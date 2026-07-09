import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../server/app.js";
import { buildParallelBatches, sanitizeToolCalls } from "../server/tcarEngine.js";

let tmpDir;
let app;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tcar-chat-"));
  app = await createApp({
    dbPath: path.join(tmpDir, "db.json"),
    uploadRoot: tmpDir
  });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function createSession(title = "Test chat") {
  const response = await request(app)
    .post("/api/chat/sessions")
    .send({ title })
    .expect(201);
  return response.body;
}

async function waitForRun(runId) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const response = await request(app).get(`/api/chat/runs/${runId}`).expect(200);
    if (["completed", "failed"].includes(response.body.status)) {
      return response.body;
    }
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error(`Run ${runId} did not complete.`);
}

describe("runtime and catalog", () => {
  it("reports seeded runtime health and mounted model names", async () => {
    const health = await request(app).get("/api/runtime/health").expect(200);
    expect(health.body.ok).toBe(true);
    expect(health.body.manifest.adapters).toBeGreaterThanOrEqual(17);
    expect(health.body.vllm.mode).toContain("simulator");

    const models = await request(app).get("/api/runtime/models").expect(200);
    expect(models.body.models.some((model) => model.id === "qwen36-awq")).toBe(true);
    expect(models.body.models.some((model) => model.id === "legal_privacy_lora")).toBe(true);
  });

  it("validates custom agent ids and blocks duplicate routes", async () => {
    await request(app)
      .post("/api/agents")
      .send({ id: "bad", title: "Bad", capability: "Bad", boundary: "Bad" })
      .expect(400);

    const payload = {
      id: "demo_policy_lora",
      title: "Demo policy route",
      capability: "Handles a demo policy.",
      boundary: "Do not invent policy.",
      routing_cues: "demo, policy"
    };
    await request(app).post("/api/agents").send(payload).expect(201);
    await request(app).post("/api/agents").send(payload).expect(409);
  });
});

describe("chat execution", () => {
  it("runs the clinic newsletter story through legal, health, support, and synthesis routes", async () => {
    const session = await createSession("Clinic review");
    const queued = await request(app)
      .post(`/api/chat/sessions/${session.session_id}/messages`)
      .send({
        content: "Review a clinic patient newsletter signup flow for consent and patient privacy, suggest health-safe wording, and draft a customer support FAQ.",
        options: { parallel_workers: 2 }
      })
      .expect(202);

    const run = await waitForRun(queued.body.run_id);
    expect(run.status).toBe("completed");
    expect(run.plan.steps.map((step) => step.adapter)).toEqual([
      "legal_privacy_lora",
      "health_safety_lora",
      "customer_support_lora",
      "writing_synthesis_lora"
    ]);
    expect(run.parallel.batches[0].width).toBe(2);
    expect(run.final_answer).toContain("Signup wording");
    expect(run.final_answer).toContain("Boundary note");

    const sessionResult = await request(app).get(`/api/chat/sessions/${session.session_id}`).expect(200);
    expect(sessionResult.body.messages.filter((message) => message.role === "assistant")).toHaveLength(1);
    expect(sessionResult.body.shared_memory.length).toBeGreaterThan(1);

    await request(app)
      .post(`/api/chat/runs/${queued.body.run_id}/feedback`)
      .send({ rating: "bad", reason: "Test flag" })
      .expect(201);
    const metrics = await request(app).get("/api/admin/metrics").expect(200);
    expect(metrics.body.bad_response_flags).toBe(1);
  });

  it("rejects empty and overlong messages before creating runs", async () => {
    const session = await createSession("Validation");
    await request(app)
      .post(`/api/chat/sessions/${session.session_id}/messages`)
      .send({ content: "   " })
      .expect(400);

    await request(app)
      .post(`/api/chat/sessions/${session.session_id}/messages`)
      .send({ content: "x".repeat(12001) })
      .expect(413);
  });

  it("handles concurrent chat stress without losing runs", async () => {
    const sessions = await Promise.all(Array.from({ length: 25 }, (_, index) => createSession(`Stress ${index}`)));
    const queued = await Promise.all(
      sessions.map((session, index) =>
        request(app)
          .post(`/api/chat/sessions/${session.session_id}/messages`)
          .send({ content: `Plan a secure support workflow with timeline and checklist ${index}.` })
          .expect(202)
      )
    );
    const runs = await Promise.all(queued.map((response) => waitForRun(response.body.run_id)));
    expect(runs.every((run) => run.status === "completed")).toBe(true);
    const metrics = await request(app).get("/api/admin/metrics").expect(200);
    expect(metrics.body.total_runs).toBe(25);
    expect(metrics.body.most_used_agents.length).toBeGreaterThan(0);
  });
});

describe("documents and sources", () => {
  it("indexes text uploads, searches chunks, and routes document questions with citations", async () => {
    const upload = await request(app)
      .post("/api/documents")
      .field("title", "Linear Algebra Notes")
      .field("routing_cues", "rank-nullity, linear maps, textbook")
      .attach(
        "file",
        Buffer.from("# Rank-Nullity Theorem\nFor a linear map T, dim(V) = rank(T) + nullity(T). If dim(V)=8 and nullity is 3, rank is 5."),
        "notes.md"
      )
      .expect(201);

    expect(upload.body.status).toBe("indexed");
    const search = await request(app)
      .post(`/api/documents/${upload.body.document_id}/search`)
      .send({ query: "rank-nullity dim(V)=8 nullity 3", top_k: 2 })
      .expect(200);
    expect(search.body.results[0].chunk_id).toContain("linear_algebra_notes");

    const session = await createSession("Doc question");
    const queued = await request(app)
      .post(`/api/chat/sessions/${session.session_id}/messages`)
      .send({ content: "Using the uploaded Linear Algebra Notes, explain rank-nullity with dim(V)=8 and nullity 3." })
      .expect(202);
    const run = await waitForRun(queued.body.run_id);
    expect(run.status).toBe("completed");
    expect(run.sources.length).toBeGreaterThan(0);
    expect(run.final_answer).toContain("rank is 5");
  });

  it("rejects unsupported uploads and unsafe source paths", async () => {
    await request(app)
      .post("/api/documents")
      .field("title", "Binary")
      .attach("file", Buffer.from("nope"), "binary.exe")
      .expect(400);

    await request(app)
      .post("/api/agents")
      .send({
        id: "unsafe_source_lora",
        title: "Unsafe",
        capability: "Unsafe",
        boundary: "Unsafe",
        sources: "../../etc/passwd"
      })
      .expect(400);
  });
});

describe("DAG and policy guards", () => {
  it("detects duplicate, missing, and cyclic route dependencies", () => {
    expect(() =>
      buildParallelBatches([
        { id: "s1", adapter: "a", depends_on: [] },
        { id: "s1", adapter: "b", depends_on: [] }
      ])
    ).toThrow(/Duplicate/);

    expect(() =>
      buildParallelBatches([{ id: "s1", adapter: "a", depends_on: ["missing"] }])
    ).toThrow(/missing/);

    expect(() =>
      buildParallelBatches([
        { id: "s1", adapter: "a", depends_on: ["s2"] },
        { id: "s2", adapter: "b", depends_on: ["s1"] }
      ])
    ).toThrow(/cycle/);
  });

  it("sanitizes hidden reasoning and unauthorized tool calls", () => {
    const result = sanitizeToolCalls(
      "<think>hidden</think>Visible <tool_call>{\"name\":\"repo_inspector\"}</tool_call> <tool_call>{bad}</tool_call>",
      []
    );
    expect(result.text).not.toContain("hidden");
    expect(result.violations).toEqual(["unauthorized_tool:repo_inspector", "malformed_tool_call"]);
  });
});

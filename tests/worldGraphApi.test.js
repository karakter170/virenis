import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../server/app.js";

const OWNER_AUTH = "Bearer worldgraph_owner_token";
const PEER_AUTH = "Bearer worldgraph_peer_token";
const OUTSIDER_AUTH = "Bearer worldgraph_outsider_token";
const PROMPT = "@wg_alpha_agent @wg_beta_agent handle this fixed request.";
const EXPECTED_ADAPTERS = ["wg_alpha_agent", "wg_beta_agent", "writing_synthesis_lora"];
const ENV_KEYS = ["APP_API_TOKENS_JSON", "APP_IDENTITY_PROVIDER", "TCAR_ENGINE_MODE", "WEB_STORE_DRIVER"];

let app;
let previousEnv;
let tmpDir;

beforeEach(async () => {
  previousEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.APP_IDENTITY_PROVIDER = "configured";
  process.env.TCAR_ENGINE_MODE = "simulator";
  process.env.WEB_STORE_DRIVER = "json";
  process.env.APP_API_TOKENS_JSON = JSON.stringify({
    worldgraph_owner_token: { user_id: "wg_owner", workspace_id: "wg_workspace", role: "user" },
    worldgraph_peer_token: { user_id: "wg_peer", workspace_id: "wg_workspace", role: "user" },
    worldgraph_outsider_token: { user_id: "wg_outsider", workspace_id: "other_workspace", role: "user" }
  });
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "virenis-worldgraph-api-"));
  app = await createApp({
    dbPath: path.join(tmpDir, "db.json"),
    uploadRoot: path.join(tmpDir, "uploads")
  });
  await createTestAgent("wg_alpha_agent", "WorldGraph Alpha");
  await createTestAgent("wg_beta_agent", "WorldGraph Beta");
});

afterEach(async () => {
  await app?.locals?.drainBackgroundTasks?.({ timeoutMs: 5000 });
  await app?.locals?.store?.close?.();
  app = null;
  for (const [key, value] of Object.entries(previousEnv || {})) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function createTestAgent(id, title) {
  await request(app)
    .post("/api/agents")
    .set("Authorization", OWNER_AUTH)
    .send({
      id,
      title,
      capability: `Handle the isolated ${title} branch.`,
      boundary: "Use only the request and validated upstream artifacts.",
      consumes: ["user_request"],
      produces: [`${id}_result`],
      routing_cues: [id],
      tools: []
    })
    .expect(201);
}

async function createSession() {
  const response = await request(app)
    .post("/api/chat/sessions")
    .set("Authorization", OWNER_AUTH)
    .send({ title: "WorldGraph integration" })
    .expect(201);
  return response.body;
}

async function execute(sessionId, options = {}, content = PROMPT, expectedAdapters = EXPECTED_ADAPTERS) {
  const queued = await request(app)
    .post(`/api/chat/sessions/${sessionId}/messages`)
    .set("Authorization", OWNER_AUTH)
    .send({ content, options, requested_agent_ids: EXPECTED_ADAPTERS })
    .expect(202);
  await app.locals.drainBackgroundTasks({ timeoutMs: 5000 });
  const completed = await request(app)
    .get(`/api/chat/runs/${queued.body.run_id}`)
    .set("Authorization", OWNER_AUTH)
    .expect(200);
  expect(completed.body.status).toBe("completed");
  if (expectedAdapters) {
    expect(completed.body.plan.steps.map((step) => step.adapter)).toEqual(expectedAdapters);
  }
  return completed.body;
}

function eventsOf(run, type) {
  return run.events.filter((event) => event.type === type);
}

function executionModes(run) {
  return Object.fromEntries(run.expert_outputs.map((output) => [output.adapter, output.execution_mode]));
}

describe.sequential("WorldGraph app integration", () => {
  it("executes every selected route on a cold run, then reuses every route on an exact repeat", async () => {
    const session = await createSession();
    const cold = await execute(session.session_id);

    expect(cold.world_graph).toMatchObject({ kept: 0, refreshed: 3, total: 3 });
    expect(eventsOf(cold, "route.started").map((event) => event.adapter)).toEqual(EXPECTED_ADAPTERS);
    expect(eventsOf(cold, "route.reused")).toHaveLength(0);
    expect(executionModes(cold)).toEqual(Object.fromEntries(EXPECTED_ADAPTERS.map((id) => [id, "refreshed"])));
    expect(cold.expert_outputs.every((output) => output.source_validation?.valid === true)).toBe(true);

    const repeated = await execute(session.session_id);
    expect(repeated.world_graph).toMatchObject({ kept: 3, refreshed: 0, total: 3 });
    expect(eventsOf(repeated, "route.started")).toHaveLength(0);
    expect(eventsOf(repeated, "route.reused").map((event) => event.adapter)).toEqual(EXPECTED_ADAPTERS);
    expect(executionModes(repeated)).toEqual(Object.fromEntries(EXPECTED_ADAPTERS.map((id) => [id, "reused"])));

    const graph = await request(app)
      .get(`/api/chat/runs/${repeated.run_id}/worldgraph`)
      .set("Authorization", OWNER_AUTH)
      .expect(200)
      .expect("Cache-Control", /private/);
    expect(graph.body.run).toMatchObject({ kept: 3, refreshed: 0, total: 3, validity: "unchecked" });
    expect(graph.body.nodes.map((node) => [node.agent_id, node.run_action])).toEqual(
      EXPECTED_ADAPTERS.map((id) => [id, "reused"])
    );
    expect(JSON.stringify(graph.body)).not.toContain("replay_output");

    const check = await request(app)
      .post(`/api/chat/runs/${repeated.run_id}/worldgraph/check`)
      .set("Authorization", OWNER_AUTH)
      .send({})
      .expect(200)
      .expect("Cache-Control", /private/);
    expect(check.body).toMatchObject({
      availability: "ready",
      validity: "current",
      keep_count: 3,
      wake_count: 0,
      model_calls_performed: 0
    });
  });

  it("wakes only a revised agent when its validated output remains unchanged", async () => {
    const session = await createSession();
    const cold = await execute(session.session_id);

    await request(app)
      .patch("/api/agents/wg_alpha_agent")
      .set("Authorization", OWNER_AUTH)
      .send({ capability: "Handle the isolated Alpha branch with revised instructions." })
      .expect(200);

    const runCountBeforePreview = app.locals.store.read().runs.length;
    const artifactCountBeforePreview = app.locals.store.read().worldGraphArtifacts.length;
    const preview = await request(app)
      .post(`/api/chat/runs/${cold.run_id}/worldgraph/check`)
      .set("Authorization", OWNER_AUTH)
      .send({})
      .expect(200);
    expect(preview.body).toMatchObject({
      availability: "ready",
      validity: "needs_refresh",
      keep_count: 1,
      wake_count: 2,
      conservative: true,
      model_calls_performed: 0
    });
    expect(preview.body.decisions.filter((item) => item.projected_action === "wake").map((item) => item.adapter))
      .toEqual(["wg_alpha_agent", "writing_synthesis_lora"]);
    expect(app.locals.store.read().runs).toHaveLength(runCountBeforePreview);
    expect(app.locals.store.read().worldGraphArtifacts).toHaveLength(artifactCountBeforePreview);

    const revised = await execute(session.session_id);
    expect(revised.world_graph).toMatchObject({ kept: 2, refreshed: 1, total: 3 });
    expect(eventsOf(revised, "route.started").map((event) => event.adapter)).toEqual(["wg_alpha_agent"]);
    expect(eventsOf(revised, "route.reused").map((event) => event.adapter)).toEqual([
      "wg_beta_agent",
      "writing_synthesis_lora"
    ]);
    expect(executionModes(revised)).toEqual({
      wg_alpha_agent: "refreshed",
      wg_beta_agent: "reused",
      writing_synthesis_lora: "reused"
    });
    expect(revised.world_graph.decisions.find((item) => item.adapter === "wg_alpha_agent")).toMatchObject({
      action: "refreshed"
    });
  });

  it("honors run_fresh by waking every route even when all prior work is reusable", async () => {
    const session = await createSession();
    await execute(session.session_id);

    const fresh = await execute(session.session_id, { run_fresh: true });
    expect(fresh.world_graph).toMatchObject({ kept: 0, refreshed: 3, total: 3 });
    expect(eventsOf(fresh, "route.started").map((event) => event.adapter)).toEqual(EXPECTED_ADAPTERS);
    expect(eventsOf(fresh, "route.reused")).toHaveLength(0);
    expect(fresh.world_graph.decisions.every((item) => item.reason === "fresh_run_requested")).toBe(true);
  });

  it("returns the safe original settings so a selective refresh uses the previewed contract", async () => {
    const session = await createSession();
    const options = {
      planner_mode: "session",
      planner_max_tokens: 300,
      max_routing_adapters: 6,
      parallel_workers: 3,
      max_tokens: 640,
      refiner_max_tokens: 900,
      temperature: 0
    };
    const cold = await execute(session.session_id, options);
    expect(cold.execution_options).toMatchObject({
      ...options,
      show_route_details: true
    });
    expect(cold.execution_options).not.toHaveProperty("api_key");
    const repeated = await execute(session.session_id, cold.execution_options);
    expect(repeated.world_graph).toMatchObject({ kept: 3, refreshed: 0, total: 3 });
  });

  it("handles serial repeat submissions without duplicate worker execution or corrupted state", async () => {
    const session = await createSession();
    await execute(session.session_id);
    const submit = (suffix) => request(app)
      .post(`/api/chat/sessions/${session.session_id}/messages`)
      .set("Authorization", OWNER_AUTH)
      .set("Idempotency-Key", `worldgraph-concurrent-${suffix}`)
      .send({ content: PROMPT, requested_agent_ids: EXPECTED_ADAPTERS })
      .expect(202);
    const left = await submit("left");
    expect((await app.locals.drainBackgroundTasks({ timeoutMs: 5000 })).ok).toBe(true);
    const right = await submit("right");
    expect((await app.locals.drainBackgroundTasks({ timeoutMs: 5000 })).ok).toBe(true);
    const runs = await Promise.all([left.body.run_id, right.body.run_id].map((runId) => request(app)
      .get(`/api/chat/runs/${runId}`)
      .set("Authorization", OWNER_AUTH)
      .expect(200)));
    for (const response of runs) {
      expect(response.body).toMatchObject({ status: "completed", world_graph: { kept: 3, refreshed: 0, total: 3 } });
      expect(eventsOf(response.body, "route.started")).toHaveLength(0);
      expect(eventsOf(response.body, "route.reused")).toHaveLength(3);
    }
    expect(app.locals.store.read().worldGraphArtifacts.every((item) => item.record_hash?.startsWith("sha256:"))).toBe(true);
  });

  it("idempotently replays simultaneous cold duplicates so only one run wakes workers", async () => {
    const session = await createSession();
    const submit = () => request(app)
      .post(`/api/chat/sessions/${session.session_id}/messages`)
      .set("Authorization", OWNER_AUTH)
      .set("Idempotency-Key", "worldgraph-cold-singleflight-0001")
      .send({ content: PROMPT, requested_agent_ids: EXPECTED_ADAPTERS })
      .expect(202);
    const [left, right] = await Promise.all([submit(), submit()]);
    expect(left.body.run_id).toBe(right.body.run_id);
    expect([left.body.duplicate, right.body.duplicate].sort()).toEqual([false, true]);
    expect((await app.locals.drainBackgroundTasks({ timeoutMs: 5000 })).ok).toBe(true);
    const response = await request(app)
      .get(`/api/chat/runs/${left.body.run_id}`)
      .set("Authorization", OWNER_AUTH)
      .expect(200);
    const run = response.body;
    expect(eventsOf(run, "route.started")).toHaveLength(3);
    expect(eventsOf(run, "route.reused")).toHaveLength(0);
    expect(run.world_graph.refreshed).toBe(3);
    expect(app.locals.store.read().worldGraphArtifacts).toHaveLength(3);
  });

  it("keeps the WorldGraph endpoint private across both user and workspace boundaries", async () => {
    const session = await createSession();
    const run = await execute(session.session_id);

    const owner = await request(app)
      .get(`/api/chat/runs/${run.run_id}/worldgraph`)
      .set("Authorization", OWNER_AUTH)
      .expect(200);
    expect(owner.body.graph_id).toBe(`world_graph:${run.run_id}`);
    expect(owner.body.stored_results).toBeGreaterThan(0);

    await request(app)
      .get(`/api/chat/runs/${run.run_id}/worldgraph`)
      .set("Authorization", PEER_AUTH)
      .expect(404);
    await request(app)
      .get(`/api/chat/runs/${run.run_id}/worldgraph`)
      .set("Authorization", OUTSIDER_AUTH)
      .expect(404);
    await request(app)
      .post(`/api/chat/runs/${run.run_id}/worldgraph/check`)
      .set("Authorization", PEER_AUTH)
      .send({})
      .expect(404);

    expect(JSON.stringify(owner.body)).not.toMatch(/record_hash|input_envelope|tool_executions|replay_output/);
  });
});

const REALISTIC_PIPELINE_PROMPTS = [
  "Create a simple textile business plan for a small local brand.",
  "Explain this science topic to a twelve-year-old student.",
  "Draft a polite reply to a customer whose package arrived damaged.",
  "Create a weekly meal-prep plan for a busy family.",
  "Outline a beginner photography workshop.",
  "Compare two software architecture approaches for a small app.",
  "Write a short privacy policy FAQ for a community website.",
  "Prepare a classroom lesson about recycling.",
  "Create a launch checklist for a neighborhood bakery.",
  "Explain how to calculate the area of a triangle.",
  "Draft a project plan for renovating a public library room.",
  "Create a safe travel checklist for a family road trip.",
  "Summarize the risks of launching a children's mobile app.",
  "Write an accessible museum visitor guide.",
  "Plan a volunteer orientation session for an animal shelter.",
  "Create an interview guide for hiring a customer support specialist.",
  "Draft a product requirements brief for a habit-tracking app.",
  "Explain the pros and cons of remote work for a small team.",
  "Create a clear onboarding guide for new club members.",
  "Write a crisis communication outline for a canceled event.",
  "Plan a community garden open day.",
  "Create a study plan for a student preparing for an exam.",
  "Draft a return-policy explanation in plain language.",
  "Outline a podcast episode about urban design.",
  "Create a cybersecurity checklist for a small nonprofit.",
  "Plan a weekend art workshop for beginners.",
  "Explain how photosynthesis works in simple terms.",
  "Create a user-research plan for a public transit app.",
  "Draft a quality checklist for handmade clothing.",
  "Prepare a concise executive memo about improving customer service."
];

const AGENTS_REQUIRING_LIVE_RECHECK = new Set([
  "finance_reasoning_lora",
  "refund_policy_lora",
  "sql_analytics_lora"
]);

describe.sequential("30 realistic full chat-pipeline selective-wake scenarios", () => {
  it.each(REALISTIC_PIPELINE_PROMPTS)("rechecks only necessary routes: %s", async (prompt) => {
    const session = await createSession();
    const cold = await execute(session.session_id, {}, prompt, null);
    const coldAdapters = cold.plan.steps.map((step) => step.adapter);
    expect(coldAdapters.length).toBeGreaterThan(0);
    expect(cold.final_answer.trim().length).toBeGreaterThan(0);
    expect(cold.world_graph).toMatchObject({ kept: 0, refreshed: coldAdapters.length, total: coldAdapters.length });

    const repeated = await execute(session.session_id, {}, prompt, null);
    const repeatedAdapters = repeated.plan.steps.map((step) => step.adapter);
    expect(repeatedAdapters).toEqual(coldAdapters);
    expect(repeated.final_answer.trim().length).toBeGreaterThan(0);

    const expectedRefreshed = repeatedAdapters.filter((adapter) => AGENTS_REQUIRING_LIVE_RECHECK.has(adapter));
    const expectedKept = repeatedAdapters.filter((adapter) => !AGENTS_REQUIRING_LIVE_RECHECK.has(adapter));
    expect(eventsOf(repeated, "route.started").map((event) => event.adapter)).toEqual(expectedRefreshed);
    expect(eventsOf(repeated, "route.reused").map((event) => event.adapter)).toEqual(expectedKept);
    expect(repeated.world_graph).toMatchObject({
      kept: expectedKept.length,
      refreshed: expectedRefreshed.length,
      total: repeatedAdapters.length
    });
    expect(repeated.world_graph.decisions.map((decision) => decision.adapter)).toEqual(repeatedAdapters);
  });
});

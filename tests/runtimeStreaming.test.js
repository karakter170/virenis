import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../server/app.js";
import {
  executeRuntimeChatStream,
  setRuntimeFetchForTests
} from "../server/runtimeClient.js";

const TOKEN = "runtime_stream_owner_token_0123456789";
const AUTH = `Bearer ${TOKEN}`;
const RUN_ID = "run_stream_parser_1";
const ENV_KEYS = [
  "APP_API_TOKENS_JSON",
  "APP_IDENTITY_PROVIDER",
  "TCAR_ENGINE_MODE",
  "TCAR_RUNTIME_API_URL",
  "TCAR_RUNTIME_API_KEY",
  "WEB_STORE_DRIVER"
];

const safePlan = {
  steps: [{
    id: "s1",
    adapter: "writing_synthesis_lora",
    task: "Prepare the concise note.",
    depends_on: []
  }]
};

let app;
let previousEnv;
let restoreFetch;
let tmpDir;

function event(type, sequence, data, runId = RUN_ID) {
  return {
    type,
    sequence,
    run_id: runId,
    at: "2026-07-17T11:00:00+00:00",
    data
  };
}

function ndjsonResponse(records) {
  return new Response(
    records.map((record) => `${JSON.stringify(record)}\n`).join(""),
    { headers: { "Content-Type": "application/x-ndjson" } }
  );
}

function contractDigest(plan) {
  const material = {
    schema_version: "tcar-runtime-plan-contract-v1",
    steps: plan.steps.map((step) => ({
      id: String(step.id || ""),
      adapter: String(step.adapter || ""),
      depends_on: (step.depends_on || []).map(String),
      task_sha256: crypto.createHash("sha256").update(String(step.task || ""), "utf8").digest("hex")
    }))
  };
  const canonical = (value) => {
    if (Array.isArray(value)) return value.map(canonical);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  };
  return `sha256:${crypto.createHash("sha256").update(JSON.stringify(canonical(material)), "utf8").digest("hex")}`;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for the streamed planner transition.");
}

beforeEach(async () => {
  previousEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.APP_IDENTITY_PROVIDER = "configured";
  process.env.WEB_STORE_DRIVER = "json";
  process.env.TCAR_ENGINE_MODE = "real";
  process.env.TCAR_RUNTIME_API_URL = "http://runtime.stream.test";
  process.env.TCAR_RUNTIME_API_KEY = "runtime-stream-api-key-0123456789";
  process.env.APP_API_TOKENS_JSON = JSON.stringify({
    [TOKEN]: { user_id: "stream_owner", workspace_id: "stream_workspace", role: "user" }
  });
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "virenis-runtime-stream-"));
});

afterEach(async () => {
  await app?.locals?.drainBackgroundTasks?.({ timeoutMs: 5000 });
  await app?.locals?.store?.close?.();
  app = null;
  restoreFetch?.();
  restoreFetch = null;
  for (const [key, value] of Object.entries(previousEnv || {})) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe.sequential("Runtime early-plan stream", () => {
  it("rejects unsafe or duplicate planner records without applying them twice", async () => {
    let callbackCount = 0;
    const unsafe = structuredClone(safePlan);
    unsafe.steps[0].private_prompt = "must not cross the boundary";
    restoreFetch = setRuntimeFetchForTests(async () => ndjsonResponse([
      event("planner.completed", 1, { plan: unsafe, contract_digest: contractDigest(safePlan) }),
      event("run.completed", 2, { result: { ok: true, plan: safePlan } })
    ]));

    await expect(executeRuntimeChatStream({
      query: "Prepare a note.",
      executionContext: { run_id: RUN_ID },
      onPlannerCompleted: async () => { callbackCount += 1; }
    })).rejects.toMatchObject({ code: "runtime_stream_invalid", status: 502 });
    expect(callbackCount).toBe(0);

    restoreFetch();
    restoreFetch = setRuntimeFetchForTests(async () => ndjsonResponse([
      event("planner.completed", 1, { plan: safePlan, contract_digest: contractDigest(safePlan) }),
      event("planner.completed", 2, { plan: safePlan, contract_digest: contractDigest(safePlan) }),
      event("run.completed", 3, { result: { ok: true, plan: safePlan } })
    ]));
    await expect(executeRuntimeChatStream({
      query: "Prepare a note.",
      executionContext: { run_id: RUN_ID },
      onPlannerCompleted: async () => { callbackCount += 1; }
    })).rejects.toMatchObject({ code: "runtime_stream_invalid", status: 502 });
    expect(callbackCount).toBe(1);
  });

  it("never replays a claimed execution when an NDJSON terminal failure uses 404", async () => {
    let fetchCount = 0;
    restoreFetch = setRuntimeFetchForTests(async () => {
      fetchCount += 1;
      return ndjsonResponse([
        event("planner.completed", 1, {
          plan: safePlan,
          contract_digest: contractDigest(safePlan)
        }),
        event("run.failed", 2, {
          error: { code: "claimed_route_failed", status: 404, retryable: false }
        })
      ]);
    });

    await expect(executeRuntimeChatStream({
      query: "Prepare a note.",
      executionContext: { run_id: RUN_ID },
      onPlannerCompleted: async () => {}
    })).rejects.toMatchObject({ code: "claimed_route_failed", status: 404 });
    expect(fetchCount).toBe(1);
  });

  it("rejects blank NDJSON records after the terminal delimiter", async () => {
    const records = [
      event("planner.completed", 1, {
        plan: safePlan,
        contract_digest: contractDigest(safePlan)
      }),
      event("run.completed", 2, { result: { ok: true, plan: safePlan } })
    ];
    restoreFetch = setRuntimeFetchForTests(async () => new Response(
      `${records.map((record) => `${JSON.stringify(record)}\n`).join("")}\n`,
      { headers: { "Content-Type": "application/x-ndjson" } }
    ));
    await expect(executeRuntimeChatStream({
      query: "Prepare a note.",
      executionContext: { run_id: RUN_ID },
      onPlannerCompleted: async () => {}
    })).rejects.toMatchObject({ code: "runtime_stream_invalid", status: 502 });
  });

  it("persists and publishes the validated plan while Runtime workers are still delayed", async () => {
    const releaseTerminal = deferred();
    const plannerTransported = deferred();
    const exactTask = `Prepare the concise note.\n${"🚗".repeat(610)} Include relevant detail.`;
    const projectedTask = Array.from(exactTask.replace(/\p{White_Space}+/gu, " ").trim())
      .slice(0, 600)
      .join("");
    const streamedSafePlan = {
      steps: [{
        id: "s1",
        adapter: "writing_synthesis_lora",
        task: projectedTask,
        depends_on: []
      }]
    };
    expect(exactTask.length).toBeGreaterThan(600);
    let runtimeAgent;
    const baseDigest = "2".repeat(64);
    const executorDigest = "3".repeat(64);
    const workerDigest = "8".repeat(64);

    restoreFetch = setRuntimeFetchForTests(async (url, options = {}) => {
      expect(new URL(url).pathname).toBe("/chat/execute/stream");
      const requestBody = JSON.parse(options.body);
      const runId = requestBody.execution_context.run_id;
      const plan = {
        steps: [{
          id: "s1",
          adapter: "writing_synthesis_lora",
          task: exactTask,
          depends_on: []
        }],
        adapters: ["writing_synthesis_lora"],
        edges: [],
        routing: {
          mode: "session",
          candidate_count: 1,
          candidate_adapters: ["writing_synthesis_lora"],
          selected: [{
            adapter: "writing_synthesis_lora",
            source: "explicit",
            reason: "Explicitly requested."
          }]
        }
      };
      const routeOutput = {
        id: "s1",
        step_id: "s1",
        adapter: "writing_synthesis_lora",
        agent_revision: runtimeAgent.agent_revision,
        revision_authority: "runtime",
        agent_content_digest: runtimeAgent.agent_content_digest,
        adapter_content_digest: runtimeAgent.adapter_content_digest,
        manifest_contract_digest: runtimeAgent.manifest_contract_digest,
        model_id: "qwen-stream-test",
        base_model_content_digest: baseDigest,
        task: exactTask,
        depends_on: [],
        used_upstream: [],
        domain_answer: "The concise validated note.",
        handoff_artifacts: [],
        citations: [],
        policy_violations: [],
        artifact_validation: { valid: true },
        consumption_validation: { valid: true },
        source_validation: { valid: true, violations: [] },
        allowed_tools: [],
        tool_executions: [],
        execution_mode: "executed",
        world_graph_reason: "no_matching_result",
        model_calls: [{ usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } }]
      };
      const calls = [
        {
          component: "agent:writing_synthesis_lora:call_1",
          agent_id: "writing_synthesis_lora",
          step_id: "s1",
          model: "qwen-stream-test",
          prompt_tokens: 20,
          completion_tokens: 5,
          total_tokens: 25
        },
        {
          component: "final_synthesis",
          model: "qwen-stream-test",
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15
        }
      ];
      const result = {
        ok: true,
        mode: "session_delegated_vllm_execute",
        plannerMode: "session",
        baseModel: "qwen-stream-test",
        manifestRevision: "1".repeat(64),
        componentProvenance: {
          revision_authority: "runtime",
          manifest_revision: "1".repeat(64),
          base_model_id: "qwen-stream-test",
          base_model_content_digest: baseDigest,
          executor_code_digest: executorDigest,
          worker_execution_config_digest: workerDigest,
          agents: [{
            adapter: runtimeAgent.id,
            agent_revision: runtimeAgent.agent_revision,
            revision_authority: "runtime",
            manifest_contract_digest: runtimeAgent.manifest_contract_digest,
            agent_content_digest: runtimeAgent.agent_content_digest,
            adapter_content_digest: runtimeAgent.adapter_content_digest
          }]
        },
        executionProvenance: {
          schema_version: "runtime-execution-provenance-v1",
          execution_id: `runtime_${runId}`,
          receipt_hash: "9".repeat(64)
        },
        plan,
        expertOutputs: [routeOutput],
        finalAnswer: "The concise validated note.",
        worldGraph: {
          kept: 0,
          refreshed: 1,
          decisions: [{
            step_id: "s1",
            adapter: runtimeAgent.id,
            action: "refresh",
            reason: "no_matching_result",
            origin_run_id: null
          }]
        },
        tokenAccounting: {
          schema_version: "router-token-accounting-v1",
          provider_reported: true,
          complete: true,
          call_count: calls.length,
          calls,
          totals: { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 },
          missing_usage: []
        }
      };
      const encoder = new TextEncoder();
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(`${JSON.stringify(event(
            "planner.completed",
            1,
            { plan: streamedSafePlan, contract_digest: contractDigest(plan) },
            runId
          ))}\n`));
          plannerTransported.resolve();
          void releaseTerminal.promise.then(() => {
            controller.enqueue(encoder.encode(`${JSON.stringify(event(
              "run.completed",
              2,
              { result },
              runId
            ))}\n`));
            controller.close();
          });
        }
      }), { headers: { "Content-Type": "application/x-ndjson; charset=utf-8" } });
    });

    app = await createApp({
      dbPath: path.join(tmpDir, "db.json"),
      uploadRoot: path.join(tmpDir, "uploads")
    });
    await app.locals.store.mutate((data) => {
      const agent = data.agents.find((item) => item.id === "writing_synthesis_lora");
      agent.revision_authority = "runtime";
      agent.agent_revision = "4".repeat(64);
      agent.manifest_contract_digest = "5".repeat(64);
      agent.agent_content_digest = "6".repeat(64);
      agent.adapter_content_digest = "6".repeat(64);
      return agent;
    });
    runtimeAgent = app.locals.store.read().agents.find((item) => item.id === "writing_synthesis_lora");

    const session = await request(app)
      .post("/api/chat/sessions")
      .set("Authorization", AUTH)
      .send({ title: "Early plan" })
      .expect(201);
    const queued = await request(app)
      .post(`/api/chat/sessions/${session.body.session_id}/messages`)
      .set("Authorization", AUTH)
      .send({ content: "@writing_synthesis_lora prepare the concise note." })
      .expect(202);

    await plannerTransported.promise;
    const running = await waitFor(() => {
      const run = app.locals.store.read().runs.find((item) => item.run_id === queued.body.run_id);
      return run?.events?.some((item) => item.type === "planner.completed") ? run : null;
    });
    expect(running.status).toBe("running");
    expect(running.plan.steps).toEqual(streamedSafePlan.steps);
    expect(running.events.filter((item) => item.type === "planner.completed")).toHaveLength(1);
    expect(running.events.some((item) => item.type === "route.completed")).toBe(false);
    expect(running.events.some((item) => item.type === "final.completed")).toBe(false);
    const plannerEvent = running.events.find((item) => item.type === "planner.completed");
    expect(Object.keys(plannerEvent).sort()).toEqual(["at", "steps", "type"]);
    expect(JSON.stringify(plannerEvent)).not.toContain("private_prompt");

    releaseTerminal.resolve();
    expect((await app.locals.drainBackgroundTasks({ timeoutMs: 5000 })).ok).toBe(true);
    const completed = app.locals.store.read().runs.find((item) => item.run_id === queued.body.run_id);
    expect(completed.status).toBe("completed");
    expect(completed.events.filter((item) => item.type === "planner.completed")).toHaveLength(1);
    expect(completed.events.findIndex((item) => item.type === "planner.completed"))
      .toBeLessThan(completed.events.findIndex((item) => item.type === "route.completed"));
  });
});

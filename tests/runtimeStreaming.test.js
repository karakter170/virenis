import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../server/app.js";
import { runtimePlanExactContractDigest } from "../server/tcarEngine.js";
import {
  executeRuntimeChatStream,
  setRuntimeFetchForTests
} from "../server/runtimeClient.js";

const TOKEN = "runtime_stream_owner_token_0123456789";
const ADMIN_TOKEN = "runtime_stream_admin_token_0123456789";
const AUTH = `Bearer ${TOKEN}`;
const RUN_ID = "run_stream_parser_1";
const BLOCKED_CLARIFICATION_V5_DIGEST =
  "sha256:7f27214b6ea68cfc343ccd9b72a96e9aeae3f8f7b56a827455e1870e6bf7d8a5";
const ENV_KEYS = [
  "APP_API_TOKENS_JSON",
  "APP_IDENTITY_PROVIDER",
  "TCAR_ENGINE_MODE",
  "TCAR_RUNTIME_API_URL",
  "TCAR_RUNTIME_API_KEY",
  "TCAR_RUNTIME_BODY_IDLE_TIMEOUT_MS",
  "TCAR_RUNTIME_CHAT_TIMEOUT_MS",
  "TCAR_RUNTIME_CONNECT_TIMEOUT_MS",
  "TCAR_RUNTIME_HEADER_TIMEOUT_MS",
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

const blockedClarificationPlan = {
  steps: [],
  routing: {
    mode: "session",
    fallback: "clarification",
    orchestrator: {
      contract_version: "session-orchestrator-v3",
      decision: "clarify",
      clarification_question: "Enable a feasibility-capable agent or adjust the requested review.",
      final_synthesis_required: false,
      fallback_used: "outcome_contract_blocked",
      outcome_contract: {
        contract_version: "session-outcome-v1",
        compiler_authority: "runtime",
        status: "blocked",
        route_admission_contract_version: "session-route-admission-v1",
        deliverables: [{
          id: "d1",
          title: "Feasibility review",
          description: "Assess feasibility from multiple perspectives.",
          required: true,
          evidence_requirement: "none",
          required_outputs: ["feasibility_assessment"],
          controller_can_synthesize: false,
          assigned_to_session_controller: false
        }],
        steps: [{
          step_id: "s1",
          route_admission_valid: false,
          route_dependency_closure_valid: false,
          route_admission: {
            contract_version: "session-route-admission-v1",
            valid: false,
            route_role: "outcome_owner",
            obligation_source: "compiled_deliverables",
            deliverable_ids: ["d1"],
            expected_outputs: ["feasibility_assessment"],
            downstream_bindings: [],
            strict_constraints_checked: [
              "activation_policy", "boundary", "write_policy",
              "tool_policy", "source_policy", "escalation_policy"
            ],
            violations: ["unsupported_expected_output:ideas"],
            obligation: "Assess feasibility without crossing the agent boundary."
          }
        }],
        coverage: [{
          deliverable_id: "d1",
          covered: false,
          fulfilling_steps: [],
          controller_synthesis: false
        }],
        violations: [
          "unsupported_expected_output:ideas",
          "required_deliverable_uncovered:d1"
        ]
      }
    }
  }
};

let app;
let previousEnv;
let restoreFetch;
let tmpDir;
const runtimeServers = [];

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
    {
      headers: {
        "Content-Type": "application/x-ndjson",
        "X-TCAR-Stream-Protocol": "heartbeat-v1"
      }
    }
  );
}

function contractDigest(plan) {
  const routing = plan?.routing || {};
  const orchestrator = routing?.orchestrator || {};
  const outcomeContract = orchestrator?.outcome_contract || {};
  const routeAdmissionSteps = (Array.isArray(outcomeContract.steps) ? outcomeContract.steps : [])
    .filter((row) => row && typeof row === "object" && !Array.isArray(row))
    .map((row) => {
      const admission = row.route_admission && typeof row.route_admission === "object" && !Array.isArray(row.route_admission)
        ? row.route_admission
        : {};
      return {
        step_id: String(row.step_id || ""),
        route_admission_valid: row.route_admission_valid === true,
        route_dependency_closure_valid: row.route_dependency_closure_valid === true,
        route_admission: {
          contract_version: String(admission.contract_version || ""),
          valid: admission.valid === true,
          route_role: String(admission.route_role || ""),
          obligation_source: String(admission.obligation_source || ""),
          deliverable_ids: (Array.isArray(admission.deliverable_ids) ? admission.deliverable_ids : []).map(String),
          expected_outputs: (Array.isArray(admission.expected_outputs) ? admission.expected_outputs : []).map(String),
          downstream_bindings: (Array.isArray(admission.downstream_bindings) ? admission.downstream_bindings : [])
            .filter((binding) => binding && typeof binding === "object" && !Array.isArray(binding))
            .map((binding) => ({
              consumer_step_id: String(binding.consumer_step_id || ""),
              consumer_adapter: String(binding.consumer_adapter || ""),
              input: String(binding.input || ""),
              output: String(binding.output || "")
            })),
          strict_constraints_checked: (Array.isArray(admission.strict_constraints_checked) ? admission.strict_constraints_checked : []).map(String),
          violations: (Array.isArray(admission.violations) ? admission.violations : []).map(String),
          obligation_sha256: crypto.createHash("sha256")
            .update(String(admission.obligation || ""), "utf8")
            .digest("hex")
        }
      };
    });
  const material = {
    schema_version: "tcar-runtime-plan-contract-v5",
    steps: plan.steps.map((step) => ({
      id: String(step.id || ""),
      adapter: String(step.adapter || ""),
      depends_on: (step.depends_on || []).map(String),
      evidence_requirement: String(step.evidence_requirement || ""),
      expected_outputs: (step.expected_outputs || []).map(String),
      fulfills: (step.fulfills || []).map(String),
      task_sha256: crypto.createHash("sha256").update(String(step.task || ""), "utf8").digest("hex")
    })),
    orchestrator: {
      contract_version: String(orchestrator.contract_version || ""),
      decision: String(orchestrator.decision || ""),
      clarification_question_sha256: crypto.createHash("sha256")
        .update(String(orchestrator.clarification_question || ""), "utf8")
        .digest("hex"),
      final_synthesis_required: orchestrator.final_synthesis_required === true,
      fallback_used: String(orchestrator.fallback_used || ""),
      fallback: String(routing.fallback || "")
    },
    outcome_contract: {
      contract_version: String(outcomeContract.contract_version || ""),
      compiler_authority: String(outcomeContract.compiler_authority || ""),
      status: String(outcomeContract.status || ""),
      route_admission_contract_version: String(outcomeContract.route_admission_contract_version || ""),
      deliverables: (outcomeContract.deliverables || []).map((deliverable) => ({
        id: String(deliverable?.id || ""),
        title_sha256: crypto.createHash("sha256")
          .update(String(deliverable?.title || ""), "utf8")
          .digest("hex"),
        description_sha256: crypto.createHash("sha256")
          .update(String(deliverable?.description || ""), "utf8")
          .digest("hex"),
        required: deliverable?.required !== false,
        evidence_requirement: String(deliverable?.evidence_requirement || ""),
        required_outputs: (Array.isArray(deliverable?.required_outputs) ? deliverable.required_outputs : []).map(String),
        controller_can_synthesize: deliverable?.controller_can_synthesize === true,
        assigned_to_session_controller: deliverable?.assigned_to_session_controller === true
      })),
      steps: routeAdmissionSteps,
      coverage: (Array.isArray(outcomeContract.coverage) ? outcomeContract.coverage : [])
        .filter((row) => row && typeof row === "object" && !Array.isArray(row))
        .map((row) => ({
          deliverable_id: String(row.deliverable_id || ""),
          covered: row.covered === true,
          fulfilling_steps: (Array.isArray(row.fulfilling_steps) ? row.fulfilling_steps : []).map(String),
          controller_synthesis: row.controller_synthesis === true
        })),
      violations: (Array.isArray(outcomeContract.violations) ? outcomeContract.violations : []).map(String)
    }
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

async function startRuntimeServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  runtimeServers.push(server);
  return `http://127.0.0.1:${address.port}`;
}

beforeEach(async () => {
  previousEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.APP_IDENTITY_PROVIDER = "configured";
  process.env.WEB_STORE_DRIVER = "json";
  process.env.TCAR_ENGINE_MODE = "real";
  process.env.TCAR_RUNTIME_API_URL = "http://runtime.stream.test";
  process.env.TCAR_RUNTIME_API_KEY = "runtime-stream-api-key-0123456789";
  process.env.APP_API_TOKENS_JSON = JSON.stringify({
    [TOKEN]: { user_id: "stream_owner", workspace_id: "stream_workspace", role: "user" },
    [ADMIN_TOKEN]: { user_id: "stream_admin", workspace_id: "stream_workspace", role: "admin" }
  });
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "virenis-runtime-stream-"));
});

afterEach(async () => {
  await app?.locals?.drainBackgroundTasks?.({ timeoutMs: 5000 });
  await app?.locals?.store?.close?.();
  app = null;
  restoreFetch?.();
  restoreFetch = null;
  await Promise.allSettled(runtimeServers.splice(0).map((server) => new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(resolve);
  })));
  for (const [key, value] of Object.entries(previousEnv || {})) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe.sequential("Runtime early-plan stream", () => {
  it("binds hidden blocked-clarification state in the v5 exact contract", () => {
    const baseline = runtimePlanExactContractDigest(blockedClarificationPlan);
    expect(baseline).toBe(contractDigest(blockedClarificationPlan));
    expect(baseline).toBe(BLOCKED_CLARIFICATION_V5_DIGEST);

    const mutations = [
      (plan) => { plan.routing.orchestrator.contract_version = "session-orchestrator-v2"; },
      (plan) => { plan.routing.orchestrator.decision = "direct"; },
      (plan) => { plan.routing.orchestrator.clarification_question = "Enable a different specialist."; },
      (plan) => { plan.routing.orchestrator.final_synthesis_required = true; },
      (plan) => { plan.routing.orchestrator.fallback_used = "clarification"; },
      (plan) => { plan.routing.fallback = "session_model"; },
      (plan) => { plan.routing.orchestrator.outcome_contract.coverage[0].covered = true; },
      (plan) => {
        plan.routing.orchestrator.outcome_contract.violations = ["required_deliverable_uncovered:d1"];
      }
    ];
    for (const mutate of mutations) {
      const changed = structuredClone(blockedClarificationPlan);
      mutate(changed);
      expect(changed.steps).toEqual(blockedClarificationPlan.steps);
      expect(runtimePlanExactContractDigest(changed)).not.toBe(baseline);
    }
  });

  it("persists a guarded blocked clarification instead of relabeling it as an invalid model response", async () => {
    const question = blockedClarificationPlan.routing.orchestrator.clarification_question;
    const runtimeUrl = await startRuntimeServer((incoming, response) => {
      let requestText = "";
      incoming.setEncoding("utf8");
      incoming.on("data", (chunk) => { requestText += chunk; });
      incoming.once("end", () => {
        const requestBody = JSON.parse(requestText);
        const runId = requestBody.execution_context.run_id;
        response.writeHead(200, {
          "Content-Type": "application/x-ndjson",
          "X-TCAR-Stream-Protocol": "heartbeat-v1"
        });
        response.write(`${JSON.stringify(event("planner.completed", 1, {
          plan: { steps: [] },
          contract_digest: runtimePlanExactContractDigest(blockedClarificationPlan)
        }, runId))}\n`);
        response.end(`${JSON.stringify(event("run.completed", 2, {
          result: {
            ok: true,
            mode: "session_clarification",
            baseModel: "qwen-stream-test",
            manifestRevision: "1".repeat(64),
            componentProvenance: {
              revision_authority: "runtime",
              manifest_revision: "1".repeat(64),
              base_model_id: "qwen-stream-test",
              base_model_content_digest: "2".repeat(64),
              session_model_id: "qwen-stream-test",
              session_model_content_digest: "2".repeat(64),
              session_contract_version: "session-orchestrator-v3",
              executor_code_digest: "3".repeat(64),
              agents: []
            },
            executionProvenance: {
              execution_id: runId,
              receipt_id: `receipt_${runId}`,
              record_hash: "9".repeat(64),
              schema_version: 1,
              created_at: "2026-07-17T11:00:00.000Z"
            },
            plan: blockedClarificationPlan,
            parallel: { workers: 1, batches: [], maxBatchWidth: 0, parallelizable: false },
            expertOutputs: [],
            finalAnswer: question,
            fallbackFinalAnswer: question,
            tokenAccounting: {
              schema_version: "router-token-accounting-v1",
              provider_reported: true,
              complete: true,
              call_count: 1,
              calls: [],
              totals: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
              missing_usage: []
            }
          }
        }, runId))}\n`);
      });
    });
    process.env.TCAR_RUNTIME_API_URL = runtimeUrl;
    app = await createApp({
      dbPath: path.join(tmpDir, "blocked-clarification-app.json"),
      uploadRoot: path.join(tmpDir, "blocked-clarification-uploads")
    });
    const session = await request(app)
      .post("/api/chat/sessions")
      .set("Authorization", AUTH)
      .send({ title: "Feasibility follow-up" })
      .expect(201);
    const queued = await request(app)
      .post(`/api/chat/sessions/${session.body.session_id}/messages`)
      .set("Authorization", AUTH)
      .send({ content: "Then brainstorm again and check feasibility from different perspectives." })
      .expect(202);
    expect((await app.locals.drainBackgroundTasks({ timeoutMs: 3000 })).ok).toBe(true);

    const run = await request(app)
      .get(`/api/chat/runs/${queued.body.run_id}`)
      .set("Authorization", AUTH)
      .expect(200);
    expect(run.body).toMatchObject({
      status: "completed",
      final_answer: question,
      expert_outputs: [],
      plan: { steps: [] }
    });
    expect(run.body.error).toBeNull();
    expect(run.body.events.filter((item) => item.type === "planner.completed")).toHaveLength(1);
    const storedSession = app.locals.store.read((data) =>
      data.sessions.find((item) => item.session_id === session.body.session_id)
    );
    expect(storedSession.shared_memory.at(-1)).toMatchObject({
      tag: "session.clarification",
      source: "session_controller",
      content: question
    });
  });

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
      {
        headers: {
          "Content-Type": "application/x-ndjson",
          "X-TCAR-Stream-Protocol": "heartbeat-v1"
        }
      }
    ));
    await expect(executeRuntimeChatStream({
      query: "Prepare a note.",
      executionContext: { run_id: RUN_ID },
      onPlannerCompleted: async () => {}
    })).rejects.toMatchObject({ code: "runtime_stream_invalid", status: 502 });
  });

  it("accepts bounded content-free heartbeats and rejects malformed or excessive ones", async () => {
    restoreFetch = setRuntimeFetchForTests(async () => ndjsonResponse([
      event("run.heartbeat", 1, {}),
      event("planner.completed", 2, {
        plan: safePlan,
        contract_digest: contractDigest(safePlan)
      }),
      event("run.heartbeat", 3, { private_status: "must not be accepted" }),
      event("run.completed", 4, { result: { ok: true, plan: safePlan } })
    ]));
    await expect(executeRuntimeChatStream({
      query: "Prepare a note.",
      executionContext: { run_id: RUN_ID },
      onPlannerCompleted: async () => {}
    })).rejects.toMatchObject({ code: "runtime_stream_invalid", status: 502 });

    restoreFetch();
    const excessive = Array.from({ length: 513 }, (_, index) => (
      event("run.heartbeat", index + 1, {})
    ));
    excessive.push(event("run.failed", 514, {
      error: { code: "synthetic_failure", status: 500, retryable: false }
    }));
    restoreFetch = setRuntimeFetchForTests(async () => ndjsonResponse(excessive));
    await expect(executeRuntimeChatStream({
      query: "Prepare a note.",
      executionContext: { run_id: RUN_ID }
    })).rejects.toMatchObject({ code: "runtime_stream_invalid", status: 502 });
  });

  it("keeps a real HTTP stream alive with heartbeats beyond the body-idle threshold", async () => {
    const observedTypes = [];
    const runtimeUrl = await startRuntimeServer((incoming, response) => {
      expect(incoming.url).toBe("/chat/execute/stream");
      expect(incoming.headers["x-tcar-stream-protocol"]).toBe("heartbeat-v1");
      let requestText = "";
      incoming.setEncoding("utf8");
      incoming.on("data", (chunk) => { requestText += chunk; });
      incoming.on("end", () => {
        const requestBody = JSON.parse(requestText);
        const runId = requestBody.execution_context.run_id;
        let sequence = 0;
        const write = (type, data) => {
          sequence += 1;
          observedTypes.push(type);
          response.write(`${JSON.stringify(event(type, sequence, data, runId))}\n`);
        };
        response.writeHead(200, {
          "Content-Type": "application/x-ndjson",
          "X-TCAR-Stream-Protocol": "heartbeat-v1"
        });
        write("run.heartbeat", {});
        write("planner.completed", {
          plan: safePlan,
          contract_digest: contractDigest(safePlan)
        });
        const heartbeat = setInterval(() => write("run.heartbeat", {}), 20);
        const terminal = setTimeout(() => {
          clearInterval(heartbeat);
          write("run.completed", { result: { ok: true, plan: safePlan, finalAnswer: "Ready." } });
          response.end();
        }, 240);
        response.once("close", () => {
          clearInterval(heartbeat);
          clearTimeout(terminal);
        });
      });
    });
    process.env.TCAR_RUNTIME_API_URL = runtimeUrl;
    process.env.TCAR_RUNTIME_CONNECT_TIMEOUT_MS = "100";
    process.env.TCAR_RUNTIME_HEADER_TIMEOUT_MS = "100";
    process.env.TCAR_RUNTIME_BODY_IDLE_TIMEOUT_MS = "60";
    process.env.TCAR_RUNTIME_CHAT_TIMEOUT_MS = "1000";
    let plannerCallbacks = 0;

    await expect(executeRuntimeChatStream({
      query: "Prepare a note.",
      executionContext: { run_id: "run_real_heartbeat" },
      onPlannerCompleted: async () => { plannerCallbacks += 1; }
    })).resolves.toMatchObject({
      legacy: false,
      result: { ok: true, finalAnswer: "Ready." }
    });
    expect(plannerCallbacks).toBe(1);
    expect(observedTypes.filter((type) => type === "run.heartbeat").length).toBeGreaterThan(2);
    expect(observedTypes.at(-1)).toBe("run.completed");
  });

  it("reports a stalled real HTTP event stream as a transport-idle timeout", async () => {
    const runtimeUrl = await startRuntimeServer((incoming, response) => {
      expect(incoming.headers["x-tcar-stream-protocol"]).toBe("heartbeat-v1");
      incoming.resume();
      incoming.once("end", () => {
        response.writeHead(200, {
          "Content-Type": "application/x-ndjson",
          "X-TCAR-Stream-Protocol": "heartbeat-v1"
        });
        response.write(`${JSON.stringify(event("run.heartbeat", 1, {}, "run_real_idle"))}\n`);
      });
    });
    process.env.TCAR_RUNTIME_API_URL = runtimeUrl;
    process.env.TCAR_RUNTIME_CONNECT_TIMEOUT_MS = "100";
    process.env.TCAR_RUNTIME_HEADER_TIMEOUT_MS = "100";
    process.env.TCAR_RUNTIME_BODY_IDLE_TIMEOUT_MS = "40";
    process.env.TCAR_RUNTIME_CHAT_TIMEOUT_MS = "500";

    await expect(executeRuntimeChatStream({
      query: "Prepare a note.",
      executionContext: { run_id: "run_real_idle" }
    })).rejects.toMatchObject({
      code: "runtime_stream_idle_timeout",
      status: 504,
      retryable: true,
      component: "runtime_stream"
    });
  });

  it("persists a stalled stream as a public connection interruption with private transport diagnostics", async () => {
    const runtimeUrl = await startRuntimeServer((incoming, response) => {
      let requestText = "";
      incoming.setEncoding("utf8");
      incoming.on("data", (chunk) => { requestText += chunk; });
      incoming.once("end", () => {
        const requestBody = JSON.parse(requestText);
        const runId = requestBody.execution_context.run_id;
        response.writeHead(200, {
          "Content-Type": "application/x-ndjson",
          "X-TCAR-Stream-Protocol": "heartbeat-v1"
        });
        response.write(`${JSON.stringify(event("run.heartbeat", 1, {}, runId))}\n`);
        response.write(`${JSON.stringify(event("planner.completed", 2, {
          plan: safePlan,
          contract_digest: contractDigest(safePlan)
        }, runId))}\n`);
      });
    });
    process.env.TCAR_RUNTIME_API_URL = runtimeUrl;
    process.env.TCAR_RUNTIME_CONNECT_TIMEOUT_MS = "100";
    process.env.TCAR_RUNTIME_HEADER_TIMEOUT_MS = "100";
    process.env.TCAR_RUNTIME_BODY_IDLE_TIMEOUT_MS = "40";
    process.env.TCAR_RUNTIME_CHAT_TIMEOUT_MS = "500";
    app = await createApp({
      dbPath: path.join(tmpDir, "stream-idle-app.json"),
      uploadRoot: path.join(tmpDir, "stream-idle-uploads")
    });
    const session = await request(app)
      .post("/api/chat/sessions")
      .set("Authorization", AUTH)
      .send({ title: "Transport timeout" })
      .expect(201);
    const queued = await request(app)
      .post(`/api/chat/sessions/${session.body.session_id}/messages`)
      .set("Authorization", AUTH)
      .send({ content: "@writing_synthesis_lora prepare the concise note." })
      .expect(202);
    expect((await app.locals.drainBackgroundTasks({ timeoutMs: 2000 })).ok).toBe(true);

    const userRun = await request(app)
      .get(`/api/chat/runs/${queued.body.run_id}`)
      .set("Authorization", AUTH)
      .expect(200);
    expect(userRun.body.status).toBe("failed");
    expect(userRun.body.error).toEqual({
      code: "model_connection_interrupted",
      message: "The connection to the model runtime stopped receiving progress. Your message is still available—try again.",
      retryable: true,
      action: "retry"
    });
    expect(userRun.body.events.filter((item) => item.type === "planner.completed")).toHaveLength(1);
    expect(userRun.body.events.some((item) => item.type === "run.heartbeat")).toBe(false);
    expect(userRun.body).not.toHaveProperty("error_admin_only");

    const adminRun = await request(app)
      .get(`/api/chat/runs/${queued.body.run_id}`)
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .expect(200);
    expect(adminRun.body.error_admin_only).toMatchObject({
      code: "runtime_stream_idle_timeout",
      public_code: "model_connection_interrupted",
      status: 504,
      retryable: true
    });
  });

  it("uses a rollout-safe idle budget when an older Runtime does not negotiate heartbeats", async () => {
    const runtimeUrl = await startRuntimeServer((incoming, response) => {
      incoming.resume();
      incoming.once("end", () => {
        response.writeHead(200, { "Content-Type": "application/x-ndjson" });
        response.write(`${JSON.stringify(event("planner.completed", 1, {
          plan: safePlan,
          contract_digest: contractDigest(safePlan)
        }, "run_legacy_stream"))}\n`);
        setTimeout(() => {
          if (response.destroyed) return;
          response.end(`${JSON.stringify(event("run.completed", 2, {
            result: { ok: true, plan: safePlan, finalAnswer: "Legacy ready." }
          }, "run_legacy_stream"))}\n`);
        }, 180);
      });
    });
    process.env.TCAR_RUNTIME_API_URL = runtimeUrl;
    process.env.TCAR_RUNTIME_CONNECT_TIMEOUT_MS = "100";
    process.env.TCAR_RUNTIME_HEADER_TIMEOUT_MS = "100";
    process.env.TCAR_RUNTIME_BODY_IDLE_TIMEOUT_MS = "40";
    process.env.TCAR_RUNTIME_CHAT_TIMEOUT_MS = "500";

    await expect(executeRuntimeChatStream({
      query: "Prepare a note.",
      executionContext: { run_id: "run_legacy_stream" },
      onPlannerCompleted: async () => {}
    })).resolves.toMatchObject({
      result: { ok: true, finalAnswer: "Legacy ready." }
    });
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
    expect(Array.from(projectedTask)).toHaveLength(600);
    expect(projectedTask.length).toBeGreaterThan(600);
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
            "run.heartbeat",
            1,
            {},
            runId
          ))}\n`));
          controller.enqueue(encoder.encode(`${JSON.stringify(event(
            "planner.completed",
            2,
            { plan: streamedSafePlan, contract_digest: contractDigest(plan) },
            runId
          ))}\n`));
          controller.enqueue(encoder.encode(`${JSON.stringify(event(
            "run.heartbeat",
            3,
            {},
            runId
          ))}\n`));
          plannerTransported.resolve();
          void releaseTerminal.promise.then(() => {
            controller.enqueue(encoder.encode(`${JSON.stringify(event(
              "run.completed",
              4,
              { result },
              runId
            ))}\n`));
            controller.close();
          });
        }
      }), {
        headers: {
          "Content-Type": "application/x-ndjson; charset=utf-8",
          "X-TCAR-Stream-Protocol": "heartbeat-v1"
        }
      });
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
    expect(running.events.some((item) => item.type === "run.heartbeat")).toBe(false);
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

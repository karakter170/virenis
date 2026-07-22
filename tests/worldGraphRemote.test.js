import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../server/app.js";
import { setRuntimeFetchForTests } from "../server/runtimeClient.js";

const TOKEN = "worldgraph_remote_owner_token";
const AUTH = `Bearer ${TOKEN}`;
const QUERY = "@writing_synthesis_lora prepare the same concise note.";
const ENV_KEYS = [
  "APP_API_TOKENS_JSON",
  "APP_IDENTITY_PROVIDER",
  "AGENT_RUNTIME_MODE",
  "AGENT_RUNTIME_API_URL",
  "AGENT_RUNTIME_API_KEY",
  "WEB_STORE_DRIVER"
];

let app;
let previousEnv;
let restoreFetch;
let tmpDir;
let requests;
let runtimeAgent;
let runtimeBaseDigest;
let runtimeExecutorDigest;
let runtimeWorkerConfigDigest;
let reuseClaimMutation;
let includeToolSecret;

function signedWorldGraphPayload(wrapper) {
  if (!wrapper) return null;
  expect(Object.keys(wrapper).sort()).toEqual(["encoding", "signature", "signed_payload"]);
  expect(wrapper.encoding).toBe("json-utf8-exact-v1");
  expect(wrapper.signature).toMatch(/^[a-f0-9]{64}$/);
  return JSON.parse(wrapper.signed_payload);
}

beforeEach(async () => {
  previousEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.APP_IDENTITY_PROVIDER = "configured";
  process.env.WEB_STORE_DRIVER = "json";
  process.env.AGENT_RUNTIME_MODE = "real";
  process.env.AGENT_RUNTIME_API_URL = "http://runtime.worldgraph.test";
  process.env.AGENT_RUNTIME_API_KEY = "worldgraph-remote-runtime-key-0123456789";
  process.env.APP_API_TOKENS_JSON = JSON.stringify({
    [TOKEN]: { user_id: "remote_owner", workspace_id: "remote_workspace", role: "user" }
  });
  requests = [];
  runtimeBaseDigest = "2".repeat(64);
  runtimeExecutorDigest = "3".repeat(64);
  runtimeWorkerConfigDigest = "8".repeat(64);
  reuseClaimMutation = null;
  includeToolSecret = false;
  restoreFetch = setRuntimeFetchForTests(async (url, options = {}) => {
    expect(String(url)).toContain("/chat/execute");
    const body = JSON.parse(options.body);
    requests.push(body);
    const worldGraph = signedWorldGraphPayload(body.world_graph);
    const candidate = worldGraph?.candidates?.find((item) => (
      item.input_envelope?.adapter === "writing_synthesis_lora"
    ));
    const reused = Boolean(
      candidate
      && candidate.runtime_component_state?.base_model_content_digest === `sha256:${runtimeBaseDigest}`
      && candidate.runtime_component_state?.executor_code_digest === `sha256:${runtimeExecutorDigest}`
      && candidate.runtime_component_state?.worker_execution_config_digest === `sha256:${runtimeWorkerConfigDigest}`
    );
    const routeOutput = {
      id: "s1",
      step_id: "s1",
      adapter: "writing_synthesis_lora",
      agent_revision: runtimeAgent.agent_revision,
      revision_authority: "runtime",
      agent_content_digest: runtimeAgent.agent_content_digest,
      adapter_content_digest: runtimeAgent.adapter_content_digest,
      manifest_contract_digest: runtimeAgent.manifest_contract_digest,
      modelId: "qwen-test",
      base_model_content_digest: runtimeBaseDigest,
      task: "Prepare the concise note.",
      depends_on: [],
      used_upstream: [],
      domain_answer: "The concise validated note.",
      handoff_artifacts: [],
      citations: [],
      policy_violations: [],
      artifact_validation: { valid: true },
      outcome_validation: {
        contract_version: "session-step-outcome-v1",
        expected_outputs: [],
        produced_expected_outputs: [],
        missing_expected_outputs: [],
        fulfills: [],
        valid: true
      },
      consumption_validation: { valid: true },
      source_validation: { valid: true, violations: [] },
      allowed_tools: Array.isArray(runtimeAgent.tools) ? runtimeAgent.tools : [],
      tool_executions: [],
      output_contract: "terminal_domain_answer",
      execution_mode: reused ? "reused" : "executed",
      reused_from_artifact_id: candidate?.artifact_id || null,
      reused_from_run_id: candidate?.origin_run_id || null,
      world_graph_output_digest: reused ? candidate?.output_digest : null,
      world_graph_reason: reused ? "inputs_and_evidence_unchanged" : "no_matching_result",
      model_calls: reused ? [] : [{ usage: { prompt_tokens: 80, completion_tokens: 20, total_tokens: 100 }, model: "qwen-test" }]
    };
    if (includeToolSecret) {
      routeOutput.allowed_tools = ["document_read"];
      routeOutput.tool_executions = [{
        id: "tool-secret",
        name: "document_read",
        arguments: { bearer_token: "plaintext-tool-secret" },
        result: { ok: true, available: true, data: { private_value: "private-tool-result" } }
      }];
    }
    if (reused && reuseClaimMutation === "wrong_artifact") {
      routeOutput.reused_from_artifact_id = "wg_artifact_not_in_capsule";
    }
    if (reused && reuseClaimMutation === "changed_retrieved_context") {
      routeOutput.retrieved_context = "Untrusted context inserted after replay selection.";
    }
    if (reused && reuseClaimMutation === "reported_worker_call") {
      routeOutput.model_calls = [{ usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }];
    }
    if (reused && reuseClaimMutation === "oversized_reuse") {
      routeOutput.domain_answer = "x".repeat(140 * 1024);
    }
    const calls = [
      ...(!reused ? [{
        component: "agent:writing_synthesis_lora:call_1",
        agent_id: "writing_synthesis_lora",
        step_id: "s1",
        model: "qwen-test",
        prompt_tokens: 80,
        completion_tokens: 20,
        total_tokens: 100
      }] : []),
      {
        component: "final_synthesis",
        model: "qwen-test",
        prompt_tokens: 60,
        completion_tokens: 15,
        total_tokens: 75
      }
    ];
    const runtimePlan = {
      steps: [{
        id: "s1",
        adapter: "writing_synthesis_lora",
        task: "Prepare the concise note.",
        depends_on: [],
        evidence_requirement: "none"
      }],
      adapters: ["writing_synthesis_lora"],
      edges: [],
      routing: {
        mode: "session",
        candidate_count: 1,
        candidate_adapters: ["writing_synthesis_lora"],
        selected: [{ adapter: "writing_synthesis_lora", source: "explicit", reason: "Explicit mention." }]
      }
    };
    if (reused && reuseClaimMutation === "unauthorized_plan") {
      runtimePlan.steps[0].adapter = "private_other_tenant_agent";
      runtimePlan.adapters = ["private_other_tenant_agent"];
    }
    if (reused && reuseClaimMutation === "cyclic_plan") {
      runtimePlan.steps[0].depends_on = ["s1"];
    }
    return Response.json({
      ok: true,
      mode: "session_delegated_model_execute",
      modelProviderBaseUrl: "https://model-provider.internal/v1",
      baseModel: "qwen-test",
      agentModelMap: { writing_synthesis_lora: "qwen-test" },
      manifestRevision: "1".repeat(64),
      componentProvenance: {
        revision_authority: "runtime",
        manifest_revision: "1".repeat(64),
        base_model_id: "qwen-test",
        base_model_content_digest: runtimeBaseDigest,
        executor_code_digest: runtimeExecutorDigest,
        worker_execution_config_digest: runtimeWorkerConfigDigest,
        agents: [{
          adapter: "writing_synthesis_lora",
          agent_revision: runtimeAgent.agent_revision,
          revision_authority: "runtime",
          manifest_contract_digest: runtimeAgent.manifest_contract_digest,
          agent_content_digest: runtimeAgent.agent_content_digest,
          adapter_content_digest: runtimeAgent.adapter_content_digest
        }]
      },
      executionProvenance: {
        schema_version: "runtime-execution-provenance-v1",
        execution_id: `runtime_execution_${requests.length}`,
        receipt_hash: "9".repeat(64)
      },
      plan: runtimePlan,
      parallel: { workers: 1, batches: [{ batch: 1, width: 1, workers: 1, steps: ["s1"] }], maxBatchWidth: 1, parallelizable: false },
      expertOutputs: reused && reuseClaimMutation === "missing_output" ? [] : [routeOutput],
      finalAnswer: "The concise validated note.",
      worldGraph: {
        kept: reused ? 1 : 0,
        refreshed: reused ? 0 : 1,
        decisions: [{
          step_id: "s1",
          adapter: "writing_synthesis_lora",
          action: reused ? "kept" : "refresh",
          reason: reused ? "inputs_and_evidence_unchanged" : "no_matching_result",
          origin_run_id: candidate?.origin_run_id || null
        }]
      },
      tokenAccounting: {
        schema_version: "router-token-accounting-v1",
        provider_reported: true,
        complete: true,
        call_count: calls.length,
        calls,
        totals: {
          prompt_tokens: calls.reduce((sum, item) => sum + item.prompt_tokens, 0),
          completion_tokens: calls.reduce((sum, item) => sum + item.completion_tokens, 0),
          total_tokens: calls.reduce((sum, item) => sum + item.total_tokens, 0)
        },
        missing_usage: []
      }
    });
  });
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "virenis-worldgraph-remote-"));
  app = await createApp({ dbPath: path.join(tmpDir, "db.json"), uploadRoot: path.join(tmpDir, "uploads") });
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
  expect(runtimeAgent?.revision_authority).toBe("runtime");
});

afterEach(async () => {
  await app?.locals?.drainBackgroundTasks?.({ timeoutMs: 5000 });
  await app?.locals?.store?.close?.();
  restoreFetch?.();
  for (const [key, value] of Object.entries(previousEnv || {})) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function send(sessionId, body = {}) {
  const queued = await request(app)
    .post(`/api/chat/sessions/${sessionId}/messages`)
    .set("Authorization", AUTH)
    .send({ content: QUERY, ...body })
    .expect(202);
  expect((await app.locals.drainBackgroundTasks({ timeoutMs: 5000 })).ok).toBe(true);
  return request(app).get(`/api/chat/runs/${queued.body.run_id}`).set("Authorization", AUTH).expect(200);
}

describe.sequential("WorldGraph real-runtime bridge", () => {
  it("sends a signed capsule, records reused routes, and bills only actual provider calls", async () => {
    const session = await request(app)
      .post("/api/chat/sessions")
      .set("Authorization", AUTH)
      .send({ title: "Remote WorldGraph" })
      .expect(201);

    const cold = (await send(session.body.session_id)).body;
    expect(cold).toMatchObject({
      status: "completed",
      world_graph: {
        kept: 0,
        refreshed: 1,
        total: 1,
        preparation: {
          capsule_created: false,
          eligible_candidates: 0,
          primary_reason: "no_matching_result"
        }
      },
      usage_receipt: { call_count: 2 }
    });
    expect(requests[0].world_graph).toBeUndefined();
    expect(cold.events.filter((event) => event.type === "route.started")).toHaveLength(1);

    const repeated = (await send(session.body.session_id)).body;
    const repeatedCapsule = signedWorldGraphPayload(requests[1].world_graph);
    expect(repeatedCapsule).toMatchObject({
      schema_version: "virenis-world-graph-v2",
      engine_revision: "world-graph-engine-v7",
      scope: {
        target_run_id: repeated.run_id,
        workspace_id: "remote_workspace",
        user_id: "remote_owner",
        session_id: session.body.session_id
      }
    });
    expect(repeatedCapsule.candidates).toHaveLength(1);
    expect(repeatedCapsule.candidates[0].runtime_component_state).toEqual({
      revision_authority: "runtime",
      base_model_id: "qwen-test",
      base_model_content_digest: `sha256:${runtimeBaseDigest}`,
      executor_code_digest: `sha256:${runtimeExecutorDigest}`,
      worker_execution_config_digest: `sha256:${runtimeWorkerConfigDigest}`
    });
    expect(repeated).toMatchObject({
      status: "completed",
      world_graph: {
        kept: 1,
        refreshed: 0,
        total: 1,
        preparation: {
          status: "ready",
          capsule_created: true,
          eligible_candidates: 1,
          primary_reason: "inputs_and_evidence_unchanged"
        }
      },
      usage_receipt: { call_count: 1 }
    });
    expect(repeated.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "world_graph.prepared",
        capsule_created: true,
        eligible_candidates: 1
      })
    ]));
    expect(JSON.stringify(repeated.world_graph.preparation)).not.toContain("replay_output");
    expect(JSON.stringify(repeated.world_graph.preparation)).not.toContain("artifact_id");
    expect(repeated.events.filter((event) => event.type === "route.started")).toHaveLength(0);
    expect(repeated.events.filter((event) => event.type === "route.reused")).toHaveLength(1);
    expect(repeated.expert_outputs[0]).toMatchObject({
      adapter: "writing_synthesis_lora",
      execution_mode: "reused"
    });
    expect(repeated.usage_receipt.components.some((item) => item.kind === "agent")).toBe(false);
  });

  it("reuses a stable exact request when web search is authorized but was not used", async () => {
    await app.locals.store.mutate((data) => {
      const agent = data.agents.find((item) => item.id === "writing_synthesis_lora");
      agent.tools = ["web_search"];
      return agent;
    });
    runtimeAgent = app.locals.store.read().agents.find((item) => item.id === "writing_synthesis_lora");
    const session = await request(app)
      .post("/api/chat/sessions")
      .set("Authorization", AUTH)
      .send({ title: "Stable web-capable WorldGraph" })
      .expect(201);

    const cold = (await send(session.body.session_id)).body;
    const repeated = (await send(session.body.session_id)).body;

    expect(cold.world_graph).toMatchObject({ kept: 0, refreshed: 1 });
    expect(signedWorldGraphPayload(requests[1].world_graph)?.candidates).toHaveLength(1);
    expect(repeated.world_graph).toMatchObject({ kept: 1, refreshed: 0 });
    expect(repeated.events.filter((event) => event.type === "route.reused")).toHaveLength(1);
    expect(repeated.usage_receipt.components.some((item) => item.kind === "agent")).toBe(false);
  });

  it("reports why an exact repeat cannot reuse work when its approved workflow changes", async () => {
    const session = await request(app)
      .post("/api/chat/sessions")
      .set("Authorization", AUTH)
      .send({ title: "Workflow-bound WorldGraph" })
      .expect(201);

    const cold = (await send(session.body.session_id)).body;
    const changedWorkflow = (await send(session.body.session_id, {
      requested_agent_ids: ["writing_synthesis_lora"]
    })).body;

    expect(cold.world_graph).toMatchObject({ kept: 0, refreshed: 1 });
    expect(requests[1].options.required_adapters).toEqual(["writing_synthesis_lora"]);
    expect(requests[1].world_graph).toBeUndefined();
    expect(changedWorkflow).toMatchObject({
      status: "completed",
      requested_agent_ids: ["writing_synthesis_lora"],
      world_graph: {
        kept: 0,
        refreshed: 1,
        preparation: {
          status: "no_match",
          capsule_created: false,
          exact_request_artifacts: 1,
          eligible_candidates: 0,
          primary_reason: "execution_settings_changed",
          exclusions: [expect.objectContaining({ reason: "execution_settings_changed", count: 1 })]
        },
        decisions: [expect.objectContaining({
          adapter: "writing_synthesis_lora",
          action: "refreshed",
          reason: "execution_settings_changed"
        })]
      },
      usage_receipt: { call_count: 2 }
    });
    expect(changedWorkflow.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "world_graph.prepared",
        capsule_created: false,
        eligible_candidates: 0,
        primary_reason: "execution_settings_changed"
      })
    ]));
    expect(JSON.stringify(changedWorkflow.world_graph.preparation)).not.toContain("replay_output");
    expect(JSON.stringify(changedWorkflow.world_graph.preparation)).not.toContain("artifact_id");

    // Once the same approved workflow repeats, the newer workflow-bound
    // artifact is eligible and the specialist worker is skipped.
    const sameWorkflow = (await send(session.body.session_id, {
      requested_agent_ids: ["writing_synthesis_lora"]
    })).body;
    expect(signedWorldGraphPayload(requests[2].world_graph)?.candidates).toHaveLength(1);
    expect(sameWorkflow.world_graph).toMatchObject({ kept: 1, refreshed: 0 });
    expect(sameWorkflow.events.filter((event) => event.type === "route.started")).toHaveLength(0);
    expect(sameWorkflow.usage_receipt.components.some((item) => item.kind === "agent")).toBe(false);
  });

  it("wakes the worker when the runtime model bytes change", async () => {
    const session = await request(app)
      .post("/api/chat/sessions")
      .set("Authorization", AUTH)
      .send({ title: "Remote revision change" })
      .expect(201);
    await send(session.body.session_id);
    runtimeBaseDigest = "7".repeat(64);
    const changed = (await send(session.body.session_id)).body;
    expect(signedWorldGraphPayload(requests[1].world_graph)?.candidates).toHaveLength(1);
    expect(changed).toMatchObject({
      status: "completed",
      world_graph: { kept: 0, refreshed: 1 },
      usage_receipt: { call_count: 2 }
    });
    expect(changed.events.filter((event) => event.type === "route.started")).toHaveLength(1);
  });

  it("persists only redacted tool receipts in route and replay storage", async () => {
    includeToolSecret = true;
    const session = await request(app)
      .post("/api/chat/sessions")
      .set("Authorization", AUTH)
      .send({ title: "Remote tool receipt redaction" })
      .expect(201);
    const run = (await send(session.body.session_id)).body;
    expect(run.status).toBe("completed");
    expect(run.expert_outputs[0].tool_executions[0]).toMatchObject({
      name: "document_read",
      arguments_redacted: true,
      result_data_redacted: true
    });
    const persisted = JSON.stringify(app.locals.store.read());
    expect(persisted).not.toContain("plaintext-tool-secret");
    expect(persisted).not.toContain("private-tool-result");
  });

  it.each([
    "wrong_artifact",
    "changed_retrieved_context",
    "reported_worker_call",
    "missing_output",
    "oversized_reuse",
    "unauthorized_plan",
    "cyclic_plan"
  ])("fails before persisting a false reuse claim: %s", async (mutation) => {
    const session = await request(app)
      .post("/api/chat/sessions")
      .set("Authorization", AUTH)
      .send({ title: `Remote invalid reuse ${mutation}` })
      .expect(201);
    await send(session.body.session_id);
    reuseClaimMutation = mutation;
    const rejected = (await send(session.body.session_id)).body;
    expect(rejected.status).toBe("failed");
    expect(rejected.events.filter((event) => event.type === "route.reused")).toHaveLength(0);
    expect(rejected.expert_outputs || []).toHaveLength(0);
    expect(app.locals.store.read().runSteps.filter((step) => step.run_id === rejected.run_id)).toHaveLength(0);
  });
});

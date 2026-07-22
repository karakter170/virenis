import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../server/app.js";
import { requireRuntimeConfigured, setRuntimeFetchForTests } from "../server/runtimeClient.js";
import { buildParallelBatches, enrichRuntimeRoutingTrace, normalizeRuntimeRouting, normalizeSharedMemory, planRoutes, sanitizeRuntimeFinalAnswer, sanitizeToolCalls, scopedRoutingContext } from "../server/tcarEngine.js";
import { chunkDocument, runtimeDocumentRevision } from "../server/documents.js";
import { appendAgentEvent } from "../server/outcomes.js";

let tmpDir;
let app;
let previousStoreDriver;
let previousActiveRunLimits;
const ACTIVE_RUN_LIMIT_ENV_KEYS = [
  "APP_MAX_ACTIVE_RUNS_PER_USER",
  "APP_MAX_ACTIVE_RUNS_PER_WORKSPACE",
  "APP_MAX_ACTIVE_RUNS_GLOBAL"
];
const resetRuntimeFetchTransport = setRuntimeFetchForTests((...args) => globalThis.fetch(...args));

afterAll(() => resetRuntimeFetchTransport());

beforeEach(async () => {
  previousStoreDriver = process.env.WEB_STORE_DRIVER;
  previousActiveRunLimits = Object.fromEntries(
    ACTIVE_RUN_LIMIT_ENV_KEYS.map((key) => [key, process.env[key]])
  );
  process.env.WEB_STORE_DRIVER = "json";
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tcar-chat-"));
  app = await createApp({
    dbPath: path.join(tmpDir, "db.json"),
    uploadRoot: tmpDir
  });
});

afterEach(async () => {
  await app?.locals?.drainBackgroundTasks?.({ timeoutMs: 5000 });
  await app?.locals?.store?.close?.();
  if (previousStoreDriver === undefined) {
    delete process.env.WEB_STORE_DRIVER;
  } else {
    process.env.WEB_STORE_DRIVER = previousStoreDriver;
  }
  for (const key of ACTIVE_RUN_LIMIT_ENV_KEYS) {
    if (previousActiveRunLimits[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = previousActiveRunLimits[key];
    }
  }
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
  for (let attempt = 0; attempt < 800; attempt += 1) {
    const response = await request(app).get(`/api/chat/runs/${runId}`).expect(200);
    if (["completed", "failed"].includes(response.body.status)) {
      return response.body;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Run ${runId} did not complete.`);
}

async function waitForRunAs(runId, authorization) {
  for (let attempt = 0; attempt < 800; attempt += 1) {
    const response = await request(app)
      .get(`/api/chat/runs/${runId}`)
      .set("Authorization", authorization)
      .expect(200);
    if (["completed", "failed"].includes(response.body.status)) {
      return response.body;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Run ${runId} did not complete.`);
}

async function waitForValidation(validationRunId) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const response = await request(app).get(`/api/admin/validation/runs/${validationRunId}`).expect(200);
    if (["completed", "failed"].includes(response.body.status)) {
      return response.body;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Validation run ${validationRunId} did not complete.`);
}

describe("runtime and catalog", () => {
  it("routes an agent's attached knowledge before the parent agent", () => {
    const plan = planRoutes({
      query: "@launch_risk_lora assess the launch",
      agents: [
        {
          id: "launch_risk_lora",
          title: "Launch risk",
          routing_cues: ["launch"],
          resources: ["agent:launch_brief_lora"],
          enabled: true
        },
        {
          id: "launch_brief_lora",
          title: "Launch brief source agent",
          document: { title: "Launch brief" },
          enabled: true
        }
      ],
      maxRoutingAdapters: 1
    });

    const resourceStep = plan.steps.find((step) => step.adapter === "launch_brief_lora");
    const parentStep = plan.steps.find((step) => step.adapter === "launch_risk_lora");
    expect(resourceStep).toBeTruthy();
    expect(parentStep.depends_on).toContain(resourceStep.id);
  });

  it("turns an Agent Studio handoff into an upstream execution step", () => {
    const plan = planRoutes({
      query: "@business_plan_agent create a textile business plan",
      agents: [
        {
          id: "textile_agent",
          title: "Textile Agent",
          enabled: true
        },
        {
          id: "business_plan_agent",
          title: "Business Plan Agent",
          consumes: ["agent:textile_agent:output"],
          enabled: true
        }
      ],
      maxRoutingAdapters: 2
    });

    const source = plan.steps.find((step) => step.adapter === "textile_agent");
    const destination = plan.steps.find((step) => step.adapter === "business_plan_agent");
    expect(source).toBeTruthy();
    expect(destination.depends_on).toContain(source.id);
  });

  it("compiles handoffs and knowledge dependencies for valid hyphenated agent ids", () => {
    const plan = planRoutes({
      query: "@reply-writer prepare the final reply",
      agents: [
        {
          id: "source-agent",
          title: "Source Agent",
          enabled: true
        },
        {
          id: "knowledge-source",
          title: "Knowledge Source",
          document: { title: "Approved source" },
          enabled: true
        },
        {
          id: "reply-writer",
          title: "Reply Writer",
          consumes: ["agent:source-agent:output"],
          resources: ["agent:knowledge-source"],
          enabled: true
        }
      ],
      maxRoutingAdapters: 3
    });

    const source = plan.steps.find((step) => step.adapter === "source-agent");
    const knowledge = plan.steps.find((step) => step.adapter === "knowledge-source");
    const destination = plan.steps.find((step) => step.adapter === "reply-writer");
    expect(source).toBeTruthy();
    expect(knowledge).toMatchObject({ resource_support: true });
    expect(destination.depends_on).toEqual(expect.arrayContaining([source.id, knowledge.id]));
  });

  it("excludes disabled and unmounted agents from the routing scope", () => {
    const session = { workspace_id: "workspace_a", created_by: "alice" };
    const context = scopedRoutingContext({
      session,
      agents: [
        { id: "active_lora", workspace_id: "workspace_a", visibility: "private", created_by: "alice", enabled: true, mounted: true },
        { id: "pending_lora", workspace_id: "workspace_a", visibility: "private", created_by: "alice", enabled: true, mounted: false },
        { id: "archived_lora", workspace_id: "workspace_a", visibility: "private", created_by: "alice", enabled: false, mounted: true },
        { id: "other_owner_lora", workspace_id: "workspace_a", visibility: "private", created_by: "bob", enabled: true, mounted: true },
        { id: "legacy_active_lora", enabled: true }
      ],
      documents: []
    });

    expect(context.allowedAdapters).toEqual(["active_lora"]);
    expect(context.agents.map((agent) => agent.id)).toEqual(["active_lora"]);
  });

  it("honors session-only agent deactivation in the routing scope", () => {
    const context = scopedRoutingContext({
      session: {
        session_id: "session_a",
        workspace_id: "workspace_a",
        created_by: "alice",
        inactive_agent_ids: ["paused_lora"]
      },
      agents: [
        { id: "paused_lora", workspace_id: "workspace_a", visibility: "private", created_by: "alice", enabled: true, mounted: true },
        { id: "ready_lora", workspace_id: "workspace_a", visibility: "private", created_by: "alice", enabled: true, mounted: true }
      ],
      documents: []
    });

    expect(context.allowedAdapters).toEqual(["ready_lora"]);
  });

  it("keeps chat-scoped document agents in their chat while reusing Knowledge agents", () => {
    const session = { session_id: "session_a", workspace_id: "workspace_a", created_by: "alice" };
    const context = scopedRoutingContext({
      session,
      agents: [
        { id: "knowledge_lora", scope: "knowledge", workspace_id: "workspace_a", visibility: "private", created_by: "alice", enabled: true, mounted: true },
        { id: "legacy_knowledge_lora", workspace_id: "workspace_a", visibility: "private", created_by: "alice", enabled: true, mounted: true },
        { id: "chat_a_lora", scope: "chat", session_id: "session_a", workspace_id: "workspace_a", visibility: "private", created_by: "alice", enabled: true, mounted: true },
        { id: "chat_b_lora", scope: "chat", session_id: "session_b", workspace_id: "workspace_a", visibility: "private", created_by: "alice", enabled: true, mounted: true }
      ],
      documents: [
        { document_id: "knowledge_doc", scope: "knowledge", workspace_id: "workspace_a", visibility: "private", created_by: "alice", enabled: true },
        { document_id: "chat_a_doc", scope: "chat", session_id: "session_a", workspace_id: "workspace_a", visibility: "private", created_by: "alice", enabled: true },
        { document_id: "chat_b_doc", scope: "chat", session_id: "session_b", workspace_id: "workspace_a", visibility: "private", created_by: "alice", enabled: true }
      ]
    });

    expect(context.allowedAdapters).toEqual(["knowledge_lora", "legacy_knowledge_lora", "chat_a_lora"]);
    expect(context.documents.map((document) => document.document_id)).toEqual(["knowledge_doc", "chat_a_doc"]);
  });

  it("enriches explicit Runtime selections with the overridden agent's RealityRank", () => {
    const revision = `sha256:${"a".repeat(64)}`;
    const plan = enrichRuntimeRoutingTrace({
      routing: {
        mode: "explicit",
        candidate_adapters: ["lower_ranked_lora"],
        candidate_trace: [{ adapter: "lower_ranked_lora", reality_rank: null }],
        selected: [{ adapter: "lower_ranked_lora", source: "explicit", reality_rank: null }]
      }
    }, {
      lower_ranked_lora: {
        score: 0.2,
        sample_size: 4,
        routing_eligible: true,
        agent_revision: revision
      }
    }, [{ id: "lower_ranked_lora" }]);

    expect(plan.routing.selected[0]).toMatchObject({
      adapter: "lower_ranked_lora",
      source: "explicit",
      reality_rank: 0.2,
      rank_sample_size: 4,
      rank_supplied: true,
      agent_revision: revision
    });
    expect(plan.routing.candidate_trace[0].reality_rank).toBe(0.2);
  });

  it("preserves a bounded session-controller trace from the Runtime", () => {
    const routing = normalizeRuntimeRouting({
      mode: "session",
      candidate_count: 2,
      candidate_adapters: ["review_lora", "writer_lora"],
      orchestrator: {
        contract_version: "session-orchestrator-v1",
        decision: "delegate",
        model: "qwen36-awq",
        intent: "Review and summarize the launch.",
        evidence_requirement: "supplied_context",
        required_capabilities: ["launch review", "clear writing"],
        missing_capabilities: [],
        clarification_question: "",
        synthesis_brief: "Return one concise recommendation.",
        discovery_method: "authorized_manifest_index",
        authorized_agent_count: 12,
        active_primary_agent_count: 2,
        all_primary_agents_visible: true,
        discovered_candidate_count: 2,
        catalog_checked: ["review_lora", "writer_lora"],
        contract_protected_candidates: ["review_lora"],
        configured_agents_added: ["writer_lora"],
        rejected_adapters: ["invented_agent"],
        fallback_used: "",
        planning_completion: {
          finish_reason: "stop",
          complete: true,
          truncated: false,
          json_object_valid: true,
          selection_schema_valid: true,
          selection_semantically_accepted: false,
          decision_discarded: false,
          semantic_fallback_reason: "exact_contract_underselection"
        },
        planning_provider_failure: null,
        direct_decision_audit: {
          applied: true,
          forced_delegation: true,
          reason: "compound_exact_contract_proven",
          matched_adapters: ["review_lora"],
          selected_adapters: ["review_lora", "writer_lora"],
          declared_output_matches: [{
            output: "launch_recommendation",
            phrase: "launch recommendation",
            adapter: "writer_lora"
          }]
        },
        planning_call_performed: true,
        final_synthesis_required: true
      }
    });

    expect(routing.orchestrator).toEqual({
      contract_version: "session-orchestrator-v1",
      decision: "delegate",
      model: "qwen36-awq",
      intent: "Review and summarize the launch.",
      evidence_requirement: "supplied_context",
      required_capabilities: ["launch review", "clear writing"],
      missing_capabilities: [],
      clarification_question: "",
      direct_answer: "",
      synthesis_brief: "Return one concise recommendation.",
      discovery_method: "authorized_manifest_index",
      authorized_agent_count: 12,
      active_primary_agent_count: 2,
      all_primary_agents_visible: true,
      discovered_candidate_count: 2,
      catalog_checked: ["review_lora", "writer_lora"],
      contract_protected_candidates: ["review_lora"],
      configured_agents_added: ["writer_lora"],
      rejected_adapters: ["invented_agent"],
      fallback_used: "",
      planning_completion: {
        finish_reason: "stop",
        complete: true,
        truncated: false,
        json_object_valid: true,
        selection_schema_valid: true,
        selection_semantically_accepted: false,
        decision_discarded: false,
        semantic_fallback_reason: "exact_contract_underselection"
      },
      planning_provider_failure: null,
      direct_decision_audit: {
        applied: true,
        forced_delegation: true,
        reason: "compound_exact_contract_proven",
        matched_adapters: ["review_lora"],
        selected_adapters: ["review_lora", "writer_lora"],
        declared_output_matches: [{
          output: "launch_recommendation",
          phrase: "launch recommendation",
          adapter: "writer_lora"
        }]
      },
      planning_call_performed: true,
      final_synthesis_required: true
    });
  });

  it("fails closed for production real-mode runtime and auth configuration", () => {
    const previous = {
      NODE_ENV: process.env.NODE_ENV,
      TCAR_ENGINE_MODE: process.env.TCAR_ENGINE_MODE,
      TCAR_RUNTIME_API_URL: process.env.TCAR_RUNTIME_API_URL,
      TCAR_RUNTIME_API_KEY: process.env.TCAR_RUNTIME_API_KEY,
      APP_BASIC_AUTH_USER: process.env.APP_BASIC_AUTH_USER,
      APP_BASIC_AUTH_PASSWORD: process.env.APP_BASIC_AUTH_PASSWORD,
      APP_API_TOKENS_JSON: process.env.APP_API_TOKENS_JSON,
      APP_API_TOKENS: process.env.APP_API_TOKENS,
      APP_ALLOW_UNAUTHENTICATED: process.env.APP_ALLOW_UNAUTHENTICATED,
      APP_ALLOW_JSON_STORE: process.env.APP_ALLOW_JSON_STORE,
      DATABASE_URL: process.env.DATABASE_URL,
      APP_PUBLIC_ORIGIN: process.env.APP_PUBLIC_ORIGIN,
      APP_ALLOW_MISSING_PUBLIC_ORIGIN: process.env.APP_ALLOW_MISSING_PUBLIC_ORIGIN,
      APP_ALLOW_PUBLIC_BIND: process.env.APP_ALLOW_PUBLIC_BIND,
      APP_UNAUTHENTICATED_USER_ID: process.env.APP_UNAUTHENTICATED_USER_ID,
      APP_UNAUTHENTICATED_WORKSPACE_ID: process.env.APP_UNAUTHENTICATED_WORKSPACE_ID,
      APP_UNAUTHENTICATED_ROLE: process.env.APP_UNAUTHENTICATED_ROLE,
      TCAR_ALLOW_LOCAL_RUNTIME_URL: process.env.TCAR_ALLOW_LOCAL_RUNTIME_URL,
      TCAR_ALLOW_LOOPBACK_RUNTIME_TUNNEL: process.env.TCAR_ALLOW_LOOPBACK_RUNTIME_TUNNEL,
      TCAR_ALLOW_SAME_ORIGIN_RUNTIME_URL: process.env.TCAR_ALLOW_SAME_ORIGIN_RUNTIME_URL,
      TCAR_ALLOW_INSECURE_PRIVATE_RUNTIME_HTTP: process.env.TCAR_ALLOW_INSECURE_PRIVATE_RUNTIME_HTTP,
      WEB_ALLOW_INSECURE_PRIVATE_POSTGRES: process.env.WEB_ALLOW_INSECURE_PRIVATE_POSTGRES,
      HOST: process.env.HOST
    };

    try {
      process.env.NODE_ENV = "production";
      process.env.TCAR_ENGINE_MODE = "real";
      process.env.TCAR_RUNTIME_API_URL = "https://gpu-runtime.example.com";
      process.env.HOST = "127.0.0.1";
      delete process.env.TCAR_RUNTIME_API_KEY;
      delete process.env.APP_BASIC_AUTH_USER;
      delete process.env.APP_BASIC_AUTH_PASSWORD;
      delete process.env.APP_API_TOKENS_JSON;
      delete process.env.APP_API_TOKENS;
      delete process.env.APP_ALLOW_UNAUTHENTICATED;
      delete process.env.APP_ALLOW_JSON_STORE;
      delete process.env.DATABASE_URL;
      delete process.env.APP_PUBLIC_ORIGIN;
      delete process.env.APP_ALLOW_MISSING_PUBLIC_ORIGIN;
      delete process.env.APP_ALLOW_PUBLIC_BIND;
      delete process.env.APP_UNAUTHENTICATED_USER_ID;
      delete process.env.APP_UNAUTHENTICATED_WORKSPACE_ID;
      delete process.env.APP_UNAUTHENTICATED_ROLE;
      delete process.env.TCAR_ALLOW_LOCAL_RUNTIME_URL;
      delete process.env.TCAR_ALLOW_LOOPBACK_RUNTIME_TUNNEL;
      delete process.env.TCAR_ALLOW_SAME_ORIGIN_RUNTIME_URL;
      delete process.env.TCAR_ALLOW_INSECURE_PRIVATE_RUNTIME_HTTP;
      delete process.env.WEB_ALLOW_INSECURE_PRIVATE_POSTGRES;
      expect(() => requireRuntimeConfigured()).toThrow(/TCAR_RUNTIME_API_KEY/);

      process.env.TCAR_RUNTIME_API_KEY = "0123456789abcdef0123456789abcdef";
      expect(() => requireRuntimeConfigured()).toThrow(/Basic Auth|APP_API_TOKENS/);

      process.env.APP_API_TOKENS_JSON = "{bad";
      expect(() => requireRuntimeConfigured()).toThrow(/APP_API_TOKENS_JSON/);

      process.env.APP_API_TOKENS_JSON = JSON.stringify({
        weak: { user_id: "alice", workspace_id: "workspace_a", role: "user" }
      });
      expect(() => requireRuntimeConfigured()).toThrow(/weak|placeholder/);

      process.env.APP_API_TOKENS_JSON = JSON.stringify({
        "0123456789abcdef0123456789abcdef": { user_id: "alice", workspace_id: "workspace_a", role: "user" }
      });
      expect(() => requireRuntimeConfigured()).toThrow(/DATABASE_URL/);

      delete process.env.APP_API_TOKENS_JSON;

      process.env.APP_BASIC_AUTH_USER = "admin";
      process.env.APP_BASIC_AUTH_PASSWORD = "0123456789abcdef0123456789abcdef";
      expect(() => requireRuntimeConfigured()).toThrow(/DATABASE_URL/);

      process.env.DATABASE_URL = "postgres://user:pass@localhost:5432/tcar";
      expect(() => requireRuntimeConfigured()).toThrow(/APP_PUBLIC_ORIGIN/);

      process.env.APP_PUBLIC_ORIGIN = "https://app.example.com";
      expect(() => requireRuntimeConfigured()).toThrow(/real public web origin/);

      for (const invalidOrigin of [
        "https://localhost.localdomain",
        "https://0.0.0.0",
        "https://[::1]",
        "https://[::]"
      ]) {
        process.env.APP_PUBLIC_ORIGIN = invalidOrigin;
        expect(() => requireRuntimeConfigured()).toThrow(/real public web origin/);
      }

      process.env.APP_PUBLIC_ORIGIN = "http://app.prod.test";
      expect(() => requireRuntimeConfigured()).toThrow(/https/);

      process.env.APP_PUBLIC_ORIGIN = "https://app.prod.test";
      process.env.DATABASE_URL = "postgres://user:pass@postgres.prod.test:5432/tcar";
      expect(() => requireRuntimeConfigured()).toThrow(/sslmode=verify-full/);

      process.env.DATABASE_URL = "postgres://user:pass@postgres.prod.test:5432/tcar?sslmode=verify-full";
      expect(() => requireRuntimeConfigured()).not.toThrow();

      process.env.DATABASE_URL = "postgres://user:pass@postgres.prod.test:5432/tcar";
      process.env.WEB_ALLOW_INSECURE_PRIVATE_POSTGRES = "1";
      expect(() => requireRuntimeConfigured()).not.toThrow();
      delete process.env.WEB_ALLOW_INSECURE_PRIVATE_POSTGRES;
      process.env.DATABASE_URL = "postgres://user:pass@localhost:5432/tcar";

      process.env.TCAR_RUNTIME_API_URL = "http://gpu-runtime.prod.test:9000";
      expect(() => requireRuntimeConfigured()).toThrow(/must use HTTPS/);

      process.env.TCAR_ALLOW_INSECURE_PRIVATE_RUNTIME_HTTP = "1";
      expect(() => requireRuntimeConfigured()).not.toThrow();
      delete process.env.TCAR_ALLOW_INSECURE_PRIVATE_RUNTIME_HTTP;

      process.env.TCAR_RUNTIME_API_URL = "http://127.0.0.1:9000";
      expect(() => requireRuntimeConfigured()).toThrow(/private GPU runtime host/);

      process.env.TCAR_ALLOW_LOCAL_RUNTIME_URL = "1";
      expect(() => requireRuntimeConfigured()).not.toThrow();

      delete process.env.TCAR_ALLOW_LOCAL_RUNTIME_URL;
      process.env.TCAR_ALLOW_LOOPBACK_RUNTIME_TUNNEL = "1";
      expect(() => requireRuntimeConfigured()).not.toThrow();

      process.env.TCAR_RUNTIME_API_URL = "http://0.0.0.0:19000";
      expect(() => requireRuntimeConfigured()).toThrow(/loopback hostname/);

      delete process.env.TCAR_ALLOW_LOOPBACK_RUNTIME_TUNNEL;
      process.env.TCAR_RUNTIME_API_URL = "https://app.prod.test/runtime";
      expect(() => requireRuntimeConfigured()).toThrow(/different host/);

      process.env.TCAR_ALLOW_SAME_ORIGIN_RUNTIME_URL = "1";
      expect(() => requireRuntimeConfigured()).not.toThrow();

      delete process.env.TCAR_ALLOW_SAME_ORIGIN_RUNTIME_URL;
      process.env.TCAR_RUNTIME_API_URL = "https://gpu-runtime.prod.test";
      process.env.HOST = "0.0.0.0";
      expect(() => requireRuntimeConfigured()).toThrow(/APP_ALLOW_PUBLIC_BIND/);

      process.env.APP_ALLOW_PUBLIC_BIND = "1";
      expect(() => requireRuntimeConfigured()).not.toThrow();

      delete process.env.APP_BASIC_AUTH_USER;
      delete process.env.APP_BASIC_AUTH_PASSWORD;
      process.env.APP_ALLOW_UNAUTHENTICATED = "1";
      expect(() => requireRuntimeConfigured()).toThrow(/APP_UNAUTHENTICATED_USER_ID/);

      process.env.APP_UNAUTHENTICATED_USER_ID = "public_user";
      process.env.APP_UNAUTHENTICATED_WORKSPACE_ID = "workspace_default";
      expect(() => requireRuntimeConfigured()).toThrow(/APP_UNAUTHENTICATED_WORKSPACE_ID/);

      process.env.APP_UNAUTHENTICATED_WORKSPACE_ID = "workspace_public";
      process.env.APP_UNAUTHENTICATED_ROLE = "admin";
      expect(() => requireRuntimeConfigured()).toThrow(/unauthenticated admin/);

      process.env.APP_UNAUTHENTICATED_ROLE = "user";
      expect(() => requireRuntimeConfigured()).not.toThrow();
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });

  it("blocks cross-origin state changes when APP_PUBLIC_ORIGIN is configured", async () => {
    const previous = {
      NODE_ENV: process.env.NODE_ENV,
      APP_PUBLIC_ORIGIN: process.env.APP_PUBLIC_ORIGIN,
      API_RATE_LIMIT: process.env.API_RATE_LIMIT,
      APP_ALLOW_JSON_STORE: process.env.APP_ALLOW_JSON_STORE,
      APP_ALLOW_SAME_SITE_FETCH: process.env.APP_ALLOW_SAME_SITE_FETCH
    };
    const prodTmp = await fs.mkdtemp(path.join(os.tmpdir(), "tcar-chat-origin-"));

    try {
      process.env.NODE_ENV = "production";
      process.env.APP_PUBLIC_ORIGIN = "https://app.example.com";
      process.env.API_RATE_LIMIT = "0";
      process.env.APP_ALLOW_JSON_STORE = "1";
      delete process.env.APP_ALLOW_SAME_SITE_FETCH;
      const prodApp = await createApp({
        dbPath: path.join(prodTmp, "db.json"),
        uploadRoot: prodTmp,
        autoRun: false
      });

      await request(prodApp)
        .post("/api/chat/sessions")
        .set("Origin", "https://evil.example.com")
        .send({ title: "Blocked" })
        .expect(403);

      await request(prodApp)
        .post("/api/chat/sessions")
        .send({ title: "Missing origin" })
        .expect(403);

      await request(prodApp)
        .post("/api/chat/sessions")
        .set("Sec-Fetch-Site", "same-origin")
        .send({ title: "Fetch metadata allowed" })
        .expect(201);

      await request(prodApp)
        .post("/api/chat/sessions")
        .set("Sec-Fetch-Site", "same-site")
        .send({ title: "Same-site without exact origin blocked" })
        .expect(403);

      process.env.APP_ALLOW_SAME_SITE_FETCH = "1";
      await request(prodApp)
        .post("/api/chat/sessions")
        .set("Sec-Fetch-Site", "same-site")
        .send({ title: "Same-site explicitly allowed" })
        .expect(201);

      await request(prodApp)
        .post("/api/chat/sessions")
        .set("Origin", "https://app.example.com")
        .send({ title: "Allowed" })
        .expect(201);
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
      await fs.rm(prodTmp, { recursive: true, force: true });
    }
  });

  it("exposes unauthenticated health probes while keeping API routes protected", async () => {
    const previous = {
      NODE_ENV: process.env.NODE_ENV,
      APP_BASIC_AUTH_USER: process.env.APP_BASIC_AUTH_USER,
      APP_BASIC_AUTH_PASSWORD: process.env.APP_BASIC_AUTH_PASSWORD,
      APP_ALLOW_JSON_STORE: process.env.APP_ALLOW_JSON_STORE,
      WEB_READY_REQUIRE_RUNTIME: process.env.WEB_READY_REQUIRE_RUNTIME,
      WEB_READY_INCLUDE_STORE_COUNTS: process.env.WEB_READY_INCLUDE_STORE_COUNTS
    };
    const prodTmp = await fs.mkdtemp(path.join(os.tmpdir(), "tcar-chat-health-"));

    try {
      process.env.NODE_ENV = "production";
      process.env.APP_BASIC_AUTH_USER = "admin";
      process.env.APP_BASIC_AUTH_PASSWORD = "0123456789abcdef0123456789abcdef";
      process.env.APP_ALLOW_JSON_STORE = "1";
      delete process.env.WEB_READY_REQUIRE_RUNTIME;
      delete process.env.WEB_READY_INCLUDE_STORE_COUNTS;
      const prodApp = await createApp({
        dbPath: path.join(prodTmp, "db.json"),
        uploadRoot: prodTmp,
        autoRun: false
      });

      const health = await request(prodApp).get("/healthz").expect(200);
      expect(health.body.ok).toBe(true);
      const readiness = await request(prodApp).get("/readyz").expect(200);
      expect(readiness.body.ok).toBe(true);
      expect(readiness.body.ready).toBe(true);
      expect(readiness.body.store).toBeUndefined();
      await request(prodApp).get("/api/runtime/health").expect(401);
      const missingApi = await request(prodApp)
        .get("/api/does-not-exist")
        .auth("admin", "0123456789abcdef0123456789abcdef")
        .expect(404);
      expect(missingApi.type).toContain("json");
      expect(missingApi.body.error).toBe("not_found");
      expect(missingApi.body.request_id).toBeTruthy();
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
      await fs.rm(prodTmp, { recursive: true, force: true });
    }
  });

  it("marks every API response private and non-cacheable", async () => {
    const session = await createSession("Cache privacy");
    const responses = [
      await request(app).get("/api/chat/sessions").expect(200),
      await request(app).get(`/api/chat/sessions/${session.session_id}`).expect(200),
      await request(app).get("/api/documents").expect(200),
      await request(app).get("/api/marketplace").expect(200),
      await request(app).get("/api/not-a-real-route").expect(404)
    ];

    for (const response of responses) {
      expect(response.headers["cache-control"]).toBe("private, no-store");
      expect(response.headers.pragma).toBe("no-cache");
      expect(response.headers.expires).toBe("0");
    }

    const health = await request(app).get("/healthz").expect(200);
    expect(health.headers["cache-control"]).toBeUndefined();
  });

  it("keeps liveness healthy while readiness fails when durable storage is unavailable", async () => {
    const originalReadinessCheck = app.locals.store.readinessCheck.bind(app.locals.store);
    app.locals.store.readinessCheck = async () => {
      throw new Error("database connection lost");
    };

    try {
      const health = await request(app).get("/healthz").expect(200);
      expect(health.body.ok).toBe(true);
      expect(health.body.ready).toBeUndefined();

      const readiness = await request(app).get("/readyz").expect(503);
      expect(readiness.body).toMatchObject({
        ok: false,
        ready: false,
        service: "virenis",
        message: "Application is not ready."
      });
    } finally {
      app.locals.store.readinessCheck = originalReadinessCheck;
    }
  });

  it("fails readiness when the required runtime is live but reports ready false", async () => {
    const previous = {
      TCAR_ENGINE_MODE: process.env.TCAR_ENGINE_MODE,
      TCAR_RUNTIME_API_URL: process.env.TCAR_RUNTIME_API_URL,
      TCAR_RUNTIME_API_KEY: process.env.TCAR_RUNTIME_API_KEY,
      WEB_READY_REQUIRE_RUNTIME: process.env.WEB_READY_REQUIRE_RUNTIME
    };
    const previousFetch = globalThis.fetch;
    let runtimeReady = false;
    let runtimeService = "tcar-gpu-runtime-api";
    let runtimeProtocol = {
      chat_stream: "heartbeat-v1",
      plan_contract_versions: [
        "tcar-runtime-plan-contract-v5",
        "tcar-runtime-plan-contract-v4"
      ],
      terminal_recovery: "chat-recover-v1"
    };

    try {
      process.env.TCAR_ENGINE_MODE = "real";
      process.env.TCAR_RUNTIME_API_URL = "http://gpu-runtime.internal:9000";
      process.env.TCAR_RUNTIME_API_KEY = "runtime0123456789abcdef0123456789abcdef";
      process.env.WEB_READY_REQUIRE_RUNTIME = "1";
      globalThis.fetch = async () => Response.json({
        ok: true,
        ready: runtimeReady,
        service: runtimeService,
        protocol: runtimeProtocol
      });

      await request(app).get("/healthz").expect(200);
      const notReady = await request(app).get("/readyz").expect(503);
      expect(notReady.body).toMatchObject({ ok: false, ready: false });

      runtimeReady = true;
      const ready = await request(app).get("/readyz").expect(200);
      expect(ready.body).toMatchObject({
        ok: true,
        ready: true,
        runtime_mode: "real",
        runtime_protocol: {
          compatible: true,
          selected_plan_contract: "tcar-runtime-plan-contract-v5"
        }
      });

      runtimeProtocol = {
        ...runtimeProtocol,
        plan_contract_versions: ["tcar-runtime-plan-contract-v99"]
      };
      await request(app).get("/healthz").expect(200);
      await request(app).get("/readyz").expect(503);

      runtimeProtocol = {
        chat_stream: "heartbeat-v1",
        plan_contract_versions: ["tcar-runtime-plan-contract-v5"],
        terminal_recovery: "chat-recover-v1"
      };
      runtimeService = "unexpected-service";
      await request(app).get("/readyz").expect(503);
    } finally {
      globalThis.fetch = previousFetch;
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("supports explicit readiness store-count diagnostics for private probes", async () => {
    const previous = {
      NODE_ENV: process.env.NODE_ENV,
      APP_BASIC_AUTH_USER: process.env.APP_BASIC_AUTH_USER,
      APP_BASIC_AUTH_PASSWORD: process.env.APP_BASIC_AUTH_PASSWORD,
      APP_ALLOW_JSON_STORE: process.env.APP_ALLOW_JSON_STORE,
      WEB_READY_INCLUDE_STORE_COUNTS: process.env.WEB_READY_INCLUDE_STORE_COUNTS
    };
    const prodTmp = await fs.mkdtemp(path.join(os.tmpdir(), "tcar-chat-ready-counts-"));
    let prodApp;

    try {
      process.env.NODE_ENV = "production";
      process.env.APP_BASIC_AUTH_USER = "admin";
      process.env.APP_BASIC_AUTH_PASSWORD = "0123456789abcdef0123456789abcdef";
      process.env.APP_ALLOW_JSON_STORE = "1";
      process.env.WEB_READY_INCLUDE_STORE_COUNTS = "1";
      prodApp = await createApp({
        dbPath: path.join(prodTmp, "db.json"),
        uploadRoot: prodTmp,
        autoRun: false
      });

      const readiness = await request(prodApp).get("/readyz").expect(200);
      expect(readiness.body.ready).toBe(true);
      expect(readiness.body.store.agents).toBeGreaterThan(0);
      expect(readiness.body.store.sessions).toBe(0);
    } finally {
      await prodApp?.locals?.store?.close?.();
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
      await fs.rm(prodTmp, { recursive: true, force: true });
    }
  });

  it("redacts production 5xx details while returning a request id", async () => {
    const previous = {
      NODE_ENV: process.env.NODE_ENV,
      APP_ALLOW_JSON_STORE: process.env.APP_ALLOW_JSON_STORE,
      TCAR_ENGINE_MODE: process.env.TCAR_ENGINE_MODE,
      TCAR_RUNTIME_API_URL: process.env.TCAR_RUNTIME_API_URL
    };
    const previousFetch = globalThis.fetch;
    const previousConsoleError = console.error;
    const prodTmp = await fs.mkdtemp(path.join(os.tmpdir(), "tcar-chat-5xx-"));
    let prodApp;

    try {
      process.env.NODE_ENV = "production";
      process.env.APP_ALLOW_JSON_STORE = "1";
      process.env.TCAR_ENGINE_MODE = "real";
      process.env.TCAR_RUNTIME_API_URL = "http://gpu-runtime.internal:9000";
      globalThis.fetch = async () => {
        throw new Error("database password leaked in stack");
      };
      console.error = () => {};
      prodApp = await createApp({
        dbPath: path.join(prodTmp, "db.json"),
        uploadRoot: prodTmp,
        autoRun: false
      });

      const response = await request(prodApp)
        .get("/api/runtime/health")
        .set("X-Request-ID", "req-public-test-123")
        .expect(500);
      expect(response.headers["x-request-id"]).toBe("req-public-test-123");
      expect(response.body).toMatchObject({
        error: "internal_error",
        message: "Unexpected server error.",
        request_id: "req-public-test-123"
      });
      expect(JSON.stringify(response.body)).not.toContain("password");
    } finally {
      await prodApp?.locals?.store?.close?.();
      globalThis.fetch = previousFetch;
      console.error = previousConsoleError;
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
      await fs.rm(prodTmp, { recursive: true, force: true });
    }
  });

  it("redacts GPU runtime health internals for non-admin API users", async () => {
    const previous = {
      NODE_ENV: process.env.NODE_ENV,
      APP_ALLOW_JSON_STORE: process.env.APP_ALLOW_JSON_STORE,
      APP_API_TOKENS_JSON: process.env.APP_API_TOKENS_JSON,
      APP_BASIC_AUTH_USER: process.env.APP_BASIC_AUTH_USER,
      APP_BASIC_AUTH_PASSWORD: process.env.APP_BASIC_AUTH_PASSWORD,
      TCAR_ENGINE_MODE: process.env.TCAR_ENGINE_MODE,
      TCAR_RUNTIME_API_URL: process.env.TCAR_RUNTIME_API_URL,
      TCAR_RUNTIME_API_KEY: process.env.TCAR_RUNTIME_API_KEY
    };
    const previousFetch = globalThis.fetch;
    const prodTmp = await fs.mkdtemp(path.join(os.tmpdir(), "tcar-chat-health-redaction-"));
    const userToken = "user0123456789abcdef0123456789abcdef";
    const adminToken = "admin0123456789abcdef0123456789abcdef";
    const runtimePayload = {
      ok: true,
      service: "tcar-gpu-runtime-api",
      auth_required: true,
      project_root: "/srv/tcar-runtime",
      manifest: {
        path: "/srv/tcar-runtime/configs/dummy_tcar_lora_suite.json",
        suite: "dummy_tcar_lora_suite",
        adapters: 18,
        active_adapters: 17,
        archived_adapters: 1,
        valid: true
      },
      vllm: {
        base_url: "http://127.0.0.1:8000/v1",
        base_model: "qwen36-awq",
        models_endpoint_ok: true,
        health: {
          ok: true,
          status: 200,
          url: "http://127.0.0.1:8000/health",
          body: { queue: "internal" },
          error: "internal transport detail"
        },
        dynamic_lora_requested: true
      },
      executor: {
        reload_per_request: true,
        parallel_workers: 2
      },
      router: {
        mode: "tcandon",
        base_url: "http://127.0.0.1:8010/v1",
        model: "tcandon-router",
        models_endpoint_ok: true
      }
    };
    let prodApp;

    try {
      process.env.NODE_ENV = "production";
      process.env.APP_ALLOW_JSON_STORE = "1";
      delete process.env.APP_BASIC_AUTH_USER;
      delete process.env.APP_BASIC_AUTH_PASSWORD;
      process.env.APP_API_TOKENS_JSON = JSON.stringify({
        [userToken]: { user_id: "alice", workspace_id: "workspace_a", role: "user" },
        [adminToken]: { user_id: "ops", workspace_id: "workspace_ops", role: "admin" }
      });
      process.env.TCAR_ENGINE_MODE = "real";
      process.env.TCAR_RUNTIME_API_URL = "http://gpu-runtime.internal:9000";
      process.env.TCAR_RUNTIME_API_KEY = "runtime0123456789abcdef0123456789abcdef";
      globalThis.fetch = async () =>
        new Response(JSON.stringify(runtimePayload), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });

      prodApp = await createApp({
        dbPath: path.join(prodTmp, "db.json"),
        uploadRoot: prodTmp,
        autoRun: false
      });

      const userHealth = await request(prodApp)
        .get("/api/runtime/health")
        .set("Authorization", `Bearer ${userToken}`)
        .expect(200);
      expect(userHealth.body.ok).toBe(true);
      expect(userHealth.body.manifest.agents).toBe(18);
      expect(userHealth.body.manifest.path).toBeUndefined();
      expect(userHealth.body.model_api.base_model).toBe("qwen36-awq");
      expect(userHealth.body.model_api.base_url).toBeUndefined();
      expect(userHealth.body.model_api.health).toEqual({ ok: true, status: 200 });
      expect(userHealth.body.router).toEqual({
        mode: "tcandon",
        model: "tcandon-router",
        models_endpoint_ok: true
      });
      expect(userHealth.body.router.base_url).toBeUndefined();
      expect(userHealth.body.project_root).toBeUndefined();
      expect(userHealth.body.executor).toBeUndefined();
      expect(JSON.stringify(userHealth.body)).not.toContain("127.0.0.1");
      expect(JSON.stringify(userHealth.body)).not.toContain("/srv/tcar-runtime");
      expect(JSON.stringify(userHealth.body)).not.toContain("internal transport detail");

      const adminHealth = await request(prodApp)
        .get("/api/runtime/health")
        .set("Authorization", `Bearer ${adminToken}`)
        .expect(200);
      expect(adminHealth.body.project_root).toBe("/srv/tcar-runtime");
      expect(adminHealth.body.manifest.path).toContain("dummy_tcar_lora_suite.json");
      expect(adminHealth.body.vllm.base_url).toBe("http://127.0.0.1:8000/v1");
      expect(adminHealth.body.router.base_url).toBe("http://127.0.0.1:8010/v1");
      expect(adminHealth.body.executor.parallel_workers).toBe(2);
    } finally {
      await prodApp?.locals?.store?.close?.();
      globalThis.fetch = previousFetch;
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
      await fs.rm(prodTmp, { recursive: true, force: true });
    }
  });

  it("rate-limits API traffic with app-local bounded buckets", async () => {
    const previous = {
      NODE_ENV: process.env.NODE_ENV,
      API_RATE_LIMIT: process.env.API_RATE_LIMIT,
      API_RATE_WINDOW_MS: process.env.API_RATE_WINDOW_MS,
      API_RATE_MAX_BUCKETS: process.env.API_RATE_MAX_BUCKETS,
      APP_ALLOW_JSON_STORE: process.env.APP_ALLOW_JSON_STORE,
      WEB_STORE_DRIVER: process.env.WEB_STORE_DRIVER
    };
    const prodTmp = await fs.mkdtemp(path.join(os.tmpdir(), "tcar-chat-rate-"));
    let prodApp;

    try {
      process.env.NODE_ENV = "production";
      process.env.API_RATE_LIMIT = "2";
      process.env.API_RATE_WINDOW_MS = "60000";
      process.env.API_RATE_MAX_BUCKETS = "4";
      process.env.APP_ALLOW_JSON_STORE = "1";
      process.env.WEB_STORE_DRIVER = "json";
      prodApp = await createApp({
        dbPath: path.join(prodTmp, "db.json"),
        uploadRoot: prodTmp,
        autoRun: false
      });

      await request(prodApp).get("/api/runtime/health").expect(200);
      await request(prodApp).get("/api/runtime/health").expect(200);
      await request(prodApp).get("/api/runtime/health").expect(429);
      expect(prodApp.locals.rateBuckets.size).toBeLessThanOrEqual(4);
    } finally {
      await prodApp?.locals?.store?.close?.();
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
      await fs.rm(prodTmp, { recursive: true, force: true });
    }
  });

  it("rate-limits unauthenticated API traffic before auth challenges", async () => {
    const previous = {
      NODE_ENV: process.env.NODE_ENV,
      API_RATE_LIMIT: process.env.API_RATE_LIMIT,
      API_RATE_WINDOW_MS: process.env.API_RATE_WINDOW_MS,
      API_RATE_MAX_BUCKETS: process.env.API_RATE_MAX_BUCKETS,
      APP_BASIC_AUTH_USER: process.env.APP_BASIC_AUTH_USER,
      APP_BASIC_AUTH_PASSWORD: process.env.APP_BASIC_AUTH_PASSWORD,
      APP_ALLOW_JSON_STORE: process.env.APP_ALLOW_JSON_STORE,
      WEB_STORE_DRIVER: process.env.WEB_STORE_DRIVER
    };
    const prodTmp = await fs.mkdtemp(path.join(os.tmpdir(), "tcar-chat-unauth-rate-"));
    let prodApp;

    try {
      process.env.NODE_ENV = "production";
      process.env.API_RATE_LIMIT = "1";
      process.env.API_RATE_WINDOW_MS = "60000";
      process.env.API_RATE_MAX_BUCKETS = "4";
      process.env.APP_BASIC_AUTH_USER = "admin";
      process.env.APP_BASIC_AUTH_PASSWORD = "0123456789abcdef0123456789abcdef";
      process.env.APP_ALLOW_JSON_STORE = "1";
      process.env.WEB_STORE_DRIVER = "json";
      prodApp = await createApp({
        dbPath: path.join(prodTmp, "db.json"),
        uploadRoot: prodTmp,
        autoRun: false
      });

      await request(prodApp).get("/healthz").expect(200);
      await request(prodApp).get("/api/runtime/health").expect(401);
      await request(prodApp).get("/api/runtime/health").expect(429);
      expect(prodApp.locals.rateBuckets.size).toBe(1);
    } finally {
      await prodApp?.locals?.store?.close?.();
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
      await fs.rm(prodTmp, { recursive: true, force: true });
    }
  });

  it("supports bearer-token-only production auth without falling back to local identity", async () => {
    const previous = {
      NODE_ENV: process.env.NODE_ENV,
      APP_BASIC_AUTH_USER: process.env.APP_BASIC_AUTH_USER,
      APP_BASIC_AUTH_PASSWORD: process.env.APP_BASIC_AUTH_PASSWORD,
      APP_API_TOKENS_JSON: process.env.APP_API_TOKENS_JSON,
      APP_ALLOW_JSON_STORE: process.env.APP_ALLOW_JSON_STORE,
      APP_PUBLIC_ORIGIN: process.env.APP_PUBLIC_ORIGIN,
      TCAR_ENGINE_MODE: process.env.TCAR_ENGINE_MODE
    };
    const prodTmp = await fs.mkdtemp(path.join(os.tmpdir(), "tcar-chat-bearer-"));
    const token = "abcdef0123456789abcdef0123456789";

    try {
      process.env.NODE_ENV = "production";
      delete process.env.APP_BASIC_AUTH_USER;
      delete process.env.APP_BASIC_AUTH_PASSWORD;
      process.env.APP_API_TOKENS_JSON = JSON.stringify({
        [token]: { user_id: "bearer_user", workspace_id: "workspace_bearer", role: "user" }
      });
      process.env.APP_ALLOW_JSON_STORE = "1";
      process.env.APP_PUBLIC_ORIGIN = "https://app.example.com";
      process.env.TCAR_ENGINE_MODE = "simulator";
      const prodApp = await createApp({
        dbPath: path.join(prodTmp, "db.json"),
        uploadRoot: prodTmp,
        autoRun: false
      });

      await request(prodApp).get("/healthz").expect(200);
      await request(prodApp).get("/api/runtime/health").expect(401);
      await request(prodApp)
        .get("/api/runtime/health")
        .set("Authorization", "Bearer wrong-token")
        .expect(401);

      await request(prodApp)
        .get("/api/runtime/health")
        .set("Authorization", `Bearer ${token}`)
        .expect(200);

      const session = await request(prodApp)
        .post("/api/chat/sessions")
        .set("Authorization", `Bearer ${token}`)
        .send({ title: "Bearer only", workspace_id: "other_workspace" })
        .expect(201);
      expect(session.body.created_by).toBe("bearer_user");
      expect(session.body.workspace_id).toBe("workspace_bearer");
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
      await fs.rm(prodTmp, { recursive: true, force: true });
    }
  });

  it("uses explicit production unauthenticated identity when unauthenticated mode is acknowledged", async () => {
    const previous = {
      NODE_ENV: process.env.NODE_ENV,
      APP_BASIC_AUTH_USER: process.env.APP_BASIC_AUTH_USER,
      APP_BASIC_AUTH_PASSWORD: process.env.APP_BASIC_AUTH_PASSWORD,
      APP_API_TOKENS_JSON: process.env.APP_API_TOKENS_JSON,
      APP_API_TOKENS: process.env.APP_API_TOKENS,
      APP_ALLOW_JSON_STORE: process.env.APP_ALLOW_JSON_STORE,
      APP_ALLOW_UNAUTHENTICATED: process.env.APP_ALLOW_UNAUTHENTICATED,
      APP_UNAUTHENTICATED_USER_ID: process.env.APP_UNAUTHENTICATED_USER_ID,
      APP_UNAUTHENTICATED_WORKSPACE_ID: process.env.APP_UNAUTHENTICATED_WORKSPACE_ID,
      APP_UNAUTHENTICATED_ROLE: process.env.APP_UNAUTHENTICATED_ROLE,
      APP_PUBLIC_ORIGIN: process.env.APP_PUBLIC_ORIGIN,
      TCAR_ENGINE_MODE: process.env.TCAR_ENGINE_MODE
    };
    const prodTmp = await fs.mkdtemp(path.join(os.tmpdir(), "tcar-chat-public-identity-"));
    let prodApp;

    try {
      process.env.NODE_ENV = "production";
      delete process.env.APP_BASIC_AUTH_USER;
      delete process.env.APP_BASIC_AUTH_PASSWORD;
      delete process.env.APP_API_TOKENS_JSON;
      delete process.env.APP_API_TOKENS;
      process.env.APP_ALLOW_JSON_STORE = "1";
      process.env.APP_ALLOW_UNAUTHENTICATED = "1";
      process.env.APP_UNAUTHENTICATED_USER_ID = "public_chat_user";
      process.env.APP_UNAUTHENTICATED_WORKSPACE_ID = "workspace_public_chat";
      process.env.APP_UNAUTHENTICATED_ROLE = "user";
      process.env.APP_PUBLIC_ORIGIN = "https://public-chat.prod.test";
      process.env.TCAR_ENGINE_MODE = "simulator";
      expect(() => requireRuntimeConfigured()).not.toThrow();
      prodApp = await createApp({
        dbPath: path.join(prodTmp, "db.json"),
        uploadRoot: prodTmp,
        autoRun: false
      });

      const identity = await request(prodApp).get("/api/auth/me").expect(200);
      expect(identity.body).toMatchObject({
        user_id: "public_chat_user",
        workspace_id: "workspace_public_chat",
        role: "user",
        auth_type: "local",
        is_admin: false
      });

      const session = await request(prodApp)
        .post("/api/chat/sessions")
        .set("Origin", "https://public-chat.prod.test")
        .send({ title: "Public identity" })
        .expect(201);
      expect(session.body.created_by).toBe("public_chat_user");
      expect(session.body.workspace_id).toBe("workspace_public_chat");
    } finally {
      await prodApp?.locals?.store?.close?.();
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
      await fs.rm(prodTmp, { recursive: true, force: true });
    }
  });

  it("keeps viewer bearer tokens read-only", async () => {
    const previousTokens = process.env.APP_API_TOKENS_JSON;
    process.env.APP_API_TOKENS_JSON = JSON.stringify({
      token_viewer: { user_id: "viewer", workspace_id: "workspace_viewer", role: "viewer" }
    });

    try {
      const identity = await request(app)
        .get("/api/auth/me")
        .set("Authorization", "Bearer token_viewer")
        .expect(200);
      expect(identity.body).toMatchObject({
        user_id: "viewer",
        workspace_id: "workspace_viewer",
        role: "viewer",
        is_admin: false,
        is_viewer: true
      });

      await request(app)
        .get("/api/runtime/health")
        .set("Authorization", "Bearer token_viewer")
        .expect(200);

      const blocked = await request(app)
        .post("/api/chat/sessions")
        .set("Authorization", "Bearer token_viewer")
        .send({ title: "Viewer write" })
        .expect(403);
      expect(blocked.body.error).toBe("read_only");
    } finally {
      if (previousTokens === undefined) {
        delete process.env.APP_API_TOKENS_JSON;
      } else {
        process.env.APP_API_TOKENS_JSON = previousTokens;
      }
    }
  });

  it("rejects viewer writes before parsing oversized JSON bodies", async () => {
    const previous = {
      APP_API_TOKENS_JSON: process.env.APP_API_TOKENS_JSON,
      APP_MAX_JSON_BODY_BYTES: process.env.APP_MAX_JSON_BODY_BYTES
    };
    const limitedTmp = await fs.mkdtemp(path.join(os.tmpdir(), "tcar-chat-viewer-body-"));
    let limitedApp;
    process.env.APP_API_TOKENS_JSON = JSON.stringify({
      token_viewer: { user_id: "viewer", workspace_id: "workspace_viewer", role: "viewer" }
    });
    process.env.APP_MAX_JSON_BODY_BYTES = "48";
    try {
      limitedApp = await createApp({
        dbPath: path.join(limitedTmp, "db.json"),
        uploadRoot: limitedTmp
      });
      const response = await request(limitedApp)
        .post("/api/chat/sessions")
        .set("Authorization", "Bearer token_viewer")
        .send({ title: "x".repeat(256) })
        .expect(403);
      expect(response.body.error).toBe("read_only");
    } finally {
      await limitedApp?.locals?.store?.close?.();
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
      await fs.rm(limitedTmp, { recursive: true, force: true });
    }
  });

  it("reports seeded runtime health and mounted model names", async () => {
    const health = await request(app).get("/api/runtime/health").expect(200);
    expect(health.body.ok).toBe(true);
    expect(health.body.manifest.agents).toBeGreaterThanOrEqual(17);
    expect(health.body.model_api.mode).toContain("simulator");

    const models = await request(app).get("/api/runtime/models").expect(200);
    expect(models.body.models.some((model) => model.id === "qwen36-awq")).toBe(true);
    expect(models.body.models).toHaveLength(1);
  });

  it("marks async chat runs failed if the background processor rejects outside normal handling", async () => {
    const previousTokens = process.env.APP_API_TOKENS_JSON;
    process.env.APP_API_TOKENS_JSON = JSON.stringify({
      background_failure_user: { user_id: "background_user", workspace_id: "workspace_background", role: "user" }
    });
    const failureTmp = await fs.mkdtemp(path.join(os.tmpdir(), "tcar-chat-background-failure-"));
    let failingApp;
    try {
      failingApp = await createApp({
        dbPath: path.join(failureTmp, "db.json"),
        uploadRoot: failureTmp,
        chatProcessor: async () => {
          throw new Error("super-secret-background-failure");
        }
      });
      const session = await request(failingApp)
        .post("/api/chat/sessions")
        .set("Authorization", "Bearer background_failure_user")
        .send({ title: "Background failure" })
        .expect(201);
      const queued = await request(failingApp)
        .post(`/api/chat/sessions/${session.body.session_id}/messages`)
        .set("Authorization", "Bearer background_failure_user")
        .send({ content: "Trigger background failure." })
        .expect(202);

      for (let attempt = 0; attempt < 80; attempt += 1) {
        const response = await request(failingApp)
          .get(`/api/chat/runs/${queued.body.run_id}`)
          .set("Authorization", "Bearer background_failure_user")
          .expect(200);
        if (response.body.status === "failed") {
          expect(response.body.error.message).toBe("The run failed before completion. Try again or contact support with the run id.");
          expect(JSON.stringify(response.body)).not.toContain("super-secret-background-failure");
          expect(response.body.events.find((event) => event.type === "run.failed").message).toBe(response.body.error.message);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error("background failure run did not transition to failed");
    } finally {
      await failingApp?.locals?.drainBackgroundTasks?.({ timeoutMs: 5000 });
      await failingApp?.locals?.store?.close?.();
      await fs.rm(failureTmp, { recursive: true, force: true });
      if (previousTokens === undefined) {
        delete process.env.APP_API_TOKENS_JSON;
      } else {
        process.env.APP_API_TOKENS_JSON = previousTokens;
      }
    }
  });

  it("bounds list responses for sessions, agents, documents, and chunks", async () => {
    const previous = {
      WEB_LIST_DEFAULT_LIMIT: process.env.WEB_LIST_DEFAULT_LIMIT,
      WEB_LIST_MAX_LIMIT: process.env.WEB_LIST_MAX_LIMIT
    };
    process.env.WEB_LIST_DEFAULT_LIMIT = "2";
    process.env.WEB_LIST_MAX_LIMIT = "3";

    try {
      await Promise.all(Array.from({ length: 4 }, (_, index) => createSession(`Bounded list ${index}`)));

      const defaultSessions = await request(app).get("/api/chat/sessions").expect(200);
      expect(defaultSessions.body.sessions).toHaveLength(2);
      expect(defaultSessions.body.total).toBe(4);
      expect(defaultSessions.body.limit).toBe(2);
      expect(defaultSessions.body.offset).toBe(0);

      const cappedSessions = await request(app).get("/api/chat/sessions?limit=99").expect(200);
      expect(cappedSessions.body.sessions).toHaveLength(3);
      expect(cappedSessions.body.total).toBe(4);
      expect(cappedSessions.body.limit).toBe(3);
      expect(cappedSessions.body.offset).toBe(0);

      const offsetSessions = await request(app).get("/api/chat/sessions?limit=2&offset=2").expect(200);
      expect(offsetSessions.body.sessions).toHaveLength(2);
      expect(offsetSessions.body.total).toBe(4);
      expect(offsetSessions.body.limit).toBe(2);
      expect(offsetSessions.body.offset).toBe(2);

      await request(app).get("/api/chat/sessions?limit=bad").expect(400);
      await request(app).get("/api/chat/sessions?offset=-1").expect(400);

      const agents = await request(app).get("/api/agents?limit=2").expect(200);
      expect(agents.body.agents).toHaveLength(2);
      expect(agents.body.total).toBeGreaterThan(2);
      expect(agents.body.limit).toBe(2);
      expect(agents.body.offset).toBe(0);

      const sourceText = Array.from({ length: 220 }, (_, index) => `analytics metric ${index} variance trend`).join(" ");
      const upload = await request(app)
        .post("/api/documents")
        .field("title", "List Bounds Manual")
        .field("routing_cues", "analytics, bounded lists")
        .field("max_words", "80")
        .field("overlap_words", "0")
        .attach("file", Buffer.from(sourceText), "bounds.txt")
        .expect(201);
      expect(upload.body.chunks).toBeGreaterThan(2);

      const documents = await request(app).get("/api/documents?limit=1").expect(200);
      expect(documents.body.documents).toHaveLength(1);
      expect(documents.body.total).toBe(1);
      expect(documents.body.limit).toBe(1);
      expect(documents.body.offset).toBe(0);

      const chunks = await request(app)
        .get(`/api/documents/${upload.body.document_id}/chunks?limit=2&offset=1`)
        .expect(200);
      expect(chunks.body.chunks).toHaveLength(2);
      expect(chunks.body.total).toBeGreaterThan(2);
      expect(chunks.body.limit).toBe(2);
      expect(chunks.body.offset).toBe(1);
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });

  it("filters the agent catalog by documented query parameters", async () => {
    await request(app)
      .patch("/api/agents/refund_policy_lora")
      .send({ enabled: false, stage: 77 })
      .expect(200);

    const disabled = await request(app).get("/api/agents?enabled=false").expect(200);
    expect(disabled.body.agents.map((agent) => agent.id)).toContain("refund_policy_lora");
    expect(disabled.body.agents.every((agent) => agent.enabled === false)).toBe(true);

    const enabled = await request(app).get("/api/agents?enabled=true").expect(200);
    expect(enabled.body.agents.map((agent) => agent.id)).not.toContain("refund_policy_lora");

    const staged = await request(app).get("/api/agents?stage_min=77&stage_max=77").expect(200);
    expect(staged.body.agents.map((agent) => agent.id)).toEqual(["refund_policy_lora"]);

    const upload = await request(app)
      .post("/api/documents")
      .field("title", "Catalog Filter Manual")
      .field("routing_cues", "catalog-filter")
      .attach("file", Buffer.from("Catalog filter source content."), "catalog.txt")
      .expect(201);

    const documentAgents = await request(app).get("/api/agents?source_type=document").expect(200);
    expect(documentAgents.body.agents.map((agent) => agent.id)).toContain(upload.body.agent_id);

    await request(app).get("/api/agents?enabled=maybe").expect(400);
    await request(app).get("/api/agents?stage_min=soon").expect(400);
    await request(app).get("/api/agents?stage_min=9&stage_max=2").expect(400);
  });

  it("validates custom agent ids and blocks duplicate routes", async () => {
    await request(app)
      .post("/api/agents")
      .send({ id: "Bad-ID", title: "Bad", capability: "Bad", boundary: "Bad" })
      .expect(400);

    const payload = {
      id: "demo_policy",
      title: "Demo policy route",
      capability: "Handles a demo policy.",
      boundary: "Do not invent policy.",
      routing_cues: "demo, policy"
    };
    await request(app).post("/api/agents").send(payload).expect(201);
    await request(app).post("/api/agents").send(payload).expect(409);

    await request(app).post("/api/agents").send({
      id: "bounded_array_contract",
      title: "Bounded array contract",
      capability: "Proves array-form contract fields are bounded.",
      boundary: "Do not accept unbounded contract lists.",
      consumes: Array.from({ length: 30 }, (_, index) => `input_${index}`),
      produces: Array.from({ length: 30 }, (_, index) => `output_${index}`),
      routing_cues: Array.from({ length: 30 }, (_, index) => `cue_${index}`),
      tools: Array.from({ length: 30 }, (_, index) => `tool_${index}`)
    }).expect(201);
    const bounded = await request(app).get("/api/agents/bounded_array_contract").expect(200);
    for (const field of ["consumes", "produces", "routing_cues", "tools"]) {
      expect(bounded.body[field]).toHaveLength(20);
    }
  });

  it("persists per-session agent activation without changing the global agent", async () => {
    const first = await createSession("Focused route");
    const second = await createSession("Independent route");

    const disabled = await request(app)
      .patch(`/api/chat/sessions/${first.session_id}/agents/legal_privacy_lora`)
      .send({ active: false })
      .expect(200);
    expect(disabled.body).toMatchObject({
      session_id: first.session_id,
      agent_id: "legal_privacy_lora",
      active: false
    });

    const firstAgents = await request(app).get(`/api/agents?session_id=${first.session_id}`).expect(200);
    const secondAgents = await request(app).get(`/api/agents?session_id=${second.session_id}`).expect(200);
    expect(firstAgents.body.agents.find((agent) => agent.id === "legal_privacy_lora").session_active).toBe(false);
    expect(secondAgents.body.agents.find((agent) => agent.id === "legal_privacy_lora").session_active).toBe(true);

    const firstSession = await request(app).get(`/api/chat/sessions/${first.session_id}`).expect(200);
    expect(firstSession.body.inactive_agent_ids).toContain("legal_privacy_lora");

    const queued = await request(app)
      .post(`/api/chat/sessions/${first.session_id}/messages`)
      .send({ content: "Review this consent notice for privacy and legal compliance." })
      .expect(202);
    const run = await waitForRun(queued.body.run_id);
    expect(run.status).toBe("completed");
    expect(run.plan.steps.map((step) => step.adapter)).not.toContain("legal_privacy_lora");

    const reenabled = await request(app)
      .patch(`/api/chat/sessions/${first.session_id}/agents/legal_privacy_lora`)
      .send({ active: true })
      .expect(200);
    expect(reenabled.body.active).toBe(true);
    expect(reenabled.body.inactive_agent_ids).not.toContain("legal_privacy_lora");
  });

  it("publishes description-only agent listings with star-only ratings", async () => {
    await request(app)
      .post("/api/agents")
      .send({
        id: "retired_model_adapter",
        title: "Retired model adapter",
        capability: "Should not be accepted.",
        boundary: "None.",
        item_type: "lora"
      })
      .expect(410);

    await request(app)
      .post("/api/agents")
      .send({
        id: "market_clinical_agent",
        title: "Clinical language agent",
        capability: "Rewrites technical clinical language for patients.",
        boundary: "Preserve clinical meaning and state uncertainty."
      })
      .expect(201);

    await request(app)
      .post("/api/marketplace/items/market_clinical_agent")
      .send({
        item_type: "agent",
        description: "A patient-safe clinical rewriting agent.",
        achievements: ["Retired field"]
      })
      .expect(400);

    await request(app)
      .post("/api/marketplace/items/market_clinical_agent")
      .send({
        item_type: "agent",
        description: "A patient-safe clinical rewriting agent."
      })
      .expect(201);

    const listed = await request(app).get("/api/marketplace?type=agent").expect(200);
    const item = listed.body.items.find((entry) => entry.id === "market_clinical_agent");
    expect(item).toMatchObject({
      item_type: "agent",
      description: "A patient-safe clinical rewriting agent.",
      published_by: expect.stringMatching(/^publisher_[a-f0-9]{32}$/),
      publisher: {
        id: expect.stringMatching(/^publisher_[a-f0-9]{32}$/),
        user_id: expect.stringMatching(/^publisher_[a-f0-9]{32}$/),
        display_name: expect.any(String),
        status: "active"
      },
      rating_count: 0,
      rating_average: 0
    });
    expect(item.publisher.id).toBe(item.published_by);
    expect(JSON.stringify(item)).not.toContain("user_local");
    expect(item.listing_id).toMatch(/^listing_/);
    for (const retiredField of ["achievements", "proofs", "version", "license", "reviews"]) {
      expect(item).not.toHaveProperty(retiredField);
    }

    const publisherSearch = await request(app)
      .get(`/api/marketplace?q=${encodeURIComponent(item.published_by)}`)
      .expect(200);
    expect(publisherSearch.body.items.some((entry) => entry.id === "market_clinical_agent")).toBe(true);

    const detail = await request(app)
      .get("/api/marketplace/items/market_clinical_agent")
      .expect(200);
    expect(detail.body.agent).toMatchObject({
      schema_version: "virenis-marketplace-agent-v1",
      title: "Clinical language agent",
      capability: "Rewrites technical clinical language for patients.",
      boundary: "Preserve clinical meaning and state uncertainty."
    });

    await request(app)
      .post("/api/marketplace/items/market_clinical_agent/ratings")
      .send({ score: 4, review: "Strong terminology preservation." })
      .expect(400);

    await request(app)
      .post("/api/marketplace/items/market_clinical_agent/ratings")
      .send({ score: 4 })
      .expect(403);

    const previousTokens = process.env.APP_API_TOKENS_JSON;
    process.env.APP_API_TOKENS_JSON = JSON.stringify({
      market_rater: { user_id: "independent_rater", workspace_id: "workspace_rater", role: "user" },
      market_rater_other: { user_id: "independent_rater", workspace_id: "workspace_rater_other", role: "user" }
    });
    try {
      const firstRating = await request(app)
        .post("/api/marketplace/items/market_clinical_agent/ratings")
        .set("Authorization", "Bearer market_rater")
        .send({ score: 4 })
        .expect(201);
      expect(firstRating.body).toMatchObject({ rating_average: 4, rating_count: 1 });

      const crossWorkspaceRating = await request(app)
        .post("/api/marketplace/items/market_clinical_agent/ratings")
        .set("Authorization", "Bearer market_rater_other")
        .send({ score: 2 })
        .expect(200);
      expect(crossWorkspaceRating.body).toMatchObject({
        rating_average: 2,
        rating_count: 1,
        my_rating: { score: 2 }
      });

      const originalWorkspaceView = await request(app)
        .get("/api/marketplace/items/market_clinical_agent")
        .set("Authorization", "Bearer market_rater")
        .expect(200);
      expect(originalWorkspaceView.body).toMatchObject({
        rating_average: 2,
        rating_count: 1,
        my_rating: { score: 2 }
      });
      expect(app.locals.store.read().marketplaceRatings.filter((rating) => (
        rating.listing_id === item.listing_id
        && rating.created_by === "independent_rater"
      ))).toHaveLength(1);

      const updatedRating = await request(app)
        .post("/api/marketplace/items/market_clinical_agent/ratings")
        .set("Authorization", "Bearer market_rater")
        .send({ score: 5 })
        .expect(200);
      expect(updatedRating.body).toMatchObject({ rating_average: 5, rating_count: 1 });
      expect(updatedRating.body.my_rating).toEqual({ score: 5 });
      expect(updatedRating.body).not.toHaveProperty("reviews");

      await request(app)
        .post("/api/marketplace/items/market_clinical_agent/ratings")
        .set("Authorization", "Bearer market_rater")
        .send({ score: 6 })
        .expect(400);
    } finally {
      if (previousTokens === undefined) delete process.env.APP_API_TOKENS_JSON;
      else process.env.APP_API_TOKENS_JSON = previousTokens;
    }

    await request(app)
      .patch("/api/agents/market_clinical_agent")
      .send({
        capability: "Rewrites clinical language and now drafts follow-up questions.",
        boundary: "Preserve clinical meaning, state uncertainty, and separate follow-up questions."
      })
      .expect(200);

    const edited = await request(app)
      .post("/api/marketplace/items/market_clinical_agent")
      .send({ description: "An edited description for patient-safe clinical rewriting." })
      .expect(200);
    expect(edited.body).toMatchObject({
      listing_id: item.listing_id,
      description: "An edited description for patient-safe clinical rewriting.",
      rating_average: 5,
      rating_count: 1
    });

    const frozenDetail = await request(app)
      .get("/api/marketplace/items/market_clinical_agent")
      .expect(200);
    expect(frozenDetail.body.agent).toMatchObject({
      capability: "Rewrites technical clinical language for patients.",
      boundary: "Preserve clinical meaning and state uncertainty."
    });

    await request(app)
      .post("/api/marketplace/items/market_clinical_agent")
      .send({ description: "Invalid revision flag.", new_revision: "yes" })
      .expect(400);

    const revised = await request(app)
      .post("/api/marketplace/items/market_clinical_agent")
      .send({
        description: "Clinical rewriting with bounded follow-up questions.",
        new_revision: true
      })
      .expect(200);
    expect(revised.body.listing_id).not.toBe(item.listing_id);
    expect(revised.body).toMatchObject({ rating_average: 0, rating_count: 0 });
    expect(app.locals.store.read().marketplaceRatings
      .some((rating) => rating.listing_id === item.listing_id)).toBe(false);

    const revisedDetail = await request(app)
      .get("/api/marketplace/items/market_clinical_agent")
      .expect(200);
    expect(revisedDetail.body.agent).toMatchObject({
      capability: "Rewrites clinical language and now drafts follow-up questions.",
      boundary: "Preserve clinical meaning, state uncertainty, and separate follow-up questions."
    });

    await request(app)
      .delete("/api/marketplace/items/market_clinical_agent")
      .expect(200);
    await request(app)
      .get("/api/marketplace/items/market_clinical_agent")
      .expect(404);
    const afterUnpublish = await request(app).get("/api/marketplace").expect(200);
    expect(afterUnpublish.body.items.some((entry) => entry.id === "market_clinical_agent")).toBe(false);

    const republished = await request(app)
      .post("/api/marketplace/items/market_clinical_agent")
      .send({ description: "Republished clinical rewriting agent." })
      .expect(201);
    expect(republished.body.listing_id).not.toBe(revised.body.listing_id);
    expect(republished.body).toMatchObject({ rating_average: 0, rating_count: 0 });
    await request(app)
      .delete("/api/marketplace/items/market_clinical_agent")
      .expect(200);

    const marketplaceEvents = app.locals.store.read().agentEvents
      .filter((event) => event.agent_id === "market_clinical_agent")
      .map((event) => event.event_type);
    expect(marketplaceEvents).toContain("agent.marketplace_description_updated");
    expect(marketplaceEvents).toContain("agent.marketplace_revision_published");
    expect(marketplaceEvents).toContain("agent.marketplace_unpublished");
  });

  it("copies a published agent into an isolated user workspace with listing provenance", async () => {
    const previousTokens = process.env.APP_API_TOKENS_JSON;
    process.env.APP_API_TOKENS_JSON = JSON.stringify({
      market_alice: { user_id: "alice", workspace_id: "workspace_a", role: "user" },
      market_bob: { user_id: "bob", workspace_id: "workspace_b", role: "user" },
      market_charlie: { user_id: "charlie", workspace_id: "workspace_b", role: "user" },
      market_other_alice: { user_id: "alice", workspace_id: "workspace_c", role: "user" }
    });

    try {
      await request(app)
        .post("/api/agents")
        .set("Authorization", "Bearer market_alice")
        .send({
          id: "alice_shared_research_agent",
          title: "Research briefing agent",
          capability: "Turns broad questions into clear research briefs.",
          boundary: "Separate verified facts from open questions.",
          consumes: ["user_request", "document_context", "agent:alice_private_helper:output"],
          produces: ["research_brief"],
          routing_cues: ["research brief", "background summary"],
          tools: ["web_search", "document_search", "document_read"],
          resources: ["agent:alice_private_helper"],
          source_text: "Alice-only terminology and private operating notes."
        })
        .expect(201);

      const publication = await request(app)
        .post("/api/marketplace/items/alice_shared_research_agent")
        .set("Authorization", "Bearer market_alice")
        .send({ description: "A reusable agent for producing clear research briefs." })
        .expect(201);
      expect(publication.body.publisher).toMatchObject({
        id: expect.stringMatching(/^publisher_[a-f0-9]{32}$/),
        user_id: expect.stringMatching(/^publisher_[a-f0-9]{32}$/),
        display_name: expect.any(String),
        status: "active"
      });
      expect(publication.body.publisher.id).toBe(publication.body.publisher.user_id);
      expect(JSON.stringify(publication.body.publisher)).not.toContain("alice");
      const publicPublisherId = publication.body.publisher.id;
      expect(publication.body).toMatchObject({
        can_manage: true,
        is_self_published: true,
        my_rating: null
      });

      await request(app)
        .post("/api/marketplace/items/alice_shared_research_agent/ratings")
        .set("Authorization", "Bearer market_alice")
        .send({ score: 5 })
        .expect(403);

      const sameUserDifferentWorkspace = await request(app)
        .get("/api/marketplace/items/alice_shared_research_agent")
        .set("Authorization", "Bearer market_other_alice")
        .expect(200);
      expect(sameUserDifferentWorkspace.body.is_self_published).toBe(true);
      await request(app)
        .post("/api/marketplace/items/alice_shared_research_agent/ratings")
        .set("Authorization", "Bearer market_other_alice")
        .send({ score: 3 })
        .expect(403);

      // A legacy self-rating recorded before user identity was enforced must
      // not influence the public score, even when it came from another workspace.
      await app.locals.store.mutate((data) => {
        data.marketplaceRatings.push({
          rating_id: "rating_legacy_cross_workspace_self",
          listing_id: publication.body.listing_id,
          agent_id: "alice_shared_research_agent",
          score: 3,
          workspace_id: "workspace_c",
          created_by: "alice",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        });
      });

      const bobListing = await request(app)
        .get("/api/marketplace/items/alice_shared_research_agent")
        .set("Authorization", "Bearer market_bob")
        .expect(200);
      expect(bobListing.body).toMatchObject({
        published_by: publicPublisherId,
        workspace_copy: null,
        can_copy: true,
        can_manage: false,
        is_self_published: false
      });
      expect(bobListing.body).toMatchObject({ rating_average: 0, rating_count: 0 });
      expect(bobListing.body.agent.exclusions).toEqual({
        private_knowledge: true,
        agent_connections: true
      });
      expect(bobListing.body.agent.consumes).toEqual(["user_request"]);
      expect(bobListing.body.agent.tools).toEqual(["web_search"]);
      expect(bobListing.body.agent).not.toHaveProperty("sources");
      expect(bobListing.body.agent).not.toHaveProperty("resources");
      expect(JSON.stringify(bobListing.body)).not.toContain("Alice-only terminology");

      const bobRating = await request(app)
        .post("/api/marketplace/items/alice_shared_research_agent/ratings")
        .set("Authorization", "Bearer market_bob")
        .send({ score: 4 })
        .expect(201);
      expect(bobRating.body).toMatchObject({ rating_average: 4, rating_count: 1 });

      const copied = await request(app)
        .post("/api/marketplace/items/alice_shared_research_agent/copy")
        .set("Authorization", "Bearer market_bob")
        .set("Idempotency-Key", "marketplace-agent-copy-0001")
        .send({ listing_id: bobListing.body.listing_id })
        .expect(201);
      expect(copied.body).toMatchObject({
        ok: true,
        status: "copied",
        listing_id: publication.body.listing_id,
        source_agent_id: "alice_shared_research_agent",
        agent: {
          workspace_id: "workspace_b",
          visibility: "private",
          created_by: "bob",
          title: "Research briefing agent",
          resources: [],
          sources: [],
          tools: ["web_search"],
          marketplace_origin: {
            listing_id: publication.body.listing_id,
            source_agent_id: "alice_shared_research_agent",
            publisher_id: publicPublisherId,
            publisher_display_name: expect.any(String)
          }
        }
      });
      expect(copied.body.agent.marketplace_origin).not.toHaveProperty("publisher_user_id");
      expect(copied.body.duplicate).toBe(false);
      expect(copied.body.agent).not.toHaveProperty("marketplace_copy_idempotency");
      const copiedAgentId = copied.body.agent.id;
      expect(copiedAgentId).not.toBe("alice_shared_research_agent");

      const replayed = await request(app)
        .post("/api/marketplace/items/alice_shared_research_agent/copy")
        .set("Authorization", "Bearer market_bob")
        .set("Idempotency-Key", "marketplace-agent-copy-0001")
        .send({ listing_id: bobListing.body.listing_id })
        .expect(200);
      expect(replayed.body).toMatchObject({
        duplicate: true,
        agent: { id: copiedAgentId }
      });
      await request(app)
        .post("/api/marketplace/items/alice_shared_research_agent/copy")
        .set("Authorization", "Bearer market_bob")
        .send({ listing_id: bobListing.body.listing_id })
        .expect(400)
        .expect((response) => expect(response.body.error).toBe("idempotency_key_required"));
      await request(app)
        .post("/api/marketplace/items/alice_shared_research_agent/copy")
        .set("Authorization", "Bearer market_bob")
        .set("Idempotency-Key", "marketplace-agent-stale-0001")
        .send({ listing_id: "listing_stale_revision" })
        .expect(409)
        .expect((response) => expect(response.body.error).toBe("marketplace_listing_changed"));
      const otherTenantUserCopy = await request(app)
        .post("/api/marketplace/items/alice_shared_research_agent/copy")
        .set("Authorization", "Bearer market_charlie")
        .set("Idempotency-Key", "marketplace-agent-copy-0001")
        .send({ listing_id: bobListing.body.listing_id })
        .expect(201);
      expect(otherTenantUserCopy.body.agent.created_by).toBe("charlie");
      expect(otherTenantUserCopy.body.agent.id).not.toBe(copiedAgentId);

      const bobAgents = await request(app)
        .get("/api/agents")
        .set("Authorization", "Bearer market_bob")
        .expect(200);
      expect(bobAgents.body.agents.some((agent) => agent.id === copiedAgentId)).toBe(true);

      const aliceAgents = await request(app)
        .get("/api/agents")
        .set("Authorization", "Bearer market_alice")
        .expect(200);
      expect(aliceAgents.body.agents.some((agent) => agent.id === copiedAgentId)).toBe(false);

      await request(app)
        .patch(`/api/agents/${copiedAgentId}`)
        .set("Authorization", "Bearer market_alice")
        .send({ title: "Alice cannot edit this copy" })
        .expect(404);
      await request(app)
        .patch(`/api/agents/${copiedAgentId}`)
        .set("Authorization", "Bearer market_bob")
        .send({ title: "Bob's independent research agent" })
        .expect(200);

      const refreshed = await request(app)
        .get("/api/marketplace")
        .set("Authorization", "Bearer market_bob")
        .expect(200);
      expect(refreshed.body.items.find((item) => item.id === "alice_shared_research_agent").workspace_copy).toEqual({
        agent_id: copiedAgentId,
        title: "Bob's independent research agent"
      });

      await request(app)
        .post("/api/marketplace/items/alice_shared_research_agent")
        .set("Authorization", "Bearer market_bob")
        .send({ description: "Bob cannot replace Alice's description." })
        .expect(404);
      await request(app)
        .delete("/api/marketplace/items/alice_shared_research_agent")
        .set("Authorization", "Bearer market_bob")
        .expect(404);

      const editedListing = await request(app)
        .post("/api/marketplace/items/alice_shared_research_agent")
        .set("Authorization", "Bearer market_alice")
        .send({ description: "Alice's updated description for clear research briefs." })
        .expect(200);
      expect(editedListing.body.description).toBe("Alice's updated description for clear research briefs.");
      expect(editedListing.body).toMatchObject({ can_manage: true, is_self_published: true });

      const updatedForBob = await request(app)
        .get("/api/marketplace/items/alice_shared_research_agent")
        .set("Authorization", "Bearer market_bob")
        .expect(200);
      expect(updatedForBob.body).toMatchObject({
        description: "Alice's updated description for clear research briefs.",
        rating_average: 4,
        rating_count: 1
      });

      await request(app)
        .delete("/api/marketplace/items/alice_shared_research_agent")
        .set("Authorization", "Bearer market_alice")
        .expect(200);
      await request(app)
        .get("/api/marketplace/items/alice_shared_research_agent")
        .set("Authorization", "Bearer market_bob")
        .expect(404);
      const sourceStillExists = await request(app)
        .get("/api/agents/alice_shared_research_agent")
        .set("Authorization", "Bearer market_alice")
        .expect(200);
      expect(sourceStillExists.body.enabled).toBe(true);
      const events = app.locals.store.read().agentEvents
        .filter((event) => event.agent_id === "alice_shared_research_agent")
        .map((event) => event.event_type);
      expect(events).toContain("agent.marketplace_description_updated");
      expect(events).toContain("agent.marketplace_unpublished");
    } finally {
      if (previousTokens === undefined) delete process.env.APP_API_TOKENS_JSON;
      else process.env.APP_API_TOKENS_JSON = previousTokens;
    }
  });

  it("permanently deletes only owned archived agents and preserves their audit history", async () => {
    const previousTokens = process.env.APP_API_TOKENS_JSON;
    process.env.APP_API_TOKENS_JSON = JSON.stringify({
      delete_alice: { user_id: "alice", workspace_id: "workspace_delete", role: "user" },
      delete_bob: { user_id: "bob", workspace_id: "workspace_delete", role: "user" }
    });

    try {
      await request(app)
        .post("/api/agents")
        .set("Authorization", "Bearer delete_alice")
        .send({
          id: "alice_archived_delete_agent",
          title: "Archived delete agent",
          capability: "Tests permanent archived-agent deletion.",
          boundary: "Use only test input."
        })
        .expect(201);
      await request(app)
        .post("/api/agents")
        .set("Authorization", "Bearer delete_alice")
        .send({
          id: "alice_active_dependent_agent",
          title: "Active dependent agent",
          capability: "Consumes the source agent's output.",
          boundary: "Use only test input.",
          consumes: ["user_request", "agent:alice_archived_delete_agent:output"]
        })
        .expect(201);

      const publication = await request(app)
        .post("/api/marketplace/items/alice_archived_delete_agent")
        .set("Authorization", "Bearer delete_alice")
        .send({ description: "A listing that should be removed with its archived source." })
        .expect(201);
      await request(app)
        .post("/api/marketplace/items/alice_archived_delete_agent/ratings")
        .set("Authorization", "Bearer delete_bob")
        .send({ score: 4 })
        .expect(201);

      await request(app)
        .delete("/api/agents/alice_archived_delete_agent/permanent")
        .set("Authorization", "Bearer delete_alice")
        .expect(409);
      await request(app)
        .delete("/api/agents/alice_archived_delete_agent")
        .set("Authorization", "Bearer delete_alice")
        .expect(200);
      await request(app)
        .delete("/api/agents/alice_archived_delete_agent/permanent")
        .set("Authorization", "Bearer delete_bob")
        .expect(404);
      await request(app)
        .delete("/api/agents/alice_archived_delete_agent/permanent")
        .set("Authorization", "Bearer delete_alice")
        .expect(409);

      await request(app)
        .patch("/api/agents/alice_active_dependent_agent")
        .set("Authorization", "Bearer delete_alice")
        .send({ consumes: ["user_request"] })
        .expect(200);
      const deleted = await request(app)
        .delete("/api/agents/alice_archived_delete_agent/permanent")
        .set("Authorization", "Bearer delete_alice")
        .expect(200);
      expect(deleted.body).toMatchObject({
        ok: true,
        status: "deleted",
        id: "alice_archived_delete_agent"
      });

      await request(app)
        .get("/api/agents/alice_archived_delete_agent")
        .set("Authorization", "Bearer delete_alice")
        .expect(404);
      const stored = app.locals.store.read();
      expect(stored.agents.some((agent) => agent.id === "alice_archived_delete_agent")).toBe(false);
      expect(stored.marketplaceRatings.some((rating) =>
        rating.agent_id === "alice_archived_delete_agent"
        || rating.listing_id === publication.body.listing_id
      )).toBe(false);
      const events = stored.agentEvents.filter((event) => event.agent_id === "alice_archived_delete_agent");
      expect(events.at(-1).event_type).toBe("agent.deleted");
      expect(events.at(-1).actor_id).toBe("alice");
      expect(events.at(-1).details).toMatchObject({
        listing_id: publication.body.listing_id,
        was_published: "true"
      });
    } finally {
      if (previousTokens === undefined) delete process.env.APP_API_TOKENS_JSON;
      else process.env.APP_API_TOKENS_JSON = previousTokens;
    }
  });

  it("migrates legacy marketplace fields without carrying reviews into the new listing contract", async () => {
    await app.locals.store.mutate((data) => {
      data.agents.push({
        id: "legacy_marketplace_agent",
        title: "Legacy marketplace agent",
        capability: "Provides a useful shared workflow.",
        boundary: "State limitations.",
        enabled: true,
        visibility: "global",
        created_by: "legacy_publisher",
        marketplace: {
          published: true,
          summary: "Legacy description",
          achievements: ["Old achievement"],
          proofs: [{ title: "Old proof", url: "https://example.com" }],
          version: "2.0",
          license: "Old license",
          published_at: "2026-01-01T00:00:00.000Z"
        }
      });
      data.marketplaceRatings.push({
        rating_id: "legacy_rating",
        agent_id: "legacy_marketplace_agent",
        score: 2,
        review: "This text must not survive migration.",
        workspace_id: "workspace_default",
        created_by: "user_local",
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z"
      });
      data.marketplaceRatings.push({
        rating_id: "legacy_rating_latest_a",
        agent_id: "legacy_marketplace_agent",
        score: 3,
        workspace_id: "workspace_other_a",
        created_by: "user_local",
        created_at: "2026-01-02T00:00:00.000Z",
        updated_at: "2026-01-03T00:00:00.000Z"
      });
      data.marketplaceRatings.push({
        rating_id: "legacy_rating_latest_z",
        agent_id: "legacy_marketplace_agent",
        score: 4,
        comment: "This duplicate comment must also be removed.",
        workspace_id: "workspace_other_z",
        created_by: "user_local",
        created_at: "2026-01-02T00:00:00.000Z",
        updated_at: "2026-01-03T00:00:00.000Z"
      });
      data.marketplaceRatings.push({
        rating_id: "legacy_self_rating",
        agent_id: "legacy_marketplace_agent",
        score: 5,
        workspace_id: "workspace_legacy",
        created_by: "legacy_publisher"
      });
    });
    await app.locals.store.close();
    app = await createApp({
      dbPath: path.join(tmpDir, "db.json"),
      uploadRoot: tmpDir
    });

    const stored = app.locals.store.read((data) => ({
      agent: data.agents.find((agent) => agent.id === "legacy_marketplace_agent"),
      ratings: data.marketplaceRatings.filter((rating) => rating.agent_id === "legacy_marketplace_agent"),
      selfRating: data.marketplaceRatings.find((rating) => rating.rating_id === "legacy_self_rating")
    }));
    expect(stored.agent.marketplace).toMatchObject({
      description: "Legacy description",
      published_by: "legacy_publisher"
    });
    expect(stored.agent.marketplace.listing_id).toMatch(/^listing_/);
    for (const retiredField of ["summary", "achievements", "proofs", "version", "license"]) {
      expect(stored.agent.marketplace).not.toHaveProperty(retiredField);
    }
    expect(stored.ratings).toHaveLength(1);
    expect(stored.ratings[0]).toMatchObject({
      rating_id: "legacy_rating_latest_z",
      score: 4,
      created_by: "user_local",
      listing_id: stored.agent.marketplace.listing_id
    });
    expect(stored.ratings[0]).not.toHaveProperty("comment");
    expect(stored.selfRating).toBeUndefined();

    const listing = await request(app)
      .get("/api/marketplace/items/legacy_marketplace_agent")
      .expect(200);
    expect(listing.body).toMatchObject({
      description: "Legacy description",
      published_by: expect.stringMatching(/^publisher_[a-f0-9]{32}$/),
      rating_average: 4,
      rating_count: 1,
      my_rating: { score: 4 }
    });
    expect(listing.body.published_by).toBe(stored.agent.marketplace.publisher_id);
    expect(JSON.stringify(listing.body)).not.toContain("legacy_publisher");
    expect(JSON.stringify(listing.body)).not.toContain("This text must not survive migration.");
  });

  it("proxies real-mode agent detail, edits, and archive to the GPU runtime", async () => {
    const previousMode = process.env.TCAR_ENGINE_MODE;
    const previousUrl = process.env.TCAR_RUNTIME_API_URL;
    const previousKey = process.env.TCAR_RUNTIME_API_KEY;
    const previousFetch = globalThis.fetch;
    const calls = [];
    const realTmp = await fs.mkdtemp(path.join(os.tmpdir(), "tcar-chat-real-"));
    const jsonResponse = (payload, status = 200) =>
      new Response(JSON.stringify(payload), {
        status,
        headers: { "Content-Type": "application/json" }
      });

    process.env.TCAR_ENGINE_MODE = "real";
    process.env.TCAR_RUNTIME_API_URL = "http://gpu-runtime.internal:9000";
    process.env.TCAR_RUNTIME_API_KEY = "test-runtime-secret";
    globalThis.fetch = async (url, options = {}) => {
      const method = options.method || "GET";
      const pathName = new URL(url).pathname;
      calls.push({ method, pathName, headers: options.headers || {}, body: options.body });
      expect(options.headers["X-TCAR-API-Key"]).toBe("test-runtime-secret");
      if (pathName === "/agents" && method === "POST") {
        return jsonResponse({
          ok: true,
          status: "unchanged",
          id: "legal_privacy_lora",
          result: { status: "unchanged", id: "legal_privacy_lora" }
        });
      }
      if (pathName === "/agents/legal_privacy_lora" && method === "GET") {
        return jsonResponse({
          ok: true,
          agent: {
            id: "legal_privacy_lora",
            title: "Legal privacy",
            capability: "Reviews consent and privacy.",
            boundary: "No legal advice.",
            tools: [],
            sources: [],
            policies: { activation_policy: "Runtime-owned activation policy." },
            enabled: true,
            mounted: true
          }
        });
      }
      if (pathName === "/agents/legal_privacy_lora" && method === "PATCH") {
        const patch = JSON.parse(options.body);
        return jsonResponse({
          ok: true,
          status: "updated",
          agent: {
            id: "legal_privacy_lora",
            title: "Legal privacy",
            capability: "Reviews consent and privacy.",
            boundary: patch.boundary,
            routing_cues: patch.routing_cues,
            tools: [],
            sources: [],
            policies: { activation_policy: "Runtime-owned activation policy." },
            enabled: true,
            mounted: true
          }
        });
      }
      if (pathName === "/agents/legal_privacy_lora" && method === "DELETE") {
        return jsonResponse({
          ok: true,
          status: "archived",
          id: "legal_privacy_lora",
          mounted: true,
          agent: {
            id: "legal_privacy_lora",
            title: "Legal privacy",
            capability: "Reviews consent and privacy.",
            boundary: "No legal advice.",
            tools: [],
            sources: [],
            enabled: false,
            mounted: true
          }
        });
      }
      return jsonResponse({ detail: "not found" }, 404);
    };

    try {
      const realApp = await createApp({
        dbPath: path.join(realTmp, "db.json"),
        uploadRoot: realTmp
      });
      await realApp.locals.store.mutate((data) => {
        const policyAgent = data.agents.find((agent) => agent.id === "legal_privacy_lora");
        policyAgent.policies = {
          response: { style: "careful", tones: ["clear"] },
          memory: { mode: "conversation" },
          knowledge: { requirements: ["user_provided_context"] },
          composition: { reusable_role: true, source_content_persisted: false }
        };
      });

      await request(realApp)
        .post("/api/agents")
        .send({
          id: "legal_privacy_lora",
          title: "Duplicate legal privacy",
          capability: "Duplicate route.",
          boundary: "Duplicate route."
        })
        .expect(409);

      const detail = await request(realApp).get("/api/agents/legal_privacy_lora").expect(200);
      expect(detail.body.runtime.ok).toBe(true);
      expect(detail.body.skill_markdown).toContain("Reviews consent and privacy.");
      expect(detail.body.policies).toMatchObject({
        activation_policy: "Runtime-owned activation policy.",
        response: { style: "careful", tones: ["clear"] },
        memory: { mode: "conversation" }
      });

      const edited = await request(realApp)
        .patch("/api/agents/legal_privacy_lora")
        .send({ boundary: "Route jurisdiction-specific legal questions to counsel.", routing_cues: "privacy, consent" })
        .expect(200);
      expect(edited.body.boundary).toContain("counsel");
      expect(edited.body.policies).toMatchObject({
        activation_policy: "Runtime-owned activation policy.",
        response: { style: "careful", tones: ["clear"] },
        memory: { mode: "conversation" }
      });

      const archived = await request(realApp).delete("/api/agents/legal_privacy_lora").expect(200);
      expect(archived.body.status).toBe("archived");
      expect(calls.map((call) => `${call.method} ${call.pathName}`)).toEqual([
        "POST /agents",
        "GET /agents/legal_privacy_lora",
        "PATCH /agents/legal_privacy_lora",
        "DELETE /agents/legal_privacy_lora"
      ]);
      for (const call of [calls[0], calls[2], calls[3]]) {
        expect(JSON.parse(call.body).audit_context).toEqual({
          user_id: "user_local",
          workspace_id: "workspace_default",
          role: "admin"
        });
      }
      expect(JSON.parse(calls[2].body).workflow_profile).toMatchObject({
        response: { style: "careful", tones: ["clear"] },
        memory: { mode: "conversation" }
      });
    } finally {
      process.env.TCAR_ENGINE_MODE = previousMode;
      process.env.TCAR_RUNTIME_API_URL = previousUrl;
      process.env.TCAR_RUNTIME_API_KEY = previousKey;
      if (previousMode === undefined) delete process.env.TCAR_ENGINE_MODE;
      if (previousUrl === undefined) delete process.env.TCAR_RUNTIME_API_URL;
      if (previousKey === undefined) delete process.env.TCAR_RUNTIME_API_KEY;
      globalThis.fetch = previousFetch;
      await fs.rm(realTmp, { recursive: true, force: true });
    }
  });

  it("rejects retired runtime mount operations without contacting the model API", async () => {
    const previous = {
      mode: process.env.TCAR_ENGINE_MODE,
      url: process.env.TCAR_RUNTIME_API_URL,
      key: process.env.TCAR_RUNTIME_API_KEY,
      tokens: process.env.APP_API_TOKENS_JSON
    };
    const previousFetch = globalThis.fetch;
    const realTmp = await fs.mkdtemp(path.join(os.tmpdir(), "tcar-chat-mount-"));
    const calls = [];
    let realApp;

    process.env.TCAR_ENGINE_MODE = "real";
    process.env.TCAR_RUNTIME_API_URL = "http://gpu-runtime.internal:9000";
    process.env.TCAR_RUNTIME_API_KEY = "test-runtime-secret";
    process.env.APP_API_TOKENS_JSON = JSON.stringify({
      token_alice: { user_id: "alice", workspace_id: "workspace_a", role: "user" },
      token_bob: { user_id: "bob", workspace_id: "workspace_a", role: "user" }
    });
    globalThis.fetch = async (url, options = {}) => {
      calls.push({ method: options.method || "GET", pathName: new URL(url).pathname });
      expect(options.headers["X-TCAR-API-Key"]).toBe("test-runtime-secret");
      return new Response(JSON.stringify({
        ok: true,
        status: "mounted",
        mounted: true,
        requires_vllm_reload: false,
        agent: {
          id: "alice_pending_lora",
          title: "Alice pending route",
          capability: "Uses Alice-approved rules.",
          boundary: "Private to Alice.",
          enabled: true,
          mounted: true,
          requires_vllm_reload: false,
          adapter_path: "/private/runtime/path"
        },
        vllm_dynamic_lora: { ok: true }
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    };

    try {
      realApp = await createApp({
        dbPath: path.join(realTmp, "db.json"),
        uploadRoot: realTmp
      });
      await realApp.locals.store.mutate((data) => {
        data.agents.push({
          id: "alice_pending_lora",
          title: "Alice pending route",
          capability: "Uses Alice-approved rules.",
          boundary: "Private to Alice.",
          workspace_id: "workspace_a",
          visibility: "private",
          created_by: "alice",
          enabled: true,
          mounted: false,
          requires_vllm_reload: true
        });
        return data.agents.length;
      });

      await request(realApp)
        .post("/api/agents/alice_pending_lora/mount")
        .set("Authorization", "Bearer token_bob")
        .send({})
        .expect(410);
      expect(calls).toHaveLength(0);

      await request(realApp)
        .post("/api/agents/alice_pending_lora/mount")
        .set("Authorization", "Bearer token_alice")
        .send({})
        .expect(410);
      expect(calls).toHaveLength(0);
    } finally {
      await realApp?.locals?.drainBackgroundTasks?.({ timeoutMs: 5000 });
      await realApp?.locals?.store?.close?.();
      globalThis.fetch = previousFetch;
      for (const [name, value] of Object.entries({
        TCAR_ENGINE_MODE: previous.mode,
        TCAR_RUNTIME_API_URL: previous.url,
        TCAR_RUNTIME_API_KEY: previous.key,
        APP_API_TOKENS_JSON: previous.tokens
      })) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      await fs.rm(realTmp, { recursive: true, force: true });
    }
  });

  it("redacts runtime agent internals from non-admin catalog readers", async () => {
    const previous = {
      APP_API_TOKENS_JSON: process.env.APP_API_TOKENS_JSON,
      TCAR_ENGINE_MODE: process.env.TCAR_ENGINE_MODE,
      TCAR_RUNTIME_API_URL: process.env.TCAR_RUNTIME_API_URL,
      TCAR_RUNTIME_API_KEY: process.env.TCAR_RUNTIME_API_KEY
    };
    const previousFetch = globalThis.fetch;
    const realTmp = await fs.mkdtemp(path.join(os.tmpdir(), "tcar-chat-agent-redaction-"));
    const tokenUser = "agent_redaction_user_token_0123456789";
    const tokenAdmin = "agent_redaction_admin_token_0123456789";
    const runtimeAgent = {
      id: "legal_privacy_lora",
      title: "Legal privacy",
      capability: "Reviews consent and privacy.",
      boundary: "No legal advice.",
      tools: [],
      sources: [],
      adapter_path: "/srv/tcar/adapters/dummy_tcar_loras/legal_privacy_lora",
      skill_path: "/srv/tcar/skills/tcar_dummy_loras/legal_privacy_lora/SKILL.md",
      enabled: true,
      mounted: true
    };
    let realApp;

    try {
      process.env.APP_API_TOKENS_JSON = JSON.stringify({
        [tokenUser]: { user_id: "alice", workspace_id: "workspace_a", role: "user" },
        [tokenAdmin]: { user_id: "ops", workspace_id: "workspace_ops", role: "admin" }
      });
      process.env.TCAR_ENGINE_MODE = "real";
      process.env.TCAR_RUNTIME_API_URL = "http://gpu-runtime.internal:9000";
      process.env.TCAR_RUNTIME_API_KEY = "test-runtime-secret";
      globalThis.fetch = async (url) => {
        const pathName = new URL(url).pathname;
        if (pathName === "/agents") {
          return new Response(
            JSON.stringify({
              ok: true,
              manifest: "/srv/tcar/configs/dummy_tcar_lora_suite.json",
              agents: [runtimeAgent]
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        if (pathName === "/agents/legal_privacy_lora") {
          return new Response(
            JSON.stringify({
              ok: true,
              manifest: "/srv/tcar/configs/dummy_tcar_lora_suite.json",
              agent: runtimeAgent
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        return new Response(JSON.stringify({ detail: "not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" }
        });
      };

      realApp = await createApp({
        dbPath: path.join(realTmp, "db.json"),
        uploadRoot: realTmp
      });

      const userList = await request(realApp)
        .get("/api/agents")
        .set("Authorization", `Bearer ${tokenUser}`)
        .expect(200);
      const userAgent = userList.body.agents.find((agent) => agent.id === "legal_privacy_lora");
      expect(userAgent).toBeTruthy();
      expect(userAgent.adapter_path).toBeUndefined();
      expect(userAgent.skill_path).toBeUndefined();
      expect(JSON.stringify(userList.body)).not.toContain("/srv/tcar");

      const userDetail = await request(realApp)
        .get("/api/agents/legal_privacy_lora")
        .set("Authorization", `Bearer ${tokenUser}`)
        .expect(200);
      expect(userDetail.body.adapter_path).toBeUndefined();
      expect(userDetail.body.skill_path).toBeUndefined();
      expect(userDetail.body.runtime).toBeUndefined();
      expect(userDetail.body.skill_markdown).toBeUndefined();
      expect(JSON.stringify(userDetail.body)).not.toContain("/srv/tcar");

      const adminDetail = await request(realApp)
        .get("/api/agents/legal_privacy_lora")
        .set("Authorization", `Bearer ${tokenAdmin}`)
        .expect(200);
      expect(adminDetail.body.adapter_path).toContain("/srv/tcar/adapters");
      expect(adminDetail.body.skill_path).toContain("/srv/tcar/skills");
      expect(adminDetail.body.runtime.manifest).toContain("dummy_tcar_lora_suite.json");
      expect(adminDetail.body.skill_markdown).toContain("Reviews consent and privacy.");
    } finally {
      await realApp?.locals?.store?.close?.();
      globalThis.fetch = previousFetch;
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
      await fs.rm(realTmp, { recursive: true, force: true });
    }
  });

  it("rejects oversized custom agent source text before runtime writes", async () => {
    const previous = {
      APP_MAX_SOURCE_TEXT_CHARS: process.env.APP_MAX_SOURCE_TEXT_CHARS,
      TCAR_ENGINE_MODE: process.env.TCAR_ENGINE_MODE
    };

    try {
      process.env.APP_MAX_SOURCE_TEXT_CHARS = "5";
      await request(app)
        .post("/api/agents")
        .send({
          id: "source_too_large",
          title: "Source too large",
          capability: "Tests source size.",
          boundary: "Stay scoped.",
          sources: "sources/router_agents/source_too_large/source.md",
          source_text: "x".repeat(6)
        })
        .expect(413);

      process.env.TCAR_ENGINE_MODE = "real";
      await request(app)
        .patch("/api/agents/legal_privacy_lora")
        .send({
          sources: "sources/router_agents/legal_privacy_lora/source.md",
          source_text: "x".repeat(6)
        })
        .expect(413);
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });

  it("scopes user-authored source text to its private agent directory", async () => {
    const previousTokens = process.env.APP_API_TOKENS_JSON;
    process.env.APP_API_TOKENS_JSON = JSON.stringify({
      private_source_user: { user_id: "source_owner", workspace_id: "workspace_sources", role: "user" },
      private_source_admin: { user_id: "source_admin", workspace_id: "workspace_sources", role: "admin" }
    });
    try {
      await request(app)
        .post("/api/agents")
        .set("Authorization", "Bearer private_source_user")
        .send({
          id: "cross_source",
          title: "Cross source",
          capability: "Must not read another agent's source.",
          boundary: "Use owned sources only.",
          sources: "sources/router_agents/refund_policy/source.md"
        })
        .expect(403);

      await request(app)
        .post("/api/agents")
        .set("Authorization", "Bearer private_source_admin")
        .send({
          id: "cross_source_admin",
          title: "Cross source admin",
          capability: "Must use document resources for shared sources.",
          boundary: "Use owned sources only.",
          sources: "sources/tcar_documents/someone_else/index.jsonl"
        })
        .expect(403);

      await request(app)
        .post("/api/agents")
        .set("Authorization", "Bearer private_source_user")
        .send({
          id: "owned_source",
          title: "Owned source",
          capability: "Uses private source text.",
          boundary: "Use owned sources only.",
          source_text: "Owner-specific operating rule."
        })
        .expect(201);
      const stored = app.locals.store.read().agents.find((agent) => agent.id === "owned_source");
      expect(stored.sources).toEqual(["sources/router_agents/owned_source/source.md"]);

      await request(app)
        .patch("/api/agents/owned_source")
        .set("Authorization", "Bearer private_source_user")
        .send({ sources: "sources/tcar_documents/someone_else/index.jsonl" })
        .expect(403);
    } finally {
      if (previousTokens === undefined) {
        delete process.env.APP_API_TOKENS_JSON;
      } else {
        process.env.APP_API_TOKENS_JSON = previousTokens;
      }
    }
  });

  it("scopes chat sessions and lets users manage only their own private agents", async () => {
    const previousTokens = process.env.APP_API_TOKENS_JSON;
    process.env.APP_API_TOKENS_JSON = JSON.stringify({
      token_a: { user_id: "alice", workspace_id: "workspace_a", role: "user" },
      token_b: { user_id: "bob", workspace_id: "workspace_b", role: "user" },
      token_admin: { user_id: "admin", workspace_id: "workspace_a", role: "admin" }
    });

    try {
      const created = await request(app)
        .post("/api/chat/sessions")
        .set("Authorization", "Bearer token_a")
        .send({ title: "Tenant A", workspace_id: "workspace_b" })
        .expect(201);

      expect(created.body.workspace_id).toBe("workspace_a");
      expect(created.body.created_by).toBe("alice");

      const visibleToA = await request(app)
        .get("/api/chat/sessions")
        .set("Authorization", "Bearer token_a")
        .expect(200);
      expect(visibleToA.body.sessions.map((session) => session.session_id)).toContain(created.body.session_id);

      const visibleToB = await request(app)
        .get("/api/chat/sessions")
        .set("Authorization", "Bearer token_b")
        .expect(200);
      expect(visibleToB.body.sessions.map((session) => session.session_id)).not.toContain(created.body.session_id);

      await request(app)
        .get(`/api/chat/sessions/${created.body.session_id}`)
        .set("Authorization", "Bearer token_b")
        .expect(404);

      const identity = await request(app)
        .get("/api/auth/me")
        .set("Authorization", "Bearer token_a")
        .expect(200);
      expect(identity.body).toMatchObject({
        user_id: "alice",
        workspace_id: "workspace_a",
        role: "user",
        is_admin: false
      });

      await request(app)
        .get("/api/admin/metrics")
        .set("Authorization", "Bearer token_a")
        .expect(403);

      const userAgent = await request(app)
        .post("/api/agents")
        .set("Authorization", "Bearer token_a")
        .send({
          id: "tenant_private_lora",
          title: "Tenant private route",
          capability: "Handles Alice's private rules.",
          boundary: "Stay within Alice's rules.",
          visibility: "global",
          workspace_id: "workspace_b"
        })
        .expect(201);
      expect(userAgent.body).toMatchObject({
        id: "tenant_private_lora",
        workspace_id: "workspace_a",
        visibility: "private",
        created_by: "alice"
      });
      expect(userAgent.body.adapter_path).toBeUndefined();

      const aliceEdit = await request(app)
        .patch("/api/agents/tenant_private_lora")
        .set("Authorization", "Bearer token_a")
        .send({ boundary: "Use only Alice-approved facts.", produces: "alice_result" })
        .expect(200);
      expect(aliceEdit.body.boundary).toBe("Use only Alice-approved facts.");
      expect(aliceEdit.body.produces).toEqual(["alice_result"]);
      expect(aliceEdit.body.adapter_path).toBeUndefined();

      await request(app)
        .patch("/api/agents/tenant_private_lora")
        .set("Authorization", "Bearer token_b")
        .send({ boundary: "Bob must not edit this." })
        .expect(404);
      await request(app)
        .delete("/api/agents/tenant_private_lora")
        .set("Authorization", "Bearer token_b")
        .expect(404);
      await request(app)
        .patch("/api/agents/legal_privacy_lora")
        .set("Authorization", "Bearer token_b")
        .send({ boundary: "Users cannot edit global agents." })
        .expect(404);

      const bobAgents = await request(app)
        .get("/api/agents")
        .set("Authorization", "Bearer token_b")
        .expect(200);
      expect(bobAgents.body.agents.map((agent) => agent.id)).not.toContain("tenant_private_lora");

      await request(app)
        .post("/api/agents")
        .set("Authorization", "Bearer token_admin")
        .send({
          id: "tenant_admin_lora",
          title: "Admin route",
          capability: "Admin route.",
          boundary: "Stay in scope.",
          routing_cues: "admin"
        })
        .expect(201);

      const bobAgentsAfterAdminCreate = await request(app)
        .get("/api/agents")
        .set("Authorization", "Bearer token_b")
        .expect(200);
      expect(bobAgentsAfterAdminCreate.body.agents.map((agent) => agent.id))
        .not.toContain("tenant_admin_lora");

      await request(app)
        .delete("/api/agents/tenant_private_lora")
        .set("Authorization", "Bearer token_a")
        .expect(200);
    } finally {
      if (previousTokens === undefined) {
        delete process.env.APP_API_TOKENS_JSON;
      } else {
        process.env.APP_API_TOKENS_JSON = previousTokens;
      }
    }
  });

  it("keeps per-agent metrics and audit events inside the requesting tenant", async () => {
    const previousTokens = process.env.APP_API_TOKENS_JSON;
    process.env.APP_API_TOKENS_JSON = JSON.stringify({
      metric_alice_token: { user_id: "alice", workspace_id: "workspace_a", role: "user" },
      metric_bob_token: { user_id: "bob", workspace_id: "workspace_b", role: "user" }
    });
    try {
      await app.locals.store.mutate((data) => {
        const template = data.agents.find((agent) => agent.id === "finance_reasoning_lora");
        const metricAgent = {
          ...template,
          id: "tenant_metric_agent",
          title: "Tenant metric agent",
          workspace_id: "workspace_a",
          visibility: "private",
          created_by: "alice",
          system_managed: false
        };
        data.agents.push(metricAgent);
        data.sessions.push(
          {
            session_id: "metric_session_alice",
            workspace_id: "workspace_a",
            created_by: "alice",
            visibility: "private"
          },
          {
            session_id: "metric_session_bob",
            workspace_id: "workspace_b",
            created_by: "bob",
            visibility: "private"
          }
        );
        data.runs.push(
          {
            run_id: "metric_run_alice",
            session_id: "metric_session_alice",
            workspace_id: "workspace_a",
            created_by: "alice"
          },
          {
            run_id: "metric_run_bob",
            session_id: "metric_session_bob",
            workspace_id: "workspace_b",
            created_by: "bob"
          }
        );
        data.runSteps.push(
          {
            step_id: "metric_step_alice",
            run_id: "metric_run_alice",
            adapter: metricAgent.id,
            elapsed_sec: 0.25,
            policy_violations: ["alice-visible"]
          },
          {
            step_id: "metric_step_bob",
            run_id: "metric_run_bob",
            adapter: metricAgent.id,
            elapsed_sec: 99,
            policy_violations: ["bob-secret-one", "bob-secret-two"]
          }
        );
        appendAgentEvent(data, {
          eventType: "agent.metric_alice",
          agent: metricAgent,
          actor: { user_id: "alice", role: "user" }
        });
        appendAgentEvent(data, {
          eventType: "agent.metric_bob",
          agent: { ...metricAgent, workspace_id: "workspace_b", created_by: "bob" },
          actor: { user_id: "bob", role: "user" }
        });
        return null;
      });

      const list = await request(app)
        .get("/api/agents")
        .set("Authorization", "Bearer metric_alice_token")
        .expect(200);
      const metricAgent = list.body.agents.find((agent) => agent.id === "tenant_metric_agent");
      expect(metricAgent).toMatchObject({
        usage_count: 1,
        average_latency: 0.25,
        policy_violation_count: 1
      });

      const events = await request(app)
        .get("/api/agents/tenant_metric_agent/events")
        .set("Authorization", "Bearer metric_alice_token")
        .expect(200);
      expect(events.body.events.map((event) => event.event_type)).toEqual(["agent.metric_alice"]);
      expect(events.body.event_chain_valid).toBe(true);
      expect(JSON.stringify({ list: metricAgent, events: events.body }))
        .not.toContain("bob-secret");
    } finally {
      if (previousTokens === undefined) delete process.env.APP_API_TOKENS_JSON;
      else process.env.APP_API_TOKENS_JSON = previousTokens;
    }
  });

  it("does not reveal or honor a foreign tenant's injected dependency during deletion", async () => {
    const previousTokens = process.env.APP_API_TOKENS_JSON;
    process.env.APP_API_TOKENS_JSON = JSON.stringify({
      delete_scope_alice: { user_id: "alice", workspace_id: "workspace_a", role: "user" },
      delete_scope_bob: { user_id: "bob", workspace_id: "workspace_b", role: "user" }
    });
    try {
      await request(app)
        .post("/api/agents")
        .set("Authorization", "Bearer delete_scope_alice")
        .send({
          id: "alice_scoped_delete_target",
          title: "Alice scoped delete target",
          capability: "Proves deletion dependency isolation.",
          boundary: "Stay in Alice's workspace."
        })
        .expect(201);
      await app.locals.store.mutate((data) => {
        const template = data.agents.find((agent) => agent.id === "finance_reasoning_lora");
        data.agents.push({
          ...template,
          id: "bob_secret_dependency",
          title: "Bob confidential dependency title",
          workspace_id: "workspace_b",
          visibility: "private",
          created_by: "bob",
          system_managed: false,
          resources: ["agent:alice_scoped_delete_target"]
        });
        return null;
      });

      await request(app)
        .delete("/api/agents/alice_scoped_delete_target")
        .set("Authorization", "Bearer delete_scope_alice")
        .expect(200);
      const deleted = await request(app)
        .delete("/api/agents/alice_scoped_delete_target/permanent")
        .set("Authorization", "Bearer delete_scope_alice")
        .expect(200);
      expect(JSON.stringify(deleted.body)).not.toContain("Bob confidential");
    } finally {
      if (previousTokens === undefined) delete process.env.APP_API_TOKENS_JSON;
      else process.env.APP_API_TOKENS_JSON = previousTokens;
    }
  });

  it("keeps private sessions and document agents visible only to their owner or an admin", async () => {
    const previousTokens = process.env.APP_API_TOKENS_JSON;
    process.env.APP_API_TOKENS_JSON = JSON.stringify({
      token_alice: { user_id: "alice", workspace_id: "workspace_shared", role: "user" },
      token_bob: { user_id: "bob", workspace_id: "workspace_shared", role: "user" },
      token_foreign: { user_id: "mallory", workspace_id: "workspace_foreign", role: "user" },
      token_admin_shared: { user_id: "admin", workspace_id: "workspace_shared", role: "admin" }
    });

    try {
      const privateSession = await request(app)
        .post("/api/chat/sessions")
        .set("Authorization", "Bearer token_alice")
        .send({ title: "Alice private" })
        .expect(201);

      const bobSessions = await request(app)
        .get("/api/chat/sessions")
        .set("Authorization", "Bearer token_bob")
        .expect(200);
      expect(bobSessions.body.sessions.map((session) => session.session_id)).not.toContain(privateSession.body.session_id);

      await request(app)
        .get(`/api/chat/sessions/${privateSession.body.session_id}`)
        .set("Authorization", "Bearer token_bob")
        .expect(404);

      await request(app)
        .get(`/api/chat/sessions/${privateSession.body.session_id}`)
        .set("Authorization", "Bearer token_admin_shared")
        .expect(200);

      const upload = await request(app)
        .post("/api/documents")
        .set("Authorization", "Bearer token_alice")
        .field("title", "Alice Private Manual")
        .field("routing_cues", "private-manual")
        .attach("file", Buffer.from("Only Alice should see this private manual."), "manual.txt")
        .expect(201);

      const bobDocuments = await request(app)
        .get("/api/documents")
        .set("Authorization", "Bearer token_bob")
        .expect(200);
      expect(bobDocuments.body.documents.map((document) => document.document_id)).not.toContain(upload.body.document_id);
      await request(app)
        .get(`/api/documents/${upload.body.document_id}/chunks`)
        .set("Authorization", "Bearer token_bob")
        .expect(404);
      await request(app)
        .get(`/api/documents/${upload.body.document_id}/chunks`)
        .set("Authorization", "Bearer token_foreign")
        .expect(404);
      await request(app)
        .get(`/api/documents/${upload.body.document_id}/chunks`)
        .set("Authorization", "Bearer token_admin_shared")
        .expect(200);

      await request(app)
        .patch(`/api/agents/${upload.body.agent_id}`)
        .set("Authorization", "Bearer token_alice")
        .send({ source_text: "Do not overwrite a document index through agent editing." })
        .expect(400);

      const bobAgents = await request(app)
        .get("/api/agents")
        .set("Authorization", "Bearer token_bob")
        .expect(200);
      expect(bobAgents.body.agents.map((agent) => agent.id)).not.toContain(upload.body.agent_id);

      const adminAgents = await request(app)
        .get("/api/agents")
        .set("Authorization", "Bearer token_admin_shared")
        .expect(200);
      expect(adminAgents.body.agents.map((agent) => agent.id)).toContain(upload.body.agent_id);

      const bobSession = await request(app)
        .post("/api/chat/sessions")
        .set("Authorization", "Bearer token_bob")
        .send({ title: "Bob asks about Alice manual" })
        .expect(201);
      const bobQueued = await request(app)
        .post(`/api/chat/sessions/${bobSession.body.session_id}/messages`)
        .set("Authorization", "Bearer token_bob")
        .send({ content: "Using the uploaded Alice Private Manual, summarize the private-manual source." })
        .expect(202);
      const bobRun = await waitForRunAs(bobQueued.body.run_id, "Bearer token_bob");
      expect(bobRun.status).toBe("completed");
      expect(bobRun.plan.steps.map((step) => step.adapter)).not.toContain(upload.body.agent_id);
      expect(JSON.stringify(bobRun)).not.toContain("Only Alice should see this private manual");
    } finally {
      if (previousTokens === undefined) {
        delete process.env.APP_API_TOKENS_JSON;
      } else {
        process.env.APP_API_TOKENS_JSON = previousTokens;
      }
    }
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

  it("routes explicit @agent references to an accessible user-created agent", async () => {
    const previousTokens = process.env.APP_API_TOKENS_JSON;
    process.env.APP_API_TOKENS_JSON = JSON.stringify({
      explicit_user_token: { user_id: "explicit_user", workspace_id: "workspace_explicit", role: "user" }
    });
    try {
      await request(app)
        .post("/api/agents")
        .set("Authorization", "Bearer explicit_user_token")
        .send({
          id: "private_numbers",
          title: "Private numbers",
          capability: "Applies the user's private number rules.",
          boundary: "Use only the configured number rules.",
          routing_cues: "unrelated-cue",
          produces: "number_result",
          source_text: "The private 2026 target is 42 units."
        })
        .expect(201);
      await app.locals.store.mutate((data) => {
        const agent = data.agents.find((item) => item.id === "private_numbers");
        agent.ready = true;
        return agent;
      });
      const session = await request(app)
        .post("/api/chat/sessions")
        .set("Authorization", "Bearer explicit_user_token")
        .send({ title: "Explicit route" })
        .expect(201);
      const queued = await request(app)
        .post(`/api/chat/sessions/${session.body.session_id}/messages`)
        .set("Authorization", "Bearer explicit_user_token")
        .send({ content: "Ask @private_numbers for the private 2026 target." })
        .expect(202);
      const run = await waitForRunAs(queued.body.run_id, "Bearer explicit_user_token");
      expect(run.status).toBe("completed");
      expect(run.plan.steps.map((step) => step.adapter)).toContain("private_numbers");
      const route = run.expert_outputs.find((step) => step.adapter === "private_numbers");
      expect(route.handoff_artifacts).toEqual([
        expect.objectContaining({
          artifact: "number_result",
          producer_agent_id: "private_numbers"
        })
      ]);
      expect(route.handoff_artifacts[0].value).toContain("42 units");
      expect(route.domain_answer).toContain("42 units");
      expect(route.citations).toEqual([
        expect.objectContaining({ chunk_id: "private_numbers_source_0001", verified: true })
      ]);
    } finally {
      if (previousTokens === undefined) {
        delete process.env.APP_API_TOKENS_JSON;
      } else {
        process.env.APP_API_TOKENS_JSON = previousTokens;
      }
    }
  });

  it("executes every Agent Studio contract field through a verified handoff", async () => {
    await request(app)
      .post("/api/agents")
      .send({
        id: "contract_source_agent",
        title: "Contract source agent",
        capability: "Returns approved catalog facts as structured context.",
        boundary: "Use only the attached catalog note.",
        consumes: ["user_request"],
        produces: ["structured_data"],
        routing_cues: ["approved catalog color"],
        source_text: "The approved catalog color is amber."
      })
      .expect(201);
    await request(app)
      .post("/api/agents")
      .send({
        id: "contract_analysis_agent",
        title: "Contract analysis agent",
        capability: "Turns verified structured upstream context into recommendations.",
        boundary: "Do not invent context that was not handed off.",
        consumes: [
          "user_request",
          "upstream_route_outputs",
          "table_context",
          "agent:contract_source_agent:output"
        ],
        produces: ["recommendations", "structured_data"],
        routing_cues: ["analyze approved catalog color"],
        tools: ["calculator", "data_table"]
      })
      .expect(201);
    await app.locals.store.mutate((data) => {
      for (const id of ["contract_source_agent", "contract_analysis_agent"]) {
        const agent = data.agents.find((item) => item.id === id);
        agent.ready = true;
        agent.mounted = true;
        agent.runtime_sync_pending = false;
      }
      return true;
    });

    const session = await createSession("Agent contract proof");
    const queued = await request(app)
      .post(`/api/chat/sessions/${session.session_id}/messages`)
      .send({ content: "Ask @contract_analysis_agent to analyze the approved catalog color." })
      .expect(202);
    const run = await waitForRun(queued.body.run_id);

    expect(run.status).toBe("completed");
    const source = run.expert_outputs.find((route) => route.adapter === "contract_source_agent");
    const analysis = run.expert_outputs.find((route) => route.adapter === "contract_analysis_agent");
    expect(source.domain_answer).toContain("amber");
    expect(source.citations).toEqual([
      expect.objectContaining({ chunk_id: "contract_source_agent_source_0001", verified: true })
    ]);
    expect(analysis.allowed_tools).toEqual(["calculator", "data_table"]);
    expect(analysis.consumption_validation).toMatchObject({
      valid: true,
      resolved_contract_inputs: [
        "agent:contract_source_agent:output",
        "table_context",
        "upstream_route_outputs"
      ]
    });
    expect(analysis.domain_answer).toContain("amber");
    expect(analysis.handoff_artifacts.map((artifact) => artifact.name)).toEqual([
      "recommendations",
      "structured_data"
    ]);
    expect(analysis.handoff_artifacts.find((artifact) => artifact.name === "structured_data")).toMatchObject({
      content_type: "application/json",
      value: { summary: expect.stringContaining("amber") }
    });
    expect(analysis.artifact_validation).toMatchObject({
      valid: true,
      produced: ["recommendations", "structured_data"]
    });
    expect(analysis.used_memory).toEqual([]);
    expect(run.token_accounting).toMatchObject({
      provider_reported: false,
      complete: false,
      missing_usage: ["local_simulator_does_not_call_a_model"]
    });
  });

  it("drains queued chat and validation background tasks", async () => {
    const session = await createSession("Drain");
    const queued = await request(app)
      .post(`/api/chat/sessions/${session.session_id}/messages`)
      .send({ content: "Plan a support analytics checklist with privacy review." })
      .expect(202);

    const validationQueued = await request(app)
      .post("/api/admin/validation/run")
      .send({ suite: "mock_smoke" })
      .expect(202);

    const drain = await app.locals.drainBackgroundTasks({ timeoutMs: 5000 });
    expect(drain.ok).toBe(true);
    expect(app.locals.backgroundTasks.size).toBe(0);

    const run = await request(app).get(`/api/chat/runs/${queued.body.run_id}`).expect(200);
    expect(run.body.status).toBe("completed");
    const validation = await waitForValidation(validationQueued.body.validation_run_id);
    expect(validation.status).toBe("completed");
    expect(validation.ok).toBe(true);
  });

  it("rejects unknown and oversized validation run inputs", async () => {
    await request(app)
      .post("/api/admin/validation/run")
      .send({ suite: "shell_command" })
      .expect(400);

    await request(app)
      .post("/api/admin/validation/run")
      .send({ suite: "mock_smoke", case_filter: "x".repeat(121) })
      .expect(413);
  });

  it("closes open run event streams on shutdown", async () => {
    const sessionId = "sess_sse_shutdown";
    const runId = "run_sse_shutdown";
    await app.locals.store.mutate((data) => {
      const now = new Date().toISOString();
      data.sessions.push({
        session_id: sessionId,
        title: "SSE close",
        workspace_id: "workspace_default",
        visibility: "private",
        created_by: "user_local",
        created_at: now,
        updated_at: now,
        last_message_at: now,
        shared_memory: []
      });
      data.runs.push({
        run_id: runId,
        session_id: sessionId,
        status: "running",
        events: [{ type: "run.started", at: now }]
      });
    });
    const server = await new Promise((resolve) => {
      const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
    });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    try {
      const stream = await fetch(`${baseUrl}/api/chat/runs/${runId}/events`);
      expect(stream.ok).toBe(true);
      expect(app.locals.eventStreams.size).toBe(1);

      const closed = app.locals.closeEventStreams({ reason: "test" });
      expect(closed.closed).toBe(1);
      expect(app.locals.eventStreams.size).toBe(0);
      const body = await stream.text();
      expect(body).toContain("event: shutdown");
    } finally {
      await new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  });

  it("redacts historical run events for non-admin SSE subscribers", async () => {
    const previousTokens = process.env.APP_API_TOKENS_JSON;
    process.env.APP_API_TOKENS_JSON = JSON.stringify({
      event_user_token: { user_id: "alice", workspace_id: "workspace_events", role: "user" },
      event_admin_token: { user_id: "ops", workspace_id: "workspace_events", role: "admin" }
    });
    const sessionId = "sess_sse_redaction";
    const runId = "run_sse_redaction";
    await app.locals.store.mutate((data) => {
      data.sessions.push({
        session_id: sessionId,
        title: "SSE redaction",
        workspace_id: "workspace_events",
        visibility: "private",
        created_by: "alice",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        last_message_at: new Date().toISOString(),
        shared_memory: []
      });
      data.runs.push({
        run_id: runId,
        session_id: sessionId,
        status: "failed",
        query: "Sensitive event",
        plan: { steps: [{ id: "s1", adapter: "writing_synthesis_lora", task: "Write safely.", depends_on: [] }] },
        parallel: { workers: 1, batches: [], maxBatchWidth: 0, parallelizable: false },
        events: [
          {
            type: "route.failed",
            step_id: "s1",
            adapter: "writing_synthesis_lora",
            status: "blocked",
            failure_class: "provider_safety_block",
            controller_synthesis_safe: false,
            citations: [{ chunk_id: "c1", title: "Chunk", path: "sources/tcar_documents/private/chunks/c1.md" }],
            raw_text_admin_only: "hidden route text super-secret-value",
            detail: "provider response super-secret-value"
          },
          {
            type: "run.failed",
            message: "super-secret-value",
            error_admin_only: { message: "super-secret-value" },
            stack: "stack with super-secret-value",
            path: "sources/tcar_documents/private/source.txt"
          }
        ],
        error: { code: "runtime_failed", message: "The run failed before completion. Try again or contact support with the run id." },
        error_admin_only: { message: "super-secret-value" }
      });
      data.runSteps.push({
        run_step_id: "run_step_sse_redaction",
        run_id: runId,
        step_id: "s1",
        adapter: "writing_synthesis_lora",
        task: "Write safely.",
        depends_on: [],
        status: "blocked",
        domain_answer: "",
        handoffs: "",
        citations: [],
        failure: {
          step_id: "s1",
          adapter: "writing_synthesis_lora",
          status: "blocked",
          failure_class: "provider_safety_block",
          controller_synthesis_safe: false,
          expected_outputs: [],
          fulfills: [],
          had_successful_tool_execution: false
        },
        raw_text_admin_only: "provider response super-secret-value",
        model_calls_admin_only: [{ provider_error: "super-secret-value" }]
      });
      return runId;
    });

    const server = await new Promise((resolve) => {
      const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
    });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    try {
      const stream = await fetch(`${baseUrl}/api/chat/runs/${runId}/events`, {
        headers: { Authorization: "Bearer event_user_token" }
      });
      expect(stream.ok).toBe(true);
      const body = await stream.text();
      expect(app.locals.eventStreams.size).toBe(0);
      expect(app.locals.bus.listenerCount(runId)).toBe(0);
      expect(body).toContain("run.failed");
      expect(body).toContain("route.failed");
      expect(body).toContain("provider_safety_block");
      expect(body).toContain("The run failed before completion");
      expect(body).not.toContain("super-secret-value");
      expect(body).not.toContain("sources/tcar_documents");
      expect(body).not.toContain("raw_text_admin_only");

      const route = await request(app)
        .get(`/api/chat/runs/${runId}/routes/s1`)
        .set("Authorization", "Bearer event_user_token")
        .expect(200);
      expect(route.body).toMatchObject({
        status: "blocked",
        domain_answer: "",
        failure: {
          status: "blocked",
          failure_class: "provider_safety_block",
          controller_synthesis_safe: false
        }
      });
      expect(route.body.raw_text_admin_only).toBeUndefined();
      expect(route.body.model_calls_admin_only).toBeUndefined();
      expect(JSON.stringify(route.body)).not.toContain("super-secret-value");
    } finally {
      if (previousTokens === undefined) {
        delete process.env.APP_API_TOKENS_JSON;
      } else {
        process.env.APP_API_TOKENS_JSON = previousTokens;
      }
      await new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
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

  it("normalizes message attachments and rejects malformed attachment payloads", async () => {
    const previous = {
      APP_MAX_MESSAGE_ATTACHMENTS: process.env.APP_MAX_MESSAGE_ATTACHMENTS,
      APP_MAX_MESSAGE_ATTACHMENT_CHARS: process.env.APP_MAX_MESSAGE_ATTACHMENT_CHARS
    };
    const session = await createSession("Attachment validation");

    try {
      process.env.APP_MAX_MESSAGE_ATTACHMENTS = "2";
      process.env.APP_MAX_MESSAGE_ATTACHMENT_CHARS = "64";
      await request(app)
        .post(`/api/chat/sessions/${session.session_id}/messages`)
        .send({
          content: "Review this referenced planning note.",
          attachments: [
            {
              type: "url",
              name: " Planning note ",
              url: "https://example.com/planning-note",
              mime_type: "text/markdown",
              size_bytes: 128,
              ignored_payload: "this should not be persisted"
            }
          ]
        })
        .expect(202);

      const sessionResult = await request(app).get(`/api/chat/sessions/${session.session_id}`).expect(200);
      const userMessage = sessionResult.body.messages.find((message) => message.role === "user");
      expect(userMessage.attachments).toEqual([
        {
          type: "url",
          name: "Planning note",
          url: "https://example.com/planning-note",
          mime_type: "text/markdown",
          size_bytes: 128
        }
      ]);
      expect(JSON.stringify(userMessage.attachments)).not.toContain("ignored_payload");

      await request(app)
        .post(`/api/chat/sessions/${session.session_id}/messages`)
        .send({ content: "Bad attachment shape.", attachments: "not-an-array" })
        .expect(400);

      await request(app)
        .post(`/api/chat/sessions/${session.session_id}/messages`)
        .send({
          content: "Too many attachments.",
          attachments: [{ name: "one" }, { name: "two" }, { name: "three" }]
        })
        .expect(413);

      await request(app)
        .post(`/api/chat/sessions/${session.session_id}/messages`)
        .send({
          content: "Unsafe URL.",
          attachments: [{ name: "bad", url: "javascript:alert(1)" }]
        })
        .expect(400);

      await request(app)
        .post(`/api/chat/sessions/${session.session_id}/messages`)
        .send({
          content: "Oversized attachment field.",
          attachments: [{ name: "oversized", summary: "x".repeat(65) }]
        })
        .expect(413);
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });

  it("rejects unsafe chat options and clamps bounded runtime knobs", async () => {
    const session = await createSession("Option guards");
    await request(app)
      .post(`/api/chat/sessions/${session.session_id}/messages`)
      .send({
        content: "Plan a support workflow.",
        options: { base_url: "https://evil.example/v1" }
      })
      .expect(400);

    await request(app)
      .post(`/api/chat/sessions/${session.session_id}/messages`)
      .send({
        content: "Plan a support workflow.",
        options: { planner_mode: "deterministic" }
      })
      .expect(400);

    const queued = await request(app)
      .post(`/api/chat/sessions/${session.session_id}/messages`)
      .send({
        content: "Plan a support workflow with privacy and customer FAQ.",
        options: {
          planner_mode: "cue",
          parallel_workers: 999,
          max_routing_adapters: 999,
          max_tokens: 999,
          refiner_max_tokens: 999,
          temperature: 99
        }
      })
      .expect(202);
    const run = await waitForRun(queued.body.run_id);
    expect(run.status).toBe("completed");
    expect(run.parallel.workers).toBe(4);

    const tcandonQueued = await request(app)
      .post(`/api/chat/sessions/${session.session_id}/messages`)
      .send({
        content: "Use the TCAndon planner for this support workflow.",
        options: { planner_mode: "tcandon" }
      })
      .expect(202);
    const tcandonRun = await waitForRun(tcandonQueued.body.run_id);
    expect(tcandonRun.status).toBe("completed");
    expect(app.locals.store.read().runs.find((item) => item.run_id === tcandonQueued.body.run_id).planner_mode).toBe("tcandon");

    const sessionQueued = await request(app)
      .post(`/api/chat/sessions/${session.session_id}/messages`)
      .send({
        content: "Let the main session model coordinate this support workflow.",
        options: { planner_mode: "session" }
      })
      .expect(202);
    const sessionRun = await waitForRun(sessionQueued.body.run_id);
    expect(sessionRun.status).toBe("completed");
    expect(app.locals.store.read().runs.find((item) => item.run_id === sessionQueued.body.run_id).planner_mode).toBe("session");
  });

  it("redacts route raw text and prompt previews for non-admin run readers", async () => {
    const previousTokens = process.env.APP_API_TOKENS_JSON;
    process.env.APP_API_TOKENS_JSON = JSON.stringify({
      token_route_user: { user_id: "route_user", workspace_id: "workspace_routes", role: "user" },
      token_route_admin: { user_id: "route_admin", workspace_id: "workspace_routes", role: "admin" }
    });

    try {
      const session = await request(app)
        .post("/api/chat/sessions")
        .set("Authorization", "Bearer token_route_user")
        .send({ title: "Route redaction" })
        .expect(201);
      const queued = await request(app)
        .post(`/api/chat/sessions/${session.body.session_id}/messages`)
        .set("Authorization", "Bearer token_route_user")
        .send({ content: "Plan a secure support workflow with privacy review." })
        .expect(202);

      const run = await waitForRunAs(queued.body.run_id, "Bearer token_route_user");
      expect(run.status).toBe("completed");
      expect(run.expert_outputs[0].raw_text_admin_only).toBeUndefined();
      expect(run.expert_outputs[0].prompt_preview_admin_only).toBeUndefined();
      expect(run.expert_outputs[0].model_calls_admin_only).toBeUndefined();
      expect(run.expert_outputs[0].agent_reasoning).toBeUndefined();

      const route = await request(app)
        .get(`/api/chat/runs/${queued.body.run_id}/routes/${run.expert_outputs[0].step_id}`)
        .set("Authorization", "Bearer token_route_user")
        .expect(200);
      expect(route.body.raw_text_admin_only).toBeUndefined();
      expect(route.body.prompt_preview_admin_only).toBeUndefined();
      expect(route.body.model_calls_admin_only).toBeUndefined();
      expect(route.body.agent_reasoning).toBeUndefined();

      const adminRoute = await request(app)
        .get(`/api/chat/runs/${queued.body.run_id}/routes/${run.expert_outputs[0].step_id}`)
        .set("Authorization", "Bearer token_route_admin")
        .expect(200);
      expect(adminRoute.body.raw_text_admin_only).toContain("AGENT_REASONING");
      expect(adminRoute.body.prompt_preview_admin_only).toContain("Adapter");
      expect(adminRoute.body.agent_reasoning).toBeTruthy();
    } finally {
      if (previousTokens === undefined) {
        delete process.env.APP_API_TOKENS_JSON;
      } else {
        process.env.APP_API_TOKENS_JSON = previousTokens;
      }
    }
  });

  it("redacts async runtime failure details from non-admin run readers", async () => {
    const previous = {
      APP_API_TOKENS_JSON: process.env.APP_API_TOKENS_JSON,
      TCAR_ENGINE_MODE: process.env.TCAR_ENGINE_MODE,
      TCAR_RUNTIME_API_URL: process.env.TCAR_RUNTIME_API_URL,
      TCAR_RUNTIME_API_KEY: process.env.TCAR_RUNTIME_API_KEY
    };
    const previousFetch = globalThis.fetch;
    const realTmp = await fs.mkdtemp(path.join(os.tmpdir(), "tcar-chat-runtime-fail-"));
    const tokenUser = "runtime_fail_user_token_0123456789";
    const tokenAdmin = "runtime_fail_admin_token_0123456789";
    let realApp;

    try {
      process.env.APP_API_TOKENS_JSON = JSON.stringify({
        [tokenUser]: { user_id: "runtime_user", workspace_id: "workspace_runtime_fail", role: "user" },
        [tokenAdmin]: { user_id: "runtime_admin", workspace_id: "workspace_runtime_fail", role: "admin" }
      });
      process.env.TCAR_ENGINE_MODE = "real";
      process.env.TCAR_RUNTIME_API_URL = "http://gpu-runtime.internal:9000";
      process.env.TCAR_RUNTIME_API_KEY = "runtime-secret-for-tests";
      globalThis.fetch = async () =>
        new Response(JSON.stringify({ detail: { stderr: "GPU traceback with database password super-secret-value" } }), {
          status: 502,
          headers: { "Content-Type": "application/json" }
        });

      realApp = await createApp({
        dbPath: path.join(realTmp, "db.json"),
        uploadRoot: realTmp
      });
      const session = await request(realApp)
        .post("/api/chat/sessions")
        .set("Authorization", `Bearer ${tokenUser}`)
        .send({ title: "Runtime failure" })
        .expect(201);
      const queued = await request(realApp)
        .post(`/api/chat/sessions/${session.body.session_id}/messages`)
        .set("Authorization", `Bearer ${tokenUser}`)
        .send({ content: "Ask the runtime to fail safely." })
        .expect(202);

      let userRun;
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const response = await request(realApp)
          .get(`/api/chat/runs/${queued.body.run_id}`)
          .set("Authorization", `Bearer ${tokenUser}`)
          .expect(200);
        if (response.body.status === "failed") {
          userRun = response.body;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(userRun).toBeTruthy();
      expect(userRun.status).toBe("failed");
      expect(userRun.error).toMatchObject({
        code: "runtime_service_error",
        message: "The model runtime could not complete the request. Contact support with the run id.",
        retryable: false,
        action: "contact_support"
      });
      expect(userRun.error_admin_only).toBeUndefined();
      expect(JSON.stringify(userRun)).not.toContain("super-secret-value");
      expect(userRun.events.find((event) => event.type === "run.failed").message).toBe(userRun.error.message);

      const adminRun = await request(realApp)
        .get(`/api/chat/runs/${queued.body.run_id}`)
        .set("Authorization", `Bearer ${tokenAdmin}`)
        .expect(200);
      expect(adminRun.body.error.message).toBe(userRun.error.message);
      expect(adminRun.body.error_admin_only).toMatchObject({
        code: "runtime_service_error",
        status: 502,
        error_type: "Error"
      });
      expect(adminRun.body.error_admin_only.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(JSON.stringify(adminRun.body.error_admin_only)).not.toContain("super-secret-value");
      expect(JSON.stringify(realApp.locals.store.read())).not.toContain("super-secret-value");
      expect(await fs.readFile(path.join(realTmp, "db.json"), "utf8")).not.toContain("super-secret-value");
    } finally {
      await realApp?.locals?.drainBackgroundTasks?.({ timeoutMs: 5000 });
      await realApp?.locals?.store?.close?.();
      globalThis.fetch = previousFetch;
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
      await fs.rm(realTmp, { recursive: true, force: true });
    }
  });

  it("keeps a synthesized real-runtime answer completed while exposing failed route truth", async () => {
    const previous = {
      APP_API_TOKENS_JSON: process.env.APP_API_TOKENS_JSON,
      TCAR_ENGINE_MODE: process.env.TCAR_ENGINE_MODE,
      TCAR_RUNTIME_API_URL: process.env.TCAR_RUNTIME_API_URL,
      TCAR_RUNTIME_API_KEY: process.env.TCAR_RUNTIME_API_KEY
    };
    const previousFetch = globalThis.fetch;
    const realTmp = await fs.mkdtemp(path.join(os.tmpdir(), "tcar-chat-route-fail-"));
    const tokenUser = "route_fail_user_token_0123456789";
    const tokenAdmin = "route_fail_admin_token_0123456789";
    let realApp;

    try {
      process.env.APP_API_TOKENS_JSON = JSON.stringify({
        [tokenUser]: { user_id: "route_user", workspace_id: "workspace_route_fail", role: "user" },
        [tokenAdmin]: { user_id: "route_admin", workspace_id: "workspace_route_fail", role: "admin" }
      });
      process.env.TCAR_ENGINE_MODE = "real";
      process.env.TCAR_RUNTIME_API_URL = "http://gpu-runtime.internal:9000";
      process.env.TCAR_RUNTIME_API_KEY = "runtime-secret-for-tests";
      globalThis.fetch = async () => new Response(JSON.stringify({
        ok: true,
        mode: "session_delegated_vllm_execute",
        baseModel: "qwen36-awq",
        manifestRevision: "1".repeat(64),
        componentProvenance: {
          revision_authority: "runtime",
          manifest_revision: "1".repeat(64),
          base_model_id: "qwen36-awq",
          base_model_content_digest: "2".repeat(64),
          session_model_id: "qwen36-awq",
          session_model_content_digest: "2".repeat(64),
          session_contract_version: "session-orchestrator-v3",
          executor_code_digest: "5".repeat(64),
          agents: [{
            adapter: "writing_synthesis_lora",
            agent_revision: "6".repeat(64),
            revision_authority: "runtime",
            manifest_contract_digest: "7".repeat(64),
            adapter_content_digest: "8".repeat(64)
          }]
        },
        executionProvenance: {
          execution_id: "runtime-route-failure-execution",
          receipt_id: "runtime-route-failure-receipt",
          record_hash: "9".repeat(64),
          schema_version: 1,
          created_at: "2026-07-19T00:00:00.000Z"
        },
        plan: {
          steps: [{
            id: "s1",
            adapter: "writing_synthesis_lora",
            task: "Prepare the requested draft.",
            depends_on: [],
            evidence_requirement: "none",
            expected_outputs: ["final_answer"],
            fulfills: ["draft"]
          }],
          adapters: ["writing_synthesis_lora"],
          edges: [],
          routing: {
            mode: "session",
            candidate_count: 1,
            candidate_adapters: ["writing_synthesis_lora"],
            selected: [{ adapter: "writing_synthesis_lora", source: "explicit" }],
            orchestrator: {
              contract_version: "session-orchestrator-v3",
              decision: "delegate",
              final_synthesis_required: true,
              outcome_contract: {
                contract_version: "session-outcome-v1",
                route_admission_contract_version: "session-route-admission-v1",
                compiler_authority: "runtime",
                status: "covered",
                deliverables: [{
                  id: "draft",
                  title: "Requested draft",
                  description: "Prepare the requested draft.",
                  required: true,
                  evidence_requirement: "none",
                  required_outputs: ["final_answer"],
                  controller_can_synthesize: false,
                  assigned_to_session_controller: false
                }],
                steps: [{
                  step_id: "s1",
                  route_admission_valid: true,
                  route_dependency_closure_valid: true,
                  route_admission: {
                    contract_version: "session-route-admission-v1",
                    valid: true,
                    route_role: "outcome_owner",
                    obligation_source: "compiled_deliverables",
                    deliverable_ids: ["draft"],
                    expected_outputs: ["final_answer"],
                    downstream_bindings: [],
                    strict_constraints_checked: [
                      "activation_policy", "boundary", "write_policy", "tool_policy",
                      "source_policy", "escalation_policy"
                    ],
                    violations: [],
                    obligation: "Prepare the requested draft."
                  }
                }]
              }
            }
          }
        },
        expertOutputs: [{
          id: "s1",
          step_id: "s1",
          adapter: "writing_synthesis_lora",
          agent_revision: "6".repeat(64),
          adapter_content_digest: "8".repeat(64),
          model_id: "qwen36-awq",
          task: "Prepare the requested draft.",
          domain_answer: "provider-secret partial worker text",
          raw_text: "provider-secret raw worker response",
          output_contract: "failed_closed",
          policy_violations: [
            "worker_execution_failed",
            "claim_not_supported_by_execution_evidence",
            "private-validator-reason"
          ],
          source_validation: {
            valid: false,
            violations: ["worker_execution_failed", "claim_not_supported_by_execution_evidence"],
            unsupported_claims: ["private rejected source claim"],
            unsupported_execution_evidence_claims: [
              "private rejected execution claim one",
              "private rejected execution claim two"
            ]
          },
          execution_evidence_repair: {
            attempted: true,
            valid: false,
            error: "PrivateProviderError",
            original_validation: { rejected_claim: "private rejected execution claim one" }
          },
          execution_evidence_sanitizer: {
            attempted: true,
            revalidation_valid: true,
            removed_claims: ["private rejected execution claim two"]
          },
          consumption_validation: { valid: true, errors: [] },
          artifact_validation: { valid: false, errors: ["worker_execution_failed"] },
          outcome_validation: { valid: false, missing_expected_outputs: ["final_answer"] },
          handoff_artifacts: [],
          citations: [],
          allowed_tools: [],
          tool_executions: [],
          model_calls: [{ finish_reason: "error", provider_error: "provider-secret" }],
          execution_mode: "executed"
        }],
        routeFailureSummary: [{
          step_id: "s1",
          adapter: "writing_synthesis_lora",
          failure_class: "worker_execution",
          controller_synthesis_safe: true,
          expected_outputs: ["final_answer"],
          fulfills: ["draft"],
          had_successful_tool_execution: false
        }],
        finalAnswer: "The specialist draft was unavailable, so I need a narrower brief before continuing."
      }), { status: 200, headers: { "Content-Type": "application/json" } });

      realApp = await createApp({
        dbPath: path.join(realTmp, "db.json"),
        uploadRoot: realTmp
      });
      const session = await request(realApp)
        .post("/api/chat/sessions")
        .set("Authorization", `Bearer ${tokenUser}`)
        .send({ title: "Route failure truth" })
        .expect(201);
      const queued = await request(realApp)
        .post(`/api/chat/sessions/${session.body.session_id}/messages`)
        .set("Authorization", `Bearer ${tokenUser}`)
        .send({ content: "Ask @writing_synthesis for a draft." })
        .expect(202);

      let run;
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const response = await request(realApp)
          .get(`/api/chat/runs/${queued.body.run_id}`)
          .set("Authorization", `Bearer ${tokenUser}`)
          .expect(200);
        if (["completed", "failed"].includes(response.body.status)) {
          run = response.body;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      expect(run.status, JSON.stringify(run.error)).toBe("completed");
      expect(run).toMatchObject({
        final_answer: "The specialist draft was unavailable, so I need a narrower brief before continuing.",
        expert_outputs: [expect.objectContaining({
          step_id: "s1",
          status: "failed",
          domain_answer: "",
          handoff_artifacts: [],
          citations: [],
          failure: expect.objectContaining({
            status: "failed",
            failure_class: "worker_execution",
            controller_synthesis_safe: true,
            expected_outputs: ["final_answer"],
            fulfills: ["draft"]
          })
        })]
      });
      expect(run.events.some((event) => event.type === "route.completed")).toBe(false);
      expect(run.events).toContainEqual(expect.objectContaining({
        type: "route.failed",
        step_id: "s1",
        status: "failed",
        failure_class: "worker_execution"
      }));
      expect(run.expert_outputs[0].failure_observability_admin_only).toBeUndefined();
      expect(JSON.stringify(run)).not.toContain("provider-secret");

      const adminRun = await request(realApp)
        .get(`/api/chat/runs/${queued.body.run_id}`)
        .set("Authorization", `Bearer ${tokenAdmin}`)
        .expect(200);
      expect(adminRun.body.expert_outputs[0].failure_observability_admin_only).toEqual({
        schema_version: "runtime-route-failure-observability-v1",
        failure_reason_codes: [
          "artifact_validation_failed",
          "claim_not_supported_by_execution_evidence",
          "outcome_validation_failed",
          "route_validation_failed",
          "source_claim_not_supported_by_cited_excerpt",
          "source_validation_failed",
          "worker_execution_failed"
        ],
        repair_attempted: true,
        repair_valid: true,
        unsupported_claim_count: 3
      });
      expect(JSON.stringify(adminRun.body.expert_outputs[0].failure_observability_admin_only))
        .not.toMatch(/private|provider-secret|PrivateProviderError/);

      const metrics = await request(realApp)
        .get("/api/admin/metrics")
        .set("Authorization", `Bearer ${tokenAdmin}`)
        .expect(200);
      expect(metrics.body).toMatchObject({
        route_repair_attempted_count: 1,
        route_repair_valid_count: 1,
        unsupported_claim_count: 3,
        route_failure_reason_counts: {
          claim_not_supported_by_execution_evidence: 1,
          worker_execution_failed: 1
        }
      });
      expect(JSON.stringify(metrics.body)).not.toMatch(/private|provider-secret|PrivateProviderError/);
      const persisted = JSON.stringify(realApp.locals.store.read());
      expect(persisted).not.toMatch(
        /private rejected source claim|private rejected execution claim|private-validator-reason|PrivateProviderError/
      );

      const dag = await request(realApp)
        .get(`/api/chat/runs/${queued.body.run_id}/dag`)
        .set("Authorization", `Bearer ${tokenUser}`)
        .expect(200);
      expect(dag.body.nodes).toContainEqual(expect.objectContaining({ id: "s1", status: "failed" }));

      const execution = await request(realApp)
        .get(`/api/executions/${run.execution.execution_id}`)
        .set("Authorization", `Bearer ${tokenUser}`)
        .expect(200);
      expect(execution.body.participants).toContainEqual(expect.objectContaining({
        step_id: "s1",
        status: "failed"
      }));
      expect(execution.body.record_hash_valid).toBe(true);
      expect(realApp.locals.store.read().worldGraphArtifacts.some((artifact) => (
        artifact.origin_run_id === queued.body.run_id && artifact.step_id === "s1"
      ))).toBe(false);
    } finally {
      await realApp?.locals?.drainBackgroundTasks?.({ timeoutMs: 5000 });
      await realApp?.locals?.store?.close?.();
      globalThis.fetch = previousFetch;
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await fs.rm(realTmp, { recursive: true, force: true });
    }
  });

  it("sends only session-visible adapters to the GPU runtime planner", async () => {
    const previous = {
      APP_API_TOKENS_JSON: process.env.APP_API_TOKENS_JSON,
      TCAR_ENGINE_MODE: process.env.TCAR_ENGINE_MODE,
      TCAR_RUNTIME_API_URL: process.env.TCAR_RUNTIME_API_URL,
      TCAR_RUNTIME_API_KEY: process.env.TCAR_RUNTIME_API_KEY
    };
    const previousFetch = globalThis.fetch;
    const realTmp = await fs.mkdtemp(path.join(os.tmpdir(), "tcar-chat-runtime-scope-"));
    const tokenBob = "runtime_scope_bob_token_0123456789";
    let realApp;
    let chatBody;

    try {
      process.env.APP_API_TOKENS_JSON = JSON.stringify({
        [tokenBob]: { user_id: "bob", workspace_id: "workspace_shared", role: "user" }
      });
      process.env.TCAR_ENGINE_MODE = "real";
      process.env.TCAR_RUNTIME_API_URL = "http://gpu-runtime.internal:9000";
      process.env.TCAR_RUNTIME_API_KEY = "runtime-secret-for-tests";
      globalThis.fetch = async (_url, options = {}) => {
        chatBody = JSON.parse(options.body);
        return new Response(
          JSON.stringify({
            ok: true,
            mode: "real",
            baseModel: "qwen36-awq",
            manifestRevision: "1".repeat(64),
            componentProvenance: {
              revision_authority: "runtime",
              manifest_revision: "1".repeat(64),
              base_model_id: "qwen36-awq",
              base_model_content_digest: "2".repeat(64),
              router_model_content_digest: "3".repeat(64),
              router_chat_template_digest: "4".repeat(64),
              executor_code_digest: "5".repeat(64),
              agents: [{
                adapter: "writing_synthesis_lora",
                agent_revision: "6".repeat(64),
                revision_authority: "runtime",
                manifest_contract_digest: "7".repeat(64),
                adapter_content_digest: "8".repeat(64)
              }]
            },
            executionProvenance: {
              execution_id: "runtime-proof-execution",
              receipt_id: "runtime-proof-receipt",
              record_hash: "9".repeat(64),
              schema_version: 1,
              created_at: "2026-07-09T00:00:00.000Z"
            },
            plan: {
              steps: [
                {
                  id: "s1",
                  adapter: "writing_synthesis_lora",
                  task: "Synthesize.",
                  depends_on: []
                }
              ],
              adapters: ["writing_synthesis_lora"],
              edges: [],
              routing: {
                mode: "tcandon",
                candidate_count: 3,
                candidate_adapters: ["writing_synthesis_lora"],
                selected: [{
                  adapter: "writing_synthesis_lora",
                  source: "tcandon",
                  confidence: 0.88,
                  reason: "Explicit synthesis request."
                }],
                explicit_adapters: ["writing_synthesis_lora"],
                unresolved_mentions: ["@alice_private_manual"],
                out_of_scope: false,
                reason: "One authorized route selected.",
                fallback: ""
              }
            },
            parallel: { workers: 1, batches: [{ batch: 1, width: 1, workers: 1, steps: ["s1"] }], maxBatchWidth: 1, parallelizable: false },
            expertOutputs: [{
              id: "s1",
              adapter: "writing_synthesis_lora",
              agent_revision: "6".repeat(64),
              revision_authority: "runtime",
              manifest_contract_digest: "7".repeat(64),
              adapter_content_digest: "8".repeat(64),
              model_id: "qwen36-awq",
              task: "Synthesize.",
              domain_answer: "Structured runtime answer.",
              approved_sources: ["sources/router_agents/writing_synthesis/source.md"],
              citations: [
                {
                  chunk_id: "runtime_chunk_1",
                  title: "Runtime source",
                  path: "sources/router_agents/writing_synthesis/source.md",
                  page_start: 3,
                  page_end: 3,
                  score: 0.9,
                  excerpt: "Validated runtime evidence.",
                  claim: "The runtime supplied evidence.",
                  verified: true
                },
                {
                  chunk_id: "unsafe_chunk",
                  path: "../../etc/passwd",
                  excerpt: "Must be rejected.",
                  verified: true
                }
              ],
              handoff_artifacts: [
                {
                  name: "final_draft",
                  content_type: "text/plain",
                  value: "Structured runtime answer.",
                  evidence: ["runtime_chunk_1"],
                  confidence: 0.9,
                  status: "model_structured",
                  verified: true
                },
                { artifact: "missing_value" }
              ]
            }],
            finalAnswer: "Scoped runtime answer."
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      };

      realApp = await createApp({
        dbPath: path.join(realTmp, "db.json"),
        uploadRoot: realTmp
      });
      await realApp.locals.store.mutate((data) => {
        data.agents.push({
          id: "alice_private_manual_lora",
          title: "Alice private manual",
          capability: "Private manual for Alice only.",
          boundary: "Private.",
          routing_cues: ["alice private manual"],
          tools: ["document_search"],
          sources: ["sources/tcar_documents/alice_private_manual/index.jsonl"],
          retrieval: { type: "document_markdown", top_k: 4 },
          document: { slug: "alice_private_manual", title: "Alice private manual" },
          workspace_id: "workspace_shared",
          visibility: "private",
          created_by: "alice",
          enabled: true
        });
        return data.agents.length;
      });

      const session = await request(realApp)
        .post("/api/chat/sessions")
        .set("Authorization", `Bearer ${tokenBob}`)
        .send({ title: "Runtime scoped adapters" })
        .expect(201);
      const queued = await request(realApp)
        .post(`/api/chat/sessions/${session.body.session_id}/messages`)
        .set("Authorization", `Bearer ${tokenBob}`)
        .send({ content: "Use @alice_private_manual if available, then preserve this mention." })
        .expect(202);

      let completedRun;
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const response = await request(realApp)
          .get(`/api/chat/runs/${queued.body.run_id}`)
          .set("Authorization", `Bearer ${tokenBob}`)
          .expect(200);
        if (response.body.status === "completed") {
          completedRun = response.body;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      expect(chatBody.options.allowed_adapters).toContain("writing_synthesis_lora");
      expect(chatBody.options.allowed_adapters).toContain("finance_reasoning_lora");
      expect(chatBody.options.allowed_adapters).not.toContain("alice_private_manual_lora");
      expect(chatBody.options.max_tokens).toBe(4096);
      expect(chatBody.options.refiner_max_tokens).toBe(8192);
      expect(chatBody.query).toBe("Use @alice_private_manual if available, then preserve this mention.");
      expect(completedRun.sources).toHaveLength(1);
      expect(completedRun.sources[0]).toMatchObject({
        chunk_id: "runtime_chunk_1",
        page_start: 3,
        page_end: 3,
        verified: true,
        claim: "The runtime supplied evidence."
      });
      expect(completedRun.expert_outputs[0].handoff_artifacts).toEqual([
        expect.objectContaining({
          name: "final_draft",
          artifact: "final_draft",
          value: "Structured runtime answer.",
          evidence: ["runtime_chunk_1"],
          confidence: 0.9,
          status: "model_structured",
          verified: true
        })
      ]);
      expect(completedRun.plan.routing).toMatchObject({
        mode: "tcandon",
        selected: [expect.objectContaining({ adapter: "writing_synthesis_lora", confidence: 0.88 })],
        unresolved_mentions: ["@alice_private_manual"],
        out_of_scope: false,
        reason: "One authorized route selected."
      });
      const execution = await request(realApp)
        .get(`/api/executions/${completedRun.execution.execution_id}`)
        .set("Authorization", `Bearer ${tokenBob}`)
        .expect(200);
      expect(execution.body).toMatchObject({
        runtime_execution_id: "runtime-proof-execution",
        base_model_digest: `sha256:${"2".repeat(64)}`,
        router_model_digest: `sha256:${"3".repeat(64)}`,
        router_chat_template_digest: `sha256:${"4".repeat(64)}`,
        executor_code_digest: `sha256:${"5".repeat(64)}`,
        participants: [expect.objectContaining({
          agent_id: "writing_synthesis_lora",
          agent_revision: `sha256:${"6".repeat(64)}`,
          adapter_digest: `sha256:${"8".repeat(64)}`,
          model_id: "qwen36-awq"
        })]
      });
      expect(execution.body.record_hash_valid).toBe(true);
    } finally {
      await realApp?.locals?.drainBackgroundTasks?.({ timeoutMs: 5000 });
      await realApp?.locals?.store?.close?.();
      globalThis.fetch = previousFetch;
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
      await fs.rm(realTmp, { recursive: true, force: true });
    }
  });

  it("falls back to the session model when every agent is off in the chat", async () => {
    const previous = {
      APP_API_TOKENS_JSON: process.env.APP_API_TOKENS_JSON,
      TCAR_ENGINE_MODE: process.env.TCAR_ENGINE_MODE,
      TCAR_RUNTIME_API_URL: process.env.TCAR_RUNTIME_API_URL,
      TCAR_RUNTIME_API_KEY: process.env.TCAR_RUNTIME_API_KEY
    };
    const previousFetch = globalThis.fetch;
    const realTmp = await fs.mkdtemp(path.join(os.tmpdir(), "tcar-chat-no-agents-"));
    const token = "runtime_no_agents_token_0123456789";
    let realApp;
    let chatBody;

    try {
      process.env.APP_API_TOKENS_JSON = JSON.stringify({
        [token]: { user_id: "alice", workspace_id: "workspace_no_agents", role: "user" }
      });
      process.env.TCAR_ENGINE_MODE = "real";
      process.env.TCAR_RUNTIME_API_URL = "http://gpu-runtime.internal:9000";
      process.env.TCAR_RUNTIME_API_KEY = "runtime-secret-for-tests";
      globalThis.fetch = async (url, options = {}) => {
        expect(String(url)).toContain("/chat/execute");
        chatBody = JSON.parse(options.body);
        return new Response(JSON.stringify({
          ok: true,
          mode: "session_direct_vllm_execute",
          baseModel: "qwen36-awq",
          manifestRevision: "1".repeat(64),
          componentProvenance: {
            revision_authority: "runtime",
            manifest_revision: "1".repeat(64),
            base_model_id: "qwen36-awq",
            base_model_content_digest: "2".repeat(64),
            session_model_id: "qwen36-awq",
            session_model_content_digest: "2".repeat(64),
            session_contract_version: "session-orchestrator-v2",
            executor_code_digest: "5".repeat(64),
            agents: []
          },
          executionProvenance: {
            execution_id: "runtime-no-agents-execution",
            receipt_id: "runtime-no-agents-receipt",
            record_hash: "9".repeat(64),
            schema_version: 1,
            created_at: "2026-07-14T00:00:00.000Z"
          },
          plan: {
            steps: [],
            adapters: [],
            edges: [],
            routing: {
              mode: "session",
              candidate_count: 0,
              candidate_adapters: [],
              selected: [],
              explicit_adapters: [],
              unresolved_mentions: [],
              out_of_scope: true,
              reason: "No enabled specialist is available.",
              fallback: "session_model",
              orchestrator: {
                contract_version: "session-orchestrator-v2",
                decision: "direct",
                authorized_agent_count: 0,
                discovered_candidate_count: 0,
                planning_call_performed: false,
                final_synthesis_required: true
              }
            }
          },
          parallel: { workers: 1, batches: [], maxBatchWidth: 0, parallelizable: false },
          expertOutputs: [],
          finalAnswer: "Leaves look green because chlorophyll absorbs mostly red and blue light while reflecting green light."
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      };

      realApp = await createApp({
        dbPath: path.join(realTmp, "db.json"),
        uploadRoot: realTmp
      });
      const session = await request(realApp)
        .post("/api/chat/sessions")
        .set("Authorization", `Bearer ${token}`)
        .send({ title: "No agents" })
        .expect(201);
      const activeAgents = realApp.locals.store.read((data) => data.agents.filter((agent) => agent.enabled !== false));
      expect(activeAgents.length).toBeGreaterThan(0);
      for (const agent of activeAgents) {
        await request(realApp)
          .patch(`/api/chat/sessions/${session.body.session_id}/agents/${agent.id}`)
          .set("Authorization", `Bearer ${token}`)
          .send({ active: false })
          .expect(200);
      }

      const queued = await request(realApp)
        .post(`/api/chat/sessions/${session.body.session_id}/messages`)
        .set("Authorization", `Bearer ${token}`)
        .send({ content: "Why are leaves green?" })
        .expect(202);
      let run;
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const response = await request(realApp)
          .get(`/api/chat/runs/${queued.body.run_id}`)
          .set("Authorization", `Bearer ${token}`)
          .expect(200);
        if (["completed", "failed"].includes(response.body.status)) {
          run = response.body;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      expect(chatBody.options.allowed_adapters).toEqual([]);
      expect(run).toMatchObject({
        status: "completed",
        final_answer: "Leaves look green because chlorophyll absorbs mostly red and blue light while reflecting green light.",
        expert_outputs: [],
        plan: { steps: [] }
      });
      expect(run.error).toBeNull();
      const execution = await request(realApp)
        .get(`/api/executions/${run.execution.execution_id}`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      expect(execution.body.participants).toEqual([]);
      expect(execution.body.record_hash_valid).toBe(true);
    } finally {
      await realApp?.locals?.drainBackgroundTasks?.({ timeoutMs: 5000 });
      await realApp?.locals?.store?.close?.();
      globalThis.fetch = previousFetch;
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await fs.rm(realTmp, { recursive: true, force: true });
    }
  });

  it("filters runtime model listings by requester-visible agents", async () => {
    const previous = {
      APP_API_TOKENS_JSON: process.env.APP_API_TOKENS_JSON,
      TCAR_ENGINE_MODE: process.env.TCAR_ENGINE_MODE,
      TCAR_RUNTIME_API_URL: process.env.TCAR_RUNTIME_API_URL,
      TCAR_RUNTIME_API_KEY: process.env.TCAR_RUNTIME_API_KEY
    };
    const previousFetch = globalThis.fetch;
    const realTmp = await fs.mkdtemp(path.join(os.tmpdir(), "tcar-chat-model-scope-"));
    const tokenBob = "model_scope_bob_token_0123456789";
    const tokenAdmin = "model_scope_admin_token_0123456789";
    let realApp;

    try {
      process.env.APP_API_TOKENS_JSON = JSON.stringify({
        [tokenBob]: { user_id: "bob", workspace_id: "workspace_models", role: "user" },
        [tokenAdmin]: { user_id: "admin", workspace_id: "workspace_models", role: "admin" }
      });
      process.env.TCAR_ENGINE_MODE = "real";
      process.env.TCAR_RUNTIME_API_URL = "http://gpu-runtime.internal:9000";
      process.env.TCAR_RUNTIME_API_KEY = "runtime-secret-for-tests";
      globalThis.fetch = async () =>
        new Response(
          JSON.stringify({
            ok: true,
            base_model: "qwen36-awq",
            models: [
              { id: "qwen36-awq" },
              { id: "alice_private_model_lora" },
              { id: "team_visible_model_lora" },
              { id: "runtime_only_secret_lora" }
            ],
            raw: { data: [{ id: "runtime_only_secret_lora" }] }
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );

      realApp = await createApp({
        dbPath: path.join(realTmp, "db.json"),
        uploadRoot: realTmp
      });
      await realApp.locals.store.mutate((data) => {
        data.agents.push(
          {
            id: "alice_private_model_lora",
            title: "Alice private model",
            capability: "Private to Alice.",
            boundary: "Private.",
            workspace_id: "workspace_models",
            visibility: "private",
            created_by: "alice",
            enabled: true,
            mounted: true
          },
          {
            id: "team_visible_model_lora",
            title: "Team visible model",
            capability: "Visible to workspace.",
            boundary: "Team.",
            workspace_id: "workspace_models",
            visibility: "team",
            created_by: "alice",
            enabled: true,
            mounted: true
          }
        );
        return data.agents.length;
      });

      const userModels = await request(realApp)
        .get("/api/runtime/models")
        .set("Authorization", `Bearer ${tokenBob}`)
        .expect(200);
      expect(userModels.body.models.map((model) => model.id)).toEqual(["qwen36-awq", "team_visible_model_lora"]);
      expect(userModels.body.raw).toBeUndefined();

      const adminModels = await request(realApp)
        .get("/api/runtime/models")
        .set("Authorization", `Bearer ${tokenAdmin}`)
        .expect(200);
      expect(adminModels.body.models.map((model) => model.id)).toEqual([
        "qwen36-awq",
        "alice_private_model_lora",
        "team_visible_model_lora",
        "runtime_only_secret_lora"
      ]);
      expect(adminModels.body.raw.data[0].id).toBe("runtime_only_secret_lora");
    } finally {
      await realApp?.locals?.store?.close?.();
      globalThis.fetch = previousFetch;
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
      await fs.rm(realTmp, { recursive: true, force: true });
    }
  });

  it("bounds shared memory entries before reuse", () => {
    const memory = Array.from({ length: 6 }, (_, index) => ({
      tag: `tag_${index}`,
      source: `source_${index}`,
      content: `${index}`.repeat(10)
    }));
    const normalized = normalizeSharedMemory(memory, {
      maxEntries: 3,
      maxEntryChars: 4,
      maxTotalChars: 8
    });
    expect(normalized).toEqual([
      { tag: "tag_4", source: "source_4", content: "4444" },
      { tag: "tag_5", source: "source_5", content: "5555" }
    ]);

    const userPreserved = normalizeSharedMemory([
      { tag: "user_request", source: "user", content: "Keep the no-downtime constraint." },
      ...Array.from({ length: 5 }, (_, index) => ({
        tag: `route_${index}`,
        source: `agent_${index}`,
        content: "x".repeat(8)
      })),
      { tag: "user_request", source: "user", content: "Revise the rollout." }
    ], {
      maxEntries: 3,
      maxEntryChars: 100,
      maxTotalChars: 80
    });
    expect(userPreserved).toEqual([
      { tag: "user_request", source: "user", content: "Keep the no-downtime constraint." },
      { tag: "route_4", source: "agent_4", content: "xxxxxxxx" },
      { tag: "user_request", source: "user", content: "Revise the rollout." }
    ]);
  });

  it("handles concurrent chat stress without losing runs", async () => {
    process.env.APP_MAX_ACTIVE_RUNS_PER_USER = "100";
    process.env.APP_MAX_ACTIVE_RUNS_PER_WORKSPACE = "100";
    process.env.APP_MAX_ACTIVE_RUNS_GLOBAL = "100";
    const billing = await request(app).get("/api/billing/account").expect(200);
    await request(app)
      .post(`/api/admin/billing/accounts/${billing.body.account.user_id}/adjustments`)
      .set("Idempotency-Key", "concurrent-stress-context-capacity")
      .send({ amount_credits: "5000", reason: "Concurrent routing stress capacity" })
      .expect(201);
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
    // This intentionally performs many serialized durable JSON commits. On a
    // shared CI host the integrity work can exceed 75 seconds when the rest of
    // the suite is running concurrently, even though every run continues to
    // make progress. Keep the workload and give it a realistic wall-clock
    // budget so cleanup never races still-active writers.
  }, 120000);
});

describe("documents and sources", () => {
  it("attaches uploaded knowledge to one agent and removes the link when the file is deleted", async () => {
    await request(app)
      .post("/api/agents")
      .send({
        id: "launch_risk_lora",
        title: "Launch risk analyst",
        capability: "Reviews launch risk using attached sources.",
        boundary: "Use approved sources and state uncertainty."
      })
      .expect(201);

    const upload = await request(app)
      .post("/api/documents")
      .field("title", "Launch brief")
      .field("scope", "knowledge")
      .field("resource_for_agent_id", "launch_risk_lora")
      .attach("file", Buffer.from("The launch brief identifies supplier concentration as a material risk."), "launch-brief.md")
      .expect(201);

    expect(upload.body.resource_for_agent_id).toBe("launch_risk_lora");
    await request(app)
      .patch("/api/agents/launch_risk_lora")
      .send({
        resources: [`agent:${upload.body.agent_id}`],
        consumes: ["user_request", "document_context"],
        tools: ["document_search", "document_read"]
      })
      .expect(200);

    await app.locals.store.mutate((data) => {
      for (const id of ["launch_risk_lora", upload.body.agent_id]) {
        const agent = data.agents.find((item) => item.id === id);
        agent.ready = true;
        agent.mounted = true;
        agent.runtime_sync_pending = false;
      }
      return true;
    });

    const session = await createSession("Attached knowledge handoff");
    const queued = await request(app)
      .post(`/api/chat/sessions/${session.session_id}/messages`)
      .send({ content: "Ask @launch_risk_lora what material risk is in the attached launch brief." })
      .expect(202);
    const run = await waitForRun(queued.body.run_id);
    const parentRoute = run.expert_outputs.find((route) => route.adapter === "launch_risk_lora");
    expect(parentRoute.consumption_validation).toMatchObject({
      valid: true,
      resolved_contract_inputs: ["document_context"]
    });
    expect(parentRoute.domain_answer).toContain("supplier concentration");

    const documents = await request(app).get("/api/documents").expect(200);
    expect(documents.body.documents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        document_id: upload.body.document_id,
        resource_for_agent_id: "launch_risk_lora"
      })
    ]));

    await request(app).delete(`/api/documents/${upload.body.document_id}`).expect(200);
    const parent = await request(app).get("/api/agents/launch_risk_lora").expect(200);
    expect(parent.body.resources).not.toContain(`agent:${upload.body.agent_id}`);
  });

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
    await app.locals.store.mutate((data) => {
      const agent = data.agents.find((item) => item.id === upload.body.agent_id);
      agent.mounted = true;
      agent.requires_vllm_reload = false;
      return agent;
    });
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
    expect(run.sources.every((source) => source.verified === true)).toBe(true);
    const documentRoute = run.expert_outputs.find((route) => route.adapter === upload.body.agent_id);
    expect(documentRoute.handoff_artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ artifact: "retrieved_context", producer_agent_id: upload.body.agent_id }),
      expect.objectContaining({ artifact: "cited_passages", content_type: "application/json" })
    ]));
    expect(run.final_answer).toContain("rank is 5");
  });

  it("separates reusable Knowledge uploads from chat-only uploads", async () => {
    process.env.APP_MAX_ACTIVE_RUNS_PER_USER = "4";
    process.env.APP_MAX_ACTIVE_RUNS_PER_WORKSPACE = "4";
    process.env.APP_MAX_ACTIVE_RUNS_GLOBAL = "4";
    const sessionA = await createSession("Scoped files A");
    const sessionB = await createSession("Scoped files B");
    const knowledge = await request(app)
      .post("/api/documents")
      .field("title", "Reusable README")
      .field("scope", "knowledge")
      .attach("file", Buffer.from("Reusable setup guidance for every chat."), "README.md")
      .expect(201);
    const chatOnly = await request(app)
      .post("/api/documents")
      .field("title", "Chat A Notes")
      .field("scope", "chat")
      .field("session_id", sessionA.session_id)
      .attach("file", Buffer.from("Only chat A may route this private note."), "chat-a.md")
      .expect(201);

    expect(knowledge.body).toMatchObject({ scope: "knowledge", session_id: null });
    expect(chatOnly.body).toMatchObject({ scope: "chat", session_id: sessionA.session_id });

    const knowledgeList = await request(app).get("/api/documents").expect(200);
    expect(knowledgeList.body.documents.map((document) => document.document_id)).toContain(knowledge.body.document_id);
    expect(knowledgeList.body.documents.map((document) => document.document_id)).not.toContain(chatOnly.body.document_id);

    await request(app).get("/api/documents?scope=chat").expect(400);
    const chatAList = await request(app)
      .get(`/api/documents?scope=chat&session_id=${encodeURIComponent(sessionA.session_id)}`)
      .expect(200);
    const chatBList = await request(app)
      .get(`/api/documents?scope=chat&session_id=${encodeURIComponent(sessionB.session_id)}`)
      .expect(200);
    expect(chatAList.body.documents.map((document) => document.document_id)).toEqual([chatOnly.body.document_id]);
    expect(chatBList.body.documents).toEqual([]);

    const sessionADetail = await request(app).get(`/api/chat/sessions/${sessionA.session_id}`).expect(200);
    const sessionBDetail = await request(app).get(`/api/chat/sessions/${sessionB.session_id}`).expect(200);
    expect(sessionADetail.body.chat_documents.map((document) => document.document_id)).toEqual([chatOnly.body.document_id]);
    expect(sessionBDetail.body.chat_documents).toEqual([]);

    const globalAgents = await request(app).get("/api/agents").expect(200);
    const chatAAgents = await request(app)
      .get(`/api/agents?session_id=${encodeURIComponent(sessionA.session_id)}`)
      .expect(200);
    const chatBAgents = await request(app)
      .get(`/api/agents?session_id=${encodeURIComponent(sessionB.session_id)}`)
      .expect(200);
    expect(globalAgents.body.agents.map((agent) => agent.id)).toContain(knowledge.body.agent_id);
    expect(globalAgents.body.agents.map((agent) => agent.id)).not.toContain(chatOnly.body.agent_id);
    expect(chatAAgents.body.agents.map((agent) => agent.id)).toContain(chatOnly.body.agent_id);
    expect(chatBAgents.body.agents.map((agent) => agent.id)).not.toContain(chatOnly.body.agent_id);

    const chatAQueued = await request(app)
      .post(`/api/chat/sessions/${sessionA.session_id}/messages`)
      .send({ content: '@"Chat A Notes source agent" use this chat file.' })
      .expect(202);
    const chatBQueued = await request(app)
      .post(`/api/chat/sessions/${sessionB.session_id}/messages`)
      .send({ content: '@"Chat A Notes source agent" must not be available here.' })
      .expect(202);
    const [chatARun, chatBRun] = await Promise.all([
      waitForRun(chatAQueued.body.run_id),
      waitForRun(chatBQueued.body.run_id)
    ]);
    const knowledgeQueued = await request(app)
      .post(`/api/chat/sessions/${sessionB.session_id}/messages`)
      .send({ content: '@“Reusable README source agent” use the reusable file.' })
      .expect(202);
    const knowledgeRun = await waitForRun(knowledgeQueued.body.run_id);
    expect(chatARun.plan.steps.map((step) => step.adapter)).toContain(chatOnly.body.agent_id);
    expect(chatBRun.plan.steps.map((step) => step.adapter)).not.toContain(chatOnly.body.agent_id);
    expect(knowledgeRun.plan.steps.map((step) => step.adapter)).toContain(knowledge.body.agent_id);

    await request(app)
      .post("/api/documents")
      .field("title", "Missing chat")
      .field("scope", "chat")
      .attach("file", Buffer.from("invalid"), "invalid.txt")
      .expect(400);
  });

  it("binds an explicit chat attachment to its session source and rejects cross-session document ids", async () => {
    const sessionA = await createSession("Attachment binding A");
    const sessionB = await createSession("Attachment binding B");
    const globalResume = await request(app)
      .post("/api/documents")
      .field("title", "Global Resume")
      .field("scope", "knowledge")
      .field("routing_cues", "resume, candidate experience")
      .attach("file", Buffer.from("Unrelated archived candidate experience."), "global-resume.txt")
      .expect(201);
    const chatResume = await request(app)
      .post("/api/documents")
      .field("title", "Candidate Resume")
      .field("scope", "chat")
      .field("session_id", sessionA.session_id)
      .field("routing_cues", "resume, data science, AI experience")
      .attach("file", Buffer.from("Python, SQL, visualization, machine learning, and AI training experience."), "candidate-resume.txt")
      .expect(201);

    const queued = await request(app)
      .post(`/api/chat/sessions/${sessionA.session_id}/messages`)
      .send({
        content: "Using only the attached resume, extract and cite the candidate's data and AI experience.",
        attachments: [{
          type: "document",
          name: "Candidate Resume",
          document_id: chatResume.body.document_id
        }]
      })
      .expect(202);
    const run = await waitForRun(queued.body.run_id);

    expect(run.status).toBe("completed");
    expect(run.attachment_document_ids).toEqual([chatResume.body.document_id]);
    expect(run.attachment_agent_ids).toEqual([chatResume.body.agent_id]);
    expect(run.plan.routing.mode).toBe("chat_attachment");
    expect(run.plan.steps.map((step) => step.adapter)).toContain(chatResume.body.agent_id);
    expect(run.plan.steps.map((step) => step.adapter)).not.toContain(globalResume.body.agent_id);

    await request(app)
      .post(`/api/chat/sessions/${sessionB.session_id}/messages`)
      .send({
        content: "Use the attached resume.",
        attachments: [{
          type: "document",
          name: "Candidate Resume",
          document_id: chatResume.body.document_id
        }]
      })
      .expect(404);
  });

  it("fails closed when an attached-file reference is ambiguous within one chat", async () => {
    const session = await createSession("Attachment ambiguity");
    const uploads = [];
    for (const title of ["Candidate Resume", "Manager Resume"]) {
      const upload = await request(app)
        .post("/api/documents")
        .field("title", title)
        .field("scope", "chat")
        .field("session_id", session.session_id)
        .field("routing_cues", "resume")
        .attach("file", Buffer.from(`${title} evidence.`), `${title.toLowerCase().replaceAll(" ", "-")}.txt`)
        .expect(201);
      uploads.push(upload.body);
    }

    const response = await request(app)
      .post(`/api/chat/sessions/${session.session_id}/messages`)
      .send({
        content: "Use only the attached resume.",
        attachments: uploads.map((upload) => ({
          type: "document",
          name: upload.title,
          document_id: upload.document_id
        }))
      })
      .expect(409);
    expect(response.body.message).toMatch(/more than one chat file/i);
  });

  it("keeps a deleted document agent inspectable as an owner-scoped tombstone after Runtime purge", async () => {
    const upload = await request(app)
      .post("/api/documents")
      .field("title", "Runtime purge tombstone")
      .attach("file", Buffer.from("Retained document tombstone proof."), "tombstone.txt")
      .expect(201);
    await request(app).delete(`/api/documents/${upload.body.document_id}`).expect(200);

    const previous = {
      TCAR_ENGINE_MODE: process.env.TCAR_ENGINE_MODE,
      TCAR_RUNTIME_API_URL: process.env.TCAR_RUNTIME_API_URL,
      TCAR_RUNTIME_API_KEY: process.env.TCAR_RUNTIME_API_KEY
    };
    const previousFetch = globalThis.fetch;
    try {
      process.env.TCAR_ENGINE_MODE = "real";
      process.env.TCAR_RUNTIME_API_URL = "http://gpu-runtime.internal:9000";
      process.env.TCAR_RUNTIME_API_KEY = "runtime-tombstone-test-key";
      globalThis.fetch = async () => Response.json({ detail: "not found" }, { status: 404 });
      const detail = await request(app).get(`/api/agents/${upload.body.agent_id}`).expect(200);
      expect(detail.body).toMatchObject({
        id: upload.body.agent_id,
        enabled: false,
        mounted: false,
        runtime_purged: true
      });
    } finally {
      globalThis.fetch = previousFetch;
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("preserves PDF pages in chunks and in the GPU registration payload", async () => {
    const previous = {
      TCAR_ENGINE_MODE: process.env.TCAR_ENGINE_MODE,
      TCAR_RUNTIME_API_URL: process.env.TCAR_RUNTIME_API_URL,
      TCAR_RUNTIME_API_KEY: process.env.TCAR_RUNTIME_API_KEY
    };
    const previousFetch = globalThis.fetch;
    let runtimeBody;
    let runtimeReceiptChunk;
    try {
      process.env.TCAR_ENGINE_MODE = "real";
      process.env.TCAR_RUNTIME_API_URL = "http://gpu-runtime.internal:9000";
      process.env.TCAR_RUNTIME_API_KEY = "runtime-secret-for-pdf-test";
      globalThis.fetch = async (_url, options = {}) => {
        if (options.method === "DELETE") {
          return new Response(JSON.stringify({ ok: true, status: "deleted", purged: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          });
        }
        runtimeBody = JSON.parse(options.body);
        const runtimeResponse = authoritativeRuntimeDocumentResponse(runtimeBody, {
          body: "runtime-authoritative-marker Shipment CT-204 must be rejected after 45 cumulative minutes.",
          pageStart: 1,
          pageEnd: 1
        });
        runtimeReceiptChunk = runtimeResponse.result.chunk_records[0];
        return new Response(JSON.stringify(runtimeResponse), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      };

      const upload = await request(app)
        .post("/api/documents")
        .field("title", "Cold Chain Stability Guide")
        .attach("file", await fs.readFile(new URL("../fixtures/cold_chain_stability_guide.pdf", import.meta.url)), "stability.pdf")
        .expect(201);
      expect(upload.body.chunks).toBe(1);
      expect(upload.body.runtime.result.chunk_records).toBeUndefined();
      expect(upload.body.runtime.result.source_digest).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(upload.body.source_digest).toBe(upload.body.runtime.result.source_digest);
      expect(upload.body.corpus_revision).toBe(upload.body.runtime.result.corpus_revision);
      expect(runtimeBody.text).toContain("Shipment CT-204 disposition rule");
      expect(runtimeBody.pages).toHaveLength(1);
      expect(runtimeBody.pages[0]).toEqual(expect.objectContaining({
        page: 1,
        text: expect.stringContaining("Reject CT-204")
      }));
      const storedDocument = app.locals.store.read().documents.find((document) => document.document_id === upload.body.document_id);
      expect(storedDocument.page_count).toBe(1);
      expect(storedDocument.chunks.map((chunk) => [chunk.page_start, chunk.page_end])).toEqual([[1, 1]]);
      expect(storedDocument.chunks[0].body).toBe("runtime-authoritative-marker Shipment CT-204 must be rejected after 45 cumulative minutes.");
      expect(storedDocument.chunks[0].content_digest).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(storedDocument.source_digest).toBe(upload.body.runtime.result.source_digest);
      expect(storedDocument.corpus_revision).toMatch(/^sha256:[a-f0-9]{64}$/);

      const listed = await request(app)
        .get("/api/documents")
        .expect(200);
      expect(listed.body.documents).toEqual(expect.arrayContaining([
        expect.objectContaining({
          document_id: upload.body.document_id,
          source_digest: storedDocument.source_digest,
          corpus_revision: storedDocument.corpus_revision
        })
      ]));

      const search = await request(app)
        .post(`/api/documents/${upload.body.document_id}/search`)
        .send({ query: "runtime-authoritative-marker" })
        .expect(200);
      expect(search.body.results[0]).toEqual(expect.objectContaining({
        chunk_id: runtimeReceiptChunk.chunk_id,
        page_start: runtimeReceiptChunk.page_start,
        page_end: runtimeReceiptChunk.page_end,
        content_digest: `sha256:${runtimeReceiptChunk.content_digest}`,
        excerpt: runtimeReceiptChunk.body
      }));

      const directChunks = chunkDocument({
        slug: "financial",
        text: runtimeBody.text,
        pages: runtimeBody.pages
      });
      expect(directChunks.map((chunk) => chunk.page_start)).toEqual([1]);

      const deleted = await request(app)
        .delete(`/api/documents/${upload.body.document_id}`)
        .expect(200);
      expect(deleted.body).toEqual(expect.objectContaining({
        source_digest: storedDocument.source_digest,
        corpus_revision: storedDocument.corpus_revision
      }));
      expect(app.locals.store.read().documents.find((document) => document.document_id === upload.body.document_id))
        .toEqual(expect.objectContaining({
          enabled: false,
          source_digest: storedDocument.source_digest,
          corpus_revision: storedDocument.corpus_revision
        }));
    } finally {
      globalThis.fetch = previousFetch;
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });

  it("rejects a tampered Runtime chunk receipt and compensates the remote registration", async () => {
    const previous = {
      TCAR_ENGINE_MODE: process.env.TCAR_ENGINE_MODE,
      TCAR_RUNTIME_API_URL: process.env.TCAR_RUNTIME_API_URL,
      TCAR_RUNTIME_API_KEY: process.env.TCAR_RUNTIME_API_KEY
    };
    const previousFetch = globalThis.fetch;
    const calls = [];
    try {
      process.env.TCAR_ENGINE_MODE = "real";
      process.env.TCAR_RUNTIME_API_URL = "http://gpu-runtime.internal:9000";
      process.env.TCAR_RUNTIME_API_KEY = "runtime-secret-for-tamper-test";
      globalThis.fetch = async (url, options = {}) => {
        const pathName = new URL(url).pathname;
        calls.push({ method: options.method || "GET", pathName });
        if (pathName === "/documents" && options.method === "POST") {
          const runtimeRequestBody = JSON.parse(options.body);
          const response = authoritativeRuntimeDocumentResponse(runtimeRequestBody, {
            body: "Runtime committed source text that must pass an exact digest check."
          });
          response.result.source_digest = "0".repeat(64);
          return new Response(JSON.stringify(response), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          });
        }
        if (pathName === "/documents/tampered_receipt" && options.method === "DELETE") {
          return new Response(JSON.stringify({
            ok: true,
            status: "purged",
            purged: true,
            enabled: false,
            mounted: false,
            requires_vllm_reload: false,
            agent: { id: "tampered_receipt", enabled: false }
          }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          });
        }
        return new Response(JSON.stringify({ detail: "not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" }
        });
      };

      const upload = await request(app)
        .post("/api/documents")
        .field("title", "Tampered Receipt")
        .field("agent_id", "tampered_receipt")
        .attach("file", Buffer.from("Original source text with enough material for a local preflight chunk."), "tampered.txt")
        .expect(502);

      expect(upload.body.error).toBe("runtime_document_contract_invalid");
      expect(calls).toEqual([
        { method: "POST", pathName: "/documents" },
        { method: "DELETE", pathName: "/documents/tampered_receipt" }
      ]);
      expect(app.locals.store.read().documents).toHaveLength(0);
      expect(app.locals.store.read().agents.some((agent) => agent.id === "tampered_receipt")).toBe(false);
    } finally {
      globalThis.fetch = previousFetch;
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });

  it("uses collision-resistant ids for concurrent automatic document agents", async () => {
    const uploads = await Promise.all(
      [1, 2].map((index) =>
        request(app)
          .post("/api/documents")
          .field("title", "Concurrent Manual")
          .field("routing_cues", "manual, concurrency")
          .attach("file", Buffer.from(`Concurrent upload ${index} has unique content for indexing.`), `manual-${index}.txt`)
          .expect(201)
      )
    );

    const agentIds = uploads.map((response) => response.body.agent_id);
    expect(new Set(agentIds).size).toBe(2);
    expect(agentIds.every((id) => /^concurrent_manual_[a-f0-9]{8}$/.test(id))).toBe(true);
    expect(new Set(uploads.map((response) => response.body.index_path)).size).toBe(2);
  });

  it("rejects duplicate explicit document agent ids", async () => {
    await request(app)
      .post("/api/documents")
      .field("title", "Explicit Agent")
      .field("agent_id", "explicit_manual_lora")
      .attach("file", Buffer.from("First explicit document content."), "explicit-one.txt")
      .expect(201);

    await request(app)
      .post("/api/documents")
      .field("title", "Explicit Agent Replacement")
      .field("agent_id", "explicit_manual_lora")
      .attach("file", Buffer.from("Second explicit document content."), "explicit-two.txt")
      .expect(409);
  });

  it("redacts document source paths from non-admin document and run responses", async () => {
    const previousTokens = process.env.APP_API_TOKENS_JSON;
    process.env.APP_API_TOKENS_JSON = JSON.stringify({
      doc_user_token: { user_id: "doc_user", workspace_id: "workspace_docs", role: "user" },
      doc_admin_token: { user_id: "doc_admin", workspace_id: "workspace_docs", role: "admin" }
    });

    try {
      const upload = await request(app)
        .post("/api/documents")
        .set("Authorization", "Bearer doc_user_token")
        .field("title", "User Safe Manual")
        .field("routing_cues", "user-safe-manual, launch proof")
        .attach("file", Buffer.from("Launch proof requires rollback owner and privacy review."), "safe-manual.txt")
        .expect(201);

      expect(upload.body.index_path).toBeUndefined();
      expect(upload.body.adapter_path).toBeUndefined();
      expect(upload.body.skill_path).toBeUndefined();
      expect(upload.body.runtime).toBeUndefined();
      await app.locals.store.mutate((data) => {
        const agent = data.agents.find((item) => item.id === upload.body.agent_id);
        agent.mounted = true;
        agent.requires_vllm_reload = false;
        return agent;
      });

      const userDocuments = await request(app)
        .get("/api/documents")
        .set("Authorization", "Bearer doc_user_token")
        .expect(200);
      const userDocument = userDocuments.body.documents.find((doc) => doc.document_id === upload.body.document_id);
      expect(userDocument).toBeTruthy();
      expect(userDocument.index_path).toBeUndefined();

      const userChunks = await request(app)
        .get(`/api/documents/${upload.body.document_id}/chunks`)
        .set("Authorization", "Bearer doc_user_token")
        .expect(200);
      expect(userChunks.body.chunks[0].path).toBeUndefined();

      const userSearch = await request(app)
        .post(`/api/documents/${upload.body.document_id}/search`)
        .set("Authorization", "Bearer doc_user_token")
        .send({ query: "rollback owner privacy review" })
        .expect(200);
      expect(userSearch.body.results[0].path).toBeUndefined();

      const adminChunks = await request(app)
        .get(`/api/documents/${upload.body.document_id}/chunks`)
        .set("Authorization", "Bearer doc_admin_token")
        .expect(200);
      expect(adminChunks.body.chunks[0].path).toContain("sources/tcar_documents/");

      const session = await request(app)
        .post("/api/chat/sessions")
        .set("Authorization", "Bearer doc_user_token")
        .send({ title: "User manual question" })
        .expect(201);
      const queued = await request(app)
        .post(`/api/chat/sessions/${session.body.session_id}/messages`)
        .set("Authorization", "Bearer doc_user_token")
        .send({ content: "Using the uploaded User Safe Manual, what does launch proof require?" })
        .expect(202);
      const run = await waitForRunAs(queued.body.run_id, "Bearer doc_user_token");
      expect(run.status).toBe("completed");
      expect(run.sources.length).toBeGreaterThan(0);
      expect(run.sources[0].path).toBeUndefined();
      const routeWithCitation = run.expert_outputs.find((route) => route.citations?.length);
      expect(routeWithCitation.citations[0].path).toBeUndefined();
      expect(routeWithCitation.approved_sources).toBeUndefined();

      const routeDetail = await request(app)
        .get(`/api/chat/runs/${run.run_id}/routes/${routeWithCitation.step_id}`)
        .set("Authorization", "Bearer doc_user_token")
        .expect(200);
      expect(routeDetail.body.citations[0].path).toBeUndefined();
      expect(routeDetail.body.approved_sources).toBeUndefined();
    } finally {
      if (previousTokens === undefined) {
        delete process.env.APP_API_TOKENS_JSON;
      } else {
        process.env.APP_API_TOKENS_JSON = previousTokens;
      }
    }
  });

  it("rejects unsupported uploads and unsafe source paths", async () => {
    await request(app)
      .post("/api/documents")
      .field("title", "Missing file")
      .expect(400);

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

  it("rejects uploads whose extracted text exceeds the configured document limit", async () => {
    const previousLimit = process.env.APP_MAX_DOCUMENT_TEXT_CHARS;
    process.env.APP_MAX_DOCUMENT_TEXT_CHARS = "10";
    try {
      await request(app)
        .post("/api/documents")
        .field("title", "Too large")
        .attach("file", Buffer.from("this text is definitely too large"), "large.txt")
        .expect(413);
    } finally {
      if (previousLimit === undefined) {
        delete process.env.APP_MAX_DOCUMENT_TEXT_CHARS;
      } else {
        process.env.APP_MAX_DOCUMENT_TEXT_CHARS = previousLimit;
      }
    }
  });

  it("rejects raw uploads whose file bytes exceed the configured upload limit", async () => {
    const previousUploadLimit = process.env.APP_MAX_UPLOAD_FILE_BYTES;
    const limitedTmp = await fs.mkdtemp(path.join(os.tmpdir(), "tcar-chat-upload-limit-"));
    let limitedApp;
    process.env.APP_MAX_UPLOAD_FILE_BYTES = "8";
    try {
      limitedApp = await createApp({
        dbPath: path.join(limitedTmp, "db.json"),
        uploadRoot: limitedTmp
      });
      const response = await request(limitedApp)
        .post("/api/documents")
        .field("title", "Raw upload too large")
        .attach("file", Buffer.from("this upload is larger than eight bytes"), "large.txt")
        .expect(413);
      expect(response.body.message).toContain("8 bytes");
    } finally {
      await limitedApp?.locals?.store?.close?.();
      if (previousUploadLimit === undefined) {
        delete process.env.APP_MAX_UPLOAD_FILE_BYTES;
      } else {
        process.env.APP_MAX_UPLOAD_FILE_BYTES = previousUploadLimit;
      }
      await fs.rm(limitedTmp, { recursive: true, force: true });
    }
  });

  it("rejects oversized multipart document metadata before extraction", async () => {
    const previous = {
      APP_MAX_UPLOAD_FIELD_BYTES: process.env.APP_MAX_UPLOAD_FIELD_BYTES,
      APP_MAX_UPLOAD_FIELDS: process.env.APP_MAX_UPLOAD_FIELDS,
      APP_MAX_UPLOAD_PARTS: process.env.APP_MAX_UPLOAD_PARTS
    };
    const cases = [
      {
        env: { APP_MAX_UPLOAD_FIELD_BYTES: "8" },
        expected: "8 bytes",
        build: (agent) => agent.field("title", "x".repeat(32)).attach("file", Buffer.from("short text"), "small.txt")
      },
      {
        env: { APP_MAX_UPLOAD_FIELDS: "1" },
        expected: "1 fields",
        build: (agent) => agent.field("title", "Too many fields").field("routing_cues", "overflow").attach("file", Buffer.from("short text"), "small.txt")
      },
      {
        env: { APP_MAX_UPLOAD_PARTS: "2" },
        expected: "2 parts",
        build: (agent) => agent.field("title", "Too many parts").field("routing_cues", "overflow").attach("file", Buffer.from("short text"), "small.txt")
      }
    ];

    try {
      for (const testCase of cases) {
        for (const [key, value] of Object.entries(previous)) {
          if (value === undefined) {
            delete process.env[key];
          } else {
            process.env[key] = value;
          }
        }
        Object.assign(process.env, testCase.env);
        const limitedTmp = await fs.mkdtemp(path.join(os.tmpdir(), "tcar-chat-upload-meta-"));
        let limitedApp;
        try {
          limitedApp = await createApp({
            dbPath: path.join(limitedTmp, "db.json"),
            uploadRoot: limitedTmp
          });
          const response = await testCase.build(request(limitedApp).post("/api/documents")).expect(413);
          expect(response.body.error).toBe("upload_error");
          expect(response.body.message).toContain(testCase.expected);
        } finally {
          await limitedApp?.locals?.store?.close?.();
          await fs.rm(limitedTmp, { recursive: true, force: true });
        }
      }
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });

  it("rejects oversized JSON request bodies before route processing", async () => {
    const previousJsonLimit = process.env.APP_MAX_JSON_BODY_BYTES;
    const limitedTmp = await fs.mkdtemp(path.join(os.tmpdir(), "tcar-chat-json-limit-"));
    let limitedApp;
    process.env.APP_MAX_JSON_BODY_BYTES = "48";
    try {
      limitedApp = await createApp({
        dbPath: path.join(limitedTmp, "db.json"),
        uploadRoot: limitedTmp
      });
      const response = await request(limitedApp)
        .post("/api/chat/sessions")
        .send({ title: "x".repeat(256) })
        .expect(413);
      expect(response.body.error).toBe("request_too_large");
      expect(response.body.message).toContain("48 bytes");
    } finally {
      await limitedApp?.locals?.store?.close?.();
      if (previousJsonLimit === undefined) {
        delete process.env.APP_MAX_JSON_BODY_BYTES;
      } else {
        process.env.APP_MAX_JSON_BODY_BYTES = previousJsonLimit;
      }
      await fs.rm(limitedTmp, { recursive: true, force: true });
    }
  });

  it("enforces document count and chunk quotas before creating source agents", async () => {
    const previous = {
      APP_MAX_DOCUMENTS_PER_USER: process.env.APP_MAX_DOCUMENTS_PER_USER,
      APP_MAX_DOCUMENTS_PER_WORKSPACE: process.env.APP_MAX_DOCUMENTS_PER_WORKSPACE,
      APP_MAX_DOCUMENT_CHUNKS: process.env.APP_MAX_DOCUMENT_CHUNKS
    };

    try {
      process.env.APP_MAX_DOCUMENTS_PER_USER = "1";
      process.env.APP_MAX_DOCUMENTS_PER_WORKSPACE = "10";
      await request(app)
        .post("/api/documents")
        .field("title", "Quota One")
        .attach("file", Buffer.from("first quota document"), "one.txt")
        .expect(201);

      await request(app)
        .post("/api/documents")
        .field("title", "Quota Two")
        .attach("file", Buffer.from("second quota document"), "two.txt")
        .expect(429);

      process.env.APP_MAX_DOCUMENTS_PER_USER = "10";
      process.env.APP_MAX_DOCUMENT_CHUNKS = "1";
      await request(app)
        .post("/api/documents")
        .field("title", "Too Many Chunks")
        .field("max_words", "80")
        .field("overlap_words", "0")
        .attach("file", Buffer.from(Array.from({ length: 180 }, (_, index) => `word${index}`).join(" ")), "chunks.txt")
        .expect(413);
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });
});

describe("runtime registration atomicity", () => {
  const runtimeEnvNames = ["TCAR_ENGINE_MODE", "TCAR_RUNTIME_API_URL", "TCAR_RUNTIME_API_KEY"];

  function ownedPurgeResponse(agentId) {
    return {
      ok: true,
      status: "purged",
      id: agentId,
      agent: { id: agentId, enabled: false, mounted: false, lifecycle_status: "purged" },
      enabled: false,
      mounted: false,
      purged: true,
      requires_vllm_reload: false
    };
  }

  function enableRealRuntime() {
    const previous = Object.fromEntries(runtimeEnvNames.map((name) => [name, process.env[name]]));
    process.env.TCAR_ENGINE_MODE = "real";
    process.env.TCAR_RUNTIME_API_URL = "http://gpu-runtime.internal:9000";
    process.env.TCAR_RUNTIME_API_KEY = "atomicity-test-runtime-key";
    return () => {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    };
  }

  it("compensates a committed agent when durable save fails and permits a clean same-id retry", async () => {
    const restoreEnv = enableRealRuntime();
    const previousFetch = globalThis.fetch;
    const calls = [];
    const registrationIds = [];
    const store = app.locals.store;
    const originalSaveNow = store.saveNow.bind(store);
    let forceSaveFailure = true;
    store.saveNow = async () => {
      if (!forceSaveFailure) return originalSaveNow();
      forceSaveFailure = false;
      await fs.writeFile(`${store.dbPath}.tmp`, `${JSON.stringify(store.data)}\n`, "utf8");
      throw new Error("forced durable agent save failure");
    };
    globalThis.fetch = async (url, options = {}) => {
      const pathName = new URL(url).pathname;
      const body = options.body ? JSON.parse(options.body) : {};
      calls.push({ method: options.method || "GET", pathName, body });
      if (pathName === "/agents" && options.method === "POST") {
        registrationIds.push(body.registration_id);
        return Response.json({
          ok: true,
          status: "added",
          id: body.id,
          registration_id: body.registration_id,
          result: { status: "added", id: body.id },
          agent: {
            id: body.id,
            title: body.title,
            capability: body.capability,
            boundary: body.boundary,
            consumes: body.consumes,
            produces: body.produces,
            routing_cues: body.routing_cues,
            resources: [],
            tools: [],
            sources: [],
            enabled: true,
            mounted: true,
            registration_id: body.registration_id,
            registration_kind: "agent",
            registration_cleanup_allowed: true,
            registration_source_root: `sources/tcar_dummy_loras/${body.id}`
          },
          mounted: true,
          requires_vllm_reload: false
        });
      }
      if (pathName === "/agents/atomic_store_failure_lora" && options.method === "DELETE") {
        return Response.json(ownedPurgeResponse("atomic_store_failure_lora"));
      }
      return Response.json({ detail: "not found" }, { status: 404 });
    };

    const payload = {
      id: "atomic_store_failure_lora",
      title: "Atomic store failure",
      capability: "Tests durable registration compensation.",
      boundary: "Use only this test."
    };
    try {
      await request(app).post("/api/agents").send(payload).expect(500);
      expect(app.locals.store.read().agents.some((agent) => agent.id === payload.id)).toBe(false);
      const durableAfterFailure = JSON.parse(await fs.readFile(store.dbPath, "utf8"));
      expect(durableAfterFailure.agents.some((agent) => agent.id === payload.id)).toBe(false);
      expect(calls.map((call) => `${call.method} ${call.pathName}`)).toEqual([
        "POST /agents",
        "DELETE /agents/atomic_store_failure_lora"
      ]);
      expect(calls[1].body).toEqual({
        audit_context: calls[0].body.audit_context,
        registration_id: registrationIds[0],
        purge_registration: true
      });

      store.saveNow = originalSaveNow;
      const retried = await request(app).post("/api/agents").send(payload).expect(201);
      expect(registrationIds[1]).not.toBe(registrationIds[0]);
      expect(retried.body.runtime?.registration_id).toBeUndefined();
      expect(retried.body.runtime?.agent?.registration_id).toBeUndefined();
      const stored = app.locals.store.read().agents.find((agent) => agent.id === payload.id);
      expect(stored).toBeTruthy();
      expect(stored.registration_id).toBeUndefined();
      expect(stored.registration_cleanup_allowed).toBeUndefined();
      expect(stored.registration_source_root).toBeUndefined();
    } finally {
      store.saveNow = originalSaveNow;
      globalThis.fetch = previousFetch;
      restoreEnv();
    }
  });

  it("cleans a token-owned agent after the Runtime commits but the POST response is lost", async () => {
    const restoreEnv = enableRealRuntime();
    const previousFetch = globalThis.fetch;
    const calls = [];
    let committedRegistrationId;
    globalThis.fetch = async (url, options = {}) => {
      const pathName = new URL(url).pathname;
      const body = options.body ? JSON.parse(options.body) : {};
      calls.push({ method: options.method || "GET", pathName, body });
      if (pathName === "/agents" && options.method === "POST") {
        committedRegistrationId = body.registration_id;
        throw new Error("response lost after Runtime commit");
      }
      if (pathName === "/agents/commit_timeout_lora" && options.method === "DELETE") {
        return Response.json(ownedPurgeResponse("commit_timeout_lora"));
      }
      return Response.json({ detail: "not found" }, { status: 404 });
    };
    try {
      await request(app)
        .post("/api/agents")
        .send({
          id: "commit_timeout_lora",
          title: "Commit timeout",
          capability: "Tests an ambiguous registration response.",
          boundary: "Use only this test."
        })
        .expect(500);
      expect(calls.map((call) => `${call.method} ${call.pathName}`)).toEqual([
        "POST /agents",
        "DELETE /agents/commit_timeout_lora"
      ]);
      expect(calls[1].body.registration_id).toBe(committedRegistrationId);
      expect(app.locals.store.read().agents.some((agent) => agent.id === "commit_timeout_lora")).toBe(false);
    } finally {
      globalThis.fetch = previousFetch;
      restoreEnv();
    }
  });

  it("rolls back in-memory and durable document state when save fails", async () => {
    const restoreEnv = enableRealRuntime();
    const previousFetch = globalThis.fetch;
    const calls = [];
    const store = app.locals.store;
    const originalSaveNow = store.saveNow.bind(store);
    store.saveNow = async () => {
      await fs.writeFile(`${store.dbPath}.tmp`, `${JSON.stringify(store.data)}\n`, "utf8");
      throw new Error("forced durable document save failure");
    };
    globalThis.fetch = async (url, options = {}) => {
      const pathName = new URL(url).pathname;
      const body = options.body ? JSON.parse(options.body) : {};
      calls.push({ method: options.method || "GET", pathName, body });
      if (pathName === "/documents" && options.method === "POST") {
        const response = authoritativeRuntimeDocumentResponse(body, {
          body: "Runtime-owned document body."
        });
        response.agent.registration_id = body.registration_id;
        response.agent.registration_cleanup_allowed = true;
        return Response.json(response);
      }
      if (pathName === "/documents/atomic_document_save" && options.method === "DELETE") {
        return Response.json(ownedPurgeResponse("atomic_document_save"));
      }
      return Response.json({ detail: "not found" }, { status: 404 });
    };
    try {
      await request(app)
        .post("/api/documents")
        .field("title", "Atomic document save")
        .field("agent_id", "atomic_document_save")
        .attach("file", Buffer.from("Uploaded document text for atomic rollback."), "atomic.txt")
        .expect(500);
      expect(app.locals.store.read().documents.some((document) => document.agent_id === "atomic_document_save")).toBe(false);
      expect(app.locals.store.read().agents.some((agent) => agent.id === "atomic_document_save")).toBe(false);
      const durable = JSON.parse(await fs.readFile(store.dbPath, "utf8"));
      expect(durable.documents.some((document) => document.agent_id === "atomic_document_save")).toBe(false);
      expect(calls.map((call) => `${call.method} ${call.pathName}`)).toEqual([
        "POST /documents",
        "DELETE /documents/atomic_document_save"
      ]);
      expect(calls[1].body.registration_id).toBe(calls[0].body.registration_id);
    } finally {
      store.saveNow = originalSaveNow;
      globalThis.fetch = previousFetch;
      restoreEnv();
    }
  });

  it("cleans a token-owned document after a lost commit response and permits same-id retry", async () => {
    const restoreEnv = enableRealRuntime();
    const previousFetch = globalThis.fetch;
    const calls = [];
    const registrationIds = [];
    let firstAttempt = true;
    globalThis.fetch = async (url, options = {}) => {
      const pathName = new URL(url).pathname;
      const body = options.body ? JSON.parse(options.body) : {};
      calls.push({ method: options.method || "GET", pathName, body });
      if (pathName === "/documents" && options.method === "POST") {
        registrationIds.push(body.registration_id);
        if (firstAttempt) {
          firstAttempt = false;
          throw new Error("document response lost after Runtime commit");
        }
        return Response.json(authoritativeRuntimeDocumentResponse(body, {
          body: "Runtime-owned retry body."
        }));
      }
      if (pathName === "/documents/document_commit_timeout" && options.method === "DELETE") {
        return Response.json(ownedPurgeResponse("document_commit_timeout"));
      }
      return Response.json({ detail: "not found" }, { status: 404 });
    };
    const upload = () => request(app)
      .post("/api/documents")
      .field("title", "Document commit timeout")
      .field("agent_id", "document_commit_timeout")
      .attach("file", Buffer.from("Document text for ambiguous commit cleanup."), "commit.txt");
    try {
      await upload().expect(500);
      expect(app.locals.store.read().documents.some((document) => document.agent_id === "document_commit_timeout")).toBe(false);
      expect(calls.map((call) => `${call.method} ${call.pathName}`)).toEqual([
        "POST /documents",
        "DELETE /documents/document_commit_timeout"
      ]);
      expect(calls[1].body.registration_id).toBe(registrationIds[0]);

      await upload().expect(201);
      expect(registrationIds[1]).not.toBe(registrationIds[0]);
      expect(app.locals.store.read().documents.some((document) => document.agent_id === "document_commit_timeout")).toBe(true);
    } finally {
      globalThis.fetch = previousFetch;
      restoreEnv();
    }
  });

  function failTwoLifecycleCompletionSaves(store) {
    const originalSaveNow = store.saveNow.bind(store);
    let calls = 0;
    store.saveNow = async () => {
      calls += 1;
      if (calls === 2 || calls === 3) {
        throw new Error("forced lifecycle completion persistence failure");
      }
      return originalSaveNow();
    };
    return () => {
      store.saveNow = originalSaveNow;
    };
  }

  it("journals a Runtime PATCH, fails closed, and idempotently reconciles after local persistence failure", async () => {
    const restoreEnv = enableRealRuntime();
    const previousFetch = globalThis.fetch;
    const store = app.locals.store;
    const restoreSave = failTwoLifecycleCompletionSaves(store);
    const runtimeAgent = {
      id: "legal_privacy_lora",
      title: "Runtime committed privacy agent",
      enabled: true,
      mounted: true
    };
    globalThis.fetch = async (url, options = {}) => {
      const pathName = new URL(url).pathname;
      if (pathName === "/agents/legal_privacy_lora" && options.method === "PATCH") {
        return Response.json({ ok: true, status: "updated", agent: runtimeAgent });
      }
      if (pathName === "/agents/legal_privacy_lora" && (!options.method || options.method === "GET")) {
        return Response.json({ ok: true, agent: runtimeAgent });
      }
      return Response.json({ detail: "not found" }, { status: 404 });
    };
    try {
      await request(app)
        .patch("/api/agents/legal_privacy_lora")
        .send({ title: runtimeAgent.title })
        .expect(500);
      const pending = store.read();
      expect(pending.runtimeLifecycleIntents).toHaveLength(1);
      expect(pending.runtimeLifecycleIntents[0].operation).toBe("agent.update");
      expect(pending.agents.find((agent) => agent.id === runtimeAgent.id)).toMatchObject({
        runtime_sync_pending: true
      });
      expect(scopedRoutingContext({
        session: { workspace_id: null, created_by: "admin" },
        agents: pending.agents,
        documents: pending.documents
      }).allowedAdapters).not.toContain(runtimeAgent.id);

      restoreSave();
      const reconciled = await request(app)
        .post("/api/admin/runtime-lifecycle/reconcile")
        .send({ intent_id: pending.runtimeLifecycleIntents[0].intent_id })
        .expect(200);
      expect(reconciled.body).toMatchObject({ attempted: 1, reconciled: 1, pending: 0 });
      expect(store.read().runtimeLifecycleIntents).toEqual([]);
      const reconciledAgent = store.read().agents.find((agent) => agent.id === runtimeAgent.id);
      expect(reconciledAgent.title).toBe(runtimeAgent.title);
      expect(reconciledAgent).not.toHaveProperty("runtime_sync_pending");
      const replay = await request(app)
        .post("/api/admin/runtime-lifecycle/reconcile")
        .send({})
        .expect(200);
      expect(replay.body).toMatchObject({ attempted: 0, reconciled: 0, pending: 0 });
    } finally {
      restoreSave();
      globalThis.fetch = previousFetch;
      restoreEnv();
    }
  });

  it("retries a journaled permanent deletion when the Runtime request initially fails", async () => {
    const restoreEnv = enableRealRuntime();
    const previousFetch = globalThis.fetch;
    const store = app.locals.store;
    const agentId = "recoverable_archived_delete_agent";
    const calls = [];
    let deleteAttempts = 0;
    await store.mutate((data) => {
      data.agents.push({
        id: agentId,
        title: "Recoverable archived delete agent",
        capability: "Tests permanent deletion recovery.",
        boundary: "Use only test input.",
        consumes: ["user_request"],
        produces: ["domain_outputs"],
        routing_cues: ["recovery"],
        resources: [],
        tools: [],
        sources: [],
        enabled: false,
        archived_at: new Date().toISOString(),
        visibility: "private",
        workspace_id: "workspace_default",
        created_by: "user_local"
      });
    });
    globalThis.fetch = async (url, options = {}) => {
      const pathName = new URL(url).pathname;
      const method = options.method || "GET";
      const body = options.body ? JSON.parse(options.body) : null;
      calls.push({ method, pathName, body });
      if (pathName === `/agents/${agentId}` && method === "DELETE") {
        deleteAttempts += 1;
        if (deleteAttempts === 1) throw new Error("temporary Runtime connection failure");
        return Response.json(ownedPurgeResponse(agentId));
      }
      if (pathName === `/agents/${agentId}` && method === "GET") {
        return Response.json({
          ok: true,
          agent: { id: agentId, enabled: false, mounted: false, lifecycle_status: "archived" }
        });
      }
      return Response.json({ detail: "not found" }, { status: 404 });
    };

    try {
      await request(app).delete(`/api/agents/${agentId}/permanent`).expect(500);
      const pending = store.read();
      expect(pending.runtimeLifecycleIntents).toHaveLength(1);
      expect(pending.runtimeLifecycleIntents[0]).toMatchObject({
        operation: "agent.delete",
        requested_by: "user_local",
        requested_role: "admin",
        workspace_id: "workspace_default"
      });
      expect(pending.agents.find((agent) => agent.id === agentId)).toMatchObject({
        runtime_sync_pending: true
      });

      const reconciled = await request(app)
        .post("/api/admin/runtime-lifecycle/reconcile")
        .send({ intent_id: pending.runtimeLifecycleIntents[0].intent_id })
        .expect(200);
      expect(reconciled.body).toMatchObject({ attempted: 1, reconciled: 1, pending: 0 });
      expect(store.read().agents.some((agent) => agent.id === agentId)).toBe(false);
      expect(store.read().runtimeLifecycleIntents).toEqual([]);
      expect(calls.map((call) => `${call.method} ${call.pathName}`)).toEqual([
        `DELETE /agents/${agentId}`,
        `GET /agents/${agentId}`,
        `DELETE /agents/${agentId}`
      ]);
      expect(calls[0].body.delete_archived).toBe(true);
      expect(calls[2].body).toMatchObject({
        delete_archived: true,
        audit_context: {
          user_id: "user_local",
          workspace_id: "workspace_default",
          role: "admin"
        }
      });
      const deletionEvent = store.read().agentEvents.find((event) =>
        event.agent_id === agentId && event.event_type === "agent.deleted"
      );
      expect(deletionEvent.actor_id).toBe("user_local");
      expect(deletionEvent.actor_role).toBe("admin");
    } finally {
      globalThis.fetch = previousFetch;
      restoreEnv();
    }
  });

  it("releases a lifecycle intent after an unambiguous Runtime PATCH rejection", async () => {
    const restoreEnv = enableRealRuntime();
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (url, options = {}) => {
      const pathName = new URL(url).pathname;
      if (pathName === "/agents/legal_privacy_lora" && options.method === "PATCH") {
        return Response.json({ detail: "boundary rejected by Runtime policy" }, { status: 409 });
      }
      return Response.json({ detail: "not found" }, { status: 404 });
    };
    try {
      await request(app)
        .patch("/api/agents/legal_privacy_lora")
        .send({ boundary: "A rejected boundary must not leave a permanent intent." })
        .expect(409);
      const data = app.locals.store.read();
      expect(data.runtimeLifecycleIntents).toEqual([]);
      expect(data.agents.find((agent) => agent.id === "legal_privacy_lora"))
        .not.toHaveProperty("runtime_sync_pending");
    } finally {
      globalThis.fetch = previousFetch;
      restoreEnv();
    }
  });

  it.each([
    {
      name: "archive",
      method: "delete",
      route: "/api/agents/legal_privacy_lora",
      runtimePath: "/agents/legal_privacy_lora",
      runtimeMethod: "DELETE",
      operation: "agent.archive",
      runtime: { ok: true, status: "archived", mounted: false, requires_vllm_reload: false }
    }
  ])("leaves $name fail-closed and recoverable when the local lifecycle commit fails", async ({ method, route, runtimePath, runtimeMethod, operation, runtime }) => {
    const restoreEnv = enableRealRuntime();
    const previousFetch = globalThis.fetch;
    const store = app.locals.store;
    const restoreSave = failTwoLifecycleCompletionSaves(store);
    const runtimeAgent = {
      id: "legal_privacy_lora",
      title: "Legal & Privacy",
      enabled: operation !== "agent.archive",
      mounted: runtime.mounted
    };
    globalThis.fetch = async (url, options = {}) => {
      const pathName = new URL(url).pathname;
      if (pathName === runtimePath && options.method === runtimeMethod) {
        return Response.json({ ...runtime, agent: runtimeAgent });
      }
      if (pathName === "/agents/legal_privacy_lora" && (!options.method || options.method === "GET")) {
        return Response.json({ ok: true, agent: runtimeAgent });
      }
      return Response.json({ detail: "not found" }, { status: 404 });
    };
    try {
      await request(app)[method](route).send({}).expect(500);
      const pending = store.read();
      expect(pending.runtimeLifecycleIntents).toHaveLength(1);
      expect(pending.runtimeLifecycleIntents[0].operation).toBe(operation);
      expect(pending.agents.find((agent) => agent.id === runtimeAgent.id).runtime_sync_pending).toBe(true);
      restoreSave();
      await request(app).post("/api/admin/runtime-lifecycle/reconcile").send({}).expect(200);
      expect(store.read().runtimeLifecycleIntents).toEqual([]);
      expect(store.read().agents.find((agent) => agent.id === runtimeAgent.id)).toMatchObject({
        enabled: runtimeAgent.enabled,
        mounted: runtimeAgent.mounted
      });
    } finally {
      restoreSave();
      globalThis.fetch = previousFetch;
      restoreEnv();
    }
  });

  it("recovers a Runtime-purged document from a durable delete intent after local persistence failure", async () => {
    const created = await request(app)
      .post("/api/documents")
      .field("title", "Lifecycle delete recovery")
      .attach("file", Buffer.from("Durable delete intent source content."), "delete.txt")
      .expect(201);
    const restoreEnv = enableRealRuntime();
    const previousFetch = globalThis.fetch;
    const store = app.locals.store;
    const restoreSave = failTwoLifecycleCompletionSaves(store);
    globalThis.fetch = async (url, options = {}) => {
      const pathName = new URL(url).pathname;
      if (pathName === `/documents/${created.body.agent_id}` && options.method === "DELETE") {
        return Response.json(ownedPurgeResponse(created.body.agent_id));
      }
      if (pathName === `/agents/${created.body.agent_id}` && (!options.method || options.method === "GET")) {
        return Response.json({ detail: "not found" }, { status: 404 });
      }
      return Response.json({ detail: "not found" }, { status: 404 });
    };
    try {
      await request(app).delete(`/api/documents/${created.body.document_id}`).expect(500);
      const pending = store.read();
      expect(pending.runtimeLifecycleIntents).toHaveLength(1);
      expect(pending.runtimeLifecycleIntents[0].operation).toBe("document.delete");
      expect(pending.documents.find((document) => document.document_id === created.body.document_id)).toMatchObject({
        enabled: true,
        runtime_sync_pending: true
      });
      restoreSave();
      await request(app).post("/api/admin/runtime-lifecycle/reconcile").send({}).expect(200);
      const deleted = store.read().documents.find((document) => document.document_id === created.body.document_id);
      expect(deleted).toMatchObject({ enabled: false, chunks: [] });
      expect(deleted).not.toHaveProperty("runtime_sync_pending");
      expect(store.read().runtimeLifecycleIntents).toEqual([]);
    } finally {
      restoreSave();
      globalThis.fetch = previousFetch;
      restoreEnv();
    }
  });
});

function authoritativeRuntimeDocumentResponse(requestBody, {
  body,
  pageStart = null,
  pageEnd = null
}) {
  const slug = requestBody.id.replace(/_lora$/, "");
  const chunkId = `${slug}_0001`;
  const record = {
    chunk_id: chunkId,
    title: "Authoritative Runtime chunk",
    page_start: pageStart,
    page_end: pageEnd,
    tags: ["authoritative", "runtime"],
    path: `sources/tcar_documents/${slug}/chunks/${chunkId}.md`,
    summary: body,
    token_count_approx: body.split(/\s+/).length,
    content_digest: runtimeSha256(body),
    body
  };
  return {
    ok: true,
    status: "added",
    id: requestBody.id,
    result: {
      status: "added",
      id: requestBody.id,
      document_root: `sources/tcar_documents/${slug}`,
      index_path: `sources/tcar_documents/${slug}/index.jsonl`,
      chunks: 1,
      chunk_records: [record],
      source_digest: runtimeSha256(requestBody.text),
      corpus_revision: runtimeDocumentRevision([record]).replace(/^sha256:/, ""),
      index_digest: runtimeSha256(JSON.stringify(record)),
      mounted: true
    },
    agent: { id: requestBody.id, enabled: true, mounted: true },
    mounted: true,
    requires_vllm_reload: false
  };
}

function runtimeSha256(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function runtimeAuditDigest(value) {
  const canonical = (candidate) => {
    if (Array.isArray(candidate)) return candidate.map(canonical);
    if (!candidate || typeof candidate !== "object") return candidate;
    return Object.fromEntries(Object.keys(candidate).sort().map((key) => [key, canonical(candidate[key])]));
  };
  return crypto.createHash("sha256")
    .update("json\0", "utf8")
    .update(JSON.stringify(canonical(value)), "utf8")
    .digest("hex");
}

function runtimeAuditReceipt({
  receiptId,
  subjectType,
  subjectId,
  eventType,
  executionId = null,
  eventId = null,
  subjectSequence = 1,
  previousHash = "0".repeat(64),
  payload
}) {
  const payloadSha256 = runtimeAuditDigest(payload);
  const material = {
    created_at: "2026-07-10T12:00:00.000000Z",
    event_id: eventId,
    event_type: eventType,
    execution_id: executionId,
    payload_sha256: payloadSha256,
    previous_hash: previousHash,
    receipt_id: receiptId,
    schema_version: 1,
    subject_id: subjectId,
    subject_sequence: subjectSequence,
    subject_type: subjectType
  };
  return {
    receipt_id: receiptId,
    schema_version: 1,
    subject_type: subjectType,
    subject_id: subjectId,
    event_type: eventType,
    event_id: eventId,
    execution_id: executionId,
    subject_sequence: subjectSequence,
    created_at: material.created_at,
    previous_hash: previousHash,
    payload_sha256: payloadSha256,
    receipt_hash: runtimeAuditDigest(material),
    payload
  };
}

describe("Runtime audit proof proxy", () => {
  it("allows a same-workspace admin to verify locally bound execution and user-agent receipts", async () => {
    const previous = {
      APP_API_TOKENS_JSON: process.env.APP_API_TOKENS_JSON,
      TCAR_ENGINE_MODE: process.env.TCAR_ENGINE_MODE,
      TCAR_RUNTIME_API_URL: process.env.TCAR_RUNTIME_API_URL
    };
    const previousFetch = globalThis.fetch;
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "virenis-runtime-proof-"));
    const creatorToken = "runtime_proof_creator_token_0123456789";
    const adminToken = "runtime_proof_admin_token_012345678901";
    let proofApp;
    try {
      process.env.APP_API_TOKENS_JSON = JSON.stringify({
        [creatorToken]: { user_id: "creator", workspace_id: "workspace_proof", role: "user" },
        [adminToken]: { user_id: "resolver", workspace_id: "workspace_proof", role: "admin" }
      });
      process.env.TCAR_ENGINE_MODE = "real";
      process.env.TCAR_RUNTIME_API_URL = "http://gpu-runtime.internal:9000";
      const requestFingerprint = "a".repeat(64);
      const executionActor = runtimeAuditDigest(JSON.stringify({
        role: "user",
        user_id: "creator",
        workspace_id: "workspace_proof"
      }));
      const executionReceipt = runtimeAuditReceipt({
        receiptId: "ar_execution_proof",
        subjectType: "execution",
        subjectId: "workspace_proof",
        eventType: "execution.completed",
        executionId: "runtime_run_proof",
        payload: {
          actor_sha256: executionActor,
          request_sha256: requestFingerprint,
          status: "completed"
        }
      });
      const agentSpec = { id: "creator_agent_lora", capability: "Creator-owned proof", mounted: true };
      const agentPayload = {
        actor_sha256: "b".repeat(64),
        source_text_sha256: "c".repeat(64),
        agent_spec_sha256: runtimeAuditDigest(agentSpec),
        agent_revision: "d".repeat(64),
        adapter_content_digest: "e".repeat(64),
        manifest_contract_digest: "f".repeat(64),
        enabled: true,
        mounted: true,
        lifecycle_status: "active"
      };
      const currentRuntimeAgent = {
        id: "creator_agent_lora",
        revision_authority: "runtime",
        agent_revision: agentPayload.agent_revision,
        adapter_content_digest: agentPayload.adapter_content_digest,
        manifest_contract_digest: agentPayload.manifest_contract_digest,
        enabled: true,
        mounted: true,
        mount_pending: false,
        lifecycle_status: "active"
      };
      const agentReceipts = [];
      let previousAgentHash = "0".repeat(64);
      for (let index = 0; index < 1005; index += 1) {
        const receipt = runtimeAuditReceipt({
          receiptId: `ar_agent_proof_${index + 1}`,
          subjectType: "agent",
          subjectId: "creator_agent_lora",
          eventType: index === 0 ? "agent.registered" : "agent.reconciled",
          eventId: `agent-proof-event-${index + 1}`,
          subjectSequence: index + 1,
          previousHash: previousAgentHash,
          payload: index === 0
            ? agentPayload
            : {
              agent_revision: agentPayload.agent_revision,
              adapter_content_digest: agentPayload.adapter_content_digest,
              enabled: true,
              lifecycle_status: "active",
              manifest_contract_digest: agentPayload.manifest_contract_digest,
              manifest_revision: runtimeAuditDigest({ revision: index + 1 }),
              mounted: true
            }
        });
        agentReceipts.push(receipt);
        previousAgentHash = receipt.receipt_hash;
      }
      const agentReceipt = agentReceipts[0];
      const agentHead = agentReceipts.at(-1);
      const receiptPageRequests = [];
      globalThis.fetch = async (url) => {
        const parsed = new URL(url);
        if (parsed.pathname === "/audit/executions/runtime_run_proof") {
          return new Response(JSON.stringify({ ok: true, receipt: executionReceipt }), { status: 200 });
        }
        if (parsed.pathname === "/agents/creator_agent_lora") {
          return new Response(JSON.stringify({ ok: true, agent: currentRuntimeAgent }), { status: 200 });
        }
        if (parsed.pathname === "/audit/subjects/agent/creator_agent_lora/receipts") {
          const afterSequence = Number(parsed.searchParams.get("after_sequence"));
          const throughSequence = parsed.searchParams.has("through_sequence")
            ? Number(parsed.searchParams.get("through_sequence"))
            : agentReceipts.length;
          const limit = Number(parsed.searchParams.get("limit"));
          const receipts = agentReceipts
            .filter((receipt) => receipt.subject_sequence > afterSequence && receipt.subject_sequence <= throughSequence)
            .slice(0, limit);
          const lastSequence = receipts.at(-1)?.subject_sequence ?? afterSequence;
          const hasMore = receipts.length > 0 && lastSequence < throughSequence;
          receiptPageRequests.push({ afterSequence, throughSequence, limit });
          return new Response(JSON.stringify({
            ok: true,
            schema_version: 1,
            subject_type: "agent",
            subject_id: "creator_agent_lora",
            after_sequence: afterSequence,
            snapshot_sequence: throughSequence,
            snapshot_head_hash: agentReceipts[throughSequence - 1]?.receipt_hash ?? "0".repeat(64),
            has_more: hasMore,
            next_after_sequence: hasMore ? lastSequence : null,
            receipts
          }), { status: 200 });
        }
        if (parsed.pathname === "/audit/subjects/execution/workspace_proof/verify") {
          return new Response(JSON.stringify({
            ok: true,
            subject_type: "execution",
            subject_id: "workspace_proof",
            receipts: 1,
            head_hash: executionReceipt.receipt_hash
          }), { status: 200 });
        }
        if (parsed.pathname === "/audit/subjects/agent/creator_agent_lora/verify") {
          const throughSequence = Number(parsed.searchParams.get("through_sequence"));
          return new Response(JSON.stringify({
            ok: true,
            subject_type: "agent",
            subject_id: "creator_agent_lora",
            receipts: throughSequence,
            through_sequence: throughSequence,
            head_hash: agentReceipts[throughSequence - 1]?.receipt_hash ?? "0".repeat(64)
          }), { status: 200 });
        }
        return new Response(JSON.stringify({ detail: "not found" }), { status: 404 });
      };
      proofApp = await createApp({ dbPath: path.join(tmp, "db.json"), uploadRoot: tmp });
      await proofApp.locals.store.mutate((data) => {
        data.executionRecords.push({
          execution_id: "local_execution_proof",
          run_id: "runtime_run_proof",
          runtime_execution_id: "runtime_run_proof",
          runtime_record_hash: `sha256:${executionReceipt.receipt_hash}`,
          runtime_request_fingerprint: `sha256:${requestFingerprint}`,
          workspace_id: "workspace_proof",
          created_by: "creator",
          actor_role: "user",
          visibility: "private",
          participants: []
        });
        data.agents.push({
          id: "creator_agent_lora",
          workspace_id: "workspace_proof",
          created_by: "creator",
          visibility: "private",
          runtime_registration_audit_binding: {
            receipt_id: agentReceipt.receipt_id,
            receipt_hash: agentReceipt.receipt_hash,
            payload_sha256: agentReceipt.payload_sha256,
            actor_sha256: agentPayload.actor_sha256,
            source_text_sha256: agentPayload.source_text_sha256,
            agent_spec_sha256: agentPayload.agent_spec_sha256,
            agent_revision: agentPayload.agent_revision,
            adapter_content_digest: agentPayload.adapter_content_digest,
            manifest_contract_digest: agentPayload.manifest_contract_digest,
            event_type: agentReceipt.event_type,
            subject_sequence: 1
          },
          runtime_registration_agent_spec: agentSpec
        });
        return true;
      });

      await request(proofApp)
        .get("/api/admin/executions/local_execution_proof/runtime-proof")
        .set("Authorization", `Bearer ${creatorToken}`)
        .expect(403);
      const executionProof = await request(proofApp)
        .get("/api/admin/executions/local_execution_proof/runtime-proof")
        .set("Authorization", `Bearer ${adminToken}`)
        .expect(200);
      expect(executionProof.body.binding_valid).toBe(true);
      expect(executionProof.body.receipt.receipt_hash).toBe(executionReceipt.receipt_hash);

      const agentProof = await request(proofApp)
        .get("/api/admin/agents/creator_agent_lora/runtime-audit")
        .set("Authorization", `Bearer ${adminToken}`)
        .expect(200);
      expect(agentProof.body.binding_valid).toBe(true);
      expect(agentProof.body.registration_receipt.receipt_hash).toBe(agentReceipt.receipt_hash);
      expect(agentProof.body.receipts).toHaveLength(1005);
      expect(agentProof.body.subject_chain.head_hash).toBe(agentHead.receipt_hash);
      expect(receiptPageRequests).toEqual([
        { afterSequence: 0, throughSequence: 1005, limit: 1000 },
        { afterSequence: 1000, throughSequence: 1005, limit: 1000 }
      ]);
      expect(JSON.stringify(agentProof.body)).not.toContain("registration_id");
    } finally {
      await proofApp?.locals?.store?.close?.();
      globalThis.fetch = previousFetch;
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await fs.rm(tmp, { recursive: true, force: true });
    }
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

  it("never exposes provider reasoning or internal synthesis narration as the chat answer", () => {
    const poem = "The Weight of Silence\n\nAt dusk the empty doorway keeps your name.";
    const critique = "The restrained imagery creates a coherent elegiac atmosphere.";
    const fallback = `### Poem\n\n${poem}\n\n### Critique\n\n${critique}`;

    expect(sanitizeRuntimeFinalAnswer({
      finalAnswer: "<think>private scratch without a completed public answer",
      fallbackFinalAnswer: fallback
    })).toBe(fallback);

    expect(sanitizeRuntimeFinalAnswer({
      finalAnswer: "AGENT_REASONING:\nPrivate rationale.\nDOMAIN_ANSWER:\nPublic answer only.\nHANDOFFS:\nInternal.",
      fallbackFinalAnswer: fallback
    })).toBe("Public answer only.");

    expect(sanitizeRuntimeFinalAnswer({
      finalAnswer: "The provided validated route results contain only the critique (Step s2). Step s1 was omitted due to budget constraints.",
      fallbackFinalAnswer: fallback
    })).toBe(fallback);
  });
});

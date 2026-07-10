import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../server/app.js";
import { requireRuntimeConfigured, setRuntimeFetchForTests } from "../server/runtimeClient.js";
import { buildParallelBatches, enrichRuntimeRoutingTrace, normalizeSharedMemory, sanitizeToolCalls, scopedRoutingContext } from "../server/tcarEngine.js";
import { chunkDocument, runtimeDocumentRevision } from "../server/documents.js";

let tmpDir;
let app;
let previousStoreDriver;
const resetRuntimeFetchTransport = setRuntimeFetchForTests((...args) => globalThis.fetch(...args));

afterAll(() => resetRuntimeFetchTransport());

beforeEach(async () => {
  previousStoreDriver = process.env.WEB_STORE_DRIVER;
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

    expect(context.allowedAdapters).toEqual(["active_lora", "legacy_active_lora"]);
    expect(context.agents.map((agent) => agent.id)).toEqual(["active_lora", "legacy_active_lora"]);
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
      TCAR_ALLOW_SAME_ORIGIN_RUNTIME_URL: process.env.TCAR_ALLOW_SAME_ORIGIN_RUNTIME_URL,
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
      delete process.env.TCAR_ALLOW_SAME_ORIGIN_RUNTIME_URL;
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

      process.env.APP_PUBLIC_ORIGIN = "http://app.prod.test";
      expect(() => requireRuntimeConfigured()).toThrow(/https/);

      process.env.APP_PUBLIC_ORIGIN = "https://app.prod.test";
      process.env.TCAR_RUNTIME_API_URL = "http://127.0.0.1:9000";
      expect(() => requireRuntimeConfigured()).toThrow(/private GPU runtime host/);

      process.env.TCAR_ALLOW_LOCAL_RUNTIME_URL = "1";
      expect(() => requireRuntimeConfigured()).not.toThrow();

      delete process.env.TCAR_ALLOW_LOCAL_RUNTIME_URL;
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
      expect(userHealth.body.manifest.adapters).toBe(18);
      expect(userHealth.body.manifest.path).toBeUndefined();
      expect(userHealth.body.vllm.base_model).toBe("qwen36-awq");
      expect(userHealth.body.vllm.base_url).toBeUndefined();
      expect(userHealth.body.vllm.health).toEqual({ ok: true, status: 200 });
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
    expect(health.body.manifest.adapters).toBeGreaterThanOrEqual(17);
    expect(health.body.vllm.mode).toContain("simulator");

    const models = await request(app).get("/api/runtime/models").expect(200);
    expect(models.body.models.some((model) => model.id === "qwen36-awq")).toBe(true);
    expect(models.body.models.some((model) => model.id === "legal_privacy_lora")).toBe(true);
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

      const edited = await request(realApp)
        .patch("/api/agents/legal_privacy_lora")
        .send({ boundary: "Route jurisdiction-specific legal questions to counsel.", routing_cues: "privacy, consent" })
        .expect(200);
      expect(edited.body.boundary).toContain("counsel");

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

  it("allows only an agent owner to retry a pending runtime mount", async () => {
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
        .expect(404);
      expect(calls).toHaveLength(0);

      const mounted = await request(realApp)
        .post("/api/agents/alice_pending_lora/mount")
        .set("Authorization", "Bearer token_alice")
        .send({})
        .expect(200);
      expect(mounted.body).toMatchObject({
        ok: true,
        status: "mounted",
        id: "alice_pending_lora",
        mounted: true,
        requires_vllm_reload: false,
        agent: {
          id: "alice_pending_lora",
          workspace_id: "workspace_a",
          visibility: "private",
          created_by: "alice",
          mounted: true,
          requires_vllm_reload: false
        }
      });
      expect(mounted.body.runtime).toBeUndefined();
      expect(mounted.body.agent.adapter_path).toBeUndefined();
      expect(calls).toEqual([{ method: "POST", pathName: "/agents/alice_pending_lora/mount" }]);

      const stored = realApp.locals.store.read().agents.find((agent) => agent.id === "alice_pending_lora");
      expect(stored).toMatchObject({
        workspace_id: "workspace_a",
        visibility: "private",
        created_by: "alice",
        mounted: true,
        requires_vllm_reload: false
      });
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
          id: "source_too_large_lora",
          title: "Source too large",
          capability: "Tests source size.",
          boundary: "Stay scoped.",
          sources: "sources/tcar_dummy_loras/source_too_large/source.md",
          source_text: "x".repeat(6)
        })
        .expect(413);

      process.env.TCAR_ENGINE_MODE = "real";
      await request(app)
        .patch("/api/agents/legal_privacy_lora")
        .send({
          sources: "sources/tcar_dummy_loras/legal_privacy/source.md",
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
      private_source_user: { user_id: "source_owner", workspace_id: "workspace_sources", role: "user" }
    });
    try {
      await request(app)
        .post("/api/agents")
        .set("Authorization", "Bearer private_source_user")
        .send({
          id: "cross_source_lora",
          title: "Cross source",
          capability: "Must not read another agent's source.",
          boundary: "Use owned sources only.",
          sources: "sources/tcar_dummy_loras/refund_policy/refund_policy.md"
        })
        .expect(403);

      await request(app)
        .post("/api/agents")
        .set("Authorization", "Bearer private_source_user")
        .send({
          id: "owned_source_lora",
          title: "Owned source",
          capability: "Uses private source text.",
          boundary: "Use owned sources only.",
          source_text: "Owner-specific operating rule."
        })
        .expect(201);
      const stored = app.locals.store.read().agents.find((agent) => agent.id === "owned_source_lora");
      expect(stored.sources).toEqual(["sources/tcar_dummy_loras/owned_source_lora/source.md"]);

      await request(app)
        .patch("/api/agents/owned_source_lora")
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

  it("keeps private sessions and document agents visible only to their owner or an admin", async () => {
    const previousTokens = process.env.APP_API_TOKENS_JSON;
    process.env.APP_API_TOKENS_JSON = JSON.stringify({
      token_alice: { user_id: "alice", workspace_id: "workspace_shared", role: "user" },
      token_bob: { user_id: "bob", workspace_id: "workspace_shared", role: "user" },
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
          id: "private_numbers_lora",
          title: "Private numbers",
          capability: "Applies the user's private number rules.",
          boundary: "Use only the configured number rules.",
          routing_cues: "unrelated-cue",
          produces: "number_result",
          source_text: "The private 2026 target is 42 units."
        })
        .expect(201);
      await app.locals.store.mutate((data) => {
        const agent = data.agents.find((item) => item.id === "private_numbers_lora");
        agent.mounted = true;
        agent.requires_vllm_reload = false;
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
      expect(run.plan.steps.map((step) => step.adapter)).toContain("private_numbers_lora");
      const route = run.expert_outputs.find((step) => step.adapter === "private_numbers_lora");
      expect(route.handoff_artifacts).toEqual([
        expect.objectContaining({
          artifact: "number_result",
          producer_agent_id: "private_numbers_lora"
        })
      ]);
      expect(route.handoff_artifacts[0].value).toContain("42 units");
      expect(route.domain_answer).toContain("42 units");
      expect(route.citations).toEqual([
        expect.objectContaining({ chunk_id: "private_numbers_lora_source_0001", verified: true })
      ]);
    } finally {
      if (previousTokens === undefined) {
        delete process.env.APP_API_TOKENS_JSON;
      } else {
        process.env.APP_API_TOKENS_JSON = previousTokens;
      }
    }
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
    const server = await new Promise((resolve) => {
      const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
    });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    try {
      const session = await fetch(`${baseUrl}/api/chat/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "SSE close" })
      }).then((response) => response.json());
      const queued = await fetch(`${baseUrl}/api/chat/sessions/${session.session_id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "Plan a secure support workflow." })
      }).then((response) => response.json());
      const stream = await fetch(`${baseUrl}/api/chat/runs/${queued.run_id}/events`);
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
        plan: { steps: [] },
        parallel: { workers: 1, batches: [], maxBatchWidth: 0, parallelizable: false },
        events: [
          {
            type: "route.completed",
            citations: [{ chunk_id: "c1", title: "Chunk", path: "sources/tcar_documents/private/chunks/c1.md" }],
            raw_text_admin_only: "hidden route text"
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
      const bodyPromise = stream.text();
      expect(app.locals.eventStreams.size).toBe(1);
      app.locals.closeEventStreams({ reason: "test" });
      const body = await bodyPromise;
      expect(body).toContain("run.failed");
      expect(body).toContain("The run failed before completion");
      expect(body).not.toContain("super-secret-value");
      expect(body).not.toContain("sources/tcar_documents");
      expect(body).not.toContain("raw_text_admin_only");
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

      const route = await request(app)
        .get(`/api/chat/runs/${queued.body.run_id}/routes/${run.expert_outputs[0].step_id}`)
        .set("Authorization", "Bearer token_route_user")
        .expect(200);
      expect(route.body.raw_text_admin_only).toBeUndefined();
      expect(route.body.prompt_preview_admin_only).toBeUndefined();

      const adminRoute = await request(app)
        .get(`/api/chat/runs/${queued.body.run_id}/routes/${run.expert_outputs[0].step_id}`)
        .set("Authorization", "Bearer token_route_admin")
        .expect(200);
      expect(adminRoute.body.raw_text_admin_only).toContain("AGENT_REASONING");
      expect(adminRoute.body.prompt_preview_admin_only).toContain("Adapter");
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
      expect(userRun.error.message).toBe("The run failed before completion. Try again or contact support with the run id.");
      expect(userRun.error_admin_only).toBeUndefined();
      expect(JSON.stringify(userRun)).not.toContain("super-secret-value");
      expect(userRun.events.find((event) => event.type === "run.failed").message).toBe(userRun.error.message);

      const adminRun = await request(realApp)
        .get(`/api/chat/runs/${queued.body.run_id}`)
        .set("Authorization", `Bearer ${tokenAdmin}`)
        .expect(200);
      expect(adminRun.body.error.message).toBe(userRun.error.message);
      expect(JSON.stringify(adminRun.body.error_admin_only)).toContain("super-secret-value");
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
              approved_sources: ["sources/tcar_dummy_loras/writing_synthesis/source.md"],
              citations: [
                {
                  chunk_id: "runtime_chunk_1",
                  title: "Runtime source",
                  path: "sources/tcar_dummy_loras/writing_synthesis/source.md",
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
      expect(chatBody.options.allowed_adapters).not.toContain("alice_private_manual_lora");
      expect(chatBody.options.max_tokens).toBe(512);
      expect(chatBody.options.refiner_max_tokens).toBe(768);
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
  }, 45000);
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
        if (pathName === "/documents/tampered_receipt_lora" && options.method === "DELETE") {
          return new Response(JSON.stringify({
            ok: true,
            status: "purged",
            purged: true,
            enabled: false,
            mounted: false,
            requires_vllm_reload: false,
            agent: { id: "tampered_receipt_lora", enabled: false, mounted: false }
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
        .field("agent_id", "tampered_receipt_lora")
        .attach("file", Buffer.from("Original source text with enough material for a local preflight chunk."), "tampered.txt")
        .expect(502);

      expect(upload.body.error).toBe("runtime_document_contract_invalid");
      expect(calls).toEqual([
        { method: "POST", pathName: "/documents" },
        { method: "DELETE", pathName: "/documents/tampered_receipt_lora" }
      ]);
      expect(app.locals.store.read().documents).toHaveLength(0);
      expect(app.locals.store.read().agents.some((agent) => agent.id === "tampered_receipt_lora")).toBe(false);
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
    expect(agentIds.every((id) => /^concurrent_manual_[a-f0-9]{8}_lora$/.test(id))).toBe(true);
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
      if (pathName === "/documents/atomic_document_save_lora" && options.method === "DELETE") {
        return Response.json(ownedPurgeResponse("atomic_document_save_lora"));
      }
      return Response.json({ detail: "not found" }, { status: 404 });
    };
    try {
      await request(app)
        .post("/api/documents")
        .field("title", "Atomic document save")
        .field("agent_id", "atomic_document_save_lora")
        .attach("file", Buffer.from("Uploaded document text for atomic rollback."), "atomic.txt")
        .expect(500);
      expect(app.locals.store.read().documents.some((document) => document.agent_id === "atomic_document_save_lora")).toBe(false);
      expect(app.locals.store.read().agents.some((agent) => agent.id === "atomic_document_save_lora")).toBe(false);
      const durable = JSON.parse(await fs.readFile(store.dbPath, "utf8"));
      expect(durable.documents.some((document) => document.agent_id === "atomic_document_save_lora")).toBe(false);
      expect(calls.map((call) => `${call.method} ${call.pathName}`)).toEqual([
        "POST /documents",
        "DELETE /documents/atomic_document_save_lora"
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
      if (pathName === "/documents/document_commit_timeout_lora" && options.method === "DELETE") {
        return Response.json(ownedPurgeResponse("document_commit_timeout_lora"));
      }
      return Response.json({ detail: "not found" }, { status: 404 });
    };
    const upload = () => request(app)
      .post("/api/documents")
      .field("title", "Document commit timeout")
      .field("agent_id", "document_commit_timeout_lora")
      .attach("file", Buffer.from("Document text for ambiguous commit cleanup."), "commit.txt");
    try {
      await upload().expect(500);
      expect(app.locals.store.read().documents.some((document) => document.agent_id === "document_commit_timeout_lora")).toBe(false);
      expect(calls.map((call) => `${call.method} ${call.pathName}`)).toEqual([
        "POST /documents",
        "DELETE /documents/document_commit_timeout_lora"
      ]);
      expect(calls[1].body.registration_id).toBe(registrationIds[0]);

      await upload().expect(201);
      expect(registrationIds[1]).not.toBe(registrationIds[0]);
      expect(app.locals.store.read().documents.some((document) => document.agent_id === "document_commit_timeout_lora")).toBe(true);
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
      name: "mount",
      method: "post",
      route: "/api/agents/legal_privacy_lora/mount",
      runtimePath: "/agents/legal_privacy_lora/mount",
      runtimeMethod: "POST",
      operation: "agent.mount",
      runtime: { ok: true, status: "mounted", mounted: true, requires_vllm_reload: false }
    },
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
});

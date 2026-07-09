import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../server/app.js";
import { requireRuntimeConfigured } from "../server/runtimeClient.js";
import { buildParallelBatches, normalizeSharedMemory, sanitizeToolCalls } from "../server/tcarEngine.js";

let tmpDir;
let app;
let previousStoreDriver;

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

  it("scopes chat sessions to bearer-token workspaces and protects admin agent writes", async () => {
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

      await request(app)
        .post("/api/agents")
        .set("Authorization", "Bearer token_a")
        .send({
          id: "tenant_blocked_lora",
          title: "Blocked",
          capability: "Blocked",
          boundary: "Blocked"
        })
        .expect(403);

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
              edges: []
            },
            parallel: { workers: 1, batches: [{ batch: 1, width: 1, workers: 1, steps: ["s1"] }], maxBatchWidth: 1, parallelizable: false },
            expertOutputs: [],
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
        .send({ content: "Use Alice private manual if available." })
        .expect(202);

      for (let attempt = 0; attempt < 200; attempt += 1) {
        const response = await request(realApp)
          .get(`/api/chat/runs/${queued.body.run_id}`)
          .set("Authorization", `Bearer ${tokenBob}`)
          .expect(200);
        if (response.body.status === "completed") {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      expect(chatBody.options.allowed_adapters).toContain("writing_synthesis_lora");
      expect(chatBody.options.allowed_adapters).not.toContain("alice_private_manual_lora");
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
  }, 30000);
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

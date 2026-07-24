import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../server/app.js";

const TOKENS = {
  admin: { user_id: "admin", workspace_id: "workspace_admin", role: "admin" },
  user: { user_id: "user", workspace_id: "workspace_admin", role: "user" }
};

let app;
let tmpDir;
let previousEnvironment;

function auth(name) {
  return { Authorization: `Bearer ${name}` };
}

beforeEach(async () => {
  previousEnvironment = {
    WEB_STORE_DRIVER: process.env.WEB_STORE_DRIVER,
    APP_API_TOKENS_JSON: process.env.APP_API_TOKENS_JSON,
    APP_PUBLIC_ORIGIN: process.env.APP_PUBLIC_ORIGIN
  };
  process.env.WEB_STORE_DRIVER = "json";
  process.env.APP_API_TOKENS_JSON = JSON.stringify(TOKENS);
  process.env.APP_PUBLIC_ORIGIN = "https://virenis.example";
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "virenis-admin-runtime-"));
  app = await createApp({
    dbPath: path.join(tmpDir, "db.json"),
    uploadRoot: tmpDir,
    autoRun: false
  });
});

afterEach(async () => {
  await app?.locals?.store?.close?.();
  for (const [key, value] of Object.entries(previousEnvironment || {})) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("admin Runtime and MCP settings", () => {
  it("keeps Qwen as the default and persists a global provider without exposing its token", async () => {
    const initial = await request(app)
      .get("/api/admin/runtime-model")
      .set(auth("admin"))
      .expect(200);
    expect(initial.body.settings).toMatchObject({
      provider: "vllm",
      model: "qwen36-awq",
      api_key_configured: false
    });

    const updated = await request(app)
      .patch("/api/admin/runtime-model")
      .set(auth("admin"))
      .send({
        provider: "openai_compatible",
        base_url: "https://models.example/v1",
        model: "future-model",
        revision: "deployment-7",
        context_tokens: 65536,
        api_key: "secret-model-token"
      })
      .expect(200);
    expect(updated.body.applied_immediately).toBe(false);
    expect(updated.body.settings).toMatchObject({
      provider: "openai_compatible",
      base_url: "https://models.example/v1",
      model: "future-model",
      revision: "deployment-7",
      context_tokens: 65536,
      api_key_configured: true
    });
    expect(JSON.stringify(updated.body)).not.toContain("secret-model-token");
    expect(JSON.stringify(app.locals.store.read().runtimeModelSettings)).not.toContain("secret-model-token");

    const userModels = await request(app).get("/api/runtime/models").set(auth("user")).expect(200);
    expect(userModels.body.models).toEqual([{ id: "future-model", type: "base" }]);

    await request(app).get("/api/admin/runtime-model").set(auth("user")).expect(403);
  });

  it("makes an encrypted admin OAuth configuration available as an MCP app plugin", async () => {
    const updated = await request(app)
      .patch("/api/admin/mcp-providers/google")
      .set(auth("admin"))
      .send({ client_id: "google-client-id", client_secret: "google-client-secret" })
      .expect(200);
    expect(updated.body.provider).toMatchObject({
      id: "google",
      client_id: "google-client-id",
      client_secret_configured: true
    });
    expect(JSON.stringify(updated.body)).not.toContain("google-client-secret");
    expect(JSON.stringify(app.locals.store.read().mcpAdminProviders)).not.toContain("google-client-secret");

    const templates = await request(app).get("/api/mcp/templates").set(auth("user")).expect(200);
    expect(templates.body.templates.find((item) => item.id === "gmail")).toMatchObject({
      availability: "available",
      setup_mode: "administrator"
    });
  });
});

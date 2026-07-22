import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../server/app.js";

const TOKENS = {
  admin_token: { user_id: "admin", workspace_id: "tool_config_workspace", role: "admin" },
  user_token: { user_id: "user", workspace_id: "tool_config_workspace", role: "user" }
};

let app;
let tmpDir;
let previousEnvironment;

function authorization(token) {
  return `Bearer ${token}`;
}

function agentPayload(overrides = {}) {
  return {
    id: "repository_reviewer",
    title: "Repository reviewer",
    capability: "Inspect files under approved repository roots and explain defects.",
    boundary: "Read only. Do not modify files.",
    consumes: ["user_request"],
    produces: ["recommendations"],
    routing_cues: ["repository review"],
    tools: ["repo_inspector"],
    tool_config: { repo_inspector: { roots: ["."] } },
    ...overrides
  };
}

beforeEach(async () => {
  previousEnvironment = {
    APP_API_TOKENS_JSON: process.env.APP_API_TOKENS_JSON,
    AGENT_RUNTIME_MODE: process.env.AGENT_RUNTIME_MODE,
    WEB_STORE_DRIVER: process.env.WEB_STORE_DRIVER
  };
  process.env.APP_API_TOKENS_JSON = JSON.stringify(TOKENS);
  process.env.AGENT_RUNTIME_MODE = "mock";
  process.env.WEB_STORE_DRIVER = "json";
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "virenis-agent-tool-config-"));
  app = await createApp({
    dbPath: path.join(tmpDir, "db.json"),
    uploadRoot: path.join(tmpDir, "uploads"),
    autoRun: false
  });
});

afterEach(async () => {
  await app?.locals?.drainBackgroundTasks?.({ timeoutMs: 5000 });
  await app?.locals?.store?.close?.();
  for (const [key, value] of Object.entries(previousEnvironment || {})) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("agent Runtime tool configuration", () => {
  it("persists administrator-approved repository roots and redacts them from ordinary users", async () => {
    await request(app)
      .post("/api/agents")
      .set("Authorization", authorization("admin_token"))
      .send(agentPayload())
      .expect(201);

    const adminAgents = await request(app)
      .get("/api/agents")
      .set("Authorization", authorization("admin_token"))
      .expect(200);
    const adminAgent = adminAgents.body.agents.find((agent) => agent.id === "repository_reviewer");
    expect(adminAgent.tool_config).toEqual({ repo_inspector: { roots: ["."] } });

    const userAgents = await request(app)
      .get("/api/agents")
      .set("Authorization", authorization("user_token"))
      .expect(200);
    const userAgent = userAgents.body.agents.find((agent) => agent.id === "repository_reviewer");
    expect(userAgent).toBeTruthy();
    expect(userAgent).not.toHaveProperty("tool_config");
  });

  it("rejects unapproved, missing, and unsafe repository configuration", async () => {
    await request(app)
      .post("/api/agents")
      .set("Authorization", authorization("user_token"))
      .send(agentPayload({ id: "ordinary_repo_agent" }))
      .expect(403);

    const missing = await request(app)
      .post("/api/agents")
      .set("Authorization", authorization("admin_token"))
      .send(agentPayload({ id: "missing_repo_config", tool_config: undefined }))
      .expect(400);
    expect(missing.body.message).toMatch(/approved Runtime repository root/i);

    const unsafe = await request(app)
      .post("/api/agents")
      .set("Authorization", authorization("admin_token"))
      .send(agentPayload({
        id: "unsafe_repo_config",
        tool_config: { repo_inspector: { roots: ["/etc"] } }
      }))
      .expect(400);
    expect(unsafe.body.message).toMatch(/relative to the Runtime project root/i);

    const unrelated = await request(app)
      .post("/api/agents")
      .set("Authorization", authorization("admin_token"))
      .send(agentPayload({
        id: "unrelated_repo_config",
        tools: ["calculator"]
      }))
      .expect(400);
    expect(unrelated.body.message).toMatch(/enabled agent ability/i);
  });

  it("clears repository configuration when the ability is removed", async () => {
    await request(app)
      .post("/api/agents")
      .set("Authorization", authorization("admin_token"))
      .send(agentPayload())
      .expect(201);

    const updated = await request(app)
      .patch("/api/agents/repository_reviewer")
      .set("Authorization", authorization("admin_token"))
      .send({ tools: ["calculator"] })
      .expect(200);
    expect(updated.body.tools).toEqual(["calculator"]);
    expect(updated.body.tool_config).toEqual({});
  });

  it("publishes and copies a safe snapshot without local repository access", async () => {
    await request(app)
      .post("/api/agents")
      .set("Authorization", authorization("admin_token"))
      .send(agentPayload())
      .expect(201);

    const published = await request(app)
      .post("/api/marketplace/items/repository_reviewer")
      .set("Authorization", authorization("admin_token"))
      .send({ description: "A read-only code review specialist." })
      .expect(201);

    const detail = await request(app)
      .get("/api/marketplace/items/repository_reviewer")
      .set("Authorization", authorization("user_token"))
      .expect(200);
    expect(detail.body.agent.tools).not.toContain("repo_inspector");
    expect(detail.body.agent).not.toHaveProperty("tool_config");
    expect(detail.body.agent.exclusions.repository_access).toBe(true);

    const copied = await request(app)
      .post("/api/marketplace/items/repository_reviewer/copy")
      .set("Authorization", authorization("user_token"))
      .set("Idempotency-Key", "repository-marketplace-copy-0001")
      .send({ listing_id: published.body.listing_id })
      .expect(201);
    expect(copied.body.agent.tools).not.toContain("repo_inspector");
    expect(copied.body.agent).not.toHaveProperty("tool_config");

    const storedCopy = app.locals.store.read().agents.find((agent) => agent.id === copied.body.agent.id);
    expect(storedCopy.tools).not.toContain("repo_inspector");
    expect(storedCopy.tool_config || {}).toEqual({});
  });
});

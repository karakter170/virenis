import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../server/app.js";

const TOKENS = {
  adminA: "output_admin_a_token_0123456789",
  userA: "output_user_a_token_01234567890",
  adminB: "output_admin_b_token_0123456789"
};
const authorization = (token) => ({ Authorization: `Bearer ${token}` });
const ENV_NAMES = [
  "APP_API_TOKENS_JSON",
  "WEB_STORE_DRIVER",
  "TCAR_MAX_TOKENS",
  "TCAR_REFINER_MAX_TOKENS",
  "TCAR_CLIENT_MAX_TOKENS",
  "TCAR_CLIENT_MAX_REFINER_TOKENS",
  "TCAR_MODEL_CONTEXT_TOKENS",
  "ROUTER_SESSION_CONTEXT_TOKENS",
  "TCAR_ROUTE_MIN_INPUT_TOKENS",
  "TCAR_REFINER_MIN_INPUT_TOKENS",
  "TCAR_ROUTE_TOKEN_SAFETY_MARGIN",
  "TCAR_COMPLETION_TOKEN_SAFETY_MARGIN"
];

let app;
let tmpDir;
let previous;

beforeEach(async () => {
  previous = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
  process.env.WEB_STORE_DRIVER = "json";
  for (const name of ENV_NAMES.slice(2)) delete process.env[name];
  process.env.APP_API_TOKENS_JSON = JSON.stringify({
    [TOKENS.adminA]: { user_id: "admin_a", workspace_id: "workspace_a", role: "admin" },
    [TOKENS.userA]: { user_id: "user_a", workspace_id: "workspace_a", role: "user" },
    [TOKENS.adminB]: { user_id: "admin_b", workspace_id: "workspace_b", role: "admin" }
  });
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "virenis-output-settings-"));
  app = await createApp({ dbPath: path.join(tmpDir, "db.json"), uploadRoot: tmpDir, autoRun: false });
});

afterEach(async () => {
  await app?.locals?.store?.close?.();
  for (const [name, value] of Object.entries(previous || {})) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("administrator model output settings API", () => {
  it("is admin-only, workspace-scoped, audited, and applied as the run ceiling", async () => {
    await request(app)
      .get("/api/admin/model-output-settings")
      .set(authorization(TOKENS.userA))
      .expect(403);

    const defaults = await request(app)
      .get("/api/admin/model-output-settings")
      .set(authorization(TOKENS.adminA))
      .expect(200);
    expect(defaults.body.settings).toMatchObject({
      workspace_id: "workspace_a",
      agent_output_tokens: 4096,
      final_output_tokens: 8192,
      revision: 0
    });

    const updated = await request(app)
      .patch("/api/admin/model-output-settings")
      .set(authorization(TOKENS.adminA))
      .send({
        agent_output_tokens: 6144,
        final_output_tokens: 10240,
        reason: "More complete workspace answers"
      })
      .expect(200);
    expect(updated.body.settings).toMatchObject({
      workspace_id: "workspace_a",
      agent_output_tokens: 6144,
      final_output_tokens: 10240,
      revision: 1,
      updated_by: "admin_a"
    });

    const otherWorkspace = await request(app)
      .get("/api/admin/model-output-settings")
      .set(authorization(TOKENS.adminB))
      .expect(200);
    expect(otherWorkspace.body.settings).toMatchObject({
      workspace_id: "workspace_b",
      agent_output_tokens: 4096,
      final_output_tokens: 8192,
      revision: 0
    });

    const session = await request(app)
      .post("/api/chat/sessions")
      .set(authorization(TOKENS.userA))
      .send({ title: "Detailed output" })
      .expect(201);
    const queued = await request(app)
      .post(`/api/chat/sessions/${session.body.session_id}/messages`)
      .set(authorization(TOKENS.userA))
      .send({
        content: "Explain the topic in depth.",
        options: { max_tokens: 99999, refiner_max_tokens: 99999 }
      })
      .expect(202);
    const storedRun = app.locals.store.read((data) => data.runs.find((run) => run.run_id === queued.body.run_id));
    expect(storedRun.execution_options).toMatchObject({
      max_tokens: 6144,
      refiner_max_tokens: 10240
    });
    expect(app.locals.store.read().identityAuditEvents).toContainEqual(expect.objectContaining({
      type: "model_output_settings.updated",
      workspace_id: "workspace_a",
      actor_user_id: "admin_a",
      revision: 1
    }));
  });

  it("rejects invalid values without changing the active revision", async () => {
    await request(app)
      .patch("/api/admin/model-output-settings")
      .set(authorization(TOKENS.adminA))
      .send({ agent_output_tokens: 127, final_output_tokens: 8192, reason: "Too low" })
      .expect(400);
    const unsafeContextSplit = await request(app)
      .patch("/api/admin/model-output-settings")
      .set(authorization(TOKENS.adminA))
      .send({ agent_output_tokens: 4096, final_output_tokens: 13000, reason: "Exceeds the configured output ceiling" })
      .expect(400);
    expect(unsafeContextSplit.body).toMatchObject({ error: "invalid_model_output_settings" });
    expect(unsafeContextSplit.body.message).toMatch(/final_output_tokens/i);
    const unchanged = await request(app)
      .get("/api/admin/model-output-settings")
      .set(authorization(TOKENS.adminA))
      .expect(200);
    expect(unchanged.body.settings.revision).toBe(0);
  });
});

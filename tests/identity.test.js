import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { buildPublishableKey } from "@clerk/shared/keys";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../server/app.js";
import {
  clerkAuthorizedParties,
  requireAuthorizedClerkBrowserOrigin,
  validateClerkEnvironment
} from "../server/clerkIdentity.js";
import { attestMcpOAuthRevocationResolved } from "../server/mcp.js";
import { setRuntimeFetchForTests } from "../server/runtimeClient.js";
import { makeId } from "../server/store.js";

const ENV_KEYS = [
  "APP_IDENTITY_PROVIDER",
  "APP_AUTH_ADMIN_EMAILS",
  "APP_CLERK_ADMIN_USER_IDS",
  "APP_API_TOKENS_JSON",
  "APP_API_TOKENS",
  "APP_BASIC_AUTH_USER",
  "APP_BASIC_AUTH_PASSWORD",
  "APP_PUBLIC_ORIGIN",
  "CLERK_AUTHORIZED_PARTIES",
  "APP_ACCOUNT_DELETION_DRAIN_TIMEOUT_MS",
  "APP_SSE_MAX_STREAMS_GLOBAL",
  "APP_SSE_MAX_STREAMS_PER_IDENTITY",
  "APP_SSE_HEARTBEAT_MS",
  "APP_SSE_MAX_LIFETIME_MS",
  "PORT",
  "WEB_STORE_DRIVER",
  "TCAR_ENGINE_MODE",
  "TCAR_RUNTIME_API_URL",
  "TCAR_RUNTIME_API_KEY"
];

let previousEnv;
let tmpDir;
let app;
let fake;

beforeEach(async () => {
  previousEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.APP_IDENTITY_PROVIDER = "clerk";
  process.env.WEB_STORE_DRIVER = "json";
  process.env.TCAR_ENGINE_MODE = "simulator";
  for (const key of [
    "APP_AUTH_ADMIN_EMAILS",
    "APP_CLERK_ADMIN_USER_IDS",
    "APP_API_TOKENS_JSON",
    "APP_API_TOKENS",
    "APP_BASIC_AUTH_USER",
    "APP_BASIC_AUTH_PASSWORD",
    "APP_PUBLIC_ORIGIN",
    "CLERK_AUTHORIZED_PARTIES",
    "APP_ACCOUNT_DELETION_DRAIN_TIMEOUT_MS",
    "APP_SSE_MAX_STREAMS_GLOBAL",
    "APP_SSE_MAX_STREAMS_PER_IDENTITY",
    "APP_SSE_HEARTBEAT_MS",
    "APP_SSE_MAX_LIFETIME_MS",
    "PORT",
    "TCAR_RUNTIME_API_URL",
    "TCAR_RUNTIME_API_KEY"
  ]) delete process.env[key];
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "virenis-clerk-"));
  fake = createFakeClerk();
});

afterEach(async () => {
  await app?.locals?.store?.close?.();
  app = null;
  for (const [key, value] of Object.entries(previousEnv || {})) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function startApp(adapter = fake.adapter, options = {}) {
  app = await createApp({
    dbPath: path.join(tmpDir, "db.json"),
    uploadRoot: path.join(tmpDir, "uploads"),
    autoRun: false,
    clerkAdapter: adapter,
    ...options
  });
  return app;
}

function asUser(userId, sessionId = `sess_${userId}`) {
  return {
    "x-test-clerk-user-id": userId,
    "x-test-clerk-session-id": sessionId,
    Origin: "http://localhost:5173"
  };
}

describe("Clerk identity integration", () => {
  it("generates full 128-bit application and agent-workspace identifiers", async () => {
    const generated = new Set(Array.from({ length: 128 }, () => makeId("proof")));
    expect(generated).toHaveLength(128);
    for (const id of generated) expect(id).toMatch(/^proof_[0-9a-f]{32}$/);

    fake.addUser({ id: "user_uuidproof01", email: "uuid-proof@example.com", name: "UUID Proof" });
    await startApp();
    const headers = asUser("user_uuidproof01");
    const identity = await request(app).get("/api/auth/me").set(headers).expect(200);
    expect(identity.body.workspace_id).toMatch(/^workspace_[0-9a-f]{32}$/);
    const workspaces = await request(app).get("/api/agent-workspaces").set(headers).expect(200);
    expect(workspaces.body.workspaces[0].agent_workspace_id).toMatch(/^aw_[0-9a-f]{32}$/);
  });

  it("authorizes both loopback browser addresses on the configured development port", () => {
    expect(clerkAuthorizedParties({ NODE_ENV: "development", PORT: "5181" })).toEqual([
      "http://localhost:5181",
      "http://127.0.0.1:5181"
    ]);
  });

  it("fails an origin preflight when the browser address is not an authorized Clerk party", () => {
    const env = {
      NODE_ENV: "development",
      PORT: "5173",
      APP_PUBLIC_ORIGIN: "http://localhost:5173"
    };
    expect(requireAuthorizedClerkBrowserOrigin("http://localhost:5173", env)).toBe("http://localhost:5173");
    expect(() => requireAuthorizedClerkBrowserOrigin("https://preview.example.test", env))
      .toThrow(/Clerk will reject sessions/);
  });

  it("returns the safe configured origin when Clerk rejects a token's authorized party", async () => {
    process.env.APP_PUBLIC_ORIGIN = "https://app.example.test";
    const rejectingAdapter = {
      ...fake.adapter,
      middleware(req, res, next) {
        res.setHeader("x-clerk-auth-reason", "token-invalid-authorized-parties");
        fake.adapter.middleware(req, res, next);
      }
    };
    await startApp(rejectingAdapter);
    const response = await request(app).get("/api/auth/me").expect(401);
    expect(response.body).toMatchObject({
      error: "authentication_required",
      details: {
        auth_reason: "token-invalid-authorized-parties",
        configured_origin: "https://app.example.test"
      }
    });
  });

  it("links a legacy profile without changing its workspace and scrubs retired credentials", async () => {
    process.env.APP_AUTH_ADMIN_EMAILS = "legacy@example.com";
    await fs.writeFile(path.join(tmpDir, "db.json"), JSON.stringify({
      version: 8,
      users: [{
        user_id: "legacy_user",
        workspace_id: "workspace_legacy",
        email: "legacy@example.com",
        email_normalized: "legacy@example.com",
        display_name: "Legacy",
        role: "user",
        status: "active",
        password_hash: "retired-password-hash",
        failed_login_count: 3
      }],
      authSessions: [{ session_id: "retired-session", token_hash: "retired-token" }],
      emailVerificationTokens: [{ token_hash: "retired-verification" }],
      passwordResetTokens: [{ token_hash: "retired-reset" }]
    }), "utf8");
    fake.addUser({ id: "user_legacy0001", email: "legacy@example.com", name: "Legacy Clerk" });
    await startApp();

    const me = await request(app).get("/api/auth/me").set(asUser("user_legacy0001")).expect(200);
    expect(me.body).toMatchObject({
      user_id: "legacy_user",
      workspace_id: "workspace_legacy",
      clerk_user_id: "user_legacy0001",
      display_name: "Legacy Clerk",
      role: "admin"
    });
    const persisted = app.locals.store.read();
    expect(persisted).not.toHaveProperty("authSessions");
    expect(persisted).not.toHaveProperty("emailVerificationTokens");
    expect(persisted).not.toHaveProperty("passwordResetTokens");
    expect(persisted.users[0]).not.toHaveProperty("password_hash");
    expect(persisted.users[0]).not.toHaveProperty("failed_login_count");
  });

  it("provisions stable private workspaces and isolates users", async () => {
    fake.addUser({ id: "user_alice0001", email: "alice@example.com", name: "Alice" });
    fake.addUser({ id: "user_bob0000002", email: "bob@example.com", name: "Bob" });
    await startApp();

    const config = await request(app).get("/api/auth/config").expect(200);
    expect(config.body).toEqual({
      provider: "clerk",
      self_service_enabled: true,
      registration_enabled: true,
      email_verification_required: true,
      organizations_enabled: false
    });
    await request(app).get("/").expect(404);
    await request(app).get("/login").expect(404);
    await request(app).get("/api/auth/me").expect(401);

    const aliceIdentity = await request(app).get("/api/auth/me").set(asUser("user_alice0001")).expect(200);
    expect(aliceIdentity.body).toMatchObject({
      user_id: "user_alice0001",
      clerk_user_id: "user_alice0001",
      email: "alice@example.com",
      display_name: "Alice",
      auth_type: "clerk",
      identity_provider: "clerk",
      role: "user",
      email_verified: true
    });
    const aliceWorkspace = aliceIdentity.body.workspace_id;
    expect(aliceWorkspace).toMatch(/^workspace_/);

    const aliceChat = await request(app)
      .post("/api/chat/sessions")
      .set(asUser("user_alice0001"))
      .send({ title: "Alice private chat" })
      .expect(201);
    expect(aliceChat.body.workspace_id).toBe(aliceWorkspace);
    expect(aliceChat.body.created_by).toBe("user_alice0001");

    fake.users.get("user_alice0001").firstName = "Alice Updated";
    const refreshedAlice = await request(app).get("/api/auth/me").set(asUser("user_alice0001")).expect(200);
    expect(refreshedAlice.body.display_name).toBe("Alice Updated");
    expect(refreshedAlice.body.workspace_id).toBe(aliceWorkspace);

    const bobIdentity = await request(app).get("/api/auth/me").set(asUser("user_bob0000002")).expect(200);
    expect(bobIdentity.body.workspace_id).not.toBe(aliceWorkspace);
    const bobChats = await request(app).get("/api/chat/sessions").set(asUser("user_bob0000002")).expect(200);
    expect(bobChats.body.sessions).toEqual([]);
    await request(app)
      .get(`/api/chat/sessions/${aliceChat.body.session_id}`)
      .set(asUser("user_bob0000002"))
      .expect(404);

    await request(app).post("/api/auth/login").set(asUser("user_alice0001")).send({}).expect(404);
    const persisted = JSON.stringify(app.locals.store.read());
    expect(persisted).not.toMatch(/password_hash|authSessions|passwordResetTokens|emailVerificationTokens/);
  });

  it("exports product data and deletes both the Clerk identity and owned workspace", async () => {
    fake.addUser({ id: "user_delete0001", email: "delete@example.com", name: "Delete Me" });
    await startApp();
    const headers = asUser("user_delete0001");
    await request(app).get("/api/auth/me").set(headers).expect(200);
    await request(app).get("/api/billing/account").set(headers).expect(200);
    await app.locals.store.mutate((data) => {
      const user = data.users.find((item) => item.clerk_user_id === "user_delete0001");
      data.workspaceModelSettings.push({
        workspace_id: user.workspace_id,
        agent_output_tokens: 2048,
        final_output_tokens: 4096,
        revision: 1,
        updated_by: user.user_id,
        reason: "DELETE_MODEL_SETTINGS_PRIVATE"
      });
      return true;
    });
    const exportedSession = await request(app)
      .post("/api/chat/sessions")
      .set(headers)
      .send({ title: "Exported chat" })
      .expect(201);
    await request(app).post("/api/agents").set(headers).send({
      id: "delete_me_agent",
      title: "Delete me agent",
      capability: "A private test agent",
      boundary: "Only test deletion.",
      routing_cues: "delete test",
      consumes: ["user_request"],
      produces: ["domain_outputs"],
      tools: []
    }).expect(201);

    const queued = await request(app)
      .post(`/api/chat/sessions/${exportedSession.body.session_id}/messages`)
      .set(headers)
      .send({ content: "@delete_me_agent prepare the fixed export test response." })
      .expect(202);
    const storedRun = app.locals.store.read().runs.find((item) => item.run_id === queued.body.run_id);
    expect(app.locals.scheduleChatRun(queued.body.run_id, storedRun.execution_options)).toBe(true);
    expect((await app.locals.drainBackgroundTasks({ timeoutMs: 5000 })).ok).toBe(true);
    const completed = await request(app).get(`/api/chat/runs/${queued.body.run_id}`).set(headers).expect(200);
    expect(completed.body).toMatchObject({ status: "completed", world_graph: { kept: 0 } });
    expect(completed.body.world_graph.refreshed).toBeGreaterThan(0);
    expect(app.locals.store.read().worldGraphArtifacts.some((item) => item.created_by === "user_delete0001")).toBe(true);

    const exported = await request(app).get("/api/account/export").set(headers).expect(200);
    expect(exported.headers["content-disposition"]).toContain("virenis-account-export");
    expect(exported.body.authentication).toMatchObject({ provider: "clerk", provider_user_id: "user_delete0001" });
    expect(exported.body.chats.sessions[0].title).toBe("Exported chat");
    expect(exported.body.billing.accounts[0]).toMatchObject({
      user_id: "user_delete0001",
      available_micros: 1_000_000_000
    });
    expect(exported.body.billing.ledger_entries.map((entry) => entry.type)).toContain("welcome_grant");
    expect(exported.body.model_settings).toEqual([
      expect.objectContaining({
        agent_output_tokens: 2048,
        final_output_tokens: 4096,
        reason: "DELETE_MODEL_SETTINGS_PRIVATE"
      })
    ]);
    expect(exported.body.world_graph.artifacts.length).toBeGreaterThan(0);
    expect(exported.body.world_graph.artifacts.every((item) => item.created_by === "user_delete0001")).toBe(true);
    expect(exported.body.retained_provenance).toMatchObject({
      projection: "virenis-ledger-content-free-v1",
      included_in_export: false,
      anonymous: false,
      operator_inventory_required: true,
      legacy_migration_status: expect.stringContaining("unknown until administrator inventory")
    });
    expect(exported.body.retained_billing).toMatchObject({
      projection: "virenis-billing-minimized-v1",
      included_in_export: false,
      anonymous: false,
      operator_inventory_required: true,
      legacy_migration_status: expect.stringContaining("unknown until administrator inventory")
    });
    expect(JSON.stringify(exported.body)).not.toMatch(/password|token_hash|credential|ciphertext/);

    await request(app).delete("/api/account").set(headers).send({ confirmation: "delete" }).expect(400);
    const deleted = await request(app).delete("/api/account").set(headers).send({ confirmation: "DELETE" }).expect(200);
    expect(deleted.body.deleted_counts).toMatchObject({ chat_sessions: 1, agents: 1 });
    expect(deleted.body.retained_provenance).toMatchObject({ included_in_export: false, anonymous: false });
    expect(deleted.body.retained_billing).toMatchObject({ included_in_export: false, anonymous: false });
    expect(fake.users.has("user_delete0001")).toBe(false);
    const persisted = app.locals.store.read();
    expect(persisted.users).toEqual([]);
    expect(persisted.sessions).toEqual([]);
    expect(persisted.billingAccounts).toEqual([]);
    expect(persisted.billingLedgerEntries).toEqual([]);
    expect(persisted.workspaceModelSettings).toEqual([]);
    expect(persisted.worldGraphArtifacts).toEqual([]);
    expect(persisted.worldGraphEvents).toEqual([]);
    expect(persisted.agents.some((agent) => agent.id === "delete_me_agent")).toBe(false);
    await request(app).get("/api/auth/me").set(headers).expect(401);
  });

  it("keeps a durable deletion marker across provider failure and resumes only through DELETE /api/account", async () => {
    fake.addUser({ id: "user_delete_retry", email: "delete-retry@example.com", name: "Delete Retry" });
    fake.deleteUserFailures = 2;
    await startApp();
    const headers = asUser("user_delete_retry");
    const identity = await request(app).get("/api/auth/me").set(headers).expect(200);
    const alternateToken = "same-tenant-configured-token-long-enough";
    process.env.APP_API_TOKENS_JSON = JSON.stringify({
      [alternateToken]: {
        user_id: identity.body.user_id,
        workspace_id: identity.body.workspace_id,
        role: "admin"
      }
    });
    await request(app).post("/api/chat/sessions").set(headers).send({ title: "Retry proof" }).expect(201);

    const failed = await request(app)
      .delete("/api/account")
      .set(headers)
      .send({ confirmation: "DELETE" })
      .expect(502);
    expect(failed.body.error).toBe("synthetic_provider_failure");
    expect(fake.users.has("user_delete_retry")).toBe(true);
    const marked = app.locals.store.read();
    expect(marked.users[0].status).toBe("deleting");
    expect(marked.users[0].deletion_started_at).toBeTruthy();
    expect(marked.users[0].deletion_external_purges).toEqual([
      expect.stringMatching(/^snapshot:[0-9a-f]{64}$/)
    ]);
    expect(marked.identityDeletionTombstones[0]).toMatchObject({ status: "deleting" });
    expect(marked.sessions).toHaveLength(1);

    await app.locals.store.close();
    app = null;
    await startApp();
    expect(app.locals.store.read().users[0]).toMatchObject({
      status: "deleting",
      deletion_id: marked.users[0].deletion_id
    });

    const blocked = await request(app).get("/api/chat/sessions").set(headers).expect(409);
    expect(blocked.body.error).toBe("account_deletion_in_progress");
    const alternateBlocked = await request(app)
      .post("/api/chat/sessions")
      .set("Authorization", `Bearer ${alternateToken}`)
      .send({ title: "Must not be created" })
      .expect(409);
    expect(alternateBlocked.body.error).toBe("account_deletion_in_progress");
    expect(app.locals.store.read().sessions).toHaveLength(1);
    await request(app)
      .post("/api/webhooks/clerk")
      .set("x-test-webhook-signature", "valid")
      .send({ type: "user.updated", data: fake.users.get("user_delete_retry") })
      .expect(200);
    expect(app.locals.store.read().users[0].status).toBe("deleting");
    await expect(app.locals.identityManager.updateUser(
      { role: "admin", user_id: "support_admin" },
      "user_delete_retry",
      { status: "active" }
    )).rejects.toMatchObject({ code: "account_deletion_in_progress", status: 409 });

    const recoveryFailure = await app.locals.recoverPendingAccountDeletions();
    expect(recoveryFailure).toMatchObject({
      attempted: 1,
      results: [{ kind: "account", ok: false, code: "synthetic_provider_failure" }]
    });
    expect(app.locals.store.read().users[0]).toMatchObject({
      deletion_recovery_attempts: 1,
      deletion_recovery_last_error_code: "synthetic_provider_failure",
      deletion_recovery_next_at: expect.any(String)
    });
    expect((await app.locals.recoverPendingAccountDeletions()).attempted).toBe(0);

    await request(app)
      .delete("/api/account")
      .set(headers)
      .send({ confirmation: "DELETE" })
      .expect(200);
    expect(fake.deleteUserCalls).toBe(3);
    expect(app.locals.store.read().users).toEqual([]);
  });

  it("single-flights concurrent API deletion requests for one Clerk account", async () => {
    fake.addUser({ id: "user_delete_flight", email: "delete-flight@example.com", name: "Delete Flight" });
    fake.deleteUserDelayMs = 75;
    await startApp();
    const headers = asUser("user_delete_flight");
    await request(app).get("/api/auth/me").set(headers).expect(200);

    const sendDeletion = () => request(app)
      .delete("/api/account")
      .set(headers)
      .send({ confirmation: "DELETE" });
    const [first, second] = await Promise.all([sendDeletion(), sendDeletion()]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(fake.deleteUserCalls).toBe(1);
    expect(app.locals.store.read().users).toEqual([]);
  });

  it("serializes a Clerk deletion webhook with an in-progress API deletion", async () => {
    fake.addUser({ id: "user_delete_webhook_race", email: "delete-webhook-race@example.com", name: "Delete Webhook Race" });
    fake.deleteUserDelayMs = 75;
    await startApp();
    const headers = asUser("user_delete_webhook_race");
    await request(app).get("/api/auth/me").set(headers).expect(200);

    const apiDeletion = request(app)
      .delete("/api/account")
      .set(headers)
      .send({ confirmation: "DELETE" });
    const apiResultPromise = apiDeletion.then((response) => response);
    for (let attempts = 0; attempts < 100 && fake.deleteUserCalls === 0; attempts += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    expect(fake.deleteUserCalls).toBe(1);
    const webhookPromise = request(app)
      .post("/api/webhooks/clerk")
      .set("x-test-webhook-signature", "valid")
      .send({ type: "user.deleted", data: { id: "user_delete_webhook_race" } });

    const [apiResult, webhookResult] = await Promise.all([apiResultPromise, webhookPromise]);
    expect(apiResult.status).toBe(200);
    expect(webhookResult.status).toBe(200);
    expect(fake.deleteUserCalls).toBe(1);
    expect(app.locals.store.read().users).toEqual([]);
  });

  it("purges a changed same-id external resource again under its new snapshot revision", async () => {
    fake.addUser({ id: "user_delete_revision", email: "delete-revision@example.com", name: "Delete Revision" });
    await startApp();
    const headers = asUser("user_delete_revision");
    const identity = await request(app).get("/api/auth/me").set(headers).expect(200);
    await app.locals.store.mutate((data) => {
      data.mcpConnections.push({
        connection_id: "mcpconn_same_id_rotates",
        provider_id: "custom",
        auth_type: "none",
        credential: { revision: "first" },
        status: "ready",
        workspace_id: identity.body.workspace_id,
        created_by: identity.body.user_id,
        updated_at: "2026-07-16T00:00:00.000Z"
      });
      return true;
    });

    const manager = app.locals.identityManager;
    const originalMarkPurge = manager.markDeletionExternalPurge.bind(manager);
    const purgeReceipts = [];
    let rotated = false;
    manager.markDeletionExternalPurge = async (actor, deletionId, receiptKey) => {
      const result = await originalMarkPurge(actor, deletionId, receiptKey);
      if (receiptKey.includes(":mcp:mcpconn_same_id_rotates")) {
        purgeReceipts.push(receiptKey);
        if (!rotated) {
          rotated = true;
          await app.locals.store.mutate((data) => {
            data.mcpConnections.push({
              connection_id: "mcpconn_same_id_rotates",
              provider_id: "custom",
              auth_type: "none",
              credential: { revision: "second" },
              status: "ready",
              workspace_id: identity.body.workspace_id,
              created_by: identity.body.user_id,
              updated_at: "2026-07-16T00:00:01.000Z"
            });
            return true;
          });
        }
      }
      return result;
    };

    await request(app)
      .delete("/api/account")
      .set(headers)
      .send({ confirmation: "DELETE" })
      .expect(200);
    expect(purgeReceipts).toHaveLength(2);
    expect(purgeReceipts[0]).toMatch(/^revision:[0-9a-f]{64}:mcp:mcpconn_same_id_rotates$/);
    expect(purgeReceipts[1]).toMatch(/^revision:[0-9a-f]{64}:mcp:mcpconn_same_id_rotates$/);
    expect(purgeReceipts[0]).not.toBe(purgeReceipts[1]);
    expect(app.locals.store.read().mcpConnections).toEqual([]);
  });

  it("retains a document-cleanup outbox after filesystem failure and completes it in the recovery worker", async () => {
    fake.addUser({ id: "user_delete_files", email: "delete-files@example.com", name: "Delete Files" });
    const purgeCalls = [];
    let failCleanup = true;
    const documentRootPurger = async (_uploadRoot, roots) => {
      purgeCalls.push([...roots]);
      if (failCleanup) {
        failCleanup = false;
        throw Object.assign(new Error("Synthetic document cleanup failure"), {
          status: 503,
          code: "synthetic_document_cleanup_failure"
        });
      }
    };
    await startApp(fake.adapter, { documentRootPurger });
    const headers = asUser("user_delete_files");
    const identity = await request(app).get("/api/auth/me").set(headers).expect(200);
    await app.locals.store.mutate((data) => {
      data.documents.push({
        document_id: "doc_delete_cleanup_retry",
        agent_id: "agent_delete_cleanup_retry",
        document_root: "user-delete-files/document-proof",
        title: "Cleanup proof",
        workspace_id: identity.body.workspace_id,
        created_by: identity.body.user_id
      });
      return true;
    });

    const failed = await request(app)
      .delete("/api/account")
      .set(headers)
      .send({ confirmation: "DELETE" })
      .expect(503);
    expect(failed.body.error).toBe("synthetic_document_cleanup_failure");
    const afterFailure = app.locals.store.read();
    expect(afterFailure.users).toEqual([]);
    expect(afterFailure.documents).toEqual([]);
    expect(afterFailure.identityDeletionTombstones[0]).toMatchObject({
      status: "deleted",
      pending_document_roots: ["user-delete-files/document-proof"]
    });
    expect(purgeCalls).toEqual([["user-delete-files/document-proof"]]);

    const recovery = await app.locals.recoverPendingAccountDeletions();
    expect(recovery).toMatchObject({
      attempted: 1,
      results: [{ kind: "document_cleanup", ok: true }]
    });
    const completed = app.locals.store.read().identityDeletionTombstones[0];
    expect(completed.pending_document_roots).toBeUndefined();
    expect(completed.document_cleanup_completed_at).toBeTruthy();
    expect(purgeCalls).toEqual([
      ["user-delete-files/document-proof"],
      ["user-delete-files/document-proof"]
    ]);
    await request(app)
      .post("/api/webhooks/clerk")
      .set("x-test-webhook-signature", "valid")
      .send({ type: "user.deleted", data: { id: "user_delete_files" } })
      .expect(200);
    expect(purgeCalls).toHaveLength(2);
  });

  it("times out safely while an older authenticated request is active, then resumes", async () => {
    process.env.APP_ACCOUNT_DELETION_DRAIN_TIMEOUT_MS = "25";
    fake.addUser({ id: "user_delete_drain", email: "delete-drain@example.com", name: "Delete Drain" });
    await startApp();
    const headers = asUser("user_delete_drain");
    await request(app).get("/api/auth/me").set(headers).expect(200);
    const clerkActor = app.locals.identityManager.actorForClerkUserId("user_delete_drain");
    const releaseOlderRequest = app.locals.identityManager.beginAuthenticatedRequest({
      user_id: clerkActor.user_id,
      workspace_id: clerkActor.workspace_id,
      role: "admin",
      auth_type: "bearer"
    });

    const timedOut = await request(app)
      .delete("/api/account")
      .set(headers)
      .send({ confirmation: "DELETE" })
      .expect(503);
    expect(timedOut.body.error).toBe("account_deletion_drain_timeout");
    expect(app.locals.store.read().users[0].status).toBe("deleting");
    expect(fake.deleteUserCalls).toBe(0);

    releaseOlderRequest();
    await request(app)
      .delete("/api/account")
      .set(headers)
      .send({ confirmation: "DELETE" })
      .expect(200);
    expect(fake.deleteUserCalls).toBe(1);
  });

  it("closes only the deleting owner's event streams before draining authenticated requests", async () => {
    process.env.APP_ACCOUNT_DELETION_DRAIN_TIMEOUT_MS = "250";
    fake.addUser({ id: "user_delete_stream", email: "delete-stream@example.com", name: "Delete Stream" });
    fake.addUser({ id: "user_other_stream", email: "other-stream@example.com", name: "Other Stream" });
    await startApp();

    const ownerHeaders = asUser("user_delete_stream");
    const otherHeaders = asUser("user_other_stream");
    await request(app).get("/api/auth/me").set(ownerHeaders).expect(200);
    await request(app).get("/api/auth/me").set(otherHeaders).expect(200);
    const ownerSession = await request(app)
      .post("/api/chat/sessions")
      .set(ownerHeaders)
      .send({ title: "Deleting owner stream" })
      .expect(201);
    const otherSession = await request(app)
      .post("/api/chat/sessions")
      .set(otherHeaders)
      .send({ title: "Other owner stream" })
      .expect(201);
    const ownerRunId = "run_delete_owner_stream";
    const otherRunId = "run_delete_other_stream";
    await app.locals.store.mutate((data) => {
      const now = new Date().toISOString();
      data.runs.push(
        {
          run_id: ownerRunId,
          session_id: ownerSession.body.session_id,
          status: "running",
          events: [{ type: "run.started", at: now }]
        },
        {
          run_id: otherRunId,
          session_id: otherSession.body.session_id,
          status: "running",
          events: [{ type: "run.started", at: now }]
        }
      );
      return true;
    });

    const server = await new Promise((resolve) => {
      const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
    });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    try {
      const ownerStream = await fetch(`${baseUrl}/api/chat/runs/${ownerRunId}/events`, {
        headers: ownerHeaders
      });
      const otherStream = await fetch(`${baseUrl}/api/chat/runs/${otherRunId}/events`, {
        headers: otherHeaders
      });
      expect(ownerStream.status).toBe(200);
      expect(otherStream.status).toBe(200);
      expect(app.locals.eventStreams.size).toBe(2);

      // Keep the HTTP event stream open while making the persisted run safe
      // to purge. This isolates the deletion-drain behavior from the separate
      // guard that rejects deletion while model work is still active.
      await app.locals.store.mutate((data) => {
        const run = data.runs.find((item) => item.run_id === ownerRunId);
        run.status = "completed";
        run.completed_at = new Date().toISOString();
        return run.run_id;
      });

      const deleted = await request(app)
        .delete("/api/account")
        .set(ownerHeaders)
        .send({ confirmation: "DELETE" });
      expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
      expect(deleted.body.ok).toBe(true);
      expect(fake.deleteUserCalls).toBe(1);
      expect(app.locals.eventStreams.size).toBe(1);
      expect([...app.locals.eventStreams][0]).toMatchObject({
        user_id: "user_other_stream"
      });
      expect(await ownerStream.text()).toContain("account_deletion");

      const closed = app.locals.closeEventStreams({ reason: "identity_test_cleanup" });
      expect(closed).toMatchObject({ closed: 1, pending: 0 });
      expect(await otherStream.text()).toContain("identity_test_cleanup");
    } finally {
      app.locals.closeEventStreams({ reason: "identity_test_finally" });
      server.closeAllConnections?.();
      await new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  });

  it("drains background workflow activation, rejects its post-Runtime commit, and leaves no orphan during deletion", async () => {
    process.env.TCAR_ENGINE_MODE = "real";
    process.env.TCAR_RUNTIME_API_URL = "http://runtime.identity-race.test";
    process.env.TCAR_RUNTIME_API_KEY = "identity-workflow-race-test-key";
    fake.addUser({
      id: "user_delete_workflow_race",
      email: "delete-workflow-race@example.com",
      name: "Delete Workflow Race"
    });
    await startApp(fake.adapter, {
      autoRun: true,
      workflowComposer: async () => ({
        title: "Background ceramic review",
        nodes: [{
          id: "ceramic_reviewer",
          type: "agent",
          title: "Ceramic Reviewer",
          task: "Review the supplied ceramic description.",
          produces: ["ceramic_review"]
        }],
        edges: []
      })
    });
    const headers = asUser("user_delete_workflow_race");
    const identity = (await request(app).get("/api/auth/me").set(headers).expect(200)).body;
    const session = (await request(app)
      .post("/api/chat/sessions")
      .set(headers)
      .send({ title: "Deletion race proof" })
      .expect(201)).body;
    const queued = (await request(app)
      .post(`/api/chat/sessions/${session.session_id}/messages`)
      .set(headers)
      .send({ content: "/agent review this ceramic description" })
      .expect(202)).body;
    await waitForStoredRun(app, queued.run_id);
    const workflow = await app.locals.store.mutate((data) => {
      const current = data.workflows.find((item) => (
        item.session_id === session.session_id
        && item.workspace_id === identity.workspace_id
        && item.created_by === identity.user_id
      ));
      expect(current).toBeTruthy();
      current.approved_at = new Date().toISOString();
      current.status = "ready_to_activate";
      current.revision += 1;
      return current;
    });

    let registrationObserved;
    const registered = new Promise((resolve) => { registrationObserved = resolve; });
    let allowRegistrationResponse;
    const registrationResponseGate = new Promise((resolve) => { allowRegistrationResponse = resolve; });
    const remoteAgents = new Set();
    const runtimeCalls = [];
    let compensationFailureReturned = false;
    const restoreFetch = setRuntimeFetchForTests(async (url, options = {}) => {
      const pathName = new URL(url).pathname;
      const method = options.method || "GET";
      const body = options.body ? JSON.parse(options.body) : {};
      runtimeCalls.push({ method, pathName, body });
      if (pathName === "/agents" && method === "POST") {
        remoteAgents.add(body.id);
        registrationObserved({ agentId: body.id, registrationId: body.registration_id });
        // The Runtime has committed, but the application has not received the
        // response and therefore cannot have committed the local agent yet.
        await registrationResponseGate;
        return Response.json({
          ok: true,
          status: "added",
          id: body.id,
          registration_id: body.registration_id,
          result: { status: "added", id: body.id },
          agent: {
            ...body,
            enabled: true,
            mounted: true,
            registration_kind: "agent",
            registration_cleanup_allowed: true
          },
          mounted: true,
          requires_vllm_reload: false
        });
      }
      if (method === "DELETE" && pathName.startsWith("/agents/")) {
        const agentId = decodeURIComponent(pathName.slice("/agents/".length));
        if (body.purge_registration === true && !compensationFailureReturned) {
          compensationFailureReturned = true;
          return Response.json({ detail: "synthetic compensation outage" }, { status: 503 });
        }
        if (body.delete_archived === true) remoteAgents.delete(agentId);
        return Response.json({
          ok: true,
          status: body.delete_archived === true ? "purged" : "archived",
          id: agentId,
          agent: { id: agentId, enabled: false, mounted: false },
          enabled: false,
          mounted: false,
          purged: body.delete_archived === true,
          requires_vllm_reload: false
        });
      }
      return Response.json({ detail: "not found" }, { status: 404 });
    });
    try {
      const backgroundActor = {
        user_id: identity.user_id,
        workspace_id: identity.workspace_id,
        role: identity.role || "user"
      };
      const activationOutcome = app.locals.activateWorkflow({
        workflowId: workflow.workflow_id,
        actor: backgroundActor
      }).then(
        (value) => ({ value, error: null }),
        (error) => ({ value: null, error })
      );
      const registration = await registered;
      expect(remoteAgents.has(registration.agentId)).toBe(true);
      expect(app.locals.store.read((data) => data.agents.find((agent) => agent.id === registration.agentId)))
        .toMatchObject({ ready: false, runtime_sync_pending: true });

      const deletionResponse = request(app)
        .delete("/api/account")
        .set(headers)
        .send({ confirmation: "DELETE" })
        .then((response) => response);
      await waitForStoredUserStatus(app, "user_delete_workflow_race", "deleting");
      expect(fake.deleteUserCalls).toBe(0);

      allowRegistrationResponse();
      const activation = await activationOutcome;
      expect(activation.error).toMatchObject({
        status: 409,
        code: "account_deletion_in_progress",
        runtime_agent_compensation_failed: true
      });
      const deleted = await deletionResponse;
      expect(deleted.status).toBe(200);
      expect(runtimeCalls.map((call) => `${call.method} ${call.pathName}`)).toEqual([
        "POST /agents",
        `DELETE /agents/${registration.agentId}`,
        `DELETE /agents/${registration.agentId}`,
        `DELETE /agents/${registration.agentId}`
      ]);
      expect(runtimeCalls[1].body).toMatchObject({
        registration_id: registration.registrationId,
        purge_registration: true
      });
      expect(runtimeCalls[2].body).not.toHaveProperty("delete_archived");
      expect(runtimeCalls[3].body).toMatchObject({ delete_archived: true });
      expect(remoteAgents).toEqual(new Set());
      const persisted = app.locals.store.read();
      expect(persisted.users.some((user) => user.clerk_user_id === "user_delete_workflow_race")).toBe(false);
      expect(persisted.workflows.some((item) => item.workflow_id === workflow.workflow_id)).toBe(false);
      expect(persisted.agents.some((agent) => agent.id === registration.agentId)).toBe(false);
    } finally {
      allowRegistrationResponse();
      restoreFetch();
    }
  });

  it("fails closed while an OAuth exchange lacks a durable revocation outbox", async () => {
    fake.addUser({ id: "user_delete_oauth_gap", email: "delete-oauth-gap@example.com", name: "Delete OAuth Gap" });
    await startApp();
    const headers = asUser("user_delete_oauth_gap");
    const identity = await request(app).get("/api/auth/me").set(headers).expect(200);
    await app.locals.store.mutate((data) => {
      data.mcpOauthStates.push({
        oauth_state_id: "mcpoauth_unresolved_exchange",
        provider_id: "gmail",
        status: "exchanging",
        workspace_id: identity.body.workspace_id,
        created_by: identity.body.user_id,
        exchange_started_at: new Date().toISOString()
      });
      return true;
    });

    const blocked = await request(app)
      .delete("/api/account")
      .set(headers)
      .send({ confirmation: "DELETE" })
      .expect(409);
    expect(blocked.body.error).toBe("account_oauth_revocation_unresolved");
    const snapshot = app.locals.store.read();
    expect(snapshot.users[0].status).toBe("deleting");
    expect(snapshot.mcpOauthStates[0].status).toBe("account_deleting");
    expect(fake.deleteUserCalls).toBe(0);

    const operator = {
      user_id: "security_operator",
      workspace_id: identity.body.workspace_id,
      role: "admin"
    };
    const attestation = {
      store: app.locals.store,
      actor: operator,
      revocationId: "mcpoauth_unresolved_exchange",
      confirmation: "PROVIDER_APP_ACCESS_REVOKED_AND_VERIFIED",
      evidenceReference: "provider-console-deauthorization-case-1001",
      reason: "The provider console confirms that the full application grant was removed."
    };
    await expect(attestMcpOAuthRevocationResolved(attestation)).rejects.toMatchObject({
      status: 409,
      code: "mcp_revocation_not_pending"
    });
    await app.locals.store.mutate((data) => {
      data.mcpOauthStates[0].exchange_started_at = new Date(Date.now() - 21 * 60 * 1000).toISOString();
      return data.mcpOauthStates[0];
    });
    await expect(attestMcpOAuthRevocationResolved({
      ...attestation,
      confirmation: "PROVIDER_ACCESS_REVOKED"
    })).rejects.toMatchObject({
      status: 400,
      code: "mcp_revocation_resolution_confirmation_required"
    });
    await expect(attestMcpOAuthRevocationResolved({
      ...attestation,
      evidenceReference: ""
    })).rejects.toMatchObject({ status: 400 });

    const resolved = await attestMcpOAuthRevocationResolved(attestation);
    expect(resolved).toMatchObject({
      revocation_id: "mcpoauth_unresolved_exchange",
      status: "revocation_manually_resolved"
    });
    expect(JSON.stringify(app.locals.store.read().identityAuditEvents.at(-1)))
      .not.toContain(attestation.evidenceReference);

    await request(app)
      .delete("/api/account")
      .set(headers)
      .send({ confirmation: "DELETE" })
      .expect(200);
    expect(fake.deleteUserCalls).toBe(1);
    expect(app.locals.store.read().users).toEqual([]);
  });

  it("recovers stale exchange and refresh intents, blocks deletion, and unblocks only after provider-wide attestation", async () => {
    fake.addUser({ id: "user_delete_oauth_restart", email: "delete-oauth-restart@example.com", name: "Delete OAuth Restart" });
    await startApp();
    const headers = asUser("user_delete_oauth_restart");
    const identity = await request(app).get("/api/auth/me").set(headers).expect(200);
    const staleAt = new Date(Date.now() - 21 * 60 * 1000).toISOString();
    await app.locals.store.mutate((data) => {
      data.mcpOauthStates.push(
        {
          oauth_state_id: "mcpoauth_delete_restart_exchange",
          provider_id: "gmail",
          status: "exchanging",
          workspace_id: identity.body.workspace_id,
          created_by: identity.body.user_id,
          created_at: staleAt,
          exchange_started_at: staleAt
        },
        {
          oauth_state_id: "mcprefresh_delete_restart_intent",
          provider_id: "gmail",
          status: "refreshing",
          workspace_id: identity.body.workspace_id,
          created_by: identity.body.user_id,
          source_connection_id: "mcpconn_deleted_restart_proof",
          source_credential_revision_digest: "a".repeat(64),
          created_at: staleAt,
          refresh_started_at: staleAt
        }
      );
      return true;
    });

    await app.locals.recoverPendingMcpRevocations();
    const recovered = app.locals.store.read().mcpOauthStates;
    expect(recovered.find((item) => item.oauth_state_id === "mcpoauth_delete_restart_exchange")).toMatchObject({
      status: "exchange_outcome_uncertain",
      uncertain_started_at: staleAt
    });
    expect(recovered.find((item) => item.oauth_state_id === "mcprefresh_delete_restart_intent")).toMatchObject({
      status: "refresh_outcome_uncertain",
      uncertain_started_at: staleAt
    });

    const blocked = await request(app)
      .delete("/api/account")
      .set(headers)
      .send({ confirmation: "DELETE" })
      .expect(409);
    expect(blocked.body.error).toBe("account_oauth_revocation_unresolved");
    expect(fake.deleteUserCalls).toBe(0);

    const operator = {
      user_id: "security_restart_operator",
      workspace_id: identity.body.workspace_id,
      role: "admin"
    };
    for (const revocationId of [
      "mcpoauth_delete_restart_exchange",
      "mcprefresh_delete_restart_intent"
    ]) {
      await attestMcpOAuthRevocationResolved({
        store: app.locals.store,
        actor: operator,
        revocationId,
        confirmation: "PROVIDER_APP_ACCESS_REVOKED_AND_VERIFIED",
        evidenceReference: `provider-wide-restart-attestation:${revocationId}`,
        reason: "Provider-wide deauthorization resolves the process-crash token outcome before deletion resumes."
      });
    }

    await request(app)
      .delete("/api/account")
      .set(headers)
      .send({ confirmation: "DELETE" })
      .expect(200);
    expect(fake.deleteUserCalls).toBe(1);
    expect(app.locals.store.read().users).toEqual([]);
  });

  it("isolates export and deletion when every tenant-local resource id collides", async () => {
    fake.addUser({ id: "user_collision_a", email: "collision-a@example.com", name: "Collision Alice" });
    fake.addUser({ id: "user_collision_b", email: "collision-b@example.com", name: "Collision Bob" });
    await startApp();
    const aliceHeaders = asUser("user_collision_a");
    const bobHeaders = asUser("user_collision_b");
    const aliceIdentity = await request(app).get("/api/auth/me").set(aliceHeaders).expect(200);
    const bobIdentity = await request(app).get("/api/auth/me").set(bobHeaders).expect(200);
    await request(app).get("/api/billing/account").set(aliceHeaders).expect(200);
    await request(app).get("/api/billing/account").set(bobHeaders).expect(200);

    const alice = { user_id: "user_collision_a", workspace_id: aliceIdentity.body.workspace_id };
    const bob = { user_id: "user_collision_b", workspace_id: bobIdentity.body.workspace_id };
    const ids = {
      session: "sess_adversarial_collision",
      run: "run_adversarial_collision",
      message: "msg_adversarial_collision",
      step: "step_adversarial_collision",
      agent: "agent_adversarial_collision",
      document: "doc_adversarial_collision",
      workflow: "workflow_adversarial_collision",
      checkpoint: "checkpoint_adversarial_collision",
      agentWorkspace: "aw_adversarial_collision",
      connection: "mcpconn_adversarial_collision",
      listing: "listing_adversarial_collision"
    };
    const at = "2026-07-16T00:00:00.000Z";
    const scoped = (owner, marker) => ({
      workspace_id: owner.workspace_id,
      created_by: owner.user_id,
      marker
    });

    await app.locals.store.mutate((data) => {
      for (const [owner, marker] of [[alice, "ALICE_PRIVATE"], [bob, "BOB_PRIVATE"]]) {
        data.sessions.push({
          session_id: ids.session,
          title: `${marker} session`,
          ...scoped(owner, marker),
          status: "completed",
          created_at: at,
          updated_at: at
        });
        data.runs.push({
          run_id: ids.run,
          session_id: ids.session,
          user_message_id: ids.message,
          assistant_message_id: ids.message,
          status: "completed",
          expert_outputs: [{ raw_text_admin_only: `${marker} raw envelope` }],
          runtime_result_admin_only: { secret: `${marker} runtime receipt` },
          ...scoped(owner, marker),
          created_at: at,
          completed_at: at
        });
        data.messages.push({
          message_id: ids.message,
          session_id: ids.session,
          run_id: ids.run,
          role: "assistant",
          content: `${marker} message`,
          ...scoped(owner, marker),
          created_at: at
        });
        data.runSteps.push({
          run_step_id: `${ids.step}_${marker}`,
          run_id: ids.run,
          step_id: ids.step,
          domain_answer: `${marker} safe answer`,
          agent_reasoning: `${marker} hidden reasoning`,
          raw_text_admin_only: `${marker} raw output`,
          prompt_preview_admin_only: `${marker} hidden prompt`,
          model_calls_admin_only: [{ response: `${marker} model response` }],
          approved_sources: [{ token: `${marker} source credential` }],
          ...scoped(owner, marker)
        });
        data.agents.push({
          id: ids.agent,
          title: `${marker} agent`,
          capability: `${marker} capability`,
          visibility: "private",
          marketplace: {
            listing_id: ids.listing,
            published_by: owner.user_id,
            publisher_workspace_id: owner.workspace_id
          },
          ...scoped(owner, marker)
        });
        data.agentEvents.push({
          event_id: `event_${marker}`,
          agent_id: ids.agent,
          details: { marker },
          ...scoped(owner, marker)
        });
        data.documents.push({
          document_id: ids.document,
          title: `${marker} document`,
          ...scoped(owner, marker)
        });
        data.agentWorkspaces.push({
          agent_workspace_id: ids.agentWorkspace,
          name: `${marker} team`,
          agent_ids: [ids.agent],
          ...scoped(owner, marker)
        });
        data.workflows.push({
          workflow_id: ids.workflow,
          session_id: ids.session,
          title: `${marker} workflow`,
          ...scoped(owner, marker)
        });
        data.conversationCheckpoints.push({
          checkpoint_id: ids.checkpoint,
          workflow_id: ids.workflow,
          session_id: ids.session,
          ...scoped(owner, marker)
        });
        data.executionRecords.push({
          execution_id: `exec_${marker}`,
          run_id: ids.run,
          payload: `${marker} execution`,
          ...scoped(owner, marker)
        });
        data.worldGraphArtifacts.push({
          artifact_id: `artifact_${marker}`,
          origin_run_id: ids.run,
          replay_output: { domain_answer: `${marker} replay` },
          ...scoped(owner, marker)
        });
        data.worldGraphEvents.push({
          event_id: `wg_event_${marker}`,
          run_id: ids.run,
          payload: `${marker} world graph event`,
          ...scoped(owner, marker)
        });
        data.outcomeContracts.push({
          contract_id: `contract_${marker}`,
          run_id: ids.run,
          claim: `${marker} outcome`,
          ...scoped(owner, marker)
        });
        data.runtimeLifecycleIntents.push({
          intent_id: `intent_${marker}`,
          agent_id: ids.agent,
          document_id: ids.document,
          ...scoped(owner, marker)
        });
        data.validationRuns.push({
          validation_run_id: `validation_${marker}`,
          result: `${marker} validation`,
          ...scoped(owner, marker)
        });
        data.mcpConnections.push({
          connection_id: ids.connection,
          name: `${marker} connection`,
          auth_type: "none",
          ...scoped(owner, marker)
        });
        data.mcpOauthClients.push({
          oauth_client_id: `oauth_client_${marker}`,
          ...scoped(owner, marker)
        });
        data.mcpOauthStates.push({
          oauth_state_id: `oauth_state_${marker}`,
          connection_id: ids.connection,
          ...scoped(owner, marker)
        });
        data.mcpApprovals.push({
          approval_id: `approval_${marker}`,
          connection_id: ids.connection,
          run_id: ids.run,
          ...scoped(owner, marker)
        });
        data.mcpToolCalls.push({
          call_id: `call_${marker}`,
          connection_id: ids.connection,
          run_id: ids.run,
          result: `${marker} tool result`,
          ...scoped(owner, marker)
        });
        data.marketplaceRatings.push({
          rating_id: `rating_${marker}`,
          listing_id: ids.listing,
          rating: 5,
          ...scoped(owner, marker)
        });
      }
      // These old rows predate tenant columns. The shared run id makes them
      // deliberately impossible to assign without leaking or over-deleting.
      data.runSteps.push(
        { run_step_id: "legacy_step_one", run_id: ids.run, domain_answer: "LEGACY_ONE_PRIVATE" },
        { run_step_id: "legacy_step_two", run_id: ids.run, domain_answer: "LEGACY_TWO_PRIVATE" }
      );
      data.validationRuns.push(
        {
          validation_run_id: "legacy_owner_alice",
          created_by: alice.user_id,
          result: "ALICE_LEGACY_OWNER_PRIVATE"
        },
        {
          validation_run_id: "legacy_owner_bob",
          created_by: bob.user_id,
          result: "BOB_LEGACY_OWNER_PRIVATE"
        }
      );
      return null;
    });

    const aliceExport = await request(app).get("/api/account/export").set(aliceHeaders).expect(200);
    const aliceJson = JSON.stringify(aliceExport.body);
    expect(aliceJson).toContain("ALICE_PRIVATE");
    expect(aliceJson).toContain("ALICE_LEGACY_OWNER_PRIVATE");
    expect(aliceJson).not.toContain("BOB_PRIVATE");
    expect(aliceJson).not.toContain("BOB_LEGACY_OWNER_PRIVATE");
    expect(aliceJson).not.toContain("LEGACY_ONE_PRIVATE");
    expect(aliceExport.body.privacy_filter).toMatchObject({
      schema_version: "tenant-qualified-export-v1"
    });
    expect(aliceExport.body.privacy_filter.ambiguous_legacy_records_omitted).toBeGreaterThanOrEqual(2);
    expect(aliceExport.body.chats.runs[0].expert_outputs).toBeUndefined();
    expect(aliceExport.body.chats.runs[0].runtime_result_admin_only).toBeUndefined();
    expect(aliceExport.body.chats.run_steps[0]).not.toHaveProperty("agent_reasoning");
    expect(aliceExport.body.chats.run_steps[0]).not.toHaveProperty("raw_text_admin_only");
    expect(aliceExport.body.chats.run_steps[0]).not.toHaveProperty("prompt_preview_admin_only");
    expect(aliceExport.body.chats.run_steps[0]).not.toHaveProperty("model_calls_admin_only");
    expect(aliceExport.body.chats.run_steps[0]).not.toHaveProperty("approved_sources");

    const blocked = await request(app)
      .delete("/api/account")
      .set(aliceHeaders)
      .send({ confirmation: "DELETE" })
      .expect(409);
    expect(blocked.body.error).toBe("account_legacy_scope_ambiguous");
    expect(blocked.body.message).toMatch(/legacy records have ambiguous tenant ownership/);
    expect(fake.users.has(alice.user_id)).toBe(true);

    // Simulate the documented administrator repair: remove the two genuinely
    // unassignable legacy rows and give the colliding listings unique IDs.
    await app.locals.store.mutate((data) => {
      data.runSteps = data.runSteps.filter((item) => !item.run_step_id.startsWith("legacy_step_"));
      const bobAgent = data.agents.find((item) => item.id === ids.agent && item.created_by === bob.user_id);
      bobAgent.marketplace.listing_id = "listing_collision_b_repaired";
      const bobRating = data.marketplaceRatings.find((item) => item.created_by === bob.user_id);
      bobRating.listing_id = bobAgent.marketplace.listing_id;
      return null;
    });

    await request(app)
      .delete("/api/account")
      .set(aliceHeaders)
      .send({ confirmation: "DELETE" })
      .expect(200);
    expect(fake.users.has(alice.user_id)).toBe(false);
    expect(fake.users.has(bob.user_id)).toBe(true);

    const persisted = app.locals.store.read();
    expect(persisted.users.some((item) => item.user_id === bob.user_id)).toBe(true);
    for (const collection of [
      "sessions",
      "messages",
      "runs",
      "runSteps",
      "agents",
      "agentEvents",
      "documents",
      "agentWorkspaces",
      "workflows",
      "conversationCheckpoints",
      "executionRecords",
      "worldGraphArtifacts",
      "worldGraphEvents",
      "outcomeContracts",
      "runtimeLifecycleIntents",
      "validationRuns",
      "mcpConnections",
      "mcpOauthClients",
      "mcpOauthStates",
      "mcpApprovals",
      "mcpToolCalls",
      "marketplaceRatings"
    ]) {
      expect(persisted[collection].some((item) => item.created_by === alice.user_id), collection).toBe(false);
      expect(persisted[collection].some((item) => item.created_by === bob.user_id), collection).toBe(true);
    }

    const bobExport = await request(app).get("/api/account/export").set(bobHeaders).expect(200);
    const bobJson = JSON.stringify(bobExport.body);
    expect(bobJson).toContain("BOB_PRIVATE");
    expect(bobJson).not.toContain("ALICE_PRIVATE");
  });

  it("reports a duplicate user workspace identity and blocks destructive traversal", async () => {
    fake.addUser({ id: "user_workspace_a", email: "workspace-a@example.com", name: "Workspace Alice" });
    fake.addUser({ id: "user_workspace_b", email: "workspace-b@example.com", name: "Workspace Bob" });
    await startApp();
    const aliceHeaders = asUser("user_workspace_a");
    const bobHeaders = asUser("user_workspace_b");
    const alice = await request(app).get("/api/auth/me").set(aliceHeaders).expect(200);
    await request(app).get("/api/auth/me").set(bobHeaders).expect(200);

    await app.locals.store.mutate((data) => {
      const bobUser = data.users.find((item) => item.user_id === "user_workspace_b");
      bobUser.workspace_id = alice.body.workspace_id;
      bobUser.user_id = "user_workspace_a";
      data.sessions.push({
        session_id: "sess_ownerless_workspace_collision",
        workspace_id: alice.body.workspace_id,
        title: "OWNERLESS_COLLISION_PRIVATE"
      }, {
        session_id: "sess_fully_scoped_identity_collision",
        workspace_id: alice.body.workspace_id,
        created_by: "user_workspace_a",
        title: "FULLY_SCOPED_COLLISION_PRIVATE"
      });
      data.workspaceModelSettings.push({
        workspace_id: alice.body.workspace_id,
        agent_output_tokens: 1024,
        final_output_tokens: 2048,
        revision: 1,
        reason: "MODEL_SETTINGS_COLLISION_PRIVATE"
      });
      data.marketplaceRatings.push(
        {
          rating_id: "rating_duplicate_identity_a",
          listing_id: "listing_duplicate_identity_a",
          workspace_id: alice.body.workspace_id,
          created_by: "user_workspace_a",
          marker: "RATING_COLLISION_A_PRIVATE"
        },
        {
          rating_id: "rating_duplicate_identity_b",
          listing_id: "listing_duplicate_identity_b",
          workspace_id: alice.body.workspace_id,
          created_by: "user_workspace_a",
          marker: "RATING_COLLISION_B_PRIVATE"
        }
      );
      data.mcpConnections.push(
        {
          connection_id: "mcpconn_duplicate_identity_a",
          workspace_id: alice.body.workspace_id,
          created_by: "user_workspace_a",
          auth_type: "none",
          marker: "MCP_COLLISION_A_PRIVATE"
        },
        {
          connection_id: "mcpconn_duplicate_identity_b",
          workspace_id: alice.body.workspace_id,
          created_by: "user_workspace_a",
          auth_type: "none",
          marker: "MCP_COLLISION_B_PRIVATE"
        }
      );
      data.identityAuditEvents.push({
        event_id: "identityevt_duplicate_user_collision",
        target_user_id: "user_workspace_a",
        actor_user_id: "user_workspace_a",
        detail: "DUPLICATE_USER_AUDIT_PRIVATE"
      });
      return null;
    });

    const exported = await request(app).get("/api/account/export").set(aliceHeaders).expect(200);
    expect(JSON.stringify(exported.body)).not.toContain("OWNERLESS_COLLISION_PRIVATE");
    expect(JSON.stringify(exported.body)).not.toContain("FULLY_SCOPED_COLLISION_PRIVATE");
    expect(JSON.stringify(exported.body)).not.toContain("RATING_COLLISION_A_PRIVATE");
    expect(JSON.stringify(exported.body)).not.toContain("RATING_COLLISION_B_PRIVATE");
    expect(JSON.stringify(exported.body)).not.toContain("MCP_COLLISION_A_PRIVATE");
    expect(JSON.stringify(exported.body)).not.toContain("MCP_COLLISION_B_PRIVATE");
    expect(JSON.stringify(exported.body)).not.toContain("DUPLICATE_USER_AUDIT_PRIVATE");
    expect(JSON.stringify(exported.body)).not.toContain("MODEL_SETTINGS_COLLISION_PRIVATE");
    expect(exported.body.privacy_filter.omitted_by_collection).toMatchObject({
      workspace_identity_collision: 1,
      user_identity_collision: 1,
      chat_sessions: 2,
      marketplace_ratings: 2,
      mcp_connections: 2
    });
    expect(exported.body.privacy_filter.omitted_by_collection.workspace_model_settings).toBe(1);
    expect(exported.body.privacy_filter.omitted_by_collection.identity_audit_events).toBeGreaterThanOrEqual(1);
    const blocked = await request(app)
      .delete("/api/account")
      .set(aliceHeaders)
      .send({ confirmation: "DELETE" })
      .expect(409);
    expect(blocked.body.error).toBe("account_legacy_scope_ambiguous");
    expect(fake.users.has("user_workspace_a")).toBe(true);
    expect(fake.users.has("user_workspace_b")).toBe(true);

    const webhookBlocked = await request(app)
      .post("/api/webhooks/clerk")
      .set("x-test-webhook-signature", "valid")
      .send({ type: "user.deleted", data: { id: "user_workspace_a" } })
      .expect(409);
    expect(webhookBlocked.body.error).toBe("account_legacy_scope_ambiguous");
    const persisted = app.locals.store.read();
    expect(persisted.mcpConnections).toHaveLength(2);
    expect(persisted.users).toHaveLength(2);
  });

  it("refuses account deletion while a metered request has an active reservation", async () => {
    fake.addUser({ id: "user_busydelete1", email: "busy-delete@example.com", name: "Busy Delete" });
    await startApp();
    const headers = asUser("user_busydelete1");
    await request(app).get("/api/auth/me").set(headers).expect(200);
    await request(app).get("/api/billing/account").set(headers).expect(200);
    const session = await request(app).post("/api/chat/sessions").set(headers).send({ title: "Active request" }).expect(201);
    await request(app)
      .post(`/api/chat/sessions/${session.body.session_id}/messages`)
      .set(headers)
      .send({ content: "Keep this request queued during deletion." })
      .expect(202);

    const rejected = await request(app)
      .delete("/api/account")
      .set(headers)
      .send({ confirmation: "DELETE" })
      .expect(409);
    expect(rejected.body.error).toBe("account_has_active_runs");
    expect(fake.users.has("user_busydelete1")).toBe(true);
    const snapshot = app.locals.store.read();
    expect(snapshot.billingReservations[0].status).toBe("active");
    expect(snapshot.billingAccounts[0].status).toBe("closing");
    expect(snapshot.users[0]).toMatchObject({
      status: "deleting",
      deletion_id: expect.stringMatching(/^deletion_[0-9a-f]{32}$/)
    });
    expect(snapshot.identityDeletionTombstones[0]).toMatchObject({
      status: "deleting",
      provider: "clerk"
    });
    const blockedAfterMarker = await request(app).get("/api/chat/sessions").set(headers).expect(409);
    expect(blockedAfterMarker.body.error).toBe("account_deletion_in_progress");
  });

  it("keeps product roles local while Clerk handles suspension and session revocation", async () => {
    process.env.APP_AUTH_ADMIN_EMAILS = "admin@example.com";
    fake.addUser({ id: "user_admin00001", email: "admin@example.com", name: "Administrator" });
    fake.addUser({ id: "user_member0001", email: "member@example.com", name: "Member" });
    await startApp();
    const adminHeaders = asUser("user_admin00001", "sess_admin");
    const memberHeaders = asUser("user_member0001", "sess_member");
    await request(app).get("/api/auth/me").set(adminHeaders).expect(200);
    await request(app).get("/api/auth/me").set(memberHeaders).expect(200);

    await request(app).get("/api/admin/users").set(memberHeaders).expect(403);
    const users = await request(app).get("/api/admin/users").set(adminHeaders).expect(200);
    const member = users.body.users.find((candidate) => candidate.email === "member@example.com");
    expect(users.body.users).toHaveLength(2);
    expect(member.active_sessions).toBeNull();

    await request(app)
      .patch(`/api/admin/users/${member.user_id}`)
      .set(adminHeaders)
      .send({ status: "suspended" })
      .expect(200);
    expect(fake.users.get("user_member0001").banned).toBe(true);
    await request(app).get("/api/auth/me").set(memberHeaders).expect(403);

    await request(app)
      .patch(`/api/admin/users/${member.user_id}`)
      .set(adminHeaders)
      .send({ status: "active", role: "viewer" })
      .expect(200);
    expect(fake.users.get("user_member0001").banned).toBe(false);
    await request(app).get("/api/account/export").set(memberHeaders).expect(200);
    await request(app).post("/api/chat/sessions").set(memberHeaders).send({ title: "Blocked" }).expect(403);

    fake.sessions.push({ id: "sess_member", userId: "user_member0001", status: "active" });
    const revoked = await request(app)
      .post(`/api/admin/users/${member.user_id}/revoke-sessions`)
      .set(adminHeaders)
      .send({})
      .expect(200);
    expect(revoked.body.revoked).toBe(1);
    expect(fake.sessions[0].status).toBe("revoked");

    const adminIdentity = await request(app).get("/api/auth/me").set(adminHeaders).expect(200);
    await request(app)
      .patch(`/api/admin/users/${adminIdentity.body.user_id}`)
      .set(adminHeaders)
      .send({ status: "suspended" })
      .expect(409);
  });

  it("syncs signed Clerk webhooks and cascades provider-side deletion", async () => {
    fake.addUser({ id: "user_webhook001", email: "webhook@example.com", name: "Before" });
    await startApp();
    const headers = asUser("user_webhook001");
    await request(app).get("/api/auth/me").set(headers).expect(200);
    await request(app).post("/api/chat/sessions").set(headers).send({ title: "Delete on webhook" }).expect(201);

    const updated = { ...fake.users.get("user_webhook001"), firstName: "After" };
    fake.users.set(updated.id, updated);
    await request(app)
      .post("/api/webhooks/clerk")
      .set("x-test-webhook-signature", "valid")
      .send({ type: "user.updated", data: updated })
      .expect(200);
    const synced = app.locals.store.read((data) => data.users.find((user) => user.clerk_user_id === updated.id));
    expect(synced.display_name).toBe("After");

    await request(app)
      .post("/api/webhooks/clerk")
      .send({ type: "user.updated", data: updated })
      .expect(400);

    fake.users.delete(updated.id);
    await request(app)
      .post("/api/webhooks/clerk")
      .set("x-test-webhook-signature", "valid")
      .send({ type: "user.deleted", data: { id: updated.id } })
      .expect(200);
    const persisted = app.locals.store.read();
    expect(persisted.users).toEqual([]);
    expect(persisted.sessions).toEqual([]);
    expect(persisted.identityDeletionTombstones).toHaveLength(1);
    expect(persisted.identityDeletionTombstones[0]).not.toHaveProperty("provider_user_id");

    await request(app)
      .post("/api/webhooks/clerk")
      .set("x-test-webhook-signature", "valid")
      .send({ type: "user.updated", data: updated })
      .expect(200);
    expect(app.locals.store.read().users).toEqual([]);
  });

  it("preserves configured service bearer tokens without invoking Clerk", async () => {
    process.env.APP_API_TOKENS_JSON = JSON.stringify({
      "service-token-that-is-long-enough": {
        user_id: "service_user",
        workspace_id: "service_workspace",
        role: "admin"
      }
    });
    await startApp();
    const me = await request(app)
      .get("/api/auth/me")
      .set("Authorization", "Bearer service-token-that-is-long-enough")
      .expect(200);
    expect(me.body).toMatchObject({
      user_id: "service_user",
      workspace_id: "service_workspace",
      auth_type: "bearer",
      is_admin: true
    });
    expect(fake.middlewareCalls).toBe(0);
  });

  it("fails closed when production Clerk configuration is incomplete or uses development keys", () => {
    const devPublishableKey = buildPublishableKey("happy-clerk-13.clerk.accounts.dev");
    const livePublishableKey = buildPublishableKey("clerk.example.com");
    const fixtureSecretKey = (environment) => [
      "sk",
      environment,
      "fixture",
      "validation",
      "value",
      "not",
      "a",
      "credential"
    ].join("_");
    const fixtureWebhookSecret = [
      "whsec",
      "fixture",
      "validation",
      "value",
      "not",
      "a",
      "credential"
    ].join("_");
    const base = {
      NODE_ENV: "production",
      APP_IDENTITY_PROVIDER: "clerk",
      APP_PUBLIC_ORIGIN: "https://app.example.com",
      CLERK_AUTHORIZED_PARTIES: "https://app.example.com",
      APP_AUTH_ADMIN_EMAILS: "admin@example.com",
      CLERK_WEBHOOK_SIGNING_SECRET: fixtureWebhookSecret
    };
    expect(() => validateClerkEnvironment({
      ...base,
      CLERK_PUBLISHABLE_KEY: devPublishableKey,
      CLERK_SECRET_KEY: fixtureSecretKey("test")
    })).toThrow(/pk_live_ and sk_live_/);
    expect(() => validateClerkEnvironment({
      ...base,
      CLERK_PUBLISHABLE_KEY: livePublishableKey,
      CLERK_SECRET_KEY: fixtureSecretKey("live"),
      CLERK_WEBHOOK_SIGNING_SECRET: ""
    })).toThrow(/webhook/i);
    expect(() => validateClerkEnvironment({
      ...base,
      CLERK_PUBLISHABLE_KEY: livePublishableKey,
      CLERK_SECRET_KEY: fixtureSecretKey("live")
    })).not.toThrow();
    expect(() => validateClerkEnvironment({
      ...base,
      CLERK_PUBLISHABLE_KEY: livePublishableKey,
      VITE_CLERK_PUBLISHABLE_KEY: buildPublishableKey("different-clerk.example.com"),
      CLERK_SECRET_KEY: fixtureSecretKey("live")
    })).toThrow(/same Clerk application/);
  });
});

async function waitForStoredRun(targetApp, runId) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const run = targetApp.locals.store.read((data) => data.runs.find((item) => item.run_id === runId));
    if (["completed", "failed"].includes(run?.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Run ${runId} did not finish.`);
}

async function waitForStoredUserStatus(targetApp, clerkUserId, status) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const user = targetApp.locals.store.read((data) => data.users.find((item) => (
      item.clerk_user_id === clerkUserId
    )));
    if (user?.status === status) return user;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Clerk user ${clerkUserId} did not reach ${status}.`);
}

function createFakeClerk() {
  const state = {
    users: new Map(),
    sessions: [],
    middlewareCalls: 0,
    deleteUserCalls: 0,
    deleteUserFailures: 0,
    deleteUserDelayMs: 0,
    addUser({ id, email, name }) {
      const timestamp = Date.now();
      const emailId = `idn_${id}`;
      const user = {
        id,
        firstName: name,
        lastName: "",
        imageUrl: `https://images.example.test/${id}.png`,
        primaryEmailAddressId: emailId,
        emailAddresses: [{
          id: emailId,
          emailAddress: email,
          verification: { status: "verified" }
        }],
        banned: false,
        createdAt: timestamp,
        updatedAt: timestamp,
        lastSignInAt: timestamp
      };
      state.users.set(id, user);
      return user;
    }
  };

  const notFound = () => Object.assign(new Error("Clerk user not found"), { status: 404 });
  const client = {
    users: {
      async getUser(userId) {
        const user = state.users.get(userId);
        if (!user) throw notFound();
        return user;
      },
      async deleteUser(userId) {
        state.deleteUserCalls += 1;
        if (state.deleteUserDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, state.deleteUserDelayMs));
        }
        if (state.deleteUserFailures > 0) {
          state.deleteUserFailures -= 1;
          throw Object.assign(new Error("Synthetic Clerk deletion failure"), {
            status: 502,
            code: "synthetic_provider_failure"
          });
        }
        if (!state.users.delete(userId)) throw notFound();
        return { id: userId, deleted: true };
      },
      async banUser(userId) {
        const user = state.users.get(userId);
        if (!user) throw notFound();
        user.banned = true;
        return user;
      },
      async unbanUser(userId) {
        const user = state.users.get(userId);
        if (!user) throw notFound();
        user.banned = false;
        return user;
      },
      async updateUserMetadata(userId, metadata) {
        const user = state.users.get(userId);
        if (!user) throw notFound();
        user.privateMetadata = metadata.privateMetadata;
        return user;
      }
    },
    sessions: {
      async getSessionList({ userId, status }) {
        return { data: state.sessions.filter((session) => session.userId === userId && (!status || session.status === status)) };
      },
      async revokeSession(sessionId) {
        const session = state.sessions.find((candidate) => candidate.id === sessionId);
        if (!session) throw Object.assign(new Error("Session not found"), { status: 404 });
        session.status = "revoked";
        return session;
      }
    }
  };
  state.adapter = {
    enabled: true,
    client,
    middleware(req, _res, next) {
      state.middlewareCalls += 1;
      next();
    },
    getAuth(req) {
      const userId = String(req.headers["x-test-clerk-user-id"] || "");
      if (!userId || !state.users.has(userId)) return { isAuthenticated: false, userId: null, sessionId: null };
      return {
        isAuthenticated: true,
        userId,
        sessionId: String(req.headers["x-test-clerk-session-id"] || `sess_${userId}`)
      };
    },
    async verifyWebhook(req) {
      if (req.headers["x-test-webhook-signature"] !== "valid") {
        throw Object.assign(new Error("Invalid Clerk webhook signature"), { status: 400, code: "invalid_webhook" });
      }
      const body = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : req.body;
      return typeof body === "string" ? JSON.parse(body) : body;
    }
  };
  return state;
}

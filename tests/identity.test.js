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
  "PORT",
  "WEB_STORE_DRIVER",
  "TCAR_ENGINE_MODE"
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
    "PORT"
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

async function startApp(adapter = fake.adapter) {
  app = await createApp({
    dbPath: path.join(tmpDir, "db.json"),
    uploadRoot: path.join(tmpDir, "uploads"),
    autoRun: false,
    clerkAdapter: adapter
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
    await request(app).post("/api/chat/sessions").set(headers).send({ title: "Exported chat" }).expect(201);
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

    const exported = await request(app).get("/api/account/export").set(headers).expect(200);
    expect(exported.headers["content-disposition"]).toContain("virenis-account-export");
    expect(exported.body.authentication).toMatchObject({ provider: "clerk", provider_user_id: "user_delete0001" });
    expect(exported.body.chats.sessions[0].title).toBe("Exported chat");
    expect(exported.body.billing.accounts[0]).toMatchObject({
      user_id: "user_delete0001",
      available_micros: 1_000_000_000
    });
    expect(exported.body.billing.ledger_entries.map((entry) => entry.type)).toContain("welcome_grant");
    expect(JSON.stringify(exported.body)).not.toMatch(/password|token_hash|credential|ciphertext/);

    await request(app).delete("/api/account").set(headers).send({ confirmation: "delete" }).expect(400);
    const deleted = await request(app).delete("/api/account").set(headers).send({ confirmation: "DELETE" }).expect(200);
    expect(deleted.body.deleted_counts).toMatchObject({ chat_sessions: 1, agents: 1 });
    expect(fake.users.has("user_delete0001")).toBe(false);
    const persisted = app.locals.store.read();
    expect(persisted.users).toEqual([]);
    expect(persisted.sessions).toEqual([]);
    expect(persisted.billingAccounts).toEqual([]);
    expect(persisted.billingLedgerEntries).toEqual([]);
    expect(persisted.agents.some((agent) => agent.id === "delete_me_agent")).toBe(false);
    await request(app).get("/api/auth/me").set(headers).expect(401);
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
    expect(snapshot.billingAccounts[0].status).toBe("active");
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

function createFakeClerk() {
  const state = {
    users: new Map(),
    sessions: [],
    middlewareCalls: 0,
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

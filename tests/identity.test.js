import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../server/app.js";
import { sessionCookie, validateIdentityEnvironment } from "../server/identity.js";

const PASSWORD = "correct horse battery staple";
const NEW_PASSWORD = "new river lantern keepsake";
const ENV_KEYS = [
  "APP_IDENTITY_ENABLED",
  "APP_AUTH_REGISTRATION_ENABLED",
  "APP_AUTH_EMAIL_MODE",
  "APP_AUTH_ADMIN_EMAILS",
  "APP_AUTH_SCRYPT_N",
  "APP_AUTH_SMTP_HOST",
  "APP_AUTH_SMTP_PORT",
  "APP_AUTH_SMTP_REQUIRE_TLS",
  "APP_AUTH_SMTP_USER",
  "APP_AUTH_SMTP_PASSWORD",
  "APP_AUTH_SMTP_PASSWORD_FILE",
  "APP_AUTH_SMTP_URL",
  "APP_AUTH_SMTP_URL_FILE",
  "APP_AUTH_EMAIL_FROM",
  "APP_AUTH_SMTP_TLS_REJECT_UNAUTHORIZED",
  "APP_API_TOKENS_JSON",
  "APP_API_TOKENS",
  "APP_BASIC_AUTH_USER",
  "APP_BASIC_AUTH_PASSWORD",
  "WEB_STORE_DRIVER"
];

let previousEnv;
let tmpDir;
let app;
let smtpServer;

beforeEach(async () => {
  previousEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.APP_IDENTITY_ENABLED = "1";
  process.env.APP_AUTH_EMAIL_MODE = "capture";
  process.env.APP_AUTH_SCRYPT_N = "4096";
  process.env.WEB_STORE_DRIVER = "json";
  delete process.env.APP_AUTH_REGISTRATION_ENABLED;
  delete process.env.APP_AUTH_ADMIN_EMAILS;
  delete process.env.APP_AUTH_SMTP_HOST;
  delete process.env.APP_AUTH_SMTP_PORT;
  delete process.env.APP_AUTH_SMTP_REQUIRE_TLS;
  delete process.env.APP_AUTH_SMTP_USER;
  delete process.env.APP_AUTH_SMTP_PASSWORD;
  delete process.env.APP_AUTH_SMTP_PASSWORD_FILE;
  delete process.env.APP_AUTH_SMTP_URL;
  delete process.env.APP_AUTH_SMTP_URL_FILE;
  delete process.env.APP_API_TOKENS_JSON;
  delete process.env.APP_API_TOKENS;
  delete process.env.APP_BASIC_AUTH_USER;
  delete process.env.APP_BASIC_AUTH_PASSWORD;
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "virenis-identity-"));
});

afterEach(async () => {
  await app?.locals?.store?.close?.();
  app = null;
  if (smtpServer) {
    await new Promise((resolve) => smtpServer.close(resolve));
    smtpServer = null;
  }
  for (const [key, value] of Object.entries(previousEnv || {})) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function startApp() {
  app = await createApp({
    dbPath: path.join(tmpDir, "db.json"),
    uploadRoot: path.join(tmpDir, "uploads"),
    autoRun: false
  });
  return app;
}

async function registerAndVerify(client, email, { displayName = "Test User", password = PASSWORD } = {}) {
  await client
    .post("/api/auth/register")
    .send({ email, display_name: displayName, password })
    .expect(202);
  const message = [...app.locals.identityOutbox].reverse().find((item) => item.kind === "verification" && item.to === email);
  expect(message?.token).toBeTruthy();
  await client.post("/api/auth/verify-email").send({ token: message.token }).expect(200);
  return message;
}

async function login(client, email, password = PASSWORD, status = 200) {
  return client
    .post("/api/auth/login")
    .set("User-Agent", "Virenis identity test browser")
    .send({ email, password })
    .expect(status);
}

async function startSmtpCapture() {
  const messages = [];
  smtpServer = net.createServer((socket) => {
    let buffer = "";
    let dataMode = false;
    socket.setEncoding("utf8");
    socket.write("220 localhost ESMTP\r\n");
    socket.on("data", (chunk) => {
      buffer += chunk;
      while (buffer) {
        if (dataMode) {
          const end = buffer.indexOf("\r\n.\r\n");
          if (end < 0) return;
          messages.push(buffer.slice(0, end));
          buffer = buffer.slice(end + 5);
          dataMode = false;
          socket.write("250 queued\r\n");
          continue;
        }
        const lineEnd = buffer.indexOf("\r\n");
        if (lineEnd < 0) return;
        const line = buffer.slice(0, lineEnd);
        buffer = buffer.slice(lineEnd + 2);
        const command = line.split(" ")[0].toUpperCase();
        if (command === "EHLO" || command === "HELO") socket.write("250-localhost\r\n250 PIPELINING\r\n");
        else if (command === "MAIL" || command === "RCPT" || command === "RSET") socket.write("250 ok\r\n");
        else if (command === "DATA") { dataMode = true; socket.write("354 end with <CRLF>.<CRLF>\r\n"); }
        else if (command === "QUIT") { socket.write("221 bye\r\n"); socket.end(); }
        else socket.write("250 ok\r\n");
      }
    });
  });
  await new Promise((resolve, reject) => {
    smtpServer.once("error", reject);
    smtpServer.listen(0, "127.0.0.1", resolve);
  });
  return { port: smtpServer.address().port, messages };
}

describe("self-service identity", () => {
  it("delivers verification links through the configured SMTP transport", async () => {
    const smtp = await startSmtpCapture();
    process.env.APP_AUTH_EMAIL_MODE = "smtp";
    process.env.APP_AUTH_EMAIL_FROM = "Virenis <no-reply@example.test>";
    process.env.APP_AUTH_SMTP_HOST = "127.0.0.1";
    process.env.APP_AUTH_SMTP_PORT = String(smtp.port);
    process.env.APP_AUTH_SMTP_REQUIRE_TLS = "0";
    await startApp();
    await request(app)
      .post("/api/auth/register")
      .send({ email: "smtp@example.test", display_name: "SMTP User", password: PASSWORD })
      .expect(202);
    expect(smtp.messages).toHaveLength(1);
    expect(smtp.messages[0]).toContain("Subject: Verify your Virenis email");
    expect(smtp.messages[0].replaceAll("=\r\n", "")).toContain("/verify-email#token=3D");
  });

  it("registers, verifies, signs in, and isolates each user's private workspace", async () => {
    await startApp();
    const alice = request.agent(app);
    const bob = request.agent(app);

    const config = await request(app).get("/api/auth/config").expect(200);
    expect(config.body).toEqual({
      self_service_enabled: true,
      registration_enabled: true,
      email_verification_required: true,
      password_min_characters: 15
    });
    await alice
      .post("/api/auth/register")
      .send({ email: "alice@example.com", password: "too-short" })
      .expect(400);

    await alice
      .post("/api/auth/register")
      .send({ email: "Alice@Example.com", display_name: "Alice", password: PASSWORD })
      .expect(202);
    const verification = app.locals.identityOutbox.at(-1);
    expect(verification.to).toBe("alice@example.com");
    expect(verification.url).toContain("/verify-email#token=");
    const persistedBeforeVerification = JSON.stringify(app.locals.store.read());
    expect(persistedBeforeVerification).not.toContain(PASSWORD);
    expect(persistedBeforeVerification).not.toContain(verification.token);

    const unverified = await login(alice, "alice@example.com", PASSWORD, 403);
    expect(unverified.body.error).toBe("email_not_verified");
    await alice.post("/api/auth/verify-email").send({ token: verification.token }).expect(200);
    await alice.post("/api/auth/verify-email").send({ token: verification.token }).expect(400);
    const signedIn = await login(alice, "alice@example.com");
    expect(signedIn.headers["set-cookie"][0]).toContain("HttpOnly");
    expect(signedIn.headers["set-cookie"][0]).toContain("SameSite=Lax");

    const aliceIdentity = await alice.get("/api/auth/me").expect(200);
    expect(aliceIdentity.body).toMatchObject({
      email: "alice@example.com",
      display_name: "Alice",
      auth_type: "session",
      role: "user",
      email_verified: true
    });
    await alice.patch("/api/account/profile").send({ display_name: "Alice Updated" }).expect(200);
    const updatedIdentity = await alice.get("/api/auth/me").expect(200);
    expect(updatedIdentity.body.display_name).toBe("Alice Updated");
    const aliceChat = await alice.post("/api/chat/sessions").send({ title: "Alice private chat" }).expect(201);
    expect(aliceChat.body.workspace_id).toBe(aliceIdentity.body.workspace_id);
    expect(aliceChat.body.created_by).toBe(aliceIdentity.body.user_id);

    await registerAndVerify(bob, "bob@example.com", { displayName: "Bob" });
    await login(bob, "bob@example.com");
    const bobIdentity = await bob.get("/api/auth/me").expect(200);
    expect(bobIdentity.body.workspace_id).not.toBe(aliceIdentity.body.workspace_id);
    const bobChats = await bob.get("/api/chat/sessions").expect(200);
    expect(bobChats.body.sessions).toEqual([]);
    await bob.get(`/api/chat/sessions/${aliceChat.body.session_id}`).expect(404);
  });

  it("lists and revokes browser sessions, resets passwords, and invalidates old credentials", async () => {
    await startApp();
    const firstBrowser = request.agent(app);
    const secondBrowser = request.agent(app);
    await registerAndVerify(firstBrowser, "sessions@example.com");
    await login(firstBrowser, "sessions@example.com");
    await login(secondBrowser, "sessions@example.com");

    const sessions = await secondBrowser.get("/api/account/sessions").expect(200);
    expect(sessions.body.sessions).toHaveLength(2);
    expect(sessions.body.sessions.filter((item) => item.current)).toHaveLength(1);
    const revoked = await secondBrowser.post("/api/account/sessions/revoke-others").send({}).expect(200);
    expect(revoked.body.revoked).toBe(1);
    await firstBrowser.get("/api/auth/me").expect(401);
    await secondBrowser.get("/api/auth/me").expect(200);

    await request(app).post("/api/auth/forgot-password").send({ email: "sessions@example.com" }).expect(202);
    const reset = [...app.locals.identityOutbox].reverse().find((item) => item.kind === "password_reset");
    expect(reset.url).toContain("/reset-password#token=");
    await request(app)
      .post("/api/auth/reset-password")
      .send({ token: reset.token, password: NEW_PASSWORD })
      .expect(200);
    await request(app)
      .post("/api/auth/reset-password")
      .send({ token: reset.token, password: NEW_PASSWORD })
      .expect(400);
    await secondBrowser.get("/api/auth/me").expect(401);
    await login(request.agent(app), "sessions@example.com", PASSWORD, 401);
    const newBrowser = request.agent(app);
    await login(newBrowser, "sessions@example.com", NEW_PASSWORD);
    await newBrowser.get("/api/auth/me").expect(200);
    const logout = await newBrowser.post("/api/auth/logout").send({}).expect(200);
    expect(logout.headers["set-cookie"][0]).toContain("Max-Age=0");
    await newBrowser.get("/api/auth/me").expect(401);
  });

  it("exports account data without credentials and permanently deletes owned data", async () => {
    await startApp();
    const browser = request.agent(app);
    await registerAndVerify(browser, "delete-me@example.com", { displayName: "Delete Me" });
    await login(browser, "delete-me@example.com");
    await browser.post("/api/chat/sessions").send({ title: "Exported chat" }).expect(201);
    await browser.post("/api/agents").send({
      id: "delete_me_agent",
      title: "Delete me agent",
      capability: "A private test agent",
      boundary: "Only test deletion.",
      routing_cues: "delete test",
      consumes: ["user_request"],
      produces: ["domain_outputs"],
      tools: []
    }).expect(201);

    const exported = await browser.get("/api/account/export").expect(200);
    expect(exported.headers["content-disposition"]).toContain("virenis-account-export");
    expect(exported.body.account.email).toBe("delete-me@example.com");
    expect(exported.body.chats.sessions[0].title).toBe("Exported chat");
    expect(JSON.stringify(exported.body)).not.toMatch(/password_hash|token_hash|credential|ciphertext/);

    await browser.delete("/api/account").send({ confirmation: "DELETE", password: "wrong password here" }).expect(400);
    const deleted = await browser
      .delete("/api/account")
      .send({ confirmation: "DELETE", password: PASSWORD })
      .expect(200);
    expect(deleted.body.deleted_counts).toMatchObject({ chat_sessions: 1, agents: 1 });
    await browser.get("/api/auth/me").expect(401);
    const persisted = app.locals.store.read();
    expect(persisted.users).toEqual([]);
    expect(persisted.authSessions).toEqual([]);
    expect(persisted.sessions).toEqual([]);
    expect(persisted.agents.some((agent) => agent.id === "delete_me_agent")).toBe(false);

    await request(app)
      .post("/api/auth/register")
      .send({ email: "delete-me@example.com", display_name: "New account", password: NEW_PASSWORD })
      .expect(202);
  });

  it("allows administrators to inspect, verify, suspend, reactivate, and revoke user sessions", async () => {
    process.env.APP_AUTH_ADMIN_EMAILS = "admin@example.com";
    await startApp();
    const admin = request.agent(app);
    const user = request.agent(app);
    await registerAndVerify(admin, "admin@example.com", { displayName: "Administrator" });
    await registerAndVerify(user, "member@example.com", { displayName: "Member" });
    await login(admin, "admin@example.com");
    await login(user, "member@example.com");

    await user.get("/api/admin/users").expect(403);
    const users = await admin.get("/api/admin/users").expect(200);
    expect(users.body.users).toHaveLength(2);
    const member = users.body.users.find((candidate) => candidate.email === "member@example.com");
    expect(member.active_sessions).toBe(1);

    const suspended = await admin
      .patch(`/api/admin/users/${member.user_id}`)
      .send({ status: "suspended" })
      .expect(200);
    expect(suspended.body.user.status).toBe("suspended");
    await user.get("/api/auth/me").expect(401);

    await admin
      .patch(`/api/admin/users/${member.user_id}`)
      .send({ status: "active", role: "viewer", email_verified: true })
      .expect(200);
    const viewer = request.agent(app);
    await login(viewer, "member@example.com");
    await viewer.patch("/api/account/profile").send({ display_name: "Read-only Member" }).expect(200);
    await viewer.post("/api/chat/sessions").send({ title: "Blocked" }).expect(403);
    const revoked = await admin.post(`/api/admin/users/${member.user_id}/revoke-sessions`).send({}).expect(200);
    expect(revoked.body.revoked).toBe(1);
    await viewer.get("/api/auth/me").expect(401);

    const adminIdentity = await admin.get("/api/auth/me").expect(200);
    await admin
      .patch(`/api/admin/users/${adminIdentity.body.user_id}`)
      .send({ status: "suspended" })
      .expect(409);
  });

  it("locks repeated password attacks and validates fail-closed production email settings", async () => {
    await startApp();
    const browser = request.agent(app);
    await registerAndVerify(browser, "lock@example.com");
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await login(request.agent(app), "lock@example.com", "incorrect password value", 401);
    }
    const locked = await login(browser, "lock@example.com", PASSWORD, 429);
    expect(locked.body.error).toBe("account_temporarily_locked");

    expect(() => validateIdentityEnvironment({
      NODE_ENV: "production",
      APP_IDENTITY_ENABLED: "1",
      APP_AUTH_EMAIL_MODE: "capture"
    })).toThrow(/APP_AUTH_EMAIL_MODE=smtp/);
    expect(() => validateIdentityEnvironment({
      NODE_ENV: "production",
      APP_IDENTITY_ENABLED: "1",
      APP_AUTH_EMAIL_MODE: "smtp",
      APP_AUTH_EMAIL_FROM: "Virenis <hello@example.com>",
      APP_AUTH_SMTP_HOST: "smtp.example.com",
      APP_AUTH_ADMIN_EMAILS: "admin@example.com",
      APP_AUTH_SMTP_TLS_REJECT_UNAUTHORIZED: "0"
    })).toThrow(/certificate verification/);
    expect(() => validateIdentityEnvironment({
      NODE_ENV: "production",
      APP_IDENTITY_ENABLED: "1",
      APP_AUTH_EMAIL_MODE: "smtp",
      APP_AUTH_EMAIL_FROM: "Virenis <hello@example.com>",
      APP_AUTH_SMTP_HOST: "smtp.example.com",
      APP_AUTH_ADMIN_EMAILS: "admin@example.com"
    })).not.toThrow();
    expect(sessionCookie("browser-secret", { NODE_ENV: "production", APP_AUTH_SESSION_DAYS: "30" }))
      .toContain("__Host-virenis_session=browser-secret; Path=/; HttpOnly; SameSite=Lax; Secure");
  });
});

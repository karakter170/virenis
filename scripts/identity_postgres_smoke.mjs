#!/usr/bin/env node
/* global console, process */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import request from "supertest";
import { createApp } from "../server/app.js";

const { Pool } = pg;
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for identity_postgres_smoke.mjs");

const suffix = `${process.pid}_${Date.now()}`;
const tableName = `tcar_identity_smoke_${process.pid}`;
const storeKey = `identity_${suffix}`;
const email = `identity-${suffix}@example.test`;
const password = "identity smoke passphrase";
const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "virenis-identity-pg-"));
const pool = new Pool({ connectionString, max: 1 });
let app;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

try {
  process.env.WEB_STORE_DRIVER = "postgres";
  process.env.WEB_DB_TABLE = tableName;
  process.env.WEB_DB_STORE_KEY = storeKey;
  process.env.APP_IDENTITY_ENABLED = "1";
  process.env.APP_AUTH_EMAIL_MODE = "capture";
  process.env.APP_AUTH_SCRYPT_N = "4096";
  process.env.TCAR_ENGINE_MODE = "simulator";
  delete process.env.APP_BASIC_AUTH_USER;
  delete process.env.APP_BASIC_AUTH_PASSWORD;
  delete process.env.APP_API_TOKENS;
  delete process.env.APP_API_TOKENS_JSON;

  app = await createApp({
    dbPath: path.join(tmpDir, "unused.json"),
    uploadRoot: path.join(tmpDir, "uploads"),
    autoRun: false
  });
  const browser = request.agent(app);
  await browser.post("/api/auth/register").send({
    email,
    display_name: "Postgres Identity Smoke",
    password
  }).expect(202);
  const verification = app.locals.identityOutbox.find((message) => message.kind === "verification" && message.to === email);
  assert(verification?.token, "verification email was not captured");
  await browser.post("/api/auth/verify-email").send({ token: verification.token }).expect(200);
  await browser.post("/api/auth/login").send({ email, password }).expect(200);
  const identity = await browser.get("/api/auth/me").expect(200);
  assert(identity.body.auth_type === "session", "browser session identity was not restored");
  const chat = await browser.post("/api/chat/sessions").send({ title: "Postgres identity smoke" }).expect(201);
  assert(chat.body.workspace_id === identity.body.workspace_id, "chat escaped the registered workspace");
  const exported = await browser.get("/api/account/export").expect(200);
  assert(exported.body.account.email === email, "account export did not contain the registered profile");
  assert(!JSON.stringify(exported.body).includes("password_hash"), "account export leaked a password hash");
  await browser.delete("/api/account").send({ confirmation: "DELETE", password }).expect(200);
  await browser.get("/api/auth/me").expect(401);
  const persisted = app.locals.store.read();
  assert(persisted.users.length === 0, "deleted account remained in the Postgres snapshot");
  assert(persisted.sessions.length === 0, "deleted account chat remained in the Postgres snapshot");
  console.log(JSON.stringify({
    ok: true,
    postgres_identity_persisted: true,
    email_verification: true,
    browser_session: true,
    workspace_isolation: true,
    export_redacted: true,
    account_deleted: true
  }, null, 2));
} finally {
  await app?.locals?.store?.close?.();
  await pool.query(`DROP TABLE IF EXISTS ${tableName}`).catch(() => undefined);
  await pool.end();
  await fs.rm(tmpDir, { recursive: true, force: true });
}

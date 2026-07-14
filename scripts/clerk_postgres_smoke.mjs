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
if (!connectionString) throw new Error("DATABASE_URL is required for clerk_postgres_smoke.mjs");

const suffix = `${process.pid}_${Date.now()}`;
const tableName = `tcar_clerk_smoke_${process.pid}`;
const storeKey = `clerk_${suffix}`;
const userId = `user_postgres_${suffix}`;
const email = `clerk-${suffix}@example.test`;
const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "virenis-clerk-pg-"));
const pool = new Pool({ connectionString, max: 1 });
let app;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const clerkUser = {
  id: userId,
  firstName: "Postgres Clerk Smoke",
  primaryEmailAddressId: `idn_${suffix}`,
  emailAddresses: [{ id: `idn_${suffix}`, emailAddress: email, verification: { status: "verified" } }],
  banned: false,
  createdAt: Date.now(),
  updatedAt: Date.now()
};
let providerDeleted = false;
const client = {
  users: {
    async getUser(id) {
      if (providerDeleted || id !== userId) throw Object.assign(new Error("Clerk user not found"), { status: 404 });
      return clerkUser;
    },
    async deleteUser(id) {
      if (id !== userId) throw Object.assign(new Error("Clerk user not found"), { status: 404 });
      providerDeleted = true;
      return { id, deleted: true };
    }
  }
};
const clerkAdapter = {
  enabled: true,
  client,
  middleware(_req, _res, next) { next(); },
  getAuth(req) {
    const signedIn = !providerDeleted && req.headers["x-smoke-clerk-user"] === userId;
    return signedIn
      ? { isAuthenticated: true, userId, sessionId: `sess_${suffix}` }
      : { isAuthenticated: false, userId: null, sessionId: null };
  },
  async verifyWebhook() { throw Object.assign(new Error("Not configured in smoke test"), { status: 503 }); }
};

try {
  process.env.WEB_STORE_DRIVER = "postgres";
  process.env.WEB_DB_TABLE = tableName;
  process.env.WEB_DB_STORE_KEY = storeKey;
  process.env.APP_IDENTITY_PROVIDER = "clerk";
  process.env.TCAR_ENGINE_MODE = "simulator";
  delete process.env.APP_BASIC_AUTH_USER;
  delete process.env.APP_BASIC_AUTH_PASSWORD;
  delete process.env.APP_API_TOKENS;
  delete process.env.APP_API_TOKENS_JSON;

  app = await createApp({
    dbPath: path.join(tmpDir, "unused.json"),
    uploadRoot: path.join(tmpDir, "uploads"),
    autoRun: false,
    clerkAdapter
  });
  const headers = { "x-smoke-clerk-user": userId, Origin: "http://localhost:5173" };
  const identity = await request(app).get("/api/auth/me").set(headers).expect(200);
  assert(identity.body.auth_type === "clerk", "Clerk identity was not linked");
  const chat = await request(app).post("/api/chat/sessions").set(headers).send({ title: "Postgres Clerk smoke" }).expect(201);
  assert(chat.body.workspace_id === identity.body.workspace_id, "chat escaped the Clerk user's workspace");
  const exported = await request(app).get("/api/account/export").set(headers).expect(200);
  assert(exported.body.account.email === email, "account export did not contain the Clerk profile");
  assert(!JSON.stringify(exported.body).includes("password_hash"), "account export leaked a legacy password hash");
  await request(app).delete("/api/account").set(headers).send({ confirmation: "DELETE" }).expect(200);
  const persisted = app.locals.store.read();
  assert(providerDeleted, "Clerk provider account was not deleted");
  assert(persisted.users.length === 0, "deleted account remained in the Postgres snapshot");
  assert(persisted.sessions.length === 0, "deleted account chat remained in the Postgres snapshot");
  console.log(JSON.stringify({
    ok: true,
    postgres_identity_persisted: true,
    clerk_provisioning: true,
    workspace_isolation: true,
    export_redacted: true,
    provider_and_workspace_deleted: true
  }, null, 2));
} finally {
  await app?.locals?.store?.close?.();
  await pool.query(`DROP TABLE IF EXISTS ${tableName}`).catch(() => undefined);
  await pool.end();
  await fs.rm(tmpDir, { recursive: true, force: true });
}

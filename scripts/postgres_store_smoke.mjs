#!/usr/bin/env node
/* global console, process */
import pg from "pg";
import { seedAgents } from "../server/catalog.js";
import { PostgresStore } from "../server/store.js";

const { Pool } = pg;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function safeIdentifier(value) {
  const identifier = String(value || "").trim();
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(identifier)) {
    throw new Error(`Unsafe SQL identifier: ${identifier}`);
  }
  return identifier;
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is required for postgres_store_smoke.mjs");
}

const tableName = safeIdentifier(process.env.WEB_DB_SMOKE_TABLE || `tcar_app_store_smoke_${process.pid}`);
const storeKey = `smoke_${Date.now()}_${Math.random().toString(16).slice(2)}`;
const dropTable = process.env.WEB_DB_SMOKE_DROP_TABLE !== "0";
const pool = new Pool({ connectionString });

try {
  const first = new PostgresStore({
    connectionString,
    tableName,
    storeKey,
    seedAgents
  });
  await first.init();
  const initial = first.read();
  assert(initial.agents.length >= seedAgents.length, "seed agents were not initialized");

  const sessionId = "sess_pg_smoke";
  await first.mutate((data) => {
    data.sessions.push({
      session_id: sessionId,
      title: "Postgres smoke",
      workspace_id: "workspace_pg_smoke",
      visibility: "private",
      created_by: "postgres_smoke",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      last_message_at: new Date().toISOString(),
      shared_memory: []
    });
    return { inserted: sessionId };
  });
  await first.close();

  const second = new PostgresStore({
    connectionString,
    tableName,
    storeKey,
    seedAgents
  });
  await second.init();
  const persisted = second.read();
  assert(persisted.sessions.some((session) => session.session_id === sessionId), "session did not persist across store instances");

  await second.mutate((data) => {
    const session = data.sessions.find((item) => item.session_id === sessionId);
    session.title = "Postgres smoke updated";
    return session;
  });
  assert(second.read().sessions.find((session) => session.session_id === sessionId).title === "Postgres smoke updated", "mutation result was not visible after update");
  await second.close();

  const queuedStoreKey = `${storeKey}_queued`;
  const queued = new PostgresStore({
    connectionString,
    tableName,
    storeKey: queuedStoreKey,
    seedAgents
  });
  await queued.init();
  const queuedMutations = Array.from({ length: 5 }, (_, index) =>
    queued.mutate((data) => {
      data.sessions.push({
        session_id: `sess_pg_queued_${index}`,
        title: `Queued close ${index}`,
        workspace_id: "workspace_pg_smoke",
        visibility: "private",
        created_by: "postgres_smoke",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        last_message_at: new Date().toISOString(),
        shared_memory: []
      });
      return { inserted: index };
    })
  );
  await queued.close();
  await Promise.all(queuedMutations);

  const queuedReader = new PostgresStore({
    connectionString,
    tableName,
    storeKey: queuedStoreKey,
    seedAgents
  });
  await queuedReader.init();
  assert(queuedReader.read().sessions.length === 5, "queued mutations did not persist before PostgresStore.close returned");
  await queuedReader.close();

  console.log(JSON.stringify({ ok: true, tableName, storeKey, seedAgents: seedAgents.length }, null, 2));
} finally {
  if (dropTable) {
    await pool.query(`DROP TABLE IF EXISTS ${tableName}`);
  }
  await pool.end();
}

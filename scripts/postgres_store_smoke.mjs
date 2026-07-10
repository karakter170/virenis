#!/usr/bin/env node
/* global console, process */
import pg from "pg";
import { setTimeout as delay } from "node:timers/promises";
import { clearTimeout, setTimeout } from "node:timers";
import { seedAgents } from "../server/catalog.js";
import { PostgresStore } from "../server/store.js";

const { Pool } = pg;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function cancellableTimeout(milliseconds, value) {
  let timer;
  const promise = new Promise((resolve) => {
    timer = setTimeout(resolve, milliseconds, value);
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

function queryText(query) {
  return typeof query === "string" ? query : String(query?.text || "");
}

function isStoreRead(query, { locked }) {
  const sql = queryText(query).replace(/\s+/g, " ").trim().toLowerCase();
  return sql.startsWith("select data from ")
    && sql.includes(" where store_key = $1")
    && sql.includes(" for update") === locked;
}

function interceptClientQueries(store, intercept) {
  const connect = store.pool.connect.bind(store.pool);
  const poolQuery = store.pool.query.bind(store.pool);
  const interceptedConnect = async () => {
    const client = await connect();
    const query = client.query.bind(client);
    client.query = (...args) => intercept({
      sql: queryText(args[0]),
      run: () => query(...args)
    });
    return client;
  };
  store.pool.connect = interceptedConnect;
  store.pool.query = async (...args) => {
    store.pool.connect = connect;
    try {
      return await poolQuery(...args);
    } finally {
      store.pool.connect = interceptedConnect;
    }
  };
}

function safeIdentifier(value) {
  const identifier = String(value || "").trim();
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(identifier)) {
    throw new Error(`Unsafe SQL identifier: ${identifier}`);
  }
  return identifier;
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function syncProbeEvent(suffix) {
  return {
    event_id: `agent_event_${suffix}`,
    schema_version: "virenis-agent-event-v1",
    event_type: "agent.created",
    agent_id: `agent_${suffix}`,
    agent_revision: `sha256:${"a".repeat(64)}`,
    workspace_id: `workspace_${suffix}`,
    visibility: "private",
    actor_id: "postgres_smoke",
    actor_role: "admin",
    occurred_at: new Date().toISOString(),
    details: { synchronization_probe: true },
    previous_event_hash: null,
    event_hash: `sha256:${"b".repeat(64)}`
  };
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is required for postgres_store_smoke.mjs");
}

const tableName = safeIdentifier(process.env.WEB_DB_SMOKE_TABLE || `tcar_app_store_smoke_${process.pid}`);
const storeKey = `smoke_${Date.now()}_${Math.random().toString(16).slice(2)}`;
const dropTable = process.env.WEB_DB_SMOKE_DROP_TABLE !== "0";
const pool = new Pool({ connectionString });
const openStores = new Set();
const debug = process.env.WEB_DB_SMOKE_DEBUG === "1";
let injectionFunctionName;

function progress(stage) {
  if (debug) console.error(`[postgres-store-smoke] ${stage}`);
}

function createStore(key, agents = seedAgents) {
  const store = new PostgresStore({
    connectionString,
    tableName,
    storeKey: key,
    seedAgents: agents
  });
  openStores.add(store);
  return store;
}

async function closeStore(store) {
  if (!openStores.delete(store)) return;
  await store.close();
}

try {
  const ledger = await pool.query("SELECT to_regclass('tcar_ledger.execution_runs') AS relation");
  assert(ledger.rows[0]?.relation, "normalized ledger schema is required for the Postgres store smoke test");
  progress("schema ready");

  const first = createStore(storeKey);
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
  await closeStore(first);

  const second = createStore(storeKey);
  await second.init();
  const persisted = second.read();
  assert(persisted.sessions.some((session) => session.session_id === sessionId), "session did not persist across store instances");

  await second.mutate((data) => {
    const session = data.sessions.find((item) => item.session_id === sessionId);
    session.title = "Postgres smoke updated";
    return session;
  });
  assert(second.read().sessions.find((session) => session.session_id === sessionId).title === "Postgres smoke updated", "mutation result was not visible after update");
  await closeStore(second);
  progress("basic persistence verified");

  const queuedStoreKey = `${storeKey}_queued`;
  const queued = createStore(queuedStoreKey);
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
  await closeStore(queued);
  await Promise.all(queuedMutations);

  const queuedReader = createStore(queuedStoreKey);
  await queuedReader.init();
  assert(queuedReader.read().sessions.length === 5, "queued mutations did not persist before PostgresStore.close returned");
  await closeStore(queuedReader);
  progress("queued close verified");

  const concurrentStoreKey = `${storeKey}_concurrent_init`;
  const concurrentFirst = createStore(concurrentStoreKey);
  const concurrentSecond = createStore(concurrentStoreKey);
  await Promise.all([concurrentFirst.init(), concurrentSecond.init()]);
  const concurrentRows = await pool.query(
    `SELECT count(*)::int AS count FROM ${tableName} WHERE store_key = $1`,
    [concurrentStoreKey]
  );
  assert(concurrentRows.rows[0].count === 1, "concurrent first initialization did not converge on one store row");
  assert(concurrentFirst.read().agents.length >= seedAgents.length, "first concurrent initializer did not load seed agents");
  assert(concurrentSecond.read().agents.length >= seedAgents.length, "second concurrent initializer did not load seed agents");
  await Promise.all([closeStore(concurrentFirst), closeStore(concurrentSecond)]);
  progress("concurrent initialization verified");

  const interleavedStoreKey = `${storeKey}_interleaved_init`;
  const writer = createStore(interleavedStoreKey);
  await writer.init();
  progress("interleaving baseline ready");
  const initializer = createStore(interleavedStoreKey);
  const lockedRead = deferred();
  const legacyRead = deferred();
  const releaseLockedRead = deferred();
  const releaseLegacyRead = deferred();
  const originalPoolQuery = initializer.pool.query.bind(initializer.pool);
  initializer.pool.query = async (...args) => {
    const result = await originalPoolQuery(...args);
    if (isStoreRead(args[0], { locked: false })) {
      legacyRead.resolve("legacy");
      await releaseLegacyRead.promise;
    }
    return result;
  };
  interceptClientQueries(initializer, async ({ sql, run }) => {
    const result = await run();
    if (isStoreRead(sql, { locked: true })) {
      lockedRead.resolve("locked");
      await releaseLockedRead.promise;
    }
    return result;
  });

  const initPromise = initializer.init();
  progress("interleaved initializer started");
  const initTimeout = cancellableTimeout(5_000, "timeout");
  const initMode = await Promise.race([
    lockedRead.promise,
    legacyRead.promise,
    initPromise.then(() => "completed"),
    initTimeout.promise
  ]);
  initTimeout.cancel();
  progress(`interleaved initializer mode: ${initMode}`);
  if (initMode !== "locked" && initMode !== "legacy") {
    releaseLockedRead.resolve();
    releaseLegacyRead.resolve();
    await Promise.allSettled([initPromise]);
  }
  assert(initMode === "locked" || initMode === "legacy", "startup did not perform a row-locking store read");

  const interleavedSessionId = "sess_pg_interleaved";
  let mutationSettled = false;
  const mutationPromise = writer.mutate((data) => {
    data.sessions.push({
      session_id: interleavedSessionId,
      title: "Concurrent startup write",
      workspace_id: "workspace_pg_smoke",
      visibility: "private",
      created_by: "postgres_smoke",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      last_message_at: new Date().toISOString(),
      shared_memory: []
    });
    return { inserted: interleavedSessionId };
  });
  progress("interleaved mutation started");
  mutationPromise.then(
    () => { mutationSettled = true; },
    () => { mutationSettled = true; }
  );
  if (initMode === "legacy") {
    await mutationPromise;
    progress("legacy mutation committed");
    releaseLegacyRead.resolve();
  } else {
    await delay(100);
    const mutationCrossedLock = mutationSettled;
    releaseLockedRead.resolve();
    progress("startup row lock released");
    assert(!mutationCrossedLock, "mutation crossed the startup row lock before initialization committed");
  }
  await Promise.all([initPromise, mutationPromise]);
  progress("interleaved initializer and mutation committed");
  releaseLockedRead.resolve();
  releaseLegacyRead.resolve();
  const interleavedRow = await pool.query(
    `SELECT data FROM ${tableName} WHERE store_key = $1`,
    [interleavedStoreKey]
  );
  assert(
    interleavedRow.rows[0].data.sessions.some((session) => session.session_id === interleavedSessionId),
    "startup overwrote a mutation committed after its read"
  );
  await Promise.all([closeStore(initializer), closeStore(writer)]);
  progress("startup serialization verified");

  const newFailureStoreKey = `${storeKey}_new_sync_failure`;
  const newProbe = syncProbeEvent(`pg_new_sync_${process.pid}_${Date.now()}`);
  injectionFunctionName = safeIdentifier(`tcar_store_smoke_inject_${process.pid}_${Date.now()}`);
  const injectionTriggerName = safeIdentifier(`tcar_store_smoke_trigger_${process.pid}_${Date.now()}`);
  await pool.query(`
    CREATE FUNCTION ${injectionFunctionName}() RETURNS trigger
    LANGUAGE plpgsql AS $function$
    BEGIN
      IF NEW.store_key = ${sqlLiteral(newFailureStoreKey)} THEN
        NEW.data = jsonb_set(
          NEW.data,
          '{agentEvents}',
          ${sqlLiteral(JSON.stringify([newProbe]))}::jsonb,
          true
        );
      END IF;
      RETURN NEW;
    END
    $function$
  `);
  await pool.query(`
    CREATE TRIGGER ${injectionTriggerName}
    BEFORE INSERT ON ${tableName}
    FOR EACH ROW EXECUTE FUNCTION ${injectionFunctionName}()
  `);
  const newFailure = createStore(newFailureStoreKey);
  const newFailureMessage = `injected new-store ledger failure ${storeKey}`;
  let newSyncAttempted = false;
  interceptClientQueries(newFailure, async ({ sql, run }) => {
    if (debug) progress(`new-store transaction query: ${sql.replace(/\s+/g, " ").trim().slice(0, 80)}`);
    if (/insert\s+into\s+tcar_ledger\.workspaces/i.test(sql)) {
      newSyncAttempted = true;
      throw new Error(newFailureMessage);
    }
    return run();
  });
  let newFailureError;
  try {
    await newFailure.init();
  } catch (error) {
    newFailureError = error;
    progress(`new-store startup rejected: ${error.message}`);
  }
  assert(newSyncAttempted, "new-store initialization skipped normalized ledger synchronization");
  assert(newFailureError?.message === newFailureMessage, "new-store ledger synchronization failure did not reject startup");
  const failedNewRows = await pool.query(
    `SELECT count(*)::int AS count FROM ${tableName} WHERE store_key = $1`,
    [newFailureStoreKey]
  );
  assert(failedNewRows.rows[0].count === 0, "new store row committed despite normalized ledger synchronization failure");
  await closeStore(newFailure);
  await pool.query(`DROP FUNCTION ${injectionFunctionName}() CASCADE`);
  injectionFunctionName = undefined;
  progress("new-store rollback verified");

  const existingFailureStoreKey = `${storeKey}_existing_sync_failure`;
  const existingBaseline = createStore(existingFailureStoreKey);
  await existingBaseline.init();
  await closeStore(existingBaseline);
  const existingProbe = syncProbeEvent(`pg_existing_sync_${process.pid}_${Date.now()}`);
  await pool.query(
    `UPDATE ${tableName}
     SET data = jsonb_set(data, '{agentEvents}', $2::jsonb, true)
     WHERE store_key = $1`,
    [existingFailureStoreKey, JSON.stringify([existingProbe])]
  );
  const extraSeed = {
    ...seedAgents[0],
    id: `agent_pg_rollback_${process.pid}`,
    title: "Transactional startup rollback sentinel"
  };
  const existingFailure = createStore(existingFailureStoreKey, [...seedAgents, extraSeed]);
  const existingFailureMessage = `injected existing-store ledger failure ${storeKey}`;
  let existingSyncAttempted = false;
  interceptClientQueries(existingFailure, async ({ sql, run }) => {
    if (/insert\s+into\s+tcar_ledger\.workspaces/i.test(sql)) {
      existingSyncAttempted = true;
      throw new Error(existingFailureMessage);
    }
    return run();
  });
  let existingFailureError;
  try {
    await existingFailure.init();
  } catch (error) {
    existingFailureError = error;
  }
  assert(existingSyncAttempted, "existing-store initialization skipped normalized ledger synchronization");
  assert(existingFailureError?.message === existingFailureMessage, "existing-store ledger synchronization failure did not reject startup");
  const failedExistingRow = await pool.query(
    `SELECT data FROM ${tableName} WHERE store_key = $1`,
    [existingFailureStoreKey]
  );
  assert(
    !failedExistingRow.rows[0].data.agents.some((agent) => agent.id === extraSeed.id),
    "existing store normalization committed despite normalized ledger synchronization failure"
  );
  await closeStore(existingFailure);
  progress("existing-store rollback verified");

  const roleFlags = await pool.query(
    "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user"
  );
  let productionPrivilegedRoleRejected = false;
  if (roleFlags.rows[0]?.rolsuper === true || roleFlags.rows[0]?.rolbypassrls === true) {
    const previousNodeEnv = process.env.NODE_ENV;
    const privilegedStore = createStore(`${storeKey}_privileged_production`);
    try {
      process.env.NODE_ENV = "production";
      await privilegedStore.init();
    } catch (error) {
      productionPrivilegedRoleRejected = /NOSUPERUSER NOBYPASSRLS/.test(error.message);
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      await closeStore(privilegedStore);
    }
    assert(productionPrivilegedRoleRejected, "production startup accepted a SUPERUSER or BYPASSRLS application role");
  }

  console.log(JSON.stringify({
    ok: true,
    tableName,
    storeKey,
    seedAgents: seedAgents.length,
    concurrent_absent_initialization: true,
    startup_write_serialized: true,
    new_store_sync_rollback: true,
    existing_store_sync_rollback: true,
    production_privileged_role_rejected: productionPrivilegedRoleRejected
  }, null, 2));
} finally {
  await Promise.allSettled([...openStores].map((store) => store.close()));
  openStores.clear();
  if (injectionFunctionName) {
    await pool.query(`DROP FUNCTION IF EXISTS ${injectionFunctionName}() CASCADE`).catch(() => undefined);
  }
  if (dropTable) {
    await pool.query(`DROP TABLE IF EXISTS ${tableName}`);
  }
  await pool.end();
}

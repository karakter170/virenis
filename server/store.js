import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import pg from "pg";
import { normalizedLedgerAvailable, syncNormalizedLedger } from "./normalizedLedger.js";

const { Pool } = pg;

function clone(value) {
  if (typeof globalThis.structuredClone === "function") {
    return globalThis.structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value));
}

function initialData(seedAgents) {
  const now = new Date().toISOString();
  return {
    version: 2,
    created_at: now,
    sessions: [],
    messages: [],
    runs: [],
    runSteps: [],
    executionRecords: [],
    outcomeContracts: [],
    agentEvents: [],
    runtimeLifecycleIntents: [],
    agents: clone(seedAgents),
    documents: [],
    validationRuns: []
  };
}

export class JsonStore {
  constructor({ dbPath, seedAgents }) {
    this.dbPath = dbPath;
    this.seedAgents = seedAgents;
    this.data = initialData(seedAgents);
    this.txQueue = Promise.resolve();
  }

  async init() {
    await fs.mkdir(path.dirname(this.dbPath), { recursive: true });
    try {
      const raw = await fs.readFile(this.dbPath, "utf8");
      this.data = normalizeData(JSON.parse(raw), this.seedAgents);
      await this.saveNow();
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
      this.data = initialData(this.seedAgents);
      await this.saveNow();
    }
  }

  mergeSeedAgents() {
    const existing = new Set(this.data.agents.map((agent) => agent.id));
    for (const agent of this.seedAgents) {
      if (!existing.has(agent.id)) {
        this.data.agents.push(clone(agent));
      }
    }
  }

  read(selector = (data) => data) {
    return clone(selector(this.data));
  }

  mutate(mutator) {
    const transaction = this.txQueue.then(async () => {
      const before = clone(this.data);
      try {
        const result = mutator(this.data);
        await this.saveNow();
        return clone(result);
      } catch (error) {
        this.data = before;
        throw error;
      }
    });
    this.txQueue = transaction.catch(() => undefined);
    return transaction;
  }

  async saveNow() {
    const tmpPath = `${this.dbPath}.tmp`;
    await fs.writeFile(tmpPath, `${JSON.stringify(this.data)}\n`, "utf8");
    await fs.rename(tmpPath, this.dbPath);
  }

  async close() {
    await this.txQueue;
  }
}

export class PostgresStore {
  constructor({
    connectionString = process.env.DATABASE_URL,
    tableName = process.env.WEB_DB_TABLE || "tcar_app_store",
    storeKey = process.env.WEB_DB_STORE_KEY || "default",
    seedAgents
  }) {
    if (!connectionString) {
      throw new Error("PostgresStore requires DATABASE_URL.");
    }
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(tableName)) {
      throw new Error("WEB_DB_TABLE must be a simple SQL identifier.");
    }
    this.tableName = tableName;
    this.storeKey = storeKey;
    this.seedAgents = seedAgents;
    this.data = initialData(seedAgents);
    this.txQueue = Promise.resolve();
    this.pool = new Pool({
      connectionString,
      max: Number(process.env.WEB_DB_POOL_SIZE || 5),
      idleTimeoutMillis: Number(process.env.WEB_DB_IDLE_TIMEOUT_MS || 30000)
    });
    this.normalizedLedger = false;
  }

  async init() {
    if (process.env.NODE_ENV === "production") {
      const table = await this.pool.query("SELECT to_regclass($1) AS relation", [this.tableName]);
      if (!table.rows[0]?.relation) {
        throw new Error("Production Postgres store table is missing. Apply deploy/sql/web_store.sql with the separate migration/admin connection before starting the web process.");
      }
    } else {
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS ${this.tableName} (
          store_key text PRIMARY KEY,
          data jsonb NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now()
        )
      `);
    }
    this.normalizedLedger = await normalizedLedgerAvailable(this.pool);
    const ledgerRequired = process.env.WEB_NORMALIZED_LEDGER_REQUIRED === "1"
      || (process.env.NODE_ENV === "production" && process.env.WEB_NORMALIZED_LEDGER_REQUIRED !== "0");
    if (ledgerRequired && !this.normalizedLedger) {
      throw new Error("Production Postgres requires deploy/sql/provenance_outcomes.sql. Set WEB_NORMALIZED_LEDGER_REQUIRED=0 only for isolated migration work.");
    }
    if (process.env.NODE_ENV === "production") {
      const role = await this.pool.query(
        "SELECT current_user AS role_name, rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user"
      );
      if (role.rows[0]?.rolsuper === true || role.rows[0]?.rolbypassrls === true) {
        throw new Error(
          "Production web DATABASE_URL must use a NOSUPERUSER NOBYPASSRLS role. Run schema migrations with a separate admin connection that is never configured on the serving process."
        );
      }
    }
    const client = await this.pool.connect();
    const seedData = initialData(this.seedAgents);
    let initializedData;
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO ${this.tableName} (store_key, data)
         VALUES ($1, $2::jsonb)
         ON CONFLICT (store_key) DO NOTHING`,
        [this.storeKey, JSON.stringify(seedData)]
      );
      const response = await client.query(
        `SELECT data FROM ${this.tableName} WHERE store_key = $1 FOR UPDATE`,
        [this.storeKey]
      );
      if (response.rowCount !== 1) {
        throw new Error(`Postgres store initialization could not lock store key ${this.storeKey}.`);
      }
      initializedData = normalizeData(response.rows[0].data, this.seedAgents);
      await client.query(
        `UPDATE ${this.tableName}
         SET data = $2::jsonb, updated_at = now()
         WHERE store_key = $1`,
        [this.storeKey, JSON.stringify(initializedData)]
      );
      if (this.normalizedLedger) {
        await syncNormalizedLedger(client, initializedData);
      }
      await client.query("COMMIT");
      this.data = initializedData;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  read(selector = (data) => data) {
    return clone(selector(this.data));
  }

  mutate(mutator) {
    const transaction = this.txQueue.then(async () => {
      const client = await this.pool.connect();
      let before;
      try {
        await client.query("BEGIN");
        const response = await client.query(
          `SELECT data FROM ${this.tableName} WHERE store_key = $1 FOR UPDATE`,
          [this.storeKey]
        );
        this.data = response.rowCount === 0 ? initialData(this.seedAgents) : normalizeData(response.rows[0].data, this.seedAgents);
        before = clone(this.data);
        const result = mutator(this.data);
        await client.query(
          `INSERT INTO ${this.tableName} (store_key, data, updated_at)
           VALUES ($1, $2::jsonb, now())
           ON CONFLICT (store_key)
           DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
          [this.storeKey, JSON.stringify(this.data)]
        );
        if (this.normalizedLedger) {
          await syncNormalizedLedger(client, this.data);
        }
        await client.query("COMMIT");
        return clone(result);
      } catch (error) {
        await client.query("ROLLBACK");
        if (before) this.data = before;
        throw error;
      } finally {
        client.release();
      }
    });
    this.txQueue = transaction.catch(() => undefined);
    return transaction;
  }

  async saveNow() {
    await this.pool.query(
      `INSERT INTO ${this.tableName} (store_key, data, updated_at)
       VALUES ($1, $2::jsonb, now())
       ON CONFLICT (store_key)
       DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
      [this.storeKey, JSON.stringify(this.data)]
    );
  }

  async close() {
    await this.txQueue;
    await this.pool.end();
  }
}

export function createStore({ dbPath, seedAgents }) {
  const driver = String(process.env.WEB_STORE_DRIVER || (process.env.DATABASE_URL ? "postgres" : "json")).toLowerCase();
  if (driver === "postgres") {
    return new PostgresStore({ seedAgents });
  }
  if (process.env.NODE_ENV === "production" && process.env.APP_ALLOW_JSON_STORE !== "1") {
    throw new Error("Production web server requires DATABASE_URL or WEB_STORE_DRIVER=postgres. Set APP_ALLOW_JSON_STORE=1 only for isolated private-beta deployments.");
  }
  return new JsonStore({ dbPath, seedAgents });
}

function normalizeData(value, seedAgents) {
  const data = value && typeof value === "object" ? clone(value) : initialData(seedAgents);
  const defaults = initialData(seedAgents);
  for (const [key, defaultValue] of Object.entries(defaults)) {
    if (!(key in data)) {
      data[key] = defaultValue;
    }
  }
  data.version = defaults.version;
  const existing = new Set((data.agents || []).map((agent) => agent.id));
  for (const agent of seedAgents) {
    if (!existing.has(agent.id)) {
      data.agents.push(clone(agent));
    }
  }
  return data;
}

export function nowIso() {
  return new Date().toISOString();
}

export function makeId(prefix) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

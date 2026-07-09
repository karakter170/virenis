import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import pg from "pg";

const { Pool } = pg;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function initialData(seedAgents) {
  const now = new Date().toISOString();
  return {
    version: 1,
    created_at: now,
    sessions: [],
    messages: [],
    runs: [],
    runSteps: [],
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
      this.data = JSON.parse(raw);
      this.mergeSeedAgents();
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
      const result = mutator(this.data);
      await this.saveNow();
      return clone(result);
    });
    this.txQueue = transaction.catch(() => undefined);
    return transaction;
  }

  async saveNow() {
    const tmpPath = `${this.dbPath}.tmp`;
    await fs.writeFile(tmpPath, `${JSON.stringify(this.data, null, 2)}\n`, "utf8");
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
  }

  async init() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.tableName} (
        store_key text PRIMARY KEY,
        data jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    const response = await this.pool.query(
      `SELECT data FROM ${this.tableName} WHERE store_key = $1`,
      [this.storeKey]
    );
    if (response.rowCount === 0) {
      this.data = initialData(this.seedAgents);
      await this.pool.query(
        `INSERT INTO ${this.tableName} (store_key, data) VALUES ($1, $2::jsonb)`,
        [this.storeKey, JSON.stringify(this.data)]
      );
      return;
    }
    this.data = normalizeData(response.rows[0].data, this.seedAgents);
    await this.saveNow();
  }

  read(selector = (data) => data) {
    return clone(selector(this.data));
  }

  mutate(mutator) {
    const transaction = this.txQueue.then(async () => {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        const response = await client.query(
          `SELECT data FROM ${this.tableName} WHERE store_key = $1 FOR UPDATE`,
          [this.storeKey]
        );
        this.data = response.rowCount === 0 ? initialData(this.seedAgents) : normalizeData(response.rows[0].data, this.seedAgents);
        const result = mutator(this.data);
        await client.query(
          `INSERT INTO ${this.tableName} (store_key, data, updated_at)
           VALUES ($1, $2::jsonb, now())
           ON CONFLICT (store_key)
           DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
          [this.storeKey, JSON.stringify(this.data)]
        );
        await client.query("COMMIT");
        return clone(result);
      } catch (error) {
        await client.query("ROLLBACK");
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

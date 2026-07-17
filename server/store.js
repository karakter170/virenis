import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import pg from "pg";
import { verifyBillingState } from "./billing.js";
import { normalizedBillingAvailable, syncNormalizedBilling } from "./normalizedBilling.js";
import { normalizedLedgerAvailable, syncNormalizedLedger } from "./normalizedLedger.js";
import { ensureGeneralAgentWorkspace, normalizeAgentWorkspaceCollections } from "./agentWorkspaces.js";
import { normalizePublicMarketplaceRatings } from "./marketplaceRatingIdentity.js";
import { normalizeMarketplacePublisherIdentities } from "./marketplacePublisherIdentity.js";
import { validateProductionDatabaseTransport } from "./databaseTransport.js";

const { Client, Pool } = pg;

function boundedDatabaseTimeout(value, fallback = 5000) {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed)) return fallback;
  return Math.max(250, Math.min(parsed, 30_000));
}

function databaseStatementTimeout(queryTimeout) {
  // Let PostgreSQL cancel first so the protocol reaches ReadyForQuery before
  // node-postgres' client-side fail-safe fires. The latter remains necessary
  // for broken networks and an unresponsive server.
  const grace = Math.min(1000, Math.max(50, Math.floor(queryTimeout / 10)));
  return Math.max(100, queryTimeout - grace);
}

function isClientQueryTimeout(error) {
  return String(error?.message || "").toLowerCase().includes("query read timeout");
}

async function rollbackAfterFailure(client, originalError) {
  let rollbackError = null;
  try {
    await client.query("ROLLBACK");
  } catch (error) {
    rollbackError = error;
  }
  // A client-side read timeout can leave an unanswered statement on the wire,
  // and a failed rollback cannot prove protocol synchronization. Passing an
  // error to release() makes pg-pool destroy, rather than recycle, the client.
  return isClientQueryTimeout(originalError) ? originalError : rollbackError;
}

function clone(value) {
  if (typeof globalThis.structuredClone === "function") {
    return globalThis.structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value));
}

function mergeSeedCatalog(agents, seedAgents) {
  const indexes = new Map((agents || []).map((agent, index) => [agent.id, index]));
  for (const seedAgent of seedAgents) {
    const existingIndex = indexes.get(seedAgent.id);
    if (existingIndex === undefined) {
      agents.push(clone(seedAgent));
      indexes.set(seedAgent.id, agents.length - 1);
      continue;
    }
    if (
      seedAgent.system_managed === true
      && seedAgent.base_lora === true
      && seedAgent.library_origin === "tcar_base_lora_library"
    ) {
      // Base-library definitions are runtime-controlled product configuration,
      // not user-owned records. Refresh them on startup so policy and receipt
      // revisions cannot remain stale in an existing JSON or PostgreSQL store.
      agents[existingIndex] = clone(seedAgent);
    }
  }
}

function initialData(seedAgents) {
  const now = new Date().toISOString();
  return {
    version: 17,
    created_at: now,
    users: [],
    billingAccounts: [],
    billingPricingVersions: [],
    billingLedgerEntries: [],
    billingReservations: [],
    billingUsageRecords: [],
    billingFundingEvents: [],
    identityAuditEvents: [],
    identityDeletionTombstones: [],
    workspaceModelSettings: [],
    sessions: [],
    messages: [],
    runs: [],
    runSteps: [],
    executionRecords: [],
    worldGraphArtifacts: [],
    worldGraphEvents: [],
    outcomeContracts: [],
    agentEvents: [],
    runtimeLifecycleIntents: [],
    marketplaceRatings: [],
    agentWorkspaces: [],
    agentWorkspaceRatings: [],
    mcpConnections: [],
    mcpOauthClients: [],
    mcpOauthStates: [],
    mcpApprovals: [],
    mcpToolCalls: [],
    workflows: [],
    conversationCheckpoints: [],
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
    const dataDirectory = path.dirname(this.dbPath);
    await fs.mkdir(dataDirectory, { recursive: true, mode: 0o700 });
    await fs.chmod(dataDirectory, 0o700);
    try {
      const raw = await fs.readFile(this.dbPath, "utf8");
      this.data = normalizeData(JSON.parse(raw), this.seedAgents);
      assertBillingStateIntegrity(this.data);
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
    mergeSeedCatalog(this.data.agents, this.seedAgents);
  }

  read(selector = (data) => data) {
    return clone(selector(this.data));
  }

  async readinessCheck() {
    // Do not report a stale in-memory snapshot as ready if the durable JSON
    // backing file has disappeared or become inaccessible.
    await this.txQueue;
    await fs.access(this.dbPath, fs.constants.R_OK | fs.constants.W_OK);
  }

  mutate(mutator) {
    const transaction = this.txQueue.then(async () => {
      const before = clone(this.data);
      try {
        const result = mutator(this.data);
        assertBillingStateIntegrity(this.data);
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
    assertBillingStateIntegrity(this.data);
    const tmpPath = `${this.dbPath}.tmp`;
    await fs.writeFile(tmpPath, `${JSON.stringify(this.data)}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
    await fs.chmod(tmpPath, 0o600);
    await fs.rename(tmpPath, this.dbPath);
    await fs.chmod(this.dbPath, 0o600);
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
    seedAgents,
    clientConstructor = Client
  }) {
    if (!connectionString) {
      throw new Error("PostgresStore requires DATABASE_URL.");
    }
    validateProductionDatabaseTransport(process.env, connectionString);
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(tableName)) {
      throw new Error("WEB_DB_TABLE must be a simple SQL identifier.");
    }
    this.tableName = tableName;
    this.storeKey = storeKey;
    this.connectionString = connectionString;
    this.seedAgents = seedAgents;
    this.clientConstructor = clientConstructor;
    this.data = initialData(seedAgents);
    this.txQueue = Promise.resolve();
    this.databaseConnectTimeoutMs = boundedDatabaseTimeout(
      process.env.WEB_DB_CONNECT_TIMEOUT_MS,
      5000
    );
    this.databaseQueryTimeoutMs = boundedDatabaseTimeout(
      process.env.WEB_DB_QUERY_TIMEOUT_MS,
      5000
    );
    this.databaseStatementTimeoutMs = databaseStatementTimeout(
      this.databaseQueryTimeoutMs
    );
    this.pool = new Pool({
      connectionString,
      max: Number(process.env.WEB_DB_POOL_SIZE || 5),
      idleTimeoutMillis: Number(process.env.WEB_DB_IDLE_TIMEOUT_MS || 30000),
      // `query_timeout` does not bound time spent acquiring a new socket.
      // Keep readiness and mutations from hanging indefinitely during a
      // network outage before PostgreSQL accepts the connection.
      connectionTimeoutMillis: this.databaseConnectTimeoutMs,
      // Bound every init/mutate/save/projection query, not just readiness.
      // PostgreSQL cancels first; the slightly later client timeout is the
      // fail-safe when no server response can arrive.
      statement_timeout: this.databaseStatementTimeoutMs,
      query_timeout: this.databaseQueryTimeoutMs
    });
    this.normalizedLedger = false;
    this.normalizedBilling = false;
    this.instanceLockClient = null;
    const lockDigest = crypto.createHash("sha256")
      .update(`virenis-single-web-process-v1\0${tableName}\0${storeKey}`, "utf8")
      .digest();
    this.instanceLockKeys = [lockDigest.readInt32BE(0), lockDigest.readInt32BE(4)];
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
    this.normalizedBilling = await normalizedBillingAvailable(this.pool);
    const ledgerRequired = process.env.WEB_NORMALIZED_LEDGER_REQUIRED === "1"
      || (process.env.NODE_ENV === "production" && process.env.WEB_NORMALIZED_LEDGER_REQUIRED !== "0");
    if (ledgerRequired && !this.normalizedLedger) {
      throw new Error("Production Postgres requires deploy/sql/provenance_outcomes.sql. Set WEB_NORMALIZED_LEDGER_REQUIRED=0 only for isolated migration work.");
    }
    const billingRequired = process.env.WEB_NORMALIZED_BILLING_REQUIRED === "1"
      || (process.env.NODE_ENV === "production" && process.env.WEB_NORMALIZED_BILLING_REQUIRED !== "0");
    if (billingRequired && !this.normalizedBilling) {
      throw new Error("Production Postgres requires deploy/sql/billing.sql. Set WEB_NORMALIZED_BILLING_REQUIRED=0 only for isolated migration work.");
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
    await this.acquireInstanceLock();
    const client = await this.pool.connect();
    const seedData = initialData(this.seedAgents);
    let initializedData;
    let releaseError = null;
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
      assertBillingStateIntegrity(initializedData);
      await client.query(
        `UPDATE ${this.tableName}
         SET data = $2::jsonb, updated_at = now()
         WHERE store_key = $1`,
        [this.storeKey, JSON.stringify(initializedData)]
      );
      if (this.normalizedLedger) {
        await syncNormalizedLedger(client, initializedData);
      }
      if (this.normalizedBilling) {
        await syncNormalizedBilling(client, initializedData);
      }
      await client.query("COMMIT");
      this.data = initializedData;
    } catch (error) {
      releaseError = await rollbackAfterFailure(client, error);
      await this.releaseInstanceLock();
      throw error;
    } finally {
      client.release(releaseError || undefined);
    }
  }

  read(selector = (data) => data) {
    return clone(selector(this.data));
  }

  async readinessCheck() {
    // `read()` is intentionally an in-memory snapshot for synchronous request
    // paths. Readiness must instead cross the database boundary so a severed
    // Postgres connection cannot leave a process advertised as ready.
    const queryTimeout = boundedDatabaseTimeout(
      process.env.WEB_DB_READINESS_TIMEOUT_MS,
      5000
    );
    const response = await this.pool.query({
      text: `SELECT data IS NOT NULL AS ready
             FROM ${this.tableName}
             WHERE store_key = $1`,
      values: [this.storeKey],
      query_timeout: queryTimeout
    });
    if (response.rowCount !== 1 || response.rows[0]?.ready !== true) {
      throw new Error(`Postgres store key ${this.storeKey} is unavailable.`);
    }
  }

  mutate(mutator) {
    const transaction = this.txQueue.then(async () => {
      const client = await this.pool.connect();
      let before;
      let releaseError = null;
      try {
        await client.query("BEGIN");
        const response = await client.query(
          `SELECT data FROM ${this.tableName} WHERE store_key = $1 FOR UPDATE`,
          [this.storeKey]
        );
        this.data = response.rowCount === 0 ? initialData(this.seedAgents) : normalizeData(response.rows[0].data, this.seedAgents);
        before = clone(this.data);
        const result = mutator(this.data);
        assertBillingStateIntegrity(this.data);
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
        if (this.normalizedBilling) {
          await syncNormalizedBilling(client, this.data);
        }
        await client.query("COMMIT");
        return clone(result);
      } catch (error) {
        releaseError = await rollbackAfterFailure(client, error);
        if (before) this.data = before;
        throw error;
      } finally {
        client.release(releaseError || undefined);
      }
    });
    this.txQueue = transaction.catch(() => undefined);
    return transaction;
  }

  async saveNow() {
    const transaction = this.txQueue.then(async () => {
      const snapshot = clone(this.data);
      assertBillingStateIntegrity(snapshot);
      const client = await this.pool.connect();
      let releaseError = null;
      try {
        await client.query("BEGIN");
        await client.query(
          `INSERT INTO ${this.tableName} (store_key, data, updated_at)
           VALUES ($1, $2::jsonb, now())
           ON CONFLICT (store_key)
           DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
          [this.storeKey, JSON.stringify(snapshot)]
        );
        if (this.normalizedLedger) await syncNormalizedLedger(client, snapshot);
        if (this.normalizedBilling) await syncNormalizedBilling(client, snapshot);
        await client.query("COMMIT");
      } catch (error) {
        releaseError = await rollbackAfterFailure(client, error);
        throw error;
      } finally {
        client.release(releaseError || undefined);
      }
    });
    this.txQueue = transaction.catch(() => undefined);
    return transaction;
  }

  async close() {
    await this.txQueue;
    await this.releaseInstanceLock();
    await this.pool.end();
  }

  async acquireInstanceLock() {
    if (this.instanceLockClient) return;
    // This lock must live on one dedicated session, so it cannot use Pool.
    // Apply the same bounded socket-acquisition contract as Pool plus a
    // client-side query timeout. Without both, a dead Postgres route could
    // hang production startup forever before the process reaches readiness.
    const client = new this.clientConstructor({
      connectionString: this.connectionString,
      connectionTimeoutMillis: this.databaseConnectTimeoutMs,
      statement_timeout: this.databaseStatementTimeoutMs,
      query_timeout: this.databaseQueryTimeoutMs
    });
    try {
      await client.connect();
      const result = await client.query(
        "SELECT pg_try_advisory_lock($1::int, $2::int) AS acquired",
        this.instanceLockKeys
      );
      if (result.rows[0]?.acquired !== true) {
        throw new Error(
          `Another Virenis web process already owns Postgres store ${this.storeKey}. `
          + "The current MVP requires exactly one web process; stop the other replica before retrying."
        );
      }
      this.instanceLockClient = client;
    } catch (error) {
      await client.end().catch(() => undefined);
      throw error;
    }
  }

  async releaseInstanceLock() {
    const client = this.instanceLockClient;
    if (!client) return;
    this.instanceLockClient = null;
    try {
      await client.query("SELECT pg_advisory_unlock($1::int, $2::int)", this.instanceLockKeys);
    } finally {
      await client.end();
    }
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
  for (const collection of [
    "users",
    "billingAccounts",
    "billingPricingVersions",
    "billingLedgerEntries",
    "billingReservations",
    "billingUsageRecords",
    "billingFundingEvents",
    "identityAuditEvents",
    "identityDeletionTombstones",
    "workspaceModelSettings",
    "mcpConnections",
    "mcpOauthClients",
    "mcpOauthStates",
    "mcpApprovals",
    "mcpToolCalls",
    "workflows",
    "conversationCheckpoints",
    "worldGraphArtifacts",
    "worldGraphEvents"
  ]) {
    data[collection] = Array.isArray(data[collection]) ? data[collection] : [];
  }
  // Clerk owns credentials, verification tokens, and browser sessions. Purge
  // records from the retired first-party identity implementation during every
  // JSON/PostgreSQL snapshot normalization so secrets cannot linger after the
  // migration.
  delete data.authSessions;
  delete data.emailVerificationTokens;
  delete data.passwordResetTokens;
  for (const user of data.users) {
    if (!user || typeof user !== "object") continue;
    delete user.password_hash;
    delete user.password_changed_at;
    delete user.failed_login_count;
    delete user.locked_until;
  }
  for (const agent of Array.isArray(data.agents) ? data.agents : []) {
    if (!agent.marketplace || typeof agent.marketplace !== "object" || Array.isArray(agent.marketplace)) continue;
    const marketplace = agent.marketplace;
    marketplace.description = String(marketplace.description || marketplace.summary || agent.capability || "").trim().slice(0, 1200);
    marketplace.published_by = String(marketplace.published_by || agent.created_by || "Virenis").trim() || "Virenis";
    marketplace.publisher_display_name = String(marketplace.publisher_display_name || marketplace.published_by).trim().slice(0, 80) || marketplace.published_by;
    marketplace.publisher_workspace_id ??= agent.workspace_id || null;
    if (!marketplace.listing_id) {
      const digest = crypto.createHash("sha256")
        .update(`${agent.id || "agent"}:${marketplace.published_at || "legacy"}`, "utf8")
        .digest("hex")
        .slice(0, 16);
      marketplace.listing_id = `listing_${digest}`;
    }
    delete marketplace.summary;
    delete marketplace.achievements;
    delete marketplace.proofs;
    delete marketplace.version;
    delete marketplace.license;
  }
  data.marketplaceRatings = normalizePublicMarketplaceRatings(data.marketplaceRatings, {
    subjects: Array.isArray(data.agents) ? data.agents : [],
    subjectIdField: "agent_id",
    subjectId: (agent) => agent.id,
    listingId: (agent) => agent.marketplace?.listing_id,
    publisherIds: (agent) => [agent.marketplace?.published_by, agent.created_by],
    subjectWorkspaceId: (agent) => agent.marketplace?.publisher_workspace_id || agent.workspace_id
  });
  normalizeAgentWorkspaceCollections(data);
  normalizeMarketplacePublisherIdentities(data);
  mergeSeedCatalog(data.agents, seedAgents);
  for (const user of data.users || []) {
    if (!user?.user_id || !user?.workspace_id || user.status === "deleted") continue;
    ensureGeneralAgentWorkspace(data, {
      user_id: user.user_id,
      workspace_id: user.workspace_id,
      role: user.role || "user"
    });
  }
  return data;
}

export function nowIso() {
  return new Date().toISOString();
}

export function makeId(prefix) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function assertBillingStateIntegrity(data) {
  const integrity = verifyBillingState(data);
  if (!integrity.valid) {
    throw new Error(`Billing state integrity verification failed: ${integrity.errors.slice(0, 12).join(", ")}`);
  }
}

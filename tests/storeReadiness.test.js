import { afterEach, describe, expect, it, vi } from "vitest";
import { PostgresStore } from "../server/store.js";

function postgresStore() {
  return new PostgresStore({
    connectionString: "postgres://readiness:readiness@127.0.0.1:5432/readiness",
    tableName: "tcar_app_store",
    storeKey: "closed_beta",
    seedAgents: []
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("PostgresStore readiness", () => {
  it("bounds database socket acquisition as well as query execution", async () => {
    vi.stubEnv("WEB_DB_CONNECT_TIMEOUT_MS", "999999");
    vi.stubEnv("WEB_DB_QUERY_TIMEOUT_MS", "999999");
    const capped = postgresStore();
    expect(capped.pool.options.connectionTimeoutMillis).toBe(30_000);
    expect(capped.pool.options.statement_timeout).toBe(29_000);
    expect(capped.pool.options.query_timeout).toBe(30_000);
    await capped.pool.end();

    vi.stubEnv("WEB_DB_CONNECT_TIMEOUT_MS", "invalid");
    vi.stubEnv("WEB_DB_QUERY_TIMEOUT_MS", "invalid");
    const fallback = postgresStore();
    expect(fallback.pool.options.connectionTimeoutMillis).toBe(5_000);
    expect(fallback.pool.options.statement_timeout).toBe(4_500);
    expect(fallback.pool.options.query_timeout).toBe(5_000);
    await fallback.pool.end();
  });

  it("bounds the dedicated advisory-lock connection and its queries", async () => {
    vi.stubEnv("WEB_DB_CONNECT_TIMEOUT_MS", "999999");
    vi.stubEnv("WEB_DB_QUERY_TIMEOUT_MS", "999999");
    let options;
    class LockClient {
      constructor(value) {
        options = value;
      }

      async connect() {}

      async query(text) {
        if (String(text).includes("pg_try_advisory_lock")) {
          return { rows: [{ acquired: true }] };
        }
        return { rows: [] };
      }

      async end() {}
    }
    const store = new PostgresStore({
      connectionString: "postgres://readiness:readiness@127.0.0.1:5432/readiness",
      tableName: "tcar_app_store",
      storeKey: "closed_beta",
      seedAgents: [],
      clientConstructor: LockClient
    });

    await store.acquireInstanceLock();
    expect(options).toMatchObject({
      connectionTimeoutMillis: 30_000,
      statement_timeout: 29_000,
      query_timeout: 30_000
    });
    await store.releaseInstanceLock();
    await store.pool.end();
  });

  it("crosses the Postgres boundary and verifies the configured durable row", async () => {
    const store = postgresStore();
    const query = vi.fn().mockResolvedValue({ rowCount: 1, rows: [{ ready: true }] });
    store.pool.query = query;

    await expect(store.readinessCheck()).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0][0]).toMatchObject({
      values: ["closed_beta"],
      query_timeout: 5000
    });
    expect(query.mock.calls[0][0].text).toContain("FROM tcar_app_store");
  });

  it("fails closed on a database outage or a missing durable row", async () => {
    const store = postgresStore();
    store.pool.query = vi.fn().mockRejectedValueOnce(new Error("connection terminated"));
    await expect(store.readinessCheck()).rejects.toThrow("connection terminated");

    store.pool.query = vi.fn().mockResolvedValueOnce({ rowCount: 0, rows: [] });
    await expect(store.readinessCheck()).rejects.toThrow("Postgres store key closed_beta is unavailable");
  });

  it("destroys a pooled client after a client-side query timeout", async () => {
    const store = postgresStore();
    const release = vi.fn();
    const timeout = new Error("Query read timeout");
    const client = {
      release,
      query: vi.fn()
        .mockResolvedValueOnce(undefined) // BEGIN
        .mockRejectedValueOnce(timeout) // SELECT ... FOR UPDATE
        .mockResolvedValueOnce(undefined) // ROLLBACK
    };
    store.pool.connect = vi.fn().mockResolvedValue(client);

    await expect(store.mutate(() => undefined)).rejects.toBe(timeout);
    expect(client.query).toHaveBeenLastCalledWith("ROLLBACK");
    expect(release).toHaveBeenCalledWith(timeout);
    await store.pool.end();
  });

  it("destroys a pooled client when rollback itself cannot complete", async () => {
    const store = postgresStore();
    const release = vi.fn();
    const queryError = new Error("constraint failure");
    const rollbackError = new Error("connection terminated during rollback");
    const client = {
      release,
      query: vi.fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(queryError)
        .mockRejectedValueOnce(rollbackError)
    };
    store.pool.connect = vi.fn().mockResolvedValue(client);

    await expect(store.mutate(() => undefined)).rejects.toBe(queryError);
    expect(release).toHaveBeenCalledWith(rollbackError);
    await store.pool.end();
  });
});

import { afterEach, describe, expect, it } from "vitest";

import { validateProductionDatabaseTransport } from "../server/databaseTransport.js";
import { validateProductionRuntimeApiUrl } from "../server/runtimeClient.js";
import { PostgresStore } from "../server/store.js";

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_POSTGRES_OVERRIDE = process.env.WEB_ALLOW_INSECURE_PRIVATE_POSTGRES;

afterEach(() => {
  if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  if (ORIGINAL_POSTGRES_OVERRIDE === undefined) {
    delete process.env.WEB_ALLOW_INSECURE_PRIVATE_POSTGRES;
  } else {
    process.env.WEB_ALLOW_INSECURE_PRIVATE_POSTGRES = ORIGINAL_POSTGRES_OVERRIDE;
  }
});

describe("production transport security", () => {
  it("rejects plaintext remote Runtime endpoints without the private-network override", () => {
    expect(() => validateProductionRuntimeApiUrl({
      AGENT_RUNTIME_API_URL: "http://gpu-runtime.example.net:9000"
    })).toThrow(/must use HTTPS/);

    expect(() => validateProductionRuntimeApiUrl({
      AGENT_RUNTIME_API_URL: "http://gpu-runtime.internal:9000",
      AGENT_RUNTIME_ALLOW_INSECURE_PRIVATE_RUNTIME_HTTP: "1"
    })).not.toThrow();

    expect(() => validateProductionRuntimeApiUrl({
      AGENT_RUNTIME_API_URL: "http://127.0.0.1:19000",
      AGENT_RUNTIME_ALLOW_LOOPBACK_RUNTIME_TUNNEL: "1"
    })).not.toThrow();

    expect(() => validateProductionRuntimeApiUrl({
      AGENT_RUNTIME_API_URL: "https://gpu-runtime.example.net"
    })).not.toThrow();
  });

  it("requires encrypted remote PostgreSQL transport in production", () => {
    const production = { NODE_ENV: "production" };
    expect(() => validateProductionDatabaseTransport(
      production,
      "postgres://virenis:secret@db.example.net:5432/virenis"
    )).toThrow(/sslmode=verify-full/);
    expect(() => validateProductionDatabaseTransport(
      production,
      "postgres://virenis:secret@db.example.net:5432/virenis?sslmode=prefer"
    )).toThrow(/encrypted PostgreSQL transport/);

    for (const encryptedDsn of [
      "postgres://virenis:secret@db.example.net:5432/virenis?sslmode=verify-full",
      "postgres://virenis:secret@db.example.net:5432/virenis?sslmode=require",
      "postgres://virenis:secret@db.example.net:5432/virenis?ssl=true"
    ]) {
      expect(() => validateProductionDatabaseTransport(production, encryptedDsn)).not.toThrow();
    }

    expect(() => validateProductionDatabaseTransport(
      production,
      "postgres://virenis:secret@127.0.0.1:5432/virenis"
    )).not.toThrow();
    expect(() => validateProductionDatabaseTransport(
      { ...production, WEB_ALLOW_INSECURE_PRIVATE_POSTGRES: "1" },
      "postgres://virenis:secret@postgres.internal:5432/virenis"
    )).not.toThrow();
    expect(() => validateProductionDatabaseTransport(
      { NODE_ENV: "test" },
      "postgres://virenis:secret@db.example.net:5432/virenis"
    )).not.toThrow();
  });

  it("enforces the PostgreSQL transport guard at the store construction boundary", () => {
    process.env.NODE_ENV = "production";
    delete process.env.WEB_ALLOW_INSECURE_PRIVATE_POSTGRES;
    expect(() => new PostgresStore({
      connectionString: "postgres://virenis:secret@db.example.net:5432/virenis",
      seedAgents: []
    })).toThrow(/encrypted PostgreSQL transport/);
  });
});

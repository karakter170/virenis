#!/usr/bin/env node
/* global console, process */
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

import { validateProductionDatabaseTransport } from "../server/databaseTransport.js";
import { attestServingDatabase } from "../server/servingDatabaseAttestation.js";

const { Client } = pg;

function boundedTimeout(value, fallback = 5000) {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed)) return fallback;
  return Math.max(250, Math.min(parsed, 30_000));
}

function statementTimeout(queryTimeout) {
  const grace = Math.min(1000, Math.max(50, Math.floor(queryTimeout / 10)));
  return Math.max(100, queryTimeout - grace);
}

export async function runServingDatabaseAttestation(env = process.env) {
  const connectionString = env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required for the serving database attestation.");
  }
  validateProductionDatabaseTransport({ ...env, NODE_ENV: "production" }, connectionString);
  const queryTimeout = boundedTimeout(env.WEB_DB_QUERY_TIMEOUT_MS);
  const client = new Client({
    connectionString,
    connectionTimeoutMillis: boundedTimeout(env.WEB_DB_CONNECT_TIMEOUT_MS),
    statement_timeout: statementTimeout(queryTimeout),
    query_timeout: queryTimeout
  });
  await client.connect();
  try {
    return await attestServingDatabase(client, {
      tableName: env.WEB_DB_TABLE || "tcar_app_store",
      storeKey: env.WEB_DB_STORE_KEY || "production"
    });
  } finally {
    await client.end();
  }
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    console.log(JSON.stringify(await runServingDatabaseAttestation(), null, 2));
  } catch (error) {
    console.error(`Serving database attestation failed: ${error?.message || "unknown error"}`);
    process.exitCode = 1;
  }
}

import crypto from "node:crypto";

import { normalizedBillingAvailable } from "./normalizedBilling.js";
import { normalizedLedgerAvailable } from "./normalizedLedger.js";

const LEDGER_TABLES = [
  "workspaces", "agent_revisions", "agent_events", "execution_runs",
  "source_revisions", "execution_steps", "execution_events", "evidence_records",
  "execution_artifacts", "artifact_evidence", "outcome_contracts",
  "outcome_contract_versions", "outcome_instances", "outcome_observations",
  "outcome_settlements", "outcome_disputes", "settlement_metric_scores",
  "settlement_observations", "reality_rank_snapshots"
];

const BILLING_TABLES = [
  "accounts", "pricing_versions", "ledger_entries", "reservations",
  "usage_records", "funding_events"
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function simpleIdentifier(value, label) {
  const identifier = String(value || "").trim();
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(identifier)) {
    throw new Error(`${label} must be a simple SQL identifier.`);
  }
  return identifier;
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

/**
 * Attest the already-migrated production database through the exact serving
 * role. This routine intentionally performs no schema mutation. Its write
 * probe is enclosed in a transaction that is always rolled back.
 */
export async function attestServingDatabase(client, {
  tableName = "tcar_app_store",
  storeKey = "production",
  ledgerAttestor = normalizedLedgerAvailable,
  billingAttestor = normalizedBillingAvailable
} = {}) {
  const operationalTable = simpleIdentifier(tableName, "WEB_DB_TABLE");
  const expectedRelations = [
    ["public", operationalTable],
    ...LEDGER_TABLES.map((table) => ["tcar_ledger", table]),
    ...BILLING_TABLES.map((table) => ["tcar_billing", table])
  ];

  const roleResult = await client.query(
    `SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole,
            rolreplication, rolcanlogin
       FROM pg_roles
      WHERE rolname = current_user`
  );
  const role = roleResult.rows[0];
  assert(role, "The connected PostgreSQL serving role could not be inspected.");
  assert(
    role.rolsuper !== true
      && role.rolbypassrls !== true
      && role.rolcreatedb !== true
      && role.rolcreaterole !== true
      && role.rolreplication !== true
      && role.rolcanlogin === true,
    "DATABASE_URL must use a LOGIN role without SUPERUSER, BYPASSRLS, CREATEDB, CREATEROLE, or REPLICATION."
  );

  const databaseResult = await client.query(
    `SELECT pg_get_userbyid(datdba) = current_user AS owned,
            has_database_privilege(current_user, current_database(), 'CREATE') AS can_create
       FROM pg_database
      WHERE datname = current_database()`
  );
  const database = databaseResult.rows[0];
  assert(database && database.owned !== true && database.can_create !== true,
    "The serving role must not own the database or hold database CREATE privilege.");

  const schemas = ["public", "tcar_ledger", "tcar_billing"];
  const schemaResult = await client.query(
    `WITH expected_schemas AS (
       SELECT name, ordinal
         FROM unnest($1::text[]) WITH ORDINALITY AS expected(name, ordinal)
     )
     SELECT expected.name,
            namespace.oid IS NOT NULL AS present,
            COALESCE(has_schema_privilege(current_user, namespace.oid, 'USAGE'), false) AS can_use,
            COALESCE(has_schema_privilege(current_user, namespace.oid, 'CREATE'), false) AS can_create,
            COALESCE(pg_get_userbyid(namespace.nspowner) = current_user, false) AS owned
       FROM expected_schemas AS expected
       LEFT JOIN pg_namespace AS namespace ON namespace.nspname = expected.name
      ORDER BY expected.ordinal`,
    [schemas]
  );
  for (const schema of schemaResult.rows) {
    assert(schema.present === true, `Required schema ${schema.name} is missing.`);
    assert(schema.can_use === true, `The serving role lacks USAGE on schema ${schema.name}.`);
    assert(schema.can_create !== true && schema.owned !== true,
      `The serving role must not own or create objects in schema ${schema.name}.`);
  }

  const relationResult = await client.query(
    `WITH expected_relations AS (
       SELECT schema_name, table_name, ordinal
         FROM unnest($1::text[], $2::text[]) WITH ORDINALITY
              AS expected(schema_name, table_name, ordinal)
     )
     SELECT expected.schema_name,
            expected.table_name,
            relation.oid IS NOT NULL AND relation.relkind IN ('r', 'p') AS present,
            COALESCE(pg_get_userbyid(relation.relowner) = current_user, false) AS owned,
            COALESCE(has_table_privilege(current_user, relation.oid, 'SELECT'), false) AS can_select,
            COALESCE(has_table_privilege(current_user, relation.oid, 'INSERT'), false) AS can_insert,
            COALESCE(has_table_privilege(current_user, relation.oid, 'UPDATE'), false) AS can_update,
            COALESCE(has_table_privilege(current_user, relation.oid, 'DELETE'), false) AS can_delete,
            COALESCE(has_table_privilege(current_user, relation.oid, 'TRUNCATE'), false) AS can_truncate,
            COALESCE(has_table_privilege(current_user, relation.oid, 'REFERENCES'), false) AS can_reference,
            COALESCE(has_table_privilege(current_user, relation.oid, 'TRIGGER'), false) AS can_trigger
       FROM expected_relations AS expected
       LEFT JOIN pg_namespace AS namespace ON namespace.nspname = expected.schema_name
       LEFT JOIN pg_class AS relation
         ON relation.relnamespace = namespace.oid
        AND relation.relname = expected.table_name
      ORDER BY expected.ordinal`,
    [expectedRelations.map(([schema]) => schema), expectedRelations.map(([, table]) => table)]
  );
  assert(relationResult.rows.length === expectedRelations.length,
    "The serving-role relation attestation returned an incomplete result.");
  for (const relation of relationResult.rows) {
    const qualifiedName = `${relation.schema_name}.${relation.table_name}`;
    assert(relation.present === true, `Required relation ${qualifiedName} is missing.`);
    assert(relation.owned !== true, `The serving role must not own ${qualifiedName}.`);
    assert(relation.can_select === true && relation.can_insert === true && relation.can_update === true,
      `The serving role requires SELECT, INSERT, and UPDATE on ${qualifiedName}.`);
    assert(
      relation.can_delete !== true
        && relation.can_truncate !== true
        && relation.can_reference !== true
        && relation.can_trigger !== true,
      `The serving role has an unsafe excess privilege on ${qualifiedName}.`
    );
  }

  assert(await ledgerAttestor(client),
    "The normalized ledger schema, forced RLS policies, columns, or triggers are not healthy.");
  assert(await billingAttestor(client),
    "The normalized billing schema, forced RLS policies, columns, or triggers are not healthy.");

  const qualifiedOperationalTable = `public.${quoteIdentifier(operationalTable)}`;
  const probeKey = `__virenis_preflight_${crypto.randomUUID()}`;
  let transactionOpen = false;
  try {
    await client.query("BEGIN");
    transactionOpen = true;
    const durableRow = await client.query(
      `SELECT 1 AS present
         FROM ${qualifiedOperationalTable}
        WHERE store_key = $1
        FOR UPDATE`,
      [String(storeKey)]
    );
    assert(durableRow.rowCount === 1,
      "The configured WEB_DB_STORE_KEY does not have a durable operational row.");

    const updateProbe = await client.query(
      `UPDATE ${qualifiedOperationalTable}
          SET data = data, updated_at = updated_at
        WHERE store_key = $1`,
      [String(storeKey)]
    );
    assert(updateProbe.rowCount === 1, "The serving role failed its transactional UPDATE probe.");

    const insertProbe = await client.query(
      `INSERT INTO ${qualifiedOperationalTable} (store_key, data)
       VALUES ($1, '{}'::jsonb)`,
      [probeKey]
    );
    assert(insertProbe.rowCount === 1, "The serving role failed its transactional INSERT probe.");

    await client.query("ROLLBACK");
    transactionOpen = false;
  } catch (error) {
    if (transactionOpen) await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }

  return {
    ok: true,
    role_least_privileged: true,
    required_relations: expectedRelations.length,
    normalized_ledger_rls: true,
    normalized_billing_rls: true,
    rolled_back_read_write_probe: true
  };
}


#!/usr/bin/env node
/* global console, process */
import crypto from "node:crypto";
import pg from "pg";

import {
  ensureBillingAccount,
  recordFundingEvent,
  reserveRunCredits,
  settleRunCredits,
  verifyBillingState
} from "../server/billing.js";
import {
  normalizedBillingAvailable,
  normalizedBillingPseudonym,
  syncNormalizedBilling
} from "../server/normalizedBilling.js";

const { Client } = pg;
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required.");

const suffix = crypto.randomBytes(8).toString("hex");
const workspaceId = `billing_smoke_${suffix}`;
const actor = { user_id: `billing_user_${suffix}`, workspace_id: workspaceId };
const admin = { user_id: `billing_admin_${suffix}`, workspace_id: `billing_admin_workspace_${suffix}` };
const run = { run_id: `billing_run_${suffix}` };
const data = {
  users: [{ ...actor, status: "active" }],
  billingAccounts: [],
  billingPricingVersions: [],
  billingLedgerEntries: [],
  billingReservations: [],
  billingUsageRecords: [],
  billingFundingEvents: []
};

const previousWelcome = process.env.APP_BILLING_WELCOME_CREDITS;
process.env.APP_BILLING_WELCOME_CREDITS = "1000";
ensureBillingAccount(data, actor);
reserveRunCredits(data, { run, actor, options: { max_routing_adapters: 1, max_tokens: 32 } });
settleRunCredits(data, run, {
  provider_reported: true,
  complete: true,
  call_count: 1,
  calls: [{
    component: `agent:private_agent_${suffix}:step:private_step_${suffix}`,
    model: `private_model_${suffix}`,
    agent_id: `private_agent_${suffix}`,
    step_id: `private_step_${suffix}`,
    prompt_tokens: 100,
    completion_tokens: 50,
    total_tokens: 150
  }],
  totals: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
  missing_usage: []
});
recordFundingEvent(data, {
  actor: admin,
  targetUserId: actor.user_id,
  targetWorkspaceId: actor.workspace_id,
  provider: "smoke_gateway",
  externalReference: `private_checkout_${suffix}`,
  providerEventId: `private_event_${suffix}`,
  status: "succeeded",
  amountCredits: "5",
  idempotencyKey: `funding-smoke-${suffix}`
});
if (!verifyBillingState(data).valid) throw new Error("Operational billing fixture failed integrity verification.");

const client = new Client({ connectionString });
await client.connect();
try {
  await client.query("BEGIN");
  if (!await normalizedBillingAvailable(client)) {
    throw new Error("Normalized billing schema, exact RLS policies, triggers, or privacy columns are not healthy.");
  }
  await syncNormalizedBilling(client, data);
  await syncNormalizedBilling(client, data);
  await client.query("SELECT set_config('tcar.workspace_id', $1, true)", [workspaceId]);
  const result = await client.query(
    `SELECT
       (SELECT count(*)::int FROM tcar_billing.accounts WHERE workspace_id=$1) AS accounts,
       (SELECT count(*)::int FROM tcar_billing.ledger_entries WHERE workspace_id=$1) AS ledger_entries,
       (SELECT count(*)::int FROM tcar_billing.reservations WHERE workspace_id=$1) AS reservations,
       (SELECT count(*)::int FROM tcar_billing.usage_records WHERE workspace_id=$1) AS usage_records,
       (SELECT count(*)::int FROM tcar_billing.funding_events WHERE workspace_id=$1) AS funding_events,
       (SELECT account_id FROM tcar_billing.accounts WHERE workspace_id=$1 LIMIT 1) AS account_id,
       (SELECT metadata FROM tcar_billing.ledger_entries WHERE workspace_id=$1 LIMIT 1) AS metadata,
       (SELECT bool_and(
          metadata->>'schema_version'='virenis-billing-minimized-v1'
          AND metadata->>'kind'='ledger_metadata'
          AND metadata->>'content_digest' ~ '^sha256:[0-9a-f]{64}$'
          AND metadata->'redacted'='true'::jsonb
        ) FROM tcar_billing.ledger_entries WHERE workspace_id=$1) AS all_metadata_minimized,
       (SELECT token_accounting FROM tcar_billing.usage_records WHERE workspace_id=$1 LIMIT 1) AS token_accounting,
       (SELECT component_costs FROM tcar_billing.usage_records WHERE workspace_id=$1 LIMIT 1) AS component_costs,
       (SELECT external_reference FROM tcar_billing.funding_events WHERE workspace_id=$1 LIMIT 1) AS external_reference,
       (SELECT provider_event_id FROM tcar_billing.funding_events WHERE workspace_id=$1 LIMIT 1) AS provider_event_id`,
    [workspaceId]
  );
  const row = result.rows[0] || {};
  const serialized = JSON.stringify(row);
  if (
    row.accounts !== 1
    || row.ledger_entries !== data.billingLedgerEntries.length
    || row.reservations !== 1
    || row.usage_records !== 1
    || row.funding_events !== 1
    || row.account_id !== normalizedBillingPseudonym("account", workspaceId, data.billingAccounts[0].account_id)
    || row.metadata?.schema_version !== "virenis-billing-minimized-v1"
    || row.metadata?.redacted !== true
    || row.all_metadata_minimized !== true
    || row.token_accounting?.schema_version !== "virenis-billing-minimized-v1"
    || Object.hasOwn(row.token_accounting || {}, "calls")
    || !Array.isArray(row.component_costs)
    || row.component_costs.some((component) => component.schema_version !== "virenis-billing-minimized-v1")
    || !/^external_reference_sha256_[a-f0-9]{64}$/.test(row.external_reference || "")
    || !/^provider_event_sha256_[a-f0-9]{64}$/.test(row.provider_event_id || "")
    || serialized.includes(suffix)
  ) {
    throw new Error("Normalized billing privacy projection retained a raw identifier or free-form payload.");
  }

  const originalFundingAmount = data.billingFundingEvents[0].amount_micros;
  data.billingFundingEvents[0].amount_micros += 1;
  let conflictingReplayRejected = false;
  try {
    await syncNormalizedBilling(client, data);
  } catch (error) {
    conflictingReplayRejected = /conflicts on amount_micros/.test(String(error?.message || ""));
  } finally {
    data.billingFundingEvents[0].amount_micros = originalFundingAmount;
  }
  if (!conflictingReplayRejected) throw new Error("Conflicting immutable normalized replay was not rejected.");

  const roleFlags = await client.query(
    "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user"
  );
  const privilegedConnection = roleFlags.rows[0]?.rolsuper === true || roleFlags.rows[0]?.rolbypassrls === true;
  const rlsRole = `virenis_billing_smoke_${suffix}`;
  if (privilegedConnection) {
    await client.query(`CREATE ROLE ${rlsRole} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
    await client.query(`GRANT USAGE ON SCHEMA tcar_billing TO ${rlsRole}`);
    await client.query(`GRANT SELECT ON tcar_billing.accounts TO ${rlsRole}`);
    await client.query(`SET LOCAL ROLE ${rlsRole}`);
  }
  await client.query("SELECT set_config('tcar.workspace_id', $1, true)", [workspaceId]);
  const ownWorkspace = await client.query(
    "SELECT count(*)::int AS count FROM tcar_billing.accounts WHERE workspace_id=$1",
    [workspaceId]
  );
  await client.query("SELECT set_config('tcar.workspace_id', $1, true)", [`other_${workspaceId}`]);
  const hiddenWorkspace = await client.query(
    "SELECT count(*)::int AS count FROM tcar_billing.accounts WHERE workspace_id=$1",
    [workspaceId]
  );
  if (privilegedConnection) await client.query("RESET ROLE");
  if (ownWorkspace.rows[0]?.count !== 1 || hiddenWorkspace.rows[0]?.count !== 0) {
    throw new Error("Normalized billing RLS did not isolate workspaces for an unprivileged role.");
  }

  const legacyWorkspace = `billing_legacy_${suffix}`;
  await client.query("SELECT set_config('tcar.workspace_id', $1, true)", [legacyWorkspace]);
  await client.query(
    `INSERT INTO tcar_billing.accounts(
       workspace_id, account_id, subject_digest, unit, status,
       available_micros, reserved_micros, lifetime_credited_micros,
       lifetime_debited_micros, revision, created_at, updated_at
     ) VALUES ($1,'raw_account_identifier',$2,'credit','active',0,0,0,0,0,now(),now())`,
    [legacyWorkspace, crypto.createHash("sha256").update("legacy-subject").digest()]
  );
  let gateRejected = false;
  try {
    await syncNormalizedBilling(client, {
      users: [{ workspace_id: legacyWorkspace, status: "active" }]
    });
  } catch (error) {
    gateRejected = error?.code === "NORMALIZED_BILLING_LEGACY_PRIVACY_MIGRATION_REQUIRED";
  }
  if (!gateRejected) throw new Error("Legacy normalized billing workspace did not fail closed.");

  const numericLegacyWorkspace = `billing_numeric_legacy_${suffix}`;
  const repeated = (character) => character.repeat(64);
  const numericLegacyAccount = `account_sha256_${repeated("a")}`;
  const numericLegacyReservation = `reservation_sha256_${repeated("b")}`;
  const numericLegacyUsage = `usage_sha256_${repeated("c")}`;
  const numericLegacyRun = `run_sha256_${repeated("d")}`;
  await client.query("SELECT set_config('tcar.workspace_id', $1, true)", [numericLegacyWorkspace]);
  await client.query(
    `INSERT INTO tcar_billing.accounts(
       workspace_id, account_id, subject_digest, unit, status,
       available_micros, reserved_micros, lifetime_credited_micros,
       lifetime_debited_micros, revision, created_at, updated_at
     ) VALUES ($1,$2,$3,'credit','active',0,0,0,0,0,now(),now())`,
    [numericLegacyWorkspace, numericLegacyAccount, crypto.createHash("sha256").update("numeric-legacy-subject").digest()]
  );
  await client.query(
    `INSERT INTO tcar_billing.reservations(
       workspace_id, reservation_id, account_id, run_id, usage_kind, status,
       authorized_micros, actual_charge_micros, pricing_version_id,
       pricing_snapshot, estimated_token_ceiling, created_at
     ) VALUES ($1,$2,$3,$4,'chat','active',0,NULL,'price_test',$5::jsonb,$6::jsonb,now())`,
    [
      numericLegacyWorkspace,
      numericLegacyReservation,
      numericLegacyAccount,
      numericLegacyRun,
      JSON.stringify({
        schema_version: "virenis-billing-minimized-v1",
        pricing_version_id: "price_test",
        rules_digest: `sha256:${repeated("e")}`,
        minimum_reservation_micros: 0
      }),
      JSON.stringify({ prompt_tokens: 0, completion_tokens: 0 })
    ]
  );
  await client.query(
    `INSERT INTO tcar_billing.usage_records(
       workspace_id, usage_record_id, reservation_id, account_id, run_id,
       accounting_status, pricing_version_id, token_accounting,
       component_costs, total_charge_micros, balance_after_micros, created_at
     ) VALUES ($1,$2,$3,$4,$5,'charged','price_test',$6::jsonb,'[]'::jsonb,0,0,now())`,
    [
      numericLegacyWorkspace,
      numericLegacyUsage,
      numericLegacyReservation,
      numericLegacyAccount,
      numericLegacyRun,
      JSON.stringify({
        schema_version: "virenis-billing-minimized-v1",
        provider_reported: true,
        complete: true,
        call_count: `private-email-${suffix}@example.com`,
        totals: {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0,
          cached_tokens: 0,
          reasoning_tokens: 0
        },
        source_digest: `sha256:${repeated("f")}`
      })
    ]
  );
  let numericLegacyRejected = false;
  try {
    await syncNormalizedBilling(client, {
      users: [{ workspace_id: numericLegacyWorkspace, status: "active" }]
    });
  } catch (error) {
    numericLegacyRejected = error?.code === "NORMALIZED_BILLING_LEGACY_PRIVACY_MIGRATION_REQUIRED";
  }
  if (!numericLegacyRejected) throw new Error("PII hidden in a numeric billing field did not fail closed.");

  console.log(JSON.stringify({
    ok: true,
    replay_idempotent: true,
    conflicting_immutable_replay_rejected: true,
    minimized_privacy_projection: true,
    raw_identifiers_absent: true,
    accounting_amounts_preserved: true,
    legacy_active_workspace_gate: true,
    legacy_numeric_type_gate: true,
    cross_workspace_rls_isolation: true,
    counts: {
      accounts: row.accounts,
      ledger_entries: row.ledger_entries,
      reservations: row.reservations,
      usage_records: row.usage_records,
      funding_events: row.funding_events
    }
  }, null, 2));
} finally {
  await client.query("ROLLBACK").catch(() => undefined);
  await client.end();
  if (previousWelcome === undefined) delete process.env.APP_BILLING_WELCOME_CREDITS;
  else process.env.APP_BILLING_WELCOME_CREDITS = previousWelcome;
}

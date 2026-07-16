import crypto from "node:crypto";

const GLOBAL_WORKSPACE = "virenis_global";
const MINIMIZED_BILLING_SCHEMA = "virenis-billing-minimized-v1";
const REQUIRED_TABLES = [
  "accounts",
  "pricing_versions",
  "ledger_entries",
  "reservations",
  "usage_records",
  "funding_events"
];
const REQUIRED_TRIGGERS = [
  "accounts_update_guard",
  "accounts_delete_guard",
  "pricing_versions_immutable_guard",
  "ledger_entries_immutable_guard",
  "reservations_update_guard",
  "reservations_delete_guard",
  "usage_records_immutable_guard",
  "funding_events_immutable_guard"
];
const REQUIRED_COLUMN_SPECS = [
  ["accounts", "workspace_id", "text", false],
  ["accounts", "account_id", "text", false],
  ["accounts", "subject_digest", "bytea", false],
  ["pricing_versions", "workspace_id", "text", false],
  ["pricing_versions", "pricing_version_id", "text", false],
  ["pricing_versions", "supersedes_version_id", "text", true],
  ["pricing_versions", "rules", "jsonb", false],
  ["pricing_versions", "created_by_digest", "bytea", false],
  ["pricing_versions", "reason", "text", false],
  ["pricing_versions", "idempotency_key_digest", "text", true],
  ["pricing_versions", "request_digest", "text", true],
  ["ledger_entries", "workspace_id", "text", false],
  ["ledger_entries", "entry_id", "text", false],
  ["ledger_entries", "account_id", "text", false],
  ["ledger_entries", "reference", "text", false],
  ["ledger_entries", "actor_digest", "bytea", false],
  ["ledger_entries", "run_id", "text", true],
  ["ledger_entries", "metadata", "jsonb", false],
  ["reservations", "workspace_id", "text", false],
  ["reservations", "reservation_id", "text", false],
  ["reservations", "account_id", "text", false],
  ["reservations", "run_id", "text", false],
  ["reservations", "pricing_snapshot", "jsonb", false],
  ["reservations", "estimated_token_ceiling", "jsonb", false],
  ["reservations", "release_reason", "text", true],
  ["usage_records", "workspace_id", "text", false],
  ["usage_records", "usage_record_id", "text", false],
  ["usage_records", "reservation_id", "text", false],
  ["usage_records", "account_id", "text", false],
  ["usage_records", "run_id", "text", false],
  ["usage_records", "token_accounting", "jsonb", false],
  ["usage_records", "component_costs", "jsonb", false],
  ["funding_events", "workspace_id", "text", false],
  ["funding_events", "funding_event_id", "text", false],
  ["funding_events", "account_id", "text", false],
  ["funding_events", "external_reference", "text", false],
  ["funding_events", "provider_event_id", "text", false],
  ["funding_events", "event_identity", "text", false],
  ["funding_events", "idempotency_key_digest", "text", false],
  ["funding_events", "request_digest", "text", false],
  ["funding_events", "recorded_by_digest", "bytea", false],
  ["funding_events", "ledger_entry_id", "text", true]
];

function jsonNonNegativeIntegerPredicate(expression) {
  return `(
    jsonb_typeof(${expression}) = 'number'
    AND COALESCE(${expression} #>> '{}', '') ~ '^(0|[1-9][0-9]*)$'
  )`;
}

export function normalizedBillingPseudonym(kind, workspaceId, value) {
  const label = String(kind || "value").replace(/[^a-z0-9_]+/gi, "_").toLowerCase().slice(0, 60) || "value";
  const hash = crypto.createHash("sha256")
    .update(`virenis-billing-pseudonym-v1\0${String(workspaceId || GLOBAL_WORKSPACE)}\0${label}\0${String(value ?? "")}`, "utf8")
    .digest("hex");
  return `${label}_sha256_${hash}`;
}

export function normalizedBillingContentReceipt(kind, value, workspaceId = GLOBAL_WORKSPACE) {
  return {
    schema_version: MINIMIZED_BILLING_SCHEMA,
    kind: String(kind || "content").replace(/[^a-z0-9_]+/gi, "_").toLowerCase().slice(0, 80) || "content",
    content_digest: `sha256:${privacyDigest({
      domain: "virenis-billing-content-receipt-v1",
      workspace_id: String(workspaceId || GLOBAL_WORKSPACE),
      kind: String(kind || "content"),
      value
    })}`,
    redacted: true
  };
}

function receiptPredicate(column, kind) {
  if (!/^[a-z_]+$/.test(column) || !/^[a-z_]+$/.test(kind)) {
    throw new Error("Invalid normalized-billing privacy predicate.");
  }
  return `(
    ${column} = jsonb_build_object(
      'schema_version', '${MINIMIZED_BILLING_SCHEMA}',
      'kind', '${kind}',
      'content_digest', ${column}->>'content_digest',
      'redacted', true
    )
    AND COALESCE(${column}->>'content_digest', '') ~ '^sha256:[0-9a-f]{64}$'
  )`;
}

const LEGACY_BILLING_PRIVACY_GATE_SQL = `
  SELECT category
    FROM (
      SELECT 'durable_identifier' AS category, (
        EXISTS (SELECT 1 FROM tcar_billing.accounts WHERE workspace_id=$1 AND account_id !~ '^account_sha256_[0-9a-f]{64}$')
        OR EXISTS (SELECT 1 FROM tcar_billing.ledger_entries WHERE workspace_id=$1 AND entry_id !~ '^entry_sha256_[0-9a-f]{64}$')
        OR EXISTS (SELECT 1 FROM tcar_billing.ledger_entries WHERE workspace_id=$1 AND account_id !~ '^account_sha256_[0-9a-f]{64}$')
        OR EXISTS (SELECT 1 FROM tcar_billing.ledger_entries WHERE workspace_id=$1 AND run_id IS NOT NULL AND run_id !~ '^run_sha256_[0-9a-f]{64}$')
        OR EXISTS (SELECT 1 FROM tcar_billing.reservations WHERE workspace_id=$1 AND reservation_id !~ '^reservation_sha256_[0-9a-f]{64}$')
        OR EXISTS (SELECT 1 FROM tcar_billing.reservations WHERE workspace_id=$1 AND account_id !~ '^account_sha256_[0-9a-f]{64}$')
        OR EXISTS (SELECT 1 FROM tcar_billing.reservations WHERE workspace_id=$1 AND run_id !~ '^run_sha256_[0-9a-f]{64}$')
        OR EXISTS (SELECT 1 FROM tcar_billing.usage_records WHERE workspace_id=$1 AND usage_record_id !~ '^usage_sha256_[0-9a-f]{64}$')
        OR EXISTS (SELECT 1 FROM tcar_billing.usage_records WHERE workspace_id=$1 AND reservation_id !~ '^reservation_sha256_[0-9a-f]{64}$')
        OR EXISTS (SELECT 1 FROM tcar_billing.usage_records WHERE workspace_id=$1 AND account_id !~ '^account_sha256_[0-9a-f]{64}$')
        OR EXISTS (SELECT 1 FROM tcar_billing.usage_records WHERE workspace_id=$1 AND run_id !~ '^run_sha256_[0-9a-f]{64}$')
        OR EXISTS (SELECT 1 FROM tcar_billing.funding_events WHERE workspace_id=$1 AND funding_event_id !~ '^funding_sha256_[0-9a-f]{64}$')
        OR EXISTS (SELECT 1 FROM tcar_billing.funding_events WHERE workspace_id=$1 AND account_id !~ '^account_sha256_[0-9a-f]{64}$')
        OR EXISTS (SELECT 1 FROM tcar_billing.funding_events WHERE workspace_id=$1 AND ledger_entry_id IS NOT NULL AND ledger_entry_id !~ '^entry_sha256_[0-9a-f]{64}$')
      ) AS present
      UNION ALL
      SELECT 'external_identifier', (
        EXISTS (SELECT 1 FROM tcar_billing.ledger_entries WHERE workspace_id=$1 AND reference !~ '^ledger_reference_sha256_[0-9a-f]{64}$')
        OR EXISTS (SELECT 1 FROM tcar_billing.funding_events WHERE workspace_id=$1 AND external_reference !~ '^external_reference_sha256_[0-9a-f]{64}$')
        OR EXISTS (SELECT 1 FROM tcar_billing.funding_events WHERE workspace_id=$1 AND provider_event_id !~ '^provider_event_sha256_[0-9a-f]{64}$')
        OR EXISTS (SELECT 1 FROM tcar_billing.funding_events WHERE workspace_id=$1 AND event_identity !~ '^funding_event_identity_sha256_[0-9a-f]{64}$')
      ) AS present
      UNION ALL
      SELECT 'free_form_text', (
        EXISTS (SELECT 1 FROM tcar_billing.pricing_versions WHERE workspace_id=$1 AND reason !~ '^reason_sha256_[0-9a-f]{64}$')
        OR EXISTS (SELECT 1 FROM tcar_billing.reservations WHERE workspace_id=$1 AND release_reason IS NOT NULL AND release_reason !~ '^reason_sha256_[0-9a-f]{64}$')
      ) AS present
      UNION ALL
      SELECT 'raw_json_content', (
        EXISTS (SELECT 1 FROM tcar_billing.ledger_entries WHERE workspace_id=$1 AND NOT ${receiptPredicate("metadata", "ledger_metadata")})
        OR EXISTS (
          SELECT 1
            FROM tcar_billing.pricing_versions AS pricing,
                 LATERAL jsonb_array_elements(pricing.rules) AS rule(value)
           WHERE pricing.workspace_id=$1
             AND CASE
               WHEN jsonb_typeof(rule.value) <> 'object' THEN true
               ELSE COALESCE(rule.value->>'model_pattern_digest', '') !~ '^sha256:[0-9a-f]{64}$'
                 OR COALESCE(rule.value->>'source_digest', '') !~ '^sha256:[0-9a-f]{64}$'
                 OR NOT ${jsonNonNegativeIntegerPredicate("rule.value->'prompt_micros_per_1k'")}
                 OR NOT ${jsonNonNegativeIntegerPredicate("rule.value->'completion_micros_per_1k'")}
                 OR NOT ${jsonNonNegativeIntegerPredicate("rule.value->'cached_micros_per_1k'")}
                 OR NOT ${jsonNonNegativeIntegerPredicate("rule.value->'unclassified_micros_per_1k'")}
                 OR EXISTS (
                   SELECT 1 FROM jsonb_object_keys(rule.value) AS property(name)
                    WHERE property.name NOT IN (
                      'schema_version', 'model_pattern_digest',
                      'prompt_micros_per_1k', 'completion_micros_per_1k',
                      'cached_micros_per_1k', 'unclassified_micros_per_1k',
                      'source_digest'
                    )
                 )
                 OR COALESCE(rule.value->>'schema_version', '') <> '${MINIMIZED_BILLING_SCHEMA}'
             END
        )
        OR EXISTS (
          SELECT 1 FROM tcar_billing.reservations
           WHERE workspace_id=$1
             AND (
               pricing_snapshot <> jsonb_build_object(
                 'schema_version', '${MINIMIZED_BILLING_SCHEMA}',
                 'pricing_version_id', pricing_snapshot->'pricing_version_id',
                 'rules_digest', pricing_snapshot->'rules_digest',
                 'minimum_reservation_micros', pricing_snapshot->'minimum_reservation_micros'
               )
               OR COALESCE(pricing_snapshot->>'rules_digest', '') !~ '^sha256:[0-9a-f]{64}$'
               OR COALESCE(pricing_snapshot->>'schema_version', '') <> '${MINIMIZED_BILLING_SCHEMA}'
               OR jsonb_typeof(pricing_snapshot->'pricing_version_id') NOT IN ('string', 'null')
               OR NOT ${jsonNonNegativeIntegerPredicate("pricing_snapshot->'minimum_reservation_micros'")}
             )
        )
        OR EXISTS (
          SELECT 1 FROM tcar_billing.reservations
           WHERE workspace_id=$1
             AND (
               estimated_token_ceiling <> jsonb_build_object(
                 'prompt_tokens', estimated_token_ceiling->'prompt_tokens',
                 'completion_tokens', estimated_token_ceiling->'completion_tokens'
               )
               OR jsonb_typeof(estimated_token_ceiling) IS DISTINCT FROM 'object'
               OR NOT ${jsonNonNegativeIntegerPredicate("estimated_token_ceiling->'prompt_tokens'")}
               OR NOT ${jsonNonNegativeIntegerPredicate("estimated_token_ceiling->'completion_tokens'")}
             )
        )
        OR EXISTS (
          SELECT 1 FROM tcar_billing.usage_records
           WHERE workspace_id=$1
             AND (
               token_accounting <> jsonb_build_object(
                 'schema_version', '${MINIMIZED_BILLING_SCHEMA}',
                 'provider_reported', token_accounting->'provider_reported',
                 'complete', token_accounting->'complete',
                 'call_count', token_accounting->'call_count',
                 'totals', token_accounting->'totals',
                 'source_digest', token_accounting->'source_digest'
               )
               OR COALESCE(token_accounting->>'schema_version', '') <> '${MINIMIZED_BILLING_SCHEMA}'
               OR COALESCE(token_accounting->>'source_digest', '') !~ '^sha256:[0-9a-f]{64}$'
               OR jsonb_typeof(token_accounting->'provider_reported') IS DISTINCT FROM 'boolean'
               OR jsonb_typeof(token_accounting->'complete') IS DISTINCT FROM 'boolean'
               OR NOT ${jsonNonNegativeIntegerPredicate("token_accounting->'call_count'")}
               OR jsonb_typeof(token_accounting->'totals') IS DISTINCT FROM 'object'
               OR token_accounting->'totals' <> jsonb_build_object(
                 'prompt_tokens', token_accounting->'totals'->'prompt_tokens',
                 'completion_tokens', token_accounting->'totals'->'completion_tokens',
                 'total_tokens', token_accounting->'totals'->'total_tokens',
                 'cached_tokens', token_accounting->'totals'->'cached_tokens',
                 'reasoning_tokens', token_accounting->'totals'->'reasoning_tokens'
               )
               OR EXISTS (
                 SELECT 1
                   FROM jsonb_each(CASE
                     WHEN jsonb_typeof(token_accounting->'totals') = 'object'
                     THEN token_accounting->'totals'
                     ELSE '{}'::jsonb
                   END) AS total(name, value)
                  WHERE NOT ${jsonNonNegativeIntegerPredicate("total.value")}
               )
             )
        )
        OR EXISTS (
          SELECT 1
            FROM tcar_billing.usage_records AS usage,
                 LATERAL jsonb_array_elements(usage.component_costs) AS component(value)
           WHERE usage.workspace_id=$1
             AND CASE
               WHEN jsonb_typeof(component.value) <> 'object' THEN true
               ELSE COALESCE(component.value->>'schema_version', '') <> '${MINIMIZED_BILLING_SCHEMA}'
                 OR COALESCE(component.value->>'kind', '') NOT IN ('agent', 'final_output', 'router', 'other')
                 OR COALESCE(component.value->>'component_digest', '') !~ '^sha256:[0-9a-f]{64}$'
                 OR (component.value->>'model_digest' IS NOT NULL AND component.value->>'model_digest' !~ '^sha256:[0-9a-f]{64}$')
                 OR (component.value->>'agent_digest' IS NOT NULL AND component.value->>'agent_digest' !~ '^sha256:[0-9a-f]{64}$')
                 OR (component.value->>'step_digest' IS NOT NULL AND component.value->>'step_digest' !~ '^sha256:[0-9a-f]{64}$')
                 OR COALESCE(component.value->>'source_digest', '') !~ '^sha256:[0-9a-f]{64}$'
                 OR NOT ${jsonNonNegativeIntegerPredicate("component.value->'calls'")}
                 OR NOT ${jsonNonNegativeIntegerPredicate("component.value->'prompt_tokens'")}
                 OR NOT ${jsonNonNegativeIntegerPredicate("component.value->'completion_tokens'")}
                 OR NOT ${jsonNonNegativeIntegerPredicate("component.value->'total_tokens'")}
                 OR NOT ${jsonNonNegativeIntegerPredicate("component.value->'cached_tokens'")}
                 OR NOT ${jsonNonNegativeIntegerPredicate("component.value->'charged_micros'")}
                 OR EXISTS (
                   SELECT 1 FROM jsonb_object_keys(component.value) AS property(name)
                    WHERE property.name NOT IN (
                      'schema_version', 'kind', 'component_digest', 'model_digest',
                      'agent_digest', 'step_digest', 'calls', 'prompt_tokens',
                      'completion_tokens', 'total_tokens', 'cached_tokens',
                      'charged_micros', 'source_digest'
                    )
                 )
             END
        )
      ) AS present
    ) AS checks
   WHERE present
   LIMIT 1`;

export async function normalizedBillingAvailable(client) {
  const expectedColumnsSql = REQUIRED_COLUMN_SPECS.map(([table, column, type, nullable]) => (
    `('${table}','${column}','${type}',${nullable})`
  )).join(",");
  const result = await client.query(
    `WITH expected_columns(table_name, column_name, data_type, nullable) AS (
       VALUES ${expectedColumnsSql}
     ),
     expected_triggers(table_name, trigger_name, function_name, trigger_type) AS (
       VALUES
         ('accounts','accounts_update_guard','guard_account_update',19),
         ('accounts','accounts_delete_guard','reject_delete',11),
         ('reservations','reservations_update_guard','guard_reservation_update',19),
         ('reservations','reservations_delete_guard','reject_delete',11),
         ('pricing_versions','pricing_versions_immutable_guard','reject_immutable_change',27),
         ('ledger_entries','ledger_entries_immutable_guard','reject_immutable_change',27),
         ('usage_records','usage_records_immutable_guard','reject_immutable_change',27),
         ('funding_events','funding_events_immutable_guard','reject_immutable_change',27)
     )
     SELECT
       (SELECT count(*)::int FROM unnest($1::text[]) AS required(name)
         WHERE to_regclass('tcar_billing.' || required.name) IS NOT NULL) AS tables,
       (SELECT count(*)::int FROM pg_class AS relation
          JOIN pg_namespace AS namespace ON namespace.oid=relation.relnamespace
         WHERE namespace.nspname='tcar_billing' AND relation.relname=ANY($1::text[])
           AND relation.relrowsecurity AND relation.relforcerowsecurity) AS forced_rls,
       (SELECT count(*)::int FROM pg_policies
         WHERE schemaname='tcar_billing' AND tablename=ANY($1::text[])
           AND policyname=tablename || '_workspace_isolation'
           AND permissive='PERMISSIVE' AND cmd='ALL'
           AND roles=ARRAY['public']::name[]
           AND regexp_replace(COALESCE(qual,''), '\\s+', '', 'g')='(workspace_id=tcar_billing.current_workspace_id())'
           AND regexp_replace(COALESCE(with_check,''), '\\s+', '', 'g')='(workspace_id=tcar_billing.current_workspace_id())') AS policies,
       (SELECT count(*)::int FROM pg_policies
         WHERE schemaname='tcar_billing' AND tablename=ANY($1::text[])) AS policy_total,
       (SELECT count(*)::int FROM expected_columns AS expected
         JOIN information_schema.columns AS actual
           ON actual.table_schema='tcar_billing'
          AND actual.table_name=expected.table_name
          AND actual.column_name=expected.column_name
          AND actual.data_type=expected.data_type
          AND (actual.is_nullable='YES')=expected.nullable) AS columns,
       (SELECT count(*)::int FROM expected_triggers AS expected
          JOIN pg_class AS relation ON relation.relname=expected.table_name
          JOIN pg_namespace AS namespace ON namespace.oid=relation.relnamespace AND namespace.nspname='tcar_billing'
          JOIN pg_trigger AS trigger ON trigger.tgrelid=relation.oid
            AND trigger.tgname=expected.trigger_name AND NOT trigger.tgisinternal
            AND trigger.tgtype=expected.trigger_type
          JOIN pg_proc AS procedure ON procedure.oid=trigger.tgfoid AND procedure.proname=expected.function_name
          JOIN pg_namespace AS procedure_namespace ON procedure_namespace.oid=procedure.pronamespace
            AND procedure_namespace.nspname='tcar_billing') AS triggers,
       (SELECT count(DISTINCT trigger.tgname)::int FROM pg_trigger AS trigger
          JOIN pg_class AS relation ON relation.oid=trigger.tgrelid
          JOIN pg_namespace AS namespace ON namespace.oid=relation.relnamespace
         WHERE namespace.nspname='tcar_billing' AND NOT trigger.tgisinternal
           AND trigger.tgname=ANY($2::text[])) AS trigger_names`,
    [REQUIRED_TABLES, REQUIRED_TRIGGERS]
  );
  const status = result.rows[0] || {};
  return status.tables === REQUIRED_TABLES.length
    && status.forced_rls === REQUIRED_TABLES.length
    && status.policies === REQUIRED_TABLES.length
    && status.policy_total === REQUIRED_TABLES.length
    && status.columns === REQUIRED_COLUMN_SPECS.length
    && status.triggers === REQUIRED_TRIGGERS.length
    && status.trigger_names === REQUIRED_TRIGGERS.length;
}

export async function syncNormalizedBilling(client, data) {
  const workspaces = collectBillingWorkspaces(data);
  for (const workspaceId of workspaces) {
    await setWorkspace(client, workspaceId);
    await assertNormalizedBillingWorkspacePrivacy(client, workspaceId);
  }
  await syncPricingVersions(client, data.billingPricingVersions || []);
  const accountsById = new Map((data.billingAccounts || []).map((account) => [account.account_id, account]));
  for (const account of accountsById.values()) {
    await setWorkspace(client, account.workspace_id);
    const accountId = normalizedBillingPseudonym("account", account.workspace_id, account.account_id);
    await client.query(
      `INSERT INTO tcar_billing.accounts(
         workspace_id, account_id, subject_digest, unit, status,
         available_micros, reserved_micros, lifetime_credited_micros,
         lifetime_debited_micros, revision, ledger_head_hash, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (workspace_id, account_id) DO UPDATE SET
         status=EXCLUDED.status,
         available_micros=EXCLUDED.available_micros,
         reserved_micros=EXCLUDED.reserved_micros,
         lifetime_credited_micros=EXCLUDED.lifetime_credited_micros,
         lifetime_debited_micros=EXCLUDED.lifetime_debited_micros,
         revision=EXCLUDED.revision,
         ledger_head_hash=EXCLUDED.ledger_head_hash,
         updated_at=EXCLUDED.updated_at`,
      [
        account.workspace_id,
        accountId,
        subjectDigest(account.workspace_id, account.user_id),
        account.unit || "credit",
        account.status || "active",
        account.available_micros,
        account.reserved_micros,
        account.lifetime_credited_micros,
        account.lifetime_debited_micros,
        account.revision,
        account.ledger_head_hash || null,
        iso(account.created_at),
        iso(account.updated_at)
      ]
    );
    await assertImmutableRow(client, "accounts", "account_id", account.workspace_id, accountId, {
      subject_digest: subjectDigest(account.workspace_id, account.user_id),
      unit: account.unit || "credit",
      status: account.status || "active",
      available_micros: account.available_micros,
      reserved_micros: account.reserved_micros,
      lifetime_credited_micros: account.lifetime_credited_micros,
      lifetime_debited_micros: account.lifetime_debited_micros,
      revision: account.revision,
      ledger_head_hash: account.ledger_head_hash || null,
      created_at: iso(account.created_at),
      updated_at: iso(account.updated_at)
    });
  }

  for (const entry of data.billingLedgerEntries || []) {
    const account = accountsById.get(entry.account_id);
    if (!account) throw new Error(`Normalized billing entry ${entry.entry_id} has no account.`);
    await setWorkspace(client, entry.workspace_id);
    const accountId = normalizedBillingPseudonym("account", entry.workspace_id, entry.account_id);
    const entryId = normalizedBillingPseudonym("entry", entry.workspace_id, entry.entry_id);
    const reference = normalizedBillingPseudonym("ledger_reference", entry.workspace_id, entry.reference);
    const runId = entry.run_id
      ? normalizedBillingPseudonym("run", entry.workspace_id, entry.run_id)
      : null;
    const metadata = normalizedBillingContentReceipt("ledger_metadata", entry.metadata || {}, entry.workspace_id);
    await client.query(
      `INSERT INTO tcar_billing.ledger_entries(
         workspace_id, entry_id, account_id, sequence_no, entry_type,
         available_delta_micros, reserved_delta_micros, credited_micros,
         debited_micros, available_after_micros, reserved_after_micros,
         reference, actor_digest, run_id, pricing_version_id, metadata,
         previous_hash, entry_hash, created_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17,$18,$19)
       ON CONFLICT (workspace_id, entry_id) DO NOTHING`,
      [
        entry.workspace_id,
        entryId,
        accountId,
        entry.sequence,
        entry.type,
        entry.available_delta_micros,
        entry.reserved_delta_micros,
        entry.credited_micros,
        entry.debited_micros,
        entry.available_after_micros,
        entry.reserved_after_micros,
        reference,
        subjectDigest(entry.workspace_id, entry.actor_id),
        runId,
        entry.pricing_version_id || null,
        JSON.stringify(metadata),
        entry.previous_hash || null,
        entry.entry_hash,
        iso(entry.created_at)
      ]
    );
    await assertImmutableRow(client, "ledger_entries", "entry_id", entry.workspace_id, entryId, {
      account_id: accountId,
      sequence_no: entry.sequence,
      entry_type: entry.type,
      available_delta_micros: entry.available_delta_micros,
      reserved_delta_micros: entry.reserved_delta_micros,
      credited_micros: entry.credited_micros,
      debited_micros: entry.debited_micros,
      available_after_micros: entry.available_after_micros,
      reserved_after_micros: entry.reserved_after_micros,
      reference,
      actor_digest: subjectDigest(entry.workspace_id, entry.actor_id),
      run_id: runId,
      pricing_version_id: entry.pricing_version_id || null,
      metadata,
      previous_hash: entry.previous_hash || null,
      entry_hash: entry.entry_hash,
      created_at: iso(entry.created_at)
    });
  }

  for (const reservation of data.billingReservations || []) {
    await setWorkspace(client, reservation.workspace_id);
    const reservationId = normalizedBillingPseudonym("reservation", reservation.workspace_id, reservation.reservation_id);
    const accountId = normalizedBillingPseudonym("account", reservation.workspace_id, reservation.account_id);
    const runId = normalizedBillingPseudonym("run", reservation.workspace_id, reservation.run_id);
    const pricingSnapshot = minimizedPricingSnapshot(reservation.workspace_id, reservation.pricing_snapshot || {});
    const tokenCeiling = minimizedTokenCeiling(reservation.estimated_token_ceiling || {});
    const releaseReason = reservation.release_reason
      ? normalizedBillingPseudonym("reason", reservation.workspace_id, reservation.release_reason)
      : null;
    await client.query(
      `INSERT INTO tcar_billing.reservations(
         workspace_id, reservation_id, account_id, run_id, usage_kind, status,
         authorized_micros, actual_charge_micros, pricing_version_id,
         pricing_snapshot, estimated_token_ceiling, created_at, settled_at,
         released_at, release_reason
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13,$14,$15)
       ON CONFLICT (workspace_id, reservation_id) DO UPDATE SET
         status=EXCLUDED.status,
         actual_charge_micros=EXCLUDED.actual_charge_micros,
         settled_at=EXCLUDED.settled_at,
         released_at=EXCLUDED.released_at,
         release_reason=EXCLUDED.release_reason`,
      [
        reservation.workspace_id,
        reservationId,
        accountId,
        runId,
        reservation.kind,
        reservation.status,
        reservation.authorized_micros,
        reservation.actual_charge_micros,
        reservation.pricing_version_id,
        JSON.stringify(pricingSnapshot),
        JSON.stringify(tokenCeiling),
        iso(reservation.created_at),
        nullableIso(reservation.settled_at),
        nullableIso(reservation.released_at),
        releaseReason
      ]
    );
    await assertImmutableRow(client, "reservations", "reservation_id", reservation.workspace_id, reservationId, {
      account_id: accountId,
      run_id: runId,
      usage_kind: reservation.kind,
      status: reservation.status,
      authorized_micros: reservation.authorized_micros,
      actual_charge_micros: reservation.actual_charge_micros,
      pricing_version_id: reservation.pricing_version_id,
      pricing_snapshot: pricingSnapshot,
      estimated_token_ceiling: tokenCeiling,
      created_at: iso(reservation.created_at),
      settled_at: nullableIso(reservation.settled_at),
      released_at: nullableIso(reservation.released_at),
      release_reason: releaseReason
    });
  }

  for (const record of data.billingUsageRecords || []) {
    await setWorkspace(client, record.workspace_id);
    const usageRecordId = normalizedBillingPseudonym("usage", record.workspace_id, record.usage_record_id);
    const reservationId = normalizedBillingPseudonym("reservation", record.workspace_id, record.reservation_id);
    const accountId = normalizedBillingPseudonym("account", record.workspace_id, record.account_id);
    const runId = normalizedBillingPseudonym("run", record.workspace_id, record.run_id);
    const tokenAccounting = minimizedTokenAccounting(record.workspace_id, record.token_accounting || {});
    const componentCosts = minimizedComponentCosts(record.workspace_id, record.component_costs || []);
    await client.query(
      `INSERT INTO tcar_billing.usage_records(
         workspace_id, usage_record_id, reservation_id, account_id, run_id,
         accounting_status, pricing_version_id, token_accounting,
         component_costs, total_charge_micros, balance_after_micros, created_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,$12)
       ON CONFLICT (workspace_id, usage_record_id) DO NOTHING`,
      [
        record.workspace_id,
        usageRecordId,
        reservationId,
        accountId,
        runId,
        record.status,
        record.pricing_version_id,
        JSON.stringify(tokenAccounting),
        JSON.stringify(componentCosts),
        record.total_charge_micros,
        record.balance_after_micros,
        iso(record.created_at)
      ]
    );
    await assertImmutableRow(client, "usage_records", "usage_record_id", record.workspace_id, usageRecordId, {
      reservation_id: reservationId,
      account_id: accountId,
      run_id: runId,
      accounting_status: record.status,
      pricing_version_id: record.pricing_version_id,
      token_accounting: tokenAccounting,
      component_costs: componentCosts,
      total_charge_micros: record.total_charge_micros,
      balance_after_micros: record.balance_after_micros,
      created_at: iso(record.created_at)
    });
  }

  for (const event of data.billingFundingEvents || []) {
    const account = accountsById.get(event.account_id);
    if (!account) throw new Error(`Normalized funding event ${event.funding_event_id} has no account.`);
    await setWorkspace(client, account.workspace_id);
    const projection = {
      fundingEventId: normalizedBillingPseudonym("funding", account.workspace_id, event.funding_event_id),
      accountId: normalizedBillingPseudonym("account", account.workspace_id, event.account_id),
      externalReference: normalizedBillingPseudonym("external_reference", account.workspace_id, event.external_reference),
      providerEventId: normalizedBillingPseudonym("provider_event", account.workspace_id, event.provider_event_id),
      eventIdentity: normalizedBillingPseudonym("funding_event_identity", account.workspace_id, event.event_identity),
      ledgerEntryId: event.ledger_entry_id
        ? normalizedBillingPseudonym("entry", account.workspace_id, event.ledger_entry_id)
        : null
    };
    await client.query(
      `INSERT INTO tcar_billing.funding_events(
         workspace_id, funding_event_id, account_id, provider,
         external_reference, provider_event_id, event_identity, funding_status,
         amount_micros, idempotency_key_digest, request_digest,
         recorded_by_digest, ledger_entry_id, created_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (workspace_id, funding_event_id) DO NOTHING`,
      [
        account.workspace_id,
        projection.fundingEventId,
        projection.accountId,
        event.provider,
        projection.externalReference,
        projection.providerEventId,
        projection.eventIdentity,
        event.status,
        event.amount_micros,
        privateBillingHexDigest("funding_idempotency", account.workspace_id, event.idempotency_key_digest),
        privateBillingHexDigest("funding_request", account.workspace_id, event.request_digest),
        subjectDigest(account.workspace_id, event.recorded_by),
        projection.ledgerEntryId,
        iso(event.created_at)
      ]
    );
    await assertImmutableRow(client, "funding_events", "funding_event_id", account.workspace_id, projection.fundingEventId, {
      account_id: projection.accountId,
      provider: event.provider,
      external_reference: projection.externalReference,
      provider_event_id: projection.providerEventId,
      event_identity: projection.eventIdentity,
      funding_status: event.status,
      amount_micros: event.amount_micros,
      idempotency_key_digest: privateBillingHexDigest("funding_idempotency", account.workspace_id, event.idempotency_key_digest),
      request_digest: privateBillingHexDigest("funding_request", account.workspace_id, event.request_digest),
      recorded_by_digest: subjectDigest(account.workspace_id, event.recorded_by),
      ledger_entry_id: projection.ledgerEntryId,
      created_at: iso(event.created_at)
    });
  }
}

export async function assertNormalizedBillingWorkspacePrivacy(client, workspaceId) {
  const result = await client.query(LEGACY_BILLING_PRIVACY_GATE_SQL, [workspaceId]);
  if (!result.rowCount) return;
  const error = new Error(
    `Normalized billing privacy migration required for ${normalizedBillingPseudonym("workspace", GLOBAL_WORKSPACE, workspaceId)} `
    + `(${result.rows[0]?.category || "legacy_content"}). Preserve required accounting facts, but stop application writes `
    + "and use a reviewed shadow-table rebuild and atomic cutover; BYPASSRLS is for complete inventory, not for bypassing immutable triggers."
  );
  error.code = "NORMALIZED_BILLING_LEGACY_PRIVACY_MIGRATION_REQUIRED";
  throw error;
}

async function syncPricingVersions(client, versions) {
  await setWorkspace(client, GLOBAL_WORKSPACE);
  for (const version of versions) {
    const rules = minimizedPricingRules(GLOBAL_WORKSPACE, version.rules || []);
    const reason = normalizedBillingPseudonym("reason", GLOBAL_WORKSPACE, version.reason || "");
    await client.query(
      `INSERT INTO tcar_billing.pricing_versions(
         workspace_id, pricing_version_id, schema_version, supersedes_version_id,
         rules, minimum_reservation_micros, created_by_digest, reason,
         idempotency_key_digest, request_digest, created_at
       ) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (workspace_id, pricing_version_id) DO NOTHING`,
      [
        GLOBAL_WORKSPACE,
        version.pricing_version_id,
        version.schema_version,
        version.supersedes_version_id || null,
        JSON.stringify(rules),
        version.minimum_reservation_micros,
        subjectDigest(GLOBAL_WORKSPACE, version.created_by),
        reason,
        version.idempotency_key_digest
          ? privateBillingHexDigest("pricing_idempotency", GLOBAL_WORKSPACE, version.idempotency_key_digest)
          : null,
        version.request_digest
          ? privateBillingHexDigest("pricing_request", GLOBAL_WORKSPACE, version.request_digest)
          : null,
        iso(version.created_at)
      ]
    );
    await assertImmutableRow(client, "pricing_versions", "pricing_version_id", GLOBAL_WORKSPACE, version.pricing_version_id, {
      schema_version: version.schema_version,
      supersedes_version_id: version.supersedes_version_id || null,
      rules,
      minimum_reservation_micros: version.minimum_reservation_micros,
      created_by_digest: subjectDigest(GLOBAL_WORKSPACE, version.created_by),
      reason,
      idempotency_key_digest: version.idempotency_key_digest
        ? privateBillingHexDigest("pricing_idempotency", GLOBAL_WORKSPACE, version.idempotency_key_digest)
        : null,
      request_digest: version.request_digest
        ? privateBillingHexDigest("pricing_request", GLOBAL_WORKSPACE, version.request_digest)
        : null,
      created_at: iso(version.created_at)
    });
  }
}

function collectBillingWorkspaces(data) {
  const workspaces = new Set([GLOBAL_WORKSPACE]);
  for (const user of data.users || []) {
    const workspaceId = String(user?.workspace_id || "").trim();
    if (workspaceId && user?.status !== "deleted") workspaces.add(workspaceId);
  }
  for (const collection of [
    "billingAccounts", "billingLedgerEntries", "billingReservations",
    "billingUsageRecords", "billingFundingEvents"
  ]) {
    for (const item of data[collection] || []) {
      const workspaceId = String(item?.workspace_id || "").trim();
      if (workspaceId) workspaces.add(workspaceId);
    }
  }
  return [...workspaces].sort();
}

export function minimizedPricingRules(workspaceId, rules) {
  return (Array.isArray(rules) ? rules : []).map((rule) => ({
    schema_version: MINIMIZED_BILLING_SCHEMA,
    model_pattern_digest: billingDigest("pricing_model_pattern", workspaceId, rule?.model_pattern || "*"),
    prompt_micros_per_1k: accountingInteger(rule?.prompt_micros_per_1k),
    completion_micros_per_1k: accountingInteger(rule?.completion_micros_per_1k),
    cached_micros_per_1k: accountingInteger(rule?.cached_micros_per_1k),
    unclassified_micros_per_1k: accountingInteger(rule?.unclassified_micros_per_1k),
    source_digest: billingDigest("pricing_rule", workspaceId, rule || {})
  }));
}

function minimizedPricingSnapshot(workspaceId, snapshot) {
  return {
    schema_version: MINIMIZED_BILLING_SCHEMA,
    pricing_version_id: snapshot?.pricing_version_id || null,
    rules_digest: billingDigest("pricing_rules", workspaceId, snapshot?.rules || []),
    minimum_reservation_micros: accountingInteger(snapshot?.minimum_reservation_micros)
  };
}

function minimizedTokenCeiling(ceiling) {
  return {
    prompt_tokens: accountingInteger(ceiling?.prompt_tokens),
    completion_tokens: accountingInteger(ceiling?.completion_tokens)
  };
}

export function minimizedTokenAccounting(workspaceId, accounting) {
  const totals = accounting?.totals || {};
  return {
    schema_version: MINIMIZED_BILLING_SCHEMA,
    provider_reported: accounting?.provider_reported === true,
    complete: accounting?.complete === true,
    call_count: accountingInteger(accounting?.call_count),
    totals: {
      prompt_tokens: accountingInteger(totals.prompt_tokens),
      completion_tokens: accountingInteger(totals.completion_tokens),
      total_tokens: accountingInteger(totals.total_tokens),
      cached_tokens: accountingInteger(totals.cached_tokens),
      reasoning_tokens: accountingInteger(totals.reasoning_tokens)
    },
    source_digest: billingDigest("token_accounting", workspaceId, accounting)
  };
}

export function minimizedComponentCosts(workspaceId, components) {
  return (Array.isArray(components) ? components : []).map((component, index) => ({
    schema_version: MINIMIZED_BILLING_SCHEMA,
    kind: ["agent", "final_output", "router", "other"].includes(component?.kind) ? component.kind : "other",
    component_digest: billingDigest(
      "usage_component",
      workspaceId,
      component?.component_key || component?.component || `component_${index + 1}`
    ),
    model_digest: nullableBillingDigest("model", workspaceId, component?.model),
    agent_digest: nullableBillingDigest("agent", workspaceId, component?.agent_id),
    step_digest: nullableBillingDigest("step", workspaceId, component?.step_id),
    calls: accountingInteger(component?.calls),
    prompt_tokens: accountingInteger(component?.prompt_tokens),
    completion_tokens: accountingInteger(component?.completion_tokens),
    total_tokens: accountingInteger(component?.total_tokens),
    cached_tokens: accountingInteger(component?.cached_tokens),
    charged_micros: accountingInteger(component?.charged_micros),
    source_digest: billingDigest("component_cost", workspaceId, component || {})
  }));
}

function accountingInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

function nullableBillingDigest(kind, workspaceId, value) {
  return value === null || value === undefined || value === ""
    ? null
    : billingDigest(kind, workspaceId, value);
}

function billingDigest(kind, workspaceId, value) {
  return `sha256:${crypto.createHash("sha256")
    .update(`virenis-billing-content-v1\0${workspaceId}\0${kind}\0${canonical(value)}`, "utf8")
    .digest("hex")}`;
}

function privateBillingHexDigest(kind, workspaceId, value) {
  return crypto.createHash("sha256")
    .update(`virenis-billing-private-field-v1\0${workspaceId}\0${kind}\0${String(value || "")}`, "utf8")
    .digest("hex");
}

function privacyDigest(value) {
  return crypto.createHash("sha256").update(canonical(value), "utf8").digest("hex");
}

async function assertImmutableRow(client, table, keyColumn, workspaceId, key, expected) {
  const columns = Object.keys(expected);
  const result = await client.query(
    `SELECT ${columns.map((column) => `"${column}"`).join(",")}
       FROM tcar_billing.${table}
      WHERE workspace_id=$1 AND "${keyColumn}"=$2`,
    [workspaceId, key]
  );
  if (result.rowCount !== 1) throw new Error(`Normalized billing row ${table}:${key} is missing.`);
  for (const column of columns) {
    if (canonical(result.rows[0][column]) !== canonical(expected[column])) {
      throw new Error(`Normalized billing row ${table}:${key} conflicts on ${column}.`);
    }
  }
}

async function setWorkspace(client, workspaceId) {
  await client.query("SELECT set_config('tcar.workspace_id', $1, true)", [workspaceId]);
}

function subjectDigest(workspaceId, value) {
  return crypto.createHash("sha256").update(`${workspaceId}\0${String(value || "system")}`, "utf8").digest();
}

function canonical(value) {
  if (Buffer.isBuffer(value)) return value.toString("hex");
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (typeof value === "string" && /^-?[0-9]+$/.test(value)) return canonical(Number(value));
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

function iso(value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date(0).toISOString();
}

function nullableIso(value) {
  return value ? iso(value) : null;
}

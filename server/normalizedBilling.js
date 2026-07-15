import crypto from "node:crypto";

const GLOBAL_WORKSPACE = "virenis_global";
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

export async function normalizedBillingAvailable(client) {
  const result = await client.query(
    `SELECT
       (SELECT count(*)::int FROM unnest($1::text[]) AS required(name)
         WHERE to_regclass('tcar_billing.' || required.name) IS NOT NULL) AS tables,
       (SELECT count(*)::int FROM pg_class AS relation
          JOIN pg_namespace AS namespace ON namespace.oid=relation.relnamespace
         WHERE namespace.nspname='tcar_billing' AND relation.relname=ANY($1::text[])
           AND relation.relrowsecurity AND relation.relforcerowsecurity) AS forced_rls,
       (SELECT count(*)::int FROM pg_policies
         WHERE schemaname='tcar_billing' AND tablename=ANY($1::text[])
           AND policyname=tablename || '_workspace_isolation') AS policies,
       (SELECT count(DISTINCT trigger.tgname)::int FROM pg_trigger AS trigger
          JOIN pg_class AS relation ON relation.oid=trigger.tgrelid
          JOIN pg_namespace AS namespace ON namespace.oid=relation.relnamespace
         WHERE namespace.nspname='tcar_billing' AND NOT trigger.tgisinternal
           AND trigger.tgname=ANY($2::text[])) AS triggers`,
    [REQUIRED_TABLES, REQUIRED_TRIGGERS]
  );
  const status = result.rows[0] || {};
  return status.tables === REQUIRED_TABLES.length
    && status.forced_rls === REQUIRED_TABLES.length
    && status.policies === REQUIRED_TABLES.length
    && status.triggers === REQUIRED_TRIGGERS.length;
}

export async function syncNormalizedBilling(client, data) {
  await syncPricingVersions(client, data.billingPricingVersions || []);
  const accountsById = new Map((data.billingAccounts || []).map((account) => [account.account_id, account]));
  for (const account of accountsById.values()) {
    await setWorkspace(client, account.workspace_id);
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
        account.account_id,
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
    await assertImmutableRow(client, "accounts", "account_id", account.workspace_id, account.account_id, {
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
        entry.entry_id,
        entry.account_id,
        entry.sequence,
        entry.type,
        entry.available_delta_micros,
        entry.reserved_delta_micros,
        entry.credited_micros,
        entry.debited_micros,
        entry.available_after_micros,
        entry.reserved_after_micros,
        entry.reference,
        subjectDigest(entry.workspace_id, entry.actor_id),
        entry.run_id || null,
        entry.pricing_version_id || null,
        JSON.stringify(entry.metadata || {}),
        entry.previous_hash || null,
        entry.entry_hash,
        iso(entry.created_at)
      ]
    );
    await assertImmutableRow(client, "ledger_entries", "entry_id", entry.workspace_id, entry.entry_id, {
      account_id: entry.account_id,
      sequence_no: entry.sequence,
      entry_type: entry.type,
      available_delta_micros: entry.available_delta_micros,
      reserved_delta_micros: entry.reserved_delta_micros,
      credited_micros: entry.credited_micros,
      debited_micros: entry.debited_micros,
      available_after_micros: entry.available_after_micros,
      reserved_after_micros: entry.reserved_after_micros,
      reference: entry.reference,
      actor_digest: subjectDigest(entry.workspace_id, entry.actor_id),
      run_id: entry.run_id || null,
      pricing_version_id: entry.pricing_version_id || null,
      metadata: entry.metadata || {},
      previous_hash: entry.previous_hash || null,
      entry_hash: entry.entry_hash,
      created_at: iso(entry.created_at)
    });
  }

  for (const reservation of data.billingReservations || []) {
    await setWorkspace(client, reservation.workspace_id);
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
        reservation.reservation_id,
        reservation.account_id,
        reservation.run_id,
        reservation.kind,
        reservation.status,
        reservation.authorized_micros,
        reservation.actual_charge_micros,
        reservation.pricing_version_id,
        JSON.stringify(reservation.pricing_snapshot || {}),
        JSON.stringify(reservation.estimated_token_ceiling || {}),
        iso(reservation.created_at),
        nullableIso(reservation.settled_at),
        nullableIso(reservation.released_at),
        reservation.release_reason || null
      ]
    );
    await assertImmutableRow(client, "reservations", "reservation_id", reservation.workspace_id, reservation.reservation_id, {
      account_id: reservation.account_id,
      run_id: reservation.run_id,
      usage_kind: reservation.kind,
      status: reservation.status,
      authorized_micros: reservation.authorized_micros,
      actual_charge_micros: reservation.actual_charge_micros,
      pricing_version_id: reservation.pricing_version_id,
      pricing_snapshot: reservation.pricing_snapshot || {},
      estimated_token_ceiling: reservation.estimated_token_ceiling || {},
      created_at: iso(reservation.created_at),
      settled_at: nullableIso(reservation.settled_at),
      released_at: nullableIso(reservation.released_at),
      release_reason: reservation.release_reason || null
    });
  }

  for (const record of data.billingUsageRecords || []) {
    await setWorkspace(client, record.workspace_id);
    await client.query(
      `INSERT INTO tcar_billing.usage_records(
         workspace_id, usage_record_id, reservation_id, account_id, run_id,
         accounting_status, pricing_version_id, token_accounting,
         component_costs, total_charge_micros, balance_after_micros, created_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,$12)
       ON CONFLICT (workspace_id, usage_record_id) DO NOTHING`,
      [
        record.workspace_id,
        record.usage_record_id,
        record.reservation_id,
        record.account_id,
        record.run_id,
        record.status,
        record.pricing_version_id,
        JSON.stringify(record.token_accounting || {}),
        JSON.stringify(record.component_costs || []),
        record.total_charge_micros,
        record.balance_after_micros,
        iso(record.created_at)
      ]
    );
    await assertImmutableRow(client, "usage_records", "usage_record_id", record.workspace_id, record.usage_record_id, {
      reservation_id: record.reservation_id,
      account_id: record.account_id,
      run_id: record.run_id,
      accounting_status: record.status,
      pricing_version_id: record.pricing_version_id,
      token_accounting: record.token_accounting || {},
      component_costs: record.component_costs || [],
      total_charge_micros: record.total_charge_micros,
      balance_after_micros: record.balance_after_micros,
      created_at: iso(record.created_at)
    });
  }

  for (const event of data.billingFundingEvents || []) {
    const account = accountsById.get(event.account_id);
    if (!account) throw new Error(`Normalized funding event ${event.funding_event_id} has no account.`);
    await setWorkspace(client, account.workspace_id);
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
        event.funding_event_id,
        event.account_id,
        event.provider,
        event.external_reference,
        event.provider_event_id,
        event.event_identity,
        event.status,
        event.amount_micros,
        event.idempotency_key_digest,
        event.request_digest,
        subjectDigest(account.workspace_id, event.recorded_by),
        event.ledger_entry_id || null,
        iso(event.created_at)
      ]
    );
    await assertImmutableRow(client, "funding_events", "funding_event_id", account.workspace_id, event.funding_event_id, {
      account_id: event.account_id,
      provider: event.provider,
      external_reference: event.external_reference,
      provider_event_id: event.provider_event_id,
      event_identity: event.event_identity,
      funding_status: event.status,
      amount_micros: event.amount_micros,
      idempotency_key_digest: event.idempotency_key_digest,
      request_digest: event.request_digest,
      recorded_by_digest: subjectDigest(account.workspace_id, event.recorded_by),
      ledger_entry_id: event.ledger_entry_id || null,
      created_at: iso(event.created_at)
    });
  }
}

async function syncPricingVersions(client, versions) {
  await setWorkspace(client, GLOBAL_WORKSPACE);
  for (const version of versions) {
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
        JSON.stringify(version.rules || []),
        version.minimum_reservation_micros,
        subjectDigest(GLOBAL_WORKSPACE, version.created_by),
        version.reason || "",
        version.idempotency_key_digest || null,
        version.request_digest || null,
        iso(version.created_at)
      ]
    );
    await assertImmutableRow(client, "pricing_versions", "pricing_version_id", GLOBAL_WORKSPACE, version.pricing_version_id, {
      schema_version: version.schema_version,
      supersedes_version_id: version.supersedes_version_id || null,
      rules: version.rules || [],
      minimum_reservation_micros: version.minimum_reservation_micros,
      created_by_digest: subjectDigest(GLOBAL_WORKSPACE, version.created_by),
      reason: version.reason || "",
      idempotency_key_digest: version.idempotency_key_digest || null,
      request_digest: version.request_digest || null,
      created_at: iso(version.created_at)
    });
  }
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

import crypto from "node:crypto";
import {
  agentRevision,
  agentRevisionSnapshot,
  outcomeContractDefinitionMaterial,
  verifyEventChain,
  verifyExecutionRecord,
  verifyOutcomeContract
} from "./outcomes.js";

const GLOBAL_WORKSPACE = "virenis_global";
const CONTENT_FREE_LEDGER_SCHEMA = "virenis-ledger-content-free-v1";
const SERVICE_ACTORS = new Set([
  "system", "virenis-web", "router-system", "tcar-system", "tracking-user"
]);
const RANK_PRIOR_MEAN = 0.5;
const RANK_PRIOR_WEIGHT = 2;
const RANK_HALF_LIFE_DAYS = 180;
const REQUIRED_LEDGER_TABLES = [
  "workspaces", "agent_revisions", "agent_events", "execution_runs",
  "source_revisions", "execution_steps", "execution_events", "evidence_records",
  "execution_artifacts", "artifact_evidence", "outcome_contracts",
  "outcome_contract_versions", "outcome_instances", "outcome_observations",
  "outcome_settlements", "outcome_disputes", "settlement_metric_scores",
  "settlement_observations", "reality_rank_snapshots"
];
const REQUIRED_LEDGER_TRIGGERS = [
  "execution_events_chain_guard", "agent_events_chain_guard",
  "outcome_observations_supersession_guard", "outcome_settlements_chain_guard",
  "settlement_observations_scope_guard", "outcome_disputes_scope_guard", "reality_rank_chain_guard",
  "execution_runs_update_guard", "execution_runs_delete_guard",
  "outcome_contracts_update_guard", "outcome_contracts_delete_guard",
  "outcome_instances_update_guard", "outcome_instances_delete_guard",
  ...[
    "agent_revisions", "agent_events", "source_revisions", "execution_steps",
    "execution_events", "evidence_records", "execution_artifacts", "artifact_evidence",
    "outcome_contract_versions", "outcome_observations", "outcome_settlements",
    "outcome_disputes", "settlement_metric_scores", "settlement_observations",
    "reality_rank_snapshots"
  ].map((table) => `${table}_immutable_guard`)
];

/**
 * Return the durable identifier used for a human actor in the append-only
 * projection. The operational store remains the identity source of truth; the
 * long-retention ledger only needs a stable, workspace-scoped correlation key.
 * Service principals are non-person identities and remain readable.
 */
export function normalizedLedgerActorId(workspaceId, value) {
  const actor = String(value || "system").trim() || "system";
  if (SERVICE_ACTORS.has(actor)) return actor;
  const hash = crypto.createHash("sha256")
    .update(`virenis-ledger-actor-v1\0${workspace(workspaceId)}\0${actor}`, "utf8")
    .digest("hex");
  return `actor_sha256_${hash}`;
}

/**
 * Replace arbitrary text/JSON with a typed digest receipt before it reaches an
 * immutable ledger JSON column. This intentionally contains no excerpt that
 * could survive an account erasure through the operational store.
 */
export function normalizedLedgerContentReceipt(kind, value) {
  return {
    schema_version: CONTENT_FREE_LEDGER_SCHEMA,
    kind: safeEvent(kind, "content"),
    content_digest: `sha256:${privacyDigest(value).toString("hex")}`,
    redacted: true
  };
}

function normalizedLedgerIdempotencyKey(workspaceId, value) {
  if (value === null || value === undefined || value === "") return null;
  return `key_sha256_${crypto.createHash("sha256")
    .update(`virenis-ledger-key-v1\0${workspace(workspaceId)}\0${String(value)}`, "utf8")
    .digest("hex")}`;
}

export function normalizedLedgerLabel(kind, workspaceId, value) {
  if (arguments.length < 3) {
    throw new TypeError("Normalized ledger labels require an explicit workspace scope.");
  }
  const safeKind = safeEvent(kind, "value");
  const scopedWorkspace = workspace(workspaceId);
  return `${safeKind}_ws2_sha256_${privacyDigest({
    schema_version: "virenis-ledger-label-v2",
    workspace_id: scopedWorkspace,
    kind: safeKind,
    value
  }).toString("hex")}`;
}

function contentReceiptPredicate(column, kind) {
  if (!/^[a-z_.]+$/.test(column) || !/^[a-z_]+$/.test(kind)) {
    throw new Error("Invalid normalized-ledger privacy predicate.");
  }
  return `(
    ${column} = jsonb_build_object(
      'schema_version', '${CONTENT_FREE_LEDGER_SCHEMA}',
      'kind', '${kind}',
      'content_digest', ${column}->>'content_digest',
      'redacted', true
    )
    AND COALESCE(${column}->>'content_digest', '') ~ '^sha256:[0-9a-f]{64}$'
  )`;
}

const LEGACY_LEDGER_PRIVACY_GATE_SQL = `
  SELECT category
    FROM (
      SELECT 'actor_identifier' AS category, (
        EXISTS (SELECT 1 FROM tcar_ledger.agent_revisions WHERE workspace_id=$1 AND NOT (created_by=ANY($2::text[]) OR created_by ~ '^actor_sha256_[0-9a-f]{64}$'))
        OR EXISTS (SELECT 1 FROM tcar_ledger.agent_events WHERE workspace_id=$1 AND NOT (actor_id=ANY($2::text[]) OR actor_id ~ '^actor_sha256_[0-9a-f]{64}$'))
        OR EXISTS (SELECT 1 FROM tcar_ledger.execution_runs WHERE workspace_id=$1 AND NOT (actor_id=ANY($2::text[]) OR actor_id ~ '^actor_sha256_[0-9a-f]{64}$'))
        OR EXISTS (SELECT 1 FROM tcar_ledger.execution_events WHERE workspace_id=$1 AND NOT (actor_id=ANY($2::text[]) OR actor_id ~ '^actor_sha256_[0-9a-f]{64}$'))
        OR EXISTS (SELECT 1 FROM tcar_ledger.source_revisions WHERE workspace_id=$1 AND NOT (created_by=ANY($2::text[]) OR created_by ~ '^actor_sha256_[0-9a-f]{64}$'))
        OR EXISTS (SELECT 1 FROM tcar_ledger.outcome_contracts WHERE workspace_id=$1 AND NOT (owner_actor_id=ANY($2::text[]) OR owner_actor_id ~ '^actor_sha256_[0-9a-f]{64}$'))
        OR EXISTS (SELECT 1 FROM tcar_ledger.outcome_contract_versions WHERE workspace_id=$1 AND NOT (created_by=ANY($2::text[]) OR created_by ~ '^actor_sha256_[0-9a-f]{64}$'))
        OR EXISTS (SELECT 1 FROM tcar_ledger.outcome_instances WHERE workspace_id=$1 AND NOT (created_by=ANY($2::text[]) OR created_by ~ '^actor_sha256_[0-9a-f]{64}$'))
        OR EXISTS (SELECT 1 FROM tcar_ledger.outcome_observations WHERE workspace_id=$1 AND NOT (oracle_principal_id=ANY($2::text[]) OR oracle_principal_id ~ '^actor_sha256_[0-9a-f]{64}$'))
        OR EXISTS (SELECT 1 FROM tcar_ledger.outcome_settlements WHERE workspace_id=$1 AND NOT (verifier_principal_id=ANY($2::text[]) OR verifier_principal_id ~ '^actor_sha256_[0-9a-f]{64}$'))
        OR EXISTS (SELECT 1 FROM tcar_ledger.outcome_disputes WHERE workspace_id=$1 AND NOT (disputed_by=ANY($2::text[]) OR disputed_by ~ '^actor_sha256_[0-9a-f]{64}$'))
      ) AS present
      UNION ALL
      SELECT 'durable_label', (
        EXISTS (SELECT 1 FROM tcar_ledger.agent_revisions WHERE workspace_id=$1 AND agent_id !~ '^agent_ws2_sha256_[0-9a-f]{64}$')
        OR EXISTS (SELECT 1 FROM tcar_ledger.agent_events WHERE workspace_id=$1 AND agent_id !~ '^agent_ws2_sha256_[0-9a-f]{64}$')
        OR EXISTS (SELECT 1 FROM tcar_ledger.execution_steps WHERE workspace_id=$1 AND agent_id !~ '^agent_ws2_sha256_[0-9a-f]{64}$')
        OR EXISTS (SELECT 1 FROM tcar_ledger.execution_steps WHERE workspace_id=$1 AND adapter_id IS NOT NULL AND adapter_id !~ '^agent_ws2_sha256_[0-9a-f]{64}$')
        OR EXISTS (SELECT 1 FROM tcar_ledger.source_revisions WHERE workspace_id=$1 AND source_id !~ '^source_ws2_sha256_[0-9a-f]{64}$')
        OR EXISTS (SELECT 1 FROM tcar_ledger.execution_steps WHERE workspace_id=$1 AND logical_step_id !~ '^step_ws2_sha256_[0-9a-f]{64}$')
        OR EXISTS (SELECT 1 FROM tcar_ledger.execution_events WHERE workspace_id=$1 AND logical_step_id IS NOT NULL AND logical_step_id !~ '^step_ws2_sha256_[0-9a-f]{64}$')
        OR EXISTS (SELECT 1 FROM tcar_ledger.evidence_records WHERE workspace_id=$1 AND logical_step_id IS NOT NULL AND logical_step_id !~ '^step_ws2_sha256_[0-9a-f]{64}$')
        OR EXISTS (SELECT 1 FROM tcar_ledger.evidence_records WHERE workspace_id=$1 AND chunk_id IS NOT NULL AND chunk_id !~ '^chunk_ws2_sha256_[0-9a-f]{64}$')
        OR EXISTS (SELECT 1 FROM tcar_ledger.execution_artifacts WHERE workspace_id=$1 AND logical_step_id !~ '^step_ws2_sha256_[0-9a-f]{64}$')
        OR EXISTS (SELECT 1 FROM tcar_ledger.execution_artifacts WHERE workspace_id=$1 AND artifact_name !~ '^artifact_ws2_sha256_[0-9a-f]{64}$')
        OR EXISTS (SELECT 1 FROM tcar_ledger.outcome_contracts WHERE workspace_id=$1 AND contract_key !~ '^contract_ws2_sha256_[0-9a-f]{64}$')
        OR EXISTS (SELECT 1 FROM tcar_ledger.outcome_observations WHERE workspace_id=$1 AND metric_key !~ '^metric_ws2_sha256_[0-9a-f]{64}$')
        OR EXISTS (SELECT 1 FROM tcar_ledger.settlement_metric_scores WHERE workspace_id=$1 AND metric_key !~ '^participant_metric_ws2_sha256_[0-9a-f]{64}$')
        OR EXISTS (SELECT 1 FROM tcar_ledger.reality_rank_snapshots WHERE workspace_id=$1 AND contract_family !~ '^contract_family_ws2_sha256_[0-9a-f]{64}$')
        OR EXISTS (SELECT 1 FROM tcar_ledger.reality_rank_snapshots WHERE workspace_id=$1 AND domain_key !~ '^domain_ws2_sha256_[0-9a-f]{64}$')
      ) AS present
      UNION ALL
      SELECT 'dependency_label', EXISTS (
        SELECT 1
          FROM tcar_ledger.execution_steps AS step,
               LATERAL jsonb_array_elements_text(step.depends_on) AS dependency(value)
         WHERE step.workspace_id=$1 AND dependency.value !~ '^step_ws2_sha256_[0-9a-f]{64}$'
      ) AS present
      UNION ALL
      SELECT 'metric_definition', EXISTS (
        SELECT 1
          FROM tcar_ledger.outcome_contract_versions AS version,
               LATERAL jsonb_array_elements(version.metric_definitions) AS metric(value)
         WHERE version.workspace_id=$1
           AND CASE
             WHEN jsonb_typeof(metric.value) <> 'object' THEN true
             ELSE COALESCE(metric.value->>'key', '') !~ '^metric_ws2_sha256_[0-9a-f]{64}$'
               OR EXISTS (
                 SELECT 1 FROM jsonb_object_keys(metric.value) AS property(name)
                  WHERE property.name NOT IN ('key', 'type', 'weight')
               )
           END
      ) AS present
      UNION ALL
      SELECT 'raw_json_content', (
        EXISTS (SELECT 1 FROM tcar_ledger.agent_revisions WHERE workspace_id=$1 AND NOT ${contentReceiptPredicate("revision_snapshot", "agent_revision_snapshot")})
        OR EXISTS (SELECT 1 FROM tcar_ledger.agent_events WHERE workspace_id=$1 AND NOT ${contentReceiptPredicate("payload", "agent_event_payload")})
        OR EXISTS (SELECT 1 FROM tcar_ledger.source_revisions WHERE workspace_id=$1 AND NOT ${contentReceiptPredicate("source_metadata", "source_metadata")})
        OR EXISTS (SELECT 1 FROM tcar_ledger.execution_runs WHERE workspace_id=$1 AND NOT ${contentReceiptPredicate("component_snapshot", "execution_component_snapshot")})
        OR EXISTS (SELECT 1 FROM tcar_ledger.execution_runs WHERE workspace_id=$1 AND NOT ${contentReceiptPredicate("planner_snapshot", "execution_planner_snapshot")})
        OR EXISTS (SELECT 1 FROM tcar_ledger.execution_steps WHERE workspace_id=$1 AND NOT ${contentReceiptPredicate("metadata", "execution_step_metadata")})
        OR EXISTS (SELECT 1 FROM tcar_ledger.execution_events WHERE workspace_id=$1 AND NOT ${contentReceiptPredicate("payload", "execution_event_payload")})
        OR EXISTS (SELECT 1 FROM tcar_ledger.outcome_contracts WHERE workspace_id=$1 AND NOT ${contentReceiptPredicate("metadata", "outcome_contract_metadata")})
        OR EXISTS (SELECT 1 FROM tcar_ledger.outcome_contract_versions WHERE workspace_id=$1 AND NOT ${contentReceiptPredicate("definition", "outcome_contract_definition")})
        OR EXISTS (SELECT 1 FROM tcar_ledger.outcome_observations WHERE workspace_id=$1 AND NOT ${contentReceiptPredicate("observed_value", "outcome_observed_value")})
        OR EXISTS (SELECT 1 FROM tcar_ledger.settlement_metric_scores WHERE workspace_id=$1 AND measured_value IS NOT NULL AND NOT ${contentReceiptPredicate("measured_value", "measured_value")})
        OR EXISTS (SELECT 1 FROM tcar_ledger.settlement_metric_scores WHERE workspace_id=$1 AND target_value IS NOT NULL AND NOT ${contentReceiptPredicate("target_value", "target_value")})
      ) AS present
      UNION ALL
      SELECT 'raw_outcome_header', EXISTS (
        SELECT 1 FROM tcar_ledger.outcome_contracts
         WHERE workspace_id=$1
           AND (display_name <> 'Content-redacted outcome contract' OR description <> '')
      ) AS present
      UNION ALL
      SELECT 'raw_idempotency_key', (
        EXISTS (SELECT 1 FROM tcar_ledger.agent_events WHERE workspace_id=$1 AND idempotency_key IS NOT NULL AND idempotency_key !~ '^key_sha256_[0-9a-f]{64}$')
        OR EXISTS (SELECT 1 FROM tcar_ledger.execution_runs WHERE workspace_id=$1 AND idempotency_key IS NOT NULL AND idempotency_key !~ '^key_sha256_[0-9a-f]{64}$')
        OR EXISTS (SELECT 1 FROM tcar_ledger.execution_events WHERE workspace_id=$1 AND idempotency_key IS NOT NULL AND idempotency_key !~ '^key_sha256_[0-9a-f]{64}$')
        OR EXISTS (SELECT 1 FROM tcar_ledger.execution_artifacts WHERE workspace_id=$1 AND idempotency_key IS NOT NULL AND idempotency_key !~ '^key_sha256_[0-9a-f]{64}$')
        OR EXISTS (SELECT 1 FROM tcar_ledger.outcome_instances WHERE workspace_id=$1 AND idempotency_key IS NOT NULL AND idempotency_key !~ '^key_sha256_[0-9a-f]{64}$')
        OR EXISTS (SELECT 1 FROM tcar_ledger.outcome_observations WHERE workspace_id=$1 AND idempotency_key IS NOT NULL AND idempotency_key !~ '^key_sha256_[0-9a-f]{64}$')
        OR EXISTS (SELECT 1 FROM tcar_ledger.outcome_settlements WHERE workspace_id=$1 AND idempotency_key IS NOT NULL AND idempotency_key !~ '^key_sha256_[0-9a-f]{64}$')
        OR EXISTS (SELECT 1 FROM tcar_ledger.reality_rank_snapshots WHERE workspace_id=$1 AND idempotency_key IS NOT NULL AND idempotency_key !~ '^key_sha256_[0-9a-f]{64}$')
      ) AS present
      UNION ALL
      SELECT 'workspace_header', EXISTS (
        SELECT 1 FROM tcar_ledger.workspaces
         WHERE workspace_id=$1
           AND (
             display_name <> CASE WHEN workspace_id='${GLOBAL_WORKSPACE}' THEN 'virenis global' ELSE 'Private workspace' END
             OR metadata <> '{"source":"virenis-web"}'::jsonb
           )
      ) AS present
      UNION ALL
      SELECT 'inline_artifact_payload', EXISTS (
        SELECT 1 FROM tcar_ledger.execution_artifacts
         WHERE workspace_id=$1 AND inline_payload IS NOT NULL
      ) AS present
    ) AS checks
   WHERE present
   LIMIT 1`;

export async function normalizedLedgerAvailable(client) {
  const result = await client.query(
    `WITH expected_triggers(table_name, trigger_name, function_name, trigger_type) AS (
       VALUES
         ('execution_events','execution_events_chain_guard','validate_execution_event_chain',7),
         ('agent_events','agent_events_chain_guard','validate_agent_event_chain',7),
         ('outcome_observations','outcome_observations_supersession_guard','validate_observation_supersession',7),
         ('outcome_settlements','outcome_settlements_chain_guard','validate_settlement_chain',7),
         ('settlement_observations','settlement_observations_scope_guard','validate_settlement_observation_scope',7),
         ('outcome_disputes','outcome_disputes_scope_guard','validate_outcome_dispute_scope',7),
         ('reality_rank_snapshots','reality_rank_chain_guard','validate_reality_rank_chain',7),
         ('execution_runs','execution_runs_update_guard','guard_execution_run_update',19),
         ('execution_runs','execution_runs_delete_guard','reject_delete',11),
         ('outcome_contracts','outcome_contracts_update_guard','guard_outcome_contract_update',19),
         ('outcome_contracts','outcome_contracts_delete_guard','reject_delete',11),
         ('outcome_instances','outcome_instances_update_guard','guard_outcome_instance_update',19),
         ('outcome_instances','outcome_instances_delete_guard','reject_delete',11),
         ('agent_revisions','agent_revisions_immutable_guard','reject_immutable_change',27),
         ('agent_events','agent_events_immutable_guard','reject_immutable_change',27),
         ('source_revisions','source_revisions_immutable_guard','reject_immutable_change',27),
         ('execution_steps','execution_steps_immutable_guard','reject_immutable_change',27),
         ('execution_events','execution_events_immutable_guard','reject_immutable_change',27),
         ('evidence_records','evidence_records_immutable_guard','reject_immutable_change',27),
         ('execution_artifacts','execution_artifacts_immutable_guard','reject_immutable_change',27),
         ('artifact_evidence','artifact_evidence_immutable_guard','reject_immutable_change',27),
         ('outcome_contract_versions','outcome_contract_versions_immutable_guard','reject_immutable_change',27),
         ('outcome_observations','outcome_observations_immutable_guard','reject_immutable_change',27),
         ('outcome_settlements','outcome_settlements_immutable_guard','reject_immutable_change',27),
         ('outcome_disputes','outcome_disputes_immutable_guard','reject_immutable_change',27),
         ('settlement_metric_scores','settlement_metric_scores_immutable_guard','reject_immutable_change',27),
         ('settlement_observations','settlement_observations_immutable_guard','reject_immutable_change',27),
         ('reality_rank_snapshots','reality_rank_snapshots_immutable_guard','reject_immutable_change',27)
     )
     SELECT
       (SELECT count(*)::int FROM unnest($1::text[]) AS required(name)
         WHERE to_regclass('tcar_ledger.' || required.name) IS NOT NULL) AS tables,
       (SELECT count(*)::int FROM pg_class AS relation
          JOIN pg_namespace AS namespace ON namespace.oid=relation.relnamespace
         WHERE namespace.nspname='tcar_ledger' AND relation.relname=ANY($1::text[])
           AND relation.relrowsecurity AND relation.relforcerowsecurity) AS forced_rls,
       (SELECT count(*)::int FROM pg_policies
         WHERE schemaname='tcar_ledger' AND tablename=ANY($1::text[])
           AND policyname=tablename || '_workspace_isolation'
           AND permissive='PERMISSIVE' AND cmd='ALL'
           AND roles=ARRAY['public']::name[]
           AND regexp_replace(COALESCE(qual,''), '\\s+', '', 'g')='(workspace_id=tcar_ledger.current_workspace_id())'
           AND regexp_replace(COALESCE(with_check,''), '\\s+', '', 'g')='(workspace_id=tcar_ledger.current_workspace_id())') AS policies,
       (SELECT count(*)::int FROM pg_policies
         WHERE schemaname='tcar_ledger' AND tablename=ANY($1::text[])) AS policy_total,
       (SELECT count(*)::int FROM information_schema.columns
         WHERE table_schema='tcar_ledger' AND table_name='reality_rank_snapshots'
           AND column_name='projection_state_digest') AS projection_columns,
       (SELECT count(*)::int FROM expected_triggers AS expected
         JOIN pg_class AS relation ON relation.relname=expected.table_name
         JOIN pg_namespace AS namespace ON namespace.oid=relation.relnamespace AND namespace.nspname='tcar_ledger'
         JOIN pg_trigger AS trigger ON trigger.tgrelid=relation.oid
           AND trigger.tgname=expected.trigger_name AND NOT trigger.tgisinternal
           AND trigger.tgtype=expected.trigger_type
         JOIN pg_proc AS procedure ON procedure.oid=trigger.tgfoid AND procedure.proname=expected.function_name
         JOIN pg_namespace AS procedure_namespace ON procedure_namespace.oid=procedure.pronamespace
           AND procedure_namespace.nspname='tcar_ledger') AS triggers,
       (SELECT count(*)::int FROM pg_trigger AS trigger
         JOIN pg_class AS relation ON relation.oid=trigger.tgrelid
         JOIN pg_namespace AS namespace ON namespace.oid=relation.relnamespace
        WHERE namespace.nspname='tcar_ledger' AND relation.relname=ANY($1::text[])
          AND NOT trigger.tgisinternal) AS trigger_total`,
    [REQUIRED_LEDGER_TABLES]
  );
  const status = result.rows[0] || {};
  return status.tables === REQUIRED_LEDGER_TABLES.length
    && status.forced_rls === REQUIRED_LEDGER_TABLES.length
    && status.policies === REQUIRED_LEDGER_TABLES.length
    && status.policy_total === REQUIRED_LEDGER_TABLES.length
    && status.projection_columns === 1
    && status.triggers === REQUIRED_LEDGER_TRIGGERS.length
    && status.trigger_total === REQUIRED_LEDGER_TRIGGERS.length;
}

export async function syncNormalizedLedger(client, data) {
  const workspaces = collectWorkspaces(data);
  for (const workspaceId of workspaces) {
    await setWorkspace(client, workspaceId);
    await assertNormalizedLedgerWorkspacePrivacy(client, workspaceId);
  }
  for (const workspaceId of workspaces) {
    await setWorkspace(client, workspaceId);
    await client.query(
      `INSERT INTO tcar_ledger.workspaces(workspace_id, display_name, metadata)
       VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (workspace_id) DO NOTHING`,
      [workspaceId, workspaceId === GLOBAL_WORKSPACE ? "virenis global" : "Private workspace", JSON.stringify({ source: "virenis-web" })]
    );
  }

  await syncAgentLedger(client, data);
  await syncSourceLedger(client, data);
  await syncExecutionLedger(client, data);
  await syncOutcomeLedger(client, data);
  await syncRealityRankLedger(client, data);
}

export async function assertNormalizedLedgerWorkspacePrivacy(client, workspaceId) {
  const result = await client.query(
    LEGACY_LEDGER_PRIVACY_GATE_SQL,
    [workspaceId, [...SERVICE_ACTORS]]
  );
  if (!result.rowCount) return;
  const error = new Error(
    `Normalized ledger privacy migration required for ${normalizedLedgerLabel("workspace", workspaceId, workspaceId)} `
    + `(${result.rows[0]?.category || "legacy_content"}). Stop application writes, inventory this workspace `
    + "with a migration-only BYPASSRLS role, and complete the approved legacy-ledger privacy migration before retrying."
  );
  error.code = "NORMALIZED_LEDGER_LEGACY_PRIVACY_MIGRATION_REQUIRED";
  throw error;
}

async function syncAgentLedger(client, data) {
  const eventsByAgent = new Map();
  for (const event of data.agentEvents || []) {
    const workspaceId = workspace(event.workspace_id);
    const key = `${workspaceId}\0${event.agent_id}`;
    const events = eventsByAgent.get(key) || [];
    events.push(event);
    eventsByAgent.set(key, events);
  }

  for (const [key, events] of eventsByAgent) {
    const [workspaceId] = key.split("\0");
    await setWorkspace(client, workspaceId);
    const ordered = [...events];
    if (!verifyEventChain(ordered)) {
      throw new Error(
        `Agent event chain failed integrity verification for ${eventSubject(workspaceId, normalizedLedgerLabel("agent", workspaceId, ordered[0]?.agent_id))}.`
      );
    }
    const ledgerAgentId = normalizedLedgerLabel("agent", workspaceId, ordered[0]?.agent_id);
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`${workspaceId}|${ledgerAgentId}`]);
    for (const event of ordered) {
      const revision = normalizedDigest(event.agent_revision) || digest(event);
      const agent = findWorkspaceAgent(data, event.agent_id, workspaceId) || { id: event.agent_id };
      const snapshot = revisionSnapshot(event.agent_revision_snapshot, agent, revision);
      const revisionId = revisionUuid(workspaceId, event.agent_id, revision);
      await insertAgentRevision(client, {
        workspaceId,
        revisionId,
        revisionNo: await revisionNumber(client, workspaceId, ledgerAgentId, revision),
        revision,
        agent,
        ledgerAgentId,
        snapshot,
        createdBy: event.actor_id || "system",
        createdAt: event.occurred_at
      });
    }
    for (const [index, event] of ordered.entries()) {
      const eventId = stableUuid("agent-event", workspaceId, event.event_id);
      const revision = normalizedDigest(event.agent_revision) || digest(event);
      const payload = { details: event.details || {}, actor_role: event.actor_role || null };
      const ledgerPayload = normalizedLedgerContentReceipt("agent_event_payload", payload);
      const expectedEvent = {
        agent_id: ledgerAgentId,
        sequence_no: index + 1,
        event_type: safeEvent(event.event_type, "agent.event"),
        payload_digest: digest(payload),
        previous_event_digest: digestOrNull(event.previous_event_hash),
        event_digest: digestOrValue(event.event_hash, event)
      };
      if (await immutableRowMatches(client, "agent_events", "agent_event_id", workspaceId, eventId, expectedEvent)) continue;
      await client.query(
        `INSERT INTO tcar_ledger.agent_events(
           workspace_id, agent_event_id, agent_id, agent_revision_id, sequence_no,
           event_type, event_version, actor_id, payload, payload_digest,
           previous_event_digest, event_digest, occurred_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13)
         ON CONFLICT (workspace_id, agent_event_id) DO NOTHING`,
        [
          workspaceId,
          eventId,
          ledgerAgentId,
          revisionUuid(workspaceId, event.agent_id, revision),
          index + 1,
          safeEvent(event.event_type, "agent.event"),
          event.schema_version || "virenis-agent-event-v1",
          normalizedLedgerActorId(workspaceId, event.actor_id),
          JSON.stringify(ledgerPayload),
          digest(payload),
          digestOrNull(event.previous_event_hash),
          digestOrValue(event.event_hash, event),
          iso(event.occurred_at)
        ]
      );
    }
  }
}

async function insertAgentRevision(client, {
  workspaceId,
  revisionId,
  revisionNo,
  revision,
  agent,
  ledgerAgentId = agent.id,
  snapshot,
  createdBy,
  createdAt
}) {
  const revisionSnapshotValue = snapshot || revisionSnapshot(null, agent, revision);
  const ledgerRevisionSnapshot = normalizedLedgerContentReceipt(
    "agent_revision_snapshot",
    revisionSnapshotValue
  );
  await client.query(
    `INSERT INTO tcar_ledger.agent_revisions(
       workspace_id, agent_revision_id, agent_id, revision_no, contract_version,
       revision_digest, manifest_item_digest, adapter_digest, source_set_digest,
       revision_snapshot, created_by, created_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12)
     ON CONFLICT (workspace_id, agent_revision_id) DO NOTHING`,
    [
      workspaceId,
      revisionId,
      ledgerAgentId,
      revisionNo,
      agent.contract_version || "tcar-agent-v1",
      revision,
      digestOrValue(revisionSnapshotValue.manifest_contract_digest, revisionSnapshotValue),
      digestOrNull(revisionSnapshotValue.adapter_content_digest),
      digest((revisionSnapshotValue.sources || []).slice().sort()),
      JSON.stringify(ledgerRevisionSnapshot),
      normalizedLedgerActorId(workspaceId, createdBy),
      iso(createdAt)
    ]
  );
  await assertImmutableRow(client, "agent_revisions", "agent_revision_id", workspaceId, revisionId, {
    agent_id: ledgerAgentId,
    revision_digest: revision,
    manifest_item_digest: digestOrValue(revisionSnapshotValue.manifest_contract_digest, revisionSnapshotValue)
  });
}

async function syncSourceLedger(client, data) {
  for (const document of data.documents || []) {
    const workspaceId = workspace(document.workspace_id);
    const documentLabel = normalizedLedgerLabel("source", workspaceId, document.document_id || document.agent_id || "unknown");
    await setWorkspace(client, workspaceId);
    const snapshot = document.source_revision_snapshot && typeof document.source_revision_snapshot === "object"
      ? document.source_revision_snapshot
      : null;
    const contentDigest = normalizedDigest(snapshot?.content_digest);
    const uploadDigest = normalizedDigest(document.upload_digest);
    if (!contentDigest || !uploadDigest || !contentDigest.equals(uploadDigest)) {
      throw new Error(`Document ${documentLabel} is missing its verified upload-byte digest.`);
    }
    const corpusRevision = normalizedDigest(snapshot?.corpus_revision || document.corpus_revision);
    if (!corpusRevision) {
      throw new Error(`Document ${documentLabel} is missing its verified corpus revision.`);
    }
    const indexDigest = normalizedDigest(snapshot?.index_digest || document.index_digest);
    if (!indexDigest) {
      throw new Error(`Document ${documentLabel} is missing its verified index digest.`);
    }
    const sourceMetadata = canonical(snapshot?.source_metadata || {});
    if (
      !normalizedDigest(sourceMetadata.upload_digest)?.equals(contentDigest)
      || !normalizedDigest(sourceMetadata.extracted_text_digest)
      || !normalizedDigest(sourceMetadata.corpus_revision)?.equals(corpusRevision)
    ) {
      throw new Error(`Document ${documentLabel} has an incomplete immutable source snapshot.`);
    }
    const chunkCount = Number.isSafeInteger(snapshot?.chunk_count)
      ? snapshot.chunk_count
      : (document.chunks || []).length;
    const metadataDigest = digest(sourceMetadata);
    const ledgerSourceMetadata = normalizedLedgerContentReceipt("source_metadata", sourceMetadata);
    const sourceId = document.document_id || document.agent_id;
    const ledgerSourceId = normalizedLedgerLabel("source", workspaceId, sourceId);
    const sourceRevisionId = sourceUuid(workspaceId, sourceId, contentDigest);
    const revisionNo = await sourceRevisionNumber(client, workspaceId, ledgerSourceId, contentDigest);
    const createdBy = document.created_by || "system";
    const createdAt = iso(document.created_at);
    await client.query(
      `INSERT INTO tcar_ledger.source_revisions(
         workspace_id, source_revision_id, source_id, revision_no, source_kind,
         content_digest, index_digest, metadata_digest, chunk_count, source_metadata,
         created_by, created_at
       ) VALUES ($1,$2,$3,$4,'document',$5,$6,$7,$8,$9::jsonb,$10,$11)
       ON CONFLICT (workspace_id, source_id, content_digest) DO NOTHING`,
      [
        workspaceId,
        sourceRevisionId,
        ledgerSourceId,
        revisionNo,
        contentDigest,
        indexDigest,
        metadataDigest,
        chunkCount,
        JSON.stringify(ledgerSourceMetadata),
        normalizedLedgerActorId(workspaceId, createdBy),
        createdAt
      ]
    );
    await assertImmutableRow(client, "source_revisions", "source_revision_id", workspaceId, sourceRevisionId, {
      workspace_id: workspaceId,
      source_revision_id: sourceRevisionId,
      source_id: ledgerSourceId,
      revision_no: revisionNo,
      source_kind: "document",
      content_digest: contentDigest,
      index_digest: indexDigest,
      metadata_digest: metadataDigest,
      chunk_count: chunkCount,
      created_at: createdAt
    });
  }
}

async function syncExecutionLedger(client, data) {
  for (const record of data.executionRecords || []) {
    if (!verifyExecutionRecord(record)) continue;
    const workspaceId = workspace(record.workspace_id);
    await setWorkspace(client, workspaceId);
    const run = (data.runs || []).find((item) => item.run_id === record.run_id) || {};
    const executionId = executionUuid(workspaceId, record.run_id);
    const terminalStatus = ["completed", "failed", "cancelled"].includes(record.status) ? record.status : "failed";
    const componentSnapshot = {
      base_model: record.base_model || null,
      base_model_digest: record.base_model_digest || null,
      router_model_digest: record.router_model_digest || null,
      router_chat_template_digest: record.router_chat_template_digest || null,
      executor_code_digest: record.executor_code_digest || null,
      component_provenance_digest: record.component_provenance_digest || null,
      runtime_execution_id: record.runtime_execution_id || null,
      runtime_record_hash: record.runtime_record_hash || null
    };
    const plannerSnapshot = { mode: record.planner_mode || null, routing: run.plan?.routing || null };
    const executionEventId = stableUuid("execution-event", workspaceId, record.execution_id);
    await client.query(
      `INSERT INTO tcar_ledger.execution_runs(
         workspace_id, execution_id, external_run_id, schema_version, actor_id,
         service_principal_id, visibility, status, request_digest, manifest_digest,
         plan_digest, component_snapshot, planner_snapshot, terminal_event_digest,
         created_at, started_at, completed_at
       ) VALUES ($1,$2,$3,$4,$5,'virenis-web',$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13,$14,$15,$16)
       ON CONFLICT (workspace_id, execution_id) DO NOTHING`,
      [
        workspaceId,
        executionId,
        record.run_id,
        record.schema_version || "virenis-execution-v1",
        normalizedLedgerActorId(workspaceId, record.created_by),
        ledgerVisibility(record.visibility),
        terminalStatus,
        digestOrValue(record.query_digest, run.query || ""),
        digestOrValue(record.manifest_revision, "unavailable"),
        digestOrValue(record.plan_digest, run.plan || {}),
        JSON.stringify(normalizedLedgerContentReceipt("execution_component_snapshot", componentSnapshot)),
        JSON.stringify(normalizedLedgerContentReceipt("execution_planner_snapshot", plannerSnapshot)),
        digestOrValue(record.record_hash, record),
        iso(run.created_at || record.started_at || record.recorded_at),
        iso(record.started_at || run.started_at || record.recorded_at),
        iso(record.completed_at || record.recorded_at)
      ]
    );
    await assertImmutableRow(client, "execution_runs", "execution_id", workspaceId, executionId, {
      external_run_id: record.run_id,
      terminal_event_digest: digestOrValue(record.record_hash, record)
    });

    const runSteps = (data.runSteps || []).filter((step) => step.run_id === record.run_id);
    for (const [index, participant] of (record.participants || []).entries()) {
      const step = runSteps.find((item) => item.step_id === participant.step_id) || {};
      const revision = normalizedDigest(participant.agent_revision) || digest(participant);
      const agent = findWorkspaceAgent(data, participant.agent_id, workspaceId) || { id: participant.agent_id };
      const ledgerAgentId = normalizedLedgerLabel("agent", workspaceId, participant.agent_id);
      const snapshot = revisionSnapshot(participant.agent_revision_snapshot, agent, revision);
      const revisionId = revisionUuid(workspaceId, participant.agent_id, revision);
      await insertAgentRevision(client, {
        workspaceId,
        revisionId,
        revisionNo: await revisionNumber(client, workspaceId, ledgerAgentId, revision),
        revision,
        agent,
        ledgerAgentId,
        snapshot,
        createdBy: record.created_by || "system",
        createdAt: record.recorded_at
      });
      const stepId = executionStepUuid(workspaceId, record.run_id, participant.step_id);
      const ledgerStepId = normalizedLedgerLabel("step", workspaceId, participant.step_id);
      const startedAt = iso(step.started_at || record.started_at || record.recorded_at);
      const completedAt = iso(step.completed_at || record.completed_at || record.recorded_at);
      await client.query(
        `INSERT INTO tcar_ledger.execution_steps(
           workspace_id, execution_step_id, execution_id, logical_step_id, attempt_no,
           agent_id, agent_revision_id, adapter_id, model_id, model_digest,
           prompt_template_digest, toolset_digest, task_digest, input_set_digest,
           output_set_digest, depends_on, status, started_at, completed_at, elapsed_ms, metadata
         ) VALUES ($1,$2,$3,$4,1,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16,$17,$18,$19,$20::jsonb)
         ON CONFLICT (workspace_id, execution_step_id) DO NOTHING`,
        [
          workspaceId,
          stepId,
          executionId,
          ledgerStepId,
          ledgerAgentId,
          revisionId,
          participant.binding_type === "base_model" ? null : ledgerAgentId,
          participant.model_id || record.base_model || "unknown",
          digestOrNull(record.base_model_digest),
          digestOrNull(record.router_chat_template_digest),
          digest(step.allowed_tools || []),
          digestOrValue(participant.task_digest, step.task || ""),
          digest({ depends_on: step.depends_on || [], routing: participant.routing || null }),
          digestOrNull(participant.output_digest),
          JSON.stringify((step.depends_on || []).map((stepIdValue) => normalizedLedgerLabel("step", workspaceId, stepIdValue))),
          stepStatus(participant.status),
          startedAt,
          completedAt,
          elapsedMs(step.elapsed_sec, startedAt, completedAt),
          JSON.stringify(normalizedLedgerContentReceipt("execution_step_metadata", {
            participant_index: index,
            routing: participant.routing || null,
            policy_violations: step.policy_violations || [],
            adapter_digest: participant.adapter_digest || null
          }))
        ]
      );
      await assertImmutableRow(client, "execution_steps", "execution_step_id", workspaceId, stepId, {
        execution_id: executionId,
        agent_revision_id: revisionId,
        output_set_digest: digestOrNull(participant.output_digest)
      });
      await syncEvidence(client, data, record, step, executionId, workspaceId);
      await syncArtifacts(client, record, step, executionId, stepId, revisionId, workspaceId);
    }

    await client.query(
      `SELECT 1 FROM tcar_ledger.execution_runs
        WHERE workspace_id=$1 AND execution_id=$2 FOR UPDATE`,
      [workspaceId, executionId]
    );
    const expectedExecutionEvent = {
      execution_id: executionId,
      sequence_no: 1,
      event_digest: digestOrValue(record.record_hash, record)
    };
    const executionEventPayload = {
      record_hash: record.record_hash,
      result_digest: record.result_digest
    };
    if (!await immutableRowMatches(client, "execution_events", "execution_event_id", workspaceId, executionEventId, expectedExecutionEvent)) await client.query(
      `INSERT INTO tcar_ledger.execution_events(
         workspace_id, execution_event_id, execution_id, sequence_no, event_type,
         actor_id, service_principal_id, payload, payload_digest, event_digest, occurred_at
       ) VALUES ($1,$2,$3,1,$4,$5,'virenis-web',$6::jsonb,$7,$8,$9)
       ON CONFLICT (workspace_id, execution_event_id) DO NOTHING`,
      [
        workspaceId,
        executionEventId,
        executionId,
        `execution.${terminalStatus}`,
        normalizedLedgerActorId(workspaceId, record.created_by),
        JSON.stringify(normalizedLedgerContentReceipt("execution_event_payload", executionEventPayload)),
        digest(executionEventPayload),
        digestOrValue(record.record_hash, record),
        iso(record.completed_at || record.recorded_at)
      ]
    );
    await assertImmutableRow(client, "execution_events", "execution_event_id", workspaceId, executionEventId, expectedExecutionEvent);
  }
}

async function syncEvidence(client, data, record, step, executionId, workspaceId) {
  for (const citation of step.citations || []) {
    if (!citation?.chunk_id) continue;
    const document = (data.documents || []).find((item) =>
      item.agent_id === step.adapter && workspace(item.workspace_id) === workspaceId
    );
    let sourceRevisionId = null;
    if (document) {
      const contentDigest = sourceContentDigest(document);
      sourceRevisionId = sourceUuid(workspaceId, document.document_id || document.agent_id, contentDigest);
    }
    const evidenceMaterial = {
      agent_id: step.adapter,
      chunk_id: citation.chunk_id,
      page_start: citation.page_start ?? null,
      page_end: citation.page_end ?? null,
      content_digest: citation.content_digest || null,
      corpus_revision: citation.corpus_revision || null,
      index_digest: citation.index_digest || null,
      excerpt: citation.excerpt || ""
    };
    const evidenceId = evidenceUuid(workspaceId, record.run_id, step.step_id, evidenceMaterial);
    await client.query(
      `INSERT INTO tcar_ledger.evidence_records(
         workspace_id, evidence_id, execution_id, logical_step_id, attempt_no,
         source_revision_id, evidence_kind, chunk_id, page_start, page_end,
         claim_digest, excerpt_digest, locator_digest, verification_status,
         verification_method, verifier_version, evidence_digest, created_at
       ) VALUES ($1,$2,$3,$4,1,$5,'source_chunk',$6,$7,$8,$9,$10,$11,$12,'executor_claim_validation','v1',$13,$14)
       ON CONFLICT (workspace_id, evidence_id) DO NOTHING`,
      [
        workspaceId,
        evidenceId,
        executionId,
        normalizedLedgerLabel("step", workspaceId, step.step_id),
        sourceRevisionId,
        normalizedLedgerLabel("chunk", workspaceId, citation.chunk_id),
        positiveIntOrNull(citation.page_start),
        positiveIntOrNull(citation.page_end),
        citation.claim ? digest(citation.claim) : null,
        citation.excerpt ? digest(citation.excerpt) : null,
        digest({
          path: citation.path || null,
          chunk_id: citation.chunk_id,
          page_start: citation.page_start,
          page_end: citation.page_end,
          content_digest: citation.content_digest || null,
          corpus_revision: citation.corpus_revision || null,
          index_digest: citation.index_digest || null
        }),
        citation.verified === true ? "verified" : "unverified",
        digest(evidenceMaterial),
        iso(step.completed_at || record.completed_at || record.recorded_at)
      ]
    );
    await assertImmutableRow(client, "evidence_records", "evidence_id", workspaceId, evidenceId, {
      execution_id: executionId,
      evidence_digest: digest(evidenceMaterial)
    });
  }
}

async function syncArtifacts(client, record, step, executionId, stepId, revisionId, workspaceId) {
  for (const artifact of step.handoff_artifacts || []) {
    if (!artifact?.name) continue;
    const artifactId = stableUuid("artifact", workspaceId, record.run_id, step.step_id, artifact.name);
    const inlinePayload = artifact.value === undefined ? null : artifact.value;
    const ledgerArtifactName = normalizedLedgerLabel("artifact", workspaceId, artifact.name);
    await client.query(
      `INSERT INTO tcar_ledger.execution_artifacts(
         workspace_id, artifact_id, execution_id, execution_step_id, logical_step_id,
         agent_revision_id, artifact_name, artifact_type, artifact_schema_version,
         content_digest, envelope_digest, inline_payload, confidence,
         verification_status, produced_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15)
       ON CONFLICT (workspace_id, artifact_id) DO NOTHING`,
      [
        workspaceId,
        artifactId,
        executionId,
        stepId,
        normalizedLedgerLabel("step", workspaceId, step.step_id),
        revisionId,
        ledgerArtifactName.slice(0, 240),
        typeof inlinePayload === "object" ? "json" : "text",
        CONTENT_FREE_LEDGER_SCHEMA,
        digestOrValue(artifact.content_digest, inlinePayload),
        digest(artifact),
        null,
        probabilityOrNull(artifact.confidence),
        artifact.verified === false ? "rejected" : artifact.verified === true ? "verified" : "unverified",
        iso(step.completed_at || record.completed_at || record.recorded_at)
      ]
    );
    await assertImmutableRow(client, "execution_artifacts", "artifact_id", workspaceId, artifactId, {
      execution_id: executionId,
      content_digest: digestOrValue(artifact.content_digest, inlinePayload),
      envelope_digest: digest(artifact)
    });
  }
}

async function syncOutcomeLedger(client, data) {
  for (const contract of data.outcomeContracts || []) {
    const workspaceId = workspace(contract.workspace_id);
    const execution = (data.executionRecords || []).find((record) =>
      record.execution_id === contract.execution_id && workspace(record.workspace_id) === workspaceId
    );
    if (!verifyOutcomeContract(contract, execution).valid) continue;
    await setWorkspace(client, workspaceId);
    const executionId = executionUuid(workspaceId, contract.run_id);
    const contractId = stableUuid("outcome-contract", workspaceId, contract.contract_id);
    const versionId = stableUuid("outcome-contract-version", workspaceId, contract.contract_id, "1");
    const instanceId = stableUuid("outcome-instance", workspaceId, contract.contract_id);
    const contractMetadata = {
      domain: contract.domain,
      task_type: contract.task_type,
      visibility: contract.visibility
    };
    await client.query(
      `INSERT INTO tcar_ledger.outcome_contracts(
         workspace_id, outcome_contract_id, contract_key, display_name, description,
         owner_actor_id, status, current_version_no, metadata, created_at
       ) VALUES ($1,$2,$3,$4,$5,$6,'active',1,$7::jsonb,$8)
       ON CONFLICT (workspace_id, outcome_contract_id) DO NOTHING`,
      [
        workspaceId,
        contractId,
        normalizedLedgerLabel("contract", workspaceId, contract.contract_id),
        "Content-redacted outcome contract",
        "",
        normalizedLedgerActorId(workspaceId, contract.created_by),
        JSON.stringify(normalizedLedgerContentReceipt("outcome_contract_metadata", contractMetadata)),
        iso(contract.created_at)
      ]
    );
    await assertImmutableRow(client, "outcome_contracts", "outcome_contract_id", workspaceId, contractId, {
      outcome_contract_id: contractId
    });
    const dueAt = iso(contract.resolution?.due_at || contract.created_at);
    const observationSeconds = Math.max(0, (Date.parse(dueAt) - Date.parse(iso(contract.created_at))) / 1000);
    const definition = outcomeContractDefinitionMaterial(contract);
    const definitionDigest = digest(definition);
    await client.query(
      `INSERT INTO tcar_ledger.outcome_contract_versions(
         workspace_id, outcome_contract_version_id, outcome_contract_id, version_no,
         contract_schema_version, definition, metric_definitions, definition_digest,
         observation_window, settlement_delay, dispute_window, minimum_evidence_count,
         rank_eligible, created_by, created_at
       ) VALUES ($1,$2,$3,1,$4,$5::jsonb,$6::jsonb,$7,$8::interval,'0 seconds','0 seconds',$9,true,$10,$11)
       ON CONFLICT (workspace_id, outcome_contract_version_id) DO NOTHING`,
      [
        workspaceId,
        versionId,
        contractId,
        contract.schema_version || "virenis-outcome-contract-v2",
        JSON.stringify(normalizedLedgerContentReceipt("outcome_contract_definition", definition)),
        JSON.stringify([{
          key: normalizedLedgerLabel("metric", workspaceId, contract.resolution?.metric || "outcome"),
          type: contract.outcome_type,
          weight: 1
        }]),
        definitionDigest,
        `${observationSeconds} seconds`,
        (contract.evidence_ids || []).length,
        normalizedLedgerActorId(workspaceId, contract.created_by),
        iso(contract.created_at)
      ]
    );
    await assertImmutableRow(client, "outcome_contract_versions", "outcome_contract_version_id", workspaceId, versionId, {
      outcome_contract_id: contractId,
      definition_digest: definitionDigest
    });
    const desiredStatus = desiredOutcomeStatus(contract, dueAt);
    const bindingDigest = digest({ execution_id: contract.execution_id, execution_record_hash: contract.execution_record_hash });
    await client.query(
      `INSERT INTO tcar_ledger.outcome_instances(
         workspace_id, outcome_instance_id, execution_id, outcome_contract_version_id,
         idempotency_key, binding_digest, status, observation_opens_at,
         observation_closes_at, settleable_at, created_by, created_at
       ) VALUES ($1,$2,$3,$4,$5,$6,'pending',$7,$8,$8,$9,$7)
       ON CONFLICT (workspace_id, outcome_instance_id) DO NOTHING`,
      [
        workspaceId,
        instanceId,
        executionId,
        versionId,
        normalizedLedgerIdempotencyKey(workspaceId, contract.idempotency_key),
        bindingDigest,
        iso(contract.created_at),
        dueAt,
        normalizedLedgerActorId(workspaceId, contract.created_by)
      ]
    );
    await assertImmutableRow(client, "outcome_instances", "outcome_instance_id", workspaceId, instanceId, {
      execution_id: executionId,
      outcome_contract_version_id: versionId,
      binding_digest: bindingDigest
    });
    await client.query(
      `SELECT 1 FROM tcar_ledger.outcome_instances
        WHERE workspace_id=$1 AND outcome_instance_id=$2 FOR UPDATE`,
      [workspaceId, instanceId]
    );

    for (const [index, settlement] of (contract.settlements || []).entries()) {
      const settlementId = stableUuid("settlement", workspaceId, settlement.settlement_id);
      const observationId = stableUuid("observation", workspaceId, settlement.settlement_id);
      const prior = index > 0 ? contract.settlements[index - 1] : null;
      const verified = settlement.verified_for_rank === true;
      const metricKey = normalizedLedgerLabel("metric", workspaceId, contract.resolution?.metric || "outcome");
      const observedValueDigest = digest(settlement.actual_value);
      await client.query(
        `INSERT INTO tcar_ledger.outcome_observations(
           workspace_id, observation_id, outcome_instance_id, metric_key,
           oracle_principal_id, oracle_type, trust_tier, idempotency_key,
           observed_value, observed_value_digest, evidence_digest,
           observation_status, supersedes_observation_id, observed_at, as_of_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,$14)
         ON CONFLICT (workspace_id, observation_id) DO NOTHING`,
        [
          workspaceId,
          observationId,
          instanceId,
          metricKey,
          normalizedLedgerActorId(
            workspaceId,
            settlement.resolver_principal?.principal_id || settlement.settled_by || "tracking-user"
          ),
          oracleType(settlement.source?.type),
          verified ? "A" : "D",
          normalizedLedgerIdempotencyKey(workspaceId, settlement.idempotency_key),
          JSON.stringify(normalizedLedgerContentReceipt("outcome_observed_value", settlement.actual_value)),
          observedValueDigest,
          digestOrNull(settlement.source?.evidence_digest),
          verified ? "verified" : "submitted",
          prior ? stableUuid("observation", workspaceId, prior.settlement_id) : null,
          iso(settlement.settled_at)
        ]
      );
      await assertImmutableRow(client, "outcome_observations", "observation_id", workspaceId, observationId, {
        outcome_instance_id: instanceId,
        observed_value_digest: observedValueDigest,
        supersedes_observation_id: prior ? stableUuid("observation", workspaceId, prior.settlement_id) : null
      });
      const aggregateUtility = average((settlement.participant_scores || []).map((score) => score.utility));
      const settlementDigest = objectHashDigest(settlement, "settlement_hash");
      const expectedSettlement = {
        outcome_instance_id: instanceId,
        settlement_version: index + 1,
        settlement_digest: settlementDigest,
        contract_definition_digest: definitionDigest
      };
      if (!await immutableRowMatches(client, "outcome_settlements", "settlement_id", workspaceId, settlementId, expectedSettlement)) await client.query(
        `INSERT INTO tcar_ledger.outcome_settlements(
           workspace_id, settlement_id, outcome_instance_id, settlement_version,
           settlement_kind, decision, idempotency_key, supersedes_settlement_id,
           previous_settlement_digest, settlement_digest, contract_definition_digest,
           aggregate_utility, rank_eligible, verifier_principal_id, verifier_version,
           rationale_digest, settled_at
         ) VALUES ($1,$2,$3,$4,$5,'settled',$6,$7,$8,$9,$10,$11,$12,$13,'virenis-v1',$14,$15)
         ON CONFLICT (workspace_id, settlement_id) DO NOTHING`,
        [
          workspaceId,
          settlementId,
          instanceId,
          index + 1,
          index === 0 ? "initial" : "correction",
          normalizedLedgerIdempotencyKey(workspaceId, settlement.idempotency_key),
          prior ? stableUuid("settlement", workspaceId, prior.settlement_id) : null,
          prior ? objectHashDigest(prior, "settlement_hash") : null,
          settlementDigest,
          definitionDigest,
          aggregateUtility,
          verified,
          normalizedLedgerActorId(
            workspaceId,
            settlement.resolver_principal?.principal_id || settlement.settled_by || "tracking-user"
          ),
          settlement.notes ? digest(settlement.notes) : null,
          iso(settlement.settled_at)
        ]
      );
      await assertImmutableRow(client, "outcome_settlements", "settlement_id", workspaceId, settlementId, expectedSettlement);
      for (const [scoreIndex, score] of (settlement.participant_scores || []).entries()) {
        const scoreKey = normalizedLedgerLabel("participant_metric", workspaceId, `${scoreIndex + 1}:${score.agent_id}`);
        await client.query(
          `INSERT INTO tcar_ledger.settlement_metric_scores(
             workspace_id, settlement_id, metric_key, normalized_score, metric_weight,
             measured_value, target_value, confidence, evidence_strength, score_digest
           ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10)
           ON CONFLICT (workspace_id, settlement_id, metric_key) DO NOTHING`,
          [
            workspaceId,
            settlementId,
            scoreKey,
            probability(score.utility),
            Math.max(0, Number(score.rank_weight || 0)),
            JSON.stringify(normalizedLedgerContentReceipt("measured_value", settlement.actual_value)),
            JSON.stringify(normalizedLedgerContentReceipt(
              "target_value",
              contract.participants?.find((participant) => participant.step_id === score.step_id)?.prediction ?? null
            )),
            probabilityOrNull(contract.participants?.find((participant) => participant.step_id === score.step_id)?.confidence),
            verified ? 1 : 0,
            digest(score)
          ]
        );
      }
      await client.query(
        `INSERT INTO tcar_ledger.settlement_observations(workspace_id, settlement_id, observation_id)
         VALUES ($1,$2,$3)
         ON CONFLICT DO NOTHING`,
        [workspaceId, settlementId, observationId]
      );
    }
    for (const dispute of contract.disputes || []) {
      const disputeId = stableUuid("outcome-dispute", workspaceId, dispute.dispute_id);
      const settlementId = stableUuid("settlement", workspaceId, dispute.settlement_id);
      const disputeDigest = objectHashDigest(dispute, "dispute_hash");
      await client.query(
        `INSERT INTO tcar_ledger.outcome_disputes(
           workspace_id, dispute_id, outcome_instance_id, settlement_id,
           dispute_digest, reason_digest, evidence_digest, disputed_by, disputed_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (workspace_id, dispute_id) DO NOTHING`,
        [
          workspaceId,
          disputeId,
          instanceId,
          settlementId,
          disputeDigest,
          digest(dispute.reason || ""),
          digestOrNull(dispute.evidence_digest),
          normalizedLedgerActorId(workspaceId, dispute.disputed_by),
          iso(dispute.disputed_at)
        ]
      );
      await assertImmutableRow(client, "outcome_disputes", "dispute_id", workspaceId, disputeId, {
        outcome_instance_id: instanceId,
        settlement_id: settlementId,
        dispute_digest: disputeDigest
      });
    }
    await transitionOutcomeInstance(client, workspaceId, instanceId, desiredStatus);
  }
}

async function transitionOutcomeInstance(client, workspaceId, instanceId, desiredStatus) {
  const result = await client.query(
    `SELECT status FROM tcar_ledger.outcome_instances
      WHERE workspace_id=$1 AND outcome_instance_id=$2`,
    [workspaceId, instanceId]
  );
  let current = result.rows[0]?.status;
  const paths = {
    pending: [],
    observing: ["observing"],
    eligible: ["observing", "eligible"],
    settled: ["observing", "eligible", "settled"],
    disputed: ["observing", "eligible", "settled", "disputed"]
  };
  const transitions = current === "disputed" && desiredStatus === "settled"
    ? ["settled"]
    : paths[desiredStatus] || [];
  for (const next of transitions) {
    if (current === next) continue;
    if (statusOrder(current) > statusOrder(next) && !(current === "disputed" && next === "settled")) continue;
    await client.query(
      `UPDATE tcar_ledger.outcome_instances SET status=$3 WHERE workspace_id=$1 AND outcome_instance_id=$2`,
      [workspaceId, instanceId, next]
    );
    current = next;
  }
}

async function syncRealityRankLedger(client, data) {
  const groups = new Map();
  for (const contract of data.outcomeContracts || []) {
    if (!(contract.settlements || []).length) continue;
    const workspaceId = workspace(contract.workspace_id);
    const execution = (data.executionRecords || []).find((record) =>
      record.execution_id === contract.execution_id && workspace(record.workspace_id) === workspaceId
    );
    const integrityValid = verifyOutcomeContract(contract, execution).valid;
    const identities = new Map();
    const authoritativeParticipants = integrityValid
      ? contract.participants || []
      : verifyExecutionRecord(execution || {}) ? execution.participants || [] : contract.participants || [];
    for (const participant of authoritativeParticipants) {
      if (!participant.agent_id || !participant.agent_revision) continue;
      identities.set(`${participant.agent_id}\0${participant.agent_revision}`, participant);
    }
    for (const settlement of integrityValid ? contract.settlements || [] : []) {
      for (const score of settlement.participant_scores || []) {
        if (!score.agent_id || !score.agent_revision) continue;
        identities.set(`${score.agent_id}\0${score.agent_revision}`, score);
      }
    }
    const state = rankContractState(contract, integrityValid);
    for (const identity of identities.values()) {
      const key = rankGroupKey(workspaceId, identity.agent_id, identity.agent_revision, contract.domain, contract.task_type);
      const group = groups.get(key) || {
        workspaceId,
        agentId: identity.agent_id,
        revision: identity.agent_revision,
        domain: contract.domain || "general",
        taskType: contract.task_type || "decision",
        entries: [],
        states: new Map()
      };
      group.states.set(contract.contract_id, state);
      groups.set(key, group);
    }
    if (!integrityValid) continue;
    if (contract.status !== "settled" || contract.settlement?.verified_for_rank !== true) continue;
    for (const score of contract.settlement.participant_scores || []) {
      if (!(Number(score.rank_weight) > 0)) continue;
      const key = rankGroupKey(workspaceId, score.agent_id, score.agent_revision, contract.domain, contract.task_type);
      const group = groups.get(key);
      if (group) group.entries.push({ contract, score });
    }
  }
  for (const group of groups.values()) {
    const { workspaceId, agentId, revision, domain, taskType, entries } = group;
    await setWorkspace(client, workspaceId);
    const ordered = entries.sort((left, right) =>
      String(left.contract.settled_at || "").localeCompare(String(right.contract.settled_at || ""))
      || String(left.contract.contract_id || "").localeCompare(String(right.contract.contract_id || ""))
    );
    const states = [...group.states.values()].sort((left, right) => left.contract_id.localeCompare(right.contract_id));
    const cutoff = iso(latestRankStateTime(states));
    const summary = rankSummary(ordered, Date.parse(cutoff));
    const inputSet = {
      contract_states: states,
      eligible_scores: ordered.map(({ contract, score }) => ({
        contract_id: contract.contract_id,
        settlement_hash: contract.settlement.settlement_hash,
        utility: score.utility,
        rank_weight: score.rank_weight
      }))
    };
    const projectionStateDigest = digest(inputSet);
    const agentRevisionId = revisionUuid(workspaceId, agentId, normalizedDigest(revision) || digest(revision));
    const subjectId = String(agentRevisionId);
    const contractFamily = normalizedLedgerLabel("contract_family", workspaceId, taskType || "decision");
    const domainKey = normalizedLedgerLabel("domain", workspaceId, domain || "general");
    const lockKey = [workspaceId, "agent_revision", subjectId, contractFamily, domainKey, "default", "bayesian-decayed-utility", "v1"].join("|");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [lockKey]);
    const previous = await client.query(
      `SELECT reality_rank_snapshot_id, snapshot_version, snapshot_digest,
              input_set_digest, projection_state_digest
         FROM tcar_ledger.reality_rank_snapshots
        WHERE workspace_id=$1 AND subject_type='agent_revision' AND subject_id=$2
          AND contract_family=$3 AND domain_key=$4 AND cohort_key='default'
          AND algorithm_id='bayesian-decayed-utility' AND algorithm_version='v1'
        ORDER BY snapshot_version DESC LIMIT 1`,
      [workspaceId, subjectId, contractFamily, domainKey]
    );
    const prior = previous.rows[0] || null;
    const priorProjection = prior?.projection_state_digest || prior?.input_set_digest || null;
    if (Buffer.isBuffer(priorProjection) && priorProjection.equals(projectionStateDigest)) continue;
    const inputDigest = digest({
      projection_state_digest: projectionStateDigest.toString("hex"),
      previous_snapshot_digest: prior?.snapshot_digest?.toString("hex") || null
    });
    const existing = await client.query(
      `SELECT 1 FROM tcar_ledger.reality_rank_snapshots
        WHERE workspace_id=$1 AND subject_type='agent_revision' AND subject_id=$2
          AND contract_family=$3 AND domain_key=$4 AND cohort_key='default'
          AND algorithm_id='bayesian-decayed-utility' AND algorithm_version='v1'
          AND input_set_digest=$5`,
      [workspaceId, subjectId, contractFamily, domainKey, inputDigest]
    );
    if (existing.rowCount) continue;
    const snapshotVersion = Number(prior?.snapshot_version || 0) + 1;
    const snapshotMaterial = {
      agent_id: agentId,
      agent_revision: revision,
      domain,
      task_type: taskType,
      snapshot_version: snapshotVersion,
      ...summary,
      input_digest: inputDigest.toString("hex"),
      projection_state_digest: projectionStateDigest.toString("hex"),
      contract_states: states
    };
    await client.query(
      `INSERT INTO tcar_ledger.reality_rank_snapshots(
         workspace_id, reality_rank_snapshot_id, subject_type, subject_id,
         subject_agent_revision_id, contract_family, domain_key, cohort_key,
         algorithm_id, algorithm_version, snapshot_version, score, lower_bound,
         upper_bound, calibration_score, sample_size, effective_sample_size,
         trust_tier_counts, settlement_cutoff_at, input_set_digest,
         projection_state_digest, previous_snapshot_id, previous_snapshot_digest,
         snapshot_digest, computed_at
       ) VALUES ($1,$2,'agent_revision',$3,$4,$5,$6,'default','bayesian-decayed-utility','v1',$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16,$17,$18,$19,$20,$15)
       ON CONFLICT DO NOTHING`,
      [
        workspaceId,
        stableUuid("rank-snapshot", workspaceId, subjectId, domainKey, contractFamily, inputDigest.toString("hex")),
        subjectId,
        agentRevisionId,
        contractFamily,
        domainKey,
        snapshotVersion,
        summary.score,
        summary.lower_bound,
        summary.upper_bound,
        summary.calibration_score,
        summary.sample_size,
        summary.effective_sample_size,
        JSON.stringify({ A: summary.sample_size }),
        cutoff,
        inputDigest,
        projectionStateDigest,
        prior?.reality_rank_snapshot_id || null,
        prior?.snapshot_digest || null,
        digest(snapshotMaterial)
      ]
    );
    await assertImmutableRow(
      client,
      "reality_rank_snapshots",
      "reality_rank_snapshot_id",
      workspaceId,
      stableUuid("rank-snapshot", workspaceId, subjectId, domainKey, contractFamily, inputDigest.toString("hex")),
      {
        subject_id: subjectId,
        input_set_digest: inputDigest,
        projection_state_digest: projectionStateDigest,
        snapshot_digest: digest(snapshotMaterial)
      }
    );
  }
}

function rankSummary(entries, now) {
  let alpha = RANK_PRIOR_MEAN * RANK_PRIOR_WEIGHT;
  let beta = (1 - RANK_PRIOR_MEAN) * RANK_PRIOR_WEIGHT;
  let weightTotal = 0;
  let calibrationTotal = 0;
  let calibrationWeight = 0;
  for (const { contract, score } of entries) {
    const settledAt = Date.parse(contract.settled_at || contract.created_at);
    const ageDays = Number.isFinite(settledAt) ? Math.max(0, (now - settledAt) / 86_400_000) : 0;
    const weight = Number(score.rank_weight || 0) * (2 ** (-ageDays / RANK_HALF_LIFE_DAYS));
    alpha += Number(score.utility) * weight;
    beta += (1 - Number(score.utility)) * weight;
    weightTotal += weight;
    if (score.calibration_error !== null && score.calibration_error !== undefined) {
      calibrationTotal += Number(score.calibration_error) * weight;
      calibrationWeight += weight;
    }
  }
  const mean = alpha / (alpha + beta);
  const variance = (alpha * beta) / (((alpha + beta) ** 2) * (alpha + beta + 1));
  const margin = 1.96 * Math.sqrt(variance);
  return {
    score: Number((mean * 100).toFixed(4)),
    lower_bound: Number((Math.max(0, mean - margin) * 100).toFixed(4)),
    upper_bound: Number((Math.min(1, mean + margin) * 100).toFixed(4)),
    calibration_score: calibrationWeight ? Number((1 - (calibrationTotal / calibrationWeight)).toFixed(7)) : null,
    sample_size: entries.length,
    effective_sample_size: Number(weightTotal.toFixed(6))
  };
}

async function revisionNumber(client, workspaceId, agentId, revision) {
  const existing = await client.query(
    `SELECT revision_no FROM tcar_ledger.agent_revisions
      WHERE workspace_id=$1 AND agent_id=$2 AND revision_digest=$3`,
    [workspaceId, agentId, revision]
  );
  if (existing.rowCount) return Number(existing.rows[0].revision_no);
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`${workspaceId}|${agentId}`]);
  const afterLock = await client.query(
    `SELECT revision_no FROM tcar_ledger.agent_revisions
      WHERE workspace_id=$1 AND agent_id=$2 AND revision_digest=$3`,
    [workspaceId, agentId, revision]
  );
  if (afterLock.rowCount) return Number(afterLock.rows[0].revision_no);
  const next = await client.query(
    `SELECT COALESCE(MAX(revision_no),0)+1 AS revision_no
       FROM tcar_ledger.agent_revisions WHERE workspace_id=$1 AND agent_id=$2`,
    [workspaceId, agentId]
  );
  return Number(next.rows[0].revision_no);
}

async function sourceRevisionNumber(client, workspaceId, sourceId, contentDigest) {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`source|${workspaceId}|${sourceId}`]);
  const result = await client.query(
    `SELECT revision_no FROM tcar_ledger.source_revisions
      WHERE workspace_id=$1 AND source_id=$2 AND content_digest=$3`,
    [workspaceId, sourceId, contentDigest]
  );
  if (result.rowCount) return Number(result.rows[0].revision_no);
  const next = await client.query(
    `SELECT COALESCE(MAX(revision_no),0)+1 AS revision_no
       FROM tcar_ledger.source_revisions WHERE workspace_id=$1 AND source_id=$2`,
    [workspaceId, sourceId]
  );
  return Number(next.rows[0].revision_no);
}

const IMMUTABLE_IDENTITIES = {
  agent_revisions: "agent_revision_id",
  agent_events: "agent_event_id",
  source_revisions: "source_revision_id",
  execution_runs: "execution_id",
  execution_steps: "execution_step_id",
  execution_events: "execution_event_id",
  evidence_records: "evidence_id",
  execution_artifacts: "artifact_id",
  outcome_contracts: "outcome_contract_id",
  outcome_contract_versions: "outcome_contract_version_id",
  outcome_instances: "outcome_instance_id",
  outcome_observations: "observation_id",
  outcome_settlements: "settlement_id",
  outcome_disputes: "dispute_id",
  reality_rank_snapshots: "reality_rank_snapshot_id"
};

async function immutableRowMatches(client, table, idColumn, workspaceId, id, expected) {
  assertImmutableLookup(table, idColumn, expected);
  const columns = Object.keys(expected);
  const result = await client.query(
    `SELECT ${columns.join(",")} FROM tcar_ledger.${table}
      WHERE workspace_id=$1 AND ${idColumn}=$2`,
    [workspaceId, id]
  );
  if (!result.rowCount) return false;
  assertExpectedValues(table, id, result.rows[0], expected);
  return true;
}

async function assertImmutableRow(client, table, idColumn, workspaceId, id, expected) {
  if (!await immutableRowMatches(client, table, idColumn, workspaceId, id, expected)) {
    throw new Error(`Normalized ledger insert did not persist ${table} identity ${id}.`);
  }
}

function assertImmutableLookup(table, idColumn, expected) {
  if (IMMUTABLE_IDENTITIES[table] !== idColumn) throw new Error("Unsupported immutable ledger lookup.");
  if (!Object.keys(expected).length || Object.keys(expected).some((column) => !/^[a-z_][a-z0-9_]*$/.test(column))) {
    throw new Error("Unsupported immutable ledger comparison.");
  }
}

function assertExpectedValues(table, id, actual, expected) {
  for (const [column, value] of Object.entries(expected)) {
    if (!ledgerValueEqual(actual[column], value)) {
      throw new Error(`Normalized ledger replay conflict for ${table} identity ${id} (${column}).`);
    }
  }
}

function ledgerValueEqual(actual, expected) {
  if (Buffer.isBuffer(actual) || Buffer.isBuffer(expected)) {
    const left = Buffer.isBuffer(actual) ? actual : normalizedDigest(actual);
    const right = Buffer.isBuffer(expected) ? expected : normalizedDigest(expected);
    return Boolean(left && right && left.equals(right));
  }
  if (actual instanceof Date || expected instanceof Date) return iso(actual) === iso(expected);
  if (actual && typeof actual === "object" || expected && typeof expected === "object") {
    return JSON.stringify(canonical(actual)) === JSON.stringify(canonical(expected));
  }
  return String(actual ?? "") === String(expected ?? "");
}

function collectWorkspaces(data) {
  const values = new Set();
  for (const user of data.users || []) {
    const workspaceId = String(user?.workspace_id || "").trim();
    if (workspaceId && user?.status !== "deleted") values.add(workspace(workspaceId));
  }
  for (const collection of ["executionRecords", "outcomeContracts", "agentEvents", "documents"]) {
    for (const item of data[collection] || []) values.add(workspace(item.workspace_id));
  }
  return [...values].sort();
}

async function setWorkspace(client, workspaceId) {
  await client.query("SELECT set_config('tcar.workspace_id', $1, true)", [workspaceId]);
}

function workspace(value) {
  const normalized = String(value || "").trim();
  return normalized || GLOBAL_WORKSPACE;
}

export function findWorkspaceAgent(data, agentId, workspaceId) {
  return (data.agents || []).find((agent) =>
    agent.id === agentId
    && (
      (agent.workspace_id && workspace(agent.workspace_id) === workspaceId)
      || (!agent.workspace_id && agent.system_managed === true && agent.visibility === "global")
    )
  );
}

function revisionSnapshot(candidate, agent, revision) {
  if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) return canonical(candidate);
  const current = normalizedDigest(agentRevision(agent));
  if (current?.equals(revision)) return agentRevisionSnapshot(agent);
  return {
    id: agent?.id || "unknown",
    provenance_status: "legacy_snapshot_unavailable",
    revision_digest: `sha256:${revision.toString("hex")}`
  };
}

function sourceContentDigest(document) {
  const contentDigest = normalizedDigest(document.source_revision_snapshot?.content_digest);
  const uploadDigest = normalizedDigest(document.upload_digest);
  if (!contentDigest || !uploadDigest || !contentDigest.equals(uploadDigest)) {
    throw new Error(
      `Document ${normalizedLedgerLabel("source", workspace(document.workspace_id), document.document_id || document.agent_id || "unknown")} has no verified upload-byte digest.`
    );
  }
  return contentDigest;
}

function objectHashDigest(value, field) {
  const unsigned = { ...(value || {}) };
  const supplied = normalizedDigest(unsigned[field]);
  delete unsigned[field];
  const computed = digest(unsigned);
  if (supplied && !supplied.equals(computed)) throw new Error(`Invalid ${field} reached normalized ledger sync.`);
  return computed;
}

function desiredOutcomeStatus(contract, dueAt) {
  if (contract.status === "disputed") return "disputed";
  if (contract.status === "settled") return "settled";
  return Date.parse(dueAt) <= Date.now() ? "eligible" : "observing";
}

function statusOrder(value) {
  return { pending: 0, observing: 1, eligible: 2, settled: 3, disputed: 4, void: 5 }[value] ?? -1;
}

function rankGroupKey(workspaceId, agentId, revision, domain, taskType) {
  return JSON.stringify([workspaceId, agentId, revision, domain || "general", taskType || "decision"]);
}

function rankContractState(contract, integrityValid = true) {
  return {
    contract_id: contract.contract_id,
    status: contract.status,
    settlement_hash: contract.settlement?.settlement_hash || null,
    dispute_hashes: (contract.disputes || []).map((dispute) => dispute.dispute_hash).sort(),
    integrity_valid: integrityValid,
    changed_at: latestContractStateTime(contract)
  };
}

function latestContractStateTime(contract) {
  const values = [
    contract.created_at,
    contract.settled_at,
    ...(contract.disputes || []).map((dispute) => dispute.disputed_at),
    ...(contract.settlements || []).map((settlement) => settlement.settled_at)
  ].map((value) => Date.parse(value || "")).filter(Number.isFinite);
  return new Date(values.length ? Math.max(...values) : Date.now()).toISOString();
}

function latestRankStateTime(states) {
  const values = states.map((state) => Date.parse(state.changed_at || "")).filter(Number.isFinite);
  return new Date(values.length ? Math.max(...values) : Date.now()).toISOString();
}

function eventSubject(workspaceId, agentId) {
  return `${workspaceId}/${agentId || "unknown"}`;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object" || Buffer.isBuffer(value)) return value === undefined ? null : value;
  return Object.fromEntries(Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => [key, canonical(value[key])]));
}

function digest(value) {
  if (Buffer.isBuffer(value) && value.length === 32) return value;
  const normalized = normalizedDigest(value);
  if (normalized) return normalized;
  return crypto.createHash("sha256").update(JSON.stringify(canonical(value)), "utf8").digest();
}

function privacyDigest(value) {
  return crypto.createHash("sha256").update(JSON.stringify(canonical(value)), "utf8").digest();
}

function normalizedDigest(value) {
  const text = typeof value === "string" ? value.trim().toLowerCase().replace(/^sha256:/, "") : "";
  return /^[a-f0-9]{64}$/.test(text) ? Buffer.from(text, "hex") : null;
}

function digestOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  return normalizedDigest(value) || digest(value);
}

function digestOrValue(value, fallback) {
  return normalizedDigest(value) || digest(fallback);
}

function stableUuid(...parts) {
  const bytes = crypto.createHash("sha256").update(parts.map((part) => String(part ?? "")).join("\0")).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function revisionUuid(workspaceId, agentId, revision) {
  return stableUuid("agent-revision", workspaceId, agentId, Buffer.isBuffer(revision) ? revision.toString("hex") : revision);
}

function sourceUuid(workspaceId, sourceId, contentDigest) {
  return stableUuid("source-revision", workspaceId, sourceId, Buffer.isBuffer(contentDigest) ? contentDigest.toString("hex") : contentDigest);
}

function executionUuid(workspaceId, runId) {
  return stableUuid("execution", workspaceId, runId);
}

function executionStepUuid(workspaceId, runId, stepId) {
  return stableUuid("execution-step", workspaceId, runId, stepId);
}

function evidenceUuid(workspaceId, runId, stepId, material) {
  return stableUuid("evidence", workspaceId, runId, stepId, digest(material).toString("hex"));
}

function safeEvent(value, fallback) {
  return String(value || fallback).replace(/[^A-Za-z0-9_.:-]+/g, "_").slice(0, 160);
}

function ledgerVisibility(value) {
  return value === "team" ? "team" : value === "workspace" ? "workspace" : "private";
}

function stepStatus(value) {
  return ["completed", "failed", "blocked", "cancelled"].includes(value) ? value : "completed";
}

function oracleType(value) {
  if (value === "api") return "deterministic_api";
  if (value === "document") return "signed_system";
  return "audited_human";
}

function positiveIntOrNull(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function probability(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : 0;
}

function probabilityOrNull(value) {
  return value === null || value === undefined ? null : probability(value);
}

function average(values) {
  const finite = values.map(Number).filter(Number.isFinite);
  return finite.length ? finite.reduce((sum, value) => sum + value, 0) / finite.length : 0;
}

function elapsedMs(value, startedAt, completedAt) {
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  return Math.max(0, Date.parse(completedAt) - Date.parse(startedAt));
}

function iso(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  const parsed = Date.parse(value || "");
  return new Date(Number.isFinite(parsed) ? parsed : Date.now()).toISOString();
}

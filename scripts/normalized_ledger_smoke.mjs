#!/usr/bin/env node
/* global console, process */
import pg from "pg";

import {
  normalizedLedgerActorId,
  normalizedLedgerAvailable,
  normalizedLedgerLabel,
  syncNormalizedLedger
} from "../server/normalizedLedger.js";
import {
  agentRevisionSnapshot,
  digestValue,
  outcomeContractDefinitionMaterial
} from "../server/outcomes.js";

const { Client } = pg;
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for normalized_ledger_smoke.mjs");

const sha = digestValue;
const suffix = `${process.pid}_${Date.now()}`;
const workspace = `workspace_ledger_smoke_${suffix}`;
const agentId = `ledger_smoke_${suffix}_lora`;
const runId = `run_ledger_smoke_${suffix}`;
const sessionId = `session_ledger_smoke_${suffix}`;
const revision = sha("revision");
const createdAt = new Date(Date.now() - 2_000).toISOString();
const dueAt = new Date(Date.now() - 1_000).toISOString();
const settledAt = new Date().toISOString();
const uploadDigest = sha("exact uploaded source bytes");
const extractedTextDigest = sha("exact extracted source text");
const corpusRevision = sha("exact corpus revision");
const indexDigest = sha("exact index bytes");
const ledgerAgentId = normalizedLedgerLabel("agent", workspace, agentId);
const ledgerSourceId = normalizedLedgerLabel("source", workspace, `doc_${suffix}`);

const agent = {
  id: agentId,
  title: "Normalized ledger smoke",
  capability: "Proves transactional normalized persistence.",
  boundary: "Synthetic test only.",
  workspace_id: workspace,
  visibility: "private",
  created_by: "ledger_smoke",
  contract_version: "tcar-agent-v1",
  sources: [],
  adapter_content_digest: sha("adapter"),
  manifest_contract_digest: sha("manifest contract bytes")
};
const agentEvent = {
  event_id: `agent_event_${suffix}`,
  schema_version: "virenis-agent-event-v1",
  event_type: "agent.created",
  agent_id: agentId,
  agent_revision: revision,
  agent_revision_snapshot: agentRevisionSnapshot(agent),
  workspace_id: workspace,
  visibility: "private",
  actor_id: "ledger_smoke",
  actor_role: "admin",
  occurred_at: createdAt,
  details: { smoke: true },
  previous_event_hash: null
};
agentEvent.event_hash = sha(agentEvent);

const citation = {
  agent_id: agentId,
  chunk_id: `ledger_chunk_${suffix}`,
  page_start: 1,
  page_end: 1,
  claim: "The synthetic probability is 0.9.",
  excerpt: "The synthetic probability is 0.9.",
  path: `sources/tcar_documents/${suffix}/chunk.md`,
  content_digest: sha("chunk body"),
  corpus_revision: corpusRevision,
  index_digest: indexDigest,
  verified: true
};
const run = {
  run_id: runId,
  session_id: sessionId,
  status: "completed",
  query: "Return the synthetic probability.",
  plan: { steps: [{ id: "s1", adapter: agentId, depends_on: [] }], routing: {} },
  created_at: createdAt,
  started_at: createdAt,
  completed_at: settledAt,
  final_answer: "The synthetic probability is 0.9.",
  sources: [citation]
};
const step = {
  run_id: runId,
  step_id: "s1",
  adapter: agentId,
  status: "completed",
  task: "Return the probability.",
  depends_on: [],
  domain_answer: "The synthetic probability is 0.9.",
  citations: [citation],
  allowed_tools: [],
  handoff_artifacts: [{ name: "probability", value: 0.9, verified: true, confidence: 0.9, content_digest: sha(0.9) }],
  started_at: createdAt,
  completed_at: settledAt,
  elapsed_sec: 2
};
const participant = {
  step_id: "s1",
  agent_id: agentId,
  agent_revision: revision,
  agent_revision_snapshot: agentRevisionSnapshot(agent),
  contract_version: "tcar-agent-v1",
  binding_type: "lora",
  model_id: "qwen36-awq",
  adapter_digest: sha("adapter"),
  task_digest: sha(step.task),
  output_digest: sha(step.domain_answer),
  evidence_ids: [sha(citation)],
  status: "completed",
  elapsed_sec: 2,
  routing: { source: "explicit", confidence: 1 }
};
const execution = {
  execution_id: `exec_${suffix}`,
  schema_version: "virenis-execution-v1",
  run_id: runId,
  session_id: sessionId,
  workspace_id: workspace,
  created_by: "ledger_smoke",
  visibility: "private",
  status: "completed",
  query_digest: sha(run.query),
  plan_digest: sha(run.plan),
  result_digest: sha(run.final_answer),
  manifest_revision: sha("manifest"),
  base_model: "qwen36-awq",
  base_model_digest: sha("base"),
  router_model_digest: sha("router"),
  router_chat_template_digest: sha("template"),
  executor_code_digest: sha("executor"),
  component_provenance_digest: sha("components"),
  planner_mode: "cue",
  started_at: createdAt,
  completed_at: settledAt,
  recorded_at: settledAt,
  participants: [participant]
};
execution.record_hash = sha(execution);

const score = {
  step_id: "s1",
  agent_id: agentId,
  agent_revision: revision,
  utility: 0.99,
  accuracy: 0.99,
  calibration_error: 0.1,
  rank_weight: 1,
  trust_weight: 1,
  abstained: false
};
const settlement = {
  settlement_id: `settlement_${suffix}`,
  scoring_version: "reality-rank-v1",
  idempotency_key: `settle_${suffix}`,
  request_digest: sha("settle"),
  actual_value: 1,
  source: { type: "human", authority: "Ledger smoke", reference: `ledger:${suffix}` },
  notes: "Rollback-only integration smoke.",
  settled_by: "ledger_resolver",
  verified_for_rank: true,
  verification_role: "resolver_principal",
  resolver_principal: {
    schema_version: "virenis-resolver-principal-v1",
    principal_id: "ledger_resolver",
    workspace_id: workspace,
    auth_type: "bearer",
    type: "human",
    authority: "Ledger smoke",
    reference_match: "exact",
    reference: `ledger:${suffix}`
  },
  settled_at: settledAt,
  participant_scores: [score]
};
settlement.settlement_hash = sha(settlement);
const contract = {
  contract_id: `outcome_${suffix}`,
  schema_version: "virenis-outcome-contract-v2",
  scoring_version: "reality-rank-v1",
  execution_id: execution.execution_id,
  run_id: runId,
  session_id: sessionId,
  workspace_id: workspace,
  created_by: "ledger_smoke",
  visibility: "private",
  idempotency_key: `contract_${suffix}`,
  request_digest: sha("contract"),
  title: "Normalized ledger smoke",
  claim: "The synthetic outcome resolves.",
  domain: "ledger_smoke",
  task_type: "integration",
  outcome_type: "binary",
  status: "settled",
  resolver: { type: "human", authority: "Ledger smoke", reference: `ledger:${suffix}` },
  resolution: { metric: "resolved", due_at: dueAt },
  participants: [{ ...participant, prediction: 0.9, confidence: 0.9, abstained: false, prediction_evidence_digest: sha("evidence"), rationale_digest: sha("rationale") }],
  evidence_ids: [sha(citation)],
  execution_record_hash: execution.record_hash,
  created_at: createdAt,
  settled_at: settledAt,
  settlement,
  settlements: [settlement],
  disputes: [],
  events: []
};
const createdEvent = {
  event_id: `outcome_event_created_${suffix}`,
  schema_version: "virenis-outcome-event-v1",
  event_type: "contract.created",
  actor_id: contract.created_by,
  occurred_at: createdAt,
  payload: {
    execution_id: contract.execution_id,
    participant_revisions: contract.participants.map(({ agent_id, agent_revision }) => ({ agent_id, agent_revision }))
  },
  previous_event_hash: null
};
createdEvent.event_hash = sha(createdEvent);
const settledEvent = {
  event_id: `outcome_event_settled_${suffix}`,
  schema_version: "virenis-outcome-event-v1",
  event_type: "contract.settled",
  actor_id: settlement.settled_by,
  occurred_at: settlement.settled_at,
  payload: {
    settlement_id: settlement.settlement_id,
    settlement_hash: settlement.settlement_hash,
    source_type: settlement.source.type
  },
  previous_event_hash: createdEvent.event_hash
};
settledEvent.event_hash = sha(settledEvent);
contract.events = [createdEvent, settledEvent];
contract.contract_hash = sha(outcomeContractDefinitionMaterial(contract));
const document = {
  document_id: `doc_${suffix}`,
  workspace_id: workspace,
  agent_id: agentId,
  title: "Ledger smoke document",
  source_digest: extractedTextDigest,
  upload_digest: uploadDigest,
  extracted_text_digest: extractedTextDigest,
  corpus_revision: corpusRevision,
  index_digest: indexDigest,
  index_path: `sources/tcar_documents/${suffix}/index.jsonl`,
  chunks: [{ chunk_id: citation.chunk_id, content_digest: sha("chunk") }],
  created_by: "ledger_smoke",
  created_at: createdAt,
  source_revision_snapshot: {
    content_digest: uploadDigest,
    corpus_revision: corpusRevision,
    index_digest: indexDigest,
    chunk_count: 1,
    source_metadata: {
      agent_id: agentId,
      title: "Ledger smoke document",
      page_count: 1,
      upload_digest: uploadDigest,
      extracted_text_digest: extractedTextDigest,
      corpus_revision: corpusRevision
    }
  }
};
const data = {
  agents: [agent],
  agentEvents: [agentEvent],
  sessions: [{ session_id: sessionId, workspace_id: workspace, created_by: "ledger_smoke" }],
  runs: [run],
  runSteps: [step],
  executionRecords: [execution],
  documents: [document],
  outcomeContracts: [contract]
};

const client = new Client({ connectionString });
await client.connect();
try {
  if (!await normalizedLedgerAvailable(client)) {
    throw new Error("normalized ledger schema, RLS policies, or triggers failed exact attestation");
  }
  await client.query("BEGIN");
  await syncNormalizedLedger(client, data);
  await syncNormalizedLedger(client, data);

  const tables = [
    "agent_revisions", "agent_events", "execution_runs", "execution_steps",
    "execution_events", "source_revisions", "evidence_records",
    "execution_artifacts", "outcome_contracts", "outcome_contract_versions",
    "outcome_instances", "outcome_observations", "outcome_settlements",
    "settlement_metric_scores", "settlement_observations", "reality_rank_snapshots"
  ];
  const counts = {};
  for (const table of tables) {
    const result = await client.query(`SELECT count(*)::int AS count FROM tcar_ledger.${table} WHERE workspace_id=$1`, [workspace]);
    counts[table] = result.rows[0].count;
    if (counts[table] !== 1) throw new Error(`${table} expected exactly one smoke row, received ${counts[table]}`);
  }
  const privacyProjection = await client.query(
    `SELECT
       (SELECT agent_id FROM tcar_ledger.agent_revisions WHERE workspace_id=$1 LIMIT 1) AS revision_agent_id,
       (SELECT actor_id FROM tcar_ledger.agent_events WHERE workspace_id=$1 LIMIT 1) AS event_actor_id,
       (SELECT actor_id FROM tcar_ledger.execution_runs WHERE workspace_id=$1 LIMIT 1) AS execution_actor_id,
       (SELECT chunk_id FROM tcar_ledger.evidence_records WHERE workspace_id=$1 LIMIT 1) AS chunk_id,
       (SELECT artifact_name FROM tcar_ledger.execution_artifacts WHERE workspace_id=$1 LIMIT 1) AS artifact_name,
       (SELECT inline_payload FROM tcar_ledger.execution_artifacts WHERE workspace_id=$1 LIMIT 1) AS inline_payload,
       (SELECT owner_actor_id FROM tcar_ledger.outcome_contracts WHERE workspace_id=$1 LIMIT 1) AS owner_actor_id,
       (SELECT observed_value FROM tcar_ledger.outcome_observations WHERE workspace_id=$1 LIMIT 1) AS observed_value`,
    [workspace]
  );
  const privacyRow = privacyProjection.rows[0] || {};
  if (
    privacyRow.revision_agent_id !== ledgerAgentId
    || privacyRow.event_actor_id !== normalizedLedgerActorId(workspace, agentEvent.actor_id)
    || privacyRow.execution_actor_id !== normalizedLedgerActorId(workspace, execution.created_by)
    || privacyRow.chunk_id !== normalizedLedgerLabel("chunk", workspace, citation.chunk_id)
    || privacyRow.artifact_name !== normalizedLedgerLabel("artifact", workspace, step.handoff_artifacts[0].name)
    || privacyRow.inline_payload !== null
    || privacyRow.owner_actor_id !== normalizedLedgerActorId(workspace, contract.created_by)
    || privacyRow.observed_value?.schema_version !== "virenis-ledger-content-free-v1"
    || privacyRow.observed_value?.redacted !== true
  ) {
    throw new Error("normalized ledger privacy projection retained a raw actor, label, or inline payload");
  }
  const instance = await client.query(
    "SELECT status FROM tcar_ledger.outcome_instances WHERE workspace_id=$1",
    [workspace]
  );
  if (instance.rows[0]?.status !== "settled") throw new Error("normalized outcome instance did not reach settled");
  const definitionProjection = await client.query(
    `SELECT definition, encode(definition_digest, 'hex') AS definition_digest
       FROM tcar_ledger.outcome_contract_versions WHERE workspace_id=$1`,
    [workspace]
  );
  const definitionReceipt = definitionProjection.rows[0]?.definition;
  if (
    definitionReceipt?.schema_version !== "virenis-ledger-content-free-v1"
    || definitionReceipt?.redacted !== true
    || definitionReceipt?.content_digest?.slice("sha256:".length) !== definitionProjection.rows[0]?.definition_digest
  ) {
    throw new Error("stored Outcome Contract definition was not reduced to its exact digest receipt");
  }
  const agentDigestProjection = await client.query(
    `SELECT encode(manifest_item_digest, 'hex') AS manifest_item_digest,
            encode(adapter_digest, 'hex') AS adapter_digest
       FROM tcar_ledger.agent_revisions
      WHERE workspace_id=$1 AND agent_id=$2 ORDER BY revision_no LIMIT 1`,
    [workspace, ledgerAgentId]
  );
  if (
    agentDigestProjection.rows[0]?.manifest_item_digest !== agent.manifest_contract_digest.slice("sha256:".length)
    || agentDigestProjection.rows[0]?.adapter_digest !== agent.adapter_content_digest.slice("sha256:".length)
  ) {
    throw new Error("agent manifest/adapter digest was double-hashed during normalized projection");
  }

  const disputedAt = new Date(Date.parse(settledAt) + 1_000).toISOString();
  const dispute = {
    dispute_id: `dispute_${suffix}`,
    settlement_id: settlement.settlement_id,
    reason: "Synthetic dispute proves append-only dispute projection.",
    evidence_digest: sha("dispute-evidence"),
    disputed_by: "ledger_challenger",
    disputed_at: disputedAt
  };
  dispute.dispute_hash = sha(dispute);
  const disputedEvent = {
    event_id: `outcome_event_disputed_${suffix}`,
    schema_version: "virenis-outcome-event-v1",
    event_type: "contract.disputed",
    actor_id: dispute.disputed_by,
    occurred_at: disputedAt,
    payload: {
      dispute_id: dispute.dispute_id,
      settlement_id: dispute.settlement_id,
      dispute_hash: dispute.dispute_hash
    },
    previous_event_hash: settledEvent.event_hash
  };
  disputedEvent.event_hash = sha(disputedEvent);
  contract.disputes.push(dispute);
  contract.events.push(disputedEvent);
  contract.status = "disputed";
  await syncNormalizedLedger(client, data);
  await syncNormalizedLedger(client, data);

  const disputedProjection = await client.query(
    `SELECT instance.status,
            (SELECT count(*)::int FROM tcar_ledger.outcome_disputes WHERE workspace_id=$1) AS disputes,
            rank.sample_size,
            rank.score::float8 AS score
       FROM tcar_ledger.outcome_instances AS instance
       JOIN LATERAL (
         SELECT sample_size, score FROM tcar_ledger.reality_rank_snapshots
          WHERE workspace_id=$1 ORDER BY snapshot_version DESC LIMIT 1
       ) AS rank ON true
      WHERE instance.workspace_id=$1`,
    [workspace]
  );
  if (
    disputedProjection.rows[0]?.status !== "disputed"
    || disputedProjection.rows[0]?.disputes !== 1
    || disputedProjection.rows[0]?.sample_size !== 0
    || disputedProjection.rows[0]?.score !== 50
  ) {
    throw new Error("dispute projection did not revoke the latest RealityRank input");
  }

  const correctedAt = new Date(Date.parse(settledAt) + 2_000).toISOString();
  const correction = {
    ...settlement,
    settlement_id: `settlement_correction_${suffix}`,
    idempotency_key: `correct_${suffix}`,
    request_digest: sha("correct"),
    supersedes_settlement_id: settlement.settlement_id,
    correction_reason: "Synthetic correction proves settlement supersession.",
    actual_value: 0,
    settled_at: correctedAt,
    participant_scores: [{ ...score, utility: 0.01, accuracy: 0.01 }]
  };
  delete correction.settlement_hash;
  correction.settlement_hash = sha(correction);
  const correctedEvent = {
    event_id: `outcome_event_corrected_${suffix}`,
    schema_version: "virenis-outcome-event-v1",
    event_type: "contract.corrected",
    actor_id: correction.settled_by,
    occurred_at: correctedAt,
    payload: {
      settlement_id: correction.settlement_id,
      supersedes_settlement_id: correction.supersedes_settlement_id,
      settlement_hash: correction.settlement_hash
    },
    previous_event_hash: disputedEvent.event_hash
  };
  correctedEvent.event_hash = sha(correctedEvent);
  contract.settlements.push(correction);
  contract.settlement = correction;
  contract.settled_at = correctedAt;
  contract.status = "settled";
  contract.events.push(correctedEvent);
  await syncNormalizedLedger(client, data);
  await syncNormalizedLedger(client, data);

  const correctionProjection = await client.query(
    `SELECT instance.status,
            (SELECT count(*)::int FROM tcar_ledger.outcome_settlements WHERE workspace_id=$1) AS settlements,
            (SELECT count(*)::int FROM tcar_ledger.outcome_observations WHERE workspace_id=$1) AS observations,
            (SELECT count(*)::int FROM tcar_ledger.reality_rank_snapshots WHERE workspace_id=$1) AS rank_snapshots,
            latest_observation.supersedes_observation_id IS NOT NULL AS observation_superseded
       FROM tcar_ledger.outcome_instances AS instance
       JOIN LATERAL (
         SELECT supersedes_observation_id FROM tcar_ledger.outcome_observations
          WHERE workspace_id=$1 ORDER BY observed_at DESC LIMIT 1
       ) AS latest_observation ON true
      WHERE instance.workspace_id=$1`,
    [workspace]
  );
  if (
    correctionProjection.rows[0]?.status !== "settled"
    || correctionProjection.rows[0]?.settlements !== 2
    || correctionProjection.rows[0]?.observations !== 2
    || correctionProjection.rows[0]?.rank_snapshots !== 3
    || correctionProjection.rows[0]?.observation_superseded !== true
  ) {
    throw new Error("correction projection did not preserve its settlement and observation chains");
  }

  const originalAgentEvent = JSON.parse(JSON.stringify(agentEvent));
  agentEvent.actor_id = "forged-replay";
  delete agentEvent.event_hash;
  agentEvent.event_hash = sha(agentEvent);
  let replayConflictRejected = false;
  try {
    await syncNormalizedLedger(client, data);
  } catch (error) {
    replayConflictRejected = /Normalized ledger replay conflict/.test(error.message);
  }
  Object.assign(agentEvent, originalAgentEvent);
  if (!replayConflictRejected) throw new Error("conflicting immutable replay was not rejected");

  agent.title = "Normalized ledger smoke revision two";
  const secondRevision = sha(agentRevisionSnapshot(agent));
  const secondAgentEvent = {
    ...agentEvent,
    event_id: `agent_event_second_${suffix}`,
    event_type: "agent.updated",
    agent_revision: secondRevision,
    agent_revision_snapshot: agentRevisionSnapshot(agent),
    details: { smoke: true, revision: 2 },
    previous_event_hash: agentEvent.event_hash
  };
  delete secondAgentEvent.event_hash;
  secondAgentEvent.event_hash = sha(secondAgentEvent);
  data.agentEvents.push(secondAgentEvent);
  await syncNormalizedLedger(client, data);
  await syncNormalizedLedger(client, data);
  const revisionProjection = await client.query(
    `SELECT count(*)::int AS revisions,
            count(DISTINCT revision_snapshot->>'content_digest')::int AS distinct_digests,
            bool_and(revision_snapshot->>'redacted'='true') AS all_redacted
       FROM tcar_ledger.agent_revisions WHERE workspace_id=$1 AND agent_id=$2`,
    [workspace, ledgerAgentId]
  );
  if (
    revisionProjection.rows[0]?.revisions !== 2
    || revisionProjection.rows[0]?.distinct_digests !== 2
    || revisionProjection.rows[0]?.all_redacted !== true
  ) {
    throw new Error("revision-time agent snapshot digest receipts were not preserved");
  }

  const validClaim = contract.claim;
  contract.claim = "tampered claim that is not covered by the frozen contract hash";
  await syncNormalizedLedger(client, data);
  await syncNormalizedLedger(client, data);
  const integrityRevocation = await client.query(
    `SELECT sample_size, score::float8 AS score
       FROM tcar_ledger.reality_rank_snapshots
      WHERE workspace_id=$1 ORDER BY snapshot_version DESC LIMIT 1`,
    [workspace]
  );
  contract.claim = validClaim;
  if (integrityRevocation.rows[0]?.sample_size !== 0 || integrityRevocation.rows[0]?.score !== 50) {
    throw new Error("invalid Outcome Contract remained eligible in the normalized RealityRank projection");
  }
  await syncNormalizedLedger(client, data);
  await syncNormalizedLedger(client, data);
  const integrityRestoration = await client.query(
    `SELECT sample_size,
            (SELECT count(*)::int FROM tcar_ledger.reality_rank_snapshots WHERE workspace_id=$1) AS snapshots
       FROM tcar_ledger.reality_rank_snapshots
      WHERE workspace_id=$1 ORDER BY snapshot_version DESC LIMIT 1`,
    [workspace]
  );
  if (integrityRestoration.rows[0]?.sample_size !== 1 || integrityRestoration.rows[0]?.snapshots !== 5) {
    throw new Error("a repaired Outcome Contract did not create one idempotent rank restoration snapshot");
  }

  await client.query("SAVEPOINT immutable_check");
  let immutableRejected = false;
  try {
    await client.query("UPDATE tcar_ledger.agent_events SET actor_id='forged' WHERE workspace_id=$1", [workspace]);
  } catch (error) {
    immutableRejected = error.code === "55000";
    await client.query("ROLLBACK TO SAVEPOINT immutable_check");
  }
  if (!immutableRejected) throw new Error("append-only trigger accepted an agent-event update");

  const sourceBeforePurge = await client.query(
    `SELECT source_revision_id, source_id, revision_no, source_kind,
            encode(content_digest, 'hex') AS content_digest,
            encode(index_digest, 'hex') AS index_digest,
            encode(metadata_digest, 'hex') AS metadata_digest,
            chunk_count, source_metadata, created_by, created_at
       FROM tcar_ledger.source_revisions
      WHERE workspace_id=$1 AND source_id=$2`,
    [workspace, ledgerSourceId]
  );
  const sourceRow = sourceBeforePurge.rows[0];
  if (
    sourceBeforePurge.rowCount !== 1
    || sourceRow.content_digest !== uploadDigest.slice("sha256:".length)
    || sourceRow.index_digest !== indexDigest.slice("sha256:".length)
    || sourceRow.source_metadata?.schema_version !== "virenis-ledger-content-free-v1"
    || sourceRow.source_metadata?.redacted !== true
    || sourceRow.source_metadata?.content_digest?.slice("sha256:".length) !== sourceRow.metadata_digest
    || sourceRow.created_by !== normalizedLedgerActorId(workspace, document.created_by)
    || sourceRow.chunk_count !== 1
  ) {
    throw new Error("normalized source revision did not preserve the exact cross-ledger source/index/corpus digests");
  }
  const purgedAt = new Date(Date.parse(settledAt) + 2_000).toISOString();
  const purgedDocument = {
    ...document,
    enabled: false,
    archived_at: purgedAt,
    purged_at: purgedAt,
    source_path: null,
    index_path: null,
    document_root: null,
    chunks: []
  };
  await syncNormalizedLedger(client, { ...data, documents: [purgedDocument] });
  await syncNormalizedLedger(client, { ...data, documents: [purgedDocument] });
  const sourceAfterPurge = await client.query(
    `SELECT source_revision_id, source_id, revision_no, source_kind,
            encode(content_digest, 'hex') AS content_digest,
            encode(index_digest, 'hex') AS index_digest,
            encode(metadata_digest, 'hex') AS metadata_digest,
            chunk_count, source_metadata, created_by, created_at
       FROM tcar_ledger.source_revisions
      WHERE workspace_id=$1 AND source_id=$2`,
    [workspace, ledgerSourceId]
  );
  if (
    sourceAfterPurge.rowCount !== 1
    || JSON.stringify(sourceAfterPurge.rows[0]) !== JSON.stringify(sourceRow)
  ) {
    throw new Error("document purge did not rebuild the exact immutable source creation snapshot");
  }
  const sourceBinding = await client.query(
    `SELECT evidence.source_revision_id=source.source_revision_id AS matches
       FROM tcar_ledger.evidence_records AS evidence
       JOIN tcar_ledger.source_revisions AS source
         ON source.workspace_id=evidence.workspace_id AND source.source_revision_id=evidence.source_revision_id
      WHERE evidence.workspace_id=$1`,
    [workspace]
  );
  if (sourceBinding.rows[0]?.matches !== true) {
    throw new Error("upload-byte source digest did not bind evidence to the inserted source revision");
  }

  const roleFlags = await client.query(
    "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user"
  );
  const privilegedConnection = roleFlags.rows[0]?.rolsuper === true || roleFlags.rows[0]?.rolbypassrls === true;
  const rlsRole = `virenis_ledger_smoke_${process.pid}`;
  if (privilegedConnection) {
    await client.query(`CREATE ROLE ${rlsRole} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
    await client.query(`GRANT USAGE ON SCHEMA tcar_ledger TO ${rlsRole}`);
    await client.query(`GRANT SELECT ON tcar_ledger.agent_events TO ${rlsRole}`);
    await client.query(`SET LOCAL ROLE ${rlsRole}`);
  }
  await client.query("SELECT set_config('tcar.workspace_id', $1, true)", [workspace]);
  const ownWorkspace = await client.query(
    "SELECT count(*)::int AS count FROM tcar_ledger.agent_events WHERE workspace_id=$1",
    [workspace]
  );
  await client.query("SELECT set_config('tcar.workspace_id', $1, true)", [`workspace_other_${suffix}`]);
  const otherWorkspace = await client.query(
    "SELECT count(*)::int AS count FROM tcar_ledger.agent_events WHERE workspace_id=$1",
    [workspace]
  );
  if (privilegedConnection) await client.query("RESET ROLE");
  await client.query("SELECT set_config('tcar.workspace_id', $1, true)", [workspace]);
  if (ownWorkspace.rows[0]?.count !== 2 || otherWorkspace.rows[0]?.count !== 0) {
    throw new Error("normalized ledger RLS did not enforce workspace isolation for an unprivileged role");
  }

  const policyResult = await client.query(
    `SELECT count(*)::int AS count FROM pg_policies WHERE schemaname='tcar_ledger'
       AND policyname=tablename || '_workspace_isolation'
       AND permissive='PERMISSIVE' AND cmd='ALL'
       AND roles=ARRAY['public']::name[]
       AND regexp_replace(COALESCE(qual,''), '\\s+', '', 'g')='(workspace_id=tcar_ledger.current_workspace_id())'
       AND regexp_replace(COALESCE(with_check,''), '\\s+', '', 'g')='(workspace_id=tcar_ledger.current_workspace_id())'`
  );
  const policyTotal = await client.query(
    `SELECT count(*)::int AS count FROM pg_policies WHERE schemaname='tcar_ledger'
       AND tablename=ANY($1::text[])`,
    [[
      "workspaces", "agent_revisions", "agent_events", "execution_runs",
      "source_revisions", "execution_steps", "execution_events", "evidence_records",
      "execution_artifacts", "artifact_evidence", "outcome_contracts",
      "outcome_contract_versions", "outcome_instances", "outcome_observations",
      "outcome_settlements", "outcome_disputes", "settlement_metric_scores",
      "settlement_observations", "reality_rank_snapshots"
    ]]
  );
  const forcedResult = await client.query(
    `SELECT count(*)::int AS count FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='tcar_ledger' AND c.relrowsecurity AND c.relforcerowsecurity`
  );
  if (policyResult.rows[0].count !== 19 || policyTotal.rows[0].count !== 19 || forcedResult.rows[0].count < 19) {
    throw new Error("normalized ledger RLS policies are incomplete");
  }

  console.log(JSON.stringify({
    ok: true,
    replay_idempotent: true,
    content_free_privacy_projection: true,
    definition_digest_receipt_matches_content: true,
    manifest_item_digest_preserved_exactly: true,
    conflicting_replay_rejected: replayConflictRejected,
    same_timestamp_event_chain_preserved: true,
    dispute_rank_revoked: true,
    correction_chain_preserved: true,
    revision_snapshot_digest_receipts_preserved: true,
    invalid_contract_rank_revoked: true,
    repaired_contract_rank_restored: true,
    source_upload_index_corpus_digests_exact_and_metadata_redacted: true,
    purged_source_snapshot_rebuild_equal: true,
    actual_rls_isolation: true,
    append_only_update_rejected: true,
    workspace_policies: policyResult.rows[0].count,
    workspace_policy_total: policyTotal.rows[0].count,
    forced_rls_tables: forcedResult.rows[0].count,
    counts
  }, null, 2));
} finally {
  await client.query("ROLLBACK").catch(() => undefined);
  await client.end();
}

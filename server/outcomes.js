import crypto from "node:crypto";
import { makeId, nowIso } from "./store.js";

const OUTCOME_TYPES = new Set(["binary", "numeric", "categorical"]);
const RESOLVER_TYPES = new Set(["human", "api", "document"]);
const RANK_PRIOR_MEAN = 0.5;
const RANK_PRIOR_WEIGHT = 2;
const RANK_HALF_LIFE_DAYS = 180;
const DEFAULT_RANK_MIN_VERIFIED_SAMPLES = 3;
const MIN_RANK_MIN_VERIFIED_SAMPLES = 1;
const MAX_RANK_MIN_VERIFIED_SAMPLES = 100;

export function realityRankMinVerifiedSamples(env = process.env) {
  const raw = String(env.VIRENIS_REALITY_RANK_MIN_VERIFIED_SAMPLES ?? "").trim();
  if (!raw) return DEFAULT_RANK_MIN_VERIFIED_SAMPLES;
  if (!/^\d+$/.test(raw)) {
    throw new Error(
      "VIRENIS_REALITY_RANK_MIN_VERIFIED_SAMPLES must be an integer from 1 to 100."
    );
  }
  const value = Number(raw);
  if (value < MIN_RANK_MIN_VERIFIED_SAMPLES || value > MAX_RANK_MIN_VERIFIED_SAMPLES) {
    throw new Error(
      "VIRENIS_REALITY_RANK_MIN_VERIFIED_SAMPLES must be an integer from 1 to 100."
    );
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

export function digestValue(value) {
  return `sha256:${crypto.createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
}

export function normalizeSha256Digest(value) {
  const digest = String(value || "").trim().toLowerCase().replace(/^sha256:/, "");
  return /^[a-f0-9]{64}$/.test(digest) ? `sha256:${digest}` : null;
}

export function agentRevision(agent = {}) {
  const authoritative = agent.revision_authority === "runtime"
    ? normalizeSha256Digest(agent.agent_revision)
    : null;
  if (authoritative) return authoritative;
  return digestValue(agentRevisionSnapshot(agent));
}

export function agentRevisionSnapshot(agent = {}) {
  return {
    id: agent.id || "",
    title: agent.title || "",
    capability: agent.capability || "",
    boundary: agent.boundary || "",
    consumes: normalizedStrings(agent.consumes),
    produces: normalizedStrings(agent.produces),
    routing_cues: normalizedStrings(agent.routing_cues),
    resources: normalizedStrings(agent.resources),
    tools: normalizedStrings(agent.tools),
    sources: normalizedStrings(agent.sources),
    retrieval: agent.retrieval || null,
    document: agent.document || null,
    policies: agent.policies || {},
    private_knowledge_digest: agent.private_knowledge_digest
      || (agent.source_text_internal ? digestValue(agent.source_text_internal) : null),
    stage: Number(agent.stage || 50),
    contract_version: agent.contract_version || "tcar-agent-v1",
    adapter_path_digest: agent.adapter_path ? digestValue(agent.adapter_path) : null,
    adapter_content_digest: normalizeSha256Digest(agent.adapter_content_digest),
    manifest_contract_digest: normalizeSha256Digest(agent.manifest_contract_digest)
  };
}

export function appendAgentEvent(data, {
  eventType,
  agent,
  actor,
  details = {},
  occurredAt = nowIso()
}) {
  data.agentEvents ||= [];
  const previous = [...data.agentEvents].reverse().find((event) => event.agent_id === agent.id);
  const event = {
    event_id: makeId("agent_event"),
    schema_version: "virenis-agent-event-v1",
    event_type: eventType,
    agent_id: agent.id,
    agent_revision: agentRevision(agent),
    agent_revision_snapshot: agentRevisionSnapshot(agent),
    workspace_id: agent.workspace_id || null,
    visibility: agent.visibility || "global",
    actor_id: actor?.user_id || "system",
    actor_role: actor?.role || "system",
    occurred_at: occurredAt,
    details: boundedAuditDetails(details),
    previous_event_hash: previous?.event_hash || null
  };
  event.event_hash = digestValue(event);
  data.agentEvents.push(event);
  return event;
}

export function recordExecution(data, {
  run,
  session,
  agents = [],
  manifestRevision = null,
  runtimeExecution = null,
  baseModel = null,
  componentProvenance = null,
  recordedAt = nowIso()
}) {
  data.executionRecords ||= [];
  const existing = data.executionRecords.find((record) => record.run_id === run.run_id);
  if (existing) {
    return existing;
  }
  const agentById = new Map(agents.map((agent) => [agent.id, agent]));
  const steps = (data.runSteps || []).filter((step) => step.run_id === run.run_id);
  const routeSelections = new Map(
    (run.plan?.routing?.selected || []).map((selection) => [selection.adapter, selection])
  );
  const participants = steps.map((step) => {
    const agent = agentById.get(step.adapter) || { id: step.adapter };
    const selection = routeSelections.get(step.adapter) || null;
    return {
      step_id: step.step_id,
      agent_id: step.adapter,
      agent_revision: normalizeSha256Digest(step.agent_revision) || agentRevision(agent),
      agent_revision_snapshot: agentRevisionSnapshot(agent),
      contract_version: agent.contract_version || "tcar-agent-v1",
      binding_type: bindingType(agent),
      model_id: step.model_id || baseModel || run.base_model || null,
      adapter_digest: normalizeSha256Digest(step.adapter_digest)
        || normalizeSha256Digest(agent.adapter_content_digest)
        || digestValue({
          adapter_path: agent.adapter_path || "",
          binding_type: bindingType(agent)
        }),
      task_digest: digestValue(step.task || ""),
      output_digest: digestValue({
        domain_answer: step.domain_answer || "",
        handoff_artifacts: step.handoff_artifacts || [],
        policy_violations: step.policy_violations || []
      }),
      evidence_ids: (step.citations || []).map(stableEvidenceId).filter(Boolean),
      status: step.status || "completed",
      elapsed_sec: finiteNumberOrNull(step.elapsed_sec),
      routing: selection ? {
        source: selection.source || null,
        confidence: finiteProbabilityOrNull(selection.confidence),
        reality_rank: finiteProbabilityOrNull(selection.reality_rank),
        reason: boundedText(selection.reason, 1000)
      } : null
    };
  });
  const record = {
    execution_id: makeId("exec"),
    runtime_execution_id: runtimeExecution?.execution_id || runtimeExecution?.runtime_execution_id || null,
    runtime_request_fingerprint: normalizeSha256Digest(runtimeExecution?.request_fingerprint),
    runtime_record_hash: normalizeSha256Digest(runtimeExecution?.record_hash),
    schema_version: "virenis-execution-v1",
    run_id: run.run_id,
    session_id: run.session_id,
    workspace_id: run.workspace_id || session?.workspace_id || null,
    created_by: run.created_by || session?.created_by || null,
    actor_role: run.actor_role || null,
    visibility: session?.visibility || "private",
    status: run.status,
    query_digest: digestValue(run.query || ""),
    plan_digest: digestValue(run.plan || { steps: [] }),
    result_digest: digestValue({
      final_answer: run.final_answer || "",
      sources: run.sources || [],
      policy_events: run.policy_events || []
    }),
    manifest_revision: manifestRevision || run.manifest_revision || null,
    base_model: baseModel || run.base_model || null,
    base_model_digest: normalizeSha256Digest(componentProvenance?.base_model_content_digest),
    router_model_digest: normalizeSha256Digest(componentProvenance?.router_model_content_digest),
    router_chat_template_digest: normalizeSha256Digest(componentProvenance?.router_chat_template_digest),
    executor_code_digest: normalizeSha256Digest(componentProvenance?.executor_code_digest),
    component_provenance_digest: componentProvenance ? digestValue(componentProvenance) : null,
    planner_mode: run.planner_mode || null,
    started_at: run.started_at || null,
    completed_at: run.completed_at || recordedAt,
    recorded_at: recordedAt,
    participants
  };
  record.record_hash = digestValue(record);
  data.executionRecords.push(record);
  run.execution_id = record.execution_id;
  return record;
}

export function createOutcomeContract(data, {
  run,
  session,
  body,
  actor,
  idempotencyKey = null,
  createdAt = nowIso()
}) {
  if (run.status !== "completed") {
    throwOutcome(409, "Outcome Contracts require a completed run.");
  }
  const execution = (data.executionRecords || []).find((record) => record.run_id === run.run_id);
  if (!execution) {
    throwOutcome(409, "Execution provenance is not available for this run.");
  }
  if (
    !verifyExecutionRecord(execution)
    || execution.run_id !== run.run_id
    || execution.session_id !== run.session_id
    || String(execution.workspace_id || "") !== String(session.workspace_id || "")
  ) {
    throwOutcome(409, "Execution provenance failed integrity verification.");
  }
  const requestDigest = digestValue(body || {});
  const keyMatch = idempotencyKey
    ? (data.outcomeContracts || []).find((contract) =>
      contract.workspace_id === session.workspace_id && contract.idempotency_key === idempotencyKey
    )
    : null;
  if (keyMatch) {
    if (
      keyMatch.created_by !== actor.user_id
      || keyMatch.run_id !== run.run_id
      || keyMatch.request_digest !== requestDigest
    ) {
      throwOutcome(409, "Idempotency-Key conflicts with an existing Outcome Contract.");
    }
    return keyMatch;
  }
  if ((data.outcomeContracts || []).some((contract) =>
    contract.run_id === run.run_id || contract.execution_id === execution.execution_id
  )) {
    throwOutcome(409, "This execution already has an Outcome Contract.");
  }
  const outcomeType = String(body?.outcome_type || "").toLowerCase().trim();
  if (!OUTCOME_TYPES.has(outcomeType)) {
    throwOutcome(400, "outcome_type must be binary, numeric, or categorical.");
  }
  const title = requiredText(body?.title, "title", 160);
  const claim = requiredText(body?.claim, "claim", 2000);
  const domain = requiredSlug(body?.domain, "domain", 100);
  const taskType = requiredSlug(body?.task_type || "decision", "task_type", 100);
  const resolver = normalizeResolver(body?.resolver || {});
  const resolution = normalizeResolution(body?.resolution || {}, outcomeType, createdAt);
  const runSteps = (data.runSteps || []).filter((step) => step.run_id === run.run_id);
  const predictions = normalizePredictions(body?.predictions, outcomeType, execution.participants, runSteps);
  const contract = {
    contract_id: makeId("outcome"),
    schema_version: "virenis-outcome-contract-v2",
    scoring_version: "reality-rank-v1",
    execution_id: execution.execution_id,
    run_id: run.run_id,
    session_id: run.session_id,
    workspace_id: session.workspace_id,
    created_by: actor.user_id,
    visibility: session.visibility || "private",
    idempotency_key: idempotencyKey,
    request_digest: requestDigest,
    title,
    claim,
    domain,
    task_type: taskType,
    outcome_type: outcomeType,
    status: "pending",
    resolver,
    resolution,
    participants: predictions,
    evidence_ids: [...new Set(execution.participants.flatMap((participant) => participant.evidence_ids || []))],
    execution_record_hash: execution.record_hash,
    created_at: createdAt,
    settled_at: null,
    settlement: null,
    settlements: [],
    disputes: [],
    events: []
  };
  appendContractEvent(contract, {
    event_type: "contract.created",
    actor_id: actor.user_id,
    payload: {
      execution_id: execution.execution_id,
      participant_revisions: predictions.map((participant) => ({
        agent_id: participant.agent_id,
        agent_revision: participant.agent_revision
      }))
    },
    occurred_at: createdAt
  });
  contract.contract_hash = digestValue(outcomeContractDefinitionMaterial(contract));
  data.outcomeContracts ||= [];
  data.outcomeContracts.push(contract);
  return contract;
}

export function settleOutcomeContract(contract, body, actor, settledAt = nowIso(), idempotencyKey = null) {
  assertContractIntegrity(contract);
  const requestDigest = digestValue(body || {});
  const existing = idempotencyKey
    ? (contract.settlements || []).find((settlement) => settlement.idempotency_key === idempotencyKey)
    : null;
  if (existing) {
    if (existing.request_digest !== requestDigest || existing.supersedes_settlement_id) {
      throwOutcome(409, "Idempotency-Key was already used with a different settlement.");
    }
    return contract;
  }
  if (contract.status !== "pending") {
    throwOutcome(409, "Only pending Outcome Contracts can be settled.");
  }
  assertResolutionDue(contract, settledAt);
  const actualValue = normalizeActualValue(body?.actual_value, contract);
  const source = normalizeSettlementSource(body?.source || {});
  assertResolverMatch(contract.resolver, source, "Settlement");
  const resolverPrincipal = matchingResolverPrincipal(actor, contract.resolver, contract.workspace_id);
  const verifiedForRank = Boolean(resolverPrincipal);
  const participantScores = contract.participants.map((participant) =>
    scoreParticipant(participant, actualValue, contract, verifiedForRank ? 1 : 0)
  );
  const settlement = {
    settlement_id: makeId("settlement"),
    scoring_version: contract.scoring_version,
    idempotency_key: idempotencyKey,
    request_digest: requestDigest,
    actual_value: actualValue,
    source,
    notes: boundedText(body?.notes, 2000),
    settled_by: actor.user_id,
    verified_for_rank: verifiedForRank,
    verification_role: verifiedForRank ? "resolver_principal" : "tracking_only",
    resolver_principal: resolverPrincipal,
    settled_at: settledAt,
    participant_scores: participantScores
  };
  settlement.settlement_hash = digestValue(settlement);
  contract.status = "settled";
  contract.settlement = settlement;
  contract.settlements ||= [];
  contract.settlements.push(settlement);
  contract.settled_at = settledAt;
  appendContractEvent(contract, {
    event_type: "contract.settled",
    actor_id: actor.user_id,
    payload: {
      settlement_id: settlement.settlement_id,
      settlement_hash: settlement.settlement_hash,
      source_type: source.type
    },
    occurred_at: settledAt
  });
  return contract;
}

export function disputeOutcomeContract(contract, body, actor, disputedAt = nowIso()) {
  assertContractIntegrity(contract);
  if (contract.status !== "settled") {
    throwOutcome(409, "Only a settled Outcome Contract can be disputed.");
  }
  const dispute = {
    dispute_id: makeId("dispute"),
    settlement_id: contract.settlement.settlement_id,
    reason: requiredText(body?.reason, "reason", 2000),
    evidence_digest: body?.evidence_digest
      ? requiredDigest(body.evidence_digest, "evidence_digest")
      : null,
    disputed_by: actor.user_id,
    disputed_at: disputedAt
  };
  dispute.dispute_hash = digestValue(dispute);
  contract.disputes ||= [];
  contract.disputes.push(dispute);
  contract.status = "disputed";
  appendContractEvent(contract, {
    event_type: "contract.disputed",
    actor_id: actor.user_id,
    payload: {
      dispute_id: dispute.dispute_id,
      settlement_id: dispute.settlement_id,
      dispute_hash: dispute.dispute_hash
    },
    occurred_at: disputedAt
  });
  return contract;
}

export function correctOutcomeContract(contract, body, actor, correctedAt = nowIso(), idempotencyKey = null) {
  assertContractIntegrity(contract);
  if (!["settled", "disputed"].includes(contract.status) || !contract.settlement) {
    throwOutcome(409, "Only a settled or disputed Outcome Contract can be corrected.");
  }
  const requestDigest = digestValue(body || {});
  const existing = idempotencyKey
    ? (contract.settlements || []).find((settlement) => settlement.idempotency_key === idempotencyKey)
    : null;
  if (existing) {
    if (existing.request_digest !== requestDigest) {
      throwOutcome(409, "Idempotency-Key was already used with a different correction.");
    }
    return contract;
  }
  const supersedes = String(body?.supersedes_settlement_id || contract.settlement.settlement_id);
  if (supersedes !== contract.settlement.settlement_id) {
    throwOutcome(409, "Correction must supersede the current settlement.");
  }
  assertResolutionDue(contract, correctedAt);
  const actualValue = normalizeActualValue(body?.actual_value, contract);
  const source = normalizeSettlementSource(body?.source || {});
  assertResolverMatch(contract.resolver, source, "Correction");
  const resolverPrincipal = matchingResolverPrincipal(actor, contract.resolver, contract.workspace_id);
  const verifiedForRank = Boolean(resolverPrincipal);
  const settlement = {
    settlement_id: makeId("settlement"),
    scoring_version: contract.scoring_version,
    idempotency_key: idempotencyKey,
    request_digest: requestDigest,
    supersedes_settlement_id: supersedes,
    correction_reason: requiredText(body?.reason, "reason", 2000),
    actual_value: actualValue,
    source,
    notes: boundedText(body?.notes, 2000),
    settled_by: actor.user_id,
    verified_for_rank: verifiedForRank,
    verification_role: verifiedForRank ? "resolver_principal" : "tracking_only",
    resolver_principal: resolverPrincipal,
    settled_at: correctedAt,
    participant_scores: contract.participants.map((participant) =>
      scoreParticipant(participant, actualValue, contract, verifiedForRank ? 1 : 0)
    )
  };
  settlement.settlement_hash = digestValue(settlement);
  contract.settlements ||= [contract.settlement];
  contract.settlements.push(settlement);
  contract.settlement = settlement;
  contract.status = "settled";
  contract.settled_at = correctedAt;
  appendContractEvent(contract, {
    event_type: "contract.corrected",
    actor_id: actor.user_id,
    payload: {
      settlement_id: settlement.settlement_id,
      supersedes_settlement_id: supersedes,
      settlement_hash: settlement.settlement_hash
    },
    occurred_at: correctedAt
  });
  return contract;
}

export function realityRankForAgent(data, {
  agent,
  workspaceId,
  domain = null,
  taskType = null,
  now = Date.now()
}) {
  const currentRevision = agentRevision(agent);
  const settled = visibleSettledContracts(data, workspaceId, domain, taskType);
  const allScores = settled.flatMap((contract) =>
    contract.settlement.participant_scores
      .filter((score) => score.agent_id === agent.id)
      .map((score) => ({ ...score, contract }))
  );
  const currentScores = allScores.filter((entry) => entry.agent_revision === currentRevision);
  const current = rankSummary(currentScores, now);
  const minimumVerifiedSamples = realityRankMinVerifiedSamples();
  const versions = new Map();
  for (const entry of allScores) {
    const list = versions.get(entry.agent_revision) || [];
    list.push(entry);
    versions.set(entry.agent_revision, list);
  }
  return {
    agent_id: agent.id,
    agent_revision: currentRevision,
    domain: domain || null,
    task_type: taskType || null,
    score: current.score,
    sample_size: current.sample_size,
    effective_sample_size: current.effective_sample_size,
    average_utility: current.average_utility,
    calibration_error: current.calibration_error,
    coverage: current.coverage,
    status: current.sample_size >= minimumVerifiedSamples ? "established" : "provisional",
    routing_eligible: current.sample_size >= minimumVerifiedSamples,
    minimum_verified_samples: minimumVerifiedSamples,
    algorithm: "bayesian-decayed-utility-v1",
    routing_use: "capability_tie_breaker_only",
    versions: [...versions.entries()].map(([revision, entries]) => ({
      agent_revision: revision,
      ...rankSummary(entries, now)
    })).sort((left, right) => right.sample_size - left.sample_size)
  };
}

export function realityRankMap(data, {
  agents = [],
  workspaceId,
  query = "",
  now = Date.now()
}) {
  const rankEligibleContracts = (data.outcomeContracts || []).filter((contract) => {
    const execution = (data.executionRecords || []).find((record) => record.execution_id === contract.execution_id) || null;
    return contract.status === "settled"
      && contract.settlement?.verified_for_rank === true
      && verifyOutcomeContract(contract, execution).valid;
  });
  const domain = bestMatchingDomain(rankEligibleContracts, workspaceId, query);
  return Object.fromEntries(agents.map((agent) => {
    const rank = realityRankForAgent(data, { agent, workspaceId, domain, now });
    const score = rank.score / 100;
    return [agent.id, {
      score,
      routing_score: rank.routing_eligible ? score : RANK_PRIOR_MEAN,
      routing_eligible: rank.routing_eligible,
      minimum_verified_samples: rank.minimum_verified_samples,
      sample_size: rank.sample_size,
      agent_revision: rank.agent_revision,
      domain
    }];
  }));
}

export function verifyEventChain(events = []) {
  let previous = null;
  for (const event of events) {
    const { event_hash: supplied, ...unsigned } = event;
    if (unsigned.previous_event_hash !== previous || digestValue(unsigned) !== supplied) {
      return false;
    }
    previous = supplied;
  }
  return true;
}

export function verifyExecutionRecord(record = {}) {
  const { record_hash: supplied, ...unsigned } = record;
  return Boolean(supplied) && digestValue(unsigned) === supplied;
}

export function verifyOutcomeContract(contract = {}, executionRecord = undefined) {
  const settlements = Array.isArray(contract.settlements) ? contract.settlements : [];
  const disputes = Array.isArray(contract.disputes) ? contract.disputes : [];
  const events = Array.isArray(contract.events) ? contract.events : [];
  const contractDefinitionValid = Boolean(contract.contract_hash)
    && contract.contract_hash === digestValue(outcomeContractDefinitionMaterial(contract));
  const settlementHashesValid = settlements.every((settlement) => {
    const { settlement_hash: supplied, ...unsigned } = settlement || {};
    return Boolean(supplied) && digestValue(unsigned) === supplied;
  });
  const settlementRankAuthorizationsValid = settlements.every((settlement) =>
    verifySettlementRankAuthorization(settlement, contract)
  );
  const settlementChainValid = verifySettlementChain(settlements, contract.settlement);
  const disputeHashesValid = disputes.every((dispute) => {
    const { dispute_hash: supplied, ...unsigned } = dispute || {};
    return Boolean(supplied) && digestValue(unsigned) === supplied;
  });
  const eventChainValid = verifyEventChain(events);
  const eventBindingsValid = verifyContractEventBindings(contract, settlements, disputes, events);
  const stateValid = verifyContractState(contract, settlements, disputes);
  const executionRecordValid = executionRecord === undefined
    ? null
    : Boolean(
      executionRecord
      && verifyExecutionRecord(executionRecord)
      && executionRecord.record_hash === contract.execution_record_hash
      && executionRecord.execution_id === contract.execution_id
      && executionRecord.run_id === contract.run_id
      && executionRecord.session_id === contract.session_id
      && String(executionRecord.workspace_id || "") === String(contract.workspace_id || "")
    );
  const checks = [
    contractDefinitionValid,
    settlementHashesValid,
    settlementRankAuthorizationsValid,
    settlementChainValid,
    disputeHashesValid,
    eventChainValid,
    eventBindingsValid,
    stateValid
  ];
  if (executionRecordValid !== null) checks.push(executionRecordValid);
  return {
    valid: checks.every(Boolean),
    contract_definition_valid: contractDefinitionValid,
    settlement_hashes_valid: settlementHashesValid,
    settlement_rank_authorizations_valid: settlementRankAuthorizationsValid,
    settlement_chain_valid: settlementChainValid,
    dispute_hashes_valid: disputeHashesValid,
    event_chain_valid: eventChainValid,
    event_bindings_valid: eventBindingsValid,
    state_valid: stateValid,
    execution_record_valid: executionRecordValid
  };
}

export function outcomeContractDefinitionMaterial(contract = {}) {
  return {
    contract_id: contract.contract_id,
    schema_version: contract.schema_version,
    scoring_version: contract.scoring_version,
    execution_id: contract.execution_id,
    run_id: contract.run_id,
    session_id: contract.session_id,
    workspace_id: contract.workspace_id,
    created_by: contract.created_by,
    visibility: contract.visibility,
    idempotency_key: contract.idempotency_key,
    request_digest: contract.request_digest,
    title: contract.title,
    claim: contract.claim,
    domain: contract.domain,
    task_type: contract.task_type,
    outcome_type: contract.outcome_type,
    resolver: contract.resolver,
    resolution: contract.resolution,
    participants: contract.participants,
    evidence_ids: contract.evidence_ids,
    execution_record_hash: contract.execution_record_hash,
    created_at: contract.created_at
  };
}

function verifySettlementChain(settlements, currentSettlement) {
  const seen = new Set();
  let previousId = null;
  for (const [index, settlement] of settlements.entries()) {
    if (!settlement?.settlement_id || seen.has(settlement.settlement_id)) return false;
    seen.add(settlement.settlement_id);
    if (index === 0) {
      if (settlement.supersedes_settlement_id) return false;
    } else if (settlement.supersedes_settlement_id !== previousId) {
      return false;
    }
    previousId = settlement.settlement_id;
  }
  if (settlements.length === 0) return currentSettlement === null;
  const latest = settlements.at(-1);
  if (!currentSettlement || canonicalJson(currentSettlement) !== canonicalJson(latest)) return false;
  const { settlement_hash: supplied, ...unsigned } = currentSettlement;
  return Boolean(supplied) && digestValue(unsigned) === supplied;
}

function verifyContractEventBindings(contract, settlements, disputes, events) {
  const created = events.filter((event) => event.event_type === "contract.created");
  const settlementEvents = events.filter((event) =>
    event.event_type === "contract.settled" || event.event_type === "contract.corrected"
  );
  const disputeEvents = events.filter((event) => event.event_type === "contract.disputed");
  const knownTypes = new Set(["contract.created", "contract.settled", "contract.corrected", "contract.disputed"]);
  if (
    created.length !== 1
    || settlementEvents.length !== settlements.length
    || disputeEvents.length !== disputes.length
    || events.some((event) => !knownTypes.has(event.event_type))
  ) {
    return false;
  }
  const expectedRevisions = (contract.participants || []).map((participant) => ({
    agent_id: participant.agent_id,
    agent_revision: participant.agent_revision
  }));
  if (
    created[0].actor_id !== contract.created_by
    || created[0].occurred_at !== contract.created_at
    || created[0].payload?.execution_id !== contract.execution_id
    || digestValue(created[0].payload?.participant_revisions || []) !== digestValue(expectedRevisions)
  ) {
    return false;
  }
  for (const [index, settlement] of settlements.entries()) {
    const event = settlementEvents.find((candidate) => candidate.payload?.settlement_id === settlement.settlement_id);
    const expectedType = index === 0 ? "contract.settled" : "contract.corrected";
    if (
      !event
      || event.event_type !== expectedType
      || event.actor_id !== settlement.settled_by
      || event.occurred_at !== settlement.settled_at
      || event.payload?.settlement_hash !== settlement.settlement_hash
      || event.payload?.source_type !== (expectedType === "contract.settled" ? settlement.source?.type : undefined)
      || event.payload?.supersedes_settlement_id !== (
        expectedType === "contract.corrected" ? settlement.supersedes_settlement_id : undefined
      )
    ) {
      return false;
    }
  }
  for (const dispute of disputes) {
    const event = disputeEvents.find((candidate) => candidate.payload?.dispute_id === dispute.dispute_id);
    if (
      !event
      || event.actor_id !== dispute.disputed_by
      || event.occurred_at !== dispute.disputed_at
      || event.payload?.settlement_id !== dispute.settlement_id
      || event.payload?.dispute_hash !== dispute.dispute_hash
    ) {
      return false;
    }
  }
  return true;
}

function verifyContractState(contract, settlements, disputes) {
  if (contract.status === "pending") {
    return settlements.length === 0
      && disputes.length === 0
      && contract.settlement === null
      && contract.settled_at === null;
  }
  if (!["settled", "disputed"].includes(contract.status) || settlements.length === 0 || !contract.settlement) {
    return false;
  }
  if (contract.settled_at !== contract.settlement.settled_at) return false;
  if (contract.status === "disputed") {
    return disputes.some((dispute) => dispute.settlement_id === contract.settlement.settlement_id);
  }
  return true;
}

function assertContractIntegrity(contract) {
  if (!verifyOutcomeContract(contract).valid) {
    throwOutcome(409, "Outcome Contract failed integrity verification.");
  }
}

function appendContractEvent(contract, { event_type, actor_id, payload, occurred_at }) {
  const previous = contract.events.at(-1)?.event_hash || null;
  const event = {
    event_id: makeId("outcome_event"),
    schema_version: "virenis-outcome-event-v1",
    event_type,
    actor_id,
    occurred_at,
    payload,
    previous_event_hash: previous
  };
  event.event_hash = digestValue(event);
  contract.events.push(event);
  return event;
}

function normalizePredictions(value, outcomeType, executionParticipants, runSteps) {
  if (!Array.isArray(value) || value.length === 0) {
    throwOutcome(400, "predictions must contain at least one executed participant.");
  }
  const byStep = new Map(executionParticipants.map((participant) => [participant.step_id, participant]));
  const byAgent = new Map(executionParticipants.map((participant) => [participant.agent_id, participant]));
  const outputsByStep = new Map(runSteps.map((step) => [step.step_id, step]));
  const seen = new Set();
  return value.map((prediction, index) => {
    if (!prediction || typeof prediction !== "object" || Array.isArray(prediction)) {
      throwOutcome(400, `prediction ${index + 1} must be an object.`);
    }
    const executed = byStep.get(String(prediction.step_id || "")) || byAgent.get(String(prediction.agent_id || ""));
    if (!executed || seen.has(executed.step_id)) {
      throwOutcome(400, `prediction ${index + 1} must reference one unique executed step.`);
    }
    seen.add(executed.step_id);
    const abstained = prediction.abstained === true;
    const predictionValue = abstained ? null : normalizePredictionValue(prediction.value, outcomeType, index);
    const output = outputsByStep.get(executed.step_id);
    const evidenceQuote = abstained ? "" : requiredText(
      prediction.evidence_quote,
      `prediction ${index + 1} evidence_quote`,
      500
    );
    if (!abstained) {
      validatePredictionEvidence(evidenceQuote, predictionValue, outcomeType, output, index);
    }
    return {
      step_id: executed.step_id,
      agent_id: executed.agent_id,
      agent_revision: executed.agent_revision,
      prediction: predictionValue,
      confidence: abstained ? 0 : probability(prediction.confidence, "prediction confidence", 0.5),
      abstained,
      prediction_evidence_digest: abstained ? null : digestValue({
        output_digest: executed.output_digest,
        evidence_quote: evidenceQuote
      }),
      rationale_digest: digestValue(boundedText(prediction.rationale, 2000))
    };
  });
}

function validatePredictionEvidence(quote, prediction, outcomeType, output, index) {
  if (!output) {
    throwOutcome(409, `prediction ${index + 1} route output is unavailable.`);
  }
  const outputText = [
    output.domain_answer || "",
    output.handoffs || "",
    ...(output.handoff_artifacts || []).map((artifact) => JSON.stringify(artifact?.value ?? ""))
  ].join("\n").toLowerCase();
  const normalizedQuote = quote.toLowerCase();
  if (!outputText.includes(normalizedQuote)) {
    throwOutcome(400, `prediction ${index + 1} evidence_quote was not found in that agent's recorded output.`);
  }
  const valuePresent = outcomeType === "categorical"
    ? containsBoundedText(normalizedQuote, String(prediction).toLowerCase())
    : containsNumericPrediction(normalizedQuote, prediction, outcomeType === "binary");
  if (!valuePresent) {
    throwOutcome(400, `prediction ${index + 1} evidence_quote does not contain its claimed value.`);
  }
}

function containsNumericPrediction(text, expected, allowPercent) {
  const numberToken = /(^|[^\p{L}\p{N}_])([-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?%?)(?=$|[^\p{L}\p{N}_])/giu;
  for (const match of text.matchAll(numberToken)) {
    const token = match[2];
    const percent = token.endsWith("%");
    if (percent && !allowPercent) continue;
    const parsed = Number(percent ? token.slice(0, -1) : token);
    const candidate = percent ? parsed / 100 : parsed;
    const tolerance = Number.EPSILON * Math.max(1, Math.abs(Number(expected)));
    if (Number.isFinite(candidate) && Math.abs(candidate - Number(expected)) <= tolerance) return true;
  }
  return false;
}

function containsBoundedText(text, expected) {
  if (!expected) return false;
  const escaped = expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\p{L}\\p{N}_])${escaped}(?=$|[^\\p{L}\\p{N}_])`, "iu").test(text);
}

function normalizePredictionValue(value, outcomeType, index) {
  if (outcomeType === "binary") {
    return probability(value, `prediction ${index + 1} value`);
  }
  if (outcomeType === "numeric") {
    return finiteNumber(value, `prediction ${index + 1} value`);
  }
  return requiredText(value, `prediction ${index + 1} value`, 200);
}

function normalizeResolution(value, outcomeType, createdAt) {
  const dueAt = requiredFutureIsoDate(value.due_at, "resolution.due_at", createdAt);
  const normalized = {
    metric: requiredText(value.metric, "resolution.metric", 160),
    unit: boundedText(value.unit, 80) || null,
    due_at: dueAt
  };
  if (outcomeType === "numeric") {
    normalized.error_scale = positiveNumber(value.error_scale, "resolution.error_scale");
  }
  if (outcomeType === "categorical" && value.allowed_values !== undefined) {
    if (!Array.isArray(value.allowed_values) || value.allowed_values.length < 2 || value.allowed_values.length > 100) {
      throwOutcome(400, "resolution.allowed_values must contain 2 to 100 categories.");
    }
    normalized.allowed_values = [...new Set(value.allowed_values.map((item) => requiredText(item, "allowed category", 200)))];
  }
  return normalized;
}

function normalizeResolver(value) {
  const type = String(value.type || "human").toLowerCase().trim();
  if (!RESOLVER_TYPES.has(type)) {
    throwOutcome(400, "resolver.type must be human, api, or document.");
  }
  return {
    type,
    authority: requiredText(value.authority, "resolver.authority", 240),
    reference: requiredText(value.reference, "resolver.reference", 1000)
  };
}

function normalizeSettlementSource(value) {
  const type = String(value.type || "").toLowerCase().trim();
  if (!RESOLVER_TYPES.has(type)) {
    throwOutcome(400, "source.type must be human, api, or document.");
  }
  return {
    type,
    authority: requiredText(value.authority, "source.authority", 240),
    reference: requiredText(value.reference, "source.reference", 1000),
    evidence_digest: value.evidence_digest ? requiredDigest(value.evidence_digest, "source.evidence_digest") : null
  };
}

function assertResolverMatch(resolver, source, operation) {
  if (
    source.type !== resolver.type
    || source.authority !== resolver.authority
    || source.reference !== resolver.reference
  ) {
    throwOutcome(400, `${operation} source must exactly match the frozen contract resolver.`);
  }
}

function matchingResolverPrincipal(actor, resolver, workspaceId) {
  const principalId = String(actor?.user_id || "").trim();
  const principalWorkspace = String(actor?.workspace_id || "").trim();
  if (
    actor?.role !== "admin"
    || actor?.auth_type !== "bearer"
    || !Array.isArray(actor?.resolver_bindings)
    || !principalId
    || !principalWorkspace
    || principalWorkspace !== String(workspaceId || "")
  ) {
    return null;
  }
  for (const binding of actor.resolver_bindings) {
    if (
      binding?.type !== resolver.type
      || binding?.authority !== resolver.authority
    ) {
      continue;
    }
    if (
      typeof binding.reference === "string"
      && binding.reference.length <= 1000
      && binding.reference === resolver.reference
    ) {
      return {
        schema_version: "virenis-resolver-principal-v1",
        principal_id: principalId,
        workspace_id: principalWorkspace,
        auth_type: "bearer",
        type: binding.type,
        authority: binding.authority,
        reference_match: "exact",
        reference: binding.reference
      };
    }
    if (
      typeof binding.reference_prefix === "string"
      && binding.reference_prefix.length >= 8
      && binding.reference_prefix.length <= 1000
      && resolver.reference.startsWith(binding.reference_prefix)
    ) {
      return {
        schema_version: "virenis-resolver-principal-v1",
        principal_id: principalId,
        workspace_id: principalWorkspace,
        auth_type: "bearer",
        type: binding.type,
        authority: binding.authority,
        reference_match: "prefix",
        reference_prefix: binding.reference_prefix
      };
    }
  }
  return null;
}

function verifySettlementRankAuthorization(settlement, contract) {
  const scores = Array.isArray(settlement?.participant_scores) ? settlement.participant_scores : [];
  if (
    settlement?.source?.type !== contract?.resolver?.type
    || settlement?.source?.authority !== contract?.resolver?.authority
    || settlement?.source?.reference !== contract?.resolver?.reference
  ) {
    return false;
  }
  if (settlement?.verified_for_rank !== true) {
    return settlement?.verification_role === "tracking_only"
      && (settlement?.resolver_principal === null || settlement?.resolver_principal === undefined)
      && scores.length > 0
      && scores.every((score) => score?.rank_weight === 0 && score?.trust_weight === 0);
  }
  const principal = settlement.resolver_principal;
  if (
    settlement.verification_role !== "resolver_principal"
    || !principal
    || principal.schema_version !== "virenis-resolver-principal-v1"
    || principal.principal_id !== settlement.settled_by
    || principal.workspace_id !== contract?.workspace_id
    || principal.auth_type !== "bearer"
    || principal.type !== settlement.source?.type
    || principal.authority !== settlement.source?.authority
  ) {
    return false;
  }
  const referenceMatches = principal.reference_match === "exact"
    ? principal.reference === settlement.source.reference
    : principal.reference_match === "prefix"
      && typeof principal.reference_prefix === "string"
      && principal.reference_prefix.length >= 8
      && principal.reference_prefix.length <= 1000
      && settlement.source.reference.startsWith(principal.reference_prefix);
  return Boolean(referenceMatches) && scores.length > 0 && scores.every((score) =>
    score?.trust_weight === 1 && score?.rank_weight === (score?.abstained === true ? 0 : 1)
  );
}

function assertResolutionDue(contract, observedAt) {
  const dueAt = Date.parse(contract.resolution?.due_at || "");
  const observed = Date.parse(observedAt);
  if (!Number.isFinite(dueAt) || !Number.isFinite(observed) || observed < dueAt) {
    throwOutcome(409, "Outcome Contract cannot be settled or corrected before resolution.due_at.");
  }
}

function normalizeActualValue(value, contract) {
  if (contract.outcome_type === "binary") {
    if (value === true || value === 1 || value === "1" || value === "true") return 1;
    if (value === false || value === 0 || value === "0" || value === "false") return 0;
    throwOutcome(400, "actual_value must be boolean for a binary contract.");
  }
  if (contract.outcome_type === "numeric") {
    return finiteNumber(value, "actual_value");
  }
  const category = requiredText(value, "actual_value", 200);
  if (contract.resolution.allowed_values && !contract.resolution.allowed_values.includes(category)) {
    throwOutcome(400, "actual_value is not in resolution.allowed_values.");
  }
  return category;
}

function scoreParticipant(participant, actualValue, contract, trustWeight = 1) {
  if (participant.abstained) {
    return {
      step_id: participant.step_id,
      agent_id: participant.agent_id,
      agent_revision: participant.agent_revision,
      utility: 0.5,
      calibration_error: null,
      rank_weight: 0,
      trust_weight: trustWeight,
      abstained: true
    };
  }
  let accuracy;
  let correct = null;
  if (contract.outcome_type === "binary") {
    accuracy = 1 - ((participant.prediction - actualValue) ** 2);
    correct = (participant.prediction >= 0.5 ? 1 : 0) === actualValue;
  } else if (contract.outcome_type === "numeric") {
    const error = Math.abs(participant.prediction - actualValue);
    accuracy = Math.max(0, 1 - (error / contract.resolution.error_scale));
    correct = error <= contract.resolution.error_scale;
  } else {
    correct = participant.prediction === actualValue;
    accuracy = correct ? 1 : 0;
  }
  const confidenceTarget = correct ? 1 : 0;
  const calibrationError = Math.abs(participant.confidence - confidenceTarget);
  const utility = contract.outcome_type === "binary"
    ? accuracy
    : (0.8 * accuracy) + (0.2 * (1 - calibrationError));
  return {
    step_id: participant.step_id,
    agent_id: participant.agent_id,
    agent_revision: participant.agent_revision,
    utility: roundProbability(utility),
    accuracy: roundProbability(accuracy),
    calibration_error: roundProbability(calibrationError),
    rank_weight: trustWeight,
    trust_weight: trustWeight,
    abstained: false
  };
}

function visibleSettledContracts(data, workspaceId, domain, taskType) {
  return (data.outcomeContracts || []).filter((contract) =>
    contract.status === "settled"
    && String(contract.workspace_id || "") === String(workspaceId || "")
    && (!domain || contract.domain === domain)
    && (!taskType || contract.task_type === taskType)
  ).filter((contract) => {
    const execution = (data.executionRecords || []).find((record) => record.execution_id === contract.execution_id) || null;
    return contract.settlement?.verified_for_rank === true
      && verifyOutcomeContract(contract, execution).valid;
  });
}

function rankSummary(entries, now) {
  let posteriorAlpha = RANK_PRIOR_MEAN * RANK_PRIOR_WEIGHT;
  let posteriorBeta = (1 - RANK_PRIOR_MEAN) * RANK_PRIOR_WEIGHT;
  let observedWeight = 0;
  let calibrationTotal = 0;
  let calibrationWeight = 0;
  let covered = 0;
  for (const entry of entries) {
    if (entry.rank_weight <= 0) continue;
    const settledAt = Date.parse(entry.contract.settled_at || entry.contract.created_at);
    const ageDays = Number.isFinite(settledAt) ? Math.max(0, (now - settledAt) / 86_400_000) : 0;
    const recency = 2 ** (-ageDays / RANK_HALF_LIFE_DAYS);
    const weight = entry.rank_weight * recency;
    posteriorAlpha += entry.utility * weight;
    posteriorBeta += (1 - entry.utility) * weight;
    observedWeight += weight;
    covered += 1;
    if (entry.calibration_error !== null && entry.calibration_error !== undefined) {
      calibrationTotal += entry.calibration_error * weight;
      calibrationWeight += weight;
    }
  }
  const mean = posteriorAlpha / (posteriorAlpha + posteriorBeta);
  const variance = (posteriorAlpha * posteriorBeta)
    / (((posteriorAlpha + posteriorBeta) ** 2) * (posteriorAlpha + posteriorBeta + 1));
  const margin = 1.96 * Math.sqrt(variance);
  return {
    score: Number((mean * 100).toFixed(2)),
    credible_interval_95: [
      Number((Math.max(0, mean - margin) * 100).toFixed(2)),
      Number((Math.min(1, mean + margin) * 100).toFixed(2))
    ],
    sample_size: covered,
    effective_sample_size: Number(observedWeight.toFixed(3)),
    average_utility: covered ? Number(((posteriorAlpha - (RANK_PRIOR_MEAN * RANK_PRIOR_WEIGHT)) / observedWeight).toFixed(4)) : null,
    calibration_error: calibrationWeight ? Number((calibrationTotal / calibrationWeight).toFixed(4)) : null,
    coverage: entries.length ? Number((covered / entries.length).toFixed(4)) : null
  };
}

function bestMatchingDomain(contracts, workspaceId, query) {
  const lower = String(query || "").toLowerCase();
  const candidates = [...new Set(contracts
    .filter((contract) => contract.status === "settled" && String(contract.workspace_id || "") === String(workspaceId || ""))
    .map((contract) => contract.domain))];
  return candidates
    .map((domain) => ({
      domain,
      score: domain.split(/[_-]+/).filter((token) => token.length > 2 && lower.includes(token)).length
    }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score || left.domain.localeCompare(right.domain))[0]?.domain || null;
}

function bindingType(agent) {
  if (agent.document || agent.retrieval?.type === "document_markdown") return "document_agent";
  if (String(agent.adapter_path || "").includes("dummy_tcar_loras")) return "zero_lora_route";
  return agent.adapter_path ? "lora" : "prompt_agent";
}

function stableEvidenceId(citation) {
  if (!citation || typeof citation !== "object") return null;
  const contentDigest = normalizeSha256Digest(citation.content_digest);
  const corpusRevision = normalizeSha256Digest(citation.corpus_revision);
  const indexDigest = normalizeSha256Digest(citation.index_digest);
  if (citation.verified === true && citation.path?.includes("/chunks/") && (!contentDigest || !corpusRevision || !indexDigest)) {
    return null;
  }
  return digestValue({
    agent_id: citation.agent_id || null,
    chunk_id: citation.chunk_id || null,
    page_start: citation.page_start ?? null,
    page_end: citation.page_end ?? null,
    content_digest: contentDigest,
    corpus_revision: corpusRevision,
    index_digest: indexDigest,
    excerpt: citation.excerpt || ""
  });
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value === undefined ? null : value;
  return Object.fromEntries(
    Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => [key, canonicalValue(value[key])])
  );
}

function normalizedStrings(value) {
  return Array.isArray(value) ? value.map(String) : [];
}

function boundedAuditDetails(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).slice(0, 32).map(([key, item]) => [
    boundedText(key, 120),
    Array.isArray(item)
      ? item.slice(0, 64).map((entry) => boundedText(entry, 240))
      : typeof item === "object" && item !== null
        ? digestValue(item)
        : boundedText(item, 1000)
  ]));
}

function requiredText(value, name, limit) {
  const text = boundedText(value, limit);
  if (!text) throwOutcome(400, `${name} is required.`);
  return text;
}

function requiredSlug(value, name, limit) {
  const slug = String(value || "").trim().toLowerCase();
  if (!new RegExp(`^[a-z0-9][a-z0-9_-]{0,${limit - 1}}$`).test(slug)) {
    throwOutcome(400, `${name} must use lowercase letters, numbers, underscores, or hyphens.`);
  }
  return slug;
}

function boundedText(value, limit) {
  return String(value ?? "").replaceAll("\0", "").trim().slice(0, limit);
}

function finiteNumber(value, name) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throwOutcome(400, `${name} must be a finite number.`);
  return parsed;
}

function positiveNumber(value, name) {
  const parsed = finiteNumber(value, name);
  if (parsed <= 0) throwOutcome(400, `${name} must be greater than zero.`);
  return parsed;
}

function finiteNumberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function probability(value, name, fallback = null) {
  if ((value === undefined || value === null || value === "") && fallback !== null) return fallback;
  const parsed = finiteNumber(value, name);
  if (parsed < 0 || parsed > 1) throwOutcome(400, `${name} must be between 0 and 1.`);
  return Number(parsed.toFixed(4));
}

function finiteProbabilityOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? Number(parsed.toFixed(4)) : null;
}

function roundProbability(value) {
  return Number(Math.max(0, Math.min(1, value)).toFixed(4));
}

function requiredFutureIsoDate(value, name, after) {
  if (!value) throwOutcome(400, `${name} is required.`);
  const timestamp = Date.parse(value);
  const afterTimestamp = Date.parse(after);
  if (!Number.isFinite(timestamp)) throwOutcome(400, `${name} must be an ISO-8601 date.`);
  if (!Number.isFinite(afterTimestamp) || timestamp <= afterTimestamp) {
    throwOutcome(400, `${name} must be strictly later than contract creation.`);
  }
  return new Date(timestamp).toISOString();
}

function requiredDigest(value, name) {
  const digest = String(value || "").trim().toLowerCase();
  if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throwOutcome(400, `${name} must be a sha256 digest.`);
  return digest;
}

function throwOutcome(status, message) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

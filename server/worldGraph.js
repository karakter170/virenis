import crypto from "node:crypto";
import { assertStoredDocumentIntegrity } from "./documents.js";
import { agentRevision, normalizeSha256Digest } from "./outcomes.js";
import { runtimeApiKey } from "./runtimeClient.js";
import { makeId, nowIso } from "./store.js";

export const WORLD_GRAPH_SCHEMA_VERSION = "virenis-world-graph-v1";
export const WORLD_GRAPH_ENGINE_REVISION = "world-graph-engine-v2";

const WORLD_GRAPH_DIGEST_DOMAIN = "worldgraph-digest-v2\n";
const WORLD_GRAPH_CAPSULE_ENCODING = "json-utf8-exact-v1";
const WORLD_GRAPH_CAPSULE_SIGNATURE_DOMAIN = "worldgraph-reuse-envelope-v2\n";
const WORLD_GRAPH_ARTIFACT_MAC_DOMAIN = "worldgraph-artifact-record-v1\n";
const replayCapsulePayloads = new WeakMap();

const MAX_ARTIFACTS_PER_OWNER = 240;
const MAX_EVENTS_PER_OWNER = 500;
const MAX_REPLAY_BYTES = 128 * 1024;
const MAX_CAPSULE_BYTES = 2 * 1024 * 1024;
const STORAGE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const REMOTE_MAX_AGE_MS = 30 * 60 * 1000;
const VOLATILE_QUERY = /\b(?:current|currently|today|tonight|latest|live|real[- ]?time|right now|this (?:week|month|year)|weather|price|stock|score|breaking|recent)\b/i;
const VOLATILE_TOOLS = new Set([
  "web_search", "market_data", "earthquake_feed", "document_search", "document_read",
  "search_index", "policy_lookup", "news_search", "weather", "http_get", "url_fetch",
  "browser", "repo_inspector", "repo_search", "repo_read", "repo_diff", "repo_patch",
  "test_runner"
]);
// Availability of these tools is input-complete and deterministic. Their
// actual receipts are still never replayed in v1. Every unknown/dynamic tool
// is treated as mutable so a newly added integration fails closed by default.
const REPLAY_SAFE_TOOL_AVAILABILITY = new Set([
  "calculator", "finance_calculator", "math_solver", "data_table", "sql_runner",
  "document_search", "document_read", "search_index", "policy_lookup"
]);
const EFFECTFUL_TOOL = /^(?:mcp_|gmail|shopify|send_|delete_|create_|update_|publish_|purchase_|write_)/i;

function assertUnicodeScalarString(value) {
  const text = String(value);
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new TypeError("WorldGraph strings must contain valid Unicode scalar values.");
      }
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new TypeError("WorldGraph strings must contain valid Unicode scalar values.");
    }
  }
  return text;
}

function binary64Hex(value) {
  if (!Number.isFinite(value)) {
    throw new TypeError("WorldGraph numbers must be finite IEEE-754 binary64 values.");
  }
  const bytes = Buffer.allocUnsafe(8);
  bytes.writeDoubleBE(value === 0 ? 0 : value, 0);
  return bytes.toString("hex");
}

function utf8KeyCompare(left, right) {
  return Buffer.compare(
    Buffer.from(assertUnicodeScalarString(left), "utf8"),
    Buffer.from(assertUnicodeScalarString(right), "utf8")
  );
}

function worldGraphCanonicalValue(value) {
  if (value === null || value === undefined) return ["null"];
  if (typeof value === "boolean") return ["boolean", value ? "true" : "false"];
  if (typeof value === "string") return ["string", assertUnicodeScalarString(value)];
  if (typeof value === "number") return ["number_binary64", binary64Hex(value)];
  if (Array.isArray(value)) return ["array", value.map(worldGraphCanonicalValue)];
  if (typeof value === "object") {
    const entries = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort(utf8KeyCompare)
      .map((key) => [assertUnicodeScalarString(key), worldGraphCanonicalValue(value[key])]);
    return ["object", entries];
  }
  throw new TypeError(`WorldGraph value has unsupported type: ${typeof value}.`);
}

export function worldGraphCanonicalJson(value) {
  return JSON.stringify(worldGraphCanonicalValue(value));
}

export function worldGraphDigest(value) {
  return `sha256:${crypto.createHash("sha256")
    .update(WORLD_GRAPH_DIGEST_DOMAIN, "utf8")
    .update(worldGraphCanonicalJson(value), "utf8")
    .digest("hex")}`;
}

function normalizedStrings(value) {
  return Array.isArray(value)
    ? [...new Set(value.map((item) => String(item || "").trim()).filter(Boolean))].sort()
    : [];
}

function normalizedQuery(value) {
  // The persisted user message is already outer-trimmed. Preserve every
  // internal code point: indentation, line breaks, table spacing, and quoted
  // whitespace can all change the meaning of a request.
  return String(value || "");
}

function normalizedTask(value) {
  return String(value || "").replaceAll("\0", "");
}

function boundedText(value, maximum = 4000) {
  return String(value || "").replaceAll("\0", "").trim().slice(0, maximum);
}

function scopeFor({ run, session }) {
  return {
    workspace_id: String(run?.workspace_id || session?.workspace_id || ""),
    created_by: String(run?.created_by || session?.created_by || ""),
    session_id: String(run?.session_id || session?.session_id || ""),
    agent_workspace_id: String(run?.agent_workspace_id || session?.agent_workspace_id || "")
  };
}

function sameScope(artifact, scope) {
  return artifact.workspace_id === scope.workspace_id
    && artifact.created_by === scope.created_by
    && artifact.session_id === scope.session_id
    && artifact.agent_workspace_id === scope.agent_workspace_id;
}

function sourceStateForAgent(agent, documents) {
  const documentStates = (documents || [])
    .filter((document) => document.agent_id === agent?.id || document.resource_for_agent_id === agent?.id)
    .map((document) => ({
      corpus_revision: normalizeSha256Digest(document.corpus_revision),
      index_digest: normalizeSha256Digest(document.index_digest),
      enabled: document.enabled !== false,
      runtime_sync_pending: document.runtime_sync_pending === true,
      integrity: documentIntegrityState(document)
    }))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return {
    sources: normalizedStrings(agent?.sources),
    retrieval: agent?.retrieval || null,
    private_knowledge_digest: normalizeSha256Digest(agent?.private_knowledge_digest)
      || (agent?.source_text_internal ? worldGraphDigest(agent.source_text_internal) : null),
    documents: documentStates
  };
}

function documentIntegrityState(document) {
  const committedDocument = Object.hasOwn(document || {}, "runtime_managed")
    || Object.hasOwn(document || {}, "chunks");
  if (!committedDocument) return "metadata_only";
  try {
    assertStoredDocumentIntegrity(document);
    return "verified";
  } catch {
    return "failed";
  }
}

function sourceStateReplayable(agent, documents) {
  const state = sourceStateForAgent(agent, documents);
  const staticSourcesAreBound = state.sources.length === 0
    || Boolean(state.private_knowledge_digest)
    || state.documents.length > 0;
  return staticSourcesAreBound && state.documents.every((document) => (
    (
      document.integrity === "verified"
      || (
        document.integrity === "metadata_only"
        && Boolean(document.corpus_revision)
        && Boolean(document.index_digest)
      )
    )
    && document.enabled === true
    && document.runtime_sync_pending === false
  ));
}

function routeOptionState(options = {}) {
  return {
    max_tokens: Number(options.max_tokens) || null,
    refiner_max_tokens: Number(options.refiner_max_tokens) || null,
    temperature: Number(options.temperature) || 0,
    runtime_mode: String(process.env.TCAR_ENGINE_MODE || "simulator"),
    worker_model: String(process.env.VLLM_BASE_MODEL || ""),
    worker_model_revision: String(process.env.VLLM_MODEL_REVISION || process.env.TCAR_MODEL_REVISION || ""),
    provider: String(process.env.TCAR_SESSION_PROVIDER || ""),
    provider_model: String(process.env.TCAR_SESSION_MODEL || ""),
    provider_model_revision: String(process.env.TCAR_SESSION_MODEL_REVISION || "")
  };
}

function normalizedRuntimeComponentState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const baseModelContentDigest = normalizeSha256Digest(value.base_model_content_digest || value.baseModelContentDigest);
  const executorCodeDigest = normalizeSha256Digest(value.executor_code_digest || value.executorCodeDigest);
  const workerExecutionConfigDigest = normalizeSha256Digest(
    value.worker_execution_config_digest || value.workerExecutionConfigDigest
  );
  if (!baseModelContentDigest || !executorCodeDigest || !workerExecutionConfigDigest) return null;
  return {
    revision_authority: "runtime",
    base_model_id: boundedText(value.base_model_id || value.baseModel || "", 300),
    base_model_content_digest: baseModelContentDigest,
    executor_code_digest: executorCodeDigest,
    worker_execution_config_digest: workerExecutionConfigDigest
  };
}

function memoryState(agent, sharedMemory) {
  const consumes = new Set(normalizedStrings(agent?.consumes));
  if (!consumes.has("shared_memory") && !consumes.has("conversation_context")) {
    return null;
  }
  return (Array.isArray(sharedMemory) ? sharedMemory : []).map((entry) => ({
    tag: boundedText(entry?.tag || "memory", 120),
    source: boundedText(entry?.source || "application", 120),
    content: boundedText(entry?.content, 2000)
  }));
}

function dependencyState(step, outputsByStep) {
  return normalizedStrings(step?.depends_on).map((stepId) => {
    const output = outputsByStep.get(stepId);
    const valid = validRouteOutput(output);
    return {
      step_id: stepId,
      adapter: output?.adapter || null,
      output_digest: valid
        ? output.world_graph_output_digest || outputDigest(output)
        : worldGraphDigest({ invalid_dependency: stepId, observed_output: outputDigest(output) })
    };
  });
}

function effectPolicy({ query, agent, output = null }) {
  const allowedTools = normalizedStrings(agent?.tools || output?.allowed_tools);
  const executions = Array.isArray(output?.tool_executions) ? output.tool_executions : [];
  const executedNames = executions.map((item) => String(item?.name || "")).filter(Boolean);
  const reasons = [];
  const agentIdentity = [agent?.id, agent?.title, ...(agent?.routing_cues || [])].join(" ").toLowerCase();
  const volatileSubject = String(query || "").toLowerCase().match(/\b(weather|price|stock|score|news|current|latest|live|recent)\b/)?.[1];
  if (
    VOLATILE_QUERY.test(query)
    && (allowedTools.some((tool) => VOLATILE_TOOLS.has(tool)) || (volatileSubject && agentIdentity.includes(volatileSubject)))
  ) reasons.push("time_sensitive_request");
  if (allowedTools.some((tool) => !REPLAY_SAFE_TOOL_AVAILABILITY.has(tool))) reasons.push("live_or_mutable_tool_available");
  if (executedNames.some((tool) => VOLATILE_TOOLS.has(tool))) reasons.push("live_or_mutable_tool_used");
  if (executedNames.some((tool) => EFFECTFUL_TOOL.test(tool))) reasons.push("external_or_effectful_tool_used");
  if (executions.some((execution) => execution?.result?.approval_required === true)) reasons.push("approval_bound_action");
  if (executions.length && !reasons.includes("tool_result_requires_fresh_execution")) {
    // V1 intentionally does not replay even deterministic tool receipts. A
    // future revision may opt specific tools in after binding implementation,
    // arguments, and output digests at both the web and runtime boundaries.
    reasons.push("tool_result_requires_fresh_execution");
  }
  return {
    class: reasons.some((reason) => reason.includes("effectful") || reason.includes("approval"))
      ? "effectful"
      : reasons.length ? "volatile" : "pure",
    replayable: reasons.length === 0,
    reasons
  };
}

function replayPolicy({ query, agent, output = null, documents = [] }) {
  const policy = effectPolicy({ query, agent, output });
  if (!sourceStateReplayable(agent, documents)) {
    policy.class = "volatile";
    policy.replayable = false;
    policy.reasons = [...new Set([...policy.reasons, "source_changed_or_unverifiable"])];
  }
  return policy;
}

function outputDigest(output = {}) {
  return worldGraphDigest({
    adapter: output.adapter || "",
    domain_answer: output.domain_answer || "",
    handoff_artifacts: output.handoff_artifacts || [],
    citations: output.citations || [],
    policy_violations: output.policy_violations || [],
    artifact_validation: output.artifact_validation || {},
    consumption_validation: output.consumption_validation || {},
    source_validation: output.source_validation || { valid: true, violations: [] }
  });
}

function replayOutput(output = {}) {
  const safeToolReceipts = (Array.isArray(output.tool_executions) ? output.tool_executions : []).map((execution) => ({
    id: boundedText(execution?.id, 120),
    name: boundedText(execution?.name, 120),
    result: {
      ok: execution?.result?.ok === true,
      available: execution?.result?.available !== false,
      tool: boundedText(execution?.result?.tool || execution?.name, 120),
      data_digest: execution?.result?.data === undefined ? null : worldGraphDigest(execution.result.data)
    },
    arguments_redacted: true,
    result_data_redacted: true
  }));
  const safe = {
    id: output.id || output.step_id,
    step_id: output.step_id || output.id,
    adapter: output.adapter,
    task: output.task || "",
    depends_on: output.depends_on || [],
    used_upstream: output.used_upstream || [],
    used_memory: output.used_memory || [],
    policy_violations: output.policy_violations || [],
    knowledge_mode: output.knowledge_mode,
    missing_data_policy: output.missing_data_policy,
    constraint_mode: output.constraint_mode,
    allowed_tools: output.allowed_tools || [],
    tool_executions: safeToolReceipts,
    approved_sources: output.approved_sources || [],
    retrieved_context: output.retrieved_context || "",
    citations: output.citations || [],
    source_validation: output.source_validation || { valid: true, violations: [] },
    handoff_artifacts: output.handoff_artifacts || [],
    artifact_validation: output.artifact_validation || {},
    consumed_artifacts: output.consumed_artifacts || [],
    consumption_validation: output.consumption_validation || {},
    text: output.domain_answer ? `DOMAIN_ANSWER:\n${output.domain_answer}` : "",
    domain_answer: output.domain_answer || "",
    boundary_check: output.boundary_check || "",
    agent_revision: normalizeSha256Digest(output.agent_revision),
    agent_content_digest: normalizeSha256Digest(output.agent_content_digest || output.adapter_digest),
    adapter_content_digest: normalizeSha256Digest(output.adapter_content_digest || output.adapter_digest),
    manifest_contract_digest: normalizeSha256Digest(output.manifest_contract_digest),
    model_id: output.model_id || output.vllmModel || null,
    vllmModel: output.vllmModel || output.model_id || null,
    output_contract: output.output_contract || null
  };
  if (Buffer.byteLength(JSON.stringify(safe), "utf8") > MAX_REPLAY_BYTES) return null;
  return safe;
}

function replayPayloadDigest(output = {}) {
  const safe = replayOutput(output);
  if (!safe) return null;
  const {
    id: _id,
    step_id: _stepId,
    task: _task,
    depends_on: _dependsOn,
    ...stable
  } = safe;
  return worldGraphDigest(stable);
}

function validRouteOutput(output) {
  return Boolean(
    output
    && output.adapter
    && output.domain_answer
    && !(output.policy_violations || []).length
    && output.artifact_validation?.valid !== false
    && output.consumption_validation?.valid !== false
    && output.source_validation?.valid !== false
  );
}

function inputEnvelope({ run, step, agent, documents, sharedMemory, options, outputsByStep, runtimeComponentProvenance = null }) {
  const query = normalizedQuery(run?.query);
  const sourceState = sourceStateForAgent(agent, documents);
  const routeEffectPolicy = replayPolicy({ query, agent, documents });
  return {
    schema_version: WORLD_GRAPH_SCHEMA_VERSION,
    engine_revision: WORLD_GRAPH_ENGINE_REVISION,
    query_digest: worldGraphDigest(query),
    task_digest: worldGraphDigest(normalizedTask(step?.task)),
    adapter: String(step?.adapter || ""),
    agent_revision: agentRevision(agent || { id: step?.adapter || "" }),
    dependency_state: dependencyState(step, outputsByStep),
    memory_digest: memoryState(agent, sharedMemory) === null
      ? null
      : worldGraphDigest(memoryState(agent, sharedMemory)),
    source_state_digest: worldGraphDigest(sourceState),
    route_options_digest: worldGraphDigest(routeOptionState(options)),
    runtime_component_digest: normalizedRuntimeComponentState(runtimeComponentProvenance)
      ? worldGraphDigest(normalizedRuntimeComponentState(runtimeComponentProvenance))
      : null,
    effect_policy: routeEffectPolicy
  };
}

function envelopeDigest(envelope) {
  return worldGraphDigest(envelope);
}

function envelopeChangeReason(previous, current) {
  if (!previous || !current) return "no_matching_result";
  if (previous.query_digest !== current.query_digest) return "request_changed";
  if (previous.agent_revision !== current.agent_revision) return "agent_changed";
  if (previous.task_digest !== current.task_digest) return "task_changed";
  if (previous.source_state_digest !== current.source_state_digest) return "source_changed_or_unverifiable";
  if (previous.memory_digest !== current.memory_digest) return "conversation_context_changed";
  if (previous.route_options_digest !== current.route_options_digest) return "execution_settings_changed";
  if (previous.runtime_component_digest !== current.runtime_component_digest) return "runtime_revision_changed_or_unverified";
  if (worldGraphDigest(previous.dependency_state || []) !== worldGraphDigest(current.dependency_state || [])) {
    return "upstream_result_changed";
  }
  if (worldGraphDigest(previous.effect_policy || {}) !== worldGraphDigest(current.effect_policy || {})) {
    return current.effect_policy?.reasons?.[0]
      || previous.effect_policy?.reasons?.[0]
      || "result_requires_fresh_execution";
  }
  return "no_matching_result";
}

function artifactRecordHash(artifact) {
  const { record_hash: _recordHash, ...body } = artifact;
  const canonicalBody = worldGraphCanonicalJson(body);
  const signingKey = runtimeApiKey();
  if (String(signingKey).length >= 16) {
    return `hmac-sha256:${crypto.createHmac("sha256", String(signingKey))
      .update(WORLD_GRAPH_ARTIFACT_MAC_DOMAIN, "utf8")
      .update(canonicalBody, "utf8")
      .digest("hex")}`;
  }
  // Simulator/development mode remains self-verifying without provisioning a
  // secret. Production real-runtime startup already requires the shared key,
  // so persisted artifacts there are MAC-bound and a database-only writer
  // cannot forge them by recomputing an unkeyed checksum.
  return worldGraphDigest(body);
}

export function verifyWorldGraphArtifact(artifact) {
  return Boolean(
    artifact
    && artifact.schema_version === WORLD_GRAPH_SCHEMA_VERSION
    && artifact.input_envelope?.schema_version === WORLD_GRAPH_SCHEMA_VERSION
    && artifact.input_envelope?.engine_revision === WORLD_GRAPH_ENGINE_REVISION
    && artifact.record_hash === artifactRecordHash(artifact)
    && artifact.envelope_digest === envelopeDigest(artifact.input_envelope)
    && artifact.output_digest === outputDigest(artifact.replay_output)
  );
}

function contestedArtifactIds(data) {
  return new Set((data.worldGraphEvents || [])
    .filter((event) => event?.event_type === "result.contested")
    .flatMap((event) => Array.isArray(event.artifact_ids) ? event.artifact_ids : []));
}

function maxAgeFor(_options = {}) {
  return String(process.env.TCAR_ENGINE_MODE || "simulator").toLowerCase() === "real"
    ? REMOTE_MAX_AGE_MS
    : DEFAULT_MAX_AGE_MS;
}

function artifactAgeValid(artifact, nowMs, options) {
  // A reused copy must never renew the freshness lease. New artifacts carry
  // the timestamp of the last actual worker execution through every reuse
  // generation. Legacy artifacts fall back to their immutable creation time.
  const anchor = Object.hasOwn(artifact || {}, "freshness_anchor_at")
    ? artifact.freshness_anchor_at
    : artifact?.created_at;
  const refreshed = Date.parse(anchor || "");
  return Number.isFinite(refreshed) && nowMs - refreshed >= 0 && nowMs - refreshed <= maxAgeFor(options);
}

export function selectWorldGraphSeeds({
  data,
  run,
  session,
  plan,
  agents,
  documents,
  sharedMemory,
  options,
  runtimeComponentProvenance = null,
  runFresh = false,
  now = Date.now()
}) {
  const scope = scopeFor({ run, session });
  const agentsById = new Map((agents || []).map((agent) => [agent.id, agent]));
  const outputsByStep = new Map();
  const seeds = new Map();
  const decisions = [];
  const contested = contestedArtifactIds(data);
  const candidates = (data.worldGraphArtifacts || [])
    .filter((artifact) => sameScope(artifact, scope))
    .sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)));

  for (const step of plan?.steps || []) {
    const agent = agentsById.get(step.adapter) || { id: step.adapter };
    const envelope = inputEnvelope({
      run, session, step, agent, documents, sharedMemory, options, outputsByStep, runtimeComponentProvenance
    });
    const digest = envelopeDigest(envelope);
    let chosen = null;
    let reason = runFresh ? "fresh_run_requested" : "no_matching_result";
    let mismatchReason = null;
    if (!runFresh && envelope.effect_policy.replayable && Number(options?.temperature || 0) === 0) {
      for (const artifact of candidates) {
        if (artifact.adapter !== step.adapter) continue;
        if (!verifyWorldGraphArtifact(artifact)) {
          reason = "stored_result_failed_integrity_check";
          continue;
        }
        if (artifact.envelope_digest !== digest) {
          mismatchReason ||= envelopeChangeReason(artifact.input_envelope, envelope);
          continue;
        }
        if (artifact.contested === true || contested.has(artifact.artifact_id)) {
          reason = "stored_results_disagree";
          continue;
        }
        if (!artifactAgeValid(artifact, now, options)) {
          reason = "stored_result_expired";
          continue;
        }
        if (!validRouteOutput(artifact.replay_output)) {
          reason = "stored_result_not_validated";
          continue;
        }
        chosen = artifact;
        reason = "inputs_and_evidence_unchanged";
        break;
      }
      if (!chosen && mismatchReason && reason === "no_matching_result") reason = mismatchReason;
    } else if (!runFresh) {
      if (Number(options?.temperature || 0) !== 0) {
        reason = "creative_variation_requested";
      } else {
      reason = envelope.effect_policy.reasons[0] || "result_requires_fresh_execution";
      }
    }
    if (chosen) {
      const seed = {
        ...structuredClone(chosen.replay_output),
        id: step.id,
        step_id: step.id,
        adapter: step.adapter,
        task: step.task,
        depends_on: step.depends_on || [],
        execution_mode: "reused",
        reused_from_artifact_id: chosen.artifact_id,
        reused_from_run_id: chosen.origin_run_id,
        world_graph_output_digest: chosen.output_digest,
        elapsed_sec: 0
      };
      seeds.set(step.id, seed);
      outputsByStep.set(step.id, seed);
    } else {
      // A live result is not known yet. Use a dependency sentinel so no
      // downstream artifact can be selected before this branch resolves.
      outputsByStep.set(step.id, {
        step_id: step.id,
        adapter: step.adapter,
        world_graph_output_digest: worldGraphDigest({ pending_live_step: step.id, envelope: digest })
      });
    }
    decisions.push({
      step_id: step.id,
      adapter: step.adapter,
      action: chosen ? "kept" : "refresh",
      reason,
      artifact_id: chosen?.artifact_id || null,
      origin_run_id: chosen?.origin_run_id || null,
      envelope_digest: digest
    });
  }
  return { seeds, decisions, scope };
}

export function selectWorldGraphSeedForStep({
  data,
  run,
  session,
  step,
  agents,
  documents,
  sharedMemory,
  options,
  runtimeComponentProvenance = null,
  resolvedOutputs,
  runFresh = false,
  now = Date.now()
}) {
  const scope = scopeFor({ run, session });
  const agent = (agents || []).find((item) => item.id === step.adapter) || { id: step.adapter };
  const outputsByStep = new Map((resolvedOutputs || []).map((output) => [output.step_id || output.id, output]));
  const envelope = inputEnvelope({
    run, session, step, agent, documents, sharedMemory, options, outputsByStep, runtimeComponentProvenance
  });
  const digest = envelopeDigest(envelope);
  const contested = contestedArtifactIds(data);
  let reason = runFresh ? "fresh_run_requested" : "no_matching_result";
  let mismatchReason = null;
  if (!runFresh && envelope.effect_policy.replayable && Number(options?.temperature || 0) === 0) {
    const candidates = (data.worldGraphArtifacts || [])
      .filter((artifact) => sameScope(artifact, scope) && artifact.adapter === step.adapter)
      .sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)));
    for (const artifact of candidates) {
      if (!verifyWorldGraphArtifact(artifact)) { reason = "stored_result_failed_integrity_check"; continue; }
      if (artifact.envelope_digest !== digest) {
        mismatchReason ||= envelopeChangeReason(artifact.input_envelope, envelope);
        continue;
      }
      if (artifact.contested || contested.has(artifact.artifact_id)) { reason = "stored_results_disagree"; continue; }
      if (!artifactAgeValid(artifact, now, options)) { reason = "stored_result_expired"; continue; }
      if (!validRouteOutput(artifact.replay_output)) { reason = "stored_result_not_validated"; continue; }
      return {
        seed: {
          ...structuredClone(artifact.replay_output),
          id: step.id,
          step_id: step.id,
          adapter: step.adapter,
          task: step.task,
          depends_on: step.depends_on || [],
          execution_mode: "reused",
          reused_from_artifact_id: artifact.artifact_id,
          reused_from_run_id: artifact.origin_run_id,
          world_graph_output_digest: artifact.output_digest,
          elapsed_sec: 0
        },
        decision: {
          step_id: step.id,
          adapter: step.adapter,
          action: "kept",
          reason: "inputs_and_evidence_unchanged",
          artifact_id: artifact.artifact_id,
          origin_run_id: artifact.origin_run_id,
          envelope_digest: digest
        }
      };
    }
    if (mismatchReason && reason === "no_matching_result") reason = mismatchReason;
  } else if (!runFresh) {
    reason = Number(options?.temperature || 0) !== 0
      ? "creative_variation_requested"
      : envelope.effect_policy.reasons[0] || "result_requires_fresh_execution";
  }
  return {
    seed: null,
    decision: {
      step_id: step.id,
      adapter: step.adapter,
      action: "refresh",
      reason,
      artifact_id: null,
      origin_run_id: null,
      envelope_digest: digest
    }
  };
}

export function recordWorldGraphRun({
  data,
  run,
  session,
  plan,
  outputs,
  agents,
  documents,
  sharedMemory,
  options,
  decisions = [],
  runtimeProvenance = null,
  replayCandidateIds = null,
  createdAt = nowIso()
}) {
  data.worldGraphArtifacts ||= [];
  data.worldGraphEvents ||= [];
  const scope = scopeFor({ run, session });
  const agentsById = new Map((agents || []).map((agent) => [agent.id, agent]));
  const outputByStep = new Map((outputs || []).map((output) => [output.step_id || output.id, output]));
  const decisionsByStep = new Map(decisions.map((item) => [item.step_id, item]));
  const recorded = [];
  const realRuntime = String(process.env.TCAR_ENGINE_MODE || "simulator").toLowerCase() === "real";
  const permittedReplayIds = new Set(Array.isArray(replayCandidateIds) ? replayCandidateIds : []);
  const recordTime = Date.parse(createdAt);

  for (const step of plan?.steps || []) {
    const output = outputByStep.get(step.id);
    if (!output) continue;
    const agent = agentsById.get(step.adapter) || { id: step.adapter };
    const runtimeComponentState = normalizedRuntimeComponentState(runtimeProvenance || output);
    const executionMode = output.execution_mode === "reused" ? "reused" : "refreshed";
    const replay = replayOutput({ ...output, id: step.id, step_id: step.id, adapter: step.adapter, task: step.task, depends_on: step.depends_on || [] });
    if (!replay) {
      if (executionMode === "reused") {
        const error = new Error(`Reused WorldGraph output exceeded the verified replay boundary for step ${step.id}.`);
        error.code = "world_graph_reuse_contract_invalid";
        throw error;
      }
      continue;
    }
    const envelope = inputEnvelope({
      run,
      session,
      step,
      agent,
      documents,
      sharedMemory,
      options,
      outputsByStep: outputByStep,
      runtimeComponentProvenance: runtimeComponentState
    });
    let actualEffect = replayPolicy({ query: run.query, agent, output, documents });
    envelope.effect_policy = actualEffect;
    const outputHash = outputDigest(replay);
    const currentEnvelopeDigest = envelopeDigest(envelope);
    const sourceArtifact = executionMode === "reused"
      ? data.worldGraphArtifacts.find((candidate) => (
        candidate.artifact_id === output.reused_from_artifact_id
        && sameScope(candidate, scope)
        && candidate.adapter === step.adapter
        && candidate.envelope_digest === currentEnvelopeDigest
        && candidate.output_digest === outputHash
        && output.world_graph_output_digest === candidate.output_digest
        && replayPayloadDigest(candidate.replay_output) === replayPayloadDigest(output)
        && worldGraphDigest(candidate.runtime_component_state || null) === worldGraphDigest(runtimeComponentState || null)
        && candidate.contested !== true
        && !contestedArtifactIds(data).has(candidate.artifact_id)
        && candidate.effect_policy?.replayable === true
        && artifactAgeValid(candidate, Number.isFinite(recordTime) ? recordTime : Date.now(), options)
        && validRouteOutput(candidate.replay_output)
        && verifyWorldGraphArtifact(candidate)
        && (!realRuntime || permittedReplayIds.has(candidate.artifact_id))
        && (!realRuntime || output.reused_from_run_id === candidate.origin_run_id)
      )) || null
      : null;
    if (executionMode === "reused" && !sourceArtifact) {
      const error = new Error(`Unverified WorldGraph reuse was claimed for step ${step.id}.`);
      error.code = "world_graph_reuse_contract_invalid";
      throw error;
    }
    if (realRuntime && !runtimeComponentState) {
      if (executionMode === "reused") {
        const error = new Error(`Runtime omitted component provenance for reused step ${step.id}.`);
        error.code = "world_graph_reuse_contract_invalid";
        throw error;
      }
      actualEffect = {
        class: "volatile",
        replayable: false,
        reasons: [...new Set([...(actualEffect.reasons || []), "runtime_revision_changed_or_unverified"])]
      };
      envelope.effect_policy = actualEffect;
    }
    // A kept route already points to an immutable, verified source artifact.
    // Do not clone the full payload on every repeat: that would amplify writes,
    // consume the per-owner cap, and evict useful results from unrelated chats.
    if (executionMode === "reused") continue;
    const artifact = {
      artifact_id: makeId("wg_artifact"),
      schema_version: WORLD_GRAPH_SCHEMA_VERSION,
      ...scope,
      origin_run_id: run.run_id,
      origin_step_id: step.id,
      adapter: step.adapter,
      input_envelope: envelope,
      envelope_digest: envelopeDigest(envelope),
      output_digest: outputHash,
      replay_output: replay,
      effect_policy: actualEffect,
      execution_mode: executionMode,
      reused_from_artifact_id: output.reused_from_artifact_id || null,
      freshness_anchor_at: createdAt,
      runtime_provenance_digest: runtimeProvenance ? worldGraphDigest(runtimeProvenance) : null,
      runtime_component_state: runtimeComponentState,
      contested: false,
      created_at: createdAt
    };
    const conflicts = data.worldGraphArtifacts.filter((candidate) =>
      sameScope(candidate, scope)
      && candidate.envelope_digest === artifact.envelope_digest
      && candidate.output_digest !== artifact.output_digest
      && verifyWorldGraphArtifact(candidate)
    );
    if (conflicts.length && Number(options?.temperature || 0) === 0) {
      artifact.contested = true;
      data.worldGraphEvents.push({
        event_id: makeId("wg_event"),
        schema_version: WORLD_GRAPH_SCHEMA_VERSION,
        event_type: "result.contested",
        ...scope,
        run_id: run.run_id,
        step_id: step.id,
        adapter: step.adapter,
        artifact_ids: [...conflicts.map((item) => item.artifact_id), artifact.artifact_id],
        occurred_at: createdAt
      });
    }
    artifact.record_hash = artifactRecordHash(artifact);
    data.worldGraphArtifacts.push(artifact);
    recorded.push(artifact);
  }

  const completedOutputs = (plan?.steps || [])
    .map((step) => outputByStep.get(step.id))
    .filter(Boolean);
  const refreshed = completedOutputs.filter((item) => item.execution_mode !== "reused").length;
  const kept = completedOutputs.filter((item) => item.execution_mode === "reused").length;
  run.world_graph = {
    schema_version: WORLD_GRAPH_SCHEMA_VERSION,
    kept,
    refreshed,
    total: completedOutputs.length,
    decisions: (plan?.steps || []).map((step) => {
      const output = outputByStep.get(step.id);
      const decision = decisionsByStep.get(step.id);
      return {
        step_id: step.id,
        adapter: step.adapter,
        action: output?.execution_mode === "reused" ? "kept" : "refreshed",
        reason: output?.execution_mode === "reused"
          ? "inputs_and_evidence_unchanged"
          : decision?.reason || "result_was_recomputed",
        reused_from_run_id: output?.reused_from_run_id || decision?.origin_run_id || null
      };
    }),
    created_at: createdAt
  };
  pruneWorldGraph(data, scope, Date.parse(createdAt));
  return run.world_graph;
}

function pruneWorldGraph(data, scope, referenceTime = Date.now()) {
  const safeReferenceTime = Number.isFinite(referenceTime) ? referenceTime : Date.now();
  pruneExpiredWorldGraphData(data, { now: safeReferenceTime });
  const owned = data.worldGraphArtifacts
    .filter((artifact) => artifact.workspace_id === scope.workspace_id && artifact.created_by === scope.created_by)
    .sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)));
  if (owned.length > MAX_ARTIFACTS_PER_OWNER) {
    const keep = new Set(owned.slice(0, MAX_ARTIFACTS_PER_OWNER).map((item) => item.artifact_id));
    data.worldGraphArtifacts = data.worldGraphArtifacts.filter((artifact) =>
      artifact.workspace_id !== scope.workspace_id
      || artifact.created_by !== scope.created_by
      || keep.has(artifact.artifact_id)
    );
  }
  const ownedEvents = (data.worldGraphEvents || [])
    .filter((event) => event.workspace_id === scope.workspace_id && event.created_by === scope.created_by)
    .sort((left, right) => String(right.occurred_at).localeCompare(String(left.occurred_at)));
  if (ownedEvents.length > MAX_EVENTS_PER_OWNER) {
    const keepEvents = new Set(ownedEvents.slice(0, MAX_EVENTS_PER_OWNER).map((event) => event.event_id));
    data.worldGraphEvents = data.worldGraphEvents.filter((event) =>
      event.workspace_id !== scope.workspace_id
      || event.created_by !== scope.created_by
      || keepEvents.has(event.event_id)
    );
  }
}

export function pruneExpiredWorldGraphData(data, { now = Date.now() } = {}) {
  const safeNow = Number.isFinite(now) ? now : Date.now();
  const cutoff = safeNow - STORAGE_RETENTION_MS;
  const artifactCount = (data.worldGraphArtifacts || []).length;
  const eventCount = (data.worldGraphEvents || []).length;
  data.worldGraphArtifacts = (data.worldGraphArtifacts || []).filter((artifact) => {
    const created = Date.parse(artifact.created_at || "");
    return Number.isFinite(created) && created >= cutoff;
  });
  data.worldGraphEvents = (data.worldGraphEvents || []).filter((event) => {
    const occurred = Date.parse(event.occurred_at || "");
    return Number.isFinite(occurred) && occurred >= cutoff;
  });
  return {
    artifacts: artifactCount - data.worldGraphArtifacts.length,
    events: eventCount - data.worldGraphEvents.length
  };
}

export function publicWorldGraphRun(run = {}) {
  const graph = run.world_graph || {};
  return {
    schema_version: graph.schema_version || WORLD_GRAPH_SCHEMA_VERSION,
    kept: Number(graph.kept) || 0,
    refreshed: Number(graph.refreshed) || 0,
    total: Number(graph.total) || 0,
    // This describes what happened at completion. Present validity is known
    // only after the explicit no-model /check operation.
    validity: run.status === "completed" ? "unchecked" : run.status === "failed" ? "unknown" : "checking",
    decisions: Array.isArray(graph.decisions) ? graph.decisions.map((item) => ({
      step_id: item.step_id,
      adapter: item.adapter,
      action: item.action,
      reason: item.reason,
      plain_reason: worldGraphReasonText(item.reason, item.action),
      reused_from_run_id: item.reused_from_run_id || null
    })) : [],
    created_at: graph.created_at || null
  };
}

export function publicWorldGraphSnapshot({ data, run, actor }) {
  const targetScope = run ? {
    workspace_id: String(run.workspace_id || ""),
    created_by: String(run.created_by || ""),
    session_id: String(run.session_id || ""),
    agent_workspace_id: String(run.agent_workspace_id || "")
  } : {
    workspace_id: String(actor.workspace_id || ""),
    created_by: String(actor.user_id || ""),
    session_id: "",
    agent_workspace_id: ""
  };
  const runQueryDigest = run ? worldGraphDigest(normalizedQuery(run.query)) : null;
  const runAdapters = new Set((run?.plan?.steps || []).map((step) => step.adapter));
  const accessible = (data.worldGraphArtifacts || []).filter((artifact) =>
    artifact.workspace_id === targetScope.workspace_id
    && artifact.created_by === targetScope.created_by
    && (!run || (
      artifact.session_id === targetScope.session_id
      && artifact.agent_workspace_id === targetScope.agent_workspace_id
      && artifact.input_envelope?.query_digest === runQueryDigest
      && runAdapters.has(artifact.adapter)
    ))
  );
  const verified = accessible.filter(verifyWorldGraphArtifact);
  const contested = contestedArtifactIds(data);
  const summary = run ? publicWorldGraphRun(run) : null;
  const decisions = new Map((summary?.decisions || []).map((item) => [item.step_id, item]));
  const steps = run?.plan?.steps || [];
  return {
    schema_version: WORLD_GRAPH_SCHEMA_VERSION,
    run: summary,
    graph_id: run ? `world_graph:${run.run_id}` : null,
    revision: run?.completed_at || run?.created_at || null,
    nodes: steps.map((step) => {
      const decision = decisions.get(step.id);
      return {
        node_id: `agent_result:${step.id}`,
        kind: "agent_result",
        agent_id: step.adapter,
        step_id: step.id,
        label: boundedText(step.task || step.adapter, 240),
        validity: run?.status === "completed" ? "unchecked" : "unknown",
        run_action: decision?.action === "kept"
          ? "reused"
          : run?.status === "completed" ? "executed" : "pending",
        reason_code: decision?.reason || "result_was_recomputed",
        plain_reason: decision?.plain_reason || worldGraphReasonText(decision?.reason, decision?.action),
        effect: "read"
      };
    }),
    edges: steps.flatMap((step) => (step.depends_on || []).map((source) => ({
      edge_id: `support:${source}:${step.id}`,
      source: `agent_result:${source}`,
      target: `agent_result:${step.id}`,
      kind: "supports"
    }))),
    stored_results: verified.length,
    contested_results: verified.filter((artifact) => artifact.contested || contested.has(artifact.artifact_id)).length,
    effect_safe_results: verified.filter((artifact) => artifact.effect_policy?.replayable === true).length
  };
}

export function previewWorldGraphRun({
  data,
  run,
  session,
  agents,
  documents,
  sharedMemory,
  options,
  runtimeComponentProvenance = null,
  targetAgentWorkspaceId = run?.agent_workspace_id || null,
  now = Date.now()
}) {
  const steps = Array.isArray(run?.plan?.steps) ? run.plan.steps : [];
  if (run?.status !== "completed" || !steps.length || !run?.world_graph?.total) {
    return {
      schema_version: WORLD_GRAPH_SCHEMA_VERSION,
      availability: "unavailable",
      base_run_id: run?.run_id || null,
      validity: "unknown",
      keep_count: 0,
      wake_count: 0,
      decisions: [],
      model_calls_performed: 0,
      checked_at: new Date(now).toISOString()
    };
  }
  if (String(targetAgentWorkspaceId || "") !== String(run.agent_workspace_id || "")) {
    return {
      schema_version: WORLD_GRAPH_SCHEMA_VERSION,
      availability: "ready",
      base_run_id: run.run_id,
      validity: "needs_refresh",
      keep_count: 0,
      wake_count: steps.length,
      decisions: steps.map((step) => ({
        step_id: step.id,
        adapter: step.adapter,
        projected_action: "wake",
        reason: "agent_team_changed",
        plain_reason: worldGraphReasonText("agent_team_changed", "refresh")
      })),
      conservative: true,
      external_actions_will_run: false,
      model_calls_performed: 0,
      checked_at: new Date(now).toISOString()
    };
  }
  const resolved = [];
  const decisions = [];
  for (const step of steps) {
    const selection = selectWorldGraphSeedForStep({
      data,
      run,
      session,
      step,
      agents,
      documents,
      sharedMemory,
      options,
      runtimeComponentProvenance,
      resolvedOutputs: resolved,
      runFresh: false,
      now
    });
    const keep = Boolean(selection.seed);
    decisions.push({
      step_id: step.id,
      adapter: step.adapter,
      projected_action: keep ? "keep" : "wake",
      reason: selection.decision.reason,
      plain_reason: worldGraphReasonText(selection.decision.reason, keep ? "kept" : "refresh")
    });
    resolved.push(selection.seed || {
      id: step.id,
      step_id: step.id,
      adapter: step.adapter,
      // A dirty upstream branch has no known future output. The sentinel makes
      // every dependent preview conservative until the branch actually runs;
      // if its validated output stays identical, the live executor can still
      // keep downstream work.
      world_graph_output_digest: worldGraphDigest({
        projected_dirty_step: step.id,
        envelope_digest: selection.decision.envelope_digest
      })
    });
  }
  const wakeCount = decisions.filter((decision) => decision.projected_action === "wake").length;
  return {
    schema_version: WORLD_GRAPH_SCHEMA_VERSION,
    availability: "ready",
    base_run_id: run.run_id,
    validity: wakeCount ? "needs_refresh" : "current",
    keep_count: decisions.length - wakeCount,
    wake_count: wakeCount,
    decisions,
    conservative: wakeCount > 0,
    external_actions_will_run: false,
    model_calls_performed: 0,
    checked_at: new Date(now).toISOString()
  };
}

export function worldGraphReasonText(code, action = "") {
  const reasons = {
    inputs_and_evidence_unchanged: "Its inputs, evidence, and agent instructions are unchanged.",
    fresh_run_requested: "You asked every agent to check again.",
    no_matching_result: "No earlier validated result matched this work.",
    agent_changed: "The agent's instructions or knowledge changed.",
    agent_team_changed: "The active agent team changed since this answer ran.",
    task_changed: "This agent received a different task.",
    upstream_result_changed: "Work this agent relies on changed.",
    dependencies_changed: "The handoff into this agent changed.",
    source_changed_or_unverifiable: "A source changed or could no longer be verified.",
    request_changed: "The request changed, so this work was checked again.",
    conversation_context_changed: "Conversation context this agent uses changed.",
    execution_settings_changed: "The model or execution settings changed.",
    runtime_revision_changed_or_unverified: "The model or Router runtime revision changed or could not be verified.",
    stored_result_expired: "The earlier result was too old to keep.",
    stored_results_disagree: "Earlier validated results disagree, so this was checked again.",
    stored_result_failed_integrity_check: "The earlier result did not pass its integrity check.",
    stored_result_not_validated: "The earlier result was not safe to reuse.",
    creative_variation_requested: "Creative variation was requested.",
    time_sensitive_request: "This request depends on current information.",
    live_or_mutable_tool_available: "This work can depend on live information.",
    live_or_mutable_tool_used: "This work used live information.",
    external_or_effectful_tool_used: "External actions are never replayed.",
    approval_bound_action: "This work requires a new approval.",
    tool_result_requires_fresh_execution: "A tool result needed to be checked again.",
    reuse_provenance_unverified: "The earlier result could not be traced to a verified stored record.",
    result_was_recomputed: "This agent checked its part of the answer now."
  };
  return reasons[code] || (action === "kept"
    ? "The prior validated work is still current."
    : "This agent checked its part of the answer now.");
}

export function worldGraphReplayCapsule({
  data,
  run,
  session,
  agents,
  documents,
  sharedMemory,
  options,
  runFresh = false,
  signingKey = "",
  now = Date.now()
}) {
  if (runFresh || Number(options?.temperature || 0) !== 0 || String(signingKey).length < 16) return null;
  const scope = scopeFor({ run, session });
  const queryDigest = worldGraphDigest(normalizedQuery(run?.query));
  const agentsById = new Map((agents || []).map((agent) => [agent.id, agent]));
  const candidates = [];
  const seenCandidates = new Set();
  let totalBytes = 0;
  const contested = contestedArtifactIds(data);
  for (const artifact of [...(data.worldGraphArtifacts || [])]
    .filter((item) => sameScope(item, scope) && item.input_envelope?.query_digest === queryDigest)
    .sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)))) {
    if (candidates.length >= 24) break;
    if (!verifyWorldGraphArtifact(artifact) || artifact.contested || contested.has(artifact.artifact_id) || !artifactAgeValid(artifact, now, options)) continue;
    if (artifact.effect_policy?.replayable !== true) continue;
    if (
      String(process.env.TCAR_ENGINE_MODE || "simulator").toLowerCase() === "real"
      && !normalizedRuntimeComponentState(artifact.runtime_component_state)
    ) continue;
    const agent = agentsById.get(artifact.adapter);
    if (!agent || agent.enabled === false || agent.runtime_sync_pending === true) continue;
    if (artifact.input_envelope.agent_revision !== agentRevision(agent)) continue;
    if (artifact.input_envelope.source_state_digest !== worldGraphDigest(sourceStateForAgent(agent, documents))) continue;
    if (!sourceStateReplayable(agent, documents)) continue;
    const memory = memoryState(agent, sharedMemory);
    const currentMemoryDigest = memory === null ? null : worldGraphDigest(memory);
    if (artifact.input_envelope.memory_digest !== currentMemoryDigest) continue;
    if (artifact.input_envelope.route_options_digest !== worldGraphDigest(routeOptionState(options))) continue;
    const candidateKey = `${artifact.adapter}\0${artifact.envelope_digest}`;
    if (seenCandidates.has(candidateKey)) continue;
    const candidate = {
      artifact_id: artifact.artifact_id,
      origin_run_id: artifact.origin_run_id,
      created_at: artifact.created_at,
      freshness_anchor_at: artifact.freshness_anchor_at || artifact.created_at,
      input_envelope: artifact.input_envelope,
      output_digest: artifact.output_digest,
      replay_output: artifact.replay_output,
      runtime_component_state: artifact.runtime_component_state || null,
      record_hash: artifact.record_hash
    };
    const bytes = Buffer.byteLength(JSON.stringify(candidate), "utf8");
    if (bytes > MAX_REPLAY_BYTES || totalBytes + bytes > MAX_CAPSULE_BYTES) continue;
    totalBytes += bytes;
    seenCandidates.add(candidateKey);
    candidates.push(candidate);
  }
  if (!candidates.length) return null;
  const issuedAt = new Date(now).toISOString();
  const capsule = {
    schema_version: WORLD_GRAPH_SCHEMA_VERSION,
    engine_revision: WORLD_GRAPH_ENGINE_REVISION,
    capsule_id: makeId("wg_capsule"),
    issued_at: issuedAt,
    expires_at: new Date(now + 5 * 60 * 1000).toISOString(),
    scope: {
      target_run_id: run.run_id,
      workspace_id: scope.workspace_id,
      user_id: scope.created_by,
      session_id: scope.session_id,
      agent_workspace_id: scope.agent_workspace_id
    },
    query_digest: queryDigest,
    candidates
  };
  // Transport the exact bytes that were signed. Re-serializing this object in
  // Python would otherwise change valid IEEE-754 spellings (for example
  // 0.000001 to 1e-06). No unsigned mirror fields are exposed on the wrapper,
  // so there is only one authoritative representation to parse.
  const signedPayload = JSON.stringify(capsule);
  const signature = crypto.createHmac("sha256", String(signingKey))
    .update(WORLD_GRAPH_CAPSULE_SIGNATURE_DOMAIN, "utf8")
    .update(WORLD_GRAPH_CAPSULE_ENCODING, "utf8")
    .update("\n", "utf8")
    .update(signedPayload, "utf8")
    .digest("hex");
  const wrapper = {
    encoding: WORLD_GRAPH_CAPSULE_ENCODING,
    signed_payload: signedPayload,
    signature
  };
  // Keep local authorization metadata out of the transport envelope. Only the
  // exact wrapper bytes cross the network, while the caller can still bind a
  // runtime reuse claim to candidates from this specific in-process capsule.
  replayCapsulePayloads.set(wrapper, capsule);
  return wrapper;
}

export function worldGraphReplayCandidateIds(wrapper) {
  const payload = wrapper && typeof wrapper === "object" ? replayCapsulePayloads.get(wrapper) : null;
  return Array.isArray(payload?.candidates)
    ? payload.candidates.map((candidate) => String(candidate?.artifact_id || "")).filter(Boolean)
    : [];
}

export function deleteWorldGraphDataForOwner(data, { workspace_id, user_id, sessionIds = null }) {
  const beforeArtifacts = (data.worldGraphArtifacts || []).length;
  const beforeEvents = (data.worldGraphEvents || []).length;
  const owns = (item) => item.workspace_id === workspace_id && item.created_by === user_id
    && (!sessionIds || sessionIds.has(item.session_id));
  data.worldGraphArtifacts = (data.worldGraphArtifacts || []).filter((item) => !owns(item));
  data.worldGraphEvents = (data.worldGraphEvents || []).filter((item) => !owns(item));
  return {
    artifacts: beforeArtifacts - data.worldGraphArtifacts.length,
    events: beforeEvents - data.worldGraphEvents.length
  };
}

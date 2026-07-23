import { agentRevision, digestValue, normalizeSha256Digest } from "./outcomes.js";
import { agentRuntimeOutputModelId } from "./agentRuntimeResponseCompatibility.js";
import {
  AGENT_DOCUMENT_SOURCE_ROOT,
  AGENT_SOURCE_ROOT
} from "../shared/agentRuntimeStateContract.js";
import {
  PERSISTED_AGENT_SOURCE_ROOT,
  PERSISTED_DOCUMENT_SOURCE_ROOT
} from "./persistedStorageCompatibility.js";
import { makeId, nowIso } from "./store.js";
import { worldGraphRouteOutputMatchesOutcomeContract } from "./worldGraph.js";

export function stripHiddenReasoningMarkup(rawText) {
  let text = String(rawText || "");
  text = text.replace(/<(think|analysis|reasoning)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ");

  const orphanClosings = [...text.matchAll(/<\/(?:think|analysis|reasoning)\s*>/gi)];
  if (orphanClosings.length > 0) {
    const last = orphanClosings.at(-1);
    text = text.slice((last.index || 0) + last[0].length);
  }

  const orphanOpening = text.search(/<(?:think|analysis|reasoning)\b[^>]*>/i);
  if (orphanOpening >= 0) {
    text = text.slice(0, orphanOpening);
  }
  return text.replace(/<\/?(?:think|analysis|reasoning)\b[^>]*>/gi, " ");
}

const INTERNAL_SYNTHESIS_NARRATION = [
  /\bvalidated\s+(?:route|agent)\s+results?\b/i,
  /\b(?:step|route)\s+s\d+\b/i,
  /\bomitted\b[\s\S]{0,100}\b(?:budget|context|validation)\b/i,
  /\b(?:handoff|routing)\s+(?:artifact|contract|pipeline)\b/i,
  /\bpolicy[_\s-]*violations?\b/i,
  /\bAGENT[_\s-]*REASON\w*\b/i
];

export function containsInternalSynthesisNarration(text) {
  const value = String(text || "");
  return INTERNAL_SYNTHESIS_NARRATION.some((pattern) => pattern.test(value));
}

function publicAnswerText(rawText) {
  let text = stripHiddenReasoningMarkup(rawText).trim();
  const domainAnswer = parseRouteSections(text).domain_answer;
  if (domainAnswer) {
    text = domainAnswer;
  } else if (/\bAGENT[_\s-]*REASON\w*\b\s*[:：]/i.test(text)) {
    return "";
  }
  return text.replace(/^\s*(?:#\s*)?Final Answer\s*[:：]?\s*/i, "").trim();
}

export function sanitizeRuntimeFinalAnswer(result = {}) {
  const primary = publicAnswerText(result.finalAnswer || "");
  const fallback = publicAnswerText(result.fallbackFinalAnswer || "");
  if ((!primary || containsInternalSynthesisNarration(primary)) && fallback) {
    return fallback;
  }
  return primary || fallback;
}

export function parseRouteSections(text) {
  const section = (name) => {
    const pattern = new RegExp(`${name}:\\s*([\\s\\S]*?)(?=\\n[A-Z_]+:|$)`, "i");
    return text.match(pattern)?.[1]?.trim() || "";
  };
  return {
    agent_reasoning: section("AGENT_REASONING"),
    domain_answer: section("DOMAIN_ANSWER"),
    handoffs: section("HANDOFFS"),
    boundary_check: section("BOUNDARY_CHECK"),
    retrieved_context: section("EXECUTOR_RETRIEVED_CONTEXT")
  };
}

function assertRuntimeRouteCoverage(plan, value) {
  const outputs = Array.isArray(value) ? value : null;
  const steps = Array.isArray(plan?.steps) ? plan.steps : [];
  const expected = new Map(steps.map((step) => [String(step.id || ""), step]));
  const seen = new Set();
  const fail = (detail) => {
    const error = new Error(`runtime_contract_invalid: ${detail}`);
    error.code = "runtime_contract_invalid";
    error.retryable = false;
    throw error;
  };
  if (!outputs) {
    fail("runtime route outputs are malformed");
  }
  if (outputs.length !== steps.length) {
    fail(`runtime returned ${outputs.length} route outputs for ${steps.length} planned steps`);
  }
  for (const output of outputs) {
    if (!output || typeof output !== "object" || Array.isArray(output)) {
      fail("runtime returned a malformed route output");
    }
    const hasId = Object.prototype.hasOwnProperty.call(output, "id");
    const hasStepId = Object.prototype.hasOwnProperty.call(output, "step_id");
    const outputId = hasId && typeof output.id === "string" ? output.id : "";
    const outputStepId = hasStepId && typeof output.step_id === "string" ? output.step_id : "";
    const stepId = outputId || outputStepId;
    if (
      !stepId
      || (hasId && !outputId)
      || (hasStepId && !outputStepId)
      || (hasId && hasStepId && outputId !== outputStepId)
    ) {
      fail("runtime route output has an invalid step identity");
    }
    const step = expected.get(stepId);
    if (!step || seen.has(stepId)) {
      fail(`runtime route output has an unexpected or duplicate step: ${stepId || "missing"}`);
    }
    if (String(output.adapter || "") !== String(step.adapter || "")) {
      fail(`runtime route output adapter does not match planned step ${stepId}`);
    }
    seen.add(stepId);
  }
  if (seen.size !== expected.size) fail("runtime omitted a planned route output");
  const byStep = new Map(outputs.map((output) => [String(output.id || output.step_id), output]));
  return steps.map((step) => byStep.get(String(step.id)));
}

function assertRuntimeSuccessfulRouteOutcomeContracts(plan, outputs, routeFailures) {
  if (plan?.routing?.orchestrator?.contract_version !== "session-orchestrator-v3") return;
  const failedStepIds = new Set(routeFailures.map((failure) => String(failure.step_id || "")));
  const stepById = new Map((Array.isArray(plan?.steps) ? plan.steps : []).map((step) => [
    String(step.id || ""),
    step
  ]));
  for (const output of outputs) {
    const stepId = String(output.id || output.step_id || "");
    if (failedStepIds.has(stepId)) continue;
    if (!worldGraphRouteOutputMatchesOutcomeContract(output, plan, stepById.get(stepId))) {
      throw runtimeRouteContractError(
        `runtime route output does not prove the compiled outcome contract for step ${stepId}`
      );
    }
  }
}

export function validateRuntimeRouteResults(plan, value, failureSummary = []) {
  // Cardinality and route identity are authoritative even when a worker
  // failed. Only after every output is bound to its exact planned step may a
  // Runtime failure summary (or the output's own validation evidence) classify
  // that route as failed. Failed output content is subsequently redacted and
  // excluded from synthesis/WorldGraph; all remaining outputs must prove the
  // compiled v3 outcome contract before any terminal route state is persisted.
  const outputs = assertRuntimeRouteCoverage(plan, value);
  const routeFailures = runtimeRouteFailureDetails(plan, outputs, failureSummary);
  assertRuntimeSuccessfulRouteOutcomeContracts(plan, outputs, routeFailures);
  return { outputs, routeFailures };
}

const RUNTIME_ROUTE_FAILURE_STATUS = Object.freeze({
  provider_safety_block: "blocked",
  required_tool_or_live_evidence: "blocked",
  worker_execution: "failed",
  source_evidence_validation: "blocked",
  model_output_limit: "failed",
  upstream_input_contract: "blocked",
  policy_validation: "blocked",
  artifact_contract: "failed",
  expected_output_contract: "failed",
  non_result: "failed",
  route_validation_failed: "blocked"
});

const RUNTIME_BLOCKED_FINISH_REASONS = new Set([
  "content_filter", "content-filter", "safety", "recitation", "blocked", "block", "prohibited_content"
]);

const RUNTIME_LIMIT_FINISH_REASONS = new Set([
  "length", "max_tokens", "max_output_tokens", "incomplete", "token_limit"
]);

// Runtime validators may carry rejected claim text, source ids, artifact
// names, tool arguments, and provider diagnostics. None of those values are
// suitable for durable operational telemetry. Preserve only this closed set
// of content-free reason codes; prefix rules deliberately discard their
// potentially sensitive suffixes.
const RUNTIME_FAILURE_REASON_CODES = new Set([
  "approved_source_context_missing",
  "artifact_validation_failed",
  "claim_not_supported_by_execution_evidence",
  "consumption_validation_failed",
  "empty_route_answer",
  "execution_claims_missing_citations",
  "fresh_evidence_tool_unavailable",
  "internal_synthesis_narration",
  "malformed_tool_call",
  "missing_expected_output",
  "model_output_truncated",
  "outcome_validation_failed",
  "provider_safety_block",
  "refusal_only_route_answer",
  "required_live_tool_not_executed",
  "required_tool_not_executed",
  "route_validation_failed",
  "source_claim_not_supported_by_cited_excerpt",
  "source_claims_missing_citations",
  "source_integrity_missing",
  "source_validation_failed",
  "tool_call_mixed_with_text",
  "tool_round_limit_exceeded",
  "unauthorized_tool",
  "uncited_source_claim",
  "unknown_citation",
  "unvalidated_interaction_claim",
  "upstream_input_contract_invalid",
  "validated_upstream_denied",
  "worker_execution_failed"
]);

const RUNTIME_FAILURE_REASON_PREFIXES = Object.freeze([
  ["required_tool_not_executed", "required_tool_not_executed"],
  ["required_live_tool_not_executed", "required_live_tool_not_executed"],
  ["fresh_evidence_tool_unavailable", "fresh_evidence_tool_unavailable"],
  ["missing_expected_output", "missing_expected_output"],
  ["invalid_upstream_contract", "upstream_input_contract_invalid"],
  ["validated_upstream_denied", "validated_upstream_denied"],
  ["unsupported_citation", "unknown_citation"],
  ["source_integrity_missing", "source_integrity_missing"]
]);

const RUNTIME_ROUTE_REPAIR_FIELDS = Object.freeze([
  "source_repair",
  "execution_evidence_repair",
  "execution_evidence_sanitizer",
  "extractive_source_fallback",
  "upstream_consistency_repair",
  "handoff_contract_repair",
  "terminal_fan_in_recovery"
]);

export function normalizeRuntimeFailureReasonCode(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (RUNTIME_FAILURE_REASON_CODES.has(normalized)) return normalized;
  for (const [prefix, code] of RUNTIME_FAILURE_REASON_PREFIXES) {
    if (normalized === prefix || normalized.startsWith(`${prefix}:`)) return code;
  }
  return null;
}

function addRuntimeFailureReasonCodes(target, value) {
  if (!Array.isArray(value)) return;
  for (const raw of value.slice(0, 256)) {
    const code = normalizeRuntimeFailureReasonCode(raw);
    if (code) target.add(code);
  }
}

function boundedArrayCount(value) {
  return Array.isArray(value) ? Math.min(value.length, 10_000) : 0;
}

/**
 * Build privacy-safe diagnostics for a failed Runtime route.
 *
 * The returned shape contains only fixed enums, booleans, and a bounded
 * integer. It intentionally never copies a validator row, policy suffix,
 * repair error, claim, source id, prompt, tool argument, or tool result.
 */
export function runtimeRouteFailureObservability(output = {}) {
  const reasonCodes = new Set();
  addRuntimeFailureReasonCodes(reasonCodes, output.policy_violations);
  const modelCalls = Array.isArray(output?.model_calls) ? output.model_calls : [];
  const lastModelCall = modelCalls.length ? modelCalls.at(-1) : null;
  const finishReason = String(lastModelCall?.finish_reason || output?.finish_reason || "").trim().toLowerCase();
  if (RUNTIME_BLOCKED_FINISH_REASONS.has(finishReason)) reasonCodes.add("provider_safety_block");
  if (RUNTIME_LIMIT_FINISH_REASONS.has(finishReason)) reasonCodes.add("model_output_truncated");

  const sourceValidation = output?.source_validation;
  if (sourceValidation && typeof sourceValidation === "object" && !Array.isArray(sourceValidation)) {
    addRuntimeFailureReasonCodes(reasonCodes, sourceValidation.violations);
    if (boundedArrayCount(sourceValidation.unknown_citations) > 0) reasonCodes.add("unknown_citation");
    if (boundedArrayCount(sourceValidation.invalid_source_integrity) > 0) reasonCodes.add("source_integrity_missing");
    if (boundedArrayCount(sourceValidation.unsupported_claims) > 0) {
      reasonCodes.add("source_claim_not_supported_by_cited_excerpt");
    }
    if (boundedArrayCount(sourceValidation.unsupported_execution_evidence_claims) > 0) {
      reasonCodes.add("claim_not_supported_by_execution_evidence");
    }
    if (sourceValidation.valid !== true) reasonCodes.add("source_validation_failed");
  }

  const validationReasonCodes = [
    ["consumption_validation", "consumption_validation_failed"],
    ["artifact_validation", "artifact_validation_failed"],
    ["outcome_validation", "outcome_validation_failed"]
  ];
  for (const [field, reasonCode] of validationReasonCodes) {
    const validation = output?.[field];
    if (!validation || typeof validation !== "object" || Array.isArray(validation)) continue;
    addRuntimeFailureReasonCodes(reasonCodes, validation.violations);
    addRuntimeFailureReasonCodes(reasonCodes, validation.errors);
    if (validation.valid !== true) reasonCodes.add(reasonCode);
  }
  if (String(output?.output_contract || "").trim().toLowerCase() === "failed_closed") {
    reasonCodes.add("route_validation_failed");
  }

  const repairAttempts = RUNTIME_ROUTE_REPAIR_FIELDS.flatMap((field) => {
    const value = output?.[field];
    return value && typeof value === "object" && !Array.isArray(value) && value.attempted === true
      ? [value]
      : [];
  });
  const unsupportedClaimCount = Math.min(10_000,
    boundedArrayCount(sourceValidation?.unsupported_claims)
    + boundedArrayCount(sourceValidation?.unsupported_execution_evidence_claims));

  return {
    schema_version: "runtime-route-failure-observability-v1",
    failure_reason_codes: [...reasonCodes].sort(),
    repair_attempted: repairAttempts.length > 0,
    repair_valid: repairAttempts.some((repair) => (
      repair.valid === true || repair.revalidation_valid === true || repair.used === true
    )),
    unsupported_claim_count: unsupportedClaimCount
  };
}

function runtimeValidationFailed(validation, fields = []) {
  const hasFailureValue = (value) => Array.isArray(value)
    ? value.length > 0
    : value && typeof value === "object"
      ? Object.keys(value).length > 0
      : Boolean(value);
  return !validation
    || typeof validation !== "object"
    || Array.isArray(validation)
    || validation.valid !== true
    || fields.some((field) => hasFailureValue(validation[field]));
}

function runtimeRouteOutputFailureClass(output) {
  const rawViolations = output?.policy_violations;
  const violations = (Array.isArray(rawViolations) ? rawViolations : [])
    .map((value) => String(value || ""));
  const modelCalls = Array.isArray(output?.model_calls) ? output.model_calls : [];
  const lastModelCall = modelCalls.length ? modelCalls.at(-1) : null;
  const finishReason = String(lastModelCall?.finish_reason || output?.finish_reason || "").trim().toLowerCase();
  if (RUNTIME_BLOCKED_FINISH_REASONS.has(finishReason)) return "provider_safety_block";
  if (rawViolations && !Array.isArray(rawViolations)) return "policy_validation";
  if (violations.some((value) => value.startsWith("required_tool_not_executed:")
    || value.startsWith("required_live_tool_not_executed")
    || value.startsWith("fresh_evidence_tool_unavailable"))) {
    return "required_tool_or_live_evidence";
  }
  if (violations.includes("worker_execution_failed")) return "worker_execution";
  if (Object.prototype.hasOwnProperty.call(output || {}, "source_validation")
    && runtimeValidationFailed(output.source_validation, [
      "violations", "invalid_source_integrity", "unsupported_claims", "unsupported_execution_evidence_claims"
    ])) return "source_evidence_validation";
  if (violations.includes("model_output_truncated") || RUNTIME_LIMIT_FINISH_REASONS.has(finishReason)) {
    return "model_output_limit";
  }
  if (Object.prototype.hasOwnProperty.call(output || {}, "consumption_validation")
    && runtimeValidationFailed(output.consumption_validation, ["errors", "rejected", "missing_from_upstream"])) {
    return "upstream_input_contract";
  }
  if (violations.some((value) => value.startsWith("invalid_upstream_contract:"))) {
    return "upstream_input_contract";
  }
  const recoverableViolations = new Set([
    "worker_execution_failed", "model_output_truncated", "empty_route_answer", "refusal_only_route_answer"
  ]);
  if (violations.some((value) => !recoverableViolations.has(value)
    && !value.startsWith("missing_expected_output:")
    && !value.startsWith("invalid_upstream_contract:"))) {
    return "policy_validation";
  }
  if (Object.prototype.hasOwnProperty.call(output || {}, "artifact_validation")
    && runtimeValidationFailed(output.artifact_validation, ["errors", "missing"])) return "artifact_contract";
  if (Object.prototype.hasOwnProperty.call(output || {}, "outcome_validation")
    && runtimeValidationFailed(output.outcome_validation, ["errors", "missing_expected_outputs"])) {
    return "expected_output_contract";
  }
  if (violations.some((value) => value.startsWith("missing_expected_output:"))) {
    return "expected_output_contract";
  }
  if (String(output?.output_contract || "").trim().toLowerCase() === "failed_closed") {
    return "route_validation_failed";
  }
  if (violations.includes("empty_route_answer")
    || violations.includes("refusal_only_route_answer")
    || typeof output?.domain_answer !== "string"
    || !output.domain_answer.trim()) return "non_result";
  return null;
}

function runtimeRouteContractError(detail) {
  const error = new Error(`runtime_contract_invalid: ${detail}`);
  error.code = "runtime_contract_invalid";
  error.retryable = false;
  return error;
}

export function runtimeRouteFailureDetails(plan, outputs, value = []) {
  const retryableFailureClasses = new Set([
    "worker_execution",
    "worker_empty_output",
    "model_output_limit",
    "provider_output_limit",
    "artifact_contract",
    "artifact_validation",
    "expected_output_contract",
    "expected_output_validation",
    "non_result",
    "non_result_output"
  ]);
  if (value !== null && value !== undefined && !Array.isArray(value)) {
    throw runtimeRouteContractError("runtime route failure summary is malformed");
  }
  const steps = Array.isArray(plan?.steps) ? plan.steps : [];
  const stepById = new Map(steps.map((step) => [String(step.id || ""), step]));
  const outputByStep = new Map((Array.isArray(outputs) ? outputs : []).map((output) => [
    String(output?.id || output?.step_id || ""),
    output
  ]));
  const summaries = new Map();
  for (const row of value || []) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw runtimeRouteContractError("runtime route failure summary contains a malformed row");
    }
    const stepId = String(row.step_id || "");
    const step = stepById.get(stepId);
    const output = outputByStep.get(stepId);
    if (!step || !output || summaries.has(stepId)) {
      throw runtimeRouteContractError(`runtime route failure summary has an unexpected or duplicate step: ${stepId || "missing"}`);
    }
    if (String(row.adapter || "") !== String(step.adapter || "") || output.execution_mode === "reused") {
      throw runtimeRouteContractError(`runtime route failure summary does not match planned step ${stepId}`);
    }
    const requestedClass = String(row.failure_class || "");
    const failureClass = Object.hasOwn(RUNTIME_ROUTE_FAILURE_STATUS, requestedClass)
      && requestedClass !== "route_validation_failed"
      ? requestedClass
      : "route_validation_failed";
    summaries.set(stepId, {
      failureClass,
      controllerSynthesisSafe: row.controller_synthesis_safe === true,
      retryable: typeof row.retryable === "boolean"
        ? row.retryable
        : retryableFailureClasses.has(failureClass),
      details: String(row.details || "").slice(0, 400),
      recommendedAction: String(row.recommended_action || "").slice(0, 80)
    });
  }

  return steps.flatMap((step) => {
    const stepId = String(step.id || "");
    const output = outputByStep.get(stepId);
    if (!output) return [];
    const outputClass = runtimeRouteOutputFailureClass(output);
    const summary = summaries.get(stepId) || null;
    if (!outputClass && !summary) return [];
    if (output.execution_mode === "reused") {
      throw runtimeRouteContractError(`runtime reused route failed validation for step ${stepId}`);
    }
    const failureClass = summary?.failureClass || outputClass || "route_validation_failed";
    const outputStatus = outputClass ? RUNTIME_ROUTE_FAILURE_STATUS[outputClass] || "blocked" : "failed";
    const summaryStatus = summary?.controllerSynthesisSafe === false
      ? "blocked"
      : RUNTIME_ROUTE_FAILURE_STATUS[failureClass] || "blocked";
    const status = outputStatus === "blocked" || summaryStatus === "blocked" ? "blocked" : "failed";
    return [{
      step_id: stepId,
      adapter: String(step.adapter || "").slice(0, 160),
      status,
      code: failureClass,
      retryable: summary?.retryable === true,
      details: summary?.details || "The route did not produce a validated result.",
      recommended_action: summary?.recommendedAction || (status === "failed" ? "select_alternate_or_retry" : "clarify_or_answer_directly"),
      failure_class: failureClass,
      controller_synthesis_safe: status === "failed",
      expected_outputs: boundedStringList(step.expected_outputs, 32, 160),
      fulfills: boundedStringList(step.fulfills, 24, 120),
      had_successful_tool_execution: (Array.isArray(output.tool_executions) ? output.tool_executions : [])
        .some((execution) => execution?.result?.ok === true)
    }];
  });
}

export function normalizeRuntimeRouting(routing) {
  if (!routing || typeof routing !== "object" || Array.isArray(routing)) {
    return null;
  }
  const selected = Array.isArray(routing.selected)
    ? routing.selected.slice(0, 64).flatMap((selection) => {
      if (!selection || typeof selection !== "object" || Array.isArray(selection)) return [];
      return [{
        adapter: boundedText(selection.adapter, 240),
        source: boundedText(selection.source, 120),
        confidence: finiteProbabilityOrNull(selection.confidence),
        reality_rank: finiteProbabilityOrNull(selection.reality_rank),
        reason: boundedText(selection.reason, 1000)
      }];
    }).filter((selection) => selection.adapter)
    : [];
  const rawOrchestrator = routing.orchestrator;
  const outcomeContract = normalizeRuntimeOutcomeContract(rawOrchestrator?.outcome_contract);
  const orchestrator = rawOrchestrator && typeof rawOrchestrator === "object" && !Array.isArray(rawOrchestrator)
    ? {
      contract_version: boundedText(rawOrchestrator.contract_version, 120),
      decision: boundedText(rawOrchestrator.decision, 40),
      model: boundedText(rawOrchestrator.model, 240),
      intent: boundedText(rawOrchestrator.intent, 600),
      evidence_requirement: ["live_external", "supplied_context", "none", "unknown"].includes(
        String(rawOrchestrator.evidence_requirement || "").trim().toLowerCase()
      ) ? String(rawOrchestrator.evidence_requirement).trim().toLowerCase() : "unknown",
      presentation_mode: ["integrated", "role_labeled", "owner_verbatim"].includes(
        String(rawOrchestrator.presentation_mode || "").trim().toLowerCase()
      ) ? String(rawOrchestrator.presentation_mode).trim().toLowerCase() : "integrated",
      requested_item_count: Number.isInteger(rawOrchestrator.requested_item_count)
        ? Math.max(0, Math.min(rawOrchestrator.requested_item_count, 100))
        : 0,
      required_capabilities: boundedStringList(rawOrchestrator.required_capabilities, 24, 240),
      missing_capabilities: boundedStringList(rawOrchestrator.missing_capabilities, 24, 240),
      clarification_question: boundedText(rawOrchestrator.clarification_question, 600),
      direct_answer: boundedText(rawOrchestrator.direct_answer, 4000),
      synthesis_brief: boundedText(rawOrchestrator.synthesis_brief, 1200),
      discovery_method: boundedText(rawOrchestrator.discovery_method, 120),
      authorized_agent_count: Math.max(0, Math.min(Number(rawOrchestrator.authorized_agent_count) || 0, 100000)),
      active_primary_agent_count: Math.max(0, Math.min(Number(rawOrchestrator.active_primary_agent_count) || 0, 16)),
      all_primary_agents_visible: rawOrchestrator.all_primary_agents_visible === true,
      discovered_candidate_count: Math.max(0, Math.min(Number(rawOrchestrator.discovered_candidate_count) || 0, 100000)),
      catalog_checked: boundedStringList(rawOrchestrator.catalog_checked, 64, 240),
      contract_protected_candidates: boundedStringList(rawOrchestrator.contract_protected_candidates, 16, 240),
      mentioned_agent_adapters: boundedStringList(rawOrchestrator.mentioned_agent_adapters, 16, 240),
      configured_agents_added: boundedStringList(rawOrchestrator.configured_agents_added, 64, 240),
      rejected_adapters: boundedStringList(rawOrchestrator.rejected_adapters, 24, 240),
      fallback_used: boundedText(rawOrchestrator.fallback_used, 120),
      planning_completion: rawOrchestrator.planning_completion && typeof rawOrchestrator.planning_completion === "object"
        ? {
          finish_reason: boundedText(rawOrchestrator.planning_completion.finish_reason, 80),
          complete: rawOrchestrator.planning_completion.complete === true,
          truncated: rawOrchestrator.planning_completion.truncated === true,
          json_object_valid: rawOrchestrator.planning_completion.json_object_valid === true,
          selection_schema_valid: rawOrchestrator.planning_completion.selection_schema_valid === true,
          selection_semantically_accepted: rawOrchestrator.planning_completion.selection_semantically_accepted === true,
          decision_discarded: rawOrchestrator.planning_completion.decision_discarded === true,
          semantic_fallback_reason: boundedText(rawOrchestrator.planning_completion.semantic_fallback_reason, 160)
        }
        : null,
      planning_provider_failure: rawOrchestrator.planning_provider_failure && typeof rawOrchestrator.planning_provider_failure === "object"
        ? {
          stage: boundedText(rawOrchestrator.planning_provider_failure.stage, 80),
          error_type: boundedText(rawOrchestrator.planning_provider_failure.error_type, 120),
          fallback_allowed: rawOrchestrator.planning_provider_failure.fallback_allowed === true
        }
        : null,
      semantic_adjudication: rawOrchestrator.semantic_adjudication
        && typeof rawOrchestrator.semantic_adjudication === "object"
        && !Array.isArray(rawOrchestrator.semantic_adjudication)
        ? {
          contract_version: boundedText(rawOrchestrator.semantic_adjudication.contract_version, 120),
          attempted: rawOrchestrator.semantic_adjudication.attempted === true,
          accepted: rawOrchestrator.semantic_adjudication.accepted === true,
          authority: boundedText(rawOrchestrator.semantic_adjudication.authority, 80),
          final_authority: boundedText(rawOrchestrator.semantic_adjudication.final_authority, 80),
          decision: boundedText(rawOrchestrator.semantic_adjudication.decision, 40),
          selected_adapters: boundedStringList(rawOrchestrator.semantic_adjudication.selected_adapters, 16, 240),
          changed_decision: rawOrchestrator.semantic_adjudication.changed_decision === true,
          changed_adapters: rawOrchestrator.semantic_adjudication.changed_adapters === true,
          primary_retained: rawOrchestrator.semantic_adjudication.primary_retained === true,
          repair_attempted: rawOrchestrator.semantic_adjudication.repair_attempted === true,
          repair_succeeded: rawOrchestrator.semantic_adjudication.repair_succeeded === true,
          errors: boundedStringList(rawOrchestrator.semantic_adjudication.errors, 24, 240),
          proposal: rawOrchestrator.semantic_adjudication.proposal
            && typeof rawOrchestrator.semantic_adjudication.proposal === "object"
            && !Array.isArray(rawOrchestrator.semantic_adjudication.proposal)
            ? {
              decision: boundedText(rawOrchestrator.semantic_adjudication.proposal.decision, 40),
              selected_adapters: boundedStringList(
                rawOrchestrator.semantic_adjudication.proposal.selected_adapters,
                16,
                240
              )
            }
            : null
        }
        : null,
      direct_decision_audit: rawOrchestrator.direct_decision_audit && typeof rawOrchestrator.direct_decision_audit === "object"
        ? {
          applied: rawOrchestrator.direct_decision_audit.applied === true,
          forced_delegation: rawOrchestrator.direct_decision_audit.forced_delegation === true,
          reason: boundedText(rawOrchestrator.direct_decision_audit.reason, 160),
          matched_adapters: boundedStringList(rawOrchestrator.direct_decision_audit.matched_adapters, 16, 240),
          selected_adapters: boundedStringList(rawOrchestrator.direct_decision_audit.selected_adapters, 16, 240),
          declared_output_matches: (Array.isArray(rawOrchestrator.direct_decision_audit.declared_output_matches)
            ? rawOrchestrator.direct_decision_audit.declared_output_matches
            : []).slice(0, 16).flatMap((match) => (
            match && typeof match === "object" && !Array.isArray(match)
              ? [{
                output: boundedText(match.output, 160),
                phrase: boundedText(match.phrase, 160),
                adapter: boundedText(match.adapter, 240)
              }]
              : []
          ))
        }
        : null,
      ...(rawOrchestrator.outcome_contract_fallback
        && typeof rawOrchestrator.outcome_contract_fallback === "object"
        && !Array.isArray(rawOrchestrator.outcome_contract_fallback)
        ? { outcome_contract_fallback: {
          applied: rawOrchestrator.outcome_contract_fallback.applied === true,
          reason: boundedText(rawOrchestrator.outcome_contract_fallback.reason, 160),
          violations: boundedStringList(rawOrchestrator.outcome_contract_fallback.violations, 32, 200),
          advisories: boundedStringList(rawOrchestrator.outcome_contract_fallback.advisories, 32, 200),
          selected_adapters: boundedStringList(rawOrchestrator.outcome_contract_fallback.selected_adapters, 16, 240),
          diagnostic_contract: normalizeRuntimeOutcomeContract(
            rawOrchestrator.outcome_contract_fallback.diagnostic_contract
          )
        } }
        : {}),
      planning_call_performed: rawOrchestrator.planning_call_performed === true,
      final_synthesis_required: rawOrchestrator.final_synthesis_required === true,
      ...(outcomeContract ? { outcome_contract: outcomeContract } : {})
    }
    : null;
  return {
    mode: boundedText(routing.mode, 80),
    candidate_count: Math.max(0, Math.min(Number(routing.candidate_count) || 0, 100000)),
    candidate_adapters: boundedStringList(routing.candidate_adapters, 256, 240),
    candidate_trace: Array.isArray(routing.candidate_trace)
      ? routing.candidate_trace.slice(0, 256).flatMap((candidate) => {
        if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
        const adapter = boundedText(candidate.adapter, 240);
        if (!adapter) return [];
        return [{
          adapter,
          cue_score: finiteNonNegativeOrNull(candidate.cue_score),
          reality_rank: finiteProbabilityOrNull(candidate.reality_rank),
          rank_supplied: candidate.rank_supplied === true
        }];
      })
      : [],
    selected,
    explicit_adapters: boundedStringList(routing.explicit_adapters, 64, 240),
    unresolved_mentions: boundedStringList(routing.unresolved_mentions, 64, 500),
    out_of_scope: routing.out_of_scope === true,
    reason: boundedText(routing.reason, 1000),
    fallback: boundedText(routing.fallback, 240),
    orchestrator
  };
}

function normalizeRuntimeRouteAdmissionSteps(value) {
  if (!Array.isArray(value)) return [];
  const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
  const stringList = (items, maximum, maxChars) => {
    if (items == null) return { rows: [], valid: true };
    if (!Array.isArray(items) || items.length > maximum || items.some((item) => typeof item !== "string")) {
      return { rows: [], valid: false };
    }
    const rows = [];
    let valid = true;
    for (const item of items) {
      const normalized = boundedText(item, maxChars);
      if (!identifierPattern.test(normalized)) valid = false;
      if (normalized && !rows.includes(normalized)) rows.push(normalized);
    }
    return { rows, valid };
  };
  return value.slice(0, 64).map((rawStep) => {
    if (!rawStep || typeof rawStep !== "object" || Array.isArray(rawStep)) {
      return {
        step_id: "",
        route_admission_valid: false,
        route_dependency_closure_valid: false
      };
    }
    const rawAdmission = rawStep.route_admission;
    if (!rawAdmission || typeof rawAdmission !== "object" || Array.isArray(rawAdmission)) {
      return {
        step_id: boundedText(rawStep.step_id, 120),
        route_admission_valid: false,
        route_dependency_closure_valid: false
      };
    }
    const deliverables = stringList(rawAdmission.deliverable_ids, 24, 120);
    const outputs = stringList(rawAdmission.expected_outputs, 32, 120);
    const constraints = stringList(rawAdmission.strict_constraints_checked, 24, 120);
    const violations = stringList(rawAdmission.violations, 64, 120);
    const advisories = stringList(rawAdmission.advisories, 64, 160);
    const rawBindings = rawAdmission.downstream_bindings == null ? [] : rawAdmission.downstream_bindings;
    let bindingsValid = Array.isArray(rawBindings) && rawBindings.length <= 64;
    const downstreamBindings = (Array.isArray(rawBindings) ? rawBindings : []).slice(0, 64).flatMap((binding) => {
      if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
        bindingsValid = false;
        return [];
      }
      const normalized = {
        consumer_step_id: boundedText(binding.consumer_step_id, 120),
        consumer_adapter: boundedText(binding.consumer_adapter, 120),
        input: boundedText(binding.input, 120),
        output: boundedText(binding.output, 120)
      };
      if (Object.values(normalized).some((item) => !identifierPattern.test(item))) bindingsValid = false;
      return [normalized];
    });
    const shapeValid = deliverables.valid && outputs.valid && constraints.valid
      && violations.valid && advisories.valid && bindingsValid;
    return {
      step_id: boundedText(rawStep.step_id, 120),
      route_admission_valid: rawStep.route_admission_valid === true && shapeValid,
      route_dependency_closure_valid: rawStep.route_dependency_closure_valid === true,
      route_admission: {
        contract_version: boundedText(rawAdmission.contract_version, 120),
        valid: rawAdmission.valid === true && shapeValid,
        route_role: boundedText(rawAdmission.route_role, 80),
        obligation_source: boundedText(rawAdmission.obligation_source, 120),
        deliverable_ids: deliverables.rows,
        expected_outputs: outputs.rows,
        downstream_bindings: downstreamBindings,
        strict_constraints_checked: constraints.rows,
        violations: violations.rows,
        advisories: advisories.rows,
        obligation: boundedText(rawAdmission.obligation, 1200)
      }
    };
  });
}

function normalizeRuntimeOutcomeContract(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const semanticAuthority = boundedText(raw.semantic_authority, 120);
  const evidenceModes = new Set(["live_external", "supplied_context", "none", "unknown"]);
  const deliverables = Array.isArray(raw.deliverables)
    ? raw.deliverables.slice(0, 24).flatMap((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const id = boundedText(item.id, 120);
      if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/.test(id)) return [];
      const evidence = String(item.evidence_requirement || "unknown").trim().toLowerCase();
      return [{
        id,
        title: boundedText(item.title || id, 160),
        description: boundedText(item.description, 600),
        required: item.required !== false,
        evidence_requirement: evidenceModes.has(evidence) ? evidence : "unknown",
        required_outputs: boundedStringList(item.required_outputs, 32, 160),
        controller_can_synthesize: item.controller_can_synthesize === true,
        assigned_to_session_controller: item.assigned_to_session_controller === true
      }];
    })
    : [];
  const coverage = Array.isArray(raw.coverage)
    ? raw.coverage.slice(0, 24).flatMap((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const deliverableId = boundedText(item.deliverable_id, 120);
      if (!deliverableId) return [];
      return [{
        deliverable_id: deliverableId,
        covered: item.covered === true,
        fulfilling_steps: boundedStringList(item.fulfilling_steps, 64, 120),
        controller_synthesis: item.controller_synthesis === true
      }];
    })
    : [];
  return {
    contract_version: boundedText(raw.contract_version, 120),
    compiler_authority: raw.compiler_authority === "runtime" ? "runtime" : "",
    // Preserve an invalid sentinel so a malformed/future status cannot be
    // silently converted into the now-valid blocked-clarification state.
    status: ["covered", "blocked", "not_applicable"].includes(raw.status) ? raw.status : "invalid",
    route_admission_contract_version: boundedText(raw.route_admission_contract_version, 120),
    deliverables,
    steps: normalizeRuntimeRouteAdmissionSteps(raw.steps),
    coverage,
    violations: boundedStringList(raw.violations, 64, 200),
    advisories: boundedStringList(raw.advisories, 64, 200),
    // The provider-neutral authority is canonical. Preserve the former Qwen
    // transport spelling only at ingress, then project one stable contract to
    // the rest of the web application.
    semantic_authority: semanticAuthority === "qwen_model_led"
      ? "semantic_model_led"
      : semanticAuthority,
    inferred_deliverables: raw.inferred_deliverables === true,
    inferred_fulfills: Array.isArray(raw.inferred_fulfills)
      ? raw.inferred_fulfills.slice(0, 64).flatMap((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return [];
        const deliverableId = boundedText(item.deliverable_id, 120);
        const stepId = boundedText(item.step_id, 120);
        return deliverableId && stepId ? [{ deliverable_id: deliverableId, step_id: stepId }] : [];
      })
      : []
  };
}

export function enrichRuntimeRoutingTrace(plan, agentRankings, agents) {
  if (!plan?.routing) return plan;
  const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
  const enrich = (candidate) => {
    const ranking = agentRankings[candidate.adapter];
    const agent = agentsById.get(candidate.adapter);
    return {
      ...candidate,
      reality_rank: ranking ? ranking.score : candidate.reality_rank ?? 0.5,
      rank_sample_size: Math.max(0, Number(ranking?.sample_size) || 0),
      rank_supplied: ranking ? ranking.routing_eligible === true : candidate.rank_supplied === true,
      agent_revision: ranking?.agent_revision || (agent ? agentRevision(agent) : null)
    };
  };
  const traceById = new Map((plan.routing.candidate_trace || []).map((candidate) => [candidate.adapter, candidate]));
  for (const adapter of plan.routing.candidate_adapters || []) {
    if (!traceById.has(adapter)) traceById.set(adapter, { adapter });
  }
  plan.routing.candidate_trace = [...traceById.values()].slice(0, 256).map(enrich);
  plan.routing.selected = (plan.routing.selected || []).slice(0, 256).map(enrich);
  return plan;
}

export function boundedStringList(value, maxItems, maxChars) {
  return Array.isArray(value)
    ? value.slice(0, maxItems).map((item) => boundedText(item, maxChars)).filter(Boolean)
    : [];
}

function finiteNonNegativeOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

export function runtimeOutputToRunStep({ run_id, output, parallel, step = null, failure = null }) {
  const reused = output.execution_mode === "reused";
  const failed = Boolean(failure);
  // Reused output is authorized replay material, not a new worker turn. Do
  // not persist free-form runtime narration, prompts, raw text, model calls,
  // or timing claims that are outside the replay digest.
  const sections = reused ? parseRouteSections("") : parseRouteSections(output.text || output.raw_text || "");
  const trustedStep = step || {};
  const batch = output.parallel_batch || findBatchForStep(parallel, output.id);
  const width = output.parallel_width || parallel?.batches?.find((item) => item.batch === batch)?.width || 1;
  return {
    run_step_id: makeId("run_step"),
    run_id,
    step_id: trustedStep.id || output.id || output.step_id,
    adapter: trustedStep.adapter || output.adapter,
    agent_revision: normalizeSha256Digest(output.agent_revision),
    adapter_digest: normalizeSha256Digest(output.agent_content_digest || output.adapter_content_digest || output.adapter_digest),
    model_id: agentRuntimeOutputModelId(output),
    model_calls_admin_only: normalizeArtifactValue(reused ? [] : output.model_calls || []),
    task: trustedStep.task || output.task || "",
    depends_on: trustedStep.depends_on || output.depends_on || [],
    used_upstream: output.used_upstream || [],
    parallel_batch: batch,
    parallel_width: width,
    status: failure?.status || "completed",
    execution_mode: reused ? "reused" : "refreshed",
    reused_from_artifact_id: output.reused_from_artifact_id || null,
    reused_from_run_id: output.reused_from_run_id || null,
    world_graph_reason: reused ? "inputs_and_evidence_unchanged" : output.world_graph_reason || null,
    agent_reasoning: failed || reused ? "" : output.agent_reasoning || sections.agent_reasoning,
    domain_answer: failed ? "" : output.domain_answer || sections.domain_answer,
    handoffs: failed || reused ? "" : typeof output.handoffs === "string" ? output.handoffs : sections.handoffs,
    handoff_artifacts: failed ? [] : normalizeHandoffArtifacts(output.handoff_artifacts || output.handoffs, output),
    artifact_validation: failed ? { valid: output.artifact_validation?.valid === true } : normalizeArtifactValue(output.artifact_validation || {}),
    outcome_validation: failed ? { valid: output.outcome_validation?.valid === true } : normalizeArtifactValue(output.outcome_validation || {}),
    consumed_artifacts: failed ? [] : normalizeArtifactValue(output.consumed_artifacts || []),
    consumption_validation: failed ? { valid: output.consumption_validation?.valid === true } : normalizeArtifactValue(output.consumption_validation || {}),
    source_validation: failed ? { valid: output.source_validation?.valid === true } : normalizeArtifactValue(output.source_validation || {}),
    terminal_fan_in_recovery: failed ? null : normalizeArtifactValue(output.terminal_fan_in_recovery || null),
    used_memory: failed ? [] : normalizeArtifactValue(output.used_memory || []),
    boundary_check: failed ? "" : output.boundary_check || sections.boundary_check,
    allowed_tools: output.allowed_tools || [],
    tool_executions: safeRuntimeToolExecutions(output.tool_executions),
    approved_sources: output.approved_sources || [],
    policy_violations: failed ? [] : output.policy_violations || [],
    retrieved_context: failed ? "" : output.retrieved_context || sections.retrieved_context,
    citations: failed ? [] : runtimeCitations([output]),
    failure: failure ? normalizeArtifactValue(failure) : null,
    failure_observability_admin_only: failed
      ? runtimeRouteFailureObservability(output)
      : null,
    execution_error_admin_only: failed
      ? normalizeArtifactValue(output.execution_error_admin_only || output.execution_error || null)
      : null,
    raw_text_admin_only: reused ? "" : output.raw_text || output.text || "",
    prompt_preview_admin_only: reused ? "" : output.prompt_preview || "",
    started_at: nowIso(),
    completed_at: nowIso(),
    elapsed_sec: reused ? 0 : output.elapsed_sec || null
  };
}

export function safeRuntimeToolExecutions(value) {
  return (Array.isArray(value) ? value : []).slice(0, 64).map((execution) => ({
    id: boundedText(execution?.id, 120),
    name: boundedText(execution?.name, 120),
    result: {
      ok: execution?.result?.ok === true,
      available: execution?.result?.available !== false,
      tool: boundedText(execution?.result?.tool || execution?.name, 120),
      data_digest: execution?.result?.data === undefined ? null : digestValue(execution.result.data)
    },
    arguments_redacted: true,
    result_data_redacted: true
  }));
}

function findBatchForStep(parallel, stepId) {
  return parallel?.batches?.find((batch) => (batch.steps || []).includes(stepId))?.batch || null;
}

export function runtimeCitations(outputs) {
  return outputs.flatMap((output) => {
    if (Array.isArray(output.citations)) {
      return output.citations
        .slice(0, 32)
        .map((citation) => normalizeRuntimeCitation(citation, output))
        .filter(Boolean);
    }
    const context = output.retrieved_context || parseRouteSections(output.text || "").retrieved_context || "";
    if (!context) return [];
    return context.split(/\n+/).filter(Boolean).slice(0, 8).map((line, index) => {
      const [label, ...rest] = line.split(" - ");
      return {
        citation_id: stableCitationId({
          step_id: output.id,
          agent_id: output.adapter,
          chunk_id: label?.split(":")[0] || `${output.id}_${index + 1}`,
          excerpt: rest.join(" - ") || line
        }),
        step_id: output.id,
        agent_id: output.adapter,
        path: "",
        chunk_id: label?.split(":")[0] || `${output.id}_${index + 1}`,
        title: label?.split(":").slice(1).join(":") || output.adapter,
        page_start: null,
        page_end: null,
        score: null,
        excerpt: rest.join(" - ") || line,
        injected: true,
        claim: "",
        verified: false
      };
    });
  });
}

function normalizeRuntimeCitation(citation, output) {
  if (!citation || typeof citation !== "object" || Array.isArray(citation)) {
    return null;
  }
  const chunkId = boundedText(citation.chunk_id, 240);
  const title = boundedText(citation.title, 500);
  const excerpt = boundedText(citation.excerpt, 4000);
  if (!chunkId && !title && !excerpt) {
    return null;
  }
  const requestedPath = String(citation.path || "").replaceAll("\\", "/");
  if (requestedPath && !isApprovedCitationPath(requestedPath, output.approved_sources || [])) {
    return null;
  }
  const pageStart = positiveIntegerOrNull(citation.page_start ?? citation.page);
  const requestedEnd = positiveIntegerOrNull(citation.page_end ?? citation.page);
  const pageEnd = pageStart && requestedEnd && requestedEnd >= pageStart ? requestedEnd : pageStart;
  const numericScore = Number(citation.score);
  const contentDigest = normalizeSha256Digest(citation.content_digest);
  const corpusRevision = normalizeSha256Digest(citation.corpus_revision);
  const indexDigest = normalizeSha256Digest(citation.index_digest);
  const documentChunk = requestedPath.includes("/chunks/")
    && (output.approved_sources || []).some((source) => String(source || "").replaceAll("\\", "/").endsWith("/index.jsonl"));
  const integrityBound = !documentChunk || Boolean(contentDigest && corpusRevision && indexDigest);
  return {
    citation_id: stableCitationId({
      step_id: output.id,
      agent_id: output.adapter,
      path: requestedPath,
      chunk_id: chunkId,
      page_start: pageStart,
      page_end: pageEnd,
      content_digest: contentDigest,
      corpus_revision: corpusRevision,
      index_digest: indexDigest,
      excerpt
    }),
    step_id: output.id,
    agent_id: output.adapter,
    path: requestedPath,
    chunk_id: chunkId,
    title: title || output.adapter,
    page_start: pageStart,
    page_end: pageEnd,
    content_digest: contentDigest,
    corpus_revision: corpusRevision,
    index_digest: indexDigest,
    score: Number.isFinite(numericScore) ? numericScore : null,
    excerpt,
    injected: citation.injected !== false,
    claim: boundedText(citation.claim, 2000),
    verified: citation.verified === true
      && Boolean(chunkId)
      && integrityBound
      && (!requestedPath || isApprovedCitationPath(requestedPath, output.approved_sources || []))
  };
}

export function isApprovedCitationPath(sourcePath, approvedSources) {
  const normalized = String(sourcePath || "").replaceAll("\\", "/");
  const approvedRoots = [
    AGENT_DOCUMENT_SOURCE_ROOT,
    AGENT_SOURCE_ROOT,
    PERSISTED_DOCUMENT_SOURCE_ROOT,
    PERSISTED_AGENT_SOURCE_ROOT
  ];
  if (
    normalized.startsWith("/") ||
    normalized.includes("..") ||
    !approvedRoots.some((root) => normalized.startsWith(`${root}/`))
  ) {
    return false;
  }
  const approved = (approvedSources || []).map((value) => String(value || "").replaceAll("\\", "/"));
  if (approved.length === 0) {
    return false;
  }
  return approved.some((allowedPath) => {
    if (normalized === allowedPath) return true;
    if (allowedPath.endsWith("/index.jsonl")) {
      return normalized.startsWith(`${allowedPath.slice(0, -"index.jsonl".length)}chunks/`);
    }
    return false;
  });
}

function positiveIntegerOrNull(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function stableCitationId(value) {
  return `cit_${digestValue(value).slice("sha256:".length, "sha256:".length + 24)}`;
}

export function boundedText(value, maxChars) {
  return Array.from(String(value || "").replaceAll("\0", "").trim())
    .slice(0, maxChars)
    .join("");
}

function normalizeHandoffArtifacts(value, output) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.slice(0, 32).flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return [];
    }
    const artifact = boundedText(item.artifact || item.name || item.type, 160);
    const artifactValue = item.value ?? item.content ?? item.data;
    if (!artifact || artifactValue === undefined || artifactValue === null || artifactValue === "") {
      return [];
    }
    return [{
      artifact_id: item.artifact_id || `artifact_${digestValue({
        step_id: output.id || output.step_id || null,
        name: artifact,
        value: artifactValue
      }).slice("sha256:".length, "sha256:".length + 24)}`,
      schema_version: boundedText(item.schema_version || "tcar-handoff-artifact-v1", 120),
      name: artifact,
      artifact,
      producer_step_id: output.id || output.step_id || null,
      producer_agent_id: output.adapter || null,
      producer: output.adapter || null,
      content_type: boundedText(item.content_type || "application/json", 120),
      value: normalizeArtifactValue(artifactValue),
      content_digest: normalizeSha256Digest(item.content_digest) || digestValue(normalizeArtifactValue(artifactValue)),
      evidence: boundedStringList(item.evidence || item.citations, 50, 240),
      confidence: finiteProbabilityOrNull(item.confidence),
      status: boundedText(item.status || "runtime_structured", 120),
      verified: item.verified === true
    }];
  });
}

export function normalizeArtifactValue(value) {
  if (typeof value === "string") {
    return boundedText(value, 12000);
  }
  if (["number", "boolean"].includes(typeof value)) {
    return value;
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return boundedText(value, 12000);
  }
}

export function finiteProbabilityOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : null;
}

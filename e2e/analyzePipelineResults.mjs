/* global console, process */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  JUNK_AGENT_DENYLIST,
  PIPELINE_SCENARIOS
} from "./pipelineScenarios.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(here, "../../..");
const defaultOutputPath = path.join(
  repositoryRoot,
  "outputs/virenis_pipeline_e2e_20260719/raw_results.json"
);
const defaultAgentLibraryPath = path.join(repositoryRoot, "configs/router_agent_library.json");
const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "cancelled"]);
const VALIDATION_FIELDS = [
  "source_validation",
  "consumption_validation",
  "artifact_validation",
  "outcome_validation"
];
const DOCUMENT_TOOLS = new Set(["document_search", "document_read"]);
const ADMIN_COUNTER_DEFINITIONS = Object.freeze([
  Object.freeze({ key: "chats", label: "Chat sessions", endpointField: "total_chats" }),
  Object.freeze({ key: "run_records", label: "Run records", endpointField: "total_run_records" }),
  Object.freeze({ key: "completed_runs", label: "Completed runs", endpointField: "completed_runs" }),
  Object.freeze({ key: "failed_runs", label: "Failed runs", endpointField: "failed_runs" }),
  Object.freeze({ key: "selected_routes", label: "Selected routes", endpointField: "selected_route_count" }),
  Object.freeze({ key: "attempted_routes", label: "Attempted fresh routes", endpointField: "attempted_route_count" }),
  Object.freeze({ key: "validated_routes", label: "Validated fresh routes", endpointField: "validated_route_count" }),
  Object.freeze({ key: "failed_routes", label: "Failed routes (including blocked)", endpointField: "failed_route_count" }),
  Object.freeze({ key: "blocked_routes", label: "Blocked routes", endpointField: "blocked_route_count" }),
  Object.freeze({ key: "reused_routes", label: "Reused routes", endpointField: "reused_route_count" })
]);

// This is a fail-safe for callers that analyze an in-memory fixture without
// loading the repository's agent library. The CLI always derives this mapping
// from configs/router_agent_library.json, so configuration remains the source
// of truth for benchmark reports.
export const FALLBACK_CONFIGURED_DEPENDENCIES = Object.freeze({
  solution_brainstormer_35b3a384: Object.freeze([
    "ai_advocate_2635a7eaa9",
    "ai_skeptic_8a2e3280"
  ]),
  business_analyst_b58a83b97d: Object.freeze(["market_researcher_71c4134e56"]),
  custom_rjsfcke: Object.freeze(["business_analyst"]),
  financial_analysis_14e44ddf75: Object.freeze([
    "finance_reasoning"
  ]),
  frontend_developer_c0dfb5da: Object.freeze(["ui_specialist_c72b37f5"]),
  feasibility_originality_agent_copy_f0cb6594: Object.freeze([
    "divergent_ideas_agent_copy_1136defa",
    "perspective_shift_agent_copy_e01172ac"
  ]),
  brainstorming_facilitator_agent_copy_6cf6696c: Object.freeze([
    "divergent_ideas_agent_copy_1136defa",
    "perspective_shift_agent_copy_e01172ac",
    "feasibility_originality_agent_copy_f0cb6594"
  ])
});

function values(value) {
  return Array.isArray(value) ? value : [];
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function unique(items) {
  return [...new Set(items.map(text).filter(Boolean))];
}

function finite(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function counter(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function rounded(value, digits = 6) {
  if (!Number.isFinite(value)) return null;
  return Number(value.toFixed(digits));
}

function ratio(successes, total) {
  return total > 0 ? rounded(successes / total) : null;
}

export function wilson95(successes, total) {
  if (!(total > 0)) return { low: null, high: null };
  const z = 1.959963984540054;
  const proportion = successes / total;
  const zSquared = z * z;
  const denominator = 1 + zSquared / total;
  const center = (proportion + zSquared / (2 * total)) / denominator;
  const margin = (
    z * Math.sqrt((proportion * (1 - proportion) + zSquared / (4 * total)) / total)
  ) / denominator;
  return {
    low: rounded(Math.max(0, center - margin)),
    high: rounded(Math.min(1, center + margin))
  };
}

function rateMetric(successes, total) {
  return {
    successes,
    total,
    rate: ratio(successes, total),
    wilson_95: wilson95(successes, total)
  };
}

function interpolatePercentile(sorted, percentile) {
  if (!sorted.length) return null;
  if (sorted.length === 1) return sorted[0];
  const position = (sorted.length - 1) * percentile;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function distribution(numbers) {
  const sample = numbers.map(finite).filter((value) => value !== null).sort((left, right) => left - right);
  if (!sample.length) return { unit: "seconds", samples: 0, mean: null, p50: null, p95: null, min: null, max: null };
  return {
    unit: "seconds",
    samples: sample.length,
    mean: rounded(sample.reduce((total, value) => total + value, 0) / sample.length, 3),
    p50: rounded(interpolatePercentile(sample, 0.5), 3),
    p95: rounded(interpolatePercentile(sample, 0.95), 3),
    min: rounded(sample[0], 3),
    max: rounded(sample.at(-1), 3)
  };
}

function numericDistribution(numbers, unit, digits = 3) {
  const sample = numbers.map(finite).filter((value) => value !== null).sort((left, right) => left - right);
  if (!sample.length) return { unit, samples: 0, mean: null, p50: null, p95: null, min: null, max: null };
  return {
    unit,
    samples: sample.length,
    mean: rounded(sample.reduce((total, value) => total + value, 0) / sample.length, digits),
    p50: rounded(interpolatePercentile(sample, 0.5), digits),
    p95: rounded(interpolatePercentile(sample, 0.95), digits),
    min: rounded(sample[0], digits),
    max: rounded(sample.at(-1), digits)
  };
}

function secondsBetween(start, end) {
  const startMs = Date.parse(start || "");
  const endMs = Date.parse(end || "");
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return null;
  return (endMs - startMs) / 1000;
}

export function dependencyMapFromAgentLibrary(library) {
  const adapters = values(library?.adapters || library?.agents);
  return Object.fromEntries(adapters.map((adapter) => {
    const dependencies = [
      ...values(adapter?.consumes).flatMap((item) => {
        const match = /^agent:([^:]+):output$/.exec(text(item));
        return match ? [match[1]] : [];
      }),
      ...values(adapter?.resources).flatMap((item) => {
        const match = /^agent:([^:]+)$/.exec(text(item));
        return match ? [match[1]] : [];
      })
    ];
    return [text(adapter?.id), unique(dependencies)];
  }).filter(([agentId, dependencies]) => agentId && dependencies.length));
}

function dependencyClosure(seedAgentIds, dependencyMap) {
  const allowed = new Set(unique(seedAgentIds));
  const pending = [...allowed];
  while (pending.length) {
    const agentId = pending.pop();
    for (const dependency of values(dependencyMap?.[agentId])) {
      const normalized = text(dependency);
      if (!normalized || allowed.has(normalized)) continue;
      allowed.add(normalized);
      pending.push(normalized);
    }
  }
  return allowed;
}

function attachmentAgentId(attachment) {
  return text(
    attachment?.agent_id
    || attachment?.document?.agent_id
    || attachment?.registration?.agent_id
  );
}

function routeKey(item, fallback) {
  const stepId = text(item?.step_id || item?.id);
  return stepId ? `step:${stepId}` : fallback;
}

function invalidValidation(output) {
  return VALIDATION_FIELDS.some((field) => (
    Object.prototype.hasOwnProperty.call(output || {}, field)
    && output?.[field]?.valid !== true
  ));
}

function routeFacts(run) {
  if (!run || typeof run !== "object") return [];
  const facts = new Map();
  const byAdapter = new Map();
  const ensure = (item, fallback) => {
    let key = routeKey(item, fallback);
    const adapter = text(item?.adapter);
    if (!key.startsWith("step:") && adapter && byAdapter.get(adapter)?.length === 1) {
      key = byAdapter.get(adapter)[0];
    }
    if (!facts.has(key)) {
      facts.set(key, {
        key,
        step_id: text(item?.step_id || item?.id),
        adapter,
        selected: false,
        plan_step: null,
        output: null,
        events: []
      });
      if (adapter) byAdapter.set(adapter, [...(byAdapter.get(adapter) || []), key]);
    }
    const fact = facts.get(key);
    if (!fact.adapter && adapter) fact.adapter = adapter;
    if (!fact.step_id) fact.step_id = text(item?.step_id || item?.id);
    return fact;
  };

  for (const [index, step] of values(run?.plan?.steps).entries()) {
    const fact = ensure(step, `plan:${text(step?.adapter) || "unknown"}:${index}`);
    fact.selected = true;
    fact.plan_step = step;
  }
  for (const [index, output] of values(run?.expert_outputs || run?.run_steps).entries()) {
    const fact = ensure(output, `output:${text(output?.adapter) || "unknown"}:${index}`);
    fact.output = output;
  }
  for (const [index, event] of values(run?.events).entries()) {
    if (!["route.started", "route.completed", "route.failed", "route.reused"].includes(text(event?.type))) continue;
    const fact = ensure(event, `event:${text(event?.adapter) || "unknown"}:${index}`);
    fact.events.push(event);
  }

  return [...facts.values()].map((fact) => {
    const output = fact.output || {};
    const eventTypes = new Set(fact.events.map((event) => text(event?.type)));
    const failedEvent = fact.events.find((event) => text(event?.type) === "route.failed") || null;
    const outputStatus = text(output?.status).toLowerCase();
    const failureStatus = text(failedEvent?.status || output?.failure?.status).toLowerCase();
    const reused = output?.execution_mode === "reused" || eventTypes.has("route.reused");
    const attempted = !reused && Boolean(
      fact.output
      || eventTypes.has("route.started")
      || eventTypes.has("route.completed")
      || eventTypes.has("route.failed")
    );
    const validationFailure = invalidValidation(output);
    const policyFailure = values(output?.policy_violations).length > 0;
    const blocked = attempted && (outputStatus === "blocked" || failureStatus === "blocked");
    const explicitFailure = eventTypes.has("route.failed")
      || ["failed", "cancelled"].includes(outputStatus)
      || failureStatus === "failed"
      || Boolean(output?.failure || output?.failure_class)
      || validationFailure
      || policyFailure;
    const failed = attempted && !blocked && explicitFailure;
    const successSignal = eventTypes.has("route.completed")
      || outputStatus === "completed"
      || (fact.output && run.status === "completed" && !explicitFailure);
    const validated = attempted && !blocked && !failed && successSignal;
    return {
      step_id: fact.step_id,
      adapter: fact.adapter,
      selected: fact.selected,
      attempted,
      validated,
      failed,
      blocked,
      reused,
      outstanding: attempted && !validated && !failed && !blocked,
      elapsed_sec: reused ? null : finite(output?.elapsed_sec || failedEvent?.elapsed_sec),
      failure_class: text(failedEvent?.failure_class || output?.failure?.failure_class) || null
    };
  });
}

function toolFacts(run) {
  return values(run?.expert_outputs || run?.run_steps).flatMap((output) => (
    values(output?.tool_executions).map((execution) => ({
      agent_id: text(output?.adapter),
      name: text(execution?.name || execution?.tool || execution?.result?.tool),
      ok: execution?.result?.ok === true
    }))
  ));
}

function sourceCount(run) {
  return values(run?.sources || run?.citations).length;
}

function observableNonResult(answer) {
  const value = text(answer);
  return Boolean(value && (
    /^I couldn't complete this request because the delegated work produced no validated result\b/i.test(value)
    || /^I cannot provide a source-grounded answer from the approved excerpts because\b/i.test(value)
    || /^I cannot provide a validated result until (?:the )?required\b/i.test(value)
    || /^The selected team cannot yet produce every required outcome with its configured outputs, inputs, sources, and tools\b/i.test(value)
    || /^I could not complete [^\r\n]{1,180} from the validated information available in this run\.\s*$/i.test(value)
  ));
}

function observablePartialNonResult(answer) {
  const value = text(answer);
  if (!value) return false;
  const terminalNotice = /(?:\r?\n){2,}I could not complete [^\r\n]{1,180} from the validated information available in this run\.\s*$/i.exec(value);
  return Boolean(terminalNotice && text(value.slice(0, terminalNotice.index)));
}

function requestedScenarioIds(raw, scenarios, observedIds) {
  const scenarioIds = unique(raw?.scenario_ids || raw?.requested_scenario_ids || []);
  if (scenarioIds.length) return scenarioIds;
  if (Number(raw?.scenario_count) === scenarios.length) return scenarios.map((scenario) => scenario.id);
  return observedIds;
}

function buildScenarioScore({ scenario, result, dependencyMap, junkAgentIds }) {
  const run = result?.run || null;
  const usageReceipt = run?.usage_receipt && typeof run.usage_receipt === "object"
    ? run.usage_receipt
    : null;
  const facts = routeFacts(run);
  const selectedFacts = facts.filter((fact) => fact.selected);
  const selectedAgents = unique(selectedFacts.map((fact) => fact.adapter));
  const requiredAgents = unique(scenario.requiredAgents);
  const forbiddenAgents = new Set(unique(scenario.forbiddenAgents));
  const attachmentAgent = attachmentAgentId(result?.attachment);
  const effectiveAllowed = dependencyClosure(
    [...unique(scenario.allowedAgents), attachmentAgent],
    dependencyMap
  );
  const requiredMissing = requiredAgents.filter((agentId) => !selectedAgents.includes(agentId));
  const forbiddenSelected = selectedAgents.filter((agentId) => forbiddenAgents.has(agentId));
  const junkSelected = selectedAgents.filter((agentId) => junkAgentIds.has(agentId));
  const disallowedSelected = selectedAgents.filter((agentId) => !effectiveAllowed.has(agentId));
  const allowedSelectedCount = selectedFacts.filter((fact) => effectiveAllowed.has(fact.adapter)).length;
  const decision = text(run?.plan?.routing?.orchestrator?.decision).toLowerCase() || null;
  const decisionCorrect = Boolean(run) && decision === scenario.expectedDecision;
  const falseDelegation = ["direct", "clarify"].includes(scenario.expectedDecision)
    && Boolean(run)
    && (decision === "delegate" || selectedFacts.length > 0);
  const attachmentRouteSuccess = !scenario.needsAttachment
    || Boolean(attachmentAgent && selectedAgents.includes(attachmentAgent));
  const exactGraphSuccess = Boolean(run)
    && requiredMissing.length === 0
    && forbiddenSelected.length === 0
    && attachmentRouteSuccess;
  const allowedGraphSuccess = exactGraphSuccess && disallowedSelected.length === 0;
  const tools = toolFacts(run);
  const citations = sourceCount(run);
  const runStatus = text(run?.status).toLowerCase() || "no_run";
  const createdSessionId = text(result?.session_id);
  const runSessionId = text(run?.session_id);
  const sessionBindingObserved = Boolean(createdSessionId && runSessionId);
  const sessionMatchesRun = sessionBindingObserved
    ? createdSessionId === runSessionId
    : null;
  const nonResult = runStatus === "completed" && observableNonResult(run?.final_answer);
  const partialNonResult = runStatus === "completed"
    && !nonResult
    && observablePartialNonResult(run?.final_answer);
  const validatedSingleRoute = selectedFacts.length === 1
    && selectedFacts[0]?.validated
    ? values(run?.expert_outputs || run?.run_steps).find((output) => (
      text(output?.step_id || output?.id) === selectedFacts[0].step_id
      && text(output?.adapter) === selectedFacts[0].adapter
    )) || null
    : null;
  const singleRouteDomainLength = text(validatedSingleRoute?.domain_answer).length;
  const finalAnswerLength = text(run?.final_answer).length;
  const singleRouteRetentionEligible = Boolean(
    runStatus === "completed"
    && !nonResult
    && !partialNonResult
    && singleRouteDomainLength >= 500
  );
  // This is intentionally a severe-loss signal, not a generic preference for
  // verbatim answers. A final synthesis may summarize, but retaining under a
  // tenth of one validated route's substantial public answer is observable
  // evidence that whole requested sections may have disappeared.
  const severeSingleRouteAnswerLoss = Boolean(
    singleRouteRetentionEligible
    && finalAnswerLength < singleRouteDomainLength * 0.1
  );
  const expectedAttachment = scenario.needsAttachment === true;
  const registeredAttachment = Boolean(attachmentAgent);
  const failedResponses = values(result?.diagnostics?.failed_responses);
  const consoleErrors = values(result?.diagnostics?.console_errors);
  const pageErrors = values(result?.diagnostics?.page_errors);
  const problems = [];
  if (!result) problems.push("missing_result");
  if (result?.error) problems.push(`harness:${text(result.error?.message) || "error"}`);
  if (!run) problems.push("no_run");
  else if (runStatus !== "completed") problems.push(`run:${runStatus}`);
  if (!decisionCorrect) problems.push(`decision:${decision || "missing"}->${scenario.expectedDecision}`);
  if (requiredMissing.length) problems.push(`missing_required:${requiredMissing.join(",")}`);
  if (forbiddenSelected.length) problems.push(`forbidden:${forbiddenSelected.join(",")}`);
  if (disallowedSelected.length) problems.push(`extra:${disallowedSelected.join(",")}`);
  if (facts.some((fact) => fact.failed)) problems.push("route_failed");
  if (facts.some((fact) => fact.blocked)) problems.push("route_blocked");
  if (expectedAttachment && !registeredAttachment) problems.push("attachment_missing");
  if (expectedAttachment && registeredAttachment && !attachmentRouteSuccess) {
    problems.push("attachment_agent_not_selected");
  }
  if (scenario.category === "document_routing" && runStatus === "completed" && citations === 0) {
    problems.push("document_citations_missing");
  }
  if (runStatus === "completed" && !text(run?.final_answer)) problems.push("api_answer_empty");
  if (nonResult) problems.push("observable_non_result");
  if (partialNonResult) problems.push("observable_partial_non_result");
  if (severeSingleRouteAnswerLoss) problems.push("severe_single_route_answer_loss");
  if (runStatus === "completed" && result?.ui?.assistant_visible !== true) problems.push("ui_answer_missing");
  if (runStatus === "completed" && result?.ui?.assistant_visible === true && result?.ui?.answer_matches_api !== true) {
    problems.push("ui_api_mismatch");
  }
  if (sessionBindingObserved && sessionMatchesRun !== true) problems.push("session_binding_mismatch");
  if (failedResponses.length) problems.push(`network_${failedResponses.length}x`);
  if (consoleErrors.length) problems.push(`console_${consoleErrors.length}x`);
  if (pageErrors.length) problems.push(`page_${pageErrors.length}x`);

  return {
    scenario_id: scenario.id,
    category: scenario.category,
    expected_decision: scenario.expectedDecision,
    observed_decision: decision,
    decision_correct: decisionCorrect,
    false_delegation: falseDelegation,
    run_status: runStatus,
    observable_non_result: nonResult,
    observable_partial_non_result: partialNonResult,
    single_route_retention_eligible: singleRouteRetentionEligible,
    severe_single_route_answer_loss: severeSingleRouteAnswerLoss,
    single_route_answer_length_ratio: singleRouteRetentionEligible
      ? rounded(finalAnswerLength / singleRouteDomainLength)
      : null,
    harness_error: Boolean(result?.error || !result),
    selected_agents: selectedAgents,
    required_agents: requiredAgents,
    required_hits: requiredAgents.length - requiredMissing.length,
    required_missing: requiredMissing,
    effective_allowed_agents: [...effectiveAllowed].sort(),
    forbidden_agents: [...forbiddenAgents].sort(),
    forbidden_selected: forbiddenSelected,
    junk_selected: junkSelected,
    disallowed_selected: disallowedSelected,
    allowed_selected_count: allowedSelectedCount,
    selected_count: selectedFacts.length,
    route_precision: ratio(allowedSelectedCount, selectedFacts.length),
    exact_graph_success: exactGraphSuccess,
    allowed_graph_success: allowedGraphSuccess,
    routes: facts,
    citations,
    tools,
    has_citations: citations > 0,
    has_tool_execution: tools.length > 0,
    has_successful_tool_execution: tools.some((tool) => tool.ok),
    has_document_tool_execution: tools.some((tool) => DOCUMENT_TOOLS.has(tool.name)),
    expected_attachment: expectedAttachment,
    attachment_registered: registeredAttachment,
    attachment_agent_id: attachmentAgent || null,
    attachment_agent_selected: Boolean(attachmentAgent && selectedAgents.includes(attachmentAgent)),
    ui_assistant_visible: result?.ui?.assistant_visible === true,
    ui_answer_matches_api: result?.ui?.answer_matches_api === true,
    session_binding_observed: sessionBindingObserved,
    session_matches_run: sessionMatchesRun,
    failed_response_count: failedResponses.length,
    run_latency_sec: finite(run?.elapsed_sec),
    browser_latency_sec: secondsBetween(result?.started_at, result?.completed_at),
    poll_latency_sec: finite(result?.poll_elapsed_ms) === null ? null : Number(result.poll_elapsed_ms) / 1000,
    usage_receipt_complete: usageReceipt?.complete === true,
    provider_usage_reported: usageReceipt?.provider_reported === true,
    model_call_count: counter(usageReceipt?.call_count),
    prompt_tokens: counter(usageReceipt?.prompt_tokens),
    completion_tokens: counter(usageReceipt?.completion_tokens),
    total_tokens: counter(usageReceipt?.total_tokens),
    charged_micros: counter(usageReceipt?.charged_micros),
    charged_credits: counter(usageReceipt?.charged_micros) === null
      ? null
      : Number(usageReceipt.charged_micros) / 1_000_000,
    problems
  };
}

function aggregateRoutes(scores) {
  const routes = scores.flatMap((score) => score.routes);
  const selected = routes.filter((route) => route.selected);
  const attempted = routes.filter((route) => route.attempted);
  const validated = routes.filter((route) => route.validated);
  const failed = routes.filter((route) => route.failed);
  const blocked = routes.filter((route) => route.blocked);
  const reused = routes.filter((route) => route.reused);
  const outstanding = routes.filter((route) => route.outstanding);
  return {
    routes,
    selected,
    attempted,
    validated,
    failed,
    blocked,
    reused,
    outstanding,
    summary: {
      selected: selected.length,
      attempted: attempted.length,
      validated: validated.length,
      failed: failed.length,
      blocked: blocked.length,
      reused: reused.length,
      outstanding: outstanding.length,
      unattempted_selected: selected.filter((route) => !route.attempted && !route.reused).length,
      invocation_success: rateMetric(validated.length, attempted.length),
      denominator_note: "attempted excludes reused routes; validated/attempted is the invocation success rate"
    }
  };
}

function categoryMetrics(category, scores) {
  const subset = scores.filter((score) => score.category === category);
  const routeAggregate = aggregateRoutes(subset);
  const requiredTotal = subset.reduce((total, score) => total + score.required_agents.length, 0);
  const requiredHits = subset.reduce((total, score) => total + score.required_hits, 0);
  const selectedTotal = subset.reduce((total, score) => total + score.selected_count, 0);
  const allowedSelected = subset.reduce((total, score) => total + score.allowed_selected_count, 0);
  return {
    category,
    scenarios: subset.length,
    completed: subset.filter((score) => score.run_status === "completed").length,
    harness_errors: subset.filter((score) => score.harness_error).length,
    decision_accuracy: rateMetric(subset.filter((score) => score.decision_correct).length, subset.length),
    required_agent_recall: rateMetric(requiredHits, requiredTotal),
    exact_graph_success: rateMetric(subset.filter((score) => score.exact_graph_success).length, subset.length),
    allowed_graph_success: rateMetric(subset.filter((score) => score.allowed_graph_success).length, subset.length),
    route_precision: rateMetric(allowedSelected, selectedTotal),
    invocation_success: routeAggregate.summary.invocation_success,
    failed_routes: routeAggregate.failed.length,
    blocked_routes: routeAggregate.blocked.length,
    citation_rate: rateMetric(subset.filter((score) => score.has_citations).length, subset.length),
    tool_execution_rate: rateMetric(subset.filter((score) => score.has_tool_execution).length, subset.length),
    latency: {
      run: distribution(subset.map((score) => score.run_latency_sec)),
      browser_end_to_end: distribution(subset.map((score) => score.browser_latency_sec))
    },
    usage: {
      total_tokens: numericDistribution(subset.map((score) => score.total_tokens), "tokens", 0),
      charged_credits: numericDistribution(subset.map((score) => score.charged_credits), "credits", 4)
    }
  };
}

function usageMetrics(scores, routeAggregate) {
  const withRun = scores.filter((score) => score.run_status !== "no_run");
  const total = (field) => scores.reduce((sum, score) => sum + (finite(score[field]) ?? 0), 0);
  const chargedMicros = total("charged_micros");
  return {
    receipts_complete: rateMetric(
      withRun.filter((score) => score.usage_receipt_complete).length,
      withRun.length
    ),
    provider_reported: rateMetric(
      withRun.filter((score) => score.provider_usage_reported).length,
      withRun.length
    ),
    totals: {
      model_calls: total("model_call_count"),
      prompt_tokens: total("prompt_tokens"),
      completion_tokens: total("completion_tokens"),
      total_tokens: total("total_tokens"),
      charged_micros: chargedMicros,
      charged_credits: rounded(chargedMicros / 1_000_000, 4)
    },
    per_scenario: {
      model_calls: numericDistribution(scores.map((score) => score.model_call_count), "calls", 2),
      total_tokens: numericDistribution(scores.map((score) => score.total_tokens), "tokens", 0),
      charged_credits: numericDistribution(scores.map((score) => score.charged_credits), "credits", 4)
    },
    validated_routes_per_credit: chargedMicros > 0
      ? rounded(routeAggregate.validated.length / (chargedMicros / 1_000_000), 4)
      : null,
    denominator_note: "Totals use charged usage receipts from canonical browser runs; credits are charged_micros divided by 1,000,000."
  };
}

function perAgentMetrics(scores) {
  const allAgentIds = new Set();
  for (const score of scores) {
    score.required_agents.forEach((agentId) => allAgentIds.add(agentId));
    score.routes.map((route) => route.adapter).filter(Boolean).forEach((agentId) => allAgentIds.add(agentId));
  }
  return [...allAgentIds].sort().map((agentId) => {
    const routes = scores.flatMap((score) => score.routes).filter((route) => route.adapter === agentId);
    const requiredScores = scores.filter((score) => score.required_agents.includes(agentId));
    const requiredHits = requiredScores.filter((score) => score.selected_agents.includes(agentId)).length;
    const attempted = routes.filter((route) => route.attempted).length;
    const validated = routes.filter((route) => route.validated).length;
    return {
      agent_id: agentId,
      required: requiredScores.length,
      required_selected: requiredHits,
      routing_recall: rateMetric(requiredHits, requiredScores.length),
      selected: routes.filter((route) => route.selected).length,
      attempted,
      validated,
      failed: routes.filter((route) => route.failed).length,
      blocked: routes.filter((route) => route.blocked).length,
      reused: routes.filter((route) => route.reused).length,
      invocation_success: rateMetric(validated, attempted)
    };
  });
}

function statusMetrics(raw, canonicalResults, scores, requestedIds, unknownIds, duplicateIds, fixtureScenarioCount) {
  const statusCounts = {};
  for (const result of canonicalResults) {
    const status = text(result?.run?.status).toLowerCase() || "no_run";
    statusCounts[status] = (statusCounts[status] || 0) + 1;
  }
  const observedRequested = scores.filter((score) => score.run_status !== "no_run" || !score.harness_error).length;
  return {
    source_result_records: values(raw?.results).length,
    canonical_result_records: canonicalResults.length,
    fixture_scenarios: fixtureScenarioCount,
    requested_scenarios: Number(raw?.scenario_count) || requestedIds.length,
    attributable_requested_scenarios: requestedIds.length,
    observed_requested_scenarios: observedRequested,
    missing_requested_scenarios: Math.max(0, requestedIds.length - scores.filter((score) => !score.problems.includes("missing_result")).length),
    unattributed_missing_scenarios: Math.max(0, (Number(raw?.scenario_count) || requestedIds.length) - requestedIds.length),
    unknown_scenario_ids: unknownIds,
    duplicate_scenario_ids: duplicateIds,
    run_status_counts: statusCounts,
    terminal_runs: canonicalResults.filter((result) => TERMINAL_RUN_STATUSES.has(text(result?.run?.status).toLowerCase())).length,
    completed_runs: statusCounts.completed || 0,
    failed_runs: statusCounts.failed || 0,
    cancelled_runs: statusCounts.cancelled || 0,
    no_run_results: statusCounts.no_run || 0
  };
}

function harnessMetrics(raw, canonicalResults, scores, duplicateIds) {
  const resultErrors = canonicalResults.filter((result) => result?.error).length;
  const missingResults = scores.filter((score) => score.problems.includes("missing_result")).length;
  const workerErrors = values(raw?.worker_errors).length;
  const clean = scores.filter((score) => !score.harness_error && score.run_status !== "no_run").length;
  return {
    result_errors: resultErrors,
    worker_errors: workerErrors,
    missing_results: missingResults,
    duplicate_results: duplicateIds.length,
    clean_scenarios: rateMetric(clean, scores.length),
    error_messages: unique([
      ...canonicalResults.map((result) => result?.error?.message),
      ...values(raw?.worker_errors).map((entry) => entry?.error?.message)
    ])
  };
}

function uiMetrics(canonicalResults) {
  const completed = canonicalResults.filter((result) => result?.run?.status === "completed");
  const visible = completed.filter((result) => result?.ui?.assistant_visible === true);
  const sessionBound = canonicalResults.filter((result) => (
    text(result?.session_id) && text(result?.run?.session_id)
  ));
  return {
    completed_run_samples: completed.length,
    assistant_visible: rateMetric(visible.length, completed.length),
    answer_matches_api: rateMetric(
      visible.filter((result) => result?.ui?.answer_matches_api === true).length,
      visible.length
    ),
    session_identity_matches: rateMetric(
      sessionBound.filter((result) => text(result.session_id) === text(result.run.session_id)).length,
      sessionBound.length
    ),
    empty_api_answers: completed.filter((result) => !text(result?.run?.final_answer)).length,
    console_error_count: canonicalResults.reduce((total, result) => total + values(result?.diagnostics?.console_errors).length, 0),
    page_error_count: canonicalResults.reduce((total, result) => total + values(result?.diagnostics?.page_errors).length, 0),
    scenarios_with_console_errors: canonicalResults.filter((result) => values(result?.diagnostics?.console_errors).length).length,
    scenarios_with_page_errors: canonicalResults.filter((result) => values(result?.diagnostics?.page_errors).length).length
  };
}

function answerMetrics(scores) {
  const completed = scores.filter((score) => score.run_status === "completed");
  const delegated = completed.filter((score) => score.expected_decision === "delegate");
  const completeAnswer = (score) => (
    !score.observable_non_result
    && !score.observable_partial_non_result
    && !score.severe_single_route_answer_loss
  );
  const retentionEligible = completed.filter((score) => score.single_route_retention_eligible);
  return {
    completed_run_samples: completed.length,
    observable_non_results: completed.filter((score) => score.observable_non_result).length,
    observable_partial_non_results: completed.filter(
      (score) => score.observable_partial_non_result
    ).length,
    severe_single_route_answer_losses: completed.filter(
      (score) => score.severe_single_route_answer_loss
    ).length,
    single_route_answer_retention: rateMetric(
      retentionEligible.filter((score) => !score.severe_single_route_answer_loss).length,
      retentionEligible.length
    ),
    substantive_completed_answers: rateMetric(
      completed.filter(completeAnswer).length,
      completed.length
    ),
    substantive_delegate_answers: rateMetric(
      delegated.filter(completeAnswer).length,
      delegated.length
    )
  };
}

function adminSnapshotFacts(snapshot) {
  if (snapshot === null || snapshot === undefined) {
    return { status: "missing", schema_version: null, capture_error: null };
  }
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    return { status: "invalid", schema_version: null, capture_error: null };
  }
  if (Object.prototype.hasOwnProperty.call(snapshot, "capture_error")) {
    return {
      status: "capture_error",
      schema_version: text(snapshot.schema_version) || null,
      capture_error: snapshot.capture_error ?? null
    };
  }
  return {
    status: "captured",
    schema_version: text(snapshot.schema_version) || null,
    capture_error: null
  };
}

function rawEndpointRates(snapshot, snapshotFacts) {
  if (snapshotFacts.status !== "captured") return null;
  return Object.fromEntries(Object.entries(snapshot).filter(([key]) => (
    /_(?:rate|rates|percent)$/.test(key)
  )));
}

function adminMetricsReconciliation(raw, canonicalResults, routeAggregate) {
  const before = raw?.admin_metrics_before;
  const after = raw?.admin_metrics_after;
  const beforeFacts = adminSnapshotFacts(before);
  const afterFacts = adminSnapshotFacts(after);
  const counterDeltas = {};
  for (const definition of ADMIN_COUNTER_DEFINITIONS) {
    const beforeValue = beforeFacts.status === "captured"
      ? counter(before?.[definition.endpointField])
      : null;
    const afterValue = afterFacts.status === "captured"
      ? counter(after?.[definition.endpointField])
      : null;
    let unavailableReason = null;
    if (beforeFacts.status !== "captured") {
      unavailableReason = `before_snapshot_${beforeFacts.status}`;
    } else if (afterFacts.status !== "captured") {
      unavailableReason = `after_snapshot_${afterFacts.status}`;
    } else if (beforeValue === null) {
      unavailableReason = `before_counter_unavailable:${definition.endpointField}`;
    } else if (afterValue === null) {
      unavailableReason = `after_counter_unavailable:${definition.endpointField}`;
    }
    const delta = unavailableReason ? null : afterValue - beforeValue;
    counterDeltas[definition.key] = {
      endpoint_field: definition.endpointField,
      before: beforeValue,
      after: afterValue,
      delta,
      counter_reset_detected: delta === null ? null : delta < 0,
      unavailable_reason: unavailableReason
    };
  }

  const canonicalRunRecords = canonicalResults.filter((result) => (
    result?.run && typeof result.run === "object" && !Array.isArray(result.run)
  ));
  const canonicalCounts = {
    chats: unique(canonicalResults.map((result) => result?.session_id)).length,
    run_records: canonicalRunRecords.length,
    completed_runs: canonicalRunRecords.filter((result) => result.run.status === "completed").length,
    failed_runs: canonicalRunRecords.filter((result) => result.run.status === "failed").length,
    selected_routes: routeAggregate.selected.length,
    attempted_routes: routeAggregate.attempted.length,
    validated_routes: routeAggregate.validated.length,
    // The durable endpoint's failed_route_count includes blocked routes. The
    // existing benchmark invocation summary intentionally reports those two
    // classes separately, so combine them only for this like-for-like check.
    failed_routes: routeAggregate.failed.length + routeAggregate.blocked.length,
    blocked_routes: routeAggregate.blocked.length,
    reused_routes: routeAggregate.reused.length
  };
  const denominatorNotes = {
    chats: "Distinct non-empty session_id values in canonical result records.",
    run_records: "Canonical result records containing a run object, regardless of terminal status.",
    completed_runs: "Canonical run records whose observed status is completed.",
    failed_runs: "Canonical run records whose observed status is failed.",
    selected_routes: "Selected plan-route facts across scored canonical scenarios.",
    attempted_routes: "Fresh attempted route facts; reused routes are excluded.",
    validated_routes: "Fresh attempted route facts with a validated terminal success.",
    failed_routes: "Canonical failed plus blocked route facts, matching the endpoint total; endpoint-only incomplete routes surface as mismatches.",
    blocked_routes: "Attempted route facts with blocked terminal status.",
    reused_routes: "Route facts explicitly observed as reused; excluded from fresh attempts."
  };
  const reconciledCounters = Object.fromEntries(ADMIN_COUNTER_DEFINITIONS.map((definition) => {
    const adminDelta = counterDeltas[definition.key].delta;
    const canonicalCount = canonicalCounts[definition.key];
    const comparable = adminDelta !== null && Number.isSafeInteger(canonicalCount);
    return [definition.key, {
      label: definition.label,
      endpoint_field: definition.endpointField,
      admin_delta: adminDelta,
      canonical_count: canonicalCount,
      difference: comparable ? adminDelta - canonicalCount : null,
      comparison: comparable ? (adminDelta === canonicalCount ? "match" : "mismatch") : null,
      denominator_note: denominatorNotes[definition.key]
    }];
  }));
  const reconciliationRows = Object.values(reconciledCounters);
  const comparable = reconciliationRows.filter((row) => row.comparison !== null);
  const matches = comparable.filter((row) => row.comparison === "match").length;
  const mismatches = comparable.filter((row) => row.comparison === "mismatch").length;

  return {
    snapshots: {
      before: beforeFacts,
      after: afterFacts
    },
    counter_deltas: counterDeltas,
    raw_endpoint_rates: {
      before: rawEndpointRates(before, beforeFacts),
      after: rawEndpointRates(after, afterFacts),
      denominator_note: "Endpoint rates are retained as independent snapshots and are never subtracted; count deltas are authoritative for this benchmark interval."
    },
    canonical_counts: canonicalCounts,
    reconciliation: {
      counters: reconciledCounters,
      summary: {
        total_counters: reconciliationRows.length,
        comparable_counters: comparable.length,
        matches,
        mismatches,
        comparison: mismatches > 0
          ? "mismatch"
          : comparable.length === reconciliationRows.length
            ? "match"
            : null,
        denominator_note: "Each comparison uses the after-minus-before durable counter delta and the corresponding deduplicated canonical browser observation count."
      }
    }
  };
}

function networkMetrics(canonicalResults) {
  const failures = canonicalResults.flatMap((result) => values(result?.diagnostics?.failed_responses));
  const statusCounts = {};
  for (const failure of failures) {
    const status = String(failure?.status || "unknown");
    statusCounts[status] = (statusCounts[status] || 0) + 1;
  }
  const submitted = canonicalResults.filter((result) => finite(result?.queued?.http_status) !== null);
  const accepted = submitted.filter((result) => {
    const status = Number(result.queued.http_status);
    return status >= 200 && status < 300;
  });
  return {
    failed_response_count: failures.length,
    client_error_count: failures.filter((failure) => Number(failure?.status) >= 400 && Number(failure?.status) < 500).length,
    server_error_count: failures.filter((failure) => Number(failure?.status) >= 500).length,
    scenarios_with_failed_responses: canonicalResults.filter((result) => values(result?.diagnostics?.failed_responses).length).length,
    failed_status_counts: statusCounts,
    message_submission_acceptance: rateMetric(accepted.length, submitted.length)
  };
}

function evidenceMetrics(scores) {
  const completed = scores.filter((score) => score.run_status === "completed");
  const attachmentExpected = scores.filter((score) => score.expected_attachment);
  const registeredAttachments = attachmentExpected.filter((score) => score.attachment_registered);
  const documentScores = scores.filter((score) => score.category === "document_routing");
  return {
    citations: {
      total: scores.reduce((total, score) => total + score.citations, 0),
      scenario_rate: rateMetric(scores.filter((score) => score.has_citations).length, scores.length),
      completed_run_rate: rateMetric(completed.filter((score) => score.has_citations).length, completed.length)
    },
    tools: {
      executions: scores.reduce((total, score) => total + score.tools.length, 0),
      successful_executions: scores.reduce(
        (total, score) => total + score.tools.filter((tool) => tool.ok).length,
        0
      ),
      scenario_rate: rateMetric(scores.filter((score) => score.has_tool_execution).length, scores.length),
      successful_scenario_rate: rateMetric(
        scores.filter((score) => score.has_successful_tool_execution).length,
        scores.length
      )
    },
    documents: {
      scenarios: documentScores.length,
      completed: rateMetric(documentScores.filter((score) => score.run_status === "completed").length, documentScores.length),
      exact_graph_success: rateMetric(documentScores.filter((score) => score.exact_graph_success).length, documentScores.length),
      citation_rate: rateMetric(documentScores.filter((score) => score.has_citations).length, documentScores.length),
      document_tool_rate: rateMetric(
        documentScores.filter((score) => score.has_document_tool_execution).length,
        documentScores.length
      )
    },
    attachments: {
      expected: attachmentExpected.length,
      registered: rateMetric(registeredAttachments.length, attachmentExpected.length),
      attachment_agent_selected: rateMetric(
        registeredAttachments.filter((score) => score.attachment_agent_selected).length,
        registeredAttachments.length
      )
    }
  };
}

export function analyzePipelineResults(raw, {
  scenarios = PIPELINE_SCENARIOS,
  dependencyMap = FALLBACK_CONFIGURED_DEPENDENCIES,
  junkAgentIds = JUNK_AGENT_DENYLIST,
  generatedAt = new Date().toISOString()
} = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new TypeError("Pipeline results must be an object.");
  const fixtureById = new Map(scenarios.map((scenario) => [scenario.id, scenario]));
  const lastResultById = new Map();
  const duplicateIds = new Set();
  const unknownIds = new Set();
  for (const result of values(raw.results)) {
    const scenarioId = text(result?.scenario_id);
    if (!scenarioId) continue;
    if (lastResultById.has(scenarioId)) duplicateIds.add(scenarioId);
    lastResultById.set(scenarioId, result);
    if (!fixtureById.has(scenarioId)) unknownIds.add(scenarioId);
  }
  const observedKnownIds = [...lastResultById.keys()].filter((scenarioId) => fixtureById.has(scenarioId));
  const requestedIds = requestedScenarioIds(raw, scenarios, observedKnownIds)
    .filter((scenarioId) => fixtureById.has(scenarioId));
  // Preserve unexpected known records too: a malformed requested-id manifest
  // must not make actual browser executions disappear from the report.
  const scoreIds = unique([...requestedIds, ...observedKnownIds]);
  const junkSet = new Set(unique(junkAgentIds));
  const scores = scoreIds.map((scenarioId) => buildScenarioScore({
    scenario: fixtureById.get(scenarioId),
    result: lastResultById.get(scenarioId) || null,
    dependencyMap,
    junkAgentIds: junkSet
  }));
  const canonicalResults = [...lastResultById.values()];
  const routeAggregate = aggregateRoutes(scores);
  const adminMetrics = adminMetricsReconciliation(raw, canonicalResults, routeAggregate);
  const requiredTotal = scores.reduce((total, score) => total + score.required_agents.length, 0);
  const requiredHits = scores.reduce((total, score) => total + score.required_hits, 0);
  const selectedTotal = scores.reduce((total, score) => total + score.selected_count, 0);
  const allowedSelected = scores.reduce((total, score) => total + score.allowed_selected_count, 0);
  const forbiddenAttempts = scores.flatMap((score) => score.routes.filter((route) => (
    route.attempted && score.forbidden_agents.includes(route.adapter)
  )));
  const junkAttempts = scores.flatMap((score) => score.routes.filter((route) => (
    route.attempted && junkSet.has(route.adapter)
  )));
  const directScores = scores.filter((score) => score.expected_decision === "direct");
  const clarifyScores = scores.filter((score) => score.expected_decision === "clarify");
  const categories = unique(scores.map((score) => score.category)).sort()
    .map((category) => categoryMetrics(category, scores));
  const agents = perAgentMetrics(scores);
  const lowestAgents = agents.filter((agent) => agent.attempted > 0)
    .sort((left, right) => (
      (left.invocation_success.rate ?? 1) - (right.invocation_success.rate ?? 1)
      || right.attempted - left.attempted
      || left.agent_id.localeCompare(right.agent_id)
    )).slice(0, 10);
  const lowestCategories = [...categories].sort((left, right) => (
    (left.exact_graph_success.rate ?? 1) - (right.exact_graph_success.rate ?? 1)
    || (left.required_agent_recall.rate ?? 1) - (right.required_agent_recall.rate ?? 1)
    || left.category.localeCompare(right.category)
  )).slice(0, 10);

  return {
    schema_version: "virenis-browser-pipeline-metrics-v1",
    generated_at: generatedAt,
    source_schema_version: raw.schema_version || null,
    source_started_at: raw.started_at || null,
    source_completed_at: raw.completed_at || null,
    base_url: raw.base_url || null,
    scoring_notes: [
      "Routing and operational contracts are scored automatically; oracle_hints are not qualitative grades.",
      "Required-agent recall uses planned agent selection and includes known missing/harness-failed cases as misses.",
      "Route precision allows scenario-listed agents, their configured transitive dependencies, and attachment.agent_id.",
      "Invocation success is validated fresh attempts divided by attempted fresh routes; reused routes are excluded.",
      "Partial non-results require the runtime's exact terminal incomplete-deliverable notice; ordinary caveats are not classified.",
      "Severe single-route answer loss means a completed final answer retained under 10% of one substantial validated public route answer; it is a loss signal, not a general verbosity score.",
      "Admin count deltas use after minus before; endpoint averages and rates are retained as snapshots and never differenced."
    ],
    status: statusMetrics(
      raw,
      canonicalResults,
      scores,
      requestedIds,
      [...unknownIds].sort(),
      [...duplicateIds].sort(),
      scenarios.length
    ),
    harness: harnessMetrics(raw, canonicalResults, scores, [...duplicateIds]),
    admin_metrics: adminMetrics,
    ui: uiMetrics(canonicalResults),
    answers: answerMetrics(scores),
    network: networkMetrics(canonicalResults),
    routing: {
      decision_accuracy: rateMetric(scores.filter((score) => score.decision_correct).length, scores.length),
      decision_observation_coverage: rateMetric(scores.filter((score) => score.observed_decision).length, scores.length),
      direct_false_delegation: rateMetric(directScores.filter((score) => score.false_delegation).length, directScores.length),
      clarify_false_delegation: rateMetric(clarifyScores.filter((score) => score.false_delegation).length, clarifyScores.length),
      required_agent_recall: rateMetric(requiredHits, requiredTotal),
      route_precision: rateMetric(allowedSelected, selectedTotal),
      exact_graph_success: rateMetric(scores.filter((score) => score.exact_graph_success).length, scores.length),
      allowed_graph_success: rateMetric(scores.filter((score) => score.allowed_graph_success).length, scores.length),
      forbidden: {
        selected: scores.reduce((total, score) => total + score.forbidden_selected.length, 0),
        scenarios: rateMetric(scores.filter((score) => score.forbidden_selected.length).length, scores.length),
        invocation_rate: rateMetric(forbiddenAttempts.length, routeAggregate.attempted.length)
      },
      junk: {
        selected: scores.reduce((total, score) => total + score.junk_selected.length, 0),
        scenarios: rateMetric(scores.filter((score) => score.junk_selected.length).length, scores.length),
        invocation_rate: rateMetric(junkAttempts.length, routeAggregate.attempted.length)
      }
    },
    invocations: routeAggregate.summary,
    latency: {
      run: distribution(scores.map((score) => score.run_latency_sec)),
      browser_end_to_end: distribution(scores.map((score) => score.browser_latency_sec)),
      polling: distribution(scores.map((score) => score.poll_latency_sec)),
      fresh_routes: distribution(routeAggregate.attempted.map((route) => route.elapsed_sec))
    },
    usage: usageMetrics(scores, routeAggregate),
    evidence: evidenceMetrics(scores),
    categories,
    agents,
    lowest_performing: {
      agents: lowestAgents.map((agent) => agent.agent_id),
      categories: lowestCategories.map((category) => category.category)
    },
    scenarios: scores
  };
}

function percent(metric) {
  return metric?.rate === null || metric?.rate === undefined ? "n/a" : `${(metric.rate * 100).toFixed(1)}%`;
}

function interval(metric) {
  const low = metric?.wilson_95?.low;
  const high = metric?.wilson_95?.high;
  return low === null || low === undefined ? "n/a" : `${(low * 100).toFixed(1)}–${(high * 100).toFixed(1)}%`;
}

function latencyText(metric) {
  if (!metric?.samples) return "n/a";
  return `${metric.mean}s / ${metric.p50}s / ${metric.p95}s (n=${metric.samples})`;
}

function distributionText(metric) {
  if (!metric?.samples) return "n/a";
  return `${metric.mean} / ${metric.p50} / ${metric.p95} ${metric.unit} (n=${metric.samples})`;
}

function markdown(value) {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function metricRow(name, metric, extra = "") {
  return `| ${markdown(name)} | ${metric?.successes ?? 0}/${metric?.total ?? 0} | ${percent(metric)} | ${interval(metric)}${extra ? ` ${markdown(extra)}` : ""} |`;
}

function countCell(value) {
  return Number.isFinite(value) ? String(value) : "n/a";
}

function rawRateCell(value) {
  if (value === null || value === undefined || value === "") return "n/a";
  const number = Number(value);
  return Number.isFinite(number) ? `${(number * 100).toFixed(1)}%` : markdown(value);
}

export function renderPipelineReport(metrics) {
  const failedScenarios = metrics.scenarios.filter((scenario) => scenario.problems.length);
  const lowAgents = metrics.agents.filter((agent) => metrics.lowest_performing.agents.includes(agent.agent_id));
  const lowCategories = metrics.categories.filter((category) => metrics.lowest_performing.categories.includes(category.category));
  const adminCounters = metrics.admin_metrics?.reconciliation?.counters || {};
  const adminRows = Object.entries(adminCounters);
  const beforeAdminRate = metrics.admin_metrics?.raw_endpoint_rates?.before?.invocation_success_rate;
  const afterAdminRate = metrics.admin_metrics?.raw_endpoint_rates?.after?.invocation_success_rate;
  const lines = [
    "# Virenis Browser Pipeline E2E Report",
    "",
    `Generated: ${metrics.generated_at}`,
    "",
    `Source: \`${metrics.source_schema_version || "unknown"}\`; ${metrics.status.canonical_result_records} canonical browser results for ${metrics.status.requested_scenarios} requested scenarios.`,
    "",
    "This report scores observable routing, execution, UI, network, citation, tool, document, and attachment contracts. It does **not** assign qualitative grades from `oracle_hints`; those hints require human or a separately declared evaluator.",
    "",
    "## Outcome summary",
    "",
    "| Metric | Result |",
    "| --- | ---: |",
    `| Completed runs | ${metrics.status.completed_runs}/${metrics.status.canonical_result_records} |`,
    `| Harness-clean scenarios | ${percent(metrics.harness.clean_scenarios)} |`,
    `| UI assistant visible on completed runs | ${percent(metrics.ui.assistant_visible)} |`,
    `| Visible UI answer matches API | ${percent(metrics.ui.answer_matches_api)} |`,
    `| Created session matches terminal run | ${percent(metrics.ui.session_identity_matches)} |`,
    `| Substantive delegate answers | ${percent(metrics.answers.substantive_delegate_answers)} |`,
    `| Observable non-result answers | ${metrics.answers.observable_non_results} |`,
    `| Observable partial non-result answers | ${metrics.answers.observable_partial_non_results} |`,
    `| Severe single-route answer losses | ${metrics.answers.severe_single_route_answer_losses} |`,
    `| Single-route answer retention | ${percent(metrics.answers.single_route_answer_retention)} |`,
    `| Failed HTTP responses | ${metrics.network.failed_response_count} |`,
    `| Console / page errors | ${metrics.ui.console_error_count} / ${metrics.ui.page_error_count} |`,
    `| Invocation success (fresh attempts) | ${percent(metrics.invocations.invocation_success)} |`,
    "",
    "## Durable admin counter reconciliation",
    "",
    `Snapshot capture: before **${markdown(metrics.admin_metrics?.snapshots?.before?.status || "missing")}**, after **${markdown(metrics.admin_metrics?.snapshots?.after?.status || "missing")}**. Deltas are authoritative after-minus-before counts; rates and averages are not subtracted.`,
    "",
    "| Counter | Before | After | Delta | Canonical observation | Result |",
    "| --- | ---: | ---: | ---: | ---: | --- |",
    ...(adminRows.length ? adminRows.map(([key, row]) => {
      const delta = metrics.admin_metrics?.counter_deltas?.[key] || {};
      return `| ${markdown(row.label)} | ${countCell(delta.before)} | ${countCell(delta.after)} | ${countCell(delta.delta)} | ${countCell(row.canonical_count)} | ${markdown(row.comparison || "n/a")} |`;
    }) : ["| _No comparable admin counters_ | n/a | n/a | n/a | n/a | n/a |"]),
    "",
    `Reconciliation: ${metrics.admin_metrics?.reconciliation?.summary?.matches ?? 0} matches, ${metrics.admin_metrics?.reconciliation?.summary?.mismatches ?? 0} mismatches, ${metrics.admin_metrics?.reconciliation?.summary?.comparable_counters ?? 0}/${metrics.admin_metrics?.reconciliation?.summary?.total_counters ?? 0} comparable. Canonical denominators are recorded per counter; fresh attempts exclude reuse, failed-route totals include blocked routes, and chats are distinct observed session IDs.`,
    `Raw endpoint invocation-success rates (retained, not differenced): before ${rawRateCell(beforeAdminRate)}, after ${rawRateCell(afterAdminRate)}.`,
    "",
    "## Routing quality",
    "",
    "| Metric | Count | Rate | Wilson 95% CI |",
    "| --- | ---: | ---: | ---: |",
    metricRow("Decision accuracy", metrics.routing.decision_accuracy),
    metricRow("Required-agent recall", metrics.routing.required_agent_recall),
    metricRow("Route precision", metrics.routing.route_precision),
    metricRow("Exact graph: required present, forbidden absent", metrics.routing.exact_graph_success),
    metricRow("Allowed graph: exact plus no unapproved extras", metrics.routing.allowed_graph_success),
    metricRow("Direct false delegation", metrics.routing.direct_false_delegation),
    metricRow("Clarify false delegation", metrics.routing.clarify_false_delegation),
    metricRow("Forbidden fresh invocation", metrics.routing.forbidden.invocation_rate),
    metricRow("Junk fresh invocation", metrics.routing.junk.invocation_rate),
    "",
    `Route precision treats configured transitive dependency additions and each uploaded \`attachment.agent_id\` as allowed extras. Required-agent recall is ${percent(metrics.routing.required_agent_recall)} (Wilson 95% CI ${interval(metrics.routing.required_agent_recall)}).`,
    "",
    "## Invocation accounting",
    "",
    "| Selected | Attempted | Validated | Failed | Blocked | Reused | Outstanding |",
    "| ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    `| ${metrics.invocations.selected} | ${metrics.invocations.attempted} | ${metrics.invocations.validated} | ${metrics.invocations.failed} | ${metrics.invocations.blocked} | ${metrics.invocations.reused} | ${metrics.invocations.outstanding} |`,
    "",
    `Fresh invocation success is ${metrics.invocations.validated}/${metrics.invocations.attempted} (${percent(metrics.invocations.invocation_success)}; Wilson 95% CI ${interval(metrics.invocations.invocation_success)}). Reused routes are reported separately and excluded from the denominator.`,
    "",
    "## Latency",
    "",
    "Mean / p50 / p95:",
    "",
    `- Run: ${latencyText(metrics.latency.run)}`,
    `- Browser end-to-end: ${latencyText(metrics.latency.browser_end_to_end)}`,
    `- Polling: ${latencyText(metrics.latency.polling)}`,
    `- Fresh routes: ${latencyText(metrics.latency.fresh_routes)}`,
    "",
    "## Model usage and charged credits",
    "",
    `Complete usage receipts: ${percent(metrics.usage.receipts_complete)}; provider-reported usage: ${percent(metrics.usage.provider_reported)}.`,
    "",
    "| Model calls | Prompt tokens | Completion tokens | Total tokens | Charged credits | Validated routes / credit |",
    "| ---: | ---: | ---: | ---: | ---: | ---: |",
    `| ${metrics.usage.totals.model_calls} | ${metrics.usage.totals.prompt_tokens} | ${metrics.usage.totals.completion_tokens} | ${metrics.usage.totals.total_tokens} | ${metrics.usage.totals.charged_credits} | ${metrics.usage.validated_routes_per_credit ?? "n/a"} |`,
    "",
    "Per-scenario mean / p50 / p95:",
    "",
    `- Model calls: ${distributionText(metrics.usage.per_scenario.model_calls)}`,
    `- Total tokens: ${distributionText(metrics.usage.per_scenario.total_tokens)}`,
    `- Charged credits: ${distributionText(metrics.usage.per_scenario.charged_credits)}`,
    "",
    "## Evidence and documents",
    "",
    "| Metric | Result |",
    "| --- | ---: |",
    `| Runs with citations | ${percent(metrics.evidence.citations.scenario_rate)} (${metrics.evidence.citations.total} citations) |`,
    `| Runs with tool executions | ${percent(metrics.evidence.tools.scenario_rate)} (${metrics.evidence.tools.executions} executions) |`,
    `| Runs with successful tools | ${percent(metrics.evidence.tools.successful_scenario_rate)} (${metrics.evidence.tools.successful_executions} successes) |`,
    `| Document runs completed | ${percent(metrics.evidence.documents.completed)} |`,
    `| Document runs with citations | ${percent(metrics.evidence.documents.citation_rate)} |`,
    `| Document runs using document tools | ${percent(metrics.evidence.documents.document_tool_rate)} |`,
    `| Expected attachments registered | ${percent(metrics.evidence.attachments.registered)} |`,
    `| Registered attachment agents selected | ${percent(metrics.evidence.attachments.attachment_agent_selected)} |`,
    "",
    "## Category stratification",
    "",
    "| Category | Scenarios | Completed | Decision | Required recall | Exact graph | Route precision | Invocation success | Run mean/p50/p95 | Mean tokens | Mean credits |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: |",
    ...metrics.categories.map((category) => (
      `| ${markdown(category.category)} | ${category.scenarios} | ${category.completed} | ${percent(category.decision_accuracy)} | ${percent(category.required_agent_recall)} | ${percent(category.exact_graph_success)} | ${percent(category.route_precision)} | ${percent(category.invocation_success)} | ${latencyText(category.latency.run)} | ${category.usage.total_tokens.mean ?? "n/a"} | ${category.usage.charged_credits.mean ?? "n/a"} |`
    )),
    "",
    "## Lowest-performing agents",
    "",
    "Agents are ordered by fresh invocation success rate, then attempt volume. Agents with no fresh attempts are omitted.",
    "",
    "| Agent | Attempts | Validated | Failed | Blocked | Reused | Invocation success | Required routing recall |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...(lowAgents.length ? lowAgents.map((agent) => (
      `| ${markdown(agent.agent_id)} | ${agent.attempted} | ${agent.validated} | ${agent.failed} | ${agent.blocked} | ${agent.reused} | ${percent(agent.invocation_success)} | ${percent(agent.routing_recall)} |`
    )) : ["| _No attempted agents_ | 0 | 0 | 0 | 0 | 0 | n/a | n/a |"]),
    "",
    "## Lowest-performing categories",
    "",
    "Categories are ordered by exact-graph success and then required-agent recall; no composite qualitative score is invented.",
    "",
    "| Category | Scenarios | Exact graph | Required recall | Decision | Invocation success |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
    ...lowCategories.map((category) => (
      `| ${markdown(category.category)} | ${category.scenarios} | ${percent(category.exact_graph_success)} | ${percent(category.required_agent_recall)} | ${percent(category.decision_accuracy)} | ${percent(category.invocation_success)} |`
    )),
    "",
    "## Scenario failures",
    "",
    ...(failedScenarios.length ? [
      "| Scenario | Category | Run | Decision | Selected agents | Problems |",
      "| --- | --- | --- | --- | --- | --- |",
      ...failedScenarios.map((scenario) => (
        `| ${markdown(scenario.scenario_id)} | ${markdown(scenario.category)} | ${markdown(scenario.run_status)} | ${markdown(scenario.observed_decision || "missing")} | ${markdown(scenario.selected_agents.join(", ") || "none")} | ${markdown(scenario.problems.join("; "))} |`
      ))
    ] : ["No observable contract failures were detected."]),
    ""
  ];
  return `${lines.join("\n")}\n`;
}

async function loadDependencyMap(agentLibraryPath) {
  try {
    const library = JSON.parse(await fs.readFile(agentLibraryPath, "utf8"));
    return dependencyMapFromAgentLibrary(library);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return FALLBACK_CONFIGURED_DEPENDENCIES;
  }
}

export async function analyzePipelineFile({
  inputPath = process.env.PIPELINE_OUTPUT || defaultOutputPath,
  agentLibraryPath = process.env.PIPELINE_AGENT_LIBRARY || defaultAgentLibraryPath
} = {}) {
  const absoluteInput = path.resolve(inputPath);
  const raw = JSON.parse(await fs.readFile(absoluteInput, "utf8"));
  const dependencyMap = await loadDependencyMap(agentLibraryPath);
  const metrics = analyzePipelineResults(raw, { dependencyMap });
  const outputDirectory = path.dirname(absoluteInput);
  const metricsPath = path.join(outputDirectory, "metrics.json");
  const reportPath = path.join(outputDirectory, "REPORT.md");
  await fs.mkdir(outputDirectory, { recursive: true });
  await Promise.all([
    fs.writeFile(metricsPath, `${JSON.stringify(metrics, null, 2)}\n`, "utf8"),
    fs.writeFile(reportPath, renderPipelineReport(metrics), "utf8")
  ]);
  return { metrics, metricsPath, reportPath };
}

const invokedAsScript = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedAsScript) {
  try {
    const result = await analyzePipelineFile();
    console.log(JSON.stringify({
      ok: true,
      input: process.env.PIPELINE_OUTPUT || defaultOutputPath,
      metrics: result.metricsPath,
      report: result.reportPath,
      scenarios: result.metrics.scenarios.length,
      completed: result.metrics.status.completed_runs,
      invocation_success_rate: result.metrics.invocations.invocation_success.rate
    }, null, 2));
  } catch (error) {
    console.error(error?.stack || error);
    process.exitCode = 1;
  }
}

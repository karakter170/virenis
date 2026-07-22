import { BASE_MODEL, DEFAULT_VLLM_BASE_URL } from "./catalog.js";
import { readAgentRuntimeEnv } from "./agentRuntimeConfig.js";
import { normalizeRuntimeFailureReasonCode } from "./routeResultNormalizer.js";

const DOCUMENT_CONTEXT_ARTIFACTS = new Set([
  "document_context",
  "retrieved_context",
  "cited_passages",
  "document_constraints",
  "source_confidence",
  "source_context",
  "approved_sources",
  "evidence_summary"
]);

function agentOwnsSemanticContext(agent = {}) {
  return Boolean(
    agent.document
    || agent.resource_for_agent_id
    || agent.resource_type
    || agent.resource_artifact
  );
}

export function runtimeHealth(data) {
  return {
    ok: true,
    model_api: {
      base_url: process.env.VLLM_BASE_URL || DEFAULT_VLLM_BASE_URL,
      models_endpoint_ok: false,
      base_model: process.env.VLLM_BASE_MODEL || BASE_MODEL,
      mode: "local graph simulator (semantic selection disabled)"
    },
    manifest: {
      path: readAgentRuntimeEnv(
        process.env,
        "AGENT_MANIFEST_PATH",
        "configs/router_agent_library.json"
      ),
      agents: data.agents.length,
      active_agents: data.agents.filter((agent) => agent.enabled !== false).length,
      archived_agents: data.agents.filter((agent) => agent.enabled === false).length,
      valid: data.agents.every((agent) => /^[a-z0-9][a-z0-9_]{0,119}$/.test(agent.id) && agent.title && agent.capability)
    },
    tool_readiness: Object.fromEntries([
      "web_search",
      "calculator",
      "data_table",
      "document_search",
      "document_read",
      "repo_inspector",
      "sql_runner"
    ].map((name) => [name, {
      available: false,
      mode: "simulator",
      message: "Tool execution requires the configured Qwen runtime."
    }]))
  };
}

export function computeMetrics(data) {
  const runs = Array.isArray(data?.runs) ? data.runs : [];
  const sessions = Array.isArray(data?.sessions) ? data.sessions : [];
  const runSteps = Array.isArray(data?.runSteps) ? data.runSteps : [];
  const agents = Array.isArray(data?.agents) ? data.agents : [];
  const runById = new Map(runs.map((run) => [String(run?.run_id || ""), run]));
  const stepsByRun = new Map();
  for (const step of runSteps) {
    const runId = String(step?.run_id || "");
    if (!stepsByRun.has(runId)) stepsByRun.set(runId, []);
    stepsByRun.get(runId).push(step);
  }

  const statusCounts = Object.fromEntries(
    ["queued", "planning", "running", "synthesizing", "completed", "failed", "cancelled", "unknown"]
      .map((status) => [status, 0])
  );
  for (const run of runs) {
    const rawStatus = String(run?.status || "").trim().toLowerCase();
    const status = Object.hasOwn(statusCounts, rawStatus) ? rawStatus : "unknown";
    statusCounts[status] += 1;
  }
  const completedRuns = runs.filter((run) => run?.status === "completed");
  const activeRuns = statusCounts.queued + statusCounts.planning + statusCounts.running + statusCounts.synthesizing;

  const decisionMix = { direct: 0, clarify: 0, delegate: 0, unknown: 0 };
  for (const run of runs) {
    const decision = String(run?.plan?.routing?.orchestrator?.decision || "").trim().toLowerCase();
    if (Object.hasOwn(decisionMix, decision) && decision !== "unknown") decisionMix[decision] += 1;
    else decisionMix.unknown += 1;
  }
  const decisionSampleCount = runs.length - decisionMix.unknown;
  const decisionRates = Object.fromEntries(
    ["direct", "clarify", "delegate"].map((decision) => [
      decision,
      decisionSampleCount > 0 ? Number((decisionMix[decision] / decisionSampleCount).toFixed(4)) : null
    ])
  );

  const opportunities = [];
  const opportunitiesByRun = new Map();
  const ensureOpportunity = ({ run, stepId, adapter, fallbackKey }) => {
    const runId = String(run?.run_id || "");
    if (!opportunitiesByRun.has(runId)) opportunitiesByRun.set(runId, new Map());
    const byKey = opportunitiesByRun.get(runId);
    const normalizedStepId = String(stepId || "").trim();
    const normalizedAdapter = String(adapter || "").trim();
    let key = normalizedStepId ? `step:${normalizedStepId}` : "";
    if (!key && normalizedAdapter) {
      const matches = [...byKey.values()].filter((item) => item.adapter === normalizedAdapter);
      if (matches.length === 1) return matches[0];
    }
    if (!key) key = `anonymous:${fallbackKey}`;
    if (!byKey.has(key)) {
      const opportunity = {
        run,
        run_id: runId,
        step_id: normalizedStepId,
        adapter: normalizedAdapter,
        selected: false,
        step: null,
        events: []
      };
      byKey.set(key, opportunity);
      opportunities.push(opportunity);
    }
    const opportunity = byKey.get(key);
    if (!opportunity.adapter && normalizedAdapter) opportunity.adapter = normalizedAdapter;
    if (!opportunity.step_id && normalizedStepId) opportunity.step_id = normalizedStepId;
    return opportunity;
  };

  for (const run of runs) {
    const planSteps = Array.isArray(run?.plan?.steps) ? run.plan.steps : [];
    for (const [index, step] of planSteps.entries()) {
      const opportunity = ensureOpportunity({
        run,
        stepId: step?.id || step?.step_id,
        adapter: step?.adapter,
        fallbackKey: `plan:${index}`
      });
      opportunity.selected = true;
      opportunity.planStep = step;
    }
    for (const [index, step] of (stepsByRun.get(String(run?.run_id || "")) || []).entries()) {
      const opportunity = ensureOpportunity({
        run,
        stepId: step?.step_id || step?.id,
        adapter: step?.adapter,
        fallbackKey: `stored:${index}`
      });
      // A durable run-step can only exist after the route was selected, even
      // when an older run predates persisted planner contracts.
      opportunity.selected = true;
      opportunity.step = step;
    }
    for (const [index, event] of (Array.isArray(run?.events) ? run.events : []).entries()) {
      const eventType = String(event?.type || "");
      if (!["route.started", "route.completed", "route.failed", "route.reused"].includes(eventType)) continue;
      const opportunity = ensureOpportunity({
        run,
        stepId: event?.step_id || event?.id,
        adapter: event?.adapter,
        fallbackKey: `event:${index}`
      });
      opportunity.selected = true;
      opportunity.events.push(event);
    }
  }

  // Retain orphaned durable steps in the operational totals. They should not
  // disappear merely because a damaged legacy store lost the parent run.
  for (const [index, step] of runSteps.entries()) {
    const runId = String(step?.run_id || "");
    if (runById.has(runId)) continue;
    const syntheticRun = { run_id: runId, status: "unknown", events: [] };
    const opportunity = ensureOpportunity({
      run: syntheticRun,
      stepId: step?.step_id || step?.id,
      adapter: step?.adapter,
      fallbackKey: `orphan:${index}`
    });
    opportunity.selected = true;
    opportunity.step = step;
  }

  const hasInvalidValidation = (step) => [
    "source_validation", "consumption_validation", "artifact_validation", "outcome_validation"
  ].some((field) => Object.prototype.hasOwnProperty.call(step || {}, field) && step?.[field]?.valid !== true);
  const routeFacts = opportunities.map((opportunity) => {
    const step = opportunity.step;
    const eventTypes = new Set(opportunity.events.map((event) => String(event?.type || "")));
    const reused = step?.execution_mode === "reused" || eventTypes.has("route.reused");
    const stepStatus = String(step?.status || "").trim().toLowerCase();
    const terminalSuccess = eventTypes.has("route.completed") || stepStatus === "completed";
    const terminalFailureEvent = opportunity.events.find((event) => event?.type === "route.failed") || null;
    const policyViolations = Array.isArray(step?.policy_violations) ? step.policy_violations.filter(Boolean) : [];
    const explicitlyFailed = Boolean(
      terminalFailureEvent
      || ["failed", "blocked"].includes(stepStatus)
      || step?.failure_class
      || step?.failure?.failure_class
      || hasInvalidValidation(step)
      || policyViolations.length > 0
    );
    const attempted = !reused && Boolean(
      step
      || eventTypes.has("route.started")
      || eventTypes.has("route.completed")
      || eventTypes.has("route.failed")
    );
    const runTerminal = ["completed", "failed", "cancelled"].includes(String(opportunity.run?.status || ""));
    const missingTerminal = attempted && !terminalSuccess && !explicitlyFailed && runTerminal;
    const failed = attempted && (explicitlyFailed || missingTerminal);
    const validated = attempted && terminalSuccess && !failed;
    const failureClass = String(
      terminalFailureEvent?.failure_class
      || step?.failure_class
      || step?.failure?.failure_class
      || (stepStatus === "blocked" ? "blocked" : "")
      || (hasInvalidValidation(step) ? "validation_failed" : "")
      || (policyViolations.length > 0 ? "policy_validation" : "")
      || (missingTerminal ? "missing_terminal_route" : "")
    ).trim() || null;
    const failureStatus = failed
      ? String(terminalFailureEvent?.status || stepStatus || "failed").toLowerCase() === "blocked"
        ? "blocked"
        : missingTerminal
          ? "incomplete"
          : "failed"
      : null;
    const terminalEvent = [...opportunity.events].reverse().find((event) => (
      ["route.completed", "route.failed", "route.reused"].includes(String(event?.type || ""))
    ));
    const elapsed = metricDuration(step?.elapsed_sec ?? terminalEvent?.elapsed_sec);
    return {
      ...opportunity,
      attempted,
      failed,
      failure_class: failureClass,
      failure_status: failureStatus,
      reused,
      validated,
      elapsed_sec: reused ? null : elapsed
    };
  });

  const selectedRoutes = routeFacts.filter((route) => route.selected);
  const attemptedRoutes = routeFacts.filter((route) => route.attempted);
  const validatedRoutes = routeFacts.filter((route) => route.validated);
  const failedRoutes = routeFacts.filter((route) => route.failed);
  const reusedRoutes = routeFacts.filter((route) => route.reused);
  const selectedRouteCounts = countByAdapter(selectedRoutes);
  const attemptedRouteCounts = countByAdapter(attemptedRoutes);
  const validatedRouteCounts = countByAdapter(validatedRoutes);
  const reusedRouteCounts = countByAdapter(reusedRoutes);
  const failedAgentCounts = new Map();
  for (const route of failedRoutes) {
    if (!route.adapter) continue;
    if (!failedAgentCounts.has(route.adapter)) {
      failedAgentCounts.set(route.adapter, { count: 0, failureClasses: new Map() });
    }
    const entry = failedAgentCounts.get(route.adapter);
    entry.count += 1;
    const failureClass = route.failure_class || "unknown";
    entry.failureClasses.set(failureClass, (entry.failureClasses.get(failureClass) || 0) + 1);
  }

  const runRouteSummaries = new Map();
  for (const route of routeFacts) {
    if (!runRouteSummaries.has(route.run_id)) {
      runRouteSummaries.set(route.run_id, { failed: 0, successful: 0 });
    }
    const summary = runRouteSummaries.get(route.run_id);
    if (route.failed) summary.failed += 1;
    if (route.validated || route.reused) summary.successful += 1;
  }
  const runHasPartialFailure = (summary) => summary.failed > 0 && summary.successful > 0;
  const runHasAllRoutesFailed = (summary) => summary.failed > 0 && summary.successful === 0;
  const routeFailureRuns = [...runRouteSummaries.values()].filter((summary) => summary.failed > 0).length;
  const partialFailureRuns = [...runRouteSummaries.values()].filter(runHasPartialFailure).length;
  const allRoutesFailedRuns = [...runRouteSummaries.values()].filter(runHasAllRoutesFailed).length;
  const completedRunIds = new Set(completedRuns.map((run) => String(run?.run_id || "")));
  const completedPartialFailureRuns = [...runRouteSummaries.entries()]
    .filter(([runId, summary]) => completedRunIds.has(runId) && runHasPartialFailure(summary)).length;
  const completedAllRoutesFailedRuns = [...runRouteSummaries.entries()]
    .filter(([runId, summary]) => completedRunIds.has(runId) && runHasAllRoutesFailed(summary)).length;

  const queueLatencies = [];
  const plannerLatencies = [];
  const routePhaseLatencies = [];
  const synthesisLatencies = [];
  const executionLatencies = [];
  const totalLatencies = [];
  for (const run of runs) {
    const createdAt = metricTimestamp(run?.created_at);
    const startedAt = firstMetricTimestamp(
      metricTimestamp(run?.started_at),
      metricEventTimestamp(run, ["run.started"], false)
    );
    const plannerStartedAt = firstMetricTimestamp(
      metricEventTimestamp(run, ["planner.started"], false),
      metricEventTimestamp(run, ["runtime.requested"], false),
      startedAt
    );
    const plannerCompletedAt = metricEventTimestamp(run, ["planner.completed"], false);
    const synthesisStartedAt = metricEventTimestamp(run, ["synthesis.started"], false);
    const terminalAt = firstMetricTimestamp(
      metricTimestamp(run?.completed_at),
      metricEventTimestamp(run, ["final.completed", "run.failed"], true)
    );
    pushMetricDuration(queueLatencies, secondsBetween(createdAt, startedAt));
    pushMetricDuration(plannerLatencies, secondsBetween(plannerStartedAt, plannerCompletedAt));
    pushMetricDuration(routePhaseLatencies, secondsBetween(plannerCompletedAt, synthesisStartedAt));
    pushMetricDuration(synthesisLatencies, secondsBetween(synthesisStartedAt, terminalAt));
    pushMetricDuration(executionLatencies, secondsBetween(startedAt, terminalAt) ?? metricDuration(run?.elapsed_sec));
    pushMetricDuration(totalLatencies, secondsBetween(createdAt, terminalAt) ?? metricDuration(run?.elapsed_sec));
  }
  const routeLatencies = attemptedRoutes.map((route) => route.elapsed_sec).filter((value) => value !== null);
  const latencyPercentile = (values, percentile) => {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((left, right) => left - right);
    const index = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * percentile));
    return Number(sorted[index].toFixed(3));
  };

  const agentById = new Map(agents.map((agent) => [String(agent?.id || ""), agent]));
  const retrievalMissCount = routeFacts.filter((route) => {
    if (!(route.attempted || route.reused)) return false;
    const step = route.step || {};
    const agent = agentById.get(route.adapter) || {};
    const declaredTools = [...(Array.isArray(agent.tools) ? agent.tools : []), ...(Array.isArray(step.allowed_tools) ? step.allowed_tools : [])];
    const consumes = Array.isArray(agent.consumes) ? agent.consumes : [];
    const hasRetrievalContract = agentOwnsSemanticContext(agent)
      || declaredTools.some((tool) => ["document_search", "document_read"].includes(String(tool)))
      || consumes.some((name) => DOCUMENT_CONTEXT_ARTIFACTS.has(String(name)));
    if (!hasRetrievalContract) return false;
    const successfulDocumentTool = (Array.isArray(step.tool_executions) ? step.tool_executions : []).some((execution) => (
      ["document_search", "document_read"].includes(String(execution?.tool || execution?.name || execution?.result?.tool || ""))
      && execution?.result?.ok === true
    ));
    const retrievedContext = step.retrieved_context;
    const hasRetrievedContext = typeof retrievedContext === "string"
      ? retrievedContext.trim().length > 0
      : Array.isArray(retrievedContext)
        ? retrievedContext.length > 0
        : Boolean(retrievedContext && typeof retrievedContext === "object" && Object.keys(retrievedContext).length > 0);
    const hasCitations = Array.isArray(step.citations) && step.citations.length > 0;
    const approvedSourceCount = metricDuration(step?.source_validation?.approved_source_count) || 0;
    return !successfulDocumentTool && !hasRetrievedContext && !hasCitations && approvedSourceCount <= 0;
  }).length;

  const failedAgents = [...failedAgentCounts.entries()]
    .map(([agent_id, failure]) => ({
      agent_id,
      count: failure.count,
      attempts: attemptedRouteCounts.get(agent_id) || 0,
      failure_rate: ratio(failure.count, attemptedRouteCounts.get(agent_id) || 0),
      failure_classes: Object.fromEntries([...failure.failureClasses.entries()].sort(([left], [right]) => left.localeCompare(right)))
    }))
    .sort((left, right) => right.count - left.count || left.agent_id.localeCompare(right.agent_id));
  const allAgentIds = [...new Set([
    ...selectedRouteCounts.keys(),
    ...attemptedRouteCounts.keys(),
    ...validatedRouteCounts.keys(),
    ...reusedRouteCounts.keys(),
    ...failedAgentCounts.keys()
  ])].sort();
  const agentInvocationMetrics = allAgentIds.map((agent_id) => ({
    agent_id,
    selected: selectedRouteCounts.get(agent_id) || 0,
    attempted: attemptedRouteCounts.get(agent_id) || 0,
    validated: validatedRouteCounts.get(agent_id) || 0,
    failed: failedAgentCounts.get(agent_id)?.count || 0,
    reused: reusedRouteCounts.get(agent_id) || 0,
    success_rate: ratio(validatedRouteCounts.get(agent_id) || 0, attemptedRouteCounts.get(agent_id) || 0)
  }));
  const invocationSuccessRate = ratio(validatedRoutes.length, attemptedRoutes.length);
  const routeFailureStatusCounts = { failed: 0, blocked: 0, incomplete: 0 };
  for (const route of failedRoutes) {
    const status = Object.hasOwn(routeFailureStatusCounts, route.failure_status) ? route.failure_status : "failed";
    routeFailureStatusCounts[status] += 1;
  }
  const routeFailureReasonCounts = new Map();
  let routeRepairAttemptedCount = 0;
  let routeRepairValidCount = 0;
  let unsupportedClaimCount = 0;
  for (const route of failedRoutes) {
    const observability = route.step?.failure_observability_admin_only;
    if (!observability || typeof observability !== "object" || Array.isArray(observability)) continue;
    const safeCodes = new Set((Array.isArray(observability.failure_reason_codes)
      ? observability.failure_reason_codes
      : [])
      .map(normalizeRuntimeFailureReasonCode)
      .filter(Boolean));
    for (const code of safeCodes) {
      routeFailureReasonCounts.set(code, (routeFailureReasonCounts.get(code) || 0) + 1);
    }
    if (observability.repair_attempted === true) routeRepairAttemptedCount += 1;
    if (observability.repair_attempted === true && observability.repair_valid === true) {
      routeRepairValidCount += 1;
    }
    const routeUnsupportedClaims = Number(observability.unsupported_claim_count);
    if (Number.isSafeInteger(routeUnsupportedClaims) && routeUnsupportedClaims > 0) {
      unsupportedClaimCount = Math.min(10_000_000, unsupportedClaimCount + Math.min(routeUnsupportedClaims, 10_000));
    }
  }

  return {
    schema_version: "admin-metrics-v2",
    latency_unit: "seconds",
    total_chats: sessions.length,
    // `total_runs` is retained for the existing Admin UI, whose label is
    // "Completed runs". `total_run_records` exposes every durable status.
    total_runs: completedRuns.length,
    total_run_records: runs.length,
    completed_runs: completedRuns.length,
    failed_runs: statusCounts.failed,
    active_runs: activeRuns,
    run_status_counts: statusCounts,
    routing_decision_mix: decisionMix,
    routing_decision_rates: decisionRates,
    routing_decision_sample_count: decisionSampleCount,
    selected_route_count: selectedRoutes.length,
    attempted_route_count: attemptedRoutes.length,
    validated_route_count: validatedRoutes.length,
    failed_route_count: failedRoutes.length,
    blocked_route_count: routeFailureStatusCounts.blocked,
    reused_route_count: reusedRoutes.length,
    successful_route_count: validatedRoutes.length + reusedRoutes.length,
    unattempted_route_count: selectedRoutes.length - attemptedRoutes.length - reusedRoutes.length,
    invocation_success_rate: invocationSuccessRate,
    invocation_success_percent: invocationSuccessRate === null ? null : Number((invocationSuccessRate * 100).toFixed(2)),
    runs_with_route_failures: routeFailureRuns,
    partial_route_failure_runs: partialFailureRuns,
    all_route_failure_runs: allRoutesFailedRuns,
    completed_partial_route_failure_runs: completedPartialFailureRuns,
    completed_all_route_failure_runs: completedAllRoutesFailedRuns,
    route_failure_status_counts: routeFailureStatusCounts,
    route_failure_reason_counts: Object.fromEntries(
      [...routeFailureReasonCounts.entries()].sort(([left], [right]) => left.localeCompare(right))
    ),
    route_repair_attempted_count: routeRepairAttemptedCount,
    route_repair_valid_count: routeRepairValidCount,
    unsupported_claim_count: unsupportedClaimCount,
    average_queue_latency: average(queueLatencies),
    average_planner_latency: average(plannerLatencies),
    average_route_latency: average(routeLatencies),
    average_route_phase_latency: average(routePhaseLatencies),
    average_synthesis_latency: average(synthesisLatencies),
    average_execution_latency: average(executionLatencies),
    average_end_to_end_latency: average(totalLatencies),
    average_total_latency: average(totalLatencies),
    p50_end_to_end_latency: latencyPercentile(totalLatencies, 0.5),
    p95_end_to_end_latency: latencyPercentile(totalLatencies, 0.95),
    p99_end_to_end_latency: latencyPercentile(totalLatencies, 0.99),
    latency_sample_counts: {
      queue: queueLatencies.length,
      planner: plannerLatencies.length,
      route: routeLatencies.length,
      route_phase: routePhaseLatencies.length,
      synthesis: synthesisLatencies.length,
      execution: executionLatencies.length,
      total: totalLatencies.length
    },
    average_parallel_batch_width: average(runs.flatMap((run) => (
      Array.isArray(run?.parallel?.batches)
        ? run.parallel.batches.map((batch) => metricDuration(batch?.width)).filter((width) => width !== null)
        : []
    ))),
    vllm_waiting_queue_count: null,
    gpu_kv_cache_usage: null,
    policy_violation_count: runs.reduce((total, run) => total + (Array.isArray(run?.policy_events) ? run.policy_events.length : 0), 0),
    retrieval_miss_count: retrievalMissCount,
    bad_response_flags: runs.filter((run) => run?.feedback?.some((item) => item?.rating === "bad")).length,
    // Usage means a fresh, validated invocation. Selection, attempts, reuse,
    // and failures remain separately observable below.
    most_used_agents: rankedCounts(validatedRouteCounts),
    most_attempted_agents: rankedCounts(attemptedRouteCounts),
    failed_agents: failedAgents,
    most_common_routes: rankedCounts(selectedRouteCounts),
    agent_invocation_metrics: agentInvocationMetrics
  };
}

function metricDuration(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function metricTimestamp(value) {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function firstMetricTimestamp(...values) {
  return values.find((value) => value !== null && value !== undefined) ?? null;
}

function metricEventTimestamp(run, types, last) {
  const allowed = new Set(types);
  const timestamps = (Array.isArray(run?.events) ? run.events : [])
    .filter((event) => allowed.has(String(event?.type || "")))
    .map((event) => metricTimestamp(event?.at))
    .filter((timestamp) => timestamp !== null);
  if (timestamps.length === 0) return null;
  return last ? Math.max(...timestamps) : Math.min(...timestamps);
}

function secondsBetween(start, end) {
  if (start === null || end === null || end < start) return null;
  return Number(((end - start) / 1000).toFixed(3));
}

function pushMetricDuration(target, value) {
  if (value !== null) target.push(value);
}

function ratio(numerator, denominator) {
  return denominator > 0 ? Number((numerator / denominator).toFixed(4)) : null;
}

function countByAdapter(routes) {
  const counts = new Map();
  for (const route of routes) {
    if (!route.adapter) continue;
    counts.set(route.adapter, (counts.get(route.adapter) || 0) + 1);
  }
  return counts;
}

function rankedCounts(counts) {
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 8)
    .map(([agent_id, count]) => ({ agent_id, count }));
}

function average(values) {
  if (values.length === 0) return 0;
  return Number((values.reduce((total, value) => total + value, 0) / values.length).toFixed(3));
}

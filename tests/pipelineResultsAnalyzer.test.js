import { describe, expect, it } from "vitest";
import {
  analyzePipelineResults,
  dependencyMapFromAgentLibrary,
  renderPipelineReport
} from "../e2e/analyzePipelineResults.mjs";

const JUNK = "junk_agent";

function scenario({
  id,
  category,
  expectedDecision,
  requiredAgents = [],
  allowedAgents = requiredAgents,
  needsAttachment = false
}) {
  return {
    id,
    category,
    expectedDecision,
    requiredAgents,
    allowedAgents,
    forbiddenAgents: [JUNK],
    needsAttachment,
    oracleHints: ["Human-only qualitative check"]
  };
}

function completedOutput({ id, adapter, elapsed = 0.5, executionMode = "refreshed", tools = [] }) {
  return {
    step_id: id,
    adapter,
    status: "completed",
    execution_mode: executionMode,
    source_validation: { valid: true },
    consumption_validation: { valid: true },
    artifact_validation: { valid: true },
    outcome_validation: { valid: true },
    tool_executions: tools,
    elapsed_sec: elapsed
  };
}

function completedRun({ decision, steps = [], outputs = [], elapsed = 1, sources = [] }) {
  return {
    status: "completed",
    final_answer: "Observable answer",
    plan: {
      routing: { orchestrator: { decision } },
      steps
    },
    expert_outputs: outputs,
    events: outputs.flatMap((output) => [{
      type: output.execution_mode === "reused"
        ? "route.reused"
        : output.status === "blocked"
          ? "route.failed"
          : "route.completed",
      step_id: output.step_id,
      adapter: output.adapter,
      status: output.status,
      elapsed_sec: output.elapsed_sec
    }]),
    sources,
    elapsed_sec: elapsed
  };
}

describe("pipeline browser result analyzer", () => {
  it("reports a run submitted into a different session even when the run completes", () => {
    const fixture = scenario({
      id: "session_drift",
      category: "direct",
      expectedDecision: "direct"
    });
    const run = {
      ...completedRun({ decision: "direct" }),
      session_id: "sess_old"
    };
    const metrics = analyzePipelineResults({
      scenario_count: 1,
      results: [{
        scenario_id: fixture.id,
        session_id: "sess_new",
        run,
        queued: { http_status: 202 },
        ui: { assistant_visible: true, answer_matches_api: true },
        diagnostics: { console_errors: [], page_errors: [], failed_responses: [] }
      }]
    }, { scenarios: [fixture], dependencyMap: new Map() });

    expect(metrics.ui.session_identity_matches).toMatchObject({
      successes: 0,
      total: 1,
      rate: 0
    });
    expect(metrics.scenarios[0].problems).toContain("session_binding_mismatch");
  });

  it("scores routing, fresh invocation, evidence, UI, and harness contracts without qualitative grading", () => {
    const scenarios = [
      scenario({
        id: "document_delegate",
        category: "document_routing",
        expectedDecision: "delegate",
        requiredAgents: ["core_agent"],
        needsAttachment: true
      }),
      scenario({ id: "direct_false_delegate", category: "direct", expectedDecision: "direct" }),
      scenario({ id: "clarify_correct", category: "clarify", expectedDecision: "clarify" }),
      scenario({
        id: "missing_delegate",
        category: "automatic_routing",
        expectedDecision: "delegate",
        requiredAgents: ["missing_agent"]
      })
    ];
    const coreOutput = completedOutput({
      id: "core",
      adapter: "core_agent",
      elapsed: 1,
      tools: [{ name: "calculator", result: { ok: true, tool: "calculator" } }]
    });
    const dependencyOutput = completedOutput({
      id: "dependency",
      adapter: "dependency_agent",
      executionMode: "reused",
      elapsed: 0
    });
    const attachmentOutput = completedOutput({
      id: "attachment",
      adapter: "uploaded_document_agent",
      elapsed: 0.5,
      tools: [{ name: "document_search", result: { ok: true, tool: "document_search" } }]
    });
    const blockedOutput = {
      step_id: "junk",
      adapter: JUNK,
      status: "blocked",
      execution_mode: "refreshed",
      failure: { status: "blocked", failure_class: "policy_validation" },
      source_validation: { valid: false },
      elapsed_sec: 4
    };
    const raw = {
      schema_version: "virenis-browser-pipeline-benchmark-v1",
      scenario_count: 4,
      started_at: "2026-07-19T00:00:00.000Z",
      completed_at: "2026-07-19T00:01:00.000Z",
      results: [
        {
          scenario_id: "document_delegate",
          attachment: { agent_id: "uploaded_document_agent" },
          run: completedRun({
            decision: "delegate",
            steps: [
              { id: "core", adapter: "core_agent" },
              { id: "dependency", adapter: "dependency_agent" },
              { id: "attachment", adapter: "uploaded_document_agent" }
            ],
            outputs: [coreOutput, dependencyOutput, attachmentOutput],
            elapsed: 2,
            sources: [{ chunk_id: "chunk_1" }]
          }),
          queued: { http_status: 202 },
          ui: { assistant_visible: true, answer_matches_api: true },
          diagnostics: { console_errors: [], page_errors: [], failed_responses: [] },
          poll_elapsed_ms: 2500,
          started_at: "2026-07-19T00:00:00.000Z",
          completed_at: "2026-07-19T00:00:05.000Z"
        },
        {
          scenario_id: "direct_false_delegate",
          run: completedRun({
            decision: "delegate",
            steps: [{ id: "junk", adapter: JUNK }],
            outputs: [blockedOutput],
            elapsed: 4
          }),
          queued: { http_status: 202 },
          ui: { assistant_visible: true, answer_matches_api: true },
          diagnostics: {
            console_errors: [],
            page_errors: [],
            failed_responses: [{ status: 500, method: "GET", path: "/api/example" }]
          },
          poll_elapsed_ms: 4500,
          started_at: "2026-07-19T00:00:10.000Z",
          completed_at: "2026-07-19T00:00:16.000Z"
        },
        {
          scenario_id: "clarify_correct",
          run: completedRun({ decision: "clarify", elapsed: 1 }),
          queued: { http_status: 202 },
          ui: { assistant_visible: true, answer_matches_api: true },
          diagnostics: { console_errors: [], page_errors: [], failed_responses: [] },
          poll_elapsed_ms: 1200,
          started_at: "2026-07-19T00:00:20.000Z",
          completed_at: "2026-07-19T00:00:22.000Z"
        },
        {
          scenario_id: "missing_delegate",
          error: { message: "Browser timed out" },
          diagnostics: { console_errors: [], page_errors: [], failed_responses: [] },
          started_at: "2026-07-19T00:00:30.000Z",
          completed_at: "2026-07-19T00:00:31.000Z"
        }
      ],
      worker_errors: []
    };
    raw.results[0].run.usage_receipt = {
      complete: true,
      provider_reported: true,
      call_count: 2,
      prompt_tokens: 100,
      completion_tokens: 20,
      total_tokens: 120,
      charged_micros: 120000
    };
    raw.results[1].run.usage_receipt = {
      complete: true,
      provider_reported: true,
      call_count: 3,
      prompt_tokens: 200,
      completion_tokens: 30,
      total_tokens: 230,
      charged_micros: 230000
    };

    const metrics = analyzePipelineResults(raw, {
      scenarios,
      dependencyMap: { core_agent: ["dependency_agent"] },
      junkAgentIds: [JUNK],
      generatedAt: "2026-07-19T01:00:00.000Z"
    });

    expect(metrics.status.completed_runs).toBe(3);
    expect(metrics.harness.result_errors).toBe(1);
    expect(metrics.harness.clean_scenarios).toMatchObject({ successes: 3, total: 4, rate: 0.75 });
    expect(metrics.ui.assistant_visible.rate).toBe(1);
    expect(metrics.network).toMatchObject({ failed_response_count: 1, server_error_count: 1 });

    expect(metrics.routing.decision_accuracy).toMatchObject({ successes: 2, total: 4, rate: 0.5 });
    expect(metrics.routing.direct_false_delegation).toMatchObject({ successes: 1, total: 1, rate: 1 });
    expect(metrics.routing.clarify_false_delegation).toMatchObject({ successes: 0, total: 1, rate: 0 });
    expect(metrics.routing.required_agent_recall).toMatchObject({ successes: 1, total: 2, rate: 0.5 });
    expect(metrics.routing.required_agent_recall.wilson_95.low).toBeCloseTo(0.094531, 5);
    expect(metrics.routing.required_agent_recall.wilson_95.high).toBeCloseTo(0.905469, 5);
    expect(metrics.routing.route_precision).toMatchObject({ successes: 3, total: 4, rate: 0.75 });
    expect(metrics.routing.exact_graph_success).toMatchObject({ successes: 2, total: 4, rate: 0.5 });
    expect(metrics.routing.forbidden.invocation_rate).toMatchObject({ successes: 1, total: 3, rate: 0.333333 });
    expect(metrics.routing.junk.invocation_rate.rate).toBe(0.333333);

    expect(metrics.invocations).toMatchObject({
      selected: 4,
      attempted: 3,
      validated: 2,
      failed: 0,
      blocked: 1,
      reused: 1
    });
    expect(metrics.invocations.invocation_success).toMatchObject({ successes: 2, total: 3, rate: 0.666667 });
    expect(metrics.agents.find((agent) => agent.agent_id === JUNK)).toMatchObject({
      attempted: 1,
      validated: 0,
      failed: 0,
      blocked: 1
    });

    expect(metrics.latency.run).toMatchObject({ samples: 3, mean: 2.333, p50: 2, p95: 3.8 });
    expect(metrics.usage.receipts_complete).toMatchObject({ successes: 2, total: 3, rate: 0.666667 });
    expect(metrics.usage.provider_reported).toMatchObject({ successes: 2, total: 3, rate: 0.666667 });
    expect(metrics.usage.totals).toMatchObject({
      model_calls: 5,
      prompt_tokens: 300,
      completion_tokens: 50,
      total_tokens: 350,
      charged_micros: 350000,
      charged_credits: 0.35
    });
    expect(metrics.usage.per_scenario.total_tokens).toMatchObject({
      unit: "tokens",
      samples: 2,
      mean: 175,
      p50: 175,
      p95: 225
    });
    expect(metrics.usage.validated_routes_per_credit).toBe(5.7143);
    expect(renderPipelineReport(metrics)).toContain("Model usage and charged credits");
    expect(metrics.evidence.citations).toMatchObject({ total: 1 });
    expect(metrics.evidence.tools).toMatchObject({ executions: 2, successful_executions: 2 });
    expect(metrics.evidence.documents).toMatchObject({ scenarios: 1 });
    expect(metrics.evidence.documents.citation_rate.rate).toBe(1);
    expect(metrics.evidence.documents.document_tool_rate.rate).toBe(1);
    expect(metrics.evidence.attachments.registered.rate).toBe(1);
    expect(metrics.evidence.attachments.attachment_agent_selected.rate).toBe(1);

    const documentScore = metrics.scenarios.find((item) => item.scenario_id === "document_delegate");
    expect(documentScore.effective_allowed_agents).toEqual([
      "core_agent",
      "dependency_agent",
      "uploaded_document_agent"
    ]);
    expect(documentScore.route_precision).toBe(1);
    expect(documentScore.problems).toEqual([]);
    expect(metrics.scenarios.find((item) => item.scenario_id === "missing_delegate").problems)
      .toEqual(expect.arrayContaining(["harness:Browser timed out", "no_run", "missing_required:missing_agent"]));

    const report = renderPipelineReport(metrics);
    expect(report).toContain("Required-agent recall is 50.0% (Wilson 95% CI 9.5–90.5%)");
    expect(report).toContain("oracle_hints");
    expect(report).toContain("direct_false_delegate");
    expect(report).not.toContain("Human-only qualitative check");
  });

  it("derives configured route dependencies from agent consume contracts", () => {
    expect(dependencyMapFromAgentLibrary({
      adapters: [
        {
          id: "synthesizer",
          consumes: ["user_request", "agent:researcher:output", "agent:critic:output"],
          resources: ["agent:calculator", "document_index"]
        },
        { id: "researcher", consumes: ["user_request"] }
      ]
    })).toEqual({ synthesizer: ["researcher", "critic", "calculator"] });
  });

  it("deltas durable admin counters and reconciles canonical benchmark observations", () => {
    const scenarios = [
      scenario({
        id: "completed_with_reuse",
        category: "workflow",
        expectedDecision: "delegate",
        requiredAgents: ["core_agent"]
      }),
      scenario({
        id: "failed_with_block",
        category: "workflow",
        expectedDecision: "delegate",
        requiredAgents: ["blocked_agent"]
      })
    ];
    const coreOutput = completedOutput({ id: "core", adapter: "core_agent" });
    const reusedOutput = completedOutput({
      id: "cached",
      adapter: "cached_agent",
      executionMode: "reused"
    });
    const blockedOutput = {
      step_id: "blocked",
      adapter: "blocked_agent",
      status: "blocked",
      execution_mode: "refreshed",
      failure: { status: "blocked", failure_class: "policy_validation" },
      source_validation: { valid: false }
    };
    const successfulRun = completedRun({
      decision: "delegate",
      steps: [
        { id: "core", adapter: "core_agent" },
        { id: "cached", adapter: "cached_agent" }
      ],
      outputs: [coreOutput, reusedOutput]
    });
    const failedRun = completedRun({
      decision: "delegate",
      steps: [{ id: "blocked", adapter: "blocked_agent" }],
      outputs: [blockedOutput]
    });
    failedRun.status = "failed";
    const adminMetricsBefore = {
      schema_version: "admin-metrics-v2",
      total_chats: 5,
      total_run_records: 10,
      completed_runs: 8,
      failed_runs: 2,
      selected_route_count: 20,
      attempted_route_count: 15,
      validated_route_count: 12,
      failed_route_count: 2,
      blocked_route_count: 1,
      reused_route_count: 3,
      invocation_success_rate: 0.8,
      routing_decision_rates: { delegate: 0.75 }
    };
    const adminMetricsAfter = {
      schema_version: "admin-metrics-v2",
      total_chats: 7,
      total_run_records: 12,
      completed_runs: 9,
      failed_runs: 3,
      // Deliberate mismatch: the endpoint observed one extra selected route.
      selected_route_count: 24,
      attempted_route_count: 17,
      validated_route_count: 13,
      failed_route_count: 3,
      blocked_route_count: 2,
      reused_route_count: 4,
      invocation_success_rate: 0.7647,
      routing_decision_rates: { delegate: 0.8 }
    };
    const raw = {
      scenario_count: 2,
      admin_metrics_before: adminMetricsBefore,
      admin_metrics_after: adminMetricsAfter,
      results: [
        {
          scenario_id: "completed_with_reuse",
          session_id: "session_1",
          run: successfulRun,
          ui: { assistant_visible: true, answer_matches_api: true },
          diagnostics: { console_errors: [], page_errors: [], failed_responses: [] }
        },
        {
          scenario_id: "failed_with_block",
          session_id: "session_2",
          run: failedRun,
          diagnostics: { console_errors: [], page_errors: [], failed_responses: [] }
        }
      ]
    };

    const metrics = analyzePipelineResults(raw, {
      scenarios,
      dependencyMap: { core_agent: ["cached_agent"] },
      junkAgentIds: []
    });

    expect(metrics.admin_metrics.snapshots).toMatchObject({
      before: { status: "captured", schema_version: "admin-metrics-v2" },
      after: { status: "captured", schema_version: "admin-metrics-v2" }
    });
    expect(metrics.admin_metrics.counter_deltas.chats).toMatchObject({
      before: 5, after: 7, delta: 2, counter_reset_detected: false
    });
    expect(metrics.admin_metrics.counter_deltas.selected_routes.delta).toBe(4);
    expect(metrics.admin_metrics.canonical_counts).toMatchObject({
      chats: 2,
      run_records: 2,
      completed_runs: 1,
      failed_runs: 1,
      selected_routes: 3,
      attempted_routes: 2,
      validated_routes: 1,
      failed_routes: 1,
      blocked_routes: 1,
      reused_routes: 1
    });
    expect(metrics.admin_metrics.reconciliation.counters.chats.comparison).toBe("match");
    expect(metrics.admin_metrics.reconciliation.counters.failed_routes).toMatchObject({
      admin_delta: 1,
      canonical_count: 1,
      comparison: "match"
    });
    expect(metrics.admin_metrics.reconciliation.counters.selected_routes).toMatchObject({
      admin_delta: 4,
      canonical_count: 3,
      difference: 1,
      comparison: "mismatch"
    });
    expect(metrics.admin_metrics.reconciliation.summary).toMatchObject({
      total_counters: 10,
      comparable_counters: 10,
      matches: 9,
      mismatches: 1,
      comparison: "mismatch"
    });
    expect(metrics.admin_metrics.raw_endpoint_rates).toMatchObject({
      before: {
        invocation_success_rate: 0.8,
        routing_decision_rates: { delegate: 0.75 }
      },
      after: {
        invocation_success_rate: 0.7647,
        routing_decision_rates: { delegate: 0.8 }
      }
    });
    expect(metrics.admin_metrics.raw_endpoint_rates).not.toHaveProperty("delta");
    const report = renderPipelineReport(metrics);
    expect(report).toContain("Durable admin counter reconciliation");
    expect(report).toContain("| Selected routes | 20 | 24 | 4 | 3 | mismatch |");
    expect(report).toContain("rates and averages are not subtracted");
  });

  it("keeps missing and capture-error admin snapshots explicitly unavailable", () => {
    const options = { scenarios: [], dependencyMap: {}, junkAgentIds: [] };
    const captureErrorMetrics = analyzePipelineResults({
      scenario_count: 0,
      results: [],
      admin_metrics_before: { capture_error: { message: "Forbidden" } },
      admin_metrics_after: {
        schema_version: "admin-metrics-v2",
        total_chats: 9,
        invocation_success_rate: 0.75
      }
    }, options);
    expect(captureErrorMetrics.admin_metrics.snapshots.before.status).toBe("capture_error");
    expect(captureErrorMetrics.admin_metrics.counter_deltas.chats).toMatchObject({
      before: null,
      after: 9,
      delta: null,
      unavailable_reason: "before_snapshot_capture_error"
    });
    expect(captureErrorMetrics.admin_metrics.reconciliation.counters.chats).toMatchObject({
      admin_delta: null,
      canonical_count: 0,
      comparison: null
    });
    expect(captureErrorMetrics.admin_metrics.raw_endpoint_rates).toMatchObject({
      before: null,
      after: { invocation_success_rate: 0.75 }
    });

    const missingMetrics = analyzePipelineResults({ scenario_count: 0, results: [] }, options);
    expect(missingMetrics.admin_metrics.snapshots).toMatchObject({
      before: { status: "missing" },
      after: { status: "missing" }
    });
    expect(missingMetrics.admin_metrics.counter_deltas.chats.delta).toBeNull();
    expect(missingMetrics.admin_metrics.reconciliation.summary).toMatchObject({
      comparable_counters: 0,
      comparison: null
    });
    expect(renderPipelineReport(missingMetrics)).toContain("| Chat sessions | n/a | n/a | n/a | 0 | n/a |");
  });

  it("does not let a terminal run hide a known observable non-result answer", () => {
    const scenarios = [scenario({
      id: "failed_synthesis",
      category: "document_routing",
      expectedDecision: "delegate",
      requiredAgents: ["document_agent"]
    })];
    const run = completedRun({
      decision: "delegate",
      steps: [{ id: "source", adapter: "document_agent" }],
      outputs: [completedOutput({ id: "source", adapter: "document_agent" })],
      sources: [{ chunk_id: "chunk_1" }]
    });
    run.final_answer = "I cannot provide a source-grounded answer from the approved excerpts because the available evidence was missing.";
    const metrics = analyzePipelineResults({
      scenario_count: 1,
      results: [{
        scenario_id: "failed_synthesis",
        run,
        ui: { assistant_visible: true, answer_matches_api: true },
        diagnostics: { console_errors: [], page_errors: [], failed_responses: [] }
      }]
    }, { scenarios, dependencyMap: {}, junkAgentIds: [] });

    expect(metrics.answers).toMatchObject({
      observable_non_results: 1,
      substantive_delegate_answers: { successes: 0, total: 1, rate: 0 }
    });
    expect(metrics.scenarios[0].problems).toContain("observable_non_result");
    expect(renderPipelineReport(metrics)).toContain("Observable non-result answers | 1");
  });

  it("classifies the runtime capability-blocked clarification as a non-result", () => {
    const scenarios = [scenario({
      id: "blocked_contract",
      category: "workflow",
      expectedDecision: "delegate",
      requiredAgents: ["financial_agent"]
    })];
    const run = completedRun({ decision: "clarify", steps: [], outputs: [] });
    run.final_answer = "The selected team cannot yet produce every required outcome with its configured outputs, inputs, sources, and tools. Please enable a compatible capability or adjust the requested deliverable.";
    const metrics = analyzePipelineResults({
      scenario_count: 1,
      results: [{
        scenario_id: "blocked_contract",
        run,
        ui: { assistant_visible: true, answer_matches_api: true },
        diagnostics: { console_errors: [], page_errors: [], failed_responses: [] }
      }]
    }, { scenarios, dependencyMap: {}, junkAgentIds: [] });

    expect(metrics.answers).toMatchObject({
      observable_non_results: 1,
      substantive_delegate_answers: { successes: 0, total: 1, rate: 0 }
    });
    expect(metrics.scenarios[0].problems).toContain("observable_non_result");
  });

  it("flags only severe loss between a substantial validated route and its final answer", () => {
    const scenarios = [
      scenario({
        id: "lost_lesson",
        category: "automatic_routing",
        expectedDecision: "delegate",
        requiredAgents: ["tutor"]
      }),
      scenario({
        id: "concise_lesson",
        category: "automatic_routing",
        expectedDecision: "delegate",
        requiredAgents: ["tutor"]
      })
    ];
    const result = (scenarioId, finalAnswer) => {
      const output = completedOutput({ id: "lesson", adapter: "tutor" });
      output.domain_answer = `Intuition and worked example. ${"Detailed lesson content. ".repeat(35)}Practice problem.`;
      const run = completedRun({
        decision: "delegate",
        steps: [{ id: "lesson", adapter: "tutor" }],
        outputs: [output]
      });
      run.final_answer = finalAnswer;
      return {
        scenario_id: scenarioId,
        run,
        ui: { assistant_visible: true, answer_matches_api: true },
        diagnostics: { console_errors: [], page_errors: [], failed_responses: [] }
      };
    };
    const metrics = analyzePipelineResults({
      scenario_count: 2,
      results: [
        result("lost_lesson", "The answer is 20."),
        result("concise_lesson", "A concise but meaningful lesson retains its intuition, worked example, and practice problem. ".repeat(3))
      ]
    }, { scenarios, dependencyMap: {}, junkAgentIds: [] });

    expect(metrics.answers.severe_single_route_answer_losses).toBe(1);
    expect(metrics.answers.single_route_answer_retention).toMatchObject({
      successes: 1,
      total: 2,
      rate: 0.5
    });
    expect(metrics.answers.substantive_delegate_answers).toMatchObject({
      successes: 1,
      total: 2,
      rate: 0.5
    });
    expect(metrics.scenarios[0].problems).toContain("severe_single_route_answer_loss");
    expect(metrics.scenarios[1].problems).not.toContain("severe_single_route_answer_loss");
    expect(renderPipelineReport(metrics)).toContain("Severe single-route answer losses | 1");
  });

  it("separates a terminal partial-result notice from ordinary limitations", () => {
    const scenarios = [
      scenario({
        id: "partial_financial_scenario",
        category: "workflow",
        expectedDecision: "delegate",
        requiredAgents: ["financial_agent"]
      }),
      scenario({
        id: "normal_financial_caveat",
        category: "workflow",
        expectedDecision: "delegate",
        requiredAgents: ["financial_agent"]
      })
    ];
    const partialRun = completedRun({
      decision: "delegate",
      steps: [{ id: "financial", adapter: "financial_agent" }],
      outputs: [completedOutput({ id: "financial", adapter: "financial_agent" })]
    });
    partialRun.final_answer = [
      "Base revenue is €160 million and downside revenue is €147.2 million.",
      "I could not complete financial analysis report, financial scenario from the validated information available in this run."
    ].join("\n\n");
    const caveatRun = completedRun({
      decision: "delegate",
      steps: [{ id: "financial", adapter: "financial_agent" }],
      outputs: [completedOutput({ id: "financial", adapter: "financial_agent" })]
    });
    caveatRun.final_answer = (
      "Base revenue is €160 million. Limitation: I could not independently validate "
      + "current market data, so this scenario uses only the supplied assumptions."
    );
    const result = (scenarioId, run) => ({
      scenario_id: scenarioId,
      run,
      ui: { assistant_visible: true, answer_matches_api: true },
      diagnostics: { console_errors: [], page_errors: [], failed_responses: [] }
    });

    const metrics = analyzePipelineResults({
      scenario_count: 2,
      results: [
        result("partial_financial_scenario", partialRun),
        result("normal_financial_caveat", caveatRun)
      ]
    }, { scenarios, dependencyMap: {}, junkAgentIds: [] });

    expect(metrics.answers).toMatchObject({
      observable_non_results: 0,
      observable_partial_non_results: 1,
      substantive_completed_answers: { successes: 1, total: 2, rate: 0.5 },
      substantive_delegate_answers: { successes: 1, total: 2, rate: 0.5 }
    });
    expect(metrics.scenarios[0]).toMatchObject({
      observable_non_result: false,
      observable_partial_non_result: true
    });
    expect(metrics.scenarios[0].problems).toContain("observable_partial_non_result");
    expect(metrics.scenarios[1]).toMatchObject({
      observable_non_result: false,
      observable_partial_non_result: false
    });
    expect(metrics.scenarios[1].problems).not.toContain("observable_partial_non_result");
    expect(renderPipelineReport(metrics)).toContain("Observable partial non-result answers | 1");
  });
});

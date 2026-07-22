import { describe, expect, it } from "vitest";

import { computeMetrics } from "../server/runtimeObservability.js";

function validStep(overrides = {}) {
  return {
    run_id: "run_partial",
    step_id: "step_valid",
    adapter: "valid_agent",
    status: "completed",
    execution_mode: "refreshed",
    elapsed_sec: 2,
    source_validation: { valid: true },
    consumption_validation: { valid: true },
    artifact_validation: { valid: true },
    outcome_validation: { valid: true },
    policy_violations: [],
    ...overrides
  };
}

function plan(decision, steps = []) {
  return {
    routing: { orchestrator: { decision } },
    steps: steps.map(([id, adapter]) => ({ id, adapter }))
  };
}

describe("computeMetrics", () => {
  it("separates durable run statuses and fresh invocation outcomes from reuse", () => {
    const data = {
      sessions: [{ session_id: "chat_one" }],
      agents: [],
      runs: [
        {
          run_id: "run_partial",
          status: "completed",
          plan: plan("delegate", [
            ["step_valid", "valid_agent"],
            ["step_reused", "reused_agent"],
            ["step_failed", "failed_agent"]
          ]),
          events: [
            { type: "route.completed", step_id: "step_valid", adapter: "valid_agent" },
            { type: "route.reused", step_id: "step_reused", adapter: "reused_agent" },
            {
              type: "route.failed",
              step_id: "step_failed",
              adapter: "failed_agent",
              status: "failed",
              failure_class: "model_output_limit"
            }
          ]
        },
        {
          run_id: "run_all_failed",
          status: "completed",
          plan: plan("delegate", [["step_blocked", "blocked_agent"]]),
          events: [{
            type: "route.failed",
            step_id: "step_blocked",
            adapter: "blocked_agent",
            status: "blocked",
            failure_class: "required_tool_or_live_evidence"
          }]
        },
        { run_id: "run_direct", status: "completed", plan: plan("direct"), events: [] },
        {
          run_id: "run_crashed",
          status: "failed",
          plan: plan("delegate", [["step_crashed", "crashed_agent"]]),
          events: [{ type: "route.started", step_id: "step_crashed", adapter: "crashed_agent" }]
        },
        { run_id: "run_queued", status: "queued", plan: { steps: [] }, events: [] }
      ],
      runSteps: [
        validStep(),
        validStep({
          step_id: "step_reused",
          adapter: "reused_agent",
          execution_mode: "reused",
          elapsed_sec: 0
        }),
        validStep({
          step_id: "step_failed",
          adapter: "failed_agent",
          status: "failed",
          failure_class: "model_output_limit",
          failure_observability_admin_only: {
            failure_reason_codes: [
              "model_output_truncated",
              "required_tool_not_executed:private-tool-name",
              "private-metrics-secret"
            ],
            repair_attempted: true,
            repair_valid: false,
            unsupported_claim_count: 3
          },
          source_validation: { valid: false },
          elapsed_sec: 1
        }),
        validStep({
          run_id: "run_all_failed",
          step_id: "step_blocked",
          adapter: "blocked_agent",
          status: "blocked",
          failure_class: "required_tool_or_live_evidence",
          failure_observability_admin_only: {
            failure_reason_codes: ["required_live_tool_not_executed:private-connector-name"],
            repair_attempted: true,
            repair_valid: true,
            unsupported_claim_count: 2
          },
          source_validation: { valid: false },
          elapsed_sec: 0.5
        })
      ]
    };

    const metrics = computeMetrics(data);

    expect(metrics.total_chats).toBe(1);
    expect(metrics.total_runs).toBe(3);
    expect(metrics.total_run_records).toBe(5);
    expect(metrics.run_status_counts).toMatchObject({ completed: 3, failed: 1, queued: 1 });
    expect(metrics.active_runs).toBe(1);
    expect(metrics.routing_decision_mix).toEqual({ direct: 1, clarify: 0, delegate: 3, unknown: 1 });
    expect(metrics.routing_decision_sample_count).toBe(4);

    expect(metrics).toMatchObject({
      selected_route_count: 5,
      attempted_route_count: 4,
      validated_route_count: 1,
      failed_route_count: 3,
      blocked_route_count: 1,
      reused_route_count: 1,
      successful_route_count: 2,
      unattempted_route_count: 0,
      invocation_success_rate: 0.25,
      invocation_success_percent: 25,
      runs_with_route_failures: 3,
      partial_route_failure_runs: 1,
      all_route_failure_runs: 2,
      completed_partial_route_failure_runs: 1,
      completed_all_route_failure_runs: 1,
      route_failure_status_counts: { failed: 1, blocked: 1, incomplete: 1 },
      route_failure_reason_counts: {
        model_output_truncated: 1,
        required_live_tool_not_executed: 1,
        required_tool_not_executed: 1
      },
      route_repair_attempted_count: 2,
      route_repair_valid_count: 1,
      unsupported_claim_count: 5
    });
    expect(JSON.stringify(metrics)).not.toContain("private-metrics-secret");
    expect(metrics.most_used_agents).toEqual([{ agent_id: "valid_agent", count: 1 }]);
    expect(metrics.most_attempted_agents).toEqual([
      { agent_id: "blocked_agent", count: 1 },
      { agent_id: "crashed_agent", count: 1 },
      { agent_id: "failed_agent", count: 1 },
      { agent_id: "valid_agent", count: 1 }
    ]);
    expect(metrics.failed_agents).toEqual([
      {
        agent_id: "blocked_agent",
        count: 1,
        attempts: 1,
        failure_rate: 1,
        failure_classes: { required_tool_or_live_evidence: 1 }
      },
      {
        agent_id: "crashed_agent",
        count: 1,
        attempts: 1,
        failure_rate: 1,
        failure_classes: { missing_terminal_route: 1 }
      },
      {
        agent_id: "failed_agent",
        count: 1,
        attempts: 1,
        failure_rate: 1,
        failure_classes: { model_output_limit: 1 }
      }
    ]);
    expect(metrics.agent_invocation_metrics.find((row) => row.agent_id === "reused_agent")).toEqual({
      agent_id: "reused_agent",
      selected: 1,
      attempted: 0,
      validated: 0,
      failed: 0,
      reused: 1,
      success_rate: null
    });
  });

  it("derives queue, planner, route, synthesis, execution, and total latency from evidence", () => {
    const metrics = computeMetrics({
      sessions: [],
      agents: [],
      runs: [{
        run_id: "run_latency",
        status: "completed",
        created_at: "2026-01-01T00:00:00.000Z",
        started_at: "2026-01-01T00:00:02.000Z",
        completed_at: "2026-01-01T00:00:10.000Z",
        elapsed_sec: 8,
        plan: plan("delegate", [["step_latency", "latency_agent"]]),
        parallel: { batches: [{ width: 3 }] },
        events: [
          { type: "run.started", at: "2026-01-01T00:00:02.000Z" },
          { type: "planner.started", at: "2026-01-01T00:00:02.000Z" },
          { type: "planner.completed", at: "2026-01-01T00:00:03.500Z" },
          { type: "route.started", step_id: "step_latency", adapter: "latency_agent", at: "2026-01-01T00:00:04.000Z" },
          {
            type: "route.completed",
            step_id: "step_latency",
            adapter: "latency_agent",
            elapsed_sec: 2.25,
            at: "2026-01-01T00:00:07.000Z"
          },
          { type: "synthesis.started", at: "2026-01-01T00:00:08.000Z" },
          { type: "final.completed", at: "2026-01-01T00:00:10.000Z" }
        ]
      }],
      runSteps: []
    });

    expect(metrics).toMatchObject({
      average_queue_latency: 2,
      average_planner_latency: 1.5,
      average_route_latency: 2.25,
      average_route_phase_latency: 4.5,
      average_synthesis_latency: 2,
      average_execution_latency: 8,
      average_end_to_end_latency: 10,
      average_total_latency: 10,
      p50_end_to_end_latency: 10,
      p95_end_to_end_latency: 10,
      p99_end_to_end_latency: 10,
      average_parallel_batch_width: 3,
      latency_sample_counts: {
        queue: 1,
        planner: 1,
        route: 1,
        route_phase: 1,
        synthesis: 1,
        execution: 1,
        total: 1
      }
    });
  });

  it("counts retrieval misses from declared document work instead of agent-name heuristics", () => {
    const metrics = computeMetrics({
      sessions: [],
      agents: [
        { id: "policy_manual", tools: ["document_search"], consumes: ["document_context"] },
        { id: "evidence_reader", retrieval: { type: "document_markdown" } }
      ],
      runs: [{
        run_id: "run_docs",
        status: "completed",
        plan: plan("delegate", [["missing", "policy_manual"], ["found", "evidence_reader"]]),
        events: [
          { type: "route.completed", step_id: "missing", adapter: "policy_manual" },
          { type: "route.completed", step_id: "found", adapter: "evidence_reader" }
        ]
      }],
      runSteps: [
        validStep({ run_id: "run_docs", step_id: "missing", adapter: "policy_manual" }),
        validStep({
          run_id: "run_docs",
          step_id: "found",
          adapter: "evidence_reader",
          citations: [{ chunk_id: "chunk_1" }],
          retrieved_context: "Verified policy excerpt."
        })
      ]
    });

    expect(metrics.retrieval_miss_count).toBe(1);
  });

  it("returns explicit zero-sample telemetry for an empty store", () => {
    expect(computeMetrics({})).toMatchObject({
      total_runs: 0,
      total_run_records: 0,
      invocation_success_rate: null,
      failed_agents: [],
      route_failure_reason_counts: {},
      route_repair_attempted_count: 0,
      route_repair_valid_count: 0,
      unsupported_claim_count: 0,
      p95_end_to_end_latency: 0,
      latency_sample_counts: { total: 0, route: 0 }
    });
  });
});

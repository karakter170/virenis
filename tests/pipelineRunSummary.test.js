import { describe, expect, it } from "vitest";

import { pipelineRunSummary } from "../e2e/pipelineRunSummary.js";

describe("pipeline runner summary", () => {
  it("fails when a worker error leaves a requested scenario unrecorded", () => {
    expect(pipelineRunSummary({
      scenario_count: 2,
      results: [{ run: { status: "completed" } }],
      worker_errors: [{ unit: ["missing_case"], error: { message: "timeout" } }]
    })).toEqual({
      ok: false,
      results: 1,
      completed: 1,
      failed: 0,
      harnessErrors: 1,
      workerErrors: 1,
      missingScenarios: 1
    });
  });

  it("passes only a complete error-free record", () => {
    expect(pipelineRunSummary({
      scenario_count: 1,
      results: [{ run: { status: "completed" } }],
      worker_errors: []
    })).toMatchObject({ ok: true, harnessErrors: 0, missingScenarios: 0 });
  });
});

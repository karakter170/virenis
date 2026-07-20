import { describe, expect, it } from "vitest";

import { parsePipelineRunnerArgs, PIPELINE_RUNNER_USAGE } from "../e2e/pipelineRunnerCli.js";

describe("pipeline runner CLI", () => {
  it("turns help flags into a side-effect-free help mode", () => {
    expect(parsePipelineRunnerArgs(["--help"])).toEqual({ help: true });
    expect(parsePipelineRunnerArgs(["-h"])).toEqual({ help: true });
    expect(PIPELINE_RUNNER_USAGE).toMatch(/PIPELINE_OUTPUT/u);
  });

  it("accepts the environment-only invocation and rejects accidental arguments", () => {
    expect(parsePipelineRunnerArgs([])).toEqual({ help: false });
    expect(() => parsePipelineRunnerArgs(["--resume"])).toThrow(/Unsupported pipeline runner arguments/u);
  });
});

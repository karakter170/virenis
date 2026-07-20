import path from "node:path";
import { describe, expect, it } from "vitest";
import { artifactDirectoryForOutput } from "../e2e/pipelineArtifactPaths.js";

describe("pipeline artifact paths", () => {
  it("namespaces screenshots by result file", () => {
    const baseline = artifactDirectoryForOutput("/tmp/pipeline/raw_results.json");
    const smoke = artifactDirectoryForOutput("/tmp/pipeline/post_fix_smoke.json");

    expect(baseline).toBe(path.resolve("/tmp/pipeline/raw_results_artifacts"));
    expect(smoke).toBe(path.resolve("/tmp/pipeline/post_fix_smoke_artifacts"));
    expect(baseline).not.toBe(smoke);
  });
});

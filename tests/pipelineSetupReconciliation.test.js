import { describe, expect, it } from "vitest";

import { workspacePayloadDiffers } from "../e2e/pipelineSetupReconciliation.js";

describe("pipeline setup reconciliation", () => {
  const payload = {
    name: "E2E Strategy",
    description: "Isolated browser benchmark team: E2E Strategy.",
    agent_ids: ["advocate", "skeptic", "synthesis"]
  };

  it("skips an identical benchmark workspace", () => {
    expect(workspacePayloadDiffers({
      agent_workspace_id: "aw_existing",
      ...payload,
      agent_count: 3,
      updated_at: "2026-07-20T00:00:00.000Z"
    }, payload)).toBe(false);
  });

  it("detects every mutable workspace field", () => {
    expect(workspacePayloadDiffers(null, payload)).toBe(true);
    expect(workspacePayloadDiffers({ ...payload, name: "Other" }, payload)).toBe(true);
    expect(workspacePayloadDiffers({ ...payload, description: "Old" }, payload)).toBe(true);
    expect(workspacePayloadDiffers({
      ...payload,
      agent_ids: ["advocate", "synthesis"]
    }, payload)).toBe(true);
    expect(workspacePayloadDiffers({
      ...payload,
      agent_ids: [...payload.agent_ids].reverse()
    }, payload)).toBe(true);
  });
});

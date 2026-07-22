import { describe, expect, it } from "vitest";
import {
  defaultModelOutputSettings,
  modelOutputSettingsForWorkspace,
  updateModelOutputSettings
} from "../server/modelSettings.js";

describe("workspace model output settings", () => {
  it("uses substantially larger safe defaults and publishes the administrator bounds", () => {
    const env = {};
    expect(defaultModelOutputSettings(env)).toEqual({
      agent_output_tokens: 4096,
      final_output_tokens: 8192
    });
    expect(modelOutputSettingsForWorkspace({}, "workspace_a", env)).toMatchObject({
      workspace_id: "workspace_a",
      agent_output_tokens: 4096,
      final_output_tokens: 8192,
      bounds: {
        agent_output_tokens: {
          min: 128,
          max: 8192,
          context_tokens: 32768,
          reserved_input_tokens: 8192,
          safety_margin_tokens: 128
        },
        final_output_tokens: {
          min: 256,
          max: 12288,
          context_tokens: 32768,
          reserved_input_tokens: 16384,
          safety_margin_tokens: 192
        }
      },
      revision: 0
    });
  });

  it("persists revisions independently for each workspace", () => {
    const data = { workspaceModelSettings: [] };
    const first = updateModelOutputSettings(data, {
      workspaceId: "workspace_a",
      actor: { user_id: "admin_a" },
      agentOutputTokens: 1536,
      finalOutputTokens: 3072,
      reason: "Allow more complete answers",
      now: "2026-07-15T10:00:00.000Z",
      env: {}
    });
    updateModelOutputSettings(data, {
      workspaceId: "workspace_b",
      actor: { user_id: "admin_b" },
      agentOutputTokens: 768,
      finalOutputTokens: 1536,
      reason: "Workspace-specific profile",
      env: {}
    });

    expect(first).toMatchObject({
      workspace_id: "workspace_a",
      agent_output_tokens: 1536,
      final_output_tokens: 3072,
      revision: 1,
      updated_by: "admin_a"
    });
    expect(modelOutputSettingsForWorkspace(data, "workspace_a", {})).toMatchObject({
      agent_output_tokens: 1536,
      final_output_tokens: 3072,
      revision: 1
    });
    expect(modelOutputSettingsForWorkspace(data, "workspace_b", {})).toMatchObject({
      agent_output_tokens: 768,
      final_output_tokens: 1536,
      revision: 1
    });
  });

  it("rejects fractional, out-of-range, and unaudited changes", () => {
    const base = {
      workspaceId: "workspace_a",
      actor: { user_id: "admin_a" },
      agentOutputTokens: 1024,
      finalOutputTokens: 2048,
      reason: "Valid reason",
      env: {}
    };
    expect(() => updateModelOutputSettings({ workspaceModelSettings: [] }, {
      ...base,
      agentOutputTokens: 1024.5
    })).toThrow("agent_output_tokens must be a whole number");
    expect(() => updateModelOutputSettings({ workspaceModelSettings: [] }, {
      ...base,
      finalOutputTokens: 13000
    })).toThrow("final_output_tokens must be between 256 and 12288");
    expect(() => updateModelOutputSettings({ workspaceModelSettings: [] }, {
      ...base,
      reason: ""
    })).toThrow("change reason");
  });

  it("derives safe output ceilings from execution and orchestration context windows", () => {
    expect(modelOutputSettingsForWorkspace({}, "workspace_a", {
      AGENT_RUNTIME_MODEL_CONTEXT_TOKENS: "16384",
      AGENT_RUNTIME_ORCHESTRATION_MODEL_CONTEXT_TOKENS: "32768",
      AGENT_RUNTIME_CLIENT_MAX_TOKENS: "16384",
      AGENT_RUNTIME_CLIENT_MAX_REFINER_TOKENS: "32768"
    }).bounds).toMatchObject({
      agent_output_tokens: { max: 7936, context_tokens: 16384 },
      final_output_tokens: { max: 16128, context_tokens: 32768 }
    });
  });
});

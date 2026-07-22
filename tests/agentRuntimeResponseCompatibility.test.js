import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  agentRuntimeOutputModelId,
  legacyAgentRuntimeResponseAliases,
  normalizeAgentRuntimeExecutionResult,
  normalizePersistedAgentRuntimeOptions,
  resetAgentRuntimeResponseAliasWarningsForTests
} from "../server/agentRuntimeResponseCompatibility.js";

describe("Agent Runtime response compatibility", () => {
  beforeEach(() => {
    resetAgentRuntimeResponseAliasWarningsForTests();
    vi.restoreAllMocks();
  });

  it("prefers neutral fields and removes redundant legacy names without warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = normalizeAgentRuntimeExecutionResult({
      mode: "agent_dag_model_execute",
      modelProviderBaseUrl: "https://canonical-model-provider.internal/v1",
      vllmBaseUrl: "https://legacy-model-provider.internal/v1",
      baseModel: "base-model",
      baseModelContentDigest: `sha256:${"a".repeat(64)}`,
      agentModelMap: { writer: "writer-model" },
      adapterMap: { writer: "legacy-writer-model" },
      expertOutputs: [{
        adapter: "writer",
        modelId: "writer-model",
        vllmModel: "legacy-writer-model"
      }]
    });

    expect(result).toMatchObject({
      mode: "agent_dag_model_execute",
      modelProviderBaseUrl: "https://canonical-model-provider.internal/v1",
      baseModel: "base-model",
      baseModelContentDigest: `sha256:${"a".repeat(64)}`,
      agentModelMap: { writer: "writer-model" },
      expertOutputs: [{ adapter: "writer", modelId: "writer-model" }]
    });
    expect(result).not.toHaveProperty("vllmBaseUrl");
    expect(result).not.toHaveProperty("adapterMap");
    expect(result.expertOutputs[0]).not.toHaveProperty("vllmModel");
    expect(warn).not.toHaveBeenCalled();
  });

  it("canonicalizes one legacy response at ingress with value-free diagnostics", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const privateEndpoint = "https://private-provider.example.invalid/secret-path";
    const result = normalizeAgentRuntimeExecutionResult({
      mode: "session_delegated_vllm_execute",
      plannerMode: "cue",
      vllmBaseUrl: privateEndpoint,
      baseModel: "base-model",
      adapterMap: { writer: "writer-model" },
      expertOutputs: [{ adapter: "writer", vllmModel: "writer-model" }],
      refinerOutput: { vllmModel: "base-model" }
    });

    expect(result).toMatchObject({
      mode: "session_delegated_model_execute",
      modelProviderBaseUrl: privateEndpoint,
      baseModel: "base-model",
      agentModelMap: { writer: "writer-model" },
      expertOutputs: [{ adapter: "writer", modelId: "writer-model" }],
      refinerOutput: { modelId: "base-model" }
    });
    expect(result).not.toHaveProperty("plannerMode");
    expect(warn.mock.calls.map((call) => call[1])).toEqual(expect.arrayContaining([
      { legacy_name: "vllmBaseUrl", canonical_name: "modelProviderBaseUrl" },
      { legacy_name: "adapterMap", canonical_name: "agentModelMap" },
      { legacy_name: "vllmModel", canonical_name: "modelId" },
      { legacy_name: "plannerMode", canonical_name: "fixed-semantic-session" },
      {
        legacy_name: "mode:session_delegated_vllm_execute",
        canonical_name: "mode:session_delegated_model_execute"
      }
    ]));
    expect(JSON.stringify(warn.mock.calls)).not.toContain(privateEndpoint);
  });

  it("keeps stable persisted model_id readable while exposing only neutral aliases", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const aliases = legacyAgentRuntimeResponseAliases();

    expect(agentRuntimeOutputModelId({ model_id: "persisted-model" })).toBe("persisted-model");
    expect(warn).not.toHaveBeenCalled();
    expect(aliases.fields).toEqual({
      vllmBaseUrl: "modelProviderBaseUrl",
      adapterMap: "agentModelMap",
      vllmModel: "modelId"
    });
    expect(aliases.retiredFields).toEqual({
      plannerMode: "fixed-semantic-session",
      planner_mode: "fixed-semantic-session"
    });
    expect(aliases.modes).toEqual({
      session_delegated_vllm_execute: "session_delegated_model_execute",
      session_direct_vllm_execute: "session_direct_model_execute",
      base_fallback_vllm_execute: "base_fallback_model_execute",
      tcar_dag_vllm_execute: "agent_dag_model_execute"
    });
  });

  it("removes planner mode from options recovered from an older store", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const options = normalizePersistedAgentRuntimeOptions({
      planner_mode: "cue",
      parallel_workers: 3
    });

    expect(options).toEqual({ parallel_workers: 3 });
    expect(warn).toHaveBeenCalledWith("agent_runtime.response_alias_deprecated", {
      legacy_name: "planner_mode",
      canonical_name: "fixed-semantic-session"
    });
  });
});

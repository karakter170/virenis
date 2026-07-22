import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  legacyAgentRuntimeEnvAliases,
  readAgentRuntimeEnv,
  resetAgentRuntimeEnvAliasWarningsForTests
} from "../server/agentRuntimeConfig.js";

describe("Agent Runtime environment compatibility", () => {
  beforeEach(() => {
    resetAgentRuntimeEnvAliasWarningsForTests();
    vi.restoreAllMocks();
  });

  it("prefers the canonical setting without emitting a deprecation diagnostic", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const value = readAgentRuntimeEnv({
      AGENT_RUNTIME_API_KEY: "canonical-secret",
      TCAR_RUNTIME_API_KEY: "legacy-secret"
    }, "AGENT_RUNTIME_API_KEY");

    expect(value).toBe("canonical-secret");
    expect(warn).not.toHaveBeenCalled();
  });

  it("accepts a legacy ingress alias once and never logs its value", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const secret = "legacy-secret-must-not-appear";
    const env = { TCAR_RUNTIME_API_KEY: secret };

    expect(readAgentRuntimeEnv(env, "AGENT_RUNTIME_API_KEY")).toBe(secret);
    expect(readAgentRuntimeEnv(env, "AGENT_RUNTIME_API_KEY")).toBe(secret);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("agent_runtime.env_alias_deprecated", {
      legacy_name: "TCAR_RUNTIME_API_KEY",
      canonical_name: "AGENT_RUNTIME_API_KEY"
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain(secret);
  });

  it("keeps adapter terminology only on the legacy side of agent limits", () => {
    const aliases = legacyAgentRuntimeEnvAliases();

    expect(aliases.AGENT_MANIFEST_PATH).toBe("PHASE222_ADAPTER_MANIFEST");
    expect(aliases.AGENT_RUNTIME_MAX_ROUTING_AGENTS).toBe("TCAR_MAX_ROUTING_ADAPTERS");
    expect(aliases.AGENT_RUNTIME_MAX_RESOURCE_SUPPORT_AGENTS).toBe("TCAR_MAX_RESOURCE_SUPPORT_ADAPTERS");
    expect(aliases.AGENT_RUNTIME_CLIENT_MAX_ROUTING_AGENTS).toBe("TCAR_CLIENT_MAX_ROUTING_ADAPTERS");
    expect(aliases.AGENT_RUNTIME_ORCHESTRATION_MODEL_CONTEXT_TOKENS).toBe("ROUTER_SESSION_CONTEXT_TOKENS");
    expect(aliases.AGENT_RUNTIME_SSH_HOST).toBe("GPU_SSH_HOST");
    expect(Object.keys(aliases).some((name) => name.endsWith("_ADAPTERS"))).toBe(false);
    expect(aliases).not.toHaveProperty("AGENT_RUNTIME_PLANNER_MODE");
    expect(Object.values(aliases)).not.toContain("TCAR_PLANNER_MODE");
  });
});

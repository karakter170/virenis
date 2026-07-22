const LEGACY_EXECUTION_MODE_ALIASES = Object.freeze({
  session_delegated_vllm_execute: "session_delegated_model_execute",
  session_direct_vllm_execute: "session_direct_model_execute",
  base_fallback_vllm_execute: "base_fallback_model_execute",
  tcar_dag_vllm_execute: "agent_dag_model_execute"
});

const warnedAliases = new Set();

// Versioned stores and ledger schemas still require this historical column.
// It is persistence metadata only; semantic session routing is not configurable.
export const LEGACY_PERSISTED_PLANNER_MODE_V1 = "session";

/**
 * Canonicalize the bounded set of response names used by older GPU executor
 * deployments. Production consumers must read only the neutral projection
 * returned here; legacy provider terminology must not spread past this seam.
 */
export function normalizeAgentRuntimeExecutionResult(value) {
  if (!isRecord(value)) return value;

  const result = { ...value };
  migrateField(result, "modelProviderBaseUrl", "vllmBaseUrl");
  migrateField(result, "agentModelMap", "adapterMap");
  retireField(result, "plannerMode", "fixed-semantic-session");
  if (hasOwn(result, "mode")) {
    result.mode = canonicalAgentRuntimeExecutionMode(result.mode);
  }

  if (Array.isArray(result.expertOutputs)) {
    result.expertOutputs = result.expertOutputs.map(normalizeAgentRuntimeOutput);
  }
  if (isRecord(result.refinerOutput)) {
    result.refinerOutput = normalizeAgentRuntimeOutput(result.refinerOutput);
  }
  return result;
}

/**
 * Strip retired routing inputs when recovering execution options written by an
 * older web release. Callers receive only options supported by the fixed
 * semantic-session runtime contract.
 */
export function normalizePersistedAgentRuntimeOptions(value) {
  if (!isRecord(value)) return {};
  const options = { ...value };
  retireField(options, "planner_mode", "fixed-semantic-session");
  return options;
}

export function normalizeAgentRuntimeOutput(value) {
  if (!isRecord(value)) return value;
  const output = { ...value };
  const usedLegacyProviderModel = !hasOwn(output, "modelId") && hasOwn(output, "vllmModel");
  const hasModelIdentity = hasOwn(output, "modelId")
    || hasOwn(output, "vllmModel")
    || hasOwn(output, "model_id");
  if (hasModelIdentity) {
    output.modelId = agentRuntimeOutputModelId(output);
  }
  if (usedLegacyProviderModel) {
    warnAlias("vllmModel", "modelId");
  }
  if (hasOwn(output, "vllmModel")) {
    delete output.vllmModel;
  }
  // model_id is the stable web persistence spelling, but the runtime response
  // contract is camelCase. Remove it only from the normalized ingress object.
  delete output.model_id;
  return output;
}

export function agentRuntimeOutputModelId(value) {
  if (!isRecord(value)) return null;
  if (hasOwn(value, "modelId")) return value.modelId;
  if (hasOwn(value, "vllmModel")) {
    warnAlias("vllmModel", "modelId");
    return value.vllmModel;
  }
  return value.model_id ?? null;
}

export function canonicalAgentRuntimeExecutionMode(value) {
  const mode = String(value || "");
  const canonical = LEGACY_EXECUTION_MODE_ALIASES[mode];
  if (!canonical) return value;
  warnAlias(`mode:${mode}`, `mode:${canonical}`);
  return canonical;
}

export function legacyAgentRuntimeResponseAliases() {
  return {
    fields: {
      vllmBaseUrl: "modelProviderBaseUrl",
      adapterMap: "agentModelMap",
      vllmModel: "modelId"
    },
    retiredFields: {
      plannerMode: "fixed-semantic-session",
      planner_mode: "fixed-semantic-session"
    },
    modes: { ...LEGACY_EXECUTION_MODE_ALIASES }
  };
}

export function resetAgentRuntimeResponseAliasWarningsForTests() {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Agent Runtime response warning reset is available only in tests.");
  }
  warnedAliases.clear();
}

function migrateField(target, canonicalName, legacyName) {
  if (hasOwn(target, canonicalName)) {
    delete target[legacyName];
    return;
  }
  if (!hasOwn(target, legacyName)) return;
  target[canonicalName] = target[legacyName];
  delete target[legacyName];
  warnAlias(legacyName, canonicalName);
}

function retireField(target, legacyName, replacement) {
  if (!hasOwn(target, legacyName)) return;
  delete target[legacyName];
  warnAlias(legacyName, replacement);
}

function warnAlias(legacyName, canonicalName) {
  if (warnedAliases.has(legacyName)) return;
  warnedAliases.add(legacyName);
  // Field names and fixed mode identifiers are safe configuration metadata.
  // Never include response values because they may contain private endpoints.
  console.warn("agent_runtime.response_alias_deprecated", {
    legacy_name: legacyName,
    canonical_name: canonicalName
  });
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

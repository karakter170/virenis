const DEFAULT_AGENT_OUTPUT_TOKENS = 1024;
const DEFAULT_FINAL_OUTPUT_TOKENS = 2048;
const MIN_AGENT_OUTPUT_TOKENS = 128;
const MIN_FINAL_OUTPUT_TOKENS = 256;
const DEFAULT_MAX_AGENT_OUTPUT_TOKENS = 4096;
const DEFAULT_MAX_FINAL_OUTPUT_TOKENS = 8192;
const DEFAULT_MODEL_CONTEXT_TOKENS = 4096;
const DEFAULT_ROUTE_INPUT_RESERVE_TOKENS = 1500;
const DEFAULT_REFINER_INPUT_RESERVE_TOKENS = 768;
const DEFAULT_ROUTE_SAFETY_MARGIN_TOKENS = 128;
const DEFAULT_COMPLETION_SAFETY_MARGIN_TOKENS = 192;
const OUTPUT_TOKEN_STEP = 256;

export function modelOutputBounds(env = process.env) {
  const configuredMaxAgent = boundedEnvironmentInteger(
    env.TCAR_CLIENT_MAX_TOKENS,
    DEFAULT_MAX_AGENT_OUTPUT_TOKENS,
    MIN_AGENT_OUTPUT_TOKENS,
    32768
  );
  const configuredMaxFinal = boundedEnvironmentInteger(
    env.TCAR_CLIENT_MAX_REFINER_TOKENS,
    DEFAULT_MAX_FINAL_OUTPUT_TOKENS,
    MIN_FINAL_OUTPUT_TOKENS,
    32768
  );
  const workerContext = boundedEnvironmentInteger(
    env.TCAR_MODEL_CONTEXT_TOKENS,
    DEFAULT_MODEL_CONTEXT_TOKENS,
    2048,
    2_000_000
  );
  const plannerMode = String(env.TCAR_PLANNER_MODE || "session").trim().toLowerCase();
  const finalContext = plannerMode === "session"
    ? boundedEnvironmentInteger(env.ROUTER_SESSION_CONTEXT_TOKENS, workerContext, 2048, 2_000_000)
    : workerContext;
  const routeInputReserve = boundedEnvironmentInteger(
    env.TCAR_ROUTE_MIN_INPUT_TOKENS,
    DEFAULT_ROUTE_INPUT_RESERVE_TOKENS,
    768,
    65_536
  );
  const refinerInputReserve = boundedEnvironmentInteger(
    env.TCAR_REFINER_MIN_INPUT_TOKENS,
    DEFAULT_REFINER_INPUT_RESERVE_TOKENS,
    640,
    65_536
  );
  const routeSafetyMargin = boundedEnvironmentInteger(
    env.TCAR_ROUTE_TOKEN_SAFETY_MARGIN,
    DEFAULT_ROUTE_SAFETY_MARGIN_TOKENS,
    64,
    16_384
  );
  const completionSafetyMargin = boundedEnvironmentInteger(
    env.TCAR_COMPLETION_TOKEN_SAFETY_MARGIN,
    DEFAULT_COMPLETION_SAFETY_MARGIN_TOKENS,
    64,
    16_384
  );
  const maxAgent = Math.min(
    configuredMaxAgent,
    steppedContextMaximum(workerContext - routeInputReserve - routeSafetyMargin, MIN_AGENT_OUTPUT_TOKENS)
  );
  const maxFinal = Math.min(
    configuredMaxFinal,
    steppedContextMaximum(finalContext - refinerInputReserve - completionSafetyMargin, MIN_FINAL_OUTPUT_TOKENS)
  );
  return {
    agent: {
      min: MIN_AGENT_OUTPUT_TOKENS,
      max: maxAgent,
      context_tokens: workerContext,
      reserved_input_tokens: routeInputReserve,
      safety_margin_tokens: routeSafetyMargin
    },
    final: {
      min: MIN_FINAL_OUTPUT_TOKENS,
      max: maxFinal,
      context_tokens: finalContext,
      reserved_input_tokens: refinerInputReserve,
      safety_margin_tokens: completionSafetyMargin
    }
  };
}

export function defaultModelOutputSettings(env = process.env) {
  const bounds = modelOutputBounds(env);
  return {
    agent_output_tokens: boundedEnvironmentInteger(
      env.TCAR_MAX_TOKENS,
      DEFAULT_AGENT_OUTPUT_TOKENS,
      bounds.agent.min,
      bounds.agent.max
    ),
    final_output_tokens: boundedEnvironmentInteger(
      env.TCAR_REFINER_MAX_TOKENS,
      DEFAULT_FINAL_OUTPUT_TOKENS,
      bounds.final.min,
      bounds.final.max
    )
  };
}

export function modelOutputSettingsForWorkspace(data, workspaceId, env = process.env) {
  const defaults = defaultModelOutputSettings(env);
  const bounds = modelOutputBounds(env);
  const record = (Array.isArray(data?.workspaceModelSettings) ? data.workspaceModelSettings : [])
    .find((item) => String(item?.workspace_id || "") === String(workspaceId || "workspace_default"));
  return {
    workspace_id: String(workspaceId || "workspace_default"),
    agent_output_tokens: boundedStoredInteger(record?.agent_output_tokens, defaults.agent_output_tokens, bounds.agent),
    final_output_tokens: boundedStoredInteger(record?.final_output_tokens, defaults.final_output_tokens, bounds.final),
    bounds: {
      agent_output_tokens: bounds.agent,
      final_output_tokens: bounds.final
    },
    revision: Math.max(0, Number(record?.revision) || 0),
    updated_at: record?.updated_at || null,
    updated_by: record?.updated_by || null
  };
}

export function updateModelOutputSettings(data, {
  workspaceId,
  actor,
  agentOutputTokens,
  finalOutputTokens,
  reason,
  now = new Date().toISOString(),
  env = process.env
}) {
  const workspace = String(workspaceId || "workspace_default");
  const bounds = modelOutputBounds(env);
  const agentTokens = strictIntegerInRange(
    agentOutputTokens,
    "agent_output_tokens",
    bounds.agent
  );
  const finalTokens = strictIntegerInRange(
    finalOutputTokens,
    "final_output_tokens",
    bounds.final
  );
  const changeReason = String(reason || "").replaceAll("\0", "").trim();
  if (!changeReason || changeReason.length > 500) {
    throw modelSettingsError(400, "A change reason between 1 and 500 characters is required.");
  }
  data.workspaceModelSettings = Array.isArray(data.workspaceModelSettings) ? data.workspaceModelSettings : [];
  const index = data.workspaceModelSettings.findIndex((item) => String(item?.workspace_id || "") === workspace);
  const previous = index >= 0 ? data.workspaceModelSettings[index] : null;
  const record = {
    workspace_id: workspace,
    agent_output_tokens: agentTokens,
    final_output_tokens: finalTokens,
    revision: Math.max(0, Number(previous?.revision) || 0) + 1,
    updated_at: now,
    updated_by: String(actor?.user_id || "administrator"),
    reason: changeReason
  };
  if (index >= 0) data.workspaceModelSettings[index] = record;
  else data.workspaceModelSettings.push(record);
  return modelOutputSettingsForWorkspace(data, workspace, env);
}

function strictIntegerInRange(value, label, bounds) {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) {
    throw modelSettingsError(400, `${label} must be a whole number.`);
  }
  if (number < bounds.min || number > bounds.max) {
    throw modelSettingsError(400, `${label} must be between ${bounds.min} and ${bounds.max}.`);
  }
  return number;
}

function boundedStoredInteger(value, fallback, bounds) {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) return fallback;
  return Math.max(bounds.min, Math.min(bounds.max, number));
}

function boundedEnvironmentInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) return Math.max(minimum, Math.min(maximum, fallback));
  return Math.max(minimum, Math.min(maximum, number));
}

function steppedContextMaximum(value, minimum) {
  return Math.max(minimum, Math.floor(Math.max(0, value) / OUTPUT_TOKEN_STEP) * OUTPUT_TOKEN_STEP);
}

function modelSettingsError(status, message) {
  const error = new Error(message);
  error.status = status;
  error.code = "invalid_model_output_settings";
  return error;
}

/* global console, process */
import {
  fetchRuntimeHealth,
  requireRuntimeConfigured
} from "../server/runtimeClient.js";
import { modelOutputBounds } from "../server/modelSettings.js";

requireRuntimeConfigured();

const health = await fetchRuntimeHealth();
if (health?.ok !== true || health?.ready === false) {
  throw new Error("TCAR Runtime is reachable but not ready.");
}
const webOutputBounds = modelOutputBounds(process.env);
const runtimeOutputLimits = health?.output_limits;
if (!runtimeOutputLimits?.agent_output_tokens || !runtimeOutputLimits?.final_output_tokens) {
  throw new Error("TCAR Runtime does not publish context-safe output limits. Deploy the current Runtime before serving web traffic.");
}
for (const [webKey, runtimeKey] of [
  ["agent", "agent_output_tokens"],
  ["final", "final_output_tokens"]
]) {
  const webLimit = webOutputBounds[webKey];
  const runtimeLimit = runtimeOutputLimits[runtimeKey];
  if (
    Number(webLimit.max) !== Number(runtimeLimit.max)
    || Number(webLimit.context_tokens) !== Number(runtimeLimit.context_tokens)
  ) {
    throw new Error(
      `Web and Runtime ${runtimeKey} context limits differ. Align TCAR_MODEL_CONTEXT_TOKENS and ROUTER_SESSION_CONTEXT_TOKENS before deployment.`
    );
  }
}

console.log(JSON.stringify({
  ok: true,
  runtime: {
    service: health.service || "tcar-runtime",
    ready: health.ready ?? health.ok,
    manifest_valid: health.manifest?.valid ?? null,
    active_adapters: health.manifest?.active_adapters ?? null,
    vllm_ready: health.vllm?.models_endpoint_ok ?? health.vllm?.health?.ok ?? null,
    router_ready: health.router?.models_endpoint_ok ?? null
  },
  output_limits: runtimeOutputLimits
}, null, 2));

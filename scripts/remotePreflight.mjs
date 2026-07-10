/* global console */
import {
  fetchRuntimeHealth,
  requireRuntimeConfigured
} from "../server/runtimeClient.js";

requireRuntimeConfigured();

const health = await fetchRuntimeHealth();
if (health?.ok !== true || health?.ready === false) {
  throw new Error("TCAR Runtime is reachable but not ready.");
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
  }
}, null, 2));

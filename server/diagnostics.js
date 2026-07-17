import crypto from "node:crypto";

const DIAGNOSTIC_CODE_RE = /^[a-z][a-z0-9_.-]{0,119}$/;
const CORRELATION_ID_RE = /^[A-Za-z0-9_.:-]{1,240}$/;
const ERROR_TYPE_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,119}$/;
const MAX_SUMMARY_KEYS = 64;
const MAX_SUMMARY_DEPTH = 4;
const MAX_SUMMARY_ITEMS = 64;

/**
 * Project an arbitrary exception into content-free support metadata.
 *
 * Provider bodies, exception messages, stack text, prompts, credentials, and
 * user-controlled payloads are deliberately excluded. The fingerprint is
 * derived from structural fields and stack frames with the exception's first
 * (message-bearing) line removed.
 */
export function normalizeDiagnosticError(error, {
  fallbackCode = "internal_error",
  status = null
} = {}) {
  const code = diagnosticCode(error?.code, fallbackCode);
  const resolvedStatus = finiteStatus(error?.status ?? status);
  const providerStatus = finiteStatus(error?.providerStatus ?? error?.provider_status);
  const providerRequestId = correlationId(error?.requestId ?? error?.provider_request_id);
  const errorType = errorTypeName(error);
  const stackShape = stackFrames(error?.stack);
  const fingerprint = crypto.createHash("sha256")
    .update(JSON.stringify({
      code,
      status: resolvedStatus,
      provider_status: providerStatus,
      error_type: errorType,
      stack_frames: stackShape
    }), "utf8")
    .digest("hex");
  return removeNullFields({
    code,
    status: resolvedStatus,
    retryable: error?.retryable === true,
    provider_status: providerStatus,
    provider_request_id: providerRequestId,
    error_type: errorType,
    fingerprint: `sha256:${fingerprint}`
  });
}

/**
 * Emit one bounded structured diagnostic without raw exception content.
 */
export function safeDiagnosticLog(event, context = {}, error = null, logger = console.error) {
  const label = diagnosticEvent(event);
  const safeContext = diagnosticContext(context);
  const diagnostic = normalizeDiagnosticError(error, {
    fallbackCode: safeContext.code || `${label.replaceAll(".", "_")}_failed`,
    status: safeContext.status
  });
  logger(label, { ...safeContext, diagnostic });
  return diagnostic;
}

/**
 * Preserve only the runtime error fields that the web tier needs to classify,
 * retry, and correlate a failure. Never retain the provider response body.
 */
export function projectRuntimeFailure(payload, status) {
  const detail = payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload.detail ?? payload
    : null;
  const object = detail && typeof detail === "object" && !Array.isArray(detail) ? detail : {};
  const code = diagnosticCode(object.code ?? payload?.code, status >= 500 ? "runtime_service_error" : "runtime_request_rejected");
  return removeNullFields({
    code,
    status: finiteStatus(status),
    retryable: object.retryable === true,
    provider_status: finiteStatus(object.provider_status),
    provider_request_id: correlationId(object.request_id ?? object.provider_request_id)
  });
}

export function runtimeFailureMessage(projected = {}) {
  const known = {
    model_rate_limited: "The selected model is temporarily rate-limited.",
    model_timeout: "The selected model did not respond before the timeout.",
    model_configuration_error: "The selected model connection is not authorized.",
    model_request_rejected: "The selected model rejected the generated request.",
    model_service_unavailable: "The selected model service is temporarily unavailable."
  };
  return known[projected.code]
    || (Number(projected.status) >= 500
      ? "The Runtime could not complete the request."
      : "The Runtime rejected the request.");
}

/**
 * Validation subprocess output is diagnostic material, not product content.
 * Keep numeric/boolean structure for dashboards and replace strings with
 * content-free metadata so stdout, stderr, paths, and secrets cannot persist.
 */
export function projectValidationResult(result = {}) {
  const source = result && typeof result === "object" && !Array.isArray(result) ? result : {};
  return removeNullFields({
    ok: source.ok === true,
    suite: safeIdentifier(source.suite, 120),
    returncode: Number.isInteger(Number(source.returncode)) ? Number(source.returncode) : null,
    elapsed_sec: finiteNonNegative(source.elapsed_sec),
    summary: diagnosticSummary(source.summary),
    output_present: Boolean(String(source.stdout || "").length || String(source.stderr || "").length)
  });
}

export function diagnosticCode(value, fallback = "internal_error") {
  const candidate = String(value || "").trim().toLowerCase();
  if (DIAGNOSTIC_CODE_RE.test(candidate)) return candidate;
  const safeFallback = String(fallback || "internal_error").trim().toLowerCase();
  return DIAGNOSTIC_CODE_RE.test(safeFallback) ? safeFallback : "internal_error";
}

export function correlationId(value) {
  const candidate = String(value || "").trim();
  return CORRELATION_ID_RE.test(candidate) ? candidate : null;
}

function diagnosticEvent(value) {
  const candidate = String(value || "diagnostic.failure").trim().toLowerCase();
  return /^[a-z][a-z0-9_.-]{0,119}$/.test(candidate) ? candidate : "diagnostic.failure";
}

function diagnosticContext(value) {
  const context = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return removeNullFields({
    operation: safeIdentifier(context.operation, 120),
    request_id: correlationId(context.request_id),
    run_id: correlationId(context.run_id),
    validation_run_id: correlationId(context.validation_run_id),
    workflow_id: correlationId(context.workflow_id),
    status: finiteStatus(context.status),
    code: context.code ? diagnosticCode(context.code) : null
  });
}

function errorTypeName(error) {
  const value = String(error?.name || error?.constructor?.name || "Error").trim();
  return ERROR_TYPE_RE.test(value) ? value : "Error";
}

function stackFrames(value) {
  if (typeof value !== "string") return [];
  return value.split(/\r?\n/)
    .slice(1, 9)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      // Retain only a source-controlled frame/function label. Paths, arguments,
      // exception text, URLs, and other arbitrary stack material must not
      // influence a support-visible fingerprint.
      const match = line.match(/^at\s+([A-Za-z0-9_.<>-]{1,160})(?:\s|$)/);
      return match?.[1] || "anonymous";
    });
}

function diagnosticSummary(value, depth = 0) {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return { text_present: value.length > 0, length: value.length };
  if (depth >= MAX_SUMMARY_DEPTH) return { truncated: true };
  if (Array.isArray(value)) {
    return value.slice(0, MAX_SUMMARY_ITEMS).map((item) => diagnosticSummary(item, depth + 1));
  }
  if (typeof value !== "object") return null;
  return Object.fromEntries(Object.entries(value)
    .slice(0, MAX_SUMMARY_KEYS)
    .flatMap(([key, child]) => {
      const safeKey = safeIdentifier(key, 120);
      return safeKey ? [[safeKey, diagnosticSummary(child, depth + 1)]] : [];
    }));
}

function safeIdentifier(value, limit) {
  const text = String(value || "").trim();
  if (!text) return null;
  return text.replace(/[^A-Za-z0-9_.:-]+/g, "_").slice(0, limit) || null;
}

function finiteStatus(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 100 && number <= 599 ? number : null;
}

function finiteNonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function removeNullFields(value) {
  return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== null && child !== undefined));
}

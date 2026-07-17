import http from "node:http";
import https from "node:https";
import { appAuthConfigured, basicAuthConfigured, secretConfigured } from "./authConfig.js";
import { validateClerkEnvironment } from "./clerkIdentity.js";
import { validateProductionDatabaseTransport } from "./databaseTransport.js";
import { projectRuntimeFailure, runtimeFailureMessage } from "./diagnostics.js";
import { readConfiguredSecret } from "./secretConfig.js";

const DEFAULT_TIMEOUT_MS = 900000;
const DEFAULT_CONNECT_TIMEOUT_MS = 10000;
const DEFAULT_BODY_IDLE_TIMEOUT_MS = 60000;
const LEGACY_STREAM_BODY_IDLE_TIMEOUT_MS = 300000;
const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const RUNTIME_STREAM_CONTENT_TYPE = "application/x-ndjson";
const RUNTIME_STREAM_PROTOCOL = "heartbeat-v1";
// Runtime can heartbeat every five seconds for the full 30-minute hard request
// limit (360 records). Keep a finite margin for scheduling jitter/config
// changes while retaining a strict parser bound.
const MAX_RUNTIME_STREAM_HEARTBEATS = 512;
const MAX_RUNTIME_STREAM_EVENTS = MAX_RUNTIME_STREAM_HEARTBEATS + 2;
const MAX_RUNTIME_STREAM_PLAN_STEPS = 24;
const MAX_RUNTIME_STREAM_TASK_CHARS = 600;
const MAX_RUNTIME_STREAM_PLAN_EVENT_BYTES = 256 * 1024;
const MAX_RUNTIME_STREAM_HEARTBEAT_BYTES = 1024;
const MAX_REQUEST_TIMEOUT_MS = 1800000;
const MAX_CONNECT_TIMEOUT_MS = 120000;
const MAX_BODY_IDLE_TIMEOUT_MS = 300000;
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const MAX_AUDIT_RECEIPT_PAGE_SIZE = 1000;
// The web and GPU runtime normally live on different hosts. Reopening a TCP
// (and commonly TLS) connection for every health probe, lifecycle call, and
// chat adds a full network handshake to each request. Keep a small bounded
// pool per protocol; Node automatically discards sockets closed by the peer.
const HTTP_AGENT = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 1000,
  maxSockets: 64,
  maxFreeSockets: 16,
  scheduling: "lifo"
});
const HTTPS_AGENT = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 1000,
  maxSockets: 64,
  maxFreeSockets: 16,
  scheduling: "lifo"
});
let testFetchTransport = null;

export function setRuntimeFetchForTests(fetchImpl) {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Runtime fetch injection is available only when NODE_ENV=test.");
  }
  if (typeof fetchImpl !== "function") {
    throw new TypeError("Runtime test fetch transport must be a function.");
  }
  const previous = testFetchTransport;
  testFetchTransport = fetchImpl;
  return () => {
    if (testFetchTransport === fetchImpl) testFetchTransport = previous;
  };
}

export function runtimeMode() {
  return String(process.env.TCAR_ENGINE_MODE || "simulator").toLowerCase();
}

export function realRuntimeEnabled() {
  return runtimeMode() === "real";
}

export function requireRuntimeConfigured() {
  const isProduction = process.env.NODE_ENV === "production";
  validateClerkEnvironment(process.env);
  const configuredRuntimeApiKey = realRuntimeEnabled() ? runtimeApiKey() : "";
  if (realRuntimeEnabled() && !process.env.TCAR_RUNTIME_API_URL) {
    throw new Error("TCAR_ENGINE_MODE=real requires TCAR_RUNTIME_API_URL.");
  }
  if (realRuntimeEnabled() && isProduction && !secretConfigured(configuredRuntimeApiKey)) {
    throw new Error("Production real runtime requires TCAR_RUNTIME_API_KEY or TCAR_RUNTIME_API_KEY_FILE.");
  }
  if (realRuntimeEnabled()) validateRuntimeTransportConfiguration(process.env);
  if (isProduction && process.env.APP_ALLOW_UNAUTHENTICATED !== "1") {
    if ((process.env.APP_BASIC_AUTH_USER || process.env.APP_BASIC_AUTH_PASSWORD || process.env.APP_BASIC_AUTH_PASSWORD_FILE) && !basicAuthConfigured(process.env)) {
      throw new Error("Configured production Basic Auth credentials are weak, incomplete, or placeholders.");
    }
    if (!appAuthConfigured(process.env, { requireStrongSecrets: true })) {
      throw new Error("Production web server requires Clerk identity, strong Basic Auth credentials, or strong APP_API_TOKENS/APP_API_TOKENS_JSON; otherwise APP_ALLOW_UNAUTHENTICATED=1 must define an explicit unauthenticated identity.");
    }
  } else if (isProduction) {
    validateUnauthenticatedProductionIdentity(process.env);
  }
  if (isProduction && !process.env.DATABASE_URL && process.env.APP_ALLOW_JSON_STORE !== "1") {
    throw new Error("Production web server requires DATABASE_URL. Set APP_ALLOW_JSON_STORE=1 only for isolated private-beta deployments.");
  }
  if (isProduction && process.env.DATABASE_URL) {
    validateProductionDatabaseTransport(process.env);
  }
  if (isProduction && process.env.APP_ALLOW_MISSING_PUBLIC_ORIGIN !== "1") {
    validatePublicOrigin(process.env.APP_PUBLIC_ORIGIN);
  }
  if (realRuntimeEnabled() && isProduction) {
    validateProductionRuntimeApiUrl(process.env);
  }
  if (isProduction && isAllInterfaceHost(process.env.HOST) && process.env.APP_ALLOW_PUBLIC_BIND !== "1") {
    throw new Error("Production web server must bind to 127.0.0.1 or a protected private interface. Set APP_ALLOW_PUBLIC_BIND=1 only when firewall/proxy controls explicitly protect the Node process.");
  }
}

export function runtimeApiKey(env = process.env) {
  return readConfiguredSecret(
    env,
    "TCAR_RUNTIME_API_KEY",
    "TCAR_RUNTIME_API_KEY_FILE"
  );
}

function validateRuntimeTransportConfiguration(env) {
  for (const [name, maximum] of [
    ["TCAR_RUNTIME_CHAT_TIMEOUT_MS", MAX_REQUEST_TIMEOUT_MS],
    ["TCAR_RUNTIME_WORKFLOW_TIMEOUT_MS", MAX_REQUEST_TIMEOUT_MS],
    ["TCAR_RUNTIME_CONTINUATION_TIMEOUT_MS", MAX_REQUEST_TIMEOUT_MS],
    ["TCAR_RUNTIME_HEALTH_TIMEOUT_MS", MAX_REQUEST_TIMEOUT_MS],
    ["TCAR_RUNTIME_ADMIN_TIMEOUT_MS", MAX_REQUEST_TIMEOUT_MS],
    ["TCAR_RUNTIME_CONNECT_TIMEOUT_MS", MAX_CONNECT_TIMEOUT_MS],
    ["TCAR_RUNTIME_HEADER_TIMEOUT_MS", MAX_REQUEST_TIMEOUT_MS],
    ["TCAR_RUNTIME_BODY_IDLE_TIMEOUT_MS", MAX_BODY_IDLE_TIMEOUT_MS]
  ]) {
    const value = String(env[name] ?? "").trim();
    if (value) boundedInteger(value, name, 1, maximum);
  }
  const maxResponseBytes = String(env.TCAR_RUNTIME_MAX_RESPONSE_BYTES ?? "").trim();
  if (maxResponseBytes) boundedInteger(maxResponseBytes, "TCAR_RUNTIME_MAX_RESPONSE_BYTES", 1024, MAX_RESPONSE_BYTES);
  const validationSeconds = String(env.TCAR_RUNTIME_VALIDATION_TIMEOUT_SEC ?? "").trim();
  if (validationSeconds) boundedInteger(validationSeconds, "TCAR_RUNTIME_VALIDATION_TIMEOUT_SEC", 1, MAX_REQUEST_TIMEOUT_MS / 1000);
}

function validatePublicOrigin(value) {
  const origin = String(value || "").replace(/\/+$/, "");
  if (!origin) {
    throw new Error("Production web server requires APP_PUBLIC_ORIGIN for browser origin checks.");
  }
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    throw new Error("APP_PUBLIC_ORIGIN must be a valid absolute URL.");
  }
  if (parsed.origin !== origin || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("APP_PUBLIC_ORIGIN must contain only scheme, host, and optional port.");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("APP_PUBLIC_ORIGIN must use https in production.");
  }
  const hostname = parsed.hostname.toLowerCase();
  if (
    hostname === "localhost"
    || hostname === "localhost.localdomain"
    || hostname === "127.0.0.1"
    || hostname === "::1"
    || hostname === "[::1]"
    || hostname === "0.0.0.0"
    || hostname === "::"
    || hostname === "[::]"
    || hostname === "app.example.com"
    || hostname.endsWith(".example.com")
  ) {
    throw new Error("APP_PUBLIC_ORIGIN must be replaced with the real public web origin.");
  }
}

function isAllInterfaceHost(value) {
  const host = String(value || "127.0.0.1").trim().toLowerCase();
  return host === "0.0.0.0" || host === "::" || host === "[::]";
}

function validateUnauthenticatedProductionIdentity(env) {
  const userId = String(env.APP_UNAUTHENTICATED_USER_ID || "").trim();
  const workspaceId = String(env.APP_UNAUTHENTICATED_WORKSPACE_ID || "").trim();
  const role = String(env.APP_UNAUTHENTICATED_ROLE || "user").trim();
  if (!/^[a-zA-Z0-9_.:-]{3,80}$/.test(userId) || userId === "user_local") {
    throw new Error("APP_ALLOW_UNAUTHENTICATED=1 requires APP_UNAUTHENTICATED_USER_ID to be an explicit non-default identity.");
  }
  if (!/^[a-zA-Z0-9_.:-]{3,120}$/.test(workspaceId) || workspaceId === "workspace_default") {
    throw new Error("APP_ALLOW_UNAUTHENTICATED=1 requires APP_UNAUTHENTICATED_WORKSPACE_ID to be an explicit non-default workspace.");
  }
  if (!["user", "viewer"].includes(role)) {
    throw new Error("APP_UNAUTHENTICATED_ROLE must be user or viewer; unauthenticated admin access is not allowed.");
  }
}

export function validateProductionRuntimeApiUrl(env) {
  let runtimeUrl;
  try {
    runtimeUrl = new URL(String(env.TCAR_RUNTIME_API_URL || ""));
  } catch {
    throw new Error("TCAR_RUNTIME_API_URL must be a valid absolute URL.");
  }
  if (!["http:", "https:"].includes(runtimeUrl.protocol)) {
    throw new Error("TCAR_RUNTIME_API_URL must use http or https.");
  }
  const runtimeHost = runtimeUrl.hostname.toLowerCase();
  if (
    env.TCAR_ALLOW_LOOPBACK_RUNTIME_TUNNEL === "1"
    && !isLoopbackRuntimeHost(runtimeHost)
  ) {
    throw new Error("TCAR_ALLOW_LOOPBACK_RUNTIME_TUNNEL=1 requires TCAR_RUNTIME_API_URL to use a loopback hostname.");
  }
  if (
    isLocalRuntimeHost(runtimeHost)
    && env.TCAR_ALLOW_LOCAL_RUNTIME_URL !== "1"
    && env.TCAR_ALLOW_LOOPBACK_RUNTIME_TUNNEL !== "1"
  ) {
    throw new Error("Production split deployment requires TCAR_RUNTIME_API_URL to point to the private GPU runtime host, not localhost. Set TCAR_ALLOW_LOOPBACK_RUNTIME_TUNNEL=1 for a supervised SSH/VPN loopback tunnel, or TCAR_ALLOW_LOCAL_RUNTIME_URL=1 only for an explicit same-host private-beta deployment.");
  }
  if (
    runtimeUrl.protocol === "http:"
    && !isLoopbackRuntimeHost(runtimeHost)
    && env.TCAR_ALLOW_INSECURE_PRIVATE_RUNTIME_HTTP !== "1"
  ) {
    throw new Error(
      "Production remote TCAR_RUNTIME_API_URL must use HTTPS. Set "
      + "TCAR_ALLOW_INSECURE_PRIVATE_RUNTIME_HTTP=1 only when an authenticated, "
      + "protected private network provides equivalent transport isolation."
    );
  }
  if (env.APP_PUBLIC_ORIGIN && env.TCAR_ALLOW_SAME_ORIGIN_RUNTIME_URL !== "1") {
    try {
      const publicOrigin = new URL(String(env.APP_PUBLIC_ORIGIN).replace(/\/+$/, ""));
      if (publicOrigin.hostname.toLowerCase() === runtimeHost) {
        throw new Error("Production split deployment requires TCAR_RUNTIME_API_URL to use a different host from APP_PUBLIC_ORIGIN. Set TCAR_ALLOW_SAME_ORIGIN_RUNTIME_URL=1 only for an explicitly proxied private-beta topology.");
      }
    } catch (error) {
      if (error.message?.includes("Production split deployment")) {
        throw error;
      }
    }
  }
}

function isLocalRuntimeHost(hostname) {
  return hostname === "localhost" || hostname === "localhost.localdomain" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]" || hostname === "0.0.0.0";
}

function isLoopbackRuntimeHost(hostname) {
  return hostname === "localhost"
    || hostname === "localhost.localdomain"
    || hostname === "127.0.0.1"
    || hostname === "::1"
    || hostname === "[::1]";
}

function runtimeBaseUrl() {
  const value = process.env.TCAR_RUNTIME_API_URL;
  if (!value) {
    throw new Error("TCAR_RUNTIME_API_URL is not configured.");
  }
  return value.replace(/\/+$/, "");
}

export async function runtimeRequest(path, { method = "GET", body, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const requestTimeoutMs = boundedInteger(timeoutMs, "runtime request timeout", 1, MAX_REQUEST_TIMEOUT_MS);
  const connectTimeoutMs = Math.min(
    requestTimeoutMs,
    optionalBoundedEnvironmentInteger(
      "TCAR_RUNTIME_CONNECT_TIMEOUT_MS",
      DEFAULT_CONNECT_TIMEOUT_MS,
      1,
      MAX_CONNECT_TIMEOUT_MS
    )
  );
  const headerTimeoutMs = Math.min(
    requestTimeoutMs,
    optionalBoundedEnvironmentInteger(
      "TCAR_RUNTIME_HEADER_TIMEOUT_MS",
      requestTimeoutMs,
      1,
      MAX_REQUEST_TIMEOUT_MS
    )
  );
  const bodyIdleTimeoutMs = Math.min(
    requestTimeoutMs,
    optionalBoundedEnvironmentInteger(
      "TCAR_RUNTIME_BODY_IDLE_TIMEOUT_MS",
      DEFAULT_BODY_IDLE_TIMEOUT_MS,
      1,
      MAX_BODY_IDLE_TIMEOUT_MS
    )
  );
  const maxResponseBytes = optionalBoundedEnvironmentInteger(
    "TCAR_RUNTIME_MAX_RESPONSE_BYTES",
    DEFAULT_MAX_RESPONSE_BYTES,
    1024,
    MAX_RESPONSE_BYTES
  );
  const headers = {};
  let encodedBody;
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    encodedBody = Buffer.from(JSON.stringify(body), "utf8");
    headers["Content-Length"] = String(encodedBody.length);
  }
  const configuredRuntimeApiKey = runtimeApiKey();
  if (configuredRuntimeApiKey) {
    headers["X-TCAR-API-Key"] = configuredRuntimeApiKey;
  }

  const requestOptions = {
    method,
    headers,
    body: encodedBody,
    requestTimeoutMs,
    connectTimeoutMs,
    headerTimeoutMs,
    bodyIdleTimeoutMs,
    maxResponseBytes
  };
  const requestUrl = `${runtimeBaseUrl()}${path}`;
  const response = testFetchTransport
    ? await boundedTestFetch(requestUrl, requestOptions, testFetchTransport)
    : await boundedHttpRequest(requestUrl, requestOptions);
  const text = response.body.toString("utf8");
  let payload = {};
  let invalidJson = false;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      invalidJson = true;
    }
  }
  if (response.status < 200 || response.status >= 300) {
    const projected = projectRuntimeFailure(payload, response.status);
    const error = new Error(runtimeFailureMessage(projected));
    error.status = response.status;
    error.code = projected.code;
    error.retryable = projected.retryable === true;
    error.providerStatus = projected.provider_status;
    error.requestId = projected.provider_request_id;
    error.diagnostic = projected;
    throw error;
  }
  if (invalidJson) {
    const error = new Error("The Runtime returned an invalid response.");
    error.status = 502;
    error.code = "runtime_invalid_json";
    throw error;
  }
  return payload;
}

async function boundedTestFetch(url, { method, headers, body, requestTimeoutMs, maxResponseBytes }, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetchImpl(url, {
      method,
      headers,
      body: body?.toString("utf8"),
      signal: controller.signal
    });
    const text = await response.text();
    const responseBody = Buffer.from(text, "utf8");
    if (responseBody.length > maxResponseBytes) {
      const error = new Error("TCAR runtime response exceeded the configured size limit.");
      error.status = 502;
      throw error;
    }
    return {
      status: response.status,
      statusMessage: response.statusText || "",
      headers: Object.fromEntries(response.headers?.entries?.() || []),
      body: responseBody
    };
  } catch (error) {
    if (error.name === "AbortError") throw runtimeTimeoutError(requestTimeoutMs);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function boundedHttpRequest(urlValue, {
  method,
  headers,
  body,
  requestTimeoutMs,
  connectTimeoutMs,
  headerTimeoutMs,
  bodyIdleTimeoutMs,
  maxResponseBytes
}) {
  const url = new URL(urlValue);
  const transport = url.protocol === "https:" ? https : url.protocol === "http:" ? http : null;
  if (!transport) throw new Error("TCAR runtime URL must use http or https.");

  return new Promise((resolve, reject) => {
    let response;
    let settled = false;
    let receivedBytes = 0;
    const chunks = [];
    const timers = new Set();

    const clearTimer = (timer) => {
      if (!timer) return;
      clearTimeout(timer);
      timers.delete(timer);
    };
    const schedule = (callback, milliseconds) => {
      const timer = setTimeout(callback, milliseconds);
      timers.add(timer);
      return timer;
    };
    const cleanup = () => {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    };
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) {
        response?.destroy();
        request.socket?.destroy();
        request.destroy();
        reject(error);
      } else {
        resolve(value);
      }
    };
    const totalTimer = schedule(() => finish(runtimeTimeoutError(requestTimeoutMs)), requestTimeoutMs);
    const headerTimer = schedule(() => finish(runtimeTimeoutError(headerTimeoutMs)), headerTimeoutMs);
    let connectTimer = schedule(() => finish(runtimeTimeoutError(connectTimeoutMs)), connectTimeoutMs);
    let bodyTimer;
    const resetBodyTimer = () => {
      clearTimer(bodyTimer);
      bodyTimer = schedule(() => finish(runtimeTimeoutError(bodyIdleTimeoutMs)), bodyIdleTimeoutMs);
    };

    let request;
    try {
      request = transport.request(url, {
        method,
        headers,
        agent: url.protocol === "https:" ? HTTPS_AGENT : HTTP_AGENT
      });
    } catch (error) {
      cleanup();
      reject(error);
      return;
    }
    request.once("socket", (socket) => {
      const readyEvent = socket.encrypted ? "secureConnect" : "connect";
      if (!socket.connecting && (!socket.encrypted || socket.authorized !== undefined)) {
        clearTimer(connectTimer);
        connectTimer = undefined;
        return;
      }
      socket.once(readyEvent, () => {
        clearTimer(connectTimer);
        connectTimer = undefined;
      });
    });
    request.once("response", (incoming) => {
      response = incoming;
      clearTimer(headerTimer);
      resetBodyTimer();
      incoming.on("data", (chunk) => {
        receivedBytes += chunk.length;
        if (receivedBytes > maxResponseBytes) {
          const error = new Error("TCAR runtime response exceeded the configured size limit.");
          error.status = 502;
          finish(error);
          return;
        }
        chunks.push(chunk);
        resetBodyTimer();
      });
      incoming.once("aborted", () => {
        const error = new Error("TCAR runtime closed the response before it completed.");
        error.status = 502;
        error.code = "runtime_response_incomplete";
        error.retryable = true;
        finish(error);
      });
      incoming.once("error", (error) => finish(normalizeRuntimeTransportError(error)));
      incoming.once("end", () => {
        clearTimer(totalTimer);
        clearTimer(bodyTimer);
        finish(null, {
          status: incoming.statusCode || 0,
          statusMessage: incoming.statusMessage || "",
          headers: incoming.headers,
          body: Buffer.concat(chunks, receivedBytes)
        });
      });
    });
    request.once("error", (error) => finish(normalizeRuntimeTransportError(error)));
    if (body) request.write(body);
    request.end();
  });
}

async function runtimeStreamRequest(path, {
  body,
  expectedRunId,
  onPlannerCompleted,
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  const requestTimeoutMs = boundedInteger(timeoutMs, "runtime stream timeout", 1, MAX_REQUEST_TIMEOUT_MS);
  const connectTimeoutMs = Math.min(
    requestTimeoutMs,
    optionalBoundedEnvironmentInteger(
      "TCAR_RUNTIME_CONNECT_TIMEOUT_MS",
      DEFAULT_CONNECT_TIMEOUT_MS,
      1,
      MAX_CONNECT_TIMEOUT_MS
    )
  );
  const headerTimeoutMs = Math.min(
    requestTimeoutMs,
    optionalBoundedEnvironmentInteger(
      "TCAR_RUNTIME_HEADER_TIMEOUT_MS",
      requestTimeoutMs,
      1,
      MAX_REQUEST_TIMEOUT_MS
    )
  );
  const bodyIdleTimeoutMs = Math.min(
    requestTimeoutMs,
    optionalBoundedEnvironmentInteger(
      "TCAR_RUNTIME_BODY_IDLE_TIMEOUT_MS",
      DEFAULT_BODY_IDLE_TIMEOUT_MS,
      1,
      MAX_BODY_IDLE_TIMEOUT_MS
    )
  );
  const maxResponseBytes = optionalBoundedEnvironmentInteger(
    "TCAR_RUNTIME_MAX_RESPONSE_BYTES",
    DEFAULT_MAX_RESPONSE_BYTES,
    1024,
    MAX_RESPONSE_BYTES
  );
  const encodedBody = Buffer.from(JSON.stringify(body ?? {}), "utf8");
  const headers = {
    Accept: RUNTIME_STREAM_CONTENT_TYPE,
    "Content-Type": "application/json",
    "Content-Length": String(encodedBody.length),
    "X-TCAR-Stream-Protocol": RUNTIME_STREAM_PROTOCOL
  };
  const configuredRuntimeApiKey = runtimeApiKey();
  if (configuredRuntimeApiKey) headers["X-TCAR-API-Key"] = configuredRuntimeApiKey;

  const requestOptions = {
    method: "POST",
    headers,
    body: encodedBody,
    requestTimeoutMs,
    connectTimeoutMs,
    headerTimeoutMs,
    bodyIdleTimeoutMs,
    maxResponseBytes,
    expectedRunId,
    onPlannerCompleted
  };
  const requestUrl = `${runtimeBaseUrl()}${path}`;
  return testFetchTransport
    ? boundedTestStreamFetch(requestUrl, requestOptions, testFetchTransport)
    : boundedHttpStreamRequest(requestUrl, requestOptions);
}

async function boundedTestStreamFetch(url, options, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.requestTimeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: options.method,
      headers: options.headers,
      body: options.body.toString("utf8"),
      signal: controller.signal
    });
    return await consumeRuntimeStreamResponse({
      status: response.status,
      headers: Object.fromEntries(response.headers?.entries?.() || []),
      body: response.body,
      maxResponseBytes: options.maxResponseBytes,
      expectedRunId: options.expectedRunId,
      onPlannerCompleted: options.onPlannerCompleted
    });
  } catch (error) {
    if (error.name === "AbortError") throw runtimeTimeoutError(options.requestTimeoutMs);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function boundedHttpStreamRequest(urlValue, options) {
  const url = new URL(urlValue);
  const transport = url.protocol === "https:" ? https : url.protocol === "http:" ? http : null;
  if (!transport) throw new Error("TCAR runtime URL must use http or https.");

  return new Promise((resolve, reject) => {
    let request;
    let response;
    let settled = false;
    const timers = new Set();
    const clearTimer = (timer) => {
      if (!timer) return;
      clearTimeout(timer);
      timers.delete(timer);
    };
    const schedule = (callback, milliseconds) => {
      const timer = setTimeout(callback, milliseconds);
      timers.add(timer);
      return timer;
    };
    const cleanup = () => {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    };
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) {
        response?.destroy();
        request?.socket?.destroy();
        request?.destroy();
        reject(error);
      } else {
        resolve(value);
      }
    };
    schedule(() => finish(runtimeTimeoutError(options.requestTimeoutMs)), options.requestTimeoutMs);
    const headerTimer = schedule(() => finish(runtimeTimeoutError(options.headerTimeoutMs)), options.headerTimeoutMs);
    let connectTimer = schedule(() => finish(runtimeTimeoutError(options.connectTimeoutMs)), options.connectTimeoutMs);
    let bodyTimer;
    let effectiveBodyIdleTimeoutMs = options.bodyIdleTimeoutMs;
    const resetBodyTimer = () => {
      clearTimer(bodyTimer);
      bodyTimer = schedule(
        () => finish(runtimeStreamIdleTimeoutError(effectiveBodyIdleTimeoutMs)),
        effectiveBodyIdleTimeoutMs
      );
    };

    try {
      request = transport.request(url, {
        method: options.method,
        headers: options.headers,
        agent: url.protocol === "https:" ? HTTPS_AGENT : HTTP_AGENT
      });
    } catch (error) {
      cleanup();
      reject(error);
      return;
    }
    request.once("socket", (socket) => {
      const readyEvent = socket.encrypted ? "secureConnect" : "connect";
      if (!socket.connecting && (!socket.encrypted || socket.authorized !== undefined)) {
        clearTimer(connectTimer);
        connectTimer = undefined;
        return;
      }
      socket.once(readyEvent, () => {
        clearTimer(connectTimer);
        connectTimer = undefined;
      });
    });
    request.once("response", (incoming) => {
      response = incoming;
      clearTimer(headerTimer);
      try {
        const heartbeatNegotiated = validateRuntimeStreamProtocol(incoming.headers);
        effectiveBodyIdleTimeoutMs = heartbeatNegotiated
          ? options.bodyIdleTimeoutMs
          : Math.min(
            options.requestTimeoutMs,
            Math.max(options.bodyIdleTimeoutMs, LEGACY_STREAM_BODY_IDLE_TIMEOUT_MS)
          );
      } catch (error) {
        finish(error);
        return;
      }
      resetBodyTimer();
      const timedBody = (async function* timedRuntimeBody() {
        for await (const chunk of incoming) {
          clearTimer(bodyTimer);
          yield chunk;
          if (!settled) resetBodyTimer();
        }
        clearTimer(bodyTimer);
      })();
      void consumeRuntimeStreamResponse({
        status: incoming.statusCode || 0,
        headers: incoming.headers,
        body: timedBody,
        maxResponseBytes: options.maxResponseBytes,
        expectedRunId: options.expectedRunId,
        onPlannerCompleted: options.onPlannerCompleted
      }).then(
        (value) => finish(null, value),
        (error) => {
          if (incoming.complete === false && !error?.code) {
            const incomplete = new Error("TCAR runtime closed the response before it completed.");
            incomplete.status = 502;
            incomplete.code = "runtime_response_incomplete";
            incomplete.retryable = true;
            finish(incomplete);
            return;
          }
          finish(normalizeRuntimeTransportError(error));
        }
      );
    });
    request.once("error", (error) => finish(normalizeRuntimeTransportError(error)));
    request.write(options.body);
    request.end();
  });
}

async function consumeRuntimeStreamResponse({
  status,
  headers,
  body,
  maxResponseBytes,
  expectedRunId,
  onPlannerCompleted
}) {
  const contentType = responseContentType(headers);
  const heartbeatsNegotiated = validateRuntimeStreamProtocol(headers);
  if (status < 200 || status >= 300) {
    const responseBody = await readBoundedStreamBody(body, maxResponseBytes);
    const payload = parseJsonObject(responseBody.toString("utf8")) || {};
    const error = projectedRuntimeError(payload, status);
    // Only the HTTP response that proves the additive endpoint itself is
    // unavailable may be replayed through /chat/execute. An NDJSON terminal
    // failure can carry the same numeric status after the execution id was
    // claimed and must never trigger a second model request.
    error.runtimeStreamFallbackSafe = status === 404 || status === 405;
    throw error;
  }
  // A JSON success is accepted as a compatibility response. This keeps older
  // Runtime deployments and existing /chat/execute-compatible test doubles
  // usable, but it cannot manufacture an early planner event.
  if (contentType === "application/json") {
    const responseBody = await readBoundedStreamBody(body, maxResponseBytes);
    const payload = parseJsonObject(responseBody.toString("utf8"));
    if (!payload) throw invalidRuntimeStream("the compatibility response was not valid JSON");
    return { result: payload, streamedPlan: null, legacy: true };
  }
  if (contentType !== RUNTIME_STREAM_CONTENT_TYPE) {
    throw invalidRuntimeStream(`unexpected content type ${contentType || "missing"}`);
  }

  const parser = createRuntimeNdjsonParser({
    expectedRunId,
    maxResponseBytes,
    onPlannerCompleted,
    heartbeatsNegotiated
  });
  if (body) {
    for await (const chunk of body) {
      await parser.push(chunk);
    }
  }
  return parser.finish();
}

function createRuntimeNdjsonParser({
  expectedRunId,
  maxResponseBytes,
  onPlannerCompleted,
  heartbeatsNegotiated
}) {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffered = "";
  let receivedBytes = 0;
  let expectedSequence = 1;
  let eventCount = 0;
  let heartbeatCount = 0;
  let streamedPlan = null;
  let terminal = null;

  const consumeLine = async (rawLine) => {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    // A single trailing delimiter does not call consumeLine because the buffer
    // is empty after splitting it. Any actual empty record therefore represents
    // additional stream data and is rejected, including CRLF/blank-line
    // smuggling after a terminal event.
    if (!line) throw invalidRuntimeStream("the response contained an empty event record");
    eventCount += 1;
    if (eventCount > MAX_RUNTIME_STREAM_EVENTS) {
      throw invalidRuntimeStream("too many events");
    }
    if (terminal) throw invalidRuntimeStream("an event followed the terminal event");
    const lineBytes = Buffer.byteLength(line, "utf8");
    const event = parseJsonObject(line);
    if (!event) throw invalidRuntimeStream("an event was not valid JSON");
    assertExactObjectKeys(event, ["at", "data", "run_id", "sequence", "type"], "event envelope");
    if (!Number.isSafeInteger(event.sequence) || event.sequence !== expectedSequence) {
      throw invalidRuntimeStream("event sequences were not strictly contiguous");
    }
    expectedSequence += 1;
    if (String(event.run_id || "") !== String(expectedRunId || "")) {
      throw invalidRuntimeStream("event run identity did not match the request");
    }
    if (!safeIdentifier(event.run_id)) throw invalidRuntimeStream("event run identity was malformed");
    if (!validStreamTimestamp(event.at)) throw invalidRuntimeStream("event timestamp was malformed");
    if (!isPlainObject(event.data)) throw invalidRuntimeStream("event data was malformed");

    if (event.type === "run.heartbeat") {
      if (!heartbeatsNegotiated) {
        throw invalidRuntimeStream("a heartbeat arrived without protocol negotiation");
      }
      heartbeatCount += 1;
      if (heartbeatCount > MAX_RUNTIME_STREAM_HEARTBEATS) {
        throw invalidRuntimeStream("too many heartbeat events");
      }
      if (lineBytes > MAX_RUNTIME_STREAM_HEARTBEAT_BYTES) {
        throw invalidRuntimeStream("a heartbeat event exceeded its size limit");
      }
      assertExactObjectKeys(event.data, [], "heartbeat event data");
      return;
    }
    if (event.type === "planner.completed") {
      if (streamedPlan) throw invalidRuntimeStream("planner.completed was duplicated");
      if (lineBytes > MAX_RUNTIME_STREAM_PLAN_EVENT_BYTES) {
        throw invalidRuntimeStream("the planner event exceeded its size limit");
      }
      assertExactObjectKeys(event.data, ["contract_digest", "plan"], "planner event data");
      const contractDigest = String(event.data.contract_digest || "");
      if (!/^sha256:[a-f0-9]{64}$/.test(contractDigest)) {
        throw invalidRuntimeStream("the planner contract digest was malformed");
      }
      streamedPlan = validateStreamPlan(event.data.plan);
      if (typeof onPlannerCompleted === "function") {
        await onPlannerCompleted(streamedPlan, contractDigest);
      }
      return;
    }
    if (event.type === "run.completed") {
      if (!streamedPlan) throw invalidRuntimeStream("run.completed arrived before planner.completed");
      assertExactObjectKeys(event.data, ["result"], "completion event data");
      if (!isPlainObject(event.data.result)) throw invalidRuntimeStream("the terminal result was malformed");
      terminal = { type: event.type, result: event.data.result };
      return;
    }
    if (event.type === "run.failed") {
      assertExactObjectKeys(event.data, ["error"], "failure event data");
      terminal = { type: event.type, error: validateStreamFailure(event.data.error) };
      return;
    }
    throw invalidRuntimeStream("an unsupported event type was returned");
  };

  return {
    async push(value) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      receivedBytes += chunk.length;
      if (receivedBytes > maxResponseBytes) {
        const error = new Error("TCAR runtime response exceeded the configured size limit.");
        error.status = 502;
        error.code = "runtime_response_too_large";
        throw error;
      }
      try {
        buffered += decoder.decode(chunk, { stream: true });
      } catch {
        throw invalidRuntimeStream("the response was not valid UTF-8");
      }
      while (true) {
        const newline = buffered.indexOf("\n");
        if (newline < 0) break;
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        await consumeLine(line);
      }
    },
    async finish() {
      try {
        buffered += decoder.decode();
      } catch {
        throw invalidRuntimeStream("the response ended with invalid UTF-8");
      }
      if (buffered) await consumeLine(buffered);
      if (!terminal) throw invalidRuntimeStream("the response ended before a terminal event");
      if (terminal.type === "run.failed") {
        const error = new Error("TCAR runtime reported a failed streamed execution.");
        error.status = terminal.error.status;
        error.code = terminal.error.code;
        error.retryable = terminal.error.retryable;
        error.component = terminal.error.component;
        throw error;
      }
      return { result: terminal.result, streamedPlan, legacy: false };
    }
  };
}

function validateStreamPlan(value) {
  if (!isPlainObject(value)) throw invalidRuntimeStream("the planner payload was malformed");
  assertExactObjectKeys(value, ["steps"], "planner payload");
  if (!Array.isArray(value.steps) || value.steps.length > MAX_RUNTIME_STREAM_PLAN_STEPS) {
    throw invalidRuntimeStream("the planner step list was malformed");
  }
  return {
    steps: value.steps.map((step) => {
      if (!isPlainObject(step)) throw invalidRuntimeStream("a planner step was malformed");
      assertExactObjectKeys(step, ["adapter", "depends_on", "id", "task"], "planner step");
      if (!safeIdentifier(step.id) || !safeIdentifier(step.adapter)) {
        throw invalidRuntimeStream("a planner step identity was malformed");
      }
      if (
        typeof step.task !== "string"
        || Array.from(step.task).length > MAX_RUNTIME_STREAM_TASK_CHARS
        || normalizeStreamTask(step.task) !== step.task
      ) {
        throw invalidRuntimeStream("a planner task was malformed");
      }
      if (
        !Array.isArray(step.depends_on)
        || step.depends_on.length > MAX_RUNTIME_STREAM_PLAN_STEPS
        || new Set(step.depends_on).size !== step.depends_on.length
        || step.depends_on.some((dependency) => !safeIdentifier(dependency))
      ) {
        throw invalidRuntimeStream("planner dependencies were malformed");
      }
      return {
        id: step.id,
        adapter: step.adapter,
        task: step.task,
        depends_on: [...step.depends_on]
      };
    })
  };
}

function validateStreamFailure(value) {
  if (!isPlainObject(value)) throw invalidRuntimeStream("the failure payload was malformed");
  const keys = Object.keys(value).sort();
  const allowed = new Set(["code", "component", "retryable", "status"]);
  if (!keys.every((key) => allowed.has(key)) || !keys.includes("code") || !keys.includes("retryable") || !keys.includes("status")) {
    throw invalidRuntimeStream("the failure payload contained unsupported fields");
  }
  if (!safeIdentifier(value.code)) throw invalidRuntimeStream("the failure code was malformed");
  if (!Number.isSafeInteger(value.status) || value.status < 400 || value.status > 599) {
    throw invalidRuntimeStream("the failure status was malformed");
  }
  if (typeof value.retryable !== "boolean") throw invalidRuntimeStream("the failure retry flag was malformed");
  if (value.component !== undefined && !safeIdentifier(value.component)) {
    throw invalidRuntimeStream("the failure component was malformed");
  }
  return {
    code: value.code,
    status: value.status,
    retryable: value.retryable,
    ...(value.component ? { component: value.component } : {})
  };
}

async function readBoundedStreamBody(body, maximum) {
  const chunks = [];
  let length = 0;
  if (body) {
    for await (const value of body) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      length += chunk.length;
      if (length > maximum) {
        const error = new Error("TCAR runtime response exceeded the configured size limit.");
        error.status = 502;
        error.code = "runtime_response_too_large";
        throw error;
      }
      chunks.push(chunk);
    }
  }
  return Buffer.concat(chunks, length);
}

function responseContentType(headers) {
  const value = headers?.["content-type"] ?? headers?.["Content-Type"] ?? "";
  return String(Array.isArray(value) ? value[0] : value).split(";", 1)[0].trim().toLowerCase();
}

function validateRuntimeStreamProtocol(headers) {
  const value = headers?.["x-tcar-stream-protocol"] ?? headers?.["X-TCAR-Stream-Protocol"] ?? "";
  const protocol = String(Array.isArray(value) ? value[0] : value).trim();
  if (!protocol) return false;
  if (protocol !== RUNTIME_STREAM_PROTOCOL) {
    throw invalidRuntimeStream("the response selected an unsupported stream protocol");
  }
  return true;
}

function projectedRuntimeError(payload, status) {
  const projected = projectRuntimeFailure(payload, status);
  const error = new Error(runtimeFailureMessage(projected));
  error.status = status;
  error.code = projected.code;
  error.retryable = projected.retryable === true;
  error.providerStatus = projected.provider_status;
  error.requestId = projected.provider_request_id;
  error.diagnostic = projected;
  return error;
}

function parseJsonObject(text) {
  if (!text) return null;
  try {
    const value = JSON.parse(text);
    return isPlainObject(value) ? value : null;
  } catch {
    return null;
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertExactObjectKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (actual.length !== sortedExpected.length || actual.some((key, index) => key !== sortedExpected[index])) {
    throw invalidRuntimeStream(`${label} contained unsupported fields`);
  }
}

function safeIdentifier(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 200
    && /^[A-Za-z0-9][A-Za-z0-9_.:@/-]*$/.test(value);
}

function normalizeStreamTask(value) {
  const normalized = stripStreamTaskControls(String(value || ""))
    .replace(/\p{White_Space}+/gu, " ")
    .trim();
  return Array.from(normalized).slice(0, MAX_RUNTIME_STREAM_TASK_CHARS).join("");
}

function stripStreamTaskControls(value) {
  return Array.from(value).filter((character) => {
    const code = character.codePointAt(0);
    return !(
      code <= 0x08
      || code === 0x0b
      || code === 0x0c
      || (code >= 0x0e && code <= 0x1f)
      || code === 0x7f
    );
  }).join("");
}

function validStreamTimestamp(value) {
  return typeof value === "string"
    && value.length <= 48
    && /(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value));
}

function invalidRuntimeStream(detail) {
  const error = new Error(`The Runtime returned an invalid event stream: ${detail}.`);
  error.status = 502;
  error.code = "runtime_stream_invalid";
  return error;
}

function normalizeRuntimeTransportError(error) {
  if (Number(error?.status) > 0) return error;
  const code = String(error?.code || "").toUpperCase();
  const message = String(error?.message || "").toLowerCase();
  if (code === "ECONNRESET" || message.includes("socket hang up") || message.includes("connection reset")) {
    const normalized = new Error("TCAR runtime connection closed unexpectedly.");
    normalized.status = 502;
    normalized.code = "runtime_connection_reset";
    normalized.retryable = true;
    normalized.cause = error;
    return normalized;
  }
  return error;
}

function runtimeTimeoutError(timeoutMs) {
  const error = new Error(`TCAR runtime request timed out after ${timeoutMs}ms.`);
  error.status = 504;
  return error;
}

function runtimeStreamIdleTimeoutError(timeoutMs) {
  const error = new Error(`TCAR runtime event stream was idle for ${timeoutMs}ms.`);
  error.status = 504;
  error.code = "runtime_stream_idle_timeout";
  error.retryable = true;
  error.component = "runtime_stream";
  return error;
}

function optionalBoundedEnvironmentInteger(name, fallback, minimum, maximum) {
  const raw = String(process.env[name] ?? "").trim();
  if (!raw) return fallback;
  return boundedInteger(raw, name, minimum, maximum);
}

function boundedInteger(value, label, minimum, maximum) {
  const text = String(value ?? "").trim();
  if (!/^\d+$/.test(text)) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}.`);
  }
  const number = Number(text);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}.`);
  }
  return number;
}

export function fetchRuntimeHealth() {
  return runtimeRequest("/health", { timeoutMs: Number(process.env.TCAR_RUNTIME_HEALTH_TIMEOUT_MS || 5000) });
}

export function fetchRuntimeModels() {
  return runtimeRequest("/models", { timeoutMs: Number(process.env.TCAR_RUNTIME_HEALTH_TIMEOUT_MS || 5000) });
}

export function fetchRuntimeAgents() {
  return runtimeRequest("/agents", {
    // Listing routes may need to validate byte provenance for every mounted and
    // archived adapter after a lifecycle mutation. It is not a lightweight
    // health probe and must not inherit the five-second health budget.
    timeoutMs: Number(process.env.TCAR_RUNTIME_AGENT_LIST_TIMEOUT_MS || 120000)
  });
}

export function fetchRuntimeAgent(agentId) {
  return runtimeRequest(`/agents/${encodeURIComponent(agentId)}`, {
    timeoutMs: Number(process.env.TCAR_RUNTIME_HEALTH_TIMEOUT_MS || 5000)
  });
}

export function fetchRuntimeExecutionReceipt(executionId) {
  return runtimeRequest(`/audit/executions/${encodeURIComponent(executionId)}`, {
    timeoutMs: Number(process.env.TCAR_RUNTIME_ADMIN_TIMEOUT_MS || 180000)
  });
}

export function verifyRuntimeExecutionSubject(subjectId) {
  return runtimeRequest(`/audit/subjects/execution/${encodeURIComponent(subjectId)}/verify`, {
    timeoutMs: Number(process.env.TCAR_RUNTIME_ADMIN_TIMEOUT_MS || 180000)
  });
}

export async function fetchRuntimeSubjectReceipts(subjectType, subjectId, { limit = MAX_AUDIT_RECEIPT_PAGE_SIZE } = {}) {
  const pageLimit = boundedInteger(
    limit,
    "Runtime audit receipt page limit",
    1,
    MAX_AUDIT_RECEIPT_PAGE_SIZE
  );
  const expectedSubjectType = String(subjectType);
  const expectedSubjectId = String(subjectId);
  const receipts = [];
  let afterSequence = 0;
  let snapshotSequence = null;
  let snapshotHeadHash = null;

  while (true) {
    const query = new URLSearchParams({
      limit: String(pageLimit),
      after_sequence: String(afterSequence)
    });
    if (snapshotSequence !== null) query.set("through_sequence", String(snapshotSequence));
    const page = await runtimeRequest(
      `/audit/subjects/${encodeURIComponent(expectedSubjectType)}/${encodeURIComponent(expectedSubjectId)}/receipts?${query.toString()}`,
      { timeoutMs: Number(process.env.TCAR_RUNTIME_ADMIN_TIMEOUT_MS || 180000) }
    );
    const pageReceipts = Array.isArray(page?.receipts) ? page.receipts : null;
    const pageSnapshotSequence = Number(page?.snapshot_sequence);
    const pageAfterSequence = Number(page?.after_sequence);
    const pageHeadHash = String(page?.snapshot_head_hash || "");
    if (
      page?.ok !== true
      || Number(page?.schema_version) !== 1
      || page?.subject_type !== expectedSubjectType
      || page?.subject_id !== expectedSubjectId
      || !Number.isSafeInteger(pageSnapshotSequence)
      || pageSnapshotSequence < 0
      || pageAfterSequence !== afterSequence
      || !/^[a-f0-9]{64}$/.test(pageHeadHash)
      || pageReceipts === null
      || pageReceipts.length > pageLimit
      || typeof page?.has_more !== "boolean"
    ) {
      throw invalidRuntimeAuditPage("metadata did not match the requested subject and cursor");
    }
    if (snapshotSequence === null) {
      snapshotSequence = pageSnapshotSequence;
      snapshotHeadHash = pageHeadHash;
    } else if (pageSnapshotSequence !== snapshotSequence || pageHeadHash !== snapshotHeadHash) {
      throw invalidRuntimeAuditPage("the pinned subject snapshot changed between pages");
    }

    let previousPageSequence = afterSequence;
    for (const receipt of pageReceipts) {
      const sequence = Number(receipt?.subject_sequence);
      if (
        !Number.isSafeInteger(sequence)
        || sequence <= previousPageSequence
        || sequence > snapshotSequence
      ) {
        throw invalidRuntimeAuditPage("receipt sequences were not strictly ascending within the snapshot");
      }
      previousPageSequence = sequence;
    }
    receipts.push(...pageReceipts);

    if (!page.has_more) {
      if (
        page?.next_after_sequence !== null
        || previousPageSequence !== snapshotSequence
        || receipts.length !== snapshotSequence
      ) {
        throw invalidRuntimeAuditPage("the final page did not complete the pinned subject snapshot");
      }
      return {
        ok: true,
        schema_version: 1,
        subject_type: expectedSubjectType,
        subject_id: expectedSubjectId,
        snapshot_sequence: snapshotSequence,
        snapshot_head_hash: snapshotHeadHash,
        receipts
      };
    }

    const nextAfterSequence = Number(page?.next_after_sequence);
    if (
      pageReceipts.length === 0
      || !Number.isSafeInteger(nextAfterSequence)
      || nextAfterSequence !== previousPageSequence
      || nextAfterSequence <= afterSequence
      || nextAfterSequence >= snapshotSequence
    ) {
      throw invalidRuntimeAuditPage("the continuation cursor did not advance");
    }
    afterSequence = nextAfterSequence;
  }
}

export function verifyRuntimeAuditSubject(subjectType, subjectId, { throughSequence } = {}) {
  const query = new URLSearchParams();
  if (throughSequence !== undefined) {
    query.set("through_sequence", String(boundedInteger(
      throughSequence,
      "Runtime audit through sequence",
      0,
      Number.MAX_SAFE_INTEGER
    )));
  }
  const suffix = query.size ? `?${query.toString()}` : "";
  return runtimeRequest(`/audit/subjects/${encodeURIComponent(subjectType)}/${encodeURIComponent(subjectId)}/verify${suffix}`, {
    timeoutMs: Number(process.env.TCAR_RUNTIME_ADMIN_TIMEOUT_MS || 180000)
  });
}

function invalidRuntimeAuditPage(detail) {
  const error = new Error(`TCAR runtime returned an invalid audit receipt page: ${detail}.`);
  error.status = 502;
  error.code = "runtime_audit_page_invalid";
  return error;
}

export function executeRuntimeChat({ query, sharedMemory = [], options = {}, executionContext = {}, worldGraph = null }) {
  return runtimeRequest("/chat/execute", {
    method: "POST",
    body: {
      query,
      shared_memory: sharedMemory,
      execution_context: executionContext,
      options,
      ...(worldGraph ? { world_graph: worldGraph } : {})
    },
    timeoutMs: Number(process.env.TCAR_RUNTIME_CHAT_TIMEOUT_MS || DEFAULT_TIMEOUT_MS)
  });
}

export async function executeRuntimeChatStream({
  query,
  sharedMemory = [],
  options = {},
  executionContext = {},
  worldGraph = null,
  onPlannerCompleted
}) {
  const body = {
    query,
    shared_memory: sharedMemory,
    execution_context: executionContext,
    options,
    ...(worldGraph ? { world_graph: worldGraph } : {})
  };
  try {
    return await runtimeStreamRequest("/chat/execute/stream", {
      body,
      expectedRunId: executionContext.run_id,
      onPlannerCompleted,
      timeoutMs: Number(process.env.TCAR_RUNTIME_CHAT_TIMEOUT_MS || DEFAULT_TIMEOUT_MS)
    });
  } catch (error) {
    // Old Runtime deployments do not expose the stream route. Only an explicit
    // endpoint/method miss is safe to replay through the compatible endpoint;
    // malformed, truncated, or failed streams are never retried implicitly.
    if (error?.runtimeStreamFallbackSafe === true) {
      return {
        result: await executeRuntimeChat({ query, sharedMemory, options, executionContext, worldGraph }),
        streamedPlan: null,
        legacy: true
      };
    }
    throw error;
  }
}

export function composeRuntimeWorkflow({
  command,
  mode,
  intent,
  candidates = [],
  connections = [],
  conversation_context = [],
  execution_context = {}
}) {
  return runtimeRequest("/workflow/compose", {
    method: "POST",
    body: {
      command,
      mode,
      intent,
      candidates,
      connections,
      conversation_context,
      execution_context
    },
    timeoutMs: Number(process.env.TCAR_RUNTIME_WORKFLOW_TIMEOUT_MS || process.env.TCAR_RUNTIME_CHAT_TIMEOUT_MS || DEFAULT_TIMEOUT_MS)
  });
}

export function continueRuntimeConversation({
  original_request = "",
  prior_answer = "",
  decision,
  tool_name,
  tool_result = null,
  conversation_context = [],
  execution_context = {}
}) {
  return runtimeRequest("/chat/continue", {
    method: "POST",
    body: {
      original_request,
      prior_answer,
      decision,
      tool_name,
      tool_result,
      conversation_context,
      execution_context
    },
    timeoutMs: Number(process.env.TCAR_RUNTIME_CONTINUATION_TIMEOUT_MS || process.env.TCAR_RUNTIME_CHAT_TIMEOUT_MS || DEFAULT_TIMEOUT_MS)
  });
}

export function registerRuntimeAgent(agent) {
  return runtimeRequest("/agents", {
    method: "POST",
    body: selectFields(agent, [
      "id",
      "title",
      "capability",
      "boundary",
      "consumes",
      "produces",
      "routing_cues",
      "resources",
      "tools",
      "tool_contracts",
      "sources",
      "policies",
      "stage",
      "source_text",
      "overwrite",
      "registration_id",
      "audit_context"
    ]),
    timeoutMs: Number(process.env.TCAR_RUNTIME_ADMIN_TIMEOUT_MS || 180000)
  });
}

export function updateRuntimeAgent(agentId, patch) {
  return runtimeRequest(`/agents/${encodeURIComponent(agentId)}`, {
    method: "PATCH",
    body: selectFields(patch, [
      "title",
      "capability",
      "boundary",
      "consumes",
      "produces",
      "routing_cues",
      "resources",
      "tools",
      "tool_contracts",
      "sources",
      "policies",
      "stage",
      "enabled",
      "source_text",
      "audit_context"
    ]),
    timeoutMs: Number(process.env.TCAR_RUNTIME_ADMIN_TIMEOUT_MS || 180000)
  });
}

function selectFields(value, allowedFields) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return Object.fromEntries(
    allowedFields
      .filter((field) => source[field] !== undefined)
      .map((field) => [field, source[field]])
  );
}

export function mountRuntimeAgent(agentId, auditContext = {}) {
  return runtimeRequest(`/agents/${encodeURIComponent(agentId)}/mount`, {
    method: "POST",
    body: { audit_context: auditContext },
    timeoutMs: Number(process.env.TCAR_RUNTIME_ADMIN_TIMEOUT_MS || 180000)
  });
}

export function archiveRuntimeAgent(agentId, auditContext = {}) {
  return runtimeRequest(`/agents/${encodeURIComponent(agentId)}`, {
    method: "DELETE",
    body: { audit_context: auditContext },
    timeoutMs: Number(process.env.TCAR_RUNTIME_ADMIN_TIMEOUT_MS || 180000)
  });
}

export function deleteArchivedRuntimeAgent(agentId, auditContext = {}) {
  return runtimeRequest(`/agents/${encodeURIComponent(agentId)}`, {
    method: "DELETE",
    body: { audit_context: auditContext, delete_archived: true },
    timeoutMs: Number(process.env.TCAR_RUNTIME_ADMIN_TIMEOUT_MS || 180000)
  });
}

export function purgeRuntimeAgentRegistration(agentId, registrationId, auditContext = {}) {
  return runtimeRequest(`/agents/${encodeURIComponent(agentId)}`, {
    method: "DELETE",
    body: {
      audit_context: auditContext,
      registration_id: registrationId,
      purge_registration: true
    },
    timeoutMs: Number(process.env.TCAR_RUNTIME_ADMIN_TIMEOUT_MS || 180000)
  });
}

export function registerRuntimeDocument(document) {
  return runtimeRequest("/documents", {
    method: "POST",
    body: document,
    timeoutMs: Number(process.env.TCAR_RUNTIME_ADMIN_TIMEOUT_MS || 600000)
  });
}

export function deleteRuntimeDocument(agentId, auditContext = {}, registrationId = null) {
  return runtimeRequest(`/documents/${encodeURIComponent(agentId)}`, {
    method: "DELETE",
    body: {
      audit_context: auditContext,
      ...(registrationId ? { registration_id: registrationId, purge_registration: true } : {})
    },
    timeoutMs: Number(process.env.TCAR_RUNTIME_ADMIN_TIMEOUT_MS || 180000)
  });
}

export function runRuntimeValidation({ suite, case_filter }) {
  return runtimeRequest("/validation/run", {
    method: "POST",
    body: { suite, case_filter, timeout_sec: Number(process.env.TCAR_RUNTIME_VALIDATION_TIMEOUT_SEC || 900) },
    timeoutMs: Number(process.env.TCAR_RUNTIME_VALIDATION_TIMEOUT_SEC || 900) * 1000
  });
}

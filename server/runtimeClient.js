import { appAuthConfigured, secretConfigured } from "./authConfig.js";

const DEFAULT_TIMEOUT_MS = 900000;

export function runtimeMode() {
  return String(process.env.TCAR_ENGINE_MODE || "simulator").toLowerCase();
}

export function realRuntimeEnabled() {
  return runtimeMode() === "real";
}

export function requireRuntimeConfigured() {
  const isProduction = process.env.NODE_ENV === "production";
  if (realRuntimeEnabled() && !process.env.TCAR_RUNTIME_API_URL) {
    throw new Error("TCAR_ENGINE_MODE=real requires TCAR_RUNTIME_API_URL.");
  }
  if (realRuntimeEnabled() && isProduction && !secretConfigured(process.env.TCAR_RUNTIME_API_KEY)) {
    throw new Error("Production real runtime requires TCAR_RUNTIME_API_KEY.");
  }
  if (isProduction && process.env.APP_ALLOW_UNAUTHENTICATED !== "1") {
    if (!appAuthConfigured(process.env, { requireStrongSecrets: true })) {
      throw new Error("Production web server requires strong Basic Auth credentials or strong APP_API_TOKENS/APP_API_TOKENS_JSON, or APP_ALLOW_UNAUTHENTICATED=1 with an explicit unauthenticated identity.");
    }
  } else if (isProduction) {
    validateUnauthenticatedProductionIdentity(process.env);
  }
  if (isProduction && !process.env.DATABASE_URL && process.env.APP_ALLOW_JSON_STORE !== "1") {
    throw new Error("Production web server requires DATABASE_URL. Set APP_ALLOW_JSON_STORE=1 only for isolated private-beta deployments.");
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
    || hostname === "127.0.0.1"
    || hostname === "::1"
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

function validateProductionRuntimeApiUrl(env) {
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
  if (isLocalRuntimeHost(runtimeHost) && env.TCAR_ALLOW_LOCAL_RUNTIME_URL !== "1") {
    throw new Error("Production split deployment requires TCAR_RUNTIME_API_URL to point to the private GPU runtime host, not localhost. Set TCAR_ALLOW_LOCAL_RUNTIME_URL=1 only for an explicit same-host private-beta deployment.");
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
  return hostname === "localhost" || hostname === "localhost.localdomain" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "0.0.0.0";
}

function runtimeBaseUrl() {
  const value = process.env.TCAR_RUNTIME_API_URL;
  if (!value) {
    throw new Error("TCAR_RUNTIME_API_URL is not configured.");
  }
  return value.replace(/\/+$/, "");
}

export async function runtimeRequest(path, { method = "GET", body, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const headers = {};
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  if (process.env.TCAR_RUNTIME_API_KEY) {
    headers["X-TCAR-API-Key"] = process.env.TCAR_RUNTIME_API_KEY;
  }

  try {
    const response = await fetch(`${runtimeBaseUrl()}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal
    });
    const text = await response.text();
    let payload = {};
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { raw: text };
      }
    }
    if (!response.ok) {
      const detail = payload.detail || payload.message || payload.error || response.statusText;
      const error = new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    return payload;
  } catch (error) {
    if (error.name === "AbortError") {
      const timeout = new Error(`TCAR runtime request timed out after ${timeoutMs}ms.`);
      timeout.status = 504;
      throw timeout;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function fetchRuntimeHealth() {
  return runtimeRequest("/health", { timeoutMs: Number(process.env.TCAR_RUNTIME_HEALTH_TIMEOUT_MS || 5000) });
}

export function fetchRuntimeModels() {
  return runtimeRequest("/models", { timeoutMs: Number(process.env.TCAR_RUNTIME_HEALTH_TIMEOUT_MS || 5000) });
}

export function fetchRuntimeAgents() {
  return runtimeRequest("/agents", { timeoutMs: Number(process.env.TCAR_RUNTIME_HEALTH_TIMEOUT_MS || 5000) });
}

export function fetchRuntimeAgent(agentId) {
  return runtimeRequest(`/agents/${encodeURIComponent(agentId)}`, {
    timeoutMs: Number(process.env.TCAR_RUNTIME_HEALTH_TIMEOUT_MS || 5000)
  });
}

export function executeRuntimeChat({ query, sharedMemory = [], options = {} }) {
  return runtimeRequest("/chat/execute", {
    method: "POST",
    body: {
      query,
      shared_memory: sharedMemory,
      options
    },
    timeoutMs: Number(process.env.TCAR_RUNTIME_CHAT_TIMEOUT_MS || DEFAULT_TIMEOUT_MS)
  });
}

export function registerRuntimeAgent(agent) {
  return runtimeRequest("/agents", {
    method: "POST",
    body: agent,
    timeoutMs: Number(process.env.TCAR_RUNTIME_ADMIN_TIMEOUT_MS || 180000)
  });
}

export function updateRuntimeAgent(agentId, patch) {
  return runtimeRequest(`/agents/${encodeURIComponent(agentId)}`, {
    method: "PATCH",
    body: patch,
    timeoutMs: Number(process.env.TCAR_RUNTIME_ADMIN_TIMEOUT_MS || 180000)
  });
}

export function mountRuntimeAgent(agentId) {
  return runtimeRequest(`/agents/${encodeURIComponent(agentId)}/mount`, {
    method: "POST",
    timeoutMs: Number(process.env.TCAR_RUNTIME_ADMIN_TIMEOUT_MS || 180000)
  });
}

export function archiveRuntimeAgent(agentId) {
  return runtimeRequest(`/agents/${encodeURIComponent(agentId)}`, {
    method: "DELETE",
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

export function runRuntimeValidation({ suite, case_filter }) {
  return runtimeRequest("/validation/run", {
    method: "POST",
    body: { suite, case_filter, timeout_sec: Number(process.env.TCAR_RUNTIME_VALIDATION_TIMEOUT_SEC || 900) },
    timeoutMs: Number(process.env.TCAR_RUNTIME_VALIDATION_TIMEOUT_SEC || 900) * 1000
  });
}

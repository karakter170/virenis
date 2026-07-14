import http from "node:http";
import https from "node:https";

import { readConfiguredSecret } from "./secretConfig.js";

const MAX_OAUTH_RESPONSE_BYTES = 512 * 1024;
const DEFAULT_OAUTH_TIMEOUT_MS = 15_000;
const GMAIL_ENDPOINT = "https://gmailmcp.googleapis.com/mcp/v1";
const GOOGLE_AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOCATION_ENDPOINT = "https://oauth2.googleapis.com/revoke";

const MANAGED_PROVIDER_PUBLIC = Object.freeze({
  id: "gmail",
  name: "Gmail",
  description: "Search mail, read threads, manage labels, and create drafts with your Google account.",
  auth_type: "oauth2",
  connection_mode: "managed",
  connect_label: "Connect Gmail",
  preview: true,
  provider_status: "developer_preview",
  default_read_policy: "allow_declared_reads"
});

export function publicManagedMcpProviders(env = process.env) {
  const provider = managedMcpProvider("gmail", env, { requireConfigured: false });
  return [{
    ...MANAGED_PROVIDER_PUBLIC,
    availability: provider.configured ? "available" : "setup_required",
    availability_message: provider.configured
      ? "Connect with Google"
      : "An administrator must configure the Google OAuth application first."
  }];
}

export function managedMcpProvider(providerId, env = process.env, { requireConfigured = true } = {}) {
  if (String(providerId || "").trim().toLowerCase() !== "gmail") {
    throw oauthError(404, "Managed MCP provider not found.", "mcp_provider_not_found");
  }
  const clientId = cleanCredential(env.APP_MCP_GMAIL_OAUTH_CLIENT_ID, "Google OAuth client id", 2048);
  const clientSecret = cleanCredential(readConfiguredSecret(
    env,
    "APP_MCP_GMAIL_OAUTH_CLIENT_SECRET",
    "APP_MCP_GMAIL_OAUTH_CLIENT_SECRET_FILE",
    { maxBytes: 16 * 1024 }
  ), "Google OAuth client secret", 16 * 1024);
  const redirectOrigin = oauthRedirectOrigin(env);
  const testOverrides = env.NODE_ENV === "test" && env.APP_MCP_OAUTH_ALLOW_TEST_HTTP === "1";
  const provider = {
    ...MANAGED_PROVIDER_PUBLIC,
    endpoint_url: testOverrides && env.APP_MCP_GMAIL_ENDPOINT_URL
      ? normalizeProviderUrl(env.APP_MCP_GMAIL_ENDPOINT_URL, env)
      : GMAIL_ENDPOINT,
    authorization_url: testOverrides && env.APP_MCP_GMAIL_AUTHORIZATION_URL
      ? normalizeProviderUrl(env.APP_MCP_GMAIL_AUTHORIZATION_URL, env)
      : GOOGLE_AUTHORIZATION_ENDPOINT,
    token_url: testOverrides && env.APP_MCP_GMAIL_TOKEN_URL
      ? normalizeProviderUrl(env.APP_MCP_GMAIL_TOKEN_URL, env)
      : GOOGLE_TOKEN_ENDPOINT,
    revocation_url: testOverrides && env.APP_MCP_GMAIL_REVOCATION_URL
      ? normalizeProviderUrl(env.APP_MCP_GMAIL_REVOCATION_URL, env)
      : GOOGLE_REVOCATION_ENDPOINT,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectOrigin ? `${redirectOrigin}/api/mcp/oauth/callback/gmail` : "",
    scopes: [
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.compose"
    ],
    configured: Boolean(
      clientId
      && clientSecret
      && redirectOrigin
      && !/replace|placeholder|example/i.test(clientId)
      && !/replace|placeholder|example/i.test(clientSecret)
    ),
    include_resource_indicator: false
  };
  if (requireConfigured && !provider.configured) {
    throw oauthError(
      503,
      "Gmail one-click connection is not configured. Set the public origin and Google OAuth client credentials.",
      "mcp_provider_not_configured"
    );
  }
  return provider;
}

export function buildManagedAuthorizationUrl(provider, { state, codeChallenge }) {
  const url = new URL(provider.authorization_url);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", provider.client_id);
  url.searchParams.set("redirect_uri", provider.redirect_uri);
  url.searchParams.set("scope", provider.scopes.join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("prompt", "consent");
  if (provider.include_resource_indicator) {
    url.searchParams.set("resource", provider.endpoint_url);
  }
  return url.toString();
}

export async function exchangeManagedAuthorizationCode(provider, { code, codeVerifier }) {
  const normalizedCode = cleanAuthorizationCode(code);
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: normalizedCode,
    client_id: provider.client_id,
    client_secret: provider.client_secret,
    redirect_uri: provider.redirect_uri,
    code_verifier: codeVerifier
  });
  if (provider.include_resource_indicator) body.set("resource", provider.endpoint_url);
  const response = await oauthFormRequest(provider.token_url, body, { env: process.env });
  const credential = normalizeTokenResponse(response, { providerId: provider.id, requireRefreshToken: false });
  credential.scope ||= provider.scopes.join(" ");
  return credential;
}

export async function refreshManagedAccessToken(provider, credential) {
  const refreshToken = cleanToken(credential?.refresh_token, "OAuth refresh token", { required: true });
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: provider.client_id,
    client_secret: provider.client_secret
  });
  if (provider.include_resource_indicator) body.set("resource", provider.endpoint_url);
  const response = await oauthFormRequest(provider.token_url, body, { env: process.env });
  const refreshed = normalizeTokenResponse(response, { providerId: provider.id, requireRefreshToken: false });
  const merged = {
    ...refreshed,
    refresh_token: refreshed.refresh_token || refreshToken,
    scope: refreshed.scope || credential.scope || ""
  };
  assertManagedCredentialScopes(provider, merged);
  return merged;
}

export async function revokeManagedCredential(provider, credential) {
  const token = cleanToken(credential?.refresh_token || credential?.access_token, "OAuth revocation token", { required: true });
  await oauthFormRequest(provider.revocation_url, new URLSearchParams({ token }), {
    env: process.env,
    allowEmpty: true
  });
  return true;
}

export function oauthCredentialNeedsRefresh(credential, { skewMs = 60_000, now = Date.now() } = {}) {
  if (credential?.type !== "oauth2") return false;
  const expiresAt = Date.parse(String(credential.expires_at || ""));
  return Number.isFinite(expiresAt) && expiresAt <= now + skewMs;
}

function normalizeTokenResponse(raw, { providerId, requireRefreshToken }) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw oauthError(502, "OAuth server returned an invalid token response.", "mcp_oauth_token_invalid");
  }
  if (raw.error) {
    throw oauthError(502, "OAuth authorization could not be completed.", "mcp_oauth_token_rejected");
  }
  const accessToken = cleanToken(raw.access_token, "OAuth access token", { required: true });
  const refreshToken = cleanToken(raw.refresh_token, "OAuth refresh token", { required: requireRefreshToken });
  const tokenType = String(raw.token_type || "Bearer").trim();
  if (!/^bearer$/i.test(tokenType)) {
    throw oauthError(502, "OAuth server returned an unsupported token type.", "mcp_oauth_token_type");
  }
  const rawExpiresIn = Number(raw.expires_in);
  const expiresIn = Number.isFinite(rawExpiresIn)
    ? Math.max(1, Math.min(Math.trunc(rawExpiresIn), 86_400))
    : 3600;
  const scope = typeof raw.scope === "string" ? raw.scope.trim().slice(0, 16_384) : "";
  return {
    type: "oauth2",
    provider_id: providerId,
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: "Bearer",
    scope,
    expires_at: new Date(Date.now() + expiresIn * 1000).toISOString()
  };
}

async function oauthFormRequest(endpoint, form, { env, allowEmpty = false }) {
  const url = new URL(normalizeProviderUrl(endpoint, env));
  const body = form.toString();
  const transport = url.protocol === "https:" ? https : http;
  const rawTimeout = Number(env.APP_MCP_OAUTH_TIMEOUT_MS || DEFAULT_OAUTH_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(rawTimeout) ? Math.max(500, Math.min(rawTimeout, 60_000)) : DEFAULT_OAUTH_TIMEOUT_MS;
  const result = await new Promise((resolve, reject) => {
    const request = transport.request(url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(body),
        "User-Agent": "Virenis-MCP-OAuth/1.0"
      }
    }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400) {
        response.resume();
        reject(oauthError(502, "OAuth redirects are not followed.", "mcp_oauth_redirect_blocked"));
        return;
      }
      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_OAUTH_RESPONSE_BYTES) {
          request.destroy(oauthError(502, "OAuth response exceeded the size limit.", "mcp_oauth_response_too_large"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        const responseBody = Buffer.concat(chunks).toString("utf8");
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(oauthError(502, "OAuth provider rejected the request.", "mcp_oauth_provider_error"));
          return;
        }
        if (!responseBody.trim() && allowEmpty) {
          resolve({});
          return;
        }
        try {
          resolve(JSON.parse(responseBody));
        } catch {
          reject(oauthError(502, "OAuth provider returned invalid JSON.", "mcp_oauth_json_invalid"));
        }
      });
    });
    const deadline = setTimeout(() => request.destroy(oauthError(504, "OAuth request timed out.", "mcp_oauth_timeout")), timeoutMs);
    request.on("close", () => clearTimeout(deadline));
    request.setTimeout(timeoutMs, () => request.destroy(oauthError(504, "OAuth request timed out.", "mcp_oauth_timeout")));
    request.on("error", (error) => reject(error.code?.startsWith?.("mcp_")
      ? error
      : oauthError(502, "OAuth provider could not be reached.", "mcp_oauth_connection_failed")));
    request.end(body);
  });
  return result;
}

function oauthRedirectOrigin(env) {
  const configuredRedirect = String(env.APP_MCP_OAUTH_REDIRECT_ORIGIN || "").replace(/\/+$/, "");
  const publicOrigin = String(env.APP_PUBLIC_ORIGIN || "").replace(/\/+$/, "");
  if (configuredRedirect && publicOrigin && configuredRedirect !== publicOrigin) {
    throw oauthError(500, "MCP OAuth redirect origin must match APP_PUBLIC_ORIGIN.", "mcp_oauth_origin_mismatch");
  }
  const raw = configuredRedirect || publicOrigin;
  if (!raw) return "";
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw oauthError(500, "MCP OAuth redirect origin is invalid.", "mcp_oauth_origin_invalid");
  }
  if (parsed.origin !== raw || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw oauthError(500, "MCP OAuth redirect origin must contain only scheme, host, and optional port.", "mcp_oauth_origin_invalid");
  }
  const testHttp = env.NODE_ENV === "test" && env.APP_MCP_OAUTH_ALLOW_TEST_HTTP === "1";
  const localDevelopment = env.NODE_ENV !== "production"
    && parsed.protocol === "http:"
    && ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !testHttp && !localDevelopment) {
    throw oauthError(500, "MCP OAuth redirect origin must use HTTPS.", "mcp_oauth_origin_invalid");
  }
  return parsed.origin;
}

function normalizeProviderUrl(value, env) {
  let parsed;
  try {
    parsed = new URL(String(value || ""));
  } catch {
    throw oauthError(500, "Managed provider URL is invalid.", "mcp_provider_url_invalid");
  }
  const testHttp = env.NODE_ENV === "test" && env.APP_MCP_OAUTH_ALLOW_TEST_HTTP === "1";
  if (parsed.protocol !== "https:" && !(testHttp && parsed.protocol === "http:")) {
    throw oauthError(500, "Managed provider URLs must use HTTPS.", "mcp_provider_url_invalid");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw oauthError(500, "Managed provider URLs cannot contain credentials, query parameters, or fragments.", "mcp_provider_url_invalid");
  }
  return parsed.toString();
}

function cleanCredential(value, label, maximum) {
  const cleaned = String(value || "").trim();
  if (!cleaned) return "";
  if (cleaned.length > maximum || /[\r\n\0]/.test(cleaned)) {
    throw oauthError(500, `${label} is invalid.`, "mcp_provider_configuration_invalid");
  }
  return cleaned;
}

function cleanAuthorizationCode(value) {
  const code = String(value || "").trim();
  if (!code || code.length > 8192 || /[\r\n\0]/.test(code)) {
    throw oauthError(400, "OAuth authorization code is invalid.", "mcp_oauth_code_invalid");
  }
  return code;
}

function cleanToken(value, label, { required }) {
  const token = String(value || "").trim();
  if (!token && !required) return "";
  if (!token || token.length > 32 * 1024 || /[\r\n\0]/.test(token)) {
    throw oauthError(502, `${label} is invalid.`, "mcp_oauth_token_invalid");
  }
  return token;
}

export function assertManagedCredentialScopes(provider, credential) {
  const granted = new Set(String(credential?.scope || "").split(/\s+/).filter(Boolean));
  const missing = provider.scopes.filter((scope) => !granted.has(scope));
  if (missing.length) {
    throw oauthError(403, "The provider did not grant every required permission.", "mcp_oauth_scope_missing");
  }
}

function oauthError(status, message, code) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

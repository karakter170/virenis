import http from "node:http";
import https from "node:https";

import { readConfiguredSecret } from "./secretConfig.js";

const MAX_OAUTH_RESPONSE_BYTES = 512 * 1024;
const DEFAULT_OAUTH_TIMEOUT_MS = 15_000;
const GOOGLE_AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOCATION_ENDPOINT = "https://oauth2.googleapis.com/revoke";

const PROVIDER_DEFINITIONS = Object.freeze([
  googleProvider({
    id: "gmail",
    name: "Gmail",
    category: "Communication",
    endpointUrl: "https://gmailmcp.googleapis.com/mcp/v1",
    description: "Search mail, read threads, manage labels, and create drafts with your Google account.",
    scopes: [
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.compose"
    ],
    permissionsSummary: "Read relevant mail and create drafts. Sending or changing data still requires approval."
  }),
  googleProvider({
    id: "google_drive",
    name: "Google Drive",
    category: "Knowledge & files",
    endpointUrl: "https://drivemcp.googleapis.com/mcp/v1",
    description: "Find and read Drive files, then work with files the connection is permitted to access.",
    scopes: [
      "https://www.googleapis.com/auth/drive.readonly",
      "https://www.googleapis.com/auth/drive.file"
    ],
    permissionsSummary: "Read Drive content and work only with files explicitly available to this app."
  }),
  googleProvider({
    id: "google_calendar",
    name: "Google Calendar",
    category: "Planning",
    endpointUrl: "https://calendarmcp.googleapis.com/mcp/v1",
    description: "Check calendars, availability, and event details with your Google account.",
    scopes: [
      "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
      "https://www.googleapis.com/auth/calendar.events.freebusy",
      "https://www.googleapis.com/auth/calendar.events.readonly"
    ],
    permissionsSummary: "Read calendars, event details, and free/busy availability."
  }),
  googleProvider({
    id: "google_chat",
    name: "Google Chat",
    category: "Communication",
    endpointUrl: "https://chatmcp.googleapis.com/mcp/v1",
    description: "Find spaces and messages, and prepare approved messages in Google Chat.",
    scopes: [
      "https://www.googleapis.com/auth/chat.spaces.readonly",
      "https://www.googleapis.com/auth/chat.memberships.readonly",
      "https://www.googleapis.com/auth/chat.messages.readonly",
      "https://www.googleapis.com/auth/chat.messages.create",
      "https://www.googleapis.com/auth/chat.users.readstate.readonly"
    ],
    permissionsSummary: "Read spaces and messages. Creating a message remains approval-gated."
  }),
  googleProvider({
    id: "google_contacts",
    name: "Google Contacts",
    category: "Productivity",
    endpointUrl: "https://people.googleapis.com/mcp/v1",
    description: "Look up people, profiles, and contacts available to your Google account.",
    scopes: [
      "https://www.googleapis.com/auth/directory.readonly",
      "https://www.googleapis.com/auth/userinfo.profile",
      "https://www.googleapis.com/auth/contacts.readonly"
    ],
    permissionsSummary: "Read profile, directory, and contact information."
  }),
  Object.freeze({
    id: "github",
    name: "GitHub",
    category: "Engineering",
    description: "Search repositories, inspect issues and pull requests, and use approved GitHub actions.",
    auth_type: "oauth2",
    connection_mode: "managed",
    connect_label: "Connect GitHub",
    provider_status: "stable",
    default_read_policy: "allow_declared_reads",
    permissions_summary: "Read repository context automatically. Mutating tools require explicit approval.",
    registration_mode: "configured",
    endpoint_url: "https://api.githubcopilot.com/mcp/",
    authorization_url: "https://github.com/login/oauth/authorize",
    token_url: "https://github.com/login/oauth/access_token",
    revocation_url: "https://api.github.com/applications",
    revocation_mode: "github_application_tokens",
    scopes: ["repo", "read:org", "read:user", "user:email"],
    required_scopes: [],
    include_resource_indicator: false,
    allowed_hosts: ["api.githubcopilot.com", "github.com", "api.github.com"],
    credential_group: "GITHUB",
    scope_parameter: "scope",
    token_response_style: "standard",
    authorization_params: {}
  }),
  Object.freeze({
    id: "slack",
    name: "Slack",
    category: "Communication",
    description: "Search workspace conversations and prepare approved messages with your Slack account.",
    auth_type: "oauth2",
    connection_mode: "managed",
    connect_label: "Connect Slack",
    provider_status: "stable",
    default_read_policy: "allow_declared_reads",
    permissions_summary: "Read permitted conversations and files. Posting or reacting remains approval-gated.",
    registration_mode: "configured",
    endpoint_url: "https://mcp.slack.com/mcp",
    authorization_url: "https://slack.com/oauth/v2_user/authorize",
    token_url: "https://slack.com/api/oauth.v2.user.access",
    revocation_url: "https://slack.com/api/auth.revoke",
    revocation_mode: "slack_auth_revoke",
    scopes: [
      "search:read.public",
      "search:read.private",
      "search:read.mpim",
      "search:read.im",
      "search:read.files",
      "files:read",
      "search:read.users",
      "channels:history",
      "groups:history",
      "mpim:history",
      "im:history",
      "chat:write"
    ],
    required_scopes: [],
    include_resource_indicator: false,
    allowed_hosts: ["mcp.slack.com", "slack.com"],
    credential_group: "SLACK",
    scope_parameter: "user_scope",
    token_response_style: "slack",
    authorization_params: {}
  }),
  dynamicProvider({
    id: "notion",
    name: "Notion",
    category: "Knowledge & files",
    endpointUrl: "https://mcp.notion.com/mcp",
    metadataUrl: "https://mcp.notion.com/.well-known/oauth-protected-resource",
    description: "Search and work with the pages and databases you choose in Notion.",
    scopes: [],
    permissionsSummary: "Use only the Notion pages you grant. Data-changing tools require approval.",
    allowedHosts: ["mcp.notion.com"]
  }),
  dynamicProvider({
    id: "linear",
    name: "Linear",
    category: "Planning",
    endpointUrl: "https://mcp.linear.app/mcp",
    metadataUrl: "https://mcp.linear.app/.well-known/oauth-protected-resource",
    description: "Read project context and use approved issue or project actions in Linear.",
    scopes: ["read", "write"],
    permissionsSummary: "Read workspace context automatically. Issue and project changes require approval.",
    allowedHosts: ["mcp.linear.app"]
  })
]);

const PROVIDERS_BY_ID = new Map(PROVIDER_DEFINITIONS.map((provider) => [provider.id, provider]));

export const MANAGED_MCP_PROVIDER_IDS = Object.freeze(PROVIDER_DEFINITIONS.map((provider) => provider.id));

export function isManagedMcpProviderId(providerId) {
  return PROVIDERS_BY_ID.has(String(providerId || "").trim().toLowerCase());
}

export function publicManagedMcpProviders(env = process.env) {
  return PROVIDER_DEFINITIONS.map((definition) => {
    const provider = managedMcpProvider(definition.id, env, { requireConfigured: false });
    const available = provider.configured;
    return {
      id: provider.id,
      name: provider.name,
      category: provider.category,
      description: provider.description,
      auth_type: provider.auth_type,
      connection_mode: provider.connection_mode,
      connect_label: provider.connect_label,
      preview: Boolean(provider.preview),
      provider_status: provider.provider_status,
      default_read_policy: provider.default_read_policy,
      permissions_summary: provider.permissions_summary,
      setup_mode: provider.registration_mode === "dynamic" ? "automatic" : "administrator",
      availability: available ? "available" : "setup_required",
      availability_message: available
        ? provider.registration_mode === "dynamic"
          ? `Sign in with ${provider.name}. No endpoint, token, or administrator setup is required.`
          : `Sign in with ${provider.name}.`
        : provider.registration_mode === "dynamic"
          ? "An administrator must configure the application's public HTTPS origin first."
          : `An administrator must configure the ${provider.name} OAuth application first.`
    };
  });
}

export function managedMcpProvider(providerId, env = process.env, { requireConfigured = true } = {}) {
  const normalizedId = String(providerId || "").trim().toLowerCase();
  const definition = PROVIDERS_BY_ID.get(normalizedId);
  if (!definition) {
    throw oauthError(404, "Managed MCP provider not found.", "mcp_provider_not_found");
  }
  const redirectOrigin = oauthRedirectOrigin(env);
  const testOverrides = env.NODE_ENV === "test" && env.APP_MCP_OAUTH_ALLOW_TEST_HTTP === "1";
  const endpointUrl = testProviderUrl(definition, "ENDPOINT_URL", env) || definition.endpoint_url;
  const provider = {
    ...definition,
    endpoint_url: normalizeAndValidateProviderUrl(endpointUrl, definition, env),
    redirect_uri: redirectOrigin ? `${redirectOrigin}/api/mcp/oauth/callback/${definition.id}` : ""
  };

  if (definition.registration_mode === "configured") {
    const credentials = configuredProviderCredentials(definition, env);
    provider.client_id = credentials.clientId;
    provider.client_secret = credentials.clientSecret;
    provider.authorization_url = normalizeAndValidateProviderUrl(
      testProviderUrl(definition, "AUTHORIZATION_URL", env) || definition.authorization_url,
      definition,
      env
    );
    provider.token_url = normalizeAndValidateProviderUrl(
      testProviderUrl(definition, "TOKEN_URL", env) || definition.token_url,
      definition,
      env
    );
    provider.revocation_url = testProviderUrl(definition, "REVOCATION_URL", env)
      || definition.revocation_url
      || "";
    if (provider.revocation_url) {
      provider.revocation_url = normalizeAndValidateProviderUrl(provider.revocation_url, definition, env);
    }
    provider.configured = Boolean(
      provider.client_id
      && provider.client_secret
      && provider.redirect_uri
      && !looksPlaceholder(provider.client_id)
      && !looksPlaceholder(provider.client_secret)
    );
  } else {
    provider.protected_resource_metadata_url = normalizeAndValidateProviderUrl(
      testProviderUrl(definition, "PROTECTED_RESOURCE_METADATA_URL", env)
        || definition.protected_resource_metadata_url,
      definition,
      env
    );
    provider.authorization_server_metadata_url = testProviderUrl(definition, "AUTHORIZATION_SERVER_METADATA_URL", env) || "";
    if (provider.authorization_server_metadata_url) {
      provider.authorization_server_metadata_url = normalizeAndValidateProviderUrl(
        provider.authorization_server_metadata_url,
        definition,
        env
      );
    }
    provider.configured = Boolean(provider.redirect_uri);
  }

  provider.test_overrides = testOverrides;
  if (requireConfigured && !provider.configured) {
    const message = definition.registration_mode === "dynamic"
      ? `${definition.name} one-click connection requires APP_PUBLIC_ORIGIN or APP_MCP_OAUTH_REDIRECT_ORIGIN.`
      : `${definition.name} one-click connection is not configured. Set the public origin and OAuth client credentials.`;
    throw oauthError(503, message, "mcp_provider_not_configured");
  }
  return provider;
}

export async function prepareManagedMcpProvider(providerId, env = process.env) {
  const provider = managedMcpProvider(providerId, env);
  if (provider.registration_mode !== "dynamic") return provider;

  const protectedMetadata = await oauthJsonRequest(provider.protected_resource_metadata_url, {
    env,
    method: "GET"
  });
  const resource = cleanMetadataUrl(protectedMetadata?.resource || provider.endpoint_url, provider, env, "resource");
  const authorizationServers = Array.isArray(protectedMetadata?.authorization_servers)
    ? protectedMetadata.authorization_servers
    : [];
  if (!authorizationServers.length) {
    throw oauthError(502, `${provider.name} did not advertise an OAuth authorization server.`, "mcp_oauth_metadata_invalid");
  }
  const issuer = cleanMetadataUrl(authorizationServers[0], provider, env, "issuer");
  const metadataUrl = provider.authorization_server_metadata_url
    || authorizationServerMetadataUrl(issuer, provider, env);
  const authorizationMetadata = await oauthJsonRequest(metadataUrl, { env, method: "GET" });
  if (normalizeIssuer(authorizationMetadata?.issuer) !== normalizeIssuer(issuer)) {
    throw oauthError(502, `${provider.name} returned mismatched OAuth issuer metadata.`, "mcp_oauth_metadata_invalid");
  }
  if (!Array.isArray(authorizationMetadata?.code_challenge_methods_supported)
    || !authorizationMetadata.code_challenge_methods_supported.includes("S256")) {
    throw oauthError(502, `${provider.name} does not advertise secure PKCE support.`, "mcp_oauth_pkce_unsupported");
  }
  const supportedAuth = authorizationMetadata?.token_endpoint_auth_methods_supported;
  if (Array.isArray(supportedAuth) && !supportedAuth.includes("none")) {
    throw oauthError(502, `${provider.name} does not support public dynamic OAuth clients.`, "mcp_oauth_registration_unsupported");
  }
  const authorizationUrl = cleanMetadataUrl(authorizationMetadata?.authorization_endpoint, provider, env, "authorization endpoint");
  const tokenUrl = cleanMetadataUrl(authorizationMetadata?.token_endpoint, provider, env, "token endpoint");
  const registrationUrl = cleanMetadataUrl(
    testProviderUrl(provider, "REGISTRATION_URL", env) || authorizationMetadata?.registration_endpoint,
    provider,
    env,
    "registration endpoint"
  );
  const revocationUrl = authorizationMetadata?.revocation_endpoint
    ? cleanMetadataUrl(authorizationMetadata.revocation_endpoint, provider, env, "revocation endpoint")
    : "";
  const registration = await oauthJsonRequest(registrationUrl, {
    env,
    method: "POST",
    json: {
      client_name: "Virenis",
      client_uri: oauthRedirectOrigin(env),
      redirect_uris: [provider.redirect_uri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      ...(provider.scopes.length ? { scope: provider.scopes.join(" ") } : {})
    }
  });
  const clientId = cleanCredential(registration?.client_id, `${provider.name} OAuth client id`, 4096);
  const registrationAuthMethod = String(registration?.token_endpoint_auth_method || "none");
  if (!clientId) {
    throw oauthError(502, `${provider.name} returned an invalid dynamic client registration.`, "mcp_oauth_registration_invalid");
  }
  if (registrationAuthMethod !== "none") {
    throw oauthError(502, `${provider.name} returned an unexpected dynamic client authentication method.`, "mcp_oauth_registration_invalid");
  }
  return {
    ...provider,
    resource_url: resource,
    authorization_url: authorizationUrl,
    token_url: tokenUrl,
    registration_url: registrationUrl,
    revocation_url: revocationUrl,
    client_id: clientId,
    client_secret: "",
    token_endpoint_auth_method: registrationAuthMethod,
    configured: true
  };
}

export function snapshotManagedMcpProvider(provider) {
  return {
    provider_id: provider.id,
    endpoint_url: provider.endpoint_url,
    resource_url: provider.resource_url || provider.endpoint_url,
    authorization_url: provider.authorization_url,
    token_url: provider.token_url,
    revocation_url: provider.revocation_url || "",
    revocation_mode: provider.revocation_mode || "rfc7009",
    client_id: provider.client_id,
    client_secret: provider.client_secret || "",
    redirect_uri: provider.redirect_uri,
    scopes: [...provider.scopes],
    required_scopes: [...(provider.required_scopes || provider.scopes)],
    scope_parameter: provider.scope_parameter || "scope",
    include_resource_indicator: Boolean(provider.include_resource_indicator),
    token_response_style: provider.token_response_style || "standard",
    token_endpoint_auth_method: provider.token_endpoint_auth_method || "client_secret_post",
    authorization_params: { ...(provider.authorization_params || {}) }
  };
}

export function restoreManagedMcpProvider(providerId, snapshot, env = process.env) {
  const provider = managedMcpProvider(providerId, env, { requireConfigured: false });
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot) || snapshot.provider_id !== provider.id) {
    throw oauthError(503, "Managed OAuth client data is invalid.", "mcp_oauth_client_invalid");
  }
  const redirectUri = cleanMetadataUrl(snapshot.redirect_uri, provider, env, "redirect URI");
  if (!provider.redirect_uri || redirectUri !== provider.redirect_uri) {
    throw oauthError(503, "Managed OAuth redirect configuration changed. Start the connection again.", "mcp_oauth_origin_changed");
  }
  const endpointUrl = cleanMetadataUrl(snapshot.endpoint_url, provider, env, "MCP endpoint");
  if (endpointUrl !== provider.endpoint_url) {
    throw oauthError(503, "Managed MCP endpoint configuration changed. Start the connection again.", "mcp_oauth_endpoint_changed");
  }
  const scopes = cleanScopeList(snapshot.scopes);
  if (JSON.stringify(scopes) !== JSON.stringify(provider.scopes)) {
    throw oauthError(503, "Managed OAuth permissions changed. Start the connection again.", "mcp_oauth_scope_changed");
  }
  const restored = {
    ...provider,
    endpoint_url: endpointUrl,
    resource_url: cleanMetadataUrl(snapshot.resource_url || endpointUrl, provider, env, "OAuth resource"),
    authorization_url: cleanMetadataUrl(snapshot.authorization_url, provider, env, "authorization endpoint"),
    token_url: cleanMetadataUrl(snapshot.token_url, provider, env, "token endpoint"),
    revocation_url: snapshot.revocation_url
      ? cleanMetadataUrl(snapshot.revocation_url, provider, env, "revocation endpoint")
      : provider.revocation_url || "",
    revocation_mode: provider.revocation_mode || "rfc7009",
    client_id: cleanCredential(snapshot.client_id, `${provider.name} OAuth client id`, 4096),
    client_secret: cleanCredential(snapshot.client_secret, `${provider.name} OAuth client secret`, 16 * 1024),
    redirect_uri: redirectUri,
    scopes,
    required_scopes: cleanScopeList(snapshot.required_scopes),
    scope_parameter: snapshot.scope_parameter === "user_scope" ? "user_scope" : "scope",
    include_resource_indicator: snapshot.include_resource_indicator === true,
    token_response_style: snapshot.token_response_style === "slack" ? "slack" : "standard",
    token_endpoint_auth_method: snapshot.token_endpoint_auth_method === "none" ? "none" : "client_secret_post",
    authorization_params: cleanAuthorizationParams(snapshot.authorization_params),
    configured: true
  };
  if (!restored.client_id) {
    throw oauthError(503, "Managed OAuth client data is incomplete.", "mcp_oauth_client_invalid");
  }
  return restored;
}

export function managedMcpProviderForCredential(providerId, credential, env = process.env) {
  if (credential?.oauth_client) return restoreManagedMcpProvider(providerId, credential.oauth_client, env);
  return managedMcpProvider(providerId, env);
}

export function buildManagedAuthorizationUrl(provider, { state, codeChallenge }) {
  const url = new URL(provider.authorization_url);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", provider.client_id);
  url.searchParams.set("redirect_uri", provider.redirect_uri);
  if (provider.scopes.length) {
    url.searchParams.set(provider.scope_parameter || "scope", provider.scopes.join(" "));
  }
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  for (const [name, value] of Object.entries(provider.authorization_params || {})) {
    url.searchParams.set(name, value);
  }
  if (provider.include_resource_indicator) {
    url.searchParams.set("resource", provider.resource_url || provider.endpoint_url);
  }
  return url.toString();
}

export async function exchangeManagedAuthorizationCode(provider, { code, codeVerifier, env = process.env }) {
  const normalizedCode = cleanAuthorizationCode(code);
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: normalizedCode,
    client_id: provider.client_id,
    redirect_uri: provider.redirect_uri,
    code_verifier: codeVerifier
  });
  if (provider.client_secret && provider.token_endpoint_auth_method !== "none") body.set("client_secret", provider.client_secret);
  if (provider.include_resource_indicator) body.set("resource", provider.resource_url || provider.endpoint_url);
  const response = await oauthFormRequest(provider.token_url, body, { env });
  const credential = normalizeTokenResponse(response, { provider, requireRefreshToken: false });
  credential.scope ||= provider.scopes.join(" ");
  credential.oauth_client = snapshotManagedMcpProvider(provider);
  return credential;
}

export async function refreshManagedAccessToken(provider, credential, env = process.env) {
  const refreshToken = cleanToken(credential?.refresh_token, "OAuth refresh token", { required: true });
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: provider.client_id
  });
  if (provider.client_secret && provider.token_endpoint_auth_method !== "none") body.set("client_secret", provider.client_secret);
  if (provider.include_resource_indicator) body.set("resource", provider.resource_url || provider.endpoint_url);
  const response = await oauthFormRequest(provider.token_url, body, { env });
  const refreshed = normalizeTokenResponse(response, { provider, requireRefreshToken: false });
  const merged = {
    ...refreshed,
    refresh_token: refreshed.refresh_token || refreshToken,
    scope: refreshed.scope || credential.scope || "",
    oauth_client: credential.oauth_client || snapshotManagedMcpProvider(provider)
  };
  assertManagedCredentialScopes(provider, merged);
  return merged;
}

export async function revokeManagedCredential(provider, credential, env = process.env) {
  if (!provider.revocation_url) {
    throw oauthError(
      501,
      `${provider.name} does not expose an OAuth revocation endpoint. Remove access from your ${provider.name} security settings.`,
      "mcp_oauth_revocation_unsupported"
    );
  }
  if (provider.revocation_mode === "github_application_tokens") {
    const tokens = uniqueCredentialTokens(credential, "GitHub");
    const clientId = cleanCredential(provider.client_id, "GitHub OAuth client id", 4096);
    const clientSecret = cleanCredential(provider.client_secret, "GitHub OAuth client secret", 16 * 1024);
    if (!clientId || !clientSecret) {
      throw oauthError(503, "GitHub OAuth deauthorization is not configured.", "mcp_oauth_client_invalid");
    }
    const endpoint = new URL(provider.revocation_url);
    endpoint.pathname = `${endpoint.pathname.replace(/\/+$/, "")}/${encodeURIComponent(clientId)}/token`;
    const headers = {
      Accept: "application/vnd.github+json",
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`, "utf8").toString("base64")}`,
      "X-GitHub-Api-Version": "2022-11-28"
    };
    for (const token of tokens) {
      // Checking first makes deletion retry-safe. GitHub documents 404 from the
      // check endpoint as an invalid token, which is the desired end state if a
      // prior DELETE succeeded but its local receipt was not committed.
      const check = await oauthJsonRequest(endpoint.toString(), {
        env,
        method: "POST",
        json: { access_token: token },
        acceptedStatusCodes: [404],
        headers
      });
      if (check?.provider_status === 404) continue;
      await oauthJsonRequest(endpoint.toString(), {
        env,
        method: "DELETE",
        json: { access_token: token },
        allowEmpty: true,
        headers
      });
    }
    return true;
  }
  if (provider.revocation_mode === "slack_auth_revoke") {
    const tokens = uniqueCredentialTokens(credential, "Slack");
    for (const token of tokens) {
      const response = await oauthFormRequest(
        provider.revocation_url,
        new URLSearchParams({ token }),
        { env }
      );
      const alreadyInactive = ["account_inactive", "token_expired", "token_revoked"].includes(response?.error);
      if ((response?.ok !== true || response?.revoked !== true) && !alreadyInactive) {
        throw oauthError(502, "Slack did not confirm token revocation.", "mcp_oauth_provider_error");
      }
    }
    return true;
  }
  const token = cleanToken(credential?.refresh_token || credential?.access_token, "OAuth revocation token", { required: true });
  const body = new URLSearchParams({ token, token_type_hint: credential?.refresh_token ? "refresh_token" : "access_token" });
  if (provider.client_id) body.set("client_id", provider.client_id);
  if (provider.client_secret && provider.token_endpoint_auth_method !== "none") body.set("client_secret", provider.client_secret);
  await oauthFormRequest(provider.revocation_url, body, { env, allowEmpty: true });
  return true;
}

export function oauthCredentialNeedsRefresh(credential, { skewMs = 60_000, now = Date.now() } = {}) {
  if (credential?.type !== "oauth2") return false;
  const expiresAt = Date.parse(String(credential.expires_at || ""));
  return Number.isFinite(expiresAt) && expiresAt <= now + skewMs;
}

export function assertManagedCredentialScopes(provider, credential) {
  const required = provider.required_scopes || provider.scopes;
  if (!required.length) return;
  const granted = new Set(String(credential?.scope || "").split(/[\s,]+/).filter(Boolean));
  const missing = required.filter((scope) => !granted.has(scope));
  if (missing.length) {
    throw oauthError(403, "The provider did not grant every required permission.", "mcp_oauth_scope_missing");
  }
}

function googleProvider({ id, name, category, endpointUrl, description, scopes, permissionsSummary }) {
  return Object.freeze({
    id,
    name,
    category,
    description,
    auth_type: "oauth2",
    connection_mode: "managed",
    connect_label: `Connect ${name}`,
    preview: true,
    provider_status: "developer_preview",
    default_read_policy: "allow_declared_reads",
    permissions_summary: permissionsSummary,
    registration_mode: "configured",
    endpoint_url: endpointUrl,
    authorization_url: GOOGLE_AUTHORIZATION_ENDPOINT,
    token_url: GOOGLE_TOKEN_ENDPOINT,
    revocation_url: GOOGLE_REVOCATION_ENDPOINT,
    scopes: Object.freeze(scopes),
    required_scopes: Object.freeze(scopes),
    include_resource_indicator: false,
    allowed_hosts: Object.freeze([
      new URL(endpointUrl).hostname,
      "accounts.google.com",
      "oauth2.googleapis.com"
    ]),
    credential_group: "GOOGLE",
    scope_parameter: "scope",
    token_response_style: "standard",
    authorization_params: Object.freeze({
      access_type: "offline",
      include_granted_scopes: "true",
      prompt: "consent"
    })
  });
}

function dynamicProvider({ id, name, category, endpointUrl, metadataUrl, description, scopes, permissionsSummary, allowedHosts }) {
  return Object.freeze({
    id,
    name,
    category,
    description,
    auth_type: "oauth2",
    connection_mode: "managed",
    connect_label: `Connect ${name}`,
    provider_status: "stable",
    default_read_policy: "allow_declared_reads",
    permissions_summary: permissionsSummary,
    registration_mode: "dynamic",
    endpoint_url: endpointUrl,
    protected_resource_metadata_url: metadataUrl,
    scopes: Object.freeze(scopes),
    required_scopes: Object.freeze([]),
    include_resource_indicator: true,
    allowed_hosts: Object.freeze(allowedHosts),
    scope_parameter: "scope",
    token_response_style: "standard",
    authorization_params: Object.freeze({})
  });
}

function configuredProviderCredentials(provider, env) {
  const group = provider.credential_group;
  const legacyGmail = group === "GOOGLE" && provider.id === "gmail";
  const sharedClientId = env[`APP_MCP_${group}_OAUTH_CLIENT_ID`];
  const clientId = cleanCredential(
    sharedClientId || (legacyGmail ? env.APP_MCP_GMAIL_OAUTH_CLIENT_ID : ""),
    `${provider.name} OAuth client id`,
    4096
  );
  const sharedSecret = readConfiguredSecret(
    env,
    `APP_MCP_${group}_OAUTH_CLIENT_SECRET`,
    `APP_MCP_${group}_OAUTH_CLIENT_SECRET_FILE`,
    { maxBytes: 16 * 1024 }
  );
  const legacySecret = legacyGmail && !sharedSecret
    ? readConfiguredSecret(
      env,
      "APP_MCP_GMAIL_OAUTH_CLIENT_SECRET",
      "APP_MCP_GMAIL_OAUTH_CLIENT_SECRET_FILE",
      { maxBytes: 16 * 1024 }
    )
    : "";
  return {
    clientId,
    clientSecret: cleanCredential(sharedSecret || legacySecret, `${provider.name} OAuth client secret`, 16 * 1024)
  };
}

function normalizeTokenResponse(raw, { provider, requireRefreshToken }) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw oauthError(502, "OAuth server returned an invalid token response.", "mcp_oauth_token_invalid");
  }
  if (raw.error || raw.ok === false) {
    throw oauthError(502, "OAuth authorization could not be completed.", "mcp_oauth_token_rejected");
  }
  const source = provider.token_response_style === "slack" && raw.authed_user?.access_token
    ? { ...raw, ...raw.authed_user, scope: raw.authed_user.scope || raw.authed_user.scopes || raw.scope }
    : raw;
  const accessToken = cleanToken(source.access_token, "OAuth access token", { required: true });
  const refreshToken = cleanToken(source.refresh_token, "OAuth refresh token", { required: requireRefreshToken });
  const tokenType = String(source.token_type || "Bearer").trim();
  if (!/^bearer$/i.test(tokenType)) {
    throw oauthError(502, "OAuth server returned an unsupported token type.", "mcp_oauth_token_type");
  }
  const rawExpiresIn = Number(source.expires_in);
  const expiresIn = Number.isFinite(rawExpiresIn) && rawExpiresIn > 0
    ? Math.max(1, Math.min(Math.trunc(rawExpiresIn), 31_536_000))
    : null;
  const scopeValue = Array.isArray(source.scope) ? source.scope.join(" ") : source.scope;
  const scope = typeof scopeValue === "string" ? scopeValue.trim().slice(0, 16_384) : "";
  return {
    type: "oauth2",
    provider_id: provider.id,
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: "Bearer",
    scope,
    expires_at: expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : null
  };
}

async function oauthFormRequest(endpoint, form, { env, allowEmpty = false }) {
  return oauthJsonRequest(endpoint, {
    env,
    method: "POST",
    body: form.toString(),
    contentType: "application/x-www-form-urlencoded",
    allowEmpty
  });
}

async function oauthJsonRequest(endpoint, {
  env,
  method,
  json,
  body = json === undefined ? "" : JSON.stringify(json),
  contentType = json === undefined ? "" : "application/json",
  allowEmpty = false,
  acceptedStatusCodes = [],
  headers: extraHeaders = {}
}) {
  const url = new URL(normalizeProviderUrl(endpoint, env));
  const transport = url.protocol === "https:" ? https : http;
  const rawTimeout = Number(env.APP_MCP_OAUTH_TIMEOUT_MS || DEFAULT_OAUTH_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(rawTimeout) ? Math.max(500, Math.min(rawTimeout, 60_000)) : DEFAULT_OAUTH_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const headers = {
      Accept: "application/json",
      "User-Agent": "Virenis-MCP-OAuth/2.0",
      ...extraHeaders
    };
    if (body) {
      headers["Content-Type"] = contentType;
      headers["Content-Length"] = Buffer.byteLength(body);
    }
    const request = transport.request(url, { method, headers }, (response) => {
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
        if (acceptedStatusCodes.includes(response.statusCode)) {
          resolve({ provider_status: response.statusCode });
          return;
        }
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
}

function uniqueCredentialTokens(credential, providerName) {
  const accessToken = cleanToken(credential?.access_token, `${providerName} OAuth access token`, { required: true });
  const refreshToken = cleanToken(credential?.refresh_token, `${providerName} OAuth refresh token`, { required: false });
  return [...new Set([accessToken, refreshToken].filter(Boolean))];
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

function normalizeAndValidateProviderUrl(value, provider, env) {
  const normalized = normalizeProviderUrl(value, env);
  const parsed = new URL(normalized);
  const testHttp = env.NODE_ENV === "test" && env.APP_MCP_OAUTH_ALLOW_TEST_HTTP === "1";
  if (!testHttp && !provider.allowed_hosts.includes(parsed.hostname)) {
    throw oauthError(500, `${provider.name} OAuth metadata referenced an untrusted host.`, "mcp_provider_host_invalid");
  }
  return normalized;
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

function cleanMetadataUrl(value, provider, env, label) {
  if (!value) {
    throw oauthError(502, `${provider.name} did not advertise a valid ${label}.`, "mcp_oauth_metadata_invalid");
  }
  return normalizeAndValidateProviderUrl(value, provider, env);
}

function authorizationServerMetadataUrl(issuer, provider, env) {
  const parsed = new URL(issuer);
  const suffix = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/$/, "");
  return normalizeAndValidateProviderUrl(
    `${parsed.origin}/.well-known/oauth-authorization-server${suffix}`,
    provider,
    env
  );
}

function normalizeIssuer(value) {
  try {
    const parsed = new URL(String(value || ""));
    return `${parsed.origin}${parsed.pathname.replace(/\/$/, "")}`;
  } catch {
    return "";
  }
}

function cleanScopeList(value) {
  if (!Array.isArray(value) || value.length > 64) {
    throw oauthError(503, "Managed OAuth permission data is invalid.", "mcp_oauth_scope_invalid");
  }
  return value.map((scope) => {
    const cleaned = String(scope || "").trim();
    if (!cleaned || cleaned.length > 512 || /[\s,\0]/.test(cleaned)) {
      throw oauthError(503, "Managed OAuth permission data is invalid.", "mcp_oauth_scope_invalid");
    }
    return cleaned;
  });
}

function cleanAuthorizationParams(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const entries = Object.entries(value);
  if (entries.length > 12) throw oauthError(503, "Managed OAuth parameters are invalid.", "mcp_oauth_client_invalid");
  return Object.fromEntries(entries.map(([name, raw]) => {
    if (!/^[a-z_]{1,64}$/.test(name)) throw oauthError(503, "Managed OAuth parameters are invalid.", "mcp_oauth_client_invalid");
    const cleaned = String(raw || "");
    if (cleaned.length > 512 || /[\r\n\0]/.test(cleaned)) throw oauthError(503, "Managed OAuth parameters are invalid.", "mcp_oauth_client_invalid");
    return [name, cleaned];
  }));
}

function testProviderUrl(provider, suffix, env) {
  if (env.NODE_ENV !== "test" || env.APP_MCP_OAUTH_ALLOW_TEST_HTTP !== "1") return "";
  const key = `APP_MCP_${provider.id.toUpperCase()}_${suffix}`;
  return String(env[key] || "").trim();
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

function looksPlaceholder(value) {
  return /replace|placeholder|example|change.?me/i.test(String(value || ""));
}

function oauthError(status, message, code) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

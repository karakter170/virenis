export function secretConfigured(value) {
  const secret = String(value || "").trim();
  return secret.length >= 16 && !/replace|change-me|secret|password/i.test(secret);
}

export function basicAuthConfigured(env = process.env) {
  return Boolean(env.APP_BASIC_AUTH_USER && secretConfigured(env.APP_BASIC_AUTH_PASSWORD));
}

export function parseConfiguredApiTokens(env = process.env, { requireStrongSecrets = false } = {}) {
  const parsed = new Map();
  const json = String(env.APP_API_TOKENS_JSON || "").trim();
  if (json) {
    let payload;
    try {
      payload = JSON.parse(json);
    } catch (error) {
      throw new Error(`APP_API_TOKENS_JSON must be valid JSON: ${error.message}`);
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("APP_API_TOKENS_JSON must be an object keyed by token.");
    }
    for (const [token, identity] of Object.entries(payload)) {
      addToken(parsed, token, identity, requireStrongSecrets, "APP_API_TOKENS_JSON");
    }
  }

  for (const entry of String(env.APP_API_TOKENS || "").split(",")) {
    if (!entry.trim()) {
      continue;
    }
    const [token, userId, workspaceId, role = "user"] = entry.split(":").map((item) => item?.trim());
    if (!token || !userId || !workspaceId) {
      throw new Error("APP_API_TOKENS entries must be token:user_id:workspace_id:role.");
    }
    addToken(parsed, token, { user_id: userId, workspace_id: workspaceId, role, auth_type: "bearer" }, requireStrongSecrets, "APP_API_TOKENS");
  }
  return parsed;
}

export function bearerAuthConfigured(env = process.env, options = {}) {
  return parseConfiguredApiTokens(env, options).size > 0;
}

export function appAuthConfigured(env = process.env, options = {}) {
  return basicAuthConfigured(env) || bearerAuthConfigured(env, options);
}

function addToken(parsed, token, identity, requireStrongSecrets, source) {
  const normalizedToken = String(token || "").trim();
  if (!normalizedToken) {
    throw new Error(`${source} contains an empty token.`);
  }
  if (requireStrongSecrets && !secretConfigured(normalizedToken)) {
    throw new Error(`${source} contains a weak or placeholder token.`);
  }
  parsed.set(normalizedToken, normalizeIdentity(identity));
}

function normalizeIdentity(identity) {
  return {
    user_id: String(identity?.user_id || identity?.user || "api_user").trim(),
    workspace_id: String(identity?.workspace_id || identity?.workspace || "workspace_default").trim(),
    role: ["admin", "user", "viewer"].includes(identity?.role) ? identity.role : "user",
    auth_type: identity?.auth_type || "bearer"
  };
}

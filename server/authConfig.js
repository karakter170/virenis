import { readConfiguredSecret } from "./secretConfig.js";

const RESOLVER_TYPES = new Set(["human", "api", "document"]);
const MAX_RESOLVER_BINDINGS = 32;
const MAX_RESOLVER_AUTHORITY_CHARS = 240;
const MAX_RESOLVER_REFERENCE_CHARS = 1000;
const MIN_RESOLVER_REFERENCE_PREFIX_CHARS = 8;

export function secretConfigured(value) {
  const secret = String(value || "").trim();
  return secret.length >= 16 && !/replace|change-me|secret|password/i.test(secret);
}

export function basicAuthConfigured(env = process.env) {
  return Boolean(env.APP_BASIC_AUTH_USER && secretConfigured(basicAuthPassword(env)));
}

export function basicAuthPassword(env = process.env) {
  return readConfiguredSecret(
    env,
    "APP_BASIC_AUTH_PASSWORD",
    "APP_BASIC_AUTH_PASSWORD_FILE"
  );
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

export function identityAuthConfigured(env = process.env) {
  return env.APP_IDENTITY_ENABLED === "1";
}

export function appAuthConfigured(env = process.env, options = {}) {
  const identityConfigured = identityAuthConfigured(env);
  const basicConfigured = basicAuthConfigured(env);
  const bearerConfigured = bearerAuthConfigured(env, options);
  return identityConfigured || basicConfigured || bearerConfigured;
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
    auth_type: "bearer",
    resolver_bindings: normalizeResolverBindings(identity?.resolver_bindings)
  };
}

function normalizeResolverBindings(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error("resolver_bindings must be an array.");
  }
  if (value.length > MAX_RESOLVER_BINDINGS) {
    throw new Error(`resolver_bindings may contain at most ${MAX_RESOLVER_BINDINGS} entries.`);
  }
  return value.map((binding, index) => normalizeResolverBinding(binding, index));
}

function normalizeResolverBinding(binding, index) {
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
    throw new Error(`resolver_bindings[${index}] must be an object.`);
  }
  const type = String(binding.type || "").trim().toLowerCase();
  if (!RESOLVER_TYPES.has(type)) {
    throw new Error(`resolver_bindings[${index}].type must be human, api, or document.`);
  }
  const authority = boundedRequiredConfigText(
    binding.authority,
    `resolver_bindings[${index}].authority`,
    MAX_RESOLVER_AUTHORITY_CHARS
  );
  const hasReference = binding.reference !== undefined;
  const hasPrefix = binding.reference_prefix !== undefined;
  if (hasReference === hasPrefix) {
    throw new Error(
      `resolver_bindings[${index}] must contain exactly one of reference or reference_prefix.`
    );
  }
  if (hasReference) {
    return {
      type,
      authority,
      reference: boundedRequiredConfigText(
        binding.reference,
        `resolver_bindings[${index}].reference`,
        MAX_RESOLVER_REFERENCE_CHARS
      )
    };
  }
  const referencePrefix = boundedRequiredConfigText(
    binding.reference_prefix,
    `resolver_bindings[${index}].reference_prefix`,
    MAX_RESOLVER_REFERENCE_CHARS
  );
  if (referencePrefix.length < MIN_RESOLVER_REFERENCE_PREFIX_CHARS) {
    throw new Error(
      `resolver_bindings[${index}].reference_prefix must contain at least ${MIN_RESOLVER_REFERENCE_PREFIX_CHARS} characters.`
    );
  }
  return { type, authority, reference_prefix: referencePrefix };
}

function boundedRequiredConfigText(value, name, maxChars) {
  const text = String(value ?? "").replaceAll("\0", "").trim();
  if (!text) throw new Error(`${name} is required.`);
  if (text.length > maxChars) throw new Error(`${name} may contain at most ${maxChars} characters.`);
  return text;
}

import crypto from "node:crypto";
import { createClerkClient, clerkMiddleware, getAuth } from "@clerk/express";
import { verifyWebhook } from "@clerk/express/webhooks";
import {
  isDevelopmentFromPublishableKey,
  isDevelopmentFromSecretKey,
  isProductionFromPublishableKey,
  isProductionFromSecretKey,
  isPublishableKey,
  parsePublishableKey
} from "@clerk/shared/keys";
import { makeId, nowIso } from "./store.js";
import { readConfiguredSecret } from "./secretConfig.js";
import { ensureGeneralAgentWorkspace } from "./agentWorkspaces.js";
import {
  ensurePublisherPublicId,
  scrubDeletedPublisherReferences
} from "./marketplacePublisherIdentity.js";

const MAX_IDENTITY_AUDIT_EVENTS = 10_000;
const MAX_IDENTITY_DELETION_TOMBSTONES = 50_000;
const DISPLAY_NAME_MAX_CHARS = 80;
const EMAIL_MAX_CHARS = 254;
const VALID_ROLES = new Set(["admin", "user", "viewer"]);
const VALID_STATUSES = new Set(["active", "suspended", "deleting"]);
const ACTIVE_RUN_STATUSES = new Set(["queued", "claimed", "planning", "running", "synthesizing"]);
const DEFAULT_DELETION_DRAIN_TIMEOUT_MS = 5_000;
const MAX_DELETION_PURGE_RECEIPTS = 10_000;

export function clerkPublishableKey(env = process.env) {
  return String(env.CLERK_PUBLISHABLE_KEY || env.VITE_CLERK_PUBLISHABLE_KEY || "").trim();
}

export function clerkSecretKey(env = process.env) {
  return readConfiguredSecret(env, "CLERK_SECRET_KEY", "CLERK_SECRET_KEY_FILE");
}

export function clerkWebhookSigningSecret(env = process.env) {
  return readConfiguredSecret(env, "CLERK_WEBHOOK_SIGNING_SECRET", "CLERK_WEBHOOK_SIGNING_SECRET_FILE");
}

export function clerkIdentityEnabled(env = process.env) {
  const provider = String(env.APP_IDENTITY_PROVIDER || "").trim().toLowerCase();
  if (provider && provider !== "clerk") return false;
  return provider === "clerk" || Boolean(clerkPublishableKey(env) && clerkSecretKey(env));
}

export function clerkFrontendApiOrigin(env = process.env) {
  const parsed = parsePublishableKey(clerkPublishableKey(env));
  return parsed?.frontendApi ? `https://${parsed.frontendApi}` : "";
}

export function clerkAuthorizedParties(env = process.env) {
  const values = String(env.CLERK_AUTHORIZED_PARTIES || "")
    .split(",")
    .map((value) => value.trim().replace(/\/+$/, ""))
    .filter(Boolean);
  const publicOrigin = String(env.APP_PUBLIC_ORIGIN || "").trim().replace(/\/+$/, "");
  if (publicOrigin) values.push(publicOrigin);
  if (env.NODE_ENV !== "production") {
    const configuredPort = Number(env.PORT || 5173);
    const port = Number.isInteger(configuredPort) && configuredPort > 0 && configuredPort <= 65535
      ? configuredPort
      : 5173;
    values.push(`http://localhost:${port}`, `http://127.0.0.1:${port}`);
  }
  return [...new Set(values.map(validateAuthorizedParty))];
}

export function validateClerkEnvironment(env = process.env) {
  if (!clerkIdentityEnabled(env)) return;
  const publishableKey = clerkPublishableKey(env);
  const secretKey = clerkSecretKey(env);
  const explicitBackendPublishableKey = String(env.CLERK_PUBLISHABLE_KEY || "").trim();
  const frontendPublishableKey = String(env.VITE_CLERK_PUBLISHABLE_KEY || "").trim();
  if (
    explicitBackendPublishableKey
    && frontendPublishableKey
    && explicitBackendPublishableKey !== frontendPublishableKey
  ) {
    throw new Error("CLERK_PUBLISHABLE_KEY and VITE_CLERK_PUBLISHABLE_KEY must identify the same Clerk application.");
  }
  if (!isPublishableKey(publishableKey)) {
    throw new Error("Clerk identity requires a valid CLERK_PUBLISHABLE_KEY or VITE_CLERK_PUBLISHABLE_KEY.");
  }
  if (!/^(sk_test|sk_live)_[A-Za-z0-9_-]{16,}$/.test(secretKey)) {
    throw new Error("Clerk identity requires a valid CLERK_SECRET_KEY or CLERK_SECRET_KEY_FILE.");
  }
  const parties = clerkAuthorizedParties(env);
  if (parties.length === 0) {
    throw new Error("Clerk identity requires APP_PUBLIC_ORIGIN or CLERK_AUTHORIZED_PARTIES.");
  }
  if (env.NODE_ENV !== "production") return;

  if (!isProductionFromPublishableKey(publishableKey) || !isProductionFromSecretKey(secretKey)) {
    throw new Error("Production Clerk identity requires matching pk_live_ and sk_live_ credentials.");
  }
  if (isDevelopmentFromPublishableKey(publishableKey) || isDevelopmentFromSecretKey(secretKey)) {
    throw new Error("Clerk development credentials may not be used in production.");
  }
  const webhookSecret = clerkWebhookSigningSecret(env);
  if (!/^whsec_[A-Za-z0-9_-]{16,}$/.test(webhookSecret)) {
    throw new Error("Production Clerk identity requires CLERK_WEBHOOK_SIGNING_SECRET or CLERK_WEBHOOK_SIGNING_SECRET_FILE.");
  }
  const publicOrigin = String(env.APP_PUBLIC_ORIGIN || "").trim().replace(/\/+$/, "");
  if (!publicOrigin || !parties.includes(publicOrigin)) {
    throw new Error("Production APP_PUBLIC_ORIGIN must be included in Clerk authorized parties.");
  }
  if (configuredAdminEmails(env).size === 0 && configuredAdminUserIds(env).size === 0) {
    throw new Error("Production Clerk identity requires APP_AUTH_ADMIN_EMAILS or APP_CLERK_ADMIN_USER_IDS for administrator bootstrap.");
  }
}

export function requireAuthorizedClerkBrowserOrigin(value, env = process.env) {
  const browserOrigin = validateAuthorizedParty(String(value || "").trim());
  const authorizedParties = clerkAuthorizedParties(env);
  if (!authorizedParties.includes(browserOrigin)) {
    throw new Error(
      `Clerk will reject sessions from ${browserOrigin}. Set APP_PUBLIC_ORIGIN and CLERK_AUTHORIZED_PARTIES to this exact origin, then restart the server.`
    );
  }
  return browserOrigin;
}

export function createClerkAdapter({ env = process.env, client = null } = {}) {
  const enabled = clerkIdentityEnabled(env);
  if (!enabled) {
    return {
      enabled: false,
      client: null,
      middleware: (_req, _res, next) => next(),
      getAuth: () => ({ isAuthenticated: false, userId: null, sessionId: null }),
      verifyWebhook: async () => {
        throw identityError(404, "clerk_disabled", "Clerk identity is not enabled.");
      }
    };
  }
  validateClerkEnvironment(env);
  const publishableKey = clerkPublishableKey(env);
  const secretKey = clerkSecretKey(env);
  const resolvedClient = client || createClerkClient({ publishableKey, secretKey });
  const middleware = clerkMiddleware({
    authorizedParties: clerkAuthorizedParties(env),
    clerkClient: resolvedClient,
    publishableKey,
    secretKey
  });
  return {
    enabled: true,
    client: resolvedClient,
    middleware,
    getAuth,
    async verifyWebhook(request) {
      const signingSecret = clerkWebhookSigningSecret(env);
      if (!signingSecret) {
        throw identityError(503, "clerk_webhook_not_configured", "Clerk webhook verification is not configured.");
      }
      return verifyWebhook(request, { signingSecret });
    }
  };
}

export function createClerkIdentityManager({
  store,
  client,
  env = process.env,
  enabled = clerkIdentityEnabled(env)
} = {}) {
  if (!store) throw new TypeError("Clerk identity manager requires a store.");
  if (enabled && !client) throw new TypeError("Clerk identity manager requires a Clerk backend client.");
  const provisioning = new Map();
  const deletionInflight = new Map();
  const authenticatedRequests = new Map();

  function exactClerkOwner(data, actor, { missingClerkIsDeleted = true } = {}) {
    if (!actor?.user_id || !actor?.workspace_id) return null;
    const matches = (data.users || []).filter((user) => (
      user.user_id === actor.user_id
      && user.workspace_id === actor.workspace_id
      && Boolean(user.clerk_user_id)
      && (!actor.clerk_user_id || user.clerk_user_id === actor.clerk_user_id)
    ));
    if (matches.length === 0) {
      if (missingClerkIsDeleted && actor.auth_type === "clerk") {
        throw identityError(401, "account_deleted", "This Virenis account has been deleted.");
      }
      return null;
    }
    if (matches.length !== 1) {
      throw identityError(
        409,
        "account_legacy_scope_ambiguous",
        "Authenticated tenant coordinates match more than one Clerk identity. Repair the legacy identity collision before continuing."
      );
    }
    return matches[0];
  }

  function assertOwnerActive(user, { allowAccountDeletion = false, actor = null } = {}) {
    if (user.status === "deleting") {
      if (allowAccountDeletion && actor?.auth_type === "clerk") return;
      throw identityError(
        409,
        "account_deletion_in_progress",
        "Account deletion is in progress. Only the account deletion request may be retried."
      );
    }
    if (user.status !== "active") {
      throw identityError(403, "account_suspended", "This account has been suspended. Contact support.");
    }
  }

  function registerOwnerOperation(user, kind) {
    const requestId = makeId("identityreq");
    let releaseRequest;
    const settled = new Promise((resolve) => { releaseRequest = resolve; });
    const entry = {
      request_id: requestId,
      kind: String(kind || "authenticated_request").slice(0, 80),
      started_at: Date.now(),
      settled
    };
    const clerkUserId = user.clerk_user_id;
    const requests = authenticatedRequests.get(clerkUserId) || new Map();
    requests.set(requestId, entry);
    authenticatedRequests.set(clerkUserId, requests);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      requests.delete(requestId);
      if (requests.size === 0 && authenticatedRequests.get(clerkUserId) === requests) {
        authenticatedRequests.delete(clerkUserId);
      }
      releaseRequest();
    };
  }

  async function provision(clerkUserId) {
    const existingTask = provisioning.get(clerkUserId);
    if (existingTask) return existingTask;
    const task = client.users.getUser(clerkUserId)
      .then((user) => syncClerkUser(user, { event: "identity.clerk_user_provisioned" }))
      .finally(() => {
        if (provisioning.get(clerkUserId) === task) provisioning.delete(clerkUserId);
      });
    provisioning.set(clerkUserId, task);
    return task;
  }

  async function syncClerkUser(payload, { event = "identity.clerk_user_synced" } = {}) {
    if (!enabled) throw identityError(404, "clerk_disabled", "Clerk identity is not enabled.");
    const profile = normalizeClerkUser(payload);
    if (!profile.clerk_user_id) throw identityError(400, "invalid_clerk_user", "Clerk user payload is missing an id.");
    if (!profile.email) {
      throw identityError(422, "email_required", "Virenis requires a primary email address for every Clerk account.");
    }
    const timestamp = nowIso();
    return store.mutate((data) => {
      if ((data.identityDeletionTombstones || []).some((item) =>
        item.provider === "clerk" && item.provider_user_hash === hashClerkUserId(profile.clerk_user_id)
      )) return null;
      let user = data.users.find((candidate) => candidate.clerk_user_id === profile.clerk_user_id);
      if (!user) {
        const emailMatch = data.users.find((candidate) =>
          normalizeEmail(candidate.email_normalized || candidate.email, { required: false }) === profile.email
        );
        if (emailMatch?.clerk_user_id && emailMatch.clerk_user_id !== profile.clerk_user_id) {
          throw identityError(409, "identity_link_conflict", "This email is already linked to another Clerk identity.");
        }
        user = emailMatch || null;
      }
      if (user && data.users.some((candidate) =>
        candidate !== user
        && normalizeEmail(candidate.email_normalized || candidate.email, { required: false }) === profile.email
      )) {
        throw identityError(409, "identity_link_conflict", "This email is already linked to another Virenis identity.");
      }
      // A provider update may race an account-deletion retry or arrive out of
      // order after Clerk has accepted deletion. Deletion is a one-way local
      // state transition: only the deletion saga may advance it.
      if (user?.status === "deleting") return null;
      const isNew = !user;
      if (!user) {
        const administrator = configuredAdminUserIds(env).has(profile.clerk_user_id)
          || (profile.email_verified && configuredAdminEmails(env).has(profile.email));
        user = {
          user_id: profile.clerk_user_id,
          workspace_id: makeId("workspace"),
          role: administrator ? "admin" : "user",
          status: profile.banned ? "suspended" : "active",
          created_at: profile.created_at || timestamp
        };
        data.users.push(user);
        ensurePublisherPublicId(data, user.user_id, profile.display_name);
      }
      if (user.provider_updated_at && profile.updated_at
        && Date.parse(profile.updated_at) < Date.parse(user.provider_updated_at)) {
        return publicUser(user);
      }
      const previousRole = user.role;
      if (!isNew && !user.clerk_user_id && (
        configuredAdminUserIds(env).has(profile.clerk_user_id)
        || (profile.email_verified && configuredAdminEmails(env).has(profile.email))
      )) {
        user.role = "admin";
      }
      const changed = isNew
        || user.email !== profile.email
        || user.display_name !== profile.display_name
        || user.avatar_url !== profile.avatar_url
        || user.email_verified !== profile.email_verified
        || user.role !== previousRole
        || user.status !== (profile.banned ? "suspended" : "active");
      user.identity_provider = "clerk";
      user.clerk_user_id = profile.clerk_user_id;
      user.email = profile.email;
      user.email_normalized = profile.email;
      user.display_name = profile.display_name;
      user.avatar_url = profile.avatar_url;
      user.email_verified = profile.email_verified;
      user.email_verified_at = profile.email_verified ? (user.email_verified_at || timestamp) : null;
      user.status = profile.banned ? "suspended" : "active";
      user.provider_created_at = profile.created_at;
      user.provider_updated_at = profile.updated_at;
      user.updated_at = timestamp;
      user.last_login_at = profile.last_sign_in_at || user.last_login_at || null;
      scrubLegacyIdentityFields(user);
      for (const agent of data.agents || []) {
        if (agent.marketplace?.published_by === user.user_id) {
          agent.marketplace.publisher_display_name = user.display_name;
        }
      }
      for (const workspace of data.agentWorkspaces || []) {
        if (workspace.marketplace?.published_by === user.user_id) {
          workspace.marketplace.publisher_display_name = user.display_name;
        }
      }
      ensureGeneralAgentWorkspace(data, {
        user_id: user.user_id,
        workspace_id: user.workspace_id,
        role: user.role
      });
      if (changed) {
        appendIdentityAudit(data, {
          action: isNew ? "identity.clerk_account_linked" : event,
          target_user_id: user.user_id,
          actor_user_id: user.user_id,
          provider_user_id: user.clerk_user_id,
          at: timestamp
        });
      }
      return publicUser(user);
    });
  }

  return {
    enabled,
    publicConfig() {
      return {
        provider: enabled ? "clerk" : "configured",
        self_service_enabled: enabled,
        registration_enabled: enabled,
        email_verification_required: enabled,
        organizations_enabled: false
      };
    },

    async resolveAuthenticated(authState, { allowAccountDeletion = false } = {}) {
      if (!enabled || !authState?.isAuthenticated || !authState.userId) return null;
      let user = store.read((data) => data.users.find((candidate) => candidate.clerk_user_id === authState.userId));
      if (!user) {
        await provision(authState.userId);
        user = store.read((data) => data.users.find((candidate) => candidate.clerk_user_id === authState.userId));
      }
      if (!user) throw identityError(401, "identity_not_provisioned", "The Clerk account could not be linked to a Virenis workspace.");
      if (user.status === "deleting") {
        if (!allowAccountDeletion) {
          throw identityError(
            409,
            "account_deletion_in_progress",
            "Account deletion is in progress. Only the account deletion request may be retried."
          );
        }
      } else if (user.status !== "active") {
        throw identityError(403, "account_suspended", "This account has been suspended. Contact support.");
      }
      return actorFromUser(user, authState.sessionId);
    },

    async refreshAuthenticated(actor) {
      requireClerkActor(actor);
      const user = await client.users.getUser(actor.clerk_user_id);
      const synced = await syncClerkUser(user);
      if (!synced) throw identityError(401, "account_deleted", "This Virenis account has been deleted.");
      return actorFromUser(synced, actor.session_id);
    },

    syncClerkUser,

    /**
     * Register a request after authentication. Exact configured identities
     * are resolved to their local Clerk owner too. This deliberately does a
     * second synchronous status check so a request that authenticated just
     * before the deletion marker cannot slip past it unnoticed.
     */
    beginAuthenticatedRequest(actor, { allowAccountDeletion = false } = {}) {
      if (!actor?.user_id || !actor?.workspace_id) return () => undefined;
      const current = store.read((data) => exactClerkOwner(data, actor));
      if (!current) return () => undefined;
      assertOwnerActive(current, { allowAccountDeletion, actor });
      // The deletion request is coordinated separately and must not wait on
      // itself while draining requests that started before its marker.
      if (allowAccountDeletion && actor.auth_type === "clerk") return () => undefined;
      return registerOwnerOperation(current, "authenticated_request");
    },

    /**
     * Background work does not have an HTTP response whose lifetime can be
     * drained. Register it against the exact durable Clerk owner before the
     * first await, then recheck the same owner and deletion generation inside
     * every external-to-local commit. The deletion marker and this in-memory
     * registration are ordered synchronously in the single web process: work
     * is either visible to the deletion drain or rejected after the marker.
     */
    beginOwnerMutation(actor, { kind = "owner_mutation" } = {}) {
      if (!actor?.user_id || !actor?.workspace_id) {
        return {
          assertActiveInData: () => true,
          release: () => undefined
        };
      }
      const current = store.read((data) => exactClerkOwner(data, actor));
      if (!current) {
        return {
          assertActiveInData: () => true,
          release: () => undefined
        };
      }
      assertOwnerActive(current, { actor });
      const owner = {
        user_id: current.user_id,
        workspace_id: current.workspace_id,
        clerk_user_id: current.clerk_user_id,
        deletion_generation: String(current.deletion_id || "")
      };
      const release = registerOwnerOperation(current, kind);
      return {
        assertActiveInData(data) {
          const matches = (data.users || []).filter((user) => (
            user.user_id === owner.user_id
            && user.workspace_id === owner.workspace_id
            && user.clerk_user_id === owner.clerk_user_id
          ));
          if (
            matches.length !== 1
            || matches[0].status !== "active"
            || String(matches[0].deletion_id || "") !== owner.deletion_generation
          ) {
            throw identityError(
              409,
              "account_deletion_in_progress",
              "The resource owner changed or began account deletion before this background update could commit."
            );
          }
          return true;
        },
        release
      };
    },

    async drainAuthenticatedRequests(actor, { timeoutMs = deletionDrainTimeoutMs(env) } = {}) {
      requireClerkActor(actor);
      const pending = [...(authenticatedRequests.get(actor.clerk_user_id)?.values() || [])]
        .map((entry) => entry.settled);
      if (pending.length === 0) return { drained: true, pending: 0 };
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(identityError(
          503,
          "account_deletion_drain_timeout",
          "Account deletion is waiting for earlier requests to finish. Retry shortly; the deletion marker remains active."
        )), timeoutMs);
        timer.unref?.();
      });
      try {
        await Promise.race([Promise.allSettled(pending), timeout]);
      } finally {
        clearTimeout(timer);
      }
      return { drained: true, pending: pending.length };
    },

    runAccountDeletion(clerkUserId, operation) {
      const normalizedId = String(clerkUserId || "");
      if (!normalizedId) throw identityError(400, "invalid_clerk_user", "Clerk user id is required for deletion.");
      const existing = deletionInflight.get(normalizedId);
      if (existing) return existing;
      const task = Promise.resolve().then(operation);
      deletionInflight.set(normalizedId, task);
      return task.finally(() => {
        if (deletionInflight.get(normalizedId) === task) deletionInflight.delete(normalizedId);
      });
    },

    actorForClerkUserId(clerkUserId) {
      const user = store.read((data) => data.users.find((candidate) => candidate.clerk_user_id === clerkUserId));
      return user ? actorFromUser(user, null) : null;
    },

    pendingDocumentCleanupForClerkUserId(clerkUserId) {
      const providerUserHash = hashClerkUserId(clerkUserId);
      const tombstone = store.read((data) => (data.identityDeletionTombstones || []).find((item) => (
        item.provider === "clerk" && item.provider_user_hash === providerUserHash
      )));
      if (!tombstone || !Array.isArray(tombstone.pending_document_roots)) return null;
      return {
        deletion_id: tombstone.deletion_id || null,
        document_roots: [...tombstone.pending_document_roots]
      };
    },

    async completeDocumentCleanup(clerkUserId, deletionId) {
      const providerUserHash = hashClerkUserId(clerkUserId);
      return store.mutate((data) => {
        const tombstone = (data.identityDeletionTombstones || []).find((item) => (
          item.provider === "clerk" && item.provider_user_hash === providerUserHash
        ));
        if (!tombstone) return false;
        if (!deletionId || !timingSafeIdentityEqual(tombstone.deletion_id, deletionId)) {
          throw identityError(409, "account_deletion_changed", "Account deletion cleanup state changed.");
        }
        delete tombstone.pending_document_roots;
        tombstone.document_cleanup_completed_at = nowIso();
        return true;
      });
    },

    listAccountDeletionRecoveryCandidates({ limit = 25, at = Date.now() } = {}) {
      const maximum = Math.max(1, Math.min(Number(limit) || 25, 100));
      const data = store.read();
      const candidates = [];
      const activeHashes = new Set();
      for (const user of data.users || []) {
        if (user.status !== "deleting" || !user.clerk_user_id || !user.deletion_id) continue;
        const providerUserHash = hashClerkUserId(user.clerk_user_id);
        activeHashes.add(providerUserHash);
        if (Date.parse(user.deletion_recovery_next_at || "") > at) continue;
        candidates.push({
          kind: "account",
          provider_user_hash: providerUserHash,
          deletion_id: user.deletion_id,
          actor: actorFromUser(user, null),
          started_at: user.deletion_started_at || user.updated_at || user.created_at || null
        });
      }
      for (const tombstone of data.identityDeletionTombstones || []) {
        if (
          activeHashes.has(tombstone.provider_user_hash)
          || !Array.isArray(tombstone.pending_document_roots)
          || !tombstone.deletion_id
          || Date.parse(tombstone.deletion_recovery_next_at || "") > at
        ) continue;
        candidates.push({
          kind: "document_cleanup",
          provider_user_hash: tombstone.provider_user_hash,
          deletion_id: tombstone.deletion_id,
          document_roots: [...tombstone.pending_document_roots],
          started_at: tombstone.deletion_started_at || tombstone.deleted_at || null
        });
      }
      return candidates
        .sort((left, right) => Date.parse(left.started_at || 0) - Date.parse(right.started_at || 0))
        .slice(0, maximum);
    },

    async completeDocumentCleanupByTombstone(providerUserHash, deletionId) {
      return store.mutate((data) => {
        const tombstone = (data.identityDeletionTombstones || []).find((item) => (
          item.provider === "clerk" && item.provider_user_hash === providerUserHash
        ));
        if (!tombstone) return false;
        if (!deletionId || !timingSafeIdentityEqual(tombstone.deletion_id, deletionId)) {
          throw identityError(409, "account_deletion_changed", "Account deletion cleanup state changed.");
        }
        delete tombstone.pending_document_roots;
        tombstone.document_cleanup_completed_at = nowIso();
        return true;
      });
    },

    async recordAccountDeletionRecovery(candidate, { error = null } = {}) {
      return store.mutate((data) => {
        const user = candidate?.actor?.clerk_user_id
          ? (data.users || []).find((item) => item.clerk_user_id === candidate.actor.clerk_user_id)
          : null;
        const tombstone = (data.identityDeletionTombstones || []).find((item) => (
          item.provider === "clerk" && item.provider_user_hash === candidate?.provider_user_hash
        ));
        const target = user || tombstone;
        if (!target || !timingSafeIdentityEqual(target.deletion_id, candidate?.deletion_id)) return false;
        if (!error) {
          delete target.deletion_recovery_attempts;
          delete target.deletion_recovery_last_attempt_at;
          delete target.deletion_recovery_last_error_code;
          delete target.deletion_recovery_next_at;
          return true;
        }
        const attempts = Math.max(0, Number(target.deletion_recovery_attempts) || 0) + 1;
        const delayMs = Math.min(60 * 60 * 1000, 5_000 * (2 ** Math.min(attempts - 1, 9)));
        target.deletion_recovery_attempts = attempts;
        target.deletion_recovery_last_attempt_at = nowIso();
        target.deletion_recovery_last_error_code = String(error?.code || "account_deletion_recovery_failed").slice(0, 120);
        target.deletion_recovery_next_at = new Date(Date.now() + delayMs).toISOString();
        return true;
      });
    },

    exportAccount(actor) {
      const data = store.read();
      const user = registeredUserForActor(data, actor);
      if (!user) throw identityError(404, "account_not_found", "Registered account not found.");
      return buildAccountExport(data, user);
    },

    validateAccountDeletionConfirmation(actor, body = {}) {
      requireClerkActor(actor);
      if (String(body.confirmation || "") !== "DELETE") {
        throw identityError(400, "confirmation_required", "Type DELETE exactly to confirm account deletion.");
      }
      return true;
    },

    async beginAccountDeletion(actor, { providerInitiated = false } = {}) {
      requireClerkActor(actor);
      return store.mutate((data) => {
        const user = registeredUserForActor(data, actor);
        if (!user) throw identityError(404, "account_not_found", "Registered account not found.");
        const resuming = user.status === "deleting";
        if (!providerInitiated && !resuming && user.role === "admin" && activeRegisteredAdmins(data).length <= 1) {
          throw identityError(409, "last_admin", "The last active administrator cannot delete their account.");
        }
        if (!providerInitiated && !resuming && user.status !== "active") {
          throw identityError(403, "account_suspended", "This account has been suspended. Contact support.");
        }
        const accountGraph = buildAccountResourceGraph(data, user);
        const ambiguousCount = accountGraphAmbiguousCount(accountGraph);
        if (ambiguousCount > 0) {
          throw identityError(
            409,
            "account_legacy_scope_ambiguous",
            `Account deletion is blocked because ${ambiguousCount} legacy ${ambiguousCount === 1 ? "record has" : "records have"} ambiguous tenant ownership. Ask an administrator to repair or remove the quarantined records, then try again.`
          );
        }
        const now = nowIso();
        if (!resuming) {
          user.status = "deleting";
          user.deletion_started_at = now;
          user.deletion_id = makeId("deletion");
          user.deletion_external_purges = [];
          user.updated_at = now;
          appendIdentityAudit(data, {
            action: providerInitiated
              ? "identity.clerk_account_deletion_started_by_provider"
              : "identity.clerk_account_deletion_started",
            target_user_id: user.user_id,
            actor_user_id: user.user_id,
            deletion_id: user.deletion_id,
            at: now
          });
        }
        upsertDeletionTombstone(data, user, {
          deletionId: user.deletion_id,
          deletionStartedAt: user.deletion_started_at || now,
          status: "deleting"
        });
        // Pending callbacks are unauthenticated browser redirects. Moving the
        // state out of pending/exchanging makes their credential commit fail
        // atomically; an already-exchanged credential is revoked in mcp.js.
        for (const state of accountGraph.mcpOauthStates.records) {
          if (["pending", "exchanging", "refreshing", "disconnect_cancelled", "superseded"].includes(state.status)) {
            state.failed_at = now;
            if (state.revocation_envelope) {
              state.status = "revocation_pending";
              state.revocation_queued_at ||= now;
            } else if (state.exchange_started_at || state.refresh_started_at) {
              // A provider request may already be on the wire. The callback
              // will stage and queue any credential it receives.
              state.status = "account_deleting";
            } else {
              // No code exchange began, so invalidating the browser state is
              // sufficient and must not leave deletion blocked forever.
              state.status = "cancelled";
            }
            delete state.verifier_envelope;
          }
        }
        for (const account of accountGraph.billingAccounts.records) {
          account.status = "closing";
          account.updated_at = now;
        }
        return {
          deletion_id: user.deletion_id,
          deletion_started_at: user.deletion_started_at,
          resumed: resuming
        };
      });
    },

    async prepareAccountDeletion(actor, deletionId) {
      requireClerkActor(actor);
      return store.mutate((data) => {
        const user = registeredUserForActor(data, actor);
        assertDeletingUser(user, deletionId);
        const graph = buildAccountResourceGraph(data, user);
        const ambiguousCount = accountGraphAmbiguousCount(graph);
        if (ambiguousCount > 0) {
          throw identityError(
            409,
            "account_legacy_scope_ambiguous",
            `Account deletion is blocked because ${ambiguousCount} legacy ${ambiguousCount === 1 ? "record has" : "records have"} ambiguous tenant ownership.`
          );
        }
        if (
          graph.billingReservations.records.some((reservation) => reservation.status === "active")
          || graph.runs.records.some((run) => ACTIVE_RUN_STATUSES.has(run.status))
        ) {
          throw identityError(
            409,
            "account_has_active_runs",
            "Wait for active requests to finish, then retry account deletion. The deletion marker remains active."
          );
        }
        if (hasUnresolvedAccountOAuth(graph)) {
          throw identityError(
            409,
            "account_oauth_revocation_unresolved",
            "An OAuth exchange or revocation is unresolved. Retry shortly; persistent failures require provider deauthorization or operator remediation."
          );
        }
        const resources = accountOwnedResources(data, user, graph);
        return {
          ...resources,
          deletion_id: user.deletion_id,
          resource_revision: deletionResourceRevision(resources),
          completed_external_purges: [...(user.deletion_external_purges || [])]
        };
      });
    },

    async markDeletionExternalPurge(actor, deletionId, purgeKey) {
      requireClerkActor(actor);
      const key = String(purgeKey || "").slice(0, 512);
      if (!key) throw identityError(400, "deletion_purge_key_required", "Deletion purge receipt key is required.");
      return store.mutate((data) => {
        const user = registeredUserForActor(data, actor);
        assertDeletingUser(user, deletionId);
        user.deletion_external_purges ||= [];
        if (!user.deletion_external_purges.includes(key)) {
          if (user.deletion_external_purges.length >= MAX_DELETION_PURGE_RECEIPTS) {
            throw identityError(503, "account_deletion_purge_limit", "Account deletion has too many external purge receipts. Contact support.");
          }
          user.deletion_external_purges.push(key);
          user.updated_at = nowIso();
        }
        return true;
      });
    },

    resourcesForActor(actor) {
      const data = store.read();
      const user = registeredUserForActor(data, actor);
      return user ? accountOwnedResources(data, user) : null;
    },

    async deleteProviderAccount(actor) {
      requireClerkActor(actor);
      try {
        await client.users.deleteUser(actor.clerk_user_id);
        return { ok: true, already_deleted: false };
      } catch (error) {
        if (Number(error?.status || error?.statusCode) === 404) {
          return { ok: true, already_deleted: true };
        }
        throw error;
      }
    },

    async deleteAccount(actor, { deletionId, resourceRevision } = {}) {
      return store.mutate((data) => {
        const user = registeredUserForActor(data, actor);
        if (!user) return null;
        assertDeletingUser(user, deletionId);
        const accountGraph = buildAccountResourceGraph(data, user);
        const ambiguousCount = accountGraphAmbiguousCount(accountGraph);
        if (ambiguousCount > 0) {
          throw identityError(
            409,
            "account_legacy_scope_ambiguous",
            `Account deletion is blocked because ${ambiguousCount} legacy ${ambiguousCount === 1 ? "record has" : "records have"} ambiguous tenant ownership.`
          );
        }
        if (
          accountGraph.billingReservations.records.some((reservation) => reservation.status === "active")
          || accountGraph.runs.records.some((run) => ACTIVE_RUN_STATUSES.has(run.status))
        ) {
          throw identityError(
            409,
            "account_has_active_runs",
            "Wait for active requests to finish before deleting this account."
          );
        }
        if (hasUnresolvedAccountOAuth(accountGraph)) {
          throw identityError(
            409,
            "account_oauth_revocation_unresolved",
            "An OAuth exchange or revocation is unresolved. Account deletion remains fail-closed."
          );
        }
        const currentResources = accountOwnedResources(data, user, accountGraph);
        const currentRevision = deletionResourceRevision(currentResources);
        if (!resourceRevision || currentRevision !== resourceRevision) {
          throw identityError(
            503,
            "account_deletion_resource_changed",
            "Account resources changed during deletion. Retry so the fresh resource set can be purged safely."
          );
        }
        if (!(user.deletion_external_purges || []).includes(`snapshot:${currentRevision}`)) {
          throw identityError(
            503,
            "account_deletion_purge_incomplete",
            "External account resources have not finished purging. Retry account deletion."
          );
        }
        const providerUserHash = hashClerkUserId(user.clerk_user_id);
        const pendingDocumentRoots = accountGraph.documents.records
          .map((item) => String(item.document_root || ""))
          .filter(Boolean);
        const result = deleteAccountData(data, user);
        upsertDeletionTombstone(data, { clerk_user_id: actor.clerk_user_id }, {
          providerUserHash,
          deletionId,
          deletionStartedAt: user.deletion_started_at,
          status: "deleted",
          deletedAt: nowIso(),
          pendingDocumentRoots
        });
        return result;
      });
    },

    listUsers(actor) {
      requireIdentityAdmin(actor);
      const data = store.read();
      return {
        users: data.users
          .filter((user) => user.identity_provider === "clerk" || user.clerk_user_id)
          .map((user) => ({ ...publicUser(user), active_sessions: null }))
          .sort((left, right) => String(left.email).localeCompare(String(right.email)))
      };
    },

    async updateUser(actor, userId, patch = {}) {
      requireIdentityAdmin(actor);
      const snapshot = store.read();
      const user = snapshot.users.find((candidate) => candidate.user_id === userId);
      if (!user?.clerk_user_id) throw identityError(404, "user_not_found", "Clerk user not found.");
      if (user.status === "deleting") {
        throw identityError(
          409,
          "account_deletion_in_progress",
          "This account is being deleted and cannot be reactivated or changed. Retry the deletion instead."
        );
      }
      const nextRole = patch.role === undefined ? user.role : normalizeRole(patch.role);
      const nextStatus = patch.status === undefined ? user.status : normalizeStatus(patch.status);
      if (user.user_id === actor.user_id && (nextRole !== "admin" || nextStatus !== "active")) {
        throw identityError(409, "self_admin_change", "You cannot demote or suspend your current administrator session.");
      }
      if (user.role === "admin" && (nextRole !== "admin" || nextStatus !== "active") && activeRegisteredAdmins(snapshot).length <= 1) {
        throw identityError(409, "last_admin", "The last active administrator cannot be demoted or suspended.");
      }

      if (nextStatus !== user.status) {
        if (nextStatus === "suspended") await client.users.banUser(user.clerk_user_id);
        else await client.users.unbanUser(user.clerk_user_id);
      }
      if (nextRole !== user.role && nextStatus !== "suspended") {
        await revokeClerkSessions(client, user.clerk_user_id);
      }
      await client.users.updateUserMetadata(user.clerk_user_id, {
        privateMetadata: {
          virenis: {
            role: nextRole,
            workspaceId: user.workspace_id
          }
        }
      });

      const timestamp = nowIso();
      return store.mutate((data) => {
        const current = data.users.find((candidate) => candidate.user_id === userId);
        if (!current) throw identityError(404, "user_not_found", "Clerk user not found.");
        if (current.status === "deleting") {
          throw identityError(
            409,
            "account_deletion_in_progress",
            "This account is being deleted and cannot be reactivated or changed. Retry the deletion instead."
          );
        }
        if (current.role === "admin" && (nextRole !== "admin" || nextStatus !== "active") && activeRegisteredAdmins(data).length <= 1) {
          throw identityError(409, "last_admin", "The last active administrator cannot be demoted or suspended.");
        }
        current.role = nextRole;
        current.status = nextStatus;
        current.updated_at = timestamp;
        appendIdentityAudit(data, {
          action: "identity.clerk_user_updated_by_admin",
          target_user_id: current.user_id,
          actor_user_id: actor.user_id,
          role: current.role,
          status: current.status,
          at: timestamp
        });
        return { user: publicUser(current) };
      });
    },

    async adminRevokeSessions(actor, userId) {
      requireIdentityAdmin(actor);
      const user = store.read((data) => data.users.find((candidate) => candidate.user_id === userId));
      if (!user?.clerk_user_id) throw identityError(404, "user_not_found", "Clerk user not found.");
      const revoked = await revokeClerkSessions(client, user.clerk_user_id);
      await store.mutate((data) => {
        appendIdentityAudit(data, {
          action: "identity.clerk_sessions_revoked_by_admin",
          target_user_id: user.user_id,
          actor_user_id: actor.user_id,
          revoked_count: revoked,
          at: nowIso()
        });
        return null;
      });
      return { ok: true, revoked };
    }
  };
}

async function revokeClerkSessions(client, clerkUserId) {
  const response = await client.sessions.getSessionList({ userId: clerkUserId, status: "active", limit: 500 });
  let revoked = 0;
  for (const session of response.data || []) {
    try {
      await client.sessions.revokeSession(session.id);
      revoked += 1;
    } catch (error) {
      if (Number(error?.status || error?.statusCode) !== 404) throw error;
    }
  }
  return revoked;
}

function normalizeClerkUser(payload = {}) {
  const clerkUserId = boundedText(payload.id, 128);
  const primaryEmailId = payload.primaryEmailAddressId || payload.primary_email_address_id;
  const emailAddresses = payload.emailAddresses || payload.email_addresses || [];
  const primary = emailAddresses.find((entry) => (entry.id || entry.email_address_id) === primaryEmailId)
    || emailAddresses[0]
    || payload.primaryEmailAddress
    || null;
  const email = normalizeEmail(primary?.emailAddress || primary?.email_address, { required: false });
  const firstName = boundedText(payload.firstName ?? payload.first_name, 80);
  const lastName = boundedText(payload.lastName ?? payload.last_name, 80);
  const username = boundedText(payload.username, 80);
  const displayName = boundedText(
    payload.fullName || payload.full_name || [firstName, lastName].filter(Boolean).join(" ") || username || email.split("@")[0] || "Virenis user",
    DISPLAY_NAME_MAX_CHARS
  );
  const verificationStatus = String(primary?.verification?.status || primary?.verification_status || "").toLowerCase();
  return {
    clerk_user_id: clerkUserId,
    email,
    display_name: displayName,
    avatar_url: boundedText(payload.imageUrl ?? payload.image_url, 2000) || null,
    email_verified: verificationStatus === "verified" || verificationStatus === "complete",
    banned: payload.banned === true,
    created_at: timestampToIso(payload.createdAt ?? payload.created_at),
    updated_at: timestampToIso(payload.updatedAt ?? payload.updated_at),
    last_sign_in_at: timestampToIso(payload.lastSignInAt ?? payload.last_sign_in_at)
  };
}

function actorFromUser(user, sessionId) {
  return {
    user_id: user.user_id,
    workspace_id: user.workspace_id,
    clerk_user_id: user.clerk_user_id,
    email: user.email,
    display_name: user.display_name,
    avatar_url: user.avatar_url || null,
    email_verified: Boolean(user.email_verified),
    role: VALID_ROLES.has(user.role) ? user.role : "user",
    auth_type: "clerk",
    session_id: sessionId || null
  };
}

function publicUser(user) {
  return {
    user_id: user.user_id,
    workspace_id: user.workspace_id,
    clerk_user_id: user.clerk_user_id || null,
    email: user.email,
    display_name: user.display_name,
    avatar_url: user.avatar_url || null,
    role: VALID_ROLES.has(user.role) ? user.role : "user",
    status: VALID_STATUSES.has(user.status) ? user.status : "active",
    email_verified: Boolean(user.email_verified),
    email_verified_at: user.email_verified_at || null,
    created_at: user.created_at,
    updated_at: user.updated_at,
    last_login_at: user.last_login_at || null,
    identity_provider: user.identity_provider || (user.clerk_user_id ? "clerk" : "configured")
  };
}

function tenantScopeStatus(item, user) {
  const workspaceId = String(item?.workspace_id || "");
  const owners = [item?.created_by, item?.user_id, item?.actor_user_id]
    .filter((value) => value !== undefined && value !== null && String(value) !== "")
    .map(String);
  if (!workspaceId) {
    if (owners.length === 0) return "unscoped";
    if (owners.some((owner) => owner !== String(user.user_id || ""))) return "foreign";
    return user.user_identity_collision === true ? "owner_ambiguous" : "owned";
  }
  if (workspaceId !== String(user.workspace_id || "")) return "foreign";
  if (owners.length > 0) {
    if (owners.some((owner) => owner !== String(user.user_id || ""))) return "foreign";
    return user.workspace_identity_collision === true && user.user_identity_collision === true
      ? "scope_ambiguous"
      : "owned";
  }
  return user.workspace_identity_collision === true ? "workspace_ambiguous" : "owned";
}

function relationOwnership(item, relation) {
  const value = item?.[relation.record_field];
  if (value === undefined || value === null || String(value) === "") return "none";
  const matches = (relation.records || []).filter((candidate) => (
    String(candidate?.[relation.parent_field]) === String(value)
  ));
  if (matches.length === 0) return "none";
  const selected = relation.selected instanceof Set
    ? relation.selected
    : new Set(relation.selected || []);
  const ownedCount = matches.filter((candidate) => selected.has(candidate)).length;
  if (ownedCount === matches.length) return "owned";
  if (ownedCount === 0) return "foreign";
  return "ambiguous";
}

function selectTenantCollection(records, user, relations = []) {
  const selected = [];
  const quarantined = [];
  for (const item of records || []) {
    if (item?.identity_scope_quarantine_admin_only?.reason === "ambiguous_legacy_tenant_reference") {
      quarantined.push(item);
      continue;
    }
    const scope = tenantScopeStatus(item, user);
    if (scope === "owned") {
      selected.push(item);
      continue;
    }
    if (scope === "foreign") continue;
    const statuses = relations.map((relation) => relationOwnership(item, relation));
    const hasOwnedProof = statuses.includes("owned");
    const hasForeignContradiction = statuses.includes("foreign");
    const hasAmbiguity = statuses.includes("ambiguous");
    if (hasOwnedProof && !hasForeignContradiction) {
      selected.push(item);
    } else if (
      scope === "workspace_ambiguous"
      || scope === "owner_ambiguous"
      || scope === "scope_ambiguous"
      || hasAmbiguity
      || (hasOwnedProof && hasForeignContradiction)
    ) {
      quarantined.push(item);
    }
  }
  return { records: selected, selected: new Set(selected), quarantined };
}

function relation(recordField, records, selected, parentField) {
  return {
    record_field: recordField,
    records,
    selected,
    parent_field: parentField
  };
}

function buildAccountResourceGraph(data, user) {
  const ambiguous = {};
  const collidingWorkspaceUsers = (data.users || []).filter((candidate) => (
    candidate !== user
    && candidate.status !== "deleted"
    && String(candidate.workspace_id || "") === String(user.workspace_id || "")
  ));
  const tenantUser = {
    ...user,
    workspace_identity_collision: collidingWorkspaceUsers.length > 0,
    user_identity_collision: (data.users || []).some((candidate) => (
      candidate !== user
      && candidate.status !== "deleted"
      && String(candidate.user_id || "") === String(user.user_id || "")
    ))
  };
  if (collidingWorkspaceUsers.length > 0) {
    ambiguous.workspace_identity_collision = collidingWorkspaceUsers.length;
  }
  if (tenantUser.user_identity_collision) {
    ambiguous.user_identity_collision = (data.users || []).filter((candidate) => (
      candidate !== user
      && candidate.status !== "deleted"
      && String(candidate.user_id || "") === String(user.user_id || "")
    )).length;
  }
  const collect = (name, records, relations = []) => {
    const result = selectTenantCollection(records, tenantUser, relations);
    if (result.quarantined.length > 0) {
      ambiguous[name] = Number(ambiguous[name] || 0) + result.quarantined.length;
    }
    return result;
  };

  const billingAccounts = collect("billing_accounts", data.billingAccounts || []);
  const workspaceModelSettings = collect("workspace_model_settings", data.workspaceModelSettings || []);
  const sessions = collect("chat_sessions", data.sessions || []);
  const agents = collect("agents", data.agents || []);
  const documents = collect("documents", data.documents || []);
  const agentWorkspaces = collect("agent_workspaces", data.agentWorkspaces || []);
  const mcpConnections = collect("mcp_connections", data.mcpConnections || []);
  const runs = collect("runs", data.runs || [], [
    relation("session_id", data.sessions || [], sessions.selected, "session_id")
  ]);
  const workflows = collect("workflows", data.workflows || [], [
    relation("session_id", data.sessions || [], sessions.selected, "session_id")
  ]);
  const checkpoints = collect("conversation_checkpoints", data.conversationCheckpoints || [], [
    relation("workflow_id", data.workflows || [], workflows.selected, "workflow_id"),
    relation("session_id", data.sessions || [], sessions.selected, "session_id")
  ]);
  const messages = collect("messages", data.messages || [], [
    relation("session_id", data.sessions || [], sessions.selected, "session_id"),
    relation("run_id", data.runs || [], runs.selected, "run_id"),
    relation("message_id", data.runs || [], runs.selected, "user_message_id"),
    relation("message_id", data.runs || [], runs.selected, "assistant_message_id"),
    relation("workflow_id", data.workflows || [], workflows.selected, "workflow_id"),
    relation("checkpoint_id", data.conversationCheckpoints || [], checkpoints.selected, "checkpoint_id")
  ]);
  const runSteps = collect("run_steps", data.runSteps || [], [
    relation("run_id", data.runs || [], runs.selected, "run_id")
  ]);
  const executions = collect("executions", data.executionRecords || [], [
    relation("run_id", data.runs || [], runs.selected, "run_id")
  ]);
  const worldGraphArtifacts = collect("world_graph_artifacts", data.worldGraphArtifacts || [], [
    relation("origin_run_id", data.runs || [], runs.selected, "run_id")
  ]);
  const worldGraphEvents = collect("world_graph_events", data.worldGraphEvents || [], [
    relation("run_id", data.runs || [], runs.selected, "run_id")
  ]);
  const outcomeContracts = collect("outcome_contracts", data.outcomeContracts || [], [
    relation("run_id", data.runs || [], runs.selected, "run_id")
  ]);
  const agentEvents = collect("agent_events", data.agentEvents || [], [
    relation("agent_id", data.agents || [], agents.selected, "id")
  ]);
  const runtimeLifecycleIntents = collect("runtime_lifecycle_intents", data.runtimeLifecycleIntents || [], [
    relation("agent_id", data.agents || [], agents.selected, "id"),
    relation("document_id", data.documents || [], documents.selected, "document_id")
  ]);
  const validationRuns = collect("validation_runs", data.validationRuns || []);
  const billingLedgerEntries = collect("billing_ledger_entries", data.billingLedgerEntries || [], [
    relation("account_id", data.billingAccounts || [], billingAccounts.selected, "account_id")
  ]);
  const billingReservations = collect("billing_reservations", data.billingReservations || [], [
    relation("account_id", data.billingAccounts || [], billingAccounts.selected, "account_id"),
    relation("run_id", data.runs || [], runs.selected, "run_id")
  ]);
  const billingUsageRecords = collect("billing_usage_records", data.billingUsageRecords || [], [
    relation("account_id", data.billingAccounts || [], billingAccounts.selected, "account_id"),
    relation("run_id", data.runs || [], runs.selected, "run_id")
  ]);
  const billingFundingEvents = collect("billing_funding_events", data.billingFundingEvents || [], [
    relation("account_id", data.billingAccounts || [], billingAccounts.selected, "account_id")
  ]);
  const mcpOauthClients = collect("mcp_oauth_clients", data.mcpOauthClients || []);
  const mcpOauthStates = collect("mcp_oauth_states", data.mcpOauthStates || [], [
    relation("connection_id", data.mcpConnections || [], mcpConnections.selected, "connection_id")
  ]);
  const mcpApprovals = collect("mcp_approvals", data.mcpApprovals || [], [
    relation("connection_id", data.mcpConnections || [], mcpConnections.selected, "connection_id"),
    relation("run_id", data.runs || [], runs.selected, "run_id")
  ]);
  const mcpToolCalls = collect("mcp_tool_calls", data.mcpToolCalls || [], [
    relation("connection_id", data.mcpConnections || [], mcpConnections.selected, "connection_id"),
    relation("run_id", data.runs || [], runs.selected, "run_id")
  ]);
  const matchingIdentityEvents = (data.identityAuditEvents || []).filter((item) => (
    item.target_user_id === user.user_id || item.actor_user_id === user.user_id
  ));
  const identityEvents = tenantUser.user_identity_collision ? [] : matchingIdentityEvents;
  if (tenantUser.user_identity_collision && matchingIdentityEvents.length > 0) {
    ambiguous.identity_audit_events = matchingIdentityEvents.length;
  }

  const marketplaceRatingRecords = collect("marketplace_ratings", data.marketplaceRatings || []);
  const agentWorkspaceRatingRecords = collect("agent_workspace_ratings", data.agentWorkspaceRatings || []);
  const marketplaceRatings = marketplaceRatingRecords.records;
  const agentWorkspaceRatings = agentWorkspaceRatingRecords.records;
  // Nested marketplace IDs need explicit readers rather than relationOwnership's
  // flat parent-field lookup.
  const uniquelyReferencesOwnedListing = (rating, parents, selected, kind) => {
    const matches = parents.filter((parent) => parent.marketplace?.listing_id === rating.listing_id);
    if (matches.length === 0) return false;
    const ownedCount = matches.filter((parent) => selected.has(parent)).length;
    if (ownedCount > 0 && ownedCount < matches.length) {
      ambiguous[`${kind}_ratings`] = Number(ambiguous[`${kind}_ratings`] || 0) + 1;
      return false;
    }
    return ownedCount === matches.length;
  };
  const marketplaceRatingsToDelete = [...new Set([
    ...marketplaceRatings,
    ...(data.marketplaceRatings || []).filter((rating) => uniquelyReferencesOwnedListing(
      rating,
      data.agents || [],
      agents.selected,
      "marketplace"
    ))
  ])];
  const agentWorkspaceRatingsToDelete = [...new Set([
    ...agentWorkspaceRatings,
    ...(data.agentWorkspaceRatings || []).filter((rating) => uniquelyReferencesOwnedListing(
      rating,
      data.agentWorkspaces || [],
      agentWorkspaces.selected,
      "agent_workspace"
    ))
  ])];

  return {
    billingAccounts,
    workspaceModelSettings,
    billingLedgerEntries,
    billingReservations,
    billingUsageRecords,
    billingFundingEvents,
    sessions,
    messages,
    runs,
    runSteps,
    agents,
    agentEvents,
    documents,
    agentWorkspaces,
    workflows,
    checkpoints,
    executions,
    worldGraphArtifacts,
    worldGraphEvents,
    outcomeContracts,
    runtimeLifecycleIntents,
    validationRuns,
    marketplaceRatings,
    marketplaceRatingsToDelete,
    agentWorkspaceRatings,
    agentWorkspaceRatingsToDelete,
    mcpConnections,
    mcpOauthClients,
    mcpOauthStates,
    mcpApprovals,
    mcpToolCalls,
    identityEvents,
    ambiguous
  };
}

function accountGraphAmbiguousCount(graph) {
  return Object.values(graph?.ambiguous || {}).reduce((sum, count) => sum + Number(count || 0), 0);
}

function hasUnresolvedAccountOAuth(graph) {
  return (graph?.mcpOauthStates?.records || []).some((state) => (
    ["exchanging", "refreshing", "account_deleting", "disconnect_cancelled", "exchange_outcome_uncertain", "refresh_outcome_uncertain"].includes(state.status)
    || (state.status === "revocation_pending" && !state.revocation_envelope)
  ));
}

function safeAccountExportRun(run) {
  const {
    expert_outputs: _expertOutputs,
    runtime_result_admin_only: _runtimeResult,
    error_admin_only: _error,
    ...safe
  } = run || {};
  return stripPrivateExecutionFields(safe);
}

function safeAccountExportRunStep(step) {
  const {
    agent_reasoning: _reasoning,
    raw_text_admin_only: _rawText,
    prompt_preview_admin_only: _promptPreview,
    model_calls_admin_only: _modelCalls,
    execution_error_admin_only: _executionError,
    approved_sources: _approvedSources,
    ...safe
  } = step || {};
  return stripPrivateExecutionFields(safe);
}

function stripPrivateExecutionFields(value) {
  if (Array.isArray(value)) return value.map(stripPrivateExecutionFields);
  if (!value || typeof value !== "object") return value;
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (
      key.endsWith("_admin_only")
      || ["agent_reasoning", "approved_sources", "expert_outputs", "model_calls", "prompt_preview"].includes(key)
    ) continue;
    result[key] = stripPrivateExecutionFields(child);
  }
  return result;
}

function buildAccountExport(data, user) {
  const workspaceId = user.workspace_id;
  const userId = user.user_id;
  const graph = buildAccountResourceGraph(data, user);
  return stripSecrets(stripPrivateExecutionFields({
    export_version: 3,
    exported_at: nowIso(),
    retention_note: "Content-free provenance receipts and minimized normalized billing records may be retained under documented security, accounting, tax, payment-reconciliation, fraud-prevention, chargeback, or legal-hold obligations. They contain workspace-scoped pseudonyms, digests, and necessary accounting facts; they are not anonymous and are not included in this JSON export. Legacy normalized databases require approved privacy migration and cross-tenant administrator inventory.",
    retained_provenance: {
      projection: "virenis-ledger-content-free-v1",
      included_in_export: false,
      identity_form: "workspace-scoped pseudonyms",
      payload_form: "digests only",
      anonymous: false,
      operator_inventory_required: true,
      legacy_migration_status: "unknown until administrator inventory; migration is required only if legacy rows are found"
    },
    retained_billing: {
      projection: "virenis-billing-minimized-v1",
      included_in_export: false,
      identity_form: "opaque tenant partition key plus workspace-scoped pseudonyms and SHA-256 digests",
      retained_partition_keys: "raw workspace_id and global pricing-version IDs; deployments must keep these opaque and non-personal",
      retained_facts: "recorded amounts, balances, transaction status/timestamps, provider name, pricing facts, aggregate usage, and integrity hashes; aggregates are not an independent repricing dataset",
      raw_fields_excluded: "raw user/account/run/ledger/provider-event identifiers, agent/step/model labels, and free-form metadata",
      retention_basis: "operator policy and legal basis are required; normalized-ledger expiry is not enforced by the application",
      anonymous: false,
      operator_inventory_required: true,
      legacy_migration_status: "unknown until administrator inventory; migration is required only if legacy rows are found"
    },
    privacy_filter: {
      schema_version: "tenant-qualified-export-v1",
      ambiguous_legacy_records_omitted: accountGraphAmbiguousCount(graph),
      omitted_by_collection: graph.ambiguous
    },
    account: publicUser(user),
    billing: {
      accounts: graph.billingAccounts.records,
      ledger_entries: graph.billingLedgerEntries.records,
      reservations: graph.billingReservations.records,
      usage_records: graph.billingUsageRecords.records,
      funding_events: graph.billingFundingEvents.records
    },
    workspace: { workspace_id: workspaceId, owner_user_id: userId },
    model_settings: graph.workspaceModelSettings.records,
    identity_events: graph.identityEvents,
    authentication: { provider: "clerk", provider_user_id: user.clerk_user_id },
    chats: {
      sessions: graph.sessions.records,
      messages: graph.messages.records,
      runs: graph.runs.records.map(safeAccountExportRun),
      run_steps: graph.runSteps.records.map(safeAccountExportRunStep)
    },
    agents: graph.agents.records.map((agent) => {
      const { workflow_registration_anchor: _workflowRegistrationAnchor, ...safeAgent } = agent;
      return safeAgent;
    }),
    agent_events: graph.agentEvents.records,
    documents: graph.documents.records,
    agent_workspaces: graph.agentWorkspaces.records,
    workflows: graph.workflows.records,
    conversation_checkpoints: graph.checkpoints.records,
    validation_runs: graph.validationRuns.records,
    executions: graph.executions.records,
    world_graph: {
      artifacts: graph.worldGraphArtifacts.records,
      events: graph.worldGraphEvents.records
    },
    outcome_contracts: graph.outcomeContracts.records,
    marketplace_ratings: graph.marketplaceRatings,
    agent_workspace_ratings: graph.agentWorkspaceRatings,
    mcp: {
      connections: graph.mcpConnections.records,
      approvals: graph.mcpApprovals.records,
      tool_calls: graph.mcpToolCalls.records
    }
  }));
}

function deleteAccountData(data, user) {
  const { user_id: userId, workspace_id: workspaceId } = user;
  const graph = buildAccountResourceGraph(data, user);
  const ownedMarketplaceSubjects = [
    ...(graph.agents?.records || []),
    ...(graph.agentWorkspaces?.records || [])
  ].filter((item) => item?.marketplace && typeof item.marketplace === "object");
  scrubDeletedPublisherReferences(data, {
    ownerId: userId,
    publisherIds: [
      user.public_publisher_id,
      ...ownedMarketplaceSubjects.map((item) => item.marketplace.publisher_id)
    ].filter(Boolean),
    listingIds: ownedMarketplaceSubjects.map((item) => item.marketplace.listing_id).filter(Boolean)
  });
  const removeExact = (collection, selection) => {
    const selected = selection instanceof Set ? selection : new Set(selection || []);
    return (collection || []).filter((item) => !selected.has(item));
  };

  data.users = data.users.filter((item) => item !== user);
  data.billingAccounts = removeExact(data.billingAccounts, graph.billingAccounts.selected);
  data.workspaceModelSettings = removeExact(data.workspaceModelSettings, graph.workspaceModelSettings.selected);
  data.billingLedgerEntries = removeExact(data.billingLedgerEntries, graph.billingLedgerEntries.selected);
  data.billingReservations = removeExact(data.billingReservations, graph.billingReservations.selected);
  data.billingUsageRecords = removeExact(data.billingUsageRecords, graph.billingUsageRecords.selected);
  data.billingFundingEvents = removeExact(data.billingFundingEvents, graph.billingFundingEvents.selected);
  data.sessions = removeExact(data.sessions, graph.sessions.selected);
  data.messages = removeExact(data.messages, graph.messages.selected);
  data.runs = removeExact(data.runs, graph.runs.selected);
  data.runSteps = removeExact(data.runSteps, graph.runSteps.selected);
  data.executionRecords = removeExact(data.executionRecords, graph.executions.selected);
  data.worldGraphArtifacts = removeExact(data.worldGraphArtifacts, graph.worldGraphArtifacts.selected);
  data.worldGraphEvents = removeExact(data.worldGraphEvents, graph.worldGraphEvents.selected);
  data.outcomeContracts = removeExact(data.outcomeContracts, graph.outcomeContracts.selected);
  data.agentEvents = removeExact(data.agentEvents, graph.agentEvents.selected);
  data.runtimeLifecycleIntents = removeExact(data.runtimeLifecycleIntents, graph.runtimeLifecycleIntents.selected);
  data.marketplaceRatings = removeExact(data.marketplaceRatings, graph.marketplaceRatingsToDelete);
  data.agentWorkspaceRatings = removeExact(data.agentWorkspaceRatings, graph.agentWorkspaceRatingsToDelete);
  data.agentWorkspaces = removeExact(data.agentWorkspaces, graph.agentWorkspaces.selected);
  data.mcpConnections = removeExact(data.mcpConnections, graph.mcpConnections.selected);
  data.mcpOauthClients = removeExact(data.mcpOauthClients, graph.mcpOauthClients.selected);
  data.mcpOauthStates = removeExact(data.mcpOauthStates, graph.mcpOauthStates.selected);
  data.mcpApprovals = removeExact(data.mcpApprovals, graph.mcpApprovals.selected);
  data.mcpToolCalls = removeExact(data.mcpToolCalls, graph.mcpToolCalls.selected);
  data.workflows = removeExact(data.workflows, graph.workflows.selected);
  data.conversationCheckpoints = removeExact(data.conversationCheckpoints, graph.checkpoints.selected);
  data.agents = removeExact(data.agents, graph.agents.selected);
  data.documents = removeExact(data.documents, graph.documents.selected);
  data.validationRuns = removeExact(data.validationRuns, graph.validationRuns.selected);
  data.identityAuditEvents = removeExact(data.identityAuditEvents, graph.identityEvents);

  return {
    deleted_user_id: userId,
    deleted_workspace_id: workspaceId,
    document_roots: graph.documents.records.map((item) => item.document_root).filter(Boolean),
    deleted_counts: {
      chat_sessions: graph.sessions.records.length,
      runs: graph.runs.records.length,
      agents: graph.agents.records.length,
      documents: graph.documents.records.length,
      agent_workspaces: graph.agentWorkspaces.records.length,
      workflows: graph.workflows.records.length,
      mcp_connections: graph.mcpConnections.records.length
    }
  };
}

function accountOwnedResources(data, user, graph = buildAccountResourceGraph(data, user)) {
  const ambiguousCount = accountGraphAmbiguousCount(graph);
  if (ambiguousCount > 0) {
    throw identityError(
      409,
      "account_legacy_scope_ambiguous",
      `Account resource cleanup is blocked because ${ambiguousCount} legacy ${ambiguousCount === 1 ? "record has" : "records have"} ambiguous tenant ownership.`
    );
  }
  return {
    agents: graph.agents.records,
    documents: graph.documents.records,
    agent_workspaces: graph.agentWorkspaces.records,
    mcp_connections: graph.mcpConnections.records,
    mcp_oauth_revocations: graph.mcpOauthStates.records.filter((state) => (
      state.status === "revocation_pending" && Boolean(state.revocation_envelope)
    ))
  };
}

function stripSecrets(value) {
  if (Array.isArray(value)) return value.map(stripSecrets);
  if (!value || typeof value !== "object") return value;
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (/(password|token_hash|credential|ciphertext|client_secret|access_token|refresh_token|ip_fingerprint)/i.test(key)) continue;
    result[key] = stripSecrets(child);
  }
  return result;
}

function appendIdentityAudit(data, event) {
  data.identityAuditEvents ||= [];
  data.identityAuditEvents.push({ event_id: makeId("identityevt"), ...event });
  if (data.identityAuditEvents.length > MAX_IDENTITY_AUDIT_EVENTS) {
    data.identityAuditEvents.splice(0, data.identityAuditEvents.length - MAX_IDENTITY_AUDIT_EVENTS);
  }
}

function scrubLegacyIdentityFields(user) {
  for (const key of [
    "password_hash",
    "password_changed_at",
    "failed_login_count",
    "locked_until"
  ]) delete user[key];
}

function hashClerkUserId(value) {
  return crypto.createHash("sha256").update(`clerk:${String(value || "")}`, "utf8").digest("hex");
}

function registeredUserForActor(data, actor) {
  return data.users.find((user) =>
    user.user_id === actor?.user_id
    && user.workspace_id === actor?.workspace_id
    && (!actor?.clerk_user_id || user.clerk_user_id === actor.clerk_user_id)
  );
}

function activeRegisteredAdmins(data) {
  return data.users.filter((user) => user.role === "admin" && user.status === "active" && user.clerk_user_id);
}

function deletionDrainTimeoutMs(env) {
  const configured = Number(env.APP_ACCOUNT_DELETION_DRAIN_TIMEOUT_MS || DEFAULT_DELETION_DRAIN_TIMEOUT_MS);
  if (!Number.isFinite(configured)) return DEFAULT_DELETION_DRAIN_TIMEOUT_MS;
  return Math.max(25, Math.min(Math.trunc(configured), 30_000));
}

function assertDeletingUser(user, deletionId) {
  if (!user) throw identityError(404, "account_not_found", "Registered account not found.");
  if (user.status !== "deleting" || !user.deletion_id) {
    throw identityError(409, "account_deletion_not_started", "Account deletion has not been started.");
  }
  if (!deletionId || !timingSafeIdentityEqual(user.deletion_id, deletionId)) {
    throw identityError(409, "account_deletion_changed", "Account deletion state changed. Start the request again.");
  }
}

function deletionResourceRevision(resources = {}) {
  const normalized = {
    agents: (resources.agents || []).map((item) => ({
      id: item.id,
      record_digest: deletionRecordDigest(item)
    })).sort((left, right) => String(left.id).localeCompare(String(right.id))),
    documents: (resources.documents || []).map((item) => ({
      document_id: item.document_id,
      record_digest: deletionRecordDigest(item)
    })).sort((left, right) => String(left.document_id).localeCompare(String(right.document_id))),
    mcp_connections: (resources.mcp_connections || []).map((item) => ({
      connection_id: item.connection_id,
      record_digest: deletionRecordDigest(item)
    })).sort((left, right) => String(left.connection_id).localeCompare(String(right.connection_id))),
    mcp_oauth_revocations: (resources.mcp_oauth_revocations || []).map((item) => ({
      oauth_state_id: item.oauth_state_id,
      record_digest: deletionRecordDigest(item)
    })).sort((left, right) => String(left.oauth_state_id).localeCompare(String(right.oauth_state_id)))
  };
  return crypto.createHash("sha256")
    .update(JSON.stringify(normalized), "utf8")
    .digest("hex");
}

function deletionRecordDigest(value) {
  return crypto.createHash("sha256")
    .update(JSON.stringify(canonicalDeletionValue(value)), "utf8")
    .digest("hex");
}

function canonicalDeletionValue(value) {
  if (Array.isArray(value)) return value.map(canonicalDeletionValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort()
    .map((key) => [key, canonicalDeletionValue(value[key])]));
}

function upsertDeletionTombstone(data, user, {
  providerUserHash = null,
  deletionId = null,
  deletionStartedAt = null,
  status = "deleting",
  deletedAt = null,
  pendingDocumentRoots = null
} = {}) {
  data.identityDeletionTombstones ||= [];
  const hash = providerUserHash || hashClerkUserId(user?.clerk_user_id);
  let tombstone = data.identityDeletionTombstones.find((item) => (
    item.provider === "clerk" && item.provider_user_hash === hash
  ));
  if (!tombstone) {
    tombstone = { provider: "clerk", provider_user_hash: hash };
    data.identityDeletionTombstones.push(tombstone);
  }
  tombstone.status = status;
  tombstone.deletion_id = deletionId || tombstone.deletion_id || null;
  tombstone.deletion_started_at = deletionStartedAt || tombstone.deletion_started_at || nowIso();
  if (deletedAt) tombstone.deleted_at = deletedAt;
  if (Array.isArray(pendingDocumentRoots)) {
    tombstone.pending_document_roots = [...new Set(pendingDocumentRoots
      .map((value) => String(value || ""))
      .filter(Boolean))].slice(0, 10_000);
  }
  while (data.identityDeletionTombstones.length > MAX_IDENTITY_DELETION_TOMBSTONES) {
    const removable = data.identityDeletionTombstones.findIndex((item) => (
      (item.status === "deleted" || Boolean(item.deleted_at))
      && !Array.isArray(item.pending_document_roots)
    ));
    // Never discard an active deletion marker or a filesystem cleanup outbox
    // merely to satisfy the soft retention cap. Operator remediation is safer
    // than making cleanup irrecoverable.
    if (removable < 0) break;
    data.identityDeletionTombstones.splice(removable, 1);
  }
  return tombstone;
}

function timingSafeIdentityEqual(left, right) {
  const leftDigest = crypto.createHash("sha256").update(String(left || ""), "utf8").digest();
  const rightDigest = crypto.createHash("sha256").update(String(right || ""), "utf8").digest();
  return crypto.timingSafeEqual(leftDigest, rightDigest);
}

function configuredAdminEmails(env) {
  return new Set(String(env.APP_AUTH_ADMIN_EMAILS || "")
    .split(",")
    .map((value) => normalizeEmail(value, { required: false }))
    .filter(Boolean));
}

function configuredAdminUserIds(env) {
  return new Set(String(env.APP_CLERK_ADMIN_USER_IDS || "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => /^user_[A-Za-z0-9_-]{8,}$/.test(value)));
}

function requireClerkActor(actor) {
  if (actor?.auth_type !== "clerk" || !actor.clerk_user_id) {
    throw identityError(403, "clerk_account_required", "This action requires a signed-in Clerk account.");
  }
}

function requireIdentityAdmin(actor) {
  if (actor?.role !== "admin") throw identityError(403, "admin_required", "Admin privileges are required.");
}

function normalizeRole(value) {
  const role = String(value || "").trim().toLowerCase();
  if (!VALID_ROLES.has(role)) throw identityError(400, "invalid_role", "Role must be admin, user, or viewer.");
  return role;
}

function normalizeStatus(value) {
  const status = String(value || "").trim().toLowerCase();
  if (!["active", "suspended"].includes(status)) throw identityError(400, "invalid_status", "Status must be active or suspended.");
  return status;
}

function normalizeEmail(value, { required = true } = {}) {
  const email = String(value || "").trim().toLowerCase();
  if (!email && !required) return "";
  if (!email || email.length > EMAIL_MAX_CHARS || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    if (!required) return "";
    throw identityError(400, "invalid_email", "A valid email address is required.");
  }
  return email;
}

function validateAuthorizedParty(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("CLERK_AUTHORIZED_PARTIES entries must be absolute HTTP(S) origins.");
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("CLERK_AUTHORIZED_PARTIES entries must be absolute HTTP(S) origins without paths.");
  }
  return parsed.origin;
}

function timestampToIso(value) {
  if (value === undefined || value === null || value === "") return null;
  const date = typeof value === "number" ? new Date(value) : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function boundedText(value, maximum) {
  return String(value || "").replaceAll("\0", "").trim().slice(0, maximum);
}

function identityError(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

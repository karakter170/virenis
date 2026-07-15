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

const MAX_IDENTITY_AUDIT_EVENTS = 10_000;
const MAX_IDENTITY_DELETION_TOMBSTONES = 50_000;
const DISPLAY_NAME_MAX_CHARS = 80;
const EMAIL_MAX_CHARS = 254;
const VALID_ROLES = new Set(["admin", "user", "viewer"]);
const VALID_STATUSES = new Set(["active", "suspended"]);

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

    async resolveAuthenticated(authState) {
      if (!enabled || !authState?.isAuthenticated || !authState.userId) return null;
      let user = store.read((data) => data.users.find((candidate) => candidate.clerk_user_id === authState.userId));
      if (!user) {
        await provision(authState.userId);
        user = store.read((data) => data.users.find((candidate) => candidate.clerk_user_id === authState.userId));
      }
      if (!user) throw identityError(401, "identity_not_provisioned", "The Clerk account could not be linked to a Virenis workspace.");
      if (user.status !== "active") throw identityError(403, "account_suspended", "This account has been suspended. Contact support.");
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

    actorForClerkUserId(clerkUserId) {
      const user = store.read((data) => data.users.find((candidate) => candidate.clerk_user_id === clerkUserId));
      return user ? actorFromUser(user, null) : null;
    },

    exportAccount(actor) {
      const data = store.read();
      const user = registeredUserForActor(data, actor);
      if (!user) throw identityError(404, "account_not_found", "Registered account not found.");
      return buildAccountExport(data, user);
    },

    async validateAccountDeletion(actor, body = {}) {
      requireClerkActor(actor);
      if (String(body.confirmation || "") !== "DELETE") {
        throw identityError(400, "confirmation_required", "Type DELETE exactly to confirm account deletion.");
      }
      return store.mutate((data) => {
        const user = registeredUserForActor(data, actor);
        if (!user) throw identityError(404, "account_not_found", "Registered account not found.");
        if (user.role === "admin" && activeRegisteredAdmins(data).length <= 1) {
          throw identityError(409, "last_admin", "The last active administrator cannot delete their account.");
        }
        const accountIds = new Set((data.billingAccounts || [])
          .filter((account) => account.user_id === user.user_id && account.workspace_id === user.workspace_id)
          .map((account) => account.account_id));
        const hasActiveReservation = (data.billingReservations || []).some((reservation) => (
          accountIds.has(reservation.account_id) && reservation.status === "active"
        ));
        const ownedSessionIds = new Set((data.sessions || [])
          .filter((session) => ownsWorkspaceItem(session, user))
          .map((session) => session.session_id));
        const hasActiveLegacyRun = (data.runs || []).some((run) => (
          (ownedSessionIds.has(run.session_id) || ownsWorkspaceItem(run, user))
          && ["queued", "claimed", "planning", "running", "synthesizing"].includes(run.status)
        ));
        if (hasActiveReservation || hasActiveLegacyRun) {
          throw identityError(
            409,
            "account_has_active_runs",
            "Wait for active requests to finish before deleting this account."
          );
        }
        const now = nowIso();
        for (const account of data.billingAccounts || []) {
          if (accountIds.has(account.account_id)) {
            account.status = "closing";
            account.updated_at = now;
          }
        }
        return accountOwnedResources(data, user);
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

    async deleteAccount(actor) {
      return store.mutate((data) => {
        const user = registeredUserForActor(data, actor);
        if (!user) return null;
        const accountIds = new Set((data.billingAccounts || [])
          .filter((account) => account.user_id === user.user_id && account.workspace_id === user.workspace_id)
          .map((account) => account.account_id));
        if ((data.billingReservations || []).some((reservation) => (
          accountIds.has(reservation.account_id) && reservation.status === "active"
        ))) {
          throw identityError(
            409,
            "account_has_active_runs",
            "Wait for active requests to finish before deleting this account."
          );
        }
        const providerUserHash = hashClerkUserId(user.clerk_user_id);
        const result = deleteAccountData(data, user);
        data.identityDeletionTombstones ||= [];
        if (!data.identityDeletionTombstones.some((item) =>
          item.provider === "clerk" && item.provider_user_hash === providerUserHash
        )) {
          data.identityDeletionTombstones.push({
            provider: "clerk",
            provider_user_hash: providerUserHash,
            deleted_at: nowIso()
          });
          if (data.identityDeletionTombstones.length > MAX_IDENTITY_DELETION_TOMBSTONES) {
            data.identityDeletionTombstones.splice(
              0,
              data.identityDeletionTombstones.length - MAX_IDENTITY_DELETION_TOMBSTONES
            );
          }
        }
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

function buildAccountExport(data, user) {
  const workspaceId = user.workspace_id;
  const userId = user.user_id;
  const sessions = data.sessions.filter((item) => ownsWorkspaceItem(item, user));
  const sessionIds = new Set(sessions.map((item) => item.session_id));
  const runs = data.runs.filter((item) => sessionIds.has(item.session_id) || ownsWorkspaceItem(item, user));
  const runIds = new Set(runs.map((item) => item.run_id));
  const agents = data.agents.filter((item) => ownsWorkspaceItem(item, user));
  const agentIds = new Set(agents.map((item) => item.id));
  const documents = data.documents.filter((item) => ownsWorkspaceItem(item, user));
  const workflows = data.workflows.filter((item) => ownsWorkspaceItem(item, user) || sessionIds.has(item.session_id));
  const workflowIds = new Set(workflows.map((item) => item.workflow_id));
  const billingAccounts = (data.billingAccounts || []).filter((item) => ownsWorkspaceItem(item, user));
  const billingAccountIds = new Set(billingAccounts.map((item) => item.account_id));
  return stripSecrets({
    export_version: 2,
    exported_at: nowIso(),
    retention_note: "Append-only integrity receipts may be retained in de-identified form for security, provenance, and abuse prevention.",
    account: publicUser(user),
    billing: {
      accounts: billingAccounts,
      ledger_entries: (data.billingLedgerEntries || []).filter((item) => billingAccountIds.has(item.account_id)),
      reservations: (data.billingReservations || []).filter((item) => billingAccountIds.has(item.account_id)),
      usage_records: (data.billingUsageRecords || []).filter((item) => billingAccountIds.has(item.account_id)),
      funding_events: (data.billingFundingEvents || []).filter((item) => billingAccountIds.has(item.account_id))
    },
    workspace: { workspace_id: workspaceId, owner_user_id: userId },
    identity_events: data.identityAuditEvents.filter((item) => item.target_user_id === userId || item.actor_user_id === userId),
    authentication: { provider: "clerk", provider_user_id: user.clerk_user_id },
    chats: {
      sessions,
      messages: data.messages.filter((item) => sessionIds.has(item.session_id)),
      runs,
      run_steps: data.runSteps.filter((item) => runIds.has(item.run_id))
    },
    agents,
    agent_events: data.agentEvents.filter((item) => agentIds.has(item.agent_id) || (item.actor_user_id === userId && item.workspace_id === workspaceId)),
    documents,
    workflows,
    conversation_checkpoints: data.conversationCheckpoints.filter((item) => workflowIds.has(item.workflow_id) || sessionIds.has(item.session_id)),
    executions: data.executionRecords.filter((item) => runIds.has(item.run_id) || ownsWorkspaceItem(item, user)),
    outcome_contracts: data.outcomeContracts.filter((item) => runIds.has(item.run_id) || ownsWorkspaceItem(item, user)),
    marketplace_ratings: data.marketplaceRatings.filter((item) => item.created_by === userId && item.workspace_id === workspaceId),
    mcp: {
      connections: data.mcpConnections.filter((item) => ownsWorkspaceItem(item, user)),
      approvals: data.mcpApprovals.filter((item) => ownsWorkspaceItem(item, user)),
      tool_calls: data.mcpToolCalls.filter((item) => ownsWorkspaceItem(item, user))
    }
  });
}

function deleteAccountData(data, user) {
  const { user_id: userId, workspace_id: workspaceId } = user;
  const sessions = data.sessions.filter((item) => ownsWorkspaceItem(item, user));
  const sessionIds = new Set(sessions.map((item) => item.session_id));
  const runs = data.runs.filter((item) => sessionIds.has(item.session_id) || ownsWorkspaceItem(item, user));
  const runIds = new Set(runs.map((item) => item.run_id));
  const agents = data.agents.filter((item) => ownsWorkspaceItem(item, user));
  const agentIds = new Set(agents.map((item) => item.id));
  const listingIds = new Set(agents.map((item) => item.marketplace?.listing_id).filter(Boolean));
  const documents = data.documents.filter((item) => ownsWorkspaceItem(item, user));
  const documentIds = new Set(documents.map((item) => item.document_id));
  const workflows = data.workflows.filter((item) => ownsWorkspaceItem(item, user) || sessionIds.has(item.session_id));
  const workflowIds = new Set(workflows.map((item) => item.workflow_id));
  const connections = data.mcpConnections.filter((item) => ownsWorkspaceItem(item, user));
  const connectionIds = new Set(connections.map((item) => item.connection_id));
  const billingAccountIds = new Set((data.billingAccounts || [])
    .filter((item) => ownsWorkspaceItem(item, user))
    .map((item) => item.account_id));

  data.users = data.users.filter((item) => item.user_id !== userId);
  data.billingAccounts = (data.billingAccounts || []).filter((item) => !billingAccountIds.has(item.account_id));
  data.billingLedgerEntries = (data.billingLedgerEntries || []).filter((item) => !billingAccountIds.has(item.account_id));
  data.billingReservations = (data.billingReservations || []).filter((item) => !billingAccountIds.has(item.account_id));
  data.billingUsageRecords = (data.billingUsageRecords || []).filter((item) => !billingAccountIds.has(item.account_id));
  data.billingFundingEvents = (data.billingFundingEvents || []).filter((item) => !billingAccountIds.has(item.account_id));
  data.sessions = data.sessions.filter((item) => !sessionIds.has(item.session_id));
  data.messages = data.messages.filter((item) => !sessionIds.has(item.session_id));
  data.runs = data.runs.filter((item) => !runIds.has(item.run_id));
  data.runSteps = data.runSteps.filter((item) => !runIds.has(item.run_id));
  data.executionRecords = data.executionRecords.filter((item) => !runIds.has(item.run_id) && !ownsWorkspaceItem(item, user));
  data.outcomeContracts = data.outcomeContracts.filter((item) => !runIds.has(item.run_id) && !ownsWorkspaceItem(item, user));
  data.agentEvents = data.agentEvents.filter((item) => !agentIds.has(item.agent_id) && !(item.actor_user_id === userId && item.workspace_id === workspaceId));
  data.runtimeLifecycleIntents = data.runtimeLifecycleIntents.filter((item) => !agentIds.has(item.agent_id) && !documentIds.has(item.document_id));
  data.marketplaceRatings = data.marketplaceRatings.filter((item) =>
    !(item.created_by === userId && item.workspace_id === workspaceId) && !listingIds.has(item.listing_id)
  );
  data.mcpConnections = data.mcpConnections.filter((item) => !connectionIds.has(item.connection_id));
  data.mcpOauthClients = data.mcpOauthClients.filter((item) => !ownsWorkspaceItem(item, user));
  data.mcpOauthStates = data.mcpOauthStates.filter((item) => !connectionIds.has(item.connection_id) && !ownsWorkspaceItem(item, user));
  data.mcpApprovals = data.mcpApprovals.filter((item) => !connectionIds.has(item.connection_id) && !ownsWorkspaceItem(item, user));
  data.mcpToolCalls = data.mcpToolCalls.filter((item) => !connectionIds.has(item.connection_id) && !ownsWorkspaceItem(item, user));
  data.workflows = data.workflows.filter((item) => !workflowIds.has(item.workflow_id));
  data.conversationCheckpoints = data.conversationCheckpoints.filter((item) => !workflowIds.has(item.workflow_id) && !sessionIds.has(item.session_id));
  data.agents = data.agents.filter((item) => !agentIds.has(item.id));
  data.documents = data.documents.filter((item) => !documentIds.has(item.document_id));
  data.validationRuns = data.validationRuns.filter((item) => !ownsWorkspaceItem(item, user));
  data.identityAuditEvents = data.identityAuditEvents.filter((item) =>
    item.target_user_id !== userId && item.actor_user_id !== userId
  );

  return {
    deleted_user_id: userId,
    deleted_workspace_id: workspaceId,
    document_roots: documents.map((item) => item.document_root).filter(Boolean),
    deleted_counts: {
      chat_sessions: sessionIds.size,
      runs: runIds.size,
      agents: agentIds.size,
      documents: documentIds.size,
      workflows: workflowIds.size,
      mcp_connections: connectionIds.size
    }
  };
}

function accountOwnedResources(data, user) {
  return {
    agents: data.agents.filter((item) => ownsWorkspaceItem(item, user)),
    documents: data.documents.filter((item) => ownsWorkspaceItem(item, user)),
    mcp_connections: data.mcpConnections.filter((item) => ownsWorkspaceItem(item, user))
  };
}

function ownsWorkspaceItem(item, user) {
  if (!item || String(item.workspace_id || "") !== String(user.workspace_id || "")) return false;
  const owner = item.created_by || item.user_id || item.actor_user_id;
  return !owner || String(owner) === String(user.user_id);
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
  if (!VALID_STATUSES.has(status)) throw identityError(400, "invalid_status", "Status must be active or suspended.");
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

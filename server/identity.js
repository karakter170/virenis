import crypto from "node:crypto";
import { promisify } from "node:util";
import nodemailer from "nodemailer";
import { makeId, nowIso } from "./store.js";
import { readConfiguredSecret } from "./secretConfig.js";

const scryptAsync = promisify(crypto.scrypt);
const PASSWORD_MIN_CHARS = 15;
const PASSWORD_MAX_CHARS = 128;
const EMAIL_MAX_CHARS = 254;
const DISPLAY_NAME_MAX_CHARS = 80;
const TOKEN_BYTES = 32;
const DEFAULT_SESSION_DAYS = 30;
const DEFAULT_VERIFICATION_HOURS = 24;
const DEFAULT_RESET_MINUTES = 60;
const MAX_ACTIVE_SESSIONS = 12;
const MAX_IDENTITY_AUDIT_EVENTS = 10_000;
const EMAIL_RESEND_COOLDOWN_MS = 60_000;
const COMMON_PASSWORDS = new Set([
  "123456789012",
  "password1234",
  "password123!",
  "qwertyuiop12",
  "letmeinplease",
  "administrator"
]);

export function selfServiceIdentityEnabled(env = process.env) {
  return env.APP_IDENTITY_ENABLED === "1";
}

export function identityRegistrationEnabled(env = process.env) {
  return selfServiceIdentityEnabled(env) && env.APP_AUTH_REGISTRATION_ENABLED !== "0";
}

export function identityCookieName(env = process.env) {
  return env.NODE_ENV === "production" ? "__Host-virenis_session" : "virenis_session";
}

export function validateIdentityEnvironment(env = process.env) {
  if (!selfServiceIdentityEnabled(env)) return;
  boundedInteger(env.APP_AUTH_SESSION_DAYS, "APP_AUTH_SESSION_DAYS", 1, 90, DEFAULT_SESSION_DAYS);
  boundedInteger(env.APP_AUTH_VERIFICATION_HOURS, "APP_AUTH_VERIFICATION_HOURS", 1, 168, DEFAULT_VERIFICATION_HOURS);
  boundedInteger(env.APP_AUTH_RESET_MINUTES, "APP_AUTH_RESET_MINUTES", 10, 1440, DEFAULT_RESET_MINUTES);
  boundedInteger(env.APP_AUTH_RATE_WINDOW_MS, "APP_AUTH_RATE_WINDOW_MS", 60_000, 3_600_000, 15 * 60 * 1000);
  boundedInteger(env.APP_AUTH_RATE_LIMIT, "APP_AUTH_RATE_LIMIT", 1, 1000, 30);
  boundedInteger(env.APP_AUTH_RATE_MAX_BUCKETS, "APP_AUTH_RATE_MAX_BUCKETS", 100, 1_000_000, 10_000);
  if (env.NODE_ENV !== "production") return;
  const mode = String(env.APP_AUTH_EMAIL_MODE || "smtp").trim().toLowerCase();
  if (mode !== "smtp") {
    throw new Error("Production self-service identity requires APP_AUTH_EMAIL_MODE=smtp.");
  }
  if (!String(env.APP_AUTH_EMAIL_FROM || "").trim() || /[\r\n]/.test(String(env.APP_AUTH_EMAIL_FROM || ""))) {
    throw new Error("Production self-service identity requires APP_AUTH_EMAIL_FROM.");
  }
  const smtpUrl = readConfiguredSecret(env, "APP_AUTH_SMTP_URL", "APP_AUTH_SMTP_URL_FILE");
  const smtpPassword = readConfiguredSecret(env, "APP_AUTH_SMTP_PASSWORD", "APP_AUTH_SMTP_PASSWORD_FILE");
  const smtpHost = String(env.APP_AUTH_SMTP_HOST || "").trim();
  if (!smtpUrl && !smtpHost) {
    throw new Error("Production self-service identity requires APP_AUTH_SMTP_URL or APP_AUTH_SMTP_HOST.");
  }
  if (smtpUrl) parseSmtpUrl(smtpUrl, env);
  if (!smtpUrl && smtpHost.endsWith(".example")) {
    throw new Error("APP_AUTH_SMTP_HOST must be replaced with a real SMTP host.");
  }
  if (!smtpUrl && String(env.APP_AUTH_SMTP_USER || "").trim() && !smtpPassword) {
    throw new Error("APP_AUTH_SMTP_USER requires APP_AUTH_SMTP_PASSWORD or APP_AUTH_SMTP_PASSWORD_FILE.");
  }
  const adminEmails = configuredAdminEmails(env);
  if (adminEmails.size === 0 || [...adminEmails].some((email) => email.endsWith(".example") || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
    throw new Error("Production self-service identity requires real APP_AUTH_ADMIN_EMAILS.");
  }
  if (env.APP_AUTH_SMTP_TLS_REJECT_UNAUTHORIZED === "0") {
    throw new Error("Production self-service identity may not disable SMTP certificate verification.");
  }
  if (String(env.APP_AUTH_SCRYPT_N || "").trim()) {
    const cost = boundedInteger(env.APP_AUTH_SCRYPT_N, "APP_AUTH_SCRYPT_N", 131072, 1_048_576, 131072);
    if (!isPowerOfTwo(cost)) throw new Error("APP_AUTH_SCRYPT_N must be a power of two.");
  }
}

export async function createIdentityManager({ store, env = process.env } = {}) {
  if (!store) throw new TypeError("Identity manager requires a store.");
  validateIdentityEnvironment(env);
  const mailer = createIdentityMailer(env);
  const dummyHash = selfServiceIdentityEnabled(env)
    ? await hashPassword(`not-a-user-${crypto.randomBytes(16).toString("hex")}`, env)
    : "";

  return {
    outbox: mailer.outbox,
    publicConfig() {
      return {
        self_service_enabled: selfServiceIdentityEnabled(env),
        registration_enabled: identityRegistrationEnabled(env),
        email_verification_required: selfServiceIdentityEnabled(env),
        password_min_characters: PASSWORD_MIN_CHARS
      };
    },

    async register(body = {}) {
      requireIdentityEnabled(env);
      if (!identityRegistrationEnabled(env)) {
        throw identityError(403, "registration_disabled", "New account registration is currently closed.");
      }
      const email = normalizeEmail(body.email);
      const displayName = normalizeDisplayName(body.display_name, email);
      const password = validatePassword(body.password, { email });
      const passwordHash = await hashPassword(password, env);
      const rawToken = randomToken();
      const timestamp = nowIso();
      const expiresAt = addMilliseconds(timestamp, verificationHours(env) * 60 * 60 * 1000);
      const result = await store.mutate((data) => {
        cleanupIdentityState(data, timestamp);
        const existing = data.users.find((user) => user.email_normalized === email);
        if (existing) {
          if (!existing.email_verified && existing.status !== "suspended") {
            if (recentUserToken(data.emailVerificationTokens, existing.user_id, timestamp)) {
              return { user: existing, send: false, rawToken: null };
            }
            invalidateUserTokens(data.emailVerificationTokens, existing.user_id, timestamp);
            data.emailVerificationTokens.push(identityTokenRecord("verify", existing.user_id, rawToken, timestamp, expiresAt));
            appendIdentityAudit(data, {
              action: "identity.verification_requested",
              target_user_id: existing.user_id,
              actor_user_id: existing.user_id,
              at: timestamp
            });
            return { user: existing, send: true, rawToken };
          }
          return { user: existing, send: false, rawToken: null };
        }
        const userId = makeId("usr");
        const workspaceId = makeId("workspace");
        const user = {
          user_id: userId,
          workspace_id: workspaceId,
          email,
          email_normalized: email,
          display_name: displayName,
          password_hash: passwordHash,
          role: configuredAdminEmails(env).has(email) ? "admin" : "user",
          status: "active",
          email_verified: false,
          email_verified_at: null,
          failed_login_count: 0,
          locked_until: null,
          created_at: timestamp,
          updated_at: timestamp,
          last_login_at: null,
          password_changed_at: timestamp
        };
        data.users.push(user);
        data.emailVerificationTokens.push(identityTokenRecord("verify", userId, rawToken, timestamp, expiresAt));
        appendIdentityAudit(data, {
          action: "identity.account_registered",
          target_user_id: userId,
          actor_user_id: userId,
          at: timestamp
        });
        return { user, send: true, rawToken };
      });
      if (result.send) {
        try {
          await mailer.sendVerification({
            to: result.user.email,
            displayName: result.user.display_name,
            token: result.rawToken,
            expiresAt
          });
        } catch (error) {
          await markTokenDeliveryFailed(store, "emailVerificationTokens", result.rawToken);
          throw error;
        }
      }
      return {
        ok: true,
        verification_required: true,
        message: "If the address can be registered, a verification email has been sent."
      };
    },

    async verifyEmail(body = {}) {
      requireIdentityEnabled(env);
      const tokenHash = validateAndHashToken(body.token);
      const timestamp = nowIso();
      return store.mutate((data) => {
        cleanupIdentityState(data, timestamp);
        const token = data.emailVerificationTokens.find((candidate) =>
          candidate.token_hash === tokenHash
          && !candidate.consumed_at
          && Date.parse(candidate.expires_at) > Date.parse(timestamp)
        );
        if (!token) throw identityError(400, "invalid_verification_token", "This verification link is invalid or has expired.");
        const user = data.users.find((candidate) => candidate.user_id === token.user_id);
        if (!user || user.status === "suspended") {
          throw identityError(400, "invalid_verification_token", "This verification link is invalid or has expired.");
        }
        token.consumed_at = timestamp;
        user.email_verified = true;
        user.email_verified_at = timestamp;
        user.updated_at = timestamp;
        invalidateUserTokens(data.emailVerificationTokens, user.user_id, timestamp);
        appendIdentityAudit(data, {
          action: "identity.email_verified",
          target_user_id: user.user_id,
          actor_user_id: user.user_id,
          at: timestamp
        });
        return { ok: true, user: publicUser(user) };
      });
    },

    async resendVerification(body = {}) {
      requireIdentityEnabled(env);
      const email = normalizeEmail(body.email);
      const timestamp = nowIso();
      const rawToken = randomToken();
      const expiresAt = addMilliseconds(timestamp, verificationHours(env) * 60 * 60 * 1000);
      const result = await store.mutate((data) => {
        cleanupIdentityState(data, timestamp);
        const user = data.users.find((candidate) => candidate.email_normalized === email);
        if (!user || user.email_verified || user.status === "suspended") return null;
        if (recentUserToken(data.emailVerificationTokens, user.user_id, timestamp)) return null;
        invalidateUserTokens(data.emailVerificationTokens, user.user_id, timestamp);
        data.emailVerificationTokens.push(identityTokenRecord("verify", user.user_id, rawToken, timestamp, expiresAt));
        appendIdentityAudit(data, {
          action: "identity.verification_requested",
          target_user_id: user.user_id,
          actor_user_id: user.user_id,
          at: timestamp
        });
        return { user, rawToken };
      });
      if (result) {
        try {
          await mailer.sendVerification({
            to: result.user.email,
            displayName: result.user.display_name,
            token: result.rawToken,
            expiresAt
          });
        } catch (error) {
          await markTokenDeliveryFailed(store, "emailVerificationTokens", result.rawToken);
          throw error;
        }
      }
      return { ok: true, message: "If the account exists and still needs verification, a new email has been sent." };
    },

    async login(body = {}, requestContext = {}) {
      requireIdentityEnabled(env);
      const email = normalizeEmail(body.email);
      const password = String(body.password || "");
      if (!password || password.length > PASSWORD_MAX_CHARS) {
        await verifyPassword("invalid-login-attempt", dummyHash).catch(() => false);
        throw invalidCredentials();
      }
      const snapshot = store.read();
      const existing = snapshot.users.find((user) => user.email_normalized === email);
      const validPassword = await verifyPassword(password, existing?.password_hash || dummyHash);
      const timestamp = nowIso();
      if (!existing || !validPassword) {
        if (existing) await recordFailedLogin(store, existing.user_id, timestamp);
        throw invalidCredentials();
      }
      if (existing.locked_until && Date.parse(existing.locked_until) > Date.parse(timestamp)) {
        throw identityError(429, "account_temporarily_locked", "This account is temporarily locked. Try again later or reset the password.");
      }
      if (existing.status === "suspended") {
        throw identityError(403, "account_suspended", "This account has been suspended. Contact support.");
      }
      if (!existing.email_verified) {
        throw identityError(403, "email_not_verified", "Verify your email address before signing in.");
      }
      const upgradedPasswordHash = passwordHashNeedsUpgrade(existing.password_hash, env)
        ? await hashPassword(password, env)
        : null;
      const rawToken = randomToken();
      const sessionHash = hashToken(rawToken);
      const expiresAt = addMilliseconds(timestamp, sessionDays(env) * 24 * 60 * 60 * 1000);
      const session = await store.mutate((data) => {
        cleanupIdentityState(data, timestamp);
        const user = data.users.find((candidate) => candidate.user_id === existing.user_id);
        if (!user || user.status !== "active" || !user.email_verified) throw invalidCredentials();
        user.failed_login_count = 0;
        user.locked_until = null;
        user.last_login_at = timestamp;
        user.updated_at = timestamp;
        if (upgradedPasswordHash) {
          user.password_hash = upgradedPasswordHash;
          user.password_changed_at = timestamp;
        }
        const record = {
          session_id: makeId("authsess"),
          user_id: user.user_id,
          token_hash: sessionHash,
          created_at: timestamp,
          last_seen_at: timestamp,
          expires_at: expiresAt,
          revoked_at: null,
          revoked_reason: null,
          user_agent: boundedText(requestContext.userAgent, 240)
        };
        data.authSessions.push(record);
        enforceSessionLimit(data.authSessions, user.user_id, record.session_id, timestamp);
        appendIdentityAudit(data, {
          action: "identity.session_created",
          target_user_id: user.user_id,
          actor_user_id: user.user_id,
          session_id: record.session_id,
          at: timestamp
        });
        return { record, user: publicUser(user) };
      });
      return { ok: true, user: session.user, session: publicSession(session.record, session.record.session_id), raw_token: rawToken };
    },

    async resolveSession(cookieHeader) {
      if (!selfServiceIdentityEnabled(env)) return null;
      const cookies = parseCookies(cookieHeader);
      const rawToken = cookies.get(identityCookieName(env)) || cookies.get("virenis_session") || cookies.get("__Host-virenis_session");
      if (!rawToken || rawToken.length > 256) return null;
      const tokenHash = hashToken(rawToken);
      const timestamp = nowIso();
      const snapshot = store.read();
      const session = snapshot.authSessions.find((candidate) => candidate.token_hash === tokenHash);
      if (!activeSession(session, timestamp)) return null;
      const user = snapshot.users.find((candidate) => candidate.user_id === session.user_id);
      if (!user || user.status !== "active" || !user.email_verified) return null;
      if (Date.parse(timestamp) - Date.parse(session.last_seen_at || session.created_at) > 5 * 60 * 1000) {
        await store.mutate((data) => {
          const mutable = data.authSessions.find((candidate) => candidate.session_id === session.session_id);
          if (activeSession(mutable, timestamp)) mutable.last_seen_at = timestamp;
          return null;
        });
      }
      return {
        user_id: user.user_id,
        workspace_id: user.workspace_id,
        email: user.email,
        display_name: user.display_name,
        email_verified: user.email_verified,
        role: user.role,
        auth_type: "session",
        session_id: session.session_id
      };
    },

    async logout(actor) {
      const timestamp = nowIso();
      if (actor?.session_id) {
        await store.mutate((data) => {
          revokeSessionRecord(data.authSessions, actor.session_id, actor.user_id, "logout", timestamp);
          appendIdentityAudit(data, {
            action: "identity.session_revoked",
            target_user_id: actor.user_id,
            actor_user_id: actor.user_id,
            session_id: actor.session_id,
            at: timestamp
          });
          return null;
        });
      }
      return { ok: true };
    },

    async requestPasswordReset(body = {}) {
      requireIdentityEnabled(env);
      const email = normalizeEmail(body.email);
      const rawToken = randomToken();
      const timestamp = nowIso();
      const expiresAt = addMilliseconds(timestamp, resetMinutes(env) * 60 * 1000);
      const result = await store.mutate((data) => {
        cleanupIdentityState(data, timestamp);
        const user = data.users.find((candidate) => candidate.email_normalized === email);
        if (!user || !user.email_verified || user.status === "suspended") return null;
        if (recentUserToken(data.passwordResetTokens, user.user_id, timestamp)) return null;
        invalidateUserTokens(data.passwordResetTokens, user.user_id, timestamp);
        data.passwordResetTokens.push(identityTokenRecord("reset", user.user_id, rawToken, timestamp, expiresAt));
        appendIdentityAudit(data, {
          action: "identity.password_reset_requested",
          target_user_id: user.user_id,
          actor_user_id: user.user_id,
          at: timestamp
        });
        return { user, rawToken };
      });
      if (result) {
        try {
          await mailer.sendPasswordReset({
            to: result.user.email,
            displayName: result.user.display_name,
            token: result.rawToken,
            expiresAt
          });
        } catch (error) {
          await markTokenDeliveryFailed(store, "passwordResetTokens", result.rawToken);
          throw error;
        }
      }
      return { ok: true, message: "If the account exists, a password reset email has been sent." };
    },

    async resetPassword(body = {}) {
      requireIdentityEnabled(env);
      const tokenHash = validateAndHashToken(body.token);
      const password = validatePassword(body.password);
      const passwordHash = await hashPassword(password, env);
      const timestamp = nowIso();
      return store.mutate((data) => {
        cleanupIdentityState(data, timestamp);
        const token = data.passwordResetTokens.find((candidate) =>
          candidate.token_hash === tokenHash
          && !candidate.consumed_at
          && Date.parse(candidate.expires_at) > Date.parse(timestamp)
        );
        if (!token) throw identityError(400, "invalid_reset_token", "This password reset link is invalid or has expired.");
        const user = data.users.find((candidate) => candidate.user_id === token.user_id);
        if (!user || user.status === "suspended") {
          throw identityError(400, "invalid_reset_token", "This password reset link is invalid or has expired.");
        }
        token.consumed_at = timestamp;
        invalidateUserTokens(data.passwordResetTokens, user.user_id, timestamp);
        user.password_hash = passwordHash;
        user.password_changed_at = timestamp;
        user.updated_at = timestamp;
        user.failed_login_count = 0;
        user.locked_until = null;
        revokeAllUserSessions(data.authSessions, user.user_id, "password_reset", timestamp);
        appendIdentityAudit(data, {
          action: "identity.password_reset_completed",
          target_user_id: user.user_id,
          actor_user_id: user.user_id,
          at: timestamp
        });
        return { ok: true };
      });
    },

    listSessions(actor) {
      const timestamp = nowIso();
      return store.read((data) => ({
        sessions: data.authSessions
          .filter((session) => session.user_id === actor.user_id && activeSession(session, timestamp))
          .sort((left, right) => Date.parse(right.last_seen_at) - Date.parse(left.last_seen_at))
          .map((session) => publicSession(session, actor.session_id))
      }));
    },

    async revokeSession(actor, sessionId) {
      const timestamp = nowIso();
      return store.mutate((data) => {
        const revoked = revokeSessionRecord(data.authSessions, sessionId, actor.user_id, "user_revoked", timestamp);
        if (!revoked) throw identityError(404, "session_not_found", "Session not found.");
        appendIdentityAudit(data, {
          action: "identity.session_revoked",
          target_user_id: actor.user_id,
          actor_user_id: actor.user_id,
          session_id: sessionId,
          at: timestamp
        });
        return { ok: true, current_session_revoked: sessionId === actor.session_id };
      });
    },

    async revokeOtherSessions(actor) {
      const timestamp = nowIso();
      return store.mutate((data) => {
        let revoked = 0;
        for (const session of data.authSessions) {
          if (session.user_id === actor.user_id && session.session_id !== actor.session_id && activeSession(session, timestamp)) {
            session.revoked_at = timestamp;
            session.revoked_reason = "user_revoked_others";
            revoked += 1;
          }
        }
        appendIdentityAudit(data, {
          action: "identity.other_sessions_revoked",
          target_user_id: actor.user_id,
          actor_user_id: actor.user_id,
          revoked_count: revoked,
          at: timestamp
        });
        return { ok: true, revoked };
      });
    },

    async changePassword(actor, body = {}) {
      const currentPassword = String(body.current_password || "");
      const nextPassword = validatePassword(body.new_password, { email: actor.email });
      const snapshot = store.read();
      const user = registeredUserForActor(snapshot, actor);
      if (!user || !(await verifyPassword(currentPassword, user.password_hash))) {
        throw identityError(400, "invalid_current_password", "The current password is incorrect.");
      }
      const passwordHash = await hashPassword(nextPassword, env);
      const timestamp = nowIso();
      return store.mutate((data) => {
        const mutable = registeredUserForActor(data, actor);
        if (!mutable) throw identityError(404, "account_not_found", "Registered account not found.");
        mutable.password_hash = passwordHash;
        mutable.password_changed_at = timestamp;
        mutable.updated_at = timestamp;
        for (const session of data.authSessions) {
          if (session.user_id === actor.user_id && session.session_id !== actor.session_id && activeSession(session, timestamp)) {
            session.revoked_at = timestamp;
            session.revoked_reason = "password_changed";
          }
        }
        invalidateUserTokens(data.passwordResetTokens, actor.user_id, timestamp);
        appendIdentityAudit(data, {
          action: "identity.password_changed",
          target_user_id: actor.user_id,
          actor_user_id: actor.user_id,
          at: timestamp
        });
        return { ok: true };
      });
    },

    async updateProfile(actor, body = {}) {
      const snapshot = store.read();
      const user = registeredUserForActor(snapshot, actor);
      if (!user) throw identityError(404, "account_not_found", "Registered account not found.");
      const displayName = normalizeDisplayName(body.display_name, user.email);
      const timestamp = nowIso();
      return store.mutate((data) => {
        const mutable = registeredUserForActor(data, actor);
        if (!mutable) throw identityError(404, "account_not_found", "Registered account not found.");
        mutable.display_name = displayName;
        mutable.updated_at = timestamp;
        appendIdentityAudit(data, {
          action: "identity.profile_updated",
          target_user_id: mutable.user_id,
          actor_user_id: mutable.user_id,
          at: timestamp
        });
        return { user: publicUser(mutable) };
      });
    },

    exportAccount(actor) {
      const snapshot = store.read();
      const user = registeredUserForActor(snapshot, actor);
      if (!user) throw identityError(404, "account_not_found", "Registered account not found.");
      return buildAccountExport(snapshot, user);
    },

    async validateAccountDeletion(actor, body = {}) {
      if (String(body.confirmation || "") !== "DELETE") {
        throw identityError(400, "confirmation_required", "Type DELETE to confirm permanent account deletion.");
      }
      const snapshot = store.read();
      const user = registeredUserForActor(snapshot, actor);
      if (!user || !(await verifyPassword(String(body.password || ""), user.password_hash))) {
        throw identityError(400, "invalid_current_password", "The password is incorrect.");
      }
      if (user.role === "admin" && activeRegisteredAdmins(snapshot).length <= 1) {
        throw identityError(409, "last_admin", "Create another administrator before deleting the last administrator account.");
      }
      return accountOwnedResources(snapshot, user);
    },

    async deleteAccount(actor) {
      const timestamp = nowIso();
      return store.mutate((data) => {
        const user = registeredUserForActor(data, actor);
        if (!user) throw identityError(404, "account_not_found", "Registered account not found.");
        const resources = deleteAccountData(data, user);
        appendIdentityAudit(data, {
          action: "identity.account_deleted",
          target_user_hash: hashToken(user.user_id),
          actor_user_hash: hashToken(user.user_id),
          at: timestamp
        });
        return { ok: true, ...resources };
      });
    },

    listUsers(actor) {
      requireIdentityAdmin(actor);
      const timestamp = nowIso();
      return store.read((data) => ({
        users: [...data.users]
          .sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at))
          .map((user) => ({
            ...publicUser(user),
            active_sessions: data.authSessions.filter((session) => session.user_id === user.user_id && activeSession(session, timestamp)).length
          }))
      }));
    },

    async updateUser(actor, userId, patch = {}) {
      requireIdentityAdmin(actor);
      const timestamp = nowIso();
      return store.mutate((data) => {
        const user = data.users.find((candidate) => candidate.user_id === userId);
        if (!user) throw identityError(404, "user_not_found", "User not found.");
        const nextRole = patch.role === undefined ? user.role : normalizeRole(patch.role);
        const nextStatus = patch.status === undefined ? user.status : normalizeStatus(patch.status);
        if (user.user_id === actor.user_id && (nextRole !== "admin" || nextStatus !== "active")) {
          throw identityError(409, "cannot_disable_self", "An administrator cannot demote or suspend their own active session.");
        }
        if (user.role === "admin" && (nextRole !== "admin" || nextStatus !== "active") && activeRegisteredAdmins(data).length <= 1) {
          throw identityError(409, "last_admin", "The last active administrator cannot be demoted or suspended.");
        }
        const roleChanged = user.role !== nextRole;
        user.role = nextRole;
        user.status = nextStatus;
        if (patch.email_verified === true && !user.email_verified) {
          user.email_verified = true;
          user.email_verified_at = timestamp;
          invalidateUserTokens(data.emailVerificationTokens, user.user_id, timestamp);
        }
        if (nextStatus === "suspended") revokeAllUserSessions(data.authSessions, user.user_id, "admin_suspended", timestamp);
        else if (roleChanged) revokeAllUserSessions(data.authSessions, user.user_id, "role_changed", timestamp);
        user.updated_at = timestamp;
        appendIdentityAudit(data, {
          action: "identity.user_updated_by_admin",
          target_user_id: user.user_id,
          actor_user_id: actor.user_id,
          role: user.role,
          status: user.status,
          at: timestamp
        });
        return { user: publicUser(user) };
      });
    },

    async adminRevokeSessions(actor, userId) {
      requireIdentityAdmin(actor);
      const timestamp = nowIso();
      return store.mutate((data) => {
        const user = data.users.find((candidate) => candidate.user_id === userId);
        if (!user) throw identityError(404, "user_not_found", "User not found.");
        const revoked = revokeAllUserSessions(data.authSessions, user.user_id, "admin_revoked", timestamp);
        appendIdentityAudit(data, {
          action: "identity.sessions_revoked_by_admin",
          target_user_id: user.user_id,
          actor_user_id: actor.user_id,
          revoked_count: revoked,
          at: timestamp
        });
        return { ok: true, revoked };
      });
    }
  };
}

export function sessionCookie(token, env = process.env) {
  const maxAge = sessionDays(env) * 24 * 60 * 60;
  return [
    `${identityCookieName(env)}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    ...(env.NODE_ENV === "production" ? ["Secure"] : []),
    `Max-Age=${maxAge}`
  ].join("; ");
}

export function clearSessionCookie(env = process.env) {
  return [
    `${identityCookieName(env)}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    ...(env.NODE_ENV === "production" ? ["Secure"] : []),
    "Max-Age=0"
  ].join("; ");
}

export function publicIdentityUser(user) {
  return publicUser(user);
}

async function recordFailedLogin(store, userId, timestamp) {
  await store.mutate((data) => {
    const user = data.users.find((candidate) => candidate.user_id === userId);
    if (!user) return null;
    if (user.locked_until && Date.parse(user.locked_until) <= Date.parse(timestamp)) {
      user.failed_login_count = 0;
      user.locked_until = null;
    }
    user.failed_login_count = Number(user.failed_login_count || 0) + 1;
    if (user.failed_login_count >= 5) {
      user.locked_until = addMilliseconds(timestamp, 15 * 60 * 1000);
      user.failed_login_count = 0;
    }
    user.updated_at = timestamp;
    appendIdentityAudit(data, {
      action: "identity.login_failed",
      target_user_id: user.user_id,
      actor_user_id: user.user_id,
      at: timestamp
    });
    return null;
  });
}

async function markTokenDeliveryFailed(store, collection, rawToken) {
  const tokenHash = hashToken(rawToken);
  const timestamp = nowIso();
  await store.mutate((data) => {
    const token = (data[collection] || []).find((candidate) => candidate.token_hash === tokenHash);
    if (token && !token.consumed_at) token.consumed_at = timestamp;
    return null;
  }).catch(() => undefined);
}

function createIdentityMailer(env) {
  const outbox = [];
  const mode = String(env.APP_AUTH_EMAIL_MODE || (env.NODE_ENV === "production" ? "smtp" : "capture")).trim().toLowerCase();
  let transporter = null;
  if (mode === "smtp") {
    const smtpUrl = readConfiguredSecret(env, "APP_AUTH_SMTP_URL", "APP_AUTH_SMTP_URL_FILE");
    if (smtpUrl) {
      transporter = nodemailer.createTransport(parseSmtpUrl(smtpUrl, env));
    } else {
      const user = String(env.APP_AUTH_SMTP_USER || "").trim();
      const pass = readConfiguredSecret(env, "APP_AUTH_SMTP_PASSWORD", "APP_AUTH_SMTP_PASSWORD_FILE");
      transporter = nodemailer.createTransport({
        host: String(env.APP_AUTH_SMTP_HOST || "").trim(),
        port: boundedInteger(env.APP_AUTH_SMTP_PORT, "APP_AUTH_SMTP_PORT", 1, 65535, 587),
        secure: env.APP_AUTH_SMTP_SECURE === "1" || String(env.APP_AUTH_SMTP_PORT || "") === "465",
        ...(user ? { auth: { user, pass } } : {}),
        requireTLS: env.APP_AUTH_SMTP_REQUIRE_TLS !== "0",
        tls: { rejectUnauthorized: env.APP_AUTH_SMTP_TLS_REJECT_UNAUTHORIZED !== "0" },
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 20_000
      });
    }
  }
  const from = String(env.APP_AUTH_EMAIL_FROM || "Virenis <no-reply@localhost>").trim();
  const origin = String(env.APP_PUBLIC_ORIGIN || "http://localhost:5173").replace(/\/+$/, "");

  async function deliver(message) {
    if (mode === "capture") {
      outbox.push({ ...message, captured_at: nowIso() });
      return;
    }
    if (mode !== "smtp" || !transporter) {
      throw identityError(503, "email_delivery_unavailable", "Account email delivery is not configured.");
    }
    try {
      await transporter.sendMail({
        from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html
      });
    } catch (error) {
      console.error("virenis identity email delivery failed.", { kind: message.kind, error: error.message });
      throw identityError(503, "email_delivery_failed", "The account email could not be delivered. Try again shortly.");
    }
  }

  return {
    outbox,
    sendVerification({ to, displayName, token, expiresAt }) {
      const url = `${origin}/verify-email#token=${encodeURIComponent(token)}`;
      const safeName = escapeHtml(displayName);
      return deliver({
        kind: "verification",
        to,
        token,
        url,
        expires_at: expiresAt,
        subject: "Verify your Virenis email",
        text: `Hello ${displayName},\n\nVerify your Virenis email: ${url}\n\nThis link expires at ${expiresAt}.`,
        html: `<p>Hello ${safeName},</p><p><a href="${escapeHtml(url)}">Verify your Virenis email</a></p><p>This link expires at ${escapeHtml(expiresAt)}.</p>`
      });
    },
    sendPasswordReset({ to, displayName, token, expiresAt }) {
      const url = `${origin}/reset-password#token=${encodeURIComponent(token)}`;
      const safeName = escapeHtml(displayName);
      return deliver({
        kind: "password_reset",
        to,
        token,
        url,
        expires_at: expiresAt,
        subject: "Reset your Virenis password",
        text: `Hello ${displayName},\n\nReset your Virenis password: ${url}\n\nThis link expires at ${expiresAt}. If you did not request it, no action is needed.`,
        html: `<p>Hello ${safeName},</p><p><a href="${escapeHtml(url)}">Reset your Virenis password</a></p><p>This link expires at ${escapeHtml(expiresAt)}. If you did not request it, no action is needed.</p>`
      });
    }
  };
}

async function hashPassword(password, env) {
  const salt = crypto.randomBytes(16);
  const N = scryptCost(env);
  const r = 8;
  const p = 1;
  const derived = await scryptAsync(password, salt, 64, { N, r, p, maxmem: Math.max(64 * 1024 * 1024, 256 * N * r) });
  return `scrypt$${N}$${r}$${p}$${salt.toString("base64url")}$${Buffer.from(derived).toString("base64url")}`;
}

async function verifyPassword(password, encoded) {
  const [algorithm, nRaw, rRaw, pRaw, saltRaw, hashRaw] = String(encoded || "").split("$");
  if (algorithm !== "scrypt" || !saltRaw || !hashRaw) return false;
  const N = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (!Number.isSafeInteger(N) || !isPowerOfTwo(N) || N < 1024 || N > 1_048_576) return false;
  if (!Number.isSafeInteger(r) || r < 1 || r > 32 || !Number.isSafeInteger(p) || p < 1 || p > 16) return false;
  const expected = Buffer.from(hashRaw, "base64url");
  if (expected.length !== 64) return false;
  const actual = Buffer.from(await scryptAsync(String(password || ""), Buffer.from(saltRaw, "base64url"), expected.length, {
    N,
    r,
    p,
    maxmem: Math.max(64 * 1024 * 1024, 256 * N * r)
  }));
  return crypto.timingSafeEqual(actual, expected);
}

function scryptCost(env) {
  const defaultCost = env.NODE_ENV === "test" ? 4096 : 131072;
  const minimum = env.NODE_ENV === "production" ? 131072 : 4096;
  const cost = boundedInteger(env.APP_AUTH_SCRYPT_N, "APP_AUTH_SCRYPT_N", minimum, 1_048_576, defaultCost);
  if (!isPowerOfTwo(cost)) throw new Error("APP_AUTH_SCRYPT_N must be a power of two.");
  return cost;
}

function parseSmtpUrl(value, env) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("APP_AUTH_SMTP_URL must be a valid SMTP URL.");
  }
  if (!new Set(["smtp:", "smtps:"]).has(parsed.protocol) || !parsed.hostname) {
    throw new Error("APP_AUTH_SMTP_URL must use smtp:// or smtps:// with a host.");
  }
  if (env.NODE_ENV === "production" && parsed.hostname.endsWith(".example")) {
    throw new Error("APP_AUTH_SMTP_URL must use a real SMTP host.");
  }
  const username = decodeURIComponent(parsed.username || "");
  const password = decodeURIComponent(parsed.password || "");
  if (username && !password) throw new Error("APP_AUTH_SMTP_URL username requires a password.");
  return {
    host: parsed.hostname,
    port: parsed.port ? boundedInteger(parsed.port, "APP_AUTH_SMTP_URL port", 1, 65535, 587) : (parsed.protocol === "smtps:" ? 465 : 587),
    secure: parsed.protocol === "smtps:",
    ...(username ? { auth: { user: username, pass: password } } : {}),
    requireTLS: parsed.protocol !== "smtps:" && env.APP_AUTH_SMTP_REQUIRE_TLS !== "0",
    tls: { rejectUnauthorized: env.APP_AUTH_SMTP_TLS_REJECT_UNAUTHORIZED !== "0" },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000
  };
}

function passwordHashNeedsUpgrade(encoded, env) {
  const [algorithm, nRaw, rRaw, pRaw] = String(encoded || "").split("$");
  if (algorithm !== "scrypt") return true;
  return Number(nRaw) < scryptCost(env) || Number(rRaw) !== 8 || Number(pRaw) !== 1;
}

function normalizeEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  if (!email || email.length > EMAIL_MAX_CHARS || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw identityError(400, "invalid_email", "Enter a valid email address.");
  }
  return email;
}

function normalizeDisplayName(value, email) {
  const fallback = String(email || "User").split("@")[0];
  const name = boundedText(value || fallback, DISPLAY_NAME_MAX_CHARS).replace(/\s+/gu, " ");
  if (!name) throw identityError(400, "invalid_display_name", "Enter a display name.");
  return name;
}

function validatePassword(value, { email = "" } = {}) {
  const password = String(value || "");
  if (password.length < PASSWORD_MIN_CHARS || password.length > PASSWORD_MAX_CHARS) {
    throw identityError(400, "weak_password", `Use a password between ${PASSWORD_MIN_CHARS} and ${PASSWORD_MAX_CHARS} characters.`);
  }
  const normalized = password.toLowerCase();
  const emailPrefix = String(email || "").split("@")[0].toLowerCase();
  if (COMMON_PASSWORDS.has(normalized) || (emailPrefix.length >= 4 && normalized.includes(emailPrefix))) {
    throw identityError(400, "weak_password", "Choose a less predictable password that does not contain your email name.");
  }
  return password;
}

function configuredAdminEmails(env) {
  return new Set(String(env.APP_AUTH_ADMIN_EMAILS || "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean));
}

function identityTokenRecord(kind, userId, rawToken, createdAt, expiresAt) {
  return {
    token_id: makeId(kind === "verify" ? "verify" : "reset"),
    user_id: userId,
    token_hash: hashToken(rawToken),
    created_at: createdAt,
    expires_at: expiresAt,
    consumed_at: null
  };
}

function validateAndHashToken(value) {
  const token = String(value || "").trim();
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(token)) {
    throw identityError(400, "invalid_token", "The account link is invalid or has expired.");
  }
  return hashToken(token);
}

function randomToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString("base64url");
}

function hashToken(value) {
  return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

function publicUser(user) {
  return {
    user_id: user.user_id,
    workspace_id: user.workspace_id,
    email: user.email,
    display_name: user.display_name,
    role: user.role,
    status: user.status,
    email_verified: Boolean(user.email_verified),
    email_verified_at: user.email_verified_at || null,
    created_at: user.created_at,
    updated_at: user.updated_at,
    last_login_at: user.last_login_at || null
  };
}

function publicSession(session, currentSessionId) {
  return {
    session_id: session.session_id,
    created_at: session.created_at,
    last_seen_at: session.last_seen_at,
    expires_at: session.expires_at,
    user_agent: session.user_agent || "Unknown browser",
    current: session.session_id === currentSessionId
  };
}

function activeSession(session, timestamp) {
  return Boolean(session && !session.revoked_at && Date.parse(session.expires_at) > Date.parse(timestamp));
}

function parseCookies(header) {
  const parsed = new Map();
  for (const part of String(header || "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    try {
      parsed.set(key, decodeURIComponent(value));
    } catch {
      // Ignore malformed cookies instead of rejecting the whole request.
    }
  }
  return parsed;
}

function revokeSessionRecord(sessions, sessionId, userId, reason, timestamp) {
  const session = sessions.find((candidate) => candidate.session_id === sessionId && candidate.user_id === userId);
  if (!session) return false;
  if (!session.revoked_at) {
    session.revoked_at = timestamp;
    session.revoked_reason = reason;
  }
  return true;
}

function revokeAllUserSessions(sessions, userId, reason, timestamp) {
  let revoked = 0;
  for (const session of sessions) {
    if (session.user_id === userId && !session.revoked_at) {
      session.revoked_at = timestamp;
      session.revoked_reason = reason;
      revoked += 1;
    }
  }
  return revoked;
}

function enforceSessionLimit(sessions, userId, keepSessionId, timestamp) {
  const active = sessions
    .filter((session) => session.user_id === userId && activeSession(session, timestamp) && session.session_id !== keepSessionId)
    .sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at));
  for (const session of active.slice(MAX_ACTIVE_SESSIONS - 1)) {
    session.revoked_at = timestamp;
    session.revoked_reason = "session_limit";
  }
}

function invalidateUserTokens(tokens, userId, timestamp) {
  for (const token of tokens) {
    if (token.user_id === userId && !token.consumed_at) token.consumed_at = timestamp;
  }
}

function recentUserToken(tokens, userId, timestamp) {
  const now = Date.parse(timestamp);
  return tokens.some((token) =>
    token.user_id === userId
    && !token.consumed_at
    && now - Date.parse(token.created_at) < EMAIL_RESEND_COOLDOWN_MS
  );
}

function cleanupIdentityState(data, timestamp) {
  const cutoff = Date.parse(timestamp) - 30 * 24 * 60 * 60 * 1000;
  data.emailVerificationTokens = data.emailVerificationTokens.filter((token) =>
    Date.parse(token.consumed_at || token.expires_at) >= cutoff
  );
  data.passwordResetTokens = data.passwordResetTokens.filter((token) =>
    Date.parse(token.consumed_at || token.expires_at) >= cutoff
  );
  data.authSessions = data.authSessions.filter((session) => {
    const terminalAt = session.revoked_at || session.expires_at;
    return !terminalAt || Date.parse(terminalAt) >= cutoff;
  });
}

function appendIdentityAudit(data, event) {
  data.identityAuditEvents.push({ event_id: makeId("identityevt"), ...event });
  if (data.identityAuditEvents.length > MAX_IDENTITY_AUDIT_EVENTS) {
    data.identityAuditEvents.splice(0, data.identityAuditEvents.length - MAX_IDENTITY_AUDIT_EVENTS);
  }
}

function registeredUserForActor(data, actor) {
  return data.users.find((user) =>
    user.user_id === actor?.user_id && user.workspace_id === actor?.workspace_id
  );
}

function activeRegisteredAdmins(data) {
  return data.users.filter((user) => user.role === "admin" && user.status === "active");
}

function accountOwnedResources(data, user) {
  return {
    agents: data.agents.filter((item) => ownsWorkspaceItem(item, user)),
    documents: data.documents.filter((item) => ownsWorkspaceItem(item, user)),
    mcp_connections: data.mcpConnections.filter((item) => ownsWorkspaceItem(item, user))
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
  return stripSecrets({
    export_version: 1,
    exported_at: nowIso(),
    retention_note: "Append-only integrity receipts may be retained in de-identified form for security, provenance, and abuse prevention.",
    account: publicUser(user),
    workspace: { workspace_id: workspaceId, owner_user_id: userId },
    identity_events: data.identityAuditEvents.filter((item) => item.target_user_id === userId || item.actor_user_id === userId),
    browser_sessions: data.authSessions.filter((item) => item.user_id === userId).map((item) => publicSession(item, null)),
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

  data.users = data.users.filter((item) => item.user_id !== userId);
  data.authSessions = data.authSessions.filter((item) => item.user_id !== userId);
  data.emailVerificationTokens = data.emailVerificationTokens.filter((item) => item.user_id !== userId);
  data.passwordResetTokens = data.passwordResetTokens.filter((item) => item.user_id !== userId);
  data.identityAuditEvents = data.identityAuditEvents.filter((item) =>
    item.target_user_id !== userId && item.actor_user_id !== userId
  );
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

function requireIdentityEnabled(env) {
  if (!selfServiceIdentityEnabled(env)) {
    throw identityError(404, "identity_disabled", "Self-service identity is not enabled.");
  }
}

function requireIdentityAdmin(actor) {
  if (actor?.role !== "admin") throw identityError(403, "admin_required", "Admin privileges are required.");
}

function normalizeRole(value) {
  const role = String(value || "").trim().toLowerCase();
  if (!new Set(["admin", "user", "viewer"]).has(role)) throw identityError(400, "invalid_role", "Role must be admin, user, or viewer.");
  return role;
}

function normalizeStatus(value) {
  const status = String(value || "").trim().toLowerCase();
  if (!new Set(["active", "suspended"]).has(status)) throw identityError(400, "invalid_status", "Status must be active or suspended.");
  return status;
}

function invalidCredentials() {
  return identityError(401, "invalid_credentials", "The email or password is incorrect.");
}

function identityError(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function addMilliseconds(iso, milliseconds) {
  return new Date(Date.parse(iso) + milliseconds).toISOString();
}

function sessionDays(env) {
  return boundedInteger(env.APP_AUTH_SESSION_DAYS, "APP_AUTH_SESSION_DAYS", 1, 90, DEFAULT_SESSION_DAYS);
}

function verificationHours(env) {
  return boundedInteger(env.APP_AUTH_VERIFICATION_HOURS, "APP_AUTH_VERIFICATION_HOURS", 1, 168, DEFAULT_VERIFICATION_HOURS);
}

function resetMinutes(env) {
  return boundedInteger(env.APP_AUTH_RESET_MINUTES, "APP_AUTH_RESET_MINUTES", 10, 1440, DEFAULT_RESET_MINUTES);
}

function boundedInteger(value, name, minimum, maximum, fallback) {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  const parsed = Number(String(value).trim());
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

function boundedText(value, maximum) {
  return String(value || "").replaceAll("\0", "").trim().slice(0, maximum);
}

function isPowerOfTwo(value) {
  return value > 0 && (value & (value - 1)) === 0;
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

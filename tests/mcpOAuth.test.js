import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../server/app.js";
import {
  attestMcpOAuthRevocationResolved,
  decryptMcpValue,
  disconnectMcpConnectionDurably,
  encryptMcpValue,
  queueStaleMcpOAuthRevocations,
  recoverMcpOAuthRevocations,
  revokePendingMcpOAuthState
} from "../server/mcp.js";

const OWNER_TOKEN = "oauth-owner-test-token";
const OTHER_TOKEN = "oauth-other-test-token";
const ADMIN_TOKEN = "oauth-admin-test-token";
const ALIEN_TOKEN = "oauth-alien-test-token";
const ALIEN_ADMIN_TOKEN = "oauth-alien-admin-test-token";
const GATEWAY_KEY = "oauth-test-gateway-key-with-more-than-thirty-two-characters";
const ENV_KEYS = [
  "WEB_STORE_DRIVER",
  "APP_API_TOKENS_JSON",
  "APP_MCP_ALLOW_TEST_HTTP",
  "APP_MCP_OAUTH_ALLOW_TEST_HTTP",
  "APP_MCP_GATEWAY_KEY",
  "APP_PUBLIC_ORIGIN",
  "APP_MCP_OAUTH_REDIRECT_ORIGIN",
  "APP_MCP_GMAIL_OAUTH_CLIENT_ID",
  "APP_MCP_GMAIL_OAUTH_CLIENT_SECRET",
  "APP_MCP_GMAIL_ENDPOINT_URL",
  "APP_MCP_GMAIL_AUTHORIZATION_URL",
  "APP_MCP_GMAIL_TOKEN_URL",
  "APP_MCP_GMAIL_REVOCATION_URL"
];

let app;
let tmpDir;
let providerServer;
let provider;
let priorEnvironment;
let webServer;
const executeFile = promisify(execFile);

const owner = () => ({ Authorization: `Bearer ${OWNER_TOKEN}` });
const other = () => ({ Authorization: `Bearer ${OTHER_TOKEN}` });
const admin = () => ({ Authorization: `Bearer ${ADMIN_TOKEN}` });
const alien = () => ({ Authorization: `Bearer ${ALIEN_TOKEN}` });
const alienAdmin = () => ({ Authorization: `Bearer ${ALIEN_ADMIN_TOKEN}` });

beforeEach(async () => {
  webServer = undefined;
  priorEnvironment = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  provider = createSyntheticManagedProvider();
  providerServer = provider.server;
  await new Promise((resolve) => providerServer.listen(0, "127.0.0.1", resolve));
  provider.origin = `http://127.0.0.1:${providerServer.address().port}`;

  process.env.WEB_STORE_DRIVER = "json";
  process.env.APP_API_TOKENS_JSON = JSON.stringify({
    [OWNER_TOKEN]: { user_id: "oauth_owner", workspace_id: "oauth_workspace", role: "user" },
    [OTHER_TOKEN]: { user_id: "oauth_other", workspace_id: "oauth_workspace", role: "user" },
    [ADMIN_TOKEN]: { user_id: "oauth_admin", workspace_id: "oauth_workspace", role: "admin" },
    [ALIEN_TOKEN]: { user_id: "oauth_alien", workspace_id: "alien_workspace", role: "user" },
    [ALIEN_ADMIN_TOKEN]: { user_id: "oauth_alien_admin", workspace_id: "alien_workspace", role: "admin" }
  });
  process.env.APP_MCP_ALLOW_TEST_HTTP = "1";
  process.env.APP_MCP_OAUTH_ALLOW_TEST_HTTP = "1";
  process.env.APP_MCP_GATEWAY_KEY = GATEWAY_KEY;
  process.env.APP_PUBLIC_ORIGIN = "http://app.oauth.test";
  process.env.APP_MCP_OAUTH_REDIRECT_ORIGIN = "http://app.oauth.test";
  process.env.APP_MCP_GMAIL_OAUTH_CLIENT_ID = "gmail-oauth-test-client";
  process.env.APP_MCP_GMAIL_OAUTH_CLIENT_SECRET = "gmail-oauth-test-client-secret";
  process.env.APP_MCP_GMAIL_ENDPOINT_URL = `${provider.origin}/mcp`;
  process.env.APP_MCP_GMAIL_AUTHORIZATION_URL = `${provider.origin}/authorize`;
  process.env.APP_MCP_GMAIL_TOKEN_URL = `${provider.origin}/token`;
  process.env.APP_MCP_GMAIL_REVOCATION_URL = `${provider.origin}/revoke`;

  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "virenis-mcp-oauth-"));
  app = await createApp({ dbPath: path.join(tmpDir, "db.json"), uploadRoot: tmpDir, autoRun: false });
});

afterEach(async () => {
  await app?.locals?.store?.close?.();
  await new Promise((resolve) => webServer ? webServer.close(resolve) : resolve());
  await new Promise((resolve) => providerServer?.close(resolve));
  await fs.rm(tmpDir, { recursive: true, force: true });
  for (const key of ENV_KEYS) {
    if (priorEnvironment[key] === undefined) delete process.env[key];
    else process.env[key] = priorEnvironment[key];
  }
});

describe("managed MCP OAuth connections", () => {
  it("advertises administrator setup instead of accepting an incomplete managed-provider configuration", async () => {
    delete process.env.APP_MCP_GMAIL_OAUTH_CLIENT_SECRET;
    const templates = await request(app).get("/api/mcp/templates").set(owner()).expect(200);
    expect(templates.body.templates.find((item) => item.id === "gmail")).toMatchObject({
      availability: "setup_required"
    });
    await request(app)
      .post("/api/mcp/oauth/start")
      .set(owner())
      .send({ provider_id: "gmail" })
      .expect(503);
  });

  it("connects Gmail without endpoint/token input and binds OAuth to the initiating browser", async () => {
    const templates = await request(app).get("/api/mcp/templates").set(owner()).expect(200);
    const gmail = templates.body.templates.find((item) => item.id === "gmail");
    expect(gmail).toMatchObject({
      connection_mode: "managed",
      auth_type: "oauth2",
      availability: "available",
      connect_label: "Connect Gmail"
    });
    expect(JSON.stringify(gmail)).not.toContain("gmail-oauth-test-client");
    expect(JSON.stringify(gmail)).not.toContain(provider.origin);

    await request(app)
      .post("/api/mcp/connections")
      .set(owner())
      .send({
        template_id: "gmail",
        name: "Bypass",
        endpoint_url: `${provider.origin}/mcp`,
        auth: { type: "none" }
      })
      .expect(400);

    const started = await startOAuth();
    const authorization = new URL(started.response.body.authorization_url);
    expect(`${authorization.origin}${authorization.pathname}`).toBe(`${provider.origin}/authorize`);
    expect(authorization.searchParams.get("client_id")).toBe("gmail-oauth-test-client");
    expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorization.searchParams.get("scope")).toContain("gmail.readonly");
    expect(started.response.body.authorization_url).not.toContain("gmail-oauth-test-client-secret");

    await request(app)
      .get("/api/mcp/oauth/callback/gmail")
      .set("Cookie", "virenis_mcp_oauth=wrong-browser")
      .query({ state: started.state, code: "code-primary" })
      .expect(403);
    expect(provider.tokenRequests).toHaveLength(0);

    const callback = await finishOAuth(started, "code-primary");
    expect(callback.headers.location).toBe("/app?mcp_oauth=connected&provider=gmail");
    expect(callback.headers["set-cookie"][0]).toContain("Max-Age=0");
    expect(provider.tokenRequests).toHaveLength(1);
    const verifier = provider.tokenRequests[0].code_verifier;
    const expectedChallenge = crypto.createHash("sha256").update(verifier, "ascii").digest("base64url");
    expect(expectedChallenge).toBe(authorization.searchParams.get("code_challenge"));

    const listed = await request(app).get("/api/mcp/connections").set(owner()).expect(200);
    expect(listed.body.connections).toEqual([
      expect.objectContaining({
        name: "Gmail",
        provider_id: "gmail",
        connection_mode: "managed",
        auth_type: "oauth2",
        status: "ready",
        read_policy: "allow_declared_reads",
        has_secret: true
      })
    ]);
    expect(listed.body.connections[0].tools).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "search_mail", risk: "read", requires_approval: false }),
      expect.objectContaining({ name: "create_draft", risk: "write", requires_approval: true })
    ]));
    expect(JSON.stringify(listed.body)).not.toContain("endpoint_url");
    expect(JSON.stringify(listed.body)).not.toContain("access-code-primary");

    const storedText = await fs.readFile(path.join(tmpDir, "db.json"), "utf8");
    for (const secret of ["code-primary", verifier, "access-code-primary", "refresh-code-primary"]) {
      expect(storedText).not.toContain(secret);
    }
    expect(storedText).toContain("aes-256-gcm");

    await request(app)
      .post("/api/mcp/oauth/start")
      .set(owner())
      .send({ provider_id: "gmail" })
      .expect(409);

    await request(app)
      .get("/api/mcp/oauth/callback/gmail")
      .set("Cookie", started.cookie)
      .query({ state: started.state, code: "code-primary" })
      .expect(409);
    expect(provider.tokenRequests).toHaveLength(1);
  });

  it("durably stages the issued credential before discovery and clears the outbox only with the connection commit", async () => {
    const started = await startOAuth();
    let releaseDiscovery;
    provider.mcpGate = new Promise((resolve) => { releaseDiscovery = resolve; });
    provider.mcpReached = new Promise((resolve) => { provider.resolveMcpReached = resolve; });
    const callbackPromise = finishOAuth(started, "code-staged-before-discovery");
    await provider.mcpReached;

    const staged = app.locals.store.read((data) => data.mcpOauthStates
      .find((item) => item.state_digest === digestForTest(started.state)));
    expect(staged).toMatchObject({
      status: "exchanging",
      revocation_envelope: { algorithm: "aes-256-gcm" }
    });
    expect(staged.credential_staged_at).toBeTruthy();
    expect(staged.verifier_envelope).toBeUndefined();
    const storedWhileDiscovering = await fs.readFile(path.join(tmpDir, "db.json"), "utf8");
    expect(storedWhileDiscovering).not.toContain("access-code-staged-before-discovery");
    expect(storedWhileDiscovering).not.toContain("refresh-code-staged-before-discovery");

    releaseDiscovery();
    await callbackPromise;
    const completed = app.locals.store.read((data) => data.mcpOauthStates
      .find((item) => item.oauth_state_id === staged.oauth_state_id));
    expect(completed.status).toBe("completed");
    expect(completed.revocation_envelope).toBeUndefined();
    expect(completed.credential_staged_at).toBeUndefined();
  });

  it("keeps a workflow cancelled when its OAuth callback returns late", async () => {
    const workflowId = "workflow_cancelled_during_oauth";
    const sessionId = "session_cancelled_during_oauth";
    await app.locals.store.mutate((data) => {
      data.workflows ||= [];
      data.workflows.push({
        workflow_id: workflowId,
        session_id: sessionId,
        workspace_id: "oauth_workspace",
        created_by: "oauth_owner",
        status: "awaiting_connections",
        approved_at: new Date().toISOString(),
        revision: 2,
        connection_requirements: [{
          provider_id: "gmail",
          name: "Gmail",
          connection_mode: "managed",
          status: "missing",
          connection_id: null
        }]
      });
      return true;
    });
    const response = await request(app)
      .post("/api/mcp/oauth/start")
      .set(owner())
      .send({ provider_id: "gmail", workflow_id: workflowId })
      .expect(200);
    const cookie = response.headers["set-cookie"][0].split(";", 1)[0];
    const state = new URL(response.body.authorization_url).searchParams.get("state");
    await app.locals.store.mutate((data) => {
      const workflow = data.workflows.find((item) => item.workflow_id === workflowId);
      workflow.status = "declined";
      workflow.declined_at = new Date().toISOString();
      workflow.revision += 1;
      return workflow;
    });
    const callback = await request(app)
      .get("/api/mcp/oauth/callback/gmail")
      .set("Cookie", cookie)
      .query({ state, code: "code-late-workflow" })
      .expect(303);
    expect(callback.headers.location).toBe(
      `/app?mcp_oauth=connected&provider=gmail&workflow=${workflowId}&session=${sessionId}`
    );
    expect(app.locals.store.read((data) => data.workflows.find((item) => item.workflow_id === workflowId).status)).toBe("declined");
    const listed = await request(app).get("/api/mcp/connections").set(owner()).expect(200);
    expect(listed.body.connections).toEqual([
      expect.objectContaining({ provider_id: "gmail", status: "ready" })
    ]);
  });

  it("supersedes an older browser flow so concurrent starts cannot create duplicate accounts", async () => {
    const first = await startOAuth();
    const second = await startOAuth();
    await request(app)
      .get("/api/mcp/oauth/callback/gmail")
      .set("Cookie", first.cookie)
      .query({ state: first.state, code: "code-superseded" })
      .expect(409);
    await finishOAuth(second, "code-current");
    expect(provider.tokenRequests).toHaveLength(1);
    const listed = await request(app).get("/api/mcp/connections").set(owner()).expect(200);
    expect(listed.body.connections).toHaveLength(1);
  });

  it("rejects a partial Google permission grant and revokes the unusable credential", async () => {
    provider.partialScope = true;
    const started = await startOAuth();
    const callback = await finishOAuth(started, "code-partial");
    expect(callback.headers.location).toBe("/app?mcp_oauth=error&reason=failed");
    expect(provider.revocations).toContain("refresh-code-partial");
    const listed = await request(app).get("/api/mcp/connections").set(owner()).expect(200);
    expect(listed.body.connections).toEqual([]);
  });

  it("revokes and stores no credential when account deletion wins the OAuth commit race", async () => {
    const started = await startOAuth();
    let releaseTokenResponse;
    provider.tokenGate = new Promise((resolve) => { releaseTokenResponse = resolve; });
    provider.tokenReached = new Promise((resolve) => { provider.resolveTokenReached = resolve; });

    const callbackPromise = finishOAuth(started, "code-delete-race");
    await provider.tokenReached;
    await app.locals.store.mutate((data) => {
      const transaction = data.mcpOauthStates.find((item) => item.state_digest === digestForTest(started.state));
      transaction.status = "account_deleting";
      transaction.failed_at = new Date().toISOString();
      delete transaction.verifier_envelope;
      return transaction;
    });
    releaseTokenResponse();

    const callback = await callbackPromise;
    expect(callback.headers.location).toBe("/app?mcp_oauth=error&reason=failed");
    expect(provider.revocations).toContain("refresh-code-delete-race");
    expect(app.locals.store.read().mcpConnections).toEqual([]);
    const storedText = await fs.readFile(path.join(tmpDir, "db.json"), "utf8");
    expect(storedText).not.toContain("access-code-delete-race");
    expect(storedText).not.toContain("refresh-code-delete-race");
  });

  it("durably queues an exchanged credential when deletion-race revocation fails, then retries it", async () => {
    const started = await startOAuth();
    let releaseTokenResponse;
    provider.failRevoke = true;
    provider.tokenGate = new Promise((resolve) => { releaseTokenResponse = resolve; });
    provider.tokenReached = new Promise((resolve) => { provider.resolveTokenReached = resolve; });

    const callbackPromise = finishOAuth(started, "code-delete-revoke-retry");
    await provider.tokenReached;
    await app.locals.store.mutate((data) => {
      const transaction = data.mcpOauthStates.find((item) => item.state_digest === digestForTest(started.state));
      transaction.status = "account_deleting";
      transaction.failed_at = new Date().toISOString();
      delete transaction.verifier_envelope;
      return transaction;
    });
    releaseTokenResponse();
    const callback = await callbackPromise;
    expect(callback.headers.location).toBe("/app?mcp_oauth=error&reason=failed");

    const pending = app.locals.store.read().mcpOauthStates.find((item) => item.state_digest === digestForTest(started.state));
    expect(pending).toMatchObject({
      status: "revocation_pending",
      revocation_attempts: 1,
      revocation_last_error_code: "mcp_oauth_provider_error"
    });
    expect(pending.revocation_envelope).toMatchObject({ algorithm: "aes-256-gcm" });
    const storedBeforeRetry = await fs.readFile(path.join(tmpDir, "db.json"), "utf8");
    expect(storedBeforeRetry).not.toContain("access-code-delete-revoke-retry");
    expect(storedBeforeRetry).not.toContain("refresh-code-delete-revoke-retry");

    provider.failRevoke = false;
    await revokePendingMcpOAuthState(pending, {
      key: app.locals.mcpCredentialKey,
      store: app.locals.store
    });
    const revoked = app.locals.store.read().mcpOauthStates.find((item) => item.oauth_state_id === pending.oauth_state_id);
    expect(revoked.status).toBe("revoked");
    expect(revoked.revocation_envelope).toBeUndefined();
    expect(revoked.revoked_at).toBeTruthy();
    expect(provider.revocations.filter((token) => token === "refresh-code-delete-revoke-retry")).toHaveLength(2);
  });

  it("hides a disconnected account atomically, retains failed revocation material, and supports recovery or audited resolution", async () => {
    const connected = await connectOAuth("code-durable-disconnect");
    const raw = app.locals.store.read((data) => data.mcpConnections
      .find((item) => item.connection_id === connected.connection_id));
    await app.locals.store.mutate((data) => {
      data.agents.push({
        id: "agent_atomic_disconnect_binding",
        title: "Atomic disconnect binding",
        workspace_id: raw.workspace_id,
        created_by: raw.created_by,
        mcp_bindings: [{ connection_id: raw.connection_id, tool_names: ["search_mail"] }]
      });
      return true;
    });
    await expect(disconnectMcpConnectionDurably(raw, {
      key: app.locals.mcpCredentialKey,
      store: app.locals.store
    })).rejects.toMatchObject({ code: "mcp_connection_bound" });
    expect(app.locals.store.read().mcpConnections).toHaveLength(1);
    await app.locals.store.mutate((data) => {
      data.agents = data.agents.filter((item) => item.id !== "agent_atomic_disconnect_binding");
      return true;
    });
    provider.failRevoke = true;
    const disconnected = await disconnectMcpConnectionDurably(raw, {
      key: app.locals.mcpCredentialKey,
      store: app.locals.store
    });
    expect(disconnected).toMatchObject({
      provider_revoked: false,
      revocation: { status: "revocation_pending", attempts: 1 }
    });
    expect(app.locals.store.read().mcpConnections).toEqual([]);
    const pending = app.locals.store.read().mcpOauthStates
      .find((item) => item.source_connection_id === connected.connection_id);
    expect(pending.revocation_envelope).toMatchObject({ algorithm: "aes-256-gcm" });
    const persisted = await fs.readFile(path.join(tmpDir, "db.json"), "utf8");
    expect(persisted).not.toContain("refresh-code-durable-disconnect");

    provider.failRevoke = false;
    await app.locals.store.mutate((data) => {
      const queued = data.mcpOauthStates.find((item) => item.oauth_state_id === pending.oauth_state_id);
      queued.revocation_next_attempt_at = new Date(0).toISOString();
      return queued;
    });
    expect(await recoverMcpOAuthRevocations({
      store: app.locals.store,
      key: app.locals.mcpCredentialKey
    })).toEqual([{ revocation_id: pending.oauth_state_id, status: "revoked" }]);
    expect(app.locals.store.read().mcpOauthStates
      .find((item) => item.oauth_state_id === pending.oauth_state_id).revocation_envelope).toBeUndefined();

    const second = await connectOAuth("code-manual-resolution");
    const secondRaw = app.locals.store.read((data) => data.mcpConnections
      .find((item) => item.connection_id === second.connection_id));
    provider.failRevoke = true;
    const secondDisconnect = await disconnectMcpConnectionDurably(secondRaw, {
      key: app.locals.mcpCredentialKey,
      store: app.locals.store
    });
    const resolved = await attestMcpOAuthRevocationResolved({
      store: app.locals.store,
      actor: { user_id: "oauth_owner", workspace_id: "oauth_workspace", role: "admin" },
      revocationId: secondDisconnect.revocation.revocation_id,
      confirmation: "PROVIDER_ACCESS_REVOKED",
      evidenceReference: "provider-security-console-ticket-42",
      reason: "Provider security console confirms the app grant was removed."
    });
    expect(resolved.status).toBe("revocation_manually_resolved");
    const snapshot = app.locals.store.read();
    expect(snapshot.mcpOauthStates.find((item) => item.oauth_state_id === resolved.revocation_id).revocation_envelope).toBeUndefined();
    expect(snapshot.identityAuditEvents.at(-1)).toMatchObject({
      type: "mcp.oauth_revocation.manually_resolved",
      actor_user_id: "oauth_owner",
      workspace_id: "oauth_workspace"
    });
    expect(JSON.stringify(snapshot.identityAuditEvents.at(-1))).not.toContain("provider-security-console-ticket-42");
  });

  it("does not let a failed queue head starve never-attempted revocations and honors retry backoff", async () => {
    provider.failRevokeTokens.add("refresh-fairness-head");
    const failedHead = await queueTestRevocation({
      id: "mcprevoke_fairness_head",
      refreshToken: "refresh-fairness-head",
      queuedAt: "2026-01-01T00:00:00.000Z"
    });

    expect(await recoverMcpOAuthRevocations({
      store: app.locals.store,
      key: app.locals.mcpCredentialKey,
      limit: 1
    })).toEqual([{
      revocation_id: failedHead.oauth_state_id,
      status: "revocation_pending",
      error_code: "mcp_oauth_provider_error"
    }]);
    const backedOff = app.locals.store.read((data) => data.mcpOauthStates
      .find((item) => item.oauth_state_id === failedHead.oauth_state_id));
    expect(backedOff.revocation_attempts).toBe(1);
    expect(Date.parse(backedOff.revocation_next_attempt_at)).toBeGreaterThan(Date.now());
    const originalNextAttempt = backedOff.revocation_next_attempt_at;

    for (let index = 1; index <= 3; index += 1) {
      await queueTestRevocation({
        id: `mcprevoke_fairness_later_${index}`,
        refreshToken: `refresh-fairness-later-${index}`,
        queuedAt: `2026-01-0${index + 1}T00:00:00.000Z`
      });
    }
    expect(app.locals.store.read((data) => data.mcpOauthStates
      .filter((item) => item.status === "revocation_pending"))).toHaveLength(4);

    const firstFairBatch = await recoverMcpOAuthRevocations({
      store: app.locals.store,
      key: app.locals.mcpCredentialKey,
      limit: 2
    });
    expect(firstFairBatch).toEqual([
      { revocation_id: "mcprevoke_fairness_later_1", status: "revoked" },
      { revocation_id: "mcprevoke_fairness_later_2", status: "revoked" }
    ]);
    const secondFairBatch = await recoverMcpOAuthRevocations({
      store: app.locals.store,
      key: app.locals.mcpCredentialKey,
      limit: 2
    });
    expect(secondFairBatch).toEqual([
      { revocation_id: "mcprevoke_fairness_later_3", status: "revoked" }
    ]);
    const stillBackedOff = app.locals.store.read((data) => data.mcpOauthStates
      .find((item) => item.oauth_state_id === failedHead.oauth_state_id));
    expect(stillBackedOff).toMatchObject({
      status: "revocation_pending",
      revocation_attempts: 1,
      revocation_next_attempt_at: originalNextAttempt
    });
    expect(provider.revocations.filter((token) => token === "refresh-fairness-head")).toHaveLength(1);
    for (let index = 1; index <= 3; index += 1) {
      expect(provider.revocations.filter((token) => token === `refresh-fairness-later-${index}`)).toHaveLength(1);
    }
  });

  it("requires an administrator, strong confirmation, evidence, and staleness to resolve an uncertain exchange", async () => {
    const fresh = await queueTestRevocation({
      id: "mcpoauth_uncertain_fresh",
      status: "account_deleting",
      withEnvelope: false,
      exchangeStartedAt: new Date().toISOString()
    });
    const stale = await queueTestRevocation({
      id: "mcpoauth_uncertain_stale",
      status: "account_deleting",
      withEnvelope: false,
      exchangeStartedAt: new Date(Date.now() - 21 * 60 * 1000).toISOString()
    });

    const ownerList = await request(app).get("/api/mcp/revocations").set(owner()).expect(200);
    expect(ownerList.headers["cache-control"]).toBe("private, no-store");
    expect(ownerList.body.revocations).toEqual([]);
    const adminList = await request(app).get("/api/mcp/revocations").set(admin()).expect(200);
    expect(adminList.body.revocations).toEqual([
      expect.objectContaining({
        revocation_id: stale.oauth_state_id,
        status: "account_deleting",
        manual_resolution_required: true
      })
    ]);
    expect(JSON.stringify(adminList.body)).not.toContain("revocation_envelope");

    const resolution = {
      confirmation: "PROVIDER_APP_ACCESS_REVOKED_AND_VERIFIED",
      evidence_reference: "provider-admin-audit-case-7001",
      reason: "The provider console shows that the complete application grant was removed."
    };
    const forbidden = await request(app)
      .post(`/api/admin/mcp/revocations/${stale.oauth_state_id}/resolve`)
      .set(owner())
      .send(resolution)
      .expect(403);
    expect(forbidden.body.error).toBe("mcp_revocation_resolution_forbidden");

    const active = await request(app)
      .post(`/api/admin/mcp/revocations/${fresh.oauth_state_id}/resolve`)
      .set(admin())
      .send(resolution)
      .expect(409);
    expect(active.body.error).toBe("mcp_revocation_not_pending");

    const weak = await request(app)
      .post(`/api/admin/mcp/revocations/${stale.oauth_state_id}/resolve`)
      .set(admin())
      .send({ ...resolution, confirmation: "PROVIDER_ACCESS_REVOKED" })
      .expect(400);
    expect(weak.body.error).toBe("mcp_revocation_resolution_confirmation_required");
    const noEvidence = await request(app)
      .post(`/api/admin/mcp/revocations/${stale.oauth_state_id}/resolve`)
      .set(admin())
      .send({ ...resolution, evidence_reference: "" })
      .expect(400);
    expect(noEvidence.body.error).toBeTruthy();

    const resolved = await request(app)
      .post(`/api/admin/mcp/revocations/${stale.oauth_state_id}/resolve`)
      .set(admin())
      .send(resolution)
      .expect(200);
    expect(resolved.headers["cache-control"]).toBe("private, no-store");
    expect(resolved.body).toMatchObject({
      ok: true,
      revocation: {
        revocation_id: stale.oauth_state_id,
        status: "revocation_manually_resolved",
        manual_resolution_required: false
      }
    });
    expect(JSON.stringify(resolved.body)).not.toContain(resolution.evidence_reference);
    expect((await request(app).get("/api/mcp/revocations").set(admin()).expect(200)).body.revocations).toEqual([]);
  });

  it("rejects a truncated authorization-code response promptly and records an uncertain exchange", async () => {
    const code = "code-aborted-token-response";
    provider.abortAuthorizationCodes.add(code);
    const started = await startOAuth();
    const callbackRequest = request(app)
      .get("/api/mcp/oauth/callback/gmail")
      .set("Cookie", started.cookie)
      .query({ state: started.state, code });
    const outcome = await settleWithin(callbackRequest);
    if (outcome.status === "timeout") callbackRequest.abort();

    expect.soft(outcome.status).toBe("fulfilled");
    if (outcome.status === "fulfilled") {
      expect.soft(outcome.value.status).toBe(303);
      expect.soft(outcome.value.headers.location).toBe("/app?mcp_oauth=error&reason=failed");
    }
    const state = app.locals.store.read((data) => data.mcpOauthStates
      .find((item) => item.state_digest === digestForTest(started.state)));
    expect.soft(state?.status).toBe("exchange_outcome_uncertain");
    expect.soft(state?.uncertain_error_code).toBeTruthy();
    expect.soft(state?.verifier_envelope).toBeUndefined();
    expect.soft(state?.revocation_envelope).toBeUndefined();
    expect.soft(app.locals.store.read().mcpConnections).toEqual([]);
    expect.soft(provider.tokenRequests.filter((item) => item.code === code)).toHaveLength(1);
  });

  it("promotes a stale no-envelope exchange to an admin-visible uncertain outcome while leaving a fresh exchange active", async () => {
    const staleStartedAt = new Date(Date.now() - 21 * 60 * 1000).toISOString();
    const freshStartedAt = new Date().toISOString();
    await app.locals.store.mutate((data) => {
      data.mcpOauthStates.push(
        {
          oauth_state_id: "mcpoauth_restart_exchange_stale",
          provider_id: "gmail",
          status: "exchanging",
          workspace_id: "oauth_workspace",
          created_by: "oauth_owner",
          created_at: staleStartedAt,
          exchange_started_at: staleStartedAt
        },
        {
          oauth_state_id: "mcpoauth_restart_exchange_fresh",
          provider_id: "gmail",
          status: "exchanging",
          workspace_id: "oauth_workspace",
          created_by: "oauth_owner",
          created_at: freshStartedAt,
          exchange_started_at: freshStartedAt
        }
      );
      return true;
    });

    await queueStaleMcpOAuthRevocations({
      store: app.locals.store,
      includeStrandedExchanges: true,
      staleBefore: new Date(Date.now() - 20 * 60 * 1000).toISOString()
    });
    const snapshot = app.locals.store.read();
    const stale = snapshot.mcpOauthStates
      .find((item) => item.oauth_state_id === "mcpoauth_restart_exchange_stale");
    const fresh = snapshot.mcpOauthStates
      .find((item) => item.oauth_state_id === "mcpoauth_restart_exchange_fresh");
    expect(stale).toMatchObject({
      status: "exchange_outcome_uncertain",
      uncertain_started_at: staleStartedAt
    });
    expect(stale.revocation_envelope).toBeUndefined();
    expect(stale.verifier_envelope).toBeUndefined();
    expect(fresh.status).toBe("exchanging");

    const ownerList = await request(app).get("/api/mcp/revocations").set(owner()).expect(200);
    expect(ownerList.body.revocations).toEqual([]);
    const adminList = await request(app).get("/api/mcp/revocations").set(admin()).expect(200);
    expect(adminList.body.revocations).toEqual([
      expect.objectContaining({
        revocation_id: stale.oauth_state_id,
        status: "exchange_outcome_uncertain",
        manual_resolution_required: true
      })
    ]);
    const resolved = await request(app)
      .post(`/api/admin/mcp/revocations/${stale.oauth_state_id}/resolve`)
      .set(admin())
      .send({
        confirmation: "PROVIDER_APP_ACCESS_REVOKED_AND_VERIFIED",
        evidence_reference: "provider-restart-exchange-case-1201",
        reason: "Provider-wide deauthorization resolves the response-loss uncertainty after process restart."
      })
      .expect(200);
    expect(resolved.body.revocation.status).toBe("revocation_manually_resolved");
  });

  it("rejects a truncated refresh response promptly without accepting or overwriting a credential", async () => {
    const connected = await connectOAuth("code-before-aborted-refresh");
    await expireStoredCredential(connected.connection_id);
    const before = app.locals.store.read((data) => data.mcpConnections
      .find((item) => item.connection_id === connected.connection_id));
    provider.abortRefreshTokens.add("refresh-code-before-aborted-refresh");
    const refreshRequest = request(app)
      .post(`/api/mcp/connections/${connected.connection_id}/refresh`)
      .set(owner())
      .send({});
    const outcome = await settleWithin(refreshRequest);
    if (outcome.status === "timeout") refreshRequest.abort();

    expect.soft(outcome.status).toBe("fulfilled");
    if (outcome.status === "fulfilled") {
      expect.soft(outcome.value.status).toBe(409);
      expect.soft(outcome.value.body.error).toBe("mcp_oauth_reauthorization_required");
    }
    const snapshot = app.locals.store.read();
    const current = snapshot.mcpConnections.find((item) => item.connection_id === connected.connection_id);
    const uncertain = snapshot.mcpOauthStates.find((item) => (
      item.source_connection_id === connected.connection_id
      && item.status === "refresh_outcome_uncertain"
    ));
    expect.soft(current?.status).toBe("reauthorization_required");
    expect.soft(current?.credential).toEqual(before.credential);
    expect.soft(uncertain).toMatchObject({
      workspace_id: "oauth_workspace",
      created_by: "oauth_owner",
      provider_id: "gmail"
    });
    expect.soft(uncertain?.revocation_envelope).toBeUndefined();
    expect.soft(provider.tokenRequests.filter((item) => item.grant_type === "refresh_token")).toHaveLength(1);
  });

  it("persists an exact refresh intent before the provider request and removes it with the successful credential commit", async () => {
    const connected = await connectOAuth("code-refresh-intent-success");
    await expireStoredCredential(connected.connection_id);
    const before = app.locals.store.read((data) => data.mcpConnections
      .find((item) => item.connection_id === connected.connection_id));
    const expectedDigest = canonicalDigestForTest(before.credential);
    let releaseTokenResponse;
    provider.tokenGate = new Promise((resolve) => { releaseTokenResponse = resolve; });
    provider.tokenReached = new Promise((resolve) => { provider.resolveTokenReached = resolve; });
    const refreshPromise = request(app)
      .post(`/api/mcp/connections/${connected.connection_id}/refresh`)
      .set(owner())
      .send({})
      .then((response) => response);
    await provider.tokenReached;

    const intent = app.locals.store.read((data) => data.mcpOauthStates.find((item) => (
      item.source_connection_id === connected.connection_id
      && item.status === "refreshing"
    )));
    expect.soft(intent).toMatchObject({
      provider_id: "gmail",
      workspace_id: "oauth_workspace",
      created_by: "oauth_owner",
      source_credential_revision_digest: expectedDigest
    });
    expect.soft(intent?.refresh_started_at).toBeTruthy();
    expect.soft(intent?.revocation_envelope).toBeUndefined();
    releaseTokenResponse();

    const refreshed = await refreshPromise;
    expect(refreshed.status).toBe(200);
    const after = app.locals.store.read();
    expect(after.mcpOauthStates.some((item) => (
      item.source_connection_id === connected.connection_id
      && item.status === "refreshing"
    ))).toBe(false);
    expect(after.mcpConnections.find((item) => item.connection_id === connected.connection_id).credential)
      .not.toEqual(before.credential);
  });

  it("atomically replaces a refresh intent with a known CAS-loss outbox", async () => {
    const connected = await connectOAuth("code-refresh-intent-cas");
    await expireStoredCredential(connected.connection_id);
    let releaseTokenResponse;
    provider.tokenGate = new Promise((resolve) => { releaseTokenResponse = resolve; });
    provider.tokenReached = new Promise((resolve) => { provider.resolveTokenReached = resolve; });
    const refreshPromise = request(app)
      .post(`/api/mcp/connections/${connected.connection_id}/refresh`)
      .set(owner())
      .send({})
      .then((response) => response);
    await provider.tokenReached;
    const intent = app.locals.store.read((data) => data.mcpOauthStates.find((item) => (
      item.source_connection_id === connected.connection_id
      && item.status === "refreshing"
    )));
    expect.soft(intent).toBeTruthy();

    let winningCredential;
    await app.locals.store.mutate((data) => {
      const connection = data.mcpConnections.find((item) => item.connection_id === connected.connection_id);
      const aad = `mcp-connection:v1:${connection.workspace_id}:${connection.connection_id}`;
      const credential = decryptMcpValue(connection.credential, app.locals.mcpCredentialKey, aad);
      credential.access_token = "access-refresh-intent-cas-winner";
      credential.refresh_token = "refresh-refresh-intent-cas-winner";
      credential.expires_at = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      winningCredential = encryptMcpValue(credential, app.locals.mcpCredentialKey, aad);
      connection.credential = winningCredential;
      connection.status = "ready";
      return connection;
    });
    releaseTokenResponse();

    const failed = await refreshPromise;
    expect(failed.status).toBe(409);
    expect(failed.body.error).toBe("mcp_connection_changed");
    const snapshot = app.locals.store.read();
    expect(snapshot.mcpOauthStates.some((item) => (
      item.source_connection_id === connected.connection_id
      && item.status === "refreshing"
    ))).toBe(false);
    expect(snapshot.mcpOauthStates).toContainEqual(expect.objectContaining({
      source_connection_id: connected.connection_id,
      revocation_reason: "refresh_compare_and_swap_lost",
      status: "revoked"
    }));
    expect(snapshot.mcpConnections.find((item) => item.connection_id === connected.connection_id)).toMatchObject({
      credential: winningCredential,
      status: "reauthorization_required"
    });
  });

  it("promotes a stale exact-credential refresh intent to an uncertain outcome that blocks reauthorization", async () => {
    const connected = await connectOAuth("code-stale-refresh-intent");
    const staleStartedAt = new Date(Date.now() - 21 * 60 * 1000).toISOString();
    await app.locals.store.mutate((data) => {
      const connection = data.mcpConnections.find((item) => item.connection_id === connected.connection_id);
      connection.status = "reauthorization_required";
      data.mcpOauthStates.push({
        oauth_state_id: "mcprefresh_restart_stale",
        provider_id: "gmail",
        status: "refreshing",
        workspace_id: connection.workspace_id,
        created_by: connection.created_by,
        connection_id: null,
        source_connection_id: connection.connection_id,
        source_credential_revision_digest: canonicalDigestForTest(connection.credential),
        created_at: staleStartedAt,
        refresh_started_at: staleStartedAt
      });
      return true;
    });

    await queueStaleMcpOAuthRevocations({
      store: app.locals.store,
      includeStrandedExchanges: true,
      staleBefore: new Date(Date.now() - 20 * 60 * 1000).toISOString()
    });
    const uncertain = app.locals.store.read((data) => data.mcpOauthStates
      .find((item) => item.oauth_state_id === "mcprefresh_restart_stale"));
    expect(uncertain).toMatchObject({
      status: "refresh_outcome_uncertain",
      uncertain_started_at: staleStartedAt
    });
    expect(uncertain.revocation_envelope).toBeUndefined();
    const adminList = await request(app).get("/api/mcp/revocations").set(admin()).expect(200);
    expect(adminList.body.revocations).toContainEqual(expect.objectContaining({
      revocation_id: uncertain.oauth_state_id,
      status: "refresh_outcome_uncertain",
      manual_resolution_required: true
    }));
    const blocked = await request(app)
      .post("/api/mcp/oauth/start")
      .set(owner())
      .send({ provider_id: "gmail", connection_id: connected.connection_id })
      .expect(409);
    expect(blocked.body.error).toBe("mcp_oauth_outcome_uncertain");
  });

  it("rejects a truncated revocation response promptly and retains a retryable disconnect outbox", async () => {
    const connected = await connectOAuth("code-before-aborted-revocation");
    const refreshToken = "refresh-code-before-aborted-revocation";
    provider.abortRevocationTokens.add(refreshToken);
    const disconnectRequest = request(app)
      .delete(`/api/mcp/connections/${connected.connection_id}`)
      .set(owner());
    const outcome = await settleWithin(disconnectRequest);
    if (outcome.status === "timeout") disconnectRequest.abort();

    expect.soft(outcome.status).toBe("fulfilled");
    if (outcome.status === "fulfilled") {
      expect.soft(outcome.value.status).toBe(202);
      expect.soft(outcome.value.body).toMatchObject({
        provider_revoked: false,
        revocation_pending: true,
        revocation: { status: "revocation_pending", attempts: 1 }
      });
    }
    const snapshot = app.locals.store.read();
    const pending = snapshot.mcpOauthStates.find((item) => (
      item.source_connection_id === connected.connection_id
      && item.revocation_reason === "connection_disconnected"
    ));
    expect.soft(snapshot.mcpConnections
      .some((item) => item.connection_id === connected.connection_id && item.workspace_id === "oauth_workspace")).toBe(false);
    expect.soft(pending).toMatchObject({
      status: "revocation_pending",
      revocation_attempts: 1,
      revocation_envelope: { algorithm: "aes-256-gcm" }
    });
    expect.soft(pending?.revocation_confirmed_token_ids || []).toEqual([]);
    expect.soft(provider.revocations.filter((token) => token === refreshToken)).toHaveLength(1);
  });

  it("does not resurrect a retired credential through explicit refresh during abandoned reauthorization", async () => {
    const connected = await connectOAuth("code-retired-refresh-guard");
    await app.locals.store.mutate((data) => {
      const connection = data.mcpConnections.find((item) => item.connection_id === connected.connection_id);
      connection.status = "reauthorization_required";
      return connection;
    });
    await startOAuth(connected.connection_id);
    const before = app.locals.store.read((data) => data.mcpConnections
      .find((item) => item.connection_id === connected.connection_id));
    expect(before.status).toBe("reauthorization_pending");
    const authorizationCount = provider.mcpAuthorization.length;
    const tokenRequestCount = provider.tokenRequests.length;

    const blocked = await request(app)
      .post(`/api/mcp/connections/${connected.connection_id}/refresh`)
      .set(owner())
      .send({})
      .expect(409);
    expect(blocked.body.error).toBe("mcp_oauth_reauthorization_required");
    const after = app.locals.store.read((data) => data.mcpConnections
      .find((item) => item.connection_id === connected.connection_id));
    expect(after).toMatchObject({
      status: "reauthorization_pending",
      credential: before.credential
    });
    expect(provider.mcpAuthorization).toHaveLength(authorizationCount);
    expect(provider.tokenRequests).toHaveLength(tokenRequestCount);
  });

  it("reuses an exact terminal preflight receipt when abandoned reauthorization is disconnected", async () => {
    const connected = await connectOAuth("code-abandoned-reauth");
    await app.locals.store.mutate((data) => {
      const connection = data.mcpConnections.find((item) => item.connection_id === connected.connection_id);
      connection.status = "reauthorization_required";
      return connection;
    });
    const abandoned = await startOAuth(connected.connection_id);
    const beforeDisconnect = app.locals.store.read();
    const current = beforeDisconnect.mcpConnections
      .find((item) => item.connection_id === connected.connection_id);
    const terminalReceipt = beforeDisconnect.mcpOauthStates.find((item) => (
      item.source_connection_id === connected.connection_id
      && item.revocation_reason === "reauthorization_preflight"
    ));
    expect(terminalReceipt).toMatchObject({
      status: "revoked",
      source_credential_revision_digest: canonicalDigestForTest(current.credential)
    });
    expect(provider.revocations.filter((token) => token === "refresh-code-abandoned-reauth")).toHaveLength(1);

    const disconnected = await disconnectMcpConnectionDurably(current, {
      key: app.locals.mcpCredentialKey,
      store: app.locals.store
    });
    expect(disconnected).toMatchObject({
      provider_revoked: true,
      revocation: {
        revocation_id: terminalReceipt.oauth_state_id,
        status: "revoked"
      }
    });
    expect(provider.revocations.filter((token) => token === "refresh-code-abandoned-reauth")).toHaveLength(1);
    const afterDisconnect = app.locals.store.read();
    expect(afterDisconnect.mcpConnections).toEqual([]);
    expect(afterDisconnect.mcpOauthStates
      .find((item) => item.state_digest === digestForTest(abandoned.state)).status).toBe("disconnect_cancelled");
    expect(afterDisconnect.mcpOauthStates.filter((item) => (
      item.source_connection_id === connected.connection_id
      && item.revocation_reason === "connection_disconnected"
    ))).toEqual([]);
  });

  it("reuses a manually resolved exact refresh-uncertain receipt during disconnect", async () => {
    const connected = await connectOAuth("code-manual-refresh-uncertain");
    let current;
    const uncertainId = "mcpuncertain_manual_refresh_disconnect";
    await app.locals.store.mutate((data) => {
      current = data.mcpConnections.find((item) => item.connection_id === connected.connection_id);
      current.status = "reauthorization_required";
      data.mcpOauthStates.push({
        oauth_state_id: uncertainId,
        provider_id: "gmail",
        status: "refresh_outcome_uncertain",
        workspace_id: current.workspace_id,
        created_by: current.created_by,
        connection_id: null,
        source_connection_id: current.connection_id,
        source_credential_revision_digest: canonicalDigestForTest(current.credential),
        created_at: new Date(Date.now() - 21 * 60 * 1000).toISOString(),
        uncertain_started_at: new Date(Date.now() - 21 * 60 * 1000).toISOString(),
        uncertain_error_code: "mcp_oauth_connection_failed"
      });
      return true;
    });
    const resolved = await attestMcpOAuthRevocationResolved({
      store: app.locals.store,
      actor: { user_id: "oauth_admin", workspace_id: "oauth_workspace", role: "admin" },
      revocationId: uncertainId,
      confirmation: "PROVIDER_APP_ACCESS_REVOKED_AND_VERIFIED",
      evidenceReference: "provider-wide-deauthorization-case-1102",
      reason: "Provider-wide deauthorization proves that the uncertain refresh grant and original grant are inactive."
    });
    expect(resolved.status).toBe("revocation_manually_resolved");
    const revocationsBefore = provider.revocations.length;

    const disconnected = await disconnectMcpConnectionDurably(current, {
      key: app.locals.mcpCredentialKey,
      store: app.locals.store
    });
    expect(disconnected).toMatchObject({
      provider_revoked: true,
      revocation: { revocation_id: uncertainId, status: "revocation_manually_resolved" }
    });
    expect(provider.revocations).toHaveLength(revocationsBefore);
    const snapshot = app.locals.store.read();
    expect(snapshot.mcpConnections).toEqual([]);
    expect(snapshot.mcpOauthStates.filter((item) => (
      item.source_connection_id === connected.connection_id
      && item.revocation_reason === "connection_disconnected"
    ))).toEqual([]);
  });

  it("loses the reconnect CAS safely when the credential changes during discovery", async () => {
    const connected = await connectOAuth("code-cas-original");
    await app.locals.store.mutate((data) => {
      const connection = data.mcpConnections.find((item) => item.connection_id === connected.connection_id);
      connection.status = "reauthorization_required";
      return connection;
    });
    const reconnect = await startOAuth(connected.connection_id);
    let releaseDiscovery;
    provider.mcpGate = new Promise((resolve) => { releaseDiscovery = resolve; });
    provider.mcpReached = new Promise((resolve) => { provider.resolveMcpReached = resolve; });
    const callbackPromise = finishOAuth(reconnect, "code-cas-loser");
    await provider.mcpReached;

    let winningEnvelope;
    await app.locals.store.mutate((data) => {
      const connection = data.mcpConnections.find((item) => item.connection_id === connected.connection_id);
      const aad = `mcp-connection:v1:${connection.workspace_id}:${connection.connection_id}`;
      winningEnvelope = encryptMcpValue({
        type: "oauth2",
        access_token: "access-concurrent-winner",
        refresh_token: "refresh-concurrent-winner",
        token_type: "Bearer",
        expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        scope: "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose"
      }, app.locals.mcpCredentialKey, aad);
      connection.credential = winningEnvelope;
      connection.status = "ready";
      connection.updated_at = new Date().toISOString();
      return connection;
    });

    releaseDiscovery();
    const callback = await callbackPromise;
    expect(callback.headers.location).toBe("/app?mcp_oauth=error&reason=failed");
    const snapshot = app.locals.store.read();
    const winner = snapshot.mcpConnections.find((item) => item.connection_id === connected.connection_id);
    expect(winner.credential).toEqual(winningEnvelope);
    // Google's revocation endpoint invalidates the project grant rather than
    // proving that only the losing token is inactive. Preserve the CAS winner's
    // bytes, but quarantine it until the user authorizes the grant again.
    expect(winner.status).toBe("reauthorization_required");
    expect(decryptMcpValue(
      winner.credential,
      app.locals.mcpCredentialKey,
      `mcp-connection:v1:${winner.workspace_id}:${winner.connection_id}`
    )).toMatchObject({ refresh_token: "refresh-concurrent-winner" });
    const losingState = snapshot.mcpOauthStates.find((item) => item.state_digest === digestForTest(reconnect.state));
    expect(losingState.status).toBe("revoked");
    expect(losingState.revocation_envelope).toBeUndefined();
    expect(provider.revocations).toContain("refresh-code-cas-loser");
    expect(provider.revocations).not.toContain("refresh-concurrent-winner");
  });

  it("allows controlled reauthorization only when required and durably retires the superseded credential", async () => {
    const connected = await connectOAuth("code-controlled-old");
    const activeStart = await request(app)
      .post("/api/mcp/oauth/start")
      .set(owner())
      .send({ provider_id: "gmail", connection_id: connected.connection_id })
      .expect(409);
    expect(activeStart.body.error).toBe("mcp_reauthorization_not_required");

    await app.locals.store.mutate((data) => {
      const connection = data.mcpConnections.find((item) => item.connection_id === connected.connection_id);
      connection.status = "reauthorization_required";
      return connection;
    });
    provider.failRevokeTokens.add("refresh-code-controlled-old");
    const blockedStart = await request(app)
      .post("/api/mcp/oauth/start")
      .set(owner())
      .send({ provider_id: "gmail", connection_id: connected.connection_id })
      .expect(502);
    expect(blockedStart.body.error).toBe("mcp_oauth_provider_error");
    const afterFailedPreflight = app.locals.store.read();
    const durableRetirement = afterFailedPreflight.mcpOauthStates.find((item) => (
      item.source_connection_id === connected.connection_id
      && item.revocation_reason === "reauthorization_preflight"
    ));
    expect(durableRetirement).toMatchObject({
      status: "revocation_pending",
      revocation_attempts: 1,
      revocation_envelope: { algorithm: "aes-256-gcm" }
    });
    expect(afterFailedPreflight.mcpConnections
      .find((item) => item.connection_id === connected.connection_id).status).toBe("reauthorization_required");
    expect(provider.revocations.filter((token) => token === "refresh-code-controlled-old")).toHaveLength(1);

    provider.failRevokeTokens.delete("refresh-code-controlled-old");
    const reauthorized = await connectOAuth("code-controlled-new", connected.connection_id);
    expect(reauthorized).toMatchObject({ connection_id: connected.connection_id, status: "ready" });
    const afterCommit = app.locals.store.read();
    const current = afterCommit.mcpConnections.find((item) => item.connection_id === connected.connection_id);
    expect(decryptMcpValue(
      current.credential,
      app.locals.mcpCredentialKey,
      `mcp-connection:v1:${current.workspace_id}:${current.connection_id}`
    )).toMatchObject({ refresh_token: "refresh-code-controlled-new" });
    expect(afterCommit.mcpOauthStates
      .find((item) => item.oauth_state_id === durableRetirement.oauth_state_id)).toMatchObject({
      status: "revoked"
    });
    expect(afterCommit.mcpOauthStates
      .find((item) => item.oauth_state_id === durableRetirement.oauth_state_id).revocation_envelope).toBeUndefined();
    expect(provider.revocations.filter((token) => token === "refresh-code-controlled-old")).toHaveLength(2);
  });

  it("keeps identical connection ids isolated across workspaces during disconnect", async () => {
    const connected = await connectOAuth("code-connection-collision-owner");
    const ownerConnection = app.locals.store.read((data) => data.mcpConnections
      .find((item) => item.connection_id === connected.connection_id));
    const alienCredential = {
      type: "oauth2",
      access_token: "access-connection-collision-alien",
      refresh_token: "refresh-connection-collision-alien",
      token_type: "Bearer",
      expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      scope: "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose"
    };
    await app.locals.store.mutate((data) => {
      data.mcpConnections.push({
        ...ownerConnection,
        workspace_id: "alien_workspace",
        created_by: "oauth_alien",
        credential: encryptMcpValue(
          alienCredential,
          app.locals.mcpCredentialKey,
          `mcp-connection:v1:alien_workspace:${ownerConnection.connection_id}`
        )
      });
      return true;
    });
    expect((await request(app).get("/api/mcp/connections").set(alien()).expect(200)).body.connections)
      .toEqual([expect.objectContaining({ connection_id: connected.connection_id })]);

    await request(app)
      .delete(`/api/mcp/connections/${connected.connection_id}`)
      .set(owner())
      .expect(200);
    const remaining = app.locals.store.read((data) => data.mcpConnections);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toMatchObject({
      connection_id: connected.connection_id,
      workspace_id: "alien_workspace",
      created_by: "oauth_alien"
    });
    expect(decryptMcpValue(
      remaining[0].credential,
      app.locals.mcpCredentialKey,
      `mcp-connection:v1:alien_workspace:${connected.connection_id}`
    )).toMatchObject({ refresh_token: "refresh-connection-collision-alien" });
    expect(provider.revocations).toContain("refresh-code-connection-collision-owner");
    expect(provider.revocations).not.toContain("refresh-connection-collision-alien");
  });

  it("scopes revocation list, retry, and admin resolution APIs despite colliding state ids", async () => {
    const retryId = "mcprevoke_api_collision_retry";
    await queueTestRevocation({
      id: retryId,
      refreshToken: "refresh-api-owner",
      workspaceId: "oauth_workspace",
      createdBy: "oauth_owner"
    });
    await queueTestRevocation({
      id: retryId,
      refreshToken: "refresh-api-alien",
      workspaceId: "alien_workspace",
      createdBy: "oauth_alien"
    });

    expect((await request(app).get("/api/mcp/revocations").set(other()).expect(200)).body.revocations).toEqual([]);
    expect((await request(app).get("/api/mcp/revocations").set(owner()).expect(200)).body.revocations)
      .toEqual([expect.objectContaining({ revocation_id: retryId, status: "revocation_pending" })]);
    expect((await request(app).get("/api/mcp/revocations").set(alien()).expect(200)).body.revocations)
      .toEqual([expect.objectContaining({ revocation_id: retryId, status: "revocation_pending" })]);
    expect((await request(app).get("/api/mcp/revocations").set(admin()).expect(200)).body.revocations)
      .toEqual([expect.objectContaining({ revocation_id: retryId })]);
    await request(app).post(`/api/mcp/revocations/${retryId}/retry`).set(other()).send({}).expect(404);

    const retried = await request(app)
      .post(`/api/mcp/revocations/${retryId}/retry`)
      .set(owner())
      .send({})
      .expect(200);
    expect(retried.headers["cache-control"]).toBe("private, no-store");
    expect(retried.body).toMatchObject({
      ok: true,
      revocation: { revocation_id: retryId, status: "revoked" }
    });
    const afterRetry = app.locals.store.read((data) => data.mcpOauthStates
      .filter((item) => item.oauth_state_id === retryId));
    expect(afterRetry.find((item) => item.workspace_id === "oauth_workspace").status).toBe("revoked");
    expect(afterRetry.find((item) => item.workspace_id === "alien_workspace").status).toBe("revocation_pending");
    expect(provider.revocations).toContain("refresh-api-owner");
    expect(provider.revocations).not.toContain("refresh-api-alien");

    const resolveId = "mcprevoke_api_collision_resolve";
    await queueTestRevocation({
      id: resolveId,
      refreshToken: "refresh-resolve-owner",
      workspaceId: "oauth_workspace",
      createdBy: "oauth_owner"
    });
    await queueTestRevocation({
      id: resolveId,
      refreshToken: "refresh-resolve-alien",
      workspaceId: "alien_workspace",
      createdBy: "oauth_alien"
    });
    const attestation = {
      confirmation: "PROVIDER_ACCESS_REVOKED",
      evidence_reference: "provider-console-case-9001",
      reason: "Provider access was removed in the provider security console."
    };
    await request(app)
      .post(`/api/admin/mcp/revocations/${resolveId}/resolve`)
      .set(owner())
      .send(attestation)
      .expect(403);

    const alienResolved = await request(app)
      .post(`/api/admin/mcp/revocations/${resolveId}/resolve`)
      .set(alienAdmin())
      .send(attestation)
      .expect(200);
    expect(alienResolved.body.revocation).toMatchObject({
      revocation_id: resolveId,
      status: "revocation_manually_resolved"
    });
    let colliding = app.locals.store.read((data) => data.mcpOauthStates
      .filter((item) => item.oauth_state_id === resolveId));
    expect(colliding.find((item) => item.workspace_id === "alien_workspace").status)
      .toBe("revocation_manually_resolved");
    expect(colliding.find((item) => item.workspace_id === "oauth_workspace").status)
      .toBe("revocation_pending");

    const ownerResolved = await request(app)
      .post(`/api/admin/mcp/revocations/${resolveId}/resolve`)
      .set(admin())
      .send(attestation)
      .expect(200);
    expect(JSON.stringify(ownerResolved.body)).not.toContain(attestation.evidence_reference);
    expect(JSON.stringify(ownerResolved.body)).not.toContain("revocation_envelope");
    colliding = app.locals.store.read((data) => data.mcpOauthStates
      .filter((item) => item.oauth_state_id === resolveId));
    expect(colliding.every((item) => item.status === "revocation_manually_resolved")).toBe(true);
  });

  it("cancels an in-flight reauthorization during disconnect and revokes rather than resurrecting its late credential", async () => {
    const connected = await connectOAuth("code-before-disconnect-race");
    const raw = app.locals.store.read((data) => data.mcpConnections
      .find((item) => item.connection_id === connected.connection_id));
    await app.locals.store.mutate((data) => {
      const connection = data.mcpConnections.find((item) => item.connection_id === connected.connection_id);
      connection.status = "reauthorization_required";
      return connection;
    });
    const reconnect = await startOAuth(connected.connection_id);
    let releaseTokenResponse;
    provider.tokenGate = new Promise((resolve) => { releaseTokenResponse = resolve; });
    provider.tokenReached = new Promise((resolve) => { provider.resolveTokenReached = resolve; });
    const callbackPromise = finishOAuth(reconnect, "code-late-after-disconnect");
    await provider.tokenReached;

    const disconnected = await disconnectMcpConnectionDurably(raw, {
      key: app.locals.mcpCredentialKey,
      store: app.locals.store
    });
    expect(disconnected.provider_revoked).toBe(true);
    const cancelled = app.locals.store.read().mcpOauthStates
      .find((item) => item.state_digest === digestForTest(reconnect.state));
    expect(cancelled.status).toBe("disconnect_cancelled");
    expect(cancelled.verifier_envelope).toBeUndefined();

    releaseTokenResponse();
    const callback = await callbackPromise;
    expect(callback.headers.location).toBe("/app?mcp_oauth=error&reason=failed");
    expect(app.locals.store.read().mcpConnections).toEqual([]);
    const late = app.locals.store.read().mcpOauthStates
      .find((item) => item.oauth_state_id === cancelled.oauth_state_id);
    expect(late.status).toBe("revoked");
    expect(late.revocation_envelope).toBeUndefined();
    expect(provider.revocations).toEqual(expect.arrayContaining([
      "refresh-code-before-disconnect-race",
      "refresh-code-late-after-disconnect"
    ]));
  });

  it("turns a staged reauthorization in delayed discovery into a revocation outbox during disconnect", async () => {
    const connected = await connectOAuth("code-before-discovery-race");
    const raw = app.locals.store.read((data) => data.mcpConnections
      .find((item) => item.connection_id === connected.connection_id));
    await app.locals.store.mutate((data) => {
      const connection = data.mcpConnections.find((item) => item.connection_id === connected.connection_id);
      connection.status = "reauthorization_required";
      return connection;
    });
    const reconnect = await startOAuth(connected.connection_id);
    let releaseDiscovery;
    provider.mcpGate = new Promise((resolve) => { releaseDiscovery = resolve; });
    provider.mcpReached = new Promise((resolve) => { provider.resolveMcpReached = resolve; });
    const callbackPromise = finishOAuth(reconnect, "code-staged-disconnect-race");
    await provider.mcpReached;

    const staged = app.locals.store.read().mcpOauthStates
      .find((item) => item.state_digest === digestForTest(reconnect.state));
    expect(staged).toMatchObject({ status: "exchanging", revocation_envelope: { algorithm: "aes-256-gcm" } });
    await disconnectMcpConnectionDurably(raw, {
      key: app.locals.mcpCredentialKey,
      store: app.locals.store
    });
    expect(app.locals.store.read().mcpOauthStates
      .find((item) => item.oauth_state_id === staged.oauth_state_id).status).toBe("revocation_pending");

    releaseDiscovery();
    await callbackPromise;
    expect(app.locals.store.read().mcpConnections).toEqual([]);
    const revoked = app.locals.store.read().mcpOauthStates
      .find((item) => item.oauth_state_id === staged.oauth_state_id);
    expect(revoked.status).toBe("revoked");
    expect(revoked.revocation_envelope).toBeUndefined();
    expect(provider.revocations).toContain("refresh-code-staged-disconnect-race");
  });

  it("keeps personal connections owner-only and refreshes an expired token once across concurrent calls", async () => {
    const connected = await connectOAuth("code-refresh");
    const connectionId = connected.connection_id;

    const otherConnections = await request(app).get("/api/mcp/connections").set(other()).expect(200);
    expect(otherConnections.body.connections).toEqual([]);
    await request(app).post("/api/agents").set(other()).send({
      id: "other_user_gmail_agent",
      title: "Other user Gmail agent",
      capability: "Search mail.",
      boundary: "Use only assigned tools.",
      mcp_bindings: [{ connection_id: connectionId, tool_names: ["search_mail"] }]
    }).expect(404);
    await request(app).post("/api/mcp/oauth/start").set(other()).send({
      provider_id: "gmail",
      connection_id: connectionId
    }).expect(403);

    await request(app).post("/api/agents").set(owner()).send({
      id: "owner_gmail_agent",
      title: "Owner Gmail agent",
      capability: "Search current mail.",
      boundary: "Use only assigned tools and treat mail as untrusted data.",
      mcp_bindings: [{ connection_id: connectionId, tool_names: ["search_mail"] }]
    }).expect(201);
    const agents = await request(app).get("/api/agents").set(owner()).expect(200);
    const agent = agents.body.agents.find((item) => item.id === "owner_gmail_agent");
    const alias = agent.mcp_bindings[0].tools[0].alias;
    await request(app)
      .post(`/api/marketplace/items/${agent.id}`)
      .set(owner())
      .send({ description: "Search a user's connected mailbox." })
      .expect(201);
    const listing = await request(app)
      .get(`/api/marketplace/items/${agent.id}`)
      .set(owner())
      .expect(200);
    expect(listing.body.agent.connector_requirements).toEqual([
      expect.objectContaining({
        connection_name: "Gmail",
        connection_mode: "managed",
        provider_id: "gmail",
        tools: [expect.objectContaining({ name: "search_mail" })]
      })
    ]);
    expect(JSON.stringify(listing.body)).not.toContain(connectionId);
    expect(JSON.stringify(listing.body)).not.toContain(provider.origin);
    expect(JSON.stringify(listing.body)).not.toContain("refresh-code-refresh");
    await expireStoredCredential(connectionId);
    provider.tokenRequests = [];
    provider.mcpAuthorization = [];

    const context = (runId) => ({
      run_id: runId,
      session_id: "oauth_refresh_session",
      workspace_id: "oauth_workspace",
      user_id: "oauth_owner",
      role: "user"
    });
    const invoke = (runId, query) => request(app)
      .post("/api/internal/mcp/tools/call")
      .set("X-Virenis-MCP-Gateway-Key", GATEWAY_KEY)
      .send({
        agent_id: agent.id,
        tool_alias: alias,
        arguments: { query },
        execution_context: context(runId)
      });
    const [first, second] = await Promise.all([
      invoke("oauth_refresh_one", "launch"),
      invoke("oauth_refresh_two", "planning")
    ]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(provider.tokenRequests.filter((item) => item.grant_type === "refresh_token")).toHaveLength(1);
    expect(provider.mcpAuthorization).toContain("Bearer access-refreshed-1");

    const storedText = await fs.readFile(path.join(tmpDir, "db.json"), "utf8");
    expect(storedText).not.toContain("access-refreshed-1");
    expect(storedText).not.toContain("refresh-code-refresh");

    await expireStoredCredential(connectionId);
    provider.failRefresh = true;
    const failed = await invoke("oauth_refresh_failure", "failure");
    expect(failed.status).toBe(409);
    expect(failed.body.error).toBe("mcp_oauth_reauthorization_required");
    const unavailable = await request(app).get("/api/mcp/connections").set(owner()).expect(200);
    expect(unavailable.body.connections[0]).toMatchObject({
      status: "reauthorization_required",
      reauthorization_required: true
    });

    provider.failRefresh = false;
    await connectOAuth("code-reauthorized", connectionId);
    const restored = await request(app).get("/api/mcp/connections").set(owner()).expect(200);
    expect(restored.body.connections).toEqual([
      expect.objectContaining({ connection_id: connectionId, status: "ready" })
    ]);
  });

  it("runs the Python executor through the governed gateway with the managed OAuth credential", async () => {
    const connection = await connectOAuth("code-python-proof");
    await request(app).post("/api/agents").set(owner()).send({
      id: "managed_oauth_executor_agent",
      title: "Managed OAuth executor agent",
      capability: "Search the connected mailbox.",
      boundary: "Use only the assigned mailbox tool.",
      mcp_bindings: [{ connection_id: connection.connection_id, tool_names: ["search_mail"] }]
    }).expect(201);
    const agents = await request(app).get("/api/agents").set(owner()).expect(200);
    const agent = agents.body.agents.find((item) => item.id === "managed_oauth_executor_agent");
    const alias = agent.mcp_bindings[0].tools[0].alias;
    webServer = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => webServer.once("listening", resolve));
    const gatewayUrl = `http://127.0.0.1:${webServer.address().port}/api/internal/mcp/tools/call`;
    const python = [
      "import json, os",
      "from pathlib import Path",
      "from tcar_tool_runtime import execute_tool_requests",
      "alias=os.environ['PROOF_ALIAS']",
      "call='<tool_call>'+json.dumps({'name':alias,'arguments':{'query':'project update'}})+'</tool_call>'",
      "executions, violations=execute_tool_requests(call,[alias],manifest_item={'id':'managed_oauth_executor_agent','tools':[alias]},query='Search mail',project_root=Path.cwd(),execution_context={'run_id':'run_managed_oauth_proof','session_id':'session_managed_oauth_proof','workspace_id':'oauth_workspace','user_id':'oauth_owner','role':'user'})",
      "print(json.dumps({'executions':executions,'violations':violations}))"
    ].join(";");
    const { stdout } = await executeFile(
      "/home/ubuntu/miniconda3/envs/tcar-qwen36/bin/python",
      ["-c", python],
      {
        cwd: "/home/ubuntu/project",
        env: {
          ...process.env,
          PYTHONPATH: "/home/ubuntu/project",
          PROOF_ALIAS: alias,
          TCAR_MCP_GATEWAY_URL: gatewayUrl,
          TCAR_MCP_GATEWAY_KEY: GATEWAY_KEY
        }
      }
    );
    const proof = JSON.parse(stdout);
    expect(proof.violations).toEqual([]);
    expect(proof.executions[0]).toMatchObject({
      name: alias,
      result: {
        ok: true,
        data: {
          trust: "external_untrusted_data",
          content: [{ type: "text", text: "Mail result for project update" }]
        }
      }
    });
    expect(provider.mcpAuthorization).toContain("Bearer access-code-python-proof");
  });

  it("consumes denied/expired state safely and revokes OAuth before local disconnect", async () => {
    const denied = await startOAuth();
    const deniedCallback = await request(app)
      .get("/api/mcp/oauth/callback/gmail")
      .set("Cookie", denied.cookie)
      .query({ state: denied.state, error: "access_denied" })
      .expect(303);
    expect(deniedCallback.headers.location).toBe("/app?mcp_oauth=error&reason=denied");
    expect(provider.tokenRequests).toHaveLength(0);
    const deniedState = app.locals.store.read((data) => data.mcpOauthStates[0]);
    expect(deniedState.status).toBe("denied");
    expect(deniedState.verifier_envelope).toBeUndefined();

    const expired = await startOAuth();
    await app.locals.store.mutate((data) => {
      const transaction = data.mcpOauthStates.find((item) => item.state_digest === digestForTest(expired.state));
      transaction.expires_at = new Date(Date.now() - 1000).toISOString();
      return transaction;
    });
    await request(app)
      .get("/api/mcp/oauth/callback/gmail")
      .set("Cookie", expired.cookie)
      .query({ state: expired.state, code: "expired-code" })
      .expect(410);
    expect(provider.tokenRequests).toHaveLength(0);

    const connection = await connectOAuth("code-disconnect");
    const removed = await request(app)
      .delete(`/api/mcp/connections/${connection.connection_id}`)
      .set(owner())
      .expect(200);
    expect(removed.body).toMatchObject({
      ok: true,
      provider_revoked: true,
      revocation_warning: null
    });
    expect(provider.revocations).toContain("refresh-code-disconnect");
    const listed = await request(app).get("/api/mcp/connections").set(owner()).expect(200);
    expect(listed.body.connections).toEqual([]);

    const fallback = await connectOAuth("code-disconnect-offline");
    provider.failRevoke = true;
    const locallyRemoved = await request(app)
      .delete(`/api/mcp/connections/${fallback.connection_id}`)
      .set(owner())
      .expect(202);
    expect(locallyRemoved.body.provider_revoked).toBe(false);
    expect(locallyRemoved.body.revocation_pending).toBe(true);
    expect(locallyRemoved.body.revocation_warning).toMatch(/unavailable to agents/i);
    const afterFallback = await request(app).get("/api/mcp/connections").set(owner()).expect(200);
    expect(afterFallback.body.connections).toEqual([]);
  });
});

async function startOAuth(connectionId) {
  const response = await request(app)
    .post("/api/mcp/oauth/start")
    .set(owner())
    .send({ provider_id: "gmail", ...(connectionId ? { connection_id: connectionId } : {}) })
    .expect(200);
  const cookie = response.headers["set-cookie"][0].split(";", 1)[0];
  const authorization = new URL(response.body.authorization_url);
  return {
    response,
    cookie,
    state: authorization.searchParams.get("state")
  };
}

async function finishOAuth(started, code) {
  return request(app)
    .get("/api/mcp/oauth/callback/gmail")
    .set("Cookie", started.cookie)
    .query({ state: started.state, code })
    .expect(303);
}

async function connectOAuth(code, connectionId) {
  const started = await startOAuth(connectionId);
  await finishOAuth(started, code);
  const listed = await request(app).get("/api/mcp/connections").set(owner()).expect(200);
  return listed.body.connections.find((item) => item.connection_id === connectionId)
    || listed.body.connections.at(-1);
}

async function queueTestRevocation({
  id,
  refreshToken = `refresh-${id}`,
  workspaceId = "oauth_workspace",
  createdBy = "oauth_owner",
  status = "revocation_pending",
  queuedAt = new Date().toISOString(),
  exchangeStartedAt,
  withEnvelope = true
}) {
  const state = {
    oauth_state_id: id,
    provider_id: "gmail",
    status,
    workspace_id: workspaceId,
    created_by: createdBy,
    created_at: queuedAt,
    revocation_queued_at: queuedAt,
    revocation_attempts: 0,
    ...(exchangeStartedAt ? { exchange_started_at: exchangeStartedAt } : {})
  };
  if (withEnvelope) {
    state.credential_staged_at = queuedAt;
    state.revocation_envelope = encryptMcpValue({
      credential: {
        type: "oauth2",
        access_token: `access-${id}-${workspaceId}`,
        refresh_token: refreshToken,
        token_type: "Bearer",
        expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        scope: "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose"
      }
    }, app.locals.mcpCredentialKey, `mcp-oauth-revocation:v1:${workspaceId}:${createdBy}:gmail:${id}`);
  }
  await app.locals.store.mutate((data) => {
    data.mcpOauthStates.push(state);
    return state;
  });
  return state;
}

async function expireStoredCredential(connectionId) {
  const key = app.locals.mcpCredentialKey;
  await app.locals.store.mutate((data) => {
    const connection = data.mcpConnections.find((item) => item.connection_id === connectionId);
    const aad = `mcp-connection:v1:${connection.workspace_id}:${connection.connection_id}`;
    const credential = decryptMcpValue(connection.credential, key, aad);
    credential.expires_at = new Date(Date.now() - 1000).toISOString();
    connection.credential = encryptMcpValue(credential, key, aad);
    return connection;
  });
}

function digestForTest(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function canonicalDigestForTest(value) {
  const canonical = (input) => {
    if (Array.isArray(input)) return input.map(canonical);
    if (input && typeof input === "object") {
      return Object.fromEntries(Object.keys(input).sort().map((key) => [key, canonical(input[key])]));
    }
    return input;
  };
  return crypto.createHash("sha256").update(JSON.stringify(canonical(value)), "utf8").digest("hex");
}

async function settleWithin(promise, timeoutMs = 1_000) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ status: "timeout" }), timeoutMs);
  });
  const settled = Promise.resolve(promise).then(
    (value) => ({ status: "fulfilled", value }),
    (error) => ({ status: "rejected", error })
  );
  const outcome = await Promise.race([settled, timeout]);
  clearTimeout(timer);
  return outcome;
}

function createSyntheticManagedProvider() {
  const state = {
    tokenRequests: [],
    revocations: [],
    mcpAuthorization: [],
    refreshCount: 0,
    failRefresh: false,
    failRevoke: false,
    failRevokeTokens: new Set(),
    abortAuthorizationCodes: new Set(),
    abortRefreshTokens: new Set(),
    abortRevocationTokens: new Set(),
    partialScope: false,
    tokenGate: null,
    tokenReached: null,
    resolveTokenReached: null,
    mcpGate: null,
    mcpReached: null,
    resolveMcpReached: null
  };
  state.server = http.createServer(async (incoming, response) => {
    if (incoming.method === "POST" && incoming.url === "/token") {
      const form = new URLSearchParams(await readBody(incoming));
      const values = Object.fromEntries(form.entries());
      state.tokenRequests.push(values);
      state.resolveTokenReached?.();
      state.resolveTokenReached = null;
      if (state.tokenGate) await state.tokenGate;
      if (values.client_id !== "gmail-oauth-test-client" || values.client_secret !== "gmail-oauth-test-client-secret") {
        return json(response, 401, { error: "invalid_client" });
      }
      if (values.grant_type === "refresh_token") {
        if (state.abortRefreshTokens.has(values.refresh_token)) {
          return abortJsonResponse(response, {
            access_token: "access-refresh-that-must-not-be-accepted",
            token_type: "Bearer",
            expires_in: 3600,
            scope: "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose"
          });
        }
        if (state.failRefresh) return json(response, 400, { error: "invalid_grant" });
        state.refreshCount += 1;
        return json(response, 200, {
          access_token: `access-refreshed-${state.refreshCount}`,
          token_type: "Bearer",
          expires_in: 3600,
          scope: "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose"
        });
      }
      if (state.abortAuthorizationCodes.has(values.code)) {
        return abortJsonResponse(response, {
          access_token: `access-${values.code}`,
          refresh_token: `refresh-${values.code}`,
          token_type: "Bearer",
          expires_in: 3600,
          scope: "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose"
        });
      }
      return json(response, 200, {
        access_token: `access-${values.code}`,
        refresh_token: `refresh-${values.code}`,
        token_type: "Bearer",
        expires_in: 3600,
        scope: state.partialScope
          ? "https://www.googleapis.com/auth/gmail.readonly"
          : "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose"
      });
    }
    if (incoming.method === "POST" && incoming.url === "/revoke") {
      const form = new URLSearchParams(await readBody(incoming));
      const token = form.get("token");
      state.revocations.push(token);
      if (state.abortRevocationTokens.has(token)) {
        return abortJsonResponse(response, { ok: true, revoked: true });
      }
      if (state.failRevoke || state.failRevokeTokens.has(token)) {
        return json(response, 503, { error: "temporarily_unavailable" });
      }
      return json(response, 200, {});
    }
    if (incoming.method === "POST" && incoming.url === "/mcp") {
      const authorization = incoming.headers.authorization || "";
      state.mcpAuthorization.push(authorization);
      if (!authorization.startsWith("Bearer access-")) return json(response, 401, { error: "unauthorized" });
      const payload = JSON.parse(await readBody(incoming));
      if (payload.method === "notifications/initialized") {
        response.writeHead(202).end();
        return;
      }
      if (payload.method === "initialize") {
        state.resolveMcpReached?.();
        state.resolveMcpReached = null;
        if (state.mcpGate) await state.mcpGate;
        response.setHeader("Mcp-Session-Id", "oauth-session");
        return rpc(response, payload.id, {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "oauth-proof", version: "1.0.0" }
        });
      }
      if (payload.method === "tools/list") {
        return rpc(response, payload.id, { tools: managedTools() });
      }
      if (payload.method === "tools/call") {
        return rpc(response, payload.id, {
          content: [{ type: "text", text: `Mail result for ${payload.params.arguments.query || "draft"}` }]
        });
      }
    }
    response.writeHead(404).end();
  });
  return state;
}

function managedTools() {
  return [
    {
      name: "search_mail",
      title: "Search mail",
      description: "Search the connected mailbox.",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
        additionalProperties: false
      },
      annotations: { readOnlyHint: true }
    },
    {
      name: "create_draft",
      title: "Create draft",
      description: "Create a draft email.",
      inputSchema: {
        type: "object",
        properties: { subject: { type: "string" } },
        required: ["subject"],
        additionalProperties: false
      },
      annotations: { readOnlyHint: false, destructiveHint: false }
    }
  ];
}

async function readBody(incoming) {
  const chunks = [];
  for await (const chunk of incoming) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function json(response, status, value) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(value));
}

function abortJsonResponse(response, value) {
  const body = JSON.stringify(value);
  const partial = body.slice(0, Math.max(1, body.length - 1));
  response.writeHead(200, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body) + 64
  });
  response.write(partial);
  setTimeout(() => response.destroy(), 10);
}

function rpc(response, id, result) {
  json(response, 200, { jsonrpc: "2.0", id, result });
}

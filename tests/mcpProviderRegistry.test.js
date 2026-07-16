import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../server/app.js";
import {
  decryptMcpValue,
  encryptMcpValue,
  revokePendingMcpOAuthState
} from "../server/mcp.js";
import {
  managedMcpProvider,
  publicManagedMcpProviders,
  revokeManagedCredential
} from "../server/mcpOAuth.js";

const TOKEN = "managed-registry-owner-token";
const SECOND_TOKEN = "managed-registry-second-token";
const ENV_KEYS = [
  "WEB_STORE_DRIVER",
  "APP_API_TOKENS_JSON",
  "APP_MCP_ALLOW_TEST_HTTP",
  "APP_MCP_OAUTH_ALLOW_TEST_HTTP",
  "APP_PUBLIC_ORIGIN",
  "APP_MCP_OAUTH_REDIRECT_ORIGIN",
  "APP_MCP_NOTION_ENDPOINT_URL",
  "APP_MCP_NOTION_PROTECTED_RESOURCE_METADATA_URL",
  "APP_MCP_NOTION_AUTHORIZATION_SERVER_METADATA_URL",
  "APP_MCP_SLACK_OAUTH_CLIENT_ID",
  "APP_MCP_SLACK_OAUTH_CLIENT_SECRET",
  "APP_MCP_SLACK_ENDPOINT_URL",
  "APP_MCP_SLACK_AUTHORIZATION_URL",
  "APP_MCP_SLACK_TOKEN_URL",
  "APP_MCP_SLACK_REVOCATION_URL",
  "APP_MCP_GITHUB_OAUTH_CLIENT_ID",
  "APP_MCP_GITHUB_OAUTH_CLIENT_SECRET",
  "APP_MCP_GITHUB_ENDPOINT_URL",
  "APP_MCP_GITHUB_AUTHORIZATION_URL",
  "APP_MCP_GITHUB_TOKEN_URL",
  "APP_MCP_GITHUB_REVOCATION_URL"
];

let app;
let provider;
let tmpDir;
let priorEnvironment;

beforeEach(async () => {
  priorEnvironment = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  provider = createDynamicProvider();
  await new Promise((resolve) => provider.server.listen(0, "127.0.0.1", resolve));
  provider.origin = `http://127.0.0.1:${provider.server.address().port}`;

  process.env.WEB_STORE_DRIVER = "json";
  process.env.APP_API_TOKENS_JSON = JSON.stringify({
    [TOKEN]: { user_id: "registry_owner", workspace_id: "registry_workspace", role: "user" },
    [SECOND_TOKEN]: { user_id: "registry_second", workspace_id: "registry_workspace", role: "user" }
  });
  process.env.APP_MCP_ALLOW_TEST_HTTP = "1";
  process.env.APP_MCP_OAUTH_ALLOW_TEST_HTTP = "1";
  process.env.APP_PUBLIC_ORIGIN = "http://registry.app.test";
  process.env.APP_MCP_OAUTH_REDIRECT_ORIGIN = "http://registry.app.test";
  process.env.APP_MCP_NOTION_ENDPOINT_URL = `${provider.origin}/mcp`;
  process.env.APP_MCP_NOTION_PROTECTED_RESOURCE_METADATA_URL = `${provider.origin}/oauth-resource`;
  process.env.APP_MCP_NOTION_AUTHORIZATION_SERVER_METADATA_URL = `${provider.origin}/.well-known/oauth-authorization-server`;
  process.env.APP_MCP_SLACK_OAUTH_CLIENT_ID = "slack-registry-client";
  process.env.APP_MCP_SLACK_OAUTH_CLIENT_SECRET = "slack-registry-secret";
  process.env.APP_MCP_SLACK_ENDPOINT_URL = `${provider.origin}/slack-mcp`;
  process.env.APP_MCP_SLACK_AUTHORIZATION_URL = `${provider.origin}/slack-authorize`;
  process.env.APP_MCP_SLACK_TOKEN_URL = `${provider.origin}/slack-token`;
  process.env.APP_MCP_SLACK_REVOCATION_URL = `${provider.origin}/slack-revoke`;
  process.env.APP_MCP_GITHUB_OAUTH_CLIENT_ID = "github-registry-client";
  process.env.APP_MCP_GITHUB_OAUTH_CLIENT_SECRET = "github-registry-secret";
  process.env.APP_MCP_GITHUB_ENDPOINT_URL = `${provider.origin}/github-mcp`;
  process.env.APP_MCP_GITHUB_AUTHORIZATION_URL = `${provider.origin}/github-authorize`;
  process.env.APP_MCP_GITHUB_TOKEN_URL = `${provider.origin}/github-token`;
  process.env.APP_MCP_GITHUB_REVOCATION_URL = `${provider.origin}/github-applications`;

  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "virenis-managed-registry-"));
  app = await createApp({ dbPath: path.join(tmpDir, "db.json"), uploadRoot: tmpDir, autoRun: false });
});

afterEach(async () => {
  await app?.locals?.store?.close?.();
  await new Promise((resolve) => provider?.server?.close(resolve));
  await fs.rm(tmpDir, { recursive: true, force: true });
  for (const key of ENV_KEYS) {
    if (priorEnvironment[key] === undefined) delete process.env[key];
    else process.env[key] = priorEnvironment[key];
  }
});

describe("managed MCP provider registry", () => {
  it("publishes the common provider catalog without exposing endpoints or OAuth credentials", () => {
    const env = {
      NODE_ENV: "production",
      APP_PUBLIC_ORIGIN: "https://app.example.test",
      APP_MCP_OAUTH_REDIRECT_ORIGIN: "https://app.example.test",
      APP_MCP_GOOGLE_OAUTH_CLIENT_ID: "google-client-id",
      APP_MCP_GOOGLE_OAUTH_CLIENT_SECRET: "google-client-secret",
      APP_MCP_GITHUB_OAUTH_CLIENT_ID: "github-client-id",
      APP_MCP_GITHUB_OAUTH_CLIENT_SECRET: "github-client-secret",
      APP_MCP_SLACK_OAUTH_CLIENT_ID: "slack-client-id",
      APP_MCP_SLACK_OAUTH_CLIENT_SECRET: "slack-client-secret"
    };
    const providers = publicManagedMcpProviders(env);
    expect(providers.map((item) => item.id)).toEqual([
      "gmail",
      "google_drive",
      "google_calendar",
      "google_chat",
      "google_contacts",
      "github",
      "slack",
      "notion",
      "linear"
    ]);
    expect(providers.every((item) => item.availability === "available")).toBe(true);
    expect(providers.find((item) => item.id === "notion")).toMatchObject({ setup_mode: "automatic" });
    expect(providers.find((item) => item.id === "gmail")).toMatchObject({
      category: "Communication",
      provider_status: "developer_preview"
    });
    const publicJson = JSON.stringify(providers);
    for (const secret of [
      "google-client-secret",
      "github-client-secret",
      "slack-client-secret",
      "gmailmcp.googleapis.com",
      "mcp.notion.com"
    ]) {
      expect(publicJson).not.toContain(secret);
    }
  });

  it("completes dynamic registration, PKCE, encrypted callback state, discovery, and revocation", async () => {
    const templates = await request(app)
      .get("/api/mcp/templates")
      .set(auth())
      .expect(200);
    expect(templates.body.templates.find((item) => item.id === "notion")).toMatchObject({
      connection_mode: "managed",
      availability: "available",
      setup_mode: "automatic",
      connect_label: "Connect Notion"
    });

    const started = await request(app)
      .post("/api/mcp/oauth/start")
      .set(auth())
      .send({ provider_id: "notion" })
      .expect(200);
    expect(provider.registrations).toHaveLength(1);
    expect(provider.registrations[0]).toMatchObject({
      client_name: "Virenis",
      redirect_uris: ["http://registry.app.test/api/mcp/oauth/callback/notion"],
      token_endpoint_auth_method: "none"
    });
    const authorization = new URL(started.body.authorization_url);
    expect(`${authorization.origin}${authorization.pathname}`).toBe(`${provider.origin}/authorize`);
    expect(authorization.searchParams.get("resource")).toBe(`${provider.origin}/mcp`);
    expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
    const cookie = started.headers["set-cookie"][0].split(";", 1)[0];
    const state = authorization.searchParams.get("state");

    const callback = await request(app)
      .get("/api/mcp/oauth/callback/notion")
      .set("Cookie", cookie)
      .query({ state, code: "dynamic-proof-code" })
      .expect(303);
    expect(callback.headers.location).toBe("/app?mcp_oauth=connected&provider=notion");
    expect(provider.tokenRequests).toHaveLength(1);
    expect(provider.tokenRequests[0]).toMatchObject({
      client_id: "virenis-dynamic-client",
      code: "dynamic-proof-code",
      grant_type: "authorization_code",
      resource: `${provider.origin}/mcp`
    });
    expect(provider.tokenRequests[0].client_secret).toBeUndefined();
    const expectedChallenge = crypto
      .createHash("sha256")
      .update(provider.tokenRequests[0].code_verifier, "ascii")
      .digest("base64url");
    expect(expectedChallenge).toBe(authorization.searchParams.get("code_challenge"));

    const listed = await request(app).get("/api/mcp/connections").set(auth()).expect(200);
    expect(listed.body.connections).toEqual([
      expect.objectContaining({
        name: "Notion",
        provider_id: "notion",
        status: "ready",
        read_policy: "allow_declared_reads",
        tools: expect.arrayContaining([
          expect.objectContaining({ name: "search_pages", risk: "read", requires_approval: false }),
          expect.objectContaining({ name: "update_page", risk: "write", requires_approval: true })
        ])
      })
    ]);
    expect(provider.mcpAuthorization).toContain("Bearer notion-access-dynamic-proof-code");

    const connectionId = listed.body.connections[0].connection_id;
    await app.locals.store.mutate((data) => {
      const connection = data.mcpConnections.find((item) => item.connection_id === connectionId);
      const aad = `mcp-connection:v1:${connection.workspace_id}:${connection.connection_id}`;
      const credential = decryptMcpValue(connection.credential, app.locals.mcpCredentialKey, aad);
      credential.expires_at = new Date(Date.now() - 1000).toISOString();
      connection.credential = encryptMcpValue(credential, app.locals.mcpCredentialKey, aad);
      return connection;
    });
    await request(app)
      .post(`/api/mcp/connections/${connectionId}/refresh`)
      .set(auth())
      .send({})
      .expect(200);
    expect(provider.tokenRequests.filter((item) => item.grant_type === "refresh_token")).toHaveLength(1);
    expect(provider.mcpAuthorization).toContain("Bearer notion-access-refreshed");

    const stored = await fs.readFile(path.join(tmpDir, "db.json"), "utf8");
    for (const secret of [
      "dynamic-proof-code",
      provider.tokenRequests[0].code_verifier,
      "notion-access-dynamic-proof-code",
      "notion-refresh-dynamic-proof-code",
      "notion-access-refreshed"
    ]) {
      expect(stored).not.toContain(secret);
    }
    expect(stored).toContain("aes-256-gcm");

    const secondStart = await request(app)
      .post("/api/mcp/oauth/start")
      .set(auth(SECOND_TOKEN))
      .send({ provider_id: "notion" })
      .expect(200);
    expect(new URL(secondStart.body.authorization_url).searchParams.get("client_id")).toBe("virenis-dynamic-client");
    expect(provider.registrations).toHaveLength(1);
    const persistedRegistry = app.locals.store.read((data) => data.mcpOauthClients);
    expect(persistedRegistry).toHaveLength(1);
    expect(JSON.stringify(persistedRegistry)).not.toContain("virenis-dynamic-client");

    const removed = await request(app)
      .delete(`/api/mcp/connections/${connectionId}`)
      .set(auth())
      .expect(200);
    expect(removed.body).toMatchObject({ provider_revoked: true, revocation_warning: null });
    expect(provider.revocations).toContain("notion-refresh-dynamic-proof-code");
  });

  it("normalizes Slack user-token responses and remotely revokes access and refresh credentials", async () => {
    const started = await request(app)
      .post("/api/mcp/oauth/start")
      .set(auth())
      .send({ provider_id: "slack" })
      .expect(200);
    const authorization = new URL(started.body.authorization_url);
    expect(authorization.searchParams.get("scope")).toBeNull();
    expect(authorization.searchParams.get("user_scope")).toContain("search:read.public");
    expect(authorization.searchParams.get("user_scope")).toContain("chat:write");
    const cookie = started.headers["set-cookie"][0].split(";", 1)[0];
    await request(app)
      .get("/api/mcp/oauth/callback/slack")
      .set("Cookie", cookie)
      .query({ state: authorization.searchParams.get("state"), code: "slack-proof-code" })
      .expect(303);

    expect(provider.slackTokenRequests).toEqual([
      expect.objectContaining({
        client_id: "slack-registry-client",
        client_secret: "slack-registry-secret",
        code: "slack-proof-code"
      })
    ]);
    expect(provider.mcpAuthorization).toContain("Bearer xoxp-slack-proof-code");
    const listed = await request(app).get("/api/mcp/connections").set(auth()).expect(200);
    const slack = listed.body.connections.find((connection) => connection.provider_id === "slack");
    expect(slack).toMatchObject({ name: "Slack", status: "ready", has_secret: true });

    const stored = await fs.readFile(path.join(tmpDir, "db.json"), "utf8");
    expect(stored).not.toContain("xoxp-slack-proof-code");
    expect(stored).not.toContain("xoxe-slack-proof-code");
    const removed = await request(app)
      .delete(`/api/mcp/connections/${slack.connection_id}`)
      .set(auth())
      .expect(200);
    expect(removed.body).toMatchObject({ provider_revoked: true, revocation_warning: null });
    expect(provider.slackRevocations).toEqual([
      "xoxp-slack-proof-code",
      "xoxe-slack-proof-code"
    ]);
    await expect(revokeManagedCredential(
      managedMcpProvider("slack", process.env),
      { access_token: "xoxp-slack-proof-code", refresh_token: "xoxe-slack-proof-code" },
      process.env
    )).resolves.toBe(true);
    expect(provider.slackRevocations).toEqual([
      "xoxp-slack-proof-code",
      "xoxe-slack-proof-code",
      "xoxp-slack-proof-code",
      "xoxe-slack-proof-code"
    ]);
  });

  it("uses GitHub's application-token API and safely retries already-revoked tokens", async () => {
    const github = managedMcpProvider("github", process.env);
    const credential = {
      access_token: "gho-registry-access",
      refresh_token: "ghr-registry-refresh"
    };

    await expect(revokeManagedCredential(github, credential, process.env)).resolves.toBe(true);
    await expect(revokeManagedCredential(github, credential, process.env)).resolves.toBe(true);

    expect(provider.githubChecks).toEqual([
      "gho-registry-access",
      "ghr-registry-refresh",
      "gho-registry-access",
      "ghr-registry-refresh"
    ]);
    expect(provider.githubRevocations).toEqual([
      "gho-registry-access",
      "ghr-registry-refresh"
    ]);
    expect(provider.githubAuthorization).toBe(
      `Basic ${Buffer.from("github-registry-client:github-registry-secret", "utf8").toString("base64")}`
    );
  });

  it("fails closed when a provider cannot prove that a credential is inactive", async () => {
    await expect(revokeManagedCredential(
      managedMcpProvider("slack", process.env),
      { access_token: "xoxp-ambiguous-auth" },
      process.env
    )).rejects.toMatchObject({ code: "mcp_oauth_provider_error" });
    await expect(revokeManagedCredential(
      managedMcpProvider("github", process.env),
      { access_token: "gho-check-error" },
      process.env
    )).rejects.toMatchObject({ code: "mcp_oauth_provider_error" });
  });

  it("persists per-token Slack progress so a transient second-token failure never retries the confirmed first token", async () => {
    const accessToken = "xoxp-progress-access";
    const refreshToken = "xoxe-progress-refresh";
    provider.activeSlackTokens.add(accessToken);
    provider.activeSlackTokens.add(refreshToken);
    provider.slackTransientFailures.set(refreshToken, 1);
    const state = {
      oauth_state_id: "mcpoauth_slack_progress",
      provider_id: "slack",
      status: "revocation_pending",
      workspace_id: "registry_workspace",
      created_by: "registry_owner",
      created_at: new Date().toISOString(),
      revocation_queued_at: new Date().toISOString(),
      revocation_attempts: 0
    };
    state.revocation_envelope = encryptMcpValue(
      { credential: { type: "oauth2", access_token: accessToken, refresh_token: refreshToken } },
      app.locals.mcpCredentialKey,
      `mcp-oauth-revocation:v1:${state.workspace_id}:${state.created_by}:${state.provider_id}:${state.oauth_state_id}`
    );
    await app.locals.store.mutate((data) => {
      data.mcpOauthStates.push(state);
      return state;
    });

    await expect(revokePendingMcpOAuthState(state, {
      key: app.locals.mcpCredentialKey,
      store: app.locals.store
    })).rejects.toMatchObject({ code: "mcp_oauth_provider_error" });
    const pending = app.locals.store.read().mcpOauthStates
      .find((item) => item.oauth_state_id === state.oauth_state_id);
    expect(pending.revocation_confirmed_token_ids).toHaveLength(1);
    expect(provider.slackRevocations).toEqual([accessToken, refreshToken]);

    await expect(revokePendingMcpOAuthState(pending, {
      key: app.locals.mcpCredentialKey,
      store: app.locals.store
    })).resolves.toBe(true);
    expect(provider.slackRevocations).toEqual([accessToken, refreshToken, refreshToken]);
    const revoked = app.locals.store.read().mcpOauthStates
      .find((item) => item.oauth_state_id === state.oauth_state_id);
    expect(revoked.status).toBe("revoked");
    expect(revoked.revocation_envelope).toBeUndefined();
    expect(revoked.revocation_confirmed_token_ids).toBeUndefined();
  });
});

function auth(token = TOKEN) {
  return { Authorization: `Bearer ${token}` };
}

function createDynamicProvider() {
  const state = {
    registrations: [],
    tokenRequests: [],
    slackTokenRequests: [],
    slackRevocations: [],
    githubChecks: [],
    githubRevocations: [],
    githubAuthorization: "",
    activeSlackTokens: new Set(),
    slackTransientFailures: new Map(),
    activeGithubTokens: new Set(["gho-registry-access", "ghr-registry-refresh"]),
    revocations: [],
    mcpAuthorization: []
  };
  state.server = http.createServer(async (incoming, response) => {
    if (incoming.method === "GET" && incoming.url === "/oauth-resource") {
      return json(response, 200, {
        resource: `${state.origin}/mcp`,
        authorization_servers: [state.origin]
      });
    }
    if (incoming.method === "GET" && incoming.url === "/.well-known/oauth-authorization-server") {
      return json(response, 200, {
        issuer: state.origin,
        authorization_endpoint: `${state.origin}/authorize`,
        token_endpoint: `${state.origin}/token`,
        registration_endpoint: `${state.origin}/register`,
        revocation_endpoint: `${state.origin}/revoke`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"]
      });
    }
    if (incoming.method === "POST" && incoming.url === "/register") {
      state.registrations.push(JSON.parse(await readBody(incoming)));
      return json(response, 201, {
        client_id: "virenis-dynamic-client",
        token_endpoint_auth_method: "none"
      });
    }
    if (incoming.method === "POST" && incoming.url === "/token") {
      const values = Object.fromEntries(new URLSearchParams(await readBody(incoming)).entries());
      state.tokenRequests.push(values);
      if (values.client_id !== "virenis-dynamic-client") return json(response, 401, { error: "invalid_client" });
      if (values.grant_type === "refresh_token") {
        return json(response, 200, {
          access_token: "notion-access-refreshed",
          token_type: "Bearer",
          expires_in: 3600
        });
      }
      return json(response, 200, {
        access_token: `notion-access-${values.code}`,
        refresh_token: `notion-refresh-${values.code}`,
        token_type: "Bearer",
        expires_in: 3600
      });
    }
    if (incoming.method === "POST" && incoming.url === "/revoke") {
      const values = new URLSearchParams(await readBody(incoming));
      state.revocations.push(values.get("token"));
      return json(response, 200, {});
    }
    if (incoming.method === "POST" && incoming.url === "/slack-token") {
      const values = Object.fromEntries(new URLSearchParams(await readBody(incoming)).entries());
      state.slackTokenRequests.push(values);
      if (values.client_id !== "slack-registry-client" || values.client_secret !== "slack-registry-secret") {
        return json(response, 200, { ok: false, error: "invalid_client" });
      }
      state.activeSlackTokens.add(`xoxp-${values.code}`);
      state.activeSlackTokens.add(`xoxe-${values.code}`);
      return json(response, 200, {
        ok: true,
        authed_user: {
          access_token: `xoxp-${values.code}`,
          refresh_token: `xoxe-${values.code}`,
          token_type: "Bearer",
          expires_in: 3600,
          scope: "search:read.public,chat:write"
        }
      });
    }
    if (incoming.method === "POST" && incoming.url === "/slack-revoke") {
      const values = new URLSearchParams(await readBody(incoming));
      const token = values.get("token");
      state.slackRevocations.push(token);
      if (token === "xoxp-ambiguous-auth") return json(response, 200, { ok: false, error: "invalid_auth" });
      const transientFailures = state.slackTransientFailures.get(token) || 0;
      if (transientFailures > 0) {
        state.slackTransientFailures.set(token, transientFailures - 1);
        return json(response, 503, { ok: false, error: "temporarily_unavailable" });
      }
      if (!state.activeSlackTokens.has(token)) return json(response, 200, { ok: false, error: "token_revoked" });
      state.activeSlackTokens.delete(token);
      return json(response, 200, { ok: true, revoked: true });
    }
    if (["POST", "DELETE"].includes(incoming.method)
      && incoming.url === "/github-applications/github-registry-client/token") {
      const payload = JSON.parse(await readBody(incoming));
      state.githubAuthorization = incoming.headers.authorization || "";
      if (incoming.method === "POST") {
        state.githubChecks.push(payload.access_token);
        if (payload.access_token === "gho-check-error") return json(response, 422, { message: "Validation failed" });
        if (!state.activeGithubTokens.has(payload.access_token)) return json(response, 404, { message: "Not Found" });
        return json(response, 200, { token: payload.access_token });
      }
      state.githubRevocations.push(payload.access_token);
      state.activeGithubTokens.delete(payload.access_token);
      response.writeHead(204).end();
      return;
    }
    if (incoming.method === "POST" && ["/mcp", "/slack-mcp"].includes(incoming.url)) {
      state.mcpAuthorization.push(incoming.headers.authorization || "");
      const validBearer = (incoming.headers.authorization || "").startsWith("Bearer notion-access-")
        || (incoming.headers.authorization || "").startsWith("Bearer xoxp-");
      if (!validBearer) {
        return json(response, 401, { error: "unauthorized" });
      }
      const payload = JSON.parse(await readBody(incoming));
      if (payload.method === "notifications/initialized") return response.writeHead(202).end();
      if (payload.method === "initialize") {
        response.setHeader("Mcp-Session-Id", "notion-registry-session");
        return rpc(response, payload.id, {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "dynamic-notion-proof", version: "1.0.0" }
        });
      }
      if (payload.method === "tools/list") return rpc(response, payload.id, { tools: dynamicTools() });
    }
    response.writeHead(404).end();
  });
  return state;
}

function dynamicTools() {
  return [
    {
      name: "search_pages",
      title: "Search pages",
      description: "Search granted Notion pages.",
      inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      annotations: { readOnlyHint: true }
    },
    {
      name: "update_page",
      title: "Update page",
      description: "Update a granted Notion page.",
      inputSchema: { type: "object", properties: { page_id: { type: "string" } }, required: ["page_id"] },
      annotations: { readOnlyHint: false }
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

function rpc(response, id, result) {
  json(response, 200, { jsonrpc: "2.0", id, result });
}

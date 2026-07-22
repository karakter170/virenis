#!/usr/bin/env node
/* global console, document, fetch, process, URL */

// Browser + web API + live GPU Runtime proof for every Agent Studio execution
// field. The script creates only temporary resources and purges them in finally.

import crypto from "node:crypto";
import { Buffer } from "node:buffer";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createClerkClient } from "@clerk/backend";
import { chromium } from "@playwright/test";
import express from "express";

import { createApp } from "../server/app.js";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "../../..");
const RUNTIME_URL = process.env.TCAR_RUNTIME_API_URL || "http://127.0.0.1:9000";
const RUNTIME_KEY_FILE = process.env.TCAR_RUNTIME_API_KEY_FILE
  || path.join(PROJECT_ROOT, "outputs", "tcar_api_key.txt");
const TOKEN = `agent_builder_live_${crypto.randomBytes(24).toString("hex")}`;
const AUTHORIZATION = `Bearer ${TOKEN}`;
const ACTOR = {
  user_id: "agent_builder_live_user",
  workspace_id: "agent_builder_live_workspace",
  role: "admin"
};
const CLERK_TEST_USER_ID = process.env.AGENT_BUILDER_CLERK_USER_ID || "";
const SCREENSHOT = path.join(PROJECT_ROOT, "outputs", "agent_builder_ui_live_proof.png");
const MANAGED_ENV = [
  "NODE_ENV",
  "WEB_STORE_DRIVER",
  "APP_API_TOKENS_JSON",
  "APP_PUBLIC_ORIGIN",
  "APP_BILLING_WELCOME_CREDITS",
  "TCAR_ENGINE_MODE",
  "TCAR_RUNTIME_API_URL",
  "TCAR_RUNTIME_API_KEY",
  "TCAR_RUNTIME_API_KEY_FILE",
  "TCAR_RUNTIME_ADMIN_TIMEOUT_MS",
  "TCAR_RUNTIME_HEALTH_TIMEOUT_MS",
  "APP_MCP_ALLOW_TEST_HTTP",
  "APP_MCP_GATEWAY_KEY"
];

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

async function startSyntheticMcpServer() {
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (payload.method === "notifications/initialized") {
      response.writeHead(202).end();
      return;
    }
    let result;
    if (payload.method === "initialize") {
      result = {
        protocolVersion: "2025-11-25",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "agent-builder-browser-proof", version: "1.0.0" }
      };
      response.setHeader("Mcp-Session-Id", "agent-builder-proof-session");
    } else if (payload.method === "tools/list") {
      result = {
        tools: [
          {
            name: "search_notes",
            title: "Search notes",
            description: "Search approved product notes.",
            inputSchema: {
              type: "object",
              properties: { query: { type: "string" } },
              required: ["query"],
              additionalProperties: false
            },
            annotations: { readOnlyHint: true }
          },
          {
            name: "create_note",
            title: "Create note",
            description: "Create a product note after explicit approval.",
            inputSchema: {
              type: "object",
              properties: { text: { type: "string" } },
              required: ["text"],
              additionalProperties: false
            },
            annotations: { readOnlyHint: false, destructiveHint: false }
          }
        ]
      };
    } else if (payload.method === "tools/call") {
      result = { content: [{ type: "text", text: "Synthetic browser proof result" }] };
    } else {
      response.writeHead(404).end();
      return;
    }
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result }));
  });
  await new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", resolve);
    server.once("error", reject);
  });
  server.url = `http://127.0.0.1:${server.address().port}/mcp`;
  return server;
}

async function pageApi(page, endpoint, { method = "GET", body, headers = {} } = {}) {
  const response = await page.evaluate(async ({ endpoint, method, body, headers }) => {
    const result = await fetch(endpoint, {
      method,
      credentials: "same-origin",
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...headers
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const text = await result.text();
    let payload;
    try { payload = text ? JSON.parse(text) : null; } catch { payload = { raw: text }; }
    return { ok: result.ok, status: result.status, payload };
  }, { endpoint, method, body, headers });
  if (!response.ok) {
    throw new Error(`${method} ${endpoint} failed (${response.status}): ${JSON.stringify(response.payload)}`);
  }
  return response.payload;
}

async function directApi(baseURL, endpoint, { method = "GET", body, headers = {} } = {}) {
  const response = await fetch(`${baseURL}${endpoint}`, {
    method,
    headers: {
      Authorization: AUTHORIZATION,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...headers
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const text = await response.text();
  let payload;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = { raw: text }; }
  if (!response.ok) {
    const error = new Error(`${method} ${endpoint} failed (${response.status}): ${JSON.stringify(payload)}`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

async function runtimeAgent(agentId, runtimeKey) {
  const response = await fetch(`${RUNTIME_URL}/agents/${encodeURIComponent(agentId)}`, {
    headers: { "X-TCAR-API-Key": runtimeKey }
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(`Runtime agent lookup failed (${response.status}): ${JSON.stringify(payload)}`);
  return payload.agent;
}

async function appReady(page) {
  await page.locator('textarea[role="combobox"]').waitFor({ state: "visible", timeout: 60_000 });
  await page.waitForFunction(() => Boolean(
    document.querySelector(".app-shell")?.getAttribute("data-active-session-id")
  ), null, { timeout: 60_000 });
}

async function checkChoice(container, text) {
  const label = container.locator("label").filter({ hasText: text }).first();
  const input = label.locator('input[type="checkbox"]').first();
  await input.waitFor({ state: "attached", timeout: 30_000 });
  if (!(await input.isChecked())) await label.click();
  requireCondition(await input.isChecked(), `${text} was not selected`);
}

async function main() {
  const runtimeKey = (await fs.readFile(RUNTIME_KEY_FILE, "utf8")).trim();
  requireCondition(runtimeKey, "The Runtime API key file is empty");
  const previousEnv = Object.fromEntries(MANAGED_ENV.map((name) => [name, process.env[name]]));
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "virenis-agent-builder-live-"));
  let app;
  let listener;
  let browser;
  let mcpServer;
  let clerkClient;
  let clerkSignInTokenId = "";
  let baseURL = "";
  let createdAgentId = "";
  let connectionId = "";
  const cleanup = [];
  try {
    process.env.NODE_ENV = "test";
    process.env.WEB_STORE_DRIVER = "json";
    process.env.APP_API_TOKENS_JSON = JSON.stringify({ [TOKEN]: ACTOR });
    process.env.TCAR_ENGINE_MODE = "real";
    process.env.TCAR_RUNTIME_API_URL = RUNTIME_URL;
    delete process.env.TCAR_RUNTIME_API_KEY;
    process.env.TCAR_RUNTIME_API_KEY_FILE = RUNTIME_KEY_FILE;
    process.env.TCAR_RUNTIME_ADMIN_TIMEOUT_MS = "300000";
    process.env.TCAR_RUNTIME_HEALTH_TIMEOUT_MS = "300000";
    process.env.APP_BILLING_WELCOME_CREDITS = "1000";
    process.env.APP_MCP_ALLOW_TEST_HTTP = "1";
    process.env.APP_MCP_GATEWAY_KEY = `agent-builder-gateway-${crypto.randomBytes(24).toString("hex")}`;
    delete process.env.APP_PUBLIC_ORIGIN;

    mcpServer = await startSyntheticMcpServer();
    app = await createApp({
      dbPath: path.join(tempRoot, "app-db.json"),
      uploadRoot: path.join(tempRoot, "uploads")
    });
    const distRoot = path.join(PROJECT_ROOT, "web", "virenis", "dist");
    app.use(express.static(distRoot, { index: false }));
    app.get("*", (request, response, next) => {
      if (request.path.startsWith("/api/")) return next();
      return response.sendFile(path.join(distRoot, "index.html"));
    });
    listener = await new Promise((resolve, reject) => {
      const server = app.listen(0, "127.0.0.1", () => resolve(server));
      server.once("error", reject);
    });
    baseURL = `http://127.0.0.1:${listener.address().port}`;

    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ baseURL, viewport: { width: 1500, height: 1100 } });
    const appOrigin = new URL(baseURL).origin;
    await context.route("**/*", async (route) => {
      const request = route.request();
      if (new URL(request.url()).origin !== appOrigin) {
        await route.continue();
        return;
      }
      await route.continue({ headers: { ...request.headers(), Authorization: AUTHORIZATION } });
    });
    const page = await context.newPage();
    let appEntryUrl = `${baseURL}/app`;
    if (process.env.CLERK_SECRET_KEY) {
      clerkClient = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });
      const clerkUserId = CLERK_TEST_USER_ID
        || (await clerkClient.users.getUserList({ limit: 1 })).data?.[0]?.id;
      requireCondition(clerkUserId, "No Clerk user is available for the browser sign-in proof");
      const signInToken = await clerkClient.signInTokens.createSignInToken({
        userId: clerkUserId,
        expiresInSeconds: 300
      });
      clerkSignInTokenId = signInToken.id;
      appEntryUrl = `${baseURL}/login?__clerk_ticket=${encodeURIComponent(signInToken.token)}`;
    }
    await page.goto(appEntryUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    try {
      await appReady(page);
    } catch {
      await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
      try {
        await appReady(page);
      } catch (error) {
        const visibleUrl = new URL(page.url());
        visibleUrl.search = "";
        visibleUrl.hash = "";
        const bodyText = await page.locator("body").innerText().catch(() => "");
        throw new Error(
          `The authenticated Agent Studio shell did not become ready at ${visibleUrl}. `
          + `Visible page: ${bodyText.slice(0, 800)}. ${error.message}`
        );
      }
    }

    await page.getByRole("button", { name: "My team", exact: true }).click();
    const studio = page.getByRole("dialog", { name: "Team studio" });
    await studio.waitFor({ state: "visible", timeout: 30_000 });
    await studio.getByRole("button", { name: "Apps", exact: true }).click();
    await studio.getByRole("button", { name: "Advanced connection" }).click();
    const connectionDialog = page.getByRole("dialog", { name: "Connect a custom MCP server" });
    await connectionDialog.getByLabel("Connection name").fill("Browser Product Notes");
    await connectionDialog.getByLabel("HTTPS endpoint").fill(mcpServer.url);
    await connectionDialog.getByLabel(/Allow declared read-only tools/).check();
    const connectionResponse = page.waitForResponse((response) => (
      response.request().method() === "POST"
      && new URL(response.url()).pathname === "/api/mcp/connections"
    ));
    await connectionDialog.getByRole("button", { name: "Connect and discover tools" }).click();
    const connectionHttpResponse = await connectionResponse;
    const connectionPayload = await connectionHttpResponse.json();
    requireCondition(
      connectionHttpResponse.ok(),
      `Custom MCP connection failed with ${connectionHttpResponse.status()}: ${JSON.stringify(connectionPayload)}`
    );
    connectionId = connectionPayload.connection_id;
    await connectionDialog.waitFor({ state: "hidden", timeout: 30_000 });
    await studio.locator(".connection-card")
      .filter({ hasText: "Browser Product Notes" })
      .waitFor({ state: "visible", timeout: 30_000 });

    await studio.getByRole("button", { name: "My team", exact: true }).click();
    const isolatedTeamName = `Agent Builder Proof ${Date.now()}`;
    await studio.locator('summary[aria-label="More team actions"]').click();
    await studio.getByRole("button", { name: "Create another team" }).click();
    const workspaceDialog = page.getByRole("dialog", { name: "Create a team" });
    await workspaceDialog.getByLabel("Team name").fill(isolatedTeamName);
    await workspaceDialog.getByLabel("Description").fill(
      "Temporary isolated team used to prove the complete Agent Studio creation contract."
    );
    await workspaceDialog.getByRole("button", { name: "Create team" }).click();
    await workspaceDialog.waitFor({ state: "hidden", timeout: 30_000 });
    await studio.waitFor({ state: "visible", timeout: 30_000 });
    await studio.getByRole("combobox", { name: "Active team" }).waitFor({ state: "visible", timeout: 30_000 });
    requireCondition(
      await studio.getByRole("combobox", { name: "Active team" }).inputValue() !== "",
      "The isolated Agent Builder proof team was not selected"
    );
    await studio.getByRole("button", { name: "Add specialist" }).click();
    const builder = page.getByRole("dialog", { name: "Add a specialist to your team" });
    await builder.getByLabel("Role name").fill("Full Contract Browser Analyst");
    await builder.getByLabel("What is this specialist responsible for?").fill(
      "Combine current research, exact calculations, structured tables, approved files, supplied SQL rows, repository inspection, conversation context, and connected product notes into a careful recommendation."
    );
    await builder.locator("label").filter({ hasText: "Careful" }).first().click();
    await builder.getByText("Add specific guardrails", { exact: false }).click();
    await builder.getByLabel("Extra instructions and limits").fill(
      "Never perform a write action without the Runtime approval checkpoint, and clearly separate verified facts from recommendations."
    );
    await builder.getByRole("button", { name: "Continue" }).click();

    const nativeAbilities = [
      "Current web information",
      "Calculations",
      "Data tables",
      "Documents",
      "Code & repositories",
      "Supplied SQL data"
    ];
    for (const ability of nativeAbilities) await checkChoice(builder.locator(".tool-choice-grid"), ability);
    await builder.getByLabel("Approved Runtime repository roots").fill(".");

    const connectedAppsDetails = builder.locator("details.connected-app-details");
    if (!(await connectedAppsDetails.evaluate((element) => element.open))) {
      await connectedAppsDetails.locator(":scope > summary").click();
    }
    const proofConnectionDetails = builder.locator(".mcp-agent-connections > details").filter({ hasText: "Browser Product Notes" });
    if (!(await proofConnectionDetails.evaluate((element) => element.open))) {
      await proofConnectionDetails.locator(":scope > summary").click();
    }
    await checkChoice(builder.locator(".mcp-agent-connections"), "Search notes");
    await checkChoice(builder.locator(".mcp-agent-connections"), "Create note");

    await builder.locator("details.advanced-handoff-details > summary").click();
    for (const contextLabel of [
      "Work passed from teammates",
      "Remember this conversation",
      "Tables and records"
    ]) {
      await checkChoice(builder.locator(".advanced-handoff-content"), contextLabel);
    }
    for (const outputLabel of [
      "Working answer",
      "Research notes",
      "Recommendations",
      "Structured data",
      "Work for another teammate",
      "Final response"
    ]) {
      await checkChoice(builder.locator(".output-fieldset"), outputLabel);
    }
    await builder.getByRole("button", { name: "Continue" }).click();

    await builder.locator('input[type="file"]').setInputFiles({
      name: "launch-evidence.csv",
      mimeType: "text/csv",
      buffer: Buffer.from("metric,value\nactivation_target,5031\naudience,school librarians", "utf8")
    });
    await builder.getByText("Paste short notes", { exact: false }).click();
    await builder.getByLabel("Private notes and rules").fill(
      "Browser proof note: the approved internal codename is saffron-kite."
    );
    await builder.getByText("Advanced setup", { exact: true }).click();
    await builder.getByLabel("When should Virenis use it?").fill(
      "full contract analysis, launch evidence, browser proof"
    );
    await builder.getByLabel("When should Virenis avoid it?").fill(
      "unapproved side effects, unrelated creative writing"
    );
    const approvedSourcePrefix = await builder.locator(".agent-source-prefix code").innerText();
    const approvedSourcePath = `${approvedSourcePrefix}source.md`;
    await builder.getByLabel("Approved source paths").fill(approvedSourcePath);

    const createAgentResponse = page.waitForResponse((response) => (
      response.request().method() === "POST"
      && new URL(response.url()).pathname === "/api/agents"
    ));
    await builder.getByRole("button", { name: "Add to team" }).click();
    const createdHttpResponse = await createAgentResponse;
    const createdPayload = await createdHttpResponse.json();
    const submittedAgentId = createdHttpResponse.request().postDataJSON()?.id || "unknown";
    requireCondition(
      createdHttpResponse.ok(),
      `Agent ${submittedAgentId} creation failed with ${createdHttpResponse.status()}: ${JSON.stringify(createdPayload)}`
    );
    createdAgentId = createdPayload.id;
    const createdAgentBeforeKnowledge = createdPayload.runtime?.agent || {};
    requireCondition(
      createdAgentBeforeKnowledge.policies?.response?.style === "careful",
      `Initial registration lost the selected response policy: ${JSON.stringify(createdAgentBeforeKnowledge.policies)}`
    );
    await builder.waitFor({ state: "hidden", timeout: 300_000 });

    const agent = await pageApi(page, `/api/agents/${encodeURIComponent(createdAgentId)}`);
    const expectedNativeTools = [
      "web_search",
      "calculator",
      "data_table",
      "document_search",
      "document_read",
      "repo_inspector",
      "sql_runner"
    ];
    requireCondition(
      expectedNativeTools.every((tool) => agent.tools.includes(tool)),
      `The saved web agent lost native abilities: ${JSON.stringify(agent.tools)}`
    );
    requireCondition(
      agent.mcp_bindings?.length === 1
      && agent.mcp_bindings[0].connection_id === connectionId
      && new Set(agent.mcp_bindings[0].tools.map((tool) => tool.name)).size === 2,
      `The saved web agent lost its exact connected-app bindings: ${JSON.stringify(agent.mcp_bindings)}`
    );
    requireCondition(
      ["upstream_route_outputs", "shared_memory", "table_context", "document_context"]
        .every((input) => agent.consumes.includes(input))
      && ["domain_outputs", "evidence_summary", "recommendations", "structured_data", "agent_handoff", "final_answer"]
        .every((output) => agent.produces.includes(output)),
      `The saved web agent lost context or output contracts: ${JSON.stringify({ consumes: agent.consumes, produces: agent.produces })}`
    );
    requireCondition(
      agent.tool_config?.repo_inspector?.roots?.[0] === "."
      && agent.memory?.retention === "session"
      && agent.memory?.read_scopes?.includes("team")
      && agent.permissions?.side_effects?.[0] === "none"
      && agent.routing?.metadata_trust === "runtime_normalized"
      && agent.lifecycle?.state === "ready"
      && agent.lifecycle?.health === "healthy",
      `The canonical Agent Studio contract drifted: ${JSON.stringify(agent)}`
    );
    requireCondition(
      agent.policies?.response?.style === "careful"
      && agent.policies?.memory?.mode === "conversation"
      && ["attached_documents", "current_web", "structured_data", "repository", "connected_app", "upstream_specialist"]
        .every((requirement) => agent.policies?.knowledge?.requirements?.includes(requirement)),
      `The policy compiler lost a selected UI option after knowledge provisioning: ${JSON.stringify({ before: createdAgentBeforeKnowledge.policies, after: agent.policies })}`
    );
    requireCondition(
      agent.resources?.length === 1
      && agent.sources?.includes(approvedSourcePath),
      `The agent's file/resource bindings were not persisted: ${JSON.stringify({ resources: agent.resources, sources: agent.sources })}`
    );

    const documents = await pageApi(page, "/api/documents");
    const uploadedDocument = documents.documents.find((document) => (
      document.resource_for_agent_id === createdAgentId
      && document.title === "launch-evidence"
    ));
    requireCondition(
      uploadedDocument?.scope === "knowledge"
      && uploadedDocument?.enabled === true
      && agent.resources.includes(`agent:${uploadedDocument.agent_id}`),
      `The CSV knowledge UI did not create a bound Runtime document: ${JSON.stringify(uploadedDocument)}`
    );
    const documentChunks = await pageApi(
      page,
      `/api/documents/${encodeURIComponent(uploadedDocument.document_id)}/chunks?limit=100`
    );
    requireCondition(
      documentChunks.chunks.some((chunk) => (
        String(chunk.text || chunk.excerpt || chunk.summary || "").includes("activation_target")
        && String(chunk.text || chunk.excerpt || chunk.summary || "").includes("5031")
      )),
      `The uploaded CSV content was not retrievable from server chunks: ${JSON.stringify(documentChunks.chunks)}`
    );
    const documentSearch = await pageApi(
      page,
      `/api/documents/${encodeURIComponent(uploadedDocument.document_id)}/search`,
      { method: "POST", body: { query: "activation target 5031", top_k: 4 } }
    );
    requireCondition(
      documentSearch.results?.some((chunk) => String(chunk.excerpt || "").includes("5031")),
      `The uploaded CSV could not be retrieved through document search: ${JSON.stringify(documentSearch.results)}`
    );

    const runtime = await runtimeAgent(createdAgentId, runtimeKey);
    requireCondition(
      expectedNativeTools.every((tool) => runtime.tools.includes(tool))
      && runtime.tool_config?.repo_inspector?.roots?.[0] === "."
      && runtime.resources?.includes(`agent:${uploadedDocument.agent_id}`)
      && runtime.lifecycle?.state === "ready"
      && runtime.lifecycle?.health === "healthy",
      `The GPU Runtime did not receive the web Agent Studio contract: ${JSON.stringify(runtime)}`
    );

    const teamDialog = page.getByRole("dialog", { name: "Team studio" });
    requireCondition(
      await teamDialog.locator(".agent-row").filter({ hasText: "Full Contract Browser Analyst" }).count() === 1,
      "The created agent exists on the backend but is missing from the My team UI"
    );
    await fs.mkdir(path.dirname(SCREENSHOT), { recursive: true });
    await page.screenshot({ path: SCREENSHOT, fullPage: true, animations: "disabled" });

    console.log(JSON.stringify({
      ok: true,
      agent_id: createdAgentId,
      native_tools: expectedNativeTools,
      mcp_connection_id: connectionId,
      mcp_tools: agent.mcp_bindings[0].tools.map((tool) => tool.name),
      contexts: agent.consumes,
      outputs: agent.produces,
      repository_roots: agent.tool_config.repo_inspector.roots,
      document_id: uploadedDocument.document_id,
      runtime_lifecycle: runtime.lifecycle,
      screenshot: SCREENSHOT
    }, null, 2));
  } finally {
    if (baseURL && app?.locals?.store) {
      const agentIds = app.locals.store.read().agents
        .filter((agent) => agent.created_by === ACTOR.user_id && !agent.document)
        .map((agent) => agent.id);
      for (const agentId of agentIds) {
        try {
          const current = app.locals.store.read().agents.find((agent) => agent.id === agentId);
          if (current?.enabled !== false) await directApi(baseURL, `/api/agents/${encodeURIComponent(agentId)}`, { method: "DELETE" });
          await directApi(baseURL, `/api/agents/${encodeURIComponent(agentId)}/permanent`, { method: "DELETE" });
          cleanup.push({ type: "agent", id: agentId, purged: true });
        } catch (error) {
          cleanup.push({ type: "agent", id: agentId, purged: false, error: error.message });
        }
      }
      const documentIds = app.locals.store.read().documents
        .filter((document) => document.created_by === ACTOR.user_id && document.enabled !== false)
        .map((document) => document.document_id);
      for (const documentId of documentIds) {
        try {
          await directApi(baseURL, `/api/documents/${encodeURIComponent(documentId)}`, { method: "DELETE" });
          cleanup.push({ type: "document", id: documentId, purged: true });
        } catch (error) {
          cleanup.push({ type: "document", id: documentId, purged: false, error: error.message });
        }
      }
      if (connectionId) {
        try {
          await directApi(baseURL, `/api/mcp/connections/${encodeURIComponent(connectionId)}`, { method: "DELETE" });
          cleanup.push({ type: "connection", id: connectionId, purged: true });
        } catch (error) {
          cleanup.push({ type: "connection", id: connectionId, purged: false, error: error.message });
        }
      }
    }
    if (cleanup.length) console.log(JSON.stringify({ cleanup }));
    await browser?.close().catch(() => undefined);
    await new Promise((resolve) => listener?.close(resolve) || resolve());
    await app?.locals?.drainBackgroundTasks?.({ timeoutMs: 5000 }).catch(() => undefined);
    await app?.locals?.store?.close?.().catch(() => undefined);
    await new Promise((resolve) => mcpServer?.close(resolve) || resolve());
    if (clerkClient && clerkSignInTokenId) {
      await clerkClient.signInTokens.revokeSignInToken(clerkSignInTokenId).catch(() => undefined);
    }
    await fs.rm(tempRoot, { recursive: true, force: true });
    for (const [name, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

#!/usr/bin/env node
/* global console, fetch, process, URL, window */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "@playwright/test";
import express from "express";

import { createApp } from "../server/app.js";
import {
  activateClerkTestTicket,
  createClerkTestTicket,
  revokeClerkTestSession
} from "./clerkTestSession.mjs";
import { activeSessionViewReady } from "../e2e/pipelineSessionBinding.js";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "../../..");
const RUNTIME_URL = String(process.env.AGENT_RUNTIME_API_URL || "").trim();
const RUNTIME_KEY_FILE = String(process.env.AGENT_RUNTIME_API_KEY_FILE || "").trim();
const INITIAL_PROMPT_BODY = "Use only this supplied hypothetical context; no current facts or web research are needed: a neighborhood library with a fixed small budget wants more teenagers to participate after school. Frame the challenge and explain the core users, constraints, assumptions, and success criteria.";
const FOLLOWUP_PROMPT = "Look the other perspectives. And explain more.";
const TOKEN = `brainstorm_ui_${crypto.randomBytes(24).toString("hex")}`;
const AUTHORIZATION = `Bearer ${TOKEN}`;
const ACTOR = { user_id: "brainstorm_ui_user", workspace_id: "brainstorm_ui_workspace", role: "admin" };
const SCREENSHOT = process.env.BRAINSTORM_UI_SCREENSHOT_PATH
  ? path.resolve(process.env.BRAINSTORM_UI_SCREENSHOT_PATH)
  : "";
const EXTERNAL_BASE_URL = String(process.env.BRAINSTORM_UI_BASE_URL || "").trim();
const STORAGE_STATE = String(process.env.BRAINSTORM_UI_STORAGE_STATE || "").trim();
const ALLOW_PERSISTED_TEST_STATE = process.env.BRAINSTORM_UI_ALLOW_PERSISTED_TEST_STATE === "1";
const APP_BOOT_TIMEOUT_MS = Number(process.env.BRAINSTORM_UI_BOOT_TIMEOUT_MS || 60_000);
const CLERK_TEST_USER_ID = process.env.BRAINSTORM_UI_CLERK_USER_ID || "";
const CAPABILITY_ERROR = /selected team cannot yet produce every required outcome|enable a compatible capability|could not complete/i;
const MANAGED_ENV = [
  "NODE_ENV", "WEB_STORE_DRIVER", "APP_API_TOKENS_JSON", "AGENT_RUNTIME_MODE",
  "AGENT_RUNTIME_API_URL", "AGENT_RUNTIME_API_KEY", "AGENT_RUNTIME_API_KEY_FILE",
  "AGENT_RUNTIME_CHAT_TIMEOUT_MS", "AGENT_RUNTIME_ADMIN_TIMEOUT_MS",
  "APP_BILLING_WELCOME_CREDITS", "APP_PUBLIC_ORIGIN"
];

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

async function pageApi(page, endpoint, { method = "GET", body, headers = {} } = {}) {
  const response = await page.evaluate(async ({ endpoint, method, body, headers }) => {
    const result = await fetch(endpoint, {
      method,
      credentials: "same-origin",
      headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
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
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`${method} ${endpoint} failed (${response.status}): ${JSON.stringify(payload)}`);
  }
  return payload;
}

async function waitForRun(page, runId) {
  const deadline = Date.now() + 30 * 60 * 1000;
  while (Date.now() < deadline) {
    const run = await pageApi(page, `/api/chat/runs/${encodeURIComponent(runId)}`);
    if (["completed", "failed"].includes(run.status)) return run;
    await page.waitForTimeout(800);
  }
  throw new Error(`Run ${runId} did not finish.`);
}

async function sendThroughComposer(page, sessionId, prompt) {
  const composer = page.locator('textarea[role="combobox"]');
  await composer.fill(prompt);
  const messageResponse = page.waitForResponse((response) => (
    response.request().method() === "POST"
    && new URL(response.url()).pathname === `/api/chat/sessions/${sessionId}/messages`
  ));
  await page.getByRole("button", { name: "Send message" }).click();
  const queuedResponse = await messageResponse;
  requireCondition(queuedResponse.ok(), `Submitting a Brainstorm prompt failed with ${queuedResponse.status()}`);
  const queued = await queuedResponse.json();
  return waitForRun(page, queued.run_id);
}

async function main() {
  requireCondition(SCREENSHOT, "BRAINSTORM_UI_SCREENSHOT_PATH is required; live evidence must use an explicit disposable path");
  requireCondition(
    !EXTERNAL_BASE_URL || ALLOW_PERSISTED_TEST_STATE,
    "BRAINSTORM_UI_ALLOW_PERSISTED_TEST_STATE=1 is required for an external run because chat, run, and billing evidence persists"
  );
  requireCondition(
    !EXTERNAL_BASE_URL || process.env.CLERK_SECRET_KEY || STORAGE_STATE,
    "BRAINSTORM_UI_STORAGE_STATE is required for an external base URL when no explicit Clerk test session is configured"
  );
  if (!EXTERNAL_BASE_URL) {
    requireCondition(RUNTIME_URL, "AGENT_RUNTIME_API_URL is required for the local live Brainstorm proof");
    requireCondition(RUNTIME_KEY_FILE, "AGENT_RUNTIME_API_KEY_FILE is required for the local live Brainstorm proof");
  }
  const previousEnv = Object.fromEntries(MANAGED_ENV.map((name) => [name, process.env[name]]));
  const tempRoot = EXTERNAL_BASE_URL ? "" : await fs.mkdtemp(path.join(os.tmpdir(), "virenis-brainstorm-ui-"));
  let app;
  let listener;
  let browser;
  let page;
  let baseURL = "";
  let copiedWorkspaceId = "";
  let copiedAgentIds = [];
  let copyListingId = "";
  let copyListingItemId = "";
  let copyIdempotencyKey = "";
  let clerkClient;
  let clerkSignInTokenId = "";
  let clerkSignInTicket = "";
  let clerkSessionId = "";
  let clerkCleanupError = null;
  const resourceCleanup = [];
  try {
    if (!EXTERNAL_BASE_URL) {
      process.env.NODE_ENV = "development";
      process.env.WEB_STORE_DRIVER = "json";
      process.env.APP_API_TOKENS_JSON = JSON.stringify({ [TOKEN]: ACTOR });
      // The isolated server binds a random loopback port. A public origin from
      // .env.local belongs to the long-running development server and would
      // correctly reject this browser's state-changing requests.
      delete process.env.APP_PUBLIC_ORIGIN;
      process.env.AGENT_RUNTIME_MODE = "real";
      process.env.AGENT_RUNTIME_API_URL = RUNTIME_URL;
      delete process.env.AGENT_RUNTIME_API_KEY;
      process.env.AGENT_RUNTIME_API_KEY_FILE = RUNTIME_KEY_FILE;
      process.env.AGENT_RUNTIME_CHAT_TIMEOUT_MS = "1800000";
      process.env.AGENT_RUNTIME_ADMIN_TIMEOUT_MS = "300000";
      process.env.APP_BILLING_WELCOME_CREDITS = "2500";

      app = await createApp({
        dbPath: path.join(tempRoot, "app-db.json"),
        uploadRoot: path.join(tempRoot, "uploads")
      });
      const distRoot = path.join(PROJECT_ROOT, "web", "virenis", "dist");
      app.use(express.static(distRoot, { index: false }));
      app.get("*", (req, res, next) => {
        if (req.path.startsWith("/api/")) return next();
        return res.sendFile(path.join(distRoot, "index.html"));
      });
      listener = await new Promise((resolve, reject) => {
        const server = app.listen(0, "127.0.0.1", () => resolve(server));
        server.once("error", reject);
      });
    }

    baseURL = EXTERNAL_BASE_URL || `http://127.0.0.1:${listener.address().port}`;
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext(EXTERNAL_BASE_URL && !process.env.CLERK_SECRET_KEY
      ? { baseURL, viewport: { width: 1440, height: 1100 }, storageState: STORAGE_STATE }
      : { baseURL, viewport: { width: 1440, height: 1100 } });
    if (!EXTERNAL_BASE_URL) {
      const appOrigin = new URL(baseURL).origin;
      // Authenticate only first-party app/API requests. A global Authorization
      // header would force Clerk's cross-origin script through a failing CORS
      // preflight and leave the browser forever on "Opening Virenis."
      await context.route("**/*", async (route) => {
        const request = route.request();
        if (new URL(request.url()).origin !== appOrigin) {
          await route.continue();
          return;
        }
        await route.continue({
          headers: { ...request.headers(), Authorization: AUTHORIZATION }
        });
      });
    }
    page = await context.newPage();
    const browserDiagnostics = [];
    const pendingRequests = new Set();
    page.on("console", (message) => browserDiagnostics.push(`console:${message.type()}:${message.text()}`));
    page.on("pageerror", (error) => browserDiagnostics.push(`pageerror:${error.message}`));
    page.on("request", (request) => pendingRequests.add(`${request.method()} ${new URL(request.url()).pathname}`));
    page.on("requestfinished", (request) => pendingRequests.delete(`${request.method()} ${new URL(request.url()).pathname}`));
    page.on("requestfailed", (request) => {
      const label = `${request.method()} ${new URL(request.url()).pathname}`;
      pendingRequests.delete(label);
      browserDiagnostics.push(`requestfailed:${label}:${request.failure()?.errorText || "unknown"}`);
    });
    page.on("response", (response) => {
      if (response.status() >= 400) {
        browserDiagnostics.push(`response:${response.status()}:${response.request().method()} ${new URL(response.url()).pathname}`);
      }
    });
    let appEntryUrl = `${baseURL}/app`;
    if (process.env.CLERK_SECRET_KEY) {
      const clerkTicket = await createClerkTestTicket({
        secretKey: process.env.CLERK_SECRET_KEY,
        userId: CLERK_TEST_USER_ID,
        userIdVariable: "BRAINSTORM_UI_CLERK_USER_ID"
      });
      clerkClient = clerkTicket.client;
      clerkSignInTokenId = clerkTicket.signInTokenId;
      clerkSignInTicket = clerkTicket.ticket;
      appEntryUrl = `${baseURL}/login`;
    }
    await page.goto(appEntryUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    if (clerkSignInTicket) {
      try {
        clerkSessionId = await activateClerkTestTicket(page, clerkSignInTicket);
      } catch (error) {
        clerkSessionId = error.clerkSessionId || "";
        throw error;
      }
      await page.waitForFunction(() => (
        window.location.pathname === "/app" && Boolean(window.Clerk?.session)
      ), null, { timeout: 60_000 });
    }
    try {
      await page.locator('textarea[role="combobox"]').waitFor({ state: "visible", timeout: APP_BOOT_TIMEOUT_MS });
    } catch {
      // The app can finish identity hydration just after the first navigation
      // in an isolated bearer-auth browser. A reload exercises the same
      // authenticated app shell without bypassing the UI.
      await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
      try {
        await page.locator('textarea[role="combobox"]').waitFor({ state: "visible", timeout: APP_BOOT_TIMEOUT_MS });
      } catch (error) {
        const bodyText = await page.locator("body").innerText().catch(() => "");
        const visibleUrl = new URL(page.url());
        visibleUrl.search = "";
        visibleUrl.hash = "";
        throw new Error(
          `The authenticated app shell did not expose the composer at ${visibleUrl.toString()}. `
          + `Visible page: ${bodyText.slice(0, 500)}. `
          + `Pending: ${[...pendingRequests].slice(-12).join(", ") || "none"}. `
          + `Diagnostics: ${browserDiagnostics.slice(-12).join(" | ") || "none"}. ${error.message}`
        );
      }
    }

    const marketplace = await pageApi(page, "/api/marketplace?type=workspace");
    const listing = marketplace.items.find((item) => item.title === "Brainstorming");
    requireCondition(listing, "Discover did not contain the Brainstorming team");
    copyListingId = listing.listing_id;
    copyListingItemId = listing.id;
    copyIdempotencyKey = `brainstorm-ui-${crypto.randomBytes(12).toString("hex")}`;
    const copied = await pageApi(page, `/api/marketplace/items/${encodeURIComponent(copyListingItemId)}/copy`, {
      method: "POST",
      headers: { "Idempotency-Key": copyIdempotencyKey },
      body: { listing_id: copyListingId }
    });
    copiedWorkspaceId = copied.agent_workspace.agent_workspace_id;
    const workspace = await pageApi(page, `/api/agent-workspaces/${copiedWorkspaceId}`);
    copiedAgentIds = workspace.agents.map((agent) => agent.id);
    const titleById = new Map(workspace.agents.map((agent) => [agent.id, agent.title]));
    const challengeAgent = workspace.agents.find((agent) => agent.title === "Challenge Framing Agent");
    requireCondition(challengeAgent, "The copied Brainstorming team omitted Challenge Framing Agent");
    const initialPrompt = `@${challengeAgent.id} ${INITIAL_PROMPT_BODY}`;
    requireCondition(workspace.agents.length === 6, "The copied Brainstorming team did not contain six agents");

    await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.locator('textarea[role="combobox"]').waitFor({ state: "visible", timeout: 60_000 });
    const sessionResponse = page.waitForResponse((response) => (
      response.request().method() === "POST"
      && new URL(response.url()).pathname === "/api/chat/sessions"
    ));
    await page.getByRole("button", { name: "New chat", exact: true }).click();
    const sessionPayload = await sessionResponse;
    requireCondition(sessionPayload.ok(), `New chat failed with ${sessionPayload.status()}`);
    const session = await sessionPayload.json();
    await page.waitForFunction(activeSessionViewReady, session.session_id, { timeout: 60_000 });

    const teamTrigger = page.getByRole("button", { name: /Choose team and specialists/ });
    await teamTrigger.click();
    const picker = page.getByRole("dialog", { name: "Choose team and specialists for this chat" });
    await picker.waitFor({ state: "visible", timeout: 30_000 });
    const copiedTeamName = copied.agent_workspace.name || "Brainstorming copy";
    const escapedTeamName = copiedTeamName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const teamOption = picker.getByRole("radio", { name: new RegExp(`^${escapedTeamName}\\b`) });
    if (await teamOption.getAttribute("aria-checked") !== "true") {
      const bindingResponse = page.waitForResponse((response) => (
        response.request().method() === "PATCH"
        && new URL(response.url()).pathname === `/api/chat/sessions/${session.session_id}/agent-workspace`
      ));
      await teamOption.click();
      requireCondition((await bindingResponse).ok(), "Selecting the Brainstorming team failed");
    }
    await page.keyboard.press("Escape");

    const initialRun = await sendThroughComposer(page, session.session_id, initialPrompt);
    requireCondition(initialRun.status === "completed", `Initial Brainstorm run failed: ${JSON.stringify(initialRun.error || {})}`);
    requireCondition(
      String(initialRun.final_answer || "").trim().length >= 200,
      `Initial Brainstorm answer was empty or too short: ${JSON.stringify({
        answer: String(initialRun.final_answer || "").slice(0, 500),
        decision: initialRun.plan?.routing?.orchestrator?.decision,
        fallback: initialRun.plan?.routing?.orchestrator?.fallback_used,
        outcome: initialRun.plan?.routing?.orchestrator?.outcome_contract,
        planned_adapters: (initialRun.plan?.steps || []).map((step) => step.adapter)
      })}`
    );
    requireCondition(!CAPABILITY_ERROR.test(initialRun.final_answer), "Initial Brainstorm turn returned a capability error");
    const initialSelectedTitles = (initialRun.plan?.steps || []).map((step) => titleById.get(step.adapter) || step.adapter);
    requireCondition(initialSelectedTitles.includes("Challenge Framing Agent"), `Establishing turn omitted Challenge Framing Agent: ${initialSelectedTitles.join(", ")}`);
    requireCondition((initialRun.expert_outputs || []).length >= 1, "Establishing turn bypassed the active Brainstorming team");

    const followupRun = await sendThroughComposer(page, session.session_id, FOLLOWUP_PROMPT);
    requireCondition(followupRun.status === "completed", `Brainstorm follow-up failed: ${JSON.stringify(followupRun.error || {})}`);
    requireCondition(String(followupRun.final_answer || "").trim().length >= 200, "Brainstorm follow-up was empty or too short");
    requireCondition(!CAPABILITY_ERROR.test(followupRun.final_answer), "Brainstorm follow-up returned the retired capability error");
    const orchestrator = followupRun.plan?.routing?.orchestrator || {};
    requireCondition(orchestrator.decision === "delegate", `Follow-up did not delegate through Qwen: ${orchestrator.decision}`);
    requireCondition(orchestrator.outcome_contract?.status === "covered", "Follow-up outcome contract was not covered");
    requireCondition(orchestrator.fallback_used !== "outcome_contract_blocked", "Follow-up hit the retired deterministic blocker");

    const selectedTitles = (followupRun.plan?.steps || []).map((step) => titleById.get(step.adapter) || step.adapter);
    requireCondition(selectedTitles.includes("Perspective & Analogy Agent"), `Qwen omitted Perspective & Analogy Agent: ${selectedTitles.join(", ")}`);
    requireCondition(selectedTitles.includes("Challenge Framing Agent"), `Declared framing dependency was not compiled: ${selectedTitles.join(", ")}`);
    requireCondition((followupRun.expert_outputs || []).length >= 2, "Follow-up did not execute the selected specialist route");
    requireCondition((followupRun.expert_outputs || []).every((output) => output.artifact_validation?.valid === true), "A follow-up specialist produced an invalid artifact");
    requireCondition((followupRun.route_failure_summary || []).length === 0, "Follow-up reported a route failure");

    const assistant = page.locator(".message.assistant").last();
    await assistant.locator(".progressive-answer.complete").waitFor({ state: "visible", timeout: 90_000 });
    const renderedAnswer = await assistant.locator(".formatted-text").innerText();
    requireCondition(renderedAnswer.trim().length >= 200, "The UI did not render the follow-up answer");
    requireCondition(!CAPABILITY_ERROR.test(renderedAnswer), "The UI rendered the retired capability error");
    requireCondition(await assistant.locator(".formatted-text h2, .formatted-text h3").count() >= 1, "The follow-up lacked readable structure");

    await fs.mkdir(path.dirname(SCREENSHOT), { recursive: true });
    await page.screenshot({ path: SCREENSHOT, fullPage: true, animations: "disabled" });
    console.log(JSON.stringify({
      ok: true,
      initial_prompt: initialPrompt,
      followup_prompt: FOLLOWUP_PROMPT,
      initial_run_id: initialRun.run_id,
      followup_run_id: followupRun.run_id,
      initial_selected_agents: initialSelectedTitles,
      selected_agents: selectedTitles,
      specialist_outputs: followupRun.expert_outputs.length,
      final_answer_characters: followupRun.final_answer.length,
      outcome_status: orchestrator.outcome_contract.status,
      capability_error_visible: false,
      screenshot: SCREENSHOT
    }, null, 2));
  } finally {
    const cleanupRequest = !EXTERNAL_BASE_URL && baseURL
      ? (endpoint, options) => directApi(baseURL, endpoint, options)
      : page
        ? (endpoint, options) => pageApi(page, endpoint, options)
        : null;
    if (!copiedWorkspaceId && copyListingId && copyListingItemId && copyIdempotencyKey) {
      if (!cleanupRequest) {
        resourceCleanup.push({ type: "copy_receipt", id: copyListingItemId, purged: false, error: "no authenticated cleanup channel is available" });
      } else {
        try {
          const recovered = await cleanupRequest(`/api/marketplace/items/${encodeURIComponent(copyListingItemId)}/copy`, {
            method: "POST",
            headers: { "Idempotency-Key": copyIdempotencyKey },
            body: { listing_id: copyListingId }
          });
          copiedWorkspaceId = recovered.agent_workspace.agent_workspace_id;
          const workspace = await cleanupRequest(`/api/agent-workspaces/${encodeURIComponent(copiedWorkspaceId)}`);
          copiedAgentIds = workspace.agents.map((agent) => agent.id);
        } catch (error) {
          resourceCleanup.push({ type: "copy_receipt", id: copyListingItemId, purged: false, error: error.message });
        }
      }
    }
    if (copiedWorkspaceId) {
      if (!cleanupRequest) {
        resourceCleanup.push({ type: "workspace", id: copiedWorkspaceId, purged: false, error: "no authenticated cleanup channel is available" });
      } else {
        try {
          await cleanupRequest(`/api/agent-workspaces/${encodeURIComponent(copiedWorkspaceId)}`, { method: "DELETE" });
          resourceCleanup.push({ type: "workspace", id: copiedWorkspaceId, purged: true });
        } catch (error) {
          resourceCleanup.push({ type: "workspace", id: copiedWorkspaceId, purged: false, error: error.message });
        }
      }
      for (const agentId of copiedAgentIds.reverse()) {
        if (!cleanupRequest) {
          resourceCleanup.push({ type: "agent", id: agentId, purged: false, error: "no authenticated cleanup channel is available" });
        } else {
          try {
            await cleanupRequest(`/api/agents/${encodeURIComponent(agentId)}`, { method: "DELETE" });
            await cleanupRequest(`/api/agents/${encodeURIComponent(agentId)}/permanent`, { method: "DELETE" });
            resourceCleanup.push({ type: "agent", id: agentId, purged: true });
          } catch (error) {
            resourceCleanup.push({ type: "agent", id: agentId, purged: false, error: error.message });
          }
        }
      }
    }
    if (resourceCleanup.length) console.log(JSON.stringify({ cleanup: resourceCleanup }));
    if (browser) await browser.close().catch(() => undefined);
    await revokeClerkTestSession({
      client: clerkClient,
      sessionId: clerkSessionId,
      signInTokenId: clerkSignInTokenId
    }).catch((error) => { clerkCleanupError = error; });
    if (listener) await new Promise((resolve) => listener.close(resolve));
    if (app?.locals) {
      await app.locals.drainBackgroundTasks({ timeoutMs: 60_000 }).catch(() => undefined);
      await app.locals.store.close().catch(() => undefined);
    }
    if (tempRoot) await fs.rm(tempRoot, { recursive: true, force: true });
    for (const [name, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    if (clerkCleanupError) {
      console.error(JSON.stringify({ ok: false, cleanup_error: clerkCleanupError.message }));
      process.exitCode = 1;
    }
    const failedResourceCleanup = resourceCleanup.filter((item) => item.purged !== true);
    if (failedResourceCleanup.length > 0) {
      console.error(JSON.stringify({ ok: false, resource_cleanup_failed: failedResourceCleanup }));
      process.exitCode = 1;
    }
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message }));
  process.exitCode = 1;
});

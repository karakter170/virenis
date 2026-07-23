#!/usr/bin/env node
/* global console, fetch, process, URL, window */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "@playwright/test";
import express from "express";

import { createApp } from "../server/app.js";
import { activeSessionViewReady } from "../e2e/pipelineSessionBinding.js";
import {
  activateClerkTestTicket,
  createClerkTestTicket,
  revokeClerkTestSession
} from "./clerkTestSession.mjs";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "../../..");
const RUNTIME_URL = String(process.env.AGENT_RUNTIME_API_URL || "").trim();
const RUNTIME_KEY_FILE = String(process.env.AGENT_RUNTIME_API_KEY_FILE || "").trim();
const GREETING_PROMPT = "Hi, how are you?";
const PROMPT = "Good thank you. I'm going to create a match 3 game. Advertising is crucial in match 3 games, so I wanted to ask for your help with the marketing and advertising aspects. What approach do you think I should take? What should I pay attention to?";
const TOKEN = `marketing_ui_${crypto.randomBytes(24).toString("hex")}`;
const AUTHORIZATION = `Bearer ${TOKEN}`;
const ACTOR = { user_id: "marketing_ui_user", workspace_id: "marketing_ui_workspace", role: "admin" };
const SCREENSHOT = process.env.MARKETING_UI_SCREENSHOT_PATH
  ? path.resolve(process.env.MARKETING_UI_SCREENSHOT_PATH)
  : "";
const RUN_EVIDENCE = process.env.MARKETING_UI_RUN_EVIDENCE_PATH
  ? path.resolve(process.env.MARKETING_UI_RUN_EVIDENCE_PATH)
  : "";
const GREETING_EVIDENCE = process.env.MARKETING_UI_GREETING_EVIDENCE_PATH
  ? path.resolve(process.env.MARKETING_UI_GREETING_EVIDENCE_PATH)
  : "";
const EXTERNAL_BASE_URL = String(process.env.MARKETING_UI_BASE_URL || "").trim();
const STORAGE_STATE = String(process.env.MARKETING_UI_STORAGE_STATE || "").trim();
const ALLOW_PERSISTED_TEST_STATE = process.env.MARKETING_UI_ALLOW_PERSISTED_TEST_STATE === "1";
const CLERK_TEST_USER_ID = process.env.MARKETING_UI_CLERK_USER_ID || "";
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
  if (!response.ok) throw new Error(`${method} ${endpoint} failed (${response.status}): ${JSON.stringify(response.payload)}`);
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

async function sendThroughComposer(page, sessionId, content) {
  const composer = page.locator('textarea[role="combobox"]');
  await composer.fill(content);
  const messageResponse = page.waitForResponse((response) => (
    response.request().method() === "POST"
    && new URL(response.url()).pathname === `/api/chat/sessions/${sessionId}/messages`
  ));
  await page.getByRole("button", { name: "Send message" }).click();
  const queuedResponse = await messageResponse;
  requireCondition(queuedResponse.ok(), `Submitting the Marketing prompt failed with ${queuedResponse.status()}`);
  const queued = await queuedResponse.json();
  return waitForRun(page, queued.run_id);
}

async function main() {
  requireCondition(
    SCREENSHOT && RUN_EVIDENCE && GREETING_EVIDENCE,
    "MARKETING_UI_SCREENSHOT_PATH, MARKETING_UI_RUN_EVIDENCE_PATH, and MARKETING_UI_GREETING_EVIDENCE_PATH are required disposable evidence paths"
  );
  requireCondition(
    !EXTERNAL_BASE_URL || ALLOW_PERSISTED_TEST_STATE,
    "MARKETING_UI_ALLOW_PERSISTED_TEST_STATE=1 is required for an external run because chat, run, and billing evidence persists"
  );
  requireCondition(
    !EXTERNAL_BASE_URL || process.env.CLERK_SECRET_KEY || STORAGE_STATE,
    "MARKETING_UI_STORAGE_STATE is required for an external base URL when no explicit Clerk test session is configured"
  );
  if (!EXTERNAL_BASE_URL) {
    requireCondition(RUNTIME_URL, "AGENT_RUNTIME_API_URL is required for the local live Marketing proof");
    requireCondition(RUNTIME_KEY_FILE, "AGENT_RUNTIME_API_KEY_FILE is required for the local live Marketing proof");
  }
  const previousEnv = Object.fromEntries(MANAGED_ENV.map((name) => [name, process.env[name]]));
  const tempRoot = EXTERNAL_BASE_URL ? "" : await fs.mkdtemp(path.join(os.tmpdir(), "virenis-marketing-ui-"));
  let app;
  let listener;
  let browser;
  let page;
  let baseURL = "";
  let clerkClient;
  let clerkSignInTokenId = "";
  let clerkSignInTicket = "";
  let clerkSessionId = "";
  let clerkCleanupError = null;
  let copiedWorkspaceId = "";
  let copiedAgentIds = [];
  let copyListingId = "";
  let copyListingItemId = "";
  let copyIdempotencyKey = "";
  const resourceCleanup = [];
  try {
    if (!EXTERNAL_BASE_URL) {
      process.env.NODE_ENV = "development";
      process.env.WEB_STORE_DRIVER = "json";
      process.env.APP_API_TOKENS_JSON = JSON.stringify({ [TOKEN]: ACTOR });
      process.env.AGENT_RUNTIME_MODE = "real";
      process.env.AGENT_RUNTIME_API_URL = RUNTIME_URL;
      delete process.env.AGENT_RUNTIME_API_KEY;
      process.env.AGENT_RUNTIME_API_KEY_FILE = RUNTIME_KEY_FILE;
      process.env.AGENT_RUNTIME_CHAT_TIMEOUT_MS = "1800000";
      process.env.AGENT_RUNTIME_ADMIN_TIMEOUT_MS = "300000";
      process.env.APP_BILLING_WELCOME_CREDITS = "2500";
      delete process.env.APP_PUBLIC_ORIGIN;

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
      await context.route("**/*", async (route) => {
        const browserRequest = route.request();
        if (new URL(browserRequest.url()).origin !== appOrigin) {
          await route.continue();
          return;
        }
        await route.continue({
          headers: { ...browserRequest.headers(), Authorization: AUTHORIZATION }
        });
      });
    }
    page = await context.newPage();
    let appEntryUrl = `${baseURL}/app`;
    if (process.env.CLERK_SECRET_KEY) {
      const clerkTicket = await createClerkTestTicket({
        secretKey: process.env.CLERK_SECRET_KEY,
        userId: CLERK_TEST_USER_ID,
        userIdVariable: "MARKETING_UI_CLERK_USER_ID"
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
      await page.locator('textarea[role="combobox"]').waitFor({ state: "visible", timeout: 60_000 });
    } catch {
      await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.locator('textarea[role="combobox"]').waitFor({ state: "visible", timeout: 60_000 });
    }

    const marketplace = await pageApi(page, "/api/marketplace?type=workspace");
    const listing = marketplace.items.find((item) => item.title === "Marketing");
    requireCondition(listing, "Discover did not contain the Marketing team");
    copyListingId = listing.listing_id;
    copyListingItemId = listing.id;
    copyIdempotencyKey = `marketing-ui-${crypto.randomBytes(12).toString("hex")}`;
    const copied = await pageApi(page, `/api/marketplace/items/${encodeURIComponent(copyListingItemId)}/copy`, {
      method: "POST",
      headers: { "Idempotency-Key": copyIdempotencyKey },
      body: { listing_id: copyListingId }
    });
    copiedWorkspaceId = copied.agent_workspace.agent_workspace_id;
    const workspace = await pageApi(page, `/api/agent-workspaces/${copiedWorkspaceId}`);
    copiedAgentIds = workspace.agents.map((agent) => agent.id);
    requireCondition(workspace.agents.length === 6, "The copied Marketing team did not contain six agents");
    // The copy happened through the authenticated web API so the currently
    // mounted React tree has not received its normal Marketplace callback.
    // Reload once to hydrate the exact copied workspace before exercising the
    // team picker itself.
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
    const copiedTeamName = copied.agent_workspace.name || "Marketing copy";
    const escapedTeamName = copiedTeamName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const teamOption = picker.getByRole("radio", { name: new RegExp(`^${escapedTeamName}\\b`) });
    if (await teamOption.getAttribute("aria-checked") !== "true") {
      const bindingResponse = page.waitForResponse((response) => (
        response.request().method() === "PATCH"
        && new URL(response.url()).pathname === `/api/chat/sessions/${session.session_id}/agent-workspace`
      ), { timeout: 60_000 });
      try {
        await teamOption.click();
      } catch (error) {
        bindingResponse.catch(() => undefined);
        throw error;
      }
      requireCondition((await bindingResponse).ok(), "Selecting the Marketing team failed");
    } else {
      requireCondition(
        session.agent_workspace_id === copiedWorkspaceId,
        "The picker showed the copied team as selected but the new chat was bound elsewhere"
      );
    }
    await page.keyboard.press("Escape");

    const greetingRun = await sendThroughComposer(page, session.session_id, GREETING_PROMPT);
    await fs.mkdir(path.dirname(GREETING_EVIDENCE), { recursive: true });
    await fs.writeFile(GREETING_EVIDENCE, `${JSON.stringify(greetingRun, null, 2)}\n`, "utf8");
    requireCondition(greetingRun.status === "completed", `Greeting run failed: ${JSON.stringify(greetingRun.error || {})}`);
    requireCondition(
      greetingRun.plan?.routing?.orchestrator?.decision === "direct"
      && (greetingRun.expert_outputs || []).length === 0,
      `The social greeting incorrectly activated Marketing agents: ${JSON.stringify({
        decision: greetingRun.plan?.routing?.orchestrator?.decision,
        adapters: greetingRun.plan?.adapters || [],
        completed: (greetingRun.expert_outputs || []).map((output) => output.adapter),
        semantic_adjudication: greetingRun.plan?.routing?.orchestrator?.semantic_adjudication
      })}`
    );
    requireCondition(
      greetingRun.plan?.routing?.orchestrator?.semantic_adjudication?.accepted === true,
      "The greeting route was not finalized by semantic adjudication"
    );
    const sessionAfterGreeting = await pageApi(page, `/api/chat/sessions/${session.session_id}`);
    requireCondition(
      sessionAfterGreeting.agent_workspace_id === copiedWorkspaceId,
      "The Marketing team binding was lost after the direct greeting turn"
    );
    requireCondition(
      (sessionAfterGreeting.inactive_agent_ids || []).every((agentId) => !copiedAgentIds.includes(agentId)),
      "The greeting turn unexpectedly deactivated a Marketing team member"
    );

    const run = await sendThroughComposer(page, session.session_id, PROMPT);
    // Persist the complete backend result before any UI assertion. Marketing
    // runs are intentionally substantial; retaining this evidence makes a
    // validation failure reproducible even though the isolated test database
    // is removed during cleanup.
    await fs.mkdir(path.dirname(RUN_EVIDENCE), { recursive: true });
    await fs.writeFile(RUN_EVIDENCE, `${JSON.stringify(run, null, 2)}\n`, "utf8");
    requireCondition(run.status === "completed", `Marketing run failed: ${JSON.stringify(run.error || {})}`);
    requireCondition(
      run.plan?.routing?.orchestrator?.semantic_adjudication?.accepted === true,
      "The substantive Marketing route was not finalized by semantic adjudication"
    );
    requireCondition(
      run.expert_outputs.length === 6,
      `The Marketing run did not complete all six agents: ${JSON.stringify({
        completed: run.expert_outputs.map((output) => output.adapter),
        routing: run.routing,
        route_plan: run.route_plan,
        final_answer_preview: String(run.final_answer || "").slice(0, 500)
      })}`
    );
    const leadAgent = workspace.agents.find((agent) => agent.title === "Marketing Lead Agent");
    const leadOutput = run.expert_outputs.find((output) => output.adapter === leadAgent?.id);
    requireCondition(leadOutput, "The completed run omitted the Marketing lead output");
    requireCondition(
      (run.route_failure_summary || []).length === 0
      && run.expert_outputs.every((output) => (
        output.artifact_validation?.valid === true
        && output.consumption_validation?.valid === true
      )),
      `The Marketing DAG completed with an invalid route: ${JSON.stringify({
        route_failures: run.route_failure_summary || [],
        outputs: run.expert_outputs.map((output) => ({
          adapter: output.adapter,
          status: output.status,
          failure: output.failure,
          artifact_validation: output.artifact_validation,
          consumption_validation: output.consumption_validation,
          source_validation: output.source_validation,
          validation_retry: output.validation_retry,
          execution_error: output.execution_error_admin_only,
          answer_preview: String(output.domain_answer || "").slice(0, 800),
          raw_preview: String(output.raw_text_admin_only || "").slice(0, 1600)
        }))
      })}`
    );
    requireCondition(
      leadOutput.terminal_fan_in_recovery?.valid !== true,
      "The Marketing lead fell back to a stitched fan-in instead of producing a usable synthesis"
    );
    requireCondition(
      run.final_answer.length >= 300 && run.final_answer.length <= 12_000,
      `The final synthesis is not a balanced UI-sized answer (${run.final_answer.length} characters): ${JSON.stringify({
        final_answer: run.final_answer,
        lead: {
          status: leadOutput.status,
          failure: leadOutput.failure,
          artifact_validation: leadOutput.artifact_validation,
          consumption_validation: leadOutput.consumption_validation,
          source_validation: leadOutput.source_validation,
          answer_preview: String(leadOutput.domain_answer || "").slice(0, 1500)
        },
        route_failures: run.route_failure_summary || []
      })}`
    );

    const assistant = page.locator(".message.assistant").last();
    await assistant.waitFor({ state: "visible", timeout: 60_000 });
    await assistant.locator(".progressive-answer.complete").waitFor({ state: "visible", timeout: 90_000 });
    const answerText = await assistant.locator(".formatted-text").innerText();
    const rawRuntimeId = /\b(?:query:|route:|artifact:|s\d+:)[a-z0-9_.:-]*[a-f0-9]{8,}\b/i;
    requireCondition(!rawRuntimeId.test(answerText), `A private Runtime id remained visible: ${answerText.match(rawRuntimeId)?.[0]}`);
    requireCondition(await assistant.locator(".formatted-text h2, .formatted-text h3").count() >= 2, "The final answer did not render readable sections");
    requireCondition(await assistant.locator(".answer-source-control").count() >= 1, "The answer did not expose named sources");

    const audienceSource = assistant.getByRole("button", { name: "Open answer source: Audience & Context Analyst" }).first();
    await audienceSource.hover();
    await audienceSource.locator(".answer-source-popover").waitFor({ state: "visible", timeout: 10_000 });
    await audienceSource.click();
    const details = page.getByRole("dialog", { name: "Answer details" });
    await details.waitFor({ state: "visible", timeout: 30_000 });
    requireCondition(await details.locator('[aria-label="Answer source summary"]').count() === 1, "The right panel omitted the answer source summary");
    requireCondition(await details.locator(".detail-row.source-focused[open]").count() === 1, "The cited specialist was not focused and expanded");
    const specialistText = await details.locator(".detail-row.source-focused .agent-full-output").innerText();
    requireCondition(!/audience_brief\s*:\s*\{/i.test(specialistText), "The specialist result still exposed its JSON handoff envelope");
    requireCondition(!rawRuntimeId.test(specialistText), "The specialist panel still exposed a private Runtime id");

    const specialistRows = details.locator(".detail-row");
    requireCondition(await specialistRows.count() === 6, "The right panel did not expose all six specialist outputs");
    for (let index = 0; index < 6; index += 1) {
      const row = specialistRows.nth(index);
      if (await row.getAttribute("open") === null) await row.locator("summary").click();
      const output = row.locator(".agent-full-output");
      await output.waitFor({ state: "visible", timeout: 10_000 });
      const outputText = await output.innerText();
      requireCondition(outputText.trim().length >= 80, `Specialist ${index + 1} rendered an empty result`);
      requireCondition(
        !/^\s*[a-z][a-z0-9_]*(?:answer|brief|framework|ledger|plan|platform|recommendation|shortlist|strategy|system)\s*:\s*\{/i.test(outputText),
        `Specialist ${index + 1} still exposed a schema envelope`
      );
      requireCondition(!rawRuntimeId.test(outputText), `Specialist ${index + 1} exposed a private Runtime id`);
    }

    await fs.mkdir(path.dirname(SCREENSHOT), { recursive: true });
    await page.screenshot({ path: SCREENSHOT, fullPage: true, animations: "disabled" });
    console.log(JSON.stringify({
      ok: true,
      greeting_prompt: GREETING_PROMPT,
      greeting_decision: greetingRun.plan?.routing?.orchestrator?.decision,
      greeting_agents_completed: greetingRun.expert_outputs?.length || 0,
      prompt: PROMPT,
      run_id: run.run_id,
      agents_completed: run.expert_outputs.length,
      final_answer_characters: run.final_answer.length,
      visible_headings: await assistant.locator(".formatted-text h2, .formatted-text h3").count(),
      named_source_controls: await assistant.locator(".answer-source-control").count(),
      source_popover_verified: true,
      right_panel_source_summary_verified: true,
      focused_specialist_verified: true,
      specialist_panels_verified: 6,
      lead_synthesis_used: true,
      stitched_fan_in_fallback_used: false,
      raw_runtime_ids_visible: false,
      run_evidence: RUN_EVIDENCE,
      greeting_evidence: GREETING_EVIDENCE,
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
    await browser?.close().catch(() => undefined);
    await app?.locals?.drainBackgroundTasks?.({ timeoutMs: 60_000 }).catch(() => undefined);
    await app?.locals?.store?.close?.().catch(() => undefined);
    await new Promise((resolve) => listener ? listener.close(resolve) : resolve());
    await revokeClerkTestSession({
      client: clerkClient,
      sessionId: clerkSessionId,
      signInTokenId: clerkSignInTokenId
    }).catch((error) => { clerkCleanupError = error; });
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
  console.error(JSON.stringify({ ok: false, error: error.message, stack: error.stack }, null, 2));
  process.exitCode = 1;
});

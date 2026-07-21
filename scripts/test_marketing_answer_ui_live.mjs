#!/usr/bin/env node
/* global console, fetch, process, URL */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "@playwright/test";
import express from "express";
import request from "supertest";

import { createApp } from "../server/app.js";
import { activeSessionViewReady } from "../e2e/pipelineSessionBinding.js";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "../../..");
const RUNTIME_KEY_FILE = process.env.TCAR_RUNTIME_API_KEY_FILE
  || path.join(PROJECT_ROOT, "outputs", "tcar_api_key.txt");
const PROMPT = "I'm going to do some marketing for my Match 3 game. Where should I start? How should I begin? Can you guide me?";
const TOKEN = `marketing_ui_${crypto.randomBytes(24).toString("hex")}`;
const AUTHORIZATION = `Bearer ${TOKEN}`;
const ACTOR = { user_id: "marketing_ui_user", workspace_id: "marketing_ui_workspace", role: "admin" };
const SCREENSHOT = path.join(PROJECT_ROOT, "outputs", "marketing_answer_ui_proof.png");
const EXTERNAL_BASE_URL = String(process.env.MARKETING_UI_BASE_URL || "").trim();
const STORAGE_STATE = process.env.MARKETING_UI_STORAGE_STATE || "/tmp/virenis-auth-5174.json";
const MANAGED_ENV = [
  "NODE_ENV", "WEB_STORE_DRIVER", "APP_API_TOKENS_JSON", "TCAR_ENGINE_MODE",
  "TCAR_RUNTIME_API_URL", "TCAR_RUNTIME_API_KEY", "TCAR_RUNTIME_API_KEY_FILE",
  "TCAR_RUNTIME_CHAT_TIMEOUT_MS", "TCAR_RUNTIME_ADMIN_TIMEOUT_MS",
  "APP_BILLING_WELCOME_CREDITS"
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

async function waitForRun(page, runId) {
  const deadline = Date.now() + 30 * 60 * 1000;
  while (Date.now() < deadline) {
    const run = await pageApi(page, `/api/chat/runs/${encodeURIComponent(runId)}`);
    if (["completed", "failed"].includes(run.status)) return run;
    await page.waitForTimeout(800);
  }
  throw new Error(`Run ${runId} did not finish.`);
}

async function main() {
  const previousEnv = Object.fromEntries(MANAGED_ENV.map((name) => [name, process.env[name]]));
  const tempRoot = EXTERNAL_BASE_URL ? "" : await fs.mkdtemp(path.join(os.tmpdir(), "virenis-marketing-ui-"));
  let app;
  let listener;
  let browser;
  let page;
  let copiedWorkspaceId = "";
  let copiedAgentIds = [];
  try {
    if (!EXTERNAL_BASE_URL) {
      process.env.NODE_ENV = "development";
      process.env.WEB_STORE_DRIVER = "json";
      process.env.APP_API_TOKENS_JSON = JSON.stringify({ [TOKEN]: ACTOR });
      process.env.TCAR_ENGINE_MODE = "real";
      process.env.TCAR_RUNTIME_API_URL = process.env.TCAR_RUNTIME_API_URL || "http://127.0.0.1:9000";
      delete process.env.TCAR_RUNTIME_API_KEY;
      process.env.TCAR_RUNTIME_API_KEY_FILE = RUNTIME_KEY_FILE;
      process.env.TCAR_RUNTIME_CHAT_TIMEOUT_MS = "1800000";
      process.env.TCAR_RUNTIME_ADMIN_TIMEOUT_MS = "300000";
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
    const baseURL = EXTERNAL_BASE_URL || `http://127.0.0.1:${listener.address().port}`;
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext(EXTERNAL_BASE_URL
      ? { baseURL, viewport: { width: 1440, height: 1100 }, storageState: STORAGE_STATE }
      : { baseURL, viewport: { width: 1440, height: 1100 }, extraHTTPHeaders: { Authorization: AUTHORIZATION } });
    page = await context.newPage();
    await page.goto(`${baseURL}/app`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    try {
      await page.locator('textarea[role="combobox"]').waitFor({ state: "visible", timeout: 60_000 });
    } catch {
      await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.locator('textarea[role="combobox"]').waitFor({ state: "visible", timeout: 60_000 });
    }

    const marketplace = await pageApi(page, "/api/marketplace?type=workspace");
    const listing = marketplace.items.find((item) => item.title === "Marketing");
    requireCondition(listing, "Discover did not contain the Marketing team");
    const copied = await pageApi(page, `/api/marketplace/items/${listing.id}/copy`, {
      method: "POST",
      headers: { "Idempotency-Key": `marketing-ui-${crypto.randomBytes(12).toString("hex")}` },
      body: { listing_id: listing.listing_id }
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

    const composer = page.locator('textarea[role="combobox"]');
    await composer.fill(PROMPT);
    const messageResponse = page.waitForResponse((response) => (
      response.request().method() === "POST"
      && new URL(response.url()).pathname === `/api/chat/sessions/${session.session_id}/messages`
    ));
    await page.getByRole("button", { name: "Send message" }).click();
    const queuedResponse = await messageResponse;
    requireCondition(queuedResponse.ok(), `Submitting the Marketing prompt failed with ${queuedResponse.status()}`);
    const queued = await queuedResponse.json();
    const run = await waitForRun(page, queued.run_id);
    requireCondition(run.status === "completed", `Marketing run failed: ${JSON.stringify(run.error || {})}`);
    requireCondition(run.expert_outputs.length === 6, "The Marketing run did not complete all six agents");
    const leadAgent = workspace.agents.find((agent) => agent.title === "Marketing Lead Agent");
    const leadOutput = run.expert_outputs.find((output) => output.adapter === leadAgent?.id);
    requireCondition(leadOutput, "The completed run omitted the Marketing lead output");
    requireCondition(
      leadOutput.terminal_fan_in_recovery?.valid !== true,
      "The Marketing lead fell back to a stitched fan-in instead of producing a usable synthesis"
    );
    requireCondition(
      run.final_answer.length >= 300 && run.final_answer.length <= 12_000,
      `The final synthesis is not a balanced UI-sized answer (${run.final_answer.length} characters)`
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
      screenshot: SCREENSHOT
    }, null, 2));
  } finally {
    if (page && copiedWorkspaceId) {
      await pageApi(page, `/api/agent-workspaces/${copiedWorkspaceId}`, { method: "DELETE" }).catch(() => undefined);
      for (const agentId of copiedAgentIds.reverse()) {
        await pageApi(page, `/api/agents/${agentId}`, { method: "DELETE" }).catch(() => undefined);
        await pageApi(page, `/api/agents/${agentId}/permanent`, { method: "DELETE" }).catch(() => undefined);
      }
    } else if (app && copiedWorkspaceId) {
      await request(app).delete(`/api/agent-workspaces/${copiedWorkspaceId}`).set("Authorization", AUTHORIZATION).catch(() => undefined);
      for (const agentId of copiedAgentIds.reverse()) {
        await request(app).delete(`/api/agents/${agentId}`).set("Authorization", AUTHORIZATION).catch(() => undefined);
        await request(app).delete(`/api/agents/${agentId}/permanent`).set("Authorization", AUTHORIZATION).catch(() => undefined);
      }
    }
    await browser?.close().catch(() => undefined);
    await app?.locals?.drainBackgroundTasks?.({ timeoutMs: 60_000 }).catch(() => undefined);
    await app?.locals?.store?.close?.().catch(() => undefined);
    await new Promise((resolve) => listener ? listener.close(resolve) : resolve());
    if (tempRoot) await fs.rm(tempRoot, { recursive: true, force: true });
    for (const [name, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message, stack: error.stack }, null, 2));
  process.exitCode = 1;
});

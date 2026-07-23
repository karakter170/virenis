#!/usr/bin/env node
/* global console, document, fetch, process, URL, window */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "@playwright/test";
import express from "express";

import { createApp } from "../server/app.js";
import { processLocalChatRun } from "../tests/fixtures/agentRuntimeSimulator.js";
import {
  activateClerkTestTicket,
  createClerkTestTicket,
  revokeClerkTestSession
} from "./clerkTestSession.mjs";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "../../..");
const TOKEN = `discover_team_isolation_${crypto.randomBytes(24).toString("hex")}`;
const AUTHORIZATION = `Bearer ${TOKEN}`;
const PUBLISHER_TOKEN = `discover_agent_publisher_${crypto.randomBytes(24).toString("hex")}`;
const ACTOR = {
  user_id: "discover_team_isolation_user",
  workspace_id: "discover_team_isolation_workspace",
  role: "admin"
};
const PUBLISHER = {
  user_id: "discover_agent_publisher_user",
  workspace_id: "discover_agent_publisher_workspace",
  role: "user"
};
const CLERK_TEST_USER_ID = process.env.DISCOVER_TEAM_CLERK_USER_ID || "";
const SCREENSHOT = process.env.DISCOVER_TEAM_ISOLATION_SCREENSHOT_PATH
  ? path.resolve(process.env.DISCOVER_TEAM_ISOLATION_SCREENSHOT_PATH)
  : "";
const MANAGED_ENV = [
  "NODE_ENV",
  "WEB_STORE_DRIVER",
  "APP_API_TOKENS_JSON",
  "AGENT_RUNTIME_MODE",
  "APP_BILLING_WELCOME_CREDITS",
  "APP_PUBLIC_ORIGIN"
];

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
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

async function directApi(baseURL, token, endpoint, { method = "GET", body, headers = {} } = {}) {
  const response = await fetch(`${baseURL}${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...headers
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(`${method} ${endpoint} failed (${response.status}): ${JSON.stringify(payload)}`);
  }
  return payload;
}

async function appReady(page) {
  await page.locator('textarea[role="combobox"]').waitFor({ state: "visible", timeout: 60_000 });
}

async function main() {
  requireCondition(SCREENSHOT, "DISCOVER_TEAM_ISOLATION_SCREENSHOT_PATH is required; live evidence must use an explicit disposable path");
  const previousEnv = Object.fromEntries(MANAGED_ENV.map((name) => [name, process.env[name]]));
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "virenis-discover-team-isolation-"));
  let app;
  let listener;
  let browser;
  let clerkClient;
  let clerkSignInTokenId = "";
  let clerkSignInTicket = "";
  let clerkSessionId = "";
  let clerkCleanupError = null;
  try {
    process.env.NODE_ENV = "development";
    process.env.WEB_STORE_DRIVER = "json";
    process.env.APP_API_TOKENS_JSON = JSON.stringify({
      [TOKEN]: ACTOR,
      [PUBLISHER_TOKEN]: PUBLISHER
    });
    process.env.AGENT_RUNTIME_MODE = "simulator";
    process.env.APP_BILLING_WELCOME_CREDITS = "2500";
    delete process.env.APP_PUBLIC_ORIGIN;

    app = await createApp({
      dbPath: path.join(tempRoot, "app-db.json"),
      uploadRoot: path.join(tempRoot, "uploads"),
      chatProcessor: processLocalChatRun
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
    const baseURL = `http://127.0.0.1:${listener.address().port}`;

    const publishedAgent = await directApi(baseURL, PUBLISHER_TOKEN, "/api/agents", {
      method: "POST",
      body: {
        id: "browser_copy_specialist",
        title: "Browser Copy Specialist",
        capability: "Turns a supplied product brief into a concise launch checklist.",
        boundary: "Use only the supplied brief and keep recommendations reversible.",
        consumes: ["user_request", "shared_memory"],
        produces: ["recommendations", "structured_data"],
        routing_cues: ["launch checklist", "product brief"],
        tools: ["calculator"],
        memory: {
          read_scopes: ["conversation", "team"],
          write_scopes: ["conversation"],
          retention: "session",
          sensitivity_limit: "internal"
        },
        permissions: {
          side_effects: ["none"],
          approval_required_for: ["email_send"]
        },
        routing: { metadata_trust: "runtime_normalized" },
        lifecycle: { state: "ready", health: "healthy" }
      }
    });
    await directApi(baseURL, PUBLISHER_TOKEN, `/api/marketplace/items/${publishedAgent.id}`, {
      method: "POST",
      body: {
        item_type: "agent",
        description: "A browser-tested launch checklist specialist."
      }
    });

    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 1100 } });
    const appOrigin = new URL(baseURL).origin;
    await context.route("**/*", async (route) => {
      const request = route.request();
      if (new URL(request.url()).origin !== appOrigin) {
        await route.continue();
        return;
      }
      await route.continue({ headers: { ...request.headers(), authorization: AUTHORIZATION } });
    });
    const page = await context.newPage();
    let appEntryUrl = `${baseURL}/app`;
    if (process.env.CLERK_SECRET_KEY) {
      const clerkTicket = await createClerkTestTicket({
        secretKey: process.env.CLERK_SECRET_KEY,
        userId: CLERK_TEST_USER_ID,
        userIdVariable: "DISCOVER_TEAM_CLERK_USER_ID"
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
      await appReady(page);
    } catch (initialError) {
      if (clerkSignInTicket) {
        const initialUrl = new URL(page.url());
        initialUrl.search = "";
        initialUrl.hash = "";
        const initialBody = await page.locator("body").innerText().catch(() => "");
        throw new Error(
          `The ticket-authenticated app shell did not expose the composer at ${initialUrl}. `
          + `Visible page: ${initialBody.slice(0, 500)}. ${initialError.message}`
        );
      }
      await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
      try {
        await appReady(page);
      } catch (error) {
        const visibleUrl = new URL(page.url());
        visibleUrl.search = "";
        visibleUrl.hash = "";
        const bodyText = await page.locator("body").innerText().catch(() => "");
        throw new Error(
          `The authenticated app shell did not expose the composer at ${visibleUrl}. `
          + `Visible page: ${bodyText.slice(0, 500)}. ${error.message}`
        );
      }
    }
    await page.waitForFunction(() => Boolean(
      document.querySelector(".app-shell")?.getAttribute("data-active-session-id")
    ), null, { timeout: 60_000 });

    const sessions = await pageApi(page, "/api/chat/sessions");
    let sessionId = await page.locator(".app-shell").getAttribute("data-active-session-id");
    const session = sessions.sessions.find((candidate) => candidate.session_id === sessionId);
    requireCondition(session, "The app did not create an initial chat session");

    const previousTeam = await pageApi(page, "/api/agent-workspaces", {
      method: "POST",
      body: { name: "Previous active team", description: "Regression fixture" }
    });
    const oldAgentIds = [];
    for (const [id, title] of [
      ["previous_planner", "Previous Planner"],
      ["previous_reviewer", "Previous Reviewer"]
    ]) {
      const agent = await pageApi(page, "/api/agents", {
        method: "POST",
        body: {
          id,
          title,
          capability: `${title} handles only the previous team's regression fixture.`,
          boundary: "Stay within the regression fixture.",
          consumes: ["user_request"],
          produces: [`${id}_output`],
          routing_cues: [title.toLowerCase()],
          agent_workspace_id: previousTeam.agent_workspace_id
        }
      });
      oldAgentIds.push(agent.id);
    }
    await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
    await appReady(page);
    sessionId = await page.locator(".app-shell").getAttribute("data-active-session-id");
    const previousTeamTrigger = page.locator(".composer-team-trigger");
    await previousTeamTrigger.click();
    const initialPicker = page.getByRole("dialog", { name: "Choose team and specialists for this chat" });
    await initialPicker.getByRole("radio").filter({ hasText: "Previous active team" }).click();
    await page.waitForFunction((workspaceId) => (
      document.querySelector('.team-picker-workspace[aria-checked="true"]')?.textContent?.includes("Previous active team")
      && document.querySelector('.team-picker-workspace[aria-checked="true"]')?.getAttribute("data-team-option") === "true"
      && Boolean(workspaceId)
    ), previousTeam.agent_workspace_id, { timeout: 30_000 });
    await initialPicker.getByLabel("Pause Previous Planner for this chat").click();
    await page.waitForFunction(() => (
      document.querySelector(".composer-team-trigger")?.getAttribute("aria-label")
        ?.startsWith("Previous active team: 1 specialist available.")
    ), null, { timeout: 30_000 });
    await page.keyboard.press("Escape");
    const previousTeamLabel = await page.locator(".composer-team-trigger").getAttribute("aria-label");
    requireCondition(
      /^Previous active team: 1 specialist available\./.test(previousTeamLabel || ""),
      `The previous team was not active before the Discover copy: ${previousTeamLabel}`
    );

    await page.getByRole("button", { name: "Discover", exact: true }).click();
    const studio = page.getByRole("dialog", { name: "Team studio" });
    await studio.waitFor({ state: "visible", timeout: 30_000 });
    await studio.getByRole("button", { name: "View Marketing" }).click();
    const detail = page.getByRole("dialog", { name: "Marketing" });
    await detail.getByRole("button", { name: "Add this team" }).waitFor({ state: "visible", timeout: 30_000 });
    const copyResponse = page.waitForResponse((response) => (
      response.request().method() === "POST"
      && /\/api\/marketplace\/items\/[^/]+\/copy$/.test(new URL(response.url()).pathname)
    ));
    await detail.getByRole("button", { name: "Add this team" }).click();
    const copiedHttpResponse = await copyResponse;
    requireCondition(copiedHttpResponse.ok(), `Discover copy failed with ${copiedHttpResponse.status()}`);
    const copied = await copiedHttpResponse.json();
    const copiedWorkspaceId = copied.agent_workspace.agent_workspace_id;

    const myTeam = page.getByRole("dialog", { name: "Team studio" });
    await myTeam.waitFor({ state: "visible", timeout: 60_000 });
    await page.waitForFunction((workspaceId) => {
      const select = document.querySelector(".agent-workspace-toolbar select");
      return select?.value === workspaceId;
    }, copiedWorkspaceId, { timeout: 60_000 });

    const copiedDetail = await pageApi(page, `/api/agent-workspaces/${copiedWorkspaceId}`);
    const copiedIds = new Set(copiedDetail.agent_ids);
    const copiedTitles = new Set(copiedDetail.agents.map((agent) => agent.title));
    const visibleRows = await myTeam.locator(".agent-list .agent-row").evaluateAll((rows) => rows.map((row) => ({
      title: row.querySelector(".row-copy strong")?.textContent?.trim() || "",
      status: row.querySelector(".row-copy small")?.textContent?.trim() || ""
    })));
    const oldRows = visibleRows.filter((row) => ["Previous Planner", "Previous Reviewer"].includes(row.title));
    requireCondition(oldRows.length === 0, `Previous-team specialists leaked into the copied team: ${JSON.stringify(oldRows)}`);
    requireCondition(
      visibleRows.length === copiedDetail.agent_count,
      `The copied team rendered ${visibleRows.length} specialists but its backend contract contains ${copiedDetail.agent_count}`
    );
    requireCondition(
      visibleRows.every((row) => copiedTitles.has(row.title)),
      `The UI rendered a specialist outside the copied workspace: ${JSON.stringify(visibleRows)}`
    );

    await myTeam.getByRole("button", { name: "Team map", exact: true }).click();
    const graphTitles = (await myTeam.locator(".graph-node > span:first-child").allTextContents())
      .map((title) => title.trim());
    requireCondition(
      graphTitles.length === copiedDetail.agent_count && graphTitles.every((title) => copiedTitles.has(title)),
      `The team map did not isolate the copied roster: ${JSON.stringify(graphTitles)}`
    );
    await myTeam.getByRole("button", { name: "My team", exact: true }).click();

    const sessionAfterCopy = await pageApi(page, `/api/chat/sessions/${sessionId}`);
    const staleInactiveIds = (sessionAfterCopy.inactive_agent_ids || []).filter((id) => !copiedIds.has(id));
    requireCondition(
      staleInactiveIds.length === 0,
      `The switched session retained inactive ids from its previous team: ${staleInactiveIds.join(", ")}`
    );
    const sessionAgents = await pageApi(page, `/api/agents?session_id=${sessionId}`);
    const previousCatalogAgents = sessionAgents.agents.filter((agent) => oldAgentIds.includes(agent.id));
    requireCondition(
      previousCatalogAgents.every((agent) => (
        agent.agent_workspace_member === false && agent.session_active === null
      )),
      `Previous-team catalog records still looked active or inactive in the copied team: ${JSON.stringify(previousCatalogAgents)}`
    );

    await myTeam.getByRole("button", { name: "Close" }).click();
    const teamTrigger = page.getByRole("button", { name: /Choose team and specialists/ });
    await teamTrigger.click();
    const picker = page.getByRole("dialog", { name: "Choose team and specialists for this chat" });
    const quickTitles = await picker.locator(".quick-agent-list label strong").allTextContents();
    requireCondition(
      quickTitles.length === copiedDetail.agent_count && quickTitles.every((title) => copiedTitles.has(title.trim())),
      `The composer picker did not isolate the copied roster: ${JSON.stringify(quickTitles)}`
    );
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: "My team", exact: true }).click();
    await page.getByRole("dialog", { name: "Team studio" }).waitFor({ state: "visible", timeout: 30_000 });

    const copiedCountBeforeAgent = copiedDetail.agent_count;
    await page.getByRole("dialog", { name: "Team studio" })
      .getByRole("button", { name: "Discover", exact: true })
      .click();
    const discover = page.getByRole("dialog", { name: "Team studio" });
    const search = discover.getByPlaceholder("Search roles, teams, or publishers");
    await search.fill("Browser Copy Specialist");
    const specialistCard = discover.locator(".market-card").filter({ hasText: "Browser Copy Specialist" });
    await specialistCard.waitFor({ state: "visible", timeout: 30_000 });

    await specialistCard.getByRole("button", { name: "Rate", exact: true }).click();
    const ratingDialog = page.getByRole("dialog", { name: "Rate Browser Copy Specialist" });
    await ratingDialog.getByRole("button", { name: "4 stars" }).click();
    await ratingDialog.getByRole("button", { name: "Save rating" }).click();
    await discover.waitFor({ state: "visible", timeout: 30_000 });
    const ratedListing = await pageApi(page, `/api/marketplace/items/${publishedAgent.id}`);
    requireCondition(
      ratedListing.my_rating?.score === 4,
      `The Discover rating UI did not persist its backend rating: ${JSON.stringify(ratedListing.my_rating)}`
    );

    await search.fill("Browser Copy Specialist");
    await discover.getByRole("button", { name: "View Browser Copy Specialist" }).click();
    const agentDetail = page.getByRole("dialog", { name: "Browser Copy Specialist" });
    await agentDetail.getByRole("button", { name: "Add to my team" }).waitFor({ state: "visible", timeout: 30_000 });
    const agentCopyResponse = page.waitForResponse((response) => (
      response.request().method() === "POST"
      && new URL(response.url()).pathname === `/api/marketplace/items/${publishedAgent.id}/copy`
    ));
    await agentDetail.getByRole("button", { name: "Add to my team" }).click();
    const agentCopyHttpResponse = await agentCopyResponse;
    requireCondition(agentCopyHttpResponse.ok(), `Discover specialist copy failed with ${agentCopyHttpResponse.status()}`);
    const agentCopy = await agentCopyHttpResponse.json();
    const copiedAgentId = agentCopy.agent.id;

    const copiedWorkspaceAfterAgent = await pageApi(page, `/api/agent-workspaces/${copiedWorkspaceId}`);
    requireCondition(
      copiedWorkspaceAfterAgent.agent_count === copiedCountBeforeAgent + 1
      && copiedWorkspaceAfterAgent.agent_ids.includes(copiedAgentId),
      `The specialist copy did not join the selected team: ${JSON.stringify(copiedWorkspaceAfterAgent.agent_ids)}`
    );
    const copiedAgent = await pageApi(page, `/api/agents/${copiedAgentId}`);
    requireCondition(
      copiedAgent.title === "Browser Copy Specialist"
      && copiedAgent.memory?.retention === "session"
      && copiedAgent.routing?.metadata_trust === "runtime_normalized"
      && copiedAgent.lifecycle?.health === "healthy",
      `The Discover specialist copy lost its canonical contract: ${JSON.stringify(copiedAgent)}`
    );
    const teamAfterAgentCopy = page.getByRole("dialog", { name: "Team studio" });
    await teamAfterAgentCopy.waitFor({ state: "visible", timeout: 30_000 });
    requireCondition(
      await teamAfterAgentCopy.locator(".agent-row").filter({ hasText: "Browser Copy Specialist" }).count() === 1,
      "The copied specialist was persisted but did not appear in the My team UI"
    );

    await fs.mkdir(path.dirname(SCREENSHOT), { recursive: true });
    await page.screenshot({ path: SCREENSHOT, fullPage: true, animations: "disabled" });
    console.log(JSON.stringify({
      ok: true,
      previous_team_agent_ids: oldAgentIds,
      copied_workspace_id: copiedWorkspaceId,
      copied_agent_count: copiedDetail.agent_count,
      copied_individual_agent_id: copiedAgentId,
      copied_agent_count_after_individual_copy: copiedWorkspaceAfterAgent.agent_count,
      discover_rating: ratedListing.my_rating.score,
      rendered_agent_count: visibleRows.length,
      stale_inactive_ids: staleInactiveIds,
      screenshot: SCREENSHOT
    }, null, 2));
  } finally {
    await browser?.close().catch(() => undefined);
    await new Promise((resolve) => listener?.close(resolve) || resolve());
    await app?.locals?.drainBackgroundTasks?.({ timeoutMs: 5000 }).catch(() => undefined);
    await app?.locals?.store?.close?.().catch(() => undefined);
    await revokeClerkTestSession({
      client: clerkClient,
      sessionId: clerkSessionId,
      signInTokenId: clerkSignInTokenId
    }).catch((error) => { clerkCleanupError = error; });
    await fs.rm(tempRoot, { recursive: true, force: true });
    for (const [name, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    if (clerkCleanupError) {
      console.error(JSON.stringify({ ok: false, cleanup_error: clerkCleanupError.message }));
      process.exitCode = 1;
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

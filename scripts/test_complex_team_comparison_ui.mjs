#!/usr/bin/env node
/* global console, document, process */

import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import express from "express";

const externalBaseURL = String(process.env.TEAM_COMPARISON_BASE_URL || "").trim();
const projectRoot = path.resolve(import.meta.dirname, "../../..");
const screenshot = path.join(projectRoot, "outputs/product_marketing/qwen_team_showcase/showcase-page.png");

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  await fs.mkdir(path.dirname(screenshot), { recursive: true });
  const reportPath = path.join(
    projectRoot,
    "web/virenis/marketing/router-quality-showcase/complex-team-comparison/report.json",
  );
  const report = JSON.parse(await fs.readFile(reportPath, "utf8"));
  const scenario = report.cases.find((item) => item.id === "marketing_match3_launch");
  requireCondition(Boolean(scenario), "Marketing scenario is missing from the captured report");
  const baseCriteria = new Map(scenario.base.score.criteria.map((item) => [item.id, item]));
  const expectedTeamOnly = scenario.team.score.criteria.filter(
    (item) => item.met && !baseCriteria.get(item.id)?.met,
  ).length;
  requireCondition(
    scenario.team.agents.length > 0 && scenario.team.agents.length <= 16,
    "captured team violates the one-to-sixteen agent contract",
  );
  let listener;
  let baseURL = externalBaseURL;
  const comparisonPath = externalBaseURL
    ? "/marketing/router-quality-showcase/complex-team-comparison/index.html"
    : "/web/virenis/marketing/router-quality-showcase/complex-team-comparison/index.html";
  if (!baseURL) {
    const app = express();
    app.use(express.static(projectRoot));
    listener = await new Promise((resolve, reject) => {
      const server = app.listen(0, "127.0.0.1", () => resolve(server));
      server.once("error", reject);
    });
    baseURL = `http://127.0.0.1:${listener.address().port}`;
  }
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    await page.goto(`${baseURL}${comparisonPath}`, {
      waitUntil: "networkidle",
      timeout: 60_000,
    });
    await page.waitForFunction(() => document.body.dataset.ready === "true", null, { timeout: 30_000 });
    requireCondition(
      await page.locator("[data-agent-pipeline] li").count() === scenario.team.agents.length,
      "pipeline does not match the captured specialist roster",
    );
    requireCondition(
      await page.locator("[data-checklist] tr").count() === scenario.rubric.length,
      "scorecard does not match the predeclared rubric",
    );
    requireCondition(
      await page.locator("[data-checklist] tr.team-only").count() === expectedTeamOnly,
      "team-only rows do not match the captured deterministic scores",
    );
    requireCondition(
      Number(await page.locator("[data-team-score]").innerText())
        === scenario.team.metrics.required_outcomes_covered
      && Number(await page.locator("[data-base-score]").innerText())
        === scenario.base.metrics.required_outcomes_covered,
      "rendered score totals do not match report.json",
    );
    requireCondition(await page.locator("[data-team-answer] h2").count() >= 5, "team answer did not render as structured prose");
    requireCondition((await page.locator("[data-density-lift]").innerText()).startsWith("+"), "coverage-density uplift is missing");
    requireCondition((await page.locator("[data-token-multiple]").innerText()).endsWith("×"), "compute multiple is missing");

    const accessibility = await new AxeBuilder({ page }).analyze();
    const serious = accessibility.violations.filter((item) => ["serious", "critical"].includes(item.impact));
    requireCondition(serious.length === 0, `serious accessibility violations: ${JSON.stringify(serious)}`);
    await page.screenshot({ path: screenshot, fullPage: true });
    console.log(JSON.stringify({
      ok: true,
      pipeline_roles: scenario.team.agents.length,
      checklist_rows: scenario.rubric.length,
      team_only_rows: expectedTeamOnly,
      serious_accessibility_violations: 0,
      screenshot,
    }, null, 2));
  } finally {
    await browser.close();
    if (listener) await new Promise((resolve) => listener.close(resolve));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

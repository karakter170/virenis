/* global console, document, fetch, HTMLButtonElement, navigator, process, URL */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { AGENT_TEAMS, PIPELINE_SCENARIOS } from "./pipelineScenarios.js";
import { artifactDirectoryForOutput } from "./pipelineArtifactPaths.js";
import { activeSessionViewReady, assertRunSession } from "./pipelineSessionBinding.js";
import { parsePipelineRunnerArgs, PIPELINE_RUNNER_USAGE } from "./pipelineRunnerCli.js";
import { pipelineRunSummary } from "./pipelineRunSummary.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "../../..");
const baseURL = process.env.PIPELINE_BASE_URL || "http://localhost:5174";
const storageState = process.env.PIPELINE_STORAGE_STATE || "/tmp/virenis-auth-5174.json";
const concurrency = Math.max(1, Math.min(6, Number(process.env.PIPELINE_CONCURRENCY || 2)));
const timeoutMs = Math.max(60_000, Number(process.env.PIPELINE_RUN_TIMEOUT_MS || 720_000));
const outputPath = process.env.PIPELINE_OUTPUT
  || path.join(projectRoot, "outputs/virenis_pipeline_e2e_20260719/raw_results.json");
// Namespace screenshots by the result file. Smoke, correction, and final
// benchmark runs often share one parent directory; a flat artifact directory
// allowed a later scenario rerun to overwrite earlier visual evidence.
const artifactDir = artifactDirectoryForOutput(outputPath);
const resume = process.env.PIPELINE_RESUME === "1";
const scenarioFilter = new Set(String(process.env.PIPELINE_SCENARIOS || "")
  .split(",").map((value) => value.trim()).filter(Boolean));

const attachmentFixtures = {
  doc_quarterly_report_risks: {
    file: path.join(projectRoot, "sources/tcar_documents/report_d042998e/source.txt"),
    title: "Phase209 Evaluation Report",
    cues: "Phase209 report, route exact, route recall, route precision"
  },
  doc_resume_role_fit: {
    file: path.join(here, "fixtures/e2e-resume.txt"),
    title: "Mete Yesil Resume",
    cues: "resume, data science, AI experience, interview"
  },
  doc_readme_local_setup: {
    file: path.join(here, "../marketing/router-quality-showcase/README.md"),
    title: "Router Showcase README",
    cues: "README, regenerate, capture scripts, environment prerequisite"
  }
};

function now() {
  return new Date().toISOString();
}

async function api(page, endpoint, { method = "GET", body, headers = {} } = {}) {
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
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch { payload = { raw: text }; }
    return { ok: result.ok, status: result.status, payload };
  }, { endpoint, method, body, headers });
  if (!response.ok) {
    const error = new Error(`${method} ${endpoint} failed (${response.status}): ${JSON.stringify(response.payload)}`);
    error.status = response.status;
    error.payload = response.payload;
    throw error;
  }
  return response.payload;
}

async function waitForApp(page) {
  await page.goto(`${baseURL}/app`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  const composer = page.locator('textarea[role="combobox"]');
  const newChat = page.getByRole("button", { name: "New chat", exact: true });
  try {
    await composer.waitFor({ state: "visible", timeout: 45_000 });
  } catch {
    await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
    await composer.waitFor({ state: "visible", timeout: 45_000 });
  }
  // The composer can render while the initial session is still hydrating.
  // Creating a session during that short interval races the disabled sidebar
  // action and leaves pending response waiters behind. Treat the enabled UI
  // control as the browser-ready boundary used by every worker.
  await newChat.waitFor({ state: "visible", timeout: 45_000 });
  await page.waitForFunction(() => {
    const button = document.querySelector('button[aria-label="New chat"]');
    return button instanceof HTMLButtonElement && !button.disabled;
  }, undefined, { timeout: 90_000 });
}

async function createSessionThroughUi(page) {
  const responsePromise = page.waitForResponse((response) => (
    response.request().method() === "POST"
    && new URL(response.url()).pathname === "/api/chat/sessions"
  ), { timeout: 60_000 });
  try {
    await page.getByRole("button", { name: "New chat", exact: true }).click();
  } catch (error) {
    // The waiter was registered before the click so the response cannot be
    // missed. Observe its rejection if the UI action itself fails; otherwise
    // closing the worker page turns it into an unhandled promise rejection.
    responsePromise.catch(() => undefined);
    throw error;
  }
  const response = await responsePromise;
  const text = await response.text();
  if (!response.ok()) {
    throw new Error(`New chat UI request failed (${response.status()}): ${text}`);
  }
  const session = JSON.parse(text);
  // A generic session-detail response is not a sufficient readiness signal:
  // an outstanding refresh for the previous chat can satisfy it while React
  // still renders and submits against that old session. Wait until the exact
  // created row is active and its empty message view has committed.
  await page.waitForFunction(activeSessionViewReady, session.session_id, { timeout: 60_000 });
  await page.locator('textarea[role="combobox"]').waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForFunction(() => {
    const button = document.querySelector('button[aria-label="New chat"]');
    return button instanceof HTMLButtonElement && !button.disabled;
  }, undefined, { timeout: 60_000 });
  return session;
}

async function selectTeamThroughUi(page, teamName) {
  const trigger = page.getByRole("button", { name: /Choose team and specialists/ });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Choose team and specialists for this chat" });
  await dialog.waitFor({ state: "visible", timeout: 30_000 });
  const option = dialog.getByRole("radio", { name: new RegExp(`^${teamName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`) });
  if (await option.getAttribute("aria-checked") !== "true") {
    const responsePromise = page.waitForResponse((response) => (
      response.request().method() === "PATCH"
      && /\/api\/chat\/sessions\/[^/]+\/agent-workspace$/.test(new URL(response.url()).pathname)
    ), { timeout: 60_000 });
    try {
      await option.click();
    } catch (error) {
      responsePromise.catch(() => undefined);
      throw error;
    }
    const response = await responsePromise;
    if (!response.ok()) throw new Error(`Team picker request failed (${response.status()}): ${await response.text()}`);
    await page.waitForFunction((expected) => (
      document.querySelector('.composer-team-trigger')?.getAttribute("aria-label")?.startsWith(`${expected}:`)
    ), teamName, { timeout: 30_000 });
  }
  await page.keyboard.press("Escape");
  await page.waitForTimeout(100);
}

async function attachThroughUi(page, scenario) {
  const fixture = attachmentFixtures[scenario.id];
  if (!fixture) throw new Error(`No attachment fixture is configured for ${scenario.id}.`);
  await fs.access(fixture.file);
  await page.getByRole("button", { name: "Attach file to this chat" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.waitFor({ state: "visible", timeout: 30_000 });
  await dialog.locator('input[type="file"]').setInputFiles(fixture.file);
  await dialog.getByLabel(/Name/).fill(fixture.title);
  const advanced = dialog.locator("details.advanced-fields");
  await advanced.locator("summary").click();
  await dialog.getByText("When to use this file", { exact: true }).locator("..").locator("textarea").fill(fixture.cues);
  const responsePromise = page.waitForResponse((response) => (
    response.request().method() === "POST"
    && new URL(response.url()).pathname === "/api/documents"
  ), { timeout: 180_000 });
  await dialog.getByRole("button", { name: "Attach", exact: true }).click();
  const response = await responsePromise;
  const text = await response.text();
  if (!response.ok()) throw new Error(`Attachment UI request failed (${response.status()}): ${text}`);
  const registration = JSON.parse(text);
  await dialog.waitFor({ state: "hidden", timeout: 60_000 });
  return { ...registration, fixture: { file: fixture.file, title: fixture.title } };
}

async function submitThroughUi(page, scenario, expectedSessionId) {
  const composer = page.locator('textarea[role="combobox"]');
  await composer.waitFor({ state: "visible", timeout: 30_000 });
  await composer.fill(scenario.prompt);
  const expectedPath = `/api/chat/sessions/${encodeURIComponent(expectedSessionId)}/messages`;
  const responsePromise = page.waitForResponse((response) => (
    response.request().method() === "POST"
    && /\/api\/chat\/sessions\/[^/]+\/messages$/.test(new URL(response.url()).pathname)
  ), { timeout: 60_000 });
  const submittedAt = now();
  try {
    await page.getByRole("button", { name: "Send message" }).click();
  } catch (error) {
    responsePromise.catch(() => undefined);
    throw error;
  }
  const response = await responsePromise;
  const actualPath = new URL(response.url()).pathname;
  if (actualPath !== expectedPath) {
    throw new Error(`Message/session mismatch: expected ${expectedPath}, received ${actualPath}.`);
  }
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = { raw: text }; }
  if (!response.ok()) {
    const error = new Error(`Message UI request failed (${response.status()}): ${text}`);
    error.status = response.status();
    error.payload = payload;
    throw error;
  }
  return { ...payload, submitted_at: submittedAt, accepted_at: now(), http_status: response.status() };
}

async function pollRun(page, runId) {
  const started = Date.now();
  const samples = [];
  let lastStatus = null;
  for (;;) {
    const run = await api(page, `/api/chat/runs/${encodeURIComponent(runId)}`);
    if (run.status !== lastStatus) {
      samples.push({ status: run.status, observed_at: now(), elapsed_ms: Date.now() - started });
      lastStatus = run.status;
    }
    if (["completed", "failed", "cancelled"].includes(run.status)) {
      return { run, samples, poll_elapsed_ms: Date.now() - started };
    }
    if (Date.now() - started > timeoutMs) {
      const error = new Error(`Run ${runId} did not reach a terminal state within ${timeoutMs}ms.`);
      error.lastRun = run;
      error.samples = samples;
      throw error;
    }
    await page.waitForTimeout(1_500);
  }
}

function groupScenarios(scenarios) {
  const groups = new Map();
  for (const scenario of scenarios) {
    if (!groups.has(scenario.turnGroup)) groups.set(scenario.turnGroup, []);
    groups.get(scenario.turnGroup).push(scenario);
  }
  return [...groups.values()].map((items) => items.sort((left, right) => left.turn - right.turn));
}

function errorRecord(error) {
  return {
    name: error?.name || "Error",
    message: String(error?.message || error),
    status: error?.status || null,
    payload: error?.payload || null,
    stack: String(error?.stack || "").split("\n").slice(0, 12).join("\n"),
    last_run: error?.lastRun || null,
    status_samples: error?.samples || null
  };
}

async function main() {
  await fs.mkdir(artifactDir, { recursive: true });
  let record = {
    schema_version: "virenis-browser-pipeline-benchmark-v1",
    started_at: now(),
    completed_at: null,
    base_url: baseURL,
    requested_concurrency: concurrency,
    scenario_count: 0,
    results: [],
    worker_errors: []
  };
  if (resume) {
    try { record = JSON.parse(await fs.readFile(outputPath, "utf8")); } catch { /* start fresh */ }
    record.completed_at = null;
    record.resumed_at = now();
  }
  const completedIds = new Set(record.results
    .filter((result) => result.run?.status || result.error)
    .map((result) => result.scenario_id));
  const selected = PIPELINE_SCENARIOS.filter((scenario) => (
    (!scenarioFilter.size || scenarioFilter.has(scenario.id))
    && !completedIds.has(scenario.id)
  ));
  record.scenario_count = PIPELINE_SCENARIOS.filter((scenario) => (
    !scenarioFilter.size || scenarioFilter.has(scenario.id)
  )).length;
  const units = groupScenarios(selected);
  let unitCursor = 0;
  let persistChain = Promise.resolve();
  const persist = () => {
    persistChain = persistChain.then(async () => {
      const temporary = `${outputPath}.tmp`;
      await fs.writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, "utf8");
      await fs.rename(temporary, outputPath);
    });
    return persistChain;
  };

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ storageState, viewport: { width: 1440, height: 1100 } });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: baseURL });
  try {
    const bootstrapPage = await context.newPage();
    await waitForApp(bootstrapPage);
    const workspacePayload = await api(bootstrapPage, "/api/agent-workspaces");
    const workspaceByTeamId = new Map(Object.values(AGENT_TEAMS).map((team) => {
      const workspace = workspacePayload.workspaces.find((item) => item.name === team.name);
      if (!workspace) throw new Error(`Benchmark workspace is missing: ${team.name}. Run pipelineSetup.mjs first.`);
      return [team.id, workspace];
    }));
    if (!record.admin_metrics_before || record.admin_metrics_before.capture_error) {
      try {
        record.admin_metrics_before = await api(bootstrapPage, "/api/admin/metrics");
      } catch (error) {
        record.admin_metrics_before = { capture_error: errorRecord(error) };
      }
    }
    await persist();
    await bootstrapPage.close();

    const categoryScreenshots = new Set(record.results
      .filter((item) => item.artifacts?.screenshot)
      .map((item) => item.category));
    // Clipboard state belongs to the shared browser context. Serialize copy
    // checks so concurrent workers cannot overwrite one another between the
    // UI click and the readback.
    let clipboardChain = Promise.resolve();
    const copyAnswerThroughUi = async (assistant) => {
      let copied = "";
      let copyError = null;
      clipboardChain = clipboardChain.then(async () => {
        try {
          await assistant.getByRole("button", { name: "Copy answer" }).click();
          await assistant.page().waitForTimeout(50);
          copied = await assistant.page().evaluate(() => navigator.clipboard.readText());
        } catch (error) {
          copyError = String(error?.message || error);
        }
      });
      await clipboardChain;
      return { copied, copyError };
    };
    const workers = Array.from({ length: Math.min(concurrency, Math.max(1, units.length)) }, async (_, workerIndex) => {
      const page = await context.newPage();
      let activeScenarioId = null;
      const consoleErrors = [];
      const pageErrors = [];
      const failedResponses = [];
      page.on("console", (message) => {
        if (message.type() === "error") consoleErrors.push({ scenario_id: activeScenarioId, at: now(), text: message.text() });
      });
      page.on("pageerror", (error) => pageErrors.push({ scenario_id: activeScenarioId, at: now(), message: error.message }));
      page.on("response", (response) => {
        if (response.status() >= 400) failedResponses.push({
          scenario_id: activeScenarioId,
          at: now(),
          status: response.status(),
          method: response.request().method(),
          path: new URL(response.url()).pathname
        });
      });
      try {
        await waitForApp(page);
        for (;;) {
          const unitIndex = unitCursor++;
          if (unitIndex >= units.length) break;
          const unit = units[unitIndex];
          let session = null;
          try {
            session = await createSessionThroughUi(page);
            const workspace = workspaceByTeamId.get(unit[0].team);
            await selectTeamThroughUi(page, workspace.name);
            for (const scenario of unit) {
              activeScenarioId = scenario.id;
              const startedAt = now();
              const consoleStart = consoleErrors.length;
              const pageErrorStart = pageErrors.length;
              const responseErrorStart = failedResponses.length;
              let result;
              try {
                const attachment = scenario.needsAttachment ? await attachThroughUi(page, scenario) : null;
                const queued = await submitThroughUi(page, scenario, session.session_id);
                const terminal = await pollRun(page, queued.run_id);
                assertRunSession(session.session_id, terminal.run.session_id);
                const expectedAssistantCount = scenario.turn;
                let uiAssistantVisible = false;
                try {
                  const assistant = page.locator(".message.assistant").nth(expectedAssistantCount - 1);
                  await assistant.waitFor({ state: "visible", timeout: 30_000 });
                  // The UI intentionally types the newest answer. Wait for its
                  // terminal DOM state so screenshots and parity checks do not
                  // mistake a mid-animation prefix for a truncated response.
                  await assistant.locator(".progressive-answer.complete")
                    .waitFor({ state: "visible", timeout: 90_000 });
                  uiAssistantVisible = true;
                } catch { /* API terminal state remains authoritative. */ }
                const assistant = page.locator(".message.assistant").nth(expectedAssistantCount - 1);
                const uiAnswer = uiAssistantVisible
                  ? await assistant.locator(".message-content").innerText().catch(() => "")
                  : "";
                const copyResult = uiAssistantVisible
                  ? await copyAnswerThroughUi(assistant)
                  : { copied: "", copyError: null };
                const shouldCapture = terminal.run.status !== "completed"
                  || !uiAssistantVisible
                  || !categoryScreenshots.has(scenario.category);
                let screenshot = null;
                let answerScreenshot = null;
                if (shouldCapture) {
                  screenshot = path.join(artifactDir, `${scenario.id}.png`);
                  await page.screenshot({ path: screenshot, fullPage: true }).catch(() => undefined);
                  if (uiAssistantVisible) {
                    answerScreenshot = path.join(artifactDir, `${scenario.id}-answer.png`);
                    await assistant.screenshot({ path: answerScreenshot, animations: "disabled" })
                      .catch(() => { answerScreenshot = null; });
                  }
                  if (terminal.run.status === "completed" && uiAssistantVisible) categoryScreenshots.add(scenario.category);
                }
                result = {
                  scenario_id: scenario.id,
                  category: scenario.category,
                  team: scenario.team,
                  team_workspace_id: workspace.agent_workspace_id,
                  turn_group: scenario.turnGroup,
                  turn: scenario.turn,
                  prompt: scenario.prompt,
                  expected_decision: scenario.expectedDecision,
                  required_agents: scenario.requiredAgents,
                  allowed_agents: scenario.allowedAgents,
                  forbidden_agents: scenario.forbiddenAgents,
                  oracle_hints: scenario.oracleHints,
                  worker: workerIndex + 1,
                  session_id: session.session_id,
                  attachment,
                  queued,
                  run: terminal.run,
                  status_samples: terminal.samples,
                  poll_elapsed_ms: terminal.poll_elapsed_ms,
                  ui: {
                    assistant_visible: uiAssistantVisible,
                    answer_text: uiAnswer,
                    copied_answer: copyResult.copied,
                    copy_error: copyResult.copyError,
                    answer_matches_api: copyResult.copied.trim() === String(terminal.run.final_answer || "").trim()
                  },
                  diagnostics: {
                    console_errors: consoleErrors.slice(consoleStart),
                    page_errors: pageErrors.slice(pageErrorStart),
                    failed_responses: failedResponses.slice(responseErrorStart)
                  },
                  artifacts: { screenshot, answer_screenshot: answerScreenshot },
                  started_at: startedAt,
                  completed_at: now()
                };
              } catch (error) {
                const screenshot = path.join(artifactDir, `${scenario.id}-error.png`);
                await page.screenshot({ path: screenshot, fullPage: true }).catch(() => undefined);
                result = {
                  scenario_id: scenario.id,
                  category: scenario.category,
                  team: scenario.team,
                  turn_group: scenario.turnGroup,
                  turn: scenario.turn,
                  prompt: scenario.prompt,
                  expected_decision: scenario.expectedDecision,
                  required_agents: scenario.requiredAgents,
                  allowed_agents: scenario.allowedAgents,
                  forbidden_agents: scenario.forbiddenAgents,
                  oracle_hints: scenario.oracleHints,
                  worker: workerIndex + 1,
                  session_id: session?.session_id || null,
                  error: errorRecord(error),
                  diagnostics: {
                    console_errors: consoleErrors.slice(consoleStart),
                    page_errors: pageErrors.slice(pageErrorStart),
                    failed_responses: failedResponses.slice(responseErrorStart)
                  },
                  artifacts: { screenshot },
                  started_at: startedAt,
                  completed_at: now()
                };
              }
              record.results.push(result);
              await persist();
              process.stdout.write(`${JSON.stringify({
                scenario: scenario.id,
                worker: workerIndex + 1,
                status: result.run?.status || "harness_error",
                decision: result.run?.plan?.routing?.orchestrator?.decision || null,
                adapters: (result.run?.plan?.steps || []).map((step) => step.adapter),
                elapsed_sec: result.run?.elapsed_sec || null,
                error: result.error?.message || null
              })}\n`);
              if (result.error && scenario.turn < unit.length) break;
            }
          } catch (error) {
            record.worker_errors.push({ worker: workerIndex + 1, unit: unit.map((item) => item.id), error: errorRecord(error), at: now() });
            await persist();
          }
        }
      } finally {
        await page.close();
      }
    });
    await Promise.all(workers);
    const metricsPage = await context.newPage();
    try {
      await waitForApp(metricsPage);
      record.admin_metrics_after = await api(metricsPage, "/api/admin/metrics");
    } catch (error) {
      record.admin_metrics_after = { capture_error: errorRecord(error) };
    } finally {
      await metricsPage.close();
    }
    await persist();
  } finally {
    await browser.close();
  }
  record.completed_at = now();
  await persist();
  await persistChain;
  console.log(JSON.stringify({ outputPath, ...pipelineRunSummary(record) }, null, 2));
}

const cli = parsePipelineRunnerArgs(process.argv.slice(2));
if (cli.help) {
  console.log(PIPELINE_RUNNER_USAGE);
} else {
  await main();
}

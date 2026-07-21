#!/usr/bin/env node
/* global console, process, setTimeout */

// Live Discover proof: use the current web application to copy every curated
// team, register its canonical contracts with Runtime, route a natural request
// through Qwen, execute the complete dependency DAG on the GPU, and purge all
// temporary Runtime agents before exit.

import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import request from "supertest";

import { createApp } from "../server/app.js";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "../../..");
const RUNTIME_KEY_FILE = process.env.TCAR_RUNTIME_API_KEY_FILE
  || path.join(PROJECT_ROOT, "outputs", "tcar_api_key.txt");
const RUNTIME_URL = process.env.TCAR_RUNTIME_API_URL || "http://127.0.0.1:9000";
const LIVE_TOKEN = `curated_live_${crypto.randomBytes(24).toString("hex")}`;
const AUTH = { Authorization: `Bearer ${LIVE_TOKEN}` };
const ACTOR = {
  user_id: "curated_live_user",
  workspace_id: "curated_live_workspace",
  role: "admin"
};
const ALL_CASES = [
  {
    team: "Engineering",
    lead: "Engineering Lead Agent",
    output: "engineering_recommendation",
    prompt: "Create a decision-ready engineering recommendation for Project Cedar: add passwordless login to a Node.js and PostgreSQL SaaS with no downtime, no forced logout, a reversible migration, explicit security and reliability review, and a testable rollout plan."
  },
  {
    team: "Marketing",
    lead: "Marketing Lead Agent",
    output: "marketing_plan",
    prompt: "Create an evidence-disciplined marketing plan for Moss Bottle, a refillable household cleaner for apartment renters who want less plastic. Use email and short-form video, keep a calm playful voice, distinguish claims from hypotheses, and include a measurement and learning plan."
  },
  {
    team: "Product",
    lead: "Product Lead Agent",
    output: "product_decision_brief",
    prompt: "Create a decision-ready product brief for PantryPair, a shared grocery-list app for roommates. Prioritize offline edits, conflict resolution, accessible simple onboarding, and a one-month validation scope; exclude social feeds and keep assumptions visibly separate from evidence."
  },
  {
    team: "Brainstorming",
    lead: "Brainstorming Facilitator Agent",
    output: "concept_shortlist",
    prompt: "Create a rigorously screened concept shortlist for Project Lantern: help neighborhood libraries attract teenagers after school with low-cost, inclusive ideas and no new construction. Preserve genuinely different options and attach a small decision-changing experiment to each finalist."
  }
];
const requestedTeams = new Set(
  String(process.env.CURATED_LIVE_TEAMS || "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
);
const CASES = requestedTeams.size
  ? ALL_CASES.filter((scenario) => requestedTeams.has(scenario.team.toLowerCase()))
  : ALL_CASES;
const MANAGED_ENV = [
  "NODE_ENV",
  "WEB_STORE_DRIVER",
  "APP_API_TOKENS_JSON",
  "TCAR_ENGINE_MODE",
  "TCAR_RUNTIME_API_URL",
  "TCAR_RUNTIME_API_KEY",
  "TCAR_RUNTIME_API_KEY_FILE",
  "TCAR_RUNTIME_CHAT_TIMEOUT_MS",
  "TCAR_RUNTIME_ADMIN_TIMEOUT_MS",
  "APP_BILLING_WELCOME_CREDITS",
  "APP_BILLING_PROMPT_CREDITS_PER_1K",
  "APP_BILLING_COMPLETION_CREDITS_PER_1K",
  "APP_BILLING_CACHED_CREDITS_PER_1K",
  "APP_BILLING_UNCLASSIFIED_CREDITS_PER_1K",
  "APP_BILLING_MINIMUM_RESERVATION_CREDITS"
];

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function auth(call) {
  return call.set(AUTH);
}

async function waitForRun(app, runId, timeoutMs = 30 * 60 * 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await auth(request(app).get(`/api/chat/runs/${runId}`)).expect(200);
    if (["completed", "failed"].includes(response.body.status)) return response.body;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Run ${runId} did not finish within ${timeoutMs}ms.`);
}

function assertCanonicalAgent(agent, label) {
  requireCondition(agent.contract_version === "virenis-agent-v4", `${label} is not contract v4`);
  requireCondition(agent.agent_contract?.schema_version === "virenis-agent-v4", `${label} has no canonical contract`);
  requireCondition(agent.routing?.metadata_trust === "runtime_normalized", `${label} routing metadata is not normalized`);
  requireCondition(agent.memory?.read_scopes?.includes("conversation"), `${label} cannot read conversation memory`);
  requireCondition(agent.memory?.read_scopes?.includes("team"), `${label} cannot read team memory`);
  requireCondition(agent.memory?.retention === "session", `${label} memory retention drifted`);
  requireCondition(agent.permissions?.side_effects?.length === 1 && agent.permissions.side_effects[0] === "none", `${label} has unexpected side effects`);
  requireCondition(agent.permissions?.approval_required_for?.includes("email_send"), `${label} lost its approval gate`);
  requireCondition(agent.lifecycle?.state === "ready" && agent.lifecycle?.health === "healthy", `${label} is not ready and healthy`);
}

async function cleanup(app, workspaces, agents) {
  const outcomes = [];
  for (const workspaceId of [...workspaces].reverse()) {
    try {
      await auth(request(app).delete(`/api/agent-workspaces/${encodeURIComponent(workspaceId)}`)).expect(200);
      outcomes.push({ workspace: workspaceId, deleted: true });
    } catch (error) {
      outcomes.push({ workspace: workspaceId, deleted: false, error: error.message });
    }
  }
  for (const agentId of [...agents].reverse()) {
    const outcome = { agent: agentId, archived: false, purged: false };
    try {
      await auth(request(app).delete(`/api/agents/${encodeURIComponent(agentId)}`)).expect(200);
      outcome.archived = true;
      await auth(request(app).delete(`/api/agents/${encodeURIComponent(agentId)}/permanent`)).expect(200);
      outcome.purged = true;
    } catch (error) {
      outcome.error = error.message;
    }
    outcomes.push(outcome);
  }
  return outcomes;
}

async function main() {
  requireCondition(CASES.length > 0, "CURATED_LIVE_TEAMS did not match a Discover team");
  await fs.access(RUNTIME_KEY_FILE);
  const previousEnv = Object.fromEntries(MANAGED_ENV.map((name) => [name, process.env[name]]));
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "virenis-curated-live-"));
  const copiedWorkspaceIds = [];
  const copiedAgentIds = [];
  const proofs = [];
  let app = null;
  let cleanupResults = [];
  let stage = "configure live environment";
  try {
    process.env.NODE_ENV = "development";
    process.env.WEB_STORE_DRIVER = "json";
    process.env.APP_API_TOKENS_JSON = JSON.stringify({ [LIVE_TOKEN]: ACTOR });
    process.env.TCAR_ENGINE_MODE = "real";
    process.env.TCAR_RUNTIME_API_URL = RUNTIME_URL;
    delete process.env.TCAR_RUNTIME_API_KEY;
    process.env.TCAR_RUNTIME_API_KEY_FILE = RUNTIME_KEY_FILE;
    process.env.TCAR_RUNTIME_CHAT_TIMEOUT_MS = "1800000";
    process.env.TCAR_RUNTIME_ADMIN_TIMEOUT_MS = "300000";
    process.env.APP_BILLING_WELCOME_CREDITS = "2500";
    process.env.APP_BILLING_PROMPT_CREDITS_PER_1K = "0.10";
    process.env.APP_BILLING_COMPLETION_CREDITS_PER_1K = "0.20";
    process.env.APP_BILLING_CACHED_CREDITS_PER_1K = "0.02";
    process.env.APP_BILLING_UNCLASSIFIED_CREDITS_PER_1K = "0.20";
    process.env.APP_BILLING_MINIMUM_RESERVATION_CREDITS = "0.10";

    stage = "create current web application";
    app = await createApp({
      dbPath: path.join(tempRoot, "app-db.json"),
      uploadRoot: path.join(tempRoot, "uploads")
    });
    stage = "verify Runtime health through the web interface";
    const health = await auth(request(app).get("/api/runtime/health")).expect(200);
    requireCondition(health.body?.ok === true, "Runtime health is not OK");
    requireCondition(health.body?.ready === true, "Runtime is reachable but not ready");
    requireCondition(health.body?.vllm?.context_contract_aligned === true, "Worker context contract does not match vLLM");
    requireCondition(health.body?.session_controller?.context_contract_aligned === true, "Qwen Router context contract does not match its provider");

    stage = "load Discover catalog";
    const discovery = await auth(request(app).get("/api/marketplace?type=workspace")).expect(200);
    requireCondition(CASES.every((scenario) => discovery.body.items.some((item) => item.title === scenario.team)), "Discover is missing a curated team");

    for (const scenario of CASES) {
      stage = `${scenario.team}: inspect published v4 team`;
      const listing = discovery.body.items.find((item) => item.title === scenario.team);
      requireCondition(listing?.verified === true && listing?.pinned === true, `${scenario.team} is not verified and pinned`);
      requireCondition(listing.agent_count === 6, `${scenario.team} does not publish six roles`);
      const published = await auth(request(app).get(`/api/marketplace/items/${listing.id}`)).expect(200);
      requireCondition(published.body.workspace?.agents?.length === 6, `${scenario.team} detail is incomplete`);
      for (const entry of published.body.workspace.agents) {
        assertCanonicalAgent(entry.agent, `${scenario.team}/${entry.agent.title}`);
      }

      stage = `${scenario.team}: copy and register six Runtime agents`;
      const copied = await auth(request(app).post(`/api/marketplace/items/${listing.id}/copy`))
        .set("Idempotency-Key", `curated-live-${scenario.team.toLowerCase()}-${crypto.randomBytes(12).toString("hex")}`)
        .send({ listing_id: listing.listing_id })
        .expect(201);
      const workspaceId = copied.body.agent_workspace.agent_workspace_id;
      copiedWorkspaceIds.push(workspaceId);
      const workspace = await auth(request(app).get(`/api/agent-workspaces/${workspaceId}`)).expect(200);
      requireCondition(workspace.body.agents?.length === 6, `${scenario.team} copy is incomplete`);
      const teamIds = workspace.body.agents.map((agent) => agent.id);
      copiedAgentIds.push(...teamIds);
      for (const agent of workspace.body.agents) assertCanonicalAgent(agent, `${scenario.team} copy/${agent.title}`);

      stage = `${scenario.team}: create and bind web chat`;
      const session = await auth(request(app).post("/api/chat/sessions"))
        .send({ title: `${scenario.team} live Discover proof` })
        .expect(201);
      await auth(request(app).patch(`/api/chat/sessions/${session.body.session_id}/agent-workspace`))
        .send({ agent_workspace_id: workspaceId })
        .expect(200);

      stage = `${scenario.team}: route naturally through Qwen and execute on GPU`;
      const queued = await auth(request(app).post(`/api/chat/sessions/${session.body.session_id}/messages`))
        .set("Idempotency-Key", `curated-live-run-${scenario.team.toLowerCase()}-${crypto.randomBytes(12).toString("hex")}`)
        .send({ content: scenario.prompt })
        .expect(202);
      const run = await waitForRun(app, queued.body.run_id);
      requireCondition(run.status === "completed", `${scenario.team} run failed: ${JSON.stringify(run.error || run.route_failure_summary || {})}`);
      requireCondition(Number(run.execution_options?.max_tokens) >= 1536, `${scenario.team} used the retired 1,024-token specialist ceiling`);
      const plannedIds = new Set((run.plan?.steps || []).map((step) => step.adapter));
      const titlesById = new Map(workspace.body.agents.map((agent) => [agent.id, agent.title]));
      const missingIds = teamIds.filter((agentId) => !plannedIds.has(agentId));
      if (missingIds.length > 0) {
        console.log(JSON.stringify({
          stage: "route_diagnostic",
          team: scenario.team,
          selected: [...plannedIds].map((agentId) => ({ id: agentId, title: titlesById.get(agentId) || "unknown" })),
          missing: missingIds.map((agentId) => ({ id: agentId, title: titlesById.get(agentId) || "unknown" })),
          orchestrator: run.plan?.routing?.orchestrator || null
        }, null, 2));
      }
      requireCondition(missingIds.length === 0, `${scenario.team} Qwen route dropped a configured teammate`);
      requireCondition(plannedIds.size === teamIds.length, `${scenario.team} route included an agent outside the active team`);
      requireCondition(run.plan?.routing?.orchestrator?.all_primary_agents_visible === true, `${scenario.team} did not expose all six agents to Qwen`);
      requireCondition((run.expert_outputs || []).length === 6, `${scenario.team} did not return six route outputs`);
      const invalidArtifacts = run.expert_outputs.filter((output) => output.artifact_validation?.valid !== true);
      const invalidConsumption = run.expert_outputs.filter((output) => output.consumption_validation?.valid !== true);
      if (invalidArtifacts.length > 0 || invalidConsumption.length > 0 || (run.route_failure_summary || []).length > 0) {
        console.log(JSON.stringify({
          stage: "execution_contract_diagnostic",
          team: scenario.team,
          invalid_artifacts: invalidArtifacts.map((output) => ({
            adapter: output.adapter,
            title: titlesById.get(output.adapter) || "unknown",
            status: output.status,
            failure: output.failure,
            failure_observability: output.failure_observability_admin_only,
            output_contract: output.output_contract,
            expected_outputs: output.outcome_validation?.expected_outputs,
            domain_answer_chars: String(output.domain_answer || "").length,
            model_call_finish_reasons: (output.model_calls_admin_only || []).map((call) => call.finish_reason),
            policy_violations: output.policy_violations,
            source_validation: output.source_validation,
            artifact_validation: output.artifact_validation,
            handoff_artifacts: output.handoff_artifacts,
            handoff_contract_repair: output.handoff_contract_repair,
            ...(process.env.CURATED_LIVE_DEBUG_RAW === "1"
              ? { raw_text_admin_only: String(output.raw_text_admin_only || "").slice(0, 16_000) }
              : {})
          })),
          invalid_consumption: invalidConsumption.map((output) => ({
            adapter: output.adapter,
            title: titlesById.get(output.adapter) || "unknown",
            consumption_validation: output.consumption_validation
          })),
          route_failures: run.route_failure_summary || []
        }, null, 2));
      }
      requireCondition(invalidArtifacts.length === 0, `${scenario.team} produced an invalid handoff artifact`);
      requireCondition(invalidConsumption.length === 0, `${scenario.team} failed an input contract`);
      requireCondition((run.route_failure_summary || []).length === 0, `${scenario.team} reported route failures`);
      requireCondition(String(run.final_answer || "").trim().length > 0, `${scenario.team} returned an empty final answer`);
      const lead = workspace.body.agents.find((agent) => agent.title === scenario.lead);
      const leadOutput = run.expert_outputs.find((output) => output.adapter === lead?.id);
      requireCondition(leadOutput?.handoff_artifacts?.some((artifact) => artifact.name === scenario.output && artifact.verified === true), `${scenario.team} lead did not produce ${scenario.output}`);
      requireCondition(leadOutput?.consumption_validation?.missing_from_upstream?.length === 0, `${scenario.team} lead missed an upstream handoff`);
      requireCondition(run.usage_receipt?.provider_reported === true && run.usage_receipt.total_tokens > 0, `${scenario.team} lacks provider-reported GPU usage`);

      proofs.push({
        team: scenario.team,
        agents_visible_to_qwen: run.plan.routing.orchestrator.active_primary_agent_count,
        selected_agents: plannedIds.size,
        valid_outputs: run.expert_outputs.filter((output) => output.artifact_validation?.valid === true).length,
        maximum_parallel_width: run.parallel?.maxBatchWidth || 0,
        agent_output_token_ceiling: run.execution_options.max_tokens,
        terminal_recovery_used: leadOutput?.terminal_fan_in_recovery?.valid === true,
        total_tokens: run.usage_receipt.total_tokens,
        final_answer_chars: String(run.final_answer).length
      });
      console.log(JSON.stringify({ stage: "team_complete", ...proofs.at(-1) }));
    }

    const billing = (await auth(request(app).get("/api/billing/account")).expect(200)).body.account;
    requireCondition(billing.reserved_micros === 0, "Live Discover runs left credits reserved");
    requireCondition(billing.lifetime_debited_micros > 0, "Live Discover runs did not settle provider usage");
    console.log(JSON.stringify({
      ok: true,
      runtime_url: RUNTIME_URL,
      teams: proofs,
      billing: {
        reserved_credits: billing.reserved_credits,
        lifetime_debited_credits: billing.lifetime_debited_credits
      }
    }, null, 2));
  } catch (error) {
    throw new Error(`${stage}: ${error.message}`, { cause: error });
  } finally {
    if (app?.locals) {
      await app.locals.drainBackgroundTasks({ timeoutMs: 60_000 }).catch(() => undefined);
      cleanupResults = await cleanup(app, copiedWorkspaceIds, copiedAgentIds).catch((error) => [{ cleanup_error: error.message }]);
      await app.locals.drainBackgroundTasks({ timeoutMs: 60_000 }).catch(() => undefined);
      await app.locals.store.close().catch(() => undefined);
    }
    await fs.rm(tempRoot, { recursive: true, force: true });
    for (const [name, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    console.log(JSON.stringify({ cleanup: cleanupResults }));
    requireCondition(
      cleanupResults.filter((item) => item.agent).every((item) => item.purged === true),
      "One or more temporary curated Runtime agents were not purged"
    );
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message }));
  process.exitCode = 1;
});

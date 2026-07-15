#!/usr/bin/env node
/* global console, process, setTimeout */

// Live end-to-end proof for explicit /agent and /workflow commands.
// The script uses a temporary web store, the configured Qwen Runtime, and
// removes every Runtime agent it creates before exiting.

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
const LIVE_TOKEN = `workflow_live_${crypto.randomBytes(24).toString("hex")}`;
const AUTH = { Authorization: `Bearer ${LIVE_TOKEN}` };
const ACTOR = { user_id: "workflow_live_user", workspace_id: "workflow_live_workspace", role: "admin" };
const MANAGED_ENV = [
  "NODE_ENV",
  "WEB_STORE_DRIVER",
  "APP_API_TOKENS_JSON",
  "TCAR_ENGINE_MODE",
  "TCAR_RUNTIME_API_URL",
  "TCAR_RUNTIME_API_KEY",
  "TCAR_RUNTIME_API_KEY_FILE",
  "TCAR_RUNTIME_WORKFLOW_TIMEOUT_MS",
  "TCAR_RUNTIME_CHAT_TIMEOUT_MS",
  "TCAR_RUNTIME_ADMIN_TIMEOUT_MS"
];

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function auth(call) {
  return call.set(AUTH);
}

async function createSession(app) {
  const response = await auth(request(app).post("/api/chat/sessions"))
    .send({ title: "Live slash-command proof" })
    .expect(201);
  return response.body;
}

async function sendMessage(app, sessionId, content, keyLabel) {
  const response = await auth(request(app).post(`/api/chat/sessions/${sessionId}/messages`))
    .set("Idempotency-Key", `${keyLabel}_${crypto.randomBytes(10).toString("hex")}`)
    .send({ content })
    .expect(202);
  return response.body;
}

async function waitForRun(app, runId, { timeoutMs = 20 * 60 * 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await auth(request(app).get(`/api/chat/runs/${runId}`)).expect(200);
    if (["completed", "failed"].includes(response.body.status)) return response.body;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Run ${runId} did not finish within ${timeoutMs}ms.`);
}

async function sessionDetail(app, sessionId) {
  return (await auth(request(app).get(`/api/chat/sessions/${sessionId}`)).expect(200)).body;
}

function workflowForRun(app, detail, runId) {
  const workflowId = app.locals.store.read((data) => (
    (data.workflows || []).find((workflow) => workflow.source_run_id === runId)?.workflow_id
  ));
  return detail.workflows.find((workflow) => workflow.workflow_id === workflowId);
}

async function workflowDecision(app, workflow, decision) {
  return (await auth(request(app).post(`/api/workflows/${workflow.workflow_id}/decision`))
    .send({ decision, revision: workflow.revision })
    .expect(200)).body;
}

function assertSafeGraph(workflow) {
  const nodes = workflow.nodes || [];
  const edges = workflow.edges || [];
  const nodeIds = new Set(nodes.map((node) => node.id));
  requireCondition(nodes.filter((node) => node.type === "trigger").length === 1, `${workflow.title} does not have exactly one trigger`);
  requireCondition(edges.every((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target) && edge.source !== edge.target), `${workflow.title} has an invalid edge`);
  const indegree = new Map(nodes.map((node) => [node.id, 0]));
  const outgoing = new Map(nodes.map((node) => [node.id, []]));
  for (const edge of edges) {
    indegree.set(edge.target, indegree.get(edge.target) + 1);
    outgoing.get(edge.source).push(edge.target);
  }
  const pending = [...indegree].filter(([, degree]) => degree === 0).map(([id]) => id);
  let visited = 0;
  while (pending.length) {
    const current = pending.shift();
    visited += 1;
    for (const target of outgoing.get(current)) {
      indegree.set(target, indegree.get(target) - 1);
      if (indegree.get(target) === 0) pending.push(target);
    }
  }
  requireCondition(visited === nodes.length, `${workflow.title} contains a cycle`);
  for (const node of nodes.filter((item) => item.side_effect === true)) {
    const guarded = edges.some((edge) => (
      edge.target === node.id
      && nodes.find((candidate) => candidate.id === edge.source)?.type === "approval"
    ));
    requireCondition(guarded, `${node.title} exposes an unguarded side effect`);
  }
}

async function cleanupWorkflowAgents(app) {
  if (!app?.locals?.store) return [];
  const agents = app.locals.store.read((data) => (data.agents || [])
    .filter((agent) => agent.workflow_origin && agent.created_by === ACTOR.user_id)
    .map((agent) => ({ id: agent.id, enabled: agent.enabled !== false })));
  const outcomes = [];
  for (const agent of agents) {
    try {
      if (agent.enabled) {
        await auth(request(app).delete(`/api/agents/${encodeURIComponent(agent.id)}`)).expect(200);
      }
      outcomes.push({ agent: agent.id, archived: true });
    } catch (error) {
      outcomes.push({ agent: agent.id, archived: false, error: error.message });
    }
  }
  for (const outcome of outcomes.filter((item) => item.archived)) {
    try {
      await auth(request(app).delete(`/api/agents/${encodeURIComponent(outcome.agent)}/permanent`)).expect(200);
      outcome.purged = true;
    } catch (error) {
      outcome.purged = false;
      outcome.error = error.message;
    }
  }
  return outcomes;
}

async function main() {
  await fs.access(RUNTIME_KEY_FILE);
  const previousEnv = Object.fromEntries(MANAGED_ENV.map((name) => [name, process.env[name]]));
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "virenis-workflow-live-"));
  const dbPath = path.join(tempRoot, "app-db.json");
  let app = null;
  let cleanup = [];
  let stage = "configure live environment";
  try {
    process.env.NODE_ENV = "development";
    process.env.WEB_STORE_DRIVER = "json";
    process.env.APP_API_TOKENS_JSON = JSON.stringify({ [LIVE_TOKEN]: ACTOR });
    process.env.TCAR_ENGINE_MODE = "real";
    process.env.TCAR_RUNTIME_API_URL = RUNTIME_URL;
    delete process.env.TCAR_RUNTIME_API_KEY;
    process.env.TCAR_RUNTIME_API_KEY_FILE = RUNTIME_KEY_FILE;
    process.env.TCAR_RUNTIME_WORKFLOW_TIMEOUT_MS = "1200000";
    process.env.TCAR_RUNTIME_CHAT_TIMEOUT_MS = "1200000";
    process.env.TCAR_RUNTIME_ADMIN_TIMEOUT_MS = "300000";

    stage = "create initial web app";
    app = await createApp({ dbPath, uploadRoot: path.join(tempRoot, "uploads") });
    stage = "create live chat session";
    const session = await createSession(app);

    stage = "compose textile /agent";
    const textileSubmission = await sendMessage(
      app,
      session.session_id,
      "/agent Create exactly a two-agent team for a textile business plan. First a Textile Agent extracts textile-industry constraints. Then a Business Plan Agent uses that handoff to write the plan.",
      "agent_textile"
    );
    const textileRun = await waitForRun(app, textileSubmission.run_id);
    requireCondition(textileRun.status === "completed", `Textile /agent composition failed: ${JSON.stringify(textileRun.error || {})}`);
    let detail = await sessionDetail(app, session.session_id);
    let textile = workflowForRun(app, detail, textileSubmission.run_id);
    requireCondition(textile, "Textile /agent did not persist a workflow draft");
    assertSafeGraph(textile);
    const textileAgents = textile.nodes.filter((node) => node.type === "agent");
    requireCondition(textile.mode === "agent_team" && textile.command === "agent", "/agent command/mode mapping drifted");
    requireCondition(textileAgents.length === 2, `Expected two textile team roles, received ${textileAgents.length}`);
    requireCondition(new Set(textileAgents.map((node) => node.capability)).size === textileAgents.length, "Textile roles reused an identical capability");
    stage = "activate textile /agent";
    textile = await workflowDecision(app, textile, "approve");
    requireCondition(textile.status === "active", `Textile team activation ended in ${textile.status}`);
    const textileAgentIds = textile.activation?.node_agents?.map((item) => item.agent_id).filter(Boolean) || [];
    requireCondition(textileAgentIds.length === 2, "Activated textile team did not expose both agent ids");
    stage = "execute activated textile team";
    const textileExecutionSubmission = await sendMessage(
      app,
      session.session_id,
      `${textileAgentIds.map((agentId) => `@${agentId}`).join(" ")} Prepare a short textile business-plan outline. Pass the textile constraints to the plan writer.`,
      "run_textile_team"
    );
    const textileExecution = await waitForRun(app, textileExecutionSubmission.run_id);
    requireCondition(textileExecution.status === "completed", `Activated textile team execution failed: ${JSON.stringify(textileExecution.error || {})}`);
    const textileExecutionSteps = textileExecution.plan?.steps || [];
    const executedTextileAgentIds = new Set(textileExecutionSteps.map((step) => step.adapter));
    requireCondition(textileAgentIds.every((agentId) => executedTextileAgentIds.has(agentId)), "Qwen did not execute both explicitly requested textile agents");
    const downstreamTextileStep = textileExecutionSteps.find((step) => step.adapter === textileAgentIds[1]);
    requireCondition((downstreamTextileStep?.depends_on || []).length > 0, "Activated textile handoff was not compiled into the execution DAG");
    requireCondition((textileExecution.expert_outputs || []).length >= 2, "Activated textile team did not return both expert outputs");
    requireCondition(String(textileExecution.final_answer || "").trim().length > 0, "Activated textile team returned an empty synthesis");

    stage = "compose repeated math /agent";
    const mathSubmission = await sendMessage(
      app,
      session.session_id,
      "/agent Create one Math Tutor that teaches algebra step by step and verifies calculations.",
      "agent_math"
    );
    const mathRun = await waitForRun(app, mathSubmission.run_id);
    requireCondition(mathRun.status === "completed", `Math /agent composition failed: ${JSON.stringify(mathRun.error || {})}`);
    detail = await sessionDetail(app, session.session_id);
    let math = workflowForRun(app, detail, mathSubmission.run_id);
    requireCondition(math, "Repeated /agent command did not persist a second draft");
    assertSafeGraph(math);
    const mathAgent = math.nodes.find((node) => node.type === "agent");
    requireCondition(mathAgent && /math|algebra/i.test(`${mathAgent.title} ${mathAgent.capability}`), "Math role inherited unrelated attributes");
    requireCondition((mathAgent.tools || []).includes("calculator"), "Math Tutor did not receive the calculator tool");
    requireCondition(!/general business questions/i.test(mathAgent.capability || ""), "Math Tutor inherited the stale Business Analyst capability");

    stage = "persist simulated interrupted activation";
    await app.locals.store.mutate((data) => {
      const stored = data.workflows.find((workflow) => workflow.workflow_id === math.workflow_id);
      stored.approved_at = new Date().toISOString();
      stored.status = "activating";
      stored.activation_claim_id = "activation_from_stopped_live_process";
      stored.activation_claimed_at = new Date().toISOString();
      stored.revision += 1;
      return stored;
    });
    stage = "close initial web app";
    await app.locals.drainBackgroundTasks({ timeoutMs: 30_000 });
    await app.locals.store.close();
    stage = "restart web app and recover activation";
    app = await createApp({ dbPath, uploadRoot: path.join(tempRoot, "uploads") });
    requireCondition(app.locals.workflowStartupRecovery.recovered === 1, "Restart did not recover the interrupted activation");
    stage = "load recovered math workflow";
    math = (await auth(request(app).get(`/api/workflows/${math.workflow_id}`)).expect(200)).body;
    requireCondition(math.status === "activation_failed", `Interrupted Math workflow recovered as ${math.status}`);
    stage = "resume recovered math workflow";
    math = (await auth(request(app).post(`/api/workflows/${math.workflow_id}/resume`)).send({}).expect(200)).body;
    requireCondition(math.status === "active", `Recovered Math workflow resumed as ${math.status}`);

    stage = "compose Gmail /workflow";
    const gmailSubmission = await sendMessage(
      app,
      session.session_id,
      "/workflow Read incoming customer complaint emails and prepare a reply draft for human review. Do not send anything.",
      "workflow_gmail"
    );
    const gmailRun = await waitForRun(app, gmailSubmission.run_id);
    requireCondition(gmailRun.status === "completed", `Gmail /workflow composition failed: ${JSON.stringify(gmailRun.error || {})}`);
    detail = await sessionDetail(app, session.session_id);
    let gmail = workflowForRun(app, detail, gmailSubmission.run_id);
    requireCondition(gmail, "/workflow did not persist a Gmail draft");
    assertSafeGraph(gmail);
    requireCondition(gmail.mode === "workflow" && gmail.command === "workflow", "/workflow command/mode mapping drifted");
    requireCondition(gmail.connection_requirements.some((item) => item.provider_id === "gmail" && item.status === "missing"), "Gmail connection requirement was not detected");
    stage = "approve Gmail workflow and pause for consent";
    gmail = await workflowDecision(app, gmail, "approve");
    requireCondition(gmail.status === "awaiting_connections", `Gmail workflow did not pause for consent: ${gmail.status}`);
    const gmailCreatedBeforeDenial = app.locals.store.read((data) => data.agents.filter((agent) => agent.workflow_origin?.workflow_id === gmail.workflow_id));
    requireCondition(gmailCreatedBeforeDenial.length === 0, "Gmail workflow created agents before connection consent");
    stage = "decline paused Gmail workflow";
    gmail = await workflowDecision(app, gmail, "deny");
    requireCondition(gmail.status === "declined", `Gmail workflow denial ended in ${gmail.status}`);

    stage = "list agents before all-off normal chat";
    const agentList = (await auth(request(app).get(`/api/agents?session_id=${encodeURIComponent(session.session_id)}&limit=500`)).expect(200)).body.agents || [];
    for (const agent of agentList.filter((item) => (
      item.enabled !== false
      && item.mounted !== false
      && item.runtime_only !== true
      && item.runtime_sync_pending !== true
      && item.session_active !== false
    ))) {
      stage = `disable agent ${agent.id} in live session`;
      await auth(request(app).patch(`/api/chat/sessions/${session.session_id}/agents/${encodeURIComponent(agent.id)}`))
        .send({ active: false })
        .expect(200);
    }
    stage = "run normal chat with all agents disabled";
    const normalSubmission = await sendMessage(app, session.session_id, "Hey, how are you?", "normal_after_workflow");
    const normalRun = await waitForRun(app, normalSubmission.run_id);
    requireCondition(normalRun.status === "completed", `Normal chat after workflow denial failed: ${JSON.stringify(normalRun.error || {})}`);
    requireCondition(String(normalRun.final_answer || "").trim().length > 0, "Normal chat returned an empty answer");

    stage = "emit live proof";
    console.log(JSON.stringify({
      ok: true,
      repeated_session: session.session_id,
      agent_team: {
        title: textile.title,
        roles: textileAgents.map((node) => ({ title: node.title, source: node.source, tools: node.tools || [] })),
        status: textile.status,
        executed_agents: textileAgentIds,
        expert_outputs: textileExecution.expert_outputs.length,
        handoff_compiled: (downstreamTextileStep?.depends_on || []).length > 0
      },
      recovered_agent: {
        title: math.title,
        role: mathAgent.title,
        tools: mathAgent.tools || [],
        status: math.status,
        startup_recovered: true
      },
      workflow: {
        title: gmail.title,
        required_connections: gmail.connection_requirements.map((item) => item.provider_id),
        status: gmail.status,
        created_before_consent: gmailCreatedBeforeDenial.length
      },
      normal_chat_with_all_agents_off: {
        status: normalRun.status,
        answer_preview: String(normalRun.final_answer || "").slice(0, 240)
      }
    }, null, 2));
  } catch (error) {
    throw new Error(`${stage}: ${error.message}`, { cause: error });
  } finally {
    cleanup = await cleanupWorkflowAgents(app).catch((error) => [{ cleanup_error: error.message }]);
    if (app?.locals) {
      await app.locals.drainBackgroundTasks({ timeoutMs: 30_000 }).catch(() => undefined);
      await app.locals.store.close().catch(() => undefined);
    }
    await fs.rm(tempRoot, { recursive: true, force: true });
    for (const [name, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    console.log(JSON.stringify({ cleanup }));
    requireCondition(cleanup.every((item) => item.purged === true), "One or more temporary live workflow agents were not purged");
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message }));
  process.exitCode = 1;
});

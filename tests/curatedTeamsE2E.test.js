import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../server/app.js";

const TOKEN = "curated_consumer";
const ACTOR = { user_id: "curated-consumer", workspace_id: "tenant-curated-consumer", role: "user" };
const CASES = [
  {
    team: "Engineering",
    lead: "Engineering Lead Agent",
    prompt: "Create an engineering plan for Project Cedar: add passwordless login to a Node.js and PostgreSQL SaaS with no downtime, no forced logout, and a reversible rollout.",
    followUp: "Revise the engineering plan for Project Cedar to fit two weeks while keeping the earlier no-downtime, no-forced-logout, and reversible-rollout constraints.",
    titles: [
      "Requirements & Constraints Analyst",
      "Systems Architecture Agent",
      "Delivery Planning Agent",
      "Security & Reliability Reviewer",
      "Verification & Rollout Agent",
      "Engineering Lead Agent"
    ],
    artifacts: ["engineering_brief", "architecture_decision_record", "implementation_plan", "risk_register", "verification_strategy", "engineering_recommendation"],
    maxBatchWidth: 2
  },
  {
    team: "Marketing",
    lead: "Marketing Lead Agent",
    prompt: "Create a marketing plan for Moss Bottle, a refillable household cleaner for apartment renters who want less plastic, using email and short-form video with a calm, playful voice.",
    followUp: "Revise the marketing plan for Moss Bottle into a four-week campaign while keeping the earlier audience, channels, and calm playful voice.",
    titles: [
      "Audience & Context Analyst",
      "Evidence & Claims Steward",
      "Positioning Strategy Agent",
      "Campaign Systems Designer",
      "Measurement & Learning Strategist",
      "Marketing Lead Agent"
    ],
    artifacts: ["audience_brief", "claims_ledger", "positioning_platform", "campaign_system", "measurement_framework", "marketing_plan"],
    maxBatchWidth: 2
  },
  {
    team: "Product",
    lead: "Product Lead Agent",
    prompt: "Create a product brief for PantryPair, a shared grocery-list app for roommates, prioritizing offline edits, conflict resolution, and simple onboarding while excluding social feeds.",
    followUp: "Revise the product brief for PantryPair to ship in one month; keep the earlier users, priorities, and no-social-feed constraint, and state what to defer.",
    titles: [
      "User Problem Analyst",
      "Evidence & Assumption Auditor",
      "Product Strategy Agent",
      "Experience & Requirements Designer",
      "Prioritization & Validation Planner",
      "Product Lead Agent"
    ],
    artifacts: ["problem_brief", "assumption_register", "product_strategy", "experience_blueprint", "prioritized_scope", "product_decision_brief"],
    maxBatchWidth: 2
  },
  {
    team: "Brainstorming",
    lead: "Brainstorming Facilitator Agent",
    prompt: "Create a concept shortlist for Project Lantern: help neighborhood libraries attract teenagers after school with low-cost, inclusive ideas and no new construction.",
    followUp: "Turn the concept shortlist for Project Lantern into one six-week pilot while keeping the earlier low-cost, inclusive, and no-new-construction constraints.",
    titles: [
      "Challenge Framing Agent",
      "Divergent Ideas Agent",
      "Perspective & Analogy Agent",
      "Feasibility & Originality Reviewer",
      "Concept Experiment Designer",
      "Brainstorming Facilitator Agent"
    ],
    artifacts: ["challenge_frame", "idea_portfolio", "alternative_lenses", "screened_concepts", "concept_experiments", "concept_shortlist"],
    maxBatchWidth: 2
  }
];

let app;
let tmpDir;
let previousEnvironment;

function auth() {
  return { Authorization: `Bearer ${TOKEN}` };
}

async function waitForRun(runId) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const response = await request(app)
      .get(`/api/chat/runs/${runId}`)
      .set(auth())
      .expect(200);
    if (["completed", "failed"].includes(response.body.status)) return response.body;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Run ${runId} did not finish.`);
}

async function sendMessage(sessionId, content) {
  const queued = await request(app)
    .post(`/api/chat/sessions/${sessionId}/messages`)
    .set(auth())
    .send({ content })
    .expect(202);
  return waitForRun(queued.body.run_id);
}

beforeAll(async () => {
  previousEnvironment = {
    WEB_STORE_DRIVER: process.env.WEB_STORE_DRIVER,
    APP_API_TOKENS_JSON: process.env.APP_API_TOKENS_JSON,
    TCAR_ENGINE_MODE: process.env.TCAR_ENGINE_MODE
  };
  process.env.WEB_STORE_DRIVER = "json";
  process.env.APP_API_TOKENS_JSON = JSON.stringify({ [TOKEN]: ACTOR });
  process.env.TCAR_ENGINE_MODE = "mock";
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "virenis-curated-e2e-"));
  app = await createApp({
    dbPath: path.join(tmpDir, "db.json"),
    uploadRoot: path.join(tmpDir, "uploads")
  });
});

afterAll(async () => {
  await app?.locals?.drainBackgroundTasks?.({ timeoutMs: 5000 });
  await app?.locals?.store?.close?.();
  for (const [key, value] of Object.entries(previousEnvironment || {})) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("curated Discover teams", () => {
  it.each(CASES)("copies and executes the $team team with same-session memory", async (scenario) => {
    const discovery = await request(app)
      .get("/api/marketplace?type=workspace")
      .set(auth())
      .expect(200);
    const listing = discovery.body.items.find((item) => item.title === scenario.team);
    expect(listing).toMatchObject({
      item_type: "workspace",
      agent_count: 6,
      publisher_display_name: "Virenis",
      verified: true,
      pinned: true,
      can_manage: false
    });

    const publishedDetail = await request(app)
      .get(`/api/marketplace/items/${listing.id}`)
      .set(auth())
      .expect(200);
    expect(publishedDetail.body.workspace.agents.map((entry) => entry.agent.title)).toEqual(scenario.titles);
    expect(publishedDetail.body.workspace.agents.every((entry) => (
      entry.agent.policies?.memory?.mode === "conversation"
      && entry.agent.contract_version === "virenis-agent-v4"
      && entry.agent.agent_contract?.schema_version === "virenis-agent-v4"
      && entry.agent.routing?.metadata_trust === "runtime_normalized"
      && entry.agent.memory?.read_scopes?.includes("conversation")
      && entry.agent.memory?.read_scopes?.includes("team")
      && entry.agent.permissions?.side_effects?.includes("none")
      && entry.agent.lifecycle?.state === "ready"
      && entry.agent.lifecycle?.health === "healthy"
      && entry.agent.consumes.includes("shared_memory")
      && entry.agent.policies?.knowledge?.requirements?.length > 0
      && entry.agent.resources === undefined
      && entry.agent.sources === undefined
      && entry.agent.connector_requirements?.length === 0
    ))).toBe(true);

    const copied = await request(app)
      .post(`/api/marketplace/items/${listing.id}/copy`)
      .set(auth())
      .set("Idempotency-Key", `curated-${scenario.team.toLowerCase()}-copy-v1`)
      .send({ listing_id: listing.listing_id })
      .expect(201);
    expect(copied.body.agent_workspace).toMatchObject({
      agent_count: 6,
      setup_status: "ready"
    });
    expect(copied.body.agent_workspace.name).toBe(`${scenario.team} copy`);

    const copiedWorkspaceId = copied.body.agent_workspace.agent_workspace_id;
    const copiedDetail = await request(app)
      .get(`/api/agent-workspaces/${copiedWorkspaceId}`)
      .set(auth())
      .expect(200);
    expect(copiedDetail.body.agents).toHaveLength(6);
    expect(copiedDetail.body.agents.map((agent) => agent.title)).toEqual(scenario.titles);
    expect(copiedDetail.body.agents.every((agent) => (
      agent.workspace_id === ACTOR.workspace_id
      && agent.created_by === ACTOR.user_id
      && agent.visibility === "private"
      && agent.contract_version === "virenis-agent-v4"
      && agent.agent_contract?.schema_version === "virenis-agent-v4"
      && agent.routing?.metadata_trust === "runtime_normalized"
      && agent.memory?.read_scopes?.includes("conversation")
      && agent.memory?.read_scopes?.includes("team")
      && agent.permissions?.side_effects?.includes("none")
      && agent.lifecycle?.state === "ready"
      && agent.lifecycle?.health === "healthy"
      && agent.policies?.memory?.mode === "conversation"
      && agent.consumes.includes("shared_memory")
      && agent.policies?.knowledge?.requirements?.length > 0
      && agent.resources.length === 0
      && agent.sources.length === 0
      && agent.mcp_bindings.length === 0
    ))).toBe(true);
    const copiedIds = new Set(copiedDetail.body.agents.map((agent) => agent.id));
    const sourceIds = new Set(publishedDetail.body.workspace.agents.map((entry) => entry.source_agent_id));
    for (const agent of copiedDetail.body.agents) {
      for (const input of agent.consumes.filter((value) => value.startsWith("agent:"))) {
        const dependencyId = input.split(":")[1];
        expect(copiedIds.has(dependencyId)).toBe(true);
        expect(sourceIds.has(dependencyId)).toBe(false);
      }
      expect(new Set(agent.agent_contract.execution.handoffs.requires_agents)).toEqual(new Set(
        agent.consumes.flatMap((value) => String(value).match(/^agent:([a-z0-9_]+):output$/i)?.[1] || [])
      ));
    }

    const session = await request(app)
      .post("/api/chat/sessions")
      .set(auth())
      .send({ title: `${scenario.team} memory proof` })
      .expect(201);
    await request(app)
      .patch(`/api/chat/sessions/${session.body.session_id}/agent-workspace`)
      .set(auth())
      .send({ agent_workspace_id: copiedWorkspaceId })
      .expect(200);

    const first = await sendMessage(session.body.session_id, scenario.prompt);
    expect(first.status).toBe("completed");
    expect(new Set(first.plan.steps.map((step) => step.adapter))).toEqual(copiedIds);
    expect(first.plan.routing.mode).toBe("simulator");
    expect(first.parallel.maxBatchWidth).toBe(scenario.maxBatchWidth);
    expect(first.expert_outputs).toHaveLength(6);
    expect(first.expert_outputs.every((route) => route.artifact_validation?.valid === true)).toBe(true);
    expect(first.expert_outputs.every((route) => route.used_memory.length === 0)).toBe(true);
    for (const artifact of scenario.artifacts) {
      expect(first.expert_outputs.some((route) => (
        route.handoff_artifacts?.some((entry) => entry.name === artifact && entry.verified === true)
      ))).toBe(true);
    }
    const leadId = copiedDetail.body.agents.find((agent) => agent.title === scenario.lead).id;
    const firstLead = first.expert_outputs.find((route) => route.adapter === leadId);
    expect(firstLead.consumption_validation).toMatchObject({ valid: true });
    expect(firstLead.consumed_artifacts.length).toBeGreaterThanOrEqual(5);
    expect(first.final_answer).toBeTruthy();

    const second = await sendMessage(session.body.session_id, scenario.followUp);
    expect(second.status).toBe("completed");
    expect(new Set(second.plan.steps.map((step) => step.adapter))).toEqual(copiedIds);
    expect(second.expert_outputs).toHaveLength(6);
    expect(second.expert_outputs.every((route) => (
      route.used_memory.some((entry) => entry.tag === "user_request" && entry.source === "user")
    ))).toBe(true);
    expect(second.expert_outputs.every((route) => route.artifact_validation?.valid === true)).toBe(true);
    const secondLead = second.expert_outputs.find((route) => route.adapter === leadId);
    expect(secondLead.consumption_validation).toMatchObject({ valid: true });
    expect(secondLead.consumed_artifacts.length).toBeGreaterThanOrEqual(5);
    expect(second.final_answer).toBeTruthy();

    const conversation = await request(app)
      .get(`/api/chat/sessions/${session.body.session_id}`)
      .set(auth())
      .expect(200);
    expect(conversation.body.agent_workspace_id).toBe(copiedWorkspaceId);
    expect(conversation.body.shared_memory).toEqual(expect.arrayContaining([
      expect.objectContaining({ tag: "user_request", source: "user", content: scenario.prompt }),
      expect.objectContaining({ tag: "user_request", source: "user", content: scenario.followUp })
    ]));
  });
});

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../server/app.js";

const TOKENS = {
  workspace_alice: { user_id: "alice", workspace_id: "tenant_shared", role: "user" },
  workspace_bob: { user_id: "bob", workspace_id: "tenant_shared", role: "user" }
};

let app;
let tmpDir;
let previousEnvironment;
let composer;

function as(user) {
  return `Bearer workspace_${user}`;
}

async function listWorkspaces(user = "alice") {
  return request(app).get("/api/agent-workspaces").set("Authorization", as(user)).expect(200);
}

async function createWorkspace(name, user = "alice") {
  const response = await request(app)
    .post("/api/agent-workspaces")
    .set("Authorization", as(user))
    .send({ name, description: `${name} description` })
    .expect(201);
  return response.body;
}

async function createAgent({ id, workspaceId = null, user = "alice", sourceText = "" }) {
  const response = await request(app)
    .post("/api/agents")
    .set("Authorization", as(user))
    .send({
      id,
      title: id.replaceAll("_", " "),
      capability: `Handles the ${id} specialty with concrete, bounded answers.`,
      boundary: "Stay within the declared specialty.",
      consumes: ["user_request"],
      produces: [`${id}_output`],
      routing_cues: [id.replaceAll("_", " ")],
      ...(workspaceId ? { agent_workspace_id: workspaceId } : {}),
      ...(sourceText ? { source_text: sourceText } : {})
    })
    .expect(201);
  return response.body;
}

async function createSession(agentWorkspaceId, user = "alice") {
  const response = await request(app)
    .post("/api/chat/sessions")
    .set("Authorization", as(user))
    .send({
      title: "Workspace session",
      ...(agentWorkspaceId ? { agent_workspace_id: agentWorkspaceId } : {})
    })
    .expect(201);
  return response.body;
}

async function waitForRun(runId, user = "alice") {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const response = await request(app)
      .get(`/api/chat/runs/${runId}`)
      .set("Authorization", as(user))
      .expect(200);
    if (["completed", "failed"].includes(response.body.status)) return response.body;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Run ${runId} did not finish.`);
}

beforeEach(async () => {
  previousEnvironment = {
    WEB_STORE_DRIVER: process.env.WEB_STORE_DRIVER,
    APP_API_TOKENS_JSON: process.env.APP_API_TOKENS_JSON
  };
  process.env.WEB_STORE_DRIVER = "json";
  process.env.APP_API_TOKENS_JSON = JSON.stringify(TOKENS);
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "virenis-agent-workspaces-"));
  composer = vi.fn(() => ({
    title: "Focused writing team",
    summary: "Create a focused writing team.",
    nodes: [
      { id: "trigger", type: "trigger", title: "Manual request", task: "Start the request." },
      {
        id: "specialist",
        type: "agent",
        title: "Poetry Specialist",
        capability: "Writes a poem that follows the requested theme and form.",
        task: "Write the requested poem.",
        produces: ["poem"]
      },
      {
        id: "reviewer",
        type: "agent",
        title: "Poetry Reviewer",
        capability: "Reviews the completed poem for clarity, imagery, and consistency.",
        task: "Review the completed poem.",
        produces: ["poem_review"]
      }
    ],
    edges: [
      { source: "trigger", target: "specialist", label: "request" },
      { source: "specialist", target: "reviewer", label: "handoff" }
    ]
  }));
  app = await createApp({
    dbPath: path.join(tmpDir, "db.json"),
    uploadRoot: tmpDir,
    workflowComposer: composer
  });
});

afterEach(async () => {
  await app?.locals?.drainBackgroundTasks?.({ timeoutMs: 5000 });
  await app?.locals?.store?.close?.();
  for (const [key, value] of Object.entries(previousEnvironment || {})) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("agent workspaces", () => {
  it("quarantines unscoped legacy agents unless they are explicit global system catalog entries", async () => {
    await app.locals.store.mutate((data) => {
      data.agents.push(
        {
          id: "legacy_unscoped_private_agent",
          title: "Alice legacy private agent",
          visibility: "private",
          created_by: "alice",
          system_managed: false,
          enabled: true
        },
        {
          id: "legacy_unscoped_global_user_agent",
          title: "Malformed global user agent",
          visibility: "global",
          created_by: "alice",
          system_managed: false,
          enabled: true
        },
        {
          id: "legacy_unscoped_private_system_agent",
          title: "Malformed private system agent",
          visibility: "private",
          created_by: "system",
          system_managed: true,
          enabled: true
        }
      );
      return null;
    });

    const bob = await listWorkspaces("bob");
    const bobAgentIds = bob.body.workspaces[0].agent_ids;
    expect(bobAgentIds).toContain("finance_reasoning_lora");
    expect(bobAgentIds).not.toContain("legacy_unscoped_private_agent");
    expect(bobAgentIds).not.toContain("legacy_unscoped_global_user_agent");
    expect(bobAgentIds).not.toContain("legacy_unscoped_private_system_agent");

    const alice = await listWorkspaces("alice");
    const aliceAgentIds = alice.body.workspaces[0].agent_ids;
    expect(aliceAgentIds).not.toContain("legacy_unscoped_private_agent");
    expect(aliceAgentIds).not.toContain("legacy_unscoped_global_user_agent");
    expect(aliceAgentIds).not.toContain("legacy_unscoped_private_system_agent");
  });

  it("cannot add legacy or ambiguous agent identities and prunes injected membership", async () => {
    const workspace = await createWorkspace("Isolation lab");
    await app.locals.store.mutate((data) => {
      data.agents.push(
        {
          id: "legacy_unscoped_membership_agent",
          title: "Legacy unscoped membership agent",
          visibility: "global",
          created_by: "alice",
          system_managed: false,
          enabled: true
        },
        {
          id: "ambiguous_membership_agent",
          title: "First ambiguous membership agent",
          workspace_id: "tenant_shared",
          visibility: "private",
          created_by: "alice",
          enabled: true
        },
        {
          id: "ambiguous_membership_agent",
          title: "Second ambiguous membership agent",
          workspace_id: "tenant_shared",
          visibility: "private",
          created_by: "alice",
          enabled: true
        }
      );
      const stored = data.agentWorkspaces.find((item) => (
        item.agent_workspace_id === workspace.agent_workspace_id
      ));
      stored.agent_ids = ["legacy_unscoped_membership_agent", "ambiguous_membership_agent"];
      return null;
    });

    const detail = await request(app)
      .get(`/api/agent-workspaces/${workspace.agent_workspace_id}`)
      .set("Authorization", as("alice"))
      .expect(200);
    expect(detail.body.agent_ids).toEqual([]);
    expect(detail.body.agents).toEqual([]);

    for (const agentId of ["legacy_unscoped_membership_agent", "ambiguous_membership_agent"]) {
      const rejected = await request(app)
        .patch(`/api/agent-workspaces/${workspace.agent_workspace_id}`)
        .set("Authorization", as("alice"))
        .send({ agent_ids: [agentId] })
        .expect(404);
      expect(rejected.body.error).toBe("agent_workspace_agent_not_found");
    }

    const trustedCatalogMember = await request(app)
      .patch(`/api/agent-workspaces/${workspace.agent_workspace_id}`)
      .set("Authorization", as("alice"))
      .send({ agent_ids: ["finance_reasoning_lora"] })
      .expect(200);
    expect(trustedCatalogMember.body.agent_ids).toEqual(["finance_reasoning_lora"]);
  });

  it("creates an isolated General workspace for every user and protects ownership", async () => {
    const alice = await listWorkspaces("alice");
    const bob = await listWorkspaces("bob");
    expect(alice.body.workspaces).toHaveLength(1);
    expect(bob.body.workspaces).toHaveLength(1);
    expect(alice.body.workspaces[0]).toMatchObject({ name: "General", is_general: true, max_agents: 16 });
    expect(bob.body.workspaces[0].agent_workspace_id).not.toBe(alice.body.workspaces[0].agent_workspace_id);

    await request(app)
      .get(`/api/agent-workspaces/${alice.body.workspaces[0].agent_workspace_id}`)
      .set("Authorization", as("bob"))
      .expect(404);
    await request(app)
      .delete(`/api/agent-workspaces/${alice.body.workspaces[0].agent_workspace_id}`)
      .set("Authorization", as("alice"))
      .expect(409);

    const sharedSession = await request(app)
      .post("/api/chat/sessions")
      .set("Authorization", as("alice"))
      .send({
        title: "Shared conversation",
        visibility: "team",
        agent_workspace_id: alice.body.workspaces[0].agent_workspace_id
      })
      .expect(201);
    const bobView = await request(app)
      .get(`/api/chat/sessions/${sharedSession.body.session_id}`)
      .set("Authorization", as("bob"))
      .expect(200);
    expect(bobView.body.agent_workspace_id).toBeNull();
    expect(bobView.body.agent_workspace).toBeNull();
  });

  it("enforces the 16-agent limit under concurrent creation without leaking reservations", async () => {
    const workspace = await createWorkspace("Capacity lab");
    const results = await Promise.all(Array.from({ length: 17 }, async (_, index) => request(app)
      .post("/api/agents")
      .set("Authorization", as("alice"))
      .send({
        id: `capacity_agent_${String(index).padStart(2, "0")}`,
        title: `Capacity agent ${index}`,
        capability: "Handles a bounded capacity test task.",
        boundary: "Stay within the capacity test.",
        consumes: ["user_request"],
        produces: ["capacity_output"],
        routing_cues: ["capacity test"],
        agent_workspace_id: workspace.agent_workspace_id
      })));
    expect(results.filter((response) => response.status === 201)).toHaveLength(16);
    expect(results.filter((response) => response.status === 409)).toHaveLength(1);
    expect(results.find((response) => response.status === 409).body.error).toBe("agent_workspace_capacity_exceeded");

    const detail = await request(app)
      .get(`/api/agent-workspaces/${workspace.agent_workspace_id}`)
      .set("Authorization", as("alice"))
      .expect(200);
    expect(detail.body.agent_count).toBe(16);
    const stored = app.locals.store.read((data) => data.agentWorkspaces
      .find((item) => item.agent_workspace_id === workspace.agent_workspace_id));
    expect(stored.reservations).toEqual([]);
  });

  it("uses only the selected user team and switches teams without losing the conversation", async () => {
    const first = await createWorkspace("First team");
    const second = await createWorkspace("Second team");
    await createAgent({ id: "first_team_specialist", workspaceId: first.agent_workspace_id });
    await createAgent({ id: "second_team_specialist", workspaceId: second.agent_workspace_id });
    const session = await createSession(first.agent_workspace_id);

    const firstPicker = await request(app)
      .get(`/api/agents?session_id=${session.session_id}`)
      .set("Authorization", as("alice"))
      .expect(200);
    expect(firstPicker.body.agents.find((agent) => agent.id === "first_team_specialist").agent_workspace_member).toBe(true);
    expect(firstPicker.body.agents.find((agent) => agent.id === "second_team_specialist").agent_workspace_member).toBe(false);

    const firstRun = await request(app)
      .post(`/api/chat/sessions/${session.session_id}/messages`)
      .set("Authorization", as("alice"))
      .send({ content: "@first_team_specialist answer this first request." })
      .expect(202);
    const firstResult = await waitForRun(firstRun.body.run_id);
    expect(firstResult.plan.steps.map((step) => step.adapter)).toContain("first_team_specialist");
    expect(firstResult.plan.steps.map((step) => step.adapter)).not.toContain("second_team_specialist");

    await request(app)
      .patch(`/api/chat/sessions/${session.session_id}/agent-workspace`)
      .set("Authorization", as("alice"))
      .send({ agent_workspace_id: second.agent_workspace_id })
      .expect(200);
    const secondPicker = await request(app)
      .get(`/api/agents?session_id=${session.session_id}`)
      .set("Authorization", as("alice"))
      .expect(200);
    expect(secondPicker.body.agents.find((agent) => agent.id === "first_team_specialist").agent_workspace_member).toBe(false);
    expect(secondPicker.body.agents.find((agent) => agent.id === "second_team_specialist").agent_workspace_member).toBe(true);
    const secondRun = await request(app)
      .post(`/api/chat/sessions/${session.session_id}/messages`)
      .set("Authorization", as("alice"))
      .send({ content: "@second_team_specialist answer this second request." })
      .expect(202);
    const secondResult = await waitForRun(secondRun.body.run_id);
    expect(secondResult.plan.steps.map((step) => step.adapter)).toContain("second_team_specialist");
    expect(secondResult.plan.steps.map((step) => step.adapter)).not.toContain("first_team_specialist");

    const sessionDetail = await request(app)
      .get(`/api/chat/sessions/${session.session_id}`)
      .set("Authorization", as("alice"))
      .expect(200);
    expect(sessionDetail.body.agent_workspace_id).toBe(second.agent_workspace_id);
    expect(sessionDetail.body.messages.filter((message) => message.role === "user")).toHaveLength(2);
  });

  it("binds /agent composition and activation to the chosen workspace", async () => {
    const workspace = await createWorkspace("Poetry workflow");
    const session = await createSession(workspace.agent_workspace_id);
    const queued = await request(app)
      .post(`/api/chat/sessions/${session.session_id}/messages`)
      .set("Authorization", as("alice"))
      .send({ content: "/agent Write a short poem and then review it." })
      .expect(202);
    expect((await waitForRun(queued.body.run_id)).status).toBe("completed");
    const draftSession = await request(app)
      .get(`/api/chat/sessions/${session.session_id}`)
      .set("Authorization", as("alice"))
      .expect(200);
    const workflow = draftSession.body.workflows[0];
    expect(workflow.agent_workspace_id).toBe(workspace.agent_workspace_id);

    await request(app)
      .post(`/api/workflows/${workflow.workflow_id}/decision`)
      .set("Authorization", as("alice"))
      .send({ decision: "approve", revision: workflow.revision })
      .expect(200);
    let activated;
    for (let attempt = 0; attempt < 300; attempt += 1) {
      activated = await request(app)
        .get(`/api/workflows/${workflow.workflow_id}`)
        .set("Authorization", as("alice"))
        .expect(200);
      if (["active", "activation_failed"].includes(activated.body.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(activated.body.status).toBe("active");
    const createdIds = activated.body.activation.node_agents.map((item) => item.agent_id);
    const workspaceDetail = await request(app)
      .get(`/api/agent-workspaces/${workspace.agent_workspace_id}`)
      .set("Authorization", as("alice"))
      .expect(200);
    expect(workspaceDetail.body.agent_ids).toEqual(expect.arrayContaining(createdIds));
    expect(workspaceDetail.body.agent_count).toBe(2);

    const finalSession = await request(app)
      .get(`/api/chat/sessions/${session.session_id}`)
      .set("Authorization", as("alice"))
      .expect(200);
    expect(finalSession.body.agent_workspace_id).toBe(workspace.agent_workspace_id);
    expect(finalSession.body.agent_workspace.agent_ids).toEqual(expect.arrayContaining(createdIds));
  });

  it("publishes, rates, and copies a sanitized workspace with remapped handoffs", async () => {
    const workspace = await createWorkspace("Editorial team");
    await createAgent({
      id: "private_draft_writer",
      workspaceId: workspace.agent_workspace_id,
      sourceText: "Secret editorial customer names and internal notes."
    });
    await createAgent({ id: "private_draft_reviewer", workspaceId: workspace.agent_workspace_id });
    await request(app)
      .patch("/api/agents/private_draft_reviewer")
      .set("Authorization", as("alice"))
      .send({ consumes: ["user_request", "agent:private_draft_writer:output"] })
      .expect(200);

    const publication = await request(app)
      .post(`/api/marketplace/items/${workspace.agent_workspace_id}`)
      .set("Authorization", as("alice"))
      .send({ item_type: "workspace", description: "A two-agent editorial writing and review team." })
      .expect(201);
    expect(publication.body).toMatchObject({ item_type: "workspace", agent_count: 2, is_self_published: true });
    await request(app)
      .post(`/api/marketplace/items/${workspace.agent_workspace_id}/ratings`)
      .set("Authorization", as("alice"))
      .send({ score: 5 })
      .expect(403);

    const detail = await request(app)
      .get(`/api/marketplace/items/${workspace.agent_workspace_id}`)
      .set("Authorization", as("bob"))
      .expect(200);
    expect(detail.body.workspace).toMatchObject({
      schema_version: "virenis-marketplace-workspace-v1",
      agents: expect.any(Array),
      edges: [{ from: "private_draft_writer", to: "private_draft_reviewer", label: "handoff" }]
    });
    const publishedWriter = detail.body.workspace.agents.find((entry) => entry.source_agent_id === "private_draft_writer").agent;
    expect(publishedWriter).toMatchObject({
      title: "private draft writer",
      capability: expect.stringContaining("private_draft_writer specialty"),
      boundary: "Stay within the declared specialty.",
      consumes: ["user_request"],
      produces: ["private_draft_writer_output"],
      routing_cues: ["private draft writer"],
      tools: [],
      connector_requirements: []
    });
    expect(JSON.stringify(detail.body)).not.toContain("Secret editorial customer names");
    expect(detail.body.workspace.agents.every((entry) => entry.agent.sources === undefined)).toBe(true);

    const rating = await request(app)
      .post(`/api/marketplace/items/${workspace.agent_workspace_id}/ratings`)
      .set("Authorization", as("bob"))
      .send({ score: 4 })
      .expect(201);
    expect(rating.body).toMatchObject({ rating_average: 4, rating_count: 1 });

    const copied = await request(app)
      .post(`/api/marketplace/items/${workspace.agent_workspace_id}/copy`)
      .set("Authorization", as("bob"))
      .send({})
      .expect(201);
    expect(copied.body.agent_workspace).toMatchObject({ agent_count: 2, max_agents: 16 });
    const copiedDetail = await request(app)
      .get(`/api/agent-workspaces/${copied.body.agent_workspace.agent_workspace_id}`)
      .set("Authorization", as("bob"))
      .expect(200);
    expect(copiedDetail.body.agents).toHaveLength(2);
    const copiedIds = new Set(copiedDetail.body.agents.map((agent) => agent.id));
    const reviewer = copiedDetail.body.agents.find((agent) => (
      (agent.consumes || []).some((input) => input.startsWith("agent:"))
    ));
    const remappedSource = reviewer.consumes.find((input) => input.startsWith("agent:")).split(":")[1];
    expect(copiedIds.has(remappedSource)).toBe(true);
    expect(remappedSource).not.toBe("private_draft_writer");
  });

  it("moves chats to General when a custom workspace is deleted without deleting its agents", async () => {
    const general = (await listWorkspaces("alice")).body.workspaces[0];
    const workspace = await createWorkspace("Temporary team");
    await createAgent({ id: "temporary_team_agent", workspaceId: workspace.agent_workspace_id });
    const session = await createSession(workspace.agent_workspace_id);

    const deletion = await request(app)
      .delete(`/api/agent-workspaces/${workspace.agent_workspace_id}`)
      .set("Authorization", as("alice"))
      .expect(200);
    expect(deletion.body.fallback_agent_workspace_id).toBe(general.agent_workspace_id);
    const sessionDetail = await request(app)
      .get(`/api/chat/sessions/${session.session_id}`)
      .set("Authorization", as("alice"))
      .expect(200);
    expect(sessionDetail.body.agent_workspace_id).toBe(general.agent_workspace_id);
    await request(app)
      .get("/api/agents/temporary_team_agent")
      .set("Authorization", as("alice"))
      .expect(200);
  });
});

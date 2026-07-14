import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { composeRuntimeWorkflowWithFallback, createApp } from "../server/app.js";
import { setRuntimeFetchForTests } from "../server/runtimeClient.js";
import { parseWorkflowCommand } from "../server/workflows.js";

const TOKENS = {
  workflow_alice: { user_id: "alice", workspace_id: "workspace_team", role: "user" },
  workflow_bob: { user_id: "bob", workspace_id: "workspace_team", role: "user" },
  workflow_publisher: { user_id: "publisher", workspace_id: "workspace_market", role: "user" }
};

let app;
let tmpDir;
let dbPath;
let composer;
let previousEnvironment;

beforeEach(async () => {
  previousEnvironment = {
    WEB_STORE_DRIVER: process.env.WEB_STORE_DRIVER,
    APP_API_TOKENS_JSON: process.env.APP_API_TOKENS_JSON
  };
  process.env.WEB_STORE_DRIVER = "json";
  process.env.APP_API_TOKENS_JSON = JSON.stringify(TOKENS);
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "virenis-workflows-"));
  dbPath = path.join(tmpDir, "db.json");
  composer = vi.fn(defaultProposal);
  app = await createApp({ dbPath, uploadRoot: tmpDir, workflowComposer: composer });
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

describe("explicit workflow Auto-Composer", () => {
  it("falls back to the deterministic safe composer for a transient Runtime failure", async () => {
    const previousUrl = process.env.TCAR_RUNTIME_API_URL;
    process.env.TCAR_RUNTIME_API_URL = "http://runtime.test";
    const restoreFetch = setRuntimeFetchForTests(async () => new Response(
      JSON.stringify({ detail: "temporary model outage" }),
      { status: 503, headers: { "Content-Type": "application/json" } }
    ));
    try {
      const proposal = await composeRuntimeWorkflowWithFallback({
        command: "agent",
        mode: "agent_team",
        intent: "Coordinate a xylophone review.",
        candidates: [],
        connections: [],
        conversation_context: [],
        execution_context: {}
      });
      expect(proposal.nodes.some((node) => node.type === "agent")).toBe(true);
      expect(proposal.composer).toMatchObject({ provider: "deterministic_fallback" });
      expect(proposal.safety.at(-1)).toContain("deterministic safe composer");
    } finally {
      restoreFetch();
      if (previousUrl === undefined) delete process.env.TCAR_RUNTIME_API_URL;
      else process.env.TCAR_RUNTIME_API_URL = previousUrl;
    }
  });

  it("activates only for exact /workflow and /agent commands", async () => {
    expect(parseWorkflowCommand("Explain the /workflow command")).toBeNull();
    expect(parseWorkflowCommand("/workflowish do something")).toBeNull();
    expect(parseWorkflowCommand(" /WORKFLOW Build a team ")).toEqual({
      command: "workflow",
      intent: "Build a team",
      mode: "workflow"
    });
    expect(parseWorkflowCommand("/agent Build a team")).toMatchObject({ mode: "agent_team" });

    const session = await createSession();
    const ordinary = await sendMessage(session.session_id, "Explain how our workflow behaves.");
    expect(ordinary.body.kind).toBe("chat");
    const nearMiss = await sendMessage(session.session_id, "/workflowish create a team");
    expect(nearMiss.body.kind).toBe("chat");
    await waitForRun(ordinary.body.run_id);
    await waitForRun(nearMiss.body.run_id);
    expect(composer).not.toHaveBeenCalled();

    const composed = await sendMessage(session.session_id, "/workflow coordinate xylophone quality review");
    expect(composed.body.kind).toBe("workflow_composition");
    await waitForRun(composed.body.run_id);
    expect(composer).toHaveBeenCalledTimes(1);

    const help = await sendMessage(session.session_id, "/agent");
    const helpRun = await waitForRun(help.body.run_id);
    expect(helpRun.final_answer).toContain("/agent");
    expect(composer).toHaveBeenCalledTimes(1);
  });

  it("classifies common hosted applications as resumable managed connections", async () => {
    composer.mockImplementationOnce(async () => ({
      title: "Connected workspace review",
      nodes: [{
        id: "connected_reviewer",
        type: "agent",
        title: "Connected Workspace Reviewer",
        task: "Review the requested connected systems.",
        provider_ids: ["drive", "calendar", "gchat", "people", "github_mcp", "slack_mcp", "notion_mcp", "linear_mcp"]
      }],
      edges: []
    }));
    const session = await createSession();
    const queued = await sendMessage(
      session.session_id,
      "/workflow Search Gmail and Google Drive, check Google Calendar, read Google Chat and Slack, find a GitHub pull request, look up Google Contacts, review Notion, and update a Linear issue."
    );
    await waitForRun(queued.body.run_id);
    const loaded = await getSession(session.session_id);
    const requirements = loaded.body.workflows[0].connection_requirements;
    expect(requirements.map((item) => item.provider_id).sort()).toEqual([
      "github",
      "gmail",
      "google_calendar",
      "google_chat",
      "google_contacts",
      "google_drive",
      "linear",
      "notion",
      "slack"
    ]);
    expect(requirements.every((item) => item.connection_mode === "managed" && item.status === "missing")).toBe(true);
    expect(requirements.find((item) => item.provider_id === "github").permissions).toContain("ask before repository changes");
    expect(requirements.find((item) => item.provider_id === "slack").permissions).toContain("ask before posting or reacting");
  });

  it("prefers a suitable private workspace agent over a requested Marketplace candidate", async () => {
    await app.locals.store.mutate((data) => {
      data.agents.push(
        agentRecord({
          id: "alice_orchid_research",
          title: "Orchid Research Agent",
          capability: "Researches orchid care evidence and prepares orchid briefs.",
          created_by: "alice",
          workspace_id: "workspace_team"
        }),
        agentRecord({
          id: "bob_private_orchid_notes",
          title: "Private Orchid Notes",
          capability: "Contains Bob's private orchid notes SECRET_BOB_NOTES.",
          created_by: "bob",
          workspace_id: "workspace_team"
        }),
        {
          ...agentRecord({
            id: "published_orchid_agent",
            title: "Publisher source",
            capability: "Private source capability SECRET_PUBLISHER_SOURCE.",
            created_by: "publisher",
            workspace_id: "workspace_market"
          }),
          marketplace: {
            published: true,
            listing_id: "listing_orchid123",
            published_by: "publisher",
            publisher_workspace_id: "workspace_market",
            description: "A shared orchid research specialist.",
            snapshot: {
              title: "Marketplace Orchid Research Agent",
              capability: "Researches orchid care and produces orchid briefs.",
              routing_cues: ["orchid research", "orchid brief"],
              consumes: ["user_request"],
              produces: ["orchid_brief"],
              tools: [],
              connector_requirements: []
            }
          }
        }
      );
      return true;
    });
    composer.mockImplementationOnce(async (input) => {
      const serialized = JSON.stringify(input);
      expect(serialized).not.toContain("SECRET_BOB_NOTES");
      expect(serialized).not.toContain("SECRET_PUBLISHER_SOURCE");
      expect(input.candidates.some((item) => item.candidate_id === "workspace:alice_orchid_research")).toBe(true);
      expect(input.candidates.some((item) => item.candidate_id === "marketplace:listing_orchid123")).toBe(true);
      return {
        title: "Orchid research team",
        nodes: [{
          id: "research",
          type: "agent",
          title: "Orchid Research Agent",
          task: "Research orchid care evidence and produce an orchid brief.",
          candidate_id: "marketplace:listing_orchid123",
          produces: ["orchid_brief"]
        }],
        edges: []
      };
    });

    const session = await createSession();
    const queued = await sendMessage(session.session_id, "/agent research orchid care and prepare an orchid brief");
    await waitForRun(queued.body.run_id);
    const loaded = await getSession(session.session_id);
    const selected = loaded.body.workflows[0].nodes.find((node) => node.type === "agent");
    expect(selected).toMatchObject({ source: "workspace", agent_id: "alice_orchid_research" });
  });

  it("never collapses distinct team roles onto one agent candidate", async () => {
    await app.locals.store.mutate((data) => {
      data.agents.push(
        agentRecord({
          id: "alice_amber_writer",
          title: "Amber Reply Writer",
          capability: "Drafts amber customer replies with a clear and empathetic tone.",
          created_by: "alice",
          workspace_id: "workspace_team"
        }),
        {
          ...agentRecord({
            id: "published_amber_reviewer",
            title: "Publisher source",
            capability: "Private publisher details.",
            created_by: "publisher",
            workspace_id: "workspace_market"
          }),
          marketplace: {
            published: true,
            listing_id: "listing_amberreview",
            published_by: "publisher",
            publisher_workspace_id: "workspace_market",
            description: "Reviews amber customer replies for clarity and tone.",
            snapshot: {
              title: "Amber Reply Reviewer",
              capability: "Reviews amber customer replies for clarity, completeness, and tone.",
              routing_cues: ["amber reply review", "amber response quality"],
              consumes: ["draft_reply"],
              produces: ["reviewed_reply"],
              tools: [],
              connector_requirements: []
            }
          }
        }
      );
      return true;
    });
    composer.mockImplementationOnce(async () => ({
      title: "Amber reply team",
      nodes: [
        {
          id: "writer",
          type: "agent",
          title: "Amber Reply Writer",
          task: "Draft an amber customer reply.",
          candidate_id: "workspace:alice_amber_writer"
        },
        {
          id: "reviewer",
          type: "agent",
          title: "Amber Reply Reviewer",
          task: "Review the amber customer reply for clarity and tone.",
          candidate_id: "workspace:alice_amber_writer"
        }
      ],
      edges: [{ source: "writer", target: "reviewer", label: "draft" }]
    }));

    const session = await createSession();
    const queued = await sendMessage(session.session_id, "/agent create an amber reply writer and amber reply reviewer");
    await waitForRun(queued.body.run_id);
    const workflow = (await getSession(session.session_id)).body.workflows[0];
    const agents = workflow.nodes.filter((node) => node.type === "agent");
    expect(agents).toEqual([
      expect.objectContaining({ source: "workspace", agent_id: "alice_amber_writer" }),
      expect.objectContaining({ source: "marketplace", listing_id: "listing_amberreview" })
    ]);
    expect(new Set(agents.map((node) => node.candidate_id)).size).toBe(agents.length);

    // Existing drafts from an older release may still contain a duplicated
    // workspace assignment. Activation must repair it instead of creating a
    // self-handoff between two visual roles backed by the same agent.
    await app.locals.store.mutate((data) => {
      const stored = data.workflows.find((item) => item.workflow_id === workflow.workflow_id);
      const reviewer = stored.nodes.find((node) => node.id === "reviewer");
      Object.assign(reviewer, {
        source: "workspace",
        candidate_id: "workspace:alice_amber_writer",
        agent_id: "alice_amber_writer",
        listing_id: null
      });
      return stored;
    });
    const activated = await request(app)
      .post(`/api/workflows/${workflow.workflow_id}/decision`)
      .set(auth("workflow_alice"))
      .send({ decision: "approve", revision: workflow.revision })
      .expect(200);
    const activationIds = activated.body.activation.node_agents.map((item) => item.agent_id);
    expect(new Set(activationIds).size).toBe(activationIds.length);
    expect(activated.body.activation.edges.every((edge) => edge.from !== edge.to)).toBe(true);
  });

  it("uses a Marketplace snapshot when appropriate and otherwise proposes a new private agent", async () => {
    await app.locals.store.mutate((data) => {
      data.agents.push({
        ...agentRecord({
          id: "published_ceramic_agent",
          title: "Ceramic source",
          capability: "Source-only details are private.",
          created_by: "publisher",
          workspace_id: "workspace_market"
        }),
        marketplace: {
          published: true,
          listing_id: "listing_ceramic42",
          published_by: "publisher",
          publisher_workspace_id: "workspace_market",
          description: "Shared ceramic glazing specialist.",
          snapshot: {
            title: "Ceramic Glazing Agent",
            capability: "Explains ceramic glaze preparation and firing constraints.",
            routing_cues: ["ceramic glaze", "kiln firing"],
            produces: ["glaze_guidance"],
            tools: [],
            connector_requirements: []
          }
        }
      });
      return true;
    });
    composer.mockImplementationOnce(async () => ({
      title: "Ceramic launch team",
      nodes: [
        {
          id: "ceramic",
          type: "agent",
          title: "Ceramic Glazing Agent",
          task: "Prepare ceramic glaze and kiln guidance.",
          candidate_id: "marketplace:listing_ceramic42"
        },
        {
          id: "luthier",
          type: "agent",
          title: "Luthier Resonance Curator",
          task: "Organize rare luthier resonance observations.",
          candidate_id: "workspace:does_not_exist"
        }
      ],
      edges: [{ source: "ceramic", target: "luthier", label: "handoff" }]
    }));
    const session = await createSession();
    const queued = await sendMessage(session.session_id, "/agent prepare ceramic glaze guidance and organize luthier resonance observations");
    await waitForRun(queued.body.run_id);
    const loaded = await getSession(session.session_id);
    const agents = loaded.body.workflows[0].nodes.filter((node) => node.type === "agent");
    expect(agents[0]).toMatchObject({ source: "marketplace", listing_id: "listing_ceramic42", publisher: "publisher" });
    expect(agents[1]).toMatchObject({ source: "generated" });
    expect(agents[1].generated_agent.boundary).toContain("untrusted data");
  });

  it("normalizes unsafe model output into a bounded acyclic graph with an approval before side effects", async () => {
    composer.mockImplementationOnce(async () => ({
      title: "Unsafe proposal",
      nodes: [
        { id: "trigger", type: "trigger", title: "Manual", task: "Start" },
        { id: "helper", type: "agent", title: "Xylophone Helper", task: "Prepare the content", candidate_id: "invented:id" },
        { id: "send", type: "action", title: "Send email", task: "Send the email to the customer", side_effect: false }
      ],
      edges: [
        { source: "trigger", target: "helper" },
        { source: "helper", target: "send" },
        { source: "send", target: "helper" },
        { source: "missing", target: "send" }
      ]
    }));
    const session = await createSession();
    const queued = await sendMessage(session.session_id, "/workflow prepare and send a xylophone service email");
    await waitForRun(queued.body.run_id);
    const loaded = await getSession(session.session_id);
    const workflow = loaded.body.workflows[0];
    expect(workflow.nodes.length).toBeLessThanOrEqual(20);
    expect(workflow.edges.length).toBeLessThanOrEqual(48);
    expect(graphHasCycle(workflow.nodes, workflow.edges)).toBe(false);
    expect(workflow.nodes.find((node) => node.id === "helper").source).toBe("generated");
    const action = workflow.nodes.find((node) => node.id === "send");
    expect(action.side_effect).toBe(true);
    const guardEdge = workflow.edges.find((edge) => edge.target === action.id);
    expect(workflow.nodes.find((node) => node.id === guardEdge.source).type).toBe("approval");
  });

  it("activates generated agents and handoffs once, while ordinary chat continues normally", async () => {
    composer.mockImplementationOnce(async () => ({
      title: "Zephyr review team",
      nodes: [
        { id: "trigger", type: "trigger", title: "Manual request", task: "Start" },
        { id: "collector", type: "agent", title: "Zephyr Quill Collector", task: "Collect zephyr quill observations", produces: ["quill_notes"] },
        { id: "editor", type: "agent", title: "Zephyr Quill Editor", task: "Turn zephyr quill observations into a concise brief", produces: ["quill_brief"] }
      ],
      edges: [
        { source: "trigger", target: "collector" },
        { source: "collector", target: "editor" }
      ]
    }));
    const session = await createSession();
    const queued = await sendMessage(session.session_id, "/agent coordinate a zephyr quill review");
    await waitForRun(queued.body.run_id);
    let loaded = await getSession(session.session_id);
    const draft = loaded.body.workflows[0];
    const activated = await request(app)
      .post(`/api/workflows/${draft.workflow_id}/decision`)
      .set(auth("workflow_alice"))
      .send({ decision: "approve", revision: draft.revision })
      .expect(200);
    expect(activated.body.status).toBe("active");
    expect(activated.body.activation.node_agents).toHaveLength(2);

    const stored = app.locals.store.read();
    const created = stored.agents.filter((agent) => agent.workflow_origin?.workflow_id === draft.workflow_id);
    expect(created).toHaveLength(2);
    expect(created.every((agent) => agent.visibility === "private" && agent.created_by === "alice")).toBe(true);
    const firstId = activated.body.activation.node_agents.find((item) => item.node_id === "collector").agent_id;
    const editorId = activated.body.activation.node_agents.find((item) => item.node_id === "editor").agent_id;
    expect(created.find((agent) => agent.id === editorId).consumes).toContain(`agent:${firstId}:output`);

    const repeated = await request(app)
      .post(`/api/workflows/${draft.workflow_id}/decision`)
      .set(auth("workflow_alice"))
      .send({ decision: "approve", revision: draft.revision })
      .expect(200);
    expect(repeated.body.status).toBe("active");
    expect(app.locals.store.read().agents.filter((agent) => agent.workflow_origin?.workflow_id === draft.workflow_id)).toHaveLength(2);

    await request(app)
      .post(`/api/workflows/${draft.workflow_id}/decision`)
      .set(auth("workflow_alice"))
      .send({ decision: "deny", revision: repeated.body.revision })
      .expect(409);

    loaded = await getSession(session.session_id);
    expect(loaded.body.checkpoints.find((item) => item.workflow_id === draft.workflow_id).status).toBe("resumed");
    const normal = await sendMessage(session.session_id, "Now summarize the idea in one sentence.");
    expect(normal.body.kind).toBe("chat");
  });

  it("persists an approved connection pause across restart and isolates it by user", async () => {
    composer.mockImplementationOnce(async () => ({
      title: "Inbox draft helper",
      nodes: [{
        id: "mail_helper",
        type: "agent",
        title: "Citrine Inbox Helper",
        task: "Read matching Gmail messages and prepare a draft",
        provider_ids: ["gmail"],
        tool_keywords: ["search", "draft"]
      }],
      edges: []
    }));
    const session = await createSession();
    const queued = await sendMessage(session.session_id, "/workflow read incoming Gmail and prepare a citrine reply draft");
    await waitForRun(queued.body.run_id);
    let loaded = await getSession(session.session_id);
    let workflow = loaded.body.workflows[0];
    const approved = await request(app)
      .post(`/api/workflows/${workflow.workflow_id}/decision`)
      .set(auth("workflow_alice"))
      .send({ decision: "approve", revision: workflow.revision })
      .expect(200);
    expect(approved.body.status).toBe("awaiting_connections");
    expect(approved.body.connection_requirements).toEqual([
      expect.objectContaining({ provider_id: "gmail", connection_mode: "managed", status: "missing" })
    ]);
    expect(app.locals.store.read().agents.some((agent) => agent.workflow_origin?.workflow_id === workflow.workflow_id)).toBe(false);

    await app.locals.drainBackgroundTasks({ timeoutMs: 5000 });
    await app.locals.store.close();
    app = await createApp({ dbPath, uploadRoot: tmpDir, workflowComposer: composer });

    const persisted = await request(app)
      .get(`/api/workflows/${workflow.workflow_id}`)
      .set(auth("workflow_alice"))
      .expect(200);
    expect(persisted.body.status).toBe("awaiting_connections");
    loaded = await getSession(session.session_id);
    expect(loaded.body.checkpoints.find((item) => item.workflow_id === workflow.workflow_id).status).toBe("awaiting_connection");

    await request(app).get(`/api/workflows/${workflow.workflow_id}`).set(auth("workflow_bob")).expect(404);
    await request(app)
      .post(`/api/workflows/${workflow.workflow_id}/decision`)
      .set(auth("workflow_bob"))
      .send({ decision: "deny", revision: persisted.body.revision })
      .expect(404);

    const normal = await sendMessage(session.session_id, "Continue with a normal conversation.");
    expect(normal.body.kind).toBe("chat");
    workflow = (await request(app)
      .post(`/api/workflows/${workflow.workflow_id}/decision`)
      .set(auth("workflow_alice"))
      .send({ decision: "deny", revision: persisted.body.revision })
      .expect(200)).body;
    expect(workflow.status).toBe("declined");
  });

  it("resumes an approved custom connection into least-privilege agent bindings", async () => {
    composer.mockImplementationOnce(async () => ({
      title: "Inventory lookup team",
      nodes: [{
        id: "inventory",
        type: "agent",
        title: "Umber Inventory Reader",
        task: "Read Shopify inventory for a requested product",
        provider_ids: ["shopify"],
        tool_keywords: ["inventory", "stock", "product"]
      }],
      edges: []
    }));
    const session = await createSession();
    const queued = await sendMessage(session.session_id, "/agent look up Shopify inventory with an umber inventory reader");
    await waitForRun(queued.body.run_id);
    let workflow = (await getSession(session.session_id)).body.workflows[0];
    workflow = (await request(app)
      .post(`/api/workflows/${workflow.workflow_id}/decision`)
      .set(auth("workflow_alice"))
      .send({ decision: "approve", revision: workflow.revision })
      .expect(200)).body;
    expect(workflow.status).toBe("awaiting_connections");

    await app.locals.store.mutate((data) => {
      data.mcpConnections.push({
        connection_id: "mcpconn_shopifyproof",
        name: "Shopify proof",
        template_id: "shopify",
        provider_id: "shopify",
        connection_mode: "custom",
        workspace_id: "workspace_team",
        visibility: "private",
        created_by: "alice",
        status: "ready",
        tools: [{
          name: "get_inventory",
          title: "Get inventory",
          description: "Read product inventory and stock availability.",
          risk: "read",
          requires_approval: false,
          input_schema: { type: "object", properties: { product: { type: "string" } }, required: ["product"] },
          schema_digest: "a".repeat(64)
        }]
      });
      return true;
    });
    const resumed = await request(app)
      .post(`/api/workflows/${workflow.workflow_id}/resume`)
      .set(auth("workflow_alice"))
      .send({})
      .expect(200);
    expect(resumed.body.status).toBe("active");
    expect(resumed.body.connection_requirements[0]).toMatchObject({
      connection_id: "mcpconn_shopifyproof",
      status: "connected"
    });
    const agentId = resumed.body.activation.node_agents[0].agent_id;
    const storedAgent = app.locals.store.read().agents.find((agent) => agent.id === agentId);
    expect(storedAgent.mcp_bindings[0]).toMatchObject({
      connection_id: "mcpconn_shopifyproof",
      tools: [expect.objectContaining({ name: "get_inventory" })]
    });
    expect(storedAgent.tools[0]).toMatch(/^mcp_/);
  });
});

async function createSession() {
  return (await request(app)
    .post("/api/chat/sessions")
    .set(auth("workflow_alice"))
    .send({ title: "Workflow test" })
    .expect(201)).body;
}

function sendMessage(sessionId, content) {
  return request(app)
    .post(`/api/chat/sessions/${sessionId}/messages`)
    .set(auth("workflow_alice"))
    .send({ content })
    .expect(202);
}

function getSession(sessionId) {
  return request(app)
    .get(`/api/chat/sessions/${sessionId}`)
    .set(auth("workflow_alice"))
    .expect(200);
}

async function waitForRun(runId) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const response = await request(app)
      .get(`/api/chat/runs/${runId}`)
      .set(auth("workflow_alice"))
      .expect(200);
    if (["completed", "failed"].includes(response.body.status)) return response.body;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error(`Run ${runId} did not finish.`);
}

function auth(token) {
  return { Authorization: `Bearer ${token}` };
}

function defaultProposal() {
  return {
    title: "Xylophone quality team",
    nodes: [{
      id: "xylophone",
      type: "agent",
      title: "Xylophone Quality Curator",
      task: "Coordinate xylophone quality observations.",
      candidate_id: null,
      produces: ["xylophone_notes"]
    }],
    edges: []
  };
}

function agentRecord({ id, title, capability, created_by, workspace_id }) {
  return {
    id,
    item_type: "agent",
    title,
    capability,
    boundary: "Use only the declared task.",
    consumes: ["user_request"],
    produces: ["domain_output"],
    routing_cues: [title],
    tools: [],
    resources: [],
    enabled: true,
    mounted: true,
    ready: true,
    visibility: "private",
    created_by,
    workspace_id
  };
}

function graphHasCycle(nodes, edges) {
  const indegree = new Map(nodes.map((node) => [node.id, 0]));
  const outgoing = new Map(nodes.map((node) => [node.id, []]));
  for (const edge of edges) {
    if (!indegree.has(edge.source) || !indegree.has(edge.target)) continue;
    indegree.set(edge.target, indegree.get(edge.target) + 1);
    outgoing.get(edge.source).push(edge.target);
  }
  const queue = [...indegree].filter(([, degree]) => degree === 0).map(([id]) => id);
  let visited = 0;
  while (queue.length) {
    const id = queue.shift();
    visited += 1;
    for (const target of outgoing.get(id)) {
      indegree.set(target, indegree.get(target) - 1);
      if (indegree.get(target) === 0) queue.push(target);
    }
  }
  return visited !== nodes.length;
}

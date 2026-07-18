import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { composeRuntimeWorkflowWithFallback, createApp } from "../server/app.js";
import { setRuntimeFetchForTests } from "../server/runtimeClient.js";
import {
  markWorkflowConnectionOutcome,
  parseWorkflowCommand,
  refreshConnectionRequirements
} from "../server/workflows.js";

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
      const tableProposal = await composeRuntimeWorkflowWithFallback({
        command: "agent",
        mode: "agent_team",
        intent: "Analyze supplied inventory from a CSV table.",
        candidates: [],
        connections: [],
        conversation_context: [],
        execution_context: {}
      });
      expect(tableProposal.nodes.find((node) => node.id === "inventory").tools).toEqual([
        "data_table",
        "calculator"
      ]);
      expect(tableProposal.nodes.find((node) => node.id === "analysis").tools).toEqual([
        "data_table",
        "calculator"
      ]);
      const documentProposal = await composeRuntimeWorkflowWithFallback({
        command: "workflow",
        mode: "workflow",
        intent: "Compare the supplied PDF documents.",
        candidates: [],
        connections: [],
        conversation_context: [],
        execution_context: {}
      });
      expect(documentProposal.nodes.find((node) => node.id === "analysis").tools).toEqual([
        "document_search",
        "document_read"
      ]);
      const generalReportProposal = await composeRuntimeWorkflowWithFallback({
        command: "agent",
        mode: "agent_team",
        intent: "Write a short general-knowledge report.",
        candidates: [],
        connections: [],
        conversation_context: [],
        execution_context: {}
      });
      expect(generalReportProposal.nodes.find((node) => node.id === "analysis").tools).toEqual([]);
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

  it("handles command whitespace and near-misses without accidental activation", () => {
    expect(parseWorkflowCommand("\n\t/AGENT\tBuild a two-role team\n")).toEqual({
      command: "agent",
      intent: "Build a two-role team",
      mode: "agent_team"
    });
    expect(parseWorkflowCommand("/workflow\nWatch an inbox\nand prepare a draft")).toEqual({
      command: "workflow",
      intent: "Watch an inbox\nand prepare a draft",
      mode: "workflow"
    });
    for (const value of ["//workflow build", "/workflow/build", "/agentic build", "prefix /agent build", "`/agent build`"]) {
      expect(parseWorkflowCommand(value)).toBeNull();
    }
  });

  it("activates an approved draft in the team selected after composition", async () => {
    const session = await createSession();
    const queued = await sendMessage(session.session_id, "/agent coordinate a xylophone quality review");
    await waitForRun(queued.body.run_id);
    const workflow = (await getSession(session.session_id)).body.workflows[0];
    expect(workflow.nodes.find((node) => node.type === "agent").new_specialist_required).toBe(true);

    const targetTeam = (await request(app)
      .post("/api/agent-workspaces")
      .set(auth("workflow_alice"))
      .send({ name: "Xylophone launch team" })
      .expect(201)).body;
    await request(app)
      .patch(`/api/chat/sessions/${session.session_id}/agent-workspace`)
      .set(auth("workflow_alice"))
      .send({ agent_workspace_id: targetTeam.agent_workspace_id })
      .expect(200);

    const approved = (await request(app)
      .post(`/api/workflows/${workflow.workflow_id}/decision`)
      .set(auth("workflow_alice"))
      .send({ decision: "approve", revision: workflow.revision })
      .expect(200)).body;
    expect(approved.agent_workspace_id).toBe(targetTeam.agent_workspace_id);
    const storedTarget = app.locals.store.read((data) => data.agentWorkspaces.find((item) => (
      item.agent_workspace_id === targetTeam.agent_workspace_id
    )));
    expect(storedTarget.agent_ids).toContain(approved.activation.node_agents[0].agent_id);
  });

  it("deduplicates retried slash-command submissions and rejects key reuse for different content", async () => {
    const session = await createSession();
    const key = "workflow-submit-proof-0001";
    const first = await request(app)
      .post(`/api/chat/sessions/${session.session_id}/messages`)
      .set(auth("workflow_alice"))
      .set("Idempotency-Key", key)
      .send({ content: "/agent coordinate a xylophone quality review" })
      .expect(202);
    const repeated = await request(app)
      .post(`/api/chat/sessions/${session.session_id}/messages`)
      .set(auth("workflow_alice"))
      .set("Idempotency-Key", key)
      .send({ content: "/agent coordinate a xylophone quality review" })
      .expect(202);
    expect(repeated.body).toMatchObject({
      message_id: first.body.message_id,
      run_id: first.body.run_id,
      kind: "workflow_composition",
      duplicate: true
    });
    await waitForRun(first.body.run_id);
    expect(composer).toHaveBeenCalledTimes(1);
    const stored = app.locals.store.read();
    expect(stored.runs.filter((run) => run.submission_key_digest)).toHaveLength(1);
    expect(stored.workflows).toHaveLength(1);

    await request(app)
      .post(`/api/chat/sessions/${session.session_id}/messages`)
      .set(auth("workflow_alice"))
      .set("Idempotency-Key", key)
      .send({ content: "/workflow a different request" })
      .expect(409);
  });

  it("offers only same-session chat documents as source-agent candidates", async () => {
    const session = await createSession();
    await app.locals.store.mutate((data) => {
      data.agents.push(
        {
          ...agentRecord({
            id: "current_chat_report",
            title: "Current chat report source",
            capability: "Retrieves cited evidence from the attached aurora report.",
            created_by: "alice",
            workspace_id: "workspace_team"
          }),
          scope: "chat",
          session_id: session.session_id,
          document: { title: "Aurora report" },
          retrieval: { type: "document_markdown", index_path: "aurora/index.jsonl" },
          tools: ["document_search", "document_read"]
        },
        {
          ...agentRecord({
            id: "other_chat_report",
            title: "Other chat private report",
            capability: "Contains another conversation's private report.",
            created_by: "alice",
            workspace_id: "workspace_team"
          }),
          scope: "chat",
          session_id: "session_other",
          document: { title: "Other report" }
        }
      );
      return true;
    });
    composer.mockImplementationOnce(async (input) => {
      expect(input.candidates).toEqual(expect.arrayContaining([
        expect.objectContaining({
          candidate_id: "workspace:current_chat_report",
          origin: "chat_document"
        })
      ]));
      expect(input.candidates.some((candidate) => candidate.agent_id === "other_chat_report")).toBe(false);
      return {
        title: "Aurora report team",
        nodes: [{
          id: "source",
          type: "agent",
          title: "Current chat report source",
          task: "Retrieve cited evidence from the attached aurora report.",
          candidate_id: "workspace:current_chat_report",
          produces: ["retrieved_context"]
        }],
        edges: []
      };
    });
    const queued = await sendMessage(session.session_id, "/agent analyze the attached aurora report");
    await waitForRun(queued.body.run_id);
    const workflow = (await getSession(session.session_id)).body.workflows[0];
    expect(workflow.nodes.find((node) => node.type === "agent")).toMatchObject({
      source: "workspace",
      agent_id: "current_chat_report"
    });
  });

  it("excludes session-disabled and not-ready agents from automatic selection", async () => {
    const session = await createSession();
    await app.locals.store.mutate((data) => {
      data.agents.push(
        agentRecord({
          id: "active_onyx_editor",
          title: "Onyx Release Editor",
          capability: "Edits onyx release notes for clarity.",
          created_by: "alice",
          workspace_id: "workspace_team"
        }),
        {
          ...agentRecord({
            id: "inactive_onyx_editor",
            title: "Onyx Release Editor Disabled Here",
            capability: "Edits onyx release notes for clarity.",
            created_by: "alice",
            workspace_id: "workspace_team"
          })
        },
        {
          ...agentRecord({
            id: "unready_onyx_editor",
            title: "Unready Onyx Editor",
            capability: "Edits onyx release notes for clarity.",
            created_by: "alice",
            workspace_id: "workspace_team"
          }),
          ready: false
        },
        {
          ...agentRecord({
            id: "unmounted_onyx_editor",
            title: "Unmounted Onyx Editor",
            capability: "Edits onyx release notes for clarity.",
            created_by: "alice",
            workspace_id: "workspace_team"
          }),
          mounted: false
        },
        {
          ...agentRecord({
            id: "pending_onyx_editor",
            title: "Pending Onyx Editor",
            capability: "Edits onyx release notes for clarity.",
            created_by: "alice",
            workspace_id: "workspace_team"
          }),
          runtime_sync_pending: true
        }
      );
      return true;
    });
    await request(app)
      .patch(`/api/chat/sessions/${session.session_id}/agents/inactive_onyx_editor`)
      .set(auth("workflow_alice"))
      .send({ active: false })
      .expect(200);
    composer.mockImplementationOnce(async (input) => {
      const ids = input.candidates.map((candidate) => candidate.agent_id);
      expect(ids).toContain("active_onyx_editor");
      for (const unavailableId of [
        "inactive_onyx_editor",
        "unready_onyx_editor",
        "unmounted_onyx_editor",
        "pending_onyx_editor"
      ]) expect(ids).not.toContain(unavailableId);
      return {
        title: "Onyx editing team",
        nodes: [{
          id: "editor",
          type: "agent",
          title: "Onyx Release Editor",
          task: "Edit the onyx release notes for clarity.",
          candidate_id: "workspace:active_onyx_editor"
        }],
        edges: []
      };
    });
    const queued = await sendMessage(session.session_id, "/agent edit the onyx release notes for clarity");
    await waitForRun(queued.body.run_id);
    const workflow = (await getSession(session.session_id)).body.workflows[0];
    expect(workflow.nodes.find((node) => node.type === "agent")).toMatchObject({
      source: "workspace",
      agent_id: "active_onyx_editor"
    });
  });

  it("bounds and relevance-ranks large agent, Marketplace, connection, and tool catalogs", async () => {
    const session = await createSession();
    await app.locals.store.mutate((data) => {
      for (let index = 0; index < 48; index += 1) {
        data.agents.push(agentRecord({
          id: `bulk_workspace_${index}`,
          title: index === 47 ? "Ultraviolet Zephyr Specialist" : `Generic Workspace ${index}`,
          capability: index === 47
            ? "Handles the ultraviolet zephyr launch proof."
            : `Handles generic catalog task ${index}.`,
          created_by: "alice",
          workspace_id: "workspace_team"
        }));
      }
      for (let index = 0; index < 20; index += 1) {
        data.agents.push({
          ...agentRecord({
            id: `bulk_marketplace_source_${index}`,
            title: `Private Marketplace Source ${index}`,
            capability: "Publisher-private source text.",
            created_by: "publisher",
            workspace_id: "workspace_market"
          }),
          marketplace: {
            published: true,
            listing_id: `listing_bulk${String(index).padStart(3, "0")}`,
            published_by: "publisher",
            publisher_workspace_id: "workspace_market",
            description: "Published catalog role.",
            snapshot: {
              title: index === 19 ? "Ultraviolet Zephyr Marketplace Reviewer" : `Generic Marketplace ${index}`,
              capability: index === 19
                ? "Reviews ultraviolet zephyr launch work."
                : `Reviews generic Marketplace work ${index}.`,
              routing_cues: index === 19 ? ["ultraviolet zephyr"] : [`generic ${index}`],
              consumes: ["user_request"],
              produces: ["review"],
              tools: [],
              connector_requirements: []
            }
          }
        });
      }
      for (let index = 0; index < 40; index += 1) {
        data.mcpConnections.push({
          connection_id: `mcpconn_bulk_${String(index).padStart(3, "0")}`,
          name: index === 39 ? "Ultraviolet Zephyr Archive" : `Generic Connection ${index}`,
          template_id: "custom",
          provider_id: index === 39 ? "ultraviolet_archive" : `generic_${index}`,
          connection_mode: "custom",
          workspace_id: "workspace_team",
          visibility: "private",
          created_by: "alice",
          status: "ready",
          tools: Array.from({ length: 40 }, (_, toolIndex) => ({
            name: index === 39 && toolIndex === 39 ? "search_ultraviolet_zephyr" : `tool_${index}_${toolIndex}`,
            title: index === 39 && toolIndex === 39 ? "Search ultraviolet zephyr records" : `Generic tool ${toolIndex}`,
            description: "Read an approved record.",
            risk: "read"
          }))
        });
      }
      return true;
    });
    composer.mockImplementationOnce(async (input) => {
      expect(input.candidates.length).toBeLessThanOrEqual(24);
      expect(input.candidates.filter((candidate) => candidate.source === "workspace").length).toBeLessThanOrEqual(16);
      expect(input.candidates.filter((candidate) => candidate.source === "marketplace").length).toBeLessThanOrEqual(8);
      expect(input.candidates).toEqual(expect.arrayContaining([
        expect.objectContaining({ candidate_id: "workspace:bulk_workspace_47" }),
        expect.objectContaining({ candidate_id: "marketplace:listing_bulk019" })
      ]));
      expect(input.connections.length).toBeLessThanOrEqual(24);
      expect(input.connections.every((connection) => connection.tools.length <= 12)).toBe(true);
      expect(input.connections[0]).toEqual(expect.objectContaining({
        connection_id: "mcpconn_bulk_039",
        tools: expect.arrayContaining([
          expect.objectContaining({ name: "search_ultraviolet_zephyr" })
        ])
      }));
      expect(JSON.stringify(input).length).toBeLessThan(150_000);
      return defaultProposal();
    });
    const queued = await sendMessage(session.session_id, "/agent coordinate the ultraviolet zephyr launch proof");
    expect((await waitForRun(queued.body.run_id)).status).toBe("completed");
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

  it("does not misclassify explicit chat-service messages as Gmail", async () => {
    composer.mockImplementationOnce(async () => ({
      title: "Chat message review",
      nodes: [{
        id: "chat_reader",
        type: "agent",
        title: "Chat Message Reader",
        task: "Read support messages in Slack and Google Chat.",
        provider_ids: ["slack", "google_chat"]
      }],
      edges: []
    }));
    const session = await createSession();
    const queued = await sendMessage(session.session_id, "/workflow Read support messages in Slack and Google Chat");
    await waitForRun(queued.body.run_id);
    const requirements = (await getSession(session.session_id)).body.workflows[0].connection_requirements;
    expect(requirements.map((item) => item.provider_id).sort()).toEqual(["google_chat", "slack"]);
  });

  it("matches an explicitly named custom provider without treating it as a managed-provider alias", async () => {
    await app.locals.store.mutate((data) => {
      data.mcpConnections.push({
        connection_id: "mcpconn_salesforce_production",
        name: "Salesforce production",
        template_id: "custom",
        provider_id: "custom",
        connection_mode: "custom",
        workspace_id: "workspace_team",
        visibility: "private",
        created_by: "alice",
        status: "ready",
        tools: [{
          name: "search_customer_cases",
          title: "Search customer cases",
          description: "Read matching customer support cases.",
          risk: "read"
        }]
      });
      return true;
    });
    composer.mockImplementationOnce(async (input) => {
      expect(input.connections).toEqual([
        expect.objectContaining({
          connection_id: "mcpconn_salesforce_production",
          name: "Salesforce production",
          provider_id: "salesforce_production",
          template_id: "custom"
        })
      ]);
      return {
        title: "Salesforce case review",
        nodes: [{
          id: "case_reader",
          type: "agent",
          title: "Salesforce Case Reader",
          task: "Read relevant customer cases from Salesforce.",
          capability: "Finds and summarizes customer support cases.",
          provider_ids: ["salesforce_production"],
          tool_keywords: ["customer", "case", "search"]
        }],
        edges: []
      };
    });
    const session = await createSession();
    const queued = await sendMessage(session.session_id, "/workflow Review customer cases in Salesforce");
    await waitForRun(queued.body.run_id);
    const workflow = (await getSession(session.session_id)).body.workflows[0];
    expect(workflow.connection_requirements).toEqual([
      expect.objectContaining({
        provider_id: "salesforce_production",
        connection_mode: "custom",
        connection_id: "mcpconn_salesforce_production",
        status: "connected"
      })
    ]);
  });

  it("does not demand Gmail or Shopify for offline email drafting and supplied inventory data", async () => {
    composer
      .mockImplementationOnce(async () => ({
        title: "Offline email writer",
        nodes: [{
          id: "writer",
          type: "agent",
          title: "Email Writer",
          task: "Draft a friendly email from the text supplied by the user.",
          capability: "Drafts concise email copy from user-provided text.",
          provider_ids: ["email", "slack"]
        }],
        edges: []
      }))
      .mockImplementationOnce(async () => ({
        title: "Inventory CSV analyst",
        nodes: [{
          id: "analyst",
          type: "agent",
          title: "Inventory CSV Analyst",
          task: "Analyze inventory rows from a supplied CSV without accessing a store.",
          capability: "Analyzes supplied inventory tables.",
          tools: ["data_table"],
          provider_ids: ["shopify"]
        }],
        edges: []
      }));
    const session = await createSession();
    const email = await sendMessage(session.session_id, "/agent draft a friendly email from this supplied text");
    await waitForRun(email.body.run_id);
    const inventory = await sendMessage(session.session_id, "/agent analyze inventory from a supplied CSV");
    await waitForRun(inventory.body.run_id);
    const workflows = (await getSession(session.session_id)).body.workflows;
    const emailWorkflow = workflows.find((workflow) => workflow.title === "Offline email writer");
    const inventoryWorkflow = workflows.find((workflow) => workflow.title === "Inventory CSV analyst");
    expect(emailWorkflow.connection_requirements).toEqual([]);
    expect(emailWorkflow.nodes.find((node) => node.type === "agent").provider_ids).toEqual([]);
    expect(emailWorkflow.permissions).toContain("Use only user-provided message content; no mailbox access or sending is requested.");
    expect(inventoryWorkflow.connection_requirements).toEqual([]);
    expect(inventoryWorkflow.nodes.find((node) => node.type === "agent").provider_ids).toEqual([]);
    expect(inventoryWorkflow.permissions).toContain("Analyze only supplied inventory data; no store connection or modification is requested.");
  });

  it("does not infer Calendar or GitHub from offline planning and supplied-code wording", async () => {
    composer.mockImplementationOnce(async () => ({
      title: "Offline planning review",
      nodes: [{
        id: "reviewer",
        type: "agent",
        title: "Planning and Code Reviewer",
        task: "Create a meeting schedule and perform a code review using supplied text.",
        capability: "Reviews user-provided planning and code material.",
        provider_ids: ["google_calendar", "github"]
      }],
      edges: []
    }));
    const session = await createSession();
    const queued = await sendMessage(
      session.session_id,
      "/agent Create a meeting schedule and perform a code review using supplied text"
    );
    await waitForRun(queued.body.run_id);
    const workflow = (await getSession(session.session_id)).body.workflows[0];
    expect(workflow.connection_requirements).toEqual([]);
    expect(workflow.nodes.find((node) => node.type === "agent").provider_ids).toEqual([]);
  });

  it("keeps attached-file research closed-world instead of adding public web search", async () => {
    composer.mockImplementationOnce(async () => ({
      title: "Attached PDF review",
      nodes: [{
        id: "researcher",
        type: "agent",
        title: "Document Researcher",
        task: "Research the attached PDF and summarize its evidence.",
        capability: "Reviews only the attached PDF."
      }],
      edges: []
    }));
    const session = await createSession();
    const queued = await sendMessage(session.session_id, "/agent Research the attached PDF and summarize its evidence");
    await waitForRun(queued.body.run_id);
    const node = (await getSession(session.session_id)).body.workflows[0].nodes
      .find((item) => item.type === "agent");
    expect(node.tools).toEqual(expect.arrayContaining(["document_search", "document_read"]));
    expect(node.tools).not.toContain("web_search");
  });

  it("detects mailbox access when descriptive words separate retrieval verbs from email", async () => {
    composer.mockImplementation(async () => ({
      title: "Complaint inbox triage",
      nodes: [{
        id: "support",
        type: "agent",
        title: "Customer Support Agent",
        task: "Read and triage incoming customer complaint emails, then prepare drafts.",
        capability: "Triages customer complaints and prepares response drafts."
      }],
      edges: []
    }));
    const session = await createSession();
    const queued = await sendMessage(
      session.session_id,
      "/workflow Read incoming customer complaint emails and prepare reply drafts for review"
    );
    await waitForRun(queued.body.run_id);
    const workflow = (await getSession(session.session_id)).body.workflows[0];
    expect(workflow.connection_requirements).toEqual([
      expect.objectContaining({ provider_id: "gmail", status: "missing" })
    ]);
    expect(workflow.permissions).toContain("Read relevant email and create drafts; do not send automatically.");
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
    // Marketplace nodes expose only a public publisher identity. This legacy
    // fixture has no public publisher id, so the private owner id must not
    // escape through workflow projections.
    expect(agents[0]).toMatchObject({ source: "marketplace", listing_id: "listing_ceramic42", publisher: null });
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

  it("enforces one manual root, connects isolated nodes, and guards side effects mislabeled as agents", async () => {
    composer.mockImplementationOnce(async () => ({
      title: "Adversarial agent team",
      nodes: [
        { id: "late_trigger", type: "trigger", title: "New email", task: "Watch email" },
        { id: "writer", type: "agent", title: "Reply Writer", task: "Draft a reply" },
        { id: "duplicate_trigger", type: "trigger", title: "Schedule", task: "Run hourly" },
        { id: "sender", type: "agent", title: "Reply Sender", task: "Send the reply to the customer" },
        { id: "isolated", type: "agent", title: "Quality Reviewer", task: "Review quality" }
      ],
      edges: [
        { source: "writer", target: "late_trigger" },
        { source: "late_trigger", target: "writer" },
        { source: "writer", target: "sender" }
      ]
    }));
    const session = await createSession();
    const queued = await sendMessage(session.session_id, "/agent draft, review, and send a customer reply");
    const run = await waitForRun(queued.body.run_id);
    const workflow = (await getSession(session.session_id)).body.workflows[0];
    const triggers = workflow.nodes.filter((node) => node.type === "trigger");
    expect(triggers).toEqual([expect.objectContaining({ title: "Manual request" })]);
    expect(workflow.edges.some((edge) => edge.target === triggers[0].id)).toBe(false);
    expect(allNodesReachable(workflow.nodes, workflow.edges, triggers[0].id)).toBe(true);
    const sender = workflow.nodes.find((node) => node.id === "sender");
    const senderGuard = workflow.edges.find((edge) => edge.target === sender.id);
    expect(sender.side_effect).toBe(true);
    expect(workflow.nodes.find((node) => node.id === senderGuard.source).type).toBe("approval");
    expect(graphHasCycle(workflow.nodes, workflow.edges)).toBe(false);
    expect(run.plan.steps).toHaveLength(3);
  });

  it("distinguishes generated content from durable external creation", async () => {
    composer.mockImplementationOnce(async () => ({
      title: "Report and calendar review",
      nodes: [
        { id: "report", type: "agent", title: "Report Writer", task: "Create a concise report and summary." },
        { id: "calendar", type: "agent", title: "Calendar Coordinator", task: "Create a calendar event for the review." }
      ],
      edges: [{ source: "report", target: "calendar" }]
    }));
    const session = await createSession();
    const queued = await sendMessage(session.session_id, "/agent create a concise report, then create a Google Calendar event");
    await waitForRun(queued.body.run_id);
    const workflow = (await getSession(session.session_id)).body.workflows[0];
    const report = workflow.nodes.find((node) => node.id === "report");
    const calendar = workflow.nodes.find((node) => node.id === "calendar");
    expect(report.side_effect).toBe(false);
    expect(calendar.side_effect).toBe(true);
    expect(workflow.edges.some((edge) => (
      edge.target === calendar.id
      && workflow.nodes.find((node) => node.id === edge.source)?.type === "approval"
    ))).toBe(true);
  });

  it("normalizes a deterministic corpus of malformed model graphs into safe connected DAGs", async () => {
    let caseIndex = 0;
    composer.mockImplementation(async () => malformedProposal(caseIndex++));
    const session = await createSession();
    for (let index = 0; index < 16; index += 1) {
      const command = index % 2 === 0 ? "agent" : "workflow";
      const queued = await sendMessage(session.session_id, `/${command} malformed graph proof ${index}`);
      await waitForRun(queued.body.run_id);
    }
    const workflows = (await getSession(session.session_id)).body.workflows;
    expect(workflows).toHaveLength(16);
    for (const workflow of workflows) {
      const triggers = workflow.nodes.filter((node) => node.type === "trigger");
      expect(triggers).toHaveLength(1);
      expect(workflow.nodes.length).toBeLessThanOrEqual(20);
      expect(workflow.edges.length).toBeLessThanOrEqual(48);
      expect(new Set(workflow.nodes.map((node) => node.id)).size).toBe(workflow.nodes.length);
      expect(workflow.edges.every((edge) => edge.source !== edge.target)).toBe(true);
      expect(workflow.edges.some((edge) => edge.target === triggers[0].id)).toBe(false);
      expect(graphHasCycle(workflow.nodes, workflow.edges)).toBe(false);
      expect(allNodesReachable(workflow.nodes, workflow.edges, triggers[0].id)).toBe(true);
      expect(workflow.nodes.some((node) => node.type === "agent")).toBe(true);
      for (const node of workflow.nodes.filter((item) => item.side_effect === true)) {
        const incoming = workflow.edges.filter((edge) => edge.target === node.id);
        expect(incoming.some((edge) => workflow.nodes.find((candidate) => candidate.id === edge.source)?.type === "approval")).toBe(true);
      }
      if (workflow.mode === "agent_team") expect(triggers[0].title).toBe("Manual request");
    }
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

  it("removes partially created hidden agents when a failed workflow draft is declined", async () => {
    const session = await createSession();
    const queued = await sendMessage(session.session_id, "/agent coordinate a partially created xylophone review");
    await waitForRun(queued.body.run_id);
    let workflow = (await getSession(session.session_id)).body.workflows[0];
    await app.locals.store.mutate((data) => {
      const storedWorkflow = data.workflows.find((item) => item.workflow_id === workflow.workflow_id);
      storedWorkflow.approved_at = new Date().toISOString();
      storedWorkflow.status = "activation_failed";
      storedWorkflow.error = "simulated partial activation";
      storedWorkflow.revision += 1;
      data.agents.push({
        ...agentRecord({
          id: "partial_xylophone_agent",
          title: "Partial Xylophone Agent",
          capability: "Represents a partially registered workflow role.",
          created_by: "alice",
          workspace_id: "workspace_team"
        }),
        runtime_sync_pending: true,
        workflow_origin: {
          workflow_id: workflow.workflow_id,
          node_id: "xylophone",
          source: "generated"
        }
      });
      return storedWorkflow;
    });
    workflow = (await request(app)
      .get(`/api/workflows/${workflow.workflow_id}`)
      .set(auth("workflow_alice"))
      .expect(200)).body;
    const declined = await request(app)
      .post(`/api/workflows/${workflow.workflow_id}/decision`)
      .set(auth("workflow_alice"))
      .send({ decision: "deny", revision: workflow.revision })
      .expect(200);
    expect(declined.body).toMatchObject({ status: "declined", error: null });
    expect(app.locals.store.read((data) => data.agents.some((agent) => agent.id === "partial_xylophone_agent"))).toBe(false);
    const statusMessage = app.locals.store.read((data) => data.messages.find((message) => (
      message.workflow_id === workflow.workflow_id
      && message.kind === "workflow_declined"
    )));
    expect(statusMessage.content).toContain("connected apps you already authorized remain available");
  });

  it("compensates a Runtime registration when durable workflow-agent persistence fails", async () => {
    const session = await createSession();
    const queued = await sendMessage(session.session_id, "/agent coordinate a durable cobalt review");
    await waitForRun(queued.body.run_id);
    const workflow = (await getSession(session.session_id)).body.workflows[0];
    const previousRuntime = {
      TCAR_ENGINE_MODE: process.env.TCAR_ENGINE_MODE,
      TCAR_RUNTIME_API_URL: process.env.TCAR_RUNTIME_API_URL,
      TCAR_RUNTIME_API_KEY: process.env.TCAR_RUNTIME_API_KEY
    };
    process.env.TCAR_ENGINE_MODE = "real";
    process.env.TCAR_RUNTIME_API_URL = "http://runtime.workflow.test";
    process.env.TCAR_RUNTIME_API_KEY = "workflow-compensation-test-key";
    const store = app.locals.store;
    const originalSaveNow = store.saveNow.bind(store);
    let failNextSave = false;
    store.saveNow = async () => {
      if (!failNextSave) return originalSaveNow();
      failNextSave = false;
      throw new Error("forced workflow-agent durable save failure");
    };
    const calls = [];
    let registeredAgentId = "";
    let registrationId = "";
    const restoreFetch = setRuntimeFetchForTests(async (url, options = {}) => {
      const pathName = new URL(url).pathname;
      const body = options.body ? JSON.parse(options.body) : {};
      calls.push({ method: options.method || "GET", pathName, body });
      if (pathName === "/agents" && options.method === "POST") {
        registeredAgentId = body.id;
        registrationId = body.registration_id;
        failNextSave = true;
        return Response.json({
          ok: true,
          status: "added",
          id: body.id,
          registration_id: body.registration_id,
          result: { status: "added", id: body.id },
          agent: {
            ...body,
            enabled: true,
            mounted: true,
            registration_kind: "agent",
            registration_cleanup_allowed: true
          },
          mounted: true,
          requires_vllm_reload: false
        });
      }
      if (registeredAgentId && pathName === `/agents/${registeredAgentId}` && options.method === "DELETE") {
        return Response.json({
          ok: true,
          status: "purged",
          id: registeredAgentId,
          agent: { id: registeredAgentId, enabled: false, mounted: false },
          enabled: false,
          mounted: false,
          purged: true,
          requires_vllm_reload: false
        });
      }
      return Response.json({ detail: "not found" }, { status: 404 });
    });
    try {
      await request(app)
        .post(`/api/workflows/${workflow.workflow_id}/decision`)
        .set(auth("workflow_alice"))
        .send({ decision: "approve", revision: workflow.revision })
        .expect(500);
      expect(calls.map((call) => `${call.method} ${call.pathName}`)).toEqual([
        "POST /agents",
        `DELETE /agents/${registeredAgentId}`
      ]);
      expect(calls[1].body).toMatchObject({
        registration_id: registrationId,
        purge_registration: true
      });
      expect(store.read((data) => data.agents.some((agent) => agent.id === registeredAgentId))).toBe(false);
      const failed = (await request(app)
        .get(`/api/workflows/${workflow.workflow_id}`)
        .set(auth("workflow_alice"))
        .expect(200)).body;
      expect(failed).toMatchObject({
        status: "activation_failed",
        error: expect.stringContaining("durable save failure")
      });
    } finally {
      restoreFetch();
      store.saveNow = originalSaveNow;
      for (const [key, value] of Object.entries(previousRuntime)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("preserves indirect agent handoffs through decision and approval nodes", async () => {
    composer.mockImplementationOnce(async () => ({
      title: "Indirect handoff team",
      nodes: [
        { id: "collector", type: "agent", title: "Signal Collector", task: "Collect verified signals", produces: ["signal_notes"] },
        { id: "quality_gate", type: "decision", title: "Quality gate", task: "Check whether evidence is sufficient" },
        { id: "editor", type: "agent", title: "Signal Editor", task: "Turn sufficient signals into a brief", produces: ["signal_brief"] }
      ],
      edges: [
        { source: "collector", target: "quality_gate", label: "evidence" },
        { source: "quality_gate", target: "editor", label: "approved evidence" }
      ]
    }));
    const session = await createSession();
    const queued = await sendMessage(session.session_id, "/agent collect signals, check quality, and prepare a brief");
    const run = await waitForRun(queued.body.run_id);
    let workflow = (await getSession(session.session_id)).body.workflows[0];
    expect(run.plan.steps.find((step) => step.adapter.includes("signal_editor")).depends_on).toHaveLength(1);
    workflow = (await request(app)
      .post(`/api/workflows/${workflow.workflow_id}/decision`)
      .set(auth("workflow_alice"))
      .send({ decision: "approve", revision: workflow.revision })
      .expect(200)).body;
    const collectorId = workflow.activation.node_agents.find((item) => item.node_id === "collector").agent_id;
    const editorId = workflow.activation.node_agents.find((item) => item.node_id === "editor").agent_id;
    expect(workflow.activation.edges).toContainEqual({ from: collectorId, to: editorId, label: "handoff" });
    const editor = app.locals.store.read((data) => data.agents.find((agent) => agent.id === editorId));
    expect(editor.consumes).toContain(`agent:${collectorId}:output`);
  });

  it("uses a workflow-scoped copy when handoffs would otherwise mutate a reusable workspace agent", async () => {
    await app.locals.store.mutate((data) => {
      data.agents.push(agentRecord({
        id: "reusable_amber_reviewer",
        title: "Reusable Amber Reviewer",
        capability: "Reviews amber drafts for accuracy and tone.",
        created_by: "alice",
        workspace_id: "workspace_team"
      }));
      return true;
    });
    composer.mockImplementationOnce(async () => ({
      title: "Scoped amber review",
      nodes: [
        { id: "writer", type: "agent", title: "Amber Draft Writer", task: "Write an amber draft", produces: ["amber_draft"] },
        {
          id: "reviewer",
          type: "agent",
          title: "Reusable Amber Reviewer",
          task: "Review the amber draft for accuracy and tone.",
          capability: "Reviews amber drafts for accuracy and tone.",
          candidate_id: "workspace:reusable_amber_reviewer",
          produces: ["domain_output"]
        }
      ],
      edges: [{ source: "writer", target: "reviewer", label: "draft" }]
    }));
    const session = await createSession();
    const queued = await sendMessage(session.session_id, "/agent write and review an amber draft");
    await waitForRun(queued.body.run_id);
    let workflow = (await getSession(session.session_id)).body.workflows[0];
    workflow = (await request(app)
      .post(`/api/workflows/${workflow.workflow_id}/decision`)
      .set(auth("workflow_alice"))
      .send({ decision: "approve", revision: workflow.revision })
      .expect(200)).body;
    const reviewerId = workflow.activation.node_agents.find((item) => item.node_id === "reviewer").agent_id;
    expect(reviewerId).not.toBe("reusable_amber_reviewer");
    const stored = app.locals.store.read();
    const original = stored.agents.find((agent) => agent.id === "reusable_amber_reviewer");
    const scoped = stored.agents.find((agent) => agent.id === reviewerId);
    expect(original.consumes).toEqual(["user_request"]);
    expect(original.tools).toEqual([]);
    expect(scoped.workflow_origin).toMatchObject({
      workflow_id: workflow.workflow_id,
      node_id: "reviewer",
      source: "workspace_copy",
      source_agent_id: "reusable_amber_reviewer"
    });
    expect(scoped.runtime_sync_pending).toBeUndefined();
  });

  it("preserves an exact custom MCP binding when a standalone workspace agent is reused", async () => {
    const alias = "mcp_aaaaaaaa_search_notes_bbbbbb";
    await app.locals.store.mutate((data) => {
      data.agents.push({
        ...agentRecord({
          id: "custom_mcp_researcher",
          title: "Custom MCP Researcher",
          capability: "Researches aurora notes using its assigned private source.",
          created_by: "alice",
          workspace_id: "workspace_team"
        }),
        tools: [alias],
        tool_contracts: {
          [alias]: {
            description: "Search assigned notes.",
            input_schema: { type: "object", properties: { query: { type: "string" } } }
          }
        },
        mcp_bindings: [{
          connection_id: "mcpconn_exact_custom",
          connection_name: "Exact private source",
          template_id: "custom",
          tools: [{
            name: "search_notes",
            alias,
            title: "Search notes",
            description: "Search assigned notes.",
            risk: "read",
            requires_approval: false,
            input_schema: { type: "object", properties: { query: { type: "string" } } },
            schema_digest: "a".repeat(64)
          }]
        }]
      });
      return true;
    });
    composer.mockImplementationOnce(async () => ({
      title: "Custom MCP research",
      nodes: [{
        id: "researcher",
        type: "agent",
        title: "Custom MCP Researcher",
        task: "Research aurora notes using the assigned private source.",
        capability: "Researches aurora notes using its assigned private source.",
        candidate_id: "workspace:custom_mcp_researcher"
      }],
      edges: []
    }));
    const session = await createSession();
    const queued = await sendMessage(session.session_id, "/agent research aurora notes with the Custom MCP Researcher");
    await waitForRun(queued.body.run_id);
    let workflow = (await getSession(session.session_id)).body.workflows[0];
    expect(workflow.connection_requirements).toEqual([]);
    workflow = (await request(app)
      .post(`/api/workflows/${workflow.workflow_id}/decision`)
      .set(auth("workflow_alice"))
      .send({ decision: "approve", revision: workflow.revision })
      .expect(200)).body;
    expect(workflow.activation.node_agents[0].agent_id).toBe("custom_mcp_researcher");
    const stored = app.locals.store.read((data) => data.agents.find((agent) => agent.id === "custom_mcp_researcher"));
    expect(stored.tools).toContain(alias);
    expect(stored.mcp_bindings).toEqual([
      expect.objectContaining({ connection_id: "mcpconn_exact_custom" })
    ]);
  });

  it("keeps role attributes isolated across repeated workflows and enables required built-in tools", async () => {
    const staleBusinessCapability = "Analyzes general business questions, researches approved current sources when needed, and organizes findings for decision-making.";
    await app.locals.store.mutate((data) => {
      data.agents.push({
        ...agentRecord({
          id: "business_analyst_proof",
          title: "Business Analyst",
          capability: staleBusinessCapability,
          created_by: "system",
          workspace_id: null
        }),
        visibility: "global",
        system_managed: true,
        routing_cues: ["business analysis", "business plan", "decision brief"],
        tools: ["web_search"]
      });
      return true;
    });

    composer.mockImplementationOnce(async (input) => {
      expect(input.candidates.some((item) => item.candidate_id === "workspace:business_analyst_proof")).toBe(true);
      return {
        title: "Business planning team",
        nodes: [{
          id: "business_planner",
          type: "agent",
          title: "Business Analyst",
          task: "Create a concise business plan and verify relevant current public sources.",
          capability: "Creates focused business plans using the user's constraints and verified current context.",
          candidate_id: "workspace:business_analyst_proof",
          produces: ["business_plan"]
        }],
        edges: []
      };
    });

    const session = await createSession();
    const firstRun = await sendMessage(session.session_id, "/agent create a business plan using current public sources");
    await waitForRun(firstRun.body.run_id);
    let loaded = await getSession(session.session_id);
    const firstWorkflow = loaded.body.workflows.find((item) => item.title === "Business planning team");
    const firstActivated = await request(app)
      .post(`/api/workflows/${firstWorkflow.workflow_id}/decision`)
      .set(auth("workflow_alice"))
      .send({ decision: "approve", revision: firstWorkflow.revision })
      .expect(200);
    const firstAgentId = firstActivated.body.activation.node_agents[0].agent_id;

    composer.mockImplementationOnce(async (input) => {
      const previousWorkflowAgent = input.candidates.find((item) => item.agent_id === firstAgentId);
      expect(previousWorkflowAgent).toBeTruthy();
      return {
        title: "Math tutoring team",
        nodes: [{
          id: "math_tutor",
          type: "agent",
          title: "Math Tutor",
          task: "Teach algebra step by step and check current public curriculum sources when needed.",
          // Reproduce a model copying the stale catalog description even
          // though the visible role and task are unrelated.
          capability: staleBusinessCapability,
          candidate_id: previousWorkflowAgent.candidate_id,
          produces: ["lesson"]
        }],
        edges: []
      };
    });

    const secondRun = await sendMessage(session.session_id, "/agent create a Math Tutor that checks current public curriculum sources");
    await waitForRun(secondRun.body.run_id);
    loaded = await getSession(session.session_id);
    const secondWorkflow = loaded.body.workflows.find((item) => item.title === "Math tutoring team");
    const mathNode = secondWorkflow.nodes.find((node) => node.id === "math_tutor");
    expect(mathNode.capability).toBe("Teach algebra step by step and check current public curriculum sources when needed.");
    expect(mathNode.candidate_id).not.toBe(`workspace:${firstAgentId}`);
    expect(mathNode.capability).not.toBe(staleBusinessCapability);
    expect(mathNode.tools).toEqual(expect.arrayContaining(["calculator", "web_search"]));

    const secondActivated = await request(app)
      .post(`/api/workflows/${secondWorkflow.workflow_id}/decision`)
      .set(auth("workflow_alice"))
      .send({ decision: "approve", revision: secondWorkflow.revision })
      .expect(200);
    const secondAgentId = secondActivated.body.activation.node_agents[0].agent_id;
    expect(secondAgentId).not.toBe(firstAgentId);

    const stored = app.locals.store.read();
    const firstAgent = stored.agents.find((agent) => agent.id === firstAgentId);
    const mathAgent = stored.agents.find((agent) => agent.id === secondAgentId);
    expect(firstAgent.capability).toBe("Creates focused business plans using the user's constraints and verified current context.");
    expect(firstAgent.tools).toContain("web_search");
    expect(mathAgent.capability).toBe(mathNode.capability);
    expect(mathAgent.tools).toEqual(expect.arrayContaining(["calculator", "web_search"]));
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

  it("recovers an interrupted activation after restart and resumes it once", async () => {
    const session = await createSession();
    const queued = await sendMessage(session.session_id, "/agent coordinate a restart-safe xylophone review");
    await waitForRun(queued.body.run_id);
    let workflow = (await getSession(session.session_id)).body.workflows[0];
    const interruptedRevision = workflow.revision + 1;
    await app.locals.store.mutate((data) => {
      const current = data.workflows.find((item) => item.workflow_id === workflow.workflow_id);
      current.approved_at = new Date().toISOString();
      current.status = "activating";
      current.revision = interruptedRevision;
      current.activation_claim_id = "activation_from_dead_process";
      current.activation_claimed_at = new Date().toISOString();
      return current;
    });
    await app.locals.drainBackgroundTasks({ timeoutMs: 5000 });
    await app.locals.store.close();
    app = await createApp({ dbPath, uploadRoot: tmpDir, workflowComposer: composer });
    expect(app.locals.workflowStartupRecovery).toEqual({
      recovered: 1,
      workflow_ids: [workflow.workflow_id]
    });
    workflow = (await request(app)
      .get(`/api/workflows/${workflow.workflow_id}`)
      .set(auth("workflow_alice"))
      .expect(200)).body;
    expect(workflow).toMatchObject({
      status: "activation_failed",
      revision: interruptedRevision + 1,
      error: expect.stringContaining("interrupted")
    });
    const resumed = await request(app)
      .post(`/api/workflows/${workflow.workflow_id}/resume`)
      .set(auth("workflow_alice"))
      .send({})
      .expect(200);
    expect(resumed.body.status).toBe("active");
    expect(app.locals.store.read().agents.filter((agent) => agent.workflow_origin?.workflow_id === workflow.workflow_id)).toHaveLength(1);
  });

  it.each([
    { kind: "generated", crashPoint: "before_remote", anchorHex: "1", registrationHex: "a" },
    {
      kind: "generated",
      crashPoint: "after_remote",
      anchorHex: "2",
      registrationHex: "b",
      pauseStartupCleanup: true
    },
    { kind: "marketplace", crashPoint: "before_remote", anchorHex: "3", registrationHex: "c" },
    {
      kind: "marketplace",
      crashPoint: "after_remote",
      anchorHex: "4",
      registrationHex: "d",
      retryAfterStartupOutage: true
    }
  ])("reconciles a $kind provisional anchor $crashPoint across restart and recreates it", async ({
    kind,
    crashPoint,
    anchorHex,
    registrationHex,
    retryAfterStartupOutage = false,
    pauseStartupCleanup = false
  }) => {
    const session = await createSession();
    const queued = await sendMessage(session.session_id, `/agent prepare a ${kind} restart recovery proof`);
    await waitForRun(queued.body.run_id);
    const workflow = (await getSession(session.session_id)).body.workflows[0];
    const provisionalAgentId = `${kind}_restart_anchor_${anchorHex}`;
    const registrationId = `registration_${registrationHex.repeat(48)}`;
    const anchorId = `workflow_registration_${anchorHex.repeat(32)}`;
    const listingId = `listing_${"f".repeat(16)}`;
    await app.locals.store.mutate((data) => {
      const current = data.workflows.find((item) => item.workflow_id === workflow.workflow_id);
      const node = current.nodes.find((item) => item.type === "agent");
      current.approved_at = new Date().toISOString();
      current.status = "activating";
      current.revision += 1;
      current.activation_claim_id = `activation_crashed_${anchorHex}`;
      current.activation_claimed_at = new Date().toISOString();
      if (kind === "generated") {
        Object.assign(node, {
          source: "generated",
          candidate_id: null,
          agent_id: null,
          listing_id: null,
          generated_agent: {
            id_hint: provisionalAgentId,
            title: "Restart Recovery Agent",
            capability: "Recreates a safely reconciled generated agent after restart.",
            boundary: "Use only the declared restart recovery task.",
            consumes: ["user_request"],
            produces: ["recovery_output"],
            routing_cues: ["restart recovery"],
            tools: []
          }
        });
      } else {
        Object.assign(node, {
          source: "marketplace",
          candidate_id: `marketplace:${listingId}`,
          agent_id: null,
          listing_id: listingId,
          generated_agent: { id_hint: provisionalAgentId }
        });
        data.agents.push({
          ...agentRecord({
            id: "published_restart_recovery_agent",
            title: "Publisher-only source",
            capability: "Private publisher source that is not copied directly.",
            created_by: "publisher",
            workspace_id: "workspace_market"
          }),
          marketplace: {
            published: true,
            listing_id: listingId,
            published_by: "publisher",
            publisher_workspace_id: "workspace_market",
            description: "Restart-safe Marketplace specialist.",
            snapshot: {
              title: "Marketplace Restart Recovery Agent",
              capability: "Recreates a safely reconciled Marketplace agent after restart.",
              consumes: ["user_request"],
              produces: ["recovery_output"],
              routing_cues: ["restart recovery"],
              tools: [],
              connector_requirements: []
            }
          }
        });
      }
      data.agents.push({
        ...agentRecord({
          id: provisionalAgentId,
          title: "Non-routable crash anchor",
          capability: "Records exact cleanup ownership while registration is incomplete.",
          created_by: "alice",
          workspace_id: "workspace_team"
        }),
        ready: false,
        runtime_sync_pending: true,
        ...(kind === "generated" ? {
          workflow_origin: {
            workflow_id: current.workflow_id,
            node_id: node.id,
            source: "generated"
          }
        } : {
          marketplace_origin: {
            listing_id: listingId,
            source_agent_id: "published_restart_recovery_agent",
            publisher_user_id: "publisher",
            copied_at: new Date().toISOString()
          }
        }),
        workflow_registration_anchor: {
          schema_version: "workflow-runtime-registration-anchor-v1",
          anchor_id: anchorId,
          registration_id: registrationId,
          agent_id: provisionalAgentId,
          kind,
          workflow_id: current.workflow_id,
          workflow_node_id: node.id,
          listing_id: kind === "marketplace" ? listingId : null,
          workspace_id: "workspace_team",
          created_by: "alice",
          requested_role: "user",
          created_at: new Date().toISOString()
        }
      });
      return current;
    });

    const visibleBeforeRestart = await request(app)
      .get("/api/agents?limit=100")
      .set(auth("workflow_alice"))
      .expect(200);
    expect(JSON.stringify(visibleBeforeRestart.body)).not.toContain(registrationId);

    await app.locals.drainBackgroundTasks({ timeoutMs: 5000 });
    await app.locals.store.close();
    app = null;
    const previousRuntime = {
      TCAR_ENGINE_MODE: process.env.TCAR_ENGINE_MODE,
      TCAR_RUNTIME_API_URL: process.env.TCAR_RUNTIME_API_URL,
      TCAR_RUNTIME_API_KEY: process.env.TCAR_RUNTIME_API_KEY
    };
    process.env.TCAR_ENGINE_MODE = "real";
    process.env.TCAR_RUNTIME_API_URL = "http://runtime.workflow-restart.test";
    process.env.TCAR_RUNTIME_API_KEY = "workflow-restart-recovery-test-key";
    let crashedRegistrationExists = crashPoint === "after_remote";
    let cleanupAttempts = 0;
    let startupCleanupObserved;
    const startupCleanupStarted = new Promise((resolve) => { startupCleanupObserved = resolve; });
    let releaseStartupCleanup;
    const startupCleanupGate = new Promise((resolve) => { releaseStartupCleanup = resolve; });
    const calls = [];
    const restoreFetch = setRuntimeFetchForTests(async (url, options = {}) => {
      const pathName = new URL(url).pathname;
      const method = options.method || "GET";
      const body = options.body ? JSON.parse(options.body) : {};
      calls.push({ method, pathName, body });
      if (method === "DELETE" && pathName === `/agents/${provisionalAgentId}`) {
        cleanupAttempts += 1;
        if (pauseStartupCleanup && cleanupAttempts === 1) {
          startupCleanupObserved();
          await startupCleanupGate;
        }
        if (retryAfterStartupOutage && cleanupAttempts === 1) {
          return Response.json({ detail: "synthetic startup Runtime outage" }, { status: 503 });
        }
        if (!crashedRegistrationExists) {
          return Response.json({ detail: "not found" }, { status: 404 });
        }
        expect(body).toMatchObject({
          registration_id: registrationId,
          purge_registration: true
        });
        crashedRegistrationExists = false;
        return Response.json({
          ok: true,
          status: "purged",
          id: provisionalAgentId,
          agent: { id: provisionalAgentId, enabled: false, mounted: false },
          enabled: false,
          mounted: false,
          purged: true,
          requires_vllm_reload: false
        });
      }
      if (method === "POST" && pathName === "/agents") {
        expect(body.id).toBe(provisionalAgentId);
        expect(body.registration_id).not.toBe(registrationId);
        return Response.json({
          ok: true,
          status: "added",
          id: body.id,
          registration_id: body.registration_id,
          result: { status: "added", id: body.id },
          agent: {
            ...body,
            enabled: true,
            mounted: true,
            registration_kind: "agent",
            registration_cleanup_allowed: true
          },
          mounted: true,
          requires_vllm_reload: false
        });
      }
      return Response.json({ detail: "not found" }, { status: 404 });
    });
    try {
      const boot = createApp({ dbPath, uploadRoot: tmpDir, workflowComposer: composer });
      app = pauseStartupCleanup
        ? await Promise.race([
            boot,
            new Promise((_, reject) => setTimeout(() => reject(new Error("startup waited for Runtime cleanup")), 1000))
          ])
        : await boot;
      if (pauseStartupCleanup) {
        expect(app.locals.workflowRegistrationStartupRecovery).toMatchObject({
          pending: 1,
          scheduled: true
        });
        await startupCleanupStarted;
        releaseStartupCleanup();
      }
      await app.locals.workflowRegistrationStartupRecoveryPromise;
      if (retryAfterStartupOutage) {
        expect(app.locals.workflowRegistrationStartupRecovery).toMatchObject({
          attempted: 1,
          reconciled: 0,
          pending: 1,
          results: [{
            agent_id: provisionalAgentId,
            anchor_id: anchorId,
            status: "pending"
          }]
        });
      } else {
        expect(app.locals.workflowRegistrationStartupRecovery).toMatchObject({
          attempted: 1,
          reconciled: 1,
          pending: 0,
          results: [{
            agent_id: provisionalAgentId,
            anchor_id: anchorId,
            status: "reconciled",
            remote_state: crashPoint === "after_remote" ? "purged" : "absent"
          }]
        });
      }
      expect(app.locals.store.read((data) => data.agents.some((agent) => (
        agent.id === provisionalAgentId
        && agent.runtime_sync_pending === true
      )))).toBe(retryAfterStartupOutage);
      const recovered = await request(app)
        .get(`/api/workflows/${workflow.workflow_id}`)
        .set(auth("workflow_alice"))
        .expect(200);
      expect(recovered.body.status).toBe("activation_failed");
      const resumed = await request(app)
        .post(`/api/workflows/${workflow.workflow_id}/resume`)
        .set(auth("workflow_alice"))
        .send({})
        .expect(200);
      expect(resumed.body.status).toBe("active");
      const recreated = app.locals.store.read((data) => data.agents.find((agent) => (
        agent.id === provisionalAgentId
        && agent.created_by === "alice"
        && agent.workspace_id === "workspace_team"
      )));
      expect(recreated).toMatchObject({ ready: true });
      expect(recreated.runtime_sync_pending).toBeUndefined();
      expect(recreated.workflow_registration_anchor).toBeUndefined();
      expect(calls.map((call) => `${call.method} ${call.pathName}`)).toEqual([
        ...(retryAfterStartupOutage ? [`DELETE /agents/${provisionalAgentId}`] : []),
        `DELETE /agents/${provisionalAgentId}`,
        "POST /agents"
      ]);
    } finally {
      releaseStartupCleanup();
      restoreFetch();
      for (const [key, value] of Object.entries(previousRuntime)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("atomically owns a promoted Marketplace copy and resumes after the next persistence step crashes", async () => {
    const listingId = `listing_${"e".repeat(16)}`;
    await app.locals.store.mutate((data) => {
      data.agents.push({
        ...agentRecord({
          id: "published_atomic_promotion_agent",
          title: "Publisher atomic source",
          capability: "Publisher-only source content.",
          created_by: "publisher",
          workspace_id: "workspace_market"
        }),
        marketplace: {
          published: true,
          listing_id: listingId,
          published_by: "publisher",
          publisher_workspace_id: "workspace_market",
          description: "Atomic promotion recovery specialist.",
          snapshot: {
            title: "Atomic Promotion Agent",
            capability: "Proves a Marketplace copy survives an interrupted workflow activation.",
            consumes: ["user_request"],
            produces: ["promotion_proof"],
            routing_cues: ["atomic promotion"],
            tools: [],
            connector_requirements: []
          }
        }
      });
      return true;
    });
    composer.mockImplementationOnce(async () => ({
      title: "Atomic Marketplace promotion",
      nodes: [{
        id: "atomic_marketplace",
        type: "agent",
        title: "Atomic Promotion Agent",
        task: "Prove the Marketplace promotion is restart-safe.",
        candidate_id: `marketplace:${listingId}`,
        produces: ["promotion_proof"]
      }],
      edges: []
    }));
    const session = await createSession();
    const queued = await sendMessage(session.session_id, "/agent prove an atomic Marketplace promotion");
    await waitForRun(queued.body.run_id);
    let workflow = (await getSession(session.session_id)).body.workflows[0];
    expect(workflow.nodes.find((node) => node.type === "agent")).toMatchObject({
      source: "marketplace",
      listing_id: listingId
    });

    const previousRuntime = {
      TCAR_ENGINE_MODE: process.env.TCAR_ENGINE_MODE,
      TCAR_RUNTIME_API_URL: process.env.TCAR_RUNTIME_API_URL,
      TCAR_RUNTIME_API_KEY: process.env.TCAR_RUNTIME_API_KEY
    };
    process.env.TCAR_ENGINE_MODE = "real";
    process.env.TCAR_RUNTIME_API_URL = "http://runtime.atomic-promotion.test";
    process.env.TCAR_RUNTIME_API_KEY = "atomic-promotion-restart-test-key";
    const calls = [];
    let registeredAgentId = "";
    const restoreFetch = setRuntimeFetchForTests(async (url, options = {}) => {
      const pathName = new URL(url).pathname;
      const method = options.method || "GET";
      const body = options.body ? JSON.parse(options.body) : {};
      calls.push({ method, pathName, body });
      if (method === "POST" && pathName === "/agents") {
        registeredAgentId = body.id;
        return Response.json({
          ok: true,
          status: "added",
          id: body.id,
          registration_id: body.registration_id,
          result: { status: "added", id: body.id },
          agent: {
            ...body,
            enabled: true,
            mounted: true,
            registration_kind: "agent",
            registration_cleanup_allowed: true
          },
          mounted: true,
          requires_vllm_reload: false
        });
      }
      return Response.json({ detail: "unexpected Runtime call" }, { status: 500 });
    });
    const store = app.locals.store;
    const originalSaveNow = store.saveNow.bind(store);
    let promotionSaved = false;
    let postPromotionFailureInjected = false;
    store.saveNow = async () => {
      const promoted = registeredAgentId && store.read((data) => data.agents.find((agent) => (
        agent.id === registeredAgentId
        && agent.ready === true
        && agent.runtime_sync_pending === true
        && agent.marketplace_origin?.listing_id === listingId
        && agent.workflow_origin?.workflow_id === workflow.workflow_id
        && agent.workflow_origin?.node_id === "atomic_marketplace"
      )));
      if (promoted && !promotionSaved) {
        await originalSaveNow();
        promotionSaved = true;
        return;
      }
      if (promotionSaved && !postPromotionFailureInjected) {
        postPromotionFailureInjected = true;
        throw new Error("synthetic crash after atomic Marketplace promotion");
      }
      return originalSaveNow();
    };
    try {
      await request(app)
        .post(`/api/workflows/${workflow.workflow_id}/decision`)
        .set(auth("workflow_alice"))
        .send({ decision: "approve", revision: workflow.revision })
        .expect(500);
      expect(promotionSaved).toBe(true);
      expect(postPromotionFailureInjected).toBe(true);
      expect(calls.map((call) => `${call.method} ${call.pathName}`)).toEqual(["POST /agents"]);
      const interruptedAgent = store.read((data) => data.agents.find((agent) => agent.id === registeredAgentId));
      expect(interruptedAgent).toMatchObject({
        ready: true,
        runtime_sync_pending: true,
        workflow_origin: {
          workflow_id: workflow.workflow_id,
          node_id: "atomic_marketplace",
          source: "marketplace",
          listing_id: listingId
        }
      });
      expect(interruptedAgent.workflow_registration_anchor).toBeUndefined();

      store.saveNow = originalSaveNow;
      await app.locals.drainBackgroundTasks({ timeoutMs: 5000 });
      await app.locals.store.close();
      app = await createApp({ dbPath, uploadRoot: tmpDir, workflowComposer: composer });
      expect(app.locals.workflowRegistrationStartupRecovery).toMatchObject({
        attempted: 0,
        reconciled: 0,
        pending: 0
      });
      workflow = (await request(app)
        .get(`/api/workflows/${workflow.workflow_id}`)
        .set(auth("workflow_alice"))
        .expect(200)).body;
      expect(workflow.status).toBe("activation_failed");
      const resumed = await request(app)
        .post(`/api/workflows/${workflow.workflow_id}/resume`)
        .set(auth("workflow_alice"))
        .send({})
        .expect(200);
      expect(resumed.body.status).toBe("active");
      expect(calls.map((call) => `${call.method} ${call.pathName}`)).toEqual(["POST /agents"]);
      const activeAgent = app.locals.store.read((data) => data.agents.find((agent) => agent.id === registeredAgentId));
      expect(activeAgent.ready).toBe(true);
      expect(activeAgent.runtime_sync_pending).toBeUndefined();
      expect(resumed.body.activation.node_agents).toContainEqual(expect.objectContaining({
        node_id: "atomic_marketplace",
        agent_id: registeredAgentId
      }));
    } finally {
      store.saveNow = originalSaveNow;
      restoreFetch();
      for (const [key, value] of Object.entries(previousRuntime)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("composes an unclaimed queued slash command once after a process restart", async () => {
    await app.locals.drainBackgroundTasks({ timeoutMs: 5000 });
    await app.locals.store.close();
    app = await createApp({
      dbPath,
      uploadRoot: tmpDir,
      workflowComposer: composer,
      autoRun: false
    });
    const session = await createSession();
    const queued = await sendMessage(session.session_id, "/workflow coordinate restart-safe xylophone checks");
    expect(app.locals.store.read((data) => data.runs.find((run) => run.run_id === queued.body.run_id))).toMatchObject({
      kind: "workflow_composition",
      status: "queued"
    });
    await app.locals.store.close();
    app = await createApp({ dbPath, uploadRoot: tmpDir, workflowComposer: composer });
    expect(app.locals.startupRecovery.chats_rescheduled).toBe(1);
    const run = await waitForRun(queued.body.run_id);
    expect(run.status).toBe("completed");
    expect(composer).toHaveBeenCalledTimes(1);
    expect((await getSession(session.session_id)).body.workflows).toHaveLength(1);
  });

  it("does not churn revisions when a paused workflow is resumed without a connection change", async () => {
    composer.mockImplementationOnce(async () => ({
      title: "Paused Gmail helper",
      nodes: [{
        id: "mail",
        type: "agent",
        title: "Paused Mail Helper",
        task: "Read relevant Gmail messages",
        provider_ids: ["gmail"],
        tool_keywords: ["mail", "message"]
      }],
      edges: []
    }));
    const session = await createSession();
    const queued = await sendMessage(session.session_id, "/workflow read relevant Gmail messages");
    await waitForRun(queued.body.run_id);
    let workflow = (await getSession(session.session_id)).body.workflows[0];
    workflow = (await request(app)
      .post(`/api/workflows/${workflow.workflow_id}/decision`)
      .set(auth("workflow_alice"))
      .send({ decision: "approve", revision: workflow.revision })
      .expect(200)).body;
    const revision = workflow.revision;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      workflow = (await request(app)
        .post(`/api/workflows/${workflow.workflow_id}/resume`)
        .set(auth("workflow_alice"))
        .send({})
        .expect(200)).body;
      expect(workflow.status).toBe("awaiting_connections");
      expect(workflow.revision).toBe(revision);
    }
  });

  it("does not let a late connection callback reopen a cancelled workflow", async () => {
    composer.mockImplementationOnce(async () => ({
      title: "Cancelled Gmail helper",
      nodes: [{
        id: "mail",
        type: "agent",
        title: "Gmail Helper",
        task: "Read relevant Gmail messages.",
        provider_ids: ["gmail"],
        tool_keywords: ["mail", "message"]
      }],
      edges: []
    }));
    const session = await createSession();
    const queued = await sendMessage(session.session_id, "/workflow read relevant Gmail messages");
    await waitForRun(queued.body.run_id);
    let workflow = (await getSession(session.session_id)).body.workflows[0];
    workflow = (await request(app)
      .post(`/api/workflows/${workflow.workflow_id}/decision`)
      .set(auth("workflow_alice"))
      .send({ decision: "approve", revision: workflow.revision })
      .expect(200)).body;
    workflow = (await request(app)
      .post(`/api/workflows/${workflow.workflow_id}/decision`)
      .set(auth("workflow_alice"))
      .send({ decision: "deny", revision: workflow.revision })
      .expect(200)).body;
    expect(workflow.status).toBe("declined");
    await app.locals.store.mutate((data) => {
      data.mcpConnections.push({
        connection_id: "mcpconn_late_gmail",
        name: "Late Gmail",
        template_id: "gmail",
        provider_id: "gmail",
        connection_mode: "managed",
        workspace_id: "workspace_team",
        visibility: "private",
        created_by: "alice",
        status: "ready",
        tools: []
      });
      return true;
    });
    await expect(markWorkflowConnectionOutcome({
      store: app.locals.store,
      workflowId: workflow.workflow_id,
      actor: TOKENS.workflow_alice,
      providerId: "gmail",
      outcome: "connected",
      connectionId: "mcpconn_late_gmail"
    })).rejects.toMatchObject({ code: "workflow_connection_state_conflict" });
    expect((await getSession(session.session_id)).body.workflows[0].status).toBe("declined");
    expect(app.locals.store.read().agents.filter((agent) => agent.workflow_origin?.workflow_id === workflow.workflow_id)).toHaveLength(0);
  });

  it("does not silently replace an unavailable explicitly selected account", () => {
    const workflow = {
      connection_requirements: [{
        provider_id: "gmail",
        name: "Gmail",
        connection_mode: "managed",
        status: "connected",
        connection_id: "mcpconn_selected_b"
      }]
    };
    const connection = (connectionId, status) => ({
      connection_id: connectionId,
      name: connectionId,
      template_id: "gmail",
      provider_id: "gmail",
      connection_mode: "managed",
      workspace_id: "workspace_team",
      visibility: "private",
      created_by: "alice",
      status,
      tools: []
    });
    const missing = refreshConnectionRequirements(workflow, {
      mcpConnections: [
        connection("mcpconn_available_a", "ready"),
        connection("mcpconn_selected_b", "reauthorization_required")
      ]
    }, TOKENS.workflow_alice);
    expect(missing).toHaveLength(1);
    expect(workflow.connection_requirements[0]).toMatchObject({
      status: "missing",
      connection_id: "mcpconn_selected_b",
      connection_selection_required: true
    });
    refreshConnectionRequirements(workflow, {
      mcpConnections: [connection("mcpconn_available_a", "ready")]
    }, TOKENS.workflow_alice);
    expect(workflow.connection_requirements[0]).toMatchObject({
      status: "missing",
      connection_id: "mcpconn_selected_b"
    });
  });

  it("preserves the explicitly selected account when multiple provider connections exist", async () => {
    const gmailTool = (suffix) => ({
      name: `search_messages_${suffix}`,
      title: "Search messages",
      description: "Search matching Gmail messages and threads.",
      risk: "read",
      requires_approval: false,
      input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      schema_digest: suffix.repeat(64).slice(0, 64)
    });
    await app.locals.store.mutate((data) => {
      data.mcpConnections.push(
        {
          connection_id: "mcpconn_gmail_account_a",
          name: "Gmail account A",
          template_id: "gmail",
          provider_id: "gmail",
          connection_mode: "managed",
          workspace_id: "workspace_team",
          visibility: "private",
          created_by: "alice",
          status: "ready",
          tools: [gmailTool("a")]
        },
        {
          connection_id: "mcpconn_gmail_account_b",
          name: "Gmail account B",
          template_id: "gmail",
          provider_id: "gmail",
          connection_mode: "managed",
          workspace_id: "workspace_team",
          visibility: "private",
          created_by: "alice",
          status: "ready",
          tools: [gmailTool("b")]
        }
      );
      return true;
    });
    composer.mockImplementationOnce(async () => ({
      title: "Selected Gmail reader",
      nodes: [{
        id: "mail_reader",
        type: "agent",
        title: "Gmail Reader",
        task: "Read matching Gmail messages.",
        provider_ids: ["gmail"],
        tool_keywords: ["search", "message"]
      }],
      edges: []
    }));
    const session = await createSession();
    const queued = await sendMessage(session.session_id, "/workflow read matching Gmail messages");
    await waitForRun(queued.body.run_id);
    let workflow = (await getSession(session.session_id)).body.workflows[0];
    workflow = (await request(app)
      .post(`/api/workflows/${workflow.workflow_id}/decision`)
      .set(auth("workflow_alice"))
      .send({ decision: "approve", revision: workflow.revision })
      .expect(200)).body;
    expect(workflow.status).toBe("awaiting_connections");
    await expect(markWorkflowConnectionOutcome({
      store: app.locals.store,
      workflowId: workflow.workflow_id,
      actor: TOKENS.workflow_alice,
      providerId: "gmail",
      outcome: "connected",
      connectionId: "mcpconn_does_not_exist"
    })).rejects.toMatchObject({ code: "workflow_connection_unavailable" });

    await request(app)
      .post(`/api/workflows/${workflow.workflow_id}/connections/gmail`)
      .set(auth("workflow_alice"))
      .send({ connection_id: "mcpconn_gmail_account_b", revision: workflow.revision - 1 })
      .expect(409);

    const selectionRevision = workflow.revision;
    const selected = await request(app)
      .post(`/api/workflows/${workflow.workflow_id}/connections/gmail`)
      .set(auth("workflow_alice"))
      .send({ connection_id: "mcpconn_gmail_account_b", revision: selectionRevision })
      .expect(200);
    workflow = selected.body;
    expect(workflow).toMatchObject({
      status: "active",
      connection_requirements: [expect.objectContaining({
        provider_id: "gmail",
        status: "connected",
        connection_id: "mcpconn_gmail_account_b"
      })]
    });
    const agentId = workflow.activation.node_agents[0].agent_id;
    const storedAgent = app.locals.store.read((data) => data.agents.find((agent) => agent.id === agentId));
    expect(storedAgent.mcp_bindings).toEqual([
      expect.objectContaining({ connection_id: "mcpconn_gmail_account_b" })
    ]);
    const repeated = await request(app)
      .post(`/api/workflows/${workflow.workflow_id}/connections/gmail`)
      .set(auth("workflow_alice"))
      .send({ connection_id: "mcpconn_gmail_account_b", revision: selectionRevision })
      .expect(200);
    expect(repeated.body.status).toBe("active");
    await request(app)
      .post(`/api/workflows/${workflow.workflow_id}/connections/gmail`)
      .set(auth("workflow_alice"))
      .send({ connection_id: "mcpconn_gmail_account_a", revision: selectionRevision })
      .expect(409);
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
        }, {
          name: "update_inventory",
          title: "Update inventory",
          description: "Modify product inventory and stock availability.",
          risk: "write",
          requires_approval: true,
          input_schema: { type: "object", properties: { product: { type: "string" } }, required: ["product"] },
          schema_digest: "b".repeat(64)
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
    expect(storedAgent.mcp_bindings[0].tools.some((tool) => tool.name === "update_inventory")).toBe(false);
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

function allNodesReachable(nodes, edges, rootId) {
  const outgoing = new Map(nodes.map((node) => [node.id, []]));
  for (const edge of edges) {
    if (outgoing.has(edge.source) && outgoing.has(edge.target)) outgoing.get(edge.source).push(edge.target);
  }
  const visited = new Set();
  const pending = [rootId];
  while (pending.length) {
    const current = pending.pop();
    if (visited.has(current)) continue;
    visited.add(current);
    pending.push(...(outgoing.get(current) || []));
  }
  return nodes.every((node) => visited.has(node.id));
}

function malformedProposal(seed) {
  const types = ["agent", "decision", "tool", "action", "trigger", "unknown"];
  const nodes = Array.from({ length: 24 }, (_, index) => ({
    id: index % 5 === 0 ? "duplicate id" : `Node ${seed}-${index}`,
    type: types[(seed + index) % types.length],
    title: `Malformed ${seed}-${index}`,
    task: (seed + index) % 4 === 0
      ? "Send and publish the external result"
      : `Analyze malformed case ${seed}-${index}`,
    side_effect: (seed + index) % 7 === 0,
    candidate_id: index % 3 === 0 ? "invented:candidate" : null
  }));
  const edges = Array.from({ length: 60 }, (_, index) => {
    const sourceIndex = (index * 7 + seed) % 27;
    const targetIndex = (index * 11 + seed + (index % 4 === 0 ? 0 : 1)) % 27;
    const id = (value) => value >= 24
      ? `missing-${value}`
      : value % 5 === 0
        ? "duplicate id"
        : `Node ${seed}-${value}`;
    return { source: id(sourceIndex), target: id(targetIndex), label: `edge ${index}` };
  });
  return { title: `Malformed graph ${seed}`, nodes, edges };
}

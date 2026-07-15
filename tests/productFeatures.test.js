import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  AgentCatalog,
  AgentGraph,
  ConnectionsPanel,
  ChatMessage,
  FormattedText,
  ProgressiveFormattedText,
  MarketplaceAgentDialog,
  MarketplacePanel,
  PublishDialog,
  RatingDialog,
  RunDetailsSheet,
  RunReceipt,
  ToolApprovalCheckpoint,
  UsageReceipt,
  WorkflowDraftCard,
  agentPayloadFromForm,
  availableSessionAgents,
  graphConnectionInputs,
  graphConnectionWouldCycle,
  graphConnections,
  graphEdgePath,
  graphPositionFromPointer,
  initialGraphPositions,
  progressiveRevealPlan,
  storedGraphPositions,
  workflowRequirementConnections
} from "../src/App.jsx";
import LandingPage from "../src/LandingPage.jsx";


afterEach(() => {
  vi.unstubAllGlobals();
});


describe("Agent Studio product surfaces", () => {
  it("compiles every agent-builder ability into the persisted execution contract", () => {
    const payload = agentPayloadFromForm({
      item_type: "agent",
      title: "  Packaging analyst  ",
      capability: "  Combine approved context into packaging guidance.  ",
      boundary: "",
      response_style: "careful",
      routing_cues: "packaging, catalog",
      consumes: ["shared_memory", "table_context", "agent:catalog_source:output"],
      produces: ["recommendations", "structured_data"],
      tools: ["calculator"],
      mcp_bindings: [],
      resources: ["agent:catalog_document"],
      source_text: "The approved packaging color is amber.",
      sources: "sources/router_agents/packaging/source.md"
    }, {
      isAdmin: false,
      hasDocumentResources: true
    });

    expect(payload).toMatchObject({
      title: "Packaging analyst",
      capability: "Combine approved context into packaging guidance.",
      routing_cues: "packaging, catalog",
      consumes: [
        "user_request",
        "shared_memory",
        "table_context",
        "agent:catalog_source:output",
        "document_context"
      ],
      produces: ["recommendations", "structured_data"],
      tools: ["calculator", "document_search", "document_read"],
      resources: ["agent:catalog_document"],
      source_text: "The approved packaging color is amber."
    });
    expect(payload.boundary).toContain("Prioritize verified evidence");
    expect(payload).not.toHaveProperty("sources");
  });

  it("renders safe GitHub Markdown and KaTeX without executing raw HTML or loading images", () => {
    const markup = renderToStaticMarkup(createElement(FormattedText, {
      text: [
        "# Result",
        "",
        "**Consistent answer** with $E = mc^2$.",
        "",
        "| Model | Result |",
        "| --- | --- |",
        "| Base | General |",
        "| Team | Context-aware |",
        "",
        "$$\\sum_{i=1}^{n} i$$",
        "",
        "<script>window.__unsafe = true</script>",
        "[unsafe](javascript:alert(1))",
        "![remote](https://example.com/tracker.png)"
      ].join("\n")
    }));

    expect(markup).toContain("<h1>Result</h1>");
    expect(markup).toContain("<strong>Consistent answer</strong>");
    expect(markup).toContain("<table>");
    expect(markup).toContain("class=\"katex\"");
    expect(markup).not.toContain("<script");
    expect(markup).not.toContain("window.__unsafe");
    expect(markup).not.toContain("javascript:");
    expect(markup).not.toContain("tracker.png");
  });

  it("shows transparent Router, per-agent, and final-answer token usage", () => {
    const markup = renderToStaticMarkup(createElement(UsageReceipt, {
      agents: [
        { id: "research_agent", title: "Research Agent" },
        { id: "writer_agent", title: "Writer Agent" }
      ],
      receipt: {
        provider_reported: true,
        complete: true,
        prompt_tokens: 1800,
        completion_tokens: 700,
        total_tokens: 2500,
        charged_credits: "0.32",
        balance_after_credits: "99.68",
        components: [
          { component_key: "router", component: "session_controller_planning", kind: "router", prompt_tokens: 400, completion_tokens: 100, total_tokens: 500, charged_credits: "0.06" },
          { component_key: "research", component: "agent:research_agent:call_1", kind: "agent", agent_id: "research_agent", prompt_tokens: 500, completion_tokens: 200, total_tokens: 700, charged_credits: "0.09" },
          { component_key: "writer", component: "agent:writer_agent:call_1", kind: "agent", agent_id: "writer_agent", prompt_tokens: 500, completion_tokens: 200, total_tokens: 700, charged_credits: "0.09" },
          { component_key: "final", component: "final_synthesis", kind: "final_output", prompt_tokens: 400, completion_tokens: 200, total_tokens: 600, charged_credits: "0.08" }
        ]
      }
    }));
    expect(markup).toContain("2,500 tokens");
    expect(markup).toContain("Router");
    expect(markup).toContain("Research Agent");
    expect(markup).toContain("Writer Agent");
    expect(markup).toContain("Final answer");
    expect(markup).toContain("0.32 credits");
    expect(markup).toContain("99.68 credits remaining");
  });

  it("keeps token usage in the compact clickable answer receipt", () => {
    const markup = renderToStaticMarkup(createElement(RunReceipt, {
      run: {
        status: "completed",
        elapsed_sec: 2.4,
        expert_outputs: [{ adapter: "research_agent" }, { adapter: "writer_agent" }],
        sources: [],
        outcome_contracts: [],
        usage_receipt: { provider_reported: true, total_tokens: 2500 }
      },
      onClick: () => undefined
    }));
    expect(markup).toContain("2 agents · 2.4s · 2,500 tokens");
    expect(markup).toContain("Open Answer details, token usage, and complete agent outputs");
    expect(markup).not.toContain("usage-receipt");
  });

  it("does not place the expanded token card directly in the conversation", () => {
    const markup = renderToStaticMarkup(createElement(ChatMessage, {
      message: { message_id: "answer_1", role: "assistant", content: "A complete response.", run_id: "run_1" },
      run: {
        run_id: "run_1",
        status: "completed",
        elapsed_sec: 1.8,
        expert_outputs: [{ adapter: "research_agent" }],
        sources: [],
        outcome_contracts: [],
        usage_receipt: { provider_reported: true, total_tokens: 840 }
      },
      agents: [{ id: "research_agent", title: "Research Agent" }],
      connections: [],
      canWrite: true,
      onCopy: () => undefined,
      onRetry: () => undefined,
      onFeedback: () => undefined,
      onDetails: () => undefined
    }));
    expect(markup).toContain("1 agent · 1.8s · 840 tokens");
    expect(markup).not.toContain("class=\"usage-receipt\"");
    expect(markup).not.toContain("input ·");
  });

  it("shows complete agent outputs and per-component usage inside Answer details", () => {
    const completeOutput = `Opening evidence. ${"Full analysis sentence. ".repeat(120)} Closing evidence.`;
    const markup = renderToStaticMarkup(createElement(RunDetailsSheet, {
      run: {
        status: "completed",
        plan: { routing: { selected: [] } },
        expert_outputs: [{
          step_id: "step_research",
          adapter: "research_agent",
          task: "Research the request",
          domain_answer: completeOutput,
          token_usage: { reported: true, prompt_tokens: 500, completion_tokens: 700, total_tokens: 1200, charged_credits: "0.1" }
        }],
        sources: [],
        outcome_contracts: [],
        events: [],
        usage_receipt: {
          provider_reported: true,
          prompt_tokens: 900,
          completion_tokens: 1000,
          total_tokens: 1900,
          charged_credits: "0.2",
          components: [
            { component_key: "router", component: "session_controller_planning", kind: "router", prompt_tokens: 100, completion_tokens: 50, total_tokens: 150, charged_credits: "0.01" },
            { component_key: "agent", component: "agent:research_agent:call_1", kind: "agent", agent_id: "research_agent", step_id: "step_research", prompt_tokens: 500, completion_tokens: 700, total_tokens: 1200, charged_credits: "0.1" },
            { component_key: "final", component: "final_synthesis", kind: "final_output", prompt_tokens: 300, completion_tokens: 250, total_tokens: 550, charged_credits: "0.09" }
          ]
        }
      },
      agents: [{ id: "research_agent", title: "Research Agent" }],
      contractsById: {},
      canWrite: true,
      onClose: () => undefined,
      onCreateOutcome: () => undefined,
      onSettleOutcome: () => undefined,
      onDisputeOutcome: () => undefined,
      onCorrectOutcome: () => undefined
    }));
    expect(markup).toContain("Agents and model usage");
    expect(markup).toContain("Router");
    expect(markup).toContain("Final answer");
    expect(markup).toContain("Agent result");
    expect(markup).toContain("Opening evidence");
    expect(markup).toContain("Closing evidence");
  });

  it("progressively reveals new answers while server rendering and reduced motion retain the full text", () => {
    expect(progressiveRevealPlan(40)).toMatchObject({ charactersPerFrame: 1 });
    expect(progressiveRevealPlan(12000).charactersPerFrame).toBeGreaterThan(1);
    const markup = renderToStaticMarkup(createElement(ProgressiveFormattedText, {
      text: "**Complete answer** remains accessible.",
      active: true
    }));
    expect(markup).toContain("<strong>Complete answer</strong>");
    expect(markup).toContain("remains accessible");
  });

  it("lists agent and final outputs explicitly when provider usage is missing", () => {
    const markup = renderToStaticMarkup(createElement(UsageReceipt, {
      agents: [{ id: "writer_agent", title: "Writer Agent" }],
      expertOutputs: [{ id: "step_writer", adapter: "writer_agent", token_usage: { reported: false } }],
      includeFinalOutput: true,
      receipt: {
        provider_reported: true,
        complete: false,
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120,
        charged_credits: "0.014",
        balance_after_credits: "99.986",
        components: [{
          component_key: "router",
          component: "session_controller_planning",
          kind: "router",
          prompt_tokens: 100,
          completion_tokens: 20,
          total_tokens: 120,
          charged_credits: "0.014"
        }]
      }
    }));
    expect(markup).toContain("Writer Agent");
    expect(markup).toContain("Final answer");
    expect(markup.match(/Not reported/g)).toHaveLength(2);
    expect(markup).toContain("Provider token usage was not reported for this output");
  });

  it("shows a reviewable workflow graph with agent provenance and connection consent", () => {
    const markup = renderToStaticMarkup(createElement(WorkflowDraftCard, {
      workflow: {
        workflow_id: "workflow_ui",
        mode: "workflow",
        title: "Customer reply workflow",
        status: "awaiting_confirmation",
        nodes: [
          { id: "trigger", type: "trigger", title: "New email", source: "system", status: "ready" },
          { id: "support", type: "agent", title: "Support Agent", source: "workspace", status: "blocked_connection", tools: ["web_search"] },
          { id: "inventory", type: "agent", title: "Inventory Agent", source: "marketplace", publisher: "maker", status: "blocked_connection" },
          { id: "writer", type: "agent", title: "Reply Writer", source: "generated", status: "ready" }
        ],
        edges: [
          { source: "trigger", target: "support" },
          { source: "support", target: "inventory" },
          { source: "inventory", target: "writer" }
        ],
        connection_requirements: [{
          provider_id: "gmail",
          name: "Gmail",
          reason: "Read relevant messages and save drafts.",
          connection_mode: "managed",
          status: "missing"
        }],
        permissions: ["Read relevant email and create drafts; do not send automatically."],
        safety: ["Require human review before sending."]
      },
      connections: [{
        connection_id: "mcpconn_personal_gmail",
        name: "Personal Gmail",
        provider_id: "gmail",
        template_id: "gmail",
        connection_mode: "managed",
        status: "ready"
      }, {
        connection_id: "mcpconn_old_gmail",
        name: "Old Gmail",
        provider_id: "gmail",
        template_id: "gmail",
        connection_mode: "managed",
        status: "reauthorization_required"
      }]
    }));

    expect(markup).toContain("AUTO-COMPOSER");
    expect(markup).toContain("Proposed workflow handoff graph");
    expect(markup).toContain("Your workspace");
    expect(markup).toContain("Marketplace · maker");
    expect(markup).toContain("New private agent");
    expect(markup).toContain("Tools: Web search");
    expect(markup).toContain("Approve plan first");
    expect(markup).not.toContain("Use Personal Gmail");
    expect(markup).not.toContain("Reconnect Old Gmail");
    expect(markup).not.toContain("Connect another");
    expect(markup).toContain("Review permissions and safety");
    expect(markup).toContain("Approve plan");
    expect(markup).not.toContain("Send automatically");

    const approvedMarkup = renderToStaticMarkup(createElement(WorkflowDraftCard, {
      workflow: {
        workflow_id: "workflow_ui_approved",
        mode: "workflow",
        title: "Approved connection selection",
        status: "awaiting_connections",
        approved_at: "2026-07-15T00:00:00.000Z",
        nodes: [{ id: "mail", type: "agent", title: "Mail Reader", source: "generated", status: "blocked_connection" }],
        edges: [],
        connection_requirements: [{
          provider_id: "gmail",
          name: "Gmail",
          reason: "Read relevant messages.",
          connection_mode: "managed",
          status: "missing"
        }],
        permissions: [],
        safety: []
      },
      connections: [{
        connection_id: "mcpconn_personal_gmail",
        name: "Personal Gmail",
        provider_id: "gmail",
        template_id: "gmail",
        connection_mode: "managed",
        status: "ready"
      }, {
        connection_id: "mcpconn_old_gmail",
        name: "Old Gmail",
        provider_id: "gmail",
        template_id: "gmail",
        connection_mode: "managed",
        status: "reauthorization_required"
      }]
    }));
    expect(approvedMarkup).toContain("Use Personal Gmail");
    expect(approvedMarkup).toContain("Reconnect Old Gmail");
  });

  it("offers only compatible ready accounts for a workflow connection requirement", () => {
    const connections = [
      { connection_id: "gmail_ready", name: "Work Gmail", provider_id: "gmail", template_id: "gmail", connection_mode: "managed", status: "ready" },
      { connection_id: "gmail_stale", name: "Old Gmail", provider_id: "gmail", template_id: "gmail", connection_mode: "managed", status: "error" },
      { connection_id: "custom_salesforce", name: "Salesforce production", provider_id: "custom", template_id: "custom", connection_mode: "custom", status: "ready" },
      { connection_id: "custom_fake_gmail", name: "Gmail exporter", provider_id: "custom", template_id: "custom", connection_mode: "custom", status: "ready" }
    ];
    expect(workflowRequirementConnections({ provider_id: "gmail", connection_mode: "managed" }, connections)
      .map((connection) => connection.connection_id)).toEqual(["gmail_ready"]);
    expect(workflowRequirementConnections({ provider_id: "salesforce", connection_mode: "custom" }, connections)
      .map((connection) => connection.connection_id)).toEqual(["custom_salesforce"]);
  });

  it("keeps an interrupted tool continuation visibly recoverable", () => {
    const markup = renderToStaticMarkup(createElement(ToolApprovalCheckpoint, {
      checkpoint: {
        checkpoint_id: "checkpoint_ui",
        status: "resuming"
      }
    }));
    expect(markup).toContain("The decision is saved");
    expect(markup).toContain("recover it here after a restart");
    expect(markup).toContain("Resume now");
  });

  it("presents an API-first homepage without adapter product language", () => {
    const markup = renderToStaticMarkup(createElement(LandingPage, { onEnter: () => undefined }));
    expect(markup).toContain("MODEL APIS");
    expect(markup).toContain("Switch providers, not the workflow.");
    expect(markup).not.toMatch(/LoRA/i);
  });

  it("makes managed account authorization primary and keeps endpoint/token fields behind Custom MCP", () => {
    const markup = renderToStaticMarkup(createElement(ConnectionsPanel, {
      connections: [],
      templates: [
        {
          id: "gmail",
          name: "Gmail",
          description: "Search mail and create drafts.",
          category: "Communication",
          connection_mode: "managed",
          auth_type: "oauth2",
          availability: "available",
          availability_message: "Connect with Google",
          connect_label: "Connect Gmail",
          permissions_summary: "Read relevant mail and create drafts.",
          preview: true
        },
        {
          id: "notion",
          name: "Notion",
          description: "Search granted workspace pages.",
          category: "Knowledge & files",
          connection_mode: "managed",
          auth_type: "oauth2",
          availability: "available",
          availability_message: "Sign in with Notion.",
          connect_label: "Connect Notion",
          setup_mode: "automatic",
          permissions_summary: "Use only the Notion pages you grant."
        },
        {
          id: "slack",
          name: "Slack",
          description: "Search workspace conversations.",
          category: "Communication",
          connection_mode: "managed",
          auth_type: "oauth2",
          availability: "setup_required",
          availability_message: "An administrator must configure Slack OAuth.",
          connect_label: "Connect Slack",
          permissions_summary: "Posting remains approval-gated."
        },
        {
          id: "custom",
          name: "Custom HTTPS",
          description: "Connect a server you administer.",
          connection_mode: "custom",
          auth_type: "none",
          endpoint_placeholder: "https://mcp.example.com/mcp"
        }
      ],
      approvals: [],
      canWrite: true,
      onRefresh: async () => undefined
    }));
    expect(markup).toContain("Connect your accounts");
    expect(markup).toContain("Connect Gmail");
    expect(markup).toContain("Connect Notion");
    expect(markup).toContain("Instant setup");
    expect(markup).toContain("Admin setup");
    expect(markup).toContain("Posting remains approval-gated");
    expect(markup).toContain("No endpoints or tokens to copy");
    expect(markup).toContain("Custom MCP");
    expect(markup).not.toContain("HTTPS endpoint");
    expect(markup).not.toContain("Bearer token");
  });

  it("distinguishes agent bubbles by color without embedding icons", () => {
    const markup = renderToStaticMarkup(createElement(AgentGraph, {
      agents: [
        { id: "research_agent", title: "Legacy LoRA Research", capability: "Uses an adapter model", enabled: true },
        { id: "finance_agent", title: "Finance agent", enabled: true }
      ],
      storageKey: ""
    }));
    const graphButtons = [...markup.matchAll(/<button[^>]*class="graph-node tone-[^"]*"[^>]*>(.*?)<\/button>/g)];

    expect(graphButtons).toHaveLength(2);
    expect(new Set(graphButtons.map((match) => match[0].match(/tone-\d/)?.[0])).size).toBe(2);
    expect(graphButtons.every((match) => !match[1].includes("<svg"))).toBe(true);
    expect(markup).toContain("Connect agents");
    expect(markup).toContain('preserveAspectRatio="none"');
    expect(markup).not.toMatch(/LoRA|adapter model/i);
  });

  it("keeps the complete active API-agent catalog available to the session picker", () => {
    const specialists = Array.from({ length: 9 }, (_, index) => ({
      id: `specialist_${index}`,
      item_type: "agent",
      enabled: true,
      mounted: true,
      session_active: index !== 8
    }));
    const available = availableSessionAgents([
      ...specialists,
      { id: "ordinary_agent", item_type: "agent", enabled: true, mounted: true },
      { id: "archived_agent", item_type: "agent", enabled: false, mounted: true },
      { id: "api_agent_with_legacy_mount_flag", item_type: "agent", enabled: true, mounted: false },
      { id: "runtime_adoption_only", item_type: "agent", enabled: true, mounted: true, runtime_only: true },
      { id: "workflow_setup_pending", item_type: "agent", enabled: true, mounted: true, runtime_sync_pending: true },
      { id: "document_agent", item_type: "agent", enabled: true, mounted: true, document: { source: "fixture" } }
    ]);

    expect(available).toHaveLength(11);
    expect(available.filter((agent) => agent.session_active !== false)).toHaveLength(10);
  });

  it("builds directed handoff/knowledge edges and bounded large-graph positions", () => {
    const agents = [
      { id: "source_agent", resources: [], consumes: [] },
      { id: "handoff_agent", resources: [], consumes: ["agent:source_agent:output"] },
      { id: "knowledge_agent", resources: ["agent:source_agent"], consumes: [] }
    ];
    expect(graphConnections(agents)).toEqual([
      { from: "source_agent", to: "handoff_agent", kind: "handoff" },
      { from: "source_agent", to: "knowledge_agent", kind: "knowledge" }
    ]);

    const positions = initialGraphPositions(Array.from({ length: 120 }, (_, index) => ({ id: `node_${index}` })));
    expect(Object.values(positions)).toHaveLength(120);
    for (const position of Object.values(positions)) {
      expect(position.x).toBeGreaterThanOrEqual(64);
      expect(position.x).toBeLessThanOrEqual(836);
      expect(position.y).toBeGreaterThanOrEqual(44);
      expect(position.y).toBeLessThanOrEqual(516);
    }
  });

  it("adds and removes persisted agent handoff inputs without disturbing other context", () => {
    const existing = ["user_request", "shared_memory"];
    expect(graphConnectionInputs(existing, "research_agent", true)).toEqual([
      "user_request",
      "shared_memory",
      "agent:research_agent:output"
    ]);
    expect(graphConnectionInputs(
      [...existing, "agent:research_agent:output"],
      "research_agent",
      false
    )).toEqual(existing);
  });

  it("blocks only graph connections that would introduce a workflow cycle", () => {
    const edges = [
      { from: "research_agent", to: "analysis_agent", kind: "handoff" },
      { from: "analysis_agent", to: "writing_agent", kind: "handoff" }
    ];

    expect(graphConnectionWouldCycle(edges, "writing_agent", "research_agent")).toBe(true);
    expect(graphConnectionWouldCycle(edges, "research_agent", "writing_agent")).toBe(false);
    expect(graphConnectionWouldCycle(edges, "research_agent", "research_agent")).toBe(true);
  });

  it("recomputes connected paths from live drag coordinates", () => {
    const bounds = { left: 100, top: 50, width: 900, height: 560 };
    const originalSource = graphPositionFromPointer(bounds, 200, 150);
    const movedSource = graphPositionFromPointer(bounds, 500, 350);
    const destination = graphPositionFromPointer(bounds, 800, 450);
    const originalPath = graphEdgePath(originalSource, destination);
    const movedPath = graphEdgePath(movedSource, destination);

    expect(originalSource).toEqual({ x: 100, y: 100 });
    expect(movedSource).toEqual({ x: 400, y: 300 });
    expect(movedPath).not.toEqual(originalPath);
    expect(movedPath).toMatch(/^M 400 300 C /);
  });

  it("restores persisted graph positions defensively and clamps unsafe coordinates", () => {
    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => JSON.stringify({
          finance_agent: { x: -500, y: 9000 },
          invalid_agent: { x: "not-a-number", y: 12 }
        })
      }
    });

    expect(storedGraphPositions("workspace-graph")).toEqual({
      finance_agent: { x: 64, y: 516 }
    });
  });

  it("keeps publishing in the Agent flow and makes Marketplace inspectable and copyable", () => {
    const item = {
      id: "shared_research_agent",
      listing_id: "listing_shared",
      title: "Research briefing agent",
      capability: "Creates clear research briefs.",
      description: "A shared agent for concise research briefs.",
      publisher: { user_id: "alice" },
      published_by: "alice",
      rating_average: 4.5,
      rating_count: 2,
      my_rating: null,
      workspace_copy: null,
      agent: {
        capability: "Creates clear research briefs.",
        boundary: "Separate facts from open questions.",
        consumes: ["user_request"],
        produces: ["research_brief"],
        routing_cues: ["research brief"],
        tools: ["web_search"],
        exclusions: { private_knowledge: true, agent_connections: false }
      }
    };
    const marketplaceMarkup = renderToStaticMarkup(createElement(MarketplacePanel, {
      items: [item],
      auth: { user_id: "bob", workspace_id: "workspace_b" }
    }));
    expect(marketplaceMarkup).toContain("Published by alice");
    expect(marketplaceMarkup).toContain("Rate");
    expect(marketplaceMarkup).not.toContain("Share your work");
    expect(marketplaceMarkup).not.toMatch(/Achievements|Proof links|License/);

    const publishMarkup = renderToStaticMarkup(createElement(PublishDialog, {
      agent: { id: "owned_agent", title: "Owned agent", capability: "Helps with planning." },
      onClose: () => undefined,
      onSaved: () => undefined
    }));
    expect(publishMarkup).toContain("Agent description");
    expect(publishMarkup).not.toMatch(/Achievements|Proof links|Version|License/);

    const detailMarkup = renderToStaticMarkup(createElement(MarketplaceAgentDialog, {
      item,
      auth: { user_id: "bob", workspace_id: "workspace_b" },
      onClose: () => undefined,
      onRate: () => undefined,
      onCopied: () => undefined
    }));
    expect(detailMarkup).toContain("Purpose and instructions");
    expect(detailMarkup).toContain("Copy to my workspace");
    expect(detailMarkup).toContain("Published by alice");

    const ratingMarkup = renderToStaticMarkup(createElement(RatingDialog, {
      item,
      onClose: () => undefined,
      onSaved: () => undefined
    }));
    expect(ratingMarkup).toContain("Your rating");
    expect(ratingMarkup).not.toContain("<textarea");

    const ownItem = {
      ...item,
      publisher: { user_id: "alice" },
      published_by: "alice",
      is_self_published: true,
      can_manage: true
    };
    const ownMarketplaceMarkup = renderToStaticMarkup(createElement(MarketplacePanel, {
      items: [ownItem],
      auth: { user_id: "alice", workspace_id: "workspace_a" }
    }));
    expect(ownMarketplaceMarkup).toContain("Your listing");
    expect(ownMarketplaceMarkup).not.toContain(">Rate<");

    const ownDetailMarkup = renderToStaticMarkup(createElement(MarketplaceAgentDialog, {
      item: ownItem,
      auth: { user_id: "alice", workspace_id: "workspace_a" },
      onClose: () => undefined,
      onRate: () => undefined,
      onCopied: () => undefined,
      onEditDescription: () => undefined,
      onUnpublish: () => undefined
    }));
    expect(ownDetailMarkup).toContain("Edit description");
    expect(ownDetailMarkup).toContain("Unpublish");
    expect(ownDetailMarkup).toContain("Your listing");
    expect(ownDetailMarkup).not.toContain(">Rate<");

    const catalogMarkup = renderToStaticMarkup(createElement(AgentCatalog, {
      agents: [
        {
          id: "alice_published_agent",
          title: "Published agent",
          capability: "A published agent.",
          enabled: true,
          visibility: "private",
          created_by: "alice",
          workspace_id: "workspace_a",
          marketplace: { published: true }
        },
        {
          id: "alice_archived_agent",
          title: "Archived agent",
          capability: "An archived agent.",
          enabled: false,
          visibility: "private",
          created_by: "alice",
          workspace_id: "workspace_a"
        }
      ],
      auth: { user_id: "alice", workspace_id: "workspace_a" },
      sessionId: "session_a",
      togglingAgentId: "",
      onCreate: () => undefined,
      onEdit: () => undefined,
      onAdopt: () => undefined,
      onArchive: () => undefined,
      onDelete: () => undefined,
      onToggle: () => undefined,
      onPublish: () => undefined,
      onUnpublish: () => undefined
    }));
    expect(catalogMarkup).toContain("Edit description");
    expect(catalogMarkup).toContain("Unpublish");
    expect(catalogMarkup).toContain("Permanently delete Archived agent");
  });
});

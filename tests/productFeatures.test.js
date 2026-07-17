import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  AgentCatalog,
  AgentGraph,
  ApprovalArguments,
  ConnectionsPanel,
  CustomMcpDialog,
  ChatMessage,
  Composer,
  EmptyTeamWelcome,
  FormattedText,
  ProgressiveFormattedText,
  MarketplaceAgentDialog,
  MarketplaceDetailFailure,
  MarketplaceWorkspaceAgentDetails,
  MarketplacePanel,
  KnowledgeDocumentDialog,
  KnowledgeList,
  PublishDialog,
  RatingDialog,
  RunDetailsSheet,
  RunProgress,
  RunReceipt,
  ToolApprovalCheckpoint,
  UsageReceipt,
  WorldGraphChanges,
  WorkflowDraftCard,
  agentPayloadFromForm,
  approvalActivityPresentation,
  agentsForWorkspace,
  availableSessionAgents,
  graphConnectionInputs,
  graphConnectionWouldCycle,
  graphConnections,
  graphEdgeEndpoints,
  graphEdgePath,
  graphPositionForCanvas,
  graphPositionFromPointer,
  initialGraphPositions,
  mergeLiveRunEvent,
  marketplaceDetailActionsDisabled,
  progressiveRevealPlan,
  responseStyleFromBoundary,
  runProgressGraph,
  runProgressSpecialists,
  settleConnectionApproval,
  storedGraphPositions,
  unavailableCollaboratorHandoffs,
  workflowProposedNewSpecialists,
  workflowWorkspaceHasCapacity,
  worldGraphChangeCounts,
  worldGraphAgentStatuses,
  worldGraphPlainReason,
  worldGraphUniqueWakeSpecialists,
  workflowRunRequest,
  workflowRequirementConnections
} from "../src/App.jsx";
import LandingPage from "../src/LandingPage.jsx";


afterEach(() => {
  vi.unstubAllGlobals();
});


describe("Agent Studio product surfaces", () => {
  it("describes denied and uncertain app actions without calling them approved", () => {
    expect(approvalActivityPresentation("denied")).toMatchObject({
      label: "Declined · nothing ran",
      icon: "deny"
    });
    expect(approvalActivityPresentation("execution_outcome_uncertain")).toMatchObject({
      label: "Needs provider verification",
      icon: "warning"
    });
  });

  it("refreshes the saved conversation after an app approval continues it", async () => {
    const order = [];
    const client = {
      post: vi.fn(async (path, body) => {
        order.push("decision");
        expect(path).toBe("/api/mcp/approvals/approval_1");
        expect(body).toEqual({ decision: "approve" });
      })
    };

    await settleConnectionApproval({
      approvalId: "approval_1",
      decision: "approve",
      client,
      onRefresh: async () => { order.push("resources"); },
      onRefreshConversation: async () => { order.push("conversation"); }
    });

    expect(order).toEqual(["decision", "resources", "conversation"]);
  });

  it("keeps live Router assignments safe, current, and deduplicated", () => {
    const planning = mergeLiveRunEvent({ run_id: "run_live", status: "queued", events: [] }, {
      type: "planner.completed",
      at: "2026-07-16T10:00:00.000Z",
      steps: [
        {
          id: "s1",
          adapter: "renault_specialist",
          task: "Summarize Renault and identify the details needed by the idea specialist.",
          depends_on: [],
          internal_note: "must never become part of the safe plan"
        },
        {
          id: "s2",
          adapter: "idea_specialist",
          task: "Combine the Renault and Python findings into a practical business idea.",
          depends_on: ["s1"]
        }
      ],
      agent_reasoning: "hidden chain of thought"
    });
    const duplicate = mergeLiveRunEvent(planning, {
      type: "planner.completed",
      steps: planning.plan.steps
    });
    const working = mergeLiveRunEvent(duplicate, {
      type: "route.started",
      step_id: "s1",
      adapter: "renault_specialist"
    });

    expect(working.status).toBe("running");
    expect(working.events).toHaveLength(2);
    expect(working.plan.steps[0]).toEqual({
      id: "s1",
      adapter: "renault_specialist",
      task: "Summarize Renault and identify the details needed by the idea specialist.",
      depends_on: []
    });
    expect(JSON.stringify(working.plan)).not.toContain("hidden chain of thought");
    expect(JSON.stringify(working.plan)).not.toContain("internal_note");
    expect(JSON.stringify(working)).not.toContain("hidden chain of thought");
    expect(JSON.stringify(working)).not.toContain("internal_note");
  });

  it("shows selected and active specialists in a compact accessible status list", () => {
    const run = {
      status: "running",
      plan: {
        steps: [
          { id: "s1", adapter: "renault_specialist", task: "Review the Renault context.", depends_on: [] },
          { id: "s2", adapter: "idea_specialist", task: "Create the combined idea.", depends_on: ["s1"] }
        ]
      },
      events: [
        { type: "planner.completed" },
        { type: "route.completed", step_id: "s1", adapter: "renault_specialist" },
        { type: "route.started", step_id: "s2", adapter: "idea_specialist" }
      ]
    };
    const agents = [
      { id: "renault_specialist", title: "Renault Specialist" },
      { id: "idea_specialist", title: "Business Idea Specialist" }
    ];

    expect(runProgressSpecialists(run, agents)).toMatchObject([
      { name: "Renault Specialist", state: "ready", dependencies: [] },
      { name: "Business Idea Specialist", state: "working", dependencies: ["Renault Specialist"] }
    ]);
    const graph = runProgressGraph(run, agents);
    expect(graph).toMatchObject({
      agentCount: 2,
      activeAgentCount: 1,
      finishedCount: 1
    });
    expect(graph.nodes.map((node) => ({ id: node.id, level: node.level, state: node.state }))).toEqual([
      { id: "s1", level: 0, state: "ready" },
      { id: "s2", level: 1, state: "working" }
    ]);
    expect(graph.edges).toEqual([expect.objectContaining({ from: "s1", to: "s2" })]);

    const markup = renderToStaticMarkup(createElement(RunProgress, { run, agents }));
    expect(markup).toContain("1 working · 2 selected");
    expect(markup).toContain("Renault Specialist");
    expect(markup).toContain("Business Idea Specialist");
    expect(markup).toContain("Working");
    expect(markup).toContain("Done");
    expect(markup).toContain("run-progress-agents");
    expect(markup).toContain('role="list"');
    expect(markup).toContain('role="listitem"');
    expect(markup).toContain("Working after Renault Specialist");
    expect(markup).toContain("Private model reasoning is not displayed");
    expect(markup).not.toContain("Why selected:");
    expect(markup).not.toContain("Receives work from");
    expect(markup).not.toContain("Review the Renault context");
    expect(markup).not.toContain("Create the combined idea");
    expect(markup).not.toContain("hidden chain of thought");

    const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
    const progressStyles = styles.match(/\.run-progress\s*\{([\s\S]*?)\}/)?.[1] || "";
    expect(progressStyles).not.toContain("border:");
    expect(progressStyles).not.toContain("background:");
    expect(styles).toContain(".run-progress-agents");
    expect(styles).not.toContain(".run-progress-dag");
  });

  it("keeps pre-plan Router progress minimal and screen-reader friendly", () => {
    const markup = renderToStaticMarkup(createElement(RunProgress, {
      run: { status: "planning", events: [{ type: "planner.started" }] },
      agents: []
    }));
    expect(markup).toContain("Selecting specialists");
    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).not.toContain("Choosing the right teammates");
    expect(markup).not.toContain("matching your request");
    expect(markup).not.toContain("Request read");
    expect(markup).not.toContain("Roles matched");
  });

  it("shows when the Router intentionally selects no specialists", () => {
    const markup = renderToStaticMarkup(createElement(RunProgress, {
      run: { status: "running", plan: { steps: [] }, events: [{ type: "planner.completed", steps: [] }] },
      agents: []
    }));
    expect(markup).toContain("Answering directly");
    expect(markup).not.toContain("Selecting specialists");
  });

  it("requires enough open team places for a proposed workflow", () => {
    expect(workflowWorkspaceHasCapacity({ agent_count: 13, max_agents: 16 }, 3)).toBe(true);
    expect(workflowWorkspaceHasCapacity({ agent_count: 14, max_agents: 16 }, 3)).toBe(false);
    expect(workflowWorkspaceHasCapacity({ agent_count: 16, max_agents: 16 }, 1)).toBe(false);
    expect(workflowWorkspaceHasCapacity({ agent_count: 15, max_agents: 16 }, 1)).toBe(true);
  });

  it("checks workflow capacity from the specialists the draft will really add", () => {
    const workflow = {
      agent_workspace_id: "team_a",
      nodes: [
        { id: "reuse", type: "agent", source: "workspace", agent_id: "writer", new_specialist_required: false },
        { id: "scoped", type: "agent", source: "workspace", agent_id: "researcher", new_specialist_required: true },
        { id: "generated", type: "agent", source: "generated" }
      ]
    };
    expect(workflowProposedNewSpecialists(workflow, {
      agent_workspace_id: "team_a",
      agent_ids: ["writer", "researcher"]
    })).toBe(2);
    expect(workflowProposedNewSpecialists(workflow, {
      agent_workspace_id: "team_b",
      agent_ids: []
    })).toBe(3);
  });

  it("keeps every saved teammate handoff visible unless its teammate is truly unavailable", () => {
    const collaborators = Array.from({ length: 30 }, (_, index) => ({ id: `specialist_${index}` }));
    expect(unavailableCollaboratorHandoffs([
      "user_request",
      "agent:specialist_29:output",
      "agent:removed_specialist:output"
    ], collaborators)).toEqual(["agent:removed_specialist:output"]);
  });

  it("runs an approved workflow through routing metadata without leaking internal IDs into chat", () => {
    const request = workflowRunRequest({
      intent: "Prepare a customer-support handoff.",
      activation: {
        node_agents: [
          { node_id: "n1", agent_id: "custom_support_4f91" },
          { node_id: "n2", agent_id: "inventory_82bd" },
          { node_id: "n3", agent_id: "custom_support_4f91" }
        ]
      }
    });

    expect(request).toEqual({
      content: "Prepare a customer-support handoff.",
      requestedAgentIds: ["custom_support_4f91", "inventory_82bd"]
    });
    expect(request.content).not.toContain("@custom_support_4f91");
    expect(request.content).not.toContain("inventory_82bd");
  });

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

  it("layers response preference onto custom guardrails without destroying either", () => {
    const payload = agentPayloadFromForm({
      item_type: "agent",
      title: "Policy writer",
      capability: "Write from approved policy.",
      boundary: "Never invent an exception to the supplied policy.",
      response_style: "direct",
      consumes: ["user_request"],
      produces: ["final_answer"],
      tools: [],
      resources: [],
      mcp_bindings: []
    });
    expect(payload.boundary).toContain("Lead with the useful answer");
    expect(payload.boundary).toContain("Additional role-specific guardrails:");
    expect(payload.boundary).toContain("Never invent an exception");
    expect(responseStyleFromBoundary(payload.boundary)).toEqual({
      response_style: "direct",
      boundary: "Never invent an exception to the supplied policy."
    });
    expect(responseStyleFromBoundary("Lead with the useful answer, keep it concise, stay within this agent's purpose, and state uncertainty when it matters.")).toEqual({
      response_style: "direct",
      boundary: ""
    });
    expect(responseStyleFromBoundary("A completely custom boundary.")).toEqual({
      response_style: "custom",
      boundary: "A completely custom boundary."
    });
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
    expect(markup).toContain("2 specialists · 2.4s · 2,500 tokens");
    expect(markup).toContain("Open Answer details, token usage, and complete specialist results");
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
    expect(markup).toContain("1 specialist · 1.8s · 840 tokens");
    expect(markup).toContain('aria-label="Run this prompt again"');
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
    expect(markup).toContain("Specialist outputs");
    expect(markup).toContain("Run summary");
    expect(markup).toContain("Router");
    expect(markup).toContain("Final answer");
    expect(markup).toContain("Specialist result");
    expect(markup).toContain("Opening evidence");
    expect(markup).toContain("Closing evidence");
    expect(markup).toContain("Model usage");
    expect(markup.indexOf("Specialist result")).toBeLessThan(markup.indexOf("Run summary"));
    expect(markup.indexOf("Run summary")).toBeLessThan(markup.indexOf('class="usage-receipt"'));
  });

  it("keeps work-reuse evidence inside Team and exposes Activity only to admins", () => {
    const run = {
      run_id: "run_answer_details_team",
      status: "completed",
      plan: {
        steps: [{ id: "research", adapter: "research_agent", task: "Research the request", depends_on: [] }],
        routing: { selected: [] }
      },
      expert_outputs: [{ step_id: "research", adapter: "research_agent", domain_answer: "Complete result." }],
      sources: [{ title: "Reference" }],
      outcome_contracts: [],
      events: [{ type: "run.started", at: "2026-01-01T00:00:00.000Z" }],
      world_graph: {
        validity: "unchecked",
        total: 1,
        decisions: [{
          step_id: "research",
          adapter: "research_agent",
          action: "refreshed",
          reason: "no_matching_result"
        }]
      }
    };
    const commonProps = {
      run,
      agents: [{ id: "research_agent", title: "Research Agent" }],
      contractsById: {},
      canWrite: true,
      onClose: () => undefined,
      onCreateOutcome: () => undefined,
      onSettleOutcome: () => undefined,
      onDisputeOutcome: () => undefined,
      onCorrectOutcome: () => undefined,
      onRefreshTracked: () => undefined,
      onRunFresh: () => undefined
    };
    const standardMarkup = renderToStaticMarkup(createElement(RunDetailsSheet, commonProps));
    const adminMarkup = renderToStaticMarkup(createElement(RunDetailsSheet, { ...commonProps, isAdmin: true }));

    expect(standardMarkup).toContain('class="view-switch" role="group" aria-label="Answer detail view"');
    expect(standardMarkup).toContain(">Team</button>");
    expect(standardMarkup).toContain(">Sources</button>");
    expect(standardMarkup).toContain(">Results</button>");
    expect(standardMarkup).not.toContain(">What changed</button>");
    expect(standardMarkup).not.toContain(">Activity</button>");
    expect(standardMarkup).toContain("Specialist outputs");
    expect(standardMarkup).toContain("Run summary");
    expect(standardMarkup).toContain("Work summary");
    expect(standardMarkup).not.toMatch(/WorldGraph/i);
    expect(standardMarkup).toContain('class="detail-section world-changes embedded" role="region"');
    expect(standardMarkup.indexOf("Complete result.")).toBeLessThan(standardMarkup.indexOf("Run summary"));
    expect(standardMarkup.indexOf("Run summary")).toBeLessThan(standardMarkup.indexOf("Work summary"));
    expect(adminMarkup).toContain('class="view-switch four-up"');
    expect(adminMarkup).toContain(">Activity</button>");
    expect(adminMarkup).not.toContain(">What changed</button>");
  });

  it("shows a completed unchecked change record without falsely calling it current", () => {
    const markup = renderToStaticMarkup(createElement(WorldGraphChanges, {
      run: {
        run_id: "run_recorded",
        status: "completed",
        plan: { steps: [{ id: "s1", adapter: "research_agent", task: "Research", depends_on: [] }] },
        world_graph: {
          validity: "unchecked",
          total: 1,
          kept: 1,
          refreshed: 0,
          decisions: [{
            step_id: "s1",
            adapter: "research_agent",
            action: "kept",
            plain_reason: "Its inputs were unchanged when this answer ran."
          }]
        }
      },
      agents: [{ id: "research_agent", title: "Research Agent" }],
      canWrite: true
    }));
    expect(markup).toContain("Work reuse summary");
    expect(markup).not.toMatch(/WorldGraph/i);
    expect(markup).toContain("Check what changed");
    expect(markup).not.toContain("This answer is current");
  });

  it("shows the safe WorldGraph exclusion reason when earlier work could not be reused", () => {
    const markup = renderToStaticMarkup(createElement(WorldGraphChanges, {
      run: {
        run_id: "run_reuse_unavailable",
        status: "completed",
        plan: { steps: [{ id: "s1", adapter: "research_agent", task: "Research", depends_on: [] }] },
        world_graph: {
          validity: "unchecked",
          total: 1,
          kept: 0,
          refreshed: 1,
          preparation: {
            status: "disabled",
            capsule_created: false,
            primary_reason: "replay_signing_unavailable",
            plain_reason: "Verified reuse was unavailable, so the work was checked again."
          },
          decisions: [{
            step_id: "s1",
            adapter: "research_agent",
            action: "refreshed",
            plain_reason: "Verified reuse was unavailable, so the work was checked again."
          }]
        }
      },
      agents: [{ id: "research_agent", title: "Research Agent" }],
      canWrite: true
    }));

    expect(markup).toContain("Why earlier work was not available");
    expect(markup).toContain("Verified reuse was unavailable, so the work was checked again.");
    expect(markup).not.toContain("artifact_id");
  });

  it("describes WorldGraph decisions as work items when one agent owns multiple steps", () => {
    const run = {
      run_id: "run_duplicate_agent_steps",
      status: "completed",
      plan: {
        steps: [
          { id: "draft", adapter: "writer_agent", task: "Draft the answer", depends_on: [] },
          { id: "revise", adapter: "writer_agent", task: "Revise the answer", depends_on: ["draft"] }
        ]
      },
      world_graph: {
        validity: "unchecked",
        total: 2,
        kept: 99,
        refreshed: 99,
        decisions: [
          { step_id: "draft", adapter: "writer_agent", action: "kept", plain_reason: "The draft was unchanged." },
          { step_id: "revise", adapter: "writer_agent", action: "refreshed", plain_reason: "The revision changed." }
        ]
      }
    };
    const markup = renderToStaticMarkup(createElement(WorldGraphChanges, {
      run,
      agents: [{ id: "writer_agent", title: "Writer" }],
      canWrite: true
    }));
    const statuses = worldGraphAgentStatuses(run.world_graph.decisions);

    expect(statuses.get("writer_agent")).toEqual({ kept: 1, fresh: 0, refreshed: 1, total: 2, action: "mixed" });
    expect(markup).toContain("reused 1 previous result, checked 1 part again");
    expect(markup).toContain("Assignment: Draft the answer");
    expect(markup).toContain("Assignment: Revise the answer");
    expect(markup).not.toContain("99 agents");
  });

  it("distinguishes a fresh baseline from work that was checked again", () => {
    const decisions = [
      { step_id: "first", adapter: "researcher", action: "refreshed", reason: "no_matching_result" },
      { step_id: "second", adapter: "reviewer", action: "refreshed", reason: "request_changed" }
    ];
    const markup = renderToStaticMarkup(createElement(WorldGraphChanges, {
      run: {
        run_id: "run_fresh_baseline",
        status: "completed",
        plan: { steps: [] },
        world_graph: { validity: "unchecked", total: 2, decisions }
      },
      agents: [],
      canWrite: true
    }));
    expect(worldGraphChangeCounts(decisions)).toEqual({ fresh: 1, rechecked: 1, reused: 0 });
    expect(markup).toContain("Completed fresh now");
    expect(markup).toContain("Checked again now");
    expect(markup).toContain("There was no earlier validated result for this work.");
  });

  it("counts affected specialists uniquely and keeps runtime wording plain", () => {
    expect(worldGraphUniqueWakeSpecialists({ decisions: [
      { step_id: "draft", adapter: "writer", projected_action: "wake" },
      { step_id: "revise", adapter: "writer", projected_action: "wake" },
      { step_id: "facts", adapter: "researcher", projected_action: "keep" }
    ] })).toBe(1);
    expect(worldGraphPlainReason({
      reason: "runtime_revision_changed_or_unverified",
      plain_reason: "The Router runtime revision changed."
    })).toBe("The underlying AI setup changed or could not be verified.");
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

  it("labels a reused agent as zero-call work instead of missing provider usage", () => {
    const markup = renderToStaticMarkup(createElement(UsageReceipt, {
      agents: [{ id: "writer_agent", title: "Writer Agent" }],
      expertOutputs: [{ id: "step_writer", adapter: "writer_agent", execution_mode: "reused", token_usage: {} }],
      receipt: {
        provider_reported: true,
        complete: true,
        prompt_tokens: 60,
        completion_tokens: 15,
        total_tokens: 75,
        charged_credits: "0.01",
        components: [{
          component_key: "final",
          component: "final_synthesis",
          kind: "final_output",
          prompt_tokens: 60,
          completion_tokens: 15,
          total_tokens: 75,
          charged_credits: "0.01"
        }]
      }
    }));
    expect(markup).toContain("Reused from earlier · no specialist model call");
    expect(markup).toContain("0 calls");
    expect(markup).not.toContain("Provider token usage was not reported for this output");
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

    expect(markup).toContain("AUTO COMPOSE · PROPOSED WORKFLOW");
    expect(markup).not.toContain("workflow-card-icon");
    expect(markup).not.toContain("lucide-wand-sparkles");
    expect(markup).toContain("Proposed workflow handoff graph");
    expect(markup).toContain("Already on your team");
    expect(markup).toContain("Marketplace · maker");
    expect(markup).toContain("Created for you");
    expect(markup).toContain("Tools: Web search");
    expect(markup).toContain("Create the team first");
    expect(markup).not.toContain("Use Personal Gmail");
    expect(markup).not.toContain("Reconnect Old Gmail");
    expect(markup).not.toContain("Connect another");
    expect(markup).toContain("Review permissions and safety");
    expect(markup).toContain("Create this workflow");
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

  it("presents the product as an understandable, user-controlled team", () => {
    const markup = renderToStaticMarkup(createElement(LandingPage, { onSignUp: () => undefined }));
    expect(markup).toContain("Build the team");
    expect(markup).toContain("See a team in action");
    expect(markup).toContain("Your team handles the handoffs");
    expect(markup).toContain("YOUR TEAM FIRST");
    expect(markup).not.toContain("MODEL APIS");
    expect(markup).not.toMatch(/Switch providers/i);
    expect(markup).not.toMatch(/3 minute read/i);
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
    expect(markup).toContain("Advanced connection");
    expect(markup).not.toContain("HTTPS endpoint");
    expect(markup).not.toContain("Bearer token");
  });

  it("renders the advanced MCP setup as a focused accessible dialog", () => {
    const markup = renderToStaticMarkup(createElement(CustomMcpDialog, {
      templates: [{
        id: "custom",
        name: "Custom HTTPS",
        description: "Connect a server you administer.",
        connection_mode: "custom",
        auth_type: "bearer",
        endpoint_placeholder: "https://mcp.example.com/mcp"
      }],
      onClose: () => undefined,
      onSaved: async () => undefined
    }));

    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('aria-modal="true"');
    expect(markup).toContain("Connect a custom MCP server");
    expect(markup).toContain("HTTPS endpoint");
    expect(markup).toContain('type="password"');
    expect(markup).toContain("Connect and discover tools");
    expect(markup).toContain("custom-mcp-dialog");
  });

  it("makes each Knowledge file identifiable and opens an authorized review surface", () => {
    const document = {
      document_id: "doc_launch_manual",
      agent_id: "launch_manual_source",
      title: "Launch Manual",
      chunks: 3,
      page_count: 2,
      visibility: "private",
      created_at: "2026-07-16T12:00:00.000Z",
      upload_digest: `sha256:${"a".repeat(64)}`
    };
    const agents = [{ id: "launch_manual_source", title: "Launch Manual source specialist" }];
    const listMarkup = renderToStaticMarkup(createElement(KnowledgeList, {
      documents: [document],
      agents,
      auth: { is_viewer: true },
      canWrite: false,
      onAdd: () => undefined,
      onOpen: () => undefined,
      onDelete: () => undefined
    }));
    expect(listMarkup).toContain('aria-label="Review Launch Manual"');
    expect(listMarkup).toContain("3 indexed sections");
    expect(listMarkup).toContain("Private · All chats");

    const dialogMarkup = renderToStaticMarkup(createElement(KnowledgeDocumentDialog, {
      document,
      agents,
      onClose: () => undefined
    }));
    expect(dialogMarkup).toContain('role="dialog"');
    expect(dialogMarkup).toContain("Indexed and ready");
    expect(dialogMarkup).toContain("2 pages");
    expect(dialogMarkup).toContain("Launch Manual source specialist");
    expect(dialogMarkup).toContain("aaaaaaaa");
    expect(dialogMarkup).toContain("Only people already authorized for this workspace");
    expect(dialogMarkup).toContain("Loading the authorized review");
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
    expect(markup).toContain("Connect teammates");
    expect(markup).toContain('preserveAspectRatio="none"');
    expect(markup).not.toMatch(/LoRA|adapter model/i);
  });

  it("keeps legacy internal specialist ids out of visible catalog, chat, graph, and Marketplace wording", () => {
    const legacyAgent = {
      id: "finance_reasoning_lora",
      title: "Finance LoRA",
      capability: "Uses an adapter model to prepare a bounded briefing.",
      enabled: true,
      session_active: true,
      visibility: "private",
      created_by: "alice",
      workspace_id: "workspace_a"
    };
    const workspace = {
      agent_workspace_id: "team_legacy",
      name: "Briefing team",
      agent_ids: [legacyAgent.id],
      agent_count: 1,
      max_agents: 16
    };
    const marketplaceItem = {
      ...legacyAgent,
      listing_id: "listing_legacy_agent",
      item_type: "agent",
      description: "A LoRA adapter model for briefings.",
      published_by: "alice",
      rating_average: 0,
      rating_count: 0,
      agent: {
        ...legacyAgent,
        consumes: ["user_request"],
        produces: ["briefing"],
        tools: []
      }
    };
    const surfaces = [
      createElement(AgentCatalog, {
        agents: [legacyAgent],
        workspaces: [workspace],
        activeWorkspace: workspace,
        auth: { user_id: "alice", workspace_id: "workspace_a" },
        sessionId: "session_legacy",
        onToggle: () => undefined
      }),
      createElement(Composer, {
        value: "",
        onChange: () => undefined,
        onSubmit: () => undefined,
        agents: [legacyAgent],
        allAgents: [legacyAgent],
        workspaces: [workspace],
        activeWorkspace: workspace,
        sessionId: "session_legacy",
        canWrite: true,
        chatDocuments: [],
        onToggleAgent: () => undefined
      }),
      createElement(AgentGraph, { agents: [legacyAgent], workspace, storageKey: "" }),
      createElement(MarketplacePanel, { items: [marketplaceItem], auth: { user_id: "bob" } }),
      createElement(MarketplaceAgentDialog, {
        item: marketplaceItem,
        auth: { user_id: "bob" },
        onClose: () => undefined,
        onCopied: () => undefined
      }),
      createElement(RunProgress, {
        agents: [legacyAgent],
        run: {
          status: "running",
          plan: { steps: [{ id: "s1", adapter: legacyAgent.id, task: "Prepare a briefing.", depends_on: [] }] },
          events: []
        }
      })
    ];
    const markup = surfaces.map((surface) => renderToStaticMarkup(surface)).join("\n")
      .replaceAll(legacyAgent.id, "internal-specialist-id");

    expect(markup).not.toMatch(/\bLoRA\b|adapter model/i);
    expect(markup).toContain("Finance specialist");
  });

  it("shows mixed per-work-item history without presenting current links as run edges", () => {
    const markup = renderToStaticMarkup(createElement(AgentGraph, {
      agents: [{ id: "writer_agent", title: "Writer", enabled: true }],
      run: {
        status: "completed",
        world_graph: {
          validity: "unchecked",
          total: 2,
          decisions: [
            { step_id: "draft", adapter: "writer_agent", action: "kept" },
            { step_id: "revise", adapter: "writer_agent", action: "refreshed" }
          ]
        }
      },
      storageKey: ""
    }));

    expect(markup).toContain("world-mixed");
    expect(markup).toContain("Latest answer: 1 reused, 1 checked again");
    expect(markup).toContain("1 previous result reused · 1 checked again");
    expect(markup).toContain("The lines below show your saved handoffs.");
  });

  it("locks execution-changing team controls while preserving map inspection and layout", () => {
    const agents = [
      { id: "writer", title: "Writer", capability: "Drafts answers.", enabled: true, visibility: "private", created_by: "alice", workspace_id: "workspace_a" },
      { id: "reviewer", title: "Reviewer", capability: "Reviews drafts.", enabled: true, visibility: "private", created_by: "alice", workspace_id: "workspace_a" }
    ];
    const graphMarkup = renderToStaticMarkup(createElement(AgentGraph, {
      agents,
      auth: { user_id: "alice", workspace_id: "workspace_a" },
      configurationBusy: true,
      storageKey: ""
    }));
    expect(graphMarkup).toContain("This answer is using the current team.");
    expect(graphMarkup).toMatch(/<button[^>]*disabled=""[^>]*title="Available when the current answer finishes"[^>]*>.*Connect teammates/s);
    expect(graphMarkup).toMatch(/<button type="button">.*Auto-arrange/s);
    expect(graphMarkup).toContain('class="graph-node');

    const workspace = { agent_workspace_id: "team_active", name: "Active team", agent_ids: agents.map((agent) => agent.id), agent_count: 2, max_agents: 16 };
    const catalogMarkup = renderToStaticMarkup(createElement(AgentCatalog, {
      agents,
      workspaces: [workspace],
      activeWorkspace: workspace,
      auth: { user_id: "alice", workspace_id: "workspace_a" },
      configurationBusy: true,
      sessionId: "session_active",
      onToggle: () => undefined
    }));
    expect(catalogMarkup).toContain("Team membership and specialist settings unlock when it finishes.");
    expect(catalogMarkup).toMatch(/Archive specialist<\/button>/);
    expect(catalogMarkup).toMatch(/disabled=""[^>]*>.*Archive specialist/s);
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

  it("scopes the composer agent picker and mentions to the currently selected workspace", () => {
    const agents = [
      { id: "first_writer", enabled: true },
      { id: "first_reviewer", enabled: true },
      { id: "second_researcher", enabled: true }
    ];
    const firstWorkspace = { agent_workspace_id: "team_first", agent_ids: ["first_writer", "first_reviewer"] };
    const secondWorkspace = { agent_workspace_id: "team_second", agent_ids: ["second_researcher"] };

    expect(availableSessionAgents(agentsForWorkspace(agents, firstWorkspace)).map((agent) => agent.id)).toEqual([
      "first_writer",
      "first_reviewer"
    ]);
    expect(availableSessionAgents(agentsForWorkspace(agents, secondWorkspace)).map((agent) => agent.id)).toEqual([
      "second_researcher"
    ]);
    expect(agentsForWorkspace(agents, null)).toEqual([]);
  });

  it("combines team switching and per-chat specialist toggles beside the composer", () => {
    const agents = [
      { id: "first_writer", title: "First Writer", capability: "Drafts the current team's response", enabled: true, session_active: true },
      { id: "second_researcher", title: "Second Researcher", capability: "Researches for another team", enabled: true, session_active: true }
    ];
    const firstWorkspace = { agent_workspace_id: "team_first", name: "Writing team", agent_ids: ["first_writer"] };
    const secondWorkspace = { agent_workspace_id: "team_second", name: "Research team", agent_ids: ["second_researcher"] };
    const markup = renderToStaticMarkup(createElement(Composer, {
      value: "",
      onChange: vi.fn(),
      onSubmit: vi.fn(),
      onAttachFile: vi.fn(),
      chatDocuments: [],
      onDeleteChatDocument: vi.fn(),
      agents: agentsForWorkspace(agents, firstWorkspace),
      allAgents: agents,
      workspaces: [firstWorkspace, secondWorkspace],
      activeWorkspace: firstWorkspace,
      sessionId: "session_one",
      canWrite: true,
      focusRequest: 0,
      onOpenAgents: vi.fn(),
      onSelectWorkspace: vi.fn(),
      onToggleAgent: vi.fn(),
      togglingAgentId: ""
    }));

    expect(markup).toContain('class="composer-shell"');
    expect(markup).toMatch(/<\/form><div class="composer-team-picker">/);
    expect(markup).toContain('aria-haspopup="dialog"');
    expect(markup).toContain('role="radiogroup"');
    expect(markup).toContain('role="radio" aria-checked="true"');
    expect(markup).toContain("Writing team");
    expect(markup).toContain("Research team");
    expect(markup).toContain("Drafts the current team&#x27;s response");
    expect(markup).not.toContain("Researches for another team");
    expect(markup).not.toContain("active-team-switcher");
    expect(markup).not.toContain("agent-trigger");
  });

  it("keeps the team picker open while switching teams", () => {
    const appSource = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
    const workspaceSelection = appSource.match(/function chooseWorkspace\([\s\S]*?\n {2}\}/)?.[0] || "";

    expect(workspaceSelection).toContain("onSelectWorkspace?.(workspaceId)");
    expect(workspaceSelection).toContain("configurationBusy");
    expect(workspaceSelection).not.toContain("setAgentMenuOpen(false)");
    expect(workspaceSelection).not.toContain("agentMenuTriggerRef.current?.focus()");
    expect(appSource).toMatch(/\[agentMenuOpen, activeWorkspace\?\.agent_workspace_id, configurationBusy\]/);
    expect(appSource).toContain("aria-busy={configurationBusy || undefined}");
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

  it("keeps configured handoffs visible for valid hyphenated agent ids", () => {
    expect(graphConnections([
      { id: "source-agent", resources: [], consumes: [] },
      { id: "reply-writer", resources: ["agent:source-agent"], consumes: ["agent:source-agent:output"] }
    ])).toEqual([
      { from: "source-agent", to: "reply-writer", kind: "knowledge" },
      { from: "source-agent", to: "reply-writer", kind: "handoff" }
    ]);
  });

  it("uses a collision-free visible grid and discloses agents outside the map limit", () => {
    const visibleAgents = Array.from({ length: 25 }, (_, index) => ({ id: `node_${index}`, title: `Agent ${index}`, enabled: true }));
    const positions = initialGraphPositions(visibleAgents);
    for (let left = 0; left < visibleAgents.length; left += 1) {
      for (let right = left + 1; right < visibleAgents.length; right += 1) {
        const first = positions[visibleAgents[left].id];
        const second = positions[visibleAgents[right].id];
        expect(Math.abs(first.x - second.x) >= 148 || Math.abs(first.y - second.y) >= 60).toBe(true);
      }
    }

    const markup = renderToStaticMarkup(createElement(AgentGraph, {
      agents: [...visibleAgents, ...Array.from({ length: 5 }, (_, index) => ({ id: `hidden_${index}`, title: `Hidden ${index}`, enabled: true }))],
      storageKey: ""
    }));
    expect(markup).toContain("25 of 30 specialists");
    expect(markup).toContain("Handoffs involving hidden specialists are omitted");
    expect(markup.match(/class="graph-node tone-/g)).toHaveLength(25);
  });

  it("does not silently truncate visible graph connections", () => {
    const agents = Array.from({ length: 25 }, (_, index) => ({
      id: `connected_${index}`,
      consumes: Array.from({ length: 25 }, (_, sourceIndex) => sourceIndex)
        .filter((sourceIndex) => sourceIndex !== index)
        .map((sourceIndex) => `agent:connected_${sourceIndex}:output`)
    }));
    const connections = graphConnections(agents);
    expect(connections.length).toBeGreaterThan(240);
    expect(connections).toHaveLength(600);
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
    const endpoints = graphEdgeEndpoints(movedSource, destination);
    expect(movedPath).toMatch(new RegExp(`^M ${endpoints.from.x} ${endpoints.from.y} C `));
    expect(endpoints.from).not.toEqual(movedSource);
    expect(endpoints.to).not.toEqual(destination);
  });

  it("keeps arrow endpoints ordered when graph bubbles overlap", () => {
    const endpoints = graphEdgeEndpoints({ x: 100, y: 100 }, { x: 130, y: 100 }, { halfWidth: 80, halfHeight: 36 });
    expect(endpoints.from.x).toBeLessThan(endpoints.to.x);
    expect(endpoints.from.x).toBeGreaterThanOrEqual(100);
    expect(endpoints.to.x).toBeLessThanOrEqual(130);
  });

  it("keeps a rendered bubble fully inside a narrow graph canvas", () => {
    const bounds = { left: 0, top: 0, width: 360, height: 420 };
    const nodeBounds = { width: 132, height: 60 };
    const fromPointer = graphPositionFromPointer(bounds, 0, 0, nodeBounds);
    const restored = graphPositionForCanvas(bounds, { x: -500, y: 9000 }, nodeBounds);
    const horizontalInset = ((nodeBounds.width / 2 + 6) / bounds.width) * 900;
    const verticalInset = ((nodeBounds.height / 2 + 6) / bounds.height) * 560;

    expect(fromPointer).toEqual({ x: horizontalInset, y: verticalInset });
    expect(restored).toEqual({ x: horizontalInset, y: 560 - verticalInset });
  });

  it("labels handoff and knowledge links accurately without focusable SVG paths", () => {
    const markup = renderToStaticMarkup(createElement(AgentGraph, {
      agents: [
        { id: "source_agent", title: "Source", enabled: true },
        { id: "consumer_agent", title: "Consumer", enabled: true, consumes: ["agent:source_agent:output"] },
        { id: "knowledge_agent", title: "Knowledge", enabled: true, resources: ["agent:source_agent"] }
      ],
      storageKey: ""
    }));
    const svg = markup.match(/<svg viewBox="0 0 900 560"[\s\S]*?<\/svg>/)?.[0] || "";
    expect(svg).toContain("Source hands work to Consumer");
    expect(svg).toContain("Source provides knowledge to Knowledge");
    expect(svg).not.toContain('role="button"');
    expect(svg).not.toContain('tabindex="0"');
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
    expect(marketplaceMarkup).toContain('<details class="marketplace-hero">');
    expect(marketplaceMarkup).toContain("COMMUNITY LIBRARY");
    expect(marketplaceMarkup).toContain("Shared agents and teams, ready to make your own.");
    expect(marketplaceMarkup).not.toContain("lucide-sparkles");
    expect(marketplaceMarkup).toContain("Published by alice");
    expect(marketplaceMarkup).toContain("Rate");
    expect(marketplaceMarkup).not.toContain("Share your work");
    expect(marketplaceMarkup).not.toMatch(/Achievements|Proof links|License/);

    const publishMarkup = renderToStaticMarkup(createElement(PublishDialog, {
      agent: { id: "owned_agent", title: "Owned agent", capability: "Helps with planning." },
      onClose: () => undefined,
      onSaved: () => undefined
    }));
    expect(publishMarkup).toContain("Specialist description");
    expect(publishMarkup).not.toMatch(/Achievements|Proof links|Version|License/);

    const detailMarkup = renderToStaticMarkup(createElement(MarketplaceAgentDialog, {
      item,
      auth: { user_id: "bob", workspace_id: "workspace_b" },
      onClose: () => undefined,
      onRate: () => undefined,
      onCopied: () => undefined
    }));
    expect(detailMarkup).toContain("Purpose and instructions");
    expect(detailMarkup).toContain("Add to my team");
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
    expect(catalogMarkup).toContain("Edit public description");
    expect(catalogMarkup).toContain("Remove public listing");
    expect(catalogMarkup).toContain("Delete permanently");
  });

  it("keeps Marketplace mutations locked until full details load and offers an explicit retry", () => {
    expect(marketplaceDetailActionsDisabled({ loading: true, detailReady: false, detailError: "" })).toBe(true);
    expect(marketplaceDetailActionsDisabled({ loading: false, detailReady: false, detailError: "Network unavailable" })).toBe(true);
    expect(marketplaceDetailActionsDisabled({ loading: false, detailReady: true, detailError: "" })).toBe(false);

    const failureMarkup = renderToStaticMarkup(createElement(MarketplaceDetailFailure, {
      message: "Details could not be verified.",
      onRetry: () => undefined
    }));
    expect(failureMarkup).toContain('role="alert"');
    expect(failureMarkup).toContain("Details could not be verified.");
    expect(failureMarkup).toContain("Retry details");

    const loadingMarkup = renderToStaticMarkup(createElement(MarketplaceAgentDialog, {
      item: {
        id: "summary_only_agent",
        listing_id: "listing_summary_only",
        item_type: "agent",
        title: "Summary-only specialist",
        can_manage: true,
        is_self_published: true,
        rating_average: 0,
        rating_count: 0
      },
      auth: { user_id: "alice" },
      onClose: () => undefined,
      onCopied: () => undefined,
      onEditDescription: () => undefined,
      onUnpublish: () => undefined
    }));
    expect(loadingMarkup).toMatch(/marketplace-edit-action[^>]*disabled/);
    expect(loadingMarkup).toMatch(/marketplace-unpublish-action[^>]*disabled/);
    expect(loadingMarkup).toMatch(/text-button primary[^>]*disabled/);
  });

  it("welcomes first-time users as the owner of a visible team", () => {
    const markup = renderToStaticMarkup(createElement(EmptyTeamWelcome, {
      workspace: { name: "Customer Care" },
      agents: [
        { id: "policy_reader", title: "Policy Reader", enabled: true, session_active: true },
        { id: "reply_writer", title: "Reply Writer", enabled: true, session_active: true }
      ]
    }));
    expect(markup).toContain("Customer Care is ready");
    expect(markup).toContain('class="team-welcome-kicker">Customer Care is ready</span>');
    expect(markup).toContain("What should your team accomplish?");
    expect(markup).toContain("2 available specialists");
    expect(markup).toContain("Start with a request");
    expect(markup).toContain("Build a repeatable workflow");
    expect(markup).toContain("Manage your team");
    expect(markup).not.toMatch(/\/workflow|\/agent/);
  });

  it("keeps normal chat understandable when every configured specialist is paused", () => {
    const markup = renderToStaticMarkup(createElement(EmptyTeamWelcome, {
      workspace: { name: "Customer Care" },
      agents: [
        { id: "policy_reader", title: "Policy Reader", enabled: true, session_active: false },
        { id: "reply_writer", title: "Reply Writer", enabled: true, session_active: false }
      ]
    }));
    expect(markup).toContain("Customer Care specialists are paused");
    expect(markup).toContain("continue without a specialist");
    expect(markup).toContain("Manage your team");
    expect(markup).not.toContain("Add your first specialist");
  });

  it("explains repeated WorldGraph work in plain language at answer level", () => {
    const markup = renderToStaticMarkup(createElement(RunReceipt, {
      run: {
        status: "completed",
        expert_outputs: [{ adapter: "brand" }, { adapter: "language" }],
        sources: [],
        outcome_contracts: [],
        world_graph: {
          total: 2,
          kept: 0,
          refreshed: 2,
          decisions: [
            { adapter: "brand", action: "refreshed", reason: "live_or_mutable_tool_available" },
            { adapter: "language", action: "refreshed", reason: "live_or_mutable_tool_available" }
          ]
        }
      }
    }));
    expect(markup).toContain("2 parts checked again · live information was enabled");
    expect(markup).not.toMatch(/WorldGraph/i);
  });

  it("shows readable approval fields before exact technical arguments", () => {
    const markup = renderToStaticMarkup(createElement(ApprovalArguments, {
      argumentsValue: {
        recipient_email: "customer@example.com",
        subject: "Your replacement",
        create_draft_only: true,
        metadata: { source: "workflow" }
      }
    }));
    expect(markup).toContain("Recipient Email");
    expect(markup).toContain("customer@example.com");
    expect(markup).toContain("Create Draft Only");
    expect(markup).toContain("Yes");
    expect(markup).toContain("Structured details included");
    expect(markup).toContain("Technical details");
    expect(markup).toContain("recipient_email");
  });

  it("keeps team creation primary and administrative actions secondary", () => {
    const markup = renderToStaticMarkup(createElement(AgentCatalog, {
      agents: [{ id: "planner", title: "Launch Planner", capability: "Plans launches.", enabled: true }],
      workspaces: [{ agent_workspace_id: "team_1", name: "Launch Team", agent_count: 1, max_agents: 16 }],
      activeWorkspace: { agent_workspace_id: "team_1", name: "Launch Team", agent_count: 1, max_agents: 16 },
      auth: {},
      sessionId: "session_1"
    }));
    expect(markup).toContain("Active team");
    expect(markup).toContain("Add specialist");
    expect(markup).toContain("Choose members");
    expect(markup).toContain("More team actions");
    expect(markup).toContain("Available for this chat");
    expect(markup).not.toContain("No verified results yet");
  });

  it("opens published workspace agents with the same contract details as Marketplace agents", () => {
    const entry = {
      source_agent_id: "workspace_writer",
      agent: {
        title: "Workspace writer",
        capability: "Writes a structured first draft.",
        boundary: "Use the supplied brief and identify missing context.",
        tools: ["web_search"],
        connector_requirements: [{ connection_name: "Google Drive", tools: [{ name: "drive_read", title: "Read files" }] }],
        consumes: ["user_request"],
        produces: ["first_draft"],
        routing_cues: ["write a draft"],
        exclusions: { private_knowledge: true }
      }
    };
    const cardMarkup = renderToStaticMarkup(createElement(MarketplaceAgentDialog, {
      item: {
        id: "workspace_editorial",
        item_type: "workspace",
        title: "Editorial team",
        description: "A coordinated writing team.",
        publisher_display_name: "Alice",
        workspace: { agents: [entry], edges: [] }
      },
      auth: { user_id: "bob", workspace_id: "workspace_b" },
      onClose: () => undefined,
      onRate: () => undefined,
      onCopied: () => undefined
    }));
    expect(cardMarkup).toContain("workspace-marketplace-agent-card");
    expect(cardMarkup).toContain("View details for Workspace writer");

    const detailMarkup = renderToStaticMarkup(createElement(MarketplaceWorkspaceAgentDetails, {
      entry,
      workspaceTitle: "Editorial team",
      publisher: "Alice"
    }));
    expect(detailMarkup).toContain("Purpose and instructions");
    expect(detailMarkup).toContain("Use the supplied brief and identify missing context.");
    expect(detailMarkup).toContain("Web search");
    expect(detailMarkup).toContain("Google Drive · Read files");
    expect(detailMarkup).toContain("first draft");
    expect(detailMarkup).toContain("Back to team");
    expect(detailMarkup).toContain("data-autofocus=\"true\"");
    expect(detailMarkup).toContain("Published by Alice");
  });

  it("keeps workspace membership checkboxes compact inside generic dialogs", () => {
    const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
    const compactControl = styles.match(/\.dialog-form \.workspace-member-list input\[type="checkbox"\]\s*\{([\s\S]*?)\}/)?.[1] || "";
    expect(compactControl).toContain("width: 16px");
    expect(compactControl).toContain("height: 16px");
    expect(compactControl).toContain("min-height: 16px");
    expect(compactControl).toContain("padding: 0");
  });

  it("keeps graph status labels readable and the mobile graph vertically reachable", () => {
    const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
    const appSource = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
    const nodeStatus = styles.match(/\.graph-node small\s*\{([\s\S]*?)\}/)?.[1] || "";
    const narrowGraph = styles.match(/@media \(max-width: 760px\)\s*\{([\s\S]*?)\.app-shell/)?.[1] || "";
    expect(nodeStatus).toContain("font-size: 11px");
    expect(nodeStatus).toContain("color: var(--graph-node-color)");
    expect(narrowGraph).toContain("overflow-y: auto !important");
    expect(styles).toMatch(/\.graph-canvas-scroll\s*\{[\s\S]*?overflow-x: auto;/);
    expect(styles).toMatch(/\.agent-graph\s*\{[\s\S]*?min-width: 800px;/);
    expect(styles).toContain(".graph-node.world-mixed");
    expect(styles).toContain(".graph-node.world-fresh");
    expect(styles).toMatch(/\.details-sheet-body > \.view-switch button\s*\{[\s\S]*?min-height: 44px;/);
    expect(styles).toMatch(/\.answer-team-reuse \.world-changes\.embedded\s*\{[\s\S]*?gap: 10px;/);
    expect(styles).not.toContain(".answer-team-worldgraph");
    expect(styles).toMatch(/\.answer-team-build\s*\{[\s\S]*?padding-top: 20px;[\s\S]*?border-top: 1px solid var\(--line\);/);
    expect(styles).not.toContain(".view-switch.five-up");
    expect(styles).toMatch(/\.team-picker-popover\s*\{[\s\S]*?max-height: min\(520px, calc\(100dvh - 145px\)\);/);
    expect(styles).toMatch(/\.composer-shell\s*\{[\s\S]*?grid-template-columns: minmax\(0, 820px\) 50px;/);
    expect(styles).toContain(".team-picker-popover[hidden]");
    expect(appSource).toContain('aria-haspopup="dialog"');
    expect(appSource).toMatch(/role="dialog"\s+aria-modal="false"/);
    expect(appSource).toContain('event.key !== "Escape"');
  });

  it("keeps the new-chat composer anchored without an empty-state spacer", () => {
    const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
    const composerZone = styles.match(/\.composer-zone\s*\{([\s\S]*?)\}/)?.[1] || "";

    expect(composerZone).toContain("env(safe-area-inset-bottom)");
    expect(styles).not.toMatch(/\.chat-main\.is-empty\s+\.composer-zone\s*\{/);
    expect(styles).not.toContain("min(24vh, 210px)");
  });

  it("compacts signed-in header controls for 320px phones", () => {
    const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
    expect(styles).toContain("@media (max-width: 420px)");
    expect(styles).toMatch(/\.app-header \.balance-pill-copy\s*\{\s*display:\s*none/);
    expect(styles).toMatch(/\.app-header \.studio-button\s*\{[\s\S]*?width:\s*36px/);
  });

  it("prevents unavailable built-in tools from being newly selected", () => {
    const appSource = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
    expect(appSource).toContain("unavailable && !selected");
    expect(appSource).toContain("templateTools = template.tools.filter");
    expect(appSource).toContain("applied without an unavailable ability");
  });
});

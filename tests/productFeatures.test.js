import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  AgentCatalog,
  AgentGraph,
  ConnectionsPanel,
  MarketplaceAgentDialog,
  MarketplacePanel,
  PublishDialog,
  RatingDialog,
  availableSessionAgents,
  graphConnectionInputs,
  graphConnectionWouldCycle,
  graphConnections,
  graphEdgePath,
  graphPositionFromPointer,
  initialGraphPositions,
  storedGraphPositions
} from "../src/App.jsx";
import LandingPage from "../src/LandingPage.jsx";


afterEach(() => {
  vi.unstubAllGlobals();
});


describe("Agent Studio product surfaces", () => {
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
          connection_mode: "managed",
          auth_type: "oauth2",
          availability: "available",
          availability_message: "Connect with Google",
          connect_label: "Connect Gmail",
          preview: true
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

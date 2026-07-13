import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  AgentGraph,
  availableSessionAgents,
  graphConnectionInputs,
  graphConnections,
  initialGraphPositions,
  storedGraphPositions
} from "../src/App.jsx";


afterEach(() => {
  vi.unstubAllGlobals();
});


describe("Agent Studio product surfaces", () => {
  it("distinguishes agent bubbles by color without embedding icons", () => {
    const markup = renderToStaticMarkup(createElement(AgentGraph, {
      agents: [
        { id: "research_agent", title: "Research agent", enabled: true },
        { id: "finance_agent", title: "Finance agent", enabled: true }
      ],
      storageKey: ""
    }));
    const graphButtons = [...markup.matchAll(/<button[^>]*class="graph-node tone-[^"]*"[^>]*>(.*?)<\/button>/g)];

    expect(graphButtons).toHaveLength(2);
    expect(new Set(graphButtons.map((match) => match[0].match(/tone-\d/)?.[0])).size).toBe(2);
    expect(graphButtons.every((match) => !match[1].includes("<svg"))).toBe(true);
    expect(markup).toContain("Connect agents");
  });

  it("keeps the complete mounted agent catalog available to the session picker", () => {
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
      { id: "pending_agent", item_type: "agent", enabled: true, mounted: false },
      { id: "document_agent", item_type: "agent", enabled: true, mounted: true, document: { source: "fixture" } }
    ]);

    expect(available).toHaveLength(10);
    expect(available.filter((agent) => agent.session_active !== false)).toHaveLength(9);
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
});

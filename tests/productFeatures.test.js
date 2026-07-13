import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  AgentGraph,
  availableSessionLoRAs,
  graphConnections,
  initialGraphPositions,
  storedGraphPositions
} from "../src/App.jsx";


afterEach(() => {
  vi.unstubAllGlobals();
});


describe("Agent Studio product surfaces", () => {
  it("distinguishes graph bubbles by type color class without embedding type icons", () => {
    const markup = renderToStaticMarkup(createElement(AgentGraph, {
      agents: [
        { id: "research_agent_lora", item_type: "agent", title: "Research agent", enabled: true },
        { id: "finance_lora", item_type: "lora", title: "Finance LoRA", enabled: true }
      ],
      storageKey: ""
    }));
    const graphButtons = [...markup.matchAll(/<button[^>]*class="graph-node (?:agent|lora)[^"]*"[^>]*>(.*?)<\/button>/g)];

    expect(markup).toContain('class="graph-node agent ');
    expect(markup).toContain('class="graph-node lora ');
    expect(graphButtons).toHaveLength(2);
    expect(graphButtons.every((match) => !match[1].includes("<svg"))).toBe(true);
  });

  it("keeps the complete mounted LoRA catalog available to the session picker", () => {
    const loras = Array.from({ length: 9 }, (_, index) => ({
      id: `adapter_${index}_lora`,
      item_type: "lora",
      enabled: true,
      mounted: true,
      session_active: index !== 8
    }));
    const available = availableSessionLoRAs([
      ...loras,
      { id: "ordinary_agent_lora", item_type: "agent", enabled: true, mounted: true },
      { id: "archived_lora", item_type: "lora", enabled: false, mounted: true },
      { id: "pending_lora", item_type: "lora", enabled: true, mounted: false }
    ]);

    expect(available).toHaveLength(9);
    expect(available.filter((agent) => agent.session_active !== false)).toHaveLength(8);
  });

  it("builds directed handoff/knowledge edges and bounded large-graph positions", () => {
    const agents = [
      { id: "source_lora", resources: [], consumes: [] },
      { id: "handoff_lora", resources: [], consumes: ["agent:source_lora:output"] },
      { id: "knowledge_lora", resources: ["agent:source_lora"], consumes: [] }
    ];
    expect(graphConnections(agents)).toEqual([
      { from: "source_lora", to: "handoff_lora", kind: "handoff" },
      { from: "source_lora", to: "knowledge_lora", kind: "knowledge" }
    ]);

    const positions = initialGraphPositions(Array.from({ length: 120 }, (_, index) => ({ id: `node_${index}_lora` })));
    expect(Object.values(positions)).toHaveLength(120);
    for (const position of Object.values(positions)) {
      expect(position.x).toBeGreaterThanOrEqual(64);
      expect(position.x).toBeLessThanOrEqual(836);
      expect(position.y).toBeGreaterThanOrEqual(44);
      expect(position.y).toBeLessThanOrEqual(516);
    }
  });

  it("restores persisted graph positions defensively and clamps unsafe coordinates", () => {
    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => JSON.stringify({
          finance_lora: { x: -500, y: 9000 },
          invalid_lora: { x: "not-a-number", y: 12 }
        })
      }
    });

    expect(storedGraphPositions("workspace-graph")).toEqual({
      finance_lora: { x: 64, y: 516 }
    });
  });
});

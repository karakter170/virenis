import { describe, expect, it } from "vitest";

import {
  agentSourcePathIsOwned,
  hasOwnedLegacyAgentSource,
  ownedAgentSourcePrefixes
} from "../src/agentSourcePaths.js";

describe("agent source editor migration boundary", () => {
  it("emits the neutral prefix first and accepts an exact owned legacy path", () => {
    expect(ownedAgentSourcePrefixes("analyst", { allowLegacy: true })).toEqual([
      "sources/agents/analyst/",
      "sources/router_agents/analyst/"
    ]);
    expect(agentSourcePathIsOwned("analyst", "sources/agents/analyst/source.md")).toBe(true);
    expect(agentSourcePathIsOwned(
      "analyst",
      "sources/router_agents/analyst/source.md",
      { allowLegacy: true }
    )).toBe(true);
    expect(hasOwnedLegacyAgentSource("analyst", ["sources/router_agents/analyst/source.md"]))
      .toBe(true);
  });

  it("rejects another agent, traversal, and merely similar prefixes", () => {
    expect(agentSourcePathIsOwned("analyst", "sources/agents/other/source.md")).toBe(false);
    expect(agentSourcePathIsOwned("analyst", "sources/router_agents/analyst/source.md")).toBe(false);
    expect(agentSourcePathIsOwned("analyst", "sources/agents/analyst/../private.md")).toBe(false);
    expect(agentSourcePathIsOwned("analyst", "sources/agents/analyst-extra/source.md")).toBe(false);
  });
});

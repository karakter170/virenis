import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  apiSeedAgents,
  approvedSourceSnippets,
  seedAgents,
  seedAgentsForMode,
  withoutLegacySeedAgents
} from "../server/catalog.js";
import {
  isLegacyManagedCatalogSeed,
  legacyApprovedSourceSnippets,
  legacySeedAgents
} from "../server/legacyCatalogCompatibility.js";

describe("active API-agent catalog", () => {
  it("keeps every built-in API agent in the dynamic Runtime manifest without model-module lifecycle fields", () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.resolve("../../configs/router_agent_library.json"), "utf8")
    );
    const manifestAgents = manifest.agents || manifest.adapters;

    expect(manifestAgents.map((agent) => agent.id)).toEqual(
      expect.arrayContaining(apiSeedAgents.map((agent) => agent.id))
    );
    expect(JSON.stringify(apiSeedAgents)).not.toMatch(/lora/i);
    for (const agent of apiSeedAgents) {
      expect(agent).not.toHaveProperty("adapter_path");
      expect(agent).not.toHaveProperty("mounted");
      expect(agent.execution).toEqual({ type: "api", model: "inherit" });
      expect(agent.skill_path).toBe(`skills/router_agents/${agent.id}/SKILL.md`);
      expect(agent.ready).toBe(true);
    }
  });

  it("uses the API catalog for real product runtimes while preserving test fixtures", () => {
    expect(seedAgentsForMode({ realRuntime: true, nodeEnv: "production" })).toBe(apiSeedAgents);
    expect(seedAgentsForMode({ realRuntime: true, nodeEnv: "development" })).toBe(apiSeedAgents);
    expect(seedAgentsForMode({ realRuntime: true, nodeEnv: "test" })).toBe(seedAgents);
    expect(seedAgentsForMode({ realRuntime: false, nodeEnv: "development" })).toBe(seedAgents);
  });

  it("keeps retired simulator fixtures behind an explicit compatibility boundary", () => {
    expect(seedAgents).toBe(legacySeedAgents);
    expect(approvedSourceSnippets).toBe(legacyApprovedSourceSnippets);
    expect(isLegacyManagedCatalogSeed(seedAgents[0])).toBe(true);
    expect(isLegacyManagedCatalogSeed(apiSeedAgents[0])).toBe(false);
    expect(seedAgents[0]).toMatchObject({
      id: "finance_reasoning_lora",
      skill_path: "skills/tcar_real_loras/finance_reasoning_lora/SKILL.md",
      adapter_path: "adapters/tcar_real_loras/finance_reasoning_lora",
      contract_version: "tcar-agent-v1",
      library_origin: "tcar_base_lora_library"
    });
  });

  it("removes only retired built-in seeds from an existing operational snapshot", () => {
    const custom = { id: "customer_created_agent", enabled: true };
    const migrated = withoutLegacySeedAgents([
      custom,
      seedAgents[0],
      ...apiSeedAgents
    ]);

    expect(migrated).toContain(custom);
    expect(migrated).toEqual(expect.arrayContaining(apiSeedAgents));
    expect(migrated.some((agent) => agent.id === seedAgents[0].id)).toBe(false);
  });
});

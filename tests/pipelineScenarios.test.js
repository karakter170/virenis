import { describe, expect, it } from "vitest";
import {
  AGENT_IDS,
  AGENT_TEAMS,
  GLOBAL_DOCUMENT_AGENT_IDS,
  JUNK_AGENT_DENYLIST,
  MEANINGFUL_AGENT_IDS,
  PIPELINE_SCENARIOS,
  UNUSABLE_AGENT_DENYLIST
} from "../e2e/pipelineScenarios.js";

describe("pipeline benchmark scenarios", () => {
  it("keeps stable unique scenarios and bounded teams", () => {
    expect(PIPELINE_SCENARIOS).toHaveLength(56);
    expect(new Set(PIPELINE_SCENARIOS.map((item) => item.id)).size).toBe(PIPELINE_SCENARIOS.length);

    const meaningful = new Set(MEANINGFUL_AGENT_IDS);
    const junk = new Set(JUNK_AGENT_DENYLIST);
    expect(meaningful.size).toBe(MEANINGFUL_AGENT_IDS.length);
    expect(junk.size).toBe(JUNK_AGENT_DENYLIST.length);

    for (const [teamId, team] of Object.entries(AGENT_TEAMS)) {
      expect(team.id).toBe(teamId);
      expect(team.agentIds.length).toBeGreaterThan(0);
      expect(team.agentIds.length).toBeLessThanOrEqual(16);
      expect(new Set(team.agentIds).size).toBe(team.agentIds.length);
      expect(team.agentIds.every((agentId) => meaningful.has(agentId))).toBe(true);
    }

    const teamCoverage = new Set([
      ...Object.values(AGENT_TEAMS).flatMap((team) => team.agentIds),
      ...GLOBAL_DOCUMENT_AGENT_IDS
    ]);
    expect(teamCoverage).toEqual(meaningful);
  });

  it("validates routing contracts and covers every meaningful agent", () => {
    const covered = new Set();
    const decisions = new Set(["delegate", "direct", "clarify"]);

    for (const item of PIPELINE_SCENARIOS) {
      const team = AGENT_TEAMS[item.team];
      expect(team, item.id).toBeTruthy();
      expect(item.prompt.trim().length, item.id).toBeGreaterThan(10);
      expect(decisions.has(item.expectedDecision), item.id).toBe(true);
      expect(Number.isInteger(item.turn) && item.turn > 0, item.id).toBe(true);
      expect(item.turnGroup, item.id).toBeTruthy();
      expect(typeof item.needsAttachment, item.id).toBe("boolean");
      expect(item.oracleHints.length, item.id).toBeGreaterThan(0);
      expect(item.oracleHints.every((hint) => typeof hint === "string" && hint.length <= 120), item.id).toBe(true);
      expect(new Set(item.requiredAgents).size, item.id).toBe(item.requiredAgents.length);
      expect(new Set(item.allowedAgents).size, item.id).toBe(item.allowedAgents.length);
      expect(item.requiredAgents.every((agentId) => item.allowedAgents.includes(agentId)), item.id).toBe(true);
      expect(item.allowedAgents.every((agentId) => (
        team.agentIds.includes(agentId) || GLOBAL_DOCUMENT_AGENT_IDS.includes(agentId)
      )), item.id).toBe(true);
      expect(JUNK_AGENT_DENYLIST.every((agentId) => item.forbiddenAgents.includes(agentId)), item.id).toBe(true);
      expect(UNUSABLE_AGENT_DENYLIST.every((agentId) => item.forbiddenAgents.includes(agentId)), item.id).toBe(true);
      expect(item.allowedAgents.every((agentId) => !item.forbiddenAgents.includes(agentId)), item.id).toBe(true);
      if (item.expectedDecision === "delegate") {
        expect(item.requiredAgents.length > 0 || item.needsAttachment, item.id).toBe(true);
      } else {
        expect(item.requiredAgents, item.id).toEqual([]);
        expect(item.allowedAgents, item.id).toEqual([]);
      }
      item.requiredAgents.forEach((agentId) => covered.add(agentId));
    }

    expect(covered).toEqual(new Set(MEANINGFUL_AGENT_IDS));
    expect(new Set(PIPELINE_SCENARIOS.map((item) => item.category))).toEqual(new Set([
      "automatic_routing",
      "document_routing",
      "direct",
      "clarify",
      "polarity",
      "multi_turn_memory",
      "workflow"
    ]));
  });

  it("supplies the source material required by the critique-only polarity case", () => {
    const critique = PIPELINE_SCENARIOS.find((item) => item.id === "polarity_critique_without_new_poem");
    const suppliedText = critique.prompt.split(/\bText:\s*/u)[1] || "";

    expect(critique.prompt).toMatch(/^Critique poem\b/u);
    expect(suppliedText.trim().length).toBeGreaterThan(40);
    expect(critique.forbiddenAgents).toContain("emotional_poet_78c8297e");
  });

  it("keeps the clinic market-research case prospective and measurable", () => {
    const clinic = PIPELINE_SCENARIOS.find((item) => item.id === "auto_market_research_clinics");

    expect(clinic.requiredAgents).toEqual([AGENT_IDS.marketResearcher]);
    expect(clinic.allowedAgents).toEqual([AGENT_IDS.marketResearcher]);
    expect(clinic.prompt).toMatch(/design—not execute—a demand-validation study/u);
    expect(clinic.prompt).toMatch(/research questions and clinic segments/u);
    expect(clinic.prompt).toMatch(/interview and survey plan/u);
    expect(clinic.prompt).toMatch(/quantitative go\/no-go thresholds/u);
    expect(clinic.prompt).toMatch(/Do not claim existing findings/u);
    expect(clinic.prompt).toMatch(/research have already been completed/u);
    expect(clinic.oracleHints).toEqual(expect.arrayContaining([
      expect.stringMatching(/Interview and survey/u),
      expect.stringMatching(/Quantitative go\/no-go/u),
      expect.stringMatching(/No claimed completed research/u)
    ]));
  });

  it("scopes the hypothetical Renault workflow to strategy and finance", () => {
    const renault = PIPELINE_SCENARIOS.find((item) => item.id === "workflow_renault_research_finance");

    expect(renault.requiredAgents).toEqual([
      AGENT_IDS.renaultAnalyst,
      AGENT_IDS.financialAnalysis
    ]);
    expect(renault.allowedAgents).toEqual([
      AGENT_IDS.renaultAnalyst,
      AGENT_IDS.financialAnalysis,
      AGENT_IDS.financeReasoning
    ]);
    expect(renault.requiredAgents).not.toContain(AGENT_IDS.industryResearch);
    expect(renault.allowedAgents).not.toContain(AGENT_IDS.industryResearch);
    expect(renault.prompt).toMatch(/use only these supplied assumptions/u);
    expect(renault.prompt).toMatch(/5,000 addressable vehicles/u);
    expect(renault.prompt).toMatch(/€32,000 revenue per vehicle/u);
    expect(renault.prompt).toMatch(/18% gross margin/u);
    expect(renault.prompt).toMatch(/8% downside volume/u);
    expect(renault.prompt).toMatch(/Renault-specific strategic base\/downside comparison/u);
    expect(renault.prompt).toMatch(/do not research, claim, or imply current market data/u);
    expect(renault.oracleHints).toEqual(expect.arrayContaining([
      "Base: €160M revenue and €28.8M gross profit",
      "Downside: 4,600 vehicles, €147.2M revenue, about €26.5M gross profit",
      expect.stringMatching(/only supplied assumptions/u),
      expect.stringMatching(/no current-market claims/u)
    ]));
  });

  it("allows the shared-memory finance specialist on the automotive follow-up", () => {
    const followup = PIPELINE_SCENARIOS.find((item) => item.id === "memory_auto_finance_followup");

    expect(followup.requiredAgents).toEqual([AGENT_IDS.financialAnalysis]);
    expect(followup.allowedAgents).toEqual([
      AGENT_IDS.industryResearch,
      AGENT_IDS.financialAnalysis,
      AGENT_IDS.financeReasoning
    ]);
  });
});

import { describe, expect, it } from "vitest";

import { insertComposerAgentMention } from "../src/App.jsx";
import { planRoutes } from "./fixtures/agentRuntimeSimulator.js";

describe("composer specialist suggestions", () => {
  it("inserts the selected specialist id when two suggestions have the same title", () => {
    const draft = "Please ask the team @sup";
    const start = draft.indexOf("@sup");
    const mention = { start, end: start + "@sup".length, query: "sup" };
    const specialists = [
      { id: "support_triage_east", title: "Support Specialist" },
      { id: "support_triage_west", title: "Support Specialist" }
    ];

    const east = insertComposerAgentMention(draft, mention, specialists[0]);
    const west = insertComposerAgentMention(draft, mention, specialists[1]);

    expect(east).toMatchObject({
      token: "@support_triage_east",
      value: "Please ask the team @support_triage_east "
    });
    expect(west).toMatchObject({
      token: "@support_triage_west",
      value: "Please ask the team @support_triage_west "
    });
    expect(west.value).not.toContain('@"Support Specialist"');
    expect(west.caret).toBe("Please ask the team @support_triage_west ".length);
  });

  it("preserves the chosen duplicate-title id through semantic graph compilation", () => {
    const specialists = [
      { id: "alpha_route", title: "Shared Specialist", enabled: true, consumes: ["user_request"], produces: ["answer"] },
      { id: "beta_route", title: "Shared Specialist", enabled: true, consumes: ["user_request"], produces: ["answer"] }
    ];
    const draft = "Ask @sha";
    const selection = insertComposerAgentMention(
      draft,
      { start: draft.indexOf("@sha"), end: draft.length, query: "sha" },
      specialists[1]
    );

    const plan = planRoutes({
      query: selection.value,
      agents: specialists,
      semanticAgentIds: ["beta_route"]
    });

    expect(selection.token).toBe("@beta_route");
    expect(plan.routing.explicit_adapters).toEqual([]);
    expect(plan.routing.selected).toEqual([
      expect.objectContaining({ adapter: "beta_route", source: "semantic_model" })
    ]);
    expect(plan.steps.map((step) => step.adapter)).toContain("beta_route");
    expect(plan.steps.map((step) => step.adapter)).not.toContain("alpha_route");
  });
});

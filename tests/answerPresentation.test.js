import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ChatMessage, RunDetailsSheet } from "../src/App.jsx";
import {
  copyableAssistantAnswer,
  formatStructuredAssistantAnswer,
  prepareAssistantAnswer
} from "../src/answerPresentation.js";

const agents = [
  { id: "audience_agent", title: "Audience & Context Analyst" },
  { id: "marketing_lead", title: "Marketing Lead Agent" }
];

const run = {
  run_id: "run_marketing",
  status: "completed",
  query: "Help me market my Match 3 game.",
  plan: { routing: { selected: [] } },
  expert_outputs: [
    {
      step_id: "s1",
      adapter: "audience_agent",
      task: "Define the audience",
      domain_answer: "Casual players are an initial hypothesis, not a researched demographic.",
      handoff_artifacts: [{
        artifact_id: "s1:audience_brief:67b2dc78144011b7",
        producer_step_id: "s1",
        name: "audience_brief",
        value: "Initial audience hypotheses and evidence gaps."
      }]
    },
    {
      step_id: "s6",
      adapter: "marketing_lead",
      task: "Create the plan",
      domain_answer: "Start with positioning, two creative tests, and a measurement loop.",
      handoff_artifacts: []
    }
  ],
  sources: [],
  outcome_contracts: [],
  events: []
};

describe("assistant answer presentation", () => {
  it("turns the legacy one-line Marketing envelope into balanced Markdown and named sources", () => {
    const answer = 'marketing_plan: executive_summary: "Execution-ready marketing plan." audience_context: source: "Audience & Context Analyst" reference: "route:s1:7eeff07ec7cee557b6733b46" artifact: "s1:audience_brief:67b2dc78144011b7" summary: "Persona and behavior hypotheses." next_actions: - "Review artifact s1:audience_brief:67b2dc78144011b7 before launch." final_answer: "Begin with audience alignment and two measurable tests."';
    const presentation = prepareAssistantAnswer(answer, run, agents);

    expect(presentation.markdown).toContain("## Marketing Plan\n\n### Overview");
    expect(presentation.markdown).toContain("### Audience Context");
    expect(presentation.markdown).toContain("### Next actions");
    expect(presentation.markdown).toContain("### Recommended starting point");
    expect(presentation.markdown).toContain("[Audience & Context Analyst](#answer-source-");
    expect(presentation.markdown).not.toContain("7eeff07ec7cee557b6733b46");
    expect(presentation.markdown).not.toContain("67b2dc78144011b7");
    expect([...presentation.references.values()].some((reference) => (
      reference.title === "Audience & Context Analyst"
      && reference.summary.includes("Casual players")
    ))).toBe(true);
    expect(copyableAssistantAnswer(answer, run, agents)).not.toContain("#answer-source-");
  });

  it("formats multiline YAML-like lead output and JSON-like specialist output without changing normal prose", () => {
    const lead = `marketing_plan:
 subject: "Match 3 game marketing"
 status: "execution-ready"
 audience_alignment:
    source: "route:s1:7eeff07ec7cee557b6733b46"
    hypothesis: "Casual players are an initial hypothesis"
 next_actions:
    - "Test two creative concepts"

final_answer: "Start with the audience and creative tests."`;
    const formattedLead = prepareAssistantAnswer(lead, run, agents).markdown;
    expect(formattedLead).toContain("## Marketing Plan");
    expect(formattedLead).toContain("### Audience Alignment");
    expect(formattedLead).toContain("**Source:** [Audience & Context Analyst]");
    expect(formattedLead).toContain("- Test two creative concepts");

    const specialist = 'audience_brief: {"subject":"Match 3 game","hypotheses":["Casual players","Puzzle fans"],"evidence_gaps":["No player research supplied"]}';
    const formattedSpecialist = formatStructuredAssistantAnswer(specialist);
    expect(formattedSpecialist).toContain("## Audience Brief");
    expect(formattedSpecialist).toContain("### Hypotheses");
    expect(formattedSpecialist).toContain("- Casual players");
    expect(formatStructuredAssistantAnswer("Use this ordinary key: value in prose.")).toBe("Use this ordinary key: value in prose.");
  });

  it("renders source controls with hover summaries and keeps uncited contributors discoverable", () => {
    const markup = renderToStaticMarkup(createElement(ChatMessage, {
      message: {
        message_id: "message_marketing",
        role: "assistant",
        run_id: run.run_id,
        content: "Use the audience hypothesis [route:s1:7eeff07ec7cee557b6733b46]."
      },
      run,
      agents,
      connections: [],
      canWrite: true,
      onCopy: () => undefined,
      onRetry: () => undefined,
      onFeedback: () => undefined,
      onDetails: () => undefined
    }));

    expect(markup).toContain('aria-label="Open answer source: Audience &amp; Context Analyst"');
    expect(markup).toContain('class="answer-source-popover" role="tooltip"');
    expect(markup).toContain("Casual players are an initial hypothesis");
    expect(markup).toContain("Answer sources");
    expect(markup).toContain("Marketing Lead Agent");
    expect(markup).not.toContain("7eeff07ec7cee557b6733b46");
  });

  it("opens Answer details on the exact specialist and displays an answer source summary", () => {
    const reference = [...prepareAssistantAnswer(
      "Audience premise [route:s1:7eeff07ec7cee557b6733b46].",
      run,
      agents
    ).references.values()][0];
    const markup = renderToStaticMarkup(createElement(RunDetailsSheet, {
      run,
      agents,
      contractsById: {},
      canWrite: true,
      focusReference: reference,
      onClose: () => undefined,
      onCreateOutcome: () => undefined,
      onSettleOutcome: () => undefined,
      onDisputeOutcome: () => undefined,
      onCorrectOutcome: () => undefined
    }));

    expect(markup).toContain('aria-label="Answer source summary"');
    expect(markup).toContain("Specialist source");
    expect(markup).toContain('class="detail-row source-focused" open=""');
    expect(markup).toContain("Casual players are an initial hypothesis");
  });

  it("maps document chunk ids to document titles and opens the focused Sources view", () => {
    const documentRun = {
      ...run,
      sources: [{
        chunk_id: "launch_brief_chunk_1",
        title: "Match 3 launch brief",
        page: 4,
        excerpt: "The supplied brief asks for a two-channel creative test."
      }]
    };
    const presentation = prepareAssistantAnswer(
      "Use the supplied launch constraint [launch_brief_chunk_1].",
      documentRun,
      agents
    );
    const reference = [...presentation.references.values()].find((item) => item.kind === "document");
    expect(presentation.markdown).toContain("[Match 3 launch brief](#answer-source-");
    expect(presentation.markdown).not.toContain("launch_brief_chunk_1");

    const markup = renderToStaticMarkup(createElement(RunDetailsSheet, {
      run: documentRun,
      agents,
      contractsById: {},
      canWrite: true,
      focusReference: reference,
      onClose: () => undefined,
      onCreateOutcome: () => undefined,
      onSettleOutcome: () => undefined,
      onDisputeOutcome: () => undefined,
      onCorrectOutcome: () => undefined
    }));
    expect(markup).toContain("Document source");
    expect(markup).toContain('class="source-row source-focused"');
    expect(markup).toContain("The supplied brief asks for a two-channel creative test.");
    expect(markup).toContain('aria-pressed="true">Sources</button>');
  });
});

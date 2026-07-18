import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../server/app.js";

const TOKEN = "configuration_alice";
const ACTOR = { user_id: "configuration_alice", workspace_id: "configuration_workspace", role: "user" };

const CONFIGURATION_CASES = [
  configCase("Customer complaint", "Handle recurring customer complaints and prepare an apology.", "careful", ["empathetic", "calm"], "conversation", ["user_provided_context"], [], "support_response"),
  configCase("Math tutor", "Explain algebra to a student step by step.", "direct", ["patient", "educational"], "none", ["user_provided_context"], ["calculator"], "lesson_output"),
  configCase("Legal document review", "Review an attached contract and state uncertainty.", "careful", ["formal", "objective"], "none", ["attached_documents"], ["document_search", "document_read"], "contract_findings"),
  configCase("Medical handout", "Summarize an uploaded patient handout without diagnosis.", "careful", ["reassuring", "clear"], "none", ["attached_documents"], ["document_search", "document_read"], "handout_summary"),
  configCase("Repository reviewer", "Review the repository source code for maintainability.", "thorough", ["technical", "clear"], "none", ["repository"], ["repo_inspector"], "code_review"),
  configCase("Public research", "Research the latest public web guidance and cite limitations.", "careful", ["objective", "professional"], "none", ["current_web"], ["web_search"], "research_brief"),
  configCase("CSV analyst", "Analyze the supplied CSV table and explain patterns.", "thorough", ["clear", "technical"], "none", ["structured_data"], ["data_table", "calculator"], "table_analysis"),
  configCase("Executive brief", "Prepare a concise executive decision brief.", "direct", ["concise", "professional"], "none", ["user_provided_context"], [], "decision_brief"),
  configCase("Business planner", "Create a comprehensive business plan with tradeoffs.", "thorough", ["persuasive", "practical"], "none", ["user_provided_context"], [], "business_plan"),
  configCase("Project monitor", "Monitor an ongoing project and remember follow-up preferences.", "careful", ["practical", "clear"], "conversation", ["user_provided_context"], [], "project_update"),
  configCase("Translator", "Translate a one-off message in a friendly style.", "direct", ["friendly", "clear"], "none", ["user_provided_context"], [], "translation"),
  configCase("Incident responder", "Assess incident risk carefully and prepare a technical response.", "careful", ["calm", "technical"], "conversation", ["user_provided_context"], [], "incident_assessment"),
  configCase("Lesson designer", "Create a detailed classroom lesson for a student.", "thorough", ["patient", "educational"], "none", ["user_provided_context"], [], "lesson_plan"),
  configCase("HR policy guide", "Explain organization policy in a diplomatic formal tone.", "careful", ["diplomatic", "formal"], "none", ["organization_knowledge"], [], "policy_guidance"),
  configCase("Sales proposal", "Draft a persuasive client proposal with practical next steps.", "thorough", ["persuasive", "professional"], "none", ["user_provided_context"], [], "client_proposal"),
  configCase("Customer onboarding", "Support ongoing customer onboarding and remember preferences.", "direct", ["friendly", "supportive"], "conversation", ["user_provided_context"], [], "onboarding_guidance"),
  configCase("Scientific explainer", "Explain a scientific concept thoroughly and objectively.", "thorough", ["objective", "educational"], "none", ["user_provided_context"], [], "science_explanation"),
  configCase("Accessibility guide", "Give clear and supportive accessibility guidance.", "direct", ["clear", "supportive"], "none", ["user_provided_context"], [], "accessibility_guidance"),
  configCase("Product requirements", "Turn user context into direct practical product requirements.", "direct", ["direct", "practical"], "none", ["user_provided_context"], [], "product_requirements"),
  configCase("Evidence auditor", "Audit a supplied data table carefully and preserve uncertainty.", "careful", ["objective", "formal"], "none", ["structured_data"], ["data_table", "calculator"], "audit_findings")
];

describe("comprehensive workflow agent configuration end-to-end", () => {
  it.each(CONFIGURATION_CASES)("persists the complete profile for $name", async (scenario) => {
    const compose = vi.fn(async () => ({
      title: `${scenario.name} reusable team`,
      nodes: [{
        id: "specialist",
        type: "agent",
        title: `${scenario.name} Agent`,
        capability: scenario.intent,
        task: scenario.intent,
        response_style: scenario.style,
        tones: scenario.tones,
        memory: { mode: scenario.memory },
        knowledge: { requirements: scenario.knowledge },
        consumes: [
          "user_request",
          ...(scenario.memory === "conversation" ? ["shared_memory"] : []),
          ...(scenario.knowledge.includes("structured_data") ? ["table_context"] : []),
          ...(scenario.knowledge.includes("attached_documents") ? ["document_context"] : [])
        ],
        produces: [scenario.produces],
        routing_cues: [scenario.name.toLowerCase(), "future similar requests"],
        tools: scenario.tools
      }],
      edges: []
    }));

    await withApp(compose, async (app) => {
      const session = await createSession(app, scenario.name);
      const command = CONFIGURATION_CASES.indexOf(scenario) % 2 === 0 ? "/workflow" : "/agent";
      const queued = await sendMessage(app, session.session_id, `${command}: ${scenario.intent}`);
      const run = await waitForRun(app, queued.body.run_id);
      expect(run.status).toBe("completed");
      expect(compose).toHaveBeenCalledTimes(1);

      const workflow = (await getSession(app, session.session_id)).body.workflows[0];
      const node = workflow.nodes.find((item) => item.type === "agent");
      expect(node.agent_config).toMatchObject({
        configuration_version: "virenis-workflow-agent-config-v3",
        response_style: scenario.style,
        tones: scenario.tones,
        memory: { mode: scenario.memory },
        knowledge: { requirements: expect.arrayContaining(scenario.knowledge) },
        produces: [scenario.produces],
        stage: expect.any(Number)
      });
      expect(node.agent_config.routing_cues).toEqual(expect.arrayContaining([
        scenario.name.toLowerCase(),
        "future similar requests"
      ]));
      expect(node.agent_config.tools).toEqual(expect.arrayContaining(scenario.tools));
      expect(node.agent_config.boundary).toContain(`declared ${scenario.name} Agent role`);

      const activated = (await request(app)
        .post(`/api/workflows/${workflow.workflow_id}/decision`)
        .set(auth())
        .send({ decision: "approve", revision: workflow.revision })
        .expect(200)).body;
      expect(activated.status).toBe("active");
      const agentId = activated.activation.node_agents.find((item) => item.node_id === "specialist").agent_id;
      const stored = app.locals.store.read().agents.find((agent) => agent.id === agentId);
      expect(stored).toMatchObject({
        title: `${scenario.name} Agent`,
        capability: scenario.intent,
        produces: [scenario.produces],
        stage: node.agent_config.stage,
        policies: {
          response: { style: scenario.style, tones: scenario.tones },
          memory: { mode: scenario.memory },
          knowledge: { requirements: expect.arrayContaining(scenario.knowledge) },
          composition: { reusable_role: true, source_content_persisted: false }
        }
      });
      expect(stored.tools).toEqual(expect.arrayContaining(scenario.tools));
      expect(stored.consumes).toContain("user_request");
      expect(stored.consumes.includes("shared_memory")).toBe(scenario.memory === "conversation");
      expect(stored.routing_cues).toContain("future similar requests");
    });
  });

  it("does not reuse stale attributes when two workflows run in the same session", async () => {
    let invocation = 0;
    const compose = vi.fn(async () => {
      const scenario = invocation++ === 0 ? CONFIGURATION_CASES[1] : CONFIGURATION_CASES[0];
      return {
        title: `${scenario.name} team`,
        nodes: [{
          id: "specialist",
          type: "agent",
          title: `${scenario.name} Agent`,
          capability: scenario.intent,
          task: scenario.intent,
          response_style: scenario.style,
          tones: scenario.tones,
          memory: { mode: scenario.memory },
          knowledge: { requirements: scenario.knowledge },
          tools: scenario.tools,
          produces: [scenario.produces],
          routing_cues: [scenario.name.toLowerCase()]
        }]
      };
    });
    await withApp(compose, async (app) => {
      const session = await createSession(app, "No stale roles");
      for (const prompt of [
        "/agent: Explain algebra to a student.",
        "/agent: Handle recurring customer complaints."
      ]) {
        const queued = await sendMessage(app, session.session_id, prompt);
        await waitForRun(app, queued.body.run_id);
      }
      const workflows = (await getSession(app, session.session_id)).body.workflows;
      const math = workflows[0].nodes.find((node) => node.type === "agent").agent_config;
      const support = workflows[1].nodes.find((node) => node.type === "agent").agent_config;
      expect(math.policies.response).toEqual({ style: "direct", tones: ["patient", "educational"] });
      expect(math.policies.memory.mode).toBe("none");
      expect(math.tools).toContain("calculator");
      expect(support.policies.response).toEqual({ style: "careful", tones: ["empathetic", "calm"] });
      expect(support.policies.memory.mode).toBe("conversation");
      expect(support.tools).not.toContain("calculator");
      expect(support.routing_cues).not.toContain("math tutor");
    });
  });

  it("compiles typed, reusable handoffs rather than scenario-specific prose links", async () => {
    const compose = vi.fn(async () => ({
      title: "Research and synthesis team",
      nodes: [
        {
          id: "research",
          type: "agent",
          title: "Evidence Research Agent",
          task: "Collect verified public evidence for future similar questions.",
          response_style: "careful",
          tones: ["objective"],
          knowledge: { requirements: ["current_web"] },
          tools: ["web_search"],
          produces: ["verified_evidence"]
        },
        {
          id: "synthesis",
          type: "agent",
          title: "Evidence Synthesis Agent",
          task: "Turn verified evidence into a clear answer.",
          response_style: "thorough",
          tones: ["clear"],
          knowledge: { requirements: ["upstream_specialist"] },
          consumes: ["upstream_route_outputs"],
          produces: ["evidence_based_answer"]
        }
      ],
      edges: [{ source: "research", target: "synthesis", label: "verified evidence" }]
    }));
    await withApp(compose, async (app) => {
      const session = await createSession(app, "Typed handoff");
      const queued = await sendMessage(app, session.session_id,
        "/workflow: Research current public guidance, then synthesize a reusable answer.");
      await waitForRun(app, queued.body.run_id);
      const workflow = (await getSession(app, session.session_id)).body.workflows[0];
      const synthesis = workflow.nodes.find((node) => node.id === "synthesis");
      expect(synthesis.handoff_contracts).toEqual([{
        from_node_id: "research",
        artifacts: ["verified_evidence"],
        label: "verified evidence",
        required: true
      }]);
      expect(synthesis.agent_config.consumes).toContain("upstream_route_outputs");
      expect(synthesis.agent_config.knowledge.requirements).toContain("upstream_specialist");
    });
  });

  it("executes an activated comprehensive profile with memory, tools, and typed knowledge handoffs", async () => {
    const compose = vi.fn(async () => ({
      title: "Context-aware recommendation team",
      nodes: [
        {
          id: "briefing",
          type: "agent",
          title: "Preference Briefing Agent",
          capability: "Prepare a verified preference brief for downstream recommendations.",
          task: "Use only relevant conversation context to prepare a reusable preference brief.",
          response_style: "careful",
          tones: ["objective", "clear"],
          memory: { mode: "conversation" },
          knowledge: { requirements: ["user_provided_context"] },
          consumes: ["user_request", "shared_memory"],
          produces: ["verified_preference_brief"],
          routing_cues: ["preference brief"],
          tools: ["calculator"]
        },
        {
          id: "recommendation",
          type: "agent",
          title: "Preference Recommendation Agent",
          capability: "Turn a verified preference brief into a practical recommendation.",
          task: "Use the upstream preference brief and produce a practical recommendation.",
          response_style: "thorough",
          tones: ["practical", "clear"],
          memory: { mode: "none" },
          knowledge: { requirements: ["upstream_specialist"] },
          consumes: ["user_request", "upstream_route_outputs"],
          produces: ["preference_recommendation"],
          routing_cues: ["recommend from preference brief"],
          tools: ["data_table", "calculator"]
        }
      ],
      edges: [{ source: "briefing", target: "recommendation", label: "verified preference brief" }]
    }));

    await withApp(compose, async (app) => {
      const session = await createSession(app, "Behavioral profile proof");
      const memorySeed = await sendMessage(app, session.session_id,
        "Remember that I prefer concise plans with one concrete next step.");
      expect((await waitForRun(app, memorySeed.body.run_id)).status).toBe("completed");

      const queued = await sendMessage(app, session.session_id,
        "/workflow: Prepare a preference brief and then make a practical recommendation.");
      expect((await waitForRun(app, queued.body.run_id)).status).toBe("completed");
      const workflow = (await getSession(app, session.session_id)).body.workflows[0];
      const activated = (await request(app)
        .post(`/api/workflows/${workflow.workflow_id}/decision`)
        .set(auth())
        .send({ decision: "approve", revision: workflow.revision })
        .expect(200)).body;
      const briefingId = activated.activation.node_agents.find((item) => item.node_id === "briefing").agent_id;
      const recommendationId = activated.activation.node_agents.find((item) => item.node_id === "recommendation").agent_id;

      const execution = await sendMessage(app, session.session_id,
        `Ask @${recommendationId} to recommend the best next step from my saved preference.`);
      const run = await waitForRun(app, execution.body.run_id);
      expect(run.status).toBe("completed");
      expect(run.plan.steps.map((step) => step.adapter)).toEqual([briefingId, recommendationId]);

      const briefing = run.expert_outputs.find((route) => route.adapter === briefingId);
      const recommendation = run.expert_outputs.find((route) => route.adapter === recommendationId);
      expect(briefing.allowed_tools).toContain("calculator");
      expect(briefing.used_memory).toEqual(expect.arrayContaining([
        expect.objectContaining({ tag: "user_request", source: "user" })
      ]));
      expect(briefing.boundary_check).toContain("user provided context");
      expect(briefing.handoff_artifacts).toEqual([
        expect.objectContaining({
          name: "verified_preference_brief",
          producer: briefingId,
          verified: true
        })
      ]);

      expect(recommendation.allowed_tools).toEqual(expect.arrayContaining(["data_table", "calculator"]));
      expect(recommendation.used_memory).toEqual([]);
      expect(recommendation.boundary_check).toContain("upstream specialist");
      expect(recommendation.consumption_validation).toMatchObject({
        valid: true,
        resolved_contract_inputs: expect.arrayContaining([
          `agent:${briefingId}:output`,
          "upstream_route_outputs"
        ]),
        resolved_from_upstream: ["verified_preference_brief"]
      });
      expect(recommendation.consumed_artifacts).toEqual([
        expect.objectContaining({
          name: "verified_preference_brief",
          producer: briefingId
        })
      ]);
      expect(recommendation.domain_answer).toContain("Using verified upstream context");
      expect(run.final_answer).toContain("verified_preference_brief");
    });
  });
});

function configCase(name, intent, style, tones, memory, knowledge, tools, produces) {
  return { name, intent, style, tones, memory, knowledge, tools, produces };
}

async function withApp(compose, callback) {
  const previous = {
    WEB_STORE_DRIVER: process.env.WEB_STORE_DRIVER,
    APP_API_TOKENS_JSON: process.env.APP_API_TOKENS_JSON,
    TCAR_ENGINE_MODE: process.env.TCAR_ENGINE_MODE
  };
  process.env.WEB_STORE_DRIVER = "json";
  process.env.APP_API_TOKENS_JSON = JSON.stringify({ [TOKEN]: ACTOR });
  process.env.TCAR_ENGINE_MODE = "mock";
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "virenis-config-e2e-"));
  const app = await createApp({
    dbPath: path.join(tmpDir, "db.json"),
    uploadRoot: tmpDir,
    workflowComposer: compose
  });
  try {
    await callback(app);
  } finally {
    await app.locals.drainBackgroundTasks({ timeoutMs: 5000 });
    await app.locals.store.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function createSession(app, title) {
  return (await request(app)
    .post("/api/chat/sessions")
    .set(auth())
    .send({ title })
    .expect(201)).body;
}

function sendMessage(app, sessionId, content) {
  return request(app)
    .post(`/api/chat/sessions/${sessionId}/messages`)
    .set(auth())
    .send({ content })
    .expect(202);
}

function getSession(app, sessionId) {
  return request(app)
    .get(`/api/chat/sessions/${sessionId}`)
    .set(auth())
    .expect(200);
}

async function waitForRun(app, runId) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const response = await request(app)
      .get(`/api/chat/runs/${runId}`)
      .set(auth())
      .expect(200);
    if (["completed", "failed"].includes(response.body.status)) return response.body;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Run ${runId} did not finish.`);
}

function auth() {
  return { Authorization: `Bearer ${TOKEN}` };
}

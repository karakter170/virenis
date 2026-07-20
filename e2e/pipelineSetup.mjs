/* global console, fetch, process */
import { chromium } from "@playwright/test";
import {
  needsAuditedArchive,
  needsAuditedProfileUpdate,
  runtimeAuditRepairCandidate
} from "./runtimeAuditReconciliation.mjs";
import { workspacePayloadDiffers } from "./pipelineSetupReconciliation.js";

const baseURL = process.env.PIPELINE_BASE_URL || "http://localhost:5174";
const storageState = process.env.PIPELINE_STORAGE_STATE || "/tmp/virenis-auth-5174.json";
const owner = process.env.PIPELINE_OWNER_ID || "user_3Gk2rrG6V0luGDrLYfoB6mBi84b";

export const meaningfulAgentIds = [
  "divergent_ideas_agent_copy_1136defa",
  "perspective_shift_agent_copy_e01172ac",
  "report_d042998e",
  "resume_7_1_260629_221302_1_fe7881a7",
  "finance_reasoning",
  "ai_skeptic_8a2e3280",
  "solution_brainstormer_35b3a384",
  "ai_advocate_2635a7eaa9",
  "ai_engineer_446157aa",
  "backend_agent_e54e40ce",
  "business_analyst",
  "business_analyst_b58a83b97d",
  "composer_agent_673c91b9",
  "critic_agent_3fc91394",
  "custom_rjsfcke",
  "devil_s_advocate_5d787b6e",
  "emotional_poet_78c8297e",
  "entrepreneurial_strategist_d1eb5f6555",
  "financial_analysis_14e44ddf75",
  "frontend_developer_c0dfb5da",
  "industry_research_a633dc3a",
  "market_researcher_71c4134e56",
  "math_tutor_cc062100d7",
  "poetry_critic_d7dab01c",
  "product_manager_c076d6c614",
  "python_tech_strategist_25660909",
  "renault_market_analyst_25222d0b",
  "ui_specialist_c72b37f5",
  "feasibility_originality_agent_copy_f0cb6594",
  "brainstorming_facilitator_agent_copy_6cf6696c"
];

export const junkAgentIds = [
  "asasas_copy_7c226080",
  "custom_rkd30de",
  "custom_rmarmjm",
  "qwdqwdqd_copy_a896eaaf"
];

export const unusableAgentIds = ["readme_agent"];

export const auditedProfileAgentIds = [
  "math_tutor_cc062100d7",
  "backend_agent_e54e40ce",
  "composer_agent_673c91b9",
  "critic_agent_3fc91394",
  "custom_rjsfcke",
  "emotional_poet_78c8297e",
  "poetry_critic_d7dab01c",
  "ai_skeptic_8a2e3280",
  "solution_brainstormer_35b3a384",
  "ai_advocate_2635a7eaa9",
  "devil_s_advocate_5d787b6e",
  "business_analyst_b58a83b97d",
  "entrepreneurial_strategist_d1eb5f6555",
  "renault_market_analyst_25222d0b",
  "ui_specialist_c72b37f5",
  "frontend_developer_c0dfb5da",
  "product_manager_c076d6c614",
  "python_tech_strategist_25660909",
  "industry_research_a633dc3a",
  "financial_analysis_14e44ddf75",
  "brainstorming_facilitator_agent_copy_6cf6696c"
];

export const benchmarkTeams = {
  "E2E Strategy": [
    "divergent_ideas_agent_copy_1136defa",
    "perspective_shift_agent_copy_e01172ac",
    "ai_skeptic_8a2e3280",
    "solution_brainstormer_35b3a384",
    "ai_advocate_2635a7eaa9",
    "business_analyst",
    "business_analyst_b58a83b97d",
    "market_researcher_71c4134e56",
    "composer_agent_673c91b9",
    "critic_agent_3fc91394",
    "devil_s_advocate_5d787b6e",
    "emotional_poet_78c8297e",
    "poetry_critic_d7dab01c",
    "feasibility_originality_agent_copy_f0cb6594",
    "brainstorming_facilitator_agent_copy_6cf6696c",
    "custom_rjsfcke"
  ],
  "E2E Tech": [
    "ai_engineer_446157aa",
    "backend_agent_e54e40ce",
    "frontend_developer_c0dfb5da",
    "ui_specialist_c72b37f5",
    "product_manager_c076d6c614",
    "business_analyst",
    "entrepreneurial_strategist_d1eb5f6555",
    "renault_market_analyst_25222d0b",
    "python_tech_strategist_25660909",
    "industry_research_a633dc3a",
    "financial_analysis_14e44ddf75",
    "finance_reasoning",
    "math_tutor_cc062100d7",
    "solution_brainstormer_35b3a384",
    "ai_advocate_2635a7eaa9",
    "ai_skeptic_8a2e3280"
  ],
  "E2E Docs": [
    "finance_reasoning",
    "business_analyst",
    "math_tutor_cc062100d7",
    "industry_research_a633dc3a",
    "market_researcher_71c4134e56",
    "custom_rjsfcke",
    "financial_analysis_14e44ddf75"
  ]
};

async function api(page, path, { method = "GET", body, headers = {} } = {}) {
  const response = await page.evaluate(async ({ path, method, body, headers }) => {
    const result = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...headers
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const text = await result.text();
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch { payload = { raw: text }; }
    return { ok: result.ok, status: result.status, payload };
  }, { path, method, body, headers });
  if (!response.ok) {
    const error = new Error(`${method} ${path} failed (${response.status}): ${JSON.stringify(response.payload)}`);
    error.status = response.status;
    error.payload = response.payload;
    throw error;
  }
  return response.payload;
}

async function mapLimit(items, limit, callback) {
  const results = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await callback(items[index], index);
    }
  }));
  return results;
}

function sameList(left, right) {
  return JSON.stringify(left || []) === JSON.stringify(right || []);
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ storageState });
  const page = await context.newPage();
  const operations = [];
  try {
    await page.goto(`${baseURL}/app`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    try {
      await page.locator('textarea[role="combobox"]').waitFor({ timeout: 45_000 });
    } catch {
      await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.locator('textarea[role="combobox"]').waitFor({ timeout: 45_000 });
    }

    const preflightIntents = await api(page, "/api/admin/runtime-lifecycle/intents");
    if ((preflightIntents.intents || []).length) {
      throw new Error(`Unresolved lifecycle intents: ${JSON.stringify(preflightIntents.intents)}`);
    }

    let catalog = await api(page, "/api/agents?limit=500");
    const byId = new Map(catalog.agents.map((agent) => [agent.id, agent]));
    const missing = [...meaningfulAgentIds, ...junkAgentIds, ...unusableAgentIds].filter((id) => !byId.has(id));
    if (missing.length) throw new Error(`Runtime catalog is missing expected agents: ${missing.join(", ")}`);

    const adoptionTargets = [...meaningfulAgentIds, ...junkAgentIds, ...unusableAgentIds]
      .filter((id) => byId.get(id)?.runtime_only === true);
    await mapLimit(adoptionTargets, 4, async (id) => {
      await api(page, `/api/admin/runtime-agents/${encodeURIComponent(id)}/adopt`, {
        method: "POST",
        headers: { "Idempotency-Key": `pipeline-e2e-adopt-${id}-20260719` },
        body: { created_by: owner, visibility: "private" }
      });
      operations.push({ operation: "adopt", id });
    });

    catalog = await api(page, "/api/agents?limit=500");
    const adoptedById = new Map(catalog.agents.map((agent) => [agent.id, agent]));
    // The real-Runtime catalog overlays current manifest values onto local
    // ownership records. An out-of-band manifest edit can therefore look
    // profile-complete while lacking a matching audit receipt. Route that one
    // exact drift case through the normal journaled PATCH lifecycle so Runtime
    // records a new update receipt; the registration binding remains immutable.
    const auditRepairIds = new Set((await mapLimit([
      ...auditedProfileAgentIds,
      ...junkAgentIds
    ], 4, (id) =>
      runtimeAuditRepairCandidate(id, (agentId) =>
        api(page, `/api/admin/agents/${encodeURIComponent(agentId)}/runtime-audit`)
      )
    )).filter(Boolean));

    const mathPatch = {
      capability: "Teach algebra step by step and check current public curriculum sources when needed.",
      routing_cues: ["Math Tutor", "math tutoring", "algebra", "calculus", "derivative of x", "step-by-step math", "practice problems", "public curriculum"],
      tools: ["calculator", "web_search"],
      policies: {
        activation_policy: "Activate math_tutor_cc062100d7 only when the request needs math tutoring, step-by-step problem solving, or curriculum guidance.",
        tool_policy: "Use calculator to verify arithmetic and web_search only when current public curriculum information is needed."
      }
    };
    const math = adoptedById.get("math_tutor_cc062100d7");
    if (needsAuditedProfileUpdate({
      agentId: "math_tutor_cc062100d7",
      profileDiffers: math?.capability !== mathPatch.capability || !sameList(math?.routing_cues, mathPatch.routing_cues),
      auditRepairIds
    })) {
      await api(page, "/api/agents/math_tutor_cc062100d7", { method: "PATCH", body: mathPatch });
      operations.push({ operation: "update", id: "math_tutor_cc062100d7" });
    }

    const financeReasoning = adoptedById.get("finance_reasoning");
    const financeReasoningPatch = {
      consumes: ["user_request", "shared_memory", "financial_context", "evidence_summary"]
    };
    if (needsAuditedProfileUpdate({
      agentId: "finance_reasoning",
      profileDiffers: !sameList(financeReasoning?.consumes, financeReasoningPatch.consumes),
      auditRepairIds
    })) {
      await api(page, "/api/agents/finance_reasoning", { method: "PATCH", body: financeReasoningPatch });
      operations.push({ operation: "update", id: "finance_reasoning" });
    }

    const writerPatch = {
      title: "Audience-Focused Writer",
      consumes: ["user_request", "shared_memory", "upstream_route_outputs"],
      routing_cues: [
        "Audience-Focused Writer",
        "audience-focused writing",
        "concise writing",
        "rewrite source material",
        "edit for clarity",
        "synthesize source material",
        "board update",
        "turn notes into board update"
      ],
      policies: {
        ...(adoptedById.get("custom_rjsfcke")?.policies || {}),
        activation_policy: "Activate custom_rjsfcke only when the request needs audience-focused writing, editing, or source-material synthesis."
      }
    };
    const writer = adoptedById.get("custom_rjsfcke");
    if (needsAuditedProfileUpdate({
      agentId: "custom_rjsfcke",
      profileDiffers: writer?.title !== writerPatch.title
        || !sameList(writer?.consumes, writerPatch.consumes)
        || !sameList(writer?.routing_cues, writerPatch.routing_cues),
      auditRepairIds
    })) {
      await api(page, "/api/agents/custom_rjsfcke", { method: "PATCH", body: writerPatch });
      operations.push({ operation: "update", id: "custom_rjsfcke" });
    }

    const backendAgent = adoptedById.get("backend_agent_e54e40ce");
    const backendPatch = {
      routing_cues: [
        "Backend Agent",
        "backend architecture",
        "backend services",
        "backend scalability",
        "infrastructure planning",
        "backend data flow"
      ]
    };
    if (needsAuditedProfileUpdate({
      agentId: "backend_agent_e54e40ce",
      profileDiffers: !sameList(backendAgent?.routing_cues, backendPatch.routing_cues),
      auditRepairIds
    })) {
      await api(page, "/api/agents/backend_agent_e54e40ce", { method: "PATCH", body: backendPatch });
      operations.push({ operation: "update", id: "backend_agent_e54e40ce" });
    }

    const composer = adoptedById.get("composer_agent_673c91b9");
    const composerPatch = {
      consumes: ["user_request", "shared_memory"],
      routing_cues: [
        "Composer Agent",
        "original composition",
        "original music",
        "brand theme",
        "jingle",
        "instrumental",
        "sixteen-bar instrumental"
      ]
    };
    if (needsAuditedProfileUpdate({
      agentId: "composer_agent_673c91b9",
      profileDiffers: !sameList(composer?.consumes, composerPatch.consumes)
        || !sameList(composer?.routing_cues, composerPatch.routing_cues),
      auditRepairIds
    })) {
      await api(page, "/api/agents/composer_agent_673c91b9", { method: "PATCH", body: composerPatch });
      operations.push({ operation: "update", id: "composer_agent_673c91b9" });
    }

    const compositionCritic = adoptedById.get("critic_agent_3fc91394");
    const compositionCriticPatch = {
      consumes: ["user_request", "shared_memory", "upstream_route_outputs"],
      routing_cues: [
        "Critic Agent",
        "critique composition",
        "composition critique",
        "structure and style feedback",
        "constructive composition feedback",
        "review supplied composition"
      ]
    };
    if (needsAuditedProfileUpdate({
      agentId: "critic_agent_3fc91394",
      profileDiffers: !sameList(compositionCritic?.consumes, compositionCriticPatch.consumes)
        || !sameList(compositionCritic?.routing_cues, compositionCriticPatch.routing_cues),
      auditRepairIds
    })) {
      await api(page, "/api/agents/critic_agent_3fc91394", { method: "PATCH", body: compositionCriticPatch });
      operations.push({ operation: "update", id: "critic_agent_3fc91394" });
    }

    const emotionalPoet = adoptedById.get("emotional_poet_78c8297e");
    const emotionalPoetPatch = {
      consumes: ["user_request", "shared_memory"],
      routing_cues: [
        "Emotional Poet",
        "write a poem",
        "compose poem",
        "emotional poem",
        "poetic composition",
        "poem theme"
      ]
    };
    if (needsAuditedProfileUpdate({
      agentId: "emotional_poet_78c8297e",
      profileDiffers: !sameList(emotionalPoet?.consumes, emotionalPoetPatch.consumes)
        || !sameList(emotionalPoet?.routing_cues, emotionalPoetPatch.routing_cues),
      auditRepairIds
    })) {
      await api(page, "/api/agents/emotional_poet_78c8297e", { method: "PATCH", body: emotionalPoetPatch });
      operations.push({ operation: "update", id: "emotional_poet_78c8297e" });
    }

    const poetryCritic = adoptedById.get("poetry_critic_d7dab01c");
    const poetryCriticPatch = {
      consumes: ["user_request", "shared_memory", "upstream_route_outputs"],
      routing_cues: [
        "Poetry Critic",
        "critique poem",
        "evaluate poem",
        "literary critique",
        "poem structure and merit",
        "review supplied poem"
      ]
    };
    if (needsAuditedProfileUpdate({
      agentId: "poetry_critic_d7dab01c",
      profileDiffers: !sameList(poetryCritic?.consumes, poetryCriticPatch.consumes)
        || !sameList(poetryCritic?.routing_cues, poetryCriticPatch.routing_cues),
      auditRepairIds
    })) {
      await api(page, "/api/agents/poetry_critic_d7dab01c", { method: "PATCH", body: poetryCriticPatch });
      operations.push({ operation: "update", id: "poetry_critic_d7dab01c" });
    }

    const aiSkepticPatch = {
      routing_cues: [
        "AI Skeptic",
        "argue AI irrelevance",
        "AI criticism",
        "case against buying an AI customer-service platform"
      ]
    };
    const aiSkeptic = adoptedById.get("ai_skeptic_8a2e3280");
    if (needsAuditedProfileUpdate({
      agentId: "ai_skeptic_8a2e3280",
      profileDiffers: !sameList(aiSkeptic?.routing_cues, aiSkepticPatch.routing_cues),
      auditRepairIds
    })) {
      await api(page, "/api/agents/ai_skeptic_8a2e3280", {
        method: "PATCH",
        body: aiSkepticPatch
      });
      operations.push({ operation: "update", id: "ai_skeptic_8a2e3280" });
    }

    const solutionBrainstormerPatch = {
      stage: 60,
      routing_cues: [
        "Brainstormer",
        "synthesize solution",
        "integrate perspectives",
        "Solution Brainstormer",
        "Brainstorm a practical solution or perspective that integrates insights from both the AI advocate and the skeptic",
        "reconciles the strongest pro-AI and anti-AI arguments",
        "synthesize a safe measurable pilot"
      ]
    };
    const solutionBrainstormer = adoptedById.get("solution_brainstormer_35b3a384");
    if (needsAuditedProfileUpdate({
      agentId: "solution_brainstormer_35b3a384",
      profileDiffers: !sameList(
        solutionBrainstormer?.routing_cues,
        solutionBrainstormerPatch.routing_cues
      ) || Number(solutionBrainstormer?.stage) !== solutionBrainstormerPatch.stage,
      auditRepairIds
    })) {
      await api(page, "/api/agents/solution_brainstormer_35b3a384", {
        method: "PATCH",
        body: solutionBrainstormerPatch
      });
      operations.push({ operation: "update", id: "solution_brainstormer_35b3a384" });
    }

    const aiAdvocatePatch = {
      routing_cues: [
        "AI Advocate",
        "defend AI",
        "AI relevance",
        "AI impact analysis and advocacy",
        "Argue that artificial intelligence is highly relevant and transformative, citing current trends and applications",
        "case for using AI",
        "case for AI",
        "AI-assisted quality inspection"
      ]
    };
    const aiAdvocate = adoptedById.get("ai_advocate_2635a7eaa9");
    if (needsAuditedProfileUpdate({
      agentId: "ai_advocate_2635a7eaa9",
      profileDiffers: !sameList(aiAdvocate?.routing_cues, aiAdvocatePatch.routing_cues),
      auditRepairIds
    })) {
      await api(page, "/api/agents/ai_advocate_2635a7eaa9", {
        method: "PATCH",
        body: aiAdvocatePatch
      });
      operations.push({ operation: "update", id: "ai_advocate_2635a7eaa9" });
    }

    const devilAdvocatePatch = {
      routing_cues: [
        "Devil's Advocate",
        "counter-arguments",
        "critical perspectives",
        "challenge both sides"
      ]
    };
    const devilAdvocate = adoptedById.get("devil_s_advocate_5d787b6e");
    if (needsAuditedProfileUpdate({
      agentId: "devil_s_advocate_5d787b6e",
      profileDiffers: !sameList(
        devilAdvocate?.routing_cues,
        devilAdvocatePatch.routing_cues
      ),
      auditRepairIds
    })) {
      await api(page, "/api/agents/devil_s_advocate_5d787b6e", {
        method: "PATCH",
        body: devilAdvocatePatch
      });
      operations.push({ operation: "update", id: "devil_s_advocate_5d787b6e" });
    }

    const researchWorkflowActivationPolicy = "Activate only when the named Research and Analysis Workflow is requested or when a validated market-research handoff must be synthesized into an analysis report.";
    const researchWorkflowPatch = {
      title: "Research Workflow Analyst",
      capability: "Synthesizes validated market-research handoffs into decision-oriented analysis reports for the Research and Analysis Workflow.",
      boundary: "Requires the configured market-research handoff for evidence-dependent findings; label gaps and do not invent sources or primary-research results.",
      routing_cues: [
        "Research and Analysis Workflow",
        "synthesize market-research findings",
        "decision-oriented analysis report",
        "upstream research handoff"
      ],
      policies: {
        activation_policy: researchWorkflowActivationPolicy
      }
    };
    const researchWorkflow = adoptedById.get("business_analyst_b58a83b97d");
    if (needsAuditedProfileUpdate({
      agentId: "business_analyst_b58a83b97d",
      profileDiffers: researchWorkflow?.title !== researchWorkflowPatch.title
        || researchWorkflow?.capability !== researchWorkflowPatch.capability
        || !sameList(researchWorkflow?.routing_cues, researchWorkflowPatch.routing_cues)
        || researchWorkflow?.policies?.activation_policy !== researchWorkflowActivationPolicy,
      auditRepairIds
    })) {
      await api(page, "/api/agents/business_analyst_b58a83b97d", {
        method: "PATCH",
        body: researchWorkflowPatch
      });
      operations.push({ operation: "update", id: "business_analyst_b58a83b97d" });
    }

    const entrepreneurialPatch = {
      title: "Entrepreneurial Strategist",
      capability: "Assesses and develops assumption-labeled, low-cost startup launch strategies for early-stage and neighborhood businesses, including customer hypotheses, lean operations, go-to-market sequencing, and small validation experiments.",
      boundary: "Focus on startup launch hypotheses and practical experiments. Separate assumptions from evidence. Treat market validation, technical feasibility, and automotive claims as unverified unless supported by approved inputs.",
      consumes: ["user_request"],
      routing_cues: [
        "startup strategy",
        "entrepreneurial launch plan",
        "customer discovery",
        "lean operations",
        "bootstrapped go-to-market",
        "startup validation experiments",
        "neighborhood business",
        "low-cost go-to-market plan",
        "repair service",
        "neighborhood"
      ],
      policies: {
        activation_policy: "Activate for early-stage venture strategy, lean launch design, customer discovery, bootstrapped go-to-market, or validation experiments.",
        source_policy: "No private source access is approved; label current-market evidence gaps and never invent validation.",
        tool_policy: "Do not request tools for this route."
      }
    };
    const entrepreneurial = adoptedById.get("entrepreneurial_strategist_d1eb5f6555");
    if (needsAuditedProfileUpdate({
      agentId: "entrepreneurial_strategist_d1eb5f6555",
      profileDiffers: entrepreneurial?.title !== entrepreneurialPatch.title
        || entrepreneurial?.capability !== entrepreneurialPatch.capability
        || entrepreneurial?.boundary !== entrepreneurialPatch.boundary
        || !sameList(entrepreneurial?.consumes, entrepreneurialPatch.consumes)
        || !sameList(entrepreneurial?.routing_cues, entrepreneurialPatch.routing_cues),
      auditRepairIds
    })) {
      await api(page, "/api/agents/entrepreneurial_strategist_d1eb5f6555", {
        method: "PATCH",
        body: entrepreneurialPatch
      });
      operations.push({ operation: "update", id: "entrepreneurial_strategist_d1eb5f6555" });
    }

    const renaultAnalyst = adoptedById.get("renault_market_analyst_25222d0b");
    const renaultActivationPolicy = "Activate renault_market_analyst_25222d0b for compare supplied Renault base and downside market assumptions or analyze Renault automotive markets.";
    const renaultPatch = {
      capability: "Analyzes Renault and automotive markets and compares supplied base and downside assumptions, trends, competitive landscape, and opportunities without presenting unsupported claims as current evidence.",
      routing_cues: [
        "Renault Market Analyst",
        "renault",
        "Renault market assumptions",
        "Renault automotive market",
        "Renault EV pilot",
        "Renault competitive landscape",
        "Renault market opportunities"
      ],
      policies: {
        ...(renaultAnalyst?.policies || {}),
        activation_policy: renaultActivationPolicy
      }
    };
    if (needsAuditedProfileUpdate({
      agentId: "renault_market_analyst_25222d0b",
      profileDiffers: renaultAnalyst?.capability !== renaultPatch.capability
        || !sameList(renaultAnalyst?.routing_cues, renaultPatch.routing_cues)
        || renaultAnalyst?.policies?.activation_policy !== renaultActivationPolicy,
      auditRepairIds
    })) {
      await api(page, "/api/agents/renault_market_analyst_25222d0b", {
        method: "PATCH",
        body: renaultPatch
      });
      operations.push({ operation: "update", id: "renault_market_analyst_25222d0b" });
    }

    const uiPatch = {
      capability: "Creates detailed UI/UX specifications covering layout, components, interaction flows, user actions, interface states, accessibility, and error handling.",
      consumes: ["user_request", "shared_memory"],
      routing_cues: [
        "UI Specialist",
        "UI specification",
        "UX specification",
        "interface layout",
        "interaction flow",
        "interface states",
        "accessibility and error handling"
      ]
    };
    const uiSpecialist = adoptedById.get("ui_specialist_c72b37f5");
    if (needsAuditedProfileUpdate({
      agentId: "ui_specialist_c72b37f5",
      profileDiffers: uiSpecialist?.capability !== uiPatch.capability
        || !sameList(uiSpecialist?.consumes, uiPatch.consumes)
        || !sameList(uiSpecialist?.routing_cues, uiPatch.routing_cues),
      auditRepairIds
    })) {
      await api(page, "/api/agents/ui_specialist_c72b37f5", { method: "PATCH", body: uiPatch });
      operations.push({ operation: "update", id: "ui_specialist_c72b37f5" });
    }

    const frontendPatch = {
      capability: "Creates and implements accessible frontend interfaces and code from validated UI specifications, including HTML, CSS, interaction states, and client-side validation."
    };
    const frontendDeveloper = adoptedById.get("frontend_developer_c0dfb5da");
    if (needsAuditedProfileUpdate({
      agentId: "frontend_developer_c0dfb5da",
      profileDiffers: frontendDeveloper?.capability !== frontendPatch.capability,
      auditRepairIds
    })) {
      await api(page, "/api/agents/frontend_developer_c0dfb5da", { method: "PATCH", body: frontendPatch });
      operations.push({ operation: "update", id: "frontend_developer_c0dfb5da" });
    }

    const productPatch = {
      capability: "Plans bounded product betas and prioritizes user-centered scope, acceptance criteria, rollout constraints such as low training effort, and launch risks.",
      routing_cues: [
        "Product Manager",
        "Business Critique",
        "business analysis",
        "business plan",
        "customer",
        "operations",
        "market research",
        "go-to-market",
        "Textile Product Brainstorm & Critique",
        "AI Project Team Assembly",
        "beta",
        "prioritize",
        "product scope",
        "scope prioritization",
        "training effort",
        "acceptance criteria",
        "launch risks"
      ]
    };
    const productManager = adoptedById.get("product_manager_c076d6c614");
    if (needsAuditedProfileUpdate({
      agentId: "product_manager_c076d6c614",
      profileDiffers: productManager?.capability !== productPatch.capability
        || !sameList(productManager?.routing_cues, productPatch.routing_cues),
      auditRepairIds
    })) {
      await api(page, "/api/agents/product_manager_c076d6c614", { method: "PATCH", body: productPatch });
      operations.push({ operation: "update", id: "product_manager_c076d6c614" });
    }

    const pythonPatch = {
      capability: "Compares Python ecosystem options for software services and analyzes library selection, maintenance, deployment, and integration tradeoffs."
    };
    const pythonStrategist = adoptedById.get("python_tech_strategist_25660909");
    if (needsAuditedProfileUpdate({
      agentId: "python_tech_strategist_25660909",
      profileDiffers: pythonStrategist?.capability !== pythonPatch.capability,
      auditRepairIds
    })) {
      await api(page, "/api/agents/python_tech_strategist_25660909", { method: "PATCH", body: pythonPatch });
      operations.push({ operation: "update", id: "python_tech_strategist_25660909" });
    }

    const industryResearch = adoptedById.get("industry_research_a633dc3a");
    const industryActivationPolicy = "Activate industry_research_a633dc3a for compare supplied industry or market evidence, or research industry structure, trends, key players, and structural risks.";
    const industryPatch = {
      capability: "Researches industry structure and compares supplied market evidence, trends, key players, and structural risks.",
      routing_cues: [
        "Industry Research",
        "industry structure",
        "industry trends",
        "key industry players",
        "structural industry risks",
        "market evidence comparison",
        "automotive industry research",
        "research European aftermarket demand"
      ],
      policies: {
        ...(industryResearch?.policies || {}),
        activation_policy: industryActivationPolicy
      }
    };
    if (needsAuditedProfileUpdate({
      agentId: "industry_research_a633dc3a",
      profileDiffers: industryResearch?.capability !== industryPatch.capability
        || !sameList(industryResearch?.routing_cues, industryPatch.routing_cues)
        || industryResearch?.policies?.activation_policy !== industryActivationPolicy,
      auditRepairIds
    })) {
      await api(page, "/api/agents/industry_research_a633dc3a", { method: "PATCH", body: industryPatch });
      operations.push({ operation: "update", id: "industry_research_a633dc3a" });
    }

    const financialAnalysis = adoptedById.get("financial_analysis_14e44ddf75");
    const financialActivationPolicy = "Activate financial_analysis_14e44ddf75 for produce assumption-labeled financial scenarios or generate financial scenario outputs.";
    const financialPatch = {
      capability: "Builds assumption-labeled financial scenarios from user-provided constraints, authorized conversation context, or validated upstream research and compares revenue, margin, volume, and downside tradeoffs.",
      consumes: ["user_request", "shared_memory", "upstream_route_outputs"],
      produces: ["financial_analysis_report", "financial_scenario"],
      routing_cues: [
        "Financial Analysis",
        "financial scenario",
        "assumption-labeled financial scenario",
        "financial downside case",
        "financial downside scenario",
        "finance",
        "financial analysis",
        "cash flow",
        "valuation",
        "economy",
        "inflation",
        "interest rate",
        "economic outlook",
        "Automotive Industry Research & Financial Analysis"
      ],
      policies: {
        ...(financialAnalysis?.policies || {}),
        activation_policy: financialActivationPolicy
      }
    };
    if (needsAuditedProfileUpdate({
      agentId: "financial_analysis_14e44ddf75",
      profileDiffers: financialAnalysis?.capability !== financialPatch.capability
        || !sameList(financialAnalysis?.consumes, financialPatch.consumes)
        || !sameList(financialAnalysis?.produces, financialPatch.produces)
        || !sameList(financialAnalysis?.routing_cues, financialPatch.routing_cues)
        || financialAnalysis?.policies?.activation_policy !== financialActivationPolicy,
      auditRepairIds
    })) {
      await api(page, "/api/agents/financial_analysis_14e44ddf75", {
        method: "PATCH",
        body: financialPatch
      });
      operations.push({ operation: "update", id: "financial_analysis_14e44ddf75" });
    }

    const brainstormingFacilitator = adoptedById.get("brainstorming_facilitator_agent_copy_6cf6696c");
    const facilitatorActivationPolicy = "Activate for brainstorming summary, best ideas, concept shortlist, creative recommendation, shortlist rationale, or small next experiments.";
    const brainstormingFacilitatorPatch = {
      routing_cues: [
        "brainstorming summary",
        "best ideas",
        "concept shortlist",
        "creative recommendation",
        "brainstorming facilitator",
        "shortlist with rationale",
        "small experiments",
        "recommend three experiments"
      ],
      policies: {
        ...(brainstormingFacilitator?.policies || {}),
        activation_policy: facilitatorActivationPolicy
      }
    };
    if (needsAuditedProfileUpdate({
      agentId: "brainstorming_facilitator_agent_copy_6cf6696c",
      profileDiffers: !sameList(
        brainstormingFacilitator?.routing_cues,
        brainstormingFacilitatorPatch.routing_cues
      ) || brainstormingFacilitator?.policies?.activation_policy !== facilitatorActivationPolicy,
      auditRepairIds
    })) {
      await api(page, "/api/agents/brainstorming_facilitator_agent_copy_6cf6696c", {
        method: "PATCH",
        body: brainstormingFacilitatorPatch
      });
      operations.push({ operation: "update", id: "brainstorming_facilitator_agent_copy_6cf6696c" });
    }

    catalog = await api(page, "/api/agents?limit=500");
    const currentById = new Map(catalog.agents.map((agent) => [agent.id, agent]));
    for (const id of [...junkAgentIds, ...unusableAgentIds]) {
      if (needsAuditedArchive({
        agentId: id,
        enabled: currentById.get(id)?.enabled,
        auditRepairIds
      })) {
        await api(page, `/api/agents/${encodeURIComponent(id)}`, { method: "DELETE" });
        operations.push({ operation: "archive", id });
      }
    }

    const existing = await api(page, "/api/agent-workspaces");
    const workspaces = [];
    for (const [name, agentIds] of Object.entries(benchmarkTeams)) {
      const found = (existing.workspaces || []).find((workspace) => workspace.name === name);
      const payload = { name, description: `Isolated browser benchmark team: ${name}.`, agent_ids: agentIds };
      let workspace = found;
      if (!found) {
        workspace = await api(page, "/api/agent-workspaces", { method: "POST", body: payload });
        operations.push({ operation: "create_team", id: workspace.agent_workspace_id, name });
      } else if (workspacePayloadDiffers(found, payload)) {
        workspace = await api(
          page,
          `/api/agent-workspaces/${encodeURIComponent(found.agent_workspace_id)}`,
          { method: "PATCH", body: payload }
        );
        operations.push({ operation: "update_team", id: workspace.agent_workspace_id, name });
      }
      workspaces.push(workspace);
    }

    const verification = {};
    for (const id of [
      ...auditedProfileAgentIds,
      ...junkAgentIds,
      ...unusableAgentIds
    ]) {
      const events = await api(page, `/api/agents/${encodeURIComponent(id)}/events`);
      let audit = null;
      let runtimeAuditUnavailable = null;
      try {
        audit = await api(page, `/api/admin/agents/${encodeURIComponent(id)}/runtime-audit`);
      } catch (error) {
        // Built-in global agents predate adoption receipts. Their local and
        // Runtime archive events remain authoritative, but no adoption binding
        // exists to validate.
        if (unusableAgentIds.includes(id) && error.status === 409) runtimeAuditUnavailable = error.message;
        else throw error;
      }
      verification[id] = {
        event_chain_valid: events.event_chain_valid,
        latest_event: events.events?.at(-1)?.event_type || null,
        binding_valid: audit?.binding_valid ?? null,
        latest_runtime_operation: audit?.receipts?.at(-1)?.operation || audit?.latest_receipt?.operation || null,
        runtime_audit_unavailable: runtimeAuditUnavailable
      };
    }
    const postflightIntents = await api(page, "/api/admin/runtime-lifecycle/intents");
    if ((postflightIntents.intents || []).length) {
      throw new Error(`Lifecycle intents remain after setup: ${JSON.stringify(postflightIntents.intents)}`);
    }

    console.log(JSON.stringify({
      ok: true,
      baseURL,
      adopted: adoptionTargets.length,
      operations,
      teams: workspaces.map((workspace) => ({
        id: workspace.agent_workspace_id,
        name: workspace.name,
        agent_count: workspace.agent_count,
        agent_ids: workspace.agent_ids
      })),
      verification
    }, null, 2));
  } finally {
    await browser.close();
  }
}

await main();

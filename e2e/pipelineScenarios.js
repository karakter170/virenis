// Stable, reusable benchmark inputs for the web pipeline. This module contains
// data only; execution, polling, scoring, and screenshots belong in a runner.

export const AGENT_IDS = Object.freeze({
  divergentIdeas: "divergent_ideas_agent_copy_1136defa",
  perspectiveShift: "perspective_shift_agent_copy_e01172ac",
  reportDocument: "report_d042998e",
  resumeDocument: "resume_7_1_260629_221302_1_fe7881a7",
  financeReasoning: "finance_reasoning",
  aiSkeptic: "ai_skeptic_8a2e3280",
  solutionBrainstormer: "solution_brainstormer_35b3a384",
  aiAdvocate: "ai_advocate_2635a7eaa9",
  aiEngineer: "ai_engineer_446157aa",
  backend: "backend_agent_e54e40ce",
  businessAnalyst: "business_analyst",
  researchBusinessAnalyst: "business_analyst_b58a83b97d",
  composer: "composer_agent_673c91b9",
  compositionCritic: "critic_agent_3fc91394",
  conciseWriter: "custom_rjsfcke",
  devilsAdvocate: "devil_s_advocate_5d787b6e",
  emotionalPoet: "emotional_poet_78c8297e",
  entrepreneurialStrategist: "entrepreneurial_strategist_d1eb5f6555",
  financialAnalysis: "financial_analysis_14e44ddf75",
  frontend: "frontend_developer_c0dfb5da",
  industryResearch: "industry_research_a633dc3a",
  marketResearcher: "market_researcher_71c4134e56",
  mathTutor: "math_tutor_cc062100d7",
  poetryCritic: "poetry_critic_d7dab01c",
  productManager: "product_manager_c076d6c614",
  pythonStrategist: "python_tech_strategist_25660909",
  readme: "readme_agent",
  renaultAnalyst: "renault_market_analyst_25222d0b",
  uiSpecialist: "ui_specialist_c72b37f5",
  feasibility: "feasibility_originality_agent_copy_f0cb6594",
  brainstormingFacilitator: "brainstorming_facilitator_agent_copy_6cf6696c"
});

export const UNUSABLE_AGENT_DENYLIST = Object.freeze([AGENT_IDS.readme]);

export const MEANINGFUL_AGENT_IDS = Object.freeze(
  Object.values(AGENT_IDS).filter((agentId) => !UNUSABLE_AGENT_DENYLIST.includes(agentId))
);

// Document-backed agents are globally scoped knowledge resources. The product
// intentionally keeps them out of editable team membership while making them
// eligible for sessions that can access their source.
export const GLOBAL_DOCUMENT_AGENT_IDS = Object.freeze([
  AGENT_IDS.reportDocument,
  AGENT_IDS.resumeDocument
]);

export const JUNK_AGENT_DENYLIST = Object.freeze([
  "asasas_copy_7c226080",
  "custom_rkd30de",
  "custom_rmarmjm",
  "qwdqwdqd_copy_a896eaaf"
]);

const A = AGENT_IDS;

export const AGENT_TEAMS = Object.freeze({
  e2e_strategy: team("e2e_strategy", "E2E Strategy", [
    A.divergentIdeas,
    A.perspectiveShift,
    A.aiSkeptic,
    A.solutionBrainstormer,
    A.aiAdvocate,
    A.businessAnalyst,
    A.researchBusinessAnalyst,
    A.marketResearcher,
    A.composer,
    A.compositionCritic,
    A.devilsAdvocate,
    A.emotionalPoet,
    A.poetryCritic,
    A.feasibility,
    A.brainstormingFacilitator,
    A.conciseWriter
  ]),
  e2e_tech: team("e2e_tech", "E2E Tech", [
    A.aiEngineer,
    A.backend,
    A.frontend,
    A.uiSpecialist,
    A.productManager,
    A.businessAnalyst,
    A.entrepreneurialStrategist,
    A.renaultAnalyst,
    A.pythonStrategist,
    A.industryResearch,
    A.financialAnalysis,
    A.financeReasoning,
    A.mathTutor,
    A.solutionBrainstormer,
    A.aiAdvocate,
    A.aiSkeptic
  ]),
  e2e_docs: team("e2e_docs", "E2E Docs", [
    A.financeReasoning,
    A.businessAnalyst,
    A.mathTutor,
    A.industryResearch,
    A.marketResearcher,
    A.conciseWriter,
    A.financialAnalysis
  ])
});

function team(id, title, agentIds) {
  return Object.freeze({ id, name: title, title, agentIds: Object.freeze([...agentIds]) });
}

function scenario({
  id,
  category,
  team: teamId,
  prompt,
  expectedDecision = "delegate",
  requiredAgents = [],
  allowedAgents = requiredAgents,
  forbiddenAgents = [],
  turnGroup = id,
  turn = 1,
  needsAttachment = false,
  oracleHints
}) {
  return Object.freeze({
    id,
    category,
    team: teamId,
    prompt,
    expectedDecision,
    requiredAgents: Object.freeze([...new Set(requiredAgents)]),
    allowedAgents: Object.freeze([...new Set(allowedAgents)]),
    forbiddenAgents: Object.freeze([...new Set([
      ...JUNK_AGENT_DENYLIST,
      ...UNUSABLE_AGENT_DENYLIST,
      ...forbiddenAgents
    ])]),
    turnGroup,
    turn,
    needsAttachment,
    oracleHints: Object.freeze([...oracleHints])
  });
}

export const PIPELINE_SCENARIOS = Object.freeze([
  scenario({
    id: "auto_divergent_cost_savings",
    category: "automatic_routing",
    team: "e2e_strategy",
    prompt: "Generate twelve meaningfully different ways a city library could reduce energy costs without shortening opening hours.",
    requiredAgents: [A.divergentIdeas],
    oracleHints: ["Twelve distinct concepts", "Preserve opening hours"]
  }),
  scenario({
    id: "auto_perspective_accessibility",
    category: "automatic_routing",
    team: "e2e_strategy",
    prompt: "Reframe the problem of low museum attendance through the perspectives of teenagers, caregivers, and night-shift workers.",
    requiredAgents: [A.perspectiveShift],
    oracleHints: ["Three named perspectives", "Reframes rather than solution list"]
  }),
  scenario({
    id: "doc_quarterly_report_risks",
    category: "document_routing",
    team: "e2e_docs",
    prompt: "Using only the attached Phase209 report, extract route exact, route recall, and route precision, then cite the supporting passages.",
    requiredAgents: [],
    needsAttachment: true,
    oracleHints: ["Route exact 0.7500, recall 0.9722, precision 0.9528", "Citations present"]
  }),
  scenario({
    id: "doc_resume_role_fit",
    category: "document_routing",
    team: "e2e_docs",
    prompt: "Using only the attached resume, extract and cite the passages describing the candidate's data and AI experience.",
    requiredAgents: [],
    needsAttachment: true,
    oracleHints: ["Python, SQL, and visualization evidence", "Machine-learning and AI-training experience"]
  }),
  scenario({
    id: "doc_global_report_agent_metrics",
    category: "document_routing",
    team: "e2e_docs",
    prompt: "Use @report_d042998e to extract route exact, route recall, and route precision from its approved report source, with citations.",
    requiredAgents: [A.reportDocument],
    oracleHints: ["Route exact 0.7500, recall 0.9722, precision 0.9528", "Verified report citation"]
  }),
  scenario({
    id: "doc_global_resume_agent_experience",
    category: "document_routing",
    team: "e2e_docs",
    prompt: "Use @resume_7_1_260629_221302_1_fe7881a7 to extract and cite the candidate's data, visualization, machine-learning, and AI-training experience.",
    requiredAgents: [A.resumeDocument],
    oracleHints: ["Python, SQL, Power BI, Tableau, and Plotly", "Scikit-learn, TensorFlow, PyTorch, and AI training"]
  }),
  scenario({
    id: "auto_finance_runway",
    category: "automatic_routing",
    team: "e2e_tech",
    prompt: "A nonprofit has $480,000 cash, spends $62,000 monthly, and expects a $90,000 grant in month four. Estimate runway and show assumptions.",
    requiredAgents: [A.financeReasoning],
    oracleHints: ["Shows calculation", "Labels timing assumption"]
  }),
  scenario({
    id: "auto_ai_skeptic_procurement",
    category: "automatic_routing",
    team: "e2e_strategy",
    prompt: "Make the strongest skeptical case against buying an AI customer-service platform this quarter.",
    requiredAgents: [A.aiSkeptic],
    oracleHints: ["Concrete limitations", "No invented vendor facts"]
  }),
  scenario({
    id: "auto_ai_balanced_solution",
    category: "automatic_routing",
    team: "e2e_strategy",
    prompt: "Develop a practical pilot that reconciles the strongest pro-AI and anti-AI arguments for hospital appointment reminders.",
    requiredAgents: [A.aiAdvocate, A.aiSkeptic, A.solutionBrainstormer],
    oracleHints: ["Both positions represented", "Bounded pilot with measurement"]
  }),
  scenario({
    id: "auto_ai_advocate_logistics",
    category: "automatic_routing",
    team: "e2e_strategy",
    prompt: "Present the strongest evidence-conscious case for using AI to improve warehouse demand forecasting.",
    requiredAgents: [A.aiAdvocate],
    oracleHints: ["Specific AI benefits", "Caveats unsupported current claims"]
  }),
  scenario({
    id: "auto_ai_engineer_support_triage",
    category: "automatic_routing",
    team: "e2e_tech",
    prompt: "Evaluate model, evaluation-data, and integration choices for an internal support-ticket triage assistant.",
    requiredAgents: [A.aiEngineer],
    oracleHints: ["Model and data plan", "Evaluation and integration risks"]
  }),
  scenario({
    id: "auto_backend_booking_scale",
    category: "automatic_routing",
    team: "e2e_tech",
    prompt: "Design the backend services and data flow for a booking platform that must survive flash-sale traffic.",
    requiredAgents: [A.backend],
    oracleHints: ["Scalability controls", "Data consistency discussed"]
  }),
  scenario({
    id: "auto_business_nonprofit_launch",
    category: "automatic_routing",
    team: "e2e_tech",
    prompt: "Analyze target customers, operating assumptions, and go-to-market risks for a hypothetical nonprofit volunteer-matching service. Use clearly labeled assumptions and do not request or claim current market data.",
    requiredAgents: [A.businessAnalyst],
    oracleHints: ["Customer segments", "Clearly labeled operating and go-to-market assumptions"]
  }),
  scenario({
    id: "auto_research_analysis_workflow",
    category: "automatic_routing",
    team: "e2e_strategy",
    prompt: "Use the Research and Analysis Workflow to assess demand for refill stations in mid-sized grocery stores.",
    requiredAgents: [A.researchBusinessAnalyst],
    oracleHints: ["Decision-oriented research plan", "Evidence gaps labeled"]
  }),
  scenario({
    id: "auto_composer_brand_theme",
    category: "automatic_routing",
    team: "e2e_strategy",
    prompt: "Create an original sixteen-bar instrumental concept inspired by a calm sunrise and a busy train station.",
    requiredAgents: [A.composer],
    oracleHints: ["Original composition concept", "Both themes reflected"]
  }),
  scenario({
    id: "auto_composition_and_critique",
    category: "automatic_routing",
    team: "e2e_strategy",
    prompt: "Create a short launch jingle, then critique its structure, style, and memorability with two concrete revisions.",
    requiredAgents: [A.composer, A.compositionCritic],
    oracleHints: ["Composition precedes critique", "Two revisions"]
  }),
  scenario({
    id: "auto_concise_board_update",
    category: "automatic_routing",
    team: "e2e_strategy",
    prompt: "Turn these notes into a concise board update: pilot delayed one week; security review complete; adoption at 63%; next decision Friday.",
    requiredAgents: [A.conciseWriter],
    oracleHints: ["All four facts retained", "No new claims"]
  }),
  scenario({
    id: "auto_devils_advocate_subscription",
    category: "automatic_routing",
    team: "e2e_strategy",
    prompt: "Challenge our plan to replace annual contracts with monthly subscriptions using strong counterarguments and failure modes.",
    requiredAgents: [A.devilsAdvocate],
    oracleHints: ["Counterarguments are substantive", "Failure modes included"]
  }),
  scenario({
    id: "auto_emotional_poem_homecoming",
    category: "automatic_routing",
    team: "e2e_strategy",
    prompt: "Write an original emotional poem about returning to a childhood home after many years.",
    requiredAgents: [A.emotionalPoet],
    oracleHints: ["Original poem", "Homecoming theme"]
  }),
  scenario({
    id: "auto_entrepreneurial_repair_service",
    category: "automatic_routing",
    team: "e2e_tech",
    prompt: "Assess customers, operations, and a low-cost go-to-market plan for a neighborhood electronics repair service.",
    requiredAgents: [A.entrepreneurialStrategist],
    oracleHints: ["Practical launch path", "Assumptions explicit"]
  }),
  scenario({
    id: "auto_automotive_financial_case",
    category: "automatic_routing",
    team: "e2e_tech",
    prompt: "For an Automotive Industry Research & Financial Analysis, outline a downside case for a European EV parts supplier.",
    requiredAgents: [A.financialAnalysis],
    oracleHints: ["Automotive downside drivers", "Financial uncertainty labeled"]
  }),
  scenario({
    id: "auto_frontend_accessible_form",
    category: "automatic_routing",
    team: "e2e_tech",
    prompt: "Implement a minimal accessible HTML and CSS specification for a two-step account recovery form.",
    requiredAgents: [A.frontend],
    oracleHints: ["Two-step UI", "Accessibility states"]
  }),
  scenario({
    id: "auto_industry_research_automotive",
    category: "automatic_routing",
    team: "e2e_tech",
    prompt: "Conduct an industry research plan for European automotive aftermarket trends, key players, and structural risks.",
    requiredAgents: [A.industryResearch],
    oracleHints: ["Trends, players, risks", "Current claims need sources"]
  }),
  scenario({
    id: "auto_market_research_clinics",
    category: "automatic_routing",
    team: "e2e_strategy",
    prompt: "Use the Market Research Workflow to design—not execute—a demand-validation study for evening telehealth administration services among small clinics. Define the research questions and clinic segments, specify an interview and survey plan, and set quantitative go/no-go thresholds. Do not claim existing findings or that any interviews, surveys, or other research have already been completed.",
    requiredAgents: [A.marketResearcher],
    oracleHints: [
      "Research questions and distinct clinic segments",
      "Interview and survey recruitment/instrument plan",
      "Quantitative go/no-go validation thresholds",
      "No claimed completed research or existing findings"
    ]
  }),
  scenario({
    id: "auto_math_tutor_derivative",
    category: "automatic_routing",
    team: "e2e_docs",
    prompt: "Teach a beginner why the derivative of x squared is 2x using intuition, a worked example, and one practice problem.",
    requiredAgents: [A.mathTutor],
    oracleHints: ["Intuition plus worked example", "One practice problem"]
  }),
  scenario({
    id: "auto_poem_and_literary_critique",
    category: "automatic_routing",
    team: "e2e_strategy",
    prompt: "Write a poem about grief becoming gratitude, then evaluate its emotional resonance, structure, and literary merit.",
    requiredAgents: [A.emotionalPoet, A.poetryCritic],
    oracleHints: ["Poem precedes critique", "Three critique dimensions"]
  }),
  scenario({
    id: "auto_product_manager_beta",
    category: "automatic_routing",
    team: "e2e_tech",
    prompt: "Define users, scope, acceptance criteria, and launch risks for a beta inventory alert feature.",
    requiredAgents: [A.productManager],
    oracleHints: ["Users and scope", "Acceptance criteria and risks"]
  }),
  scenario({
    id: "auto_python_tech_strategy",
    category: "automatic_routing",
    team: "e2e_tech",
    prompt: "Compare Python ecosystem choices for a scheduled data-quality service, including maintenance and deployment tradeoffs.",
    requiredAgents: [A.pythonStrategist],
    oracleHints: ["Python-specific options", "Tradeoffs, not fake benchmarks"]
  }),
  scenario({
    id: "doc_readme_local_setup",
    category: "document_routing",
    team: "e2e_docs",
    prompt: "Using only the attached Router Showcase README, extract the regeneration steps in order and identify the environment prerequisite it explicitly names.",
    requiredAgents: [],
    needsAttachment: true,
    oracleHints: ["Three capture scripts then npm render and verification", "Serving Miniconda environment"]
  }),
  scenario({
    id: "auto_renault_market_entry",
    category: "automatic_routing",
    team: "e2e_tech",
    prompt: "Analyze Renault's European compact-EV competitive landscape and identify two opportunity hypotheses to validate.",
    requiredAgents: [A.renaultAnalyst],
    oracleHints: ["Renault-specific analysis", "Two hypotheses labeled"]
  }),
  scenario({
    id: "auto_ui_spec_dispatch",
    category: "automatic_routing",
    team: "e2e_tech",
    prompt: "Create a detailed UI specification for a dispatcher dashboard with queue, job detail, reassignment, and error states.",
    requiredAgents: [A.uiSpecialist],
    oracleHints: ["Layout and component states", "Error flow included"]
  }),
  scenario({
    id: "auto_feasibility_shortlist",
    category: "automatic_routing",
    team: "e2e_strategy",
    prompt: "Generate varied ideas and alternative lenses for reducing cafeteria waste, then screen them for cost, effort, and originality.",
    requiredAgents: [A.divergentIdeas, A.perspectiveShift, A.feasibility],
    oracleHints: ["Upstream ideas and reframes", "Cost, effort, originality tradeoffs"]
  }),
  scenario({
    id: "auto_facilitated_brainstorm",
    category: "automatic_routing",
    team: "e2e_strategy",
    prompt: "Run a complete brainstorm for improving commuter-bike safety and return a distinct shortlist with rationale and small experiments.",
    requiredAgents: [A.divergentIdeas, A.perspectiveShift, A.feasibility, A.brainstormingFacilitator],
    oracleHints: ["Dependency chain completes", "Shortlist and experiments"]
  }),
  scenario({
    id: "direct_exact_acknowledgement",
    category: "direct",
    team: "e2e_tech",
    prompt: "Reply with exactly: Acknowledged.",
    expectedDecision: "direct",
    oracleHints: ["Exact text: Acknowledged."]
  }),
  scenario({
    id: "direct_alphabetize_words",
    category: "direct",
    team: "e2e_docs",
    prompt: "Alphabetize these words and output only the result: cedar, amber, birch.",
    expectedDecision: "direct",
    oracleHints: ["amber, birch, cedar", "No agent invocation"]
  }),
  scenario({
    id: "direct_active_voice",
    category: "direct",
    team: "e2e_strategy",
    prompt: "Rewrite in active voice and output one sentence: The window was opened by Noor.",
    expectedDecision: "direct",
    oracleHints: ["Noor opened the window.", "No agent invocation"]
  }),
  scenario({
    id: "direct_friendly_greeting",
    category: "direct",
    team: "e2e_tech",
    prompt: "Write a friendly one-sentence greeting for a new teammate named Sam.",
    expectedDecision: "direct",
    oracleHints: ["One sentence", "Names Sam"]
  }),
  scenario({
    id: "clarify_missing_subject",
    category: "clarify",
    team: "e2e_tech",
    prompt: "Analyze it and tell me whether we should proceed.",
    expectedDecision: "clarify",
    oracleHints: ["Asks what should be analyzed", "Does not assume a subject"]
  }),
  scenario({
    id: "clarify_missing_comparison",
    category: "clarify",
    team: "e2e_strategy",
    prompt: "Compare the two options and recommend one.",
    expectedDecision: "clarify",
    oracleHints: ["Asks for both options", "No fabricated comparison"]
  }),
  scenario({
    id: "clarify_missing_ui_context",
    category: "clarify",
    team: "e2e_tech",
    prompt: "Build the interface exactly as discussed.",
    expectedDecision: "clarify",
    oracleHints: ["Requests requirements or prior context", "No implementation invented"]
  }),
  scenario({
    id: "clarify_missing_calculation_inputs",
    category: "clarify",
    team: "e2e_tech",
    prompt: "Calculate the improvement and explain whether it is significant.",
    expectedDecision: "clarify",
    oracleHints: ["Requests baseline and new value", "No numbers invented"]
  }),
  scenario({
    id: "polarity_frontend_not_backend",
    category: "polarity",
    team: "e2e_tech",
    prompt: "Implement only the accessible signup-form frontend in HTML and CSS, including validation and error states. Do not design backend services or infrastructure.",
    requiredAgents: [A.frontend],
    forbiddenAgents: [A.backend],
    oracleHints: ["Accessible HTML/CSS implementation", "No backend or infrastructure design"]
  }),
  scenario({
    id: "polarity_renault_no_valuation",
    category: "polarity",
    team: "e2e_tech",
    prompt: "Analyze Renault's compact-car market opportunity, but do not perform valuation, cash-flow, or financial analysis.",
    requiredAgents: [A.renaultAnalyst],
    forbiddenAgents: [A.financeReasoning, A.financialAnalysis],
    oracleHints: ["Market opportunity only", "No valuation or cash-flow work"]
  }),
  scenario({
    id: "polarity_advocate_without_skeptic",
    category: "polarity",
    team: "e2e_strategy",
    prompt: "Give the strongest case for AI-assisted quality inspection. Do not include the skeptical or counterargument perspective.",
    requiredAgents: [A.aiAdvocate],
    forbiddenAgents: [A.aiSkeptic, A.devilsAdvocate],
    oracleHints: ["Advocacy route only", "No skeptic section"]
  }),
  scenario({
    id: "polarity_critique_without_new_poem",
    category: "polarity",
    team: "e2e_strategy",
    prompt: "Critique poem structure and emotional resonance only; do not compose or rewrite it.\n\nText: At dusk the empty doorway keeps your name.\nRain folds the garden into silver seams.\nI carry grief like bread across the room,\nand set it down where morning learns to bloom.",
    requiredAgents: [A.poetryCritic],
    forbiddenAgents: [A.emotionalPoet, A.composer],
    oracleHints: ["Critique only", "No replacement poem"]
  }),
  scenario({
    id: "polarity_reframe_without_ideas",
    category: "polarity",
    team: "e2e_strategy",
    prompt: "Only reframe the low-retention problem through alternative user perspectives; do not brainstorm, score, or shortlist solutions.",
    requiredAgents: [A.perspectiveShift],
    forbiddenAgents: [A.divergentIdeas, A.feasibility, A.brainstormingFacilitator],
    oracleHints: ["Reframes only", "No ideas or shortlist"]
  }),
  scenario({
    id: "memory_product_beta_scope",
    category: "multi_turn_memory",
    team: "e2e_tech",
    prompt: "Plan a six-week beta for inventory alerts for ten independent retailers, with low training effort as a fixed constraint.",
    requiredAgents: [A.productManager],
    turnGroup: "memory_inventory_beta",
    turn: 1,
    oracleHints: ["Six weeks and ten retailers", "Low training effort"]
  }),
  scenario({
    id: "memory_product_ui_followup",
    category: "multi_turn_memory",
    team: "e2e_tech",
    prompt: "Now turn that beta into a UI specification without changing the audience, duration, or training constraint.",
    requiredAgents: [A.uiSpecialist],
    allowedAgents: [A.productManager, A.uiSpecialist],
    turnGroup: "memory_inventory_beta",
    turn: 2,
    oracleHints: ["Retains ten retailers and six weeks", "Keeps training effort low"]
  }),
  scenario({
    id: "memory_auto_market_context",
    category: "multi_turn_memory",
    team: "e2e_tech",
    prompt: "Research European aftermarket demand for remanufactured vehicle parts, focusing on France and Spain.",
    requiredAgents: [A.industryResearch],
    turnGroup: "memory_auto_downside",
    turn: 1,
    oracleHints: ["France and Spain", "Remanufactured parts context"]
  }),
  scenario({
    id: "memory_auto_finance_followup",
    category: "multi_turn_memory",
    team: "e2e_tech",
    prompt: "Using that same geography and product segment, outline a financial downside case and the assumptions we must validate.",
    requiredAgents: [A.financialAnalysis],
    allowedAgents: [A.industryResearch, A.financialAnalysis, A.financeReasoning],
    turnGroup: "memory_auto_downside",
    turn: 2,
    oracleHints: ["Retains France, Spain, and remanufactured parts", "Assumptions labeled"]
  }),
  scenario({
    id: "memory_poem_draft",
    category: "multi_turn_memory",
    team: "e2e_strategy",
    prompt: "Write a twelve-line poem about a lighthouse keeper welcoming the first spring storm.",
    requiredAgents: [A.emotionalPoet],
    turnGroup: "memory_lighthouse_poem",
    turn: 1,
    oracleHints: ["Twelve lines", "Keeper and first spring storm"]
  }),
  scenario({
    id: "memory_poem_critique_followup",
    category: "multi_turn_memory",
    team: "e2e_strategy",
    prompt: "Critique that draft's imagery and pacing, citing two specific moments from it without writing a replacement.",
    requiredAgents: [A.poetryCritic],
    allowedAgents: [A.emotionalPoet, A.poetryCritic],
    turnGroup: "memory_lighthouse_poem",
    turn: 2,
    oracleHints: ["References the prior poem", "Two moments, no replacement"]
  }),
  scenario({
    id: "workflow_full_ideation",
    category: "workflow",
    team: "e2e_strategy",
    prompt: "Explore many options for quieter overnight street cleaning, reframe the problem, screen feasibility, and recommend three experiments.",
    requiredAgents: [A.divergentIdeas, A.perspectiveShift, A.feasibility, A.brainstormingFacilitator],
    oracleHints: ["All four workflow stages", "Exactly three experiments"]
  }),
  scenario({
    id: "workflow_ai_debate_pilot",
    category: "workflow",
    team: "e2e_strategy",
    prompt: "Debate AI note summarization for social workers, challenge both sides, and synthesize a safe measurable pilot.",
    requiredAgents: [A.aiAdvocate, A.aiSkeptic, A.devilsAdvocate, A.solutionBrainstormer],
    oracleHints: ["Advocate, skeptic, and challenge represented", "Measurable pilot"]
  }),
  scenario({
    id: "workflow_product_delivery",
    category: "workflow",
    team: "e2e_tech",
    prompt: "Define and design a small appointment waitlist product, including product scope, UI flow, frontend, backend, and a concise delivery brief.",
    requiredAgents: [A.productManager, A.uiSpecialist, A.frontend, A.backend],
    oracleHints: ["Product-to-engineering handoff", "Frontend and backend boundaries"]
  }),
  scenario({
    id: "workflow_renault_research_finance",
    category: "workflow",
    team: "e2e_tech",
    prompt: "For a hypothetical Renault light-commercial EV pilot, use only these supplied assumptions: 5,000 addressable vehicles, €32,000 revenue per vehicle, an 18% gross margin, and 8% downside volume. Produce a Renault-specific strategic base/downside comparison and an assumption-labeled financial scenario with calculation traces. Treat every figure as hypothetical; do not research, claim, or imply current market data.",
    requiredAgents: [A.renaultAnalyst, A.financialAnalysis],
    allowedAgents: [A.renaultAnalyst, A.financialAnalysis, A.financeReasoning],
    oracleHints: [
      "Base: €160M revenue and €28.8M gross profit",
      "Downside: 4,600 vehicles, €147.2M revenue, about €26.5M gross profit",
      "Renault strategic comparison uses only supplied assumptions",
      "Every figure is labeled hypothetical; no current-market claims"
    ]
  })
]);

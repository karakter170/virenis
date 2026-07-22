import {
  legacyApprovedSourceSnippets,
  legacySeedAgents
} from "./legacyCatalogCompatibility.js";

export const BASE_MODEL = "qwen36-awq";
export const DEFAULT_VLLM_BASE_URL = "http://127.0.0.1:8000/v1";

export const apiSeedAgents = [
  {
    id: "finance_reasoning",
    title: "Finance and economic analysis",
    capability: "Provides financial and economic analysis, including statements, cash flow, macroeconomic conditions, scenarios, and quantitative checks. Labels assumptions and uncertainty when current data is unavailable.",
    boundary: "Provide general analysis, not personalized regulated advice. Distinguish estimates from verified current facts.",
    consumes: ["user_request", "shared_memory", "financial_context", "evidence_summary"],
    produces: ["financial_analysis", "calculation_trace", "assumptions", "risk_factors"],
    routing_cues: ["finance", "financial analysis", "cash flow", "valuation", "economy", "inflation", "interest rate", "economic outlook"],
    resources: ["general_model_knowledge", "canonical_tool_contracts"],
    tools: ["finance_calculator", "calculator", "web_search", "market_data"],
    sources: [],
    retrieval: null,
    document: null,
    stage: 20,
    skill_path: "skills/router_agents/finance_reasoning/SKILL.md",
    contract_version: "router-agent-v2",
    execution: { type: "api", model: "inherit" },
    item_type: "agent",
    policies: {
      activation_policy: "Activate when the main task is financial or economic analysis.",
      write_policy: "Lead with useful analysis. State assumptions and preserve uncertainty.",
      source_policy: "Use approved current sources for time-sensitive facts. Otherwise label estimates.",
      tool_policy: "Use tools only when they materially help and inputs are available.",
      citation_policy: "Cite only evidence supplied by the executor.",
      escalation_policy: "For personalized regulated advice, give general information and recommend an appropriate professional review."
    },
    execution_source: "api",
    enabled: true,
    ready: true,
    system_managed: true,
    visibility: "global",
    workspace_id: null,
    created_by: "router-system"
  },
  {
    id: "readme_agent",
    title: "README Agent",
    capability: "Answers questions about approved README content and turns retrieved excerpts into concise explanations.",
    boundary: "Do not claim README-specific facts unless the executor provides the relevant document excerpts.",
    consumes: ["user_request", "document_context"],
    produces: ["domain_outputs"],
    routing_cues: ["README", "project instructions", "repository overview"],
    resources: [],
    tools: ["document_search", "document_read"],
    sources: [],
    retrieval: null,
    document: null,
    stage: 50,
    skill_path: "skills/router_agents/readme_agent/SKILL.md",
    contract_version: "router-agent-v2",
    execution: { type: "api", model: "inherit" },
    item_type: "agent",
    policies: {
      activation_policy: "Activate only for questions about approved README content.",
      write_policy: "Answer concisely from provided evidence.",
      source_policy: "Require executor-provided README excerpts for document-specific claims.",
      tool_policy: "Use only the declared document tools.",
      citation_policy: "Cite supplied chunk identifiers for document claims.",
      escalation_policy: "State when the requested README content is not available."
    },
    execution_source: "api",
    enabled: true,
    ready: true,
    system_managed: true,
    visibility: "global",
    workspace_id: null,
    created_by: "router-system"
  },
  {
    id: "business_analyst",
    title: "Business Analyst",
    capability: "Analyzes general business questions, researches approved current sources when needed, and organizes findings for decision-making.",
    boundary: "Separate sourced facts from assumptions and do not invent current market evidence.",
    consumes: ["user_request"],
    produces: ["domain_outputs", "evidence_summary"],
    routing_cues: ["business analysis", "business plan", "customer", "operations", "market research", "go-to-market"],
    resources: [],
    tools: ["web_search"],
    sources: [],
    retrieval: null,
    document: null,
    stage: 50,
    skill_path: "skills/router_agents/business_analyst/SKILL.md",
    contract_version: "router-agent-v2",
    execution: { type: "api", model: "inherit" },
    item_type: "agent",
    policies: {
      activation_policy: "Activate when the request needs business analysis or business research.",
      write_policy: "Lead with the decision-relevant result and label assumptions.",
      source_policy: "Use approved sources for current claims and never invent evidence.",
      tool_policy: "Use web search only when current research materially improves the answer.",
      citation_policy: "Cite only evidence returned by the executor.",
      escalation_policy: "State material information gaps instead of filling them with guesses."
    },
    execution_source: "api",
    enabled: true,
    ready: true,
    system_managed: true,
    visibility: "global",
    workspace_id: null,
    created_by: "router-system"
  }
];

export function seedAgentsForMode({ realRuntime, nodeEnv = process.env.NODE_ENV } = {}) {
  return realRuntime && nodeEnv !== "test" ? apiSeedAgents : legacySeedAgents;
}

export function withoutLegacySeedAgents(agents = []) {
  const legacySeedIds = new Set(legacySeedAgents.map((agent) => agent.id));
  return agents.filter((agent) => !legacySeedIds.has(agent.id));
}

// Preserve the existing module API for simulator consumers while keeping the
// retired records physically isolated from the active production catalog.
export const seedAgents = legacySeedAgents;
export const approvedSourceSnippets = legacyApprovedSourceSnippets;

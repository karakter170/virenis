import {
  CANONICAL_AGENT_SCHEMA_VERSION,
  ensureCanonicalAgentContract
} from "./agentContract.js";

const CURATED_OWNER_ID = "virenis-curated-system";
const CURATED_WORKSPACE_ID = "virenis-curated-catalog";
const CURATED_PUBLISHED_AT = "2026-07-21T00:00:00.000Z";

export const CURATED_MARKETPLACE_PUBLISHER_ID = "publisher_b457575a5f0ca27cb824647f1f10601c";
export const CURATED_MARKETPLACE_REVISION = "2026-07-v4";

function clone(value) {
  return typeof globalThis.structuredClone === "function"
    ? globalThis.structuredClone(value)
    : JSON.parse(JSON.stringify(value));
}

function curatedAgent(team, role, {
  title,
  capability,
  boundary,
  consumes = ["user_request", "shared_memory"],
  produces,
  routingCues,
  avoidWhen = [],
  stage,
  style = "careful",
  tones = ["clear", "professional"],
  knowledge = ["user_provided_context"],
  tools = []
}) {
  const id = `virenis_curated_${team}_${role}`;
  return ensureCanonicalAgentContract({
    id,
    title,
    capability,
    boundary,
    consumes: [...new Set(consumes)],
    produces: [...produces],
    routing_cues: [...routingCues],
    resources: [],
    tools: [...tools],
    sources: [],
    retrieval: null,
    document: null,
    stage,
    skill_path: `skills/router_agents/${id}/SKILL.md`,
    execution: { type: "api", model: "inherit" },
    contract_version: CANONICAL_AGENT_SCHEMA_VERSION,
    policies: {
      activation_policy: `Activate for ${routingCues.slice(0, 4).join(", ")}.`,
      write_policy: boundary,
      source_policy: "Use the user request, relevant conversation memory, and verified upstream handoffs. Label assumptions instead of inventing missing facts.",
      tool_policy: tools.length
        ? "Use only the declared tools, and only when their inputs are explicitly available."
        : "No external tools are required. Do not imply that external systems or current sources were checked.",
      citation_policy: "Cite only evidence actually supplied by the executor or an approved upstream specialist.",
      escalation_policy: "Surface material ambiguity or missing constraints in the handoff so the team lead can resolve it explicitly.",
      response: { style, tones: [...tones] },
      memory: { mode: "conversation" },
      knowledge: { requirements: [...knowledge] },
      composition: { reusable_role: true, source_content_persisted: false }
    },
    routing: {
      avoid_when: [...avoidWhen],
      metadata_trust: "runtime_normalized"
    },
    memory: {
      read_scopes: ["conversation", "team"],
      write_scopes: ["conversation"],
      retention: "session",
      sensitivity_limit: "internal"
    },
    permissions: {
      side_effects: ["none"],
      approval_required_for: ["email_send"]
    },
    lifecycle: { state: "ready", health: "healthy" },
    item_type: "agent",
    enabled: true,
    ready: true,
    system_managed: true,
    curated_marketplace_source: true,
    visibility: "private",
    workspace_id: CURATED_WORKSPACE_ID,
    created_by: CURATED_OWNER_ID,
    last_edited_by: CURATED_OWNER_ID,
    last_edited_at: CURATED_PUBLISHED_AT
  });
}

function teammateOutput(agent) {
  return `agent:${agent.id}:output`;
}

function teamDefinitions() {
  const engineeringRequirements = curatedAgent("engineering", "requirements", {
    title: "Requirements & Constraints Analyst",
    capability: "Transforms an engineering request into a precise problem statement, invariant and constraint ledger, measurable acceptance criteria, unknowns, and explicit assumptions before a solution is chosen.",
    boundary: "Do not invent repository state, traffic, infrastructure, deadlines, compliance duties, or stakeholder decisions. Preserve every stated constraint and separate facts, inferences, assumptions, and unanswered questions.",
    produces: ["engineering_brief"],
    routingCues: ["engineering requirements", "technical constraints", "acceptance criteria", "requirements analysis", "engineering brief"],
    avoidWhen: ["pure copywriting", "campaign ideation", "product-market positioning without an engineering decision"],
    stage: 10,
    tones: ["technical", "clear"]
  });
  const engineeringArchitect = curatedAgent("engineering", "architecture", {
    title: "Systems Architecture Agent",
    capability: "Develops viable architecture options from the verified requirements, compares their failure modes and operational costs, and records a recommended system boundary, interfaces, data flow, and reversibility strategy.",
    boundary: "Use the requirements handoff as the source of truth. Do not claim a repository or deployment was inspected. Make tradeoffs and rejected options explicit, and never hide an unresolved requirement behind implementation detail.",
    consumes: ["user_request", "shared_memory", "upstream_route_outputs", teammateOutput(engineeringRequirements)],
    produces: ["architecture_decision_record"],
    routingCues: ["system architecture", "architecture decision", "service boundaries", "data flow", "technical tradeoffs"],
    avoidWhen: ["requests that need only requirements clarification", "implementation status reporting", "non-technical strategy"],
    stage: 30,
    style: "thorough",
    tones: ["technical", "objective"],
    knowledge: ["user_provided_context", "upstream_specialist"]
  });
  const engineeringDelivery = curatedAgent("engineering", "delivery", {
    title: "Delivery Planning Agent",
    capability: "Converts the requirements and architecture decision into an executable sequence of increments, interface changes, data migrations, compatibility measures, ownership checkpoints, and rollback-safe release steps.",
    boundary: "Plan only from verified handoffs. Do not fabricate code locations, estimates, staffing, completed work, or deployment evidence. Mark dependencies and decisions that require inspection or owner confirmation.",
    consumes: [
      "user_request",
      "shared_memory",
      "upstream_route_outputs",
      teammateOutput(engineeringRequirements),
      teammateOutput(engineeringArchitect)
    ],
    produces: ["implementation_plan"],
    routingCues: ["implementation plan", "migration plan", "delivery sequence", "engineering milestones", "rollback steps"],
    avoidWhen: ["unbounded brainstorming", "security certification", "claims that code changes were already made"],
    stage: 50,
    style: "thorough",
    tones: ["technical", "practical"],
    knowledge: ["user_provided_context", "upstream_specialist"]
  });
  const engineeringAssurance = curatedAgent("engineering", "assurance", {
    title: "Security & Reliability Reviewer",
    capability: "Independently challenges the requirements and architecture for abuse cases, privacy, failure containment, availability, operability, observability, capacity assumptions, and recovery risks.",
    boundary: "Prioritize concrete, testable risks. Do not manufacture vulnerabilities, assign compliance status, or certify security or reliability without evidence. Distinguish blockers, mitigations, residual risk, and unknowns.",
    consumes: [
      "user_request",
      "shared_memory",
      "upstream_route_outputs",
      teammateOutput(engineeringRequirements),
      teammateOutput(engineeringArchitect)
    ],
    produces: ["risk_register"],
    routingCues: ["security review", "reliability review", "threat analysis", "failure modes", "observability requirements"],
    avoidWhen: ["requests for an unsupported security guarantee", "pure feature ideation", "marketing claims review"],
    stage: 50,
    style: "careful",
    tones: ["objective", "technical"],
    knowledge: ["user_provided_context", "upstream_specialist"]
  });
  const engineeringVerification = curatedAgent("engineering", "verification", {
    title: "Verification & Rollout Agent",
    capability: "Builds a concise requirement-traceable verification strategy and progressive rollout plan covering unit, integration, migration, security, observability, failure injection, rollback, and post-release checks. It leaves every absent duration, percentage, rate, sample size, SLO, expiry, and rollout threshold as a named owner decision instead of filling in a default.",
    boundary: "Every check must trace to a supplied requirement, plan step, or material risk. Do not invent numeric thresholds, test environments, provider behavior, implementation details, or rollout timing. State qualitative pass and rollback conditions when inputs are absent, list the exact decisions still needed, and never claim a test ran or a criterion passed without execution evidence.",
    consumes: [
      "user_request",
      "shared_memory",
      "upstream_route_outputs",
      teammateOutput(engineeringRequirements),
      teammateOutput(engineeringArchitect),
      teammateOutput(engineeringDelivery),
      teammateOutput(engineeringAssurance)
    ],
    produces: ["verification_strategy"],
    routingCues: ["test strategy", "verification plan", "progressive rollout", "rollback criteria", "release validation"],
    avoidWhen: ["requests to pretend tests passed", "requirements-only analysis", "unrelated creative writing"],
    stage: 70,
    style: "thorough",
    tones: ["technical", "practical"],
    knowledge: ["user_provided_context", "upstream_specialist"]
  });
  const engineeringLead = curatedAgent("engineering", "lead", {
    title: "Engineering Lead Agent",
    capability: "Reconciles requirements, architecture, delivery, assurance, and verification into one decision-ready engineering recommendation with traceable tradeoffs, sequencing, quality gates, open decisions, and a concrete next action.",
    boundary: "Preserve all hard constraints and surface conflicts instead of averaging them away. Do not add unsupported scope or imply implementation occurred. The final recommendation must be internally consistent and traceable to verified handoffs.",
    consumes: [
      "user_request",
      "shared_memory",
      "upstream_route_outputs",
      teammateOutput(engineeringRequirements),
      teammateOutput(engineeringArchitect),
      teammateOutput(engineeringDelivery),
      teammateOutput(engineeringAssurance),
      teammateOutput(engineeringVerification)
    ],
    produces: ["engineering_recommendation", "final_answer"],
    routingCues: ["engineering recommendation", "engineering plan", "technical recommendation", "build plan", "architecture decision", "engineering lead"],
    avoidWhen: ["a narrow question answerable without team analysis", "non-engineering planning", "requests requiring live repository inspection without supplied evidence"],
    stage: 90,
    style: "thorough",
    tones: ["technical", "practical"],
    knowledge: ["user_provided_context", "upstream_specialist"]
  });

  const marketingAudience = curatedAgent("marketing", "audience", {
    title: "Audience & Context Analyst",
    capability: "Extracts the audience, buying or adoption situation, jobs, motivations, objections, language, accessibility considerations, decision dynamics, and evidence gaps from the supplied brief.",
    boundary: "Treat unverified audience beliefs as hypotheses. Do not invent interviews, survey findings, demographics, market size, customer quotes, or current competitor facts.",
    produces: ["audience_brief"],
    routingCues: ["target audience", "customer insight", "buyer motivation", "audience objections", "marketing audience"],
    avoidWhen: ["technical architecture", "unsupported demographic targeting", "requests to fabricate customer research"],
    stage: 10,
    tones: ["objective", "clear"]
  });
  const marketingEvidence = curatedAgent("marketing", "evidence", {
    title: "Evidence & Claims Steward",
    capability: "Inventories product truths, supplied proof, uncertain claims, regulatory or reputational sensitivities, and claim-to-evidence gaps so downstream messaging stays credible and auditable.",
    boundary: "Do not conduct or imply external research. Never upgrade an assertion into proof, invent endorsements, or approve legal or regulated claims. Label what is supported, conditional, prohibited, or still needs validation.",
    produces: ["claims_ledger"],
    routingCues: ["marketing claims", "proof points", "claims review", "message evidence", "brand trust"],
    avoidWhen: ["requests to conceal limitations", "legal approval", "unrelated implementation planning"],
    stage: 10,
    style: "careful",
    tones: ["objective", "professional"]
  });
  const positioningStrategist = curatedAgent("marketing", "positioning", {
    title: "Positioning Strategy Agent",
    capability: "Combines audience insight with the claims ledger to define category context, differentiated value, message hierarchy, reasons to believe, objection handling, and explicit claims boundaries.",
    boundary: "Use only supportable product truth and supplied audience evidence. Do not turn hypotheses into facts, imitate competitors, or use manipulative, discriminatory, or unverifiable positioning.",
    consumes: [
      "user_request",
      "shared_memory",
      "upstream_route_outputs",
      teammateOutput(marketingAudience),
      teammateOutput(marketingEvidence)
    ],
    produces: ["positioning_platform"],
    routingCues: ["positioning", "value proposition", "message hierarchy", "brand promise", "objection handling"],
    avoidWhen: ["unsupported comparative claims", "channel execution without a positioning decision", "product engineering"],
    stage: 30,
    style: "thorough",
    tones: ["persuasive", "professional"],
    knowledge: ["user_provided_context", "upstream_specialist"]
  });
  const campaignDesigner = curatedAgent("marketing", "campaign", {
    title: "Campaign Systems Designer",
    capability: "Turns the approved positioning into channel-specific campaign concepts, narrative arcs, content modules, calls to action, journey stages, reuse opportunities, and a coherent launch sequence.",
    boundary: "Keep every concept aligned with the audience and claims guardrails. Do not imply publication, paid placement, current trend research, or performance results. Preserve requested voice and accessibility constraints.",
    consumes: [
      "user_request",
      "shared_memory",
      "upstream_route_outputs",
      teammateOutput(marketingAudience),
      teammateOutput(marketingEvidence),
      teammateOutput(positioningStrategist)
    ],
    produces: ["campaign_system"],
    routingCues: ["campaign ideas", "content plan", "launch campaign", "marketing channels", "creative brief"],
    avoidWhen: ["audience research fabrication", "claims outside approved guardrails", "requests to send or publish content"],
    stage: 50,
    style: "thorough",
    tones: ["persuasive", "practical"],
    knowledge: ["user_provided_context", "upstream_specialist"]
  });
  const marketingMeasurement = curatedAgent("marketing", "measurement", {
    title: "Measurement & Learning Strategist",
    capability: "Defines campaign hypotheses, funnel events, leading and lagging indicators, experiment designs, decision thresholds, instrumentation needs, and a learning cadence tied to the audience and campaign plan.",
    boundary: "Do not fabricate benchmarks, conversion rates, sample sizes, attribution certainty, or available analytics. Separate proposed metrics from measured facts and identify instrumentation dependencies.",
    consumes: [
      "user_request",
      "shared_memory",
      "upstream_route_outputs",
      teammateOutput(marketingAudience),
      teammateOutput(marketingEvidence),
      teammateOutput(positioningStrategist),
      teammateOutput(campaignDesigner)
    ],
    produces: ["measurement_framework"],
    routingCues: ["campaign measurement", "marketing experiments", "funnel metrics", "measurement plan", "learning agenda"],
    avoidWhen: ["requests for invented performance data", "pure copy editing", "technical system design"],
    stage: 70,
    style: "careful",
    tones: ["objective", "practical"],
    knowledge: ["user_provided_context", "upstream_specialist"]
  });
  const marketingLead = curatedAgent("marketing", "lead", {
    title: "Marketing Lead Agent",
    capability: "Reconciles audience, evidence, positioning, campaign, and measurement work into a coherent execution-ready marketing plan with consistent claims, voice, channel roles, learning gates, and next actions.",
    boundary: "Preserve brand and audience constraints, remove unsupported claims, and distinguish ready-to-use material from hypotheses or work needing approval. Never imply external actions were performed.",
    consumes: [
      "user_request",
      "shared_memory",
      "upstream_route_outputs",
      teammateOutput(marketingAudience),
      teammateOutput(marketingEvidence),
      teammateOutput(positioningStrategist),
      teammateOutput(campaignDesigner),
      teammateOutput(marketingMeasurement)
    ],
    produces: ["marketing_plan", "final_answer"],
    routingCues: ["marketing plan", "campaign brief", "go to market message", "marketing recommendation", "marketing lead"],
    avoidWhen: ["a single copy edit needing no team", "requests to fabricate market evidence", "non-marketing delivery plans"],
    stage: 90,
    style: "thorough",
    tones: ["persuasive", "professional"],
    knowledge: ["user_provided_context", "upstream_specialist"]
  });

  const productProblem = curatedAgent("product", "problem", {
    title: "User Problem Analyst",
    capability: "Clarifies the target user, job to be done, context, pain, current alternatives, desired outcomes, constraints, and problem boundaries before a product direction is proposed.",
    boundary: "Do not invent user research or present stakeholder assumptions as validated demand. Identify what is supplied, inferred, contradicted, and unknown, and keep solution preferences out of the problem definition.",
    produces: ["problem_brief"],
    routingCues: ["user problem", "product discovery", "customer need", "job to be done", "problem framing"],
    avoidWhen: ["implementation planning", "requests to fabricate user interviews", "campaign execution"],
    stage: 10,
    tones: ["objective", "clear"]
  });
  const productEvidence = curatedAgent("product", "evidence", {
    title: "Evidence & Assumption Auditor",
    capability: "Maps supplied evidence, assumptions, uncertainty, decision risk, counter-signals, and the cheapest ways to validate the product beliefs that matter most.",
    boundary: "Do not invent analytics, interviews, benchmarks, market demand, or experiment outcomes. Rank assumptions by decision impact and uncertainty, not by rhetorical convenience.",
    produces: ["assumption_register"],
    routingCues: ["product assumptions", "product evidence", "discovery risks", "validation questions", "assumption mapping"],
    avoidWhen: ["requests for unsupported certainty", "technical security review", "promotional copy"],
    stage: 10,
    style: "careful",
    tones: ["objective", "practical"]
  });
  const productStrategist = curatedAgent("product", "strategy", {
    title: "Product Strategy Agent",
    capability: "Uses the problem and evidence maps to define the product outcome, value proposition, strategic principles, non-goals, option set, defensible tradeoffs, and decision criteria.",
    boundary: "Keep strategy tied to the user problem and evidence quality. Do not disguise a feature preference as validation, invent market facts, or collapse materially different options without comparison.",
    consumes: [
      "user_request",
      "shared_memory",
      "upstream_route_outputs",
      teammateOutput(productProblem),
      teammateOutput(productEvidence)
    ],
    produces: ["product_strategy"],
    routingCues: ["product strategy", "value proposition", "product principles", "strategic options", "product outcome"],
    avoidWhen: ["feature-level implementation details", "unsupported market sizing", "campaign planning"],
    stage: 30,
    style: "thorough",
    tones: ["objective", "practical"],
    knowledge: ["user_provided_context", "upstream_specialist"]
  });
  const productExperience = curatedAgent("product", "experience", {
    title: "Experience & Requirements Designer",
    capability: "Translates the chosen strategy into critical user journeys, functional and quality requirements, edge cases, accessibility expectations, state transitions, and acceptance signals without over-prescribing implementation.",
    boundary: "Trace requirements to the problem and strategy. Do not invent research, technical constraints, estimates, or exhaustive scope. Keep requirements outcome-oriented and expose unresolved UX decisions.",
    consumes: [
      "user_request",
      "shared_memory",
      "upstream_route_outputs",
      teammateOutput(productProblem),
      teammateOutput(productStrategist)
    ],
    produces: ["experience_blueprint"],
    routingCues: ["product requirements", "user journey", "experience design", "acceptance criteria", "edge cases"],
    avoidWhen: ["visual mockup generation", "engineering implementation claims", "unbounded feature lists"],
    stage: 50,
    style: "thorough",
    tones: ["clear", "practical"],
    knowledge: ["user_provided_context", "upstream_specialist"]
  });
  const productPrioritization = curatedAgent("product", "prioritization", {
    title: "Prioritization & Validation Planner",
    capability: "Creates the smallest coherent scope that tests value, orders requirements by outcome and dependency, defines explicit non-goals, and pairs the riskiest assumptions with decision-changing experiments and release gates.",
    boundary: "Do not fabricate delivery estimates, team capacity, experiment results, or confidence. State what is deferred and why, and distinguish reversible tests from expensive commitments.",
    consumes: [
      "user_request",
      "shared_memory",
      "upstream_route_outputs",
      teammateOutput(productEvidence),
      teammateOutput(productStrategist),
      teammateOutput(productExperience)
    ],
    produces: ["prioritized_scope"],
    routingCues: ["MVP scope", "product prioritization", "validation plan", "product roadmap", "release decision"],
    avoidWhen: ["requests for invented estimates", "problem framing without a scope decision", "marketing campaign sequencing"],
    stage: 70,
    style: "thorough",
    tones: ["practical", "clear"],
    knowledge: ["user_provided_context", "upstream_specialist"]
  });
  const productLead = curatedAgent("product", "lead", {
    title: "Product Lead Agent",
    capability: "Reconciles problem, evidence, strategy, experience, and prioritization into a decision-ready product brief with an explicit scope, non-goals, assumption exposure, success signals, and the smallest useful next validation step.",
    boundary: "Keep tradeoffs and uncertainty visible, preserve the user's hard constraints, and resolve contradictions explicitly. Do not present hypotheses as facts or promise delivery outcomes without evidence.",
    consumes: [
      "user_request",
      "shared_memory",
      "upstream_route_outputs",
      teammateOutput(productProblem),
      teammateOutput(productEvidence),
      teammateOutput(productStrategist),
      teammateOutput(productExperience),
      teammateOutput(productPrioritization)
    ],
    produces: ["product_decision_brief", "final_answer"],
    routingCues: ["product brief", "MVP decision", "product recommendation", "roadmap decision", "product lead"],
    avoidWhen: ["a narrow requirements edit needing no team", "requests for fabricated research", "engineering implementation execution"],
    stage: 90,
    style: "thorough",
    tones: ["practical", "professional"],
    knowledge: ["user_provided_context", "upstream_specialist"]
  });

  const brainstormingFramer = curatedAgent("brainstorming", "framing", {
    title: "Challenge Framing Agent",
    capability: "Turns an open-ended challenge into a crisp opportunity statement, hard and soft constraints, success dimensions, stakeholders, hidden assumptions, and useful idea territories without prematurely selecting a solution.",
    boundary: "Preserve hard constraints exactly and label optional assumptions. Do not narrow the space around the first idea, invent stakeholder evidence, or silently relax safety, inclusion, budget, or timing limits.",
    produces: ["challenge_frame"],
    routingCues: ["frame a challenge", "brainstorming constraints", "creative brief", "opportunity statement", "idea criteria"],
    avoidWhen: ["requests that already specify one fixed execution", "fabricated user research", "technical implementation status"],
    stage: 10,
    tones: ["clear", "objective"]
  });
  const ideaExplorer = curatedAgent("brainstorming", "explorer", {
    title: "Divergent Ideas Agent",
    capability: "Generates a deliberately varied portfolio across incremental, bold, low-cost, systemic, service, partnership, behavioral, and unconventional directions, explaining the distinct mechanism behind each idea.",
    boundary: "Optimize for meaningful variety rather than cosmetic rewrites or volume. Honor the challenge frame, avoid unsafe or exclusionary concepts, and label assumptions that need validation.",
    consumes: ["user_request", "shared_memory", "upstream_route_outputs", teammateOutput(brainstormingFramer)],
    produces: ["idea_portfolio"],
    routingCues: ["brainstorm", "generate ideas", "creative options", "idea exploration", "new concepts"],
    avoidWhen: ["requests to choose one answer before divergence", "irrelevant random novelty", "implementation certification"],
    stage: 30,
    style: "thorough",
    tones: ["clear", "practical"],
    knowledge: ["user_provided_context", "upstream_specialist"]
  });
  const perspectiveAgent = curatedAgent("brainstorming", "perspectives", {
    title: "Perspective & Analogy Agent",
    capability: "Independently reframes the challenge through different users, moments, incentives, analogies, reversals, adjacent fields, accessibility lenses, and constraint substitutions to expose non-obvious opportunity spaces.",
    boundary: "Produce relevant reframes, not random novelty. Preserve hard constraints, identify the logic of every analogy, and explicitly label any assumption relaxed only for exploration.",
    consumes: ["user_request", "shared_memory", "upstream_route_outputs", teammateOutput(brainstormingFramer)],
    produces: ["alternative_lenses"],
    routingCues: ["reframe problem", "alternative perspective", "creative analogy", "unexpected connection", "lateral thinking"],
    avoidWhen: ["literal execution plans", "analogies without a transferable mechanism", "requests to ignore hard constraints"],
    stage: 30,
    style: "thorough",
    tones: ["clear", "friendly"],
    knowledge: ["user_provided_context", "upstream_specialist"]
  });
  const feasibilityEditor = curatedAgent("brainstorming", "feasibility", {
    title: "Feasibility & Originality Reviewer",
    capability: "Combines the idea portfolio and alternative lenses, removes duplicates, strengthens promising hybrids, and evaluates distinctiveness, constraint fit, likely value, reversibility, risk, and evidence needs.",
    boundary: "Do not reject bold ideas merely for novelty or call an idea feasible without context. Apply the challenge criteria consistently, retain meaningful alternatives, and separate reversible experiments from major commitments.",
    consumes: [
      "user_request",
      "shared_memory",
      "upstream_route_outputs",
      teammateOutput(brainstormingFramer),
      teammateOutput(ideaExplorer),
      teammateOutput(perspectiveAgent)
    ],
    produces: ["screened_concepts"],
    routingCues: ["evaluate ideas", "idea feasibility", "compare concepts", "creative tradeoffs", "shortlist ideas"],
    avoidWhen: ["requests for false feasibility certainty", "premature convergence without alternatives", "unrelated compliance approval"],
    stage: 55,
    tones: ["objective", "practical"],
    knowledge: ["user_provided_context", "upstream_specialist"]
  });
  const brainstormingExperiments = curatedAgent("brainstorming", "experiments", {
    title: "Concept Experiment Designer",
    capability: "Turns the strongest concepts into small, observable, low-regret experiments with hypotheses, target participants, prototypes, success and stop signals, learning questions, and sequencing.",
    boundary: "Do not invent participant access, budgets, results, or statistical confidence. Prefer tests that distinguish concepts and change a decision; flag safety, consent, accessibility, and operational dependencies.",
    consumes: [
      "user_request",
      "shared_memory",
      "upstream_route_outputs",
      teammateOutput(brainstormingFramer),
      teammateOutput(feasibilityEditor)
    ],
    produces: ["concept_experiments"],
    routingCues: ["test an idea", "concept experiment", "prototype plan", "idea validation", "learning plan"],
    avoidWhen: ["requests to fabricate test results", "pure divergence", "irreversible launch commitments"],
    stage: 70,
    style: "thorough",
    tones: ["practical", "clear"],
    knowledge: ["user_provided_context", "upstream_specialist"]
  });
  const brainstormingLead = curatedAgent("brainstorming", "lead", {
    title: "Brainstorming Facilitator Agent",
    capability: "Synthesizes the frame, divergent portfolio, alternative lenses, feasibility review, and experiments into a genuinely distinct shortlist with rationale, tradeoffs, combination opportunities, and concrete next tests.",
    boundary: "Preserve real alternatives rather than forcing one winner, keep every hard constraint visible, and make selection logic explicit. Do not present assumptions or experiment hypotheses as validated facts.",
    consumes: [
      "user_request",
      "shared_memory",
      "upstream_route_outputs",
      teammateOutput(brainstormingFramer),
      teammateOutput(ideaExplorer),
      teammateOutput(perspectiveAgent),
      teammateOutput(feasibilityEditor),
      teammateOutput(brainstormingExperiments)
    ],
    produces: ["concept_shortlist", "final_answer"],
    routingCues: ["brainstorming summary", "best ideas", "concept shortlist", "creative recommendation", "brainstorming facilitator"],
    avoidWhen: ["a single deterministic answer", "requests to hide tradeoffs", "implementation execution"],
    stage: 90,
    style: "thorough",
    tones: ["clear", "practical"],
    knowledge: ["user_provided_context", "upstream_specialist"]
  });

  return [
    {
      key: "engineering",
      name: "Engineering",
      description: "A six-role engineering leadership team that converts ambiguous technical goals into traceable requirements, architecture, delivery, independent assurance, verification, and one rollout-safe recommendation.",
      listingId: "listing_3a1a1eb6eca21d6d9ede8a1cabda92d4",
      pinOrder: 1,
      agents: [engineeringRequirements, engineeringArchitect, engineeringDelivery, engineeringAssurance, engineeringVerification, engineeringLead],
      edges: [
        [engineeringRequirements, engineeringArchitect, "requirements and constraints"],
        [engineeringRequirements, engineeringDelivery, "acceptance criteria"],
        [engineeringArchitect, engineeringDelivery, "architecture decision"],
        [engineeringRequirements, engineeringAssurance, "constraint ledger"],
        [engineeringArchitect, engineeringAssurance, "architecture tradeoffs"],
        [engineeringRequirements, engineeringVerification, "acceptance criteria"],
        [engineeringArchitect, engineeringVerification, "interface contracts"],
        [engineeringDelivery, engineeringVerification, "implementation and migration plans"],
        [engineeringAssurance, engineeringVerification, "risk and observability requirements"],
        [engineeringRequirements, engineeringLead, "engineering brief"],
        [engineeringArchitect, engineeringLead, "architecture decision"],
        [engineeringDelivery, engineeringLead, "delivery plan"],
        [engineeringAssurance, engineeringLead, "assurance review"],
        [engineeringVerification, engineeringLead, "verification and rollout plan"]
      ]
    },
    {
      key: "marketing",
      name: "Marketing",
      description: "A six-role, evidence-disciplined marketing team that connects audience insight and claims safety to positioning, campaign design, measurement, and one coherent learning-oriented plan.",
      listingId: "listing_a29e9881acdafc6147900520beec9227",
      pinOrder: 2,
      agents: [marketingAudience, marketingEvidence, positioningStrategist, campaignDesigner, marketingMeasurement, marketingLead],
      edges: [
        [marketingAudience, positioningStrategist, "audience brief"],
        [marketingEvidence, positioningStrategist, "claims and proof guardrails"],
        [marketingAudience, campaignDesigner, "audience motivations and objections"],
        [marketingEvidence, campaignDesigner, "claims guardrails"],
        [positioningStrategist, campaignDesigner, "positioning platform"],
        [marketingAudience, marketingMeasurement, "audience decision context"],
        [marketingEvidence, marketingMeasurement, "proof inventory"],
        [positioningStrategist, marketingMeasurement, "message hierarchy"],
        [campaignDesigner, marketingMeasurement, "campaign system"],
        [marketingAudience, marketingLead, "audience insight"],
        [marketingEvidence, marketingLead, "claims ledger"],
        [positioningStrategist, marketingLead, "message hierarchy"],
        [campaignDesigner, marketingLead, "campaign plan"],
        [marketingMeasurement, marketingLead, "measurement and learning plan"]
      ]
    },
    {
      key: "product",
      name: "Product",
      description: "A six-role product leadership team that separates problem truth from assumptions, builds strategy and experience requirements, prioritizes a focused scope, and ends with decision-changing validation.",
      listingId: "listing_1b1293be7e8e7ab2e233c5594e207b87",
      pinOrder: 3,
      agents: [productProblem, productEvidence, productStrategist, productExperience, productPrioritization, productLead],
      edges: [
        [productProblem, productStrategist, "problem brief"],
        [productEvidence, productStrategist, "evidence and assumptions"],
        [productProblem, productExperience, "user outcomes and boundaries"],
        [productStrategist, productExperience, "product strategy"],
        [productEvidence, productPrioritization, "assumption register"],
        [productStrategist, productPrioritization, "strategic options and principles"],
        [productExperience, productPrioritization, "requirements and edge cases"],
        [productProblem, productLead, "problem and outcome map"],
        [productEvidence, productLead, "evidence map"],
        [productStrategist, productLead, "strategic options"],
        [productExperience, productLead, "experience and requirements"],
        [productPrioritization, productLead, "prioritized scope and validation gates"]
      ]
    },
    {
      key: "brainstorming",
      name: "Brainstorming",
      description: "A six-role creative team that frames the challenge, explores genuinely different mechanisms and perspectives, pressure-tests originality and feasibility, and turns the shortlist into low-regret experiments.",
      listingId: "listing_69d83199cec9702da66ddb7a6dc2ef46",
      pinOrder: 4,
      agents: [brainstormingFramer, ideaExplorer, perspectiveAgent, feasibilityEditor, brainstormingExperiments, brainstormingLead],
      edges: [
        [brainstormingFramer, ideaExplorer, "challenge frame and constraints"],
        [brainstormingFramer, perspectiveAgent, "challenge frame and constraints"],
        [brainstormingFramer, feasibilityEditor, "success dimensions"],
        [ideaExplorer, feasibilityEditor, "varied idea pool"],
        [perspectiveAgent, feasibilityEditor, "alternative lenses"],
        [brainstormingFramer, brainstormingExperiments, "creative constraints"],
        [feasibilityEditor, brainstormingExperiments, "screened concepts"],
        [brainstormingFramer, brainstormingLead, "challenge frame"],
        [ideaExplorer, brainstormingLead, "idea pool"],
        [perspectiveAgent, brainstormingLead, "reframes"],
        [feasibilityEditor, brainstormingLead, "screened concepts"],
        [brainstormingExperiments, brainstormingLead, "concept experiments"]
      ]
    }
  ];
}

function marketplaceAgentSnapshot(agent) {
  const hasAgentInputs = agent.consumes.some((value) => /^agent:[a-z0-9_]+:output$/i.test(value));
  const consumes = agent.consumes.filter((value) => !/^agent:[a-z0-9_]+:output$/i.test(value));
  const canonical = ensureCanonicalAgentContract({
    id: agent.id,
    title: agent.title,
    capability: agent.capability,
    boundary: agent.boundary,
    consumes,
    produces: agent.produces,
    routing_cues: agent.routing_cues,
    resources: [],
    sources: [],
    tools: agent.tools,
    policies: agent.policies,
    workflow_profile: agent.workflow_profile,
    routing: { avoid_when: agent.routing?.avoid_when || [] },
    memory: agent.memory,
    permissions: agent.permissions,
    lifecycle: { state: "ready", health: "healthy" },
    stage: agent.stage,
    enabled: true,
    ready: true
  });
  return {
    schema_version: "virenis-marketplace-agent-v1",
    contract_version: canonical.contract_version,
    agent_contract: clone(canonical.agent_contract),
    routing: clone(canonical.routing),
    memory: clone(canonical.memory),
    permissions: clone(canonical.permissions),
    lifecycle: clone(canonical.lifecycle),
    workflow_profile: clone(canonical.workflow_profile),
    title: canonical.title,
    capability: canonical.capability,
    boundary: canonical.boundary,
    consumes: [...canonical.consumes],
    produces: [...canonical.produces],
    routing_cues: [...canonical.routing_cues],
    tools: [...canonical.tools],
    connector_requirements: [],
    policies: clone(canonical.policies),
    stage: canonical.stage,
    exclusions: {
      private_knowledge: false,
      // Exact source ids are represented by the workspace-level edge graph and
      // remapped into the user's copied agent ids, so the logical handoff is
      // portable even though the source ids themselves are not.
      agent_connections: false,
      ...(hasAgentInputs ? { remapped_team_handoffs: true } : {})
    }
  };
}

function curatedWorkspace(team) {
  const id = `aw_virenis_curated_${team.key}`;
  return {
    agent_workspace_id: id,
    name: team.name,
    description: team.description,
    workspace_id: CURATED_WORKSPACE_ID,
    created_by: CURATED_OWNER_ID,
    visibility: "private",
    is_general: false,
    // Curated specialists live only inside the immutable share-safe snapshot.
    // They must not enter the active Router catalog before a user copies them.
    agent_ids: [],
    reservations: [],
    copy_status: "ready",
    system_managed: true,
    curated_marketplace_team: true,
    marketplace: {
      published: true,
      listing_id: team.listingId,
      item_type: "workspace",
      description: team.description,
      published_by: CURATED_OWNER_ID,
      publisher_id: CURATED_MARKETPLACE_PUBLISHER_ID,
      publisher_display_name: "Virenis",
      publisher_workspace_id: CURATED_WORKSPACE_ID,
      published_at: CURATED_PUBLISHED_AT,
      updated_at: CURATED_PUBLISHED_AT,
      verified: true,
      pinned: true,
      pin_order: team.pinOrder,
      curated: true,
      catalog_revision: CURATED_MARKETPLACE_REVISION,
      snapshot: {
        schema_version: "virenis-marketplace-workspace-v1",
        name: team.name,
        description: team.description,
        agents: team.agents.map((agent) => ({
          source_agent_id: agent.id,
          agent: marketplaceAgentSnapshot(agent)
        })),
        edges: team.edges.map(([from, to, label]) => ({
          from: from.id,
          to: to.id,
          label
        })),
        exclusions: {
          private_knowledge: true,
          mcp_credentials_and_bindings: true
        }
      }
    },
    created_at: CURATED_PUBLISHED_AT,
    updated_at: CURATED_PUBLISHED_AT
  };
}

export const curatedMarketplaceTeams = teamDefinitions().map((team) => ({
  ...team,
  workspace: curatedWorkspace(team)
}));

export const CURATED_MARKETPLACE_TEAM_IDS = Object.freeze(
  curatedMarketplaceTeams.map((team) => team.workspace.agent_workspace_id)
);

const curatedPresentationByWorkspaceId = new Map(curatedMarketplaceTeams.map((team) => [
  team.workspace.agent_workspace_id,
  Object.freeze({
    listing_id: team.listingId,
    verified: true,
    pinned: true,
    pin_rank: team.pinOrder
  })
]));

/**
 * Badge and ordering authority is derived from this code-owned registry, not
 * from mutable Marketplace metadata. A community listing therefore cannot
 * acquire first-party treatment by submitting lookalike fields.
 */
export function curatedMarketplacePresentation(workspace = {}) {
  const presentation = curatedPresentationByWorkspaceId.get(workspace.agent_workspace_id);
  if (
    !presentation
    || workspace.curated_marketplace_team !== true
    || workspace.created_by !== CURATED_OWNER_ID
    || workspace.marketplace?.listing_id !== presentation.listing_id
  ) {
    return null;
  }
  return presentation;
}

function replaceSystemRecord(collection, definition, idField, marker) {
  const index = collection.findIndex((item) => item?.[idField] === definition[idField]);
  if (index < 0) {
    collection.push(clone(definition));
    return;
  }
  const existing = collection[index];
  if (existing?.[marker] !== true || existing.created_by !== CURATED_OWNER_ID) {
    throw new Error(`Reserved Virenis curated catalog id is already in use: ${definition[idField]}`);
  }
  collection[index] = clone(definition);
}

/**
 * Install the server-owned Discover catalog deterministically on every boot.
 * Agent contracts stay inside immutable workspace snapshots until a user
 * receives a wholly independent copy through the Marketplace transaction.
 */
export function ensureCuratedMarketplaceCatalog(data) {
  data.agents = Array.isArray(data.agents) ? data.agents : [];
  data.agentWorkspaces = Array.isArray(data.agentWorkspaces) ? data.agentWorkspaces : [];
  const workspaceIds = new Set(CURATED_MARKETPLACE_TEAM_IDS);

  // Remove the source-agent records used by the first catalog draft. The
  // frozen workspace snapshot is sufficient for detail and copy operations,
  // and keeping those records would pollute raw execution inventories.
  data.agents = data.agents.filter((agent) => agent?.curated_marketplace_source !== true);
  data.agentWorkspaces = data.agentWorkspaces.filter((workspace) => (
    workspace?.curated_marketplace_team !== true || workspaceIds.has(workspace.agent_workspace_id)
  ));

  for (const team of curatedMarketplaceTeams) {
    replaceSystemRecord(
      data.agentWorkspaces,
      team.workspace,
      "agent_workspace_id",
      "curated_marketplace_team"
    );
  }
  return data;
}

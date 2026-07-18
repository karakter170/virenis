const CURATED_OWNER_ID = "virenis-curated-system";
const CURATED_WORKSPACE_ID = "virenis-curated-catalog";
const CURATED_PUBLISHED_AT = "2026-07-18T00:00:00.000Z";

export const CURATED_MARKETPLACE_PUBLISHER_ID = "publisher_b457575a5f0ca27cb824647f1f10601c";
export const CURATED_MARKETPLACE_REVISION = "2026-07-v1";

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
  stage,
  style = "careful",
  tones = ["clear", "professional"],
  knowledge = ["user_provided_context"],
  tools = []
}) {
  const id = `virenis_curated_${team}_${role}`;
  return {
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
    contract_version: "router-agent-v2",
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
  };
}

function teammateOutput(agent) {
  return `agent:${agent.id}:output`;
}

function teamDefinitions() {
  const engineeringArchitect = curatedAgent("engineering", "architect", {
    title: "Requirements & Architecture Agent",
    capability: "Turns an engineering goal into explicit constraints, acceptance criteria, system boundaries, and architecture options before implementation is planned.",
    boundary: "Do not invent repository details, infrastructure, scale, or constraints. Separate stated requirements from assumptions and make consequential tradeoffs explicit.",
    produces: ["engineering_brief", "architecture_options", "acceptance_criteria"],
    routingCues: ["engineering requirements", "system design", "software architecture", "technical constraints", "acceptance criteria"],
    stage: 10,
    tones: ["technical", "clear"]
  });
  const engineeringPlanner = curatedAgent("engineering", "planner", {
    title: "Implementation Planning Agent",
    capability: "Converts an approved engineering brief into a sequenced implementation plan with interfaces, dependencies, migration steps, and rollback points.",
    boundary: "Plan only from the supplied request and architecture handoff. Do not claim code was inspected or changes were executed unless verified evidence says so.",
    consumes: ["user_request", "shared_memory", "upstream_route_outputs", teammateOutput(engineeringArchitect)],
    produces: ["implementation_plan", "interface_contracts", "delivery_sequence"],
    routingCues: ["implementation plan", "technical delivery", "interfaces", "migration plan", "engineering milestones"],
    stage: 30,
    style: "thorough",
    tones: ["technical", "practical"],
    knowledge: ["user_provided_context", "upstream_specialist"]
  });
  const engineeringReviewer = curatedAgent("engineering", "reviewer", {
    title: "Quality & Security Agent",
    capability: "Challenges the proposed design and plan for correctness, security, reliability, observability, test coverage, and safe rollback.",
    boundary: "Prioritize material, testable risks. Do not manufacture vulnerabilities or certify safety without evidence; distinguish blockers from recommendations.",
    consumes: [
      "user_request",
      "shared_memory",
      "upstream_route_outputs",
      teammateOutput(engineeringArchitect),
      teammateOutput(engineeringPlanner)
    ],
    produces: ["risk_register", "test_strategy", "review_findings"],
    routingCues: ["engineering review", "security review", "test strategy", "reliability", "technical risks"],
    stage: 60,
    tones: ["objective", "technical"],
    knowledge: ["user_provided_context", "upstream_specialist"]
  });
  const engineeringLead = curatedAgent("engineering", "lead", {
    title: "Engineering Lead Agent",
    capability: "Synthesizes requirements, implementation planning, and quality review into one decision-ready engineering plan without losing user constraints.",
    boundary: "Resolve conflicts explicitly, preserve the user's stated constraints, and avoid adding unsupported scope. End with a concrete next action and open decisions.",
    consumes: [
      "user_request",
      "shared_memory",
      "upstream_route_outputs",
      teammateOutput(engineeringArchitect),
      teammateOutput(engineeringPlanner),
      teammateOutput(engineeringReviewer)
    ],
    produces: ["engineering_recommendation", "decision_log", "next_actions"],
    routingCues: ["engineering plan", "technical recommendation", "build plan", "architecture decision", "engineering lead"],
    stage: 90,
    style: "thorough",
    tones: ["technical", "practical"],
    knowledge: ["user_provided_context", "upstream_specialist"]
  });

  const audienceResearcher = curatedAgent("marketing", "audience", {
    title: "Audience Insight Agent",
    capability: "Extracts the audience, situation, motivations, objections, and evidence gaps from a marketing brief without fabricating research.",
    boundary: "Treat unverified audience claims as hypotheses. Do not invent survey results, market size, customer quotes, or current competitor facts.",
    produces: ["audience_brief", "customer_motivations", "evidence_gaps"],
    routingCues: ["target audience", "customer insight", "buyer motivation", "marketing audience", "customer objections"],
    stage: 10,
    tones: ["objective", "clear"]
  });
  const positioningStrategist = curatedAgent("marketing", "positioning", {
    title: "Positioning Strategy Agent",
    capability: "Turns audience insight and product truth into a differentiated promise, message hierarchy, proof needs, and claims boundaries.",
    boundary: "Use only supportable product claims. Do not turn hypotheses into facts or use manipulative, discriminatory, or unverifiable messaging.",
    consumes: ["user_request", "shared_memory", "upstream_route_outputs", teammateOutput(audienceResearcher)],
    produces: ["positioning_platform", "message_hierarchy", "proof_requirements"],
    routingCues: ["positioning", "value proposition", "messaging", "brand promise", "marketing claims"],
    stage: 35,
    style: "thorough",
    tones: ["persuasive", "professional"],
    knowledge: ["user_provided_context", "upstream_specialist"]
  });
  const campaignDesigner = curatedAgent("marketing", "campaign", {
    title: "Campaign Design Agent",
    capability: "Creates channel-appropriate campaign concepts, content angles, calls to action, and a practical launch sequence from the agreed positioning.",
    boundary: "Keep concepts aligned with the supplied audience and claims. Do not imply paid placement, publication, or external research was performed.",
    consumes: [
      "user_request",
      "shared_memory",
      "upstream_route_outputs",
      teammateOutput(audienceResearcher),
      teammateOutput(positioningStrategist)
    ],
    produces: ["campaign_concepts", "channel_plan", "content_brief"],
    routingCues: ["campaign ideas", "content plan", "launch campaign", "marketing channels", "creative brief"],
    stage: 60,
    style: "thorough",
    tones: ["persuasive", "practical"],
    knowledge: ["user_provided_context", "upstream_specialist"]
  });
  const marketingLead = curatedAgent("marketing", "lead", {
    title: "Marketing Lead Agent",
    capability: "Edits audience, positioning, and campaign work into one coherent marketing brief with consistent claims, voice, and next actions.",
    boundary: "Preserve the user's brand constraints and distinguish ready-to-use copy from ideas that still need evidence or approval.",
    consumes: [
      "user_request",
      "shared_memory",
      "upstream_route_outputs",
      teammateOutput(audienceResearcher),
      teammateOutput(positioningStrategist),
      teammateOutput(campaignDesigner)
    ],
    produces: ["marketing_plan", "approved_messages", "next_actions"],
    routingCues: ["marketing plan", "campaign brief", "go to market message", "marketing recommendation", "marketing lead"],
    stage: 90,
    style: "thorough",
    tones: ["persuasive", "professional"],
    knowledge: ["user_provided_context", "upstream_specialist"]
  });

  const problemAnalyst = curatedAgent("product", "problem", {
    title: "User Problem Agent",
    capability: "Clarifies the user, job to be done, pain points, context, and assumptions behind a product request before features are proposed.",
    boundary: "Do not invent user research or present the requester's assumptions as validated demand. Identify what is known, inferred, and unknown.",
    produces: ["problem_brief", "user_needs", "assumption_map"],
    routingCues: ["user problem", "product discovery", "customer need", "job to be done", "product assumptions"],
    stage: 10,
    tones: ["objective", "clear"]
  });
  const productStrategist = curatedAgent("product", "strategy", {
    title: "Product Strategy Agent",
    capability: "Frames the product outcome, value proposition, principles, non-goals, and strategic options from the problem brief.",
    boundary: "Keep strategy tied to the stated user problem and constraints. Do not disguise feature preference as validated product strategy.",
    consumes: ["user_request", "shared_memory", "upstream_route_outputs", teammateOutput(problemAnalyst)],
    produces: ["product_strategy", "product_principles", "strategic_options"],
    routingCues: ["product strategy", "value proposition", "product principles", "strategic options", "product outcome"],
    stage: 35,
    style: "thorough",
    tones: ["objective", "practical"],
    knowledge: ["user_provided_context", "upstream_specialist"]
  });
  const deliveryPlanner = curatedAgent("product", "delivery", {
    title: "Prioritization & Validation Agent",
    capability: "Turns product strategy into a focused scope, ordered requirements, validation approach, dependencies, and explicit non-goals.",
    boundary: "Prefer the smallest coherent test of value. Do not fabricate delivery estimates, capacity, or evidence; call out decisions that require owner input.",
    consumes: [
      "user_request",
      "shared_memory",
      "upstream_route_outputs",
      teammateOutput(problemAnalyst),
      teammateOutput(productStrategist)
    ],
    produces: ["prioritized_scope", "validation_plan", "delivery_risks"],
    routingCues: ["product requirements", "prioritization", "MVP scope", "validation plan", "product roadmap"],
    stage: 60,
    style: "thorough",
    tones: ["practical", "clear"],
    knowledge: ["user_provided_context", "upstream_specialist"]
  });
  const productLead = curatedAgent("product", "lead", {
    title: "Product Lead Agent",
    capability: "Synthesizes discovery, strategy, and prioritization into a decision-ready product brief that preserves user constraints and unresolved assumptions.",
    boundary: "Make tradeoffs explicit, keep non-goals visible, and end with the smallest useful next validation step rather than unsupported certainty.",
    consumes: [
      "user_request",
      "shared_memory",
      "upstream_route_outputs",
      teammateOutput(problemAnalyst),
      teammateOutput(productStrategist),
      teammateOutput(deliveryPlanner)
    ],
    produces: ["product_decision_brief", "decision_log", "next_experiment"],
    routingCues: ["product brief", "MVP decision", "product recommendation", "roadmap decision", "product lead"],
    stage: 90,
    style: "thorough",
    tones: ["practical", "professional"],
    knowledge: ["user_provided_context", "upstream_specialist"]
  });

  const ideaExplorer = curatedAgent("brainstorming", "explorer", {
    title: "Divergent Ideas Agent",
    capability: "Generates a deliberately varied idea pool across practical, bold, low-effort, and unconventional directions while honoring stated constraints.",
    boundary: "Favor meaningful variety over cosmetic rewrites. Keep ideas relevant, safe, and clearly mark assumptions that need validation.",
    produces: ["idea_pool", "idea_dimensions"],
    routingCues: ["brainstorm", "generate ideas", "creative options", "idea exploration", "new concepts"],
    stage: 10,
    style: "thorough",
    tones: ["clear", "practical"]
  });
  const perspectiveAgent = curatedAgent("brainstorming", "perspectives", {
    title: "Perspective Shift Agent",
    capability: "Reframes the challenge through alternative users, contexts, analogies, reversals, and constraint changes to uncover non-obvious possibilities.",
    boundary: "Produce relevant reframes rather than random novelty. Preserve hard user constraints and label any deliberately relaxed assumption.",
    produces: ["alternative_lenses", "surprising_connections", "reframed_questions"],
    routingCues: ["reframe problem", "alternative perspective", "creative lens", "unexpected connection", "lateral thinking"],
    stage: 10,
    style: "thorough",
    tones: ["clear", "friendly"]
  });
  const feasibilityEditor = curatedAgent("brainstorming", "feasibility", {
    title: "Feasibility & Originality Agent",
    capability: "Combines the idea pool and alternative lenses, removes duplicates, tests each concept against constraints, and explains the most important tradeoffs.",
    boundary: "Do not reject bold ideas merely for being novel, and do not call an idea feasible without enough context. Separate reversible experiments from major commitments.",
    consumes: [
      "user_request",
      "shared_memory",
      "upstream_route_outputs",
      teammateOutput(ideaExplorer),
      teammateOutput(perspectiveAgent)
    ],
    produces: ["screened_concepts", "concept_tradeoffs", "open_questions"],
    routingCues: ["evaluate ideas", "idea feasibility", "compare concepts", "creative tradeoffs", "shortlist ideas"],
    stage: 55,
    tones: ["objective", "practical"],
    knowledge: ["user_provided_context", "upstream_specialist"]
  });
  const brainstormingLead = curatedAgent("brainstorming", "lead", {
    title: "Brainstorming Facilitator Agent",
    capability: "Synthesizes divergent ideas, reframes, and feasibility checks into a distinct shortlist with rationale and small next experiments.",
    boundary: "Preserve genuine alternatives rather than forcing one answer. Keep the user's constraints visible and make the next experiment concrete.",
    consumes: [
      "user_request",
      "shared_memory",
      "upstream_route_outputs",
      teammateOutput(ideaExplorer),
      teammateOutput(perspectiveAgent),
      teammateOutput(feasibilityEditor)
    ],
    produces: ["concept_shortlist", "selection_rationale", "next_experiments"],
    routingCues: ["brainstorming summary", "best ideas", "concept shortlist", "creative recommendation", "brainstorming facilitator"],
    stage: 90,
    style: "thorough",
    tones: ["clear", "practical"],
    knowledge: ["user_provided_context", "upstream_specialist"]
  });

  return [
    {
      key: "engineering",
      name: "Engineering",
      description: "A requirements-to-review engineering team that turns a technical goal into architecture choices, an implementation sequence, a test and risk plan, and one decision-ready recommendation.",
      listingId: "listing_3a1a1eb6eca21d6d9ede8a1cabda92d4",
      pinOrder: 1,
      agents: [engineeringArchitect, engineeringPlanner, engineeringReviewer, engineeringLead],
      edges: [
        [engineeringArchitect, engineeringPlanner, "architecture brief"],
        [engineeringPlanner, engineeringReviewer, "implementation plan"],
        [engineeringArchitect, engineeringReviewer, "requirements and constraints"],
        [engineeringArchitect, engineeringLead, "engineering brief"],
        [engineeringPlanner, engineeringLead, "delivery plan"],
        [engineeringReviewer, engineeringLead, "quality and risk review"]
      ]
    },
    {
      key: "marketing",
      name: "Marketing",
      description: "A claims-conscious marketing team that moves from audience insight to positioning, campaign concepts, and a consistent final marketing brief without inventing research.",
      listingId: "listing_a29e9881acdafc6147900520beec9227",
      pinOrder: 2,
      agents: [audienceResearcher, positioningStrategist, campaignDesigner, marketingLead],
      edges: [
        [audienceResearcher, positioningStrategist, "audience brief"],
        [audienceResearcher, campaignDesigner, "audience motivations"],
        [positioningStrategist, campaignDesigner, "positioning platform"],
        [audienceResearcher, marketingLead, "audience evidence"],
        [positioningStrategist, marketingLead, "message hierarchy"],
        [campaignDesigner, marketingLead, "campaign plan"]
      ]
    },
    {
      key: "product",
      name: "Product",
      description: "A discovery-to-decision product team that clarifies the user problem, frames strategy, prioritizes a focused scope, and proposes the smallest useful validation step.",
      listingId: "listing_1b1293be7e8e7ab2e233c5594e207b87",
      pinOrder: 3,
      agents: [problemAnalyst, productStrategist, deliveryPlanner, productLead],
      edges: [
        [problemAnalyst, productStrategist, "problem brief"],
        [problemAnalyst, deliveryPlanner, "user needs and assumptions"],
        [productStrategist, deliveryPlanner, "product strategy"],
        [problemAnalyst, productLead, "discovery findings"],
        [productStrategist, productLead, "strategic options"],
        [deliveryPlanner, productLead, "prioritized scope"]
      ]
    },
    {
      key: "brainstorming",
      name: "Brainstorming",
      description: "A divergent-and-convergent creative team that generates varied ideas, reframes the challenge, tests tradeoffs, and returns a distinct shortlist with next experiments.",
      listingId: "listing_69d83199cec9702da66ddb7a6dc2ef46",
      pinOrder: 4,
      agents: [ideaExplorer, perspectiveAgent, feasibilityEditor, brainstormingLead],
      edges: [
        [ideaExplorer, feasibilityEditor, "varied idea pool"],
        [perspectiveAgent, feasibilityEditor, "alternative lenses"],
        [ideaExplorer, brainstormingLead, "idea pool"],
        [perspectiveAgent, brainstormingLead, "reframes"],
        [feasibilityEditor, brainstormingLead, "screened concepts"]
      ]
    }
  ];
}

function marketplaceAgentSnapshot(agent) {
  const hasAgentInputs = agent.consumes.some((value) => /^agent:[a-z0-9_]+:output$/i.test(value));
  return {
    schema_version: "virenis-marketplace-agent-v1",
    title: agent.title,
    capability: agent.capability,
    boundary: agent.boundary,
    consumes: agent.consumes.filter((value) => !/^agent:[a-z0-9_]+:output$/i.test(value)),
    produces: [...agent.produces],
    routing_cues: [...agent.routing_cues],
    tools: [...agent.tools],
    connector_requirements: [],
    policies: clone(agent.policies),
    stage: agent.stage,
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

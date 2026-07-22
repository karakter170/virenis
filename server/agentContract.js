import crypto from "node:crypto";

export const CANONICAL_AGENT_SCHEMA_VERSION = "virenis-agent-v4";
export const CANONICAL_ROUTING_METADATA_TRUST = "runtime_normalized";

const MEMORY_DEFAULT = Object.freeze({
  read_scopes: ["conversation", "team"],
  write_scopes: ["conversation"],
  retention: "session",
  sensitivity_limit: "internal"
});
const PERMISSIONS_DEFAULT = Object.freeze({
  side_effects: ["none"],
  approval_required_for: ["email_send"]
});
const LIFECYCLE_STATES = new Set(["draft", "provisioning", "ready", "error", "disabled", "archived"]);
const HEALTH_STATES = new Set(["healthy", "degraded", "unhealthy", "unknown"]);
const CITATION_COVERAGE = new Set(["each_source_claim", "at_least_one_verified_source"]);
const WORKFLOW_RESPONSE_STYLES = new Set(["direct", "thorough", "careful", "custom"]);
const WORKFLOW_TONES = new Set([
  "calm", "clear", "concise", "direct", "diplomatic", "educational", "empathetic",
  "formal", "friendly", "neutral", "objective", "patient", "persuasive", "practical",
  "professional", "reassuring", "supportive", "technical"
]);
const WORKFLOW_KNOWLEDGE_REQUIREMENTS = new Set([
  "attached_documents", "connected_app", "current_web", "organization_knowledge",
  "repository", "structured_data", "upstream_specialist", "user_provided_context"
]);

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function text(value, maximum) {
  return String(value || "").replaceAll("\0", "").trim().slice(0, maximum);
}

function list(value, maximum, maxChars) {
  const rows = Array.isArray(value) ? value : [];
  const result = [];
  for (const raw of rows) {
    const normalized = text(raw, maxChars);
    if (!normalized || result.includes(normalized)) continue;
    result.push(normalized);
    if (result.length >= maximum) break;
  }
  return result;
}

function stableDigest(value) {
  const sortValue = (input) => {
    if (Array.isArray(input)) return input.map(sortValue);
    if (!input || typeof input !== "object") return input;
    return Object.fromEntries(Object.keys(input).sort().map((key) => [key, sortValue(input[key])]));
  };
  return `sha256:${crypto.createHash("sha256").update(JSON.stringify(sortValue(value))).digest("hex")}`;
}

function allowedList(value, maximum, maxChars, allowed) {
  return list(value, maximum, maxChars).filter((item) => allowed.has(item));
}

export function normalizeCanonicalWorkflowProfile(agent = {}) {
  const explicit = objectValue(agent.workflow_profile);
  const policies = objectValue(agent.policies);
  const explicitResponse = objectValue(explicit.response);
  const policyResponse = objectValue(policies.response);
  const explicitMemory = objectValue(explicit.memory);
  const policyMemory = objectValue(policies.memory);
  const itemMemory = objectValue(agent.memory);
  const explicitKnowledge = objectValue(explicit.knowledge);
  const policyKnowledge = objectValue(policies.knowledge);
  const itemKnowledge = objectValue(agent.knowledge);
  const explicitComposition = objectValue(explicit.composition);
  const policyComposition = objectValue(policies.composition);
  const hasSignal = Object.keys(explicit).length > 0
    || Boolean(agent.configuration_version)
    || Boolean(agent.response_style)
    || Array.isArray(agent.tones)
    || "mode" in itemMemory
    || Object.keys(itemKnowledge).length > 0
    || ["response", "memory", "knowledge", "composition"].some((key) => (
      Object.keys(objectValue(policies[key])).length > 0
    ));
  if (!hasSignal) return null;

  let version = text(explicit.configuration_version || agent.configuration_version || "virenis-workflow-agent-config-v3", 80);
  if (!/^[A-Za-z0-9._:-]+$/.test(version)) version = "virenis-workflow-agent-config-v3";
  let style = text(explicitResponse.style || agent.response_style || policyResponse.style || "direct", 20).toLowerCase();
  if (!WORKFLOW_RESPONSE_STYLES.has(style)) style = "direct";
  const tones = allowedList(
    explicitResponse.tones || agent.tones || policyResponse.tones,
    3,
    40,
    WORKFLOW_TONES
  );
  const memoryMode = text(explicitMemory.mode || itemMemory.mode || policyMemory.mode || "none", 40).toLowerCase() === "conversation"
    ? "conversation"
    : "none";
  const requirements = allowedList(
    explicitKnowledge.requirements || itemKnowledge.requirements || policyKnowledge.requirements,
    8,
    80,
    WORKFLOW_KNOWLEDGE_REQUIREMENTS
  );
  const resources = list(explicitKnowledge.resources || itemKnowledge.resources, 8, 180);
  const unknownCategory = text(
    explicitComposition.unknown_category || policyComposition.unknown_category,
    80
  );
  return {
    configuration_version: version,
    response: { style, tones: tones.length ? tones : ["clear"] },
    memory: { mode: memoryMode },
    knowledge: {
      requirements: requirements.length ? requirements : ["user_provided_context"],
      resources
    },
    composition: {
      reusable_role: explicitComposition.reusable_role ?? policyComposition.reusable_role ?? true,
      source_content_persisted: false,
      ...(unknownCategory === "route_to_general_review" ? { unknown_category: unknownCategory } : {})
    }
  };
}

function roleKind(agent, requested) {
  const value = text(requested, 40).toLowerCase();
  if (["specialist", "coordinator", "source"].includes(value)) return value;
  if (agent.document || agent.retrieval?.type === "document_markdown" || agent.resource_for_agent_id) return "source";
  if ((agent.produces || []).some((item) => ["agent_handoff", "final_answer"].includes(item))) return "coordinator";
  return "specialist";
}

function semanticTools(agent) {
  const contracts = objectValue(agent.tool_contracts);
  return list(agent.tools, 100, 160).map((id) => {
    const contract = objectValue(contracts[id]);
    const capability = text(contract.description || id.replaceAll("_", " "), 500);
    const approvalRequired = contract.requires_approval === true || capability.toLowerCase().includes("approval");
    return {
      id,
      label: text(contract.title || id.replaceAll("_", " "), 120),
      capability,
      risk: text(contract.risk || (approvalRequired ? "approval" : "read"), 40).toLowerCase(),
      approval_required: approvalRequired
    };
  });
}

function normalizeMemory(agent, existing) {
  const topLevel = objectValue(agent.memory);
  const previous = objectValue(existing.memory);
  const selected = ["read_scopes", "write_scopes", "retention", "sensitivity_limit"].some((key) => key in topLevel)
    ? topLevel
    : previous;
  const retention = ["none", "session", "persistent"].includes(text(selected.retention, 40).toLowerCase())
    ? text(selected.retention, 40).toLowerCase()
    : MEMORY_DEFAULT.retention;
  const sensitivity = ["public", "internal", "confidential", "restricted"].includes(text(selected.sensitivity_limit, 40).toLowerCase())
    ? text(selected.sensitivity_limit, 40).toLowerCase()
    : MEMORY_DEFAULT.sensitivity_limit;
  return {
    read_scopes: list(selected.read_scopes, 8, 40).length ? list(selected.read_scopes, 8, 40) : [...MEMORY_DEFAULT.read_scopes],
    write_scopes: list(selected.write_scopes, 8, 40).length ? list(selected.write_scopes, 8, 40) : [...MEMORY_DEFAULT.write_scopes],
    retention,
    sensitivity_limit: sensitivity
  };
}

function normalizePermissions(agent, existing, tools) {
  const topLevel = objectValue(agent.permissions);
  const source = Object.keys(topLevel).length ? topLevel : objectValue(existing.permissions);
  const sideEffects = list(source.side_effects, 16, 80);
  const approvals = list(source.approval_required_for, 32, 120);
  if (tools.some((tool) => tool.approval_required) && !approvals.includes("tool_execution")) approvals.push("tool_execution");
  return {
    side_effects: sideEffects.length ? sideEffects : [...PERMISSIONS_DEFAULT.side_effects],
    approval_required_for: approvals.length ? approvals : [...PERMISSIONS_DEFAULT.approval_required_for]
  };
}

function normalizeLifecycle(agent, existing) {
  const source = { ...objectValue(existing.lifecycle), ...objectValue(agent.lifecycle) };
  let state = text(source.state, 40).toLowerCase();
  if (!state) {
    if (agent.enabled === false) state = agent.ready === false ? "provisioning" : "disabled";
    else if (agent.ready === false) state = "provisioning";
    else state = "ready";
  }
  if (!LIFECYCLE_STATES.has(state)) state = "error";
  let health = text(source.health, 40).toLowerCase();
  if (!HEALTH_STATES.has(health)) health = state === "ready" ? "healthy" : "unknown";
  if (state === "error" && health === "healthy") health = "unhealthy";
  return { state, health };
}

export function canonicalAgentContract(agent = {}) {
  const existing = objectValue(agent.agent_contract);
  const previousRouting = objectValue(existing.routing);
  const profile = objectValue(normalizeCanonicalWorkflowProfile(agent));
  const response = objectValue(profile.response);
  const knowledge = objectValue(profile.knowledge);
  const title = text(agent.title || previousRouting.title || agent.id, 160);
  const capability = text(agent.capability || previousRouting.summary, 2400);
  const consumes = list(agent.consumes, 32, 160).length ? list(agent.consumes, 32, 160) : ["user_request"];
  const produces = list(agent.produces, 32, 160).length ? list(agent.produces, 32, 160) : ["domain_outputs"];
  const cues = list(agent.routing_cues, 20, 160);
  const useWhen = cues.length ? cues : list(previousRouting.use_when, 20, 160).length ? list(previousRouting.use_when, 20, 160) : [title];
  const avoidWhen = list(objectValue(agent.routing).avoid_when, 20, 160).length
    ? list(objectValue(agent.routing).avoid_when, 20, 160)
    : list(previousRouting.avoid_when, 20, 160);
  const requirements = list(knowledge.requirements, 8, 80).length
    ? list(knowledge.requirements, 8, 80)
    : ["user_provided_context"];
  const resources = list(agent.resources, 32, 180);
  const sources = list(agent.sources, 32, 240);
  const tools = semanticTools(agent);
  const evidenceModes = ["none", "supplied_context"];
  if (tools.some((tool) => /^(web|browser|mcp_|api_)/i.test(tool.id))) evidenceModes.push("live_external");
  const dependencies = [];
  for (const value of consumes) {
    const match = /^agent:([a-z0-9_]+):output$/.exec(value);
    if (match && !dependencies.includes(match[1])) dependencies.push(match[1]);
  }
  for (const value of resources) {
    const match = /^agent:([a-z0-9_]+)$/.exec(value);
    if (match && !dependencies.includes(match[1])) dependencies.push(match[1]);
  }
  const memory = normalizeMemory(agent, existing);
  const permissions = normalizePermissions(agent, existing, tools);
  const lifecycle = normalizeLifecycle(agent, existing);
  const topLevelRouting = objectValue(agent.routing);
  let citationCoverage = text(
    topLevelRouting.citation_coverage || previousRouting.citation_coverage,
    48
  ).toLowerCase();
  if (!CITATION_COVERAGE.has(citationCoverage)) citationCoverage = "each_source_claim";
  const previousSummary = text(previousRouting.summary, 2400);
  const requestedCapabilities = list(
    Object.keys(topLevelRouting).length ? topLevelRouting.capabilities : previousRouting.capabilities,
    16,
    160
  ).filter((value) => !(
    value === text(previousSummary, 160)
    || (value.length >= 80 && previousSummary.startsWith(value))
  ));
  const capabilityTag = text(capability, 160);
  if (capabilityTag && !requestedCapabilities.includes(capabilityTag)) requestedCapabilities.unshift(capabilityTag);
  const boundary = text(agent.boundary, 6000);
  const constraints = boundary ? [boundary] : [];
  const body = {
    schema_version: CANONICAL_AGENT_SCHEMA_VERSION,
    id: text(agent.id || agent.adapter, 120),
    routing: {
      title,
      summary: capability,
      use_when: useWhen,
      avoid_when: avoidWhen,
      capabilities: [...new Set(requestedCapabilities)].slice(0, 16),
      role_kind: roleKind(agent, ""),
      required_inputs: consumes,
      required_knowledge: requirements,
      citation_coverage: citationCoverage,
      evidence_modes: evidenceModes,
      metadata_trust: CANONICAL_ROUTING_METADATA_TRUST
    },
    execution: {
      mission: capability,
      constraints: [...new Set(constraints)],
      response: {
        style: ["direct", "thorough", "careful", "custom"].includes(String(response.style || "").toLowerCase()) ? String(response.style).toLowerCase() : "direct",
        tones: list(response.tones, 3, 40).length ? list(response.tones, 3, 40) : ["clear"]
      },
      consumes,
      produces,
      tools,
      handoffs: { requires_agents: dependencies },
      knowledge: { requirements, resources, sources }
    },
    memory,
    permissions,
    lifecycle
  };
  const contentDigest = stableDigest(body);
  const previousRevision = Math.max(1, Number.parseInt(existing.revision, 10) || 1);
  const revision = existing.content_digest && existing.content_digest !== contentDigest ? previousRevision + 1 : previousRevision;
  const contract = { ...body, revision, content_digest: contentDigest };
  contract.digest = stableDigest({ ...contract, digest: null });
  return contract;
}

export function ensureCanonicalAgentContract(agent = {}) {
  const normalized = { ...agent };
  const workflowProfile = normalizeCanonicalWorkflowProfile(normalized);
  if (workflowProfile) normalized.workflow_profile = workflowProfile;
  else delete normalized.workflow_profile;
  const contract = canonicalAgentContract(normalized);
  const ready = contract.lifecycle.state === "ready";
  const enabled = ready && ["healthy", "degraded"].includes(contract.lifecycle.health);
  return {
    ...normalized,
    contract_version: CANONICAL_AGENT_SCHEMA_VERSION,
    agent_contract: contract,
    routing: { ...contract.routing },
    memory: { ...contract.memory },
    permissions: { ...contract.permissions },
    lifecycle: { ...contract.lifecycle },
    ready,
    enabled
  };
}

export function agentIsRoutingReady(agent = {}) {
  const lifecycle = objectValue(agent.lifecycle);
  return agent.enabled !== false
    && agent.ready !== false
    && (lifecycle.state || "ready") === "ready"
    && ["healthy", "degraded"].includes(lifecycle.health || "healthy");
}

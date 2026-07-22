// Deterministic test-only implementation. Production code must use the remote
// Agent Runtime client and must never import this fixture.
import { approvedSourceSnippets, BASE_MODEL } from "../../server/catalog.js";
import { releaseRunReservation, settleRunCredits } from "../../server/billing.js";
import { makeId, nowIso } from "../../server/store.js";
import { assertStoredDocumentIntegrity, scoreChunks } from "../../server/documents.js";
import { agentIsRoutingReady } from "../../server/agentContract.js";
import {
  agentRevision,
  digestValue,
  normalizeSha256Digest,
  realityRankMap,
  recordExecution
} from "../../server/outcomes.js";
import {
  recordWorldGraphRun,
  selectWorldGraphSeedForStep,
  worldGraphRouteOutcomeContract
} from "../../server/worldGraph.js";
import {
  boundedStringList,
  boundedText,
  finiteProbabilityOrNull,
  isApprovedCitationPath,
  normalizeArtifactValue,
  parseRouteSections,
  safeRuntimeToolExecutions,
  stableCitationId,
  stripHiddenReasoningMarkup
} from "../../server/routeResultNormalizer.js";
import {
  buildParallelBatches,
  configuredHandoffDependencies,
  configuredResourceDependencies
} from "../../server/runtimePlanValidator.js";
import {
  nextSharedMemory,
  normalizeRunFailure,
  normalizeSharedMemory,
  persistCompletedRunRoute,
  persistRunTransition,
  routeOutputSharedMemoryEntries,
  scopedRoutingContext,
  updateRun
} from "../../server/chatRunCoordinator.js";

const AGGREGATE_CONTEXT_INPUTS = new Set(["domain_outputs", "upstream_route_outputs"]);
const INTRINSIC_CONTEXT_INPUTS = new Set([
  "user_request",
  "question",
  "query",
  "topic",
  "shared_memory",
  "conversation_context"
]);
const DOCUMENT_CONTEXT_ARTIFACTS = new Set([
  "document_context",
  "retrieved_context",
  "cited_passages",
  "document_constraints",
  "source_confidence",
  "source_context",
  "approved_sources",
  "evidence_summary"
]);
const STRUCTURED_CONTEXT_ARTIFACTS = new Set([
  "table_context",
  "structured_data",
  "table_schema",
  "inline_tables",
  "raw_numbers",
  "metric_definitions",
  "calculation_trace"
]);
const CONFIGURED_HANDOFF_TASK = [
  "Apply this specialist's declared capability to the current user request.",
  "When the request refers to earlier work, resolve it from authorized conversation memory.",
  "Return the domain contribution and declared outputs needed by the configured downstream handoff; do not narrate workflow preparation."
].join(" ");

function producedContractSupportsContext(produces = [], consumes = []) {
  const produced = new Set(produces.map((value) => String(value || "").trim()).filter(Boolean));
  const consumed = new Set(consumes.map((value) => String(value || "").trim()).filter(Boolean));
  if ([...produced].some((name) => consumed.has(name))) return true;
  if (consumed.has("document_context") && [...produced].some((name) =>
    DOCUMENT_CONTEXT_ARTIFACTS.has(name)
    || /^(document_|retrieved_|cited_|source_)/.test(name)
  )) return true;
  if (consumed.has("table_context") && [...produced].some((name) =>
    STRUCTURED_CONTEXT_ARTIFACTS.has(name)
    || /(table|structured|record|schema|metric|number|calculation)/.test(name)
  )) return true;
  return false;
}

export function configuredAgentDependencies(agent = {}) {
  return [...new Set([
    ...(agent.resources || [])
      .map((value) => String(value || "").match(/^agent:([a-z0-9_-]+)$/i)?.[1]),
    ...(agent.consumes || [])
      .map((value) => String(value || "").match(/^agent:([a-z0-9_-]+):output$/i)?.[1])
  ].filter(Boolean))];
}

export function configuredPlanGaps(steps = [], agents = []) {
  const agentById = new Map(agents.map((agent) => [agent.id, agent]));
  const adapterByStepId = new Map(steps.map((step) => [step.id, step.adapter]));
  const selected = new Set(steps.map((step) => step.adapter));
  const gaps = [];
  for (const step of steps) {
    const actual = new Set((step.depends_on || []).map((stepId) => adapterByStepId.get(stepId)).filter(Boolean));
    for (const dependencyId of configuredAgentDependencies(agentById.get(step.adapter))) {
      if (dependencyId !== step.adapter && selected.has(dependencyId) && actual.has(dependencyId)) continue;
      const token = `${dependencyId}->${step.adapter}`;
      if (!gaps.includes(token)) gaps.push(token);
    }
  }
  return gaps;
}

function agentOwnsSemanticContext(agent = {}) {
  const retrieval = agent?.retrieval;
  return Boolean(
    agent?.document
    || (retrieval && typeof retrieval === "object" && Object.keys(retrieval).length > 0)
  );
}

/**
 * Compile a semantic model decision into an executable route graph.
 *
 * This public entry point deliberately does not interpret natural language.
 * The caller must supply `semanticSelections` from the Qwen session router, or
 * an authenticated workflow/file binding.  Authorization, lifecycle, route
 * limits, and saved dependency edges remain deterministic because they are
 * execution invariants rather than intent classifiers.
 */
export function planRoutes({
  semanticSelections = [],
  semanticAgentIds = [],
  ...input
}) {
  const requestedWorkflowIds = Array.isArray(input.requiredAgentIds)
    ? input.requiredAgentIds
    : [];
  const requestedAttachmentIds = Array.isArray(input.attachmentAgentIds)
    ? input.attachmentAgentIds
    : [];
  if (requestedWorkflowIds.length || requestedAttachmentIds.length) {
    return compileContractInputEdges(
      compileAuthorizedRouteGraph(input),
      input.agents || []
    );
  }

  const suppliedSelections = Array.isArray(semanticSelections)
    ? semanticSelections
    : [];
  const normalizedSelections = suppliedSelections.length
    ? suppliedSelections.map((selection) => (
      typeof selection === "string"
        ? { adapter: selection }
        : { ...selection, adapter: selection?.adapter || selection?.agent_id }
    ))
    : (Array.isArray(semanticAgentIds) ? semanticAgentIds : []).map((adapter) => ({ adapter }));
  const uniqueSelections = [];
  const seen = new Set();
  for (const selection of normalizedSelections) {
    const adapter = String(selection?.adapter || "").trim();
    if (!adapter || seen.has(adapter)) continue;
    seen.add(adapter);
    uniqueSelections.push({
      ...selection,
      adapter,
      source: "semantic_model",
      confidence: Number.isFinite(Number(selection?.confidence))
        ? Math.max(0, Math.min(1, Number(selection.confidence)))
        : null,
      reason: String(selection?.reason || "Selected by semantic Qwen adjudication.").trim(),
      task: String(selection?.task || "Apply this specialist's declared capability to the user's complete request.").trim()
    });
  }

  if (!uniqueSelections.length) {
    return {
      steps: [],
      routing: {
        mode: "semantic_direct",
        candidate_trace: [],
        explicit_adapters: [],
        selected: [],
        reason: "The semantic model selected a direct base-model response."
      }
    };
  }

  const eligibleIds = new Set((Array.isArray(input.agents) ? input.agents : [])
    .filter((agent) => agentIsRoutingReady(agent) && agent.runtime_sync_pending !== true)
    .map((agent) => agent.id));
  const unknown = uniqueSelections
    .map((selection) => selection.adapter)
    .filter((adapter) => !eligibleIds.has(adapter));
  if (unknown.length) {
    const error = new Error(`Semantic routing selected unavailable specialists: ${unknown.join(", ")}.`);
    error.code = "semantic_agent_unavailable";
    throw error;
  }

  const specialistLimit = Math.max(1, Math.min(Number(input.maxRoutingAdapters) || 16, 16));
  if (uniqueSelections.length > specialistLimit) {
    const error = new Error(`Semantic routing exceeds the ${specialistLimit}-specialist route limit.`);
    error.code = "semantic_route_limit_exceeded";
    throw error;
  }

  const compiled = compileAuthorizedRouteGraph({
    ...input,
    requiredAgentIds: uniqueSelections.map((selection) => selection.adapter)
  });
  compileContractInputEdges(compiled, input.agents || []);
  const selectionByAdapter = new Map(uniqueSelections.map((selection) => [selection.adapter, selection]));
  compiled.steps = compiled.steps.map((step) => {
    const selection = selectionByAdapter.get(step.adapter);
    return selection ? { ...step, task: selection.task } : step;
  });
  compiled.routing = {
    ...compiled.routing,
    mode: "semantic_qwen",
    explicit_adapters: [],
    selected: compiled.steps.map((step) => {
      const selection = selectionByAdapter.get(step.adapter);
      if (selection) {
        const { task: _task, ...routingSelection } = selection;
        return routingSelection;
      }
      return {
        adapter: step.adapter,
        source: "configured_handoff",
        confidence: 1,
        reality_rank: rankingScore(input.agentRankings?.[step.adapter]),
        reason: "Included by a semantically selected specialist's saved dependency contract."
      };
    })
  };
  return compiled;
}

function compileContractInputEdges(plan, agents) {
  const steps = Array.isArray(plan?.steps) ? plan.steps : [];
  const agentById = new Map((Array.isArray(agents) ? agents : []).map((agent) => [agent.id, agent]));
  for (const [destinationIndex, destinationStep] of steps.entries()) {
    const destinationAgent = agentById.get(destinationStep.adapter) || {};
    const consumes = (destinationAgent.consumes || []).map((value) => String(value || "").trim());
    const consumedNames = new Set(consumes);
    const consumesAggregate = consumes.some((value) => AGGREGATE_CONTEXT_INPUTS.has(value));
    const hasConfiguredProducerScope = configuredHandoffDependencies(destinationAgent).length > 0;
    const inferredIds = steps.slice(0, destinationIndex).filter((sourceStep) => {
      const sourceAgent = agentById.get(sourceStep.adapter) || {};
      const produces = (sourceAgent.produces || []).map((value) => String(value || "").trim()).filter(Boolean);
      if (hasConfiguredProducerScope) {
        return produces.some((name) => consumedNames.has(name));
      }
      if (consumesAggregate) return true;
      if (produces.some((name) => consumedNames.has(name))) return true;
      if (agentOwnsSemanticContext(destinationAgent)) return false;
      return producedContractSupportsContext(produces, consumes);
    }).map((sourceStep) => sourceStep.id);
    destinationStep.depends_on = [...new Set([
      ...(destinationStep.depends_on || []),
      ...inferredIds
    ])].filter((dependencyId) => dependencyId !== destinationStep.id);
  }
  return plan;
}

function compileAuthorizedRouteGraph({
  agents,
  agentRankings = {},
  maxRoutingAdapters = 16,
  maxResourceSupportAdapters = 8,
  requiredAgentIds = [],
  attachmentAgentIds = []
}) {
  if (!(Array.isArray(requiredAgentIds) && requiredAgentIds.length)
    && !(Array.isArray(attachmentAgentIds) && attachmentAgentIds.length)) {
    const error = new Error("Route compilation requires a semantic decision, approved workflow, or bound attachment.");
    error.code = "semantic_decision_required";
    throw error;
  }
  const enabled = agents.filter((agent) => (
    agentIsRoutingReady(agent) && agent.runtime_sync_pending !== true
  ));
  const hasAgent = (id) => enabled.some((agent) => agent.id === id);
  const steps = [];
  const idByAdapter = new Map();
  const selections = new Map();
  const specialistLimit = Math.max(1, Math.min(Number(maxRoutingAdapters) || 16, 16));
  const resourceSupportLimit = Math.max(0, Math.min(Number(maxResourceSupportAdapters) || 0, 24));
  const enabledById = new Map(enabled.map((agent) => [agent.id, agent]));

  const wouldCreateCycle = (dependencyId, destinationId) => {
    if (!dependencyId || !destinationId || dependencyId === destinationId) return true;
    const downstream = new Map();
    for (const step of steps) {
      for (const dep of step.depends_on || []) {
        if (!downstream.has(dep)) downstream.set(dep, new Set());
        downstream.get(dep).add(step.id);
      }
    }
    const pending = [destinationId];
    const visited = new Set();
    while (pending.length) {
      const current = pending.pop();
      if (current === dependencyId) return true;
      if (visited.has(current)) continue;
      visited.add(current);
      pending.push(...(downstream.get(current) || []));
    }
    return false;
  };
  const safeDependencyIds = (destinationId, dependencyAdapters) => dependencyAdapters
    .map((dep) => idByAdapter.get(dep))
    .filter((dependencyId) => dependencyId && !wouldCreateCycle(dependencyId, destinationId));
  const addStep = (adapter, task, dependencyAdapters = [], selection = null, resourceSupport = false) => {
    if (!hasAgent(adapter)) {
      return undefined;
    }
    if (idByAdapter.has(adapter)) {
      const existing = steps.find((step) => step.adapter === adapter);
      const dependencies = safeDependencyIds(existing.id, dependencyAdapters);
      existing.depends_on = [...new Set([...(existing.depends_on || []), ...dependencies])].filter((id) => id !== existing.id);
      // A knowledge helper can later become an explicitly requested or hard
      // handoff specialist. Promote it instead of leaving it cap-exempt with
      // the generic support task and missing selection provenance.
      if (existing.resource_support === true && !resourceSupport) {
        delete existing.resource_support;
        existing.task = task;
      } else if (selection) {
        existing.task = task;
      }
      if (selection) selections.set(adapter, selection);
      return idByAdapter.get(adapter);
    }
    if (adapter !== "writing_synthesis_lora" && !resourceSupport
      && steps.filter((step) => step.adapter !== "writing_synthesis_lora" && step.resource_support !== true).length >= specialistLimit) {
      return undefined;
    }
    const id = `s${steps.length + 1}`;
    const depends_on = safeDependencyIds(id, dependencyAdapters);
    steps.push({ id, adapter, task, depends_on, ...(resourceSupport ? { resource_support: true } : {}) });
    idByAdapter.set(adapter, id);
    if (selection) {
      selections.set(adapter, selection);
    }
    return id;
  };

  const configuredDependencies = (agent = {}) => configuredAgentDependencies(agent);

  const dependencyClosure = (rootAdapter) => {
    const ordered = [];
    const visited = new Set();
    const visiting = new Set();
    const missing = [];
    const resourceDependencies = new Set();
    const handoffDependencies = new Set();
    let cycle = false;
    const walk = (adapter) => {
      if (visited.has(adapter)) return;
      if (visiting.has(adapter)) {
        cycle = true;
        return;
      }
      const agent = enabledById.get(adapter);
      if (!agent) {
        missing.push(adapter);
        return;
      }
      visiting.add(adapter);
      for (const dependencyId of configuredResourceDependencies(agent)) resourceDependencies.add(dependencyId);
      for (const dependencyId of configuredHandoffDependencies(agent)) handoffDependencies.add(dependencyId);
      for (const dependencyId of configuredDependencies(agent)) {
        if (dependencyId === adapter) {
          cycle = true;
          continue;
        }
        if (!enabledById.has(dependencyId)) missing.push(dependencyId);
        else walk(dependencyId);
      }
      visiting.delete(adapter);
      visited.add(adapter);
      ordered.push(adapter);
    };
    walk(rootAdapter);
    return {
      ordered,
      missing: [...new Set(missing)],
      cycle,
      resourceSupport: new Set(
        [...resourceDependencies].filter((dependencyId) => (
          dependencyId !== rootAdapter && !handoffDependencies.has(dependencyId)
        ))
      )
    };
  };

  const add = (adapter, task, dependencyAdapters = [], selection = null) => {
    const closure = dependencyClosure(adapter);
    if (closure.cycle || closure.missing.length) return undefined;
    const additions = closure.ordered.filter((candidate) => !idByAdapter.has(candidate));
    const promotions = closure.ordered.filter((candidate) => {
      const existing = steps.find((step) => step.adapter === candidate);
      return existing?.resource_support === true && !closure.resourceSupport.has(candidate);
    });
    const occupied = steps.filter((step) => (
      step.adapter !== "writing_synthesis_lora" && step.resource_support !== true
    )).length;
    const countedAdditions = additions.filter((candidate) => (
      candidate !== "writing_synthesis_lora" && !closure.resourceSupport.has(candidate)
    )).length;
    if (occupied + countedAdditions + promotions.length > specialistLimit) return undefined;
    const occupiedResourceSupport = steps.filter((step) => step.resource_support === true).length;
    const resourceAdditions = additions.filter((candidate) => closure.resourceSupport.has(candidate)).length;
    if (occupiedResourceSupport - promotions.length + resourceAdditions > resourceSupportLimit) return undefined;

    for (const currentAdapter of closure.ordered) {
      const currentAgent = enabledById.get(currentAdapter);
      const isRoot = currentAdapter === adapter;
      const configured = configuredDependencies(currentAgent);
      const result = addStep(
        currentAdapter,
        isRoot ? task : CONFIGURED_HANDOFF_TASK,
        isRoot ? [...new Set([...configured, ...dependencyAdapters])] : configured,
        isRoot ? selection : null,
        closure.resourceSupport.has(currentAdapter)
      );
      if (!result) return undefined;
    }
    return idByAdapter.get(adapter);
  };

  const approvedWorkflowAgents = [...new Set(
    (Array.isArray(requiredAgentIds) ? requiredAgentIds : [])
      .map((agentId) => String(agentId || "").trim())
      .filter((agentId) => agentId && hasAgent(agentId))
  )];
  const boundAttachmentAgents = [...new Set(
    (Array.isArray(attachmentAgentIds) ? attachmentAgentIds : [])
      .map((agentId) => String(agentId || "").trim())
      .filter((agentId) => agentId && hasAgent(agentId))
  )];
  if (boundAttachmentAgents.length && !approvedWorkflowAgents.length) {
    if (boundAttachmentAgents.length > specialistLimit) {
      const error = new Error(`The attached files exceed the ${specialistLimit}-specialist route limit.`);
      error.code = "chat_attachment_route_limit_exceeded";
      throw error;
    }
    for (const agentId of boundAttachmentAgents) {
      const agent = enabledById.get(agentId);
      const added = add(agentId, `Retrieve only from the explicitly referenced chat file using ${agent?.title || "its session source agent"}.`, [], {
        adapter: agentId,
        source: "chat_attachment",
        confidence: 1,
        reality_rank: rankingScore(agentRankings[agentId]),
        reason: "Bound to an explicitly referenced, session-authorized chat attachment."
      });
      if (!added) {
        const error = new Error("The referenced chat file cannot fit its complete configured handoff graph within the current specialist limit and active team.");
        error.code = "chat_attachment_dependency_closure_unavailable";
        throw error;
      }
    }
    return {
      steps,
      routing: {
        mode: "chat_attachment",
        candidate_trace: [],
        explicit_adapters: [],
        attachment_adapters: boundAttachmentAgents,
        selected: steps.map((step) => selections.get(step.adapter) || {
          adapter: step.adapter,
          source: "configured_handoff",
          confidence: 1,
          reality_rank: rankingScore(agentRankings[step.adapter]),
          reason: "Included by the attachment source agent's saved handoff."
        })
      }
    };
  }
  if (approvedWorkflowAgents.length) {
    if (approvedWorkflowAgents.length > specialistLimit) {
      const error = new Error(`The approved workflow exceeds the ${specialistLimit}-specialist route limit.`);
      error.code = "workflow_route_limit_exceeded";
      throw error;
    }
    for (const agentId of approvedWorkflowAgents) {
      const agent = enabled.find((candidate) => candidate.id === agentId);
      const added = add(agentId, `Complete the approved workflow assignment for ${agent?.title || "this specialist"}.`, [], {
        adapter: agentId,
        source: "approved_workflow",
        confidence: 1,
        reality_rank: rankingScore(agentRankings[agentId]),
        reason: "Selected by the workflow the user approved."
      });
      if (!added) {
        const error = new Error("The approved workflow cannot fit its complete configured handoff graph within the current specialist limit and active team.");
        error.code = "workflow_dependency_closure_unavailable";
        throw error;
      }
    }
    const plannedAdapters = new Set(steps.map((step) => step.adapter));
    if (approvedWorkflowAgents.some((adapter) => !plannedAdapters.has(adapter))) {
      const error = new Error("The approved workflow could not be compiled without dropping a requested specialist.");
      error.code = "workflow_plan_incomplete";
      throw error;
    }
    const dependencyGaps = configuredPlanGaps(steps, enabled);
    if (dependencyGaps.length) {
      const error = new Error(`The approved workflow is missing configured handoffs: ${dependencyGaps.join(", ")}.`);
      error.code = "workflow_plan_incomplete";
      throw error;
    }
    return {
      steps,
      routing: {
        mode: "approved_workflow",
        candidate_trace: [],
        explicit_adapters: [],
        selected: steps.map((step) => selections.get(step.adapter) || {
          adapter: step.adapter,
          source: "configured_handoff",
          confidence: 1,
          reality_rank: rankingScore(agentRankings[step.adapter]),
          reason: "Included by the approved workflow's saved handoff."
        })
      }
    };
  }

  const error = new Error("The bound route contains no available specialist to compile.");
  error.code = "bound_route_unavailable";
  throw error;
}

function rankingScore(value) {
  const score = Number(value?.score ?? value);
  return Number.isFinite(score) && score >= 0 && score <= 1 ? score : 0.5;
}

export function sanitizeToolCalls(rawText, allowedTools = []) {
  const violations = [];
  const sanitized = String(rawText || "").replace(/<tool_call>([\s\S]*?)<\/tool_call>/g, (_match, payload) => {
    try {
      const parsed = JSON.parse(payload);
      const toolName = parsed?.name || parsed?.tool || parsed?.tool_name;
      if (!toolName) {
        violations.push("malformed_tool_call");
        return "[Blocked malformed tool call]";
      }
      if (!allowedTools.includes(toolName)) {
        violations.push(`unauthorized_tool:${toolName}`);
        return `[Blocked unauthorized tool call: ${toolName}]`;
      }
      return `[Authorized tool call: ${toolName}]`;
    } catch {
      violations.push("malformed_tool_call");
      return "[Blocked malformed tool call]";
    }
  });

  return {
    text: stripHiddenReasoningMarkup(sanitized).trim(),
    violations
  };
}

export async function processLocalChatRun({ store, bus, run_id, options = {} }) {
  const started = Date.now();
  try {
    const snapshot = store.read((data) => ({
      run: data.runs.find((item) => item.run_id === run_id),
      session: data.sessions.find((item) => item.session_id === data.runs.find((run) => run.run_id === run_id)?.session_id),
      agents: data.agents,
      documents: data.documents,
      agentWorkspaces: data.agentWorkspaces || [],
      messages: data.messages,
      outcomeContracts: data.outcomeContracts || [],
      executionRecords: data.executionRecords || [],
      worldGraphArtifacts: data.worldGraphArtifacts || [],
      worldGraphEvents: data.worldGraphEvents || []
    }));
    if (!snapshot.run) {
      throw new Error("Run not found.");
    }

    const query = snapshot.run.query;
    const agentWorkspace = (snapshot.agentWorkspaces || []).find((workspace) => (
      workspace.agent_workspace_id === snapshot.run.agent_workspace_id
      && String(workspace.workspace_id || "") === String(snapshot.session?.workspace_id || "")
      && workspace.created_by === snapshot.session?.created_by
    )) || null;
    const scoped = scopedRoutingContext({
      session: snapshot.session,
      agents: snapshot.agents,
      documents: snapshot.documents,
      agentWorkspace
    });
    const requiredAdapters = [...new Set(
      (Array.isArray(snapshot.run.requested_agent_ids)
        ? snapshot.run.requested_agent_ids
        : Array.isArray(options.required_adapters)
          ? options.required_adapters
          : [])
        .map((adapter) => String(adapter || "").trim())
        .filter(Boolean)
    )];
    const attachmentAdapters = [...new Set(
      (Array.isArray(snapshot.run.attachment_agent_ids)
        ? snapshot.run.attachment_agent_ids
        : Array.isArray(options.attachment_adapters)
          ? options.attachment_adapters
          : [])
        .map((adapter) => String(adapter || "").trim())
        .filter(Boolean)
    )];
    const allowedAdapterSet = new Set(scoped.allowedAdapters);
    if (requiredAdapters.some((adapter) => !allowedAdapterSet.has(adapter))) {
      const error = new Error("A workflow specialist is no longer available in the active team.");
      error.code = "workflow_agent_unavailable";
      throw error;
    }
    if (attachmentAdapters.some((adapter) => !allowedAdapterSet.has(adapter))) {
      const error = new Error("A referenced chat file is no longer available in this session.");
      error.code = "chat_attachment_agent_unavailable";
      throw error;
    }
    const agentRankings = realityRankMap(snapshot, {
      agents: scoped.agents,
      workspaceId: snapshot.session?.workspace_id,
      query
    });
    const plan = planRoutes({
      query,
      agents: scoped.agents,
      documents: scoped.documents,
      agentRankings,
      maxRoutingAdapters: Number(options.max_routing_adapters) || 16,
      requiredAgentIds: requiredAdapters,
      attachmentAgentIds: attachmentAdapters
    });
    const parallel = buildParallelBatches(plan.steps, Number(options.parallel_workers) || 2);
    await persistRunTransition({
      store,
      bus,
      runId: run_id,
      patch: { status: "running", started_at: nowIso(), plan, parallel },
      events: [
        { type: "run.started", run_id },
        { type: "planner.started" },
        { type: "planner.completed", steps: plan.steps }
      ]
    });

    const routeOutputs = [];
    const worldGraphDecisions = [];
    for (const batch of parallel.batches) {
      const batchSteps = plan.steps.filter((step) => batch.steps.includes(step.id));
      await Promise.all(batchSteps.map(async (step) => {
        const routeStarted = Date.now();
        const replay = selectWorldGraphSeedForStep({
          data: snapshot,
          run: snapshot.run,
          session: snapshot.session,
          plan,
          step,
          agents: scoped.agents,
          documents: scoped.documents,
          sharedMemory: normalizeSharedMemory(snapshot.session?.shared_memory || []),
          options,
          resolvedOutputs: routeOutputs,
          runFresh: options.run_fresh === true
        });
        const routeStartedEvent = replay.seed ? null : {
          type: "route.started",
          step_id: step.id,
          adapter: step.adapter,
          agent_revision: agentRevision(scoped.agents.find((agent) => agent.id === step.adapter) || { id: step.adapter }),
          adapter_digest: null,
          model_id: BASE_MODEL,
          batch: batch.batch
        };
        worldGraphDecisions.push(replay.decision);
        const result = replay.seed || {
          ...buildRouteOutput({
            step,
            plan,
            query,
            agents: scoped.agents,
            documents: scoped.documents,
            upstream: routeOutputs,
            sharedMemory: normalizeSharedMemory(snapshot.session?.shared_memory || [])
          }),
          execution_mode: "refreshed"
        };
        const elapsed = Number(((Date.now() - routeStarted) / 1000 + 0.015).toFixed(3));
        routeOutputs.push({
          ...result,
          elapsed_sec: replay.seed ? 0 : elapsed,
          parallel_batch: batch.batch,
          parallel_width: batch.width
        });
        const routeCompletedEvent = {
          type: replay.seed ? "route.reused" : "route.completed",
          step_id: step.id,
          adapter: step.adapter,
          elapsed_sec: replay.seed ? 0 : elapsed,
          execution_mode: replay.seed ? "reused" : "refreshed"
        };
        await persistCompletedRunRoute({
          store,
          bus,
          runId: run_id,
          startedEvent: routeStartedEvent,
          completedEvent: routeCompletedEvent,
          runStep: {
            run_step_id: makeId("run_step"),
            run_id,
            step_id: step.id,
            adapter: step.adapter,
            task: step.task,
            depends_on: step.depends_on || [],
            used_upstream: step.depends_on || [],
            parallel_batch: batch.batch,
            parallel_width: batch.width,
            status: "completed",
            execution_mode: replay.seed ? "reused" : "refreshed",
            reused_from_artifact_id: result.reused_from_artifact_id || null,
            reused_from_run_id: result.reused_from_run_id || null,
            world_graph_reason: replay.decision.reason,
            agent_reasoning: result.agent_reasoning,
            domain_answer: result.domain_answer,
            handoffs: result.handoffs,
            handoff_artifacts: result.handoff_artifacts,
            artifact_validation: result.artifact_validation,
            outcome_validation: result.outcome_validation,
            consumed_artifacts: result.consumed_artifacts,
            consumption_validation: result.consumption_validation,
            source_validation: result.source_validation,
            used_memory: result.used_memory,
            boundary_check: result.boundary_check,
            allowed_tools: result.allowed_tools,
            tool_executions: safeRuntimeToolExecutions(result.tool_executions),
            approved_sources: result.approved_sources,
            policy_violations: result.policy_violations,
            retrieved_context: result.retrieved_context,
            citations: result.citations,
            raw_text_admin_only: result.raw_text,
            prompt_preview_admin_only: `Adapter ${step.adapter} received task: ${step.task}`,
            started_at: new Date(routeStarted).toISOString(),
            completed_at: nowIso(),
            elapsed_sec: replay.seed ? 0 : elapsed
          }
        });
      }));
    }

    await updateRun(store, bus, run_id, { status: "synthesizing" }, { type: "synthesis.started" });
    const finalAnswer = synthesizeFinalAnswer(query, routeOutputs);
    const citations = routeOutputs.flatMap((output) => output.citations);
    const policyEvents = routeOutputs.flatMap((output) =>
      output.policy_violations.map((violation) => ({ step_id: output.step_id, adapter: output.adapter, violation }))
    );
    const assistantMessageId = makeId("msg");
    const completedAt = nowIso();
    const elapsedSec = Number(((Date.now() - started) / 1000).toFixed(3));

    await store.mutate((data) => {
      const run = data.runs.find((item) => item.run_id === run_id);
      const session = data.sessions.find((item) => item.session_id === run.session_id);
      run.status = "completed";
      run.final_answer = finalAnswer;
      // Route outputs have a single canonical persisted representation in
      // runSteps. Avoid duplicating raw model envelopes (including hidden
      // reasoning or tool payloads) on the run record.
      run.expert_outputs = [];
      run.sources = citations;
      run.policy_events = policyEvents;
      run.token_accounting = {
        schema_version: "router-token-accounting-v1",
        provider_reported: false,
        complete: false,
        call_count: 0,
        calls: [],
        totals: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        missing_usage: ["local_simulator_does_not_call_a_model"]
      };
      recordWorldGraphRun({
        data,
        run,
        session,
        plan,
        outputs: routeOutputs,
        agents: scoped.agents,
        documents: scoped.documents,
        sharedMemory: normalizeSharedMemory(snapshot.session?.shared_memory || []),
        options,
        decisions: worldGraphDecisions,
        createdAt: completedAt
      });
      settleRunCredits(data, run, run.token_accounting);
      run.assistant_message_id = assistantMessageId;
      run.completed_at = completedAt;
      run.elapsed_sec = elapsedSec;
      run.reality_rank_snapshot = agentRankings;
      data.messages.push({
        message_id: assistantMessageId,
        session_id: run.session_id,
        role: "assistant",
        content: finalAnswer,
        attachments: [],
        run_id,
        usage_receipt: run.usage_receipt,
        billing: run.billing,
        created_at: completedAt
      });
      if (session) {
        session.updated_at = completedAt;
        session.last_message_at = completedAt;
        session.shared_memory = nextSharedMemory(session.shared_memory, [
          { tag: "user_request", source: "user", content: query },
          ...routeOutputSharedMemoryEntries(routeOutputs),
          { tag: "base.synthesis", source: BASE_MODEL, content: finalAnswer }
        ]);
      }
      run.events.push({ type: "final.completed", message_id: assistantMessageId, elapsed_sec: elapsedSec, at: completedAt });
      recordExecution(data, {
        run,
        session,
        agents: snapshot.agents,
        baseModel: BASE_MODEL,
        recordedAt: completedAt
      });
      return run;
    });
    bus.publish(run_id, { type: "final.completed", message_id: assistantMessageId, elapsed_sec: elapsedSec });
  } catch (error) {
    const failure = normalizeRunFailure(error, "run_failed");
    await store.mutate((data) => {
      const run = data.runs.find((item) => item.run_id === run_id);
      if (run) {
        run.status = "failed";
        run.error = failure.public;
        run.error_admin_only = failure.admin;
        run.completed_at = nowIso();
        releaseRunReservation(data, run, { reason: failure.public.code || "run_failed" });
        run.events.push({
          type: "run.failed",
          code: failure.public.code,
          message: failure.public.message,
          retryable: failure.public.retryable,
          action: failure.public.action,
          at: nowIso()
        });
        const session = data.sessions.find((item) => item.session_id === run.session_id);
        recordExecution(data, {
          run,
          session,
          agents: data.agents,
          baseModel: BASE_MODEL,
          recordedAt: run.completed_at
        });
      }
      return run;
    });
    bus.publish(run_id, {
      type: "run.failed",
      code: failure.public.code,
      message: failure.public.message,
      retryable: failure.public.retryable,
      action: failure.public.action
    });
  }
}

function contextArtifactName(row = {}) {
  return boundedText(row.name || row.artifact || row.type, 160);
}

function contextArtifactProducer(row = {}, output = {}) {
  return boundedText(
    output.adapter || row.producer || row.producer_agent_id,
    160
  );
}

function isDocumentContextArtifact(row = {}) {
  const name = contextArtifactName(row);
  return DOCUMENT_CONTEXT_ARTIFACTS.has(name)
    || /^(document_|retrieved_|cited_|source_)/.test(name);
}

function isStructuredContextArtifact(row = {}) {
  const name = contextArtifactName(row);
  if (isDocumentContextArtifact(row) && !STRUCTURED_CONTEXT_ARTIFACTS.has(name)) {
    return false;
  }
  return STRUCTURED_CONTEXT_ARTIFACTS.has(name)
    || /(table|structured|record|schema|metric|number|calculation)/.test(name)
    || Array.isArray(row.value)
    || (row.value && typeof row.value === "object")
    || String(row.content_type || "").toLowerCase().includes("json");
}

export function resolveAgentContext({ agent = {}, step = {}, upstream = [], sharedMemory = [] }) {
  const consumes = [...new Set((agent.consumes || []).map((value) => String(value || "").trim()).filter(Boolean))];
  const consumeSet = new Set(consumes);
  const aggregateInputs = new Set(consumes.filter((value) => AGGREGATE_CONTEXT_INPUTS.has(value)));
  const scopedProducers = new Set(consumes.flatMap((value) => {
    const match = value.match(/^agent:([a-z0-9][a-z0-9_-]*):output$/i);
    return match ? [match[1]] : [];
  }));
  const dependencyIds = new Set(Array.isArray(step.depends_on) ? step.depends_on : []);
  const scopedUpstream = (Array.isArray(upstream) ? upstream : []).filter((output) =>
    dependencyIds.has(output?.step_id || output?.id)
    || dependencyIds.has(output?.adapter)
  );
  const resolved = new Set();
  const rejected = [];
  const availableNames = new Set();
  const declaredUpstreamNames = new Set();
  const consumedArtifacts = [];
  const seen = new Set();

  const matchingContracts = (row, output) => {
    const matches = new Set(aggregateInputs);
    const name = contextArtifactName(row);
    const producer = contextArtifactProducer(row, output);
    if (consumeSet.has(name)) matches.add(name);
    if (consumeSet.has("document_context") && isDocumentContextArtifact(row)) matches.add("document_context");
    if (consumeSet.has("table_context") && isStructuredContextArtifact(row)) matches.add("table_context");
    if (producer && scopedProducers.has(producer)) matches.add(`agent:${producer}:output`);
    return matches;
  };

  for (const output of scopedUpstream) {
    for (const name of output?.artifact_validation?.declared_produces || []) {
      if (String(name || "").trim()) declaredUpstreamNames.add(String(name).trim());
    }
    for (const row of Array.isArray(output?.handoff_artifacts) ? output.handoff_artifacts : []) {
      if (!row || typeof row !== "object" || Array.isArray(row)) {
        rejected.push("malformed_upstream_artifact");
        continue;
      }
      const name = contextArtifactName(row);
      availableNames.add(name);
      const matches = matchingContracts(row, output);
      if (matches.size === 0) continue;
      const claimedProducer = boundedText(row.producer || row.producer_agent_id, 160);
      const outputProducer = boundedText(output.adapter, 160);
      if (claimedProducer && outputProducer && claimedProducer !== outputProducer) {
        rejected.push(`upstream_producer_mismatch:${name}`);
        continue;
      }
      if (row.verified === false || row.value === undefined || row.value === null || row.value === "") {
        rejected.push(`invalid_upstream_artifact:${name}`);
        continue;
      }
      const suppliedDigest = String(row.content_digest || "").trim();
      const normalizedDigest = normalizeSha256Digest(suppliedDigest);
      if (suppliedDigest && (!normalizedDigest || normalizedDigest !== digestValue(normalizeArtifactValue(row.value)))) {
        rejected.push(`upstream_digest_mismatch:${name}`);
        continue;
      }
      const producer = contextArtifactProducer(row, output);
      const key = [row.artifact_id || "", producer, name, row.content_digest || digestValue(row.value)].join("|");
      for (const match of matches) resolved.add(match);
      if (seen.has(key)) continue;
      seen.add(key);
      consumedArtifacts.push({
        artifact_id: boundedText(row.artifact_id, 240),
        schema_version: boundedText(row.schema_version || "tcar-handoff-artifact-v1", 120),
        name,
        value: normalizeArtifactValue(row.value),
        content_digest: normalizeSha256Digest(row.content_digest) || digestValue(normalizeArtifactValue(row.value)),
        producer,
        producer_step_id: boundedText(row.producer_step_id || output.step_id || output.id, 160),
        evidence: boundedStringList(row.evidence, 50, 240),
        confidence: finiteProbabilityOrNull(row.confidence)
      });
    }
  }

  const required = new Set();
  for (const value of consumes) {
    if (declaredUpstreamNames.has(value)) required.add(value);
  }
  for (const producer of scopedProducers) required.add(`agent:${producer}:output`);
  if (scopedUpstream.length > 0) {
    for (const value of aggregateInputs) required.add(value);
    const declaredOutputs = [...declaredUpstreamNames];
    if (
      consumeSet.has("document_context")
      && producedContractSupportsContext(declaredOutputs, ["document_context"])
    ) required.add("document_context");
    if (
      consumeSet.has("table_context")
      && producedContractSupportsContext(declaredOutputs, ["table_context"])
    ) required.add("table_context");
  }
  const missing = [...required].filter((value) => !resolved.has(value));
  const unresolved = consumes.filter((value) => !INTRINSIC_CONTEXT_INPUTS.has(value) && !resolved.has(value));
  const consumedNames = new Set(consumedArtifacts.map((row) => row.name));
  const acceptsMemory = consumeSet.has("shared_memory") || consumeSet.has("conversation_context");
  const usedMemory = acceptsMemory ? normalizeSharedMemory(sharedMemory) : [];

  return {
    consumed_artifacts: consumedArtifacts,
    used_memory: usedMemory,
    validation: {
      contract_version: "tcar-handoff-v1",
      consumer: agent.id || step.adapter || "",
      declared_consumes: consumes,
      aggregate_consumes: [...aggregateInputs].sort(),
      resolved_contract_inputs: [...resolved].sort(),
      resolved_from_upstream: [...consumedNames].sort(),
      required_from_upstream: [...required].sort(),
      missing_from_upstream: missing.sort(),
      unresolved: unresolved.sort(),
      available_but_not_consumed: aggregateInputs.size > 0
        ? []
        : [...availableNames].filter((name) => !consumedNames.has(name)).sort(),
      rejected: [...new Set(rejected)],
      valid: missing.length === 0 && rejected.length === 0
    }
  };
}

function buildRouteOutput({ step, plan, query, agents, documents, upstream = [], sharedMemory = [] }) {
  const agent = agents.find((item) => item.id === step.adapter);
  const citations = gatherCitations({ step, agent, query, documents });
  const retrievedContext = citations
    .map((citation) => `${citation.chunk_id || citation.path}:${citation.title} - ${citation.excerpt}`)
    .join("\n");
  const context = resolveAgentContext({ agent, step, upstream, sharedMemory });
  const missingContext = context.validation.missing_from_upstream;
  const domainAnswer = context.validation.valid
    ? domainAnswerFor(step.adapter, query, citations, agent, context.consumed_artifacts, context.used_memory)
    : `Required verified context was unavailable: ${missingContext.join(", ") || context.validation.rejected.join(", ")}.`;
  const handoffArtifacts = context.validation.valid ? buildLocalHandoffArtifacts({
    step,
    agent,
    domainAnswer,
    citations,
    retrievedContext
  }) : [];
  const rawText = [
    "AGENT_REASONING:",
    `- Selected because the request matched ${agent?.title || step.adapter}.`,
    "",
    "DOMAIN_ANSWER:",
    domainAnswer,
    "",
    "HANDOFFS:",
    handoffArtifacts.length
      ? handoffArtifacts.map((artifact) => `- ${artifact.artifact}`).join("\n")
      : "- No validated handoff artifact was produced.",
    "",
    "BOUNDARY_CHECK:",
    agent?.boundary || "Stay within the route capability and surface uncertainty.",
    retrievedContext ? `\nEXECUTOR_RETRIEVED_CONTEXT:\n${retrievedContext}` : ""
  ].join("\n");
  const sanitized = sanitizeToolCalls(rawText, agent?.tools || []);
  if (!context.validation.valid) {
    sanitized.violations.push(...missingContext.map((name) => `invalid_upstream_contract:${name}`));
  }
  const sections = parseRouteSections(sanitized.text);
  const routeOutcomeContract = worldGraphRouteOutcomeContract(plan || { steps: [step] }, step);
  const producedNames = new Set(handoffArtifacts.map((artifact) => artifact.name));
  const expectedOutputs = routeOutcomeContract.expected_outputs;

  return {
    step_id: step.id,
    adapter: step.adapter,
    modelId: BASE_MODEL,
    task: step.task,
    agent_reasoning: sections.agent_reasoning,
    domain_answer: sections.domain_answer,
    handoffs: sections.handoffs,
    handoff_artifacts: handoffArtifacts,
    artifact_validation: {
      contract_version: "tcar-handoff-v1",
      declared_produces: [...new Set(agent?.produces || [])],
      produced: handoffArtifacts.map((artifact) => artifact.name),
      missing: [...new Set(agent?.produces || [])].filter((name) => !handoffArtifacts.some((artifact) => artifact.name === name)),
      errors: context.validation.valid ? [] : missingContext.map((name) => `blocked_by_input_contract:${name}`),
      warnings: [],
      valid: context.validation.valid
    },
    outcome_validation: {
      contract_version: "session-step-outcome-v1",
      expected_outputs: expectedOutputs,
      produced_expected_outputs: expectedOutputs.filter((name) => producedNames.has(name)),
      missing_expected_outputs: expectedOutputs.filter((name) => !producedNames.has(name)),
      fulfills: routeOutcomeContract.fulfills,
      valid: context.validation.valid && expectedOutputs.every((name) => producedNames.has(name))
    },
    consumed_artifacts: context.consumed_artifacts,
    consumption_validation: context.validation,
    used_memory: context.used_memory.map(({ tag, source }) => ({ tag, source })),
    boundary_check: sections.boundary_check,
    retrieved_context: sections.retrieved_context,
    allowed_tools: agent?.tools || [],
    tool_executions: [],
    approved_sources: agent?.sources || [],
    policy_violations: sanitized.violations,
    citations,
    source_validation: {
      valid: true,
      violations: [],
      approved_source_count: citations.length
    },
    output_contract: routeOutcomeContract.execution_output_contract,
    raw_text: sanitized.text
  };
}

function gatherCitations({ step, agent, query, documents }) {
  const citations = [];
  if (agent?.document || agent?.retrieval?.type === "document_markdown") {
    const document = documents.find((doc) => doc.agent_id === step.adapter || doc.agent_id === agent.id);
    if (document) {
      assertStoredDocumentIntegrity(document);
      const documentChunks = new Map((document.chunks || []).map((chunk) => [chunk.chunk_id, chunk]));
      citations.push(
        ...scoreChunks(document.chunks || [], query, document.top_k || 4).flatMap((chunk) => {
          const indexedChunk = documentChunks.get(chunk.chunk_id);
          if (!indexedChunk || chunk.path !== indexedChunk.path || !isApprovedCitationPath(chunk.path, [document.index_path])) {
            return [];
          }
          return [{
          citation_id: stableCitationId({
            step_id: step.id,
            agent_id: step.adapter,
            path: chunk.path,
            chunk_id: chunk.chunk_id,
            content_digest: chunk.content_digest || null,
            corpus_revision: document.corpus_revision || null,
            index_digest: document.index_digest || null,
            excerpt: chunk.excerpt
          }),
          step_id: step.id,
          agent_id: step.adapter,
          path: chunk.path,
          chunk_id: chunk.chunk_id,
          title: chunk.title,
          page_start: chunk.page_start,
          page_end: chunk.page_end,
          score: chunk.score,
          excerpt: chunk.excerpt,
          content_digest: chunk.content_digest || null,
          corpus_revision: document.corpus_revision || null,
          index_digest: document.index_digest || null,
          injected: chunk.injected,
          claim: "",
          verified: true
          }];
        })
      );
    }
  }

  for (const sourcePath of agent?.sources || []) {
    const source = approvedSourceSnippets[sourcePath];
    if (source) {
      citations.push({
        citation_id: stableCitationId({
          step_id: step.id,
          agent_id: step.adapter,
          path: sourcePath,
          chunk_id: sourcePath.split("/").pop(),
          excerpt: source.excerpt
        }),
        step_id: step.id,
        agent_id: step.adapter,
        path: sourcePath,
        chunk_id: sourcePath.split("/").pop(),
        title: source.title,
        page_start: null,
        page_end: null,
        score: source.score,
        excerpt: source.excerpt,
        injected: true,
        claim: "",
        verified: true
      });
    } else if (agent?.source_text_internal && sourcePath === agent.sources[0] && isApprovedCitationPath(sourcePath, agent.sources)) {
      citations.push({
        citation_id: stableCitationId({
          step_id: step.id,
          agent_id: step.adapter,
          path: sourcePath,
          chunk_id: `${step.adapter}_source_0001`,
          excerpt: selectSourceExcerpt(agent.source_text_internal, query)
        }),
        step_id: step.id,
        agent_id: step.adapter,
        path: sourcePath,
        chunk_id: `${step.adapter}_source_0001`,
        title: `${agent.title || step.adapter} private knowledge`,
        page_start: null,
        page_end: null,
        score: 1,
        excerpt: selectSourceExcerpt(agent.source_text_internal, query),
        injected: true,
        claim: "",
        verified: true
      });
    }
  }

  return citations;
}

function buildLocalHandoffArtifacts({ step, agent, domainAnswer, citations, retrievedContext }) {
  const declared = [...new Set((agent?.produces || []).map((name) => boundedText(name, 160)).filter(Boolean))];
  const names = declared.length > 0 ? declared : ["domain_answer"];
  return names.flatMap((artifact) => {
    let value = domainAnswer;
    let contentType = "text/plain";
    if (["retrieved_context", "cited_passages"].includes(artifact)) {
      value = artifact === "retrieved_context" ? retrievedContext : citations;
      contentType = artifact === "retrieved_context" ? "text/plain" : "application/json";
    } else if (artifact === "source_confidence") {
      value = citations.length > 0 ? 1 : 0;
      contentType = "application/json";
    } else if (artifact === "structured_data") {
      value = { summary: domainAnswer };
      contentType = "application/json";
    }
    if (value === "" || value === null || value === undefined || (Array.isArray(value) && value.length === 0)) {
      return [];
    }
    const normalizedValue = normalizeArtifactValue(value);
    const contentDigest = digestValue(normalizedValue);
    return [{
      artifact_id: `artifact_${digestValue({ step_id: step.id, name: artifact, value: normalizedValue }).slice("sha256:".length, "sha256:".length + 24)}`,
      schema_version: "tcar-handoff-artifact-v1",
      name: artifact,
      artifact,
      producer_step_id: step.id,
      producer_agent_id: step.adapter,
      producer: step.adapter,
      content_type: contentType,
      value: normalizedValue,
      content_digest: contentDigest,
      evidence: citations.map((citation) => citation.chunk_id).filter(Boolean),
      confidence: citations.length > 0 ? 1 : null,
      status: "local_executor_derived",
      verified: true
    }];
  });
}

function domainAnswerFor(adapter, query, citations, agent, consumedArtifacts = [], usedMemory = []) {
  if (adapter === "legal_privacy_lora") {
    return "Require clear opt-in consent, explain what messages the user will receive, avoid collecting unnecessary protected details, and keep records of consent state, timestamp, source, and withdrawal. Treat this as general legal/privacy guidance and route jurisdiction-specific review to counsel.";
  }
  if (adapter === "health_safety_lora") {
    return "Use educational language, avoid diagnosis or personalized treatment, and include a direct care boundary: urgent or worsening symptoms should go to a qualified clinician or emergency services. Keep newsletter wording practical and patient-safe.";
  }
  if (adapter === "customer_support_lora") {
    return "Create support language that acknowledges the request, states what can be verified, avoids overpromising, and gives a clear escalation path. For FAQs, include consent changes, unsubscribe, privacy questions, delivery issues, and when to contact support.";
  }
  if (adapter === "refund_policy_lora") {
    return "The approved policy supports a damaged-on-arrival path when the customer provides photos and order context within 7 days. Support can offer replacement or refund after eligibility is confirmed, but should not promise either before validation.";
  }
  if (adapter === "finance_risk_lora") {
    return "Track replacement shipping, refund exposure, chargeback risk, and inventory impact. Confirm order value and eligibility before committing to a financial remedy.";
  }
  if (adapter === "linear_algebra_textbook_lora" || adapter.includes("document") || agent?.document) {
    if (citations.length === 0) {
      return "No relevant document chunks were retrieved, so the route should not make document-specific claims.";
    }
    if (query.toLowerCase().includes("rank")) {
      return "Using the retrieved textbook chunks, rank-nullity says dim(V) = rank(T) + nullity(T). If dim(V)=8 and nullity(T)=3, then rank(T)=5.";
    }
    return `Use the retrieved chunks only: ${citations.map((citation) => citation.title).join(", ")}. Cite chunk ids when presenting document-specific claims.`;
  }
  if (adapter === "software_architect_lora") {
    return "Expose stable API endpoints for chat sessions, async run events, route details, agents, documents, runtime health, validation, and metrics. Keep vLLM behind the backend and persist sessions, runs, route outputs, citations, and telemetry.";
  }
  if (adapter === "security_review_lora") {
    return "Do not expose direct model endpoints to end users. Validate source paths, restrict tool names server-side, sanitize chain-of-thought tags, limit upload types and sizes, and return safe fallbacks for failed routes.";
  }
  if (adapter === "project_planning_lora") {
    return "Sequence the work as chat-first UI, API contracts, deterministic execution, document upload, admin observability, and stress tests. Verify with automated API tests and a production build.";
  }
  if (adapter === "product_strategy_lora") {
    return "Position the product as one chat box backed by controlled specialist route identities, approved sources, tool authorization, and transparent execution details.";
  }
  if (adapter === "data_math_tool_lora") {
    return "Show formulas and arithmetic explicitly, separate assumptions from computed values, and run sanity checks before synthesis.";
  }
  if (adapter === "writing_synthesis_lora") {
    return "Merge upstream route outputs into one clear answer, preserving legal, health, finance, source, and policy caveats where relevant.";
  }
  if (consumedArtifacts.length > 0) {
    const byProducer = new Map();
    for (const artifact of consumedArtifacts) {
      const producer = artifact.producer || "upstream";
      const group = byProducer.get(producer) || { producer, names: [], sample: "" };
      if (!group.names.includes(artifact.name)) group.names.push(artifact.name);
      if (!group.sample) {
        const value = typeof artifact.value === "string"
          ? artifact.value
          : JSON.stringify(artifact.value);
        group.sample = boundedText(value, 600);
      }
      byProducer.set(producer, group);
    }
    const contextSummary = [...byProducer.values()].slice(0, 6)
      .map((group) => `${group.producer} supplied ${group.names.slice(0, 6).join(", ")}: ${group.sample}`)
      .join(" ");
    return boundedText(`Using verified upstream context: ${contextSummary}`, 5000);
  }
  if (citations.length > 0) {
    return `Based on the agent's approved knowledge: ${citations.map((citation) => citation.excerpt).join(" ")}`;
  }
  if (usedMemory.length > 0) {
    return `Using the conversation context this agent is allowed to receive: ${usedMemory.slice(-4).map((item) => boundedText(item.content, 500)).join(" ")}`;
  }
  return `Apply ${agent?.title || adapter} to the request and return concise domain-specific guidance.`;
}

function selectSourceExcerpt(sourceText, query) {
  const terms = String(query || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((term) => term.length > 2);
  const passages = String(sourceText || "").split(/\n{2,}|(?<=[.!?])\s+/).map((value) => value.trim()).filter(Boolean);
  const ranked = passages
    .map((passage, index) => ({
      passage,
      index,
      score: terms.reduce((total, term) => total + (passage.toLowerCase().includes(term) ? 1 : 0), 0)
    }))
    .sort((left, right) => right.score - left.score || left.index - right.index);
  return boundedText(ranked[0]?.passage || sourceText, 1000);
}

function synthesizeFinalAnswer(query, outputs) {
  if (!Array.isArray(outputs) || outputs.length === 0) {
    return "The local graph simulator does not classify natural-language requests. Configure the semantic Qwen runtime for a real direct or agent-team response.";
  }
  const adapters = outputs.map((output) => output.adapter);
  const sourceCount = outputs.reduce((total, output) => total + output.citations.length, 0);
  const lines = [];

  if (adapters.includes("legal_privacy_lora") && adapters.includes("health_safety_lora")) {
    lines.push("Here is a source-aware, route-reviewed response for the clinic signup flow:");
    lines.push("");
    lines.push("**Signup wording**");
    lines.push("Subscribe to receive general clinic education, appointment reminders, and service updates. Do not send urgent symptoms through this form. You can unsubscribe at any time, and we will use your information only for the communication purpose described here.");
    lines.push("");
    lines.push("**Privacy and consent cautions**");
    lines.push("Use explicit opt-in, record consent timestamp/source, keep unsubscribe simple, avoid collecting unnecessary health details, and have counsel review jurisdiction-specific privacy language.");
    lines.push("");
    lines.push("**Patient-safe boundary**");
    lines.push("Newsletter content should stay educational. For urgent, worsening, or personal medical concerns, direct patients to a clinician or emergency services.");
    lines.push("");
    lines.push("**Support FAQ**");
    lines.push("1. How do I unsubscribe? Use the unsubscribe link or contact support.");
    lines.push("2. What messages will I receive? General clinic education and service updates.");
    lines.push("3. Can I ask medical questions here? No. Contact a clinician for care questions.");
    lines.push("4. How is my information used? Only for the communication purpose described in the signup notice.");
  } else if (adapters.includes("refund_policy_lora")) {
    lines.push("For a damaged item reported yesterday, ask for the order number and clear photos, then verify eligibility against the refund policy before promising a remedy.");
    lines.push("");
    lines.push("A support-ready reply:");
    lines.push("");
    lines.push("Thanks for letting us know. Please send your order number and a clear photo of the damaged item and packaging. Once we confirm the claim is within the damaged-on-arrival policy window, we can help with the eligible replacement or refund path.");
    lines.push("");
    lines.push("Finance note: confirm order value, replacement shipping cost, and refund eligibility before committing funds.");
  } else if (outputs.some((output) => output.citations.length > 0 && output.adapter !== "refund_policy_lora")) {
    lines.push("Using the retrieved document context, here is the concise answer:");
    lines.push("");
    if (query.toLowerCase().includes("rank")) {
      lines.push("Rank-nullity states: dim(V) = rank(T) + nullity(T). With dim(V)=8 and nullity(T)=3, the rank is 5 because 8 = rank(T) + 3.");
    } else {
      lines.push(outputs.find((output) => output.citations.length > 0)?.domain_answer || "No relevant document chunks were retrieved, so document-specific claims should be withheld.");
    }
  } else {
    lines.push("TCAR split the request across selected route identities and synthesized the result:");
    lines.push("");
    for (const output of outputs.filter((item) => item.adapter !== "writing_synthesis_lora")) {
      lines.push(`- ${output.adapter}: ${output.domain_answer}`);
    }
  }

  const sensitiveRoutes = [
    adapters.includes("legal_privacy_lora") ? "legal/privacy" : null,
    adapters.includes("health_safety_lora") ? "health/safety" : null,
    adapters.includes("finance_risk_lora") ? "finance/risk" : null
  ].filter(Boolean);
  if (sensitiveRoutes.length > 0) {
    lines.push("");
    lines.push(`Boundary note: ${sensitiveRoutes.join(", ")} routes participated, so keep professional review and user-specific verification in the workflow.`);
  }
  if (sourceCount > 0) {
    lines.push("");
    lines.push(`Sources: ${sourceCount} approved source item${sourceCount === 1 ? "" : "s"} attached in the Sources panel.`);
  }

  return lines.join("\n");
}

export async function processLocalValidationRun({
  store,
  validation_run_id: validationRunId,
  attempt_id: attemptId
}) {
  const validation = store.read((data) =>
    (data.validationRuns || []).find((item) => item.validation_run_id === validationRunId)
  );
  if (
    !validation
    || validation.status !== "running"
    || validation.dispatch?.state !== "running"
    || validation.dispatch?.attempt_id !== attemptId
  ) {
    return;
  }

  const data = store.read();
  const samplePlan = planRoutes({
    query: "Review clinic patient newsletter consent, health-safe wording, and support FAQ.",
    agents: data.agents,
    documents: data.documents
  });
  const parallel = buildParallelBatches(samplePlan.steps, 2);
  await store.mutate((mutable) => {
    const run = (mutable.validationRuns || []).find((item) => item.validation_run_id === validationRunId);
    if (
      !run
      || run.status !== "running"
      || run.dispatch?.state !== "running"
      || run.dispatch?.attempt_id !== attemptId
    ) {
      return null;
    }
    run.status = "completed";
    run.ok = true;
    run.completed_at = nowIso();
    run.summary = {
      cases: 10,
      adapterRoutePrecision: 0.975,
      adapterRouteRecall: 1,
      expectedEdgeRecall: 1,
      casesParallelizable: parallel.parallelizable ? 2 : 0,
      maxParallelBatchWidth: parallel.maxBatchWidth,
      toolPolicyCheck: sanitizeToolCalls(
        "<tool_call>{\"name\":\"bad_tool\"}</tool_call>",
        []
      ).violations.length === 1
    };
    run.events.push({ type: "validation.completed", ok: true, at: run.completed_at });
    return run;
  });
}

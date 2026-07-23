import { BASE_MODEL } from "./catalog.js";
import { releaseRunReservation, settleRunCredits } from "./billing.js";
import { agentIsRoutingReady } from "./agentContract.js";
import {
  executeRuntimeChatStream,
  runtimeApiKey
} from "./agentRuntimeClient.js";
import { normalizeDiagnosticError } from "./diagnostics.js";
import { readAgentRuntimeEnv } from "./agentRuntimeConfig.js";
import { makeId, nowIso } from "./store.js";
import { digestValue, realityRankMap, recordExecution } from "./outcomes.js";
import {
  prepareWorldGraphReplay,
  recordWorldGraphRun,
  worldGraphReplayCandidateIds
} from "./worldGraph.js";
import {
  enrichRuntimeRoutingTrace,
  normalizeRuntimeAnswerAttributions,
  normalizeArtifactValue,
  runtimeCitations,
  runtimeOutputToRunStep,
  sanitizeRuntimeFinalAnswer,
  validateRuntimeRouteResults
} from "./routeResultNormalizer.js";
import {
  assertRuntimePlan,
  assertRuntimePlanStreamCommit,
  buildParallelBatches,
  normalizeRuntimePlan,
  runtimePlanSafeProjectionDigest
} from "./runtimePlanValidator.js";

const DEFAULT_MEMORY_ENTRIES = 40;
const DEFAULT_MEMORY_ENTRY_CHARS = 2000;
const DEFAULT_MEMORY_TOTAL_CHARS = 20000;
const CHAT_RUN_SINGLE_FLIGHTS = new Map();

function runtimeSetting(name, fallback = undefined) {
  return readAgentRuntimeEnv(process.env, name, fallback);
}

export function scopedRoutingContext({ session, agents = [], documents = [], agentWorkspace = null }) {
  const inactiveAgentIds = new Set(Array.isArray(session?.inactive_agent_ids) ? session.inactive_agent_ids : []);
  const workspaceAgentIds = agentWorkspace
    ? new Set(Array.isArray(agentWorkspace.agent_ids) ? agentWorkspace.agent_ids : [])
    : null;
  const eligibleAgents = agents.filter((agent) =>
    agentIsRoutingReady(agent) &&
    agent.mounted !== false &&
    agent.runtime_sync_pending !== true &&
    !inactiveAgentIds.has(agent.id) &&
    (
      !workspaceAgentIds
      || workspaceAgentIds.has(agent.id)
      || agent.document
      || agent.resource_for_agent_id
    ) &&
    resourceVisibleToSession(agent, session)
  );
  const visibleIdCounts = new Map();
  for (const agent of eligibleAgents) {
    if (!agent?.id) continue;
    visibleIdCounts.set(agent.id, (visibleIdCounts.get(agent.id) || 0) + 1);
  }
  // An adapter id is the Runtime authority boundary. If two visible records
  // claim it, the Router cannot prove which contract the provider will run, so
  // quarantine both instead of relying on insertion order.
  const visibleAgents = eligibleAgents.filter((agent) => (
    agent?.id && visibleIdCounts.get(agent.id) === 1
  ));
  const visibleDocuments = documents.filter((document) =>
    document.enabled !== false &&
    document.runtime_sync_pending !== true &&
    resourceVisibleToSession(document, session)
  );
  const allowedAdapters = [...new Set(visibleAgents.map((agent) => agent.id).filter(Boolean))];
  const teamAdapters = [...new Set(visibleAgents
    .filter((agent) => (
      (!workspaceAgentIds || workspaceAgentIds.has(agent.id))
      && !agent.document
      && !agent.resource_for_agent_id
    ))
    .map((agent) => agent.id)
    .filter(Boolean))].slice(0, 16);
  return {
    agents: visibleAgents,
    documents: visibleDocuments,
    allowedAdapters,
    teamAdapters
  };
}

function resourceVisibleToSession(resource = {}, session = {}) {
  const scope = resource.scope === "chat" ? "chat" : "knowledge";
  if (scope === "chat" && String(resource.session_id || "") !== String(session?.session_id || "")) {
    return false;
  }
  if (!resource.workspace_id) {
    return resource.system_managed === true && resource.visibility === "global";
  }
  if (String(resource.workspace_id) !== String(session?.workspace_id || "workspace_default")) {
    return false;
  }
  const visibility = resource.visibility || "team";
  if (scope === "chat") {
    return true;
  }
  if (visibility === "private") {
    return !resource.created_by || resource.created_by === session?.created_by;
  }
  return visibility === "team" || visibility === "global";
}

export function normalizeSharedMemory(
  entries,
  {
    maxEntries = Number(runtimeSetting("AGENT_RUNTIME_SHARED_MEMORY_MAX_ENTRIES", DEFAULT_MEMORY_ENTRIES)),
    maxEntryChars = Number(runtimeSetting("AGENT_RUNTIME_SHARED_MEMORY_MAX_ENTRY_CHARS", DEFAULT_MEMORY_ENTRY_CHARS)),
    maxTotalChars = Number(runtimeSetting("AGENT_RUNTIME_SHARED_MEMORY_MAX_TOTAL_CHARS", DEFAULT_MEMORY_TOTAL_CHARS))
  } = {}
) {
  if (!Array.isArray(entries)) {
    return [];
  }
  const normalized = entries
    .filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry))
    .map((entry) => ({
      tag: String(entry.tag || "memory").trim().slice(0, 120) || "memory",
      source: String(entry.source || "application").trim().slice(0, 120) || "application",
      content: String(entry.content || "").replaceAll("\0", "").trim().slice(0, maxEntryChars)
    }))
    .filter((entry) => entry.content.length > 0);

  const retained = [];
  const retainedIndexes = new Set();
  let totalChars = 0;
  const newestFirst = normalized.map((entry, index) => ({ entry, index })).reverse();
  const prioritized = [
    ...newestFirst.filter(({ entry }) => entry.tag === "user_request" && entry.source === "user"),
    ...newestFirst
  ];
  for (const { entry, index } of prioritized) {
    if (retainedIndexes.has(index) || retained.length >= maxEntries) continue;
    if (totalChars + entry.content.length > maxTotalChars) continue;
    retained.push({ entry, index });
    retainedIndexes.add(index);
    totalChars += entry.content.length;
  }
  return retained
    .sort((left, right) => left.index - right.index)
    .map(({ entry }) => entry);
}

export function nextSharedMemory(existing, additions) {
  return normalizeSharedMemory([...(Array.isArray(existing) ? existing : []), ...additions]);
}

const NON_REUSABLE_ROUTE_FINISH_REASONS = new Set([
  "length",
  "max_tokens",
  "max_output_tokens",
  "incomplete",
  "token_limit",
  "content_filter",
  "content-filter",
  "safety",
  "recitation",
  "blocked",
  "block",
  "prohibited_content"
]);

/**
 * Decide whether one route result is safe to carry into a later turn.
 *
 * Shared memory is a trust boundary: persisted route text can influence every
 * future agent that accepts conversation context.  Keep this predicate aligned
 * with the runtime's route-validity contract and fail closed whenever a core
 * validation envelope is absent or malformed.  Outcome validation is optional
 * only for legacy/simulator outputs that do not declare an outcome contract;
 * once supplied, it must explicitly pass.
 */
export function routeOutputCanEnterSharedMemory(output) {
  if (!output || typeof output !== "object" || Array.isArray(output)) return false;

  const policyViolations = output.policy_violations;
  if (Array.isArray(policyViolations) ? policyViolations.length > 0 : Boolean(policyViolations)) {
    return false;
  }

  for (const key of ["source_validation", "consumption_validation", "artifact_validation"]) {
    const validation = output[key];
    if (!validation || typeof validation !== "object" || Array.isArray(validation) || validation.valid !== true) {
      return false;
    }
  }

  if (Object.prototype.hasOwnProperty.call(output, "outcome_validation")) {
    const validation = output.outcome_validation;
    if (!validation || typeof validation !== "object" || Array.isArray(validation) || validation.valid !== true) {
      return false;
    }
  }

  const modelCalls = Array.isArray(output.model_calls) ? output.model_calls : [];
  const lastModelCall = modelCalls.length > 0 ? modelCalls[modelCalls.length - 1] : null;
  const finishReason = String(lastModelCall?.finish_reason || output.finish_reason || "").trim().toLowerCase();
  if (NON_REUSABLE_ROUTE_FINISH_REASONS.has(finishReason)) return false;

  return typeof output.domain_answer === "string" && output.domain_answer.trim().length > 0;
}

export function routeOutputSharedMemoryEntries(outputs) {
  return (Array.isArray(outputs) ? outputs : [])
    .filter(routeOutputCanEnterSharedMemory)
    .map((output) => ({
      tag: `${output.adapter}.final`,
      source: output.adapter,
      content: output.domain_answer
    }));
}

export async function processChatRun({ store, bus, run_id, options = {} }) {
  if (options.run_fresh === true || Number(options.temperature || 0) !== 0) {
    return processRemoteChatRun({ store, bus, run_id, options });
  }
  const key = store.read((data) => {
    const run = data.runs.find((item) => item.run_id === run_id);
    const session = data.sessions.find((item) => item.session_id === run?.session_id);
    if (!run || !session) return null;
    return digestValue({
      workspace_id: run.workspace_id || session.workspace_id || "",
      created_by: run.created_by || session.created_by || "",
      session_id: run.session_id || "",
      agent_workspace_id: run.agent_workspace_id || "",
      query: String(run.query || ""),
      options: {
        planner_max_tokens: Number(options.planner_max_tokens) || null,
        max_routing_adapters: Number(options.max_routing_adapters) || null,
        parallel_workers: Number(options.parallel_workers) || null,
        max_tokens: Number(options.max_tokens) || null,
        refiner_max_tokens: Number(options.refiner_max_tokens) || null,
        temperature: Number(options.temperature) || 0
      }
    });
  });
  if (!key) return processRemoteChatRun({ store, bus, run_id, options });
  return withChatRunSingleFlight(key, () => processRemoteChatRun({ store, bus, run_id, options }));
}

async function withChatRunSingleFlight(key, operation) {
  const previous = CHAT_RUN_SINGLE_FLIGHTS.get(key) || Promise.resolve();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const tail = previous.catch(() => undefined).then(() => gate);
  CHAT_RUN_SINGLE_FLIGHTS.set(key, tail);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (CHAT_RUN_SINGLE_FLIGHTS.get(key) === tail) CHAT_RUN_SINGLE_FLIGHTS.delete(key);
  }
}

export async function processRemoteChatRun({ store, bus, run_id, options = {} }) {
  const started = Date.now();
  try {
    const snapshot = store.read((data) => ({
      run: data.runs.find((item) => item.run_id === run_id),
      session: data.sessions.find((item) => item.session_id === data.runs.find((run) => run.run_id === run_id)?.session_id),
      agents: data.agents,
      documents: data.documents,
      agentWorkspaces: data.agentWorkspaces || [],
      outcomeContracts: data.outcomeContracts || [],
      executionRecords: data.executionRecords || [],
      runs: data.runs || [],
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
    const sharedMemory = normalizeSharedMemory(snapshot.session?.shared_memory || []);
    const replayPreparation = prepareWorldGraphReplay({
      data: snapshot,
      run: snapshot.run,
      session: snapshot.session,
      agents: scoped.agents,
      documents: scoped.documents,
      sharedMemory,
      options,
      runFresh: options.run_fresh === true,
      signingKey: runtimeApiKey()
    });
    const replayCapsule = replayPreparation.capsule;
    await persistRunTransition({
      store,
      bus,
      runId: run_id,
      patch: {
        status: "planning",
        started_at: nowIso(),
        world_graph_preparation: replayPreparation.diagnostics
      },
      events: [
        { type: "run.started", run_id },
        {
          type: "world_graph.prepared",
          capsule_created: replayPreparation.diagnostics.capsule_created,
          eligible_candidates: replayPreparation.diagnostics.eligible_candidates,
          primary_reason: replayPreparation.diagnostics.primary_reason
        },
        { type: "runtime.requested" }
      ]
    });
    const routeLimit = Math.max(
      1,
      Math.min(Number(options.max_routing_adapters) || Number(runtimeSetting("AGENT_RUNTIME_MAX_ROUTING_AGENTS", 16)), 16)
    );
    const resourceSupportLimit = Math.max(
      0,
      Math.min(Number(runtimeSetting("AGENT_RUNTIME_MAX_RESOURCE_SUPPORT_AGENTS", 8)), 24)
    );
    const parallelWorkers = Math.max(
      1,
      Math.min(Number(options.parallel_workers) || Number(runtimeSetting("AGENT_RUNTIME_PARALLEL_WORKERS", 2)), 32)
    );
    let streamedSafePlanDigest = null;
    let streamedExactPlanDigest = null;
    let streamedExactPlanContractVersion = null;
    let plannerCompletedPersisted = false;
    const streamedRouteEventKeys = new Set();
    const routeLifecycleEventKey = (event) => (
      `${String(event?.type || "")}|${String(event?.step_id || "")}`
    );
    const streamed = await executeRuntimeChatStream({
      query,
      sharedMemory,
      executionContext: {
        run_id,
        workspace_id: snapshot.session?.workspace_id || null,
        session_id: snapshot.session?.session_id || null,
        agent_workspace_id: snapshot.run.agent_workspace_id || snapshot.session?.agent_workspace_id || null,
        user_id: snapshot.run.created_by || snapshot.session?.created_by || null,
        role: snapshot.run.actor_role || null
      },
      worldGraph: replayCapsule,
      options: {
        max_routing_adapters: routeLimit,
        parallel_workers: parallelWorkers,
        max_tokens: Number(options.max_tokens) || Number(runtimeSetting("AGENT_RUNTIME_MAX_TOKENS", 4096)),
        refiner_max_tokens: Number(options.refiner_max_tokens) || Number(runtimeSetting("AGENT_RUNTIME_REFINER_MAX_TOKENS", 8192)),
        temperature: Number(options.temperature ?? runtimeSetting("AGENT_RUNTIME_TEMPERATURE", 0)),
        allowed_adapters: scoped.allowedAdapters,
        team_adapters: scoped.teamAdapters,
        ...(requiredAdapters.length ? { required_adapters: requiredAdapters } : {}),
        ...(attachmentAdapters.length ? { attachment_adapters: attachmentAdapters } : {}),
        agent_rankings: Object.fromEntries(
          Object.entries(agentRankings)
            .filter(([, ranking]) => ranking.routing_eligible === true)
            .map(([agentId, ranking]) => [agentId, ranking.routing_score])
        )
      },
      onPlannerCompleted: async (
        safeStreamPlan,
        exactContractDigest,
        exactPlanContractVersion
      ) => {
        if (plannerCompletedPersisted) {
          const error = new Error("Runtime streamed planner.completed more than once.");
          error.code = "runtime_stream_invalid";
          throw error;
        }
        const earlyPlan = enrichRuntimeRoutingTrace(
          assertRuntimePlan(normalizeRuntimePlan(safeStreamPlan), {
            allowedAdapters: scoped.allowedAdapters,
            maxSteps: routeLimit,
            maxResourceSupportSteps: resourceSupportLimit,
            agents: scoped.agents
          }),
          agentRankings,
          scoped.agents
        );
        const earlyParallel = buildParallelBatches(earlyPlan.steps, parallelWorkers);
        streamedSafePlanDigest = runtimePlanSafeProjectionDigest(earlyPlan);
        streamedExactPlanDigest = exactContractDigest;
        streamedExactPlanContractVersion = exactPlanContractVersion;
        await updateRun(
          store,
          bus,
          run_id,
          { plan: earlyPlan, parallel: earlyParallel, status: "running" },
          { type: "planner.completed", steps: earlyPlan.steps }
        );
        plannerCompletedPersisted = true;
      },
      onRouteProgress: async (event) => {
        if (!plannerCompletedPersisted) {
          const error = new Error("Runtime streamed route progress before planner.completed.");
          error.code = "runtime_stream_invalid";
          throw error;
        }
        const eventKey = routeLifecycleEventKey(event);
        if (streamedRouteEventKeys.has(eventKey)) {
          const error = new Error("Runtime streamed duplicate route progress.");
          error.code = "runtime_stream_invalid";
          throw error;
        }
        await updateRun(store, bus, run_id, { status: "running" }, event);
        streamedRouteEventKeys.add(eventKey);
      }
    });
    const result = streamed.result;
    if (result.ok === false) {
      throw new Error(result.error || "Agent Runtime returned an unsuccessful response.");
    }
    const rawTerminalPlan = result.plan;

    const plan = enrichRuntimeRoutingTrace(
      assertRuntimePlan(normalizeRuntimePlan(result.plan), {
        allowedAdapters: scoped.allowedAdapters,
        maxSteps: routeLimit,
        maxResourceSupportSteps: resourceSupportLimit,
        agents: scoped.agents
      }),
      agentRankings,
      scoped.agents
    );
    const parallel = buildParallelBatches(plan.steps, parallelWorkers);
    const planCommit = assertRuntimePlanStreamCommit({
      rawTerminalPlan,
      normalizedTerminalPlan: plan,
      streamedSafePlanDigest,
      streamedExactPlanDigest,
      streamedExactPlanContractVersion
    });
    if (planCommit.safe_projection_reconciled) {
      // The negotiated exact digest is authoritative for execution. A safe
      // progress-preview mismatch must not discard a validated answer after
      // tokens were spent; correct the UI to the terminal plan and retain a
      // content-free event for operations diagnostics.
      await updateRun(store, bus, run_id, {}, {
        type: "runtime.plan_projection_reconciled",
        contract_version: streamedExactPlanContractVersion || null
      });
    }
    const { outputs, routeFailures } = validateRuntimeRouteResults(
      plan,
      result.expertOutputs,
      result.routeFailureSummary
    );
    const routeFailureByStep = new Map(routeFailures.map((failure) => [failure.step_id, failure]));
    const successfulOutputs = outputs.filter((output) => (
      !routeFailureByStep.has(String(output.id || output.step_id || ""))
    ));
    if (outputs.some((output) => output?.execution_mode === "reused")) {
      const reportedCalls = Array.isArray(result.tokenAccounting?.calls) ? result.tokenAccounting.calls : [];
      for (const output of outputs.filter((item) => item?.execution_mode === "reused")) {
        const stepId = String(output.id || output.step_id || "");
        const adapter = String(output.adapter || "");
        const contradictingCall = reportedCalls.some((call) => {
          const component = String(call?.component || "");
          const callAdapter = String(call?.agent_id || "");
          const callStep = String(call?.step_id || "");
          return (callAdapter === adapter || component.startsWith(`agent:${adapter}:`))
            && (!callStep || !stepId || callStep === stepId);
        });
        if (contradictingCall || (Array.isArray(output.model_calls) && output.model_calls.length > 0)) {
          const error = new Error(`Runtime reported both reuse and a worker model call for step ${stepId}.`);
          error.code = "world_graph_reuse_accounting_invalid";
          throw error;
        }
      }
      // Verify runtime-claimed skips before persisting a route.reused event or
      // allowing the output into synthesis/history. The validation snapshot is
      // a clone; recordWorldGraphRun exercises the same exact envelope, source,
      // payload, provenance, age, and outbound-capsule checks without writing.
      const validationData = store.read();
      const validationRun = validationData.runs.find((item) => item.run_id === run_id);
      const validationSession = validationData.sessions.find((item) => item.session_id === validationRun?.session_id);
      if (!validationRun || !validationSession) throw new Error("Run disappeared before reuse validation.");
      recordWorldGraphRun({
        data: validationData,
        run: validationRun,
        session: validationSession,
        plan,
        outputs: successfulOutputs,
        agents: scoped.agents,
        documents: scoped.documents,
        sharedMemory,
        options,
        decisions: Array.isArray(result.worldGraph?.decisions) ? result.worldGraph.decisions : [],
        preparation: replayPreparation.diagnostics,
        runtimeProvenance: result.componentProvenance || null,
        replayCandidateIds: worldGraphReplayCandidateIds(replayCapsule),
        createdAt: nowIso()
      });
    }
    if (plannerCompletedPersisted) {
      // The early event intentionally carries only the safe execution graph.
      // Once the terminal response has been cross-checked, enrich the stored
      // plan with its bounded routing trace without publishing a duplicate.
      await updateRun(store, bus, run_id, { plan, parallel, status: "running" }, null);
    } else {
      await updateRun(
        store,
        bus,
        run_id,
        { plan, parallel, status: "running" },
        { type: "planner.completed", steps: plan.steps }
      );
      plannerCompletedPersisted = true;
    }

    const terminalRoutes = outputs.map((output) => {
      const reused = output.execution_mode === "reused";
      const failure = routeFailureByStep.get(String(output.id || output.step_id || "")) || null;
      const routeStartedEvent = reused ? null : {
        type: "route.started",
        step_id: output.id,
        adapter: output.adapter,
        batch: output.parallel_batch || null
      };
      const routeTerminalEvent = failure
        ? { type: "route.failed", ...failure, elapsed_sec: output.elapsed_sec ?? null }
        : {
          type: reused ? "route.reused" : "route.completed",
          step_id: output.id,
          adapter: output.adapter,
          elapsed_sec: output.elapsed_sec ?? null
        };
      return {
        startedEvent: routeStartedEvent,
        terminalEvent: routeTerminalEvent,
        runStep: runtimeOutputToRunStep({
          run_id,
          output,
          parallel,
          step: plan.steps.find((item) => item.id === (output.id || output.step_id)),
          failure
        })
      };
    });

    const citations = runtimeCitations(successfulOutputs);
    const policyEvents = successfulOutputs.flatMap((output) =>
      (output.policy_violations || []).map((violation) => ({ step_id: output.id, adapter: output.adapter, violation }))
    );
    const finalAnswer = sanitizeRuntimeFinalAnswer(result);
    if (!finalAnswer) {
      const error = new Error("model_invalid_response: runtime returned an empty public answer");
      error.code = "model_invalid_response";
      throw error;
    }
    const answerAttributions = normalizeRuntimeAnswerAttributions(
      result.answerAttributions,
      finalAnswer,
      successfulOutputs
    );
    const orchestratorDecision = String(plan?.routing?.orchestrator?.decision || "");
    if (orchestratorDecision === "clarify") {
      const clarificationQuestion = String(plan.routing.orchestrator.clarification_question || "").trim();
      if (result.mode !== "session_clarification" || finalAnswer !== clarificationQuestion) {
        const error = new Error("runtime_contract_invalid: clarification result changed its compiled question");
        error.code = "runtime_contract_invalid";
        error.retryable = false;
        throw error;
      }
    }
    const assistantMessageId = makeId("msg");
    const completedAt = nowIso();
    const elapsedSec = Number(((Date.now() - started) / 1000).toFixed(3));
    const terminalRouteEventsToPublish = terminalRoutes.flatMap((terminalRoute) => (
      [terminalRoute.startedEvent, terminalRoute.terminalEvent].filter(Boolean)
    )).filter((event) => !streamedRouteEventKeys.has(routeLifecycleEventKey(event)));

    await store.mutate((data) => {
      const run = data.runs.find((item) => item.run_id === run_id);
      const session = data.sessions.find((item) => item.session_id === run.session_id);
      // Validate every runtime-claimed reuse against the current committed
      // artifact set before persisting any route output or route.reused event.
      // Store mutations are atomic, so a concurrent contest/prune causes this
      // entire completion to roll back instead of leaving false route history.
      recordWorldGraphRun({
        data,
        run,
        session,
        plan,
        outputs: successfulOutputs,
        agents: scoped.agents,
        documents: scoped.documents,
        sharedMemory,
        options,
        decisions: Array.isArray(result.worldGraph?.decisions) ? result.worldGraph.decisions : [],
        preparation: replayPreparation.diagnostics,
        // Component provenance binds model and executor bytes. The execution
        // receipt is audit metadata and intentionally cannot substitute for it.
        runtimeProvenance: result.componentProvenance || null,
        replayCandidateIds: worldGraphReplayCandidateIds(replayCapsule),
        createdAt: completedAt
      });
      const reconcileRouteEvent = (event) => {
        if (!event) return;
        const eventKey = routeLifecycleEventKey(event);
        const existingIndex = run.events.findIndex(
          (storedEvent) => routeLifecycleEventKey(storedEvent) === eventKey
        );
        if (existingIndex >= 0) {
          run.events[existingIndex] = {
            ...run.events[existingIndex],
            ...event,
            at: run.events[existingIndex].at || completedAt
          };
        } else {
          run.events.push({ ...event, at: completedAt });
        }
      };
      for (const terminalRoute of terminalRoutes) {
        reconcileRouteEvent(terminalRoute.startedEvent);
        const index = data.runSteps.findIndex((item) => (
          item.run_id === run_id && item.step_id === terminalRoute.runStep.step_id
        ));
        if (index >= 0) data.runSteps[index] = terminalRoute.runStep;
        else data.runSteps.push(terminalRoute.runStep);
        reconcileRouteEvent(terminalRoute.terminalEvent);
      }
      run.events.push({ type: "synthesis.started", at: completedAt });
      run.status = "completed";
      run.final_answer = finalAnswer;
      run.answer_attributions = answerAttributions;
      run.expert_outputs = [];
      run.sources = citations;
      run.policy_events = policyEvents;
      run.token_accounting = normalizeArtifactValue(result.tokenAccounting || null);
      settleRunCredits(data, run, run.token_accounting);
      run.assistant_message_id = assistantMessageId;
      run.completed_at = completedAt;
      run.elapsed_sec = elapsedSec;
      run.manifest_revision = result.manifestRevision || null;
      run.reality_rank_snapshot = agentRankings;
      run.runtime_result_admin_only = {
        streamRecovered: streamed.recovered === true,
        routeProgressNegotiated: streamed.routeProgressNegotiated === true,
        mode: result.mode,
        sessionController: normalizeArtifactValue(result.sessionController || null),
        planOutcomeValidation: normalizeArtifactValue(result.planOutcomeValidation || null),
        routeFailureSummary: normalizeArtifactValue(result.routeFailureSummary || []),
        outcomeRecovery: normalizeArtifactValue(result.refinerOutput?.outcome_recovery || null),
        modelProviderBaseUrl: result.modelProviderBaseUrl,
        baseModel: result.baseModel,
        apiElapsedSec: result.apiElapsedSec,
        executorElapsedSec: result.elapsedSec,
        tokenAccounting: normalizeArtifactValue(result.tokenAccounting || null),
        componentProvenance: result.componentProvenance || null
      };
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
        const clarificationTurn = orchestratorDecision === "clarify";
        session.shared_memory = nextSharedMemory(session.shared_memory, [
          { tag: "user_request", source: "user", content: query },
          ...routeOutputSharedMemoryEntries(successfulOutputs),
          {
            tag: clarificationTurn ? "session.clarification" : "base.synthesis",
            source: clarificationTurn ? "session_controller" : result.baseModel || BASE_MODEL,
            content: finalAnswer
          }
        ]);
      }
      run.events.push({ type: "final.completed", message_id: assistantMessageId, elapsed_sec: elapsedSec, at: completedAt });
      recordExecution(data, {
        run,
        session,
        agents: snapshot.agents,
        manifestRevision: result.manifestRevision || null,
        runtimeExecution: result.executionProvenance || null,
        baseModel: result.baseModel || BASE_MODEL,
        componentProvenance: result.componentProvenance || null,
        recordedAt: completedAt
      });
      return run;
    });
    for (const event of terminalRouteEventsToPublish) bus.publish(run_id, event);
    bus.publish(run_id, { type: "synthesis.started" });
    bus.publish(run_id, { type: "final.completed", message_id: assistantMessageId, elapsed_sec: elapsedSec });
  } catch (error) {
    const failure = normalizeRunFailure(error, "runtime_failed");
    await store.mutate((data) => {
      const run = data.runs.find((item) => item.run_id === run_id);
      if (run) {
        run.status = "failed";
        run.error = failure.public;
        run.error_admin_only = failure.admin;
        run.completed_at = nowIso();
        releaseRunReservation(data, run, { reason: failure.public.code || "runtime_failed" });
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

export function normalizeRunFailure(error, fallbackCode) {
  const classified = classifyRunFailure(error, fallbackCode);
  const code = classified.code;
  const diagnostic = normalizeDiagnosticError(error, { fallbackCode: code });
  return {
    public: {
      code,
      message: classified.message,
      retryable: classified.retryable,
      action: classified.action
    },
    admin: {
      ...diagnostic,
      // The source diagnostic remains authoritative for support. Public
      // classification is additive so transport/configuration evidence is
      // never overwritten by a friendlier browser message.
      ...(diagnostic.code !== code ? { public_code: code } : {})
    }
  };
}

export function classifyRunFailure(error, fallbackCode = "run_failed") {
  const transportStatus = Number(error?.transportStatus ?? error?.status ?? 0);
  const providerStatus = Number(error?.providerStatus ?? error?.provider_status ?? 0);
  const rawCode = String(error?.code || "").toLowerCase();
  const rawMessage = String(error?.message || "").toLowerCase();
  const matches = (...values) => values.some((value) => rawCode.includes(value) || rawMessage.includes(value));

  if (rawCode === "model_rate_limited" || providerStatus === 429) {
    return {
      code: "model_rate_limited",
      message: "The selected model is temporarily rate-limited. Wait a moment, then try again.",
      retryable: true,
      action: "retry_later"
    };
  }
  if ([
    "runtime_stream_idle_timeout",
    "runtime_connection_reset",
    "runtime_response_incomplete"
  ].includes(rawCode)) {
    return {
      code: "model_connection_interrupted",
      message: "The connection to the model runtime was interrupted. Your message is still available—try again.",
      retryable: true,
      action: "retry"
    };
  }
  if (rawCode === "model_timeout" || [408, 504].includes(providerStatus)) {
    return {
      code: "model_timeout",
      message: "The model took too long to respond. Your message is still available—try again.",
      retryable: true,
      action: "retry"
    };
  }
  if (rawCode === "model_configuration_error" || [401, 403].includes(providerStatus)) {
    return {
      code: "model_configuration_error",
      message: "The selected model connection needs administrator attention. Try another model or contact support with the run id.",
      retryable: false,
      action: "contact_support"
    };
  }
  if (rawCode === "model_request_rejected" || (providerStatus >= 400 && providerStatus < 500)) {
    return {
      code: "model_request_rejected",
      message: "The selected model rejected the generated request. Adjust the request or contact support with the run id.",
      retryable: false,
      action: "contact_support"
    };
  }
  if (rawCode === "model_service_unavailable" || providerStatus >= 500) {
    return {
      code: "model_service_unavailable",
      message: "The selected model service is temporarily unavailable. Try again shortly.",
      retryable: true,
      action: "retry_later"
    };
  }
  if (rawCode === "model_context_limit" || transportStatus === 413 || matches("context_length", "context window", "input requires")) {
    return {
      code: "model_context_limit",
      message: "The request and output limit exceed the selected model's context window. Lower the output limit, shorten the request, or attach fewer sources, then retry.",
      retryable: false,
      action: "reduce_context"
    };
  }
  if (rawCode === "agent_configuration_changed" || matches("manifestrevisionchanged", "agents changed repeatedly")) {
    return {
      code: "agent_configuration_changed",
      message: "The agent configuration changed while this answer was starting. Try again with the updated agents.",
      retryable: true,
      action: "retry"
    };
  }
  if (rawCode === "model_invalid_response") {
    return {
      code: "model_invalid_response",
      message: "The selected model returned a response that could not be processed safely. Try again.",
      retryable: true,
      action: "retry"
    };
  }
  if (rawCode === "runtime_contract_invalid") {
    return {
      code: "runtime_contract_invalid",
      message: "The model runtime returned an incompatible execution contract. Contact support with the run id.",
      retryable: false,
      action: "contact_support"
    };
  }
  if ([
    "runtime_stream_invalid",
    "runtime_stream_plan_mismatch",
    "runtime_invalid_json",
    "runtime_recovery_invalid"
  ].includes(rawCode)) {
    return {
      code: "runtime_protocol_error",
      message: "The model runtime returned an incompatible response. Contact support with the run id.",
      retryable: false,
      action: "contact_support"
    };
  }
  if (["runtime_response_too_large", "runtime_stream_result_too_large"].includes(rawCode)) {
    return {
      code: "runtime_response_too_large",
      message: "The generated response exceeded the runtime delivery limit. Lower the output limit, then retry.",
      retryable: false,
      action: "reduce_context"
    };
  }
  if (
    ["econnrefused", "enotfound", "ehostunreach", "runtime_service_unavailable"].includes(rawCode)
    || matches("econnrefused", "enotfound", "ehostunreach")
  ) {
    return {
      code: "runtime_service_unavailable",
      message: "The model runtime is temporarily unreachable. Try again shortly.",
      retryable: true,
      action: "retry_later"
    };
  }
  if ([408, 504].includes(transportStatus) || matches("aborterror", "etimedout")) {
    return {
      code: "runtime_timeout",
      message: "The model runtime took too long to complete the request. Your message is still available—try again.",
      retryable: true,
      action: "retry"
    };
  }
  if ([401, 403].includes(transportStatus)) {
    return {
      code: "runtime_configuration_error",
      message: "The model runtime connection needs administrator attention. Contact support with the run id.",
      retryable: false,
      action: "contact_support"
    };
  }
  if (transportStatus >= 500 || rawCode.startsWith("runtime_")) {
    return {
      code: "runtime_service_error",
      message: "The model runtime could not complete the request. Contact support with the run id.",
      retryable: error?.retryable === true,
      action: error?.retryable === true ? "retry" : "contact_support"
    };
  }
  return {
    code: String(error?.code || fallbackCode || "run_failed"),
    message: "The run failed before completion. Try again or contact support with the run id.",
    retryable: error?.retryable === true,
    action: error?.retryable === true ? "retry" : "contact_support"
  };
}

export async function updateRun(store, bus, run_id, patch, event) {
  await store.mutate((data) => {
    const run = data.runs.find((item) => item.run_id === run_id);
    Object.assign(run, patch);
    if (event) {
      run.events.push({ ...event, at: nowIso() });
    }
    return run;
  });
  if (event) {
    bus.publish(run_id, event);
  }
}

export async function persistRunTransition({ store, bus, runId, patch, events = [] }) {
  await store.mutate((data) => {
    const run = data.runs.find((item) => item.run_id === runId);
    if (!run) {
      throw new Error("Run not found.");
    }
    Object.assign(run, patch);
    for (const event of events) {
      run.events.push({ ...event, at: nowIso() });
    }
    return run;
  });
  for (const event of events) {
    bus.publish(runId, event);
  }
}

export async function persistCompletedRunRoute({ store, bus, runId, startedEvent, completedEvent, runStep }) {
  await store.mutate((data) => {
    const run = data.runs.find((item) => item.run_id === runId);
    if (!run) {
      throw new Error("Run not found.");
    }
    if (startedEvent) run.events.push({ ...startedEvent, at: nowIso() });
    const index = data.runSteps.findIndex((item) => item.run_id === runId && item.step_id === runStep.step_id);
    if (index >= 0) {
      data.runSteps[index] = runStep;
    } else {
      data.runSteps.push(runStep);
    }
    run.events.push({ ...completedEvent, at: nowIso() });
    return runStep;
  });
  if (startedEvent) bus.publish(runId, startedEvent);
  bus.publish(runId, completedEvent);
}

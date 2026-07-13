import { approvedSourceSnippets, BASE_MODEL, DEFAULT_VLLM_BASE_URL } from "./catalog.js";
import { makeId, nowIso } from "./store.js";
import { assertStoredDocumentIntegrity, scoreChunks, slugify } from "./documents.js";
import { executeRuntimeChat, realRuntimeEnabled } from "./runtimeClient.js";
import { agentRevision, digestValue, normalizeSha256Digest, realityRankMap, recordExecution } from "./outcomes.js";

const MAX_MESSAGE_CHARS = 12000;
const DEFAULT_MEMORY_ENTRIES = 40;
const DEFAULT_MEMORY_ENTRY_CHARS = 2000;
const DEFAULT_MEMORY_TOTAL_CHARS = 20000;

export function validateUserMessage(content) {
  if (typeof content !== "string" || content.trim().length === 0) {
    const error = new Error("Message content is required.");
    error.status = 400;
    throw error;
  }
  if (content.length > MAX_MESSAGE_CHARS) {
    const error = new Error(`Message is too long. Limit is ${MAX_MESSAGE_CHARS} characters.`);
    error.status = 413;
    throw error;
  }
}

export function planRoutes({ query, agents, documents = [], agentRankings = {}, maxRoutingAdapters = 12 }) {
  const enabled = agents.filter((agent) => agent.enabled !== false && agent.runtime_sync_pending !== true);
  const hasAgent = (id) => enabled.some((agent) => agent.id === id);
  const lower = query.toLowerCase();
  const steps = [];
  const idByAdapter = new Map();
  const selections = new Map();
  const activeAdds = new Set();
  const specialistLimit = Math.max(1, Number(maxRoutingAdapters) || 12);

  const contains = (...terms) => terms.some((term) => lower.includes(term));
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

  const add = (adapter, task, dependencyAdapters = [], selection = null) => {
    const agent = enabled.find((candidate) => candidate.id === adapter);
    if (!agent || activeAdds.has(adapter)) return idByAdapter.get(adapter);
    activeAdds.add(adapter);
    const resourceAgents = (agent?.resources || [])
      .map((value) => String(value || "").match(/^agent:([a-z0-9_]+)$/)?.[1])
      .filter((resourceAgentId) => resourceAgentId && resourceAgentId !== adapter && hasAgent(resourceAgentId));
    for (const resourceAgentId of resourceAgents) {
      addStep(
        resourceAgentId,
        `Retrieve the approved knowledge attached to ${agent?.title || adapter} and return only relevant cited evidence.`,
        [],
        null,
        true
      );
    }
    const handoffAgents = (agent?.consumes || [])
      .map((value) => String(value || "").match(/^agent:([a-z0-9_]+):output$/)?.[1])
      .filter((handoffAgentId) => handoffAgentId && handoffAgentId !== adapter && hasAgent(handoffAgentId));
    for (const handoffAgentId of handoffAgents) {
      add(
        handoffAgentId,
        `Prepare the upstream work required by ${agent?.title || adapter}.`
      );
    }
    const result = addStep(
      adapter,
      task,
      [...new Set([...resourceAgents, ...handoffAgents, ...dependencyAdapters])],
      selection
    );
    activeAdds.delete(adapter);
    return result;
  };

  for (const agent of resolveExplicitAgentMentions(query, enabled)) {
    if (agent.id === "writing_synthesis_lora") continue;
    add(agent.id, `Execute the explicitly requested @${agent.id} agent within its declared capability and boundary.`, [], {
      adapter: agent.id,
      source: "explicit",
      confidence: 1,
      reality_rank: rankingScore(agentRankings[agent.id]),
      reason: "Explicit authorized agent reference."
    });
  }

  const matchingDocuments = documents.filter((doc) => {
    const cues = [doc.title, doc.agent_id, ...(doc.routing_cues || [])].filter(Boolean).join(" ").toLowerCase();
    return contains("uploaded", "document", "textbook", "source") || cues.split(/\s+/).some((cue) => cue.length > 3 && lower.includes(cue));
  });

  for (const doc of matchingDocuments.slice(0, 2)) {
    add(doc.agent_id, `Retrieve approved chunks from ${doc.title} and answer only from cited document evidence.`);
  }

  if (contains("privacy", "consent", "legal", "records", "policy risk")) {
    add("legal_privacy_lora", "Review consent, privacy boundaries, records needed, and legal-information caveats.");
  }
  if (contains("health", "patient", "clinic", "medical", "symptom", "care")) {
    add("health_safety_lora", "Suggest health-safe, patient-facing wording and escalation boundaries.");
  }
  if (contains("refund", "return", "replacement", "damaged")) {
    add("finance_risk_lora", "Identify refund, billing, and financial-risk assumptions.");
    add("refund_policy_lora", "Use the approved refund policy source to determine policy boundaries.");
  }
  if (contains("software", "api", "backend", "frontend", "web app", "architecture", "database")) {
    add("software_architect_lora", "Plan the software architecture, APIs, data model, and implementation risks.");
  }
  if (contains("security", "auth", "abuse", "hardening", "threat")) {
    add("security_review_lora", "Review abuse cases, auth boundaries, data protection, and hardening tests.");
  }
  if (contains("sql", "warehouse", "analytics", "metric", "dashboard")) {
    add("sql_analytics_lora", "Define analytics checks, metric logic, and query validation plan.");
  }
  if (contains("calculate", "csv", "table", "numbers", "formula", "rank-nullity", "rank nullity")) {
    add("data_math_tool_lora", "Verify calculations and formulas with a visible arithmetic trace.");
  }
  if (contains("research", "literature", "evidence", "study", "paper")) {
    add("research_literature_lora", "Summarize evidence quality, caveats, and research terms.");
  }
  if (contains("lesson", "curriculum", "student", "teach", "worksheet")) {
    add("education_curriculum_lora", "Adapt the response for teaching, learning outcomes, and assessment.");
  }
  if (contains("chart", "visualization", "graph", "plot")) {
    add("visualization_lora", "Recommend chart and dashboard presentation choices.");
  }
  if (contains("launch", "product", "customer segment", "value proposition", "positioning")) {
    add("product_strategy_lora", "Frame product strategy, customer segments, and launch assumptions.");
  }
  if (contains("plan", "timeline", "milestone", "rollout", "checklist")) {
    add("project_planning_lora", "Sequence the work into milestones, owners, and checklist items.");
  }

  const metadataCandidates = enabled
    .filter((agent) => agent.id !== "writing_synthesis_lora" && !idByAdapter.has(agent.id))
    .map((agent) => ({ agent, score: agentMetadataScore(agent, lower) }))
    .filter((match) => match.score > 0)
    .sort((left, right) =>
      right.score - left.score
      || routingRankingScore(agentRankings[right.agent.id]) - routingRankingScore(agentRankings[left.agent.id])
      || left.agent.id.localeCompare(right.agent.id)
    );
  const metadataMatches = metadataCandidates.slice(0, Math.min(2, specialistLimit));
  for (const { agent, score } of metadataMatches) {
    const rank = rankingScore(agentRankings[agent.id]);
    const rankApplied = agentRankings[agent.id]?.routing_eligible === true
      && metadataCandidates.some((candidate) => candidate.agent.id !== agent.id && candidate.score === score);
    add(agent.id, `Apply ${agent.title || agent.id} to the request using only its declared tools and approved sources.`, [], {
      adapter: agent.id,
      source: rankApplied ? "cue+reality_rank" : "cue",
      confidence: Number((score / (score + 4)).toFixed(4)),
      reality_rank: rank,
      reason: rankApplied
        ? "Capability cues matched; settled outcomes broke an equally relevant tie."
        : "Agent metadata matched the request."
    });
  }

  const currentAdapters = steps.map((step) => step.adapter);
  if (contains("support", "faq", "customer", "reply", "message") || currentAdapters.includes("refund_policy_lora") || currentAdapters.includes("health_safety_lora")) {
    add("customer_support_lora", "Draft support-ready language using upstream constraints.", [
      "legal_privacy_lora",
      "health_safety_lora",
      "finance_risk_lora",
      "refund_policy_lora"
    ]);
  }

  if (steps.length === 0) {
    add("product_strategy_lora", "Clarify the request and identify the most useful product-facing answer.");
    add("project_planning_lora", "Turn the request into practical next steps.", ["product_strategy_lora"]);
  }

  add("writing_synthesis_lora", "Synthesize one concise final answer while preserving source and safety boundaries.", steps.map((step) => step.adapter));

  return {
    steps,
    routing: {
      mode: "simulator",
      candidate_trace: metadataCandidates.slice(0, 256).map(({ agent, score }) => ({
        adapter: agent.id,
        cue_score: score,
        reality_rank: rankingScore(agentRankings[agent.id]),
        rank_sample_size: Math.max(0, Number(agentRankings[agent.id]?.sample_size) || 0),
        rank_supplied: agentRankings[agent.id]?.routing_eligible === true,
        agent_revision: agentRankings[agent.id]?.agent_revision || agentRevision(agent)
      })),
      explicit_adapters: [...selections.values()]
        .filter((selection) => selection.source === "explicit")
        .map((selection) => selection.adapter),
      selected: steps
        .filter((step) => step.adapter !== "writing_synthesis_lora")
        .map((step) => selections.get(step.adapter) || {
          adapter: step.adapter,
          source: "cue",
          confidence: null,
          reality_rank: rankingScore(agentRankings[step.adapter]),
          reason: "Deterministic capability rule matched the request."
        })
    }
  };
}

function rankingScore(value) {
  const score = Number(value?.score ?? value);
  return Number.isFinite(score) && score >= 0 && score <= 1 ? score : 0.5;
}

function routingRankingScore(value) {
  if (value?.routing_eligible !== true) return 0.5;
  const score = Number(value.routing_score ?? value.score);
  return Number.isFinite(score) && score >= 0 && score <= 1 ? score : 0.5;
}

function resolveExplicitAgentMentions(query, agents) {
  const aliases = new Map();
  for (const agent of agents) {
    const values = [
      agent.id,
      String(agent.id || "").replace(/_lora$/, ""),
      agent.title,
      agent.document?.title
    ].filter(Boolean);
    for (const value of values) {
      aliases.set(slugify(value), agent);
    }
  }
  const selected = [];
  const seen = new Set();
  const mentionPattern = /@(?:"([^"\r\n]+)"|'([^'\r\n]+)'|“([^”\r\n]+)”|‘([^’\r\n]+)’|([a-z0-9][a-z0-9_-]*))/gi;
  for (const match of String(query || "").matchAll(mentionPattern)) {
    const reference = match.slice(1).find((value) => value !== undefined);
    const agent = aliases.get(slugify(reference));
    if (agent && !seen.has(agent.id)) {
      selected.push(agent);
      seen.add(agent.id);
    }
  }
  return selected;
}

function agentMetadataScore(agent, lowerQuery) {
  const phrases = [agent.title, agent.id, agent.document?.title, ...(agent.routing_cues || [])]
    .map((value) => String(value || "").toLowerCase().trim())
    .filter((value) => value.length >= 4);
  let score = 0;
  for (const phrase of phrases) {
    const normalized = phrase.replace(/_lora$/, "").replaceAll("_", " ").replaceAll("-", " ");
    if (lowerQuery.includes(phrase) || lowerQuery.includes(normalized)) {
      score += phrase.includes(" ") ? 4 : 2;
    }
  }
  return score;
}

export function scopedRoutingContext({ session, agents = [], documents = [] }) {
  const inactiveAgentIds = new Set(Array.isArray(session?.inactive_agent_ids) ? session.inactive_agent_ids : []);
  const visibleAgents = agents.filter((agent) =>
    agent.enabled !== false &&
    agent.mounted !== false &&
    agent.runtime_sync_pending !== true &&
    !inactiveAgentIds.has(agent.id) &&
    resourceVisibleToSession(agent, session)
  );
  const visibleDocuments = documents.filter((document) =>
    document.enabled !== false &&
    document.runtime_sync_pending !== true &&
    resourceVisibleToSession(document, session)
  );
  const allowedAdapters = [...new Set(visibleAgents.map((agent) => agent.id).filter(Boolean))];
  return {
    agents: visibleAgents,
    documents: visibleDocuments,
    allowedAdapters
  };
}

function resourceVisibleToSession(resource = {}, session = {}) {
  const scope = resource.scope === "chat" ? "chat" : "knowledge";
  if (scope === "chat" && String(resource.session_id || "") !== String(session?.session_id || "")) {
    return false;
  }
  if (!resource.workspace_id) {
    return true;
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

export function buildParallelBatches(steps, workers = 2) {
  const ids = new Set();
  for (const step of steps) {
    if (ids.has(step.id)) {
      throwDagError("duplicate_step_id", `Duplicate step id: ${step.id}`);
    }
    ids.add(step.id);
  }

  for (const step of steps) {
    for (const dep of step.depends_on || []) {
      if (!ids.has(dep)) {
        throwDagError("unresolved_dependency", `Step ${step.id} depends on missing step ${dep}`);
      }
    }
  }

  const completed = new Set();
  const remaining = [...steps];
  const batches = [];

  while (remaining.length > 0) {
    const ready = remaining.filter((step) => (step.depends_on || []).every((dep) => completed.has(dep)));
    if (ready.length === 0) {
      throwDagError("cyclic_dependency", "Route DAG contains a dependency cycle.");
    }
    const batchNumber = batches.length + 1;
    batches.push({
      batch: batchNumber,
      width: ready.length,
      workers,
      steps: ready.map((step) => step.id)
    });
    for (const step of ready) {
      completed.add(step.id);
      remaining.splice(remaining.indexOf(step), 1);
    }
  }

  return {
    workers,
    batches,
    maxBatchWidth: batches.reduce((max, batch) => Math.max(max, batch.width), 0),
    parallelizable: batches.some((batch) => batch.width > 1)
  };
}

function throwDagError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.status = 400;
  throw error;
}

export function sanitizeToolCalls(rawText, allowedTools = []) {
  const violations = [];
  const sanitized = rawText.replace(/<tool_call>([\s\S]*?)<\/tool_call>/g, (_match, payload) => {
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
    text: sanitized.replace(/<think>[\s\S]*?<\/think>/gi, "").trim(),
    violations
  };
}

export function parseRouteSections(text) {
  const section = (name) => {
    const pattern = new RegExp(`${name}:\\s*([\\s\\S]*?)(?=\\n[A-Z_]+:|$)`, "i");
    return text.match(pattern)?.[1]?.trim() || "";
  };
  return {
    agent_reasoning: section("AGENT_REASONING"),
    domain_answer: section("DOMAIN_ANSWER"),
    handoffs: section("HANDOFFS"),
    boundary_check: section("BOUNDARY_CHECK"),
    retrieved_context: section("EXECUTOR_RETRIEVED_CONTEXT")
  };
}

export function normalizeSharedMemory(
  entries,
  {
    maxEntries = Number(process.env.TCAR_SHARED_MEMORY_MAX_ENTRIES || DEFAULT_MEMORY_ENTRIES),
    maxEntryChars = Number(process.env.TCAR_SHARED_MEMORY_MAX_ENTRY_CHARS || DEFAULT_MEMORY_ENTRY_CHARS),
    maxTotalChars = Number(process.env.TCAR_SHARED_MEMORY_MAX_TOTAL_CHARS || DEFAULT_MEMORY_TOTAL_CHARS)
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
  let totalChars = 0;
  for (const entry of normalized.slice(-maxEntries).reverse()) {
    if (totalChars + entry.content.length > maxTotalChars && retained.length > 0) {
      break;
    }
    retained.push(entry);
    totalChars += entry.content.length;
  }
  return retained.reverse();
}

function nextSharedMemory(existing, additions) {
  return normalizeSharedMemory([...(Array.isArray(existing) ? existing : []), ...additions]);
}

export async function processChatRun({ store, bus, run_id, options = {} }) {
  if (realRuntimeEnabled()) {
    return processRemoteChatRun({ store, bus, run_id, options });
  }
  return processLocalChatRun({ store, bus, run_id, options });
}

async function processLocalChatRun({ store, bus, run_id, options = {} }) {
  const started = Date.now();
  try {
    const snapshot = store.read((data) => ({
      run: data.runs.find((item) => item.run_id === run_id),
      session: data.sessions.find((item) => item.session_id === data.runs.find((run) => run.run_id === run_id)?.session_id),
      agents: data.agents,
      documents: data.documents,
      messages: data.messages,
      outcomeContracts: data.outcomeContracts || [],
      executionRecords: data.executionRecords || []
    }));
    if (!snapshot.run) {
      throw new Error("Run not found.");
    }

    const query = snapshot.run.query;
    const scoped = scopedRoutingContext({
      session: snapshot.session,
      agents: snapshot.agents,
      documents: snapshot.documents
    });
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
      maxRoutingAdapters: Number(options.max_routing_adapters) || 12
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
    for (const batch of parallel.batches) {
      const batchSteps = plan.steps.filter((step) => batch.steps.includes(step.id));
      await Promise.all(batchSteps.map(async (step) => {
        const routeStartedEvent = {
          type: "route.started",
          step_id: step.id,
          adapter: step.adapter,
          agent_revision: agentRevision(scoped.agents.find((agent) => agent.id === step.adapter) || { id: step.adapter }),
          adapter_digest: null,
          model_id: BASE_MODEL,
          batch: batch.batch
        };
        const routeStarted = Date.now();
        const result = buildRouteOutput({
          step,
          query,
          agents: scoped.agents,
          documents: scoped.documents,
          upstream: routeOutputs
        });
        const elapsed = Number(((Date.now() - routeStarted) / 1000 + 0.015).toFixed(3));
        routeOutputs.push({ ...result, elapsed_sec: elapsed, parallel_batch: batch.batch, parallel_width: batch.width });
        const routeCompletedEvent = {
          type: "route.completed",
          step_id: step.id,
          adapter: step.adapter,
          elapsed_sec: elapsed
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
            agent_reasoning: result.agent_reasoning,
            domain_answer: result.domain_answer,
            handoffs: result.handoffs,
            handoff_artifacts: result.handoff_artifacts,
            boundary_check: result.boundary_check,
            allowed_tools: result.allowed_tools,
            approved_sources: result.approved_sources,
            policy_violations: result.policy_violations,
            retrieved_context: result.retrieved_context,
            citations: result.citations,
            raw_text_admin_only: result.raw_text,
            prompt_preview_admin_only: `Adapter ${step.adapter} received task: ${step.task}`,
            started_at: new Date(routeStarted).toISOString(),
            completed_at: nowIso(),
            elapsed_sec: elapsed
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
      run.expert_outputs = routeOutputs;
      run.sources = citations;
      run.policy_events = policyEvents;
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
        created_at: completedAt
      });
      if (session) {
        session.updated_at = completedAt;
        session.last_message_at = completedAt;
        session.shared_memory = nextSharedMemory(session.shared_memory, [
          { tag: "user_request", source: "user", content: query },
          ...routeOutputs.map((output) => ({
            tag: `${output.adapter}.final`,
            source: output.adapter,
            content: output.domain_answer
          })),
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
        run.events.push({ type: "run.failed", message: failure.public.message, at: nowIso() });
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
    bus.publish(run_id, { type: "run.failed", message: failure.public.message });
  }
}

async function processRemoteChatRun({ store, bus, run_id, options = {} }) {
  const started = Date.now();
  try {
    const snapshot = store.read((data) => ({
      run: data.runs.find((item) => item.run_id === run_id),
      session: data.sessions.find((item) => item.session_id === data.runs.find((run) => run.run_id === run_id)?.session_id),
      agents: data.agents,
      documents: data.documents,
      outcomeContracts: data.outcomeContracts || [],
      executionRecords: data.executionRecords || []
    }));
    if (!snapshot.run) {
      throw new Error("Run not found.");
    }

    const query = snapshot.run.query;
    const scoped = scopedRoutingContext({
      session: snapshot.session,
      agents: snapshot.agents,
      documents: snapshot.documents
    });
    const agentRankings = realityRankMap(snapshot, {
      agents: scoped.agents,
      workspaceId: snapshot.session?.workspace_id,
      query
    });
    await persistRunTransition({
      store,
      bus,
      runId: run_id,
      patch: { status: "planning", started_at: nowIso() },
      events: [
        { type: "run.started", run_id },
        { type: "runtime.requested" }
      ]
    });
    const result = await executeRuntimeChat({
      query,
      sharedMemory: normalizeSharedMemory(snapshot.session?.shared_memory || []),
      executionContext: {
        run_id,
        workspace_id: snapshot.session?.workspace_id || null,
        session_id: snapshot.session?.session_id || null,
        user_id: snapshot.run.created_by || snapshot.session?.created_by || null,
        role: snapshot.run.actor_role || null
      },
      options: {
        planner_mode: options.planner_mode || process.env.TCAR_PLANNER_MODE || "session",
        max_routing_adapters: Number(options.max_routing_adapters) || Number(process.env.TCAR_MAX_ROUTING_ADAPTERS || 12),
        parallel_workers: Number(options.parallel_workers) || Number(process.env.TCAR_PARALLEL_WORKERS || 2),
        max_tokens: Number(options.max_tokens) || Number(process.env.TCAR_MAX_TOKENS || 256),
        refiner_max_tokens: Number(options.refiner_max_tokens) || Number(process.env.TCAR_REFINER_MAX_TOKENS || 384),
        temperature: Number(options.temperature ?? process.env.TCAR_TEMPERATURE ?? 0),
        allowed_adapters: scoped.allowedAdapters,
        agent_rankings: Object.fromEntries(
          Object.entries(agentRankings)
            .filter(([, ranking]) => ranking.routing_eligible === true)
            .map(([agentId, ranking]) => [agentId, ranking.routing_score])
        )
      }
    });
    if (result.ok === false) {
      throw new Error(result.error || "TCAR runtime returned an unsuccessful response.");
    }

    const plan = enrichRuntimeRoutingTrace(
      normalizeRuntimePlan(result.plan),
      agentRankings,
      scoped.agents
    );
    const parallel = result.parallel || { workers: Number(options.parallel_workers) || 2, batches: [], maxBatchWidth: 0, parallelizable: false };
    await updateRun(store, bus, run_id, { plan, parallel, status: "running" }, { type: "planner.completed", steps: plan.steps });

    const outputs = Array.isArray(result.expertOutputs) ? result.expertOutputs : [];
    for (const output of outputs) {
      const routeStartedEvent = {
        type: "route.started",
        step_id: output.id,
        adapter: output.adapter,
        batch: output.parallel_batch || null
      };
      const routeCompletedEvent = {
        type: "route.completed",
        step_id: output.id,
        adapter: output.adapter,
        elapsed_sec: output.elapsed_sec || null
      };
      await persistCompletedRunRoute({
        store,
        bus,
        runId: run_id,
        startedEvent: routeStartedEvent,
        completedEvent: routeCompletedEvent,
        runStep: runtimeOutputToRunStep({ run_id, output, parallel })
      });
    }

    await updateRun(store, bus, run_id, { status: "synthesizing" }, { type: "synthesis.started" });
    const citations = runtimeCitations(outputs);
    const policyEvents = outputs.flatMap((output) =>
      (output.policy_violations || []).map((violation) => ({ step_id: output.id, adapter: output.adapter, violation }))
    );
    const finalAnswer = result.finalAnswer || result.fallbackFinalAnswer || "";
    const assistantMessageId = makeId("msg");
    const completedAt = nowIso();
    const elapsedSec = Number(((Date.now() - started) / 1000).toFixed(3));

    await store.mutate((data) => {
      const run = data.runs.find((item) => item.run_id === run_id);
      const session = data.sessions.find((item) => item.session_id === run.session_id);
      run.status = "completed";
      run.final_answer = finalAnswer;
      run.expert_outputs = outputs;
      run.sources = citations;
      run.policy_events = policyEvents;
      run.assistant_message_id = assistantMessageId;
      run.completed_at = completedAt;
      run.elapsed_sec = elapsedSec;
      run.manifest_revision = result.manifestRevision || null;
      run.reality_rank_snapshot = agentRankings;
      run.runtime_result_admin_only = {
        mode: result.mode,
        plannerMode: result.plannerMode,
        sessionController: normalizeArtifactValue(result.sessionController || null),
        vllmBaseUrl: result.vllmBaseUrl,
        baseModel: result.baseModel,
        apiElapsedSec: result.apiElapsedSec,
        executorElapsedSec: result.elapsedSec,
        componentProvenance: result.componentProvenance || null
      };
      data.messages.push({
        message_id: assistantMessageId,
        session_id: run.session_id,
        role: "assistant",
        content: finalAnswer,
        attachments: [],
        run_id,
        created_at: completedAt
      });
      if (session) {
        session.updated_at = completedAt;
        session.last_message_at = completedAt;
        session.shared_memory = nextSharedMemory(session.shared_memory, [
          { tag: "user_request", source: "user", content: query },
          ...outputs.map((output) => ({
            tag: `${output.adapter}.final`,
            source: output.adapter,
            content: output.domain_answer || output.text || ""
          })),
          { tag: "base.synthesis", source: result.baseModel || BASE_MODEL, content: finalAnswer }
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
        run.events.push({ type: "run.failed", message: failure.public.message, at: nowIso() });
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
    bus.publish(run_id, { type: "run.failed", message: failure.public.message });
  }
}

function normalizeRunFailure(error, fallbackCode) {
  const code = String(error?.code || fallbackCode || "run_failed");
  const message = String(error?.message || "Run failed.");
  return {
    public: {
      code,
      message: "The run failed before completion. Try again or contact support with the run id."
    },
    admin: {
      code,
      message,
      status: error?.status || null,
      payload: error?.payload || null,
      stack: error?.stack || null
    }
  };
}

function normalizeRuntimePlan(plan) {
  if (plan?.steps) {
    return {
      steps: plan.steps,
      adapters: plan.adapters || plan.steps.map((step) => step.adapter),
      edges: plan.edges || plan.steps.flatMap((step) => (step.depends_on || []).map((source) => ({ source, target: step.id }))),
      acyclic: plan.acyclic !== false,
      routing: normalizeRuntimeRouting(plan.routing)
    };
  }
  return { steps: [], adapters: [], edges: [], acyclic: true, routing: null };
}

export function normalizeRuntimeRouting(routing) {
  if (!routing || typeof routing !== "object" || Array.isArray(routing)) {
    return null;
  }
  const selected = Array.isArray(routing.selected)
    ? routing.selected.slice(0, 64).flatMap((selection) => {
      if (!selection || typeof selection !== "object" || Array.isArray(selection)) return [];
      return [{
        adapter: boundedText(selection.adapter, 240),
        source: boundedText(selection.source, 120),
        confidence: finiteProbabilityOrNull(selection.confidence),
        reality_rank: finiteProbabilityOrNull(selection.reality_rank),
        reason: boundedText(selection.reason, 1000)
      }];
    }).filter((selection) => selection.adapter)
    : [];
  const rawOrchestrator = routing.orchestrator;
  const orchestrator = rawOrchestrator && typeof rawOrchestrator === "object" && !Array.isArray(rawOrchestrator)
    ? {
      contract_version: boundedText(rawOrchestrator.contract_version, 120),
      decision: boundedText(rawOrchestrator.decision, 40),
      model: boundedText(rawOrchestrator.model, 240),
      intent: boundedText(rawOrchestrator.intent, 600),
      required_capabilities: boundedStringList(rawOrchestrator.required_capabilities, 24, 240),
      missing_capabilities: boundedStringList(rawOrchestrator.missing_capabilities, 24, 240),
      clarification_question: boundedText(rawOrchestrator.clarification_question, 600),
      synthesis_brief: boundedText(rawOrchestrator.synthesis_brief, 1200),
      discovery_method: boundedText(rawOrchestrator.discovery_method, 120),
      authorized_agent_count: Math.max(0, Math.min(Number(rawOrchestrator.authorized_agent_count) || 0, 100000)),
      discovered_candidate_count: Math.max(0, Math.min(Number(rawOrchestrator.discovered_candidate_count) || 0, 100000)),
      catalog_checked: boundedStringList(rawOrchestrator.catalog_checked, 64, 240),
      rejected_adapters: boundedStringList(rawOrchestrator.rejected_adapters, 24, 240),
      fallback_used: boundedText(rawOrchestrator.fallback_used, 120),
      planning_call_performed: rawOrchestrator.planning_call_performed === true,
      final_synthesis_required: rawOrchestrator.final_synthesis_required === true
    }
    : null;
  return {
    mode: boundedText(routing.mode, 80),
    candidate_count: Math.max(0, Math.min(Number(routing.candidate_count) || 0, 100000)),
    candidate_adapters: boundedStringList(routing.candidate_adapters, 256, 240),
    candidate_trace: Array.isArray(routing.candidate_trace)
      ? routing.candidate_trace.slice(0, 256).flatMap((candidate) => {
        if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
        const adapter = boundedText(candidate.adapter, 240);
        if (!adapter) return [];
        return [{
          adapter,
          cue_score: finiteNonNegativeOrNull(candidate.cue_score),
          reality_rank: finiteProbabilityOrNull(candidate.reality_rank),
          rank_supplied: candidate.rank_supplied === true
        }];
      })
      : [],
    selected,
    explicit_adapters: boundedStringList(routing.explicit_adapters, 64, 240),
    unresolved_mentions: boundedStringList(routing.unresolved_mentions, 64, 500),
    out_of_scope: routing.out_of_scope === true,
    reason: boundedText(routing.reason, 1000),
    fallback: boundedText(routing.fallback, 240),
    orchestrator
  };
}

export function enrichRuntimeRoutingTrace(plan, agentRankings, agents) {
  if (!plan?.routing) return plan;
  const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
  const enrich = (candidate) => {
    const ranking = agentRankings[candidate.adapter];
    const agent = agentsById.get(candidate.adapter);
    return {
      ...candidate,
      reality_rank: ranking ? ranking.score : candidate.reality_rank ?? 0.5,
      rank_sample_size: Math.max(0, Number(ranking?.sample_size) || 0),
      rank_supplied: ranking ? ranking.routing_eligible === true : candidate.rank_supplied === true,
      agent_revision: ranking?.agent_revision || (agent ? agentRevision(agent) : null)
    };
  };
  const traceById = new Map((plan.routing.candidate_trace || []).map((candidate) => [candidate.adapter, candidate]));
  for (const adapter of plan.routing.candidate_adapters || []) {
    if (!traceById.has(adapter)) traceById.set(adapter, { adapter });
  }
  plan.routing.candidate_trace = [...traceById.values()].slice(0, 256).map(enrich);
  plan.routing.selected = (plan.routing.selected || []).slice(0, 256).map(enrich);
  return plan;
}

function boundedStringList(value, maxItems, maxChars) {
  return Array.isArray(value)
    ? value.slice(0, maxItems).map((item) => boundedText(item, maxChars)).filter(Boolean)
    : [];
}

function finiteNonNegativeOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function runtimeOutputToRunStep({ run_id, output, parallel }) {
  const sections = parseRouteSections(output.text || output.raw_text || "");
  const batch = output.parallel_batch || findBatchForStep(parallel, output.id);
  const width = output.parallel_width || parallel?.batches?.find((item) => item.batch === batch)?.width || 1;
  return {
    run_step_id: makeId("run_step"),
    run_id,
    step_id: output.id,
    adapter: output.adapter,
    agent_revision: normalizeSha256Digest(output.agent_revision),
    adapter_digest: normalizeSha256Digest(output.adapter_content_digest || output.adapter_digest),
    model_id: output.model_id || null,
    model_calls_admin_only: normalizeArtifactValue(output.model_calls || []),
    task: output.task || "",
    depends_on: output.depends_on || [],
    used_upstream: output.used_upstream || [],
    parallel_batch: batch,
    parallel_width: width,
    status: "completed",
    agent_reasoning: output.agent_reasoning || sections.agent_reasoning,
    domain_answer: output.domain_answer || sections.domain_answer,
    handoffs: typeof output.handoffs === "string" ? output.handoffs : sections.handoffs,
    handoff_artifacts: normalizeHandoffArtifacts(output.handoff_artifacts || output.handoffs, output),
    artifact_validation: normalizeArtifactValue(output.artifact_validation || {}),
    consumption_validation: normalizeArtifactValue(output.consumption_validation || {}),
    boundary_check: output.boundary_check || sections.boundary_check,
    allowed_tools: output.allowed_tools || [],
    approved_sources: output.approved_sources || [],
    policy_violations: output.policy_violations || [],
    retrieved_context: output.retrieved_context || sections.retrieved_context,
    citations: runtimeCitations([output]),
    raw_text_admin_only: output.raw_text || output.text || "",
    prompt_preview_admin_only: output.prompt_preview || "",
    started_at: nowIso(),
    completed_at: nowIso(),
    elapsed_sec: output.elapsed_sec || null
  };
}

function findBatchForStep(parallel, stepId) {
  return parallel?.batches?.find((batch) => (batch.steps || []).includes(stepId))?.batch || null;
}

function runtimeCitations(outputs) {
  return outputs.flatMap((output) => {
    if (Array.isArray(output.citations)) {
      return output.citations
        .slice(0, 32)
        .map((citation) => normalizeRuntimeCitation(citation, output))
        .filter(Boolean);
    }
    const context = output.retrieved_context || parseRouteSections(output.text || "").retrieved_context || "";
    if (!context) return [];
    return context.split(/\n+/).filter(Boolean).slice(0, 8).map((line, index) => {
      const [label, ...rest] = line.split(" - ");
      return {
        citation_id: stableCitationId({
          step_id: output.id,
          agent_id: output.adapter,
          chunk_id: label?.split(":")[0] || `${output.id}_${index + 1}`,
          excerpt: rest.join(" - ") || line
        }),
        step_id: output.id,
        agent_id: output.adapter,
        path: "",
        chunk_id: label?.split(":")[0] || `${output.id}_${index + 1}`,
        title: label?.split(":").slice(1).join(":") || output.adapter,
        page_start: null,
        page_end: null,
        score: null,
        excerpt: rest.join(" - ") || line,
        injected: true,
        claim: "",
        verified: false
      };
    });
  });
}

function normalizeRuntimeCitation(citation, output) {
  if (!citation || typeof citation !== "object" || Array.isArray(citation)) {
    return null;
  }
  const chunkId = boundedText(citation.chunk_id, 240);
  const title = boundedText(citation.title, 500);
  const excerpt = boundedText(citation.excerpt, 4000);
  if (!chunkId && !title && !excerpt) {
    return null;
  }
  const requestedPath = String(citation.path || "").replaceAll("\\", "/");
  if (requestedPath && !isApprovedCitationPath(requestedPath, output.approved_sources || [])) {
    return null;
  }
  const pageStart = positiveIntegerOrNull(citation.page_start ?? citation.page);
  const requestedEnd = positiveIntegerOrNull(citation.page_end ?? citation.page);
  const pageEnd = pageStart && requestedEnd && requestedEnd >= pageStart ? requestedEnd : pageStart;
  const numericScore = Number(citation.score);
  const contentDigest = normalizeSha256Digest(citation.content_digest);
  const corpusRevision = normalizeSha256Digest(citation.corpus_revision);
  const indexDigest = normalizeSha256Digest(citation.index_digest);
  const documentChunk = requestedPath.includes("/chunks/")
    && (output.approved_sources || []).some((source) => String(source || "").replaceAll("\\", "/").endsWith("/index.jsonl"));
  const integrityBound = !documentChunk || Boolean(contentDigest && corpusRevision && indexDigest);
  return {
    citation_id: stableCitationId({
      step_id: output.id,
      agent_id: output.adapter,
      path: requestedPath,
      chunk_id: chunkId,
      page_start: pageStart,
      page_end: pageEnd,
      content_digest: contentDigest,
      corpus_revision: corpusRevision,
      index_digest: indexDigest,
      excerpt
    }),
    step_id: output.id,
    agent_id: output.adapter,
    path: requestedPath,
    chunk_id: chunkId,
    title: title || output.adapter,
    page_start: pageStart,
    page_end: pageEnd,
    content_digest: contentDigest,
    corpus_revision: corpusRevision,
    index_digest: indexDigest,
    score: Number.isFinite(numericScore) ? numericScore : null,
    excerpt,
    injected: citation.injected !== false,
    claim: boundedText(citation.claim, 2000),
    verified: citation.verified === true
      && Boolean(chunkId)
      && integrityBound
      && (!requestedPath || isApprovedCitationPath(requestedPath, output.approved_sources || []))
  };
}

function isApprovedCitationPath(sourcePath, approvedSources) {
  const normalized = String(sourcePath || "").replaceAll("\\", "/");
  if (
    normalized.startsWith("/") ||
    normalized.includes("..") ||
    !(normalized.startsWith("sources/tcar_documents/") || normalized.startsWith("sources/tcar_dummy_loras/"))
  ) {
    return false;
  }
  const approved = (approvedSources || []).map((value) => String(value || "").replaceAll("\\", "/"));
  if (approved.length === 0) {
    return false;
  }
  return approved.some((allowedPath) => {
    if (normalized === allowedPath) return true;
    if (allowedPath.endsWith("/index.jsonl")) {
      return normalized.startsWith(`${allowedPath.slice(0, -"index.jsonl".length)}chunks/`);
    }
    return false;
  });
}

function positiveIntegerOrNull(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function stableCitationId(value) {
  return `cit_${digestValue(value).slice("sha256:".length, "sha256:".length + 24)}`;
}

function boundedText(value, maxChars) {
  return String(value || "").replaceAll("\0", "").trim().slice(0, maxChars);
}

function normalizeHandoffArtifacts(value, output) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.slice(0, 32).flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return [];
    }
    const artifact = boundedText(item.artifact || item.name || item.type, 160);
    const artifactValue = item.value ?? item.content ?? item.data;
    if (!artifact || artifactValue === undefined || artifactValue === null || artifactValue === "") {
      return [];
    }
    return [{
      artifact_id: item.artifact_id || `artifact_${digestValue({
        step_id: output.id || output.step_id || null,
        name: artifact,
        value: artifactValue
      }).slice("sha256:".length, "sha256:".length + 24)}`,
      schema_version: boundedText(item.schema_version || "tcar-handoff-artifact-v1", 120),
      name: artifact,
      artifact,
      producer_step_id: output.id || output.step_id || null,
      producer_agent_id: output.adapter || null,
      producer: output.adapter || null,
      content_type: boundedText(item.content_type || "application/json", 120),
      value: normalizeArtifactValue(artifactValue),
      content_digest: normalizeSha256Digest(item.content_digest) || digestValue(normalizeArtifactValue(artifactValue)),
      evidence: boundedStringList(item.evidence || item.citations, 50, 240),
      confidence: finiteProbabilityOrNull(item.confidence),
      status: boundedText(item.status || "runtime_structured", 120),
      verified: item.verified === true
    }];
  });
}

function normalizeArtifactValue(value) {
  if (typeof value === "string") {
    return boundedText(value, 12000);
  }
  if (["number", "boolean"].includes(typeof value)) {
    return value;
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return boundedText(value, 12000);
  }
}

function finiteProbabilityOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : null;
}

async function updateRun(store, bus, run_id, patch, event) {
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

async function persistRunTransition({ store, bus, runId, patch, events = [] }) {
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

async function persistCompletedRunRoute({ store, bus, runId, startedEvent, completedEvent, runStep }) {
  await store.mutate((data) => {
    const run = data.runs.find((item) => item.run_id === runId);
    if (!run) {
      throw new Error("Run not found.");
    }
    run.events.push({ ...startedEvent, at: nowIso() });
    const index = data.runSteps.findIndex((item) => item.run_id === runId && item.step_id === runStep.step_id);
    if (index >= 0) {
      data.runSteps[index] = runStep;
    } else {
      data.runSteps.push(runStep);
    }
    run.events.push({ ...completedEvent, at: nowIso() });
    return runStep;
  });
  bus.publish(runId, startedEvent);
  bus.publish(runId, completedEvent);
}

function buildRouteOutput({ step, query, agents, documents }) {
  const agent = agents.find((item) => item.id === step.adapter);
  const citations = gatherCitations({ step, agent, query, documents });
  const retrievedContext = citations
    .map((citation) => `${citation.chunk_id || citation.path}:${citation.title} - ${citation.excerpt}`)
    .join("\n");
  const domainAnswer = domainAnswerFor(step.adapter, query, citations, agent);
  const handoffArtifacts = buildLocalHandoffArtifacts({
    step,
    agent,
    domainAnswer,
    citations,
    retrievedContext
  });
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
  const sections = parseRouteSections(sanitized.text);

  return {
    step_id: step.id,
    adapter: step.adapter,
    task: step.task,
    agent_reasoning: sections.agent_reasoning,
    domain_answer: sections.domain_answer,
    handoffs: sections.handoffs,
    handoff_artifacts: handoffArtifacts,
    boundary_check: sections.boundary_check,
    retrieved_context: sections.retrieved_context,
    allowed_tools: agent?.tools || [],
    approved_sources: agent?.sources || [],
    policy_violations: sanitized.violations,
    citations,
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
    }
    if (value === "" || value === null || value === undefined || (Array.isArray(value) && value.length === 0)) {
      return [];
    }
    const contentDigest = digestValue(value);
    return [{
      artifact_id: `artifact_${digestValue({ step_id: step.id, name: artifact, value }).slice("sha256:".length, "sha256:".length + 24)}`,
      schema_version: "tcar-handoff-artifact-v1",
      name: artifact,
      artifact,
      producer_step_id: step.id,
      producer_agent_id: step.adapter,
      producer: step.adapter,
      content_type: contentType,
      value,
      content_digest: contentDigest,
      evidence: citations.map((citation) => citation.chunk_id).filter(Boolean),
      confidence: citations.length > 0 ? 1 : null,
      status: "local_executor_derived",
      verified: true
    }];
  });
}

function domainAnswerFor(adapter, query, citations, agent) {
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
  if (citations.length > 0) {
    return `Based on the agent's approved knowledge: ${citations.map((citation) => citation.excerpt).join(" ")}`;
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

export function runtimeHealth(data) {
  const mountedLoras = data.agents.filter((agent) => agent.mounted !== false).length;
  return {
    ok: true,
    vllm: {
      base_url: process.env.VLLM_BASE_URL || DEFAULT_VLLM_BASE_URL,
      models_endpoint_ok: false,
      base_model: process.env.VLLM_BASE_MODEL || BASE_MODEL,
      mounted_loras: mountedLoras,
      mode: "local deterministic TCAR simulator"
    },
    manifest: {
      path: process.env.PHASE222_ADAPTER_MANIFEST || "configs/tcar_lora_library.json",
      adapters: data.agents.length,
      valid: data.agents.every((agent) => agent.id.endsWith("_lora") && agent.title && agent.capability)
    }
  };
}

export function computeMetrics(data) {
  const completedRuns = data.runs.filter((run) => run.status === "completed");
  const elapsed = completedRuns.map((run) => run.elapsed_sec || 0).sort((a, b) => a - b);
  const percentile = (p) => {
    if (elapsed.length === 0) return 0;
    const index = Math.min(elapsed.length - 1, Math.floor((elapsed.length - 1) * p));
    return elapsed[index];
  };
  const routeCounts = new Map();
  for (const step of data.runSteps) {
    routeCounts.set(step.adapter, (routeCounts.get(step.adapter) || 0) + 1);
  }
  return {
    total_chats: data.sessions.length,
    total_runs: data.runs.length,
    average_planner_latency: 0.01,
    average_route_latency: average(data.runSteps.map((step) => step.elapsed_sec || 0)),
    average_synthesis_latency: 0.01,
    p50_end_to_end_latency: percentile(0.5),
    p95_end_to_end_latency: percentile(0.95),
    p99_end_to_end_latency: percentile(0.99),
    average_parallel_batch_width: average(data.runs.flatMap((run) => run.parallel?.batches?.map((batch) => batch.width) || [])),
    vllm_waiting_queue_count: null,
    gpu_kv_cache_usage: null,
    policy_violation_count: data.runs.reduce((total, run) => total + (run.policy_events?.length || 0), 0),
    retrieval_miss_count: data.runSteps.filter((step) => step.adapter.includes("document") && !step.retrieved_context).length,
    bad_response_flags: data.runs.filter((run) => run.feedback?.some((item) => item.rating === "bad")).length,
    most_used_agents: [...routeCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([agent_id, count]) => ({ agent_id, count })),
    failed_agents: [],
    most_common_routes: [...routeCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([agent_id, count]) => ({ agent_id, count }))
  };
}

function average(values) {
  if (values.length === 0) return 0;
  return Number((values.reduce((total, value) => total + value, 0) / values.length).toFixed(3));
}

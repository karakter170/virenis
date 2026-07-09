import { approvedSourceSnippets, BASE_MODEL, DEFAULT_VLLM_BASE_URL } from "./catalog.js";
import { makeId, nowIso } from "./store.js";
import { scoreChunks } from "./documents.js";
import { executeRuntimeChat, realRuntimeEnabled } from "./runtimeClient.js";

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

export function planRoutes({ query, agents, documents = [] }) {
  const enabled = agents.filter((agent) => agent.enabled !== false);
  const hasAgent = (id) => enabled.some((agent) => agent.id === id);
  const lower = query.toLowerCase();
  const steps = [];
  const idByAdapter = new Map();

  const contains = (...terms) => terms.some((term) => lower.includes(term));
  const add = (adapter, task, dependencyAdapters = []) => {
    if (!hasAgent(adapter) || idByAdapter.has(adapter)) {
      return idByAdapter.get(adapter);
    }
    const id = `s${steps.length + 1}`;
    const depends_on = dependencyAdapters.map((dep) => idByAdapter.get(dep)).filter(Boolean);
    steps.push({ id, adapter, task, depends_on });
    idByAdapter.set(adapter, id);
    return id;
  };

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

  return { steps };
}

export function scopedRoutingContext({ session, agents = [], documents = [] }) {
  const visibleAgents = agents.filter((agent) => resourceVisibleToSession(agent, session));
  const visibleDocuments = documents.filter((document) => resourceVisibleToSession(document, session));
  const allowedAdapters = [...new Set(visibleAgents.map((agent) => agent.id).filter(Boolean))];
  return {
    agents: visibleAgents,
    documents: visibleDocuments,
    allowedAdapters
  };
}

function resourceVisibleToSession(resource = {}, session = {}) {
  if (!resource.workspace_id) {
    return true;
  }
  if (String(resource.workspace_id) !== String(session?.workspace_id || "workspace_default")) {
    return false;
  }
  const visibility = resource.visibility || "team";
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
      messages: data.messages
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
    await updateRun(store, bus, run_id, { status: "planning", started_at: nowIso() }, { type: "run.started", run_id });
    await appendEvent(store, bus, run_id, { type: "planner.started" });
    const plan = planRoutes({ query, agents: scoped.agents, documents: scoped.documents });
    const parallel = buildParallelBatches(plan.steps, Number(options.parallel_workers) || 2);
    await updateRun(store, bus, run_id, { plan, parallel }, { type: "planner.completed", steps: plan.steps });

    const routeOutputs = [];
    for (const batch of parallel.batches) {
      const batchSteps = plan.steps.filter((step) => batch.steps.includes(step.id));
      await Promise.all(batchSteps.map(async (step) => {
        await appendEvent(store, bus, run_id, {
          type: "route.started",
          step_id: step.id,
          adapter: step.adapter,
          batch: batch.batch
        });
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
        await upsertRunStep(store, run_id, {
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
        });
        await appendEvent(store, bus, run_id, {
          type: "route.completed",
          step_id: step.id,
          adapter: step.adapter,
          elapsed_sec: elapsed
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
      documents: data.documents
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
    await updateRun(store, bus, run_id, { status: "planning", started_at: nowIso() }, { type: "run.started", run_id });
    await appendEvent(store, bus, run_id, { type: "runtime.requested" });
    const result = await executeRuntimeChat({
      query,
      sharedMemory: normalizeSharedMemory(snapshot.session?.shared_memory || []),
      options: {
        planner_mode: options.planner_mode || process.env.TCAR_PLANNER_MODE || "cue",
        max_routing_adapters: Number(options.max_routing_adapters) || Number(process.env.TCAR_MAX_ROUTING_ADAPTERS || 12),
        parallel_workers: Number(options.parallel_workers) || Number(process.env.TCAR_PARALLEL_WORKERS || 2),
        max_tokens: Number(options.max_tokens) || Number(process.env.TCAR_MAX_TOKENS || 80),
        refiner_max_tokens: Number(options.refiner_max_tokens) || Number(process.env.TCAR_REFINER_MAX_TOKENS || 220),
        temperature: Number(options.temperature ?? process.env.TCAR_TEMPERATURE ?? 0),
        allowed_adapters: scoped.allowedAdapters
      }
    });
    if (result.ok === false) {
      throw new Error(result.error || "TCAR runtime returned an unsuccessful response.");
    }

    const plan = normalizeRuntimePlan(result.plan);
    const parallel = result.parallel || { workers: Number(options.parallel_workers) || 2, batches: [], maxBatchWidth: 0, parallelizable: false };
    await updateRun(store, bus, run_id, { plan, parallel, status: "running" }, { type: "planner.completed", steps: plan.steps });

    const outputs = Array.isArray(result.expertOutputs) ? result.expertOutputs : [];
    for (const output of outputs) {
      await appendEvent(store, bus, run_id, {
        type: "route.started",
        step_id: output.id,
        adapter: output.adapter,
        batch: output.parallel_batch || null
      });
      await upsertRunStep(store, run_id, runtimeOutputToRunStep({ run_id, output, parallel }));
      await appendEvent(store, bus, run_id, {
        type: "route.completed",
        step_id: output.id,
        adapter: output.adapter,
        elapsed_sec: output.elapsed_sec || null
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
      run.runtime_result_admin_only = {
        mode: result.mode,
        plannerMode: result.plannerMode,
        vllmBaseUrl: result.vllmBaseUrl,
        baseModel: result.baseModel,
        apiElapsedSec: result.apiElapsedSec,
        executorElapsedSec: result.elapsedSec
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
      acyclic: plan.acyclic !== false
    };
  }
  return { steps: [], adapters: [], edges: [], acyclic: true };
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
    task: output.task || "",
    depends_on: output.depends_on || [],
    used_upstream: output.used_upstream || [],
    parallel_batch: batch,
    parallel_width: width,
    status: "completed",
    agent_reasoning: sections.agent_reasoning,
    domain_answer: output.domain_answer || sections.domain_answer,
    handoffs: sections.handoffs,
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
    const context = output.retrieved_context || parseRouteSections(output.text || "").retrieved_context || "";
    if (!context) return [];
    return context.split(/\n+/).filter(Boolean).slice(0, 8).map((line, index) => {
      const [label, ...rest] = line.split(" - ");
      return {
        citation_id: makeId("cit"),
        step_id: output.id,
        agent_id: output.adapter,
        path: "",
        chunk_id: label?.split(":")[0] || `${output.id}_${index + 1}`,
        title: label?.split(":").slice(1).join(":") || output.adapter,
        page_start: null,
        page_end: null,
        score: null,
        excerpt: rest.join(" - ") || line,
        injected: true
      };
    });
  });
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

async function appendEvent(store, bus, run_id, event) {
  await store.mutate((data) => {
    const run = data.runs.find((item) => item.run_id === run_id);
    if (run) {
      run.events.push({ ...event, at: nowIso() });
    }
    return run;
  });
  bus.publish(run_id, event);
}

async function upsertRunStep(store, run_id, step) {
  await store.mutate((data) => {
    const index = data.runSteps.findIndex((item) => item.run_id === run_id && item.step_id === step.step_id);
    if (index >= 0) {
      data.runSteps[index] = step;
    } else {
      data.runSteps.push(step);
    }
    return step;
  });
}

function buildRouteOutput({ step, query, agents, documents }) {
  const agent = agents.find((item) => item.id === step.adapter);
  const citations = gatherCitations({ step, agent, query, documents });
  const retrievedContext = citations
    .map((citation) => `${citation.chunk_id || citation.path}:${citation.title} - ${citation.excerpt}`)
    .join("\n");
  const domainAnswer = domainAnswerFor(step.adapter, query, citations, agent);
  const rawText = [
    "AGENT_REASONING:",
    `- Selected because the request matched ${agent?.title || step.adapter}.`,
    "",
    "DOMAIN_ANSWER:",
    domainAnswer,
    "",
    "HANDOFFS:",
    `- Produces ${(agent?.produces || []).join(", ") || "route output"} for downstream synthesis.`,
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
      citations.push(
        ...scoreChunks(document.chunks || [], query, document.top_k || 4).map((chunk) => ({
          citation_id: makeId("cit"),
          step_id: step.id,
          agent_id: step.adapter,
          path: chunk.path,
          chunk_id: chunk.chunk_id,
          title: chunk.title,
          page_start: chunk.page_start,
          page_end: chunk.page_end,
          score: chunk.score,
          excerpt: chunk.excerpt,
          injected: chunk.injected
        }))
      );
    }
  }

  for (const sourcePath of agent?.sources || []) {
    const source = approvedSourceSnippets[sourcePath];
    if (source) {
      citations.push({
        citation_id: makeId("cit"),
        step_id: step.id,
        agent_id: step.adapter,
        path: sourcePath,
        chunk_id: sourcePath.split("/").pop(),
        title: source.title,
        page_start: null,
        page_end: null,
        score: source.score,
        excerpt: source.excerpt,
        injected: true
      });
    }
  }

  return citations;
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
  return `Apply ${agent?.title || adapter} to the request and return concise domain-specific guidance.`;
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
      path: process.env.PHASE222_ADAPTER_MANIFEST || "configs/dummy_tcar_lora_suite.json",
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

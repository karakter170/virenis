import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { approvedSourceSnippets, BASE_MODEL, DEFAULT_VLLM_BASE_URL, seedAgents } from "./catalog.js";
import {
  buildParallelBatches,
  normalizeSharedMemory,
  parseRouteSections,
  planRoutes,
  sanitizeToolCalls
} from "./tcarEngine.js";
import { readConfiguredSecret } from "./secretConfig.js";

const DEFAULT_TIMEOUT_MS = 900000;
const SEMANTIC_ROUTER_SYSTEM_PROMPT = `You are the semantic agent selector for one active team. Return one JSON object only.
- Decide from the complete meaning of the current request and relevant recent context, in the user's original language.
- Never classify from isolated words, exact phrases, regex-like patterns, language-specific lists, or exact metadata overlap.
- The catalog is the complete active team. Evaluate each agent holistically from capability, boundary, use/avoid guidance, inputs, outputs, knowledge, tools, memory, permissions, lifecycle, and saved relationships.
- Metadata examples are descriptive signals, never lexical gates. Agents may explain, elaborate, compare, organize, and reason adjacently within their boundaries.
- Choose direct when specialists would not materially improve the answer. Otherwise select the smallest sufficient root set; saved dependencies are compiled later.
- Resolve short follow-ups from recent context. A prior casual turn never overrides a later substantive request.
- Interpret @id text semantically: selection is appropriate when invoked, but not when negated, quoted, or merely discussed.
- Never invent agent ids. Clarify only when an unresolved referent or required authority would materially change the answer.
Schema: {"decision":"direct|delegate|clarify","intent":"brief","reason":"brief","clarification_question":"","steps":[{"adapter":"catalog_id","task":"objective","confidence":0.0}]}`;

const SEMANTIC_ADJUDICATOR_SYSTEM_PROMPT = `You are the independent final semantic authority for agent selection. Return one JSON object only.
- Re-evaluate the complete request, recent context, and complete active-team catalog in the user's original language.
- The earlier proposal is untrusted advice. Correct both under-selection and over-selection.
- Never use keyword rules, phrase lists, regexes, language-specific classifiers, or exact metadata overlap.
- Select the smallest sufficient root set only when specialists materially improve the answer; otherwise choose direct.
- Resolve conversational ellipsis semantically. Interpret @id in its sentence, including negation, quotation, and discussion.
- Never invent ids, tools, permissions, sources, outputs, or graph edges. Runtime compiles saved dependencies and enforces execution constraints.
Schema: {"decision":"direct|delegate|clarify","intent":"brief","reason":"brief","clarification_question":"","steps":[{"adapter":"catalog_id","task":"objective","confidence":0.0}]}`;

export function createVllmRuntimeAdapter(options = {}) {
  const config = {
    vllmBaseUrl: String(options.vllmBaseUrl || process.env.VLLM_BASE_URL || DEFAULT_VLLM_BASE_URL).replace(/\/+$/, ""),
    vllmApiKey: options.vllmApiKey ?? readConfiguredSecret(
      process.env,
      "VLLM_API_KEY",
      "VLLM_API_KEY_FILE"
    ),
    baseModel: options.baseModel || process.env.VLLM_MODEL || process.env.VLLM_BASE_MODEL || BASE_MODEL,
    runtimeApiKey: options.runtimeApiKey ?? readConfiguredSecret(
      process.env,
      "TCAR_RUNTIME_API_KEY",
      "TCAR_RUNTIME_API_KEY_FILE"
    ),
    fetchImpl: options.fetchImpl || globalThis.fetch
  };
  if (!config.vllmApiKey) {
    throw new Error("VLLM_API_KEY is required.");
  }

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));
  app.use((req, res, next) => {
    if (config.runtimeApiKey && req.get("X-TCAR-API-Key") !== config.runtimeApiKey) {
      res.status(401).json({ detail: "Unauthorized" });
      return;
    }
    next();
  });

  const vllmRequest = async (endpoint, { method = "GET", body, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await config.fetchImpl(`${config.vllmBaseUrl}/${endpoint.replace(/^\/+/, "")}`, {
        method,
        headers: {
          Authorization: `Bearer ${config.vllmApiKey}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" })
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal
      });
      const text = await response.text();
      let payload = {};
      try {
        payload = text ? JSON.parse(text) : {};
      } catch {
        payload = { raw: text };
      }
      if (!response.ok) {
        const detail = payload.error?.message || payload.detail || response.statusText;
        const error = new Error(`vLLM request failed (${response.status}): ${detail}`);
        error.status = 502;
        throw error;
      }
      return payload;
    } catch (error) {
      if (error.name === "AbortError") {
        const timeout = new Error(`vLLM request timed out after ${timeoutMs}ms.`);
        timeout.status = 504;
        throw timeout;
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };

  const listModels = async () => {
    const raw = await vllmRequest("models", { timeoutMs: 20000 });
    return {
      raw,
      models: Array.isArray(raw.data) ? raw.data.map((model) => ({ ...model, id: model.id })) : []
    };
  };

  app.get("/health", asyncRoute(async (_req, res) => {
    const { models } = await listModels();
    const modelIds = new Set(models.map((model) => model.id));
    const mountedLoras = seedAgents.filter((agent) => modelIds.has(agent.id)).length;
    res.json({
      ok: modelIds.has(config.baseModel),
      service: "tcar-vllm-adapter",
      auth_required: Boolean(config.runtimeApiKey),
      manifest: {
        suite: "dummy_tcar_lora_suite",
        adapters: seedAgents.length,
        active_adapters: mountedLoras,
        archived_adapters: 0,
        valid: mountedLoras === seedAgents.length
      },
      vllm: {
        base_url: config.vllmBaseUrl,
        base_model: config.baseModel,
        models_endpoint_ok: true,
        mounted_loras: mountedLoras,
        mode: "remote vLLM",
        health: { ok: true, status: 200 },
        dynamic_lora_requested: true
      }
    });
  }));

  app.get("/models", asyncRoute(async (_req, res) => {
    const { raw, models } = await listModels();
    res.json({ ok: true, base_model: config.baseModel, models, raw });
  }));

  app.get("/agents", (_req, res) => {
    res.json({ ok: true, agents: seedAgents });
  });

  app.get("/agents/:agentId", (req, res) => {
    const agent = seedAgents.find((item) => item.id === req.params.agentId);
    if (!agent) {
      res.status(404).json({ detail: "Agent not found." });
      return;
    }
    res.json({ ok: true, agent });
  });

  app.post("/chat/execute", asyncRoute(async (req, res) => {
    const query = String(req.body?.query || "").trim();
    if (!query) {
      res.status(400).json({ detail: "query is required." });
      return;
    }
    const options = req.body?.options || {};
    const allowed = Array.isArray(options.allowed_adapters) ? new Set(options.allowed_adapters) : null;
    const authorizedAgents = seedAgents.filter((agent) => agent.enabled !== false && (!allowed || allowed.has(agent.id)));
    const requestedTeam = Array.isArray(options.team_adapters)
      ? [...new Set(options.team_adapters.map((value) => String(value || "").trim()).filter(Boolean))]
      : [];
    const teamSet = requestedTeam.length ? new Set(requestedTeam) : null;
    const agents = teamSet
      ? authorizedAgents.filter((agent) => teamSet.has(agent.id))
      : authorizedAgents;
    if (requestedTeam.some((adapter) => !authorizedAgents.some((agent) => agent.id === adapter))) {
      const error = new Error("The active team contains an unauthorized or unavailable specialist.");
      error.status = 403;
      throw error;
    }
    if (agents.length > 16) {
      const error = new Error("Semantic routing requires an explicit active team when more than 16 specialists are authorized.");
      error.status = 400;
      throw error;
    }
    const workers = boundedInteger(options.parallel_workers, 2, 1, 8);
    const sharedMemory = normalizeSharedMemory(req.body?.shared_memory || []);
    const semantic = await selectAgentsSemantically({
      query,
      agents,
      sharedMemory,
      options,
      config,
      vllmRequest
    });
    const plan = planRoutes({
      query,
      agents,
      semanticSelections: semantic.steps,
      maxRoutingAdapters: boundedInteger(options.max_routing_adapters, 16, 1, 16)
    });
    const parallel = buildParallelBatches(plan.steps, workers);
    const outputsById = new Map();
    const expertOutputs = [];
    const startedAt = Date.now();

    for (const batch of parallel.batches) {
      const steps = plan.steps.filter((step) => batch.steps.includes(step.id));
      const outputs = await mapConcurrent(steps, workers, (step) => executeRoute({
        step,
        query,
        agents,
        sharedMemory,
        outputsById,
        batch,
        options,
        vllmRequest
      }));
      for (const output of outputs) {
        outputsById.set(output.id, output);
        expertOutputs.push(output);
      }
    }

    const fallbackFinalAnswer = expertOutputs.find((output) => output.adapter === "writing_synthesis_lora")?.domain_answer
      || expertOutputs.at(-1)?.domain_answer
      || "";
    const finalAnswer = semantic.decision === "clarify" && semantic.clarification_question
      ? semantic.clarification_question
      : await synthesizeAnswer({
        query,
        sharedMemory,
        expertOutputs,
        options,
        config,
        vllmRequest
      });
    const elapsedSec = secondsSince(startedAt);
    res.json({
      ok: true,
      mode: "tcar_dag_vllm_execute",
      plannerMode: "session",
      query,
      vllmBaseUrl: config.vllmBaseUrl,
      baseModel: config.baseModel,
      plan: {
        steps: plan.steps,
        adapters: plan.steps.map((step) => step.adapter),
        edges: plan.steps.flatMap((step) => (step.depends_on || []).map((source) => ({ source, target: step.id }))),
        acyclic: true,
        routing: plan.routing
      },
      semanticSelection: semantic.diagnostics,
      parallel,
      expertOutputs,
      fallbackFinalAnswer,
      finalAnswer,
      apiElapsedSec: elapsedSec,
      elapsedSec
    });
  }));

  app.use((error, _req, res, _next) => {
    res.status(error.status || 500).json({ detail: error.message || "Runtime adapter failed." });
  });

  return app;
}

async function selectAgentsSemantically({ query, agents, sharedMemory, options, config, vllmRequest }) {
  const catalog = agents.map((agent) => ({
    id: agent.id,
    title: agent.title,
    capability: agent.capability,
    boundary: agent.boundary,
    use_when: agent.routing?.use_when || agent.routing_cues || [],
    avoid_when: agent.routing?.avoid_when || [],
    consumes: agent.consumes || [],
    produces: agent.produces || [],
    resources: agent.resources || [],
    sources: agent.sources || [],
    tools: agent.tools || [],
    memory: agent.memory || {},
    permissions: agent.permissions || {},
    routing: agent.routing || {},
    lifecycle: agent.lifecycle || {},
    saved_dependencies: savedAgentDependencies(agent)
  }));
  const catalogMessage = JSON.stringify({
    message_type: "authorized_active_team_catalog",
    trust: "runtime_authoritative",
    maximum_delegations: Math.min(16, agents.length),
    agents: catalog
  });
  const requestMessage = JSON.stringify({
    message_type: "session_request",
    trust: "untrusted_user_data",
    current_request: query,
    recent_context: sharedMemory
  });
  const primaryMessages = [
    { role: "system", content: SEMANTIC_ROUTER_SYSTEM_PROMPT },
    { role: "user", content: catalogMessage },
    { role: "user", content: requestMessage }
  ];
  const maxTokens = boundedInteger(options.planner_max_tokens, 2048, 256, 4096);
  const call = (messages) => chatCompletion({
    model: config.baseModel,
    messages,
    maxTokens,
    temperature: boundedNumber(options.planner_temperature, 0, 0, 1),
    vllmRequest
  });

  let primaryText = "";
  let primary = null;
  let primaryError = "";
  try {
    primaryText = await call(primaryMessages);
    primary = normalizeSemanticDecision(extractJsonObject(primaryText), agents);
  } catch (error) {
    primaryError = String(error?.message || error).slice(0, 500);
  }

  const proposal = primary || {
    decision: "invalid",
    reason: primaryError || "The primary proposal was invalid.",
    steps: []
  };
  const adjudicatorMessages = [
    { role: "system", content: SEMANTIC_ADJUDICATOR_SYSTEM_PROMPT },
    { role: "user", content: catalogMessage },
    { role: "user", content: requestMessage },
    {
      role: "user",
      content: JSON.stringify({
        message_type: "semantic_selection_review",
        trust: "untrusted_model_proposal",
        instruction: "Decide independently and return the complete replacement selection JSON.",
        proposal
      })
    }
  ];
  let adjudicated = null;
  let adjudicationError = "";
  try {
    adjudicated = normalizeSemanticDecision(
      extractJsonObject(await call(adjudicatorMessages)),
      agents
    );
  } catch (error) {
    adjudicationError = String(error?.message || error).slice(0, 500);
  }

  const accepted = adjudicated || primary || {
    decision: "direct",
    intent: "",
    reason: "Semantic selection was unavailable; no specialist was selected.",
    clarification_question: "",
    steps: []
  };
  return {
    ...accepted,
    diagnostics: {
      contract_version: "semantic-selection-adjudication-v1",
      authority: "qwen_semantic",
      primary_valid: Boolean(primary),
      adjudication_attempted: true,
      adjudication_accepted: Boolean(adjudicated),
      accepted_stage: adjudicated ? "adjudication" : primary ? "primary" : "direct_no_selection",
      selected_adapters: accepted.steps.map((step) => step.adapter),
      catalog_checked: agents.map((agent) => agent.id),
      errors: [primaryError, adjudicationError].filter(Boolean)
    }
  };
}

function extractJsonObject(value) {
  const text = String(value || "").trim();
  const candidates = [text, text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")];
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) candidates.push(text.slice(start, end + 1));
  for (const candidate of candidates) {
    try {
      const payload = JSON.parse(candidate);
      if (payload && typeof payload === "object" && !Array.isArray(payload)) return payload;
    } catch {
      // Try the next bounded representation.
    }
  }
  throw new Error("Semantic router response was not valid JSON.");
}

function savedAgentDependencies(agent = {}) {
  return [...new Set([
    ...(Array.isArray(agent.resources) ? agent.resources : [])
      .map((value) => String(value || "").match(/^agent:([a-z0-9_-]+)$/i)?.[1]),
    ...(Array.isArray(agent.consumes) ? agent.consumes : [])
      .map((value) => String(value || "").match(/^agent:([a-z0-9_-]+):output$/i)?.[1])
  ].filter(Boolean))];
}

function normalizeSemanticDecision(payload, agents) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Semantic router response must be an object.");
  }
  const allowed = new Set(agents.map((agent) => agent.id));
  let decision = String(payload.decision || "").trim().toLowerCase();
  if (!new Set(["direct", "delegate", "clarify"]).has(decision)) {
    throw new Error("Semantic router decision is invalid.");
  }
  const rows = Array.isArray(payload.steps) ? payload.steps : [];
  const steps = [];
  const seen = new Set();
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const adapter = String(row.adapter || row.agent_id || "").trim();
    if (!adapter || seen.has(adapter)) continue;
    if (!allowed.has(adapter)) throw new Error(`Semantic router invented unavailable specialist ${adapter}.`);
    seen.add(adapter);
    steps.push({
      adapter,
      task: String(row.task || "Apply this specialist's declared capability to the complete request.").trim().slice(0, 600),
      confidence: boundedNumber(row.confidence, null, 0, 1),
      reason: String(row.reason || payload.reason || "Selected by semantic Qwen.").trim().slice(0, 500)
    });
  }
  if (steps.length > Math.min(16, agents.length)) {
    throw new Error("Semantic router selected more specialists than the active-team limit.");
  }
  if (decision === "delegate" && !steps.length) {
    throw new Error("Semantic router delegated without selecting a specialist.");
  }
  if (decision !== "delegate") steps.length = 0;
  return {
    decision,
    intent: String(payload.intent || "").trim().slice(0, 600),
    reason: String(payload.reason || "").trim().slice(0, 1000),
    clarification_question: decision === "clarify"
      ? String(payload.clarification_question || "").trim().slice(0, 1000)
      : "",
    steps
  };
}

async function executeRoute({ step, query, agents, sharedMemory, outputsById, batch, options, vllmRequest }) {
  const startedAt = Date.now();
  const agent = agents.find((item) => item.id === step.adapter);
  if (!agent) {
    const error = new Error(`Unknown or unavailable route: ${step.adapter}`);
    error.status = 400;
    throw error;
  }
  const upstream = (step.depends_on || []).map((id) => outputsById.get(id)).filter(Boolean);
  const retrievedContext = (agent.sources || [])
    .map((sourcePath) => {
      const source = approvedSourceSnippets[sourcePath];
      return source ? `${sourcePath}:${source.title} - ${source.excerpt}` : "";
    })
    .filter(Boolean)
    .join("\n");
  const prompt = routePrompt({ agent, step, query, sharedMemory, upstream, retrievedContext });
  const rawText = await chatCompletion({
    model: agent.id,
    messages: [{ role: "user", content: prompt }],
    maxTokens: boundedInteger(options.max_tokens, 4096, 32, 8192),
    temperature: boundedNumber(options.temperature, 0, 0, 2),
    vllmRequest
  });
  const sanitized = sanitizeToolCalls(rawText, agent.tools || []);
  const sections = parseRouteSections(sanitized.text);
  return {
    id: step.id,
    step_id: step.id,
    adapter: step.adapter,
    task: step.task,
    depends_on: step.depends_on || [],
    used_upstream: step.depends_on || [],
    parallel_batch: batch.batch,
    parallel_width: batch.width,
    text: sanitized.text,
    raw_text: sanitized.text,
    prompt_preview: prompt.slice(0, 2000),
    agent_reasoning: sections.agent_reasoning,
    domain_answer: sections.domain_answer || sanitized.text,
    handoffs: sections.handoffs,
    boundary_check: sections.boundary_check || agent.boundary,
    retrieved_context: retrievedContext,
    allowed_tools: agent.tools || [],
    approved_sources: agent.sources || [],
    policy_violations: sanitized.violations,
    elapsed_sec: secondsSince(startedAt)
  };
}

async function synthesizeAnswer({ query, sharedMemory, expertOutputs, options, config, vllmRequest }) {
  const routeContext = expertOutputs
    .map((output) => `[${output.adapter}]\n${output.domain_answer}\nBoundary: ${output.boundary_check}`)
    .join("\n\n");
  return chatCompletion({
    model: config.baseModel,
    messages: [
      {
        role: "system",
        content: "Synthesize the specialist outputs into one direct, useful answer. Preserve important boundaries and uncertainty. Do not mention routing internals or provide hidden reasoning."
      },
      {
        role: "user",
        content: [
          `User request:\n${query}`,
          sharedMemory.length ? `Conversation memory:\n${JSON.stringify(sharedMemory)}` : "",
          `Specialist outputs:\n${routeContext}`,
          "Return only the final answer."
        ].filter(Boolean).join("\n\n")
      }
    ],
    maxTokens: boundedInteger(options.refiner_max_tokens, 8192, 64, 12288),
    temperature: boundedNumber(options.temperature, 0, 0, 2),
    vllmRequest
  });
}

function routePrompt({ agent, step, query, sharedMemory, upstream, retrievedContext }) {
  return [
    `You are the ${agent.title} specialist route.`,
    `Capability: ${agent.capability}`,
    `Boundary: ${agent.boundary}`,
    `Task: ${step.task}`,
    `User request: ${query}`,
    sharedMemory.length ? `Conversation memory: ${JSON.stringify(sharedMemory)}` : "",
    upstream.length ? `Upstream route outputs:\n${upstream.map((output) => `[${output.adapter}] ${output.domain_answer}`).join("\n")}` : "",
    retrievedContext ? `Approved source context:\n${retrievedContext}` : "Approved source context: none.",
    "Return exactly these four sections. Keep AGENT_REASONING to one brief, visible rationale sentence and do not reveal hidden chain-of-thought:\nAGENT_REASONING:\nDOMAIN_ANSWER:\nHANDOFFS:\nBOUNDARY_CHECK:"
  ].filter(Boolean).join("\n\n");
}

async function chatCompletion({ model, messages, maxTokens, temperature, vllmRequest }) {
  const payload = await vllmRequest("chat/completions", {
    method: "POST",
    body: {
      model,
      messages,
      max_tokens: maxTokens,
      temperature,
      chat_template_kwargs: { enable_thinking: false }
    }
  });
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    const error = new Error(`vLLM returned no content for model ${model}.`);
    error.status = 502;
    throw error;
  }
  return content.trim();
}

async function mapConcurrent(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index]);
    }
  }));
  return results;
}

function boundedInteger(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function boundedNumber(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function secondsSince(startedAt) {
  return Number(((Date.now() - startedAt) / 1000).toFixed(3));
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const host = process.env.TCAR_RUNTIME_HOST || "127.0.0.1";
  const port = Number(process.env.TCAR_RUNTIME_PORT || 9000);
  const app = createVllmRuntimeAdapter();
  const server = app.listen(port, host, () => {
    console.log(`TCAR vLLM adapter listening on http://${host}:${port}`);
  });
  const shutdown = () => server.close(() => process.exit(0));
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

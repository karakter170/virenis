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

const DEFAULT_TIMEOUT_MS = 900000;

export function createVllmRuntimeAdapter(options = {}) {
  const config = {
    vllmBaseUrl: String(options.vllmBaseUrl || process.env.VLLM_BASE_URL || DEFAULT_VLLM_BASE_URL).replace(/\/+$/, ""),
    vllmApiKey: options.vllmApiKey ?? process.env.VLLM_API_KEY,
    baseModel: options.baseModel || process.env.VLLM_MODEL || process.env.VLLM_BASE_MODEL || BASE_MODEL,
    runtimeApiKey: options.runtimeApiKey ?? process.env.TCAR_RUNTIME_API_KEY,
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
    const agents = seedAgents.filter((agent) => agent.enabled !== false && (!allowed || allowed.has(agent.id)));
    const plan = planRoutes({ query, agents });
    const workers = boundedInteger(options.parallel_workers, 2, 1, 8);
    const parallel = buildParallelBatches(plan.steps, workers);
    const sharedMemory = normalizeSharedMemory(req.body?.shared_memory || []);
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
    const finalAnswer = await synthesizeAnswer({
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
      plannerMode: "cue",
      query,
      vllmBaseUrl: config.vllmBaseUrl,
      baseModel: config.baseModel,
      plan: {
        steps: plan.steps,
        adapters: plan.steps.map((step) => step.adapter),
        edges: plan.steps.flatMap((step) => (step.depends_on || []).map((source) => ({ source, target: step.id }))),
        acyclic: true
      },
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
    maxTokens: boundedInteger(options.max_tokens, 160, 32, 4096),
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
    maxTokens: boundedInteger(options.refiner_max_tokens, 512, 64, 8192),
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

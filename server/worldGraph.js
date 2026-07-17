import crypto from "node:crypto";
import { assertStoredDocumentIntegrity } from "./documents.js";
import { agentRevision, normalizeSha256Digest } from "./outcomes.js";
import { runtimeApiKey } from "./runtimeClient.js";
import { makeId, nowIso } from "./store.js";

export const WORLD_GRAPH_SCHEMA_VERSION = "virenis-world-graph-v1";
export const WORLD_GRAPH_ENGINE_REVISION = "world-graph-engine-v5";

const WORLD_GRAPH_DIGEST_DOMAIN = "worldgraph-digest-v2\n";
const WORLD_GRAPH_CAPSULE_ENCODING = "json-utf8-exact-v1";
const WORLD_GRAPH_CAPSULE_SIGNATURE_DOMAIN = "worldgraph-reuse-envelope-v2\n";
const WORLD_GRAPH_ARTIFACT_MAC_DOMAIN = "worldgraph-artifact-record-v1\n";
const WORLD_GRAPH_EVENT_MAC_DOMAIN = "worldgraph-contest-event-v1\n";
const replayCapsulePayloads = new WeakMap();

const MAX_ARTIFACTS_PER_OWNER = 240;
const MAX_EVENTS_PER_OWNER = 500;
const MAX_REPLAY_BYTES = 128 * 1024;
const MAX_CAPSULE_BYTES = 2 * 1024 * 1024;
const STORAGE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const REMOTE_MAX_AGE_MS = 30 * 60 * 1000;
const STRONG_FRESHNESS_QUERY = /\b(?:currently|today|tonight|latest|right\s+now|at\s+the\s+moment|as\s+of\s+(?:today|now)|this\s+(?:week|month|quarter|year)|recently|most\s+recent)\b/i;
const FACTUAL_RELATIVE_EVENT_QUERY = /\b(?:last\s+night(?:['’]s)?|yesterday(?:['’]s)?|tomorrow(?:['’]s)?|this\s+(?:morning|afternoon|evening|weekend)(?:['’]s)?)\b.{0,60}\b(?:game|match|election|vote|poll|result|score|weather|forecast|traffic|news|headline|earnings|market|price|outage|incident|release|schedule|flight|train|bus|coach|ferry|tram|subway|metro|departure|arrival)\b|\b(?:game|match|election|vote|poll|result|score|weather|forecast|traffic|news|headline|earnings|market|price|outage|incident|release|schedule|flight|train|bus|coach|ferry|tram|subway|metro|departure|arrival)\b.{0,60}\b(?:last\s+night|yesterday|tomorrow|this\s+(?:morning|afternoon|evening|weekend))\b/i;
const HISTORICAL_CHANGE_QUERY = /\b(?:change(?:d|s)?|different|difference|evolve(?:d|s)?|evolution|develop(?:ed|s)?|progress(?:ed|ion)?|update(?:d|s)?|new)\b.{0,60}\bsince\s+(?:19|20)\d{2}\b|\bsince\s+(?:19|20)\d{2}\b.{0,80}\b(?:change(?:d|s)?|different|difference|evolve(?:d|s)?|evolution|develop(?:ed|s)?|progress(?:ed|ion)?|update(?:d|s)?|new|today|now|current|latest)\b|\bas\s+of\s+(?:19|20)\d{2}\b.{0,100}\b(?:what|how)\b.{0,40}\b(?:change(?:d|s)?|different|evolve(?:d|s)?|develop(?:ed|s)?|progress(?:ed)?|update(?:d|s)?)\b|\b(?:compare|comparison|difference|versus|vs\.?).{0,80}\b(?:19|20)\d{2}\b.{0,80}\b(?:today|now|current|latest)\b/i;
const CONTEXTUAL_FRESHNESS_QUERY = /\bnewest\s+(?:stable\s+)?(?:version|release|node(?:\.js)?|python|java|go|rust|npm|runtime|framework|library|package|sdk|api|browser|operating\s+system|model)\b|\bcurrent\b.{0,80}\b(?:president|prime\s+minister|ceo|mayor|governor|leader|office[- ]?holder|weather|forecast|price|cost|value|exchange\s+rate|share|stock\s+price|score|standings|news|sales|market\s+share|version|release|status|availability|traffic|delay|departure|arrival)\b|\bwho\s+is\b.{0,80}\b(?:president|prime\s+minister|ceo|mayor|governor|leader|office[- ]?holder)\b|\b(?:what(?:'s|\s+is)|tell\s+me|give\s+me|show\s+me|check|find|get)\b.{0,80}\b(?:weather|forecast|price|cost|exchange\s+rate|share\s+price|stock\s+price|score|standings|news\s+headlines?|current\s+version|traffic|transit\s+status)\b|\bhow\s+much\b.{0,100}\b(?:cost|worth|price)\b|\b(?:EUR|USD|GBP|JPY|TRY|CAD|AUD)[ /-](?:EUR|USD|GBP|JPY|TRY|CAD|AUD)\b.{0,40}\b(?:rate|value|quote)?\b|\b(?:share|stock)\s+(?:price|value|quote)\b|\bexchange\s+rate\b|\bwhen\s+is\b.{0,100}\bnext\b.{0,80}\b(?:earnings|call|release|event)\b|\bnext\s+(?:train|bus|coach|flight|ferry|tram|subway|metro|departure|arrival)\b|\b(?:is|are)\s+(?:(?:the|my|our|your)\s+)?(?:gmail|google|github|slack|shopify|salesforce|stripe|notion|dropbox|zoom|jira|confluence|teams|outlook|icloud|aws|azure|cloudflare|openai|chatgpt|anthropic|claude|service|website|site|api|server|platform|app)(?:\s+service)?\s+(?:currently\s+)?(?:working|up|available|reachable|operational|down|offline)\b|\b(?:gmail|google|github|slack|shopify|salesforce|stripe|notion|dropbox|zoom|jira|confluence|teams|outlook|icloud|aws|azure|cloudflare|openai|chatgpt|anthropic|claude|service|website|site|api|server|platform|app)(?:\s+service)?\s+(?:is|are)\s+(?:currently\s+)?(?:working|up|available|reachable|operational|down|offline)\b|\bis\b.{0,80}\b(?:down|offline|operational)\b|\b(?:live|real[- ]?time)\b.{0,50}\b(?:data|status|result|score|price|quote|traffic|weather|feed)\b|\b(?:last\s+night(?:['’]s)?|yesterday(?:['’]s)?|tomorrow(?:['’]s)?)\b.{0,60}\b(?:game|match|election|vote|poll|result|score|weather|forecast|traffic|news|headline|earnings|market|price|outage|incident|release|schedule)\b|\b(?:game|match|election|vote|poll|result|score|weather|forecast|traffic|news|headline|earnings|market|price|outage|incident|release|schedule)\b.{0,60}\b(?:last\s+night|yesterday|tomorrow)\b/i;
const MULTILINGUAL_VOLATILE_QUERY = /(?<!\p{L})(?:güncel|bugün|bugünkü|yarın|şu\s*anda|en\s*son|gerçek\s*zamanlı|ne\s+kadar|cumhurbaşkanı\s+kim|actualmente|hoy|ahora|reciente|aujourd'hui|maintenant|dernier|aktuell|heute|jetzt|neueste|hoje|agora|últim[oa]|hari\s+ini|sekarang|terbaru|сегодня|сейчас|последние|последний|последняя|اليوم|الآن|أحدث|今天|现在|最新|实时|今日|現在|リアルタイム|오늘|현재|최신|실시간)(?!\p{L})/iu;
const FRESHNESS_FALSE_SENSE = /\b(?:score\s+(?:this|the)\s+(?:essay|answer|response)|breaking\s+changes?|real[- ]?time\s+(?:chat|system|architecture|application)|live\s+(?:music|concert|event)|stock\s+management|inventory\s+stock|news\s+article\s+(?:I\s+|we\s+)?(?:pasted|provided|attached)|(?:yesterday|tomorrow|last\s+night).{0,50}(?:poem|theme|story|sentence)|(?:poem|theme|story|sentence).{0,50}(?:yesterday|tomorrow|last\s+night)|tiempo\s+verbal)\b/gis;
const VOLATILE_TOOLS = new Set([
  "web_search", "market_data", "earthquake_feed", "document_search", "document_read",
  "search_index", "policy_lookup", "news_search", "weather", "http_get", "url_fetch",
  "browser", "repo_inspector", "repo_search", "repo_read", "repo_diff", "repo_patch",
  "test_runner"
]);
// Availability of these tools is input-complete and deterministic. Their
// actual receipts are still never replayed in v1. Every unknown/dynamic tool
// is treated as mutable so a newly added integration fails closed by default.
const REPLAY_SAFE_TOOL_AVAILABILITY = new Set([
  "calculator", "finance_calculator", "math_solver", "data_table", "sql_runner",
  "document_search", "document_read", "search_index", "policy_lookup"
]);
const EFFECTFUL_TOOL = /^(?:mcp_|gmail|shopify|send_|delete_|create_|update_|publish_|purchase_|write_)/i;

function assertUnicodeScalarString(value) {
  const text = String(value);
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new TypeError("Work-reuse strings must contain valid Unicode scalar values.");
      }
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new TypeError("Work-reuse strings must contain valid Unicode scalar values.");
    }
  }
  return text;
}

function binary64Hex(value) {
  if (!Number.isFinite(value)) {
    throw new TypeError("Work-reuse numbers must be finite IEEE-754 binary64 values.");
  }
  const bytes = Buffer.allocUnsafe(8);
  bytes.writeDoubleBE(value === 0 ? 0 : value, 0);
  return bytes.toString("hex");
}

function utf8KeyCompare(left, right) {
  return Buffer.compare(
    Buffer.from(assertUnicodeScalarString(left), "utf8"),
    Buffer.from(assertUnicodeScalarString(right), "utf8")
  );
}

function worldGraphCanonicalValue(value) {
  if (value === null || value === undefined) return ["null"];
  if (typeof value === "boolean") return ["boolean", value ? "true" : "false"];
  if (typeof value === "string") return ["string", assertUnicodeScalarString(value)];
  if (typeof value === "number") return ["number_binary64", binary64Hex(value)];
  if (Array.isArray(value)) return ["array", value.map(worldGraphCanonicalValue)];
  if (typeof value === "object") {
    const entries = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort(utf8KeyCompare)
      .map((key) => [assertUnicodeScalarString(key), worldGraphCanonicalValue(value[key])]);
    return ["object", entries];
  }
  throw new TypeError(`Work-reuse value has unsupported type: ${typeof value}.`);
}

export function worldGraphCanonicalJson(value) {
  return JSON.stringify(worldGraphCanonicalValue(value));
}

export function worldGraphDigest(value) {
  return `sha256:${crypto.createHash("sha256")
    .update(WORLD_GRAPH_DIGEST_DOMAIN, "utf8")
    .update(worldGraphCanonicalJson(value), "utf8")
    .digest("hex")}`;
}

function normalizedStrings(value) {
  return Array.isArray(value)
    ? [...new Set(value.map((item) => String(item || "").trim()).filter(Boolean))].sort()
    : [];
}

function normalizedQuery(value) {
  // The persisted user message is already outer-trimmed. Preserve every
  // internal code point: indentation, line breaks, table spacing, and quoted
  // whitespace can all change the meaning of a request.
  return String(value || "");
}

function normalizedTask(value) {
  return String(value || "").replaceAll("\0", "");
}

function boundedText(value, maximum = 4000) {
  return String(value || "").replaceAll("\0", "").trim().slice(0, maximum);
}

function scopeFor({ run, session }) {
  return {
    workspace_id: String(run?.workspace_id || session?.workspace_id || ""),
    created_by: String(run?.created_by || session?.created_by || ""),
    session_id: String(run?.session_id || session?.session_id || ""),
    agent_workspace_id: String(run?.agent_workspace_id || session?.agent_workspace_id || "")
  };
}

function sameScope(artifact, scope) {
  return artifact.workspace_id === scope.workspace_id
    && artifact.created_by === scope.created_by
    && artifact.session_id === scope.session_id
    && artifact.agent_workspace_id === scope.agent_workspace_id;
}

function sourceStateForAgent(agent, documents) {
  const documentStates = (documents || [])
    .filter((document) => document.agent_id === agent?.id || document.resource_for_agent_id === agent?.id)
    .map((document) => ({
      corpus_revision: normalizeSha256Digest(document.corpus_revision),
      index_digest: normalizeSha256Digest(document.index_digest),
      enabled: document.enabled !== false,
      runtime_sync_pending: document.runtime_sync_pending === true,
      integrity: documentIntegrityState(document)
    }))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return {
    sources: normalizedStrings(agent?.sources),
    retrieval: agent?.retrieval || null,
    private_knowledge_digest: normalizeSha256Digest(agent?.private_knowledge_digest)
      || (agent?.source_text_internal ? worldGraphDigest(agent.source_text_internal) : null),
    documents: documentStates
  };
}

function documentIntegrityState(document) {
  const committedDocument = Object.hasOwn(document || {}, "runtime_managed")
    || Object.hasOwn(document || {}, "chunks");
  if (!committedDocument) return "metadata_only";
  try {
    assertStoredDocumentIntegrity(document);
    return "verified";
  } catch {
    return "failed";
  }
}

function sourceStateReplayable(agent, documents) {
  const state = sourceStateForAgent(agent, documents);
  const staticSourcesAreBound = state.sources.length === 0
    || Boolean(state.private_knowledge_digest)
    || state.documents.length > 0;
  return staticSourcesAreBound && state.documents.every((document) => (
    (
      document.integrity === "verified"
      || (
        document.integrity === "metadata_only"
        && Boolean(document.corpus_revision)
        && Boolean(document.index_digest)
      )
    )
    && document.enabled === true
    && document.runtime_sync_pending === false
  ));
}

function routeOptionState(options = {}) {
  return {
    max_tokens: Number(options.max_tokens) || null,
    temperature: Number(options.temperature) || 0,
    required_adapters: normalizedStrings(options.required_adapters)
  };
}

function normalizedRuntimeComponentState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const baseModelContentDigest = normalizeSha256Digest(value.base_model_content_digest || value.baseModelContentDigest);
  const executorCodeDigest = normalizeSha256Digest(value.executor_code_digest || value.executorCodeDigest);
  const workerExecutionConfigDigest = normalizeSha256Digest(
    value.worker_execution_config_digest || value.workerExecutionConfigDigest
  );
  if (!baseModelContentDigest || !executorCodeDigest || !workerExecutionConfigDigest) return null;
  return {
    revision_authority: "runtime",
    base_model_id: boundedText(value.base_model_id || value.baseModel || "", 300),
    base_model_content_digest: baseModelContentDigest,
    executor_code_digest: executorCodeDigest,
    worker_execution_config_digest: workerExecutionConfigDigest
  };
}

function memoryState(agent, sharedMemory) {
  const consumes = new Set(normalizedStrings(agent?.consumes));
  if (!consumes.has("shared_memory") && !consumes.has("conversation_context")) {
    return null;
  }
  return (Array.isArray(sharedMemory) ? sharedMemory : []).map((entry) => ({
    tag: boundedText(entry?.tag || "memory", 120),
    source: boundedText(entry?.source || "application", 120),
    content: boundedText(entry?.content, 2000)
  }));
}

function exactRepeatAntecedentMemory(query, sharedMemory) {
  const rows = Array.isArray(sharedMemory) ? sharedMemory : [];
  const target = String(query || "").replace(/\s+/g, " ").trim();
  let cut = rows.length;
  let rewound = false;
  while (cut > 0) {
    let latestUserIndex = -1;
    for (let index = cut - 1; index >= 0; index -= 1) {
      if (String(rows[index]?.tag || "").trim() === "user_request") {
        latestUserIndex = index;
        break;
      }
    }
    if (latestUserIndex < 0) break;
    const priorQuery = String(rows[latestUserIndex]?.content || "").replace(/\s+/g, " ").trim();
    if (priorQuery !== target) break;
    cut = latestUserIndex;
    rewound = true;
  }
  return rewound ? rows.slice(0, cut) : rows;
}

function dependencyState(step, outputsByStep) {
  return normalizedStrings(step?.depends_on).map((stepId) => {
    const output = outputsByStep.get(stepId);
    // Dependency identity must be computed from the same bounded replay
    // representation that is persisted as an artifact.  Fresh runtime
    // outputs can carry additional, non-replay metadata while reused outputs
    // are already replay-shaped; hashing the raw objects made an unchanged
    // upstream result appear different on the next run.
    const canonicalReplay = replayOutput({
      ...output,
      id: output?.id || output?.step_id || stepId,
      step_id: output?.step_id || output?.id || stepId
    });
    const valid = validRouteOutput(canonicalReplay);
    return {
      step_id: stepId,
      adapter: canonicalReplay?.adapter || output?.adapter || null,
      output_digest: valid
        ? outputDigest(canonicalReplay)
        : worldGraphDigest({ invalid_dependency: stepId, observed_output: outputDigest(output) })
    };
  });
}

function queryRequestsFreshInformation(query, task = "") {
  const rawValue = `${String(query || "")} ${String(task || "")}`
    .replace(/\s+/g, " ")
    .trim();
  const value = rawValue.replace(FRESHNESS_FALSE_SENSE, " ");
  return FACTUAL_RELATIVE_EVENT_QUERY.test(rawValue)
    || HISTORICAL_CHANGE_QUERY.test(rawValue)
    || STRONG_FRESHNESS_QUERY.test(value)
    || CONTEXTUAL_FRESHNESS_QUERY.test(value)
    || MULTILINGUAL_VOLATILE_QUERY.test(value);
}

function effectPolicy({ query, task = "", evidenceRequirement = "", agent, output = null }) {
  const allowedTools = normalizedStrings(agent?.tools || output?.allowed_tools);
  const executions = Array.isArray(output?.tool_executions) ? output.tool_executions : [];
  const executedNames = executions.map((item) => String(item?.name || "")).filter(Boolean);
  const reasons = [];
  const agentIdentity = [agent?.id, agent?.title, ...(agent?.routing_cues || [])].join(" ").toLowerCase();
  const queryText = String(query || "");
  const volatileSubject = queryText.toLowerCase().match(/\b(weather|price|stock|score|news|current|latest|live|recent)\b/)?.[1];
  const mutableToolAvailable = allowedTools.some((tool) => !REPLAY_SAFE_TOOL_AVAILABILITY.has(tool));
  const evidenceClass = String(evidenceRequirement || "").trim().toLowerCase();
  const explicitlyTimeSensitive = evidenceClass === "live_external"
    || queryRequestsFreshInformation(queryText, task);
  // A session controller marks uncertain external-state work explicitly. A
  // mutable-tool route then fails closed without a second classifier/model
  // call; stable or supplied-context work remains reusable.
  const languageFreshnessUnknown = evidenceClass === "unknown" && mutableToolAvailable;
  if (
    (explicitlyTimeSensitive || languageFreshnessUnknown)
    && (
      mutableToolAvailable
      || allowedTools.some((tool) => VOLATILE_TOOLS.has(tool))
      || (volatileSubject && agentIdentity.includes(volatileSubject))
    )
  ) reasons.push("time_sensitive_request");
  if (executedNames.some((tool) => VOLATILE_TOOLS.has(tool))) reasons.push("live_or_mutable_tool_used");
  if (executedNames.some((tool) => EFFECTFUL_TOOL.test(tool))) reasons.push("external_or_effectful_tool_used");
  if (executions.some((execution) => execution?.result?.approval_required === true)) reasons.push("approval_bound_action");
  if (executions.length && !reasons.includes("tool_result_requires_fresh_execution")) {
    // V1 intentionally does not replay even deterministic tool receipts. A
    // future revision may opt specific tools in after binding implementation,
    // arguments, and output digests at both the web and runtime boundaries.
    reasons.push("tool_result_requires_fresh_execution");
  }
  return {
    class: reasons.some((reason) => reason.includes("effectful") || reason.includes("approval"))
      ? "effectful"
      : reasons.length ? "volatile" : "pure",
    replayable: reasons.length === 0,
    reasons
  };
}

function replayPolicy({ query, task = "", evidenceRequirement = "", agent, output = null, documents = [] }) {
  const policy = effectPolicy({ query, task, evidenceRequirement, agent, output });
  if (!sourceStateReplayable(agent, documents)) {
    policy.class = "volatile";
    policy.replayable = false;
    policy.reasons = [...new Set([...policy.reasons, "source_changed_or_unverifiable"])];
  }
  return policy;
}

function outputDigest(output = {}) {
  return worldGraphDigest({
    adapter: output.adapter || "",
    domain_answer: output.domain_answer || "",
    handoff_artifacts: output.handoff_artifacts || [],
    citations: output.citations || [],
    policy_violations: output.policy_violations || [],
    artifact_validation: output.artifact_validation || {},
    consumption_validation: output.consumption_validation || {},
    source_validation: output.source_validation || {}
  });
}

function replayOutput(output = {}) {
  const safeToolReceipts = (Array.isArray(output.tool_executions) ? output.tool_executions : []).map((execution) => ({
    id: boundedText(execution?.id, 120),
    name: boundedText(execution?.name, 120),
    result: {
      ok: execution?.result?.ok === true,
      available: execution?.result?.available !== false,
      tool: boundedText(execution?.result?.tool || execution?.name, 120),
      data_digest: execution?.result?.data === undefined ? null : worldGraphDigest(execution.result.data)
    },
    arguments_redacted: true,
    result_data_redacted: true
  }));
  const safe = {
    id: output.id || output.step_id,
    step_id: output.step_id || output.id,
    adapter: output.adapter,
    task: output.task || "",
    depends_on: output.depends_on || [],
    used_upstream: output.used_upstream || [],
    used_memory: output.used_memory || [],
    policy_violations: output.policy_violations || [],
    knowledge_mode: output.knowledge_mode,
    missing_data_policy: output.missing_data_policy,
    constraint_mode: output.constraint_mode,
    allowed_tools: output.allowed_tools || [],
    tool_executions: safeToolReceipts,
    approved_sources: output.approved_sources || [],
    retrieved_context: output.retrieved_context || "",
    citations: output.citations || [],
    source_validation: output.source_validation || {},
    handoff_artifacts: output.handoff_artifacts || [],
    artifact_validation: output.artifact_validation || {},
    consumed_artifacts: output.consumed_artifacts || [],
    consumption_validation: output.consumption_validation || {},
    text: output.domain_answer ? `DOMAIN_ANSWER:\n${output.domain_answer}` : "",
    domain_answer: output.domain_answer || "",
    boundary_check: output.boundary_check || "",
    agent_revision: normalizeSha256Digest(output.agent_revision),
    agent_content_digest: normalizeSha256Digest(output.agent_content_digest || output.adapter_digest),
    adapter_content_digest: normalizeSha256Digest(output.adapter_content_digest || output.adapter_digest),
    manifest_contract_digest: normalizeSha256Digest(output.manifest_contract_digest),
    model_id: output.model_id || output.vllmModel || null,
    vllmModel: output.vllmModel || output.model_id || null,
    output_contract: output.output_contract || null
  };
  if (Buffer.byteLength(JSON.stringify(safe), "utf8") > MAX_REPLAY_BYTES) return null;
  return safe;
}

function replayPayloadDigest(output = {}) {
  const safe = replayOutput(output);
  if (!safe) return null;
  const {
    id: _id,
    step_id: _stepId,
    task: _task,
    depends_on: _dependsOn,
    ...stable
  } = safe;
  return worldGraphDigest(stable);
}

function normalizedRefusalText(value) {
  return String(value || "")
    .replaceAll("’", "'")
    .replace(/^\s*(?:#{1,6}\s*)?(?:\*{1,2}|_{1,2})?(?:limitation|unable to complete|status|note)(?:\*{1,2}|_{1,2})?\s*[:：-]?\s*(?:\r?\n|$)/i, "")
    .replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/, "")
    .replace(/^\s*(?:(?:unfortunately|regrettably|sorry|apologies|i'm sorry)\s*[,.:;-]?\s*)+/i, "")
    .replace(/\bI'm\b/i, "I am")
    .replace(/\bwe're\b/i, "we are")
    .replace(/\s+/g, " ")
    .trim();
}

const ROUTE_REFUSAL_PATTERNS = [
  /^no validated .{0,160} result was produced\b/i,
  /^(?:i|we|this (?:agent|route|analysis|request)|the system)\s+(?:cannot|can't|could not|was unable to|is unable to|am unable to|are unable to)\s+(?:proceed|complete|provide|produce|answer|analy[sz]e|generate|continue|help|assist|comply)\b/i,
  /^unable\s+to\s+(?:proceed|complete|provide|produce|answer|analy[sz]e|generate|continue)\b/i,
  /^(?:i\s+)?(?:cannot|can't)\s+(?:assist|comply)\b/i,
  /^(?:i|we)\s+(?:do not|don't)\s+have\s+enough\s+(?:information|details|context|data)\s+to\s+(?:proceed|complete|answer|analy[sz]e|continue)\b/i,
  /^(?:i|we)\s+need\s+(?:more|additional)\s+(?:information|details|context|data)\b.{0,140}\bbefore\b.{0,80}\b(?:proceed|continue|begin|complete)\b/i,
  /^(?:more|additional)\s+(?:information|details|context|data|project details)\s+(?:is|are)\s+(?:required|needed)\b.{0,120}\b(?:before|to)\b/i,
  /^(?:this|the)\s+(?:task|analysis|request|work)\s+(?:cannot|can't|could not)\s+(?:be\s+)?(?:completed|provided|produced|generated|analy[sz]ed)\b/i,
  /^(?:what|which)\b.{0,120}\b(?:project|scope|outcome|audience|market|timeframe)\b.{0,80}\?\s*$/i,
  /^the requested .{0,180}\b(?:could not|cannot|was not)\s+(?:be\s+)?(?:completed|provided|produced|generated|analy[sz]ed)\b/i,
  /^(?:there\s+(?:is|are)|we\s+have)\s+(?:insufficient|not enough)\s+(?:information|details|context|data)\b.{0,140}\b(?:to|for)\s+(?:proceed|complete|provide|produce|answer|analy[sz]e|generate|continue)\b/i,
  /^(?:please|could you|can you|would you|kindly)\s+(?:provide|define|clarify|supply|share|specify)\b.{0,160}\b(?:scope|requirements?|target (?:users?|audience)|missing (?:details|information|data)|needed (?:details|information|data)|project details|input data)\b/i,
  /^(?:n\/?a|unknown|unavailable|not available)\s*(?:[.:-]|$)/i,
  /^no\s+(?:answer|result|output)\s+(?:is\s+)?available\b/i,
  /^(?:ben|biz|bu\s+(?:istek|görev|analiz))\b.{0,100}\b(?:tamamlayamıyorum|tamamlanamıyor|sağlayamıyorum|devam\s+edemiyorum)\b/i,
  /^(?:no\s+puedo|no\s+podemos|se\s+necesita\s+más\s+información)\b/i,
  /^(?:je\s+ne\s+peux\s+pas|nous\s+ne\s+pouvons\s+pas|impossible\s+de)\b/i,
  /^(?:ich\s+kann\b.{0,100}\bnicht|wir\s+können\b.{0,100}\bnicht|weitere\s+informationen\s+sind\s+erforderlich)\b/i,
  /^(?:无法|不能|我无法|我们无法).{0,120}(?:完成|提供|继续|回答)/i
];

function refusalOnlyRouteAnswer(value) {
  const answer = normalizedRefusalText(value);
  for (const pattern of ROUTE_REFUSAL_PATTERNS) {
    const match = answer.match(pattern);
    if (!match) continue;
    const remainder = answer.slice((match.index || 0) + match[0].length);
    const contrast = remainder.match(/\b(?:but|however|instead|assuming|meanwhile|nevertheless|still|here (?:is|are)|I can|we can)\b([\s\S]+)$/i);
    if (contrast && (contrast[1].match(/[\p{L}\p{M}][\p{L}\p{M}'-]*/gu) || []).length >= 6) return false;
    const sentenceEnd = remainder.match(/[.!?](?:\s+|$)/);
    if (!sentenceEnd) return true;
    const tail = remainder.slice((sentenceEnd.index || 0) + sentenceEnd[0].length).trim();
    if ((tail.match(/[\p{L}\p{M}][\p{L}\p{M}'-]*/gu) || []).length < 6) return true;
    return ROUTE_REFUSAL_PATTERNS.some((candidate) => candidate.test(tail));
  }
  return false;
}

function validRouteOutput(output) {
  const answer = String(output?.domain_answer || "").replace(/\s+/g, " ").trim();
  return Boolean(
    output
    && output.adapter
    && answer
    && !refusalOnlyRouteAnswer(answer)
    && !(output.policy_violations || []).length
    && output.artifact_validation?.valid === true
    && output.consumption_validation?.valid === true
    && output.source_validation?.valid === true
  );
}

function inputEnvelope({ run, step, agent, documents, sharedMemory, options, outputsByStep, runtimeComponentProvenance = null }) {
  const query = normalizedQuery(run?.query);
  const sourceState = sourceStateForAgent(agent, documents);
  const effectiveMemory = exactRepeatAntecedentMemory(query, sharedMemory);
  const routeEffectPolicy = replayPolicy({
    query,
    task: step?.task,
    evidenceRequirement: step?.evidence_requirement,
    agent,
    documents
  });
  return {
    schema_version: WORLD_GRAPH_SCHEMA_VERSION,
    engine_revision: WORLD_GRAPH_ENGINE_REVISION,
    query_digest: worldGraphDigest(query),
    task_digest: worldGraphDigest(normalizedTask(step?.task)),
    adapter: String(step?.adapter || ""),
    agent_revision: agentRevision(agent || { id: step?.adapter || "" }),
    dependency_state: dependencyState(step, outputsByStep),
    memory_digest: memoryState(agent, effectiveMemory) === null
      ? null
      : worldGraphDigest(memoryState(agent, effectiveMemory)),
    source_state_digest: worldGraphDigest(sourceState),
    route_options_digest: worldGraphDigest(routeOptionState(options)),
    runtime_component_digest: normalizedRuntimeComponentState(runtimeComponentProvenance)
      ? worldGraphDigest(normalizedRuntimeComponentState(runtimeComponentProvenance))
      : null,
    effect_policy: routeEffectPolicy
  };
}

function envelopeDigest(envelope) {
  return worldGraphDigest(envelope);
}

function envelopeChangeReason(previous, current) {
  if (!previous || !current) return "no_matching_result";
  if (previous.query_digest !== current.query_digest) return "request_changed";
  if (previous.agent_revision !== current.agent_revision) return "agent_changed";
  if (previous.task_digest !== current.task_digest) return "task_changed";
  if (previous.source_state_digest !== current.source_state_digest) return "source_changed_or_unverifiable";
  if (previous.memory_digest !== current.memory_digest) return "conversation_context_changed";
  if (previous.route_options_digest !== current.route_options_digest) return "execution_settings_changed";
  if (previous.runtime_component_digest !== current.runtime_component_digest) return "runtime_revision_changed_or_unverified";
  if (worldGraphDigest(previous.dependency_state || []) !== worldGraphDigest(current.dependency_state || [])) {
    return "upstream_result_changed";
  }
  if (worldGraphDigest(previous.effect_policy || {}) !== worldGraphDigest(current.effect_policy || {})) {
    return current.effect_policy?.reasons?.[0]
      || previous.effect_policy?.reasons?.[0]
      || "result_requires_fresh_execution";
  }
  return "no_matching_result";
}

function artifactRecordHash(artifact) {
  const { record_hash: _recordHash, ...body } = artifact;
  const canonicalBody = worldGraphCanonicalJson(body);
  const signingKey = runtimeApiKey();
  if (String(signingKey).length >= 16) {
    return `hmac-sha256:${crypto.createHmac("sha256", String(signingKey))
      .update(WORLD_GRAPH_ARTIFACT_MAC_DOMAIN, "utf8")
      .update(canonicalBody, "utf8")
      .digest("hex")}`;
  }
  // Simulator/development mode remains self-verifying without provisioning a
  // secret. Production real-runtime startup already requires the shared key,
  // so persisted artifacts there are MAC-bound and a database-only writer
  // cannot forge them by recomputing an unkeyed checksum.
  return worldGraphDigest(body);
}

export function verifyWorldGraphArtifact(artifact) {
  return Boolean(
    artifact
    && artifact.schema_version === WORLD_GRAPH_SCHEMA_VERSION
    && artifact.input_envelope?.schema_version === WORLD_GRAPH_SCHEMA_VERSION
    && artifact.input_envelope?.engine_revision === WORLD_GRAPH_ENGINE_REVISION
    && artifact.record_hash === artifactRecordHash(artifact)
    && artifact.envelope_digest === envelopeDigest(artifact.input_envelope)
    && artifact.output_digest === outputDigest(artifact.replay_output)
  );
}

function eventRecordHash(event) {
  const { record_hash: _recordHash, ...body } = event || {};
  const canonicalBody = worldGraphCanonicalJson(body);
  const signingKey = runtimeApiKey();
  if (String(signingKey).length >= 16) {
    return `hmac-sha256:${crypto.createHmac("sha256", String(signingKey))
      .update(WORLD_GRAPH_EVENT_MAC_DOMAIN, "utf8")
      .update(canonicalBody, "utf8")
      .digest("hex")}`;
  }
  return worldGraphDigest(body);
}

function verifyWorldGraphEvent(event) {
  return Boolean(
    event
    && event.schema_version === WORLD_GRAPH_SCHEMA_VERSION
    && event.event_type === "result.contested"
    && event.record_hash === eventRecordHash(event)
  );
}

function contestedArtifactIds(data) {
  const artifacts = (data.worldGraphArtifacts || []).filter((artifact) => (
    verifyWorldGraphArtifact(artifact) && validRouteOutput(artifact.replay_output)
  ));
  const byId = new Map(artifacts.map((artifact) => [artifact.artifact_id, artifact]));
  const contested = new Set();

  const groupKey = (artifact) => worldGraphDigest({
    workspace_id: artifact.workspace_id,
    created_by: artifact.created_by,
    session_id: artifact.session_id,
    agent_workspace_id: artifact.agent_workspace_id,
    adapter: artifact.adapter,
    envelope_digest: artifact.envelope_digest
  });

  // Derive conflict truth from complete, integrity-valid route artifacts so
  // event pruning cannot silently erase a real deterministic disagreement.
  const groups = new Map();
  for (const artifact of artifacts) {
    const key = groupKey(artifact);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(artifact);
  }
  for (const group of groups.values()) {
    if (new Set(group.map((artifact) => artifact.output_digest)).size < 2) continue;
    for (const artifact of group) contested.add(artifact.artifact_id);
  }

  // Signed events remain auditable evidence, but every reference must still
  // resolve to a valid artifact in the same exact tenant/envelope group with
  // at least two distinct outputs. A legacy flag or poisoned event cannot by
  // itself suppress a good result.
  for (const event of data.worldGraphEvents || []) {
    if (!verifyWorldGraphEvent(event) || !Array.isArray(event.artifact_ids)) continue;
    const ids = [...new Set(event.artifact_ids.map((value) => String(value || "")).filter(Boolean))];
    const referenced = ids.map((id) => byId.get(id));
    if (ids.length < 2 || referenced.some((artifact) => !artifact)) continue;
    const first = referenced[0];
    const eventScope = scopeFor({ run: event, session: event });
    if (
      !referenced.every((artifact) => sameScope(artifact, eventScope))
      || referenced.some((artifact) => artifact.adapter !== event.adapter)
      || new Set(referenced.map(groupKey)).size !== 1
      || new Set(referenced.map((artifact) => artifact.output_digest)).size < 2
      || first.adapter !== event.adapter
    ) continue;
    for (const artifact of referenced) contested.add(artifact.artifact_id);
  }
  return contested;
}

function maxAgeFor(_options = {}) {
  return String(process.env.TCAR_ENGINE_MODE || "simulator").toLowerCase() === "real"
    ? REMOTE_MAX_AGE_MS
    : DEFAULT_MAX_AGE_MS;
}

function artifactAgeValid(artifact, nowMs, options) {
  // A reused copy must never renew the freshness lease. New artifacts carry
  // the timestamp of the last actual worker execution through every reuse
  // generation. Legacy artifacts fall back to their immutable creation time.
  const anchor = Object.hasOwn(artifact || {}, "freshness_anchor_at")
    ? artifact.freshness_anchor_at
    : artifact?.created_at;
  const refreshed = Date.parse(anchor || "");
  return Number.isFinite(refreshed) && nowMs - refreshed >= 0 && nowMs - refreshed <= maxAgeFor(options);
}

export function selectWorldGraphSeeds({
  data,
  run,
  session,
  plan,
  agents,
  documents,
  sharedMemory,
  options,
  runtimeComponentProvenance = null,
  runFresh = false,
  now = Date.now()
}) {
  const scope = scopeFor({ run, session });
  const agentsById = new Map((agents || []).map((agent) => [agent.id, agent]));
  const outputsByStep = new Map();
  const seeds = new Map();
  const decisions = [];
  const contested = contestedArtifactIds(data);
  const candidates = (data.worldGraphArtifacts || [])
    .filter((artifact) => sameScope(artifact, scope))
    .sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)));

  for (const step of plan?.steps || []) {
    const agent = agentsById.get(step.adapter) || { id: step.adapter };
    const envelope = inputEnvelope({
      run, session, step, agent, documents, sharedMemory, options, outputsByStep, runtimeComponentProvenance
    });
    const digest = envelopeDigest(envelope);
    let chosen = null;
    let reason = runFresh ? "fresh_run_requested" : "no_matching_result";
    let mismatchReason = null;
    if (!runFresh && envelope.effect_policy.replayable && Number(options?.temperature || 0) === 0) {
      for (const artifact of candidates) {
        if (artifact.adapter !== step.adapter) continue;
        if (!verifyWorldGraphArtifact(artifact)) {
          reason = "stored_result_failed_integrity_check";
          continue;
        }
        if (artifact.envelope_digest !== digest) {
          mismatchReason ||= envelopeChangeReason(artifact.input_envelope, envelope);
          continue;
        }
        if (contested.has(artifact.artifact_id)) {
          reason = "stored_results_disagree";
          continue;
        }
        if (!artifactAgeValid(artifact, now, options)) {
          reason = "stored_result_expired";
          continue;
        }
        if (!validRouteOutput(artifact.replay_output)) {
          reason = "stored_result_not_validated";
          continue;
        }
        chosen = artifact;
        reason = "inputs_and_evidence_unchanged";
        break;
      }
      if (!chosen && mismatchReason && reason === "no_matching_result") reason = mismatchReason;
    } else if (!runFresh) {
      if (Number(options?.temperature || 0) !== 0) {
        reason = "creative_variation_requested";
      } else {
      reason = envelope.effect_policy.reasons[0] || "result_requires_fresh_execution";
      }
    }
    if (chosen) {
      const seed = {
        ...structuredClone(chosen.replay_output),
        id: step.id,
        step_id: step.id,
        adapter: step.adapter,
        task: step.task,
        depends_on: step.depends_on || [],
        execution_mode: "reused",
        reused_from_artifact_id: chosen.artifact_id,
        reused_from_run_id: chosen.origin_run_id,
        world_graph_output_digest: chosen.output_digest,
        elapsed_sec: 0
      };
      seeds.set(step.id, seed);
      outputsByStep.set(step.id, seed);
    } else {
      // A live result is not known yet. Use a dependency sentinel so no
      // downstream artifact can be selected before this branch resolves.
      outputsByStep.set(step.id, {
        step_id: step.id,
        adapter: step.adapter,
        world_graph_output_digest: worldGraphDigest({ pending_live_step: step.id, envelope: digest })
      });
    }
    decisions.push({
      step_id: step.id,
      adapter: step.adapter,
      action: chosen ? "kept" : "refresh",
      reason,
      artifact_id: chosen?.artifact_id || null,
      origin_run_id: chosen?.origin_run_id || null,
      envelope_digest: digest
    });
  }
  return { seeds, decisions, scope };
}

export function selectWorldGraphSeedForStep({
  data,
  run,
  session,
  step,
  agents,
  documents,
  sharedMemory,
  options,
  runtimeComponentProvenance = null,
  resolvedOutputs,
  runFresh = false,
  now = Date.now()
}) {
  const scope = scopeFor({ run, session });
  const agent = (agents || []).find((item) => item.id === step.adapter) || { id: step.adapter };
  const outputsByStep = new Map((resolvedOutputs || []).map((output) => [output.step_id || output.id, output]));
  const envelope = inputEnvelope({
    run, session, step, agent, documents, sharedMemory, options, outputsByStep, runtimeComponentProvenance
  });
  const digest = envelopeDigest(envelope);
  const contested = contestedArtifactIds(data);
  let reason = runFresh ? "fresh_run_requested" : "no_matching_result";
  let mismatchReason = null;
  if (!runFresh && envelope.effect_policy.replayable && Number(options?.temperature || 0) === 0) {
    const candidates = (data.worldGraphArtifacts || [])
      .filter((artifact) => sameScope(artifact, scope) && artifact.adapter === step.adapter)
      .sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)));
    for (const artifact of candidates) {
      if (!verifyWorldGraphArtifact(artifact)) { reason = "stored_result_failed_integrity_check"; continue; }
      if (artifact.envelope_digest !== digest) {
        mismatchReason ||= envelopeChangeReason(artifact.input_envelope, envelope);
        continue;
      }
      if (contested.has(artifact.artifact_id)) { reason = "stored_results_disagree"; continue; }
      if (!artifactAgeValid(artifact, now, options)) { reason = "stored_result_expired"; continue; }
      if (!validRouteOutput(artifact.replay_output)) { reason = "stored_result_not_validated"; continue; }
      return {
        seed: {
          ...structuredClone(artifact.replay_output),
          id: step.id,
          step_id: step.id,
          adapter: step.adapter,
          task: step.task,
          depends_on: step.depends_on || [],
          execution_mode: "reused",
          reused_from_artifact_id: artifact.artifact_id,
          reused_from_run_id: artifact.origin_run_id,
          world_graph_output_digest: artifact.output_digest,
          elapsed_sec: 0
        },
        decision: {
          step_id: step.id,
          adapter: step.adapter,
          action: "kept",
          reason: "inputs_and_evidence_unchanged",
          artifact_id: artifact.artifact_id,
          origin_run_id: artifact.origin_run_id,
          envelope_digest: digest
        }
      };
    }
    if (mismatchReason && reason === "no_matching_result") reason = mismatchReason;
  } else if (!runFresh) {
    reason = Number(options?.temperature || 0) !== 0
      ? "creative_variation_requested"
      : envelope.effect_policy.reasons[0] || "result_requires_fresh_execution";
  }
  return {
    seed: null,
    decision: {
      step_id: step.id,
      adapter: step.adapter,
      action: "refresh",
      reason,
      artifact_id: null,
      origin_run_id: null,
      envelope_digest: digest
    }
  };
}

export function recordWorldGraphRun({
  data,
  run,
  session,
  plan,
  outputs,
  agents,
  documents,
  sharedMemory,
  options,
  decisions = [],
  preparation = null,
  runtimeProvenance = null,
  replayCandidateIds = null,
  createdAt = nowIso()
}) {
  data.worldGraphArtifacts ||= [];
  data.worldGraphEvents ||= [];
  const scope = scopeFor({ run, session });
  const agentsById = new Map((agents || []).map((agent) => [agent.id, agent]));
  const outputByStep = new Map((outputs || []).map((output) => [output.step_id || output.id, output]));
  const decisionsByStep = new Map(decisions.map((item) => [item.step_id, item]));
  const recorded = [];
  const realRuntime = String(process.env.TCAR_ENGINE_MODE || "simulator").toLowerCase() === "real";
  const permittedReplayIds = new Set(Array.isArray(replayCandidateIds) ? replayCandidateIds : []);
  const recordTime = Date.parse(createdAt);

  for (const step of plan?.steps || []) {
    const output = outputByStep.get(step.id);
    if (!output) continue;
    const agent = agentsById.get(step.adapter) || { id: step.adapter };
    const runtimeComponentState = normalizedRuntimeComponentState(runtimeProvenance || output);
    const executionMode = output.execution_mode === "reused" ? "reused" : "refreshed";
    const replay = replayOutput({ ...output, id: step.id, step_id: step.id, adapter: step.adapter, task: step.task, depends_on: step.depends_on || [] });
    if (!replay) {
      if (executionMode === "reused") {
        const error = new Error(`Reused output exceeded the verified replay boundary for step ${step.id}.`);
        error.code = "world_graph_reuse_contract_invalid";
        throw error;
      }
      continue;
    }
    if (!validRouteOutput(replay)) {
      if (executionMode === "reused") {
        const error = new Error(`Reused output was not validated for step ${step.id}.`);
        error.code = "world_graph_reuse_contract_invalid";
        throw error;
      }
      // Failed-closed/partial worker results remain on the run for diagnosis,
      // but they are not durable reusable knowledge and cannot create a
      // deterministic contest against an earlier valid result.
      continue;
    }
    const envelope = inputEnvelope({
      run,
      session,
      step,
      agent,
      documents,
      sharedMemory,
      options,
      outputsByStep: outputByStep,
      runtimeComponentProvenance: runtimeComponentState
    });
    let actualEffect = replayPolicy({
      query: run.query,
      task: step?.task,
      evidenceRequirement: step?.evidence_requirement,
      agent,
      output,
      documents
    });
    envelope.effect_policy = actualEffect;
    const outputHash = outputDigest(replay);
    const currentEnvelopeDigest = envelopeDigest(envelope);
    const sourceArtifact = executionMode === "reused"
      ? data.worldGraphArtifacts.find((candidate) => (
        candidate.artifact_id === output.reused_from_artifact_id
        && sameScope(candidate, scope)
        && candidate.adapter === step.adapter
        && candidate.envelope_digest === currentEnvelopeDigest
        && candidate.output_digest === outputHash
        && output.world_graph_output_digest === candidate.output_digest
        && replayPayloadDigest(candidate.replay_output) === replayPayloadDigest(output)
        && worldGraphDigest(candidate.runtime_component_state || null) === worldGraphDigest(runtimeComponentState || null)
        && !contestedArtifactIds(data).has(candidate.artifact_id)
        && candidate.effect_policy?.replayable === true
        && artifactAgeValid(candidate, Number.isFinite(recordTime) ? recordTime : Date.now(), options)
        && validRouteOutput(candidate.replay_output)
        && verifyWorldGraphArtifact(candidate)
        && (!realRuntime || permittedReplayIds.has(candidate.artifact_id))
        && (!realRuntime || output.reused_from_run_id === candidate.origin_run_id)
      )) || null
      : null;
    if (executionMode === "reused" && !sourceArtifact) {
      const error = new Error(`Unverified work reuse was claimed for step ${step.id}.`);
      error.code = "world_graph_reuse_contract_invalid";
      throw error;
    }
    if (realRuntime && !runtimeComponentState) {
      if (executionMode === "reused") {
        const error = new Error(`Runtime omitted component provenance for reused step ${step.id}.`);
        error.code = "world_graph_reuse_contract_invalid";
        throw error;
      }
      actualEffect = {
        class: "volatile",
        replayable: false,
        reasons: [...new Set([...(actualEffect.reasons || []), "runtime_revision_changed_or_unverified"])]
      };
      envelope.effect_policy = actualEffect;
    }
    // A kept route already points to an immutable, verified source artifact.
    // Do not clone the full payload on every repeat: that would amplify writes,
    // consume the per-owner cap, and evict useful results from unrelated chats.
    if (executionMode === "reused") continue;
    const artifact = {
      artifact_id: makeId("wg_artifact"),
      schema_version: WORLD_GRAPH_SCHEMA_VERSION,
      ...scope,
      origin_run_id: run.run_id,
      origin_step_id: step.id,
      adapter: step.adapter,
      input_envelope: envelope,
      envelope_digest: envelopeDigest(envelope),
      output_digest: outputHash,
      replay_output: replay,
      effect_policy: actualEffect,
      execution_mode: executionMode,
      reused_from_artifact_id: output.reused_from_artifact_id || null,
      freshness_anchor_at: createdAt,
      runtime_provenance_digest: runtimeProvenance ? worldGraphDigest(runtimeProvenance) : null,
      runtime_component_state: runtimeComponentState,
      contested: false,
      created_at: createdAt
    };
    const conflicts = data.worldGraphArtifacts.filter((candidate) =>
      sameScope(candidate, scope)
      && candidate.envelope_digest === artifact.envelope_digest
      && candidate.output_digest !== artifact.output_digest
      && verifyWorldGraphArtifact(candidate)
      && validRouteOutput(candidate.replay_output)
    );
    if (conflicts.length && Number(options?.temperature || 0) === 0) {
      artifact.contested = true;
      for (const conflict of conflicts) {
        conflict.contested = true;
        conflict.record_hash = artifactRecordHash(conflict);
      }
      const contestEvent = {
        event_id: makeId("wg_event"),
        schema_version: WORLD_GRAPH_SCHEMA_VERSION,
        event_type: "result.contested",
        ...scope,
        run_id: run.run_id,
        step_id: step.id,
        adapter: step.adapter,
        artifact_ids: [...conflicts.map((item) => item.artifact_id), artifact.artifact_id],
        occurred_at: createdAt
      };
      contestEvent.record_hash = eventRecordHash(contestEvent);
      data.worldGraphEvents.push(contestEvent);
    }
    artifact.record_hash = artifactRecordHash(artifact);
    data.worldGraphArtifacts.push(artifact);
    recorded.push(artifact);
  }

  const completedOutputs = (plan?.steps || [])
    .map((step) => outputByStep.get(step.id))
    .filter(Boolean);
  const refreshed = completedOutputs.filter((item) => item.execution_mode !== "reused").length;
  const kept = completedOutputs.filter((item) => item.execution_mode === "reused").length;
  const safePreparation = replayPreparationSummary(preparation || run.world_graph_preparation || {});
  run.world_graph = {
    schema_version: WORLD_GRAPH_SCHEMA_VERSION,
    kept,
    refreshed,
    total: completedOutputs.length,
    decisions: (plan?.steps || []).map((step) => {
      const output = outputByStep.get(step.id);
      const decision = decisionsByStep.get(step.id);
      return {
        step_id: step.id,
        adapter: step.adapter,
        action: output?.execution_mode === "reused" ? "kept" : "refreshed",
        reason: output?.execution_mode === "reused"
          ? "inputs_and_evidence_unchanged"
          : (() => {
            const runtimeReason = decision?.reason || "result_was_recomputed";
            if (runtimeReason !== "no_matching_result") return runtimeReason;
            const agentPreparation = safePreparation.agents.find((item) => item.adapter === step.adapter);
            if (agentPreparation?.status === "excluded") return agentPreparation.reason;
            return safePreparation.primary_reason !== "inputs_and_evidence_unchanged"
              ? safePreparation.primary_reason
              : runtimeReason;
          })(),
        reused_from_run_id: output?.reused_from_run_id || decision?.origin_run_id || null
      };
    }),
    preparation: safePreparation,
    created_at: createdAt
  };
  pruneWorldGraph(data, scope, Date.parse(createdAt));
  return run.world_graph;
}

function pruneWorldGraph(data, scope, referenceTime = Date.now()) {
  const safeReferenceTime = Number.isFinite(referenceTime) ? referenceTime : Date.now();
  pruneExpiredWorldGraphData(data, { now: safeReferenceTime });
  const owned = data.worldGraphArtifacts
    .filter((artifact) => artifact.workspace_id === scope.workspace_id && artifact.created_by === scope.created_by)
    .sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)));
  if (owned.length > MAX_ARTIFACTS_PER_OWNER) {
    const keep = new Set(owned.slice(0, MAX_ARTIFACTS_PER_OWNER).map((item) => item.artifact_id));
    data.worldGraphArtifacts = data.worldGraphArtifacts.filter((artifact) =>
      artifact.workspace_id !== scope.workspace_id
      || artifact.created_by !== scope.created_by
      || keep.has(artifact.artifact_id)
    );
  }
  const ownedEvents = (data.worldGraphEvents || [])
    .filter((event) => event.workspace_id === scope.workspace_id && event.created_by === scope.created_by)
    .sort((left, right) => String(right.occurred_at).localeCompare(String(left.occurred_at)));
  if (ownedEvents.length > MAX_EVENTS_PER_OWNER) {
    const keepEvents = new Set(ownedEvents.slice(0, MAX_EVENTS_PER_OWNER).map((event) => event.event_id));
    data.worldGraphEvents = data.worldGraphEvents.filter((event) =>
      event.workspace_id !== scope.workspace_id
      || event.created_by !== scope.created_by
      || keepEvents.has(event.event_id)
    );
  }
}

export function pruneExpiredWorldGraphData(data, { now = Date.now() } = {}) {
  const safeNow = Number.isFinite(now) ? now : Date.now();
  const cutoff = safeNow - STORAGE_RETENTION_MS;
  const artifactCount = (data.worldGraphArtifacts || []).length;
  const eventCount = (data.worldGraphEvents || []).length;
  data.worldGraphArtifacts = (data.worldGraphArtifacts || []).filter((artifact) => {
    const created = Date.parse(artifact.created_at || "");
    return Number.isFinite(created) && created >= cutoff;
  });
  data.worldGraphEvents = (data.worldGraphEvents || []).filter((event) => {
    const occurred = Date.parse(event.occurred_at || "");
    return Number.isFinite(occurred) && occurred >= cutoff;
  });
  return {
    artifacts: artifactCount - data.worldGraphArtifacts.length,
    events: eventCount - data.worldGraphEvents.length
  };
}

export function publicWorldGraphRun(run = {}) {
  const graph = run.world_graph || {};
  const preparation = replayPreparationSummary(graph.preparation || run.world_graph_preparation || {});
  return {
    schema_version: graph.schema_version || WORLD_GRAPH_SCHEMA_VERSION,
    kept: Number(graph.kept) || 0,
    refreshed: Number(graph.refreshed) || 0,
    total: Number(graph.total) || 0,
    // This describes what happened at completion. Present validity is known
    // only after the explicit no-model /check operation.
    validity: run.status === "completed" ? "unchecked" : run.status === "failed" ? "unknown" : "checking",
    decisions: Array.isArray(graph.decisions) ? graph.decisions.map((item) => ({
      step_id: item.step_id,
      adapter: item.adapter,
      action: item.action,
      reason: item.reason,
      plain_reason: worldGraphReasonText(item.reason, item.action),
      reused_from_run_id: item.reused_from_run_id || null
    })) : [],
    preparation,
    created_at: graph.created_at || null
  };
}

export function publicWorldGraphSnapshot({ data, run, actor }) {
  const targetScope = run ? {
    workspace_id: String(run.workspace_id || ""),
    created_by: String(run.created_by || ""),
    session_id: String(run.session_id || ""),
    agent_workspace_id: String(run.agent_workspace_id || "")
  } : {
    workspace_id: String(actor.workspace_id || ""),
    created_by: String(actor.user_id || ""),
    session_id: "",
    agent_workspace_id: ""
  };
  const runQueryDigest = run ? worldGraphDigest(normalizedQuery(run.query)) : null;
  const runAdapters = new Set((run?.plan?.steps || []).map((step) => step.adapter));
  const accessible = (data.worldGraphArtifacts || []).filter((artifact) =>
    artifact.workspace_id === targetScope.workspace_id
    && artifact.created_by === targetScope.created_by
    && (!run || (
      artifact.session_id === targetScope.session_id
      && artifact.agent_workspace_id === targetScope.agent_workspace_id
      && artifact.input_envelope?.query_digest === runQueryDigest
      && runAdapters.has(artifact.adapter)
    ))
  );
  const verified = accessible.filter(verifyWorldGraphArtifact);
  const validStored = verified.filter((artifact) => validRouteOutput(artifact.replay_output));
  const contested = contestedArtifactIds(data);
  const summary = run ? publicWorldGraphRun(run) : null;
  const decisions = new Map((summary?.decisions || []).map((item) => [item.step_id, item]));
  const steps = run?.plan?.steps || [];
  return {
    schema_version: WORLD_GRAPH_SCHEMA_VERSION,
    run: summary,
    graph_id: run ? `world_graph:${run.run_id}` : null,
    revision: run?.completed_at || run?.created_at || null,
    nodes: steps.map((step) => {
      const decision = decisions.get(step.id);
      return {
        node_id: `agent_result:${step.id}`,
        kind: "agent_result",
        agent_id: step.adapter,
        step_id: step.id,
        label: boundedText(step.task || step.adapter, 240),
        validity: run?.status === "completed" ? "unchecked" : "unknown",
        run_action: decision?.action === "kept"
          ? "reused"
          : run?.status === "completed" ? "executed" : "pending",
        reason_code: decision?.reason || "result_was_recomputed",
        plain_reason: decision?.plain_reason || worldGraphReasonText(decision?.reason, decision?.action),
        effect: "read"
      };
    }),
    edges: steps.flatMap((step) => (step.depends_on || []).map((source) => ({
      edge_id: `support:${source}:${step.id}`,
      source: `agent_result:${source}`,
      target: `agent_result:${step.id}`,
      kind: "supports"
    }))),
    stored_results: validStored.length,
    contested_results: validStored.filter((artifact) => contested.has(artifact.artifact_id)).length,
    effect_safe_results: validStored.filter((artifact) => artifact.effect_policy?.replayable === true).length
  };
}

export function previewWorldGraphRun({
  data,
  run,
  session,
  agents,
  documents,
  sharedMemory,
  options,
  runtimeComponentProvenance = null,
  targetAgentWorkspaceId = run?.agent_workspace_id || null,
  now = Date.now()
}) {
  const steps = Array.isArray(run?.plan?.steps) ? run.plan.steps : [];
  if (run?.status !== "completed" || !steps.length || !run?.world_graph?.total) {
    return {
      schema_version: WORLD_GRAPH_SCHEMA_VERSION,
      availability: "unavailable",
      base_run_id: run?.run_id || null,
      validity: "unknown",
      keep_count: 0,
      wake_count: 0,
      decisions: [],
      model_calls_performed: 0,
      checked_at: new Date(now).toISOString()
    };
  }
  if (String(targetAgentWorkspaceId || "") !== String(run.agent_workspace_id || "")) {
    return {
      schema_version: WORLD_GRAPH_SCHEMA_VERSION,
      availability: "ready",
      base_run_id: run.run_id,
      validity: "needs_refresh",
      keep_count: 0,
      wake_count: steps.length,
      decisions: steps.map((step) => ({
        step_id: step.id,
        adapter: step.adapter,
        projected_action: "wake",
        reason: "agent_team_changed",
        plain_reason: worldGraphReasonText("agent_team_changed", "refresh")
      })),
      conservative: true,
      external_actions_will_run: false,
      model_calls_performed: 0,
      checked_at: new Date(now).toISOString()
    };
  }
  const resolved = [];
  const decisions = [];
  for (const step of steps) {
    const selection = selectWorldGraphSeedForStep({
      data,
      run,
      session,
      step,
      agents,
      documents,
      sharedMemory,
      options,
      runtimeComponentProvenance,
      resolvedOutputs: resolved,
      runFresh: false,
      now
    });
    const keep = Boolean(selection.seed);
    decisions.push({
      step_id: step.id,
      adapter: step.adapter,
      projected_action: keep ? "keep" : "wake",
      reason: selection.decision.reason,
      plain_reason: worldGraphReasonText(selection.decision.reason, keep ? "kept" : "refresh")
    });
    resolved.push(selection.seed || {
      id: step.id,
      step_id: step.id,
      adapter: step.adapter,
      // A dirty upstream branch has no known future output. The sentinel makes
      // every dependent preview conservative until the branch actually runs;
      // if its validated output stays identical, the live executor can still
      // keep downstream work.
      world_graph_output_digest: worldGraphDigest({
        projected_dirty_step: step.id,
        envelope_digest: selection.decision.envelope_digest
      })
    });
  }
  const wakeCount = decisions.filter((decision) => decision.projected_action === "wake").length;
  return {
    schema_version: WORLD_GRAPH_SCHEMA_VERSION,
    availability: "ready",
    base_run_id: run.run_id,
    validity: wakeCount ? "needs_refresh" : "current",
    keep_count: decisions.length - wakeCount,
    wake_count: wakeCount,
    decisions,
    conservative: wakeCount > 0,
    external_actions_will_run: false,
    model_calls_performed: 0,
    checked_at: new Date(now).toISOString()
  };
}

export function worldGraphReasonText(code, action = "") {
  const reasons = {
    inputs_and_evidence_unchanged: "Its inputs, evidence, and specialist instructions are unchanged.",
    fresh_run_requested: "You asked every specialist to check again.",
    no_matching_result: "No earlier validated result matched this work.",
    agent_changed: "The specialist's instructions or knowledge changed.",
    agent_team_changed: "The active team changed since this answer ran.",
    task_changed: "This specialist received a different task.",
    upstream_result_changed: "Work this specialist relies on changed.",
    dependencies_changed: "The handoff into this specialist changed.",
    source_changed_or_unverifiable: "A source changed or could no longer be verified.",
    request_changed: "The request changed, so this work was checked again.",
    conversation_context_changed: "Conversation context this specialist uses changed.",
    execution_settings_changed: "The model or execution settings changed.",
    runtime_revision_changed_or_unverified: "The model or Router runtime revision changed or could not be verified.",
    stored_result_expired: "The earlier result was too old to keep.",
    stored_results_disagree: "Earlier validated results disagree, so this was checked again.",
    stored_result_failed_integrity_check: "The earlier result did not pass its integrity check.",
    stored_result_not_validated: "The earlier result was not safe to reuse.",
    creative_variation_requested: "Creative variation was requested.",
    time_sensitive_request: "This request depends on current information.",
    live_or_mutable_tool_available: "This work can depend on live information.",
    live_or_mutable_tool_used: "This work used live information.",
    external_or_effectful_tool_used: "External actions are never replayed.",
    approval_bound_action: "This work requires a new approval.",
    tool_result_requires_fresh_execution: "A tool result needed to be checked again.",
    replay_signing_unavailable: "Verified reuse was unavailable, so the work was checked again.",
    agent_unavailable: "The specialist was unavailable or still syncing.",
    replay_payload_too_large: "The earlier result was too large to verify safely.",
    duplicate_stored_result: "A newer matching result was considered instead.",
    reuse_provenance_unverified: "The earlier result could not be traced to a verified stored record.",
    result_was_recomputed: "This specialist checked its part of the answer now."
  };
  return reasons[code] || (action === "kept"
    ? "The prior validated work is still current."
    : "This specialist checked its part of the answer now.");
}

function replayPreparationSummary(value = {}) {
  const exclusions = Array.isArray(value.exclusions) ? value.exclusions : [];
  const agents = Array.isArray(value.agents) ? value.agents : [];
  return {
    status: ["ready", "no_match", "disabled"].includes(value.status) ? value.status : "no_match",
    capsule_created: value.capsule_created === true,
    artifacts_in_scope: Math.max(0, Number(value.artifacts_in_scope) || 0),
    exact_request_artifacts: Math.max(0, Number(value.exact_request_artifacts) || 0),
    eligible_candidates: Math.max(0, Number(value.eligible_candidates) || 0),
    primary_reason: boundedText(value.primary_reason || "no_matching_result", 120),
    plain_reason: worldGraphReasonText(value.primary_reason || "no_matching_result", "refresh"),
    exclusions: exclusions.slice(0, 16).map((item) => ({
      reason: boundedText(item?.reason || "no_matching_result", 120),
      count: Math.max(0, Number(item?.count) || 0),
      plain_reason: worldGraphReasonText(item?.reason || "no_matching_result", "refresh")
    })),
    agents: agents.slice(0, 24).map((item) => ({
      adapter: boundedText(item?.adapter, 300),
      status: item?.status === "eligible" ? "eligible" : "excluded",
      reason: boundedText(item?.reason || "no_matching_result", 120),
      plain_reason: item?.status === "eligible"
        ? "A verified earlier result was available for comparison."
        : worldGraphReasonText(item?.reason || "no_matching_result", "refresh")
    }))
  };
}

function newReplayPreparation() {
  return {
    status: "no_match",
    capsule_created: false,
    artifacts_in_scope: 0,
    exact_request_artifacts: 0,
    eligible_candidates: 0,
    primary_reason: "no_matching_result",
    exclusions: [],
    agents: []
  };
}

function addReplayExclusion(counts, agentReasons, reason, adapter = "") {
  counts.set(reason, (counts.get(reason) || 0) + 1);
  if (adapter && !agentReasons.has(adapter)) agentReasons.set(adapter, reason);
}

function finalizeReplayPreparation(preparation, counts, agentReasons, eligibleAdapters) {
  preparation.exclusions = [...counts.entries()].map(([reason, count]) => ({ reason, count }));
  preparation.agents = [...new Set([...agentReasons.keys(), ...eligibleAdapters])].map((adapter) => ({
    adapter,
    status: eligibleAdapters.has(adapter) ? "eligible" : "excluded",
    reason: eligibleAdapters.has(adapter) ? "inputs_and_evidence_unchanged" : agentReasons.get(adapter) || "no_matching_result"
  }));
  if (preparation.eligible_candidates > 0) {
    preparation.status = "ready";
    preparation.capsule_created = true;
    preparation.primary_reason = "inputs_and_evidence_unchanged";
  } else if (preparation.primary_reason === "no_matching_result" && preparation.exclusions.length) {
    preparation.primary_reason = preparation.exclusions[0].reason;
  }
  return replayPreparationSummary(preparation);
}

export function prepareWorldGraphReplay({
  data,
  run,
  session,
  agents,
  documents,
  sharedMemory,
  options,
  runFresh = false,
  signingKey = "",
  now = Date.now()
}) {
  const preparation = newReplayPreparation();
  const exclusionCounts = new Map();
  const agentReasons = new Map();
  const eligibleAdapters = new Set();
  if (runFresh) {
    preparation.status = "disabled";
    preparation.primary_reason = "fresh_run_requested";
    addReplayExclusion(exclusionCounts, agentReasons, "fresh_run_requested");
    return { capsule: null, diagnostics: finalizeReplayPreparation(preparation, exclusionCounts, agentReasons, eligibleAdapters) };
  }
  if (Number(options?.temperature || 0) !== 0) {
    preparation.status = "disabled";
    preparation.primary_reason = "creative_variation_requested";
    addReplayExclusion(exclusionCounts, agentReasons, "creative_variation_requested");
    return { capsule: null, diagnostics: finalizeReplayPreparation(preparation, exclusionCounts, agentReasons, eligibleAdapters) };
  }
  if (String(signingKey).length < 16) {
    preparation.status = "disabled";
    preparation.primary_reason = "replay_signing_unavailable";
    addReplayExclusion(exclusionCounts, agentReasons, "replay_signing_unavailable");
    return { capsule: null, diagnostics: finalizeReplayPreparation(preparation, exclusionCounts, agentReasons, eligibleAdapters) };
  }
  const scope = scopeFor({ run, session });
  const queryDigest = worldGraphDigest(normalizedQuery(run?.query));
  const agentsById = new Map((agents || []).map((agent) => [agent.id, agent]));
  const candidates = [];
  const seenCandidates = new Set();
  let totalBytes = 0;
  const contested = contestedArtifactIds(data);
  const scopedArtifacts = [...(data.worldGraphArtifacts || [])]
    .filter((item) => sameScope(item, scope))
    .sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)));
  preparation.artifacts_in_scope = scopedArtifacts.length;
  const exactRequestArtifacts = scopedArtifacts.filter((item) => item.input_envelope?.query_digest === queryDigest);
  preparation.exact_request_artifacts = exactRequestArtifacts.length;
  if (!exactRequestArtifacts.length) {
    preparation.primary_reason = scopedArtifacts.length ? "request_changed" : "no_matching_result";
    addReplayExclusion(exclusionCounts, agentReasons, preparation.primary_reason);
    return { capsule: null, diagnostics: finalizeReplayPreparation(preparation, exclusionCounts, agentReasons, eligibleAdapters) };
  }
  for (const artifact of exactRequestArtifacts) {
    if (candidates.length >= 24) break;
    const adapter = String(artifact.adapter || artifact.input_envelope?.adapter || "");
    if (!verifyWorldGraphArtifact(artifact)) {
      addReplayExclusion(exclusionCounts, agentReasons, "stored_result_failed_integrity_check", adapter);
      continue;
    }
    if (contested.has(artifact.artifact_id)) {
      addReplayExclusion(exclusionCounts, agentReasons, "stored_results_disagree", adapter);
      continue;
    }
    if (!artifactAgeValid(artifact, now, options)) {
      addReplayExclusion(exclusionCounts, agentReasons, "stored_result_expired", adapter);
      continue;
    }
    if (artifact.effect_policy?.replayable !== true) {
      addReplayExclusion(
        exclusionCounts,
        agentReasons,
        artifact.effect_policy?.reasons?.[0] || "result_requires_fresh_execution",
        adapter
      );
      continue;
    }
    if (
      String(process.env.TCAR_ENGINE_MODE || "simulator").toLowerCase() === "real"
      && !normalizedRuntimeComponentState(artifact.runtime_component_state)
    ) {
      addReplayExclusion(exclusionCounts, agentReasons, "runtime_revision_changed_or_unverified", adapter);
      continue;
    }
    const agent = agentsById.get(artifact.adapter);
    if (!agent || agent.enabled === false || agent.runtime_sync_pending === true) {
      addReplayExclusion(exclusionCounts, agentReasons, "agent_unavailable", adapter);
      continue;
    }
    if (artifact.input_envelope.agent_revision !== agentRevision(agent)) {
      addReplayExclusion(exclusionCounts, agentReasons, "agent_changed", adapter);
      continue;
    }
    if (artifact.input_envelope.source_state_digest !== worldGraphDigest(sourceStateForAgent(agent, documents)) || !sourceStateReplayable(agent, documents)) {
      addReplayExclusion(exclusionCounts, agentReasons, "source_changed_or_unverifiable", adapter);
      continue;
    }
    // Exact repeats must be compared with the memory that preceded the first
    // occurrence of the request. The session now contains the prior request,
    // route outputs, and synthesis, but those are consequences of the result
    // being considered and cannot invalidate that same result.
    const effectiveMemory = exactRepeatAntecedentMemory(run?.query, sharedMemory);
    const memory = memoryState(agent, effectiveMemory);
    const currentMemoryDigest = memory === null ? null : worldGraphDigest(memory);
    if (artifact.input_envelope.memory_digest !== currentMemoryDigest) {
      addReplayExclusion(exclusionCounts, agentReasons, "conversation_context_changed", adapter);
      continue;
    }
    if (artifact.input_envelope.route_options_digest !== worldGraphDigest(routeOptionState(options))) {
      addReplayExclusion(exclusionCounts, agentReasons, "execution_settings_changed", adapter);
      continue;
    }
    const candidateKey = `${artifact.adapter}\0${artifact.envelope_digest}`;
    if (seenCandidates.has(candidateKey)) {
      addReplayExclusion(exclusionCounts, agentReasons, "duplicate_stored_result", adapter);
      continue;
    }
    const candidate = {
      artifact_id: artifact.artifact_id,
      origin_run_id: artifact.origin_run_id,
      created_at: artifact.created_at,
      freshness_anchor_at: artifact.freshness_anchor_at || artifact.created_at,
      input_envelope: artifact.input_envelope,
      output_digest: artifact.output_digest,
      replay_output: artifact.replay_output,
      runtime_component_state: artifact.runtime_component_state || null,
      record_hash: artifact.record_hash
    };
    const bytes = Buffer.byteLength(JSON.stringify(candidate), "utf8");
    if (bytes > MAX_REPLAY_BYTES || totalBytes + bytes > MAX_CAPSULE_BYTES) {
      addReplayExclusion(exclusionCounts, agentReasons, "replay_payload_too_large", adapter);
      continue;
    }
    totalBytes += bytes;
    seenCandidates.add(candidateKey);
    candidates.push(candidate);
    eligibleAdapters.add(adapter);
  }
  const issuedAt = new Date(now).toISOString();
  const capsule = {
    schema_version: WORLD_GRAPH_SCHEMA_VERSION,
    engine_revision: WORLD_GRAPH_ENGINE_REVISION,
    capsule_id: makeId("wg_capsule"),
    issued_at: issuedAt,
    expires_at: new Date(now + 5 * 60 * 1000).toISOString(),
    scope: {
      target_run_id: run.run_id,
      workspace_id: scope.workspace_id,
      user_id: scope.created_by,
      session_id: scope.session_id,
      agent_workspace_id: scope.agent_workspace_id
    },
    query_digest: queryDigest,
    candidates
  };
  // Candidate-byte accounting alone omits the signed capsule's scope,
  // timestamps, separators, and field names. Enforce the documented limit on
  // the complete signed payload, removing the lowest-priority (latest appended)
  // candidates until the exact transport bytes fit.
  while (candidates.length && Buffer.byteLength(JSON.stringify(capsule), "utf8") > MAX_CAPSULE_BYTES) {
    const removed = candidates.pop();
    addReplayExclusion(exclusionCounts, agentReasons, "replay_payload_too_large", removed?.replay_output?.adapter);
  }
  eligibleAdapters.clear();
  for (const candidate of candidates) {
    eligibleAdapters.add(String(candidate?.replay_output?.adapter || candidate?.input_envelope?.adapter || ""));
  }
  preparation.eligible_candidates = candidates.length;
  if (!candidates.length) {
    return { capsule: null, diagnostics: finalizeReplayPreparation(preparation, exclusionCounts, agentReasons, eligibleAdapters) };
  }
  // Transport the exact bytes that were signed. Re-serializing this object in
  // Python would otherwise change valid IEEE-754 spellings (for example
  // 0.000001 to 1e-06). No unsigned mirror fields are exposed on the wrapper,
  // so there is only one authoritative representation to parse.
  const signedPayload = JSON.stringify(capsule);
  const signature = crypto.createHmac("sha256", String(signingKey))
    .update(WORLD_GRAPH_CAPSULE_SIGNATURE_DOMAIN, "utf8")
    .update(WORLD_GRAPH_CAPSULE_ENCODING, "utf8")
    .update("\n", "utf8")
    .update(signedPayload, "utf8")
    .digest("hex");
  const wrapper = {
    encoding: WORLD_GRAPH_CAPSULE_ENCODING,
    signed_payload: signedPayload,
    signature
  };
  // Keep local authorization metadata out of the transport envelope. Only the
  // exact wrapper bytes cross the network, while the caller can still bind a
  // runtime reuse claim to candidates from this specific in-process capsule.
  replayCapsulePayloads.set(wrapper, capsule);
  return {
    capsule: wrapper,
    diagnostics: finalizeReplayPreparation(preparation, exclusionCounts, agentReasons, eligibleAdapters)
  };
}

export function worldGraphReplayCapsule(options) {
  return prepareWorldGraphReplay(options).capsule;
}

export function worldGraphReplayCandidateIds(wrapper) {
  const payload = wrapper && typeof wrapper === "object" ? replayCapsulePayloads.get(wrapper) : null;
  return Array.isArray(payload?.candidates)
    ? payload.candidates.map((candidate) => String(candidate?.artifact_id || "")).filter(Boolean)
    : [];
}

export function deleteWorldGraphDataForOwner(data, { workspace_id, user_id, sessionIds = null }) {
  const beforeArtifacts = (data.worldGraphArtifacts || []).length;
  const beforeEvents = (data.worldGraphEvents || []).length;
  const owns = (item) => item.workspace_id === workspace_id && item.created_by === user_id
    && (!sessionIds || sessionIds.has(item.session_id));
  data.worldGraphArtifacts = (data.worldGraphArtifacts || []).filter((item) => !owns(item));
  data.worldGraphEvents = (data.worldGraphEvents || []).filter((item) => !owns(item));
  return {
    artifacts: beforeArtifacts - data.worldGraphArtifacts.length,
    events: beforeEvents - data.worldGraphEvents.length
  };
}

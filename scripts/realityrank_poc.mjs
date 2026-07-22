#!/usr/bin/env node
/* global AbortController, clearTimeout, console, fetch, FormData, process, setTimeout, URL, URLSearchParams */

import { Blob, Buffer } from "node:buffer";
import crypto from "node:crypto";
import fs from "node:fs/promises";

const REPORT_SCHEMA = "virenis-realityrank-poc-v1";
const CUE = "shipment disposition";
const DOMAIN = "cold_chain_disposition";
const TASK_TYPE = "shipment_release";
const POC_CHAT_LIMITS = Object.freeze({
  planner_max_tokens: 128,
  max_tokens: 192,
  refiner_max_tokens: 256
});
const POC_DOCUMENT_CHAT_LIMITS = Object.freeze({
  ...POC_CHAT_LIMITS,
  max_tokens: 384,
  refiner_max_tokens: 320
});
const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "cancelled"]);
const STABILITY_FIXTURE_URL = new URL("../fixtures/cold_chain_stability_guide.pdf", import.meta.url);
const TELEMETRY_FIXTURE_URL = new URL("../fixtures/cold_chain_telemetry.md", import.meta.url);

class ProofFailure extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "ProofFailure";
    this.details = details;
  }
}

class ApiFailure extends ProofFailure {
  constructor(message, details = {}) {
    super(message, details);
    this.name = "ApiFailure";
    this.status = details.status || null;
  }
}

function usage() {
  return [
    "virenis RealityRank API proof of concept",
    "",
    "Usage:",
    "  VIRN_BASE_URL=https://virenis.example \\",
    "  VIRN_API_TOKEN=<bound-admin-resolver-token> \\",
    "  VIRN_CREATOR_API_TOKEN=<ordinary-same-workspace-user-token> \\",
    "  node web/virenis/scripts/realityrank_poc.mjs [--keep]",
    "",
    "Options:",
    "  --keep   Keep all generated documents and route agents.",
    "  --help   Show this help text.",
    "",
    "Optional tuning:",
    "  VIRN_ALLOW_INSECURE_HTTP  Set to 1 only for trusted non-loopback HTTP tests.",
    "  VIRN_REQUEST_ORIGIN       Public browser origin when transport uses an internal URL.",
    "  VIRN_CREATOR_API_TOKEN    Required ordinary creator distinct from the bound admin resolver.",
    "  VIRN_SECONDARY_API_TOKEN  Optional different-workspace user token for tenant isolation.",
    "  VIRN_REQUEST_TIMEOUT_MS  Per-request timeout (default: 15000).",
    "  VIRN_POLL_TIMEOUT_MS     Per-run polling timeout (default: 120000).",
    "  VIRN_POLL_INTERVAL_MS    Poll interval (default: 200).",
    "  VIRN_OUTCOME_WAIT_MS     Outcome due-time window (default: 500)."
  ].join("\n");
}

function parseArgs(argv) {
  const accepted = new Set(["--keep", "--help", "-h"]);
  const unknown = argv.filter((arg) => !accepted.has(arg));
  if (unknown.length > 0) {
    throw new ProofFailure(`Unknown argument(s): ${unknown.join(", ")}`, { unknown });
  }
  return {
    help: argv.includes("--help") || argv.includes("-h"),
    keep: argv.includes("--keep")
  };
}

function positiveIntegerEnv(name, defaultValue, { min = 1, max = 900_000 } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return defaultValue;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new ProofFailure(`${name} must be an integer from ${min} to ${max}.`, { supplied: raw });
  }
  return value;
}

function normalizeBaseUrl(value) {
  const supplied = String(value || "").trim();
  if (!supplied) {
    throw new ProofFailure("VIRN_BASE_URL is required.");
  }
  let parsed;
  try {
    parsed = new URL(supplied);
  } catch {
    throw new ProofFailure("VIRN_BASE_URL must be an absolute HTTP(S) URL.", { supplied });
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new ProofFailure("VIRN_BASE_URL must be an absolute HTTP(S) URL without credentials, query, or fragment.", {
      supplied
    });
  }
  return parsed.toString().replace(/\/+$/, "");
}

function normalizeRequestOrigin(value, fallback) {
  const supplied = String(value || fallback || "").trim();
  let parsed;
  try {
    parsed = new URL(supplied);
  } catch {
    throw new ProofFailure("VIRN_REQUEST_ORIGIN must be an absolute HTTP(S) origin.", { supplied });
  }
  if (
    !["http:", "https:"].includes(parsed.protocol)
    || parsed.username
    || parsed.password
    || parsed.pathname !== "/"
    || parsed.search
    || parsed.hash
  ) {
    throw new ProofFailure("VIRN_REQUEST_ORIGIN must contain only scheme, host, and optional port.", { supplied });
  }
  return parsed.origin;
}

function isLoopbackHost(hostname) {
  const normalized = String(hostname || "").toLowerCase();
  return normalized === "localhost"
    || normalized === "::1"
    || normalized === "[::1]"
    || normalized === "127.0.0.1"
    || normalized.startsWith("127.");
}

function assertSecureBearerTransport(baseUrl, token, allowInsecure) {
  if (!token) return;
  const parsed = new URL(baseUrl);
  if (parsed.protocol === "https:" || isLoopbackHost(parsed.hostname) || allowInsecure === "1") return;
  throw new ProofFailure(
    "Bearer credentials require HTTPS for non-loopback targets. Set VIRN_ALLOW_INSECURE_HTTP=1 only for an explicitly trusted test target.",
    { protocol: parsed.protocol, hostname: parsed.hostname }
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function uniqueProofId() {
  return `rr_${Date.now().toString(36)}_${crypto.randomBytes(5).toString("hex")}`;
}

function encodeId(value) {
  return encodeURIComponent(String(value));
}

function queryPath(path, params) {
  const query = new URLSearchParams(
    Object.entries(params).filter(([, value]) => value !== undefined && value !== null)
  );
  return `${path}?${query.toString()}`;
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value === undefined ? null : value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, canonicalValue(value[key])])
  );
}

function digestValue(value) {
  return `sha256:${crypto.createHash("sha256").update(JSON.stringify(canonicalValue(value)), "utf8").digest("hex")}`;
}

function sha256ByteDigest(value) {
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}

function runtimeDigestValue(value) {
  return crypto.createHash("sha256")
    .update("json\0", "utf8")
    .update(runtimeCanonicalJson(value), "utf8")
    .digest("hex");
}

function runtimeCanonicalJson(value) {
  const json = JSON.stringify(canonicalValue(value));
  if (json === undefined) throw new ProofFailure("Runtime audit material is not JSON serializable.");
  return [...json].map((character) => {
    const code = character.codePointAt(0);
    if (code < 0x80) return character;
    if (code <= 0xffff) return `\\u${code.toString(16).padStart(4, "0")}`;
    const adjusted = code - 0x10000;
    const high = 0xd800 + (adjusted >> 10);
    const low = 0xdc00 + (adjusted & 0x3ff);
    return `\\u${high.toString(16)}\\u${low.toString(16)}`;
  }).join("");
}

function runtimeReceiptHashValid(receipt) {
  if (!receipt || typeof receipt !== "object" || !receipt.payload || typeof receipt.payload !== "object") {
    return false;
  }
  const payloadDigest = runtimeDigestValue(receipt.payload);
  const material = {
    created_at: receipt.created_at,
    event_id: receipt.event_id ?? null,
    event_type: receipt.event_type,
    execution_id: receipt.execution_id ?? null,
    payload_sha256: payloadDigest,
    previous_hash: receipt.previous_hash,
    receipt_id: receipt.receipt_id,
    schema_version: receipt.schema_version,
    subject_id: receipt.subject_id,
    subject_sequence: receipt.subject_sequence,
    subject_type: receipt.subject_type
  };
  return Number.isSafeInteger(receipt.subject_sequence)
    && receipt.subject_sequence >= 1
    && /^[a-f0-9]{64}$/.test(String(receipt.previous_hash || ""))
    && /^[a-f0-9]{64}$/.test(String(receipt.payload_sha256 || ""))
    && /^[a-f0-9]{64}$/.test(String(receipt.receipt_hash || ""))
    && receipt.payload_sha256 === payloadDigest
    && receipt.receipt_hash === runtimeDigestValue(material);
}

function runtimeReceiptChainValid(receipts, { subjectType, subjectId, headHash }) {
  if (!Array.isArray(receipts)) return false;
  const ordered = [...receipts].sort(
    (left, right) => Number(left?.subject_sequence) - Number(right?.subject_sequence)
  );
  let previousHash = "0".repeat(64);
  for (let index = 0; index < ordered.length; index += 1) {
    const receipt = ordered[index];
    if (
      receipt?.subject_type !== subjectType
      || receipt?.subject_id !== subjectId
      || Number(receipt?.subject_sequence) !== index + 1
      || receipt?.previous_hash !== previousHash
      || !runtimeReceiptHashValid(receipt)
    ) {
      return false;
    }
    previousHash = receipt.receipt_hash;
  }
  return previousHash === headHash;
}

function runtimeAuditReceiptValid(receipt, { subjectId, eventType, sourceText, identity }) {
  const actor = runtimeCanonicalJson({
    role: identity?.role,
    user_id: identity?.user_id,
    workspace_id: identity?.workspace_id
  });
  return runtimeReceiptHashValid(receipt)
    && receipt.subject_type === "agent"
    && receipt.subject_id === subjectId
    && receipt.event_type === eventType
    && receipt.payload.actor_sha256 === runtimeDigestValue(actor)
    && receipt.payload.source_text_sha256 === runtimeDigestValue(sourceText);
}

function runtimeAgentAuditProofValid(proof, { subjectId, sourceText, identity }) {
  const receipt = proof?.registration_receipt;
  const current = proof?.current_runtime_revision;
  const head = proof?.current_head_receipt;
  return proof?.ok === true
    && proof?.binding_valid === true
    && proof?.agent?.id === subjectId
    && proof?.agent?.created_by === identity?.user_id
    && proof?.agent?.workspace_id === identity?.workspace_id
    && runtimeAuditReceiptValid(receipt, { subjectId, eventType: "agent.registered", sourceText, identity })
    && receipt.payload?.agent_spec_sha256 === runtimeDigestValue(proof?.agent_spec_material)
    && current?.revision_authority === "runtime"
    && digestTextEqual(receipt.payload?.agent_revision, current?.agent_revision)
    && digestTextEqual(receipt.payload?.adapter_content_digest, current?.adapter_content_digest)
    && digestTextEqual(receipt.payload?.manifest_contract_digest, current?.manifest_contract_digest)
    && proof?.registration_binding?.receipt_hash === receipt.receipt_hash
    && proof?.registration_binding?.payload_sha256 === receipt.payload_sha256
    && proof?.subject_chain?.ok === true
    && proof?.subject_chain?.subject_type === "agent"
    && proof?.subject_chain?.subject_id === subjectId
    && Number(proof?.subject_chain?.receipts) === proof?.receipts?.length
    && runtimeReceiptChainValid(proof?.receipts, {
      subjectType: "agent",
      subjectId,
      headHash: proof?.subject_chain?.head_hash
    })
    && runtimeReceiptHashValid(head)
    && head?.receipt_hash === proof?.subject_chain?.head_hash
    && digestTextEqual(head?.payload?.agent_revision, current?.agent_revision)
    && digestTextEqual(head?.payload?.adapter_content_digest, current?.adapter_content_digest)
    && digestTextEqual(head?.payload?.manifest_contract_digest, current?.manifest_contract_digest)
    && !Object.keys(proof?.agent_spec_material || {}).some((key) => key.startsWith("registration_"));
}

function runtimeExecutionAuditProofValid(proof, execution) {
  const receipt = proof?.receipt;
  const actor = execution?.created_by && execution?.actor_role && execution?.workspace_id
    ? runtimeCanonicalJson({
      role: execution.actor_role,
      user_id: execution.created_by,
      workspace_id: execution.workspace_id
    })
    : null;
  return proof?.ok === true
    && proof?.binding_valid === true
    && runtimeReceiptHashValid(receipt)
    && receipt.subject_type === "execution"
    && receipt.execution_id === execution?.runtime_execution_id
    && digestTextEqual(receipt.receipt_hash, execution?.runtime_record_hash)
    && digestTextEqual(receipt.payload?.request_sha256, execution?.runtime_request_fingerprint)
    && receipt.payload?.actor_sha256 === (actor ? runtimeDigestValue(actor) : null)
    && proof?.execution?.execution_id === execution?.execution_id
    && proof?.execution?.run_id === execution?.run_id
    && proof?.execution?.created_by === execution?.created_by
    && proof?.execution?.actor_role === execution?.actor_role
    && proof?.subject_chain?.ok === true
    && proof?.subject_chain?.subject_type === "execution"
    && proof?.subject_chain?.subject_id === execution?.workspace_id
    && Number(proof?.subject_chain?.receipts) >= Number(receipt.subject_sequence);
}

function digestTextEqual(left, right) {
  const normalizedLeft = String(left || "").toLowerCase().replace(/^sha256:/, "");
  const normalizedRight = String(right || "").toLowerCase().replace(/^sha256:/, "");
  return /^[a-f0-9]{64}$/.test(normalizedLeft) && normalizedLeft === normalizedRight;
}

function compactRuntimeReceipt(receipt) {
  if (!receipt || typeof receipt !== "object") return null;
  return {
    receipt_id: receipt.receipt_id,
    subject_type: receipt.subject_type,
    subject_id: receipt.subject_id,
    subject_sequence: receipt.subject_sequence,
    event_type: receipt.event_type,
    previous_hash: receipt.previous_hash,
    payload_sha256: receipt.payload_sha256,
    receipt_hash: receipt.receipt_hash
  };
}

function stableEvidenceId(citation) {
  return digestValue({
    agent_id: citation?.agent_id || null,
    chunk_id: citation?.chunk_id || null,
    page_start: citation?.page_start ?? null,
    page_end: citation?.page_end ?? null,
    content_digest: citation?.content_digest || null,
    corpus_revision: citation?.corpus_revision || null,
    index_digest: citation?.index_digest || null,
    excerpt: citation?.excerpt || ""
  });
}

function approximatelyEqual(left, right, epsilon = 0.000001) {
  return Number.isFinite(Number(left))
    && Number.isFinite(Number(right))
    && Math.abs(Number(left) - Number(right)) <= epsilon;
}

function unsignedExecutionRecord(execution = {}) {
  const unsigned = { ...execution };
  delete unsigned.record_hash;
  delete unsigned.record_hash_valid;
  return unsigned;
}

function executionMatchesRun(execution, run) {
  const suppliedHash = execution?.record_hash;
  const unsigned = unsignedExecutionRecord(execution);
  return execution?.record_hash_valid === true
    && digestValue(unsigned) === suppliedHash
    && execution?.schema_version === "virenis-execution-v1"
    && execution?.execution_id === run?.execution?.execution_id
    && execution?.run_id === run?.run_id
    && execution?.session_id === run?.session_id
    && execution?.status === run?.status
    && /^sha256:[a-f0-9]{64}$/.test(String(execution?.record_hash || ""));
}

function verifyHashChain(events, hashField, previousField) {
  let previous = null;
  for (const event of events || []) {
    const { [hashField]: supplied, ...unsigned } = event || {};
    if (!supplied || unsigned[previousField] !== previous || digestValue(unsigned) !== supplied) return false;
    previous = supplied;
  }
  return true;
}

function planIsAcyclic(plan = {}) {
  const steps = Array.isArray(plan.steps) ? plan.steps : [];
  const ids = new Set(steps.map((step) => String(step?.id || "")).filter(Boolean));
  const remaining = new Set(ids);
  const dependencies = new Map(steps.map((step) => [
    String(step?.id || ""),
    new Set((step?.depends_on || []).map(String).filter((dependency) => ids.has(dependency)))
  ]));
  while (remaining.size > 0) {
    const ready = [...remaining].filter((stepId) => (
      ![...(dependencies.get(stepId) || [])].some((dependency) => remaining.has(dependency))
    ));
    if (ready.length === 0) return false;
    ready.forEach((stepId) => remaining.delete(stepId));
  }
  return steps.length > 0;
}

function outcomeDefinitionMaterial(contract = {}) {
  return {
    contract_id: contract.contract_id,
    schema_version: contract.schema_version,
    scoring_version: contract.scoring_version,
    execution_id: contract.execution_id,
    run_id: contract.run_id,
    session_id: contract.session_id,
    workspace_id: contract.workspace_id,
    created_by: contract.created_by,
    visibility: contract.visibility,
    idempotency_key: contract.idempotency_key,
    request_digest: contract.request_digest,
    title: contract.title,
    claim: contract.claim,
    domain: contract.domain,
    task_type: contract.task_type,
    outcome_type: contract.outcome_type,
    resolver: contract.resolver,
    resolution: contract.resolution,
    participants: contract.participants,
    evidence_ids: contract.evidence_ids,
    execution_record_hash: contract.execution_record_hash,
    created_at: contract.created_at
  };
}

function settlementHashesValid(settlements = []) {
  return settlements.every((settlement, index) => {
    const { settlement_hash: supplied, ...unsigned } = settlement || {};
    const expectedPrior = index === 0 ? null : settlements[index - 1]?.settlement_id;
    return Boolean(supplied)
      && digestValue(unsigned) === supplied
      && (settlement.supersedes_settlement_id || null) === expectedPrior;
  });
}

function disputeHashesValid(disputes = []) {
  return disputes.every((dispute) => {
    const { dispute_hash: supplied, ...unsigned } = dispute || {};
    return Boolean(supplied) && digestValue(unsigned) === supplied;
  });
}

function realExecutionProvenanceValid(execution, runtimeMode, { requireRouter = false } = {}) {
  if (runtimeMode !== "real") return true;
  const digestFields = [
    execution?.runtime_request_fingerprint,
    execution?.runtime_record_hash,
    execution?.base_model_digest,
    execution?.executor_code_digest,
    execution?.component_provenance_digest
  ];
  const routerDigestsValid = !requireRouter || [
    execution?.router_model_digest,
    execution?.router_chat_template_digest
  ].every((value) => /^sha256:[a-f0-9]{64}$/.test(String(value || "")));
  return digestFields.every((value) => /^sha256:[a-f0-9]{64}$/.test(String(value || "")))
    && routerDigestsValid
    && (execution?.participants || []).length > 0
    && execution.participants.every((participant) => (
      /^sha256:[a-f0-9]{64}$/.test(String(participant.agent_revision || ""))
      && /^sha256:[a-f0-9]{64}$/.test(String(participant.adapter_digest || ""))
    ));
}

function includesFacts(value, facts) {
  const normalized = String(value || "").toLowerCase();
  return facts.every((fact) => normalized.includes(String(fact).toLowerCase()));
}

function normalizedExcerptMatches(citationExcerpt, authoritativeExcerpt) {
  const normalize = (value) => String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
  const citation = normalize(citationExcerpt);
  const authoritative = normalize(authoritativeExcerpt);
  if (!citation || !authoritative) return false;
  return authoritative.includes(citation) || citation.includes(authoritative);
}

function sameStringSet(left, right) {
  const leftSet = new Set((left || []).map(String));
  const rightSet = new Set((right || []).map(String));
  return leftSet.size === rightSet.size && [...leftSet].every((value) => rightSet.has(value));
}

function compactRank(rank) {
  return {
    agent_id: rank.agent_id,
    agent_revision: rank.agent_revision,
    score: rank.score,
    sample_size: rank.sample_size,
    effective_sample_size: rank.effective_sample_size,
    average_utility: rank.average_utility,
    status: rank.status,
    routing_eligible: rank.routing_eligible,
    minimum_verified_samples: rank.minimum_verified_samples,
    algorithm: rank.algorithm,
    routing_use: rank.routing_use,
    domain: rank.domain,
    task_type: rank.task_type
  };
}

function compactSelection(selection) {
  return selection ? {
    adapter: selection.adapter,
    source: selection.source,
    confidence: selection.confidence ?? null,
    reality_rank: selection.reality_rank ?? null,
    reason: selection.reason || null
  } : null;
}

function compactCandidate(candidate) {
  return candidate ? {
    adapter: candidate.adapter,
    cue_score: candidate.cue_score ?? null,
    reality_rank: candidate.reality_rank ?? null,
    rank_sample_size: candidate.rank_sample_size ?? null,
    agent_revision: candidate.agent_revision || null,
    rank_supplied: candidate.rank_supplied ?? null
  } : null;
}

function compactParticipant(participant) {
  return participant ? {
    step_id: participant.step_id,
    agent_id: participant.agent_id,
    agent_revision: participant.agent_revision,
    adapter_digest: participant.adapter_digest || null,
    model_id: participant.model_id || null,
    routing: participant.routing ? compactSelection({
      adapter: participant.agent_id,
      ...participant.routing
    }) : null
  } : null;
}

function runAdapters(run) {
  return [...new Set((run.plan?.steps || []).map((step) => step.adapter).filter(Boolean))];
}

function executedAdapters(run) {
  return [...new Set((run.expert_outputs || []).map((step) => step.adapter).filter(Boolean))];
}

function routingSelection(run, agentId) {
  return (run.plan?.routing?.selected || []).find((selection) => selection.adapter === agentId) || null;
}

function routeOutput(run, agentId) {
  return (run.expert_outputs || []).find((step) => step.adapter === agentId) || null;
}

function executionParticipant(execution, agentId) {
  return (execution.participants || []).find((participant) => participant.agent_id === agentId) || null;
}

function predictionEvidence(step, value) {
  const candidates = [
    step?.domain_answer,
    step?.handoffs,
    ...(step?.handoff_artifacts || []).map((artifact) => {
      const artifactValue = artifact?.value ?? artifact?.content ?? artifact?.data;
      return typeof artifactValue === "string" ? artifactValue : JSON.stringify(artifactValue);
    })
  ].filter((candidate) => typeof candidate === "string" && candidate.trim());
  const decimal = String(Number(Number(value).toFixed(4)));
  const percent = `${Number((Number(value) * 100).toFixed(2))}%`;
  for (const candidate of candidates) {
    const lower = candidate.toLowerCase();
    const token = [decimal.toLowerCase(), percent.toLowerCase()].find((item) => lower.includes(item));
    if (!token) continue;
    const tokenIndex = lower.indexOf(token);
    const start = Math.max(0, tokenIndex - 180);
    const end = Math.min(candidate.length, Math.max(tokenIndex + token.length + 180, start + 1));
    return candidate.slice(start, Math.min(end, start + 500)).trim();
  }
  return null;
}

function prove(assertions, claim, condition, evidence) {
  if (!condition) {
    throw new ProofFailure(`Unproven claim: ${claim}`, { claim, evidence });
  }
  assertions.push({ claim, status: "proven", evidence });
}

class VirenisApi {
  constructor({ baseUrl, token, requestOrigin, requestTimeoutMs, proofId }) {
    this.baseUrl = baseUrl;
    this.base = new URL(`${baseUrl}/`);
    this.origin = requestOrigin || this.base.origin;
    this.token = token;
    this.requestTimeoutMs = requestTimeoutMs;
    this.proofId = proofId;
    this.requestCount = 0;
  }

  url(path) {
    return new URL(String(path).replace(/^\/+/, ""), this.base).toString();
  }

  async request(path, {
    method = "GET",
    body,
    multipart = false,
    headers = {},
    expectedStatus = 200,
    allowedStatuses = []
  } = {}) {
    const normalizedMethod = method.toUpperCase();
    const requestHeaders = {
      Accept: "application/json",
      "User-Agent": "virenis-realityrank-poc/1.0",
      "X-Request-ID": `${this.proofId}-${String(++this.requestCount).padStart(3, "0")}`,
      ...headers
    };
    if (this.token) requestHeaders.Authorization = `Bearer ${this.token}`;
    if (!["GET", "HEAD", "OPTIONS"].includes(normalizedMethod)) requestHeaders.Origin = this.origin;
    if (body !== undefined && !multipart) requestHeaders["Content-Type"] = "application/json";

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    let response;
    try {
      response = await fetch(this.url(path), {
        method: normalizedMethod,
        headers: requestHeaders,
        body: body === undefined ? undefined : multipart ? body : JSON.stringify(body),
        signal: controller.signal
      });
    } catch (error) {
      const timedOut = error?.name === "AbortError";
      throw new ApiFailure(
        `${normalizedMethod} ${path} ${timedOut ? `timed out after ${this.requestTimeoutMs}ms` : "failed"}.`,
        { method: normalizedMethod, path, timed_out: timedOut, cause: error?.message || String(error) }
      );
    } finally {
      clearTimeout(timeout);
    }

    const raw = await response.text();
    let payload = null;
    if (raw) {
      try {
        payload = JSON.parse(raw);
      } catch {
        payload = { message: raw.slice(0, 2000) };
      }
    }
    const accepted = new Set([
      ...(Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus]),
      ...allowedStatuses
    ]);
    if (!accepted.has(response.status)) {
      throw new ApiFailure(`${normalizedMethod} ${path} returned HTTP ${response.status}.`, {
        method: normalizedMethod,
        path,
        status: response.status,
        request_id: response.headers.get("x-request-id"),
        response: payload
      });
    }
    return {
      body: payload,
      status: response.status,
      request_id: response.headers.get("x-request-id")
    };
  }
}

const ISOLATION_PROBE_STATUSES = [200, 201, 400, 403, 404, 409, 410];
const OPAQUE_DENIAL_KEYS = new Set(["error", "message", "request_id"]);

function publicIdentity(identity) {
  return {
    user_id: identity?.user_id || null,
    workspace_id: identity?.workspace_id || null,
    role: identity?.role || null,
    auth_type: identity?.auth_type || null,
    is_admin: identity?.is_admin === true,
    is_viewer: identity?.is_viewer === true
  };
}

function opaqueMissingDenial(response, protectedValues) {
  const responseBody = response?.body;
  if (
    response?.status !== 404
    || !responseBody
    || typeof responseBody !== "object"
    || Array.isArray(responseBody)
  ) {
    return false;
  }
  const responseKeys = Object.keys(responseBody).sort();
  const serialized = JSON.stringify(responseBody);
  return responseKeys.length > 0
    && responseKeys.every((key) => OPAQUE_DENIAL_KEYS.has(key))
    && responseKeys.every((key) => typeof responseBody[key] === "string")
    && protectedValues.every((value) => !serialized.includes(String(value)));
}

async function isolationProbe(api, path, options = {}) {
  return api.request(path, {
    ...options,
    expectedStatus: ISOLATION_PROBE_STATUSES
  });
}

function denialSummary(resource, operation, responses, protectedValues) {
  return {
    resource,
    operation,
    attempts: responses.length,
    statuses: [...new Set(responses.map((response) => response.status))],
    all_opaque_missing: responses.length > 0
      && responses.every((response) => opaqueMissingDenial(response, protectedValues))
  };
}

async function proveTenantIsolation(api, {
  primaryIdentity,
  secondaryIdentity,
  documentIds,
  agentIds,
  historicalRunId,
  executionId,
  contractId,
  settlementPayload
}) {
  const documentList = (await api.request("/api/documents?limit=500&offset=0")).body;
  const agentList = (await api.request("/api/agents?limit=500&offset=0")).body;
  const visibleDocumentIds = new Set((documentList?.documents || []).map((document) => document.document_id));
  const visibleAgentIds = new Set((agentList?.agents || []).map((agent) => agent.id));

  const documentGetResponses = await Promise.all(documentIds.map((documentId) =>
    isolationProbe(api, `/api/documents/${encodeId(documentId)}/chunks?limit=1&offset=0`)
  ));
  const agentGetResponses = await Promise.all(agentIds.map((agentId) =>
    isolationProbe(api, `/api/agents/${encodeId(agentId)}`)
  ));
  const runGetResponses = [await isolationProbe(api, `/api/chat/runs/${encodeId(historicalRunId)}`)];
  const executionGetResponses = [await isolationProbe(api, `/api/executions/${encodeId(executionId)}`)];
  const contractGetResponses = [await isolationProbe(api, `/api/outcome-contracts/${encodeId(contractId)}`)];

  const agentPatch = { title: "Cross-tenant mutation probe" };
  const documentDeleteResponses = [];
  for (const documentId of documentIds) {
    documentDeleteResponses.push(await isolationProbe(api, `/api/documents/${encodeId(documentId)}`, { method: "DELETE" }));
  }
  const agentPatchResponses = [];
  for (const agentId of agentIds) {
    agentPatchResponses.push(await isolationProbe(api, `/api/agents/${encodeId(agentId)}`, {
      method: "PATCH",
      body: agentPatch
    }));
  }
  const contractSettleResponses = [await isolationProbe(api, `/api/outcome-contracts/${encodeId(contractId)}/settlements`, {
    method: "POST",
    body: settlementPayload
  })];

  const protectedValues = [...documentIds, ...agentIds, historicalRunId, executionId, contractId];
  const denials = [
    denialSummary("document", "get", documentGetResponses, protectedValues),
    denialSummary("document", "delete", documentDeleteResponses, protectedValues),
    denialSummary("agent", "get", agentGetResponses, protectedValues),
    denialSummary("agent", "patch", agentPatchResponses, protectedValues),
    denialSummary("historical_run", "get", runGetResponses, protectedValues),
    denialSummary("execution_receipt", "get", executionGetResponses, protectedValues),
    denialSummary("outcome_contract", "get", contractGetResponses, protectedValues),
    denialSummary("outcome_contract", "settle", contractSettleResponses, protectedValues)
  ];
  const separatedIdentities = Boolean(primaryIdentity?.user_id)
    && Boolean(primaryIdentity?.workspace_id)
    && Boolean(secondaryIdentity?.user_id)
    && Boolean(secondaryIdentity?.workspace_id)
    && primaryIdentity.user_id !== secondaryIdentity.user_id
    && primaryIdentity.workspace_id !== secondaryIdentity.workspace_id
    && secondaryIdentity.auth_type === "bearer"
    && secondaryIdentity.is_admin === false
    && secondaryIdentity.is_viewer === false;
  const listIsolation = {
    documents_hidden: documentIds.length === 2 && documentIds.every((documentId) => !visibleDocumentIds.has(documentId)),
    agents_hidden: agentIds.length === 4 && agentIds.every((agentId) => !visibleAgentIds.has(agentId)),
    primary_document_count: documentIds.length,
    primary_agent_count: agentIds.length
  };
  return {
    status: separatedIdentities
      && listIsolation.documents_hidden
      && listIsolation.agents_hidden
      && denials.every((denial) => denial.all_opaque_missing)
      ? "proven"
      : "failed",
    primary_identity: publicIdentity(primaryIdentity),
    secondary_identity: publicIdentity(secondaryIdentity),
    identities_separated: separatedIdentities,
    list_isolation: listIsolation,
    direct_denials: denials
  };
}

async function createAgent(api, spec) {
  return (await api.request("/api/agents", {
    method: "POST",
    expectedStatus: 201,
    body: {
      id: spec.id,
      title: spec.title,
      capability: spec.capability,
      boundary: spec.boundary,
      consumes: ["shipment_context"],
      produces: ["shipment_disposition"],
      routing_cues: [CUE],
      source_text: spec.sourceText,
      visibility: "private"
    }
  })).body;
}

async function uploadDocument(api, {
  agentId,
  title,
  routingCues,
  capability,
  customPrompt,
  fixtureUrl
}) {
  const bytes = await fs.readFile(fixtureUrl);
  const fixtureName = fixtureUrl.pathname.split("/").at(-1);
  const pdf = fixtureName.toLowerCase().endsWith(".pdf");
  const form = new FormData();
  form.set("agent_id", agentId);
  form.set("title", title);
  form.set("routing_cues", routingCues.join(", "));
  form.set("capability", capability);
  form.set("custom_prompt", customPrompt);
  form.set("visibility", "private");
  form.set("max_words", "180");
  form.set("overlap_words", "30");
  form.set("top_k", "3");
  form.set("max_excerpt_chars", "700");
  form.set("file", new Blob([bytes], { type: pdf ? "application/pdf" : "text/markdown" }), fixtureName);
  return (await api.request("/api/documents", {
    method: "POST",
    expectedStatus: 201,
    multipart: true,
    body: form
  })).body;
}

async function createSession(api, title) {
  return (await api.request("/api/chat/sessions", {
    method: "POST",
    expectedStatus: 201,
    body: { title, visibility: "private" }
  })).body;
}

async function runMessage(api, {
  sessionId,
  content,
  options,
  pollTimeoutMs,
  pollIntervalMs
}) {
  const queued = (await api.request(`/api/chat/sessions/${encodeId(sessionId)}/messages`, {
    method: "POST",
    expectedStatus: 202,
    body: { content, options }
  })).body;
  if (!queued?.run_id) {
    throw new ProofFailure("Message response did not contain run_id.", { queued });
  }
  const deadline = Date.now() + pollTimeoutMs;
  let lastStatus = queued.status || "queued";
  while (Date.now() < deadline) {
    const run = (await api.request(`/api/chat/runs/${encodeId(queued.run_id)}`)).body;
    lastStatus = run?.status || lastStatus;
    if (TERMINAL_RUN_STATUSES.has(lastStatus)) {
      if (lastStatus !== "completed") {
        throw new ProofFailure(`Run ${queued.run_id} ended with status ${lastStatus}.`, {
          run_id: queued.run_id,
          status: lastStatus,
          error: run?.error || run?.error_admin_only || null
        });
      }
      return run;
    }
    await sleep(pollIntervalMs);
  }
  throw new ProofFailure(`Run ${queued.run_id} did not complete within ${pollTimeoutMs}ms.`, {
    run_id: queued.run_id,
    last_status: lastStatus
  });
}

async function fetchRank(api, agentId) {
  return (await api.request(queryPath(`/api/agents/${encodeId(agentId)}/reality-rank`, {
    domain: DOMAIN,
    task_type: TASK_TYPE
  }))).body;
}

async function fetchExecution(api, run) {
  const executionId = run?.execution?.execution_id;
  if (!executionId) {
    throw new ProofFailure(`Completed run ${run?.run_id || "unknown"} has no execution receipt.`, {
      run_id: run?.run_id,
      execution: run?.execution || null
    });
  }
  return (await api.request(`/api/executions/${encodeId(executionId)}`)).body;
}

async function fetchRuntimeExecutionProof(adminApi, execution) {
  return (await adminApi.request(
    `/api/admin/executions/${encodeId(execution.execution_id)}/runtime-proof`
  )).body;
}

async function fetchRuntimeAgentAudit(adminApi, agentId) {
  return (await adminApi.request(`/api/admin/agents/${encodeId(agentId)}/runtime-audit`)).body;
}

async function runtimeExecutionProof(adminApi, execution, required) {
  const proof = required ? await fetchRuntimeExecutionProof(adminApi, execution) : null;
  return {
    proof,
    valid: required ? runtimeExecutionAuditProofValid(proof, execution) : null
  };
}

async function executeProof({ api, adminApi, secondaryApi, proofId, pollTimeoutMs, pollIntervalMs, outcomeWaitMs, state }) {
  const assertions = state.assertions;
  const startedAt = new Date().toISOString();
  const suffix = proofId.replace(/^rr_/, "");
  const favored = {
    id: `rr_rules_${suffix}`,
    title: `Rules-first disposition ${suffix}`,
    capability: "For the controlled cold-chain proof, predicts shipment disposition and states release probability 0.9 exactly with the retrieved source citation.",
    boundary: "Use only the synthetic POC shipment rule. For this controlled question, return one sentence with probability 0.9 and the exact retrieved chunk citation at the end; do not omit the citation.",
    sourceText: `Controlled POC rule: for this shipment disposition, release probability 0.9 follows pharmacist review. Required controlled answer format: Shipment disposition is release with probability 0.9 following pharmacist review [rr_rules_${suffix}_0001].`
  };
  const lower = {
    id: `rr_legacy_${suffix}`,
    title: `Legacy disposition ${suffix}`,
    capability: "For the controlled cold-chain proof, predicts shipment disposition and states release probability 0.1 exactly with the retrieved source citation.",
    boundary: "Use only the synthetic POC shipment rule. For this controlled question, return one sentence with probability 0.1 and the exact retrieved chunk citation at the end; do not omit the citation.",
    sourceText: `Controlled POC rule: for this shipment disposition, release probability 0.1 follows pharmacist review. Required controlled answer format: Shipment disposition is release with probability 0.1 following pharmacist review [rr_legacy_${suffix}_0001].`
  };
  const stabilityDocument = {
    agentId: `rr_stability_${suffix}`,
    title: `Cold Chain Stability Guide ${suffix}`,
    routingCues: ["cold chain stability", "stability threshold", "CT-204"],
    capability: "Retrieves the synthetic CT-204 cold-chain stability and disposition rules with citations.",
    customPrompt: "Answer only from retrieved stability-guide chunks. In DOMAIN_ANSWER, write one concise sentence containing the 45-minute and 12 C quarantine condition plus the pharmacist-release requirement, then put the supporting chunk citation immediately at the end of that same sentence. Do not add an uncited lead-in or a rejection list.",
    fixtureUrl: STABILITY_FIXTURE_URL
  };
  const telemetryDocument = {
    agentId: `rr_telemetry_${suffix}`,
    title: `Cold Chain Telemetry ${suffix}`,
    routingCues: ["cold chain telemetry", "temperature excursion", "CT-204"],
    capability: "Retrieves the synthetic CT-204 temperature telemetry with citations.",
    customPrompt: "Answer only from retrieved telemetry chunks. In DOMAIN_ANSWER, write one concise sentence containing the 28-minute excursion and 10.4 C peak, then put the supporting chunk citation immediately at the end of that same sentence. Do not add an uncited lead-in or extra list items.",
    fixtureUrl: TELEMETRY_FIXTURE_URL
  };
  state.candidateAgentIds.push(
    stabilityDocument.agentId,
    telemetryDocument.agentId,
    favored.id,
    lower.id
  );
  state.documentAgentIds.push(stabilityDocument.agentId, telemetryDocument.agentId);
  state.promptAgentIds.push(favored.id, lower.id);

  state.phase = "target_discovery";
  const health = (await api.request("/healthz")).body;
  const identity = (await api.request("/api/auth/me")).body;
  const resolverIdentity = (await adminApi.request("/api/auth/me")).body;
  let secondaryIdentity = null;
  if (secondaryApi) {
    secondaryIdentity = (await secondaryApi.request("/api/auth/me")).body;
    const validSecondaryIdentity = Boolean(secondaryIdentity?.user_id)
      && Boolean(secondaryIdentity?.workspace_id)
      && secondaryIdentity.user_id !== identity?.user_id
      && secondaryIdentity.workspace_id !== identity?.workspace_id
      && secondaryIdentity.auth_type === "bearer"
      && secondaryIdentity.is_admin === false
      && secondaryIdentity.is_viewer === false;
    if (!validSecondaryIdentity) {
      throw new ProofFailure(
        "VIRN_SECONDARY_API_TOKEN must authenticate an ordinary user in a different user and workspace from the creator identity.",
        {
          creator_identity: publicIdentity(identity),
          secondary_identity: publicIdentity(secondaryIdentity)
        }
      );
    }
  }
  prove(assertions, "an ordinary creator and a distinct bound administrator share the proof workspace", (
    health?.ok === true
    && identity?.role === "user"
    && identity?.is_admin === false
    && identity?.is_viewer === false
    && Boolean(identity?.user_id)
    && Boolean(identity?.workspace_id)
    && identity?.auth_type === "bearer"
    && resolverIdentity?.is_admin === true
    && resolverIdentity?.role === "admin"
    && resolverIdentity?.auth_type === "bearer"
    && resolverIdentity?.workspace_id === identity?.workspace_id
    && resolverIdentity?.user_id !== identity?.user_id
    && adminApi.token !== api.token
  ), {
    service: health?.service,
    runtime_mode: health?.runtime_mode,
    creator_identity: publicIdentity(identity),
    resolver_identity: publicIdentity(resolverIdentity)
  });

  state.phase = "document_ingestion";
  const stabilityFixtureBytes = await fs.readFile(STABILITY_FIXTURE_URL);
  const telemetryFixtureBytes = await fs.readFile(TELEMETRY_FIXTURE_URL);
  const telemetrySourceText = telemetryFixtureBytes.toString("utf8").replaceAll("\0", "").trim();
  const expectedStabilityUploadDigest = sha256ByteDigest(stabilityFixtureBytes);
  const expectedTelemetryUploadDigest = sha256ByteDigest(telemetryFixtureBytes);
  const expectedTelemetryTextDigest = sha256ByteDigest(Buffer.from(telemetrySourceText, "utf8"));
  const stabilityUpload = await uploadDocument(api, stabilityDocument);
  state.confirmedAgentIds.push(stabilityDocument.agentId);
  state.createdDocuments.push({
    document_id: stabilityUpload.document_id,
    agent_id: stabilityUpload.agent_id
  });
  const telemetryUpload = await uploadDocument(api, telemetryDocument);
  state.confirmedAgentIds.push(telemetryDocument.agentId);
  state.createdDocuments.push({
    document_id: telemetryUpload.document_id,
    agent_id: telemetryUpload.agent_id
  });
  prove(assertions, "two synthetic cold-chain documents were indexed as ready private source agents", (
    stabilityUpload?.status === "indexed"
    && telemetryUpload?.status === "indexed"
    && stabilityUpload?.agent_id === stabilityDocument.agentId
    && telemetryUpload?.agent_id === telemetryDocument.agentId
    && stabilityUpload?.ready === true
    && telemetryUpload?.ready === true
    && Number(stabilityUpload?.chunks) > 0
    && Number(telemetryUpload?.chunks) > 0
    && /^sha256:[a-f0-9]{64}$/.test(stabilityUpload?.corpus_revision || "")
    && /^sha256:[a-f0-9]{64}$/.test(telemetryUpload?.corpus_revision || "")
    && /^sha256:[a-f0-9]{64}$/.test(stabilityUpload?.index_digest || "")
    && /^sha256:[a-f0-9]{64}$/.test(telemetryUpload?.index_digest || "")
    && stabilityUpload?.upload_digest === expectedStabilityUploadDigest
    && telemetryUpload?.upload_digest === expectedTelemetryUploadDigest
    && telemetryUpload?.extracted_text_digest === expectedTelemetryTextDigest
    && telemetryUpload?.source_digest === telemetryUpload?.extracted_text_digest
  ), {
    stability: stabilityUpload,
    telemetry: telemetryUpload
  });

  const uploadedDocumentList = (await api.request(queryPath("/api/documents", { limit: 500, offset: 0 }))).body;
  const adminDocumentList = (await adminApi.request(queryPath("/api/documents", { limit: 500, offset: 0 }))).body;
  const stabilityDocumentSummary = (uploadedDocumentList?.documents || [])
    .find((document) => document.document_id === stabilityUpload.document_id);
  const telemetryDocumentSummary = (uploadedDocumentList?.documents || [])
    .find((document) => document.document_id === telemetryUpload.document_id);
  const stabilityAdminSummary = (adminDocumentList?.documents || [])
    .find((document) => document.document_id === stabilityUpload.document_id);
  const telemetryAdminSummary = (adminDocumentList?.documents || [])
    .find((document) => document.document_id === telemetryUpload.document_id);
  const stabilityDocumentAgent = (await api.request(`/api/agents/${encodeId(stabilityDocument.agentId)}`)).body;
  const telemetryDocumentAgent = (await api.request(`/api/agents/${encodeId(telemetryDocument.agentId)}`)).body;
  prove(assertions, "both document agents are private resources owned by the authenticated workspace user", (
    stabilityDocumentSummary?.visibility === "private"
    && telemetryDocumentSummary?.visibility === "private"
    && stabilityAdminSummary?.source_path?.endsWith(".pdf")
    && stabilityAdminSummary?.page_count === 1
    && stabilityDocumentAgent?.visibility === "private"
    && telemetryDocumentAgent?.visibility === "private"
    && stabilityDocumentAgent?.created_by === identity.user_id
    && telemetryDocumentAgent?.created_by === identity.user_id
    && stabilityDocumentAgent?.workspace_id === identity.workspace_id
    && telemetryDocumentAgent?.workspace_id === identity.workspace_id
  ), {
    identity: { user_id: identity.user_id, workspace_id: identity.workspace_id, auth_type: identity.auth_type },
    stability: {
      document_id: stabilityDocumentSummary?.document_id,
      visibility: stabilityDocumentSummary?.visibility,
      source_path: stabilityAdminSummary?.source_path,
      page_count: stabilityAdminSummary?.page_count,
      agent_owner: stabilityDocumentAgent?.created_by,
      agent_workspace: stabilityDocumentAgent?.workspace_id
    },
    telemetry: {
      document_id: telemetryDocumentSummary?.document_id,
      visibility: telemetryDocumentSummary?.visibility,
      agent_owner: telemetryDocumentAgent?.created_by,
      agent_workspace: telemetryDocumentAgent?.workspace_id
    }
  });

  const runtimeReceiptsRequired = health?.runtime_mode === "real";
  const telemetryDocumentRuntimeAudit = runtimeReceiptsRequired
    ? await fetchRuntimeAgentAudit(adminApi, telemetryDocument.agentId)
    : null;
  const telemetryDocumentRuntimeAuditValid = runtimeReceiptsRequired
    ? runtimeAgentAuditProofValid(telemetryDocumentRuntimeAudit, {
      subjectId: telemetryDocument.agentId,
      sourceText: telemetrySourceText,
      identity
    })
    : null;
  prove(assertions, "a user-created document agent receives a durable independently verifiable Runtime registration chain", (
    !runtimeReceiptsRequired || telemetryDocumentRuntimeAuditValid === true
  ), {
    runtime_mode: health?.runtime_mode,
    required: runtimeReceiptsRequired,
    valid: telemetryDocumentRuntimeAuditValid,
    proof: telemetryDocumentRuntimeAudit
  });

  const stabilitySearch = (await api.request(`/api/documents/${encodeId(stabilityUpload.document_id)}/search`, {
    method: "POST",
    body: { query: "CT-204 excursion duration disposition pharmacist release", top_k: 3 }
  })).body;
  const telemetrySearch = (await api.request(`/api/documents/${encodeId(telemetryUpload.document_id)}/search`, {
    method: "POST",
    body: { query: "CT-204 peak temperature excursion minutes sensor", top_k: 3 }
  })).body;
  const stabilityFactResult = (stabilitySearch?.results || []).find((result) =>
    result.chunk_id
    && result.content_digest
    && result.corpus_revision
    && result.index_digest
    && includesFacts(result.excerpt, ["45", "12", "quarantine"])
  );
  const telemetryFactResult = (telemetrySearch?.results || []).find((result) =>
    result.chunk_id
    && result.content_digest
    && result.corpus_revision
    && result.index_digest
    && includesFacts(result.excerpt, ["28", "10.4", "SN-7741"])
  );
  prove(assertions, "document search returns stable chunk metadata for both corpora", (
    Boolean(stabilityFactResult)
    && Boolean(telemetryFactResult)
  ), {
    stability_results: (stabilitySearch?.results || []).map((result) => ({
      chunk_id: result.chunk_id,
      title: result.title,
      page_start: result.page_start,
      content_digest: result.content_digest,
      corpus_revision: result.corpus_revision,
      index_digest: result.index_digest,
      score: result.score
    })),
    telemetry_results: (telemetrySearch?.results || []).map((result) => ({
      chunk_id: result.chunk_id,
      title: result.title,
      page_start: result.page_start,
      content_digest: result.content_digest,
      corpus_revision: result.corpus_revision,
      index_digest: result.index_digest,
      score: result.score
    }))
  });

  state.phase = "document_evidence_run";
  const evidenceSession = await createSession(api, `Cold-chain evidence ${suffix}`);
  const evidenceQuery = `Ask @${stabilityDocument.agentId} and @${telemetryDocument.agentId}: for synthetic shipment CT-204, what were the excursion duration and peak temperature, and what disposition rule applies? Cite the source chunks.`;
  const evidenceRun = await runMessage(api, {
    sessionId: evidenceSession.session_id,
    content: evidenceQuery,
    options: {
      ...POC_DOCUMENT_CHAT_LIMITS,
      max_routing_adapters: 2,
      parallel_workers: 2
    },
    pollTimeoutMs,
    pollIntervalMs
  });
  const evidencePlanAdapters = runAdapters(evidenceRun);
  const evidenceExecutedAdapters = executedAdapters(evidenceRun);
  prove(assertions, "the first evidence question routes and executes both uploaded document agents", (
    evidencePlanAdapters.includes(stabilityDocument.agentId)
    && evidencePlanAdapters.includes(telemetryDocument.agentId)
    && evidenceExecutedAdapters.includes(stabilityDocument.agentId)
    && evidenceExecutedAdapters.includes(telemetryDocument.agentId)
    && planIsAcyclic(evidenceRun?.plan)
    && evidenceRun?.parallel?.parallelizable === true
    && Number(evidenceRun?.parallel?.maxBatchWidth) >= 2
    && (health.runtime_mode !== "real" || includesFacts(evidenceRun?.final_answer, ["28", "10.4", "quarantine"]))
    && (health.runtime_mode !== "real" || evidenceRun?.plan?.routing?.mode === "session")
  ), {
    run_id: evidenceRun.run_id,
    plan_adapters: evidencePlanAdapters,
    executed_adapters: evidenceExecutedAdapters,
    semantic_routing_mode: evidenceRun?.plan?.routing?.mode || null,
    acyclic: planIsAcyclic(evidenceRun?.plan),
    edges: evidenceRun?.plan?.edges || [],
    parallel: evidenceRun?.parallel || null,
    synthesized_facts_present: includesFacts(evidenceRun?.final_answer, ["28", "10.4", "quarantine"])
  });

  const documentAgentIds = new Set([stabilityDocument.agentId, telemetryDocument.agentId]);
  const evidenceCitations = (evidenceRun.sources || []).filter((source) => documentAgentIds.has(source.agent_id));
  const stabilityCitation = evidenceCitations.find((source) => source.agent_id === stabilityDocument.agentId);
  const telemetryCitation = evidenceCitations.find((source) => source.agent_id === telemetryDocument.agentId);
  const stabilitySearchChunkIds = new Set((stabilitySearch?.results || []).map((result) => result.chunk_id));
  const telemetrySearchChunkIds = new Set((telemetrySearch?.results || []).map((result) => result.chunk_id));
  const stabilityMatchedSearch = (stabilitySearch?.results || [])
    .find((result) => result.chunk_id === stabilityCitation?.chunk_id);
  const telemetryMatchedSearch = (telemetrySearch?.results || [])
    .find((result) => result.chunk_id === telemetryCitation?.chunk_id);
  prove(assertions, "the evidence run returns verified citations with chunk or page metadata from both documents", (
    stabilitySearchChunkIds.has(stabilityCitation?.chunk_id)
    && telemetrySearchChunkIds.has(telemetryCitation?.chunk_id)
    && stabilityCitation?.page_start === 1
    && stabilityCitation?.page_end === 1
    && includesFacts(stabilityCitation?.excerpt, ["45", "12", "quarantine"])
    && includesFacts(telemetryCitation?.excerpt, ["28", "10.4", "SN-7741"])
    && stabilityCitation?.content_digest === stabilityMatchedSearch?.content_digest
    && telemetryCitation?.content_digest === telemetryMatchedSearch?.content_digest
    && stabilityCitation?.corpus_revision === stabilityMatchedSearch?.corpus_revision
    && telemetryCitation?.corpus_revision === telemetryMatchedSearch?.corpus_revision
    && stabilityCitation?.index_digest === stabilityMatchedSearch?.index_digest
    && telemetryCitation?.index_digest === telemetryMatchedSearch?.index_digest
    && normalizedExcerptMatches(stabilityCitation?.excerpt, stabilityMatchedSearch?.excerpt)
    && normalizedExcerptMatches(telemetryCitation?.excerpt, telemetryMatchedSearch?.excerpt)
    && evidenceCitations.every((source) => (
      source.verified === true
      && /^sha256:[a-f0-9]{64}$/.test(source.content_digest || "")
      && /^sha256:[a-f0-9]{64}$/.test(source.corpus_revision || "")
      && /^sha256:[a-f0-9]{64}$/.test(source.index_digest || "")
      && Boolean(source.chunk_id || (Number.isSafeInteger(source.page_start) && source.page_start > 0))
    ))
  ), {
    citations: evidenceCitations.map((source) => ({
      agent_id: source.agent_id,
      citation_id: source.citation_id,
      chunk_id: source.chunk_id,
      title: source.title,
      page_start: source.page_start,
      page_end: source.page_end,
      content_digest: source.content_digest,
      corpus_revision: source.corpus_revision,
      index_digest: source.index_digest,
      verified: source.verified
    }))
  });

  const evidenceExecution = await fetchExecution(api, evidenceRun);
  const stabilityEvidenceParticipant = executionParticipant(evidenceExecution, stabilityDocument.agentId);
  const telemetryEvidenceParticipant = executionParticipant(evidenceExecution, telemetryDocument.agentId);
  const expectedStabilityEvidenceIds = evidenceCitations
    .filter((citation) => citation.agent_id === stabilityDocument.agentId)
    .map(stableEvidenceId);
  const expectedTelemetryEvidenceIds = evidenceCitations
    .filter((citation) => citation.agent_id === telemetryDocument.agentId)
    .map(stableEvidenceId);
  prove(assertions, "the document run has a hashed execution receipt with evidence-bound participants", (
    executionMatchesRun(evidenceExecution, evidenceRun)
    && realExecutionProvenanceValid(evidenceExecution, health.runtime_mode, { requireRouter: true })
    && expectedStabilityEvidenceIds.length > 0
    && expectedTelemetryEvidenceIds.length > 0
    && sameStringSet(stabilityEvidenceParticipant?.evidence_ids, expectedStabilityEvidenceIds)
    && sameStringSet(telemetryEvidenceParticipant?.evidence_ids, expectedTelemetryEvidenceIds)
  ), {
    execution_id: evidenceExecution.execution_id,
    record_hash: evidenceExecution.record_hash,
    participants: [stabilityEvidenceParticipant, telemetryEvidenceParticipant].map((participant) => ({
      agent_id: participant?.agent_id,
      agent_revision: participant?.agent_revision,
      evidence_ids: participant?.evidence_ids || []
    })),
    record_hash_valid: evidenceExecution.record_hash_valid,
    independently_recomputed_record_hash: digestValue(unsignedExecutionRecord(evidenceExecution)),
    component_digests: {
      base_model: evidenceExecution.base_model_digest || null,
      router_model: evidenceExecution.router_model_digest || null,
      router_template: evidenceExecution.router_chat_template_digest || null,
      executor_code: evidenceExecution.executor_code_digest || null,
      component_snapshot: evidenceExecution.component_provenance_digest || null,
      runtime_record: evidenceExecution.runtime_record_hash || null,
      runtime_request: evidenceExecution.runtime_request_fingerprint || null
    },
    expected_evidence_ids: {
      [stabilityDocument.agentId]: expectedStabilityEvidenceIds,
      [telemetryDocument.agentId]: expectedTelemetryEvidenceIds
    }
  });
  const evidenceRuntimeAudit = await runtimeExecutionProof(adminApi, evidenceExecution, runtimeReceiptsRequired);
  prove(assertions, "the evidence run has a recomputed persisted Agent Runtime receipt", (
    !runtimeReceiptsRequired || evidenceRuntimeAudit.valid === true
  ), {
    runtime_mode: health?.runtime_mode,
    required: runtimeReceiptsRequired,
    valid: evidenceRuntimeAudit.valid,
    receipt: evidenceRuntimeAudit.proof?.receipt || null,
    subject_chain: evidenceRuntimeAudit.proof?.subject_chain || null
  });

  state.phase = "agent_creation";
  const favoredCreated = await createAgent(api, favored);
  state.confirmedAgentIds.push(favored.id);
  const lowerCreated = await createAgent(api, lower);
  state.confirmedAgentIds.push(lower.id);
  prove(assertions, "two distinct user agents were created and are API-ready", (
    favoredCreated?.id === favored.id
    && lowerCreated?.id === lower.id
    && favoredCreated?.ready === true
    && lowerCreated?.ready === true
  ), {
    favored: { id: favoredCreated?.id, ready: favoredCreated?.ready, status: favoredCreated?.status },
    lower: { id: lowerCreated?.id, ready: lowerCreated?.ready, status: lowerCreated?.status }
  });

  const favoredDetail = (await api.request(`/api/agents/${encodeId(favored.id)}`)).body;
  const lowerDetail = (await api.request(`/api/agents/${encodeId(lower.id)}`)).body;
  prove(assertions, "both private agents have the same shipment disposition routing cue and owner", (
    favoredDetail?.visibility === "private"
    && lowerDetail?.visibility === "private"
    && favoredDetail?.created_by === identity?.user_id
    && lowerDetail?.created_by === identity?.user_id
    && favoredDetail?.workspace_id === identity?.workspace_id
    && lowerDetail?.workspace_id === identity?.workspace_id
    && JSON.stringify(favoredDetail?.routing_cues) === JSON.stringify([CUE])
    && JSON.stringify(lowerDetail?.routing_cues) === JSON.stringify([CUE])
  ), {
    cue: CUE,
    favored: { id: favored.id, owner: favoredDetail?.created_by, visibility: favoredDetail?.visibility },
    lower: { id: lower.id, owner: lowerDetail?.created_by, visibility: lowerDetail?.visibility }
  });

  const favoredCreationEvents = (await api.request(`/api/agents/${encodeId(favored.id)}/events`)).body;
  const lowerCreationEvents = (await api.request(`/api/agents/${encodeId(lower.id)}/events`)).body;
  const favoredRuntimeAudit = runtimeReceiptsRequired
    ? await fetchRuntimeAgentAudit(adminApi, favored.id)
    : null;
  const lowerRuntimeAudit = runtimeReceiptsRequired
    ? await fetchRuntimeAgentAudit(adminApi, lower.id)
    : null;
  const favoredRuntimeReceipt = favoredRuntimeAudit?.registration_receipt || null;
  const lowerRuntimeReceipt = lowerRuntimeAudit?.registration_receipt || null;
  const favoredRuntimeReceiptValid = runtimeReceiptsRequired
    ? runtimeAgentAuditProofValid(favoredRuntimeAudit, {
      subjectId: favored.id,
      sourceText: favored.sourceText,
      identity
    })
    : null;
  const lowerRuntimeReceiptValid = runtimeReceiptsRequired
    ? runtimeAgentAuditProofValid(lowerRuntimeAudit, {
      subjectId: lower.id,
      sourceText: lower.sourceText,
      identity
    })
    : null;
  prove(assertions, "API-created user agents receive verifiable workspace logs and, in real mode, Runtime receipts", (
    favoredCreationEvents?.event_chain_valid === true
    && lowerCreationEvents?.event_chain_valid === true
    && verifyHashChain(favoredCreationEvents?.events, "event_hash", "previous_event_hash")
    && verifyHashChain(lowerCreationEvents?.events, "event_hash", "previous_event_hash")
    && favoredCreationEvents?.events?.some((event) => event.event_type === "agent.created")
    && lowerCreationEvents?.events?.some((event) => event.event_type === "agent.created")
    && favoredCreated?.runtime === undefined
    && lowerCreated?.runtime === undefined
    && (!runtimeReceiptsRequired || (favoredRuntimeReceiptValid && lowerRuntimeReceiptValid))
  ), {
    runtime_mode: health?.runtime_mode,
    workspace_event_chains: {
      favored: {
        agent_id: favored.id,
        events: favoredCreationEvents?.events?.length,
        valid: favoredCreationEvents?.event_chain_valid === true
      },
      lower: {
        agent_id: lower.id,
        events: lowerCreationEvents?.events?.length,
        valid: lowerCreationEvents?.event_chain_valid === true
      }
    },
    runtime_receipts: {
      required: runtimeReceiptsRequired,
      favored: { valid: favoredRuntimeReceiptValid, receipt: compactRuntimeReceipt(favoredRuntimeReceipt) },
      lower: { valid: lowerRuntimeReceiptValid, receipt: compactRuntimeReceipt(lowerRuntimeReceipt) }
    }
  });

  const initialFavoredRank = await fetchRank(api, favored.id);
  const initialLowerRank = await fetchRank(api, lower.id);
  prove(assertions, "the new agent revisions begin with equal unobserved RealityRank priors", (
    initialFavoredRank?.sample_size === 0
    && initialLowerRank?.sample_size === 0
    && initialFavoredRank?.score === initialLowerRank?.score
    && typeof initialFavoredRank?.agent_revision === "string"
    && typeof initialLowerRank?.agent_revision === "string"
  ), {
    favored: compactRank(initialFavoredRank),
    lower: compactRank(initialLowerRank)
  });

  state.phase = "historical_explicit_run";
  const historicalSession = await createSession(api, `RealityRank history ${suffix}`);
  const historicalQuery = `Ask @${favored.id} and @${lower.id} for the shipment disposition.`;
  const historicalRun = await runMessage(api, {
    sessionId: historicalSession.session_id,
    content: historicalQuery,
    options: {
      ...POC_CHAT_LIMITS,
      max_routing_adapters: 2,
      parallel_workers: 2
    },
    pollTimeoutMs,
    pollIntervalMs
  });
  const historicalPlanAdapters = runAdapters(historicalRun);
  const historicalExecutedAdapters = executedAdapters(historicalRun);
  const historicalFavoredSelection = routingSelection(historicalRun, favored.id);
  const historicalLowerSelection = routingSelection(historicalRun, lower.id);
  const historicalSelections = historicalRun.plan?.routing?.selected || [];
  prove(assertions, "the historical run explicitly selected and executed both agents", (
    historicalPlanAdapters.includes(favored.id)
    && historicalPlanAdapters.includes(lower.id)
    && historicalExecutedAdapters.includes(favored.id)
    && historicalExecutedAdapters.includes(lower.id)
    && historicalSelections.length === 2
    && historicalFavoredSelection?.source === "explicit"
    && historicalLowerSelection?.source === "explicit"
  ), {
    run_id: historicalRun.run_id,
    plan_adapters: historicalPlanAdapters,
    executed_adapters: historicalExecutedAdapters,
    routing: historicalSelections.map(compactSelection)
  });

  const historicalExecution = await fetchExecution(api, historicalRun);
  const historicalFavoredParticipant = executionParticipant(historicalExecution, favored.id);
  const historicalLowerParticipant = executionParticipant(historicalExecution, lower.id);
  prove(assertions, "the historical execution receipt binds the exact current revisions", (
    executionMatchesRun(historicalExecution, historicalRun)
    && historicalFavoredParticipant?.agent_revision === initialFavoredRank.agent_revision
    && historicalLowerParticipant?.agent_revision === initialLowerRank.agent_revision
  ), {
    execution_id: historicalExecution.execution_id,
    record_hash_valid: historicalExecution.record_hash_valid,
    favored: compactParticipant(historicalFavoredParticipant),
    lower: compactParticipant(historicalLowerParticipant)
  });
  const historicalRuntimeProof = runtimeReceiptsRequired
    ? await fetchRuntimeExecutionProof(adminApi, historicalExecution)
    : null;
  const historicalRuntimeProofValid = runtimeReceiptsRequired
    ? runtimeExecutionAuditProofValid(historicalRuntimeProof, historicalExecution)
    : null;
  prove(assertions, "the persisted Agent Runtime execution receipt and workspace chain independently verify against virenis", (
    !runtimeReceiptsRequired || historicalRuntimeProofValid === true
  ), {
    runtime_mode: health?.runtime_mode,
    required: runtimeReceiptsRequired,
    valid: historicalRuntimeProofValid,
    local_execution_id: historicalExecution.execution_id,
    runtime_execution_id: historicalExecution.runtime_execution_id || null,
    receipt: historicalRuntimeProof?.receipt || null,
    subject_chain: historicalRuntimeProof?.subject_chain || null,
    hash_contract: historicalRuntimeProof?.hash_contract || null
  });

  const favoredStep = routeOutput(historicalRun, favored.id);
  const lowerStep = routeOutput(historicalRun, lower.id);
  const favoredEvidence = predictionEvidence(favoredStep, 0.9);
  const lowerEvidence = predictionEvidence(lowerStep, 0.1);
  prove(assertions, "each contract prediction is supported by its recorded route output", (
    Boolean(favoredEvidence) && Boolean(lowerEvidence)
  ), {
    favored_step_id: favoredStep?.step_id,
    lower_step_id: lowerStep?.step_id,
    favored_value: 0.9,
    lower_value: 0.1
  });

  state.phase = "outcome_contract";
  const resolverAuthority = "RealityRank POC Chief Pharmacist";
  const resolverReference = `synthetic-pharmacy-disposition:${suffix}`;
  const dueAt = new Date(Date.now() + outcomeWaitMs).toISOString();
  const contractKey = `${proofId}-contract`;
  const contractPayload = {
    title: `Synthetic shipment ${suffix} disposition`,
    claim: `Synthetic shipment ${suffix} will be released after pharmacist review.`,
    domain: DOMAIN,
    task_type: TASK_TYPE,
    outcome_type: "binary",
    resolver: { type: "human", authority: resolverAuthority, reference: resolverReference },
    resolution: { metric: "released", due_at: dueAt },
    predictions: [
      {
        step_id: favoredStep.step_id,
        value: 0.9,
        confidence: 0.9,
        evidence_quote: favoredEvidence,
        rationale: "Synthetic POC prediction recorded by the rules-first route."
      },
      {
        step_id: lowerStep.step_id,
        value: 0.1,
        confidence: 0.9,
        evidence_quote: lowerEvidence,
        rationale: "Synthetic POC prediction recorded by the legacy route."
      }
    ]
  };
  const contract = (await api.request(`/api/chat/runs/${encodeId(historicalRun.run_id)}/outcome-contracts`, {
    method: "POST",
    expectedStatus: 201,
    headers: { "Idempotency-Key": contractKey },
    body: contractPayload
  })).body;
  const contractReplay = (await api.request(`/api/chat/runs/${encodeId(historicalRun.run_id)}/outcome-contracts`, {
    method: "POST",
    expectedStatus: 201,
    headers: { "Idempotency-Key": contractKey },
    body: contractPayload
  })).body;
  const contractConflict = await api.request(`/api/chat/runs/${encodeId(historicalRun.run_id)}/outcome-contracts`, {
    method: "POST",
    expectedStatus: 409,
    headers: { "Idempotency-Key": contractKey },
    body: { ...contractPayload, claim: `${contractPayload.claim} Altered replay.` }
  });
  const favoredContractParticipant = contract?.participants?.find((participant) => participant.agent_id === favored.id);
  const lowerContractParticipant = contract?.participants?.find((participant) => participant.agent_id === lower.id);
  const expectedFavoredPredictionEvidence = digestValue({
    output_digest: historicalFavoredParticipant.output_digest,
    evidence_quote: favoredEvidence
  });
  const expectedLowerPredictionEvidence = digestValue({
    output_digest: historicalLowerParticipant.output_digest,
    evidence_quote: lowerEvidence
  });
  prove(assertions, "a pending binary Outcome Contract references both executed participants", (
    contract?.status === "pending"
    && contract?.outcome_type === "binary"
    && contract?.run_id === historicalRun.run_id
    && contract?.participants?.length === 2
    && contract?.execution_id === historicalExecution.execution_id
    && contract?.execution_record_hash === historicalExecution.record_hash
    && favoredContractParticipant?.step_id === favoredStep.step_id
    && favoredContractParticipant?.agent_revision === initialFavoredRank.agent_revision
    && favoredContractParticipant?.prediction === 0.9
    && favoredContractParticipant?.prediction_evidence_digest === expectedFavoredPredictionEvidence
    && lowerContractParticipant?.step_id === lowerStep.step_id
    && lowerContractParticipant?.agent_revision === initialLowerRank.agent_revision
    && lowerContractParticipant?.prediction === 0.1
    && lowerContractParticipant?.prediction_evidence_digest === expectedLowerPredictionEvidence
    && contractReplay?.contract_id === contract.contract_id
    && contractReplay?.request_digest === contract.request_digest
    && contractConflict.status === 409
  ), {
    contract_id: contract?.contract_id,
    status: contract?.status,
    outcome_type: contract?.outcome_type,
    execution_id: contract?.execution_id,
    execution_record_hash: contract?.execution_record_hash,
    participants: contract?.participants,
    idempotent_replay_contract_id: contractReplay?.contract_id,
    altered_replay_status: contractConflict.status
  });

  state.phase = "outcome_settlement";
  await sleep(Math.max(0, Date.parse(dueAt) - Date.now() + 10));
  const settlementKey = `${proofId}-settlement`;
  const settlementPayload = {
    actual_value: true,
    source: {
      type: "human",
      authority: resolverAuthority,
      reference: resolverReference
    },
    notes: "Synthetic POC settlement: pharmacist review released the fixture shipment."
  };
  const settled = (await adminApi.request(`/api/outcome-contracts/${encodeId(contract.contract_id)}/settlements`, {
    method: "POST",
    expectedStatus: 201,
    headers: { "Idempotency-Key": settlementKey },
    body: settlementPayload
  })).body;
  const settledReplay = (await adminApi.request(`/api/outcome-contracts/${encodeId(contract.contract_id)}/settlements`, {
    method: "POST",
    expectedStatus: 201,
    headers: { "Idempotency-Key": settlementKey },
    body: settlementPayload
  })).body;
  const settlementConflict = await adminApi.request(`/api/outcome-contracts/${encodeId(contract.contract_id)}/settlements`, {
    method: "POST",
    expectedStatus: 409,
    headers: { "Idempotency-Key": settlementKey },
    body: { ...settlementPayload, notes: `${settlementPayload.notes} Altered replay.` }
  });
  const favoredScore = settled?.settlement?.participant_scores?.find((score) => score.agent_id === favored.id);
  const lowerScore = settled?.settlement?.participant_scores?.find((score) => score.agent_id === lower.id);
  prove(assertions, "the binary contract settled and scored the accurate revision above the inaccurate revision", (
    settled?.status === "settled"
    && settled?.settlement?.actual_value === 1
    && settled?.settlement?.verified_for_rank === true
    && settled?.settlement?.verification_role === "resolver_principal"
    && Boolean(settled?.settlement?.resolver_principal?.principal_id)
    && Number(favoredScore?.utility) > Number(lowerScore?.utility)
    && settledReplay?.settlement?.settlement_id === settled.settlement.settlement_id
    && settledReplay?.settlement?.request_digest === settled.settlement.request_digest
    && settlementConflict.status === 409
  ), {
    contract_id: settled?.contract_id,
    actual_value: settled?.settlement?.actual_value,
    verification_role: settled?.settlement?.verification_role,
    resolver_principal_id: settled?.settlement?.resolver_principal?.principal_id || null,
    favored_score: favoredScore,
    lower_score: lowerScore,
    idempotent_replay_settlement_id: settledReplay?.settlement?.settlement_id,
    altered_replay_status: settlementConflict.status
  });
  const initialSettledRead = (await api.request(`/api/outcome-contracts/${encodeId(contract.contract_id)}`)).body;
  prove(assertions, "the settled Outcome Contract has a valid event chain", (
    initialSettledRead?.status === "settled"
    && initialSettledRead?.event_chain_valid === true
    && digestValue(outcomeDefinitionMaterial(initialSettledRead)) === initialSettledRead?.contract_hash
    && settlementHashesValid(initialSettledRead?.settlements)
    && verifyHashChain(initialSettledRead?.events, "event_hash", "previous_event_hash")
  ), {
    contract_id: initialSettledRead?.contract_id,
    event_chain_valid: initialSettledRead?.event_chain_valid,
    contract_definition_recomputed: digestValue(outcomeDefinitionMaterial(initialSettledRead)),
    settlement_hashes_recomputed: settlementHashesValid(initialSettledRead?.settlements),
    event_chain_recomputed: verifyHashChain(initialSettledRead?.events, "event_hash", "previous_event_hash"),
    event_types: (initialSettledRead?.events || []).map((event) => event.event_type)
  });

  state.phase = "rank_divergence";
  const favoredRank = await fetchRank(api, favored.id);
  const lowerRank = await fetchRank(api, lower.id);
  prove(assertions, "settlement makes the exact agent revision RealityRanks diverge", (
    favoredRank?.sample_size === 1
    && lowerRank?.sample_size === 1
    && favoredRank?.routing_eligible === true
    && lowerRank?.routing_eligible === true
    && favoredRank?.minimum_verified_samples === 1
    && lowerRank?.minimum_verified_samples === 1
    && favoredRank?.agent_revision === initialFavoredRank.agent_revision
    && lowerRank?.agent_revision === initialLowerRank.agent_revision
    && Number(favoredRank?.score) > Number(lowerRank?.score)
  ), {
    favored: compactRank(favoredRank),
    lower: compactRank(lowerRank),
    score_gap: Number((Number(favoredRank?.score) - Number(lowerRank?.score)).toFixed(2))
  });

  state.phase = "outcome_dispute";
  const disputeReason = "The initial synthetic disposition feed is being independently rechecked.";
  const disputed = (await adminApi.request(`/api/outcome-contracts/${encodeId(contract.contract_id)}/disputes`, {
    method: "POST",
    expectedStatus: 201,
    body: {
      reason: disputeReason,
      evidence_digest: historicalExecution.record_hash
    }
  })).body;
  const disputedFavoredRank = await fetchRank(api, favored.id);
  const disputedLowerRank = await fetchRank(api, lower.id);
  prove(assertions, "a dispute immediately withdraws the observation from RealityRank routing without deleting its audit history", (
    disputed?.status === "disputed"
    && disputed?.disputes?.length === 1
    && disputed?.disputes?.[0]?.reason === disputeReason
    && disputedFavoredRank?.sample_size === 0
    && disputedLowerRank?.sample_size === 0
    && disputedFavoredRank?.routing_eligible === false
    && disputedLowerRank?.routing_eligible === false
    && disputed?.settlements?.length === 1
  ), {
    contract_id: disputed?.contract_id,
    status: disputed?.status,
    dispute_id: disputed?.disputes?.[0]?.dispute_id,
    retained_settlement_count: disputed?.settlements?.length,
    favored: compactRank(disputedFavoredRank),
    lower: compactRank(disputedLowerRank)
  });

  state.phase = "outcome_correction";
  const correctionKey = `${proofId}-correction-quarantine`;
  const correctionPayload = {
    supersedes_settlement_id: settled.settlement.settlement_id,
    actual_value: false,
    reason: "Independent synthetic review temporarily corrected the disposition to quarantine.",
    source: settlementPayload.source,
    notes: "Controlled POC correction used to prove score reversal and chained supersession."
  };
  const corrected = (await adminApi.request(`/api/outcome-contracts/${encodeId(contract.contract_id)}/corrections`, {
    method: "POST",
    expectedStatus: 201,
    headers: { "Idempotency-Key": correctionKey },
    body: correctionPayload
  })).body;
  const correctedReplay = (await adminApi.request(`/api/outcome-contracts/${encodeId(contract.contract_id)}/corrections`, {
    method: "POST",
    expectedStatus: 201,
    headers: { "Idempotency-Key": correctionKey },
    body: correctionPayload
  })).body;
  const correctionConflict = await adminApi.request(`/api/outcome-contracts/${encodeId(contract.contract_id)}/corrections`, {
    method: "POST",
    expectedStatus: 409,
    headers: { "Idempotency-Key": correctionKey },
    body: { ...correctionPayload, reason: `${correctionPayload.reason} Altered replay.` }
  });
  const correctedFavoredRank = await fetchRank(api, favored.id);
  const correctedLowerRank = await fetchRank(api, lower.id);
  prove(assertions, "a resolver-bound correction reverses the scores and preserves an idempotent settlement chain", (
    corrected?.status === "settled"
    && corrected?.settlements?.length === 2
    && corrected?.settlement?.supersedes_settlement_id === settled.settlement.settlement_id
    && corrected?.settlement?.verified_for_rank === true
    && corrected?.settlement?.verification_role === "resolver_principal"
    && corrected?.settlement?.actual_value === 0
    && correctedReplay?.settlements?.length === 2
    && correctedReplay?.settlement?.settlement_id === corrected.settlement.settlement_id
    && correctionConflict.status === 409
    && Number(correctedLowerRank?.score) > Number(correctedFavoredRank?.score)
  ), {
    corrected_settlement_id: corrected?.settlement?.settlement_id,
    supersedes_settlement_id: corrected?.settlement?.supersedes_settlement_id,
    settlement_count: corrected?.settlements?.length,
    altered_replay_status: correctionConflict.status,
    favored: compactRank(correctedFavoredRank),
    lower: compactRank(correctedLowerRank)
  });

  const finalCorrectionKey = `${proofId}-correction-release`;
  const finalCorrectionPayload = {
    supersedes_settlement_id: corrected.settlement.settlement_id,
    actual_value: true,
    reason: "Final signed synthetic review confirms pharmacist release.",
    source: settlementPayload.source,
    notes: "Final controlled POC disposition."
  };
  const finalCorrected = (await adminApi.request(`/api/outcome-contracts/${encodeId(contract.contract_id)}/corrections`, {
    method: "POST",
    expectedStatus: 201,
    headers: { "Idempotency-Key": finalCorrectionKey },
    body: finalCorrectionPayload
  })).body;
  const finalFavoredRank = await fetchRank(api, favored.id);
  const finalLowerRank = await fetchRank(api, lower.id);
  const settledRead = (await api.request(`/api/outcome-contracts/${encodeId(contract.contract_id)}`)).body;
  prove(assertions, "the final correction restores the accurate revision and the complete contract remains independently verifiable", (
    finalCorrected?.status === "settled"
    && finalCorrected?.settlements?.length === 3
    && finalCorrected?.settlement?.supersedes_settlement_id === corrected.settlement.settlement_id
    && finalCorrected?.settlement?.actual_value === 1
    && finalFavoredRank?.agent_revision === favoredRank.agent_revision
    && finalLowerRank?.agent_revision === lowerRank.agent_revision
    && Number(finalFavoredRank?.score) > Number(finalLowerRank?.score)
    && digestValue(outcomeDefinitionMaterial(settledRead)) === settledRead?.contract_hash
    && settlementHashesValid(settledRead?.settlements)
    && disputeHashesValid(settledRead?.disputes)
    && verifyHashChain(settledRead?.events, "event_hash", "previous_event_hash")
    && settledRead?.event_chain_valid === true
    && settledRead?.integrity_valid === true
  ), {
    final_settlement_id: finalCorrected?.settlement?.settlement_id,
    settlement_count: finalCorrected?.settlements?.length,
    dispute_count: finalCorrected?.disputes?.length,
    favored: compactRank(finalFavoredRank),
    lower: compactRank(finalLowerRank),
    contract_definition_recomputed: digestValue(outcomeDefinitionMaterial(settledRead)),
    settlement_hashes_recomputed: settlementHashesValid(settledRead?.settlements),
    dispute_hashes_recomputed: disputeHashesValid(settledRead?.disputes),
    event_chain_recomputed: verifyHashChain(settledRead?.events, "event_hash", "previous_event_hash"),
    event_types: (settledRead?.events || []).map((event) => event.event_type)
  });

  state.phase = "implicit_routing";
  const implicitSession = await createSession(api, `RealityRank implicit ${suffix}`);
  const implicitQuery = "Provide a refrigerated shipment disposition decision.";
  const implicitRun = await runMessage(api, {
    sessionId: implicitSession.session_id,
    content: implicitQuery,
    options: {
      ...POC_CHAT_LIMITS,
      max_routing_adapters: 1,
      parallel_workers: 1
    },
    pollTimeoutMs,
    pollIntervalMs
  });
  const implicitSelection = routingSelection(implicitRun, favored.id);
  const implicitAdapters = runAdapters(implicitRun);
  const implicitSelections = implicitRun.plan?.routing?.selected || [];
  const implicitCandidates = implicitRun.plan?.routing?.candidate_trace || [];
  const favoredCandidate = implicitCandidates.find((candidate) => candidate.adapter === favored.id);
  const lowerCandidate = implicitCandidates.find((candidate) => candidate.adapter === lower.id);
  const reportedImplicitAdapters = implicitRun.plan?.routing?.explicit_adapters;
  const noImplicitOverride = Array.isArray(reportedImplicitAdapters)
    ? reportedImplicitAdapters.length === 0
    : !implicitQuery.includes("@") && implicitSelections.every((selection) => selection.source !== "explicit");
  prove(assertions, "the next implicit one-adapter query selects only the better-ranked tied agent via cue+reality_rank", (
    !implicitQuery.includes("@")
    && implicitAdapters.includes(favored.id)
    && !implicitAdapters.includes(lower.id)
    && implicitSelections.length === 1
    && implicitSelection?.adapter === favored.id
    && implicitSelection?.source === "cue+reality_rank"
    && approximatelyEqual(implicitSelection?.reality_rank, finalFavoredRank.score / 100)
    && Number(favoredCandidate?.cue_score) > 0
    && approximatelyEqual(favoredCandidate?.cue_score, lowerCandidate?.cue_score)
    && favoredCandidate?.agent_revision === finalFavoredRank.agent_revision
    && lowerCandidate?.agent_revision === finalLowerRank.agent_revision
    && approximatelyEqual(favoredCandidate?.reality_rank, finalFavoredRank.score / 100)
    && approximatelyEqual(lowerCandidate?.reality_rank, finalLowerRank.score / 100)
    && Number(favoredCandidate?.rank_sample_size) === Number(finalFavoredRank.sample_size)
    && Number(lowerCandidate?.rank_sample_size) === Number(finalLowerRank.sample_size)
    && noImplicitOverride
  ), {
    run_id: implicitRun.run_id,
    max_routing_adapters: 1,
    plan_adapters: implicitAdapters,
    selections: implicitSelections.map(compactSelection),
    tied_candidates: [favoredCandidate, lowerCandidate].map(compactCandidate),
    explicit_adapters: reportedImplicitAdapters ?? null,
    explicit_adapter_field_present: Array.isArray(reportedImplicitAdapters)
  });
  const implicitExecution = await fetchExecution(api, implicitRun);
  const implicitParticipant = executionParticipant(implicitExecution, favored.id);
  prove(assertions, "the implicit execution receipt confirms the winning revision and routing source", (
    executionMatchesRun(implicitExecution, implicitRun)
    && implicitParticipant?.agent_revision === finalFavoredRank.agent_revision
    && implicitParticipant?.routing?.source === "cue+reality_rank"
    && approximatelyEqual(implicitParticipant?.routing?.reality_rank, finalFavoredRank.score / 100)
  ), {
    execution_id: implicitExecution.execution_id,
    record_hash_valid: implicitExecution.record_hash_valid,
    participant: compactParticipant(implicitParticipant)
  });
  const implicitRuntimeAudit = await runtimeExecutionProof(adminApi, implicitExecution, runtimeReceiptsRequired);
  prove(assertions, "the implicit RealityRank route has a recomputed persisted Agent Runtime receipt", (
    !runtimeReceiptsRequired || implicitRuntimeAudit.valid === true
  ), {
    runtime_mode: health?.runtime_mode,
    required: runtimeReceiptsRequired,
    valid: implicitRuntimeAudit.valid,
    receipt: implicitRuntimeAudit.proof?.receipt || null,
    subject_chain: implicitRuntimeAudit.proof?.subject_chain || null
  });

  state.phase = "explicit_override";
  const explicitSession = await createSession(api, `RealityRank override ${suffix}`);
  const explicitQuery = `Ask @${lower.id} for the cold chain shipment disposition.`;
  const explicitRun = await runMessage(api, {
    sessionId: explicitSession.session_id,
    content: explicitQuery,
    options: {
      ...POC_CHAT_LIMITS,
      max_routing_adapters: 1,
      parallel_workers: 1
    },
    pollTimeoutMs,
    pollIntervalMs
  });
  const explicitSelection = routingSelection(explicitRun, lower.id);
  const explicitAdapters = runAdapters(explicitRun);
  const explicitSelections = explicitRun.plan?.routing?.selected || [];
  prove(assertions, "an explicit reference overrides RealityRank and executes the lower-ranked agent", (
    explicitAdapters.includes(lower.id)
    && !explicitAdapters.includes(favored.id)
    && explicitSelections.length === 1
    && explicitSelection?.adapter === lower.id
    && explicitSelection?.source === "explicit"
    && approximatelyEqual(explicitSelection?.reality_rank, finalLowerRank.score / 100)
  ), {
    run_id: explicitRun.run_id,
    max_routing_adapters: 1,
    lower_rank: finalLowerRank.score,
    favored_rank: finalFavoredRank.score,
    plan_adapters: explicitAdapters,
    selections: explicitSelections.map(compactSelection)
  });
  const explicitExecution = await fetchExecution(api, explicitRun);
  const explicitParticipant = executionParticipant(explicitExecution, lower.id);
  prove(assertions, "the override execution receipt binds the lower-ranked revision and explicit source", (
    executionMatchesRun(explicitExecution, explicitRun)
    && explicitParticipant?.agent_revision === finalLowerRank.agent_revision
    && explicitParticipant?.routing?.source === "explicit"
    && approximatelyEqual(explicitParticipant?.routing?.reality_rank, finalLowerRank.score / 100)
  ), {
    execution_id: explicitExecution.execution_id,
    record_hash_valid: explicitExecution.record_hash_valid,
    participant: compactParticipant(explicitParticipant)
  });
  const explicitRuntimeAudit = await runtimeExecutionProof(adminApi, explicitExecution, runtimeReceiptsRequired);
  prove(assertions, "the explicit override has a recomputed persisted Agent Runtime receipt", (
    !runtimeReceiptsRequired || explicitRuntimeAudit.valid === true
  ), {
    runtime_mode: health?.runtime_mode,
    required: runtimeReceiptsRequired,
    valid: explicitRuntimeAudit.valid,
    receipt: explicitRuntimeAudit.proof?.receipt || null,
    subject_chain: explicitRuntimeAudit.proof?.subject_chain || null
  });

  state.phase = "agent_revision";
  const revisedBoundary = "A revised controlled policy begins a new empirical revision and must earn its own outcomes.";
  await api.request(`/api/agents/${encodeId(favored.id)}`, {
    method: "PATCH",
    expectedStatus: 200,
    body: { boundary: revisedBoundary }
  });
  const revisedFavoredRank = await fetchRank(api, favored.id);
  const favoredEvents = (await api.request(`/api/agents/${encodeId(favored.id)}/events`)).body;
  const historicalRankVersion = (revisedFavoredRank?.versions || []).find((version) => (
    version.agent_revision === finalFavoredRank.agent_revision
  ));
  prove(assertions, "editing an agent creates a new unranked revision while retaining the prior revision's verified history", (
    revisedFavoredRank?.agent_revision !== finalFavoredRank.agent_revision
    && revisedFavoredRank?.sample_size === 0
    && revisedFavoredRank?.score === 50
    && revisedFavoredRank?.routing_eligible === false
    && historicalRankVersion?.sample_size === 1
    && approximatelyEqual(historicalRankVersion?.score, finalFavoredRank.score)
    && favoredEvents?.event_chain_valid === true
    && favoredEvents?.events?.at(-1)?.event_type === "agent.updated"
  ), {
    agent_id: favored.id,
    previous_revision: compactRank(finalFavoredRank),
    current_revision: compactRank(revisedFavoredRank),
    retained_history: historicalRankVersion || null,
    lifecycle_event_chain_valid: favoredEvents?.event_chain_valid,
    final_lifecycle_event: favoredEvents?.events?.at(-1)?.event_type || null
  });

  let tenantIsolation = {
    status: "not_requested",
    requirement: "Set VIRN_SECONDARY_API_TOKEN to an ordinary user in a different workspace for the cross-tenant negative proof."
  };
  if (secondaryApi) {
    state.phase = "tenant_isolation";
    tenantIsolation = await proveTenantIsolation(secondaryApi, {
      primaryIdentity: identity,
      secondaryIdentity,
      documentIds: [stabilityUpload.document_id, telemetryUpload.document_id],
      agentIds: [stabilityDocument.agentId, telemetryDocument.agentId, favored.id, lower.id],
      historicalRunId: historicalRun.run_id,
      executionId: historicalExecution.execution_id,
      contractId: contract.contract_id,
      settlementPayload
    });
    prove(assertions, "a second workspace cannot discover, read, mutate, or settle the primary workspace's private proof resources", (
      tenantIsolation.status === "proven"
    ), tenantIsolation);
  }

  state.phase = "proof_complete";
  return {
    schema_version: REPORT_SCHEMA,
    ok: true,
    proof_id: proofId,
    started_at: startedAt,
    target: {
      base_url: api.baseUrl,
      service: health.service,
      runtime_mode: health.runtime_mode,
      creator_identity: publicIdentity(identity),
      resolver_identity: publicIdentity(resolverIdentity)
    },
    scenario: {
      name: "Cold-chain document evidence, shipment disposition learning, and explicit override",
      synthetic: true,
      routing_cue: CUE,
      outcome_domain: DOMAIN,
      task_type: TASK_TYPE,
      better_prediction: 0.9,
      lower_prediction: 0.1,
      actual_outcome: true,
      chat_limits: POC_CHAT_LIMITS
    },
    document_rag: {
      documents: [
        {
          document_id: stabilityUpload.document_id,
          agent_id: stabilityUpload.agent_id,
          title: stabilityDocument.title,
          status: stabilityUpload.status,
          chunks: stabilityUpload.chunks,
          upload_digest: stabilityUpload.upload_digest,
          extracted_text_digest: stabilityUpload.extracted_text_digest,
          corpus_revision: stabilityUpload.corpus_revision,
          index_digest: stabilityUpload.index_digest,
          source_path: stabilityAdminSummary.source_path,
          page_count: stabilityAdminSummary.page_count
        },
        {
          document_id: telemetryUpload.document_id,
          agent_id: telemetryUpload.agent_id,
          title: telemetryDocument.title,
          status: telemetryUpload.status,
          chunks: telemetryUpload.chunks,
          upload_digest: telemetryUpload.upload_digest,
          extracted_text_digest: telemetryUpload.extracted_text_digest,
          corpus_revision: telemetryUpload.corpus_revision,
          index_digest: telemetryUpload.index_digest,
          source_path: telemetryAdminSummary.source_path,
          page_count: telemetryAdminSummary.page_count
        }
      ],
      evidence_run: {
        session_id: evidenceSession.session_id,
        run_id: evidenceRun.run_id,
        execution_id: evidenceExecution.execution_id,
        record_hash: evidenceExecution.record_hash,
        record_hash_valid: evidenceExecution.record_hash_valid,
        executed_adapters: evidenceExecutedAdapters,
        verified_citations: evidenceCitations.map((source) => ({
          agent_id: source.agent_id,
          citation_id: source.citation_id,
          chunk_id: source.chunk_id,
          title: source.title,
          page_start: source.page_start,
          page_end: source.page_end,
          content_digest: source.content_digest,
          corpus_revision: source.corpus_revision,
          index_digest: source.index_digest,
          verified: source.verified
        }))
      }
    },
    runtime_audit: {
      required: runtimeReceiptsRequired,
      hash_contract: historicalRuntimeProof?.hash_contract || null,
      agent_registrations: {
        document_agent: telemetryDocumentRuntimeAudit,
        better_ranked: favoredRuntimeAudit,
        lower_ranked: lowerRuntimeAudit
      },
      executions: {
        evidence: { valid: evidenceRuntimeAudit.valid, proof: evidenceRuntimeAudit.proof },
        historical: { valid: historicalRuntimeProofValid, proof: historicalRuntimeProof },
        implicit: { valid: implicitRuntimeAudit.valid, proof: implicitRuntimeAudit.proof },
        explicit_override: { valid: explicitRuntimeAudit.valid, proof: explicitRuntimeAudit.proof }
      }
    },
    agents: {
      better_ranked: {
        id: favored.id,
        title: favored.title,
        revision: finalFavoredRank.agent_revision,
        routing_cues: favoredDetail.routing_cues
      },
      lower_ranked: {
        id: lower.id,
        title: lower.title,
        revision: finalLowerRank.agent_revision,
        routing_cues: lowerDetail.routing_cues
      },
      revised_after_proof: {
        id: favored.id,
        previous_revision: finalFavoredRank.agent_revision,
        current_revision: revisedFavoredRank.agent_revision,
        current_sample_size: revisedFavoredRank.sample_size,
        retained_history: historicalRankVersion || null
      },
      lifecycle_logging: {
        workspace_event_chains_valid: favoredCreationEvents.event_chain_valid === true && lowerCreationEvents.event_chain_valid === true,
        runtime_receipts_required: runtimeReceiptsRequired,
        runtime_receipts_valid: runtimeReceiptsRequired
          ? favoredRuntimeReceiptValid && lowerRuntimeReceiptValid
          : null,
        runtime_receipts: [favoredRuntimeReceipt, lowerRuntimeReceipt].map(compactRuntimeReceipt)
      }
    },
    historical_run: {
      session_id: historicalSession.session_id,
      run_id: historicalRun.run_id,
      execution_id: historicalExecution.execution_id,
      execution_record_hash_valid: historicalExecution.record_hash_valid,
      status: historicalRun.status,
      explicit_selections: [compactSelection(historicalFavoredSelection), compactSelection(historicalLowerSelection)],
      executed_adapters: historicalExecutedAdapters
    },
    outcome_contract: {
      contract_id: finalCorrected.contract_id,
      status: finalCorrected.status,
      outcome_type: finalCorrected.outcome_type,
      actual_value: finalCorrected.settlement.actual_value,
      event_chain_valid: settledRead.event_chain_valid,
      integrity_valid: settledRead.integrity_valid,
      dispute_count: finalCorrected.disputes.length,
      settlement_count: finalCorrected.settlements.length,
      participant_scores: finalCorrected.settlement.participant_scores,
      idempotency: {
        contract_replay_same_id: contractReplay.contract_id === contract.contract_id,
        contract_changed_replay_status: contractConflict.status,
        settlement_replay_same_id: settledReplay.settlement.settlement_id === settled.settlement.settlement_id,
        settlement_changed_replay_status: settlementConflict.status,
        correction_replay_same_id: correctedReplay.settlement.settlement_id === corrected.settlement.settlement_id,
        correction_changed_replay_status: correctionConflict.status
      }
    },
    reality_rank: {
      before_settlement: {
        better: compactRank(initialFavoredRank),
        lower: compactRank(initialLowerRank)
      },
      after_settlement: {
        better: compactRank(finalFavoredRank),
        lower: compactRank(finalLowerRank),
        score_gap: Number((finalFavoredRank.score - finalLowerRank.score).toFixed(2))
      },
      while_disputed: {
        better: compactRank(disputedFavoredRank),
        lower: compactRank(disputedLowerRank)
      },
      after_quarantine_correction: {
        better: compactRank(correctedFavoredRank),
        lower: compactRank(correctedLowerRank)
      },
      after_agent_edit: {
        current: compactRank(revisedFavoredRank),
        retained_history: historicalRankVersion || null
      }
    },
    routing_proofs: {
      implicit: {
        session_id: implicitSession.session_id,
        run_id: implicitRun.run_id,
        execution_id: implicitExecution.execution_id,
        max_routing_adapters: 1,
        selection: compactSelection(implicitSelection),
        tied_candidates: [favoredCandidate, lowerCandidate].map(compactCandidate),
        participant: compactParticipant(implicitParticipant)
      },
      explicit_override: {
        session_id: explicitSession.session_id,
        run_id: explicitRun.run_id,
        execution_id: explicitExecution.execution_id,
        max_routing_adapters: 1,
        selection: compactSelection(explicitSelection),
        participant: compactParticipant(explicitParticipant)
      }
    },
    tenant_isolation: tenantIsolation,
    proof_boundaries: {
      ...(secondaryApi ? {} : {
        tenant_isolation: "Cross-tenant negative evidence requires VIRN_SECONDARY_API_TOKEN for an ordinary user in a different workspace."
      }),
      retained_provenance: "Document tombstones, chat runs, execution receipts, and the settled Outcome Contract are intentionally retained."
    },
    assertions
  };
}

function recordCleanupProof(assertions, errors, claim, condition, evidence) {
  if (condition) {
    assertions.push({ claim, status: "proven", evidence });
    return;
  }
  errors.push({ claim, message: `Cleanup claim was not proven: ${claim}`, evidence });
}

async function cleanupResources(api, state, keep) {
  const agentIds = [...new Set(state.candidateAgentIds)];
  const documentAgentIds = new Set(state.documentAgentIds);
  const promptAgentIds = [...new Set(state.promptAgentIds)];
  const confirmedPromptIds = state.confirmedAgentIds.filter((agentId) => promptAgentIds.includes(agentId));
  const uncreatedPromptIds = promptAgentIds.filter((agentId) => !confirmedPromptIds.includes(agentId));
  const knownDocuments = new Map(
    state.createdDocuments
      .filter((document) => document.document_id && document.agent_id)
      .map((document) => [document.document_id, document])
  );
  if (keep) {
    return {
      mode: "kept",
      agent_ids: agentIds,
      document_ids: [...knownDocuments.keys()],
      documents: { results: [], verification: [] },
      prompt_agents: { results: [], verification: [], not_created: uncreatedPromptIds },
      errors: []
    };
  }

  const errors = [];
  const documentResults = [];
  const documentVerification = [];
  const promptResults = [];
  const promptVerification = [];

  try {
    const active = (await api.request(queryPath("/api/documents", { limit: 500, offset: 0 }))).body;
    for (const document of active?.documents || []) {
      if (documentAgentIds.has(document.agent_id)) {
        knownDocuments.set(document.document_id, {
          document_id: document.document_id,
          agent_id: document.agent_id
        });
      }
    }
  } catch (error) {
    errors.push({ resource: "documents", operation: "discover", message: error.message, details: error.details || null });
  }

  for (const document of [...knownDocuments.values()].reverse()) {
    try {
      const response = await api.request(`/api/documents/${encodeId(document.document_id)}`, {
        method: "DELETE",
        expectedStatus: 200,
        allowedStatuses: [404]
      });
      if (response.status === 404) {
        documentResults.push({ ...document, status: "not_found" });
      } else if (
        response.body?.status === "deleted"
        && response.body?.document_id === document.document_id
        && response.body?.agent_id === document.agent_id
      ) {
        documentResults.push({
          document_id: document.document_id,
          agent_id: document.agent_id,
          status: "deleted",
          corpus_revision: response.body.corpus_revision,
          purged_at: response.body.purged_at
        });
      } else {
        errors.push({
          resource: "document",
          document_id: document.document_id,
          operation: "delete",
          message: "Delete response did not confirm the expected document and route agent.",
          response: response.body
        });
      }
    } catch (error) {
      errors.push({
        resource: "document",
        document_id: document.document_id,
        operation: "delete",
        message: error.message,
        details: error.details || null
      });
    }
  }

  let activeAfter = null;
  try {
    activeAfter = (await api.request(queryPath("/api/documents", { limit: 500, offset: 0 }))).body;
  } catch (error) {
    errors.push({ resource: "documents", operation: "verify_list", message: error.message, details: error.details || null });
  }
  const activeDocumentIds = new Set((activeAfter?.documents || []).map((document) => document.document_id));

  for (const document of knownDocuments.values()) {
    try {
      const agent = (await api.request(`/api/agents/${encodeId(document.agent_id)}`)).body;
      const events = (await api.request(`/api/agents/${encodeId(document.agent_id)}/events`)).body;
      const chunks = (await api.request(`/api/documents/${encodeId(document.document_id)}/chunks?limit=1&offset=0`)).body;
      const search = await api.request(`/api/documents/${encodeId(document.document_id)}/search`, {
        method: "POST",
        expectedStatus: 410,
        body: { query: "CT-204 cleanup verification" }
      });
      documentVerification.push({
        document_id: document.document_id,
        agent_id: document.agent_id,
        absent_from_active_documents: !activeDocumentIds.has(document.document_id),
        chunk_total: chunks.total,
        search_status: search.status,
        agent_enabled: agent.enabled,
        agent_ready: agent.ready,
        event_chain_valid: events.event_chain_valid,
        final_event_type: events.events?.at(-1)?.event_type || null
      });
    } catch (error) {
      errors.push({
        resource: "document",
        document_id: document.document_id,
        operation: "verify_purge",
        message: error.message,
        details: error.details || null
      });
    }
  }

  for (const agentId of [...confirmedPromptIds].reverse()) {
    try {
      const response = await api.request(`/api/agents/${encodeId(agentId)}`, {
        method: "DELETE",
        expectedStatus: 200,
        allowedStatuses: [404]
      });
      if (response.status === 404) {
        promptResults.push({ agent_id: agentId, status: "not_found" });
      } else if (response.body?.status === "archived" && response.body?.id === agentId) {
        promptResults.push({ agent_id: agentId, status: "archived" });
      } else {
        errors.push({
          resource: "prompt_agent",
          agent_id: agentId,
          operation: "archive",
          message: "Archive response did not confirm the expected prompt agent.",
          response: response.body
        });
      }
    } catch (error) {
      errors.push({
        resource: "prompt_agent",
        agent_id: agentId,
        operation: "archive",
        message: error.message,
        details: error.details || null
      });
    }
  }

  for (const agentId of confirmedPromptIds) {
    try {
      const agent = (await api.request(`/api/agents/${encodeId(agentId)}`)).body;
      promptVerification.push({
        agent_id: agentId,
        enabled: agent.enabled,
        ready: agent.ready,
        archived: agent.enabled === false
      });
    } catch (error) {
      errors.push({
        resource: "prompt_agent",
        agent_id: agentId,
        operation: "verify_archive",
        message: error.message,
        details: error.details || null
      });
    }
  }

  const deletedDocumentIds = new Set(
    documentResults.filter((result) => result.status === "deleted").map((result) => result.document_id)
  );
  const documentsPurged = knownDocuments.size === 2
    && documentResults.length === 2
    && [...knownDocuments.keys()].every((documentId) => deletedDocumentIds.has(documentId));
  const documentsVerified = documentVerification.length === 2 && documentVerification.every((item) => (
    item.absent_from_active_documents
    && item.chunk_total === 0
    && item.search_status === 410
    && item.agent_enabled === false
    && item.event_chain_valid === true
    && item.final_event_type === "document_agent.deleted"
  ));
  recordCleanupProof(
    state.assertions,
    errors,
    "cleanup purges both documents' indexed chunks and archives their tombstones and route agents",
    documentsPurged && documentsVerified,
    { deleted_documents: documentResults, verification: documentVerification }
  );

  const promptAgentsArchived = confirmedPromptIds.length > 0
    && promptResults.length === confirmedPromptIds.length
    && promptVerification.length === confirmedPromptIds.length
    && confirmedPromptIds.every((agentId) =>
    promptResults.some((result) => result.agent_id === agentId && result.status === "archived")
    && promptVerification.some((result) => result.agent_id === agentId && result.archived)
  );
  if (confirmedPromptIds.length > 0) {
    recordCleanupProof(
      state.assertions,
      errors,
      "cleanup directly archives every generated prompt agent",
      promptAgentsArchived,
      { archive_results: promptResults, verification: promptVerification }
    );
  }

  return {
    mode: "purged_and_archived",
    agent_ids: agentIds,
    document_ids: [...knownDocuments.keys()],
    documents: { results: documentResults, verification: documentVerification },
    prompt_agents: { results: promptResults, verification: promptVerification, not_created: uncreatedPromptIds },
    errors
  };
}

function serializedError(error) {
  return {
    name: error?.name || "Error",
    message: error?.message || String(error),
    details: error?.details || null
  };
}

async function main() {
  const proofId = uniqueProofId();
  const state = {
    phase: "configuration",
    candidateAgentIds: [],
    confirmedAgentIds: [],
    documentAgentIds: [],
    promptAgentIds: [],
    createdDocuments: [],
    assertions: []
  };
  let args;
  let api;
  let adminApi;
  let secondaryApi;
  let report;
  let failure;
  let cleanup = {
    mode: "not_started",
    agent_ids: [],
    document_ids: [],
    documents: { results: [], verification: [] },
    prompt_agents: { results: [] },
    errors: []
  };

  try {
    args = parseArgs(process.argv.slice(2));
    if (args.help) {
      console.log(usage());
      return;
    }
    const baseUrl = normalizeBaseUrl(process.env.VIRN_BASE_URL);
    const adminToken = String(process.env.VIRN_API_TOKEN || "").trim();
    const creatorToken = String(process.env.VIRN_CREATOR_API_TOKEN || "").trim();
    const secondaryToken = String(process.env.VIRN_SECONDARY_API_TOKEN || "").trim();
    if (!adminToken || !creatorToken || adminToken === creatorToken) {
      throw new ProofFailure(
        "VIRN_API_TOKEN and VIRN_CREATOR_API_TOKEN are required and must be distinct bound-admin and ordinary-user credentials."
      );
    }
    const allowInsecure = String(process.env.VIRN_ALLOW_INSECURE_HTTP || "");
    const requestOrigin = normalizeRequestOrigin(process.env.VIRN_REQUEST_ORIGIN, baseUrl);
    const requestTimeoutMs = positiveIntegerEnv("VIRN_REQUEST_TIMEOUT_MS", 15_000, { min: 1000 });
    assertSecureBearerTransport(baseUrl, adminToken, allowInsecure);
    assertSecureBearerTransport(baseUrl, creatorToken, allowInsecure);
    assertSecureBearerTransport(baseUrl, secondaryToken, allowInsecure);
    api = new VirenisApi({
      baseUrl,
      token: creatorToken,
      requestOrigin,
      requestTimeoutMs,
      proofId
    });
    adminApi = new VirenisApi({
      baseUrl,
      token: adminToken,
      requestOrigin,
      requestTimeoutMs,
      proofId: `${proofId}-admin`
    });
    secondaryApi = secondaryToken ? new VirenisApi({
      baseUrl,
      token: secondaryToken,
      requestOrigin,
      requestTimeoutMs,
      proofId: `${proofId}-tenant`
    }) : null;
    report = await executeProof({
      api,
      adminApi,
      secondaryApi,
      proofId,
      pollTimeoutMs: positiveIntegerEnv("VIRN_POLL_TIMEOUT_MS", 120_000, { min: 1000 }),
      pollIntervalMs: positiveIntegerEnv("VIRN_POLL_INTERVAL_MS", 200, { min: 10, max: 10_000 }),
      outcomeWaitMs: positiveIntegerEnv("VIRN_OUTCOME_WAIT_MS", 500, { min: 50, max: 10_000 }),
      state
    });
  } catch (error) {
    failure = error;
  }

  if (api) {
    cleanup = await cleanupResources(api, state, args?.keep === true);
  }
  if (!failure && cleanup.errors.length > 0) {
    failure = new ProofFailure("The proof passed, but generated-resource cleanup was not fully verified.", {
      cleanup_errors: cleanup.errors
    });
  }

  const completedAt = new Date().toISOString();
  if (failure) {
    const failedReport = {
      schema_version: REPORT_SCHEMA,
      ok: false,
      proof_id: proofId,
      completed_at: completedAt,
      phase: state.phase,
      target: { base_url: api?.baseUrl || process.env.VIRN_BASE_URL || null },
      error: serializedError(failure),
      assertions_proven: state.assertions,
      generated_agents: {
        candidates: state.candidateAgentIds,
        confirmed_created: state.confirmedAgentIds,
        created_documents: state.createdDocuments
      },
      cleanup
    };
    process.stdout.write(`${JSON.stringify(failedReport, null, 2)}\n`);
    process.stderr.write(`RealityRank POC failed during ${state.phase}: ${failure.message}\n`);
    process.exitCode = 1;
    return;
  }

  report.completed_at = completedAt;
  report.assertion_summary = {
    total: report.assertions.length,
    proven: report.assertions.length,
    failed: 0
  };
  report.cleanup = cleanup;
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

await main();

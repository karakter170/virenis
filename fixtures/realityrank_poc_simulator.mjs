#!/usr/bin/env node
/* global clearTimeout, console, fetch, process, setTimeout, URL */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

import { createApp } from "../server/app.js";
import { processChatRun } from "../server/tcarEngine.js";

function requireProof(condition, message, evidence = null) {
  if (!condition) {
    const error = new Error(message);
    error.evidence = evidence;
    throw error;
  }
}

function runChild(command, args, options, timeoutMs) {
  const child = spawn(command, args, options);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`POC process exceeded ${timeoutMs}ms.`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, stdout, stderr, child });
    });
  });
}

async function jsonRequest(baseUrl, pathName, token, { method = "GET", body } = {}) {
  const response = await fetch(`${baseUrl}${pathName}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" })
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const payload = await response.json();
  requireProof(response.ok, `${method} ${pathName} returned HTTP ${response.status}.`, payload);
  return payload;
}

function jsonGet(baseUrl, pathName, token) {
  return jsonRequest(baseUrl, pathName, token);
}

function parseChildReport(result, label) {
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`${label} stdout was not a JSON report: ${error.message}\n${result.stdout}`);
  }
}

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "virenis-realityrank-poc-"));
const token = `rr_poc_fixture_${crypto.randomBytes(12).toString("hex")}`;
const creatorToken = `rr_poc_creator_${crypto.randomBytes(12).toString("hex")}`;
const secondaryToken = `rr_poc_secondary_${crypto.randomBytes(12).toString("hex")}`;
const previousEnv = {
  NODE_ENV: process.env.NODE_ENV,
  WEB_STORE_DRIVER: process.env.WEB_STORE_DRIVER,
  TCAR_ENGINE_MODE: process.env.TCAR_ENGINE_MODE,
  APP_API_TOKENS_JSON: process.env.APP_API_TOKENS_JSON,
  VIRENIS_REALITY_RANK_MIN_VERIFIED_SAMPLES: process.env.VIRENIS_REALITY_RANK_MIN_VERIFIED_SAMPLES
};

Object.assign(process.env, {
  NODE_ENV: "test",
  WEB_STORE_DRIVER: "json",
  TCAR_ENGINE_MODE: "simulator",
  APP_API_TOKENS_JSON: JSON.stringify({
    [token]: {
      user_id: "realityrank_poc_resolver",
      workspace_id: "workspace_realityrank_poc",
      role: "admin",
      resolver_bindings: [{
        type: "human",
        authority: "RealityRank POC Chief Pharmacist",
        reference_prefix: "synthetic-pharmacy-disposition:"
      }]
    },
    [creatorToken]: {
      user_id: "realityrank_poc_creator",
      workspace_id: "workspace_realityrank_poc",
      role: "user"
    },
    [secondaryToken]: {
      user_id: "realityrank_poc_secondary_user",
      workspace_id: "workspace_realityrank_poc_secondary",
      role: "user"
    }
  }),
  VIRENIS_REALITY_RANK_MIN_VERIFIED_SAMPLES: "1"
});

let app;
let server;
let faultApp;
let faultServer;
try {
  app = await createApp({
    dbPath: path.join(tmpDir, "app-db.json"),
    uploadRoot: path.join(tmpDir, "uploads")
  });
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const scriptPath = fileURLToPath(new URL("../scripts/realityrank_poc.mjs", import.meta.url));
  const insecureTransportResult = await runChild(process.execPath, [scriptPath], {
    cwd: path.dirname(scriptPath),
    env: {
      ...process.env,
      VIRN_BASE_URL: "http://api.example.test",
      VIRN_API_TOKEN: token,
      VIRN_CREATOR_API_TOKEN: creatorToken,
      VIRN_SECONDARY_API_TOKEN: "",
      VIRN_ALLOW_INSECURE_HTTP: ""
    },
    stdio: ["ignore", "pipe", "pipe"]
  }, 5000);
  const insecureTransportReport = parseChildReport(insecureTransportResult, "insecure transport check");
  requireProof(
    insecureTransportResult.code === 1
    && insecureTransportReport.ok === false
    && insecureTransportReport.phase === "configuration"
    && insecureTransportReport.error?.message?.includes("require HTTPS"),
    "Bearer transport guard did not reject a non-loopback HTTP target.",
    insecureTransportReport
  );

  const pocEnv = {
    ...process.env,
    VIRN_BASE_URL: baseUrl,
    VIRN_API_TOKEN: token,
    VIRN_CREATOR_API_TOKEN: creatorToken,
    VIRN_SECONDARY_API_TOKEN: secondaryToken,
    VIRN_ALLOW_INSECURE_HTTP: "",
    VIRN_REQUEST_TIMEOUT_MS: "5000",
    VIRN_POLL_TIMEOUT_MS: "30000",
    VIRN_POLL_INTERVAL_MS: "20",
    VIRN_OUTCOME_WAIT_MS: "100"
  };

  faultApp = await createApp({
    dbPath: path.join(tmpDir, "fault-app-db.json"),
    uploadRoot: path.join(tmpDir, "fault-uploads"),
    chatProcessor: async (context) => {
      const faultStore = {
        read: (...args) => context.store.read(...args),
        mutate: (mutator) => context.store.mutate((data) => {
          const result = mutator(data);
          const run = data.runs.find((item) => item.run_id === context.run_id);
          if (run?.status === "completed") {
            run.sources = [];
            for (const step of data.runSteps.filter((item) => item.run_id === context.run_id)) {
              step.citations = [];
            }
          }
          return result;
        })
      };
      await processChatRun({ ...context, store: faultStore });
    }
  });
  faultServer = faultApp.listen(0, "127.0.0.1");
  await once(faultServer, "listening");
  const faultAddress = faultServer.address();
  const faultBaseUrl = `http://127.0.0.1:${faultAddress.port}`;
  const earlyFailureResult = await runChild(process.execPath, [scriptPath], {
    cwd: path.dirname(scriptPath),
    env: {
      ...pocEnv,
      VIRN_BASE_URL: faultBaseUrl,
      VIRN_SECONDARY_API_TOKEN: ""
    },
    stdio: ["ignore", "pipe", "pipe"]
  }, 45_000);
  const earlyFailureReport = parseChildReport(earlyFailureResult, "early evidence-failure POC");
  requireProof(
    earlyFailureResult.code === 1
    && earlyFailureReport.ok === false
    && earlyFailureReport.phase === "document_evidence_run"
    && earlyFailureReport.error?.message?.includes("verified citations")
    && earlyFailureReport.generated_agents?.confirmed_created?.length === 2
    && earlyFailureReport.cleanup?.documents?.results?.length === 2
    && earlyFailureReport.cleanup?.documents?.verification?.length === 2
    && earlyFailureReport.cleanup?.prompt_agents?.results?.length === 0
    && earlyFailureReport.cleanup?.prompt_agents?.verification?.length === 0
    && earlyFailureReport.cleanup?.prompt_agents?.not_created?.length === 2
    && earlyFailureReport.cleanup?.errors?.length === 0
    && !(earlyFailureReport.assertions_proven || []).some((assertion) =>
      assertion.claim === "cleanup directly archives every generated prompt agent"
    ),
    "Early evidence failure did not clean only resources that were actually created.",
    earlyFailureReport
  );

  const result = await runChild(process.execPath, [scriptPath], {
    cwd: path.dirname(scriptPath),
    env: pocEnv,
    stdio: ["ignore", "pipe", "pipe"]
  }, 45_000);

  requireProof(result.code === 0, `POC exited with code ${result.code} and signal ${result.signal || "none"}.`, {
    stdout: result.stdout,
    stderr: result.stderr
  });
  const report = parseChildReport(result, "default cleanup POC");

  requireProof(report.ok === true, "POC report did not prove success.", report.error || report);
  requireProof(report.target?.runtime_mode === "simulator", "POC did not target the simulator.", report.target);
  requireProof(report.assertion_summary?.failed === 0, "POC report contains failed assertions.", report.assertion_summary);
  requireProof(
    report.document_rag?.documents?.length === 2
    && report.document_rag?.documents?.[0]?.source_path?.endsWith(".pdf")
    && report.document_rag?.documents?.[0]?.page_count === 1
    && report.document_rag?.evidence_run?.verified_citations?.length === 2
    && report.document_rag.evidence_run.verified_citations.some((citation) => (
      citation.agent_id === report.document_rag.documents[0].agent_id
      && citation.page_start === 1
      && citation.page_end === 1
    )),
    "Document ingestion and verified RAG citations were not proven.",
    report.document_rag
  );
  requireProof(
    report.outcome_contract?.integrity_valid === true
    && report.outcome_contract?.dispute_count === 1
    && report.outcome_contract?.settlement_count === 3
    && report.outcome_contract?.idempotency?.correction_replay_same_id === true
    && report.outcome_contract?.idempotency?.correction_changed_replay_status === 409,
    "Dispute, correction, and final contract integrity were not proven.",
    report.outcome_contract
  );
  requireProof(
    report.reality_rank?.while_disputed?.better?.sample_size === 0
    && report.reality_rank?.while_disputed?.lower?.sample_size === 0
    && report.reality_rank?.while_disputed?.better?.routing_eligible === false
    && Number(report.reality_rank?.after_quarantine_correction?.lower?.score)
      > Number(report.reality_rank?.after_quarantine_correction?.better?.score)
    && report.reality_rank?.after_agent_edit?.current?.sample_size === 0
    && report.reality_rank?.after_agent_edit?.current?.routing_eligible === false
    && report.reality_rank?.after_agent_edit?.retained_history?.sample_size === 1,
    "Outcome withdrawal, score reversal, or revision-scoped history was not proven.",
    report.reality_rank
  );
  const implicitCandidates = report.routing_proofs?.implicit?.tied_candidates || [];
  requireProof(
    report.routing_proofs?.implicit?.selection?.source === "cue+reality_rank"
    && implicitCandidates.length === 2
    && Number(implicitCandidates[0]?.cue_score) > 0
    && Number(implicitCandidates[0]?.cue_score) === Number(implicitCandidates[1]?.cue_score)
    && implicitCandidates.every((candidate) => (
      Boolean(candidate.adapter)
      && Boolean(candidate.agent_revision)
      && Number(candidate.rank_sample_size) === 1
      && Number.isFinite(Number(candidate.reality_rank))
    )),
    "Implicit routing source was not cue+reality_rank.",
    report.routing_proofs?.implicit
  );
  requireProof(
    report.routing_proofs?.explicit_override?.selection?.source === "explicit",
    "Explicit override source was not explicit.",
    report.routing_proofs?.explicit_override
  );
  const tenantIsolation = report.tenant_isolation;
  const expectedTenantAttempts = new Map([
    ["document:get", 2],
    ["document:delete", 2],
    ["agent:get", 4],
    ["agent:patch", 4],
    ["historical_run:get", 1],
    ["execution_receipt:get", 1],
    ["outcome_contract:get", 1],
    ["outcome_contract:settle", 1]
  ]);
  requireProof(
    tenantIsolation?.status === "proven"
    && tenantIsolation.identities_separated === true
    && tenantIsolation.primary_identity?.user_id !== tenantIsolation.secondary_identity?.user_id
    && tenantIsolation.primary_identity?.workspace_id !== tenantIsolation.secondary_identity?.workspace_id
    && tenantIsolation.secondary_identity?.auth_type === "bearer"
    && tenantIsolation.secondary_identity?.is_admin === false
    && tenantIsolation.list_isolation?.documents_hidden === true
    && tenantIsolation.list_isolation?.agents_hidden === true
    && tenantIsolation.list_isolation?.primary_document_count === 2
    && tenantIsolation.list_isolation?.primary_agent_count === 4
    && tenantIsolation.direct_denials?.length === expectedTenantAttempts.size
    && tenantIsolation.direct_denials.every((denial) => (
      denial.attempts === expectedTenantAttempts.get(`${denial.resource}:${denial.operation}`)
      && denial.statuses?.length === 1
      && denial.statuses[0] === 404
      && denial.all_opaque_missing === true
    )),
    "Cross-tenant private-resource isolation was not proven.",
    tenantIsolation
  );
  requireProof(
    report.cleanup?.mode === "purged_and_archived"
    && report.cleanup?.document_ids?.length === 2
    && report.cleanup?.agent_ids?.length === 4
    && report.cleanup?.documents?.results?.length === 2
    && report.cleanup?.documents?.verification?.length === 2
    && report.cleanup?.documents?.results?.every((result) => result.status === "deleted")
    && report.cleanup?.documents?.verification?.every((result) => result.chunk_total === 0)
    && report.cleanup?.prompt_agents?.results?.length === 2
    && report.cleanup?.prompt_agents?.verification?.length === 2
    && report.cleanup?.prompt_agents?.results?.every((result) => result.status === "archived")
    && report.cleanup?.errors?.length === 0,
    "POC cleanup failed.",
    report.cleanup
  );

  const activeDocuments = await jsonGet(baseUrl, "/api/documents?limit=500&offset=0", token);
  const activeDocumentIds = new Set(activeDocuments.documents.map((document) => document.document_id));
  requireProof(
    report.cleanup.document_ids.every((documentId) => !activeDocumentIds.has(documentId)),
    "Purged fixtures remained in the active document list.",
    { purged: report.cleanup.document_ids, active: [...activeDocumentIds] }
  );

  const agentIds = report.cleanup.agent_ids;
  const archivedAgents = [];
  for (const agentId of agentIds) {
    const agent = await jsonGet(baseUrl, `/api/agents/${encodeURIComponent(agentId)}`, token);
    requireProof(agent.enabled === false && agent.mounted === false, `Agent ${agentId} was not archived.`, {
      enabled: agent.enabled,
      mounted: agent.mounted
    });
    archivedAgents.push(agentId);
  }

  const keepResult = await runChild(process.execPath, [scriptPath, "--keep"], {
    cwd: path.dirname(scriptPath),
    env: pocEnv,
    stdio: ["ignore", "pipe", "pipe"]
  }, 45_000);
  requireProof(keepResult.code === 0, `POC --keep exited with code ${keepResult.code}.`, {
    stdout: keepResult.stdout,
    stderr: keepResult.stderr
  });
  const keepReport = parseChildReport(keepResult, "keep-path POC");
  requireProof(
    keepReport.ok === true
    && keepReport.tenant_isolation?.status === "proven"
    && keepReport.cleanup?.mode === "kept"
    && keepReport.cleanup?.document_ids?.length === 2
    && keepReport.cleanup?.agent_ids?.length === 4
    && keepReport.cleanup?.documents?.results?.length === 0
    && keepReport.cleanup?.prompt_agents?.results?.length === 0
    && keepReport.cleanup?.errors?.length === 0,
    "POC --keep did not preserve exactly two documents and four agents.",
    keepReport.cleanup
  );

  const keptDocuments = await jsonGet(baseUrl, "/api/documents?limit=500&offset=0", token);
  const keptDocumentIds = new Set(keptDocuments.documents.map((document) => document.document_id));
  requireProof(
    keepReport.cleanup.document_ids.every((documentId) => keptDocumentIds.has(documentId)),
    "POC --keep document resources were not active after the proof.",
    { expected: keepReport.cleanup.document_ids, active: [...keptDocumentIds] }
  );
  for (const agentId of keepReport.cleanup.agent_ids) {
    const agent = await jsonGet(baseUrl, `/api/agents/${encodeURIComponent(agentId)}`, token);
    requireProof(agent.enabled !== false && agent.mounted === true, `POC --keep agent ${agentId} was not active.`, {
      enabled: agent.enabled,
      mounted: agent.mounted
    });
  }

  for (const documentId of keepReport.cleanup.document_ids) {
    const deleted = await jsonRequest(baseUrl, `/api/documents/${encodeURIComponent(documentId)}`, token, { method: "DELETE" });
    requireProof(deleted.status === "deleted", `Keep-path teardown did not delete ${documentId}.`, deleted);
    const chunks = await jsonGet(baseUrl, `/api/documents/${encodeURIComponent(documentId)}/chunks?limit=1&offset=0`, token);
    requireProof(chunks.total === 0, `Keep-path teardown left indexed chunks for ${documentId}.`, chunks);
  }
  const keepDocumentAgentIds = new Set(keepReport.document_rag.documents.map((document) => document.agent_id));
  const keepPromptAgentIds = keepReport.cleanup.agent_ids.filter((agentId) => !keepDocumentAgentIds.has(agentId));
  requireProof(keepPromptAgentIds.length === 2, "Keep-path teardown did not identify exactly two prompt agents.", keepPromptAgentIds);
  for (const agentId of keepPromptAgentIds) {
    const archived = await jsonRequest(baseUrl, `/api/agents/${encodeURIComponent(agentId)}`, token, { method: "DELETE" });
    requireProof(archived.status === "archived", `Keep-path teardown did not archive ${agentId}.`, archived);
  }
  const afterKeepTeardown = await jsonGet(baseUrl, "/api/documents?limit=500&offset=0", token);
  const afterKeepDocumentIds = new Set(afterKeepTeardown.documents.map((document) => document.document_id));
  requireProof(
    keepReport.cleanup.document_ids.every((documentId) => !afterKeepDocumentIds.has(documentId)),
    "Keep-path teardown left active documents.",
    { deleted: keepReport.cleanup.document_ids, active: [...afterKeepDocumentIds] }
  );
  for (const agentId of keepReport.cleanup.agent_ids) {
    const agent = await jsonGet(baseUrl, `/api/agents/${encodeURIComponent(agentId)}`, token);
    requireProof(
      agent.enabled === false && agent.mounted === false,
      `Keep-path teardown left ${agentId} enabled or mounted.`,
      agent
    );
  }

  const noSecondaryResult = await runChild(process.execPath, [scriptPath], {
    cwd: path.dirname(scriptPath),
    env: { ...pocEnv, VIRN_SECONDARY_API_TOKEN: "" },
    stdio: ["ignore", "pipe", "pipe"]
  }, 45_000);
  requireProof(noSecondaryResult.code === 0, `POC without a secondary token exited with code ${noSecondaryResult.code}.`, {
    stdout: noSecondaryResult.stdout,
    stderr: noSecondaryResult.stderr
  });
  const noSecondaryReport = parseChildReport(noSecondaryResult, "single-credential POC");
  requireProof(
    noSecondaryReport.ok === true
    && noSecondaryReport.tenant_isolation?.status === "not_requested"
    && typeof noSecondaryReport.proof_boundaries?.tenant_isolation === "string"
    && noSecondaryReport.cleanup?.mode === "purged_and_archived"
    && noSecondaryReport.cleanup?.document_ids?.length === 2
    && noSecondaryReport.cleanup?.agent_ids?.length === 4
    && noSecondaryReport.cleanup?.documents?.verification?.every((item) => item.chunk_total === 0)
    && noSecondaryReport.cleanup?.errors?.length === 0,
    "The single-credential path did not preserve its original cleanup behavior.",
    noSecondaryReport
  );

  console.log(JSON.stringify({
    ok: true,
    fixture: "temporary virenis simulator over HTTP",
    report_schema: report.schema_version,
    proof_id: report.proof_id,
    assertions_proven: report.assertion_summary.proven,
    rank_score_gap: report.reality_rank.after_settlement.score_gap,
    implicit_winner: report.routing_proofs.implicit.selection.adapter,
    implicit_source: report.routing_proofs.implicit.selection.source,
    explicit_override: report.routing_proofs.explicit_override.selection.adapter,
    explicit_source: report.routing_proofs.explicit_override.selection.source,
    purged_documents: report.cleanup.document_ids,
    archived_agents: archivedAgents,
    transport_guard: "non-loopback bearer HTTP rejected",
    tenant_isolation: "different-workspace user received opaque 404 denials",
    optional_secondary_token: "omitted path also passed",
    early_failure_cleanup: "documents purged; uncreated prompt agents skipped",
    keep_path: {
      proof_id: keepReport.proof_id,
      preserved_documents: keepReport.cleanup.document_ids.length,
      preserved_agents: keepReport.cleanup.agent_ids.length,
      teardown: "complete"
    }
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    error: error.message,
    evidence: error.evidence || null
  }, null, 2));
  process.exitCode = 1;
} finally {
  if (server) {
    app.locals.closeEventStreams?.({ reason: "fixture_complete" });
    await app.locals.drainBackgroundTasks?.({ timeoutMs: 5000 });
    await new Promise((resolve) => server.close(resolve));
    server.closeAllConnections?.();
  }
  if (faultServer) {
    faultApp.locals.closeEventStreams?.({ reason: "fixture_complete" });
    await faultApp.locals.drainBackgroundTasks?.({ timeoutMs: 5000 });
    await new Promise((resolve) => faultServer.close(resolve));
    faultServer.closeAllConnections?.();
  }
  await app?.locals?.store?.close?.();
  await faultApp?.locals?.store?.close?.();
  await fs.rm(tmpDir, { recursive: true, force: true });
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../server/app.js";
import { parseConfiguredApiTokens } from "../server/authConfig.js";
import {
  correctOutcomeContract,
  digestValue,
  realityRankMinVerifiedSamples,
  verifyEventChain
} from "../server/outcomes.js";

let app;
let tmpDir;
let previousStoreDriver;
let previousTokens;
let previousRankMinimum;

const RESOLVER_TOKEN = "pharmacy_resolver_token";
const RESOLVER_AUTH = { Authorization: `Bearer ${RESOLVER_TOKEN}` };

beforeEach(async () => {
  previousStoreDriver = process.env.WEB_STORE_DRIVER;
  previousTokens = process.env.APP_API_TOKENS_JSON;
  previousRankMinimum = process.env.VIRENIS_REALITY_RANK_MIN_VERIFIED_SAMPLES;
  process.env.WEB_STORE_DRIVER = "json";
  delete process.env.APP_API_TOKENS_JSON;
  delete process.env.VIRENIS_REALITY_RANK_MIN_VERIFIED_SAMPLES;
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "virenis-outcomes-"));
  app = await createApp({ dbPath: path.join(tmpDir, "db.json"), uploadRoot: tmpDir });
});

afterEach(async () => {
  await app?.locals?.drainBackgroundTasks?.({ timeoutMs: 5000 });
  await app?.locals?.store?.close?.();
  if (previousStoreDriver === undefined) delete process.env.WEB_STORE_DRIVER;
  else process.env.WEB_STORE_DRIVER = previousStoreDriver;
  if (previousTokens === undefined) delete process.env.APP_API_TOKENS_JSON;
  else process.env.APP_API_TOKENS_JSON = previousTokens;
  if (previousRankMinimum === undefined) delete process.env.VIRENIS_REALITY_RANK_MIN_VERIFIED_SAMPLES;
  else process.env.VIRENIS_REALITY_RANK_MIN_VERIFIED_SAMPLES = previousRankMinimum;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function createAgent(
  id,
  title,
  cue = "shipment disposition",
  sourceText = `${title} operating rule for ${cue}.`,
  headers = {}
) {
  const response = await request(app)
    .post("/api/agents")
    .set(headers)
    .send({
      id,
      title,
      capability: `Makes ${cue} predictions from approved evidence.`,
      boundary: "State uncertainty and never invent source facts.",
      routing_cues: cue,
      produces: "shipment_disposition",
      source_text: sourceText
    })
    .expect(201);
  expect(response.body.ready).toBe(true);
  return response.body;
}

async function createSession(title = "Outcome test", headers = {}) {
  return (await request(app).post("/api/chat/sessions").set(headers).send({ title }).expect(201)).body;
}

async function runMessage(sessionId, content, options = {}, headers = {}) {
  const queued = await request(app)
    .post(`/api/chat/sessions/${sessionId}/messages`)
    .set(headers)
    .send({ content, options })
    .expect(202);
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const response = await request(app).get(`/api/chat/runs/${queued.body.run_id}`).set(headers).expect(200);
    if (["completed", "failed"].includes(response.body.status)) return response.body;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Run ${queued.body.run_id} did not finish.`);
}

function futureIso(delayMs = 500) {
  return new Date(Date.now() + delayMs).toISOString();
}

function configurePharmacyResolverPrincipal() {
  process.env.APP_API_TOKENS_JSON = JSON.stringify({
    [RESOLVER_TOKEN]: {
      user_id: "pharmacy_oracle",
      workspace_id: "workspace_default",
      role: "admin",
      resolver_bindings: [{
        type: "human",
        authority: "Chief Pharmacist",
        reference_prefix: "pharmacy-disposition:"
      }]
    }
  });
}

async function waitUntil(iso) {
  const delay = Math.max(0, Date.parse(iso) - Date.now() + 5);
  await new Promise((resolve) => setTimeout(resolve, delay));
}

async function settledCompetition() {
  await createAgent(
    "rules_first_disposition_lora",
    "Rules first disposition",
    "shipment disposition",
    "Release probability is 0.9 based on the current stability rule."
  );
  await createAgent(
    "legacy_conservative_disposition_lora",
    "Legacy conservative disposition",
    "shipment disposition",
    "Release probability is 0.1 under the legacy conservative rule."
  );
  const session = await createSession("Historical shipment");
  const run = await runMessage(
    session.session_id,
    "Ask @rules_first_disposition and @legacy_conservative_disposition for the shipment disposition.",
    { max_routing_adapters: 3 }
  );
  const rules = run.expert_outputs.find((step) => step.adapter === "rules_first_disposition_lora");
  const legacy = run.expert_outputs.find((step) => step.adapter === "legacy_conservative_disposition_lora");
  const resolverReference = "pharmacy-disposition:NS-204";
  const dueAt = futureIso();
  await request(app)
    .post(`/api/chat/runs/${run.run_id}/outcome-contracts`)
    .send({
      title: "Forged prediction",
      claim: "A value not present in the route output must not earn reputation.",
      domain: "cold_chain_disposition",
      task_type: "shipment_release",
      outcome_type: "binary",
      resolver: { type: "human", authority: "Chief Pharmacist", reference: resolverReference },
      resolution: { metric: "released", due_at: dueAt },
      predictions: [{
        step_id: rules.step_id,
        value: 0.1,
        confidence: 0.9,
        evidence_quote: "Release probability is 0.9 based on the current stability rule."
      }]
    })
    .expect(400);
  const contractPayload = {
    title: "Shipment NS-204 disposition",
    claim: "Shipment NS-204 will be released after pharmacist review.",
    domain: "cold_chain_disposition",
    task_type: "shipment_release",
    outcome_type: "binary",
    resolver: { type: "human", authority: "Chief Pharmacist", reference: resolverReference },
    resolution: { metric: "released", due_at: dueAt },
    predictions: [
      {
        step_id: rules.step_id,
        value: 0.9,
        confidence: 0.9,
        evidence_quote: "Release probability is 0.9 based on the current stability rule."
      },
      {
        step_id: legacy.step_id,
        value: 0.1,
        confidence: 0.9,
        evidence_quote: "Release probability is 0.1 under the legacy conservative rule."
      }
    ]
  };
  const contractKey = `contract-${run.run_id}`;
  const contract = await request(app)
    .post(`/api/chat/runs/${run.run_id}/outcome-contracts`)
    .set("Idempotency-Key", contractKey)
    .send(contractPayload)
    .expect(201);
  const repeatedContract = await request(app)
    .post(`/api/chat/runs/${run.run_id}/outcome-contracts`)
    .set("Idempotency-Key", contractKey)
    .send(contractPayload)
    .expect(201);
  expect(repeatedContract.body.contract_id).toBe(contract.body.contract_id);
  const settlementPayload = {
    actual_value: true,
    source: {
      type: "human",
      authority: "Chief Pharmacist",
      reference: resolverReference
    }
  };
  const settlementKey = `settlement-${run.run_id}`;
  await request(app)
    .post(`/api/outcome-contracts/${contract.body.contract_id}/settlements`)
    .set("Idempotency-Key", settlementKey)
    .send(settlementPayload)
    .expect(409);
  await waitUntil(dueAt);
  await request(app)
    .post(`/api/outcome-contracts/${contract.body.contract_id}/settlements`)
    .set("Idempotency-Key", settlementKey)
    .send({
      ...settlementPayload,
      source: { ...settlementPayload.source, reference: "different-source" }
    })
    .expect(400);
  const tokensBeforeResolver = process.env.APP_API_TOKENS_JSON;
  configurePharmacyResolverPrincipal();
  const settled = await request(app)
    .post(`/api/outcome-contracts/${contract.body.contract_id}/settlements`)
    .set(RESOLVER_AUTH)
    .set("Idempotency-Key", settlementKey)
    .send(settlementPayload)
    .expect(201);
  const repeatedSettlement = await request(app)
    .post(`/api/outcome-contracts/${contract.body.contract_id}/settlements`)
    .set(RESOLVER_AUTH)
    .set("Idempotency-Key", settlementKey)
    .send(settlementPayload)
    .expect(201);
  if (tokensBeforeResolver === undefined) delete process.env.APP_API_TOKENS_JSON;
  else process.env.APP_API_TOKENS_JSON = tokensBeforeResolver;
  expect(repeatedSettlement.body.settlement.settlement_id).toBe(settled.body.settlement.settlement_id);
  return { run, contract: settled.body, contractPayload, resolverReference, resolverAuth: RESOLVER_AUTH };
}

describe("execution provenance and Outcome Contracts", () => {
  it("bounds resolver-principal bindings and the routing sample threshold", async () => {
    const identity = parseConfiguredApiTokens({
      APP_API_TOKENS_JSON: JSON.stringify({
        oracle_token: {
          user_id: "oracle",
          workspace_id: "workspace_a",
          role: "admin",
          resolver_bindings: [{
            type: "api",
            authority: "Signed outcome feed",
            reference_prefix: "outcome:2026:"
          }]
        }
      })
    }).get("oracle_token");
    expect(identity).toMatchObject({
      user_id: "oracle",
      role: "admin",
      auth_type: "bearer",
      resolver_bindings: [{
        type: "api",
        authority: "Signed outcome feed",
        reference_prefix: "outcome:2026:"
      }]
    });
    expect(() => parseConfiguredApiTokens({
      APP_API_TOKENS_JSON: JSON.stringify({
        token: {
          role: "admin",
          resolver_bindings: [{
            type: "api",
            authority: "Feed",
            reference_prefix: "short"
          }]
        }
      })
    })).toThrow(/at least 8 characters/);
    expect(() => parseConfiguredApiTokens({
      APP_API_TOKENS_JSON: JSON.stringify({
        token: {
          role: "admin",
          resolver_bindings: [{
            type: "api",
            authority: "Feed",
            reference: "exact",
            reference_prefix: "outcome:"
          }]
        }
      })
    })).toThrow(/exactly one/);

    expect(realityRankMinVerifiedSamples({})).toBe(3);
    expect(realityRankMinVerifiedSamples({ VIRENIS_REALITY_RANK_MIN_VERIFIED_SAMPLES: "1" })).toBe(1);
    for (const invalid of ["0", "101", "1.5", "three"]) {
      expect(() => realityRankMinVerifiedSamples({
        VIRENIS_REALITY_RANK_MIN_VERIFIED_SAMPLES: invalid
      })).toThrow(/integer from 1 to 100/);
    }
    process.env.VIRENIS_REALITY_RANK_MIN_VERIFIED_SAMPLES = "0";
    await expect(createApp({
      dbPath: path.join(tmpDir, "invalid-rank-threshold.json"),
      uploadRoot: tmpDir
    })).rejects.toThrow(/VIRENIS_REALITY_RANK_MIN_VERIFIED_SAMPLES/);
    delete process.env.VIRENIS_REALITY_RANK_MIN_VERIFIED_SAMPLES;
  });

  it("deletes uploaded knowledge through the API while preserving only its provenance revision", async () => {
    const upload = await request(app)
      .post("/api/documents")
      .field("title", "Disposable cold chain fixture")
      .field("agent_id", "disposable_cold_chain")
      .field("routing_cues", "disposable cold chain")
      .attach(
        "file",
        Buffer.from("Cold chain evidence requires a pharmacist review after a controlled temperature excursion. The verified release threshold is forty minutes."),
        "disposable.txt"
      )
      .expect(201);
    const storedBefore = app.locals.store.read().documents.find((document) => document.document_id === upload.body.document_id);
    const storedRoot = path.resolve(tmpDir, storedBefore.document_root);
    await fs.access(storedRoot);

    const deleted = await request(app)
      .delete(`/api/documents/${upload.body.document_id}`)
      .expect(200);
    expect(deleted.body).toMatchObject({
      status: "deleted",
      document_id: upload.body.document_id,
      agent_id: "disposable_cold_chain"
    });
    expect(deleted.body.corpus_revision).toMatch(/^sha256:[a-f0-9]{64}$/);
    await expect(fs.access(storedRoot)).rejects.toMatchObject({ code: "ENOENT" });

    const documents = await request(app).get("/api/documents").expect(200);
    expect(documents.body.documents.map((document) => document.document_id)).not.toContain(upload.body.document_id);
    await request(app)
      .post(`/api/documents/${upload.body.document_id}/search`)
      .send({ query: "threshold" })
      .expect(410);
    const agent = await request(app).get("/api/agents/disposable_cold_chain").expect(200);
    expect(agent.body.enabled).toBe(false);
    const events = await request(app).get("/api/agents/disposable_cold_chain/events").expect(200);
    expect(events.body.events.at(-1).event_type).toBe("document_agent.deleted");
    expect(events.body.event_chain_valid).toBe(true);
  });

  it("keeps a tamper-evident lifecycle history for user-created agents", async () => {
    await createAgent("audited_brain_lora", "Audited brain", "audited decision");
    const initial = await request(app).get("/api/agents/audited_brain_lora/events").expect(200);
    expect(initial.body.events.map((event) => event.event_type)).toEqual(["agent.created"]);
    expect(initial.body.event_chain_valid).toBe(true);
    const firstRevision = initial.body.agent_revision;

    await request(app)
      .patch("/api/agents/audited_brain_lora")
      .send({ boundary: "Use approved evidence and report uncertainty explicitly." })
      .expect(200);
    await request(app).delete("/api/agents/audited_brain_lora").expect(200);

    const history = await request(app).get("/api/agents/audited_brain_lora/events").expect(200);
    expect(history.body.events.map((event) => event.event_type)).toEqual([
      "agent.created",
      "agent.updated",
      "agent.archived"
    ]);
    expect(history.body.agent_revision).not.toBe(firstRevision);
    expect(history.body.event_chain_valid).toBe(true);
    const tampered = structuredClone(history.body.events);
    tampered[1].details.changed_fields = ["forged"];
    expect(verifyEventChain(tampered)).toBe(false);
  });

  it("automatically records immutable execution provenance and enforces tenant isolation", async () => {
    process.env.APP_API_TOKENS_JSON = JSON.stringify({
      alice_token: { user_id: "alice", workspace_id: "workspace_a", role: "user" },
      bob_token: { user_id: "bob", workspace_id: "workspace_b", role: "user" }
    });
    const auth = { Authorization: "Bearer alice_token" };
    await request(app)
      .post("/api/agents")
      .set(auth)
      .send({
        id: "alice_forecast_lora",
        title: "Alice forecast",
        capability: "Forecasts Alice's approved operating metric.",
        boundary: "Use only Alice's private source.",
        routing_cues: "alice forecast",
        source_text: "The approved forecast is stable."
      })
      .expect(201);
    const session = (await request(app).post("/api/chat/sessions").set(auth).send({ title: "Alice" }).expect(201)).body;
    const queued = await request(app)
      .post(`/api/chat/sessions/${session.session_id}/messages`)
      .set(auth)
      .send({ content: "Ask @alice_forecast for the alice forecast." })
      .expect(202);
    let run;
    for (let attempt = 0; attempt < 400; attempt += 1) {
      run = (await request(app).get(`/api/chat/runs/${queued.body.run_id}`).set(auth).expect(200)).body;
      if (run.status === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(run.execution).toMatchObject({ schema_version: "virenis-execution-v1" });
    expect(run.execution.record_hash).toMatch(/^sha256:[a-f0-9]{64}$/);

    const receipt = await request(app).get(`/api/executions/${run.execution.execution_id}`).set(auth).expect(200);
    expect(receipt.body.participants.map((item) => item.agent_id)).toContain("alice_forecast_lora");
    expect(receipt.body.query).toBeUndefined();
    expect(receipt.body.query_digest).toMatch(/^sha256:/);
    await request(app)
      .get(`/api/executions/${run.execution.execution_id}`)
      .set("Authorization", "Bearer bob_token")
      .expect(404);
  });

  it("never returns another user's private contract on a same-workspace idempotency collision", async () => {
    process.env.APP_API_TOKENS_JSON = JSON.stringify({
      alice_token: { user_id: "alice", workspace_id: "shared_workspace", role: "admin" },
      bob_token: { user_id: "bob", workspace_id: "shared_workspace", role: "user" }
    });
    const aliceAuth = { Authorization: "Bearer alice_token" };
    const bobAuth = { Authorization: "Bearer bob_token" };
    await createAgent(
      "shared_forecast_lora",
      "Shared forecast",
      "shared collision forecast",
      "Shared collision probability is 0.7.",
      aliceAuth
    );
    const aliceSession = await createSession("Alice collision", aliceAuth);
    const bobSession = await createSession("Bob collision", bobAuth);
    const query = "Ask @shared_forecast for the shared collision forecast.";
    const aliceRun = await runMessage(aliceSession.session_id, query, {}, aliceAuth);
    const bobRun = await runMessage(bobSession.session_id, query, {}, bobAuth);
    const dueAt = futureIso(1000);
    const payload = {
      title: "Shared collision outcome",
      claim: "The shared collision outcome will occur.",
      domain: "shared_collision",
      task_type: "decision",
      outcome_type: "binary",
      resolver: { type: "human", authority: "Shared verifier", reference: "shared:collision:1" },
      resolution: { metric: "occurred", due_at: dueAt },
      predictions: [{
        agent_id: "shared_forecast_lora",
        value: 0.7,
        confidence: 0.7,
        evidence_quote: "Shared collision probability is 0.7."
      }]
    };
    const key = "same-workspace-idempotency-key";
    const aliceContract = await request(app)
      .post(`/api/chat/runs/${aliceRun.run_id}/outcome-contracts`)
      .set(aliceAuth)
      .set("Idempotency-Key", key)
      .send(payload)
      .expect(201);
    await request(app)
      .post(`/api/chat/runs/${bobRun.run_id}/outcome-contracts`)
      .set(bobAuth)
      .set("Idempotency-Key", key)
      .send(payload)
      .expect(409);
    await request(app)
      .get(`/api/outcome-contracts/${aliceContract.body.contract_id}`)
      .set(bobAuth)
      .expect(404);
  });

  it("requires a future observation window, a frozen resolver reference, and token-bound evidence", async () => {
    await createAgent(
      "boundary_number_lora",
      "Boundary number",
      "boundary number forecast",
      "The approved batch count is 10."
    );
    const session = await createSession("Boundary checks");
    const run = await runMessage(session.session_id, "Ask @boundary_number for the boundary number forecast.");
    const base = {
      title: "Boundary outcome",
      claim: "The approved batch count will be observed.",
      domain: "boundary_number",
      task_type: "decision",
      outcome_type: "numeric",
      resolver: { type: "document", authority: "Batch ledger", reference: "ledger:batch:1" },
      resolution: { metric: "batch_count", error_scale: 1 },
      predictions: [{
        agent_id: "boundary_number_lora",
        value: 1,
        confidence: 0.8,
        evidence_quote: "The approved batch count is 10."
      }]
    };
    await request(app)
      .post(`/api/chat/runs/${run.run_id}/outcome-contracts`)
      .send(base)
      .expect(400);
    await request(app)
      .post(`/api/chat/runs/${run.run_id}/outcome-contracts`)
      .send({
        ...base,
        resolution: { ...base.resolution, due_at: new Date(Date.now() - 1000).toISOString() }
      })
      .expect(400);
    await request(app)
      .post(`/api/chat/runs/${run.run_id}/outcome-contracts`)
      .send({
        ...base,
        resolver: { type: "document", authority: "Batch ledger" },
        resolution: { ...base.resolution, due_at: futureIso(1000) }
      })
      .expect(400);
    await request(app)
      .post(`/api/chat/runs/${run.run_id}/outcome-contracts`)
      .send({ ...base, resolution: { ...base.resolution, due_at: futureIso(1000) } })
      .expect(400);
  });

  it("refuses to contract against a corrupted execution receipt", async () => {
    await createAgent(
      "receipt_guard_lora",
      "Receipt guard",
      "receipt integrity forecast",
      "Receipt integrity probability is 0.6."
    );
    const session = await createSession("Receipt integrity");
    const run = await runMessage(session.session_id, "Ask @receipt_guard for the receipt integrity forecast.");
    await app.locals.store.mutate((data) => {
      const execution = data.executionRecords.find((record) => record.execution_id === run.execution.execution_id);
      execution.query_digest = "sha256:" + "0".repeat(64);
      return execution;
    });
    await request(app)
      .post(`/api/chat/runs/${run.run_id}/outcome-contracts`)
      .send({
        title: "Receipt outcome",
        claim: "The receipt-backed event will occur.",
        domain: "receipt_integrity",
        task_type: "decision",
        outcome_type: "binary",
        resolver: { type: "human", authority: "Receipt verifier", reference: "receipt:1" },
        resolution: { metric: "occurred", due_at: futureIso(1000) },
        predictions: [{
          agent_id: "receipt_guard_lora",
          value: 0.6,
          confidence: 0.6,
          evidence_quote: "Receipt integrity probability is 0.6."
        }]
      })
      .expect(409);
  });

  it("keeps user-attested settlements as tracking data without creating routing reputation", async () => {
    process.env.APP_API_TOKENS_JSON = JSON.stringify({
      tracker_token: {
        user_id: "tracker",
        workspace_id: "tracking_workspace",
        role: "user",
        resolver_bindings: [{
          type: "human",
          authority: "Unverified tracker",
          reference: "tracking:1"
        }]
      }
    });
    const auth = { Authorization: "Bearer tracker_token" };
    await createAgent(
      "tracking_alpha_lora",
      "Tracking alpha",
      "tracking-only forecast",
      "Tracking-only probability is 0.8.",
      auth
    );
    await createAgent(
      "tracking_beta_lora",
      "Tracking beta",
      "tracking-only forecast",
      "Tracking-only probability is 0.2.",
      auth
    );
    const historicalSession = await createSession("Tracking history", auth);
    const historical = await runMessage(
      historicalSession.session_id,
      "Ask @tracking_alpha for the tracking-only forecast.",
      {},
      auth
    );
    const dueAt = futureIso();
    const resolver = { type: "human", authority: "Unverified tracker", reference: "tracking:1" };
    const contract = await request(app)
      .post(`/api/chat/runs/${historical.run_id}/outcome-contracts`)
      .set(auth)
      .send({
        title: "Tracking-only outcome",
        claim: "The tracking-only event will occur.",
        domain: "tracking_only",
        task_type: "decision",
        outcome_type: "binary",
        resolver,
        resolution: { metric: "occurred", due_at: dueAt },
        predictions: [{
          agent_id: "tracking_alpha_lora",
          value: 0.8,
          confidence: 0.8,
          evidence_quote: "Tracking-only probability is 0.8."
        }]
      })
      .expect(201);
    await waitUntil(dueAt);
    const settled = await request(app)
      .post(`/api/outcome-contracts/${contract.body.contract_id}/settlements`)
      .set(auth)
      .send({ actual_value: true, source: resolver })
      .expect(201);
    expect(settled.body.settlement).toMatchObject({
      verified_for_rank: false,
      verification_role: "tracking_only"
    });
    expect(settled.body.settlement.participant_scores[0].rank_weight).toBe(0);
    const rank = await request(app)
      .get("/api/agents/tracking_alpha_lora/reality-rank")
      .set(auth)
      .expect(200);
    expect(rank.body).toMatchObject({ score: 50, sample_size: 0, effective_sample_size: 0 });

    const routingSession = await createSession("Tracking routing", auth);
    const routed = await runMessage(
      routingSession.session_id,
      "Provide the tracking-only forecast.",
      { max_routing_adapters: 1 },
      auth
    );
    expect(routed.plan.routing.selected[0].source).toBe("cue");
  });

  it("keeps an authenticated admin without the frozen resolver binding tracking-only", async () => {
    process.env.APP_API_TOKENS_JSON = JSON.stringify({
      unbound_admin_token: {
        user_id: "operations_admin",
        workspace_id: "unbound_workspace",
        role: "admin",
        resolver_bindings: [{
          type: "api",
          authority: "Independent signed feed",
          reference_prefix: "outcome:other:"
        }]
      }
    });
    const auth = { Authorization: "Bearer unbound_admin_token" };
    await createAgent(
      "unbound_admin_forecast_lora",
      "Unbound admin forecast",
      "unbound admin forecast",
      "Unbound admin probability is 0.75.",
      auth
    );
    const session = await createSession("Unbound admin history", auth);
    const run = await runMessage(
      session.session_id,
      "Ask @unbound_admin_forecast for the unbound admin forecast.",
      {},
      auth
    );
    const dueAt = futureIso();
    const resolver = {
      type: "api",
      authority: "Independent signed feed",
      reference: "outcome:unbound:1"
    };
    const contract = await request(app)
      .post(`/api/chat/runs/${run.run_id}/outcome-contracts`)
      .set(auth)
      .send({
        title: "Unbound admin outcome",
        claim: "The independently observed event will occur.",
        domain: "unbound_admin",
        task_type: "decision",
        outcome_type: "binary",
        resolver,
        resolution: { metric: "occurred", due_at: dueAt },
        predictions: [{
          agent_id: "unbound_admin_forecast_lora",
          value: 0.75,
          confidence: 0.75,
          evidence_quote: "Unbound admin probability is 0.75."
        }]
      })
      .expect(201);
    await waitUntil(dueAt);
    const settled = await request(app)
      .post(`/api/outcome-contracts/${contract.body.contract_id}/settlements`)
      .set(auth)
      .send({ actual_value: true, source: resolver })
      .expect(201);
    expect(settled.body.settlement).toMatchObject({
      settled_by: "operations_admin",
      verified_for_rank: false,
      verification_role: "tracking_only",
      resolver_principal: null
    });
    expect(settled.body.settlement.participant_scores[0]).toMatchObject({
      rank_weight: 0,
      trust_weight: 0
    });
    expect(settled.body.integrity.settlement_rank_authorizations_valid).toBe(true);
  });

  it("excludes hash-invalid settlements and contract definitions from RealityRank", async () => {
    const { contract } = await settledCompetition();
    const originalUtility = contract.settlement.participant_scores[0].utility;
    await app.locals.store.mutate((data) => {
      const mutable = data.outcomeContracts.find((item) => item.contract_id === contract.contract_id);
      mutable.settlement.participant_scores[0].utility = 0;
      mutable.settlements.at(-1).participant_scores[0].utility = 0;
      return mutable;
    });
    const settlementTamper = await request(app)
      .get(`/api/outcome-contracts/${contract.contract_id}`)
      .expect(200);
    expect(settlementTamper.body).toMatchObject({
      integrity_valid: false,
      contract_definition_valid: true,
      settlement_hashes_valid: false,
      event_chain_valid: true
    });
    const excluded = await request(app)
      .get("/api/agents/rules_first_disposition_lora/reality-rank")
      .expect(200);
    expect(excluded.body).toMatchObject({ score: 50, sample_size: 0 });

    await app.locals.store.mutate((data) => {
      const mutable = data.outcomeContracts.find((item) => item.contract_id === contract.contract_id);
      mutable.settlement.participant_scores[0].utility = originalUtility;
      mutable.settlements.at(-1).participant_scores[0].utility = originalUtility;
      mutable.claim = "Tampered contract definition";
      return mutable;
    });
    const definitionTamper = await request(app)
      .get(`/api/outcome-contracts/${contract.contract_id}`)
      .expect(200);
    expect(definitionTamper.body.integrity).toMatchObject({
      valid: false,
      contract_definition_valid: false,
      settlement_hashes_valid: true
    });

    await app.locals.store.mutate((data) => {
      const mutable = data.outcomeContracts.find((item) => item.contract_id === contract.contract_id);
      mutable.claim = contract.claim;
      mutable.events.at(-1).payload.settlement_hash = "sha256:" + "f".repeat(64);
      return mutable;
    });
    const eventTamper = await request(app)
      .get(`/api/outcome-contracts/${contract.contract_id}`)
      .expect(200);
    expect(eventTamper.body.integrity).toMatchObject({
      valid: false,
      contract_definition_valid: true,
      settlement_hashes_valid: true,
      event_chain_valid: false,
      event_bindings_valid: false
    });
  });

  it("rejects a self-consistently rehashed resolver-principal mismatch", async () => {
    const { contract } = await settledCompetition();
    await app.locals.store.mutate((data) => {
      const mutable = data.outcomeContracts.find((item) => item.contract_id === contract.contract_id);
      const settlement = mutable.settlements.at(-1);
      settlement.resolver_principal.reference_prefix = "forged-pharmacy-namespace:";
      const unsignedSettlement = structuredClone(settlement);
      delete unsignedSettlement.settlement_hash;
      settlement.settlement_hash = digestValue(unsignedSettlement);
      mutable.settlement = structuredClone(settlement);
      let previousEventHash = null;
      for (const event of mutable.events) {
        if (event.payload?.settlement_id === settlement.settlement_id) {
          event.payload.settlement_hash = settlement.settlement_hash;
        }
        event.previous_event_hash = previousEventHash;
        const unsignedEvent = structuredClone(event);
        delete unsignedEvent.event_hash;
        event.event_hash = digestValue(unsignedEvent);
        previousEventHash = event.event_hash;
      }
      return mutable;
    });

    const forged = await request(app)
      .get(`/api/outcome-contracts/${contract.contract_id}`)
      .expect(200);
    expect(forged.body.integrity).toMatchObject({
      valid: false,
      settlement_hashes_valid: true,
      settlement_rank_authorizations_valid: false,
      settlement_chain_valid: true,
      event_chain_valid: true,
      event_bindings_valid: true
    });
    const rank = await request(app)
      .get("/api/agents/rules_first_disposition_lora/reality-rank")
      .expect(200);
    expect(rank.body).toMatchObject({ score: 50, sample_size: 0, routing_eligible: false });
  });

  it("rejects a correction timestamp before the frozen observation deadline", async () => {
    const { contract, resolverReference } = await settledCompetition();
    const beforeDue = new Date(Date.parse(contract.resolution.due_at) - 1).toISOString();
    expect(() => correctOutcomeContract(
      structuredClone(contract),
      {
        supersedes_settlement_id: contract.settlement.settlement_id,
        actual_value: false,
        reason: "A non-monotonic clock must not bypass the observation window.",
        source: {
          type: "human",
          authority: "Chief Pharmacist",
          reference: resolverReference
        }
      },
      { user_id: "admin", role: "admin" },
      beforeDue,
      `early-correction-${contract.contract_id}`
    )).toThrow(/before resolution\.due_at/);
  });

  it("settles objective outcomes, ranks exact agent revisions, and refuses duplicate settlement", async () => {
    const { run, contract, contractPayload, resolverReference, resolverAuth } = await settledCompetition();
    expect(contract.status).toBe("settled");
    expect(contract.integrity_valid).toBe(true);
    expect(contract.integrity).toMatchObject({
      contract_definition_valid: true,
      settlement_hashes_valid: true,
      settlement_rank_authorizations_valid: true,
      event_chain_valid: true,
      execution_record_valid: true
    });
    expect(contract.settlement).toMatchObject({
      verified_for_rank: true,
      verification_role: "resolver_principal",
      resolver_principal: {
        principal_id: "pharmacy_oracle",
        auth_type: "bearer",
        type: "human",
        authority: "Chief Pharmacist",
        reference_match: "prefix",
        reference_prefix: "pharmacy-disposition:"
      }
    });
    expect(contract.settlement.participant_scores[0].utility).toBeGreaterThan(
      contract.settlement.participant_scores[1].utility
    );
    expect(verifyEventChain(contract.events)).toBe(true);

    await request(app)
      .post(`/api/chat/runs/${run.run_id}/outcome-contracts`)
      .set("Idempotency-Key", `second-contract-${run.run_id}`)
      .send(contractPayload)
      .expect(409);

    await request(app)
      .post(`/api/outcome-contracts/${contract.contract_id}/settlements`)
      .send({
        actual_value: false,
        source: { type: "human", authority: "Chief Pharmacist", reference: "changed" }
      })
      .expect(409);

    const good = await request(app).get("/api/agents/rules_first_disposition_lora/reality-rank").expect(200);
    const poor = await request(app).get("/api/agents/legacy_conservative_disposition_lora/reality-rank").expect(200);
    expect(good.body.sample_size).toBe(1);
    expect(good.body.score).toBeGreaterThan(poor.body.score);
    expect(good.body.routing_use).toBe("capability_tie_breaker_only");

    const disputed = await request(app)
      .post(`/api/outcome-contracts/${contract.contract_id}/disputes`)
      .send({ reason: "The first pharmacy feed was later found to be incorrect." })
      .expect(201);
    expect(disputed.body.status).toBe("disputed");
    const excludedWhileDisputed = await request(app)
      .get("/api/agents/rules_first_disposition_lora/reality-rank")
      .expect(200);
    expect(excludedWhileDisputed.body.sample_size).toBe(0);

    const correctionKeyA = `correction-a-${contract.contract_id}`;
    const correctionPayloadA = {
      supersedes_settlement_id: contract.settlement.settlement_id,
      actual_value: false,
      reason: "Verified replacement feed shows quarantine.",
      source: {
        type: "human",
        authority: "Chief Pharmacist",
        reference: resolverReference
      }
    };
    configurePharmacyResolverPrincipal();
    const corrected = await request(app)
      .post(`/api/outcome-contracts/${contract.contract_id}/corrections`)
      .set(resolverAuth)
      .set("Idempotency-Key", correctionKeyA)
      .send(correctionPayloadA)
      .expect(201);
    delete process.env.APP_API_TOKENS_JSON;
    expect(corrected.body.status).toBe("settled");
    expect(corrected.body.settlements).toHaveLength(2);
    expect(verifyEventChain(corrected.body.events)).toBe(true);
    const correctedGood = await request(app).get("/api/agents/rules_first_disposition_lora/reality-rank").expect(200);
    const correctedPoor = await request(app).get("/api/agents/legacy_conservative_disposition_lora/reality-rank").expect(200);
    expect(correctedPoor.body.score).toBeGreaterThan(correctedGood.body.score);

    const correctionPayloadB = {
      supersedes_settlement_id: corrected.body.settlement.settlement_id,
      actual_value: true,
      reason: "Final signed disposition confirms release.",
      source: {
        type: "human",
        authority: "Chief Pharmacist",
        reference: resolverReference
      }
    };
    configurePharmacyResolverPrincipal();
    const correctedAgain = await request(app)
      .post(`/api/outcome-contracts/${contract.contract_id}/corrections`)
      .set(resolverAuth)
      .set("Idempotency-Key", `correction-b-${contract.contract_id}`)
      .send(correctionPayloadB)
      .expect(201);
    const eventCount = correctedAgain.body.events.length;
    const replayedOldCorrection = await request(app)
      .post(`/api/outcome-contracts/${contract.contract_id}/corrections`)
      .set(resolverAuth)
      .set("Idempotency-Key", correctionKeyA)
      .send(correctionPayloadA)
      .expect(201);
    delete process.env.APP_API_TOKENS_JSON;
    expect(replayedOldCorrection.body.settlement.settlement_id).toBe(correctedAgain.body.settlement.settlement_id);
    expect(replayedOldCorrection.body.settlements).toHaveLength(3);
    expect(replayedOldCorrection.body.events).toHaveLength(eventCount);
    expect(replayedOldCorrection.body.integrity_valid).toBe(true);

    await request(app)
      .patch("/api/agents/rules_first_disposition_lora")
      .send({ boundary: "A revised policy starts a new empirical revision." })
      .expect(200);
    const revised = await request(app).get("/api/agents/rules_first_disposition_lora/reality-rank").expect(200);
    expect(revised.body.score).toBe(50);
    expect(revised.body.sample_size).toBe(0);
    expect(revised.body.versions.some((version) => version.sample_size === 1)).toBe(true);
  });

  it("uses settled outcomes only to break capability ties and preserves explicit overrides", async () => {
    await settledCompetition();
    const provisionalRank = await request(app)
      .get("/api/agents/rules_first_disposition_lora/reality-rank")
      .expect(200);
    expect(provisionalRank.body).toMatchObject({
      sample_size: 1,
      status: "provisional",
      routing_eligible: false,
      minimum_verified_samples: 3
    });
    const session = await createSession("Next shipment");
    const provisionalRoute = await runMessage(
      session.session_id,
      "Provide a cold chain shipment disposition decision.",
      { max_routing_adapters: 1 }
    );
    expect(provisionalRoute.plan.routing.selected[0].source).toBe("cue");
    expect(provisionalRoute.plan.routing.candidate_trace.every((candidate) => candidate.rank_supplied === false)).toBe(true);

    process.env.VIRENIS_REALITY_RANK_MIN_VERIFIED_SAMPLES = "1";
    const controlledSession = await createSession("Controlled threshold proof");
    const routed = await runMessage(
      controlledSession.session_id,
      "Provide a cold chain shipment disposition decision.",
      { max_routing_adapters: 1 }
    );
    expect(routed.plan.steps.map((step) => step.adapter)).toContain("rules_first_disposition_lora");
    expect(routed.plan.steps.map((step) => step.adapter)).not.toContain("legacy_conservative_disposition_lora");
    expect(routed.plan.routing.selected[0]).toMatchObject({
      adapter: "rules_first_disposition_lora",
      source: "cue+reality_rank"
    });
    const routedCandidate = routed.plan.routing.candidate_trace.find((candidate) =>
      candidate.adapter === "rules_first_disposition_lora"
    );
    expect(routedCandidate).toMatchObject({ rank_sample_size: 1, rank_supplied: true });

    const explicitSession = await createSession("Explicit override");
    const explicit = await runMessage(
      explicitSession.session_id,
      "Ask @legacy_conservative_disposition for the cold chain shipment disposition.",
      { max_routing_adapters: 1 }
    );
    expect(explicit.plan.steps.map((step) => step.adapter)).toContain("legacy_conservative_disposition_lora");
    expect(explicit.plan.routing.selected[0]).toMatchObject({
      adapter: "legacy_conservative_disposition_lora",
      source: "explicit"
    });
  });
});

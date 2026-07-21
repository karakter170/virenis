import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../server/app.js";
import { verifyBillingState } from "../server/billing.js";
import { setRuntimeFetchForTests } from "../server/runtimeClient.js";
import { composeWorkflowFallback } from "../server/workflows.js";

const TOKENS = {
  admin: "billing_admin_token_0123456789",
  alice: "billing_alice_token_0123456789",
  bob: "billing_bob_token_0123456789"
};
const auth = (name) => ({ Authorization: `Bearer ${TOKENS[name]}` });
const MANAGED_ENV = [
  "APP_API_TOKENS_JSON",
  "WEB_STORE_DRIVER",
  "TCAR_ENGINE_MODE",
  "TCAR_RUNTIME_API_URL",
  "TCAR_RUNTIME_API_KEY",
  "APP_BILLING_WELCOME_CREDITS",
  "APP_BILLING_PROMPT_CREDITS_PER_1K",
  "APP_BILLING_COMPLETION_CREDITS_PER_1K",
  "APP_BILLING_CACHED_CREDITS_PER_1K",
  "APP_BILLING_UNCLASSIFIED_CREDITS_PER_1K",
  "APP_BILLING_MINIMUM_RESERVATION_CREDITS",
  "APP_MAX_ACTIVE_RUNS_PER_USER",
  "APP_MAX_ACTIVE_RUNS_PER_WORKSPACE",
  "APP_MAX_ACTIVE_RUNS_GLOBAL"
];

let app;
let tmpDir;
let previousEnv;
let previousFetch;
let restoreRuntimeFetch;

beforeEach(async () => {
  previousEnv = Object.fromEntries(MANAGED_ENV.map((name) => [name, process.env[name]]));
  previousFetch = globalThis.fetch;
  restoreRuntimeFetch = setRuntimeFetchForTests((...args) => globalThis.fetch(...args));
  process.env.WEB_STORE_DRIVER = "json";
  process.env.TCAR_ENGINE_MODE = "simulator";
  process.env.APP_BILLING_WELCOME_CREDITS = "1000";
  process.env.APP_BILLING_PROMPT_CREDITS_PER_1K = "0.1";
  process.env.APP_BILLING_COMPLETION_CREDITS_PER_1K = "0.2";
  process.env.APP_BILLING_CACHED_CREDITS_PER_1K = "0.02";
  process.env.APP_BILLING_UNCLASSIFIED_CREDITS_PER_1K = "0.2";
  process.env.APP_BILLING_MINIMUM_RESERVATION_CREDITS = "0.1";
  process.env.APP_API_TOKENS_JSON = JSON.stringify({
    [TOKENS.admin]: { user_id: "billing_admin", workspace_id: "workspace_admin", role: "admin" },
    [TOKENS.alice]: { user_id: "billing_alice", workspace_id: "workspace_alice", role: "user" },
    [TOKENS.bob]: { user_id: "billing_bob", workspace_id: "workspace_bob", role: "user" }
  });
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "virenis-billing-api-"));
});

afterEach(async () => {
  await app?.locals?.drainBackgroundTasks?.({ timeoutMs: 5000 });
  await app?.locals?.store?.close?.();
  app = null;
  globalThis.fetch = previousFetch;
  restoreRuntimeFetch?.();
  for (const [name, value] of Object.entries(previousEnv || {})) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("tenant-safe billing APIs", () => {
  it("fails startup when initial pricing is malformed", async () => {
    process.env.APP_BILLING_PROMPT_CREDITS_PER_1K = "1e3";
    await expect(startApp({ autoRun: false })).rejects.toMatchObject({
      code: "billing_amount_invalid",
      status: 400
    });
  });

  it("isolates balances and protects all admin mutations", async () => {
    await startApp({ autoRun: false });
    const alice = await request(app).get("/api/billing/account").set(auth("alice")).expect(200);
    const bob = await request(app).get("/api/billing/account").set(auth("bob")).expect(200);
    expect(alice.body.account).toMatchObject({ user_id: "billing_alice", workspace_id: "workspace_alice", balance_credits: "1000" });
    expect(bob.body.account).toMatchObject({ user_id: "billing_bob", workspace_id: "workspace_bob", balance_credits: "1000" });
    expect(alice.body.pricing).not.toHaveProperty("created_by");
    expect(alice.body.account.account_id).not.toBe(bob.body.account.account_id);

    await request(app).get("/api/admin/billing/accounts").set(auth("alice")).expect(403);
    await request(app)
      .post("/api/admin/billing/accounts/billing_bob/adjustments")
      .set(auth("alice"))
      .set("Idempotency-Key", "forbidden-adjustment-0001")
      .send({ amount_credits: "999", reason: "Unauthorized" })
      .expect(403);

    const adjusted = await request(app)
      .post("/api/admin/billing/accounts/billing_alice/adjustments")
      .set(auth("admin"))
      .set("Idempotency-Key", "support-adjustment-0001")
      .send({ amount_credits: "12.5", reason: "Support goodwill" })
      .expect(201);
    expect(adjusted.body.account.balance_credits).toBe("1012.5");

    const replay = await request(app)
      .post("/api/admin/billing/accounts/billing_alice/adjustments")
      .set(auth("admin"))
      .set("Idempotency-Key", "support-adjustment-0001")
      .send({ amount_credits: "12.5", reason: "Support goodwill" })
      .expect(200);
    expect(replay.body.duplicate).toBe(true);
    await request(app)
      .post("/api/admin/billing/accounts/billing_alice/adjustments")
      .set(auth("admin"))
      .set("Idempotency-Key", "support-adjustment-0001")
      .send({ amount_credits: "13", reason: "Changed replay" })
      .expect(409);
    await request(app)
      .post("/api/admin/billing/accounts/billing_alice/adjustments")
      .set(auth("admin"))
      .set("Idempotency-Key", "workspace-mismatch-0001")
      .send({ workspace_id: "workspace_bob", amount_credits: "1", reason: "Wrong tenant" })
      .expect(404);

    const aliceAfter = await request(app).get("/api/billing/account").set(auth("alice")).expect(200);
    const bobAfter = await request(app).get("/api/billing/account").set(auth("bob")).expect(200);
    expect(aliceAfter.body.account.balance_credits).toBe("1012.5");
    expect(bobAfter.body.account.balance_credits).toBe("1000");
    expect(JSON.stringify(await request(app).get("/api/billing/ledger").set(auth("alice")).then((response) => response.body))).not.toContain("billing_bob");
  });

  it("publishes versioned pricing and keeps a complete admin audit trail", async () => {
    await startApp({ autoRun: false });
    await request(app).get("/api/billing/account").set(auth("alice")).expect(200);
    const current = await request(app).get("/api/admin/billing/pricing").set(auth("admin")).expect(200);
    expect(current.body.pricing).toHaveProperty("created_by", "system");
    expect(app.locals.store.read().billingAccounts.some((account) => account.user_id === "billing_admin")).toBe(false);
    const changed = await request(app)
      .post("/api/admin/billing/pricing")
      .set(auth("admin"))
      .set("Idempotency-Key", "pricing-version-api-0001")
      .send({
        prompt_credits_per_1k: "0.3",
        completion_credits_per_1k: "0.6",
        cached_credits_per_1k: "0.05",
        minimum_reservation_credits: "0.2",
        reason: "New provider contract"
      })
      .expect(201);
    expect(changed.body.pricing.supersedes_version_id).toBe(current.body.pricing.pricing_version_id);
    expect(changed.body.pricing.rules[0]).toMatchObject({
      prompt_credits_per_1k: "0.3",
      completion_credits_per_1k: "0.6",
      cached_credits_per_1k: "0.05"
    });
    const accounts = await request(app).get("/api/admin/billing/accounts").set(auth("admin")).expect(200);
    expect(accounts.body.integrity_valid).toBe(true);
    expect(accounts.body.accounts.find((account) => account.user_id === "billing_alice").balance_credits).toBe("1000");
  });

  it("rejects a request atomically when the balance cannot cover its reservation", async () => {
    await startApp({ autoRun: false });
    await request(app).get("/api/billing/account").set(auth("alice")).expect(200);
    await request(app)
      .post("/api/admin/billing/accounts/billing_alice/adjustments")
      .set(auth("admin"))
      .set("Idempotency-Key", "empty-account-api-0001")
      .send({ amount_credits: "-1000", reason: "Security test: empty account" })
      .expect(201);
    const session = await request(app).post("/api/chat/sessions").set(auth("alice")).send({ title: "No funds" }).expect(201);
    const rejected = await request(app)
      .post(`/api/chat/sessions/${session.body.session_id}/messages`)
      .set(auth("alice"))
      .send({ content: "This request must not be queued." })
      .expect(402);
    expect(rejected.body).toMatchObject({
      error: "insufficient_balance",
      details: { available_micros: 0 }
    });
    expect(rejected.body.details.required_micros).toBeGreaterThan(0);
    const stored = app.locals.store.read();
    expect(stored.runs).toHaveLength(0);
    expect(stored.messages).toHaveLength(0);
    expect(stored.billingReservations).toHaveLength(0);
    expect(verifyBillingState(stored).valid).toBe(true);
  });
});

describe("run charging and transparency", () => {
  it("meters workflow composition as a Router output", async () => {
    await startApp({
      workflowComposer: async (input) => ({
        ...composeWorkflowFallback(input),
        token_accounting: {
          schema_version: "router-token-accounting-v1",
          provider_reported: true,
          complete: true,
          call_count: 1,
          calls: [{ component: "workflow_composition", model: "qwen36-awq", prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200 }],
          totals: { prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200 },
          missing_usage: []
        }
      })
    });
    const session = await request(app).post("/api/chat/sessions").set(auth("alice")).send({ title: "Workflow billing" }).expect(201);
    const queued = await request(app)
      .post(`/api/chat/sessions/${session.body.session_id}/messages`)
      .set(auth("alice"))
      .send({ content: "/workflow prepare a simple research summary" })
      .expect(202);
    const run = await waitForRun(queued.body.run_id, "alice");
    expect(run.status).toBe("completed");
    expect(run.usage_receipt).toMatchObject({ total_tokens: 1200, charged_credits: "0.14" });
    expect(run.usage_receipt.components).toEqual([
      expect.objectContaining({ kind: "router", component: "workflow_composition", total_tokens: 1200 })
    ]);
    expect(run.billing.balance_after_credits).toBe("999.86");
  });

  it("charges only server-reported Runtime calls and returns totals for every agent and output", async () => {
    process.env.TCAR_ENGINE_MODE = "real";
    process.env.TCAR_RUNTIME_API_URL = "http://runtime.internal:9000";
    process.env.TCAR_RUNTIME_API_KEY = "billing-runtime-test-key";
    let runtimeRequests = 0;
    globalThis.fetch = async (url) => {
      expect(String(url)).toContain("/chat/execute");
      runtimeRequests += 1;
      await new Promise((resolve) => setTimeout(resolve, 30));
      return jsonResponse(runtimeExecutionResponse());
    };
    await startApp();
    const session = await request(app).post("/api/chat/sessions").set(auth("alice")).send({ title: "Metered run" }).expect(201);
    const messagePath = `/api/chat/sessions/${session.body.session_id}/messages`;
    const first = request(app)
      .post(messagePath)
      .set(auth("alice"))
      .set("Idempotency-Key", "metered-message-0001")
      .send({
        content: "Prepare a short product launch note.",
        token_accounting: { calls: [{ prompt_tokens: 999_999_999, completion_tokens: 999_999_999 }] }
      });
    const duplicate = request(app)
      .post(messagePath)
      .set(auth("alice"))
      .set("Idempotency-Key", "metered-message-0001")
      .send({
        content: "Prepare a short product launch note.",
        token_accounting: { calls: [{ prompt_tokens: 1, completion_tokens: 1 }] }
      });
    const [queued, replay] = await Promise.all([first, duplicate]);
    expect(queued.status).toBe(202);
    expect(replay.status).toBe(202);
    expect(replay.body.run_id).toBe(queued.body.run_id);

    const run = await waitForRun(queued.body.run_id, "alice");
    expect(runtimeRequests).toBe(1);
    expect(run.status).toBe("completed");
    expect(run.usage_receipt).toMatchObject({
      provider_reported: true,
      complete: true,
      call_count: 4,
      prompt_tokens: 2800,
      completion_tokens: 1050,
      total_tokens: 3850,
      charged_micros: 490000,
      charged_credits: "0.49",
      balance_after_credits: "999.51"
    });
    expect(run.usage_receipt.components.map((component) => ({ kind: component.kind, agent: component.agent_id, tokens: component.total_tokens }))).toEqual([
      { kind: "router", agent: null, tokens: 1100 },
      { kind: "agent", agent: "product_strategy_lora", tokens: 750 },
      { kind: "agent", agent: "writing_synthesis_lora", tokens: 900 },
      { kind: "final_output", agent: null, tokens: 1100 }
    ]);
    expect(run.expert_outputs).toEqual(expect.arrayContaining([
      expect.objectContaining({ adapter: "product_strategy_lora", token_usage: expect.objectContaining({ total_tokens: 750, charged_credits: "0.1", reported: true }) }),
      expect.objectContaining({ adapter: "writing_synthesis_lora", token_usage: expect.objectContaining({ total_tokens: 900, charged_credits: "0.12", reported: true }) })
    ]));
    expect(run.billing).toMatchObject({ status: "settled", charged_credits: "0.49", balance_after_credits: "999.51" });

    const history = await request(app).get(`/api/chat/sessions/${session.body.session_id}`).set(auth("alice")).expect(200);
    const persistedAnswer = history.body.messages.find((message) => message.role === "assistant" && message.run_id === run.run_id);
    expect(persistedAnswer).toMatchObject({
      usage_receipt: expect.objectContaining({ total_tokens: 3850, charged_credits: "0.49" }),
      billing: expect.objectContaining({ status: "settled", balance_after_credits: "999.51" })
    });

    const account = await request(app).get("/api/billing/account").set(auth("alice")).expect(200);
    expect(account.body.account).toMatchObject({ balance_credits: "999.51", reserved_credits: "0", lifetime_debited_credits: "0.49" });
    const ledger = await request(app).get("/api/billing/ledger").set(auth("alice")).expect(200);
    expect(ledger.body.integrity_valid).toBe(true);
    expect(ledger.body.entries.map((entry) => entry.type)).toEqual(["usage_settlement", "usage_reservation", "welcome_grant"]);
    expect(ledger.body.entries[0]).toMatchObject({ debited_micros: 490000, debited_credits: "0.49" });
    expect(app.locals.store.read().billingReservations).toHaveLength(1);
  });

  it("returns the full reservation after a Runtime failure", async () => {
    process.env.TCAR_ENGINE_MODE = "real";
    process.env.TCAR_RUNTIME_API_URL = "http://runtime.internal:9000";
    process.env.TCAR_RUNTIME_API_KEY = "billing-runtime-test-key";
    globalThis.fetch = async () => jsonResponse({ detail: "provider unavailable" }, 503);
    await startApp();
    const session = await request(app).post("/api/chat/sessions").set(auth("alice")).send({ title: "Failed metered run" }).expect(201);
    const queued = await request(app)
      .post(`/api/chat/sessions/${session.body.session_id}/messages`)
      .set(auth("alice"))
      .send({ content: "This call will fail." })
      .expect(202);
    const run = await waitForRun(queued.body.run_id, "alice");
    expect(run.status).toBe("failed");
    expect(run.billing).toMatchObject({ status: "released", charged_credits: "0", balance_after_credits: "1000" });
    const account = await request(app).get("/api/billing/account").set(auth("alice")).expect(200);
    expect(account.body.account).toMatchObject({ balance_credits: "1000", reserved_credits: "0", lifetime_debited_credits: "0" });
    const stored = app.locals.store.read();
    expect(stored.billingReservations[0].status).toBe("released");
    expect(verifyBillingState(stored).valid).toBe(true);
  });

  it("preserves every credit under a burst of concurrent reservations across sessions", async () => {
    process.env.APP_MAX_ACTIVE_RUNS_PER_USER = "100";
    process.env.APP_MAX_ACTIVE_RUNS_PER_WORKSPACE = "100";
    process.env.APP_MAX_ACTIVE_RUNS_GLOBAL = "100";
    // Fund all 30 simultaneous worst-case 32K-context, 16-route reservations.
    process.env.APP_BILLING_WELCOME_CREDITS = "5000";
    await startApp({ autoRun: false });
    const sessions = await Promise.all(Array.from({ length: 30 }, (_, index) => request(app)
      .post("/api/chat/sessions")
      .set(auth("alice"))
      .send({ title: `Reservation stress ${index + 1}` })
      .expect(201)));
    const responses = await Promise.all(sessions.map((session, index) => request(app)
      .post(`/api/chat/sessions/${session.body.session_id}/messages`)
      .set(auth("alice"))
      .set("Idempotency-Key", `stress-message-${String(index + 1).padStart(4, "0")}`)
      .send({ content: `Stress request ${index + 1}` })));
    expect(responses.every((response) => response.status === 202)).toBe(true);
    const stored = app.locals.store.read();
    const account = stored.billingAccounts.find((candidate) => candidate.user_id === "billing_alice");
    const reservations = stored.billingReservations.filter((reservation) => reservation.account_id === account.account_id);
    expect(reservations).toHaveLength(30);
    expect(new Set(reservations.map((reservation) => reservation.run_id)).size).toBe(30);
    expect(account.available_micros + account.reserved_micros).toBe(5_000_000_000);
    expect(account.reserved_micros).toBe(reservations.reduce((sum, reservation) => sum + reservation.authorized_micros, 0));
    expect(verifyBillingState(stored)).toEqual({ valid: true, errors: [] });
  });

  it("returns a clear error and rolls back the message when active-run capacity is reached", async () => {
    process.env.APP_MAX_ACTIVE_RUNS_PER_USER = "1";
    process.env.APP_MAX_ACTIVE_RUNS_PER_WORKSPACE = "4";
    process.env.APP_MAX_ACTIVE_RUNS_GLOBAL = "8";
    await startApp({ autoRun: false });
    const session = await request(app)
      .post("/api/chat/sessions")
      .set(auth("alice"))
      .send({ title: "Capacity guard" })
      .expect(201);
    const secondSession = await request(app)
      .post("/api/chat/sessions")
      .set(auth("alice"))
      .send({ title: "Capacity guard second chat" })
      .expect(201);
    await request(app)
      .post(`/api/chat/sessions/${session.body.session_id}/messages`)
      .set(auth("alice"))
      .send({ content: "First active request" })
      .expect(202);
    const blocked = await request(app)
      .post(`/api/chat/sessions/${secondSession.body.session_id}/messages`)
      .set(auth("alice"))
      .send({ content: "Second active request" })
      .expect(429);
    expect(blocked.body).toMatchObject({ error: "active_run_limit_reached" });
    const stored = app.locals.store.read();
    expect(stored.runs).toHaveLength(1);
    expect(stored.messages.filter((message) => message.session_id === session.body.session_id)).toHaveLength(1);
    expect(stored.billingReservations.filter((reservation) => reservation.status === "active")).toHaveLength(1);
  });
});

async function startApp(options = {}) {
  app = await createApp({
    dbPath: path.join(tmpDir, "db.json"),
    uploadRoot: tmpDir,
    ...options
  });
}

async function waitForRun(runId, identity) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const response = await request(app).get(`/api/chat/runs/${runId}`).set(auth(identity)).expect(200);
    if (["completed", "failed"].includes(response.body.status)) return response.body;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error(`Run ${runId} did not finish.`);
}

function runtimeExecutionResponse() {
  return {
    ok: true,
    mode: "session_controller_vllm_execute",
    baseModel: "qwen36-awq",
    manifestRevision: "1".repeat(64),
    plan: {
      steps: [
        { id: "step_strategy", adapter: "product_strategy_lora", task: "Outline the launch", depends_on: [] },
        { id: "step_writer", adapter: "writing_synthesis_lora", task: "Write the note", depends_on: ["step_strategy"] }
      ],
      adapters: ["product_strategy_lora", "writing_synthesis_lora"],
      edges: [{ source: "step_strategy", target: "step_writer" }],
      routing: { mode: "session", selected: [], reason: "Two matching agents selected." }
    },
    parallel: { workers: 1, batches: [{ batch: 1, steps: ["step_strategy"], width: 1 }, { batch: 2, steps: ["step_writer"], width: 1 }], maxBatchWidth: 1, parallelizable: false },
    expertOutputs: [
      { id: "step_strategy", adapter: "product_strategy_lora", task: "Outline the launch", domain_answer: "Launch outline", text: "DOMAIN_ANSWER: Launch outline", elapsed_sec: 0.1 },
      { id: "step_writer", adapter: "writing_synthesis_lora", task: "Write the note", domain_answer: "Draft note", text: "DOMAIN_ANSWER: Draft note", elapsed_sec: 0.1 }
    ],
    finalAnswer: "A concise product launch note.",
    tokenAccounting: {
      schema_version: "router-token-accounting-v1",
      provider_reported: true,
      complete: true,
      call_count: 4,
      calls: [
        { component: "session_controller_planning", model: "qwen36-awq", prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 },
        { component: "agent:product_strategy_lora:call_1", agent_id: "product_strategy_lora", step_id: "step_strategy", model: "qwen36-awq", prompt_tokens: 500, completion_tokens: 250, total_tokens: 750 },
        { component: "agent:writing_synthesis_lora:call_1", agent_id: "writing_synthesis_lora", step_id: "step_writer", model: "qwen36-awq", prompt_tokens: 600, completion_tokens: 300, total_tokens: 900 },
        { component: "final_synthesis", model: "qwen36-awq", prompt_tokens: 700, completion_tokens: 400, total_tokens: 1100 }
      ],
      totals: { prompt_tokens: 2800, completion_tokens: 1050, total_tokens: 3850 },
      missing_usage: []
    }
  };
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

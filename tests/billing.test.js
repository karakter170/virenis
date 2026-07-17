import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BillingError,
  createAdminAdjustment,
  createPricingVersion,
  ensureBillingAccount,
  formatCredits,
  normalizeTokenAccounting,
  parseCredits,
  recordFundingEvent,
  releaseRunReservation,
  reserveRunCredits,
  settleRunCredits,
  usageForRunStep,
  verifyBillingLedger,
  verifyBillingState
} from "../server/billing.js";
import { JsonStore } from "../server/store.js";
import { recoverStaleContinuationReservations, resumeMcpApprovalConversation } from "../server/workflows.js";

const actor = { user_id: "user_alice", workspace_id: "workspace_alice", role: "user" };
const admin = { user_id: "admin_root", workspace_id: "workspace_admin", role: "admin" };
const BILLING_ENV = [
  "APP_BILLING_WELCOME_CREDITS",
  "APP_BILLING_PROMPT_CREDITS_PER_1K",
  "APP_BILLING_COMPLETION_CREDITS_PER_1K",
  "APP_BILLING_CACHED_CREDITS_PER_1K",
  "APP_BILLING_UNCLASSIFIED_CREDITS_PER_1K",
  "APP_BILLING_MINIMUM_RESERVATION_CREDITS",
  "APP_MAX_ACTIVE_RUNS_PER_USER",
  "APP_MAX_ACTIVE_RUNS_PER_WORKSPACE",
  "APP_MAX_ACTIVE_RUNS_GLOBAL",
  "WORKFLOW_CONTINUATION_CLAIM_TTL_MS",
  "TCAR_RUNTIME_CONTINUATION_TIMEOUT_MS"
];

let previousEnv;
let temporaryDirectories;

beforeEach(() => {
  previousEnv = Object.fromEntries(BILLING_ENV.map((name) => [name, process.env[name]]));
  process.env.APP_BILLING_WELCOME_CREDITS = "1000";
  process.env.APP_BILLING_PROMPT_CREDITS_PER_1K = "0.1";
  process.env.APP_BILLING_COMPLETION_CREDITS_PER_1K = "0.2";
  process.env.APP_BILLING_CACHED_CREDITS_PER_1K = "0.02";
  process.env.APP_BILLING_UNCLASSIFIED_CREDITS_PER_1K = "0.2";
  process.env.APP_BILLING_MINIMUM_RESERVATION_CREDITS = "0.1";
  temporaryDirectories = [];
});

afterEach(async () => {
  for (const [name, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await Promise.all(temporaryDirectories.map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("credit parsing and token normalization", () => {
  it("uses exact microcredits and rejects ambiguous or overflowing amounts", () => {
    expect(parseCredits("12.345678")).toBe(12_345_678);
    expect(formatCredits(-12_345_678)).toBe("-12.345678");
    for (const invalid of ["1e3", "01", ".5", "1.0000001", "Infinity", "-0", "1000000001"]) {
      expect(() => parseCredits(invalid, "Test", { allowNegative: true })).toThrow(BillingError);
    }
  });

  it("never trusts claimed totals or unsafe provider token fields", () => {
    const normalized = normalizeTokenAccounting({
      provider_reported: true,
      complete: true,
      call_count: 4,
      totals: { total_tokens: 999_999 },
      calls: [
        { component: "session_controller_planning", prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
        { component: "bad_negative", prompt_tokens: -1, completion_tokens: 20, total_tokens: 19 },
        { component: "bad_combined", prompt_tokens: 90_000_000, completion_tokens: 20_000_000, total_tokens: 100_000_000 },
        "not-an-object"
      ]
    });
    expect(normalized.calls).toHaveLength(1);
    expect(normalized.totals.total_tokens).toBe(120);
    expect(normalized.complete).toBe(false);
    expect(normalized.anomalies).toEqual(expect.arrayContaining([
      "invalid_tokens:2",
      "token_limit_exceeded:3",
      "invalid_call:4",
      "provider_total_mismatch",
      "provider_call_count_mismatch"
    ]));
  });

  it("marks internally inconsistent provider telemetry as partial while retaining safe usage", () => {
    const normalized = normalizeTokenAccounting({
      provider_reported: true,
      complete: true,
      call_count: 1,
      calls: [{
        component: "final_synthesis",
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 2,
        cached_tokens: 20,
        reasoning_tokens: -1
      }],
      totals: { total_tokens: 2 },
      missing_usage: []
    });
    expect(normalized.calls[0]).toMatchObject({ total_tokens: 15, cached_tokens: 10, reasoning_tokens: 0 });
    expect(normalized.complete).toBe(false);
    expect(normalized.anomalies).toEqual(expect.arrayContaining([
      "call_total_mismatch:1",
      "cached_tokens_exceed_prompt:1",
      "invalid_reasoning_tokens:1",
      "provider_total_mismatch"
    ]));

    const missing = normalizeTokenAccounting({ provider_reported: true, complete: true, calls: [], missing_usage: [] });
    expect(missing.complete).toBe(false);
    expect(missing.anomalies).toContain("provider_calls_missing");
  });
});

describe("immutable balance lifecycle", () => {
  it("reserves, prices each component, settles exactly once, and exposes per-agent usage", () => {
    const data = blankData();
    const account = ensureBillingAccount(data, actor);
    const startingBalance = account.available_micros;
    const run = { run_id: "run_component_usage" };
    const reservation = reserveRunCredits(data, { run, actor, options: { max_routing_adapters: 2, max_tokens: 64 } });
    expect(account.available_micros).toBe(startingBalance - reservation.authorized_micros);
    expect(account.reserved_micros).toBe(reservation.authorized_micros);

    const receipt = settleRunCredits(data, run, tokenAccounting([
      { component: "session_controller_planning", prompt_tokens: 1_000, completion_tokens: 100, total_tokens: 1_100 },
      { component: "agent:research_agent:call_1", agent_id: "research_agent", step_id: "step_research", prompt_tokens: 500, completion_tokens: 250, total_tokens: 750 },
      { component: "agent:writer_agent:call_1", agent_id: "writer_agent", step_id: "step_writer", prompt_tokens: 600, completion_tokens: 300, total_tokens: 900 },
      { component: "final_synthesis", prompt_tokens: 700, completion_tokens: 400, total_tokens: 1_100 }
    ]));

    expect(receipt.total_tokens).toBe(3_850);
    expect(receipt.components.map((component) => component.kind)).toEqual(["router", "agent", "agent", "final_output"]);
    expect(receipt.charged_micros).toBe(490_000);
    expect(account.available_micros).toBe(startingBalance - 490_000);
    expect(account.reserved_micros).toBe(0);
    expect(usageForRunStep(receipt, { step_id: "step_research", adapter: "research_agent" })).toMatchObject({
      calls: 1,
      prompt_tokens: 500,
      completion_tokens: 250,
      total_tokens: 750,
      charged_micros: 100_000,
      reported: true
    });

    const ledgerLength = data.billingLedgerEntries.length;
    const duplicateReceipt = settleRunCredits(data, run, tokenAccounting([
      { component: "final_synthesis", prompt_tokens: 99_000, completion_tokens: 99_000, total_tokens: 198_000 }
    ]));
    expect(duplicateReceipt).toEqual(receipt);
    expect(data.billingLedgerEntries).toHaveLength(ledgerLength);
    expect(verifyBillingState(data)).toEqual({ valid: true, errors: [] });
  });

  it("uses the reservation's pricing version even after an admin changes current rates", () => {
    const data = blankData();
    const run = { run_id: "run_price_snapshot" };
    reserveRunCredits(data, { run, actor, options: { max_routing_adapters: 1, max_tokens: 32 } });
    const reservedVersion = run.billing.pricing_version_id;
    createPricingVersion(data, {
      actor: admin,
      idempotencyKey: "pricing-update-0001",
      body: {
        prompt_credits_per_1k: "9",
        completion_credits_per_1k: "9",
        cached_credits_per_1k: "9",
        minimum_reservation_credits: "9",
        reason: "Future runs only"
      }
    });
    const receipt = settleRunCredits(data, run, tokenAccounting([
      { component: "final_synthesis", prompt_tokens: 1_000, completion_tokens: 1_000, total_tokens: 2_000 }
    ]));
    expect(receipt.pricing_version_id).toBe(reservedVersion);
    expect(receipt.charged_credits).toBe("0.3");
  });

  it("keeps catch-all pricing when an administrator adds a model-specific rate", () => {
    const data = blankData();
    ensureBillingAccount(data, actor);
    const special = createPricingVersion(data, {
      actor: admin,
      idempotencyKey: "pricing-special-model-0001",
      body: {
        model_pattern: "premium-*",
        prompt_credits_per_1k: "1",
        completion_credits_per_1k: "2",
        cached_credits_per_1k: "0.5",
        minimum_reservation_credits: "0.1",
        reason: "Premium provider rate"
      }
    }).pricing;
    expect(special.rules.map((rule) => rule.model_pattern)).toEqual(["*", "premium-*"]);

    const run = { run_id: "run_model_specific_pricing" };
    reserveRunCredits(data, { run, actor, options: { max_routing_adapters: 1, max_tokens: 32 } });
    const receipt = settleRunCredits(data, run, tokenAccounting([
      { component: "session_controller_planning", model: "standard-model", prompt_tokens: 1_000, completion_tokens: 0, total_tokens: 1_000 },
      { component: "final_synthesis", model: "premium-qwen", prompt_tokens: 1_000, completion_tokens: 0, total_tokens: 1_000 }
    ]));
    expect(receipt.charged_credits).toBe("1.1");
    expect(receipt.components.map((component) => component.charged_credits)).toEqual(["0.1", "1"]);
    expect(verifyBillingState(data)).toEqual({ valid: true, errors: [] });
  });

  it("prices cached prompt tokens at the cached rate without double charging them", () => {
    const data = blankData();
    const run = { run_id: "run_cached_usage" };
    reserveRunCredits(data, { run, actor, options: { max_routing_adapters: 1, max_tokens: 32 } });
    const receipt = settleRunCredits(data, run, tokenAccounting([{
      component: "final_synthesis",
      prompt_tokens: 1_000,
      completion_tokens: 0,
      total_tokens: 1_000,
      cached_tokens: 800
    }]));
    expect(receipt).toMatchObject({
      prompt_tokens: 1_000,
      cached_tokens: 800,
      charged_credits: "0.036"
    });
    expect(receipt.components[0]).toMatchObject({ cached_tokens: 800, charged_credits: "0.036" });
    expect(verifyBillingState(data)).toEqual({ valid: true, errors: [] });
  });

  it("charges server-reported overage in full, records a negative balance, and blocks the next run", () => {
    const data = blankData();
    const account = ensureBillingAccount(data, actor);
    const run = { run_id: "run_large_overage" };
    const reservation = reserveRunCredits(data, { run, actor, options: { max_routing_adapters: 1, max_tokens: 16 } });
    const receipt = settleRunCredits(data, run, tokenAccounting([{
      component: "final_synthesis",
      prompt_tokens: 10_000_000,
      completion_tokens: 10_000_000,
      total_tokens: 20_000_000
    }]));
    expect(receipt.charged_credits).toBe("3000");
    expect(receipt.charged_micros).toBeGreaterThan(reservation.authorized_micros);
    expect(account.available_micros).toBe(-2_000_000_000);
    expect(account.reserved_micros).toBe(0);
    expect(() => reserveRunCredits(data, {
      run: { run_id: "run_after_overage" },
      actor,
      options: {}
    })).toThrow(expect.objectContaining({ status: 402, code: "insufficient_balance" }));
    expect(verifyBillingState(data)).toEqual({ valid: true, errors: [] });
  });

  it("releases failed reservations without charging and blocks underfunded requests", () => {
    const data = blankData();
    const account = ensureBillingAccount(data, actor);
    const before = account.available_micros;
    const run = { run_id: "run_failure" };
    reserveRunCredits(data, { run, actor, options: { max_routing_adapters: 1 } });
    releaseRunReservation(data, run, { reason: "provider_unavailable" });
    expect(account.available_micros).toBe(before);
    expect(account.reserved_micros).toBe(0);
    expect(run.billing).toMatchObject({ status: "released", charged_micros: 0 });
    expect(() => releaseRunReservation(data, run)).not.toThrow();

    process.env.APP_BILLING_WELCOME_CREDITS = "0";
    const emptyData = blankData();
    expect(() => reserveRunCredits(emptyData, {
      run: { run_id: "run_without_funds" },
      actor: { user_id: "user_empty", workspace_id: "workspace_empty" },
      options: {}
    })).toThrow(expect.objectContaining({ status: 402, code: "insufficient_balance" }));
  });

  it("atomically bounds active chat runs by user, workspace, and service", () => {
    const data = blankData();
    process.env.APP_MAX_ACTIVE_RUNS_PER_USER = "1";
    process.env.APP_MAX_ACTIVE_RUNS_PER_WORKSPACE = "2";
    process.env.APP_MAX_ACTIVE_RUNS_GLOBAL = "3";
    const first = { run_id: "run_capacity_first" };
    reserveRunCredits(data, { run: first, actor, options: {} });
    expect(() => reserveRunCredits(data, {
      run: { run_id: "run_capacity_same_user" },
      actor,
      options: {}
    })).toThrow(expect.objectContaining({ status: 429, code: "active_run_limit_reached" }));

    process.env.APP_MAX_ACTIVE_RUNS_PER_USER = "10";
    const workspacePeer = { user_id: "user_peer", workspace_id: actor.workspace_id };
    reserveRunCredits(data, { run: { run_id: "run_capacity_peer" }, actor: workspacePeer, options: {} });
    expect(() => reserveRunCredits(data, {
      run: { run_id: "run_capacity_workspace" },
      actor: { user_id: "user_third", workspace_id: actor.workspace_id },
      options: {}
    })).toThrow(expect.objectContaining({ status: 429, code: "active_run_limit_reached" }));

    process.env.APP_MAX_ACTIVE_RUNS_PER_WORKSPACE = "10";
    reserveRunCredits(data, {
      run: { run_id: "run_capacity_other_workspace" },
      actor: { user_id: "user_other", workspace_id: "workspace_other" },
      options: {}
    });
    expect(() => reserveRunCredits(data, {
      run: { run_id: "run_capacity_global" },
      actor: { user_id: "user_global", workspace_id: "workspace_global" },
      options: {}
    })).toThrow(expect.objectContaining({ status: 503, code: "active_run_capacity_reached" }));

    releaseRunReservation(data, first, { reason: "completed_for_capacity_test" });
    expect(() => reserveRunCredits(data, {
      run: { run_id: "run_capacity_after_release" },
      actor,
      options: {}
    })).not.toThrow();
  });

  it("detects ledger, projection, and reservation tampering", () => {
    const data = blankData();
    const run = { run_id: "run_integrity" };
    reserveRunCredits(data, { run, actor, options: {} });
    expect(verifyBillingState(data).valid).toBe(true);
    data.billingLedgerEntries[0].available_after_micros += 1;
    expect(verifyBillingLedger(data).valid).toBe(false);
    expect(verifyBillingState(data).errors).toEqual(expect.arrayContaining([
      expect.stringContaining("entry_hash"),
      expect.stringContaining("running_balance")
    ]));
  });

  it("fails integrity checks for owner substitution and non-integer ledger values", () => {
    const data = blankData();
    ensureBillingAccount(data, actor);
    data.billingLedgerEntries[0].user_id = "user_attacker";
    data.billingLedgerEntries[0].available_delta_micros = "1000000000";
    const integrity = verifyBillingState(data);
    expect(integrity.valid).toBe(false);
    expect(integrity.errors).toEqual(expect.arrayContaining([
      expect.stringContaining("entry_owner"),
      expect.stringContaining("entry_amount")
    ]));
  });

  it("fails integrity checks for tampered pricing and component charges", () => {
    const data = blankData();
    const run = { run_id: "run_pricing_integrity" };
    reserveRunCredits(data, { run, actor, options: {} });
    settleRunCredits(data, run, tokenAccounting([{
      component: "final_synthesis",
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150
    }]));
    data.billingPricingVersions[0].rules[0].prompt_micros_per_1k = "100000";
    data.billingUsageRecords[0].component_costs[0].charged_micros += 1;
    const integrity = verifyBillingState(data);
    expect(integrity.valid).toBe(false);
    expect(integrity.errors).toEqual(expect.arrayContaining([
      expect.stringContaining("pricing_rate"),
      expect.stringContaining("usage_component_charge")
    ]));
  });

  it("refuses new reservations once account deletion has moved an account to closing", () => {
    const data = blankData();
    const account = ensureBillingAccount(data, actor);
    account.status = "closing";
    expect(() => reserveRunCredits(data, {
      run: { run_id: "run_while_closing" },
      actor,
      options: {}
    })).toThrow(expect.objectContaining({ status: 403, code: "billing_account_unavailable" }));
  });

  it("reserves and settles a durable tool continuation without losing its chat receipt", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "virenis-continuation-billing-"));
    temporaryDirectories.push(directory);
    const store = new JsonStore({ dbPath: path.join(directory, "db.json"), seedAgents: [] });
    await store.init();
    await store.mutate((data) => {
      data.sessions.push({
        session_id: "session_continuation",
        workspace_id: actor.workspace_id,
        created_by: actor.user_id,
        shared_memory: [],
        created_at: "2026-07-15T00:00:00.000Z",
        updated_at: "2026-07-15T00:00:00.000Z"
      });
      data.runs.push({
        run_id: "run_tool_source",
        session_id: "session_continuation",
        query: "Use the approved tool.",
        final_answer: "Waiting for approval."
      });
      data.conversationCheckpoints.push({
        checkpoint_id: "checkpoint_continuation",
        type: "mcp_tool_approval",
        approval_id: "approval_continuation",
        status: "pending",
        source_run_id: "run_tool_source",
        session_id: "session_continuation",
        workspace_id: actor.workspace_id,
        created_by: actor.user_id,
        created_at: "2026-07-15T00:00:00.000Z",
        updated_at: "2026-07-15T00:00:00.000Z",
        resume_attempts: 0
      });
    });

    const checkpoint = await resumeMcpApprovalConversation({
      store,
      approval: {
        approval_id: "approval_continuation",
        run_id: "run_tool_source",
        session_id: "session_continuation",
        workspace_id: actor.workspace_id,
        created_by: actor.user_id,
        tool_title: "Read approved data",
        result: { ok: true, value: "approved result" }
      },
      decision: "approve",
      actor,
      continueConversation: async () => ({
        content: "The approved result is now included.",
        token_accounting: tokenAccounting([
          { component: "conversation_continuation", prompt_tokens: 300, completion_tokens: 100, total_tokens: 400 }
        ])
      })
    });
    const snapshot = store.read();
    const message = snapshot.messages.find((candidate) => candidate.message_id === checkpoint.resume_message_id);
    expect(checkpoint.status).toBe("resumed");
    expect(message).toMatchObject({
      kind: "tool_continuation",
      usage_receipt: expect.objectContaining({ total_tokens: 400, charged_credits: "0.05" }),
      billing: expect.objectContaining({ status: "settled", charged_credits: "0.05" })
    });
    expect(message.usage_receipt.components).toEqual([
      expect.objectContaining({ kind: "final_output", component: "conversation_continuation" })
    ]);
    expect(verifyBillingState(snapshot)).toEqual({ valid: true, errors: [] });
    await store.close();
  });

  it("joins a live continuation claim instead of starting duplicate provider work", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "virenis-continuation-claim-"));
    temporaryDirectories.push(directory);
    const store = new JsonStore({ dbPath: path.join(directory, "db.json"), seedAgents: [] });
    await store.init();
    await store.mutate((data) => {
      data.sessions.push({
        session_id: "session_claim",
        workspace_id: actor.workspace_id,
        created_by: actor.user_id,
        shared_memory: [],
        created_at: "2026-07-15T00:00:00.000Z",
        updated_at: "2026-07-15T00:00:00.000Z"
      });
      data.runs.push({
        run_id: "run_claim",
        session_id: "session_claim",
        query: "Continue after approval.",
        final_answer: "Waiting for approval."
      });
      data.conversationCheckpoints.push({
        checkpoint_id: "checkpoint_claim",
        type: "mcp_tool_approval",
        approval_id: "approval_claim",
        status: "pending",
        source_run_id: "run_claim",
        session_id: "session_claim",
        workspace_id: actor.workspace_id,
        created_by: actor.user_id,
        created_at: "2026-07-15T00:00:00.000Z",
        updated_at: "2026-07-15T00:00:00.000Z",
        resume_attempts: 0
      });
    });

    let continuationCalls = 0;
    let releaseContinuation;
    let markStarted;
    const continuationGate = new Promise((resolve) => { releaseContinuation = resolve; });
    const started = new Promise((resolve) => { markStarted = resolve; });
    const options = {
      store,
      approval: {
        approval_id: "approval_claim",
        run_id: "run_claim",
        session_id: "session_claim",
        workspace_id: actor.workspace_id,
        created_by: actor.user_id,
        tool_title: "Approved action",
        result: { ok: true }
      },
      decision: "approve",
      actor,
      continueConversation: async () => {
        continuationCalls += 1;
        markStarted();
        await continuationGate;
        return { content: "Continuation completed once." };
      }
    };

    const first = resumeMcpApprovalConversation(options);
    await started;
    const joined = await resumeMcpApprovalConversation(options);
    expect(joined).toMatchObject({ status: "resuming", resume_attempts: 1 });
    expect(continuationCalls).toBe(1);

    releaseContinuation();
    const completed = await first;
    expect(completed).toMatchObject({ status: "resumed", resume_attempts: 1 });
    expect(continuationCalls).toBe(1);
    expect(store.read().messages.filter((message) => message.checkpoint_id === "checkpoint_claim")).toHaveLength(1);
    await store.close();
  });

  it("releases an interrupted continuation reservation after its claim expires", async () => {
    process.env.WORKFLOW_CONTINUATION_CLAIM_TTL_MS = "1000";
    process.env.TCAR_RUNTIME_CONTINUATION_TIMEOUT_MS = "1000";
    const nowMs = Date.parse("2026-07-15T12:00:00.000Z");
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "virenis-continuation-recovery-"));
    temporaryDirectories.push(directory);
    const store = new JsonStore({ dbPath: path.join(directory, "db.json"), seedAgents: [] });
    await store.init();
    await store.mutate((data) => {
      const billingRun = { run_id: "continuation_stale_reservation" };
      reserveRunCredits(data, { run: billingRun, actor, kind: "conversation_continuation" });
      data.conversationCheckpoints.push({
        checkpoint_id: "checkpoint_stale_continuation",
        type: "mcp_tool_approval",
        status: "resuming",
        workspace_id: actor.workspace_id,
        created_by: actor.user_id,
        resume_claim_id: "claim_from_crashed_worker",
        resume_claimed_at: "2026-07-15T11:00:00.000Z",
        billing_run_id: billingRun.run_id,
        updated_at: "2026-07-15T11:00:00.000Z"
      });
    });

    const recovery = await recoverStaleContinuationReservations({ store, actor, nowMs });
    const snapshot = store.read();
    const account = snapshot.billingAccounts.find((candidate) => candidate.user_id === actor.user_id);
    expect(recovery).toEqual({ recovered: 1, checkpoint_ids: ["checkpoint_stale_continuation"] });
    expect(snapshot.billingReservations[0]).toMatchObject({ status: "released", release_reason: "continuation_claim_expired" });
    expect(snapshot.conversationCheckpoints[0]).toMatchObject({ status: "resume_failed" });
    expect(snapshot.conversationCheckpoints[0]).not.toHaveProperty("resume_claim_id");
    expect(account).toMatchObject({ available_micros: 1_000_000_000, reserved_micros: 0 });
    expect(verifyBillingState(snapshot)).toEqual({ valid: true, errors: [] });
    await store.close();
  });
});

describe("admin and future payment operations", () => {
  it("makes adjustments idempotent and rejects key reuse with changed values", () => {
    const data = blankData();
    const request = {
      actor: admin,
      targetUserId: actor.user_id,
      targetWorkspaceId: actor.workspace_id,
      amountCredits: "25.5",
      reason: "Customer support credit",
      idempotencyKey: "adjustment-ticket-1001"
    };
    const first = createAdminAdjustment(data, request);
    const second = createAdminAdjustment(data, request);
    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(second.account.balance_credits).toBe("1025.5");
    expect(() => createAdminAdjustment(data, { ...request, amountCredits: "30" })).toThrow(expect.objectContaining({
      status: 409,
      code: "billing_idempotency_conflict"
    }));
  });

  it("rejects an administrator debit that would overdraw the account", () => {
    const data = blankData();
    expect(() => createAdminAdjustment(data, {
      actor: admin,
      targetUserId: actor.user_id,
      targetWorkspaceId: actor.workspace_id,
      amountCredits: "-1000.000001",
      reason: "Invalid excessive debit",
      idempotencyKey: "adjustment-overdraw-0001"
    })).toThrow(expect.objectContaining({ status: 409, code: "billing_adjustment_exceeds_balance" }));
    const account = data.billingAccounts.find((candidate) => candidate.user_id === actor.user_id);
    expect(account.available_micros).toBe(1_000_000_000);
    expect(data.billingLedgerEntries).toHaveLength(1);
  });

  it("records provider-neutral funding once and does not credit failed events", () => {
    const data = blankData();
    const succeeded = {
      actor: admin,
      targetUserId: actor.user_id,
      targetWorkspaceId: actor.workspace_id,
      provider: "future_gateway",
      externalReference: "checkout_order_42",
      providerEventId: "event_paid_42",
      status: "succeeded",
      amountCredits: "50",
      idempotencyKey: "funding-event-paid-0042"
    };
    const first = recordFundingEvent(data, succeeded);
    const replay = recordFundingEvent(data, succeeded);
    expect(first.duplicate).toBe(false);
    expect(replay.duplicate).toBe(true);
    expect(first.account.balance_credits).toBe("1050");

    const failed = recordFundingEvent(data, {
      ...succeeded,
      externalReference: "checkout_order_43",
      providerEventId: "event_failed_43",
      status: "failed",
      amountCredits: "75",
      idempotencyKey: "funding-event-failed-0043"
    });
    expect(failed.account.balance_credits).toBe("1050");
    expect(failed.event.ledger_entry_id).toBeNull();
    expect(() => recordFundingEvent(data, { ...succeeded, amountCredits: "51" })).toThrow(expect.objectContaining({
      status: 409,
      code: "billing_provider_event_conflict"
    }));
  });

  it("rejects overlong or ambiguous funding identifiers instead of truncating them", () => {
    const data = blankData();
    const request = {
      actor: admin,
      targetUserId: actor.user_id,
      targetWorkspaceId: actor.workspace_id,
      provider: "future_gateway",
      externalReference: "checkout_identifier_test",
      status: "succeeded",
      amountCredits: "5",
      idempotencyKey: "funding-identifier-test-0001"
    };
    expect(() => recordFundingEvent(data, {
      ...request,
      providerEventId: `event_${"x".repeat(200)}`
    })).toThrow(expect.objectContaining({ code: "billing_identifier_invalid", status: 400 }));
    expect(() => recordFundingEvent(data, {
      ...request,
      providerEventId: "event_safe\0suffix"
    })).toThrow(expect.objectContaining({ code: "billing_identifier_invalid", status: 400 }));
    expect(data.billingFundingEvents).toHaveLength(0);
    expect(data.billingLedgerEntries).toHaveLength(0);
    expect(data.billingAccounts).toHaveLength(0);
  });

  it("serializes a burst of adjustments without lost updates", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "virenis-billing-stress-"));
    temporaryDirectories.push(directory);
    const store = new JsonStore({ dbPath: path.join(directory, "db.json"), seedAgents: [] });
    await store.init();
    await Promise.all(Array.from({ length: 100 }, (_, index) => store.mutate((data) => createAdminAdjustment(data, {
      actor: admin,
      targetUserId: actor.user_id,
      targetWorkspaceId: actor.workspace_id,
      amountCredits: "1",
      reason: `Concurrent adjustment ${index + 1}`,
      idempotencyKey: `concurrent-adjustment-${String(index + 1).padStart(4, "0")}`
    }))));
    const snapshot = store.read();
    const account = snapshot.billingAccounts.find((candidate) => candidate.user_id === actor.user_id);
    expect(formatCredits(account.available_micros)).toBe("1100");
    expect(snapshot.billingLedgerEntries).toHaveLength(101);
    expect(verifyBillingState(snapshot)).toEqual({ valid: true, errors: [] });
    await store.close();
  });
});

function blankData() {
  return {
    billingAccounts: [],
    billingPricingVersions: [],
    billingLedgerEntries: [],
    billingReservations: [],
    billingUsageRecords: [],
    billingFundingEvents: []
  };
}

function tokenAccounting(calls) {
  return {
    schema_version: "router-token-accounting-v1",
    provider_reported: true,
    complete: true,
    call_count: calls.length,
    calls,
    totals: calls.reduce((totals, call) => ({
      prompt_tokens: totals.prompt_tokens + call.prompt_tokens,
      completion_tokens: totals.completion_tokens + call.completion_tokens,
      total_tokens: totals.total_tokens + call.total_tokens
    }), { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }),
    missing_usage: []
  };
}

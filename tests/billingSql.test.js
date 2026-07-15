import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ensureBillingAccount,
  recordFundingEvent,
  reserveRunCredits,
  settleRunCredits,
  verifyBillingState
} from "../server/billing.js";
import { normalizedBillingAvailable, syncNormalizedBilling } from "../server/normalizedBilling.js";

const SQL_PATH = path.resolve("../../deploy/sql/billing.sql");

describe("normalized billing migration", () => {
  it("defines tenant RLS, immutable facts, lifecycle guards, and payment-neutral events", async () => {
    const sql = await fs.readFile(SQL_PATH, "utf8");
    for (const table of ["accounts", "pricing_versions", "ledger_entries", "reservations", "usage_records", "funding_events"]) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS tcar_billing.${table}`);
      expect(sql).toContain(`'${table}'`);
    }
    expect(sql).toContain("ALTER TABLE tcar_billing.%I FORCE ROW LEVEL SECURITY");
    expect(sql).toContain("workspace_id = tcar_billing.current_workspace_id()");
    expect(sql).toContain("trigger_name := immutable_table || '_immutable_guard'");
    expect(sql).toContain("'pricing_versions',");
    expect(sql).toContain("'ledger_entries',");
    expect(sql).toContain("'usage_records',");
    expect(sql).toContain("'funding_events'");
    expect(sql).toContain("guard_account_update");
    expect(sql).toContain("guard_reservation_update");
    expect(sql).toContain("subject_digest bytea NOT NULL");
    expect(sql).not.toMatch(/\buser_id\s+text/i);
    expect(sql).not.toMatch(/client_secret|bearer_token|access_token/i);
    expect(sql.trim()).toMatch(/^BEGIN;[\s\S]*COMMIT;$/);
  });

  it("fails closed unless every table, RLS policy, and trigger is present", async () => {
    const healthy = {
      query: async () => ({ rows: [{ tables: 6, forced_rls: 6, policies: 6, triggers: 8 }] })
    };
    expect(await normalizedBillingAvailable(healthy)).toBe(true);
    for (const patch of [
      { tables: 5 },
      { forced_rls: 5 },
      { policies: 5 },
      { triggers: 7 }
    ]) {
      const incomplete = {
        query: async () => ({ rows: [{ tables: 6, forced_rls: 6, policies: 6, triggers: 8, ...patch }] })
      };
      expect(await normalizedBillingAvailable(incomplete)).toBe(false);
    }
  });

  it("projects a settled run and funding event without raw user identities", async () => {
    const previousWelcome = process.env.APP_BILLING_WELCOME_CREDITS;
    process.env.APP_BILLING_WELCOME_CREDITS = "1000";
    try {
      const actor = { user_id: "private_user_identifier", workspace_id: "workspace_projection" };
      const admin = { user_id: "private_admin_identifier", workspace_id: "workspace_admin" };
      const data = blankData();
      ensureBillingAccount(data, actor);
      const run = { run_id: "run_projection" };
      reserveRunCredits(data, { run, actor, options: { max_routing_adapters: 1, max_tokens: 32 } });
      settleRunCredits(data, run, {
        provider_reported: true,
        complete: true,
        call_count: 1,
        calls: [{ component: "final_synthesis", prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }],
        totals: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
        missing_usage: []
      });
      recordFundingEvent(data, {
        actor: admin,
        targetUserId: actor.user_id,
        targetWorkspaceId: actor.workspace_id,
        provider: "future_gateway",
        externalReference: "checkout_projection",
        providerEventId: "event_projection",
        status: "succeeded",
        amountCredits: "5",
        idempotencyKey: "funding-projection-0001"
      });
      expect(verifyBillingState(data).valid).toBe(true);

      const client = projectionClient(data);
      await syncNormalizedBilling(client, data);
      const sql = client.calls.map((call) => call.sql).join("\n");
      expect(sql).toContain("INSERT INTO tcar_billing.accounts");
      expect(sql).toContain("INSERT INTO tcar_billing.pricing_versions");
      expect(sql).toContain("INSERT INTO tcar_billing.ledger_entries");
      expect(sql).toContain("INSERT INTO tcar_billing.reservations");
      expect(sql).toContain("INSERT INTO tcar_billing.usage_records");
      expect(sql).toContain("INSERT INTO tcar_billing.funding_events");
      const parameterText = client.calls.flatMap((call) => call.params || []).map((value) => (
        Buffer.isBuffer(value) ? value.toString("hex") : String(value)
      )).join("\n");
      expect(parameterText).not.toContain(actor.user_id);
      expect(parameterText).not.toContain(admin.user_id);
    } finally {
      if (previousWelcome === undefined) delete process.env.APP_BILLING_WELCOME_CREDITS;
      else process.env.APP_BILLING_WELCOME_CREDITS = previousWelcome;
    }
  });
});

function projectionClient() {
  const calls = [];
  const rows = new Map();
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql, params });
      const insertion = sql.match(/INSERT\s+INTO\s+tcar_billing\.([a-z_]+)\s*\(([\s\S]*?)\)\s*VALUES/i);
      if (insertion) {
        const [, table, columnText] = insertion;
        const columns = columnText.split(",").map((column) => column.trim());
        const row = Object.fromEntries(columns.map((column, index) => [column, params[index]]));
        for (const jsonColumn of ["rules", "metadata", "pricing_snapshot", "estimated_token_ceiling", "token_accounting", "component_costs"]) {
          if (typeof row[jsonColumn] === "string") row[jsonColumn] = JSON.parse(row[jsonColumn]);
        }
        const keyColumn = {
          accounts: "account_id",
          pricing_versions: "pricing_version_id",
          ledger_entries: "entry_id",
          reservations: "reservation_id",
          usage_records: "usage_record_id",
          funding_events: "funding_event_id"
        }[table];
        rows.set(`${table}:${row.workspace_id}:${row[keyColumn]}`, row);
        return { rowCount: 1, rows: [row] };
      }
      if (!/^\s*SELECT\s+/i.test(sql) || /set_config/i.test(sql)) return { rowCount: 1, rows: [{}] };
      const table = sql.match(/FROM\s+tcar_billing\.([a-z_]+)/i)?.[1];
      const source = rows.get(`${table}:${params[0]}:${params[1]}`);
      if (!source) return { rowCount: 0, rows: [] };
      const columns = sql.match(/^\s*SELECT\s+([\s\S]*?)\s+FROM/i)?.[1]
        .split(",")
        .map((column) => column.replaceAll('"', "").trim()) || [];
      const row = Object.fromEntries(columns.map((column) => [column, source[column]]));
      return { rowCount: 1, rows: [row] };
    }
  };
}

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

import { describe, expect, it } from "vitest";

import {
  assertNormalizedBillingWorkspacePrivacy,
  minimizedComponentCosts,
  minimizedPricingRules,
  minimizedTokenAccounting,
  normalizedBillingContentReceipt,
  normalizedBillingPseudonym,
  syncNormalizedBilling
} from "../server/normalizedBilling.js";

describe("normalized billing privacy projection", () => {
  it("uses stable workspace-scoped pseudonyms for durable and provider identifiers", () => {
    const first = normalizedBillingPseudonym("external_reference", "workspace_one", "checkout_private_123");
    expect(first).toMatch(/^external_reference_sha256_[a-f0-9]{64}$/);
    expect(first).not.toContain("checkout_private");
    expect(normalizedBillingPseudonym("external_reference", "workspace_one", "checkout_private_123")).toBe(first);
    expect(normalizedBillingPseudonym("external_reference", "workspace_two", "checkout_private_123")).not.toBe(first);
  });

  it("turns free-form metadata into a content-free digest receipt", () => {
    const privatePayload = {
      email: "private@example.com",
      reference: "customer-order-123"
    };
    const receipt = normalizedBillingContentReceipt("ledger metadata", privatePayload, "workspace_one");
    expect(receipt).toEqual({
      schema_version: "virenis-billing-minimized-v1",
      kind: "ledger_metadata",
      content_digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      redacted: true
    });
    expect(JSON.stringify(receipt)).not.toMatch(/private@example|customer-order/);
    expect(normalizedBillingContentReceipt("ledger metadata", privatePayload, "workspace_two").content_digest)
      .not.toBe(receipt.content_digest);
  });

  it("preserves accounting totals while digesting model, agent, step, and rule labels", () => {
    const workspaceId = "workspace_private";
    const rules = minimizedPricingRules(workspaceId, [{
      model_pattern: "private-customer-model",
      prompt_micros_per_1k: 12,
      completion_micros_per_1k: 34
    }]);
    const accounting = minimizedTokenAccounting(workspaceId, {
      provider_reported: true,
      complete: true,
      call_count: 1,
      calls: [{ model: "private-customer-model", prompt_tokens: 8 }],
      totals: { prompt_tokens: 8, completion_tokens: 5, total_tokens: 13 }
    });
    const costs = minimizedComponentCosts(workspaceId, [{
      kind: "agent",
      component: "customer-name-agent",
      model: "private-customer-model",
      agent_id: "customer-name-agent",
      step_id: "medical-record-step",
      calls: 1,
      prompt_tokens: 8,
      completion_tokens: 5,
      total_tokens: 13,
      charged_micros: 42
    }]);
    const serialized = JSON.stringify({ rules, accounting, costs });

    expect(rules[0]).toMatchObject({
      schema_version: "virenis-billing-minimized-v1",
      model_pattern_digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      prompt_micros_per_1k: 12,
      completion_micros_per_1k: 34
    });
    expect(accounting).toMatchObject({
      call_count: 1,
      totals: { prompt_tokens: 8, completion_tokens: 5, total_tokens: 13 }
    });
    expect(accounting).not.toHaveProperty("calls");
    expect(costs[0]).toMatchObject({
      component_digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      model_digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      agent_digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      step_digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      charged_micros: 42
    });
    expect(serialized).not.toMatch(/private-customer-model|customer-name-agent|medical-record-step/);
  });

  it("checks every legacy content class for the active billing workspace", async () => {
    const calls = [];
    const client = {
      async query(sql, params) {
        calls.push({ sql, params });
        return { rowCount: 0, rows: [] };
      }
    };

    await assertNormalizedBillingWorkspacePrivacy(client, "workspace_private");

    expect(calls).toHaveLength(1);
    expect(calls[0].params).toEqual(["workspace_private"]);
    expect(calls[0].sql).toContain("external_reference_sha256_");
    expect(calls[0].sql).toContain("model_pattern_digest");
    expect(calls[0].sql).toContain("estimated_token_ceiling");
    expect(calls[0].sql).toContain("component_digest");
    expect(calls[0].sql).toContain("virenis-billing-minimized-v1");
    expect(calls[0].sql).toContain("~ '^(0|[1-9][0-9]*)$'");
  });

  it("fails before every insert when any active workspace has legacy billing rows", async () => {
    const calls = [];
    const client = {
      async query(sql, params = []) {
        calls.push({ sql, params });
        if (sql.includes("set_config('tcar.workspace_id'")) {
          return { rowCount: 1, rows: [{ set_config: params[0] }] };
        }
        if (sql.includes("SELECT category")) {
          return params[0] === "workspace_two"
            ? { rowCount: 1, rows: [{ category: "external_identifier" }] }
            : { rowCount: 0, rows: [] };
        }
        throw new Error(`Unexpected query before privacy gate completed: ${sql}`);
      }
    };

    await expect(syncNormalizedBilling(client, {
      users: [
        { workspace_id: "workspace_one", status: "active" },
        { workspace_id: "workspace_two", status: "active" }
      ]
    })).rejects.toMatchObject({
      code: "NORMALIZED_BILLING_LEGACY_PRIVACY_MIGRATION_REQUIRED",
      message: expect.stringContaining("shadow-table rebuild")
    });

    expect(calls.some(({ sql }) => /\bINSERT\s+INTO\b/i.test(sql))).toBe(false);
    expect(calls.at(-1).params[0]).toBe("workspace_two");
  });
});

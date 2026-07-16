import { describe, expect, it } from "vitest";

import {
  assertNormalizedLedgerWorkspacePrivacy,
  findWorkspaceAgent,
  normalizedLedgerActorId,
  normalizedLedgerContentReceipt,
  normalizedLedgerLabel,
  syncNormalizedLedger
} from "../server/normalizedLedger.js";

describe("normalized ledger privacy projection", () => {
  it("uses stable workspace-scoped pseudonyms instead of human actor ids", () => {
    const first = normalizedLedgerActorId("workspace_one", "meteye@example.com");
    expect(first).toMatch(/^actor_sha256_[a-f0-9]{64}$/);
    expect(first).not.toContain("meteye");
    expect(normalizedLedgerActorId("workspace_one", "meteye@example.com")).toBe(first);
    expect(normalizedLedgerActorId("workspace_two", "meteye@example.com")).not.toBe(first);
    expect(normalizedLedgerActorId("workspace_one", "system")).toBe("system");
  });

  it("turns arbitrary nested payloads into content-free digest receipts", () => {
    const sensitive = {
      customer_email: "private@example.com",
      complaint: "My medical parcel arrived damaged",
      nested: { account: "customer-123" }
    };
    const receipt = normalizedLedgerContentReceipt("handoff payload", sensitive);
    expect(receipt).toEqual({
      schema_version: "virenis-ledger-content-free-v1",
      kind: "handoff_payload",
      content_digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      redacted: true
    });
    expect(JSON.stringify(receipt)).not.toMatch(/private@example|medical parcel|customer-123/);
    expect(normalizedLedgerContentReceipt("handoff payload", { ...sensitive, complaint: "changed" }))
      .not.toEqual(receipt);
  });

  it("pseudonymizes title-derived durable labels", () => {
    const agent = normalizedLedgerLabel("agent", "Jane Doe medical records_lora");
    const chunk = normalizedLedgerLabel("chunk", "Jane_Doe_medical_records_0001");
    expect(agent).toMatch(/^agent_sha256_[a-f0-9]{64}$/);
    expect(chunk).toMatch(/^chunk_sha256_[a-f0-9]{64}$/);
    expect(`${agent} ${chunk}`).not.toMatch(/Jane|medical|records/i);
  });

  it("never lets an unscoped legacy user agent enter another workspace's projection", () => {
    const exact = { id: "shared_id", workspace_id: "workspace_one", created_by: "alice" };
    const legacy = { id: "legacy_id", created_by: "legacy_user", visibility: "private" };
    const catalog = { id: "catalog_id", system_managed: true, visibility: "global" };
    const data = { agents: [exact, legacy, catalog] };

    expect(findWorkspaceAgent(data, "shared_id", "workspace_one")).toBe(exact);
    expect(findWorkspaceAgent(data, "shared_id", "workspace_two")).toBeUndefined();
    expect(findWorkspaceAgent(data, "legacy_id", "workspace_two")).toBeUndefined();
    expect(findWorkspaceAgent(data, "catalog_id", "workspace_two")).toBe(catalog);
  });

  it("checks all legacy content classes for the active workspace", async () => {
    const calls = [];
    const client = {
      async query(sql, params) {
        calls.push({ sql, params });
        return { rowCount: 0, rows: [] };
      }
    };

    await assertNormalizedLedgerWorkspacePrivacy(client, "workspace_private");

    expect(calls).toHaveLength(1);
    expect(calls[0].params[0]).toBe("workspace_private");
    expect(calls[0].sql).toContain("tcar_ledger.agent_revisions");
    expect(calls[0].sql).toContain("actor_sha256_");
    expect(calls[0].sql).toContain("source_sha256_");
    expect(calls[0].sql).toContain("chunk_sha256_");
    expect(calls[0].sql).toContain("artifact_sha256_");
    expect(calls[0].sql).toContain("key_sha256_");
    expect(calls[0].sql).toContain("virenis-ledger-content-free-v1");
    expect(calls[0].sql).toContain("Private workspace");
    expect(calls[0].sql).toContain("inline_payload IS NOT NULL");
  });

  it("fails before every insert when a later active workspace has legacy rows", async () => {
    const calls = [];
    const client = {
      async query(sql, params = []) {
        calls.push({ sql, params });
        if (sql.includes("set_config('tcar.workspace_id'")) {
          return { rowCount: 1, rows: [{ set_config: params[0] }] };
        }
        if (sql.includes("SELECT category")) {
          return params[0] === "workspace_two"
            ? { rowCount: 1, rows: [{ category: "raw_json_content" }] }
            : { rowCount: 0, rows: [] };
        }
        throw new Error(`Unexpected query before privacy gate completed: ${sql}`);
      }
    };

    await expect(syncNormalizedLedger(client, {
      executionRecords: [
        { workspace_id: "workspace_one" },
        { workspace_id: "workspace_two" }
      ]
    })).rejects.toMatchObject({
      code: "NORMALIZED_LEDGER_LEGACY_PRIVACY_MIGRATION_REQUIRED",
      message: expect.stringContaining("approved legacy-ledger privacy migration")
    });

    expect(calls.some(({ sql }) => /\bINSERT\s+INTO\b/i.test(sql))).toBe(false);
    expect(calls.at(-1).params[0]).toBe("workspace_two");
  });
});

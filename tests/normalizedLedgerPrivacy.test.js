import fs from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  assertNormalizedLedgerWorkspacePrivacy,
  findWorkspaceAgent,
  normalizedLedgerAvailable,
  normalizedLedgerActorId,
  normalizedLedgerContentReceipt,
  normalizedLedgerLabel,
  syncNormalizedLedger
} from "../server/normalizedLedger.js";

const SQL_PATH = path.resolve("../../deploy/sql/provenance_outcomes.sql");

describe("normalized ledger privacy projection", () => {
  it("recreates exact tenant policies and rejects policy or trigger drift", async () => {
    const sql = await fs.readFile(SQL_PATH, "utf8");
    expect(sql).toContain("DROP POLICY IF EXISTS %I ON tcar_ledger.%I");
    expect(sql).toContain("AS PERMISSIVE FOR ALL TO PUBLIC");

    const healthyStatus = {
      tables: 19,
      forced_rls: 19,
      policies: 19,
      policy_total: 19,
      projection_columns: 1,
      triggers: 28,
      trigger_total: 28
    };
    const healthy = {
      query: async (query) => {
        expect(query).toContain("permissive='PERMISSIVE'");
        expect(query).toContain("roles=ARRAY['public']::name[]");
        expect(query).toContain("trigger.tgtype=expected.trigger_type");
        expect(query).toContain("procedure_namespace.nspname='tcar_ledger'");
        return { rows: [healthyStatus] };
      }
    };
    expect(await normalizedLedgerAvailable(healthy)).toBe(true);
    for (const patch of [
      { tables: 18 },
      { forced_rls: 18 },
      { policies: 18 },
      { policy_total: 20 },
      { projection_columns: 0 },
      { triggers: 27 },
      { trigger_total: 29 }
    ]) {
      expect(await normalizedLedgerAvailable({
        query: async () => ({ rows: [{ ...healthyStatus, ...patch }] })
      })).toBe(false);
    }
  });

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
    const agent = normalizedLedgerLabel("agent", "workspace_one", "Jane Doe medical records_lora");
    const chunk = normalizedLedgerLabel("chunk", "workspace_one", "Jane_Doe_medical_records_0001");
    expect(agent).toMatch(/^agent_ws2_sha256_[a-f0-9]{64}$/);
    expect(chunk).toMatch(/^chunk_ws2_sha256_[a-f0-9]{64}$/);
    expect(`${agent} ${chunk}`).not.toMatch(/Jane|medical|records/i);
    expect(normalizedLedgerLabel("agent", "workspace_two", "Jane Doe medical records_lora")).not.toBe(agent);
    expect(() => normalizedLedgerLabel("agent", "Jane Doe medical records_lora")).toThrow(/workspace scope/i);
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
    expect(calls[0].sql).toContain("source_ws2_sha256_");
    expect(calls[0].sql).toContain("chunk_ws2_sha256_");
    expect(calls[0].sql).toContain("artifact_ws2_sha256_");
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

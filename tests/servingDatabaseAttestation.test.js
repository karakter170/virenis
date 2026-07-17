import { describe, expect, it, vi } from "vitest";

import { attestServingDatabase } from "../server/servingDatabaseAttestation.js";

function successfulClient() {
  const queries = [];
  const client = {
    queries,
    async query(value) {
      const text = typeof value === "string" ? value : String(value?.text || "");
      queries.push(text);
      if (text.includes("FROM pg_roles")) {
        return {
          rows: [{
            rolsuper: false,
            rolbypassrls: false,
            rolcreatedb: false,
            rolcreaterole: false,
            rolreplication: false,
            rolcanlogin: true
          }]
        };
      }
      if (text.includes("FROM pg_database")) {
        return { rows: [{ owned: false, can_create: false }] };
      }
      if (text.includes("expected_schemas")) {
        return {
          rows: ["public", "tcar_ledger", "tcar_billing"].map((name) => ({
            name,
            present: true,
            can_use: true,
            can_create: false,
            owned: false
          }))
        };
      }
      if (text.includes("expected_relations")) {
        return {
          rows: Array.from({ length: 26 }, (_, index) => ({
            schema_name: index === 0 ? "public" : index < 20 ? "tcar_ledger" : "tcar_billing",
            table_name: `table_${index}`,
            present: true,
            owned: false,
            can_select: true,
            can_insert: true,
            can_update: true,
            can_delete: false,
            can_truncate: false,
            can_reference: false,
            can_trigger: false
          }))
        };
      }
      if (text.includes("SELECT 1 AS present")) return { rowCount: 1, rows: [{ present: 1 }] };
      if (text.startsWith("UPDATE")) return { rowCount: 1, rows: [] };
      if (text.startsWith("INSERT")) return { rowCount: 1, rows: [] };
      return { rowCount: 0, rows: [] };
    }
  };
  return client;
}

describe("serving database attestation", () => {
  it("validates least privilege, schema contracts, and rolls back its write probe", async () => {
    const client = successfulClient();
    const ledgerAttestor = vi.fn().mockResolvedValue(true);
    const billingAttestor = vi.fn().mockResolvedValue(true);

    await expect(attestServingDatabase(client, {
      tableName: "tcar_app_store",
      storeKey: "production",
      ledgerAttestor,
      billingAttestor
    })).resolves.toMatchObject({
      ok: true,
      required_relations: 26,
      rolled_back_read_write_probe: true
    });
    expect(ledgerAttestor).toHaveBeenCalledWith(client);
    expect(billingAttestor).toHaveBeenCalledWith(client);
    expect(client.queries.at(-1)).toBe("ROLLBACK");
    expect(client.queries.some((query) => /CREATE\s+(TABLE|SCHEMA)|DROP\s+|TRUNCATE\s+|DELETE\s+FROM/i.test(query))).toBe(false);
  });

  it("fails closed on excess serving-role privileges before any write probe", async () => {
    const client = successfulClient();
    const original = client.query;
    client.query = async (value, parameters) => {
      const result = await original.call(client, value, parameters);
      const text = typeof value === "string" ? value : String(value?.text || "");
      if (text.includes("FROM pg_database")) result.rows[0].can_create = true;
      return result;
    };

    await expect(attestServingDatabase(client, {
      ledgerAttestor: vi.fn(),
      billingAttestor: vi.fn()
    })).rejects.toThrow(/must not own the database or hold database CREATE/);
    expect(client.queries).not.toContain("BEGIN");
  });

  it("rolls back when the transactional write contract fails", async () => {
    const client = successfulClient();
    const original = client.query;
    client.query = async (value, parameters) => {
      const text = typeof value === "string" ? value : String(value?.text || "");
      if (text.startsWith("INSERT")) {
        client.queries.push(text);
        throw new Error("permission denied");
      }
      return original.call(client, value, parameters);
    };

    await expect(attestServingDatabase(client, {
      ledgerAttestor: vi.fn().mockResolvedValue(true),
      billingAttestor: vi.fn().mockResolvedValue(true)
    })).rejects.toThrow("permission denied");
    expect(client.queries.at(-1)).toBe("ROLLBACK");
  });
});

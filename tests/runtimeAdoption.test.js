import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import request from "supertest";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../server/app.js";
import { setRuntimeFetchForTests } from "../server/runtimeClient.js";

const resetRuntimeFetchTransport = setRuntimeFetchForTests((...args) => globalThis.fetch(...args));

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value === undefined ? null : value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])])
  );
}

function runtimeDigest(value) {
  return crypto.createHash("sha256")
    .update("json\0", "utf8")
    .update(JSON.stringify(canonicalValue(value)), "utf8")
    .digest("hex");
}

function lifecycleReceipt({
  agentId,
  receiptId,
  sequence,
  previousHash,
  eventType = "agent.registered",
  agentRevision,
  adapterDigest,
  manifestContractDigest,
  enabled = true,
  mounted = true
}) {
  const payload = {
    adapter_content_digest: adapterDigest,
    agent_revision: agentRevision,
    enabled,
    lifecycle_status: enabled ? "active" : "archived",
    manifest_contract_digest: manifestContractDigest,
    mounted
  };
  const receipt = {
    receipt_id: receiptId,
    schema_version: 1,
    subject_type: "agent",
    subject_id: agentId,
    subject_sequence: sequence,
    event_type: eventType,
    event_id: `event_${receiptId}`,
    execution_id: null,
    created_at: `2026-07-10T12:00:${String(sequence).padStart(2, "0")}.000Z`,
    previous_hash: previousHash,
    payload,
    payload_sha256: runtimeDigest(payload)
  };
  receipt.receipt_hash = runtimeDigest({
    created_at: receipt.created_at,
    event_id: receipt.event_id,
    event_type: receipt.event_type,
    execution_id: receipt.execution_id,
    payload_sha256: receipt.payload_sha256,
    previous_hash: receipt.previous_hash,
    receipt_id: receipt.receipt_id,
    schema_version: receipt.schema_version,
    subject_id: receipt.subject_id,
    subject_sequence: receipt.subject_sequence,
    subject_type: receipt.subject_type
  });
  return receipt;
}

afterAll(() => resetRuntimeFetchTransport());

describe("runtime-only agent adoption", () => {
  let app;
  let tmpDir;
  let previousEnv;
  let previousFetch;
  let runtimeAgent;
  let baseLibraryAgent;
  let agentReceipts;

  beforeEach(async () => {
    previousFetch = globalThis.fetch;
    previousEnv = Object.fromEntries([
      "APP_API_TOKENS_JSON",
      "AGENT_RUNTIME_MODE",
      "AGENT_RUNTIME_API_URL",
      "AGENT_RUNTIME_API_KEY",
      "WEB_STORE_DRIVER"
    ].map((name) => [name, process.env[name]]));
    process.env.WEB_STORE_DRIVER = "json";
    process.env.AGENT_RUNTIME_MODE = "real";
    process.env.AGENT_RUNTIME_API_URL = "http://gpu-runtime.internal:9000";
    process.env.AGENT_RUNTIME_API_KEY = "runtime-adoption-test-secret";
    process.env.APP_API_TOKENS_JSON = JSON.stringify({
      admin_adoption_token: { user_id: "admin", workspace_id: "workspace_a", role: "admin" },
      alice_adoption_token: { user_id: "alice", workspace_id: "workspace_a", role: "user" },
      bob_adoption_token: { user_id: "bob", workspace_id: "workspace_a", role: "user" }
    });
    runtimeAgent = {
      id: "external_audit_lora",
      title: "External audit",
      capability: "Reviews an externally managed audit contract.",
      boundary: "Use only approved evidence.",
      consumes: ["user_request"],
      produces: ["audit_findings"],
      routing_cues: ["external audit"],
      resources: [],
      tools: [],
      sources: [],
      stage: 30,
      adapter_path: "/srv/virenis/adapters/external_audit_lora",
      agent_revision: "a".repeat(64),
      revision_authority: "runtime",
      adapter_content_digest: "b".repeat(64),
      manifest_contract_digest: "c".repeat(64),
      enabled: true,
      mounted: true,
      mount_pending: false,
      lifecycle_status: "active"
    };
    baseLibraryAgent = {
      id: "finance_reasoning_lora",
      title: "Finance analysis and quantitative decision support",
      capability: "Provides globally available finance reasoning.",
      boundary: "Educational finance analysis only.",
      consumes: ["user_request"],
      produces: ["financial_analysis"],
      routing_cues: ["finance", "npv"],
      resources: ["poc_validated_evaluation"],
      tools: ["finance_calculator"],
      sources: [],
      stage: 20,
      library_tier: "base",
      library_origin: "tcar_base_lora_library",
      base_lora: true,
      system_managed: true,
      visibility: "global",
      workspace_id: null,
      created_by: "tcar-system",
      web_access: "all_users",
      agent_revision: "1".repeat(64),
      revision_authority: "runtime",
      adapter_content_digest: "2".repeat(64),
      manifest_contract_digest: "3".repeat(64),
      enabled: true,
      mounted: true,
      mount_pending: false,
      lifecycle_status: "active"
    };
    agentReceipts = [lifecycleReceipt({
      agentId: runtimeAgent.id,
      receiptId: "receipt_external_registered",
      sequence: 1,
      previousHash: "0".repeat(64),
      agentRevision: runtimeAgent.agent_revision,
      adapterDigest: runtimeAgent.adapter_content_digest,
      manifestContractDigest: runtimeAgent.manifest_contract_digest
    })];
    globalThis.fetch = async (url, options = {}) => {
      expect(options.headers["X-TCAR-API-Key"]).toBe("runtime-adoption-test-secret");
      const pathName = new URL(url).pathname;
      if (pathName === "/agents") {
        return Response.json({ ok: true, agents: [runtimeAgent, baseLibraryAgent] });
      }
      if (pathName === "/agents/external_audit_lora") {
        return Response.json({ ok: true, agent: runtimeAgent });
      }
      if (pathName === "/agents/finance_reasoning_lora") {
        return Response.json({ ok: true, agent: baseLibraryAgent });
      }
      if (pathName === "/audit/subjects/agent/external_audit_lora/receipts") {
        const last = agentReceipts.at(-1);
        return Response.json({
          ok: true,
          schema_version: 1,
          subject_type: "agent",
          subject_id: runtimeAgent.id,
          after_sequence: Number(new URL(url).searchParams.get("after_sequence") || 0),
          snapshot_sequence: agentReceipts.length,
          snapshot_head_hash: last.receipt_hash,
          has_more: false,
          next_after_sequence: null,
          receipts: agentReceipts
        });
      }
      if (pathName === "/audit/subjects/agent/external_audit_lora/verify") {
        const last = agentReceipts.at(-1);
        return Response.json({
          ok: true,
          schema_version: 1,
          subject_type: "agent",
          subject_id: runtimeAgent.id,
          receipts: agentReceipts.length,
          through_sequence: agentReceipts.length,
          head_hash: last.receipt_hash
        });
      }
      return Response.json({ detail: "not found" }, { status: 404 });
    };
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "virenis-adoption-"));
    app = await createApp({ dbPath: path.join(tmpDir, "db.json"), uploadRoot: tmpDir });
  });

  afterEach(async () => {
    await app?.locals?.drainBackgroundTasks?.({ timeoutMs: 5000 });
    await app?.locals?.store?.close?.();
    globalThis.fetch = previousFetch;
    for (const [name, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("keeps runtime-only agents admin-only until an explicit owned adoption", async () => {
    const admin = { Authorization: "Bearer admin_adoption_token" };
    const alice = { Authorization: "Bearer alice_adoption_token" };
    const bob = { Authorization: "Bearer bob_adoption_token" };

    const hidden = await request(app).get("/api/agents").set(alice).expect(200);
    expect(hidden.body.agents.map((agent) => agent.id)).not.toContain("external_audit_lora");
    expect(hidden.body.agents).toContainEqual(expect.objectContaining({
      id: "finance_reasoning_lora",
      base_lora: true,
      system_managed: true,
      visibility: "global",
      web_access: "all_users"
    }));
    await request(app)
      .get("/api/agents/finance_reasoning_lora")
      .set(alice)
      .expect(200)
      .expect((response) => {
        expect(response.body).toMatchObject({
          id: "finance_reasoning_lora",
          base_lora: true,
          visibility: "global",
          mounted: true
        });
    });
    await request(app).get("/api/agents/external_audit_lora").set(alice).expect(404);
    await request(app)
      .patch("/api/agents/external_audit_lora")
      .set(alice)
      .send({ boundary: "A tenant user must not discover runtime-only inventory." })
      .expect(404);
    await request(app)
      .patch("/api/agents/external_audit_lora")
      .set(admin)
      .send({ boundary: "Unowned mutation must not create web ownership." })
      .expect(409);
    await request(app)
      .post("/api/admin/runtime-agents/external_audit_lora/adopt")
      .set(alice)
      .send({ created_by: "alice", visibility: "private" })
      .expect(403);
    await request(app)
      .post("/api/admin/runtime-agents/external_audit_lora/adopt")
      .set(admin)
      .send({ created_by: "alice", visibility: "private" })
      .expect(400)
      .expect((response) => expect(response.body.error).toBe("idempotency_key_required"));

    const adopted = await request(app)
      .post("/api/admin/runtime-agents/external_audit_lora/adopt")
      .set(admin)
      .set("Idempotency-Key", "runtime-adoption-external-0001")
      .send({ created_by: "alice", visibility: "private" })
      .expect(201);
    expect(adopted.body).toMatchObject({
      status: "adopted",
      agent: {
        id: "external_audit_lora",
        workspace_id: "workspace_a",
        visibility: "private",
        created_by: "alice",
        runtime_only: false,
        agent_revision: `sha256:${"a".repeat(64)}`
      }
    });
    expect(adopted.body.agent).not.toHaveProperty("runtime_adoption_idempotency");

    const detail = await request(app).get("/api/agents/external_audit_lora").set(alice).expect(200);
    expect(detail.body).toMatchObject({
      id: "external_audit_lora",
      workspace_id: "workspace_a",
      visibility: "private",
      created_by: "alice"
    });
    await request(app).get("/api/agents/external_audit_lora").set(bob).expect(404);

    const events = await request(app)
      .get("/api/agents/external_audit_lora/events")
      .set(alice)
      .expect(200);
    expect(events.body.event_chain_valid).toBe(true);
    expect(events.body.agent_revision).toBe(`sha256:${"a".repeat(64)}`);
    expect(events.body.events[0].agent_revision).toBe(`sha256:${"a".repeat(64)}`);
    expect(events.body.events.map((event) => event.event_type)).toEqual(["agent.adopted"]);
    expect(events.body.events[0].details).toMatchObject({
      adopted_from: "runtime_only",
      assigned_owner: "alice",
      assigned_visibility: "private"
    });

    const runtimeAudit = await request(app)
      .get("/api/admin/agents/external_audit_lora/runtime-audit")
      .set(admin)
      .expect(200);
    expect(runtimeAudit.body).toMatchObject({
      ok: true,
      binding_valid: true,
      registration_binding: {
        receipt_id: "receipt_external_registered",
        agent_revision: "a".repeat(64),
        adapter_content_digest: "b".repeat(64),
        manifest_contract_digest: "c".repeat(64)
      },
      current_runtime_revision: {
        agent_revision: "a".repeat(64),
        adapter_content_digest: "b".repeat(64),
        manifest_contract_digest: "c".repeat(64)
      }
    });

    const replayed = await request(app)
      .post("/api/admin/runtime-agents/external_audit_lora/adopt")
      .set(admin)
      .set("Idempotency-Key", "runtime-adoption-external-0001")
      .send({ created_by: "alice", visibility: "private" })
      .expect(200);
    expect(replayed.body).toMatchObject({
      status: "adopted",
      duplicate: true,
      agent: { id: "external_audit_lora" }
    });
    await request(app)
      .post("/api/admin/runtime-agents/external_audit_lora/adopt")
      .set(admin)
      .set("Idempotency-Key", "runtime-adoption-external-0001")
      .send({ created_by: "bob", visibility: "private" })
      .expect(409)
      .expect((response) => expect(response.body.error).toBe("idempotency_conflict"));
  });

  it("binds adoption to the latest valid registration epoch after a Runtime re-registration", async () => {
    const admin = { Authorization: "Bearer admin_adoption_token" };
    const previous = agentReceipts.at(-1);
    runtimeAgent.agent_revision = "d".repeat(64);
    runtimeAgent.adapter_content_digest = "e".repeat(64);
    runtimeAgent.manifest_contract_digest = "f".repeat(64);
    agentReceipts.push(lifecycleReceipt({
      agentId: runtimeAgent.id,
      receiptId: "receipt_external_reregistered",
      sequence: 2,
      previousHash: previous.receipt_hash,
      agentRevision: runtimeAgent.agent_revision,
      adapterDigest: runtimeAgent.adapter_content_digest,
      manifestContractDigest: runtimeAgent.manifest_contract_digest
    }));

    const adopted = await request(app)
      .post("/api/admin/runtime-agents/external_audit_lora/adopt")
      .set(admin)
      .set("Idempotency-Key", "runtime-adoption-reregistered-0001")
      .send({ created_by: "alice", visibility: "private" })
      .expect(201);
    expect(adopted.body.agent.agent_revision).toBe(`sha256:${"d".repeat(64)}`);

    const audit = await request(app)
      .get("/api/admin/agents/external_audit_lora/runtime-audit")
      .set(admin)
      .expect(200);
    expect(audit.body.registration_binding.receipt_id).toBe("receipt_external_reregistered");
    expect(audit.body.receipts).toHaveLength(2);
  });
});

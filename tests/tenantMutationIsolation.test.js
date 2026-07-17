import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../server/app.js";

const TOKENS = {
  tenant_owner: { user_id: "owner_a", workspace_id: "tenant_a", role: "user" },
  tenant_admin_same: { user_id: "admin_a", workspace_id: "tenant_a", role: "admin" },
  tenant_admin_foreign: { user_id: "admin_b", workspace_id: "tenant_b", role: "admin" }
};

const auth = (token) => ({ Authorization: `Bearer ${token}` });

let app;
let tmpDir;
let previousEnvironment;

beforeEach(async () => {
  previousEnvironment = {
    WEB_STORE_DRIVER: process.env.WEB_STORE_DRIVER,
    APP_API_TOKENS_JSON: process.env.APP_API_TOKENS_JSON,
    APP_ADMIN_SEES_ALL_WORKSPACES: process.env.APP_ADMIN_SEES_ALL_WORKSPACES,
    APP_ALLOW_WORKSPACE_OVERRIDE: process.env.APP_ALLOW_WORKSPACE_OVERRIDE
  };
  process.env.WEB_STORE_DRIVER = "json";
  process.env.APP_API_TOKENS_JSON = JSON.stringify(TOKENS);
  // This deliberately expands support reads. Ordinary resource routes must
  // remain tenant-bound even under the broadest configured admin visibility.
  process.env.APP_ADMIN_SEES_ALL_WORKSPACES = "1";
  process.env.APP_ALLOW_WORKSPACE_OVERRIDE = "1";
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "virenis-tenant-mutation-"));
  app = await createApp({ dbPath: path.join(tmpDir, "db.json"), uploadRoot: tmpDir, autoRun: false });
});

afterEach(async () => {
  await app?.locals?.drainBackgroundTasks?.({ timeoutMs: 5000 });
  await app?.locals?.store?.close?.();
  for (const [name, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("ordinary data-plane mutation isolation", () => {
  it("rejects cross-tenant create targeting before any session, agent, or knowledge state is written", async () => {
    const foreignAdmin = auth("tenant_admin_foreign");
    const before = app.locals.store.read();
    const baseline = {
      sessions: before.sessions.length,
      agents: before.agents.length,
      documents: before.documents.length,
      agentEvents: before.agentEvents.length,
      agentWorkspaces: before.agentWorkspaces.length
    };

    await request(app)
      .post("/api/chat/sessions")
      .set(foreignAdmin)
      .send({ title: "Injected Tenant A session", workspace_id: "tenant_a" })
      .expect(404);
    await request(app)
      .post("/api/agents")
      .set(foreignAdmin)
      .send({
        id: "foreign_admin_injected_agent",
        title: "Injected Tenant A agent",
        capability: "Must never be stored outside the authenticated tenant.",
        boundary: "Remain tenant-bound.",
        workspace_id: "tenant_a"
      })
      .expect(404);
    await request(app)
      .post("/api/documents")
      .set(foreignAdmin)
      .field("title", "Injected Tenant A knowledge")
      .field("agent_id", "foreign_admin_injected_document")
      .field("workspace_id", "tenant_a")
      .attach("file", Buffer.from("Must never cross the tenant boundary."), "injected.txt")
      .expect(404);

    const afterRejectedCreates = app.locals.store.read();
    expect({
      sessions: afterRejectedCreates.sessions.length,
      agents: afterRejectedCreates.agents.length,
      documents: afterRejectedCreates.documents.length,
      agentEvents: afterRejectedCreates.agentEvents.length,
      agentWorkspaces: afterRejectedCreates.agentWorkspaces.length
    }).toEqual(baseline);
    expect(afterRejectedCreates.sessions.some((item) => item.title === "Injected Tenant A session")).toBe(false);
    expect(afterRejectedCreates.agents.some((item) => item.id === "foreign_admin_injected_agent")).toBe(false);
    expect(afterRejectedCreates.documents.some((item) => item.agent_id === "foreign_admin_injected_document")).toBe(false);

    const sameWorkspaceSession = await request(app)
      .post("/api/chat/sessions")
      .set(foreignAdmin)
      .send({ title: "Tenant B session", workspace_id: "tenant_b" })
      .expect(201);
    const sameWorkspaceAgent = await request(app)
      .post("/api/agents")
      .set(foreignAdmin)
      .send({
        id: "tenant_b_admin_agent",
        title: "Tenant B admin agent",
        capability: "Exercises same-workspace agent creation.",
        boundary: "Remain inside Tenant B.",
        workspace_id: "tenant_b"
      })
      .expect(201);
    const sameWorkspaceDocument = await request(app)
      .post("/api/documents")
      .set(foreignAdmin)
      .field("title", "Tenant B knowledge")
      .field("agent_id", "tenant_b_admin_document")
      .field("workspace_id", "tenant_b")
      .attach("file", Buffer.from("Tenant B same-workspace knowledge."), "tenant-b.txt")
      .expect(201);

    expect(sameWorkspaceSession.body.workspace_id).toBe("tenant_b");
    expect(sameWorkspaceAgent.body.workspace_id).toBe("tenant_b");
    expect(app.locals.store.read().documents
      .find((item) => item.document_id === sameWorkspaceDocument.body.document_id)?.workspace_id).toBe("tenant_b");
  });

  it("keeps foreign support admins read-only across agent, Marketplace, session, document, and outcome routes", async () => {
    const owner = auth("tenant_owner");
    const sameWorkspaceAdmin = auth("tenant_admin_same");
    const foreignAdmin = auth("tenant_admin_foreign");

    await request(app)
      .post("/api/agents")
      .set(owner)
      .send({
        id: "tenant_a_guarded_agent",
        title: "Tenant A guarded agent",
        capability: "Handles Tenant A's bounded support procedure.",
        boundary: "Use only Tenant A's approved procedure.",
        routing_cues: ["tenant a guarded procedure"]
      })
      .expect(201);
    const publication = await request(app)
      .post("/api/marketplace/items/tenant_a_guarded_agent")
      .set(owner)
      .send({ description: "Tenant A's published support agent." })
      .expect(201);
    const session = await request(app)
      .post("/api/chat/sessions")
      .set(owner)
      .send({ title: "Tenant A guarded session" })
      .expect(201);
    const document = await request(app)
      .post("/api/documents")
      .set(owner)
      .field("title", "Tenant A guarded manual")
      .field("agent_id", "tenant_a_guarded_document")
      .field("routing_cues", "tenant a guarded manual")
      .attach("file", Buffer.from("Tenant A private operating procedure."), "guarded.txt")
      .expect(201);

    await request(app)
      .post("/api/agents")
      .set(owner)
      .send({
        id: "tenant_a_archived_agent",
        title: "Tenant A archived agent",
        capability: "Exercises permanent deletion isolation.",
        boundary: "Stay inside Tenant A."
      })
      .expect(201);
    await request(app)
      .delete("/api/agents/tenant_a_archived_agent")
      .set(owner)
      .expect(200);

    await app.locals.store.mutate((data) => {
      data.runs.push({
        run_id: "run_tenant_a_guard",
        session_id: session.body.session_id,
        workspace_id: "tenant_a",
        created_by: "owner_a",
        status: "completed",
        events: []
      });
      for (const suffix of ["settlement", "dispute", "correction"]) {
        data.outcomeContracts.push({
          contract_id: `contract_tenant_a_${suffix}`,
          workspace_id: "tenant_a",
          created_by: "owner_a",
          visibility: "private",
          status: "pending",
          settlements: [],
          disputes: [],
          events: []
        });
      }
    });

    // The support visibility flag permits foreign reads, but must not imply
    // mutation authority or advertise a misleading Marketplace manage action.
    await request(app)
      .get("/api/agents/tenant_a_guarded_agent")
      .set(foreignAdmin)
      .expect(200);
    await request(app)
      .get(`/api/chat/sessions/${session.body.session_id}`)
      .set(foreignAdmin)
      .expect(200);
    await request(app)
      .get(`/api/documents/${document.body.document_id}/chunks`)
      .set(foreignAdmin)
      .expect(200);
    const foreignListing = await request(app)
      .get("/api/marketplace/items/tenant_a_guarded_agent")
      .set(foreignAdmin)
      .expect(200);
    expect(foreignListing.body.can_manage).toBe(false);

    const blocked = [
      request(app)
        .patch("/api/agents/tenant_a_guarded_agent")
        .set(foreignAdmin)
        .send({ title: "Foreign admin mutation" }),
      request(app)
        .delete("/api/agents/tenant_a_guarded_agent")
        .set(foreignAdmin),
      request(app)
        .delete("/api/agents/tenant_a_archived_agent/permanent")
        .set(foreignAdmin),
      request(app)
        .post("/api/marketplace/items/tenant_a_guarded_agent")
        .set(foreignAdmin)
        .send({ description: "Foreign admin listing mutation." }),
      request(app)
        .delete("/api/marketplace/items/tenant_a_guarded_agent")
        .set(foreignAdmin),
      request(app)
        .patch(`/api/chat/sessions/${session.body.session_id}/agents/tenant_a_guarded_agent`)
        .set(foreignAdmin)
        .send({ active: false }),
      request(app)
        .patch(`/api/chat/sessions/${session.body.session_id}/agent-workspace`)
        .set(foreignAdmin)
        .send({ agent_workspace_id: "foreign_workspace_id" }),
      request(app)
        .post(`/api/chat/sessions/${session.body.session_id}/messages`)
        .set(foreignAdmin)
        .send({ content: "Attempt a foreign support-admin message mutation." }),
      request(app)
        .post("/api/chat/runs/run_tenant_a_guard/feedback")
        .set(foreignAdmin)
        .send({ rating: "bad", reason: "Foreign feedback mutation" }),
      request(app)
        .delete(`/api/documents/${document.body.document_id}`)
        .set(foreignAdmin),
      request(app)
        .post("/api/documents")
        .set(foreignAdmin)
        .field("title", "Foreign attachment")
        .field("resource_for_agent_id", "tenant_a_guarded_agent")
        .attach("file", Buffer.from("Must not be attached."), "foreign.txt"),
      request(app)
        .post("/api/documents")
        .set(foreignAdmin)
        .field("title", "Foreign chat attachment")
        .field("scope", "chat")
        .field("session_id", session.body.session_id)
        .attach("file", Buffer.from("Must not be attached to a foreign chat."), "foreign-chat.txt"),
      request(app)
        .post("/api/chat/runs/run_tenant_a_guard/outcome-contracts")
        .set(foreignAdmin)
        .send({}),
      request(app)
        .post("/api/outcome-contracts/contract_tenant_a_settlement/settlements")
        .set(foreignAdmin)
        .send({}),
      request(app)
        .post("/api/outcome-contracts/contract_tenant_a_dispute/disputes")
        .set(foreignAdmin)
        .send({ reason: "Foreign mutation" }),
      request(app)
        .post("/api/outcome-contracts/contract_tenant_a_correction/corrections")
        .set(foreignAdmin)
        .send({ reason: "Foreign mutation" })
    ];
    for (const mutation of blocked) await mutation.expect(404);

    const ownerAgent = await request(app)
      .get("/api/agents/tenant_a_guarded_agent")
      .set(owner)
      .expect(200);
    expect(ownerAgent.body.title).toBe("Tenant A guarded agent");
    const unchangedListing = await request(app)
      .get("/api/marketplace/items/tenant_a_guarded_agent")
      .set(owner)
      .expect(200);
    expect(unchangedListing.body).toMatchObject({
      listing_id: publication.body.listing_id,
      description: "Tenant A's published support agent."
    });
    expect(app.locals.store.read().documents
      .find((item) => item.document_id === document.body.document_id).enabled).toBe(true);
    expect(app.locals.store.read().messages
      .some((message) => message.content === "Attempt a foreign support-admin message mutation.")).toBe(false);
    expect(app.locals.store.read().runs
      .find((run) => run.run_id === "run_tenant_a_guard").feedback || []).toEqual([]);
    expect(app.locals.store.read().documents
      .some((item) => item.source_path === "foreign-chat.txt")).toBe(false);

    // A different administrator in the resource's own workspace retains the
    // pre-existing operational authority on these ordinary routes.
    const sameWorkspaceListing = await request(app)
      .get("/api/marketplace/items/tenant_a_guarded_agent")
      .set(sameWorkspaceAdmin)
      .expect(200);
    expect(sameWorkspaceListing.body.can_manage).toBe(true);
    await request(app)
      .patch("/api/agents/tenant_a_guarded_agent")
      .set(sameWorkspaceAdmin)
      .send({ title: "Tenant A admin-approved title" })
      .expect(200);
    await request(app)
      .post("/api/marketplace/items/tenant_a_guarded_agent")
      .set(sameWorkspaceAdmin)
      .send({ description: "Tenant A admin-updated listing description." })
      .expect(200);
    await request(app)
      .patch(`/api/chat/sessions/${session.body.session_id}/agents/tenant_a_guarded_agent`)
      .set(sameWorkspaceAdmin)
      .send({ active: false })
      .expect(200);
    await request(app)
      .post(`/api/chat/sessions/${session.body.session_id}/messages`)
      .set(sameWorkspaceAdmin)
      .send({ content: "Record a same-workspace administrative support message." })
      .expect(202);
    await request(app)
      .post("/api/chat/runs/run_tenant_a_guard/feedback")
      .set(sameWorkspaceAdmin)
      .send({ rating: "bad", reason: "Same-workspace feedback review" })
      .expect(201);
    await request(app)
      .post("/api/documents")
      .set(sameWorkspaceAdmin)
      .field("title", "Same-workspace chat attachment")
      .field("scope", "chat")
      .field("session_id", session.body.session_id)
      .attach("file", Buffer.from("Same-workspace administrative chat context."), "same-workspace-chat.txt")
      .expect(201);
    await request(app)
      .delete(`/api/documents/${document.body.document_id}`)
      .set(sameWorkspaceAdmin)
      .expect(200);
    await request(app)
      .delete("/api/agents/tenant_a_archived_agent/permanent")
      .set(sameWorkspaceAdmin)
      .expect(200);
    await request(app)
      .post("/api/outcome-contracts/contract_tenant_a_settlement/settlements")
      .set(sameWorkspaceAdmin)
      .send({})
      .expect(409);
    await request(app)
      .delete("/api/marketplace/items/tenant_a_guarded_agent")
      .set(sameWorkspaceAdmin)
      .expect(200);
  });
});

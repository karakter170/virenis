import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  MarketplacePanel,
  MarketplaceWorkspaceAgentDetails
} from "../src/App.jsx";
import { CANONICAL_AGENT_SCHEMA_VERSION } from "../server/agentContract.js";
import { createApp } from "../server/app.js";
import {
  CURATED_MARKETPLACE_TEAM_IDS,
  curatedMarketplaceTeams
} from "../server/curatedMarketplace.js";
import { configuredPlanGaps, planRoutes } from "../server/tcarEngine.js";

const TOKENS = {
  curated_alice: {
    user_id: "curated_alice",
    workspace_id: "tenant_curated_alice",
    role: "user",
    display_name: "Alice"
  },
  curated_bob: {
    user_id: "curated_bob",
    workspace_id: "tenant_curated_bob",
    role: "user",
    display_name: "Bob"
  }
};
const EXPECTED_MEMORY = {
  read_scopes: ["conversation", "team"],
  write_scopes: ["conversation"],
  retention: "session",
  sensitivity_limit: "internal"
};
const EXPECTED_PERMISSIONS = {
  side_effects: ["none"],
  approval_required_for: ["email_send"]
};

let app;
let tempRoot;
let dbPath;
let previousEnvironment;

function as(user) {
  return `Bearer curated_${user}`;
}

function curatedWorkspaces(data) {
  return (data.agentWorkspaces || []).filter((workspace) => workspace.curated_marketplace_team === true);
}

function assertDirectedAcyclicGraph(team) {
  const ids = new Set(team.agents.map((agent) => agent.id));
  const outgoing = new Map([...ids].map((id) => [id, []]));
  const indegree = new Map([...ids].map((id) => [id, 0]));

  for (const [source, target, label] of team.edges) {
    expect(ids.has(source.id)).toBe(true);
    expect(ids.has(target.id)).toBe(true);
    expect(source.id).not.toBe(target.id);
    expect(label.trim()).not.toBe("");
    outgoing.get(source.id).push(target.id);
    indegree.set(target.id, indegree.get(target.id) + 1);
  }

  const ready = [...ids].filter((id) => indegree.get(id) === 0);
  let visited = 0;
  while (ready.length) {
    const id = ready.shift();
    visited += 1;
    for (const target of outgoing.get(id)) {
      indegree.set(target, indegree.get(target) - 1);
      if (indegree.get(target) === 0) ready.push(target);
    }
  }
  expect(visited).toBe(ids.size);
}

function dependencyClosure(agent, agents) {
  const byId = new Map(agents.map((candidate) => [candidate.id, candidate]));
  const selected = new Set();
  const visit = (candidate) => {
    if (!candidate || selected.has(candidate.id)) return;
    for (const input of candidate.consumes || []) {
      const dependency = String(input).match(/^agent:([a-z0-9_]+):output$/i)?.[1];
      if (dependency) visit(byId.get(dependency));
    }
    selected.add(candidate.id);
  };
  visit(agent);
  return selected;
}

beforeEach(async () => {
  previousEnvironment = {
    WEB_STORE_DRIVER: process.env.WEB_STORE_DRIVER,
    APP_API_TOKENS_JSON: process.env.APP_API_TOKENS_JSON
  };
  process.env.WEB_STORE_DRIVER = "json";
  process.env.APP_API_TOKENS_JSON = JSON.stringify(TOKENS);
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "virenis-curated-marketplace-"));
  dbPath = path.join(tempRoot, "db.json");
  app = await createApp({
    dbPath,
    uploadRoot: tempRoot,
    autoRun: false
  });
});

afterEach(async () => {
  await app?.locals?.drainBackgroundTasks?.({ timeoutMs: 5000 });
  await app?.locals?.store?.close?.();
  app = null;
  for (const [key, value] of Object.entries(previousEnvironment || {})) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await fs.rm(tempRoot, { recursive: true, force: true });
});

describe("Virenis curated Marketplace teams", () => {
  it("defines four canonical six-agent teams with unique ids, acyclic handoffs, and one terminal coordinator", () => {
    expect(curatedMarketplaceTeams).toHaveLength(4);
    expect(curatedMarketplaceTeams.map((team) => team.name)).toEqual([
      "Engineering",
      "Marketing",
      "Product",
      "Brainstorming"
    ]);
    expect(CURATED_MARKETPLACE_TEAM_IDS).toHaveLength(4);
    expect(new Set(CURATED_MARKETPLACE_TEAM_IDS).size).toBe(4);

    const allAgentIds = curatedMarketplaceTeams.flatMap((team) => team.agents.map((agent) => agent.id));
    const allListingIds = curatedMarketplaceTeams.map((team) => team.listingId);
    expect(allAgentIds).toHaveLength(24);
    expect(new Set(allAgentIds).size).toBe(24);
    expect(new Set(allListingIds).size).toBe(4);

    for (const team of curatedMarketplaceTeams) {
      expect(team.agents).toHaveLength(6);
      expect(team.agents.length).toBeLessThanOrEqual(16);
      expect(team.workspace.marketplace.snapshot.agents).toHaveLength(6);
      expect(team.workspace.marketplace.snapshot.edges).toHaveLength(team.edges.length);
      assertDirectedAcyclicGraph(team);

      const incoming = new Map(team.agents.map((agent) => [agent.id, []]));
      const outgoing = new Map(team.agents.map((agent) => [agent.id, []]));
      for (const [source, target] of team.edges) {
        incoming.get(target.id).push(source);
        outgoing.get(source.id).push(target);
        expect(source.stage).toBeLessThan(target.stage);
      }
      const terminalAgents = team.agents.filter((agent) => outgoing.get(agent.id).length === 0);
      expect(terminalAgents).toHaveLength(1);
      expect(terminalAgents[0]).toBe(team.agents.at(-1));
      expect(terminalAgents[0].agent_contract.routing.role_kind).toBe("coordinator");
      expect(new Set(incoming.get(terminalAgents[0].id).map((agent) => agent.id))).toEqual(
        new Set(team.agents.slice(0, -1).map((agent) => agent.id))
      );

      const outputNames = team.agents.flatMap((agent) => agent.produces);
      expect(new Set(outputNames).size).toBe(outputNames.length);

      for (const [index, agent] of team.agents.entries()) {
        expect(agent.contract_version).toBe(CANONICAL_AGENT_SCHEMA_VERSION);
        expect(agent.agent_contract.schema_version).toBe(CANONICAL_AGENT_SCHEMA_VERSION);
        expect(agent.agent_contract.id).toBe(agent.id);
        expect(agent.memory).toEqual(EXPECTED_MEMORY);
        expect(agent.permissions).toEqual(EXPECTED_PERMISSIONS);
        expect(agent.routing.metadata_trust).toBe("runtime_normalized");
        expect(agent.routing.use_when.length).toBeGreaterThanOrEqual(5);
        expect(agent.routing.avoid_when.length).toBeGreaterThan(0);
        expect(agent.lifecycle).toEqual({ state: "ready", health: "healthy" });
        expect(agent.agent_contract.memory).toEqual(EXPECTED_MEMORY);
        expect(agent.agent_contract.permissions).toEqual(EXPECTED_PERMISSIONS);
        expect(agent.agent_contract.lifecycle).toEqual({ state: "ready", health: "healthy" });
        expect(agent.agent_contract.content_digest).toMatch(/^sha256:[a-f0-9]{64}$/);
        expect(agent.agent_contract.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
        expect(agent.agent_contract.routing.role_kind).toBe(index === team.agents.length - 1 ? "coordinator" : "specialist");
        expect(agent.policies.memory).toEqual({ mode: "conversation" });
        expect(agent.consumes).toContain("shared_memory");
        expect(agent.policies.knowledge.requirements).toContain("user_provided_context");
        expect(agent.resources).toEqual([]);
        expect(agent.sources).toEqual([]);

        for (const source of incoming.get(agent.id)) {
          expect(agent.consumes).toContain(`agent:${source.id}:output`);
        }
        const declaredDependencies = agent.consumes
          .flatMap((value) => String(value).match(/^agent:([a-z0-9_]+):output$/i)?.[1] || []);
        expect(new Set(declaredDependencies)).toEqual(new Set(incoming.get(agent.id).map((source) => source.id)));
        expect(new Set(agent.agent_contract.execution.handoffs.requires_agents)).toEqual(new Set(declaredDependencies));
        if (incoming.get(agent.id).length) {
          expect(agent.consumes).not.toContain("upstream_route_outputs");
          expect(agent.policies.knowledge.requirements).toContain("upstream_specialist");
        }

        const published = team.workspace.marketplace.snapshot.agents.find((entry) => entry.source_agent_id === agent.id).agent;
        expect(published.contract_version).toBe(CANONICAL_AGENT_SCHEMA_VERSION);
        expect(published.agent_contract.schema_version).toBe(CANONICAL_AGENT_SCHEMA_VERSION);
        expect(published.memory).toEqual(EXPECTED_MEMORY);
        expect(published.permissions).toEqual(EXPECTED_PERMISSIONS);
        expect(published.routing.metadata_trust).toBe("runtime_normalized");
        expect(published.lifecycle).toEqual({ state: "ready", health: "healthy" });
        expect(published.agent_contract.execution.handoffs.requires_agents).toEqual([]);
      }
    }
  });

  it("compiles every intermediate and terminal role with an exact complete handoff closure", () => {
    for (const team of curatedMarketplaceTeams) {
      const convergingAgent = team.agents.find((agent) => agent.stage === 70);
      const convergingClosure = dependencyClosure(convergingAgent, team.agents);
      const bounded = planRoutes({
        query: `Ask @${convergingAgent.id} to continue the earlier conclusion.`,
        agents: team.agents,
        semanticAgentIds: [convergingAgent.id],
        maxRoutingAdapters: convergingClosure.size
      });
      expect(new Set(bounded.steps.map((step) => step.adapter)), team.name).toEqual(convergingClosure);
      expect(configuredPlanGaps(bounded.steps, team.agents), team.name).toEqual([]);
      expect(bounded.steps.filter((step) => step.adapter !== convergingAgent.id).every((step) => (
        step.task.includes("authorized conversation memory")
        && !step.task.includes("Prepare the upstream work")
      )), team.name).toBe(true);

      const leadAgent = team.agents.at(-1);
      const complete = planRoutes({
        query: `Ask @${leadAgent.id} to continue the earlier conclusion.`,
        agents: team.agents,
        semanticAgentIds: [leadAgent.id],
        maxRoutingAdapters: 6
      });
      expect(new Set(complete.steps.map((step) => step.adapter)), team.name).toEqual(
        new Set(team.agents.map((agent) => agent.id))
      );
      expect(configuredPlanGaps(complete.steps, team.agents), team.name).toEqual([]);

      expect(() => planRoutes({
        query: `Ask @${leadAgent.id} to continue the earlier conclusion.`,
        agents: team.agents,
        semanticAgentIds: [leadAgent.id],
        maxRoutingAdapters: 5
      }), team.name).toThrow(/complete configured handoff graph/i);
    }
  });

  it("seeds the four teams first in Discover with stable Virenis verification while community fields cannot spoof it", async () => {
    const initial = await request(app)
      .get("/api/marketplace")
      .set("Authorization", as("alice"))
      .expect(200);
    const firstFour = initial.body.items.slice(0, 4);
    expect(firstFour.map((item) => item.title)).toEqual([
      "Engineering",
      "Marketing",
      "Product",
      "Brainstorming"
    ]);
    expect(firstFour.map((item) => item.pin_rank)).toEqual([1, 2, 3, 4]);
    for (const item of firstFour) {
      expect(item).toMatchObject({
        item_type: "workspace",
        agent_count: 6,
        verified: true,
        pinned: true,
        publisher_display_name: "Virenis",
        can_manage: false,
        is_self_published: false
      });
      expect(item.publisher).toMatchObject({ display_name: "Virenis", status: "active" });
    }

    await request(app)
      .post("/api/agents")
      .set("Authorization", as("alice"))
      .send({
        id: "community_spoof_attempt",
        title: "Community showcase",
        capability: "Creates a bounded community showcase.",
        boundary: "Use only the supplied request.",
        consumes: ["user_request"],
        produces: ["community_showcase"],
        routing_cues: ["community showcase"]
      })
      .expect(201);
    await request(app)
      .post("/api/marketplace/items/community_spoof_attempt")
      .set("Authorization", as("alice"))
      .send({
        description: "A community listing that submitted reserved presentation fields.",
        verified: true,
        pinned: true,
        pin_rank: 0,
        publisher_display_name: "Virenis"
      })
      .expect(201);
    await request(app)
      .post("/api/marketplace/items/community_spoof_attempt/ratings")
      .set("Authorization", as("bob"))
      .send({ score: 5 })
      .expect(201);

    const listed = await request(app)
      .get("/api/marketplace")
      .set("Authorization", as("bob"))
      .expect(200);
    expect(listed.body.items.slice(0, 4).map((item) => item.id)).toEqual(CURATED_MARKETPLACE_TEAM_IDS);
    const community = listed.body.items.find((item) => item.id === "community_spoof_attempt");
    expect(community).toMatchObject({
      verified: false,
      pinned: false,
      pin_rank: null,
      rating_average: 5,
      rating_count: 1
    });
    expect(community.publisher_display_name).not.toBe("Virenis");
    expect(listed.body.items.indexOf(community)).toBeGreaterThanOrEqual(4);

    const searched = await request(app)
      .get("/api/marketplace?type=workspace&q=Product")
      .set("Authorization", as("bob"))
      .expect(200);
    expect(searched.body.items).toHaveLength(1);
    expect(searched.body.items[0]).toMatchObject({ title: "Product", verified: true, pin_rank: 3 });
  });

  it("keeps first-party definitions immutable to ordinary Marketplace publish and unpublish routes", async () => {
    const target = curatedMarketplaceTeams[0];
    await request(app)
      .post(`/api/marketplace/items/${target.workspace.agent_workspace_id}`)
      .set("Authorization", as("alice"))
      .send({ description: "Attempt to replace the official description." })
      .expect(404);
    await request(app)
      .delete(`/api/marketplace/items/${target.workspace.agent_workspace_id}`)
      .set("Authorization", as("alice"))
      .expect(404);

    const detail = await request(app)
      .get(`/api/marketplace/items/${target.workspace.agent_workspace_id}`)
      .set("Authorization", as("alice"))
      .expect(200);
    expect(detail.body).toMatchObject({
      listing_id: target.listingId,
      description: target.description,
      verified: true,
      pinned: true,
      can_manage: false
    });
  });

  it("reinstalls the curated catalog idempotently across a persistent-store restart with stable listing ids", async () => {
    const before = app.locals.store.read();
    const beforeWorkspaceIds = curatedWorkspaces(before).map((workspace) => workspace.agent_workspace_id).sort();
    const beforeListings = curatedWorkspaces(before)
      .map((workspace) => [workspace.agent_workspace_id, workspace.marketplace.listing_id])
      .sort(([left], [right]) => left.localeCompare(right));
    expect(beforeWorkspaceIds).toHaveLength(4);
    expect(before.agents.some((agent) => agent.curated_marketplace_source === true)).toBe(false);

    await app.locals.store.close();
    app = await createApp({
      dbPath,
      uploadRoot: tempRoot,
      autoRun: false
    });

    const after = app.locals.store.read();
    expect(curatedWorkspaces(after).map((workspace) => workspace.agent_workspace_id).sort()).toEqual(beforeWorkspaceIds);
    expect(after.agents.some((agent) => agent.curated_marketplace_source === true)).toBe(false);
    expect(curatedWorkspaces(after)
      .map((workspace) => [workspace.agent_workspace_id, workspace.marketplace.listing_id])
      .sort(([left], [right]) => left.localeCompare(right))).toEqual(beforeListings);
    expect(new Set((after.agentWorkspaces || []).map((workspace) => workspace.agent_workspace_id)).size)
      .toBe((after.agentWorkspaces || []).length);
    expect(new Set((after.agents || []).map((agent) => agent.id)).size)
      .toBe((after.agents || []).length);
  });

  it("copies a curated team into a private tenant with remapped handoffs and share-safe memory and knowledge policies", async () => {
    const source = curatedMarketplaceTeams[0];
    const detail = await request(app)
      .get(`/api/marketplace/items/${source.workspace.agent_workspace_id}`)
      .set("Authorization", as("bob"))
      .expect(200);

    const copied = await request(app)
      .post(`/api/marketplace/items/${source.workspace.agent_workspace_id}/copy`)
      .set("Authorization", as("bob"))
      .set("Idempotency-Key", "copy-curated-engineering-0001")
      .send({ listing_id: detail.body.listing_id })
      .expect(201);
    const copiedWorkspaceId = copied.body.agent_workspace.agent_workspace_id;
    expect(copiedWorkspaceId).not.toBe(source.workspace.agent_workspace_id);

    const workspace = await request(app)
      .get(`/api/agent-workspaces/${copiedWorkspaceId}`)
      .set("Authorization", as("bob"))
      .expect(200);
    expect(workspace.body).toMatchObject({
      agent_workspace_id: copiedWorkspaceId,
      name: "Engineering copy",
      agent_count: 6,
      setup_status: "ready"
    });
    expect(workspace.body.agents).toHaveLength(6);

    const sourceToCopy = new Map(workspace.body.agents.map((agent) => [
      agent.marketplace_origin?.source_agent_id,
      agent
    ]));
    expect(sourceToCopy.size).toBe(6);
    for (const sourceAgent of source.agents) {
      const agent = sourceToCopy.get(sourceAgent.id);
      expect(agent).toBeTruthy();
      expect(agent.id).not.toBe(sourceAgent.id);
      expect(agent).toMatchObject({
        workspace_id: TOKENS.curated_bob.workspace_id,
        created_by: TOKENS.curated_bob.user_id,
        visibility: "private"
      });
      expect(agent.policies.memory).toEqual(sourceAgent.policies.memory);
      expect(agent.policies.knowledge).toEqual(sourceAgent.policies.knowledge);
      expect(agent.consumes).toContain("shared_memory");
      expect(agent.contract_version).toBe(CANONICAL_AGENT_SCHEMA_VERSION);
      expect(agent.memory).toEqual(EXPECTED_MEMORY);
      expect(agent.permissions).toEqual(EXPECTED_PERMISSIONS);
      expect(agent.routing.metadata_trust).toBe("runtime_normalized");
      expect(agent.lifecycle).toEqual({ state: "ready", health: "healthy" });
    }

    for (const [sourceAgent, targetAgent] of source.edges) {
      const copiedSource = sourceToCopy.get(sourceAgent.id);
      const copiedTarget = sourceToCopy.get(targetAgent.id);
      expect(copiedTarget.consumes).toContain(`agent:${copiedSource.id}:output`);
      expect(copiedTarget.consumes).not.toContain(`agent:${sourceAgent.id}:output`);
    }

    const copiedIds = new Set(workspace.body.agents.map((agent) => agent.id));
    const storedCopies = app.locals.store.read().agents.filter((agent) => copiedIds.has(agent.id));
    expect(storedCopies).toHaveLength(6);
    for (const agent of storedCopies) {
      expect(agent.workspace_id).toBe(TOKENS.curated_bob.workspace_id);
      expect(agent.created_by).toBe(TOKENS.curated_bob.user_id);
      expect(agent.visibility).toBe("private");
      expect(agent.resources).toEqual([]);
      expect(agent.sources).toEqual([]);
      expect(agent.mcp_bindings).toEqual([]);
      expect(agent.tool_contracts).toEqual({});
      expect(agent).not.toHaveProperty("source_text_internal");
      expect(agent.document).toBeNull();
      expect(agent.retrieval).toBeNull();
      const remappedDependencies = agent.consumes
        .flatMap((value) => String(value).match(/^agent:([a-z0-9_]+):output$/i)?.[1] || []);
      expect(new Set(agent.agent_contract.execution.handoffs.requires_agents)).toEqual(new Set(remappedDependencies));
      expect(remappedDependencies.every((dependency) => copiedIds.has(dependency))).toBe(true);
      expect(JSON.stringify(agent.agent_contract)).not.toMatch(/virenis_curated_engineering_/);
      expect(JSON.stringify(agent)).not.toMatch(/bearer|client_secret|access_token|refresh_token/i);
    }
  });

  it("renders the real Discover API catalog and canonical specialist contract through the web interface", async () => {
    const discovery = await request(app)
      .get("/api/marketplace?type=workspace")
      .set("Authorization", as("alice"))
      .expect(200);
    const panelMarkup = renderToStaticMarkup(createElement(MarketplacePanel, {
      items: discovery.body.items,
      auth: TOKENS.curated_alice
    }));
    for (const team of curatedMarketplaceTeams) {
      expect(panelMarkup).toContain(team.name);
      expect(panelMarkup).toContain(team.description);
    }
    expect(panelMarkup.match(/>Verified</g)).toHaveLength(4);

    const engineering = discovery.body.items.find((item) => item.title === "Engineering");
    const detail = await request(app)
      .get(`/api/marketplace/items/${engineering.id}`)
      .set("Authorization", as("alice"))
      .expect(200);
    expect(detail.body.workspace.agents).toHaveLength(6);
    const specialistMarkup = renderToStaticMarkup(createElement(MarketplaceWorkspaceAgentDetails, {
      entry: detail.body.workspace.agents[0],
      workspaceTitle: detail.body.title,
      publisher: detail.body.publisher_display_name,
      verified: detail.body.verified
    }));
    expect(specialistMarkup).toContain("virenis-agent-v4");
    expect(specialistMarkup).toContain("Runtime-normalized metadata");
    expect(specialistMarkup).toContain("Reads this conversation and the active team");
    expect(specialistMarkup).toContain("No side effects");
    expect(specialistMarkup).toContain("Approval required for email send");
    expect(specialistMarkup).toContain("ready · healthy");
  });
});

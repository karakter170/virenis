import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  CANONICAL_AGENT_SCHEMA_VERSION,
  agentIsRoutingReady,
  canonicalAgentContract,
  ensureCanonicalAgentContract
} from "../server/agentContract.js";
import { scopedRoutingContext } from "../server/chatRunCoordinator.js";


const expectedMemory = {
  read_scopes: ["conversation", "team"],
  write_scopes: ["conversation"],
  retention: "session",
  sensitivity_limit: "internal"
};

const expectedPermissions = {
  side_effects: ["none"],
  approval_required_for: ["email_send"]
};

function canonicalAgent(id, overrides = {}) {
  return ensureCanonicalAgentContract({
    id,
    title: `Specialist ${id}`,
    capability: `Handles ${id} requests.`,
    boundary: `Stay within ${id}.`,
    consumes: ["user_request"],
    produces: [`${id}_output`],
    routing_cues: [id],
    resources: [],
    tools: [],
    sources: [],
    policies: {},
    stage: 10,
    ...overrides
  });
}

describe("canonical agent contract v4", () => {
  it("keeps the Python Runtime and JavaScript web compiler byte-equivalent", () => {
    const fixture = {
      id: "parity_agent",
      title: "Parity Agent",
      capability: "Reviews plans with approved evidence.",
      boundary: "Do not perform external side effects.",
      consumes: ["user_request", "agent:research_agent:output"],
      produces: ["review"],
      routing_cues: ["plan review", "evidence review"],
      routing: { avoid_when: ["The request needs an external mutation."] },
      resources: ["agent:research_agent"],
      tools: ["web_search"],
      tool_contracts: {
        web_search: {
          title: "Web search",
          description: "Read current public sources.",
          risk: "read",
          requires_approval: false
        }
      },
      sources: ["approved/source.md"],
      workflow_profile: {
        configuration_version: "virenis-workflow-agent-config-v3",
        response: { style: "careful", tones: ["clear", "technical"] },
        memory: { mode: "conversation" },
        knowledge: { requirements: ["current_web"], resources: ["agent:research_agent"] },
        composition: { reusable_role: true, source_content_persisted: false }
      },
      memory: expectedMemory,
      permissions: expectedPermissions,
      lifecycle: { state: "ready", health: "healthy" }
    };
    const projectRoot = fileURLToPath(new URL("../../../", import.meta.url));
    const python = spawnSync("python", [
      "-c",
      "import json,sys; from tcar_agent_contracts import canonical_agent_contract; print(json.dumps(canonical_agent_contract(json.load(sys.stdin)), sort_keys=True, separators=(',', ':')))"
    ], {
      cwd: projectRoot,
      input: JSON.stringify(fixture),
      encoding: "utf8"
    });

    expect(python.status, python.stderr).toBe(0);
    expect(canonicalAgentContract(fixture)).toEqual(JSON.parse(python.stdout));
  });

  it("builds exact routing controls and remains digest-idempotent", () => {
    const first = canonicalAgent("contract_agent");

    expect(first.contract_version).toBe(CANONICAL_AGENT_SCHEMA_VERSION);
    expect(first.agent_contract.schema_version).toBe(CANONICAL_AGENT_SCHEMA_VERSION);
    expect(first.agent_contract.memory).toEqual(expectedMemory);
    expect(first.agent_contract.permissions).toEqual(expectedPermissions);
    expect(first.agent_contract.routing.metadata_trust).toBe("runtime_normalized");
    expect(first.agent_contract.lifecycle).toEqual({ state: "ready", health: "healthy" });
    expect(first.memory).toEqual(first.agent_contract.memory);
    expect(first.permissions).toEqual(first.agent_contract.permissions);
    expect(first.routing).toEqual(first.agent_contract.routing);
    expect(first.lifecycle).toEqual(first.agent_contract.lifecycle);

    const second = ensureCanonicalAgentContract(first);
    expect(second.agent_contract.digest).toBe(first.agent_contract.digest);
    expect(second.agent_contract.content_digest).toBe(first.agent_contract.content_digest);
    expect(second.agent_contract.revision).toBe(first.agent_contract.revision);

    const edited = ensureCanonicalAgentContract({
      ...second,
      capability: "Handles contract requests and unit checks.",
      memory: { ...second.memory, retention: "persistent" }
    });
    expect(edited.agent_contract.content_digest).not.toBe(first.agent_contract.content_digest);
    expect(edited.agent_contract.revision).toBe(first.agent_contract.revision + 1);
    expect(edited.agent_contract.memory.retention).toBe("persistent");
  });

  it("gates lifecycle and exposes every member of a full 16-agent active team", () => {
    const session = {
      session_id: "session_contract",
      workspace_id: "workspace_contract",
      created_by: "owner_contract",
      inactive_agent_ids: []
    };
    const team = Array.from({ length: 16 }, (_, index) => canonicalAgent(`team_agent_${index}`, {
      workspace_id: session.workspace_id,
      created_by: session.created_by,
      visibility: "private",
      mounted: true
    }));
    const source = canonicalAgent("attached_source", {
      workspace_id: session.workspace_id,
      created_by: session.created_by,
      visibility: "private",
      mounted: true,
      resource_for_agent_id: team[0].id
    });
    const provisioning = canonicalAgent("provisioning_agent", {
      workspace_id: session.workspace_id,
      created_by: session.created_by,
      visibility: "private",
      mounted: true,
      lifecycle: { state: "provisioning", health: "unknown" }
    });
    const workspace = {
      agent_workspace_id: "team_contract",
      workspace_id: session.workspace_id,
      created_by: session.created_by,
      agent_ids: team.map((agent) => agent.id),
      max_agents: 16
    };

    const scoped = scopedRoutingContext({
      session,
      agents: [...team, source, provisioning],
      documents: [],
      agentWorkspace: workspace
    });

    expect(agentIsRoutingReady(team[0])).toBe(true);
    expect(agentIsRoutingReady(provisioning)).toBe(false);
    expect(scoped.teamAdapters).toEqual(team.map((agent) => agent.id));
    expect(scoped.teamAdapters).toHaveLength(16);
    expect(scoped.allowedAdapters).toContain(source.id);
    expect(scoped.teamAdapters).not.toContain(source.id);
    expect(scoped.allowedAdapters).not.toContain(provisioning.id);
  });
});

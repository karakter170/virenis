import { describe, expect, it } from "vitest";

import { scopedRoutingContext } from "../server/tcarEngine.js";
import { buildWorkflowCompositionInput } from "../server/workflows.js";

function agent(id, overrides = {}) {
  return {
    id,
    title: id,
    capability: `Handles ${id}.`,
    routing_cues: [id],
    produces: [`${id}_output`],
    enabled: true,
    mounted: true,
    ready: true,
    ...overrides
  };
}

describe("legacy resource isolation", () => {
  it("gives the Router and workflow composer the same fail-closed tenant catalog", () => {
    const session = {
      session_id: "session_alice",
      workspace_id: "workspace_a",
      created_by: "alice",
      inactive_agent_ids: [],
      shared_memory: []
    };
    const agents = [
      agent("alice_agent", {
        workspace_id: "workspace_a",
        visibility: "private",
        created_by: "alice"
      }),
      agent("bob_agent", {
        workspace_id: "workspace_b",
        visibility: "global",
        created_by: "bob"
      }),
      agent("legacy_unscoped_user_agent", {
        visibility: "global",
        created_by: "alice",
        system_managed: false
      }),
      agent("trusted_catalog_agent", {
        visibility: "global",
        created_by: "router-system",
        system_managed: true
      }),
      agent("ambiguous_agent", {
        workspace_id: "workspace_a",
        visibility: "private",
        created_by: "alice"
      }),
      agent("ambiguous_agent", {
        workspace_id: "workspace_a",
        visibility: "private",
        created_by: "alice",
        title: "A second record with the same execution id"
      })
    ];
    const documents = [
      {
        document_id: "alice_document",
        workspace_id: "workspace_a",
        visibility: "private",
        created_by: "alice",
        enabled: true
      },
      {
        document_id: "bob_document",
        workspace_id: "workspace_b",
        visibility: "global",
        created_by: "bob",
        enabled: true
      },
      {
        document_id: "legacy_unscoped_document",
        visibility: "global",
        created_by: "alice",
        enabled: true
      }
    ];
    const agentWorkspace = {
      agent_workspace_id: "aw_alice",
      workspace_id: "workspace_a",
      created_by: "alice",
      agent_ids: agents.map((item) => item.id)
    };

    const routing = scopedRoutingContext({ session, agents, documents, agentWorkspace });
    expect(routing.allowedAdapters).toEqual(["alice_agent", "trusted_catalog_agent"]);
    expect(routing.documents.map((item) => item.document_id)).toEqual(["alice_document"]);

    const composition = buildWorkflowCompositionInput({
      data: {
        agents,
        agentWorkspaces: [agentWorkspace],
        marketplaceRatings: [],
        mcpConnections: []
      },
      session,
      actor: { user_id: "alice", workspace_id: "workspace_a", role: "user" },
      command: {
        command: "workflow",
        mode: "workflow",
        intent: "Use the available agents"
      },
      agentWorkspaceId: agentWorkspace.agent_workspace_id
    });
    expect(composition.candidates.map((item) => item.agent_id)).toEqual([
      "alice_agent",
      "trusted_catalog_agent"
    ]);
  });
});

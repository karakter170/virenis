import { describe, expect, it } from "vitest";

import {
  AGENT_DOCUMENT_SOURCE_ROOT,
  AGENT_SOURCE_ROOT,
  agentDocumentChunkPath,
  agentDocumentIndexPath,
  agentDocumentRoot,
  agentSourcePath,
  agentSourceRoot
} from "../shared/agentRuntimeStateContract.js";
import { isApprovedCitationPath } from "../server/routeResultNormalizer.js";

describe("neutral Agent Runtime state paths", () => {
  it("uses the neutral logical namespace for newly managed documents", () => {
    expect(AGENT_DOCUMENT_SOURCE_ROOT).toBe("sources/agent_documents");
    expect(AGENT_SOURCE_ROOT).toBe("sources/agents");
    expect(agentDocumentRoot("policy_manual")).toBe("sources/agent_documents/policy_manual");
    expect(agentDocumentIndexPath("policy_manual"))
      .toBe("sources/agent_documents/policy_manual/index.jsonl");
    expect(agentDocumentChunkPath("policy_manual", "policy_manual_0001"))
      .toBe("sources/agent_documents/policy_manual/chunks/policy_manual_0001.md");
    expect(agentSourceRoot("analyst")).toBe("sources/agents/analyst");
    expect(agentSourcePath("analyst")).toBe("sources/agents/analyst/source.md");
  });

  it("admits neutral citations and keeps legacy persisted paths in compatibility", () => {
    expect(isApprovedCitationPath(
      "sources/agent_documents/manual/chunks/manual_0001.md",
      ["sources/agent_documents/manual/index.jsonl"]
    )).toBe(true);
    expect(isApprovedCitationPath(
      "sources/agents/analyst/source.md",
      ["sources/agents/analyst/source.md"]
    )).toBe(true);
    expect(isApprovedCitationPath(
      "sources/tcar_documents/manual/chunks/manual_0001.md",
      ["sources/tcar_documents/manual/index.jsonl"]
    )).toBe(true);
    expect(isApprovedCitationPath(
      "sources/agent_documents/manual/../private.md",
      ["sources/agent_documents/manual/index.jsonl"]
    )).toBe(false);
  });
});

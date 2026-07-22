import { describe, expect, it } from "vitest";

import {
  PERSISTED_AGENT_SOURCE_ROOT,
  PERSISTED_DOCUMENT_SOURCE_ROOT,
  PERSISTED_WEB_STORE_TABLE,
  persistedDocumentChunkPath,
  persistedDocumentIndexPath,
  persistedDocumentRoot
} from "../server/persistedStorageCompatibility.js";

describe("persisted storage compatibility", () => {
  it("preserves deployed database and source namespaces exactly", () => {
    expect(PERSISTED_WEB_STORE_TABLE).toBe("tcar_app_store");
    expect(PERSISTED_DOCUMENT_SOURCE_ROOT).toBe("sources/tcar_documents");
    expect(PERSISTED_AGENT_SOURCE_ROOT).toBe("sources/router_agents");
  });

  it("constructs the same durable document paths used by existing records", () => {
    expect(persistedDocumentRoot("policy_manual")).toBe("sources/tcar_documents/policy_manual");
    expect(persistedDocumentIndexPath("policy_manual")).toBe("sources/tcar_documents/policy_manual/index.jsonl");
    expect(persistedDocumentChunkPath("policy_manual", "policy_manual_0001"))
      .toBe("sources/tcar_documents/policy_manual/chunks/policy_manual_0001.md");
  });
});

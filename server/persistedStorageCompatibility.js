// These values are durable namespaces from the original deployment. They are
// compatibility contracts, not descriptions of the current architecture.
// Changing any value requires an explicit, separately reviewed data migration.
export const PERSISTED_DOCUMENT_SOURCE_ROOT = "sources/tcar_documents";
export const PERSISTED_AGENT_SOURCE_ROOT = "sources/router_agents";
export const PERSISTED_WEB_STORE_TABLE = "tcar_app_store";

export function persistedDocumentRoot(slug) {
  return `${PERSISTED_DOCUMENT_SOURCE_ROOT}/${slug}`;
}

export function persistedDocumentIndexPath(slug) {
  return `${persistedDocumentRoot(slug)}/index.jsonl`;
}

export function persistedDocumentChunkPath(slug, chunkId) {
  return `${persistedDocumentRoot(slug)}/chunks/${chunkId}.md`;
}

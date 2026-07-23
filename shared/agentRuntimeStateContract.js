// Logical paths emitted by the neutral Agent Runtime for newly managed state.
// Durable pre-refactor paths remain isolated in persistedStorageCompatibility.js
// and are accepted only through that explicit staged-rollout boundary.
export const AGENT_DOCUMENT_SOURCE_ROOT = "sources/agent_documents";
export const AGENT_SOURCE_ROOT = "sources/agents";

export function agentDocumentRoot(slug) {
  return `${AGENT_DOCUMENT_SOURCE_ROOT}/${slug}`;
}

export function agentDocumentIndexPath(slug) {
  return `${agentDocumentRoot(slug)}/index.jsonl`;
}

export function agentDocumentChunkPath(slug, chunkId) {
  return `${agentDocumentRoot(slug)}/chunks/${chunkId}.md`;
}

export function agentSourceRoot(agentId) {
  return `${AGENT_SOURCE_ROOT}/${agentId}`;
}

export function agentSourcePath(agentId) {
  return `${agentSourceRoot(agentId)}/source.md`;
}

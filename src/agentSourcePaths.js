import { agentSourceRoot } from "../shared/agentRuntimeStateContract.js";
import { PERSISTED_AGENT_SOURCE_ROOT } from "../shared/persistedStorageCompatibility.js";

export function ownedAgentSourcePrefixes(agentId, { allowLegacy = false } = {}) {
  const prefixes = [`${agentSourceRoot(agentId)}/`];
  if (allowLegacy) prefixes.push(`${PERSISTED_AGENT_SOURCE_ROOT}/${agentId}/`);
  return prefixes;
}

export function hasOwnedLegacyAgentSource(agentId, sources) {
  const legacyPrefix = `${PERSISTED_AGENT_SOURCE_ROOT}/${agentId}/`;
  return (sources || []).some((sourcePath) => (
    String(sourcePath || "").replaceAll("\\", "/").startsWith(legacyPrefix)
  ));
}

export function agentSourcePathIsOwned(agentId, sourcePath, { allowLegacy = false } = {}) {
  const normalized = String(sourcePath || "").replaceAll("\\", "/").trim();
  return Boolean(
    normalized
    && !normalized.includes("..")
    && ownedAgentSourcePrefixes(agentId, { allowLegacy }).some((prefix) => normalized.startsWith(prefix))
  );
}

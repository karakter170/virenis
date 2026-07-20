export function isRepairableRuntimeAgentAuditFailure(error) {
  return Number(error?.status) === 502
    && error?.payload?.error === "runtime_agent_audit_invalid";
}

export async function runtimeAuditRepairCandidate(agentId, verifyAudit) {
  try {
    const audit = await verifyAudit(agentId);
    if (audit?.binding_valid !== true) {
      throw new Error(`Runtime audit did not confirm a valid binding for ${agentId}.`);
    }
    return null;
  } catch (error) {
    if (isRepairableRuntimeAgentAuditFailure(error)) return agentId;
    throw error;
  }
}

export function needsAuditedProfileUpdate({ agentId, profileDiffers, auditRepairIds }) {
  return Boolean(profileDiffers || auditRepairIds?.has(agentId));
}

export function needsAuditedArchive({ agentId, enabled, auditRepairIds }) {
  return enabled !== false || Boolean(auditRepairIds?.has(agentId));
}

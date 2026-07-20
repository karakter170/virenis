import { describe, expect, it, vi } from "vitest";

import {
  isRepairableRuntimeAgentAuditFailure,
  needsAuditedArchive,
  needsAuditedProfileUpdate,
  runtimeAuditRepairCandidate
} from "../e2e/runtimeAuditReconciliation.mjs";

describe("pipeline Runtime audit reconciliation", () => {
  it("forces an audited update when the profile already matches but Runtime reports unreceipted drift", async () => {
    const failure = Object.assign(new Error("audit mismatch"), {
      status: 502,
      payload: { error: "runtime_agent_audit_invalid" }
    });
    const verifyAudit = vi.fn().mockRejectedValue(failure);

    const repairId = await runtimeAuditRepairCandidate("financial_analysis", verifyAudit);
    const repairIds = new Set([repairId]);

    expect(repairId).toBe("financial_analysis");
    expect(needsAuditedProfileUpdate({
      agentId: "financial_analysis",
      profileDiffers: false,
      auditRepairIds: repairIds
    })).toBe(true);
  });

  it("does not update an unchanged profile whose Runtime audit is valid", async () => {
    const repairId = await runtimeAuditRepairCandidate(
      "financial_analysis",
      vi.fn().mockResolvedValue({ binding_valid: true })
    );

    expect(repairId).toBeNull();
    expect(needsAuditedProfileUpdate({
      agentId: "financial_analysis",
      profileDiffers: false,
      auditRepairIds: new Set()
    })).toBe(false);
  });

  it("re-archives a disabled agent when its current manifest state lacks a matching receipt", () => {
    expect(needsAuditedArchive({
      agentId: "junk_agent",
      enabled: false,
      auditRepairIds: new Set(["junk_agent"])
    })).toBe(true);
    expect(needsAuditedArchive({
      agentId: "junk_agent",
      enabled: false,
      auditRepairIds: new Set()
    })).toBe(false);
  });

  it("fails closed for missing bindings, Runtime outages, and malformed successful audits", async () => {
    const failures = [
      Object.assign(new Error("missing binding"), {
        status: 409,
        payload: { error: "bad_request" }
      }),
      Object.assign(new Error("runtime unavailable"), {
        status: 502,
        payload: { error: "runtime_unavailable" }
      })
    ];

    for (const failure of failures) {
      expect(isRepairableRuntimeAgentAuditFailure(failure)).toBe(false);
      await expect(runtimeAuditRepairCandidate(
        "financial_analysis",
        vi.fn().mockRejectedValue(failure)
      )).rejects.toBe(failure);
    }

    await expect(runtimeAuditRepairCandidate(
      "financial_analysis",
      vi.fn().mockResolvedValue({ binding_valid: false })
    )).rejects.toThrow(/did not confirm a valid binding/);
  });
});

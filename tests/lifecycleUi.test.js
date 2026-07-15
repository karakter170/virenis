import { describe, expect, it } from "vitest";
import {
  canManageDocument,
  missingOutcomeContractIds,
  outcomeLifecycleState,
  realityRankHistory,
  realityRankSummary,
  realityRankTieBreak,
  shortRevision
} from "../src/lifecycleUi.js";

describe("resource lifecycle UI helpers", () => {
  it("presents the current rank, status, and verified sample count without inflating evidence", () => {
    expect(realityRankSummary({ score: 72.5, sample_size: 3, status: "established" })).toEqual({
      score: 72.5,
      score_label: "72.5",
      samples: 3,
      sample_label: "3 verified results",
      status: "established",
      status_label: "Established"
    });
    expect(realityRankSummary({ score: null, sample_size: -4 })).toMatchObject({
      score: 50,
      samples: 0,
      sample_label: "0 verified results",
      status: "provisional"
    });
  });

  it("keeps the current revision first and deduplicates revision history", () => {
    const current = `sha256:${"a".repeat(64)}`;
    const historical = `sha256:${"b".repeat(64)}`;
    const history = realityRankHistory({
      agent_revision: current,
      score: 50,
      sample_size: 0,
      versions: [
        { agent_revision: historical, score: 81.25, sample_size: 4 },
        { agent_revision: current, score: 49, sample_size: 9 }
      ]
    });
    expect(history).toEqual([
      { agent_revision: current, score: 50, sample_size: 0, current: true },
      { agent_revision: historical, score: 81.25, sample_size: 4, current: false }
    ]);
    expect(shortRevision(historical)).toBe("bbbbbbbb");
  });

  it("shows document deletion only to an admin or the private document-agent owner", () => {
    const document = { document_id: "doc_1", agent_id: "doc_agent" };
    const agent = {
      id: "doc_agent",
      visibility: "private",
      workspace_id: "workspace_a",
      created_by: "alice",
      runtime_only: false
    };
    expect(canManageDocument(document, [agent], {
      user_id: "alice",
      workspace_id: "workspace_a",
      is_admin: false,
      is_viewer: false
    })).toBe(true);
    expect(canManageDocument(document, [agent], {
      user_id: "bob",
      workspace_id: "workspace_a",
      is_admin: false,
      is_viewer: false
    })).toBe(false);
    expect(canManageDocument(document, [{ ...agent, visibility: "team" }], {
      user_id: "alice",
      workspace_id: "workspace_a",
      is_admin: false,
      is_viewer: false
    })).toBe(false);
    expect(canManageDocument(document, [], { is_admin: true, is_viewer: false })).toBe(true);
  });
});

describe("routing and outcome lifecycle UI helpers", () => {
  it("hydrates outcome details only on demand and skips contracts already in memory", () => {
    const run = {
      outcome_contracts: [
        { contract_id: "contract_a" },
        { contract_id: "contract_b" },
        { contract_id: "contract_a" },
        {},
        null
      ]
    };
    expect(missingOutcomeContractIds(run, { contract_a: { status: "pending" } })).toEqual(["contract_b"]);
    expect(missingOutcomeContractIds(run, {
      contract_a: { status: "pending" },
      contract_b: { status: "settled" }
    })).toEqual([]);
  });

  it("explains only an actual RealityRank capability tie-break and preserves its comparison set", () => {
    const routing = {
      selected: [{
        adapter: "ranked_agent",
        source: "cue+reality_rank",
        reality_rank: 0.78,
        reason: "Settled outcomes broke an equally relevant tie."
      }],
      candidate_trace: [
        { adapter: "ranked_agent", cue_score: 8, reality_rank: 0.78, rank_sample_size: 5 },
        { adapter: "peer_agent", cue_score: 8, reality_rank: 0.42, rank_sample_size: 4 },
        { adapter: "different_match", cue_score: 4, reality_rank: 0.99, rank_sample_size: 10 }
      ]
    };
    expect(realityRankTieBreak(routing, "ranked_agent")).toEqual({
      reason: "Settled outcomes broke an equally relevant tie.",
      cue_score: 8,
      reality_rank: 0.78,
      sample_size: 5,
      tied_candidates: [{ adapter: "peer_agent", reality_rank: 0.42, sample_size: 4 }]
    });
    expect(realityRankTieBreak({ ...routing, selected: [{ adapter: "ranked_agent", source: "explicit" }] }, "ranked_agent")).toBeNull();
  });

  it("enforces due-time and status constraints for every outcome action", () => {
    const dueAt = "2026-07-10T12:00:00.000Z";
    const before = Date.parse("2026-07-10T11:59:59.999Z");
    const atDue = Date.parse(dueAt);
    expect(outcomeLifecycleState({ status: "pending", due_at: dueAt }, true, before)).toEqual({
      due: false,
      can_settle: false,
      can_dispute: false,
      can_correct: false
    });
    expect(outcomeLifecycleState({ status: "pending", due_at: dueAt }, true, atDue).can_settle).toBe(true);
    expect(outcomeLifecycleState({ status: "settled", due_at: dueAt }, true, atDue)).toMatchObject({
      can_settle: false,
      can_dispute: true,
      can_correct: true
    });
    expect(outcomeLifecycleState({ status: "disputed", due_at: dueAt }, true, atDue)).toMatchObject({
      can_dispute: false,
      can_correct: true
    });
    expect(outcomeLifecycleState({ status: "settled", due_at: dueAt }, false, atDue).can_correct).toBe(false);
  });
});

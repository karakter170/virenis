function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function boundedRankScore(value, fallback = 50) {
  const score = finiteNumber(value);
  return score !== null && score >= 0 && score <= 100 ? score : fallback;
}

function sampleCount(value) {
  const count = finiteNumber(value);
  return count !== null && count > 0 ? Math.trunc(count) : 0;
}

export function realityRankSummary(rank = {}) {
  const score = boundedRankScore(rank?.score);
  const samples = sampleCount(rank?.sample_size);
  const established = rank?.status === "established" || samples >= 3;
  return {
    score,
    score_label: Number.isInteger(score) ? String(score) : String(Number(score.toFixed(2))),
    samples,
    sample_label: `${samples} verified ${samples === 1 ? "result" : "results"}`,
    status: established ? "established" : "provisional",
    status_label: established ? "Established" : "Provisional"
  };
}

export function realityRankHistory(rank = {}) {
  const currentRevision = String(rank?.agent_revision || "");
  const entries = [{
    agent_revision: currentRevision,
    score: boundedRankScore(rank?.score),
    sample_size: sampleCount(rank?.sample_size),
    current: true
  }];
  for (const version of Array.isArray(rank?.versions) ? rank.versions : []) {
    const revision = String(version?.agent_revision || "");
    if (!revision || entries.some((entry) => entry.agent_revision === revision)) continue;
    entries.push({
      agent_revision: revision,
      score: boundedRankScore(version?.score),
      sample_size: sampleCount(version?.sample_size),
      current: revision === currentRevision
    });
  }
  return entries.sort((left, right) => Number(right.current) - Number(left.current)
    || right.sample_size - left.sample_size
    || left.agent_revision.localeCompare(right.agent_revision));
}

export function shortRevision(value) {
  const revision = String(value || "");
  const digest = revision.replace(/^sha256:/, "");
  return digest ? digest.slice(0, 8) : "unversioned";
}

export function canManageDocument(document, agents, auth) {
  if (!auth || auth.is_viewer) return false;
  if (auth.is_admin) return true;
  const agent = (Array.isArray(agents) ? agents : []).find((item) => item.id === document?.agent_id);
  return Boolean(agent
    && agent.runtime_only !== true
    && agent.visibility === "private"
    && agent.created_by === auth.user_id
    && String(agent.workspace_id || "") === String(auth.workspace_id || ""));
}

export function realityRankTieBreak(routing, adapter) {
  const selected = (Array.isArray(routing?.selected) ? routing.selected : [])
    .find((item) => item?.adapter === adapter);
  if (selected?.source !== "cue+reality_rank") return null;

  const candidates = Array.isArray(routing?.candidate_trace) ? routing.candidate_trace : [];
  const selectedCandidate = candidates.find((candidate) => candidate?.adapter === adapter) || {};
  const cueScore = finiteNumber(selectedCandidate.cue_score);
  const selectedRank = finiteNumber(selected.reality_rank) ?? finiteNumber(selectedCandidate.reality_rank) ?? 0.5;
  const selectedSamples = sampleCount(selectedCandidate.rank_sample_size);
  const tied = cueScore === null ? [] : candidates
    .filter((candidate) => candidate?.adapter && candidate.adapter !== adapter)
    .filter((candidate) => finiteNumber(candidate.cue_score) === cueScore)
    .map((candidate) => ({
      adapter: candidate.adapter,
      reality_rank: finiteNumber(candidate.reality_rank) ?? 0.5,
      sample_size: sampleCount(candidate.rank_sample_size)
    }))
    .sort((left, right) => right.reality_rank - left.reality_rank || left.adapter.localeCompare(right.adapter));

  return {
    reason: String(selected.reason || "Settled outcomes broke an equally relevant capability tie."),
    cue_score: cueScore,
    reality_rank: Math.max(0, Math.min(selectedRank, 1)),
    sample_size: selectedSamples,
    tied_candidates: tied
  };
}

export function outcomeLifecycleState(contract, canWrite, now = Date.now()) {
  const dueAt = Date.parse(String(contract?.resolution?.due_at || contract?.due_at || ""));
  const observedAt = now instanceof Date ? now.getTime() : Number(now);
  const due = Number.isFinite(dueAt) && Number.isFinite(observedAt) && observedAt >= dueAt;
  const status = String(contract?.status || "pending");
  return {
    due,
    can_settle: Boolean(canWrite && status === "pending" && due),
    can_dispute: Boolean(canWrite && status === "settled" && due),
    can_correct: Boolean(canWrite && (status === "settled" || status === "disputed") && due)
  };
}

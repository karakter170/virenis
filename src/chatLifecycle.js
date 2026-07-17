export const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "cancelled"]);

export const WORKFLOW_POLL_DEADLINE_MS = 45_000;
export const WORKFLOW_POLL_DELAYS_MS = [750, 1_250, 2_000, 3_500, 5_000, 7_500];
export const SSE_RECOVERY_MAX_ATTEMPTS = 4;

export function isTerminalRunStatus(status) {
  return TERMINAL_RUN_STATUSES.has(String(status || ""));
}

export function runIsActiveForSession(run, sessionId) {
  if (!run || !sessionId || isTerminalRunStatus(run.status)) return false;
  return !run.session_id || String(run.session_id) === String(sessionId);
}

export function shouldApplySessionResponse({
  requestId,
  latestRequestId,
  targetSessionId,
  desiredSessionId
}) {
  if (requestId !== latestRequestId) return false;
  if (desiredSessionId && String(targetSessionId) !== String(desiredSessionId)) return false;
  return true;
}

export function shouldRefreshOriginSession(originSessionId, displayedSessionId, desiredSessionId = displayedSessionId) {
  if (!originSessionId || !displayedSessionId) return false;
  return String(originSessionId) === String(displayedSessionId)
    && (!desiredSessionId || String(originSessionId) === String(desiredSessionId));
}

export function workflowPollDelay(attempt) {
  const index = Math.max(0, Math.min(WORKFLOW_POLL_DELAYS_MS.length - 1, Number(attempt) || 0));
  return WORKFLOW_POLL_DELAYS_MS[index];
}

export function sseRecoveryDelay(attempt) {
  const normalized = Math.max(1, Number(attempt) || 1);
  return Math.min(4_000, 400 * (2 ** (normalized - 1)));
}

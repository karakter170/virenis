export function activeSessionViewReady(expectedSessionId) {
  const appShell = document.querySelector(".app-shell");
  return appShell?.getAttribute("data-active-session-id") === String(expectedSessionId || "")
    && document.querySelectorAll(".message").length === 0;
}

export function assertRunSession(expectedSessionId, actualSessionId) {
  const expected = String(expectedSessionId || "");
  const actual = String(actualSessionId || "");
  if (!expected || actual !== expected) {
    throw new Error(`Run/session mismatch: created ${expected || "none"}, received ${actual || "none"}.`);
  }
}

import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { Composer, WorkspaceLoadFailure, preserveAmbiguousChatSubmission, request } from "../src/App.jsx";
import {
  SSE_RECOVERY_MAX_ATTEMPTS,
  isTerminalRunStatus,
  refreshedSessionsPreservingCurrent,
  runIsActiveForSession,
  shouldApplySessionResponse,
  shouldRefreshOriginSession,
  sseRecoveryDelay,
  workflowPollDelay
} from "../src/chatLifecycle.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("chat lifecycle safety", () => {
  it("reuses an ambiguous retry key only for the exact same chat operation", () => {
    const first = {
      content: "Retry this answer",
      sessionId: "chat_a",
      routingKey: "selective:run_a",
      idempotencyKey: "message_first_key"
    };
    const repeated = {
      ...first,
      idempotencyKey: "message_new_key"
    };
    expect(preserveAmbiguousChatSubmission(first, repeated)).toBe(first);
    expect(preserveAmbiguousChatSubmission(first, {
      ...repeated,
      routingKey: "fresh:run_a"
    })).not.toBe(first);
  });

  it("only treats a non-terminal run from the displayed chat as active", () => {
    expect(runIsActiveForSession({ status: "running", session_id: "chat_a" }, "chat_a")).toBe(true);
    expect(runIsActiveForSession({ status: "running", session_id: "chat_a" }, "chat_b")).toBe(false);
    expect(runIsActiveForSession({ status: "completed", session_id: "chat_a" }, "chat_a")).toBe(false);
    expect(runIsActiveForSession({ status: "failed", session_id: "chat_a" }, "chat_a")).toBe(false);
    expect(runIsActiveForSession({ status: "cancelled", session_id: "chat_a" }, "chat_a")).toBe(false);
    expect(isTerminalRunStatus("completed")).toBe(true);
    expect(isTerminalRunStatus("cancelled")).toBe(true);
  });

  it("rejects stale chat responses and background refreshes after navigation", () => {
    expect(shouldApplySessionResponse({
      requestId: 4,
      latestRequestId: 5,
      targetSessionId: "chat_old",
      desiredSessionId: "chat_new"
    })).toBe(false);
    expect(shouldApplySessionResponse({
      requestId: 5,
      latestRequestId: 5,
      targetSessionId: "chat_old",
      desiredSessionId: "chat_new"
    })).toBe(false);
    expect(shouldApplySessionResponse({
      requestId: 5,
      latestRequestId: 5,
      targetSessionId: "chat_new",
      desiredSessionId: "chat_new"
    })).toBe(true);
    expect(shouldRefreshOriginSession("chat_old", "chat_new", "chat_new")).toBe(false);
    expect(shouldRefreshOriginSession("chat_old", "chat_old", "chat_new")).toBe(false);
    expect(shouldRefreshOriginSession("chat_new", "chat_new", "chat_new")).toBe(true);
  });

  it("does not let a stale session-list refresh drop the newly opened chat", () => {
    const created = { session_id: "chat_new", title: "New chat" };
    const old = { session_id: "chat_old", title: "Old chat" };
    expect(refreshedSessionsPreservingCurrent([old], [created, old], "chat_new"))
      .toEqual([created, old]);
    expect(refreshedSessionsPreservingCurrent([created, old], [old], "chat_new"))
      .toEqual([created, old]);
    expect(refreshedSessionsPreservingCurrent([old], [old], "chat_missing"))
      .toEqual([old]);
  });

  it("uses bounded backoff for workflow and live-run recovery checks", () => {
    expect(workflowPollDelay(0)).toBe(750);
    expect(workflowPollDelay(100)).toBe(7_500);
    expect(sseRecoveryDelay(1)).toBe(400);
    expect(sseRecoveryDelay(SSE_RECOVERY_MAX_ATTEMPTS)).toBe(3_200);
    expect(sseRecoveryDelay(100)).toBe(4_000);
  });

  it("aborts a stalled client request with a truthful timeout error", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn((_path, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      });
    })));

    const pending = request("/api/slow", { timeoutMs: 25 });
    const assertion = expect(pending).rejects.toMatchObject({
      code: "client_request_timeout",
      message: "The request timed out. Check your connection and try again."
    });
    await vi.advanceTimersByTimeAsync(30);
    await assertion;
  });

  it("keeps drafting available while preventing a second send or team mutation", () => {
    const markup = renderToStaticMarkup(createElement(Composer, {
      value: "A second request",
      onChange: () => undefined,
      onSubmit: () => undefined,
      onAttachFile: () => undefined,
      chatDocuments: [],
      onDeleteChatDocument: () => undefined,
      agents: [{ id: "writer", title: "Writer", session_active: true }],
      allAgents: [{ id: "writer", title: "Writer", session_active: true }],
      workspaces: [{ agent_workspace_id: "team_a", name: "Team A", agent_ids: ["writer"] }],
      activeWorkspace: { agent_workspace_id: "team_a", name: "Team A", agent_ids: ["writer"] },
      sessionId: "chat_a",
      canWrite: true,
      sendBlocked: true,
      configurationBusy: true,
      onOpenAgents: () => undefined,
      onSelectWorkspace: () => undefined,
      onToggleAgent: () => undefined,
      togglingAgentId: ""
    }));

    const textarea = markup.match(/<textarea[^>]*>/)?.[0] || "";
    const sendButton = markup.match(/<button[^>]*aria-label="Wait for the current operation to finish"[^>]*>/)?.[0] || "";
    expect(markup).toContain('aria-busy="true"');
    expect(textarea).not.toContain("disabled");
    expect(sendButton).toContain("disabled");
    expect(markup).toContain('aria-label="Team A: 1 specialist available. Choose team and specialists."');
  });

  it("renders a fatal bootstrap failure as retryable instead of an empty workspace", () => {
    const markup = renderToStaticMarkup(createElement(WorkspaceLoadFailure, {
      message: "The request timed out.",
      onRetry: () => undefined
    }));
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("We couldn’t open your workspace");
    expect(markup).toContain("The request timed out.");
    expect(markup).toContain("Retry");
    expect(markup).toContain("Your chats were not changed");
  });
});

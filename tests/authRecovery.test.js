import { describe, expect, it } from "vitest";
import {
  AUTHENTICATION_REQUIRED_EVENT,
  authenticationFailureDetails,
  notifyAuthenticationRequired,
  resetAuthenticationNotification,
  shouldOpenWorkspaceFromIdentity
} from "../src/authRecovery.js";
import { loadAuthenticatedResourceBatch } from "../src/workspaceBootstrap.js";

describe("authentication recovery", () => {
  it("holds a Clerk-signed-in user on recovery instead of redirecting back to the failing workspace", () => {
    expect(shouldOpenWorkspaceFromIdentity({ isSignedIn: true, authenticationFailure: null })).toBe(true);
    expect(shouldOpenWorkspaceFromIdentity({
      isSignedIn: true,
      authenticationFailure: authenticationFailureDetails({ status: 401 })
    })).toBe(false);
    expect(shouldOpenWorkspaceFromIdentity({ isSignedIn: false, authenticationFailure: null })).toBe(false);
  });

  it("turns an authorized-party rejection into actionable, non-secret recovery guidance", () => {
    const failure = authenticationFailureDetails({
      status: 401,
      code: "authentication_required",
      authReason: "token-invalid-authorized-parties",
      requestId: "req_auth_test",
      details: { configured_origin: "https://app.example.test" }
    }, "https://preview.example.test");
    expect(failure).toMatchObject({
      status: 401,
      reason: "token-invalid-authorized-parties",
      request_id: "req_auth_test",
      origin: "https://preview.example.test",
      configured_origin: "https://app.example.test",
      title: "This site address is not authorized"
    });
    expect(failure.message).toContain("https://app.example.test");
  });

  it("coalesces a burst of parallel 401 responses into one route transition", () => {
    resetAuthenticationNotification();
    const events = [];
    class FakeCustomEvent {
      constructor(type, options) {
        this.type = type;
        this.detail = options.detail;
      }
    }
    const fakeWindow = {
      CustomEvent: FakeCustomEvent,
      location: { origin: "http://localhost:5173" },
      dispatchEvent(event) { events.push(event); }
    };
    expect(notifyAuthenticationRequired({ status: 401 }, fakeWindow)).toBe(true);
    expect(notifyAuthenticationRequired({ status: 401 }, fakeWindow)).toBe(false);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe(AUTHENTICATION_REQUIRED_EVENT);
    resetAuthenticationNotification();
    expect(notifyAuthenticationRequired({ status: 401 }, fakeWindow)).toBe(true);
    expect(events).toHaveLength(2);
    resetAuthenticationNotification();
  });
});

describe("authenticated workspace bootstrap", () => {
  it("does not fan out resource requests until the server session is verified", async () => {
    const calls = [];
    const unauthorized = Object.assign(new Error("Sign in to continue."), { status: 401 });
    const api = {
      async get(path) {
        calls.push(path);
        if (path === "/api/auth/me") throw unauthorized;
        return {};
      }
    };
    await expect(loadAuthenticatedResourceBatch(api, ["/api/chat/sessions", "/api/agents"])).rejects.toBe(unauthorized);
    expect(calls).toEqual(["/api/auth/me"]);
  });

  it("loads independent workspace resources in parallel after authentication succeeds", async () => {
    const calls = [];
    const api = {
      async get(path) {
        calls.push(path);
        if (path === "/api/auth/me") return { user_id: "user_test" };
        if (path === "/api/optional") throw new Error("optional unavailable");
        return { path };
      }
    };
    const result = await loadAuthenticatedResourceBatch(api, ["/api/chat/sessions", "/api/optional"]);
    expect(result.identity.user_id).toBe("user_test");
    expect(result.resources.map((item) => item.status)).toEqual(["fulfilled", "rejected"]);
    expect(calls).toEqual(["/api/auth/me", "/api/chat/sessions", "/api/optional"]);
  });
});

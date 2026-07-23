import { describe, expect, it, vi } from "vitest";

import {
  createClerkTestTicket,
  revokeClerkTestSession
} from "../scripts/clerkTestSession.mjs";

describe("Clerk live-test session safety", () => {
  it("rejects secret-key use without an explicit test user", async () => {
    await expect(createClerkTestTicket({
      secretKey: "sk_test_placeholder",
      userId: "",
      userIdVariable: "MARKETING_UI_CLERK_USER_ID"
    })).rejects.toThrow(/arbitrary-user fallback is forbidden/);
  });

  it("revokes both the created session and its sign-in token", async () => {
    const revokeSession = vi.fn().mockResolvedValue({});
    const revokeSignInToken = vi.fn().mockResolvedValue({});
    await revokeClerkTestSession({
      client: {
        sessions: { revokeSession },
        signInTokens: { revokeSignInToken }
      },
      sessionId: "sess_test_owned",
      signInTokenId: "sit_test_owned"
    });
    expect(revokeSession).toHaveBeenCalledExactlyOnceWith("sess_test_owned");
    expect(revokeSignInToken).toHaveBeenCalledExactlyOnceWith("sit_test_owned");
  });

  it("fails closed when the owned session cannot be revoked", async () => {
    await expect(revokeClerkTestSession({
      client: {
        sessions: { revokeSession: vi.fn().mockRejectedValue(new Error("denied")) },
        signInTokens: { revokeSignInToken: vi.fn().mockResolvedValue({}) }
      },
      sessionId: "sess_test_owned",
      signInTokenId: "sit_test_owned"
    })).rejects.toThrow(/session sess_test_owned: denied/);
  });
});

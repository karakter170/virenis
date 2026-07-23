/* global window */

import { createClerkClient } from "@clerk/backend";

export async function createClerkTestTicket({ secretKey, userId, userIdVariable }) {
  if (!secretKey) return null;
  if (!String(userId || "").trim()) {
    throw new Error(`${userIdVariable} is required when CLERK_SECRET_KEY is configured; arbitrary-user fallback is forbidden.`);
  }
  const client = createClerkClient({ secretKey });
  const signInToken = await client.signInTokens.createSignInToken({
    userId: String(userId).trim(),
    expiresInSeconds: 300
  });
  return {
    client,
    signInTokenId: signInToken.id,
    ticket: signInToken.token
  };
}

export async function activateClerkTestTicket(page, ticket) {
  await page.waitForFunction(() => Boolean(
    window.Clerk?.client?.signIn?.create && window.Clerk?.setActive
  ), null, { timeout: 60_000 });
  const activation = await page.evaluate(async (signInTicket) => {
    let sessionId = "";
    try {
      const signIn = await window.Clerk.client.signIn.create({
        strategy: "ticket",
        ticket: signInTicket
      });
      if (signIn.status !== "complete" || !signIn.createdSessionId) {
        return { ok: false, status: signIn.status || "unknown" };
      }
      sessionId = signIn.createdSessionId;
      await window.Clerk.setActive({ session: sessionId });
      return { ok: true, sessionId };
    } catch (error) {
      return {
        ok: false,
        sessionId,
        error: String(
          error?.errors?.[0]?.longMessage
          || error?.message
          || "ticket activation failed"
        )
      };
    }
  }, ticket);
  if (!activation.ok || !activation.sessionId) {
    const error = new Error(`Clerk test-ticket activation failed: ${activation.error || activation.status}`);
    error.clerkSessionId = activation.sessionId || "";
    throw error;
  }
  return activation.sessionId;
}

export async function revokeClerkTestSession({ client, sessionId, signInTokenId }) {
  const failures = [];
  if (client && sessionId) {
    try {
      await client.sessions.revokeSession(sessionId);
    } catch (error) {
      failures.push(`session ${sessionId}: ${error.message}`);
    }
  }
  if (client && signInTokenId) {
    try {
      await client.signInTokens.revokeSignInToken(signInTokenId);
    } catch (error) {
      failures.push(`sign-in token ${signInTokenId}: ${error.message}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`Clerk test identity cleanup failed: ${failures.join("; ")}`);
  }
}

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ClerkProvider } from "@clerk/react";
import { buildPublishableKey } from "@clerk/shared/keys";
import { describe, expect, it } from "vitest";
import { AccountPanel, AdminUsersPanel, IdentityPage } from "../src/IdentityPage.jsx";

const publishableKey = buildPublishableKey("happy-clerk-13.clerk.accounts.dev");

function renderWithClerk(component) {
  return renderToStaticMarkup(
    React.createElement(ClerkProvider, { publishableKey }, component)
  );
}

describe("Clerk identity UI", () => {
  it("renders branded Clerk sign-in and sign-up surfaces", () => {
    const signIn = renderWithClerk(
      React.createElement(IdentityPage, { mode: "login", onHome: () => undefined })
    );
    const signUp = renderWithClerk(
      React.createElement(IdentityPage, { mode: "register", onHome: () => undefined })
    );
    expect(signIn).toContain("Continue where your agents left off");
    expect(signIn).toContain("Private by default");
    expect(signIn).toContain("Verified identity powered by Clerk");
    expect(signUp).toContain("Build your own team of agents");
    expect(signUp).toContain("clerk-identity-card");
  });

  it("keeps product export and deletion controls beside Clerk-managed security", () => {
    const markup = renderWithClerk(
      React.createElement(AccountPanel, {
        auth: {
          user_id: "user_alice",
          workspace_id: "workspace_alice",
          display_name: "Alice",
          email: "alice@example.com",
          email_verified: true,
          role: "user",
          auth_type: "clerk"
        },
        billing: {
          account: {
            balance_credits: "87.5",
            reserved_credits: "1.25",
            lifetime_debited_credits: "12.5",
            recent_entries: [{
              entry_id: "ledger_usage_1",
              type: "usage_settlement",
              available_delta_micros: -250000,
              available_delta_credits: "-0.25",
              debited_micros: 400000,
              debited_credits: "0.4",
              created_at: "2026-07-15T08:00:00.000Z"
            }]
          }
        },
        onSignedOut: () => undefined
      })
    );
    expect(markup).toContain("Identity &amp; security");
    expect(markup).toContain("Open account settings");
    expect(markup).toContain("Export account data");
    expect(markup).toContain("Delete account permanently");
    expect(markup).toContain("Type DELETE to confirm");
    expect(markup).toContain("Credit balance");
    expect(markup).toContain("87.5 credits");
    expect(markup).toContain("1.25 credits");
    expect(markup).toContain("Token usage");
    expect(markup).toContain("0.4 credits used");
    expect(markup).toContain("0.25 credits over reserve");
    expect(markup).not.toContain("Current password");
  });

  it("renders Clerk-aware administrator controls without manual verification", () => {
    const markup = renderToStaticMarkup(React.createElement(AdminUsersPanel));
    expect(markup).toContain("Registered users");
    expect(markup).toContain("Assign product roles");
    expect(markup).toContain("Clerk manages identity verification");
    expect(markup).toContain("No Clerk users have signed up yet");
    expect(markup).toContain("Token pricing");
    expect(markup).toContain("Save pricing");
    expect(markup).not.toContain(">Verify<");
  });
});

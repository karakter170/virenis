import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AccountPanel, AdminUsersPanel, IdentityPage } from "../src/IdentityPage.jsx";

describe("identity UI", () => {
  it("renders accessible sign-in and account recovery entry points", () => {
    const markup = renderToStaticMarkup(
      React.createElement(IdentityPage, {
        mode: "login",
        onNavigate: () => undefined,
        onAuthenticated: () => undefined,
        onHome: () => undefined
      })
    );
    expect(markup).toContain("Continue where your agents left off");
    expect(markup).toContain("Private by default");
    expect(markup).toContain("Loading account access");
  });

  it("renders browser account security, export, and deletion controls", () => {
    const markup = renderToStaticMarkup(
      React.createElement(AccountPanel, {
        auth: {
          user_id: "usr_alice",
          workspace_id: "workspace_alice",
          display_name: "Alice",
          email: "alice@example.com",
          email_verified: true,
          role: "user",
          auth_type: "session"
        },
        onSignedOut: () => undefined
      })
    );
    expect(markup).toContain("Browser sessions");
    expect(markup).toContain("Change password");
    expect(markup).toContain("Export account data");
    expect(markup).toContain("Delete account permanently");
    expect(markup).toContain("Type DELETE to confirm");
  });

  it("renders the administrator user-control surface", () => {
    const markup = renderToStaticMarkup(React.createElement(AdminUsersPanel));
    expect(markup).toContain("Registered users");
    expect(markup).toContain("Suspend access");
    expect(markup).toContain("No self-service users have registered");
  });
});

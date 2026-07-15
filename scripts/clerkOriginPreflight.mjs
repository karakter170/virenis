#!/usr/bin/env node
/* global console, process, URL */
import {
  clerkAuthorizedParties,
  clerkIdentityEnabled,
  clerkPublishableKey,
  requireAuthorizedClerkBrowserOrigin,
  validateClerkEnvironment
} from "../server/clerkIdentity.js";

const requestedOrigin = String(process.argv[2] || process.env.APP_PUBLIC_ORIGIN || "").trim();

if (!clerkIdentityEnabled()) {
  throw new Error("Clerk identity is not configured in this environment.");
}
if (!requestedOrigin) {
  throw new Error("Pass the public browser origin, for example: npm run preflight:auth -- https://app.example.com");
}

validateClerkEnvironment(process.env);
const browserOrigin = requireAuthorizedClerkBrowserOrigin(requestedOrigin, process.env);
const publicOrigin = String(process.env.APP_PUBLIC_ORIGIN || "").trim().replace(/\/+$/, "");
const oauthOrigin = String(process.env.APP_MCP_OAUTH_REDIRECT_ORIGIN || "").trim().replace(/\/+$/, "");
if (!publicOrigin || browserOrigin !== publicOrigin) {
  throw new Error("The tested browser origin must exactly match APP_PUBLIC_ORIGIN.");
}
if (process.env.NODE_ENV === "production" && new URL(browserOrigin).protocol !== "https:") {
  throw new Error("A production Clerk browser origin must use HTTPS.");
}
if (oauthOrigin && publicOrigin && oauthOrigin !== publicOrigin) {
  throw new Error("APP_MCP_OAUTH_REDIRECT_ORIGIN must match APP_PUBLIC_ORIGIN.");
}

const publishableKey = clerkPublishableKey(process.env);
console.log(JSON.stringify({
  ok: true,
  identity_provider: "clerk",
  environment: process.env.NODE_ENV === "production" ? "production" : "development",
  browser_origin: browserOrigin,
  public_origin: publicOrigin || null,
  authorized_parties: clerkAuthorizedParties(process.env),
  clerk_key_mode: publishableKey.startsWith("pk_live_") ? "production" : "development",
  mcp_oauth_origin_matches: !oauthOrigin || oauthOrigin === publicOrigin
}, null, 2));

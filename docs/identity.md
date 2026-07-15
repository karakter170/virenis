# Clerk identity and private workspaces

Virenis uses Clerk for public identity and keeps authorization and product data
inside Virenis. Every Clerk user receives one stable, private Virenis workspace.
This design deliberately does not create organizations, invitations, shared
workspace membership, or organization switching.

This identity workspace is the tenant/security boundary (`workspace_id`). Agent
Studio teams are a separate nested concept identified by `agent_workspace_id`;
see [Agent workspaces](agent-workspaces.md).

## Responsibility boundary

Clerk owns:

- sign-up, sign-in, email verification, password recovery, and social login;
- browser sessions, multi-factor authentication, and account security;
- the canonical identity profile and account suspension state.

Virenis owns:

- the stable `clerk_user_id` to `user_id` and `workspace_id` link;
- product roles (`admin`, `user`, and `viewer`);
- agents, conversations, workflows, documents, Marketplace identity, and MCP
  connections scoped to that private workspace;
- product-data export and cascading workspace deletion.

The browser never receives `CLERK_SECRET_KEY`. It receives only
`VITE_CLERK_PUBLISHABLE_KEY`. The Express backend verifies Clerk cookies or
session tokens with `@clerk/express`, then converts the verified Clerk identity
to Virenis's internal actor before any product route runs.

## Provisioning and synchronization

The first authenticated request provisions the user synchronously, so a new
account can open `/app` without waiting for a webhook. Virenis then preserves
the generated private workspace ID across profile changes and future sessions.
During migration, a Clerk account whose verified primary email matches a
retired first-party Virenis profile is linked to that existing `user_id` and
`workspace_id`; its agents and history therefore remain in place. Email matches
already linked to a different Clerk user fail closed.

Configure a signed Clerk webhook at:

```text
POST https://your-public-origin.example/api/webhooks/clerk
```

Subscribe to:

- `user.created`
- `user.updated`
- `user.deleted`

The webhook keeps display name, primary email, avatar, verification status, and
suspension status current. `user.deleted` cascades deletion through the user's
local agents, documents, chats, workflows, Marketplace records, MCP credentials,
and local document files. Signatures are verified before an event is accepted.
Synchronous provisioning remains the availability path; webhooks are the
lifecycle synchronization path.

## Configuration

Local development uses `.env.local`, which is created by `clerk init` and is
not committed. Production needs the following settings:

```dotenv
APP_IDENTITY_PROVIDER=clerk
VITE_CLERK_PUBLISHABLE_KEY=pk_live_replace
CLERK_PUBLISHABLE_KEY=pk_live_replace
CLERK_SECRET_KEY=
CLERK_SECRET_KEY_FILE=/run/secrets/clerk_secret_key
CLERK_WEBHOOK_SIGNING_SECRET=
CLERK_WEBHOOK_SIGNING_SECRET_FILE=/run/secrets/clerk_webhook_signing_secret
CLERK_AUTHORIZED_PARTIES=https://app.your-domain.example
APP_PUBLIC_ORIGIN=https://app.your-domain.example
APP_AUTH_ADMIN_EMAILS=admin@your-domain.example
APP_CLERK_ADMIN_USER_IDS=
```

`CLERK_PUBLISHABLE_KEY` may be omitted when
`VITE_CLERK_PUBLISHABLE_KEY` is present; defining both explicitly is clearer in
split build/runtime environments. For secrets, an inline value takes precedence
over its `_FILE` variant. Keep secret files readable only by the web service.
When both publishable-key variables are defined, they must be identical. The
frontend key is embedded at build time, so hosted builds must be created with
the same environment used by the backend.

Production startup fails closed when Clerk keys are missing, malformed, or
development keys; the webhook signing secret is missing; the public origin is
not authorized; or no initial administrator is configured. Use
`APP_AUTH_ADMIN_EMAILS` before the first administrator signs in, or pin a Clerk
user ID with `APP_CLERK_ADMIN_USER_IDS`. This bootstrap allowlist does not turn
email into a session credential: Clerk must still authenticate the account.

## Hosted sign-in troubleshooting

`Your session could not be verified` for every account is a deployment problem,
not a user-role problem. If the recovery screen reports that the site address
is not authorized, the Clerk token's `azp` origin does not match the backend's
authorized parties. An administrator email cannot bypass this check.

Choose one canonical HTTPS origin, with no path or trailing slash, and use it
consistently on the web host. For example:

```dotenv
NODE_ENV=production
APP_PUBLIC_ORIGIN=https://app.your-domain.example
CLERK_AUTHORIZED_PARTIES=https://app.your-domain.example
APP_MCP_OAUTH_REDIRECT_ORIGIN=https://app.your-domain.example
VITE_CLERK_PUBLISHABLE_KEY=pk_live_same-production-application
CLERK_PUBLISHABLE_KEY=pk_live_same-production-application
APP_AUTH_ADMIN_EMAILS=meteyesil@virenis.com
```

Use the matching `sk_live_` backend key and webhook signing secret from the same
Clerk production application. Configure that production application's domain
and DNS in Clerk, then build and start from the remote environment:

```bash
cp .env.remote.example .env.remote.local
npm run preflight:auth:remote -- https://app.your-domain.example
npm run build:remote
npm run preflight:remote
npm run start:remote
```

Do not use `npm run dev` for the public deployment. Do not build the hosted
bundle from `.env.local`; that file is intended for loopback development and can
embed a `pk_test_` key. Production startup checks that the built browser bundle
contains the same publishable key as the backend and refuses a stale bundle.

When Node runs behind Nginx, Caddy, a load balancer, or a tunnel, the proxy must
preserve the public host and HTTPS scheme. The equivalent Nginx settings are:

```nginx
proxy_set_header Host $host;
proxy_set_header X-Forwarded-Host $host;
proxy_set_header X-Forwarded-Proto https;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
```

Keep `APP_TRUST_PROXY=loopback` when the reverse proxy connects to Node over
loopback. After changing the origin or Clerk application, restart the server,
open only the canonical URL, sign out, and clear old Clerk cookies once before
testing again.

## Browser routes and controls

- `/login` renders Clerk's sign-in, recovery, and verification tasks.
- `/register` renders Clerk's sign-up flow.
- `/app` requires a signed-in Clerk session.
- the landing page exposes distinct sign-in and sign-up controls;
- the workspace header exposes Clerk's user control;
- Agent Studio's Account tab opens Clerk's profile/security surface and keeps
  Virenis data export and full account deletion nearby.

Legacy Virenis password, verification-token, reset-token, and browser-session
endpoints have been removed. Legacy password hashes and token/session arrays are
scrubbed when an older store snapshot is normalized.

## Product API

Authenticated Clerk users can use:

- `GET /api/auth/me` — returns the linked Virenis actor and product role;
- `GET /api/account/export` — returns a credential-redacted product-data export;
- `DELETE /api/account` — requires `{ "confirmation": "DELETE" }`, deletes the
  Clerk user, and cascades the private Virenis workspace;
- `GET /api/admin/users` — admin-only product identity view;
- `PATCH /api/admin/users/:user_id` — changes product role or Clerk-backed
  suspension status;
- `POST /api/admin/users/:user_id/revoke-sessions` — revokes active Clerk
  sessions for that user.

Viewer identities remain read-only for product data but may access their own
export and account-deletion controls. Users cannot demote or suspend their own
active administrator session, and the final active Virenis administrator cannot
be demoted, suspended, or deleted.

Configured API bearer identities and optional Basic Auth remain supported for
service clients and break-glass operations. A configured Virenis bearer token is
recognized before Clerk middleware, while unknown bearer tokens fail closed.

## Verification

From `web/virenis`:

```bash
clerk doctor
npm run lint
npm test
npm run build
```

For a disposable PostgreSQL table, set `DATABASE_URL` and run:

```bash
npm run test:clerk:postgres
```

Before production traffic, create a production Clerk instance and keys, add the
public origin and redirect URLs in Clerk, configure the signed webhook, sign up
the first administrator, and verify sign-in, sign-up, recovery, MFA, user-profile,
suspension, session revocation, export, and deletion in the deployed origin.

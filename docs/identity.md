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

### Resumable account deletion

Account deletion is a durable, fail-closed saga in the current single-web-
process deployment. After exact confirmation (or a verified Clerk
`user.deleted` webhook), Virenis first changes the local user to `deleting`,
records `deletion_started_at` and a random `deletion_id`, and writes a hashed
provider tombstone. Profile webhooks and Clerk synchronization cannot reactivate
that state. All authenticated operations are rejected with
`account_deletion_in_progress`; only `DELETE /api/account` may resume it.

The web process also tracks authenticated requests by the matching local Clerk
identity, including configured bearer/basic actors that use the same exact
`user_id` and `workspace_id`. Deletion drains requests that started before the
marker with a bounded timeout, rebuilds a fresh tenant-qualified resource
graph, and then performs idempotent external cleanup. Successful external
cleanup steps have durable per-deletion receipts, so a transient provider or
Runtime failure leaves the marker intact and a retry resumes instead of
repeating completed steps. Owner-scoped background mutations, including an
activation resumed by an OAuth callback, join the same drain before their first
await. After a Runtime agent registration returns, the local commit rechecks
the exact durable owner, captured deletion generation, and workflow activation
claim. If deletion or another activation won, the registration is compensated
and the local agent is not made routable. A non-routable tenant-owned cleanup
anchor is written before the remote call; if immediate compensation itself is
unavailable, deletion discovers that anchor and must purge the Runtime agent
before the account can be removed. The anchor contains an internal exact
registration cleanup identifier and is never returned by agent APIs or account
exports. Startup inventories these anchors locally, marks interrupted workflows
retryable, and schedules a bounded post-readiness recovery batch; Runtime
availability therefore cannot block web readiness. The recovery handles both
generated-agent and Marketplace-copy anchors, including a crash before the
Runtime request and a crash after remote success but before local promotion. A
missing exact registration is safe to remove locally; an exact matching
registration is purged first. An ownership mismatch or Runtime outage leaves
the anchor non-routable and pending, and the next workflow activation retry
runs the same reconciliation before allocating a fresh registration. The
scheduled recovery is exposed through the normal background-task drain so
graceful shutdown can wait for or report its bounded batch.

Each per-resource receipt is namespaced by a
canonical digest of the exact external-resource snapshot. A credential or
runtime registration changed under the same ID therefore receives a new purge,
while only the exact already-purged version may be skipped. Clerk deletion
treats provider `404` as success.
Local product data is removed in one exact store transaction, followed by
managed document-file cleanup. That transaction copies the relative document
roots into the hashed deletion tombstone as a short-lived cleanup outbox. The
roots are cleared only after filesystem removal succeeds, so a retried Clerk
deletion webhook can finish cleanup even after the user record and provider
session have already been deleted.

Managed MCP OAuth callbacks share the deletion boundary. A pending callback is
invalidated by the marker; if token exchange was already in flight, its final
store transaction fails and no connection is inserted. The issued credential is
first persisted in an encrypted revocation outbox and then revoked. A transient
revocation failure retains that outbox for the deletion recovery worker; the
account cannot finish deletion until revocation succeeds. An exchange left in
`exchanging`/`account_deleting` without an outbox also blocks deletion and
requires retry or operator remediation rather than being treated as clean. If
the connection committed just before the marker, it is part of the fresh
deletion graph and is revoked by the deletion saga.

Refreshes use the same rule: an exact credential-revision intent is committed
before the provider request. A crash cannot erase that evidence. Stale
`exchanging` and `refreshing` records are promoted after the recovery grace to
explicit exchange/refresh uncertainty and block deletion. An administrator must
first remove the application grant at the provider, then record the evidence
reference, reason, and strong confirmation in the Connections UI. The audited
terminal receipt is scoped to the exact workspace, owner, connection, provider,
and encrypted credential revision, so it cannot authorize cleanup for a
colliding tenant record.

Some providers do not expose a generic RFC-style revocation endpoint. Virenis
does not silently claim success for those providers: deletion stays marked and
fail-closed until a supported provider-specific deauthorization is available.
GitHub uses its application-token check/delete API with OAuth-app Basic
authentication; both stored access and refresh credentials are invalidated.
Slack uses `auth.revoke` for both credentials and accepts only the provider's
documented inactive-token outcomes on a retry. This makes a crash after remote
success resumable without treating an ambiguous authentication failure as
proof of revocation. Other providers continue to use their advertised RFC-style
endpoint; an unsupported provider remains fail-closed rather than reporting a
local-only deletion as complete.

An approved write action interrupted after provider dispatch is never retried
automatically. Recovery exposes `execution_outcome_uncertain` in the original
conversation, preserves the encrypted exact arguments, and requires the user to
check the provider before continuing without replay.

Startup and a bounded periodic worker scan durable deletion markers and
document-cleanup outboxes. It retries the complete saga or filesystem cleanup
under the same per-account coordinator, stores only bounded error codes and
attempt timestamps, and applies durable exponential backoff. The default scan
interval is 60 seconds and the default batch is 25. No credential or provider
error body is written to logs.

Request tracking and deletion single-flight coordination are process-local by
design and match the documented single-web-process MVP topology. PostgreSQL
deployments hold a dedicated advisory lock and refuse a second web process for
the same operational store, preventing accidental unsupported scaling.
Horizontal web scaling requires replacing those two coordination pieces with a
shared lease/request registry before it is supported.

Workspace model-output settings participate in the same tenant-qualified graph
as conversations, agents, documents, and MCP data. They are included in account
export and removed by exact object identity during deletion; ownerless settings
under a colliding legacy workspace are quarantined and block destructive
traversal.

Account export and deletion cover the operational product store, including
WorldGraph artifacts. Production may additionally retain append-only normalized
provenance receipts. Rows written by the current privacy projection contain
digests and workspace-scoped pseudonyms instead of arbitrary payloads, but they
are still pseudonymous records and are not included in the current JSON export.
Any database written by an older projection must pass the legacy-ledger privacy
migration gate described in `docs/virenis_outcomes.md`; immutable legacy rows do
not become content-free merely by deploying newer application code. The runtime
gate covers workspaces present in the active operational snapshot. A migration
administrator must separately inventory orphaned ledger workspaces across RLS
boundaries before launch.

The operational account export includes the user's billing account, ledger
entries, reservations, usage records, and funding events. Account deletion
removes those operational records. A separate normalized accounting projection
may be retained when required for accounting, tax, payment reconciliation,
fraud prevention, or another documented legal obligation. It preserves amounts,
statuses, timestamps, pricing facts, aggregate token usage, and integrity hashes;
raw provider references, run/resource identifiers, and free-form metadata are
replaced with workspace-scoped pseudonyms or digests. These retained rows are
pseudonymous, not anonymous, and are not currently included in the account JSON
export. See [Normalized billing privacy](billing-privacy.md) for the migration
gate, orphan-workspace inventory, and launch requirements.

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

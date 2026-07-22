# MCP Phase 1

Virenis supports remote MCP servers over Streamable HTTP using the stable
`2025-11-25` protocol version. Users can connect Gmail, Google Drive, Google
Calendar, Google Chat, Google Contacts, GitHub, Slack, Notion, and Linear
without copying an endpoint or token, or use the advanced Custom MCP form for
a remote server they administer. They can then bind an exact subset of
discovered tools to an agent and inspect or approve calls in Agent Studio.

## Managed connection flow

```text
Choose a provider and click Connect
  -> server creates a single-use OAuth state, PKCE verifier, and browser nonce
  -> provider account consent
  -> callback validates state + HttpOnly SameSite browser cookie
  -> server exchanges the code and encrypts access/refresh tokens
  -> the official hosted MCP endpoint is initialized and tools are discovered
  -> user assigns selected provider tools to an agent
```

The endpoint and OAuth client configuration are server-owned. OAuth state is
short-lived and never persisted in plaintext; PKCE verifiers, authorization
codes, access tokens, and refresh tokens are never persisted in frontend state
or exposed to the Router. A private connection is visible
and bindable only by its owner, including when several users share a workspace.
Each managed provider permits one active connection per user; users reconnect
or remove it before authorizing a different account for that provider.
Expired access tokens are refreshed once behind a per-connection concurrency
gate. A failed refresh marks the connection `reauthorization_required` and the
UI offers a Reconnect action. Reconnect first retires the exact old credential
through a durable revocation outbox; a new authorization state is not issued
until that retirement is confirmed. Disconnect removes the connection from
agent use atomically, retains its credential only inside the encrypted cleanup
outbox, and retries provider revocation with bounded exponential backoff. It
never reports provider revocation merely because the local connection is gone.

## Execution boundary

```text
session controller
  -> selected agent
  -> Runtime exact tool allowlist
  -> authenticated web MCP gateway
  -> workspace connection and pinned schema check
  -> approval gate when required
  -> remote MCP server
  -> untrusted-data result
  -> agent and session synthesis
```

The Runtime receives an opaque tool alias and a prompt-safe input schema. It
does not receive the connection URL, connection identifier, bearer token, or
encrypted credential envelope. The gateway resolves the alias only after the
Runtime forwards the server-owned execution identity (`run_id`, `session_id`,
`user_id`, and `workspace_id`).

## Security properties

- Bearer credentials and approval arguments/results use AES-256-GCM at rest.
- OAuth access tokens, refresh tokens, and PKCE verifier state use the same
  authenticated encryption boundary with record-specific associated data.
- OAuth callbacks use high-entropy, single-use state plus an HttpOnly,
  SameSite browser nonce. Replayed, expired, cross-browser, or provider-mismatched
  callbacks are rejected before token exchange.
- Production keys can be supplied through mode-`0600` secret files.
- Remote endpoints require HTTPS. Redirects, URL credentials, fragments,
  private/reserved DNS results, oversized responses, and DNS-to-request address
  changes are blocked.
- Tool schemas are hashed when bound. A changed schema stops execution until
  the agent is reviewed and rebound.
- Every call is checked against both the Runtime allowlist and the stored agent
  binding. Bindings and approvals pin the connection ID, workspace, and owner;
  legacy identifier collisions fail closed. An MCP server never chooses its
  own agent or scope.
- Calls marked as actions create an encrypted, exact-argument approval. Denial
  never contacts the remote server; approval is claimed before the remote call
  so a replay cannot execute it twice.
- Tool output is labeled `external_untrusted_data` and wrapped with an
  executor instruction that forbids following embedded instructions.
- The MCP gateway audit collection retains identities, status, timestamps, and
  input/output digests. Raw MCP call arguments, tool-call turns, and tool
  results are redacted from the completed Runtime record after synthesis; the
  user-facing answer remains in normal chat history.
- Marketplace snapshots contain only abstract provider/tool requirements.
  Connection IDs, URLs, aliases, live bindings, and credentials are excluded.

Tool risk annotations originate at the selected MCP server. The default policy
therefore asks before every call. A workspace owner can explicitly trust a
server's declared read-only labels; only then may those declared reads run
without approval. Unknown or non-read-only tools are always treated as actions.
Users should still scope remote credentials to the least privilege available.

## Crash and uncertainty recovery

Virenis writes an OAuth refresh intent before contacting a token endpoint and
stages every returned credential before it can become usable. A complete
response commits the rotated credential and clears the intent in one store
transaction. A process crash or truncated response instead leaves durable
evidence. After the configured grace period, startup and the periodic recovery
worker promote incomplete exchanges and refreshes to an explicit uncertain
state. Account deletion and reconnect remain blocked until an administrator has
removed the app grant in the provider, supplies an evidence reference and
reason, and records the exact confirmation through the Connections UI or
`POST /api/admin/mcp/revocations/{id}/resolve`.

Provider revocation semantics are respected. GitHub and Slack cleanup is
token-scoped. Google and conservatively handled RFC-style providers may revoke
the wider app grant, so a surviving credential in an exceptional concurrency
race is quarantined for reauthorization rather than presented as ready.

Approved write tools have a separate fail-safe. If the process stops while a
provider action is in flight, recovery marks the action
`execution_outcome_uncertain`; it is never replayed automatically. The chat
shows the exact attempted arguments, asks the user to check the provider, and
offers a continuation that explicitly preserves the unknown outcome.

## Configuration

Web process:

```dotenv
APP_MCP_CREDENTIAL_KEY_FILE=/run/secrets/mcp_credential_key
APP_MCP_GATEWAY_KEY_FILE=/run/secrets/mcp_gateway_key
```

Managed provider connections:

```dotenv
APP_MCP_OAUTH_REDIRECT_ORIGIN=https://app.example.com
APP_MCP_GOOGLE_OAUTH_CLIENT_ID=your-client.apps.googleusercontent.com
APP_MCP_GOOGLE_OAUTH_CLIENT_SECRET_FILE=/run/secrets/google_oauth_client_secret
APP_MCP_GITHUB_OAUTH_CLIENT_ID=your-github-client-id
APP_MCP_GITHUB_OAUTH_CLIENT_SECRET_FILE=/run/secrets/github_oauth_client_secret
APP_MCP_SLACK_OAUTH_CLIENT_ID=your-slack-client-id
APP_MCP_SLACK_OAUTH_CLIENT_SECRET_FILE=/run/secrets/slack_oauth_client_secret
APP_MCP_OAUTH_RECOVERY_GRACE_MS=1200000
APP_MCP_OAUTH_RECOVERY_INTERVAL_MS=60000
APP_MCP_OAUTH_RECOVERY_BATCH=25
```

Register exact callbacks of the form
`https://app.example.com/api/mcp/oauth/callback/{provider}`. Google provider
IDs are `gmail`, `google_drive`, `google_calendar`, `google_chat`, and
`google_contacts`; enable only the corresponding APIs and documented scopes in
the Google Cloud project. GitHub and Slack use `github` and `slack`. Notion and
Linear use OAuth discovery, PKCE, and dynamic client registration, so the
public HTTPS origin is their only deployment prerequisite. A statically
configured provider without credentials is shown as requiring administrator
setup and cannot start authorization.

Runtime process:

```dotenv
TOOL_GATEWAY_URL=https://app.example.com/api/internal/mcp/tools/call
TOOL_GATEWAY_KEY_FILE=/run/secrets/tool_gateway_key
```

The credential key exists only on the web host. The gateway key is shared only
between the web and Runtime processes and must be different from the Runtime
API key.

## Proof tests

```bash
npm test -- tests/mcp.test.js
npm test -- tests/mcpOAuth.test.js
/home/ubuntu/miniconda3/envs/tcar-qwen36/bin/python scripts/test_tcar_mcp_gateway.py
/home/ubuntu/miniconda3/envs/tcar-qwen36/bin/python scripts/test_runtime_api_agent_atomicity.py
```

The web tests include a complete live path from the Python executor through
the authenticated Express gateway to a synthetic MCP server. It also proves
encrypted storage, discovery, read execution, write approval/denial, replay
prevention, identity isolation, schema drift blocking, SSRF blocking, audit
digests, and Marketplace redaction. The managed-provider suite additionally
proves provider-registry redaction, dynamic registration, PKCE, browser binding,
encrypted OAuth storage, callback replay/expiry rejection, owner isolation
inside a shared workspace, concurrent token refresh, reauthorization, provider
revocation, and a live Python-executor → authenticated gateway →
OAuth-protected MCP-server call. Adversarial cases cover partial-response
socket aborts, refresh/exchange crash recovery, exact-tenant legacy collisions,
grant-wide cleanup races, retry fairness, account-deletion blocking, and an
interrupted approved write that must continue without replay.

The current boundary intentionally does not include local `stdio` servers,
MCP resources/prompts, or arbitrary-provider OAuth discovery. Workflow and
tool checkpoints are durable: after a user accepts, rejects, connects, or
reauthorizes a provider, the saved conversation resumes without exposing the
provider credential to the Router.

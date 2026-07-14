# MCP Phase 1

Virenis Phase 1 supports remote MCP servers over Streamable HTTP using the
stable `2025-11-25` protocol version. Workspace owners can discover a server's
tools, bind an exact subset to an agent, and inspect or approve calls in Agent
Studio.

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
- Production keys can be supplied through mode-`0600` secret files.
- Remote endpoints require HTTPS. Redirects, URL credentials, fragments,
  private/reserved DNS results, oversized responses, and DNS-to-request address
  changes are blocked.
- Tool schemas are hashed when bound. A changed schema stops execution until
  the agent is reviewed and rebound.
- Every call is checked against both the Runtime allowlist and the stored agent
  binding. An MCP server never chooses its own agent or scope.
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

## Configuration

Web process:

```dotenv
APP_MCP_CREDENTIAL_KEY_FILE=/run/secrets/mcp_credential_key
APP_MCP_GATEWAY_KEY_FILE=/run/secrets/mcp_gateway_key
```

Runtime process:

```dotenv
TCAR_MCP_GATEWAY_URL=https://app.example.com/api/internal/mcp/tools/call
TCAR_MCP_GATEWAY_KEY_FILE=/run/secrets/mcp_gateway_key
```

The credential key exists only on the web host. The gateway key is shared only
between the web and Runtime processes and must be different from the Runtime
API key.

## Proof tests

```bash
npm test -- tests/mcp.test.js
/home/ubuntu/miniconda3/envs/tcar-qwen36/bin/python scripts/test_tcar_mcp_gateway.py
/home/ubuntu/miniconda3/envs/tcar-qwen36/bin/python scripts/test_runtime_api_agent_atomicity.py
```

The web test includes a complete live path from the Python executor through
the authenticated Express gateway to a synthetic MCP server. It also proves
encrypted storage, discovery, read execution, write approval/denial, replay
prevention, identity isolation, schema drift blocking, SSRF blocking, audit
digests, and Marketplace redaction.

Phase 1 intentionally does not include local `stdio` servers, OAuth account
linking, MCP resources/prompts, or automatic continuation of a chat after a
separately approved action. The approved action itself runs and its result is
shown in Connections; a later phase can add resumable execution checkpoints.

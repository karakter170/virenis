# WorldGraph selective execution

WorldGraph is the Router's change-aware execution layer. After a successful run, it stores a bounded, integrity-sealed result for each agent route. On an exact repeat, the Router may keep a route asleep only when it can prove that the route's request, instructions, evidence, dependencies, relevant memory, execution settings, and effect policy are unchanged.

This reduces worker-agent model calls; it does not bypass planning, final synthesis, validation, authorization, or billing. A cold run behaves exactly like a normal Router run.

## Runtime flow

```text
request -> Router plan -> per-route validity check -> wake or reuse each agent
                          |                         |
                          |                         +-> validated route outputs
                          +-> signed, scoped capsule       |
                                                          v
                                                final synthesis -> answer
```

The unit of reuse is a validated route output, not a full answer. A route that wakes is executed normally. After it finishes:

- If its validated output digest changed, consumers of that output wake.
- If its instructions changed but its recomputed output has the same canonical digest under the validated output contract, unaffected consumers may remain asleep.
- Final synthesis still combines the route outputs into a new answer.

The session controller treats the current request as authoritative and uses older conversation content only to resolve references. A narrowing follow-up such as “continue specifically with Renault's Clio” therefore selects the Renault specialist without reactivating unrelated Python or business-idea branches merely because they appeared earlier in the chat. This routing scope guard is separate from reuse: the first changed Clio request runs the selected Renault route, while an exact repeat can reuse that verified route.

## Reuse invariant

A stored route is reusable only when all of these bindings match:

| Binding | What is compared |
| --- | --- |
| Tenant scope | Workspace, user, chat session, and agent workspace |
| Request | Digest of the exact persisted UTF-8 request; internal whitespace, indentation, line breaks, and Unicode code points are preserved |
| Route | Agent adapter, route task, and WorldGraph schema/engine revision |
| Agent | Revision digest of its instructions, contracts, knowledge, tools, and other execution-relevant configuration |
| Dependencies | Exact upstream step IDs, adapters, validated output digests, and source/artifact/consumption validation state |
| Memory | Digest of the admitted conversation/shared memory, but only for agents whose contract consumes it |
| Sources | Source configuration, private-knowledge digest, retrieval settings, and document corpus/index revisions |
| Documents | Enabled state, runtime-sync state, and committed-document integrity; metadata-only/external documents must bind valid corpus and index digests |
| Execution | Base-model checkpoint bytes, transitive executor source bytes, worker dependency/configuration digest, tokenizer bytes, retrieval/embedding configuration, request token limits, temperature, and the normalized set of specialists in a user-approved workflow |
| Effects | A pure, replayable effect policy with no executed tool receipt |

The Router also requires an unexpired artifact whose record seal, input-envelope digest, output digest, and validation contracts all verify. In production real-runtime mode, the record seal is an HMAC under the web/runtime secret, so a database-only writer cannot forge a modified artifact by recomputing a public checksum. Simulator/development mode uses an unkeyed integrity checksum when no secret is configured. A mismatch wakes the route; it never silently falls back to an approximate match.

### Selective invalidation

WorldGraph evaluates routes in dependency order. A dirty upstream route is represented as unknown until it executes, so a downstream result cannot be selected using stale evidence. Once the upstream output is validated, its actual digest is used to decide the consumer.

Typical outcomes:

- Editing one independent agent wakes that agent only when its result remains equivalent.
- Editing an agent and changing its result wakes that agent and its downstream consumers, but not unrelated branches.
- Changing one of ten documents wakes the document's agent and the consumers of that result; agents bound to the other nine documents remain eligible for reuse.
- Changing conversation memory wakes only agents that declare that they consume conversation or shared memory.
- Changing the request, route task, model revision, source revision, or relevant execution setting wakes the affected route.

## Fail-closed and effect policy

WorldGraph intentionally refuses reuse when safety cannot be proved. A route runs fresh when any of the following applies:

- `run_fresh` is enabled or temperature is nonzero.
- The request is time-sensitive and the route can provide mutable information.
- The request asks for current or changing information and the agent has a live/mutable capability such as web, news, weather, browser, HTTP, repository, market, or an unknown future integration. Merely having an unused tool available does not invalidate a stable exact repeat because the unchanged tool allowlist is already bound into the agent revision. Deterministic document/index availability can remain eligible only when immutable source revisions are bound; any actual tool receipt still forces fresh execution.
- Any tool was executed, including a deterministic read. Tool implementation and argument digests are not yet part of the v1 replay contract.
- The route executed an MCP/external action or requires approval.
- A document is disabled, awaiting runtime synchronization, unverifiable, lacks bound corpus/index digests, or fails its committed-content integrity check.
- The output is missing, oversized, invalid, policy-violating, malformed, expired, tampered with, or contested.

Raw tool arguments and raw returned data are not copied into replay receipts. Stored tool receipts contain bounded names/status fields and data digests only. External actions are never repeated by the change preview and are never automatically replayed.

At deterministic settings, two different validated outputs for the same exact input envelope create an integrity-sealed `result.contested` event. Both artifacts are marked contested with new seals and are then excluded from reuse. Modifying either the event or either artifact without the application key fails verification.

Capsule preparation is observable rather than silent. Each run records whether a signed capsule was created, the number of exact-request artifacts and eligible candidates, and bounded exclusion reason codes such as changed instructions, relevant memory, sources, settings, expiry, disagreement, or unavailable signing. Public run responses contain only counts and plain explanations—never replay payloads, artifact IDs, envelopes, record hashes, or signatures. The runtime audit receipt independently records capsule presence and candidate count.

## “Check what changed” and refresh UX

The run details sheet uses three deliberately different operations:

1. **Check what changed** recalculates validity against current agent revisions, sources, documents, relevant memory, and execution settings. It creates no run or artifact, performs no model call, and triggers no tool or external action.
2. **Refresh affected work** resubmits the same request with selective reuse enabled. The live execution wakes the minimum routes it can prove are dirty.
3. **Run all agents anyway** resubmits with `run_fresh: true`, bypassing every stored route result.

The check is conservative around dependencies: if an upstream route might change, the preview also marks its consumers as potentially affected. The live run can keep more consumers asleep if the refreshed upstream output proves identical. UI copy must therefore say “may need to check again,” not promise that every previewed agent will run.

A completed run's change record describes what happened when that answer ran. It is not a continuous freshness claim. Users must select **Check what changed** to compare it with current state.

Color is not the only signal: reused/checked-again states use different icons, labels, status text, and accessible live regions. Reused specialists are labeled “Reused from earlier · no specialist model call,” and their specialist-call count is zero.

## HTTP API

All endpoints use the existing authenticated chat-run ownership rules. An inaccessible run returns `404`; responses are `Cache-Control: private, no-store`.

### Read a run's change record

```http
GET /api/chat/runs/:run_id/worldgraph
```

Returns a public graph snapshot containing nodes, dependency edges, plain-language decisions, and aggregate counts. It never returns replay outputs, input envelopes, record hashes, tool receipts, or signed capsules.

### Preview current validity

```http
POST /api/chat/runs/:run_id/worldgraph/check
Content-Type: application/json

{}
```

The response includes `availability`, `validity`, `keep_count`, `wake_count`, per-route projected actions/reasons, `conservative`, and `model_calls_performed: 0`. It performs no persistence mutation.

### Execute selective or full refresh

Use the normal message endpoint with the original request:

```http
POST /api/chat/sessions/:session_id/messages
Content-Type: application/json

{
  "content": "the original request",
  "options": { "run_fresh": false }
}
```

Set `run_fresh` to `true` for a full rerun. Use an idempotency key for production submissions, as with all chat messages.

## Storage, identity, and limits

Artifacts are append-only application records until retention pruning, with integrity seals (HMACs in production real-runtime mode). Disagreement is recorded as an event instead of mutating a prior artifact. Operational WorldGraph data follows the application's configured persistent store and is included in user export and user-deletion flows. The separate normalized provenance projection may retain content-free digest receipts under workspace-scoped pseudonyms; those pseudonymous receipts are not anonymous and are not included in the account JSON export. A database written by an older projection must pass the documented legacy-ledger privacy migration gate before new receipts can be appended.

The retention sweep runs at application startup and then hourly by default (configurable from one minute to 24 hours). The seven-day TTL is therefore enforced no later than one configured sweep interval after expiry, even when no new chat runs are created. Reused routes point to the verified original artifact instead of cloning its payload, so repeats neither renew freshness nor amplify storage.

Current hard limits are intentionally conservative:

| Limit | Value |
| --- | ---: |
| Real-runtime reuse age | 30 minutes |
| Simulator reuse age | 24 hours |
| Artifact storage retention | 7 days |
| Stored artifacts per workspace/user owner | 240 |
| Contention/audit events per workspace/user owner | 500 |
| Replay material per route | 128 KiB |
| Outbound signed capsule | 2 MiB |
| Candidates per capsule | 24, de-duplicated by agent and input envelope |
| Capsule lifetime | 5 minutes |
| Runtime inbound capsule guard | 4 MiB |

Oversized route output is omitted from reuse storage without failing the answer. Retention is enforced globally by artifact age; the per-owner count cap never evicts another tenant's artifacts.

## Runtime trust boundary and deployment

WorldGraph adds no browser-visible secret and no new model request. In real-runtime mode, it reuses the existing Router web-to-runtime authentication configured in the Router runtime block of [`.env.example`](../.env.example):

- The web server and runtime must hold the same strong API secret (prefer the supported secret-file setting in production).
- The web server creates an HMAC-SHA256 capsule bound to the target run, workspace, user, session, agent workspace, and exact query.
- The runtime verifies the signature, exact scope, query digest, schema/revision, timestamps, size, and candidate count before executor work.
- The executor independently verifies agent revision, task, admitted-memory digest, current execution-setting digest, dependency identities/digests, output digest, validation state, sources, and effect policy before skipping a worker model call.
- The cross-service execution-setting digest contains request-owned settings only. Process-local web/GPU environment values are bound through authenticated runtime component provenance instead, so a normal split deployment does not invalidate every candidate.

Production checklist:

- Use the normal production identity, database, origin, and private-runtime transport guards; do not enable JSON storage except for an explicitly isolated private beta.
- Keep the runtime API off the public browser path, use TLS or a private authenticated network, and never expose its secret to client code or logs.
- Synchronize clocks on the web and runtime hosts. The verifier tolerates only 30 seconds of future clock skew.
- Deploy web and runtime support for a new WorldGraph schema/engine revision together. Unknown revisions fail closed.
- Restart the runtime after changing executor code or dependencies. In-place source replacement is detected and fails closed because Python cannot truthfully relabel already-loaded bytecode.
- Give embedding-backed retrieval a stable model revision (`TCAR_EMBEDDING_MODEL_REVISION`) and roll that revision whenever provider/model behavior changes. Retrieval weights, endpoint origin, model, declared revision, and non-secret behavior settings are included in worker provenance.
- Rotate the shared runtime secret on both sides in one controlled deployment; in-flight capsules and stored artifact MACs created under the old key will be rejected and safely rebuilt cold.
- Monitor route `started` versus `reused` events, provider-reported call counts, contested events, and validation failures. Reused routes must have no agent provider-call component.

## Verification

From `/home/ubuntu/project/web/virenis`:

```bash
npx vitest run tests/worldGraph.test.js tests/worldGraphApi.test.js tests/worldGraphRemote.test.js
npm test -- --reporter=dot
npm run lint
npm run build
```

The focused suite covers integrity/tamper rejection, exact tenant boundaries, expiry, fresh/creative/live rules, relevant-memory invalidation, document revisions and corruption, invalid upstream validation, a ten-document branch stress case, contested results, tool redaction, storage and size caps, concurrent repeats, private API output, the signed remote bridge, runtime-plan/output coverage, and billing. Separately, 30 realistic simulator-backed full application cold/repeat scenarios exercise varied product requests. They are integration scenarios, not 30 live Qwen quality evaluations.

Activate the project's Miniconda environment, then run the cross-language trust-boundary and executor proofs:

```bash
python /home/ubuntu/project/scripts/test_runtime_world_graph_capsule.py
python /home/ubuntu/project/scripts/test_world_graph_executor.py
python /home/ubuntu/project/scripts/test_phase219_executor_data_plane.py
```

The executor proof asserts instrumented provider-call roles: a cold three-agent DAG calls all three agents plus final synthesis; an all-clean repeat calls final synthesis only; a changed branch wakes itself and its consumer; and an unchanged recomputed output preserves its consumer. It also rejects tampered output, tool-bound output, forged dependencies, invalid upstream validation, expired capsules, changed admitted memory, changed execution settings, changed model/executor/configuration provenance, and cross-query candidates. The capsule proof checks that the production Node and Python implementations produce the same execution-setting digest.

For an optional live Qwen/vLLM smoke test, first load a reachable, API-key-protected Router runtime whose catalog exposes the test agent to the test user's agent workspace, then run:

```bash
node /home/ubuntu/project/scripts/test_world_graph_live_runtime.mjs
node /home/ubuntu/project/scripts/test_world_graph_live_followup.mjs
```

The generic script must finish with `ok: true`, at least one cold worker route, at least one reused repeat route, fewer repeat `route.started` events, and provider usage that excludes reused specialists. The follow-up script reproduces the Renault + Python + business example: three initial routes, Renault alone on the narrowed Clio turn, then one reused Renault result and zero worker-route starts on the exact repeat. Treat a catalog/scope failure as a deployment failure; do not weaken workspace isolation to make the smoke test pass.

## Deliberate v1 boundaries

- Reuse is exact, not semantic. A rephrased request gets a different digest and wakes work; WorldGraph does not infer that two prompts “mean the same thing.”
- The Router planner and final synthesizer may still call a model. WorldGraph reduces eligible worker-agent calls; it does not promise a zero-call repeat.
- Billing reserves the conservative cold-run maximum before execution, then settles only provider-reported calls. This protects ledger integrity, but an account whose balance is below the cold reservation can be rejected even when an exact repeat would ultimately reuse every worker route.
- No executed tool result is replayed in v1, even when the tool appears read-only or deterministic.
- The preview can overestimate downstream wake-up work, but never understates a known dirty dependency.
- Source freshness is only as strong as the immutable content/revision metadata supplied by the document or source adapter. Titles, paths, and filenames are not treated as validity evidence.
- WorldGraph is not an arbitrary what-if engine, long-term knowledge graph, or semantic cache. It tracks validated execution dependencies for the same request.
- The current capped application-store representation is a bounded single-web-process MVP/private-beta topology. PostgreSQL still serializes a global JSONB application snapshot, while SSE delivery and duplicate-run single-flight coordination are process-local. A session-level PostgreSQL advisory lock now refuses a second Virenis web process for the same table/store key instead of allowing an unsafe replica to start; the serving connection must therefore use direct or session-pooled PostgreSQL, not transaction pooling. JSON-store private betas must likewise run one process. Before broad B2C/B2B scale, move WorldGraph and chat records to normalized tenant-indexed tables, use shared event delivery and distributed coordination, and load-test pruning, contention, billing, and tenant queries at the intended concurrency.

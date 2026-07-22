# Web functionality proof

This document maps every major interactive Virenis web surface to its server implementation and executable proof. It is an implementation audit, not a claim that testing can mathematically exclude every future defect. A feature is marked supported only when all three boundaries exist: browser behavior, an authenticated server handler, and a behavior test. High-value cross-system paths also have a live browser or GPU Runtime proof.

Audit date: 2026-07-22.

## Contract inventory

- The browser references 58 distinct `/api` paths.
- It declares 60 distinct static HTTP method/path operations.
- `server/app.js` exposes 95 authenticated or operational Express routes, including browser routes and server-only webhook, OAuth callback, audit, and health routes.
- `tests/webSurfaceBackendContract.test.js` extracts the browser contract from `App.jsx`, `IdentityPage.jsx`, and `workspaceBootstrap.js`, normalizes dynamic IDs, and fails if either a path or its declared HTTP method has no matching Express handler.
- Every mutable resource crosses workspace/actor authorization in the server; the browser is never treated as the security boundary.
- Final audit result: 65 web test files / 868 tests, 95 planner tests, 86 executor trust/data-plane tests, 7 routing-contract tests, 7 Playwright tests, plus the focused Runtime suites listed below are green.

## UI-to-server proof matrix

| User-facing surface | Browser implementation | Server implementation | Automated behavior proof | Live boundary proof |
|---|---|---|---|---|
| Sign-in, account, export, deletion, roles, suspension, session revocation | `src/IdentityPage.jsx`, Clerk shell | `server/clerkIdentity.js`, account/admin routes in `server/app.js` | `identity.test.js`, `identityUi.test.js`, `tenantMutationIsolation.test.js`, `authRecovery.test.js` | Clerk ticket authentication is exercised by the browser live scripts when Clerk credentials are configured. |
| New chat, send, stream, cancel/recover, retry, copy, feedback | `src/App.jsx` | chat/run/SSE routes in `server/app.js`, `server/tcarEngine.js` | `api.test.js`, `sseLifecycle.test.js`, `recovery.test.js`, `sessionRunAdmission.test.js`, `chatLifecycleUi.test.js` | Marketing and Brainstorming scripts submit through the real composer and wait for the durable GPU run. |
| Team creation/edit/delete, membership, active state, team map, handoffs, 16-agent cap | `src/App.jsx` team studio and graph | `server/agentWorkspaces.js`, workspace/session routes | `agentWorkspaces.test.js`, `productFeatures.test.js`, `tenantMutationIsolation.test.js` | Discover-isolation proof copies a six-agent team and proves the previous roster is absent from list, graph, picker, and active-session state. |
| Agent creation and editing | `AgentBuilderDialog` in `src/App.jsx` | agent CRUD routes, `server/agentContract.js`, `server/runtimeClient.js` | `agentContractV4.test.js`, `agentToolConfiguration.test.js`, `workflowAgentConfigurationE2E.test.js`, `api.test.js` | Agent Builder browser proof creates an agent, verifies the persisted JSON and live Runtime manifest, then archives and purges it. |
| Native tools | Agent Builder tool choices | normalized tool contracts in `server/agentContract.js`; execution in Runtime | `agentToolConfiguration.test.js`, `runtimeClient.test.js`, Runtime specialist-tool suite | Browser proof persists all seven native tools: web search, calculator, data table, document search/read, repository inspector, and SQL runner. |
| Connected apps and custom MCP | Connected Apps UI and Agent Builder bindings | `server/mcp.js`, `server/mcpOAuth.js`, internal MCP gateway | `mcp.test.js`, `mcpOAuth.test.js`, `mcpProviderRegistry.test.js` | Agent Builder proof discovers and binds synthetic read and write MCP tools through the actual protocol. Managed OAuth is protocol-tested; a real Google/Notion account is intentionally not mutated by CI. |
| Repository access | approved-root control in Agent Builder | admin-only root normalization and Runtime agent registration | `agentToolConfiguration.test.js`, `api.test.js`, `storagePermissions.test.js` | Agent Builder proof persists root `.` and confirms it in the Runtime manifest. |
| Knowledge upload/review/delete | Knowledge UI and Agent Builder file step | `server/documents.js`, document routes, Runtime document registration | `documents.test.js`, `workflowSourceFirstE2E.test.js`, `api.test.js` | Browser proof uploads CSV, verifies chunks, retrieves the value `5031` through server search, binds the document resource, and confirms it reached Runtime. PDF, Markdown, text, and CSV parsers are covered by server tests. |
| Private agent source text | Agent Builder knowledge text and validated source-path helper | owned-source enforcement in `server/app.js`; Runtime registration | source-scope cases in `api.test.js`, `agentContractV4.test.js` | Agent Builder proof saves private notes under `sources/router_agents/<agent-id>/`; cross-agent and cross-document paths are rejected for users and admins. |
| Conversation/team memory | Agent Builder memory controls and chat history | canonical memory contract, admitted session memory in web/Runtime bridge | `agentContractV4.test.js`, `workflowAgentConfigurationE2E.test.js`, `curatedTeamsE2E.test.js` | Agent Builder checks the full memory envelope. `test_agent_studio_fields_live.py` proves a downstream live Qwen route receives conversation memory while the source reader does not; curated/Brainstorming runs prove later-turn routing. Long-term retention is not claimed when the selected contract says `session`. |
| Permissions, approvals, routing trust, lifecycle | Agent Builder advanced controls and Discover detail | canonical contract validation, MCP approval routes, Runtime lifecycle intents | `agentContractV4.test.js`, `mcp.test.js`, `runtimeAdoption.test.js`, `lifecycleUi.test.js` | Agent Builder proof confirms memory, side effects, approval requirements, `runtime_normalized`, and ready/healthy state in both web storage and Runtime. |
| Discover browse/detail/rate/publish/unpublish | Discover cards and details in `src/App.jsx` | Marketplace routes and `server/curatedMarketplace.js` | `curatedMarketplace.test.js`, `marketplaceRatingIdentity.test.js`, `curatedTeamsE2E.test.js` | Discover-isolation browser proof opens a curated listing and persists a four-star rating. |
| Discover team copy | Add-team action | atomic workspace/agent copy with ID and typed-handoff remapping | `curatedTeamsE2E.test.js`, `agentWorkspaces.test.js`, `api.test.js` | Browser proof copies Marketing, verifies six canonical agents, and proves no stale inactive agents from the former team survive. |
| Discover individual-agent copy | Add-to-team action | Marketplace copy route and workspace capacity reservation | `curatedMarketplace.test.js`, `agentWorkspaces.test.js`, `tenantMutationIsolation.test.js` | Browser proof copies one specialist into the selected copied team and verifies its canonical contract and UI membership. |
| `/agent` and `/workflow` commands | shared chat composer and workflow decision cards | `server/workflows.js`, workflow routes, Runtime composer | `workflows.test.js`, `workflowAgentConfig.test.js`, `workflowSourceFirstE2E.test.js`, `workflowAgentConfigurationE2E.test.js` | Live command proof composes, approves, activates, executes, restarts/resumes, detects Gmail consent, declines safely, and purges temporary agents. |
| Human-readable answers and named provenance | formatted answer, source hover card, right-side Answer Details panel | route/output provenance in `server/tcarEngine.js`; presentation normalization in `src/answerPresentation.js` | `answerPresentation.test.js`, `productFeatures.test.js`, `runtimeStreaming.test.js` | Marketing browser proof checks headings, no raw Runtime IDs/schema envelopes, named agent controls, hover summary, focused source panel, and every specialist output. |
| Runtime status, adoption, audit, model/output limits | status/admin panels | `server/runtimeClient.js`, `server/modelSettings.js`, Runtime audit routes | `runtimeClient.test.js`, `runtimeAdoption.test.js`, `runtimeAuditReconciliation.test.js`, `modelSettingsApi.test.js` | Agent Builder and curated live scripts cross the web-to-Runtime boundary and inspect the registered Runtime agent. |
| Billing and usage | account/admin credit panels and run receipt | `server/billing.js`, normalized ledger | `billingApi.test.js`, `billingSql.test.js`, `normalizedBillingPrivacy.test.js`, `normalizedLedgerPrivacy.test.js` | Live command and curated proofs require provider-reported token components, settled charges, and zero leftover reservations. |
| WorldGraph reuse/refresh | Work Summary and graph controls | `server/worldGraph.js`, worldgraph routes | `worldGraph.test.js`, `worldGraphApi.test.js`, `worldGraphRemote.test.js` | Runtime world-graph contract scripts exercise capsule creation, freshness, and parity. |
| Outcome Contracts and RealityRank | Results panel, track/settle/dispute/correct dialogs | `server/outcomes.js`, outcome and rank routes | `outcomes.test.js`, `outcomeEvidence.test.js`, `productFeatures.test.js` | The product PoC and API suites exercise the complete state transition chain. |
| Responsive landing/navigation/accessibility | `src/LandingPage.jsx` | production SPA serving and auth entry | `productionBuild.test.js`, `identityUi.test.js`, Playwright landing suite | Playwright runs phone 320/360/375, tablet, desktop, keyboard navigation, and serious automated accessibility checks. |

## Agent creation JSON contract

The Agent Builder does not generate an informal UI-only record. It produces a normalized `virenis-agent-v4` object and sends the same execution fields to Runtime. The meaningful shape is:

```json
{
  "id": "full_contract_browser_analyst",
  "title": "Full Contract Browser Analyst",
  "capability": "...",
  "boundary": "...",
  "consumes": ["user_request", "shared_memory", "upstream_specialist", "table_data", "document_context"],
  "produces": ["domain_answer", "evidence", "recommendations", "structured_data", "handoff", "final_answer"],
  "routing_cues": ["..."],
  "resources": ["agent:<document-agent-id>"],
  "sources": ["sources/router_agents/full_contract_browser_analyst/source.md"],
  "tools": ["web_search", "calculator", "data_table", "document_search", "document_read", "repo_inspector", "sql_runner", "mcp:<connection>:search_notes", "mcp:<connection>:create_note"],
  "tool_config": { "repo_inspector": { "roots": ["."] } },
  "mcp_bindings": [{ "connection_id": "...", "tools": [{ "name": "search_notes" }, { "name": "create_note" }] }],
  "memory": {
    "read_scopes": ["conversation", "team"],
    "write_scopes": ["conversation"],
    "retention": "session",
    "sensitivity_limit": "internal"
  },
  "permissions": {
    "side_effects": ["none"],
    "approval_required_for": ["email_send"]
  },
  "routing": { "metadata_trust": "runtime_normalized" },
  "lifecycle": { "state": "ready", "health": "healthy" },
  "contract_version": "virenis-agent-v4"
}
```

Structured response, memory, knowledge, and composition policies are preserved in web storage while Runtime may add normalized enforcement policies. Partial edits merge these policy namespaces instead of replacing them.

## Fixed defects found by the audit

1. Discover team copies could leave agents from the previously selected team visible as inactive. Session/team hydration now derives the roster exclusively from the selected workspace; the browser isolation proof checks list, map, picker, and composer state.
2. Agent source paths accepted by the web UI could later be rejected by Runtime. The UI now shows the owned source prefix and blocks invalid submission; the server applies the same rule to administrators and users whenever sources change.
3. Source hardening initially blocked unrelated edits on historical catalog agents. Ownership is now revalidated only on create or an actual `sources`/`source_text` mutation.
4. Runtime detail refresh could overwrite structured response/memory/knowledge/composition policy data with flat enforcement policies. Runtime refresh now merges both namespaces, and partial PATCH keeps local structured policy data.
5. Agent and final-output controls retained obsolete browser fallback limits. They now match the server defaults and ceilings: 4,096/8,192 defaults and 8,192/12,288 configurable maxima, subject to context-safe clamping.
6. Generic Marketing guidance after a greeting could be under-selected because a schema-valid Qwen `direct` proposal bypassed semantic review and an exact-word fallback could not understand natural advisory wording. Every turn now uses a complete-team Qwen proposal plus independent Qwen semantic adjudication; no request-language rule may choose or veto membership.
7. Capability arithmetic could block ordinary follow-ups such as “look at other perspectives.” Selection is now model-led across the active team, while deterministic checks enforce identity, lifecycle, permissions, exact typed handoffs, and required dependency closure instead of classifying qualitative wording.
8. Raw handoff JSON and private route/artifact IDs could leak into the final presentation. Answers are normalized to Markdown; provenance is represented by named specialists with a hover preview and an Answer Details side panel.
9. The product-comparison harness used stale hard-coded agent IDs after Discover teams changed. It now loads the current code-owned catalog, creates isolated Runtime IDs, remaps every typed handoff, records the exact catalog digest/roster, and proves all temporary registrations were purged.
10. Long advisory tables could be rejected because a whole Markdown row was flattened into one claim and private execution IDs were treated as public factual citations. Source-free evaluative routes may now move validated internal handoff IDs into an audit sidecar. The exception is bounded to validated typed inputs with no document/live/tool source obligation; unsupported guarantees and changed quantities remain fail-closed. The executor regression suite proves both acceptance and rejection paths.
11. The comparison verifier and UI test encoded the previous capture's outcome totals and agent IDs. They now verify the exact captured identity mapping, cleanup proof, deterministic score arithmetic, report-scoped claim, rendered row counts, compute disclosure, and absence of private Runtime IDs.
12. Python and web terminal validators still demanded a legacy six-item English policy checklist after Qwen had produced a valid semantic-first plan. Python rejected before execution; the web then rejected a later run after all six agents had completed. Both boundaries now preserve the enum-closed `qwen_model_led` authority and accept `semantic_policy_diagnostics_only`, while missing/tampered authority markers remain fail-closed.
13. Workflow review helpers had been inserted inside `/chat/recover`, leaving the endpoint body unreachable. The recovery body is restored, the helpers are module-level, and `test_runtime_audit_integration.py` proves pending, completed, conflicting, failed, and expired recovery states.

## Live same-model comparison

The comparison is illustrative evidence, not a universal benchmark. Both arms use `qwen36-awq`, the same user prompt, temperature, and final-output ceiling. The team arm is allowed its saved six-stage graph and therefore spends more inference calls.

| Predeclared scenario | Standard Base Qwen | Agent-Team Qwen | Supported conclusion |
|---|---:|---:|---|
| Engineering person-tracking architecture | 11/12 outcomes, 1 call, 3,112 tokens, 108.5s | 12/12 outcomes, 7 calls, 49,262 tokens, 671.6s | The team was more complete in this capture, but slower and more compute-intensive. |
| Match-3 launch marketing | 5/12 outcomes, 1 call, 2,166 tokens, 74.6s | 9/12 outcomes, 10 calls, 61,673 tokens, 755.7s | The team covered four additional decisions in fewer final-answer words (896 vs 1,034), but used much more time and compute. |
| Combined | 16/24 outcomes | 21/24 outcomes | A scoped two-example coverage result only; no universal superiority, latency, or cost claim. |

The public, redacted evidence is in `marketing/router-quality-showcase/complex-team-comparison/report.json`; private captures retain route validations, provider usage, catalog identity, and cleanup evidence under `outputs/product_marketing/qwen_team_showcase/`.

## Reproducible commands and retained evidence

```bash
npm test
npm run lint
npm run build
npm run test:e2e
npm run test:live:agent-builder
npm run test:live:discover-isolation
npm run test:live:marketing
npm run test:live:brainstorm
npm run test:live:workflow-commands
npm run marketing:qwen-comparison:test

/home/ubuntu/miniconda3/envs/tcar-qwen36/bin/python scripts/test_tcar_runtime_planner.py
/home/ubuntu/miniconda3/envs/tcar-qwen36/bin/python scripts/test_phase219_executor_data_plane.py
/home/ubuntu/miniconda3/envs/tcar-qwen36/bin/python scripts/test_agent_routing_v4.py
/home/ubuntu/miniconda3/envs/tcar-qwen36/bin/python scripts/test_agent_studio_fields_live.py
/home/ubuntu/miniconda3/envs/tcar-qwen36/bin/python scripts/verify_qwen_team_product_showcase.py
```

The live scripts use isolated web databases, unique Runtime agent IDs, and cleanup in `finally`. Current browser screenshots are retained in the project `outputs` directory:

- `agent_builder_ui_live_proof.png`
- `discover_team_isolation_ui_proof.png`
- `marketing_answer_ui_proof.png`
- `brainstorm_followup_ui_proof.png`
- `product_marketing/qwen_team_showcase/showcase-page.png`

External-provider boundary: OAuth discovery, callback validation, refresh, disconnect, approval, revocation, and recovery are implemented and tested. Automated verification deliberately does not send email, publish content, charge a real payment instrument, or modify a user's external SaaS account. Those actions require real credentials and explicit human approval by design.

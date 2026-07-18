# Workflow Composer production proof

## What is implemented

Both `/workflow ...` and `/workflow: ...` (and the equivalent `/agent` forms) now pass through one normalized agent-configuration compiler. Every created role has a behavior-bearing contract for:

- response style and tones;
- memory mode and allowed context;
- knowledge requirements and attached resources;
- least-privilege built-in and connected tools;
- typed inputs, outputs, routing cues, boundaries, and server-controlled stage;
- reusable handoff artifacts between upstream and downstream specialists.

The bounded response, tone, memory, and knowledge profile is also rendered into the Runtime specialist instruction. It therefore changes execution behavior instead of existing only as stored UI metadata; flat enforcement policies and tool/context allowlists remain separate and authoritative.

Source-first requests are handled in this order:

1. Detect that team design depends on connected source evidence.
2. Resolve the exact user-owned connection and a bounded read-only tool.
3. Preflight every requested provider before making the first external read.
4. Read a bounded sample under a server-issued, identity-bound grant.
5. Give observations to the session controller as explicitly untrusted data.
6. Validate the controller's evidence bindings and proposed permissions.
7. Show a source-informed team for a second confirmation.
8. Create agents only after that confirmation.

Raw source records are transient. Durable workflow state keeps provider/tool/schema/result digests, but not the source content. External text cannot add a provider, built-in tool, private knowledge resource, or side effect that was not authorized by the user's slash command.

Source-informed teams also pass through a bounded, server-authored role taxonomy. Source text may help select a reusable role, but it cannot become a durable agent title, task, capability, routing cue, handoff label, workflow title, or private knowledge reference. The same comprehensive profile round-trips through Agent Studio and reaches the Runtime specialist instructions used during execution.

## Comprehensive configuration scenarios

The HTTP-to-persistence suite executes these 20 workflows through command parsing, controller composition, normalization, confirmation, activation, and stored-agent verification:

| # | Scenario | Primary contract exercised |
|---:|---|---|
| 1 | Customer complaint | Careful, empathetic, conversational support |
| 2 | Math tutor | Patient educational tone and calculator |
| 3 | Legal document review | Careful attached-document grounding |
| 4 | Medical handout | Reassuring document-bounded summary |
| 5 | Repository reviewer | Technical repository-only access |
| 6 | Public research | Explicit public-web knowledge |
| 7 | CSV analyst | Structured-data context and calculation |
| 8 | Executive brief | Direct, concise professional output |
| 9 | Business planner | Thorough, persuasive tradeoff analysis |
| 10 | Project monitor | Ongoing conversation memory |
| 11 | Translator | One-off, stateless friendly response |
| 12 | Incident responder | Careful, calm technical response |
| 13 | Lesson designer | Thorough educational explanation |
| 14 | HR policy guide | Organization knowledge and diplomatic tone |
| 15 | Sales proposal | Persuasive professional output |
| 16 | Customer onboarding | Supportive ongoing memory |
| 17 | Scientific explainer | Thorough objective explanation |
| 18 | Accessibility guide | Clear supportive response |
| 19 | Product requirements | Direct practical artifact |
| 20 | Evidence auditor | Careful structured-data audit |

Additional tests run two different `/agent` workflows in the same session to prove that Math Tutor attributes do not leak into Customer Support, and verify a typed `verified_evidence -> evidence_based_answer` handoff.

## Source-first scenarios

The second HTTP-to-persistence matrix executes 20 source-informed workflows:

| # | Source scenario | Applications |
|---:|---|---|
| 1 | Complaint triage | Gmail |
| 2 | Policy library | Google Drive |
| 3 | Workload review | Google Calendar |
| 4 | Support themes | Google Chat |
| 5 | Outreach grouping | Google Contacts |
| 6 | Issue triage | GitHub |
| 7 | Feedback themes | Slack |
| 8 | Knowledge classification | Notion |
| 9 | Backlog bottlenecks | Linear |
| 10 | Store operations | Shopify |
| 11 | Customer pipeline | Salesforce |
| 12 | Support demand | Zendesk |
| 13 | Engineering work | Jira |
| 14 | Complaints plus stock | Gmail + Shopify |
| 15 | Release risk | GitHub + Slack |
| 16 | Internal guidance | Google Drive + Notion |
| 17 | Staffing needs | Google Calendar + Google Contacts |
| 18 | Unresolved customers | Salesforce + Zendesk |
| 19 | Delivery work | Linear + Jira |
| 20 | Cross-channel operations | Gmail + Google Drive + Slack |

Every case proves that reads occur before composition, no workflow agents exist before confirmation, two reusable roles are created afterward, connected tools are bound by exact connection, and the downstream role consumes the upstream agent's typed output.

## Edge and abuse cases

The automated proof also covers:

- missing connections remain agentless;
- multi-provider preflight is all-or-nothing before the first read;
- optional query fields are populated so reads are not limit-only account scans;
- required opaque IDs are never guessed;
- tools labeled `read` but named like create/update/post/archive operations are rejected twice (planner and gateway);
- source-aware controller failures fail closed rather than claiming a generic fallback used the evidence;
- provider, tool, and knowledge escalation attempted through source prompt injection is removed;
- raw email addresses, links, dates, phone numbers, and record IDs are not persisted into reusable role text;
- source-derived free text is reduced to reusable server-authored roles before any workflow field is persisted;
- private knowledge candidates are inherited only when the original slash command explicitly names them;
- thirteen providers can be inspected, assigned, and bound in one source-informed workflow without silent truncation;
- duplicate/mismatched evidence bindings and oversized source observations are rejected by the Runtime;
- an activated two-agent team executes both configured specialists and preserves its memory, knowledge, tool, and typed-handoff boundaries;
- a source-first workflow reads through a real local MCP HTTP transport, activates, and executes without persisting raw source content;
- activation interruption, Runtime registration cleanup, restart, and Marketplace-copy recovery remain green.

## Reproducible commands and results

```bash
cd /home/ubuntu/project/web/virenis
npm test -- --run \
  tests/workflowAgentConfig.test.js \
  tests/workflowAgentConfigurationE2E.test.js \
  tests/workflowSourceDiscovery.test.js \
  tests/workflowSourceFirstE2E.test.js \
  tests/productFeatures.test.js
```

Result: **201/201 passed**. The two E2E matrices contribute the 40 required real-life cases; the remaining 161 tests exercise compiler, discovery, source privacy and authorization, connection/reconfirmation, activation and execution, Agent Studio round-tripping, and failure contracts.

```bash
cd /home/ubuntu/project
/home/ubuntu/miniconda3/bin/conda run -n tcar-qwen36 \
  python scripts/test_runtime_workflow_composer.py
```

Result: `{"continuation_calls":4,"model":"qwen-workflow-proof","ok":true,"workflow_composer_calls":5}`. The proof includes 13- and 16-source requests and verifies the dynamic composer-output budget up to its 4,096-token hard cap.

The final full-project run passed **745/745 tests across 48 files**. ESLint, `git diff --check`, and the production Vite build also passed.

## Evidence boundary

Most application scenarios use deterministic provider fixtures, and one source-first E2E runs through an actual local MCP HTTP server. Together they prove ordering, authorization, contracts, persistence, privacy, retries, activation, and execution without reading a real customer's account. The Miniconda test exercises the production Python Runtime request/schema/controller code against a deterministic Qwen-compatible upstream, so it is reproducible and does not claim a live-model quality result. A live Qwen/vLLM and Gmail or other SaaS smoke test still requires reachable deployed services, a test account, and provider credentials; those secrets are intentionally not embedded in this repository.

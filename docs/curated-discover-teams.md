# Virenis curated Discover teams

Virenis publishes four first-party teams at the top of Discover: **Engineering**, **Marketing**, **Product**, and **Brainstorming**. Catalog revision `2026-07-v4` is server-owned, Verified, pinned in that order, and gives each team six agents. Public Marketplace fields cannot grant first-party verification or pinning.

Adding a listing creates a new private team and six new private agents for the signed-in user. Agent IDs, typed handoffs, and the canonical contract digest are remapped to the copy. Private knowledge, source files, credentials, MCP bindings, and connected-account access are never distributed.

## Shared contract and routing principles

Every role uses `virenis-agent-v4` and carries the same safe runtime envelope:

```json
{
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
  "lifecycle": { "state": "ready", "health": "healthy" }
}
```

Each role also declares a bounded capability, boundary, positive routing cues, `avoid_when` conditions, exact inputs and outputs, stage, evidence policy, and response profile. Every specialist produces one atomic typed handoff; this avoids duplicated prose/JSON claim surfaces and gives the next role one authoritative input. The final role is the only coordinator and the only producer of `final_answer`. It consumes all five specialist handoffs, making the saved graph a complete, acyclic terminal-owner contract.

Qwen sees all agents in the active team (maximum 16) and remains the primary semantic selector. Runtime independently validates IDs, outputs, permissions, lifecycle, and dependency closure. If the model response is invalid or unavailable, an exact action/output contract can recover the uniquely requested terminal owner and its complete DAG; ordinary deterministic cues remain the final bounded fallback. Runtime readiness also compares the configured 32,768-token context window with the provider's advertised `max_model_len`, preventing a smaller Qwen deployment from silently degrading selection.

The executor gives literal user constraints a content-bound `query:<digest>` identity and validated route results their own content-bound evidence IDs. Markers apply only to the clause or structured `claim:` field that carries them; they cannot spread across a semicolon or through sibling metadata to bless a new recommendation. One-output and terminal agents return only a validated domain answer, which the executor wraps into the declared artifact. Four-or-more-result fan-in uses a compact, coverage-preserving representation, and ordinary agent output has a 1,536-token ceiling.

If a terminal lead response fails only execution-evidence publication checks, Runtime may promote its complete set of already validated upstream results. This recovery is allowed only when every upstream route and the lead's consumption contract passed, there are no source, policy, lifecycle, or integrity failures, and the promoted result passes the same validator again. Rejected lead text is never published.

The Discover detail screen exposes the canonical lifecycle, normalized routing trust, memory scope, permission and approval envelope, instructions, inputs, outputs, and labeled handoff graph.

## Engineering

| Role | Primary outputs | Depends on |
|---|---|---|
| Requirements & Constraints Analyst | `engineering_brief` | Current request and session memory |
| Systems Architecture Agent | `architecture_decision_record` | Requirements |
| Delivery Planning Agent | `implementation_plan` | Requirements and Architecture |
| Security & Reliability Reviewer | `risk_register` | Requirements and Architecture |
| Verification & Rollout Agent | `verification_strategy` | Requirements, Architecture, Delivery, and Assurance |
| Engineering Lead Agent | `engineering_recommendation`, `final_answer` | All five roles |

The two middle reviews can proceed independently after Architecture. Verification reconciles delivery and assurance before the lead issues one traceable, rollback-safe recommendation.

## Marketing

| Role | Primary outputs | Depends on |
|---|---|---|
| Audience & Context Analyst | `audience_brief` | Current request and session memory |
| Evidence & Claims Steward | `claims_ledger` | Current request and session memory |
| Positioning Strategy Agent | `positioning_platform` | Audience and Evidence |
| Campaign Systems Designer | `campaign_system` | Audience, Evidence, and Positioning |
| Measurement & Learning Strategist | `measurement_framework` | Audience, Evidence, Positioning, and Campaign |
| Marketing Lead Agent | `marketing_plan`, `final_answer` | All five roles |

Audience and evidence work begins in parallel. Claims remain explicitly separated from hypotheses through positioning, campaign design, measurement, and final synthesis.

## Product

| Role | Primary outputs | Depends on |
|---|---|---|
| User Problem Analyst | `problem_brief` | Current request and session memory |
| Evidence & Assumption Auditor | `assumption_register` | Current request and session memory |
| Product Strategy Agent | `product_strategy` | Problem and Evidence |
| Experience & Requirements Designer | `experience_blueprint` | Problem and Strategy |
| Prioritization & Validation Planner | `prioritized_scope` | Evidence, Strategy, and Experience |
| Product Lead Agent | `product_decision_brief`, `final_answer` | All five roles |

The graph prevents feature preferences from masquerading as evidence and ends with the smallest coherent scope that can change a product decision.

## Brainstorming

| Role | Primary outputs | Depends on |
|---|---|---|
| Challenge Framing Agent | `challenge_frame` | Current request and session memory |
| Divergent Ideas Agent | `idea_portfolio` | Challenge frame |
| Perspective & Analogy Agent | `alternative_lenses` | Challenge frame |
| Feasibility & Originality Reviewer | `screened_concepts` | Frame, Ideas, and Perspectives |
| Concept Experiment Designer | `concept_experiments` | Frame and Feasibility review |
| Brainstorming Facilitator Agent | `concept_shortlist`, `final_answer` | All five roles |

Ideas and perspectives run in parallel. Convergence preserves materially different options, and every finalist receives a low-regret, decision-changing experiment.

## Proofs

The deterministic integration suite copies each listing, binds it to a new chat, runs two same-session turns, and proves canonical ID remapping, six valid outputs, exact typed handoffs, bounded parallelism, retained user memory, tenant isolation, and a non-empty final answer.

The live proof uses the current web application and real GPU Runtime. It loads Discover through the web API, copies and registers each team, sends natural prompts without agent IDs, verifies all six agents were visible to Qwen, executes the GPU DAG, validates every handoff and usage receipt, settles billing, and purges all temporary agents:

```bash
node scripts/test_curated_discover_live.mjs
# Optional focused replay:
CURATED_LIVE_TEAMS=Engineering node scripts/test_curated_discover_live.mjs
```

The `2026-07-v4` live run completed all four teams with 24/24 validated route outputs:

| Team | Visible to Qwen | Selected | Valid outputs | Maximum parallel width | Terminal publication |
|---|---:|---:|---:|---:|---|
| Engineering | 6 | 6 | 6 | 1 | Validated-upstream recovery |
| Marketing | 6 | 6 | 6 | 2 | Direct lead result |
| Product | 6 | 6 | 6 | 2 | Validated-upstream recovery |
| Brainstorming | 6 | 6 | 6 | 1 | Validated-upstream recovery |

Every live proof ended with zero reserved billing credits, deletion of its temporary workspace, and archive/purge of all copied agents.

Standard verification:

```bash
npm test -- --run tests/curatedMarketplace.test.js tests/curatedTeamsE2E.test.js tests/productFeatures.test.js tests/agentContract.test.js
npm run lint
npm run build
```

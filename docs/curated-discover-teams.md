# Virenis curated Discover teams

Virenis ships four first-party teams at the top of Discover: **Engineering**, **Marketing**, **Product**, and **Brainstorming**. Each listing is published by Virenis, carries a server-derived Verified label, and is pinned in that order. Verified and pinned status cannot be supplied through the public publishing API.

Adding a team creates a new private team and four new private agents in the signed-in user's workspace. Agent IDs and handoffs are remapped to the copy. Private knowledge, source files, credentials, MCP bindings, and connected-account access are never distributed with a listing.

## Shared configuration principles

Every curated role:

- uses the selected session's relevant conversation memory (`shared_memory` with `memory.mode = conversation`);
- relies on user-provided context and, for downstream roles, verified upstream-specialist handoffs;
- has a bounded purpose, explicit limits, response style, tone, routing cues, and named outputs;
- uses no external tool by default, so the team works without a connection and never implies that it checked a repository, private account, or current source;
- preserves uncertainty and separates supplied facts from assumptions.

The Discover detail screen exposes each role's instructions, response profile, memory source, knowledge requirements, inputs, outputs, and routing cues. It also shows the team's labeled handoff graph.

## Engineering

| Role | Primary output | Receives from |
|---|---|---|
| Requirements & Architecture Agent | Engineering brief, architecture options, acceptance criteria | User request and this chat |
| Implementation Planning Agent | Implementation plan, interface contracts, delivery sequence | Architecture Agent |
| Quality & Security Agent | Risk register, test strategy, review findings | Architecture and Implementation Agents |
| Engineering Lead Agent | Engineering recommendation, decision log, next actions | All three specialists |

The team deliberately sequences definition before planning and review. The lead cannot produce its final recommendation until all required handoffs validate.

## Marketing

| Role | Primary output | Receives from |
|---|---|---|
| Audience Insight Agent | Audience brief, motivations, evidence gaps | User request and this chat |
| Positioning Strategy Agent | Positioning platform, message hierarchy, proof requirements | Audience Agent |
| Campaign Design Agent | Campaign concepts, channel plan, content brief | Audience and Positioning Agents |
| Marketing Lead Agent | Marketing plan, approved messages, next actions | All three specialists |

The contracts explicitly forbid invented market research, survey findings, quotes, and unsupported claims.

## Product

| Role | Primary output | Receives from |
|---|---|---|
| User Problem Agent | Problem brief, user needs, assumption map | User request and this chat |
| Product Strategy Agent | Product strategy, principles, strategic options | Problem Agent |
| Prioritization & Validation Agent | Prioritized scope, validation plan, delivery risks | Problem and Strategy Agents |
| Product Lead Agent | Product decision brief, decision log, next experiment | All three specialists |

The team keeps assumptions visible and favors the smallest coherent validation of value over an unbounded feature list.

## Brainstorming

| Role | Primary output | Receives from |
|---|---|---|
| Divergent Ideas Agent | Varied idea pool and idea dimensions | User request and this chat |
| Perspective Shift Agent | Alternative lenses, surprising connections, reframed questions | User request and this chat |
| Feasibility & Originality Agent | Screened concepts, tradeoffs, open questions | Both divergent specialists |
| Brainstorming Facilitator Agent | Concept shortlist, rationale, next experiments | All three specialists |

The first two roles can run in parallel. Convergence happens only after both viewpoints are available, preserving variety without returning an unfiltered idea dump.

## Realistic same-session proofs

The integration suite copies each listing into a user tenant, starts a clean chat, selects the copied team, and sends both prompts naturally—without forcing agent IDs.

| Team | First turn | Follow-up in the same chat |
|---|---|---|
| Engineering | “Create an engineering plan for Project Cedar: add passwordless login to a Node.js and PostgreSQL SaaS with no downtime, no forced logout, and a reversible rollout.” | “Revise the engineering plan for Project Cedar to fit two weeks while keeping the earlier no-downtime, no-forced-logout, and reversible-rollout constraints.” |
| Marketing | “Create a marketing plan for Moss Bottle, a refillable household cleaner for apartment renters who want less plastic, using email and short-form video with a calm, playful voice.” | “Revise the marketing plan for Moss Bottle into a four-week campaign while keeping the earlier audience, channels, and calm playful voice.” |
| Product | “Create a product brief for PantryPair, a shared grocery-list app for roommates, prioritizing offline edits, conflict resolution, and simple onboarding while excluding social feeds.” | “Revise the product brief for PantryPair to ship in one month; keep the earlier users, priorities, and no-social-feed constraint, and state what to defer.” |
| Brainstorming | “Create a concept shortlist for Project Lantern: help neighborhood libraries attract teenagers after school with low-cost, inclusive ideas and no new construction.” | “Turn the concept shortlist for Project Lantern into one six-week pilot while keeping the earlier low-cost, inclusive, and no-new-construction constraints.” |

For every pair, the tests prove:

1. the Router naturally selects the lead from the prompt and recursively includes its saved dependencies;
2. exactly the four copied team agents execute—no default or unrelated agent appears;
3. all named handoff artifacts validate and the lead consumes at least three verified upstream artifacts;
4. the first turn has no earlier memory, while every role receives allowed user-session memory on the follow-up;
5. the same private copied team remains selected throughout the conversation;
6. all runs complete with a non-empty final answer.

These are deterministic application integration proofs, not claims about subjective model quality or a live-provider benchmark. They validate the product contracts, routing, tenancy, handoffs, and memory behavior independently of provider variability.

## Verification commands

```bash
npm test -- --run tests/curatedMarketplace.test.js tests/curatedTeamsE2E.test.js tests/productFeatures.test.js tests/agentWorkspaces.test.js
npm run lint
npm run build
```

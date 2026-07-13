# virenis UI/UX notes

Updated: 2026-07-12

## Product surface

virenis presents one familiar chat workspace. Users should not have to
understand TCAR, TCAndon, vLLM, or LoRA mechanics to ask a question. Those names
belong in operator diagnostics and provenance, not primary interface copy.

The current surface is intentionally restrained:

- a header with the lowercase `virenis` wordmark, history, new chat, and account
  controls;
- a centered conversation thread with plain-language run progress;
- one composer with knowledge upload, `@agent` selection, and a LoRA session
  picker beside the attachment control;
- a chat-history sheet rather than a permanent left rail;
- an Agent Studio sheet with `Agents`, `LoRAs`, `Graph`, `Marketplace`,
  `Knowledge`, and admin-only `Admin` views;
- an Answer details sheet with `Agents`, `Sources`, `Outcomes`, and `Activity`;
- focused dialogs for agent, document, settlement, dispute, and correction
  workflows;
- confirmations before destructive archive or deletion actions.

There is no permanent right operations rail or collection of separate dashboard
pages. The Obsidian-inspired relationship graph is deliberately on demand inside
Agent Studio: nodes are draggable, positions persist per workspace, and arrows
represent configured handoffs or knowledge relationships.

## Interaction principles

- Keep chat primary on desktop and mobile. Secondary state opens only when the
  user asks for it.
- Use familiar icons for commands and provide an accessible label and tooltip
  for every icon-only button.
- Explain routing beside the answer in plain language. Show selected agents,
  their contribution, RealityRank tie-break context, verified sources, outcome
  state, activity, and the execution record without exposing hidden reasoning.
- Surface lifecycle state honestly: ready, preparing, archived, needs an owner,
  tracking only, disputed, or verified for ranking.
- Treat unavailable metrics as unavailable, never as a fabricated zero.
- Keep destructive controls ownership-aware and confirmation-gated.
- Preserve keyboard focus within sheets/dialogs, restore focus on close, and
  keep controls usable without pointer input.
- Keep source excerpts and PDF page/chunk provenance close to the answer that
  used them.

## Role behavior

- Ordinary users can manage their own private agents and knowledge.
- Administrators can adopt runtime-only agents, inspect service state, and run
  workspace checks.
- Viewers receive a read-only surface with mutation controls disabled or absent
  according to the action.
- Cross-workspace resources are not discoverable through lists or direct ids.

## Responsive behavior

The conversation remains the default viewport at every width. History,
resources, and answer details use modal sheets that cover only the space they
need and close predictably. Labels, status text, and actions must wrap without
overlap; no fixed-format control may resize when dynamic status text changes.

## Evidence over promotion

The interface should show actual citations, run state, selected agents,
outcomes, revision history, and integrity identifiers. It should not display
unsupported claims about intelligence, accuracy, production throughput, or live
proof status.

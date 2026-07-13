# Demo 1 evidence: textile business-plan handoff

This directory contains the sanitized public evidence for an isolated comparison using the same user prompt in both arms:

- **Base arm:** one direct `qwen36-awq` completion.
- **Router arm:** the Router selects a Textile Agent and a Business Plan Agent, the runtime compiles the declared handoff, and the Business Plan Agent consumes the Textile Agent's verified brief.

The two role adapters deliberately use the repository's zero-effect adapter identity. Its metadata states `no-op; all LoRA tensors are zeros`. This capture therefore demonstrates routing, scoped instructions, source grounding, and a validated agent handoff. It does **not** claim that trained textile or business-plan LoRA weights caused the difference.

The production manifest is never read or written by the capture. A dedicated capture harness builds an isolated executable fixture, uses a separate audit ledger, temporarily mounts two uniquely named adapter identities, and unloads them in a guaranteed cleanup step.

`agent_team_fixture.json` and `textile_playbook.md` are the stable public fixtures. Generated public JSON contains only curated prompts, answers, handoff facts, and content-addressed receipt identifiers. Exact low-level requests, responses, execution records, and the private audit database are retained outside the marketing tree.

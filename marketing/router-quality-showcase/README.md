# Router in action

Six marketing frames show three captured demonstrations:

1. A Textile Agent creates a verified industry brief, then a Business Plan Agent consumes that handoff.
2. Router selects two document-source agents; server-owned workflow rules append a downstream Analysis Agent and compile both dependencies.
3. A Live Events Agent calls a bounded official USGS feed for a current earthquake question.

Each demonstration includes an observable route frame and a same-prompt comparison frame. The visuals show selected roles, scoped source retrieval, validated handoffs, tool actions, and final outputs. They do not show or claim private chain-of-thought.

## Evidence rules

- The base path receives the identical user prompt.
- In the document demo, the base prompt also receives the complete text of both documents.
- Captured answers are not rewritten to manufacture a difference.
- No aggregate score or broad benchmark claim is made.
- Role adapters in these demonstrations use zero-effect weights. The evidence supports routing, scoped context, handoffs, document retrieval, and tool grounding—not a newly trained domain-weight uplift.
- The company, country, and textile playbook are clearly labeled synthetic fixtures. The earthquake frame is a timestamped point-in-time USGS snapshot.

Public, presentation-safe evidence is retained under `evidence/`. Native execution records and audit data are retained separately under `outputs/router_marketing_demos/` at the project root.

## Regenerate

Run the three capture scripts inside the project’s serving Miniconda environment:

```bash
python scripts/capture_router_marketing_demo1.py
python scripts/capture_router_demo2.py
python scripts/capture_router_marketing_demo3.py
```

Render the SVG masters, 1920×1080 PNGs, and contact sheet from `web/virenis`:

```bash
npm run marketing:router-quality
```

Verify naming, public evidence hashes, the USGS snapshot, campaign status, and all six frame pairs:

```bash
python scripts/verify_router_marketing_evidence.py
```

## Same-model complex-team field test

`complex-team-comparison/` is a separate, data-backed product page comparing
Standard Base Qwen with Agent-Team Qwen on two predeclared complex scenarios.
It intentionally distinguishes output efficiency from compute efficiency.

The positive Marketing example is the publishable scenario-specific claim:
the team covered 9/12 required outcomes versus 5/12 for Base, in 896 versus
1,034 answer words. Engineering covered 12/12 versus Base's 11/12. Across the
two predeclared examples the result is 21/24 versus 16/24, but the team used
substantially more inference calls, tokens, and wall time. The page therefore
makes no universal superiority, latency, or cost claim; those claims remain
governed by the 200-case benchmark contract.

Capture or rebuild the report from the project root:

```bash
python scripts/capture_qwen_team_product_showcase.py --resume
python scripts/verify_qwen_team_product_showcase.py
```

Exercise the actual page in Chromium, run its accessibility audit, and create
the full-page proof image:

```bash
cd web/virenis
npm run marketing:qwen-comparison:test
```

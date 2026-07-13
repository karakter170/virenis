# Ten-document stress-test viewer

This directory is an additive, standalone viewer for four future marketing visuals. It does not replace or modify the existing Router showcase.

## Expected exports

Place these PNG files in an `exports/` directory beside `index.html`:

| File | Navigation label | Presentation | Content contract |
| --- | --- | --- | --- |
| `07-ten-document-route.png` | Route | 16:9 stage | Observable document and agent flow |
| `08-ten-document-comparison.png` | Comparison | 16:9 stage | Evidence-backed result comparison |
| `09-base-full-output.png` | Base full output | Tall, scrollable view | Complete captured base answer |
| `10-router-full-output.png` | Router full output | Tall, scrollable view | Complete captured Router answer |

Until an export exists, the viewer displays a neutral pending state with the expected path. It does not substitute a mock result.

## Evidence contract

Full-output images must be unabridged and evidence-backed. They must show the complete captured answer without an editorial rewrite, omitted section, cropping, or truncation. Every displayed comparison claim must remain traceable to the accompanying evidence:

- [Full-output evidence](../evidence/demo4/full-outputs.json)
- [Evidence summary](../evidence/demo4/evidence-summary.json)

Only observable routing, captured outputs, and execution evidence belong in the public visuals. Do not publish private hidden reasoning.

## Navigation and accessibility

The four views are implemented as an accessible tab set. Select a view with a pointer, or focus a tab and use Left Arrow, Right Arrow, Home, or End. The layout collapses from four columns to two and then one on smaller screens, honors reduced-motion preferences, includes visible focus states, and exposes meaningful image alternatives.

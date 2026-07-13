# Demo 2: two documents, three-agent analysis

This evidence set uses two short synthetic documents and one simple user request. The Router selects the two source agents. Server-owned deterministic orchestration then appends the manifest-declared downstream Analysis Agent, compiles both dependencies, runs the sources in parallel, and passes their validated findings forward. The user supplies neither a plan nor agent identifiers.

The base model receives the identical document text and question in its prompt. This keeps the information available to both sides equivalent.

Public evidence in this folder is presentation-safe and uses the name “Router.” Exact internal captures and their receipts are retained separately under `outputs/router_marketing_demos/demo2/`; the public integrity manifest binds those captures by SHA-256.

The three role adapters are seeded zero-effect adapters. Their tensors are all zeros, so this demo isolates the value of routing, retrieval, validation, handoffs, synthesis, and citations. It is not evidence of a gain from newly trained specialist weights.

The fictional company and country are demonstration fixtures, not real-world claims.

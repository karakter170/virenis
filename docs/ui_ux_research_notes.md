# TCAR Chat UI/UX Research Notes

Date: 2026-07-09

## Product Surface

The app should present TCAR as one familiar chat workspace with inspectable routing, not as many separate bots. The primary screen is:

- Left rail: conversations, session history, and live system status.
- Center: chat thread, current run status, answer actions, upload entry point, and composer.
- Right rail: route graph, quick agent/document actions, runtime health, event trail, and operational signals.

## Research Inputs

- NN/g chatbot guidance: users should not need to understand internal architecture to get help, and competing chatbot entry points should be consolidated into one clear assistant surface.
  Source: https://www.nngroup.com/articles/ai-chatbots-design-guidelines/

- NN/g explainable AI guidance: explanation text alone often fails; explanation should be tied to the actual output and decision context.
  Source: https://www.nngroup.com/articles/explainable-ai/

- Obsidian Graph View: node/link graphs are effective when direction, grouping, and color encode relationships.
  Source: https://obsidian.md/help/plugins/graph

- Material motion guidance: motion should clarify relationships, available actions, and outcomes rather than act as decoration.
  Source: https://m2.material.io/design/motion/understanding-motion.html

## Design Implications

- Keep the chat entry point singular. TCAR can route internally, but the user should still feel like they are in one conversation.
- Make routing inspectable. The graph should reveal which route identities participated, which dependencies were used, and which sources/documents were selected.
- Use live signals instead of marketing claims. Runtime health, mounted agents, DAG links, event trail, document count, and validation state make the backend/GPU features visible.
- Use motion only during inference. Edge pulses and route-node firing should communicate active work and dependency flow.
- Keep mobile chat-first. The inspector is useful but should not cover the conversation by default on small screens.
- Show gated data honestly. Non-admin metrics should read as unavailable rather than zero.

## Current UI Features To Preserve

- Past conversations visible in the left rail.
- ChatGPT/Gemini/Claude-style message thread and composer.
- Right-side quick actions for route agent creation, document-agent registration, and validation.
- Obsidian-like execution graph with route, agent, document, source, runtime, and chat nodes.
- Animated graph pulses while a run is active.
- Runtime operations panel with mounted agents, documents, run status, runtime health, latest event, and recent event trail.
- Responsive mobile layout with history visible and inspector closed by default.

## Production UX Risks

- If real GPU/vLLM health is degraded, the UI must say so plainly and still let the user understand whether they are seeing simulator output.
- Admin-only controls should remain visible but disabled with clear affordance; hiding them makes the product capability harder to discover.
- The graph can become dense with many agents. Keep labels short, show details on hover/focus, and avoid using the graph as the only way to understand the answer.
- PDF/document uploads should surface chunk/source provenance in answers, not just in the inspector.

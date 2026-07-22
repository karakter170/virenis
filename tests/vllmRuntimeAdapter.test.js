import request from "supertest";
import { describe, expect, it } from "vitest";
import { createVllmRuntimeAdapter } from "../server/vllmRuntimeAdapter.js";

const servedModels = [
  "qwen36-awq",
  "software_architect_lora",
  "security_review_lora",
  "project_planning_lora",
  "writing_synthesis_lora"
];

describe("vLLM runtime adapter", () => {
  it("protects its API and normalizes the vLLM model catalog", async () => {
    const app = createVllmRuntimeAdapter({
      vllmBaseUrl: "https://gpu.example.test/v1",
      vllmApiKey: "vllm-secret",
      runtimeApiKey: "runtime-secret",
      fetchImpl: async (_url, options) => {
        expect(options.headers.Authorization).toBe("Bearer vllm-secret");
        return jsonResponse({ data: servedModels.map((id) => ({ id, object: "model" })) });
      }
    });

    await request(app).get("/models").expect(401);
    const response = await request(app)
      .get("/models")
      .set("X-TCAR-API-Key", "runtime-secret")
      .expect(200);
    expect(response.body.base_model).toBe("qwen36-awq");
    expect(response.body.models.map((model) => model.id)).toEqual(servedModels);
  });

  it("runs selected LoRA routes and synthesizes with the base model", async () => {
    const calls = [];
    const app = createVllmRuntimeAdapter({
      vllmBaseUrl: "https://gpu.example.test/v1",
      vllmApiKey: "vllm-secret",
      runtimeApiKey: "runtime-secret",
      fetchImpl: async (url, options = {}) => {
        if (new URL(url).pathname.endsWith("/models")) {
          return jsonResponse({ data: servedModels.map((id) => ({ id })) });
        }
        const body = JSON.parse(options.body);
        calls.push(body);
        if (body.model === "qwen36-awq") {
          const systemPrompt = String(body.messages?.[0]?.content || "");
          if (systemPrompt.includes("semantic agent selector")) {
            // A valid but under-selected primary answer must never become a
            // keyword fallback. The independent model review gets the whole
            // utterance and complete active team and may replace it.
            return completionResponse(JSON.stringify({
              decision: "direct",
              intent: "software rollout",
              reason: "Primary model under-selected.",
              clarification_question: "",
              steps: []
            }));
          }
          if (systemPrompt.includes("independent final semantic authority")) {
            return completionResponse(JSON.stringify({
              decision: "delegate",
              intent: "Plan and review a secure software API rollout.",
              reason: "The active specialists materially improve this engineering request.",
              clarification_question: "",
              steps: [
                { adapter: "software_architect_lora", task: "Design the API rollout architecture.", confidence: 0.97 },
                { adapter: "security_review_lora", task: "Review security and failure modes.", confidence: 0.96 },
                { adapter: "project_planning_lora", task: "Build the phased delivery plan.", confidence: 0.95 },
                { adapter: "writing_synthesis_lora", task: "Synthesize the specialist work.", confidence: 0.94 }
              ]
            }));
          }
          return completionResponse("Use authenticated server-side calls and verify the rollout.");
        }
        return completionResponse([
          "AGENT_REASONING:",
          "This route matches the request.",
          "DOMAIN_ANSWER:",
          `${body.model} answer`,
          "HANDOFFS:",
          "Pass this result to synthesis.",
          "BOUNDARY_CHECK:",
          "Stay within the route boundary."
        ].join("\n"));
      }
    });

    const response = await request(app)
      .post("/chat/execute")
      .set("X-TCAR-API-Key", "runtime-secret")
      .send({
        query: "Good, thank you. How do I plan a security-reviewed software API rollout?",
        shared_memory: [{ tag: "user_request", source: "user", content: "Hi, how are you?" }],
        options: {
          team_adapters: [
            "software_architect_lora",
            "security_review_lora",
            "project_planning_lora",
            "writing_synthesis_lora"
          ],
          parallel_workers: 2,
          max_tokens: 80,
          refiner_max_tokens: 220
        }
      })
      .expect(200);

    expect(response.body.ok).toBe(true);
    expect(response.body.finalAnswer).toContain("authenticated server-side calls");
    expect(response.body.expertOutputs.map((output) => output.adapter)).toEqual(expect.arrayContaining([
      "software_architect_lora",
      "security_review_lora",
      "project_planning_lora",
      "writing_synthesis_lora"
    ]));
    expect(response.body.semanticSelection).toMatchObject({
      authority: "qwen_semantic",
      primary_valid: true,
      adjudication_attempted: true,
      adjudication_accepted: true,
      accepted_stage: "adjudication"
    });
    expect(response.body.semanticSelection.catalog_checked).toEqual([
      "software_architect_lora",
      "security_review_lora",
      "project_planning_lora",
      "writing_synthesis_lora"
    ]);
    const semanticCalls = calls.filter((call) => (
      String(call.messages?.[0]?.content || "").includes("semantic")
    ));
    expect(semanticCalls).toHaveLength(2);
    expect(semanticCalls.every((call) => (
      String(call.messages?.[0]?.content || "").includes("Never")
      && String(call.messages?.[0]?.content || "").includes("language")
    ))).toBe(true);
    expect(calls.at(-1).model).toBe("qwen36-awq");
    expect(calls.every((call) => call.chat_template_kwargs.enable_thinking === false)).toBe(true);
  });
});

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function completionResponse(content) {
  return jsonResponse({ choices: [{ message: { content }, finish_reason: "stop" }] });
}

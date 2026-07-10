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
        query: "Plan a security-reviewed software API rollout.",
        shared_memory: [],
        options: { parallel_workers: 2, max_tokens: 80, refiner_max_tokens: 220 }
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

import { describe, expect, it } from "vitest";

import { buildParallelBatches, planRoutes, resolveAgentContext } from "../server/tcarEngine.js";


function artifact({ name, value, producer, stepId, contentType = "application/json" }) {
  return {
    artifact_id: `${stepId}:${name}:fixture`,
    schema_version: "tcar-handoff-artifact-v1",
    name,
    value,
    producer,
    producer_step_id: stepId,
    content_type: contentType,
    evidence: [],
    confidence: 1,
    verified: true
  };
}


describe("canonical Agent Studio execution contract", () => {
  const memory = [{ tag: "preference", source: "user", content: "Use amber." }];
  const documentOutput = {
    step_id: "s1",
    adapter: "document_agent",
    artifact_validation: { declared_produces: ["retrieved_context"] },
    handoff_artifacts: [artifact({
      name: "retrieved_context",
      value: "The approved catalog color is amber.",
      producer: "document_agent",
      stepId: "s1",
      contentType: "text/plain"
    })]
  };
  const tableOutput = {
    step_id: "s2",
    adapter: "table_agent",
    artifact_validation: { declared_produces: ["structured_data"] },
    handoff_artifacts: [artifact({
      name: "structured_data",
      value: [{ item: "scarf", status: "ready" }],
      producer: "table_agent",
      stepId: "s2"
    })]
  };

  it("resolves attached-document and specific-agent context without leaking memory", () => {
    const result = resolveAgentContext({
      agent: {
        id: "analysis_agent",
        consumes: ["user_request", "document_context", "agent:document_agent:output"]
      },
      step: { id: "s3", adapter: "analysis_agent", depends_on: ["s1"] },
      upstream: [documentOutput, tableOutput],
      sharedMemory: memory
    });

    expect(result.validation.valid).toBe(true);
    expect(result.validation.resolved_contract_inputs).toEqual([
      "agent:document_agent:output",
      "document_context"
    ]);
    expect(result.consumed_artifacts.map((row) => row.name)).toEqual(["retrieved_context"]);
    expect(result.used_memory).toEqual([]);
  });

  it("maps structured and aggregate context, while keeping producer scope exact", () => {
    const optionalTableResult = resolveAgentContext({
      agent: { id: "document_consumer", consumes: ["user_request", "document_context", "table_context"] },
      step: { id: "s3", adapter: "document_consumer", depends_on: ["s1"] },
      upstream: [documentOutput]
    });
    expect(optionalTableResult.validation.valid).toBe(true);
    expect(optionalTableResult.validation.missing_from_upstream).toEqual([]);
    expect(optionalTableResult.validation.unresolved).toContain("table_context");

    const tableResult = resolveAgentContext({
      agent: { id: "table_consumer", consumes: ["user_request", "table_context"] },
      step: { id: "s3", adapter: "table_consumer", depends_on: ["s2"] },
      upstream: [documentOutput, tableOutput]
    });
    expect(tableResult.validation.valid).toBe(true);
    expect(tableResult.consumed_artifacts.map((row) => row.name)).toEqual(["structured_data"]);

    const aggregateResult = resolveAgentContext({
      agent: { id: "synthesizer", consumes: ["user_request", "upstream_route_outputs"] },
      step: { id: "s4", adapter: "synthesizer", depends_on: ["s1", "s2"] },
      upstream: [documentOutput, tableOutput]
    });
    expect(aggregateResult.validation.valid).toBe(true);
    expect(aggregateResult.consumed_artifacts.map((row) => row.name)).toEqual([
      "retrieved_context",
      "structured_data"
    ]);
  });

  it("delivers conversation memory only when declared and fails closed on a missing graph handoff", () => {
    const withMemory = resolveAgentContext({
      agent: { id: "memory_agent", consumes: ["user_request", "shared_memory"] },
      step: { id: "s3", adapter: "memory_agent", depends_on: [] },
      sharedMemory: memory
    });
    expect(withMemory.used_memory).toEqual(memory);

    const missingHandoff = resolveAgentContext({
      agent: { id: "consumer", consumes: ["user_request", "agent:missing_agent:output"] },
      step: { id: "s3", adapter: "consumer", depends_on: [] },
      upstream: [documentOutput]
    });
    expect(missingHandoff.validation.valid).toBe(false);
    expect(missingHandoff.validation.missing_from_upstream).toEqual(["agent:missing_agent:output"]);
  });

  it("rejects tampered values and producer spoofing before context reaches an agent", () => {
    const original = documentOutput.handoff_artifacts[0];
    const tampered = resolveAgentContext({
      agent: { id: "consumer", consumes: ["upstream_route_outputs"] },
      step: { id: "s3", adapter: "consumer", depends_on: ["s1"] },
      upstream: [{
        ...documentOutput,
        handoff_artifacts: [{
          ...original,
          value: "A tampered value.",
          content_digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000"
        }]
      }]
    });
    expect(tampered.validation.valid).toBe(false);
    expect(tampered.validation.rejected).toEqual(["upstream_digest_mismatch:retrieved_context"]);

    const spoofed = resolveAgentContext({
      agent: { id: "consumer", consumes: ["upstream_route_outputs"] },
      step: { id: "s3", adapter: "consumer", depends_on: ["s1"] },
      upstream: [{
        ...documentOutput,
        handoff_artifacts: [{ ...original, producer: "different_agent" }]
      }]
    });
    expect(spoofed.validation.valid).toBe(false);
    expect(spoofed.validation.rejected).toEqual(["upstream_producer_mismatch:retrieved_context"]);
  });

  it("compiles aggregate context into a deterministic handoff edge", () => {
    const agents = [
      {
        id: "source_agent",
        title: "Source Agent",
        capability: "Collect source facts.",
        routing_cues: [],
        consumes: ["user_request"],
        produces: ["evidence_summary"],
        resources: [],
        enabled: true,
        mounted: true
      },
      {
        id: "analysis_agent",
        title: "Analysis Agent",
        capability: "Analyze supplied facts.",
        routing_cues: [],
        consumes: ["user_request", "upstream_route_outputs"],
        produces: ["recommendations"],
        resources: [],
        enabled: true,
        mounted: true
      },
      {
        id: "writing_synthesis_lora",
        title: "Writing Synthesis",
        capability: "Synthesize route outputs.",
        routing_cues: [],
        consumes: ["upstream_route_outputs"],
        produces: ["final_answer"],
        resources: [],
        enabled: true,
        mounted: true
      }
    ];
    const plan = planRoutes({
      query: "Use @source_agent and @analysis_agent.",
      agents,
      maxRoutingAdapters: 4
    });
    const analysis = plan.steps.find((step) => step.adapter === "analysis_agent");
    const source = plan.steps.find((step) => step.adapter === "source_agent");
    expect(analysis.depends_on).toContain(source.id);
  });

  it("keeps independent document-backed agents parallel despite their semantic context aliases", () => {
    const documentAgent = (id, title) => ({
      id,
      title,
      capability: `Retrieve cited evidence from ${title}.`,
      routing_cues: [],
      consumes: ["user_request", "document_context"],
      produces: ["retrieved_context", "cited_passages"],
      resources: [id],
      retrieval: { type: "document_markdown", index_path: `sources/${id}/index.jsonl` },
      document: { slug: id, title },
      enabled: true,
      mounted: true
    });
    const agents = [
      documentAgent("policy_document", "Policy document"),
      documentAgent("telemetry_document", "Telemetry document"),
      {
        id: "writing_synthesis_lora",
        title: "Writing Synthesis",
        capability: "Synthesize route outputs.",
        routing_cues: [],
        consumes: ["upstream_route_outputs"],
        produces: ["final_answer"],
        resources: [],
        enabled: true,
        mounted: true
      }
    ];

    const plan = planRoutes({
      query: "Ask @policy_document and @telemetry_document, then compare their evidence.",
      agents,
      maxRoutingAdapters: 2
    });
    const policy = plan.steps.find((step) => step.adapter === "policy_document");
    const telemetry = plan.steps.find((step) => step.adapter === "telemetry_document");
    const synthesis = plan.steps.find((step) => step.adapter === "writing_synthesis_lora");

    expect(policy.depends_on).toEqual([]);
    expect(telemetry.depends_on).toEqual([]);
    expect(synthesis.depends_on).toEqual([policy.id, telemetry.id]);
    expect(buildParallelBatches(plan.steps, 2)).toMatchObject({
      parallelizable: true,
      maxBatchWidth: 2
    });
  });
});

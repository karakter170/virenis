import { describe, expect, it } from "vitest";
import { chunkDocument, documentIndexDigest, documentRevision } from "../server/documents.js";
import { digestValue } from "../server/outcomes.js";
import {
  prepareWorldGraphReplay,
  previewWorldGraphRun,
  pruneExpiredWorldGraphData,
  publicWorldGraphSnapshot,
  recordWorldGraphRun,
  selectWorldGraphSeedForStep,
  verifyWorldGraphArtifact,
  worldGraphReplayCapsule
} from "../server/worldGraph.js";

function signedCapsulePayload(wrapper) {
  expect(Object.keys(wrapper).sort()).toEqual(["encoding", "signature", "signed_payload"]);
  expect(wrapper.encoding).toBe("json-utf8-exact-v1");
  expect(wrapper.signature).toMatch(/^[a-f0-9]{64}$/);
  return JSON.parse(wrapper.signed_payload);
}

function agent(id, patch = {}) {
  return {
    id,
    title: id.replaceAll("_", " "),
    capability: `Handle the ${id} branch.`,
    boundary: "Use only validated inputs.",
    consumes: [],
    produces: [`${id}_result`],
    routing_cues: [id],
    resources: [],
    tools: [],
    sources: [],
    enabled: true,
    stage: 20,
    ...patch
  };
}

function routeOutput(step, version = "v1", patch = {}) {
  const value = `${step.adapter}:${version}`;
  const artifact = {
    artifact_id: `handoff_${step.id}_${version}`,
    schema_version: "tcar-handoff-artifact-v1",
    name: `${step.adapter}_result`,
    artifact: `${step.adapter}_result`,
    value,
    content_digest: digestValue(value),
    producer: step.adapter,
    producer_step_id: step.id,
    evidence: [],
    confidence: 1,
    verified: true
  };
  return {
    id: step.id,
    step_id: step.id,
    adapter: step.adapter,
    task: step.task,
    depends_on: step.depends_on || [],
    used_upstream: step.depends_on || [],
    domain_answer: `${step.adapter} produced ${version}.`,
    handoff_artifacts: [artifact],
    citations: [],
    policy_violations: [],
    artifact_validation: { valid: true, produced: [artifact.name], declared_produces: [artifact.name] },
    consumption_validation: { valid: true, resolved_contract_inputs: [] },
    source_validation: { valid: true, violations: [] },
    used_memory: [],
    allowed_tools: [],
    tool_executions: [],
    approved_sources: [],
    boundary_check: "Validated.",
    execution_mode: "refreshed",
    ...patch
  };
}

function fixture({
  query = "Prepare a clear launch recommendation.",
  agentPatches = {},
  plan = null,
  options = { max_tokens: 1024, temperature: 0 }
} = {}) {
  const agents = [
    agent("research_agent", agentPatches.research_agent),
    agent("safety_agent", agentPatches.safety_agent),
    agent("writer_agent", {
      consumes: ["domain_outputs"],
      ...agentPatches.writer_agent
    })
  ];
  const resolvedPlan = plan || {
    steps: [
      { id: "s1", adapter: "research_agent", task: "Collect the relevant evidence.", depends_on: [] },
      { id: "s2", adapter: "safety_agent", task: "Review the relevant safeguards.", depends_on: [] },
      { id: "s3", adapter: "writer_agent", task: "Combine the validated findings.", depends_on: ["s1", "s2"] }
    ]
  };
  const run = {
    run_id: "run_cold",
    session_id: "session_one",
    workspace_id: "workspace_one",
    agent_workspace_id: "team_one",
    created_by: "user_one",
    query,
    status: "completed",
    plan: resolvedPlan,
    created_at: "2026-07-15T10:00:00.000Z",
    completed_at: "2026-07-15T10:00:01.000Z"
  };
  const session = {
    session_id: run.session_id,
    workspace_id: run.workspace_id,
    agent_workspace_id: run.agent_workspace_id,
    created_by: run.created_by,
    shared_memory: []
  };
  const data = { worldGraphArtifacts: [], worldGraphEvents: [] };
  const outputs = resolvedPlan.steps.map((step) => routeOutput(step));
  recordWorldGraphRun({
    data,
    run,
    session,
    plan: resolvedPlan,
    outputs,
    agents,
    documents: [],
    sharedMemory: [],
    options,
    createdAt: "2026-07-15T10:00:01.000Z"
  });
  return { data, run, session, plan: resolvedPlan, agents, documents: [], outputs, options };
}

function replayFixture(base, {
  agents = base.agents,
  documents = base.documents,
  sharedMemory = [],
  options = { max_tokens: 1024, temperature: 0 },
  runPatch = {},
  outputVersions = {},
  runFresh = false,
  now = Date.parse("2026-07-15T10:05:00.000Z")
} = {}) {
  const run = { ...base.run, run_id: "run_next", ...runPatch };
  const session = {
    ...base.session,
    session_id: run.session_id,
    workspace_id: run.workspace_id,
    agent_workspace_id: run.agent_workspace_id,
    created_by: run.created_by,
    shared_memory: sharedMemory
  };
  const resolved = [];
  const actions = [];
  const reasons = {};
  for (const step of base.plan.steps) {
    const decision = selectWorldGraphSeedForStep({
      data: base.data,
      run,
      session,
      step,
      agents,
      documents,
      sharedMemory,
      options,
      resolvedOutputs: resolved,
      runFresh,
      now
    });
    actions.push([step.adapter, decision.seed ? "kept" : "refreshed"]);
    reasons[step.adapter] = decision.decision.reason;
    resolved.push(decision.seed || routeOutput(step, outputVersions[step.adapter] || "v1"));
  }
  return { actions: Object.fromEntries(actions), reasons, outputs: resolved };
}

describe("WorldGraph validity and selective replay", () => {
  it("records immutable, integrity-verifiable route artifacts", () => {
    const base = fixture();
    expect(base.data.worldGraphArtifacts).toHaveLength(3);
    expect(base.data.worldGraphArtifacts.every(verifyWorldGraphArtifact)).toBe(true);
    expect(base.run.world_graph).toMatchObject({ kept: 0, refreshed: 3, total: 3 });
  });

  it("MAC-binds production artifacts so a database-only writer cannot forge a checksum", () => {
    const previousKey = process.env.TCAR_RUNTIME_API_KEY;
    process.env.TCAR_RUNTIME_API_KEY = "worldgraph-artifact-mac-test-key-0123456789";
    try {
      const base = fixture();
      const artifact = base.data.worldGraphArtifacts[0];
      expect(artifact.record_hash).toMatch(/^hmac-sha256:[a-f0-9]{64}$/);
      expect(verifyWorldGraphArtifact(artifact)).toBe(true);
      artifact.replay_output.domain_answer = "database-forged output";
      artifact.record_hash = digestValue(Object.fromEntries(
        Object.entries(artifact).filter(([key]) => key !== "record_hash")
      ));
      expect(verifyWorldGraphArtifact(artifact)).toBe(false);
    } finally {
      if (previousKey === undefined) delete process.env.TCAR_RUNTIME_API_KEY;
      else process.env.TCAR_RUNTIME_API_KEY = previousKey;
    }
  });

  it("keeps every agent dormant for an exact repeat", () => {
    const result = replayFixture(fixture());
    expect(result.actions).toEqual({ research_agent: "kept", safety_agent: "kept", writer_agent: "kept" });
  });

  it("treats indentation and line breaks as semantic request input", () => {
    const original = fixture({ query: "Explain:\nif ok:\n    x()\ny()" });
    const differentlyIndented = replayFixture(original, {
      runPatch: { query: "Explain:\nif ok:\n    x()\n    y()" }
    });
    expect(Object.values(differentlyIndented.actions).every((value) => value === "refreshed")).toBe(true);
    expect(differentlyIndented.reasons.research_agent).toBe("request_changed");
  });

  it("wakes one changed agent but keeps its consumer when the validated output is identical", () => {
    const base = fixture();
    const agents = base.agents.map((item) => item.id === "safety_agent" ? { ...item, capability: "Updated safety instructions." } : item);
    const result = replayFixture(base, { agents });
    expect(result.actions).toEqual({ research_agent: "kept", safety_agent: "refreshed", writer_agent: "kept" });
    expect(result.reasons.safety_agent).toBe("agent_changed");
  });

  it("wakes the downstream consumer when a changed branch produces a different artifact", () => {
    const base = fixture();
    const agents = base.agents.map((item) => item.id === "safety_agent" ? { ...item, boundary: "Updated boundary." } : item);
    const result = replayFixture(base, { agents, outputVersions: { safety_agent: "v2" } });
    expect(result.actions).toEqual({ research_agent: "kept", safety_agent: "refreshed", writer_agent: "refreshed" });
  });

  it("fails closed when stored output bytes are tampered", () => {
    const base = fixture();
    base.data.worldGraphArtifacts[0].replay_output.domain_answer = "forged";
    const result = replayFixture(base);
    expect(result.actions.research_agent).toBe("refreshed");
    expect(result.reasons.research_agent).toBe("stored_result_failed_integrity_check");
  });

  it("never crosses user, workspace, session, or agent-workspace boundaries", () => {
    for (const runPatch of [
      { created_by: "user_two" },
      { workspace_id: "workspace_two" },
      { session_id: "session_two" },
      { agent_workspace_id: "team_two" }
    ]) {
      expect(Object.values(replayFixture(fixture(), { runPatch }).actions).every((value) => value === "refreshed")).toBe(true);
    }
  });

  it("projects every historical route awake when the active agent team changed", () => {
    const base = fixture();
    const preview = previewWorldGraphRun({
      data: base.data,
      run: base.run,
      session: base.session,
      agents: base.agents,
      documents: [],
      sharedMemory: [],
      options: { max_tokens: 1024, temperature: 0 },
      targetAgentWorkspaceId: "team_two"
    });
    expect(preview).toMatchObject({ validity: "needs_refresh", keep_count: 0, wake_count: 3 });
    expect(preview.decisions.every((item) => item.reason === "agent_team_changed")).toBe(true);
  });

  it("expires stored work and honors the explicit fresh-run escape", () => {
    const base = fixture();
    const expired = replayFixture(base, { now: Date.parse("2026-07-17T11:00:00.000Z") });
    expect(Object.values(expired.actions).every((value) => value === "refreshed")).toBe(true);
    const fresh = replayFixture(base, { runFresh: true });
    expect(Object.values(fresh.actions).every((value) => value === "refreshed")).toBe(true);
    expect(fresh.reasons.research_agent).toBe("fresh_run_requested");
  });

  it("never renews the freshness window by repeatedly cloning reused work", () => {
    const base = fixture();
    const nearExpiry = replayFixture(base, {
      now: Date.parse("2026-07-16T09:59:59.000Z")
    });
    expect(Object.values(nearExpiry.actions).every((value) => value === "kept")).toBe(true);
    const intermediateRun = { ...base.run, run_id: "run_near_expiry" };
    recordWorldGraphRun({
      data: base.data,
      run: intermediateRun,
      session: base.session,
      plan: base.plan,
      outputs: nearExpiry.outputs,
      agents: base.agents,
      documents: [],
      sharedMemory: [],
      options: { max_tokens: 1024, temperature: 0 },
      createdAt: "2026-07-16T09:59:59.000Z"
    });
    const expired = replayFixture(base, {
      now: Date.parse("2026-07-16T10:00:02.000Z")
    });
    expect(Object.values(expired.actions).every((value) => value === "refreshed")).toBe(true);
    expect(base.data.worldGraphArtifacts
      .filter((item) => item.origin_run_id === "run_near_expiry")).toHaveLength(0);
  });

  it("does not amplify storage writes for repeated kept routes", () => {
    const base = fixture();
    for (let index = 0; index < 30; index += 1) {
      const repeated = replayFixture(base, {
        runPatch: { run_id: `repeat_${index}` },
        now: Date.parse("2026-07-15T10:05:00.000Z") + index * 1000
      });
      recordWorldGraphRun({
        data: base.data,
        run: { ...base.run, run_id: `repeat_${index}` },
        session: base.session,
        plan: base.plan,
        outputs: repeated.outputs,
        agents: base.agents,
        documents: [],
        sharedMemory: [],
        options: { max_tokens: 1024, temperature: 0 },
        createdAt: new Date(Date.parse("2026-07-15T10:05:00.000Z") + index * 1000).toISOString()
      });
    }
    expect(base.data.worldGraphArtifacts).toHaveLength(3);
  });

  it("does not replay creative-variation or live-information routes", () => {
    const varied = replayFixture(fixture(), { options: { max_tokens: 1024, temperature: 0.7 } });
    expect(Object.values(varied.actions).every((value) => value === "refreshed")).toBe(true);
    const live = fixture({ query: "Give me the latest live launch status today.", agentPatches: { research_agent: { tools: ["web_search"] } } });
    expect(replayFixture(live).actions).toEqual({ research_agent: "refreshed", safety_agent: "kept", writer_agent: "kept" });
    const earthquake = fixture({ agentPatches: { research_agent: { tools: ["earthquake_feed"] } } });
    expect(replayFixture(earthquake).actions.research_agent).toBe("kept");
    const futureDynamicTool = fixture({ agentPatches: { research_agent: { tools: ["future_external_connector"] } } });
    expect(replayFixture(futureDynamicTool).actions.research_agent).toBe("kept");
    const currentFutureTool = fixture({
      query: "Give me the current status.",
      agentPatches: { research_agent: { tools: ["future_external_connector"] } }
    });
    expect(replayFixture(currentFutureTool).actions.research_agent).toBe("refreshed");
    expect(replayFixture(currentFutureTool).reasons.research_agent).toBe("time_sensitive_request");
  });

  it("reuses stable research work when a live tool was available but never called", () => {
    const base = fixture({
      query: "Explain the Renault brand and the Python language.",
      agentPatches: {
        research_agent: { tools: ["web_search"] },
        safety_agent: { tools: ["web_search"] }
      }
    });
    const repeated = replayFixture(base);
    expect(repeated.actions).toEqual({
      research_agent: "kept",
      safety_agent: "kept",
      writer_agent: "kept"
    });
  });

  it("wakes routes when a request-level refiner budget changes", () => {
    const changed = replayFixture(fixture(), {
      options: { max_tokens: 1024, refiner_max_tokens: 2048, temperature: 0 }
    });
    expect(changed.actions).toEqual({
      research_agent: "refreshed",
      safety_agent: "refreshed",
      writer_agent: "refreshed"
    });
    expect(changed.reasons.research_agent).toBe("execution_settings_changed");
  });

  it("invalidates only agents that actually consume changed conversation memory", () => {
    const base = fixture({ agentPatches: { research_agent: { consumes: ["shared_memory"] } } });
    const memory = [{ tag: "audience", source: "user", content: "Teachers" }];
    const result = replayFixture(base, { sharedMemory: memory });
    expect(result.actions).toEqual({ research_agent: "refreshed", safety_agent: "kept", writer_agent: "kept" });
  });

  it("uses content revisions rather than filenames for document validity", () => {
    const revision = `sha256:${"a".repeat(64)}`;
    const index = `sha256:${"b".repeat(64)}`;
    const base = fixture({ agentPatches: { research_agent: {
      document: { title: "Guide" },
      tools: ["document_search", "document_read"]
    } } });
    base.documents = [{ document_id: "doc_old", agent_id: "research_agent", corpus_revision: revision, index_digest: index, enabled: true }];
    // Re-record with the source state present.
    base.data.worldGraphArtifacts = [];
    recordWorldGraphRun({ data: base.data, run: base.run, session: base.session, plan: base.plan, outputs: base.outputs, agents: base.agents, documents: base.documents, sharedMemory: [], options: { max_tokens: 1024, temperature: 0 }, createdAt: "2026-07-15T10:00:01.000Z" });
    const renamed = [{ ...base.documents[0], document_id: "doc_new" }];
    expect(replayFixture(base, { documents: renamed }).actions.research_agent).toBe("kept");
    const changed = [{ ...renamed[0], corpus_revision: `sha256:${"c".repeat(64)}` }];
    expect(replayFixture(base, { documents: changed }).actions).toEqual({ research_agent: "refreshed", safety_agent: "kept", writer_agent: "kept" });
  });

  it("never reuses metadata-only documents without committed content and index digests", () => {
    const base = fixture({ agentPatches: { research_agent: {
      document: { title: "Legacy external guide" },
      tools: ["document_search", "document_read"]
    } } });
    base.documents = [{
      document_id: "doc_unbound_metadata",
      agent_id: "research_agent",
      enabled: true
    }];
    base.data.worldGraphArtifacts = [];
    recordWorldGraphRun({
      data: base.data,
      run: base.run,
      session: base.session,
      plan: base.plan,
      outputs: base.outputs,
      agents: base.agents,
      documents: base.documents,
      sharedMemory: [],
      options: { max_tokens: 1024, temperature: 0 },
      createdAt: "2026-07-15T10:00:01.000Z"
    });

    const replay = replayFixture(base);
    expect(replay.actions.research_agent).toBe("refreshed");
    expect(replay.reasons.research_agent).toBe("source_changed_or_unverifiable");
  });

  it("never previews an unbound source path as reusable evidence", () => {
    const base = fixture({ agentPatches: { research_agent: {
      sources: ["sources/unbound/current-guide.md"]
    } } });
    expect(replayFixture(base).actions).toEqual({
      research_agent: "refreshed",
      safety_agent: "kept",
      writer_agent: "kept"
    });
    expect(replayFixture(base).reasons.research_agent).toBe("source_changed_or_unverifiable");
  });

  it("fails closed when committed document bytes no longer match their digests", () => {
    const chunks = chunkDocument("integrity_guide", "Trusted source text for the recommendation.", 80, 0);
    const document = {
      document_id: "doc_integrity",
      agent_id: "research_agent",
      runtime_managed: false,
      chunks,
      corpus_revision: documentRevision(chunks),
      index_digest: documentIndexDigest(chunks),
      enabled: true
    };
    const base = fixture({ agentPatches: { research_agent: { document: { title: "Integrity guide" } } } });
    base.documents = [document];
    base.data.worldGraphArtifacts = [];
    recordWorldGraphRun({
      data: base.data,
      run: base.run,
      session: base.session,
      plan: base.plan,
      outputs: base.outputs,
      agents: base.agents,
      documents: base.documents,
      sharedMemory: [],
      options: { max_tokens: 1024, temperature: 0 },
      createdAt: "2026-07-15T10:00:01.000Z"
    });
    const tampered = [{
      ...document,
      chunks: document.chunks.map((chunk, index) => index ? chunk : { ...chunk, body: "Tampered source text." })
    }];
    const replay = replayFixture(base, { documents: tampered });
    expect(replay.actions.research_agent).toBe("refreshed");
    expect(replay.reasons.research_agent).toBe("source_changed_or_unverifiable");
  });

  it("stress-tests ten documents and wakes only the changed document branch and its consumer", () => {
    const sourceSteps = Array.from({ length: 10 }, (_, index) => ({
      id: `s${index + 1}`,
      adapter: `document_agent_${index + 1}`,
      task: `Analyze document ${index + 1}.`,
      depends_on: []
    }));
    const synthesisStep = {
      id: "s11",
      adapter: "writer_agent",
      task: "Combine all ten validated document results.",
      depends_on: sourceSteps.map((step) => step.id)
    };
    const plan = { steps: [...sourceSteps, synthesisStep] };
    const agents = [
      ...sourceSteps.map((step) => agent(step.adapter, { document: { title: step.adapter } })),
      agent("writer_agent", { consumes: ["domain_outputs"] })
    ];
    const documents = sourceSteps.map((step, index) => ({
      document_id: `doc_${index + 1}`,
      agent_id: step.adapter,
      corpus_revision: `sha256:${String(index + 1).padStart(64, "0")}`,
      index_digest: `sha256:${String(index + 11).padStart(64, "0")}`,
      enabled: true
    }));
    const run = {
      run_id: "run_ten_docs",
      session_id: "session_one",
      workspace_id: "workspace_one",
      agent_workspace_id: "team_one",
      created_by: "user_one",
      query: "Compare ten uploaded community reports.",
      status: "completed",
      plan
    };
    const session = {
      session_id: run.session_id,
      workspace_id: run.workspace_id,
      agent_workspace_id: run.agent_workspace_id,
      created_by: run.created_by
    };
    const data = { worldGraphArtifacts: [], worldGraphEvents: [] };
    const outputs = plan.steps.map((step) => routeOutput(step));
    recordWorldGraphRun({
      data,
      run,
      session,
      plan,
      outputs,
      agents,
      documents,
      sharedMemory: [],
      options: { max_tokens: 4096, temperature: 0 },
      createdAt: "2026-07-15T10:00:00.000Z"
    });
    const changedDocuments = documents.map((document, index) => index === 4
      ? { ...document, corpus_revision: `sha256:${"f".repeat(64)}` }
      : document);
    const resolved = [];
    const refreshed = [];
    for (const step of plan.steps) {
      const selection = selectWorldGraphSeedForStep({
        data,
        run: { ...run, run_id: "run_ten_docs_repeat" },
        session,
        step,
        agents,
        documents: changedDocuments,
        sharedMemory: [],
        options: { max_tokens: 4096, temperature: 0 },
        resolvedOutputs: resolved,
        now: Date.parse("2026-07-15T10:05:00.000Z")
      });
      if (!selection.seed) refreshed.push(step.adapter);
      resolved.push(selection.seed || routeOutput(step, step.adapter === "document_agent_5" ? "v2" : "v1"));
    }
    expect(refreshed).toEqual(["document_agent_5", "writer_agent"]);
    expect(resolved.filter((output) => output.execution_mode === "reused")).toHaveLength(9);
  });

  it("marks deterministic disagreement as contested and refuses both results", () => {
    const base = fixture();
    const run = { ...base.run, run_id: "run_fresh" };
    const outputs = base.plan.steps.map((step) => routeOutput(step, step.id === "s1" ? "conflict" : "v1"));
    recordWorldGraphRun({ data: base.data, run, session: base.session, plan: base.plan, outputs, agents: base.agents, documents: [], sharedMemory: [], options: { max_tokens: 1024, temperature: 0 } });
    expect(publicWorldGraphSnapshot({
      data: base.data,
      run,
      actor: { workspace_id: "workspace_one", user_id: "user_one" }
    }).contested_results).toBe(2);
    const disputed = base.data.worldGraphArtifacts.filter((artifact) => artifact.adapter === "research_agent");
    expect(disputed).toHaveLength(2);
    expect(disputed.every((artifact) => artifact.contested && verifyWorldGraphArtifact(artifact))).toBe(true);
    expect(base.data.worldGraphEvents.every((event) => /^hmac-sha256:|^sha256:/.test(event.record_hash))).toBe(true);
    expect(replayFixture(base).reasons.research_agent).toBe("stored_results_disagree");
  });

  it("never authenticates an unsigned cross-tenant contest event during reads", () => {
    const base = fixture();
    const target = base.data.worldGraphArtifacts[0];
    const originalHash = target.record_hash;
    base.data.worldGraphEvents.push({
      event_id: "forged_legacy_event",
      schema_version: "virenis-world-graph-v1",
      event_type: "result.contested",
      workspace_id: "workspace_attacker",
      created_by: "user_attacker",
      session_id: "session_attacker",
      agent_workspace_id: "team_attacker",
      run_id: "run_attacker",
      step_id: "s1",
      adapter: target.adapter,
      artifact_ids: [target.artifact_id],
      occurred_at: "2026-07-15T10:00:02.000Z"
    });

    const snapshot = publicWorldGraphSnapshot({
      data: base.data,
      run: base.run,
      actor: { workspace_id: "workspace_one", user_id: "user_one" }
    });

    expect(target.contested).toBe(false);
    expect(target.record_hash).toBe(originalHash);
    expect(base.data.worldGraphEvents.at(-1)).not.toHaveProperty("record_hash");
    expect(snapshot.contested_results).toBe(0);
  });

  it("redacts tool arguments and result data in stored replay material", () => {
    const base = fixture();
    base.data.worldGraphArtifacts = [];
    const outputs = base.outputs.map((output, index) => index ? output : {
      ...output,
      tool_executions: [{ id: "call", name: "mcp_secret_read", arguments: { token: "plaintext-secret" }, result: { ok: true, data: { secret: "private-result" } } }]
    });
    recordWorldGraphRun({ data: base.data, run: base.run, session: base.session, plan: base.plan, outputs, agents: base.agents, documents: [], sharedMemory: [], options: { max_tokens: 1024, temperature: 0 } });
    const encoded = JSON.stringify(base.data.worldGraphArtifacts);
    expect(encoded).not.toContain("plaintext-secret");
    expect(encoded).not.toContain("private-result");
    expect(base.data.worldGraphArtifacts[0].effect_policy.replayable).toBe(false);
  });

  it("rechecks even deterministic tool output until implementation and input digests are bound", () => {
    const base = fixture();
    base.data.worldGraphArtifacts = [];
    const outputs = base.outputs.map((output, index) => index ? output : {
      ...output,
      tool_executions: [{ id: "calc", name: "calculator", arguments: { expression: "2+2" }, result: { ok: true, data: 4 } }]
    });
    recordWorldGraphRun({
      data: base.data,
      run: base.run,
      session: base.session,
      plan: base.plan,
      outputs,
      agents: base.agents,
      documents: [],
      sharedMemory: [],
      options: { max_tokens: 1024, temperature: 0 },
      createdAt: "2026-07-15T10:00:01.000Z"
    });
    const replay = replayFixture(base);
    expect(replay.actions).toEqual({ research_agent: "refreshed", safety_agent: "kept", writer_agent: "kept" });
    expect(replay.reasons.research_agent).toBe("tool_result_requires_fresh_execution");
  });

  it("bounds per-owner storage without evicting another tenant", () => {
    const base = fixture();
    const other = fixture();
    const foreign = other.data.worldGraphArtifacts.map((artifact) => ({
      ...artifact,
      artifact_id: `foreign_${artifact.artifact_id}`,
      workspace_id: "workspace_two",
      created_by: "user_two"
    })).map((artifact) => ({ ...artifact, record_hash: digestValue(Object.fromEntries(Object.entries(artifact).filter(([key]) => key !== "record_hash"))) }));
    base.data.worldGraphArtifacts.push(...foreign);
    for (let index = 0; index < 90; index += 1) {
      const createdAt = new Date(Date.parse("2026-07-15T10:01:00.000Z") + index * 1000).toISOString();
      recordWorldGraphRun({
        data: base.data,
        run: { ...base.run, run_id: `run_stress_${index}` },
        session: base.session,
        plan: base.plan,
        outputs: base.outputs,
        agents: base.agents,
        documents: [],
        sharedMemory: [],
        options: { max_tokens: 1024, temperature: 0 },
        createdAt
      });
    }
    expect(base.data.worldGraphArtifacts.filter((item) => item.created_by === "user_one")).toHaveLength(240);
    expect(base.data.worldGraphArtifacts.filter((item) => item.created_by === "user_two")).toHaveLength(3);
  });

  it("removes expired artifacts and their contest events after the retention window", () => {
    const base = fixture();
    base.data.worldGraphEvents = [{
      event_id: "wg_event_expired",
      event_type: "result.contested",
      workspace_id: base.run.workspace_id,
      created_by: base.run.created_by,
      session_id: base.run.session_id,
      agent_workspace_id: base.run.agent_workspace_id,
      artifact_ids: base.data.worldGraphArtifacts.map((item) => item.artifact_id),
      occurred_at: "2026-07-15T10:00:00.000Z"
    }];
    recordWorldGraphRun({
      data: base.data,
      run: { ...base.run, run_id: "run_after_retention" },
      session: base.session,
      plan: base.plan,
      outputs: base.outputs,
      agents: base.agents,
      documents: [],
      sharedMemory: [],
      options: { max_tokens: 1024, temperature: 0 },
      createdAt: "2026-07-23T10:00:01.000Z"
    });
    expect(base.data.worldGraphArtifacts.some((item) => item.origin_run_id === "run_cold")).toBe(false);
    expect(base.data.worldGraphEvents.some((item) => item.event_id === "wg_event_expired")).toBe(false);
  });

  it("sweeps dormant retained data without requiring another successful run", () => {
    const base = fixture();
    base.data.worldGraphEvents = [{
      event_id: "old_event",
      occurred_at: "2026-07-15T10:00:01.000Z"
    }];
    const removed = pruneExpiredWorldGraphData(base.data, {
      now: Date.parse("2026-07-23T10:00:02.000Z")
    });
    expect(removed).toEqual({ artifacts: 3, events: 1 });
    expect(base.data.worldGraphArtifacts).toHaveLength(0);
    expect(base.data.worldGraphEvents).toHaveLength(0);
  });

  it("skips oversized replay material instead of growing storage or failing the run", () => {
    const plan = { steps: [{ id: "s1", adapter: "research_agent", task: "Create the bounded result.", depends_on: [] }] };
    const base = fixture({ plan });
    base.data.worldGraphArtifacts = [];
    const oversized = routeOutput(plan.steps[0], "v1", { domain_answer: "x".repeat(140 * 1024) });
    recordWorldGraphRun({
      data: base.data,
      run: base.run,
      session: base.session,
      plan,
      outputs: [oversized],
      agents: base.agents,
      documents: [],
      sharedMemory: [],
      options: { max_tokens: 1024, temperature: 0 },
      createdAt: "2026-07-15T10:00:01.000Z"
    });
    expect(base.data.worldGraphArtifacts).toHaveLength(0);
    expect(base.run.world_graph).toMatchObject({ kept: 0, refreshed: 1, total: 1 });
  });

  it("deduplicates repeated artifacts in the signed runtime capsule", () => {
    const base = fixture();
    for (let index = 0; index < 8; index += 1) {
      recordWorldGraphRun({
        data: base.data,
        run: { ...base.run, run_id: `run_repeat_${index}` },
        session: base.session,
        plan: base.plan,
        outputs: base.outputs,
        agents: base.agents,
        documents: [],
        sharedMemory: [],
        options: { max_tokens: 1024, temperature: 0 },
        createdAt: new Date(Date.parse("2026-07-15T10:01:00.000Z") + index * 1000).toISOString()
      });
    }
    const capsule = worldGraphReplayCapsule({
      data: base.data,
      run: { ...base.run, run_id: "run_target" },
      session: base.session,
      agents: base.agents,
      documents: [],
      sharedMemory: [],
      options: { max_tokens: 1024, temperature: 0 },
      signingKey: "a-runtime-key-long-enough-for-hmac",
      now: Date.parse("2026-07-15T10:02:00.000Z")
    });
    expect(signedCapsulePayload(capsule).candidates).toHaveLength(3);
  });

  it("returns a public two-axis graph without private replay payloads", () => {
    const base = fixture();
    const snapshot = publicWorldGraphSnapshot({ data: base.data, run: base.run, actor: { workspace_id: "workspace_one", user_id: "user_one" } });
    expect(snapshot.nodes).toHaveLength(3);
    expect(snapshot.nodes[0]).toMatchObject({ validity: "unchecked", run_action: "executed" });
    expect(snapshot.edges).toEqual(expect.arrayContaining([{ edge_id: "support:s1:s3", source: "agent_result:s1", target: "agent_result:s3", kind: "supports" }]));
    expect(JSON.stringify(snapshot)).not.toContain("replay_output");
  });

  it("does not inflate a run snapshot with other queries from the same session", () => {
    const base = fixture();
    const otherRun = {
      ...base.run,
      run_id: "run_other_query",
      query: "Prepare a different support recommendation."
    };
    recordWorldGraphRun({
      data: base.data,
      run: otherRun,
      session: base.session,
      plan: base.plan,
      outputs: base.outputs,
      agents: base.agents,
      documents: [],
      sharedMemory: [],
      options: { max_tokens: 1024, temperature: 0 },
      createdAt: "2026-07-15T10:02:00.000Z"
    });
    expect(base.data.worldGraphArtifacts).toHaveLength(6);
    const snapshot = publicWorldGraphSnapshot({
      data: base.data,
      run: base.run,
      actor: { workspace_id: "workspace_one", user_id: "user_one" }
    });
    expect(snapshot.stored_results).toBe(3);
    expect(snapshot.effect_safe_results).toBe(3);
  });

  it("wakes a downstream agent when an upstream validation becomes invalid", () => {
    const base = fixture();
    const byAdapter = new Map(base.data.worldGraphArtifacts.map((artifact) => [artifact.adapter, artifact]));
    const invalidUpstream = {
      ...base.outputs[0],
      source_validation: { valid: false, violations: ["source_integrity_failed"] },
      // Simulate a stale or adversarial digest claim. Dependency validity is
      // checked independently, so this cannot preserve the downstream route.
      world_graph_output_digest: byAdapter.get("research_agent").output_digest
    };
    const validUpstream = {
      ...base.outputs[1],
      world_graph_output_digest: byAdapter.get("safety_agent").output_digest
    };
    const selection = selectWorldGraphSeedForStep({
      data: base.data,
      run: { ...base.run, run_id: "run_invalid_upstream" },
      session: base.session,
      step: base.plan.steps[2],
      agents: base.agents,
      documents: [],
      sharedMemory: [],
      options: { max_tokens: 1024, temperature: 0 },
      resolvedOutputs: [invalidUpstream, validUpstream],
      now: Date.parse("2026-07-15T10:05:00.000Z")
    });
    expect(selection.seed).toBeNull();
    expect(selection.decision.reason).toBe("upstream_result_changed");
  });

  it("creates a short-lived HMAC-bound internal replay capsule", () => {
    const base = fixture();
    const target = { ...base.run, run_id: "run_target" };
    const capsule = worldGraphReplayCapsule({
      data: base.data,
      run: target,
      session: base.session,
      agents: base.agents,
      documents: [],
      sharedMemory: [],
      options: { max_tokens: 1024, temperature: 0 },
      signingKey: "a-runtime-key-long-enough-for-hmac",
      now: Date.parse("2026-07-15T10:02:00.000Z")
    });
    const payload = signedCapsulePayload(capsule);
    expect(payload).toMatchObject({
      schema_version: "virenis-world-graph-v1",
      engine_revision: "world-graph-engine-v3"
    });
    expect(payload.scope).toMatchObject({ target_run_id: "run_target", workspace_id: "workspace_one", user_id: "user_one", session_id: "session_one", agent_workspace_id: "team_one" });
    expect(payload.candidates).toHaveLength(3);
  });

  it("explains replay readiness without exposing stored result payloads", () => {
    const base = fixture();
    const prepared = prepareWorldGraphReplay({
      data: base.data,
      run: { ...base.run, run_id: "run_diagnostics" },
      session: base.session,
      agents: base.agents,
      documents: [],
      // The session may grow between exact repeats. These agents do not
      // consume shared memory, so unrelated history must not wake them.
      sharedMemory: [{ tag: "older_result", source: "application", content: "Unrelated history." }],
      options: { max_tokens: 1024, temperature: 0 },
      signingKey: "a-runtime-key-long-enough-for-hmac",
      now: Date.parse("2026-07-15T10:02:00.000Z")
    });

    expect(signedCapsulePayload(prepared.capsule).candidates).toHaveLength(3);
    expect(prepared.diagnostics).toMatchObject({
      status: "ready",
      capsule_created: true,
      artifacts_in_scope: 3,
      exact_request_artifacts: 3,
      eligible_candidates: 3,
      primary_reason: "inputs_and_evidence_unchanged"
    });
    expect(prepared.diagnostics.agents).toHaveLength(3);
    expect(prepared.diagnostics.agents.every((item) => item.status === "eligible")).toBe(true);
    expect(JSON.stringify(prepared.diagnostics)).not.toContain("replay_output");
    expect(JSON.stringify(prepared.diagnostics)).not.toContain("domain_answer");
    expect(JSON.stringify(prepared.diagnostics)).not.toContain("artifact_id");
  });

  it("surfaces why verified reuse was unavailable instead of silently refreshing", () => {
    const base = fixture();
    const changedAgents = base.agents.map((item) => item.id === "research_agent"
      ? { ...item, capability: "Use the revised research instructions." }
      : item);
    const prepared = prepareWorldGraphReplay({
      data: base.data,
      run: { ...base.run, run_id: "run_changed_agent" },
      session: base.session,
      agents: changedAgents,
      documents: [],
      sharedMemory: [],
      options: { max_tokens: 1024, temperature: 0 },
      signingKey: "a-runtime-key-long-enough-for-hmac",
      now: Date.parse("2026-07-15T10:02:00.000Z")
    });

    expect(signedCapsulePayload(prepared.capsule).candidates).toHaveLength(2);
    expect(prepared.diagnostics).toMatchObject({
      capsule_created: true,
      eligible_candidates: 2,
      exclusions: expect.arrayContaining([expect.objectContaining({ reason: "agent_changed", count: 1 })]),
      agents: expect.arrayContaining([
        expect.objectContaining({ adapter: "research_agent", status: "excluded", reason: "agent_changed" })
      ])
    });

    const unsigned = prepareWorldGraphReplay({
      data: base.data,
      run: { ...base.run, run_id: "run_unsigned" },
      session: base.session,
      agents: base.agents,
      documents: [],
      sharedMemory: [],
      options: { max_tokens: 1024, temperature: 0 },
      signingKey: "short",
      now: Date.parse("2026-07-15T10:02:00.000Z")
    });
    expect(unsigned.capsule).toBeNull();
    expect(unsigned.diagnostics).toMatchObject({
      status: "disabled",
      capsule_created: false,
      primary_reason: "replay_signing_unavailable",
      plain_reason: "Verified reuse was unavailable, so the work was checked again."
    });
  });

  it("binds the approved workflow specialist set and explains an exact-repeat mismatch", () => {
    const base = fixture({
      options: {
        max_tokens: 1024,
        temperature: 0,
        required_adapters: ["research_agent", "writer_agent"]
      }
    });
    const common = {
      data: base.data,
      run: { ...base.run, run_id: "run_required_workflow" },
      session: base.session,
      agents: base.agents,
      documents: [],
      sharedMemory: [],
      signingKey: "a-runtime-key-long-enough-for-hmac",
      now: Date.parse("2026-07-15T10:02:00.000Z")
    };

    // A specialist set is a set for replay purposes: ordering and duplicate UI
    // selections do not create a false settings change.
    const sameWorkflow = prepareWorldGraphReplay({
      ...common,
      options: {
        max_tokens: 1024,
        temperature: 0,
        required_adapters: ["writer_agent", "research_agent", "writer_agent"]
      }
    });
    expect(signedCapsulePayload(sameWorkflow.capsule).candidates).toHaveLength(3);
    expect(sameWorkflow.diagnostics).toMatchObject({
      status: "ready",
      capsule_created: true,
      exact_request_artifacts: 3,
      eligible_candidates: 3
    });

    // The text is still an exact repeat, but changing the approved workflow is
    // an execution input and must fail closed with an observable reason.
    const changedWorkflow = prepareWorldGraphReplay({
      ...common,
      run: { ...common.run, run_id: "run_changed_required_workflow" },
      options: {
        max_tokens: 1024,
        temperature: 0,
        required_adapters: ["research_agent"]
      }
    });
    expect(changedWorkflow.capsule).toBeNull();
    expect(changedWorkflow.diagnostics).toMatchObject({
      status: "no_match",
      capsule_created: false,
      exact_request_artifacts: 3,
      eligible_candidates: 0,
      primary_reason: "execution_settings_changed",
      exclusions: [expect.objectContaining({ reason: "execution_settings_changed", count: 3 })]
    });
    expect(changedWorkflow.diagnostics.agents).toHaveLength(3);
    expect(changedWorkflow.diagnostics.agents.every((item) => (
      item.status === "excluded" && item.reason === "execution_settings_changed"
    ))).toBe(true);
  });
});

const REAL_LIFE_SCENARIOS = [
  ["textile supplier guide revision", "Create a textile business plan.", ["research_agent"], ["research_agent"], ["research_agent", "writer_agent"]],
  ["accounting table correction", "Compare the accounting table with the policy brief.", ["research_agent"], ["research_agent"], ["research_agent", "writer_agent"]],
  ["inflation brief correction", "Explain the two documents in plain language.", ["safety_agent"], ["safety_agent"], ["safety_agent", "writer_agent"]],
  ["automotive research source update", "Research the automotive industry and summarize it.", ["research_agent"], ["research_agent"], ["research_agent", "writer_agent"]],
  ["medical guidance revision", "Draft a patient-friendly appointment guide.", ["safety_agent"], ["safety_agent"], ["safety_agent", "writer_agent"]],
  ["school curriculum source revision", "Create a classroom lesson outline.", ["research_agent"], ["research_agent"], ["research_agent", "writer_agent"]],
  ["travel safety advisory revision", "Prepare a family travel checklist.", ["safety_agent"], ["safety_agent"], ["safety_agent", "writer_agent"]],
  ["software API contract revision", "Write an implementation brief for a web app.", ["research_agent"], ["research_agent"], ["research_agent", "writer_agent"]],
  ["privacy policy revision", "Draft a simple privacy FAQ.", ["safety_agent"], ["safety_agent"], ["safety_agent", "writer_agent"]],
  ["support policy revision", "Write a damaged-product support response.", ["safety_agent"], ["safety_agent"], ["safety_agent", "writer_agent"]],
  ["product research revision", "Recommend a beginner-friendly camera.", ["research_agent"], ["research_agent"], ["research_agent", "writer_agent"]],
  ["food allergy guidance revision", "Create a safe dinner plan for guests.", ["safety_agent"], ["safety_agent"], ["safety_agent", "writer_agent"]],
  ["museum source revision", "Plan a one-day museum visit.", ["research_agent"], ["research_agent"], ["research_agent", "writer_agent"]],
  ["housing regulation revision", "Explain a tenant move-out checklist.", ["safety_agent"], ["safety_agent"], ["safety_agent", "writer_agent"]],
  ["environmental report revision", "Summarize a local recycling proposal.", ["research_agent"], ["research_agent"], ["research_agent", "writer_agent"]],
  ["two independent source updates", "Combine research and safety guidance.", ["research_agent", "safety_agent"], ["research_agent", "safety_agent"], ["research_agent", "safety_agent", "writer_agent"]],
  ["research agent instructions update", "Prepare a market overview.", ["research_agent"], [], ["research_agent"]],
  ["safety agent instructions update", "Prepare a risk-aware overview.", ["safety_agent"], [], ["safety_agent"]],
  ["writer instructions only", "Prepare a concise executive memo.", ["writer_agent"], ["writer_agent"], ["writer_agent"]],
  ["unchanged FAQ repeat", "Answer a common product question.", [], [], []],
  ["unchanged business plan repeat", "Create a textile business plan.", [], [], []],
  ["unchanged document analysis repeat", "Compare two uploaded documents.", [], [], []],
  ["source changes but yields identical facts", "Check whether the recommendation still holds.", ["research_agent"], [], ["research_agent"]],
  ["safety source changes but same conclusion", "Check whether the safety advice still holds.", ["safety_agent"], [], ["safety_agent"]],
  ["both sources change but facts stay equal", "Recheck both evidence branches.", ["research_agent", "safety_agent"], [], ["research_agent", "safety_agent"]],
  ["archived research specialist", "Rebuild the research-backed answer.", ["research_agent"], ["research_agent"], ["research_agent", "writer_agent"]],
  ["archived safety specialist", "Rebuild the safety-backed answer.", ["safety_agent"], ["safety_agent"], ["safety_agent", "writer_agent"]],
  ["ten-document weather branch update", "Synthesize ten documents; only the weather brief changed.", ["safety_agent"], ["safety_agent"], ["safety_agent", "writer_agent"]],
  ["corrected research plus unchanged safety", "Update the report from corrected evidence.", ["research_agent"], ["research_agent"], ["research_agent", "writer_agent"]],
  ["corrected safety plus unchanged research", "Update the report from corrected safeguards.", ["safety_agent"], ["safety_agent"], ["safety_agent", "writer_agent"]]
];

describe("30 realistic selective-wake scenarios", () => {
  it.each(REAL_LIFE_SCENARIOS)("%s", (_name, query, changedAgents, changedOutputs, expectedRefresh) => {
    const base = fixture({ query });
    const agents = base.agents.map((item) => changedAgents.includes(item.id)
      ? { ...item, capability: `${item.capability} Revision 2.` }
      : item);
    const outputVersions = Object.fromEntries(changedOutputs.map((id) => [id, "v2"]));
    const result = replayFixture(base, { agents, outputVersions });
    const actualRefresh = Object.entries(result.actions).filter(([, action]) => action === "refreshed").map(([id]) => id);
    expect(actualRefresh).toEqual(expectedRefresh);
    const actualKept = Object.entries(result.actions).filter(([, action]) => action === "kept").map(([id]) => id);
    expect(new Set([...actualRefresh, ...actualKept])).toEqual(new Set(["research_agent", "safety_agent", "writer_agent"]));
  });
});

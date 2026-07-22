import crypto from "node:crypto";
import {
  RUNTIME_PLAN_CONTRACT_VERSIONS,
  runtimeStreamTaskProjection
} from "./agentRuntimeClient.js";
import { digestValue } from "./outcomes.js";
import { normalizeRuntimeRouting } from "./routeResultNormalizer.js";

export const MAX_MESSAGE_CHARS = 12000;

export function configuredResourceDependencies(agent = {}) {
  return [...new Set((agent.resources || [])
    .map((value) => String(value || "").match(/^agent:([a-z0-9_-]+)$/i)?.[1])
    .filter(Boolean))];
}

export function configuredHandoffDependencies(agent = {}) {
  return [...new Set((agent.consumes || [])
    .map((value) => String(value || "").match(/^agent:([a-z0-9_-]+):output$/i)?.[1])
    .filter(Boolean))];
}

export function buildParallelBatches(steps, workers = 2) {
  const ids = new Set();
  for (const step of steps) {
    if (ids.has(step.id)) {
      throwDagError("duplicate_step_id", `Duplicate step id: ${step.id}`);
    }
    ids.add(step.id);
  }

  for (const step of steps) {
    for (const dep of step.depends_on || []) {
      if (!ids.has(dep)) {
        throwDagError("unresolved_dependency", `Step ${step.id} depends on missing step ${dep}`);
      }
    }
  }

  const completed = new Set();
  const remaining = [...steps];
  const batches = [];

  while (remaining.length > 0) {
    const ready = remaining.filter((step) => (step.depends_on || []).every((dep) => completed.has(dep)));
    if (ready.length === 0) {
      throwDagError("cyclic_dependency", "Route DAG contains a dependency cycle.");
    }
    const batchNumber = batches.length + 1;
    batches.push({
      batch: batchNumber,
      width: ready.length,
      workers,
      steps: ready.map((step) => step.id)
    });
    for (const step of ready) {
      completed.add(step.id);
      remaining.splice(remaining.indexOf(step), 1);
    }
  }

  return {
    workers,
    batches,
    maxBatchWidth: batches.reduce((max, batch) => Math.max(max, batch.width), 0),
    parallelizable: batches.some((batch) => batch.width > 1)
  };
}

function throwDagError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.status = 400;
  throw error;
}

export function normalizeRuntimePlan(plan) {
  if (plan?.steps) {
    return {
      steps: plan.steps,
      adapters: plan.adapters || plan.steps.map((step) => step.adapter),
      edges: plan.edges || plan.steps.flatMap((step) => (step.depends_on || []).map((source) => ({ source, target: step.id }))),
      acyclic: plan.acyclic !== false,
      routing: normalizeRuntimeRouting(plan.routing)
    };
  }
  return { steps: [], adapters: [], edges: [], acyclic: true, routing: null };
}

export function runtimePlanSafeProjectionDigest(plan) {
  return digestValue((Array.isArray(plan?.steps) ? plan.steps : []).map((step) => ({
    id: String(step.id || ""),
    adapter: String(step.adapter || ""),
    // The progress stream deliberately projects tasks onto the same compact
    // public representation as Runtime: strip controls, collapse whitespace,
    // and cap at 600 characters. Compare identical projections so a legitimate
    // multiline or detailed task cannot fail merely because its safe preview
    // differs from the exact terminal execution text.
    task: runtimeStreamTaskProjection(step.task),
    depends_on: (Array.isArray(step.depends_on) ? step.depends_on : []).map(String)
  })));
}

export function runtimePlanExactContractDigest(
  plan,
  schemaVersion = RUNTIME_PLAN_CONTRACT_VERSIONS[0]
) {
  if (!RUNTIME_PLAN_CONTRACT_VERSIONS.includes(schemaVersion)) {
    throw new Error("Unsupported Runtime plan contract version.");
  }
  const rawRouting = plan?.routing || {};
  const rawOrchestrator = rawRouting?.orchestrator || {};
  const rawOutcome = rawOrchestrator?.outcome_contract || {};
  const clarificationQuestion = String(rawOrchestrator.clarification_question || "");
  const commonOutcomeContract = {
    contract_version: String(rawOutcome.contract_version || ""),
    compiler_authority: String(rawOutcome.compiler_authority || ""),
    status: String(rawOutcome.status || ""),
    route_admission_contract_version: String(rawOutcome.route_admission_contract_version || ""),
    deliverables: (Array.isArray(rawOutcome.deliverables) ? rawOutcome.deliverables : []).map((row) => ({
      id: String(row?.id || ""),
      title_sha256: crypto.createHash("sha256").update(String(row?.title || ""), "utf8").digest("hex"),
      description_sha256: crypto.createHash("sha256").update(String(row?.description || ""), "utf8").digest("hex"),
      required: row?.required !== false,
      evidence_requirement: String(row?.evidence_requirement || ""),
      required_outputs: (Array.isArray(row?.required_outputs) ? row.required_outputs : []).map(String),
      controller_can_synthesize: row?.controller_can_synthesize === true,
      assigned_to_session_controller: row?.assigned_to_session_controller === true
    })),
    steps: runtimeRouteAdmissionDigestProjection(rawOutcome.steps)
  };
  const steps = (Array.isArray(plan?.steps) ? plan.steps : []).map((step) => ({
    id: String(step.id || ""),
    adapter: String(step.adapter || ""),
    depends_on: (Array.isArray(step.depends_on) ? step.depends_on : []).map(String),
    evidence_requirement: String(step.evidence_requirement || ""),
    expected_outputs: (Array.isArray(step.expected_outputs) ? step.expected_outputs : []).map(String),
    fulfills: (Array.isArray(step.fulfills) ? step.fulfills : []).map(String),
    task_sha256: crypto.createHash("sha256")
      .update(String(step.task || ""), "utf8")
      .digest("hex")
  }));
  const material = schemaVersion === "tcar-runtime-plan-contract-v4"
    ? {
      schema_version: schemaVersion,
      steps,
      outcome_contract: commonOutcomeContract
    }
    : {
    schema_version: schemaVersion,
    steps,
    orchestrator: {
      contract_version: String(rawOrchestrator.contract_version || ""),
      decision: String(rawOrchestrator.decision || ""),
      clarification_question_sha256: crypto.createHash("sha256")
        .update(clarificationQuestion, "utf8")
        .digest("hex"),
      final_synthesis_required: rawOrchestrator.final_synthesis_required === true,
      fallback_used: String(rawOrchestrator.fallback_used || ""),
      fallback: String(rawRouting.fallback || "")
    },
    outcome_contract: {
      ...commonOutcomeContract,
      coverage: (Array.isArray(rawOutcome.coverage) ? rawOutcome.coverage : [])
        .filter((row) => row && typeof row === "object" && !Array.isArray(row))
        .map((row) => ({
          deliverable_id: String(row.deliverable_id || ""),
          covered: row.covered === true,
          fulfilling_steps: (Array.isArray(row.fulfilling_steps) ? row.fulfilling_steps : []).map(String),
          controller_synthesis: row.controller_synthesis === true
        })),
      violations: (Array.isArray(rawOutcome.violations) ? rawOutcome.violations : []).map(String)
    }
  };
  const canonical = JSON.stringify(canonicalRuntimeContractValue(material));
  return `sha256:${crypto.createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

function runtimePlanContractDigestMatches(plan, digest, selectedVersion = null) {
  const versions = selectedVersion
    ? [selectedVersion]
    : RUNTIME_PLAN_CONTRACT_VERSIONS;
  return versions.some((version) => (
    runtimePlanExactContractDigest(plan, version) === digest
  ));
}

export function assertRuntimePlanStreamCommit({
  rawTerminalPlan,
  normalizedTerminalPlan,
  streamedSafePlanDigest = null,
  streamedExactPlanDigest = null,
  streamedExactPlanContractVersion = null
}) {
  const exactContractMatches = streamedExactPlanDigest
    ? runtimePlanContractDigestMatches(
      rawTerminalPlan,
      streamedExactPlanDigest,
      streamedExactPlanContractVersion
    )
    : false;
  if (streamedExactPlanDigest && !exactContractMatches) {
    const error = new Error("Runtime terminal plan did not match its exact execution contract digest.");
    error.code = "runtime_stream_plan_mismatch";
    error.status = 502;
    error.component = "runtime_plan_exact_contract";
    throw error;
  }

  const safeProjectionMismatch = Boolean(
    streamedSafePlanDigest
    && runtimePlanSafeProjectionDigest(normalizedTerminalPlan) !== streamedSafePlanDigest
  );
  if (safeProjectionMismatch && !exactContractMatches) {
    const error = new Error("Runtime terminal plan did not match its streamed planner contract.");
    error.code = "runtime_stream_plan_mismatch";
    error.status = 502;
    error.component = "runtime_plan_safe_projection";
    throw error;
  }
  return {
    exact_contract_verified: exactContractMatches,
    safe_projection_reconciled: safeProjectionMismatch && exactContractMatches
  };
}

function runtimeRouteAdmissionDigestProjection(value) {
  return (Array.isArray(value) ? value : [])
    .filter((row) => row && typeof row === "object" && !Array.isArray(row))
    .map((row) => {
      const admission = row.route_admission && typeof row.route_admission === "object" && !Array.isArray(row.route_admission)
        ? row.route_admission
        : {};
      return {
        step_id: String(row.step_id || ""),
        route_admission_valid: row.route_admission_valid === true,
        route_dependency_closure_valid: row.route_dependency_closure_valid === true,
        route_admission: {
          contract_version: String(admission.contract_version || ""),
          valid: admission.valid === true,
          route_role: String(admission.route_role || ""),
          obligation_source: String(admission.obligation_source || ""),
          deliverable_ids: (Array.isArray(admission.deliverable_ids) ? admission.deliverable_ids : []).map(String),
          expected_outputs: (Array.isArray(admission.expected_outputs) ? admission.expected_outputs : []).map(String),
          downstream_bindings: (Array.isArray(admission.downstream_bindings) ? admission.downstream_bindings : [])
            .filter((binding) => binding && typeof binding === "object" && !Array.isArray(binding))
            .map((binding) => ({
              consumer_step_id: String(binding.consumer_step_id || ""),
              consumer_adapter: String(binding.consumer_adapter || ""),
              input: String(binding.input || ""),
              output: String(binding.output || "")
            })),
          strict_constraints_checked: (Array.isArray(admission.strict_constraints_checked) ? admission.strict_constraints_checked : []).map(String),
          violations: (Array.isArray(admission.violations) ? admission.violations : []).map(String),
          obligation_sha256: crypto.createHash("sha256")
            .update(String(admission.obligation || ""), "utf8")
            .digest("hex")
        }
      };
    });
}

function canonicalRuntimeContractValue(value) {
  if (Array.isArray(value)) return value.map(canonicalRuntimeContractValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalRuntimeContractValue(value[key])])
  );
}

export function assertRuntimePlan(plan, {
  allowedAdapters = [],
  maxSteps = 16,
  maxResourceSupportSteps = 0,
  agents = []
} = {}) {
  const fail = (detail) => {
    const error = new Error(`runtime_contract_invalid: ${detail}`);
    error.code = "runtime_contract_invalid";
    error.retryable = false;
    throw error;
  };
  const rawSteps = Array.isArray(plan?.steps) ? plan.steps : [];
  const routeLimit = Math.max(1, Math.min(Number(maxSteps) || 16, 16));
  const resourceSupportLimit = Math.max(0, Math.min(Number(maxResourceSupportSteps) || 0, 24));
  const absoluteStepLimit = routeLimit + resourceSupportLimit;
  if (rawSteps.length > absoluteStepLimit) {
    fail(`runtime plan exceeds the ${absoluteStepLimit}-step combined route limit`);
  }
  const allowed = new Set((allowedAdapters || []).map(String));
  const agentById = new Map((agents || []).map((agent) => [String(agent?.id || ""), agent]));
  const contractIdentifiers = (value, field, maximum = 32) => {
    if (!Array.isArray(value) || value.length > maximum) fail(`runtime ${field} is malformed`);
    const rows = [];
    for (const raw of value) {
      if (typeof raw !== "string") fail(`runtime ${field} contains a non-string identifier`);
      const normalized = raw.trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(normalized)) {
        fail(`runtime ${field} contains an invalid identifier`);
      }
      if (!rows.includes(normalized)) rows.push(normalized);
    }
    return rows;
  };
  const normalizedSteps = rawSteps.map((step) => {
    if (!step || typeof step !== "object" || Array.isArray(step)) fail("runtime plan contains a malformed step");
    const id = String(step.id || "");
    const adapter = String(step.adapter || "");
    const task = String(step.task || "");
    const evidenceRequirement = String(step.evidence_requirement || "").trim().toLowerCase();
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/.test(id)) fail("runtime plan contains an invalid step id");
    if (!adapter || adapter.length > 240 || !allowed.has(adapter)) {
      fail(`runtime plan selected an unauthorized agent for step ${id}`);
    }
    if (task.length > MAX_MESSAGE_CHARS) fail(`runtime task is too large for step ${id}`);
    if (!Array.isArray(step.depends_on || [])) fail(`runtime dependencies are malformed for step ${id}`);
    const dependsOn = (step.depends_on || []).map((dependency) => String(dependency || ""));
    if (
      dependsOn.length > absoluteStepLimit
      || new Set(dependsOn).size !== dependsOn.length
      || dependsOn.some((dependency) => !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/.test(dependency))
    ) fail(`runtime dependencies are invalid for step ${id}`);
    if (
      evidenceRequirement
      && !["live_external", "supplied_context", "none", "unknown"].includes(evidenceRequirement)
    ) fail(`runtime plan contains an invalid evidence requirement for step ${id}`);
    const expectedOutputs = step.expected_outputs === undefined
      ? null
      : contractIdentifiers(step.expected_outputs, `expected outputs for step ${id}`);
    const fulfills = step.fulfills === undefined
      ? null
      : contractIdentifiers(step.fulfills, `deliverable assignments for step ${id}`, 24);
    if (expectedOutputs) {
      const declared = new Set((agentById.get(adapter)?.produces || []).map((value) => String(value || "").trim()));
      if (expectedOutputs.some((name) => !declared.has(name))) {
        fail(`runtime step ${id} expects an output not declared by ${adapter}`);
      }
    }
    return {
      id,
      adapter,
      task,
      depends_on: dependsOn,
      ...(evidenceRequirement ? { evidence_requirement: evidenceRequirement } : {}),
      ...(expectedOutputs ? { expected_outputs: expectedOutputs } : {}),
      ...(fulfills ? { fulfills } : {})
    };
  });
  try {
    buildParallelBatches(normalizedSteps, 1);
  } catch (cause) {
    fail(`runtime plan is not a valid acyclic graph: ${cause.message}`);
  }
  const routedAdapters = [
    ...(plan?.routing?.selected || []).map((item) => item?.adapter),
    ...(plan?.routing?.candidate_adapters || []),
    ...(plan?.routing?.candidate_trace || []).map((item) => item?.adapter)
  ].filter(Boolean).map(String);
  if (routedAdapters.some((adapter) => !allowed.has(adapter))) {
    fail("runtime routing trace contains an unauthorized agent");
  }
  const routingMode = String(plan?.routing?.mode || "");
  if (routingMode && routingMode !== "session") {
    fail("runtime routing mode must use the fixed semantic session");
  }
  const orchestrator = plan?.routing?.orchestrator || null;
  const outcomeContract = orchestrator?.outcome_contract;
  const strictStepContracts = orchestrator?.contract_version === "session-orchestrator-v3";
  if (orchestrator) {
    const supportedVersions = new Set([
      "session-orchestrator-v1",
      "session-orchestrator-v2",
      "session-orchestrator-v3"
    ]);
    const decision = String(orchestrator.decision || "");
    if (!supportedVersions.has(String(orchestrator.contract_version || ""))) {
      fail("runtime plan has an unsupported orchestrator contract");
    }
    if (routingMode !== "session") {
      fail("runtime orchestrator is attached to a non-session plan");
    }
    if (!["direct", "delegate", "clarify"].includes(decision)) {
      fail("runtime plan has an invalid orchestrator decision");
    }
    if ((normalizedSteps.length > 0) !== (decision === "delegate")) {
      fail("runtime orchestrator decision does not match its executable routes");
    }
    if (decision === "clarify" && !String(orchestrator.clarification_question || "").trim()) {
      fail("runtime clarification decision contains no question");
    }
    if (
      strictStepContracts
      && orchestrator.final_synthesis_required !== (decision !== "clarify")
    ) {
      fail("runtime orchestrator has an invalid synthesis state");
    }
    if (strictStepContracts && !outcomeContract) {
      fail("runtime v3 plan is missing its outcome contract");
    }
  }
  if (outcomeContract) {
    const decision = String(orchestrator.decision || "");
    const clarificationQuestion = String(orchestrator.clarification_question || "").trim();
    const blockedClarification = strictStepContracts
      && decision === "clarify"
      && normalizedSteps.length === 0
      && outcomeContract.status === "blocked";
    if (outcomeContract.compiler_authority !== "runtime") {
      fail("runtime outcome contract lacks compiler authority");
    }
    if (outcomeContract.contract_version !== "session-outcome-v1") {
      fail("runtime outcome contract has an unsupported version");
    }
    if (strictStepContracts) {
      if (decision === "delegate") {
        if (normalizedSteps.length === 0 || outcomeContract.status !== "covered") {
          fail("runtime delegated outcome contract is not executable");
        }
      } else if (decision === "direct") {
        if (normalizedSteps.length !== 0 || outcomeContract.status !== "not_applicable") {
          fail("runtime direct outcome contract has an invalid execution state");
        }
      } else if (decision === "clarify") {
        if (
          normalizedSteps.length !== 0
          || !["blocked", "not_applicable"].includes(outcomeContract.status)
          || !clarificationQuestion
        ) {
          fail("runtime clarification outcome contract has an invalid execution state");
        }
      } else {
        fail("runtime outcome contract has an invalid orchestrator decision");
      }
    } else if (
      (normalizedSteps.length > 0 && outcomeContract.status !== "covered")
      || (normalizedSteps.length === 0 && !["covered", "not_applicable"].includes(outcomeContract.status))
    ) {
      fail("runtime outcome contract is not executable");
    }
    const deliverables = Array.isArray(outcomeContract.deliverables) ? outcomeContract.deliverables : [];
    if (normalizedSteps.length > 0 && deliverables.length === 0) {
      fail("runtime delegated outcome contract has no deliverables");
    }
    const deliverableRows = deliverables.map((item) => ({
      ...item,
      id: String(item?.id || ""),
      required_outputs: contractIdentifiers(
        item?.required_outputs || [],
        `required outputs for deliverable ${String(item?.id || "missing")}`
      )
    }));
    const deliverableIds = new Set(deliverableRows.map((item) => item.id).filter(Boolean));
    if (
      deliverableIds.size !== deliverableRows.length
      || [...deliverableIds].some((id) => !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/.test(id))
    ) {
      fail("runtime outcome contract contains invalid or duplicate deliverables");
    }
    if (blockedClarification) {
      if (deliverableRows.length === 0 || !Array.isArray(outcomeContract.violations) || outcomeContract.violations.length === 0) {
        fail("runtime blocked clarification lacks compiler diagnostics");
      }
      if ((plan?.routing?.selected || []).length > 0) {
        fail("runtime blocked clarification exposes an executable selection");
      }
      const coverageRows = Array.isArray(outcomeContract.coverage) ? outcomeContract.coverage : [];
      const coverageIds = coverageRows.map((item) => String(item?.deliverable_id || ""));
      if (
        coverageRows.length !== deliverableRows.length
        || new Set(coverageIds).size !== coverageIds.length
        || coverageIds.some((id) => !deliverableIds.has(id))
      ) {
        fail("runtime blocked clarification has inconsistent outcome coverage");
      }
    }
    if (deliverableRows.some((item) => (
      item.evidence_requirement === "live_external"
      && (item.controller_can_synthesize === true || item.assigned_to_session_controller === true)
    ))) {
      fail("runtime outcome contract delegates live evidence to synthesis");
    }
    if (strictStepContracts && normalizedSteps.some((step) => (
      !Object.prototype.hasOwnProperty.call(step, "expected_outputs")
      || !Object.prototype.hasOwnProperty.call(step, "fulfills")
      || step.expected_outputs.length === 0
    ))) {
      fail("runtime v3 plan omits a compiled step contract");
    }
    const routeAdmissionVersion = String(outcomeContract.route_admission_contract_version || "");
    if (routeAdmissionVersion && routeAdmissionVersion !== "session-route-admission-v1") {
      fail("runtime outcome contract has an unsupported route admission contract");
    }
    if (
      strictStepContracts
      && ["covered", "blocked"].includes(outcomeContract.status)
      && routeAdmissionVersion !== "session-route-admission-v1"
    ) {
      fail("runtime v3 outcome contract is missing its route admission contract");
    }
    if (strictStepContracts && !blockedClarification && routeAdmissionVersion === "session-route-admission-v1") {
      const proofRows = Array.isArray(outcomeContract.steps) ? outcomeContract.steps : [];
      const executableById = new Map(normalizedSteps.map((step) => [step.id, step]));
      const proofById = new Map();
      for (const proof of proofRows) {
        const stepId = String(proof?.step_id || "");
        if (!executableById.has(stepId) || proofById.has(stepId)) {
          fail("runtime route admission proof has invalid step identity coverage");
        }
        proofById.set(stepId, proof);
      }
      if (proofRows.length !== normalizedSteps.length || proofById.size !== normalizedSteps.length) {
        fail("runtime route admission proof does not cover every executable step");
      }
      const requiredChecks = new Set([
        "activation_policy", "boundary", "write_policy", "tool_policy",
        "source_policy", "escalation_policy"
      ]);
      const semanticAuthority = String(outcomeContract.semantic_authority || "");
      const semanticModelLed = semanticAuthority === "semantic_model_led"
        // Direct callers may validate the legacy wire value before routing
        // normalization. Keep that ingress compatibility explicit while all
        // normalized plans use the provider-neutral authority above.
        || semanticAuthority === "qwen_model_led";
      for (const step of normalizedSteps) {
        const proof = proofById.get(step.id);
        const admission = proof?.route_admission;
        if (
          !admission
          || typeof admission !== "object"
          || Array.isArray(admission)
          || admission.contract_version !== "session-route-admission-v1"
          || admission.valid !== true
          || proof.route_admission_valid !== true
          || proof.route_dependency_closure_valid !== true
          || (Array.isArray(admission.violations) && admission.violations.length > 0)
        ) {
          fail(`runtime step ${step.id} lacks a valid route admission proof`);
        }
        const proofOutputs = contractIdentifiers(
          admission.expected_outputs,
          `route admission expected outputs for step ${step.id}`
        );
        const proofDeliverables = contractIdentifiers(
          admission.deliverable_ids,
          `route admission deliverables for step ${step.id}`,
          24
        );
        if (
          JSON.stringify([...proofOutputs].sort()) !== JSON.stringify([...(step.expected_outputs || [])].sort())
          || JSON.stringify([...proofDeliverables].sort()) !== JSON.stringify([...(step.fulfills || [])].sort())
        ) {
          fail(`runtime step ${step.id} route admission contract changed`);
        }
        const checked = new Set(contractIdentifiers(
          admission.strict_constraints_checked,
          `route admission constraints for step ${step.id}`,
          24
        ));
        // The semantic model and independent adjudicator own membership for a
        // semantic-first plan. The compiler's prose-policy pass is audit data,
        // not an English lexical veto that may be reintroduced by the web
        // boundary after every GPU worker has already completed.
        const requiredChecksPresent = semanticModelLed
          ? checked.has("semantic_policy_diagnostics_only")
          : [...requiredChecks].every((name) => checked.has(name));
        if (!requiredChecksPresent) {
          fail(`runtime step ${step.id} route admission omits a strict constraint`);
        }
        const downstream = normalizedSteps.filter((candidate) => candidate.depends_on.includes(step.id));
        const expectedRole = step.fulfills.length
          ? (downstream.length ? "outcome_owner_and_prerequisite" : "outcome_owner")
          : "prerequisite";
        const expectedObligationSource = expectedRole === "outcome_owner"
          ? "compiled_deliverables"
          : expectedRole === "prerequisite"
            ? "typed_downstream_bindings"
            : "compiled_deliverables_and_typed_downstream_bindings";
        if (
          admission.route_role !== expectedRole
          || admission.obligation_source !== expectedObligationSource
        ) {
          fail(`runtime step ${step.id} route admission role is inconsistent with the DAG`);
        }
        const seenBindings = new Set();
        for (const binding of Array.isArray(admission.downstream_bindings) ? admission.downstream_bindings : []) {
          const consumerId = String(binding?.consumer_step_id || "");
          const consumer = executableById.get(consumerId);
          const identity = JSON.stringify([
            consumerId,
            String(binding?.consumer_adapter || ""),
            String(binding?.input || ""),
            String(binding?.output || "")
          ]);
          if (
            seenBindings.has(identity)
            || !consumer
            || !consumer.depends_on.includes(step.id)
            || String(binding?.consumer_adapter || "") !== consumer.adapter
            || !proofOutputs.includes(String(binding?.output || ""))
          ) {
            fail(`runtime step ${step.id} route admission contains an invalid binding`);
          }
          seenBindings.add(identity);
        }
      }
    }
    if (!blockedClarification) {
      const assigned = new Set();
      const assignedOutputs = new Map(deliverableRows.map((item) => [item.id, new Set()]));
      for (const step of normalizedSteps) {
        for (const deliverableId of step.fulfills || []) {
          if (!deliverableIds.has(deliverableId)) {
            fail(`runtime step ${step.id} references an unknown deliverable`);
          }
          assigned.add(deliverableId);
          for (const outputName of step.expected_outputs || []) {
            assignedOutputs.get(deliverableId).add(outputName);
          }
        }
      }
      for (const deliverable of deliverableRows) {
        if (
          deliverable.required !== false
          && !assigned.has(deliverable.id)
          && deliverable.controller_can_synthesize !== true
          && deliverable.assigned_to_session_controller !== true
        ) {
          fail(`runtime outcome contract leaves required deliverable ${deliverable.id} uncovered`);
        }
        if (
          deliverable.required_outputs.some((name) => !assignedOutputs.get(deliverable.id)?.has(name))
          && deliverable.assigned_to_session_controller !== true
        ) {
          fail(`runtime outcome contract lacks a producer for ${deliverable.id}`);
        }
      }
    }
  }
  const selectedAgents = normalizedSteps
    .map((step) => agentById.get(step.adapter))
    .filter(Boolean);
  const selectionSource = new Map(
    (plan?.routing?.selected || [])
      .filter((selection) => selection?.adapter)
      .map((selection) => [String(selection.adapter), String(selection.source || "")])
  );
  const resourceDependencies = new Set(
    selectedAgents.flatMap((agent) => configuredResourceDependencies(agent))
  );
  const hardHandoffDependencies = new Set(
    selectedAgents.flatMap((agent) => configuredHandoffDependencies(agent))
  );
  const resourceSupportAdapters = new Set(
    normalizedSteps
      .map((step) => step.adapter)
      .filter((adapter) => {
        const source = selectionSource.get(adapter);
        return agentById.has(adapter)
          && resourceDependencies.has(adapter)
          && !hardHandoffDependencies.has(adapter)
          && ["configured_handoff", "configured_resource"].includes(source);
      })
  );
  if (resourceSupportAdapters.size > resourceSupportLimit) {
    fail(`runtime plan exceeds the ${resourceSupportLimit}-resource support limit`);
  }
  if (normalizedSteps.length - resourceSupportAdapters.size > routeLimit) {
    fail(`runtime plan exceeds the ${routeLimit}-specialist route limit`);
  }
  return {
    ...plan,
    steps: normalizedSteps,
    adapters: [...new Set(normalizedSteps.map((step) => step.adapter))],
    edges: normalizedSteps.flatMap((step) => step.depends_on.map((source) => ({ source, target: step.id }))),
    acyclic: true
  };
}

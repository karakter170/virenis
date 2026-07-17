import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, resolveLifecycleTimeouts } from "../server/app.js";
import { verifyExecutionRecord } from "../server/outcomes.js";

let tmpDir;
let app;
let previousEnv;

beforeEach(async () => {
  previousEnv = {
    NODE_ENV: process.env.NODE_ENV,
    WEB_STORE_DRIVER: process.env.WEB_STORE_DRIVER,
    TCAR_ENGINE_MODE: process.env.TCAR_ENGINE_MODE,
    APP_API_TOKENS_JSON: process.env.APP_API_TOKENS_JSON
  };
  delete process.env.NODE_ENV;
  process.env.WEB_STORE_DRIVER = "json";
  process.env.TCAR_ENGINE_MODE = "simulator";
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "virenis-recovery-"));
});

afterEach(async () => {
  await app?.locals?.drainBackgroundTasks?.({ timeoutMs: 5000 });
  await app?.locals?.store?.close?.();
  await fs.rm(tmpDir, { recursive: true, force: true });
  for (const [name, value] of Object.entries(previousEnv || {})) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

async function seedQueuedChat(seedApp, options = {}) {
  const session = await request(seedApp)
    .post("/api/chat/sessions")
    .send({ title: "Durable recovery" })
    .expect(201);
  const queued = await request(seedApp)
    .post(`/api/chat/sessions/${session.body.session_id}/messages`)
    .send({
      content: "Plan a privacy-safe financial review.",
      options
    })
    .expect(202);
  return { session: session.body, runId: queued.body.run_id };
}

function completeChatProcessor(spy) {
  return async ({ store, run_id: runId, options }) => {
    spy({ runId, options });
    await store.mutate((data) => {
      const run = data.runs.find((item) => item.run_id === runId);
      run.status = "completed";
      run.started_at ||= new Date().toISOString();
      run.completed_at = new Date().toISOString();
      run.final_answer = "Recovered exactly once.";
      run.events.push({ type: "final.completed", at: run.completed_at });
      return run;
    });
  };
}

function completeValidationProcessor(spy) {
  return async ({ store, validation_run_id: validationRunId, attempt_id: attemptId }) => {
    spy({ validationRunId, attemptId });
    await store.mutate((data) => {
      const validation = data.validationRuns.find((item) => item.validation_run_id === validationRunId);
      validation.status = "completed";
      validation.ok = true;
      validation.completed_at = new Date().toISOString();
      validation.summary = { recovered: true };
      return validation;
    });
  };
}

describe("durable background recovery", () => {
  it("preserves safe actionable model failures while keeping diagnostics private", async () => {
    const dbPath = path.join(tmpDir, "actionable-errors.json");
    const failingProcessor = async () => {
      const error = new Error("private provider timeout diagnostics");
      error.code = "model_timeout";
      error.status = 504;
      throw error;
    };
    process.env.APP_API_TOKENS_JSON = JSON.stringify({
      actionableusertoken: { user_id: "action_user", workspace_id: "workspace_default", role: "user" }
    });
    app = await createApp({ dbPath, uploadRoot: tmpDir, chatProcessor: failingProcessor });
    const session = await request(app)
      .post("/api/chat/sessions")
      .set("Authorization", "Bearer actionableusertoken")
      .send({ title: "Actionable failure" })
      .expect(201);
    const queued = await request(app)
      .post(`/api/chat/sessions/${session.body.session_id}/messages`)
      .set("Authorization", "Bearer actionableusertoken")
      .send({ content: "Test the model timeout." })
      .expect(202);
    await app.locals.drainBackgroundTasks({ timeoutMs: 5000 });

    const response = await request(app)
      .get(`/api/chat/runs/${queued.body.run_id}`)
      .set("Authorization", "Bearer actionableusertoken")
      .expect(200);
    expect(response.body.status).toBe("failed");
    expect(response.body.error).toEqual({
      code: "model_timeout",
      message: "The model took too long to respond. Your message is still available—try again.",
      retryable: true,
      action: "retry"
    });
    expect(response.body).not.toHaveProperty("error_admin_only");
    expect(JSON.stringify(response.body)).not.toContain("private provider timeout diagnostics");
  });

  it("classifies an idle Runtime event stream as transport recovery, not a model timeout", async () => {
    const dbPath = path.join(tmpDir, "stream-idle-errors.json");
    const failingProcessor = async () => {
      const error = new Error("private transport diagnostics");
      error.code = "runtime_stream_idle_timeout";
      error.status = 504;
      error.retryable = true;
      throw error;
    };
    process.env.APP_API_TOKENS_JSON = JSON.stringify({
      streamidleusertoken: { user_id: "stream_idle_user", workspace_id: "workspace_default", role: "user" },
      streamidleadmintoken: { user_id: "stream_idle_admin", workspace_id: "workspace_default", role: "admin" }
    });
    app = await createApp({ dbPath, uploadRoot: tmpDir, chatProcessor: failingProcessor });
    const session = await request(app)
      .post("/api/chat/sessions")
      .set("Authorization", "Bearer streamidleusertoken")
      .send({ title: "Stream idle failure" })
      .expect(201);
    const queued = await request(app)
      .post(`/api/chat/sessions/${session.body.session_id}/messages`)
      .set("Authorization", "Bearer streamidleusertoken")
      .send({ content: "Test the Runtime transport." })
      .expect(202);
    await app.locals.drainBackgroundTasks({ timeoutMs: 5000 });

    const response = await request(app)
      .get(`/api/chat/runs/${queued.body.run_id}`)
      .set("Authorization", "Bearer streamidleusertoken")
      .expect(200);
    expect(response.body.error).toEqual({
      code: "model_connection_interrupted",
      message: "The connection to the model runtime stopped receiving progress. Your message is still available—try again.",
      retryable: true,
      action: "retry"
    });
    expect(response.body.error.code).not.toBe("model_timeout");
    expect(JSON.stringify(response.body)).not.toContain("private transport diagnostics");

    const adminResponse = await request(app)
      .get(`/api/chat/runs/${queued.body.run_id}`)
      .set("Authorization", "Bearer streamidleadmintoken")
      .expect(200);
    expect(adminResponse.body.error).toMatchObject({ code: "model_connection_interrupted" });
    expect(adminResponse.body.error_admin_only).toMatchObject({
      code: "runtime_stream_idle_timeout",
      public_code: "model_connection_interrupted",
      status: 504,
      retryable: true
    });
    expect(JSON.stringify(adminResponse.body.error_admin_only)).not.toContain("private transport diagnostics");
  });

  it("resumes unclaimed queued chat and validation work exactly once", async () => {
    const dbPath = path.join(tmpDir, "db.json");
    app = await createApp({ dbPath, uploadRoot: tmpDir, autoRun: false });
    const { runId } = await seedQueuedChat(app, {
      planner_mode: "cue",
      parallel_workers: 3,
      max_routing_adapters: 7,
      max_tokens: 173,
      refiner_max_tokens: 311,
      temperature: 0.2
    });
    const validationRunId = "val_recovery_queued";
    await app.locals.store.mutate((data) => {
      data.validationRuns.push({
        validation_run_id: validationRunId,
        suite: "mock_smoke",
        case_filter: null,
        status: "queued",
        created_at: new Date().toISOString(),
        started_at: null,
        completed_at: null,
        ok: null,
        summary: null,
        events: []
      });
      return validationRunId;
    });
    await app.locals.store.close();
    app = null;

    const chatCalls = vi.fn();
    const validationCalls = vi.fn();
    app = await createApp({
      dbPath,
      uploadRoot: tmpDir,
      chatProcessor: completeChatProcessor(chatCalls),
      validationProcessor: completeValidationProcessor(validationCalls)
    });

    expect(app.locals.startupRecovery).toMatchObject({
      enabled: true,
      chats_rescheduled: 1,
      chats_interrupted: 0,
      validations_rescheduled: 1,
      validations_interrupted: 0
    });
    expect(app.locals.scheduleChatRun(runId)).toBe(false);
    expect(app.locals.scheduleValidationRun(validationRunId)).toBe(false);

    const drained = await app.locals.drainBackgroundTasks({ timeoutMs: 5000 });
    expect(drained.ok).toBe(true);
    expect(chatCalls).toHaveBeenCalledTimes(1);
    expect(validationCalls).toHaveBeenCalledTimes(1);
    expect(chatCalls.mock.calls[0][0].options).toMatchObject({
      planner_mode: "cue",
      parallel_workers: 3,
      max_routing_adapters: 7,
      max_tokens: 173,
      refiner_max_tokens: 311,
      temperature: 0.2
    });

    const recoveredRun = app.locals.store.read((data) => data.runs.find((item) => item.run_id === runId));
    const recoveredValidation = app.locals.store.read((data) =>
      data.validationRuns.find((item) => item.validation_run_id === validationRunId)
    );
    expect(recoveredRun.status).toBe("completed");
    expect(recoveredRun.dispatch).toMatchObject({ state: "finished", recovered: true });
    expect(recoveredRun.events.some((event) => event.type === "run.recovered")).toBe(true);
    expect(recoveredValidation.status).toBe("completed");
    expect(recoveredValidation.dispatch).toMatchObject({ state: "finished", recovered: true });
    expect(recoveredValidation.events.some((event) => event.type === "validation.recovered")).toBe(true);

    await app.locals.store.close();
    app = null;
    const duplicateChatCalls = vi.fn();
    const duplicateValidationCalls = vi.fn();
    app = await createApp({
      dbPath,
      uploadRoot: tmpDir,
      chatProcessor: completeChatProcessor(duplicateChatCalls),
      validationProcessor: completeValidationProcessor(duplicateValidationCalls)
    });
    await app.locals.drainBackgroundTasks({ timeoutMs: 5000 });
    expect(app.locals.startupRecovery.chats_rescheduled).toBe(0);
    expect(app.locals.startupRecovery.validations_rescheduled).toBe(0);
    expect(duplicateChatCalls).not.toHaveBeenCalled();
    expect(duplicateValidationCalls).not.toHaveBeenCalled();
  });

  it("terminalizes ambiguous in-flight work without invoking a processor", async () => {
    const dbPath = path.join(tmpDir, "db.json");
    app = await createApp({ dbPath, uploadRoot: tmpDir, autoRun: false });
    const first = await seedQueuedChat(app);
    const second = await seedQueuedChat(app);
    const startedAt = new Date(Date.now() - 5000).toISOString();
    await app.locals.store.mutate((data) => {
      const running = data.runs.find((item) => item.run_id === first.runId);
      running.status = "running";
      running.started_at = startedAt;
      running.dispatch = {
        attempt_id: "attempt_previous_chat",
        worker_instance_id: "worker_previous",
        state: "running",
        claimed_at: startedAt
      };
      const claimedQueued = data.runs.find((item) => item.run_id === second.runId);
      claimedQueued.dispatch = {
        attempt_id: "attempt_previous_queued_chat",
        worker_instance_id: "worker_previous",
        state: "running",
        claimed_at: startedAt
      };
      data.validationRuns.push(
        {
          validation_run_id: "val_previous_running",
          suite: "mock_smoke",
          case_filter: null,
          status: "running",
          created_at: startedAt,
          started_at: startedAt,
          completed_at: null,
          ok: null,
          summary: null,
          events: [],
          dispatch: {
            attempt_id: "attempt_previous_validation",
            worker_instance_id: "worker_previous",
            state: "running",
            claimed_at: startedAt
          }
        },
        {
          validation_run_id: "val_previous_claimed_queued",
          suite: "mock_smoke",
          case_filter: null,
          status: "queued",
          created_at: startedAt,
          started_at: null,
          completed_at: null,
          ok: null,
          summary: null,
          events: [],
          dispatch: {
            attempt_id: "attempt_previous_queued_validation",
            worker_instance_id: "worker_previous",
            state: "running",
            claimed_at: startedAt
          }
        }
      );
      return true;
    });
    await app.locals.store.close();
    app = null;

    const chatProcessor = vi.fn();
    const validationProcessor = vi.fn();
    app = await createApp({ dbPath, uploadRoot: tmpDir, chatProcessor, validationProcessor });
    await app.locals.drainBackgroundTasks({ timeoutMs: 5000 });

    expect(app.locals.startupRecovery).toMatchObject({
      chats_rescheduled: 0,
      chats_interrupted: 2,
      validations_rescheduled: 0,
      validations_interrupted: 2
    });
    expect(chatProcessor).not.toHaveBeenCalled();
    expect(validationProcessor).not.toHaveBeenCalled();

    for (const runId of [first.runId, second.runId]) {
      const run = app.locals.store.read((data) => data.runs.find((item) => item.run_id === runId));
      const execution = app.locals.store.read((data) =>
        data.executionRecords.find((item) => item.run_id === runId)
      );
      expect(run.status).toBe("failed");
      expect(run.error).toEqual({
        code: "run_interrupted",
        message: "The run was interrupted before completion and was not retried. Start a new run or contact support with the run id."
      });
      expect(run.dispatch.state).toBe("interrupted");
      expect(run.events.map((event) => event.type)).toContain("run.interrupted");
      expect(execution.status).toBe("failed");
      expect(verifyExecutionRecord(execution)).toBe(true);
    }

    process.env.APP_API_TOKENS_JSON = JSON.stringify({
      recoveryusertoken: { user_id: "user_local", workspace_id: "workspace_default", role: "user" },
      recoveryadmintoken: { user_id: "recovery_admin", workspace_id: "workspace_default", role: "admin" }
    });
    const userResult = await request(app)
      .get(`/api/chat/runs/${first.runId}`)
      .set("Authorization", "Bearer recoveryusertoken")
      .expect(200);
    expect(userResult.body.error).toEqual({
      code: "run_interrupted",
      message: "The run was interrupted before completion and was not retried. Start a new run or contact support with the run id."
    });
    expect(userResult.body).not.toHaveProperty("error_admin_only");
    expect(JSON.stringify(userResult.body)).not.toContain("worker_previous");

    const adminResult = await request(app)
      .get(`/api/chat/runs/${first.runId}`)
      .set("Authorization", "Bearer recoveryadmintoken")
      .expect(200);
    expect(adminResult.body.error_admin_only).toMatchObject({
      code: "run_interrupted",
      previous_status: "running"
    });

    const validations = app.locals.store.read((data) => data.validationRuns);
    for (const validation of validations) {
      expect(validation.status).toBe("failed");
      expect(validation.error.code).toBe("validation_interrupted");
      expect(validation.dispatch.state).toBe("interrupted");
      expect(validation.events.map((event) => event.type)).toContain("validation.interrupted");
    }
  });
});

describe("lifecycle timeout configuration", () => {
  it("derives shutdown budgets from the longest runtime operation", () => {
    expect(resolveLifecycleTimeouts({})).toEqual({
      runtimeOperationTimeoutMs: 900000,
      backgroundDrainTimeoutMs: 930000,
      shutdownTimeoutMs: 960000
    });
    expect(resolveLifecycleTimeouts({
      TCAR_RUNTIME_CHAT_TIMEOUT_MS: "1200000",
      TCAR_RUNTIME_ADMIN_TIMEOUT_MS: "600000",
      TCAR_RUNTIME_VALIDATION_TIMEOUT_SEC: "900"
    })).toEqual({
      runtimeOperationTimeoutMs: 1200000,
      backgroundDrainTimeoutMs: 1230000,
      shutdownTimeoutMs: 1260000
    });
    expect(resolveLifecycleTimeouts({
      TCAR_RUNTIME_CHAT_TIMEOUT_MS: "900000",
      TCAR_RUNTIME_WORKFLOW_TIMEOUT_MS: "1500000",
      TCAR_RUNTIME_CONTINUATION_TIMEOUT_MS: "1000000"
    })).toEqual({
      runtimeOperationTimeoutMs: 1500000,
      backgroundDrainTimeoutMs: 1530000,
      shutdownTimeoutMs: 1560000
    });
  });

  it("accepts explicit budgets and rejects invalid or inconsistent values", () => {
    expect(resolveLifecycleTimeouts({
      APP_BACKGROUND_DRAIN_TIMEOUT_MS: "4000",
      APP_SHUTDOWN_TIMEOUT_MS: "5000"
    })).toMatchObject({
      backgroundDrainTimeoutMs: 4000,
      shutdownTimeoutMs: 5000
    });
    for (const value of ["0", "-1", "1.5", "not-a-timeout", "2147483648", "9007199254740992"]) {
      expect(() => resolveLifecycleTimeouts({ APP_SHUTDOWN_TIMEOUT_MS: value })).toThrow();
    }
    expect(() => resolveLifecycleTimeouts({
      APP_BACKGROUND_DRAIN_TIMEOUT_MS: "5001",
      APP_SHUTDOWN_TIMEOUT_MS: "5000"
    })).toThrow(/greater than or equal/);
  });
});

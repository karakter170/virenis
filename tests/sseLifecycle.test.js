import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../server/app.js";

const ENV_KEYS = [
  "WEB_STORE_DRIVER",
  "APP_IDENTITY_PROVIDER",
  "APP_API_TOKENS_JSON",
  "APP_API_TOKENS",
  "APP_BASIC_AUTH_USER",
  "APP_BASIC_AUTH_PASSWORD",
  "APP_BASIC_AUTH_PASSWORD_FILE",
  "APP_SSE_MAX_STREAMS_GLOBAL",
  "APP_SSE_MAX_STREAMS_PER_IDENTITY",
  "APP_SSE_HEARTBEAT_MS",
  "APP_SSE_MAX_LIFETIME_MS"
];

const TOKENS = {
  alice: "sse_alice_test_token",
  bob: "sse_bob_test_token",
  carol: "sse_carol_test_token"
};

let previousEnv;
let tmpDir;
let app;
let server;

beforeEach(async () => {
  previousEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.WEB_STORE_DRIVER = "json";
  process.env.APP_IDENTITY_PROVIDER = "configured";
  process.env.APP_API_TOKENS_JSON = JSON.stringify({
    [TOKENS.alice]: { user_id: "alice", workspace_id: "workspace_alice", role: "user" },
    [TOKENS.bob]: { user_id: "bob", workspace_id: "workspace_bob", role: "user" },
    [TOKENS.carol]: { user_id: "carol", workspace_id: "workspace_carol", role: "user" }
  });
  for (const key of [
    "APP_API_TOKENS",
    "APP_BASIC_AUTH_USER",
    "APP_BASIC_AUTH_PASSWORD",
    "APP_BASIC_AUTH_PASSWORD_FILE"
  ]) delete process.env[key];
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "virenis-sse-lifecycle-"));
});

afterEach(async () => {
  app?.locals?.closeEventStreams?.({ reason: "test_cleanup" });
  if (server) {
    server.closeAllConnections?.();
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
  await app?.locals?.store?.close?.();
  await fs.rm(tmpDir, { recursive: true, force: true });
  for (const [key, value] of Object.entries(previousEnv || {})) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  app = null;
  server = null;
});

describe("run event-stream lifecycle", () => {
  it("replays a terminal run and ends without registering a live listener", async () => {
    await startApp();
    await seedRun({
      runId: "run_terminal_replay",
      status: "completed",
      events: [
        { type: "run.started" },
        { type: "final.completed", message_id: "msg_terminal_replay" }
      ]
    });

    const response = await streamRun("run_terminal_replay", TOKENS.alice);
    const body = await responseText(response);

    expect(response.status).toBe(200);
    expect(body).toContain("run.started");
    expect(body).toContain("final.completed");
    expect(app.locals.eventStreams.size).toBe(0);
    expect(app.locals.bus.listenerCount("run_terminal_replay")).toBe(0);
  });

  it("delivers a live terminal event before EOF and releases every stream resource", async () => {
    await startApp();
    await seedRun({ runId: "run_live_terminal" });

    const response = await streamRun("run_live_terminal", TOKENS.alice);
    expect(app.locals.eventStreams.size).toBe(1);
    expect(app.locals.bus.listenerCount("run_live_terminal")).toBe(1);

    expect(() => app.locals.bus.publish("run_live_terminal", {
      type: "final.completed",
      message_id: "msg_live_terminal"
    })).not.toThrow();
    const body = await responseText(response);

    expect(body).toContain("final.completed");
    expect(body).toContain("msg_live_terminal");
    expect(app.locals.eventStreams.size).toBe(0);
    expect(app.locals.bus.listenerCount("run_live_terminal")).toBe(0);
  });

  it("recovers a terminal transition that lands in the pre-subscription gap", async () => {
    await startApp();
    const runId = "run_terminal_subscription_gap";
    await seedRun({ runId });
    const originalSubscribe = app.locals.bus.subscribe.bind(app.locals.bus);
    app.locals.bus.subscribe = (subscribedRunId, listener) => {
      if (subscribedRunId === runId) {
        const terminal = {
          type: "final.completed",
          message_id: "msg_subscription_gap",
          at: new Date().toISOString()
        };
        const run = app.locals.store.data.runs.find((item) => item.run_id === runId);
        run.status = "completed";
        run.completed_at = terminal.at;
        run.events.push(terminal);
        // This publication intentionally precedes actual listener registration.
        // The old replay-then-subscribe flow lost it and left the response open.
        app.locals.bus.publish(runId, terminal);
      }
      return originalSubscribe(subscribedRunId, listener);
    };

    const response = await streamRun(runId, TOKENS.alice);
    const body = await responseText(response);

    expect(sseDataEvents(body).map((event) => event.type)).toEqual([
      "run.started",
      "final.completed"
    ]);
    expect(body).toContain("msg_subscription_gap");
    expect(app.locals.eventStreams.size).toBe(0);
    expect(app.locals.bus.listenerCount(runId)).toBe(0);
  });

  it("deduplicates ordered persisted events published while the replay listener attaches", async () => {
    await startApp();
    const runId = "run_terminal_replay_buffer";
    await seedRun({ runId });
    const originalSubscribe = app.locals.bus.subscribe.bind(app.locals.bus);
    app.locals.bus.subscribe = (subscribedRunId, listener) => {
      const unsubscribe = originalSubscribe(subscribedRunId, listener);
      if (subscribedRunId === runId) {
        const completedAt = new Date().toISOString();
        const route = {
          type: "route.completed",
          step_id: "s1",
          adapter: "research_agent",
          at: completedAt
        };
        const terminal = {
          type: "final.completed",
          message_id: "msg_replay_buffer",
          at: completedAt
        };
        const run = app.locals.store.data.runs.find((item) => item.run_id === runId);
        run.status = "completed";
        run.completed_at = completedAt;
        run.events.push(route, terminal);
        app.locals.bus.publish(runId, route);
        app.locals.bus.publish(runId, terminal);
      }
      return unsubscribe;
    };

    const response = await streamRun(runId, TOKENS.alice);
    const body = await responseText(response);
    const events = sseDataEvents(body);

    expect(events.map((event) => event.type)).toEqual([
      "run.started",
      "route.completed",
      "final.completed"
    ]);
    expect(events.filter((event) => event.type === "route.completed")).toHaveLength(1);
    expect(events.filter((event) => event.type === "final.completed")).toHaveLength(1);
    expect(app.locals.eventStreams.size).toBe(0);
    expect(app.locals.bus.listenerCount(runId)).toBe(0);
  });

  it("enforces per-identity and global stream caps, then releases capacity", async () => {
    await startApp({ maxGlobal: 2, maxPerIdentity: 1 });
    await Promise.all([
      seedRun({ runId: "run_alice_one" }),
      seedRun({ runId: "run_alice_two" }),
      seedRun({ runId: "run_bob_one", userId: "bob", workspaceId: "workspace_bob" }),
      seedRun({ runId: "run_carol_one", userId: "carol", workspaceId: "workspace_carol" })
    ]);

    const alice = await streamRun("run_alice_one", TOKENS.alice);
    const aliceOverflow = await streamRun("run_alice_two", TOKENS.alice);
    expect(aliceOverflow.status).toBe(429);
    expect(aliceOverflow.headers.get("retry-after")).toBe("1");
    await expect(aliceOverflow.json()).resolves.toMatchObject({ error: "event_stream_limit" });

    const bob = await streamRun("run_bob_one", TOKENS.bob);
    const globalOverflow = await streamRun("run_carol_one", TOKENS.carol);
    expect(globalOverflow.status).toBe(429);
    await expect(globalOverflow.json()).resolves.toMatchObject({ error: "event_stream_limit" });
    expect(app.locals.eventStreams.size).toBe(2);

    app.locals.bus.publish("run_alice_one", { type: "final.completed", message_id: "msg_alice" });
    await responseText(alice);
    expect(app.locals.eventStreams.size).toBe(1);

    const carol = await streamRun("run_carol_one", TOKENS.carol);
    expect(carol.status).toBe(200);
    expect(app.locals.eventStreams.size).toBe(2);

    app.locals.bus.publish("run_bob_one", { type: "run.failed", code: "test_failure" });
    app.locals.bus.publish("run_carol_one", { type: "final.completed", message_id: "msg_carol" });
    await Promise.all([responseText(bob), responseText(carol)]);
    expect(app.locals.eventStreams.size).toBe(0);
    expect(app.locals.bus.listenerCount("run_bob_one")).toBe(0);
    expect(app.locals.bus.listenerCount("run_carol_one")).toBe(0);
  });

  it("emits heartbeat comments and closes an idle stream at its maximum lifetime", async () => {
    await startApp({ heartbeatMs: 10, maxLifetimeMs: 60 });
    await seedRun({ runId: "run_idle_lifetime" });

    const response = await streamRun("run_idle_lifetime", TOKENS.alice);
    const body = await responseText(response);

    expect(body).toContain(": heartbeat ");
    expect(body).toContain("event: stream.closed");
    expect(body).toContain("max_lifetime");
    expect(app.locals.eventStreams.size).toBe(0);
    expect(app.locals.bus.listenerCount("run_idle_lifetime")).toBe(0);
  });

  it("closes and unregisters a slow stream without letting backpressure escape the bus", async () => {
    await startApp();
    await seedRun({ runId: "run_backpressure" });

    const response = await streamRun("run_backpressure", TOKENS.alice);
    const [registered] = [...app.locals.eventStreams];
    expect(registered).toBeTruthy();
    registered.res.write = () => false;

    expect(() => app.locals.bus.publish("run_backpressure", {
      type: "route.completed",
      step_id: "s1"
    })).not.toThrow();
    await responseText(response);

    expect(app.locals.eventStreams.size).toBe(0);
    expect(app.locals.bus.listenerCount("run_backpressure")).toBe(0);
  });
});

async function startApp({
  maxGlobal = 500,
  maxPerIdentity = 8,
  heartbeatMs = 15_000,
  maxLifetimeMs = 16 * 60 * 1000
} = {}) {
  process.env.APP_SSE_MAX_STREAMS_GLOBAL = String(maxGlobal);
  process.env.APP_SSE_MAX_STREAMS_PER_IDENTITY = String(maxPerIdentity);
  process.env.APP_SSE_HEARTBEAT_MS = String(heartbeatMs);
  process.env.APP_SSE_MAX_LIFETIME_MS = String(maxLifetimeMs);
  app = await createApp({
    dbPath: path.join(tmpDir, "db.json"),
    uploadRoot: path.join(tmpDir, "uploads"),
    autoRun: false
  });
  server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
}

async function seedRun({
  runId,
  userId = "alice",
  workspaceId = "workspace_alice",
  status = "running",
  events = [{ type: "run.started" }]
}) {
  const now = new Date().toISOString();
  await app.locals.store.mutate((data) => {
    const sessionId = `session_${runId}`;
    data.sessions.push({
      session_id: sessionId,
      title: `SSE ${runId}`,
      workspace_id: workspaceId,
      visibility: "private",
      created_by: userId,
      created_at: now,
      updated_at: now,
      last_message_at: now,
      shared_memory: []
    });
    data.runs.push({
      run_id: runId,
      session_id: sessionId,
      workspace_id: workspaceId,
      created_by: userId,
      status,
      events: events.map((event) => ({ ...event, at: event.at || now }))
    });
  });
}

function streamRun(runId, token) {
  return fetch(`${baseUrl()}/api/chat/runs/${encodeURIComponent(runId)}/events`, {
    headers: { Authorization: `Bearer ${token}` }
  });
}

function baseUrl() {
  return `http://127.0.0.1:${server.address().port}`;
}

async function responseText(response, timeoutMs = 1_500) {
  let timer;
  try {
    return await Promise.race([
      response.text(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Timed out waiting for event-stream EOF.")), timeoutMs);
        timer.unref?.();
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function sseDataEvents(body) {
  return String(body || "")
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice("data: ".length)));
}

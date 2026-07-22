import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../server/app.js";

let app;
let tmpDir;
let previousStoreDriver;

beforeEach(async () => {
  previousStoreDriver = process.env.WEB_STORE_DRIVER;
  process.env.WEB_STORE_DRIVER = "json";
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "virenis-session-admission-"));
  app = await createApp({
    dbPath: path.join(tmpDir, "db.json"),
    uploadRoot: tmpDir,
    autoRun: false
  });
});

afterEach(async () => {
  await app?.locals?.store?.close?.();
  if (previousStoreDriver === undefined) {
    delete process.env.WEB_STORE_DRIVER;
  } else {
    process.env.WEB_STORE_DRIVER = previousStoreDriver;
  }
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function createSession() {
  const response = await request(app)
    .post("/api/chat/sessions")
    .send({ title: "Concurrent turn admission" })
    .expect(201);
  return response.body;
}

describe("same-session run admission", () => {
  it("atomically rejects one of two concurrent distinct submissions", async () => {
    const session = await createSession();
    const messagePath = `/api/chat/sessions/${session.session_id}/messages`;
    const submissions = [
      request(app)
        .post(messagePath)
        .set("Idempotency-Key", "concurrent-turn-left-0001")
        .send({ content: "Draft a realistic customer renewal brief." }),
      request(app)
        .post(messagePath)
        .set("Idempotency-Key", "concurrent-turn-right-0001")
        .send({ content: "Analyze a separate supplier delivery risk." })
    ];

    const responses = await Promise.all(submissions);
    const accepted = responses.filter((response) => response.status === 202);
    const rejected = responses.filter((response) => response.status === 409);

    expect(accepted).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].body).toMatchObject({
      error: "session_run_in_progress",
      message: "This chat already has an answer in progress. Wait for it to finish before sending another message."
    });

    const stored = app.locals.store.read();
    expect(stored.runs).toHaveLength(1);
    expect(stored.runs[0]).toMatchObject({
      run_id: accepted[0].body.run_id,
      session_id: session.session_id,
      status: "queued"
    });
    expect(stored.messages.filter((message) => message.session_id === session.session_id)).toHaveLength(1);
  });

  it("replays the exact submission key while its run is still active", async () => {
    const session = await createSession();
    const messagePath = `/api/chat/sessions/${session.session_id}/messages`;
    const idempotencyKey = "active-turn-retry-0001";
    const body = {
      content: "Prepare an incident follow-up with owners and deadlines.",
      options: { parallel_workers: 2 }
    };

    const accepted = await request(app)
      .post(messagePath)
      .set("Idempotency-Key", idempotencyKey)
      .send(body)
      .expect(202);
    const replay = await request(app)
      .post(messagePath)
      .set("Idempotency-Key", idempotencyKey)
      .send(body)
      .expect(202);

    expect(accepted.body).toMatchObject({ status: "queued", duplicate: false });
    expect(replay.body).toMatchObject({
      run_id: accepted.body.run_id,
      message_id: accepted.body.message_id,
      status: "queued",
      duplicate: true
    });

    const stored = app.locals.store.read();
    expect(stored.runs).toHaveLength(1);
    expect(stored.messages.filter((message) => message.session_id === session.session_id)).toHaveLength(1);
  });
});

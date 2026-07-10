import http from "node:http";
import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";

import { fetchRuntimeAgents, requireRuntimeConfigured, runtimeRequest } from "../server/runtimeClient.js";

const ENVIRONMENT_KEYS = [
  "TCAR_RUNTIME_API_URL",
  "TCAR_RUNTIME_API_KEY",
  "TCAR_ENGINE_MODE",
  "TCAR_RUNTIME_HEALTH_TIMEOUT_MS",
  "TCAR_RUNTIME_AGENT_LIST_TIMEOUT_MS",
  "TCAR_RUNTIME_CONNECT_TIMEOUT_MS",
  "TCAR_RUNTIME_HEADER_TIMEOUT_MS",
  "TCAR_RUNTIME_BODY_IDLE_TIMEOUT_MS",
  "TCAR_RUNTIME_MAX_RESPONSE_BYTES"
];
const originalEnvironment = Object.fromEntries(
  ENVIRONMENT_KEYS.map((key) => [key, process.env[key]])
);
const cleanups = [];

afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("TCAR runtime HTTP transport", () => {
  it("honors the configured response-header budget for a 900000ms chat request", async () => {
    const runtime = await startHttpServer(async (request, response) => {
      const body = await readRequest(request);
      await delay(70);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: true, body, api_key: request.headers["x-tcar-api-key"] }));
    });
    configureRuntime(runtime.url, {
      TCAR_RUNTIME_API_KEY: "runtime-test-key",
      TCAR_RUNTIME_CONNECT_TIMEOUT_MS: "100",
      TCAR_RUNTIME_HEADER_TIMEOUT_MS: "200",
      TCAR_RUNTIME_BODY_IDLE_TIMEOUT_MS: "100"
    });

    const result = await runtimeRequest("/chat/execute", {
      method: "POST",
      body: { query: "delayed headers" },
      timeoutMs: 900000
    });

    expect(result).toEqual({
      ok: true,
      body: { query: "delayed headers" },
      api_key: "runtime-test-key"
    });
  });

  it("gives provenance-heavy Runtime agent listings a distinct bounded timeout", async () => {
    const runtime = await startHttpServer(async (_request, response) => {
      await delay(40);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: true, agents: [] }));
    });
    configureRuntime(runtime.url, {
      TCAR_RUNTIME_HEALTH_TIMEOUT_MS: "10",
      TCAR_RUNTIME_AGENT_LIST_TIMEOUT_MS: "100",
      TCAR_RUNTIME_CONNECT_TIMEOUT_MS: "100",
      TCAR_RUNTIME_HEADER_TIMEOUT_MS: "100"
    });

    await expect(fetchRuntimeAgents()).resolves.toEqual({ ok: true, agents: [] });
  });

  it("aborts a response that exceeds the configured header timeout", async () => {
    const runtime = await startHttpServer(async (_request, response) => {
      await delay(100);
      if (!response.destroyed) response.end("{}");
    });
    configureRuntime(runtime.url, {
      TCAR_RUNTIME_CONNECT_TIMEOUT_MS: "100",
      TCAR_RUNTIME_HEADER_TIMEOUT_MS: "30"
    });

    await expect(runtimeRequest("/slow-headers", { timeoutMs: 500 })).rejects.toMatchObject({
      status: 504,
      message: "TCAR runtime request timed out after 30ms."
    });
    await waitForSocketsToClose(runtime.sockets);
  });

  it("bounds DNS/TCP/TLS connection establishment separately", async () => {
    const runtime = await startTcpServer((socket) => socket.resume());
    configureRuntime(`https://127.0.0.1:${runtime.port}`, {
      TCAR_RUNTIME_CONNECT_TIMEOUT_MS: "30",
      TCAR_RUNTIME_HEADER_TIMEOUT_MS: "400"
    });

    await expect(runtimeRequest("/tls-never-ready", { timeoutMs: 500 })).rejects.toMatchObject({
      status: 504,
      message: "TCAR runtime request timed out after 30ms."
    });
    await waitForSocketsToClose(runtime.sockets);
  });

  it("aborts a response body that stops making progress", async () => {
    const runtime = await startHttpServer(async (_request, response) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.write('{"ok":');
      await delay(100);
      if (!response.destroyed) response.end("true}");
    });
    configureRuntime(runtime.url, {
      TCAR_RUNTIME_CONNECT_TIMEOUT_MS: "100",
      TCAR_RUNTIME_HEADER_TIMEOUT_MS: "200",
      TCAR_RUNTIME_BODY_IDLE_TIMEOUT_MS: "30"
    });

    await expect(runtimeRequest("/stalled-body", { timeoutMs: 500 })).rejects.toMatchObject({
      status: 504,
      message: "TCAR runtime request timed out after 30ms."
    });
    await waitForSocketsToClose(runtime.sockets);
  });

  it("enforces the overall deadline even while the body keeps making progress", async () => {
    const runtime = await startHttpServer(async (_request, response) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      for (let index = 0; index < 10 && !response.destroyed; index += 1) {
        response.write(index === 0 ? '{"chunks":[' : `"${index}",`);
        await delay(20);
      }
      if (!response.destroyed) response.end("null]}");
    });
    configureRuntime(runtime.url, {
      TCAR_RUNTIME_CONNECT_TIMEOUT_MS: "50",
      TCAR_RUNTIME_HEADER_TIMEOUT_MS: "50",
      TCAR_RUNTIME_BODY_IDLE_TIMEOUT_MS: "50"
    });

    await expect(runtimeRequest("/overall-timeout", { timeoutMs: 75 })).rejects.toMatchObject({
      status: 504,
      message: "TCAR runtime request timed out after 75ms."
    });
    await waitForSocketsToClose(runtime.sockets);
  });

  it("rejects oversized runtime responses and closes the socket", async () => {
    const runtime = await startHttpServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ payload: "x".repeat(2048) }));
    });
    configureRuntime(runtime.url, {
      TCAR_RUNTIME_MAX_RESPONSE_BYTES: "1024"
    });

    await expect(runtimeRequest("/oversized", { timeoutMs: 500 })).rejects.toMatchObject({
      status: 502,
      message: "TCAR runtime response exceeded the configured size limit."
    });
    await waitForSocketsToClose(runtime.sockets);
  });

  it("preserves structured runtime HTTP errors", async () => {
    const runtime = await startHttpServer((_request, response) => {
      response.writeHead(409, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ detail: "execution already claimed", private_field: "retained-for-admin-redaction" }));
    });
    configureRuntime(runtime.url);

    await expect(runtimeRequest("/conflict", { timeoutMs: 500 })).rejects.toMatchObject({
      status: 409,
      message: "execution already claimed",
      payload: {
        detail: "execution already claimed",
        private_field: "retained-for-admin-redaction"
      }
    });
  });

  it("rejects invalid transport bounds before opening a socket", async () => {
    process.env.TCAR_RUNTIME_API_URL = "http://127.0.0.1:1";
    process.env.TCAR_RUNTIME_CONNECT_TIMEOUT_MS = "0";

    await expect(runtimeRequest("/invalid", { timeoutMs: 500 })).rejects.toThrow(
      /TCAR_RUNTIME_CONNECT_TIMEOUT_MS must be an integer/
    );
  });

  it("rejects invalid transport bounds during real-runtime startup validation", () => {
    process.env.TCAR_ENGINE_MODE = "real";
    process.env.TCAR_RUNTIME_API_URL = "http://127.0.0.1:9000";
    process.env.TCAR_RUNTIME_CONNECT_TIMEOUT_MS = "0";

    expect(() => requireRuntimeConfigured()).toThrow(/TCAR_RUNTIME_CONNECT_TIMEOUT_MS must be an integer/);
  });
});

function configureRuntime(url, values = {}) {
  process.env.TCAR_RUNTIME_API_URL = url;
  delete process.env.TCAR_RUNTIME_API_KEY;
  delete process.env.TCAR_RUNTIME_HEALTH_TIMEOUT_MS;
  delete process.env.TCAR_RUNTIME_AGENT_LIST_TIMEOUT_MS;
  delete process.env.TCAR_RUNTIME_CONNECT_TIMEOUT_MS;
  delete process.env.TCAR_RUNTIME_HEADER_TIMEOUT_MS;
  delete process.env.TCAR_RUNTIME_BODY_IDLE_TIMEOUT_MS;
  delete process.env.TCAR_RUNTIME_MAX_RESPONSE_BYTES;
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
}

async function startHttpServer(handler) {
  const sockets = new Set();
  const server = http.createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch(() => {
      if (!response.destroyed) response.destroy();
    });
  });
  trackSockets(server, sockets);
  const port = await listen(server);
  cleanups.push(() => closeServer(server, sockets));
  return { server, sockets, port, url: `http://127.0.0.1:${port}` };
}

async function startTcpServer(connectionHandler) {
  const sockets = new Set();
  const server = net.createServer((socket) => connectionHandler(socket));
  trackSockets(server, sockets);
  const port = await listen(server);
  cleanups.push(() => closeServer(server, sockets));
  return { server, sockets, port };
}

function trackSockets(server, sockets) {
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server.address().port);
    });
  });
}

async function closeServer(server, sockets) {
  for (const socket of sockets) socket.destroy();
  if (!server.listening) return;
  await new Promise((resolve) => server.close(resolve));
}

async function waitForSocketsToClose(sockets) {
  for (let attempt = 0; attempt < 100 && sockets.size; attempt += 1) await delay(5);
  expect(sockets.size).toBe(0);
}

async function readRequest(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : null;
}

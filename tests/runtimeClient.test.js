import crypto from "node:crypto";
import http from "node:http";
import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";

import {
  composeRuntimeWorkflow,
  continueRuntimeConversation,
  deleteArchivedRuntimeAgent,
  fetchRuntimeAgents,
  registerRuntimeAgent,
  requireRuntimeConfigured,
  runtimeRequest,
  updateRuntimeAgent
} from "../server/runtimeClient.js";

const ENVIRONMENT_KEYS = [
  "TCAR_RUNTIME_API_URL",
  "TCAR_RUNTIME_API_KEY",
  "TCAR_ENGINE_MODE",
  "TCAR_RUNTIME_HEALTH_TIMEOUT_MS",
  "TCAR_RUNTIME_AGENT_LIST_TIMEOUT_MS",
  "TCAR_RUNTIME_CONNECT_TIMEOUT_MS",
  "TCAR_RUNTIME_HEADER_TIMEOUT_MS",
  "TCAR_RUNTIME_BODY_IDLE_TIMEOUT_MS",
  "TCAR_RUNTIME_MAX_RESPONSE_BYTES",
  "TCAR_RUNTIME_WORKFLOW_TIMEOUT_MS",
  "TCAR_RUNTIME_CONTINUATION_TIMEOUT_MS"
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
  it("uses dedicated runtime contracts for workflow composition and tool continuation", async () => {
    const observed = [];
    const runtime = await startHttpServer(async (incoming, response) => {
      observed.push({ path: incoming.url, body: await readRequest(incoming) });
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(incoming.url === "/workflow/compose"
        ? { title: "Composed", nodes: [] }
        : { content: "Continued safely." }));
    });
    configureRuntime(runtime.url, {
      TCAR_RUNTIME_WORKFLOW_TIMEOUT_MS: "2000",
      TCAR_RUNTIME_CONTINUATION_TIMEOUT_MS: "2000"
    });
    const executionContext = {
      run_id: "run_contract",
      session_id: "session_contract",
      workspace_id: "workspace_contract",
      user_id: "alice"
    };
    const compositionDependencies = [{
      request_id: "source_gmail_1",
      provider_id: "gmail",
      connection_id: "mcp_gmail",
      read_only: true,
      required_before_agent_design: true
    }];
    const observationContent = "{\"categories\":[\"returns\"]}";
    const sourceObservations = [{
      request_id: "source_gmail_1",
      provider_id: "gmail",
      trust: "external_untrusted_data",
      content: observationContent,
      content_digest: crypto.createHash("sha256").update(observationContent).digest("hex")
    }];
    await expect(composeRuntimeWorkflow({
      command: "workflow",
      mode: "workflow",
      intent: "Prepare a support draft.",
      candidates: [{ candidate_id: "workspace:support" }],
      connections: [],
      conversation_context: [{ tag: "context", content: "Keep it concise." }],
      composition_dependencies: compositionDependencies,
      source_observations: sourceObservations,
      execution_context: executionContext
    })).resolves.toEqual({ title: "Composed", nodes: [] });
    await expect(continueRuntimeConversation({
      original_request: "Create a note.",
      prior_answer: "Waiting for approval.",
      decision: "approve",
      tool_name: "Create note",
      tool_result: { ok: true },
      conversation_context: [],
      execution_context: executionContext
    })).resolves.toEqual({ content: "Continued safely." });
    expect(observed).toEqual([
      {
        path: "/workflow/compose",
        body: {
          command: "workflow",
          mode: "workflow",
          intent: "Prepare a support draft.",
          candidates: [{ candidate_id: "workspace:support" }],
          connections: [],
          conversation_context: [{ tag: "context", content: "Keep it concise." }],
          composition_dependencies: compositionDependencies,
          source_observations: sourceObservations,
          execution_context: executionContext
        }
      },
      {
        path: "/chat/continue",
        body: {
          original_request: "Create a note.",
          prior_answer: "Waiting for approval.",
          decision: "approve",
          tool_name: "Create note",
          tool_result: { ok: true },
          conversation_context: [],
          execution_context: executionContext
        }
      }
    ]);
  });

  it("sends MCP prompt contracts to Runtime without sending workspace bindings", async () => {
    let observed = null;
    const runtime = await startHttpServer(async (request, response) => {
      observed = await readRequest(request);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
    });
    configureRuntime(runtime.url);
    const alias = "mcp_12345678_search_notes_abcdef";
    await registerRuntimeAgent({
      id: "mcp_contract_agent",
      title: "MCP contract agent",
      capability: "Search notes.",
      boundary: "Use assigned tools.",
      tools: [alias],
      tool_contracts: {
        [alias]: {
          description: "Search current notes.",
          input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] }
        }
      },
      mcp_bindings: [{ connection_id: "must_not_cross_runtime_boundary" }]
    });
    expect(observed).toMatchObject({
      id: "mcp_contract_agent",
      tools: [alias],
      tool_contracts: {
        [alias]: expect.objectContaining({ description: "Search current notes." })
      }
    });
    expect(observed).not.toHaveProperty("mcp_bindings");
  });

  it("uses the explicit archived-agent deletion contract", async () => {
    let observed = null;
    const runtime = await startHttpServer(async (request, response) => {
      observed = {
        method: request.method,
        path: request.url,
        body: await readRequest(request)
      };
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: true, status: "purged", purged: true }));
    });
    configureRuntime(runtime.url);

    await expect(deleteArchivedRuntimeAgent("archived_agent", {
      user_id: "alice",
      workspace_id: "workspace_a",
      role: "user"
    })).resolves.toMatchObject({ ok: true, status: "purged", purged: true });
    expect(observed).toEqual({
      method: "DELETE",
      path: "/agents/archived_agent",
      body: {
        audit_context: {
          user_id: "alice",
          workspace_id: "workspace_a",
          role: "user"
        },
        delete_archived: true
      }
    });
  });

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

  it("reuses a bounded keep-alive connection across runtime calls", async () => {
    const peerPorts = new Set();
    const runtime = await startHttpServer((request, response) => {
      peerPorts.add(request.socket.remotePort);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
    });
    configureRuntime(runtime.url);

    await expect(runtimeRequest("/first", { timeoutMs: 500 })).resolves.toEqual({ ok: true });
    await expect(runtimeRequest("/second", { timeoutMs: 500 })).resolves.toEqual({ ok: true });

    expect(peerPorts.size).toBe(1);
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

  it("normalizes an upstream socket reset into a retryable runtime failure", async () => {
    const runtime = await startHttpServer((request) => {
      request.socket.destroy();
    });
    configureRuntime(runtime.url);

    await expect(runtimeRequest("/reset", { timeoutMs: 500 })).rejects.toMatchObject({
      status: 502,
      code: "runtime_connection_reset",
      retryable: true,
      message: "TCAR runtime connection closed unexpectedly."
    });
    await waitForSocketsToClose(runtime.sockets);
  });

  it("drops untrusted runtime HTTP bodies while preserving safe classification", async () => {
    const runtime = await startHttpServer((_request, response) => {
      response.writeHead(409, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ detail: "execution already claimed", private_field: "retained-for-admin-redaction" }));
    });
    configureRuntime(runtime.url);

    await expect(runtimeRequest("/conflict", { timeoutMs: 500 })).rejects.toMatchObject({
      status: 409,
      code: "runtime_request_rejected",
      message: "The Runtime rejected the request.",
      diagnostic: {
        code: "runtime_request_rejected",
        status: 409,
        retryable: false
      }
    });
  });

  it("preserves safe provider failure metadata for user-facing recovery", async () => {
    const runtime = await startHttpServer((_request, response) => {
      response.writeHead(429, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        detail: {
          code: "model_rate_limited",
          message: "The provider is busy.",
          retryable: true,
          provider_status: 429,
          request_id: "provider_request_123"
        }
      }));
    });
    configureRuntime(runtime.url);

    await expect(runtimeRequest("/rate-limit", { timeoutMs: 500 })).rejects.toMatchObject({
      status: 429,
      code: "model_rate_limited",
      retryable: true,
      providerStatus: 429,
      requestId: "provider_request_123"
    });
  });

  it("sends only fields accepted by the live agent lifecycle contract", async () => {
    const requests = [];
    const runtime = await startHttpServer(async (request, response) => {
      const body = await readRequest(request);
      requests.push({ method: request.method, path: request.url, body });
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        ok: true,
        ...(["POST", "PATCH"].includes(request.method) ? {
          agent: {
            ...body,
            policies: {
              activation_policy: "Runtime-owned activation policy.",
              source_policy: body.policies?.source_policy
            }
          }
        } : {})
      }));
    });
    configureRuntime(runtime.url);

    const registered = await registerRuntimeAgent({
      id: "textile_agent",
      title: "Textile Agent",
      capability: "Analyzes textile operations.",
      boundary: "Labels assumptions.",
      consumes: ["user_request"],
      produces: ["industry_context"],
      routing_cues: ["textile"],
      resources: [],
      tools: ["web_search"],
      sources: [],
      configuration_version: "virenis-workflow-agent-config-v3",
      policies: {
        source_policy: "Use approved current sources.",
        response: { style: "careful", tones: ["professional", "objective", "unsafe-tone"] },
        memory: { mode: "conversation" },
        knowledge: { requirements: ["current_web", "unknown_requirement"] },
        composition: { reusable_role: true, source_content_persisted: true }
      },
      stage: 20,
      registration_id: "registration_contract_test",
      audit_context: { user_id: "alice" },
      item_type: "agent",
      execution: { type: "api", model: "inherit" },
      visibility: "private",
      workspace_id: "workspace_a",
      ready: true
    });
    const updated = await updateRuntimeAgent("textile_agent", {
      title: "Textile Specialist",
      enabled: true,
      policies: {
        source_policy: "Use evidence.",
        response: { style: "thorough", tones: ["clear"] },
        memory: { mode: "none" },
        knowledge: { requirements: ["user_provided_context"] }
      },
      audit_context: { user_id: "alice" },
      item_type: "agent",
      license: "private"
    });

    expect(registered.agent.policies).toEqual({
      source_policy: "Use approved current sources.",
      response: { style: "careful", tones: ["professional", "objective"] },
      memory: { mode: "conversation" },
      knowledge: { requirements: ["current_web"] },
      composition: { reusable_role: true, source_content_persisted: false }
    });
    expect(updated.agent.policies).toEqual({
      source_policy: "Use evidence.",
      response: { style: "thorough", tones: ["clear"] },
      memory: { mode: "none" },
      knowledge: { requirements: ["user_provided_context"] },
      composition: { reusable_role: true, source_content_persisted: false }
    });

    expect(requests).toEqual([
      {
        method: "POST",
        path: "/agents",
        body: {
          id: "textile_agent",
          title: "Textile Agent",
          capability: "Analyzes textile operations.",
          boundary: "Labels assumptions.",
          consumes: ["user_request"],
          produces: ["industry_context"],
          routing_cues: ["textile"],
          resources: [],
          tools: ["web_search"],
          sources: [],
          policies: { source_policy: "Use approved current sources." },
          workflow_profile: {
            configuration_version: "virenis-workflow-agent-config-v3",
            response: { style: "careful", tones: ["professional", "objective"] },
            memory: { mode: "conversation" },
            knowledge: { requirements: ["current_web"], resources: [] },
            composition: { reusable_role: true, source_content_persisted: false }
          },
          stage: 20,
          ready: true,
          registration_id: "registration_contract_test",
          audit_context: { user_id: "alice" }
        }
      },
      {
        method: "PATCH",
        path: "/agents/textile_agent",
        body: {
          title: "Textile Specialist",
          policies: { source_policy: "Use evidence." },
          workflow_profile: {
            configuration_version: "virenis-workflow-agent-config-v3",
            response: { style: "thorough", tones: ["clear"] },
            memory: { mode: "none" },
            knowledge: { requirements: ["user_provided_context"], resources: [] },
            composition: { reusable_role: true, source_content_persisted: false }
          },
          enabled: true,
          audit_context: { user_id: "alice" }
        }
      }
    ]);
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

  it("validates workflow and continuation Runtime budgets at startup", () => {
    process.env.TCAR_ENGINE_MODE = "real";
    process.env.TCAR_RUNTIME_API_URL = "http://127.0.0.1:9000";
    process.env.TCAR_RUNTIME_WORKFLOW_TIMEOUT_MS = "0";
    expect(() => requireRuntimeConfigured()).toThrow(/TCAR_RUNTIME_WORKFLOW_TIMEOUT_MS must be an integer/);
    delete process.env.TCAR_RUNTIME_WORKFLOW_TIMEOUT_MS;
    process.env.TCAR_RUNTIME_CONTINUATION_TIMEOUT_MS = "1800001";
    expect(() => requireRuntimeConfigured()).toThrow(/TCAR_RUNTIME_CONTINUATION_TIMEOUT_MS must be an integer/);
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

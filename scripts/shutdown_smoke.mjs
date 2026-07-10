#!/usr/bin/env node
/* global console, fetch, process, setTimeout, URL */
import { spawn } from "node:child_process";

function request(url, options = {}) {
  return fetch(url, options);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function jsonRequest(url, options = {}) {
  const response = await request(url, options);
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(`${options.method || "GET"} ${url} returned ${response.status}: ${JSON.stringify(payload).slice(0, 500)}`);
  }
  return payload;
}

function waitForExit(child) {
  return new Promise((resolve) => {
    child.once("exit", (code, signal) => {
      resolve({ code, signal });
    });
  });
}

async function waitForHealth(baseUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await request(`${baseUrl}/healthz`);
      if (response.ok) {
        return;
      }
    } catch {
      // Server is not ready yet.
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${baseUrl}/healthz`);
}

async function verifyProductionStaticResponses(baseUrl, token) {
  const headers = { Authorization: `Bearer ${token}` };
  const indexResponse = await request(`${baseUrl}/`, { headers });
  const indexHtml = await indexResponse.text();
  if (!indexResponse.ok) {
    throw new Error(`GET / returned ${indexResponse.status}`);
  }
  const indexCache = indexResponse.headers.get("cache-control") || "";
  if (!indexCache.includes("no-cache")) {
    throw new Error(`GET / did not return no-cache Cache-Control: ${indexCache}`);
  }
  const assetMatch = indexHtml.match(/\/assets\/[^"'<>]+\.(?:js|css)/);
  if (!assetMatch) {
    throw new Error("production index.html did not reference a hashed asset");
  }
  const assetResponse = await request(`${baseUrl}${assetMatch[0]}`, { headers });
  if (!assetResponse.ok) {
    throw new Error(`GET ${assetMatch[0]} returned ${assetResponse.status}`);
  }
  const assetCache = assetResponse.headers.get("cache-control") || "";
  if (!assetCache.includes("max-age=31536000") || !assetCache.includes("immutable")) {
    throw new Error(`asset did not return immutable Cache-Control: ${assetCache}`);
  }
  const missingAsset = await request(`${baseUrl}/assets/missing-smoke.js`, { headers });
  if (missingAsset.status !== 404) {
    throw new Error(`missing asset returned ${missingAsset.status}, expected 404`);
  }
  const missingBody = await missingAsset.text();
  if (missingBody.includes("<!doctype html>") || missingBody.includes("<div id=\"root\"")) {
    throw new Error("missing asset returned the SPA shell instead of a 404");
  }
  return { asset: assetMatch[0], asset_cache: assetCache, index_cache: indexCache };
}

async function openRunEventStream(baseUrl, token) {
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json"
  };
  const session = await jsonRequest(`${baseUrl}/api/chat/sessions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ title: "Shutdown smoke SSE" })
  });
  const queued = await jsonRequest(`${baseUrl}/api/chat/sessions/${session.session_id}/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      content: "Plan a release-readiness support checklist.",
      options: { parallel_workers: 2, max_routing_adapters: 4 }
    })
  });
  const response = await request(`${baseUrl}/api/chat/runs/${queued.run_id}/events`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!response.ok || !response.body) {
    throw new Error(`SSE stream failed with status ${response.status}`);
  }
  const reader = response.body.getReader();
  const firstChunk = await Promise.race([
    reader.read(),
    sleep(3000).then(() => ({ timeout: true }))
  ]);
  if (firstChunk.timeout) {
    throw new Error("SSE stream opened but did not produce an initial event.");
  }
  return { reader, runId: queued.run_id };
}

const port = Number(process.env.SHUTDOWN_SMOKE_PORT || 5187);
const baseUrl = `http://127.0.0.1:${port}`;
const smokeToken = "shutdownsmoketoken0123456789";
const child = spawn(process.execPath, ["server/index.js"], {
  cwd: new URL("..", import.meta.url),
  env: {
    ...process.env,
    NODE_ENV: "production",
    HOST: "127.0.0.1",
    PORT: String(port),
    WEB_STORE_DRIVER: "json",
    APP_ALLOW_JSON_STORE: "1",
    TCAR_ENGINE_MODE: "simulator",
    APP_API_TOKENS_JSON: JSON.stringify({
      [smokeToken]: {
        user_id: "shutdown_smoke",
        workspace_id: "workspace_shutdown_smoke",
        role: "admin"
      }
    }),
    APP_PUBLIC_ORIGIN: "https://shutdown-smoke.prod.test",
    APP_ENABLE_HSTS: "0",
    APP_BACKGROUND_DRAIN_TIMEOUT_MS: "4000",
    APP_SHUTDOWN_TIMEOUT_MS: "5000"
  },
  stdio: ["ignore", "pipe", "pipe"]
});

let stdout = "";
let stderr = "";
let sse;
child.stdout.on("data", (chunk) => {
  stdout += chunk.toString();
});
child.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
});

try {
  await waitForHealth(baseUrl, 15000);
  const staticCheck = await verifyProductionStaticResponses(baseUrl, smokeToken);
  sse = await openRunEventStream(baseUrl, smokeToken);
  child.kill("SIGTERM");
  const result = await Promise.race([
    waitForExit(child),
    sleep(10000).then(() => ({ timeout: true }))
  ]);
  if (result.timeout) {
    child.kill("SIGKILL");
    throw new Error("server did not exit after SIGTERM");
  }
  if (result.code !== 0) {
    throw new Error(`server exited with code=${result.code} signal=${result.signal}`);
  }
  try {
    await request(`${baseUrl}/healthz`);
    throw new Error("server still accepted requests after shutdown");
  } catch (error) {
    if (error.message === "server still accepted requests after shutdown") {
      throw error;
    }
  }
  await sse.reader.cancel().catch(() => {});
  console.log(JSON.stringify({ ok: true, port, sse_run_id: sse.runId, static: staticCheck, stdout: stdout.slice(-500), stderr: stderr.slice(-500) }, null, 2));
} catch (error) {
  await sse?.reader?.cancel?.().catch(() => {});
  child.kill("SIGKILL");
  console.error(JSON.stringify({ ok: false, error: error.message, stdout: stdout.slice(-2000), stderr: stderr.slice(-2000) }, null, 2));
  process.exit(1);
}

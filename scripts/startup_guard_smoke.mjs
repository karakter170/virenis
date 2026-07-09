#!/usr/bin/env node
/* global console, process, setTimeout, URL */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

function waitForExit(child) {
  return new Promise((resolve) => {
    child.once("exit", (code, signal) => {
      resolve({ code, signal });
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tcar-startup-guard-"));
const missingDist = path.join(tmpDir, "missing-dist");
const smokeToken = "startupguardsmoketoken0123456789";
const child = spawn(process.execPath, ["server/index.js"], {
  cwd: new URL("..", import.meta.url),
  env: {
    ...process.env,
    NODE_ENV: "production",
    HOST: "127.0.0.1",
    PORT: String(process.env.STARTUP_GUARD_SMOKE_PORT || 5188),
    WEB_DIST_DIR: missingDist,
    WEB_STORE_DRIVER: "json",
    APP_ALLOW_JSON_STORE: "1",
    TCAR_ENGINE_MODE: "simulator",
    APP_API_TOKENS_JSON: JSON.stringify({
      [smokeToken]: {
        user_id: "startup_guard_smoke",
        workspace_id: "workspace_startup_guard_smoke",
        role: "admin"
      }
    }),
    APP_PUBLIC_ORIGIN: "https://startup-guard.prod.test",
    APP_ENABLE_HSTS: "0"
  },
  stdio: ["ignore", "pipe", "pipe"]
});

let stdout = "";
let stderr = "";
child.stdout.on("data", (chunk) => {
  stdout += chunk.toString();
});
child.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
});

try {
  const result = await Promise.race([
    waitForExit(child),
    sleep(10000).then(() => ({ timeout: true }))
  ]);
  if (result.timeout) {
    child.kill("SIGKILL");
    throw new Error("server did not exit when WEB_DIST_DIR was missing");
  }
  if (result.code === 0) {
    throw new Error("server exited successfully even though WEB_DIST_DIR was missing");
  }
  const output = `${stdout}\n${stderr}`;
  if (!output.includes("Production web build is missing")) {
    throw new Error(`missing build failure message was not explicit: ${output.slice(-1000)}`);
  }
  console.log(JSON.stringify({ ok: true, missing_dist: missingDist, exit_code: result.code }, null, 2));
} catch (error) {
  child.kill("SIGKILL");
  console.error(JSON.stringify({ ok: false, error: error.message, stdout: stdout.slice(-2000), stderr: stderr.slice(-2000) }, null, 2));
  process.exit(1);
} finally {
  await fs.rm(tmpDir, { recursive: true, force: true });
}

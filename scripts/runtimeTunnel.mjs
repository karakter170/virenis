/* global console, process */
import fs from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readAgentRuntimeEnv } from "../server/agentRuntimeConfig.js";

export function runtimeTunnelConfig(env = process.env) {
  const config = {
    sshBinary: requiredAbsolutePath(
      readAgentRuntimeEnv(env, "AGENT_RUNTIME_SSH_BINARY", "/usr/bin/ssh"),
      "AGENT_RUNTIME_SSH_BINARY"
    ),
    sshHost: requiredText(
      readAgentRuntimeEnv(env, "AGENT_RUNTIME_SSH_HOST"),
      "AGENT_RUNTIME_SSH_HOST"
    ),
    sshPort: portNumber(
      readAgentRuntimeEnv(env, "AGENT_RUNTIME_SSH_PORT", 22),
      "AGENT_RUNTIME_SSH_PORT"
    ),
    sshUser: requiredText(
      readAgentRuntimeEnv(env, "AGENT_RUNTIME_SSH_USER"),
      "AGENT_RUNTIME_SSH_USER"
    ),
    identityFile: requiredAbsolutePath(
      readAgentRuntimeEnv(env, "AGENT_RUNTIME_SSH_IDENTITY_FILE"),
      "AGENT_RUNTIME_SSH_IDENTITY_FILE"
    ),
    knownHostsFile: requiredAbsolutePath(
      readAgentRuntimeEnv(env, "AGENT_RUNTIME_SSH_KNOWN_HOSTS_FILE"),
      "AGENT_RUNTIME_SSH_KNOWN_HOSTS_FILE"
    ),
    localHost: String(readAgentRuntimeEnv(env, "AGENT_RUNTIME_TUNNEL_LOCAL_HOST", "127.0.0.1")).trim(),
    localPort: portNumber(readAgentRuntimeEnv(env, "AGENT_RUNTIME_TUNNEL_LOCAL_PORT", 19000), "AGENT_RUNTIME_TUNNEL_LOCAL_PORT"),
    runtimeHost: String(readAgentRuntimeEnv(env, "AGENT_RUNTIME_TUNNEL_RUNTIME_HOST", "127.0.0.1")).trim(),
    runtimePort: portNumber(readAgentRuntimeEnv(env, "AGENT_RUNTIME_TUNNEL_RUNTIME_PORT", 9000), "AGENT_RUNTIME_TUNNEL_RUNTIME_PORT")
  };

  if (!/^[a-z_][a-z0-9_-]*$/i.test(config.sshUser)) {
    throw new Error("AGENT_RUNTIME_SSH_USER contains unsupported characters.");
  }
  if (!/^[a-z0-9.-]+$/i.test(config.sshHost) || config.sshHost.startsWith("-")) {
    throw new Error("AGENT_RUNTIME_SSH_HOST must be an IPv4 address or DNS hostname.");
  }
  if (config.localHost !== "127.0.0.1") {
    throw new Error("AGENT_RUNTIME_TUNNEL_LOCAL_HOST must remain 127.0.0.1.");
  }
  if (config.runtimeHost !== "127.0.0.1") {
    throw new Error("AGENT_RUNTIME_TUNNEL_RUNTIME_HOST must remain 127.0.0.1.");
  }
  return config;
}

export function buildRuntimeTunnelArgs(config) {
  return [
    "-NT",
    "-p", String(config.sshPort),
    "-i", config.identityFile,
    "-o", "BatchMode=yes",
    "-o", "IdentitiesOnly=yes",
    "-o", "ExitOnForwardFailure=yes",
    "-o", "ServerAliveInterval=30",
    "-o", "ServerAliveCountMax=3",
    "-o", "StrictHostKeyChecking=yes",
    "-o", `UserKnownHostsFile=${config.knownHostsFile}`,
    "-L", `${config.localHost}:${config.localPort}:${config.runtimeHost}:${config.runtimePort}`,
    `${config.sshUser}@${config.sshHost}`
  ];
}

export function validateRuntimeTunnelFiles(config) {
  assertProtectedRegularFile(config.identityFile, "AGENT_RUNTIME_SSH_IDENTITY_FILE", true);
  assertProtectedRegularFile(config.knownHostsFile, "AGENT_RUNTIME_SSH_KNOWN_HOSTS_FILE", false);
}

function assertProtectedRegularFile(filePath, name, privateFile) {
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    throw new Error(`${name} could not be inspected: ${error.message}`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${name} must refer directly to a regular file.`);
  }
  if (privateFile && (stat.mode & 0o077) !== 0) {
    throw new Error(`${name} must not be group- or world-accessible.`);
  }
}

function requiredText(value, name) {
  const text = String(value || "").trim();
  if (!text) throw new Error(`${name} is required.`);
  return text;
}

function requiredAbsolutePath(value, name) {
  const filePath = requiredText(value, name);
  if (!filePath.startsWith("/")) throw new Error(`${name} must be an absolute path.`);
  return filePath;
}

function portNumber(value, name) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name} must be an integer between 1 and 65535.`);
  }
  return port;
}

async function run() {
  const config = runtimeTunnelConfig();
  validateRuntimeTunnelFiles(config);
  const child = spawn(config.sshBinary, buildRuntimeTunnelArgs(config), {
    stdio: "inherit",
    shell: false
  });
  const forwardSignal = (signal) => child.kill(signal);
  process.once("SIGINT", () => forwardSignal("SIGINT"));
  process.once("SIGTERM", () => forwardSignal("SIGTERM"));
  child.once("error", (error) => {
    console.error(`Agent Runtime SSH tunnel failed to start: ${error.message}`);
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    if (signal) {
      console.error(`Agent Runtime SSH tunnel stopped after ${signal}.`);
      process.exitCode = 1;
      return;
    }
    process.exitCode = code ?? 1;
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await run();
}

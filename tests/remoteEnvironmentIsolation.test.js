import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";

const WEB_ENV_URL = new URL("../.env.remote.example", import.meta.url);
const TUNNEL_ENV_URL = new URL("../.env.runtime-tunnel.example", import.meta.url);
const PACKAGE_URL = new URL("../package.json", import.meta.url);
const IDENTITY_DOC_URL = new URL("../docs/identity.md", import.meta.url);

function environmentKeys(source) {
  return source
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => line.slice(0, line.indexOf("=")))
    .filter(Boolean);
}

describe("split-host production environment isolation", () => {
  it("keeps SSH credentials and endpoint metadata out of the web process", async () => {
    const webEnvironment = await fs.readFile(WEB_ENV_URL, "utf8");
    const webKeys = environmentKeys(webEnvironment);

    expect(webKeys.some((key) => key.startsWith("AGENT_RUNTIME_SSH_"))).toBe(false);
    expect(webKeys.some((key) => key.startsWith("GPU_SSH_"))).toBe(false);
    expect(webEnvironment).not.toMatch(/\/var\/lib\/tcar-web-/u);
    expect(webEnvironment).not.toMatch(/\/etc\/tcar\//u);
    expect(webEnvironment).not.toContain("ROUTER_SESSION_CONTEXT_TOKENS");
    expect(webEnvironment).not.toContain("TCAR_MCP_GATEWAY_KEY");
  });

  it("limits the tunnel environment to forwarding metadata", async () => {
    const tunnelEnvironment = await fs.readFile(TUNNEL_ENV_URL, "utf8");
    const tunnelKeys = environmentKeys(tunnelEnvironment);

    expect(tunnelKeys.sort()).toEqual([
      "AGENT_RUNTIME_SSH_BINARY",
      "AGENT_RUNTIME_SSH_HOST",
      "AGENT_RUNTIME_SSH_IDENTITY_FILE",
      "AGENT_RUNTIME_SSH_KNOWN_HOSTS_FILE",
      "AGENT_RUNTIME_SSH_PORT",
      "AGENT_RUNTIME_SSH_USER",
      "AGENT_RUNTIME_TUNNEL_LOCAL_HOST",
      "AGENT_RUNTIME_TUNNEL_LOCAL_PORT",
      "AGENT_RUNTIME_TUNNEL_RUNTIME_HOST",
      "AGENT_RUNTIME_TUNNEL_RUNTIME_PORT"
    ].sort());
    expect(tunnelEnvironment).toContain("AGENT_RUNTIME_SSH_HOST=gpu-runtime.example.com");
    expect(tunnelEnvironment).toContain("AGENT_RUNTIME_SSH_PORT=22");
    expect(tunnelEnvironment).not.toMatch(/(?:CLERK|DATABASE|APP_MCP|AGENT_RUNTIME_API_KEY|WEB_)/u);
    expect(tunnelEnvironment)
      .not.toMatch(/^AGENT_RUNTIME_SSH_HOST=(?:\d{1,3}\.){3}\d{1,3}$/mu);
  });

  it("loads the isolated tunnel file and documents separate service identities", async () => {
    const packageDocument = JSON.parse(await fs.readFile(PACKAGE_URL, "utf8"));
    const identityDocumentation = await fs.readFile(IDENTITY_DOC_URL, "utf8");

    expect(packageDocument.scripts["tunnel:runtime"])
      .toContain("--env-file=.env.runtime-tunnel.local");
    expect(identityDocumentation).toContain("`virenis-web`");
    expect(identityDocumentation).toContain("`virenis-tunnel`");
    expect(identityDocumentation).toContain("/etc/virenis/web-remote.env");
    expect(identityDocumentation).toContain("/etc/virenis/runtime-tunnel.env");
    expect(identityDocumentation).not.toContain("/etc/tcar/web-remote.env");
    expect(identityDocumentation).not.toContain("tcar-web-tunneled.service");
  });
});

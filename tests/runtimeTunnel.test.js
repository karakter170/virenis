import { describe, expect, it } from "vitest";

import {
  buildRuntimeTunnelArgs,
  runtimeTunnelConfig
} from "../scripts/runtimeTunnel.mjs";

describe("Agent Runtime SSH runtime tunnel", () => {
  it("builds a loopback-only, host-key-verified SSH forward", () => {
    const config = runtimeTunnelConfig({
      AGENT_RUNTIME_SSH_HOST: "gpu-runtime.example.com",
      AGENT_RUNTIME_SSH_PORT: "2222",
      AGENT_RUNTIME_SSH_USER: "virenis-runtime-tunnel",
      AGENT_RUNTIME_SSH_IDENTITY_FILE: "/etc/virenis/runtime-tunnel/id_ed25519",
      AGENT_RUNTIME_SSH_KNOWN_HOSTS_FILE: "/etc/virenis/runtime-tunnel/known_hosts",
      AGENT_RUNTIME_TUNNEL_LOCAL_PORT: "19000",
      AGENT_RUNTIME_TUNNEL_RUNTIME_PORT: "9000"
    });

    expect(buildRuntimeTunnelArgs(config)).toEqual([
      "-NT",
      "-p", "2222",
      "-i", "/etc/virenis/runtime-tunnel/id_ed25519",
      "-o", "BatchMode=yes",
      "-o", "IdentitiesOnly=yes",
      "-o", "ExitOnForwardFailure=yes",
      "-o", "ServerAliveInterval=30",
      "-o", "ServerAliveCountMax=3",
      "-o", "StrictHostKeyChecking=yes",
      "-o", "UserKnownHostsFile=/etc/virenis/runtime-tunnel/known_hosts",
      "-L", "127.0.0.1:19000:127.0.0.1:9000",
      "virenis-runtime-tunnel@gpu-runtime.example.com"
    ]);
  });

  it("refuses to expose either side of the tunnel on a non-loopback bind", () => {
    const base = {
      AGENT_RUNTIME_SSH_HOST: "gpu-runtime.example.com",
      AGENT_RUNTIME_SSH_USER: "virenis-runtime-tunnel",
      AGENT_RUNTIME_SSH_IDENTITY_FILE: "/etc/virenis/runtime-tunnel/id_ed25519",
      AGENT_RUNTIME_SSH_KNOWN_HOSTS_FILE: "/etc/virenis/runtime-tunnel/known_hosts"
    };

    expect(() => runtimeTunnelConfig({
      ...base,
      AGENT_RUNTIME_TUNNEL_LOCAL_HOST: "0.0.0.0"
    })).toThrow(/must remain 127\.0\.0\.1/);
    expect(() => runtimeTunnelConfig({
      ...base,
      AGENT_RUNTIME_TUNNEL_RUNTIME_HOST: "10.0.0.5"
    })).toThrow(/must remain 127\.0\.0\.1/);
  });

  it("rejects malformed SSH endpoints and port values", () => {
    const base = {
      AGENT_RUNTIME_SSH_USER: "virenis-runtime-tunnel",
      AGENT_RUNTIME_SSH_IDENTITY_FILE: "/etc/virenis/runtime-tunnel/id_ed25519",
      AGENT_RUNTIME_SSH_KNOWN_HOSTS_FILE: "/etc/virenis/runtime-tunnel/known_hosts"
    };
    expect(() => runtimeTunnelConfig({ ...base, AGENT_RUNTIME_SSH_HOST: "-oProxyCommand=bad" }))
      .toThrow(/AGENT_RUNTIME_SSH_HOST/);
    expect(() => runtimeTunnelConfig({
      ...base,
      AGENT_RUNTIME_SSH_HOST: "gpu.example.test",
      AGENT_RUNTIME_SSH_PORT: "70000"
    })).toThrow(/AGENT_RUNTIME_SSH_PORT/);
  });
});

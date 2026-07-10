import { describe, expect, it } from "vitest";

import {
  buildRuntimeTunnelArgs,
  runtimeTunnelConfig
} from "../scripts/runtimeTunnel.mjs";

describe("TCAR SSH runtime tunnel", () => {
  it("builds a loopback-only, host-key-verified SSH forward", () => {
    const config = runtimeTunnelConfig({
      GPU_SSH_HOST: "216.81.200.239",
      GPU_SSH_PORT: "32338",
      GPU_SSH_USER: "ubuntu",
      GPU_SSH_IDENTITY_FILE: "/home/ubuntu/.ssh/tcar_gpu",
      GPU_SSH_KNOWN_HOSTS_FILE: "/home/ubuntu/.ssh/known_hosts",
      TCAR_TUNNEL_LOCAL_PORT: "19000",
      TCAR_TUNNEL_RUNTIME_PORT: "9000"
    });

    expect(buildRuntimeTunnelArgs(config)).toEqual([
      "-NT",
      "-p", "32338",
      "-i", "/home/ubuntu/.ssh/tcar_gpu",
      "-o", "BatchMode=yes",
      "-o", "IdentitiesOnly=yes",
      "-o", "ExitOnForwardFailure=yes",
      "-o", "ServerAliveInterval=30",
      "-o", "ServerAliveCountMax=3",
      "-o", "StrictHostKeyChecking=yes",
      "-o", "UserKnownHostsFile=/home/ubuntu/.ssh/known_hosts",
      "-L", "127.0.0.1:19000:127.0.0.1:9000",
      "ubuntu@216.81.200.239"
    ]);
  });

  it("refuses to expose either side of the tunnel on a non-loopback bind", () => {
    const base = {
      GPU_SSH_HOST: "216.81.200.239",
      GPU_SSH_IDENTITY_FILE: "/home/ubuntu/.ssh/tcar_gpu",
      GPU_SSH_KNOWN_HOSTS_FILE: "/home/ubuntu/.ssh/known_hosts"
    };

    expect(() => runtimeTunnelConfig({
      ...base,
      TCAR_TUNNEL_LOCAL_HOST: "0.0.0.0"
    })).toThrow(/must remain 127\.0\.0\.1/);
    expect(() => runtimeTunnelConfig({
      ...base,
      TCAR_TUNNEL_RUNTIME_HOST: "10.0.0.5"
    })).toThrow(/must remain 127\.0\.0\.1/);
  });

  it("rejects malformed SSH endpoints and port values", () => {
    const base = {
      GPU_SSH_IDENTITY_FILE: "/home/ubuntu/.ssh/tcar_gpu",
      GPU_SSH_KNOWN_HOSTS_FILE: "/home/ubuntu/.ssh/known_hosts"
    };
    expect(() => runtimeTunnelConfig({ ...base, GPU_SSH_HOST: "-oProxyCommand=bad" }))
      .toThrow(/GPU_SSH_HOST/);
    expect(() => runtimeTunnelConfig({
      ...base,
      GPU_SSH_HOST: "gpu.example.test",
      GPU_SSH_PORT: "70000"
    })).toThrow(/GPU_SSH_PORT/);
  });
});

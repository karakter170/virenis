import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import * as simulator from "./fixtures/agentRuntimeSimulator.js";

const PROJECT_ROOT = fileURLToPath(new URL("../", import.meta.url));
const SERVER_ROOT = path.join(PROJECT_ROOT, "server");
const SIMULATOR_FIXTURE = path.join(PROJECT_ROOT, "tests", "fixtures", "agentRuntimeSimulator.js");
const APPROVED_SHARED_CONTRACTS = [
  path.join(PROJECT_ROOT, "shared", "agentRuntimeStateContract.js"),
  path.join(PROJECT_ROOT, "shared", "persistedStorageCompatibility.js")
].sort();

describe("runtime module boundary", () => {
  it("keeps test-only simulation outside the production import graph", async () => {
    const reachable = await staticModuleGraph(path.join(SERVER_ROOT, "index.js"));
    expect(reachable).not.toContain(SIMULATOR_FIXTURE);
    expect(
      [...reachable]
        .filter((filename) => !filename.startsWith(SERVER_ROOT))
        .sort()
    ).toEqual(APPROVED_SHARED_CONTRACTS);
  });

  it("keeps the local processor explicit and fixture-only", () => {
    expect(Object.keys(simulator).sort()).toEqual([
      "configuredAgentDependencies",
      "configuredPlanGaps",
      "planRoutes",
      "processLocalChatRun",
      "processLocalValidationRun",
      "resolveAgentContext",
      "sanitizeToolCalls"
    ]);
  });
});

async function staticModuleGraph(entry) {
  const visited = new Set();
  const pending = [entry];
  while (pending.length > 0) {
    const current = pending.pop();
    if (visited.has(current)) continue;
    visited.add(current);
    const source = await fs.readFile(current, "utf8");
    const specifiers = [
      ...source.matchAll(/(?:from\s*|import\s*\()\s*["'](\.[^"']+)["']/g)
    ].map((match) => match[1]);
    for (const specifier of specifiers) {
      const resolved = path.resolve(path.dirname(current), specifier);
      const candidate = path.extname(resolved) ? resolved : `${resolved}.js`;
      if (candidate.startsWith(PROJECT_ROOT) && !visited.has(candidate)) pending.push(candidate);
    }
  }
  return visited;
}

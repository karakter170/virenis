import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const UI_FILES = [
  "src/App.jsx",
  "src/IdentityPage.jsx",
  "src/workspaceBootstrap.js"
];

const FEATURE_PROOF = [
  {
    feature: "identity, account export, deletion, roles, suspension, and session revocation",
    ui: "src/IdentityPage.jsx",
    backend: "server/app.js",
    tests: ["tests/identity.test.js", "tests/identityUi.test.js", "tests/tenantMutationIsolation.test.js"]
  },
  {
    feature: "chat sessions, message admission, live events, retry, feedback, and durable recovery",
    ui: "src/App.jsx",
    backend: "server/app.js",
    tests: ["tests/api.test.js", "tests/sseLifecycle.test.js", "tests/recovery.test.js", "tests/sessionRunAdmission.test.js"]
  },
  {
    feature: "teams, membership, active-agent state, team maps, and 16-agent capacity",
    ui: "src/App.jsx",
    backend: "server/agentWorkspaces.js",
    tests: ["tests/agentWorkspaces.test.js", "tests/productFeatures.test.js", "tests/tenantMutationIsolation.test.js"]
  },
  {
    feature: "Agent Studio fields, canonical contract, lifecycle, tools, memory, and permissions",
    ui: "src/App.jsx",
    backend: "server/agentContract.js",
    tests: ["tests/agentContractV4.test.js", "tests/agentToolConfiguration.test.js", "tests/workflowAgentConfigurationE2E.test.js"]
  },
  {
    feature: "knowledge upload, CSV/PDF extraction, chunks, search, binding, and deletion",
    ui: "src/App.jsx",
    backend: "server/documents.js",
    tests: ["tests/documents.test.js", "tests/api.test.js", "tests/workflowSourceFirstE2E.test.js"]
  },
  {
    feature: "Discover listing detail, publish, unpublish, rating, agent copy, and team copy",
    ui: "src/App.jsx",
    backend: "server/app.js",
    tests: ["tests/curatedMarketplace.test.js", "tests/curatedTeamsE2E.test.js", "tests/agentWorkspaces.test.js"]
  },
  {
    feature: "workflow and agent commands, decisions, connections, activation, and resume",
    ui: "src/App.jsx",
    backend: "server/workflows.js",
    tests: ["tests/workflows.test.js", "tests/workflowAgentConfig.test.js", "tests/workflowSourceFirstE2E.test.js"]
  },
  {
    feature: "connected apps, OAuth/custom MCP, refresh, disconnect, approvals, and revocation recovery",
    ui: "src/App.jsx",
    backend: "server/mcp.js",
    tests: ["tests/mcp.test.js", "tests/mcpOAuth.test.js", "tests/mcpProviderRegistry.test.js"]
  },
  {
    feature: "human-readable Markdown, named sources, source preview, and answer-details panel",
    ui: "src/answerPresentation.js",
    backend: "server/tcarEngine.js",
    tests: ["tests/answerPresentation.test.js", "tests/productFeatures.test.js", "tests/runtimeStreaming.test.js"]
  },
  {
    feature: "billing balance, usage receipts, ledger privacy, pricing, and admin adjustments",
    ui: "src/IdentityPage.jsx",
    backend: "server/billing.js",
    tests: ["tests/billingApi.test.js", "tests/billingSql.test.js", "tests/normalizedBillingPrivacy.test.js"]
  },
  {
    feature: "Runtime health, models, adoption, audit proof, validation, and metrics",
    ui: "src/App.jsx",
    backend: "server/runtimeClient.js",
    tests: ["tests/runtimeClient.test.js", "tests/runtimeAdoption.test.js", "tests/runtimeAuditReconciliation.test.js"]
  },
  {
    feature: "WorldGraph freshness checks, selective reuse, and visual explanations",
    ui: "src/App.jsx",
    backend: "server/worldGraph.js",
    tests: ["tests/worldGraph.test.js", "tests/worldGraphApi.test.js", "tests/worldGraphRemote.test.js"]
  },
  {
    feature: "Outcome Contracts, evidence quotes, settlement, dispute, correction, and RealityRank",
    ui: "src/App.jsx",
    backend: "server/outcomes.js",
    tests: ["tests/outcomes.test.js", "tests/outcomeEvidence.test.js", "tests/productFeatures.test.js"]
  },
  {
    feature: "landing, identity recovery, responsive navigation, and production build",
    ui: "src/LandingPage.jsx",
    backend: "server/productionBuild.js",
    tests: ["tests/authRecovery.test.js", "tests/identityUi.test.js", "tests/productionBuild.test.js"]
  }
];

function normalizeRoute(value) {
  return String(value || "")
    .replace(/\$\{[^}]+\}/g, ":param")
    .replace(/:[A-Za-z0-9_]+/g, ":param")
    .split("?")[0];
}

function uiApiRoutes() {
  const routes = new Set();
  for (const relative of UI_FILES) {
    const source = fs.readFileSync(path.join(ROOT, relative), "utf8");
    for (const match of source.matchAll(/(["'`])(\/api\/[\s\S]*?)\1/g)) {
      if (match[2].includes("\n")) continue;
      routes.add(normalizeRoute(match[2]));
    }
  }
  return [...routes].sort();
}

function serverApiRoutes() {
  const source = fs.readFileSync(path.join(ROOT, "server/app.js"), "utf8");
  return new Set(
    [...source.matchAll(/app\.(?:get|post|put|patch|delete)\(\s*["']([^"']+)["']/g)]
      .map((match) => normalizeRoute(match[1]))
  );
}

function uiApiOperations() {
  const operations = new Set();
  for (const relative of UI_FILES) {
    const source = fs.readFileSync(path.join(ROOT, relative), "utf8");
    for (const match of source.matchAll(/\b(?:api|apiClient)\.(get|post|patch|delete|postForm)\(\s*(["'`])(\/api\/[\s\S]*?)\2/g)) {
      if (match[3].includes("\n")) continue;
      const method = match[1] === "postForm" ? "post" : match[1];
      operations.add(`${method} ${normalizeRoute(match[3])}`);
    }
    for (const match of source.matchAll(/identityRequest\(\s*(["'`])(\/api\/[\s\S]*?)\1/g)) {
      if (match[2].includes("\n")) continue;
      const followingCall = source.slice(match.index, match.index + 500);
      const explicitMethod = followingCall.match(/method:\s*["'](GET|POST|PUT|PATCH|DELETE)["']/)?.[1];
      operations.add(`${String(explicitMethod || "GET").toLowerCase()} ${normalizeRoute(match[2])}`);
    }
    for (const match of source.matchAll(/new EventSource\(\s*(["'`])(\/api\/[\s\S]*?)\1/g)) {
      if (!match[2].includes("\n")) operations.add(`get ${normalizeRoute(match[2])}`);
    }
  }
  return [...operations].sort();
}

function serverApiOperations() {
  const source = fs.readFileSync(path.join(ROOT, "server/app.js"), "utf8");
  return new Set(
    [...source.matchAll(/app\.(get|post|put|patch|delete)\(\s*["']([^"']+)["']/g)]
      .map((match) => `${match[1]} ${normalizeRoute(match[2])}`)
  );
}

describe("web surface to backend contract", () => {
  it("backs every API path referenced by the browser with an Express implementation", () => {
    const backendRoutes = serverApiRoutes();
    const uiRoutes = uiApiRoutes();
    const missing = uiRoutes.filter((route) => !backendRoutes.has(route));

    expect(uiRoutes.length).toBeGreaterThanOrEqual(55);
    expect(missing).toEqual([]);
  });

  it("backs every statically declared browser mutation with the matching HTTP method", () => {
    const backendOperations = serverApiOperations();
    const uiOperations = uiApiOperations();
    const missing = uiOperations.filter((operation) => !backendOperations.has(operation));

    expect(uiOperations.length).toBeGreaterThanOrEqual(60);
    expect(missing).toEqual([]);
  });

  it("keeps every major interactive surface tied to executable behavior tests", () => {
    for (const proof of FEATURE_PROOF) {
      expect(fs.existsSync(path.join(ROOT, proof.ui)), `${proof.feature}: UI`).toBe(true);
      expect(fs.existsSync(path.join(ROOT, proof.backend)), `${proof.feature}: backend`).toBe(true);
      expect(proof.tests.length, `${proof.feature}: tests`).toBeGreaterThanOrEqual(3);
      for (const test of proof.tests) {
        expect(fs.existsSync(path.join(ROOT, test)), `${proof.feature}: ${test}`).toBe(true);
      }
    }
  });
});

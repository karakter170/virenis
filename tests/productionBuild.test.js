import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertFrontendClerkPublishableKey } from "../server/productionBuild.js";

let temporaryRoot = "";

afterEach(async () => {
  if (temporaryRoot) await fs.rm(temporaryRoot, { recursive: true, force: true });
  temporaryRoot = "";
});

describe("production frontend identity build", () => {
  it("accepts a bundle containing the backend Clerk publishable key", async () => {
    temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "virenis-build-identity-"));
    await fs.mkdir(path.join(temporaryRoot, "assets"));
    await fs.writeFile(
      path.join(temporaryRoot, "assets", "index.js"),
      'const publishableKey = "pk_live_expected_public_fixture";\n',
      "utf8"
    );
    await expect(assertFrontendClerkPublishableKey(
      temporaryRoot,
      "pk_live_expected_public_fixture"
    )).resolves.toBeUndefined();
  });

  it("rejects a stale bundle built for a different Clerk application", async () => {
    temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "virenis-build-identity-"));
    await fs.mkdir(path.join(temporaryRoot, "assets"));
    await fs.writeFile(
      path.join(temporaryRoot, "assets", "index.js"),
      'const publishableKey = "pk_test_stale_public_fixture";\n',
      "utf8"
    );
    await expect(assertFrontendClerkPublishableKey(
      temporaryRoot,
      "pk_live_expected_public_fixture"
    )).rejects.toThrow(/different Clerk publishable key/);
  });
});

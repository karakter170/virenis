import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeDocumentFiles } from "../server/documents.js";
import { JsonStore } from "../server/store.js";

const temporaryRoots = [];

async function privateMode(filePath) {
  return (await fs.stat(filePath)).mode & 0o777;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, {
    recursive: true,
    force: true
  })));
});

describe("private local storage permissions", () => {
  it("repairs the JSON data directory and snapshot to owner-only modes", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "virenis-storage-mode-"));
    temporaryRoots.push(root);
    const dataRoot = path.join(root, "data");
    const dbPath = path.join(dataRoot, "app-db.json");
    await fs.mkdir(dataRoot, { recursive: true, mode: 0o755 });
    await fs.writeFile(dbPath, "{}\n", { mode: 0o644 });

    const store = new JsonStore({ dbPath, seedAgents: [] });
    await store.init();

    expect(await privateMode(dataRoot)).toBe(0o700);
    expect(await privateMode(dbPath)).toBe(0o600);
  });

  it("writes uploaded knowledge and its index with owner-only modes", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "virenis-upload-mode-"));
    temporaryRoots.push(root);
    const uploadRoot = path.join(root, "uploads");
    await fs.mkdir(uploadRoot, { recursive: true, mode: 0o755 });

    await writeDocumentFiles({
      uploadRoot,
      slug: "sample",
      chunks: [{
        chunk_id: "sample_0001",
        title: "Sample",
        page_start: 1,
        page_end: 1,
        tags: ["sample"],
        content_digest: "sha256:test",
        path: "sources/tcar_documents/sample/chunks/sample_0001.md",
        body: "Private knowledge."
      }]
    });

    expect(await privateMode(uploadRoot)).toBe(0o700);
    expect(await privateMode(path.join(uploadRoot, "sources/tcar_documents/sample"))).toBe(0o700);
    expect(await privateMode(path.join(
      uploadRoot,
      "sources/tcar_documents/sample/chunks/sample_0001.md"
    ))).toBe(0o600);
    expect(await privateMode(path.join(
      uploadRoot,
      "sources/tcar_documents/sample/index.jsonl"
    ))).toBe(0o600);
  });
});

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { basicAuthPassword, basicAuthConfigured } from "../server/authConfig.js";
import { runtimeApiKey } from "../server/runtimeClient.js";
import { readConfiguredSecret } from "../server/secretConfig.js";

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    fs.rm(directory, { recursive: true, force: true })
  ));
});

describe("file-backed server secrets", () => {
  it("loads TCAR and Basic Auth secrets from mode-0600 files", async () => {
    const secretFile = await createSecretFile("0123456789abcdef0123456789abcdef");
    const env = {
      NODE_ENV: "production",
      AGENT_RUNTIME_API_KEY_FILE: secretFile,
      APP_BASIC_AUTH_USER: "admin",
      APP_BASIC_AUTH_PASSWORD_FILE: secretFile
    };

    expect(runtimeApiKey(env)).toBe("0123456789abcdef0123456789abcdef");
    expect(basicAuthPassword(env)).toBe("0123456789abcdef0123456789abcdef");
    expect(basicAuthConfigured(env)).toBe(true);
  });

  it("keeps inline values backward compatible and gives them precedence", async () => {
    const secretFile = await createSecretFile("file-secret-value");
    expect(readConfiguredSecret({
      INLINE_SECRET: "inline-secret-value",
      SECRET_FILE: secretFile
    }, "INLINE_SECRET", "SECRET_FILE")).toBe("inline-secret-value");
  });

  it("rejects production secret files readable by other users", async () => {
    const secretFile = await createSecretFile("0123456789abcdef0123456789abcdef");
    await fs.chmod(secretFile, 0o644);

    expect(() => runtimeApiKey({
      NODE_ENV: "production",
      AGENT_RUNTIME_API_KEY_FILE: secretFile
    })).toThrow(/group- or world-accessible/);
  });

  it("rejects empty and multiline secret files", async () => {
    const emptyFile = await createSecretFile("");
    const multilineFile = await createSecretFile("first-line\nsecond-line");

    expect(() => readConfiguredSecret({ SECRET_FILE: emptyFile }, "SECRET", "SECRET_FILE"))
      .toThrow(/empty/);
    expect(() => readConfiguredSecret({ SECRET_FILE: multilineFile }, "SECRET", "SECRET_FILE"))
      .toThrow(/exactly one secret line/);
  });
});

async function createSecretFile(value) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "virenis-secret-"));
  temporaryDirectories.push(directory);
  const filePath = path.join(directory, "secret.txt");
  await fs.writeFile(filePath, value, { encoding: "utf8", mode: 0o600 });
  return filePath;
}

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

if (process.env.APP_GENERATE_BASIC_AUTH_PASSWORD === "1") {
  const passwordFile = String(process.env.APP_BASIC_AUTH_PASSWORD_FILE || "").trim();
  if (!passwordFile) {
    throw new Error(
      "APP_GENERATE_BASIC_AUTH_PASSWORD=1 requires APP_BASIC_AUTH_PASSWORD_FILE."
    );
  }
  await ensurePasswordFile(passwordFile);
}

await import("./index.js");

async function ensurePasswordFile(filePath) {
  await fs.mkdir(path.dirname(path.resolve(filePath)), { recursive: true, mode: 0o700 });
  let handle;
  try {
    handle = await fs.open(filePath, "wx", 0o600);
    await handle.writeFile(`${crypto.randomBytes(32).toString("hex")}\n`, "utf8");
    await handle.sync();
    console.log(`Created the web Basic Auth password file at ${filePath}.`);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  } finally {
    await handle?.close();
  }
}

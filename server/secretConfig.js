import fs from "node:fs";

const DEFAULT_MAX_SECRET_BYTES = 64 * 1024;

/**
 * Resolve a one-line secret from an environment variable or a mode-restricted
 * file. Inline values take precedence so existing deployments remain
 * compatible while systemd/Kubernetes-style secret files can be adopted
 * without copying credentials into the web process command line.
 */
export function readConfiguredSecret(
  env,
  inlineName,
  fileName,
  { maxBytes = DEFAULT_MAX_SECRET_BYTES } = {}
) {
  const inline = String(env?.[inlineName] ?? "").trim();
  if (inline) return inline;

  const filePath = String(env?.[fileName] ?? "").trim();
  if (!filePath) return "";

  let descriptor;
  try {
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)
    );
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) {
      throw secretFileError(`${fileName} must refer to a regular file.`);
    }
    if (stat.size > maxBytes) {
      throw secretFileError(`${fileName} exceeds the ${maxBytes}-byte limit.`);
    }
    const production = String(env?.NODE_ENV ?? process.env.NODE_ENV ?? "") === "production";
    if (production && (stat.mode & 0o077) !== 0) {
      throw secretFileError(`${fileName} must not be group- or world-accessible in production.`);
    }

    const value = fs.readFileSync(descriptor, "utf8").trim();
    if (!value) {
      throw secretFileError(`${fileName} is empty.`);
    }
    if (/[\r\n\0]/.test(value)) {
      throw secretFileError(`${fileName} must contain exactly one secret line.`);
    }
    return value;
  } catch (error) {
    if (error?.code === "CONFIG_SECRET_INVALID") throw error;
    throw secretFileError(`${fileName} could not be read: ${error.message}`);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function secretFileError(message) {
  const error = new Error(message);
  error.code = "CONFIG_SECRET_INVALID";
  return error;
}

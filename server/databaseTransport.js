const ENCRYPTED_POSTGRES_SSL_MODES = new Set([
  "require",
  "verify-ca",
  "verify-full"
]);

/**
 * Fail closed when the production serving process connects to PostgreSQL over
 * a remote network. Loopback databases remain usable for the documented
 * same-host deployment, while an explicitly acknowledged protected-network
 * exception is available for installations that terminate transport security
 * outside PostgreSQL.
 */
export function validateProductionDatabaseTransport(
  env = process.env,
  connectionString = env.DATABASE_URL
) {
  if (env.NODE_ENV !== "production" || !connectionString) return;

  let databaseUrl;
  try {
    databaseUrl = new URL(String(connectionString));
  } catch {
    throw new Error("DATABASE_URL must be a valid absolute PostgreSQL URL.");
  }

  if (!["postgres:", "postgresql:"].includes(databaseUrl.protocol)) {
    throw new Error("DATABASE_URL must use the postgres or postgresql scheme.");
  }

  if (isLoopbackDatabaseHost(databaseUrl.hostname)) return;
  if (env.WEB_ALLOW_INSECURE_PRIVATE_POSTGRES === "1") return;

  const sslMode = String(databaseUrl.searchParams.get("sslmode") || "").toLowerCase();
  const sslFlag = String(databaseUrl.searchParams.get("ssl") || "").toLowerCase();
  const encrypted = sslMode
    ? ENCRYPTED_POSTGRES_SSL_MODES.has(sslMode)
    : sslFlag === "true";

  if (!encrypted) {
    throw new Error(
      "Production remote DATABASE_URL must require encrypted PostgreSQL transport; "
      + "use sslmode=verify-full (recommended). Set "
      + "WEB_ALLOW_INSECURE_PRIVATE_POSTGRES=1 only when a protected private network "
      + "provides equivalent transport isolation."
    );
  }
}

function isLoopbackDatabaseHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  return host === "localhost"
    || host === "localhost.localdomain"
    || host === "127.0.0.1"
    || host === "::1"
    || host === "[::1]";
}

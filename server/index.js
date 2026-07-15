import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { createServer as createViteServer } from "vite";
import { createApp, resolveLifecycleTimeouts } from "./app.js";
import { requireRuntimeConfigured } from "./runtimeClient.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const distRoot = process.env.WEB_DIST_DIR ? path.resolve(process.env.WEB_DIST_DIR) : path.join(root, "dist");
const port = Number(process.env.PORT || 5173);
const isProduction = process.env.NODE_ENV === "production";
const host = process.env.HOST || (isProduction ? "127.0.0.1" : "0.0.0.0");
const { shutdownTimeoutMs, backgroundDrainTimeoutMs } = resolveLifecycleTimeouts();

requireRuntimeConfigured();

if (isProduction) {
  await assertProductionBuild(distRoot);
}

const app = await createApp({
  dbPath: path.join(root, "data", "app-db.json"),
  uploadRoot: path.join(root, "uploads")
});

let vite;
if (isProduction) {
  app.use(express.static(distRoot, {
    dotfiles: "deny",
    index: false,
    setHeaders: setProductionStaticHeaders
  }));
  app.get("*", (req, res) => {
    if (req.path.startsWith("/assets/") || path.extname(req.path)) {
      res.status(404).type("text/plain").send("Not found.");
      return;
    }
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(path.join(distRoot, "index.html"));
  });
} else {
  vite = await createViteServer({
    root,
    server: { middlewareMode: true },
    appType: "spa"
  });
  app.use(vite.middlewares);
}

const server = app.listen(port, host, () => {
  const boundUrl = `http://${host}:${port}`;
  const browserUrl = String(process.env.APP_PUBLIC_ORIGIN || "").trim().replace(/\/+$/, "")
    || `http://${["0.0.0.0", "::"].includes(host) ? "localhost" : host}:${port}`;
  console.log(`virenis listening on ${browserUrl}${browserUrl === boundUrl ? "" : ` (bound to ${boundUrl})`}`);
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.log(`virenis received ${signal}; shutting down.`);
  const forceExit = setTimeout(() => {
    console.error(`virenis shutdown exceeded ${shutdownTimeoutMs}ms.`);
    process.exit(1);
  }, shutdownTimeoutMs);
  forceExit.unref();

  try {
    const serverClosed = new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
    app.locals.closeEventStreams?.({ reason: signal });
    await serverClosed;
    const drainResult = await app.locals.drainBackgroundTasks?.({
      timeoutMs: backgroundDrainTimeoutMs
    });
    if (drainResult && !drainResult.ok) {
      throw new Error(`Timed out waiting for ${drainResult.pending} background task(s) to finish.`);
    }
    await vite?.close?.();
    await app.locals.store?.close?.();
    clearTimeout(forceExit);
    process.exit(0);
  } catch (error) {
    clearTimeout(forceExit);
    console.error("virenis shutdown failed.", error);
    process.exit(1);
  }
}

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});
process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

async function assertProductionBuild(buildRoot) {
  try {
    await fs.access(path.join(buildRoot, "index.html"));
  } catch {
    throw new Error(`Production web build is missing at ${buildRoot}. Run npm run build before npm start.`);
  }
}

function setProductionStaticHeaders(res, filePath) {
  const relative = path.relative(distRoot, filePath).split(path.sep).join("/");
  if (relative.startsWith("assets/")) {
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    return;
  }
  res.setHeader("Cache-Control", "no-cache");
}

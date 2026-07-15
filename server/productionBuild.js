import fs from "node:fs/promises";
import path from "node:path";

export async function assertFrontendClerkPublishableKey(buildRoot, publishableKey) {
  const expectedKey = String(publishableKey || "").trim();
  if (!expectedKey) return;

  const assetsRoot = path.join(path.resolve(buildRoot), "assets");
  let assetNames;
  try {
    assetNames = await fs.readdir(assetsRoot);
  } catch {
    throw new Error(
      `Production web build is missing JavaScript assets at ${assetsRoot}. Run the hosted build before starting the server.`
    );
  }

  const javascriptAssets = assetNames
    .filter((name) => name.endsWith(".js"))
    .map((name) => path.join(assetsRoot, name));
  for (const assetPath of javascriptAssets) {
    const source = await fs.readFile(assetPath, "utf8");
    if (source.includes(expectedKey)) return;
  }

  throw new Error(
    "The production web build uses a different Clerk publishable key than the backend. Rebuild the frontend with the hosted environment, then restart the server."
  );
}

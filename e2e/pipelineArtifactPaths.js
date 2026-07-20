import path from "node:path";

export function artifactDirectoryForOutput(outputPath) {
  const normalized = path.resolve(String(outputPath || ""));
  const extension = path.extname(normalized);
  const stem = path.basename(normalized, extension) || "pipeline_results";
  return path.join(path.dirname(normalized), `${stem}_artifacts`);
}

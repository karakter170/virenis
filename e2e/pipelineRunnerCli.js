export const PIPELINE_RUNNER_USAGE = `Usage: node e2e/pipelineBrowserRunner.mjs

Configure runs with PIPELINE_BASE_URL, PIPELINE_STORAGE_STATE,
PIPELINE_CONCURRENCY, PIPELINE_RUN_TIMEOUT_MS, PIPELINE_OUTPUT,
PIPELINE_RESUME, and PIPELINE_SCENARIOS.`;

export function parsePipelineRunnerArgs(args = []) {
  const values = Array.isArray(args) ? args.map(String) : [];
  if (values.includes("--help") || values.includes("-h")) return { help: true };
  if (values.length > 0) {
    throw new Error(`Unsupported pipeline runner arguments: ${values.join(" ")}. Use --help for usage.`);
  }
  return { help: false };
}

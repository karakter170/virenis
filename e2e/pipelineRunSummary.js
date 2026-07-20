export function pipelineRunSummary(record = {}) {
  const results = Array.isArray(record.results) ? record.results : [];
  const workerErrors = Array.isArray(record.worker_errors) ? record.worker_errors : [];
  const requested = Math.max(0, Number(record.scenario_count) || 0);
  const completed = results.filter((result) => result.run?.status === "completed").length;
  const failed = results.filter((result) => result.run?.status === "failed").length;
  const resultErrors = results.filter((result) => result.error).length;
  const missingScenarios = Math.max(0, requested - results.length);
  const harnessErrors = resultErrors + workerErrors.length;
  return {
    ok: harnessErrors === 0 && missingScenarios === 0,
    results: results.length,
    completed,
    failed,
    harnessErrors,
    workerErrors: workerErrors.length,
    missingScenarios
  };
}

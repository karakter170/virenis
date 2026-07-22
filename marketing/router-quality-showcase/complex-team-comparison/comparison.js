const $ = (selector) => document.querySelector(selector);
const number = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });

function setText(selector, value) {
  const node = $(selector);
  if (node) node.textContent = value;
}

function plainInline(value) {
  return value
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^\s*[*_]+|[*_]+\s*$/g, "")
    .trim();
}

function renderMarkdown(container, source) {
  const lines = String(source || "").replace(/\r/g, "").split("\n");
  let index = 0;
  let list = null;
  const closeList = () => { list = null; };
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { closeList(); index += 1; continue; }
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      closeList();
      const node = document.createElement(`h${heading[1].length}`);
      node.textContent = plainInline(heading[2]);
      container.append(node);
      index += 1;
      continue;
    }
    if (/^\s*\|/.test(line)) {
      closeList();
      const rows = [];
      while (index < lines.length && /^\s*\|/.test(lines[index])) rows.push(lines[index++]);
      const pre = document.createElement("pre");
      pre.className = "md-table";
      pre.textContent = rows.join("\n");
      container.append(pre);
      continue;
    }
    const unordered = /^\s*[-*+]\s+(.+)$/.exec(line);
    const ordered = /^\s*\d+[.)]\s+(.+)$/.exec(line);
    if (unordered || ordered) {
      const tag = ordered ? "ol" : "ul";
      if (!list || list.tagName.toLowerCase() !== tag) {
        list = document.createElement(tag);
        container.append(list);
      }
      const item = document.createElement("li");
      item.textContent = plainInline((unordered || ordered)[1]);
      list.append(item);
      index += 1;
      continue;
    }
    closeList();
    const paragraphLines = [line.trim()];
    index += 1;
    while (
      index < lines.length && lines[index].trim() &&
      !/^(#{1,3})\s+/.test(lines[index]) &&
      !/^\s*(?:[-*+]|\d+[.)])\s+/.test(lines[index]) &&
      !/^\s*\|/.test(lines[index])
    ) paragraphLines.push(lines[index++].trim());
    const paragraph = document.createElement("p");
    paragraph.textContent = plainInline(paragraphLines.join(" "));
    container.append(paragraph);
  }
}

function statusMark(met) {
  const span = document.createElement("span");
  span.className = `check${met ? "" : " miss"}`;
  span.textContent = met ? "✓" : "—";
  span.setAttribute("aria-label", met ? "Covered" : "Not detected");
  return span;
}

async function loadComparison() {
  const response = await fetch("report.json", { cache: "no-store" });
  if (!response.ok) throw new Error(`report.json returned ${response.status}`);
  const report = await response.json();
  const scenario = report.cases.find((item) => item.id === "marketing_match3_launch");
  if (!scenario) throw new Error("Marketing scenario is missing");

  const base = scenario.base;
  const team = scenario.team;
  const baseMetrics = base.metrics;
  const teamMetrics = team.metrics;
  setText("[data-team-score]", teamMetrics.required_outcomes_covered);
  setText("[data-base-score]", baseMetrics.required_outcomes_covered);
  setText("[data-outcome-lift]", `+${teamMetrics.required_outcomes_covered - baseMetrics.required_outcomes_covered}`);
  $("[data-team-bar]").style.width = `${teamMetrics.coverage_rate * 100}%`;
  $("[data-base-bar]").style.width = `${baseMetrics.coverage_rate * 100}%`;

  const densityLift = (teamMetrics.coverage_per_1000_answer_words / baseMetrics.coverage_per_1000_answer_words - 1) * 100;
  const fewerWords = (1 - teamMetrics.answer_words / baseMetrics.answer_words) * 100;
  const tokenMultiple = teamMetrics.model_usage.total_tokens / baseMetrics.model_usage.total_tokens;
  const latencyMultiple = teamMetrics.elapsed_seconds / baseMetrics.elapsed_seconds;
  setText("[data-density-lift]", `+${number.format(densityLift)}%`);
  setText("[data-word-change]", `${number.format(fewerWords)}%`);
  setText("[data-token-multiple]", `${number.format(tokenMultiple)}×`);
  setText("[data-base-answer-meta]", `${number.format(baseMetrics.answer_words)} words · ${number.format(baseMetrics.elapsed_seconds)}s`);
  setText("[data-team-answer-meta]", `${number.format(teamMetrics.answer_words)} words · ${number.format(teamMetrics.elapsed_seconds)}s`);
  setText(
    "[data-cost-disclosure]",
    `Team used ${number.format(tokenMultiple)}× the reported inference tokens and ${number.format(latencyMultiple)}× the wall time in this capture.`,
  );

  const pipeline = $("[data-agent-pipeline]");
  team.agents.forEach((agent, index) => {
    const item = document.createElement("li");
    const title = document.createElement("strong");
    title.textContent = agent;
    const label = document.createElement("small");
    label.textContent = index === team.agents.length - 1 ? "Team lead" : "Validated handoff";
    item.append(title, label);
    pipeline.append(item);
  });

  const baseById = new Map(base.score.criteria.map((item) => [item.id, item]));
  const teamById = new Map(team.score.criteria.map((item) => [item.id, item]));
  const checklist = $("[data-checklist]");
  scenario.rubric.forEach((criterion) => {
    const baseResult = baseById.get(criterion.id);
    const teamResult = teamById.get(criterion.id);
    const row = document.createElement("tr");
    if (teamResult?.met && !baseResult?.met) row.className = "team-only";
    const label = document.createElement("td");
    label.textContent = criterion.label;
    const baseCell = document.createElement("td");
    const teamCell = document.createElement("td");
    baseCell.append(statusMark(Boolean(baseResult?.met)));
    teamCell.append(statusMark(Boolean(teamResult?.met)));
    row.append(label, baseCell, teamCell);
    checklist.append(row);
  });

  renderMarkdown($("[data-base-answer]"), base.answer);
  renderMarkdown($("[data-team-answer]"), team.answer);
  setText("[data-total-base]", `${report.totals.base_required_outcomes}/${report.totals.required_outcomes_maximum}`);
  setText("[data-total-team]", `${report.totals.team_required_outcomes}/${report.totals.required_outcomes_maximum}`);
  const captured = new Date(report.captured_at);
  setText("[data-captured-at]", Number.isNaN(captured.valueOf()) ? report.captured_at : captured.toLocaleString("en-US", { timeZone: "UTC", dateStyle: "medium", timeStyle: "short" }) + " UTC");
  document.body.dataset.ready = "true";
}

loadComparison().catch((error) => {
  console.error(error);
  $("[data-load-error]").hidden = false;
  document.body.dataset.ready = "error";
});

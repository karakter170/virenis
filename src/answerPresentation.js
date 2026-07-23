const STRUCTURED_METADATA_KEYS = new Set(["source", "reference", "artifact"]);
const STRUCTURED_PRIORITY_KEYS = new Set(["executive_summary", "final_answer", "next_actions"]);
const SCHEMA_ROOT_SUFFIX = /(?:answer|brief|framework|ledger|plan|platform|recommendation|shortlist|strategy|system)$/;

function humanizeKey(value) {
  return String(value || "")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function unquote(value) {
  const text = String(value || "").trim();
  if (text.length > 1 && ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))) {
    return text.slice(1, -1).trim();
  }
  return text.replace(/^['"]/, "").replace(/['"]$/, "").trim();
}

function structuredFields(value) {
  const matches = [...value.matchAll(/(?:^|(?<=\s))([a-z][a-z0-9_]{2,}):\s*/g)];
  return matches.map((match, index) => ({
    key: match[1],
    value: value.slice(match.index + match[0].length, matches[index + 1]?.index ?? value.length).trim()
  }));
}

function listItems(value) {
  const quoted = [...String(value || "").matchAll(/(?:^|\s)-\s*["']([^"']+)["']/g)].map((match) => match[1].trim());
  if (quoted.length) return quoted;
  return String(value || "")
    .split(/\s+-\s+/)
    .map(unquote)
    .filter(Boolean);
}

function formatMultilineEnvelope(value) {
  const lines = value.split("\n");
  const root = lines[0]?.match(/^([a-z][a-z0-9_]*):\s*$/);
  if (!root || !SCHEMA_ROOT_SUFFIX.test(root[1])) return "";
  const keyRows = lines.slice(1).flatMap((line) => {
    const match = line.match(/^(\s*)(?:-\s*)?([a-z][a-z0-9_]*):\s*(.*)$/);
    return match ? [{ indent: match[1].replaceAll("\t", "    ").length, key: match[2], content: match[3] }] : [];
  });
  if (keyRows.length < 4) return "";
  const positiveIndents = keyRows.map((row) => row.indent).filter((indent) => indent > 0);
  const baseIndent = positiveIndents.length ? Math.min(...positiveIndents) : 1;
  const output = [`## ${humanizeKey(root[1])}`];
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const indent = line.length - line.trimStart().length;
    const stripped = line.trim();
    const field = stripped.match(/^(?:-\s*)?([a-z][a-z0-9_]*):\s*(.*)$/);
    const item = stripped.match(/^-\s*(.*)$/);
    if (field) {
      const [, key, rawContent] = field;
      const content = unquote(rawContent);
      if (indent === 0 && key === "final_answer") {
        output.push("", "### Recommended starting point", "", content);
      } else if (indent <= baseIndent && !content) {
        output.push("", `### ${humanizeKey(key)}`);
      } else if (indent <= baseIndent) {
        output.push("", `**${humanizeKey(key)}:** ${content}`);
      } else if (!content) {
        output.push("", `#### ${humanizeKey(key)}`);
      } else if (stripped.startsWith("-")) {
        output.push("", `- **${humanizeKey(key)}:** ${content}`);
      } else {
        output.push("", `**${humanizeKey(key)}:** ${content}`);
      }
    } else if (item) {
      output.push("", `- ${unquote(item[1])}`);
    } else {
      output.push("", stripped);
    }
  }
  return output.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function markdownFromStructuredValue(name, value, depth = 2) {
  const heading = "#".repeat(Math.max(2, Math.min(depth, 4)));
  const lines = [`${heading} ${humanizeKey(name)}`];
  if (Array.isArray(value)) {
    for (const item of value) {
      if (item && typeof item === "object" && !Array.isArray(item)) {
        const scalars = Object.entries(item).filter(([, child]) => !child || typeof child !== "object");
        if (scalars.length) lines.push("", `- ${scalars.map(([key, child]) => `**${humanizeKey(key)}:** ${String(child)}`).join(" · ")}`);
        for (const [key, child] of Object.entries(item).filter(([, nested]) => nested && typeof nested === "object")) {
          lines.push("", ...markdownFromStructuredValue(key, child, depth + 1));
        }
      } else {
        lines.push("", `- ${String(item ?? "Not specified")}`);
      }
    }
    return lines;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (child && typeof child === "object") lines.push("", ...markdownFromStructuredValue(key, child, depth + 1));
      else lines.push("", `**${humanizeKey(key)}:** ${String(child ?? "Not specified")}`);
    }
    return lines;
  }
  lines.push("", String(value ?? "Not specified"));
  return lines;
}

function formatJsonEnvelope(value) {
  const match = value.match(/^([a-z][a-z0-9_]*):\s*(\{[\s\S]*\})$/);
  if (!match || !SCHEMA_ROOT_SUFFIX.test(match[1])) return "";
  try {
    const parsed = JSON.parse(match[2]);
    return markdownFromStructuredValue(match[1], parsed).join("\n").replace(/\n{3,}/g, "\n\n").trim();
  } catch {
    return "";
  }
}

/**
 * Older coordinator completions sometimes copied the typed handoff schema into
 * DOMAIN_ANSWER as one line of YAML-like text. Keep the stored bytes intact,
 * but present that narrow legacy shape as ordinary readable Markdown.
 */
export function formatStructuredAssistantAnswer(text) {
  const value = String(text || "").replace(/\r\n?/g, "\n").trim();
  if (!value || value.includes("```")) return value;
  const jsonEnvelope = formatJsonEnvelope(value);
  if (jsonEnvelope) return jsonEnvelope;
  const multiline = formatMultilineEnvelope(value);
  if (multiline) return multiline;
  const fields = structuredFields(value);
  const first = fields[0];
  const looksLikeEnvelope = (
    value.split("\n").length <= 3
    && fields.length >= 5
    && first?.key
    && SCHEMA_ROOT_SUFFIX.test(first.key)
    && fields.some((field) => STRUCTURED_PRIORITY_KEYS.has(field.key))
  );
  if (!looksLikeEnvelope) return value;

  const lines = [`## ${humanizeKey(first.key)}`];
  const sourceBySection = new Map();
  let activeSection = "";
  for (const field of fields.slice(1)) {
    const content = unquote(field.value);
    if (field.key === "source") {
      if (activeSection) sourceBySection.set(activeSection, content);
      continue;
    }
    if (field.key === "artifact") {
      // The route reference carries the same producer and opens the richer
      // specialist result. Avoid showing a second implementation identifier.
      continue;
    }
    if (field.key === "reference") {
      if (content) lines.push(`\nSource: ${content}`);
      continue;
    }
    if (field.key === "executive_summary") {
      lines.push("\n### Overview", ...(content ? [`\n${content}`] : []));
      activeSection = field.key;
      continue;
    }
    if (field.key === "final_answer") {
      lines.push("\n### Recommended starting point", ...(content ? [`\n${content}`] : []));
      activeSection = field.key;
      continue;
    }
    if (field.key === "next_actions") {
      const items = listItems(field.value);
      lines.push("\n### Next actions", "", ...(items.length ? items.map((item) => `- ${item}`) : [content]));
      activeSection = field.key;
      continue;
    }
    if (field.key === "summary") {
      if (content) lines.push(`\n${content}`);
      continue;
    }
    if (STRUCTURED_METADATA_KEYS.has(field.key)) continue;
    activeSection = field.key;
    lines.push(`\n### ${humanizeKey(field.key)}`, ...(content ? [`\n${content}`] : []));
    const source = sourceBySection.get(field.key);
    if (source) lines.push(`\nSource: ${source}`);
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function compactPlainText(value, limit = 240) {
  const text = String(value ?? "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[*_#>`]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit).replace(/\s+\S*$/, "").trim()}…`;
}

function agentTitle(agentId, agents) {
  const agent = (agents || []).find((item) => item.id === agentId);
  return String(agent?.title || agentId || "Specialist")
    .replace(/_lora$/i, "")
    .replace(/^custom_[a-z0-9]+_/i, "")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function artifactValueSummary(artifact, route) {
  if (route?.domain_answer) {
    return compactPlainText(formatStructuredAssistantAnswer(route.domain_answer));
  }
  const value = artifact?.value;
  if (typeof value === "string") return compactPlainText(value);
  if (value && typeof value === "object") return compactPlainText(JSON.stringify(value));
  return "";
}

function makeReference({ kind, token = "", route = null, artifact = null, source = null, agents = [] }) {
  const agentId = String(route?.adapter || artifact?.producer || "");
  const title = source?.title || agentTitle(agentId, agents);
  const artifactName = artifact?.name || artifact?.artifact || "";
  return {
    kind,
    token,
    stepId: String(route?.step_id || route?.id || artifact?.producer_step_id || ""),
    agentId,
    title,
    label: title,
    detail: source
      ? [source.page ? `Page ${source.page}` : "", source.document_title || ""].filter(Boolean).join(" · ") || "Document source"
      : artifactName
        ? humanizeKey(artifactName)
        : "Specialist contribution",
    summary: source?.excerpt
      ? compactPlainText(source.excerpt)
      : artifact
        ? artifactValueSummary(artifact, route)
        : compactPlainText(route?.domain_answer || route?.task),
    source,
    artifact
  };
}

function escapePattern(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeMarkdownLabel(value) {
  return String(value || "Source")
    .replaceAll("\\", "\\\\")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]");
}

function codeAwareReplace(value, replacer) {
  const code = /(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`+[^`\n]*`+)/g;
  let cursor = 0;
  let output = "";
  for (const match of value.matchAll(code)) {
    output += replacer(value.slice(cursor, match.index));
    output += match[0];
    cursor = match.index + match[0].length;
  }
  return output + replacer(value.slice(cursor));
}

/** Build a private implementation-id → user-facing source index for one run. */
export function answerProvenanceIndex(run, agents = []) {
  const exact = new Map();
  const routePrefixes = [];
  if (run?.query) {
    routePrefixes.push({
      prefix: "query:",
      reference: {
        kind: "request",
        token: "",
        stepId: "",
        agentId: "",
        title: "Your request",
        label: "Your request",
        detail: "Conversation context",
        summary: compactPlainText(run.query),
        source: null,
        artifact: null
      }
    });
  }
  for (const route of run?.expert_outputs || []) {
    const stepId = String(route?.step_id || route?.id || "");
    if (stepId) {
      routePrefixes.push({
        prefix: `route:${stepId}:`.toLowerCase(),
        reference: makeReference({ kind: "agent", route, agents })
      });
    }
    for (const artifact of route?.handoff_artifacts || []) {
      const token = String(artifact?.artifact_id || "");
      if (token) exact.set(token.toLowerCase(), makeReference({ kind: "artifact", token, route, artifact, agents }));
    }
  }
  for (const source of run?.sources || []) {
    const token = String(source?.chunk_id || source?.citation_id || "");
    if (token) exact.set(token.toLowerCase(), makeReference({ kind: "document", token, source, agents }));
  }
  return { exact, routePrefixes };
}

export function answerContributorReferences(run, agents = []) {
  return (run?.expert_outputs || [])
    .filter((route) => String(route?.domain_answer || "").trim())
    .map((route, index) => ({
      ...makeReference({ kind: "agent", route, agents }),
      id: `answer-contributor-${index + 1}`
    }));
}

function resolveReference(token, index) {
  const normalized = String(token || "").toLowerCase();
  const exact = index.exact.get(normalized);
  if (exact) return { ...exact, token };
  const route = index.routePrefixes.find((item) => normalized.startsWith(item.prefix));
  return route ? { ...route.reference, token } : null;
}

/**
 * Convert verified runtime/document identifiers into accessible inline source
 * controls. The returned hrefs are local-only handles consumed by FormattedText.
 */
export function prepareAssistantAnswer(text, run, agents = []) {
  const formatted = formatStructuredAssistantAnswer(text);
  const index = answerProvenanceIndex(run, agents);
  const exactTokens = [...index.exact.keys()].sort((left, right) => right.length - left.length);
  const routePatterns = index.routePrefixes.map(({ prefix }) => `${escapePattern(prefix)}[a-z0-9._-]+`);
  const alternatives = [...exactTokens.map(escapePattern), ...routePatterns];
  const normalizedInput = String(text || "").replace(/\r\n?/g, "\n").trim();
  const attributionItems = (
    formatted === normalizedInput
    && run?.answer_attributions?.contract_version === "public-answer-attributions-v1"
    && Array.isArray(run.answer_attributions.items)
  )
    ? run.answer_attributions.items
    : [];
  if (!alternatives.length && !attributionItems.length) {
    return { markdown: formatted, references: new Map() };
  }

  const references = new Map();
  const keysBySource = new Map();
  let sequence = 0;

  const registerReference = (reference) => {
    const sourceKey = [reference.kind, reference.stepId, reference.agentId, reference.source?.chunk_id || "", reference.artifact?.name || ""].join(":");
    let key = keysBySource.get(sourceKey);
    if (!key) {
      sequence += 1;
      key = `answer-source-${sequence}`;
      keysBySource.set(sourceKey, key);
      references.set(`#${key}`, { ...reference, id: key });
    }
    return `[${escapeMarkdownLabel(reference.label)}](#${key})`;
  };

  const routeByStep = new Map((run?.expert_outputs || []).flatMap((route) => {
    const stepId = String(route?.step_id || route?.id || "");
    return stepId ? [[stepId, route]] : [];
  }));
  const insertions = new Map();
  for (const item of attributionItems) {
    const start = Number(item?.start);
    const end = Number(item?.end);
    const stepId = String(item?.step_id || "");
    const agentId = String(item?.agent_id || "");
    const route = routeByStep.get(stepId);
    if (
      !Number.isSafeInteger(start)
      || !Number.isSafeInteger(end)
      || start < 0
      || end <= start
      || end > formatted.length
      || !formatted.slice(start, end).trim()
      || !route
      || String(route.adapter || "") !== agentId
    ) {
      continue;
    }
    const reference = makeReference({ kind: "agent", route, agents });
    const link = registerReference(reference);
    const existing = insertions.get(end) || [];
    if (!existing.includes(link)) existing.push(link);
    insertions.set(end, existing);
  }

  let markdown = formatted;
  for (const [offset, links] of [...insertions.entries()].sort((left, right) => right[0] - left[0])) {
    markdown = `${markdown.slice(0, offset)} ${links.join(" ")}${markdown.slice(offset)}`;
  }

  if (alternatives.length) {
    const tokenPattern = alternatives.join("|");
    const matcher = new RegExp(`\\[(${tokenPattern})\\]|["'](${tokenPattern})["']|(${tokenPattern})`, "gi");
    markdown = codeAwareReplace(markdown, (segment) => segment.replace(matcher, (_match, bracketed, quoted, bare) => {
      const token = bracketed || quoted || bare;
      const reference = resolveReference(token, index);
      return reference ? registerReference(reference) : _match;
    })).replace(/\bartifact\s+(?=\[[^\]]+\]\(#answer-source-)/gi, "work from ");
  }
  return { markdown, references };
}

export function copyableAssistantAnswer(text, run, agents = []) {
  return prepareAssistantAnswer(text, run, agents).markdown
    .replace(/\[([^\]]+)\]\(#answer-source-[^)]+\)/g, "$1");
}

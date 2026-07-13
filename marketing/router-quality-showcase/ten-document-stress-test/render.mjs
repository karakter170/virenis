import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { createCanvas, GlobalFonts, loadImage } from "@napi-rs/canvas";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const EVIDENCE_ROOT = path.resolve(ROOT, "../evidence/demo4");
const FINAL_FRAMES = path.join(ROOT, "frames");
const FINAL_EXPORTS = path.join(ROOT, "exports");
const FINAL_MANIFEST = path.join(ROOT, "asset-manifest.json");
const STAGE = path.join(ROOT, `.render-stage-${process.pid}`);
const STAGE_FRAMES = path.join(STAGE, "frames");
const STAGE_EXPORTS = path.join(STAGE, "exports");

const WIDTH = 1920;
const STAGE_HEIGHT = 1080;
const META_SCHEMA = "router-demo4-visual-asset-v1";
const MANIFEST_SCHEMA = "router-demo4-visual-assets-v1";
const FORBIDDEN_LABELS = [
  ["T", "C", "A", "R"].join(""),
  ["T", "C", "A", "n", "d", "o", "n"].join("")
];

const REQUIRED_EVIDENCE = [
  "router-selection-passes.json",
  "server-orchestration-request.json",
  "full-outputs.json",
  "evidence-summary.json",
  "executed-dag-response.json",
  "execution-receipt.json",
  "capture-integrity.json",
  "qualitative-audit.json",
  "fixtures/qualitative-rubric.json"
];

const C = {
  page: "#f4f7f5",
  white: "#ffffff",
  ink: "#101713",
  text: "#29342e",
  soft: "#66736c",
  faint: "#849087",
  line: "#d7e0da",
  lineStrong: "#b9c8bf",
  green: "#176b4b",
  greenDark: "#0c4f37",
  greenSoft: "#e4f3eb",
  blue: "#2867a6",
  blueSoft: "#e7f0fa",
  violet: "#6a4b9e",
  violetSoft: "#efe9fa",
  amber: "#a45d1f",
  amberSoft: "#fff0e1",
  graySoft: "#edf1ee",
  red: "#9b4848",
  redSoft: "#f9eaea"
};

GlobalFonts.registerFromPath("/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf", "Virenis Sans");
GlobalFonts.registerFromPath("/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf", "Virenis Sans Bold");
GlobalFonts.registerFromPath("/usr/share/fonts/truetype/liberation/LiberationMono-Regular.ttf", "Virenis Mono");
GlobalFonts.registerFromPath("/usr/share/fonts/truetype/liberation/LiberationMono-Bold.ttf", "Virenis Mono Bold");

const measureCanvas = createCanvas(8, 8);
const measureContext = measureCanvas.getContext("2d");

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sha256Text(value) {
  return sha256Bytes(Buffer.from(String(value), "utf8"));
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function prettyJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function esc(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function assertPublicText(value, label) {
  const text = String(value);
  for (const prohibited of FORBIDDEN_LABELS) {
    if (text.toLowerCase().includes(prohibited.toLowerCase())) {
      throw new Error(`${label} contains a forbidden internal architecture label.`);
    }
  }
}

function rect(x, y, width, height, { fill = C.white, stroke = C.line, radius = 18, strokeWidth = 1 } = {}) {
  return `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${radius}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}"/>`;
}

function line(x1, y1, x2, y2, color = C.lineStrong, width = 2, marker = "") {
  return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="${width}"${marker ? ` marker-end="url(#${marker})"` : ""}/>`;
}

function fontString(size, family, bold = false) {
  const resolved = bold ? `${family} Bold` : family;
  return `${size}px "${resolved}"`;
}

function wrapMeasured(value, maxWidth, { size = 20, family = "Virenis Sans", bold = false } = {}) {
  measureContext.font = fontString(size, family, bold);
  const output = [];
  for (const paragraph of String(value ?? "").split("\n")) {
    if (!paragraph) {
      output.push("");
      continue;
    }
    const words = paragraph.split(/\s+/).filter(Boolean);
    let current = "";
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (!current || measureContext.measureText(candidate).width <= maxWidth) {
        current = candidate;
      } else {
        output.push(current);
        current = word;
      }
    }
    if (current) output.push(current);
  }
  return output;
}

function textLines(x, y, lines, {
  size = 20,
  color = C.text,
  family = "Virenis Sans",
  bold = false,
  lineHeight = 1.25,
  anchor = "start",
  preserve = false,
  letterSpacing = 0
} = {}) {
  const fontFamily = bold ? `${family} Bold` : family;
  const step = size * lineHeight;
  const space = preserve ? ' xml:space="preserve"' : "";
  return `<text x="${x}" y="${y}" fill="${color}" font-family="${fontFamily}" font-size="${size}" text-anchor="${anchor}" letter-spacing="${letterSpacing}"${space}>${lines.map((entry, index) => `<tspan x="${x}" dy="${index === 0 ? 0 : step}"${space}>${esc(entry)}</tspan>`).join("")}</text>`;
}

function textBlock(x, y, value, options = {}) {
  const lines = wrapMeasured(value, options.maxWidth ?? 720, options);
  return textLines(x, y, lines, options);
}

function pill(x, y, label, { width = 150, fill = C.greenSoft, color = C.green, stroke = fill } = {}) {
  return `${rect(x, y, width, 34, { fill, stroke, radius: 17 })}${textLines(x + width / 2, y + 22, [String(label).toUpperCase()], { size: 12, color, family: "Virenis Mono", bold: true, anchor: "middle", letterSpacing: 0.5 })}`;
}

function svgMetadata(core) {
  return `<metadata id="evidence-metadata">${esc(stableJson(core))}</metadata>`;
}

function definitions() {
  return `<defs>
    <pattern id="dots" width="24" height="24" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="1" fill="#d6dfd9"/></pattern>
    <marker id="arrow" markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto"><path d="M0,0 L10,5 L0,10 Z" fill="#83968c"/></marker>
    <marker id="arrowGreen" markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto"><path d="M0,0 L10,5 L0,10 Z" fill="${C.green}"/></marker>
  </defs>`;
}

function stageShell(core, { count, title, subtitle, body, proof }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${STAGE_HEIGHT}" viewBox="0 0 ${WIDTH} ${STAGE_HEIGHT}">
    ${svgMetadata(core)}${definitions()}
    <rect width="${WIDTH}" height="${STAGE_HEIGHT}" fill="${C.page}"/>
    <rect x="1480" y="0" width="440" height="1080" fill="url(#dots)" opacity="0.5"/>
    <circle cx="1790" cy="30" r="245" fill="${C.greenSoft}"/>
    <circle cx="1825" cy="1040" r="190" fill="${C.violetSoft}"/>
    ${textLines(82, 62, ["Virenis"], { size: 29, color: C.ink, bold: true })}
    ${textLines(1838, 60, [`TEN-DOCUMENT STRESS TEST · ${count}`], { size: 13, color: C.faint, family: "Virenis Mono", bold: true, anchor: "end", letterSpacing: 0.7 })}
    ${line(82, 88, 1838, 88, C.lineStrong, 1)}
    ${textLines(82, 150, [title], { size: 48, color: C.ink, bold: true })}
    ${textBlock(84, 188, subtitle, { size: 19, color: C.soft, maxWidth: 1620, lineHeight: 1.2 })}
    ${body}
    ${line(82, 1004, 1838, 1004, C.lineStrong, 1)}
    ${textLines(82, 1038, ["Observable route and captured evidence — not private chain-of-thought"], { size: 13, color: C.faint, family: "Virenis Mono" })}
    ${textLines(1838, 1038, [proof], { size: 13, color: C.green, family: "Virenis Mono", bold: true, anchor: "end" })}
  </svg>`;
}

function didsFromAgents(agents) {
  return (agents ?? []).map((agent) => String(agent).match(/\bD(?:0[1-9]|10)\b/i)?.[0]?.toUpperCase()).filter(Boolean);
}

function routeFrame(core, evidence) {
  const passes = evidence.selections.passes;
  const receiptHash = evidence.receipt.receipt_hash;
  const checks = evidence.summary.router_trace_checks;
  const passCards = passes.map((pass, index) => {
    const x = 82 + index * 438;
    const ids = didsFromAgents(pass.selected_agents);
    const badges = ids.map((id, badgeIndex) => pill(x + 22 + badgeIndex * 96, 420, id, { width: 78, fill: C.white, color: C.green, stroke: C.white })).join("");
    return `${rect(x, 358, 402, 174, { fill: C.greenSoft, stroke: "#9fc9b5", radius: 20 })}
      ${pill(x + 20, 376, `Router pass ${pass.pass}`, { width: 150 })}
      ${badges}
      ${textLines(x + 22, 490, ["Every candidate selected"], { size: 16, color: C.greenDark, bold: true })}
      ${line(x + 201, 532, x + 201, 596, C.green, 2, "arrowGreen")}`;
  }).join("");
  const promptLines = wrapMeasured(evidence.selections.user_prompt, 1688, { size: 17, family: "Virenis Sans", bold: true });
  if (promptLines.length > 3) throw new Error("The Demo 4 prompt no longer fits the route frame without truncation.");
  const allSourcesValid = Object.values(checks.source_agents ?? {}).every((row) => row?.source_validation_valid === true && row?.unique_handoff_present === true);
  const body = `${rect(82, 224, 1756, 104, { fill: C.white, stroke: C.lineStrong, radius: 18 })}
    ${pill(104, 242, "User prompt", { width: 126, fill: C.graySoft, color: C.soft, stroke: C.graySoft })}
    ${textLines(250, 263, promptLines, { size: 17, color: C.ink, bold: true, lineHeight: 1.2 })}
    ${passCards}
    ${rect(240, 606, 1440, 92, { fill: C.white, stroke: C.green, radius: 20, strokeWidth: 2 })}
    ${pill(264, 624, "Selected union", { width: 152 })}
    ${textLines(446, 650, ["D01–D10 · ten distinct source agents · no deterministic fill"], { size: 25, color: C.greenDark, bold: true })}
    ${line(960, 698, 960, 754, C.green, 3, "arrowGreen")}
    ${rect(480, 764, 960, 138, { fill: C.greenDark, stroke: C.greenDark, radius: 22 })}
    ${pill(504, 784, "Server workflow", { width: 166, fill: C.white, color: C.greenDark, stroke: C.white })}
    ${textLines(504, 844, ["Analysis Agent"], { size: 31, color: C.white, bold: true })}
    ${textLines(790, 842, ["Consumes ten exact handoffs · compiled with ten dependencies"], { size: 19, color: "#d3ecdf", bold: true })}
    ${rect(82, 764, 354, 138, { fill: allSourcesValid ? C.blueSoft : C.redSoft, stroke: allSourcesValid ? C.blue : C.red, radius: 20 })}
    ${textLines(104, 800, ["SOURCE PROOF"], { size: 12, color: allSourcesValid ? C.blue : C.red, family: "Virenis Mono", bold: true })}
    ${textBlock(104, 840, allSourcesValid ? "Citations and unique handoffs validated for every source." : "Source validation is incomplete.", { size: 18, color: C.ink, bold: true, maxWidth: 308, lineHeight: 1.2 })}
    ${rect(1484, 764, 354, 138, { fill: C.violetSoft, stroke: C.violet, radius: 20 })}
    ${textLines(1506, 800, ["EXECUTION RECEIPT"], { size: 12, color: C.violet, family: "Virenis Mono", bold: true })}
    ${textLines(1506, 842, [receiptHash.slice(0, 24)], { size: 18, color: C.ink, family: "Virenis Mono", bold: true })}
    ${textLines(1506, 874, ["Completed run"], { size: 15, color: C.soft, bold: true })}`;
  return stageShell(core, {
    count: "07 / 10",
    title: "Ten documents. Four bounded Router passes. One fan-in.",
    subtitle: "Each source keeps its own evidence boundary. The server appends the downstream Analysis Agent only after the Router-selected union is complete.",
    body,
    proof: "CAPTURED RUN · RECEIPT RECORDED"
  });
}

function ratingPill(x, y, rating) {
  const styles = {
    meets: { fill: C.greenSoft, color: C.green, stroke: "#9fc9b5" },
    needs_revision: { fill: C.amberSoft, color: C.amber, stroke: "#ddba94" },
    fails: { fill: C.redSoft, color: C.red, stroke: "#ddb1b1" }
  };
  const style = styles[rating];
  if (!style) throw new Error(`Unsupported qualitative rating: ${rating}`);
  return pill(x, y, rating.replaceAll("_", " "), { width: 164, ...style });
}

function firstAuditEvidence(dimensions, side) {
  for (const dimension of dimensions) {
    const rows = dimension?.[side]?.evidence;
    if (Array.isArray(rows) && typeof rows[0]?.excerpt === "string" && rows[0].excerpt) {
      return { dimension: dimension.label, ...rows[0] };
    }
  }
  throw new Error(`Qualitative audit has no captured-output excerpt for ${side}.`);
}

function auditSnippetCard(x, y, width, label, accent, snippet) {
  const excerptLines = losslessLayout(snippet.excerpt, 82);
  if (excerptLines.length > 4) throw new Error(`${label} qualitative evidence excerpt is too long for frame 08 without truncation.`);
  return `${rect(x, y, width, 144, { fill: C.white, stroke: accent, radius: 18 })}
    ${textLines(x + 20, y + 28, [label.toUpperCase()], { size: 11, color: accent, family: "Virenis Mono", bold: true, letterSpacing: 0.5 })}
    ${textLines(x + width - 20, y + 28, [String(snippet.dimension).toUpperCase()], { size: 10, color: C.faint, family: "Virenis Mono", anchor: "end" })}
    ${textLines(x + 20, y + 58, excerptLines, { size: 16, color: C.ink, family: "Virenis Mono", lineHeight: 1.22, preserve: true })}`;
}

function comparisonFrame(core, evidence) {
  const { full, receipt, audit } = evidence;
  const contract = full.comparison_contract;
  const dimensions = audit.dimensions;
  if (dimensions.length > 7) throw new Error("Frame 08 supports the frozen seven-dimension qualitative rubric only.");
  const baseSnippet = firstAuditEvidence(dimensions, "base_model");
  const routerSnippet = firstAuditEvidence(dimensions, "router");
  const rows = dimensions.map((dimension, index) => {
    const y = 390 + index * 48;
    return `${index % 2 === 0 ? rect(100, y - 28, 1720, 45, { fill: C.graySoft, stroke: C.graySoft, radius: 8 }) : ""}
      ${textLines(120, y, [dimension.label], { size: 17, color: C.ink, bold: true })}
      ${ratingPill(864, y - 25, dimension.base_model.rating)}
      ${ratingPill(1264, y - 25, dimension.router.rating)}`;
  }).join("");
  const body = `${rect(82, 226, 1756, 88, { fill: C.white, stroke: C.lineStrong, radius: 18 })}
    ${pill(104, 252, "Comparison contract", { width: 190, fill: C.graySoft, color: C.soft, stroke: C.graySoft })}
    ${textLines(324, 274, [contract.same_user_prompt && contract.judge_files_withheld_from_both_paths ? "Same user prompt · same canonical D01–D10 documents · judge files withheld" : "Comparison contract incomplete"], { size: 19, color: C.ink, bold: true })}
    ${textLines(120, 350, ["QUALITATIVE DIMENSION"], { size: 11, color: C.faint, family: "Virenis Mono", bold: true })}
    ${textLines(946, 350, ["BASE MODEL"], { size: 11, color: C.soft, family: "Virenis Mono", bold: true, anchor: "middle" })}
    ${textLines(1346, 350, ["ROUTER"], { size: 11, color: C.green, family: "Virenis Mono", bold: true, anchor: "middle" })}
    ${rows}
    ${auditSnippetCard(82, 744, 850, "Base · captured evidence", C.soft, baseSnippet)}
    ${auditSnippetCard(988, 744, 850, "Router · captured evidence", C.green, routerSnippet)}
    ${rect(82, 908, 1756, 46, { fill: C.violetSoft, stroke: C.violetSoft, radius: 12 })}
    ${textLines(104, 938, ["AUDIT-PROVIDED RATINGS · NO NUMERIC AGGREGATE"], { size: 12, color: C.violet, family: "Virenis Mono", bold: true })}
    ${textLines(1816, 938, [`Receipt ${receipt.receipt_hash.slice(0, 18)}`], { size: 12, color: C.faint, family: "Virenis Mono", anchor: "end" })}`;
  return stageShell(core, {
    count: "08 / 10",
    title: "The quality comparison is tied to captured text.",
    subtitle: "Per-dimension outcomes and excerpts come directly from the qualitative audit of this one synthetic fixture; no numeric aggregate is used.",
    body,
    proof: "ILLUSTRATIVE FIXTURE · FULL OUTPUTS ATTACHED"
  });
}

function wrapExactLine(line, maxColumns) {
  const characters = Array.from(line);
  if (characters.length === 0) return [""];
  const segments = [];
  let rest = characters;
  while (rest.length > maxColumns) {
    const candidate = rest.slice(0, maxColumns + 1).lastIndexOf(" ");
    const split = candidate >= Math.floor(maxColumns * 0.55) ? candidate + 1 : maxColumns;
    segments.push(rest.slice(0, split).join(""));
    rest = rest.slice(split);
  }
  segments.push(rest.join(""));
  return segments;
}

function losslessLayout(answer, maxColumns) {
  const sourceLines = String(answer).split("\n");
  const visualLines = [];
  const groups = [];
  for (const sourceLine of sourceLines) {
    const segments = wrapExactLine(sourceLine, maxColumns);
    visualLines.push(...segments);
    groups.push(segments);
  }
  const reconstructed = groups.map((segments) => segments.join("")).join("\n");
  if (reconstructed !== answer) throw new Error("Full-output layout changed captured answer characters.");
  return visualLines;
}

function fullOutputFrame(core, { side, answer, answerSha256, sourcePointer }) {
  const computed = sha256Text(answer);
  if (computed !== answerSha256) throw new Error(`${side} answer SHA-256 does not match full-outputs.json.`);
  assertPublicText(answer, `${side} full answer`);
  const fontSize = 23;
  const lineStep = 32;
  const lines = losslessLayout(answer, 120);
  const top = 326;
  const outputHeight = Math.max(560, lines.length * lineStep + 74);
  const height = top + outputHeight + 126;
  core.height = height;
  core.answer_sha256 = answerSha256;
  core.source_json_pointer = sourcePointer;
  const accent = side === "Base model" ? C.soft : C.green;
  const tint = side === "Base model" ? C.graySoft : C.greenSoft;
  const body = `${rect(76, 204, 1768, 92, { fill: tint, stroke: accent, radius: 18 })}
    ${pill(100, 232, "Unabridged capture", { width: 182, fill: C.white, color: accent, stroke: C.white })}
    ${textLines(314, 255, [`${answer.length} characters · SHA-256 ${answerSha256}`], { size: 15, color: C.ink, family: "Virenis Mono", bold: true })}
    ${rect(76, top, 1768, outputHeight, { fill: C.white, stroke: C.lineStrong, radius: 18 })}
    ${textLines(108, top + 48, lines, { size: fontSize, color: C.ink, family: "Virenis Mono", lineHeight: lineStep / fontSize, preserve: true })}
    ${line(76, top + outputHeight + 48, 1844, top + outputHeight + 48, C.lineStrong, 1)}
    ${textLines(76, top + outputHeight + 84, ["END OF CAPTURED ANSWER"], { size: 13, color: accent, family: "Virenis Mono", bold: true })}
    ${textLines(1844, top + outputHeight + 84, [answerSha256], { size: 12, color: C.faint, family: "Virenis Mono", anchor: "end" })}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}">
    ${svgMetadata(core)}${definitions()}
    <rect width="${WIDTH}" height="${height}" fill="${C.page}"/>
    <rect x="1510" y="0" width="410" height="${height}" fill="url(#dots)" opacity="0.32"/>
    ${textLines(76, 64, ["Virenis"], { size: 29, color: C.ink, bold: true })}
    ${textLines(1844, 62, [`TEN-DOCUMENT STRESS TEST · ${core.frame_number} / 10`], { size: 13, color: C.faint, family: "Virenis Mono", bold: true, anchor: "end" })}
    ${line(76, 90, 1844, 90, C.lineStrong, 1)}
    ${textLines(76, 150, [`${side} · full captured output`], { size: 46, color: C.ink, bold: true })}
    ${textLines(78, 184, ["Every captured character is rendered. No editorial rewrite, crop, or omission."], { size: 18, color: C.soft })}
    ${body}
  </svg>`;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngTextChunk(keyword, value) {
  if (!/^[\x20-\x7e]{1,79}$/.test(keyword)) throw new Error(`Invalid PNG metadata keyword: ${keyword}`);
  const type = Buffer.from("tEXt", "ascii");
  const data = Buffer.concat([Buffer.from(keyword, "latin1"), Buffer.from([0]), Buffer.from(String(value), "latin1")]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([type, data])));
  return Buffer.concat([length, type, data, checksum]);
}

function injectPngMetadata(png, metadata) {
  const signature = png.subarray(0, 8);
  if (!signature.equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error("Canvas did not produce a PNG file.");
  const ihdrLength = png.readUInt32BE(8);
  const ihdrEnd = 8 + 12 + ihdrLength;
  const chunks = Object.entries(metadata).map(([key, value]) => pngTextChunk(key, value));
  return Buffer.concat([png.subarray(0, ihdrEnd), ...chunks, png.subarray(ihdrEnd)]);
}

async function rasterize(svg, width, height, output, metadata) {
  const image = await loadImage(Buffer.from(svg, "utf8"));
  const canvas = createCanvas(width, height);
  canvas.getContext("2d").drawImage(image, 0, 0, width, height);
  const encoded = canvas.toBuffer("image/png");
  await writeFile(output, injectPngMetadata(encoded, metadata));
}

async function readEvidenceFile(relativePath) {
  const absolute = path.join(EVIDENCE_ROOT, relativePath);
  const raw = await readFile(absolute);
  return {
    relativePath: `../evidence/demo4/${relativePath}`,
    raw,
    sha256: sha256Bytes(raw),
    json: JSON.parse(raw.toString("utf8"))
  };
}

async function evidenceAvailability() {
  const loaded = new Map();
  const missing = [];
  for (const relativePath of REQUIRED_EVIDENCE) {
    try {
      loaded.set(relativePath, await readEvidenceFile(relativePath));
    } catch (error) {
      if (error?.code === "ENOENT") missing.push(relativePath);
      else throw error;
    }
  }
  return { loaded, missing };
}

function evidenceSources(loaded, names) {
  return names.map((name) => {
    const entry = loaded.get(name);
    if (!entry) throw new Error(`Required evidence was not loaded: ${name}`);
    return { path: entry.relativePath, sha256: entry.sha256 };
  }).sort((left, right) => left.path.localeCompare(right.path));
}

function evidenceBundleSha256(sources) {
  return sha256Text([...sources].sort((left, right) => left.path.localeCompare(right.path)).map((row) => `${row.path}\0${row.sha256}`).join("\n"));
}

function evidenceCore({ assetId, frameNumber, width, height, presentation, unabridged, sources, sourcePointer, answerSha256 }) {
  return {
    schema_version: META_SCHEMA,
    asset_id: assetId,
    frame_number: frameNumber,
    width,
    height,
    presentation,
    unabridged,
    evidence_sources: sources,
    evidence_bundle_sha256: evidenceBundleSha256(sources),
    ...(sourcePointer ? { source_json_pointer: sourcePointer } : {}),
    ...(answerSha256 ? { answer_sha256: answerSha256 } : {})
  };
}

function pngMetadata(core) {
  return {
    "Schema-Version": META_SCHEMA,
    "Asset-ID": core.asset_id,
    "Evidence-SHA256": core.evidence_bundle_sha256,
    "Unabridged": String(core.unabridged),
    "Width": String(core.width),
    "Height": String(core.height),
    ...(core.answer_sha256 ? { "Answer-SHA256": core.answer_sha256 } : {}),
    ...(core.source_json_pointer ? { "Source-JSON-Pointer": core.source_json_pointer } : {})
  };
}

function validateEvidence(evidence) {
  const { selections, orchestration, full, summary, execution, receipt, integrity, rubric, audit } = evidence;
  if (summary.capture_status !== "passed") throw new Error("Demo 4 evidence-summary.json is not a passing capture.");
  if (selections.pass_count !== 4 || selections.deterministic_fill_used !== false || selections.analysis_agent_selected_by_router !== false) {
    throw new Error("Router selection evidence does not satisfy the four-pass no-fill contract.");
  }
  if (!Array.isArray(selections.selected_union) || new Set(selections.selected_union).size !== 10) throw new Error("Router selected union is not ten unique sources.");
  if (orchestration.user_supplied_plan !== false || !Array.isArray(orchestration.source_steps) || orchestration.source_steps.length !== 10) {
    throw new Error("Server orchestration evidence is incomplete.");
  }
  if (!full?.base?.answer || !full?.router?.full_answer) throw new Error("Full captured outputs are missing.");
  if (full.base.unabridged !== true || full.router.unabridged !== true) throw new Error("Full-output evidence is not marked unabridged.");
  if (sha256Text(full.base.answer) !== full.base.answer_sha256) throw new Error("Base full-output digest mismatch.");
  if (sha256Text(full.router.full_answer) !== full.router.full_answer_sha256) throw new Error("Router full-output digest mismatch.");
  if (receipt.status !== "completed" || !receipt.receipt_hash) throw new Error("Completed execution receipt is missing.");
  if (!Array.isArray(execution?.plan?.steps) || execution.plan.steps.length !== 11) throw new Error("Executed route does not contain eleven agents.");
  if (!integrity?.captures?.["full-outputs"] || !Array.isArray(rubric?.dimensions)) throw new Error("Capture integrity or qualitative rubric is incomplete.");
  if (!audit || !Array.isArray(audit.dimensions) || audit.dimensions.length !== rubric.dimensions.length) throw new Error("Qualitative audit is missing rubric dimensions.");
  for (const dimension of audit.dimensions) {
    for (const side of ["base_model", "router"]) {
      if (!["meets", "needs_revision", "fails"].includes(dimension?.[side]?.rating)) throw new Error(`Qualitative audit has an invalid ${side} rating.`);
    }
  }
  assertPublicText(stableJson(evidence), "Demo 4 public evidence");
}

async function renderAsset({ name, core, svg }) {
  assertPublicText(svg, name);
  const svgPath = path.join(STAGE_FRAMES, `${name}.svg`);
  const pngPath = path.join(STAGE_EXPORTS, `${name}.png`);
  await writeFile(svgPath, svg);
  const metadata = pngMetadata(core);
  await rasterize(svg, core.width, core.height, pngPath, metadata);
  const svgBytes = await readFile(svgPath);
  const pngBytes = await readFile(pngPath);
  return {
    ...core,
    svg_path: `frames/${name}.svg`,
    png_path: `exports/${name}.png`,
    svg_sha256: sha256Bytes(svgBytes),
    png_sha256: sha256Bytes(pngBytes),
    png_metadata: metadata
  };
}

async function promote(files) {
  await mkdir(FINAL_FRAMES, { recursive: true });
  await mkdir(FINAL_EXPORTS, { recursive: true });
  for (const asset of files) {
    const svgTarget = path.join(ROOT, asset.svg_path);
    const pngTarget = path.join(ROOT, asset.png_path);
    await rm(svgTarget, { force: true });
    await rm(pngTarget, { force: true });
    await rename(path.join(STAGE, asset.svg_path), svgTarget);
    await rename(path.join(STAGE, asset.png_path), pngTarget);
  }
  await rm(FINAL_MANIFEST, { force: true });
  await rename(path.join(STAGE, "asset-manifest.json"), FINAL_MANIFEST);
}

async function main() {
  const { loaded, missing } = await evidenceAvailability();
  const checkOnly = process.argv.includes("--check");
  if (missing.length) {
    process.stdout.write(`${prettyJson({ ready: false, missing_evidence: missing, assets_written: false })}`);
    if (!checkOnly) process.exitCode = 2;
    return;
  }

  const evidence = {
    selections: loaded.get("router-selection-passes.json").json,
    orchestration: loaded.get("server-orchestration-request.json").json,
    full: loaded.get("full-outputs.json").json,
    summary: loaded.get("evidence-summary.json").json,
    execution: loaded.get("executed-dag-response.json").json,
    receipt: loaded.get("execution-receipt.json").json,
    integrity: loaded.get("capture-integrity.json").json,
    audit: loaded.get("qualitative-audit.json").json,
    rubric: loaded.get("fixtures/qualitative-rubric.json").json
  };
  validateEvidence(evidence);
  if (checkOnly) {
    process.stdout.write(`${prettyJson({ ready: true, assets_written: false, evidence_root: EVIDENCE_ROOT })}`);
    return;
  }

  await rm(STAGE, { recursive: true, force: true });
  await mkdir(STAGE_FRAMES, { recursive: true });
  await mkdir(STAGE_EXPORTS, { recursive: true });
  try {
    const commonEvidence = ["full-outputs.json", "evidence-summary.json", "execution-receipt.json", "capture-integrity.json"];
    const routeSources = evidenceSources(loaded, ["router-selection-passes.json", "server-orchestration-request.json", "executed-dag-response.json", "execution-receipt.json", "evidence-summary.json"]);
    const comparisonSources = evidenceSources(loaded, [...commonEvidence, "qualitative-audit.json", "fixtures/qualitative-rubric.json"]);
    const fullSources = evidenceSources(loaded, ["full-outputs.json", "capture-integrity.json"]);

    const routeCore = evidenceCore({ assetId: "07-ten-document-route", frameNumber: "07", width: WIDTH, height: STAGE_HEIGHT, presentation: "16:9", unabridged: false, sources: routeSources });
    const comparisonCore = evidenceCore({ assetId: "08-ten-document-comparison", frameNumber: "08", width: WIDTH, height: STAGE_HEIGHT, presentation: "16:9", unabridged: false, sources: comparisonSources });
    const baseCore = evidenceCore({ assetId: "09-base-full-output", frameNumber: "09", width: WIDTH, height: 0, presentation: "tall-full-output", unabridged: true, sources: fullSources, sourcePointer: "/base/answer", answerSha256: evidence.full.base.answer_sha256 });
    const routerCore = evidenceCore({ assetId: "10-router-full-output", frameNumber: "10", width: WIDTH, height: 0, presentation: "tall-full-output", unabridged: true, sources: fullSources, sourcePointer: "/router/full_answer", answerSha256: evidence.full.router.full_answer_sha256 });

    const routeSvg = routeFrame(routeCore, evidence);
    const comparisonSvg = comparisonFrame(comparisonCore, evidence);
    const baseSvg = fullOutputFrame(baseCore, { side: "Base model", answer: evidence.full.base.answer, answerSha256: evidence.full.base.answer_sha256, sourcePointer: "/base/answer" });
    const routerSvg = fullOutputFrame(routerCore, { side: "Router", answer: evidence.full.router.full_answer, answerSha256: evidence.full.router.full_answer_sha256, sourcePointer: "/router/full_answer" });

    const assets = [];
    assets.push(await renderAsset({ name: "07-ten-document-route", core: routeCore, svg: routeSvg }));
    assets.push(await renderAsset({ name: "08-ten-document-comparison", core: comparisonCore, svg: comparisonSvg }));
    assets.push(await renderAsset({ name: "09-base-full-output", core: baseCore, svg: baseSvg }));
    assets.push(await renderAsset({ name: "10-router-full-output", core: routerCore, svg: routerSvg }));
    const manifest = {
      schema_version: MANIFEST_SCHEMA,
      generated_from_capture_at: evidence.full.captured_at,
      renderer: "render.mjs",
      evidence_root: "../evidence/demo4",
      assets
    };
    assertPublicText(stableJson(manifest), "asset-manifest.json");
    await writeFile(path.join(STAGE, "asset-manifest.json"), prettyJson(manifest));
    await promote(assets);
    process.stdout.write(`${prettyJson({ ready: true, assets_written: true, manifest: FINAL_MANIFEST, assets: assets.map((asset) => asset.png_path) })}`);
  } finally {
    await rm(STAGE, { recursive: true, force: true });
  }
}

await main();

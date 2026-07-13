import { Buffer } from "node:buffer";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { stdout } from "node:process";
import { fileURLToPath } from "node:url";
import { createCanvas, GlobalFonts, loadImage } from "@napi-rs/canvas";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const FRAMES = path.join(ROOT, "frames");
const EXPORTS = path.join(ROOT, "exports");
const WIDTH = 1920;
const HEIGHT = 1080;

GlobalFonts.registerFromPath("/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf", "Showcase Sans");
GlobalFonts.registerFromPath("/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf", "Showcase Sans Bold");
GlobalFonts.registerFromPath("/usr/share/fonts/truetype/liberation/LiberationMono-Regular.ttf", "Showcase Mono");

const C = {
  page: "#f7f9f7",
  white: "#ffffff",
  ink: "#131815",
  text: "#29302c",
  soft: "#68716b",
  faint: "#818b84",
  line: "#d9e1dc",
  lineStrong: "#bdc9c2",
  green: "#176b4b",
  greenDark: "#0d5339",
  greenSoft: "#e5f3ec",
  graySoft: "#eef1ef",
  purple: "#65459b",
  purpleSoft: "#f0e9fb",
  blue: "#2564a7",
  blueSoft: "#e8f1fb",
  orange: "#a8581a",
  orangeSoft: "#fff0e4",
  coral: "#9e4848",
  coralSoft: "#fbeaea",
  cyan: "#087786",
  cyanSoft: "#e3f5f7"
};

function esc(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function wrapWords(value, maxChars) {
  const lines = [];
  for (const paragraph of String(value || "").split("\n")) {
    const words = paragraph.trim().split(/\s+/).filter(Boolean);
    let line = "";
    for (const word of words) {
      if (!line) line = word;
      else if (`${line} ${word}`.length <= maxChars) line += ` ${word}`;
      else {
        lines.push(line);
        line = word;
      }
    }
    if (line) lines.push(line);
  }
  return lines;
}

function textBlock(x, y, value, {
  size = 28,
  color = C.text,
  weight = 400,
  family = "Showcase Sans",
  maxWidth = 720,
  lineHeight = 1.25,
  anchor = "start",
  maxLines = 12,
  letterSpacing = 0
} = {}) {
  const ratio = family.includes("Mono") ? 0.61 : 0.53;
  const maxChars = Math.max(4, Math.floor(maxWidth / (size * ratio)));
  let lines = wrapWords(value, maxChars);
  if (lines.length > maxLines) {
    lines = lines.slice(0, maxLines);
    lines[maxLines - 1] = `${lines[maxLines - 1].replace(/[.,;:]?$/, "")}…`;
  }
  const step = size * lineHeight;
  return `<text x="${x}" y="${y}" fill="${color}" font-family="${family}" font-size="${size}" font-weight="${weight}" text-anchor="${anchor}" letter-spacing="${letterSpacing}">${lines.map((line, index) => `<tspan x="${x}" dy="${index === 0 ? 0 : step}">${esc(line)}</tspan>`).join("")}</text>`;
}

function rect(x, y, width, height, {
  fill = C.white,
  stroke = C.line,
  radius = 18,
  strokeWidth = 1,
  opacity = 1
} = {}) {
  return `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${radius}" fill="${fill}" fill-opacity="${opacity}" stroke="${stroke}" stroke-width="${strokeWidth}"/>`;
}

function line(x1, y1, x2, y2, color = C.lineStrong, width = 2, marker = "") {
  return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="${width}" ${marker ? `marker-end="url(#${marker})"` : ""}/>`;
}

function pathLine(d, color = C.lineStrong, width = 2, marker = "") {
  return `<path d="${d}" fill="none" stroke="${color}" stroke-width="${width}" ${marker ? `marker-end="url(#${marker})"` : ""}/>`;
}

function circle(cx, cy, radius, fill, stroke = fill, strokeWidth = 0) {
  return `<circle cx="${cx}" cy="${cy}" r="${radius}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}"/>`;
}

function pill(x, y, value, {
  width,
  fill = C.greenSoft,
  color = C.green,
  border = fill,
  size = 14
} = {}) {
  const computedWidth = width || Math.max(96, value.length * size * 0.64 + 32);
  return `${rect(x, y, computedWidth, 34, { fill, stroke: border, radius: 17 })}${textBlock(x + computedWidth / 2, y + 23, value.toUpperCase(), { size, color, weight: 700, family: "Showcase Mono", maxWidth: computedWidth - 18, anchor: "middle", maxLines: 1, letterSpacing: 0.35 })}`;
}

function check(x, y, color = C.green) {
  return `<path d="M${x},${y + 7} l7,7 l14,-17" fill="none" stroke="${color}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>`;
}

function defs() {
  return `<defs>
    <pattern id="dots" width="26" height="26" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="1.15" fill="#d8e0db"/></pattern>
    <marker id="arrow" markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto"><path d="M0,0 L10,5 L0,10 Z" fill="#8ea098"/></marker>
    <marker id="arrowGreen" markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto"><path d="M0,0 L10,5 L0,10 Z" fill="${C.green}"/></marker>
  </defs>`;
}

function shell({ section, count, title, subtitle, body, proof = "CAPTURED RUN · RECEIPT RECORDED" }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
    ${defs()}
    <rect width="${WIDTH}" height="${HEIGHT}" fill="${C.page}"/>
    <rect x="1470" y="0" width="450" height="1080" fill="url(#dots)" opacity="0.5"/>
    ${circle(1755, 55, 250, C.greenSoft)}
    ${circle(1808, 1016, 212, C.purpleSoft)}
    ${textBlock(86, 68, "Virenis", { size: 29, color: C.ink, weight: 700, maxWidth: 240, maxLines: 1 })}
    ${textBlock(1834, 66, `${section.toUpperCase()} · ${count}`, { size: 14, color: C.faint, weight: 700, family: "Showcase Mono", maxWidth: 520, anchor: "end", maxLines: 1, letterSpacing: 0.8 })}
    ${line(86, 94, 1834, 94, C.lineStrong, 1)}
    ${textBlock(86, 170, title, { size: 56, color: C.ink, weight: 700, maxWidth: 1440, maxLines: 1 })}
    ${textBlock(88, 214, subtitle, { size: 20, color: C.soft, maxWidth: 1420, maxLines: 2 })}
    ${body}
    ${line(86, 1004, 1834, 1004, C.lineStrong, 1)}
    ${textBlock(86, 1039, "Observable route decisions and captured outputs — not private chain-of-thought", { size: 14, color: C.faint, family: "Showcase Mono", maxWidth: 1180, maxLines: 1 })}
    ${textBlock(1834, 1039, proof, { size: 14, color: C.green, weight: 700, family: "Showcase Mono", anchor: "end", maxWidth: 560, maxLines: 1 })}
  </svg>`;
}

function promptPanel(x, y, width, prompt) {
  return `${rect(x, y, width, 112, { fill: C.white, stroke: C.lineStrong, radius: 18 })}
    ${pill(x + 22, y + 18, "User prompt", { width: 126, fill: C.graySoft, color: C.soft, border: C.graySoft, size: 12 })}
    ${textBlock(x + 22, y + 76, prompt, { size: 20, color: C.ink, weight: 700, maxWidth: width - 44, maxLines: 2, lineHeight: 1.2 })}`;
}

function rolePanel(x, y, width, height, { title, label, detail, fill, color, artifact = "", titleSize = 28 }) {
  return `${rect(x, y, width, height, { fill, stroke: color, radius: 20 })}
    ${pill(x + 20, y + 18, label, { width: 128, fill: C.white, color, border: C.white, size: 12 })}
    ${textBlock(x + 20, y + 78, title, { size: titleSize, color, weight: 700, maxWidth: width - 40, maxLines: 1 })}
    ${textBlock(x + 20, y + 116, detail, { size: 18, color: C.text, maxWidth: width - 40, maxLines: 3, lineHeight: 1.25 })}
    ${artifact ? `${line(x + 20, y + height - 42, x + width - 20, y + height - 42, color, 1)}${textBlock(x + 20, y + height - 14, artifact, { size: 12, color, weight: 700, family: "Showcase Mono", maxWidth: width - 40, maxLines: 1 })}` : ""}`;
}

function teamRoute(data) {
  const body = `${promptPanel(86, 258, 1748, data.prompt)}
    ${pill(86, 398, "Observable decision trace", { width: 250 })}
    ${rect(86, 452, 1748, 466, { fill: C.white, stroke: C.line, radius: 24 })}
    ${rolePanel(120, 508, 348, 296, { title: "Router", label: "Selects", detail: "Selects both roles; the workflow compiler sequences their handoff.", fill: C.greenSoft, color: C.green, artifact: data.trace.router_decision })}
    ${line(468, 656, 540, 656, C.green, 3, "arrowGreen")}
    ${rolePanel(548, 508, 360, 296, { title: data.trace.first_agent, label: "Stage 1", detail: data.trace.first_action, fill: C.orangeSoft, color: C.orange, artifact: data.trace.first_artifact_label })}
    ${line(908, 656, 980, 656, C.green, 3, "arrowGreen")}
    ${rolePanel(988, 508, 360, 296, { title: data.trace.second_agent, label: "Stage 2", detail: data.trace.second_action, fill: C.blueSoft, color: C.blue, artifact: data.trace.second_artifact_label })}
    ${line(1348, 656, 1420, 656, C.green, 3, "arrowGreen")}
    ${rect(1428, 508, 372, 296, { fill: C.greenDark, stroke: C.greenDark, radius: 20 })}
    ${pill(1448, 526, "Final answer", { width: 140, fill: C.white, color: C.greenDark, border: C.white, size: 12 })}
    ${textBlock(1448, 592, data.trace.final_label, { size: 29, color: C.white, weight: 700, maxWidth: 330, maxLines: 2 })}
    ${textBlock(1448, 678, data.trace.final_detail, { size: 18, color: "#d5eee2", maxWidth: 330, maxLines: 4, lineHeight: 1.25 })}
    ${rect(120, 834, 1680, 56, { fill: C.graySoft, stroke: C.graySoft, radius: 14 })}
    ${check(142, 851)}
    ${textBlock(180, 870, data.takeaway, { size: 20, color: C.greenDark, weight: 700, maxWidth: 1580, maxLines: 1 })}`;
  return shell({ section: "Demo 1 · Agent team", count: "01 / 06", title: "One request. Two specialist roles.", subtitle: "The first agent extracts textile constraints; the second turns the verified handoff into a business plan.", body });
}

function comparisonCard(x, y, width, height, { label, route, answer, router = false }) {
  const fill = router ? C.greenSoft : C.graySoft;
  const border = router ? "#9cc8b3" : C.lineStrong;
  const accent = router ? C.green : C.soft;
  return `${rect(x, y, width, height, { fill, stroke: border, radius: 22 })}
    ${pill(x + 24, y + 22, label, { width: router ? 136 : 150, fill: C.white, color: accent, border: C.white, size: 12 })}
    ${textBlock(x + 24, y + 84, route, { size: 13, color: accent, weight: 700, family: "Showcase Mono", maxWidth: width - 48, maxLines: 1, letterSpacing: 0.25 })}
    ${textBlock(x + 24, y + 136, answer, { size: 24, color: router ? C.greenDark : C.ink, weight: 700, maxWidth: width - 48, maxLines: 7, lineHeight: 1.28 })}`;
}

function teamCompare(data) {
  const body = `${promptPanel(86, 258, 1748, data.prompt)}
    ${comparisonCard(86, 400, 842, 386, { label: "Base model", route: "CAPTURED EXCERPT · ONE DIRECT RESPONSE", answer: data.base.excerpt })}
    ${comparisonCard(952, 400, 882, 386, { label: "Router", route: `CAPTURED EXCERPT · ${data.trace.first_agent.toUpperCase()} → ${data.trace.second_agent.toUpperCase()}`, answer: data.router.excerpt, router: true })}
    ${rect(86, 816, 1748, 112, { fill: C.white, stroke: C.lineStrong, radius: 18 })}
    ${textBlock(112, 850, "VISIBLE DIFFERENCE", { size: 13, color: C.green, weight: 700, family: "Showcase Mono", maxWidth: 220, maxLines: 1, letterSpacing: 0.6 })}
    ${textBlock(112, 895, data.comparison, { size: 23, color: C.ink, weight: 700, maxWidth: 1650, maxLines: 2 })}`;
  return shell({ section: "Demo 1 · Agent team", count: "02 / 06", title: "The specialist brief shapes the final plan.", subtitle: "Same prompt and same base model family. The Router path adds scoped source context and a validated handoff.", body });
}

function documentPage(x, y, width, height, { title, label, excerpt, fill, color }) {
  return `${rect(x, y, width, height, { fill, stroke: color, radius: 16 })}
    ${pill(x + 18, y + 16, label, { width: 116, fill: C.white, color, border: C.white, size: 11 })}
    ${textBlock(x + 18, y + 72, title, { size: 21, color, weight: 700, maxWidth: width - 36, maxLines: 2 })}
    ${line(x + 18, y + 108, x + width - 18, y + 108, color, 1)}
    ${textBlock(x + 18, y + 140, excerpt, { size: 16, color: C.text, maxWidth: width - 36, maxLines: 4, lineHeight: 1.28 })}`;
}

function documentsRoute(data) {
  const firstDoc = data.documents[0];
  const secondDoc = data.documents[1];
  const body = `${promptPanel(86, 258, 1748, data.prompt)}
    ${rect(86, 398, 1748, 526, { fill: C.white, stroke: C.line, radius: 24 })}
    ${documentPage(116, 438, 306, 194, { ...firstDoc, label: "Document A", fill: C.blueSoft, color: C.blue })}
    ${documentPage(116, 694, 306, 194, { ...secondDoc, label: "Document B", fill: C.coralSoft, color: C.coral })}
    ${pathLine("M422,535 C485,535 486,562 534,562", C.lineStrong, 2, "arrow")}
    ${pathLine("M422,791 C485,791 486,754 534,754", C.lineStrong, 2, "arrow")}
    ${rolePanel(542, 502, 282, 290, { title: "Router", label: "Selects 2", detail: data.trace.router_decision, fill: C.greenSoft, color: C.green, artifact: "PARALLEL SOURCE ROUTES" })}
    ${pathLine("M824,605 C868,605 868,512 916,512", C.blue, 2, "arrow")}
    ${pathLine("M824,689 C868,689 868,780 916,780", C.coral, 2, "arrow")}
    ${rolePanel(924, 438, 318, 194, { title: data.trace.first_agent, titleSize: 21, label: "Source A", detail: data.trace.first_action, fill: C.blueSoft, color: C.blue, artifact: data.trace.first_citation })}
    ${rolePanel(924, 694, 318, 194, { title: data.trace.second_agent, titleSize: 21, label: "Source B", detail: data.trace.second_action, fill: C.coralSoft, color: C.coral, artifact: data.trace.second_citation })}
    ${pathLine("M1242,535 C1305,535 1305,617 1350,617", C.blue, 2, "arrow")}
    ${pathLine("M1242,791 C1305,791 1305,709 1350,709", C.coral, 2, "arrow")}
    ${rolePanel(1358, 502, 442, 290, { title: data.trace.analysis_agent, label: "Workflow", detail: data.trace.analysis_action, fill: C.greenSoft, color: C.green, artifact: data.trace.analysis_artifact })}`;
  return shell({ section: "Demo 2 · Two documents", count: "03 / 06", title: "Two sources. Scoped in parallel. Joined once.", subtitle: "Each document stays with its own source agent before the Analysis Agent receives validated source handoffs from both.", body });
}

function documentsCompare(data) {
  const body = `${promptPanel(86, 258, 1748, data.prompt)}
    ${comparisonCard(86, 400, 842, 390, { label: "Base model", route: "CAPTURED RESPONSE · BOTH DOCUMENTS IN ONE PROMPT", answer: data.base.excerpt })}
    ${comparisonCard(952, 400, 882, 390, { label: "Router", route: "CAPTURED RESPONSE · 2 SOURCE AGENTS → ANALYSIS AGENT", answer: data.router.excerpt, router: true })}
    ${rect(86, 820, 1748, 110, { fill: C.white, stroke: C.lineStrong, radius: 18 })}
    ${pill(110, 840, data.router.citations[0], { width: 170, fill: C.blueSoft, color: C.blue, border: C.blueSoft, size: 11 })}
    ${pill(294, 840, data.router.citations[1], { width: 210, fill: C.coralSoft, color: C.coral, border: C.coralSoft, size: 11 })}
    ${textBlock(540, 864, "Verified source handoffs", { size: 18, color: C.soft, weight: 700, maxWidth: 360, maxLines: 1 })}
    ${textBlock(110, 908, data.comparison, { size: 21, color: C.ink, weight: 700, maxWidth: 1660, maxLines: 1 })}`;
  return shell({ section: "Demo 2 · Two documents", count: "04 / 06", title: "The answer shows what came from where.", subtitle: "The base comparison receives the exact same document text; the Router path adds source separation and a downstream synthesis step.", body });
}

function liveRoute(data) {
  const event = data.feed.event;
  const body = `${promptPanel(86, 258, 1748, data.prompt)}
    ${pill(86, 398, "Observable tool trace", { width: 222, fill: C.cyanSoft, color: C.cyan, border: C.cyanSoft })}
    ${rect(86, 452, 1748, 464, { fill: C.white, stroke: C.line, radius: 24 })}
    ${rolePanel(118, 508, 340, 300, { title: "Router", label: "Keyword match", detail: data.trace.router_decision, fill: C.greenSoft, color: C.green, artifact: data.trace.route_artifact })}
    ${line(458, 658, 530, 658, C.green, 3, "arrowGreen")}
    ${rolePanel(538, 508, 348, 300, { title: data.trace.agent, label: "Selected", detail: data.trace.agent_action, fill: C.cyanSoft, color: C.cyan, artifact: data.trace.tool_request })}
    ${line(886, 658, 958, 658, C.cyan, 3, "arrow")}
    ${rect(966, 508, 350, 300, { fill: C.white, stroke: C.cyan, radius: 20 })}
    ${pill(986, 526, "Official tool", { width: 142, fill: C.cyanSoft, color: C.cyan, border: C.cyanSoft, size: 12 })}
    ${textBlock(986, 592, "USGS past-hour feed", { size: 27, color: C.cyan, weight: 700, maxWidth: 310, maxLines: 1 })}
    ${textBlock(986, 642, `Feed generated ${data.feed.generated_utc}`, { size: 17, color: C.text, maxWidth: 310, maxLines: 2 })}
    ${textBlock(986, 710, "Fixed official endpoint", { size: 16, color: C.soft, weight: 700, maxWidth: 310, maxLines: 1 })}
    ${textBlock(986, 762, data.feed.source_label, { size: 13, color: C.faint, family: "Showcase Mono", maxWidth: 310, maxLines: 2 })}
    ${line(1316, 658, 1388, 658, C.cyan, 3, "arrow")}
    ${rect(1396, 508, 404, 300, { fill: C.greenDark, stroke: C.greenDark, radius: 20 })}
    ${pill(1416, 526, "Grounded answer", { width: 170, fill: C.white, color: C.greenDark, border: C.white, size: 12 })}
    ${textBlock(1416, 592, event.title, { size: 26, color: C.white, weight: 700, maxWidth: 364, maxLines: 3 })}
    ${textBlock(1416, 704, event.time_utc, { size: 17, color: "#d5eee2", family: "Showcase Mono", maxWidth: 364, maxLines: 1 })}
    ${textBlock(1416, 758, `Event ${event.id}`, { size: 14, color: "#9fd2b9", family: "Showcase Mono", maxWidth: 364, maxLines: 1 })}
    ${rect(118, 838, 1682, 50, { fill: C.graySoft, stroke: C.graySoft, radius: 13 })}
    ${check(140, 851, C.cyan)}
    ${textBlock(178, 870, data.takeaway, { size: 20, color: C.cyan, weight: 700, maxWidth: 1580, maxLines: 1 })}`;
  return shell({ section: "Demo 3 · Live tool", count: "05 / 06", title: "A current question triggers a current source.", subtitle: "The model does not browse on its own. The selected agent requests one bounded, executor-owned tool.", body, proof: "LIVE SOURCE SNAPSHOT · RECEIPT RECORDED" });
}

function liveCompare(data) {
  const body = `${promptPanel(86, 258, 1748, data.prompt)}
    ${comparisonCard(86, 400, 842, 390, { label: "Base model", route: "CAPTURED RESPONSE · NO LIVE SOURCE", answer: data.base.excerpt })}
    ${comparisonCard(952, 400, 882, 390, { label: "Router", route: `CAPTURED RESPONSE · ${data.trace.agent.toUpperCase()} → OFFICIAL USGS FEED`, answer: data.router.excerpt, router: true })}
    ${rect(86, 820, 1748, 110, { fill: C.white, stroke: C.lineStrong, radius: 18 })}
    ${pill(110, 840, "Source receipt", { width: 154, fill: C.cyanSoft, color: C.cyan, border: C.cyanSoft, size: 11 })}
    ${textBlock(290, 864, `${data.feed.source_label} · ${data.feed.generated_utc}`, { size: 18, color: C.soft, family: "Showcase Mono", maxWidth: 1380, maxLines: 1 })}
    ${textBlock(110, 908, data.comparison, { size: 21, color: C.ink, weight: 700, maxWidth: 1660, maxLines: 1 })}`;
  return shell({ section: "Demo 3 · Live tool", count: "06 / 06", title: "The quality difference is the evidence path.", subtitle: "The base answer is honest about its limit. The Router answer is current because a timestamped official source was available.", body, proof: "LIVE SOURCE SNAPSHOT · RECEIPT RECORDED" });
}

async function cleanDirectory(directory) {
  await mkdir(directory, { recursive: true });
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isFile()) await rm(path.join(directory, entry.name));
  }
}

async function renderPng(svg, output) {
  const image = await loadImage(Buffer.from(svg));
  const canvas = createCanvas(image.width, image.height);
  canvas.getContext("2d").drawImage(image, 0, 0);
  await writeFile(output, canvas.toBuffer("image/png"));
}

async function renderContactSheet(names, output) {
  const thumbWidth = 800;
  const thumbHeight = 450;
  const gapX = 48;
  const gapY = 38;
  const margin = 72;
  const header = 92;
  const width = 1800;
  const height = margin + header + thumbHeight * 3 + gapY * 2 + margin;
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  context.fillStyle = "#edf1ee";
  context.fillRect(0, 0, width, height);
  context.fillStyle = C.ink;
  context.font = "32px Showcase Sans Bold";
  context.fillText("Virenis · Three evidence-backed demonstrations", margin, 58);
  for (let index = 0; index < names.length; index += 1) {
    const x = margin + (index % 2) * (thumbWidth + gapX);
    const y = margin + header + Math.floor(index / 2) * (thumbHeight + gapY);
    const image = await loadImage(path.join(EXPORTS, `${names[index]}.png`));
    context.drawImage(image, x, y, thumbWidth, thumbHeight);
    context.strokeStyle = C.lineStrong;
    context.strokeRect(x, y, thumbWidth, thumbHeight);
  }
  await writeFile(output, canvas.toBuffer("image/png"));
}

function validateEvidence(evidence) {
  if (!evidence || typeof evidence !== "object") throw new Error("Campaign evidence must be an object.");
  if (!Array.isArray(evidence.demos) || evidence.demos.length !== 3) throw new Error("Campaign evidence requires exactly three demonstrations.");
  const expectedIds = ["agent_team", "document_analysis", "live_tool"];
  for (const id of expectedIds) {
    if (!evidence.demos.some((demo) => demo.id === id)) throw new Error(`Missing demonstration: ${id}`);
  }
  const prohibited = ["T", "C", "A", "R"].join("");
  if (JSON.stringify(evidence).toLowerCase().includes(prohibited.toLowerCase())) {
    throw new Error("Campaign evidence contains a prohibited architecture label.");
  }
}

async function main() {
  const evidence = JSON.parse(await readFile(path.join(ROOT, "campaign.json"), "utf8"));
  validateEvidence(evidence);
  const team = evidence.demos.find((demo) => demo.id === "agent_team");
  const documents = evidence.demos.find((demo) => demo.id === "document_analysis");
  const live = evidence.demos.find((demo) => demo.id === "live_tool");
  const slides = [
    ["01-agent-team-route", teamRoute(team)],
    ["02-agent-team-comparison", teamCompare(team)],
    ["03-document-route", documentsRoute(documents)],
    ["04-document-comparison", documentsCompare(documents)],
    ["05-live-tool-route", liveRoute(live)],
    ["06-live-tool-comparison", liveCompare(live)]
  ];
  const prohibited = ["T", "C", "A", "R"].join("");
  await cleanDirectory(FRAMES);
  await cleanDirectory(EXPORTS);
  for (const [name, svg] of slides) {
    if (svg.toLowerCase().includes(prohibited.toLowerCase())) throw new Error(`${name} contains a prohibited architecture label.`);
    await writeFile(path.join(FRAMES, `${name}.svg`), svg);
    await renderPng(svg, path.join(EXPORTS, `${name}.png`));
  }
  await renderContactSheet(slides.map(([name]) => name), path.join(EXPORTS, "router-marketing-contact-sheet.png"));
  stdout.write(`${JSON.stringify({ frames: slides.length, width: WIDTH, height: HEIGHT, exports: EXPORTS }, null, 2)}\n`);
}

await main();

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const allowedExtensions = new Set([".pdf", ".md", ".markdown", ".txt", ".csv"]);
const DEFAULT_MAX_DOCUMENT_TEXT_CHARS = 2_000_000;
const DEFAULT_MAX_PDF_PAGES = 500;
const DEFAULT_PDF_EXTRACTION_TIMEOUT_MS = 60_000;
const MAX_RUNTIME_CHUNK_RECORDS = 10_000;
const MAX_RUNTIME_CHUNK_ID_CHARS = 120;
const MAX_RUNTIME_CHUNK_TITLE_CHARS = 512;
const MAX_RUNTIME_CHUNK_SUMMARY_CHARS = 2_000;
const MAX_RUNTIME_CHUNK_TAGS = 12;
const MAX_RUNTIME_CHUNK_TAG_CHARS = 64;

export function slugify(value) {
  return String(value || "document")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64) || "document";
}

export function assertSafeSourcePath(sourcePath) {
  const normalized = sourcePath.replaceAll("\\", "/");
  const allowed = normalized.startsWith("sources/tcar_documents/") || normalized.startsWith("sources/router_agents/");
  if (!allowed || normalized.includes("..")) {
    const error = new Error("Source path must stay under approved TCAR source roots.");
    error.status = 400;
    throw error;
  }
}

export async function extractDocumentFromUpload(file) {
  if (!file) {
    const error = new Error("A document file is required.");
    error.status = 400;
    throw error;
  }

  const extension = path.extname(file.originalname || "").toLowerCase();
  if (!allowedExtensions.has(extension)) {
    const error = new Error("Unsupported document type. Upload PDF, Markdown, text, or CSV.");
    error.status = 400;
    throw error;
  }

  if (extension === ".pdf") {
    return extractPdfDocument(file.buffer);
  }

  const text = file.buffer.toString("utf8").replaceAll("\0", "").trim();
  if (!text) {
    const error = new Error("Document file is empty.");
    error.status = 400;
    throw error;
  }
  return { text: assertDocumentTextLimit(text), pages: [] };
}

export async function extractTextFromUpload(file) {
  return (await extractDocumentFromUpload(file)).text;
}

function assertDocumentTextLimit(text) {
  const maxChars = positiveLimit("APP_MAX_DOCUMENT_TEXT_CHARS", DEFAULT_MAX_DOCUMENT_TEXT_CHARS);
  if (text.length > maxChars) {
    const error = new Error(`Document text is too large. Limit is ${maxChars} characters after extraction.`);
    error.status = 413;
    throw error;
  }
  return text;
}

async function extractPdfDocument(buffer) {
  let loadingTask = null;
  let pdf = null;
  const deadline = Date.now() + positiveLimit(
    "APP_PDF_EXTRACTION_TIMEOUT_MS",
    DEFAULT_PDF_EXTRACTION_TIMEOUT_MS
  );

  try {
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const assetRoot = fileURLToPath(new URL("../../", import.meta.resolve("pdfjs-dist/legacy/build/pdf.mjs")));
    loadingTask = getDocument({
      data: Uint8Array.from(buffer),
      cMapUrl: pdfJsAssetPath(assetRoot, "cmaps"),
      cMapPacked: true,
      iccUrl: pdfJsAssetPath(assetRoot, "iccs"),
      isEvalSupported: false,
      maxImageSize: 0,
      standardFontDataUrl: pdfJsAssetPath(assetRoot, "standard_fonts"),
      stopAtErrors: false,
      useSystemFonts: true,
      useWorkerFetch: false,
      wasmUrl: pdfJsAssetPath(assetRoot, "wasm"),
      verbosity: 0
    });
    pdf = await beforePdfDeadline(loadingTask.promise, deadline);

    const maxPages = positiveLimit("APP_MAX_DOCUMENT_PDF_PAGES", DEFAULT_MAX_PDF_PAGES);
    if (!Number.isSafeInteger(pdf.numPages) || pdf.numPages < 1) {
      throw documentError(422, "PDF did not contain any pages.");
    }
    if (pdf.numPages > maxPages) {
      const unit = maxPages === 1 ? "page" : "pages";
      throw documentError(413, `PDF has too many pages. Limit is ${maxPages} ${unit}.`);
    }

    const maxChars = positiveLimit("APP_MAX_DOCUMENT_TEXT_CHARS", DEFAULT_MAX_DOCUMENT_TEXT_CHARS);
    const pages = [];
    let extractedChars = 0;

    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await beforePdfDeadline(pdf.getPage(pageNumber), deadline);
      try {
        const separatorChars = pages.length > 0 ? 2 : 0;
        const pageText = await extractPdfPageText(
          page,
          maxChars - extractedChars - separatorChars,
          deadline
        );
        if (!pageText) continue;

        extractedChars += pageText.length + separatorChars;
        pages.push({ page: pageNumber, text: pageText });
      } finally {
        page.cleanup();
      }
    }

    const text = pages.map((page) => page.text).join("\n\n").trim();
    if (!text) {
      throw documentError(422, "PDF did not contain extractable text. Image-only PDFs require OCR before upload.");
    }
    return { text: assertDocumentTextLimit(text), pages };
  } catch (error) {
    if (error?.status) throw error;
    throw documentError(422, "PDF extraction failed. Try a text-based PDF, Markdown, or text file.");
  } finally {
    try {
      await pdf?.cleanup();
    } catch {
      // The loading task still owns final worker and resource cleanup.
    }
    try {
      await loadingTask?.destroy();
    } catch {
      // Do not replace the extraction result with a worker cleanup failure.
    }
  }
}

async function extractPdfPageText(page, remainingChars, deadline) {
  if (remainingChars <= 0) throw documentTextLimitError();
  const reader = page.streamTextContent().getReader();
  const lines = [];
  let line = "";
  let lastY = null;
  let outputChars = 0;
  let completed = false;

  const flushLine = () => {
    if (!line) return;
    outputChars += line.length + (lines.length > 0 ? 1 : 0);
    if (outputChars > remainingChars) throw documentTextLimitError();
    lines.push(line);
    line = "";
  };

  try {
    while (true) {
      const chunk = await beforePdfDeadline(reader.read(), deadline);
      if (chunk.done) {
        completed = true;
        break;
      }
      for (const item of chunk.value?.items || []) {
        if (!item || typeof item.str !== "string") continue;
        const value = item.str.replaceAll("\0", "").replace(/\s+/g, " ").trim();
        const y = Array.isArray(item.transform) && Number.isFinite(item.transform[5])
          ? item.transform[5]
          : null;
        if (value && lastY !== null && y !== null && Math.abs(y - lastY) > 1.5) {
          flushLine();
        }
        if (value) {
          const needsSpace = line
            && !/^[,.;:!?%)\]]/.test(value)
            && !/[([]$/.test(line);
          line += `${needsSpace ? " " : ""}${value}`;
          if (outputChars + line.length + (lines.length > 0 ? 1 : 0) > remainingChars) {
            throw documentTextLimitError();
          }
        }
        if (item.hasEOL) flushLine();
        if (y !== null) lastY = y;
      }
    }
    flushLine();
    return lines.join("\n").trim();
  } finally {
    if (!completed) {
      try {
        // pdf.js requires an Error cancellation reason. Passing `undefined`
        // closes Node's stream controller before pdf.js marks its transport as
        // closed, which can surface later as an unhandled double-close.
        await beforePdfDeadline(
          reader.cancel(new Error("PDF text extraction stopped before completion.")),
          Date.now() + 1_000
        );
      } catch {
        // Loading-task destruction is the final cancellation fallback.
      }
    }
    reader.releaseLock();
  }
}

function beforePdfDeadline(promise, deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    return Promise.reject(documentError(422, "PDF extraction timed out."));
  }
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(documentError(422, "PDF extraction timed out.")), remaining);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function positiveLimit(name, fallback) {
  const configured = process.env[name];
  if (configured === undefined || configured === "") return fallback;
  const value = Number(configured);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function documentError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function documentTextLimitError() {
  const maxChars = positiveLimit("APP_MAX_DOCUMENT_TEXT_CHARS", DEFAULT_MAX_DOCUMENT_TEXT_CHARS);
  return documentError(
    413,
    `Document text is too large. Limit is ${maxChars} characters after extraction.`
  );
}

function pdfJsAssetPath(root, directory) {
  return `${path.join(root, directory)}${path.sep}`;
}

export function chunkDocument({ text, pages = [], slug, maxWords = 350, overlapWords = 60 }) {
  const safeMax = Math.min(Math.max(Number(maxWords) || 350, 80), 1200);
  const safeOverlap = Math.min(Math.max(Number(overlapWords) || 60, 0), Math.floor(safeMax / 2));
  const chunks = [];
  const normalizedPages = Array.isArray(pages)
    ? pages
      .map((page) => ({ page: Number(page?.page), text: String(page?.text || "").trim() }))
      .filter((page) => Number.isSafeInteger(page.page) && page.page > 0 && page.text)
    : [];
  const segments = normalizedPages.length > 0
    ? normalizedPages.map((page) => ({ text: page.text, pageStart: page.page, pageEnd: page.page }))
    : [{ text: String(text || ""), pageStart: null, pageEnd: null }];

  for (const segment of segments) {
    const words = segment.text.split(/\s+/).filter(Boolean);
    let cursor = 0;
    while (cursor < words.length) {
      const chunkWords = words.slice(cursor, cursor + safeMax);
      const body = chunkWords.join(" ");
      const title = inferTitle(body, chunks.length);
      const chunkId = `${slug}_${String(chunks.length + 1).padStart(4, "0")}`;
      const contentDigest = `sha256:${crypto.createHash("sha256").update(body, "utf8").digest("hex")}`;
      chunks.push({
        chunk_id: chunkId,
        title,
        page_start: segment.pageStart,
        page_end: segment.pageEnd,
        tags: inferTags(`${title} ${body}`),
        path: `sources/tcar_documents/${slug}/chunks/${chunkId}.md`,
        summary: summarize(body),
        token_count_approx: Math.ceil(chunkWords.length * 1.3),
        content_digest: contentDigest,
        body
      });
      if (cursor + safeMax >= words.length) {
        break;
      }
      cursor += safeMax - safeOverlap;
    }
  }

  return chunks;
}

export function documentRevision(chunks) {
  const material = chunks.map((chunk) => ({
    chunk_id: chunk.chunk_id,
    content_digest: chunk.content_digest,
    page_start: chunk.page_start,
    page_end: chunk.page_end
  }));
  return `sha256:${crypto.createHash("sha256").update(JSON.stringify(material), "utf8").digest("hex")}`;
}

export function documentIndexDigest(chunks) {
  const rows = chunks.map(({ body: _body, ...row }) => row);
  const bytes = rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
  return `sha256:${crypto.createHash("sha256").update(bytes, "utf8").digest("hex")}`;
}

export function documentChunkSnapshotDigest(chunks) {
  return `sha256:${crypto.createHash("sha256").update(canonicalJson(chunks), "utf8").digest("hex")}`;
}

export function assertStoredDocumentIntegrity(document) {
  if (!document || !Array.isArray(document.chunks) || document.chunks.length === 0) {
    throw documentIntegrityError("document has no committed chunks");
  }
  for (const chunk of document.chunks) {
    const expected = normalizeRuntimeSha256(chunk.content_digest);
    const actual = `sha256:${crypto.createHash("sha256").update(String(chunk.body || ""), "utf8").digest("hex")}`;
    if (!expected || expected !== actual) {
      throw documentIntegrityError(`chunk ${String(chunk.chunk_id || "unknown")} failed its content digest check`);
    }
  }
  const expectedRevision = normalizeRuntimeSha256(document.corpus_revision);
  const actualRevision = document.runtime_managed === true
    ? runtimeDocumentRevision(document.chunks)
    : documentRevision(document.chunks);
  if (!expectedRevision || expectedRevision !== actualRevision) {
    throw documentIntegrityError("document corpus revision does not match its chunks");
  }
  const expectedIndexDigest = normalizeRuntimeSha256(document.index_digest);
  if (!expectedIndexDigest) {
    throw documentIntegrityError("document index digest is missing");
  }
  const expectedSnapshotDigest = normalizeRuntimeSha256(document.chunk_snapshot_digest);
  if (document.runtime_managed === true && (
    !expectedSnapshotDigest || expectedSnapshotDigest !== documentChunkSnapshotDigest(document.chunks)
  )) {
    throw documentIntegrityError("document chunk snapshot does not match its registration commitment");
  }
  if (document.runtime_managed !== true && expectedIndexDigest !== documentIndexDigest(document.chunks)) {
    throw documentIntegrityError("document index digest does not match its ranking metadata");
  }
  return true;
}

export function validateRuntimeDocumentResult(result, {
  agentId,
  slug,
  text,
  pages = []
} = {}) {
  if (!isPlainObject(result)) {
    throw runtimeDocumentContractError("result must be an object");
  }
  if (!/^[a-z0-9][a-z0-9_]{0,119}$/.test(String(agentId || ""))) {
    throw runtimeDocumentContractError("request agent id is invalid");
  }
  if (!/^[a-z0-9_]+$/.test(String(slug || ""))) {
    throw runtimeDocumentContractError("request document slug is invalid");
  }
  if (result.id !== agentId) {
    throw runtimeDocumentContractError("agent id does not match the request");
  }
  if (!Number.isSafeInteger(result.chunks) || result.chunks < 1 || result.chunks > MAX_RUNTIME_CHUNK_RECORDS) {
    throw runtimeDocumentContractError("chunks must be a bounded positive integer");
  }
  const configuredChunkLimit = configuredRuntimeChunkLimit();
  if (result.chunks > configuredChunkLimit) {
    throw runtimeDocumentQuotaError(configuredChunkLimit);
  }
  if (!Array.isArray(result.chunk_records) || result.chunk_records.length !== result.chunks) {
    throw runtimeDocumentContractError("chunk_records must match the declared chunk count");
  }

  const documentRoot = `sources/tcar_documents/${slug}`;
  const indexPath = `${documentRoot}/index.jsonl`;
  if (result.document_root !== documentRoot || result.index_path !== indexPath) {
    throw runtimeDocumentContractError("document paths do not match the managed source root");
  }
  const sourceText = typeof text === "string" ? text : "";
  const sourceDigest = normalizeRuntimeSha256(result.source_digest);
  const computedSourceDigest = `sha256:${crypto.createHash("sha256").update(sourceText, "utf8").digest("hex")}`;
  if (!sourceText || !sourceDigest || sourceDigest !== computedSourceDigest) {
    throw runtimeDocumentContractError("source_digest does not match the uploaded document text");
  }

  const expectedPages = new Set(
    (Array.isArray(pages) ? pages : [])
      .map((page) => Number(page?.page))
      .filter((page) => Number.isSafeInteger(page) && page > 0)
  );
  const seenChunkIds = new Set();
  const maxBodyChars = positiveLimit("APP_MAX_DOCUMENT_TEXT_CHARS", DEFAULT_MAX_DOCUMENT_TEXT_CHARS);
  let totalBodyChars = 0;
  const chunkRecords = result.chunk_records.map((record, index) => {
    if (!isPlainObject(record)) {
      throw runtimeDocumentContractError(`chunk_records[${index}] must be an object`);
    }
    const chunkId = exactBoundedString(record.chunk_id, MAX_RUNTIME_CHUNK_ID_CHARS);
    if (!chunkId || !/^[a-z0-9_]+$/.test(chunkId) || !chunkId.startsWith(`${slug}_`)) {
      throw runtimeDocumentContractError(`chunk_records[${index}].chunk_id is invalid`);
    }
    if (seenChunkIds.has(chunkId)) {
      throw runtimeDocumentContractError("chunk ids must be unique");
    }
    seenChunkIds.add(chunkId);

    const title = exactMetadataString(record.title, MAX_RUNTIME_CHUNK_TITLE_CHARS);
    if (!title) {
      throw runtimeDocumentContractError(`chunk_records[${index}].title is invalid`);
    }
    const body = exactBoundedString(record.body, maxBodyChars);
    if (!body) {
      throw runtimeDocumentContractError(`chunk_records[${index}].body is invalid`);
    }
    totalBodyChars += body.length;
    if (totalBodyChars > maxBodyChars * 2) {
      throw runtimeDocumentContractError("aggregate chunk bodies exceed the document response limit");
    }

    const pageStart = runtimeChunkPage(record.page_start, `chunk_records[${index}].page_start`);
    const pageEnd = runtimeChunkPage(record.page_end, `chunk_records[${index}].page_end`);
    if ((pageStart === null) !== (pageEnd === null) || (pageStart !== null && pageEnd < pageStart)) {
      throw runtimeDocumentContractError(`chunk_records[${index}] has an invalid page range`);
    }
    if (expectedPages.size === 0) {
      if (pageStart !== null) {
        throw runtimeDocumentContractError(`chunk_records[${index}] has unexpected page metadata`);
      }
    } else if (
      pageStart === null
      || !expectedPages.has(pageStart)
      || !expectedPages.has(pageEnd)
    ) {
      throw runtimeDocumentContractError(`chunk_records[${index}] does not reference an uploaded page`);
    }

    if (!Array.isArray(record.tags) || record.tags.length > MAX_RUNTIME_CHUNK_TAGS) {
      throw runtimeDocumentContractError(`chunk_records[${index}].tags is invalid`);
    }
    const tags = record.tags.map((tag, tagIndex) => {
      const value = exactMetadataString(tag, MAX_RUNTIME_CHUNK_TAG_CHARS);
      if (!value || !/^[a-z0-9]+$/.test(value)) {
        throw runtimeDocumentContractError(`chunk_records[${index}].tags[${tagIndex}] is invalid`);
      }
      return value;
    });
    const pathValue = exactMetadataString(record.path, 512);
    if (pathValue !== `${documentRoot}/chunks/${chunkId}.md`) {
      throw runtimeDocumentContractError(`chunk_records[${index}].path is invalid`);
    }
    const summary = exactMetadataString(record.summary, MAX_RUNTIME_CHUNK_SUMMARY_CHARS, { allowEmpty: true });
    if (summary === null) {
      throw runtimeDocumentContractError(`chunk_records[${index}].summary is invalid`);
    }
    if (
      !Number.isSafeInteger(record.token_count_approx)
      || record.token_count_approx < 0
      || record.token_count_approx > body.length
    ) {
      throw runtimeDocumentContractError(`chunk_records[${index}].token_count_approx is invalid`);
    }
    const contentDigest = normalizeRuntimeSha256(record.content_digest);
    const computedDigest = `sha256:${crypto.createHash("sha256").update(body, "utf8").digest("hex")}`;
    if (!contentDigest || contentDigest !== computedDigest) {
      throw runtimeDocumentContractError(`chunk_records[${index}].content_digest does not match its body`);
    }

    return {
      chunk_id: chunkId,
      title,
      page_start: pageStart,
      page_end: pageEnd,
      tags,
      path: pathValue,
      summary,
      token_count_approx: record.token_count_approx,
      content_digest: contentDigest,
      body
    };
  });

  const corpusRevision = normalizeRuntimeSha256(result.corpus_revision);
  const computedRevision = runtimeDocumentRevision(chunkRecords);
  if (!corpusRevision || corpusRevision !== computedRevision) {
    throw runtimeDocumentContractError("corpus_revision does not match chunk_records");
  }
  const indexDigest = normalizeRuntimeSha256(result.index_digest);
  if (!indexDigest) {
    throw runtimeDocumentContractError("index_digest is missing or invalid");
  }

  return {
    ...result,
    document_root: documentRoot,
    index_path: indexPath,
    chunks: chunkRecords.length,
    chunk_records: chunkRecords,
    source_digest: sourceDigest,
    corpus_revision: corpusRevision,
    index_digest: indexDigest,
    chunk_snapshot_digest: documentChunkSnapshotDigest(chunkRecords)
  };
}

export function runtimeDocumentRevision(chunks) {
  const material = chunks.map((chunk) => ({
    chunk_id: chunk.chunk_id,
    content_digest: normalizeRuntimeSha256(chunk.content_digest)?.slice("sha256:".length) || "",
    page_start: chunk.page_start ?? null,
    page_end: chunk.page_end ?? null
  }));
  return `sha256:${crypto.createHash("sha256").update(canonicalJson(material), "utf8").digest("hex")}`;
}

function runtimeChunkPage(value, label) {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw runtimeDocumentContractError(`${label} is invalid`);
  }
  return value;
}

function normalizeRuntimeSha256(value) {
  const digest = typeof value === "string"
    ? value.trim().toLowerCase().replace(/^sha256:/, "")
    : "";
  return /^[a-f0-9]{64}$/.test(digest) ? `sha256:${digest}` : null;
}

function exactBoundedString(value, limit, { allowEmpty = false } = {}) {
  if (typeof value !== "string" || value.includes("\0") || value.length > limit || value !== value.trim()) {
    return null;
  }
  if (!allowEmpty && !value) return null;
  return value;
}

function exactMetadataString(value, limit, options = {}) {
  const text = exactBoundedString(value, limit, options);
  if (text === null || [...text].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint <= 31 || codePoint === 127;
  })) return null;
  return text;
}

function configuredRuntimeChunkLimit() {
  const configured = Number(process.env.APP_MAX_DOCUMENT_CHUNKS ?? 1000);
  if (!Number.isSafeInteger(configured) || configured < 0) return 1000;
  if (configured === 0) return MAX_RUNTIME_CHUNK_RECORDS;
  return Math.min(configured, MAX_RUNTIME_CHUNK_RECORDS);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function runtimeDocumentContractError(detail) {
  const error = new Error(`TCAR runtime returned an invalid document registration: ${detail}.`);
  error.status = 502;
  error.code = "runtime_document_contract_invalid";
  return error;
}

function documentIntegrityError(detail) {
  const error = new Error(`Document integrity verification failed: ${detail}.`);
  error.status = 409;
  error.code = "document_integrity_failed";
  return error;
}

function runtimeDocumentQuotaError(limit) {
  const error = new Error(`Document produced too many authoritative Runtime chunks. Limit is ${limit} chunks.`);
  error.status = 413;
  error.code = "runtime_document_chunk_limit";
  return error;
}

function inferTitle(body, index) {
  const heading = body.match(/#{1,6}\s+([^\n.]+)/);
  if (heading) {
    return heading[1].trim().slice(0, 90);
  }
  const sentence = body.split(/[.!?]/)[0]?.trim();
  return sentence ? sentence.slice(0, 90) : `Chunk ${index + 1}`;
}

function inferTags(text) {
  const terms = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((term) => term.length > 4);
  return [...new Set(terms)].slice(0, 8);
}

function summarize(body) {
  return body.replace(/\s+/g, " ").slice(0, 180);
}

export function scoreChunks(chunks, query, limit = 4) {
  const terms = query
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((term) => term.length > 2);

  return chunks
    .map((chunk) => {
      const haystack = `${chunk.title || ""} ${(chunk.tags || []).join(" ")} ${chunk.summary || ""} ${chunk.body || ""}`.toLowerCase();
      const score = terms.reduce((total, term) => {
        const matches = haystack.split(term).length - 1;
        return total + matches;
      }, 0);
      return {
        chunk_id: chunk.chunk_id,
        title: chunk.title,
        page_start: chunk.page_start,
        page_end: chunk.page_end,
        score: Number((score + (score > 0 ? 0.25 : 0)).toFixed(6)),
        summary: chunk.summary,
        excerpt: String(chunk.body || "").slice(0, 420),
        path: chunk.path,
        content_digest: chunk.content_digest,
        injected: score > 0
      };
    })
    .filter((chunk) => chunk.score > 0)
    .sort((a, b) => b.score - a.score || a.chunk_id.localeCompare(b.chunk_id))
    .slice(0, Math.min(Math.max(Number(limit) || 4, 1), 12));
}

export async function writeDocumentFiles({ uploadRoot, slug, chunks }) {
  const docRoot = path.join(uploadRoot, "sources", "tcar_documents", slug);
  const chunkRoot = path.join(docRoot, "chunks");
  await fs.mkdir(chunkRoot, { recursive: true, mode: 0o700 });
  for (const privateDirectory of [path.resolve(uploadRoot), docRoot, chunkRoot]) {
    await fs.chmod(privateDirectory, 0o700);
  }

  const indexRows = [];
  for (const chunk of chunks) {
    const frontMatter = [
      "---",
      `chunk_id: ${chunk.chunk_id}`,
      `title: ${JSON.stringify(chunk.title)}`,
      `page_start: ${chunk.page_start ?? "null"}`,
      `page_end: ${chunk.page_end ?? "null"}`,
      `tags: ${JSON.stringify(chunk.tags)}`,
      `content_digest: ${JSON.stringify(chunk.content_digest)}`,
      "---",
      "",
      chunk.body,
      ""
    ].join("\n");
    const chunkPath = path.join(uploadRoot, chunk.path);
    await fs.writeFile(chunkPath, frontMatter, {
      encoding: "utf8",
      mode: 0o600
    });
    await fs.chmod(chunkPath, 0o600);
    const { body: _body, ...indexRow } = chunk;
    indexRows.push(indexRow);
  }

  const indexPath = path.join(uploadRoot, "sources", "tcar_documents", slug, "index.jsonl");
  const indexBytes = indexRows.map((row) => JSON.stringify(row)).join("\n") + "\n";
  await fs.writeFile(indexPath, indexBytes, { encoding: "utf8", mode: 0o600 });
  await fs.chmod(indexPath, 0o600);
  return {
    document_root: `sources/tcar_documents/${slug}`,
    index_path: `sources/tcar_documents/${slug}/index.jsonl`,
    index_digest: `sha256:${crypto.createHash("sha256").update(indexBytes, "utf8").digest("hex")}`
  };
}

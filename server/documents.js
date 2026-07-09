import fs from "node:fs/promises";
import path from "node:path";

const allowedExtensions = new Set([".pdf", ".md", ".markdown", ".txt"]);

export function slugify(value) {
  return String(value || "document")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64) || "document";
}

export function assertSafeSourcePath(sourcePath) {
  const normalized = sourcePath.replaceAll("\\", "/");
  const allowed = normalized.startsWith("sources/tcar_documents/") || normalized.startsWith("sources/tcar_dummy_loras/");
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
    const error = new Error("Unsupported document type. Upload PDF, Markdown, or text.");
    error.status = 400;
    throw error;
  }

  if (extension === ".pdf") {
    try {
      const { default: pdfParse } = await import("pdf-parse");
      const pages = [];
      const parsed = await pdfParse(file.buffer, {
        pagerender: async (pageData) => {
          const content = await pageData.getTextContent({
            normalizeWhitespace: true,
            disableCombineTextItems: false
          });
          let lastY = null;
          const lines = [];
          for (const item of content.items || []) {
            const value = String(item?.str || "").replaceAll("\0", "").trim();
            if (!value) continue;
            const y = Array.isArray(item.transform) ? item.transform[5] : null;
            if (lastY !== null && y !== null && y !== lastY) {
              lines.push("\n");
            } else if (lines.length > 0 && lines.at(-1) !== "\n") {
              lines.push(" ");
            }
            lines.push(value);
            lastY = y;
          }
          const pageText = lines.join("").replace(/[ \t]+\n/g, "\n").trim();
          pages.push({
            page: Number.isSafeInteger(pageData.pageNumber) ? pageData.pageNumber : pages.length + 1,
            text: pageText
          });
          return pageText;
        }
      });
      pages.sort((left, right) => left.page - right.page);
      const text = pages.map((page) => page.text).filter(Boolean).join("\n\n").trim() || parsed.text.trim();
      if (!text) {
        const error = new Error("PDF did not contain extractable text.");
        error.status = 422;
        throw error;
      }
      return {
        text: assertDocumentTextLimit(text),
        pages: pages.filter((page) => page.text)
      };
    } catch (error) {
      if (error.status) {
        throw error;
      }
      const wrapped = new Error("PDF extraction failed. Try a text-based PDF, Markdown, or text file.");
      wrapped.status = 422;
      throw wrapped;
    }
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
  const maxChars = Number(process.env.APP_MAX_DOCUMENT_TEXT_CHARS || 2_000_000);
  if (text.length > maxChars) {
    const error = new Error(`Document text is too large. Limit is ${maxChars} characters after extraction.`);
    error.status = 413;
    throw error;
  }
  return text;
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
      chunks.push({
        chunk_id: chunkId,
        title,
        page_start: segment.pageStart,
        page_end: segment.pageEnd,
        tags: inferTags(`${title} ${body}`),
        path: `sources/tcar_documents/${slug}/chunks/${chunkId}.md`,
        summary: summarize(body),
        token_count_approx: Math.ceil(chunkWords.length * 1.3),
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
  await fs.mkdir(chunkRoot, { recursive: true });

  const indexRows = [];
  for (const chunk of chunks) {
    const frontMatter = [
      "---",
      `chunk_id: ${chunk.chunk_id}`,
      `title: ${JSON.stringify(chunk.title)}`,
      `page_start: ${chunk.page_start ?? "null"}`,
      `page_end: ${chunk.page_end ?? "null"}`,
      `tags: ${JSON.stringify(chunk.tags)}`,
      "---",
      "",
      chunk.body,
      ""
    ].join("\n");
    await fs.writeFile(path.join(uploadRoot, chunk.path), frontMatter, "utf8");
    const { body: _body, ...indexRow } = chunk;
    indexRows.push(indexRow);
  }

  const indexPath = path.join(uploadRoot, "sources", "tcar_documents", slug, "index.jsonl");
  await fs.writeFile(indexPath, indexRows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
  return {
    document_root: `sources/tcar_documents/${slug}`,
    index_path: `sources/tcar_documents/${slug}/index.jsonl`
  };
}

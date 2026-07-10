import crypto from "node:crypto";
import fs from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertStoredDocumentIntegrity,
  chunkDocument,
  documentIndexDigest,
  documentRevision,
  extractDocumentFromUpload,
  runtimeDocumentRevision,
  validateRuntimeDocumentResult
} from "../server/documents.js";

const previousLimits = {
  APP_MAX_DOCUMENT_TEXT_CHARS: process.env.APP_MAX_DOCUMENT_TEXT_CHARS,
  APP_MAX_DOCUMENT_PDF_PAGES: process.env.APP_MAX_DOCUMENT_PDF_PAGES,
  APP_PDF_EXTRACTION_TIMEOUT_MS: process.env.APP_PDF_EXTRACTION_TIMEOUT_MS,
  APP_MAX_DOCUMENT_CHUNKS: process.env.APP_MAX_DOCUMENT_CHUNKS
};

afterEach(() => {
  for (const [name, value] of Object.entries(previousLimits)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("PDF document extraction", () => {
  it("extracts bounded page-aware text from the production PDF fixture", async () => {
    const buffer = await fs.readFile(new URL("../fixtures/cold_chain_stability_guide.pdf", import.meta.url));

    const result = await extractDocumentFromUpload({
      originalname: "cold_chain_stability_guide.pdf",
      buffer
    });

    expect(result.pages).toHaveLength(1);
    expect(result.pages[0]).toEqual(expect.objectContaining({
      page: 1,
      text: expect.stringContaining("Shipment CT-204 disposition rule")
    }));
    expect(result.text).toContain("Reject CT-204");
    expect(result.text).toContain("45 cumulative minutes");
  });

  it("keeps extracted text attached to its original one-based PDF page", async () => {
    const result = await extractDocumentFromUpload({
      originalname: "financial.pdf",
      buffer: textPdfBytes(["Revenue is 100 million.", "Expenses are 40 million."])
    });

    expect(result).toEqual({
      text: "Revenue is 100 million.\n\nExpenses are 40 million.",
      pages: [
        { page: 1, text: "Revenue is 100 million." },
        { page: 2, text: "Expenses are 40 million." }
      ]
    });
  });

  it("rejects malformed PDF bytes without exposing parser internals", async () => {
    const extraction = extractDocumentFromUpload({
      originalname: "broken.pdf",
      buffer: Buffer.from("%PDF-1.7\nthis is not a valid PDF")
    });

    await expect(extraction).rejects.toMatchObject({
      status: 422,
      message: "PDF extraction failed. Try a text-based PDF, Markdown, or text file."
    });
  });

  it("rejects an image-only scanned PDF with an OCR-specific response", async () => {
    const extraction = extractDocumentFromUpload({
      originalname: "scan.pdf",
      buffer: imageOnlyPdfBytes()
    });

    await expect(extraction).rejects.toMatchObject({
      status: 422,
      message: "PDF did not contain extractable text. Image-only PDFs require OCR before upload."
    });
  });

  it("stops when extracted PDF text exceeds the configured character limit", async () => {
    process.env.APP_MAX_DOCUMENT_TEXT_CHARS = "80";
    const buffer = await fs.readFile(new URL("../fixtures/cold_chain_stability_guide.pdf", import.meta.url));

    const extraction = extractDocumentFromUpload({
      originalname: "oversized-text.pdf",
      buffer
    });

    await expect(extraction).rejects.toMatchObject({
      status: 413,
      message: "Document text is too large. Limit is 80 characters after extraction."
    });
  });

  it("rejects a PDF before extraction when its page count exceeds the configured limit", async () => {
    process.env.APP_MAX_DOCUMENT_PDF_PAGES = "1";

    const extraction = extractDocumentFromUpload({
      originalname: "two-pages.pdf",
      buffer: textPdfBytes(["Revenue is 100 million.", "Expenses are 40 million."])
    });

    await expect(extraction).rejects.toMatchObject({
      status: 413,
      message: "PDF has too many pages. Limit is 1 page."
    });
  });
});

describe("authoritative Runtime document chunks", () => {
  it("validates and normalizes the exact Runtime corpus", () => {
    const body = "Runtime canonical cold-chain disposition evidence for shipment CT-204.";
    const record = runtimeChunkRecord({
      slug: "cold_chain",
      body,
      pageStart: 3,
      pageEnd: 3
    });
    const result = runtimeDocumentResult({
      agentId: "cold_chain_lora",
      slug: "cold_chain",
      records: [record],
      sourceText: body
    });

    const validated = validateRuntimeDocumentResult(result, {
      agentId: "cold_chain_lora",
      slug: "cold_chain",
      text: body,
      pages: [{ page: 3, text: body }]
    });

    expect(validated.chunk_records).toEqual([{
      ...record,
      content_digest: `sha256:${record.content_digest}`
    }]);
    expect(validated.corpus_revision).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(validated.index_digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(validated.chunk_snapshot_digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(runtimeDocumentRevision(validated.chunk_records)).toBe(validated.corpus_revision);
    const cachedDocument = {
      chunks: structuredClone(validated.chunk_records),
      corpus_revision: validated.corpus_revision,
      index_digest: validated.index_digest,
      chunk_snapshot_digest: validated.chunk_snapshot_digest,
      runtime_managed: true
    };
    expect(assertStoredDocumentIntegrity(cachedDocument)).toBe(true);
    cachedDocument.chunks[0].title = "Tampered cached ranking title";
    expect(() => assertStoredDocumentIntegrity(cachedDocument)).toThrow(/chunk snapshot does not match/);
  });

  it.each([
    ["count mismatch", (result) => { result.chunks = 2; }],
    ["duplicate id", (result) => { result.chunk_records.push({ ...result.chunk_records[0] }); result.chunks = 2; }],
    ["foreign path", (result) => { result.chunk_records[0].path = "sources/tcar_documents/other/chunks/other_0001.md"; }],
    ["control characters in title", (result) => { result.chunk_records[0].title = "Unsafe\nTitle"; }],
    ["invalid tag grammar", (result) => { result.chunk_records[0].tags = ["Not-Safe"]; }],
    ["tampered body", (result) => { result.chunk_records[0].body += " tampered"; }],
    ["tampered source digest", (result) => { result.source_digest = "0".repeat(64); }],
    ["missing index digest", (result) => { result.index_digest = ""; }],
    ["foreign page", (result) => { result.chunk_records[0].page_start = 4; result.chunk_records[0].page_end = 4; }],
    ["tampered revision", (result) => { result.corpus_revision = "0".repeat(64); }]
  ])("rejects %s in a Runtime receipt", (_label, mutate) => {
    const record = runtimeChunkRecord({
      slug: "verified_manual",
      body: "This is the exact authoritative body committed by Runtime.",
      pageStart: 3,
      pageEnd: 3
    });
    const result = runtimeDocumentResult({
      agentId: "verified_manual_lora",
      slug: "verified_manual",
      records: [record],
      sourceText: record.body
    });
    mutate(result);

    expect(() => validateRuntimeDocumentResult(result, {
      agentId: "verified_manual_lora",
      slug: "verified_manual",
      text: record.body,
      pages: [{ page: 3, text: record.body }]
    })).toThrow(expect.objectContaining({
      status: 502,
      code: "runtime_document_contract_invalid"
    }));
  });

  it("bounds authoritative chunk bodies independently of the HTTP response cap", () => {
    process.env.APP_MAX_DOCUMENT_TEXT_CHARS = "20";
    const record = runtimeChunkRecord({
      slug: "bounded_manual",
      body: "This authoritative chunk body exceeds twenty characters."
    });
    const result = runtimeDocumentResult({
      agentId: "bounded_manual_lora",
      slug: "bounded_manual",
      records: [record],
      sourceText: record.body
    });

    expect(() => validateRuntimeDocumentResult(result, {
      agentId: "bounded_manual_lora",
      slug: "bounded_manual",
      text: record.body
    })).toThrow(expect.objectContaining({ status: 502 }));
  });

  it("applies the configured chunk quota before accepting Runtime records", () => {
    process.env.APP_MAX_DOCUMENT_CHUNKS = "1";
    const records = [
      runtimeChunkRecord({ slug: "quota_manual", body: "First authoritative Runtime chunk body.", chunkIndex: 1 }),
      runtimeChunkRecord({ slug: "quota_manual", body: "Second authoritative Runtime chunk body.", chunkIndex: 2 })
    ];
    const result = runtimeDocumentResult({
      agentId: "quota_manual_lora",
      slug: "quota_manual",
      records,
      sourceText: "Uploaded source text."
    });

    expect(() => validateRuntimeDocumentResult(result, {
      agentId: "quota_manual_lora",
      slug: "quota_manual",
      text: "Uploaded source text."
    })).toThrow(expect.objectContaining({
      status: 413,
      code: "runtime_document_chunk_limit"
    }));
  });
});

describe("stored document retrieval integrity", () => {
  it("rejects post-registration body and ranking-metadata tampering", () => {
    const chunks = chunkDocument({
      slug: "stored_integrity",
      text: "Shipment CT-204 remains quarantined after a 45 minute excursion above 12 C pending pharmacist review.",
      maxWords: 80,
      overlapWords: 0
    });
    const document = {
      chunks,
      corpus_revision: documentRevision(chunks),
      index_digest: documentIndexDigest(chunks),
      runtime_managed: false
    };
    expect(assertStoredDocumentIntegrity(document)).toBe(true);

    const originalBody = chunks[0].body;
    chunks[0].body += " post-registration tamper";
    expect(() => assertStoredDocumentIntegrity(document)).toThrow(/content digest check/);
    chunks[0].body = originalBody;

    chunks[0].title = "Attacker-controlled ranking title";
    expect(() => assertStoredDocumentIntegrity(document)).toThrow(/index digest does not match/);
  });
});

function runtimeChunkRecord({ slug, body, pageStart = null, pageEnd = null, chunkIndex = 1 }) {
  const chunkId = `${slug}_${String(chunkIndex).padStart(4, "0")}`;
  return {
    chunk_id: chunkId,
    title: "Authoritative Runtime chunk",
    page_start: pageStart,
    page_end: pageEnd,
    tags: ["authoritative", "runtime"],
    path: `sources/tcar_documents/${slug}/chunks/${chunkId}.md`,
    summary: body,
    token_count_approx: body.split(/\s+/).length,
    content_digest: crypto.createHash("sha256").update(body, "utf8").digest("hex"),
    body
  };
}

function runtimeDocumentResult({ agentId, slug, records, sourceText }) {
  return {
    status: "added",
    id: agentId,
    document_root: `sources/tcar_documents/${slug}`,
    index_path: `sources/tcar_documents/${slug}/index.jsonl`,
    chunks: records.length,
    chunk_records: records,
    source_digest: crypto.createHash("sha256").update(sourceText, "utf8").digest("hex"),
    corpus_revision: runtimeDocumentRevision(records).replace(/^sha256:/, ""),
    index_digest: crypto.createHash("sha256").update(JSON.stringify(records), "utf8").digest("hex")
  };
}

function textPdfBytes(pageTexts) {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
  ];
  const pageReferences = [];

  for (const text of pageTexts) {
    const pageObject = objects.length + 1;
    const contentObject = pageObject + 1;
    pageReferences.push(`${pageObject} 0 R`);
    const stream = `BT\n/F1 12 Tf\n72 720 Td\n(${escapePdfText(text)}) Tj\nET\n`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentObject} 0 R >>`,
      `<< /Length ${Buffer.byteLength(stream, "ascii")} >>\nstream\n${stream}endstream`
    );
  }
  objects[1] = `<< /Type /Pages /Kids [${pageReferences.join(" ")}] /Count ${pageReferences.length} >>`;
  return buildPdf(objects);
}

function imageOnlyPdfBytes() {
  const content = "q\n100 0 0 100 72 620 cm\n/Im0 Do\nQ\n";
  const image = Buffer.concat([
    Buffer.from("<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 1 >>\nstream\n", "ascii"),
    Buffer.from([128]),
    Buffer.from("\nendstream", "ascii")
  ]);
  return buildPdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(content, "ascii")} >>\nstream\n${content}endstream`,
    image
  ]);
}

function buildPdf(objects) {
  const parts = [Buffer.from("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n", "latin1")];
  const offsets = [0];
  let length = parts[0].length;

  objects.forEach((object, index) => {
    offsets.push(length);
    const body = Buffer.isBuffer(object) ? object : Buffer.from(object, "latin1");
    const part = Buffer.concat([
      Buffer.from(`${index + 1} 0 obj\n`, "ascii"),
      body,
      Buffer.from("\nendobj\n", "ascii")
    ]);
    parts.push(part);
    length += part.length;
  });

  const xrefOffset = length;
  const xref = [
    `xref\n0 ${objects.length + 1}\n`,
    "0000000000 65535 f \n",
    ...offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`),
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  ].join("");
  parts.push(Buffer.from(xref, "ascii"));
  return Buffer.concat(parts);
}

function escapePdfText(value) {
  return value.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
}

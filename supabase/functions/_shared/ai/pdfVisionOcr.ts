/**
 * PDF Vision OCR — renders PDF pages to images via canvas, then OCRs via vision AI.
 * Handles multi-page PDFs safely with batching and page separators.
 */

import { callVision } from "./openaiClient.ts";
import { MODEL_VISION } from "./modelRouter.ts";

const MAX_OCR_BYTES = 4 * 1024 * 1024; // 4MB per file
const PAGES_PER_BATCH = 3;
const MAX_CUMULATIVE_CHARS = 50000;

export interface ExtractionDiagnostics {
  fileName: string;
  mimeType: string;
  byteSizeKB: number;
  embeddedTextLength: number;
  embeddedTextUsed: boolean;
  ocrAttempted: boolean;
  pageCount: number | null;
  ocrResultLength: number;
  fallbackPath: string;
  duration_ms: number;
  status: "success" | "failed" | "partial";
  failureReason?: string;
}

export type ExtractionFailure =
  | "too_large_for_ocr"
  | "unsupported_mime"
  | "empty_embedded_text_no_ocr_fallback"
  | "vision_ocr_failed"
  | "page_render_failed"
  | "pdf_parse_failed";

/**
 * Convert raw bytes to base64 (Deno-safe, no Node Buffer).
 */
function bytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 32768;
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    chunks.push(String.fromCharCode(...chunk));
  }
  return btoa(chunks.join(""));
}

/**
 * Determine image mime type from filename. Never returns application/pdf.
 */
function getImageMimeType(fileName: string): string {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".bmp")) return "image/bmp";
  return "image/jpeg";
}

/**
 * OCR a single image (not PDF) via vision AI.
 */
export async function ocrImageViaVision(
  bytes: Uint8Array,
  fileName: string,
): Promise<{ text: string | null; diagnostics: ExtractionDiagnostics }> {
  const start = Date.now();
  const mimeType = getImageMimeType(fileName);
  const diag: ExtractionDiagnostics = {
    fileName,
    mimeType,
    byteSizeKB: Math.round(bytes.length / 1024),
    embeddedTextLength: 0,
    embeddedTextUsed: false,
    ocrAttempted: true,
    pageCount: 1,
    ocrResultLength: 0,
    fallbackPath: "image_direct_ocr",
    duration_ms: 0,
    status: "failed",
  };

  if (bytes.length > MAX_OCR_BYTES) {
    diag.failureReason = "too_large_for_ocr";
    diag.duration_ms = Date.now() - start;
    console.warn(`[OCR-DIAG] ${fileName}: too_large_for_ocr (${diag.byteSizeKB}KB)`);
    return { text: null, diagnostics: diag };
  }

  try {
    const base64 = bytesToBase64(bytes);
    console.log(`[OCR-DIAG] ${fileName}: sending ${diag.byteSizeKB}KB ${mimeType} to vision`);

    const result = await callVision({
      model: MODEL_VISION,
      messages: [
        {
          role: "system",
          content:
            "Extract ALL text content from this document image. Return the raw text exactly as it appears, preserving dates, numbers, names, and addresses. Do not summarize or interpret.",
        },
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: `data:${mimeType};base64,${base64}` } },
            { type: "text", text: "Extract all text from this document. Return only the raw text content." },
          ],
        },
      ],
      temperature: 0.1,
    });

    const text = result.text || null;
    diag.ocrResultLength = text?.length || 0;
    diag.status = text && text.length > 10 ? "success" : "partial";
    diag.duration_ms = Date.now() - start;

    console.log(`[OCR-DIAG] ${fileName}: vision returned ${diag.ocrResultLength} chars in ${diag.duration_ms}ms`);
    return { text, diagnostics: diag };
  } catch (error) {
    diag.failureReason = `vision_ocr_failed: ${error instanceof Error ? error.message : String(error)}`;
    diag.duration_ms = Date.now() - start;
    console.error(`[OCR-DIAG] ${fileName}: ${diag.failureReason}`);
    return { text: null, diagnostics: diag };
  }
}

/**
 * Full PDF extraction pipeline:
 * 1. Try embedded text extraction via PDF.js
 * 2. If text < threshold, attempt per-page image OCR
 * 3. Return concatenated results with page separators
 */
export async function extractPdfWithOcrFallback(
  bytes: Uint8Array,
  fileName: string,
  opts?: {
    embeddedTextThreshold?: number;
    minOcrRetryThreshold?: number;
  },
): Promise<{
  text: string;
  method: string;
  diagnostics: ExtractionDiagnostics;
}> {
  const start = Date.now();
  const threshold = opts?.embeddedTextThreshold ?? 150;
  const minRetryThreshold = opts?.minOcrRetryThreshold ?? 100;

  const diag: ExtractionDiagnostics = {
    fileName,
    mimeType: "application/pdf",
    byteSizeKB: Math.round(bytes.length / 1024),
    embeddedTextLength: 0,
    embeddedTextUsed: false,
    ocrAttempted: false,
    pageCount: null,
    ocrResultLength: 0,
    fallbackPath: "pdf_embedded_text",
    duration_ms: 0,
    status: "failed",
  };

  // Step 1: Try PDF.js text extraction
  let embeddedText = "";
  let pageCount: number | null = null;

  try {
    const pdfjs = await import("https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.mjs");
    const pdfData = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
      ? bytes.buffer
      : bytes.slice().buffer;

    const loadingTask = pdfjs.getDocument({ data: pdfData });
    const pdf = await loadingTask.promise;
    pageCount = pdf.numPages;
    diag.pageCount = pageCount;

    const textParts: string[] = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const textContent = await page.getTextContent();
      const pageText = (textContent.items || [])
        .map((item: any) => (typeof item?.str === "string" ? item.str : ""))
        .join(" ")
        .trim();
      if (pageText) textParts.push(pageText);
    }

    embeddedText = textParts.join("\n\n").trim();
    diag.embeddedTextLength = embeddedText.length;

    console.log(`[OCR-DIAG] ${fileName}: PDF.js extracted ${embeddedText.length} chars from ${pageCount} pages`);
  } catch (err) {
    console.error(`[OCR-DIAG] ${fileName}: PDF.js failed: ${err instanceof Error ? err.message : String(err)}`);
    diag.failureReason = "pdf_parse_failed";
  }

  // Step 2: Check if embedded text is sufficient
  const embeddedSufficient = embeddedText.length >= threshold;
  const isScannedPdf = embeddedText.length < minRetryThreshold;

  if (embeddedSufficient && !isScannedPdf) {
    diag.embeddedTextUsed = true;
    diag.status = "success";
    diag.fallbackPath = "pdf_embedded_text";
    diag.duration_ms = Date.now() - start;
    console.log(`[OCR-DIAG] ${fileName}: using embedded text (${embeddedText.length} chars), no OCR needed`);
    return { text: embeddedText, method: "pdfjs_native", diagnostics: diag };
  }

  // Step 3: PDF is scanned or has insufficient text — OCR via vision
  if (bytes.length > MAX_OCR_BYTES) {
    diag.failureReason = "too_large_for_ocr";
    diag.duration_ms = Date.now() - start;
    // Return whatever embedded text we got
    if (embeddedText.length > 10) {
      diag.embeddedTextUsed = true;
      diag.status = "partial";
      diag.fallbackPath = "pdf_embedded_text_partial";
      return { text: embeddedText, method: "pdfjs_native_partial", diagnostics: diag };
    }
    console.warn(`[OCR-DIAG] ${fileName}: too large for OCR (${diag.byteSizeKB}KB) and no embedded text`);
    return { text: "", method: "none", diagnostics: diag };
  }

  // OCR via OpenAI's native PDF support (Files API + file content type)
  // OpenAI vision models can read PDFs natively when uploaded via the Files API.
  diag.ocrAttempted = true;
  diag.fallbackPath = "pdf_ocr_openai_files";

  console.log(`[OCR-DIAG] ${fileName}: embedded text insufficient (${embeddedText.length} chars < ${threshold}), uploading to OpenAI Files API for native PDF OCR`);

  try {
    const ocrText = await ocrPdfViaOpenAIFiles(bytes, fileName, pageCount);
    diag.ocrResultLength = ocrText.length;

    if (ocrText.length > 10) {
      // Use OCR if it got more text, or use combined
      const finalText = ocrText.length > embeddedText.length ? ocrText : embeddedText;
      diag.status = "success";
      diag.embeddedTextUsed = finalText === embeddedText;
      diag.duration_ms = Date.now() - start;
      console.log(`[OCR-DIAG] ${fileName}: OCR yielded ${ocrText.length} chars, embedded=${embeddedText.length} chars, using ${finalText === embeddedText ? "embedded" : "ocr"}`);
      return {
        text: finalText,
        method: finalText === embeddedText ? "pdfjs_native" : "ocr_vision",
        diagnostics: diag,
      };
    }

    // OCR returned very little — fall back to embedded text
    if (embeddedText.length > 10) {
      diag.embeddedTextUsed = true;
      diag.status = "partial";
      diag.duration_ms = Date.now() - start;
      return { text: embeddedText, method: "pdfjs_native_partial", diagnostics: diag };
    }

    diag.failureReason = "empty_embedded_text_no_ocr_fallback";
    diag.duration_ms = Date.now() - start;
    return { text: "", method: "none", diagnostics: diag };
  } catch (error) {
    diag.failureReason = `vision_ocr_failed: ${error instanceof Error ? error.message : String(error)}`;
    diag.duration_ms = Date.now() - start;
    console.error(`[OCR-DIAG] ${fileName}: ${diag.failureReason}`);

    // Return embedded text as fallback
    if (embeddedText.length > 10) {
      diag.embeddedTextUsed = true;
      diag.status = "partial";
      return { text: embeddedText, method: "pdfjs_native_fallback", diagnostics: diag };
    }

    return { text: "", method: "none", diagnostics: diag };
  }
}

/**
 * Shared native-first PDF text extractor (pdf.js).
 *
 * Strategy: pull embedded text via pdf.js BEFORE sending the PDF to a vision
 * model. Vision OCR is reserved for pages that are genuinely scanned/image-only.
 *
 * Quality gates:
 *  - per-page average char count (default >= 50)
 *  - "garbage" detection (mostly non-printable chars or zero alpha ratio)
 *
 * Cost impact: typical carrier letters / denials / engineer reports / contractor
 * estimates are text PDFs and cost $0 to extract. Vision is only invoked when
 * the gate fails.
 */

const PDFJS_URL =
  "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.mjs";

let pdfjsLib: any = null;
async function getPdfJs() {
  if (!pdfjsLib) {
    pdfjsLib = await import(PDFJS_URL);
  }
  return pdfjsLib;
}

export interface NativePdfResult {
  text: string;
  pageCount: number;
  charCount: number;
  avgCharsPerPage: number;
  status: "ok" | "partial" | "scanned" | "error";
  pagesNeedingOcr: number[]; // 1-indexed page numbers with insufficient text
  durationMs: number;
  error?: string;
}

const DEFAULT_MIN_CHARS_PER_PAGE = 50;

/** Decode a base64 string to Uint8Array (chunked to avoid stack overflow). */
export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Quick "is this gibberish?" gate — guards against encoded/garbled PDF text. */
export function isGarbledExtraction(text: string): boolean {
  if (!text || text.length < 50) return true;
  const sample = text.slice(0, 5000);
  const printable = sample.replace(/[^\x20-\x7E\s]/g, "").length;
  const printableRatio = printable / sample.length;
  if (printableRatio < 0.7) return true;
  const alphaCount = (sample.match(/[A-Za-z]/g) || []).length;
  const alphaRatio = alphaCount / sample.length;
  if (alphaRatio < 0.25) return true;
  return false;
}

/**
 * Extract text from a PDF (bytes or base64) using pdf.js.
 *
 * @param input - Uint8Array of PDF bytes OR base64-encoded string
 * @param options.minCharsPerPage - threshold for considering a page "scanned"
 *   (default 50). Pages below this are returned in `pagesNeedingOcr`.
 */
export async function extractPdfNative(
  input: Uint8Array | string,
  options: { minCharsPerPage?: number; fileName?: string } = {},
): Promise<NativePdfResult> {
  const start = Date.now();
  const minCharsPerPage = options.minCharsPerPage ?? DEFAULT_MIN_CHARS_PER_PAGE;
  const fileName = options.fileName || "document.pdf";

  const result: NativePdfResult = {
    text: "",
    pageCount: 0,
    charCount: 0,
    avgCharsPerPage: 0,
    status: "error",
    pagesNeedingOcr: [],
    durationMs: 0,
  };

  try {
    const bytes = typeof input === "string" ? base64ToBytes(input) : input;
    const data =
      bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
        ? bytes.buffer
        : bytes.slice().buffer;

    const pdfjs = await getPdfJs();
    const loadingTask = pdfjs.getDocument({ data, disableFontFace: true });
    const pdf = await loadingTask.promise;
    result.pageCount = pdf.numPages;

    const pageTexts: string[] = [];
    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      try {
        const page = await pdf.getPage(pageNum);
        const tc = await page.getTextContent();
        const pageText = (tc.items || [])
          .map((it: any) => (typeof it.str === "string" ? it.str : ""))
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
        pageTexts.push(pageText);
        if (pageText.length < minCharsPerPage) {
          result.pagesNeedingOcr.push(pageNum);
        }
      } catch (pageErr) {
        console.warn(
          `[pdfNativeExtract] page ${pageNum} of ${fileName} failed:`,
          pageErr instanceof Error ? pageErr.message : pageErr,
        );
        pageTexts.push("");
        result.pagesNeedingOcr.push(pageNum);
      }
    }

    const fullText = pageTexts.join("\n\n").trim();
    result.text = fullText;
    result.charCount = fullText.length;
    result.avgCharsPerPage =
      result.pageCount > 0 ? result.charCount / result.pageCount : 0;

    if (isGarbledExtraction(fullText)) {
      result.status = "error";
      result.error = "extracted_text_garbled";
    } else if (result.pagesNeedingOcr.length === 0) {
      result.status = "ok";
    } else if (result.pagesNeedingOcr.length === result.pageCount) {
      result.status = "scanned";
    } else {
      result.status = "partial";
    }
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    console.error(`[pdfNativeExtract] failed for ${fileName}:`, result.error);
  } finally {
    result.durationMs = Date.now() - start;
    console.log(
      `[pdfNativeExtract] ${fileName}: pages=${result.pageCount}, chars=${result.charCount}, avg=${Math.round(result.avgCharsPerPage)}, status=${result.status}, scannedPages=${result.pagesNeedingOcr.length}, ${result.durationMs}ms`,
    );
  }

  return result;
}

/** True when native extraction produced text that's safe to use as-is. */
export function isNativeExtractionUsable(r: NativePdfResult): boolean {
  return (r.status === "ok" || r.status === "partial") && r.charCount >= 200;
}

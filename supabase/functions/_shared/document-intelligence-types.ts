/**
 * Universal Document Intelligence Types for Darwin
 * Shared across edge functions and frontend.
 * CONTRACT_VERSION must match src/lib/darwinContracts.ts.
 */

export const DOCUMENT_INTELLIGENCE_VERSION = "2026-03-15";

// ── Document Type System ──────────────────────────────────────────────────────

export type ClaimDocumentType =
  | "engineering_report"
  | "carrier_denial"
  | "coverage_letter"
  | "carrier_email"
  | "adjuster_report"
  | "estimate"
  | "policy_document"
  | "inspection_report"
  | "contractor_report"
  | "invoice"
  | "photo_report"
  | "proof_of_loss"
  | "expert_report"
  | "other";

export type ClaimDocumentSubtype =
  | "full_denial"
  | "partial_denial"
  | "reservation_of_rights"
  | "carrier_estimate"
  | "pa_estimate"
  | "contractor_estimate"
  | "supplement_estimate"
  | "declarations"
  | "endorsement"
  | "mitigation_invoice"
  | "engineering_report_low_slope"
  | "engineering_report_wind"
  | "engineering_report_hail"
  | "engineering_report_structural"
  | "carrier_email_request"
  | "carrier_email_position"
  | "carrier_email_followup"
  | "other";

// ── Structured Intelligence Interface ─────────────────────────────────────────

export interface ClaimDocumentIntel {
  documentType: ClaimDocumentType;
  documentSubtype?: ClaimDocumentSubtype | string;
  summary?: string;
  sender?: string;
  recipient?: string;
  causeOfLoss?: string;
  coveragePosition?: string;
  keyDates?: Array<{ date: string; label: string }>;
  keyEntities?: Array<{ name: string; role: string }>;
  denialReasons?: string[];
  exclusionsCited?: string[];
  testingPerformed?: string[];
  testingMissing?: string[];
  estimateTotals?: {
    rcv?: number;
    acv?: number;
    depreciation?: number;
    deductible?: number;
  };
  scopePositions?: string[];
  buildingComponents?: string[];
  codeReferences?: string[];
  manufacturerReferences?: string[];
  citations?: string[];
  contradictions?: string[];
  extractedFacts?: Record<string, unknown>;
  confidenceScore?: number;
}

// ── Text Quality ──────────────────────────────────────────────────────────────

export type TextQualityStatus = "good" | "fair" | "poor" | "unusable";

export interface TextQualityResult {
  status: TextQualityStatus;
  score: number;
  reasons: string[];
}

// ── Classification Mapping ────────────────────────────────────────────────────

/**
 * Maps legacy classification strings to ClaimDocumentType.
 * Used by darwin-process-document and darwin-ai-analysis for unified type resolution.
 */
export const CLASSIFICATION_TO_DOC_TYPE: Record<string, ClaimDocumentType> = {
  denial: "carrier_denial",
  denial_letter: "carrier_denial",
  estimate: "estimate",
  carrier_estimate: "estimate",
  approval: "coverage_letter",
  coverage_letter: "coverage_letter",
  rfi: "carrier_email",
  carrier_correspondence: "carrier_email",
  engineering_report: "engineering_report",
  policy: "policy_document",
  policy_document: "policy_document",
  correspondence: "carrier_email",
  invoice: "invoice",
  photo: "photo_report",
  photos_report: "photo_report",
  inspection_report: "inspection_report",
  contractor_report: "contractor_report",
  proof_of_loss: "proof_of_loss",
  expert_report: "expert_report",
  other: "other",
};

/**
 * Maps ClaimDocumentType to the Darwin analysis type that should consume it.
 */
export const DOC_TYPE_TO_ANALYSIS_TYPE: Record<string, string> = {
  engineering_report: "engineer_report_rebuttal",
  carrier_denial: "denial_rebuttal",
  coverage_letter: "denial_rebuttal",
  carrier_email: "carrier_email_draft",
  estimate: "estimate_gap_analysis",
  policy_document: "policy_analysis",
};

// ── Garbage Text Detection ────────────────────────────────────────────────────

/**
 * Multi-sample garbage text detector.
 * Samples multiple sections of the text and rejects likely binary/garbled data.
 */
export function isGarbageText(text: string): boolean {
  if (!text || text.length < 50) return true;

  const samplePoints = [
    0,
    Math.floor(text.length * 0.25),
    Math.floor(text.length * 0.5),
    Math.floor(text.length * 0.75),
  ];

  let garbageSamples = 0;
  for (const start of samplePoints) {
    const sample = text.substring(start, start + 500);
    if (!sample || sample.length < 50) continue;

    const nonPrintable = (sample.match(/[^\x20-\x7E\n\r\t]/g) || []).length;
    const ratio = nonPrintable / sample.length;

    // Check for common language words
    const lower = sample.toLowerCase();
    const commonWords = ["the", "and", "was", "for", "that", "with", "this", "from", "have", "been"];
    const wordHits = commonWords.filter((w) => lower.includes(` ${w} `)).length;

    if (ratio > 0.3 || (ratio > 0.15 && wordHits < 2)) {
      garbageSamples++;
    }
  }

  // If majority of samples are garbage, text is garbage
  return garbageSamples >= Math.ceil(samplePoints.length / 2);
}

/**
 * Resolve the best available document type from legacy classification strings.
 */
export function resolveDocumentType(
  classification?: string | null,
  documentType?: string | null
): ClaimDocumentType {
  if (documentType && CLASSIFICATION_TO_DOC_TYPE[documentType]) {
    return CLASSIFICATION_TO_DOC_TYPE[documentType];
  }
  if (classification && CLASSIFICATION_TO_DOC_TYPE[classification]) {
    return CLASSIFICATION_TO_DOC_TYPE[classification];
  }
  return "other";
}

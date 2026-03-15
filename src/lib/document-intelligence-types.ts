/**
 * Universal Document Intelligence Types for Darwin (Frontend mirror)
 * Keep in sync with supabase/functions/_shared/document-intelligence-types.ts
 */

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

export type TextQualityStatus = "good" | "fair" | "poor" | "unusable";

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

/**
 * Maps legacy classification strings to readable document type labels.
 */
export const DOCUMENT_TYPE_LABELS: Record<string, string> = {
  engineering_report: "Engineering Report",
  carrier_denial: "Carrier Denial",
  denial: "Carrier Denial",
  denial_letter: "Denial Letter",
  coverage_letter: "Coverage Letter",
  approval: "Coverage Letter",
  carrier_email: "Carrier Email",
  carrier_correspondence: "Carrier Correspondence",
  correspondence: "Correspondence",
  adjuster_report: "Adjuster Report",
  estimate: "Estimate",
  carrier_estimate: "Carrier Estimate",
  policy_document: "Policy Document",
  policy: "Policy Document",
  inspection_report: "Inspection Report",
  contractor_report: "Contractor Report",
  invoice: "Invoice",
  photo_report: "Photo Report",
  photo: "Photo",
  photos_report: "Photos Report",
  proof_of_loss: "Proof of Loss",
  expert_report: "Expert Report",
  rfi: "Request for Info",
  other: "Other",
};

export const TEXT_QUALITY_LABELS: Record<TextQualityStatus, { label: string; color: string }> = {
  good: { label: "Good", color: "text-green-500" },
  fair: { label: "Fair", color: "text-yellow-500" },
  poor: { label: "Poor", color: "text-orange-500" },
  unusable: { label: "Unusable", color: "text-red-500" },
};

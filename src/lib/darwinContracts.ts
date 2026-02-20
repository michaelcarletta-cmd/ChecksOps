/**
 * Shared Darwin contracts: ClaimFactsPack (EvidenceIndex) and DismantlerResult (post-step).
 * Keep ClaimFactsPack small, structured, and citation-friendly; store references, not raw text.
 *
 * FolderKey = where the doc lives (UI grouping). Category = what the doc is (can be uncertain).
 * - folderKey is required; use for UI grouping (e.g. estimates, supplements, carrier).
 * - category is optional; when set it uses singular noun buckets (estimate, supplement, invoice)
 *   or source buckets (carrier_comms). Do not assume folderKey === category in UI filters.
 *
 * FolderKey + CONTRACT_VERSION: imported from supabase/functions/_shared/darwin-contracts.ts (canonical).
 * CI fails if CONTRACT_VERSION differs between that file and this one.
 */

import type { FolderKey } from "../../../supabase/functions/_shared/darwin-contracts";
export type { FolderKey };

/** Must match supabase/functions/_shared/darwin-contracts.ts CONTRACT_VERSION (CI checks). */
export const CONTRACT_VERSION = "2026-02-18";

/** What the document is (singular/noun or source bucket); optional when uncertain (don't guess). */
export type ClaimDocCategory =
  | "policy"
  | "estimate"
  | "photos"
  | "carrier_comms"
  | "invoice"
  | "supplement"
  | "other";

/** Structured doc request; supplements missingDocs string[] for UI and templates. */
export type MissingDocRequest = {
  key: string;
  title: string;
  whyNeeded: string;
  whereToFind?: string;
  priority: "high" | "med" | "low";
};

/** Global evidence ledger: counts by folder for "We have 3 policy docs / 0 carrier letters". */
export type EvidenceIndexSummary = {
  byFolderKey: Partial<Record<FolderKey, number>>;
  /** Sum of pageCount across documents that have pageCount set. Use this for "N pages indexed". */
  totalPagesKnownAcrossDocs?: number;
  /** @deprecated Prefer totalPagesKnownAcrossDocs. Kept for backward compatibility. */
  totalPagesKnown?: number;
};

/** Invoice scope bucket for debris vs documentation (scope splitter). */
export type InvoiceScopeBucket =
  | "physical_removal"
  | "packout_storage"
  | "documentation_inventory"
  | "cleaning_mitigation"
  | "unknown_unclassified";

export type ClaimFactsPack = {
  meta: {
    claimId: string;
    state?: string | null;
    carrier?: string | null;
    audience?: "carrier" | "regulator" | "internal";
    regulatoryComplaint?: boolean;
    drp?: boolean;
    lossType?: string | null;
    createdAt: string; // ISO
    servicesPerformed?: string[];
  };

  /** Global evidence ledger for UI summary. */
  evidenceIndexSummary?: EvidenceIndexSummary;

  documents: Array<{
    docId: string;
    docName: string;
    category?: ClaimDocCategory;
    categoryHint?: string;
    folderKey: FolderKey;
    pageCount?: number;
  }>;

  policy?: {
    policyNumber?: string | null;
    effectiveDate?: string | null;
    expirationDate?: string | null;
    coverages: Array<{
      name: string;
      limit?: string | null;
      deductible?: string | null;
      evidence: Array<{ docId: string; docName: string; page?: number; sectionHint?: string }>;
      confidence: 0 | 0.5 | 1;
    }>;
    missingDocs: string[];
  };

  estimate?: {
    source?: "carrier" | "shop" | "unknown";
    totals?: {
      labor?: number;
      parts?: number;
      paintMaterials?: number;
      tax?: number;
      grandTotal?: number;
    };
    laborRates?: Record<string, number>;
    lineItemHighlights: Array<{
      label: string;
      amount?: number;
      evidence: Array<{ docId: string; docName: string; page?: number; lineHint?: string }>;
    }>;
    missingDocs: string[];
  };

  objections?: Array<{
    verbatim: string;
    source: { docId: string; docName: string; page?: number; lineHint?: string };
    inferredType?: string;
    confidence: 0 | 0.5 | 1;
  }>;

  evidenceGaps: string[];
  /** Structured requests (evidence-index baseline). UI should prefer carrierDismantler.missingDocRequests when present (merged with pack; single source of truth). */
  missingDocRequests?: MissingDocRequest[];

  /** Invoice line items classified by scope (debris vs documentation). */
  invoiceScopeBuckets?: Partial<Record<InvoiceScopeBucket, { label: string; amount?: number; evidence: Array<{ docId: string; docName: string }> }[]>>;
};

/** Discrete confidence for dismantler */
export type DismantlerConfidence = 0 | 0.25 | 0.5 | 0.75 | 1;

/** Evidence quality + traceability per chip. */
export type EvidenceMethod = "quote" | "table" | "inference";
export type EvidenceStrength = "weak" | "ok" | "strong";

/** One evidence chip with method and optional span. */
export type DismantlerEvidenceChip = {
  docId?: string;
  docName: string;
  page?: number;
  sectionHint?: string;
  quote?: string; // <= 25 words
  evidenceMethod?: EvidenceMethod;
  spanHint?: { startLine?: number; endLine?: number };
  /** When evidenceMethod is "inference", short 1–2 sentence basis for the inference (keeps trust). */
  basis?: string;
};

/** One objection with optional evidence strength (computed). */
export type DismantlerObjection = {
  verbatim: string;
  type: string;
  whyItFails: string;
  evidence: DismantlerEvidenceChip[];
  requestedResolution: string;
  evidenceStrength?: EvidenceStrength;
};

/** Decision card: actionable ifTrue/ifFalse based on required facts/docs. */
export type DecisionCard = {
  /** Stable slug for React keys and telemetry (e.g. debris_vs_documentation). */
  key: string;
  decision: string;
  requiredFacts: string[];
  requiredDocs: string[];
  ifTrue: string;
  ifFalse: string;
};

export type DismantlerResult = {
  confidence: DismantlerConfidence;
  missingDocs: string[];
  /**
   * Merged missing-doc requests: dedupe by key from pack + dismantler; pack baseline, dismantler can add/upgrade.
   * UI should prefer this (carrierDismantler.missingDocRequests) when present; it is the single source of truth.
   */
  missingDocRequests?: MissingDocRequest[];

  objections: DismantlerObjection[];

  requestedResolutionOverall: string;
  notesForUser: string[];

  decisionCards?: DecisionCard[];
};

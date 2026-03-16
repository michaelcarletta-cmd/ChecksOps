export type PositionLockStatus = "draft" | "strategic_lock" | "litigation_grade";
export type PositionStrengthLabel = "fragile" | "moderate" | "strong";
export type DriftRisk = "low" | "medium" | "high";

export interface EvidenceAnchor {
  id: string;
  type:
    | "document"
    | "photo"
    | "policy"
    | "manufacturer"
    | "code"
    | "estimate"
    | "carrier_letter"
    | "expert_report"
    | "timeline_event"
    | "other";
  label: string;
  citation?: string;
  document_id?: string;
  photo_id?: string;
  note?: string;
}

export interface DarwinDeclaredPosition {
  id?: string;
  claim_id: string;

  claim_type?: string | null;

  observed_damage_condition: string;
  primary_loss_mechanism: string;
  coverage_trigger_theory: string;
  specific_carrier_failure: string;
  decisive_contradiction: string;
  requested_remedy: string;

  key_supporting_evidence: EvidenceAnchor[];
  policy_standard_support: EvidenceAnchor[];
  carrier_evidence_rebutted: EvidenceAnchor[];

  known_weaknesses: string[];
  missing_proof_needed: string[];

  position_strength_score: number | null;
  position_strength_label: PositionStrengthLabel | null;
  drift_risk: DriftRisk | null;
  lock_status: PositionLockStatus;

  master_position_statement: string | null;
  strategic_notes?: string | null;
  provisional_reason?: string | null;

  // Legacy fields (backwards compat)
  primary_cause_of_loss?: string | null;
  primary_coverage_theory?: string | null;
  primary_carrier_error?: string | null;
  carrier_dependency_statement?: string | null;
  confidence_level?: string;
  reasoning_complete?: boolean;
  position_locked?: boolean;
  risk_flags?: string[];
  missing_inputs?: string[];

  created_by?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface PositionValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  blockingRiskFlags: string[];
}

export interface PositionScoreResult {
  score: number;
  label: PositionStrengthLabel;
  driftRisk: DriftRisk;
  reasons: string[];
}

export interface OutputDriftResult {
  passes: boolean;
  reasons: string[];
}

export const DECLARED_POSITION_FIELD_HELP: Record<string, string> = {
  observed_damage_condition:
    "Describe what is physically damaged and how it presents. Focus on actual condition, not conclusions.",
  primary_loss_mechanism:
    "State the event and physical mechanism that caused the damage. Avoid vague phrases like 'storm damage'.",
  coverage_trigger_theory:
    "Explain why these facts trigger coverage under the policy or coverage grant.",
  specific_carrier_failure:
    "Identify the exact action, omission, assumption, or misapplication that led the carrier to the wrong result.",
  decisive_contradiction:
    "State what fact must be true for the carrier's position to hold, and what evidence proves that fact is false.",
  requested_remedy:
    "State the exact result Darwin should advocate for: reinspection, reversal, revised estimate, full replacement, code payment, etc.",
};

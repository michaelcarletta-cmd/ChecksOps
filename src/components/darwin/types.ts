export type DarwinMode = "rebuttal" | "steelman" | "evidence" | "scripts";

export interface DarwinKeyClaim {
  claim: string;
  assumptions: string[];
}

export interface DarwinBestRebuttal {
  rebuttal: string;
  reasoning: string;
  suggested_phrasing: string;
  strength_score: number; // 0-100
}

export interface DarwinEvidenceSource {
  label: string;
  url?: string;
}

export interface DarwinEvidencePackItem {
  key_facts: string[];
  sources: DarwinEvidenceSource[];
  relevance: string;
}

export interface DarwinTalkingPoints {
  "30-sec": string;
  "2-min": string;
  "5-min": string;
}

export interface DarwinStructuredResult {
  steelman_opponent: string;
  their_key_claims: DarwinKeyClaim[];
  my_best_rebuttals: DarwinBestRebuttal[];
  evidence_pack: DarwinEvidencePackItem[];
  questions_to_clarify: string[];
  risk_flags: string[];
  talking_points: DarwinTalkingPoints;
  confidence: number; // 0-100
  uncertainties: string[];
}

// Three-state indicator model for Counterfactual Causation Test
export type IndicatorState = 'present' | 'absent' | 'unknown';

export interface IndicatorValue {
  state: IndicatorState;
  notes?: string;
}

export interface CausationIndicator {
  id: string;
  category: string;
  label: string;
  description?: string;
  isPositive: boolean;
}

export interface CausationFormData {
  perilTested: string;
  damageTypes: string[];
  eventDate: string;
  damageNoticedDate: string;
  indicators: Record<string, IndicatorValue>;
  roofAge: string;
  shingleType: string;
  manufacturer: string;
  priorRepairs: string;
  weatherEvidence: string;
  observationsNotes: string;
  carrierBlameTactics: string[];
  blameEvidenceChecked: Record<string, string[]>;
}

export interface IndicatorBreakdown {
  id: string;
  label: string;
  state: IndicatorState;
  isPositive: boolean;
  category: string;
}

export interface CausationResult {
  decision: 'supported' | 'not_supported' | 'indeterminate';
  decisionLabel: string;
  counterfactualQuestion: string;
  directAnswer: string;
  conclusion: string;
  reasoningSummary: string;
  supportingObservations: IndicatorBreakdown[];
  opposingObservations: IndicatorBreakdown[];
  unknownObservations: IndicatorBreakdown[];
  evidenceGaps: string[];
  carrierBurdenStatement: string;
  baselineContext: string;
  rebuttalSummary?: string;
}

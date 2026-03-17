import { DamageObservation } from "@/types";
import { ScopeContext } from "@/lib/xactimateMap";

export interface ScopeLineItem {
  code: string;
  description: string;
  quantity: number;
  unit: string;
  unitPrice: number;
  total: number;
  reasoning: string;
  sourceObservationIndexes: number[];
  isCodeRequired?: boolean;
  isDependency?: boolean;
  isManualReviewRequired?: boolean;
  isProvisionalQuantity?: boolean;
}

export interface ScopeWarning {
  type:
    | "no_match"
    | "low_confidence"
    | "manual_review"
    | "code_upgrade"
    | "matching_issue"
    | "manual_measurement_required"
    | "structural_review_recommended"
    | "access_scope_required";
  message: string;
  observationIndex?: number;
}

export interface ScopeBuildResult {
  summary: string;
  observations: DamageObservation[];
  lineItems: ScopeLineItem[];
  warnings: ScopeWarning[];
  assumptions: string[];
  metrics: {
    roofSquares: number;
    sidingSf: number;
    interiorSf: number;
    gutterLf: number;
    windowCount: number;
    grossTotal: number;
  };
  contextUsed: ScopeContext;
}

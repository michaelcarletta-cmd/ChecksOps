export type DamageCategory =
  | "roof"
  | "siding"
  | "interior"
  | "window"
  | "gutter"
  | "fence"
  | "other";

export type Severity = "low" | "medium" | "high";

export interface DamageObservation {
  category: DamageCategory;
  component: string;
  material: string;
  damageType: string;
  severity: Severity;
  repairability: "repair" | "replace" | "undetermined";
  quantityBasis: string;
  recommendedQuantity: number;
  unit: string;
  confidence: number;
  rationale: string;
}

export interface EstimateLineItem {
  code: string;
  description: string;
  quantity: number;
  unit: string;
  unitPrice: number;
  total: number;
  reasoning: string;
}

export interface ScopeWarning {
  type:
    | "no_match"
    | "low_confidence"
    | "manual_review"
    | "code_upgrade"
    | "matching_issue";
  message: string;
  observationIndex?: number;
}

export interface AnalyzeResponse {
  observations: DamageObservation[];
  estimateItems: EstimateLineItem[];
  summary: string;
  aiSummary?: string;
  warnings?: ScopeWarning[];
  assumptions?: string[];
  metrics?: {
    roofSquares: number;
    sidingSf: number;
    interiorSf: number;
    gutterLf: number;
    windowCount: number;
    grossTotal: number;
  };
  contextUsed?: Record<string, unknown>;
}

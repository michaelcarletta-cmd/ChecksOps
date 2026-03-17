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

export interface AnalyzeResponse {
  observations: DamageObservation[];
  estimateItems: EstimateLineItem[];
  summary: string;
}

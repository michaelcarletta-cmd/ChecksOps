export type DamageCategory =
  | "roof"
  | "siding"
  | "interior"
  | "window"
  | "gutter"
  | "fence"
  | "other";

export type Severity = "low" | "medium" | "high";
export type MeasurementConfidence = "low" | "medium" | "high";
export type AssemblyLayer =
  | "roof_covering"
  | "underlayment"
  | "decking"
  | "framing"
  | "interior_finish"
  | "insulation"
  | "flashing"
  | "trim"
  | "unknown";
export type DamageMechanism =
  | "water_staining"
  | "rot"
  | "delamination"
  | "sagging"
  | "active_leak"
  | "missing_material"
  | "creased"
  | "hail_impact"
  | "wind_damage"
  | "deterioration"
  | "unknown";

export type RoomType = "closet" | "bedroom" | "bathroom" | "kitchen" | "hall" | "attic" | "garage" | "other";
export type SurfaceOrientation = "ceiling" | "wall" | "sloped_ceiling" | "other";
export type FinishLevel = "painted" | "textured" | "wallpaper" | "unfinished" | "unknown";
export type ObstructionLevel = "low" | "medium" | "high";

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

  assemblyLayer?: AssemblyLayer;
  damageMechanism?: DamageMechanism;
  accessRequired?: boolean;
  structuralConcern?: boolean;
  measurementConfidence?: MeasurementConfidence;
  provisionalQuantity?: boolean;
  visibleAreaOnly?: boolean;

  attachedItems?: string[];
  roomType?: RoomType;
  surfaceOrientation?: SurfaceOrientation;
  finishLevel?: FinishLevel;
  obstructionLevel?: ObstructionLevel;
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
    | "matching_issue"
    | "manual_measurement_required"
    | "structural_review_recommended"
    | "access_scope_required";
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

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

type DerivationSource = "geometry" | "ai_estimated" | "satellite_imagery";
type FieldAuthority = "geometry_authoritative" | "ai_provisional" | "user_authoritative" | "unknown_insufficient_geometry";
type RoofForm = "gable" | "hip" | "cross_gable" | "complex" | "unknown";
type PitchBand = "flat" | "low" | "moderate" | "steep" | "very_steep" | "unknown";
type PitchType = "band" | "exact";

interface VisionClassification<T> {
  value: T;
  confidence: number;
  abstain: boolean;
  reasoning: string;
}

interface ObstructionDetection {
  tree_cover_pct: number;
  shadow_coverage: "none" | "light" | "moderate" | "heavy";
  rear_slope_visible: boolean;
  visible_sides: number;
  obstructions: string[];
  confidence: number;
}

interface SatelliteVisionResult {
  roof_form: VisionClassification<string>;
  pitch_band: VisionClassification<PitchBand>;
  visible_facets: VisionClassification<number>;
  obstructions: ObstructionDetection;
  roof_color: string | null;
  overall_image_quality: number;
  analysis_notes: string;
}

interface SuppressionRecord {
  rule: string;
  field: string;
  reason: string;
  action: "confidence_reduced" | "value_suppressed" | "abstain_forced";
  before_confidence: number;
  after_confidence: number;
}

const PITCH_BAND_META: Record<PitchBand, { label: string; range: string; slope_factor_mid: number }> = {
  flat: { label: "Flat", range: "0-2/12", slope_factor_mid: 1.007 },
  low: { label: "Low", range: "2-4/12", slope_factor_mid: 1.034 },
  moderate: { label: "Moderate", range: "5-7/12", slope_factor_mid: 1.118 },
  steep: { label: "Steep", range: "8-10/12", slope_factor_mid: 1.250 },
  very_steep: { label: "Very Steep", range: "11+/12", slope_factor_mid: 1.414 },
  unknown: { label: "Unknown", range: "?", slope_factor_mid: 1.118 },
};

function exactPitchToBand(pitch: string): PitchBand {
  const match = pitch.match(/^(\d+)\/12$/);
  if (!match) return "unknown";
  const n = parseInt(match[1]);
  if (n <= 2) return "flat";
  if (n <= 4) return "low";
  if (n <= 7) return "moderate";
  if (n <= 10) return "steep";
  return "very_steep";
}

function bandToDisplayPitch(band: PitchBand): string {
  if (band === "unknown") return "unknown";
  return `${PITCH_BAND_META[band].label} (${PITCH_BAND_META[band].range})`;
}

interface EdgeClassification {
  segment_index: number;
  start: [number, number];
  end: [number, number];
  length_ft: number;
  bearing_deg: number;
  classification: "likely_eave" | "likely_rake" | "unknown";
  classification_reason: string;
}

interface GeometryMetadata {
  source_name: string;
  source_feature_id: string | null;
  retrieval_time: string;
  centroid_offset_ft: number;
  raw_polygon_hash: string;
  vertex_count: number;
}

interface RidgeCandidate {
  start: [number, number];
  end: [number, number];
  length_ft: number;
  bearing_deg: number;
  confidence: number;
  reasoning: string;
}

interface HipValleyCandidate {
  type: "hip" | "valley";
  start: [number, number];
  end: [number, number];
  length_ft: number;
  bearing_deg: number;
  confidence: number;
  reasoning: string;
}

interface RoofFormInference {
  inferred_roof_form: RoofForm;
  roof_form_confidence: number;
  roof_form_reasoning: string;
  dominant_axis_bearing: number;
  dominant_axis_length_ft: number;
  perpendicular_axis_length_ft: number;
  aspect_ratio: number;
  ridge_candidates: RidgeCandidate[];
  hip_valley_candidates: HipValleyCandidate[];
}

interface CandidateFootprint {
  polygon: number[][];
  area_sqft: number;
  perimeter_ft: number;
  source: string;
  source_feature_id: string | null;
  imagery_date: string | null;
  geometry_quality_score: number;
  geometry_metadata: GeometryMetadata;
  edge_classifications: EdgeClassification[];
  geojson: Record<string, unknown>;
}

interface OverhangConfig {
  eave_overhang_ft: number;
  rake_overhang_ft: number;
  unknown_overhang_ft: number;
  source: "default" | "user" | "regional";
}

const DEFAULT_OVERHANG: OverhangConfig = {
  eave_overhang_ft: 1.0,
  rake_overhang_ft: 0.75,
  unknown_overhang_ft: 0.5,
  source: "default",
};

type MassType = "main_roof" | "attached_garage" | "rear_projection" | "porch_bump_out" | "unknown_accessory";

interface MassClassification {
  mass_type: MassType;
  confidence: number;
  reasoning: string;
  /** Footprint contribution: this mass's area / total footprint area */
  footprint_contribution: number;
  /** Weight applied to linear values from this mass (0-1). Minor masses get lower weight. */
  derivation_weight: number;
}

/** A single rectangular roof mass decomposed from the building footprint. */
interface RoofMass {
  id: string;
  polygon: number[][];
  area_sqft: number;
  perimeter_ft: number;
  dominant_axis_bearing: number;
  dominant_axis_length_ft: number;
  perpendicular_axis_length_ft: number;
  aspect_ratio: number;
  edge_classifications: EdgeClassification[];
  inferred_form: RoofForm;
  form_confidence: number;
  /** Indices of other masses this one connects to (shared edges → valleys). */
  connected_mass_ids: string[];
  /** Classification of mass type and derivation weight */
  classification: MassClassification | null;
}

interface JunctionValley {
  mass_a: string;
  mass_b: string;
  approx_length_ft: number;
  /** Whether this junction valley has been promoted from candidate to measured */
  status: "candidate" | "promoted";
  promotion_reason: string | null;
}

interface RoofMassDecomposition {
  masses: RoofMass[];
  junction_valleys: JunctionValley[];
  decomposition_method: "axis_split" | "convex_partition" | "single_mass";
  notes: string[];
}

/** A single roof facet decomposed from footprint + roof type */
interface RoofFacet {
  id: string;
  label: string; // e.g. "Front Slope", "Left Hip", "Right Hip"
  area_sqft: number;
  slope_area_sqft: number;
  edges: {
    type: "eave" | "rake" | "ridge" | "hip" | "valley";
    length_ft: number;
    bearing_deg: number;
  }[];
  pitch: string | null;
  slope_factor: number;
}

interface FacetDecomposition {
  facets: RoofFacet[];
  total_eave_lf: number;
  total_rake_lf: number;
  total_ridge_lf: number;
  total_hip_lf: number;
  total_valley_lf: number;
  total_slope_area_sqft: number;
  total_squares: number;
  roof_type_used: string;
  decomposition_notes: string[];
}

interface RoofEstimateResult {
  footprint_area_sqft: number;
  estimated_roof_area_sqft: number;
  squares: number;
  dominant_pitch: string;
  pitch_band: PitchBand | null;
  pitch_type: PitchType;
  ridge_lf: number | null;
  hip_lf: number | null;
  valley_lf: number | null;
  eave_lf: number | null;
  rake_lf: number | null;
  facet_count: number | null;
  confidence_score: number;
  review_required: boolean;
  overlay_image_url: string | null;
  raw_geojson: Record<string, unknown> | null;
  ai_notes: string;
  data_sources: string[];
  field_sources: Record<string, DerivationSource>;
  field_confidence: Record<string, number>;
  field_authority: Record<string, FieldAuthority>;
  footprint_polygon: Record<string, unknown> | null;
  footprint_perimeter_ft: number | null;
  imagery_source: string | null;
  imagery_date: string | null;
  geometry_quality_score: number | null;
  edge_classifications: EdgeClassification[] | null;
  geometry_metadata: GeometryMetadata | null;
  candidate_footprints: CandidateFootprint[] | null;
  selected_candidate_index: number | null;
  // Phase 2C
  inferred_roof_form: RoofForm | null;
  roof_form_confidence: number | null;
  roof_form_reasoning: string | null;
  dominant_axis_bearing: number | null;
  dominant_axis_length_ft: number | null;
  perpendicular_axis_length_ft: number | null;
  aspect_ratio: number | null;
  ridge_candidates: RidgeCandidate[] | null;
  hip_valley_candidates: HipValleyCandidate[] | null;
  // Phase 2F: Vision classifications
  vision_classifications: SatelliteVisionResult | null;
  suppression_records: SuppressionRecord[] | null;
  // Phase 2G: Mass decomposition + overhang config
  roof_mass_decomposition: RoofMassDecomposition | null;
  overhang_config: OverhangConfig;
  // Phase 3: Roof polygon expansion
  roof_planar_area_sqft: number | null;
  roof_polygon_geojson: any | null;
  planar_area_gain_sqft: number | null;
  // Debug: intermediate calculation values
  slope_factor_used: number | null;
  correction_factor_used: number | null;
  // Shape conflict (existing)
  roof_shape_conflict: boolean;
  roof_shape_conflict_reason: string | null;
  provisional_complexity_uplift_used: number;
  shape_conflicted_roof_area_sqft: number | null;
  shape_conflicted_squares: number | null;
  // New: suggested outline, mass, imagery, calibration
  suggested_roof_polygon_geojson: any | null;
  suggested_roof_polygon_source: string | null;
  suggested_roof_polygon_confidence: number | null;
  suggested_roof_outline_notes: string | null;
  roof_mass_count: number | null;
  roof_mass_polygons: any[] | null;
  imagery_analysis: MultiImageAnalysis | null;
  calibration_adjustment_factor: number | null;
  // Per-facet decomposition
  facet_decomposition: FacetDecomposition | null;
}

// ── Helpers ──────────────────────────────────────────────────────────

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
const roundTo = (v: number, decimals = 0) => {
  const f = 10 ** decimals;
  return Math.round(v * f) / f;
};
const toRad = (d: number) => (d * Math.PI) / 180;
const toDeg = (r: number) => (r * 180) / Math.PI;
const R_FT = 20902231; // Earth radius in feet

/** Validate & sanitise numeric estimate fields. Preserves null for unknown values. */
function sanitise(raw: Record<string, any>): Record<string, any> {
  const numeric: [string, number, number, number][] = [
    ["footprint_area_sqft", 0, 100, 50000],
    ["estimated_roof_area_sqft", 0, 100, 60000],
    ["squares", 1, 1, 600],
    ["ridge_lf", 0, 0, 500],
    ["hip_lf", 0, 0, 500],
    ["valley_lf", 0, 0, 500],
    ["eave_lf", 0, 0, 1000],
    ["rake_lf", 0, 0, 1000],
    ["facet_count", 0, 1, 50],
    ["confidence_score", 0, 0, 50],
  ];
  const out: Record<string, any> = { ...raw };
  for (const [key, decimals, min, max] of numeric) {
    if (out[key] === null || out[key] === undefined) continue; // preserve null
    const v = Number(out[key]);
    out[key] = isNaN(v) ? null : roundTo(clamp(v, min, max), decimals);
  }
  if (out.estimated_roof_area_sqft != null && out.estimated_roof_area_sqft > 0) {
    out.squares = roundTo(out.estimated_roof_area_sqft / 100, 1);
  }
  return out;
}

// ── Geometry helpers ─────────────────────────────────────────────────

function polygonAreaSqft(ring: number[][]): number {
  if (ring.length < 3) return 0;
  let area = 0;
  for (let i = 0; i < ring.length; i++) {
    const j = (i + 1) % ring.length;
    const [lng1, lat1] = ring[i];
    const [lng2, lat2] = ring[j];
    area += toRad(lng2 - lng1) * (2 + Math.sin(toRad(lat1)) + Math.sin(toRad(lat2)));
  }
  area = Math.abs((area * R_FT * R_FT) / 2);
  return roundTo(area, 0);
}

function polygonPerimeterFt(ring: number[][]): number {
  if (ring.length < 2) return 0;
  let total = 0;
  for (let i = 0; i < ring.length; i++) {
    const j = (i + 1) % ring.length;
    total += haversineDistFt(ring[i], ring[j]);
  }
  return roundTo(total, 0);
}

function haversineDistFt(p1: number[], p2: number[]): number {
  const [lng1, lat1] = p1;
  const [lng2, lat2] = p2;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R_FT * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function bearingDeg(p1: number[], p2: number[]): number {
  const [lng1, lat1] = p1;
  const [lng2, lat2] = p2;
  const dLng = toRad(lng2 - lng1);
  const y = Math.sin(dLng) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) - Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLng);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

function polygonCentroid(ring: number[][]): [number, number] {
  const pts = ring[ring.length - 1][0] === ring[0][0] && ring[ring.length - 1][1] === ring[0][1]
    ? ring.slice(0, -1) : ring;
  const n = pts.length;
  const lng = pts.reduce((s, p) => s + p[0], 0) / n;
  const lat = pts.reduce((s, p) => s + p[1], 0) / n;
  return [lng, lat];
}

function midpoint(p1: number[], p2: number[]): [number, number] {
  return [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2];
}

/** Simple hash of polygon for versioning */
function polygonHash(ring: number[][]): string {
  const str = ring.map(p => `${p[0].toFixed(7)},${p[1].toFixed(7)}`).join("|");
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36);
}

// ── Phase 3: Roof polygon expansion (overhang-based) ─────────────────

type LocalPoint = { x: number; y: number };
type EdgeClass = "likely_eave" | "likely_rake" | "unknown";

interface EdgeClassForExpansion {
  classification: EdgeClass;
}

interface RoofPolygonResult {
  roof_polygon: LocalPoint[];
  original_planar_area_sqft: number;
  expanded_planar_area_sqft: number;
  area_gain_sqft: number;
}

function localPolygonArea(points: LocalPoint[]): number {
  if (!points || points.length < 3) return 0;
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

function localPolygonSignedArea(points: LocalPoint[]): number {
  if (!points || points.length < 3) return 0;
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return sum / 2;
}

function vecNormalize(v: LocalPoint): LocalPoint {
  const mag = Math.hypot(v.x, v.y);
  if (mag === 0) return { x: 0, y: 0 };
  return { x: v.x / mag, y: v.y / mag };
}

function vecSub(a: LocalPoint, b: LocalPoint): LocalPoint {
  return { x: a.x - b.x, y: a.y - b.y };
}

function vecAdd(a: LocalPoint, b: LocalPoint): LocalPoint {
  return { x: a.x + b.x, y: a.y + b.y };
}

function vecScale(v: LocalPoint, s: number): LocalPoint {
  return { x: v.x * s, y: v.y * s };
}

function outwardNormal(start: LocalPoint, end: LocalPoint, isCCW: boolean): LocalPoint {
  const dir = vecNormalize(vecSub(end, start));
  const normal = isCCW
    ? { x: dir.y, y: -dir.x }
    : { x: -dir.y, y: dir.x };
  return vecNormalize(normal);
}

function lineIntersection2D(
  p1: LocalPoint, p2: LocalPoint, p3: LocalPoint, p4: LocalPoint,
): LocalPoint | null {
  const denom = (p1.x - p2.x) * (p3.y - p4.y) - (p1.y - p2.y) * (p3.x - p4.x);
  if (Math.abs(denom) < 1e-8) return null;
  const px = ((p1.x * p2.y - p1.y * p2.x) * (p3.x - p4.x) - (p1.x - p2.x) * (p3.x * p4.y - p3.y * p4.x)) / denom;
  const py = ((p1.x * p2.y - p1.y * p2.x) * (p3.y - p4.y) - (p1.y - p2.y) * (p3.x * p4.y - p3.y * p4.x)) / denom;
  return { x: px, y: py };
}

function getEdgeOffsetFt(classification: EdgeClass, config: OverhangConfig): number {
  if (classification === "likely_eave") return config.eave_overhang_ft;
  if (classification === "likely_rake") return config.rake_overhang_ft;
  return config.unknown_overhang_ft;
}

function buildRoofPolygonFromFootprint(
  footprint: LocalPoint[],
  edgeClassifications: EdgeClassForExpansion[],
  overhangConfig: OverhangConfig,
): RoofPolygonResult {
  if (!footprint || footprint.length < 3) {
    return { roof_polygon: footprint || [], original_planar_area_sqft: 0, expanded_planar_area_sqft: 0, area_gain_sqft: 0 };
  }

  const originalPlanarArea = localPolygonArea(footprint);
  const isCCW = localPolygonSignedArea(footprint) > 0;

  if (!edgeClassifications || edgeClassifications.length !== footprint.length) {
    return { roof_polygon: footprint, original_planar_area_sqft: originalPlanarArea, expanded_planar_area_sqft: originalPlanarArea, area_gain_sqft: 0 };
  }

  const offsetLines: Array<{ a: LocalPoint; b: LocalPoint }> = [];
  for (let i = 0; i < footprint.length; i++) {
    const start = footprint[i];
    const end = footprint[(i + 1) % footprint.length];
    const cls = edgeClassifications[i]?.classification ?? "unknown";
    const offsetFt = getEdgeOffsetFt(cls, overhangConfig);
    const normal = outwardNormal(start, end, isCCW);
    const shift = vecScale(normal, offsetFt);
    offsetLines.push({ a: vecAdd(start, shift), b: vecAdd(end, shift) });
  }

  const expanded: LocalPoint[] = [];
  for (let i = 0; i < footprint.length; i++) {
    const prev = offsetLines[(i - 1 + offsetLines.length) % offsetLines.length];
    const curr = offsetLines[i];
    const intersection = lineIntersection2D(prev.a, prev.b, curr.a, curr.b);
    expanded.push(intersection ?? curr.a);
  }

  const expandedPlanarArea = localPolygonArea(expanded);
  return {
    roof_polygon: expanded,
    original_planar_area_sqft: originalPlanarArea,
    expanded_planar_area_sqft: expandedPlanarArea,
    area_gain_sqft: Math.max(0, expandedPlanarArea - originalPlanarArea),
  };
}

/** Convert a lng/lat polygon ring to local XY feet coordinates */
function lngLatRingToLocalXY(ring: number[][], originLat: number, originLng: number): LocalPoint[] {
  const feetPerDegreeLat = 364000;
  const feetPerDegreeLng = 364000 * Math.cos(toRad(originLat));
  const pts = ring[ring.length - 1][0] === ring[0][0] && ring[ring.length - 1][1] === ring[0][1]
    ? ring.slice(0, -1) : ring;
  return pts.map(p => ({ x: (p[0] - originLng) * feetPerDegreeLng, y: (p[1] - originLat) * feetPerDegreeLat }));
}

type LngLat = { lng: number; lat: number };

function localXYToLngLat(pt: LocalPoint, origin: LngLat): LngLat {
  const feetPerDegreeLat = 364000;
  const feetPerDegreeLng = 364000 * Math.cos((origin.lat * Math.PI) / 180);
  return { lng: origin.lng + pt.x / feetPerDegreeLng, lat: origin.lat + pt.y / feetPerDegreeLat };
}

function buildPolygonGeoJson(localPoints: LocalPoint[], origin: LngLat): { type: "Polygon"; coordinates: number[][][] } | null {
  if (!localPoints || localPoints.length < 3) return null;
  const ring = localPoints.map((pt) => {
    const ll = localXYToLngLat(pt, origin);
    return [ll.lng, ll.lat];
  });
  ring.push(ring[0]);
  return { type: "Polygon", coordinates: [ring] };
}

// ── Suggested Outline / Mass Decomposition / Calibration helpers ─────

interface RoofOutlineSuggestion {
  polygon_geojson: { type: "Polygon"; coordinates: number[][][] } | null;
  confidence: number;
  notes: string;
  source: "edge_detect" | "vision_guided_edge_detect" | "none";
}

interface SimpleMass {
  id: string;
  polygon: LocalPoint[];
  label: "main_roof" | "garage" | "rear_projection" | "porch_bumpout" | "unknown";
  confidence: number;
}

interface MultiImageAnalysis {
  complexity: "simple" | "multi_mass" | "highly_complex" | "unknown";
  visible_roof_form: string;
  visible_facet_count: number | null;
  mass_count_estimate: number | null;
  confidence: number;
  notes: string;
}

function localDistance(a: LocalPoint, b: LocalPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function simplifyClosedPolygon(points: LocalPoint[], toleranceFt = 1.5): LocalPoint[] {
  if (points.length < 4) return points;
  const out: LocalPoint[] = [points[0]];
  for (let i = 1; i < points.length; i++) {
    if (localDistance(points[i], out[out.length - 1]) >= toleranceFt) out.push(points[i]);
  }
  if (out.length > 2 && localDistance(out[0], out[out.length - 1]) < toleranceFt) {
    out[out.length - 1] = out[0];
  }
  return out;
}

function bboxOfLocalPoints(points: LocalPoint[]) {
  const xs = points.map(p => p.x);
  const ys = points.map(p => p.y);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

function buildSuggestedRoofOutline(args: {
  selectedFootprintLocalXY: LocalPoint[];
  visibleFacetCount: number | null;
  complexity: MultiImageAnalysis["complexity"];
  overhangEaveFt: number;
  overhangRakeFt: number;
  origin: LngLat;
}): RoofOutlineSuggestion {
  const { selectedFootprintLocalXY, visibleFacetCount, complexity, overhangEaveFt, overhangRakeFt, origin } = args;
  if (!selectedFootprintLocalXY || selectedFootprintLocalXY.length < 3) {
    return { polygon_geojson: null, confidence: 0, notes: "No usable footprint for suggested outline.", source: "none" };
  }

  const bbox = bboxOfLocalPoints(selectedFootprintLocalXY);
  const width = bbox.maxX - bbox.minX;
  const height = bbox.maxY - bbox.minY;

  let expanded: LocalPoint[];
  if (complexity === "simple") {
    expanded = [
      { x: bbox.minX - overhangRakeFt, y: bbox.minY - overhangEaveFt },
      { x: bbox.maxX + overhangRakeFt, y: bbox.minY - overhangEaveFt },
      { x: bbox.maxX + overhangRakeFt, y: bbox.maxY + overhangEaveFt },
      { x: bbox.minX - overhangRakeFt, y: bbox.maxY + overhangEaveFt },
      { x: bbox.minX - overhangRakeFt, y: bbox.minY - overhangEaveFt },
    ];
  } else {
    const bump = Math.max(4, Math.min(width, height) * 0.18);
    expanded = [
      { x: bbox.minX - overhangRakeFt, y: bbox.minY - overhangEaveFt },
      { x: bbox.maxX + overhangRakeFt, y: bbox.minY - overhangEaveFt },
      { x: bbox.maxX + overhangRakeFt, y: bbox.minY + height * 0.35 },
      { x: bbox.maxX + overhangRakeFt + bump, y: bbox.minY + height * 0.35 },
      { x: bbox.maxX + overhangRakeFt + bump, y: bbox.maxY + overhangEaveFt },
      { x: bbox.minX - overhangRakeFt, y: bbox.maxY + overhangEaveFt },
      { x: bbox.minX - overhangRakeFt, y: bbox.minY - overhangEaveFt },
    ];
  }

  const simplified = simplifyClosedPolygon(expanded, 0.5);
  return {
    polygon_geojson: buildPolygonGeoJson(simplified, origin),
    confidence: complexity === "simple" ? 55 : (visibleFacetCount != null && visibleFacetCount >= 10 ? 35 : 45),
    notes: complexity === "simple"
      ? "Suggested outline expanded from simple footprint bbox."
      : "Suggested outline expanded and bumped for visible multi-mass complexity. Requires staff review.",
    source: "vision_guided_edge_detect",
  };
}

function buildMultiImageAnalysis(args: {
  visionRoofForm: string | null;
  visionRoofFormConfidence: number | null;
  visibleFacetCount: number | null;
  visibleFacetConfidence: number | null;
}): MultiImageAnalysis {
  const form = args.visionRoofForm || "unknown";
  const facets = args.visibleFacetCount ?? null;
  const conf = Math.round(((args.visionRoofFormConfidence ?? 0) + (args.visibleFacetConfidence ?? 0)) / 2);

  let complexity: MultiImageAnalysis["complexity"] = "unknown";
  let massCountEstimate: number | null = null;
  if (facets != null) {
    if (facets <= 4) { complexity = "simple"; massCountEstimate = 1; }
    else if (facets <= 8) { complexity = "multi_mass"; massCountEstimate = 2; }
    else { complexity = "highly_complex"; massCountEstimate = 3; }
  }

  return { complexity, visible_roof_form: form, visible_facet_count: facets, mass_count_estimate: massCountEstimate, confidence: conf, notes: `Vision indicates ${form} with ${facets ?? "unknown"} visible facets.` };
}

function decomposeSimpleMasses(args: {
  footprintLocalXY: LocalPoint[];
  analysis: MultiImageAnalysis;
}): SimpleMass[] {
  const pts = args.footprintLocalXY;
  if (!pts || pts.length < 3) return [];

  const b = bboxOfLocalPoints(pts);
  const width = b.maxX - b.minX;
  const height = b.maxY - b.minY;

  const mainMass: SimpleMass = {
    id: "main", label: "main_roof", confidence: 80,
    polygon: [
      { x: b.minX, y: b.minY }, { x: b.maxX, y: b.minY },
      { x: b.maxX, y: b.maxY }, { x: b.minX, y: b.maxY }, { x: b.minX, y: b.minY },
    ],
  };

  if (args.analysis.complexity === "simple") return [mainMass];

  const sideWidth = Math.max(8, width * 0.28);
  const rearDepth = Math.max(8, height * 0.24);

  const garageMass: SimpleMass = {
    id: "garage", label: "garage", confidence: 60,
    polygon: [
      { x: b.maxX - sideWidth, y: b.maxY - rearDepth },
      { x: b.maxX + sideWidth * 0.35, y: b.maxY - rearDepth },
      { x: b.maxX + sideWidth * 0.35, y: b.maxY + rearDepth * 0.2 },
      { x: b.maxX - sideWidth, y: b.maxY + rearDepth * 0.2 },
      { x: b.maxX - sideWidth, y: b.maxY - rearDepth },
    ],
  };

  return [mainMass, garageMass];
}

function getCalibrationAdjustmentFactor(args: {
  inferredRoofForm: string | null;
  complexity: string | null;
  geometryQualityScore: number | null;
  source: string | null;
}): number {
  const form = (args.inferredRoofForm || "").toLowerCase();
  const complexity = (args.complexity || "").toLowerCase();
  const source = (args.source || "").toLowerCase();
  const quality = args.geometryQualityScore ?? 0;

  let factor = 1.0;
  if (source.includes("ai vision")) factor += 0.02;
  if (complexity === "highly_complex") factor += 0.05;
  if (form === "gable" && quality >= 70) factor += 0.01;
  if (quality < 50) factor += 0.03;

  return Math.round(factor * 1000) / 1000;
}

function getValidationDerivedAreaCorrection(args: {
  inferredRoofForm: string | null;
  geometrySource: string | null;
  geometryQualityScore: number | null;
  pitchBand: string | null;
}): number {
  const { inferredRoofForm, geometrySource, geometryQualityScore, pitchBand } = args;
  let factor = 1.0;
  if (geometrySource === "NJGIN" && (geometryQualityScore ?? 0) >= 70) factor += 0.02;
  if (inferredRoofForm === "gable" && pitchBand?.toLowerCase().includes("steep")) factor += 0.03;
  if ((geometryQualityScore ?? 0) < 40) factor -= 0.03;
  return factor;
}


// ── Phase 2B: Edge classification ────────────────────────────────────

interface AxisAnalysis {
  primaryAxis: number;
  perpAxis: number;
  primaryTotalLen: number;
  perpTotalLen: number;
  otherTotalLen: number;
  primarySegments: number[];
  perpSegments: number[];
}

function analyzeAxes(ring: number[][]): { segments: { start: [number, number]; end: [number, number]; len: number; bearing: number; normBearing: number }[]; axis: AxisAnalysis } {
  const pts = ring[ring.length - 1][0] === ring[0][0] && ring[ring.length - 1][1] === ring[0][1]
    ? ring.slice(0, -1) : ring;
  if (pts.length < 3) return { segments: [], axis: { primaryAxis: 0, perpAxis: 90, primaryTotalLen: 0, perpTotalLen: 0, otherTotalLen: 0, primarySegments: [], perpSegments: [] } };

  const segments: { start: [number, number]; end: [number, number]; len: number; bearing: number; normBearing: number }[] = [];
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    const b = bearingDeg(pts[i], pts[j]);
    segments.push({
      start: [pts[i][0], pts[i][1]],
      end: [pts[j][0], pts[j][1]],
      len: haversineDistFt(pts[i], pts[j]),
      bearing: b,
      normBearing: b % 180,
    });
  }

  // Weighted buckets to find dominant axis
  const buckets: Record<number, number> = {};
  for (const s of segments) {
    const b10 = Math.round(s.normBearing / 10) * 10;
    buckets[b10] = (buckets[b10] || 0) + s.len;
  }
  const sorted = Object.entries(buckets).sort((a, b) => Number(b[1]) - Number(a[1]));
  const primaryAxis = Number(sorted[0]?.[0] ?? 0);
  const perpAxis = (primaryAxis + 90) % 180;

  let primaryTotalLen = 0, perpTotalLen = 0, otherTotalLen = 0;
  const primarySegments: number[] = [];
  const perpSegments: number[] = [];

  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    const diffPrimary = Math.min(Math.abs(s.normBearing - primaryAxis), Math.abs(s.normBearing - primaryAxis + 180), Math.abs(s.normBearing - primaryAxis - 180));
    const diffPerp = Math.min(Math.abs(s.normBearing - perpAxis), Math.abs(s.normBearing - perpAxis + 180), Math.abs(s.normBearing - perpAxis - 180));
    if (diffPrimary <= 15) { primaryTotalLen += s.len; primarySegments.push(i); }
    else if (diffPerp <= 15) { perpTotalLen += s.len; perpSegments.push(i); }
    else { otherTotalLen += s.len; }
  }

  return { segments, axis: { primaryAxis, perpAxis, primaryTotalLen, perpTotalLen, otherTotalLen, primarySegments, perpSegments } };
}

function classifyEdges(ring: number[][]): EdgeClassification[] {
  const { segments, axis } = analyzeAxes(ring);
  if (segments.length === 0) return [];

  // Determine which axis is eave (longer total) vs rake (shorter total)
  const swapped = axis.perpTotalLen > axis.primaryTotalLen;

  const classifications: EdgeClassification[] = [];
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    const diffPrimary = Math.min(Math.abs(s.normBearing - axis.primaryAxis), Math.abs(s.normBearing - axis.primaryAxis + 180), Math.abs(s.normBearing - axis.primaryAxis - 180));
    const diffPerp = Math.min(Math.abs(s.normBearing - axis.perpAxis), Math.abs(s.normBearing - axis.perpAxis + 180), Math.abs(s.normBearing - axis.perpAxis - 180));

    let classification: "likely_eave" | "likely_rake" | "unknown";
    let reason: string;

    if (diffPrimary <= 15) {
      classification = swapped ? "likely_rake" : "likely_eave";
      reason = `Aligned with ${swapped ? "shorter" : "longer"} building axis (${axis.primaryAxis}°±15°). Footprint-proxy — not exact roof edge.`;
    } else if (diffPerp <= 15) {
      classification = swapped ? "likely_eave" : "likely_rake";
      reason = `Perpendicular to primary axis. Footprint-proxy — not exact roof edge.`;
    } else {
      classification = "unknown";
      reason = `Bearing ${roundTo(s.normBearing)}° does not align with primary axes. May be offset, wing, or irregular geometry.`;
    }

    classifications.push({
      segment_index: i,
      start: s.start,
      end: s.end,
      length_ft: roundTo(s.len, 1),
      bearing_deg: roundTo(s.bearing, 1),
      classification,
      classification_reason: reason,
    });
  }

  return classifications;
}

/** Compute a geometry quality score (0-100) for a footprint polygon */
function computeGeometryQuality(ring: number[][], areaSqft: number, centroidOffsetFt: number): number {
  let score = 100;
  const vertexCount = ring[ring.length - 1][0] === ring[0][0] ? ring.length - 1 : ring.length;
  if (vertexCount < 4) score -= 30;
  else if (vertexCount > 20) score -= 10;
  else if (vertexCount >= 4 && vertexCount <= 8) score += 0;
  else score -= 5;

  if (areaSqft < 500) score -= 25;
  else if (areaSqft > 10000) score -= 15;
  else if (areaSqft > 5000) score -= 5;

  if (centroidOffsetFt > 150) score -= 30;
  else if (centroidOffsetFt > 100) score -= 20;
  else if (centroidOffsetFt > 50) score -= 10;

  const perim = polygonPerimeterFt(ring);
  if (perim > 0) {
    const compactness = (4 * Math.PI * areaSqft) / (perim * perim);
    if (compactness < 0.3) score -= 20;
    else if (compactness < 0.5) score -= 10;
  }

  return Math.max(0, Math.min(100, score));
}

function buildGeometryMetadata(
  ring: number[][],
  source: string,
  featureId: string | null,
  geocodeLat: number,
  geocodeLng: number,
): GeometryMetadata {
  const [cLng, cLat] = polygonCentroid(ring);
  const centroidOffset = haversineDistFt([geocodeLng, geocodeLat], [cLng, cLat]);
  const vertexCount = ring[ring.length - 1][0] === ring[0][0] ? ring.length - 1 : ring.length;

  return {
    source_name: source,
    source_feature_id: featureId,
    retrieval_time: new Date().toISOString(),
    centroid_offset_ft: roundTo(centroidOffset, 1),
    raw_polygon_hash: polygonHash(ring),
    vertex_count: vertexCount,
  };
}

// ── Phase 2C: Roof form inference ────────────────────────────────────

function inferRoofForm(candidate: CandidateFootprint): RoofFormInference {
  const ring = candidate.polygon;
  const { segments, axis } = analyzeAxes(ring);
  const edges = candidate.edge_classifications;

  // Determine dominant (eave) and perpendicular (rake) axis lengths
  // Eave = longer total, Rake = shorter total
  const swapped = axis.perpTotalLen > axis.primaryTotalLen;
  const eaveTotalLen = swapped ? axis.perpTotalLen : axis.primaryTotalLen;
  const rakeTotalLen = swapped ? axis.primaryTotalLen : axis.perpTotalLen;
  const eaveAxis = swapped ? axis.perpAxis : axis.primaryAxis;
  const rakeAxis = swapped ? axis.primaryAxis : axis.perpAxis;

  // Dominant axis = the direction eaves run (the "long" direction of the building)
  const dominantAxisBearing = eaveAxis;

  // Estimate building dimensions from segment groups
  // For eave direction: the longest eave-aligned segment pair approximates building length
  const eaveSegLens = edges.filter(e => e.classification === "likely_eave").map(e => e.length_ft).sort((a, b) => b - a);
  const rakeSegLens = edges.filter(e => e.classification === "likely_rake").map(e => e.length_ft).sort((a, b) => b - a);

  const dominantAxisLength = eaveSegLens[0] || eaveTotalLen / 2;
  const perpAxisLength = rakeSegLens[0] || rakeTotalLen / 2;

  const aspectRatio = perpAxisLength > 0 ? roundTo(dominantAxisLength / perpAxisLength, 2) : 1;

  // Count segments by classification
  const eaveCount = edges.filter(e => e.classification === "likely_eave").length;
  const rakeCount = edges.filter(e => e.classification === "likely_rake").length;
  const unknownCount = edges.filter(e => e.classification === "unknown").length;
  const totalSegments = edges.length;
  const unknownPct = totalSegments > 0 ? unknownCount / totalSegments : 0;

  // Quality gate: if geometry quality is poor or too many unknowns, classify as unknown
  const qualityScore = candidate.geometry_quality_score;

  let form: RoofForm = "unknown";
  let confidence = 0;
  let reasoning = "";

  if (qualityScore < 30 || unknownPct > 0.4) {
    form = "unknown";
    confidence = 10;
    reasoning = `Geometry quality too low (${qualityScore}/100) or too many unclassified edges (${Math.round(unknownPct * 100)}%) for reliable roof form inference.`;
  } else if (totalSegments === 4 && unknownCount === 0) {
    // Simple 4-sided rectangle
    if (aspectRatio >= 1.3) {
      form = "gable";
      confidence = 55;
      reasoning = `Rectangular footprint (4 vertices, aspect ratio ${aspectRatio}). Elongated shape consistent with simple gable. Ridge would run along dominant axis (${roundTo(dominantAxisBearing)}°).`;
    } else {
      form = "hip";
      confidence = 45;
      reasoning = `Nearly square footprint (4 vertices, aspect ratio ${aspectRatio}). Low aspect ratio is more consistent with hip roof. However, both gable and hip are plausible at this ratio.`;
    }
  } else if (totalSegments >= 5 && totalSegments <= 8 && unknownCount <= 1) {
    // Slight complexity — L-shape or T-shape possible
    if (unknownCount === 0 && eaveCount >= 2 && rakeCount >= 2) {
      if (aspectRatio >= 1.3) {
        form = "gable";
        confidence = 45;
        reasoning = `${totalSegments}-sided footprint with clear axis alignment (${eaveCount} eave, ${rakeCount} rake segments). Elongated shape (aspect ratio ${aspectRatio}) suggests gable.`;
      } else {
        form = "hip";
        confidence = 40;
        reasoning = `${totalSegments}-sided footprint with clear axis alignment. Low aspect ratio (${aspectRatio}) more consistent with hip roof.`;
      }
    } else {
      form = "cross_gable";
      confidence = 35;
      reasoning = `${totalSegments}-sided footprint with ${unknownCount} unclassified segment(s), suggesting wing/extension. May indicate cross-gable or T-shaped roof.`;
    }
  } else if (totalSegments > 8) {
    form = "complex";
    confidence = 25;
    reasoning = `Complex footprint with ${totalSegments} segments. Too many edges for simple form classification. May have multiple wings, extensions, or irregular geometry.`;
  } else {
    form = "unknown";
    confidence = 15;
    reasoning = `Footprint shape (${totalSegments} segments, ${unknownCount} unknown) does not clearly match standard roof form categories.`;
  }

  // Infer ridge candidates — only when geometry supports it
  const ridgeCandidates: RidgeCandidate[] = [];
  if ((form === "gable" || form === "cross_gable") && confidence >= 35) {
    // For gable: ridge runs along dominant (eave) axis, centered between rake edges
    // Find rake-classified segment midpoints to estimate ridge endpoints
    const rakeEdges = edges.filter(e => e.classification === "likely_rake");
    if (rakeEdges.length >= 2) {
      const rakeMidpoints = rakeEdges.map(e => midpoint(e.start, e.end));
      // Ridge connects rake-side midpoints along the eave axis
      const ridgeLen = roundTo(dominantAxisLength, 0);
      if (ridgeLen > 5) {
        ridgeCandidates.push({
          start: rakeMidpoints[0] as [number, number],
          end: rakeMidpoints[1] as [number, number],
          length_ft: ridgeLen,
          bearing_deg: roundTo(dominantAxisBearing, 1),
          confidence: Math.min(confidence, 50),
          reasoning: `Inferred ridge along dominant axis (${roundTo(dominantAxisBearing)}°) between rake midpoints. Length approximated from longest eave segment. Footprint-proxy — actual ridge position depends on roof style and overhang.`,
        });
      }
    }
  }

  // Infer hip/valley candidates — only when confidence is sufficient
  const hipValleyCandidates: HipValleyCandidate[] = [];
  if (form === "hip" && confidence >= 40) {
    // Hip roof: diagonal lines from corners to ridge endpoints
    // Approximate: hip lines run from corners at ~45° to ridge
    const centroid = polygonCentroid(ring);
    const pts = ring[ring.length - 1][0] === ring[0][0] ? ring.slice(0, -1) : ring;
    // Each corner produces a hip line to the nearest ridge end
    // Only add if we have enough confidence
    const cornerCount = pts.length;
    if (cornerCount === 4) {
      // For a 4-sided hip: 4 hip lines from corners to ridge endpoints
      const hipLen = roundTo(Math.sqrt((dominantAxisLength / 2) ** 2 + (perpAxisLength / 2) ** 2), 0);
      if (hipLen > 5) {
        hipValleyCandidates.push({
          type: "hip",
          start: [pts[0][0], pts[0][1]] as [number, number],
          end: centroid,
          length_ft: hipLen,
          bearing_deg: roundTo(bearingDeg(pts[0], centroid), 1),
          confidence: Math.min(confidence - 10, 35),
          reasoning: `Inferred hip line from corner to approximate ridge end. Length estimated from building dimensions. Low confidence — actual hip geometry depends on roof pitch and overhang.`,
        });
      }
    }
  } else if (form === "cross_gable" && confidence >= 35) {
    // Cross gable: valley where wings meet
    const unknownEdges = edges.filter(e => e.classification === "unknown");
    for (const ue of unknownEdges) {
      hipValleyCandidates.push({
        type: "valley",
        start: ue.start,
        end: ue.end,
        length_ft: ue.length_ft,
        bearing_deg: ue.bearing_deg,
        confidence: Math.min(confidence - 10, 30),
        reasoning: `Potential valley at unclassified edge (segment #${ue.segment_index}). Wing junction often produces valleys. Very low confidence — requires visual confirmation.`,
      });
    }
  }

  return {
    inferred_roof_form: form,
    roof_form_confidence: confidence,
    roof_form_reasoning: reasoning,
    dominant_axis_bearing: roundTo(dominantAxisBearing, 1),
    dominant_axis_length_ft: roundTo(dominantAxisLength, 0),
    perpendicular_axis_length_ft: roundTo(perpAxisLength, 0),
    aspect_ratio: aspectRatio,
    ridge_candidates: ridgeCandidates,
    hip_valley_candidates: hipValleyCandidates,
  };
}

// ── External data fetchers ───────────────────────────────────────────

async function geocodeAddress(address: string): Promise<{ lat: number; lng: number; matchedAddress: string } | null> {
  const url = `https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?address=${encodeURIComponent(address)}&benchmark=Public_AR_Current&format=json`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const matches = data?.result?.addressMatches;
    if (!matches || matches.length === 0) return null;
    const m = matches[0];
    return { lat: m.coordinates.y, lng: m.coordinates.x, matchedAddress: m.matchedAddress };
  } catch { return null; }
}

async function fetchParcelContext(lat: number, lng: number) {
  try {
    const njUrl = `https://services2.arcgis.com/XVOqAjTOJ5P6ngMu/arcgis/rest/services/Parcels_in_New_Jersey/FeatureServer/0/query?geometry=${lng},${lat}&geometryType=esriGeometryPoint&spatialRel=esriSpatialRelIntersects&outFields=*&returnGeometry=true&f=json`;
    const res = await fetch(njUrl, { signal: AbortSignal.timeout(8000) });
    if (res.ok) {
      const data = await res.json();
      if (data.features?.length > 0) {
        const attrs = data.features[0].attributes;
        return {
          parcelArea: attrs.SHAPE_Area ? Math.round(attrs.SHAPE_Area * 10.764) : undefined,
          landUse: attrs.PROP_CLASS || attrs.MOD4_DESC || undefined,
          yearBuilt: attrs.YR_BUILT || undefined,
          source: "NJ Parcels ArcGIS",
        };
      }
    }
  } catch { /* continue */ }
  return null;
}

async function getElevation(lat: number, lng: number): Promise<number | null> {
  try {
    const url = `https://epqs.nationalmap.gov/v1/json?x=${lng}&y=${lat}&wkid=4326&units=Feet&includeDate=false`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.value ?? null;
  } catch { return null; }
}

// ── Phase 2A+2B: Footprint extraction with multi-candidate support ───

// Source ladder priority (higher = preferred):
// 1. Microsoft Building Footprints (from building_footprints table) — authoritative, ML-extracted
// 2. NJGIN Building Footprints — state-authoritative GIS
// 3. Esri USA Structures — Microsoft via Esri hosting
// 4. OpenStreetMap — community-contributed
// 5. User-drawn outline (handled separately)
// 6. AI Vision footprint (last resort)

const SOURCE_PRIORITY: Record<string, number> = {
  "Microsoft Building Footprints (Local DB)": 100,
  "NJGIN Building Footprints": 90,
  "Microsoft Building Footprints (Esri)": 80,
  "OpenStreetMap Building Footprints": 60,
  "AI Vision Estimate (satellite imagery)": 20,
  "Default Residential Fallback (no GIS or vision data)": 10,
};

interface CandidateScore {
  total: number;
  source_priority: number;
  centroid_offset_score: number;
  area_sanity_score: number;
  vertex_quality_score: number;
  shape_conflict_score: number;
  breakdown: string;
}

/** Score a candidate footprint for selection. Higher = better. */
function scoreCandidateFootprint(
  candidate: CandidateFootprint,
  geocodeLat: number,
  geocodeLng: number,
  visionAreaHint: number | null,
): CandidateScore {
  // 1. Source priority (0-100)
  const sourcePriority = SOURCE_PRIORITY[candidate.source] ?? 50;

  // 2. Centroid offset score (0-100): closer to geocode = better
  const offsetFt = candidate.geometry_metadata?.centroid_offset_ft ??
    haversineDistFt([geocodeLng, geocodeLat], polygonCentroid(candidate.polygon));
  let centroidScore = 100;
  if (offsetFt > 200) centroidScore = 10;
  else if (offsetFt > 150) centroidScore = 25;
  else if (offsetFt > 100) centroidScore = 40;
  else if (offsetFt > 50) centroidScore = 65;
  else if (offsetFt > 25) centroidScore = 85;

  // 3. Area sanity score (0-100): residential 800-5000 sqft is ideal
  let areaScore = 70;
  if (candidate.area_sqft >= 800 && candidate.area_sqft <= 5000) areaScore = 100;
  else if (candidate.area_sqft >= 500 && candidate.area_sqft <= 8000) areaScore = 80;
  else if (candidate.area_sqft < 300) areaScore = 20;
  else if (candidate.area_sqft > 15000) areaScore = 30;

  // 4. Vertex quality score (0-100): 4-12 vertices ideal for residential
  const vCount = candidate.geometry_metadata?.vertex_count ?? candidate.polygon.length;
  let vertexScore = 60;
  if (vCount >= 4 && vCount <= 12) vertexScore = 100;
  else if (vCount >= 3 && vCount <= 20) vertexScore = 75;
  else if (vCount > 30) vertexScore = 30;
  else if (vCount < 3) vertexScore = 10;

  // 5. Shape conflict with vision area hint (0-100)
  let shapeConflictScore = 80; // default: no conflict
  if (visionAreaHint && visionAreaHint > 0) {
    const areaRatio = candidate.area_sqft / visionAreaHint;
    if (areaRatio >= 0.7 && areaRatio <= 1.4) shapeConflictScore = 100;
    else if (areaRatio >= 0.5 && areaRatio <= 2.0) shapeConflictScore = 60;
    else shapeConflictScore = 20;
  }

  // Weighted total
  const total = Math.round(
    sourcePriority * 0.30 +
    centroidScore * 0.30 +
    areaScore * 0.15 +
    vertexScore * 0.10 +
    shapeConflictScore * 0.15
  );

  return {
    total,
    source_priority: sourcePriority,
    centroid_offset_score: centroidScore,
    area_sanity_score: areaScore,
    vertex_quality_score: vertexScore,
    shape_conflict_score: shapeConflictScore,
    breakdown: `src=${sourcePriority} offset=${centroidScore} area=${areaScore} vtx=${vertexScore} conflict=${shapeConflictScore} → ${total}`,
  };
}

/** Fetch Microsoft Building Footprints from the local building_footprints PostGIS table.
 *  Search radius: 1000ft so Darwin can still surface authoritative geometry when
 *  geocoding is slightly offset from the targeted ingestion coordinates.
 */
async function fetchMSBuildingFootprintFromDB(
  lat: number,
  lng: number,
  supabase: any,
): Promise<CandidateFootprint[]> {
  try {
    const SEARCH_RADIUS_FT = 1000;
    const searchRadiusDeg = SEARCH_RADIUS_FT / 364000;
    const { data, error } = await supabase.rpc("find_nearest_building_footprint", {
      search_lat: lat,
      search_lng: lng,
      search_radius: searchRadiusDeg,
    });

    if (error) {
      // Fallback: simple centroid proximity query with expanded authoritative buffer
      console.log(`[Darwin Roof] PostGIS RPC unavailable, using centroid fallback path: ${error.message}`);
      const latBuf = searchRadiusDeg;
      const lngBuf = searchRadiusDeg / Math.max(Math.cos(toRad(lat)), 0.000001);
      const { data: fallbackData, error: fallbackErr } = await supabase
        .from("building_footprints")
        .select("*")
        .gte("centroid_lat", lat - latBuf)
        .lte("centroid_lat", lat + latBuf)
        .gte("centroid_lng", lng - lngBuf)
        .lte("centroid_lng", lng + lngBuf)
        .order("area_sqft", { ascending: false })
        .limit(10);

      const rowCount = fallbackData?.length ?? 0;
      console.log(`[Darwin Roof] MS DB centroid fallback (${SEARCH_RADIUS_FT}ft radius): ${rowCount} rows returned from building_footprints query`);

      if (fallbackErr || !fallbackData?.length) {
        console.log("[Darwin Roof] MS Building Footprints (DB): no results found via centroid fallback");
        return [];
      }

      // Log ALL nearby footprint distances for diagnostics
      for (const row of fallbackData) {
        const d = haversineDistFt([lng, lat], [row.centroid_lng, row.centroid_lat]);
        console.log(`[Darwin Roof] MS DB nearby: source_id=${row.source_id} area=${row.area_sqft}sqft dist=${roundTo(d, 1)}ft centroid=(${row.centroid_lat},${row.centroid_lng})`);
      }

      const dedupedRows = Array.from(
        new Map(
          fallbackData.map((row: any) => [`${row.source ?? "microsoft"}-${row.source_id ?? row.id}`, row]),
        ).values(),
      );

      const candidates = dedupedRows
        .map((row: any) => {
          const dist = haversineDistFt([lng, lat], [row.centroid_lng, row.centroid_lat]);
          return buildCandidateFromDBRow(row, lat, lng, dist);
        })
        .filter((candidate): candidate is CandidateFootprint => Boolean(candidate))
        .sort((a, b) => (a.geometry_metadata?.centroid_offset_ft ?? 999999) - (b.geometry_metadata?.centroid_offset_ft ?? 999999));

      const nearestDist = candidates[0]?.geometry_metadata?.centroid_offset_ft ?? null;
      console.log(`[Darwin Roof] MS DB centroid fallback: nearest centroid distance = ${nearestDist != null ? roundTo(nearestDist, 1) : "n/a"}ft (search coords: ${lat},${lng})`);

      return candidates;
    }

    const rowCount = data?.length ?? 0;
    console.log(`[Darwin Roof] MS DB PostGIS RPC path (${SEARCH_RADIUS_FT}ft radius): ${rowCount} rows returned from building_footprints query`);

    if (!data || data.length === 0) {
      console.log("[Darwin Roof] MS Building Footprints (DB): no results within search radius via PostGIS RPC");
      return [];
    }

    // Log all returned rows for diagnostics
    for (const row of data) {
      const d = haversineDistFt([lng, lat], [row.centroid_lng, row.centroid_lat]);
      console.log(`[Darwin Roof] MS DB RPC nearby: source_id=${row.source_id} area=${row.area_sqft}sqft dist=${roundTo(d, 1)}ft`);
    }

    const dedupedRows = Array.from(
      new Map(
        data.map((row: any) => [`${row.source ?? "microsoft"}-${row.source_id ?? row.id}`, row]),
      ).values(),
    );

    const candidates = dedupedRows
      .map((row: any) => {
        const dist = haversineDistFt([lng, lat], [row.centroid_lng, row.centroid_lat]);
        return buildCandidateFromDBRow(row, lat, lng, dist);
      })
      .filter((candidate): candidate is CandidateFootprint => Boolean(candidate))
      .sort((a, b) => (a.geometry_metadata?.centroid_offset_ft ?? 999999) - (b.geometry_metadata?.centroid_offset_ft ?? 999999));

    const nearestDist = candidates[0]?.geometry_metadata?.centroid_offset_ft ?? null;
    console.log(`[Darwin Roof] MS DB PostGIS RPC: nearest centroid distance = ${nearestDist != null ? roundTo(nearestDist, 1) : "n/a"}ft (search coords: ${lat},${lng})`);
    return candidates;
  } catch (e) {
    console.log("[Darwin Roof] MS Building Footprints (DB) query failed:", e instanceof Error ? e.message : e);
    return [];
  }
}

function buildCandidateFromDBRow(
  row: any,
  geocodeLat: number,
  geocodeLng: number,
  distFt: number,
): CandidateFootprint | null {
  // If the row has a geometry_json field (from RPC), parse it
  // Otherwise build a ring from bbox as approximation
  let ring: number[][] | null = null;

  if (row.geometry_json) {
    // PostGIS ST_AsGeoJSON result
    try {
      const geom = typeof row.geometry_json === "string" ? JSON.parse(row.geometry_json) : row.geometry_json;
      if (geom?.coordinates?.[0]) {
        ring = geom.coordinates[0];
      }
    } catch { /* continue */ }
  }

  if (!ring && row.bbox) {
    // Approximate from bbox
    const b = typeof row.bbox === "string" ? JSON.parse(row.bbox) : row.bbox;
    if (b.minLng && b.minLat && b.maxLng && b.maxLat) {
      ring = [
        [b.minLng, b.minLat],
        [b.maxLng, b.minLat],
        [b.maxLng, b.maxLat],
        [b.minLng, b.maxLat],
        [b.minLng, b.minLat],
      ];
    }
  }

  if (!ring || ring.length < 4) return null;

  const areaSqft = row.area_sqft || polygonAreaSqft(ring);
  if (areaSqft < 100 || areaSqft > 50000) return null;

  const perimeterFt = polygonPerimeterFt(ring);
  const featureId = row.source_id || row.id;
  const metadata = buildGeometryMetadata(ring, "Microsoft Building Footprints (Local DB)", featureId, geocodeLat, geocodeLng);

  // MS footprints get a quality bonus (authoritative, ML-extracted from high-res imagery)
  const baseQuality = computeGeometryQuality(ring, areaSqft, metadata.centroid_offset_ft);
  const qualityScore = Math.min(100, baseQuality + 15); // +15 bonus for authoritative source

  const edges = classifyEdges(ring);
  const geojson = {
    type: "Feature",
    properties: { source: "Microsoft Building Footprints (Local DB)", source_id: featureId, state: row.state },
    geometry: { type: "Polygon", coordinates: [ring] },
  };

  console.log(`[Darwin Roof] MS Building Footprints (DB): found ${featureId} (${areaSqft} sqft, ${roundTo(distFt)}ft from geocode, quality=${qualityScore})`);

  return {
    polygon: ring,
    area_sqft: areaSqft,
    perimeter_ft: perimeterFt,
    source: "Microsoft Building Footprints (Local DB)",
    source_feature_id: featureId,
    imagery_date: null,
    geometry_quality_score: qualityScore,
    geometry_metadata: metadata,
    edge_classifications: edges,
    geojson,
  };
}

async function fetchAllCandidateFootprints(
  lat: number,
  lng: number,
  supabase?: any,
): Promise<CandidateFootprint[]> {
  const candidates: CandidateFootprint[] = [];

  // Source ladder: fetch all sources in parallel, prioritize by scoring
  const msPromise = supabase
    ? fetchMSBuildingFootprintFromDB(lat, lng, supabase)
    : Promise.resolve([] as CandidateFootprint[]);

  const promises: Promise<any>[] = [
    fetchOSMBuildingCandidates(lat, lng),
    fetchNJBuildingCandidate(lat, lng),
    fetchEsriUSAStructuresCandidate(lat, lng),
    msPromise,
  ];

  const [osmResults, njResult, esriResult, msDbResults] = await Promise.all(promises);

  // Add in source-priority order (MS DB first)
  candidates.push(...msDbResults);
  if (njResult) candidates.push(njResult);
  if (esriResult) candidates.push(esriResult);
  candidates.push(...(osmResults || []));

  // Deduplicate: if two candidates overlap significantly (>80% area match), keep the higher quality one
  const deduped: CandidateFootprint[] = [];
  for (const c of candidates) {
    const isDuplicate = deduped.some(existing => {
      const areaRatio = Math.min(c.area_sqft, existing.area_sqft) / Math.max(c.area_sqft, existing.area_sqft);
      return areaRatio > 0.8 && existing.geometry_quality_score >= c.geometry_quality_score;
    });
    if (!isDuplicate) deduped.push(c);
  }

  // Score and sort by composite candidate score
  const scored = deduped.map(c => ({
    candidate: c,
    score: scoreCandidateFootprint(c, lat, lng, null),
  }));
  scored.sort((a, b) => b.score.total - a.score.total);

  const msCount = msDbResults.length;
  console.log(`[Darwin Roof] Found ${scored.length} candidate footprints (${msCount} MS-DB, ${(osmResults || []).length} OSM, ${njResult ? 1 : 0} NJGIN, ${esriResult ? 1 : 0} Esri)`);
  for (const s of scored) {
    console.log(`[Darwin Roof]   → ${s.candidate.source}: ${s.candidate.area_sqft}sqft, score=${s.score.total} (${s.score.breakdown})`);
  }

  return scored.map(s => s.candidate);
}

/**
 * AI Vision Footprint Estimation: when all polygon sources fail,
 * use satellite imagery + AI to estimate building dimensions and
 * create a synthetic rectangular footprint.
 */
async function estimateFootprintFromVision(
  tileGrid: { base64: string; row: number; col: number }[],
  address: string,
  lat: number,
  lng: number,
): Promise<CandidateFootprint | null> {
  const LOVABLE_AI_KEY = Deno.env.get("LOVABLE_API_KEY");
  if (!LOVABLE_AI_KEY || tileGrid.length === 0) return null;

  try {
    const imageContent: any[] = [];
    const gridSize = Math.round(Math.sqrt(tileGrid.length));
    imageContent.push({
      type: "text",
      text: `${tileGrid.length} satellite tiles in a ${gridSize}×${gridSize} grid for ${address}. The CENTER tile contains the property.\n\nYou are a building footprint estimator. Estimate the building's footprint dimensions from this aerial imagery. Look at the building's roof outline and estimate its approximate length and width in feet. Also estimate the compass bearing of the building's long axis (0-360 degrees, where 0=North).`,
    });
    const sorted = [...tileGrid].sort((a, b) => a.row !== b.row ? a.row - b.row : a.col - b.col);
    for (const tile of sorted) {
      imageContent.push({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${tile.base64}` } });
    }

    const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${LOVABLE_AI_KEY}` },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          {
            role: "system",
            content: `You estimate building footprint dimensions from aerial/satellite imagery. You MUST provide estimates — do NOT refuse or say you cannot determine dimensions. Use visual cues like roof shadow length, comparison to driveways (~10ft wide), cars (~6x15ft), sidewalks (~4ft), and standard residential features.

RULES:
- Estimate length (longer dimension) and width (shorter dimension) in feet
- length_ft should be the LONGER dimension, width_ft the SHORTER
- Typical US residential: 30-80ft long, 25-50ft wide
- Estimate bearing of the long axis in degrees (0=North, 90=East)
- Provide confidence 0-100
- ALWAYS provide a best estimate even if uncertain`,
          },
          { role: "user", content: imageContent },
        ],
        temperature: 0.1,
        max_tokens: 1000,
        tools: [{
          type: "function",
          function: {
            name: "estimate_footprint",
            description: "Estimate building footprint dimensions from satellite imagery",
            parameters: {
              type: "object",
              properties: {
                length_ft: { type: "number", description: "Longer building dimension in feet" },
                width_ft: { type: "number", description: "Shorter building dimension in feet" },
                bearing_deg: { type: "number", description: "Compass bearing of long axis (0-360)" },
                confidence: { type: "number", description: "Confidence 0-100" },
                notes: { type: "string", description: "Brief notes on estimation method" },
              },
              required: ["length_ft", "width_ft", "bearing_deg", "confidence", "notes"],
              additionalProperties: false,
            },
          },
        }],
        tool_choice: { type: "function", function: { name: "estimate_footprint" } },
      }),
    });

    if (!response.ok) {
      console.error("[Darwin Roof] Vision footprint estimation error:", response.status);
      return null;
    }

    const result = await response.json();
    const toolCall = result.choices?.[0]?.message?.tool_calls?.[0];
    let parsed: any;
    if (toolCall?.function?.arguments) {
      parsed = typeof toolCall.function.arguments === "string"
        ? JSON.parse(toolCall.function.arguments)
        : toolCall.function.arguments;
    } else {
      const content = result.choices?.[0]?.message?.content || "";
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return null;
      parsed = JSON.parse(jsonMatch[0]);
    }

    const lengthFt = Math.max(20, Math.min(200, Number(parsed.length_ft) || 50));
    const widthFt = Math.max(15, Math.min(150, Number(parsed.width_ft) || 30));
    const bearingDegVal = Number(parsed.bearing_deg) || 0;
    const conf = clamp(Number(parsed.confidence) || 30, 10, 70);

    console.log(`[Darwin Roof] Vision footprint estimate: ${lengthFt}ft x ${widthFt}ft, bearing=${bearingDegVal}°, confidence=${conf}% — "${parsed.notes}"`);

    // Create a synthetic rectangular footprint polygon centered on the geocoded point
    const areaSqft = roundTo(lengthFt * widthFt, 0);
    const halfL = lengthFt / 2;
    const halfW = widthFt / 2;
    const bearingRad = toRad(bearingDegVal);

    // Compute 4 corners of the rectangle in lat/lng
    // Each corner is offset from center by (halfL along bearing, halfW perpendicular)
    const corners: [number, number][] = [];
    const offsets = [
      [-halfL, -halfW],
      [halfL, -halfW],
      [halfL, halfW],
      [-halfL, halfW],
    ];
    for (const [along, perp] of offsets) {
      const dxFt = along * Math.sin(bearingRad) + perp * Math.cos(bearingRad);
      const dyFt = along * Math.cos(bearingRad) - perp * Math.sin(bearingRad);
      const dLat = dyFt / 364000; // ~364000 ft per degree lat
      const dLng = dxFt / (364000 * Math.cos(toRad(lat))); // adjust for longitude
      corners.push([lng + dLng, lat + dLat]);
    }
    // Close the ring
    const ring: number[][] = [...corners, [corners[0][0], corners[0][1]]];

    const perimeterFt = roundTo(2 * (lengthFt + widthFt), 0);
    const metadata = buildGeometryMetadata(ring, "AI Vision Estimate", null, lat, lng);
    // Lower quality score since this is AI-estimated
    const qualityScore = Math.min(conf, 40);
    const edges = classifyEdges(ring);

    const geojson = {
      type: "Feature",
      properties: { source: "AI Vision Estimate", length_ft: lengthFt, width_ft: widthFt, bearing: bearingDegVal, notes: parsed.notes },
      geometry: { type: "Polygon", coordinates: [ring] },
    };

    return {
      polygon: ring,
      area_sqft: areaSqft,
      perimeter_ft: perimeterFt,
      source: "AI Vision Estimate (satellite imagery)",
      source_feature_id: null,
      imagery_date: null,
      geometry_quality_score: qualityScore,
      geometry_metadata: metadata,
      edge_classifications: edges,
      geojson,
    };
  } catch (e) {
    console.error("[Darwin Roof] Vision footprint estimation failed:", e);
    return null;
  }
}

async function fetchOSMBuildingCandidates(lat: number, lng: number): Promise<CandidateFootprint[]> {
  try {
    const radius = 0.0008; // ~90m radius — increased from 0.0003 for better coverage
    const bbox = `${lat - radius},${lng - radius},${lat + radius},${lng + radius}`;
    const query = `[out:json][timeout:10];way["building"](${bbox});out body geom;`;
    const url = `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
    if (!res.ok) return [];
    const data = await res.json();

    const buildings = data.elements?.filter((e: any) => e.type === "way" && e.geometry?.length > 2);
    if (!buildings || buildings.length === 0) return [];

    const results: CandidateFootprint[] = [];

    for (const b of buildings) {
      const ring: number[][] = b.geometry.map((g: any) => [g.lon, g.lat]);
      if (ring.length > 0 && (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1])) {
        ring.push([...ring[0]]);
      }

      const areaSqft = polygonAreaSqft(ring);
      if (areaSqft < 100 || areaSqft > 50000) continue;

      const perimeterFt = polygonPerimeterFt(ring);
      const featureId = b.id ? String(b.id) : null;
      const metadata = buildGeometryMetadata(ring, "OpenStreetMap", featureId, lat, lng);
      const qualityScore = computeGeometryQuality(ring, areaSqft, metadata.centroid_offset_ft);
      const edges = classifyEdges(ring);

      const geojson = {
        type: "Feature",
        properties: { source: "OpenStreetMap", osm_id: b.id },
        geometry: { type: "Polygon", coordinates: [ring] },
      };

      results.push({
        polygon: ring,
        area_sqft: areaSqft,
        perimeter_ft: perimeterFt,
        source: "OpenStreetMap Building Footprints",
        source_feature_id: featureId,
        imagery_date: null,
        geometry_quality_score: qualityScore,
        geometry_metadata: metadata,
        edge_classifications: edges,
        geojson,
      });
    }

    return results;
  } catch { return []; }
}

async function fetchNJBuildingCandidate(lat: number, lng: number): Promise<CandidateFootprint | null> {
  try {
    // Use envelope buffer ~152m / 500ft to match MS DB search radius
    const buf = 0.00137; // ~152m / ~500ft
    const envelope = `${lng - buf},${lat - buf},${lng + buf},${lat + buf}`;
    const url = `https://services2.arcgis.com/XVOqAjTOJ5P6ngMu/arcgis/rest/services/Building_Footprints_of_NJ/FeatureServer/0/query?geometry=${envelope}&geometryType=esriGeometryEnvelope&spatialRel=esriSpatialRelIntersects&outFields=*&returnGeometry=true&outSR=4326&f=json&resultRecordCount=10`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.features?.length) return null;

    // Find the feature nearest to the geocoded point
    let bestFeat = data.features[0];
    let bestDist = Infinity;
    for (const feat of data.features) {
      if (feat.geometry?.rings?.[0]) {
        const centroid = polygonCentroid(feat.geometry.rings[0]);
        const dist = haversineDistFt([lng, lat], centroid);
        if (dist < bestDist) { bestDist = dist; bestFeat = feat; }
      }
    }
    const feat = bestFeat;

    const rings = feat.geometry?.rings;
    if (!rings || rings.length === 0) return null;

    const ring: number[][] = rings[0];
    const areaSqft = polygonAreaSqft(ring);
    if (areaSqft < 100 || areaSqft > 50000) return null;

    const perimeterFt = polygonPerimeterFt(ring);
    const featureId = feat.attributes?.OBJECTID ? String(feat.attributes.OBJECTID) : null;
    const metadata = buildGeometryMetadata(ring, "NJGIN Building Footprints", featureId, lat, lng);
    const qualityScore = computeGeometryQuality(ring, areaSqft, metadata.centroid_offset_ft);
    const edges = classifyEdges(ring);

    const geojson = {
      type: "Feature",
      properties: { source: "NJGIN Building Footprints", ...(feat.attributes || {}) },
      geometry: { type: "Polygon", coordinates: [ring] },
    };

    console.log(`[Darwin Roof] NJGIN: found building ${featureId} (${areaSqft} sqft, ${roundTo(bestDist)}ft from geocode)`);

    return {
      polygon: ring,
      area_sqft: areaSqft,
      perimeter_ft: perimeterFt,
      source: "NJGIN Building Footprints",
      source_feature_id: featureId,
      imagery_date: feat.attributes?.PHOTO_DATE || feat.attributes?.SOURCE_DATE || null,
      geometry_quality_score: qualityScore,
      geometry_metadata: metadata,
      edge_classifications: edges,
      geojson,
    };
  } catch (e) {
    console.log("[Darwin Roof] NJGIN fetch failed:", e);
    return null;
  }
}

/** Fetch building footprint from Esri USA Structures (AI-extracted, near-universal US coverage). */
async function fetchEsriUSAStructuresCandidate(lat: number, lng: number): Promise<CandidateFootprint | null> {
  // Try multiple endpoints with retry logic
  const endpoints = [
    `https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/MSBFP2/FeatureServer/0/query?geometry=${lng - 0.00137},${lat - 0.00137},${lng + 0.00137},${lat + 0.00137}&geometryType=esriGeometryEnvelope&spatialRel=esriSpatialRelIntersects&outFields=*&returnGeometry=true&outSR=4326&f=json&resultRecordCount=10`,
    `https://services2.arcgis.com/FiaPA4ga0iQKduv3/arcgis/rest/services/USA_Structures_Footprints/FeatureServer/0/query?geometry=${lng - 0.00137},${lat - 0.00137},${lng + 0.00137},${lat + 0.00137}&geometryType=esriGeometryEnvelope&spatialRel=esriSpatialRelIntersects&outFields=*&returnGeometry=true&outSR=4326&f=json&resultRecordCount=10`,
  ];

  for (const url of endpoints) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
        if (!res.ok) continue;
        const data = await res.json();
        if (!data.features?.length) continue;

        // Find nearest to geocode point
        let nearest = data.features[0];
        let nearestDist = Infinity;
        for (const feat of data.features) {
          if (feat.geometry?.rings?.[0]) {
            const centroid = polygonCentroid(feat.geometry.rings[0]);
            const dist = haversineDistFt([lng, lat], centroid);
            if (dist < nearestDist) { nearestDist = dist; nearest = feat; }
          }
        }
        const result = processEsriFeature(nearest, lat, lng, "Microsoft Building Footprints (Esri)");
        if (result) {
          console.log(`[Darwin Roof] Esri: found building (${result.area_sqft} sqft, ${roundTo(nearestDist)}ft from geocode, attempt ${attempt + 1})`);
          return result;
        }
      } catch (e) {
        console.log(`[Darwin Roof] Esri endpoint attempt ${attempt + 1} failed:`, e instanceof Error ? e.message : e);
        // Brief pause before retry
        if (attempt === 0) await new Promise(r => setTimeout(r, 500));
      }
    }
  }
  return null;
}

function processEsriFeature(feat: any, lat: number, lng: number, sourceName: string): CandidateFootprint | null {
  const rings = feat.geometry?.rings;
  if (!rings || rings.length === 0) return null;
  const ring: number[][] = rings[0];
  if (ring.length < 4) return null;
  const areaSqft = polygonAreaSqft(ring);
  if (areaSqft < 100 || areaSqft > 50000) return null;
  const perimeterFt = polygonPerimeterFt(ring);
  const featureId = feat.attributes?.OBJECTID ? String(feat.attributes.OBJECTID) : (feat.attributes?.GlobalID || null);
  const metadata = buildGeometryMetadata(ring, sourceName, featureId, lat, lng);
  const qualityScore = computeGeometryQuality(ring, areaSqft, metadata.centroid_offset_ft);
  const edges = classifyEdges(ring);
  const geojson = {
    type: "Feature",
    properties: { source: sourceName, ...(feat.attributes || {}) },
    geometry: { type: "Polygon", coordinates: [ring] },
  };
  return {
    polygon: ring,
    area_sqft: areaSqft,
    perimeter_ft: perimeterFt,
    source: sourceName,
    source_feature_id: featureId,
    imagery_date: feat.attributes?.CAPTURE_DATE || feat.attributes?.LASTMODDATE || null,
    geometry_quality_score: qualityScore,
    geometry_metadata: metadata,
    edge_classifications: edges,
    geojson,
  };
}
// Vision is used for CLASSIFICATION only (form, pitch band, facet count, obstructions).
// Footprint geometry remains the source of truth for area and perimeter-derived values.
// Vision results refine uncertainty or suppress weak geometry inferences.

/** Encode a single tile to base64, returning null on failure. */
async function fetchTileBase64(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) { await res.text().catch(() => {}); return null; }
    const ct = res.headers.get("content-type") || "";
    if (!ct.includes("image")) { await res.text().catch(() => {}); return null; }
    const buf = await res.arrayBuffer();
    const bytes = new Uint8Array(buf);
    if (bytes.length < 500) return null;
    let binary = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  } catch { return null; }
}

/** Fetch a grid of satellite tiles centered on lat/lng. */
async function fetchSatelliteTileGrid(
  lat: number, lng: number, gridSize: number = 3, zoom: number = 20,
): Promise<{ base64: string; row: number; col: number; tileX: number; tileY: number }[]> {
  const tileX = Math.floor((lng + 180) / 360 * Math.pow(2, zoom));
  const latRad = lat * Math.PI / 180;
  const tileY = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * Math.pow(2, zoom));
  const half = Math.floor(gridSize / 2);
  console.log(`[Darwin Roof] Fetching ${gridSize}x${gridSize} tile grid at zoom ${zoom}, center: ${tileX},${tileY}`);
  const tilePromises: { row: number; col: number; url: string; tileX: number; tileY: number }[] = [];
  for (let dy = -half; dy <= half; dy++) {
    for (let dx = -half; dx <= half; dx++) {
      const tx = tileX + dx;
      const ty = tileY + dy;
      tilePromises.push({ row: dy + half, col: dx + half, tileX: tx, tileY: ty,
        url: `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${zoom}/${ty}/${tx}` });
    }
  }
  const results = await Promise.all(tilePromises.map(async (t) => {
    const b64 = await fetchTileBase64(t.url);
    return b64 ? { base64: b64, row: t.row, col: t.col, tileX: t.tileX, tileY: t.tileY } : null;
  }));
  const successful = results.filter((r): r is NonNullable<typeof r> => r !== null);
  console.log(`[Darwin Roof] Fetched ${successful.length}/${tilePromises.length} tiles successfully`);
  return successful;
}

/** Fetch satellite tiles from Google Maps as fallback when ArcGIS has no coverage. */
async function fetchGoogleSatelliteTiles(
  lat: number, lng: number,
): Promise<{ base64: string; row: number; col: number; tileX: number; tileY: number }[]> {
  const zoom = 19;
  const tileX = Math.floor((lng + 180) / 360 * Math.pow(2, zoom));
  const latRad = lat * Math.PI / 180;
  const tileY = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * Math.pow(2, zoom));
  
  const tiles: { row: number; col: number; url: string; tileX: number; tileY: number }[] = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const tx = tileX + dx;
      const ty = tileY + dy;
      tiles.push({
        row: dy + 1, col: dx + 1, tileX: tx, tileY: ty,
        url: `https://mt1.google.com/vt/lyrs=s&x=${tx}&y=${ty}&z=${zoom}`,
      });
    }
  }
  
  const results = await Promise.all(tiles.map(async (t) => {
    const b64 = await fetchTileBase64(t.url);
    return b64 ? { base64: b64, row: t.row, col: t.col, tileX: t.tileX, tileY: t.tileY } : null;
  }));
  const successful = results.filter((r): r is NonNullable<typeof r> => r !== null);
  if (successful.length > 0) {
    console.log(`[Darwin Roof] Google satellite: fetched ${successful.length}/${tiles.length} tiles`);
  }
  return successful;
}

function normalizeVisionResult(parsed: any): SatelliteVisionResult {
  const validBands: PitchBand[] = ["flat", "low", "moderate", "steep", "very_steep", "unknown"];
  const validShadow = ["none", "light", "moderate", "heavy"];
  return {
    roof_form: {
      value: parsed.roof_form?.value ?? "unknown",
      confidence: clamp(Number(parsed.roof_form?.confidence) || 0, 0, 100),
      abstain: !!parsed.roof_form?.abstain,
      reasoning: parsed.roof_form?.reasoning ?? "",
    },
    pitch_band: {
      value: (validBands.includes(parsed.pitch_band?.value) ? parsed.pitch_band.value : "unknown") as PitchBand,
      confidence: clamp(Number(parsed.pitch_band?.confidence) || 0, 0, 100),
      abstain: !!parsed.pitch_band?.abstain,
      reasoning: parsed.pitch_band?.reasoning ?? "",
    },
    visible_facets: {
      value: Math.max(0, Math.round(Number(parsed.visible_facets?.value) || 0)),
      confidence: clamp(Number(parsed.visible_facets?.confidence) || 0, 0, 100),
      abstain: !!parsed.visible_facets?.abstain,
      reasoning: parsed.visible_facets?.reasoning ?? "",
    },
    obstructions: {
      tree_cover_pct: clamp(Number(parsed.obstructions?.tree_cover_pct) || 0, 0, 100),
      shadow_coverage: (validShadow.includes(parsed.obstructions?.shadow_coverage) ? parsed.obstructions.shadow_coverage : "light") as any,
      rear_slope_visible: parsed.obstructions?.rear_slope_visible !== false,
      visible_sides: clamp(Math.round(Number(parsed.obstructions?.visible_sides) || 4), 1, 4),
      obstructions: Array.isArray(parsed.obstructions?.obstructions) ? parsed.obstructions.obstructions : [],
      confidence: clamp(Number(parsed.obstructions?.confidence) || 0, 0, 100),
    },
    roof_color: parsed.roof_color ?? null,
    overall_image_quality: clamp(Number(parsed.overall_image_quality) || 50, 0, 100),
    analysis_notes: parsed.analysis_notes ?? "",
  };
}

/**
 * Split-task satellite vision classification.
 * Returns structured per-task results with confidence and abstain flags.
 * Does NOT produce measurements — only classifications.
 */
async function classifyRoofFromSatellite(
  tileGrid: { base64: string; row: number; col: number }[],
  address: string,
  footprintAreaSqft: number | null,
): Promise<SatelliteVisionResult | null> {
  const LOVABLE_AI_KEY = Deno.env.get("LOVABLE_API_KEY");
  if (!LOVABLE_AI_KEY || tileGrid.length === 0) return null;

  try {
    const imageContent: any[] = [];
    if (tileGrid.length > 1) {
      const gridSize = Math.round(Math.sqrt(tileGrid.length));
      imageContent.push({ type: "text", text: `${tileGrid.length} satellite tiles in a ${gridSize}×${gridSize} grid for ${address}. CENTER tile has the property.${footprintAreaSqft ? ` Known footprint: ~${footprintAreaSqft} sqft.` : ""}\n\nYou are a CLASSIFIER, not a measurer. For each task, report confidence (0-100) and set abstain=true if you genuinely cannot determine.` });
      const sorted = [...tileGrid].sort((a, b) => a.row !== b.row ? a.row - b.row : a.col - b.col);
      for (const tile of sorted) {
        imageContent.push({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${tile.base64}` } });
      }
    } else {
      imageContent.push({ type: "text", text: `Satellite image of ${address}.${footprintAreaSqft ? ` Footprint: ~${footprintAreaSqft} sqft.` : ""} Classify the roof.` });
      imageContent.push({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${tileGrid[0].base64}` } });
    }

    const systemPrompt = `You are a roof CLASSIFIER (not measurer). Classify roof characteristics from aerial imagery into discrete categories. Do NOT attempt to measure areas or linear dimensions.

TASK 1 — ROOF FORM: Identify the overall roof form.
Options: gable, hip, cross_gable, cross_hip, gambrel, mansard, flat, complex, unknown.
- gable: Ridge along long axis, slopes down two sides, triangular walls at ends.
- hip: All four sides slope, no vertical gable walls.
- cross_gable: Two+ gable sections intersecting, creating valleys.
- cross_hip: Like cross_gable but with hipped ends.
- complex: Multiple forms combined.

TASK 2 — PITCH BAND: Classify roof steepness into a BAND (not an exact pitch).
- "flat": 0-2/12 (nearly flat)
- "low": 2-4/12 (shallow, porches/garages)
- "moderate": 5-7/12 (standard residential)
- "steep": 8-10/12 (clearly steep, common in NJ)
- "very_steep": 11+/12 (very steep)
- "unknown": cannot determine
CRITICAL: Aerial imagery CANNOT determine exact pitch. Use bands only. If shadows suggest steepness but you can't narrow to a band, set abstain=true.

TASK 3 — VISIBLE FACETS: Count distinct visible roof planes/facets. Only count what you can actually see. Note if rear slopes are hidden.

TASK 4 — OBSTRUCTIONS: Report what prevents accurate classification.
- tree_cover_pct: 0-100, what percentage of the roof is obscured by tree canopy
- shadow_coverage: none/light/moderate/heavy
- rear_slope_visible: can you see the back of the building?
- visible_sides: 1-4, how many building sides are clearly visible
- obstructions: list of obstruction types (trees, shadows, neighboring buildings, etc.)

RULES:
- ABSTAIN rather than guess when visibility is poor (set abstain=true, confidence<15)
- Pitch from aerial is inherently imprecise — bands only, never exact values
- If tree cover >40%, abstain on pitch
- If only 1-2 sides visible, reduce facet confidence and note rear-slope invisibility`;

    const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${LOVABLE_AI_KEY}` },
      body: JSON.stringify({
        model: "google/gemini-2.5-pro",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: imageContent },
        ],
        temperature: 0.1,
        max_tokens: 2000,
        tools: [{
          type: "function",
          function: {
            name: "classify_roof",
            description: "Classify roof characteristics from satellite imagery",
            parameters: {
              type: "object",
              properties: {
                roof_form: {
                  type: "object",
                  properties: {
                    value: { type: "string", enum: ["gable", "hip", "cross_gable", "cross_hip", "gambrel", "mansard", "flat", "complex", "unknown"] },
                    confidence: { type: "number" },
                    abstain: { type: "boolean" },
                    reasoning: { type: "string" },
                  },
                  required: ["value", "confidence", "abstain", "reasoning"],
                  additionalProperties: false,
                },
                pitch_band: {
                  type: "object",
                  properties: {
                    value: { type: "string", enum: ["flat", "low", "moderate", "steep", "very_steep", "unknown"] },
                    confidence: { type: "number" },
                    abstain: { type: "boolean" },
                    reasoning: { type: "string" },
                  },
                  required: ["value", "confidence", "abstain", "reasoning"],
                  additionalProperties: false,
                },
                visible_facets: {
                  type: "object",
                  properties: {
                    value: { type: "number" },
                    confidence: { type: "number" },
                    abstain: { type: "boolean" },
                    reasoning: { type: "string" },
                  },
                  required: ["value", "confidence", "abstain", "reasoning"],
                  additionalProperties: false,
                },
                obstructions: {
                  type: "object",
                  properties: {
                    tree_cover_pct: { type: "number" },
                    shadow_coverage: { type: "string", enum: ["none", "light", "moderate", "heavy"] },
                    rear_slope_visible: { type: "boolean" },
                    visible_sides: { type: "number" },
                    obstructions: { type: "array", items: { type: "string" } },
                    confidence: { type: "number" },
                  },
                  required: ["tree_cover_pct", "shadow_coverage", "rear_slope_visible", "visible_sides", "obstructions", "confidence"],
                  additionalProperties: false,
                },
                roof_color: { type: "string" },
                overall_image_quality: { type: "number" },
                analysis_notes: { type: "string" },
              },
              required: ["roof_form", "pitch_band", "visible_facets", "obstructions", "roof_color", "overall_image_quality", "analysis_notes"],
              additionalProperties: false,
            },
          },
        }],
        tool_choice: { type: "function", function: { name: "classify_roof" } },
      }),
    });

    if (!response.ok) {
      console.error("Vision classification error:", response.status, await response.text().catch(() => ""));
      return null;
    }

    const result = await response.json();
    const toolCall = result.choices?.[0]?.message?.tool_calls?.[0];
    let parsed: any;
    if (toolCall?.function?.arguments) {
      parsed = typeof toolCall.function.arguments === "string"
        ? JSON.parse(toolCall.function.arguments)
        : toolCall.function.arguments;
    } else {
      // Fallback: parse content as JSON
      const content = result.choices?.[0]?.message?.content || "";
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) { console.warn("[Darwin Roof] Vision returned no structured output"); return null; }
      parsed = JSON.parse(jsonMatch[0]);
    }

    return normalizeVisionResult(parsed);
  } catch (e) {
    console.error("Vision classification failed:", e);
    return null;
  }
}

/**
 * Suppression engine: applies rules to reduce confidence or force abstain
 * based on obstructions, image quality, and geometry-vision conflicts.
 */
function applyVisionSuppressions(
  vision: SatelliteVisionResult,
  geometryQuality: number | null,
  geometryRoofForm: RoofForm | null,
  geometryRoofFormConfidence: number | null,
): { refined: SatelliteVisionResult; suppressions: SuppressionRecord[] } {
  const suppressions: SuppressionRecord[] = [];
  const refined: SatelliteVisionResult = JSON.parse(JSON.stringify(vision));

  // Rule 1: Tree cover heavy (>40%) — suppress pitch and facet confidence
  if (vision.obstructions.tree_cover_pct > 40) {
    const beforeP = refined.pitch_band.confidence;
    refined.pitch_band.confidence = Math.min(refined.pitch_band.confidence, 20);
    if (refined.pitch_band.confidence < 15) { refined.pitch_band.abstain = true; refined.pitch_band.value = "unknown"; }
    suppressions.push({ rule: "tree_cover_heavy", field: "pitch_band", reason: `Tree cover ${vision.obstructions.tree_cover_pct}% obscures roof surface`, action: refined.pitch_band.abstain ? "abstain_forced" : "confidence_reduced", before_confidence: beforeP, after_confidence: refined.pitch_band.confidence });

    const beforeF = refined.visible_facets.confidence;
    refined.visible_facets.confidence = Math.min(refined.visible_facets.confidence, 25);
    suppressions.push({ rule: "tree_cover_heavy", field: "visible_facets", reason: `Tree cover ${vision.obstructions.tree_cover_pct}% may hide facets`, action: "confidence_reduced", before_confidence: beforeF, after_confidence: refined.visible_facets.confidence });
  }

  // Rule 2: Heavy shadow — suppress pitch classification
  if (vision.obstructions.shadow_coverage === "heavy") {
    const before = refined.pitch_band.confidence;
    refined.pitch_band.confidence = Math.min(refined.pitch_band.confidence, 15);
    refined.pitch_band.abstain = true;
    refined.pitch_band.value = "unknown";
    suppressions.push({ rule: "heavy_shadow", field: "pitch_band", reason: "Heavy shadow prevents reliable pitch assessment", action: "abstain_forced", before_confidence: before, after_confidence: refined.pitch_band.confidence });
  }

  // Rule 3: Rear-slope invisibility (< 3 sides visible)
  if (vision.obstructions.visible_sides < 3) {
    const beforeF = refined.visible_facets.confidence;
    refined.visible_facets.confidence = Math.min(refined.visible_facets.confidence, 30);
    suppressions.push({ rule: "rear_slope_invisible", field: "visible_facets", reason: `Only ${vision.obstructions.visible_sides}/4 sides visible`, action: "confidence_reduced", before_confidence: beforeF, after_confidence: refined.visible_facets.confidence });

    const beforeForm = refined.roof_form.confidence;
    refined.roof_form.confidence = Math.min(refined.roof_form.confidence, 40);
    suppressions.push({ rule: "rear_slope_invisible", field: "roof_form", reason: `Cannot confirm rear slopes with ${vision.obstructions.visible_sides}/4 sides visible`, action: "confidence_reduced", before_confidence: beforeForm, after_confidence: refined.roof_form.confidence });
  }

  // Rule 4: Low footprint quality — geometry-vision conflicts are unreliable
  if (geometryQuality != null && geometryQuality < 40) {
    // Don't suppress vision (geometry is weak), but note for downstream
    suppressions.push({ rule: "low_footprint_quality", field: "geometry_vs_vision", reason: `Footprint quality ${geometryQuality}/100 too low for reliable geometry-vision comparison`, action: "confidence_reduced", before_confidence: geometryQuality, after_confidence: geometryQuality });
  }

  // Rule 5: Geometry-vision conflict on roof form
  if (geometryRoofForm && geometryRoofForm !== "unknown" &&
      refined.roof_form.value !== "unknown" && refined.roof_form.value !== geometryRoofForm &&
      !refined.roof_form.abstain) {
    const geoConf = geometryRoofFormConfidence ?? 0;
    const visConf = refined.roof_form.confidence;

    if (geoConf > 50 && visConf < 40) {
      // Geometry wins
      const before = refined.roof_form.confidence;
      refined.roof_form.confidence = Math.min(visConf, 15);
      suppressions.push({ rule: "geometry_vision_conflict", field: "roof_form", reason: `Vision (${refined.roof_form.value}) conflicts with geometry (${geometryRoofForm}); geometry confidence higher (${geoConf}% vs ${before}%)`, action: "confidence_reduced", before_confidence: before, after_confidence: refined.roof_form.confidence });
    } else if (visConf > 50 && geoConf < 40) {
      // Vision wins — no suppression but record
      suppressions.push({ rule: "geometry_vision_conflict", field: "roof_form", reason: `Vision (${refined.roof_form.value}) overrides weak geometry (${geometryRoofForm}, ${geoConf}%)`, action: "confidence_reduced", before_confidence: geoConf, after_confidence: geoConf });
    } else {
      // Both uncertain — reduce vision confidence
      const before = refined.roof_form.confidence;
      refined.roof_form.confidence = Math.round(visConf * 0.7);
      suppressions.push({ rule: "geometry_vision_conflict", field: "roof_form", reason: `Vision (${refined.roof_form.value}) and geometry (${geometryRoofForm}) disagree; both uncertain`, action: "confidence_reduced", before_confidence: before, after_confidence: refined.roof_form.confidence });
    }
  }

  // Rule 6: Low image quality — suppress all classifications
  if (vision.overall_image_quality < 30) {
    for (const field of ["roof_form", "pitch_band", "visible_facets"] as const) {
      const before = refined[field].confidence;
      refined[field].confidence = Math.min(refined[field].confidence, 20);
      if (refined[field].confidence < 15) {
        refined[field].abstain = true;
        if (field === "pitch_band") (refined[field] as any).value = "unknown";
      }
      suppressions.push({ rule: "low_image_quality", field, reason: `Image quality ${vision.overall_image_quality}/100 too low for reliable ${field}`, action: before > 20 ? "confidence_reduced" : "abstain_forced", before_confidence: before, after_confidence: refined[field].confidence });
    }
  }

  return { refined, suppressions };
}

// ── Phase 2G: Roof-mass decomposition + classification ──────────────
// Split an L/T/U-shaped footprint into separate rectangular roof masses
// so each mass gets independent ridge/hip/valley/facet derivation.
// Each mass is classified by type to weight its contribution.

/** Mass-type derivation weight — controls how much each mass contributes to aggregated totals. */
const MASS_TYPE_WEIGHTS: Record<MassType, number> = {
  main_roof: 1.0,
  attached_garage: 0.9,
  rear_projection: 0.8,
  porch_bump_out: 0.5,
  unknown_accessory: 0.6,
};

/**
 * Classify a decomposed roof mass based on size, aspect ratio,
 * attachment geometry, and relative footprint contribution.
 */
function classifyMass(
  mass: RoofMass,
  allMasses: RoofMass[],
  totalFootprintArea: number,
  massIndex: number,
): MassClassification {
  const contribution = totalFootprintArea > 0 ? mass.area_sqft / totalFootprintArea : 0;
  const isLargest = allMasses.every(m => m.area_sqft <= mass.area_sqft);

  // Single mass → always main_roof
  if (allMasses.length === 1) {
    return {
      mass_type: "main_roof",
      confidence: 90,
      reasoning: "Single mass — classified as main roof by default.",
      footprint_contribution: contribution,
      derivation_weight: MASS_TYPE_WEIGHTS.main_roof,
    };
  }

  // ── Main roof: largest mass, or contribution > 55%
  if (isLargest && contribution >= 0.45) {
    return {
      mass_type: "main_roof",
      confidence: 80,
      reasoning: `Largest mass (${Math.round(contribution * 100)}% of footprint). Classified as main roof.`,
      footprint_contribution: contribution,
      derivation_weight: MASS_TYPE_WEIGHTS.main_roof,
    };
  }

  // ── Attached garage: secondary mass, contribution 20-50%, aspect ratio 1.0-2.5 (squarish-rectangular)
  if (!isLargest && contribution >= 0.20 && contribution <= 0.50 &&
      mass.aspect_ratio >= 0.8 && mass.aspect_ratio <= 2.5 &&
      mass.area_sqft >= 200) {
    return {
      mass_type: "attached_garage",
      confidence: 55,
      reasoning: `Secondary mass (${Math.round(contribution * 100)}% of footprint, AR=${mass.aspect_ratio}). Size/shape consistent with attached garage.`,
      footprint_contribution: contribution,
      derivation_weight: MASS_TYPE_WEIGHTS.attached_garage,
    };
  }

  // ── Rear projection: secondary mass, contribution 10-35%, elongated (AR > 1.5)
  if (!isLargest && contribution >= 0.10 && contribution <= 0.35 && mass.aspect_ratio > 1.5) {
    return {
      mass_type: "rear_projection",
      confidence: 50,
      reasoning: `Secondary elongated mass (${Math.round(contribution * 100)}% of footprint, AR=${mass.aspect_ratio}). Consistent with rear projection or wing.`,
      footprint_contribution: contribution,
      derivation_weight: MASS_TYPE_WEIGHTS.rear_projection,
    };
  }

  // ── Porch / bump-out: small mass, contribution < 15%, area < 200 sqft
  if (contribution < 0.15 || mass.area_sqft < 200) {
    return {
      mass_type: "porch_bump_out",
      confidence: 60,
      reasoning: `Minor mass (${Math.round(contribution * 100)}% of footprint, ${mass.area_sqft} sqft). Too small for independent ridge/valley — classified as porch or bump-out.`,
      footprint_contribution: contribution,
      derivation_weight: MASS_TYPE_WEIGHTS.porch_bump_out,
    };
  }

  // ── Fallback: unknown accessory
  return {
    mass_type: "unknown_accessory",
    confidence: 30,
    reasoning: `Mass #${massIndex} (${Math.round(contribution * 100)}% of footprint, ${mass.area_sqft} sqft, AR=${mass.aspect_ratio}). Does not match known mass type patterns.`,
    footprint_contribution: contribution,
    derivation_weight: MASS_TYPE_WEIGHTS.unknown_accessory,
  };
}

function decomposeIntoMasses(candidate: CandidateFootprint): RoofMassDecomposition {
  const ring = candidate.polygon;
  const pts = ring[ring.length - 1][0] === ring[0][0] && ring[ring.length - 1][1] === ring[0][1]
    ? ring.slice(0, -1) : ring;
  const notes: string[] = [];

  // Simple rectangular footprint (4 vertices) → single mass
  if (pts.length <= 4) {
    const { axis } = analyzeAxes(ring);
    const edges = candidate.edge_classifications;
    const eaveLen = edges.filter(e => e.classification === "likely_eave").reduce((s, e) => s + e.length_ft, 0);
    const rakeLen = edges.filter(e => e.classification === "likely_rake").reduce((s, e) => s + e.length_ft, 0);
    const longestEave = Math.max(...edges.filter(e => e.classification === "likely_eave").map(e => e.length_ft), 0);
    const longestRake = Math.max(...edges.filter(e => e.classification === "likely_rake").map(e => e.length_ft), 0);

    notes.push(`Simple ${pts.length}-vertex footprint → single roof mass.`);
    const singleMass: RoofMass = {
      id: "mass_0",
      polygon: ring,
      area_sqft: candidate.area_sqft,
      perimeter_ft: candidate.perimeter_ft,
      dominant_axis_bearing: axis.primaryAxis,
      dominant_axis_length_ft: longestEave || axis.primaryTotalLen / 2,
      perpendicular_axis_length_ft: longestRake || axis.perpTotalLen / 2,
      aspect_ratio: (longestRake > 0 ? (longestEave || axis.primaryTotalLen / 2) / longestRake : 1),
      edge_classifications: edges,
      inferred_form: "unknown", // will be resolved later
      form_confidence: 0,
      connected_mass_ids: [],
      classification: null, // classified below
    };
    singleMass.classification = classifyMass(singleMass, [singleMass], candidate.area_sqft, 0);
    notes.push(`  Classification: ${singleMass.classification.mass_type} (${singleMass.classification.confidence}% confidence, weight=${singleMass.classification.derivation_weight}).`);

    return {
      masses: [singleMass],
      junction_valleys: [],
      decomposition_method: "single_mass",
      notes,
    };
  }

  // Complex footprint (5+ vertices) → attempt axis-aligned split
  const { segments, axis } = analyzeAxes(ring);
  const edges = candidate.edge_classifications;

  // Group consecutive edges by axis alignment into "runs"
  interface EdgeRun {
    indices: number[];
    alignment: "primary" | "perpendicular" | "other";
    totalLength: number;
    centroid: [number, number];
  }
  const runs: EdgeRun[] = [];
  let currentRun: EdgeRun | null = null;

  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    const diffP = Math.min(Math.abs(s.normBearing - axis.primaryAxis), Math.abs(s.normBearing - axis.primaryAxis + 180), Math.abs(s.normBearing - axis.primaryAxis - 180));
    const diffQ = Math.min(Math.abs(s.normBearing - axis.perpAxis), Math.abs(s.normBearing - axis.perpAxis + 180), Math.abs(s.normBearing - axis.perpAxis - 180));
    const alignment: "primary" | "perpendicular" | "other" = diffP <= 15 ? "primary" : diffQ <= 15 ? "perpendicular" : "other";

    if (currentRun && currentRun.alignment === alignment) {
      currentRun.indices.push(i);
      currentRun.totalLength += s.len;
    } else {
      if (currentRun) runs.push(currentRun);
      currentRun = { indices: [i], alignment, totalLength: s.len, centroid: midpoint(s.start, s.end) };
    }
  }
  if (currentRun) runs.push(currentRun);

  const perpRuns = runs.filter(r => r.alignment === "perpendicular");
  if (perpRuns.length <= 1 || pts.length <= 5) {
    const longestEave = Math.max(...edges.filter(e => e.classification === "likely_eave").map(e => e.length_ft), 0);
    const longestRake = Math.max(...edges.filter(e => e.classification === "likely_rake").map(e => e.length_ft), 0);
    notes.push(`${pts.length}-vertex footprint with ${perpRuns.length} perp run(s) — insufficient for multi-mass decomposition → single mass.`);
    const singleMass: RoofMass = {
      id: "mass_0",
      polygon: ring,
      area_sqft: candidate.area_sqft,
      perimeter_ft: candidate.perimeter_ft,
      dominant_axis_bearing: axis.primaryAxis,
      dominant_axis_length_ft: longestEave || axis.primaryTotalLen / 2,
      perpendicular_axis_length_ft: longestRake || axis.perpTotalLen / 2,
      aspect_ratio: longestRake > 0 ? (longestEave || axis.primaryTotalLen / 2) / longestRake : 1,
      edge_classifications: edges,
      inferred_form: "unknown",
      form_confidence: 0,
      connected_mass_ids: [],
      classification: null,
    };
    singleMass.classification = classifyMass(singleMass, [singleMass], candidate.area_sqft, 0);
    notes.push(`  Classification: ${singleMass.classification.mass_type} (${singleMass.classification.confidence}%).`);
    return {
      masses: [singleMass],
      junction_valleys: [],
      decomposition_method: "single_mass",
      notes,
    };
  }

  // Multi-mass split
  perpRuns.sort((a, b) => b.totalLength - a.totalLength);
  const mainEaveEdges = edges.filter(e => e.classification === "likely_eave");
  const mainRakeEdges = edges.filter(e => e.classification === "likely_rake");

  const eaveSorted = [...mainEaveEdges].sort((a, b) => b.length_ft - a.length_ft);
  const rakeSorted = [...mainRakeEdges].sort((a, b) => b.length_ft - a.length_ft);

  const massALength = eaveSorted[0]?.length_ft ?? axis.primaryTotalLen / 2;
  const massAWidth = rakeSorted[0]?.length_ft ?? axis.perpTotalLen / 2;
  const massBLength = eaveSorted.length > 1 ? (eaveSorted[1]?.length_ft ?? 0) : 0;
  const massBWidth = rakeSorted.length > 1 ? (rakeSorted[1]?.length_ft ?? 0) : 0;

  if (massBLength < 5 || massBWidth < 5) {
    notes.push(`Potential wing too small (${roundTo(massBLength)}×${roundTo(massBWidth)}ft) — single mass.`);
    const singleMass: RoofMass = {
      id: "mass_0",
      polygon: ring,
      area_sqft: candidate.area_sqft,
      perimeter_ft: candidate.perimeter_ft,
      dominant_axis_bearing: axis.primaryAxis,
      dominant_axis_length_ft: massALength,
      perpendicular_axis_length_ft: massAWidth,
      aspect_ratio: massAWidth > 0 ? massALength / massAWidth : 1,
      edge_classifications: edges,
      inferred_form: "unknown",
      form_confidence: 0,
      connected_mass_ids: [],
      classification: null,
    };
    singleMass.classification = classifyMass(singleMass, [singleMass], candidate.area_sqft, 0);
    notes.push(`  Classification: ${singleMass.classification.mass_type} (${singleMass.classification.confidence}%).`);
    return {
      masses: [singleMass],
      junction_valleys: [],
      decomposition_method: "single_mass",
      notes,
    };
  }

  // Compute approximate areas
  const massAArea = roundTo(massALength * massAWidth, 0);
  const massBArea = roundTo(massBLength * massBWidth, 0);
  const totalDecomposed = massAArea + massBArea;
  const areaRatio = candidate.area_sqft > 0 ? totalDecomposed / candidate.area_sqft : 1;

  notes.push(`Decomposed into 2 masses: A(${roundTo(massALength)}×${roundTo(massAWidth)}ft ≈${massAArea}sqft) + B(${roundTo(massBLength)}×${roundTo(massBWidth)}ft ≈${massBArea}sqft).`);
  notes.push(`Decomposed total ${totalDecomposed}sqft vs footprint ${candidate.area_sqft}sqft (ratio: ${roundTo(areaRatio, 2)}).`);

  // Estimate planar valley length at junction (where wing meets main body).
  // Keep this UNSLOPED here — pitch-based slope adjustment happens later when
  // junction valleys are promoted into measured totals.
  const junctionLength = Math.min(massBWidth, massAWidth);
  const valleyAtJunction = roundTo(junctionLength, 0);

  const massA: RoofMass = {
    id: "mass_0",
    polygon: ring, // approximation — actual sub-polygon not computed
    area_sqft: massAArea,
    perimeter_ft: roundTo((massALength + massAWidth) * 2, 0),
    dominant_axis_bearing: axis.primaryAxis,
    dominant_axis_length_ft: massALength,
    perpendicular_axis_length_ft: massAWidth,
    aspect_ratio: massAWidth > 0 ? roundTo(massALength / massAWidth, 2) : 1,
    edge_classifications: edges.filter(e => e.length_ft >= massAWidth * 0.5),
    inferred_form: "unknown",
    form_confidence: 0,
    connected_mass_ids: ["mass_1"],
    classification: null,
  };
  const massB: RoofMass = {
    id: "mass_1",
    polygon: ring,
    area_sqft: massBArea,
    perimeter_ft: roundTo((massBLength + massBWidth) * 2, 0),
    dominant_axis_bearing: (axis.primaryAxis + 90) % 180, // wing is typically perpendicular
    dominant_axis_length_ft: massBLength,
    perpendicular_axis_length_ft: massBWidth,
    aspect_ratio: massBWidth > 0 ? roundTo(massBLength / massBWidth, 2) : 1,
    edge_classifications: edges.filter(e => e.length_ft < massAWidth * 0.5 || e.classification === "unknown"),
    inferred_form: "unknown",
    form_confidence: 0,
    connected_mass_ids: ["mass_0"],
    classification: null,
  };

  const allMasses = [massA, massB];
  // Classify each mass
  for (let i = 0; i < allMasses.length; i++) {
    allMasses[i].classification = classifyMass(allMasses[i], allMasses, candidate.area_sqft, i);
    notes.push(`  Mass ${allMasses[i].id}: ${allMasses[i].classification!.mass_type} (${allMasses[i].classification!.confidence}% conf, weight=${allMasses[i].classification!.derivation_weight}, contribution=${Math.round(allMasses[i].classification!.footprint_contribution * 100)}%).`);
  }

  return {
    masses: allMasses,
    junction_valleys: [{
      mass_a: "mass_0",
      mass_b: "mass_1",
      approx_length_ft: valleyAtJunction,
      status: "candidate",
      promotion_reason: null,
    }],
    decomposition_method: "axis_split",
    notes,
  };
}

// ── Deterministic linear measurement derivation ──────────────────────
// All linear values (ridge, hip, valley, eave, rake) are computed from
// footprint geometry, edge classifications, roof form, dominant axis,
// pitch band, and roof-mass decomposition.
// Vision validates/suppresses — never generates.
// Unknown values are null with explicit authority="unknown_insufficient_geometry".

interface DerivedLinearMeasurements {
  ridge_lf: number | null;
  hip_lf: number | null;
  valley_lf: number | null;
  eave_lf: number | null;
  rake_lf: number | null;
  facet_count: number | null;
  derivation_notes: string[];
  linear_confidence: Record<string, number>;
  unknown_fields: string[];
}

/** Guardrail: ridge must be >= min_ridge_ratio × dominant axis for the form to be plausible. */
const RIDGE_GUARDRAILS = {
  /** Gable ridge should be >= 60% of dominant axis (else footprint is too irregular). */
  gable_min_ridge_ratio: 0.6,
  /** Hip ridge must be positive and < dominant axis (else it's not really a hip). */
  hip_max_ridge_ratio: 0.95,
  /** Minimum absolute ridge length to report (ft). Below this → null. */
  min_absolute_ridge_ft: 8,
  /** Hip derivation: halfPerp must be > this to be reliable. */
  min_half_perp_ft: 5,
};

function deriveLinearForMass(
  mass: RoofMass,
  resolvedForm: RoofForm,
  pitchBand: PitchBand,
  overhang: OverhangConfig,
  roofFormInference: RoofFormInference | null,
): DerivedLinearMeasurements {
  const notes: string[] = [];
  const unknown_fields: string[] = [];
  const linear_confidence: Record<string, number> = {};

  const edges = mass.edge_classifications;
  const dominantLen = mass.dominant_axis_length_ft;
  const perpLen = mass.perpendicular_axis_length_ft;
  const aspect = mass.aspect_ratio;
  // Use a rough quality proxy: area > 500 and reasonable aspect = decent quality
  const qualityProxy = (mass.area_sqft > 500 && aspect > 0.5 && aspect < 5) ? 60 : 30;

  // ── Eave & Rake: sum from edge classifications + configurable overhang ──
  let rawEaveLf = 0, rawRakeLf = 0;
  for (const e of edges) {
    if (e.classification === "likely_eave") rawEaveLf += e.length_ft;
    else if (e.classification === "likely_rake") rawRakeLf += e.length_ft;
  }

  const eaveSegCount = edges.filter(e => e.classification === "likely_eave").length;
  const rakeSegCount = edges.filter(e => e.classification === "likely_rake").length;

  let eaveLf: number | null = null;
  let rakeLf: number | null = null;

  if (rawEaveLf > 0) {
    eaveLf = roundTo(rawEaveLf + eaveSegCount * overhang.eave_overhang_ft * 2, 0);
    linear_confidence.eave_lf = qualityProxy >= 60 ? 65 : qualityProxy >= 40 ? 45 : 25;
    notes.push(`Eave: ${rawEaveLf}ft edge + ${eaveSegCount}×${overhang.eave_overhang_ft*2}ft overhang(${overhang.source}) = ${eaveLf}ft.`);
  } else {
    unknown_fields.push("eave_lf");
    linear_confidence.eave_lf = 0;
    notes.push("Eave: null — no eave-classified edges.");
  }

  if (rawRakeLf > 0) {
    rakeLf = roundTo(rawRakeLf + rakeSegCount * overhang.rake_overhang_ft * 2, 0);
    linear_confidence.rake_lf = qualityProxy >= 60 ? 65 : qualityProxy >= 40 ? 45 : 25;
    notes.push(`Rake: ${rawRakeLf}ft edge + ${rakeSegCount}×${overhang.rake_overhang_ft*2}ft overhang(${overhang.source}) = ${rakeLf}ft.`);
  } else {
    unknown_fields.push("rake_lf");
    linear_confidence.rake_lf = 0;
    notes.push("Rake: null — no rake-classified edges.");
  }

  // ── Ridge: with guardrails ──
  let ridgeLf: number | null = null;
  if (resolvedForm === "gable" || resolvedForm === "cross_gable") {
    // Try ridge candidates first
    let candidateRidge: number | null = null;
    if (roofFormInference && roofFormInference.ridge_candidates.length > 0) {
      candidateRidge = roofFormInference.ridge_candidates[0].length_ft;
    }
    const rawRidge = candidateRidge ?? dominantLen;

    // Guardrail: ridge must be >= ratio × dominant and >= min absolute
    if (rawRidge >= RIDGE_GUARDRAILS.min_absolute_ridge_ft &&
        rawRidge >= dominantLen * RIDGE_GUARDRAILS.gable_min_ridge_ratio) {
      ridgeLf = roundTo(rawRidge, 0);
      linear_confidence.ridge_lf = qualityProxy >= 50 ? (candidateRidge ? 50 : 35) : 20;
      notes.push(`Ridge (gable): ${ridgeLf}ft${candidateRidge ? " from candidate" : " = dominant axis"}. Passed guardrail (>=${roundTo(dominantLen * RIDGE_GUARDRAILS.gable_min_ridge_ratio)}ft min).`);
    } else {
      unknown_fields.push("ridge_lf");
      linear_confidence.ridge_lf = 0;
      notes.push(`Ridge: null — failed guardrail (raw=${roundTo(rawRidge)}ft, min=${roundTo(dominantLen * RIDGE_GUARDRAILS.gable_min_ridge_ratio)}ft or ${RIDGE_GUARDRAILS.min_absolute_ridge_ft}ft).`);
    }
  } else if (resolvedForm === "hip") {
    const hipRidge = dominantLen - perpLen;
    // Guardrail: positive, > min absolute, < max ratio of dominant
    if (hipRidge >= RIDGE_GUARDRAILS.min_absolute_ridge_ft &&
        dominantLen > perpLen &&
        hipRidge / dominantLen < RIDGE_GUARDRAILS.hip_max_ridge_ratio) {
      ridgeLf = roundTo(hipRidge, 0);
      linear_confidence.ridge_lf = qualityProxy >= 50 ? 40 : 20;
      notes.push(`Ridge (hip): ${ridgeLf}ft = dominant(${roundTo(dominantLen)}) - perp(${roundTo(perpLen)}). Passed guardrail.`);
    } else if (aspect < 1.15 && dominantLen > 10) {
      // Near-square hip = pyramid, ridge ≈ 0 is intentional
      ridgeLf = 0;
      linear_confidence.ridge_lf = 30;
      notes.push(`Ridge (pyramid hip): 0ft. Near-square AR=${aspect}.`);
    } else {
      unknown_fields.push("ridge_lf");
      linear_confidence.ridge_lf = 0;
      notes.push(`Ridge (hip): null — failed guardrail (raw=${roundTo(hipRidge)}ft, dom=${roundTo(dominantLen)}, perp=${roundTo(perpLen)}).`);
    }
  } else {
    unknown_fields.push("ridge_lf");
    linear_confidence.ridge_lf = 0;
    notes.push(`Ridge: null — form '${resolvedForm}' unsupported for deterministic derivation.`);
  }

  // ── Hip LF: with guardrails ──
  let hipLf: number | null = null;
  if (resolvedForm === "hip") {
    const halfPerp = perpLen / 2;
    if (halfPerp >= RIDGE_GUARDRAILS.min_half_perp_ft) {
      const sf = PITCH_BAND_META[pitchBand]?.slope_factor_mid ?? 1.118;
      const singleHipSlope = halfPerp * Math.SQRT2 * sf;
      hipLf = roundTo(4 * singleHipSlope, 0);
      linear_confidence.hip_lf = qualityProxy >= 50 ? 35 : 20;
      notes.push(`Hip: 4×(${roundTo(halfPerp,1)}ft×√2×${sf}) = ${hipLf}ft. halfPerp passed guardrail (>=${RIDGE_GUARDRAILS.min_half_perp_ft}ft).`);
    } else {
      unknown_fields.push("hip_lf");
      linear_confidence.hip_lf = 0;
      notes.push(`Hip: null — halfPerp ${roundTo(halfPerp,1)}ft < ${RIDGE_GUARDRAILS.min_half_perp_ft}ft guardrail.`);
    }
  } else if (resolvedForm === "gable") {
    hipLf = 0; // gable has no hips — this is a known zero, not unknown
    linear_confidence.hip_lf = 70;
    notes.push("Hip: 0ft (gable — known zero).");
  } else {
    // complex/cross_gable/unknown — check candidates
    if (roofFormInference) {
      const hipCands = roofFormInference.hip_valley_candidates.filter(c => c.type === "hip");
      if (hipCands.length > 0) {
        hipLf = roundTo(hipCands.reduce((s, c) => s + c.length_ft, 0), 0);
        linear_confidence.hip_lf = 20;
        notes.push(`Hip (${resolvedForm}): ${hipLf}ft from ${hipCands.length} candidate(s).`);
      }
    }
    if (hipLf === null) {
      unknown_fields.push("hip_lf");
      linear_confidence.hip_lf = 0;
      notes.push(`Hip: null — no candidates for '${resolvedForm}'.`);
    }
  }

  // ── Valley LF (per-mass — junction valleys added separately) ──
  let valleyLf: number | null = null;
  if (resolvedForm === "gable") {
    valleyLf = 0;
    linear_confidence.valley_lf = 70;
    notes.push("Valley: 0ft (gable — known zero).");
  } else if (resolvedForm === "hip") {
    valleyLf = 0;
    linear_confidence.valley_lf = 50;
    notes.push("Valley: 0ft (simple hip — no valleys).");
  } else if (resolvedForm === "cross_gable" || resolvedForm === "complex") {
    if (roofFormInference) {
      const valCands = roofFormInference.hip_valley_candidates.filter(c => c.type === "valley");
      if (valCands.length > 0) {
        const sf = PITCH_BAND_META[pitchBand]?.slope_factor_mid ?? 1.118;
        valleyLf = roundTo(valCands.reduce((s, c) => s + c.length_ft * sf, 0), 0);
        linear_confidence.valley_lf = Math.min(25, valCands[0].confidence);
        notes.push(`Valley (${resolvedForm}): ${valleyLf}ft from ${valCands.length} candidate(s), slope-adjusted.`);
      }
    }
    if (valleyLf === null) {
      unknown_fields.push("valley_lf");
      linear_confidence.valley_lf = 0;
      notes.push(`Valley: null — no candidates for '${resolvedForm}'.`);
    }
  } else {
    unknown_fields.push("valley_lf");
    linear_confidence.valley_lf = 0;
    notes.push("Valley: null — unknown form.");
  }

  // ── Facet count ──
  let facetCount: number | null = null;
  if (resolvedForm === "gable") {
    facetCount = 2;
    linear_confidence.facet_count = 60;
    notes.push("Facets: 2 (gable).");
  } else if (resolvedForm === "hip") {
    facetCount = 4;
    linear_confidence.facet_count = 50;
    notes.push("Facets: 4 (hip).");
  } else if (resolvedForm === "cross_gable") {
    const valCount = roofFormInference?.hip_valley_candidates.filter(c => c.type === "valley").length ?? 0;
    facetCount = Math.max(6, 6 + valCount * 2);
    linear_confidence.facet_count = 30;
    notes.push(`Facets: ${facetCount} (cross-gable, ${valCount} valley(s)).`);
  } else {
    unknown_fields.push("facet_count");
    linear_confidence.facet_count = 0;
    notes.push("Facets: null — form unsupported.");
  }

  return {
    ridge_lf: ridgeLf,
    hip_lf: hipLf,
    valley_lf: valleyLf,
    eave_lf: eaveLf,
    rake_lf: rakeLf,
    facet_count: facetCount,
    derivation_notes: notes,
    linear_confidence,
    unknown_fields,
  };
}

/**
 * Full derivation: decompose → per-mass derivation → aggregate.
 */
function deriveLinearMeasurements(
  candidate: CandidateFootprint | null,
  roofForm: RoofFormInference | null,
  resolvedForm: RoofForm,
  pitchBand: PitchBand,
  overhang: OverhangConfig,
): { linear: DerivedLinearMeasurements; decomposition: RoofMassDecomposition | null } {
  if (!candidate || !roofForm) {
    return {
      linear: {
        ridge_lf: null, hip_lf: null, valley_lf: null, eave_lf: null, rake_lf: null,
        facet_count: null,
        derivation_notes: ["No footprint geometry — all linear values null."],
        linear_confidence: { ridge_lf: 0, hip_lf: 0, valley_lf: 0, eave_lf: 0, rake_lf: 0, facet_count: 0 },
        unknown_fields: ["ridge_lf", "hip_lf", "valley_lf", "eave_lf", "rake_lf", "facet_count"],
      },
      decomposition: null,
    };
  }

  const decomposition = decomposeIntoMasses(candidate);
  const massCount = decomposition.masses.length;

  if (massCount === 1) {
    // Single mass — derive directly
    const mass = decomposition.masses[0];
    // Assign resolved form to the single mass
    mass.inferred_form = resolvedForm;
    mass.form_confidence = roofForm.roof_form_confidence;
    const linear = deriveLinearForMass(mass, resolvedForm, pitchBand, overhang, roofForm);
    return { linear, decomposition };
  }

  // Multi-mass aggregation with type-based weighting
  const allNotes: string[] = [`Roof decomposed into ${massCount} masses.`];
  const allUnknown: string[] = [];
  const aggConfidence: Record<string, number> = {};
  let totalRidge: number | null = null;
  let totalHip: number | null = null;
  let totalValley: number | null = null;
  let totalEave: number | null = null;
  let totalRake: number | null = null;
  let totalFacets: number | null = null;

  // Assign forms: main_roof mass gets resolved form, others get form based on aspect ratio
  for (let i = 0; i < decomposition.masses.length; i++) {
    const mass = decomposition.masses[i];
    const massType = mass.classification?.mass_type ?? "unknown_accessory";
    const weight = mass.classification?.derivation_weight ?? 1.0;

    // Main roof gets the resolved form; secondaries infer from aspect ratio
    if (massType === "main_roof") {
      mass.inferred_form = resolvedForm;
      mass.form_confidence = roofForm.roof_form_confidence;
    } else {
      mass.inferred_form = mass.aspect_ratio >= 1.3 ? "gable" : "hip";
      mass.form_confidence = 30;
    }

    const massLinear = deriveLinearForMass(mass, mass.inferred_form, pitchBand, overhang, massType === "main_roof" ? roofForm : null);
    allNotes.push(`── Mass ${mass.id} [${massType}] (${mass.inferred_form}, ${mass.area_sqft}sqft, weight=${weight}):`);
    allNotes.push(...massLinear.derivation_notes.map(n => `  ${n}`));

    // Weighted aggregation: porch/bump-out gets reduced contribution
    const addWeighted = (a: number | null, b: number | null, w: number): number | null => {
      if (a === null && b === null) return null;
      return (a ?? 0) + Math.round((b ?? 0) * w);
    };

    totalRidge = addWeighted(totalRidge, massLinear.ridge_lf, weight);
    totalHip = addWeighted(totalHip, massLinear.hip_lf, weight);
    totalValley = addWeighted(totalValley, massLinear.valley_lf, weight);
    totalEave = addWeighted(totalEave, massLinear.eave_lf, weight);
    totalRake = addWeighted(totalRake, massLinear.rake_lf, weight);
    // Facets are not weighted — each mass contributes its full facet count
    const addNullable = (a: number | null, b: number | null): number | null => {
      if (a === null && b === null) return null;
      return (a ?? 0) + (b ?? 0);
    };
    totalFacets = addNullable(totalFacets, massLinear.facet_count);

    if (weight < 1.0) {
      allNotes.push(`  ⚖️ Linear values weighted ×${weight} (mass type: ${massType}).`);
    }

    for (const f of massLinear.unknown_fields) {
      if (!allUnknown.includes(f)) allUnknown.push(f);
    }
    for (const [k, v] of Object.entries(massLinear.linear_confidence)) {
      aggConfidence[k] = Math.min(aggConfidence[k] ?? 100, v); // worst-case across masses
    }
  }

  // Junction valleys remain as CANDIDATES — not promoted to measured values.
  // They only contribute to valley_lf when promoted by roof form + validation evidence.
  for (const jv of decomposition.junction_valleys) {
    const sf = PITCH_BAND_META[pitchBand]?.slope_factor_mid ?? 1.118;
    const junctionValleySloped = roundTo(jv.approx_length_ft * sf, 0);
    const junctionTotal = junctionValleySloped * 2;

    if (jv.status === "promoted") {
      // Promoted junction valleys add to measured total
      totalValley = (totalValley ?? 0) + junctionTotal;
      allNotes.push(`Junction valley (${jv.mass_a}↔${jv.mass_b}) [PROMOTED]: 2×${junctionValleySloped}ft = ${junctionTotal}ft. Reason: ${jv.promotion_reason ?? "unknown"}.`);
      const vIdx = allUnknown.indexOf("valley_lf");
      if (vIdx >= 0) allUnknown.splice(vIdx, 1);
      aggConfidence.valley_lf = Math.max(aggConfidence.valley_lf ?? 0, 35);
    } else {
      // Candidate junction valleys: logged but NOT added to total
      allNotes.push(`Junction valley (${jv.mass_a}↔${jv.mass_b}) [CANDIDATE]: 2×${junctionValleySloped}ft = ${junctionTotal}ft. Not promoted — requires roof form confirmation or validation evidence.`);
      aggConfidence.valley_lf = Math.max(aggConfidence.valley_lf ?? 0, 10);
    }
  }

  // Auto-promote junction valleys when cross_gable or complex form is confirmed with >=35% confidence
  if ((resolvedForm === "cross_gable" || resolvedForm === "complex") && roofForm.roof_form_confidence >= 35) {
    for (const jv of decomposition.junction_valleys) {
      if (jv.status === "candidate") {
        jv.status = "promoted";
        jv.promotion_reason = `Roof form '${resolvedForm}' confirmed @${roofForm.roof_form_confidence}% confidence — valleys expected at mass junctions.`;
        const sf = PITCH_BAND_META[pitchBand]?.slope_factor_mid ?? 1.118;
        const junctionValleySloped = roundTo(jv.approx_length_ft * sf, 0);
        const junctionTotal = junctionValleySloped * 2;
        totalValley = (totalValley ?? 0) + junctionTotal;
        allNotes.push(`  ↑ Auto-promoted junction valley (${jv.mass_a}↔${jv.mass_b}): +${junctionTotal}ft. ${jv.promotion_reason}`);
        const vIdx = allUnknown.indexOf("valley_lf");
        if (vIdx >= 0) allUnknown.splice(vIdx, 1);
        aggConfidence.valley_lf = Math.max(aggConfidence.valley_lf ?? 0, 25);
      }
    }
  }

  return {
    linear: {
      ridge_lf: totalRidge,
      hip_lf: totalHip,
      valley_lf: totalValley,
      eave_lf: totalEave,
      rake_lf: totalRake,
      facet_count: totalFacets,
      derivation_notes: allNotes,
      linear_confidence: aggConfidence,
      unknown_fields: allUnknown,
    },
    decomposition,
  };
}

/**
 * Vision validation/suppression for geometry-derived linear values.
 */
function applyVisionLinearValidation(
  derived: DerivedLinearMeasurements,
  resolvedForm: RoofForm,
  vision: SatelliteVisionResult | null,
): { validated: DerivedLinearMeasurements; validationNotes: string[] } {
  if (!vision) return { validated: derived, validationNotes: [] };

  const v = { ...derived, linear_confidence: { ...derived.linear_confidence }, unknown_fields: [...derived.unknown_fields] };
  const validationNotes: string[] = [];

  // 1. Facet override: vision can fill null facet count
  if (v.facet_count === null && !vision.visible_facets.abstain && vision.visible_facets.confidence >= 30) {
    v.facet_count = vision.visible_facets.value;
    v.linear_confidence.facet_count = Math.min(vision.visible_facets.confidence, 40);
    v.unknown_fields = v.unknown_fields.filter(f => f !== "facet_count");
    validationNotes.push(`Facets: vision-filled ${v.facet_count} @${v.linear_confidence.facet_count}% (geometry null).`);
  }

  // 2. Facet conflict
  if (v.facet_count !== null && !vision.visible_facets.abstain && vision.visible_facets.confidence >= 25) {
    if (Math.abs(vision.visible_facets.value - v.facet_count) > 1) {
      v.linear_confidence.facet_count = Math.round((v.linear_confidence.facet_count ?? 0) * 0.6);
      validationNotes.push(`Facet conflict: geometry=${v.facet_count}, vision=${vision.visible_facets.value}. Confidence reduced.`);
    }
  }

  // 3. Form conflict suppression
  if (!vision.roof_form.abstain && vision.roof_form.confidence >= 35) {
    const vf = vision.roof_form.value;
    if (resolvedForm === "gable" && (vf === "hip" || vf === "cross_hip")) {
      if ((v.linear_confidence.rake_lf ?? 0) > 0) {
        v.linear_confidence.rake_lf = Math.round(v.linear_confidence.rake_lf * 0.5);
        validationNotes.push(`Vision hip vs geometry gable — rake confidence halved.`);
      }
      if (v.hip_lf === 0) {
        v.linear_confidence.hip_lf = 5;
        validationNotes.push("Hip=0 but vision sees hip — low confidence in zero.");
      }
    }
    if (resolvedForm === "hip" && vf === "gable") {
      if (v.hip_lf !== null && v.hip_lf > 0) {
        v.linear_confidence.hip_lf = Math.round((v.linear_confidence.hip_lf ?? 0) * 0.5);
        validationNotes.push(`Vision gable vs geometry hip — hip confidence halved.`);
      }
    }
  }

  // 4. Tree cover → suppress all linear confidence
  if (vision.obstructions.tree_cover_pct > 50) {
    for (const f of ["ridge_lf", "hip_lf", "valley_lf", "eave_lf", "rake_lf"]) {
      if ((v.linear_confidence[f] ?? 0) > 0) {
        const before = v.linear_confidence[f];
        v.linear_confidence[f] = Math.round(before * 0.6);
        validationNotes.push(`${f}: conf ${before}→${v.linear_confidence[f]}% (trees ${vision.obstructions.tree_cover_pct}%).`);
      }
    }
  }

  return { validated: v, validationNotes };
}

// ── Per-Facet Decomposition from Footprint + Roof Type ──────────────
// Decomposes a building footprint into individual roof facets based on
// the specified roof type, pitch, and building geometry.

function decomposeFacetsFromFootprint(
  candidate: CandidateFootprint | null,
  roofFormInference: RoofFormInference | null,
  roofType: string | null, // user-specified: "hip", "gable", "cross_gable"
  slopeFactor: number,
  pitchLabel: string,
  overhang: OverhangConfig,
): FacetDecomposition | null {
  if (!candidate || !roofFormInference) return null;

  const resolvedType = roofType || roofFormInference.inferred_roof_form || "gable";
  const notes: string[] = [];
  const facets: RoofFacet[] = [];

  const edges = candidate.edge_classifications;
  const dominantLen = roofFormInference.dominant_axis_length_ft;
  const perpLen = roofFormInference.perpendicular_axis_length_ft;
  const dominantBearing = roofFormInference.dominant_axis_bearing;

  // Add overhang to building dimensions to get roof dimensions
  const roofLength = dominantLen + 2 * overhang.eave_overhang_ft;
  const roofWidth = perpLen + 2 * overhang.rake_overhang_ft;

  notes.push(`Building: ${roundTo(dominantLen)}×${roundTo(perpLen)}ft → Roof: ${roundTo(roofLength, 1)}×${roundTo(roofWidth, 1)}ft (with overhang).`);
  notes.push(`Roof type: ${resolvedType} (${roofType ? "user-specified" : "auto-inferred"}).`);

  if (resolvedType === "gable") {
    // GABLE: 2 rectangular slopes, eave at bottom of each, rake on sides, ridge at top
    const halfWidth = roofWidth / 2;
    // Sloped length of each facet = halfWidth / cos(pitch) = halfWidth * slopeFactor
    // But slope factor already accounts for this: area = planar_area * slope_factor
    const facetPlanarArea = roofLength * halfWidth;
    const facetSlopeArea = roundTo(facetPlanarArea * slopeFactor, 0);

    // Ridge runs along dominant axis
    const ridgeLen = roundTo(roofLength, 0);
    // Each eave = roofLength
    const eaveLen = roundTo(roofLength, 0);
    // Each rake = halfWidth * slope_factor (the sloped edge from eave to ridge)
    const rakeLen = roundTo(halfWidth * slopeFactor, 0);

    facets.push({
      id: "facet_1",
      label: "Front Slope",
      area_sqft: facetPlanarArea,
      slope_area_sqft: facetSlopeArea,
      edges: [
        { type: "eave", length_ft: eaveLen, bearing_deg: roundTo(dominantBearing, 1) },
        { type: "rake", length_ft: rakeLen, bearing_deg: roundTo((dominantBearing + 90) % 360, 1) },
        { type: "ridge", length_ft: ridgeLen, bearing_deg: roundTo(dominantBearing, 1) },
        { type: "rake", length_ft: rakeLen, bearing_deg: roundTo((dominantBearing + 270) % 360, 1) },
      ],
      pitch: pitchLabel,
      slope_factor: slopeFactor,
    });

    facets.push({
      id: "facet_2",
      label: "Rear Slope",
      area_sqft: facetPlanarArea,
      slope_area_sqft: facetSlopeArea,
      edges: [
        { type: "eave", length_ft: eaveLen, bearing_deg: roundTo((dominantBearing + 180) % 360, 1) },
        { type: "rake", length_ft: rakeLen, bearing_deg: roundTo((dominantBearing + 90) % 360, 1) },
        { type: "ridge", length_ft: ridgeLen, bearing_deg: roundTo(dominantBearing, 1) },
        { type: "rake", length_ft: rakeLen, bearing_deg: roundTo((dominantBearing + 270) % 360, 1) },
      ],
      pitch: pitchLabel,
      slope_factor: slopeFactor,
    });

    notes.push(`Gable: 2 facets, each ${roundTo(facetPlanarArea)}sqft planar → ${facetSlopeArea}sqft slope.`);
    notes.push(`Ridge: ${ridgeLen}ft, Eave: 2×${eaveLen}ft, Rake: 4×${rakeLen}ft.`);

  } else if (resolvedType === "hip") {
    // HIP: 4 facets — 2 trapezoidal (front/rear), 2 triangular (sides/hips)
    // Ridge length = dominantLen - perpLen (when building is longer than wide)
    const ridgeLen = Math.max(0, roundTo(roofLength - roofWidth, 0));
    const halfPerp = roofWidth / 2;

    // Front and rear slopes (trapezoidal): area = (ridge + eave) / 2 * halfPerp
    const trapPlanarArea = (ridgeLen + roofLength) / 2 * halfPerp;
    const trapSlopeArea = roundTo(trapPlanarArea * slopeFactor, 0);

    // Side hip triangles: area = roofWidth / 2 * halfPerp (triangle)
    const triPlanarArea = (roofWidth * halfPerp) / 2;
    const triSlopeArea = roundTo(triPlanarArea * slopeFactor, 0);

    // Hip line length: diagonal from corner to ridge endpoint
    const hipLineLen = roundTo(Math.sqrt(halfPerp ** 2 + halfPerp ** 2) * slopeFactor, 0);

    // Front slope (trapezoid)
    facets.push({
      id: "facet_1",
      label: "Front Slope",
      area_sqft: roundTo(trapPlanarArea, 0),
      slope_area_sqft: trapSlopeArea,
      edges: [
        { type: "eave", length_ft: roundTo(roofLength, 0), bearing_deg: roundTo(dominantBearing, 1) },
        { type: "hip", length_ft: hipLineLen, bearing_deg: roundTo((dominantBearing + 45) % 360, 1) },
        { type: "ridge", length_ft: ridgeLen, bearing_deg: roundTo(dominantBearing, 1) },
        { type: "hip", length_ft: hipLineLen, bearing_deg: roundTo((dominantBearing + 315) % 360, 1) },
      ],
      pitch: pitchLabel,
      slope_factor: slopeFactor,
    });

    // Rear slope (trapezoid)
    facets.push({
      id: "facet_2",
      label: "Rear Slope",
      area_sqft: roundTo(trapPlanarArea, 0),
      slope_area_sqft: trapSlopeArea,
      edges: [
        { type: "eave", length_ft: roundTo(roofLength, 0), bearing_deg: roundTo((dominantBearing + 180) % 360, 1) },
        { type: "hip", length_ft: hipLineLen, bearing_deg: roundTo((dominantBearing + 135) % 360, 1) },
        { type: "ridge", length_ft: ridgeLen, bearing_deg: roundTo(dominantBearing, 1) },
        { type: "hip", length_ft: hipLineLen, bearing_deg: roundTo((dominantBearing + 225) % 360, 1) },
      ],
      pitch: pitchLabel,
      slope_factor: slopeFactor,
    });

    // Left hip (triangle)
    facets.push({
      id: "facet_3",
      label: "Left Hip",
      area_sqft: roundTo(triPlanarArea, 0),
      slope_area_sqft: triSlopeArea,
      edges: [
        { type: "eave", length_ft: roundTo(roofWidth, 0), bearing_deg: roundTo((dominantBearing + 90) % 360, 1) },
        { type: "hip", length_ft: hipLineLen, bearing_deg: roundTo((dominantBearing + 315) % 360, 1) },
        { type: "hip", length_ft: hipLineLen, bearing_deg: roundTo((dominantBearing + 225) % 360, 1) },
      ],
      pitch: pitchLabel,
      slope_factor: slopeFactor,
    });

    // Right hip (triangle)
    facets.push({
      id: "facet_4",
      label: "Right Hip",
      area_sqft: roundTo(triPlanarArea, 0),
      slope_area_sqft: triSlopeArea,
      edges: [
        { type: "eave", length_ft: roundTo(roofWidth, 0), bearing_deg: roundTo((dominantBearing + 270) % 360, 1) },
        { type: "hip", length_ft: hipLineLen, bearing_deg: roundTo((dominantBearing + 45) % 360, 1) },
        { type: "hip", length_ft: hipLineLen, bearing_deg: roundTo((dominantBearing + 135) % 360, 1) },
      ],
      pitch: pitchLabel,
      slope_factor: slopeFactor,
    });

    notes.push(`Hip: 4 facets (2 trapezoid @${trapSlopeArea}sqft, 2 triangle @${triSlopeArea}sqft).`);
    notes.push(`Ridge: ${ridgeLen}ft, Hip lines: 4×${hipLineLen}ft, Eave: 2×${roundTo(roofLength)}+2×${roundTo(roofWidth)}ft.`);

  } else if (resolvedType === "cross_gable") {
    // CROSS-GABLE: T/L/+ shape — main body + perpendicular wing
    // The bounding box (roofLength × roofWidth) encompasses both sections.
    // Key geometry: wing extends PERPENDICULAR to main body beyond its depth.

    const wingDepthRatio = 0.35;  // wing occupies ~35% of dominant axis
    const mainBodyRatio = 0.65;   // main body is ~65% of perpendicular extent

    const wingDepth = roofLength * wingDepthRatio;       // wing dimension along dominant axis
    const mainDepth = roofWidth * mainBodyRatio;          // main body perpendicular depth
    const wingExtPerSide = (roofWidth - mainDepth) / 2;  // how far wing extends beyond main body
    const halfMainDepth = mainDepth / 2;
    const halfWingDepth = wingDepth / 2;

    // ── RIDGES ──
    // Main ridge runs along dominant axis but NOT the full bounding box length.
    // It spans the main body section, shortened where the wing creates valley intersections.
    const mainRidgeLen = roundTo(roofLength - wingDepth * 0.5, 0);
    // Wing ridge: perpendicular extension beyond main body per side
    const wingRidgePerSide = roundTo(Math.max(wingExtPerSide, roofWidth * 0.05), 0);

    // ── AREAS ──
    // Use actual footprint area (not L×W which overcounts for T-shapes)
    const overhangScale = (dominantLen > 0 && perpLen > 0)
      ? (roofLength * roofWidth) / (dominantLen * perpLen)
      : 1;
    const effectiveFootprint = (candidate.area_sqft || dominantLen * perpLen) * overhangScale;

    // Main body takes ~70% of area, wing extensions take ~30%
    const mainFacetPlanar = roundTo(effectiveFootprint * 0.35, 0); // per slope (2 slopes)
    const wingFacetPlanar = roundTo(effectiveFootprint * 0.075, 0); // per extension facet (4 facets)
    const mainFacetSlope = roundTo(mainFacetPlanar * slopeFactor, 0);
    const wingFacetSlope = roundTo(wingFacetPlanar * slopeFactor, 0);

    // ── EAVE ──
    // Main eave: BOTH front and rear are interrupted where wing intersects (cross-gable is symmetric)
    const mainEaveFront = roundTo(Math.max(0, roofLength - wingDepth), 0);
    const mainEaveRear = roundTo(Math.max(0, roofLength - wingDepth), 0);
    // Wing extensions are gable ends — they have NO eave, only rake edges.
    // The wing's bottom edge runs perpendicular to main ridge → that's a rake, not eave.

    // ── RAKE (sloped gable-end edges from eave to ridge) ──
    // Main gable ends: 2 ends × 2 rakes each = 4 mainRake edges
    const mainRake = roundTo(halfMainDepth * slopeFactor, 0);
    // Wing gable ends: 2 ends × 2 rakes each × 2 sides = 8 wingRake edges
    const wingRake = roundTo(halfWingDepth * slopeFactor, 0);

    // ── VALLEY ──
    // Cross-gable has 2 unique valley lines (left + right of wing intersection).
    // Use the actual junction geometry: valley plan length is the diagonal from
    // the wing ridge end to the main-roof re-entrant corner, using the wing
    // half-depth and the wing extension beyond the main body.
    // Each valley is shared between front and rear main slopes, so we list it on
    // both facets and deduplicate in aggregation below.
    const valleyPlanLen = Math.hypot(halfWingDepth, Math.max(wingExtPerSide, 0));
    const valleyLen = roundTo(valleyPlanLen * slopeFactor, 0);

    // ── FACETS (6 total) ──
    // Facet 1: Main Front Slope (interrupted eave, 2 rakes, 2 valleys where wings intersect)
    facets.push({
      id: "facet_1", label: "Main Front Slope",
      area_sqft: mainFacetPlanar, slope_area_sqft: mainFacetSlope,
      edges: [
        { type: "eave", length_ft: mainEaveFront, bearing_deg: roundTo(dominantBearing, 1) },
        { type: "rake", length_ft: mainRake, bearing_deg: roundTo((dominantBearing + 90) % 360, 1) },
        { type: "ridge", length_ft: mainRidgeLen, bearing_deg: roundTo(dominantBearing, 1) },
        { type: "rake", length_ft: mainRake, bearing_deg: roundTo((dominantBearing + 270) % 360, 1) },
        { type: "valley", length_ft: valleyLen, bearing_deg: roundTo((dominantBearing + 45) % 360, 1) },
        { type: "valley", length_ft: valleyLen, bearing_deg: roundTo((dominantBearing + 315) % 360, 1) },
      ],
      pitch: pitchLabel, slope_factor: slopeFactor,
    });
    // Facet 2: Main Rear Slope (interrupted eave, 2 rakes, 2 valleys)
    facets.push({
      id: "facet_2", label: "Main Rear Slope",
      area_sqft: mainFacetPlanar, slope_area_sqft: mainFacetSlope,
      edges: [
        { type: "eave", length_ft: mainEaveRear, bearing_deg: roundTo((dominantBearing + 180) % 360, 1) },
        { type: "rake", length_ft: mainRake, bearing_deg: roundTo((dominantBearing + 90) % 360, 1) },
        { type: "ridge", length_ft: mainRidgeLen, bearing_deg: roundTo(dominantBearing, 1) },
        { type: "rake", length_ft: mainRake, bearing_deg: roundTo((dominantBearing + 270) % 360, 1) },
        { type: "valley", length_ft: valleyLen, bearing_deg: roundTo((dominantBearing + 135) % 360, 1) },
        { type: "valley", length_ft: valleyLen, bearing_deg: roundTo((dominantBearing + 225) % 360, 1) },
      ],
      pitch: pitchLabel, slope_factor: slopeFactor,
    });
    // Facets 3-6: Wing extension slopes (front+rear on each side)
    // Wing extensions are gable ends — NO eave edges, only rakes
    for (let side = 0; side < 2; side++) {
      const sideLabel = side === 0 ? "Left" : "Right";
      const sideBearing = side === 0 ? 90 : 270;
      facets.push({
        id: `facet_${3 + side * 2}`, label: `Wing ${sideLabel} Front`,
        area_sqft: wingFacetPlanar, slope_area_sqft: wingFacetSlope,
        edges: [
          { type: "rake", length_ft: wingRake, bearing_deg: roundTo(dominantBearing, 1) },
          { type: "ridge", length_ft: wingRidgePerSide, bearing_deg: roundTo((dominantBearing + sideBearing) % 360, 1) },
          { type: "rake", length_ft: wingRake, bearing_deg: roundTo((dominantBearing + 180) % 360, 1) },
        ],
        pitch: pitchLabel, slope_factor: slopeFactor,
      });
      facets.push({
        id: `facet_${4 + side * 2}`, label: `Wing ${sideLabel} Rear`,
        area_sqft: wingFacetPlanar, slope_area_sqft: wingFacetSlope,
        edges: [
          { type: "rake", length_ft: wingRake, bearing_deg: roundTo(dominantBearing, 1) },
          { type: "ridge", length_ft: wingRidgePerSide, bearing_deg: roundTo((dominantBearing + sideBearing) % 360, 1) },
          { type: "rake", length_ft: wingRake, bearing_deg: roundTo((dominantBearing + 180) % 360, 1) },
        ],
        pitch: pitchLabel, slope_factor: slopeFactor,
      });
    }

    notes.push(`Cross-gable: 6 facets (2 main @${mainFacetSlope}sqft, 4 wing @${wingFacetSlope}sqft).`);
    notes.push(`Main eave: front=${mainEaveFront}ft, rear=${mainEaveRear}ft (both interrupted by wing). No wing eave (gable ends).`);
    notes.push(`Main ridge: ${mainRidgeLen}ft, Wing ridge: 4×${wingRidgePerSide}ft.`);
    notes.push(`Valleys: 4×${valleyLen}ft (plan ${roundTo(valleyPlanLen, 1)}ft each). Main rake: 4×${mainRake}ft, Wing rake: 8×${wingRake}ft.`);
  } else {
    notes.push(`Roof type '${resolvedType}' not supported for facet decomposition.`);
    return null;
  }

  // Aggregate edge totals
  let totalEave = 0, totalRake = 0, totalRidge = 0, totalHip = 0, totalValley = 0;
  let totalSlopeArea = 0;
  for (const f of facets) {
    totalSlopeArea += f.slope_area_sqft;
    for (const e of f.edges) {
      if (e.type === "eave") totalEave += e.length_ft;
      else if (e.type === "rake") totalRake += e.length_ft;
      else if (e.type === "ridge") totalRidge += e.length_ft;
      else if (e.type === "hip") totalHip += e.length_ft;
      else if (e.type === "valley") totalValley += e.length_ft;
    }
  }
  // Deduplicate shared edges: ridge is shared between 2 adjacent slopes so halve it.
  // Valleys are NOT shared — each cross-gable valley is a distinct edge (front-left ≠ rear-left).
  totalRidge = roundTo(totalRidge / 2, 0);

  notes.push(`Totals: eave=${roundTo(totalEave)}ft, rake=${roundTo(totalRake)}ft, ridge=${totalRidge}ft, hip=${roundTo(totalHip)}ft, valley=${roundTo(totalValley)}ft.`);
  notes.push(`Total slope area: ${roundTo(totalSlopeArea)}sqft (${roundTo(totalSlopeArea / 100, 1)} squares).`);

  return {
    facets,
    total_eave_lf: roundTo(totalEave, 0),
    total_rake_lf: roundTo(totalRake, 0),
    total_ridge_lf: totalRidge,
    total_hip_lf: roundTo(totalHip, 0),
    total_valley_lf: roundTo(totalValley, 0),
    total_slope_area_sqft: roundTo(totalSlopeArea, 0),
    total_squares: roundTo(totalSlopeArea / 100, 1),
    roof_type_used: resolvedType,
    decomposition_notes: notes,
  };
}

// ── Roof estimate assembly (deterministic — no AI for measurements) ──

function deriveRoofEstimate(
  address: string,
  lat: number,
  lng: number,
  parcel: { parcelArea?: number; landUse?: string; yearBuilt?: number; source: string } | null,
  elevation: number | null,
  selectedCandidate: CandidateFootprint | null,
  allCandidates: CandidateFootprint[],
  roofFormInference: RoofFormInference | null,
  visionResult: SatelliteVisionResult | null,
  suppressions: SuppressionRecord[],
  exactPitchRise: number | null = null,
  userRoofType: string | null = null,
): RoofEstimateResult {
  const hasGeometry = !!selectedCandidate;
  const footprintArea = selectedCandidate?.area_sqft ?? 0;
  const overhang: OverhangConfig = DEFAULT_OVERHANG;

  // ── Pitch — prefer exact pitch when provided ──
  let pitchBand: PitchBand = "unknown";
  let pitchType: PitchType = "band";
  let slopeFactor = PITCH_BAND_META.unknown.slope_factor_mid;
  let pitchIsDefaultFallback = false;
  let exactPitchUsed: string | null = null;

  if (exactPitchRise != null && exactPitchRise >= 0 && exactPitchRise <= 24) {
    // EXACT PITCH: compute precise slope factor = sqrt(1 + (rise/12)²)
    slopeFactor = Math.sqrt(1 + (exactPitchRise / 12) ** 2);
    pitchBand = exactPitchToBand(`${exactPitchRise}/12`);
    pitchType = "exact";
    exactPitchUsed = `${exactPitchRise}/12`;
    console.log(`[Darwin Roof] Exact pitch: ${exactPitchUsed}, slope_factor=${roundTo(slopeFactor, 5)}`);
  } else if (visionResult && !visionResult.pitch_band.abstain && visionResult.pitch_band.confidence >= 20) {
    pitchBand = visionResult.pitch_band.value;
    slopeFactor = PITCH_BAND_META[pitchBand].slope_factor_mid;
  } else if (hasGeometry) {
    // Fallback: use moderate pitch when vision is unavailable/abstained
    pitchBand = "moderate";
    slopeFactor = PITCH_BAND_META.moderate.slope_factor_mid;
    pitchIsDefaultFallback = true;
  }

  // ── Area calculation ──
  // For authoritative sources (Microsoft, NJGIN, Local DB), the footprint polygon
  // already represents the building outline including overhangs as captured by aerial
  // imagery. We use the RAW footprint area × slope factor — no overhang expansion,
  // no artificial correction factors. This produces the most accurate results when
  // compared to professional measurement reports (e.g., GAF QuickMeasure).
  let roofArea = 0, squares = 0;
  let roofPolyResult: RoofPolygonResult | null = null;
  let roofPolygonGeoJson: any = null;
  let planarRoofAreaSqft = 0;
  let correctionFactorUsed: number | null = null;

  const isAuthoritativeSource = (selectedCandidate?.source ?? "").includes("Microsoft") ||
    (selectedCandidate?.source ?? "").includes("NJGIN") ||
    (selectedCandidate?.source ?? "").includes("Local DB");

  if (hasGeometry && selectedCandidate) {
    const [cLng, cLat] = polygonCentroid(selectedCandidate.polygon);
    const localXY = lngLatRingToLocalXY(selectedCandidate.polygon, cLat, cLng);

    // Map edge classifications for polygon expansion
    const edgeClsForExpansion: EdgeClassForExpansion[] = (selectedCandidate.edge_classifications || []).map(ec => ({
      classification: ec.classification as EdgeClass,
    }));

    roofPolyResult = buildRoofPolygonFromFootprint(localXY, edgeClsForExpansion, overhang);

    if (isAuthoritativeSource) {
      // AUTHORITATIVE: use raw footprint area directly — no overhang expansion, no correction
      planarRoofAreaSqft = selectedCandidate.area_sqft;
      correctionFactorUsed = 1.0;
      console.log(`[Darwin Roof] Authoritative source: using raw footprint area ${planarRoofAreaSqft} sqft (no expansion/correction)`);
    } else {
      // Non-authoritative (AI Vision, etc.): use expanded area + corrections
      planarRoofAreaSqft = roofPolyResult.expanded_planar_area_sqft;
      correctionFactorUsed = getValidationDerivedAreaCorrection({
        inferredRoofForm: roofFormInference?.inferred_roof_form ?? null,
        geometrySource: selectedCandidate.geometry_metadata?.source_name ?? null,
        geometryQualityScore: selectedCandidate.geometry_quality_score,
        pitchBand: pitchBand,
      });
    }

    // Build GeoJSON for the expanded roof polygon (still useful for visualization)
    roofPolygonGeoJson = buildPolygonGeoJson(roofPolyResult.roof_polygon, { lng: cLng, lat: cLat });

    roofArea = roundTo(planarRoofAreaSqft * slopeFactor * correctionFactorUsed, 0);
    squares = roundTo(roofArea / 100, 1);
  }

  // ── Imagery Analysis, Suggested Outline, Mass Decomposition, Calibration ──
  const origin: LngLat = { lng, lat };
  const selectedRing: number[][] = selectedCandidate?.polygon ?? [];
  const selectedLocalXY: LocalPoint[] = selectedRing.length >= 3
    ? lngLatRingToLocalXY(selectedRing, lat, lng)
    : [];

  const imageryAnalysis = buildMultiImageAnalysis({
    visionRoofForm: visionResult?.roof_form?.value ?? null,
    visionRoofFormConfidence: visionResult?.roof_form?.confidence ?? null,
    visibleFacetCount: visionResult?.visible_facets?.value ?? null,
    visibleFacetConfidence: visionResult?.visible_facets?.confidence ?? null,
  });

  const suggestedOutline = buildSuggestedRoofOutline({
    selectedFootprintLocalXY: selectedLocalXY,
    visibleFacetCount: imageryAnalysis.visible_facet_count,
    complexity: imageryAnalysis.complexity,
    overhangEaveFt: overhang.eave_overhang_ft,
    overhangRakeFt: overhang.rake_overhang_ft,
    origin,
  });

  const simpleMasses = decomposeSimpleMasses({
    footprintLocalXY: selectedLocalXY,
    analysis: imageryAnalysis,
  });

  // For authoritative sources, skip calibration adjustment — the footprint area is the source of truth
  const calibrationAdjustmentFactor = isAuthoritativeSource ? 1.0 : getCalibrationAdjustmentFactor({
    inferredRoofForm: roofFormInference?.inferred_roof_form ?? null,
    complexity: imageryAnalysis.complexity,
    geometryQualityScore: selectedCandidate?.geometry_quality_score ?? null,
    source: selectedCandidate?.source ?? null,
  });

  // Apply calibration factor to area if it differs from 1.0
  if (calibrationAdjustmentFactor !== 1.0 && roofArea > 0) {
    roofArea = roundTo(roofArea * calibrationAdjustmentFactor, 0);
    squares = roundTo(roofArea / 100, 1);
  }

  // ── Shape Conflict Detection ──
  function isSimpleGeometryShape(vertexCount: number | null, inferredForm: string | null): boolean {
    const v = vertexCount ?? 0;
    const form = (inferredForm || "").toLowerCase();
    return v <= 4 || form === "gable" || form === "hip";
  }

  function detectShapeConflict(
    vertexCount: number | null,
    inferredForm: string | null,
    vision: SatelliteVisionResult | null
  ): { conflict: boolean; reason: string | null } {
    const simpleGeom = isSimpleGeometryShape(vertexCount, inferredForm);
    if (!simpleGeom || !vision) return { conflict: false, reason: null };

    const visionForm = vision.roof_form.value;
    const visionFormConf = vision.roof_form.confidence;
    const visionFacets = vision.visible_facets.value;
    const visionFacetConf = vision.visible_facets.confidence;

    const complexVision = (visionForm === "complex" || visionForm === "cross_gable" || visionForm === "cross_hip") && visionFormConf >= 70;
    const highFacetVision = typeof visionFacets === "number" && visionFacets >= 8 && visionFacetConf >= 70;

    if (complexVision || highFacetVision) {
      const reasons: string[] = [];
      reasons.push(`Selected footprint is simple (${vertexCount ?? 0} vertices / ${inferredForm ?? "unknown"} geometry)`);
      if (complexVision) reasons.push(`satellite vision says ${visionForm} @ ${visionFormConf}%`);
      if (highFacetVision) reasons.push(`visible facets ${visionFacets} @ ${visionFacetConf}%`);
      return { conflict: true, reason: reasons.join("; ") };
    }
    return { conflict: false, reason: null };
  }

  function getComplexityUplift(
    facets: number | null,
    qualityScore: number | null,
    source: string | null,
    hasBetterAlt: boolean
  ): number {
    const src = (source || "").toLowerCase();
    const sourceIsWeak = src.includes("ai vision") || src.includes("satellite") || src.includes("vision");
    if (!sourceIsWeak) return 1.0;
    if ((qualityScore ?? 0) >= 60) return 1.0;
    if (hasBetterAlt) return 1.0;
    const f = facets ?? 0;
    if (f >= 12) return 1.20;
    if (f >= 10) return 1.15;
    if (f >= 8) return 1.10;
    return 1.0;
  }

  function findBetterAlternate(
    selectedIdx: number | null | undefined,
    candidates: any[] | null
  ): { found: boolean; betterIndex: number | null } {
    if (selectedIdx == null || !candidates || !candidates[selectedIdx]) return { found: false, betterIndex: null };
    const currentQ = candidates[selectedIdx].geometry_quality_score ?? 0;
    let bestIdx: number | null = null;
    let bestScore = currentQ;
    for (let i = 0; i < candidates.length; i++) {
      if (i === selectedIdx) continue;
      const q = candidates[i].geometry_quality_score ?? 0;
      const src = (candidates[i].source || "").toLowerCase();
      const nonAI = !src.includes("ai vision") && !src.includes("satellite") && !src.includes("vision");
      if (nonAI && q >= currentQ + 15 && q > bestScore) {
        bestScore = q;
        bestIdx = i;
      }
    }
    return { found: bestIdx != null, betterIndex: bestIdx };
  }

  // Compute vertex count for selected candidate
  const selectedVertexCount = selectedCandidate
    ? (selectedCandidate.polygon.length > 0 && selectedCandidate.polygon[selectedCandidate.polygon.length - 1][0] === selectedCandidate.polygon[0][0]
      ? selectedCandidate.polygon.length - 1
      : selectedCandidate.polygon.length)
    : null;

  const shapeConflictCheck = detectShapeConflict(
    selectedVertexCount,
    roofFormInference?.inferred_roof_form ?? null,
    visionResult,
  );

  const selectedIdx = selectedCandidate && allCandidates.length > 0 ? allCandidates.indexOf(selectedCandidate) : null;
  const betterAlt = findBetterAlternate(selectedIdx, allCandidates.length > 0 ? allCandidates : null);

  let roof_shape_conflict = shapeConflictCheck.conflict;
  let roof_shape_conflict_reason = shapeConflictCheck.reason;
  let provisional_complexity_uplift_used = 1.0;
  let shape_conflicted_roof_area_sqft: number | null = null;
  let shape_conflicted_squares: number | null = null;

  // ── Resolve roof form ──
  // Start with geometry inference — use it even at low confidence as a baseline
  let resolvedRoofForm: RoofForm = roofFormInference?.inferred_roof_form ?? "unknown";

  // Vision can upgrade form if it has higher confidence than geometry
  if (visionResult && !visionResult.roof_form.abstain && visionResult.roof_form.confidence > 30) {
    const vf = visionResult.roof_form.value;
    if (vf === "cross_hip" || vf === "gambrel" || vf === "mansard") resolvedRoofForm = "complex";
    else if (["gable", "hip", "cross_gable", "complex"].includes(vf)) resolvedRoofForm = vf as RoofForm;
    // Geometry wins if its confidence is higher
    if (roofFormInference && roofFormInference.roof_form_confidence > visionResult.roof_form.confidence) {
      resolvedRoofForm = roofFormInference.inferred_roof_form;
    }
  }

  // Last resort: if form is still "unknown" but we have geometry with 4 sides,
  // default to gable (most common residential form) with very low confidence
  if (resolvedRoofForm === "unknown" && hasGeometry && selectedCandidate) {
    const vertexCount = selectedCandidate.polygon.length;
    const effectiveVertices = (selectedCandidate.polygon[vertexCount - 1][0] === selectedCandidate.polygon[0][0]) ? vertexCount - 1 : vertexCount;
    if (effectiveVertices <= 6) {
      const ar = roofFormInference?.aspect_ratio ?? 1;
      resolvedRoofForm = ar >= 1.3 ? "gable" : "hip";
      console.log(`[Darwin Roof] Form fallback: ${resolvedRoofForm} (AR=${ar}, vertices=${effectiveVertices})`);
    }
  }

  // ── Deterministic derivation with mass decomposition ──
  const { linear: rawLinear, decomposition } = deriveLinearMeasurements(selectedCandidate, roofFormInference, resolvedRoofForm, pitchBand, overhang);
  const { validated: linear, validationNotes } = applyVisionLinearValidation(rawLinear, resolvedRoofForm, visionResult);

  // Vision facet fallback
  let resolvedFacets = linear.facet_count;
  if (resolvedFacets === null && visionResult && !visionResult.visible_facets.abstain && visionResult.visible_facets.confidence >= 25) {
    resolvedFacets = visionResult.visible_facets.value;
  }

  // ── Sanitise (null-safe) ──
  const confScore = hasGeometry ? Math.min(45, selectedCandidate!.geometry_quality_score * 0.5) : 10;

  // ── Field sources ──
  const fieldSources: Record<string, DerivationSource> = {
    footprint_area_sqft: hasGeometry ? "geometry" : "ai_estimated",
    roof_planar_area_sqft: hasGeometry ? "geometry" : "ai_estimated",
    estimated_roof_area_sqft: (hasGeometry && pitchBand !== "unknown") ? "geometry" : "ai_estimated",
    squares: (hasGeometry && pitchBand !== "unknown") ? "geometry" : "ai_estimated",
    dominant_pitch: (visionResult && !visionResult.pitch_band.abstain) ? "satellite_imagery" : "ai_estimated",
    ridge_lf: (hasGeometry && linear.ridge_lf !== null) ? "geometry" : "ai_estimated",
    hip_lf: (hasGeometry && linear.hip_lf !== null) ? "geometry" : "ai_estimated",
    valley_lf: (hasGeometry && linear.valley_lf !== null) ? "geometry" : "ai_estimated",
    eave_lf: (hasGeometry && linear.eave_lf !== null) ? "geometry" : "ai_estimated",
    rake_lf: (hasGeometry && linear.rake_lf !== null) ? "geometry" : "ai_estimated",
    facet_count: (resolvedFacets !== null && linear.facet_count !== null) ? "geometry"
      : (visionResult && !visionResult.visible_facets.abstain && visionResult.visible_facets.confidence >= 25) ? "satellite_imagery"
      : "ai_estimated",
  };

  // ── Field confidence ──
  const fieldConfidence: Record<string, number> = {
    footprint_area_sqft: hasGeometry ? Math.max(75, 70) : 0,
    roof_planar_area_sqft: hasGeometry ? 65 : 0,
    estimated_roof_area_sqft: hasGeometry ? Math.max((pitchIsDefaultFallback ? 35 : 60), 45) : 0,
    squares: hasGeometry ? Math.max((pitchIsDefaultFallback ? 35 : 60), 45) : 0,
    dominant_pitch: pitchIsDefaultFallback ? 15 : ((visionResult && !visionResult.pitch_band.abstain) ? visionResult.pitch_band.confidence : 0),
    ridge_lf: linear.linear_confidence.ridge_lf ?? 0,
    hip_lf: linear.linear_confidence.hip_lf ?? 0,
    valley_lf: linear.linear_confidence.valley_lf ?? 0,
    eave_lf: linear.linear_confidence.eave_lf ?? 0,
    rake_lf: linear.linear_confidence.rake_lf ?? 0,
    facet_count: linear.linear_confidence.facet_count ?? 0,
  };

  // ── Field authority: null values get explicit unknown status ──
  const fieldAuthority: Record<string, FieldAuthority> = {
    footprint_area_sqft: hasGeometry ? "geometry_authoritative" : "ai_provisional",
    roof_planar_area_sqft: hasGeometry ? "geometry_authoritative" : "ai_provisional",
    estimated_roof_area_sqft: hasGeometry ? (pitchIsDefaultFallback ? "ai_provisional" : "geometry_authoritative") : "ai_provisional",
    squares: hasGeometry ? (pitchIsDefaultFallback ? "ai_provisional" : "geometry_authoritative") : "ai_provisional",
    dominant_pitch: "ai_provisional",
    ridge_lf: linear.ridge_lf !== null ? (hasGeometry ? "geometry_authoritative" : "ai_provisional") : "unknown_insufficient_geometry",
    hip_lf: linear.hip_lf !== null ? (hasGeometry ? "geometry_authoritative" : "ai_provisional") : "unknown_insufficient_geometry",
    valley_lf: linear.valley_lf !== null ? (hasGeometry ? "geometry_authoritative" : "ai_provisional") : "unknown_insufficient_geometry",
    eave_lf: linear.eave_lf !== null ? (hasGeometry ? "geometry_authoritative" : "ai_provisional") : "unknown_insufficient_geometry",
    rake_lf: linear.rake_lf !== null ? (hasGeometry ? "geometry_authoritative" : "ai_provisional") : "unknown_insufficient_geometry",
    facet_count: resolvedFacets !== null ? "ai_provisional" : "unknown_insufficient_geometry",
  };

  // ── Apply shape conflict ──
  if (roof_shape_conflict) {
    const visibleFacetCount = visionResult?.visible_facets?.value ?? null;
    provisional_complexity_uplift_used = getComplexityUplift(
      visibleFacetCount,
      selectedCandidate?.geometry_quality_score ?? null,
      selectedCandidate?.source ?? null,
      betterAlt.found,
    );

    if (provisional_complexity_uplift_used > 1.0 && roofArea > 0) {
      shape_conflicted_roof_area_sqft = Math.round(roofArea * provisional_complexity_uplift_used);
      shape_conflicted_squares = Math.round((shape_conflicted_roof_area_sqft / 100) * 10) / 10;
    }

    fieldAuthority.estimated_roof_area_sqft = "ai_provisional";
    fieldAuthority.squares = "ai_provisional";
    fieldConfidence.estimated_roof_area_sqft = Math.min(fieldConfidence.estimated_roof_area_sqft ?? 45, 35);
    fieldConfidence.squares = Math.min(fieldConfidence.squares ?? 45, 35);

  }

  // Shape conflict notes are appended after notes array is initialized (see below)

  // ── Notes ──
  const displayPitch = pitchBand !== "unknown" ? bandToDisplayPitch(pitchBand) : "unknown";
  const notes: string[] = [];
  notes.push(`Pitch: ${displayPitch} (${pitchType})${pitchIsDefaultFallback ? " [DEFAULT FALLBACK — no vision pitch available]" : ""}. Roof form: ${resolvedRoofForm}.`);
  notes.push(`📐 Overhang: eave=${overhang.eave_overhang_ft}ft, rake=${overhang.rake_overhang_ft}ft (${overhang.source}).`);
  if (hasGeometry) {
    notes.push(`📐 Footprint: ${footprintArea} sqft from ${selectedCandidate!.source} (quality: ${selectedCandidate!.geometry_quality_score}/100).`);
    if (roofPolyResult) {
      notes.push(`📐 Roof polygon expansion: ${roundTo(roofPolyResult.original_planar_area_sqft, 0)} sqft → ${roundTo(roofPolyResult.expanded_planar_area_sqft, 0)} sqft (+${roundTo(roofPolyResult.area_gain_sqft, 0)} sqft from overhang).`);
    }
    if (roofArea > 0) notes.push(`📐 Slope-adjusted area: ${roundTo(planarRoofAreaSqft, 0)} × ${slopeFactor} = ${roofArea} sqft.`);
  }
  if (decomposition && decomposition.masses.length > 1) {
    const promoted = decomposition.junction_valleys.filter(jv => jv.status === "promoted").length;
    const candidate = decomposition.junction_valleys.filter(jv => jv.status === "candidate").length;
    notes.push(`🏗️ Mass decomposition (${decomposition.decomposition_method}): ${decomposition.masses.length} masses, ${promoted} promoted + ${candidate} candidate junction valley(s).`);
    for (const m of decomposition.masses) {
      const cls = m.classification;
      notes.push(`  • Mass ${m.id}: ${cls?.mass_type ?? "unclassified"} (${cls?.confidence ?? 0}% conf, weight=${cls?.derivation_weight ?? 1}, ${Math.round((cls?.footprint_contribution ?? 0) * 100)}% of footprint)`);
    }
    for (const dn of decomposition.notes) notes.push(`  • ${dn}`);
  } else if (decomposition && decomposition.masses.length === 1) {
    const cls = decomposition.masses[0].classification;
    if (cls) notes.push(`🏗️ Single mass: ${cls.mass_type} (${cls.confidence}% conf).`);
  }
  notes.push(`📏 Linear derivation (rule-based):`);
  for (const dn of linear.derivation_notes) notes.push(`  • ${dn}`);
  if (validationNotes.length > 0) {
    notes.push(`🛰️ Vision validation:`);
    for (const vn of validationNotes) notes.push(`  • ${vn}`);
  }
  if (linear.unknown_fields.length > 0) {
    notes.push(`⚠️ Null fields (geometry insufficient): ${linear.unknown_fields.join(", ")}`);
  }
  if (visionResult) {
    notes.push(`🛰️ Vision: form=${visionResult.roof_form.value}@${visionResult.roof_form.confidence}%${visionResult.roof_form.abstain ? "(abstained)" : ""}, pitch=${visionResult.pitch_band.value}@${visionResult.pitch_band.confidence}%${visionResult.pitch_band.abstain ? "(abstained)" : ""}, facets=${visionResult.visible_facets.value}@${visionResult.visible_facets.confidence}%${visionResult.visible_facets.abstain ? "(abstained)" : ""}`);
  }
  if (suppressions.length > 0) {
    notes.push(`⚠️ ${suppressions.length} suppression(s): ${suppressions.map(s => `${s.rule}→${s.field}`).join(", ")}`);
  }
  // Shape conflict notes (deferred from above to avoid accessing notes before init)
  if (roof_shape_conflict) {
    notes.push(`⚠️ SHAPE CONFLICT: ${roof_shape_conflict_reason}`);
    if (provisional_complexity_uplift_used > 1.0) {
      notes.push(`📊 Provisional complexity uplift: ×${provisional_complexity_uplift_used} → ${shape_conflicted_roof_area_sqft} sqft / ${shape_conflicted_squares} squares`);
    }
    if (betterAlt.found) {
      notes.push(`💡 Better alternate footprint candidate available at index ${betterAlt.betterIndex}`);
    }
  }
  notes.push("\n⚠️ PRELIMINARY. Linear values are geometry-derived with null for unsupported fields. Overhang is configurable. All values require manual confirmation.");

  // ── Per-Facet Decomposition ──
  const facetDecomposition = decomposeFacetsFromFootprint(
    selectedCandidate, roofFormInference, userRoofType, slopeFactor, exactPitchUsed || displayPitch, overhang,
  );
  if (facetDecomposition) {
    console.info(`[Darwin Roof] Facet decomposition: type=${facetDecomposition.roof_type_used}, ridge=${facetDecomposition.total_ridge_lf}, eave=${facetDecomposition.total_eave_lf}, rake=${facetDecomposition.total_rake_lf}, hip=${facetDecomposition.total_hip_lf}, valley=${facetDecomposition.total_valley_lf}`);
    notes.push(`\n🔷 FACET DECOMPOSITION (${facetDecomposition.roof_type_used}):`);
    for (const fn of facetDecomposition.decomposition_notes) notes.push(`  • ${fn}`);
  }

  // ── Override linear values from facet decomposition when available ──
  // Facet decomposition produces more accurate eave/rake/ridge/hip/valley values
  // because it models the actual roof shape rather than just classifying footprint edges.
  let finalRidge = linear.ridge_lf;
  let finalHip = linear.hip_lf;
  let finalValley = linear.valley_lf;
  let finalEave = linear.eave_lf;
  let finalRake = linear.rake_lf;
  let finalFacets = resolvedFacets;

  if (facetDecomposition) {
    const fd = facetDecomposition;
    // Only override when facet decomposition has meaningful values
    if (fd.total_ridge_lf > 0 || fd.total_eave_lf > 0 || fd.total_rake_lf > 0) {
      finalRidge = fd.total_ridge_lf;
      finalHip = fd.total_hip_lf;
      finalValley = fd.total_valley_lf;
      finalEave = fd.total_eave_lf;
      finalRake = fd.total_rake_lf;
      finalFacets = fd.facets.length;

      // Update field sources and confidence to reflect facet-based derivation
      fieldSources.ridge_lf = hasGeometry ? "geometry" : "ai_estimated";
      fieldSources.hip_lf = hasGeometry ? "geometry" : "ai_estimated";
      fieldSources.valley_lf = hasGeometry ? "geometry" : "ai_estimated";
      fieldSources.eave_lf = hasGeometry ? "geometry" : "ai_estimated";
      fieldSources.rake_lf = hasGeometry ? "geometry" : "ai_estimated";
      fieldSources.facet_count = hasGeometry ? "geometry" : "ai_estimated";

      // Facet decomposition confidence: higher than raw edge classification
      const facetConf = userRoofType ? 55 : 35; // user-specified roof type = higher confidence
      fieldConfidence.ridge_lf = facetConf;
      fieldConfidence.hip_lf = facetConf;
      fieldConfidence.valley_lf = facetConf;
      fieldConfidence.eave_lf = facetConf;
      fieldConfidence.rake_lf = facetConf;
      fieldConfidence.facet_count = facetConf;

      // Update authority
      const facetAuth: FieldAuthority = hasGeometry ? "geometry_authoritative" : "ai_provisional";
      fieldAuthority.ridge_lf = facetAuth;
      fieldAuthority.hip_lf = facetAuth;
      fieldAuthority.valley_lf = facetAuth;
      fieldAuthority.eave_lf = facetAuth;
      fieldAuthority.rake_lf = facetAuth;
      fieldAuthority.facet_count = facetAuth;

      notes.push(`\n✅ Linear values overridden by facet decomposition (${fd.roof_type_used}): eave=${finalEave}, rake=${finalRake}, ridge=${finalRidge}, hip=${finalHip}, valley=${finalValley}, facets=${finalFacets}.`);
    }
  }

  return {
    footprint_area_sqft: footprintArea,
    estimated_roof_area_sqft: roofArea,
    squares,
    dominant_pitch: displayPitch,
    pitch_band: pitchBand,
    pitch_type: pitchType,
    ridge_lf: finalRidge,
    hip_lf: finalHip,
    valley_lf: finalValley,
    eave_lf: finalEave,
    rake_lf: finalRake,
    facet_count: finalFacets,
    confidence_score: roundTo(confScore, 0),
    review_required: true,
    overlay_image_url: null,
    raw_geojson: selectedCandidate?.geojson || null,
    ai_notes: notes.filter(Boolean).join("\n"),
    data_sources: [
      "US Census Geocoder",
      ...(selectedCandidate ? [selectedCandidate.source] : []),
      ...(roofFormInference ? ["Geometry Roof Form Inference"] : []),
      ...(visionResult ? ["Satellite Vision Classification (ArcGIS World Imagery)"] : []),
      "Deterministic Linear Derivation Engine v3",
      ...(decomposition && decomposition.masses.length > 1 ? ["Roof Mass Decomposition + Classification"] : []),
      ...(decomposition && decomposition.masses.some(m => m.classification) ? ["Mass Type Weighting"] : []),
      ...(roofPolyResult ? ["Roof Polygon Expansion (Overhang)"] : []),
    ],
    field_sources: fieldSources,
    field_confidence: fieldConfidence,
    field_authority: fieldAuthority,
    footprint_polygon: selectedCandidate ? { type: "Polygon", coordinates: [selectedCandidate.polygon] } : null,
    footprint_perimeter_ft: selectedCandidate?.perimeter_ft ?? null,
    imagery_source: selectedCandidate?.source ?? null,
    imagery_date: selectedCandidate?.imagery_date ?? null,
    geometry_quality_score: selectedCandidate?.geometry_quality_score ?? null,
    edge_classifications: selectedCandidate?.edge_classifications ?? null,
    geometry_metadata: selectedCandidate?.geometry_metadata ?? null,
    candidate_footprints: allCandidates.length > 0 ? allCandidates : null,
    selected_candidate_index: selectedCandidate && allCandidates.length > 0 ? allCandidates.indexOf(selectedCandidate) : null,
    inferred_roof_form: roofFormInference?.inferred_roof_form ?? null,
    roof_form_confidence: roofFormInference?.roof_form_confidence ?? null,
    roof_form_reasoning: roofFormInference?.roof_form_reasoning ?? null,
    dominant_axis_bearing: roofFormInference?.dominant_axis_bearing ?? null,
    dominant_axis_length_ft: roofFormInference?.dominant_axis_length_ft ?? null,
    perpendicular_axis_length_ft: roofFormInference?.perpendicular_axis_length_ft ?? null,
    aspect_ratio: roofFormInference?.aspect_ratio ?? null,
    ridge_candidates: roofFormInference?.ridge_candidates ?? null,
    hip_valley_candidates: roofFormInference?.hip_valley_candidates ?? null,
    vision_classifications: visionResult,
    suppression_records: suppressions.length > 0 ? suppressions : null,
    roof_mass_decomposition: decomposition,
    overhang_config: overhang,
    // Phase 3: Roof polygon expansion
    roof_planar_area_sqft: roofPolyResult ? roundTo(roofPolyResult.expanded_planar_area_sqft, 0) : null,
    roof_polygon_geojson: roofPolygonGeoJson,
    planar_area_gain_sqft: roofPolyResult ? roundTo(roofPolyResult.area_gain_sqft, 0) : null,
    // Debug: intermediate calculation values
    slope_factor_used: hasGeometry ? slopeFactor : null,
    correction_factor_used: correctionFactorUsed,
    // Shape conflict
    roof_shape_conflict,
    roof_shape_conflict_reason,
    provisional_complexity_uplift_used,
    shape_conflicted_roof_area_sqft,
    shape_conflicted_squares,
    // New: suggested outline, mass, imagery, calibration
    suggested_roof_polygon_geojson: suggestedOutline.polygon_geojson,
    suggested_roof_polygon_source: suggestedOutline.source,
    suggested_roof_polygon_confidence: suggestedOutline.confidence,
    suggested_roof_outline_notes: suggestedOutline.notes,
    roof_mass_count: simpleMasses.length > 0 ? simpleMasses.length : null,
    roof_mass_polygons: simpleMasses.length > 0 ? simpleMasses.map(m => ({
      id: m.id, label: m.label, confidence: m.confidence,
      polygon_geojson: buildPolygonGeoJson(m.polygon, origin),
    })) : null,
    imagery_analysis: imageryAnalysis,
    calibration_adjustment_factor: calibrationAdjustmentFactor,
    facet_decomposition: facetDecomposition,
  };
}

// ── Phase 2D: Tuning heuristics application with governance ─────────

// Global per-estimate governance caps
const ESTIMATE_CAPS = {
  MAX_TOTAL_AREA_ADJUSTMENT_PCT: 25,    // Combined area fields can't shift >25%
  MAX_TOTAL_CONFIDENCE_REDUCTION_PCT: 50, // Combined confidence can't drop >50%
  ONE_ADJUSTMENT_PER_FIELD: true,         // Only the highest-priority heuristic adjusts each field
};

interface TuningHeuristic {
  id: string;
  heuristic_key: string;
  action_type: string;
  adjustment_field: string | null;
  adjustment_factor: number | null;
  suppress_field: string | null;
  suppress_below_confidence: number | null;
  segment_roof_form: string | null;
  segment_quality_score_min: number | null;
  segment_quality_score_max: number | null;
  segment_aspect_ratio_min: number | null;
  segment_aspect_ratio_max: number | null;
  evidence_summary: string | null;
  // Governance
  min_sample_size: number | null;
  sample_size: number | null;
  effective_from: string | null;
  expires_at: string | null;
  last_validation_support_at: string | null;
  staleness_days: number | null;
  max_adjustment_factor: number | null;
  min_adjustment_factor: number | null;
  max_confidence_penalty: number | null;
  priority: number | null;
  conflict_group: string | null;
  governance_status: string | null;
  // Shadow mode
  shadow_mode: boolean;
  shadow_mode_hits: number | null;
  shadow_mode_min_hits: number | null;
}

interface ExplanationStep {
  order: number;
  heuristic_key: string;
  action_type: string;
  field: string;
  action: string;
  before: number;
  after: number;
  segment_match: string;
  evidence_basis: string;
  governance_status: string;
  was_capped: boolean;
  was_suppressed: boolean;
  suppression_reason: string | null;
}

function matchesHeuristic(
  h: TuningHeuristic,
  roofForm: string | null,
  qualityScore: number | null,
  aspectRatio: number | null,
): boolean {
  if (h.segment_roof_form && h.segment_roof_form !== roofForm) return false;
  if (h.segment_quality_score_min != null && (qualityScore ?? 0) < h.segment_quality_score_min) return false;
  if (h.segment_quality_score_max != null && (qualityScore ?? 100) > h.segment_quality_score_max) return false;
  if (h.segment_aspect_ratio_min != null && (aspectRatio ?? 1) < h.segment_aspect_ratio_min) return false;
  if (h.segment_aspect_ratio_max != null && (aspectRatio ?? 1) > h.segment_aspect_ratio_max) return false;
  return true;
}

function isGovernanceEligible(h: TuningHeuristic): { eligible: boolean; reason: string } {
  const now = Date.now();
  if (h.min_sample_size != null && (h.sample_size ?? 0) < h.min_sample_size) {
    return { eligible: false, reason: `Insufficient evidence: ${h.sample_size ?? 0} < ${h.min_sample_size}` };
  }
  if (h.effective_from && new Date(h.effective_from).getTime() > now) {
    return { eligible: false, reason: `Not yet effective` };
  }
  if (h.expires_at && new Date(h.expires_at).getTime() < now) {
    return { eligible: false, reason: `Expired` };
  }
  if (h.last_validation_support_at && h.staleness_days) {
    const daysSince = (now - new Date(h.last_validation_support_at).getTime()) / 86400000;
    if (daysSince > h.staleness_days) {
      return { eligible: false, reason: `Stale: ${Math.round(daysSince)}d since last support` };
    }
  }
  if (h.governance_status && ["expired", "stale", "insufficient_evidence", "conflict_suppressed"].includes(h.governance_status)) {
    return { eligible: false, reason: `Governance status: ${h.governance_status}` };
  }
  return { eligible: true, reason: "OK" };
}

function resolveConflicts(matched: TuningHeuristic[]): { winners: TuningHeuristic[]; suppressed: { heuristic: TuningHeuristic; reason: string }[] } {
  const suppressed: { heuristic: TuningHeuristic; reason: string }[] = [];
  const byGroup = new Map<string, TuningHeuristic[]>();
  for (const h of matched) {
    const group = h.conflict_group || h.heuristic_key;
    if (!byGroup.has(group)) byGroup.set(group, []);
    byGroup.get(group)!.push(h);
  }
  const winners: TuningHeuristic[] = [];
  for (const [group, heurs] of byGroup) {
    if (heurs.length === 1) { winners.push(heurs[0]); continue; }
    heurs.sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100) || (b.sample_size ?? 0) - (a.sample_size ?? 0));
    winners.push(heurs[0]);
    for (let i = 1; i < heurs.length; i++) {
      suppressed.push({ heuristic: heurs[i], reason: `Conflict: superseded by "${heurs[0].heuristic_key}"` });
    }
  }
  // Suppress adjustments when same field is also suppressed
  const suppressedFields = new Set(winners.filter(h => h.action_type === "suppress_field" && h.suppress_field).map(h => h.suppress_field!));
  const final: TuningHeuristic[] = [];
  for (const h of winners) {
    if (h.action_type === "adjust_value" && h.adjustment_field && suppressedFields.has(h.adjustment_field)) {
      suppressed.push({ heuristic: h, reason: `Redundant: "${h.adjustment_field}" also suppressed` });
    } else {
      final.push(h);
    }
  }
  return { winners: final, suppressed };
}

function buildSegmentDesc(h: TuningHeuristic): string {
  const p: string[] = [];
  if (h.segment_roof_form) p.push(`form=${h.segment_roof_form}`);
  if (h.segment_quality_score_min != null) p.push(`quality=${h.segment_quality_score_min}-${h.segment_quality_score_max ?? 100}`);
  if (h.segment_aspect_ratio_min != null) p.push(`AR=${h.segment_aspect_ratio_min}-${h.segment_aspect_ratio_max ?? "∞"}`);
  return p.length > 0 ? p.join(", ") : "all segments";
}

function applyTuningHeuristics(
  estimate: RoofEstimateResult,
  heuristics: TuningHeuristic[],
  roofForm: string | null,
  qualityScore: number | null,
  aspectRatio: number | null,
): {
  tuned: RoofEstimateResult;
  applied: { key: string; field: string; action: string; before: number; after: number }[];
  preTuningValues: Record<string, number>;
  explanationChain: ExplanationStep[];
  suppressedHeuristics: { key: string; reason: string }[];
  netImpact: Record<string, { original: number; final: number; pctChange: number }>;
  shadowMatches: { key: string; field: string; predictedAction: string; predictedBefore: number; predictedAfter: number; evidence: string }[];
} {
  const applied: { key: string; field: string; action: string; before: number; after: number }[] = [];
  const preTuningValues: Record<string, number> = {};
  const explanationChain: ExplanationStep[] = [];
  const suppressedHeuristics: { key: string; reason: string }[] = [];
  const shadowMatches: { key: string; field: string; predictedAction: string; predictedBefore: number; predictedAfter: number; evidence: string }[] = [];
  const tuned = { ...estimate };
  const originalValues: Record<string, number> = {};

  const fieldMap: Record<string, keyof RoofEstimateResult> = {
    footprint_area: "footprint_area_sqft",
    roof_area: "estimated_roof_area_sqft",
    squares: "squares",
    ridge_lf: "ridge_lf",
    hip_lf: "hip_lf",
    valley_lf: "valley_lf",
    eave_lf: "eave_lf",
    rake_lf: "rake_lf",
    confidence_score: "confidence_score",
  };

  // Area fields for global cap enforcement
  const areaFields = new Set(["footprint_area_sqft", "estimated_roof_area_sqft", "squares"]);
  const confidenceFields = new Set(["confidence_score", "roof_form_confidence"]);

  for (const [, mf] of Object.entries(fieldMap)) {
    originalValues[String(mf)] = Number((estimate as any)[mf] ?? 0);
  }
  if (estimate.roof_form_confidence != null) originalValues["roof_form_confidence"] = estimate.roof_form_confidence;

  // Step 1: Match all (including shadow mode)
  const allMatched = heuristics.filter(h => matchesHeuristic(h, roofForm, qualityScore, aspectRatio));
  
  // Separate shadow from active
  const shadowHeuristics = allMatched.filter(h => h.shadow_mode);
  const activeMatched = allMatched.filter(h => !h.shadow_mode);

  // Process shadow mode heuristics (log predicted impact, don't apply)
  for (const h of shadowHeuristics) {
    const mf = h.adjustment_field ? (fieldMap[h.adjustment_field] || h.adjustment_field) : (h.suppress_field ? (fieldMap[h.suppress_field] || h.suppress_field) : "?");
    const before = Number((estimate as any)[mf] ?? 0);
    let predictedAfter = before;
    let predictedAction = "shadow_match";

    if (h.action_type === "adjust_value" && h.adjustment_factor != null && before !== 0) {
      predictedAfter = roundTo(before * h.adjustment_factor, String(mf) === "squares" ? 1 : 0);
      predictedAction = `would ×${h.adjustment_factor}`;
    } else if (h.action_type === "adjust_confidence" && h.adjustment_factor != null && before !== 0) {
      predictedAfter = roundTo(before * h.adjustment_factor, 0);
      predictedAction = `would ×${h.adjustment_factor}`;
    } else if (h.action_type === "suppress_field") {
      predictedAfter = 0;
      predictedAction = "would suppress";
    }

    shadowMatches.push({
      key: h.heuristic_key,
      field: String(mf),
      predictedAction,
      predictedBefore: before,
      predictedAfter,
      evidence: h.evidence_summary || "",
    });

    explanationChain.push({
      order: explanationChain.length + 1,
      heuristic_key: h.heuristic_key,
      action_type: h.action_type,
      field: String(mf),
      action: `shadow: ${predictedAction}`,
      before,
      after: predictedAfter,
      segment_match: buildSegmentDesc(h),
      evidence_basis: h.evidence_summary || "",
      governance_status: "shadow_mode",
      was_capped: false,
      was_suppressed: true,
      suppression_reason: "Shadow mode — observing only",
    });
  }

  // Step 2: Governance check on active heuristics
  const eligible: TuningHeuristic[] = [];
  for (const h of activeMatched) {
    const { eligible: ok, reason } = isGovernanceEligible(h);
    if (!ok) {
      suppressedHeuristics.push({ key: h.heuristic_key, reason });
      explanationChain.push({ order: explanationChain.length + 1, heuristic_key: h.heuristic_key, action_type: h.action_type, field: h.adjustment_field || h.suppress_field || "?", action: "governance_blocked", before: 0, after: 0, segment_match: buildSegmentDesc(h), evidence_basis: h.evidence_summary || "", governance_status: h.governance_status || "blocked", was_capped: false, was_suppressed: true, suppression_reason: reason });
      continue;
    }
    eligible.push(h);
  }

  // Step 3: Conflicts
  const { winners, suppressed } = resolveConflicts(eligible);
  for (const { heuristic, reason } of suppressed) {
    suppressedHeuristics.push({ key: heuristic.heuristic_key, reason });
    explanationChain.push({ order: explanationChain.length + 1, heuristic_key: heuristic.heuristic_key, action_type: heuristic.action_type, field: heuristic.adjustment_field || heuristic.suppress_field || "?", action: "conflict_suppressed", before: 0, after: 0, segment_match: buildSegmentDesc(heuristic), evidence_basis: heuristic.evidence_summary || "", governance_status: "conflict_suppressed", was_capped: false, was_suppressed: true, suppression_reason: reason });
  }

  // Step 4: Sort & apply with per-heuristic caps AND global estimate caps
  winners.sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
  let stepN = explanationChain.length;

  // Track which fields have already been adjusted (one adjustment per field)
  const adjustedFields = new Set<string>();
  // Track cumulative area and confidence changes for global caps
  let cumulativeAreaPctChange = 0; // tracks net % change across area fields
  let cumulativeConfidenceReduction = 0; // tracks total % reduction

  for (const h of winners) {
    const maxF = h.max_adjustment_factor ?? 1.35;
    const minF = h.min_adjustment_factor ?? 0.65;
    const maxCP = h.max_confidence_penalty ?? 0.40;

    if (h.action_type === "adjust_value" && h.adjustment_field && h.adjustment_factor != null) {
      const mf = fieldMap[h.adjustment_field] || h.adjustment_field;
      const mfStr = String(mf);
      
      // One adjustment per field
      if (ESTIMATE_CAPS.ONE_ADJUSTMENT_PER_FIELD && adjustedFields.has(mfStr)) {
        suppressedHeuristics.push({ key: h.heuristic_key, reason: `One adjustment per field: "${mfStr}" already adjusted` });
        stepN++;
        explanationChain.push({ order: stepN, heuristic_key: h.heuristic_key, action_type: h.action_type, field: mfStr, action: "global_cap_blocked", before: 0, after: 0, segment_match: buildSegmentDesc(h), evidence_basis: h.evidence_summary || "", governance_status: "estimate_cap", was_capped: true, was_suppressed: true, suppression_reason: `Field "${mfStr}" already adjusted by prior heuristic` });
        continue;
      }

      const before = Number((tuned as any)[mf] ?? 0);
      if (before === 0) continue;
      preTuningValues[mfStr] = preTuningValues[mfStr] ?? before;
      let factor = h.adjustment_factor;
      const cappedByHeuristic = factor < minF || factor > maxF;
      factor = Math.max(minF, Math.min(maxF, factor));

      // Check global area cap
      if (areaFields.has(mfStr)) {
        const proposedPctChange = Math.abs((factor - 1) * 100);
        if (cumulativeAreaPctChange + proposedPctChange > ESTIMATE_CAPS.MAX_TOTAL_AREA_ADJUSTMENT_PCT) {
          const remaining = ESTIMATE_CAPS.MAX_TOTAL_AREA_ADJUSTMENT_PCT - cumulativeAreaPctChange;
          if (remaining <= 1) {
            suppressedHeuristics.push({ key: h.heuristic_key, reason: `Global area cap exceeded (${cumulativeAreaPctChange.toFixed(1)}% used of ${ESTIMATE_CAPS.MAX_TOTAL_AREA_ADJUSTMENT_PCT}%)` });
            stepN++;
            explanationChain.push({ order: stepN, heuristic_key: h.heuristic_key, action_type: h.action_type, field: mfStr, action: "global_area_cap", before, after: before, segment_match: buildSegmentDesc(h), evidence_basis: h.evidence_summary || "", governance_status: "estimate_cap", was_capped: true, was_suppressed: true, suppression_reason: `Global area adjustment cap (${ESTIMATE_CAPS.MAX_TOTAL_AREA_ADJUSTMENT_PCT}%) exhausted` });
            continue;
          }
          // Clamp factor to remaining budget
          const maxFactorDelta = remaining / 100;
          factor = factor > 1 ? Math.min(factor, 1 + maxFactorDelta) : Math.max(factor, 1 - maxFactorDelta);
        }
        cumulativeAreaPctChange += Math.abs((factor - 1) * 100);
      }

      const after = roundTo(before * factor, mfStr === "squares" ? 1 : 0);
      (tuned as any)[mf] = after;
      adjustedFields.add(mfStr);
      const wasCapped = cappedByHeuristic || factor !== h.adjustment_factor;
      applied.push({ key: h.heuristic_key, field: mfStr, action: `×${factor}${wasCapped ? " (capped)" : ""}`, before, after });
      stepN++;
      explanationChain.push({ order: stepN, heuristic_key: h.heuristic_key, action_type: h.action_type, field: mfStr, action: `×${factor}`, before, after, segment_match: buildSegmentDesc(h), evidence_basis: h.evidence_summary || "", governance_status: wasCapped ? "capped" : "active", was_capped: wasCapped, was_suppressed: false, suppression_reason: null });
      if (mfStr === "estimated_roof_area_sqft") {
        const oldSq = tuned.squares;
        tuned.squares = roundTo(after / 100, 1);
        if (oldSq !== tuned.squares) {
          preTuningValues["squares"] = preTuningValues["squares"] ?? oldSq;
          applied.push({ key: h.heuristic_key, field: "squares", action: "recalc", before: oldSq, after: tuned.squares });
          adjustedFields.add("squares");
        }
      }
    } else if (h.action_type === "adjust_confidence" && h.adjustment_field && h.adjustment_factor != null) {
      const fieldKey = h.adjustment_field;
      
      // One adjustment per field
      if (ESTIMATE_CAPS.ONE_ADJUSTMENT_PER_FIELD && adjustedFields.has(fieldKey)) {
        suppressedHeuristics.push({ key: h.heuristic_key, reason: `One adjustment per field: "${fieldKey}" already adjusted` });
        continue;
      }

      let factor = Math.max(maxCP, Math.min(1.0, h.adjustment_factor));
      const capped = factor !== h.adjustment_factor;

      // Check global confidence cap
      const proposedReduction = (1 - factor) * 100;
      if (cumulativeConfidenceReduction + proposedReduction > ESTIMATE_CAPS.MAX_TOTAL_CONFIDENCE_REDUCTION_PCT) {
        const remaining = ESTIMATE_CAPS.MAX_TOTAL_CONFIDENCE_REDUCTION_PCT - cumulativeConfidenceReduction;
        if (remaining <= 1) {
          suppressedHeuristics.push({ key: h.heuristic_key, reason: `Global confidence cap exceeded` });
          stepN++;
          explanationChain.push({ order: stepN, heuristic_key: h.heuristic_key, action_type: h.action_type, field: fieldKey, action: "global_confidence_cap", before: 0, after: 0, segment_match: buildSegmentDesc(h), evidence_basis: h.evidence_summary || "", governance_status: "estimate_cap", was_capped: true, was_suppressed: true, suppression_reason: `Global confidence reduction cap (${ESTIMATE_CAPS.MAX_TOTAL_CONFIDENCE_REDUCTION_PCT}%) exhausted` });
          continue;
        }
        factor = Math.max(1 - remaining / 100, factor);
      }
      cumulativeConfidenceReduction += (1 - factor) * 100;

      if (fieldKey === "confidence_score") {
        const before = tuned.confidence_score;
        preTuningValues["confidence_score"] = preTuningValues["confidence_score"] ?? before;
        tuned.confidence_score = roundTo(before * factor, 0);
        adjustedFields.add(fieldKey);
        applied.push({ key: h.heuristic_key, field: "confidence_score", action: `×${factor}${capped ? " (capped)" : ""}`, before, after: tuned.confidence_score });
        stepN++;
        explanationChain.push({ order: stepN, heuristic_key: h.heuristic_key, action_type: h.action_type, field: "confidence_score", action: `×${factor}`, before, after: tuned.confidence_score, segment_match: buildSegmentDesc(h), evidence_basis: h.evidence_summary || "", governance_status: capped ? "capped" : "active", was_capped: capped, was_suppressed: false, suppression_reason: null });
      } else if (fieldKey === "roof_form_confidence" && tuned.roof_form_confidence != null) {
        const before = tuned.roof_form_confidence;
        preTuningValues["roof_form_confidence"] = preTuningValues["roof_form_confidence"] ?? before;
        tuned.roof_form_confidence = roundTo(before * factor, 0);
        adjustedFields.add(fieldKey);
        applied.push({ key: h.heuristic_key, field: "roof_form_confidence", action: `×${factor}${capped ? " (capped)" : ""}`, before, after: tuned.roof_form_confidence });
        stepN++;
        explanationChain.push({ order: stepN, heuristic_key: h.heuristic_key, action_type: h.action_type, field: "roof_form_confidence", action: `×${factor}`, before, after: tuned.roof_form_confidence, segment_match: buildSegmentDesc(h), evidence_basis: h.evidence_summary || "", governance_status: capped ? "capped" : "active", was_capped: capped, was_suppressed: false, suppression_reason: null });
      }
    } else if (h.action_type === "suppress_field" && h.suppress_field && h.suppress_below_confidence != null) {
      const mf = fieldMap[h.suppress_field] || h.suppress_field;
      const mfStr = String(mf);
      
      // One adjustment per field (suppression counts as adjustment)
      if (ESTIMATE_CAPS.ONE_ADJUSTMENT_PER_FIELD && adjustedFields.has(mfStr)) {
        suppressedHeuristics.push({ key: h.heuristic_key, reason: `One adjustment per field: "${mfStr}" already adjusted` });
        continue;
      }

      const fc = (tuned.field_confidence as Record<string, number>)?.[h.suppress_field] ?? 0;
      if (fc < h.suppress_below_confidence) {
        const before = Number((tuned as any)[mf] ?? 0);
        if (before !== 0) {
          preTuningValues[mfStr] = preTuningValues[mfStr] ?? before;
          (tuned as any)[mf] = 0;
          adjustedFields.add(mfStr);
          applied.push({ key: h.heuristic_key, field: mfStr, action: `suppressed (conf ${fc}% < ${h.suppress_below_confidence}%)`, before, after: 0 });
          stepN++;
          explanationChain.push({ order: stepN, heuristic_key: h.heuristic_key, action_type: h.action_type, field: mfStr, action: "suppressed", before, after: 0, segment_match: buildSegmentDesc(h), evidence_basis: h.evidence_summary || "", governance_status: "active", was_capped: false, was_suppressed: false, suppression_reason: null });
        }
      }
    }
  }

  // Net impact
  const netImpact: Record<string, { original: number; final: number; pctChange: number }> = {};
  for (const [key, orig] of Object.entries(originalValues)) {
    const fin = Number((tuned as any)[key] ?? 0);
    if (orig !== fin) netImpact[key] = { original: orig, final: fin, pctChange: orig !== 0 ? Math.round(((fin - orig) / orig) * 1000) / 10 : 0 };
  }

  // Notes
  const parts: string[] = [];
  if (applied.length > 0) {
    parts.push(`🔧 Tuning Applied (${applied.length} heuristic${applied.length > 1 ? "s" : ""}, ${suppressedHeuristics.length} suppressed): ` +
      applied.map(a => `${a.field}: ${a.before} → ${a.after} (${a.action})`).join("; "));
  }
  if (shadowMatches.length > 0) {
    parts.push(`👁 Shadow Mode (${shadowMatches.length} heuristic${shadowMatches.length > 1 ? "s" : ""} observing): ` +
      shadowMatches.map(s => `${s.field}: ${s.predictedAction} (${s.predictedBefore} → ${s.predictedAfter})`).join("; "));
  }
  if (cumulativeAreaPctChange > 0 || cumulativeConfidenceReduction > 0) {
    parts.push(`📊 Estimate Caps: area adjustment ${cumulativeAreaPctChange.toFixed(1)}%/${ESTIMATE_CAPS.MAX_TOTAL_AREA_ADJUSTMENT_PCT}%, confidence reduction ${cumulativeConfidenceReduction.toFixed(1)}%/${ESTIMATE_CAPS.MAX_TOTAL_CONFIDENCE_REDUCTION_PCT}%`);
  }
  if (parts.length > 0) {
    tuned.ai_notes += "\n\n" + parts.join("\n");
  }

  return { tuned, applied, preTuningValues, explanationChain, suppressedHeuristics, netImpact, shadowMatches };
}

// ── Main handler ─────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Missing authorization" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const userClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: userErr } = await userClient.auth.getUser();
    if (userErr || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: roleData } = await supabase
      .from("user_roles").select("role").eq("user_id", user.id).in("role", ["staff", "admin"]);
    if (!roleData || roleData.length === 0) {
      return new Response(JSON.stringify({ error: "Insufficient permissions" }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json();
    const { claim_id, address, selected_candidate_index, force_fresh_candidates, exact_pitch, roof_type } = body;
    const forceFreshCandidates = force_fresh_candidates === true;
    // exact_pitch: e.g. "7/12" — enables precise slope factor calculation
    const parsedExactPitch = typeof exact_pitch === "string" ? exact_pitch.match(/^(\d+)\/12$/) : null;
    const exactPitchRise = parsedExactPitch ? parseInt(parsedExactPitch[1]) : null;
    // roof_type: user-specified roof type for facet decomposition
    const normalizedRoofType = typeof roof_type === "string"
      ? roof_type.trim().toLowerCase().replace(/[-\s]+/g, "_")
      : null;
    const userRoofType = normalizedRoofType && ["gable", "hip", "cross_gable"].includes(normalizedRoofType)
      ? normalizedRoofType
      : null;

    if (!claim_id || !address) {
      return new Response(JSON.stringify({ error: "claim_id and address are required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (typeof address !== "string" || address.trim().length < 5) {
      return new Response(JSON.stringify({ error: "Address must be at least 5 characters" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: claimRecord, error: claimLookupErr } = await supabase
      .from("claims")
      .select("policyholder_address, latitude, longitude")
      .eq("id", claim_id)
      .maybeSingle();

    if (claimLookupErr) {
      console.error("Claim lookup error:", claimLookupErr);
    }

    // ── ADDRESS OVERRIDE DETECTION ────────────────────────────────────────
    // Treat shortened versions of the claim address (e.g. street-only input)
    // as the same property so claim-locked analysis doesn't accidentally flip
    // into external-property geocoding mode.
    const normalizeAddr = (s: string) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "").trim();
    const claimFullAddress = (claimRecord?.policyholder_address ?? "").trim();
    const normalizedInput = normalizeAddr(address);
    const normalizedClaim = normalizeAddr(claimFullAddress);
    const addressesMatch =
      normalizedInput.length > 0 &&
      normalizedClaim.length > 0 &&
      (normalizedInput === normalizedClaim ||
        normalizedClaim.startsWith(normalizedInput) ||
        normalizedInput.startsWith(normalizedClaim));

    const isOverride =
      normalizedInput.length > 0 &&
      normalizedClaim.length > 0 &&
      !addressesMatch;

    // ── TWO EXPLICIT MODES ────────────────────────────────────────────────
    // Mode A: CLAIM_LOCKED — use claim.latitude/longitude ONLY
    // Mode B: EXTERNAL_PROPERTY — use geocoded coordinates from input address ONLY
    let resolvedLat: number;
    let resolvedLng: number;
    let resolvedAddress: string;
    let coordinateSource: string;
    let analysisMode: "CLAIM_LOCKED" | "EXTERNAL_PROPERTY";

    if (isOverride) {
      // EXTERNAL_PROPERTY mode: geocode the input address, ignore claim coords entirely
      analysisMode = "EXTERNAL_PROPERTY";
      const geocoded = await geocodeAddress(address);
      if (!geocoded) {
        return new Response(
          JSON.stringify({ error: "Could not geocode the external address. Please verify and try again." }),
          { status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      resolvedLat = geocoded.lat;
      resolvedLng = geocoded.lng;
      resolvedAddress = geocoded.matchedAddress || address;
      coordinateSource = "geocoded_external";
    } else {
      // CLAIM_LOCKED mode: use claim coordinates, fall back to geocoding claim address
      analysisMode = "CLAIM_LOCKED";
      if (claimRecord?.latitude != null && claimRecord?.longitude != null) {
        const lat = Number(claimRecord.latitude);
        const lng = Number(claimRecord.longitude);
        if (Number.isFinite(lat) && Number.isFinite(lng) && lat !== 0 && lng !== 0) {
          resolvedLat = lat;
          resolvedLng = lng;
          resolvedAddress = claimFullAddress || address;
          coordinateSource = "claim_record";
        } else {
          const geocoded = await geocodeAddress(claimFullAddress || address);
          if (!geocoded) {
            return new Response(
              JSON.stringify({ error: "Could not geocode address. Please verify the address and try again." }),
              { status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" } },
            );
          }
          resolvedLat = geocoded.lat;
          resolvedLng = geocoded.lng;
          resolvedAddress = geocoded.matchedAddress || address;
          coordinateSource = "geocoded_claim";
        }
      } else {
        const geocoded = await geocodeAddress(claimFullAddress || address);
        if (!geocoded) {
          return new Response(
            JSON.stringify({ error: "Could not geocode address. Please verify the address and try again." }),
            { status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
        resolvedLat = geocoded.lat;
        resolvedLng = geocoded.lng;
        resolvedAddress = geocoded.matchedAddress || address;
        coordinateSource = "geocoded_claim";
      }
    }

    // ── DEBUG LOGGING ─────────────────────────────────────────────────────
    console.log(`[Darwin Roof] Mode: ${analysisMode}`);
    console.log(`[Darwin Roof] Coordinates used:`, JSON.stringify({
      resolvedLat,
      resolvedLng,
      claimLat: claimRecord?.latitude ?? null,
      claimLng: claimRecord?.longitude ?? null,
      inputAddress: address,
      claimAddress: claimFullAddress,
      isOverride,
      coordinateSource,
    }));

    // Create a geo object for downstream compatibility (ALL downstream uses resolvedLat/resolvedLng)
    const geo = { lat: resolvedLat, lng: resolvedLng, matchedAddress: resolvedAddress };

    const [parcel, elevation, candidates] = await Promise.all([
      fetchParcelContext(geo.lat, geo.lng),
      getElevation(geo.lat, geo.lng),
      fetchAllCandidateFootprints(geo.lat, geo.lng, supabase),
    ]);

    // Build candidate debug info and scores
    const candidateScores = candidates.map(c => scoreCandidateFootprint(c, geo.lat, geo.lng, null));
    const candidateDebug: any[] = candidates.map((c, i) => ({
      source: c.source,
      source_feature_id: c.source_feature_id,
      geometry_quality_score: c.geometry_quality_score,
      candidate_score_total: candidateScores[i].total,
      candidate_score_breakdown: {
        source_priority: candidateScores[i].source_priority,
        centroid_offset: candidateScores[i].centroid_offset_score,
        area_sanity: candidateScores[i].area_sanity_score,
        vertex_quality: candidateScores[i].vertex_quality_score,
        shape_conflict: candidateScores[i].shape_conflict_score,
      },
      area_sqft: c.area_sqft,
      centroid_offset_ft: c.geometry_metadata?.centroid_offset_ft ?? null,
      vertex_count: c.geometry_metadata?.vertex_count ?? c.polygon.length,
      selected: false,
      rejected_reason: null as string | null,
    }));

    // ── HARD AUTHORITATIVE SOURCE FILTER ──────────────────────────────────
    const AUTHORITATIVE_SOURCE_MATCHERS = [
      "Microsoft Building Footprints",
      "Local DB",
      "NJGIN Building Footprints",
    ];

    const isAuthoritativeCandidate = (source?: string | null) =>
      AUTHORITATIVE_SOURCE_MATCHERS.some((matcher) =>
        (source ?? "").includes(matcher)
      );

    const isAiVisionCandidate = (source?: string | null) =>
      (source ?? "").includes("AI Vision") ||
      (source ?? "").includes("Default Residential");

    // Strict sanity: offset <= 200ft
    const passesStrictSanity = (candidate: CandidateFootprint) => {
      const area = candidate.area_sqft ?? 0;
      const quality = candidate.geometry_quality_score ?? 0;
      const offset = candidate.geometry_metadata?.centroid_offset_ft ?? 999999;
      const vertexCount =
        candidate.geometry_metadata?.vertex_count ??
        (Array.isArray(candidate.polygon) ? candidate.polygon.length : 0);
      return area >= 300 && area <= 15000 && quality >= 35 && offset <= 200 && vertexCount >= 4;
    };

    // Weak sanity: offset <= 1000ft (for authoritative candidates discovered outside strict bounds)
    const passesWeakSanity = (candidate: CandidateFootprint) => {
      const area = candidate.area_sqft ?? 0;
      const quality = candidate.geometry_quality_score ?? 0;
      const offset = candidate.geometry_metadata?.centroid_offset_ft ?? 999999;
      const vertexCount =
        candidate.geometry_metadata?.vertex_count ??
        (Array.isArray(candidate.polygon) ? candidate.polygon.length : 0);
      return area >= 300 && area <= 15000 && quality >= 25 && offset <= 1000 && vertexCount >= 4;
    };

    // Log ALL authoritative candidate distances (even if they fail sanity)
    const allAuthoritativeCandidates = candidates.filter(c => isAuthoritativeCandidate(c.source));
    for (const ac of allAuthoritativeCandidates) {
      const offset = ac.geometry_metadata?.centroid_offset_ft ?? -1;
      const strictPass = passesStrictSanity(ac);
      const weakPass = passesWeakSanity(ac);
      console.log(`[Darwin Roof] Authoritative candidate: source="${ac.source}" area=${ac.area_sqft}sqft offset=${roundTo(offset, 1)}ft quality=${ac.geometry_quality_score} vtx=${ac.geometry_metadata?.vertex_count} strict=${strictPass} weak=${weakPass}`);
    }

    // Find nearest authoritative distance for debug
    const nearestAuthoritativeDistFt = allAuthoritativeCandidates.length > 0
      ? Math.min(...allAuthoritativeCandidates.map(c => c.geometry_metadata?.centroid_offset_ft ?? 999999))
      : null;

    // Strict authoritative candidates
    const authoritativeCandidates = candidates.filter(
      (candidate) => isAuthoritativeCandidate(candidate.source) && passesStrictSanity(candidate)
    );

    // Weak authoritative: within 1000ft but outside strict bounds
    const weakAuthoritativeCandidates = candidates.filter(
      (candidate) => isAuthoritativeCandidate(candidate.source) && !passesStrictSanity(candidate) && passesWeakSanity(candidate)
    );

    if (weakAuthoritativeCandidates.length > 0) {
      console.log(`[Darwin Roof] Found ${weakAuthoritativeCandidates.length} weak_authoritative candidate(s) within 1000ft but outside strict bounds`);
    }

    // Combined: strict + weak authoritative candidates trigger the hard filter
    const allPassingAuthoritative = [...authoritativeCandidates, ...weakAuthoritativeCandidates];

    // HARD RULE:
    // If any authoritative candidate exists (strict or weak), AI Vision and Default fallback
    // must be removed from the candidate set entirely.
    let effectiveCandidates = candidates;
    const aiCandidatesRemovedCount = candidates.filter((c) => isAiVisionCandidate(c.source)).length;

    if (allPassingAuthoritative.length > 0) {
      effectiveCandidates = candidates.filter(
        (candidate) => !isAiVisionCandidate(candidate.source)
      );

      console.log(
        `[Darwin Roof] HARD SOURCE FILTER: removed AI Vision candidates because ${allPassingAuthoritative.length} authoritative candidate(s) exist (${authoritativeCandidates.length} strict, ${weakAuthoritativeCandidates.length} weak)`
      );

      // Mark removed AI Vision candidates in debug
      for (let i = 0; i < candidates.length; i++) {
        if (isAiVisionCandidate(candidates[i].source)) {
          candidateDebug[i].rejected_reason = `hard_filter: removed because ${allPassingAuthoritative.length} authoritative candidate(s) passed sanity`;
        }
      }

      // Mark weak authoritative candidates in debug
      for (let i = 0; i < candidates.length; i++) {
        if (weakAuthoritativeCandidates.includes(candidates[i])) {
          candidateDebug[i].rejected_reason = null; // include them, but note
          (candidateDebug[i] as any).weak_authoritative = true;
        }
      }
    }

    // Sort effective candidates: authoritative sources first, then by distance, then quality
    const sourceRank = (source?: string | null) => {
      const s = source ?? "";
      if (s.includes("Microsoft") || s.includes("Local DB")) return 1;
      if (s.includes("NJGIN")) return 2;
      if (s.includes("Esri")) return 3;
      if (s.includes("OpenStreetMap")) return 4;
      if (s.includes("AI Vision")) return 5;
      return 99;
    };

    effectiveCandidates.sort((a, b) => {
      const rankDelta = sourceRank(a.source) - sourceRank(b.source);
      if (rankDelta !== 0) return rankDelta;

      const aOffset = a.geometry_metadata?.centroid_offset_ft ?? 999999;
      const bOffset = b.geometry_metadata?.centroid_offset_ft ?? 999999;
      if (aOffset !== bOffset) return aOffset - bOffset;

      return (b.geometry_quality_score ?? 0) - (a.geometry_quality_score ?? 0);
    });

    // Select candidate from effective (filtered) set
    let selectedCandidate: CandidateFootprint | null = null;

    if (effectiveCandidates.length > 0) {
      const idx =
        !forceFreshCandidates &&
        typeof selected_candidate_index === "number" &&
        selected_candidate_index >= 0 &&
        selected_candidate_index < effectiveCandidates.length
          ? selected_candidate_index
          : 0;

      selectedCandidate = effectiveCandidates[idx];

      // Mark selected in debug (find original index)
      const originalIdx = candidates.indexOf(selectedCandidate);
      if (originalIdx >= 0 && candidateDebug[originalIdx]) {
        candidateDebug[originalIdx].selected = true;
      }
    }

    const effectiveAiRemoved = aiCandidatesRemovedCount - effectiveCandidates.filter((c) => isAiVisionCandidate(c.source)).length;

    // Build candidate fetch summary
    const candidateFetchSummary = {
      microsoft_count: candidates.filter(c => c.source.includes("Microsoft") || c.source.includes("Local DB")).length,
      njgin_count: candidates.filter(c => c.source.includes("NJGIN")).length,
      esri_count: candidates.filter(c => c.source.includes("Esri")).length,
      osm_count: candidates.filter(c => c.source.includes("OpenStreetMap")).length,
      ai_count: candidates.filter(c => c.source.includes("AI Vision")).length,
      selected_source: selectedCandidate?.source ?? null,
      selected_score: selectedCandidate ? (candidateScores[candidates.indexOf(selectedCandidate)]?.total ?? null) : null,
      guardrail_triggered: false,
      guardrail_reason: null as string | null,
      // Hard filter fields
      raw_candidate_count: candidates.length,
      effective_candidate_count: effectiveCandidates.length,
      authoritative_candidate_count: allPassingAuthoritative.length,
      weak_authoritative_count: weakAuthoritativeCandidates.length,
      ai_candidates_removed: effectiveAiRemoved,
      hard_source_filter_triggered: allPassingAuthoritative.length > 0,
      nearest_authoritative_distance_ft: nearestAuthoritativeDistFt,
      coordinate_source: coordinateSource,
      // Address override / analysis mode
      analysis_mode: analysisMode,
      is_override: isOverride,
    };

    console.log(`[Darwin Roof] Candidate fetch summary: coords=${coordinateSource} MS=${candidateFetchSummary.microsoft_count} NJGIN=${candidateFetchSummary.njgin_count} Esri=${candidateFetchSummary.esri_count} OSM=${candidateFetchSummary.osm_count} AI=${candidateFetchSummary.ai_count} raw=${candidateFetchSummary.raw_candidate_count} effective=${candidateFetchSummary.effective_candidate_count} auth=${candidateFetchSummary.authoritative_candidate_count} weak_auth=${candidateFetchSummary.weak_authoritative_count} nearest_auth_dist=${candidateFetchSummary.nearest_authoritative_distance_ft ?? "n/a"}ft ai_removed=${candidateFetchSummary.ai_candidates_removed} hard_filter=${candidateFetchSummary.hard_source_filter_triggered} → selected="${candidateFetchSummary.selected_source}"`);

    // Phase 2C: Infer roof form from selected footprint
    let roofFormInference: RoofFormInference | null = null;
    if (selectedCandidate) {
      roofFormInference = inferRoofForm(selectedCandidate);
    }

    // Phase 2F: Split-task satellite vision classification
    // Try multiple zoom levels and imagery sources for best coverage
    console.log("[Darwin Roof] Fetching satellite imagery for vision classification...");
    let rawVisionResult: SatelliteVisionResult | null = null;
    let visionResult: SatelliteVisionResult | null = null;
    let visionSuppressions: SuppressionRecord[] = [];

    // Try zoom levels in order: 20 (highest detail), 19, 18
    let usedTileGrid: { base64: string; row: number; col: number; tileX: number; tileY: number }[] | null = null;
    for (const zoom of [20, 19, 18]) {
      const gridSize = zoom >= 20 ? 3 : zoom >= 19 ? 3 : 1;
      const tileGrid = await fetchSatelliteTileGrid(geo.lat, geo.lng, gridSize, zoom);
      if (tileGrid.length > 0) {
        usedTileGrid = tileGrid;
        console.log(`[Darwin Roof] Using zoom ${zoom} with ${tileGrid.length} tiles`);
        break;
      }
    }

    if (usedTileGrid && usedTileGrid.length > 0) {
      console.log(`[Darwin Roof] Classifying roof from ${usedTileGrid.length} tiles (split-task vision)...`);
      rawVisionResult = await classifyRoofFromSatellite(
        usedTileGrid, address, selectedCandidate?.area_sqft ?? null,
      );
      if (rawVisionResult) {
        console.log(`[Darwin Roof] Raw vision: form=${rawVisionResult.roof_form.value}@${rawVisionResult.roof_form.confidence}%, pitch_band=${rawVisionResult.pitch_band.value}@${rawVisionResult.pitch_band.confidence}%, facets=${rawVisionResult.visible_facets.value}, trees=${rawVisionResult.obstructions.tree_cover_pct}%, quality=${rawVisionResult.overall_image_quality}`);

        // If vision reports all tiles are blank/unavailable, try Google satellite tiles
        const imageryUnavailable = rawVisionResult.analysis_notes?.toLowerCase().includes("not yet available") ||
          rawVisionResult.analysis_notes?.toLowerCase().includes("grey") ||
          rawVisionResult.analysis_notes?.toLowerCase().includes("gray") ||
          (rawVisionResult.overall_image_quality <= 20 && rawVisionResult.roof_form.abstain && rawVisionResult.pitch_band.abstain);

        if (imageryUnavailable) {
          console.log("[Darwin Roof] ArcGIS imagery unavailable at this location — trying Google Maps satellite...");
          // Try Google Maps satellite tiles
          const googleTiles = await fetchGoogleSatelliteTiles(geo.lat, geo.lng);
          if (googleTiles.length > 0) {
            const googleVision = await classifyRoofFromSatellite(googleTiles, address, selectedCandidate?.area_sqft ?? null);
            if (googleVision && googleVision.overall_image_quality > rawVisionResult.overall_image_quality) {
              rawVisionResult = googleVision;
              console.log(`[Darwin Roof] Google satellite vision: form=${rawVisionResult.roof_form.value}@${rawVisionResult.roof_form.confidence}%`);
            }
          }
        }

        // Apply suppression rules
        const suppResult = applyVisionSuppressions(
          rawVisionResult,
          selectedCandidate?.geometry_quality_score ?? null,
          roofFormInference?.inferred_roof_form ?? null,
          roofFormInference?.roof_form_confidence ?? null,
        );
        visionResult = suppResult.refined;
        visionSuppressions = suppResult.suppressions;
        if (visionSuppressions.length > 0) {
          console.log(`[Darwin Roof] ${visionSuppressions.length} suppression(s) applied: ${visionSuppressions.map(s => s.rule).join(", ")}`);
        }
        console.log(`[Darwin Roof] Post-suppression vision: form=${visionResult.roof_form.value}@${visionResult.roof_form.confidence}%${visionResult.roof_form.abstain ? "(abstained)" : ""}, pitch_band=${visionResult.pitch_band.value}@${visionResult.pitch_band.confidence}%${visionResult.pitch_band.abstain ? "(abstained)" : ""}`);
      }
    } else {
      console.log("[Darwin Roof] No satellite imagery available at any zoom level");
    }

    // ── FALLBACK: AI Vision Footprint Estimation ──
    // When ALL polygon sources fail (0 candidates), use satellite imagery + AI
    // to estimate building dimensions and create a synthetic rectangular footprint.
    // This ensures we always get measurements (sq ft, eaves, rakes, etc.) even
    // when OSM/NJGIN/Esri have no data for this address.
    if (candidates.length === 0 && !selectedCandidate) {
      // Determine which tile grid to use for estimation
      const estimationTiles = usedTileGrid && usedTileGrid.length > 0
        ? usedTileGrid
        : await (async () => {
            // Try Google tiles if ArcGIS failed
            const gt = await fetchGoogleSatelliteTiles(geo.lat, geo.lng);
            return gt.length > 0 ? gt : null;
          })();

      if (estimationTiles && estimationTiles.length > 0) {
        console.log(`[Darwin Roof] No polygon sources available — attempting AI vision footprint estimation from ${estimationTiles.length} tiles...`);
        try {
          const visionCandidate = await estimateFootprintFromVision(estimationTiles, address, geo.lat, geo.lng);
          if (visionCandidate) {
            selectedCandidate = visionCandidate;
            candidates.push(visionCandidate);
            roofFormInference = inferRoofForm(visionCandidate);
            console.log(`[Darwin Roof] Vision footprint created: ${visionCandidate.area_sqft} sqft, quality=${visionCandidate.geometry_quality_score}`);
          } else {
            console.log("[Darwin Roof] Vision footprint estimation returned no result — will use default fallback");
          }
        } catch (visionErr) {
          console.error("[Darwin Roof] Vision footprint estimation threw error:", visionErr);
        }
      } else {
        console.log("[Darwin Roof] No satellite imagery available for footprint estimation fallback");
      }
    }

    // ── GUARANTEED FALLBACK: Default residential footprint ──
    // If ALL sources failed (GIS + AI vision), create a default rectangular
    // footprint using typical US residential dimensions so that eaves, rakes,
    // ridge, hip, and sqft are NEVER zero when we at least have an address.
    if (candidates.length === 0 && !selectedCandidate) {
      console.log("[Darwin Roof] ALL footprint sources exhausted — creating default residential footprint");
      const defaultLengthFt = 50;
      const defaultWidthFt = 30;
      const defaultBearing = 0; // North-aligned
      const defaultArea = defaultLengthFt * defaultWidthFt; // 1500 sqft

      const halfL = defaultLengthFt / 2;
      const halfW = defaultWidthFt / 2;
      const bearingRad = toRad(defaultBearing);

      const defaultCorners: [number, number][] = [];
      const defaultOffsets = [
        [-halfL, -halfW],
        [halfL, -halfW],
        [halfL, halfW],
        [-halfL, halfW],
      ];
      for (const [along, perp] of defaultOffsets) {
        const dxFt = along * Math.sin(bearingRad) + perp * Math.cos(bearingRad);
        const dyFt = along * Math.cos(bearingRad) - perp * Math.sin(bearingRad);
        const dLat = dyFt / 364000;
        const dLng = dxFt / (364000 * Math.cos(toRad(geo.lat)));
        defaultCorners.push([geo.lng + dLng, geo.lat + dLat]);
      }
      const defaultRing: number[][] = [...defaultCorners, [defaultCorners[0][0], defaultCorners[0][1]]];
      const defaultEdges = classifyEdges(defaultRing);
      const defaultMetadata = buildGeometryMetadata(defaultRing, "Default Residential Fallback", null, geo.lat, geo.lng);

      const defaultCandidate: CandidateFootprint = {
        polygon: defaultRing,
        area_sqft: defaultArea,
        perimeter_ft: roundTo(2 * (defaultLengthFt + defaultWidthFt), 0),
        source: "Default Residential Fallback (no GIS or vision data)",
        source_feature_id: null,
        imagery_date: null,
        geometry_quality_score: 15,
        geometry_metadata: defaultMetadata,
        edge_classifications: defaultEdges,
        geojson: {
          type: "Feature",
          properties: { source: "Default Residential Fallback", length_ft: defaultLengthFt, width_ft: defaultWidthFt },
          geometry: { type: "Polygon", coordinates: [defaultRing] },
        },
      };

      selectedCandidate = defaultCandidate;
      candidates.push(defaultCandidate);
      roofFormInference = inferRoofForm(defaultCandidate);
      console.log(`[Darwin Roof] Default fallback footprint created: ${defaultArea} sqft (${defaultLengthFt}x${defaultWidthFt}ft). Measurements will populate but require manual review.`);
    }

    const isReselection = typeof selected_candidate_index === "number";
    if (selectedCandidate) {
      await supabase.from("audit_logs").insert({
        user_id: user.id,
        action: isReselection ? "update" : "create",
        record_type: "roof_footprint_selection",
        record_id: claim_id,
        new_values: {
          selected_candidate_index: candidates.indexOf(selectedCandidate),
          source: selectedCandidate.source,
          source_feature_id: selectedCandidate.source_feature_id,
          area_sqft: selectedCandidate.area_sqft,
          quality_score: selectedCandidate.geometry_quality_score,
          is_reselection: isReselection,
          total_candidates: candidates.length,
          inferred_roof_form: roofFormInference?.inferred_roof_form ?? null,
          vision_available: !!visionResult,
          vision_pitch_band: visionResult?.pitch_band.value ?? null,
          vision_suppressions: visionSuppressions.length,
        },
        metadata: {
          event: isReselection ? "footprint_candidate_reselected" : "footprint_candidate_selected",
          note: isReselection
            ? "Staff re-selected a different footprint candidate."
            : "Initial footprint candidate auto-selected.",
        },
      }).then(({ error }) => { if (error) console.error("Audit log error:", error); });
    }

    const rawEstimate = deriveRoofEstimate(address, geo.lat, geo.lng, parcel, elevation, selectedCandidate, candidates, roofFormInference, visionResult, visionSuppressions, exactPitchRise, userRoofType);

    // Phase 2D: Apply tuning heuristics
    let estimate = rawEstimate;
    let tuningApplied: any = null;
    let preTuningValues: Record<string, number> = {};

    const { data: activeHeuristics } = await supabase
      .from("darwin_roof_tuning_heuristics")
      .select("id, heuristic_key, action_type, adjustment_field, adjustment_factor, suppress_field, suppress_below_confidence, segment_roof_form, segment_quality_score_min, segment_quality_score_max, segment_aspect_ratio_min, segment_aspect_ratio_max, evidence_summary, min_sample_size, sample_size, effective_from, expires_at, last_validation_support_at, staleness_days, max_adjustment_factor, min_adjustment_factor, max_confidence_penalty, priority, conflict_group, governance_status, shadow_mode, shadow_mode_hits, shadow_mode_min_hits")
      .or("is_active.eq.true,shadow_mode.eq.true");

    let explanationChain: any = null;
    let suppressedHeuristics: any = null;
    let netImpact: any = null;
    let shadowMatches: any = null;

    if (activeHeuristics && activeHeuristics.length > 0) {
      const result = applyTuningHeuristics(
        rawEstimate,
        activeHeuristics as TuningHeuristic[],
        roofFormInference?.inferred_roof_form ?? null,
        selectedCandidate?.geometry_quality_score ?? null,
        roofFormInference?.aspect_ratio ?? null,
      );
      estimate = result.tuned;
      if (result.applied.length > 0) {
        tuningApplied = result.applied;
        preTuningValues = result.preTuningValues;
      }
      if (result.explanationChain.length > 0) explanationChain = result.explanationChain;
      if (result.suppressedHeuristics.length > 0) suppressedHeuristics = result.suppressedHeuristics;
      if (Object.keys(result.netImpact).length > 0) netImpact = result.netImpact;
      if (result.shadowMatches.length > 0) {
        shadowMatches = result.shadowMatches;
        // Increment shadow_mode_hits and store predicted impacts
        for (const sm of result.shadowMatches) {
          const existing = activeHeuristics?.find((h: any) => h.heuristic_key === sm.key);
          const newHits = (existing?.shadow_mode_hits ?? 0) + 1;
          const prevImpacts = (existing as any)?.shadow_mode_predicted_impacts || [];
          const updatedImpacts = [...(Array.isArray(prevImpacts) ? prevImpacts.slice(-19) : []), {
            claim_id,
            field: sm.field,
            predicted_action: sm.predictedAction,
            before: sm.predictedBefore,
            after: sm.predictedAfter,
            at: new Date().toISOString(),
          }];
          await supabase.from("darwin_roof_tuning_heuristics")
            .update({ shadow_mode_hits: newHits, shadow_mode_predicted_impacts: updatedImpacts })
            .eq("heuristic_key", sm.key);
        }
      }
    }

    const { data: saved, error: saveErr } = await supabase
      .from("claim_roof_measurements")
      .insert({
        claim_id,
        address: geo.matchedAddress || address,
        geocoded_lat: geo.lat,
        geocoded_lng: geo.lng,
        footprint_area_sqft: estimate.footprint_area_sqft,
        estimated_roof_area_sqft: estimate.estimated_roof_area_sqft,
        squares: estimate.squares,
        dominant_pitch: estimate.dominant_pitch,
        pitch_band: estimate.pitch_band,
        pitch_type: estimate.pitch_type,
        ridge_lf: estimate.ridge_lf,
        hip_lf: estimate.hip_lf,
        valley_lf: estimate.valley_lf,
        eave_lf: estimate.eave_lf,
        rake_lf: estimate.rake_lf,
        facet_count: estimate.facet_count,
        confidence_score: estimate.confidence_score,
        review_required: true,
        manually_confirmed: false,
        overlay_image_url: null,
        raw_geojson: estimate.raw_geojson,
        ai_notes: estimate.ai_notes,
        data_sources: estimate.data_sources,
        field_sources: estimate.field_sources,
        field_confidence: estimate.field_confidence,
        field_authority: estimate.field_authority,
        footprint_polygon: estimate.footprint_polygon,
        footprint_perimeter_ft: estimate.footprint_perimeter_ft,
        imagery_source: estimate.imagery_source,
        imagery_date: estimate.imagery_date,
        geometry_quality_score: estimate.geometry_quality_score,
        edge_classifications: estimate.edge_classifications,
        geometry_metadata: estimate.geometry_metadata,
        candidate_footprints: estimate.candidate_footprints,
        selected_candidate_index: estimate.selected_candidate_index,
        inferred_roof_form: estimate.inferred_roof_form,
        roof_form_confidence: estimate.roof_form_confidence,
        roof_form_reasoning: estimate.roof_form_reasoning,
        dominant_axis_bearing: estimate.dominant_axis_bearing,
        dominant_axis_length_ft: estimate.dominant_axis_length_ft,
        perpendicular_axis_length_ft: estimate.perpendicular_axis_length_ft,
        aspect_ratio: estimate.aspect_ratio,
        ridge_candidates: estimate.ridge_candidates,
        hip_valley_candidates: estimate.hip_valley_candidates,
        vision_classifications: estimate.vision_classifications,
        suppression_records: estimate.suppression_records,
        roof_mass_decomposition: estimate.roof_mass_decomposition,
        overhang_config: estimate.overhang_config,
        roof_planar_area_sqft: estimate.roof_planar_area_sqft,
        roof_polygon_geojson: estimate.roof_polygon_geojson,
        planar_area_gain_sqft: estimate.planar_area_gain_sqft,
        slope_factor_used: estimate.slope_factor_used,
        correction_factor_used: estimate.correction_factor_used,
        tuning_applied: tuningApplied,
        pre_tuning_values: Object.keys(preTuningValues).length > 0 ? preTuningValues : null,
        roof_shape_conflict: estimate.roof_shape_conflict ?? false,
        roof_shape_conflict_reason: estimate.roof_shape_conflict_reason ?? null,
        provisional_complexity_uplift_used: estimate.provisional_complexity_uplift_used ?? null,
        shape_conflicted_roof_area_sqft: estimate.shape_conflicted_roof_area_sqft ?? null,
        shape_conflicted_squares: estimate.shape_conflicted_squares ?? null,
        suggested_roof_polygon_geojson: estimate.suggested_roof_polygon_geojson ?? null,
        suggested_roof_polygon_source: estimate.suggested_roof_polygon_source ?? null,
        suggested_roof_polygon_confidence: estimate.suggested_roof_polygon_confidence ?? null,
        suggested_roof_outline_notes: estimate.suggested_roof_outline_notes ?? null,
        roof_mass_count: estimate.roof_mass_count ?? null,
        roof_mass_polygons: estimate.roof_mass_polygons ?? null,
        imagery_analysis: estimate.imagery_analysis ?? null,
        calibration_adjustment_factor: estimate.calibration_adjustment_factor ?? null,
        facet_decomposition: estimate.facet_decomposition ?? null,
        created_by: user.id,
      })
      .select()
      .single();

    if (saveErr) {
      console.error("Save error:", saveErr);
      return new Response(JSON.stringify({ error: "Failed to save estimate", detail: saveErr.message }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(
      JSON.stringify({
        success: true,
        measurement: saved,
        geocode: { lat: geo.lat, lng: geo.lng, matchedAddress: geo.matchedAddress },
        parcelContext: parcel,
        elevation,
        footprintExtracted: !!selectedCandidate,
        candidateCount: candidates.length,
        roofFormInferred: !!roofFormInference,
        visionClassified: !!visionResult,
        visionPitchBand: visionResult?.pitch_band.value ?? null,
        visionPitchConfidence: visionResult?.pitch_band.confidence ?? null,
        visionAbstentions: visionResult ? [
          ...(visionResult.roof_form.abstain ? ["roof_form"] : []),
          ...(visionResult.pitch_band.abstain ? ["pitch_band"] : []),
          ...(visionResult.visible_facets.abstain ? ["visible_facets"] : []),
        ] : [],
        suppressionCount: visionSuppressions.length,
        tuningApplied: tuningApplied ? tuningApplied.length : 0,
        shadowModeMatches: shadowMatches ? shadowMatches.length : 0,
        explanationChain,
        suppressedHeuristics,
        netImpact,
        shadowMatches,
        candidate_debug: candidateDebug,
        candidate_fetch_summary: candidateFetchSummary,
        force_fresh_candidates: forceFreshCandidates,
        analysis_mode: analysisMode,
        is_override: isOverride,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error("Roof estimate error:", err);
    return new Response(JSON.stringify({ error: err.message || "Internal error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

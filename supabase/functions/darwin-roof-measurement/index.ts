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
  source: "default" | "user" | "regional";
}

const DEFAULT_OVERHANG: OverhangConfig = {
  eave_overhang_ft: 1.0,
  rake_overhang_ft: 0.75,
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

async function fetchAllCandidateFootprints(
  lat: number,
  lng: number,
): Promise<CandidateFootprint[]> {
  const candidates: CandidateFootprint[] = [];

  const [osmResults, njResult, esriResult] = await Promise.all([
    fetchOSMBuildingCandidates(lat, lng),
    fetchNJBuildingCandidate(lat, lng),
    fetchEsriUSAStructuresCandidate(lat, lng),
  ]);

  candidates.push(...osmResults);
  if (njResult) candidates.push(njResult);
  if (esriResult) candidates.push(esriResult);

  // Deduplicate: if two candidates overlap significantly (>80% area match), keep the higher quality one
  const deduped: CandidateFootprint[] = [];
  for (const c of candidates) {
    const isDuplicate = deduped.some(existing => {
      const areaRatio = Math.min(c.area_sqft, existing.area_sqft) / Math.max(c.area_sqft, existing.area_sqft);
      return areaRatio > 0.8 && existing.geometry_quality_score >= c.geometry_quality_score;
    });
    if (!isDuplicate) deduped.push(c);
  }

  deduped.sort((a, b) => b.geometry_quality_score - a.geometry_quality_score);

  console.log(`[Darwin Roof] Found ${deduped.length} candidate footprints (${osmResults.length} OSM, ${njResult ? 1 : 0} NJGIN, ${esriResult ? 1 : 0} Esri USA Structures)`);

  return deduped;
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
    const url = `https://services2.arcgis.com/XVOqAjTOJ5P6ngMu/arcgis/rest/services/Building_Footprints_of_NJ/FeatureServer/0/query?geometry=${lng},${lat}&geometryType=esriGeometryPoint&spatialRel=esriSpatialRelIntersects&outFields=*&returnGeometry=true&outSR=4326&f=json`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.features?.length) return null;

    const feat = data.features[0];
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
  } catch { return null; }
}

/** Fetch building footprint from Esri USA Structures (AI-extracted, near-universal US coverage). */
async function fetchEsriUSAStructuresCandidate(lat: number, lng: number): Promise<CandidateFootprint | null> {
  try {
    // Esri USA Structures / USA Building Footprints service
    const url = `https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/MSBFP2/FeatureServer/0/query?geometry=${lng},${lat}&geometryType=esriGeometryPoint&spatialRel=esriSpatialRelIntersects&outFields=*&returnGeometry=true&outSR=4326&f=json`;
    const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
    if (!res.ok) {
      // Try alternative endpoint (USA Structures)
      const altUrl = `https://services2.arcgis.com/FiaPA4ga0iQKduv3/arcgis/rest/services/USA_Structures_Footprints/FeatureServer/0/query?geometry=${lng},${lat}&geometryType=esriGeometryPoint&spatialRel=esriSpatialRelIntersects&outFields=*&returnGeometry=true&outSR=4326&f=json`;
      const altRes = await fetch(altUrl, { signal: AbortSignal.timeout(12000) });
      if (!altRes.ok) return null;
      const altData = await altRes.json();
      if (!altData.features?.length) return null;
      return processEsriFeature(altData.features[0], lat, lng, "USA Structures (Esri)");
    }
    const data = await res.json();
    if (!data.features?.length) {
      // Fallback: try buffer query (50m)
      const bufferUrl = `https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/MSBFP2/FeatureServer/0/query?geometry=${lng-0.0005},${lat-0.0005},${lng+0.0005},${lat+0.0005}&geometryType=esriGeometryEnvelope&spatialRel=esriSpatialRelIntersects&outFields=*&returnGeometry=true&outSR=4326&f=json&resultRecordCount=5`;
      const bufRes = await fetch(bufferUrl, { signal: AbortSignal.timeout(10000) });
      if (!bufRes.ok) return null;
      const bufData = await bufRes.json();
      if (!bufData.features?.length) return null;
      // Find nearest to geocode point
      let nearest = bufData.features[0];
      let nearestDist = Infinity;
      for (const feat of bufData.features) {
        if (feat.geometry?.rings?.[0]) {
          const centroid = polygonCentroid(feat.geometry.rings[0]);
          const dist = haversineDistFt([lng, lat], centroid);
          if (dist < nearestDist) { nearestDist = dist; nearest = feat; }
        }
      }
      return processEsriFeature(nearest, lat, lng, "Microsoft Building Footprints (Esri)");
    }
    return processEsriFeature(data.features[0], lat, lng, "Microsoft Building Footprints (Esri)");
  } catch (e) {
    console.log("[Darwin Roof] Esri USA Structures fetch failed:", e);
    return null;
  }
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

  // Estimate valley length at junction (where wing meets main body)
  const junctionLength = Math.min(massBWidth, massAWidth);
  const slopeFactor = 1.118; // moderate default for valley slope-adjustment
  const valleyAtJunction = roundTo(junctionLength * slopeFactor, 0);

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
    facetCount = Math.max(4, 4 + valCount * 2);
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
): RoofEstimateResult {
  const hasGeometry = !!selectedCandidate;
  const footprintArea = selectedCandidate?.area_sqft ?? 0;
  const overhang: OverhangConfig = DEFAULT_OVERHANG;

  // ── Pitch band ──
  let pitchBand: PitchBand = "unknown";
  let pitchType: PitchType = "band";
  let slopeFactor = PITCH_BAND_META.unknown.slope_factor_mid;
  let pitchIsDefaultFallback = false;
  if (visionResult && !visionResult.pitch_band.abstain && visionResult.pitch_band.confidence >= 20) {
    pitchBand = visionResult.pitch_band.value;
    slopeFactor = PITCH_BAND_META[pitchBand].slope_factor_mid;
  } else if (hasGeometry) {
    // Fallback: use moderate pitch when vision is unavailable/abstained
    // This ensures area and linear calculations proceed rather than returning zero
    pitchBand = "moderate";
    slopeFactor = PITCH_BAND_META.moderate.slope_factor_mid;
    pitchIsDefaultFallback = true;
  }

  // ── Area ──
  // Always compute area when geometry exists — pitch fallback ensures non-zero
  let roofArea = 0, squares = 0;
  if (hasGeometry) {
    roofArea = roundTo(footprintArea * slopeFactor, 0);
    squares = roundTo(roofArea / 100, 1);
  }

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
    footprint_area_sqft: hasGeometry ? 75 : 0,
    estimated_roof_area_sqft: hasGeometry ? (pitchIsDefaultFallback ? 35 : 60) : 0,
    squares: hasGeometry ? (pitchIsDefaultFallback ? 35 : 60) : 0,
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

  // ── Notes ──
  const displayPitch = pitchBand !== "unknown" ? bandToDisplayPitch(pitchBand) : "unknown";
  const notes: string[] = [];
  notes.push(`Pitch: ${displayPitch} (${pitchType})${pitchIsDefaultFallback ? " [DEFAULT FALLBACK — no vision pitch available]" : ""}. Roof form: ${resolvedRoofForm}.`);
  notes.push(`📐 Overhang: eave=${overhang.eave_overhang_ft}ft, rake=${overhang.rake_overhang_ft}ft (${overhang.source}).`);
  if (hasGeometry) {
    notes.push(`📐 Footprint: ${footprintArea} sqft from ${selectedCandidate!.source} (quality: ${selectedCandidate!.geometry_quality_score}/100).`);
    if (roofArea > 0) notes.push(`📐 Area: ${footprintArea} × ${slopeFactor} = ${roofArea} sqft.`);
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
  notes.push("\n⚠️ PRELIMINARY. Linear values are geometry-derived with null for unsupported fields. Overhang is configurable. All values require manual confirmation.");

  return {
    footprint_area_sqft: footprintArea,
    estimated_roof_area_sqft: roofArea,
    squares,
    dominant_pitch: displayPitch,
    pitch_band: pitchBand,
    pitch_type: pitchType,
    ridge_lf: linear.ridge_lf,
    hip_lf: linear.hip_lf,
    valley_lf: linear.valley_lf,
    eave_lf: linear.eave_lf,
    rake_lf: linear.rake_lf,
    facet_count: resolvedFacets,
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
    const { claim_id, address, selected_candidate_index } = body;

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

    const geo = await geocodeAddress(address);
    if (!geo) {
      return new Response(
        JSON.stringify({ error: "Could not geocode address. Please verify the address and try again." }),
        { status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const [parcel, elevation, candidates] = await Promise.all([
      fetchParcelContext(geo.lat, geo.lng),
      getElevation(geo.lat, geo.lng),
      fetchAllCandidateFootprints(geo.lat, geo.lng),
    ]);

    // Select candidate
    let selectedCandidate: CandidateFootprint | null = null;
    if (candidates.length > 0) {
      const idx = typeof selected_candidate_index === "number" && selected_candidate_index >= 0 && selected_candidate_index < candidates.length
        ? selected_candidate_index
        : 0;
      selectedCandidate = candidates[idx];
    }

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
    let usedTileGrid: typeof tileGrid | null = null;
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

    // Audit log: candidate selection
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

    const rawEstimate = deriveRoofEstimate(address, geo.lat, geo.lng, parcel, elevation, selectedCandidate, candidates, roofFormInference, visionResult, visionSuppressions);

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
        tuning_applied: tuningApplied,
        pre_tuning_values: Object.keys(preTuningValues).length > 0 ? preTuningValues : null,
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

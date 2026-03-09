import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

type DerivationSource = "geometry" | "ai_estimated";
type FieldAuthority = "geometry_authoritative" | "ai_provisional" | "user_authoritative";
type RoofForm = "gable" | "hip" | "cross_gable" | "complex" | "unknown";

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

interface RoofEstimateResult {
  footprint_area_sqft: number;
  estimated_roof_area_sqft: number;
  squares: number;
  dominant_pitch: string;
  ridge_lf: number;
  hip_lf: number;
  valley_lf: number;
  eave_lf: number;
  rake_lf: number;
  facet_count: number;
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

/** Validate & sanitise numeric estimate fields. */
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
    const v = Number(out[key]);
    out[key] = isNaN(v) ? 0 : roundTo(clamp(v, min, max), decimals);
  }
  if (out.estimated_roof_area_sqft > 0) {
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

  const [osmResults, njResult] = await Promise.all([
    fetchOSMBuildingCandidates(lat, lng),
    fetchNJBuildingCandidate(lat, lng),
  ]);

  candidates.push(...osmResults);
  if (njResult) candidates.push(njResult);

  candidates.sort((a, b) => b.geometry_quality_score - a.geometry_quality_score);

  return candidates;
}

async function fetchOSMBuildingCandidates(lat: number, lng: number): Promise<CandidateFootprint[]> {
  try {
    const radius = 0.0003;
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

// ── AI estimation ────────────────────────────────────────────────────

async function estimateRoofWithAI(
  address: string,
  lat: number,
  lng: number,
  parcel: { parcelArea?: number; landUse?: string; yearBuilt?: number; source: string } | null,
  elevation: number | null,
  selectedCandidate: CandidateFootprint | null,
  allCandidates: CandidateFootprint[],
  roofFormInference: RoofFormInference | null,
): Promise<RoofEstimateResult> {
  const LOVABLE_AI_URL = Deno.env.get("LOVABLE_AI_BASE_URL");
  const LOVABLE_AI_KEY = Deno.env.get("LOVABLE_AI_API_KEY");
  if (!LOVABLE_AI_URL || !LOVABLE_AI_KEY) throw new Error("AI service not configured");

  let geometryEaveLf = 0;
  let geometryRakeLf = 0;
  if (selectedCandidate?.edge_classifications) {
    for (const edge of selectedCandidate.edge_classifications) {
      if (edge.classification === "likely_eave") geometryEaveLf += edge.length_ft;
      else if (edge.classification === "likely_rake") geometryRakeLf += edge.length_ft;
    }
  }

  const footprintContext = selectedCandidate
    ? `\nBuilding Footprint (from ${selectedCandidate.source}, quality: ${selectedCandidate.geometry_quality_score}/100):\n- Footprint area: ${selectedCandidate.area_sqft} sqft (GEOMETRY-DERIVED — use this, do NOT re-estimate)\n- Perimeter: ${selectedCandidate.perimeter_ft} ft (FOOTPRINT-PROXY — not exact roof edge)\n- Edge classification derived eave LF (footprint-proxy): ${roundTo(geometryEaveLf)} ft\n- Edge classification derived rake LF (footprint-proxy): ${roundTo(geometryRakeLf)} ft\n- Imagery date: ${selectedCandidate.imagery_date || "unknown"}\nDo NOT re-estimate footprint_area_sqft — use ${selectedCandidate.area_sqft} exactly.\nEave and rake values are footprint-proxy estimates derived from perimeter segment classification, NOT exact roof-edge measurements. Adjust based on typical overhang and roof style.`
    : "\nNo building footprint geometry available.";

  const roofFormContext = roofFormInference
    ? `\nRoof Form Inference (Phase 2C — from footprint geometry):\n- Inferred form: ${roofFormInference.inferred_roof_form} (confidence: ${roofFormInference.roof_form_confidence}%)\n- Reasoning: ${roofFormInference.roof_form_reasoning}\n- Dominant axis: ${roofFormInference.dominant_axis_bearing}° bearing, ${roofFormInference.dominant_axis_length_ft} ft\n- Perpendicular axis: ${roofFormInference.perpendicular_axis_length_ft} ft\n- Aspect ratio: ${roofFormInference.aspect_ratio}\n- Ridge candidates: ${roofFormInference.ridge_candidates.length} (${roofFormInference.ridge_candidates.map(r => `${r.length_ft}ft @${r.confidence}%`).join(", ") || "none"})\n- Hip/valley candidates: ${roofFormInference.hip_valley_candidates.length}\nUse these geometry-inferred values to inform your estimates. Ridge and hip/valley candidates are conservative and may be incomplete.`
    : "\nNo roof form inference available (no valid footprint geometry).";

  const systemPrompt = `You are a roof ESTIMATE AI for insurance claims adjusting. You produce PRELIMINARY estimates only — not measurements. Be conservative and honest about uncertainty. Return ONLY valid JSON.

JSON schema:
{
  "footprint_area_sqft": number,
  "estimated_roof_area_sqft": number (slope-adjusted),
  "squares": number (roof area / 100, 1 decimal),
  "dominant_pitch": string (e.g. "6/12"),
  "ridge_lf": number (whole),
  "hip_lf": number (whole),
  "valley_lf": number (whole),
  "eave_lf": number (whole),
  "rake_lf": number (whole),
  "facet_count": number,
  "confidence_score": number (0-50, be honest),
  "ai_notes": string (explain methodology, assumptions, limitations),
  "data_sources": string[],
  "field_sources": object mapping each field name to "geometry" or "ai_estimated",
  "field_confidence": object mapping each field name to a 0-100 integer confidence score
}

Rules:
- If a geometry-derived footprint area is provided, use it EXACTLY for footprint_area_sqft and mark field_sources.footprint_area_sqft = "geometry"
- If edge-classified eave/rake values are provided, use them as starting points and adjust for overhang (+1-2ft per side typically). Mark these as "geometry" source but note they are footprint-proxy.
- If roof form inference is provided, use it to guide hip_lf, valley_lf, ridge_lf, and facet_count estimates. For "gable" forms, hip_lf should be 0. For "hip" forms, rake_lf should be minimal.
- Footprint is typically 30-50% of lot area for residential (only if no geometry footprint)
- Standard residential pitches: 4/12-8/12
- Slope factors: 4/12=1.054, 5/12=1.083, 6/12=1.118, 7/12=1.158, 8/12=1.202
- Pre-1970 homes: simpler gable roofs. Newer: more hip/valley
- confidence_score MUST be ≤ 50 (no verified imagery = low confidence)
- field_confidence: give each field its own 0-100 confidence score. Geometry-derived fields get higher scores (60-85). AI guesses get lower scores (10-35). Footprint-proxy derived values (eave, rake from edge classification) get 40-60.
- Clearly state this is a preliminary estimate, not a measurement
- All perimeter-derived values (eave_lf, rake_lf) should be labeled as FOOTPRINT-PROXY in ai_notes`;

  const userPrompt = `Estimate roof for:
Address: ${address}
Coordinates: ${lat}, ${lng}
Elevation: ${elevation ? `${elevation} ft` : "unknown"}
Parcel: ${parcel ? JSON.stringify(parcel) : "unavailable"}${footprintContext}${roofFormContext}

Return JSON only.`;

  const response = await fetch(`${LOVABLE_AI_URL}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${LOVABLE_AI_KEY}` },
    body: JSON.stringify({
      model: "google/gemini-2.5-flash",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.2,
      max_tokens: 2000,
    }),
  });

  if (!response.ok) throw new Error(`AI request failed: ${await response.text()}`);

  const result = await response.json();
  const content = result.choices?.[0]?.message?.content || "";
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("AI returned non-JSON response");

  const parsed = JSON.parse(jsonMatch[0]);

  if (selectedCandidate) {
    parsed.footprint_area_sqft = selectedCandidate.area_sqft;
  }

  const cleaned = sanitise(parsed);

  // Build field_sources
  const hasGeometry = !!selectedCandidate;
  const defaultSources: Record<string, DerivationSource> = {
    footprint_area_sqft: hasGeometry ? "geometry" : "ai_estimated",
    estimated_roof_area_sqft: "ai_estimated",
    squares: "ai_estimated",
    dominant_pitch: "ai_estimated",
    ridge_lf: "ai_estimated",
    hip_lf: "ai_estimated",
    valley_lf: "ai_estimated",
    eave_lf: hasGeometry && geometryEaveLf > 0 ? "geometry" : "ai_estimated",
    rake_lf: hasGeometry && geometryRakeLf > 0 ? "geometry" : "ai_estimated",
    facet_count: "ai_estimated",
  };
  const fieldSources: Record<string, DerivationSource> = {
    ...defaultSources,
    ...(parsed.field_sources || {}),
  };
  if (hasGeometry) fieldSources.footprint_area_sqft = "geometry";
  if (hasGeometry && geometryEaveLf > 0) fieldSources.eave_lf = "geometry";
  if (hasGeometry && geometryRakeLf > 0) fieldSources.rake_lf = "geometry";

  // Build field_confidence
  const defaultConfidence: Record<string, number> = {
    footprint_area_sqft: hasGeometry ? 75 : parcel?.parcelArea ? 55 : 20,
    estimated_roof_area_sqft: hasGeometry ? 40 : 15,
    squares: hasGeometry ? 40 : 15,
    dominant_pitch: 20,
    ridge_lf: roofFormInference?.ridge_candidates?.length ? 30 : 10,
    hip_lf: roofFormInference?.hip_valley_candidates?.length ? 25 : 10,
    valley_lf: roofFormInference?.hip_valley_candidates?.some(c => c.type === "valley") ? 25 : 10,
    eave_lf: hasGeometry && geometryEaveLf > 0 ? 50 : 10,
    rake_lf: hasGeometry && geometryRakeLf > 0 ? 50 : 10,
    facet_count: 15,
  };
  const fieldConfidence: Record<string, number> = { ...defaultConfidence };
  const aiConfidence = parsed.field_confidence || {};
  for (const [k, v] of Object.entries(aiConfidence)) {
    const num = Number(v);
    if (!isNaN(num)) fieldConfidence[k] = Math.max(0, Math.min(100, Math.round(num)));
  }

  // Build field_authority
  const fieldAuthority: Record<string, FieldAuthority> = {
    footprint_area_sqft: hasGeometry ? "geometry_authoritative" : "ai_provisional",
    estimated_roof_area_sqft: "ai_provisional",
    squares: "ai_provisional",
    dominant_pitch: "ai_provisional",
    ridge_lf: "ai_provisional",
    hip_lf: "ai_provisional",
    valley_lf: "ai_provisional",
    eave_lf: "ai_provisional",
    rake_lf: "ai_provisional",
    facet_count: "ai_provisional",
  };

  const proxyNote = hasGeometry
    ? `\n\n📐 Building footprint extracted from ${selectedCandidate!.source} (${selectedCandidate!.area_sqft} sqft, ${selectedCandidate!.perimeter_ft} ft perimeter, quality: ${selectedCandidate!.geometry_quality_score}/100). Footprint area is geometry-derived.` +
      `\n⚠️ Eave and rake values are FOOTPRINT-PROXY measurements derived from perimeter edge classification — they approximate roof edges but are NOT exact roof-edge measurements.` +
      (allCandidates.length > 1 ? `\n📊 ${allCandidates.length} candidate footprints found from multiple sources.` : "")
    : "";

  const roofFormNote = roofFormInference
    ? `\n\n🏠 Roof Form Inference: ${roofFormInference.inferred_roof_form} (confidence: ${roofFormInference.roof_form_confidence}%). ${roofFormInference.roof_form_reasoning}` +
      (roofFormInference.ridge_candidates.length > 0 ? `\n📏 ${roofFormInference.ridge_candidates.length} ridge candidate(s) inferred from geometry.` : "") +
      (roofFormInference.hip_valley_candidates.length > 0 ? `\n📐 ${roofFormInference.hip_valley_candidates.length} hip/valley candidate(s) inferred.` : "")
    : "";

  return {
    footprint_area_sqft: cleaned.footprint_area_sqft,
    estimated_roof_area_sqft: cleaned.estimated_roof_area_sqft,
    squares: cleaned.squares,
    dominant_pitch: parsed.dominant_pitch ?? "unknown",
    ridge_lf: cleaned.ridge_lf,
    hip_lf: cleaned.hip_lf,
    valley_lf: cleaned.valley_lf,
    eave_lf: cleaned.eave_lf,
    rake_lf: cleaned.rake_lf,
    facet_count: cleaned.facet_count,
    confidence_score: cleaned.confidence_score,
    review_required: true,
    overlay_image_url: null,
    raw_geojson: selectedCandidate?.geojson || null,
    ai_notes: (parsed.ai_notes ?? "Preliminary AI estimate. Field verification required.") +
      proxyNote + roofFormNote +
      "\n\n⚠️ This is a PRELIMINARY ESTIMATE, not a measurement. All values are AI-modeled and should not be used without manual confirmation.",
    data_sources: [
      ...(parsed.data_sources ?? ["US Census Geocoder", "AI estimation"]),
      ...(selectedCandidate ? [selectedCandidate.source] : []),
      ...(roofFormInference ? ["Geometry Roof Form Inference"] : []),
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
    selected_candidate_index: selectedCandidate && allCandidates.length > 0
      ? allCandidates.indexOf(selectedCandidate)
      : null,
    // Phase 2C
    inferred_roof_form: roofFormInference?.inferred_roof_form ?? null,
    roof_form_confidence: roofFormInference?.roof_form_confidence ?? null,
    roof_form_reasoning: roofFormInference?.roof_form_reasoning ?? null,
    dominant_axis_bearing: roofFormInference?.dominant_axis_bearing ?? null,
    dominant_axis_length_ft: roofFormInference?.dominant_axis_length_ft ?? null,
    perpendicular_axis_length_ft: roofFormInference?.perpendicular_axis_length_ft ?? null,
    aspect_ratio: roofFormInference?.aspect_ratio ?? null,
    ridge_candidates: roofFormInference?.ridge_candidates ?? null,
    hip_valley_candidates: roofFormInference?.hip_valley_candidates ?? null,
  };
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

    // Audit log: candidate selection (especially re-selection)
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
        },
        metadata: {
          event: isReselection ? "footprint_candidate_reselected" : "footprint_candidate_selected",
          note: isReselection
            ? "Staff re-selected a different footprint candidate. All downstream geometry-derived values have changed."
            : "Initial footprint candidate auto-selected (highest quality score).",
        },
      }).then(({ error }) => {
        if (error) console.error("Audit log error:", error);
      });
    }

    const estimate = await estimateRoofWithAI(address, geo.lat, geo.lng, parcel, elevation, selectedCandidate, candidates, roofFormInference);

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
        // Phase 2C
        inferred_roof_form: estimate.inferred_roof_form,
        roof_form_confidence: estimate.roof_form_confidence,
        roof_form_reasoning: estimate.roof_form_reasoning,
        dominant_axis_bearing: estimate.dominant_axis_bearing,
        dominant_axis_length_ft: estimate.dominant_axis_length_ft,
        perpendicular_axis_length_ft: estimate.perpendicular_axis_length_ft,
        aspect_ratio: estimate.aspect_ratio,
        ridge_candidates: estimate.ridge_candidates,
        hip_valley_candidates: estimate.hip_valley_candidates,
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

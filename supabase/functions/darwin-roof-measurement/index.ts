import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

type DerivationSource = "geometry" | "ai_estimated";
type FieldAuthority = "geometry_authoritative" | "ai_provisional" | "user_authoritative";

interface EdgeClassification {
  segment_index: number;
  start: [number, number]; // [lng, lat]
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

function classifyEdges(ring: number[][]): EdgeClassification[] {
  // Close ring check
  const pts = ring[ring.length - 1][0] === ring[0][0] && ring[ring.length - 1][1] === ring[0][1]
    ? ring.slice(0, -1) : ring;
  if (pts.length < 3) return [];

  // Compute all segment bearings and lengths
  const segments: { start: [number, number]; end: [number, number]; len: number; bearing: number }[] = [];
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    segments.push({
      start: [pts[i][0], pts[i][1]],
      end: [pts[j][0], pts[j][1]],
      len: haversineDistFt(pts[i], pts[j]),
      bearing: bearingDeg(pts[i], pts[j]),
    });
  }

  // Find dominant bearing axis — most buildings align to two perpendicular axes
  // Normalize bearings to 0-180 range (direction-agnostic)
  const normalizedBearings = segments.map(s => s.bearing % 180);

  // Weighted by length: find dominant direction
  const buckets: Record<number, number> = {};
  for (let i = 0; i < segments.length; i++) {
    const b10 = Math.round(normalizedBearings[i] / 10) * 10; // 10-degree buckets
    buckets[b10] = (buckets[b10] || 0) + segments[i].len;
  }
  const sortedBuckets = Object.entries(buckets).sort((a, b) => Number(b[1]) - Number(a[1]));
  const primaryAxis = Number(sortedBuckets[0]?.[0] ?? 0);

  // Classify: segments aligned with the longer dimension are likely eaves,
  // perpendicular segments are likely rakes
  // For a simple gable, eaves run along the longer side
  const totalByAxis: Record<string, number> = { primary: 0, perp: 0, other: 0 };
  const classifications: EdgeClassification[] = [];

  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    const normBearing = normalizedBearings[i];
    const diffFromPrimary = Math.min(
      Math.abs(normBearing - primaryAxis),
      Math.abs(normBearing - primaryAxis + 180),
      Math.abs(normBearing - primaryAxis - 180),
    );
    const diffFromPerp = Math.min(
      Math.abs(normBearing - ((primaryAxis + 90) % 180)),
      Math.abs(normBearing - ((primaryAxis + 90) % 180) + 180),
      Math.abs(normBearing - ((primaryAxis + 90) % 180) - 180),
    );

    let classification: "likely_eave" | "likely_rake" | "unknown";
    let reason: string;

    if (diffFromPrimary <= 15) {
      totalByAxis.primary += s.len;
      classification = "likely_eave";
      reason = `Aligned with primary building axis (${primaryAxis}°±15°). Footprint-proxy — not exact roof edge.`;
    } else if (diffFromPerp <= 15) {
      totalByAxis.perp += s.len;
      classification = "likely_rake";
      reason = `Perpendicular to primary axis. Footprint-proxy — not exact roof edge.`;
    } else {
      totalByAxis.other += s.len;
      classification = "unknown";
      reason = `Bearing ${roundTo(normBearing)}° does not align with primary axes. May be offset, wing, or irregular geometry.`;
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

  // If primary axis total > perp total, primary = eave is correct (longer runs)
  // If perp > primary, swap — the "dominant" bucket might be the gable end
  if (totalByAxis.perp > totalByAxis.primary) {
    for (const c of classifications) {
      if (c.classification === "likely_eave") {
        c.classification = "likely_rake";
        c.classification_reason = c.classification_reason.replace("eave", "rake");
      } else if (c.classification === "likely_rake") {
        c.classification = "likely_eave";
        c.classification_reason = c.classification_reason.replace("rake", "eave");
      }
    }
  }

  return classifications;
}

/** Compute a geometry quality score (0-100) for a footprint polygon */
function computeGeometryQuality(ring: number[][], areaSqft: number, centroidOffsetFt: number): number {
  let score = 100;

  // Vertex count: 4 = perfect rectangle, 3 = triangle (bad), >20 = complex
  const vertexCount = ring[ring.length - 1][0] === ring[0][0] ? ring.length - 1 : ring.length;
  if (vertexCount < 4) score -= 30;
  else if (vertexCount > 20) score -= 10;
  else if (vertexCount >= 4 && vertexCount <= 8) score += 0; // ideal
  else score -= 5;

  // Area sanity: residential 500-10000 sqft = good
  if (areaSqft < 500) score -= 25;
  else if (areaSqft > 10000) score -= 15;
  else if (areaSqft > 5000) score -= 5;

  // Centroid offset from geocode: <30ft = good, >100ft = bad
  if (centroidOffsetFt > 150) score -= 30;
  else if (centroidOffsetFt > 100) score -= 20;
  else if (centroidOffsetFt > 50) score -= 10;

  // Compactness (isoperimetric ratio): 4πA/P² — circle=1, square≈0.785
  const perim = polygonPerimeterFt(ring);
  if (perim > 0) {
    const compactness = (4 * Math.PI * areaSqft) / (perim * perim);
    if (compactness < 0.3) score -= 20; // very irregular
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

  // Sort by quality score descending
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
): Promise<RoofEstimateResult> {
  const LOVABLE_AI_URL = Deno.env.get("LOVABLE_AI_BASE_URL");
  const LOVABLE_AI_KEY = Deno.env.get("LOVABLE_AI_API_KEY");
  if (!LOVABLE_AI_URL || !LOVABLE_AI_KEY) throw new Error("AI service not configured");

  // Derive eave/rake from edge classifications if available
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
Parcel: ${parcel ? JSON.stringify(parcel) : "unavailable"}${footprintContext}

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
    ridge_lf: 10,
    hip_lf: 10,
    valley_lf: 10,
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
      proxyNote +
      "\n\n⚠️ This is a PRELIMINARY ESTIMATE, not a measurement. All values are AI-modeled and should not be used without manual confirmation.",
    data_sources: [
      ...(parsed.data_sources ?? ["US Census Geocoder", "AI estimation"]),
      ...(selectedCandidate ? [selectedCandidate.source] : []),
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

    // Phase 2B: fetch ALL candidate footprints in parallel with parcel/elevation
    const [parcel, elevation, candidates] = await Promise.all([
      fetchParcelContext(geo.lat, geo.lng),
      getElevation(geo.lat, geo.lng),
      fetchAllCandidateFootprints(geo.lat, geo.lng),
    ]);

    // Select candidate: use requested index or pick best quality
    let selectedCandidate: CandidateFootprint | null = null;
    if (candidates.length > 0) {
      const idx = typeof selected_candidate_index === "number" && selected_candidate_index >= 0 && selected_candidate_index < candidates.length
        ? selected_candidate_index
        : 0; // default: highest quality (already sorted)
      selectedCandidate = candidates[idx];
    }

    const estimate = await estimateRoofWithAI(address, geo.lat, geo.lng, parcel, elevation, selectedCandidate, candidates);

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

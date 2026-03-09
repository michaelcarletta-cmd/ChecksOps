import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

type DerivationSource = "geometry" | "ai_estimated";
type FieldAuthority = "geometry_authoritative" | "ai_provisional" | "user_authoritative";

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
}

// ── Helpers ──────────────────────────────────────────────────────────

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
const roundTo = (v: number, decimals = 0) => {
  const f = 10 ** decimals;
  return Math.round(v * f) / f;
};

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

/** Calculate area of polygon in sqft from [lng,lat] ring using Shoelace + geodesic approximation */
function polygonAreaSqft(ring: number[][]): number {
  if (ring.length < 3) return 0;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const R = 20902231; // Earth radius in feet
  let area = 0;
  for (let i = 0; i < ring.length; i++) {
    const j = (i + 1) % ring.length;
    const [lng1, lat1] = ring[i];
    const [lng2, lat2] = ring[j];
    area += toRad(lng2 - lng1) * (2 + Math.sin(toRad(lat1)) + Math.sin(toRad(lat2)));
  }
  area = Math.abs((area * R * R) / 2);
  return roundTo(area, 0);
}

/** Calculate perimeter of polygon in feet from [lng,lat] ring using Haversine */
function polygonPerimeterFt(ring: number[][]): number {
  if (ring.length < 2) return 0;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const R = 20902231;
  let total = 0;
  for (let i = 0; i < ring.length; i++) {
    const j = (i + 1) % ring.length;
    const [lng1, lat1] = ring[i];
    const [lng2, lat2] = ring[j];
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    total += 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }
  return roundTo(total, 0);
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

// ── Phase 2A: Aerial footprint extraction ────────────────────────────

interface FootprintResult {
  polygon: number[][];  // [lng, lat] ring
  areaSqft: number;
  perimeterFt: number;
  source: string;
  imageryDate: string | null;
  geojson: Record<string, unknown>;
}

/**
 * Attempt to extract a building footprint from Microsoft Building Footprints
 * (open dataset) or OpenStreetMap building outlines.
 */
async function extractBuildingFootprint(lat: number, lng: number): Promise<FootprintResult | null> {
  // Strategy 1: Microsoft Building Footprints via Overture/PMTiles proxy
  // Strategy 2: OpenStreetMap Overpass API for building outlines
  const footprint = await fetchOSMBuildingFootprint(lat, lng);
  if (footprint) return footprint;

  // Strategy 3: NJGIN building footprint layer
  const njFootprint = await fetchNJBuildingFootprint(lat, lng);
  if (njFootprint) return njFootprint;

  return null;
}

async function fetchOSMBuildingFootprint(lat: number, lng: number): Promise<FootprintResult | null> {
  try {
    const radius = 0.0003; // ~30m bounding box
    const bbox = `${lat - radius},${lng - radius},${lat + radius},${lng + radius}`;
    const query = `[out:json][timeout:10];way["building"](${bbox});out body geom;`;
    const url = `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
    if (!res.ok) return null;
    const data = await res.json();

    const buildings = data.elements?.filter((e: any) => e.type === "way" && e.geometry?.length > 2);
    if (!buildings || buildings.length === 0) return null;

    // Pick the building closest to the target point
    let best = buildings[0];
    let bestDist = Infinity;
    for (const b of buildings) {
      const centLat = b.geometry.reduce((s: number, g: any) => s + g.lat, 0) / b.geometry.length;
      const centLng = b.geometry.reduce((s: number, g: any) => s + g.lon, 0) / b.geometry.length;
      const d = Math.hypot(centLat - lat, centLng - lng);
      if (d < bestDist) { bestDist = d; best = b; }
    }

    const ring: number[][] = best.geometry.map((g: any) => [g.lon, g.lat]);
    // Close the ring if needed
    if (ring.length > 0 && (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1])) {
      ring.push([...ring[0]]);
    }

    const areaSqft = polygonAreaSqft(ring);
    const perimeterFt = polygonPerimeterFt(ring);

    if (areaSqft < 100 || areaSqft > 50000) return null; // sanity check

    const geojson = {
      type: "Feature",
      properties: { source: "OpenStreetMap", osm_id: best.id },
      geometry: { type: "Polygon", coordinates: [ring] },
    };

    return {
      polygon: ring,
      areaSqft,
      perimeterFt,
      source: "OpenStreetMap Building Footprints",
      imageryDate: null,
      geojson,
    };
  } catch { return null; }
}

async function fetchNJBuildingFootprint(lat: number, lng: number): Promise<FootprintResult | null> {
  try {
    const url = `https://services2.arcgis.com/XVOqAjTOJ5P6ngMu/arcgis/rest/services/Building_Footprints_of_NJ/FeatureServer/0/query?geometry=${lng},${lat}&geometryType=esriGeometryPoint&spatialRel=esriSpatialRelIntersects&outFields=*&returnGeometry=true&outSR=4326&f=json`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.features?.length) return null;

    const feat = data.features[0];
    const rings = feat.geometry?.rings;
    if (!rings || rings.length === 0) return null;

    const ring: number[][] = rings[0]; // outer ring [lng, lat]
    const areaSqft = polygonAreaSqft(ring);
    const perimeterFt = polygonPerimeterFt(ring);

    if (areaSqft < 100 || areaSqft > 50000) return null;

    const geojson = {
      type: "Feature",
      properties: {
        source: "NJGIN Building Footprints",
        ...(feat.attributes || {}),
      },
      geometry: { type: "Polygon", coordinates: [ring] },
    };

    return {
      polygon: ring,
      areaSqft,
      perimeterFt,
      source: "NJGIN Building Footprints",
      imageryDate: feat.attributes?.PHOTO_DATE || feat.attributes?.SOURCE_DATE || null,
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
  footprint: FootprintResult | null,
): Promise<RoofEstimateResult> {
  const LOVABLE_AI_URL = Deno.env.get("LOVABLE_AI_BASE_URL");
  const LOVABLE_AI_KEY = Deno.env.get("LOVABLE_AI_API_KEY");
  if (!LOVABLE_AI_URL || !LOVABLE_AI_KEY) throw new Error("AI service not configured");

  const footprintContext = footprint
    ? `\nBuilding Footprint (from ${footprint.source}):\n- Footprint area: ${footprint.areaSqft} sqft (GEOMETRY-DERIVED — use this, do NOT re-estimate)\n- Perimeter: ${footprint.perimeterFt} ft\n- Imagery date: ${footprint.imageryDate || "unknown"}\nDo NOT re-estimate footprint_area_sqft — use ${footprint.areaSqft} exactly.`
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
- If footprint perimeter is provided, use it to derive eave_lf and rake_lf estimates (perimeter ≈ 2*(eave + rake) for simple gable)
- Footprint is typically 30-50% of lot area for residential (only if no geometry footprint)
- Standard residential pitches: 4/12-8/12
- Slope factors: 4/12=1.054, 5/12=1.083, 6/12=1.118, 7/12=1.158, 8/12=1.202
- Pre-1970 homes: simpler gable roofs. Newer: more hip/valley
- confidence_score MUST be ≤ 50 (no verified imagery = low confidence)
- field_confidence: give each field its own 0-100 confidence score. Geometry-derived fields get higher scores (60-85). AI guesses get lower scores (10-35).
- Clearly state this is a preliminary estimate, not a measurement`;

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

  // If we have geometry footprint, override AI's footprint value
  if (footprint) {
    parsed.footprint_area_sqft = footprint.areaSqft;
  }

  const cleaned = sanitise(parsed);

  // Build field_sources
  const defaultSources: Record<string, DerivationSource> = {
    footprint_area_sqft: footprint ? "geometry" : "ai_estimated",
    estimated_roof_area_sqft: "ai_estimated",
    squares: "ai_estimated",
    dominant_pitch: "ai_estimated",
    ridge_lf: "ai_estimated",
    hip_lf: "ai_estimated",
    valley_lf: "ai_estimated",
    eave_lf: "ai_estimated",
    rake_lf: "ai_estimated",
    facet_count: "ai_estimated",
  };
  const fieldSources: Record<string, DerivationSource> = {
    ...defaultSources,
    ...(parsed.field_sources || {}),
  };
  // Enforce geometry source when footprint polygon exists
  if (footprint) {
    fieldSources.footprint_area_sqft = "geometry";
  } else if (parcel?.parcelArea) {
    fieldSources.footprint_area_sqft = "geometry";
  }

  // Build field_confidence
  const defaultConfidence: Record<string, number> = {
    footprint_area_sqft: footprint ? 75 : parcel?.parcelArea ? 55 : 20,
    estimated_roof_area_sqft: footprint ? 40 : 15,
    squares: footprint ? 40 : 15,
    dominant_pitch: 20,
    ridge_lf: 10,
    hip_lf: 10,
    valley_lf: 10,
    eave_lf: footprint ? 50 : 10,
    rake_lf: footprint ? 50 : 10,
    facet_count: 15,
  };
  const fieldConfidence: Record<string, number> = { ...defaultConfidence };
  const aiConfidence = parsed.field_confidence || {};
  for (const [k, v] of Object.entries(aiConfidence)) {
    const num = Number(v);
    if (!isNaN(num)) fieldConfidence[k] = Math.max(0, Math.min(100, Math.round(num)));
  }

  // Build field_authority — separate from confidence
  const fieldAuthority: Record<string, FieldAuthority> = {
    footprint_area_sqft: footprint ? "geometry_authoritative" : "ai_provisional",
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
    raw_geojson: footprint?.geojson || null,
    ai_notes: (parsed.ai_notes ?? "Preliminary AI estimate. Field verification required.") +
      (footprint
        ? `\n\n📐 Building footprint extracted from ${footprint.source} (${footprint.areaSqft} sqft, ${footprint.perimeterFt} ft perimeter). Footprint area is geometry-derived.`
        : "") +
      "\n\n⚠️ This is a PRELIMINARY ESTIMATE, not a measurement. All values are AI-modeled and should not be used without manual confirmation.",
    data_sources: [
      ...(parsed.data_sources ?? ["US Census Geocoder", "AI estimation"]),
      ...(footprint ? [footprint.source] : []),
    ],
    field_sources: fieldSources,
    field_confidence: fieldConfidence,
    field_authority: fieldAuthority,
    footprint_polygon: footprint ? { type: "Polygon", coordinates: [footprint.polygon] } : null,
    footprint_perimeter_ft: footprint?.perimeterFt ?? null,
    imagery_source: footprint?.source ?? null,
    imagery_date: footprint?.imageryDate ?? null,
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
    const { claim_id, address } = body;

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

    // Phase 2A: attempt footprint extraction in parallel with parcel/elevation
    const [parcel, elevation, footprint] = await Promise.all([
      fetchParcelContext(geo.lat, geo.lng),
      getElevation(geo.lat, geo.lng),
      extractBuildingFootprint(geo.lat, geo.lng),
    ]);

    const estimate = await estimateRoofWithAI(address, geo.lat, geo.lng, parcel, elevation, footprint);

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
        footprintExtracted: !!footprint,
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

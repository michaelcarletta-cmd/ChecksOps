import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

type DerivationSource = "geometry" | "ai_estimated";

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
  // Squares must be consistent with roof area
  if (out.estimated_roof_area_sqft > 0) {
    out.squares = roundTo(out.estimated_roof_area_sqft / 100, 1);
  }
  return out;
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

// ── AI estimation ────────────────────────────────────────────────────

async function estimateRoofWithAI(
  address: string,
  lat: number,
  lng: number,
  parcel: { parcelArea?: number; landUse?: string; yearBuilt?: number; source: string } | null,
  elevation: number | null,
): Promise<RoofEstimateResult> {
  const LOVABLE_AI_URL = Deno.env.get("LOVABLE_AI_BASE_URL");
  const LOVABLE_AI_KEY = Deno.env.get("LOVABLE_AI_API_KEY");
  if (!LOVABLE_AI_URL || !LOVABLE_AI_KEY) throw new Error("AI service not configured");

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
- Footprint is typically 30-50% of lot area for residential
- Standard residential pitches: 4/12-8/12
- Slope factors: 4/12=1.054, 5/12=1.083, 6/12=1.118, 7/12=1.158, 8/12=1.202
- Pre-1970 homes: simpler gable roofs. Newer: more hip/valley
- confidence_score MUST be ≤ 50 (no imagery = low confidence)
- field_confidence: give each field its own 0-100 confidence score. Fields derived from parcel geometry get higher scores (40-70). Pure AI guesses get lower scores (10-35). Be honest per field.
- All linear measurements (ridge, hip, valley, eave, rake) are AI_ESTIMATED
- footprint_area_sqft is "geometry" ONLY if parcel data provides building footprint; otherwise "ai_estimated"
- estimated_roof_area_sqft, squares are always "ai_estimated" (derived from pitch assumption)
- Clearly state this is a preliminary estimate, not a measurement`;

  const userPrompt = `Estimate roof for:
Address: ${address}
Coordinates: ${lat}, ${lng}
Elevation: ${elevation ? `${elevation} ft` : "unknown"}
Parcel: ${parcel ? JSON.stringify(parcel) : "unavailable"}

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
  const cleaned = sanitise(parsed);

  // Build field_sources with defaults
  const defaultSources: Record<string, DerivationSource> = {
    footprint_area_sqft: "ai_estimated",
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
  // Override: if parcel data gave us lot area, footprint may be geometry-based
  if (parcel?.parcelArea) {
    fieldSources.footprint_area_sqft = "geometry";
  }

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
    raw_geojson: null,
    ai_notes: (parsed.ai_notes ?? "Preliminary AI estimate. Field verification required.") +
      "\n\n⚠️ This is a PRELIMINARY ESTIMATE, not a measurement. All values are AI-modeled from public parcel data and should not be used without manual confirmation.",
    data_sources: parsed.data_sources ?? ["US Census Geocoder", "AI estimation"],
    field_sources: fieldSources,
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

    const [parcel, elevation] = await Promise.all([
      fetchParcelContext(geo.lat, geo.lng),
      getElevation(geo.lat, geo.lng),
    ]);

    const estimate = await estimateRoofWithAI(address, geo.lat, geo.lng, parcel, elevation);

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
        raw_geojson: null,
        ai_notes: estimate.ai_notes,
        data_sources: estimate.data_sources,
        field_sources: estimate.field_sources,
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

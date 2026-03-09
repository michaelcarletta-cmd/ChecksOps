import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

interface RoofMeasurement {
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
}

/** Geocode an address using the US Census Bureau geocoder (free, no API key). */
async function geocodeAddress(address: string): Promise<{ lat: number; lng: number; matchedAddress: string } | null> {
  const url = `https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?address=${encodeURIComponent(address)}&benchmark=Public_AR_Current&format=json`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const matches = data?.result?.addressMatches;
    if (!matches || matches.length === 0) return null;
    const m = matches[0];
    return {
      lat: m.coordinates.y,
      lng: m.coordinates.x,
      matchedAddress: m.matchedAddress,
    };
  } catch {
    return null;
  }
}

/** Fetch parcel context from public sources. Returns whatever we can find. */
async function fetchParcelContext(lat: number, lng: number): Promise<{ parcelArea?: number; landUse?: string; yearBuilt?: number; source: string } | null> {
  // Try NJ Parcels (ArcGIS REST) - works for NJ addresses
  try {
    const njUrl = `https://services2.arcgis.com/XVOqAjTOJ5P6ngMu/arcgis/rest/services/Parcels_in_New_Jersey/FeatureServer/0/query?geometry=${lng},${lat}&geometryType=esriGeometryPoint&spatialRel=esriSpatialRelIntersects&outFields=*&returnGeometry=true&f=json`;
    const res = await fetch(njUrl, { signal: AbortSignal.timeout(8000) });
    if (res.ok) {
      const data = await res.json();
      if (data.features?.length > 0) {
        const attrs = data.features[0].attributes;
        return {
          parcelArea: attrs.SHAPE_Area ? Math.round(attrs.SHAPE_Area * 10.764) : undefined, // m² to sqft
          landUse: attrs.PROP_CLASS || attrs.MOD4_DESC || undefined,
          yearBuilt: attrs.YR_BUILT || undefined,
          source: "NJ Parcels ArcGIS",
        };
      }
    }
  } catch { /* continue */ }
  return null;
}

/** Use USGS Elevation Point Query Service. */
async function getElevation(lat: number, lng: number): Promise<number | null> {
  try {
    const url = `https://epqs.nationalmap.gov/v1/json?x=${lng}&y=${lat}&wkid=4326&units=Feet&includeDate=false`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.value ?? null;
  } catch {
    return null;
  }
}

/** Use AI to estimate roof measurements based on available data. */
async function estimateRoofWithAI(
  address: string,
  lat: number,
  lng: number,
  parcel: { parcelArea?: number; landUse?: string; yearBuilt?: number; source: string } | null,
  elevation: number | null,
): Promise<RoofMeasurement> {
  const LOVABLE_AI_URL = Deno.env.get("LOVABLE_AI_BASE_URL");
  const LOVABLE_AI_KEY = Deno.env.get("LOVABLE_AI_API_KEY");

  if (!LOVABLE_AI_URL || !LOVABLE_AI_KEY) {
    throw new Error("AI service not configured");
  }

  const systemPrompt = `You are a roof measurement estimation AI for insurance claims adjusting. Given property data, estimate roof measurements. Be conservative. All estimates must be clearly labeled as AI-estimated. Return ONLY valid JSON matching the schema.

JSON schema:
{
  "footprint_area_sqft": number,
  "estimated_roof_area_sqft": number (slope-adjusted),
  "squares": number (roof area / 100),
  "dominant_pitch": string (e.g. "6/12"),
  "ridge_lf": number,
  "hip_lf": number,
  "valley_lf": number,
  "eave_lf": number,
  "rake_lf": number,
  "facet_count": number,
  "confidence_score": number (0-100, be honest about confidence),
  "ai_notes": string (explain methodology, assumptions, and limitations),
  "data_sources": string[] (list each data source used)
}

Key rules:
- For typical residential NJ homes, footprint is 30-50% of lot area
- Standard residential pitches are 4/12 to 8/12
- Slope factor: multiply footprint by pitch factor (4/12=1.054, 5/12=1.083, 6/12=1.118, 7/12=1.158, 8/12=1.202)
- If year built is known, older homes (pre-1970) tend to be simpler gable roofs, newer homes have more complex hip/valley configurations
- Always set confidence_score LOW (20-45) since this is estimation without imagery
- Always note this is an estimate requiring field verification`;

  const userPrompt = `Estimate roof measurements for:
Address: ${address}
Coordinates: ${lat}, ${lng}
Elevation: ${elevation ? `${elevation} feet` : "unknown"}
Parcel data: ${parcel ? JSON.stringify(parcel) : "No parcel data available"}

Provide your best estimate as JSON.`;

  const response = await fetch(`${LOVABLE_AI_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${LOVABLE_AI_KEY}`,
    },
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

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`AI request failed: ${err}`);
  }

  const result = await response.json();
  const content = result.choices?.[0]?.message?.content || "";

  // Extract JSON from response
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("AI returned non-JSON response");

  const parsed = JSON.parse(jsonMatch[0]);

  return {
    footprint_area_sqft: parsed.footprint_area_sqft ?? 0,
    estimated_roof_area_sqft: parsed.estimated_roof_area_sqft ?? 0,
    squares: parsed.squares ?? 0,
    dominant_pitch: parsed.dominant_pitch ?? "unknown",
    ridge_lf: parsed.ridge_lf ?? 0,
    hip_lf: parsed.hip_lf ?? 0,
    valley_lf: parsed.valley_lf ?? 0,
    eave_lf: parsed.eave_lf ?? 0,
    rake_lf: parsed.rake_lf ?? 0,
    facet_count: parsed.facet_count ?? 0,
    confidence_score: Math.min(parsed.confidence_score ?? 25, 50), // Cap at 50 for AI estimates
    review_required: true,
    overlay_image_url: null,
    raw_geojson: null,
    ai_notes: parsed.ai_notes ?? "AI-estimated measurements. Field verification required.",
    data_sources: parsed.data_sources ?? ["US Census Geocoder", "AI estimation"],
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Missing authorization" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Verify user
    const userClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: userErr } = await userClient.auth.getUser();
    if (userErr || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Check role
    const { data: roleData } = await supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", user.id)
      .in("role", ["staff", "admin"]);

    if (!roleData || roleData.length === 0) {
      return new Response(JSON.stringify({ error: "Insufficient permissions" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json();
    const { claim_id, address } = body;

    if (!claim_id || !address) {
      return new Response(
        JSON.stringify({ error: "claim_id and address are required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Step 1: Geocode
    const geo = await geocodeAddress(address);
    if (!geo) {
      return new Response(
        JSON.stringify({ error: "Could not geocode address. Please verify the address and try again." }),
        { status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Step 2-3: Fetch parcel data and elevation in parallel
    const [parcel, elevation] = await Promise.all([
      fetchParcelContext(geo.lat, geo.lng),
      getElevation(geo.lat, geo.lng),
    ]);

    // Step 4: AI estimation
    const measurement = await estimateRoofWithAI(address, geo.lat, geo.lng, parcel, elevation);

    // Step 5: Store in database
    const { data: saved, error: saveErr } = await supabase
      .from("claim_roof_measurements")
      .insert({
        claim_id,
        address: geo.matchedAddress || address,
        geocoded_lat: geo.lat,
        geocoded_lng: geo.lng,
        footprint_area_sqft: measurement.footprint_area_sqft,
        estimated_roof_area_sqft: measurement.estimated_roof_area_sqft,
        squares: measurement.squares,
        dominant_pitch: measurement.dominant_pitch,
        ridge_lf: measurement.ridge_lf,
        hip_lf: measurement.hip_lf,
        valley_lf: measurement.valley_lf,
        eave_lf: measurement.eave_lf,
        rake_lf: measurement.rake_lf,
        facet_count: measurement.facet_count,
        confidence_score: measurement.confidence_score,
        review_required: true,
        manually_confirmed: false,
        overlay_image_url: measurement.overlay_image_url,
        raw_geojson: measurement.raw_geojson,
        ai_notes: measurement.ai_notes,
        data_sources: measurement.data_sources,
        created_by: user.id,
      })
      .select()
      .single();

    if (saveErr) {
      console.error("Save error:", saveErr);
      return new Response(
        JSON.stringify({ error: "Failed to save measurement", detail: saveErr.message }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
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
    console.error("Roof measurement error:", err);
    return new Response(
      JSON.stringify({ error: err.message || "Internal error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});

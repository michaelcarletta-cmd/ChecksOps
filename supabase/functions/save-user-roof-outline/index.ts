import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

type Point = { x: number; y: number };

function polygonAreaSqFt(points: Point[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

function lngLatRingToLocalXY(ring: [number, number][], originLat: number, originLng: number): Point[] {
  const feetPerDegreeLat = 364000;
  const feetPerDegreeLng = 364000 * Math.cos((originLat * Math.PI) / 180);
  return ring.map(([lng, lat]) => ({
    x: (lng - originLng) * feetPerDegreeLng,
    y: (lat - originLat) * feetPerDegreeLat,
  }));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) throw new Error("Missing authorization");

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    const supabase = createClient(supabaseUrl, serviceKey);
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: { user } } = await userClient.auth.getUser();
    if (!user) throw new Error("Unauthorized");

    const body = await req.json();
    const { roof_measurement_id, polygon_geojson } = body;

    if (!roof_measurement_id || !polygon_geojson?.coordinates?.[0]?.length) {
      throw new Error("roof_measurement_id and polygon_geojson are required");
    }

    const { data: current, error: readErr } = await supabase
      .from("claim_roof_measurements")
      .select("*")
      .eq("id", roof_measurement_id)
      .single();

    if (readErr || !current) throw new Error("Roof measurement not found");

    const ring = polygon_geojson.coordinates[0] as [number, number][];
    const localXY = lngLatRingToLocalXY(ring, current.geocoded_lat, current.geocoded_lng);

    const planar = Math.round(polygonAreaSqFt(localXY));
    const slopeFactor = Number(current.slope_factor_used ?? 1);
    const correctionFactor = Number(current.correction_factor_used ?? 1);
    const roofArea = Math.round(planar * slopeFactor * correctionFactor);
    const squares = Math.round((roofArea / 100) * 10) / 10;

    const priorPolygon = current.user_drawn_roof_polygon_geojson ?? current.roof_polygon_geojson ?? null;
    const priorPlanar = current.user_drawn_planar_area_sqft ?? current.roof_planar_area_sqft ?? null;

    const { error: updateErr } = await supabase
      .from("claim_roof_measurements")
      .update({
        user_drawn_planar_area_sqft: planar,
        user_drawn_roof_area_sqft: roofArea,
        user_drawn_squares: squares,
        user_drawn_roof_polygon_geojson: polygon_geojson,
        user_drawn_at: new Date().toISOString(),
        user_drawn_by: user.id,
        field_authority: {
          ...(current.field_authority || {}),
          footprint_area_sqft: "user_authoritative",
          roof_planar_area_sqft: "user_authoritative",
          estimated_roof_area_sqft: "user_authoritative",
          squares: "user_authoritative",
        },
      })
      .eq("id", roof_measurement_id);

    if (updateErr) throw updateErr;

    await supabase.from("claim_roof_outline_edits").insert({
      roof_measurement_id,
      prior_polygon_geojson: priorPolygon,
      new_polygon_geojson: polygon_geojson,
      prior_planar_area_sqft: priorPlanar,
      new_planar_area_sqft: planar,
      edit_source: "user_drawn_roof_outline",
      created_by: user.id,
    });

    // Audit log
    await supabase.from("audit_logs").insert({
      user_id: user.id,
      action: "update",
      record_type: "roof_user_drawn_outline",
      record_id: roof_measurement_id,
      old_values: { prior_planar_area_sqft: priorPlanar },
      new_values: {
        user_drawn_planar_area_sqft: planar,
        user_drawn_roof_area_sqft: roofArea,
        user_drawn_squares: squares,
      },
      metadata: { event: "user_drawn_roof_outline_saved" },
    });

    return new Response(
      JSON.stringify({
        success: true,
        user_drawn_planar_area_sqft: planar,
        user_drawn_roof_area_sqft: roofArea,
        user_drawn_squares: squares,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "Unknown error" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

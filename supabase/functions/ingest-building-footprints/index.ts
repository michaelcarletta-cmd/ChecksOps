import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

/**
 * Ingest Microsoft Building Footprints for a given state (default: New Jersey).
 *
 * Microsoft publishes their building footprints as GeoJSON files partitioned by state.
 * Source: https://github.com/microsoft/USBuildingFootprints
 *
 * This function:
 * 1. Downloads the state GeoJSON from Microsoft's GitHub release
 * 2. Parses features in streaming batches
 * 3. Inserts into building_footprints with PostGIS geometry
 *
 * Can be called with:
 *   { "state": "NewJersey", "batch_size": 5000, "offset": 0, "limit": 50000 }
 */

// Microsoft Building Footprints download URLs by state
const STATE_URLS: Record<string, string> = {
  NewJersey:
    "https://usbuildingdata.blob.core.windows.net/usbuildings-v2/NewJersey.geojson.zip",
};

// State code mapping
const STATE_CODES: Record<string, string> = {
  NewJersey: "NJ",
};

interface FootprintFeature {
  type: "Feature";
  properties: Record<string, unknown>;
  geometry: {
    type: "Polygon";
    coordinates: number[][][];
  };
}

function computeAreaSqft(ring: number[][]): number {
  if (ring.length < 3) return 0;
  const R_FT = 20902231;
  const toRad = (d: number) => (d * Math.PI) / 180;
  let area = 0;
  for (let i = 0; i < ring.length; i++) {
    const j = (i + 1) % ring.length;
    const [lng1, lat1] = ring[i];
    const [lng2, lat2] = ring[j];
    area += toRad(lng2 - lng1) * (2 + Math.sin(toRad(lat1)) + Math.sin(toRad(lat2)));
  }
  return Math.abs((area * R_FT * R_FT) / 2);
}

function computeCentroid(ring: number[][]): [number, number] {
  const pts =
    ring.length > 0 &&
    ring[ring.length - 1][0] === ring[0][0] &&
    ring[ring.length - 1][1] === ring[0][1]
      ? ring.slice(0, -1)
      : ring;
  const n = pts.length;
  if (n === 0) return [0, 0];
  const lng = pts.reduce((s, p) => s + p[0], 0) / n;
  const lat = pts.reduce((s, p) => s + p[1], 0) / n;
  return [lng, lat];
}

function computeBbox(ring: number[][]): { minLng: number; minLat: number; maxLng: number; maxLat: number } {
  const lngs = ring.map((p) => p[0]);
  const lats = ring.map((p) => p[1]);
  return {
    minLng: Math.min(...lngs),
    minLat: Math.min(...lats),
    maxLng: Math.max(...lngs),
    maxLat: Math.max(...lats),
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

    // Verify user is admin
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

    const { data: roleData } = await supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", user.id)
      .eq("role", "admin");
    if (!roleData || roleData.length === 0) {
      return new Response(JSON.stringify({ error: "Admin access required" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json();
    const state = body.state || "NewJersey";
    const batchSize = Math.min(body.batch_size || 5000, 10000);
    const offset = body.offset || 0;
    const limit = body.limit || 50000;
    const stateCode = STATE_CODES[state] || state.substring(0, 2).toUpperCase();

    // Instead of downloading the massive GeoJSON file directly,
    // use the Esri-hosted Microsoft Building Footprints service for NJ
    // which supports pagination and spatial queries
    const esriUrl = `https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/MSBFP2/FeatureServer/0/query`;

    let totalInserted = 0;
    let currentOffset = offset;
    const errors: string[] = [];

    while (totalInserted < limit) {
      const queryUrl = `${esriUrl}?where=1%3D1&outFields=*&returnGeometry=true&outSR=4326&f=json&resultRecordCount=${batchSize}&resultOffset=${currentOffset}`;

      // For NJ, filter by state bounding box
      const njBbox = "-75.56,38.93,-73.89,41.36";
      const spatialUrl = `${esriUrl}?geometry=${njBbox}&geometryType=esriGeometryEnvelope&spatialRel=esriSpatialRelIntersects&outFields=*&returnGeometry=true&outSR=4326&f=json&resultRecordCount=${batchSize}&resultOffset=${currentOffset}`;

      console.log(`[Ingest] Fetching batch at offset ${currentOffset}, batch_size=${batchSize}...`);

      const res = await fetch(spatialUrl, { signal: AbortSignal.timeout(60000) });
      if (!res.ok) {
        errors.push(`Fetch failed at offset ${currentOffset}: ${res.status}`);
        break;
      }

      const data = await res.json();
      const features = data.features || [];

      if (features.length === 0) {
        console.log(`[Ingest] No more features at offset ${currentOffset}`);
        break;
      }

      // Process features into insert rows
      const rows: any[] = [];
      for (const feat of features) {
        try {
          if (!feat.geometry?.rings?.[0]) continue;
          const ring = feat.geometry.rings[0] as number[][];
          if (ring.length < 4) continue;

          const areaSqft = computeAreaSqft(ring);
          if (areaSqft < 50 || areaSqft > 100000) continue;

          const [cLng, cLat] = computeCentroid(ring);
          const bbox = computeBbox(ring);
          const vertexCount =
            ring[ring.length - 1][0] === ring[0][0] && ring[ring.length - 1][1] === ring[0][1]
              ? ring.length - 1
              : ring.length;

          // Build WKT for PostGIS
          const wktRing = ring.map((p) => `${p[0]} ${p[1]}`).join(", ");
          // Ensure closed
          const closed =
            ring[ring.length - 1][0] === ring[0][0] && ring[ring.length - 1][1] === ring[0][1]
              ? wktRing
              : `${wktRing}, ${ring[0][0]} ${ring[0][1]}`;

          rows.push({
            source: "microsoft",
            source_id: feat.attributes?.OBJECTID
              ? String(feat.attributes.OBJECTID)
              : feat.attributes?.GlobalID || null,
            state: stateCode,
            centroid_lat: Math.round(cLat * 1e7) / 1e7,
            centroid_lng: Math.round(cLng * 1e7) / 1e7,
            bbox: bbox,
            area_sqft: Math.round(areaSqft),
            vertex_count: vertexCount,
            // We'll use raw SQL for geometry insertion
            _wkt: `SRID=4326;POLYGON((${closed}))`,
            _ring: ring,
          });
        } catch (e) {
          errors.push(`Feature parse error: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      // Insert batch using raw SQL for PostGIS geometry
      if (rows.length > 0) {
        // Build VALUES clause with ST_GeomFromText
        const valuesClauses: string[] = [];
        for (const row of rows) {
          const escapedWkt = row._wkt.replace(/'/g, "''");
          valuesClauses.push(
            `(gen_random_uuid(), '${row.source}', ${row.source_id ? `'${row.source_id}'` : "NULL"}, '${row.state}', ST_GeomFromText('${escapedWkt.replace("SRID=4326;", "")}', 4326), ${row.centroid_lat}, ${row.centroid_lng}, '${JSON.stringify(row.bbox)}'::jsonb, ${row.area_sqft}, ${row.vertex_count}, now(), now())`
          );
        }

        const insertSql = `INSERT INTO public.building_footprints (id, source, source_id, state, geometry, centroid_lat, centroid_lng, bbox, area_sqft, vertex_count, created_at, updated_at) VALUES ${valuesClauses.join(", ")} ON CONFLICT DO NOTHING`;

        const { error: insertErr } = await supabase.rpc("exec_sql", { sql: insertSql }).maybeSingle();

        // Fallback: insert individually if batch fails
        if (insertErr) {
          console.log(`[Ingest] Batch insert failed, trying individual inserts: ${insertErr.message}`);
          let individualInserted = 0;
          for (const row of rows) {
            const escapedWkt = row._wkt.replace(/'/g, "''").replace("SRID=4326;", "");
            const singleSql = `INSERT INTO public.building_footprints (source, source_id, state, geometry, centroid_lat, centroid_lng, bbox, area_sqft, vertex_count) VALUES ('${row.source}', ${row.source_id ? `'${row.source_id}'` : "NULL"}, '${row.state}', ST_GeomFromText('${escapedWkt}', 4326), ${row.centroid_lat}, ${row.centroid_lng}, '${JSON.stringify(row.bbox)}'::jsonb, ${row.area_sqft}, ${row.vertex_count})`;
            const { error: singleErr } = await supabase.rpc("exec_sql", { sql: singleSql }).maybeSingle();
            if (!singleErr) individualInserted++;
          }
          totalInserted += individualInserted;
        } else {
          totalInserted += rows.length;
        }
        console.log(`[Ingest] Inserted ${rows.length} footprints (total: ${totalInserted})`);
      }

      currentOffset += features.length;

      // Respect Esri pagination
      if (!data.exceededTransferLimit && features.length < batchSize) {
        break;
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        state,
        state_code: stateCode,
        total_inserted: totalInserted,
        final_offset: currentOffset,
        errors: errors.slice(0, 20),
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("[Ingest] Error:", err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "Internal error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

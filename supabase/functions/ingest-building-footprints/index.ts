import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const STATE_CODES: Record<string, string> = { NewJersey: "NJ" };

// NJ bounding box in Web Mercator (EPSG:3857)
const STATE_BBOX_3857: Record<string, string> = {
  NewJersey: "-8393948,4579616,-8218656,5052338",
};

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
    ring.length > 0 && ring[ring.length - 1][0] === ring[0][0] && ring[ring.length - 1][1] === ring[0][1]
      ? ring.slice(0, -1) : ring;
  const n = pts.length;
  if (n === 0) return [0, 0];
  return [pts.reduce((s, p) => s + p[0], 0) / n, pts.reduce((s, p) => s + p[1], 0) / n];
}

function computeBbox(ring: number[][]) {
  const lngs = ring.map((p) => p[0]);
  const lats = ring.map((p) => p[1]);
  return { minLng: Math.min(...lngs), minLat: Math.min(...lats), maxLng: Math.max(...lngs), maxLat: Math.max(...lats) };
}

// Convert WGS84 to Web Mercator
function toWebMercator(lng: number, lat: number): [number, number] {
  const x = lng * 20037508.34 / 180;
  const y = Math.log(Math.tan((90 + lat) * Math.PI / 360)) / (Math.PI / 180) * 20037508.34 / 180;
  return [x, y];
}

const ESRI_URL = "https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/MSBFP2/FeatureServer/0/query";

async function fetchEsriIds(bbox3857: string): Promise<number[]> {
  const params = new URLSearchParams({
    geometry: bbox3857,
    geometryType: "esriGeometryEnvelope",
    spatialRel: "esriSpatialRelIntersects",
    inSR: "102100",
    returnIdsOnly: "true",
    f: "json",
  });
  const res = await fetch(`${ESRI_URL}?${params.toString()}`, { signal: AbortSignal.timeout(120000) });
  if (!res.ok) { await res.text(); throw new Error(`Esri IDs query failed: ${res.status}`); }
  const data = await res.json();
  if (data.error) throw new Error(`Esri IDs error: ${JSON.stringify(data.error).substring(0, 200)}`);
  return data.objectIds || [];
}

async function fetchEsriFeatures(objectIds: number[]): Promise<any[]> {
  const params = new URLSearchParams({
    objectIds: objectIds.join(","),
    outFields: "OBJECTID,GlobalID",
    returnGeometry: "true",
    outSR: "4326",
    f: "json",
  });
  const res = await fetch(`${ESRI_URL}?${params.toString()}`, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) { await res.text(); throw new Error(`Esri features query failed: ${res.status}`); }
  const data = await res.json();
  if (data.error) throw new Error(`Esri features error: ${JSON.stringify(data.error).substring(0, 200)}`);
  return data.features || [];
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, supabaseKey);

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Missing authorization" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const userClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: userErr } = await userClient.auth.getUser();
    if (userErr || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const { data: roleData } = await supabase.from("user_roles").select("role").eq("user_id", user.id).eq("role", "admin");
    if (!roleData || roleData.length === 0) {
      return new Response(JSON.stringify({ error: "Admin access required" }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json();
    const state = body.state || "NewJersey";
    const stateCode = STATE_CODES[state] || state.substring(0, 2).toUpperCase();
    const testMode = body.test_mode === true;
    const maxFeatures = testMode ? (body.test_limit || 50) : (body.limit || 5000);
    const idBatchSize = body.id_batch_size || 200; // fetch geometry in batches of 200 IDs

    // Custom bbox override for targeted ingestion
    let bbox3857 = STATE_BBOX_3857[state];
    if (body.bbox_wgs84) {
      // Accept [minLng, minLat, maxLng, maxLat] in WGS84
      const [minLng, minLat, maxLng, maxLat] = body.bbox_wgs84;
      const [xmin, ymin] = toWebMercator(minLng, minLat);
      const [xmax, ymax] = toWebMercator(maxLng, maxLat);
      bbox3857 = `${xmin},${ymin},${xmax},${ymax}`;
    }

    if (!bbox3857) {
      return new Response(JSON.stringify({ error: `No bbox for state: ${state}` }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Create ingestion log
    const { data: logRow } = await supabase.from("building_footprint_ingestion_logs").insert({
      state: stateCode,
      source: "microsoft",
      config: { state, testMode, maxFeatures, bbox3857, idBatchSize },
      created_by: user.id,
    }).select("id").single();
    const logId = logRow?.id;

    console.log(`[Ingest] Starting: state=${state}, testMode=${testMode}, maxFeatures=${maxFeatures}`);
    console.log(`[Ingest] Bbox (3857): ${bbox3857}`);

    // Step 1: Get all OBJECTIDs in the bounding box
    console.log(`[Ingest] Step 1: Fetching OBJECTIDs via spatial query...`);
    let allIds: number[];
    try {
      allIds = await fetchEsriIds(bbox3857);
    } catch (e) {
      const msg = `Failed to fetch IDs: ${e instanceof Error ? e.message : String(e)}`;
      console.error(`[Ingest] ${msg}`);
      if (logId) {
        await supabase.from("building_footprint_ingestion_logs").update({
          completed_at: new Date().toISOString(), status: "failed",
          error_count: 1, errors: [msg],
        }).eq("id", logId);
      }
      return new Response(JSON.stringify({ error: msg }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log(`[Ingest] Found ${allIds.length} OBJECTIDs in bbox`);

    // Limit to maxFeatures
    const targetIds = allIds.slice(0, maxFeatures);
    console.log(`[Ingest] Processing ${targetIds.length} of ${allIds.length} IDs`);

    let totalFetched = 0;
    let totalParsed = 0;
    let totalInserted = 0;
    let totalSkipped = 0;
    let totalErrors = 0;
    const errors: string[] = [];

    // Step 2: Fetch geometry in batches by OBJECTID
    for (let i = 0; i < targetIds.length; i += idBatchSize) {
      const batchIds = targetIds.slice(i, i + idBatchSize);
      console.log(`[Ingest] Fetching geometry batch ${Math.floor(i / idBatchSize) + 1}: ${batchIds.length} IDs (offset ${i})`);

      let features: any[];
      try {
        features = await fetchEsriFeatures(batchIds);
      } catch (e) {
        const msg = `Geometry fetch error at batch ${i}: ${e instanceof Error ? e.message : String(e)}`;
        console.error(`[Ingest] ${msg}`);
        errors.push(msg);
        continue;
      }

      totalFetched += features.length;

      // Parse into arrays for batch RPC
      const sources: string[] = [];
      const sourceIds: string[] = [];
      const states: string[] = [];
      const wkts: string[] = [];
      const centroidLats: number[] = [];
      const centroidLngs: number[] = [];
      const bboxes: any[] = [];
      const areasSqft: number[] = [];
      const vertexCounts: number[] = [];

      for (const feat of features) {
        try {
          if (!feat.geometry?.rings?.[0]) { totalSkipped++; continue; }
          const ring = feat.geometry.rings[0] as number[][];
          if (ring.length < 4) { totalSkipped++; continue; }

          const areaSqft = computeAreaSqft(ring);
          if (areaSqft < 50 || areaSqft > 100000) { totalSkipped++; continue; }

          const [cLng, cLat] = computeCentroid(ring);
          const bbox = computeBbox(ring);
          const vertexCount = ring[ring.length - 1][0] === ring[0][0] && ring[ring.length - 1][1] === ring[0][1]
            ? ring.length - 1 : ring.length;

          const wktRing = ring.map((p: number[]) => `${p[0]} ${p[1]}`).join(", ");
          const closed = ring[ring.length - 1][0] === ring[0][0] && ring[ring.length - 1][1] === ring[0][1]
            ? wktRing : `${wktRing}, ${ring[0][0]} ${ring[0][1]}`;

          sources.push("microsoft");
          sourceIds.push(feat.attributes?.OBJECTID ? String(feat.attributes.OBJECTID) : feat.attributes?.GlobalID || "");
          states.push(stateCode);
          wkts.push(`POLYGON((${closed}))`);
          centroidLats.push(Math.round(cLat * 1e7) / 1e7);
          centroidLngs.push(Math.round(cLng * 1e7) / 1e7);
          bboxes.push(bbox);
          areasSqft.push(Math.round(areaSqft));
          vertexCounts.push(vertexCount);
          totalParsed++;
        } catch (e) {
          totalErrors++;
          errors.push(`Parse: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      // Insert via RPC
      if (sources.length > 0) {
        console.log(`[Ingest] Inserting ${sources.length} rows via RPC...`);
        const { data: rpcResult, error: rpcErr } = await supabase.rpc("insert_building_footprints_batch", {
          p_sources: sources,
          p_source_ids: sourceIds,
          p_states: states,
          p_wkts: wkts,
          p_centroid_lats: centroidLats,
          p_centroid_lngs: centroidLngs,
          p_bboxes: bboxes,
          p_areas_sqft: areasSqft,
          p_vertex_counts: vertexCounts,
        });

        if (rpcErr) {
          const msg = `RPC error: ${rpcErr.message}`;
          console.error(`[Ingest] ${msg}`);
          errors.push(msg);
          totalErrors += sources.length;
        } else {
          const r = rpcResult as any;
          console.log(`[Ingest] RPC: inserted=${r.inserted}, skipped=${r.skipped}, errors=${r.errors}`);
          totalInserted += r.inserted || 0;
          totalSkipped += r.skipped || 0;
          totalErrors += r.errors || 0;
          if (r.error_messages?.length > 0) errors.push(...r.error_messages.filter(Boolean));
        }
      }
    }

    // Update log
    if (logId) {
      await supabase.from("building_footprint_ingestion_logs").update({
        completed_at: new Date().toISOString(),
        status: totalInserted > 0 ? "completed" : errors.length > 0 ? "failed" : "empty",
        fetched_count: totalFetched,
        parsed_count: totalParsed,
        inserted_count: totalInserted,
        skipped_count: totalSkipped,
        error_count: totalErrors,
        errors: errors.slice(0, 50),
      }).eq("id", logId);
    }

    const summary = {
      success: true, state, state_code: stateCode, test_mode: testMode,
      total_ids_in_bbox: allIds.length,
      fetched_count: totalFetched, parsed_count: totalParsed,
      inserted_count: totalInserted, skipped_count: totalSkipped,
      error_count: totalErrors, errors: errors.slice(0, 20), log_id: logId,
    };
    console.log(`[Ingest] DONE: ${JSON.stringify(summary)}`);

    return new Response(JSON.stringify(summary), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[Ingest] Fatal:", err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "Internal error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

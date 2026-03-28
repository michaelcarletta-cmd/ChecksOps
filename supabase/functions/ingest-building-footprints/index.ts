import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const STATE_CODES: Record<string, string> = { NewJersey: "NJ" };

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
      ? ring.slice(0, -1)
      : ring;
  const n = pts.length;
  if (n === 0) return [0, 0];
  return [pts.reduce((s, p) => s + p[0], 0) / n, pts.reduce((s, p) => s + p[1], 0) / n];
}

function computeBbox(ring: number[][]) {
  const lngs = ring.map((p) => p[0]);
  const lats = ring.map((p) => p[1]);
  return { minLng: Math.min(...lngs), minLat: Math.min(...lats), maxLng: Math.max(...lngs), maxLat: Math.max(...lats) };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, supabaseKey);

  try {
    // Auth check
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
    const batchSize = Math.min(body.batch_size || 500, 2000);
    const maxFeatures = body.limit || 5000;
    const testMode = body.test_mode === true;
    const testLimit = body.test_limit || 50;
    const effectiveLimit = testMode ? testLimit : maxFeatures;

    // Create ingestion log
    const { data: logRow, error: logErr } = await supabase.from("building_footprint_ingestion_logs").insert({
      state: stateCode,
      source: "microsoft",
      config: { state, batchSize, effectiveLimit, testMode },
      created_by: user.id,
    }).select("id").single();

    const logId = logRow?.id;
    if (logErr) console.error("[Ingest] Failed to create log:", logErr.message);

    // Esri-hosted Microsoft Building Footprints
    const esriUrl = "https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/MSBFP2/FeatureServer/0/query";

    // NJ bounding box
    const njBbox = "-75.56,38.93,-73.89,41.36";

    let totalFetched = 0;
    let totalParsed = 0;
    let totalInserted = 0;
    let totalSkipped = 0;
    let totalErrors = 0;
    const errors: string[] = [];
    let currentOffset = body.offset || 0;

    while (totalInserted < effectiveLimit) {
      const remaining = effectiveLimit - totalInserted;
      const thisBatch = Math.min(batchSize, remaining);

      const queryParams = new URLSearchParams({
        geometry: njBbox,
        geometryType: "esriGeometryEnvelope",
        spatialRel: "esriSpatialRelIntersects",
        outFields: "*",
        returnGeometry: "true",
        outSR: "4326",
        f: "json",
        resultRecordCount: String(thisBatch),
        resultOffset: String(currentOffset),
      });

      const url = `${esriUrl}?${queryParams.toString()}`;
      console.log(`[Ingest] Fetching offset=${currentOffset}, batchSize=${thisBatch}...`);

      let res: Response;
      try {
        res = await fetch(url, { signal: AbortSignal.timeout(60000) });
      } catch (fetchErr) {
        const msg = `Fetch timeout/error at offset ${currentOffset}: ${fetchErr}`;
        console.error(`[Ingest] ${msg}`);
        errors.push(msg);
        break;
      }

      if (!res.ok) {
        const msg = `Esri API returned ${res.status} at offset ${currentOffset}`;
        console.error(`[Ingest] ${msg}`);
        errors.push(msg);
        await res.text(); // consume body
        break;
      }

      const data = await res.json();

      if (data.error) {
        const msg = `Esri API error: ${JSON.stringify(data.error).substring(0, 200)}`;
        console.error(`[Ingest] ${msg}`);
        errors.push(msg);
        break;
      }

      const features = data.features || [];
      totalFetched += features.length;
      console.log(`[Ingest] Fetched ${features.length} features (total fetched: ${totalFetched})`);

      if (features.length === 0) {
        console.log(`[Ingest] No more features at offset ${currentOffset}`);
        break;
      }

      // Parse features into arrays for batch RPC
      const sources: string[] = [];
      const sourceIds: string[] = [];
      const states: string[] = [];
      const wkts: string[] = [];
      const centroidLats: number[] = [];
      const centroidLngs: number[] = [];
      const bboxes: any[] = [];
      const areasSqft: number[] = [];
      const vertexCounts: number[] = [];
      let batchSkipped = 0;

      for (const feat of features) {
        try {
          if (!feat.geometry?.rings?.[0]) {
            batchSkipped++;
            continue;
          }
          const ring = feat.geometry.rings[0] as number[][];
          if (ring.length < 4) {
            batchSkipped++;
            continue;
          }

          const areaSqft = computeAreaSqft(ring);
          if (areaSqft < 50 || areaSqft > 100000) {
            batchSkipped++;
            continue;
          }

          const [cLng, cLat] = computeCentroid(ring);
          const bbox = computeBbox(ring);
          const vertexCount = ring[ring.length - 1][0] === ring[0][0] && ring[ring.length - 1][1] === ring[0][1]
            ? ring.length - 1 : ring.length;

          // Build WKT
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
          const msg = `Parse error: ${e instanceof Error ? e.message : String(e)}`;
          errors.push(msg);
          totalErrors++;
        }
      }

      totalSkipped += batchSkipped;

      // Insert batch via RPC
      if (sources.length > 0) {
        console.log(`[Ingest] Inserting batch of ${sources.length} rows via RPC...`);
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
          const msg = `RPC insert error: ${rpcErr.message}`;
          console.error(`[Ingest] ${msg}`);
          errors.push(msg);
          totalErrors += sources.length;
        } else {
          const result = rpcResult as any;
          console.log(`[Ingest] RPC result: inserted=${result.inserted}, skipped=${result.skipped}, errors=${result.errors}`);
          totalInserted += result.inserted || 0;
          totalSkipped += result.skipped || 0;
          totalErrors += result.errors || 0;
          if (result.error_messages?.length > 0) {
            errors.push(...result.error_messages.filter(Boolean));
          }
        }
      }

      currentOffset += features.length;

      // Check if more pages
      if (!data.exceededTransferLimit && features.length < thisBatch) {
        console.log(`[Ingest] Reached end of data`);
        break;
      }
    }

    // Update ingestion log
    if (logId) {
      await supabase.from("building_footprint_ingestion_logs").update({
        completed_at: new Date().toISOString(),
        status: errors.length > 0 && totalInserted === 0 ? "failed" : totalInserted > 0 ? "completed" : "empty",
        fetched_count: totalFetched,
        parsed_count: totalParsed,
        inserted_count: totalInserted,
        skipped_count: totalSkipped,
        error_count: totalErrors,
        errors: errors.slice(0, 50),
      }).eq("id", logId);
    }

    const summary = {
      success: true,
      state,
      state_code: stateCode,
      test_mode: testMode,
      fetched_count: totalFetched,
      parsed_count: totalParsed,
      inserted_count: totalInserted,
      skipped_count: totalSkipped,
      error_count: totalErrors,
      final_offset: currentOffset,
      errors: errors.slice(0, 20),
      log_id: logId,
    };

    console.log(`[Ingest] DONE: ${JSON.stringify(summary)}`);

    return new Response(JSON.stringify(summary), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[Ingest] Fatal error:", err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "Internal error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

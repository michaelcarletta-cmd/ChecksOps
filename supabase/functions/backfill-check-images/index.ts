import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const BUCKET = "claim-files";

function extFromUrl(url: string, fallback = "jpg") {
  const clean = url.split("?")[0];
  const last = clean.split("/").pop() ?? "";
  const ext = last.includes(".") ? last.split(".").pop() : "";
  return (ext || fallback).toLowerCase();
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const admin = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  );

  const results: Array<Record<string, unknown>> = [];
  let scanned = 0;
  let repaired = 0;
  let failed = 0;

  try {
    const { data: rows, error } = await admin
      .from("check_intake_items")
      .select("id, front_image_path, back_image_path")
      .or("front_image_path.ilike.http%,back_image_path.ilike.http%");

    if (error) throw error;

    for (const row of rows ?? []) {
      scanned++;
      const update: Record<string, string> = {};

      for (const side of ["front", "back"] as const) {
        const col = `${side}_image_path` as const;
        const val = (row as any)[col] as string | null;
        if (!val || !/^https?:\/\//i.test(val)) continue;

        try {
          const resp = await fetch(val);
          if (!resp.ok) {
            failed++;
            results.push({ id: row.id, side, status: "fetch_failed", code: resp.status });
            continue;
          }
          const ext = extFromUrl(val);
          const contentType = resp.headers.get("content-type") ?? `image/${ext === "jpg" ? "jpeg" : ext}`;
          const bytes = new Uint8Array(await resp.arrayBuffer());
          const target = `checks/${row.id}/${side}-backfill-${Date.now()}.${ext}`;
          const { error: upErr } = await admin.storage.from(BUCKET).upload(target, bytes, {
            upsert: true,
            contentType,
            cacheControl: "31536000",
          });
          if (upErr) {
            failed++;
            results.push({ id: row.id, side, status: "upload_failed", error: upErr.message });
            continue;
          }
          update[col] = target;
          repaired++;
          results.push({ id: row.id, side, status: "repaired", path: target });
        } catch (e) {
          failed++;
          results.push({ id: row.id, side, status: "error", error: (e as Error).message });
        }
      }

      if (Object.keys(update).length > 0) {
        await admin.from("check_intake_items").update(update).eq("id", row.id);
      }
    }

    return new Response(
      JSON.stringify({ scanned, repaired, failed, results }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    return new Response(
      JSON.stringify({ error: (e as Error).message, scanned, repaired, failed, results }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});

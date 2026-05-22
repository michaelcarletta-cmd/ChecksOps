// Admin-callable backfill: for every locally-mirrored shared check, ask the source
// app (Freedom CRM) to re-push its current payee/endorsement snapshot. Freedom's
// push-check-payees-to-partners function will then POST back into our
// sync-check-payees endpoint, refreshing stale "pending" rows.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const FREEDOM_PROJECT_REF = "yvagrvfkeuvzjezfsbun";
const FREEDOM_PUSH_URL =
  `https://${FREEDOM_PROJECT_REF}.supabase.co/functions/v1/push-check-payees-to-partners`;
const FREEDOM_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inl2YWdydmZrZXV2emplemZzYnVuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE4NzcyMjUsImV4cCI6MjA4NzQ1MzIyNX0.1Jgm-plSdEFFnPrtA492s0jH-GQcCN08WplZS_VrtEg";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const body = await req.json().catch(() => ({} as any));
    const explicitSourceIds: string[] | undefined = Array.isArray(body?.source_check_ids)
      ? body.source_check_ids.filter((s: any) => typeof s === "string")
      : undefined;
    const onlyId: string | undefined = typeof body?.check_id === "string" ? body.check_id : undefined;

    // Resolve list of source_check_ids to backfill
    let sourceIds: string[] = [];
    if (explicitSourceIds && explicitSourceIds.length > 0) {
      sourceIds = explicitSourceIds;
    } else {
      let q = supabase
        .from("check_intake_items")
        .select("id, external_origin")
        .not("external_origin->>source_check_id", "is", null);
      if (onlyId) q = q.eq("id", onlyId);
      const { data, error } = await q;
      if (error) throw error;
      sourceIds = (data ?? [])
        .map((r: any) => r.external_origin?.source_check_id)
        .filter((s: any) => typeof s === "string");
    }

    const results: Array<{ source_check_id: string; ok: boolean; status?: number; detail?: any }> = [];
    for (const sid of sourceIds) {
      try {
        const resp = await fetch(FREEDOM_PUSH_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${FREEDOM_ANON_KEY}`,
            apikey: FREEDOM_ANON_KEY,
          },
          body: JSON.stringify({ check_id: sid }),
        });
        const text = await resp.text();
        let parsed: any = null;
        try { parsed = JSON.parse(text); } catch { /* keep raw */ }
        results.push({ source_check_id: sid, ok: resp.ok, status: resp.status, detail: parsed ?? text });
      } catch (e: any) {
        results.push({ source_check_id: sid, ok: false, detail: e?.message || String(e) });
      }
    }

    const succeeded = results.filter((r) => r.ok).length;
    return new Response(
      JSON.stringify({ ok: true, total: results.length, succeeded, failed: results.length - succeeded, results }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e: any) {
    console.error("backfill-mirrored-endorsements error", e);
    return new Response(JSON.stringify({ error: e?.message ?? String(e) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const auth = req.headers.get("Authorization") ?? "";
    if (!auth) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: auth } } },
    );

    const body = await req.json().catch(() => ({}));
    const {
      trades = [],
      states = [],
      minRating = 0,
      search = "",
      limit = 24,
      offset = 0,
      sortBy = "rating",
    }: {
      trades?: string[];
      states?: string[];
      minRating?: number;
      search?: string;
      limit?: number;
      offset?: number;
      sortBy?: "rating" | "jobs" | "recent";
    } = body;

    let query = supabase
      .from("contractor_directory_view")
      .select("*", { count: "exact" })
      .eq("is_directory_listed", true)
      .eq("directory_opt_in", true)
      .gte("avg_rating", minRating);

    if (trades.length > 0) query = query.overlaps("trades", trades);
    if (states.length > 0) query = query.overlaps("service_states", states);
    if (search.trim()) {
      const s = search.trim().replace(/[%_]/g, "");
      query = query.or(`display_name.ilike.%${s}%,bio.ilike.%${s}%`);
    }

    if (sortBy === "rating") query = query.order("avg_rating", { ascending: false }).order("review_count", { ascending: false });
    else if (sortBy === "jobs") query = query.order("jobs_count", { ascending: false });
    else query = query.order("created_at", { ascending: false });

    query = query.range(offset, offset + Math.max(1, Math.min(limit, 100)) - 1);

    const { data, error, count } = await query;
    if (error) throw error;

    return new Response(JSON.stringify({ results: data ?? [], total: count ?? 0 }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

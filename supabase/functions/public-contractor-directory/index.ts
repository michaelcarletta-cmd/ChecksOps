// Public homeowner-facing directory. NO auth required.
// Returns sanitized data only: NEVER expose contractor contact info (email/phone).
// Also captures the homeowner lead (email + zip) that gated access.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

// Whitelist of fields safe to return to the public
const PUBLIC_FIELDS = [
  "id",
  "display_name",
  "bio",
  "trades",
  "service_states",
  "tier",
  "avg_rating",
  "review_count",
  "jobs_count",
  "created_at",
] as const;

function sanitize(row: any) {
  const out: Record<string, any> = {};
  for (const k of PUBLIC_FIELDS) out[k] = row?.[k] ?? null;
  // Homeowner-facing "verified" badge = Pro tier + directory opt-in (already filtered)
  out.verified = row?.tier === "pro";
  return out;
}

function isValidEmail(e: string) {
  return typeof e === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 255;
}
function isValidZip(z: string) {
  return typeof z === "string" && /^\d{5}(-\d{4})?$/.test(z);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = await req.json().catch(() => ({}));
    const action: string = body.action ?? "search";
    const email: string = (body.email ?? "").trim().toLowerCase();
    const zip: string = (body.zip ?? "").trim();

    // Gate: require email + zip on every call
    if (!isValidEmail(email) || !isValidZip(zip)) {
      return new Response(
        JSON.stringify({ error: "Valid email and 5-digit US zip are required." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (action === "search") {
      const {
        trades = [],
        states = [],
        minRating = 0,
        search = "",
        limit = 24,
        offset = 0,
        sortBy = "rating",
      } = body;

      let query = admin
        .from("contractor_directory_view")
        .select("*", { count: "exact" })
        .eq("is_directory_listed", true)
        .eq("directory_opt_in", true)
        .eq("tier", "pro") // homeowner-facing = Pro-verified only
        .gte("avg_rating", Number(minRating) || 0);

      if (Array.isArray(trades) && trades.length) query = query.overlaps("trades", trades);
      if (Array.isArray(states) && states.length) query = query.overlaps("service_states", states);
      if (typeof search === "string" && search.trim()) {
        const s = search.trim().replace(/[%_]/g, "").slice(0, 80);
        query = query.or(`display_name.ilike.%${s}%,bio.ilike.%${s}%`);
      }

      if (sortBy === "rating") {
        query = query.order("avg_rating", { ascending: false }).order("review_count", { ascending: false });
      } else if (sortBy === "jobs") {
        query = query.order("jobs_count", { ascending: false });
      } else {
        query = query.order("created_at", { ascending: false });
      }

      const lim = Math.max(1, Math.min(Number(limit) || 24, 60));
      const off = Math.max(0, Number(offset) || 0);
      query = query.range(off, off + lim - 1);

      const { data, error, count } = await query;
      if (error) throw error;

      // Fire-and-forget lead capture (browse)
      admin.from("homeowner_directory_leads").insert({
        email, zip, action: "browse",
        user_agent: req.headers.get("user-agent") ?? null,
        referrer: req.headers.get("referer") ?? null,
      }).then(() => {});

      return new Response(
        JSON.stringify({ results: (data ?? []).map(sanitize), total: count ?? 0 }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (action === "detail") {
      const contractorId: string = body.contractorId;
      if (!contractorId || typeof contractorId !== "string") {
        return new Response(JSON.stringify({ error: "contractorId required" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const { data: profile, error: pErr } = await admin
        .from("contractor_directory_view")
        .select("*")
        .eq("id", contractorId)
        .eq("is_directory_listed", true)
        .eq("directory_opt_in", true)
        .eq("tier", "pro")
        .maybeSingle();
      if (pErr) throw pErr;
      if (!profile) {
        return new Response(JSON.stringify({ error: "Not found" }), {
          status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const { data: reviews } = await admin
        .from("contractor_reviews")
        .select("rating, comment, created_at")
        .eq("contractor_id", contractorId)
        .order("created_at", { ascending: false })
        .limit(50);

      admin.from("homeowner_directory_leads").insert({
        email, zip, contractor_id: contractorId, action: "view_profile",
        user_agent: req.headers.get("user-agent") ?? null,
        referrer: req.headers.get("referer") ?? null,
      }).then(() => {});

      return new Response(
        JSON.stringify({ profile: sanitize(profile), reviews: reviews ?? [] }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    return new Response(JSON.stringify({ error: "Unknown action" }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("public-contractor-directory error", e);
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

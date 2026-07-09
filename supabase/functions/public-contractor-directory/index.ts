// Public homeowner-facing directory. NO auth required.
// Returns sanitized contractor data + distance/local-match signals derived from the homeowner ZIP.
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

const PUBLIC_FIELDS = [
  "id", "display_name", "bio", "trades", "service_states",
  "service_zip_prefixes", "service_radius_miles",
  "tier", "avg_rating", "review_count", "jobs_count", "created_at",
] as const;

function sanitize(row: any) {
  const out: Record<string, any> = {};
  for (const k of PUBLIC_FIELDS) out[k] = row?.[k] ?? null;
  out.verified = row?.tier === "pro";
  if (row?.distance_miles != null) out.distance_miles = Number(row.distance_miles);
  if (row?.zip_prefix_match != null) out.zip_prefix_match = !!row.zip_prefix_match;
  return out;
}

const isValidEmail = (e: string) =>
  typeof e === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 255;
const isValidZip = (z: string) => typeof z === "string" && /^\d{5}(-\d{4})?$/.test(z);

// Geocode a US ZIP via Zippopotam.us (free, no key), cached in zip_geocache.
async function geocodeZip(zip5: string): Promise<{ lat: number; lng: number } | null> {
  const { data: cached } = await admin
    .from("zip_geocache").select("lat,lng").eq("zip", zip5).maybeSingle();
  if (cached) return { lat: Number(cached.lat), lng: Number(cached.lng) };

  try {
    const res = await fetch(`https://api.zippopotam.us/us/${zip5}`);
    if (!res.ok) return null;
    const j = await res.json();
    const place = j?.places?.[0];
    if (!place) return null;
    const lat = Number(place.latitude), lng = Number(place.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    admin.from("zip_geocache").insert({
      zip: zip5, lat, lng,
      city: place["place name"] ?? null,
      state: place["state abbreviation"] ?? null,
    }).then(() => {});
    return { lat, lng };
  } catch {
    return null;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = await req.json().catch(() => ({}));
    const action: string = body.action ?? "search";
    const email: string = (body.email ?? "").trim().toLowerCase();
    const zip: string = (body.zip ?? "").trim();

    if (!isValidEmail(email) || !isValidZip(zip)) {
      return new Response(
        JSON.stringify({ error: "Valid email and 5-digit US zip are required." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    const zip5 = zip.slice(0, 5);

    if (action === "search") {
      const {
        trades = [], states = [], minRating = 0,
        search = "", limit = 24, offset = 0, sortBy = "rating",
      } = body;

      const geo = await geocodeZip(zip5);

      const { data, error } = await admin.rpc("search_public_contractors", {
        p_zip: zip5,
        p_lat: geo?.lat ?? null,
        p_lng: geo?.lng ?? null,
        p_trades: Array.isArray(trades) && trades.length ? trades : null,
        p_states: Array.isArray(states) && states.length ? states : null,
        p_min_rating: Number(minRating) || 0,
        p_search: typeof search === "string" ? search.trim().slice(0, 80) : "",
        p_sort: ["rating", "jobs", "recent"].includes(sortBy) ? sortBy : "rating",
        p_limit: Math.max(1, Math.min(Number(limit) || 24, 60)),
        p_offset: Math.max(0, Number(offset) || 0),
      });
      if (error) throw error;

      admin.from("homeowner_directory_leads").insert({
        email, zip: zip5, action: "browse",
        user_agent: req.headers.get("user-agent") ?? null,
        referrer: req.headers.get("referer") ?? null,
      }).then(() => {});

      const total = (data as any[])?.[0]?.total_count ?? 0;
      return new Response(
        JSON.stringify({
          results: (data ?? []).map(sanitize),
          total: Number(total),
          geocoded: !!geo,
        }),
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
        email, zip: zip5, contractor_id: contractorId, action: "view_profile",
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

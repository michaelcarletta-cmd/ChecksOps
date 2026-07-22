// One-time (repeatable) backfill: for every check_intake_items row that could
// still be deposited (ready_for_deposit, needs_review, endorsing, or already
// deposited but might be re-deposited via reissue), pre-generate the
// "<base>.deposit.jpg" sibling that checkalt-prepare-image looks for.
//
// This does NOT modify checkalt-prepare-image, checkalt-submit-deposit, or
// any other CheckAlt code. It only WRITES files that CheckAlt code already
// reads from cache. If the cached file exists, CheckAlt skips its own
// preparation step — the hot path never re-encodes bytes.
//
// Auth: admin/owner only, per JWT + user_roles lookup.

import { corsHeaders } from "https://esm.sh/@supabase/supabase-js@2/cors";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { Image } from "https://deno.land/x/imagescript@1.3.0/mod.ts";

const BUCKET = "claim-files";

// Match the exact budget checkalt-prepare-image uses so the cache files it
// would produce are byte-compatible with what it already expects.
const TARGET_MAX_DIM = 1200;
const TARGET_JPEG_QUALITY = 68;
const MIN_DIM = 600;
const MIN_QUALITY = 35;
const PER_IMAGE_BYTES_BUDGET = 450_000;

const ELIGIBLE_STAGES = ["ready_for_deposit", "endorsing", "review", "deposited"];

async function normalizeToBudget(bytes: Uint8Array): Promise<Uint8Array> {
  if (bytes.length <= PER_IMAGE_BYTES_BUDGET) return bytes;
  let img = await Image.decode(bytes);
  let quality = TARGET_JPEG_QUALITY;
  const longest = Math.max(img.width, img.height);
  if (longest > TARGET_MAX_DIM) {
    const scale = TARGET_MAX_DIM / longest;
    img = img.resize(Math.round(img.width * scale), Math.round(img.height * scale));
  }
  let out: Uint8Array = await img.encodeJPEG(quality);
  while (out.length > PER_IMAGE_BYTES_BUDGET) {
    if (quality > MIN_QUALITY) {
      quality = Math.max(MIN_QUALITY, quality - 10);
    } else {
      const cur = Math.max(img.width, img.height);
      if (cur <= MIN_DIM) break;
      const next = Math.max(MIN_DIM, Math.round(cur * 0.8));
      const scale = next / cur;
      img = img.resize(Math.round(img.width * scale), Math.round(img.height * scale));
    }
    out = await img.encodeJPEG(quality);
  }
  return out;
}

function preparedPathFor(sourcePath: string): string {
  return `${sourcePath.replace(/\.(jpe?g|png|webp|svg)$/i, "")}.deposit.jpg`;
}

async function processSide(
  supabase: ReturnType<typeof createClient>,
  sourcePath: string | null,
): Promise<"skipped" | "cached" | "written" | "error"> {
  if (!sourcePath) return "skipped";
  // Skip SVG endorsements — checkalt-prepare-image resolves those to the raw
  // raster on demand and we don't want to duplicate that resolution logic.
  if (/\.svg(\?|$)/i.test(sourcePath)) return "skipped";

  const prepared = preparedPathFor(sourcePath);
  try {
    const { data: existing } = await supabase.storage.from(BUCKET).download(prepared);
    if (existing && existing.size > 0 && existing.size <= PER_IMAGE_BYTES_BUDGET) {
      return "cached";
    }
  } catch (_) { /* fall through to (re)generate */ }

  try {
    const { data: src, error: dlErr } = await supabase.storage.from(BUCKET).download(sourcePath);
    if (dlErr || !src) return "error";
    const srcBytes = new Uint8Array(await src.arrayBuffer());
    const out = await normalizeToBudget(srcBytes);
    const { error: upErr } = await supabase.storage.from(BUCKET).upload(
      prepared,
      new Blob([out], { type: "image/jpeg" }),
      { upsert: true, contentType: "image/jpeg" },
    );
    if (upErr) return "error";
    return "written";
  } catch (e) {
    console.warn("[backfill-check-deposit-images] error:", (e as Error).message);
    return "error";
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Admin-token bypass for one-off ops runs from a trusted operator.
    const adminToken = Deno.env.get("BACKFILL_ADMIN_TOKEN");
    const providedToken = req.headers.get("x-backfill-token");
    const tokenOk = !!adminToken && !!providedToken && providedToken === adminToken;

    if (!tokenOk) {
      const authHeader = req.headers.get("Authorization");
      if (!authHeader?.startsWith("Bearer ")) {
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const { data: userRes, error: userErr } = await supabase.auth.getUser(
        authHeader.replace("Bearer ", ""),
      );
      if (userErr || !userRes.user?.id) {
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const { data: roles } = await supabase
        .from("user_roles")
        .select("role")
        .eq("user_id", userRes.user.id);
      const allowed = (roles ?? []).some((r: any) => ["admin", "owner", "staff"].includes(r.role));
      if (!allowed) {
        return new Response(JSON.stringify({ error: "forbidden" }), {
          status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    let body: any = {};
    try { body = await req.json(); } catch (_) { /* optional */ }
    const limit = Math.min(Math.max(Number(body?.limit) || 50, 1), 200);
    const tenantId: string | null = body?.tenant_id ?? null;

    let q = supabase
      .from("check_intake_items")
      .select("id, tenant_id, front_image_path, back_image_path, check_stage")
      .in("check_stage", ELIGIBLE_STAGES)
      .order("updated_at", { ascending: false })
      .range(Number(body?.offset) || 0, (Number(body?.offset) || 0) + limit - 1);
    if (tenantId) q = q.eq("tenant_id", tenantId);

    const { data: checks, error: cErr } = await q;
    if (cErr) throw cErr;

    const results = { total: checks?.length ?? 0, written: 0, cached: 0, skipped: 0, error: 0 };
    for (const c of checks ?? []) {
      const f = await processSide(supabase, (c as any).front_image_path);
      const b = await processSide(supabase, (c as any).back_image_path);
      for (const r of [f, b]) results[r]++;
    }

    return new Response(JSON.stringify({ ok: true, ...results }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

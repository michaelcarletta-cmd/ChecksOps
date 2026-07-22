// Queue-based worker: processes ONE check per invocation from
// public.check_deposit_image_backfill_queue. Designed to stay well under the
// Edge Function CPU budget by only touching a single check per call.
//
// Trigger with:
//   POST /functions/v1/backfill-check-deposit-images-worker
//   header: x-backfill-token: <BACKFILL_ADMIN_TOKEN>
// Response includes `remaining` so the caller can loop until 0.

import { corsHeaders } from "https://esm.sh/@supabase/supabase-js@2/cors";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { Image } from "https://deno.land/x/imagescript@1.3.0/mod.ts";

const BUCKET = "claim-files";
const TARGET_MAX_DIM = 1200;
const TARGET_JPEG_QUALITY = 68;
const MIN_DIM = 600;
const MIN_QUALITY = 35;
const PER_IMAGE_BYTES_BUDGET = 450_000;

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
  if (/\.svg(\?|$)/i.test(sourcePath)) return "skipped";
  const prepared = preparedPathFor(sourcePath);
  try {
    const { data: existing } = await supabase.storage.from(BUCKET).download(prepared);
    if (existing && existing.size > 0 && existing.size <= PER_IMAGE_BYTES_BUDGET) return "cached";
  } catch (_) { /* regenerate */ }
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
    console.warn("[backfill-worker] side error:", (e as Error).message);
    return "error";
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Auth: admin token OR admin user JWT
    const adminToken = Deno.env.get("BACKFILL_ADMIN_TOKEN");
    const provided = req.headers.get("x-backfill-token");
    let ok = !!adminToken && provided === adminToken;
    if (!ok) {
      const authHeader = req.headers.get("Authorization");
      if (!authHeader?.startsWith("Bearer ")) return json({ error: "unauthorized" }, 401);
      const { data: userRes } = await supabase.auth.getUser(authHeader.replace("Bearer ", ""));
      if (!userRes.user?.id) return json({ error: "unauthorized" }, 401);
      const { data: roles } = await supabase
        .from("user_roles").select("role").eq("user_id", userRes.user.id);
      ok = (roles ?? []).some((r: any) => ["admin", "staff"].includes(r.role));
      if (!ok) return json({ error: "forbidden" }, 403);
    }

    // Claim ONE pending row
    const { data: row, error: claimErr } = await supabase
      .from("check_deposit_image_backfill_queue")
      .select("id, check_id, attempts")
      .eq("status", "pending")
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (claimErr) throw claimErr;

    const { count: remainingBefore } = await supabase
      .from("check_deposit_image_backfill_queue")
      .select("*", { count: "exact", head: true })
      .eq("status", "pending");

    if (!row) return json({ ok: true, done: true, remaining: 0 });

    // Mark processing
    await supabase.from("check_deposit_image_backfill_queue")
      .update({ status: "processing", attempts: row.attempts + 1, updated_at: new Date().toISOString() })
      .eq("id", row.id);

    const { data: check, error: cErr } = await supabase
      .from("check_intake_items")
      .select("front_image_path, back_image_path")
      .eq("id", row.check_id)
      .maybeSingle();

    if (cErr || !check) {
      await supabase.from("check_deposit_image_backfill_queue")
        .update({ status: "error", last_error: cErr?.message ?? "check not found", updated_at: new Date().toISOString() })
        .eq("id", row.id);
      return json({ ok: false, processed: row.check_id, error: "check not found", remaining: (remainingBefore ?? 1) - 1 });
    }

    const front = await processSide(supabase, (check as any).front_image_path);
    const back = await processSide(supabase, (check as any).back_image_path);

    const finalStatus = (front === "error" || back === "error") ? "error" : "done";
    await supabase.from("check_deposit_image_backfill_queue")
      .update({
        status: finalStatus,
        front_result: front,
        back_result: back,
        last_error: finalStatus === "error" ? "one or both sides failed" : null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", row.id);

    return json({
      ok: true, processed: row.check_id, front, back,
      remaining: Math.max(0, (remainingBefore ?? 1) - 1),
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

// CheckAlt image preparation — normalizes ONE side (front or back) of a check
// image to fit CheckAlt's per-image byte budget, uploads the result to storage
// as a "deposit-ready" variant, and returns the storage path.
//
// Splitting per-side normalization into its own edge function gives each side
// an independent CPU budget so oversized images (5MB+) never trip the deposit
// worker's CPU-exceeded limit. Client calls this once for front and once for
// back before invoking checkalt-submit-deposit with the pre-normalized paths.

import { corsHeaders } from "https://esm.sh/@supabase/supabase-js@2/cors";
import { z } from "https://esm.sh/zod@3.23.8";
import { Image } from "https://deno.land/x/imagescript@1.3.0/mod.ts";
import { getServiceClient } from "../_shared/checkalt.ts";

const TARGET_MAX_DIM = 1600;
const TARGET_JPEG_QUALITY = 78;
const MIN_DIM = 1300;
const MIN_QUALITY = 35;
const PER_IMAGE_BYTES_BUDGET = 450_000;

const BUCKET = "claim-files";

const BodySchema = z.object({
  check_intake_item_id: z.string().uuid(),
  side: z.enum(["front", "back"]),
});

async function resolveRasterPath(
  supabase: ReturnType<typeof getServiceClient>,
  checkId: string,
  path: string,
  allowOriginalFallback = false,
): Promise<string> {
  if (!/\.svg(\?|$)/i.test(path)) return path;

  if (!allowOriginalFallback) {
    throw new Error(
      "Back image needs an approved deposit JPEG before submission. Generate and approve the deposit image before depositing.",
    );
  }

  try {
    const { data: evt } = await supabase
      .from("check_endorsement_events")
      .select("event_data")
      .eq("check_id", checkId)
      .order("created_at", { ascending: false })
      .limit(20);
    for (const row of (evt ?? []) as any[]) {
      const d = row?.event_data ?? {};
      const orig = d.original_back_image_path ?? d.original_back_path;
      if (orig && !/\.svg(\?|$)/i.test(orig)) return orig as string;
    }
  } catch (_) { /* fall through */ }

  const base = path.replace(/_endorsed_\d+\.svg$/i, "");
  if (base !== path) {
    for (const ext of [".jpeg", ".jpg", ".png"]) {
      const candidate = `${base}${ext}`;
      const { data } = await supabase.storage.from(BUCKET).createSignedUrl(candidate, 60);
      if (data?.signedUrl) return candidate;
    }
  }
  throw new Error(
    "Back-of-check image is stored as SVG and the original raster could not be located. " +
    "Reupload the back image as JPEG or PNG before depositing.",
  );
}

async function normalizeToBudget(bytes: Uint8Array, label: string): Promise<Uint8Array> {
  let img = await Image.decode(bytes);

  // Mitek IQA rejects sideways checks (reject 1680) — force landscape first.
  const wasPortrait = img.height > img.width;
  if (wasPortrait) img = img.rotate(90);

  const withinBudget = bytes.length <= PER_IMAGE_BYTES_BUDGET;
  const bigEnough = Math.max(img.width, img.height) >= MIN_DIM;
  if (!wasPortrait && withinBudget && bigEnough) return bytes;

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
      const newLongest = Math.max(img.width, img.height);
      if (newLongest <= MIN_DIM) break;
      const nextDim = Math.max(MIN_DIM, Math.round(newLongest * 0.8));
      const scale = nextDim / newLongest;
      img = img.resize(Math.round(img.width * scale), Math.round(img.height * scale));
    }
    out = await img.encodeJPEG(quality);
  }
  console.log(
    `[checkalt-prepare-image] normalized ${label}: ${Math.round(bytes.length / 1024)}KB → ${Math.round(out.length / 1024)}KB @ ${img.width}x${img.height} q=${quality}`,
  );
  if (out.length > PER_IMAGE_BYTES_BUDGET) {
    throw new Error(
      `${label} could not be compressed below ${Math.round(PER_IMAGE_BYTES_BUDGET / 1024)}KB.`,
    );
  }
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const supabase = getServiceClient();
    const { data: { user }, error: userErr } = await supabase.auth.getUser(
      authHeader.replace("Bearer ", ""),
    );
    if (userErr || !user?.id) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const parsed = BodySchema.safeParse(await req.json());
    if (!parsed.success) {
      return new Response(JSON.stringify({ error: parsed.error.flatten().fieldErrors }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const { check_intake_item_id, side } = parsed.data;

    const { data: check, error: checkErr } = await supabase
      .from("check_intake_items")
      .select("id, front_image_path, back_image_path, back_image_deposit_path")
      .eq("id", check_intake_item_id)
      .maybeSingle();
    if (checkErr || !check) throw new Error(checkErr?.message || "Check not found");

    const rawPath = side === "front"
      ? check.front_image_path
      : (check.back_image_deposit_path ?? check.back_image_path);
    if (!rawPath) {
      return new Response(
        JSON.stringify({ prepared_path: null, skipped: true, reason: "no_source_image" }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Prefer the approved endorsed deposit JPEG when present. Do not silently
    // resolve endorsed SVG wrappers back to the original raster, because that
    // would submit a clean back image without the received endorsements.
    const sourcePath = side === "back"
      ? await resolveRasterPath(supabase, check.id, rawPath, Boolean(check.back_image_deposit_path))
      : rawPath;

    // Skip re-preparing if a prior deposit-ready variant is already present.
    const preparedPath = `${sourcePath.replace(/\.(jpe?g|png|webp|svg)$/i, "")}.deposit2.jpg`;
    const { data: existing } = await supabase.storage.from(BUCKET).createSignedUrl(preparedPath, 60);
    if (existing?.signedUrl) {
      // Cheap HEAD check by re-signing; presence of a signed URL doesn't guarantee bytes exist.
      const { data: dl } = await supabase.storage.from(BUCKET).download(preparedPath);
      if (dl && dl.size > 0 && dl.size <= PER_IMAGE_BYTES_BUDGET) {
        console.log(`[checkalt-prepare-image] reusing cached ${side}: ${preparedPath} (${dl.size}B)`);
        return new Response(JSON.stringify({ prepared_path: preparedPath, cached: true }), {
          status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    const { data: srcBlob, error: dlErr } = await supabase.storage.from(BUCKET).download(sourcePath);
    if (dlErr || !srcBlob) throw new Error(`${side} download failed: ${dlErr?.message}`);
    const srcBytes = new Uint8Array(await srcBlob.arrayBuffer());
    const normalized = await normalizeToBudget(srcBytes, side);

    const { error: upErr } = await supabase.storage.from(BUCKET).upload(
      preparedPath,
      new Blob([normalized], { type: "image/jpeg" }),
      { upsert: true, contentType: "image/jpeg" },
    );
    if (upErr) throw new Error(`${side} upload failed: ${upErr.message}`);

    return new Response(JSON.stringify({ prepared_path: preparedPath, cached: false }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    console.error("[checkalt-prepare-image]", msg);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

// CheckAlt RDC submission — POSTs front/back check images to FinCapture's
// `/fincapture/deposit/process` endpoint and persists the result in
// checkalt_deposits.
//
// Image rules (FinCapture spec):
//   - 25 KB – 300 KB per image (1 MB hard max)
//   - Compressed JPEG, base64-encoded after compression
//   - Front + back required in the same request

import { corsHeaders } from "https://esm.sh/@supabase/supabase-js@2/cors";
import { z } from "https://esm.sh/zod@3.23.8";
import { Image } from "https://deno.land/x/imagescript@1.2.17/mod.ts";
import {
  getServiceClient,
  loadConfig,
  checkAltFetch,
  getCheckAltFiKey,
} from "../_shared/checkalt.ts";

const BodySchema = z.object({
  check_intake_item_id: z.string().uuid(),
});

const MIN_BYTES = 25 * 1024;
const MAX_BYTES = 300 * 1024;

async function downloadAndCompress(
  supabase: ReturnType<typeof getServiceClient>,
  path: string,
): Promise<string> {
  const { data, error } = await supabase.storage.from("claim-files").download(path);
  if (error || !data) throw new Error(`Image download failed: ${error?.message}`);
  const raw = new Uint8Array(await data.arrayBuffer());

  // Decode + resize to ~75% then iteratively re-encode to land inside 25–300 KB.
  let img: Image;
  try {
    img = await Image.decode(raw);
  } catch (e) {
    throw new Error(`Image decode failed (${path}): ${e instanceof Error ? e.message : e}`);
  }
  // Initial resize: 75% per FinCapture compression guidance
  let w = Math.max(640, Math.round(img.width * 0.75));
  img = img.resize(w, Image.RESIZE_AUTO);

  let quality = 75;
  let encoded = await img.encodeJPEG(quality);
  // Shrink further if still too large
  while (encoded.byteLength > MAX_BYTES && (quality > 25 || w > 640)) {
    if (quality > 25) {
      quality = Math.max(25, quality - 10);
    } else {
      w = Math.max(640, Math.round(w * 0.85));
      img = img.resize(w, Image.RESIZE_AUTO);
    }
    encoded = await img.encodeJPEG(quality);
  }
  // Bump quality back up if we're under the minimum (rare for check photos)
  while (encoded.byteLength < MIN_BYTES && quality < 95) {
    quality = Math.min(95, quality + 10);
    encoded = await img.encodeJPEG(quality);
  }

  let binary = "";
  for (let i = 0; i < encoded.length; i++) binary += String.fromCharCode(encoded[i]);
  return btoa(binary);
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
    const token = authHeader.replace("Bearer ", "");
    const { data: claims } = await supabase.auth.getClaims(token);
    const userId = claims?.claims?.sub;
    if (!userId) {
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
    const { check_intake_item_id } = parsed.data;

    const cfg = await loadConfig(supabase);
    if (!cfg.default_enabled) {
      return new Response(JSON.stringify({ error: "CheckAlt integration is disabled" }), {
        status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (!cfg.base_url || !cfg.depositor_account_id) {
      return new Response(JSON.stringify({ error: "CheckAlt is not fully configured" }), {
        status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: check, error: checkErr } = await supabase
      .from("check_intake_items")
      .select("id, tenant_id, amount, check_number, front_image_path, back_image_path, status")
      .eq("id", check_intake_item_id)
      .maybeSingle();
    if (checkErr || !check) throw new Error(checkErr?.message || "Check not found");
    if (!check.front_image_path || !check.back_image_path) {
      throw new Error("Both front and back check images are required for CheckAlt submission");
    }

    const [frontImage, rearImage] = await Promise.all([
      downloadAndCompress(supabase, check.front_image_path),
      downloadAndCompress(supabase, check.back_image_path),
    ]);

    // Create pending deposit row for audit anchor
    const { data: depositRow, error: depErr } = await supabase
      .from("checkalt_deposits")
      .insert({
        check_intake_item_id: check.id,
        tenant_id: check.tenant_id,
        amount: check.amount,
        status: "pending",
        submitted_by: userId,
      })
      .select()
      .single();
    if (depErr) throw depErr;

    const fiKey = getCheckAltFiKey();
    const payload = {
      fiKey,
      ssoKey: cfg.business_unit || cfg.depositor_account_id,
      captureDateTime: new Date().toISOString(),
      depositAccountNumber: cfg.depositor_account_id,
      userAmount: Number(check.amount),
      frontImage,
      rearImage,
      performRiskAssessment: true,
      externalReference: depositRow.id,
    };

    const submitResp = await checkAltFetch(supabase, "/fincapture/deposit/process", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    const submitJson = await submitResp.json().catch(() => ({}));

    if (!submitResp.ok) {
      await supabase
        .from("checkalt_deposits")
        .update({ status: "error", last_status_payload: submitJson })
        .eq("id", depositRow.id);
      return new Response(JSON.stringify({
        error: "CheckAlt submission failed",
        status: submitResp.status,
        details: submitJson,
      }), { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const reference: string | undefined =
      submitJson?.reference ?? submitJson?.referenceId ??
      submitJson?.depositReference ?? submitJson?.transactionId ?? submitJson?.id;

    // Map FinCapture status codes -> internal status
    const apiStatus = Number(submitJson?.status ?? submitJson?.statusCode);
    let internalStatus = "submitted";
    if (apiStatus === 40) internalStatus = "pending_approval";
    else if (apiStatus === 120) internalStatus = "rejected";
    else if (apiStatus === 11) internalStatus = "error";

    await supabase
      .from("checkalt_deposits")
      .update({
        checkalt_reference: reference ?? null,
        status: internalStatus,
        submitted_at: new Date().toISOString(),
        last_status_payload: submitJson,
      })
      .eq("id", depositRow.id);

    await supabase
      .from("claim_checks")
      .update({ deposit_method: "checkalt", checkalt_deposit_id: depositRow.id })
      .eq("check_intake_item_id", check.id);

    return new Response(JSON.stringify({
      success: true,
      deposit_id: depositRow.id,
      checkalt_reference: reference ?? null,
      status: internalStatus,
      api_status: apiStatus,
      status_description: submitJson?.statusDescription ?? null,
    }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    console.error("[checkalt-submit-deposit]", msg);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

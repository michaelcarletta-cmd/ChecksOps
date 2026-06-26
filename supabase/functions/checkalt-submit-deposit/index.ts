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
  loadTenantAccount,
  checkAltFetch,
  getCheckAltFiKey,
  syncDepositItem,
} from "../_shared/checkalt.ts";

const BodySchema = z.object({
  check_intake_item_id: z.string().uuid(),
});

const MIN_BYTES = 25 * 1024;
const MAX_BYTES = 300 * 1024;

function base64FromBytes(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

async function downloadStorageTransform(
  supabase: ReturnType<typeof getServiceClient>,
  path: string,
): Promise<Uint8Array | null> {
  const candidates = [
    { width: 1200, quality: 68 },
    { width: 1100, quality: 62 },
    { width: 1000, quality: 58 },
    { width: 900, quality: 54 },
    { width: 800, quality: 50 },
    { width: 700, quality: 46 },
  ];

  let bestUnderMax: Uint8Array | null = null;
  let largestUnderMin: Uint8Array | null = null;

  for (const candidate of candidates) {
    const { data, error } = await supabase.storage.from("claim-files").download(path, {
      transform: {
        width: candidate.width,
        resize: "contain",
        quality: candidate.quality,
      },
    } as any);
    if (error || !data) continue;

    const bytes = new Uint8Array(await data.arrayBuffer());
    if (bytes.byteLength >= MIN_BYTES && bytes.byteLength <= MAX_BYTES) return bytes;
    if (bytes.byteLength <= MAX_BYTES) bestUnderMax = bytes;
    if (bytes.byteLength < MIN_BYTES && (!largestUnderMin || bytes.byteLength > largestUnderMin.byteLength)) {
      largestUnderMin = bytes;
    }
  }

  return bestUnderMax ?? largestUnderMin;
}

async function downloadAndCompress(
  supabase: ReturnType<typeof getServiceClient>,
  path: string,
): Promise<string> {
  const transformed = await downloadStorageTransform(supabase, path);
  if (transformed && transformed.byteLength >= MIN_BYTES && transformed.byteLength <= MAX_BYTES) {
    return base64FromBytes(transformed);
  }

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
  // FinCapture spec targets 1920x1080 capture; we cap at 1600px wide to
  // stay well above the Federal Reserve 200 DPI ICL minimum on a ~6" check
  // (~266 DPI) while keeping imagescript CPU bounded on edge runtime.
  const MAX_DIM = 1000;
  let w = Math.min(MAX_DIM, img.width);
  if (w !== img.width) {
    img = img.resize(w, Image.RESIZE_AUTO);
  }

  let quality = 58;
  let encoded = await img.encodeJPEG(quality);
  // Shrink further if still too large — bounded loop to stay inside Edge CPU limits.
  let iter = 0;
  while (encoded.byteLength > MAX_BYTES && iter < 3 && (quality > 35 || w > 700)) {
    if (quality > 35) {
      quality = Math.max(35, quality - 12);
    } else {
      w = Math.max(700, Math.round(w * 0.82));
      img = img.resize(w, Image.RESIZE_AUTO);
    }
    encoded = await img.encodeJPEG(quality);
    iter++;
  }
  // Bump quality back up if we're under the minimum (rare for check photos)
  while (encoded.byteLength < MIN_BYTES && quality < 95) {
    quality = Math.min(90, quality + 12);
    encoded = await img.encodeJPEG(quality);
  }

  if (encoded.byteLength > MAX_BYTES) {
    throw new Error(`Compressed image is still too large for CheckAlt (${Math.round(encoded.byteLength / 1024)} KB). Re-upload a clearer cropped JPG check image.`);
  }
  if (encoded.byteLength < MIN_BYTES) {
    throw new Error(`Compressed image is too small for CheckAlt (${Math.round(encoded.byteLength / 1024)} KB). Re-upload a higher quality check image.`);
  }

  return base64FromBytes(encoded);
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
    if (!cfg.base_url) {
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

    const tenantAccount = await loadTenantAccount(supabase, check.tenant_id);

    const frontImage = await downloadAndCompress(supabase, check.front_image_path);
    const rearImage = await downloadAndCompress(supabase, check.back_image_path);

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
      ssoKey: tenantAccount.sso_user_id,
      captureDateTime: new Date().toISOString(),
      depositAccountNumber: tenantAccount.deposit_account_number,
      userAmount: Number(check.amount),
      frontImage,
      rearImage,
      performRiskAssessment: true,
    };

    // Use the (stable) pending deposit row id as the idempotency key. Any
    // retry of this exact submission reuses the same key and CheckAlt will
    // return 409 Conflict instead of double-posting.
    const submitResp = await checkAltFetch(supabase, "/fincapture/deposit/process", {
      method: "POST",
      body: JSON.stringify(payload),
      idempotencyKey: `deposit-${depositRow.id}`,
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
      submitJson?.referenceNumber ?? submitJson?.reference ?? submitJson?.referenceId ??
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

    // Status sync: when CheckAlt accepts the submission (anything other than
    // outright error/reject), advance the check_intake_items stage to
    // 'deposited' so it surfaces under the Deposited tab. Rejections and
    // hard errors leave the stage where it was so the operator can retry.
    if (internalStatus !== "rejected" && internalStatus !== "error") {
      await supabase
        .from("check_intake_items")
        .update({
          check_stage: "deposited",
          deposited_at: new Date().toISOString(),
          deposited_by_tenant_id: check.tenant_id,
        })
        .eq("id", check.id);
    }

    // Mirror into the deposit_items pipeline if this check was routed there
    // (assign_provider must have set provider = 'checkalt' first).
    const { data: depositItem } = await supabase
      .from("deposit_items")
      .select("id, status, provider")
      .eq("check_id", check.id)
      .maybeSingle();
    if (depositItem && depositItem.provider === "checkalt") {
      await syncDepositItem(supabase, {
        action: "record_submission",
        deposit_item_id: depositItem.id,
        actor_id: userId,
        extra: { provider_reference: reference, payload: submitJson },
      });
      if (internalStatus === "rejected" || internalStatus === "error") {
        await syncDepositItem(supabase, {
          action: "record_failure",
          deposit_item_id: depositItem.id,
          actor_id: userId,
          notes: submitJson?.statusDescription ?? internalStatus,
          extra: { error: submitJson?.statusDescription ?? internalStatus, error_code: String(apiStatus), response: submitJson },
        });
      }
    }

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

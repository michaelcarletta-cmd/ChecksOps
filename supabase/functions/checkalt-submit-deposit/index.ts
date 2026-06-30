// CheckAlt RDC submission — sends check images to FinCapture for deposit.
// Pulls front/back check images from storage, base64-encodes, POSTs to
// /fincapture/deposit/process per the Clearingworks FinCapture API spec.
//
// The ssoKey for the deposit is resolved in this order:
//   1. Cached in last_register_payload.sso_key (stored during registration)
//   2. Fetched live from getUserAccountInformation
//   3. Falls back to sso_user_id (may work if CheckAlt uses userId as ssoKey)

import { corsHeaders } from "https://esm.sh/@supabase/supabase-js@2/cors";
import { z } from "https://esm.sh/zod@3.23.8";
import {
  getServiceClient,
  loadConfig,
  checkAltFetch,
  getUserAccountInfo,
  extractSsoKey,
} from "../_shared/checkalt.ts";

// CheckAlt now enforces a tighter per-image size. We aggressively downscale +
// recompress every image before submission so phone-camera originals (often
// 4-8MB) make it through. Target: ~700KB per side, max ~1.4MB combined b64.
const TARGET_MAX_DIM = 1600;        // px, longest edge
const TARGET_JPEG_QUALITY = 72;
const MIN_DIM = 800;                // px, do not shrink below this
const MIN_QUALITY = 45;
const PER_IMAGE_BYTES_BUDGET = 750_000;   // ~750KB encoded JPEG per side
const MAX_TOTAL_B64_CHARS = 2_400_000;    // ~1.8MB combined base64 payload

const IMAGESCRIPT_URL = "https://deno.land/x/imagescript@1.2.17/mod.ts";
let _imagescript: any = null;
async function getImageScript() {
  if (!_imagescript) _imagescript = await import(IMAGESCRIPT_URL);
  return _imagescript;
}

function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(
      null,
      bytes.subarray(i, i + CHUNK) as unknown as number[],
    );
  }
  return btoa(binary);
}

/**
 * Decode → resize → re-encode JPEG, iterating down until the output fits the
 * per-image byte budget. Returns base64 (no data: prefix). Falls back to the
 * raw bytes if decoding fails so PDFs / unknown blobs aren't dropped.
 */
async function normalizeImageToBudget(
  bytes: Uint8Array,
  label: string,
): Promise<string> {
  try {
    const { Image } = await getImageScript();
    let img = await Image.decode(bytes);
    let maxDim = TARGET_MAX_DIM;
    let quality = TARGET_JPEG_QUALITY;

    // Always resize down to TARGET_MAX_DIM first.
    const longest = Math.max(img.width, img.height);
    if (longest > maxDim) {
      const scale = maxDim / longest;
      img = img.resize(Math.round(img.width * scale), Math.round(img.height * scale));
    }

    let out: Uint8Array = await img.encodeJPEG(quality);

    // Tighten until it fits the budget or we hit floors.
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
      `[checkalt-submit-deposit] normalized ${label}: ${Math.round(bytes.length / 1024)}KB → ${Math.round(out.length / 1024)}KB @ ${img.width}x${img.height} q=${quality}`,
    );
    return bytesToBase64(out);
  } catch (e) {
    console.warn(
      `[checkalt-submit-deposit] normalize failed for ${label}, using original (${Math.round(bytes.length / 1024)}KB):`,
      (e as Error).message,
    );
    return bytesToBase64(bytes);
  }
}

const BodySchema = z.object({
  check_intake_item_id: z.string().uuid(),
});

Deno.serve(async (req) => {
  if (req.method === "OPTIONS")
    return new Response("ok", { headers: corsHeaders });

  try {
    // --- auth ---
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const supabase = getServiceClient();
    const token = authHeader.replace("Bearer ", "");
    const {
      data: { user },
      error: userErr,
    } = await supabase.auth.getUser(token);
    const userId = user?.id;
    if (userErr || !userId) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // --- input ---
    const parsed = BodySchema.safeParse(await req.json());
    if (!parsed.success) {
      return new Response(
        JSON.stringify({ error: parsed.error.flatten().fieldErrors }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }
    const { check_intake_item_id } = parsed.data;

    // --- gate: integration must be enabled + fully configured ---
    const cfg = await loadConfig(supabase);
    if (!cfg.default_enabled) {
      return new Response(
        JSON.stringify({ error: "CheckAlt integration is disabled" }),
        {
          status: 409,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }
    if (
      !cfg.base_url ||
      !cfg.depositor_account_id ||
      !cfg.merchant ||
      !cfg.fi_key
    ) {
      return new Response(
        JSON.stringify({ error: "CheckAlt is not fully configured (need base_url, depositor_account_id, merchant, fi_key)" }),
        {
          status: 409,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // --- load check + images ---
    const { data: check, error: checkErr } = await supabase
      .from("check_intake_items")
      .select(
        "id, tenant_id, amount, check_number, front_image_path, back_image_path, status",
      )
      .eq("id", check_intake_item_id)
      .maybeSingle();
    if (checkErr || !check)
      throw new Error(checkErr?.message || "Check not found");

    // --- load submitting user's profile for FinCapture user fields ---
    const { data: profile } = await supabase
      .from("profiles")
      .select("email, full_name")
      .eq("id", userId)
      .maybeSingle();
    const userEmail = profile?.email ?? user?.email ?? "";
    const fullName = profile?.full_name ?? "";
    const nameParts = fullName.trim().split(/\s+/);
    const firstName = nameParts[0] || "User";
    const lastName = nameParts.length > 1 ? nameParts.slice(1).join(" ") : "";

    const downloadAsB64 = async (path: string | null, label: "front" | "back") => {
      if (!path) return null;
      const { data, error } = await supabase.storage
        .from("claim-files")
        .download(path);
      if (error || !data)
        throw new Error(`${label} image download failed: ${error?.message}`);
      const bytes = new Uint8Array(await data.arrayBuffer());
      return await normalizeImageToBudget(bytes, label);
    };
    const frontB64 = await downloadAsB64(check.front_image_path, "front");
    const backB64 = await downloadAsB64(check.back_image_path, "back");

    if (!frontB64)
      throw new Error("Front image required for CheckAlt submission");

    const totalB64 = frontB64.length + (backB64?.length ?? 0);
    if (totalB64 > MAX_TOTAL_B64_CHARS) {
      throw new Error(
        `Combined check images still exceed CheckAlt's limit after compression (${(totalB64 / 1_000_000).toFixed(1)}MB encoded). ` +
        `Please reupload smaller front/back images.`
      );
    }



    // --- look up tenant-specific CheckAlt account ---
    const { data: tenantAccount, error: taErr } = await supabase
      .from("checkalt_tenant_accounts")
      .select("sso_user_id, deposit_account_number, last_register_payload")
      .eq("tenant_id", check.tenant_id)
      .maybeSingle();
    if (taErr) throw taErr;
    if (!tenantAccount?.sso_user_id || !tenantAccount?.deposit_account_number) {
      return new Response(
        JSON.stringify({ error: "Tenant CheckAlt account not registered. Register in Integration Settings first." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // --- resolve the real ssoKey ---
    // Priority: cached in last_register_payload → live from getUserAccountInfo → fallback to sso_user_id
    let ssoKey: string | null = null;
    const cached = tenantAccount.last_register_payload as any;
    if (cached?.sso_key) {
      ssoKey = cached.sso_key;
      console.log("[checkalt-submit-deposit] Using cached ssoKey from registration");
    }

    if (!ssoKey) {
      // Fetch live from CheckAlt
      try {
        const info = await getUserAccountInfo(supabase, tenantAccount.sso_user_id);
        if (info.ok) {
          ssoKey = extractSsoKey(info.json, tenantAccount.deposit_account_number);
          console.log("[checkalt-submit-deposit] Fetched ssoKey from getUserAccountInfo:", ssoKey ? "found" : "not found");

          // Cache for next time
          if (ssoKey) {
            await supabase
              .from("checkalt_tenant_accounts")
              .update({
                last_register_payload: {
                  ...(typeof cached === "object" && cached ? cached : {}),
                  user_account_info: info.json,
                  sso_key: ssoKey,
                },
              })
              .eq("tenant_id", check.tenant_id);
          }
        }
      } catch (e) {
        console.error("[checkalt-submit-deposit] getUserAccountInfo failed:", e);
      }
    }

    // Fallback: use sso_user_id as ssoKey (works when CheckAlt userId = ssoKey)
    if (!ssoKey) {
      ssoKey = tenantAccount.sso_user_id;
      console.log("[checkalt-submit-deposit] Falling back to sso_user_id as ssoKey");
    }

    // --- create pending deposit row first (audit anchor) ---
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

    // --- submit to FinCapture /fincapture/deposit/process ---
    // Payload shape per CheckAlt's official sample — only these fields:
    //   fiKey, ssoKey, captureDateTime, userAmount, frontImage, rearImage, performRiskAssessment
    const submitResp = await checkAltFetch(
      supabase,
      "/fincapture/deposit/process",
      {
        method: "POST",
        body: JSON.stringify({
          fiKey: cfg.fi_key,
          ssoKey,
          captureDateTime: new Date().toISOString(),
          userAmount: check.amount,
          frontImage: frontB64,
          rearImage: backB64 ?? undefined,
          performRiskAssessment: true,
        }),
      },
    );
    const submitText = await submitResp.text();
    let submitJson: any = {};
    try { submitJson = submitText ? JSON.parse(submitText) : {}; } catch { submitJson = { raw: submitText }; }
    console.log("[checkalt-submit-deposit] response", submitResp.status, submitText.slice(0, 500));

    if (!submitResp.ok) {
      await supabase
        .from("checkalt_deposits")
        .update({ status: "error", last_status_payload: { http_status: submitResp.status, body: submitJson, raw: submitText.slice(0, 2000) } })
        .eq("id", depositRow.id);
      return new Response(
        JSON.stringify({
          error: "CheckAlt submission failed",
          status: submitResp.status,
          details: submitJson,
          raw: submitText.slice(0, 1000),
        }),
        {
          status: 502,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const reference: string | undefined = submitJson?.referenceNumber != null
      ? String(submitJson.referenceNumber)
      : undefined;

    await supabase
      .from("checkalt_deposits")
      .update({
        checkalt_reference: reference ?? null,
        status: "submitted",
        submitted_at: new Date().toISOString(),
        last_status_payload: submitJson,
      })
      .eq("id", depositRow.id);

    await supabase
      .from("claim_checks")
      .update({
        deposit_method: "checkalt",
        checkalt_deposit_id: depositRow.id,
      })
      .eq("check_intake_item_id", check.id);

    return new Response(
      JSON.stringify({
        success: true,
        deposit_id: depositRow.id,
        checkalt_reference: reference ?? null,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    console.error("[checkalt-submit-deposit]", msg);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

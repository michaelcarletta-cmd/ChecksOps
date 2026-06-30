// CheckAlt RDC submission — sends check images to FinCapture for deposit.
// Pulls front/back check images from storage, base64-encodes, POSTs to
// /fincapture/deposit/process per the Clearingworks FinCapture API spec.
//
// Returns the CheckAlt reference number and writes a checkalt_deposits row.
// Live traffic only happens once CHECKALT_USERNAME/PASSWORD + base_url + merchant
// + fi_key are configured.
//
// NOTE: Heavy image libraries (imagescript, resvg_wasm) removed to stay within
// edge function compute limits. Image compression should happen client-side
// before upload. If images exceed CheckAlt's ~10MB payload limit after base64
// encoding, the function returns an error asking the user to upload smaller images.

import { corsHeaders } from "https://esm.sh/@supabase/supabase-js@2/cors";
import { z } from "https://esm.sh/zod@3.23.8";
import {
  getServiceClient,
  loadConfig,
  checkAltFetch,
} from "../_shared/checkalt.ts";

// CheckAlt has a ~10MB total payload limit. Base64 adds ~33% overhead.
// 3MB per image raw ≈ 4MB base64 ≈ 8MB for front+back with JSON wrapper.
const MAX_IMAGE_BYTES = 3_500_000;
const MAX_TOTAL_B64_CHARS = 8_800_000;

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
      if (bytes.length > MAX_IMAGE_BYTES) {
        throw new Error(
          `${label} image is too large (${(bytes.length / 1_000_000).toFixed(1)}MB). ` +
          `Please upload a smaller image (max ~3.5MB). Compress or resize it before uploading.`
        );
      }
      return bytesToBase64(bytes);
    };
    const frontB64 = await downloadAsB64(check.front_image_path, "front");
    const backB64 = await downloadAsB64(check.back_image_path, "back");

    if (!frontB64)
      throw new Error("Front image required for CheckAlt submission");

    const totalB64 = frontB64.length + (backB64?.length ?? 0);
    if (totalB64 > MAX_TOTAL_B64_CHARS) {
      throw new Error(
        `Combined check images are too large for CheckAlt (${(totalB64 / 1_000_000).toFixed(1)}MB encoded). ` +
        `Please upload smaller front/back images.`
      );
    }

    // --- look up tenant-specific CheckAlt account ---
    const { data: tenantAccount, error: taErr } = await supabase
      .from("checkalt_tenant_accounts")
      .select("sso_user_id, deposit_account_number")
      .eq("tenant_id", check.tenant_id)
      .maybeSingle();
    if (taErr) throw taErr;
    if (!tenantAccount?.sso_user_id || !tenantAccount?.deposit_account_number) {
      return new Response(
        JSON.stringify({ error: "Tenant CheckAlt account not registered. Register in Integration Settings first." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
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
    // Body schema: FinCaptureAPIDepositRequest from Clearingworks OpenAPI spec
    const submitResp = await checkAltFetch(
      supabase,
      "/fincapture/deposit/process",
      {
        method: "POST",
        body: JSON.stringify({
          fiKey: cfg.fi_key,
          ssoKey: tenantAccount.sso_user_id,
          depositAccountNumber: tenantAccount.deposit_account_number,
          firstName,
          lastName,
          emailAddress: userEmail,
          captureDateTime: new Date().toISOString(),
          userAmount: check.amount,
          frontImage: frontB64,
          rearImage: backB64 ?? undefined,
          performRiskAssessment: false,
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

    // Response schema: FinCaptureAPIDepositResponse
    // referenceNumber is int64 — store as string for our DB
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

    // Link claim_checks if a row exists
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

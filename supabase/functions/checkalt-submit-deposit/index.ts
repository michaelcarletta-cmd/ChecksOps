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
import { Image } from "https://deno.land/x/imagescript@1.3.0/mod.ts";
import {
  getServiceClient,
  loadConfig,
  checkAltFetch,
  getUserAccountInfo,
  extractSsoKey,
} from "../_shared/checkalt.ts";

// CheckAlt enforces a tight image payload. Compress every already-uploaded
// image during deposit so existing oversized uploads do not need reuploading.
const TARGET_MAX_DIM = 1200;              // px, longest edge
const TARGET_JPEG_QUALITY = 68;
const MIN_DIM = 600;                      // px, final hard floor
const MIN_QUALITY = 35;
const PER_IMAGE_BYTES_BUDGET = 450_000;   // ~450KB encoded JPEG per side
const MAX_TOTAL_B64_CHARS = 1_600_000;    // ~1.2MB combined base64 payload

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
    if (out.length > PER_IMAGE_BYTES_BUDGET) {
      throw new Error(
        `${label} image could not be compressed below ${Math.round(PER_IMAGE_BYTES_BUDGET / 1024)}KB ` +
        `(${Math.round(out.length / 1024)}KB after compression). Reupload a JPEG/PNG image.`,
      );
    }

    return bytesToBase64(out);
  } catch (e) {
    console.error(
      `[checkalt-submit-deposit] normalize failed for ${label} (${Math.round(bytes.length / 1024)}KB):`,
      (e as Error).message,
    );
    throw new Error(
      `${label} check image could not be compressed for CheckAlt. ` +
      `Reupload that side as a clear JPEG/PNG image under 2000px wide.`,
    );
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

    // --- load check ---
    const { data: check, error: checkErr } = await supabase
      .from("check_intake_items")
      .select(
        "id, tenant_id, amount, check_number, front_image_path, back_image_path, status",
      )
      .eq("id", check_intake_item_id)
      .maybeSingle();
    if (checkErr || !check)
      throw new Error(checkErr?.message || "Check not found");

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

    // --- create pending deposit row immediately (audit anchor) ---
    const { data: depositRow, error: depErr } = await supabase
      .from("checkalt_deposits")
      .insert({
        check_intake_item_id: check.id,
        tenant_id: check.tenant_id,
        amount: check.amount,
        status: "queued",
        submitted_by: userId,
      })
      .select()
      .single();
    if (depErr) throw depErr;

    // --- background worker: image normalization + CheckAlt submission ---
    // Offloaded via EdgeRuntime.waitUntil to avoid the 2s CPU limit on the
    // request handler. Frontend polls checkalt_deposits.status:
    // queued → pending → submitted | error.
    const runDeposit = async () => {
      try {
        await supabase
          .from("checkalt_deposits")
          .update({ status: "pending" })
          .eq("id", depositRow.id);

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

        if (!frontB64) throw new Error("Front image required for CheckAlt submission");

        const totalB64 = frontB64.length + (backB64?.length ?? 0);
        if (totalB64 > MAX_TOTAL_B64_CHARS) {
          throw new Error(
            `Combined check images still exceed CheckAlt's limit after compression (${(totalB64 / 1_000_000).toFixed(1)}MB encoded). ` +
            `Please reupload smaller front/back images.`,
          );
        }

        // resolve ssoKey
        let ssoKey: string | null = null;
        const cached = tenantAccount.last_register_payload as any;
        if (cached?.sso_key) ssoKey = cached.sso_key;
        if (!ssoKey) {
          try {
            const info = await getUserAccountInfo(supabase, tenantAccount.sso_user_id);
            if (info.ok) {
              ssoKey = extractSsoKey(info.json, tenantAccount.deposit_account_number);
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
        if (!ssoKey) ssoKey = tenantAccount.sso_user_id;

        const submitResp = await checkAltFetch(
          supabase,
          "/fincapture/deposit/process",
          {
            method: "POST",
            body: JSON.stringify({
              fiKey: cfg.fi_key,
              ssoKey,
              depositAccountNumber: tenantAccount.deposit_account_number,
              captureDateTime: new Date().toISOString(),
              // CheckAlt support: amount must be sent as an integer with no
              // decimal point, including cents (e.g. $123.45 -> 12345).
              // check.amount is stored in whole dollars (e.g. 780.00), so a
              // raw pass-through caused an "RDC Amount Mismatch" against the
              // cents-scale amount OCR'd off the check image.
              userAmount: Math.round(Number(check.amount) * 100),
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
            .update({
              status: "error",
              last_status_payload: { http_status: submitResp.status, body: submitJson, raw: submitText.slice(0, 2000) },
            })
            .eq("id", depositRow.id);
          return;
        }

        const reference: string | undefined = submitJson?.referenceNumber != null
          ? String(submitJson.referenceNumber)
          : undefined;

        // CheckAlt FinCapture status codes:
        //   40  = pending manual review/approval
        //   127 = submitted for processing
        //   120 = rejected
        // Once CheckAlt accepts the image package, the check belongs in the
        // Deposited tab. Status 40 is shown there as "Pending Approval" until
        // the manager approves it; the 48-hour release hold starts only after
        // that approval succeeds.
        const apiStatus = Number(submitJson?.status ?? submitJson?.statusCode);
        const isPendingApproval = apiStatus === 40;
        const internalStatus = isPendingApproval ? "pending_approval" : "submitted";
        const statusIso = new Date().toISOString();

        await supabase
          .from("checkalt_deposits")
          .update({
            checkalt_reference: reference ?? null,
            status: internalStatus,
            submitted_at: statusIso,
            last_status_payload: submitJson,
          })
          .eq("id", depositRow.id);

        await supabase
          .from("check_intake_items")
          .update({
            check_stage: "deposited",
            status: isPendingApproval ? "approved_for_deposit" : "deposited",
            deposit_recommendation: null,
            deposited_at: isPendingApproval ? null : statusIso,
            deposited_by_tenant_id: check.tenant_id,
            updated_at: statusIso,
          })
          .eq("id", check.id);

        await supabase
          .from("claim_checks")
          .update({
            deposit_method: "checkalt",
            checkalt_deposit_id: depositRow.id,
            deposit_status: "deposited",
          })
          .eq("check_intake_item_id", check.id);

      } catch (e) {
        const msg = e instanceof Error ? e.message : "Unknown error";
        console.error("[checkalt-submit-deposit:bg]", msg);
        await supabase
          .from("checkalt_deposits")
          .update({ status: "error", last_status_payload: { error: msg } })
          .eq("id", depositRow.id);
      }
    };

    // @ts-ignore — EdgeRuntime is provided by the Deno edge runtime
    if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) {
      // @ts-ignore
      EdgeRuntime.waitUntil(runDeposit());
    } else {
      runDeposit();
    }

    return new Response(
      JSON.stringify({
        success: true,
        deposit_id: depositRow.id,
        status: "queued",
        message: "Deposit queued — images are being compressed and submitted to CheckAlt in the background.",
      }),
      {
        status: 202,
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

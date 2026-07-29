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
  // Fast path: if the source is already under budget, skip the CPU-heavy
  // decode/resize/re-encode cycle entirely. Uploads are pre-compressed to
  // 1600px by src/lib/compressCheckImage.ts, so most files land here.
  if (bytes.length <= PER_IMAGE_BYTES_BUDGET) {
    console.log(
      `[checkalt-submit-deposit] ${label} already under budget (${Math.round(bytes.length / 1024)}KB) — skipping re-encode`,
    );
    return bytesToBase64(bytes);
  }
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
  // Optional pre-normalized paths returned by checkalt-prepare-image.
  // When provided, submit skips the CPU-heavy normalize entirely (fast path).
  deposit_front_path: z.string().nullable().optional(),
  deposit_back_path: z.string().nullable().optional(),
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
    const { check_intake_item_id, deposit_front_path, deposit_back_path } = parsed.data;

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
        "id, tenant_id, amount, check_number, front_image_path, back_image_path, back_image_deposit_path, status",
      )
      .eq("id", check_intake_item_id)
      .maybeSingle();
    if (checkErr || !check)
      throw new Error(checkErr?.message || "Check not found");

    // --- look up tenant-specific CheckAlt account ---
    const { data: tenantAccount, error: taErr } = await supabase
      .from("checkalt_tenant_accounts")
      .select("sso_user_id, deposit_account_number, last_register_payload, auto_approve_enabled, auto_approve_max_cents")
      .eq("tenant_id", check.tenant_id)
      .maybeSingle();
    if (taErr) throw taErr;
    if (!tenantAccount?.sso_user_id || !tenantAccount?.deposit_account_number) {
      return new Response(
        JSON.stringify({ error: "Tenant CheckAlt account not registered. Register in Integration Settings first." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }


    // --- reap stuck prior deposits for this check ---
    // If a previous submission crashed mid-flight (edge worker CPU-exceeded),
    // its row can sit forever in "queued"/"pending" with no referenceNumber,
    // blocking the user. Mark any of those as errored before creating a new
    // attempt so the retry can proceed cleanly.
    await supabase
      .from("checkalt_deposits")
      .update({
        status: "error",
        last_status_payload: { reaped: true, reason: "superseded_by_retry" },
      })
      .eq("check_intake_item_id", check.id)
      .in("status", ["queued", "pending"])
      .is("checkalt_reference", null);

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

        // CheckAlt rejects SVGs. Prefer the approved endorsed deposit JPEG
        // (back_image_deposit_path) when present; only resolve SVG wrappers to
        // the original raster as a legacy fallback when no approved JPEG exists.
        const resolveRasterBackPath = async (path: string | null): Promise<string | null> => {
          if (!path) return null;
          if (!/\.svg(\?|$)/i.test(path)) return path;
          try {
            const { data: evt } = await supabase
              .from("check_endorsement_events")
              .select("event_data")
              .eq("check_id", check.id)
              .order("created_at", { ascending: false })
              .limit(20);
            for (const row of (evt ?? []) as any[]) {
              const d = row?.event_data ?? {};
              const orig = d.original_back_image_path ?? d.original_back_path;
              if (orig && !/\.svg(\?|$)/i.test(orig)) return orig as string;
            }
          } catch (e) {
            console.warn("[checkalt-submit-deposit] endorsement audit lookup failed:", (e as Error).message);
          }
          // Fallback: strip `_endorsed_<digits>.svg` and try common extensions.
          const base = path.replace(/_endorsed_\d+\.svg$/i, "");
          if (base !== path) {
            for (const ext of [".jpeg", ".jpg", ".png"]) {
              const candidate = `${base}${ext}`;
              const { data } = await supabase.storage.from("claim-files").createSignedUrl(candidate, 60);
              if (data?.signedUrl) return candidate;
            }
          }
          throw new Error(
            "Back-of-check image is stored as SVG and the original raster could not be located. " +
            "Reupload the back image as JPEG or PNG before depositing.",
          );
        };

        // Fast path: if the client called checkalt-prepare-image first, use
        // those pre-normalized paths directly and skip the CPU-heavy re-encode.
        const downloadPreparedAsB64 = async (path: string, label: "front" | "back") => {
          const { data, error } = await supabase.storage.from("claim-files").download(path);
          if (error || !data) throw new Error(`${label} prepared image download failed: ${error?.message}`);
          const bytes = new Uint8Array(await data.arrayBuffer());
          return bytesToBase64(bytes);
        };

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

        let frontB64: string | null;
        let backB64: string | null;
        if (deposit_front_path || deposit_back_path) {
          console.log("[checkalt-submit-deposit] using pre-normalized paths (fast path)");
          frontB64 = deposit_front_path
            ? await downloadPreparedAsB64(deposit_front_path, "front")
            : await downloadAsB64(check.front_image_path, "front");
          const fallbackBackPath = check.back_image_deposit_path ?? await resolveRasterBackPath(check.back_image_path);
          backB64 = deposit_back_path
            ? await downloadPreparedAsB64(deposit_back_path, "back")
            : await downloadAsB64(fallbackBackPath, "back");
        } else {
          const rasterBackPath = check.back_image_deposit_path ?? await resolveRasterBackPath(check.back_image_path);
          frontB64 = await downloadAsB64(check.front_image_path, "front");
          backB64 = await downloadAsB64(rasterBackPath, "back");
        }

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
        let isPendingApproval = apiStatus === 40;
        let internalStatus = isPendingApproval ? "pending_approval" : "submitted";
        let statusIso = new Date().toISOString();

        // --- Auto-approve pending_approval deposits if configured and clean ---
        // Skip auto-approve when CheckAlt returned any flags/exceptions or a
        // risk-related status description — those should always land in front
        // of a human. Also honor an optional amount ceiling.
        let autoApprovePayload: any = null;
        let autoApproveSkipReason: string | null = null;
        // Per-tenant settings take precedence over the global checkalt_config defaults.
        const autoApproveEnabled = tenantAccount.auto_approve_enabled ?? (cfg as any).auto_approve_enabled ?? false;
        const tenantMaxCents = tenantAccount.auto_approve_max_cents;
        if (isPendingApproval && reference && autoApproveEnabled) {
          const amountCents = Math.round(Number(check.amount) * 100);
          const maxCents = (tenantMaxCents ?? (cfg as any).auto_approve_max_cents) as number | null;


          const flagText = (
            String(submitJson?.statusDescription ?? "") + " " +
            JSON.stringify(submitJson?.warnings ?? "") + " " +
            JSON.stringify(submitJson?.exceptions ?? "")
          ).toLowerCase();
          const hasFlags =
            (Array.isArray(submitJson?.exceptions) && submitJson.exceptions.length > 0) ||
            (Array.isArray(submitJson?.warnings) && submitJson.warnings.length > 0) ||
            (Array.isArray(submitJson?.riskFactors) && submitJson.riskFactors.length > 0) ||
            /duplicate|fraud|risk|exception|warning|hold|suspect|mismatch|unreadable/.test(flagText);

          if (hasFlags) {
            autoApproveSkipReason = "flagged_by_checkalt";
          } else if (maxCents != null && amountCents > maxCents) {
            autoApproveSkipReason = "over_max_amount";
          } else {
            // CheckAlt briefly "locks" a transaction right after /process, so
            // calling /approve immediately returns 404 "We couldn't locate
            // transaction [...]. This may be due to the transaction being
            // locked or processed." Retry with backoff until it unlocks.
            const APPROVE_MAX_ATTEMPTS = 5;
            const APPROVE_BACKOFF_MS = [1500, 2500, 4000, 6000, 8000];
            let approveJson: any = null;
            let approveStatus = 0;
            let approved = false;
            for (let attempt = 0; attempt < APPROVE_MAX_ATTEMPTS; attempt++) {
              if (attempt > 0) {
                await new Promise((r) => setTimeout(r, APPROVE_BACKOFF_MS[attempt - 1] ?? 8000));
              }
              try {
                const approveResp = await checkAltFetch(supabase, "/fincapture/deposit/approve", {
                  method: "POST",
                  body: JSON.stringify({
                    fiKey: cfg.fi_key,
                    referenceNumber: Number(reference),
                    action: 1,
                  }),
                });
                approveStatus = approveResp.status;
                approveJson = await approveResp.json().catch(() => ({}));
                if (approveResp.ok && approveJson?.success === true) {
                  approved = true;
                  break;
                }
                const msg = String(approveJson?.message ?? approveJson?.statusDescription ?? "").toLowerCase();
                const isLocked = approveStatus === 404 && (msg.includes("locate transaction") || msg.includes("locked"));
                console.warn(
                  "[checkalt-submit-deposit] auto-approve attempt",
                  attempt + 1,
                  "status",
                  approveStatus,
                  "locked?",
                  isLocked,
                  approveJson,
                );
                if (!isLocked) break; // don't burn retries on non-lock failures
              } catch (approveErr) {
                autoApproveSkipReason = `auto_approve_error:${(approveErr as Error).message}`;
                console.error("[checkalt-submit-deposit] auto-approve error", approveErr);
                break;
              }
            }
            if (approved) {
              autoApprovePayload = approveJson;
              isPendingApproval = false;
              internalStatus = "submitted";
              statusIso = new Date().toISOString();
              console.log("[checkalt-submit-deposit] auto-approved", reference);
            } else if (!autoApproveSkipReason) {
              autoApproveSkipReason = `auto_approve_failed:${approveJson?.statusDescription ?? approveJson?.message ?? approveStatus}`;
            }
          }
        }

        await supabase
          .from("checkalt_deposits")
          .update({
            checkalt_reference: reference ?? null,
            status: internalStatus,
            submitted_at: statusIso,
            last_status_payload: {
              ...submitJson,
              _auto_approve: autoApprovePayload
                ? { approved: true, response: autoApprovePayload }
                : autoApproveSkipReason
                  ? { approved: false, skip_reason: autoApproveSkipReason }
                  : undefined,
            },
            approved_at: autoApprovePayload ? statusIso : null,
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

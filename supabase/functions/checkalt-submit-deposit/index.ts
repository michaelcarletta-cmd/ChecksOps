// CheckAlt RDC submission — sends check images to FinCapture for deposit.
// Pulls front/back check images from storage, base64-encodes, POSTs to
// /fincapture/deposit/process per the Clearingworks FinCapture API spec.
//
// Returns the CheckAlt reference number and writes a checkalt_deposits row.
// Live traffic only happens once CHECKALT_USERNAME/PASSWORD + base_url + merchant
// + fi_key are configured.

import { corsHeaders } from "https://esm.sh/@supabase/supabase-js@2/cors";
import { z } from "https://esm.sh/zod@3.23.8";
import {
  getServiceClient,
  loadConfig,
  checkAltFetch,
} from "../_shared/checkalt.ts";

let imageScriptPromise: Promise<any> | null = null;
async function loadImageScript(): Promise<any> {
  if (!imageScriptPromise) {
    imageScriptPromise = import("https://deno.land/x/imagescript@1.2.17/mod.ts");
  }
  return imageScriptPromise;
}

let svgRenderPromise: Promise<((svg: string) => Promise<Uint8Array>) | null> | null = null;
async function loadSvgRenderer(): Promise<((svg: string) => Promise<Uint8Array>) | null> {
  if (!svgRenderPromise) {
    svgRenderPromise = import("https://deno.land/x/resvg_wasm@0.2.0/mod.ts")
      .then((mod) => mod.render as (svg: string) => Promise<Uint8Array>)
      .catch((e) => {
        console.warn("[checkalt-submit-deposit] SVG renderer unavailable", e);
        return null;
      });
  }
  return svgRenderPromise;
}

const MAX_CHECKALT_IMAGE_B64_CHARS = 4_000_000;
const MAX_CHECKALT_IMAGE_PIXELS = 2_400_000;

function normalizeAccountNumber(value: unknown): string {
  return String(value ?? "").replace(/\D/g, "");
}

function readVendorMessage(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const obj = payload as Record<string, unknown>;
  const message = obj.message ?? obj.error ?? obj.statusDescription;
  return typeof message === "string" && message.trim() ? message.trim() : null;
}

async function resolveDepositSsoKey(
  supabase: ReturnType<typeof getServiceClient>,
  fiKey: string,
  userId: string,
  depositAccountNumber: string,
): Promise<{ ssoKey: string; lookupPayload: unknown }> {
  const resp = await checkAltFetch(supabase, "/fincapture/useraccount/getUserAccountInformation", {
    method: "POST",
    body: JSON.stringify({
      fiKey,
      isSSORequest: true,
      userId,
    }),
  });
  const text = await resp.text();
  let json: unknown = {};
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }

  if (!resp.ok) {
    const vendorMsg = readVendorMessage(json) ?? text.slice(0, 300) ?? `HTTP ${resp.status}`;
    throw new Error(`CheckAlt user lookup failed [${resp.status}]: ${vendorMsg}`);
  }

  const accountDataList = Array.isArray((json as any)?.accountDataList)
    ? (json as any).accountDataList
    : [];
  const targetAccount = normalizeAccountNumber(depositAccountNumber);
  const matched = accountDataList.find(
    (acct: any) => normalizeAccountNumber(acct?.accountNumber) === targetAccount,
  ) ?? accountDataList[0];
  const ssoKey = matched?.ssoKey;
  if (typeof ssoKey !== "string" || !ssoKey.trim()) {
    throw new Error(
      "CheckAlt user is registered, but CheckAlt did not return the deposit ssoKey for this account. Re-register the tenant account, then try the deposit again.",
    );
  }

  return { ssoKey: ssoKey.trim(), lookupPayload: json };
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

function isSvgImage(path: string, contentType: string | null, bytes: Uint8Array): boolean {
  if (path.toLowerCase().endsWith(".svg") || contentType?.includes("svg")) return true;
  const head = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 256))).trimStart();
  return head.startsWith("<svg") || head.startsWith("<?xml");
}

async function normalizeImageForCheckAlt(
  bytes: Uint8Array,
  path: string,
  contentType: string | null,
  label: "front" | "back",
): Promise<string> {
  let working = bytes;

  if (isSvgImage(path, contentType, working)) {
    const render = await loadSvgRenderer();
    if (!render) throw new Error(`${label} image is SVG and could not be rasterized for CheckAlt`);
    const svg = new TextDecoder().decode(working);
    working = await render(svg);
    console.log(`[checkalt-submit-deposit] rasterized ${label} SVG ${bytes.length}B -> ${working.length}B PNG`);
  }

  let initialB64 = bytesToBase64(working);
  if (initialB64.length <= MAX_CHECKALT_IMAGE_B64_CHARS && !path.toLowerCase().endsWith(".png")) {
    return initialB64;
  }

  const lib = await loadImageScript();
  const decoded = await lib.Image.decode(working);
  const originalWidth = decoded.width;
  const originalHeight = decoded.height;
  const pixelCount = originalWidth * originalHeight;
  const ratio = pixelCount > MAX_CHECKALT_IMAGE_PIXELS
    ? Math.sqrt(MAX_CHECKALT_IMAGE_PIXELS / pixelCount)
    : 1;
  const targetWidth = Math.max(900, Math.floor(originalWidth * ratio));
  const targetHeight = Math.max(400, Math.floor(originalHeight * ratio));
  if (ratio < 1) decoded.resize(targetWidth, targetHeight);

  let bestBytes: Uint8Array | null = null;
  let bestB64 = initialB64;
  for (const quality of [82, 72, 62, 52, 42]) {
    const encoded = await decoded.clone().encodeJPEG(quality);
    const b64 = bytesToBase64(encoded);
    bestBytes = encoded;
    bestB64 = b64;
    if (b64.length <= MAX_CHECKALT_IMAGE_B64_CHARS) {
      console.log(
        `[checkalt-submit-deposit] normalized ${label} ${originalWidth}x${originalHeight} ${bytes.length}B -> ${decoded.width}x${decoded.height} ${encoded.length}B JPEG q${quality}`,
      );
      return b64;
    }
  }

  const finalLength = bestBytes?.length ?? working.length;
  console.warn(
    `[checkalt-submit-deposit] ${label} image still large after compression: ${bestB64.length} base64 chars (${finalLength}B raw)`,
  );
  return bestB64;
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
        throw new Error(`Image download failed: ${error?.message}`);
      const bytes = new Uint8Array(await data.arrayBuffer());
      return await normalizeImageForCheckAlt(bytes, path, data.type || null, label);
    };
    const frontB64 = await downloadAsB64(check.front_image_path, "front");
    const backB64 = await downloadAsB64(check.back_image_path, "back");

    if (!frontB64)
      throw new Error("Front image required for CheckAlt submission");

    const estimatedPayloadSize = frontB64.length + (backB64?.length ?? 0);
    if (estimatedPayloadSize > 8_800_000) {
      throw new Error(`Check images are still too large for CheckAlt after compression (${estimatedPayloadSize} bytes). Re-upload smaller front/back images.`);
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
    const { ssoKey: depositSsoKey, lookupPayload } = await resolveDepositSsoKey(
      supabase,
      cfg.fi_key,
      tenantAccount.sso_user_id,
      tenantAccount.deposit_account_number,
    );

    await supabase
      .from("checkalt_tenant_accounts")
      .update({ last_register_payload: lookupPayload })
      .eq("tenant_id", check.tenant_id);

    const submitResp = await checkAltFetch(
      supabase,
      "/fincapture/deposit/process",
      {
        method: "POST",
        body: JSON.stringify({
          fiKey: cfg.fi_key,
          ssoKey: depositSsoKey,
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

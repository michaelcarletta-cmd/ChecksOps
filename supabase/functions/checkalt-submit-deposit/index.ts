// CheckAlt RDC submission (Phase 1 skeleton).
// Pulls front/back check images from storage, base64-encodes, POSTs to FinCapture.
// Returns the CheckAlt reference ID and writes a checkalt_deposits row.
//
// Live traffic only happens once CHECKALT_USERNAME/PASSWORD + base_url are configured.

import { corsHeaders } from "https://esm.sh/@supabase/supabase-js@2/cors";
import { z } from "https://esm.sh/zod@3.23.8";
import { getServiceClient, loadConfig, checkAltFetch } from "../_shared/checkalt.ts";

const BodySchema = z.object({
  check_intake_item_id: z.string().uuid(),
});

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    // --- auth ---
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

    // --- input ---
    const parsed = BodySchema.safeParse(await req.json());
    if (!parsed.success) {
      return new Response(JSON.stringify({ error: parsed.error.flatten().fieldErrors }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const { check_intake_item_id } = parsed.data;

    // --- gate: integration must be enabled ---
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

    // --- load check + images ---
    const { data: check, error: checkErr } = await supabase
      .from("check_intake_items")
      .select("id, tenant_id, amount, check_number, front_image_path, back_image_path, status")
      .eq("id", check_intake_item_id)
      .maybeSingle();
    if (checkErr || !check) throw new Error(checkErr?.message || "Check not found");

    const downloadAsB64 = async (path: string | null) => {
      if (!path) return null;
      const { data, error } = await supabase.storage.from("check-images").download(path);
      if (error || !data) throw new Error(`Image download failed: ${error?.message}`);
      const buf = new Uint8Array(await data.arrayBuffer());
      let binary = "";
      for (let i = 0; i < buf.length; i++) binary += String.fromCharCode(buf[i]);
      return btoa(binary);
    };
    const frontB64 = await downloadAsB64(check.front_image_path);
    const backB64 = await downloadAsB64(check.back_image_path);
    if (!frontB64) throw new Error("Front image required for CheckAlt submission");

    // --- create pending deposit row first (so we always have an audit anchor) ---
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

    // --- submit to FinCapture ---
    // Endpoint based on FinCapture Deposits → "Submit deposit transaction"
    // Field shape kept generic; refine once sandbox echoes back exact contract.
    const submitResp = await checkAltFetch(supabase, "/fincapture/deposits", {
      method: "POST",
      body: JSON.stringify({
        depositorAccountId: cfg.depositor_account_id,
        businessUnit: cfg.business_unit,
        amount: check.amount,
        checkNumber: check.check_number,
        frontImage: frontB64,
        backImage: backB64,
        externalReference: depositRow.id,
      }),
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
      submitJson?.reference ?? submitJson?.referenceId ?? submitJson?.depositReference ?? submitJson?.id;

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
      .update({ deposit_method: "checkalt", checkalt_deposit_id: depositRow.id })
      .eq("check_intake_item_id", check.id);

    return new Response(JSON.stringify({
      success: true,
      deposit_id: depositRow.id,
      checkalt_reference: reference ?? null,
    }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    console.error("[checkalt-submit-deposit]", msg);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

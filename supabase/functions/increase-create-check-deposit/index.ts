import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const apiKey = Deno.env.get("INCREASE_API_KEY");
    const baseUrl = Deno.env.get("INCREASE_BASE_URL") || "https://api.sandbox.increase.com";
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    if (!apiKey) throw new Error("INCREASE_API_KEY is not set");

    const supabase = createClient(supabaseUrl, supabaseServiceKey);
    const { check_intake_item_id, increase_account_id } = await req.json();

    if (!check_intake_item_id) throw new Error("check_intake_item_id is required");
    if (!increase_account_id) throw new Error("increase_account_id is required");

    // 1. Get check intake item
    const { data: check, error: checkErr } = await supabase
      .from("check_intake_items")
      .select("*")
      .eq("id", check_intake_item_id)
      .single();

    if (checkErr || !check) throw new Error(`Check not found: ${checkErr?.message}`);

    // 2. Verify front image exists
    if (!check.front_image_path) {
      throw new Error("Front check image is missing");
    }

    // 3. Verify back image exists
    if (!check.back_image_path) {
      throw new Error("Back check image is missing");
    }

    // 4. Verify endorsements are complete for multi-payee checks
    if (check.is_multi_payee) {
      const { data: endorsements, error: endErr } = await supabase
        .from("check_endorsements")
        .select("id, status")
        .eq("check_id", check_intake_item_id);

      if (endErr) throw new Error(`Failed to check endorsements: ${endErr.message}`);

      const pendingEndorsements = (endorsements ?? []).filter(
        (e: { status: string }) => e.status !== "signed" && e.status !== "waived"
      );

      if (pendingEndorsements.length > 0) {
        throw new Error(`${pendingEndorsements.length} endorsement(s) still pending. Complete all endorsements before depositing.`);
      }

      // Optionally verify endorsement packet exists
      if (!check.endorsement_packet_path) {
        console.warn("[INCREASE-CREATE-DEPOSIT] Multi-payee check missing endorsement packet, proceeding anyway");
      }
    }

    // 5. Check amount
    if (!check.amount || check.amount <= 0) {
      throw new Error("Check amount must be positive");
    }

    // 6. Check for duplicate submission
    const { data: existingDeposit } = await supabase
      .from("deposit_items")
      .select("id, increase_check_deposit_id")
      .eq("check_id", check_intake_item_id)
      .not("increase_check_deposit_id", "is", null)
      .maybeSingle();

    if (existingDeposit?.increase_check_deposit_id) {
      throw new Error(`Check already submitted to Increase: ${existingDeposit.increase_check_deposit_id}`);
    }

    // 7. Download front image from Supabase storage
    const frontImageData = await downloadImage(supabase, check.front_image_path);
    const backImageData = await downloadImage(supabase, check.back_image_path);

    // 8. Upload front image to Increase
    console.log("[INCREASE-CREATE-DEPOSIT] Uploading front image...");
    const frontFileId = await uploadFileToIncrease(baseUrl, apiKey, frontImageData, "check_image_front", "front.jpg");

    // 9. Upload back image to Increase
    console.log("[INCREASE-CREATE-DEPOSIT] Uploading back image...");
    const backFileId = await uploadFileToIncrease(baseUrl, apiKey, backImageData, "check_image_back", "back.jpg");

    // 10. Create check deposit on Increase
    const amountCents = Math.round(check.amount * 100);
    const description = `Darwin Check #${check.check_number || "unknown"} — ${check.carrier_name || ""}`.slice(0, 200);

    console.log(`[INCREASE-CREATE-DEPOSIT] Creating deposit: $${check.amount} (${amountCents} cents) into ${increase_account_id}`);

    const depositResp = await fetch(`${baseUrl}/check_deposits`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        account_id: increase_account_id,
        amount: amountCents,
        front_image_file_id: frontFileId,
        back_image_file_id: backFileId,
        description,
      }),
    });

    if (!depositResp.ok) {
      const errText = await depositResp.text();
      throw new Error(`Increase API error ${depositResp.status}: ${errText}`);
    }

    const deposit = await depositResp.json();
    console.log(`[INCREASE-CREATE-DEPOSIT] Created: ${deposit.id} status=${deposit.status}`);

    // 11. Upsert deposit_items row
    const { data: existingItem } = await supabase
      .from("deposit_items")
      .select("id")
      .eq("check_id", check_intake_item_id)
      .maybeSingle();

    const depositItemUpdate = {
      increase_account_id: increase_account_id,
      increase_check_deposit_id: deposit.id,
      increase_status: deposit.status,
      increase_submitted_at: new Date().toISOString(),
      increase_last_synced_at: new Date().toISOString(),
      increase_raw_response: deposit,
      provider: "increase",
      provider_reference: deposit.id,
      status: "submitted",
      submitted_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    if (existingItem) {
      await supabase
        .from("deposit_items")
        .update(depositItemUpdate)
        .eq("id", existingItem.id);
    } else {
      await supabase
        .from("deposit_items")
        .insert({
          check_id: check_intake_item_id,
          amount: check.amount,
          check_number: check.check_number,
          carrier_name: check.carrier_name,
          claim_id: check.claim_id,
          ...depositItemUpdate,
        });
    }

    // 12. Update check status
    await supabase
      .from("check_intake_items")
      .update({ status: "deposited", updated_at: new Date().toISOString() })
      .eq("id", check_intake_item_id);

    return new Response(JSON.stringify({
      success: true,
      increase_check_deposit_id: deposit.id,
      increase_status: deposit.status,
      amount_cents: amountCents,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    console.error(`[INCREASE-CREATE-DEPOSIT] ERROR: ${msg}`);
    return new Response(JSON.stringify({ success: false, error: msg }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

async function downloadImage(supabase: ReturnType<typeof createClient>, path: string): Promise<Uint8Array> {
  // Check images are uploaded to claim-files bucket in CheckCommandCenter
  const { data, error } = await supabase.storage.from("claim-files").download(path);
  if (error || !data) {
    throw new Error(`Could not download image from claim-files: ${path} — ${error?.message}`);
  }
  return new Uint8Array(await data.arrayBuffer());
}

async function uploadFileToIncrease(
  baseUrl: string,
  apiKey: string,
  fileData: Uint8Array,
  purpose: string,
  filename: string
): Promise<string> {
  const formData = new FormData();
  formData.append("file", new Blob([fileData], { type: "image/jpeg" }), filename);
  formData.append("purpose", purpose);

  const resp = await fetch(`${baseUrl}/files`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
    },
    body: formData,
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Failed to upload ${purpose}: ${resp.status} ${errText}`);
  }

  const file = await resp.json();
  return file.id;
}

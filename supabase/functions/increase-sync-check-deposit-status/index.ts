import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Map Increase statuses to Darwin deposit_item_status
function mapIncreaseStatus(increaseStatus: string): {
  darwinStatus: string;
  checkStatus?: string;
} {
  switch (increaseStatus) {
    case "pending":
      return { darwinStatus: "submitted" };
    case "submitted":
      return { darwinStatus: "processing" };
    case "rejected":
      return { darwinStatus: "failed" };
    case "returned":
      return { darwinStatus: "returned", checkStatus: "needs_review" };
    default:
      // For any other status (including future ones), keep as processing
      return { darwinStatus: "processing" };
  }
}

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
    const body = await req.json().catch(() => ({}));
    const { deposit_item_id, increase_check_deposit_id } = body;

    // If specific ID provided, sync just that one
    if (deposit_item_id || increase_check_deposit_id) {
      const result = await syncSingleDeposit(supabase, baseUrl, apiKey, deposit_item_id, increase_check_deposit_id);
      return new Response(JSON.stringify(result), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Otherwise sync all active Increase deposits
    const { data: activeDeposits, error } = await supabase
      .from("deposit_items")
      .select("id, increase_check_deposit_id, increase_status, status")
      .eq("provider", "increase")
      .not("increase_check_deposit_id", "is", null)
      .in("status", ["submitted", "processing"]);

    if (error) throw new Error(`Failed to fetch deposits: ${error.message}`);

    const results = [];
    for (const dep of activeDeposits ?? []) {
      try {
        const result = await syncSingleDeposit(supabase, baseUrl, apiKey, dep.id, dep.increase_check_deposit_id);
        results.push(result);
      } catch (e) {
        results.push({ deposit_item_id: dep.id, success: false, error: (e as Error).message });
      }
    }

    return new Response(JSON.stringify({ success: true, synced: results.length, results }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    console.error(`[INCREASE-SYNC] ERROR: ${msg}`);
    return new Response(JSON.stringify({ success: false, error: msg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

async function syncSingleDeposit(
  supabase: ReturnType<typeof createClient>,
  baseUrl: string,
  apiKey: string,
  depositItemId?: string,
  increaseDepositId?: string,
) {
  // Look up the deposit item if needed
  let itemId = depositItemId;
  let incId = increaseDepositId;

  if (itemId && !incId) {
    const { data } = await supabase
      .from("deposit_items")
      .select("increase_check_deposit_id")
      .eq("id", itemId)
      .single();
    incId = data?.increase_check_deposit_id;
  }

  if (!incId) throw new Error("No Increase deposit ID found");

  // Fetch from Increase
  const resp = await fetch(`${baseUrl}/check_deposits/${incId}`, {
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Increase API error ${resp.status}: ${errText}`);
  }

  const deposit = await resp.json();
  const { darwinStatus, checkStatus } = mapIncreaseStatus(deposit.status);

  console.log(`[INCREASE-SYNC] ${incId}: ${deposit.status} → Darwin ${darwinStatus}`);

  // Build update
  const update: Record<string, unknown> = {
    increase_status: deposit.status,
    increase_last_synced_at: new Date().toISOString(),
    increase_raw_response: deposit,
    status: darwinStatus,
    updated_at: new Date().toISOString(),
  };

  // Handle rejection
  if (deposit.status === "rejected" && deposit.deposit_rejection) {
    update.exception_reason = deposit.deposit_rejection.reason || "Rejected by Increase";
    update.exception_code = "INCREASE_REJECTED";
  }

  // Handle return
  if (deposit.status === "returned" && deposit.deposit_return) {
    update.return_reason = deposit.deposit_return.reason || "Returned after deposit";
    update.exception_reason = deposit.deposit_return.reason;
    update.exception_code = "INCREASE_RETURNED";
  }

  // Handle acceptance (deposit went through)
  if (deposit.deposit_acceptance) {
    update.status = "succeeded";
    update.cleared_at = new Date().toISOString();
    update.provider_reference = deposit.id;
    if (deposit.transaction_id) {
      update.bank_reference = deposit.transaction_id;
    }
  }

  // Update deposit_items
  const query = itemId
    ? supabase.from("deposit_items").update(update).eq("id", itemId)
    : supabase.from("deposit_items").update(update).eq("increase_check_deposit_id", incId);

  const { error: updateErr } = await query;
  if (updateErr) throw new Error(`Failed to update deposit: ${updateErr.message}`);

  // Get the check_id from deposit_items for cross-record sync
  const lookupQuery = itemId
    ? supabase.from("deposit_items").select("check_id").eq("id", itemId).single()
    : supabase.from("deposit_items").select("check_id").eq("increase_check_deposit_id", incId).single();

  const { data: depositItem } = await lookupQuery;

  if (depositItem?.check_id) {
    // Sync check_intake_items status based on Increase lifecycle
    let checkStatus: string | null = null;
    if (deposit.deposit_acceptance) {
      checkStatus = "deposited";
    } else if (deposit.status === "rejected") {
      checkStatus = "needs_review";
    } else if (deposit.status === "returned") {
      checkStatus = "needs_review";
    }

    if (checkStatus) {
      await supabase
        .from("check_intake_items")
        .update({ status: checkStatus, updated_at: new Date().toISOString() })
        .eq("id", depositItem.check_id);
    }
  }

  return {
    success: true,
    deposit_item_id: itemId,
    increase_status: deposit.status,
    darwin_status: update.status,
    has_acceptance: !!deposit.deposit_acceptance,
    has_rejection: !!deposit.deposit_rejection,
    has_return: !!deposit.deposit_return,
  };
}

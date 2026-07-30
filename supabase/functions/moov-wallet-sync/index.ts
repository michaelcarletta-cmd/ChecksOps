import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, json, isResponse, requireMoovCaller } from "../_shared/moovGuard.ts";
import { readWallet, syncWallet } from "../_shared/moovWallet.ts";

// Provisions (if needed) and refreshes a tenant's wallet balance from the
// provider, then returns the wallet with its recent ledger.
//
// Wallets are per-tenant. `trust` wallets are used for attorney/IOLTA style
// accounts, where every matter has its own sub-ledger that can never go
// negative.

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = await req.json().catch(() => ({}));
    const { tenant_id, wallet_type = "operating", ledger_limit = 50 } = body ?? {};
    if (!tenant_id) return json({ error: "tenant_id is required" }, 400);
    if (!["operating", "trust"].includes(wallet_type)) {
      return json({ error: "wallet_type must be 'operating' or 'trust'" }, 400);
    }

    const caller = await requireMoovCaller(req, tenant_id);
    if (isResponse(caller)) return caller;
    const { supabase, environment } = caller;

    const { data: account } = await supabase
      .from("payment_provider_accounts")
      .select("provider_account_id, onboarding_status")
      .eq("tenant_id", tenant_id)
      .eq("provider", "moov")
      .eq("environment", environment)
      .maybeSingle();

    if (!account?.provider_account_id) {
      return json({ error: "Set up your payment account first." }, 409);
    }

    let wallet;
    try {
      wallet = await syncWallet(supabase, {
        tenantId: tenant_id,
        accountId: account.provider_account_id,
        environment,
        walletType: wallet_type,
      });
    } catch (e) {
      // Fall back to the last known local state so the UI still renders.
      const local = await readWallet(supabase, tenant_id, environment, wallet_type);
      if (!local) return json({ error: (e as Error).message }, 502);
      wallet = local;
    }

    const { data: ledger } = await supabase
      .from("payment_wallet_ledger")
      .select("*")
      .eq("wallet_id", wallet.id)
      .order("created_at", { ascending: false })
      .limit(Math.min(Number(ledger_limit) || 50, 200));

    const { data: subLedgers } = await supabase
      .from("payment_wallet_sub_ledgers")
      .select("*")
      .eq("wallet_id", wallet.id)
      .order("created_at", { ascending: false });

    return json({ success: true, wallet, ledger: ledger ?? [], sub_ledgers: subLedgers ?? [] });
  } catch (e) {
    console.error("[moov-wallet-sync]", (e as Error).message);
    return json({ error: (e as Error).message }, 500);
  }
});

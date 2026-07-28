import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { callPlaid } from "../_shared/plaidClient.ts";
import { moovFetch, scopes, safeLastFour } from "../_shared/moovClient.ts";
import { corsHeaders, json, isResponse, requireMoovCaller, logPaymentEvent } from "../_shared/moovGuard.ts";

/**
 * One-click bridge: attaches an ALREADY Plaid-linked bank to the tenant's Moov
 * account using a Plaid processor token, so the org never re-enters bank details.
 *
 * Nothing about the Plaid or Actum rails changes — the Plaid item keeps working
 * exactly as before; we only mint an additional processor token for Moov.
 * Raw account/routing numbers are never read or stored here.
 */

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { tenant_id, stakeholder_account_id } = await req.json();
    if (!tenant_id) return json({ error: "tenant_id is required" }, 400);

    const caller = await requireMoovCaller(req, tenant_id, { requireAdmin: true });
    if (isResponse(caller)) return caller;
    const { supabase, environment } = caller;

    // --- Moov account must exist -----------------------------------------
    const { data: acct } = await supabase
      .from("payment_provider_accounts")
      .select("id, provider_account_id")
      .eq("tenant_id", tenant_id)
      .eq("provider", "moov")
      .eq("environment", environment)
      .maybeSingle();

    const moovAccountId = (acct as any)?.provider_account_id as string | undefined;
    if (!moovAccountId) {
      return json({ error: "Set up the payment account first." }, 409);
    }

    // --- Find the Plaid-verified bank on this tenant ----------------------
    let q = supabase
      .from("stakeholder_accounts")
      .select("id, nickname, plaid_access_token, plaid_account_id, plaid_institution_name, plaid_account_mask")
      .eq("tenant_id", tenant_id)
      .eq("verification_source", "plaid")
      .not("plaid_access_token", "is", null)
      .order("verified_at", { ascending: false })
      .limit(1);
    if (stakeholder_account_id) q = q.eq("id", stakeholder_account_id);

    const { data: rows, error: rowsErr } = await q;
    if (rowsErr) throw new Error(rowsErr.message);
    const bank = rows?.[0] as any;

    if (!bank?.plaid_access_token || !bank?.plaid_account_id) {
      return json(
        { error: "No connected bank was found to bridge. Link a bank account first." },
        409,
      );
    }

    // --- Mint a Moov processor token from the existing Plaid item ---------
    const processor = await callPlaid<{ processor_token: string }>(
      "/processor/token/create",
      {
        access_token: bank.plaid_access_token,
        account_id: bank.plaid_account_id,
        processor: "moov",
      },
    );

    // --- Attach the bank to the tenant's Moov account ---------------------
    let created: any;
    try {
      created = await moovFetch<any>(`/accounts/${moovAccountId}/bank-accounts`, {
        method: "POST",
        scopes: scopes.bankAccountsWrite(moovAccountId),
        body: { plaid: { token: processor.processor_token } },
      });
    } catch (_e) {
      // Older payload shape accepted by Moov.
      created = await moovFetch<any>(`/accounts/${moovAccountId}/bank-accounts`, {
        method: "POST",
        scopes: scopes.bankAccountsWrite(moovAccountId),
        body: { plaidToken: processor.processor_token },
      });
    }

    const bankName = created?.bankName ?? bank.plaid_institution_name ?? null;
    const lastFour = safeLastFour(created?.lastFourAccountNumber) ?? bank.plaid_account_mask ?? null;
    const status = (created?.status ?? "pending").toLowerCase();

    await supabase
      .from("payment_provider_accounts")
      .update({ last_synced_at: new Date().toISOString() })
      .eq("id", (acct as any).id);


    await logPaymentEvent(supabase, {
      tenant_id,
      event_type: "bank_bridged_from_plaid",
      new_status: status,
      environment,
      provider_metadata: { bankName, lastFour, source: "plaid_processor_token" },
    });

    return json({
      success: true,
      bank_name: bankName,
      last_four: lastFour,
      status,
    });
  } catch (e) {
    console.error("[moov-plaid-bridge]", (e as Error).message);
    return json({ error: (e as Error).message }, 500);
  }
});

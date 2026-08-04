import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, json, isResponse, requireMoovCaller } from "../_shared/moovGuard.ts";
import { bridgePlaidBankToMoov, BridgeError } from "../_shared/moovPlaidBridge.ts";

/**
 * One-click bridge from an EXISTING Plaid-linked bank to Moov.
 *
 * Two modes, both driven off a `stakeholder_accounts` row that already holds a
 * Plaid item — nobody re-enters bank details, and raw account/routing numbers
 * are never read or stored:
 *
 *   "tenant"    — attaches the organization's own funding bank to its Moov
 *                 account (admin only). This is the payer side.
 *   "recipient" — a homeowner / sub / one-time payee who linked their bank via
 *                 Plaid. We create (or reuse) their Moov recipient account and
 *                 attach that same bank, so they become payable on the Moov
 *                 rail without a second setup link.
 *
 * The actual work lives in `_shared/moovPlaidBridge.ts`, which `plaid-exchange`
 * also runs automatically right after a new Plaid Link session, so both paths
 * behave identically. The Plaid and Actum rails are untouched.
 */
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { tenant_id, stakeholder_account_id, mode } = await req.json();
    if (!tenant_id) return json({ error: "tenant_id is required" }, 400);

    // The recipient path is a normal day-to-day action for anyone working the
    // check; only the org's own funding bank is admin-gated.
    const isRecipientMode = mode === "recipient";
    const caller = await requireMoovCaller(req, tenant_id, { requireAdmin: !isRecipientMode });
    if (isResponse(caller)) return caller;
    const { supabase, environment, userId } = caller;

    const result = await bridgePlaidBankToMoov({
      supabase,
      tenantId: tenant_id,
      environment,
      mode: isRecipientMode ? "recipient" : "tenant",
      stakeholderAccountId: stakeholder_account_id ?? null,
      userId,
    });

    return json({ success: true, ...result });
  } catch (e) {
    if (e instanceof BridgeError) return json({ error: e.message }, e.status);
    console.error("[moov-plaid-bridge]", (e as Error).message);
    return json({ error: (e as Error).message }, 500);
  }
});

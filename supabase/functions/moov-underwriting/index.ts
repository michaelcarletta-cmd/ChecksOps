import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { moovFetch, scopes } from "../_shared/moovClient.ts";
import { corsHeaders, json, isResponse, logPaymentEvent, requireMoovCaller } from "../_shared/moovGuard.ts";

// Underwriting questionnaire for a tenant's own connected payment account.
//
// The provider asks a short set of expected-activity questions before an
// account may move money. ChecksOps collects the answers in-app and writes
// them straight to the provider, so the tenant never has to leave the product.

const num = (v: unknown, max = 100_000_000) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.min(Math.round(n), max);
};

const pct = (v: unknown) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(100, Math.round(n));
};

/** Dollars in the UI, cents at the provider. */
const cents = (v: unknown) => {
  const n = num(v);
  return n === null ? null : n * 100;
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const payload = await req.json().catch(() => ({}));
    const tenant_id = typeof payload?.tenant_id === "string" ? payload.tenant_id : "";
    if (!tenant_id) return json({ error: "tenant_id is required" }, 400);

    const caller = await requireMoovCaller(req, tenant_id, { requireAdmin: true });
    if (isResponse(caller)) return caller;
    const { supabase, environment, userId } = caller;

    const { data: account } = await supabase
      .from("payment_provider_accounts")
      .select("id, provider_account_id")
      .eq("tenant_id", tenant_id)
      .eq("provider", "moov")
      .eq("environment", environment)
      .maybeSingle();

    const accountId = (account as any)?.provider_account_id as string | undefined;
    if (!accountId) return json({ error: "Set up the payment account first." }, 409);

    /* ---------------- read current answers ---------------- */
    if (payload?.action !== "save") {
      const current = await moovFetch<any>(`/accounts/${accountId}/underwriting`, {
        scopes: scopes.accountRead(accountId),
      }).catch(() => null);
      return json({ success: true, underwriting: current ?? null });
    }

    /* ---------------- save answers ---------------- */
    const a = payload?.answers ?? {};

    const averageTransactionSize = cents(a.averageTransactionSize);
    const maxTransactionSize = cents(a.maxTransactionSize);
    const averageMonthlyTransactionVolume = cents(a.averageMonthlyTransactionVolume);

    if (!averageTransactionSize || !maxTransactionSize || !averageMonthlyTransactionVolume) {
      return json({ error: "Enter your average payment, largest payment and monthly volume." }, 400);
    }
    if (maxTransactionSize < averageTransactionSize) {
      return json({ error: "The largest payment can't be smaller than the average payment." }, 400);
    }

    const b2b = pct(a.businessToBusinessPercentage);
    const c2b = pct(a.consumerToBusinessPercentage ?? a.businessToConsumerPercentage);
    if (b2b + c2b !== 100) {
      return json({ error: "Business and consumer percentages must add up to 100." }, 400);
    }

    const body = {
      averageTransactionSize,
      maxTransactionSize,
      averageMonthlyTransactionVolume,
      volumeByCustomerType: {
        businessToBusinessPercentage: b2b,
        consumerToBusinessPercentage: c2b,
      },
      fulfillment: {
        hasPhysicalGoods: !!a.hasPhysicalGoods,
        isShippingProduct: !!a.isShippingProduct,
        shipmentDurationDays: num(a.shipmentDurationDays, 365) ?? 0,
        returnPolicy: typeof a.returnPolicy === "string" && a.returnPolicy ? a.returnPolicy : "none",
      },
    };

    let saved: any = null;
    try {
      saved = await moovFetch(`/accounts/${accountId}/underwriting`, {
        method: "PUT",
        scopes: scopes.accountWrite(accountId),
        body,
      });
    } catch (e) {
      const msg = (e as Error).message ?? "";
      // Some account states only accept the create verb.
      saved = await moovFetch(`/accounts/${accountId}/underwriting`, {
        method: "POST",
        scopes: scopes.accountWrite(accountId),
        body,
      }).catch(() => {
        throw new Error(msg || "The payment provider rejected these answers.");
      });
    }

    await supabase
      .from("payment_provider_accounts")
      .update({ last_synced_at: new Date().toISOString() })
      .eq("id", (account as any).id);

    await logPaymentEvent(supabase, {
      tenant_id,
      event_type: "payment_account.underwriting_submitted",
      environment,
      provider_metadata: { account_id: accountId, submitted_by: userId },
    });

    return json({ success: true, underwriting: saved ?? body });
  } catch (e) {
    const msg = (e as Error).message ?? "Request failed";
    console.error("[moov-underwriting]", msg);
    return json({ error: msg }, 502);
  }
});

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { moovFetch, scopes } from "../_shared/moovClient.ts";
import { evaluateReadiness, type CapabilityLike } from "../_shared/moovReadiness.ts";
import { corsHeaders, json, isResponse, requireMoovCaller, sanitize } from "../_shared/moovGuard.ts";
import { persistVerifiedPayees, resolveLiveReadAccount } from "../_shared/preferProductionMoov.ts";

/**
 * Server-side money-movement readiness check.
 *
 * Read-only: it never creates accounts, never enables capabilities, and never
 * moves money. It reports exactly what the provider says about this tenant so
 * the UI can show Ready / Pending / Action required before any disbursement.
 */

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = await req.json().catch(() => ({}));
    const tenant_id = body?.tenant_id;
    if (!tenant_id) return json({ error: "tenant_id is required" }, 400);

    const caller = await requireMoovCaller(req, tenant_id);
    if (isResponse(caller)) return caller;
    const { supabase } = caller;
    const resolved = await resolveLiveReadAccount(supabase, tenant_id, caller.environment);
    const environment = resolved.environment;
    const account = resolved.account;
    const accountId = resolved.accountId;

    if (!accountId) {
      const result = evaluateReadiness({
        environment,
        accountId: null,
        capabilities: [],
        banks: [],
        termsAccepted: false,
      });
      return json({ success: true, readiness: result });
    }

    // Live provider state — never trust a stale local column for readiness.
    const remote = await moovFetch<any>(`/accounts/${accountId}`, {
      scopes: scopes.accountRead(accountId),
    }).catch(() => null);

    const caps = await moovFetch<any[]>(`/accounts/${accountId}/capabilities`, {
      scopes: scopes.capabilitiesRead(accountId),
    }).catch(() => [] as any[]);

    const capList: CapabilityLike[] = (caps ?? []).map((c: any) => ({
      capability: c.capability,
      status: c.status,
      requirements: c.requirements ?? null,
    }));

    const banks = await moovFetch<any[]>(`/accounts/${accountId}/bank-accounts`, {
      scopes: scopes.bankAccountsRead(accountId),
    }).catch(() => [] as any[]);

    // Fee plans are provisioned by the payment provider, not self-serve.
    // A missing plan is reported, never treated as a hard failure.
    let feePlanCode: string | null = null;
    let feePlanUnavailable = false;
    try {
      const plans = await moovFetch<any>(`/accounts/${accountId}/fee-plans`, {
        scopes: scopes.accountWrite(accountId),
      });
      const list = Array.isArray(plans) ? plans : plans?.feePlans ?? [];
      const code = list.map((p: any) => p?.planCode ?? p?.code).find((c: unknown) => typeof c === "string");
      feePlanCode = (code as string) ?? null;
      feePlanUnavailable = !feePlanCode;
    } catch {
      feePlanUnavailable = true;
    }

    const remoteTos =
      remote?.termsOfService?.acceptedOn ??
      remote?.termsOfService?.acceptedDate ??
      remote?.termsOfServiceAcceptedOn ??
      null;
    const termsAccepted = !!(account?.tos_accepted_at || remoteTos);

    const verificationStatus =
      remote?.profile?.business?.verification?.status
      ?? remote?.profile?.individual?.verification?.status
      ?? remote?.verification?.status
      ?? null;

    const readiness = evaluateReadiness({
      environment,
      accountId,
      capabilities: capList,
      banks: (banks ?? []).map((b: any) => ({ status: b.status })),
      verificationStatus,
      disabled: !!remote?.disabledOn,
      termsAccepted,
      feePlanCode,
      feePlanUnavailable,
    });
    (readiness as any).source = "live_provider";
    (readiness as any).liveProviderCalled = true;
    (readiness as any).isSandbox = environment !== "production";

    if (account?.id) {
      await supabase
        .from("payment_provider_accounts")
        .update({
          readiness: sanitize(readiness) as unknown as Record<string, unknown>,
          readiness_checked_at: new Date().toISOString(),
          fee_plan_code: feePlanCode,
          fee_plan_status: feePlanCode ? "assigned" : feePlanUnavailable ? "provider_managed" : "unknown",
          verification_status: verificationStatus || account.verification_status,
          onboarding_status: verificationStatus === "verified" ? "active" : account.onboarding_status,
          ...(remoteTos && !account?.tos_accepted_at
            ? { tos_accepted_at: remoteTos, tos_source: "hosted_onboarding" }
            : {}),
        })
        .eq("id", account.id);
    }

    const payees = environment === "production"
      ? await persistVerifiedPayees(supabase, tenant_id).catch(() => [])
      : [];

    return json({ success: true, readiness, payees, liveProviderCalled: true });
  } catch (e) {
    console.error("[moov-readiness]", (e as Error).message);
    return json({ error: (e as Error).message }, 500);
  }
});

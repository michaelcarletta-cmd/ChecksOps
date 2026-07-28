import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { moovFetch, moovToken, moovHost, moovOrigin, moovEnvironment, moovConfigured, scopes } from "../_shared/moovClient.ts";
import { corsHeaders, json, isResponse, requireMoovCaller } from "../_shared/moovGuard.ts";

// Diagnostic-only: exercises each provider endpoint we depend on and reports
// pass/fail per step. No money moves, nothing is written to the database.
// Fee plans are intentionally NOT required here — onboarding invites are the
// only call that needs one, and that is deferred while we test.

type Step = { step: string; ok: boolean; status?: number; detail?: unknown };

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const steps: Step[] = [];
  const record = async (step: string, fn: () => Promise<unknown>) => {
    try {
      const detail = await fn();
      steps.push({ step, ok: true, detail });
      return detail;
    } catch (e) {
      const err = e as any;
      steps.push({ step, ok: false, status: err?.status, detail: err?.body ?? err?.message });
      return null;
    }
  };

  try {
    const { tenant_id } = await req.json().catch(() => ({ tenant_id: null }));
    if (!tenant_id) return json({ error: "tenant_id is required" }, 400);

    const caller = await requireMoovCaller(req, tenant_id, { requireAdmin: true });
    if (isResponse(caller)) return caller;
    const { supabase, environment } = caller;

    steps.push({
      step: "config",
      ok: moovConfigured(),
      detail: { environment: moovEnvironment(), host: moovHost(), origin: moovOrigin() },
    });

    // 1. OAuth — the gate everything else depends on.
    await record("oauth_token", async () => {
      const t = await moovToken(scopes.accountsWrite());
      return { token_length: t.length };
    });

    // 2. Platform account listing (needs /accounts.write on the key).
    await record("list_accounts", async () => {
      const res = await moovFetch<any>("/accounts", { method: "GET", scopes: scopes.accountsWrite() });
      const list = Array.isArray(res) ? res : res?.accounts ?? [];
      return { count: list.length, ids: list.map((a: any) => a?.accountID ?? a?.accountId).slice(0, 5) };
    });

    // 3. This tenant's connected account, if one exists yet.
    const { data: account } = await supabase
      .from("payment_provider_accounts")
      .select("provider_account_id, onboarding_status")
      .eq("tenant_id", tenant_id)
      .eq("provider", "moov")
      .eq("environment", environment)
      .maybeSingle();

    const accountId = account?.provider_account_id as string | undefined;
    steps.push({ step: "tenant_account", ok: !!accountId, detail: account ?? "not created yet" });

    if (accountId) {
      await record("account_read", () =>
        moovFetch(`/accounts/${accountId}`, { method: "GET", scopes: scopes.accountRead(accountId) }),
      );
      await record("capabilities_read", () =>
        moovFetch(`/accounts/${accountId}/capabilities`, {
          method: "GET",
          scopes: scopes.capabilitiesRead(accountId),
        }),
      );
      await record("bank_accounts_read", () =>
        moovFetch(`/accounts/${accountId}/bank-accounts`, {
          method: "GET",
          scopes: scopes.bankAccountsRead(accountId),
        }),
      );
      await record("payment_methods_read", () =>
        moovFetch(`/accounts/${accountId}/payment-methods`, {
          method: "GET",
          scopes: scopes.paymentMethodsRead(accountId),
        }),
      );
      await record("transfers_read", () =>
        moovFetch(`/accounts/${accountId}/transfers`, {
          method: "GET",
          scopes: scopes.transfersRead(accountId),
        }),
      );
      await record("bank_link_session_token", async () => {
        const t = await moovToken(scopes.dropBankLink(accountId));
        return { token_length: t.length };
      });
      await record("fee_plans_optional", () =>
        moovFetch(`/accounts/${accountId}/fee-plans`, {
          method: "GET",
          scopes: scopes.accountWrite(accountId),
        }),
      );
    }

    const failures = steps.filter((s) => !s.ok && s.step !== "fee_plans_optional" && s.step !== "tenant_account");
    return json({ success: failures.length === 0, environment, steps, failure_count: failures.length });
  } catch (e) {
    console.error("[moov-selftest]", (e as Error).message);
    return json({ error: (e as Error).message, steps }, 500);
  }
});

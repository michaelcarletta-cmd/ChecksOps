import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { moovFetch, moovHost, moovOrigin, scopes } from "../_shared/moovClient.ts";
import { corsHeaders, isResponse, json, requireMoovCaller } from "../_shared/moovGuard.ts";

// Diagnostic only. Moves no money: uses /transfer-options, which validates the
// same permissions a real transfer needs and returns the available rails.

type Step = { step: string; ok: boolean; status?: number; detail?: unknown };

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const steps: Step[] = [];
  const record = async (step: string, fn: () => Promise<unknown>) => {
    try {
      steps.push({ step, ok: true, detail: await fn() });
    } catch (e) {
      const err = e as any;
      steps.push({ step, ok: false, status: err?.status, detail: err?.body ?? err?.message });
    }
  };

  try {
    const { tenant_id, source_payment_method_id, destination_payment_method_id } = await req
      .json().catch(() => ({}));
    if (!tenant_id) return json({ error: "tenant_id is required" }, 400);

    const caller = await requireMoovCaller(req, tenant_id, { requireAdmin: true });
    if (isResponse(caller)) return caller;
    const { supabase, environment } = caller;

    const { data: payer } = await supabase
      .from("payment_provider_accounts").select("provider_account_id")
      .eq("tenant_id", tenant_id).eq("provider", "moov").eq("environment", environment)
      .maybeSingle();
    const accountId = payer?.provider_account_id as string | undefined;
    if (!accountId) return json({ error: "No payment account for this organization." }, 409);

    let facilitatorId: string | null = null;
    await record("list_accounts", async () => {
      const res = await moovFetch<any>("/accounts", { method: "GET", scopes: scopes.accountsRead() });
      const list = Array.isArray(res) ? res : res?.accounts ?? [];
      const ids = list.map((a: any) => a?.accountID ?? a?.accountId);
      facilitatorId = ids.find((id: string) => id !== accountId) ?? ids[0] ?? null;
      return { count: list.length, ids: ids.slice(0, 10), accountId, facilitatorId };
    });

    let methods: any[] = [];
    await record("payment_methods", async () => {
      const res = await moovFetch<any>(`/accounts/${accountId}/payment-methods`, {
        method: "GET",
        scopes: scopes.paymentMethodsRead(accountId),
      });
      methods = Array.isArray(res) ? res : [];
      return methods.map((m) => ({
        paymentMethodID: m.paymentMethodID,
        paymentMethodType: m.paymentMethodType,
        bankAccountStatus: m.bankAccount?.status,
        walletID: m.wallet?.walletID,
      }));
    });

    const src = source_payment_method_id ??
      methods.find((m) => m.paymentMethodType === "moov-wallet")?.paymentMethodID ??
      methods.find((m) => m.paymentMethodType === "ach-debit-fund")?.paymentMethodID;
    const dst = destination_payment_method_id ??
      methods.find((m) => m.paymentMethodType === "ach-credit-standard")?.paymentMethodID;

    steps.push({ step: "chosen_methods", ok: !!(src && dst), detail: { src, dst } });
    if (!src || !dst) return json({ steps }, 200);

    const body = {
      source: { paymentMethodID: src },
      destination: { paymentMethodID: dst },
      amount: { currency: "USD", value: 1 },
    };
    const bodyWithAccounts = {
      source: { accountID: accountId, paymentMethodID: src },
      destination: { accountID: accountId, paymentMethodID: dst },
      amount: { currency: "USD", value: 1 },
    };

    const variants: Array<{ name: string; scopes: string[]; onBehalfOf?: string }> = [
      { name: "account_scope_no_header", scopes: scopes.transfersWrite(accountId) },
      { name: "account_scope_with_header", scopes: scopes.transfersWrite(accountId), onBehalfOf: accountId },
    ];
    if (facilitatorId && facilitatorId !== accountId) {
      variants.push({
        name: "facilitator_scope",
        scopes: scopes.transfersWrite(facilitatorId),
        onBehalfOf: facilitatorId,
      });
      variants.push({
        name: "both_scopes",
        scopes: [...scopes.transfersWrite(facilitatorId), ...scopes.transfersWrite(accountId)],
        onBehalfOf: facilitatorId,
      });
    }

    // What the provider actually grants for each requested scope set.
    const rawToken = async (scopeList: string[]) => {
      const key = Deno.env.get("MOOV_PUBLIC_KEY")!;
      const secret = Deno.env.get("MOOV_SECRET_KEY")!;
      const res = await fetch(`${moovHost()}/oauth2/token`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${btoa(`${key}:${secret}`)}`,
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: moovOrigin(),
        },
        body: new URLSearchParams({ grant_type: "client_credentials", scope: scopeList.join(" ") }),
      });
      const body = await res.json().catch(() => null);
      return { status: res.status, granted: body?.scope ?? null, error: body?.error ?? null };
    };
    await record("granted_scope_account", () => rawToken(scopes.transfersWrite(accountId)));
    if (facilitatorId) {
      await record("granted_scope_facilitator", () => rawToken(scopes.transfersWrite(facilitatorId!)));
    }

    await record("live_transfer_0.01", () =>
      moovFetch<any>(`/accounts/${accountId}/transfers`, {
        method: "POST",
        scopes: scopes.transfersWrite(accountId),
        idempotencyKey: `checksops-probe-${accountId}-1`,
        onBehalfOf: accountId,
        body: {
          source: { paymentMethodID: src },
          destination: { paymentMethodID: dst },
          amount: { currency: "USD", value: 1 },
          description: "ChecksOps probe",
        },
      }));

    await record("opts_account_path_plain", () =>
      moovFetch<any>(`/accounts/${accountId}/transfer-options`, {
        method: "POST",
        scopes: scopes.transfersWrite(accountId),
        body,
      }));

    for (const combo of [
      { name: "acct_scope_no_header", path: `/accounts/${accountId}/transfers`, sc: scopes.transfersWrite(accountId), obo: undefined as string | undefined },
      { name: "acct_scope_facilitator_header", path: `/accounts/${accountId}/transfers`, sc: scopes.transfersWrite(accountId), obo: facilitatorId ?? undefined },
      { name: "facilitator_path", path: `/accounts/${facilitatorId}/transfers`, sc: scopes.transfersWrite(facilitatorId ?? accountId), obo: undefined },
      { name: "both_scopes_acct_path", path: `/accounts/${accountId}/transfers`, sc: [...scopes.transfersWrite(accountId), ...scopes.transfersWrite(facilitatorId ?? accountId)], obo: undefined },
    ]) {
      await record(`live2 ${combo.name}`, () =>
        moovFetch<any>(combo.path, {
          method: "POST",
          scopes: combo.sc,
          idempotencyKey: `checksops-probe2-${combo.name}`,
          onBehalfOf: combo.obo,
          body: {
            source: { paymentMethodID: src },
            destination: { paymentMethodID: dst },
            amount: { currency: "USD", value: 1 },
            description: "ChecksOps probe",
          },
        }));
    }

    const paths = ["/transfer-options", `/accounts/${accountId}/transfer-options`];
    for (const path of paths) {
      for (const apiVersion of ["v2024.01.00", "v2025.01.00", undefined]) {
        await record(`opts ${path} ${apiVersion ?? "default"}`, () =>
          moovFetch<any>(path, {
            method: "POST",
            scopes: scopes.transfersWrite(accountId),
            apiVersion,
            body: bodyWithAccounts,
          }));
      }
    }

    for (const v of variants) {
      await record(`transfer_options:${v.name}`, () =>
        moovFetch<any>("/transfer-options", {
          method: "POST",
          scopes: v.scopes,
          onBehalfOf: v.onBehalfOf,
          body,
        }));
      await record(`transfer_options_with_ids:${v.name}`, () =>
        moovFetch<any>("/transfer-options", {
          method: "POST",
          scopes: v.scopes,
          onBehalfOf: v.onBehalfOf,
          body: bodyWithAccounts,
        }));
    }

    return json({ accountId, facilitatorId, steps }, 200);
  } catch (e) {
    return json({ error: (e as Error).message, steps }, 500);
  }
});

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { moovFetch } from "../_shared/moovClient.ts";
import { corsHeaders, json, isResponse, requireMoovCaller } from "../_shared/moovGuard.ts";

// TEMPORARY diagnostic: tries the same $0.01 wallet funding transfer under a
// couple of account-scoping variants so we can see which one Moov accepts.
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const { tenant_id, source_method_id, dest_method_id, facilitator_id } = await req.json();
  const caller = await requireMoovCaller(req, tenant_id, { requireAdmin: true });
  if (isResponse(caller)) return caller;
  const { supabase, environment } = caller;

  const { data: account } = await supabase
    .from("payment_provider_accounts")
    .select("provider_account_id")
    .eq("tenant_id", tenant_id).eq("provider", "moov").eq("environment", environment)
    .maybeSingle();
  const accountId = account!.provider_account_id as string;

  const attempts: any[] = [];
  const body = {
    source: { paymentMethodID: source_method_id },
    destination: { paymentMethodID: dest_method_id },
    amount: { currency: "USD", value: 1 },
    description: "probe",
  };

  const variants: Array<{ name: string; path: string; scopeAcct: string; onBehalfOf?: string }> = [
    { name: "tenant_path_tenant_header", path: accountId, scopeAcct: accountId, onBehalfOf: accountId },
    { name: "tenant_path_no_header", path: accountId, scopeAcct: accountId },
  ];
  if (facilitator_id) {
    variants.push({ name: "facilitator_path", path: facilitator_id, scopeAcct: facilitator_id });
    variants.push({
      name: "facilitator_path_tenant_header",
      path: facilitator_id,
      scopeAcct: facilitator_id,
      onBehalfOf: accountId,
    });
  }

  for (const v of variants) {
    try {
      const res = await moovFetch<any>(`/accounts/${v.path}/transfers`, {
        method: "POST",
        scopes: [`/accounts/${v.scopeAcct}/transfers.write`],
        idempotencyKey: `probe-${v.name}-${Date.now()}`,
        onBehalfOf: v.onBehalfOf,
        body,
      });
      attempts.push({ variant: v.name, ok: true, transferID: res?.transferID, status: res?.status });
      break;
    } catch (e) {
      const err = e as any;
      attempts.push({ variant: v.name, ok: false, status: err?.status, body: err?.body ?? err?.message });
    }
  }

  return json({ accountId, attempts });
});

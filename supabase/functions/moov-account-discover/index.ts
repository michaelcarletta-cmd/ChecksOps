import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { moovFetch, scopes } from "../_shared/moovClient.ts";
import { corsHeaders, json, isResponse, requireMoovCaller } from "../_shared/moovGuard.ts";

/**
 * Reconciles ChecksOps with what actually exists at the payment provider.
 *
 * Onboarding is sometimes completed on a provider account that ChecksOps is not
 * pointed at (created directly in the provider dashboard, or a second account).
 * This function lists every account under the platform with its live
 * verification / capability / bank state so an administrator can pick the right
 * one, and — when `link_account_id` is supplied — repoints the organization at
 * that account so all readiness checks mirror the provider.
 *
 * Read-only unless `link_account_id` is provided. Never moves money.
 */

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = await req.json().catch(() => ({}));
    const tenant_id = body?.tenant_id;
    const link_account_id = (body?.link_account_id as string | undefined) ?? null;
    if (!tenant_id) return json({ error: "tenant_id is required" }, 400);

    const caller = await requireMoovCaller(req, tenant_id, { requireAdmin: true });
    if (isResponse(caller)) return caller;
    const { supabase, environment } = caller;

    const summarize = async (accountId: string) => {
      const [caps, banks] = await Promise.all([
        moovFetch<any[]>(`/accounts/${accountId}/capabilities`, {
          scopes: scopes.capabilitiesRead(accountId),
        }).catch(() => [] as any[]),
        moovFetch<any[]>(`/accounts/${accountId}/bank-accounts`, {
          scopes: scopes.bankAccountsRead(accountId),
        }).catch(() => [] as any[]),
      ]);
      return {
        capabilities: (caps ?? []).map((c: any) => ({ capability: c.capability, status: c.status })),
        banks: (banks ?? []).map((b: any) => ({
          bank_name: b.bankName ?? null,
          last_four: b.lastFourAccountNumber ?? null,
          status: b.status ?? null,
        })),
      };
    };

    /* ---------------- Link mode ---------------- */
    if (link_account_id) {
      const remote = await moovFetch<any>(`/accounts/${link_account_id}`, {
        scopes: scopes.accountRead(link_account_id),
      });
      if (!remote?.accountID && !remote?.accountId) {
        return json({ error: "That payment account could not be found." }, 404);
      }

      const { data: existing } = await supabase
        .from("payment_provider_accounts")
        .select("id")
        .eq("tenant_id", tenant_id)
        .eq("provider", "moov")
        .eq("environment", environment)
        .maybeSingle();

      if (existing?.id) {
        await supabase
          .from("payment_provider_accounts")
          .update({ provider_account_id: link_account_id, last_synced_at: null })
          .eq("id", existing.id);
      } else {
        await supabase.from("payment_provider_accounts").insert({
          tenant_id,
          provider: "moov",
          environment,
          provider_account_id: link_account_id,
          onboarding_status: "verification_pending",
        });
      }

      await supabase
        .from("tenants")
        .update({
          moov_account_id: link_account_id,
          // Clear the mirrored snapshot from the previous account so the UI
          // never shows stale bank/verification state until the next sync.
          bank_connection_status: "not_connected",
          bank_name: null,
          bank_last_four: null,
          last_sync: null,
        })
        .eq("id", tenant_id);

      return json({ success: true, linked_account_id: link_account_id });
    }

    /* ---------------- Discovery mode ---------------- */
    const accounts = await moovFetch<any[]>(`/accounts?count=200`, {
      scopes: scopes.accountsRead(),
    }).catch(() => [] as any[]);

    const { data: linkedRows } = await supabase
      .from("payment_provider_accounts")
      .select("tenant_id, provider_account_id")
      .eq("provider", "moov")
      .eq("environment", environment);
    const linkedBy = new Map<string, string>(
      (linkedRows ?? []).map((r: any) => [r.provider_account_id, r.tenant_id]),
    );

    const list = (accounts ?? []).slice(0, 50);
    const detailed = await Promise.all(
      list.map(async (a: any) => {
        const id = a.accountID ?? a.accountId;
        const extra = id ? await summarize(id) : { capabilities: [], banks: [] };
        return {
          account_id: id,
          display_name:
            a.displayName ??
            a.profile?.business?.legalBusinessName ??
            [a.profile?.individual?.name?.firstName, a.profile?.individual?.name?.lastName]
              .filter(Boolean)
              .join(" ") ??
            null,
          email: a.profile?.business?.email ?? a.profile?.individual?.email ?? null,
          account_type: a.accountType ?? null,
          verification_status:
            a.profile?.business?.verification?.status ?? a.verification?.status ?? null,
          terms_accepted_on: a.termsOfService?.acceptedOn ?? null,
          disabled: !!a.disabledOn,
          created_on: a.createdOn ?? null,
          linked_tenant_id: id ? linkedBy.get(id) ?? null : null,
          is_current: id === (linkedBy.has(id) ? id : null) && linkedBy.get(id) === tenant_id,
          ...extra,
        };
      }),
    );

    return json({ success: true, environment, accounts: detailed });
  } catch (e) {
    console.error("[moov-account-discover]", (e as Error).message);
    return json({ error: (e as Error).message }, 500);
  }
});

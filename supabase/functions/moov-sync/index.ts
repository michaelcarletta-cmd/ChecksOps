import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  capabilityFlags,
  moovFetch,
  normalizeOnboardingStatus,
  safeLastFour,
  scopes,
} from "../_shared/moovClient.ts";
import { fetchRailMethodIds, saveMethodRails } from "../_shared/moovRails.ts";
import { corsHeaders, json, isResponse, logPaymentEvent, requireMoovCaller, sanitize } from "../_shared/moovGuard.ts";

// Server-side capability + account + bank synchronization.
//
// The displayed status is always derived from the provider's live account and
// capability response — never from a stale local payment_status field.

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = await req.json().catch(() => ({}));
    const tenant_id = body?.tenant_id;
    if (!tenant_id) return json({ error: "tenant_id is required" }, 400);

    const caller = await requireMoovCaller(req, tenant_id);
    if (isResponse(caller)) return caller;
    const { supabase, environment } = caller;

    const { data: account } = await supabase
      .from("payment_provider_accounts")
      .select("*")
      .eq("tenant_id", tenant_id)
      .eq("provider", "moov")
      .eq("environment", environment)
      .maybeSingle();

    if (!account?.provider_account_id) {
      return json({ success: true, status: "not_started", account: account ?? null });
    }
    const accountId = account.provider_account_id as string;
    const previousStatus = account.onboarding_status as string;

    // 1. Account (verification state).
    const remote = await moovFetch<any>(`/accounts/${accountId}`, {
      scopes: scopes.accountRead(accountId),
    });

    // 2. Capabilities.
    const caps = await moovFetch<any[]>(`/accounts/${accountId}/capabilities`, {
      scopes: scopes.capabilitiesRead(accountId),
    }).catch(() => [] as any[]);

    const capList = (caps ?? []).map((c: any) => ({
      capability: c.capability,
      status: c.status,
      requirements: c.requirements ?? null,
    }));

    const flags = capabilityFlags(capList);
    const verificationStatus =
      remote?.profile?.business?.verification?.status ??
      remote?.verification?.status ??
      "not_started";

    const onboardingStatus = normalizeOnboardingStatus({
      verificationStatus,
      capabilities: capList,
      disabled: !!remote?.disabledOn,
    });

    const requirements = capList
      .flatMap((c) => c.requirements?.currentlyDue ?? [])
      .filter(Boolean);

    // 3. Bank accounts — safe metadata only.
    const banks = await moovFetch<any[]>(`/accounts/${accountId}/bank-accounts`, {
      scopes: scopes.bankAccountsRead(accountId),
    }).catch(() => [] as any[]);

    let bankName: string | null = null;
    let bankLastFour: string | null = null;
    let bankConnectionStatus = "not_connected";

    for (const b of banks ?? []) {
      const bankAccountId = b.bankAccountID ?? b.bankAccountId;
      if (!bankAccountId) continue;

      // Pull the verification object if it exists to see micro-deposit status.
      let verification = b.verification ?? null;
      if (!verification) {
        try {
          verification = await moovFetch<any>(
            `/accounts/${accountId}/bank-accounts/${bankAccountId}/verification`,
            { scopes: scopes.bankAccountsRead(accountId) },
          );
        } catch {
          /* no verification yet */
        }
      }

      const status = (verification?.status ?? b.status ?? "pending").toLowerCase();
      const lastFour = b.lastFourAccountNumber ?? safeLastFour(b.accountNumber);
      const connection = status === "verified" ? "connected" : status === "errored" ? "failed" : "pending";

      await supabase.from("payment_provider_methods").upsert(
        {
          tenant_id,
          external_recipient_id: null,
          provider: "moov",
          environment,
          provider_account_id: accountId,
          provider_bank_account_id: bankAccountId,
          bank_name: b.bankName ?? null,
          account_type: b.bankAccountType ?? null,
          last_four: lastFour ?? null,
          holder_name: b.holderName ?? null,
          verification_status: status,
          connection_status: connection,
          can_send: flags.can_ach_credit,
          can_receive: flags.can_receive_payments,
          connected_at: new Date().toISOString(),
          provider_metadata: sanitize(b),
        },
        { onConflict: "provider,environment,provider_account_id,provider_bank_account_id" },
      );

      // Rail eligibility (standard ACH / same-day ACH / RTP / card) for this bank.
      try {
        const rails = await fetchRailMethodIds(accountId, bankAccountId);
        if (Object.keys(rails).length > 0) {
          const { data: methodRow } = await supabase
            .from("payment_provider_methods")
            .select("id")
            .eq("provider", "moov")
            .eq("environment", environment)
            .eq("provider_account_id", accountId)
            .eq("provider_bank_account_id", bankAccountId)
            .maybeSingle();
          if (methodRow?.id) await saveMethodRails(supabase, methodRow.id, rails);
        }
      } catch (e) {
        console.warn("[moov-sync] rail sync skipped", bankAccountId, (e as Error).message);
      }

      if (status === "verified" || bankConnectionStatus === "not_connected") {
        bankName = b.bankName ?? bankName;
        bankLastFour = lastFour ?? bankLastFour;
        bankConnectionStatus = connection;
      }
    }

    // 4. Proactive Capability Requests.
    // If the account is being verified but doesn't have all standard capabilities,
    // we request them now to avoid manual retries later.
    const requiredCaps = ["send-funds.ach", "collect-funds.ach", "wallet.balance"];
    const missing = requiredCaps.filter(req => !capList.some(c => c.capability === req || c.capability === req.split(".")[0]));
    
    if (missing.length > 0 && verificationStatus !== "failed") {
      try {
        await moovFetch(`/accounts/${accountId}/capabilities`, {
          method: "POST",
          scopes: scopes.capabilitiesWrite(accountId),
          body: { capabilities: missing }
        });
        console.log(`[moov-sync] Requested missing capabilities: ${missing.join(", ")}`);
      } catch (e) {
        console.warn(`[moov-sync] Failed to request capabilities: ${(e as Error).message}`);
      }
    }

    const nowIso = new Date().toISOString();

    const { data: updated } = await supabase
      .from("payment_provider_accounts")
      .update({
        onboarding_status: onboardingStatus,
        verification_status: verificationStatus,
        capabilities: capList,
        requirements,
        restricted: flags.restricted,
        disabled: !!remote?.disabledOn,
        can_receive_payments: flags.can_receive_payments,
        can_send_payments: flags.can_send_payments,
        can_ach_debit: flags.can_ach_debit,
        can_ach_credit: flags.can_ach_credit,
        provider_metadata: sanitize(remote ?? {}),
        last_synced_at: nowIso,
      })
      .eq("id", account.id)
      .select()
      .single();

    // Mirror onto the provider-neutral tenant columns the UI already reads.
    await supabase
      .from("tenants")
      .update({
        payment_status: onboardingStatus === "active"
          ? "active"
          : onboardingStatus === "suspended"
          ? "suspended"
          : onboardingStatus === "additional_information_required" || onboardingStatus === "restricted"
          ? "verification_required"
          : "pending_verification",
        verification_status: verificationStatus === "verified" ? "verified" : "business_pending",
        bank_connection_status: bankConnectionStatus,
        bank_name: bankName,
        bank_last_four: bankLastFour,
        last_sync: nowIso,
      })
      .eq("id", tenant_id);

    if (previousStatus !== onboardingStatus) {
      await logPaymentEvent(supabase, {
        tenant_id,
        event_type: "payment_account.status_changed",
        previous_status: previousStatus,
        new_status: onboardingStatus,
        environment,
      });
    }

    return json({ success: true, status: onboardingStatus, account: updated, bank_count: (banks ?? []).length });
  } catch (e) {
    console.error("[moov-sync]", (e as Error).message);
    return json({ error: (e as Error).message }, 500);
  }
});

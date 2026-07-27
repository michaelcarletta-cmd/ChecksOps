import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { moovFetch, scopes } from "../_shared/moovClient.ts";
import { corsHeaders, json, isResponse, logPaymentEvent, requireMoovCaller, sanitize } from "../_shared/moovGuard.ts";

// Creates (once) the tenant's own connected Moov business account.
//
// ChecksOps is the platform; each tenant — public adjuster, contractor, roofer,
// restoration company — owns its own connected account. Freedom Adjustment is
// just another tenant here. There is no shared account for claim funds.
//
// Idempotent two ways: an existing provider account id short-circuits, and the
// Moov call carries a deterministic X-Idempotency-Key derived from tenant id.

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { tenant_id } = await req.json();
    if (!tenant_id) return json({ error: "tenant_id is required" }, 400);

    const caller = await requireMoovCaller(req, tenant_id, { requireAdmin: true });
    if (isResponse(caller)) return caller;
    const { supabase, environment, userId } = caller;

    // 1. Already have one? Return it. Never create a duplicate.
    const { data: existing } = await supabase
      .from("payment_provider_accounts")
      .select("*")
      .eq("tenant_id", tenant_id)
      .eq("provider", "moov")
      .eq("environment", environment)
      .maybeSingle();

    if (existing?.provider_account_id) {
      return json({ success: true, already_existed: true, account: existing });
    }

    const { data: tenant } = await supabase
      .from("tenants")
      .select("id, name, contact_email, contact_phone")
      .eq("id", tenant_id)
      .maybeSingle();
    if (!tenant) return json({ error: "Organization not found" }, 404);

    const idempotencyKey = `checksops-account-${environment}-${tenant_id}`;

    // 2. Reserve the idempotency record before calling out.
    const { error: idemErr } = await supabase.from("payment_idempotency_keys").insert({
      tenant_id,
      provider: "moov",
      scope: "account_create",
      idempotency_key: idempotencyKey,
      status: "in_progress",
    });
    if (idemErr && !idemErr.message.toLowerCase().includes("duplicate")) {
      console.error("[moov-account-create] idempotency insert", idemErr.message);
    }

    // 3. Create the connected account.
    const created = await moovFetch<any>("/accounts", {
      method: "POST",
      scopes: scopes.accountsWrite(),
      idempotencyKey,
      body: {
        accountType: "business",
        profile: {
          business: {
            legalBusinessName: (tenant as any).name ?? "ChecksOps Organization",
            email: (tenant as any).contact_email ?? undefined,
            phone: (tenant as any).contact_phone
              ? { number: String((tenant as any).contact_phone).replace(/\D/g, "").slice(-10) }
              : undefined,
          },
        },
        capabilities: ["transfers", "send-funds", "collect-funds", "wallet"],
        foreignID: tenant_id,
        metadata: { checksops_tenant_id: tenant_id },
      },
    });

    const accountId = created?.accountID ?? created?.accountId;
    if (!accountId) return json({ error: "Payment provider did not return an account id" }, 502);

    // 4. Persist against the tenant. Unique index blocks any duplicate row.
    const { data: saved, error: saveErr } = await supabase
      .from("payment_provider_accounts")
      .upsert(
        {
          tenant_id,
          provider: "moov",
          environment,
          provider_account_id: accountId,
          account_type: "business",
          display_name: (tenant as any).name ?? null,
          onboarding_status: "onboarding_incomplete",
          verification_status: "not_started",
          provider_metadata: sanitize(created ?? {}),
          last_synced_at: new Date().toISOString(),
        },
        { onConflict: "tenant_id,provider,environment" },
      )
      .select()
      .single();
    if (saveErr) return json({ error: saveErr.message }, 500);

    await supabase
      .from("tenants")
      .update({
        moov_account_id: accountId,
        payment_status: "pending_verification",
        last_sync: new Date().toISOString(),
      })
      .eq("id", tenant_id);

    await supabase
      .from("payment_idempotency_keys")
      .update({ status: "completed", response: { account_id: accountId } })
      .eq("provider", "moov")
      .eq("scope", "account_create")
      .eq("idempotency_key", idempotencyKey);

    await logPaymentEvent(supabase, {
      tenant_id,
      event_type: "payment_account.created",
      new_status: "onboarding_incomplete",
      environment,
      provider_metadata: { account_id: accountId, created_by: userId },
    });

    return json({ success: true, already_existed: false, account: saved });
  } catch (e) {
    console.error("[moov-account-create]", (e as Error).message);
    return json({ error: (e as Error).message }, 500);
  }
});

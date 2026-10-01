import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { moovFetch, scopes } from "../_shared/moovClient.ts";
import { MOOV_CAPABILITIES_API_VERSION, RECIPIENT_CAPABILITIES } from "../_shared/moovCapabilities.ts";
import { corsHeaders, json, isResponse, logPaymentEvent, requireMoovCaller, sanitize } from "../_shared/moovGuard.ts";

// Creates a lightweight recipient for a payee who has NO ChecksOps login —
// homeowner, individual subcontractor, one-time vendor, other claim payee.
//
// If the payee IS already a ChecksOps tenant, this function refuses and points
// at that tenant's existing connected account instead: we never create a
// duplicate provider account for an organization that already has one.
//
// The recipient gets a secure, expiring ChecksOps link to a branded page where
// the provider's hosted component collects their bank details directly.

function secureToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const {
      tenant_id,
      name,
      email,
      phone,
      recipient_type = "individual",
      relationship = "one_time",
      claim_id = null,
      check_id = null,
      expires_in_days = 14,
    } = await req.json();

    if (!tenant_id) return json({ error: "tenant_id is required" }, 400);
    if (!name || String(name).trim().length < 2) {
      return json({ error: "Recipient name is required" }, 400);
    }

    const caller = await requireMoovCaller(req, tenant_id);
    if (isResponse(caller)) return caller;
    const { supabase, environment, userId } = caller;

    // 1. Is this payee already a ChecksOps tenant? Reuse, never duplicate.
    if (email) {
      const { data: memberTenant } = await supabase
        .from("tenants")
        .select("id, name, email_reply_to")
        .ilike("email_reply_to", String(email).trim())
        .maybeSingle();

      if (memberTenant) {
        const { data: theirAccount } = await supabase
          .from("payment_provider_accounts")
          .select("provider_account_id, onboarding_status, can_receive_payments")
          .eq("tenant_id", (memberTenant as any).id)
          .eq("provider", "moov")
          .eq("environment", environment)
          .maybeSingle();

        return json({
          success: true,
          is_existing_member: true,
          recipient_tenant_id: (memberTenant as any).id,
          recipient_tenant_name: (memberTenant as any).name,
          provider_account_id: theirAccount?.provider_account_id ?? null,
          can_receive_payments: !!theirAccount?.can_receive_payments,
          message: theirAccount?.provider_account_id
            ? "This payee already has a ChecksOps payment account — it will be used directly."
            : "This payee is a ChecksOps organization but has not finished payment setup.",
        });
      }
    }

    // 2. De-dupe external recipients within this tenant by email.
    if (email) {
      const { data: dupe } = await supabase
        .from("external_payment_recipients")
        .select("*")
        .eq("tenant_id", tenant_id)
        .ilike("email", String(email).trim())
        .maybeSingle();
      if (dupe) {
        return json({ success: true, already_existed: true, recipient: dupe });
      }
    }

    const token = secureToken();
    const expiresAt = new Date(Date.now() + Number(expires_in_days) * 86_400_000).toISOString();

    const { data: recipient, error: insErr } = await supabase
      .from("external_payment_recipients")
      .insert({
        tenant_id,
        provider: "moov",
        environment,
        display_name: String(name).trim(),
        email: email ?? null,
        phone: phone ?? null,
        recipient_type,
        relationship,
        claim_id,
        check_id,
        secure_token: token,
        token_expires_at: expiresAt,
        created_by: userId,
      })
      .select()
      .single();
    if (insErr) return json({ error: insErr.message }, 500);

    // 3. Create the provider-side recipient account (individual or business).
    const idempotencyKey = `checksops-recipient-${environment}-${recipient.id}`;
    const [first, ...rest] = String(name).trim().split(/\s+/);

    const created = await moovFetch<any>("/accounts", {
      method: "POST",
      scopes: scopes.accountsWrite(),
      idempotencyKey,
      apiVersion: MOOV_CAPABILITIES_API_VERSION,
      body: recipient_type === "business"
        ? {
          accountType: "business",
          profile: { business: { legalBusinessName: String(name).trim(), email: email ?? undefined } },
          // Receive-only stakeholder accounts use the baseline transfers
          // capability. Requesting send-funds incorrectly turns the recipient
          // into a sender and adds platform-agreement/full-KYC requirements.
          capabilities: [...RECIPIENT_CAPABILITIES],
          foreignID: recipient.id,
          metadata: { checksops_recipient_id: recipient.id, checksops_tenant_id: tenant_id },
        }
        : {
          accountType: "individual",
          profile: {
            individual: {
              name: { firstName: first, lastName: rest.join(" ") || first },
              email: email ?? undefined,
            },
          },
          capabilities: [...RECIPIENT_CAPABILITIES],
          foreignID: recipient.id,
          metadata: { checksops_recipient_id: recipient.id, checksops_tenant_id: tenant_id },
        },
    });

    const providerAccountId = created?.accountID ?? created?.accountId ?? null;

    const { data: saved } = await supabase
      .from("external_payment_recipients")
      .update({
        provider_account_id: providerAccountId,
        onboarding_status: providerAccountId ? "awaiting_kyc" : "not_started",
      })
      .eq("id", recipient.id)
      .select()
      .single();

    await logPaymentEvent(supabase, {
      tenant_id,
      recipient_id: recipient.id,
      event_type: "recipient.created",
      new_status: "awaiting_kyc",
      environment,
      provider_metadata: sanitize({ provider_account_id: providerAccountId, relationship }),
    });

    const appUrl = Deno.env.get("CHECKSOPS_APP_URL") ?? "https://checksops.com";

    return json({
      success: true,
      already_existed: false,
      is_existing_member: false,
      recipient: saved ?? recipient,
      secure_link: `${appUrl}/pay-setup/${token}`,
      expires_at: expiresAt,
    });
  } catch (e) {
    console.error("[moov-recipient-create]", (e as Error).message);
    return json({ error: (e as Error).message }, 500);
  }
});

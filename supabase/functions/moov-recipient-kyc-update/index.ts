import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { bindMoovEnvironment, moovConfigured, moovEnvironment, moovFetch, scopes } from "../_shared/moovClient.ts";
import { corsHeaders, json, sanitize } from "../_shared/moovGuard.ts";

const digits = (value: unknown) => String(value ?? "").replace(/\D/g, "");

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    if ((Deno.env.get("MOOV_ENABLED") ?? "false").toLowerCase() !== "true") {
      return json({ error: "This payment provider is not enabled." }, 403);
    }

    const body = await req.json().catch(() => ({}));
    const token = String(body?.token ?? "");
    if (!token) return json({ error: "token is required" }, 400);

    const firstName = String(body?.first_name ?? "").trim();
    const lastName = String(body?.last_name ?? "").trim();
    const email = String(body?.email ?? "").trim();
    const phone = digits(body?.phone);
    const address1 = String(body?.address_line1 ?? "").trim();
    const address2 = String(body?.address_line2 ?? "").trim();
    const city = String(body?.city ?? "").trim();
    const state = String(body?.state ?? "").trim().toUpperCase();
    const postalCode = digits(body?.postal_code);
    const birthDate = String(body?.birth_date ?? "");
    const ssn = digits(body?.ssn);

    const dob = /^\d{4}-\d{2}-\d{2}$/.test(birthDate) ? birthDate.split("-").map(Number) : [];
    if (firstName.length < 1 || lastName.length < 1) return json({ error: "First and last name are required." }, 400);
    if (!email.includes("@")) return json({ error: "Enter a valid email address." }, 400);
    if (phone.length !== 10) return json({ error: "Phone number must be 10 digits." }, 400);
    if (!address1 || !city || state.length !== 2 || postalCode.length !== 5) {
      return json({ error: "Enter a complete U.S. residential address." }, 400);
    }
    if (dob.length !== 3 || !dob.every(Number.isFinite)) return json({ error: "Enter a valid date of birth." }, 400);
    if (ssn.length !== 9) return json({ error: "SSN must be 9 digits." }, 400);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: recipient } = await supabase
      .from("external_payment_recipients")
      .select("id, tenant_id, provider_account_id, token_expires_at, environment, stakeholder_account_id")
      .eq("secure_token", token)
      .maybeSingle();

    if (!recipient) return json({ error: "This link is not valid." }, 404);
    if (recipient.token_expires_at && new Date(recipient.token_expires_at) < new Date()) {
      return json({ error: "This link has expired. Ask the sender for a new one." }, 410);
    }
    if (!recipient.provider_account_id) return json({ error: "This payment setup is not ready yet." }, 409);

    bindMoovEnvironment(String(recipient.environment ?? ""));
    const environment = moovEnvironment();
    if (!moovConfigured(environment)) return json({ error: "Payment provider is not configured." }, 503);

    const accountId = String(recipient.provider_account_id);
    const account = await moovFetch<any>(`/accounts/${accountId}`, { scopes: scopes.accountRead(accountId) });
    if (account?.accountType && account.accountType !== "individual") {
      return json({ error: "This recipient requires business verification instead of individual KYC." }, 409);
    }

    await moovFetch<any>(`/accounts/${accountId}`, {
      method: "PATCH",
      scopes: scopes.accountWrite(accountId),
      body: {
        profile: {
          individual: {
            name: { firstName, lastName },
            email,
            phone: { number: phone, countryCode: "1" },
            address: {
              addressLine1: address1,
              ...(address2 ? { addressLine2: address2 } : {}),
              city,
              stateOrProvince: state,
              postalCode,
              country: "US",
            },
            birthDate: { year: dob[0], month: dob[1], day: dob[2] },
            governmentID: { ssn: { full: ssn } },
          },
        },
      },
    });

    const refreshed = await moovFetch<any>(`/accounts/${accountId}`, { scopes: scopes.accountRead(accountId) });
    const verification = String(refreshed?.profile?.individual?.verification?.status ?? refreshed?.verification?.status ?? "pending").toLowerCase();

    await supabase
      .from("external_payment_recipients")
      .update({ onboarding_status: verification === "verified" ? "awaiting_bank" : "kyc_pending" })
      .eq("id", recipient.id);

    if (recipient.stakeholder_account_id) {
      await supabase
        .from("stakeholder_accounts")
        .update({ verification_status: verification === "verified" ? "verified" : "pending" })
        .eq("id", recipient.stakeholder_account_id);
    }

    await supabase.from("payment_event_log").insert(sanitize({
      tenant_id: recipient.tenant_id,
      event_type: "recipient.kyc.submitted",
      new_status: verification,
      environment,
      provider_metadata: { recipient_id: recipient.id, account_id: accountId },
    }));

    return json({ success: true, verification_status: verification });
  } catch (e) {
    console.error("[moov-recipient-kyc-update]", (e as Error).message);
    return json({ error: (e as Error).message }, 500);
  }
});

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { moovFetch, bindMoovEnvironment, moovConfigured, moovEnvironment, scopes } from "../_shared/moovClient.ts";
import { corsHeaders, json, sanitize } from "../_shared/moovGuard.ts";
import {
  dropTokenFromBody,
  rejectForgedRecipientTos,
  tosBoundToRecipientAccount,
  tosConfirmedByMoov,
  tosRequirementOutstanding,
} from "../_shared/recipientTosPolicy.ts";

const listOf = (payload: any) => {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.capabilities)) return payload.capabilities;
  return [];
};

/** Public, secure-link Terms acceptance. Requires a Moov.js Drop token bound to the recipient account. */
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    if ((Deno.env.get("MOOV_ENABLED") ?? "false").toLowerCase() !== "true") {
      return json({ error: "This payment provider is not enabled." }, 403);
    }

    const body = await req.json().catch(() => ({}));
    const token = String(body?.token ?? "");
    if (!token) return json({ error: "token is required" }, 400);

    const forged = rejectForgedRecipientTos(body);
    if (forged) return json({ error: forged.error, message: forged.message }, forged.statusCode);

    const dropToken = dropTokenFromBody(body);
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: recipient } = await supabase
      .from("external_payment_recipients")
      .select("id, tenant_id, provider_account_id, token_expires_at, environment")
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

    const bound = tosBoundToRecipientAccount({
      recipientAccountId: String(recipient.provider_account_id),
      requestedAccountId: body.account_id ?? body.accountId ?? null,
      environment,
    });
    if (!bound.ok) return json({ error: bound.error }, 400);
    const accountId = bound.account_id;

    const current = await moovFetch<any>(`/accounts/${accountId}`, { scopes: scopes.accountRead(accountId) });
    let capabilitiesBefore: any[] = [];
    let capsReadOk = false;
    try {
      capabilitiesBefore = listOf(await moovFetch<any>(`/accounts/${accountId}/capabilities`, { scopes: scopes.capabilitiesRead(accountId) }));
      capsReadOk = true;
    } catch { /* continue */ }
    const outstandingBefore = capsReadOk ? tosRequirementOutstanding(capabilitiesBefore) : null;
    const alreadyAccepted = tosConfirmedByMoov({
      account: current,
      capabilities: capabilitiesBefore,
      capabilitiesReadOk: capsReadOk,
    });

    if (!alreadyAccepted) {
      await moovFetch<any>(`/accounts/${accountId}`, {
        method: "PATCH",
        scopes: scopes.accountWrite(accountId),
        body: { termsOfService: { token: dropToken } },
      });
    }

    const refreshed = await moovFetch<any>(`/accounts/${accountId}`, { scopes: scopes.accountRead(accountId) });
    let capabilitiesAfter: any[] = [];
    let capsAfterOk = false;
    try {
      capabilitiesAfter = listOf(await moovFetch<any>(`/accounts/${accountId}/capabilities`, { scopes: scopes.capabilitiesRead(accountId) }));
      capsAfterOk = true;
    } catch { /* continue */ }

    const confirmed = tosConfirmedByMoov({
      account: refreshed,
      capabilities: capabilitiesAfter,
      capabilitiesReadOk: capsAfterOk,
      tosOutstandingBefore: outstandingBefore === true,
    });
    if (!confirmed) {
      return json({
        error: "tos_not_recorded",
        message: "The payment provider did not record terms acceptance. Please accept the hosted terms again.",
      }, 502);
    }

    await supabase.from("payment_event_log").insert(sanitize({
      tenant_id: recipient.tenant_id,
      event_type: "recipient.terms_accepted",
      environment,
      provider_metadata: {
        recipient_id: recipient.id,
        account_id: accountId,
        source: "recipient_tos_drop",
        already_accepted: alreadyAccepted,
      },
    }));

    return json({
      success: true,
      already_accepted: alreadyAccepted,
      terms_accepted: true,
      account_id: accountId,
      environment,
    });
  } catch (e) {
    console.error("[moov-recipient-tos-accept]", (e as Error).message);
    return json({ error: (e as Error).message }, 500);
  }
});

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { normalizeTransferStatus } from "../_shared/moovClient.ts";
import { corsHeaders, json, sanitize, serviceClient } from "../_shared/moovGuard.ts";

// Secure provider webhook endpoint.
//
// - Verifies authenticity (HMAC over id.timestamp.body) before doing anything.
// - Idempotent: the external event id is stored unique, so a redelivered event
//   is acknowledged and skipped rather than reprocessed.
// - Writes only safe metadata into the payment event log. Never banking data.
//
// Public endpoint by design (no JWT) — authenticity comes from the signature.

const encoder = new TextEncoder();

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmacBase64(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

/** Moov signs `webhookID.timestamp.body` with the webhook secret. */
async function verifySignature(req: Request, rawBody: string): Promise<{ ok: boolean; eventId: string | null }> {
  const secret = Deno.env.get("MOOV_WEBHOOK_SECRET");
  if (!secret) return { ok: false, eventId: null };

  const webhookId = req.headers.get("webhook-id") ?? req.headers.get("x-moov-webhook-id");
  const timestamp = req.headers.get("webhook-timestamp") ?? req.headers.get("x-moov-timestamp");
  const signatureHeader = req.headers.get("webhook-signature") ?? req.headers.get("x-moov-signature");
  if (!webhookId || !timestamp || !signatureHeader) return { ok: false, eventId: null };

  // Reject anything older than 5 minutes (replay protection).
  const ts = Number(timestamp);
  const tsMs = ts > 1e12 ? ts : ts * 1000;
  if (!Number.isFinite(tsMs) || Math.abs(Date.now() - tsMs) > 5 * 60 * 1000) {
    return { ok: false, eventId: webhookId };
  }

  const expected = await hmacBase64(secret, `${webhookId}.${timestamp}.${rawBody}`);
  // Header may be a space-separated list of "v1,<sig>" entries.
  const candidates = signatureHeader
    .split(/\s+/)
    .map((s) => (s.includes(",") ? s.split(",")[1] : s))
    .filter(Boolean);

  const ok = candidates.some((c) => timingSafeEqual(c, expected));
  return { ok, eventId: webhookId };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const rawBody = await req.text();
  const { ok, eventId } = await verifySignature(req, rawBody);
  if (!ok) {
    console.warn("[moov-webhook] rejected: signature verification failed");
    return json({ error: "Invalid signature" }, 401);
  }

  let payload: any;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const supabase = serviceClient();
  const environment = (Deno.env.get("MOOV_ENVIRONMENT") ?? "sandbox").toLowerCase();
  const eventType: string = payload?.type ?? payload?.eventType ?? "unknown";
  const externalEventId: string = payload?.eventID ?? eventId ?? crypto.randomUUID();
  const providerAccountId: string | null = payload?.accountID ?? payload?.data?.accountID ?? null;

  // Idempotency: unique(provider, external_event_id).
  const { error: insertErr } = await supabase.from("payment_webhook_events").insert({
    provider: "moov",
    environment,
    external_event_id: externalEventId,
    event_type: eventType,
    provider_account_id: providerAccountId,
    resource_id: payload?.data?.transferID ?? payload?.data?.bankAccountID ?? null,
    payload: sanitize(payload),
  });

  if (insertErr) {
    if (insertErr.message.toLowerCase().includes("duplicate")) {
      // Already handled — acknowledge so the provider stops retrying.
      return json({ success: true, duplicate: true });
    }
    console.error("[moov-webhook] store failed", insertErr.message);
    return json({ error: "Could not record event" }, 500);
  }

  try {
    await handleEvent(supabase, eventType, payload, providerAccountId, environment);
    await supabase
      .from("payment_webhook_events")
      .update({ processed_at: new Date().toISOString() })
      .eq("provider", "moov")
      .eq("external_event_id", externalEventId);
  } catch (e) {
    console.error("[moov-webhook] processing failed", eventType, (e as Error).message);
    await supabase
      .from("payment_webhook_events")
      .update({ processing_error: (e as Error).message })
      .eq("provider", "moov")
      .eq("external_event_id", externalEventId);
    return json({ error: "Processing failed" }, 500);
  }

  return json({ success: true, duplicate: false });
});

async function handleEvent(
  supabase: ReturnType<typeof createClient>,
  eventType: string,
  payload: any,
  providerAccountId: string | null,
  environment: string,
) {
  const data = payload?.data ?? payload;

  // Resolve which tenant (if any) this account belongs to.
  let tenantId: string | null = null;
  if (providerAccountId) {
    const { data: acct } = await supabase
      .from("payment_provider_accounts")
      .select("id, tenant_id, onboarding_status")
      .eq("provider_account_id", providerAccountId)
      .eq("environment", environment)
      .maybeSingle();
    tenantId = (acct as any)?.tenant_id ?? null;

    if (acct && (eventType.startsWith("account") || eventType.startsWith("capability") || eventType.startsWith("bankAccount") || eventType.includes("verification"))) {
      await supabase
        .from("payment_provider_accounts")
        .update({
          last_webhook_event_at: new Date().toISOString(),
          last_webhook_event_type: eventType,
        })
        .eq("id", (acct as any).id);
    }
  }

  /* ---- Account / capability / bank / verification ---- */
  if (
    eventType.startsWith("account") ||
    eventType.startsWith("capability") ||
    eventType.startsWith("bankAccount") ||
    eventType.includes("verification") ||
    eventType.includes("representative")
  ) {
    if (eventType.startsWith("bankAccount") && data?.bankAccountID) {
      const status = String(data.status ?? "pending").toLowerCase();
      await supabase
        .from("payment_provider_methods")
        .update({
          verification_status: status,
          connection_status: status === "verified" ? "connected" : status === "errored" ? "failed" : "pending",
        })
        .eq("provider_bank_account_id", data.bankAccountID)
        .eq("environment", environment);
    }

    await supabase.from("payment_event_log").insert({
      provider: "moov",
      environment,
      tenant_id: tenantId,
      event_type: eventType,
      new_status: data?.status ?? null,
      provider_metadata: sanitize({ account_id: providerAccountId, resource: data?.bankAccountID ?? null }),
    });
    return;
  }

  /* ---- Transfers ---- */
  const transferId = data?.transferID ?? data?.transferId ?? null;
  if (!transferId) return;

  const { data: transfer } = await supabase
    .from("payment_transfers")
    .select("id, tenant_id, status, destination_recipient_id")
    .eq("provider_transfer_id", transferId)
    .eq("environment", environment)
    .maybeSingle();

  const providerStatus: string = data?.status ?? eventTypeToStatus(eventType);
  const newStatus = normalizeTransferStatus(providerStatus);

  if (!transfer) {
    // Unknown transfer (e.g. created outside ChecksOps) — log and stop.
    await supabase.from("payment_event_log").insert({
      provider: "moov",
      environment,
      tenant_id: tenantId,
      provider_transfer_id: transferId,
      event_type: eventType,
      new_status: newStatus,
      provider_metadata: sanitize({ provider_status: providerStatus }),
    });
    return;
  }

  const previous = (transfer as any).status as string;
  const patch: Record<string, unknown> = {
    status: newStatus,
    provider_status: providerStatus,
  };
  if (newStatus === "completed") patch.completed_at = new Date().toISOString();
  if (newStatus === "failed" || newStatus === "returned") {
    patch.failure_reason = data?.failureReason ?? data?.reason ?? eventType;
  }

  await supabase.from("payment_transfers").update(patch).eq("id", (transfer as any).id);

  await supabase.from("payment_event_log").insert({
    provider: "moov",
    environment,
    tenant_id: (transfer as any).tenant_id,
    recipient_id: (transfer as any).destination_recipient_id,
    transfer_id: (transfer as any).id,
    provider_transfer_id: transferId,
    event_type: eventType,
    previous_status: previous,
    new_status: newStatus,
    provider_metadata: sanitize({ provider_status: providerStatus }),
  });
}

/** Falls back to the event name when the payload carries no status. */
function eventTypeToStatus(eventType: string): string {
  if (eventType.includes("completed")) return "completed";
  if (eventType.includes("failed")) return "failed";
  if (eventType.includes("reversed") || eventType.includes("returned")) return "reversed";
  if (eventType.includes("canceled")) return "canceled";
  if (eventType.includes("created")) return "created";
  return "pending";
}

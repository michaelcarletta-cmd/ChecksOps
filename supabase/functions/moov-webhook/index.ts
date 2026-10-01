import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { normalizeTransferStatus } from "../_shared/moovClient.ts";
import { corsHeaders, json, sanitize, serviceClient } from "../_shared/moovGuard.ts";
import { postTransferLedger } from "../_shared/moovWallet.ts";
import {
  applyMoovBankVerificationEvent,
  bankEventFromPayload,
  shouldApplyBankVerificationEvent,
} from "../_shared/moovStakeholderSync.ts";

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

async function hmacHex(secret: string, payload: string, hash: "SHA-256" | "SHA-512"): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
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

function parseTimestampMs(raw: string): number {
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return n > 1e12 ? n : n * 1000;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : NaN;
}

/**
 * Moov signs `timestamp|nonce|webhookID` with HMAC-SHA512 (hex) and sends it in
 * `X-Signature`. A legacy Svix-style body signature is still accepted as a
 * fallback for older endpoint configurations.
 */
async function verifySignature(req: Request, rawBody: string): Promise<{ ok: boolean; eventId: string | null }> {
  const secret = Deno.env.get("MOOV_WEBHOOK_SECRET");
  if (!secret) return { ok: false, eventId: null };

  const h = (name: string) => req.headers.get(name);
  const webhookId = h("x-webhook-id") ?? h("webhook-id") ?? h("x-moov-webhook-id");
  const timestamp = h("x-timestamp") ?? h("webhook-timestamp") ?? h("x-moov-timestamp");
  const nonce = h("x-nonce");
  const signatureHeader = h("x-signature") ?? h("webhook-signature") ?? h("x-moov-signature");

  if (!webhookId || !timestamp || !signatureHeader) {
    console.warn("[moov-webhook] missing signature headers", {
      hasId: !!webhookId,
      hasTimestamp: !!timestamp,
      hasNonce: !!nonce,
      hasSignature: !!signatureHeader,
    });
    return { ok: false, eventId: webhookId };
  }

  // Replay protection — accept a 5 minute window.
  const tsMs = parseTimestampMs(timestamp);
  if (!Number.isFinite(tsMs) || Math.abs(Date.now() - tsMs) > 5 * 60 * 1000) {
    console.warn("[moov-webhook] timestamp outside allowed window");
    return { ok: false, eventId: webhookId };
  }

  const candidates = signatureHeader
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => s && s !== "v1");

  // Primary: Moov HMAC-SHA512 hex over `timestamp|nonce|webhookID`.
  if (nonce) {
    const expected = await hmacHex(secret, `${timestamp}|${nonce}|${webhookId}`, "SHA-512");
    if (candidates.some((c) => timingSafeEqual(c.toLowerCase(), expected))) {
      return { ok: true, eventId: webhookId };
    }
  }

  // Fallback: legacy body signature (base64 HMAC-SHA256 over id.timestamp.body).
  const legacy = await hmacBase64(secret, `${webhookId}.${timestamp}.${rawBody}`);
  const ok = candidates.some((c) => timingSafeEqual(c, legacy));
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
    if (shouldApplyBankVerificationEvent(eventType, data) && providerAccountId) {
      const event = bankEventFromPayload(data);
      const status = String(event.status ?? data.status ?? "pending").toLowerCase();
      if (event.bankAccountID) {
        await supabase
          .from("payment_provider_methods")
          .update({
            verification_status: status,
            connection_status: status === "verified" ? "connected" : status === "errored" ? "failed" : "pending",
          })
          .eq("provider_bank_account_id", event.bankAccountID)
          .eq("environment", environment);
      }

      // Recipients are often the only ChecksOps row that already stores the
      // Moov account id. Attach that verification onto the Settings
      // stakeholder even when provider_account_id was never copied over.
      await applyMoovBankVerificationEvent(supabase, {
        environment,
        providerAccountId,
        tenantId,
        bank: {
          bankAccountID: event.bankAccountID,
          bankName: event.bankName,
          lastFourAccountNumber: event.lastFour,
          status: event.status,
        },
        verification: event.verification,
      });
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

  /* ---- Transfers / Disputes ---- */
  const transferId = data?.transferID ?? data?.transferId ?? null;
  const disputeId = data?.disputeID ?? data?.disputeId ?? null;

  if (!transferId && !disputeId) return;

  if (disputeId) {
    // Handle dispute event
    await supabase.from("payment_event_log").insert({
      provider: "moov",
      environment,
      tenant_id: tenantId,
      event_type: eventType,
      provider_metadata: sanitize({ 
        dispute_id: disputeId, 
        transfer_id: transferId,
        amount: data?.amount,
        phase: data?.phase,
        status: data?.status 
      }),
    });
    // If it's a dispute, we might want to flag the transfer if we have it
    if (transferId) {
      const { data: transfer } = await supabase
        .from("payment_transfers")
        .select("id")
        .eq("provider_transfer_id", transferId)
        .eq("environment", environment)
        .maybeSingle();
      
      if (transfer) {
        await supabase
          .from("payment_transfers")
          .update({ 
            failure_reason: `Dispute ${disputeId}: ${data?.phase || eventType}` 
          })
          .eq("id", transfer.id);
      }
    }
    return;
  }


  const { data: transfer } = await supabase
    .from("payment_transfers")
    .select(
      "id, tenant_id, status, destination_recipient_id, amount_cents, wallet_id, leg_role, transfer_group_id, claim_id, check_id",
    )
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

  // Wallet balances only move on a terminal transfer, and each transfer can
  // only ever post (and reverse) once — unique `reference`.
  const t = transfer as any;
  await postTransferLedger(supabase, t, newStatus, transferId);

  // Roll the split's overall state up from its legs.
  if (t.transfer_group_id) {
    const { data: legs } = await supabase
      .from("payment_transfers")
      .select("status, leg_role")
      .eq("transfer_group_id", t.transfer_group_id);
    const children = (legs ?? []).filter((l: any) => l.leg_role !== "parent");
    const failed = children.filter((l: any) =>
      ["failed", "returned", "canceled", "cancelled"].includes(l.status)
    ).length;
    const done = children.filter((l: any) => l.status === "completed").length;
    const groupStatus = children.length === 0
      ? "submitted"
      : done === children.length
      ? "completed"
      : failed === children.length
      ? "failed"
      : failed > 0
      ? "partially_failed"
      : "processing";
    await supabase
      .from("payment_transfer_groups")
      .update({
        status: groupStatus,
        completed_at: groupStatus === "completed" ? new Date().toISOString() : null,
      })
      .eq("id", t.transfer_group_id);
  }

  // Automatic wallet funding: keep the funding request in step, and send the
  // approved payment once (and only once) the money is actually available.
  await syncFundingRequest(supabase, environment, transferId, newStatus, patch.failure_reason as string | undefined);

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

const FUNDING_TERMINAL = ["completed", "failed", "returned", "canceled"];

/**
 * Maps a provider transfer status onto its wallet funding request.
 *
 * Webhooks duplicate and arrive out of order, so a terminal funding record is
 * never moved backwards, and the outgoing payment is only ever handed to
 * `process-funded-payment` — which itself locks before sending.
 */
async function syncFundingRequest(
  supabase: any,
  environment: string,
  providerTransferId: string,
  newStatus: string,
  failureReason?: string,
): Promise<void> {
  const { data: request } = await supabase
    .from("wallet_funding_requests")
    .select("id, tenant_id, status, related_payment_id")
    .eq("moov_transfer_id", providerTransferId)
    .maybeSingle();
  if (!request) return;
  if (FUNDING_TERMINAL.includes(String(request.status))) return;

  const map: Record<string, string> = {
    completed: "completed",
    failed: "failed",
    returned: "returned",
    reversed: "returned",
    canceled: "canceled",
    cancelled: "canceled",
  };
  const fundingStatus = map[newStatus] ?? "pending";
  const now = new Date().toISOString();

  await supabase.from("wallet_funding_requests").update({
    status: fundingStatus,
    failure_code: ["failed", "returned"].includes(fundingStatus) ? newStatus : null,
    failure_reason: ["failed", "returned"].includes(fundingStatus) ? (failureReason ?? null) : null,
    funds_available_at: fundingStatus === "completed" ? now : null,
    completed_at: FUNDING_TERMINAL.includes(fundingStatus) ? now : null,
  }).eq("id", request.id);

  if (fundingStatus === "completed") {
    // Hand off to the sender. Failed ACH debits are NEVER retried here.
    await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/process-funded-payment`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-checksops-internal": Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
        Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
      },
      body: JSON.stringify({ funding_request_id: request.id }),
    }).catch((e) => console.error("[moov-webhook] process-funded-payment", (e as Error).message));
    return;
  }

  if (["failed", "returned"].includes(fundingStatus) && request.related_payment_id) {
    await supabase.from("disbursement_batches").update({
      funding_status: fundingStatus === "returned" ? "action_required" : "funding_failed",
      amount_reserved_cents: 0,
      auto_send_after_funding: false,
    }).eq("id", request.related_payment_id);

    // Auditable alert for tenant finance admins — surfaced in Wallet Ops.
    await supabase.from("payment_event_log").insert({
      provider: "moov",
      environment,
      tenant_id: request.tenant_id,
      provider_transfer_id: providerTransferId,
      event_type: fundingStatus === "returned"
        ? "wallet.funding.returned"
        : "wallet.funding.failed",
      new_status: fundingStatus,
      provider_metadata: {
        funding_request_id: request.id,
        payment_id: request.related_payment_id,
        action_required: true,
      },
    }).then(() => undefined, () => undefined);

  }
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

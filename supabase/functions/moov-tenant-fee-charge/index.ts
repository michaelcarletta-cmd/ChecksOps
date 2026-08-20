import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  facilitatorAccountId,
  moovFetch,
  normalizeTransferStatus,
  scopes,
} from "../_shared/moovClient.ts";
import {
  corsHeaders,
  isResponse,
  json,
  logPaymentEvent,
  requireMoovCaller,
  sanitize,
} from "../_shared/moovGuard.ts";
import { resolveDebitSourceMethodId } from "../_shared/moovRails.ts";

/**
 * Ad-hoc platform-fee pull from one organization, over Moov.
 *
 * Debits the organization's own connected bank account (ACH debit) into the
 * ChecksOps platform balance, records the payment locally, and optionally
 * emails the invoice. This replaces the legacy Actum path used by
 * Tenant Management -> "Pull ... & email invoice".
 */

interface LineItem { label: string; detail?: string; amount_cents: number }

function firstOfCurrentMonth(d = new Date()): string {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString().slice(0, 10);
}
function firstOfNextMonth(d = new Date()): string {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
}

/** The platform balance that fees land in. */
async function platformWalletMethodId(platformAccount: string): Promise<string | null> {
  const fromEnv = Deno.env.get("MOOV_PLATFORM_PAYMENT_METHOD_ID");
  if (fromEnv) return fromEnv;
  const methods = await moovFetch<any[]>(`/accounts/${platformAccount}/payment-methods`, {
    scopes: scopes.paymentMethodsRead(platformAccount),
  }).catch(() => [] as any[]);
  const wallet = (methods ?? []).find(
    (m: any) => String(m?.paymentMethodType ?? "") === "moov-wallet",
  );
  return wallet?.paymentMethodID ?? wallet?.paymentMethodId ?? null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = await req.json().catch(() => ({}));
    const tenantId: string | null = body?.tenant_id ?? null;
    const amountCents = Math.round(Number(body?.amount_cents ?? 0));
    const kind: string = body?.kind ?? "consolidated";
    const periodLabel: string | null = body?.period_label ?? null;
    const lineItems: LineItem[] = Array.isArray(body?.line_items) ? body.line_items : [];
    const sendInvoice: boolean = body?.send_invoice !== false;
    const invoiceRecipient: string | null = body?.invoice_recipient ?? null;
    const dryRun: boolean = !!body?.dry_run;

    if (!tenantId) return json({ error: "tenant_id is required" }, 400);
    if (!Number.isFinite(amountCents) || amountCents <= 0) {
      return json({ error: "amount_cents must be greater than zero" }, 400);
    }

    const caller = await requireMoovCaller(req, tenantId, { requireAdmin: true });
    if (isResponse(caller)) return caller;
    const { supabase, environment, userId } = caller;

    const { data: tenant } = await supabase
      .from("tenants")
      .select("id, name")
      .eq("id", tenantId)
      .maybeSingle();
    if (!tenant) return json({ error: "Organization not found" }, 404);

    const { data: account } = await supabase
      .from("payment_provider_accounts")
      .select("provider_account_id, onboarding_status, can_ach_debit")
      .eq("tenant_id", tenantId)
      .eq("provider", "moov")
      .eq("environment", environment)
      .maybeSingle();
    if (!account?.provider_account_id) {
      return json({ error: "This organization has no payment account yet." }, 409);
    }
    if (!account.can_ach_debit) {
      return json({ error: "Bank debits are not authorized for this organization yet." }, 409);
    }

    const { data: source } = await supabase
      .from("payment_provider_methods")
      .select("*")
      .eq("tenant_id", tenantId)
      .eq("provider", "moov")
      .eq("environment", environment)
      .eq("provider_account_id", account.provider_account_id)
      .eq("connection_status", "connected")
      .order("is_default", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!source) {
      return json({ error: "No connected bank account to pull fees from." }, 409);
    }

    const platformAccount = await facilitatorAccountId(account.provider_account_id);
    const destinationMethodId = await platformWalletMethodId(platformAccount);
    if (!destinationMethodId) {
      return json({ error: "The platform billing balance is not configured yet." }, 503);
    }

    const sourceMethodId = await resolveDebitSourceMethodId(
      supabase,
      source as any,
      account.provider_account_id,
    );
    if (!sourceMethodId) {
      return json({ error: "That bank account cannot be debited over ACH yet." }, 409);
    }

    const period_start = firstOfCurrentMonth();
    const period_end = firstOfNextMonth();

    if (dryRun) {
      return json({
        success: true,
        dry_run: true,
        amount_cents: amountCents,
        tenant_id: tenantId,
        period_start,
        period_end,
      });
    }

    const idempotence_key = `${kind}_moov_${tenantId}_${Date.now()}`;

    const { data: payment, error: payErr } = await supabase
      .from("tenant_maintenance_payments")
      .insert({
        tenant_id: tenantId,
        amount_cents: amountCents,
        period_start,
        period_end,
        method: kind === "maintenance" ? "moov_ach" : "moov_ach_consolidated",
        status: "pending",
        idempotence_key,
        recorded_by: userId,
        notes: `Moov ACH pull (${kind}) for ${periodLabel || period_start.slice(0, 7)}${
          lineItems.length
            ? ": " + lineItems.map((li) => `${li.label} $${(li.amount_cents / 100).toFixed(2)}`).join(" · ")
            : ""
        }`,
      })
      .select()
      .single();
    if (payErr) return json({ error: payErr.message }, 500);

    let created: Record<string, unknown> | null = null;
    let failure: string | null = null;
    try {
      created = await moovFetch<Record<string, unknown>>(`/accounts/${platformAccount}/transfers`, {
        method: "POST",
        scopes: scopes.transfersWrite(platformAccount),
        idempotencyKey: `checksops-fee-pull-${payment.id}`,
        body: {
          source: { paymentMethodID: sourceMethodId },
          destination: { paymentMethodID: destinationMethodId },
          amount: { currency: "USD", value: amountCents },
          description: `ChecksOps fees ${periodLabel || period_start.slice(0, 7)}`.slice(0, 128),
          metadata: {
            checksops_tenant_id: tenantId,
            checksops_payment_id: payment.id,
            checksops_kind: kind,
          },
        },
      });
    } catch (e) {
      failure = (e as Error).message;
    }

    const providerTransferId =
      (created as any)?.transferID ?? (created as any)?.transferId ?? null;
    const status = failure ? "failed" : normalizeTransferStatus((created as any)?.status);
    const accepted = !failure;

    await supabase
      .from("tenant_maintenance_payments")
      .update({
        status: accepted ? "submitted" : "failed",
        failure_reason: failure,
        submitted_at: accepted ? new Date().toISOString() : null,
        notes: `${payment.notes ?? ""}${providerTransferId ? ` · moov:${providerTransferId}` : ""}`,
      })
      .eq("id", payment.id);

    await logPaymentEvent(supabase, {
      tenant_id: tenantId,
      provider_transfer_id: providerTransferId,
      event_type: "platform_fee.pull",
      new_status: status,
      environment,
      provider_metadata: sanitize({ amount_cents: amountCents, kind, period_label: periodLabel }),
    });

    if (!accepted) {
      return json({ success: false, error: failure, payment_id: payment.id }, 502);
    }

    // Invoice email — best effort, never changes the ACH outcome.
    let invoice_sent = false;
    let invoice_error: string | null = null;
    if (sendInvoice) {
      try {
        let recipient = invoiceRecipient;
        if (!recipient) {
          const { data: tu } = await supabase
            .from("tenant_users")
            .select("user_id, created_at")
            .eq("tenant_id", tenantId)
            .order("created_at", { ascending: true })
            .limit(1)
            .maybeSingle();
          if (tu?.user_id) {
            const { data: u } = await supabase.auth.admin.getUserById(tu.user_id);
            recipient = u?.user?.email ?? null;
          }
        }
        if (recipient) {
          const { error: emailErr } = await supabase.functions.invoke("send-transactional-email", {
            body: {
              templateName: "tenant-invoice",
              recipientEmail: recipient,
              idempotencyKey: `invoice-${payment.id}`,
              templateData: {
                tenant_name: tenant.name,
                period_label: periodLabel || period_start.slice(0, 7),
                invoice_number: `INV-${period_start.slice(0, 7)}-${payment.id.slice(0, 6).toUpperCase()}`,
                line_items: lineItems.length
                  ? lineItems
                  : [{ label: "ChecksOps fees", detail: periodLabel ?? "", amount_cents: amountCents }],
                discount_cents: 0,
                total_cents: amountCents,
                bank_last4: (source as any).last_four ?? null,
                status: "submitted",
                charged_at: new Date().toISOString(),
              },
            },
          });
          if (emailErr) invoice_error = emailErr.message;
          else invoice_sent = true;
        } else {
          invoice_error = "no_recipient";
        }
      } catch (e) {
        invoice_error = (e as Error).message;
      }
    }

    return json({
      success: true,
      results: [
        {
          tenant_id: tenantId,
          name: tenant.name,
          amount_cents: amountCents,
          status: "submitted",
          provider_transfer_id: providerTransferId,
          transfer_status: status,
          invoice_sent,
          invoice_error,
        },
      ],
    });
  } catch (e) {
    console.error("[moov-tenant-fee-charge]", (e as Error).message);
    return json({ error: (e as Error).message }, 500);
  }
});

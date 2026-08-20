import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { moovFetch } from "../_shared/moovClient.ts";
import { corsHeaders, json, isResponse, logPaymentEvent, requireMoovCaller, sanitize } from "../_shared/moovGuard.ts";

// Tenant invoicing on Moov.
//
// Tenants create an invoice against their own connected Moov account, Moov
// generates a hosted payment link, and when the customer pays (bank transfer
// or card) the funds settle directly into that tenant's Moov wallet.
//
// Invoices are only available on the newer Moov API surface, so every call
// here pins v2026.07.00 instead of the platform-wide default.
const INVOICE_API_VERSION = "v2026.07.00";

const invoiceScopes = (accountID: string, write = false) => [
  `/accounts/${accountID}/invoices.${write ? "write" : "read"}`,
];

type LineItem = { name: string; unit_price: number; quantity: number };

function normalizeLineItems(raw: unknown): LineItem[] | string {
  if (!Array.isArray(raw) || raw.length === 0) return "At least one line item is required";
  const items: LineItem[] = [];
  for (const r of raw as any[]) {
    const name = String(r?.name ?? "").trim();
    const unit = Number(r?.unit_price);
    const qty = Number(r?.quantity ?? 1);
    if (!name) return "Every line item needs a description";
    if (!Number.isFinite(unit) || unit <= 0) return `Enter a price greater than zero for "${name}"`;
    if (!Number.isFinite(qty) || qty <= 0) return `Enter a quantity greater than zero for "${name}"`;
    items.push({ name, unit_price: Math.round(unit * 100) / 100, quantity: Math.round(qty) });
  }
  if (items.length > 50) return "An invoice can have at most 50 line items";
  return items;
}

const total = (items: LineItem[]) =>
  Math.round(items.reduce((s, i) => s + i.unit_price * i.quantity, 0) * 100) / 100;

const money = (v: number) => ({ currency: "USD", valueDecimal: v.toFixed(2) });
const dec = (a: any) => (a?.valueDecimal != null ? Number(a.valueDecimal) : 0);

function splitName(name: string) {
  const parts = name.trim().split(/\s+/);
  return {
    firstName: parts[0] ?? name,
    lastName: parts.length > 1 ? parts.slice(1).join(" ") : parts[0] ?? name,
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = await req.json().catch(() => ({}));
    const { action, tenant_id } = body ?? {};
    if (!tenant_id) return json({ error: "tenant_id is required" }, 400);
    if (!action) return json({ error: "action is required" }, 400);

    const caller = await requireMoovCaller(req, tenant_id);
    if (isResponse(caller)) return caller;
    const { supabase, environment, userId } = caller;

    // The tenant's own connected Moov account is the merchant on every invoice.
    const { data: account } = await supabase
      .from("payment_provider_accounts")
      .select("provider_account_id, can_receive_payments, onboarding_status")
      .eq("tenant_id", tenant_id)
      .eq("provider", "moov")
      .eq("environment", environment)
      .maybeSingle();

    const merchantAccountId = (account as any)?.provider_account_id as string | undefined;
    if (!merchantAccountId) {
      return json({ error: "Finish your payment account setup before sending invoices." }, 400);
    }

    const { data: tenantBranding } = await supabase
      .from("tenants")
      .select("invoice_letterhead_url, invoice_footer_note, invoice_default_terms")
      .eq("id", tenant_id)
      .maybeSingle();

    /* ------------------------------ create ------------------------------ */
    if (action === "create" || action === "create_and_send") {
      const customerName = String(body.customer_name ?? "").trim();
      const customerEmail = String(body.customer_email ?? "").trim().toLowerCase();
      if (customerName.length < 2) return json({ error: "Customer name is required" }, 400);
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(customerEmail)) {
        return json({ error: "A valid customer email is required" }, 400);
      }

      const items = normalizeLineItems(body.line_items);
      if (typeof items === "string") return json({ error: items }, 400);
      const amount = total(items);

      const customerType = body.customer_type === "individual" ? "individual" : "business";
      const description = body.description ? String(body.description).slice(0, 500) : null;

      // 1. Reuse (or create) the customer's Moov account.
      const { data: existingCustomer } = await supabase
        .from("moov_invoice_customers")
        .select("id, moov_account_id")
        .eq("tenant_id", tenant_id)
        .eq("environment", environment)
        .ilike("email", customerEmail)
        .maybeSingle();

      let customerRowId = (existingCustomer as any)?.id ?? null;
      let customerAccountId = (existingCustomer as any)?.moov_account_id ?? null;

      if (!customerAccountId) {
        const profile = customerType === "business"
          ? { business: { legalBusinessName: customerName, email: customerEmail } }
          : { individual: { name: splitName(customerName), email: customerEmail } };

        const created = await moovFetch<any>("/accounts", {
          method: "POST",
          scopes: ["/accounts.write"],
          apiVersion: INVOICE_API_VERSION,
          body: { accountType: customerType, profile },
        });
        customerAccountId = created?.accountID;
        if (!customerAccountId) return json({ error: "Could not create the customer record" }, 502);

        const { data: savedCustomer } = await supabase
          .from("moov_invoice_customers")
          .insert({
            tenant_id,
            environment,
            display_name: customerName,
            email: customerEmail,
            phone: body.customer_phone ?? null,
            customer_type: customerType,
            moov_account_id: customerAccountId,
            created_by: userId,
          })
          .select("id")
          .maybeSingle();
        customerRowId = (savedCustomer as any)?.id ?? null;
      }

      // 2. Create the invoice on the tenant's Moov account.
      const invoice = await moovFetch<any>(`/accounts/${merchantAccountId}/invoices`, {
        method: "POST",
        scopes: invoiceScopes(merchantAccountId, true),
        apiVersion: INVOICE_API_VERSION,
        body: {
          customerAccountID: customerAccountId,
          ...(description ? { description } : {}),
          ...(body.invoice_date ? { invoiceDate: new Date(body.invoice_date).toISOString() } : {}),
          ...(body.due_date ? { dueDate: new Date(body.due_date).toISOString() } : {}),
          lineItems: {
            items: items.map((i) => ({
              name: i.name,
              basePrice: money(i.unit_price),
              quantity: i.quantity,
            })),
          },
          ...(tenantBranding?.invoice_footer_note ? { footer: String(tenantBranding.invoice_footer_note).slice(0, 1000) } : {}),
        },
      });

      let finalInvoice = invoice;

      // 3. Setting the status to "unpaid" is what actually sends it.
      if (action === "create_and_send") {
        finalInvoice = await moovFetch<any>(
          `/accounts/${merchantAccountId}/invoices/${invoice.invoiceID}`,
          {
            method: "PATCH",
            scopes: invoiceScopes(merchantAccountId, true),
            apiVersion: INVOICE_API_VERSION,
            body: { status: "unpaid" },
          },
        );
      }

      const { data: row, error: insertErr } = await supabase
        .from("moov_invoices")
        .insert({
          tenant_id,
          environment,
          moov_account_id: merchantAccountId,
          moov_invoice_id: finalInvoice.invoiceID,
          invoice_number: finalInvoice.invoiceNumber ?? null,
          customer_id: customerRowId,
          customer_name: customerName,
          customer_email: customerEmail,
          customer_moov_account_id: customerAccountId,
          description,
          line_items: items,
          total_amount: dec(finalInvoice.totalAmount) || amount,
          paid_amount: dec(finalInvoice.paidAmount),
          status: finalInvoice.status ?? "draft",
          invoice_date: body.invoice_date ?? null,
          due_date: body.due_date ?? null,
          payment_link_url: finalInvoice.paymentLinkURL ?? null,
          public_token: crypto.randomUUID(),
          sent_at: finalInvoice.sentOn ?? (action === "create_and_send" ? new Date().toISOString() : null),
          claim_id: body.claim_id ?? null,
          last_synced_at: new Date().toISOString(),
          provider_metadata: sanitize(finalInvoice),
          created_by: userId,
        })
        .select("*")
        .maybeSingle();

      if (insertErr) {
        console.error("[moov-invoice] insert failed", insertErr.message);
        return json({ error: "Invoice was created but could not be saved" }, 500);
      }

      await logPaymentEvent(supabase, {
        tenant_id,
        event_type: action === "create_and_send" ? "invoice.sent" : "invoice.created",
        new_status: finalInvoice.status ?? "draft",
        environment,
        provider_metadata: { invoiceID: finalInvoice.invoiceID, invoiceNumber: finalInvoice.invoiceNumber },
      });

      return json({ success: true, invoice: row });
    }

    /* ------------------------------- send ------------------------------- */
    if (action === "send") {
      const { data: row } = await supabase
        .from("moov_invoices")
        .select("*")
        .eq("id", body.invoice_id)
        .eq("tenant_id", tenant_id)
        .maybeSingle();
      if (!row) return json({ error: "Invoice not found" }, 404);
      if (!(row as any).moov_invoice_id) return json({ error: "Invoice is not linked to the payment provider" }, 400);

      const sent = await moovFetch<any>(
        `/accounts/${merchantAccountId}/invoices/${(row as any).moov_invoice_id}`,
        {
          method: "PATCH",
          scopes: invoiceScopes(merchantAccountId, true),
          apiVersion: INVOICE_API_VERSION,
          body: { status: "unpaid" },
        },
      );

      const { data: updated } = await supabase
        .from("moov_invoices")
        .update({
          status: sent.status ?? "unpaid",
          invoice_number: sent.invoiceNumber ?? (row as any).invoice_number,
          payment_link_url: sent.paymentLinkURL ?? (row as any).payment_link_url,
          sent_at: sent.sentOn ?? new Date().toISOString(),
          last_synced_at: new Date().toISOString(),
          provider_metadata: sanitize(sent),
        })
        .eq("id", (row as any).id)
        .select("*")
        .maybeSingle();

      await logPaymentEvent(supabase, {
        tenant_id,
        event_type: "invoice.sent",
        previous_status: (row as any).status,
        new_status: sent.status ?? "unpaid",
        environment,
        provider_metadata: { invoiceID: (row as any).moov_invoice_id },
      });

      return json({ success: true, invoice: updated });
    }

    /* ------------------------------- sync ------------------------------- */
    if (action === "sync") {
      const query = supabase
        .from("moov_invoices")
        .select("*")
        .eq("tenant_id", tenant_id)
        .eq("environment", environment)
        .not("moov_invoice_id", "is", null);

      const { data: rows } = body.invoice_id
        ? await query.eq("id", body.invoice_id)
        : await query.not("status", "in", '("paid","canceled","void")').limit(100);

      let synced = 0;
      for (const row of (rows ?? []) as any[]) {
        try {
          const inv = await moovFetch<any>(
            `/accounts/${merchantAccountId}/invoices/${row.moov_invoice_id}`,
            { scopes: invoiceScopes(merchantAccountId), apiVersion: INVOICE_API_VERSION },
          );
          await supabase
            .from("moov_invoices")
            .update({
              status: inv.status ?? row.status,
              invoice_number: inv.invoiceNumber ?? row.invoice_number,
              total_amount: dec(inv.totalAmount) || row.total_amount,
              paid_amount: dec(inv.paidAmount),
              payment_link_url: inv.paymentLinkURL ?? row.payment_link_url,
              sent_at: inv.sentOn ?? row.sent_at,
              paid_at: inv.paidOn ?? row.paid_at,
              last_synced_at: new Date().toISOString(),
              provider_metadata: sanitize(inv),
            })
            .eq("id", row.id);
          synced++;
        } catch (e) {
          console.error("[moov-invoice] sync failed", row.id, (e as Error).message);
        }
      }
      return json({ success: true, synced });
    }

    /* ------------------------------ cancel ------------------------------ */
    if (action === "cancel") {
      const { data: row } = await supabase
        .from("moov_invoices")
        .select("*")
        .eq("id", body.invoice_id)
        .eq("tenant_id", tenant_id)
        .maybeSingle();
      if (!row) return json({ error: "Invoice not found" }, 404);
      if ((row as any).status === "paid") return json({ error: "A paid invoice cannot be canceled" }, 400);

      if ((row as any).moov_invoice_id) {
        await moovFetch(
          `/accounts/${merchantAccountId}/invoices/${(row as any).moov_invoice_id}`,
          { method: "DELETE", scopes: invoiceScopes(merchantAccountId, true), apiVersion: INVOICE_API_VERSION },
        );
      }

      const { data: updated } = await supabase
        .from("moov_invoices")
        .update({ status: "canceled", last_synced_at: new Date().toISOString() })
        .eq("id", (row as any).id)
        .select("*")
        .maybeSingle();

      await logPaymentEvent(supabase, {
        tenant_id,
        event_type: "invoice.canceled",
        previous_status: (row as any).status,
        new_status: "canceled",
        environment,
        provider_metadata: { invoiceID: (row as any).moov_invoice_id },
      });

      return json({ success: true, invoice: updated });
    }

    return json({ error: `Unknown action "${action}"` }, 400);
  } catch (e) {
    const err = e as any;
    console.error("[moov-invoice] error", err?.message);
    return json({ error: err?.message ?? "Invoice request failed" }, err?.status && err.status >= 400 && err.status < 600 ? err.status : 500);
  }
});

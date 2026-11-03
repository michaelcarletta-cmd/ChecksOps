/**
 * Recent Wallet Activity rows for invoices a customer paid into this organization's wallet.
 *
 * An invoice is paid through the provider's hosted payment link, so no payment_transfers row
 * (and so no wallet ledger entry) is written for it: without these rows a paid invoice never
 * shows in the wallet's activity. The invoice row (moov_invoices: amounts in dollars, status,
 * paid_amount and paid_at as the provider last reported them on sync) is the only local record.
 *
 * - A paid amount (status paid, or a partial paid_amount) is a completed credit, dated paid_at.
 * - The unpaid balance of an invoice whose payment is in progress is a pending credit.
 * Drafts, unpaid or overdue invoices nobody has paid, canceled or void ones add nothing, and
 * other tenants or environments are never shown.
 */
import { isInvoiceBeingPaid, type InvoicePendingRow } from "./invoicePendingIn.ts";

export interface InvoiceActivitySourceRow extends InvoicePendingRow {
  paid_at?: string | null;
  sent_at?: string | null;
  last_synced_at?: string | null;
  updated_at?: string | null;
  created_at?: string | null;
}

export interface InvoiceActivityRow {
  key: string;
  invoiceId: string;
  at: string;
  title: string;
  subtitle: string;
  status: "completed" | "pending";
  amountCents: number;
}

const toCents = (dollars: number | string | null | undefined): number => {
  const value = Number(dollars ?? 0);
  return Number.isFinite(value) ? Math.round(value * 100) : 0;
};

const NO_PAYMENT = new Set(["draft", "canceled", "cancelled", "void"]);

const firstDate = (...values: Array<string | null | undefined>): string | null => {
  for (const value of values) {
    if (value && Number.isFinite(new Date(value).getTime())) return value;
  }
  return null;
};

const describe = (row: InvoiceActivitySourceRow): string => {
  const number = String(row.invoice_number || "").trim();
  const customer = String(row.customer_name || "").trim();
  const label = number ? `Invoice ${number}` : "Invoice";
  return customer ? `${label} · ${customer}` : label;
};

export function invoiceWalletActivity(
  invoices: InvoiceActivitySourceRow[],
  { tenantId, environment }: { tenantId: string; environment?: string | null },
): InvoiceActivityRow[] {
  const rows: InvoiceActivityRow[] = [];
  for (const row of invoices || []) {
    if (!row || !row.id) continue;
    if (row.tenant_id && row.tenant_id !== tenantId) continue;
    if (environment && row.environment && row.environment !== environment) continue;
    const status = String(row.status || "").trim().toLowerCase();
    if (NO_PAYMENT.has(status)) continue;

    const totalCents = toCents(row.total_amount);
    const reportedPaidCents = toCents(row.paid_amount);
    // A paid invoice the provider reported without a paid amount was paid in full.
    const paidCents = status === "paid" && reportedPaidCents <= 0 ? totalCents : reportedPaidCents;

    if (paidCents > 0) {
      const at = firstDate(row.paid_at, row.last_synced_at, row.updated_at, row.created_at);
      if (at) {
        rows.push({
          key: `invoice-paid-${row.id}`,
          invoiceId: row.id,
          at,
          title: "Invoice payment received",
          subtitle: describe(row),
          status: "completed",
          amountCents: paidCents,
        });
      }
    }

    if (isInvoiceBeingPaid(row.status)) {
      const pendingCents = Math.max(totalCents - reportedPaidCents, 0);
      const at = firstDate(row.last_synced_at, row.updated_at, row.sent_at, row.created_at);
      if (pendingCents > 0 && at) {
        rows.push({
          key: `invoice-pending-${row.id}`,
          invoiceId: row.id,
          at,
          title: "Invoice payment in progress",
          subtitle: describe(row),
          status: "pending",
          amountCents: pendingCents,
        });
      }
    }
  }
  return rows;
}

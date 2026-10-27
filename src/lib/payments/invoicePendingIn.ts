/**
 * Invoices a customer is paying into this organization's wallet, counted as WalletOps "Pending in".
 *
 * An invoice is paid through the provider's hosted payment link, so no payment_transfers row is
 * written for it and the transfer-based Pending in never sees it. The invoice row (moov_invoices,
 * amounts in dollars, status as the provider last reported it) is the only local record of the
 * payment in flight. Only the unpaid balance of an invoice whose payment is in progress counts:
 * drafts, unpaid or overdue invoices nobody has paid yet, and paid or canceled ones do not.
 */

export interface InvoicePendingRow {
  id: string;
  tenant_id?: string | null;
  environment?: string | null;
  status?: string | null;
  total_amount?: number | string | null;
  paid_amount?: number | string | null;
  invoice_number?: string | null;
  customer_name?: string | null;
}

export interface InvoiceInFlight {
  id: string;
  invoice_number: string | null;
  customer_name: string | null;
  status: string;
  pending_cents: number;
}

const SETTLED_OR_CLOSED = new Set(["paid", "canceled", "cancelled", "void", "draft"]);

/** True for the provider's in-progress payment statuses (e.g. "payment-pending"). */
export function isInvoiceBeingPaid(status: string | null | undefined): boolean {
  const value = String(status || "").trim().toLowerCase();
  if (!value || SETTLED_OR_CLOSED.has(value)) return false;
  return /pending|processing|in[-_ ]?progress/.test(value);
}

const toCents = (dollars: number | string | null | undefined): number => {
  const value = Number(dollars ?? 0);
  return Number.isFinite(value) ? Math.round(value * 100) : 0;
};

export function invoicesInFlight(
  invoices: InvoicePendingRow[],
  { tenantId, environment }: { tenantId: string; environment?: string | null },
): InvoiceInFlight[] {
  return (invoices || [])
    .filter((row) => row && (!row.tenant_id || row.tenant_id === tenantId))
    .filter((row) => !environment || !row.environment || row.environment === environment)
    .filter((row) => isInvoiceBeingPaid(row.status))
    .map((row) => ({
      id: row.id,
      invoice_number: row.invoice_number ?? null,
      customer_name: row.customer_name ?? null,
      status: String(row.status),
      pending_cents: Math.max(toCents(row.total_amount) - toCents(row.paid_amount), 0),
    }))
    .filter((row) => row.pending_cents > 0);
}

export function invoicePendingInCents(
  invoices: InvoicePendingRow[],
  options: { tenantId: string; environment?: string | null },
): number {
  return invoicesInFlight(invoices, options).reduce((sum, row) => sum + row.pending_cents, 0);
}

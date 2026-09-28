import { billingPeriodLabel, money, snapshottedRateLabel, type ConsolidatedInvoice } from "@/lib/billing/tenantBilling";

export function ConsolidatedInvoicePreview({
  invoice,
  title,
  fundingLast4,
  destinationLabel,
}: {
  invoice: ConsolidatedInvoice;
  title?: string;
  fundingLast4?: string | null;
  destinationLabel?: string | null;
}) {
  return (
    <div className="rounded-lg border bg-card">
      <div className="px-4 py-3 border-b">
        <div className="text-sm font-semibold">
          {title || `Invoice ${billingPeriodLabel(invoice.billing_period)}`}
        </div>
        <div className="text-[11px] text-muted-foreground">
          Server-calculated consolidated amount. Rates come from snapshotted usage lines.
        </div>
      </div>
      <table className="w-full text-sm">
        <tbody className="divide-y">
          <tr>
            <td className="px-4 py-2">Maintenance</td>
            <td className="px-4 py-2 text-right tabular-nums">{money(invoice.maintenance_rate_cents)}</td>
          </tr>
          <tr>
            <td className="px-4 py-2 text-emerald-700">Discount</td>
            <td className="px-4 py-2 text-right tabular-nums text-emerald-700">
              {invoice.discount_cents ? `−${money(invoice.discount_cents)}` : money(0)}
            </td>
          </tr>
          <tr>
            <td className="px-4 py-2">Maintenance net</td>
            <td className="px-4 py-2 text-right tabular-nums">{money(invoice.maintenance_net_cents)}</td>
          </tr>
          <tr>
            <td className="px-4 py-2">
              Check processing
              <span className="block text-[11px] text-muted-foreground">{invoice.check_count} checks</span>
            </td>
            <td className="px-4 py-2 text-right tabular-nums">{money(invoice.check_usage_cents)}</td>
          </tr>
          <tr>
            <td className="px-4 py-2">
              Next Day
              <span className="block text-[11px] text-muted-foreground">{invoice.next_day_count} transactions</span>
            </td>
            <td className="px-4 py-2 text-right tabular-nums">{money(invoice.next_day_usage_cents)}</td>
          </tr>
          <tr>
            <td className="px-4 py-2">
              Same Day
              <span className="block text-[11px] text-muted-foreground">{invoice.same_day_count} transactions</span>
            </td>
            <td className="px-4 py-2 text-right tabular-nums">{money(invoice.same_day_usage_cents)}</td>
          </tr>
          <tr>
            <td className="px-4 py-2">
              Mortgage Ops — First Check
              <span className="block text-[11px] text-muted-foreground">
                {snapshottedRateLabel(invoice.lines?.mortgage_ops_initial, 1000)}
              </span>
            </td>
            <td className="px-4 py-2 text-right tabular-nums">{money(invoice.mortgage_ops_initial_amount_cents)}</td>
          </tr>
          <tr>
            <td className="px-4 py-2">
              Mortgage Ops — Additional Check
              <span className="block text-[11px] text-muted-foreground">
                {snapshottedRateLabel(invoice.lines?.mortgage_ops_additional, 500)}
              </span>
            </td>
            <td className="px-4 py-2 text-right tabular-nums">{money(invoice.mortgage_ops_additional_amount_cents)}</td>
          </tr>
          <tr className="bg-muted/30">
            <td className="px-4 py-2 font-semibold">Current amount due</td>
            <td className="px-4 py-2 text-right tabular-nums font-bold">{money(invoice.amount_cents)}</td>
          </tr>
        </tbody>
      </table>
      {(fundingLast4 || destinationLabel) && (
        <div className="px-4 py-3 border-t text-[11px] text-muted-foreground space-y-1">
          {fundingLast4 ? <div>Funding source: ••••{fundingLast4}</div> : null}
          {destinationLabel ? <div>Destination: {destinationLabel}</div> : null}
        </div>
      )}
    </div>
  );
}

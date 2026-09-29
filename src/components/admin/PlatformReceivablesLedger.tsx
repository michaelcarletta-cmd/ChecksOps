import { Fragment, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Separator } from "@/components/ui/separator";

export type CollectionLeg = {
  leg_type?: string;
  amount_cents?: number;
  provider_transfer_id?: string | null;
  status?: string;
  provider_status?: string;
  idempotency_key?: string;
  submitted_at?: string | null;
  completed_at?: string | null;
};

export type ReceivableRow = {
  tenant_id: string;
  tenant_name: string;
  billing_month: string | null;
  billing_period_label: string;
  fee_type: string;
  kind: string;
  amount_billed_cents: number;
  amount_received_cents: number;
  balance_cents: number;
  wallet_applied_cents?: number;
  bank_ach_cents?: number;
  collection_legs?: CollectionLeg[];
  payment_status: string;
  ach_status: string | null;
  initiated_at: string | null;
  received_at: string | null;
  provider_transfer_id: string | null;
  local_operation_id: string;
  line_items: { label: string; amount_cents: number }[];
  exceptions: string[];
};

export type ReceivableTotals = {
  amount_billed_cents: number;
  amount_collected_cents: number;
  outstanding_cents: number;
  pending_cents: number;
  failed_returned_cents: number;
  row_count: number;
};

const money = (cents: number) =>
  (Number(cents || 0) / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

const statusTone = (status: string) => {
  if (status === "SETTLED") return "bg-emerald-500/15 text-emerald-400 border-emerald-500/30";
  if (status === "ORIGINATED" || status === "SUBMITTED" || status === "SCHEDULED" || status === "PARTIALLY PAID") {
    return "bg-amber-500/15 text-amber-400 border-amber-500/30";
  }
  if (status === "FAILED" || status === "RETURNED" || status === "PARTIALLY PAID / BANK FAILED" || status === "RECONCILIATION REQUIRED") {
    return "bg-red-500/15 text-red-400 border-red-500/30";
  }
  return "text-muted-foreground";
};

export function PlatformReceivablesLedger({
  rows,
  totals,
  showTenantFilter = true,
  onFilterChange,
}: {
  rows: ReceivableRow[];
  totals?: ReceivableTotals | null;
  showTenantFilter?: boolean;
  onFilterChange?: (next: { billingMonth: string; tenantId: string; paymentStatus: string }) => void;
}) {
  const [billingMonth, setBillingMonth] = useState("all");
  const [tenantId, setTenantId] = useState("all");
  const [paymentStatus, setPaymentStatus] = useState("all");
  const [openId, setOpenId] = useState<string | null>(null);

  const months = useMemo(
    () => [...new Set(rows.map((row) => row.billing_month).filter(Boolean))] as string[],
    [rows],
  );
  const tenants = useMemo(() => {
    const map = new Map<string, string>();
    for (const row of rows) map.set(row.tenant_id, row.tenant_name);
    return [...map.entries()];
  }, [rows]);
  const statuses = useMemo(
    () => [...new Set(rows.map((row) => row.payment_status))],
    [rows],
  );
  const visible = useMemo(
    () => rows.filter((row) => (
      (billingMonth === "all" || row.billing_month === billingMonth)
      && (tenantId === "all" || row.tenant_id === tenantId)
      && (paymentStatus === "all" || row.payment_status === paymentStatus)
    )),
    [rows, billingMonth, tenantId, paymentStatus],
  );
  const visibleTotals = useMemo(() => {
    const seen = new Set<string>();
    const next = {
      amount_billed_cents: 0,
      amount_collected_cents: 0,
      outstanding_cents: 0,
      pending_cents: 0,
      failed_returned_cents: 0,
      row_count: 0,
    };
    for (const row of visible) {
      const key = row.provider_transfer_id || `local:${row.local_operation_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      next.amount_billed_cents += row.amount_billed_cents;
      next.amount_collected_cents += row.amount_received_cents;
      next.outstanding_cents += row.balance_cents;
      if (["DUE", "SCHEDULED", "SUBMITTED", "ORIGINATED"].includes(row.payment_status)) {
        next.pending_cents += row.amount_billed_cents;
      }
      if (["FAILED", "RETURNED"].includes(row.payment_status)) {
        next.failed_returned_cents += row.amount_billed_cents;
      }
      next.row_count += 1;
    }
    return next;
  }, [visible]);

  const emit = (next: { billingMonth: string; tenantId: string; paymentStatus: string }) => {
    onFilterChange?.(next);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Tenant payments / receivables</CardTitle>
        <CardDescription>
          Tenant attribution comes from the ChecksOps billing operation that created the transfer — not bank name or last4.
          Pending or originated ACH is not treated as received.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-2">
          <Select
            value={billingMonth}
            onValueChange={(value) => {
              setBillingMonth(value);
              emit({ billingMonth: value, tenantId, paymentStatus });
            }}
          >
            <SelectTrigger className="w-[160px] h-8"><SelectValue placeholder="Billing month" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All months</SelectItem>
              {months.map((month) => (
                <SelectItem key={month} value={month}>{month}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          {showTenantFilter && (
            <Select
              value={tenantId}
              onValueChange={(value) => {
                setTenantId(value);
                emit({ billingMonth, tenantId: value, paymentStatus });
              }}
            >
              <SelectTrigger className="w-[220px] h-8"><SelectValue placeholder="Tenant" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All tenants</SelectItem>
                {tenants.map(([id, name]) => (
                  <SelectItem key={id} value={id}>{name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Select
            value={paymentStatus}
            onValueChange={(value) => {
              setPaymentStatus(value);
              emit({ billingMonth, tenantId, paymentStatus: value });
            }}
          >
            <SelectTrigger className="w-[160px] h-8"><SelectValue placeholder="Status" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {statuses.map((status) => (
                <SelectItem key={status} value={status}>{status}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {(visibleTotals || totals) && (
          <div className="grid gap-3 sm:grid-cols-5">
            {[
              ["Billed", visibleTotals.amount_billed_cents],
              ["Collected", visibleTotals.amount_collected_cents],
              ["Outstanding", visibleTotals.outstanding_cents],
              ["Pending", visibleTotals.pending_cents],
              ["Failed / returned", visibleTotals.failed_returned_cents],
            ].map(([label, cents]) => (
              <div key={String(label)} className="rounded-lg border p-3">
                <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
                <p className="text-lg font-semibold">{money(Number(cents))}</p>
              </div>
            ))}
          </div>
        )}

        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Tenant</TableHead>
                <TableHead>Billing month</TableHead>
                <TableHead>Fee type</TableHead>
                <TableHead className="text-right">Due</TableHead>
                <TableHead className="text-right">Wallet</TableHead>
                <TableHead className="text-right">Bank ACH</TableHead>
                <TableHead className="text-right">Received</TableHead>
                <TableHead className="text-right">Outstanding</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Initiated</TableHead>
                <TableHead>Settled</TableHead>
                <TableHead>Provider transfer</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
                  {visible.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={12} className="text-center text-sm text-muted-foreground py-8">
                    No tenant-fee receivables for this filter.
                  </TableCell>
                </TableRow>
              ) : visible.map((row) => (
                <Fragment key={row.local_operation_id}>
                  <TableRow
                    className="cursor-pointer"
                    onClick={() => setOpenId(openId === row.local_operation_id ? null : row.local_operation_id)}
                  >
                    <TableCell className="max-w-[180px] truncate">{row.tenant_name}</TableCell>
                    <TableCell>{row.billing_period_label}</TableCell>
                    <TableCell>{row.fee_type}</TableCell>
                    <TableCell className="text-right">{money(row.amount_billed_cents)}</TableCell>
                    <TableCell className="text-right">{money(row.wallet_applied_cents ?? 0)}</TableCell>
                    <TableCell className="text-right">{money(row.bank_ach_cents ?? 0)}</TableCell>
                    <TableCell className="text-right">{money(row.amount_received_cents)}</TableCell>
                    <TableCell className="text-right">{money(row.balance_cents)}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className={statusTone(row.payment_status)}>
                        {row.payment_status}
                        {row.ach_status ? ` · ${row.ach_status}` : ""}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {row.initiated_at ? new Date(row.initiated_at).toLocaleDateString() : "—"}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {row.received_at ? new Date(row.received_at).toLocaleDateString() : "—"}
                    </TableCell>
                    <TableCell className="font-mono text-[11px]">
                      {row.provider_transfer_id ? `${row.provider_transfer_id.slice(0, 8)}…` : "—"}
                    </TableCell>
                  </TableRow>
                  {openId === row.local_operation_id && (
                    <TableRow key={`${row.local_operation_id}-details`}>
                      <TableCell colSpan={12}>
                        <div className="space-y-2 text-sm">
                          {row.line_items?.length ? (
                            <div className="space-y-1">
                              {row.line_items.map((item) => (
                                <div key={`${item.label}-${item.amount_cents}`} className="flex justify-between">
                                  <span>{item.label}</span>
                                  <span>{money(item.amount_cents)}</span>
                                </div>
                              ))}
                              <Separator />
                              <div className="flex justify-between font-medium">
                                <span>Total</span>
                                <span>{money(row.amount_billed_cents)}</span>
                              </div>
                            </div>
                          ) : (
                            <p className="text-muted-foreground">No stored fee breakdown on this operation.</p>
                          )}
                          {!!row.collection_legs?.length && (
                            <div className="space-y-1 pt-2">
                              {row.collection_legs.map((leg, index) => (
                                <div key={leg.idempotency_key || `${leg.leg_type}-${index}`} className="flex justify-between text-xs">
                                  <span>
                                    {leg.leg_type === "wallet" ? "Wallet provider transfer" : "Bank provider transfer"}
                                    {leg.provider_transfer_id ? ` ${leg.provider_transfer_id}` : ""}
                                    {` · ${leg.provider_status || leg.status || "unknown"}`}
                                  </span>
                                  <span>{money(Number(leg.amount_cents || 0))}</span>
                                </div>
                              ))}
                            </div>
                          )}
                          <p className="text-xs text-muted-foreground">
                            Local operation {row.local_operation_id}
                            {row.provider_transfer_id ? ` · Provider ${row.provider_transfer_id}` : ""}
                          </p>
                          {!!row.exceptions?.length && (
                            <p className="text-xs text-amber-500">Exceptions: {row.exceptions.join(", ")}</p>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

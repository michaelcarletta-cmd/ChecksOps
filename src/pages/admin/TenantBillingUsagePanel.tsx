import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast as sonnerToast } from "sonner";
import { Loader2, Receipt, RefreshCw } from "lucide-react";
import { SectionCard } from "@/components/settings/SectionCard";
import {
  SAME_DAY_DISBURSEMENT_CENTS,
  NEXT_DAY_DISBURSEMENT_CENTS,
  billedUnitRateCents,
  countDisbursementFees,
} from "@/lib/tenantBillingUsage";

function eventAmount(events: any[], eventType: string) {
  return events.filter((e) => e.event_type === eventType).reduce((s, e) => s + (e.unit_price_cents ?? 0), 0);
}

function eventCount(events: any[], eventType: string) {
  return events.filter((e) => e.event_type === eventType).length;
}

type UsageLine = {
  type: string;
  quantity: string;
  rate: string;
  amountCents: number;
  note?: string;
};

function UsageLinesTable({
  title,
  period,
  description,
  lines,
  totalLabel,
  totalCents,
  fmt,
}: {
  title: string;
  period: string;
  description: string;
  lines: UsageLine[];
  totalLabel: string;
  totalCents: number;
  fmt: (cents: number) => string;
}) {
  return (
    <div className="rounded-lg border">
      <div className="px-4 py-3 border-b bg-muted/30">
        <h4 className="text-sm font-semibold">{title}</h4>
        <p className="text-[11px] text-muted-foreground">Billing period: {period}</p>
        <p className="text-[11px] text-muted-foreground">{description}</p>
      </div>
      <table className="w-full text-sm">
        <thead className="text-[10px] uppercase text-muted-foreground bg-muted/20">
          <tr>
            <th className="text-left px-4 py-2 font-medium">Fee / event type</th>
            <th className="text-right px-4 py-2 font-medium">Quantity</th>
            <th className="text-right px-4 py-2 font-medium">Unit rate</th>
            <th className="text-right px-4 py-2 font-medium">Amount</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {lines.map((line) => (
            <tr key={line.type}>
              <td className="px-4 py-2">
                {line.type}
                {line.note && <div className="text-[10px] text-muted-foreground">{line.note}</div>}
              </td>
              <td className="text-right px-4 py-2 tabular-nums">{line.quantity}</td>
              <td className="text-right px-4 py-2 tabular-nums text-muted-foreground">{line.rate}</td>
              <td className={`text-right px-4 py-2 tabular-nums font-medium ${line.amountCents < 0 ? "text-emerald-600" : ""}`}>
                {line.amountCents < 0 ? `−${fmt(Math.abs(line.amountCents))}` : fmt(line.amountCents)}
              </td>
            </tr>
          ))}
          <tr className="bg-muted/30">
            <td className="px-4 py-2 font-semibold" colSpan={3}>{totalLabel}</td>
            <td className="text-right px-4 py-2 tabular-nums font-bold text-base">{fmt(totalCents)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

async function readFnError(error: any): Promise<string> {
  try {
    const parsed = await error?.context?.json?.();
    if (parsed?.error) return parsed.error;
    if (parsed?.message) return parsed.message;
  } catch {
    /* fall through */
  }
  return error?.message || "Request failed";
}

async function loadUsageRange(tenantId: string, start: Date, end: Date) {
  const startISO = start.toISOString();
  const endISO = new Date(end.getTime() - 1).toISOString();
  const [usageRes, moovRes, batchRes, splitRes] = await Promise.all([
    supabase.rpc("get_tenant_check_usage", {
      _tenant_id: tenantId,
      _month_start: startISO,
      _month_end: endISO,
    } as any),
    supabase
      .from("payment_transfers")
      .select("id, amount_cents, status, created_at")
      .eq("provider", "moov")
      .eq("tenant_id", tenantId)
      .gte("created_at", start.toISOString())
      .lt("created_at", end.toISOString()),
    supabase
      .from("disbursement_batches")
      .select("id, delivery_speed, status, created_at")
      .eq("tenant_id", tenantId)
      .gte("created_at", start.toISOString())
      .lt("created_at", end.toISOString()),
    supabase
      .from("disbursement_splits")
      .select("id, status, requested_speed, batch_id, created_at")
      .eq("tenant_id", tenantId)
      .gte("created_at", start.toISOString())
      .lt("created_at", end.toISOString()),
  ]);
  if (usageRes.error) throw usageRes.error;
  const events: any[] = usageRes.data?.events || [];
  const fees = countDisbursementFees(batchRes.data, splitRes.data);
  return {
    events,
    currency: usageRes.data?.currency || "usd",
    mortgageCount: usageRes.data?.mortgage_count || eventCount(events, "mortgage_handling"),
    checkCount: eventCount(events, "check_processing"),
    checkCents: eventAmount(events, "check_processing"),
    mortgageCents: eventAmount(events, "mortgage_handling"),
    sameDay: fees.sameDay,
    nextDay: fees.nextDay,
    sameDayCents: fees.sameDay * SAME_DAY_DISBURSEMENT_CENTS,
    nextDayCents: fees.nextDay * NEXT_DAY_DISBURSEMENT_CENTS,
    transferCount: moovRes.data?.length ?? 0,
    transferVolumeCents: (moovRes.data ?? [])
      .filter((r: any) => r.status === "completed")
      .reduce((s: number, r: any) => s + Number(r.amount_cents ?? 0), 0),
  };
}

export function TenantUsageInlinePanel({ tenantId, tenantName }: { tenantId: string; tenantName: string }) {
  const now = new Date();
  const [scope, setScope] = useState<"month" | "year">("month");
  const [month, setMonth] = useState(now.getMonth());
  const [year, setYear] = useState(now.getFullYear());
  const [period, setPeriod] = useState<any>(null);
  const [ytd, setYtd] = useState<any>(null);
  const [maintenance, setMaintenance] = useState<any[]>([]);
  const [tenantMeta, setTenantMeta] = useState<{
    monthly_rate_cents: number;
    referral_discount_cents: number;
    is_founding_partner: boolean;
    per_check_rate_cents: number;
    is_test_account: boolean;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pulling, setPulling] = useState(false);

  const monthStart = new Date(year, month, 1);
  const monthEnd = new Date(year, month + 1, 1);
  const yearStart = new Date(year, 0, 1);
  const yearEnd = new Date(year + 1, 0, 1);
  const periodLabel = monthStart.toLocaleDateString("en-US", { month: "long", year: "numeric" });
  const ytdLabel = `${year} year-to-date`;

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [monthUsage, yearUsage, maintRes, tenantRes] = await Promise.all([
        loadUsageRange(tenantId, monthStart, monthEnd),
        loadUsageRange(tenantId, yearStart, yearEnd),
        supabase
          .from("tenant_maintenance_payments")
          .select("id, amount_cents, status, received_at, period_start, period_end, method, reference, failure_reason")
          .eq("tenant_id", tenantId)
          .gte("received_at", yearStart.toISOString())
          .lt("received_at", yearEnd.toISOString())
          .order("received_at", { ascending: false }),
        supabase
          .from("tenants")
          .select("monthly_rate_cents, referral_discount_cents, is_founding_partner, per_check_rate_cents, is_test_account")
          .eq("id", tenantId)
          .maybeSingle(),
      ]);
      setPeriod(monthUsage);
      setYtd(yearUsage);
      setMaintenance(maintRes.data ?? []);
      setTenantMeta(tenantRes.data as any ?? null);
    } catch (e: any) {
      setError(e.message);
    }
    setLoading(false);
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [tenantId, month, year]);

  const fmt = (cents: number) =>
    new Intl.NumberFormat("en-US", { style: "currency", currency: (period?.currency || ytd?.currency || "usd").toUpperCase() }).format((cents || 0) / 100);

  const cards = scope === "year" ? ytd : period;
  const months = Array.from({ length: 12 }, (_, i) => ({ v: i, l: new Date(2020, i, 1).toLocaleString("en-US", { month: "long" }) }));
  const years = Array.from({ length: 5 }, (_, i) => now.getFullYear() - i);

  const paidStatuses = new Set(["cleared", "recorded", "submitted"]);
  const yearCollectedCents = maintenance
    .filter((r) => paidStatuses.has(r.status))
    .reduce((s, r) => s + (r.amount_cents ?? 0), 0);
  const periodCollectedCents = maintenance
    .filter((r) => {
      if (!paidStatuses.has(r.status)) return false;
      const start = r.period_start ? new Date(r.period_start) : new Date(r.received_at);
      return start >= monthStart && start < monthEnd;
    })
    .reduce((s, r) => s + (r.amount_cents ?? 0), 0);

  const standardRateCents = tenantMeta?.per_check_rate_cents ?? 0;
  const grossMaintenance = tenantMeta?.monthly_rate_cents ?? 0;
  const discount = tenantMeta?.referral_discount_cents ?? 0;
  const periodCheckRate = billedUnitRateCents(period?.events || [], "check_processing", standardRateCents);
  const periodMortgageRate = billedUnitRateCents(period?.events || [], "mortgage_handling", 1000);
  const ytdCheckRate = billedUnitRateCents(ytd?.events || [], "check_processing", standardRateCents);
  const ytdMortgageRate = billedUnitRateCents(ytd?.events || [], "mortgage_handling", 1000);

  const periodUsageCents = (period?.checkCents ?? 0) + (period?.mortgageCents ?? 0) + (period?.sameDayCents ?? 0) + (period?.nextDayCents ?? 0);
  const periodTotalCents = periodUsageCents + grossMaintenance - discount;
  const periodOutstandingCents = Math.max(0, periodTotalCents - periodCollectedCents);
  const ytdUsageCents = (ytd?.checkCents ?? 0) + (ytd?.mortgageCents ?? 0) + (ytd?.sameDayCents ?? 0) + (ytd?.nextDayCents ?? 0);
  const ytdRecordedMaintenance = yearCollectedCents;
  const hasYtdMaintenanceRecords = maintenance.some((r) => paidStatuses.has(r.status));

  const periodLines: UsageLine[] = period ? [
    {
      type: "Check processing",
      quantity: `${period.checkCount} events`,
      rate: periodCheckRate.mixed ? "mixed billed rates" : fmt(periodCheckRate.cents),
      amountCents: period.checkCents,
      note: periodCheckRate.mixed
        ? "Amount is the sum of check_billing_events.unit_price_cents"
        : "check_billing_events.check_processing",
    },
    {
      type: "Mortgage handling",
      quantity: `${period.mortgageCount} events`,
      rate: periodMortgageRate.mixed ? "mixed billed rates" : fmt(periodMortgageRate.cents),
      amountCents: period.mortgageCents,
      note: "check_billing_events.mortgage_handling",
    },
    {
      type: "Same-day disbursement",
      quantity: `${period.sameDay} payments`,
      rate: fmt(SAME_DAY_DISBURSEMENT_CENTS),
      amountCents: period.sameDayCents,
      note: "COALESCE(disbursement_splits.requested_speed, disbursement_batches.delivery_speed)=same_day",
    },
    {
      type: "Next-day disbursement",
      quantity: `${period.nextDay} payments`,
      rate: fmt(NEXT_DAY_DISBURSEMENT_CENTS),
      amountCents: period.nextDayCents,
      note: "COALESCE(disbursement_splits.requested_speed, disbursement_batches.delivery_speed)=next_day",
    },
    {
      type: "Monthly maintenance",
      quantity: "1 mo",
      rate: fmt(grossMaintenance),
      amountCents: grossMaintenance,
      note: tenantMeta?.is_founding_partner
        ? "Current tenants.monthly_rate_cents · founding partner"
        : "Current tenants.monthly_rate_cents pricing setting",
    },
    ...(discount > 0 ? [{
      type: "Referral discount",
      quantity: "—",
      rate: `−${fmt(discount)}`,
      amountCents: -discount,
      note: "Current tenants.referral_discount_cents",
    }] : []),
    {
      type: "Moov / payment transfers",
      quantity: `${period.transferCount} transfers`,
      rate: fmt(0),
      amountCents: 0,
      note: "Volume/activity only — not a ChecksOps fee. Do not add payment_transfers again.",
    },
  ] : [];

  const ytdLines: UsageLine[] = ytd ? [
    {
      type: "YTD check processing",
      quantity: `${ytd.checkCount} events`,
      rate: ytdCheckRate.mixed ? "mixed billed rates" : fmt(ytdCheckRate.cents),
      amountCents: ytd.checkCents,
      note: "check_billing_events.check_processing",
    },
    {
      type: "YTD mortgage handling",
      quantity: `${ytd.mortgageCount} events`,
      rate: ytdMortgageRate.mixed ? "mixed billed rates" : fmt(ytdMortgageRate.cents),
      amountCents: ytd.mortgageCents,
      note: "check_billing_events.mortgage_handling",
    },
    {
      type: "YTD same-day disbursement",
      quantity: `${ytd.sameDay} payments`,
      rate: fmt(SAME_DAY_DISBURSEMENT_CENTS),
      amountCents: ytd.sameDayCents,
    },
    {
      type: "YTD next-day disbursement",
      quantity: `${ytd.nextDay} payments`,
      rate: fmt(NEXT_DAY_DISBURSEMENT_CENTS),
      amountCents: ytd.nextDayCents,
    },
    {
      type: "YTD recorded maintenance",
      quantity: hasYtdMaintenanceRecords ? `${maintenance.filter((r) => paidStatuses.has(r.status)).length} records` : "none recorded",
      rate: hasYtdMaintenanceRecords ? "from payment records" : "—",
      amountCents: hasYtdMaintenanceRecords ? ytdRecordedMaintenance : 0,
      note: hasYtdMaintenanceRecords
        ? "tenant_maintenance_payments only. Current monthly_rate_cents is not multiplied across prior months."
        : "No authoritative maintenance invoices for prior months. Current monthly_rate_cents is a pricing setting, not historical billing.",
    },
    {
      type: "YTD recorded discounts",
      quantity: "none recorded",
      rate: "—",
      amountCents: 0,
      note: "Shown only when tenant_maintenance_payments or other billing records support a discount. The current referral_discount_cents setting is not applied retroactively.",
    },
    {
      type: "YTD Moov / payment transfers",
      quantity: `${ytd.transferCount} transfers`,
      rate: fmt(0),
      amountCents: 0,
      note: "Volume/activity only — not a ChecksOps fee.",
    },
  ] : [];

  const pullConsolidated = async () => {
    if (periodTotalCents <= 0) {
      sonnerToast.warning("Nothing to charge for this period.");
      return;
    }
    const confirmed = window.confirm(
      `Preview $${(periodTotalCents / 100).toFixed(2)} for ${tenantName}? ACH will not be submitted.`,
    );
    if (!confirmed) return;
    setPulling(true);
    const line_items = [
      (period?.checkCents ?? 0) > 0 && { label: "Check processing", detail: `${period.checkCount} checks`, amount_cents: period.checkCents },
      (period?.sameDayCents ?? 0) > 0 && { label: "Same-day disbursements", detail: `${period.sameDay} payments`, amount_cents: period.sameDayCents },
      (period?.nextDayCents ?? 0) > 0 && { label: "Next-day disbursements", detail: `${period.nextDay} payments`, amount_cents: period.nextDayCents },
      (period?.mortgageCents ?? 0) > 0 && { label: "MortgageOps handling", detail: `${period.mortgageCount} requests`, amount_cents: period.mortgageCents },
      grossMaintenance > 0 && { label: "Monthly maintenance", detail: periodLabel, amount_cents: grossMaintenance },
      discount > 0 && { label: "Referral discount", detail: "applied to maintenance", amount_cents: -discount },
    ].filter(Boolean);

    const { data: resp, error } = await supabase.functions.invoke("moov-tenant-fee-charge", {
      body: {
        tenant_id: tenantId,
        amount_cents: periodTotalCents,
        kind: "consolidated",
        line_items,
        period_label: periodLabel,
        send_invoice: true,
      },
    });
    setPulling(false);
    const failure = (resp as any)?.error ?? (error ? await readFnError(error) : null);
    if (failure) return sonnerToast.error(failure);
    const r = (resp as any)?.results?.[0];
    if ((resp as any)?.dark || r?.status === "preview") {
      sonnerToast.info(`Preview only: ${fmt(r?.amount_cents ?? periodTotalCents)}. ACH was not submitted.`);
      return;
    }
    if (r?.status === "submitted") {
      sonnerToast.success(`ACH debit for $${(r.amount_cents / 100).toFixed(2)} submitted`);
      load();
    } else sonnerToast.info(JSON.stringify(r ?? resp));
  };

  return (
    <SectionCard
      title={`Billing & Usage — ${scope === "year" ? ytdLabel : periodLabel}`}
      icon={<Receipt className="h-4 w-4 text-emerald-500" />}
      accent="bg-gradient-to-r from-emerald-500 to-emerald-500/30"
      description="Current billing period and year-to-date usage from established ChecksOps sources. ACH is not submitted in this environment."
    >
      <div className="flex items-center gap-2 flex-wrap">
        <Select value={scope} onValueChange={(v) => setScope(v as any)}>
          <SelectTrigger className="w-[110px] h-8"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="month">Month</SelectItem>
            <SelectItem value="year">Year</SelectItem>
          </SelectContent>
        </Select>
        <Select value={String(month)} onValueChange={(v) => setMonth(parseInt(v))}>
          <SelectTrigger className="w-[130px] h-8"><SelectValue /></SelectTrigger>
          <SelectContent>
            {months.map((m) => <SelectItem key={m.v} value={String(m.v)}>{m.l}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={String(year)} onValueChange={(v) => setYear(parseInt(v))}>
          <SelectTrigger className="w-[90px] h-8"><SelectValue /></SelectTrigger>
          <SelectContent>
            {years.map((y) => <SelectItem key={y} value={String(y)}>{y}</SelectItem>)}
          </SelectContent>
        </Select>
        <Button variant="ghost" size="sm" onClick={load} disabled={loading}>
          <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
        </Button>
        {tenantMeta?.is_test_account && (
          <Badge variant="outline" className="text-[10px] h-6 border-amber-500/40 text-amber-700">
            Test/sandbox — not production billable
          </Badge>
        )}
      </div>

      {error ? (
        <div className="text-sm text-destructive">{error}</div>
      ) : loading || !period || !ytd ? (
        <div className="flex justify-center py-10"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
      ) : (
        <div className="space-y-6">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="rounded-lg border bg-card p-3">
              <div className="text-[10px] text-muted-foreground uppercase tracking-wider">Check processing</div>
              <div className="text-2xl font-bold mt-1">{cards.checkCount}</div>
              <div className="text-[10px] text-muted-foreground mt-1">{fmt(cards.checkCents)}</div>
            </div>
            <div className="rounded-lg border bg-card p-3">
              <div className="text-[10px] text-muted-foreground uppercase tracking-wider">Mortgage handling</div>
              <div className="text-2xl font-bold mt-1">{cards.mortgageCount}</div>
              <div className="text-[10px] text-muted-foreground mt-1">{fmt(cards.mortgageCents)}</div>
            </div>
            <div className="rounded-lg border bg-card p-3">
              <div className="text-[10px] text-muted-foreground uppercase tracking-wider">Disbursement fees</div>
              <div className="text-2xl font-bold mt-1">{cards.sameDay + cards.nextDay}</div>
              <div className="text-[10px] text-muted-foreground mt-1">
                Same day {cards.sameDay} × $1.00 · Next day {cards.nextDay} × $0.75
              </div>
            </div>
            <div className="rounded-lg border bg-card p-3">
              <div className="text-[10px] text-muted-foreground uppercase tracking-wider">Collected / paid</div>
              <div className="text-2xl font-bold mt-1">{fmt(scope === "year" ? yearCollectedCents : periodCollectedCents)}</div>
              <div className="text-[10px] text-muted-foreground mt-1">tenant_maintenance_payments</div>
            </div>
          </div>

          <UsageLinesTable
            title="Current Billing Period"
            period={periodLabel}
            description={tenantMeta?.is_test_account
              ? "Test/sandbox tenant. This preview is not production billable and is not mixed into other tenants."
              : "Current-month usage plus the current monthly maintenance setting. ACH is not submitted in this environment."}
            lines={periodLines}
            totalLabel={tenantMeta?.is_test_account ? "Test preview — not production billable" : "Current-period total"}
            totalCents={periodTotalCents}
            fmt={fmt}
          />

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div className="rounded-lg border p-3">
              <div className="text-[10px] text-muted-foreground uppercase tracking-wider">Total charges</div>
              <div className="text-lg font-semibold mt-1">{fmt(periodTotalCents)}</div>
            </div>
            <div className="rounded-lg border p-3">
              <div className="text-[10px] text-muted-foreground uppercase tracking-wider">Amount collected / paid</div>
              <div className="text-lg font-semibold mt-1">{fmt(periodCollectedCents)}</div>
              <div className="text-[10px] text-muted-foreground">From tenant_maintenance_payments for this period</div>
            </div>
            <div className="rounded-lg border p-3">
              <div className="text-[10px] text-muted-foreground uppercase tracking-wider">Amount outstanding</div>
              <div className="text-lg font-semibold mt-1">{fmt(periodOutstandingCents)}</div>
              <div className="text-[10px] text-muted-foreground">
                {maintenance.length === 0
                  ? "Preview outstanding — not invoiced. No collection records for this tenant."
                  : "Preview outstanding (period total minus recorded payments). Not an invoiced AR balance."}
              </div>
            </div>
          </div>

          <div className="flex justify-end">
            <Button size="sm" onClick={pullConsolidated} disabled={pulling || periodTotalCents <= 0}>
              {pulling ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : null}
              Preview {fmt(periodTotalCents)}
            </Button>
          </div>

          <UsageLinesTable
            title="Year-to-Date Usage / Charges"
            period={ytdLabel}
            description="YTD usage from billing events and disbursement records. Recurring maintenance is included only when tenant_maintenance_payments exist. The current monthly_rate_cents setting is not multiplied across prior months."
            lines={ytdLines}
            totalLabel="YTD usage / recorded charges"
            totalCents={ytdUsageCents + (hasYtdMaintenanceRecords ? ytdRecordedMaintenance : 0)}
            fmt={fmt}
          />

          <div>
            <h4 className="text-sm font-semibold mb-2">Billing history ({maintenance.length})</h4>
            <div className="border rounded-lg max-h-56 overflow-y-auto divide-y">
              {maintenance.length === 0 ? (
                <div className="p-6 text-center text-sm text-muted-foreground italic">
                  No tenant_maintenance_payments records for {year}. Usage events appear in the detailed check log.
                </div>
              ) : (
                maintenance.map((p) => (
                  <div key={p.id} className="flex items-center justify-between px-3 py-2 text-xs">
                    <div>
                      <div className="font-medium">
                        {new Date(p.received_at).toLocaleDateString()}
                        {p.period_start && (
                          <span className="text-muted-foreground ml-2">
                            · {new Date(p.period_start).toLocaleDateString(undefined, { month: "short", year: "numeric" })}
                          </span>
                        )}
                      </div>
                      <div className="text-[10px] text-muted-foreground">
                        {p.method?.toUpperCase()} {p.reference && `· ${p.reference}`} {p.failure_reason && `· ${p.failure_reason}`}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="font-bold">{fmt(p.amount_cents)}</span>
                      <Badge variant="outline" className={`text-[9px] h-4 ${
                        p.status === "cleared" ? "border-emerald-500/40 text-emerald-500" :
                        p.status === "returned" || p.status === "failed" ? "border-destructive/40 text-destructive" :
                        "border-muted-foreground/30"
                      }`}>
                        {p.status}
                      </Badge>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          <div>
            <h4 className="text-sm font-semibold mb-2">
              Detailed check log ({scope === "year" ? ytd.events.length : period.events.length})
            </h4>
            <div className="border rounded-lg max-h-72 overflow-y-auto divide-y">
              {(scope === "year" ? ytd.events : period.events).length === 0 ? (
                <div className="p-6 text-center text-sm text-muted-foreground italic">No usage events for this range.</div>
              ) : (
                (scope === "year" ? ytd.events : period.events).map((e: any) => (
                  <div key={e.id} className="flex items-center justify-between px-3 py-2 text-xs">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{new Date(e.billed_at).toLocaleString()}</span>
                        <Badge variant="secondary" className="text-[9px] h-4 px-1 uppercase">
                          {(e.event_type || "processing").replace("_", " ")}
                        </Badge>
                      </div>
                      <div className="text-[10px] text-muted-foreground font-mono">
                        {e.check_number && <>Check #{e.check_number} · </>}
                        {e.payee_name && <>{e.payee_name} · </>}
                        {e.processed_by && <span className="text-primary/80">By: {e.processed_by}</span>}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="font-semibold">{fmt(e.unit_price_cents)}</div>
                      <Badge variant="outline" className="text-[9px] h-4 mt-0.5">{e.status}</Badge>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </SectionCard>
  );
}

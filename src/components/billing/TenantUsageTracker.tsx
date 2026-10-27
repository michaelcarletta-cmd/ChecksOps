import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useTenant } from "@/contexts/TenantContext";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ScrollArea } from "@/components/ui/scroll-area";
import { BarChart3, Receipt, Landmark, ArrowDownCircle, CheckCircle2, Calendar } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { format, startOfMonth, endOfMonth } from "date-fns";
import { displayCase } from "@/lib/displayCase";
import {
  disbursementDetails,
  disbursementVolumeCents,
  isSendFeeEvent,
  usageEventLabel,
  type SendLeg,
  type UsageCheck,
  type UsageClaim,
  type UsageFeeEvent,
} from "@/lib/billing/usageDisbursements";
import { FeeScheduleCard } from "@/components/billing/FeeScheduleCard";


export function TenantUsageTracker() {
  const { tenant } = useTenant();
  const [month, setMonth] = useState(format(new Date(), "yyyy-MM"));
  const now = new Date(month + "-01T00:00:00");
  const monthStart = startOfMonth(now).toISOString();
  const monthEnd = endOfMonth(now).toISOString();

  const monthOptions = Array.from({ length: 12 }, (_, i) => {
    const d = new Date();
    d.setDate(1);
    d.setMonth(d.getMonth() - i);
    return format(d, "yyyy-MM");
  });

  const { data: usage, isLoading: usageLoading } = useQuery({
    queryKey: ["tenant-usage", tenant?.id, month],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_tenant_check_usage", {
        _tenant_id: tenant!.id,
        _month_start: monthStart,
        _month_end: monthEnd,
      });
      if (error) throw error;
      return data as any;
    },
    enabled: !!tenant?.id,
  });

  // Disbursement fees: each next-day / same-day fee is linked to the payment it was charged for
  // (its first posted leg), not to the check. Load those payments, the check and its claim, so the
  // log names the check, the insured and the payee, and the card shows the amount sent.
  const { data: disbursements } = useQuery({
    queryKey: ["tenant-usage-disbursements", tenant?.id, monthStart, monthEnd],
    queryFn: async () => {
      const { data: events, error } = await supabase
        .from("check_billing_events")
        .select("id, event_type, payment_transfer_id, claim_id, status")
        .eq("tenant_id", tenant!.id)
        .in("event_type", ["moov_next_day", "moov_same_day", "moov_instant"])
        .neq("status", "voided")
        .gte("billed_at", monthStart)
        .lte("billed_at", monthEnd);
      if (error) throw error;
      const feeEvents = (events ?? []) as unknown as UsageFeeEvent[];
      const anchorIds = [...new Set(feeEvents.map((e) => e.payment_transfer_id).filter(Boolean))] as string[];
      if (!anchorIds.length) return disbursementDetails(feeEvents, [], [], []);
      const legColumns = "id, amount_cents, status, check_id, provider_metadata";
      const { data: anchors, error: anchorError } = await supabase
        .from("payment_transfers")
        .select(legColumns)
        .in("id", anchorIds);
      if (anchorError) throw anchorError;
      const checkIds = [...new Set(((anchors ?? []) as SendLeg[]).map((l) => l.check_id).filter(Boolean))] as string[];
      let legs = (anchors ?? []) as SendLeg[];
      let checks: UsageCheck[] = [];
      let claims: UsageClaim[] = [];
      if (checkIds.length) {
        const [siblings, checkRows] = await Promise.all([
          supabase.from("payment_transfers").select(legColumns)
            .in("check_id", checkIds).in("leg_role", ["send_wallet", "send_bank"]),
          supabase.from("check_intake_items").select("id, check_number, payee_line, claim_id").in("id", checkIds),
        ]);
        if (siblings.error) throw siblings.error;
        if (checkRows.error) throw checkRows.error;
        const seen = new Set(legs.map((l) => l.id));
        legs = [...legs, ...((siblings.data ?? []) as SendLeg[]).filter((l) => !seen.has(l.id))];
        checks = (checkRows.data ?? []) as UsageCheck[];
      }
      const claimIds = [...new Set([
        ...feeEvents.map((e) => e.claim_id),
        ...checks.map((c) => c.claim_id),
      ].filter(Boolean))] as string[];
      if (claimIds.length) {
        const { data: claimRows, error: claimError } = await supabase
          .from("claims")
          .select("id, claim_number, policyholder_name")
          .in("id", claimIds);
        if (claimError) throw claimError;
        claims = (claimRows ?? []) as UsageClaim[];
      }
      return disbursementDetails(feeEvents, legs, checks, claims);
    },
    enabled: !!tenant?.id,
  });

  // Mortgage-ops usage — completed requests inside the current billing month.
  // Each row contributes services_cents (default $10) + shipping_cents.
  const { data: mortgageOpsUsage } = useQuery({
    queryKey: ["tenant-mortgage-ops-usage", tenant?.id, monthStart, monthEnd],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("mortgage_handling_requests")
        .select("id, invoice_services_cents, invoice_shipping_cents, completed_at")
        .eq("tenant_id", tenant!.id)
        .not("completed_at", "is", null)
        .gte("completed_at", monthStart)
        .lte("completed_at", monthEnd);
      if (error) throw error;
      const rows = data ?? [];
      const totalCents = rows.reduce(
        (sum, r: any) =>
          sum + (r.invoice_services_cents ?? 1000) + (r.invoice_shipping_cents ?? 0),
        0,
      );
      return { count: rows.length, totalCents };
    },
    enabled: !!tenant?.id,
  });

  if (usageLoading) return <div className="p-8 text-center text-sm text-muted-foreground animate-pulse">Loading usage & funds data...</div>;

  const formatCurrency = (amount: number) => 
    new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(amount);

  // Amount sent in the disbursements whose fees are counted this month.
  const disbursementVolume = disbursements ? disbursementVolumeCents(disbursements) / 100 : 0;
  // The next-day / same-day fees charged for those disbursements (what the tenant is billed).
  const disbursementFees = (usage?.events ?? [])
    .filter((e: { event_type?: string | null }) => isSendFeeEvent(e.event_type))
    .reduce((sum: number, e: { unit_price_cents?: number | string | null }) => sum + Number(e.unit_price_cents ?? 0), 0) / 100;

  // The price on the latest check processing charge: the per-check price when the tenant has no rate of its own.
  const chargedCheckCents = (usage?.events ?? [])
    .filter((e: { event_type?: string | null }) => e.event_type === "check_processing")
    .map((e: { unit_price_cents?: number | string | null }) => Number(e.unit_price_cents))
    .find((cents: number) => Number.isFinite(cents)) ?? null;

  return (
    <div className="space-y-6">
      <FeeScheduleCard tenantId={tenant?.id} chargedCheckCents={chargedCheckCents} />
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card className="bg-gradient-to-br from-primary/10 to-blue-500/5 border-primary/20">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Receipt className="h-4 w-4 text-primary" />
              Check Processing Usage
            </CardTitle>
            <CardDescription className="text-[10px]">Usage for {format(now, "MMMM yyyy")}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-baseline gap-2">
              <span className="text-3xl font-bold">
                {usage?.events?.filter((e: any) => e.event_type === 'check_processing').length ?? 0}
              </span>
              <span className="text-xs text-muted-foreground">checks processed</span>
            </div>
            <p className="text-xs text-muted-foreground mt-2">
              Estimated fees: <span className="font-semibold text-foreground">
                {formatCurrency((usage?.events?.filter((e: any) => e.event_type === 'check_processing').reduce((s: number, e: any) => s + (e.unit_price_cents ?? 0), 0) ?? 0) / 100)}
              </span>
            </p>
          </CardContent>
        </Card>

        <Card className="bg-gradient-to-br from-amber-500/10 to-orange-500/5 border-amber-500/20">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Landmark className="h-4 w-4 text-amber-500" />
              MortgageOps Usage
            </CardTitle>
            <CardDescription className="text-[10px]">Handled by ChecksOps this month</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-baseline gap-2">
              <span className="text-3xl font-bold">
                {usage?.events?.filter((e: any) => e.event_type === 'mortgage_handling').length ?? 0}
              </span>
              <span className="text-xs text-muted-foreground">mortgage requests</span>
            </div>
            <p className="text-xs text-muted-foreground mt-2">
              Month-end total (services + shipping):{" "}
              <span className="font-semibold text-foreground">
                {formatCurrency((usage?.events?.filter((e: any) => e.event_type === 'mortgage_handling').reduce((s: number, e: any) => s + (e.unit_price_cents ?? 0), 0) ?? 0) / 100)}
              </span>
            </p>
          </CardContent>
        </Card>

        <Card className="bg-gradient-to-br from-emerald-500/10 to-teal-500/5 border-emerald-500/20">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Landmark className="h-4 w-4 text-emerald-500" />
              Disbursement Usage
            </CardTitle>
            <CardDescription className="text-[10px]">ACH payouts triggered this month</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-baseline gap-2">
              <span className="text-3xl font-bold text-emerald-600">
                {usage?.events?.filter((e: any) => isSendFeeEvent(e.event_type)).length ?? 0}
              </span>
              <span className="text-xs text-muted-foreground">transfers</span>
            </div>
            <p className="text-xs text-muted-foreground mt-2">
              Estimated fees: <span className="font-semibold text-foreground">{formatCurrency(disbursementFees)}</span>
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              Amount sent: <span className="font-semibold text-foreground">{formatCurrency(disbursementVolume)}</span>
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>

        <CardHeader className="pb-3 flex flex-row items-center justify-between gap-3 space-y-0">
          <div>
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <ArrowDownCircle className="h-4 w-4 text-primary" />
              Usage & Processing Log
            </CardTitle>
            <CardDescription className="text-[10px]">
              Showing {format(now, "MMMM yyyy")}
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Calendar className="h-4 w-4 text-muted-foreground" />
            <Select value={month} onValueChange={setMonth}>
              <SelectTrigger className="w-[170px] h-8 text-xs">
                <SelectValue placeholder="Select month" />
              </SelectTrigger>
              <SelectContent>
                {monthOptions.map((m) => (
                  <SelectItem key={m} value={m} className="text-xs">
                    {format(new Date(m + "-01T00:00:00"), "MMMM yyyy")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <ScrollArea className="h-[400px]">
            <Table>
              <TableHeader>
                <TableRow className="text-[10px] tracking-wider">
                  <TableHead className="pl-4">Date</TableHead>
                  <TableHead>Event / Item</TableHead>
                  <TableHead className="text-right">Estimated Fee</TableHead>
                  <TableHead className="text-center">Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {usage?.events?.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={4} className="h-24 text-center text-xs text-muted-foreground">No usage recorded for this period.</TableCell>
                  </TableRow>
                ) : (
                  usage?.events?.map((row: any) => {
                    const sent = isSendFeeEvent(row.event_type) ? disbursements?.get(row.id) : undefined;
                    const checkNumber = row.check_number || sent?.check_number;
                    const details = sent
                      ? [
                          sent.insured_name && `Insured: ${displayCase(sent.insured_name)}`,
                          sent.payee_name && `Paid to: ${displayCase(sent.payee_name)}`,
                          sent.amount_cents > 0 && `Sent ${formatCurrency(sent.amount_cents / 100)}`,
                        ].filter(Boolean).join(" · ")
                      : [displayCase(row.payee_name), row.processed_by].filter(Boolean).join(" · ");
                    return (
                    <TableRow key={row.id} className="hover:bg-muted/30">
                      <TableCell className="pl-4 text-xs text-muted-foreground">
                        {format(new Date(row.billed_at), "MMM d, h:mm a")}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col">
                          <span className="text-xs font-medium">
                            <Badge variant="secondary" className="text-[9px] h-4 px-1 py-0 mr-2">
                              {usageEventLabel(row.event_type)}
                            </Badge>
                            Check #{checkNumber || "—"}
                            {sent?.claim_number && (
                              <span className="text-muted-foreground font-normal"> · Claim {sent.claim_number}</span>
                            )}
                          </span>
                          <span className="text-[10px] text-muted-foreground truncate max-w-[320px]" title={details}>
                            {details}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell className="text-right text-xs font-semibold tabular-nums">
                        {formatCurrency(Number(row.unit_price_cents ?? 0) / 100)}
                      </TableCell>
                      <TableCell className="text-center">
                        <Badge 
                          variant="outline" 
                          className="text-[9px] px-1.5 py-0 h-4"
                        >
                          {row.status}
                        </Badge>
                      </TableCell>
                    </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </ScrollArea>
        </CardContent>
      </Card>
    </div>
  );
}

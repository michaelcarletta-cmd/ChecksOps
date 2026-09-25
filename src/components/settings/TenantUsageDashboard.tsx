import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Receipt, Loader2, AlertCircle, TrendingUp, DollarSign } from "lucide-react";
import { format, startOfMonth, endOfMonth } from "date-fns";
import { SectionCard } from "./SectionCard";

interface TenantUsageDashboardProps {
  tenantId: string;
  tenantName: string;
  isOpen: boolean;
  onClose: () => void;
}

interface UsageEvent {
  id: string;
  check_intake_item_id: string;
  billed_at: string;
  unit_price_cents: number;
  currency: string;
  status: string;
  event_type?: string;
  check_number?: string;
  payee_name?: string;
  processed_by?: string;
  source?: string;
  mortgage_company?: string;
  loan_number?: string;
}

interface UsagePayload {
  count: number;
  amount_cents: number;
  currency: string;
  month_start: string;
  month_end: string;
  events: UsageEvent[];
  mortgage_count?: number;
  mortgage_amount_cents?: number;
}

const formatCents = (cents: number, currency = "usd") =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase() }).format(cents / 100);

export function TenantUsageDashboard({ tenantId, tenantName, isOpen, onClose }: TenantUsageDashboardProps) {
  const now = new Date();
  const monthStart = startOfMonth(now).toISOString();
  const monthEnd = endOfMonth(now).toISOString();
  const yearStart = new Date(now.getFullYear(), 0, 1).toISOString();
  const yearEnd = new Date(now.getFullYear() + 1, 0, 1).toISOString();

  const { data, isLoading, error } = useQuery({
    queryKey: ["tenant-usage-full", tenantId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_tenant_check_usage", {
        _tenant_id: tenantId,
        _month_start: monthStart,
        _month_end: monthEnd,
      });
      if (error) throw error;
      return data as unknown as UsagePayload;
    },
    enabled: isOpen && !!tenantId,
  });

  // Year-to-date + payments-out rollups
  const { data: rollups } = useQuery({
    queryKey: ["tenant-usage-rollups", tenantId, now.getFullYear()],
    enabled: isOpen && !!tenantId,
    queryFn: async () => {
      const [ytdChecksRes, checkaltRes, moovRes, maintRes, monthlyBreakdownRes] = await Promise.all([
        supabase
          .from("check_billing_events")
          .select("id, unit_price_cents, event_type", { count: "exact" })
          .eq("tenant_id", tenantId)
          .eq("event_type", "check_processing")
          .gte("billed_at", yearStart)
          .lt("billed_at", yearEnd),
        supabase
          .from("checkalt_deposits")
          .select("id, amount, status, created_at")
          .eq("tenant_id", tenantId)
          .gte("created_at", yearStart)
          .lt("created_at", yearEnd),
        supabase
          .from("payment_transfers")
          .select("id, amount_cents, status, created_at")
          .eq("provider", "moov")
          .eq("tenant_id", tenantId)
          .gte("created_at", yearStart)
          .lt("created_at", yearEnd),
        supabase
          .from("tenant_maintenance_payments")
          .select("id, amount_cents, status, received_at, period_start, method, reference")
          .eq("tenant_id", tenantId)
          .order("received_at", { ascending: false })
          .limit(24),
        supabase
          .from("check_billing_events")
          .select("billed_at")
          .eq("tenant_id", tenantId)
          .eq("event_type", "check_processing")
          .gte("billed_at", yearStart)
          .lt("billed_at", yearEnd),
      ]);

      const monthlyCounts: Record<string, number> = {};
      (monthlyBreakdownRes.data ?? []).forEach((r: any) => {
        const d = new Date(r.billed_at);
        const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
        monthlyCounts[k] = (monthlyCounts[k] ?? 0) + 1;
      });

      const checkaltCount = checkaltRes.data?.length ?? 0;
      const checkaltAmount = (checkaltRes.data ?? []).reduce(
        (s: number, r: any) => s + Number(r.amount ?? 0),
        0,
      );
      const moovCount = moovRes.data?.length ?? 0;
      const moovOutAmount = (moovRes.data ?? [])
        .filter((r: any) => r.status === "completed")
        .reduce((s: number, r: any) => s + Number(r.amount_cents ?? 0) / 100, 0);
      const maintenance = maintRes.data ?? [];
      const maintenancePaidCents = maintenance
        .filter((r: any) => ["cleared", "recorded", "submitted"].includes(r.status))
        .reduce((s: number, r: any) => s + (r.amount_cents ?? 0), 0);

      return {
        ytdChecks: ytdChecksRes.count ?? ytdChecksRes.data?.length ?? 0,
        ytdCheckFeesCents: (ytdChecksRes.data ?? []).reduce(
          (s: number, r: any) => s + (r.unit_price_cents ?? 0),
          0,
        ),
        monthlyCounts,
        checkalt: { count: checkaltCount, amount: checkaltAmount },
        moov: { count: moovCount, amountOut: moovOutAmount },
        maintenance,
        maintenancePaidCents,
      };
    },
  });

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-4xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-xl">
            <Receipt className="h-5 w-5 text-primary" />
            {tenantName} — Usage Tracker
          </DialogTitle>
          <DialogDescription>
            Real-time usage tracking for check processing and Moov disbursements.
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="flex flex-col items-center justify-center py-20 space-y-4">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
            <p className="text-sm text-muted-foreground">Calculating usage metrics...</p>
          </div>
        ) : error ? (
          <div className="p-8 text-center space-y-4">
            <AlertCircle className="h-12 w-12 text-destructive mx-auto opacity-50" />
            <p className="text-sm text-destructive font-medium">Failed to load usage data</p>
            <p className="text-xs text-muted-foreground">{(error as any).message}</p>
          </div>
        ) : (
          <div className="space-y-6 overflow-y-auto pr-2 pb-4">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="rounded-xl border border-border/50 bg-card/30 p-4 shadow-sm backdrop-blur-sm">
                <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-1 flex items-center gap-1.5">
                  <TrendingUp className="h-3 w-3" /> Check Processing
                </div>
                <div className="text-3xl font-bold tracking-tight">
                  {data?.events?.filter(e => e.event_type === 'check_processing').length ?? 0}
                </div>
                <div className="text-[10px] text-muted-foreground mt-2">Standard processing volume</div>
              </div>
              
              <div className="rounded-xl border border-border/50 bg-card/30 p-4 shadow-sm backdrop-blur-sm">
                <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-1 flex items-center gap-1.5">
                  <Receipt className="h-3 w-3" /> MortgageOps
                </div>
                <div className="text-3xl font-bold tracking-tight">
                  {data?.mortgage_count ?? data?.events?.filter(e => e.event_type === 'mortgage_handling').length ?? 0}
                </div>
                <div className="text-[10px] text-muted-foreground mt-2">Mortgage handling requests</div>
              </div>

              <div className="rounded-xl border border-border/50 bg-card/30 p-4 shadow-sm backdrop-blur-sm">
                <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-1 flex items-center gap-1.5">
                  <DollarSign className="h-3 w-3" /> Disbursements
                </div>
                <div className="text-3xl font-bold tracking-tight">
                  {data?.events?.filter(e => e.event_type?.startsWith('moov_')).length ?? 0}
                </div>
                <div className="text-[10px] text-muted-foreground mt-2">ACH (Same Day/Instant)</div>
              </div>
            </div>


            <div className="rounded-xl border border-primary/20 bg-primary/5 p-5">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-xs font-medium text-primary uppercase tracking-wider mb-1">Total Estimated Fees</div>
                  <div className="text-4xl font-black text-primary">
                    {formatCents(data?.amount_cents ?? 0, data?.currency)}
                  </div>
                </div>
                <Badge variant="outline" className="bg-background border-primary/20 text-primary px-3 py-1 h-auto text-sm">
                  {format(new Date(), "MMMM yyyy")}
                </Badge>
              </div>
              <p className="text-[11px] text-muted-foreground mt-3 italic">
                * ChecksOps check and speed fees accrue on the monthly consolidated invoice. Instant is not billed.
              </p>
            </div>

            {/* Year-to-date + Payments Out */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div className="rounded-lg border bg-card p-3">
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Checks YTD</div>
                <div className="text-2xl font-bold mt-1">{rollups?.ytdChecks ?? 0}</div>
                <div className="text-[10px] text-muted-foreground mt-1">
                  Fees: {formatCents(rollups?.ytdCheckFeesCents ?? 0)}
                </div>
              </div>
              <div className="rounded-lg border bg-card p-3">
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Check Deposits YTD</div>
                <div className="text-2xl font-bold mt-1">{rollups?.checkalt.count ?? 0}</div>
                <div className="text-[10px] text-muted-foreground mt-1">
                  Volume: ${(rollups?.checkalt.amount ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </div>
              </div>
              <div className="rounded-lg border bg-card p-3">
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Moov Out YTD</div>
                <div className="text-2xl font-bold mt-1">{rollups?.moov.count ?? 0}</div>
                <div className="text-[10px] text-muted-foreground mt-1">
                  Sent: ${(rollups?.moov.amountOut ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </div>
              </div>
              <div className="rounded-lg border bg-card p-3">
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Paid to ChecksOps</div>
                <div className="text-2xl font-bold mt-1">{formatCents(rollups?.maintenancePaidCents ?? 0)}</div>
                <div className="text-[10px] text-muted-foreground mt-1">Maintenance fees</div>
              </div>
            </div>

            {/* Monthly breakdown of checks processed */}
            <div className="rounded-lg border bg-card p-4">
              <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">
                Checks by Month · {now.getFullYear()}
              </div>
              <div className="grid grid-cols-6 md:grid-cols-12 gap-1">
                {Array.from({ length: 12 }, (_, i) => {
                  const key = `${now.getFullYear()}-${String(i + 1).padStart(2, "0")}`;
                  const count = rollups?.monthlyCounts?.[key] ?? 0;
                  const max = Math.max(1, ...Object.values(rollups?.monthlyCounts ?? {}));
                  const pct = Math.round((count / max) * 100);
                  return (
                    <div key={key} className="flex flex-col items-center gap-1" title={`${format(new Date(now.getFullYear(), i, 1), "MMMM")}: ${count} checks`}>
                      <div className="w-full h-16 bg-muted/40 rounded relative flex items-end">
                        <div
                          className="w-full bg-primary/70 rounded-b transition-all"
                          style={{ height: `${pct}%` }}
                        />
                      </div>
                      <div className="text-[9px] text-muted-foreground uppercase">
                        {format(new Date(now.getFullYear(), i, 1), "MMM")}
                      </div>
                      <div className="text-[10px] font-semibold">{count}</div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Maintenance fee history */}
            {rollups?.maintenance && rollups.maintenance.length > 0 && (
              <div className="space-y-2">
                <h4 className="text-sm font-semibold">ChecksOps Maintenance Fee History</h4>
                <div className="border rounded-lg overflow-hidden">
                  <div className="max-h-48 overflow-y-auto divide-y bg-muted/10">
                    {rollups.maintenance.map((p: any) => (
                      <div key={p.id} className="flex items-center justify-between px-4 py-2 text-xs">
                        <div>
                          <div className="font-medium">
                            {format(new Date(p.received_at), "MMM d, yyyy")}
                            {p.period_start && (
                              <span className="text-muted-foreground ml-2">
                                · Period {format(new Date(p.period_start), "MMM yyyy")}
                              </span>
                            )}
                          </div>
                          <div className="text-[10px] text-muted-foreground">
                            {p.method?.toUpperCase()} {p.reference && `· ${p.reference}`}
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="font-bold">{formatCents(p.amount_cents)}</span>
                          <Badge
                            variant="outline"
                            className={`text-[9px] h-4 ${
                              p.status === "cleared"
                                ? "border-emerald-500/40 text-emerald-500"
                                : p.status === "returned" || p.status === "failed"
                                ? "border-destructive/40 text-destructive"
                                : "border-muted-foreground/30"
                            }`}
                          >
                            {p.status}
                          </Badge>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}


            <div className="space-y-3">
              <h4 className="text-sm font-semibold flex items-center gap-2">
                Detailed Log
                <span className="text-xs font-normal text-muted-foreground">({data?.events?.length ?? 0} items)</span>
              </h4>
              <div className="border rounded-lg overflow-hidden">
                <div className="max-h-64 overflow-y-auto divide-y bg-muted/10">
                  {data?.events?.length === 0 ? (
                    <div className="p-8 text-center text-muted-foreground text-sm italic">
                      No usage events recorded this month.
                    </div>
                  ) : (
                    data?.events?.map((e) => (
                      <div key={e.id} className="flex items-center justify-between px-4 py-3 hover:bg-muted/30 transition-colors">
                        <div className="space-y-0.5">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium">{format(new Date(e.billed_at), "MMM d, h:mm a")}</span>
                            <Badge variant="secondary" className="text-[9px] h-4 px-1 py-0 uppercase font-bold">
                              {e.event_type?.replace('_', ' ') || 'processing'}
                            </Badge>
                          </div>
                          <div className="text-[10px] text-muted-foreground font-mono flex gap-2">
                            <span>ID: {e.check_intake_item_id}</span>
                            {e.check_number && <span>· Check #{e.check_number}</span>}
                            {e.payee_name && <span className="truncate max-w-[150px]">· {e.payee_name}</span>}
                            {e.processed_by && <span className="text-primary/80">· By: {e.processed_by}</span>}
                          </div>
                        </div>
                        <div className="text-right space-y-1">
                          <div className="text-sm font-bold">{formatCents(e.unit_price_cents, e.currency)}</div>
                          <Badge variant={e.status === 'reported' ? 'secondary' : 'outline'} className="text-[9px] h-4">
                            {e.status}
                          </Badge>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

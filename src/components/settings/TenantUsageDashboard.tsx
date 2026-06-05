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
import { Receipt, Loader2, AlertCircle } from "lucide-react";
import { format, startOfMonth, endOfMonth } from "date-fns";

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
  event_type?: "check_processing" | "actum_same_day" | "actum_instant";
  check_number?: string;
  payee_name?: string;
}

interface UsagePayload {
  count: number;
  amount_cents: number;
  currency: string;
  month_start: string;
  month_end: string;
  events: UsageEvent[];
}

const formatCents = (cents: number, currency = "usd") =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase() }).format(cents / 100);

export function TenantUsageDashboard({ tenantId, tenantName, isOpen, onClose }: TenantUsageDashboardProps) {
  const now = new Date();
  const monthStart = startOfMonth(now).toISOString();
  const monthEnd = endOfMonth(now).toISOString();

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

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-4xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-xl">
            <Receipt className="h-5 w-5 text-primary" />
            {tenantName} — Usage Tracker
          </DialogTitle>
          <DialogDescription>
            Real-time usage tracking for check processing and Actum disbursements.
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
          <div className="space-y-6 overflow-y-auto pr-2">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="rounded-xl border bg-card p-4 shadow-sm">
                <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">Checks Processed</div>
                <div className="text-3xl font-bold">
                  {data?.events?.filter(e => e.event_type === 'check_processing').length ?? 0}
                </div>
                <div className="text-[10px] text-muted-foreground mt-2">Standard endorsement workflow</div>
              </div>
              <div className="rounded-xl border bg-card p-4 shadow-sm">
                <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">Actum Same Day</div>
                <div className="text-3xl font-bold">
                  {data?.events?.filter(e => e.event_type === 'actum_same_day').length ?? 0}
                </div>
                <div className="text-[10px] text-muted-foreground mt-2">$1.00 pass-through fee</div>
              </div>
              <div className="rounded-xl border bg-card p-4 shadow-sm">
                <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">Actum Instant</div>
                <div className="text-3xl font-bold">
                  {data?.events?.filter(e => e.event_type === 'actum_instant').length ?? 0}
                </div>
                <div className="text-[10px] text-muted-foreground mt-2">$1.50 pass-through fee</div>
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
                * Note: Actum fees are paid directly to Actum. Billing amounts reflect the internal per-check rate configured for this tenant.
              </p>
            </div>

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

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { isPlatformOwner } from "@/lib/masterMerchant";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Receipt, ChevronDown, ChevronUp, RefreshCw, AlertCircle } from "lucide-react";
import { useState } from "react";
import { useTenantFilter } from "@/hooks/useTenantFilter";
import { format } from "date-fns";
import { toast } from "sonner";

interface UsageEvent {
  id: string;
  check_intake_item_id: string;
  billed_at: string;
  unit_price_cents: number;
  currency: string;
  status: string;
  event_type?: "check_processing" | "moov_same_day" | "moov_next_day" | "mortgage_handling";
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

export function CheckUsageCard() {
  const { tenantId } = useTenantFilter();
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();

  const { data: tenant } = useQuery({
    queryKey: ["tenant-billing-status", tenantId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("tenants")
        .select("per_check_billing_enabled, name")
        .eq("id", tenantId!)
        .single();
      if (error) throw error;
      return data;
    },
    enabled: !!tenantId,
  });

  const { data: user } = useQuery({
    queryKey: ["current-user-email"],
    queryFn: async () => {
      const { data: { user } } = await supabase.auth.getUser();
      return user;
    },
  });

  const showBillingAmounts = isPlatformOwner(user?.email, user?.id) || tenant?.per_check_billing_enabled;

  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ["check-usage-current-month", tenantId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_tenant_check_usage", {
        _tenant_id: tenantId!,
      });
      if (error) throw error;
      return data as unknown as UsagePayload;
    },
    enabled: !!tenantId,
    refetchInterval: 60_000,
  });

  const reportMutation = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke("report-check-usage-to-stripe");
      if (error) throw error;
      return data;
    },
    onSuccess: (res) => {
      toast.success(`Usage reported: ${res?.succeeded ?? 0} events sent`);
      qc.invalidateQueries({ queryKey: ["check-usage-current-month"] });
    },
    onError: (e: any) => toast.error(e?.message ?? "Failed to report usage"),
  });

  if (!tenantId) return null;

  const monthLabel = data?.month_start ? format(new Date(data.month_start), "MMMM yyyy") : "";

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Receipt className="h-4 w-4 text-primary" />
            Check Processing Usage
            {monthLabel && <span className="text-xs text-muted-foreground font-normal">· {monthLabel}</span>}
          </CardTitle>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => refetch()}
            disabled={isFetching}
            className="h-7 px-2"
            title="Refresh"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${isFetching ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
          <div className="rounded-lg bg-muted/30 p-3">
            <div className="text-xs text-muted-foreground">Checks processed</div>
            <div className="text-2xl font-bold">
              {isLoading ? "—" : data?.events?.filter(e => e.event_type === 'check_processing').length ?? 0}
            </div>
          </div>
          <div className="rounded-lg bg-muted/30 p-3">
            <div className="text-xs text-muted-foreground">MortgageOps Requests</div>
            <div className="text-2xl font-bold">
              {isLoading ? "—" : data?.events?.filter(e => e.event_type === 'mortgage_handling').length ?? 0}
            </div>
          </div>
          <div className="rounded-lg bg-muted/30 p-3">
            <div className="text-xs text-muted-foreground">Next Day ACH</div>
            <div className="text-2xl font-bold">
              {isLoading ? "—" : data?.events?.filter(e => e.event_type === 'moov_next_day').length ?? 0}
            </div>
          </div>
          <div className="rounded-lg bg-muted/30 p-3">
            <div className="text-xs text-muted-foreground">Same Day ACH</div>
            <div className="text-2xl font-bold">
              {isLoading ? "—" : data?.events?.filter(e => e.event_type === 'moov_same_day').length ?? 0}
            </div>
          </div>
        </div>

        <div className="rounded-lg bg-primary/5 p-3 border border-primary/10">
          <div className="text-xs text-muted-foreground">Total estimated fees this month</div>
          <div className="text-2xl font-bold text-primary">
            {isLoading ? "—" : showBillingAmounts ? formatCents(data?.amount_cents ?? 0, data?.currency) : "$—"}
          </div>
          <p className="text-[10px] text-muted-foreground mt-1">
            ChecksOps check and speed fees accrue on the monthly consolidated invoice. Instant is not billed.
            {!showBillingAmounts && " Processing fees are managed by Freedom Adjustment."}
          </p>
        </div>

        <p className="text-[11px] text-muted-foreground leading-snug flex items-start gap-1.5">
          <AlertCircle className="h-3 w-3 mt-0.5 flex-shrink-0" />
          Usage is tracked automatically as checks are processed and disbursements are triggered.
        </p>

        <Button
          variant="ghost"
          size="sm"
          className="w-full text-xs h-8"
          onClick={() => setOpen((o) => !o)}
          disabled={!data?.events?.length}
        >
          {open ? <ChevronUp className="h-3 w-3 mr-1" /> : <ChevronDown className="h-3 w-3 mr-1" />}
          {open ? "Hide" : "Show"} line items ({data?.events?.length ?? 0})
        </Button>

        {open && data?.events?.length ? (
          <div className="border rounded-lg max-h-72 overflow-y-auto divide-y">
            {data.events.map((e) => (
              <div key={e.id} className="flex items-center justify-between px-3 py-2 text-xs">
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{format(new Date(e.billed_at), "MMM d, h:mm a")}</span>
                    <Badge variant="outline" className="text-[9px] h-4 px-1 py-0 uppercase">
                      {e.event_type?.replace('_', ' ') || 'processing'}
                    </Badge>
                  </div>
                  <div className="text-muted-foreground font-mono text-[10px]">
                    {e.check_intake_item_id.slice(0, 8)}…
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant={e.status === "reported" ? "secondary" : "outline"} className="text-[10px] h-5">
                    {e.status}
                  </Badge>
                  {showBillingAmounts && (
                    <span className="font-semibold">{formatCents(e.unit_price_cents, e.currency)}</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { PlatformReceivablesLedger, type ReceivableRow, type ReceivableTotals } from "@/components/admin/PlatformReceivablesLedger";

const money = (cents: number) =>
  (Number(cents || 0) / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  });

type HistoryResponse = {
  history?: {
    rows: ReceivableRow[];
    totals: ReceivableTotals;
    summary: {
      current_month: string;
      current_month_amount_due_cents: number;
      current_payment_status: string | null;
      last_successful_payment: {
        billing_month: string | null;
        amount_cents: number;
        received_at: string | null;
      } | null;
      outstanding_balance_cents: number;
    } | null;
  };
  error?: string;
};

export function TenantBillingHistoryPanel({ tenantId, tenantName }: { tenantId: string; tenantName: string }) {
  const { data, isLoading, error } = useQuery<HistoryResponse>({
    queryKey: ["tenant-billing-history", tenantId],
    staleTime: 30_000,
    retry: false,
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke("platform-treasury", {
        body: { action: "tenant-history", tenant_id: tenantId },
      });
      if (error) throw new Error(error.message);
      if ((data as any)?.error) throw new Error((data as any).error);
      return data as HistoryResponse;
    },
  });

  if (isLoading) return <Skeleton className="h-40 w-full" />;
  if (error) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-destructive">{(error as Error).message}</CardContent>
      </Card>
    );
  }

  const summary = data?.history?.summary;
  const rows = data?.history?.rows ?? [];
  const totals = data?.history?.totals;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">ChecksOps billing history</CardTitle>
          <CardDescription>
            Monthly fees owed, attempted, and received for {tenantName}. Other tenants are never included.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-4">
          <div>
            <p className="text-xs uppercase text-muted-foreground">Current month due</p>
            <p className="text-xl font-semibold">{money(summary?.current_month_amount_due_cents ?? 0)}</p>
          </div>
          <div>
            <p className="text-xs uppercase text-muted-foreground">Current status</p>
            <Badge variant="outline">{summary?.current_payment_status ?? "—"}</Badge>
          </div>
          <div>
            <p className="text-xs uppercase text-muted-foreground">Last successful payment</p>
            <p className="text-sm">
              {summary?.last_successful_payment
                ? `${money(summary.last_successful_payment.amount_cents)} · ${summary.last_successful_payment.billing_month}`
                : "None yet"}
            </p>
          </div>
          <div>
            <p className="text-xs uppercase text-muted-foreground">Outstanding</p>
            <p className="text-xl font-semibold">{money(summary?.outstanding_balance_cents ?? 0)}</p>
          </div>
        </CardContent>
      </Card>
      <PlatformReceivablesLedger rows={rows} totals={totals} showTenantFilter={false} />
    </div>
  );
}

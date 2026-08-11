import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useTenant } from "@/contexts/TenantContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { TrendingUp, TrendingDown, DollarSign, Wallet } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";

export function RevenueSummary() {
  const { tenant } = useTenant();

  const { data: revenueData, isLoading: revenueLoading } = useQuery({
    queryKey: ["revenue-summary-incoming", tenant?.id],
    enabled: !!tenant?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("check_intake_items")
        .select("amount, status, deposited_at")
        .eq("tenant_id", tenant!.id)
        .in("status", ["deposited", "funds_released"]);

      if (error) throw error;
      return data ?? [];
    },
  });

  const { data: disbursementData, isLoading: disbursementLoading } = useQuery({
    queryKey: ["revenue-summary-outgoing", tenant?.id],
    enabled: !!tenant?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("disbursement_splits")
        .select("amount, status")
        .eq("tenant_id", tenant!.id)
        .eq("status", "settled");

      if (error) throw error;
      return data ?? [];
    },
  });

  const stats = useMemo(() => {
    const totalIncoming = revenueData?.reduce((sum, item) => sum + Number(item.amount || 0), 0) || 0;
    const totalOutgoing = disbursementData?.reduce((sum, item) => sum + Number(item.amount || 0), 0) || 0;
    const profit = totalIncoming - totalOutgoing;
    const margin = totalIncoming > 0 ? (profit / totalIncoming) * 100 : 0;

    return { totalIncoming, totalOutgoing, profit, margin };
  }, [revenueData, disbursementData]);

  if (revenueLoading || disbursementLoading) {
    return (
      <div className="grid gap-4 md:grid-cols-3">
        {[1, 2, 3].map((i) => (
          <Card key={i}>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <Skeleton className="h-4 w-[100px]" />
            </CardHeader>
            <CardContent>
              <Skeleton className="h-8 w-[120px] mb-1" />
              <Skeleton className="h-4 w-[80px]" />
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Received (Revenue)</CardTitle>
            <TrendingUp className="h-4 w-4 text-emerald-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              ${stats.totalIncoming.toLocaleString("en-US", { minimumFractionDigits: 2 })}
            </div>
            <p className="text-xs text-muted-foreground">From deposited checks</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Paid (Expenses)</CardTitle>
            <TrendingDown className="h-4 w-4 text-rose-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              ${stats.totalOutgoing.toLocaleString("en-US", { minimumFractionDigits: 2 })}
            </div>
            <p className="text-xs text-muted-foreground">Settled disbursements</p>
          </CardContent>
        </Card>

        <Card className="border-primary/20 bg-primary/5">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Net Profit</CardTitle>
            <DollarSign className="h-4 w-4 text-primary" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-primary">
              ${stats.profit.toLocaleString("en-US", { minimumFractionDigits: 2 })}
            </div>
            <div className="flex items-center gap-2 mt-1">
              <p className="text-xs text-muted-foreground">Retained earnings</p>
              <Badge variant="outline" className="text-[10px] font-mono py-0 h-4">
                {stats.margin.toFixed(1)}% margin
              </Badge>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Wallet className="h-4 w-4" /> Revenue & Profit Analysis
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="h-[200px] flex items-center justify-center border-2 border-dashed rounded-lg bg-muted/30">
            <div className="text-center">
              <p className="text-sm text-muted-foreground">Detailed chart view coming soon</p>
              <p className="text-[10px] text-muted-foreground mt-1">Comparing monthly inflow vs outflow</p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

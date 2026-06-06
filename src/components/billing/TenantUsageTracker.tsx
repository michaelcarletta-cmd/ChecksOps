import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useTenant } from "@/contexts/TenantContext";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ScrollArea } from "@/components/ui/scroll-area";
import { BarChart3, Receipt, Landmark, ArrowDownCircle, CheckCircle2 } from "lucide-react";
import { format, startOfMonth, endOfMonth } from "date-fns";

export function TenantUsageTracker() {
  const { tenant } = useTenant();
  const now = new Date();
  const monthStart = startOfMonth(now).toISOString();
  const monthEnd = endOfMonth(now).toISOString();

  const { data: usage, isLoading: usageLoading } = useQuery({
    queryKey: ["tenant-usage", tenant?.id],
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

  const { data: fundsLog = [], isLoading: fundsLoading } = useQuery({
    queryKey: ["tenant-funds-log", tenant?.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("claim_check_payments")
        .select(`
          id, payment_amount, status, created_at,
          check_intake_items (check_number, carrier_name)
        `)
        .eq("recipient_tenant_id", tenant!.id)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
    enabled: !!tenant?.id,
  });

  if (usageLoading || fundsLoading) return <div className="p-8 text-center text-sm text-muted-foreground animate-pulse">Loading usage & funds data...</div>;

  const formatCurrency = (amount: number) => 
    new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(amount);

  const totalReceived = fundsLog
    .filter((f: any) => f.status === "settled")
    .reduce((sum: number, f: any) => sum + Number(f.payment_amount), 0);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card className="bg-gradient-to-br from-primary/10 to-blue-500/5 border-primary/20">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Receipt className="h-4 w-4 text-primary" />
              Processing Usage
            </CardTitle>
            <CardDescription className="text-[10px]">Usage for {format(now, "MMMM yyyy")}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-baseline gap-2">
              <span className="text-3xl font-bold">{usage?.count ?? 0}</span>
              <span className="text-xs text-muted-foreground">checks processed</span>
            </div>
            <p className="text-xs text-muted-foreground mt-2">
              Estimated fees: <span className="font-semibold text-foreground">{formatCurrency((usage?.amount_cents ?? 0) / 100)}</span>
            </p>
          </CardContent>
        </Card>

        <Card className="bg-gradient-to-br from-emerald-500/10 to-teal-500/5 border-emerald-500/20">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Landmark className="h-4 w-4 text-emerald-500" />
              Total Settled Funds
            </CardTitle>
            <CardDescription className="text-[10px]">Actual deposits into your account</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-baseline gap-2">
              <span className="text-3xl font-bold text-emerald-600">{formatCurrency(totalReceived)}</span>
            </div>
            <p className="text-xs text-muted-foreground mt-2">
              Across <span className="font-semibold text-foreground">{fundsLog.filter((f: any) => f.status === 'settled').length}</span> cleared payments
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <ArrowDownCircle className="h-4 w-4 text-primary" />
            Funding & Deposit Log
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <ScrollArea className="h-[400px]">
            <Table>
              <TableHeader>
                <TableRow className="text-[10px] uppercase tracking-wider">
                  <TableHead className="pl-4">Date</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead className="text-center">Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {fundsLog.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={4} className="h-24 text-center text-xs text-muted-foreground">No funding activity found.</TableCell>
                  </TableRow>
                ) : (
                  fundsLog.map((row: any) => (
                    <TableRow key={row.id} className="hover:bg-muted/30">
                      <TableCell className="pl-4 text-xs text-muted-foreground">
                        {format(new Date(row.created_at), "MMM d, yyyy")}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col">
                          <span className="text-xs font-medium">Check #{row.check_intake_items?.check_number || "—"}</span>
                          <span className="text-[10px] text-muted-foreground truncate max-w-[120px]">{row.check_intake_items?.carrier_name}</span>
                        </div>
                      </TableCell>
                      <TableCell className="text-right text-xs font-semibold tabular-nums">
                        {formatCurrency(Number(row.payment_amount))}
                      </TableCell>
                      <TableCell className="text-center">
                        <Badge 
                          variant="outline" 
                          className={`text-[9px] px-1.5 py-0 h-4 ${
                            row.status === "settled" ? "bg-emerald-500/10 text-emerald-600 border-emerald-500/20" :
                            row.status === "submitted" ? "bg-blue-500/10 text-blue-600 border-blue-500/20" :
                            "bg-amber-500/10 text-amber-600 border-amber-500/20"
                          }`}
                        >
                          {row.status}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </ScrollArea>
        </CardContent>
      </Card>
    </div>
  );
}

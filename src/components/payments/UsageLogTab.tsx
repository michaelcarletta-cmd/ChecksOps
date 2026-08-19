import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useTenant } from "@/contexts/TenantContext";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Loader2, Receipt, Search, Calendar, ArrowRight } from "lucide-react";
import { format, startOfMonth, endOfMonth } from "date-fns";

const money = (cents: number) =>
  (Number(cents || 0) / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
  });

export function UsageLogTab() {
  const { tenant } = useTenant();
  const [month, setMonth] = useState(format(new Date(), "yyyy-MM"));

  const { data: logs, isLoading } = useQuery({
    queryKey: ["tenant-usage-logs", tenant?.id, month],
    queryFn: async () => {
      const date = new Date(month + "-01");
      const start = startOfMonth(date).toISOString();
      const end = endOfMonth(date).toISOString();

      const { data, error } = await supabase
        .from("tenant_usage_logs" as any)
        .select("*")
        .eq("tenant_id", tenant?.id)
        .gte("created_at", start)
        .lte("created_at", end)
        .order("created_at", { ascending: false });

      if (error) throw error;
      return data as any[];
    },
    enabled: !!tenant?.id,
  });

  const totalCents = logs?.reduce((sum, log) => sum + (log.amount_cents || 0), 0) || 0;

  // Generate last 12 months for the filter
  const months = Array.from({ length: 12 }, (_, i) => {
    const d = new Date();
    d.setMonth(d.getMonth() - i);
    return format(d, "yyyy-MM");
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="space-y-1">
          <h3 className="text-lg font-semibold flex items-center gap-2">
            <Receipt className="h-5 w-5 text-primary" />
            Usage History
          </h3>
          <p className="text-sm text-muted-foreground">
            Monitor check processing and payment volume.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Calendar className="h-4 w-4 text-muted-foreground" />
          <Select value={month} onValueChange={setMonth}>
            <SelectTrigger className="w-[180px]">
              <SelectValue placeholder="Select month" />
            </SelectTrigger>
            <SelectContent>
              {months.map((m) => (
                <SelectItem key={m} value={m}>
                  {format(new Date(m + "-01"), "MMMM yyyy")}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card className="bg-primary/5 border-primary/20">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Monthly Total</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-primary">{money(totalCents)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Events</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{logs?.length || 0}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Billing Status</CardTitle>
          </CardHeader>
          <CardContent>
            <Badge variant="outline" className="border-emerald-500/50 text-emerald-500 bg-emerald-500/5">
              Active
            </Badge>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Event Type</TableHead>
                <TableHead>Description</TableHead>
                <TableHead className="text-right">Amount</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={4} className="h-24 text-center">
                    <Loader2 className="h-6 w-6 animate-spin mx-auto" />
                  </TableCell>
                </TableRow>
              ) : logs?.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="h-24 text-center text-muted-foreground italic">
                    No usage recorded for {format(new Date(month + "-01"), "MMMM yyyy")}.
                  </TableCell>
                </TableRow>
              ) : (
                logs?.map((log) => (
                  <TableRow key={log.id}>
                    <TableCell className="whitespace-nowrap">
                      {format(new Date(log.created_at), "MMM d, yyyy HH:mm")}
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary" className="capitalize">
                        {log.event_type.replace(/_/g, " ")}
                      </Badge>
                    </TableCell>
                    <TableCell>{log.description}</TableCell>
                    <TableCell className="text-right font-medium">{money(log.amount_cents)}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

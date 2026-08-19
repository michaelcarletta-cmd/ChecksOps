import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useTenant } from "@/contexts/TenantContext";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Loader2, Receipt, Search, Calendar, ArrowRight, BarChart3, TrendingUp, Activity, ShieldCheck, History } from "lucide-react";
import { format, startOfMonth, endOfMonth } from "date-fns";
import { SettingsHero } from "@/components/settings/SettingsHero";
import { SectionCard } from "@/components/settings/SectionCard";

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
        .from("tenant_usage_logs")
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
    <div className="space-y-6 max-w-7xl mx-auto">
      <SettingsHero
        title="Usage History"
        description="Monitor check processing and payment volume for your organization."
        badge="Billing & Usage"
        icon={<Receipt className="h-4 w-4 text-primary" />}
      />

      <SectionCard
        title="Usage Overview"
        accent="bg-gradient-to-r from-sky-500/60 to-sky-500/10"
        icon={<BarChart3 className="h-4 w-4 text-sky-500" />}
        description="Summary of your processing volume and billing status"
      >
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-4">
          <div className="text-sm text-muted-foreground">
            View usage metrics and event logs for a specific month.
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
          <div className="rounded-xl border border-primary/20 bg-primary/5 p-4 shadow-sm backdrop-blur-sm">
            <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-1 flex items-center gap-1.5">
              <TrendingUp className="h-3 w-3" /> Monthly Total
            </div>
            <div className="text-2xl font-bold tracking-tight text-primary">
              {money(totalCents)}
            </div>
          </div>
          
          <div className="rounded-xl border border-border/50 bg-card/30 p-4 shadow-sm backdrop-blur-sm">
            <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-1 flex items-center gap-1.5">
              <Activity className="h-3 w-3" /> Events
            </div>
            <div className="text-2xl font-bold tracking-tight">
              {logs?.length || 0}
            </div>
          </div>

          <div className="rounded-xl border border-border/50 bg-card/30 p-4 shadow-sm backdrop-blur-sm">
            <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-1 flex items-center gap-1.5">
              <ShieldCheck className="h-3 w-3" /> Billing Status
            </div>
            <div className="mt-1">
              <Badge variant="outline" className="border-emerald-500/50 text-emerald-500 bg-emerald-500/5">
                Active
              </Badge>
            </div>
          </div>
        </div>
      </SectionCard>

      <SectionCard
        title="Event History"
        accent="bg-gradient-to-r from-primary/60 to-primary/10"
        icon={<History className="h-4 w-4 text-primary" />}
        description="Detailed log of all billable processing events"
      >
        <div className="p-0 -mx-4">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-6">Date</TableHead>
                <TableHead>Event Type</TableHead>
                <TableHead>Description</TableHead>
                <TableHead className="text-right pr-6">Amount</TableHead>
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
                    <TableCell className="whitespace-nowrap pl-6">
                      {format(new Date(log.created_at), "MMM d, yyyy HH:mm")}
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary" className="capitalize">
                        {log.event_type.replace(/_/g, " ")}
                      </Badge>
                    </TableCell>
                    <TableCell>{log.description}</TableCell>
                    <TableCell className="text-right font-medium pr-6">{money(log.amount_cents)}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </SectionCard>
    </div>
  );
}

import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useTenant } from "@/contexts/TenantContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { format } from "date-fns";

const STATUS_STYLE: Record<string, string> = {
  pending: "bg-muted text-muted-foreground",
  submitted: "bg-blue-500/10 text-blue-600 border-blue-500/20",
  completed: "bg-emerald-500/10 text-emerald-600 border-emerald-500/20",
  failed: "bg-destructive/10 text-destructive border-destructive/20",
};

const SPEED_LABEL: Record<string, string> = { next_day: "Next Day", same_day: "Same Day", instant: "Instant" };

export function PayrollHistoryTable() {
  const { tenant } = useTenant();

  const { data: runs = [], isLoading } = useQuery({
    queryKey: ["payroll-runs", tenant?.id],
    enabled: !!tenant?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("payroll_runs")
        .select(`
          id, amount, speed, memo, status, error, created_at,
          stakeholder_accounts(nickname, custname),
          disbursement_batches(debit_actum_order_id, disbursement_splits(actum_order_id, status))
        `)
        .eq("tenant_id", tenant!.id)
        .order("created_at", { ascending: false })
        .limit(100);
      if (error) throw error;
      return data ?? [];
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Payroll History</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="text-sm text-muted-foreground p-4">Loading...</div>
        ) : runs.length === 0 ? (
          <div className="text-sm text-muted-foreground p-4">
            No payroll payments yet. Payees only appear here after their first payment.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs text-muted-foreground border-b border-border">
                <tr>
                  <th className="text-left py-2 pr-3">Date</th>
                  <th className="text-left py-2 pr-3">Payee</th>
                  <th className="text-right py-2 pr-3">Amount</th>
                  <th className="text-left py-2 pr-3">Speed</th>
                  <th className="text-left py-2 pr-3">Status</th>
                  <th className="text-left py-2 pr-3">Memo</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r: any) => (
                  <tr key={r.id} className="border-b border-border/50">
                    <td className="py-2 pr-3 whitespace-nowrap">{format(new Date(r.created_at), "MMM d, yyyy p")}</td>
                    <td className="py-2 pr-3">
                      <div className="font-medium">{r.stakeholder_accounts?.nickname ?? "—"}</div>
                      <div className="text-xs text-muted-foreground">{r.stakeholder_accounts?.custname}</div>
                    </td>
                    <td className="py-2 pr-3 text-right font-medium">${Number(r.amount).toFixed(2)}</td>
                    <td className="py-2 pr-3">{SPEED_LABEL[r.speed] ?? r.speed}</td>
                    <td className="py-2 pr-3">
                      <Badge variant="outline" className={STATUS_STYLE[r.status] ?? ""}>{r.status}</Badge>
                      {r.status === "failed" && r.error && (
                        <div className="text-xs text-destructive mt-1 max-w-xs truncate" title={r.error}>{r.error}</div>
                      )}
                    </td>
                    <td className="py-2 pr-3 text-muted-foreground max-w-xs truncate">{r.memo ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

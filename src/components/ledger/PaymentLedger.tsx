import { useState, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useTenant } from "@/contexts/TenantContext";
import { toast } from "sonner";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { format, startOfYear, endOfYear, startOfMonth, endOfMonth, subMonths } from "date-fns";
import { Download, Search } from "lucide-react";

const STATUS_COLORS: Record<string, string> = {
  submitted: "text-blue-600 border-blue-500/30 bg-blue-500/10",
  settled: "text-emerald-600 border-emerald-500/30 bg-emerald-500/10",
  returned: "text-red-600 border-red-500/30 bg-red-500/10",
  failed: "text-red-600 border-red-500/30 bg-red-500/10",
  pending: "text-amber-600 border-amber-500/30 bg-amber-500/10",
};

const ACCOUNT_TYPE_LABELS: Record<string, string> = {
  subcontractor: "Subcontractor",
  contractor: "Contractor",
  sales_rep: "Sales Rep",
  appraisal: "Appraisal",
  supplier: "Supplier",
  adjuster: "Adjuster",
  vendor: "Vendor",
  insured: "Insured",
  overhead: "Overhead",
  operating: "Operating",
  other: "Other",
};

const TYPE_COLORS: Record<string, string> = {
  subcontractor: "text-purple-600 border-purple-500/30 bg-purple-500/10",
  contractor: "text-emerald-600 border-emerald-500/30 bg-emerald-500/10",
  sales_rep: "text-pink-600 border-pink-500/30 bg-pink-500/10",
  appraisal: "text-indigo-600 border-indigo-500/30 bg-indigo-500/10",
  supplier: "text-amber-600 border-amber-500/30 bg-amber-500/10",
  adjuster: "text-orange-600 border-orange-500/30 bg-orange-500/10",
  vendor: "text-blue-600 border-blue-500/30 bg-blue-500/10",
  insured: "text-cyan-600 border-cyan-500/30 bg-cyan-500/10",
  other: "text-muted-foreground border-border bg-muted/30",
};

const EDITABLE_TYPES = ["subcontractor", "contractor", "sales_rep", "appraisal", "supplier", "adjuster", "vendor", "insured", "other"];

type DateRange = "this_month" | "last_month" | "this_year" | "all";

export function PaymentLedger() {
  const { tenant } = useTenant();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [dateRange, setDateRange] = useState<DateRange>("this_year");

  const updateType = async (id: string, newType: string) => {
    const { error } = await (supabase as any)
      .from("disbursement_splits")
      .update({ recipient_type: newType })
      .eq("id", id);
    if (error) {
      toast.error("Could not update type");
      return;
    }
    toast.success("Type updated");
    queryClient.invalidateQueries({ queryKey: ["payment-ledger"] });
    queryClient.invalidateQueries({ queryKey: ["recipient-report"] });
    queryClient.invalidateQueries({ queryKey: ["tax-summary"] });
  };

  const dateFilters = useMemo(() => {
    const now = new Date();
    switch (dateRange) {
      case "this_month": return { from: startOfMonth(now), to: endOfMonth(now) };
      case "last_month": return { from: startOfMonth(subMonths(now, 1)), to: endOfMonth(subMonths(now, 1)) };
      case "this_year": return { from: startOfYear(now), to: endOfYear(now) };
      default: return null;
    }
  }, [dateRange]);

  const { data: payments = [], isLoading } = useQuery({
    queryKey: ["payment-ledger", tenant?.id, dateRange],
    enabled: !!tenant?.id,
    queryFn: async () => {
      let query = (supabase as any)
        .from("disbursement_splits")
        .select(`
          id, amount, status, submitted_at, settled_at, returned_at,
          return_code, return_desc, actum_order_id, created_at,
          method, recipient_name, recipient_type, external_check_number,
          stakeholder_accounts (
            id, nickname, custname, account_type, chk_acct
          ),
          disbursement_batches (
            id, check_amount, check_intake_item_id,
            check_intake_items:check_intake_item_id (
              check_number, carrier_name, amount,
              claim_id
            )
          )
        `)
        .eq("tenant_id", tenant!.id)
        .neq("status", "pending")
        .order("created_at", { ascending: false });

      if (dateFilters) {
        query = query
          .gte("created_at", dateFilters.from.toISOString())
          .lte("created_at", dateFilters.to.toISOString());
      }

      const { data, error } = await query;
      if (error) throw error;
      return data ?? [];
    },
  });

  const filtered = useMemo(() => {
    return payments.filter((p: any) => {
      const acct = p.stakeholder_accounts;
      const batch = p.disbursement_batches;
      const check = batch?.check_intake_items;
      const name = acct?.nickname ?? acct?.custname ?? p.recipient_name ?? "";
      const type = acct?.account_type ?? p.recipient_type ?? "other";

      const matchSearch = !search ||
        name.toLowerCase().includes(search.toLowerCase()) ||
        check?.check_number?.toLowerCase().includes(search.toLowerCase()) ||
        check?.carrier_name?.toLowerCase().includes(search.toLowerCase()) ||
        p.external_check_number?.toLowerCase().includes(search.toLowerCase());

      const matchType = typeFilter === "all" || type === typeFilter;
      const matchStatus = statusFilter === "all" || p.status === statusFilter;

      return matchSearch && matchType && matchStatus;
    });
  }, [payments, search, typeFilter, statusFilter]);

  const stats = useMemo(() => {
    const settled = filtered.filter((p: any) => p.status === "settled");
    const totalOut = settled.reduce((s: number, p: any) => s + Number(p.amount), 0);
    const byType = settled.reduce((acc: Record<string, number>, p: any) => {
      const t = p.stakeholder_accounts?.account_type ?? p.recipient_type ?? "other";
      acc[t] = (acc[t] ?? 0) + Number(p.amount);
      return acc;
    }, {});
    const uniqueRecipients = new Set(settled.map((p: any) => p.stakeholder_accounts?.id ?? p.recipient_name)).size;
    return { totalOut, byType, uniqueRecipients, count: settled.length };
  }, [filtered]);

  const exportCSV = () => {
    const headers = ["Date", "Recipient", "Type", "Account (last 4)", "Check #", "Carrier", "Amount", "Status", "Actum Order ID", "Return Code"];
    const rows = filtered.map((p: any) => {
      const acct = p.stakeholder_accounts;
      const check = p.disbursement_batches?.check_intake_items;
      return [
        format(new Date(p.created_at), "MM/dd/yyyy"),
        acct?.nickname ?? acct?.custname ?? "—",
        ACCOUNT_TYPE_LABELS[acct?.account_type] ?? "—",
        acct?.chk_acct ? `••••${acct.chk_acct.slice(-4)}` : "—",
        check?.check_number ?? "—",
        check?.carrier_name ?? "—",
        Number(p.amount).toFixed(2),
        p.status,
        p.actum_order_id ?? "—",
        p.return_code ?? "—",
      ];
    });

    const csv = [headers, ...rows].map(r => r.map(v => `"${v}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `payments_${format(new Date(), "yyyy-MM-dd")}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-4">

      <Card>
        <CardContent className="pt-3 pb-3">
          <div className="flex flex-wrap gap-2 items-center">
            <div className="relative flex-1 min-w-48">
              <Search className="absolute left-2.5 top-2 h-3.5 w-3.5 text-muted-foreground" />
              <Input className="h-8 text-sm pl-8" placeholder="Search recipient, check #, carrier..." value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
            <Select value={dateRange} onValueChange={(v) => setDateRange(v as DateRange)}>
              <SelectTrigger className="h-8 text-sm w-36"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="this_month" className="text-xs">This month</SelectItem>
                <SelectItem value="last_month" className="text-xs">Last month</SelectItem>
                <SelectItem value="this_year" className="text-xs">This year</SelectItem>
                <SelectItem value="all" className="text-xs">All time</SelectItem>
              </SelectContent>
            </Select>
            <Select value={typeFilter} onValueChange={setTypeFilter}>
              <SelectTrigger className="h-8 text-sm w-36"><SelectValue placeholder="All types" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all" className="text-xs">All types</SelectItem>
                {Object.entries(ACCOUNT_TYPE_LABELS).map(([v, l]) => (
                  <SelectItem key={v} value={v} className="text-xs">{l}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="h-8 text-sm w-32"><SelectValue placeholder="All status" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all" className="text-xs">All status</SelectItem>
                <SelectItem value="settled" className="text-xs">Settled</SelectItem>
                <SelectItem value="submitted" className="text-xs">In Transit</SelectItem>
                <SelectItem value="returned" className="text-xs">Returned</SelectItem>
                <SelectItem value="failed" className="text-xs">Failed</SelectItem>
              </SelectContent>
            </Select>
            <Button size="sm" variant="outline" className="h-8 text-xs" onClick={exportCSV}>
              <Download className="h-3.5 w-3.5 mr-1" />Export CSV
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-6 text-center text-sm text-muted-foreground">Loading payments...</div>
          ) : filtered.length === 0 ? (
            <div className="p-6 text-center text-sm text-muted-foreground">No payments found for the selected filters.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-xs text-muted-foreground">
                    <th className="text-left p-3 font-medium">Date</th>
                    <th className="text-left p-3 font-medium">Recipient</th>
                    <th className="text-left p-3 font-medium hidden md:table-cell">Type</th>
                    <th className="text-left p-3 font-medium hidden md:table-cell">Check #</th>
                    <th className="text-left p-3 font-medium hidden lg:table-cell">Carrier</th>
                    <th className="text-right p-3 font-medium">Amount</th>
                    <th className="text-left p-3 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((p: any) => {
                    const acct = p.stakeholder_accounts;
                    const check = p.disbursement_batches?.check_intake_items;
                    const name = acct?.nickname ?? acct?.custname ?? p.recipient_name ?? "—";
                    const type = acct?.account_type ?? p.recipient_type ?? null;
                    const acctLabel = acct?.chk_acct
                      ? `••••${acct.chk_acct.slice(-4)}`
                      : p.method === "external_check"
                        ? (p.external_check_number ? `Ck #${p.external_check_number}` : "External check")
                        : "";
                    return (
                      <tr key={p.id} className="border-b last:border-0 hover:bg-muted/30 transition-colors">
                        <td className="p-3 text-xs text-muted-foreground whitespace-nowrap">{format(new Date(p.created_at), "MMM d, yyyy")}</td>
                        <td className="p-3">
                          <p className="font-medium text-xs">{name}</p>
                          {acctLabel && <p className="text-[10px] text-muted-foreground font-mono">{acctLabel}</p>}
                        </td>
                        <td className="p-3 hidden md:table-cell">
                          {acct ? (
                            <Badge variant="outline" className={`text-[10px] ${TYPE_COLORS[type ?? ""] ?? ""}`}>
                              {type ? (ACCOUNT_TYPE_LABELS[type] ?? type) : "—"}
                            </Badge>
                          ) : (
                            <Select value={type ?? "other"} onValueChange={(v) => updateType(p.id, v)}>
                              <SelectTrigger className={`h-6 text-[10px] px-1.5 border ${TYPE_COLORS[type ?? "other"] ?? ""} gap-1 w-auto min-w-[90px]`}>
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {EDITABLE_TYPES.map((t) => (
                                  <SelectItem key={t} value={t} className="text-xs">{ACCOUNT_TYPE_LABELS[t]}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          )}
                        </td>
                        <td className="p-3 text-xs font-mono hidden md:table-cell">{check?.check_number ?? "—"}</td>
                        <td className="p-3 text-xs hidden lg:table-cell text-muted-foreground">{check?.carrier_name ?? "—"}</td>
                        <td className="p-3 text-right font-medium text-sm">${Number(p.amount).toLocaleString("en-US", { minimumFractionDigits: 2 })}</td>
                        <td className="p-3">
                          <Badge variant="outline" className={`text-[10px] ${STATUS_COLORS[p.status] ?? ""}`}>
                            {p.status}{p.return_code && ` · ${p.return_code}`}
                          </Badge>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="border-t bg-muted/20">
                    <td colSpan={5} className="p-3 text-xs text-muted-foreground">{filtered.length} payment{filtered.length !== 1 ? "s" : ""}</td>
                    <td className="p-3 text-right font-semibold text-sm">
                      ${filtered.filter((p: any) => p.status === "settled").reduce((s: number, p: any) => s + Number(p.amount), 0).toLocaleString("en-US", { minimumFractionDigits: 2 })}
                    </td>
                    <td className="p-3 text-xs text-muted-foreground">settled</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

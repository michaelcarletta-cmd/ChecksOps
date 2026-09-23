import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/aws/client";
import { useTenant } from "@/contexts/TenantContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Download, Search, Users, Pencil } from "lucide-react";
import { toast } from "@/hooks/use-toast";
import { format, startOfYear, endOfYear, startOfMonth, endOfMonth, subMonths } from "date-fns";


const TYPE_LABELS: Record<string, string> = {
  subcontractor: "Subs",
  contractor: "Contractors",
  sales_rep: "Sales Reps",
  appraisal: "Appraisal",
  supplier: "Suppliers",
  adjuster: "Adjusters",
  vendor: "Vendors",
  client: "Insured",
  insured: "Insured",
  overhead: "Overhead",
  operating: "Operating",
  other: "Other",
};

const CATEGORY_TILES: { key: string; label: string }[] = [
  { key: "subcontractor", label: "Subs" },
  { key: "contractor", label: "Contractors" },
  { key: "sales_rep", label: "Sales Reps" },
  { key: "client", label: "Insured" },
  { key: "appraisal", label: "Appraisal" },
  { key: "supplier", label: "Suppliers" },
  { key: "adjuster", label: "Adjusters" },
];

const TYPE_COLORS: Record<string, string> = {
  vendor: "text-blue-600 border-blue-500/30 bg-blue-500/10",
  subcontractor: "text-purple-600 border-purple-500/30 bg-purple-500/10",
  supplier: "text-amber-600 border-amber-500/30 bg-amber-500/10",
  contractor: "text-emerald-600 border-emerald-500/30 bg-emerald-500/10",
  sales_rep: "text-pink-600 border-pink-500/30 bg-pink-500/10",
  appraisal: "text-indigo-600 border-indigo-500/30 bg-indigo-500/10",
  adjuster: "text-orange-600 border-orange-500/30 bg-orange-500/10",
  client: "text-teal-600 border-teal-500/30 bg-teal-500/10",
  insured: "text-cyan-600 border-cyan-500/30 bg-cyan-500/10",
  other: "text-muted-foreground border-border bg-muted/30",
};

type DateRange = "this_month" | "last_month" | "this_year" | "all";

export function RecipientReport() {
  const { tenant } = useTenant();
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [dateRange, setDateRange] = useState<DateRange>("this_year");
  const [editTarget, setEditTarget] = useState<{ name: string; type: string; count: number } | null>(null);
  const [editName, setEditName] = useState("");
  const [editType, setEditType] = useState("other");
  const [editSaving, setEditSaving] = useState(false);

  const openEdit = (name: string, type: string, count: number) => {
    setEditTarget({ name, type, count });
    setEditName(name);
    setEditType(type);
  };

  const saveEdit = async () => {
    if (!editTarget || !tenant?.id) return;
    const newName = editName.trim();
    if (!newName) {
      toast({ title: "Recipient name required", variant: "destructive" });
      return;
    }
    setEditSaving(true);
    try {
      const { error } = await (supabase as any)
        .from("disbursement_splits")
        .update({ recipient_name: newName, recipient_type: editType })
        .eq("tenant_id", tenant.id)
        .eq("recipient_name", editTarget.name)
        .eq("recipient_type", editTarget.type);
      if (error) throw error;
      toast({ title: "Recipient updated", description: `${editTarget.count} payment${editTarget.count !== 1 ? "s" : ""} updated` });
      setEditTarget(null);
      qc.invalidateQueries({ queryKey: ["recipient-report", tenant.id] });
      qc.invalidateQueries({ queryKey: ["recurring-recipients", tenant.id] });
    } catch (e: any) {
      toast({ title: "Couldn't update recipient", description: e.message, variant: "destructive" });
    } finally {
      setEditSaving(false);
    }
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

  const { data: rows = [], isLoading } = useQuery({
    queryKey: ["recipient-report", tenant?.id, dateRange],
    enabled: !!tenant?.id,
    queryFn: async () => {
      let q = (supabase as any)
        .from("disbursement_splits")
        .select(`
          id, amount, status, method, recipient_name, recipient_type, created_at, settled_at,
          stakeholder_accounts (id, nickname, custname, account_type, chk_acct)
        `)
        .eq("tenant_id", tenant!.id)
        .neq("status", "pending")
        .order("created_at", { ascending: false });
      if (dateFilters) {
        q = q.gte("created_at", dateFilters.from.toISOString())
             .lte("created_at", dateFilters.to.toISOString());
      }
      const { data, error } = await q;
      if (error) throw error;
      return data ?? [];
    },
  });

  const normalized = useMemo(() => {
    return (rows as any[]).map((r) => {
      const acct = r.stakeholder_accounts;
      const name = acct?.nickname ?? acct?.custname ?? r.recipient_name ?? "—";
      const type = acct?.account_type ?? r.recipient_type ?? "other";
      const acct4 = acct?.chk_acct ? `••••${acct.chk_acct.slice(-4)}` : (r.method === "external_check" ? "External check" : "—");
      return {
        id: r.id,
        date: r.settled_at ?? r.created_at,
        name,
        type,
        acct4,
        amount: Number(r.amount ?? 0),
        status: r.status,
        method: r.method ?? "ach",
      };
    });
  }, [rows]);

  const filtered = useMemo(() => normalized.filter((r) => {
    const matchSearch = !search || r.name.toLowerCase().includes(search.toLowerCase());
    const matchType = typeFilter === "all" || r.type === typeFilter;
    return matchSearch && matchType;
  }), [normalized, search, typeFilter]);

  const byType = useMemo(() => {
    const acc: Record<string, { total: number; count: number; recipients: Set<string> }> = {};
    for (const r of filtered) {
      if (r.status !== "settled") continue;
      const k = r.type;
      if (!acc[k]) acc[k] = { total: 0, count: 0, recipients: new Set() };
      acc[k].total += r.amount;
      acc[k].count += 1;
      acc[k].recipients.add(r.name);
    }
    return Object.entries(acc)
      .map(([type, v]) => ({ type, total: v.total, count: v.count, recipients: v.recipients.size }))
      .sort((a, b) => b.total - a.total);
  }, [filtered]);

  const byRecipient = useMemo(() => {
    const acc: Record<string, { name: string; type: string; total: number; count: number; last: string }> = {};
    for (const r of filtered) {
      if (r.status !== "settled") continue;
      const k = `${r.type}|${r.name}`;
      if (!acc[k]) acc[k] = { name: r.name, type: r.type, total: 0, count: 0, last: r.date };
      acc[k].total += r.amount;
      acc[k].count += 1;
      if (new Date(r.date) > new Date(acc[k].last)) acc[k].last = r.date;
    }
    return Object.values(acc).sort((a, b) => b.total - a.total);
  }, [filtered]);

  const grandTotal = byType.reduce((s, t) => s + t.total, 0);

  const exportCSV = () => {
    const headers = ["Recipient", "Type", "Total Paid", "Payment Count", "Last Paid"];
    const rs = byRecipient.map((r) => [
      r.name,
      TYPE_LABELS[r.type] ?? r.type,
      r.total.toFixed(2),
      r.count,
      format(new Date(r.last), "yyyy-MM-dd"),
    ]);
    const csv = [headers, ...rs].map((row) => row.map((v) => `"${v}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `recipient_report_${format(new Date(), "yyyy-MM-dd")}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const tileTotals = useMemo(() => {
    const acc: Record<string, { total: number; count: number; recipients: Set<string> }> = {};
    for (const r of normalized) {
      if (r.status !== "settled") continue;
      if (!acc[r.type]) acc[r.type] = { total: 0, count: 0, recipients: new Set() };
      acc[r.type].total += r.amount;
      acc[r.type].count += 1;
      acc[r.type].recipients.add(r.name);
    }
    return acc;
  }, [normalized]);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
        {CATEGORY_TILES.map((t) => {
          const v = tileTotals[t.key] ?? { total: 0, count: 0, recipients: new Set() };
          const active = typeFilter === t.key;
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => setTypeFilter(active ? "all" : t.key)}
              className={`text-left rounded-lg border p-3 transition-colors hover:bg-muted/40 ${active ? "border-primary bg-primary/5" : ""}`}
            >
              <div className="flex items-center justify-between mb-1">
                <Badge variant="outline" className={`text-[10px] ${TYPE_COLORS[t.key] ?? ""}`}>{t.label}</Badge>
                <span className="text-[10px] text-muted-foreground">{v.recipients.size}</span>
              </div>
              <p className="text-sm font-semibold">${v.total.toLocaleString("en-US", { minimumFractionDigits: 2 })}</p>
              <p className="text-[10px] text-muted-foreground">{v.count} payment{v.count !== 1 ? "s" : ""}</p>
            </button>
          );
        })}
      </div>

      <Card>
        <CardContent className="pt-3 pb-3">
          <div className="flex flex-wrap gap-2 items-center">
            <div className="relative flex-1 min-w-48">
              <Search className="absolute left-2.5 top-2 h-3.5 w-3.5 text-muted-foreground" />
              <Input className="h-8 text-sm pl-8" placeholder="Search recipient name..." value={search} onChange={(e) => setSearch(e.target.value)} />
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
              <SelectTrigger className="h-8 text-sm w-40"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all" className="text-xs">All types</SelectItem>
                {Object.entries(TYPE_LABELS).map(([v, l]) => (
                  <SelectItem key={v} value={v} className="text-xs">{l}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button size="sm" variant="outline" className="h-8 text-xs" onClick={exportCSV}>
              <Download className="h-3.5 w-3.5 mr-1" />Export CSV
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Users className="h-4 w-4" />Totals by Recipient Type
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-4 text-center text-sm text-muted-foreground">Loading...</div>
          ) : byType.length === 0 ? (
            <div className="p-4 text-center text-sm text-muted-foreground">No settled payments in this range.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-xs text-muted-foreground">
                    <th className="text-left p-3 font-medium">Type</th>
                    <th className="text-right p-3 font-medium">Recipients</th>
                    <th className="text-right p-3 font-medium">Payments</th>
                    <th className="text-right p-3 font-medium">Total Paid</th>
                    <th className="text-right p-3 font-medium hidden sm:table-cell">% of Total</th>
                  </tr>
                </thead>
                <tbody>
                  {byType.map((t) => (
                    <tr key={t.type} className="border-b last:border-0 hover:bg-muted/30">
                      <td className="p-3">
                        <Badge variant="outline" className={`text-[10px] ${TYPE_COLORS[t.type] ?? ""}`}>
                          {TYPE_LABELS[t.type] ?? t.type}
                        </Badge>
                      </td>
                      <td className="p-3 text-right text-xs">{t.recipients}</td>
                      <td className="p-3 text-right text-xs">{t.count}</td>
                      <td className="p-3 text-right font-semibold text-sm">
                        ${t.total.toLocaleString("en-US", { minimumFractionDigits: 2 })}
                      </td>
                      <td className="p-3 text-right text-xs text-muted-foreground hidden sm:table-cell">
                        {grandTotal > 0 ? ((t.total / grandTotal) * 100).toFixed(1) : "0.0"}%
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t bg-muted/20">
                    <td className="p-3 text-xs text-muted-foreground" colSpan={3}>Total</td>
                    <td className="p-3 text-right font-semibold text-sm">
                      ${grandTotal.toLocaleString("en-US", { minimumFractionDigits: 2 })}
                    </td>
                    <td className="p-3 hidden sm:table-cell" />
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Per-Recipient Detail</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {byRecipient.length === 0 ? (
            <div className="p-4 text-center text-sm text-muted-foreground">No recipients to show.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-xs text-muted-foreground">
                    <th className="text-left p-3 font-medium">Recipient</th>
                    <th className="text-left p-3 font-medium">Type</th>
                    <th className="text-right p-3 font-medium hidden sm:table-cell">Payments</th>
                    <th className="text-right p-3 font-medium">Total Paid</th>
                    <th className="text-left p-3 font-medium hidden md:table-cell">Last Paid</th>
                    <th className="p-3 w-10"></th>
                  </tr>
                </thead>
                <tbody>
                  {byRecipient.map((r, i) => (
                    <tr key={i} className="border-b last:border-0 hover:bg-muted/30">
                      <td className="p-3 font-medium text-xs">{r.name}</td>
                      <td className="p-3">
                        <Badge variant="outline" className={`text-[10px] ${TYPE_COLORS[r.type] ?? ""}`}>
                          {TYPE_LABELS[r.type] ?? r.type}
                        </Badge>
                      </td>
                      <td className="p-3 text-right text-xs hidden sm:table-cell">{r.count}</td>
                      <td className="p-3 text-right font-semibold text-sm">
                        ${r.total.toLocaleString("en-US", { minimumFractionDigits: 2 })}
                      </td>
                      <td className="p-3 text-xs text-muted-foreground hidden md:table-cell">
                        {format(new Date(r.last), "MMM d, yyyy")}
                      </td>
                      <td className="p-3 text-right">
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 w-7 p-0"
                          title="Edit recipient"
                          onClick={() => openEdit(r.name, r.type, r.count)}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={!!editTarget} onOpenChange={(o) => !o && setEditTarget(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Edit recipient</DialogTitle>
          </DialogHeader>
          {editTarget && (
            <div className="space-y-3">
              <p className="text-xs text-muted-foreground">
                Updates <span className="font-medium text-foreground">{editTarget.count}</span> payment
                {editTarget.count !== 1 ? "s" : ""} tied to <span className="font-medium text-foreground">{editTarget.name}</span>.
                To merge with an existing recipient, enter that recipient's exact name and matching type.
              </p>
              <div className="space-y-1.5">
                <Label className="text-xs">Recipient name</Label>
                <Input value={editName} onChange={(e) => setEditName(e.target.value)} className="h-9 text-sm" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Type</Label>
                <Select value={editType} onValueChange={setEditType}>
                  <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {Object.entries(TYPE_LABELS).map(([v, l]) => (
                      <SelectItem key={v} value={v} className="text-xs">{l}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditTarget(null)}>Cancel</Button>
            <Button onClick={saveEdit} disabled={editSaving}>
              {editSaving ? "Saving..." : "Save changes"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

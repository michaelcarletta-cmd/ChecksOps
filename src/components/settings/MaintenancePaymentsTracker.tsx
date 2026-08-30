import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { DollarSign, Plus, Trash2, Loader2 } from "lucide-react";
import { format, startOfMonth, endOfMonth } from "date-fns";

export function MaintenancePaymentsTracker() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    tenant_id: "",
    amount: "100.00",
    period_start: format(startOfMonth(new Date()), "yyyy-MM-dd"),
    period_end: format(endOfMonth(new Date()), "yyyy-MM-dd"),
    method: "stripe",
    reference: "",
    notes: "",
  });

  const { data: tenants = [] } = useQuery({
    queryKey: ["maint-tenants"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("tenants")
        .select("id, name, monthly_rate_cents, referral_discount_cents")
        .eq("is_system_tenant", false)
        .order("name");
      if (error) throw error;
      return data ?? [];
    },
  });

  const { data: payments = [], isLoading } = useQuery({
    queryKey: ["maintenance-payments"],
    refetchOnMount: "always",
    queryFn: async () => {
      const { data, error } = await supabase
        .from("tenant_maintenance_payments")
        .select("id, tenant_id, amount_cents, period_start, period_end, method, reference, notes, received_at, status, failure_reason, tenants:tenant_id(name)")
        .order("received_at", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });

  const addMutation = useMutation({
    mutationFn: async () => {
      if (!form.tenant_id) throw new Error("Select a tenant");
      const cents = Math.round(parseFloat(form.amount) * 100);
      if (!Number.isFinite(cents) || cents < 0) throw new Error("Invalid amount");
      const { error } = await supabase.from("tenant_maintenance_payments").insert({
        tenant_id: form.tenant_id,
        amount_cents: cents,
        period_start: form.period_start,
        period_end: form.period_end,
        method: form.method,
        reference: form.reference || null,
        notes: form.notes || null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Payment logged");
      setOpen(false);
      qc.invalidateQueries({ queryKey: ["maintenance-payments"] });
    },
    onError: (e: any) => toast.error(e?.message ?? "Failed to save"),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("tenant_maintenance_payments").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Payment removed");
      qc.invalidateQueries({ queryKey: ["maintenance-payments"] });
    },
    onError: (e: any) => toast.error(e?.message ?? "Failed to delete"),
  });

  const total = payments.reduce((s: number, p: any) => s + p.amount_cents, 0) / 100;
  const thisMonthTotal = payments
    .filter((p: any) => new Date(p.received_at) >= startOfMonth(new Date()))
    .reduce((s: number, p: any) => s + p.amount_cents, 0) / 100;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <DollarSign className="h-4 w-4" />
              Maintenance Fee Payments
            </CardTitle>
            <CardDescription>
              Track monthly maintenance fees received from tenants (after referral discounts). Total: <strong>${total.toFixed(2)}</strong> · This month: <strong>${thisMonthTotal.toFixed(2)}</strong>
            </CardDescription>
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" onClick={() => setOpen(!open)}>
              <Plus className="h-3.5 w-3.5 mr-1.5" /> Log manual
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {open && (
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3 p-3 rounded-md border bg-muted/30">
            <div className="col-span-2 md:col-span-1 space-y-1">
              <Label>Tenant</Label>
              <Select value={form.tenant_id} onValueChange={(v) => setForm({ ...form, tenant_id: v })}>
                <SelectTrigger><SelectValue placeholder="Select tenant" /></SelectTrigger>
                <SelectContent>
                  {tenants.map((t: any) => {
                    const eff = ((t.monthly_rate_cents || 0) - (t.referral_discount_cents || 0)) / 100;
                    return (
                      <SelectItem key={t.id} value={t.id}>
                        {t.name} (${eff.toFixed(2)}/mo)
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Amount (USD)</Label>
              <Input type="number" step="0.01" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label>Method</Label>
              <Select value={form.method} onValueChange={(v) => setForm({ ...form, method: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="stripe">Stripe</SelectItem>
                  <SelectItem value="ach">ACH</SelectItem>
                  <SelectItem value="check">Check</SelectItem>
                  <SelectItem value="wire">Wire</SelectItem>
                  <SelectItem value="other">Other</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Period start</Label>
              <Input type="date" value={form.period_start} onChange={(e) => setForm({ ...form, period_start: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label>Period end</Label>
              <Input type="date" value={form.period_end} onChange={(e) => setForm({ ...form, period_end: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label>Reference</Label>
              <Input value={form.reference} onChange={(e) => setForm({ ...form, reference: e.target.value })} placeholder="Invoice # / txn id" />
            </div>
            <div className="col-span-2 md:col-span-3 space-y-1">
              <Label>Notes</Label>
              <Input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
            </div>
            <div className="col-span-2 md:col-span-3 flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>Cancel</Button>
              <Button size="sm" onClick={() => addMutation.mutate()} disabled={addMutation.isPending}>Save</Button>
            </div>
          </div>
        )}

        <div className="border rounded-md overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Received</TableHead>
                <TableHead>Tenant</TableHead>
                <TableHead>Period</TableHead>
                <TableHead>Method</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Reference</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow><TableCell colSpan={8} className="text-center text-xs py-8 text-muted-foreground">Loading…</TableCell></TableRow>
              ) : payments.length === 0 ? (
                <TableRow><TableCell colSpan={8} className="text-center text-xs py-8 text-muted-foreground">No payments logged yet.</TableCell></TableRow>
              ) : payments.map((p: any) => (
                <TableRow key={p.id}>
                  <TableCell className="text-xs">{format(new Date(p.received_at), "MMM d, yyyy")}</TableCell>
                  <TableCell className="text-xs font-medium">{p.tenants?.name ?? "—"}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{format(new Date(p.period_start), "MMM d")} – {format(new Date(p.period_end), "MMM d")}</TableCell>
                  <TableCell><Badge variant="outline" className="text-[10px]">{p.method}</Badge></TableCell>
                  <TableCell>
                    <Badge variant={p.status === "submitted" || p.status === "cleared" ? "default" : p.status === "failed" || p.status === "returned" ? "destructive" : "outline"} className="text-[10px]">
                      {p.status ?? "recorded"}
                    </Badge>
                    {p.failure_reason && <div className="text-[10px] text-destructive mt-0.5">{p.failure_reason}</div>}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{p.reference || "—"}</TableCell>
                  <TableCell className="text-right text-xs font-bold tabular-nums">${(p.amount_cents / 100).toFixed(2)}</TableCell>
                  <TableCell className="text-right">
                    <Button variant="ghost" size="icon" onClick={() => deleteMutation.mutate(p.id)} className="h-7 w-7">
                      <Trash2 className="h-3.5 w-3.5 text-destructive" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

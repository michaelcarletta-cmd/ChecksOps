import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CalendarRange, Loader2 } from "lucide-react";
import { toast } from "@/hooks/use-toast";

interface Props {
  claimId: string;
  tenantId: string;
}

const STATUSES = [
  { value: "tentative", label: "Tentative" },
  { value: "confirmed", label: "Confirmed" },
  { value: "rescheduled", label: "Rescheduled" },
  { value: "in_progress", label: "In progress" },
  { value: "on_hold", label: "On hold" },
  { value: "complete", label: "Complete" },
];

type PlanForm = {
  start_window_start: string;
  start_window_end: string;
  schedule_status: string;
  schedule_note: string;
  contract_total: string;
  deductible_amount: string;
  other_out_of_pocket: string;
  share_with_homeowner: boolean;
  allow_deductible_payment: boolean;
};

const EMPTY: PlanForm = {
  start_window_start: "",
  start_window_end: "",
  schedule_status: "tentative",
  schedule_note: "",
  contract_total: "",
  deductible_amount: "",
  other_out_of_pocket: "",
  share_with_homeowner: true,
  allow_deductible_payment: true,
};

const num = (v: string) => (v.trim() === "" ? null : Number(v));

export function ProjectPlanCard({ claimId, tenantId }: Props) {
  const qc = useQueryClient();
  const [form, setForm] = useState<PlanForm>(EMPTY);
  const [saving, setSaving] = useState(false);

  const { data: plan, isLoading } = useQuery({
    queryKey: ["claim-project-plan", claimId],
    enabled: !!claimId,
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("claim_project_plans")
        .select("*")
        .eq("claim_id", claimId)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  const { data: paid = 0 } = useQuery({
    queryKey: ["claim-deductible-paid", claimId],
    enabled: !!claimId,
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("homeowner_deductible_payments")
        .select("amount, status")
        .eq("claim_id", claimId);
      if (error) throw error;
      return (data ?? [])
        .filter((r: any) => !["failed", "returned", "canceled"].includes(String(r.status)))
        .reduce((s: number, r: any) => s + Number(r.amount ?? 0), 0);
    },
  });

  useEffect(() => {
    if (!plan) return;
    setForm({
      start_window_start: plan.start_window_start ?? "",
      start_window_end: plan.start_window_end ?? "",
      schedule_status: plan.schedule_status ?? "tentative",
      schedule_note: plan.schedule_note ?? "",
      contract_total: plan.contract_total != null ? String(plan.contract_total) : "",
      deductible_amount: plan.deductible_amount != null ? String(plan.deductible_amount) : "",
      other_out_of_pocket: plan.other_out_of_pocket != null ? String(plan.other_out_of_pocket) : "",
      share_with_homeowner: plan.share_with_homeowner ?? true,
      allow_deductible_payment: plan.allow_deductible_payment ?? true,
    });
  }, [plan]);

  const save = async () => {
    setSaving(true);
    try {
      const payload = {
        tenant_id: tenantId,
        claim_id: claimId,
        start_window_start: form.start_window_start || null,
        start_window_end: form.start_window_end || null,
        schedule_status: form.schedule_status,
        schedule_note: form.schedule_note || null,
        contract_total: num(form.contract_total),
        deductible_amount: num(form.deductible_amount),
        other_out_of_pocket: num(form.other_out_of_pocket),
        share_with_homeowner: form.share_with_homeowner,
        allow_deductible_payment: form.allow_deductible_payment,
      };
      const query = plan?.id
        ? (supabase as any).from("claim_project_plans").update(payload).eq("id", plan.id)
        : (supabase as any).from("claim_project_plans").insert(payload);
      const { error } = await query;
      if (error) throw error;
      toast({ title: "Project details saved", description: "The homeowner timeline is updated." });
      qc.invalidateQueries({ queryKey: ["claim-project-plan", claimId] });
    } catch (e: any) {
      toast({ title: "Couldn't save", description: e.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const deductible = Number(form.deductible_amount || 0);
  const due = Math.max(0, deductible - paid);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          <CalendarRange className="h-4 w-4 text-primary" />
          Project schedule &amp; homeowner costs
        </CardTitle>
        <p className="text-[11px] text-muted-foreground">
          Shown on the homeowner tracking timeline. The homeowner can pay their deductible from there.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading ? (
          <div className="flex justify-center py-6"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>
        ) : (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <div className="space-y-1">
                <Label className="text-[11px]">Tentative start</Label>
                <Input type="date" className="h-8 text-xs" value={form.start_window_start}
                  onChange={(e) => setForm({ ...form, start_window_start: e.target.value })} />
              </div>
              <div className="space-y-1">
                <Label className="text-[11px]">Through</Label>
                <Input type="date" className="h-8 text-xs" value={form.start_window_end}
                  onChange={(e) => setForm({ ...form, start_window_end: e.target.value })} />
              </div>
              <div className="space-y-1">
                <Label className="text-[11px]">Status</Label>
                <Select value={form.schedule_status} onValueChange={(v) => setForm({ ...form, schedule_status: v })}>
                  <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {STATUSES.map((s) => <SelectItem key={s.value} value={s.value} className="text-xs">{s.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-1">
              <Label className="text-[11px]">Note to homeowner</Label>
              <Textarea rows={2} className="text-xs" placeholder="Materials arrive the week prior; crew starts weather permitting."
                value={form.schedule_note} onChange={(e) => setForm({ ...form, schedule_note: e.target.value })} />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <div className="space-y-1">
                <Label className="text-[11px]">Total project / claim amount</Label>
                <Input type="number" step="0.01" className="h-8 text-xs" placeholder="0.00"
                  value={form.contract_total} onChange={(e) => setForm({ ...form, contract_total: e.target.value })} />
              </div>
              <div className="space-y-1">
                <Label className="text-[11px]">Deductible</Label>
                <Input type="number" step="0.01" className="h-8 text-xs" placeholder="0.00"
                  value={form.deductible_amount} onChange={(e) => setForm({ ...form, deductible_amount: e.target.value })} />
              </div>
              <div className="space-y-1">
                <Label className="text-[11px]">Other out of pocket</Label>
                <Input type="number" step="0.01" className="h-8 text-xs" placeholder="0.00"
                  value={form.other_out_of_pocket} onChange={(e) => setForm({ ...form, other_out_of_pocket: e.target.value })} />
              </div>
            </div>

            {deductible > 0 && (
              <p className="text-[11px] text-muted-foreground">
                Deductible collected: ${paid.toFixed(2)} · Still due: ${due.toFixed(2)}
              </p>
            )}

            <div className="flex flex-wrap items-center gap-4">
              <label className="flex items-center gap-2 text-[11px]">
                <Switch checked={form.share_with_homeowner}
                  onCheckedChange={(v) => setForm({ ...form, share_with_homeowner: v })} />
                Show on homeowner timeline
              </label>
              <label className="flex items-center gap-2 text-[11px]">
                <Switch checked={form.allow_deductible_payment}
                  onCheckedChange={(v) => setForm({ ...form, allow_deductible_payment: v })} />
                Allow online deductible payment
              </label>
            </div>

            <Button size="sm" className="h-8 text-xs" disabled={saving} onClick={save}>
              {saving ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : null}
              Save project details
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}

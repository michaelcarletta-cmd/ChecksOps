import { useState, useEffect } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  claimId: string;
  settlement: any | null;
}

type Category = "dwelling" | "other_structures" | "pwi" | "personal_property" | "ale";

const CAT_LABEL: Record<Category, string> = {
  dwelling: "Dwelling",
  other_structures: "Other Structures",
  pwi: "Ordinance & Law",
  personal_property: "Personal Property",
  ale: "Add'l Living Exp.",
};

// Map category → DB column names
const COLS: Record<Category, { rcv: string; recDep: string; nonRecDep: string; deductible: string | null }> = {
  dwelling: {
    rcv: "replacement_cost_value",
    recDep: "recoverable_depreciation",
    nonRecDep: "non_recoverable_depreciation",
    deductible: "deductible",
  },
  other_structures: {
    rcv: "other_structures_rcv",
    recDep: "other_structures_recoverable_depreciation",
    nonRecDep: "other_structures_non_recoverable_depreciation",
    deductible: "other_structures_deductible",
  },
  pwi: {
    rcv: "pwi_rcv",
    recDep: "pwi_recoverable_depreciation",
    nonRecDep: "pwi_non_recoverable_depreciation",
    deductible: null,
  },
  personal_property: {
    rcv: "personal_property_rcv",
    recDep: "personal_property_recoverable_depreciation",
    nonRecDep: "personal_property_non_recoverable_depreciation",
    deductible: null,
  },
  ale: {
    rcv: "ale_rcv",
    recDep: "ale_recoverable_depreciation",
    nonRecDep: "ale_non_recoverable_depreciation",
    deductible: null,
  },
};

const num = (v: any) => Number(v || 0);

export function ClaimSettlementEditor({ open, onOpenChange, claimId, settlement }: Props) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [tab, setTab] = useState<Category>("dwelling");
  const [form, setForm] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!open) return;
    const s = settlement || {};
    const init: Record<string, string> = {};
    (Object.keys(COLS) as Category[]).forEach((cat) => {
      const c = COLS[cat];
      init[c.rcv] = String(num(s[c.rcv]));
      init[c.recDep] = String(num(s[c.recDep]));
      init[c.nonRecDep] = String(num(s[c.nonRecDep]));
      if (c.deductible) init[c.deductible] = String(num(s[c.deductible]));
    });
    setForm(init);
  }, [open, settlement]);

  const set = (k: string, v: string) => setForm((prev) => ({ ...prev, [k]: v }));

  const save = useMutation({
    mutationFn: async () => {
      const payload: any = { claim_id: claimId };
      Object.keys(form).forEach((k) => {
        const n = parseFloat(form[k]);
        payload[k] = Number.isFinite(n) && n >= 0 ? n : 0;
      });
      if (settlement?.id) {
        const { error } = await supabase
          .from("claim_settlements")
          .update(payload)
          .eq("id", settlement.id);
        if (error) throw error;
      } else {
        const { data: { user } } = await supabase.auth.getUser();
        const { error } = await supabase
          .from("claim_settlements")
          .insert({ ...payload, created_by: user?.id });
        if (error) throw error;
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["claim-ledger-settlement", claimId] });
      qc.invalidateQueries({ queryKey: ["claim-settlement", claimId] });
      toast({ title: "Settlement saved" });
      onOpenChange(false);
    },
    onError: (e: any) => {
      toast({ title: "Save failed", description: e.message, variant: "destructive" });
    },
  });

  const c = COLS[tab];
  const rcv = parseFloat(form[c.rcv] || "0") || 0;
  const recDep = parseFloat(form[c.recDep] || "0") || 0;
  const nonRecDep = parseFloat(form[c.nonRecDep] || "0") || 0;
  const ded = c.deductible ? (parseFloat(form[c.deductible] || "0") || 0) : 0;
  const acv = Math.max(0, rcv - recDep - nonRecDep - ded);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Claim Settlement Amounts</DialogTitle>
        </DialogHeader>

        <Tabs value={tab} onValueChange={(v) => setTab(v as Category)}>
          <TabsList className="grid grid-cols-5 h-auto">
            {(Object.keys(CAT_LABEL) as Category[]).map((k) => (
              <TabsTrigger key={k} value={k} className="text-[10px] px-1 py-1.5">
                {CAT_LABEL[k].split(" ")[0]}
              </TabsTrigger>
            ))}
          </TabsList>

          {(Object.keys(COLS) as Category[]).map((cat) => {
            const cols = COLS[cat];
            return (
              <TabsContent key={cat} value={cat} className="space-y-3 mt-3">
                <p className="text-xs text-muted-foreground">{CAT_LABEL[cat]}</p>
                <div className="space-y-2">
                  <Field label="Replacement Cost Value (RCV)" value={form[cols.rcv] ?? ""} onChange={(v) => set(cols.rcv, v)} />
                  <Field label="Recoverable Depreciation" value={form[cols.recDep] ?? ""} onChange={(v) => set(cols.recDep, v)} />
                  <Field label="Non-Recoverable Depreciation" value={form[cols.nonRecDep] ?? ""} onChange={(v) => set(cols.nonRecDep, v)} />
                  {cols.deductible && (
                    <Field label="Deductible" value={form[cols.deductible] ?? ""} onChange={(v) => set(cols.deductible!, v)} />
                  )}
                </div>
                <div className="rounded-md bg-muted/50 p-2 flex justify-between text-sm">
                  <span className="text-muted-foreground">Actual Cash Value (ACV)</span>
                  <span className="font-bold tabular-nums">
                    ${acv.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </span>
                </div>
              </TabsContent>
            );
          })}
        </Tabs>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? "Saving..." : "Save All Categories"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      <Input
        type="number"
        inputMode="decimal"
        step="0.01"
        min="0"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 text-sm"
      />
    </div>
  );
}

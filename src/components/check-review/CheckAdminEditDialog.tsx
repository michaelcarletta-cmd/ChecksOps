import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Loader2, Pencil, ShieldAlert, AlertTriangle } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { useQuery, useQueryClient } from "@tanstack/react-query";

const STATUS_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "uploaded", label: "Uploaded" },
  { value: "processing", label: "Processing" },
  { value: "ocr_complete", label: "OCR Complete" },
  { value: "needs_review", label: "Needs Review" },
  { value: "manual_review_required", label: "Manual Review Required" },
  { value: "endorsements_in_progress", label: "Endorsements In Progress" },
  { value: "endorsements_complete", label: "Endorsements Complete" },
  { value: "approved_for_deposit", label: "Approved for Deposit" },
  { value: "branch_deposit_required", label: "Branch Deposit Required" },
  { value: "loss_draft_required", label: "Loss Draft Required" },
  { value: "reissue_requested", label: "Reissue Requested" },
  { value: "deposited", label: "Deposited" },
  { value: "voided", label: "Voided" },
];

const MORTGAGE_MONITORING_OPTIONS = [
  { value: "monitor", label: "Monitor (track release)" },
  { value: "skip", label: "Skip (no monitoring)" },
];

interface Props {
  /** check_intake_items.id */
  checkId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}

interface FormState {
  status: string;
  mortgage_flag: boolean;
  mortgage_monitoring_type: string; // 'not_set' | 'monitor' | 'skip'
  carrier_name: string;
  check_number: string;
  amount: string;
  payee_line: string;
  issue_date: string; // YYYY-MM-DD
  routing_number: string;
  account_number: string;
}

const MORTGAGE_HEURISTIC = /\b(mortgage|loan\s*servicing|rocket|wells\s*fargo|chase|mr\.?\s*cooper|freedom\s*mortgage|pennymac|carrington|caliber|loandepot|nationstar|shellpoint|servis\s*one|cenlar|midfirst|truist\s*bank|fifth\s*third|usaa\s*federal|bank\s*of\s*america.*home|flagstar)\b/i;

export function CheckAdminEditDialog({ checkId, open, onOpenChange, onSaved }: Props) {
  const qc = useQueryClient();
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<FormState>({
    status: "needs_review",
    mortgage_flag: false,
    mortgage_monitoring_type: "not_set",
    carrier_name: "",
    check_number: "",
    amount: "",
    payee_line: "",
    issue_date: "",
    routing_number: "",
    account_number: "",
  });

  const { data, isLoading } = useQuery({
    queryKey: ["check-admin-edit", checkId, open],
    enabled: open,
    queryFn: async () => {
      const [intake, claimCheck] = await Promise.all([
        supabase.from("check_intake_items")
          .select("id, status, check_number, payee_line, carrier_name, amount, issue_date, mortgage_monitoring_type, routing_number, account_number")
          .eq("id", checkId).maybeSingle(),
        supabase.from("claim_checks")
          .select("id, mortgage_flag, mortgage_monitoring_type, claim_id")
          .eq("check_intake_item_id", checkId).maybeSingle(),
      ]);
      if (intake.error) throw intake.error;
      return {
        intake: intake.data,
        claimCheck: claimCheck.data,
      };
    },
  });

  // Derive an honest initial value for the toggle: true if ANY system signal
  // says the check is mortgage-bound.
  useEffect(() => {
    if (!data?.intake) return;
    const intakeMonitoring = data.intake.mortgage_monitoring_type ?? "not_set";
    const intakeSaysMortgage = intakeMonitoring !== "not_set";
    const claimSaysMortgage = !!data.claimCheck?.mortgage_flag;
    const payeeSaysMortgage = MORTGAGE_HEURISTIC.test(data.intake.payee_line ?? "");
    const flag = intakeSaysMortgage || claimSaysMortgage || payeeSaysMortgage;

    const monitoring =
      intakeMonitoring !== "not_set"
        ? intakeMonitoring
        : data.claimCheck?.mortgage_monitoring_type && data.claimCheck.mortgage_monitoring_type !== "not_set"
          ? data.claimCheck.mortgage_monitoring_type
          : flag ? "monitor" : "not_set";

    setForm({
      status: data.intake.status ?? "needs_review",
      mortgage_flag: flag,
      mortgage_monitoring_type: monitoring,
      carrier_name: data.intake.carrier_name ?? "",
      check_number: data.intake.check_number ?? "",
      amount: data.intake.amount != null ? String(data.intake.amount) : "",
      payee_line: data.intake.payee_line ?? "",
      issue_date: (data.intake as any).issue_date ?? "",
      routing_number: (data.intake as any).routing_number ?? "",
      account_number: (data.intake as any).account_number ?? "",
    });
  }, [data]);

  const showLossDraftHint = useMemo(
    () => !form.mortgage_flag && data?.intake?.status === "loss_draft_required" && form.status === "loss_draft_required",
    [form, data],
  );

  async function handleSave() {
    if (!data?.intake) return;
    setSaving(true);
    const changes: string[] = [];
    try {
      const { data: { user } } = await supabase.auth.getUser();

      // 1. Status change on check_intake_items
      const intakeUpdates: Record<string, unknown> = {};

      // Safety net: if admin removes the mortgage flag while the check is sitting
      // in Loss Draft, automatically reroute it to Review so the endorsement
      // workflow can begin (otherwise the check would be lost in transit).
      let effectiveStatus = form.status;
      if (
        !form.mortgage_flag &&
        (form.status === "loss_draft_required" || data.intake.status === "loss_draft_required")
      ) {
        effectiveStatus = "needs_review";
      }

      if (effectiveStatus !== data.intake.status) {
        intakeUpdates.status = effectiveStatus;
        changes.push(`status → ${effectiveStatus.replace(/_/g, " ")}`);
      }

      // 2. Intake-level mortgage_monitoring_type — always persisted here so it
      // works even when there's no claim_checks row yet.
      const desiredIntakeMonitoring = form.mortgage_flag
        ? (form.mortgage_monitoring_type === "not_set" ? "monitor" : form.mortgage_monitoring_type)
        : "not_set";
      const currentIntakeMonitoring = data.intake.mortgage_monitoring_type ?? "not_set";
      if (desiredIntakeMonitoring !== currentIntakeMonitoring) {
        intakeUpdates.mortgage_monitoring_type = desiredIntakeMonitoring;
        changes.push(`mortgage routing → ${desiredIntakeMonitoring}`);
      }

      // 2b. Manual entry of OCR fields (carrier, check #, amount, payee, date)
      const trimOrNull = (s: string) => {
        const t = s.trim();
        return t.length === 0 ? null : t;
      };
      const newCarrier = trimOrNull(form.carrier_name);
      if (newCarrier !== (data.intake.carrier_name ?? null)) {
        intakeUpdates.carrier_name = newCarrier;
        changes.push(`carrier → ${newCarrier ?? "—"}`);
      }
      const newCheckNum = trimOrNull(form.check_number);
      if (newCheckNum !== (data.intake.check_number ?? null)) {
        intakeUpdates.check_number = newCheckNum;
        changes.push(`check # → ${newCheckNum ?? "—"}`);
      }
      const newPayee = trimOrNull(form.payee_line);
      if (newPayee !== (data.intake.payee_line ?? null)) {
        intakeUpdates.payee_line = newPayee;
        changes.push(`payee → ${newPayee ?? "—"}`);
      }
      const amountTrim = form.amount.trim();
      let newAmount: number | null = null;
      if (amountTrim.length > 0) {
        const parsed = Number(amountTrim.replace(/[$,]/g, ""));
        if (Number.isNaN(parsed)) {
          throw new Error("Amount must be a valid number");
        }
        newAmount = parsed;
      }
      const currentAmount = data.intake.amount != null ? Number(data.intake.amount) : null;
      if (newAmount !== currentAmount) {
        intakeUpdates.amount = newAmount;
        changes.push(`amount → ${newAmount != null ? `$${newAmount.toFixed(2)}` : "—"}`);
      }
      const dateTrim = form.issue_date.trim();
      const newDate = dateTrim.length === 0 ? null : dateTrim;
      const currentDate = (data.intake as any).issue_date ?? null;
      if (newDate !== currentDate) {
        if (newDate && !/^\d{4}-\d{2}-\d{2}$/.test(newDate)) {
          throw new Error("Issue date must be in YYYY-MM-DD format");
        }
        intakeUpdates.issue_date = newDate;
        changes.push(`date → ${newDate ?? "—"}`);
      }

      // Routing & account numbers (digits only; allow blank to clear)
      const digitsOrNull = (s: string): string | null => {
        const d = s.replace(/[^0-9]/g, "");
        return d.length === 0 ? null : d;
      };
      const newRouting = digitsOrNull(form.routing_number);
      const currentRouting = (data.intake as any).routing_number ?? null;
      if (newRouting !== currentRouting) {
        if (newRouting && newRouting.length !== 9) {
          throw new Error("Routing number must be exactly 9 digits");
        }
        intakeUpdates.routing_number = newRouting;
        changes.push(`routing # → ${newRouting ? `***${newRouting.slice(-4)}` : "—"}`);
      }
      const newAccount = digitsOrNull(form.account_number);
      const currentAccount = (data.intake as any).account_number ?? null;
      if (newAccount !== currentAccount) {
        intakeUpdates.account_number = newAccount;
        changes.push(`account # → ${newAccount ? `***${newAccount.slice(-4)}` : "—"}`);
      }

      if (Object.keys(intakeUpdates).length > 0) {
        intakeUpdates.updated_at = new Date().toISOString();
        const { error } = await supabase
          .from("check_intake_items")
          .update(intakeUpdates)
          .eq("id", checkId);
        if (error) throw error;

        await supabase.from("check_audit_log").insert([{
          check_id: checkId,
          event_type: "admin_correction",
          actor_id: user?.id ?? null,
          event_description: `Admin edit: ${Object.entries(intakeUpdates)
            .filter(([k]) => k !== "updated_at")
            .map(([k, v]) => `${k}=${v}`).join(", ")}`,
          event_data: intakeUpdates as Record<string, any>,
        }]);
      }

      // 3. Mirror to claim_checks if the row exists
      if (data.claimCheck?.id) {
        const ccUpdates: Record<string, unknown> = {};
        if (form.mortgage_flag !== data.claimCheck.mortgage_flag) {
          ccUpdates.mortgage_flag = form.mortgage_flag;
        }
        const ccCurrent = data.claimCheck.mortgage_monitoring_type ?? "not_set";
        if (desiredIntakeMonitoring !== ccCurrent) {
          ccUpdates.mortgage_monitoring_type = desiredIntakeMonitoring;
        }
        // Mirror manual OCR field corrections
        if (intakeUpdates.check_number !== undefined) ccUpdates.check_number = intakeUpdates.check_number;
        if (intakeUpdates.amount !== undefined) ccUpdates.amount = intakeUpdates.amount;
        if (intakeUpdates.payee_line !== undefined) ccUpdates.payee_line = intakeUpdates.payee_line;
        if (intakeUpdates.carrier_name !== undefined) ccUpdates.carrier_name = intakeUpdates.carrier_name;
        if (intakeUpdates.issue_date !== undefined) ccUpdates.check_date = intakeUpdates.issue_date;
        if (intakeUpdates.routing_number !== undefined) ccUpdates.routing_number = intakeUpdates.routing_number;
        if (intakeUpdates.account_number !== undefined) ccUpdates.account_number = intakeUpdates.account_number;
        if (Object.keys(ccUpdates).length > 0) {
          const { error } = await supabase
            .from("claim_checks")
            .update(ccUpdates)
            .eq("id", data.claimCheck.id);
          if (error) throw error;
        }
      }

      if (changes.length === 0) {
        toast.info("No changes to save");
      } else {
        toast.success(`Saved: ${changes.join(", ")}`);
      }

      qc.invalidateQueries({ queryKey: ["check-detail", checkId] });
      qc.invalidateQueries({ queryKey: ["check-intake-items"] });
      qc.invalidateQueries({ queryKey: ["loss-draft-checks"] });
      onSaved();
      onOpenChange(false);
    } catch (err: any) {
      toast.error(err?.message ?? "Failed to save changes");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldAlert className="h-4 w-4 text-amber-400" />
            Edit Check (Admin)
          </DialogTitle>
          <DialogDescription>
            Manually enter or correct check details, override workflow status, and adjust mortgage routing. All changes are logged.
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : !data?.intake ? (
          <p className="text-sm text-destructive py-4">Check not found.</p>
        ) : (
          <div className="space-y-5 py-2">
            <div className="text-xs text-muted-foreground rounded-md bg-muted/40 p-2 space-y-0.5">
              <div>Check #{data.intake.check_number ?? "—"} · ${data.intake.amount ?? "—"}</div>
              {data.intake.payee_line && <div>Payee: {data.intake.payee_line}</div>}
              {data.intake.carrier_name && <div>Carrier: {data.intake.carrier_name}</div>}
            </div>

            {/* Mortgage toggle — TOP, prominent, amber-bordered */}
            <div className="space-y-3 rounded-md border-2 border-amber-500/60 bg-amber-500/5 p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1">
                  <Label className="text-sm font-semibold flex items-center gap-1.5">
                    <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
                    Mortgage Company on Check
                  </Label>
                  <p className="text-[11px] text-muted-foreground mt-1">
                    Turn OFF to remove loss-draft / mortgage routing for this check
                    (use when payee has no mortgagee even if name suggests one).
                  </p>
                </div>
                <Switch
                  checked={form.mortgage_flag}
                  onCheckedChange={(v) => setForm((f) => ({
                    ...f,
                    mortgage_flag: v,
                    mortgage_monitoring_type: v
                      ? (f.mortgage_monitoring_type === "not_set" ? "monitor" : f.mortgage_monitoring_type)
                      : "not_set",
                  }))}
                />
              </div>

              {form.mortgage_flag && (
                <div className="space-y-1.5 pt-2 border-t border-amber-500/30">
                  <Label className="text-xs">Mortgage Monitoring</Label>
                  <Select
                    value={form.mortgage_monitoring_type === "not_set" ? "monitor" : form.mortgage_monitoring_type}
                    onValueChange={(v) => setForm((f) => ({ ...f, mortgage_monitoring_type: v }))}
                  >
                    <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {MORTGAGE_MONITORING_OPTIONS.map((m) => (
                        <SelectItem key={m.value} value={m.value} className="text-sm">{m.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              {showLossDraftHint && (
                <div className="text-[11px] rounded bg-amber-500/10 border border-amber-500/40 p-2 text-amber-200">
                  This check is in <strong>Loss Draft Required</strong>. Since you turned mortgage off,
                  it will be automatically moved to <strong>Review</strong> on save so you can begin
                  the endorsement process.
                </div>
              )}
            </div>

            {/* Manual entry of OCR fields — for when AI extraction failed
                or the check was uploaded in manual mode. */}
            <div className="space-y-3 rounded-md border border-border/60 bg-muted/20 p-3">
              <Label className="text-sm font-semibold">Check Details</Label>
              <p className="text-[11px] text-muted-foreground -mt-1">
                Enter or correct any field. Leave blank to clear.
              </p>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1 col-span-2">
                  <Label className="text-[11px]">Carrier</Label>
                  <Input
                    value={form.carrier_name}
                    onChange={(e) => setForm((f) => ({ ...f, carrier_name: e.target.value }))}
                    className="h-8 text-sm"
                    placeholder="e.g. State Farm"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-[11px]">Check #</Label>
                  <Input
                    value={form.check_number}
                    onChange={(e) => setForm((f) => ({ ...f, check_number: e.target.value }))}
                    className="h-8 text-sm"
                    placeholder="123456"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-[11px]">Amount ($)</Label>
                  <Input
                    inputMode="decimal"
                    value={form.amount}
                    onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))}
                    className="h-8 text-sm"
                    placeholder="0.00"
                  />
                </div>
                <div className="space-y-1 col-span-2">
                  <Label className="text-[11px]">Payee Line</Label>
                  <Input
                    value={form.payee_line}
                    onChange={(e) => setForm((f) => ({ ...f, payee_line: e.target.value }))}
                    className="h-8 text-sm"
                    placeholder="John Doe and Wells Fargo"
                  />
                </div>
                <div className="space-y-1 col-span-2">
                  <Label className="text-[11px]">Issue Date</Label>
                  <Input
                    type="date"
                    value={form.issue_date}
                    onChange={(e) => setForm((f) => ({ ...f, issue_date: e.target.value }))}
                    className="h-8 text-sm"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-[11px]">Routing # (9 digits)</Label>
                  <Input
                    inputMode="numeric"
                    value={form.routing_number}
                    onChange={(e) => setForm((f) => ({ ...f, routing_number: e.target.value.replace(/[^0-9]/g, "").slice(0, 9) }))}
                    className="h-8 text-sm font-mono"
                    placeholder="021000021"
                    maxLength={9}
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-[11px]">Account #</Label>
                  <Input
                    inputMode="numeric"
                    value={form.account_number}
                    onChange={(e) => setForm((f) => ({ ...f, account_number: e.target.value.replace(/[^0-9]/g, "").slice(0, 20) }))}
                    className="h-8 text-sm font-mono"
                    placeholder="From bottom of check"
                    maxLength={20}
                  />
                </div>
                <p className="text-[10px] text-muted-foreground col-span-2 -mt-1">
                  Routing & account numbers are read from the MICR line at the bottom of the check.
                </p>
              </div>
            </div>

            <div className="space-y-2">
              <Label className="text-xs">Workflow Status</Label>
              <Select value={form.status} onValueChange={(v) => setForm((f) => ({ ...f, status: v }))}>
                <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {STATUS_OPTIONS.map((s) => (
                    <SelectItem key={s.value} value={s.value} className="text-sm">{s.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground">
                Move from any status to any other (e.g. Loss Draft → Approved for Deposit).
              </p>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving || isLoading || !data?.intake}>
            {saving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Pencil className="h-4 w-4 mr-2" />}
            Save Changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

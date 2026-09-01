import { useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AlertTriangle, RotateCcw } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { CHECK_RETURN_CODES, resolveReturnCode } from "@/lib/checkReturnCodes";

/**
 * Logs a bank return against a check that was already deposited (and possibly
 * already cleared and disbursed). Routes through the record_check_return RPC
 * so the stage change, audit trail, reconciliation alert and clawback flag all
 * happen atomically — never write check_stage directly.
 */
export function MarkCheckReturnedDialog({
  checkId,
  checkLabel,
  open,
  onOpenChange,
  onRecorded,
}: {
  checkId: string;
  checkLabel?: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRecorded?: () => void;
}) {
  const { user } = useAuth();
  const { toast } = useToast();
  const [code, setCode] = useState("S");
  const [returnedAt, setReturnedAt] = useState(() => new Date().toISOString().slice(0, 10));
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  const selected = resolveReturnCode(code);

  const submit = async () => {
    setSaving(true);
    try {
      const { data, error } = await supabase.rpc("record_check_return" as any, {
        p_check_id: checkId,
        p_return_code: code,
        p_return_reason: selected?.label ?? "Returned by paying bank",
        p_returned_at: new Date(`${returnedAt}T12:00:00Z`).toISOString(),
        p_notes: notes.trim() || null,
        p_actor_id: user?.id ?? null,
        p_source: "manual",
      });
      if (error) throw error;

      const exposure = (data as any)?.clawback_exposure;
      toast({
        title: "Return recorded",
        description: exposure
          ? "This check was already disbursed — a clawback alert was raised in Reconciliation."
          : "The check moved to Returned and a reconciliation alert was raised.",
        variant: exposure ? "destructive" : undefined,
      });
      onOpenChange(false);
      setNotes("");
      onRecorded?.();
    } catch (e: any) {
      toast({ title: "Could not record return", description: e.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <RotateCcw className="h-4 w-4 text-orange-400" />
            Mark check returned
          </DialogTitle>
          <DialogDescription className="text-xs">
            {checkLabel ? `${checkLabel} — ` : ""}
            Use this when the bank sends the item back after deposit, including
            late returns that arrive after it already cleared.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs">Bank return reason (X9 / CheckAlt code)</Label>
            <Select value={code} onValueChange={setCode}>
              <SelectTrigger className="h-9 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="max-h-72">
                {CHECK_RETURN_CODES.map((entry) => (
                  <SelectItem key={entry.code} value={entry.code} className="text-xs">
                    {entry.code === "OTHER" ? entry.label : `${entry.code} — ${entry.label}`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {selected && <p className="text-[11px] text-muted-foreground">{selected.description}</p>}
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">Return date</Label>
            <Input
              type="date"
              value={returnedAt}
              onChange={(e) => setReturnedAt(e.target.value)}
              className="h-9 text-xs"
            />
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">Notes</Label>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              placeholder="Bank advice number, who was notified, next step…"
              className="text-xs"
            />
          </div>

          {selected && !selected.redepositable && selected.code !== "OTHER" && (
            <div className="flex gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-[11px] text-amber-200">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              <span>
                This reason is not re-presentable — the check must be reissued by the carrier.
              </span>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button size="sm" variant="destructive" onClick={submit} disabled={saving}>
            {saving ? "Recording…" : "Record return"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

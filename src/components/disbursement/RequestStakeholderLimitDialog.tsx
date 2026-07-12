import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useTenant } from "@/contexts/TenantContext";
import { useToast } from "@/hooks/use-toast";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Loader2 } from "lucide-react";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  category: "sales_rep" | "subcontractor" | "vendor";
  currentLimit: number;
}

const LABELS: Record<Props["category"], string> = {
  sales_rep: "sales reps",
  subcontractor: "subcontractors",
  vendor: "vendors",
};

export function RequestStakeholderLimitDialog({ open, onOpenChange, category, currentLimit }: Props) {
  const { user } = useAuth();
  const { tenant } = useTenant();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [requested, setRequested] = useState(currentLimit + 5);
  const [reason, setReason] = useState("");

  const label = LABELS[category];

  const submit = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from("stakeholder_limit_requests").insert({
        tenant_id: tenant!.id,
        requested_by: user!.id,
        category,
        requested_limit: requested,
        reason: reason.trim() || null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast({ title: "Request submitted", description: "An admin will review your cap-increase request." });
      qc.invalidateQueries({ queryKey: ["stakeholder-limit-requests"] });
      setReason("");
      onOpenChange(false);
    },
    onError: (e: any) => toast({ title: "Couldn't submit", description: e.message, variant: "destructive" }),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Request more {label}</DialogTitle>
          <DialogDescription>
            You're currently capped at <strong>{currentLimit}</strong> {label}. Ask an admin to raise it.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label className="text-xs">New cap</Label>
            <Input
              type="number"
              min={currentLimit + 1}
              value={requested}
              onChange={(e) => setRequested(Number(e.target.value))}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Reason (optional)</Label>
            <Textarea
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why do you need more?"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submit.isPending}>Cancel</Button>
          <Button onClick={() => submit.mutate()} disabled={submit.isPending || requested <= currentLimit}>
            {submit.isPending && <Loader2 className="h-3 w-3 mr-1 animate-spin" />} Submit request
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

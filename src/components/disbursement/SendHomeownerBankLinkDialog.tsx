import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/aws/client";
import { useTenant } from "@/contexts/TenantContext";
import { useToast } from "@/hooks/use-toast";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Loader2, Home } from "lucide-react";
import { queriesInvalidatedAfterBankLinkSend } from "@/lib/homeownerBankLink";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  checkIntakeItemId: string;
  claimId: string | null;
}

export function SendHomeownerBankLinkDialog({ open, onOpenChange, checkIntakeItemId, claimId }: Props) {
  const { tenant } = useTenant();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [scope, setScope] = useState<"check" | "claim">("check");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");

  const send = useMutation({
    mutationFn: async () => {
      if (!name.trim() || !email.trim()) throw new Error("Name and email are required");
      const body: any = {
        tenant_id: tenant!.id,
        scope,
        homeowner_name: name.trim(),
        homeowner_email: email.trim().toLowerCase(),
      };
      if (scope === "check") body.check_intake_item_id = checkIntakeItemId;
      else body.claim_id = claimId;

      const { data, error } = await supabase.functions.invoke("homeowner-bank-link-send", { body });
      if (error) {
        let msg = error.message ?? "Failed to send bank link";
        try { const b = await (error as any).context?.json?.(); if (b?.error) msg = b.error; } catch {}
        throw new Error(msg);
      }
      if ((data as any)?.error) throw new Error((data as any).error);
      return data;
    },
    onSuccess: (data: any) => {
      const url = data?.payout_url as string | undefined;
      if (url) {
        navigator.clipboard?.writeText(url).catch(() => {});
      }
      toast({
        title: "Payout setup link sent",
        description: `${name} will receive an email to complete their payout profile and bank details. ${url ? "The link was also copied to your clipboard." : ""}`,
      });
      for (const queryKey of queriesInvalidatedAfterBankLinkSend(checkIntakeItemId)) {
        void qc.invalidateQueries({ queryKey: [...queryKey] });
      }
      setName(""); setEmail("");
      onOpenChange(false);
    },
    onError: (e: any) => toast({ title: "Couldn't send link", description: e.message, variant: "destructive" }),
  });

  const claimScopeDisabled = !claimId;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Home className="h-4 w-4" /> Send homeowner payout setup
          </DialogTitle>
          <DialogDescription>
            The homeowner receives a secure link to complete their payout profile and bank details so claim
            funds can be sent directly to their bank account. Once complete, they're auto-added as a
            disbursable stakeholder.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label className="text-xs">Attach to</Label>
            <RadioGroup value={scope} onValueChange={(v) => setScope(v as "check" | "claim")} className="space-y-1">
              <div className="flex items-center gap-2 text-sm">
                <RadioGroupItem value="check" id="scope-check" />
                <Label htmlFor="scope-check" className="cursor-pointer">Just this check</Label>
              </div>
              <div className="flex items-center gap-2 text-sm">
                <RadioGroupItem value="claim" id="scope-claim" disabled={claimScopeDisabled} />
                <Label htmlFor="scope-claim" className={`cursor-pointer ${claimScopeDisabled ? "text-muted-foreground" : ""}`}>
                  Every check on this claim {claimScopeDisabled && "(claim not linked yet)"}
                </Label>
              </div>
            </RadioGroup>
          </div>

          <div className="space-y-1">
            <Label className="text-xs">Homeowner name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Jane Homeowner" />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Homeowner email</Label>
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="jane@example.com" />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={send.isPending}>Cancel</Button>
          <Button onClick={() => send.mutate()} disabled={send.isPending || !name || !email}>
            {send.isPending && <Loader2 className="h-3 w-3 mr-1 animate-spin" />} Send link
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

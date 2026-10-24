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
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Loader2, Home } from "lucide-react";
import { queriesInvalidatedAfterBankLinkSend } from "@/lib/homeownerBankLink";
import { unwrapPayeeInvoke } from "@/lib/payeeSetup";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  checkIntakeItemId: string;
  claimId: string | null;
}

export function SendHomeownerBankLinkDialog({ open, onOpenChange, checkIntakeItemId, claimId }: Props) {
  const { tenant } = useTenant();
  const { user } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [scope, setScope] = useState<"check" | "claim">("check");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());

  const send = useMutation({
    mutationFn: async () => {
      if (!name.trim() || !email.trim()) throw new Error("Name and email are required");
      const body: Record<string, unknown> = {
        tenant_id: tenant!.id,
        scope,
        homeowner_name: name.trim(),
        homeowner_email: email.trim().toLowerCase(),
        // A retried click maps to the same payee on the server.
        request_id: requestId,
      };
      if (scope === "check") body.check_intake_item_id = checkIntakeItemId;
      if (claimId) body.claim_id = claimId;

      // The server creates the payee and its stakeholder account and emails the
      // setup link; the link itself never comes back to the browser.
      const created = await unwrapPayeeInvoke<{ stakeholder_account_id?: string | null; email_sent?: boolean }>(
        await supabase.functions.invoke("homeowner-bank-link-send", { body }),
        "Failed to send the setup link",
      );

      // Attach the homeowner to the check(s) right away ("Awaiting verification").
      const stakeholderId = created.stakeholder_account_id ?? null;
      if (stakeholderId) {
        let checkIds: string[] = [checkIntakeItemId];
        if (scope === "claim" && claimId) {
          const { data: claimChecks } = await supabase.from("check_intake_items").select("id").eq("claim_id", claimId);
          checkIds = Array.from(new Set([checkIntakeItemId, ...((claimChecks ?? []) as { id: string }[]).map((c) => c.id)]));
        }
        const { error: linkErr } = await supabase.from("check_stakeholders").insert(
          checkIds.map((id) => ({
            check_intake_item_id: id,
            stakeholder_account_id: stakeholderId,
            tenant_id: tenant!.id,
            added_via: "homeowner_link",
            added_by: user?.id ?? null,
          })),
        );
        if (linkErr && !linkErr.message.includes("duplicate")) throw new Error(linkErr.message);
      }
      return { emailSent: created.email_sent === true, email: email.trim().toLowerCase() };
    },
    onSuccess: ({ emailSent, email: sentTo }) => {
      toast(emailSent
        ? { title: "Setup link emailed", description: `${name} will receive an email at ${sentTo} to verify their identity and bank account.` }
        : { title: "Homeowner added; email not sent", description: "The setup email could not be sent. Use Resend link in Settings → Stakeholders.", variant: "destructive" });
      for (const queryKey of queriesInvalidatedAfterBankLinkSend(checkIntakeItemId)) {
        void qc.invalidateQueries({ queryKey: [...queryKey] });
      }
      void qc.invalidateQueries({ queryKey: ["stakeholder-accounts"] });
      void qc.invalidateQueries({ queryKey: ["payee-recipients"] });
      setName(""); setEmail(""); setRequestId(crypto.randomUUID());
      onOpenChange(false);
    },
    onError: (e: Error) => toast({ title: "Couldn't send link", description: e.message, variant: "destructive" }),
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
            The homeowner is emailed a secure link to verify their identity and add their bank account so
            claim funds can be sent directly to them. They are added to the check now as awaiting
            verification and can be paid once setup is verified.
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
            {send.isPending && <Loader2 className="h-3 w-3 mr-1 animate-spin" />} Email setup link
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

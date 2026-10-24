import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useTenant } from "@/contexts/TenantContext";
import { useToast } from "@/hooks/use-toast";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2, UserPlus, CheckCircle2, MailWarning } from "lucide-react";
import { unwrapPayeeInvoke, type PayeeRecipientType } from "@/lib/payeeSetup";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  checkIntakeItemId: string;
  claimId?: string | null;
}

interface CreatedPayee {
  recipient_id: string;
  stakeholder_account_id: string | null;
  email_sent?: boolean;
  replayed?: boolean;
}

/**
 * Adds a payee who is NOT a ChecksOps organization (an individual sub, a
 * vendor, a one-time payee) to this check. The server (moov-recipient-create)
 * creates the payee and its stakeholder account, then emails the payee a
 * secure setup link; the link itself never comes back to the browser. This
 * dialog only attaches the new stakeholder account to the check.
 */
export function AddExternalStakeholderDialog({ open, onOpenChange, checkIntakeItemId, claimId }: Props) {
  const { tenant } = useTenant();
  const { user } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [recipientType, setRecipientType] = useState<PayeeRecipientType>("individual");
  const [relationship, setRelationship] = useState<string>("subcontractor");
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [result, setResult] = useState<{ email: string; emailSent: boolean } | null>(null);

  const reset = () => {
    setName(""); setEmail(""); setRecipientType("individual");
    setRelationship("subcontractor"); setResult(null); setRequestId(crypto.randomUUID());
  };

  const create = useMutation({
    mutationFn: async () => {
      if (!name.trim()) throw new Error("Name is required");
      if (!email.trim()) throw new Error("Email is required to send the setup link");

      const created = await unwrapPayeeInvoke<CreatedPayee>(await supabase.functions.invoke("moov-recipient-create", {
        body: {
          tenant_id: tenant!.id,
          name: name.trim(),
          email: email.trim().toLowerCase(),
          recipient_type: recipientType,
          relationship,
          claim_id: claimId ?? null,
          check_id: checkIntakeItemId,
          // A retried click maps to the same payee on the server.
          request_id: requestId,
        },
      }), "Couldn't add the payee");

      if (created.stakeholder_account_id) {
        const { error: linkErr } = await supabase.from("check_stakeholders").insert({
          check_intake_item_id: checkIntakeItemId,
          stakeholder_account_id: created.stakeholder_account_id,
          tenant_id: tenant!.id,
          added_via: "manual",
          added_by: user?.id ?? null,
        });
        if (linkErr && !linkErr.message.includes("duplicate")) throw new Error(linkErr.message);
      }
      return { email: email.trim().toLowerCase(), emailSent: created.email_sent === true };
    },
    onSuccess: (out) => {
      setResult(out);
      qc.invalidateQueries({ queryKey: ["check-stakeholders", checkIntakeItemId] });
      qc.invalidateQueries({ queryKey: ["disbursement-accounts", checkIntakeItemId] });
      qc.invalidateQueries({ queryKey: ["stakeholder-accounts"] });
      qc.invalidateQueries({ queryKey: ["payee-recipients"] });
      toast({
        title: "Payee added",
        description: out.emailSent
          ? `A setup link was emailed to ${out.email}.`
          : "The setup email could not be sent. Use Resend link in Settings → Stakeholders.",
      });
    },
    onError: (e: Error) => toast({ title: "Couldn't add payee", description: e.message, variant: "destructive" }),
  });

  return (
    <Dialog open={open} onOpenChange={(o) => { onOpenChange(o); if (!o) reset(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserPlus className="h-4 w-4" /> Add a new payee
          </DialogTitle>
          <DialogDescription>
            For a payee who isn't a ChecksOps organization. They get an emailed link to verify their identity
            and bank account before any money moves.
          </DialogDescription>
        </DialogHeader>

        {result ? (
          <div className={`rounded-md border p-3 text-sm flex items-start gap-2 ${result.emailSent ? "border-emerald-500/30 bg-emerald-500/10" : "border-amber-500/30 bg-amber-500/10"}`}>
            {result.emailSent
              ? <CheckCircle2 className="h-4 w-4 text-emerald-600 mt-0.5 shrink-0" />
              : <MailWarning className="h-4 w-4 text-amber-600 mt-0.5 shrink-0" />}
            <p className="text-xs">
              Added to this check as <span className="font-medium">Awaiting verification</span>.{" "}
              {result.emailSent
                ? <>Setup link emailed to <span className="font-medium">{result.email}</span>. They can be paid once they finish setup.</>
                : <>The setup email could not be sent. Use <span className="font-medium">Resend link</span> in Settings → Stakeholders.</>}
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="space-y-1">
              <Label className="text-xs">Payee is</Label>
              <Select value={recipientType} onValueChange={(v) => setRecipientType(v as PayeeRecipientType)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="individual">An individual (person)</SelectItem>
                  <SelectItem value="business">A business</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">{recipientType === "business" ? "Business name" : "Full name"}</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={recipientType === "business" ? "ABC Roofing LLC" : "Jane Smith"} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Role on check</Label>
              <Select value={relationship} onValueChange={setRelationship}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="subcontractor">Subcontractor</SelectItem>
                  <SelectItem value="vendor">Vendor</SelectItem>
                  <SelectItem value="contractor">Contractor</SelectItem>
                  <SelectItem value="supplier">Supplier</SelectItem>
                  <SelectItem value="other">Other</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Email (receives the setup link)</Label>
              <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com" />
            </div>
          </div>
        )}

        <DialogFooter>
          {result ? (
            <Button onClick={() => { onOpenChange(false); reset(); }}>Done</Button>
          ) : (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={create.isPending}>Cancel</Button>
              <Button onClick={() => create.mutate()} disabled={create.isPending || !name.trim() || !email.trim()}>
                {create.isPending && <Loader2 className="h-3 w-3 mr-1 animate-spin" />} Add & email link
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

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
import { Copy, Loader2, UserPlus, CheckCircle2 } from "lucide-react";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  checkIntakeItemId: string;
  claimId?: string | null;
}

/**
 * Adds a payee who is NOT a ChecksOps organization (individual sub, vendor,
 * one-time payee). We create the recipient with the payment provider first,
 * attach a matching stakeholder record to this check, then email them a secure
 * link where the provider's hosted form collects their bank details.
 */
export function AddExternalStakeholderDialog({ open, onOpenChange, checkIntakeItemId, claimId }: Props) {
  const { tenant } = useTenant();
  const { user } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [recipientType, setRecipientType] = useState<"individual" | "business">("individual");
  const [accountType, setAccountType] = useState<string>("subcontractor");
  const [link, setLink] = useState<string | null>(null);

  const reset = () => {
    setName(""); setEmail(""); setPhone(""); setRecipientType("individual");
    setAccountType("subcontractor"); setLink(null);
  };

  const create = useMutation({
    mutationFn: async () => {
      if (!name.trim()) throw new Error("Name is required");

      const { data, error } = await supabase.functions.invoke("moov-recipient-create", {
        body: {
          tenant_id: tenant!.id,
          name: name.trim(),
          email: email.trim() || null,
          phone: phone.trim() || null,
          recipient_type: recipientType,
          relationship: accountType === "insured" ? "homeowner" : "one_time",
          claim_id: claimId ?? null,
          check_id: checkIntakeItemId,
        },
      });
      if (error) {
        let msg = error.message ?? "Couldn't create recipient";
        try { const b = await (error as any).context?.json?.(); if (b?.error) msg = b.error; } catch { /* keep */ }
        throw new Error(msg);
      }
      if ((data as any)?.error) throw new Error((data as any).error);

      if ((data as any)?.is_existing_member) {
        throw new Error(
          `${name.trim()} is already a ChecksOps organization. Add them from the Partners list instead.`,
        );
      }

      const recipient = (data as any).recipient;
      const secureLink: string | null = (data as any).secure_link ?? null;

      // Mirror the provider recipient as a stakeholder account so the existing
      // disbursement flow can pay them once their bank is on file.
      const { data: existing } = await supabase
        .from("stakeholder_accounts")
        .select("id")
        .eq("tenant_id", tenant!.id)
        .eq("provider_account_id", recipient.provider_account_id)
        .maybeSingle();

      let accountId = existing?.id as string | undefined;

      if (!accountId) {
        const { data: inserted, error: insErr } = await supabase
          .from("stakeholder_accounts")
          .insert({
            tenant_id: tenant!.id,
            created_by: user?.id ?? null,
            nickname: name.trim(),
            custname: name.trim(),
            account_type: accountType,
            chk_aba: "000000000",
            chk_acct: "PENDING",
            acct_type: "C",
            is_primary: false,
            is_active: true,
            origin: "provider_recipient",
            verification_status: "pending",
            verification_source: "moov",
            provider: "moov",
            provider_environment: recipient.environment ?? null,
            provider_account_id: recipient.provider_account_id,
            verification_recipient_email: email.trim() || null,
          } as any)
          .select("id")
          .single();
        if (insErr) throw new Error(insErr.message);
        accountId = inserted.id;
      }

      const { error: linkErr } = await supabase.from("check_stakeholders").insert({
        check_intake_item_id: checkIntakeItemId,
        stakeholder_account_id: accountId!,
        tenant_id: tenant!.id,
        added_via: "manual",
        added_by: user?.id ?? null,
      });
      if (linkErr && !linkErr.message.includes("duplicate")) throw new Error(linkErr.message);

      if (email.trim() && secureLink) {
        await supabase.functions.invoke("send-transactional-email", {
          body: {
            templateName: "stakeholder-verify-account",
            recipientEmail: email.trim().toLowerCase(),
            tenantId: tenant!.id,
            idempotencyKey: `recipient-setup-${accountId}`,
            templateData: { nickname: name.trim(), custname: name.trim(), verifyUrl: secureLink },
          },
        });
      }

      return secureLink;
    },
    onSuccess: (secureLink) => {
      setLink(secureLink ?? null);
      qc.invalidateQueries({ queryKey: ["check-stakeholders", checkIntakeItemId] });
      qc.invalidateQueries({ queryKey: ["disbursement-accounts", checkIntakeItemId] });
      toast({
        title: "Recipient added",
        description: email
          ? "They've been emailed a secure link to add their bank details."
          : "Share the secure link so they can add their bank details.",
      });
    },
    onError: (e: any) => toast({ title: "Couldn't add recipient", description: e.message, variant: "destructive" }),
  });

  return (
    <Dialog open={open} onOpenChange={(o) => { onOpenChange(o); if (!o) reset(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserPlus className="h-4 w-4" /> Add a new recipient
          </DialogTitle>
          <DialogDescription>
            For a payee who isn't a ChecksOps organization. They'll get a secure link to verify their
            bank account before any money moves.
          </DialogDescription>
        </DialogHeader>

        {link ? (
          <div className="space-y-3">
            <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm flex items-start gap-2">
              <CheckCircle2 className="h-4 w-4 text-emerald-600 mt-0.5 shrink-0" />
              <p className="text-xs">
                Added to this check as <span className="font-medium">Awaiting verification</span>. They can be
                paid once they finish bank verification.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Input readOnly value={link} className="text-xs" />
              <Button
                size="icon"
                variant="outline"
                onClick={() => { navigator.clipboard.writeText(link); toast({ title: "Link copied" }); }}
              >
                <Copy className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="space-y-1">
              <Label className="text-xs">Name</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="ABC Roofing or Jane Smith" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs">Recipient is</Label>
                <Select value={recipientType} onValueChange={(v) => setRecipientType(v as any)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="individual">A person</SelectItem>
                    <SelectItem value="business">A business</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Role on check</Label>
                <Select value={accountType} onValueChange={setAccountType}>
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
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Email (sends the verification link)</Label>
              <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Phone (optional)</Label>
              <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="(555) 555-5555" />
            </div>
          </div>
        )}

        <DialogFooter>
          {link ? (
            <Button onClick={() => { onOpenChange(false); reset(); }}>Done</Button>
          ) : (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={create.isPending}>Cancel</Button>
              <Button onClick={() => create.mutate()} disabled={create.isPending || !name.trim()}>
                {create.isPending && <Loader2 className="h-3 w-3 mr-1 animate-spin" />} Add & send link
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

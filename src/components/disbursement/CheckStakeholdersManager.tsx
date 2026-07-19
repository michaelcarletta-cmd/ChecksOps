import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useTenant } from "@/contexts/TenantContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Plus, X, Users, Handshake, ShieldCheck, MailCheck, Lock, Home } from "lucide-react";
import { VERIFICATION_BADGE_CLASS, VERIFICATION_LABEL, type VerificationStatus } from "@/lib/banking";
import { SendHomeownerBankLinkDialog } from "./SendHomeownerBankLinkDialog";
import { SendCheckTrackingLinkButton } from "@/components/homeowner-ledger/SendCheckTrackingLinkButton";

interface Props {
  checkIntakeItemId: string;
}

const TYPE_LABELS: Record<string, string> = {
  operating: "Operating", vendor: "Vendor", subcontractor: "Subcontractor",
  overhead: "Overhead", insured: "Insured", contractor: "Contractor",
  supplier: "Supplier", other: "Other",
};

export function CheckStakeholdersManager({ checkIntakeItemId }: Props) {
  const { user } = useAuth();
  const { tenant } = useTenant();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [homeownerDialogOpen, setHomeownerDialogOpen] = useState(false);

  const { data: checkMeta } = useQuery({
    queryKey: ["check-meta-for-stakeholders", checkIntakeItemId],
    enabled: !!checkIntakeItemId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("check_intake_items")
        .select("id, claim_id")
        .eq("id", checkIntakeItemId)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  const { data: checkStakeholders = [] } = useQuery({
    queryKey: ["check-stakeholders", checkIntakeItemId],
    enabled: !!checkIntakeItemId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("check_stakeholders")
        .select(`
          id, added_via, partner_tenant_id, stakeholder_account_id,
          stakeholder_accounts:stakeholder_account_id (id, nickname, account_type, chk_acct, is_active, verification_status),
          partner:partner_tenant_id (id, name)
        `)
        .eq("check_intake_item_id", checkIntakeItemId);
      if (error) throw error;
      return data ?? [];
    },
  });

  const { data: allAccounts = [] } = useQuery({
    queryKey: ["stakeholder-accounts-all", tenant?.id],
    enabled: !!tenant?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("stakeholder_accounts")
        .select("id, nickname, account_type, chk_acct")
        .eq("tenant_id", tenant!.id)
        .eq("is_active", true)
        .order("nickname");
      if (error) throw error;
      return data ?? [];
    },
  });

  const activeCheckStakeholders = checkStakeholders.filter((s: any) => s.stakeholder_accounts?.is_active !== false);
  const selectedIds = new Set(activeCheckStakeholders.map((s: any) => s.stakeholder_account_id));
  const availableToAdd = allAccounts.filter((a: any) => !selectedIds.has(a.id));

  const addMut = useMutation({
    mutationFn: async (accountId: string) => {
      const { error } = await supabase.from("check_stakeholders").insert({
        check_intake_item_id: checkIntakeItemId,
        stakeholder_account_id: accountId,
        tenant_id: tenant!.id,
        added_via: "manual",
        added_by: user?.id ?? null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["check-stakeholders", checkIntakeItemId] });
      qc.invalidateQueries({ queryKey: ["disbursement-accounts", checkIntakeItemId] });
      setPickerOpen(false);
    },
    onError: (e: any) => toast({ title: "Couldn't add stakeholder", description: e.message, variant: "destructive" }),
  });

  const removeMut = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("check_stakeholders").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["check-stakeholders", checkIntakeItemId] });
      qc.invalidateQueries({ queryKey: ["disbursement-accounts", checkIntakeItemId] });
    },
    onError: (e: any) => toast({ title: "Couldn't remove", description: e.message, variant: "destructive" }),
  });

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-muted-foreground flex items-center gap-1">
          <Users className="h-3 w-3" /> Stakeholders on this check
        </p>
        <div className="flex items-center gap-1 flex-wrap justify-end">
          <SendCheckTrackingLinkButton
            claimId={(checkMeta?.claim_id as string | null) ?? null}
            tenantId={tenant?.id ?? null}
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            label="Tracking link"
          />
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            onClick={() => setHomeownerDialogOpen(true)}
            title="Send the homeowner a link to link their bank via AuthenteCheck"
          >
            <Home className="h-3 w-3 mr-1" /> Bank link
          </Button>
          <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
            <PopoverTrigger asChild>
              <Button size="sm" variant="outline" className="h-7 text-xs" disabled={availableToAdd.length === 0}>
                <Plus className="h-3 w-3 mr-1" /> Add
              </Button>
            </PopoverTrigger>
          <PopoverContent className="w-72 p-2" align="end">
            {availableToAdd.length === 0 ? (
              <p className="text-xs text-muted-foreground p-2">All your accounts are already added.</p>
            ) : (
              <div className="space-y-1 max-h-64 overflow-y-auto">
                {availableToAdd.map((a: any) => (
                  <button
                    key={a.id}
                    className="w-full text-left p-2 rounded hover:bg-accent text-xs flex items-center justify-between"
                    onClick={() => addMut.mutate(a.id)}
                    disabled={addMut.isPending}
                  >
                    <span>
                      <span className="font-medium">{a.nickname}</span>
                      <span className="text-muted-foreground ml-1 font-mono">••••{a.chk_acct.slice(-4)}</span>
                    </span>
                    <Badge variant="outline" className="text-[9px]">{TYPE_LABELS[a.account_type] ?? a.account_type}</Badge>
                  </button>
                ))}
              </div>
            )}
          </PopoverContent>
        </Popover>
        </div>
      </div>

      <SendHomeownerBankLinkDialog
        open={homeownerDialogOpen}
        onOpenChange={setHomeownerDialogOpen}
        checkIntakeItemId={checkIntakeItemId}
        claimId={(checkMeta?.claim_id as string | null) ?? null}
      />

      {activeCheckStakeholders.length === 0 ? (
        <div className="rounded-md border border-dashed p-3 text-xs text-muted-foreground text-center">
          No stakeholders yet. Add one to start disbursing.
        </div>
      ) : (
        <div className="space-y-1">
          {activeCheckStakeholders.map((s: any) => {
            const acct = s.stakeholder_accounts;
            if (!acct) return null;
            const vStatus = (acct.verification_status ?? "unverified") as VerificationStatus;
            return (
              <div key={s.id} className="flex items-center justify-between gap-2 rounded-md border p-2 text-xs">
                <div className="flex items-center gap-2 min-w-0 flex-wrap">
                  <span className="font-medium truncate">{acct.nickname}</span>
                  <span className="text-muted-foreground font-mono">••••{acct.chk_acct.slice(-4)}</span>
                  <Badge variant="outline" className={`text-[9px] px-1.5 ${VERIFICATION_BADGE_CLASS[vStatus]}`} title={VERIFICATION_LABEL[vStatus]}>
                    {vStatus === "verified" ? <><ShieldCheck className="h-2.5 w-2.5 mr-0.5 inline" /> Verified</> :
                     vStatus === "pending" ? <><MailCheck className="h-2.5 w-2.5 mr-0.5 inline" /> Awaiting</> :
                     vStatus === "locked" ? <><Lock className="h-2.5 w-2.5 mr-0.5 inline" /> Locked</> :
                     vStatus === "admin_override" ? "Override" :
                     "Unverified"}
                  </Badge>
                  {s.added_via === "partner_share" && (
                    <Badge variant="outline" className="text-[9px] border-purple-500/30 text-purple-600 bg-purple-500/10"
                      title={s.partner?.name ? `Partner: ${s.partner.name}` : "Partner share"}>
                      <Handshake className="h-2.5 w-2.5 mr-0.5" /> Partner
                    </Badge>
                  )}
                </div>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-6 w-6"
                  onClick={() => removeMut.mutate(s.id)}
                  disabled={removeMut.isPending}
                >
                  <X className="h-3 w-3" />
                </Button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

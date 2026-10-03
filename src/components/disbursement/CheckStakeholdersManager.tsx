import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useTenant } from "@/contexts/TenantContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Plus, X, Users, Handshake, ShieldCheck, MailCheck, Lock, Home, Link2, Loader2, Search, UserPlus } from "lucide-react";
import { VERIFICATION_BADGE_CLASS, VERIFICATION_LABEL, type VerificationStatus } from "@/lib/banking";
import { PAYMENT_FLAGS } from "@/lib/payments/featureFlags";
import { SendHomeownerBankLinkDialog } from "./SendHomeownerBankLinkDialog";
import { AddExternalStakeholderDialog } from "./AddExternalStakeholderDialog";
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
  const [externalDialogOpen, setExternalDialogOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");


  const { data: checkMeta } = useQuery({
    queryKey: ["check-meta-for-stakeholders", checkIntakeItemId],
    enabled: !!checkIntakeItemId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("check_intake_items")
        .select(`
          id, 
          claim_id,
          claims:claim_id (
            id,
            policyholder_name
          )
        `)
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
          stakeholder_accounts:stakeholder_account_id (id, nickname, account_type, chk_acct, is_active, verification_status, verification_source, plaid_account_id, custname, homeowner_name, authentecheck_bank_name, provider, provider_account_id, provider_bank_name, provider_last_four),
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
        .select("id, nickname, account_type, chk_acct, custname, homeowner_name, authentecheck_bank_name")
        .eq("tenant_id", tenant!.id)
        .eq("is_active", true)
        .order("nickname");
      if (error) throw error;
      return data ?? [];
    },
  });

  // Partner organizations of this tenant, with whether their bank account is
  // approved and ready to receive money.
  const { data: partnerOptions = [] } = useQuery({
    queryKey: ["partner-payout-options", checkIntakeItemId],
    enabled: !!checkIntakeItemId && !!tenant?.id,
    queryFn: async () => {
      const { data, error } = await (supabase as any).rpc("list_partner_payout_options", {
        _check_intake_item_id: checkIntakeItemId,
      });
      if (error) throw error;
      return (data ?? []) as any[];
    },
  });


  const activeCheckStakeholders = checkStakeholders.filter((s: any) => s.stakeholder_accounts?.is_active !== false);
  const selectedIds = new Set(activeCheckStakeholders.map((s: any) => s.stakeholder_account_id));
  
  const currentClaimHomeowner = (checkMeta?.claims as any)?.policyholder_name;

  const availableToAdd = useMemo(() => {
    const query = searchQuery.toLowerCase().trim();
    
    return allAccounts.filter((a: any) => {
      if (selectedIds.has(a.id)) return false;

      const holderName = (a.custname || a.homeowner_name || a.nickname || "").toLowerCase();
      const matchesSearch = !query || holderName.includes(query);
      
      // If it's a homeowner account, it MUST match the current claim's homeowner
      if (a.homeowner_name) {
        const isCurrentOwner = currentClaimHomeowner && 
          a.homeowner_name.toLowerCase().trim() === currentClaimHomeowner.toLowerCase().trim();
        return matchesSearch && isCurrentOwner;
      }
      
      // Otherwise it's a regular stakeholder (vendor, contractor, etc.) from settings
      return matchesSearch;
    });
  }, [allAccounts, selectedIds, searchQuery, currentClaimHomeowner]);

  const visiblePartners = useMemo(() => {
    const query = searchQuery.toLowerCase().trim();
    return (partnerOptions as any[]).filter(
      (p) => !p.already_added && (!query || String(p.partner_name ?? "").toLowerCase().includes(query)),
    );
  }, [partnerOptions, searchQuery]);

  const addPartnerMut = useMutation({
    mutationFn: async (partnerTenantId: string) => {
      const { error } = await (supabase as any).rpc("add_partner_stakeholder_to_check", {
        _check_intake_item_id: checkIntakeItemId,
        _partner_tenant_id: partnerTenantId,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["check-stakeholders", checkIntakeItemId] });
      qc.invalidateQueries({ queryKey: ["partner-payout-options", checkIntakeItemId] });
      qc.invalidateQueries({ queryKey: ["disbursement-accounts", checkIntakeItemId] });
      setPickerOpen(false);
      toast({ title: "Partner added", description: "Their approved payment account is attached to this check." });
    },
    onError: (e: any) => toast({ title: "Couldn't add partner", description: e.message, variant: "destructive" }),
  });


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

  const bridgeMut = useMutation({
    mutationFn: async (stakeholderAccountId: string) => {
      const { data, error } = await supabase.functions.invoke("moov-plaid-bridge", {
        body: { tenant_id: tenant!.id, stakeholder_account_id: stakeholderAccountId, mode: "recipient" },
      });
      if (error) {
        let message = error.message ?? "Bridge failed";
        try {
          const parsed = await (error as any).context?.json?.();
          if (parsed?.error) message = parsed.error;
        } catch { /* keep original */ }
        throw new Error(message);
      }
      if ((data as any)?.error) throw new Error((data as any).error);
      return data as any;
    },
    onSuccess: (data: any) => {
      toast({
        title: "Payout account ready",
        description:
          data?.status === "verified"
            ? "Their linked bank is now set up to receive payments."
            : "Their linked bank was attached and is being verified.",
      });
      qc.invalidateQueries({ queryKey: ["check-stakeholders", checkIntakeItemId] });
      qc.invalidateQueries({ queryKey: ["disbursement-accounts", checkIntakeItemId] });
    },
    onError: (e: any) =>
      toast({ title: "Couldn't set up payouts", description: e.message, variant: "destructive" }),
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

  const moovAllowed = PAYMENT_FLAGS.USE_MOOV;


  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-muted-foreground flex items-center gap-1">
          <Users className="h-3 w-3" /> Stakeholders on this check
        </p>
        <div className="flex items-center gap-1 flex-wrap justify-end">
          <SendCheckTrackingLinkButton
            claimId={(checkMeta?.claim_id as string | null) ?? null}
            checkIntakeItemId={checkIntakeItemId}
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
            title="Send the homeowner a secure link to link their bank account"
          >
            <Home className="h-3 w-3 mr-1" /> Bank link
          </Button>
          <Popover open={pickerOpen} onOpenChange={(open) => {
            setPickerOpen(open);
            if (!open) setSearchQuery("");
          }}>
            <PopoverTrigger asChild>
              <Button size="sm" variant="outline" className="h-7 text-xs">
                <Plus className="h-3 w-3 mr-1" /> Add
              </Button>
            </PopoverTrigger>
          <PopoverContent className="w-72 p-2" align="end">
            <div className="space-y-2">
              <div className="relative">
                <Search className="absolute left-2 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  placeholder="Search stakeholders..."
                  className="h-8 pl-8 text-xs"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  autoFocus
                />
              </div>

              {visiblePartners.length > 0 && (
                <div className="space-y-1">
                  <p className="text-[10px] uppercase tracking-wide text-muted-foreground px-1">Partner organizations</p>
                  <div className="space-y-1 max-h-40 overflow-y-auto pr-1">
                    {visiblePartners.map((p: any) => (
                      <button
                        key={p.partner_tenant_id}
                        className="w-full text-left p-2 rounded hover:bg-accent text-xs flex items-center justify-between group transition-colors disabled:opacity-50"
                        onClick={() => addPartnerMut.mutate(p.partner_tenant_id)}
                        disabled={addPartnerMut.isPending || !p.payout_ready}
                        title={p.payout_ready ? "Add this partner as a stakeholder" : "This partner hasn't finished bank verification"}
                      >
                        <span className="min-w-0">
                          <span className="font-medium block truncate group-hover:text-accent-foreground">{p.partner_name}</span>
                          <span className="text-muted-foreground text-[10px]">
                            {p.payout_ready
                              ? `Bank approved${p.last_four ? ` · ${p.bank_name ?? "Bank"} ••${p.last_four}` : ""}`
                              : "Bank not verified yet"}
                          </span>
                        </span>
                        <Badge
                          variant="outline"
                          className={`text-[9px] ml-2 shrink-0 ${p.payout_ready ? "border-purple-500/30 text-purple-600 bg-purple-500/10" : ""}`}
                        >
                          <Handshake className="h-2.5 w-2.5 mr-0.5" /> Partner
                        </Badge>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {availableToAdd.length > 0 && (
                <div className="space-y-1">
                  {visiblePartners.length > 0 && (
                    <p className="text-[10px] uppercase tracking-wide text-muted-foreground px-1">Saved stakeholders</p>
                  )}
                  <div className="space-y-1 max-h-64 overflow-y-auto pr-1">
                    {availableToAdd.map((a: any) => {
                      const holder = a.custname || a.homeowner_name || a.nickname;
                      return (
                        <button
                          key={a.id}
                          className="w-full text-left p-2 rounded hover:bg-accent text-xs flex items-center justify-between group transition-colors"
                          onClick={() => addMut.mutate(a.id)}
                          disabled={addMut.isPending}
                        >
                          <span className="min-w-0">
                            <span className="font-medium block truncate group-hover:text-accent-foreground">{holder}</span>
                            <span className="text-muted-foreground text-[10px]">
                              Payment account connected
                            </span>
                          </span>
                          <Badge variant="outline" className="text-[9px] ml-2 shrink-0">{TYPE_LABELS[a.account_type] ?? a.account_type}</Badge>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {availableToAdd.length === 0 && visiblePartners.length === 0 && (
                <p className="text-xs text-muted-foreground p-2 text-center">
                  {searchQuery ? "No matches found." : "Everyone available is already added."}
                </p>
              )}

              <Button
                size="sm"
                variant="secondary"
                className="w-full h-8 text-xs"
                onClick={() => { setPickerOpen(false); setExternalDialogOpen(true); }}
              >
                <UserPlus className="h-3 w-3 mr-1" /> Add someone new
              </Button>
            </div>
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

      <AddExternalStakeholderDialog
        open={externalDialogOpen}
        onOpenChange={setExternalDialogOpen}
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
            const canBridge =
              moovAllowed &&
              acct.verification_source === "plaid" &&
              !!acct.plaid_account_id &&
              !acct.provider_account_id;
            const bridging = bridgeMut.isPending && bridgeMut.variables === acct.id;
            return (
              <div key={s.id} className="flex items-center justify-between gap-2 rounded-md border p-2 text-xs">
                <div className="flex items-center gap-2 min-w-0 flex-wrap">
                  <span className="font-medium truncate">
                    {acct.custname || acct.nickname || acct.homeowner_name}
                  </span>
                  <span className="text-muted-foreground text-[10px]">
                    Payment account connected
                  </span>
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
                <div className="flex items-center gap-1 shrink-0">
                  {canBridge && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-6 text-[10px] px-2"
                      onClick={() => bridgeMut.mutate(acct.id)}
                      disabled={bridgeMut.isPending}
                      title="Reuse the bank they already linked so they can be paid on this rail"
                    >
                      {bridging
                        ? <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                        : <Link2 className="h-3 w-3 mr-1" />}
                      Enable payouts
                    </Button>
                  )}
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

              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

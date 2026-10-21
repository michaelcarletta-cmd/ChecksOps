import { useState, useMemo, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useTenant } from "@/contexts/TenantContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Plus, X, Users, Handshake, ShieldCheck, MailCheck, Lock, Home, Search, UserPlus, Send } from "lucide-react";
import { VERIFICATION_BADGE_CLASS, VERIFICATION_LABEL, type VerificationStatus } from "@/lib/banking";
import { SendHomeownerBankLinkDialog } from "./SendHomeownerBankLinkDialog";
import { AddExternalStakeholderDialog } from "./AddExternalStakeholderDialog";
import { SendCheckTrackingLinkButton } from "@/components/homeowner-ledger/SendCheckTrackingLinkButton";
import { displayCaseOrNull } from "@/lib/displayCase";
import { useSelectedPartners } from "@/lib/payments/selectedPartners";
import { useCheckStakeholderList } from "@/hooks/useCheckStakeholderList";
import { formatUsdCents, releasedForRow, type CheckStakeholderRow } from "@/lib/payments/checkStakeholderList";


interface Props {
  checkIntakeItemId: string;
  /** Focus this recipient in the payment screen's amounts (no money moves here). */
  onPay?: (key: string) => void;
  /** Row keys (lower case) the payment screen can allocate to. */
  payableKeys?: Set<string>;
}

const TYPE_LABELS: Record<string, string> = {
  operating: "Operating", vendor: "Vendor", subcontractor: "Subcontractor",
  overhead: "Overhead", insured: "Insured", contractor: "Contractor",
  supplier: "Supplier", other: "Other",
};

export function CheckStakeholdersManager({ checkIntakeItemId, onPay, payableKeys }: Props) {
  const { user } = useAuth();
  const { tenant } = useTenant();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [homeownerDialogOpen, setHomeownerDialogOpen] = useState(false);
  const [externalDialogOpen, setExternalDialogOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [pendingRemoval, setPendingRemoval] = useState<CheckStakeholderRow | null>(null);


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

  // One list: saved stakeholders, partners the check is shared with, and
  // partners chosen in the picker, with what each was sent so far. A partner
  // the check is shared with stays listed until the check is unshared.
  const { rows, released } = useCheckStakeholderList(checkIntakeItemId, tenant?.id);
  const activeRows = rows.filter((r) => r.status === "active");
  const listedKeys = useMemo(() => new Set(rows.map((r) => r.key)), [rows]);

  const { data: allAccounts = [] } = useQuery({
    queryKey: ["stakeholder-accounts-all", tenant?.id],
    enabled: !!tenant?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("stakeholder_accounts")
        .select("id, nickname, account_type, chk_acct, custname, homeowner_name")
        .eq("tenant_id", tenant!.id)
        .eq("is_active", true)
        .order("nickname");
      if (error) throw error;
      return data ?? [];
    },
  });

  // Partner organizations of this tenant, with whether their bank account is
  // approved and ready to receive money.
  const { data: partnerOptions = [], isSuccess: partnerOptionsLoaded } = useQuery({
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


  const selectedIds = useMemo(
    () => new Set(rows.filter((r) => r.kind === "stakeholder").map((r) => r.stakeholderAccountId)),
    [rows],
  );
  
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

  // Choosing a partner adds them to this check's payment list without sharing the
  // check or writing anything; the payment server checks the partnership on send.
  const { partners: selectedPartners, add: selectPartner, remove: unselectPartner, keepOnly } = useSelectedPartners(checkIntakeItemId);

  // A chosen partner whose partnership has ended drops out of the payment list.
  useEffect(() => {
    if (!partnerOptionsLoaded || selectedPartners.length === 0) return;
    keepOnly(new Set((partnerOptions as any[]).map((p) => p.partner_tenant_id)));
  }, [partnerOptionsLoaded, partnerOptions, selectedPartners.length, keepOnly]);

  const visiblePartners = useMemo(() => {
    const query = searchQuery.toLowerCase().trim();
    const chosen = new Set(selectedPartners.map((p) => p.partner_tenant_id));
    return (partnerOptions as any[]).filter(
      (p) => !p.already_added
        && !chosen.has(p.partner_tenant_id)
        && !listedKeys.has(`partner:${String(p.partner_tenant_id).toLowerCase()}`)
        && (!query || String(p.partner_name ?? "").toLowerCase().includes(query)),
    );
  }, [partnerOptions, searchQuery, selectedPartners, listedKeys]);

  const choosePartner = (p: any) => {
    selectPartner({ partner_tenant_id: p.partner_tenant_id, partner_name: p.partner_name || "Partner organization" });
    setPickerOpen(false);
    toast({ title: "Partner added", description: `${p.partner_name || "This partner"} is in the payment list for this check.` });
  };


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

  const confirmRemoval = () => {
    const row = pendingRemoval;
    setPendingRemoval(null);
    if (!row) return;
    if (row.kind === "partner") {
      // Shared partners are never offered for removal; unsharing removes them.
      if (row.sharedLive) return;
      if (row.checkStakeholderId) removeMut.mutate(row.checkStakeholderId);
      else if (row.partnerTenantId) unselectPartner(row.partnerTenantId);
      return;
    }
    if (row.checkStakeholderId) removeMut.mutate(row.checkStakeholderId);
  };

  const removing = removeMut.isPending;


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
                  <p className="text-[10px] tracking-wide text-muted-foreground px-1">Partner organizations</p>
                  <div className="space-y-1 max-h-40 overflow-y-auto pr-1">
                    {visiblePartners.map((p: any) => (
                      <button
                        key={p.partner_tenant_id}
                        className="w-full text-left p-2 rounded hover:bg-accent text-xs flex items-center justify-between group transition-colors disabled:opacity-50"
                        onClick={() => choosePartner(p)}
                        title={p.payout_ready ? "Add this partner to the payment list" : "Add this partner to the payment list (they may still need to finish payment setup)"}
                      >
                        <span className="min-w-0">
                          <span className="font-medium block truncate group-hover:text-accent-foreground">{p.partner_name}</span>
                          <span className="text-muted-foreground text-[10px]">
                            {p.payout_ready
                              ? `Bank approved${p.last_four ? ` · ${displayCaseOrNull(p.bank_name) ?? "Bank"} ••${p.last_four}` : ""}`
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
                    <p className="text-[10px] tracking-wide text-muted-foreground px-1">Saved stakeholders</p>
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



      {activeRows.length === 0 ? (
        <div className="rounded-md border border-dashed p-3 text-xs text-muted-foreground text-center">
          No stakeholders yet. Add one to start disbursing.
        </div>
      ) : (
        <div className="space-y-1">
          {activeRows.map((row) => {
            const acct = row.account;
            const vStatus = (acct?.verification_status ?? "unverified") as VerificationStatus;
            const canPay = !!onPay && (!payableKeys || payableKeys.has(row.key.toLowerCase()));
            return (
              <div key={row.key} className="flex items-center justify-between gap-2 rounded-md border p-2 text-xs">
                <div className="flex items-center gap-2 min-w-0 flex-wrap">
                  <span className="font-medium truncate">{row.name}</span>
                  {row.kind === "partner" ? (
                    <Badge variant="outline" className="text-[9px] border-purple-500/30 text-purple-600 bg-purple-500/10"
                      title={row.sharedLive ? "Shared on this check; paid as a partner" : "Paid as a partner"}>
                      <Handshake className="h-2.5 w-2.5 mr-0.5" /> Partner
                    </Badge>
                  ) : acct ? (
                    <>
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
                    </>
                  ) : (
                    <span className="text-muted-foreground text-[10px]">Account details unavailable</span>
                  )}
                  <span className="text-muted-foreground text-[10px]" title="Sent to them on this check so far">
                    Released {formatUsdCents(releasedForRow(released, row))}
                  </span>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  {canPay && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-6 text-[10px] px-2"
                      onClick={() => onPay!(row.key)}
                      title="Enter an amount for them below, then send with the normal confirmation"
                    >
                      <Send className="h-3 w-3 mr-1" /> Pay
                    </Button>
                  )}
                  {row.kind === "partner" && row.sharedLive ? (
                    <span className="text-muted-foreground text-[10px]" title="Unshare the check to remove them">
                      Shared — unshare to remove
                    </span>
                  ) : (
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-6 w-6"
                      onClick={() => setPendingRemoval(row)}
                      disabled={removing}
                      title="Remove from this check's stakeholders"
                      aria-label={`Remove ${row.name}`}
                    >
                      <X className="h-3 w-3" />
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <AlertDialog open={!!pendingRemoval} onOpenChange={(open) => { if (!open) setPendingRemoval(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {pendingRemoval?.name ?? "this stakeholder"}?</AlertDialogTitle>
            <AlertDialogDescription>
              They are taken off this check's stakeholders and payment list. Payments already sent are not affected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmRemoval}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

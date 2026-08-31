import React, { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useTenant } from "@/contexts/TenantContext";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AlertTriangle, Banknote, Plus, Trash2, ShieldCheck, MailCheck, Lock, Loader2, ShieldAlert } from "lucide-react";
import { isValidRoutingNumber, VERIFICATION_LABEL, VERIFICATION_BADGE_CLASS, type VerificationStatus } from "@/lib/banking";
import { AchAuthorizationForm } from "@/components/disbursement/AchAuthorizationForm";
import { BankVerification } from "@/components/disbursement/BankVerification";
import { usePermissions } from "@/hooks/usePermissions";
import { usePaymentRail } from "@/hooks/usePaymentRail";
import { SettingsHero } from "./SettingsHero";
import { SectionCard } from "./SectionCard";


export function TenantBankAccountSettings() {
  const { user } = useAuth();
  const { tenant } = useTenant();
  const { toast } = useToast();
  const { isAdmin } = usePermissions();
  const { isPlaid } = usePaymentRail();
  const qc = useQueryClient();
  const [isStarting, setIsStarting] = useState(false);


  const { data: accounts = [], isLoading } = useQuery({
    queryKey: ["tenant-primary-accounts", tenant?.id],
    enabled: !!tenant?.id,
    queryFn: async () => {
      // Tenant's own operating account only. Stakeholder accounts
      // (subcontractors, vendors, sales reps) belong in the Stakeholder
      // Accounts section below, and homeowner-linked accounts belong to the
      // homeowner on a specific check/claim — never show either here.
      const { data, error } = await supabase
        .from("stakeholder_accounts")
        .select("id, nickname, chk_acct, acct_type, is_active, custname, verification_status, verified_at, is_primary, origin, account_type")
        .eq("tenant_id", tenant!.id)
        .eq("is_active", true)
        .eq("account_type", "operating")
        .neq("origin", "homeowner_link")
        .order("verified_at", { ascending: false, nullsFirst: false })
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });

  const addAccount = useMutation({
    mutationFn: async () => {
      let insertedId: string | null = null;
      // Create placeholder row; the bank-verification rail fills in all real fields:
      // routing, account, account type, holder name, and bank name.
      const { data: inserted, error } = await supabase
        .from("stakeholder_accounts")
        .insert({
          nickname: "Bank Account (pending verification)",
          custname: "Pending",
          acct_type: "C",
          chk_aba: "000000000",
          chk_acct: "0000000000",
          account_type: "operating",
          is_primary: true,
          tenant_id: tenant!.id,
          created_by: user!.id,
        } as any)
        .select("id")
        .single();
      if (error) throw error;
      insertedId = inserted!.id;

      try {
        // Moov rail: the row lands unverified and the
        // inline Moov Link widget on the account card finishes the job.
        // Legacy rails are disabled globally.
        return null;
      } catch (e: any) {
        if (insertedId) {
          await supabase
            .from("stakeholder_accounts")
            .update({ is_active: false, verification_status: "failed", verification_failure_reason: e.message })
            .eq("id", insertedId);
        }
        throw e;
      }
    },
    onMutate: () => setIsStarting(true),
    onSettled: () => setIsStarting(false),
    onSuccess: (url) => {
      if (!url) {
        toast({
          title: "Account added",
          description: "Click \u201cVerify with bank login\u201d below to link it.",
        });
      }
      if (url) {
        // Open as a normal full-size tab, not a constrained popup — OAuth-based
        // bank redirects (Wells Fargo, Chase, etc. via Moov) can lose session
        // state inside small fixed-size popup windows, especially on mobile.
        const win = window.open(url, "_blank", "noopener,noreferrer");
        if (!win) {
          toast({
            title: "Popup blocked",
            description: "Allow popups, then click 'Verify with bank login' on the new account.",
            variant: "destructive",
          });
        } else {
          toast({ title: "Bank login opened", description: "Sign in with your bank — we'll fill in the rest automatically." });
        }
      }
      qc.invalidateQueries({ queryKey: ["tenant-primary-accounts"] });
    },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });


  const resendVerification = useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await supabase.functions.invoke("stakeholder-resend-verification", {
        body: { stakeholder_account_id: id },
      });
      if (error) {
        let msg = error.message ?? "Failed to resend verification";
        try {
          const body = await (error as any).context?.json?.();
          if (body?.error) msg = body.error;
        } catch {}
        throw new Error(msg);
      }
      if ((data as any)?.error) throw new Error((data as any).error);
    },
    onSuccess: () => toast({ title: "Verification email resent" }),
    onError: (e: any) => toast({ title: "Couldn't resend", description: e.message, variant: "destructive" }),
  });

  const deleteAccount = useMutation({
    mutationFn: async (id: string) => {
      const { error: linkError } = await supabase
        .from("check_stakeholders")
        .delete()
        .eq("stakeholder_account_id", id);
      if (linkError) throw linkError;

      const { error } = await supabase
        .from("stakeholder_accounts")
        .update({ is_active: false, is_primary: false })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast({ title: "Bank account removed" });
      qc.invalidateQueries({ queryKey: ["tenant-primary-accounts"] });
      qc.invalidateQueries({ queryKey: ["stakeholder-accounts"] });
      qc.invalidateQueries({ queryKey: ["check-stakeholders"] });
      qc.invalidateQueries({ queryKey: ["disbursement-accounts"] });
    },
    onError: (e: any) => toast({ title: "Couldn't remove account", description: e.message, variant: "destructive" }),
  });

  const adminOverride = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("stakeholder_accounts")
        .update({ verification_status: "admin_override", verified_at: new Date().toISOString() })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast({ title: "Account marked as verified (admin override)" });
      qc.invalidateQueries({ queryKey: ["tenant-primary-accounts"] });
    },
    onError: (e: any) => toast({ title: "Override failed", description: e.message, variant: "destructive" }),
  });

  if (isLoading) return <div className="text-sm text-muted-foreground p-4">Loading...</div>;

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      <SettingsHero
        title="Bank Account"
        description="Your bank account for receiving check deposits. Sign in with your bank via Moov — routing & account number, holder name, and account type are captured securely through your bank login. No manual entry."
        badge="Financials"
        icon={<Banknote className="h-4 w-4 text-primary" />}
      />

      <SectionCard
        title="Operating Account"
        accent="bg-gradient-to-r from-blue-400/60 to-blue-400/10"
        icon={<Banknote className="h-4 w-4 text-blue-400" />}
      >
        <div className="flex items-center justify-between mb-4">
          <div>
            <p className="text-sm text-muted-foreground">
              Link a primary business account for all claim deposits and treasury operations.
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            onClick={() => addAccount.mutate()}
            disabled={isStarting}
          >
            {isStarting
              ? <><Loader2 className="h-3 w-3 mr-1 animate-spin" /> Opening bank login...</>
              : <><Plus className="h-3 w-3 mr-1" /> Add account</>}
          </Button>
        </div>


          {accounts.length === 0 && (
            <p className="text-xs text-muted-foreground text-center py-4">
              No bank account added yet. Click "Add account" to sign in with your bank and verify instantly.
            </p>
          )}


          {accounts.map((acct: any) => {
            const vStatus = (acct.verification_status ?? "unverified") as VerificationStatus;
            return (
              <React.Fragment key={acct.id}>
                <div className="flex items-center justify-between gap-2 p-2.5 rounded-md border bg-background">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <p className="text-sm font-medium truncate">{acct.nickname}</p>
                      <Badge variant="outline" className={`text-[10px] px-1.5 ${VERIFICATION_BADGE_CLASS[vStatus]}`} title={VERIFICATION_LABEL[vStatus]}>
                        {vStatus === "verified" || vStatus === "admin_override" ? (
                          <><ShieldCheck className="h-2.5 w-2.5 mr-0.5 inline" /> Verified</>
                        ) : vStatus === "pending" ? (
                          <><MailCheck className="h-2.5 w-2.5 mr-0.5 inline" /> Awaiting confirmation</>
                        ) : vStatus === "locked" ? (
                          <><Lock className="h-2.5 w-2.5 mr-0.5 inline" /> Locked</>
                        ) : vStatus === "failed" ? (
                          "Failed"
                        ) : (
                          "Not verified"
                        )}
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground font-mono">
                      {acct.chk_acct ? `••••${acct.chk_acct.slice(-4)}` : "Account pending"} · {acct.acct_type === "C" ? "Checking" : "Savings"} · {acct.custname}
                    </p>
                  </div>
                  <div className="flex items-center gap-1">
                    {vStatus === "pending" && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 text-xs"
                        onClick={() => resendVerification.mutate(acct.id)}
                        disabled={resendVerification.isPending}
                      >
                        <MailCheck className="h-3 w-3 mr-1" /> Resend
                      </Button>
                    )}
                    {isAdmin && vStatus !== "verified" && vStatus !== "admin_override" && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 text-xs text-amber-600 hover:text-amber-700 hover:bg-amber-50"
                        onClick={() => adminOverride.mutate(acct.id)}
                        disabled={adminOverride.isPending}
                        title="Admin override: mark as verified without micro-deposits"
                      >
                        <ShieldAlert className="h-3 w-3 mr-1" /> Override
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-muted-foreground hover:text-destructive"
                      onClick={() => deleteAccount.mutate(acct.id)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
                <BankVerification
                  accountId={acct.id}
                  accountNickname={acct.nickname}
                  accountLast4={acct.chk_acct?.slice(-4) ?? ""}
                  verificationStatus={acct.verification_status ?? "unverified"}
                  verificationSource={(acct as any).verification_source ?? "moov"}
                />
                <AchAuthorizationForm
                  stakeholderAccountId={acct.id}
                  accountNickname={acct.nickname}
                  accountLast4={acct.chk_acct?.slice(-4) ?? ""}
                  custname={acct.custname}
                />
              </React.Fragment>
            );
        })}
      </SectionCard>
    </div>

  );
}

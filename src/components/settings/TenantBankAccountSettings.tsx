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
import { AuthentecheckVerification } from "@/components/disbursement/AuthentecheckVerification";
import { usePermissions } from "@/hooks/usePermissions";


export function TenantBankAccountSettings() {
  const { user } = useAuth();
  const { tenant } = useTenant();
  const { toast } = useToast();
  const { isAdmin } = usePermissions();
  const qc = useQueryClient();
  const [isStarting, setIsStarting] = useState(false);


  const { data: accounts = [], isLoading } = useQuery({
    queryKey: ["tenant-primary-accounts", tenant?.id],
    enabled: !!tenant?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("stakeholder_accounts")
        .select("id, nickname, chk_acct, acct_type, is_active, custname, verification_status, verified_at")
        .eq("tenant_id", tenant!.id)
        .eq("is_primary", true)
        .eq("is_active", true)
        .order("created_at", { ascending: true });
      if (error) throw error;
      return data ?? [];
    },
  });

  const addAccount = useMutation({
    mutationFn: async () => {
      let insertedId: string | null = null;
      // Create placeholder row; Authentecheck postback (Plaid) fills in all real fields:
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
        const { data: sess, error: initErr } = await supabase.functions.invoke(
          "actum-authentecheck-init",
          { body: { stakeholder_account_id: inserted!.id } },
        );
        if (initErr) {
          let msg = initErr.message ?? "Failed to start verification";
          try { const b = await (initErr as any).context?.json?.(); if (b?.error) msg = b.error; } catch {}
          throw new Error(msg);
        }
        if ((sess as any)?.error) throw new Error((sess as any).error);
        return (sess as any)?.url as string;
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
      if (url) {
        // Open as a normal full-size tab, not a constrained popup — OAuth-based
        // bank redirects (Wells Fargo, Chase, etc. via Plaid) can lose session
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
    <div className="space-y-6">
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-sm flex items-center gap-2">
                <Banknote className="h-4 w-4 text-blue-400" />
                Bank Account
              </CardTitle>
              <CardDescription className="text-xs mt-1">
                Your bank account for receiving check deposits. Sign in with your bank — routing & account number, holder name, and account type are captured securely through Authentecheck (Plaid). No manual entry.
              </CardDescription>
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
        </CardHeader>
        <CardContent className="space-y-3">

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
                      ••••{acct.chk_acct.slice(-4)} · {acct.acct_type === "C" ? "Checking" : "Savings"} · {acct.custname}
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
                <AuthentecheckVerification
                  accountId={acct.id}
                  accountNickname={acct.nickname}
                  accountLast4={acct.chk_acct.slice(-4)}
                  verificationStatus={acct.verification_status ?? "unverified"}
                />
                <AchAuthorizationForm
                  stakeholderAccountId={acct.id}
                  accountNickname={acct.nickname}
                  accountLast4={acct.chk_acct.slice(-4)}
                  custname={acct.custname}
                />
              </React.Fragment>
            );
          })}
        </CardContent>
      </Card>
    </div>
  );
}

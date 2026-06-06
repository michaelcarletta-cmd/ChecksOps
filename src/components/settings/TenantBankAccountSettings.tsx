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
import { AlertTriangle, Banknote, Plus, Trash2, ShieldCheck, MailCheck, Lock, Loader2 } from "lucide-react";
import { isValidRoutingNumber, VERIFICATION_LABEL, VERIFICATION_BADGE_CLASS, type VerificationStatus } from "@/lib/banking";
import { AchAuthorizationForm } from "@/components/disbursement/AchAuthorizationForm";
import { MicroDepositVerification } from "@/components/disbursement/MicroDepositVerification";

const emptyForm = {
  nickname: "",
  custname: "",
  chk_aba: "",
  chk_acct: "",
  acct_type: "C",
  recipient_email: "",
};

export function TenantBankAccountSettings() {
  const { user } = useAuth();
  const { tenant } = useTenant();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(emptyForm);

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
    mutationFn: async (values: typeof emptyForm) => {
      const { recipient_email, ...accountValues } = values;
      const { data: inserted, error } = await supabase
        .from("stakeholder_accounts")
        .insert({
          ...accountValues,
          account_type: "operating",
          is_primary: true,
          tenant_id: tenant!.id,
          created_by: user!.id,
        })
        .select("id")
        .single();
      if (error) throw error;

      const { data: initData, error: initErr } = await supabase.functions.invoke(
        "stakeholder-init-microdeposits",
        { body: { stakeholder_account_id: inserted.id, recipient_email } },
      );
      if (initErr) {
        let msg = initErr.message ?? "Failed to start verification";
        try {
          const body = await (initErr as any).context?.json?.();
          if (body?.error) msg = body.error;
        } catch {}
        throw new Error(msg);
      }
      if ((initData as any)?.error) throw new Error((initData as any).error);
    },
    onSuccess: () => {
      toast({ title: "Bank account added", description: "Two small deposits are on the way. Check your email to confirm the amounts." });
      qc.invalidateQueries({ queryKey: ["tenant-primary-accounts"] });
      setForm(emptyForm);
      setShowForm(false);
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
      const { error } = await supabase
        .from("stakeholder_accounts")
        .update({ is_active: false })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast({ title: "Bank account removed" });
      qc.invalidateQueries({ queryKey: ["tenant-primary-accounts"] });
    },
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
                Your bank account for receiving check alternative deposits. Must be verified via micro-deposits before use.
              </CardDescription>
            </div>
            {!showForm && (
              <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setShowForm(true)}>
                <Plus className="h-3 w-3 mr-1" />
                Add account
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-3">

          {showForm && (
            <div className="rounded-md border bg-muted/30 p-3 space-y-3">
              <p className="text-xs font-medium">New bank account</p>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <Label className="text-xs">Account nickname</Label>
                  <Input className="h-8 text-sm" placeholder="e.g. Main Operating Account" value={form.nickname} onChange={(e) => setForm({ ...form, nickname: e.target.value })} />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Account type</Label>
                  <Select value={form.acct_type} onValueChange={(v) => setForm({ ...form, acct_type: v })}>
                    <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="C" className="text-xs">Checking</SelectItem>
                      <SelectItem value="S" className="text-xs">Savings</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1 col-span-2">
                  <Label className="text-xs">Account holder name</Label>
                  <Input className="h-8 text-sm" placeholder="Full legal name on account" value={form.custname} onChange={(e) => setForm({ ...form, custname: e.target.value })} />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Routing number (ABA)</Label>
                  <Input className="h-8 text-sm font-mono" placeholder="9 digits" maxLength={9} value={form.chk_aba} onChange={(e) => setForm({ ...form, chk_aba: e.target.value.replace(/\D/g, "") })} />
                  {form.chk_aba.length === 9 && !isValidRoutingNumber(form.chk_aba) && (
                    <p className="text-[11px] text-rose-600 flex items-center gap-1">
                      <AlertTriangle className="h-3 w-3" /> Routing number failed checksum — please double-check.
                    </p>
                  )}
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Account number</Label>
                  <Input className="h-8 text-sm font-mono" placeholder="Up to 17 digits" maxLength={17} value={form.chk_acct} onChange={(e) => setForm({ ...form, chk_acct: e.target.value.replace(/\D/g, "") })} />
                </div>
                <div className="space-y-1 col-span-2">
                  <Label className="text-xs">Verification email</Label>
                  <Input
                    className="h-8 text-sm"
                    type="email"
                    placeholder="email@yourcompany.com"
                    value={form.recipient_email}
                    onChange={(e) => setForm({ ...form, recipient_email: e.target.value })}
                  />
                  <p className="text-[11px] text-muted-foreground">
                    We'll send two small deposits to this account and email this address a link to confirm the amounts.
                  </p>
                </div>
              </div>

              {(!form.nickname || !form.custname || !form.chk_aba || !form.chk_acct || !form.recipient_email) && (
                <div className="flex items-center gap-1 text-xs text-amber-600">
                  <AlertTriangle className="h-3 w-3" />
                  All fields are required
                </div>
              )}

              <div className="flex gap-2">
                <Button
                  size="sm"
                  onClick={() => addAccount.mutate(form)}
                  disabled={
                    addAccount.isPending ||
                    !form.nickname ||
                    !form.custname ||
                    !form.chk_aba ||
                    !form.chk_acct ||
                    !form.recipient_email ||
                    !isValidRoutingNumber(form.chk_aba)
                  }
                >
                  {addAccount.isPending ? <><Loader2 className="h-3 w-3 mr-1 animate-spin" /> Sending verification deposits...</> : "Add & verify account"}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => { setShowForm(false); setForm(emptyForm); }}>Cancel</Button>
              </div>
            </div>
          )}

          {accounts.length === 0 && !showForm && (
            <p className="text-xs text-muted-foreground text-center py-4">
              No bank account added yet. Add one to start accepting check alternative deposits.
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
                <MicroDepositVerification
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

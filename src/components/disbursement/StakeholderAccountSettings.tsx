import React, { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useTenant } from "@/contexts/TenantContext";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { AlertTriangle, Building2, Plus, Trash2, Star, CreditCard, ShieldCheck, MailCheck, Lock, Loader2, Info, ShieldAlert } from "lucide-react";
import { isValidRoutingNumber, VERIFICATION_LABEL, VERIFICATION_BADGE_CLASS, type VerificationStatus } from "@/lib/banking";
import { AchAuthorizationForm } from "./AchAuthorizationForm";
import { MicroDepositVerification } from "./MicroDepositVerification";
import { usePermissions } from "@/hooks/usePermissions";

const ACCOUNT_TYPE_LABELS: Record<string, string> = {
  operating: "Operating",
  vendor: "Vendor",
  subcontractor: "Subcontractor",
  overhead: "Overhead",
  insured: "Insured",
  contractor: "Contractor",
  supplier: "Supplier",
  other: "Other",
};

const ACCOUNT_TYPE_COLORS: Record<string, string> = {
  operating: "bg-emerald-500/10 text-emerald-700 border-emerald-500/20",
  vendor: "bg-blue-500/10 text-blue-700 border-blue-500/20",
  subcontractor: "bg-purple-500/10 text-purple-700 border-purple-500/20",
  overhead: "bg-amber-500/10 text-amber-700 border-amber-500/20",
  insured: "bg-rose-500/10 text-rose-700 border-rose-500/20",
  contractor: "bg-indigo-500/10 text-indigo-700 border-indigo-500/20",
  supplier: "bg-cyan-500/10 text-cyan-700 border-cyan-500/20",
  other: "bg-muted text-muted-foreground border-border",
};

const emptyForm = {
  nickname: "",
  account_type: "operating",
  custname: "",
  chk_aba: "",
  chk_acct: "",
  acct_type: "C",
  is_primary: false,
  recipient_email: "",
};

export function StakeholderAccountSettings() {
  const { user } = useAuth();
  const { tenant } = useTenant();
  const { toast } = useToast();
  const { isAdmin } = usePermissions();
  const qc = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(emptyForm);

  const { data: accounts = [], isLoading } = useQuery({
    queryKey: ["stakeholder-accounts", tenant?.id],
    enabled: !!tenant?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("stakeholder_accounts")
        .select("id, nickname, account_type, chk_acct, acct_type, is_primary, is_active, custname, verification_status, verified_at")
        .eq("tenant_id", tenant!.id)
        .eq("is_active", true)
        .order("is_primary", { ascending: false })
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
          tenant_id: tenant!.id,
          created_by: user!.id,
        })
        .select("id")
        .single();
      if (error) throw error;
      // Kick off micro-deposit verification
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
      if ((initData as any)?.error) {
        throw new Error((initData as any).error);
      }
    },
    onSuccess: () => {
      toast({ title: "Account added", description: "Two small deposits are on the way. Recipient will get an email to confirm." });
      qc.invalidateQueries({ queryKey: ["stakeholder-accounts"] });
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
      toast({ title: "Account removed" });
      qc.invalidateQueries({ queryKey: ["stakeholder-accounts"] });
    },
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
      qc.invalidateQueries({ queryKey: ["stakeholder-accounts"] });
    },
    onError: (e: any) => toast({ title: "Override failed", description: e.message, variant: "destructive" }),
  });


  if (isLoading) return <div className="text-sm text-muted-foreground p-4">Loading accounts...</div>;

  return (
    <div className="space-y-6">


      {/* Stakeholder Accounts */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm flex items-center gap-2">
              <Building2 className="h-4 w-4 text-blue-400" />
              Stakeholder Accounts
              <Badge variant="outline" className="text-xs">{accounts.length}</Badge>
            </CardTitle>
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setShowForm(!showForm)}>
              <Plus className="h-3 w-3 mr-1" />
              Add account
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">

          {/* Add account form */}
          {showForm && (
            <div className="rounded-md border bg-muted/30 p-3 space-y-3">
              <p className="text-xs font-medium">New stakeholder account</p>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <Label className="text-xs">Nickname</Label>
                  <Input className="h-8 text-sm" placeholder="e.g. Operating account" value={form.nickname} onChange={(e) => setForm({ ...form, nickname: e.target.value })} />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Type</Label>
                  <Select value={form.account_type} onValueChange={(v) => setForm({ ...form, account_type: v })}>
                    <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {Object.entries(ACCOUNT_TYPE_LABELS).map(([v, l]) => (
                        <SelectItem key={v} value={v} className="text-xs">{l}</SelectItem>
                      ))}
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
                  <Label className="text-xs">Recipient email for verification</Label>
                  <Input
                    className="h-8 text-sm"
                    type="email"
                    placeholder="who-owns-this-account@example.com"
                    value={form.recipient_email}
                    onChange={(e) => setForm({ ...form, recipient_email: e.target.value })}
                  />
                  <p className="text-[11px] text-muted-foreground">
                    We'll send two small deposits to this account, then email this address with a link to confirm the amounts.
                  </p>
                </div>
                <div className="flex items-center gap-2 pt-4">
                  <Switch checked={form.is_primary} onCheckedChange={(v) => setForm({ ...form, is_primary: v })} />
                  <Label className="text-xs">Set as primary account</Label>
                </div>
              </div>

              {(!form.nickname || !form.custname || !form.chk_aba || !form.chk_acct || !form.recipient_email) && (
                <div className="flex items-center gap-1 text-xs text-amber-600">
                  <AlertTriangle className="h-3 w-3" />
                  All fields required (including recipient email)
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
                  {addAccount.isPending ? <><Loader2 className="h-3 w-3 mr-1 animate-spin" /> Sending micro-deposits...</> : "Add & verify account"}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => { setShowForm(false); setForm(emptyForm); }}>Cancel</Button>
              </div>
            </div>
          )}

          {/* Account list */}
          <div className="flex items-center gap-2 px-1 mb-2">
            <Info className="h-3.5 w-3.5 text-muted-foreground" />
            <p className="text-xs text-muted-foreground">
              Your primary account requires ACH debit authorization before disbursements can be sent.
            </p>
          </div>

          {accounts.length === 0 && !showForm && (
            <p className="text-xs text-muted-foreground text-center py-4">
              No stakeholder accounts yet. Add one to start disbursing.
            </p>
          )}

          {accounts.map((acct: any) => {
            const vStatus = (acct.verification_status ?? "unverified") as VerificationStatus;
            return (
              <React.Fragment key={acct.id}>
                <div className="flex items-center justify-between gap-2 p-2.5 rounded-md border bg-background">
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  {acct.is_primary && <Star className="h-3 w-3 text-amber-400 flex-shrink-0" />}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <p className="text-sm font-medium truncate">{acct.nickname}</p>
                      <Badge variant="outline" className={`text-[10px] px-1.5 ${ACCOUNT_TYPE_COLORS[acct.account_type]}`}>
                        {ACCOUNT_TYPE_LABELS[acct.account_type]}
                      </Badge>
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
                      ••••{acct.chk_acct.slice(-4)} · {acct.acct_type === "C" ? "Checking" : "Savings"}
                    </p>
                  </div>
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
              <MicroDepositVerification
                accountId={acct.id}
                accountNickname={acct.nickname}
                accountLast4={acct.chk_acct.slice(-4)}
                verificationStatus={acct.verification_status ?? "unverified"}
              />
              {acct.is_primary && (
                <AchAuthorizationForm
                  stakeholderAccountId={acct.id}
                  accountNickname={acct.nickname}
                  accountLast4={acct.chk_acct.slice(-4)}
                  custname={acct.custname}
                />
              )}
            </React.Fragment>
          );
        })}
        </CardContent>
      </Card>
    </div>
  );
}

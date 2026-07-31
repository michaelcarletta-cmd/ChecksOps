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
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { AlertTriangle, Building2, Plus, Trash2, Star, CreditCard, ShieldCheck, MailCheck, Lock, Loader2, Info, ShieldAlert } from "lucide-react";
import { isValidRoutingNumber, VERIFICATION_LABEL, VERIFICATION_BADGE_CLASS, type VerificationStatus } from "@/lib/banking";
import { AchAuthorizationForm } from "./AchAuthorizationForm";
import { BankVerification } from "./BankVerification";
import { usePermissions } from "@/hooks/usePermissions";
import { usePaymentRail } from "@/hooks/usePaymentRail";
import { RequestStakeholderLimitDialog } from "./RequestStakeholderLimitDialog";


const ACCOUNT_TYPE_LABELS: Record<string, string> = {
  operating: "Operating",
  vendor: "Vendor",
  subcontractor: "Subcontractor",
  overhead: "Overhead",
  insured: "Insured",
  contractor: "Contractor",
  supplier: "Supplier",
  sales_rep: "Sales rep",
  homeowner: "Homeowner",
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
  sales_rep: "bg-orange-500/10 text-orange-700 border-orange-500/20",
  homeowner: "bg-pink-500/10 text-pink-700 border-pink-500/20",
  other: "bg-muted text-muted-foreground border-border",
};

// Types users can pick when creating a new stakeholder account.
// Legacy values (operating, overhead, insured, contractor, supplier, other)
// stay in ACCOUNT_TYPE_LABELS so grandfathered accounts still render correctly.
const SELECTABLE_ACCOUNT_TYPES = ["subcontractor", "vendor", "sales_rep", "homeowner"] as const;

const emptyForm = {
  nickname: "",
  account_type: "subcontractor",
  custname: "",
  acct_type: "C",
  is_primary: false,
  send_method: "self" as "self" | "email",
  verification_recipient_email: "",
};

export function StakeholderAccountSettings() {
  const { user } = useAuth();
  const { tenant } = useTenant();
  const { toast } = useToast();
  const { isAdmin } = usePermissions();
  const { isPlaid } = usePaymentRail();
  const qc = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [capLimitDialog, setCapLimitDialog] = useState<null | "sales_rep" | "subcontractor" | "vendor">(null);
  const [requestLimitDialog, setRequestLimitDialog] = useState<null | "sales_rep" | "subcontractor" | "vendor">(null);

  const { data: accounts = [], isLoading } = useQuery({
    queryKey: ["stakeholder-accounts", tenant?.id],
    enabled: !!tenant?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("stakeholder_accounts")
        .select("id, nickname, account_type, chk_acct, acct_type, is_primary, is_active, custname, homeowner_name, verification_status, verified_at, verification_recipient_email")
        .eq("tenant_id", tenant!.id)
        .eq("is_active", true)
        .order("is_primary", { ascending: false })
        .order("created_at", { ascending: true });
      if (error) throw error;
      // Tenant's own bank account (operating) is shown separately at the top of
      // the page in TenantBankAccountSettings. Exclude it here so stakeholders
      // are strictly third parties identified by their account_type.
      return (data ?? []).filter((a: any) => a.account_type !== "operating");
    },
  });

  const { data: tenantCaps } = useQuery({
    queryKey: ["tenant-stakeholder-caps", tenant?.id],
    enabled: !!tenant?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("tenants")
        .select("max_sales_reps, max_subcontractors, max_vendors")
        .eq("id", tenant!.id)
        .maybeSingle();
      if (error) throw error;
      return data as { max_sales_reps: number; max_subcontractors: number; max_vendors: number } | null;
    },
  });

  const { data: tenantRole } = useQuery({
    queryKey: ["tenant-user-role", tenant?.id, user?.id],
    enabled: !!tenant?.id && !!user?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("tenant_users")
        .select("role")
        .eq("tenant_id", tenant!.id)
        .eq("user_id", user!.id)
        .maybeSingle();
      if (error) throw error;
      return (data?.role ?? null) as string | null;
    },
  });
  const canManageTenant = tenantRole === "owner" || tenantRole === "admin";

  const capForType = (t: string): number | null => {
    if (t === "sales_rep") return tenantCaps?.max_sales_reps ?? 5;
    if (t === "subcontractor") return tenantCaps?.max_subcontractors ?? 10;
    if (t === "vendor") return tenantCaps?.max_vendors ?? 5;
    return null;
  };
  const countForType = (t: string) => accounts.filter((a: any) => a.account_type === t).length;
  const isAtCap = (t: string) => {
    const max = capForType(t);
    return max !== null && countForType(t) >= max;
  };



  const addAccount = useMutation({
    mutationFn: async (values: typeof emptyForm) => {
      const { send_method, verification_recipient_email, ...accountFields } = values;
      let insertedId: string | null = null;
      const { data: inserted, error } = await supabase
        .from("stakeholder_accounts")
        .insert({
          ...accountFields,
          verification_recipient_email: send_method === "email" ? verification_recipient_email.trim() : null,
          chk_aba: "000000000",
          chk_acct: "0000000000",
          tenant_id: tenant!.id,
          created_by: user!.id,
        } as any)
        .select("id")
        .single();
      if (error) throw error;
      insertedId = inserted!.id;

      try {
        if (send_method === "email") {
          const { data: sent, error: sendErr } = await supabase.functions.invoke(
            "stakeholder-resend-verification",
            { body: { stakeholder_account_id: inserted!.id, recipient_email: verification_recipient_email.trim() } },
          );
          if (sendErr) {
            let msg = sendErr.message ?? "Failed to send verification link";
            try { const b = await (sendErr as any).context?.json?.(); if (b?.error) msg = b.error; } catch {}
            throw new Error(msg);
          }
          if ((sent as any)?.error) throw new Error((sent as any).error);
          return { url: null, emailed: true };
        }

        // Plaid rail: no hosted redirect — the inline Plaid Link widget on the
        // new account card completes verification.
        if (isPlaid) return { url: null, emailed: false };

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
        return { url: (sess as any)?.url as string, emailed: false };
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
    onSuccess: ({ url, emailed }) => {
      if (emailed) {
        toast({ title: "Verification link sent", description: "The account holder will receive an email to link their bank account." });
      } else if (!url && isPlaid) {
        toast({
          title: "Account added",
          description: "Click \u201cVerify with bank login\u201d on the new account to link it through Plaid.",
        });
      } else if (url) {
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
          toast({ title: "Bank login opened", description: "Sign in with your bank to verify the account." });
        }
      }
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
      toast({ title: "Account removed" });
      qc.invalidateQueries({ queryKey: ["stakeholder-accounts"] });
      qc.invalidateQueries({ queryKey: ["tenant-primary-accounts"] });
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
      qc.invalidateQueries({ queryKey: ["stakeholder-accounts"] });
    },
    onError: (e: any) => toast({ title: "Override failed", description: e.message, variant: "destructive" }),
  });


  if (isLoading) return <div className="text-sm text-muted-foreground p-4">Loading accounts...</div>;

  return (
    <div className="space-y-6">
      <StakeholderCapsBar accounts={accounts} tenantId={tenant?.id} />








      {/* Stakeholder Accounts */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm flex items-center gap-2">
              <Building2 className="h-4 w-4 text-blue-400" />
              Stakeholder Accounts
              <Badge variant="outline" className="text-xs">{accounts.length}</Badge>
            </CardTitle>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              onClick={() => {
                // If they're already at cap on the default type, pop the limit dialog
                if (!showForm && isAtCap(form.account_type)) {
                  setCapLimitDialog(form.account_type as any);
                  return;
                }
                setShowForm(!showForm);
              }}
            >
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
                  <Select
                    value={form.account_type}
                    onValueChange={(v) => {
                      if (isAtCap(v)) {
                        setCapLimitDialog(v as any);
                        return;
                      }
                      setForm({ ...form, account_type: v });
                    }}
                  >
                    <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {SELECTABLE_ACCOUNT_TYPES.map((v) => (
                        <SelectItem key={v} value={v} className="text-xs">
                          {ACCOUNT_TYPE_LABELS[v]}{isAtCap(v) ? " (limit reached)" : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1 col-span-2">
                  <Label className="text-xs">Account holder name</Label>
                  <Input className="h-8 text-sm" placeholder="Full legal name on account" value={form.custname} onChange={(e) => setForm({ ...form, custname: e.target.value })} />
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
                <div className="flex items-center gap-2 pt-4 col-span-2">
                  <Switch checked={form.is_primary} onCheckedChange={(v) => setForm({ ...form, is_primary: v })} />
                  <Label className="text-xs">Set as primary account</Label>
                </div>
              </div>

              {(!form.nickname || !form.custname) && (
                <div className="flex items-center gap-1 text-xs text-amber-600">
                  <AlertTriangle className="h-3 w-3" />
                  Nickname and account holder name are required
                </div>
              )}

              <div className="flex items-center gap-2 pt-1">
                <Switch
                  checked={form.send_method === "email"}
                  onCheckedChange={(v) => setForm({ ...form, send_method: v ? "email" : "self" })}
                />
                <Label className="text-xs">Send a link for the account holder to add their own bank account</Label>
              </div>

              {form.send_method === "email" ? (
                <div className="space-y-1">
                  <Label className="text-xs">Account holder's email</Label>
                  <Input
                    className="h-8 text-sm"
                    type="email"
                    placeholder="name@example.com"
                    value={form.verification_recipient_email}
                    onChange={(e) => setForm({ ...form, verification_recipient_email: e.target.value })}
                  />
                  <p className="text-[11px] text-muted-foreground">
                    They'll get an emailed link to securely sign in to their bank and link
                    their own account — no bank details are entered here.
                  </p>
                </div>
              ) : (
                <p className="text-[11px] text-muted-foreground">
                  Routing & account numbers are captured securely after you sign in to your bank.
                  Continue to launch the bank login.
                </p>
              )}

              <div className="flex gap-2">
                <Button
                  size="sm"
                  onClick={() => {
                    if (isAtCap(form.account_type)) {
                      setCapLimitDialog(form.account_type as any);
                      return;
                    }
                    addAccount.mutate(form);
                  }}

                  disabled={
                    addAccount.isPending ||
                    !form.nickname ||
                    !form.custname ||
                    (form.send_method === "email" && !form.verification_recipient_email.trim())
                  }
                >
                  {addAccount.isPending ? (
                    <><Loader2 className="h-3 w-3 mr-1 animate-spin" /> {form.send_method === "email" ? "Sending link..." : "Opening bank login..."}</>
                  ) : form.send_method === "email" ? (
                    "Send link"
                  ) : (
                    "Continue to bank login"
                  )}
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
                      <p className="text-sm font-medium truncate">{acct.homeowner_name || acct.custname || acct.nickname}</p>
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
                      {acct.nickname ? `${acct.nickname} · ` : ""}{acct.chk_acct ? `••••${acct.chk_acct.slice(-4)}` : "Account pending"} · {acct.acct_type === "C" ? "Checking" : "Savings"}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  {acct.verification_recipient_email && ["unverified", "pending", "failed"].includes(vStatus) && (
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
                      title="Admin override: mark as verified without a bank login"
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
                verificationSource={(acct as any).verification_source ?? null}
              />
              {acct.is_primary && (
                <AchAuthorizationForm
                  stakeholderAccountId={acct.id}
                  accountNickname={acct.nickname}
                  accountLast4={acct.chk_acct?.slice(-4) ?? ""}
                  custname={acct.custname}
                />
              )}
            </React.Fragment>
          );
        })}
        </CardContent>
      </Card>

      {/* Cap-reached popup */}
      <Dialog open={!!capLimitDialog} onOpenChange={(o) => !o && setCapLimitDialog(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldAlert className="h-4 w-4 text-amber-500" />
              {capLimitDialog ? ACCOUNT_TYPE_LABELS[capLimitDialog] : ""} limit reached
            </DialogTitle>
            <DialogDescription>
              All {capLimitDialog ? ACCOUNT_TYPE_LABELS[capLimitDialog].toLowerCase() : ""} account
              slots for your tenant are in use
              {capLimitDialog ? ` (${countForType(capLimitDialog)} of ${capForType(capLimitDialog)})` : ""}.
              To add another, request more capacity from ChecksOps below.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" size="sm" onClick={() => setCapLimitDialog(null)}>Close</Button>
            {canManageTenant ? (
              <Button
                size="sm"
                onClick={() => {
                  const cat = capLimitDialog;
                  setCapLimitDialog(null);
                  if (cat) setRequestLimitDialog(cat);
                }}
              >
                Request more
              </Button>
            ) : (
              <span className="text-[11px] text-muted-foreground italic self-center">
                Ask an owner/admin to request more
              </span>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {requestLimitDialog && (
        <RequestStakeholderLimitDialog
          open={!!requestLimitDialog}
          onOpenChange={(o) => !o && setRequestLimitDialog(null)}
          category={requestLimitDialog}
          currentLimit={capForType(requestLimitDialog) ?? 0}
        />
      )}
    </div>
  );
}


// ---------------------------------------------------------------------------
// Sales-rep + subcontractor cap counter with "Request more" button
// ---------------------------------------------------------------------------
function StakeholderCapsBar({ accounts, tenantId }: { accounts: any[]; tenantId?: string }) {
  const { user } = useAuth();
  const [openDialog, setOpenDialog] = useState<null | "sales_rep" | "subcontractor" | "vendor">(null);

  const { data: tenantLimits } = useQuery({
    queryKey: ["tenant-stakeholder-caps", tenantId],
    enabled: !!tenantId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("tenants")
        .select("max_sales_reps, max_subcontractors, max_vendors")
        .eq("id", tenantId!)
        .maybeSingle();
      if (error) throw error;
      return data as { max_sales_reps: number; max_subcontractors: number; max_vendors: number } | null;
    },
  });

  // Only tenant owners/admins may request more capacity.
  const { data: tenantRole } = useQuery({
    queryKey: ["tenant-user-role", tenantId, user?.id],
    enabled: !!tenantId && !!user?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("tenant_users")
        .select("role")
        .eq("tenant_id", tenantId!)
        .eq("user_id", user!.id)
        .maybeSingle();
      if (error) throw error;
      return (data?.role ?? null) as string | null;
    },
  });
  const canManageTenant = tenantRole === "owner" || tenantRole === "admin";

  const maxSalesReps = tenantLimits?.max_sales_reps ?? 5;
  const maxSubs = tenantLimits?.max_subcontractors ?? 10;
  const maxVendors = tenantLimits?.max_vendors ?? 5;
  const salesCount = accounts.filter((a: any) => a.account_type === "sales_rep").length;
  const subCount = accounts.filter((a: any) => a.account_type === "subcontractor").length;
  const vendorCount = accounts.filter((a: any) => a.account_type === "vendor").length;

  const currentLimit =
    openDialog === "sales_rep" ? maxSalesReps :
    openDialog === "subcontractor" ? maxSubs :
    openDialog === "vendor" ? maxVendors : 0;

  const CapRow = ({ label, used, max, category }: { label: string; used: number; max: number; category: "sales_rep" | "subcontractor" | "vendor" }) => {
    const nearCap = used >= max;
    return (
      <div className="flex items-center justify-between text-xs">
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground">{label}</span>
          <Badge variant="outline" className={nearCap ? "border-amber-500/40 text-amber-700 bg-amber-500/10" : ""}>
            {used} / {max}
          </Badge>
        </div>
        {canManageTenant ? (
          <Button size="sm" variant="ghost" className="h-6 text-[10px]" onClick={() => setOpenDialog(category)}>
            Request more
          </Button>
        ) : (
          <span className="text-[10px] text-muted-foreground italic">Ask an owner to request more</span>
        )}
      </div>
    );
  };

  return (
    <>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-xs text-muted-foreground">Team caps</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1.5">
          <CapRow label="Sales reps" used={salesCount} max={maxSalesReps} category="sales_rep" />
          <CapRow label="Subcontractors" used={subCount} max={maxSubs} category="subcontractor" />
          <CapRow label="Vendors" used={vendorCount} max={maxVendors} category="vendor" />
        </CardContent>
      </Card>
      {openDialog && (
        <RequestStakeholderLimitDialog
          open={!!openDialog}
          onOpenChange={(o) => !o && setOpenDialog(null)}
          category={openDialog}
          currentLimit={currentLimit}
        />
      )}
    </>
  );
}


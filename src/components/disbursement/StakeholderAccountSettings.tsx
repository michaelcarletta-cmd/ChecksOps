import React, { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useTenant } from "@/contexts/TenantContext";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { AlertTriangle, Building2, Plus, Trash2, Star, ShieldCheck, MailCheck, Lock, Loader2, Info, ShieldAlert, Unplug } from "lucide-react";
import { isValidRoutingNumber, VERIFICATION_LABEL, VERIFICATION_BADGE_CLASS, type VerificationStatus } from "@/lib/banking";
import { AchAuthorizationForm } from "./AchAuthorizationForm";
import { BankVerification } from "./BankVerification";
import { useCurrentTenantMembership } from "@/hooks/useCurrentTenantMembership";
import {
  PAYEE_ROW_COLUMNS,
  PAYEE_STATUS_CLASS,
  PAYEE_STATUS_LABEL,
  payeeCanResend,
  payeeProgress,
  payeeStatus,
  unwrapPayeeInvoke,
  type PayeeRecipientType,
  type PayeeRow,
} from "@/lib/payeeSetup";


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

// A new stakeholder is a payee: the server creates it and emails the payee a
// setup link (identity + bank, completed by the payee). No bank details here.
const emptyForm = {
  recipient_type: "individual" as PayeeRecipientType,
  name: "",
  email: "",
  account_type: "subcontractor",
};

export function StakeholderAccountSettings() {
  const { tenant } = useTenant();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [capLimitDialog, setCapLimitDialog] = useState<null | "sales_rep" | "subcontractor" | "vendor">(null);
  const [deleteTarget, setDeleteTarget] = useState<null | { id: string; label: string; payee: PayeeRow | null }>(null);
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());

  const { data: accounts = [], isLoading } = useQuery({
    queryKey: ["stakeholder-accounts", tenant?.id],
    enabled: !!tenant?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("stakeholder_accounts")
        .select("id, nickname, account_type, chk_acct, acct_type, is_primary, is_active, custname, homeowner_name, verification_status, verified_at, verification_recipient_email, origin")
        .eq("tenant_id", tenant!.id)
        .eq("is_active", true)
        .order("is_primary", { ascending: false })
        .order("created_at", { ascending: true });
      if (error) throw error;
      // Tenant's own bank account (operating, or a provider-connected payment
      // account like the Moov-linked "payment account") is shown separately at
      // the top of the page in TenantBankAccountSettings. Exclude both here so
      // stakeholders are strictly third parties identified by their account_type.
      return (data ?? []).filter(
        (a: any) => a.account_type !== "operating" && a.origin !== "provider_connected",
      );
    },
  });

  // Payee setup state (SQL 113 columns; SELECT under the tenant policy). The
  // link token column is never read.
  const { data: payees = [] } = useQuery({
    queryKey: ["payee-recipients", tenant?.id],
    enabled: !!tenant?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("external_payment_recipients")
        .select(PAYEE_ROW_COLUMNS)
        .eq("tenant_id", tenant!.id)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as PayeeRow[];
    },
  });
  const payeeByStakeholder = new Map<string, PayeeRow>();
  for (const p of payees) {
    if (p.stakeholder_account_id && !payeeByStakeholder.has(p.stakeholder_account_id)) payeeByStakeholder.set(p.stakeholder_account_id, p);
  }
  const activeIds = new Set(accounts.map((a: any) => a.id as string));
  const disconnectedPayees = payees.filter((p) => p.disconnected_at && !(p.stakeholder_account_id && activeIds.has(p.stakeholder_account_id)));

  const { data: tenantCaps } = useQuery({
    queryKey: ["tenant-stakeholder-caps", tenant?.id],
    enabled: !!tenant?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("tenants")
        .select("stakeholder_cap")
        .eq("id", tenant!.id)
        .maybeSingle();
      if (error) throw error;
      return data as { stakeholder_cap: number | null } | null;
    },
  });

  // Owner policy: every member of the tenant is a user with the same rights.
  const { isMember: canManageTenant } = useCurrentTenantMembership();

  // One shared limit across vendors, sales reps and subcontractors.
  const CAPPED_TYPES = ["sales_rep", "subcontractor", "vendor"];
  const sharedCap = tenantCaps?.stakeholder_cap ?? 5;
  const capForType = (t: string): number | null =>
    CAPPED_TYPES.includes(t) ? sharedCap : null;
  const countForType = (t: string) =>
    CAPPED_TYPES.includes(t)
      ? accounts.filter((a: any) => CAPPED_TYPES.includes(a.account_type)).length
      : accounts.filter((a: any) => a.account_type === t).length;
  const isAtCap = (t: string) => {
    const max = capForType(t);
    return max !== null && countForType(t) >= max;
  };




  const addAccount = useMutation({
    mutationFn: async (values: typeof emptyForm) => {
      const created = await unwrapPayeeInvoke<{ email_sent?: boolean }>(await supabase.functions.invoke("moov-recipient-create", {
        body: {
          tenant_id: tenant!.id,
          name: values.name.trim(),
          email: values.email.trim().toLowerCase(),
          recipient_type: values.recipient_type,
          relationship: values.account_type,
          // A retried click maps to the same payee on the server.
          request_id: requestId,
        },
      }), "Couldn't add the stakeholder");
      return { emailSent: created.email_sent === true, email: values.email.trim().toLowerCase() };
    },
    onSuccess: ({ emailSent, email }) => {
      toast(emailSent
        ? { title: "Setup link emailed", description: `${email} will receive a link to verify their identity and bank account.` }
        : { title: "Stakeholder added; email not sent", description: "The setup email could not be sent. Use Resend link to try again.", variant: "destructive" });
      qc.invalidateQueries({ queryKey: ["stakeholder-accounts"] });
      qc.invalidateQueries({ queryKey: ["payee-recipients"] });
      setForm(emptyForm);
      setRequestId(crypto.randomUUID());
      setShowForm(false);
    },
    onError: (e: Error) => toast({ title: "Couldn't add stakeholder", description: e.message, variant: "destructive" }),
  });

  const resendLink = useMutation({
    mutationFn: async (payee: PayeeRow) => {
      const out = await unwrapPayeeInvoke<{ email_sent?: boolean }>(await supabase.functions.invoke("moov-recipient-link-resend", {
        body: { recipient_id: payee.id },
      }), "Couldn't resend the link");
      return { emailSent: out.email_sent === true, email: payee.email };
    },
    onSuccess: ({ emailSent, email }) => {
      toast(emailSent
        ? { title: "Setup link emailed", description: `A new link was sent${email ? ` to ${email}` : ""}. Earlier links no longer work.` }
        : { title: "Email not sent", description: "A new link was created but the email could not be sent. Try again shortly.", variant: "destructive" });
      qc.invalidateQueries({ queryKey: ["payee-recipients"] });
    },
    onError: (e: Error) => toast({ title: "Couldn't resend", description: e.message, variant: "destructive" }),
  });

  const deleteAccount = useMutation({
    mutationFn: async ({ id, payee }: { id: string; payee: PayeeRow | null }) => {
      if (payee) {
        // A payee is disconnected on the server: link closed, stakeholder
        // inactive, bank methods disconnected, then the provider account.
        await unwrapPayeeInvoke(await supabase.functions.invoke("moov-recipient-disconnect", {
          body: { recipient_id: payee.id },
        }), "Couldn't disconnect the payee");
      }

      const { error: linkError } = await supabase
        .from("check_stakeholders")
        .delete()
        .eq("stakeholder_account_id", id);
      if (linkError) throw linkError;

      if (!payee) {
        const { error } = await supabase
          .from("stakeholder_accounts")
          .update({ is_active: false, is_primary: false })
          .eq("id", id);
        if (error) throw error;
      }
    },
    onSuccess: (_out, { payee }) => {
      setDeleteTarget(null);
      toast({ title: payee ? "Payee disconnected" : "Account removed" });
      qc.invalidateQueries({ queryKey: ["stakeholder-accounts"] });
      qc.invalidateQueries({ queryKey: ["payee-recipients"] });
      qc.invalidateQueries({ queryKey: ["tenant-primary-accounts"] });
      qc.invalidateQueries({ queryKey: ["check-stakeholders"] });
      qc.invalidateQueries({ queryKey: ["disbursement-accounts"] });
    },
    onError: (e: Error) => toast({ title: "Couldn't remove account", description: e.message, variant: "destructive" }),
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
              Add stakeholder
            </Button>

          </div>
        </CardHeader>
        <CardContent className="space-y-3">

          {/* Add stakeholder form: creates a payee and emails the setup link */}
          {showForm && (
            <div className="rounded-md border bg-muted/30 p-3 space-y-3">
              <p className="text-xs font-medium">New stakeholder</p>
              <div className="flex gap-1" role="radiogroup" aria-label="Stakeholder is">
                {(["individual", "business"] as const).map((t) => (
                  <Button
                    key={t}
                    type="button"
                    size="sm"
                    variant={form.recipient_type === t ? "default" : "outline"}
                    className="h-7 text-xs"
                    role="radio"
                    aria-checked={form.recipient_type === t}
                    onClick={() => setForm({ ...form, recipient_type: t })}
                  >
                    {t === "individual" ? "Individual" : "Business"}
                  </Button>
                ))}
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1 col-span-2">
                  <Label className="text-xs">{form.recipient_type === "business" ? "Business name" : "Full name"}</Label>
                  <Input className="h-8 text-sm" placeholder={form.recipient_type === "business" ? "ABC Roofing LLC" : "Jane Smith"} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Email</Label>
                  <Input className="h-8 text-sm" type="email" placeholder="name@example.com" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Relationship</Label>
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
              </div>

              {(form.name.trim().length < 2 || !form.email.trim()) && (
                <div className="flex items-center gap-1 text-xs text-amber-600">
                  <AlertTriangle className="h-3 w-3" />
                  Name and email are required
                </div>
              )}

              <p className="text-[11px] text-muted-foreground">
                They'll be emailed a secure link to verify their {form.recipient_type === "business" ? "business, its owners" : "identity"} and
                add their bank account. No bank details are entered here. They can be paid once setup is verified.
              </p>

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
                  disabled={addAccount.isPending || form.name.trim().length < 2 || !form.email.trim()}
                >
                  {addAccount.isPending ? (
                    <><Loader2 className="h-3 w-3 mr-1 animate-spin" /> Sending link...</>
                  ) : (
                    "Add & email setup link"
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
            const payee = payeeByStakeholder.get(acct.id) ?? null;
            const pStatus = payee ? payeeStatus(payee) : null;
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
                      {payee && pStatus ? (
                        <Badge variant="outline" className={`text-[10px] px-1.5 ${PAYEE_STATUS_CLASS[pStatus]}`} title={payeeProgress(payee)}>
                          {pStatus === "verified" && <ShieldCheck className="h-2.5 w-2.5 mr-0.5 inline" />}
                          {pStatus === "link_sent" && <MailCheck className="h-2.5 w-2.5 mr-0.5 inline" />}
                          {PAYEE_STATUS_LABEL[pStatus]}
                        </Badge>
                      ) : (
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
                      )}
                    </div>
                    {payee ? (
                      <p className="text-xs text-muted-foreground">
                        {payee.recipient_type === "business" ? "Business" : "Individual"}
                        {payee.email ? ` · ${payee.email}` : ""}
                        {" · "}
                        {payee.provider_last_four
                          ? <span className="font-mono">{payee.provider_bank_name ? `${payee.provider_bank_name} ` : ""}••••{payee.provider_last_four}</span>
                          : payeeProgress(payee)}
                      </p>
                    ) : (
                    <p className="text-xs text-muted-foreground font-mono">
                      {acct.nickname ? `${acct.nickname} · ` : ""}{acct.chk_acct ? `••••${acct.chk_acct.slice(-4)}` : "Account pending"} · {acct.acct_type === "C" ? "Checking" : "Savings"}
                    </p>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  {payee && payeeCanResend(payee) && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 text-xs"
                      onClick={() => resendLink.mutate(payee)}
                      disabled={resendLink.isPending}
                      title="Email a new setup link (earlier links stop working)"
                    >
                      <MailCheck className="h-3 w-3 mr-1" /> Resend link
                    </Button>
                  )}
                  {payee && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 text-xs text-muted-foreground hover:text-destructive"
                      onClick={() => setDeleteTarget({ id: acct.id, label: acct.custname || acct.nickname || "this stakeholder", payee })}
                      title="Stop paying this payee and close their setup link"
                    >
                      <Unplug className="h-3 w-3 mr-1" /> Disconnect
                    </Button>
                  )}
                  {!payee && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-muted-foreground hover:text-destructive"
                    onClick={() => setDeleteTarget({ id: acct.id, label: acct.custname || acct.nickname || "this stakeholder", payee: null })}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                  )}
                </div>
              </div>
              {!payee && (
              <BankVerification
                accountId={acct.id}
                accountNickname={acct.nickname}
                accountLast4={acct.chk_acct?.slice(-4) ?? ""}
                verificationStatus={acct.verification_status ?? "unverified"}
                verificationSource={(acct as any).verification_source ?? null}
              />
              )}
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

          {disconnectedPayees.length > 0 && (
            <div className="space-y-1 pt-2">
              <p className="text-[11px] font-medium text-muted-foreground">Disconnected payees</p>
              {disconnectedPayees.map((p) => (
                <div key={p.id} className="flex items-center justify-between gap-2 p-2 rounded-md border border-dashed text-xs text-muted-foreground">
                  <span className="truncate">{p.display_name}{p.email ? ` · ${p.email}` : ""}</span>
                  <Badge variant="outline" className={`text-[10px] px-1.5 ${PAYEE_STATUS_CLASS.disconnected}`}>{PAYEE_STATUS_LABEL.disconnected}</Badge>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Cap-reached popup */}
      <Dialog open={!!capLimitDialog} onOpenChange={(o) => !o && setCapLimitDialog(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldAlert className="h-4 w-4 text-amber-500" />
              Stakeholder limit reached
            </DialogTitle>
            <DialogDescription>
              All additional stakeholder slots for your tenant are in use
              {capLimitDialog ? ` (${countForType(capLimitDialog)} of ${capForType(capLimitDialog)})` : ""}.
              Vendors, sales reps and subcontractors share one limit. Remove an existing
              stakeholder to free up a slot.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" size="sm" onClick={() => setCapLimitDialog(null)}>Close</Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={!!deleteTarget} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base">{deleteTarget?.payee ? "Disconnect" : "Remove"} {deleteTarget?.label}?</DialogTitle>
            <DialogDescription className="text-xs">
              {deleteTarget?.payee
                ? "They will be unlinked from all checks and can no longer be paid. Their setup link stops working and their payment account is disconnected. To pay them again, add them as a new stakeholder."
                : "They will be unlinked from all checks and hidden from payouts."}
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" size="sm" onClick={() => setDeleteTarget(null)}>Cancel</Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={deleteAccount.isPending}
              onClick={() => deleteTarget && deleteAccount.mutate({ id: deleteTarget.id, payee: deleteTarget.payee })}
            >
              {deleteAccount.isPending && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
              {deleteTarget?.payee ? "Disconnect" : "Remove"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

    </div>
  );
}


// ---------------------------------------------------------------------------
// Shared additional-stakeholder cap counter (fixed limit, no self-service raise)
// ---------------------------------------------------------------------------
function StakeholderCapsBar({ accounts, tenantId }: { accounts: any[]; tenantId?: string }) {
  const { data: tenantLimits } = useQuery({
    queryKey: ["tenant-stakeholder-caps", tenantId],
    enabled: !!tenantId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("tenants")
        .select("stakeholder_cap")
        .eq("id", tenantId!)
        .maybeSingle();
      if (error) throw error;
      return data as { stakeholder_cap: number | null } | null;
    },
  });

  const maxStakeholders = tenantLimits?.stakeholder_cap ?? 5;
  const used = accounts.filter((a: any) =>
    ["sales_rep", "subcontractor", "vendor"].includes(a.account_type),
  ).length;
  const nearCap = used >= maxStakeholders;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-xs text-muted-foreground">Additional stakeholders</CardTitle>
      </CardHeader>
      <CardContent className="space-y-1.5">
        <div className="flex items-center justify-between text-xs">
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">Vendors, sales reps &amp; subcontractors</span>
            <Badge variant="outline" className={nearCap ? "border-amber-500/40 text-amber-700 bg-amber-500/10" : ""}>
              {used} / {maxStakeholders}
            </Badge>
          </div>
          <span className="text-[10px] text-muted-foreground italic">Fixed limit</span>
        </div>
      </CardContent>
    </Card>
  );
}




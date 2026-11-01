import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { Landmark, ShieldCheck, AlertTriangle, Info } from "lucide-react";
import { useTenantFilter } from "@/hooks/useTenantFilter";

/**
 * Maintenance-fee billing: pick which of your already-verified bank accounts
 * (added via Moov in the Bank Account panel) should be
 * debited monthly. No manual routing/account entry — ever.
 *
 * Writes go through the API route `save-tenant-billing-account`
 * (tenant-settings-handlers.mjs). tenant_billing_accounts is a money table: the
 * generic browser write path refuses it, and SQL 136 lets it be written only
 * by server handlers that set the money-write flag. The route re-checks that
 * the caller may manage the tenant, that the bank account is the tenant's own
 * and verified, and records who authorized ACH and when (server clock).
 */
const BILLING_ERRORS: Record<string, string> = {
  ach_authorization_required: "Tick the ACH authorization box to continue.",
  funding_source_not_found: "That bank account was not found for this company.",
  bank_not_verified: "That bank account is not verified yet.",
  bank_disconnected: "That bank account is disconnected. Reconnect it in the Bank Account section.",
  account_inactive: "That bank account is inactive.",
  missing_authorization: "Link a billing account first.",
  cross_tenant_denied: "That bank account belongs to another company.",
  billing_update_not_applied: "The change was not saved. Contact ChecksOps support.",
};

type StoredAuthorization = {
  id?: string;
  stakeholder_account_id?: string | null;
  ach_authorized_at?: string | null;
  auto_debit_enabled?: boolean;
  verification_status?: string | null;
};

/** The billing row exactly as the server stored it (the route's `authorization`), for the card's cache. */
function storedBilling(data: unknown) {
  const auth = data && typeof data === "object" ? (data as { authorization?: StoredAuthorization | null }).authorization : null;
  if (!auth || !auth.id) return null;
  return {
    id: auth.id,
    stakeholder_account_id: auth.stakeholder_account_id ?? null,
    ach_authorized_at: auth.ach_authorized_at ?? null,
    auto_debit_enabled: auth.auto_debit_enabled === true,
    verification_status: auth.verification_status ?? null,
  };
}

type BillingDiagnostic = Record<string, unknown>;

/**
 * A compact, phone-readable summary of the route's read-only diagnostic for a write the database did not
 * apply (billing_update_not_applied). Counts, yes/no, the role name and policy names only; no ids.
 */
export function billingDiagnosticCode(diagnostic: BillingDiagnostic | null | undefined): string {
  if (!diagnostic || typeof diagnostic !== "object") return "";
  const show = (value: unknown): string => {
    if (value === true) return "yes";
    if (value === false) return "no";
    if (value === null || value === undefined) return "-";
    if (typeof value === "object" && value && "error" in value) return `err${String((value as { error: unknown }).error)}`;
    return String(value);
  };
  const policies = Array.isArray(diagnostic.policies)
    ? (diagnostic.policies as Array<{ name?: unknown; permissive?: unknown; cmd?: unknown; roles?: unknown }>)
      .map((p) => `${String(p.name ?? "?")}/${String(p.cmd ?? "?")}/${String(p.permissive ?? "").toUpperCase() === "RESTRICTIVE" ? "restr" : "perm"}/${Array.isArray(p.roles) ? p.roles.join("+") : String(p.roles ?? "")}`)
      .join(", ")
    : show(diagnostic.policies);
  const parts = [
    `row:${show(diagnostic.row_visible)}`,
    `write:${show(diagnostic.can_write_tenant)}`,
    `member:${show(diagnostic.is_tenant_member)}`,
    `uid:${show(diagnostic.auth_uid_set)}`,
    `caller:${show(diagnostic.auth_uid_matches_caller)}`,
    `role:${show(diagnostic.current_user)}`,
    `rls:${show(diagnostic.rls_enabled)}/${show(diagnostic.rls_forced)}`,
  ];
  if ("returned_row" in diagnostic) {
    parts.push(`ret:${show(diagnostic.returned_row)}/${show(diagnostic.returned_auto_debit_enabled)}`);
  }
  parts.push(`policies:${policies || "none"}`);
  return parts.join(" ");
}

function billingErrorMessage(error: { message?: string } | null, data: unknown): string {
  const payload = data && typeof data === "object" ? data as { error?: string; message?: string; diagnostic?: BillingDiagnostic } : null;
  const code = payload?.error || "";
  const base = BILLING_ERRORS[code] || payload?.message || error?.message || "The billing account could not be saved.";
  if (code === "billing_update_not_applied") {
    const detail = billingDiagnosticCode(payload?.diagnostic);
    if (detail) return `${base} (${detail})`;
  }
  return base;
}

async function saveBillingAccount(body: Record<string, unknown>) {
  const { data, error } = await supabase.functions.invoke("save-tenant-billing-account", { body });
  if (error || (data && typeof data === "object" && (data as { ok?: boolean }).ok === false)) {
    throw new Error(billingErrorMessage(error, data));
  }
  return data;
}

export function TenantBillingAccountPanel() {
  const { tenantId } = useTenantFilter();
  const qc = useQueryClient();
  const [selectedId, setSelectedId] = useState<string>("");
  const [authorized, setAuthorized] = useState(false);

  // Currently-linked billing account
  const { data: billing, isLoading: loadingBilling } = useQuery({
    queryKey: ["tenant-billing-account", tenantId],
    enabled: !!tenantId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("tenant_billing_accounts")
        .select("id, stakeholder_account_id, ach_authorized_at, auto_debit_enabled, verification_status")
        .eq("tenant_id", tenantId!)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  // Verified bank accounts available to bill from
  const { data: accounts = [], isLoading: loadingAccounts } = useQuery({
    queryKey: ["tenant-verified-bank-accounts", tenantId],
    enabled: !!tenantId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("stakeholder_accounts")
        .select("id, nickname, chk_acct, acct_type, custname, verification_status, verified_at")
        .eq("tenant_id", tenantId!)
        .eq("is_active", true)
        .in("verification_status", ["verified", "admin_override"])
        .order("verified_at", { ascending: false, nullsFirst: false });
      if (error) throw error;
      return data ?? [];
    },
  });

  useEffect(() => {
    if (billing?.stakeholder_account_id) setSelectedId(billing.stakeholder_account_id);
  }, [billing?.stakeholder_account_id]);

  const linkedAccount = accounts.find((a: any) => a.id === billing?.stakeholder_account_id);

  const linkAccount = useMutation({
    mutationFn: async () => {
      if (!selectedId) throw new Error("Select a verified bank account");
      if (!authorized) throw new Error("You must authorize ACH debits");

      if (!accounts.some((a: any) => a.id === selectedId)) throw new Error("Account not found");
      return saveBillingAccount({
        action: "save",
        tenant_id: tenantId,
        stakeholder_account_id: selectedId,
        auto_debit_enabled: true,
        authorized: true,
      });
    },
    onSuccess: (data) => {
      const stored = storedBilling(data);
      if (stored) qc.setQueryData(["tenant-billing-account", tenantId], stored);
      toast.success("Billing account linked — auto-debit is on");
      setAuthorized(false);
      qc.invalidateQueries({ queryKey: ["tenant-billing-account", tenantId] });
    },
    onError: (e: any) => toast.error(e?.message ?? "Failed to link account", { duration: 30000 }),
  });

  const toggleAutoDebit = useMutation({
    mutationFn: async (enabled: boolean) => {
      return saveBillingAccount({ action: "toggle_auto_debit", tenant_id: tenantId, auto_debit_enabled: enabled });
    },
    onSuccess: (data) => {
      const stored = storedBilling(data);
      if (stored) qc.setQueryData(["tenant-billing-account", tenantId], stored);
      toast.success("Auto-debit preference updated");
      qc.invalidateQueries({ queryKey: ["tenant-billing-account", tenantId] });
    },
    onError: (e: Error) => {
      toast.error(e?.message ?? "Failed to update auto-debit", { duration: 30000 });
      qc.invalidateQueries({ queryKey: ["tenant-billing-account", tenantId] });
    },
  });

  const isLoading = loadingBilling || loadingAccounts;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Landmark className="h-4 w-4" />
          Monthly fee auto-billing
        </CardTitle>
        <CardDescription>
          Choose which of your verified bank accounts ChecksOps should debit each month for <strong>maintenance fees, check processing fees, and payment processing fees</strong>. All bank accounts are added through the secure bank login in the Bank Account section — no manual entry.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <div className="text-xs text-muted-foreground">Loading…</div>
        ) : accounts.length === 0 ? (
          <Alert>
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription className="text-xs">
              You don't have any verified bank accounts yet. Add one in the <strong>Bank Account</strong> section using bank sign-in (Moov), then return here to enable auto-billing.
            </AlertDescription>
          </Alert>
        ) : (
          <>
            {linkedAccount && (
              <div className="flex items-center justify-between p-3 border rounded-md bg-muted/30">
                <div>
                  <div className="text-sm font-medium">{linkedAccount.nickname}</div>
                  <div className="text-xs text-muted-foreground">
                    {linkedAccount.custname} · {linkedAccount.acct_type === "C" ? "Checking" : "Savings"} · {linkedAccount.chk_acct ? `••••${linkedAccount.chk_acct.slice(-4)}` : "Account pending"}
                  </div>
                </div>
                <div className="flex flex-col items-end gap-1">
                  <Badge variant="default" className="text-[10px]">
                    <ShieldCheck className="h-3 w-3 mr-1" />
                    Verified via Moov
                  </Badge>
                  {billing?.ach_authorized_at && (
                    <span className="text-[10px] text-muted-foreground">
                      ACH authorized {new Date(billing.ach_authorized_at).toLocaleDateString()}
                    </span>
                  )}
                </div>
              </div>
            )}

            {linkedAccount && (
              <div className="flex items-center gap-2 pt-2 border-t">
                <Checkbox
                  id="auto-debit"
                  checked={!!billing?.auto_debit_enabled}
                  onCheckedChange={(c) => toggleAutoDebit.mutate(!!c)}
                />
                <Label htmlFor="auto-debit" className="text-xs cursor-pointer">
                  Enable monthly auto-debit (maintenance + check processing + payment processing)
                </Label>
              </div>
            )}

            <div className="space-y-3 p-3 border rounded-md">
              <div className="text-xs font-medium">
                {linkedAccount ? "Change billing account" : "Link a billing account"}
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Choose a verified bank account</Label>
                <Select value={selectedId} onValueChange={setSelectedId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select an account…" />
                  </SelectTrigger>
                  <SelectContent>
                    {accounts.map((a: any) => (
                      <SelectItem key={a.id} value={a.id}>
                        {a.nickname} · {a.chk_acct ? `••••${a.chk_acct.slice(-4)}` : "Account pending"} · {a.custname}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="flex items-start gap-2 p-2 bg-muted/40 rounded">
                <Checkbox
                  id="ach-auth"
                  checked={authorized}
                  onCheckedChange={(c) => setAuthorized(!!c)}
                  className="mt-0.5"
                />
                <Label htmlFor="ach-auth" className="text-xs leading-snug cursor-pointer">
                  I authorize ChecksOps to initiate monthly ACH debits from the selected account for <strong>maintenance fees, check processing fees, and payment processing fees</strong>, until I revoke this authorization in writing. Amounts may vary based on monthly usage and any referral discounts applied.
                </Label>
              </div>

              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                  <Info className="h-3 w-3" />
                  Add more accounts in the Bank Account panel above.
                </div>
                <Button
                  size="sm"
                  onClick={() => linkAccount.mutate()}
                  disabled={linkAccount.isPending || !selectedId || !authorized}
                >
                  {linkedAccount ? "Replace" : "Link account"}
                </Button>
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

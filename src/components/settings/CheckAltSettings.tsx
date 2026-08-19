import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { usePermissions } from "@/hooks/usePermissions";
import { useTenant } from "@/contexts/TenantContext";
import { Loader2, Banknote, ShieldCheck, AlertTriangle, RefreshCw, UserPlus, UserCheck, Landmark } from "lucide-react";
import { SectionCard } from "./SectionCard";
import { SettingsHero } from "./SettingsHero";

/**
 * Admin-only configuration panel for the CheckAlt (FinCapture) RDC integration.
 * Single ChecksOps-wide account model:
 *   - Username/password live in backend secrets (CHECKALT_USERNAME / CHECKALT_PASSWORD)
 *   - Per-deployment values (base URL, depositor account, business unit, enable flag) live here
 */
export function CheckAltSettings() {
  const { isAdmin } = usePermissions();
  const { tenant } = useTenant();
  const { toast } = useToast();
  const qc = useQueryClient();

  const { data: cfg, isLoading } = useQuery({
    queryKey: ["checkalt-config"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("checkalt_config")
        .select("*")
        .eq("singleton", true)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
    enabled: isAdmin,
  });

  const [form, setForm] = useState({
    base_url: "",
    merchant: "",
    fi_key: "",
    business_unit: "",
    depositor_account_id: "",
    default_enabled: false,
    auto_approve_enabled: false,
    auto_approve_max_dollars: "",
    notes: "",
  });

  useEffect(() => {
    if (cfg) {
      setForm({
        base_url: cfg.base_url ?? "",
        merchant: cfg.merchant ?? "",
        fi_key: cfg.fi_key ?? "",
        business_unit: cfg.business_unit ?? "",
        depositor_account_id: cfg.depositor_account_id ?? "",
        default_enabled: !!cfg.default_enabled,
        auto_approve_enabled: !!(cfg as any).auto_approve_enabled,
        auto_approve_max_dollars:
          (cfg as any).auto_approve_max_cents != null
            ? String(((cfg as any).auto_approve_max_cents as number) / 100)
            : "",
        notes: cfg.notes ?? "",
      });
    }
  }, [cfg]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const maxDollars = form.auto_approve_max_dollars.trim();
      const maxCents = maxDollars ? Math.round(parseFloat(maxDollars) * 100) : null;
      const { error } = await supabase
        .from("checkalt_config")
        .update({
          base_url: form.base_url.trim() || null,
          merchant: form.merchant.trim() || null,
          fi_key: form.fi_key.trim() || null,
          business_unit: form.business_unit.trim() || null,
          depositor_account_id: form.depositor_account_id.trim() || null,
          default_enabled: form.default_enabled,
          auto_approve_enabled: form.auto_approve_enabled,
          auto_approve_max_cents: Number.isFinite(maxCents as number) ? maxCents : null,
          notes: form.notes.trim() || null,
        } as any)
        .eq("singleton", true);
      if (error) throw error;
    },
    onSuccess: () => {
      toast({ title: "CheckAlt settings saved" });
      qc.invalidateQueries({ queryKey: ["checkalt-config"] });
    },
    onError: (e: unknown) => {
      toast({
        title: "Save failed",
        description: e instanceof Error ? e.message : "Unknown error",
        variant: "destructive",
      });
    },
  });

  const pollMutation = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke("checkalt-poll-status");
      if (error) throw error;
      return data as { polled: number; updated: number; errors: number };
    },
    onSuccess: (data) => {
      toast({
        title: "Reconciliation complete",
        description: `Polled ${data.polled}, updated ${data.updated}, errors ${data.errors}`,
      });
    },
    onError: (e: unknown) => {
      toast({
        title: "Poll failed",
        description: e instanceof Error ? e.message : "Unknown error",
        variant: "destructive",
      });
    },
  });

  const testMutation = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke("checkalt-test-connection");
      if (error) throw error;
      if (data && data.success === false) throw new Error(data.error || "Test failed");
      return data as { success: boolean; message: string; token_preview?: string };
    },
    onSuccess: (data) => {
      toast({
        title: "Connection successful",
        description: data.message + (data.token_preview ? ` (token ${data.token_preview})` : ""),
      });
    },
    onError: (e: unknown) => {
      toast({
        title: "Connection test failed",
        description: e instanceof Error ? e.message : "Unknown error",
        variant: "destructive",
      });
    },
  });

  // ---- Tenant account registration ----
  const { data: regAccount, isLoading: regLoading } = useQuery({
    queryKey: ["checkalt-tenant-account", tenant?.id],
    enabled: isAdmin && !!tenant?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("checkalt_tenant_accounts")
        .select("sso_user_id, deposit_account_number, first_name, last_name, email, enabled, registered_at, last_register_payload")
        .eq("tenant_id", tenant!.id)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  const [reg, setReg] = useState({
    sso_user_id: "",
    first_name: "",
    last_name: "",
    email: "",
    deposit_account_number: "",
  });

  useEffect(() => {
    if (regAccount) {
      setReg({
        sso_user_id: regAccount.sso_user_id ?? "",
        first_name: regAccount.first_name ?? "",
        last_name: regAccount.last_name ?? "",
        email: regAccount.email ?? "",
        deposit_account_number: regAccount.deposit_account_number ?? "",
      });
    } else if (cfg?.depositor_account_id) {
      setReg((r) => ({ ...r, deposit_account_number: r.deposit_account_number || cfg.depositor_account_id! }));
    }
  }, [regAccount, cfg]);

  const registerMutation = useMutation({
    mutationFn: async () => {
      if (!tenant?.id) throw new Error("No tenant in context");
      const { data, error } = await supabase.functions.invoke("checkalt-register-account", {
        body: { tenant_id: tenant.id, ...reg },
      });
      if (error) {
        let msg = error.message ?? "Registration failed";
        try { const b = await (error as any).context?.json?.(); if (b?.error) msg = typeof b.error === "string" ? b.error : JSON.stringify(b.error); } catch {}
        throw new Error(msg);
      }
      if ((data as any)?.error) throw new Error((data as any).error);
      return data;
    },
    onSuccess: () => {
      toast({ title: "Account registered with CheckAlt" });
      qc.invalidateQueries({ queryKey: ["checkalt-tenant-account"] });
    },
    onError: (e: unknown) =>
      toast({
        title: "Registration failed",
        description: e instanceof Error ? e.message : "Unknown error",
        variant: "destructive",
      }),
  });

  const [verifyResult, setVerifyResult] = useState<{ action: string; payload: unknown } | null>(null);

  const verifyMutation = useMutation({
    mutationFn: async (action: "user" | "account") => {
      if (!tenant?.id) throw new Error("No tenant in context");
      const { data, error } = await supabase.functions.invoke("checkalt-verify-account", {
        body: { tenant_id: tenant.id, action },
      });
      if (error) throw new Error(error.message ?? "Verification failed");
      if ((data as any)?.success === false) {
        // Keep the raw CheckAlt response visible so we can see what the vendor said.
        setVerifyResult({ action, payload: (data as any).details ?? data });
        throw new Error((data as any).error || "Verification failed");
      }
      return { action, payload: (data as any)?.data };
    },
    onSuccess: ({ action, payload }) => {
      setVerifyResult({ action, payload });
      toast({
        title: action === "user" ? "User verified" : "Deposit account verified",
        description: "CheckAlt returned a valid response. See payload below.",
      });
    },
    onError: (e: unknown) =>
      toast({
        title: "Verification failed",
        description: e instanceof Error ? e.message : "Unknown error",
        variant: "destructive",
      }),
  });




  if (!isAdmin) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          CheckAlt settings are restricted to administrators.
        </CardContent>
      </Card>
    );
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const fullyConfigured =
    !!form.base_url && !!form.merchant && !!form.fi_key && !!form.depositor_account_id && form.default_enabled;

  return (
    <div className="space-y-6">
      <SettingsHero
        title="CheckAlt RDC Integration"
        description="Configure Remote Deposit Capture to automate check processing and deposits."
        badge="Banking Infrastructure"
        icon={<Landmark className="h-4 w-4 text-primary" />}
      />

      <SectionCard
        title="CheckAlt (FinCapture) Integration"
        icon={<Banknote className="h-4 w-4 text-emerald-500" />}
        accent="bg-gradient-to-r from-emerald-500/60 to-emerald-500/10"
        description="Remote Deposit Capture rail. When enabled, eligible checks can be deposited directly through CheckAlt."
        headerActions={
          <Badge variant={fullyConfigured ? "default" : "outline"} className={fullyConfigured ? "bg-emerald-600" : ""}>
            {fullyConfigured ? (
              <span className="flex items-center gap-1"><ShieldCheck className="h-3 w-3" /> Live</span>
            ) : (
              <span className="flex items-center gap-1"><AlertTriangle className="h-3 w-3" /> Not active</span>
            )}
          </Badge>
        }
      >
        <div className="space-y-6 pt-4">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="base_url">Base URL</Label>
              <Input
                id="base_url"
                placeholder="https://uatapi.checkalt.com"
                value={form.base_url}
                onChange={(e) => setForm({ ...form, base_url: e.target.value })}
              />
              <p className="text-xs text-muted-foreground">
                UAT: https://uatapi.checkalt.com &middot; Prod: provided by CheckAlt
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="merchant">Merchant</Label>
              <Input
                id="merchant"
                placeholder="e.g. lockbox5"
                value={form.merchant}
                onChange={(e) => setForm({ ...form, merchant: e.target.value })}
              />
              <p className="text-xs text-muted-foreground">
                Required header for Cloudflare WAF. Assigned by CheckAlt.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="fi_key">FI Key</Label>
              <Input
                id="fi_key"
                placeholder="e.g. 40E28855-35FA-45C3-..."
                value={form.fi_key}
                onChange={(e) => setForm({ ...form, fi_key: e.target.value })}
              />
              <p className="text-xs text-muted-foreground">
                Financial Institution identifier (UUID). Required for deposits.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="business_unit">Business Unit</Label>
              <Input
                id="business_unit"
                placeholder="e.g. CHECKSOPS_PROD"
                value={form.business_unit}
                onChange={(e) => setForm({ ...form, business_unit: e.target.value })}
              />
            </div>
            <div className="space-y-1.5 md:col-span-2">
              <Label htmlFor="depositor_account_id">Deposit Account Number</Label>
              <Input
                id="depositor_account_id"
                placeholder="Bank account number for deposits"
                value={form.depositor_account_id}
                onChange={(e) => setForm({ ...form, depositor_account_id: e.target.value })}
              />
              <p className="text-xs text-muted-foreground">
                The bank account where deposits are credited. Maps to depositAccountNumber in the API.
              </p>
            </div>
          </div>

          <div className="flex items-start gap-3 rounded-md border border-border/60 bg-muted/30 p-3">
            <Switch
              id="default_enabled"
              checked={form.default_enabled}
              onCheckedChange={(v) => setForm({ ...form, default_enabled: v })}
            />
            <div className="space-y-1">
              <Label htmlFor="default_enabled" className="cursor-pointer">
                Enable CheckAlt deposits
              </Label>
              <p className="text-xs text-muted-foreground">
                When off, the platform behaves exactly as today (branch deposit only).
                When on, the Ready-for-Deposit flow exposes a "Send to CheckAlt" option.
              </p>
            </div>
          </div>

          <div className="space-y-3 rounded-md border border-border/60 bg-muted/30 p-3">
            <div className="flex items-start gap-3">
              <Switch
                id="auto_approve_enabled"
                checked={form.auto_approve_enabled}
                onCheckedChange={(v) => setForm({ ...form, auto_approve_enabled: v })}
                disabled={!form.default_enabled}
              />
              <div className="space-y-1">
                <Label htmlFor="auto_approve_enabled" className="cursor-pointer">
                  Auto-approve clean deposits
                </Label>
                <p className="text-xs text-muted-foreground">
                  When on, deposits CheckAlt parks in pending approval are approved
                  automatically. Any deposit CheckAlt flags (duplicate MICR, amount
                  mismatch, poor image quality, risk warning, exception, hold) is
                  always skipped and left for manual review.
                </p>
              </div>
            </div>

            {form.auto_approve_enabled && (
              <div className="space-y-1.5 pl-11">
                <Label htmlFor="auto_approve_max_dollars">Auto-approve ceiling (USD, optional)</Label>
                <Input
                  id="auto_approve_max_dollars"
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="e.g. 10000 — leave blank for no limit"
                  value={form.auto_approve_max_dollars}
                  onChange={(e) =>
                    setForm({ ...form, auto_approve_max_dollars: e.target.value })
                  }
                />
                <p className="text-xs text-muted-foreground">
                  Deposits over this amount still require a human to approve.
                </p>
              </div>
            )}
          </div>


          <div className="space-y-1.5">
            <Label htmlFor="notes">Internal notes</Label>
            <Textarea
              id="notes"
              rows={2}
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
              placeholder="Any internal context (account contact, rollout plan, etc.)"
            />
          </div>

          <div className="flex items-center justify-end gap-2 pt-2">
            <Button
              variant="outline"
              onClick={() => testMutation.mutate()}
              disabled={testMutation.isPending}
            >
              {testMutation.isPending
                ? <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                : <ShieldCheck className="h-4 w-4 mr-1" />}
              Test connection
            </Button>

            <Button
              variant="outline"
              onClick={() => pollMutation.mutate()}
              disabled={pollMutation.isPending || !fullyConfigured}
            >
              {pollMutation.isPending
                ? <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                : <RefreshCw className="h-4 w-4 mr-1" />}
              Reconcile pending deposits
            </Button>
            <Button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending}>
              {saveMutation.isPending && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
              Save settings
            </Button>
          </div>
        </div>
      </SectionCard>

      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2 text-sm">
                <UserPlus className="h-4 w-4 text-primary" />
                Register Tenant Account with CheckAlt
              </CardTitle>
              <CardDescription>
                Posts <code>fiKey, userId, firstName, lastName, emailAddress, isSSORequest, accountDataList[].accountNumber</code> to
                <code className="ml-1">/fincapture/useraccount/register</code>. The <code>userId</code> becomes the
                <code className="ml-1">ssoKey</code> used on every deposit submitted for this tenant.
              </CardDescription>
            </div>
            {regAccount?.registered_at ? (
              <Badge variant="default" className="shrink-0">
                <ShieldCheck className="h-3 w-3 mr-1" /> Registered
              </Badge>
            ) : (
              <Badge variant="outline" className="shrink-0">
                <AlertTriangle className="h-3 w-3 mr-1" /> Not registered
              </Badge>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {regLoading ? (
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          ) : (
            <>
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="sso_user_id">User ID (ssoKey)</Label>
                  <Input
                    id="sso_user_id"
                    placeholder="e.g. mcarletta"
                    value={reg.sso_user_id}
                    onChange={(e) => setReg({ ...reg, sso_user_id: e.target.value })}
                  />
                  <p className="text-xs text-muted-foreground">
                    Unique identifier for this depositor. Becomes the <code>ssoKey</code> on all deposits.
                  </p>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="reg_email">Email address</Label>
                  <Input
                    id="reg_email"
                    type="email"
                    placeholder="user@company.com"
                    value={reg.email}
                    onChange={(e) => setReg({ ...reg, email: e.target.value })}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="reg_first">First name</Label>
                  <Input
                    id="reg_first"
                    value={reg.first_name}
                    onChange={(e) => setReg({ ...reg, first_name: e.target.value })}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="reg_last">Last name</Label>
                  <Input
                    id="reg_last"
                    value={reg.last_name}
                    onChange={(e) => setReg({ ...reg, last_name: e.target.value })}
                  />
                </div>
                <div className="space-y-1.5 md:col-span-2">
                  <Label htmlFor="reg_acct">Deposit account number</Label>
                  <Input
                    id="reg_acct"
                    placeholder="Bank account number"
                    value={reg.deposit_account_number}
                    onChange={(e) => setReg({ ...reg, deposit_account_number: e.target.value })}
                  />
                  <p className="text-xs text-muted-foreground">
                    Defaults to the deposit account number from the integration config above.
                  </p>
                </div>
              </div>

              {regAccount?.last_register_payload ? (
                <div className="rounded-md border border-border/60 bg-muted/30 p-3">
                  <p className="text-xs font-medium mb-1">Last CheckAlt response</p>
                  <pre className="text-[11px] overflow-x-auto whitespace-pre-wrap break-all text-muted-foreground">
                    {JSON.stringify(regAccount.last_register_payload, null, 2)}
                  </pre>
                </div>
              ) : null}

              {verifyResult ? (
                <div className="rounded-md border border-border/60 bg-muted/30 p-3">
                  <p className="text-xs font-medium mb-1">
                    Verify {verifyResult.action === "user" ? "user" : "deposit account"} response
                  </p>
                  <pre className="text-[11px] overflow-x-auto whitespace-pre-wrap break-all text-muted-foreground">
                    {JSON.stringify(verifyResult.payload, null, 2)}
                  </pre>
                </div>
              ) : null}

              <div className="flex flex-wrap items-center justify-end gap-2">
                <Button
                  variant="outline"
                  onClick={() => verifyMutation.mutate("user")}
                  disabled={verifyMutation.isPending || !regAccount?.registered_at}
                >
                  {verifyMutation.isPending && verifyMutation.variables === "user"
                    ? <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                    : <UserCheck className="h-4 w-4 mr-1" />}
                  Verify user
                </Button>
                <Button
                  onClick={() => registerMutation.mutate()}
                  disabled={
                    registerMutation.isPending ||
                    !reg.sso_user_id ||
                    !reg.first_name ||
                    !reg.last_name ||
                    !reg.email ||
                    !reg.deposit_account_number ||
                    !tenant?.id
                  }
                >
                  {registerMutation.isPending
                    ? <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                    : <UserPlus className="h-4 w-4 mr-1" />}
                  {regAccount?.registered_at ? "Re-register account" : "Register account"}
                </Button>
              </div>

            </>
          )}
        </CardContent>
      </Card>



      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Required backend secrets</CardTitle>
          <CardDescription>
            These are stored securely and only available to the CheckAlt backend functions.
            CheckAlt does not require a webhook — status is pulled via the reconcile action above.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-xs">
          <div className="flex items-center justify-between rounded-md border border-border/60 px-3 py-2">
            <code>CHECKALT_USERNAME</code>
            <span className="text-muted-foreground">FinCapture API user</span>
          </div>
          <div className="flex items-center justify-between rounded-md border border-border/60 px-3 py-2">
            <code>CHECKALT_PASSWORD</code>
            <span className="text-muted-foreground">FinCapture API password</span>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * Manager-side queue showing CheckAlt deposits parked at FinCapture for manual
 * review (status 40 / pending_approval). Approve/Reject calls the
 * `checkalt-approve-deposit` edge function which hits
 * `/fincapture/deposit/approve` upstream.
 */
export function PendingApprovalDeposits() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectNotes, setRejectNotes] = useState("");

  const { data, isLoading, refetch } = useQuery({
    queryKey: ["checkalt-pending-approvals"],
    queryFn: async () => {
      // Two queries instead of an embedded check_intake_items(...) select —
      // an embed that can't resolve (RLS, a deleted/inaccessible row) risks
      // silently dropping the parent checkalt_deposits row depending on how
      // PostgREST infers the join, which would hide a genuinely pending
      // deposit with no error and no indication why. Fetching separately
      // guarantees every pending_approval row always renders.
      const { data, error } = await supabase
        .from("checkalt_deposits")
        .select(
          "id, amount, checkalt_reference, submitted_at, last_status_payload, status_unresolved, check_intake_item_id",
        )
        .eq("status", "pending_approval")
        .order("submitted_at", { ascending: false, nullsFirst: false })
        .limit(50);
      if (error) throw error;
      const rows = data ?? [];

      const intakeIds = [...new Set(rows.map((r) => r.check_intake_item_id).filter(Boolean))];
      let intakeById = new Map<string, any>();
      if (intakeIds.length > 0) {
        const { data: intakeRows, error: intakeErr } = await supabase
          .from("check_intake_items")
          .select("id, check_number, carrier_name, payee_line, freedom_claim_number, detected_claim_number")
          .in("id", intakeIds as string[]);
        if (intakeErr) throw intakeErr;
        intakeById = new Map((intakeRows ?? []).map((r) => [r.id, r]));
      }

      return rows.map((r) => ({
        ...r,
        check_intake_items: r.check_intake_item_id ? intakeById.get(r.check_intake_item_id) ?? null : null,
      }));
    },
    refetchInterval: 30_000,
  });

  const decide = useMutation({
    mutationFn: async (args: {
      deposit_id: string;
      action: "approve" | "reject";
      reject_notes?: string;
    }) => {
      const { data, error } = await supabase.functions.invoke(
        "checkalt-approve-deposit",
        { body: args },
      );
      if (error) throw error;
      if ((data as any)?.error) throw new Error((data as any).error);
      return data;
    },
    onSuccess: (data: any) => {
      const wasRejected = data?.status === "rejected";
      toast({
        title: wasRejected ? "Deposit rejected by CheckAlt" : "Deposit approved",
        description:
          data?.status_description
            ? `${data.status_description}${data?.api_status ? ` (code ${data.api_status})` : ""}`
            : `Status: ${data?.status}`,
        variant: wasRejected ? "destructive" : "default",
      });
      setRejectingId(null);
      setRejectNotes("");
      qc.invalidateQueries({ queryKey: ["checkalt-pending-approvals"] });
      qc.invalidateQueries({ queryKey: ["check-intake-items"] });
      qc.invalidateQueries({ queryKey: ["deposit-items"] });
    },
    onError: (e: unknown) => {
      toast({
        title: "Approval call failed",
        description: e instanceof Error ? e.message : "Unknown error",
        variant: "destructive",
      });
    },
  });

  // Bulk "Poll Now" — reconciles every checkalt_deposits row sitting in
  // submitted/pending_approval against CheckAlt's real status right here in
  // the operational queue, instead of only via the admin Settings panel or
  // waiting up to 10 minutes for the cron.
  const poll = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke("checkalt-poll-status");
      if (error) throw error;
      if ((data as any)?.error) throw new Error((data as any).error);
      return data as { polled: number; updated: number; errors: number };
    },
    onSuccess: (data) => {
      toast({
        title: "Reconciled with CheckAlt",
        description: `Checked ${data.polled}, updated ${data.updated}${data.errors ? `, ${data.errors} error(s)` : ""}`,
      });
      qc.invalidateQueries({ queryKey: ["checkalt-pending-approvals"] });
      qc.invalidateQueries({ queryKey: ["check-intake-items"] });
      qc.invalidateQueries({ queryKey: ["deposit-items"] });
    },
    onError: (e: unknown) => {
      toast({
        title: "Poll failed",
        description: e instanceof Error ? e.message : "Unknown error",
        variant: "destructive",
      });
    },
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-6">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (!data || data.length === 0) {
    return (
      <div className="flex items-center justify-between rounded-md border border-dashed border-border/60 px-3 py-3">
        <p className="text-xs text-muted-foreground">
          No CheckAlt deposits awaiting approval.
        </p>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" onClick={() => poll.mutate()} disabled={poll.isPending}>
            {poll.isPending
              ? <Loader2 className="h-3 w-3 mr-1 animate-spin" />
              : <RefreshCw className="h-3 w-3 mr-1" />}
            Poll Now
          </Button>
          <Button size="sm" variant="ghost" onClick={() => refetch()}>
            Refresh
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-end">
        <Button size="sm" variant="outline" onClick={() => poll.mutate()} disabled={poll.isPending}>
          {poll.isPending
            ? <Loader2 className="h-3 w-3 mr-1 animate-spin" />
            : <RefreshCw className="h-3 w-3 mr-1" />}
          Poll Now
        </Button>
      </div>
      {data.map((row: any) => {
        const intake = row.check_intake_items;
        const statusDesc = row.last_status_payload?.statusDescription ?? row.last_status_payload?.reasonDescription;
        const isRejecting = rejectingId === row.id;
        return (
          <div
            key={row.id}
            className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-sm space-y-2"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="font-medium truncate">
                  {intake?.carrier_name ?? "Check"} → {intake?.payee_line ?? "—"}
                </div>
                <div className="text-xs text-muted-foreground">
                  Check #{intake?.check_number ?? "—"} ·{" "}
                  {(intake?.freedom_claim_number || intake?.detected_claim_number)
                    ? `Claim ${intake.freedom_claim_number || intake.detected_claim_number} · `
                    : ""}
                  Ref {row.checkalt_reference ?? "pending"} · $
                  {Number(row.amount ?? 0).toLocaleString(undefined, {
                    minimumFractionDigits: 2,
                  })}
                </div>
                {statusDesc && (
                  <div className="text-xs text-amber-300 mt-1">
                    CheckAlt: {statusDesc}
                  </div>
                )}
                {row.status_unresolved && (
                  <div className="text-xs text-destructive mt-1 flex items-center gap-1">
                    <AlertTriangle className="h-3 w-3" />
                    Last poll couldn't read a status from CheckAlt — this row may be stale
                  </div>
                )}
              </div>
              {!isRejecting && (
                <div className="flex items-center gap-2 shrink-0">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setRejectingId(row.id)}
                    disabled={decide.isPending}
                  >
                    Reject
                  </Button>
                  <Button
                    size="sm"
                    onClick={() =>
                      decide.mutate({ deposit_id: row.id, action: "approve" })
                    }
                    disabled={decide.isPending}
                  >
                    {decide.isPending ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      "Approve"
                    )}
                  </Button>
                </div>
              )}
            </div>
            {isRejecting && (
              <div className="space-y-2 border-t border-border/40 pt-2">
                <Label className="text-xs">Reject reason (optional)</Label>
                <Input
                  value={rejectNotes}
                  onChange={(e) => setRejectNotes(e.target.value)}
                  placeholder="Notes shown to CheckAlt"
                  maxLength={1000}
                />
                <div className="flex justify-end gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setRejectingId(null);
                      setRejectNotes("");
                    }}
                    disabled={decide.isPending}
                  >
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() =>
                      decide.mutate({
                        deposit_id: row.id,
                        action: "reject",
                        reject_notes: rejectNotes || undefined,
                      })
                    }
                    disabled={decide.isPending}
                  >
                    {decide.isPending ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      "Confirm reject"
                    )}
                  </Button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Manager view: CheckAlt deposit history pulled live from
 * POST /fincapture/deposit/history (via the `checkalt-deposit-history` edge function).
 * Defaults to the last 30 days; user can adjust date range.
 */
export function CheckAltDepositHistory() {
  const { toast } = useToast();
  const today = new Date().toISOString().slice(0, 10);
  const thirtyAgo = new Date(Date.now() - 30 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const [startDate, setStartDate] = useState(thirtyAgo);
  const [endDate, setEndDate] = useState(today);

  const { data, isFetching, refetch, error } = useQuery({
    queryKey: ["checkalt-deposit-history", startDate, endDate],
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke(
        "checkalt-deposit-history",
        { body: { start_date: startDate, end_date: endDate } },
      );
      if (error) throw error;
      if ((data as any)?.error) throw new Error((data as any).error);
      return data as { items: any[]; count: number };
    },
    staleTime: 60_000,
  });

  const items = data?.items ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Banknote className="h-4 w-4" /> CheckAlt Deposit History
        </CardTitle>
        <CardDescription>
          Live history from FinCapture (/fincapture/deposit/history). Adjust the date
          range and refresh to query CheckAlt directly.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label className="text-xs">Start date</Label>
            <Input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="h-8 w-[150px]"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">End date</Label>
            <Input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              className="h-8 w-[150px]"
            />
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => refetch()}
            disabled={isFetching}
            className="gap-1"
          >
            {isFetching ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <RefreshCw className="h-3 w-3" />
            )}
            Refresh
          </Button>
          <div className="ml-auto text-xs text-muted-foreground">
            {data ? `${data.count} record${data.count === 1 ? "" : "s"}` : ""}
          </div>
        </div>

        {error && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error instanceof Error ? error.message : "Failed to load history"}
          </div>
        )}

        {isFetching && !data && (
          <div className="flex items-center justify-center py-6">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        )}

        {!isFetching && items.length === 0 && !error && (
          <div className="rounded-md border border-dashed border-border/60 px-3 py-4 text-center text-xs text-muted-foreground">
            No deposits found for this range.
          </div>
        )}

        {items.length > 0 && (
          <div className="overflow-x-auto rounded-md border border-border/40">
            <table className="w-full text-xs">
              <thead className="bg-muted/40 text-muted-foreground">
                <tr className="text-left">
                  <th className="px-3 py-2 font-medium">Submitted</th>
                  <th className="px-3 py-2 font-medium">Reference</th>
                  <th className="px-3 py-2 font-medium">Check #</th>
                  <th className="px-3 py-2 font-medium">Payer</th>
                  <th className="px-3 py-2 font-medium text-right">Amount</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {items.map((it: any, idx: number) => {
                  const amount = Number(
                    it.amount ?? it.depositAmount ?? it.checkAmount ?? 0,
                  );
                  // CheckAlt's FinCapture API sends/returns amounts as whole
                  // cents, not decimal dollars (confirmed directly by
                  // CheckAlt support, and confirmed here — a $780.00 check's
                  // history entry came back as depositAmount: 78000). The
                  // previous "only convert if > $100,000" heuristic missed
                  // this because 78000 cents doesn't clear that threshold,
                  // displaying it as $78,000.00 instead of $780.00.
                  const displayAmount = amount / 100;
                  const submitted =
                    it.submittedDate ??
                    it.depositDate ??
                    it.createdDate ??
                    it.submitted_at ??
                    "—";
                  return (
                    <tr
                      key={
                        it.referenceNumber ??
                        it.reference ??
                        it.depositItemId ??
                        idx
                      }
                      className="border-t border-border/30"
                    >
                      <td className="px-3 py-2 whitespace-nowrap">
                        {typeof submitted === "string"
                          ? submitted.slice(0, 19).replace("T", " ")
                          : "—"}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap font-mono">
                        {it.referenceNumber ?? it.reference ?? "—"}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        {it.checkNumber ?? it.serialNumber ?? "—"}
                      </td>
                      <td className="px-3 py-2 truncate max-w-[200px]">
                        {it.payerName ?? it.makerName ?? it.payor ?? "—"}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap text-right">
                        $
                        {displayAmount.toLocaleString(undefined, {
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 2,
                        })}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        <Badge variant="outline" className="text-[10px]">
                          {it.statusDescription ??
                            it.status ??
                            it.statusCode ??
                            "—"}
                        </Badge>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}


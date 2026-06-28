import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { usePermissions } from "@/hooks/usePermissions";
import { useTenant } from "@/contexts/TenantContext";
import { Loader2, Banknote, ShieldCheck, AlertTriangle, RefreshCw, Check, X, UserPlus } from "lucide-react";

interface PendingApprovalDeposit {
  id: string;
  amount: number | null;
  checkalt_reference: string | null;
  created_at: string;
  check_intake_item_id: string | null;
  check_intake_items: { check_number: string | null; carrier_name: string | null } | null;
}

/**
 * Lists CheckAlt deposits parked in manual review (status 40 / pending_approval)
 * and lets an admin approve or reject them via the deposit/approve endpoint.
 */
export function PendingApprovalDeposits() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectNotes, setRejectNotes] = useState("");

  const { data: deposits = [], isLoading } = useQuery({
    queryKey: ["checkalt-pending-approval-deposits"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("checkalt_deposits")
        .select("id, amount, checkalt_reference, created_at, check_intake_item_id, check_intake_items(check_number, carrier_name)")
        .eq("status", "pending_approval")
        .order("created_at", { ascending: true });
      if (error) throw error;
      return (data ?? []) as unknown as PendingApprovalDeposit[];
    },
    refetchInterval: 30_000,
  });

  const decisionMutation = useMutation({
    mutationFn: async (vars: { deposit_id: string; action: "approve" | "reject"; reject_notes?: string }) => {
      const { data, error } = await supabase.functions.invoke("checkalt-approve-deposit", {
        body: vars,
      });
      if (error) throw error;
      return data as { status: string };
    },
    onSuccess: (data, vars) => {
      toast({
        title: vars.action === "approve" ? "Deposit approved" : "Deposit rejected",
        description: `New status: ${data.status}`,
      });
      setRejectingId(null);
      setRejectNotes("");
      qc.invalidateQueries({ queryKey: ["checkalt-pending-approval-deposits"] });
    },
    onError: (e: unknown) => {
      toast({
        title: "Action failed",
        description: e instanceof Error ? e.message : "Unknown error",
        variant: "destructive",
      });
    },
  });

  const [refreshingId, setRefreshingId] = useState<string | null>(null);

  const refreshMutation = useMutation({
    mutationFn: async (depositId: string) => {
      setRefreshingId(depositId);
      const { data, error } = await supabase.functions.invoke("checkalt-account-status", {
        body: { action: "deposit_item", deposit_id: depositId },
      });
      if (error) throw error;
      return data as { ok: boolean; status: number; json: any };
    },
    onSuccess: (data) => {
      toast({
        title: data.ok ? "Status refreshed" : "Refresh returned an error",
        description: data.ok
          ? "Latest status pulled from FinCapture."
          : `FinCapture responded with HTTP ${data.status}.`,
        variant: data.ok ? "default" : "destructive",
      });
      qc.invalidateQueries({ queryKey: ["checkalt-pending-approval-deposits"] });
    },
    onError: (e: unknown) => {
      toast({
        title: "Refresh failed",
        description: e instanceof Error ? e.message : "Unknown error",
        variant: "destructive",
      });
    },
    onSettled: () => setRefreshingId(null),
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-6">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (deposits.length === 0) {
    return (
      <p className="py-4 text-center text-xs text-muted-foreground">
        No deposits awaiting manual review.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {deposits.map((dep) => (
        <div key={dep.id} className="rounded-md border border-border/60 p-3 space-y-2">
          <div className="flex items-center justify-between gap-3">
            <div className="text-xs space-y-0.5">
              <div className="font-medium">
                Check #{dep.check_intake_items?.check_number || "—"}
                {dep.check_intake_items?.carrier_name ? ` · ${dep.check_intake_items.carrier_name}` : ""}
              </div>
              <div className="text-muted-foreground font-mono">{dep.checkalt_reference}</div>
              <div className="text-muted-foreground">
                {dep.amount != null ? `$${Number(dep.amount).toLocaleString("en-US", { minimumFractionDigits: 2 })}` : "—"}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => refreshMutation.mutate(dep.id)}
                disabled={refreshingId === dep.id}
              >
                {refreshingId === dep.id
                  ? <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                  : <RefreshCw className="h-3 w-3 mr-1" />}
                Refresh
              </Button>
              <Button
                size="sm"
                onClick={() => decisionMutation.mutate({ deposit_id: dep.id, action: "approve" })}
                disabled={decisionMutation.isPending}
              >
                <Check className="h-3 w-3 mr-1" />Approve
              </Button>
              <Button
                size="sm"
                variant="destructive"
                onClick={() => setRejectingId(rejectingId === dep.id ? null : dep.id)}
                disabled={decisionMutation.isPending}
              >
                <X className="h-3 w-3 mr-1" />Reject
              </Button>
            </div>
          </div>
          {rejectingId === dep.id && (
            <div className="flex items-center gap-2 pt-1">
              <Input
                placeholder="Reason (optional)"
                value={rejectNotes}
                onChange={(e) => setRejectNotes(e.target.value)}
                className="h-8 text-xs"
              />
              <Button
                size="sm"
                variant="destructive"
                onClick={() => decisionMutation.mutate({ deposit_id: dep.id, action: "reject", reject_notes: rejectNotes || undefined })}
                disabled={decisionMutation.isPending}
              >
                Confirm reject
              </Button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * Derive ssoKey as first initial + last name (lowercase, alphanumeric).
 * Matches the convention CheckAlt uses for most FinCapture depositors.
 */
function deriveSsoKey(firstName: string, lastName: string): string {
  const fi = (firstName || "").trim().charAt(0).toLowerCase();
  const ln = (lastName || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!fi || !ln) return "";
  return `${fi}${ln}`;
}

interface TenantAccount {
  sso_user_id: string;
  deposit_account_number: string;
  first_name: string;
  last_name: string;
  email: string;
  enabled: boolean;
  registered_at: string | null;
}

/**
 * Registers (or shows the status of) this tenant's FinCapture depositor
 * "user account". FinCapture's onboarding is per-tenant: each org needs its
 * own POST /fincapture/useraccount/register call before deposits, approvals
 * or polling will work for its checks. The userId submitted here becomes the
 * ssoKey used on every later deposit call for this tenant.
 */
function TenantDepositorAccount({ tenantId, tenantName }: { tenantId: string; tenantName: string }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [form, setForm] = useState({
    sso_user_id: "",
    first_name: "",
    last_name: "",
    email: "",
    deposit_account_number: "",
  });

  const { data: account, isLoading } = useQuery({
    queryKey: ["checkalt-tenant-account", tenantId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("checkalt_tenant_accounts")
        .select("sso_user_id, deposit_account_number, first_name, last_name, email, enabled, registered_at")
        .eq("tenant_id", tenantId)
        .maybeSingle();
      if (error) throw error;
      return data as TenantAccount | null;
    },
  });

  useEffect(() => {
    if (account) {
      setForm({
        sso_user_id: account.sso_user_id,
        first_name: account.first_name,
        last_name: account.last_name,
        email: account.email,
        deposit_account_number: "",
      });
    }
  }, [account]);

  const testConnectionMutation = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke("checkalt-account-status", {
        body: { action: "user_account", tenant_id: tenantId },
      });
      if (error) throw error;
      return data as { ok: boolean; status: number; json: any };
    },
    onSuccess: (data) => {
      toast({
        title: data.ok ? "Connection OK" : `FinCapture responded with HTTP ${data.status}`,
        description: data.ok
          ? "Login and account lookup succeeded — no WAF block right now."
          : "Reached FinCapture's app (no edge/WAF block), but the call itself returned an error. See console for details.",
        variant: data.ok ? "default" : "destructive",
      });
      if (!data.ok) console.error("[checkalt] test connection error response", data.json);
    },
    onError: (e: unknown) => {
      // A WAF/Cloudflare block surfaces here as a CheckAltAuthError thrown
      // during login, before any account lookup happens — same diagnostic
      // path as a real deposit attempt, without creating one.
      toast({
        title: "Connection test failed",
        description: e instanceof Error ? e.message : "Unknown error",
        variant: "destructive",
      });
    },
  });

  const registerMutation = useMutation({
    mutationFn: async () => {
      // CheckAlt provisions the FinCapture user/deposit account on their side
      // and hands us the ssoKey + account number. We just persist them locally
      // so the deposit edge functions can resolve them per tenant.
      const { error } = await supabase
        .from("checkalt_tenant_accounts")
        .upsert({
          tenant_id: tenantId,
          sso_user_id: form.sso_user_id.trim(),
          deposit_account_number: form.deposit_account_number.trim(),
          first_name: form.first_name.trim(),
          last_name: form.last_name.trim(),
          email: form.email.trim(),
          enabled: true,
          registered_at: new Date().toISOString(),
        }, { onConflict: "tenant_id" });
      if (error) throw error;
      return { success: true, sso_user_id: form.sso_user_id.trim() };
    },
    onSuccess: () => {
      toast({ title: "CheckAlt account saved", description: `Depositor account active for ${tenantName}.` });
      setForm((f) => ({ ...f, deposit_account_number: "" }));
      qc.invalidateQueries({ queryKey: ["checkalt-tenant-account", tenantId] });
    },
    onError: (e: unknown) => {
      toast({
        title: "Save failed",
        description: e instanceof Error ? e.message : "Unknown error",
        variant: "destructive",
      });
    },
  });



  const isRegistered = !!account?.registered_at;
  const canSubmit =
    !!form.sso_user_id.trim() && !!form.first_name.trim() && !!form.last_name.trim() &&
    !!form.email.trim() && !!form.deposit_account_number.trim();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-6">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {isRegistered && (
        <div className="space-y-2">
          <div className="flex items-center justify-between rounded-md border border-border/60 bg-muted/30 p-3 text-xs">
            <div className="space-y-0.5">
              <div className="font-medium flex items-center gap-1.5">
                <ShieldCheck className="h-3.5 w-3.5 text-emerald-500" /> Registered with FinCapture
              </div>
              <div className="text-muted-foreground">
                ssoKey: <code>{account?.sso_user_id}</code> · Account ending {account?.deposit_account_number.slice(-4)}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant={account?.enabled ? "default" : "outline"}>
                {account?.enabled ? "Enabled" : "Disabled"}
              </Badge>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={testConnectionMutation.isPending}
                onClick={() => testConnectionMutation.mutate()}
              >
                {testConnectionMutation.isPending
                  ? <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                  : <RefreshCw className="h-3 w-3 mr-1" />}
                Test Connection
              </Button>
            </div>
          </div>
        </div>
      )}

      <div className="grid gap-3 md:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="first_name">First name</Label>
          <Input
            id="first_name"
            value={form.first_name}
            onChange={(e) => {
              const first_name = e.target.value;
              setForm((f) => ({
                ...f,
                first_name,
                sso_user_id: deriveSsoKey(first_name, f.last_name),
              }));
            }}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="last_name">Last name</Label>
          <Input
            id="last_name"
            value={form.last_name}
            onChange={(e) => {
              const last_name = e.target.value;
              setForm((f) => ({
                ...f,
                last_name,
                sso_user_id: deriveSsoKey(f.first_name, last_name),
              }));
            }}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="sso_user_id">FinCapture User ID (ssoKey)</Label>
          <Input
            id="sso_user_id"
            placeholder="auto: first initial + last name"
            value={form.sso_user_id}
            onChange={(e) => setForm({ ...form, sso_user_id: e.target.value })}
          />
          <p className="text-[11px] text-muted-foreground">
            Auto-generated from name (e.g. John Smith → jsmith). Edit if CheckAlt issued a different ID.
          </p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="deposit_account_number">Deposit account number</Label>
          <Input
            id="deposit_account_number"
            placeholder="Full bank account number"
            value={form.deposit_account_number}
            onChange={(e) => setForm({ ...form, deposit_account_number: e.target.value })}
          />
        </div>
        <div className="space-y-1.5 md:col-span-2">
          <Label htmlFor="checkalt_email">Email</Label>
          <Input
            id="checkalt_email"
            type="email"
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
          />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        ssoKey defaults to first initial + last name (the convention CheckAlt uses for most depositors).
        Override it only if CheckAlt issued a different value for {tenantName}.
      </p>
      <div className="flex justify-end">
        <Button
          size="sm"
          onClick={() => registerMutation.mutate()}
          disabled={!canSubmit || registerMutation.isPending}
        >
          {registerMutation.isPending
            ? <Loader2 className="h-4 w-4 mr-1 animate-spin" />
            : <UserPlus className="h-4 w-4 mr-1" />}
          Save CheckAlt account
        </Button>
      </div>

    </div>
  );
}

/**
 * Admin-only configuration panel for the CheckAlt (FinCapture) RDC integration.
 * Per-tenant account model:
 *   - Username/password for the platform-wide auth call live in backend secrets
 *     (CHECKALT_USERNAME / CHECKALT_PASSWORD)
 *   - Connection settings (base URL, enable flag) live here, in checkalt_config
 *   - Each tenant registers its own depositor account (ssoKey + bank account)
 *     via the section below, stored in checkalt_tenant_accounts
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
    default_enabled: false,
    notes: "",
  });

  useEffect(() => {
    if (cfg) {
      setForm({
        base_url: cfg.base_url ?? "",
        default_enabled: !!cfg.default_enabled,
        notes: cfg.notes ?? "",
      });
    }
  }, [cfg]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabase
        .from("checkalt_config")
        .update({
          base_url: form.base_url.trim() || null,
          default_enabled: form.default_enabled,
          notes: form.notes.trim() || null,
        })
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

  const webhookUrl = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/checkalt-webhook`;

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

  const fullyConfigured = !!form.base_url && form.default_enabled;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Banknote className="h-4 w-4 text-primary" />
                CheckAlt (FinCapture) Integration
              </CardTitle>
              <CardDescription>
                Remote Deposit Capture rail. When enabled, eligible checks can be deposited
                directly through CheckAlt instead of routing to a branch.
              </CardDescription>
            </div>
            <Badge variant={fullyConfigured ? "default" : "outline"}>
              {fullyConfigured ? (
                <span className="flex items-center gap-1"><ShieldCheck className="h-3 w-3" /> Live</span>
              ) : (
                <span className="flex items-center gap-1"><AlertTriangle className="h-3 w-3" /> Not active</span>
              )}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="base_url">Base URL</Label>
            <Input
              id="base_url"
              placeholder="https://sandbox.checkalt.com"
              value={form.base_url}
              onChange={(e) => setForm({ ...form, base_url: e.target.value })}
            />
            <p className="text-xs text-muted-foreground">
              Use the sandbox URL until live testing is approved. Per-tenant depositor accounts
              (ssoKey + bank account) are configured per organization below, not here.
            </p>
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
                When off, deposits route through Manual / Branch only. When on, staff can
                assign "CheckAlt (FinCapture RDC)" as the route for a check in the Deposit
                Operations console, which submits it through this API.
              </p>
            </div>
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
        </CardContent>
      </Card>

      {tenant && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm flex items-center gap-2">
              <UserPlus className="h-4 w-4 text-primary" />
              Depositor Account — {tenant.name}
            </CardTitle>
            <CardDescription>
              FinCapture requires each organization to register its own depositor account
              before it can submit, approve, or poll deposits.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <TenantDepositorAccount tenantId={tenant.id} tenantName={tenant.name} />
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-amber-400" />
            Pending Manual Review
          </CardTitle>
          <CardDescription>
            Deposits CheckAlt parked for manual review (status 40). Approve to continue
            processing, or reject to decline.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <PendingApprovalDeposits />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Webhook endpoint</CardTitle>
          <CardDescription>
            Nothing in CheckAlt's onboarding materials or RDC reference docs describes
            an outbound push notification — every status check they document is a
            pull (deposit history / status lookups). The 10-minute polling job above is
            the actual, confirmed reconciliation path; treat it as primary, not a
            fallback. This endpoint is left in place only in case CheckAlt turns out to
            support a postback after all — it would need a shared-secret header matching
            the <code>CHECKALT_WEBHOOK_SECRET</code> backend secret to be accepted.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <code className="block rounded-md bg-muted px-3 py-2 text-xs font-mono break-all">
            {webhookUrl}
          </code>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Required backend secrets</CardTitle>
          <CardDescription>
            These are stored securely and only available to the CheckAlt backend functions.
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
          <div className="flex items-center justify-between rounded-md border border-border/60 px-3 py-2">
            <code>CHECKALT_WEBHOOK_SECRET</code>
            <span className="text-muted-foreground">Shared secret for webhook verification</span>
          </div>
          <div className="flex items-center justify-between rounded-md border border-border/60 px-3 py-2">
            <code>CHECKALT_FI_KEY</code>
            <span className="text-muted-foreground">FinCapture FI key for RDC APIs</span>
          </div>
          <div className="flex items-center justify-between rounded-md border border-border/60 px-3 py-2">
            <code>CHECKALT_MERCHANT</code>
            <span className="text-muted-foreground">Merchant header (defaults to lockbox5)</span>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

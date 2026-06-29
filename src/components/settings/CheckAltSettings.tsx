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
import { Loader2, Banknote, ShieldCheck, AlertTriangle, RefreshCw } from "lucide-react";

/**
 * Admin-only configuration panel for the CheckAlt (FinCapture) RDC integration.
 * Single ChecksOps-wide account model:
 *   - Username/password live in backend secrets (CHECKALT_USERNAME / CHECKALT_PASSWORD)
 *   - Per-deployment values (base URL, depositor account, business unit, enable flag) live here
 */
export function CheckAltSettings() {
  const { isAdmin } = usePermissions();
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
          merchant: form.merchant.trim() || null,
          fi_key: form.fi_key.trim() || null,
          business_unit: form.business_unit.trim() || null,
          depositor_account_id: form.depositor_account_id.trim() || null,
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
 * Manager-side queue showing CheckAlt deposits awaiting manual approval.
 * Rendered inside the Deposit Manager Command Center.
 */
export function PendingApprovalDeposits() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data, isLoading } = useQuery({
    queryKey: ["checkalt-pending-approvals"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("deposit_pending_approvals")
        .select("id, description, item_count, total_amount, requested_at, status")
        .eq("approval_type", "checkalt_deposit")
        .eq("status", "pending")
        .order("requested_at", { ascending: false })
        .limit(50);
      if (error) throw error;
      return data ?? [];
    },
  });

  const decide = useMutation({
    mutationFn: async ({ id, approve }: { id: string; approve: boolean }) => {
      const { error } = await supabase
        .from("deposit_pending_approvals")
        .update({
          status: approve ? "approved" : "rejected",
          reviewed_at: new Date().toISOString(),
        })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast({ title: "Decision recorded" });
      qc.invalidateQueries({ queryKey: ["checkalt-pending-approvals"] });
    },
    onError: (e: unknown) => {
      toast({
        title: "Failed",
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
    return <p className="text-xs text-muted-foreground py-2">No deposits awaiting approval.</p>;
  }

  return (
    <div className="space-y-2">
      {data.map((row) => (
        <div
          key={row.id}
          className="flex items-center justify-between gap-3 rounded-md border border-border/60 px-3 py-2 text-sm"
        >
          <div className="min-w-0">
            <div className="font-medium truncate">{row.description ?? "CheckAlt deposit"}</div>
            <div className="text-xs text-muted-foreground">
              {row.item_count ?? 0} item(s) · ${Number(row.total_amount ?? 0).toLocaleString()}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => decide.mutate({ id: row.id, approve: false })}
              disabled={decide.isPending}
            >
              Reject
            </Button>
            <Button
              size="sm"
              onClick={() => decide.mutate({ id: row.id, approve: true })}
              disabled={decide.isPending}
            >
              Approve
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}

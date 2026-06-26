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
import { Loader2, Banknote, ShieldCheck, AlertTriangle, RefreshCw, Check, X } from "lucide-react";

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
function PendingApprovalDeposits() {
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
    business_unit: "",
    depositor_account_id: "",
    default_enabled: false,
    notes: "",
  });

  useEffect(() => {
    if (cfg) {
      setForm({
        base_url: cfg.base_url ?? "",
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

  const fullyConfigured =
    !!form.base_url && !!form.depositor_account_id && form.default_enabled;

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
                placeholder="https://sandbox.checkalt.com"
                value={form.base_url}
                onChange={(e) => setForm({ ...form, base_url: e.target.value })}
              />
              <p className="text-xs text-muted-foreground">
                Use the sandbox URL until live testing is approved.
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
              <Label htmlFor="depositor_account_id">Depositor Account ID</Label>
              <Input
                id="depositor_account_id"
                placeholder="Provided by CheckAlt"
                value={form.depositor_account_id}
                onChange={(e) => setForm({ ...form, depositor_account_id: e.target.value })}
              />
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
            CheckAlt's own RDC documentation describes a pull/poll-based status model
            (deposit history lookups), not a confirmed push notification. This endpoint is
            ready to receive a postback if CheckAlt confirms they support one — verify with
            CheckAlt support before relying on it; the scheduled polling above is the
            confirmed fallback. Register this URL if/when confirmed. They will
            include a shared-secret header that matches the <code>CHECKALT_WEBHOOK_SECRET</code>{" "}
            backend secret.
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

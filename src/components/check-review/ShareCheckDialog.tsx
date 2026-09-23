import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/aws/client";
import { useTenantFilter } from "@/hooks/useTenantFilter";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Share2, X, Loader2, AlertTriangle } from "lucide-react";
import { SharedCheckThread } from "./SharedCheckThread";
import { useToast } from "@/hooks/use-toast";

interface ShareCheckDialogProps {
  checkId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ShareCheckDialog({ checkId, open, onOpenChange }: ShareCheckDialogProps) {
  const { tenantId } = useTenantFilter();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [selectedTenant, setSelectedTenant] = useState<string>("");

  // Fetch partnered tenants only
  const { data: tenants = [] } = useQuery({
    queryKey: ["partnered-tenants", tenantId],
    queryFn: async () => {
      // Get active partnerships
      const { data: partnerships, error: pErr } = await supabase
        .from("tenant_partnerships")
        .select("inviter_tenant_id, invitee_tenant_id")
        .eq("status", "active")
        .or(`inviter_tenant_id.eq.${tenantId},invitee_tenant_id.eq.${tenantId}`);
      if (pErr) throw pErr;
      if (!partnerships || partnerships.length === 0) return [];

      // Extract partner tenant IDs
      const partnerIds = partnerships.map((p: any) =>
        p.inviter_tenant_id === tenantId ? p.invitee_tenant_id : p.inviter_tenant_id
      ).filter(Boolean);

      if (partnerIds.length === 0) return [];

      const { data, error } = await supabase
        .from("tenants_public" as any)
        .select("id, name, slug")
        .in("id", partnerIds)
        .order("name");
      if (error) throw error;
      return data ?? [];
    },
    enabled: open && !!tenantId,
  });

  // Fetch existing shares for this check
  const { data: existingShares = [] } = useQuery({
    queryKey: ["shared-checks", checkId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("shared_checks")
        .select("id, target_tenant_id, created_at, revoked_at")
        .eq("check_id", checkId)
        .eq("source_tenant_id", tenantId!);
      if (error) throw error;
      const rows = (data ?? []) as any[];
      const targetIds = [...new Set(rows.map((row) => row.target_tenant_id).filter(Boolean))];
      let names = new Map<string, string>();
      if (targetIds.length) {
        const { data: tenants, error: tErr } = await supabase
          .from("tenants_public" as any)
          .select("id, name")
          .in("id", targetIds);
        if (tErr) throw tErr;
        names = new Map((tenants ?? []).map((t: any) => [t.id, t.name]));
      }
      return rows.map((row) => ({
        ...row,
        tenants: { name: names.get(row.target_tenant_id) ?? "Partner" },
      }));
    },
    enabled: open && !!tenantId,
  });

  const activeShares = existingShares.filter((s: any) => !s.revoked_at);

  const shareMutation = useMutation({
    mutationFn: async (targetTenantId: string) => {
      const { error } = await supabase.rpc("share_check_with_partner", {
        _check_id: checkId,
        _target_tenant_id: targetTenantId,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast({ title: "Check shared successfully" });
      setSelectedTenant("");
      qc.invalidateQueries({ queryKey: ["shared-checks", checkId] });
      qc.invalidateQueries({ queryKey: ["shared-with-me-checks"] });
      qc.invalidateQueries({ queryKey: ["check-stage-totals"] });
    },
    onError: (e: any) => {
      toast({ title: "Failed to share", description: e.message, variant: "destructive" });
    },
  });

  const revokeMutation = useMutation({
    mutationFn: async (shareId: string) => {
      const { error } = await supabase.rpc("revoke_shared_check", {
        _share_id: shareId,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast({ title: "Share revoked" });
      qc.invalidateQueries({ queryKey: ["shared-checks", checkId] });
      qc.invalidateQueries({ queryKey: ["shared-with-me-checks"] });
      qc.invalidateQueries({ queryKey: ["check-stage-totals"] });
    },
  });

  const alreadySharedIds = activeShares.map((s: any) => s.target_tenant_id);
  const availableTenants = tenants.filter((t: any) => !alreadySharedIds.includes(t.id));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Share2 className="h-4 w-4" /> Share Check
          </DialogTitle>
        </DialogHeader>

        {/* Active shares */}
        {activeShares.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">Currently shared with</p>
            {activeShares.map((share: any) => (
              <div key={share.id} className="flex items-center justify-between rounded-md border border-border/60 px-3 py-2">
                <span className="text-sm">{share.tenants?.name ?? "Unknown"}</span>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-destructive hover:text-destructive border-destructive/40 hover:bg-destructive/10"
                  onClick={() => {
                    if (confirm(`Unsync this check from ${share.tenants?.name ?? "this partner"}? They will lose access immediately.`)) {
                      revokeMutation.mutate(share.id);
                    }
                  }}
                  disabled={revokeMutation.isPending}
                >
                  <X className="h-3 w-3 mr-1" /> Unsync
                </Button>
              </div>
            ))}
          </div>
        )}

        {/* Share with new tenant */}
        {availableTenants.length > 0 ? (
          <div className="flex items-end gap-2">
            <div className="flex-1 space-y-1">
              <p className="text-xs font-medium text-muted-foreground">Share with</p>
              <Select value={selectedTenant} onValueChange={setSelectedTenant}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a company..." />
                </SelectTrigger>
                <SelectContent>
                  {availableTenants.map((t: any) => (
                    <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button
              onClick={() => selectedTenant && shareMutation.mutate(selectedTenant)}
              disabled={!selectedTenant || shareMutation.isPending}
              size="sm"
            >
              {shareMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Share"}
            </Button>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            {tenants.length === 0
              ? "No other companies available to share with."
              : "Already shared with all available companies."}
          </p>
        )}

        {availableTenants.length > 0 && (
          <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-2 text-[11px] text-amber-700 dark:text-amber-400">
            <AlertTriangle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
            <span>
              If the partner doesn't have a verified payout account yet, the share still succeeds — they'll add and verify one before disbursement.
            </span>
          </div>
        )}

        {activeShares.length > 0 && <SharedCheckThread checkId={checkId} />}
      </DialogContent>
    </Dialog>
  );
}

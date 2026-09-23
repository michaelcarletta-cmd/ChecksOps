import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/aws/client";
import { useAuth } from "@/hooks/useAuth";
import { useTenantFilter } from "@/hooks/useTenantFilter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Copy, Link2, Loader2, Check, X, Users, Share2 } from "lucide-react";
import { SettingsHero } from "@/components/settings/SettingsHero";
import { SectionCard } from "@/components/settings/SectionCard";
import { useToast } from "@/hooks/use-toast";
import { isMasterMerchant } from "@/lib/masterMerchant";

export function TenantPartnerManager() {
  const { user } = useAuth();
  const { tenantId } = useTenantFilter();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [redeemCode, setRedeemCode] = useState("");
  const [copiedCode, setCopiedCode] = useState(false);

  // Get current tenant's permanent partner code
  const { data: tenantData } = useQuery({
    queryKey: ["tenant-partner-code", tenantId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("tenants")
        .select("partner_code, name")
        .eq("id", tenantId!)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
    enabled: !!tenantId,
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: "always",
  });

  // Active partnerships. Names come from tenants_public — AWS RLS on base
  // tenants is membership-only, so the old inviter/invitee embed rendered Unknown.
  const { data: partnerships = [] } = useQuery({
    queryKey: ["tenant-partnerships", tenantId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("tenant_partnerships")
        .select("id, inviter_tenant_id, invitee_tenant_id, status, created_at")
        .eq("status", "active")
        .or(`inviter_tenant_id.eq.${tenantId},invitee_tenant_id.eq.${tenantId}`)
        .order("created_at", { ascending: false });
      if (error) throw error;
      const rows = (data ?? []) as any[];
      const partnerIds = [...new Set(rows.map((p) =>
        p.inviter_tenant_id === tenantId ? p.invitee_tenant_id : p.inviter_tenant_id,
      ).filter(Boolean))];
      let names = new Map<string, string>();
      if (partnerIds.length) {
        const { data: tenants, error: tErr } = await supabase
          .from("tenants_public" as any)
          .select("id, name")
          .in("id", partnerIds);
        if (tErr) throw tErr;
        names = new Map((tenants ?? []).map((t: any) => [t.id, t.name]));
      }
      return rows.map((p) => {
        const partnerId = p.inviter_tenant_id === tenantId ? p.invitee_tenant_id : p.inviter_tenant_id;
        return { ...p, partnerName: names.get(partnerId) ?? null };
      });
    },
    enabled: !!tenantId,
  });

  // Redeem a partner's code
  const redeemMutation = useMutation({
    mutationFn: async (code: string) => {
      // Strip everything except A-Z and 0-9 so spaces, dashes, or pasted formatting don't break lookup
      const normalizedCode = code.toUpperCase().replace(/[^A-Z0-9]/g, "");
      if (normalizedCode.length !== 8) {
        throw new Error("Partner codes are 8 characters (letters and numbers only).");
      }

      // Preflight: confirm current user is actually a member of their tenant.
      // Master merchant / super admins bypass this check so they can help tenants
      // during preview without being added to tenant_users.
      const superAdmin = isMasterMerchant(user!.email, user!.id);
      if (!superAdmin) {
        const { data: membership, error: memErr } = await supabase
          .from("tenant_users")
          .select("id")
          .eq("tenant_id", tenantId!)
          .eq("user_id", user!.id)
          .maybeSingle();
        if (memErr) throw memErr;
        if (!membership) {
          throw new Error(
            "Your account isn't enrolled in this company yet. Ask an admin to add you under Settings → Team before connecting partners."
          );
        }
      }

      const { data, error } = await supabase.rpc("connect_partner_by_code", {
        _code: normalizedCode,
        _source_tenant_id: tenantId,
      });
      if (error) throw error;
      const payload = (data && typeof data === "object" ? data : {}) as {
        ok?: boolean;
        error?: string;
        partner_name?: string;
      };
      if (payload.ok === false) throw new Error(String(payload.error || "Connection failed"));
      return String(payload.partner_name || "partner");
    },
    onSuccess: (partnerName) => {
      toast({ title: `Connected with ${partnerName}!` });
      setRedeemCode("");
      qc.invalidateQueries({ queryKey: ["tenant-partnerships", tenantId] });
    },
    onError: (e: any) => {
      toast({ title: "Connection failed", description: e.message, variant: "destructive" });
    },
  });

  // Revoke partnership
  const revokeMutation = useMutation({
    mutationFn: async (partnershipId: string) => {
      const { error } = await supabase.rpc("revoke_tenant_partnership", {
        _partnership_id: partnershipId,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast({ title: "Partnership revoked" });
      qc.invalidateQueries({ queryKey: ["tenant-partnerships", tenantId] });
      qc.invalidateQueries({ queryKey: ["shared-checks"] });
      qc.invalidateQueries({ queryKey: ["shared-with-me-checks"] });
      qc.invalidateQueries({ queryKey: ["partnered-tenants", tenantId] });
    },
  });

  const copyCode = () => {
    if (tenantData?.partner_code) {
      navigator.clipboard.writeText(tenantData.partner_code);
      setCopiedCode(true);
      setTimeout(() => setCopiedCode(false), 2000);
    }
  };

  return (
    <div className="space-y-6">
      <SettingsHero
        title="Partner Ecosystem"
        description="Connect with other companies to share checks securely using partner codes."
        badge="Shared Workspaces"
        icon={<Share2 className="h-4 w-4 text-primary" />}
      />

      <SectionCard
        title="Your Partner Code"
        icon={<Link2 className="h-4 w-4 text-amber-500" />}
        accent="bg-gradient-to-r from-amber-500/60 to-amber-500/10"
        description="Share this code with any company you want to partner with"
      >
        {tenantData?.partner_code ? (
          <div className="flex items-center gap-3">
            <code className="rounded-md border border-border/60 bg-muted/30 px-4 py-2 font-mono text-lg font-bold tracking-[0.3em]">
              {tenantData.partner_code}
            </code>
            <Button variant="outline" size="icon" onClick={copyCode} aria-label="Copy partner code">
              {copiedCode ? <Check className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading...
          </div>
        )}
      </SectionCard>

      <SectionCard
        title="Connect with a Partner"
        icon={<Users className="h-4 w-4 text-sky-500" />}
        accent="bg-gradient-to-r from-sky-500/60 to-sky-500/10"
        description="Enter the partner code you received from another company"
      >
        <div className="flex flex-col gap-3 sm:flex-row">
          <Input
            placeholder="e.g. AB3K7X9P"
            value={redeemCode}
            onChange={(e) => setRedeemCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))}
            maxLength={8}
            className="h-9 flex-1 font-mono uppercase tracking-widest"
          />
          <Button
            onClick={() => redeemCode.length === 8 && redeemMutation.mutate(redeemCode)}
            disabled={redeemCode.length !== 8 || redeemMutation.isPending}
            size="sm"
            className="sm:w-32"
          >
            {redeemMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Connect"}
          </Button>
        </div>
      </SectionCard>

      <SectionCard
        title="Active Partners"
        icon={<Share2 className="h-4 w-4 text-violet-500" />}
        accent="bg-gradient-to-r from-violet-500/60 to-violet-500/10"
        description="Companies currently connected to your workspace"
      >
        {partnerships.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border/60 bg-muted/20 py-10 text-center">
            <Users className="mx-auto mb-3 h-10 w-10 text-muted-foreground/50" />
            <p className="text-sm font-medium text-foreground">No active partnerships yet</p>
            <p className="mx-auto mt-1 max-w-xs text-xs text-muted-foreground">
              Share your code or enter a partner's code to connect.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {partnerships.map((p: any) => {
              const partnerName = p.partnerName;
              return (
                <div
                  key={p.id}
                  className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-muted/20 p-4 backdrop-blur-sm transition-colors hover:border-violet-500/30"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-foreground">{partnerName ?? "Unknown"}</span>
                    <Badge variant="outline" className="text-[10px]">Active</Badge>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 text-destructive hover:text-destructive"
                    onClick={() => {
                      if (confirm("Revoke this partnership? The partner will lose access to shared checks.")) {
                        revokeMutation.mutate(p.id);
                      }
                    }}
                  >
                    <X className="mr-1 h-3 w-3" /> Revoke
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      </SectionCard>
    </div>
  );
}

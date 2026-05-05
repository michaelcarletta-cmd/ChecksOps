import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useTenantFilter } from "@/hooks/useTenantFilter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Copy, Link2, Loader2, Check, X, Users } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

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

  // Active partnerships
  const { data: partnerships = [] } = useQuery({
    queryKey: ["tenant-partnerships", tenantId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("tenant_partnerships")
        .select("*, inviter:tenants!tenant_partnerships_inviter_tenant_id_fkey(name), invitee:tenants!tenant_partnerships_invitee_tenant_id_fkey(name)")
        .eq("status", "active")
        .or(`inviter_tenant_id.eq.${tenantId},invitee_tenant_id.eq.${tenantId}`)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as any[];
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
      // Without this, the partnership INSERT fails with a raw RLS violation
      // because user_belongs_to_tenant(auth.uid(), inviter_tenant_id) returns false.
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

      // Look up the tenant by their permanent partner_code via SECURITY DEFINER RPC
      // (bypasses RLS so cross-tenant lookup works for any signed-in user)
      const { data: lookupRows, error: lookupErr } = await supabase
        .rpc("lookup_tenant_by_partner_code", { _code: normalizedCode });
      if (lookupErr) throw lookupErr;
      const partnerTenant = Array.isArray(lookupRows) ? lookupRows[0] : null;
      if (!partnerTenant) throw new Error("Invalid partner code. Check the code and try again.");
      if (partnerTenant.id === tenantId) throw new Error("That's your own partner code!");

      // Check if partnership already exists
      const { data: existing } = await supabase
        .from("tenant_partnerships")
        .select("id, status")
        .or(`and(inviter_tenant_id.eq.${tenantId},invitee_tenant_id.eq.${partnerTenant.id}),and(inviter_tenant_id.eq.${partnerTenant.id},invitee_tenant_id.eq.${tenantId})`)
        .eq("status", "active")
        .maybeSingle();
      if (existing) throw new Error(`Already partnered with ${partnerTenant.name}`);

      // Create the partnership
      const { error: insertErr } = await supabase.from("tenant_partnerships").insert({
        inviter_tenant_id: tenantId!,
        invitee_tenant_id: partnerTenant.id,
        invite_code: normalizedCode,
        status: "active",
        created_by: user!.id,
        accepted_at: new Date().toISOString(),
      });
      if (insertErr) throw insertErr;
      return partnerTenant.name;
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
      const { error } = await supabase
        .from("tenant_partnerships")
        .update({ status: "revoked", revoked_at: new Date().toISOString() })
        .eq("id", partnershipId);
      if (error) throw error;
    },
    onSuccess: () => {
      toast({ title: "Partnership revoked" });
      qc.invalidateQueries({ queryKey: ["tenant-partnerships", tenantId] });
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
      {/* Your partner code */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Link2 className="h-4 w-4" /> Your Partner Code
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Share this code with any company you want to partner with. They can enter it to connect with you for check sharing.
          </p>
          {tenantData?.partner_code ? (
            <div className="flex items-center gap-3">
              <code className="text-lg font-mono font-bold tracking-[0.3em] bg-muted px-4 py-2 rounded-md">
                {tenantData.partner_code}
              </code>
              <Button variant="outline" size="icon" onClick={copyCode}>
                {copiedCode ? <Check className="h-4 w-4 text-emerald-400" /> : <Copy className="h-4 w-4" />}
              </Button>
            </div>
          ) : (
            <div className="text-xs text-muted-foreground">Loading...</div>
          )}
        </CardContent>
      </Card>

      {/* Enter partner's code */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Users className="h-4 w-4" /> Connect with a Partner
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground mb-3">
            Enter the partner code you received from another company.
          </p>
          <div className="flex gap-2">
            <Input
              placeholder="e.g. AB3K7X9P"
              value={redeemCode}
              onChange={(e) => setRedeemCode(e.target.value.toUpperCase())}
              maxLength={8}
              className="font-mono tracking-widest uppercase"
            />
            <Button
              onClick={() => redeemCode.length === 8 && redeemMutation.mutate(redeemCode)}
              disabled={redeemCode.length !== 8 || redeemMutation.isPending}
              size="sm"
            >
              {redeemMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Connect"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Active partnerships */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Active Partners</CardTitle>
        </CardHeader>
        <CardContent>
          {partnerships.length === 0 ? (
            <p className="text-xs text-muted-foreground">No active partnerships yet. Share your code or enter a partner's code to connect.</p>
          ) : (
            <div className="space-y-2">
              {partnerships.map((p: any) => {
                const partnerName = p.inviter_tenant_id === tenantId
                  ? p.invitee?.name
                  : p.inviter?.name;
                return (
                  <div key={p.id} className="flex items-center justify-between rounded-md border border-border/60 px-3 py-2">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{partnerName ?? "Unknown"}</span>
                      <Badge variant="outline" className="text-[10px]">Active</Badge>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 text-destructive hover:text-destructive"
                      onClick={() => {
                        if (confirm("Revoke this partnership? The partner will lose access to shared checks.")) {
                          revokeMutation.mutate(p.id);
                        }
                      }}
                    >
                      <X className="h-3 w-3 mr-1" /> Revoke
                    </Button>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

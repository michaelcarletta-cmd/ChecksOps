import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useTenantFilter } from "@/hooks/useTenantFilter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Copy, Link2, Loader2, Check, X, Users } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

function generateCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 8; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

export function TenantPartnerManager() {
  const { user } = useAuth();
  const { tenantId } = useTenantFilter();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [redeemCode, setRedeemCode] = useState("");
  const [copiedCode, setCopiedCode] = useState<string | null>(null);

  // Active partnerships
  const { data: partnerships = [] } = useQuery({
    queryKey: ["tenant-partnerships", tenantId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("tenant_partnerships")
        .select("*, inviter:tenants!tenant_partnerships_inviter_tenant_id_fkey(name), invitee:tenants!tenant_partnerships_invitee_tenant_id_fkey(name)")
        .or(`inviter_tenant_id.eq.${tenantId},invitee_tenant_id.eq.${tenantId}`)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as any[];
    },
    enabled: !!tenantId,
  });

  // Pending invite codes (ones we created, not yet redeemed)
  const { data: pendingInvites = [] } = useQuery({
    queryKey: ["pending-invites", tenantId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("tenant_partnerships")
        .select("id, invite_code, created_at")
        .eq("inviter_tenant_id", tenantId!)
        .eq("status", "pending")
        .is("invitee_tenant_id", null);
      if (error) throw error;
      return (data ?? []) as any[];
    },
    enabled: !!tenantId,
  });

  const activePartners = partnerships.filter((p: any) => p.status === "active");

  // Generate invite code
  const generateMutation = useMutation({
    mutationFn: async () => {
      const code = generateCode();
      const { error } = await supabase.from("tenant_partnerships").insert({
        inviter_tenant_id: tenantId!,
        invite_code: code,
        created_by: user!.id,
        status: "pending",
      });
      if (error) throw error;
      return code;
    },
    onSuccess: (code) => {
      toast({ title: "Invite code created", description: code });
      qc.invalidateQueries({ queryKey: ["pending-invites", tenantId] });
    },
    onError: (e: any) => {
      toast({ title: "Failed to generate code", description: e.message, variant: "destructive" });
    },
  });

  // Redeem invite code
  const redeemMutation = useMutation({
    mutationFn: async (code: string) => {
      // Look up the pending invite
      const { data: invite, error: lookupErr } = await supabase
        .from("tenant_partnerships")
        .select("id, inviter_tenant_id")
        .eq("invite_code", code.toUpperCase().trim())
        .eq("status", "pending")
        .is("invitee_tenant_id", null)
        .maybeSingle();
      if (lookupErr) throw lookupErr;
      if (!invite) throw new Error("Invalid or expired invite code");
      if (invite.inviter_tenant_id === tenantId) throw new Error("Cannot redeem your own invite code");

      // Activate the partnership
      const { error: updateErr } = await supabase
        .from("tenant_partnerships")
        .update({
          invitee_tenant_id: tenantId!,
          status: "active",
          accepted_at: new Date().toISOString(),
        })
        .eq("id", invite.id);
      if (updateErr) throw updateErr;
    },
    onSuccess: () => {
      toast({ title: "Partnership established!" });
      setRedeemCode("");
      qc.invalidateQueries({ queryKey: ["tenant-partnerships", tenantId] });
    },
    onError: (e: any) => {
      toast({ title: "Failed to redeem", description: e.message, variant: "destructive" });
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

  const copyCode = (code: string) => {
    navigator.clipboard.writeText(code);
    setCopiedCode(code);
    setTimeout(() => setCopiedCode(null), 2000);
  };

  return (
    <div className="space-y-6">
      {/* Generate invite code */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Link2 className="h-4 w-4" /> Generate Invite Code
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Generate a code and share it with a partner company. They'll enter it to connect with you for check sharing.
          </p>
          <Button
            onClick={() => generateMutation.mutate()}
            disabled={generateMutation.isPending}
            size="sm"
          >
            {generateMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
            Generate Code
          </Button>

          {pendingInvites.length > 0 && (
            <div className="space-y-2 pt-2">
              <p className="text-xs font-medium text-muted-foreground">Active invite codes</p>
              {pendingInvites.map((inv: any) => (
                <div key={inv.id} className="flex items-center gap-2 rounded-md border border-border/60 px-3 py-2">
                  <code className="text-sm font-mono font-bold tracking-widest">{inv.invite_code}</code>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={() => copyCode(inv.invite_code)}
                  >
                    {copiedCode === inv.invite_code ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Redeem invite code */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Users className="h-4 w-4" /> Redeem Partner Code
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground mb-3">
            Enter the invite code you received from a partner company.
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
          {activePartners.length === 0 ? (
            <p className="text-xs text-muted-foreground">No active partnerships yet.</p>
          ) : (
            <div className="space-y-2">
              {activePartners.map((p: any) => {
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
                        if (confirm("Revoke this partnership? The partner will no longer see shared checks.")) {
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

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/aws/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { Loader2, RotateCcw, Send, Trash2, UserPlus, Users, Shield } from "lucide-react";
import { SettingsHero } from "@/components/settings/SettingsHero";
import { SectionCard } from "@/components/settings/SectionCard";
import { usePermissions } from "@/hooks/usePermissions";

interface Props {
  tenantId: string;
}

export function TenantUserManager({ tenantId }: Props) {
  const { toast } = useToast();
  const { isAdmin } = usePermissions();
  const qc = useQueryClient();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<string>("operator");

  const { data: users = [], isLoading } = useQuery({
    queryKey: ["tenant-users", tenantId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_tenant_users_with_profiles", {
        _tenant_id: tenantId,
      });
      if (error) throw error;
      return (data ?? []) as Array<{
        id: string;
        user_id: string;
        role: string;
        created_at: string;
        full_name: string | null;
        email: string | null;
      }>;
    },
  });

  const inviteMutation = useMutation({
    mutationFn: async ({ email, role }: { email: string; role: string }) => {
      // Look up user by email from profiles or auth — for now use edge function
      const { data, error } = await supabase.functions.invoke("tenant-invite-user", {
        body: { tenant_id: tenantId, email, role },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tenant-users", tenantId] });
      setEmail("");
      toast({ title: "User invited", description: "They can now sign in to access the Check Center." });
    },
    onError: (e: any) => {
      toast({ title: "Failed to invite", description: e.message, variant: "destructive" });
    },
  });

  const resendMutation = useMutation({
    mutationFn: async ({ email, role }: { email: string; role: string }) => {
      const { data, error } = await supabase.functions.invoke("tenant-invite-user", {
        body: { tenant_id: tenantId, email, role },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      if (data?.invite_sent === false) {
        throw new Error(data?.invite_error || "Invite email could not be sent");
      }
      return data;
    },
    onSuccess: () => {
      toast({ title: "Invite resent", description: "A fresh sign-in link is on its way. It expires in 24 hours." });
    },
    onError: (e: any) => {
      toast({ title: "Failed to resend invite", description: e.message, variant: "destructive" });
    },
  });

  const removeMutation = useMutation({
    mutationFn: async (userId: string) => {
      const { error } = await supabase
        .from("tenant_users")
        .delete()
        .eq("tenant_id", tenantId)
        .eq("user_id", userId);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tenant-users", tenantId] });
      toast({ title: "User removed" });
    },
    onError: (e: any) => {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    },
  });

  const resetTwoFactorMutation = useMutation({
    mutationFn: async ({ userId }: { userId: string; email: string }) => {
      const { data, error } = await supabase.functions.invoke("admin-reset-totp", {
        body: { user_id: userId },
      });
      if (error) throw error;
      if (!data?.success) throw new Error(data?.error || "Two-factor reset failed");
      return data;
    },
    onSuccess: (_data, variables) => {
      toast({
        title: "Two-factor reset",
        description: `${variables.email} can now sign in by magic link and set up a new authenticator.`,
      });
    },
    onError: (e: any) => {
      toast({ title: "Could not reset two-factor", description: e.message, variant: "destructive" });
    },
  });

  const confirmTwoFactorReset = (userId: string, email: string) => {
    if (!confirm(`Reset two-factor authentication for ${email}? They will be signed out and must set up a new authenticator.`)) return;
    resetTwoFactorMutation.mutate({ userId, email });
  };


  const roleColor = (r: string) => {
    switch (r) {
      case "admin": return "bg-primary/20 text-primary";
      case "operator": return "bg-sky-500/20 text-sky-400";
      default: return "bg-muted text-muted-foreground";
    }
  };

  return (
    <div className="space-y-6">
      <SettingsHero
        title="User Management"
        description="Invite teammates, assign roles, and manage access to your Check Center."
        badge="Team Access"
        icon={<Users className="h-4 w-4 text-primary" />}
      />

      <SectionCard
        title="Add Team Member"
        icon={<UserPlus className="h-4 w-4 text-orange-500" />}
        accent="bg-gradient-to-r from-orange-500/60 to-orange-500/10"
        description="Send a sign-in invite to a new teammate"
      >
        <div className="flex flex-col gap-3 sm:flex-row">
          <Input
            placeholder="Email address"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="h-9 flex-1"
          />
          <Select value={role} onValueChange={setRole}>
            <SelectTrigger className="h-9 w-full sm:w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="admin">Admin</SelectItem>
              <SelectItem value="operator">Operator</SelectItem>
              <SelectItem value="viewer">Viewer</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex justify-end">
          <Button
            size="sm"
            onClick={() => inviteMutation.mutate({ email, role })}
            disabled={!email || inviteMutation.isPending}
          >
            {inviteMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <UserPlus className="mr-2 h-4 w-4" />}
            Invite
          </Button>
        </div>
      </SectionCard>

      <SectionCard
        title="Active Team Members"
        icon={<Shield className="h-4 w-4 text-sky-500" />}
        accent="bg-gradient-to-r from-sky-500/60 to-sky-500/10"
        description="Manage roles and access for existing team members"
      >
        {isLoading ? (
          <div className="flex justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : users.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border/60 bg-muted/20 py-10 text-center">
            <Users className="mx-auto mb-3 h-10 w-10 text-muted-foreground/50" />
            <p className="text-sm font-medium text-foreground">No team members yet</p>
            <p className="mt-1 text-xs text-muted-foreground">Invite someone above to give them access.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {users.map((u) => {
              const displayName = u.full_name?.trim() || u.email?.split("@")[0] || "Unknown user";
              return (
                <div
                  key={u.id}
                  className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-muted/20 p-4 backdrop-blur-sm transition-colors hover:border-sky-500/30"
                >
                  <div className="flex min-w-0 flex-1 items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-foreground">{displayName}</div>
                      {u.email && (
                        <div className="truncate text-xs text-muted-foreground">{u.email}</div>
                      )}
                    </div>
                    <Badge className={`shrink-0 text-[10px] ${roleColor(u.role)}`}>{u.role}</Badge>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {isAdmin && u.email && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        disabled={resetTwoFactorMutation.isPending && resetTwoFactorMutation.variables?.userId === u.user_id}
                        onClick={() => confirmTwoFactorReset(u.user_id, u.email ?? "this user")}
                        title="Reset two-factor authentication"
                        aria-label={`Reset two-factor authentication for ${u.email}`}
                      >
                        {resetTwoFactorMutation.isPending && resetTwoFactorMutation.variables?.userId === u.user_id ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <RotateCcw className="h-3.5 w-3.5" />
                        )}
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      disabled={!u.email || (resendMutation.isPending && resendMutation.variables?.email === u.email)}
                      onClick={() => u.email && resendMutation.mutate({ email: u.email, role: u.role })}
                      title="Resend sign-in invite"
                      aria-label="Resend sign-in invite"
                    >
                      {resendMutation.isPending && resendMutation.variables?.email === u.email ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Send className="h-3.5 w-3.5" />
                      )}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => removeMutation.mutate(u.user_id)}
                      title="Remove user"
                      aria-label="Remove user"
                    >
                      <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </SectionCard>
    </div>
  );
}

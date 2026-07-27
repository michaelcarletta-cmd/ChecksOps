import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Plus, Trash2, UserPlus } from "lucide-react";

interface Props {
  tenantId: string;
}

export function TenantUserManager({ tenantId }: Props) {
  const { toast } = useToast();
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


  const roleColor = (r: string) => {
    switch (r) {
      case "admin": return "bg-primary/20 text-primary";
      case "operator": return "bg-blue-500/20 text-blue-400";
      default: return "bg-muted text-muted-foreground";
    }
  };

  return (
    <div className="space-y-4">
      {/* Invite form */}
      <div className="space-y-3 p-3 border rounded-lg">
        <Label className="text-xs font-medium">Add Team Member</Label>
        <div className="flex gap-2">
          <Input
            placeholder="Email address"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="flex-1"
          />
          <Select value={role} onValueChange={setRole}>
            <SelectTrigger className="w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="admin">Admin</SelectItem>
              <SelectItem value="operator">Operator</SelectItem>
              <SelectItem value="viewer">Viewer</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Button
          size="sm"
          onClick={() => inviteMutation.mutate({ email, role })}
          disabled={!email || inviteMutation.isPending}
          className="w-full"
        >
          {inviteMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <UserPlus className="mr-2 h-4 w-4" />}
          Invite
        </Button>
      </div>

      {/* User list */}
      {isLoading ? (
        <div className="flex justify-center py-4">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <div className="space-y-2">
          {users.map((u) => {
            const displayName = u.full_name?.trim() || u.email?.split("@")[0] || "Unknown user";
            return (
              <div key={u.id} className="flex items-center justify-between p-2 rounded border">
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium truncate">{displayName}</div>
                    {u.email && (
                      <div className="text-xs text-muted-foreground truncate">{u.email}</div>
                    )}
                  </div>
                  <Badge className={`text-xs shrink-0 ${roleColor(u.role)}`}>{u.role}</Badge>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 shrink-0"
                  onClick={() => removeMutation.mutate(u.user_id)}
                >
                  <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
                </Button>
              </div>
            );
          })}
          {users.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-4">
              No team members yet. Invite someone above.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

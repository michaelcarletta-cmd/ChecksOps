import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/aws/client";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { UserPlus, Trash2, Shield, UserX, CheckCircle, XCircle, Clock, RotateCcw, Loader2, Users } from "lucide-react";
import { SectionCard } from "./SectionCard";
import { SettingsHero } from "./SettingsHero";

interface Profile {
  id: string;
  email: string;
  full_name: string | null;
  phone: string | null;
  approval_status: string;
}

interface UserRole {
  id: string;
  user_id: string;
  role: "admin" | "staff" | "client" | "contractor" | "referrer" | "read_only" | "guided" | "mortgage_agent";
}

interface UserWithRoles extends Profile {
  roles: UserRole[];
}

const ROLE_LABELS: Record<string, string> = {
  admin: "Admin",
  staff: "Staff",
  client: "Client",
  contractor: "Contractor",
  referrer: "Referrer",
  read_only: "Read Only",
  guided: "Guided",
  mortgage_agent: "Mortgage Agent",
};

const ROLE_COLORS: Record<string, string> = {
  admin: "destructive",
  staff: "default",
  client: "secondary",
  contractor: "outline",
  referrer: "outline",
  read_only: "secondary",
  guided: "outline",
  mortgage_agent: "default",
};

export function UserManagementSettings() {
  const [users, setUsers] = useState<UserWithRoles[]>([]);
  const [pendingUsers, setPendingUsers] = useState<UserWithRoles[]>([]);
  const [loading, setLoading] = useState(true);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [selectedRoles, setSelectedRoles] = useState<Record<string, string | undefined>>({});
  const [resettingUserId, setResettingUserId] = useState<string | null>(null);
  const { toast } = useToast();

  useEffect(() => {
    fetchCurrentUser();
    fetchUsers();
  }, []);

  const fetchCurrentUser = async () => {
    const { data } = await supabase.auth.getUser();
    setCurrentUserId(data.user?.id || null);
  };

  const fetchUsers = async () => {
    try {
      setLoading(true);
      
      const { data: profiles, error: profilesError } = await supabase
        .from("profiles")
        .select("*")
        .order("email");

      if (profilesError) throw profilesError;

      const { data: roles, error: rolesError } = await supabase
        .from("user_roles")
        .select("*");

      if (rolesError) throw rolesError;

      const usersWithRoles: UserWithRoles[] = (profiles || [])
        .map((profile) => ({
          ...profile,
          approval_status: profile.approval_status || 'approved',
          roles: (roles || []).filter((role) => role.user_id === profile.id),
        }));

      const staffAdminUsers = usersWithRoles.filter(u => {
        const hasPortalRole = u.roles.some(r => 
          r.role === 'client' || r.role === 'contractor' || r.role === 'referrer'
        );
        const hasStaffRole = u.roles.some(r => r.role === 'staff' || r.role === 'admin' || r.role === 'mortgage_agent');
        return !hasPortalRole && (hasStaffRole || u.roles.length === 0 || u.approval_status === 'pending');
      });

      const pending = staffAdminUsers.filter(u => u.approval_status === 'pending');
      const approved = staffAdminUsers.filter(u => u.approval_status !== 'pending');

      setPendingUsers(pending);
      setUsers(approved);
    } catch (error: any) {
      console.error("Error fetching users:", error);
      toast({
        title: "Error",
        description: `Failed to load users: ${error.message}`,
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  const approveUser = async (userId: string, userName: string) => {
    try {
      const { error } = await supabase
        .from("profiles")
        .update({ approval_status: 'approved' })
        .eq("id", userId);

      if (error) throw error;

      toast({
        title: "Success",
        description: `${userName} has been approved.`,
      });

      fetchUsers();
    } catch (error: any) {
      toast({
        title: "Error",
        description: error?.message || "Failed to approve user",
        variant: "destructive",
      });
    }
  };

  const denyUser = async (userId: string, userName: string) => {
    if (!confirm(`Deny access to ${userName}?`)) return;

    try {
      const { error } = await supabase
        .from("profiles")
        .update({ approval_status: 'denied' })
        .eq("id", userId);

      if (error) throw error;

      toast({
        title: "Access Denied",
        description: `${userName} has been denied access.`,
      });

      fetchUsers();
    } catch (error: any) {
      toast({
        title: "Error",
        description: error?.message || "Failed to deny user",
        variant: "destructive",
      });
    }
  };

  const addRole = async (userId: string, role: string) => {
    try {
      const { error } = await supabase
        .from("user_roles")
        .insert({
          user_id: userId,
          role: role as any,
        });

      if (error) {
        if (error.code === "23505") {
          toast({ title: "Info", description: "User already has this role" });
          setSelectedRoles(prev => ({ ...prev, [userId]: undefined }));
          return;
        }
        throw error;
      }

      toast({ title: "Success", description: "Role added successfully" });
      setSelectedRoles(prev => ({ ...prev, [userId]: undefined }));
      fetchUsers();
    } catch (error: any) {
      toast({
        title: "Error",
        description: error?.message || "Failed to add role",
        variant: "destructive",
      });
    }
  };

  const removeRole = async (roleId: string, userId: string, role: string) => {
    if (userId === currentUserId && role === "admin") {
      toast({
        title: "Cannot Remove Your Own Admin Role",
        description: "Ask another admin to remove it if needed.",
        variant: "destructive",
      });
      return;
    }

    if (!confirm("Remove this role?")) return;

    try {
      const { error } = await supabase
        .from("user_roles")
        .delete()
        .eq("id", roleId);

      if (error) throw error;
      toast({ title: "Success", description: "Role removed successfully" });
      fetchUsers();
    } catch (error: any) {
      toast({
        title: "Error",
        description: error?.message || "Failed to remove role",
        variant: "destructive",
      });
    }
  };

  const removeAllRoles = async (userId: string, userName: string) => {
    if (userId === currentUserId) {
      toast({
        title: "Cannot Remove Your Own Roles",
        description: "Ask another admin if needed.",
        variant: "destructive",
      });
      return;
    }

    if (!confirm(`Remove all roles from ${userName}?`)) return;

    try {
      const { error } = await supabase.from("user_roles").delete().eq("user_id", userId);
      if (error) throw error;
      toast({ title: "Success", description: "All roles removed" });
      fetchUsers();
    } catch (error: any) {
      toast({ title: "Error", description: error?.message, variant: "destructive" });
    }
  };

  const deleteUser = async (userId: string, userName: string) => {
    if (userId === currentUserId) {
      toast({ title: "Error", description: "Cannot delete your own account", variant: "destructive" });
      return;
    }

    if (!confirm(`PERMANENTLY DELETE ${userName}?`)) return;

    try {
      await supabase.from("user_roles").delete().eq("user_id", userId);
      const { error } = await supabase.from("profiles").delete().eq("id", userId);
      if (error) throw error;
      toast({ title: "Success", description: "User deleted" });
      fetchUsers();
    } catch (error: any) {
      toast({ title: "Error", description: error?.message, variant: "destructive" });
    }
  };

  const resetTwoFactor = async (userId: string, userEmail: string, userName: string) => {
    if (!confirm(`Reset two-factor authentication for ${userName}? They will be signed out and must set up a new authenticator.`)) return;

    try {
      setResettingUserId(userId);
      const { data, error } = await supabase.functions.invoke("admin-reset-totp", {
        body: { user_id: userId },
      });
      if (error) throw error;
      if (!data?.success) throw new Error(data?.error || "Two-factor reset failed");
      toast({
        title: "Two-factor reset",
        description: `${userEmail} can now sign in by magic link and set up a new authenticator.`,
      });
    } catch (error: any) {
      toast({ title: "Could not reset two-factor", description: error?.message, variant: "destructive" });
    } finally {
      setResettingUserId(null);
    }
  };

  if (loading) {
    return <div className="text-center py-8 text-muted-foreground">Loading users...</div>;
  }

  return (
    <div className="space-y-6">
      <SettingsHero
        title="User Management"
        description="Manage your team's access, roles, and pending approvals."
        badge="Team Access"
        icon={<Users className="h-4 w-4 text-primary" />}
      />
      <div className="grid gap-6">
        {pendingUsers.length > 0 && (
          <SectionCard
            title={`Pending Staff Approvals (${pendingUsers.length})`}
            icon={<Clock className="h-4 w-4 text-orange-500" />}
            accent="bg-gradient-to-r from-orange-500/60 to-orange-500/10"
            description="New staff members awaiting your approval"
          >
            <div className="space-y-3">
              {pendingUsers.map((user) => (
                <div key={user.id} className="flex items-center justify-between p-4 border border-orange-500/20 rounded-lg bg-orange-500/5 backdrop-blur-sm">
                  <div>
                    <p className="font-medium">{user.full_name || "Unnamed User"}</p>
                    <p className="text-sm text-muted-foreground">{user.email}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button variant="outline" size="sm" onClick={() => resetTwoFactor(user.id, user.email, user.full_name || user.email)} disabled={resettingUserId === user.id}>
                      {resettingUserId === user.id ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <RotateCcw className="h-4 w-4 mr-1" />}
                      Reset two-factor
                    </Button>
                    <Button variant="default" size="sm" onClick={() => approveUser(user.id, user.full_name || user.email)} className="bg-success text-success-foreground hover:bg-success/90">
                      <CheckCircle className="h-4 w-4 mr-1" /> Approve
                    </Button>
                    <Button variant="destructive" size="sm" onClick={() => denyUser(user.id, user.full_name || user.email)}>
                      <XCircle className="h-4 w-4 mr-1" /> Deny
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </SectionCard>
        )}

        <SectionCard
          title="Active System Users"
          icon={<Shield className="h-4 w-4 text-sky-500" />}
          accent="bg-gradient-to-r from-sky-500/60 to-sky-500/10"
          description="Manage roles and access for existing team members"
        >
          <div className="space-y-4 pt-2">
            {users.map((user) => (
              <div key={user.id} className="flex items-start justify-between p-4 border border-border/60 rounded-lg bg-muted/20 backdrop-blur-sm hover:border-sky-500/30 transition-colors">
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-2">
                    <Shield className="h-4 w-4 text-muted-foreground" />
                    <p className="text-foreground font-medium">{user.full_name || "Unnamed User"}</p>
                    {user.approval_status === 'denied' && <Badge variant="destructive" className="text-xs">Denied</Badge>}
                  </div>
                  <p className="text-sm text-muted-foreground mb-3">{user.email}</p>
                  <div className="flex flex-wrap gap-2">
                    {user.roles.length === 0 ? (
                      <Badge variant="outline" className="text-muted-foreground">No roles assigned</Badge>
                    ) : (
                      user.roles.map((userRole) => (
                        <Badge key={userRole.id} variant={ROLE_COLORS[userRole.role] as any} className="flex items-center gap-2">
                          {ROLE_LABELS[userRole.role]}
                          <Button type="button" variant="ghost" size="icon" onClick={() => removeRole(userRole.id, user.id, userRole.role)} className="ml-1 h-5 w-5 p-0">
                            <Trash2 className="h-3 w-3" />
                          </Button>
                        </Badge>
                      ))
                    )}
                  </div>
                </div>

                <div className="ml-4 flex items-center gap-2">
                  <Button variant="outline" size="icon" onClick={() => resetTwoFactor(user.id, user.email, user.full_name || user.email)} disabled={resettingUserId === user.id} title="Reset two-factor authentication">
                    {resettingUserId === user.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
                  </Button>
                  <Select onValueChange={(role) => addRole(user.id, role)}>
                    <SelectTrigger className="w-[180px]">
                      <SelectValue placeholder="Add role..." />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="admin">Admin</SelectItem>
                      <SelectItem value="staff">Staff</SelectItem>
                      <SelectItem value="mortgage_agent">Mortgage Agent</SelectItem>
                    </SelectContent>
                  </Select>
                  {user.roles.length > 0 && (
                    <Button variant="destructive" size="icon" onClick={() => removeAllRoles(user.id, user.full_name || user.email)} title="Remove all roles">
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  )}
                  <Button variant="destructive" size="icon" onClick={() => deleteUser(user.id, user.full_name || user.email)} title="Delete user">
                    <UserX className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            ))}
            {users.length === 0 && <div className="text-center py-8 text-muted-foreground">No users found</div>}
          </div>
        </SectionCard>
      </div>
    </div>
  );
}

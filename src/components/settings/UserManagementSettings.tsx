import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { UserPlus, Trash2, Shield, UserX, CheckCircle, XCircle, Clock, KeyRound, Loader2, Users } from "lucide-react";
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
};

const ROLE_COLORS: Record<string, string> = {
  admin: "destructive",
  staff: "default",
  client: "secondary",
  contractor: "outline",
  referrer: "outline",
  read_only: "secondary",
  guided: "outline",
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
        const hasStaffRole = u.roles.some(r => r.role === 'staff' || r.role === 'admin');
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
        description: `${userName} has been approved and can now access the system.`,
      });

      fetchUsers();
    } catch (error: any) {
      console.error("Failed to approve user", error);
      toast({
        title: "Error",
        description: error?.message || "Failed to approve user",
        variant: "destructive",
      });
    }
  };

  const denyUser = async (userId: string, userName: string) => {
    if (!confirm(`Are you sure you want to deny access to ${userName}? They will not be able to log in.`)) return;

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
      console.error("Failed to deny user", error);
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
          toast({
            title: "Info",
            description: "User already has this role",
            variant: "default",
          });
          setSelectedRoles(prev => ({ ...prev, [userId]: undefined }));
          return;
        }
        throw error;
      }

      toast({
        title: "Success",
        description: "Role added successfully",
      });

      setSelectedRoles(prev => ({ ...prev, [userId]: undefined }));
      fetchUsers();
    } catch (error: any) {
      console.error("Failed to add role", error);
      toast({
        title: "Error",
        description: error?.message || error?.details || "Failed to add role",
        variant: "destructive",
      });
    }
  };

  const removeRole = async (roleId: string, userId: string, role: string) => {
    if (userId === currentUserId && role === "admin") {
      toast({
        title: "Cannot Remove Your Own Admin Role",
        description: "You cannot remove your own admin role. Ask another admin to remove it if needed.",
        variant: "destructive",
      });
      return;
    }

    if (!confirm("Are you sure you want to remove this role?")) return;

    try {
      const { error } = await supabase
        .from("user_roles")
        .delete()
        .eq("id", roleId);

      if (error) throw error;

      toast({
        title: "Success",
        description: "Role removed successfully",
      });

      fetchUsers();
    } catch (error: any) {
      console.error("Failed to remove role", error);
      toast({
        title: "Error",
        description: error?.message || error?.details || "Failed to remove role",
        variant: "destructive",
      });
    }
  };

  const removeAllRoles = async (userId: string, userName: string) => {
    if (userId === currentUserId) {
      toast({
        title: "Cannot Remove Your Own Roles",
        description: "You cannot remove your own roles. Ask another admin to manage your access if needed.",
        variant: "destructive",
      });
      return;
    }

    if (!confirm(`Are you sure you want to remove all roles from ${userName}? This will remove their access to the system.`)) return;

    try {
      const { error } = await supabase
        .from("user_roles")
        .delete()
        .eq("user_id", userId);

      if (error) throw error;

      toast({
        title: "Success",
        description: "All roles removed successfully",
      });

      fetchUsers();
    } catch (error: any) {
      console.error("Failed to remove all roles", error);
      toast({
        title: "Error",
        description: error?.message || error?.details || "Failed to remove roles",
        variant: "destructive",
      });
    }
  };

  const deleteUser = async (userId: string, userName: string) => {
    if (userId === currentUserId) {
      toast({
        title: "Cannot Delete Your Own Account",
        description: "You cannot delete your own account. Ask another admin if needed.",
        variant: "destructive",
      });
      return;
    }

    if (!confirm(`Are you sure you want to PERMANENTLY DELETE ${userName}? This will remove their account, all roles, and cannot be undone.`)) return;

    try {
      const { error: rolesError } = await supabase
        .from("user_roles")
        .delete()
        .eq("user_id", userId);

      if (rolesError) throw rolesError;

      const { error: profileError } = await supabase
        .from("profiles")
        .delete()
        .eq("id", userId);

      if (profileError) throw profileError;

      toast({
        title: "Success",
        description: "User deleted successfully",
      });

      fetchUsers();
    } catch (error: any) {
      console.error("Failed to delete user", error);
      toast({
        title: "Error",
        description: error?.message || error?.details || "Failed to delete user",
        variant: "destructive",
      });
    }
  };

  const sendPasswordResetEmail = async (userId: string, userEmail: string, userName: string) => {
    if (!confirm(`Send password reset email to ${userName}?`)) return;

    try {
      setResettingUserId(userId);

      const { error } = await supabase.auth.resetPasswordForEmail(userEmail, {
        redirectTo: `${window.location.origin}/auth?reset=1`,
      });

      if (error) throw error;

      toast({
        title: "Reset email sent",
        description: `${userName} has been sent a password reset link.`,
      });
    } catch (error: any) {
      console.error("Failed to send password reset email", error);
      toast({
        title: "Error",
        description: error?.message || "Failed to send password reset email",
        variant: "destructive",
      });
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
            description="New staff members awaiting your approval to access the system"
          >
            <div className="space-y-3 pt-4">
              {pendingUsers.map((user) => (
                <div
                  key={user.id}
                  className="flex items-center justify-between p-4 border border-yellow-500/30 rounded-lg bg-background"
                >
                  <div>
                    <p className="font-medium">{user.full_name || "Unnamed User"}</p>
                    <p className="text-sm text-muted-foreground">{user.email}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => sendPasswordResetEmail(user.id, user.email, user.full_name || user.email)}
                      disabled={resettingUserId === user.id}
                    >
                      {resettingUserId === user.id ? (
                        <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                      ) : (
                        <KeyRound className="h-4 w-4 mr-1" />
                      )}
                      Reset Password
                    </Button>
                    <Button
                      variant="default"
                      size="sm"
                      onClick={() => approveUser(user.id, user.full_name || user.email)}
                      className="bg-green-600 hover:bg-green-700"
                    >
                      <CheckCircle className="h-4 w-4 mr-1" />
                      Approve
                    </Button>
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => denyUser(user.id, user.full_name || user.email)}
                    >
                      <XCircle className="h-4 w-4 mr-1" />
                      Deny
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </SectionCard>
        )}

        <SectionCard
          title="System Users"
          icon={<Shield className="h-4 w-4 text-sky-500" />}
          accent="bg-gradient-to-r from-sky-500/60 to-sky-500/10"
          description="Manage roles and access for existing team members"
        >
          <div className="space-y-4 pt-4">
            {users.map((user) => (
              <div
                key={user.id}
                className="flex items-start justify-between p-4 border border-border rounded-lg"
              >
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-2">
                    <Shield className="h-4 w-4 text-muted-foreground" />
                    <p className="text-foreground font-medium">
                      {user.full_name || "Unnamed User"}
                    </p>
                    {user.approval_status === 'denied' && (
                      <Badge variant="destructive" className="text-xs">Denied</Badge>
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground mb-3">{user.email}</p>
                  
                  <div className="flex flex-wrap gap-2">
                    {user.roles.length === 0 ? (
                      <Badge variant="outline" className="text-muted-foreground">
                        No roles assigned
                      </Badge>
                    ) : (
                      user.roles.map((userRole) => (
                        <Badge
                          key={userRole.id}
                          variant={ROLE_COLORS[userRole.role] as "default" | "destructive" | "outline" | "secondary"}
                          className="flex items-center gap-2"
                        >
                          {ROLE_LABELS[userRole.role]}
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            onClick={() => removeRole(userRole.id, user.id, userRole.role)}
                            className="ml-1 h-5 w-5 p-0"
                          >
                            <Trash2 className="h-3 w-3" />
                          </Button>
                        </Badge>
                      ))
                    )}
                  </div>
                </div>

                <div className="ml-4 flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => sendPasswordResetEmail(user.id, user.email, user.full_name || user.email)}
                    disabled={resettingUserId === user.id}
                    title="Send password reset email"
                  >
                    {resettingUserId === user.id ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <KeyRound className="h-4 w-4" />
                    )}
                  </Button>
                  <Select
                    value={selectedRoles[user.id]}
                    onValueChange={(role) => {
                      if (role) {
                        addRole(user.id, role);
                      }
                    }}
                  >
                    <SelectTrigger className="w-[180px]">
                      <SelectValue placeholder="Add role..." />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="admin">
                        <div className="flex items-center gap-2">
                          <UserPlus className="h-4 w-4" />
                          Admin
                        </div>
                      </SelectItem>
                      <SelectItem value="staff">
                        <div className="flex items-center gap-2">
                          <UserPlus className="h-4 w-4" />
                          Staff
                        </div>
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  
                  {user.roles.length > 0 && (
                    <Button
                      variant="destructive"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => removeAllRoles(user.id, user.full_name || user.email)}
                      title="Remove all roles from this user"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  )}
                  
                  <Button
                    variant="destructive"
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => deleteUser(user.id, user.full_name || user.email)}
                    title="Permanently delete this user"
                  >
                    <UserX className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            ))}

            {users.length === 0 && (
              <div className="text-center py-8 text-muted-foreground">
                No users found
              </div>
            )}
          </div>
          
          <div className="mt-6 p-4 bg-muted/30 rounded-lg border border-border/50">
            <div className="flex gap-3">
              <Shield className="h-5 w-5 text-muted-foreground flex-shrink-0 mt-0.5" />
              <div className="space-y-1 text-sm">
                <p className="font-medium text-foreground">Role Descriptions</p>
                <ul className="text-muted-foreground space-y-1 list-disc list-inside">
                  <li><strong>Admin:</strong> Full system access, can manage all settings and users</li>
                  <li><strong>Staff:</strong> Can manage claims, clients, and tasks (requires approval on signup)</li>
                </ul>
                <p className="text-muted-foreground mt-2 text-xs">
                  Clients, contractors, and referrers are managed on their respective pages.
                </p>
              </div>
            </div>
          </div>
        </SectionCard>
      </div>
    </div>
  );
}

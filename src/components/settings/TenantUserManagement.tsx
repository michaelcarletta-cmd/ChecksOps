import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { CredentialsDialog } from "@/components/CredentialsDialog";
import {
  Loader2,
  Plus,
  Search,
  UserMinus,
  Shield,
  ShieldCheck,
  Eye,
  Users,
  Mail,
  ChevronDown,
  ChevronUp,
} from "lucide-react";

interface TenantUserManagementProps {
  tenantId: string;
  tenantName: string;
  isOpen: boolean;
  onClose: () => void;
}

type TenantRole = "admin" | "operator" | "viewer";

interface TenantUser {
  id: string;
  user_id: string;
  role: TenantRole;
  created_at: string;
  email?: string;
  full_name?: string;
}

const ROLE_META: Record<TenantRole, { label: string; icon: React.ReactNode; color: string; description: string }> = {
  admin: {
    label: "Admin",
    icon: <ShieldCheck className="h-3.5 w-3.5" />,
    color: "text-amber-400 bg-amber-400/10 border-amber-400/20",
    description: "Full access — manage users, settings, and all checks",
  },
  operator: {
    label: "Operator",
    icon: <Shield className="h-3.5 w-3.5" />,
    color: "text-blue-400 bg-blue-400/10 border-blue-400/20",
    description: "Process checks, endorsements, and daily operations",
  },
  viewer: {
    label: "Viewer",
    icon: <Eye className="h-3.5 w-3.5" />,
    color: "text-muted-foreground bg-muted border-border",
    description: "Read-only access to checks and reports",
  },
};

type SortField = "name" | "email" | "role" | "created_at";
type SortDir = "asc" | "desc";

export function TenantUserManagement({ tenantId, tenantName, isOpen, onClose }: TenantUserManagementProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // State
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState<TenantRole | "all">("all");
  const [addOpen, setAddOpen] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [newName, setNewName] = useState("");
  const [newRole, setNewRole] = useState<TenantRole>("operator");
  const [removeTarget, setRemoveTarget] = useState<TenantUser | null>(null);
  const [sortField, setSortField] = useState<SortField>("name");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [credentialsDialog, setCredentialsDialog] = useState<{
    email: string;
    password: string;
    userName: string;
  } | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkRole, setBulkRole] = useState<TenantRole | "">("");

  // Fetch tenant users with auth user info
  const { data: users = [], isLoading } = useQuery({
    queryKey: ["tenant-users", tenantId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("tenant_users")
        .select("id, user_id, role, created_at")
        .eq("tenant_id", tenantId)
        .order("created_at", { ascending: false });

      if (error) throw error;

      // Fetch profile info for each user
      const userIds = data.map((u: any) => u.user_id);
      const { data: profiles } = await supabase
        .from("profiles")
        .select("id, full_name, email")
        .in("id", userIds);

      const profileMap = new Map(
        (profiles || []).map((p: any) => [p.id, p])
      );

      return data.map((u: any) => ({
        ...u,
        email: profileMap.get(u.user_id)?.email || "—",
        full_name: profileMap.get(u.user_id)?.full_name || "—",
      })) as TenantUser[];
    },
    enabled: isOpen,
  });

  // Filtered and sorted users
  const filteredUsers = useMemo(() => {
    let result = users.filter((u) => {
      const matchesSearch =
        !search ||
        u.email?.toLowerCase().includes(search.toLowerCase()) ||
        u.full_name?.toLowerCase().includes(search.toLowerCase());
      const matchesRole = roleFilter === "all" || u.role === roleFilter;
      return matchesSearch && matchesRole;
    });

    result.sort((a, b) => {
      let aVal: string, bVal: string;
      switch (sortField) {
        case "name":
          aVal = a.full_name || "";
          bVal = b.full_name || "";
          break;
        case "email":
          aVal = a.email || "";
          bVal = b.email || "";
          break;
        case "role":
          aVal = a.role;
          bVal = b.role;
          break;
        case "created_at":
          aVal = a.created_at;
          bVal = b.created_at;
          break;
        default:
          aVal = "";
          bVal = "";
      }
      const cmp = aVal.localeCompare(bVal);
      return sortDir === "asc" ? cmp : -cmp;
    });

    return result;
  }, [users, search, roleFilter, sortField, sortDir]);

  // Role counts
  const roleCounts = useMemo(() => {
    const counts = { admin: 0, operator: 0, viewer: 0 };
    users.forEach((u) => {
      if (u.role in counts) counts[u.role as TenantRole]++;
    });
    return counts;
  }, [users]);

  // Add user mutation
  const addUser = useMutation({
    mutationFn: async () => {
      const password = generatePassword();
      const { data, error } = await supabase.functions.invoke("create-tenant-user", {
        body: { email: newEmail, password, full_name: newName, tenant_id: tenantId, role: newRole },
      });

      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      return { email: newEmail, password, userName: newName, ...data };
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["tenant-users", tenantId] });
      setAddOpen(false);
      setNewEmail("");
      setNewName("");
      setNewRole("operator");
      setCredentialsDialog({
        email: data.email,
        password: data.password,
        userName: data.userName,
      });
    },
    onError: (err: any) => {
      toast({ title: "Failed to add user", description: err.message, variant: "destructive" });
    },
  });

  // Remove user mutation
  const removeUser = useMutation({
    mutationFn: async (userId: string) => {
      const { error } = await supabase
        .from("tenant_users")
        .delete()
        .eq("tenant_id", tenantId)
        .eq("user_id", userId);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tenant-users", tenantId] });
      setRemoveTarget(null);
      setSelectedIds(new Set());
      toast({ title: "User removed" });
    },
    onError: (err: any) => {
      toast({ title: "Failed to remove user", description: err.message, variant: "destructive" });
    },
  });

  // Change role mutation
  const changeRole = useMutation({
    mutationFn: async ({ userId, role }: { userId: string; role: TenantRole }) => {
      const { error } = await supabase
        .from("tenant_users")
        .update({ role })
        .eq("tenant_id", tenantId)
        .eq("user_id", userId);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tenant-users", tenantId] });
    },
    onError: (err: any) => {
      toast({ title: "Failed to change role", description: err.message, variant: "destructive" });
    },
  });

  // Bulk role change
  const bulkChangeRole = useMutation({
    mutationFn: async (role: TenantRole) => {
      const promises = Array.from(selectedIds).map((tuId) => {
        const user = users.find((u) => u.id === tuId);
        if (!user) return Promise.resolve();
        return supabase
          .from("tenant_users")
          .update({ role })
          .eq("id", tuId);
      });
      await Promise.all(promises);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tenant-users", tenantId] });
      setSelectedIds(new Set());
      setBulkRole("");
      toast({ title: "Roles updated" });
    },
  });

  // Bulk remove
  const bulkRemove = useMutation({
    mutationFn: async () => {
      const promises = Array.from(selectedIds).map((tuId) =>
        supabase.from("tenant_users").delete().eq("id", tuId)
      );
      await Promise.all(promises);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tenant-users", tenantId] });
      setSelectedIds(new Set());
      toast({ title: "Users removed" });
    },
  });

  const toggleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortField(field);
      setSortDir("asc");
    }
  };

  const SortIcon = ({ field }: { field: SortField }) => {
    if (sortField !== field) return null;
    return sortDir === "asc" ? (
      <ChevronUp className="h-3 w-3 inline ml-1" />
    ) : (
      <ChevronDown className="h-3 w-3 inline ml-1" />
    );
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === filteredUsers.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filteredUsers.map((u) => u.id)));
    }
  };

  const toggleSelect = (id: string) => {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedIds(next);
  };

  return (
    <>
      <Dialog open={isOpen} onOpenChange={onClose}>
        <DialogContent className="max-w-4xl max-h-[85vh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Users className="h-5 w-5" />
              {tenantName} — Users
            </DialogTitle>
            <DialogDescription>
              Manage who can access this tenant's Check Command Center.
            </DialogDescription>
          </DialogHeader>

          {/* Stats bar */}
          <div className="flex items-center gap-3 flex-wrap">
            <Badge variant="outline" className="text-xs">
              {users.length} total
            </Badge>
            {(Object.entries(roleCounts) as [TenantRole, number][]).map(([role, count]) => (
              <Badge
                key={role}
                variant="outline"
                className={`text-xs cursor-pointer ${roleFilter === role ? ROLE_META[role].color : ""}`}
                onClick={() => setRoleFilter(roleFilter === role ? "all" : role)}
              >
                {ROLE_META[role].icon}
                <span className="ml-1">
                  {count} {ROLE_META[role].label}{count !== 1 ? "s" : ""}
                </span>
              </Badge>
            ))}
          </div>

          {/* Toolbar */}
          <div className="flex items-center gap-2 flex-wrap">
            <div className="relative flex-1 min-w-[200px]">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search by name or email..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-9 h-9"
              />
            </div>

            {selectedIds.size > 0 && (
              <div className="flex items-center gap-2 bg-muted/50 rounded-md px-2 py-1">
                <span className="text-xs text-muted-foreground">{selectedIds.size} selected</span>
                <Select
                  value={bulkRole}
                  onValueChange={(val) => {
                    setBulkRole(val as TenantRole);
                    if (val) bulkChangeRole.mutate(val as TenantRole);
                  }}
                >
                  <SelectTrigger className="h-7 w-[120px] text-xs">
                    <SelectValue placeholder="Change role" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="admin">Admin</SelectItem>
                    <SelectItem value="operator">Operator</SelectItem>
                    <SelectItem value="viewer">Viewer</SelectItem>
                  </SelectContent>
                </Select>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs text-destructive hover:text-destructive"
                  onClick={() => bulkRemove.mutate()}
                >
                  <UserMinus className="h-3.5 w-3.5 mr-1" />
                  Remove
                </Button>
              </div>
            )}

            <Button size="sm" className="h-9" onClick={() => setAddOpen(true)}>
              <Plus className="h-4 w-4 mr-1" />
              Add User
            </Button>
          </div>

          {/* User table */}
          <div className="flex-1 overflow-auto border rounded-md">
            {isLoading ? (
              <div className="flex justify-center py-12">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : filteredUsers.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                <Users className="h-10 w-10 mb-3 opacity-40" />
                <p className="text-sm font-medium">
                  {users.length === 0 ? "No users yet" : "No matching users"}
                </p>
                <p className="text-xs mt-1">
                  {users.length === 0
                    ? "Add the first user to get started."
                    : "Try adjusting your search or filters."}
                </p>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10">
                      <input
                        type="checkbox"
                        checked={selectedIds.size === filteredUsers.length && filteredUsers.length > 0}
                        onChange={toggleSelectAll}
                        className="rounded border-muted-foreground/30"
                      />
                    </TableHead>
                    <TableHead
                      className="cursor-pointer select-none"
                      onClick={() => toggleSort("name")}
                    >
                      Name <SortIcon field="name" />
                    </TableHead>
                    <TableHead
                      className="cursor-pointer select-none"
                      onClick={() => toggleSort("email")}
                    >
                      Email <SortIcon field="email" />
                    </TableHead>
                    <TableHead
                      className="cursor-pointer select-none w-[140px]"
                      onClick={() => toggleSort("role")}
                    >
                      Role <SortIcon field="role" />
                    </TableHead>
                    <TableHead
                      className="cursor-pointer select-none"
                      onClick={() => toggleSort("created_at")}
                    >
                      Added <SortIcon field="created_at" />
                    </TableHead>
                    <TableHead className="w-10" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredUsers.map((user) => (
                    <TableRow key={user.id} className={selectedIds.has(user.id) ? "bg-muted/30" : ""}>
                      <TableCell>
                        <input
                          type="checkbox"
                          checked={selectedIds.has(user.id)}
                          onChange={() => toggleSelect(user.id)}
                          className="rounded border-muted-foreground/30"
                        />
                      </TableCell>
                      <TableCell className="font-medium">{user.full_name}</TableCell>
                      <TableCell className="text-muted-foreground text-sm">{user.email}</TableCell>
                      <TableCell>
                        <Select
                          value={user.role}
                          onValueChange={(val) =>
                            changeRole.mutate({ userId: user.user_id, role: val as TenantRole })
                          }
                        >
                          <SelectTrigger className="h-7 w-[120px] text-xs border-0 bg-transparent hover:bg-muted">
                            <div className="flex items-center gap-1.5">
                              <Badge
                                variant="outline"
                                className={`text-xs px-1.5 py-0 ${ROLE_META[user.role]?.color || ""}`}
                              >
                                {ROLE_META[user.role]?.icon}
                                <span className="ml-1">{ROLE_META[user.role]?.label || user.role}</span>
                              </Badge>
                            </div>
                          </SelectTrigger>
                          <SelectContent>
                            {(Object.entries(ROLE_META) as [TenantRole, typeof ROLE_META.admin][]).map(
                              ([key, meta]) => (
                                <SelectItem key={key} value={key}>
                                  <div className="flex items-center gap-2">
                                    {meta.icon}
                                    <div>
                                      <div className="font-medium text-xs">{meta.label}</div>
                                      <div className="text-[10px] text-muted-foreground">
                                        {meta.description}
                                      </div>
                                    </div>
                                  </div>
                                </SelectItem>
                              )
                            )}
                          </SelectContent>
                        </Select>
                      </TableCell>
                      <TableCell className="text-muted-foreground text-xs">
                        {new Date(user.created_at).toLocaleDateString()}
                      </TableCell>
                      <TableCell>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-muted-foreground hover:text-destructive"
                          title="Remove user"
                          onClick={() => setRemoveTarget(user)}
                        >
                          <UserMinus className="h-3.5 w-3.5" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Add User Dialog */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Add User to {tenantName}</DialogTitle>
            <DialogDescription>
              Create an account or add an existing user to this tenant.
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              addUser.mutate();
            }}
            className="space-y-4"
          >
            <div className="space-y-2">
              <Label>Full Name</Label>
              <Input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Jane Smith"
                required
              />
            </div>
            <div className="space-y-2">
              <Label>Email</Label>
              <Input
                type="email"
                value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
                placeholder="jane@company.com"
                required
              />
            </div>
            <div className="space-y-2">
              <Label>Role</Label>
              <Select value={newRole} onValueChange={(v) => setNewRole(v as TenantRole)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.entries(ROLE_META) as [TenantRole, typeof ROLE_META.admin][]).map(
                    ([key, meta]) => (
                      <SelectItem key={key} value={key}>
                        <div className="flex items-center gap-2">
                          {meta.icon}
                          <span>{meta.label}</span>
                          <span className="text-xs text-muted-foreground">— {meta.description}</span>
                        </div>
                      </SelectItem>
                    )
                  )}
                </SelectContent>
              </Select>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="outline" onClick={() => setAddOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={addUser.isPending || !newEmail || !newName}>
                {addUser.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                <Mail className="h-4 w-4 mr-1" />
                Create & Send Invite
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* Remove Confirmation */}
      <AlertDialog open={!!removeTarget} onOpenChange={() => setRemoveTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove User</AlertDialogTitle>
            <AlertDialogDescription>
              Remove <strong>{removeTarget?.full_name || removeTarget?.email}</strong> from{" "}
              <strong>{tenantName}</strong>? They will lose access to the Check Command Center
              immediately. Their account will not be deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => removeTarget && removeUser.mutate(removeTarget.user_id)}
            >
              {removeUser.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Credentials Dialog */}
      {credentialsDialog && (
        <CredentialsDialog
          isOpen={true}
          onClose={() => setCredentialsDialog(null)}
          email={credentialsDialog.email}
          password={credentialsDialog.password}
          userType="Tenant User"
          userName={credentialsDialog.userName}
          tenantName={tenantName}
        />
      )}
    </>
  );
}

function generatePassword(): string {
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const lower = "abcdefghjkmnpqrstuvwxyz";
  const digits = "23456789";
  const specials = "!@#$%&";
  const all = upper + lower + digits + specials;
  // Guarantee at least one of each category
  let password = "";
  password += upper.charAt(Math.floor(Math.random() * upper.length));
  password += lower.charAt(Math.floor(Math.random() * lower.length));
  password += digits.charAt(Math.floor(Math.random() * digits.length));
  password += specials.charAt(Math.floor(Math.random() * specials.length));
  for (let i = 0; i < 8; i++) {
    password += all.charAt(Math.floor(Math.random() * all.length));
  }
  // Shuffle
  return password.split("").sort(() => Math.random() - 0.5).join("");
}

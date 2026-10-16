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

// Owner policy: every member of the tenant is a user with the same rights.
// There are no roles to pick or change; tenant_users.role is ignored.
interface TenantUser {
  id: string;
  user_id: string;
  created_at: string;
  email?: string;
  full_name?: string;
}

type SortField = "name" | "email" | "created_at";
type SortDir = "asc" | "desc";

export function TenantUserManagement({ tenantId, tenantName, isOpen, onClose }: TenantUserManagementProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // State
  const [search, setSearch] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [newName, setNewName] = useState("");
  const [removeTarget, setRemoveTarget] = useState<TenantUser | null>(null);
  const [sortField, setSortField] = useState<SortField>("name");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [credentialsDialog, setCredentialsDialog] = useState<{
    email: string;
    password: string;
    userName: string;
  } | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Fetch tenant users with auth user info
  const { data: users = [], isLoading } = useQuery({
    queryKey: ["tenant-users", tenantId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("tenant_users")
        .select("id, user_id, created_at")
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
      return matchesSearch;
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
  }, [users, search, sortField, sortDir]);

  // Add user mutation
  const addUser = useMutation({
    mutationFn: async () => {
      const password = generatePassword();
      const { data, error } = await supabase.functions.invoke("create-tenant-user", {
        body: { email: newEmail, password, full_name: newName, tenant_id: tenantId },
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
              Manage who can access this tenant's ChecksOps workspace.
            </DialogDescription>
          </DialogHeader>

          {/* Stats bar */}
          <div className="flex items-center gap-3 flex-wrap">
            <Badge variant="outline" className="text-xs">
              {users.length} total
            </Badge>
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
              <strong>{tenantName}</strong>? They will lose access to the ChecksOps workspace
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
  const specials = "!#&*+-?";
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

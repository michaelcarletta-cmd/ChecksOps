import { useState, useEffect } from "react";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { Building2, UserPlus, Trash2, Crown, Shield, User, Pencil, Check, ChevronsUpDown, Sparkles, Users } from "lucide-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
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
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { SectionCard } from "./SectionCard";
import { SettingsHero } from "./SettingsHero";

interface Org {
  id: string;
  name: string;
  slug: string;
  domain: string | null;
  created_at: string;
}

export function OrganizationSettings() {
  const { user } = useAuth();
  const [userOrg, setUserOrg] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [isCreating, setIsCreating] = useState(false);
  const [newOrgName, setNewOrgName] = useState("");
  const [newOrgSlug, setNewOrgSlug] = useState("");
  const [newOrgDomain, setNewOrgDomain] = useState("");
  const [showCreateDialog, setShowCreateDialog] = useState(false);

  // Edit org state
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [editOrgName, setEditOrgName] = useState("");
  const [editOrgSlug, setEditOrgSlug] = useState("");
  const [editOrgDomain, setEditOrgDomain] = useState("");
  const [isEditing, setIsEditing] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  // Members state
  const [orgMembers, setOrgMembers] = useState<any[]>([]);
  const [availableUsers, setAvailableUsers] = useState<any[]>([]);
  const [selectedUserId, setSelectedUserId] = useState<string>("");
  const [newMemberRole, setNewMemberRole] = useState("member");
  const [showAddMemberDialog, setShowAddMemberDialog] = useState(false);
  const [isAddingMember, setIsAddingMember] = useState(false);
  const [userSearchOpen, setUserSearchOpen] = useState(false);

  useEffect(() => {
    if (user) {
      fetchUserOrg();
      fetchAvailableUsers();
    }
  }, [user]);

  const fetchUserOrg = async () => {
    try {
      const { data, error } = await supabase
        .from("organization_members")
        .select(`
          *,
          orgs:organization_id (*)
        `)
        .eq("user_id", user?.id)
        .maybeSingle();

      if (error) throw error;
      setUserOrg(data);

      if (data?.organization_id) {
        fetchOrgMembers(data.organization_id);
      }
    } catch (error) {
      console.error("Error fetching org:", error);
    } finally {
      setLoading(false);
    }
  };

  const fetchOrgMembers = async (orgId: string) => {
    try {
      const { data, error } = await supabase
        .from("organization_members")
        .select(`
          *,
          profiles:user_id (full_name, email)
        `)
        .eq("organization_id", orgId);

      if (error) throw error;
      setOrgMembers(data || []);
    } catch (error) {
      console.error("Error fetching members:", error);
    }
  };

  const fetchAvailableUsers = async () => {
    try {
      const { data, error } = await supabase
        .from("profiles")
        .select("id, full_name, email")
        .limit(100);

      if (error) throw error;
      setAvailableUsers(data || []);
    } catch (error) {
      console.error("Error fetching users:", error);
    }
  };

  const handleCreateOrg = async () => {
    if (!newOrgName || !newOrgSlug) {
      toast.error("Name and slug are required");
      return;
    }

    setIsCreating(true);
    try {
      // 1. Create organization
      const { data: org, error: orgError } = await supabase
        .from("organizations")
        .insert({
          name: newOrgName,
          slug: newOrgSlug,
          domain: newOrgDomain || null,
        })
        .select()
        .single();

      if (orgError) throw orgError;

      // 2. Add current user as owner
      const { error: memberError } = await supabase
        .from("organization_members")
        .insert({
          organization_id: org.id,
          user_id: user?.id,
          role: "owner",
        });

      if (memberError) throw memberError;

      toast.success("Organization created successfully");
      setShowCreateDialog(false);
      fetchUserOrg();
    } catch (error: any) {
      console.error("Error creating org:", error);
      toast.error(error.message || "Failed to create organization");
    } finally {
      setIsCreating(false);
    }
  };

  const handleEditOrg = async () => {
    if (!editOrgName || !editOrgSlug) {
      toast.error("Name and slug are required");
      return;
    }

    setIsEditing(true);
    try {
      const { error } = await supabase
        .from("organizations")
        .update({
          name: editOrgName,
          slug: editOrgSlug,
          domain: editOrgDomain || null,
        })
        .eq("id", userOrg.organization_id);

      if (error) throw error;

      toast.success("Organization updated");
      setShowEditDialog(false);
      fetchUserOrg();
    } catch (error: any) {
      toast.error(error.message || "Failed to update organization");
    } finally {
      setIsEditing(false);
    }
  };

  const handleDeleteOrg = async () => {
    setIsDeleting(true);
    try {
      const { error } = await supabase
        .from("organizations")
        .delete()
        .eq("id", userOrg.organization_id);

      if (error) throw error;

      toast.success("Organization deleted");
      setUserOrg(null);
    } catch (error: any) {
      toast.error(error.message || "Failed to delete organization");
    } finally {
      setIsDeleting(false);
    }
  };

  const handleAddMember = async () => {
    if (!selectedUserId) {
      toast.error("Please select a user");
      return;
    }

    setIsAddingMember(true);
    try {
      const { error } = await supabase
        .from("organization_members")
        .insert({
          organization_id: userOrg.organization_id,
          user_id: selectedUserId,
          role: newMemberRole as any,
        });

      if (error) throw error;

      toast.success("Member added");
      setShowAddMemberDialog(false);
      setSelectedUserId("");
      fetchOrgMembers(userOrg.organization_id);
    } catch (error: any) {
      toast.error(error.message || "Failed to add member");
    } finally {
      setIsAddingMember(false);
    }
  };

  const handleRemoveMember = async (memberId: string) => {
    try {
      const { error } = await supabase
        .from("organization_members")
        .delete()
        .eq("id", memberId);

      if (error) throw error;

      toast.success("Member removed");
      fetchOrgMembers(userOrg.organization_id);
    } catch (error: any) {
      toast.error(error.message || "Failed to remove member");
    }
  };

  const handleUpdateRole = async (memberId: string, role: string) => {
    try {
      const { error } = await supabase
        .from("organization_members")
        .update({ role: role as any })
        .eq("id", memberId);

      if (error) throw error;

      toast.success("Role updated");
      fetchOrgMembers(userOrg.organization_id);
    } catch (error: any) {
      toast.error(error.message || "Failed to update role");
    }
  };

  const openEditDialog = (org: Org) => {
    setEditOrgName(org.name);
    setEditOrgSlug(org.slug);
    setEditOrgDomain(org.domain || "");
    setShowEditDialog(true);
  };

  const getRoleIcon = (role: string) => {
    switch (role) {
      case "owner":
        return <Crown className="h-4 w-4 text-yellow-500" />;
      case "admin":
        return <Shield className="h-4 w-4 text-blue-500" />;
      default:
        return <User className="h-4 w-4 text-gray-400" />;
    }
  };

  if (loading) return <div>Loading organization...</div>;

  const isOrgOwner = userOrg?.role === "owner";
  const isOrgAdmin = ["owner", "admin"].includes(userOrg?.role);

  if (!userOrg) {
    return (
      <div className="space-y-6">
        <SettingsHero
          title="Organization"
          description="Create an organization to enable workspace collaboration with partner companies"
          badge="Collaboration"
          icon={<Building2 className="h-4 w-4 text-primary" />}
        />

        <SectionCard
          title="Setup Organization"
          icon={<Building2 className="h-4 w-4 text-sky-500" />}
          accent="bg-gradient-to-r from-sky-500/60 to-sky-500/10"
          description="Create your company organization to collaborate with partners"
        >
          <div className="max-w-md space-y-4">
            <p className="text-sm text-muted-foreground">
              You aren't part of an organization yet. Create one to manage team members 
              and collaborate with other companies.
            </p>
            <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
              <DialogTrigger asChild>
                <Button>
                  <Building2 className="h-4 w-4 mr-2" />
                  Create Organization
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Create Organization</DialogTitle>
                  <DialogDescription>
                    Enter your company details to get started
                  </DialogDescription>
                </DialogHeader>
                <div className="space-y-4">
                  <div className="space-y-2">
                    <Label>Organization Name</Label>
                    <Input
                      placeholder="e.g., Freedom Claims"
                      value={newOrgName}
                      onChange={(e) => {
                        setNewOrgName(e.target.value);
                        if (!newOrgSlug) {
                          setNewOrgSlug(e.target.value.toLowerCase().replace(/\s+/g, '-'));
                        }
                      }}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Slug (URL-friendly identifier)</Label>
                    <Input
                      placeholder="e.g., freedom-claims"
                      value={newOrgSlug}
                      onChange={(e) => setNewOrgSlug(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Domain (optional)</Label>
                    <Input
                      placeholder="e.g., freedomclaims.com"
                      value={newOrgDomain}
                      onChange={(e) => setNewOrgDomain(e.target.value)}
                    />
                    <p className="text-xs text-muted-foreground">
                      Users with this email domain can auto-join your organization
                    </p>
                  </div>
                </div>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setShowCreateDialog(false)}>
                    Cancel
                  </Button>
                  <Button onClick={handleCreateOrg} disabled={isCreating}>
                    {isCreating ? "Creating..." : "Create Organization"}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>
        </SectionCard>
      </div>
    );
  }

  // Has organization - show details
  const org = userOrg.orgs as unknown as Org;

  return (
    <div className="space-y-6">
      <SettingsHero
        title={org.name}
        description="Manage your company organization and collaborate with partners."
        badge="Organization Settings"
        icon={<Building2 className="h-4 w-4 text-primary" />}
      />

      <div className="grid gap-6">
        <SectionCard
          title="Organization Details"
          icon={<Building2 className="h-4 w-4 text-sky-500" />}
          accent="bg-gradient-to-r from-sky-500/60 to-sky-500/10"
        >
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <Label className="text-muted-foreground">Slug</Label>
              <p className="font-medium">{org.slug}</p>
            </div>
            <div>
              <Label className="text-muted-foreground">Domain</Label>
              <p className="font-medium">{org.domain || "Not set"}</p>
            </div>
          </div>

          <div className="flex justify-between items-center mt-4 pt-4 border-t">
            <div className="text-xs text-muted-foreground">
              Created {new Date(org.created_at).toLocaleDateString()}
            </div>
            {isOrgOwner && (
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={() => openEditDialog(org)}>
                  <Pencil className="h-4 w-4 mr-2" />
                  Edit Details
                </Button>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="destructive" size="sm">
                      <Trash2 className="h-4 w-4 mr-2" />
                      Delete
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Delete Organization</AlertDialogTitle>
                      <AlertDialogDescription>
                        Are you sure you want to delete "{org.name}"? This action cannot be undone. 
                        All team members will be removed and workspace memberships will be lost.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction
                        onClick={handleDeleteOrg}
                        disabled={isDeleting}
                        className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                      >
                        {isDeleting ? "Deleting..." : "Delete Organization"}
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            )}
          </div>
        </SectionCard>

        <SectionCard
          title="Team Members"
          icon={<Users className="h-4 w-4 text-violet-500" />}
          accent="bg-gradient-to-r from-violet-500/60 to-violet-500/10"
          description="Manage who has access to your organization"
        >
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Role</TableHead>
                {isOrgAdmin && <TableHead className="w-12"></TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {orgMembers?.map((member: any) => (
                <TableRow key={member.id}>
                  <TableCell className="font-medium">
                    {member.profiles?.full_name || "—"}
                  </TableCell>
                  <TableCell>{member.profiles?.email}</TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      {getRoleIcon(member.role)}
                      {isOrgAdmin && member.role !== "owner" ? (
                        <Select
                          value={member.role}
                          onValueChange={(value) => handleUpdateRole(member.id, value)}
                        >
                          <SelectTrigger className="w-24 h-8">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="member">Member</SelectItem>
                            <SelectItem value="admin">Admin</SelectItem>
                          </SelectContent>
                        </Select>
                      ) : (
                        <Badge variant={member.role === "owner" ? "default" : "secondary"}>
                          {member.role}
                        </Badge>
                      )}
                    </div>
                  </TableCell>
                  {isOrgAdmin && (
                    <TableCell>
                      {member.role !== "owner" && (
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => handleRemoveMember(member.id)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      )}
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>

          {isOrgAdmin && (
            <div className="mt-6 flex justify-end">
              <Dialog open={showAddMemberDialog} onOpenChange={setShowAddMemberDialog}>
                <DialogTrigger asChild>
                  <Button>
                    <UserPlus className="h-4 w-4 mr-2" />
                    Add Team Member
                  </Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Add Team Member</DialogTitle>
                    <DialogDescription>
                      Add a staff member to your organization
                    </DialogDescription>
                  </DialogHeader>
                  <div className="space-y-4">
                    <div className="space-y-2">
                      <Label>Staff Member</Label>
                      <Popover open={userSearchOpen} onOpenChange={setUserSearchOpen}>
                        <PopoverTrigger asChild>
                          <Button
                            variant="outline"
                            role="combobox"
                            aria-expanded={userSearchOpen}
                            className="w-full justify-between"
                          >
                            {selectedUserId
                              ? availableUsers?.find((user) => user.id === selectedUserId)?.email
                              : "Search users..."}
                            <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                          </Button>
                        </PopoverTrigger>
                        <PopoverContent className="w-[400px] p-0">
                          <Command>
                            <CommandInput placeholder="Search staff members..." />
                            <CommandList>
                              <CommandEmpty>No staff members found.</CommandEmpty>
                              <CommandGroup>
                                {availableUsers?.map((user) => (
                                  <CommandItem
                                    key={user.id}
                                    value={user.email}
                                    onSelect={() => {
                                      setSelectedUserId(user.id);
                                      setUserSearchOpen(false);
                                    }}
                                  >
                                    <Check
                                      className={cn(
                                        "mr-2 h-4 w-4",
                                        selectedUserId === user.id ? "opacity-100" : "opacity-0"
                                      )}
                                    />
                                    <div className="flex flex-col">
                                      <span>{user.full_name}</span>
                                      <span className="text-xs text-muted-foreground">{user.email}</span>
                                    </div>
                                  </CommandItem>
                                ))}
                              </CommandGroup>
                            </CommandList>
                          </Command>
                        </PopoverContent>
                      </Popover>
                    </div>
                    <div className="space-y-2">
                      <Label>Role</Label>
                      <Select value={newMemberRole} onValueChange={setNewMemberRole}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="member">Member</SelectItem>
                          <SelectItem value="admin">Admin</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  <DialogFooter>
                    <Button variant="outline" onClick={() => setShowAddMemberDialog(false)}>
                      Cancel
                    </Button>
                    <Button onClick={handleAddMember} disabled={isAddingMember}>
                      {isAddingMember ? "Adding..." : "Add Member"}
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </div>
          )}
        </SectionCard>
      </div>

      {/* Edit Organization Dialog */}
      <Dialog open={showEditDialog} onOpenChange={setShowEditDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Organization</DialogTitle>
            <DialogDescription>
              Update your organization details
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Organization Name</Label>
              <Input
                placeholder="e.g., Freedom Claims"
                value={editOrgName}
                onChange={(e) => setEditOrgName(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label>Slug (URL-friendly identifier)</Label>
              <Input
                placeholder="e.g., freedom-claims"
                value={editOrgSlug}
                onChange={(e) => setEditOrgSlug(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label>Domain (optional)</Label>
              <Input
                placeholder="e.g., freedomclaims.com"
                value={editOrgDomain}
                onChange={(e) => setEditOrgDomain(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowEditDialog(false)}>
              Cancel
            </Button>
            <Button onClick={handleEditOrg} disabled={isEditing}>
              {isEditing ? "Saving..." : "Save Changes"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

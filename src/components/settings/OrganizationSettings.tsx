import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Building2, UserPlus, Trash2, Crown, Shield, User, Pencil, Check, ChevronsUpDown, Sparkles } from "lucide-react";
import { SectionCard } from "./SectionCard";
import { SettingsHero } from "./SettingsHero";
import { useQuery, useQueryClient } from "@tanstack/react-query";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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

interface OrgMember {
  id: string;
  user_id: string;
  role: string;
  created_at: string;
  profiles?: {
    email: string;
    full_name: string | null;
  };
}

interface Org {
  id: string;
  name: string;
  slug: string;
  domain: string | null;
  logo_url: string | null;
  created_at: string;
}

export function OrganizationSettings() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [isCreating, setIsCreating] = useState(false);
  const [isAddingMember, setIsAddingMember] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [newOrgName, setNewOrgName] = useState("");
  const [newOrgSlug, setNewOrgSlug] = useState("");
  const [newOrgDomain, setNewOrgDomain] = useState("");
  const [newMemberRole, setNewMemberRole] = useState("member");
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [showAddMemberDialog, setShowAddMemberDialog] = useState(false);
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [editOrgName, setEditOrgName] = useState("");
  const [editOrgSlug, setEditOrgSlug] = useState("");
  const [editOrgDomain, setEditOrgDomain] = useState("");
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [userSearchOpen, setUserSearchOpen] = useState(false);

  // Get current user's organization
  const { data: userOrg, isLoading: loadingOrg } = useQuery({
    queryKey: ["user-organization"],
    queryFn: async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return null;

      const { data: membership } = await supabase
        .from("org_members")
        .select(`
          *,
          orgs (*)
        `)
        .eq("user_id", user.id)
        .maybeSingle();

      return membership;
    },
  });

  // Get organization members
  const { data: orgMembers, isLoading: loadingMembers } = useQuery({
    queryKey: ["org-members", userOrg?.org_id],
    queryFn: async () => {
      if (!userOrg?.org_id) return [];

      const { data } = await supabase
        .from("org_members")
        .select(`
          *,
          profiles:user_id (
            email,
            full_name
          )
        `)
        .eq("org_id", userOrg.org_id)
        .order("created_at");

      return data || [];
    },
    enabled: !!userOrg?.org_id,
  });

  // Get available staff/admin users who aren't already org members
  const { data: availableUsers } = useQuery({
    queryKey: ["available-org-users", userOrg?.org_id],
    queryFn: async () => {
      // Get staff and admin user IDs
      const { data: staffRoles } = await supabase
        .from("user_roles")
        .select("user_id")
        .in("role", ["staff", "admin"]);

      if (!staffRoles || staffRoles.length === 0) return [];

      const staffUserIds = staffRoles.map(r => r.user_id);

      // Get existing org member user IDs
      const existingMemberIds = orgMembers?.map((m: any) => m.user_id) || [];

      // Get profiles for staff/admin users who aren't already members
      const { data: profiles } = await supabase
        .from("profiles")
        .select("id, email, full_name")
        .in("id", staffUserIds)
        .not("id", "in", existingMemberIds.length > 0 ? `(${existingMemberIds.join(",")})` : "(00000000-0000-0000-0000-000000000000)");

      return profiles || [];
    },
    enabled: !!userOrg?.org_id && !!orgMembers,
  });

  const handleCreateOrg = async () => {
    if (!newOrgName.trim() || !newOrgSlug.trim()) {
      toast({
        title: "Error",
        description: "Organization name and slug are required",
        variant: "destructive",
      });
      return;
    }

    setIsCreating(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Not authenticated");

      // Create the organization
      const { data: newOrg, error: orgError } = await supabase
        .from("orgs")
        .insert({
          name: newOrgName.trim(),
          slug: newOrgSlug.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-"),
          domain: newOrgDomain.trim() || null,
        })
        .select()
        .single();

      if (orgError) throw orgError;

      // Add current user as owner
      const { error: memberError } = await supabase
        .from("org_members")
        .insert({
          org_id: newOrg.id,
          user_id: user.id,
          role: "owner",
        });

      if (memberError) throw memberError;

      toast({
        title: "Success",
        description: "Organization created successfully",
      });

      setShowCreateDialog(false);
      setNewOrgName("");
      setNewOrgSlug("");
      setNewOrgDomain("");
      queryClient.invalidateQueries({ queryKey: ["user-organization"] });
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    } finally {
      setIsCreating(false);
    }
  };

  const handleEditOrg = async () => {
    if (!editOrgName.trim() || !editOrgSlug.trim() || !userOrg?.org_id) {
      toast({
        title: "Error",
        description: "Organization name and slug are required",
        variant: "destructive",
      });
      return;
    }

    setIsEditing(true);
    try {
      const { error } = await supabase
        .from("orgs")
        .update({
          name: editOrgName.trim(),
          slug: editOrgSlug.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-"),
          domain: editOrgDomain.trim() || null,
        })
        .eq("id", userOrg.org_id);

      if (error) throw error;

      toast({
        title: "Success",
        description: "Organization updated successfully",
      });

      setShowEditDialog(false);
      queryClient.invalidateQueries({ queryKey: ["user-organization"] });
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    } finally {
      setIsEditing(false);
    }
  };

  const handleDeleteOrg = async () => {
    if (!userOrg?.org_id) return;

    setIsDeleting(true);
    try {
      // Delete all org members first (cascade should handle this, but being explicit)
      await supabase
        .from("org_members")
        .delete()
        .eq("org_id", userOrg.org_id);

      // Delete the organization
      const { error } = await supabase
        .from("orgs")
        .delete()
        .eq("id", userOrg.org_id);

      if (error) throw error;

      toast({
        title: "Success",
        description: "Organization deleted successfully",
      });

      queryClient.invalidateQueries({ queryKey: ["user-organization"] });
      queryClient.invalidateQueries({ queryKey: ["org-members"] });
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    } finally {
      setIsDeleting(false);
    }
  };

  const openEditDialog = (org: Org) => {
    setEditOrgName(org.name);
    setEditOrgSlug(org.slug);
    setEditOrgDomain(org.domain || "");
    setShowEditDialog(true);
  };

  const handleAddMember = async () => {
    if (!selectedUserId || !userOrg?.org_id) {
      toast({
        title: "Error",
        description: "Please select a user",
        variant: "destructive",
      });
      return;
    }

    setIsAddingMember(true);
    try {
      // Add member
      const { error } = await supabase
        .from("org_members")
        .insert({
          org_id: userOrg.org_id,
          user_id: selectedUserId,
          role: newMemberRole,
        });

      if (error) throw error;

      toast({
        title: "Success",
        description: "Member added successfully",
      });

      setShowAddMemberDialog(false);
      setSelectedUserId(null);
      setNewMemberRole("member");
      queryClient.invalidateQueries({ queryKey: ["org-members"] });
      queryClient.invalidateQueries({ queryKey: ["available-org-users"] });
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    } finally {
      setIsAddingMember(false);
    }
  };

  const handleRemoveMember = async (memberId: string) => {
    try {
      const { error } = await supabase
        .from("org_members")
        .delete()
        .eq("id", memberId);

      if (error) throw error;

      toast({
        title: "Success",
        description: "Member removed",
      });
      queryClient.invalidateQueries({ queryKey: ["org-members"] });
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    }
  };

  const handleUpdateRole = async (memberId: string, newRole: string) => {
    try {
      const { error } = await supabase
        .from("org_members")
        .update({ role: newRole })
        .eq("id", memberId);

      if (error) throw error;

      toast({
        title: "Success",
        description: "Role updated",
      });
      queryClient.invalidateQueries({ queryKey: ["org-members"] });
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    }
  };

  const getRoleIcon = (role: string) => {
    switch (role) {
      case "owner":
        return <Crown className="h-4 w-4 text-yellow-500" />;
      case "admin":
        return <Shield className="h-4 w-4 text-blue-500" />;
      default:
        return <User className="h-4 w-4 text-muted-foreground" />;
    }
  };

  const isOrgAdmin = userOrg?.role === "owner" || userOrg?.role === "admin";
  const isOrgOwner = userOrg?.role === "owner";

  if (loadingOrg) {
    return (
      <Card>
        <CardContent className="py-8">
          <div className="text-center text-muted-foreground">Loading...</div>
        </CardContent>
      </Card>
    );
  }

  // No organization - show create prompt
  if (!userOrg) {
    return (
      <Card>
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
                  Set up your company organization to collaborate with partners
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label>Organization Name</Label>
                  <Input
                    placeholder="e.g., Freedom Claims"
                    value={newOrgName}
                    onChange={(e) => setNewOrgName(e.target.value)}
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
        </SectionCard>
      </div>
    );
  }

  // Has organization - show details
  const org = userOrg.orgs as unknown as Org;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex flex-row items-start justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Building2 className="h-5 w-5" />
              {org.name}
            </CardTitle>
            <CardDescription>
              Manage your organization settings
            </CardDescription>
          </div>
          {isOrgOwner && (
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => openEditDialog(org)}>
                <Pencil className="h-4 w-4 mr-2" />
                Edit
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
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label className="text-muted-foreground">Slug</Label>
              <p className="font-medium">{org.slug}</p>
            </div>
            <div>
              <Label className="text-muted-foreground">Domain</Label>
              <p className="font-medium">{org.domain || "Not set"}</p>
            </div>
          </div>
        </CardContent>
      </Card>

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
              <p className="text-xs text-muted-foreground">
                Partners use this slug to invite your organization to workspaces
              </p>
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

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle>Organization Members</CardTitle>
            <CardDescription>
              Staff members in your organization who can access shared workspaces
            </CardDescription>
          </div>
          {isOrgAdmin && (
            <Dialog open={showAddMemberDialog} onOpenChange={setShowAddMemberDialog}>
              <DialogTrigger asChild>
                <Button size="sm">
                  <UserPlus className="h-4 w-4 mr-2" />
                  Add Member
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Add Organization Member</DialogTitle>
                  <DialogDescription>
                    Add an existing user to your organization
                  </DialogDescription>
                </DialogHeader>
                <div className="space-y-4">
                  <div className="space-y-2">
                    <Label>Select User</Label>
                    <Popover open={userSearchOpen} onOpenChange={setUserSearchOpen}>
                      <PopoverTrigger asChild>
                        <Button
                          variant="outline"
                          role="combobox"
                          aria-expanded={userSearchOpen}
                          className="w-full justify-between"
                        >
                          {selectedUserId
                            ? availableUsers?.find((user) => user.id === selectedUserId)?.full_name ||
                              availableUsers?.find((user) => user.id === selectedUserId)?.email
                            : "Select a user..."}
                          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent className="w-full p-0 bg-popover" align="start">
                        <Command>
                          <CommandInput placeholder="Search users..." />
                          <CommandList>
                            <CommandEmpty>No users found.</CommandEmpty>
                            <CommandGroup>
                              {availableUsers?.map((user) => (
                                <CommandItem
                                  key={user.id}
                                  value={`${user.full_name || ""} ${user.email}`}
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
                                    <span>{user.full_name || "—"}</span>
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
          )}
        </CardHeader>
        <CardContent>
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
                          <SelectItem value="owner">Owner</SelectItem>
                          <SelectItem value="admin">Admin</SelectItem>
                          <SelectItem value="member">Member</SelectItem>
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
    </div>
  );
}

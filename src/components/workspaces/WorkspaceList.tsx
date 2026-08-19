import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Folder, Plus, Users, Building2, ExternalLink, Sparkles, Share2 } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { SettingsHero } from "@/components/settings/SettingsHero";
import { SectionCard } from "@/components/settings/SectionCard";

interface Workspace {
  id: string;
  name: string;
  description: string | null;
  owner_org_id: string;
  created_at: string;
  owner_org?: {
    name: string;
    slug: string;
  };
  workspace_members?: {
    org_id: string;
    role: string;
    status: string;
    orgs?: {
      name: string;
    };
  }[];
  claims?: {
    id: string;
  }[];
}

interface WorkspaceListProps {
  embedded?: boolean;
}

export function WorkspaceList({ embedded }: WorkspaceListProps = {}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [isCreating, setIsCreating] = useState(false);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [newWorkspaceName, setNewWorkspaceName] = useState("");
  const [newWorkspaceDescription, setNewWorkspaceDescription] = useState("");

  // Get user's organization
  const { data: userOrg } = useQuery({
    queryKey: ["user-organization"],
    queryFn: async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return null;

      const { data } = await supabase
        .from("org_members")
        .select("*, orgs (*)")
        .eq("user_id", user.id)
        .maybeSingle();

      return data;
    },
  });

  // Get workspaces the user's org has access to
  const { data: workspaces, isLoading } = useQuery({
    queryKey: ["workspaces", userOrg?.org_id],
    queryFn: async () => {
      if (!userOrg?.org_id) return [];

      const { data } = await supabase
        .from("workspace_members")
        .select(`
          workspace_id,
          role,
          status,
          workspaces!inner (
            id,
            name,
            description,
            owner_org_id,
            created_at,
            owner_org:orgs!owner_org_id (
              name,
              slug
            )
          )
        `)
        .eq("org_id", userOrg.org_id)
        .eq("status", "active");

      // Get member counts and claim counts for each workspace
      const workspacesWithDetails = await Promise.all(
        (data || []).map(async (item: any) => {
          const workspace = item.workspaces;
          
          // Get member orgs
          const { data: members } = await supabase
            .from("workspace_members")
            .select("org_id, role, status, orgs (name)")
            .eq("workspace_id", workspace.id)
            .eq("status", "active");

          // Get claim count
          const { count } = await supabase
            .from("claims")
            .select("id", { count: "exact", head: true })
            .eq("workspace_id", workspace.id);

          return {
            ...workspace,
            memberRole: item.role,
            workspace_members: members,
            claimCount: count || 0,
          };
        })
      );

      return workspacesWithDetails;
    },
    enabled: !!userOrg?.org_id,
  });

  // Get pending invites
  const { data: invites } = useQuery({
    queryKey: ["workspace-invites", userOrg?.org_id],
    queryFn: async () => {
      if (!userOrg?.org_id) return [];

      const { data } = await supabase
        .from("workspace_invites")
        .select(`
          *,
          workspaces (
            name,
            owner_org:orgs!owner_org_id (name)
          )
        `)
        .eq("invited_org_id", userOrg.org_id)
        .eq("status", "pending");

      return data || [];
    },
    enabled: !!userOrg?.org_id,
  });

  const handleCreateWorkspace = async () => {
    if (!newWorkspaceName.trim() || !userOrg?.org_id) {
      toast({
        title: "Error",
        description: "Workspace name is required",
        variant: "destructive",
      });
      return;
    }

    setIsCreating(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Not authenticated");

      // Create workspace
      const { data: workspace, error: wsError } = await supabase
        .from("workspaces")
        .insert({
          name: newWorkspaceName.trim(),
          description: newWorkspaceDescription.trim() || null,
          owner_org_id: userOrg.org_id,
          created_by: user.id,
        })
        .select()
        .single();

      if (wsError) throw wsError;

      // Add owner org as workspace member
      const { error: memberError } = await supabase
        .from("workspace_members")
        .insert({
          workspace_id: workspace.id,
          org_id: userOrg.org_id,
          role: "owner",
          status: "active",
          invited_by: user.id,
          joined_at: new Date().toISOString(),
        });

      if (memberError) throw memberError;

      toast({
        title: "Success",
        description: "Workspace created successfully",
      });

      setShowCreateDialog(false);
      setNewWorkspaceName("");
      setNewWorkspaceDescription("");
      queryClient.invalidateQueries({ queryKey: ["workspaces"] });
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

  const handleAcceptInvite = async (inviteId: string, workspaceId: string) => {
    if (!userOrg?.org_id) return;

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Not authenticated");

      // Update invite status
      await supabase
        .from("workspace_invites")
        .update({ status: "accepted" })
        .eq("id", inviteId);

      // Add org as workspace member
      await supabase
        .from("workspace_members")
        .insert({
          workspace_id: workspaceId,
          org_id: userOrg.org_id,
          role: "collaborator",
          status: "active",
          joined_at: new Date().toISOString(),
        });

      toast({
        title: "Success",
        description: "You've joined the workspace",
      });

      queryClient.invalidateQueries({ queryKey: ["workspaces"] });
      queryClient.invalidateQueries({ queryKey: ["workspace-invites"] });
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    }
  };

  const handleDeclineInvite = async (inviteId: string) => {
    try {
      await supabase
        .from("workspace_invites")
        .update({ status: "declined" })
        .eq("id", inviteId);

      toast({
        title: "Invitation declined",
      });

      queryClient.invalidateQueries({ queryKey: ["workspace-invites"] });
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    }
  };

  if (!userOrg) {
    return (
      <Card>
        <CardContent className="py-8">
          <div className="text-center">
            <Building2 className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
            <h3 className="font-semibold mb-2">No Organization</h3>
            <p className="text-muted-foreground mb-4">
              Create an organization in Settings to enable workspace collaboration
            </p>
            <Button onClick={() => navigate("/settings")}>
              Go to Settings
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {/* Pending Invites */}
      {invites && invites.length > 0 && (
        <Card className="border-primary/50">
          <CardHeader>
            <CardTitle className="text-lg">Pending Invitations</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {invites.map((invite: any) => (
              <div
                key={invite.id}
                className="flex items-center justify-between p-4 bg-muted rounded-lg"
              >
                <div>
                  <p className="font-medium">{invite.workspaces?.name}</p>
                  <p className="text-sm text-muted-foreground">
                    Invited by {invite.workspaces?.owner_org?.name}
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleDeclineInvite(invite.id)}
                  >
                    Decline
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => handleAcceptInvite(invite.id, invite.workspace_id)}
                  >
                    Accept
                  </Button>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Workspaces List */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle>Shared Workspaces</CardTitle>
            <CardDescription>
              Collaborative spaces with partner companies
            </CardDescription>
          </div>
          <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
            <DialogTrigger asChild>
              <Button>
                <Plus className="h-4 w-4 mr-2" />
                New Workspace
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Create Workspace</DialogTitle>
                <DialogDescription>
                  Create a new shared workspace for collaboration
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label>Workspace Name</Label>
                  <Input
                    placeholder="e.g., Partner Claims"
                    value={newWorkspaceName}
                    onChange={(e) => setNewWorkspaceName(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Description (optional)</Label>
                  <Textarea
                    placeholder="What is this workspace for?"
                    value={newWorkspaceDescription}
                    onChange={(e) => setNewWorkspaceDescription(e.target.value)}
                  />
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setShowCreateDialog(false)}>
                  Cancel
                </Button>
                <Button onClick={handleCreateWorkspace} disabled={isCreating}>
                  {isCreating ? "Creating..." : "Create Workspace"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="text-center py-8 text-muted-foreground">Loading...</div>
          ) : workspaces && workspaces.length > 0 ? (
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {workspaces.map((workspace: any) => (
                <Card
                  key={workspace.id}
                  className="cursor-pointer hover:border-primary transition-colors"
                  onClick={() => navigate(`/workspaces/${workspace.id}`)}
                >
                  <CardHeader className="pb-2">
                    <div className="flex items-start justify-between">
                      <div className="flex items-center gap-2">
                        <Folder className="h-5 w-5 text-primary" />
                        <CardTitle className="text-base">{workspace.name}</CardTitle>
                      </div>
                      <Badge variant={workspace.memberRole === "owner" ? "default" : "secondary"}>
                        {workspace.memberRole}
                      </Badge>
                    </div>
                  </CardHeader>
                  <CardContent>
                    {workspace.description && (
                      <p className="text-sm text-muted-foreground mb-3">
                        {workspace.description}
                      </p>
                    )}
                    <div className="flex items-center gap-4 text-sm text-muted-foreground">
                      <div className="flex items-center gap-1">
                        <Users className="h-4 w-4" />
                        {workspace.workspace_members?.length || 0} orgs
                      </div>
                      <div className="flex items-center gap-1">
                        <ExternalLink className="h-4 w-4" />
                        {workspace.claimCount} claims
                      </div>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-1">
                      {workspace.workspace_members?.slice(0, 3).map((member: any) => (
                        <Badge key={member.org_id} variant="outline" className="text-xs">
                          {member.orgs?.name}
                        </Badge>
                      ))}
                      {workspace.workspace_members?.length > 3 && (
                        <Badge variant="outline" className="text-xs">
                          +{workspace.workspace_members.length - 3} more
                        </Badge>
                      )}
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          ) : (
            <div className="text-center py-8">
              <Folder className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
              <h3 className="font-semibold mb-2">No workspaces yet</h3>
              <p className="text-muted-foreground mb-4">
                Create a workspace to start collaborating with partners
              </p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

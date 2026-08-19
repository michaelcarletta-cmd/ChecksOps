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
      <div className="space-y-6">
        {!embedded && (
          <SettingsHero
            title="Partner Ecosystem"
            description="Manage collaborative spaces and shared claim data with outside organizations."
            badge="Shared Workspaces"
            icon={<Share2 className="h-4 w-4 text-primary" />}
          />
        )}
        <SectionCard
          title="No Organization"
          description="Workspace collaboration requires an organization"
          icon={<Building2 className="h-4 w-4 text-violet-500" />}
          accent="bg-gradient-to-r from-violet-500/60 to-violet-500/10"
        >
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <Building2 className="mb-4 h-12 w-12 text-muted-foreground" />
            <p className="mb-4 text-sm text-muted-foreground">
              Create an organization in Company Settings to enable workspace collaboration.
            </p>
            <Button onClick={() => navigate("/settings")}>Go to Settings</Button>
          </div>
        </SectionCard>
      </div>
    );
  }


  return (
    <div className="space-y-6">
      {!embedded && (
        <SettingsHero
          title="Partner Ecosystem"
          description="Manage collaborative spaces and shared claim data with outside organizations."
          badge="Shared Workspaces"
          icon={<Share2 className="h-4 w-4 text-primary" />}
        />
      )}

      <div className="grid gap-6">
        {/* Pending Invites */}
        {invites && invites.length > 0 && (
          <SectionCard
            title="Pending Invitations"
            description="Workspace invitations awaiting your response"
            icon={<Plus className="h-4 w-4 text-amber-500" />}
            accent="bg-gradient-to-r from-amber-500/60 to-amber-500/10"
          >
            <div className="space-y-4 pt-2">
              {invites.map((invite: any) => (
                <div
                  key={invite.id}
                  className="flex items-center justify-between p-4 bg-muted/30 backdrop-blur-sm rounded-lg border border-border/60"
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
            </div>
          </SectionCard>
        )}

        {/* Workspaces List */}
        <SectionCard
          title="Connected Workspaces"
          description="Collaborative spaces with partner companies"
          icon={<Users className="h-4 w-4 text-violet-500" />}
          accent="bg-gradient-to-r from-violet-500/60 to-violet-500/10"
        >
          <div className="pt-2">
            <div className="flex justify-end mb-4">
              <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
                <DialogTrigger asChild>
                  <Button size="sm">
                    <Plus className="h-4 w-4 mr-2" /> New Workspace
                  </Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Create Workspace</DialogTitle>
                    <DialogDescription>
                      Start a new shared workspace for multi-org collaboration
                    </DialogDescription>
                  </DialogHeader>
                  <div className="space-y-4 py-4">
                    <div className="space-y-2">
                      <Label htmlFor="name">Workspace Name</Label>
                      <Input
                        id="name"
                        value={newWorkspaceName}
                        onChange={(e) => setNewWorkspaceName(e.target.value)}
                        placeholder="e.g. Acme & Freedom Collaboration"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="description">Description (Optional)</Label>
                      <Textarea
                        id="description"
                        value={newWorkspaceDescription}
                        onChange={(e) => setNewWorkspaceDescription(e.target.value)}
                        placeholder="Purpose of this shared space..."
                      />
                    </div>
                  </div>
                  <DialogFooter>
                    <Button
                      variant="outline"
                      onClick={() => setShowCreateDialog(false)}
                      disabled={isCreating}
                    >
                      Cancel
                    </Button>
                    <Button onClick={handleCreateWorkspace} disabled={isCreating}>
                      {isCreating ? "Creating..." : "Create Workspace"}
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </div>

            {isLoading ? (
              <div className="space-y-4">
                {[1, 2].map((i) => (
                  <div key={i} className="h-32 bg-muted/50 rounded-lg animate-pulse" />
                ))}
              </div>
            ) : workspaces && workspaces.length > 0 ? (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {workspaces.map((workspace: any) => (
                  <div
                    key={workspace.id}
                    className="group flex flex-col p-5 bg-muted/30 backdrop-blur-sm border border-border/60 hover:border-violet-500/30 transition-all rounded-xl cursor-pointer"
                    onClick={() => navigate(`/workspaces/${workspace.id}`)}
                  >
                    <div className="flex-1 space-y-1">
                      <div className="flex items-center justify-between mb-1">
                        <div className="flex items-center gap-2">
                          <Folder className="h-4 w-4 text-violet-400" />
                          <h4 className="font-semibold">{workspace.name}</h4>
                        </div>
                        <Badge variant="outline" className="text-[10px] py-0 border-violet-500/20 text-violet-300">
                          {workspace.memberRole}
                        </Badge>
                      </div>
                      <p className="text-sm text-muted-foreground line-clamp-2 min-h-[40px]">
                        {workspace.description || "No description provided"}
                      </p>
                      <div className="flex flex-col gap-2 mt-4 text-xs text-muted-foreground">
                        <span className="flex items-center gap-2 bg-muted/30 px-2 py-1 rounded">
                          <Building2 className="h-3 w-3" />
                          Owner: {workspace.owner_org?.name}
                        </span>
                        <div className="flex items-center justify-between mt-1">
                          <span className="flex items-center gap-1">
                            <Users className="h-3 w-3" />
                            {workspace.workspace_members?.length || 0} orgs
                          </span>
                          <span className="flex items-center gap-1">
                            <ExternalLink className="h-3 w-3" />
                            {workspace.claimCount} claims
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-center py-12 border border-dashed rounded-xl bg-muted/20">
                <Users className="h-12 w-12 mx-auto text-muted-foreground/50 mb-4" />
                <h4 className="font-medium text-foreground">No Shared Workspaces</h4>
                <p className="text-sm text-muted-foreground max-w-xs mx-auto mt-1">
                  Connect with partners to create collaborative spaces for your claims.
                </p>
              </div>
            )}
          </div>
        </SectionCard>
      </div>
    </div>
  );
}

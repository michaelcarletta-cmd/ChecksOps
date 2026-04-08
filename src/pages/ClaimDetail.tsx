import { useParams, Link, useNavigate } from "react-router-dom";
import { useState, lazy, Suspense, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useRenderCount } from "@/hooks/useRenderCount";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ClaimStatusSelect } from "@/components/ClaimStatusSelect";

import { ClaimOverview } from "@/components/claim-detail/ClaimOverview";
import { ClaimCashFlowCard } from "@/components/loss-draft/ClaimCashFlowCard";
import { ClaimActivity } from "@/components/claim-detail/ClaimActivity";
import { ClaimFiles } from "@/components/claim-detail/ClaimFiles";
import { ClaimAccounting } from "@/components/claim-detail/ClaimAccounting";
import { ClaimTasks } from "@/components/claim-detail/ClaimTasks";
import { ClaimInspections } from "@/components/claim-detail/ClaimInspections";
import { ClaimAccessManagement } from "@/components/claim-detail/ClaimAccessManagement";
import { ClaimExternalSync } from "@/components/claim-detail/ClaimExternalSync";
import { ClaimAssigned } from "@/components/claim-detail/ClaimAssigned";
import { ClaimPhotos } from "@/components/claim-detail/ClaimPhotos";
import { EditClaimDialog } from "@/components/claim-detail/EditClaimDialog";
import { DeleteClaimDialog } from "@/components/claim-detail/DeleteClaimDialog";
import { NotifyPortalDialog } from "@/components/claim-detail/NotifyPortalDialog";
import { ShareClaimDialog } from "@/components/claim-detail/ShareClaimDialog";
import { ClaimTabsDropdown } from "@/components/claim-detail/ClaimTabsDropdown";
import { ClaimsAIAssistant } from "@/components/ClaimsAIAssistant";
import { useAuth } from "@/hooks/useAuth";
import { useIsMobile } from "@/hooks/use-mobile";
import { ArrowLeft, Edit, Trash2, Bell, Brain, Share2, Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { Skeleton } from "@/components/ui/skeleton";
import { useQuery, useQueryClient } from "@tanstack/react-query";

// Lazy load Darwin tab as a single organized component
const DarwinTab = lazy(() => import("@/components/claim-detail/DarwinTab").then(m => ({ default: m.DarwinTab })));

// Loading fallback for Darwin components
const DarwinLoadingFallback = () => (
  <div className="flex items-center justify-center p-8">
    <Loader2 className="h-6 w-6 animate-spin text-primary mr-2" />
    <span className="text-muted-foreground">Loading Darwin AI...</span>
  </div>
);

interface Contractor {
  contractor_id: string;
  profiles?: {
    full_name: string | null;
    email: string;
  } | null;
}


const ClaimDetail = () => {
  useRenderCount("ClaimDetail");
  const { id } = useParams();
  const navigate = useNavigate();
  const { userRole } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const isMobile = useIsMobile();
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [notifyDialogOpen, setNotifyDialogOpen] = useState(false);
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  const [activeTab, setActiveTab] = useState(
    userRole === "admin" || userRole === "staff" ? "darwin" : "overview",
  );

  // Check if user is a portal user (client, contractor)
  const isPortalUser = userRole === "client" || userRole === "contractor";
  const isStaffOrAdmin = userRole === "admin" || userRole === "staff";

  useEffect(() => {
    setActiveTab(isStaffOrAdmin ? "darwin" : "overview");
  }, [id, isStaffOrAdmin]);

  // Fetch claim with React Query for caching
  const { data: claim, isLoading, error: claimError } = useQuery({
    queryKey: ["claim", id],
    queryFn: async () => {
      const start = performance.now();
      const { data, error } = await supabase
        .from("claims")
        .select(`
          *,
          insurance_companies:insurance_company_id(id, name, phone, email),
          loss_types:loss_type_id(id, name)
        `)
        .eq("id", id)
        .maybeSingle();
      console.log(`[query] getClaimDetail: ${(performance.now() - start).toFixed(2)}ms`);
      if (error) {
        console.error("Error fetching claim:", error);
        throw error;
      }
      const flattenedData = data ? {
        ...data,
        insurance_company: data.insurance_companies?.name || null,
        loss_type: data.loss_types?.name || null,
      } : null;
      return flattenedData;
    },
    enabled: !!id,
    staleTime: 5000, // Reduced cache time for more responsive updates
  });

  // Real-time subscription for this specific claim
  useEffect(() => {
    if (!id) return;

    const channel = supabase
      .channel(`claim-detail-${id}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'claims',
          filter: `id=eq.${id}`,
        },
        (payload) => {
          console.log("Claim updated via realtime:", payload.new);
          // Invalidate and refetch to get proper joined data
          queryClient.invalidateQueries({ queryKey: ["claim", id] });
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [id, queryClient]);

  // Log any claim fetch errors
  if (claimError) {
    console.error("ClaimDetail query error:", claimError);
  }

  // Fetch contractors with React Query
  const { data: contractors = [] } = useQuery({
    queryKey: ["claim-contractors", id],
    queryFn: async () => {
      const start = performance.now();
      const { data, error } = await supabase
        .from("claim_contractors")
        .select("contractor_id")
        .eq("claim_id", id);
      console.log(`[query] getClaimContractors: ${(performance.now() - start).toFixed(2)}ms`);
      if (error) throw error;
      return (data || []) as Contractor[];
    },
    enabled: !!id,
    staleTime: 30000,
  });

  // Generate claim-specific email address using policy number
  const getClaimEmail = (claim: any): string => {
    const domain = "freedomclaims.work";
    if (claim.policy_number) {
      // Sanitize policy number: lowercase, replace non-alphanumeric with hyphens
      const sanitized = claim.policy_number
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
      return `claim-${sanitized}@${domain}`;
    }
    // Fallback to claim_email_id if no policy number
    return `claim-${claim.claim_email_id}@${domain}`;
  };

  const handleStatusChange = (newStatus: string) => {
    queryClient.setQueryData(["claim", id], (old: any) => 
      old ? { ...old, status: newStatus } : old
    );
  };

  const handleConstructionStatusChange = (newStatus: string) => {
    queryClient.setQueryData(["claim", id], (old: any) => 
      old ? { ...old, construction_status: newStatus } : old
    );
  };

  // Check if this is a workspace claim (synced from partner)
  const isWorkspaceClaim = !!claim?.workspace_id;

  const handleClaimUpdated = (updatedClaim: any) => {
    queryClient.setQueryData(["claim", id], updatedClaim);
  };

  const toggleClosedStatus = async () => {
    if (!id || !claim) return;

    try {
      const newIsClosed = !claim.is_closed;

      const { error } = await supabase
        .from("claims")
        .update({ is_closed: newIsClosed })
        .eq("id", id);

      if (error) throw error;

      queryClient.setQueryData(["claim", id], (old: any) => 
        old ? { ...old, is_closed: newIsClosed } : old
      );
      toast({
        title: "Status updated",
        description: newIsClosed
          ? "Claim has been closed and removed from the active list."
          : "Claim has been reopened.",
      });
    } catch (error: any) {
      console.error("Error toggling closed status:", error);
      toast({
        title: "Error",
        description: error.message || "Failed to update claim status",
        variant: "destructive",
      });
    }
  };

  const getBackLink = () => {
    if (userRole === "client") return "/client-portal";
    if (userRole === "contractor") return "/contractor-portal";
    return "/claims";
  };

  // Skeleton loading component
  if (isLoading) {
    return (
      <div className="space-y-4 md:space-y-6 p-4 md:p-6 bg-background min-h-screen">
        <div className="flex flex-col md:flex-row md:items-center gap-4">
          <div className="flex items-center gap-4">
            <Skeleton className="h-10 w-10 rounded-md" />
            <div className="space-y-2">
              <Skeleton className="h-8 w-48" />
              <Skeleton className="h-4 w-32" />
            </div>
          </div>
        </div>
        <div className="space-y-4">
          <Skeleton className="h-10 w-full max-w-lg" />
          <Skeleton className="h-64 w-full" />
        </div>
      </div>
    );
  }

  if (!claim) {
    return <div className="p-8">Claim not found</div>;
  }

  return (
    <div className="space-y-3 md:space-y-6 p-3 md:p-6 bg-background min-h-screen">
      <div className="flex flex-col md:flex-row md:items-center gap-4">
        <div className="flex items-center gap-4">
          <Link to={getBackLink()}>
            <Button variant="ghost" size="icon">
              <ArrowLeft className="h-5 w-5" />
            </Button>
          </Link>
          <div className="flex-1">
            <div className="flex flex-col md:flex-row md:items-center gap-2 md:gap-3">
              <h1 className="text-xl md:text-3xl font-bold text-foreground">{claim.claim_number}</h1>
              {isStaffOrAdmin && (
                <ClaimStatusSelect 
                  claimId={claim.id} 
                  currentStatus={claim.status}
                  currentSubStatusId={claim.sub_status_id}
                  onStatusChange={handleStatusChange}
                  onSubStatusChange={() => queryClient.invalidateQueries({ queryKey: ["claim", id] })}
                />
              )}
              {/* Read-only status display for portal users only */}
              {isPortalUser && claim.status && (
                <span className="px-3 py-1 text-xs font-semibold rounded-full bg-primary/10 text-primary border border-primary/20 w-fit whitespace-nowrap">
                  {claim.status}
                </span>
              )}
            </div>
            <p className="text-muted-foreground mt-1 font-medium">{claim.policyholder_name}</p>
            {isStaffOrAdmin && (claim.policy_number || claim.claim_email_id) && (
              <p className="text-[10px] md:text-xs text-muted-foreground mt-1 font-mono break-all leading-relaxed">
                <span className="hidden sm:inline">Claim Email: </span>
                <span className="sm:hidden">📧 </span>
                {getClaimEmail(claim)}
                <Button 
                  variant="ghost" 
                  size="sm" 
                  className="ml-1 h-5 px-1.5 text-[10px] md:text-xs"
                  onClick={() => {
                    navigator.clipboard.writeText(getClaimEmail(claim));
                    toast({ title: "Copied", description: "Claim email copied to clipboard" });
                  }}
                >
                  Copy
                </Button>
              </p>
            )}
          </div>
        </div>
        {isStaffOrAdmin && (
          <div className="flex flex-wrap md:flex-row items-stretch md:items-center gap-1.5 md:gap-2 md:ml-auto">
            <Button variant="outline" size="sm" className="h-8 text-xs md:text-sm" onClick={() => setShareDialogOpen(true)}>
              <Share2 className="h-3.5 w-3.5 mr-1.5" />
              Share
            </Button>
            <Button variant="outline" size="sm" className="h-8 text-xs md:text-sm" onClick={() => setNotifyDialogOpen(true)}>
              <Bell className="h-3.5 w-3.5 mr-1.5" />
              Notify
            </Button>
            <Button
              variant={claim.is_closed ? "outline" : "secondary"}
              size="sm"
              className="h-8 text-xs md:text-sm"
              onClick={toggleClosedStatus}
            >
              {claim.is_closed ? "Reopen" : "Close"}
            </Button>
            <Button size="sm" className="h-8 text-xs md:text-sm bg-primary hover:bg-primary/90" onClick={() => setEditDialogOpen(true)}>
              <Edit className="h-3.5 w-3.5 mr-1.5" />
              Edit
            </Button>
          </div>
        )}
      </div>

      {isStaffOrAdmin && (
        <>
          <EditClaimDialog
            open={editDialogOpen}
            onOpenChange={setEditDialogOpen}
            claim={claim}
            onClaimUpdated={handleClaimUpdated}
          />

          <DeleteClaimDialog
            open={deleteDialogOpen}
            onOpenChange={setDeleteDialogOpen}
            claimId={claim.id}
            claimNumber={claim.claim_number}
          />

          <NotifyPortalDialog
            open={notifyDialogOpen}
            onOpenChange={setNotifyDialogOpen}
            claimId={claim.id}
            clientId={claim.client_id}
            contractors={contractors}
            policyholderName={claim.policyholder_name}
          />

          <ShareClaimDialog
            isOpen={shareDialogOpen}
            onClose={() => setShareDialogOpen(false)}
            onShared={() => queryClient.invalidateQueries({ queryKey: ["claim", id] })}
            claimId={claim.id}
            claimNumber={claim.claim_number}
          />
        </>
      )}

      {isStaffOrAdmin ? (
        /* Staff/Admin: Render Darwin directly, no tab bar needed */
        <Suspense fallback={<DarwinLoadingFallback />}>
          <DarwinTab
            claimId={claim.id}
            claim={claim}
            userRole={userRole}
            isStaffOrAdmin={isStaffOrAdmin}
            onClaimUpdated={handleClaimUpdated}
          />
        </Suspense>
      ) : (
        /* Portal users: Keep existing tab navigation */
        <Tabs defaultValue="overview" value={activeTab} onValueChange={setActiveTab} className="w-full">
          {isMobile ? (
            <ClaimTabsDropdown 
              activeTab={activeTab} 
              onTabChange={setActiveTab} 
              isStaffOrAdmin={isStaffOrAdmin} 
            />
          ) : (
            <TabsList className="flex flex-row w-full bg-muted p-2 gap-1 h-auto rounded-md">
              <TabsTrigger value="overview" className="w-auto justify-start text-base font-medium px-4 py-2 text-muted-foreground data-[state=active]:bg-background data-[state=active]:text-foreground rounded-sm">
                Overview
              </TabsTrigger>
              <TabsTrigger value="activity" className="w-auto justify-start text-base font-medium px-4 py-2 text-muted-foreground data-[state=active]:bg-background data-[state=active]:text-foreground rounded-sm">
                Notes & Activity
              </TabsTrigger>
              <TabsTrigger value="inspections" className="w-auto justify-start text-base font-medium px-4 py-2 text-muted-foreground data-[state=active]:bg-background data-[state=active]:text-foreground rounded-sm">
                Inspections
              </TabsTrigger>
              <TabsTrigger value="photos" className="w-auto justify-start text-base font-medium px-4 py-2 text-muted-foreground data-[state=active]:bg-background data-[state=active]:text-foreground rounded-sm">
                Photos
              </TabsTrigger>
              <TabsTrigger value="files" className="w-auto justify-start text-base font-medium px-4 py-2 text-muted-foreground data-[state=active]:bg-background data-[state=active]:text-foreground rounded-sm">
                Files
              </TabsTrigger>
              <TabsTrigger value="accounting" className="w-auto justify-start text-base font-medium px-4 py-2 text-muted-foreground data-[state=active]:bg-background data-[state=active]:text-foreground rounded-sm">
                Accounting
              </TabsTrigger>
            </TabsList>
          )}

          <TabsContent value="overview" className="mt-6 space-y-6">
            <ClaimOverview 
              claim={claim} 
              isPortalUser={isPortalUser} 
              onClaimUpdated={handleClaimUpdated}
            />
          </TabsContent>

          <TabsContent value="activity" className="mt-6">
            <ClaimActivity claimId={id || ""} claim={claim} isPortalUser={isPortalUser} />
          </TabsContent>

          <TabsContent value="inspections" className="mt-6">
            <ClaimInspections claimId={id || ""} />
          </TabsContent>

          <TabsContent value="photos" className="mt-6">
            <ClaimPhotos claimId={id || ""} claim={claim} isPortalUser={isPortalUser} />
          </TabsContent>

          <TabsContent value="files" className="mt-6">
            <ClaimFiles claimId={id || ""} claim={claim} isStaffOrAdmin={isStaffOrAdmin} />
          </TabsContent>

          <TabsContent value="accounting" className="mt-6">
            <ClaimAccounting claim={claim} userRole={userRole} />
          </TabsContent>
        </Tabs>
      )}

      {isStaffOrAdmin && activeTab === "overview" && (
        <div className="pt-6 border-t border-destructive/30">
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
            <div>
              <h3 className="text-lg font-semibold text-destructive">Danger Zone</h3>
              <p className="text-sm text-muted-foreground">Permanently delete this claim and all associated data</p>
            </div>
            <Button size="sm" variant="destructive" onClick={() => setDeleteDialogOpen(true)}>
              <Trash2 className="h-4 w-4 mr-2" />
              Delete Claim
            </Button>
          </div>
        </div>
      )}
      
      {/* Floating AI Assistant Button - claim-aware (staff only) */}
      {isStaffOrAdmin && (
        <ClaimsAIAssistant 
          claimId={claim.id} 
          claimNumber={claim.claim_number} 
          policyholderName={claim.policyholder_name}
        />
      )}
    </div>
  );
};

export default ClaimDetail;
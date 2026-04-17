import { useState, useMemo, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Search, Bell } from "lucide-react";
import { ClaimStatusSelect } from "./ClaimStatusSelect";
import { format } from "date-fns";
import { useAuth } from "@/hooks/useAuth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { Skeleton } from "@/components/ui/skeleton";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BulkClaimActions } from "./BulkClaimActions";
import { Badge } from "@/components/ui/badge";


interface Claim {
  id: string;
  claim_number: string;
  policyholder_name: string;
  policyholder_address: string;
  claim_amount: number | null;
  status: string;
  created_at: string;
  updated_at: string;
  loss_type: string;
  is_closed: boolean;
}

interface ClaimsTableConnectedProps {
  portalType?: "client" | "contractor" | "referrer";
}

export const ClaimsTableConnected = ({ portalType }: ClaimsTableConnectedProps) => {
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [lossTypeFilter, setLossTypeFilter] = useState<string>("all");
  // Show closed claims by default for client/contractor portals for tracking purposes
  const [showClosed, setShowClosed] = useState(portalType === "client" || portalType === "contractor" || portalType === "referrer");
  const [selectedClaims, setSelectedClaims] = useState<Set<string>>(new Set());
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const navigate = useNavigate();
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Fetch unread notifications with claim IDs
  const { data: claimNotifications = [], refetch: refetchNotifications } = useQuery({
    queryKey: ["claim-notifications", user?.id],
    queryFn: async () => {
      if (!user?.id) return [];
      const { data, error } = await supabase
        .from("notifications")
        .select("id, claim_id")
        .eq("user_id", user.id)
        .eq("is_read", false);
      if (error) throw error;
      return data || [];
    },
    enabled: !!user?.id,
    staleTime: 5000,
  });

  // Create a set of claim IDs with notifications for quick lookup
  const claimsWithNotifications = useMemo(() => {
    return new Set(claimNotifications.map(n => n.claim_id));
  }, [claimNotifications]);

  // Real-time subscription for notification updates
  useEffect(() => {
    if (!user?.id) return;

    const channel = supabase
      .channel('claims-table-notifications')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'notifications',
          filter: `user_id=eq.${user.id}`,
        },
        () => {
          refetchNotifications();
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [user?.id, refetchNotifications]);

  // Mark notifications as read when navigating to a claim
  const handleClaimClick = async (claimId: string) => {
    // Check if this claim has notifications
    const notificationsForClaim = claimNotifications.filter(n => n.claim_id === claimId);
    
    if (notificationsForClaim.length > 0) {
      // Mark all notifications for this claim as read
      const notificationIds = notificationsForClaim.map(n => n.id);
      await supabase
        .from("notifications")
        .update({ is_read: true })
        .in("id", notificationIds);
      
      // Invalidate both queries to update the sidebar badge and table
      queryClient.invalidateQueries({ queryKey: ["claim-notifications"] });
      queryClient.invalidateQueries({ queryKey: ["unread-claim-notifications"] });
    }
    
    navigate(`/claims/${claimId}`);
  };

  // Fetch claims with React Query for caching
  const { data: claims = [], isLoading } = useQuery({
    queryKey: ["claims", portalType, user?.id],
    queryFn: async () => {
      if (!user?.id) return [];

      const start = performance.now();
      let query = supabase.from("claims").select("*");

      if (portalType === "client") {
        // Find the client record linked to this user
        const { data: clientData } = await supabase
          .from("clients")
          .select("id")
          .eq("user_id", user.id)
          .maybeSingle();

        if (clientData?.id) {
          query = query.eq("client_id", clientData.id);
        } else {
          return [];
        }
      } else if (portalType === "contractor") {
        const { data: assignments } = await supabase
          .from("claim_contractors")
          .select("claim_id")
          .eq("contractor_id", user.id);

        if (assignments && assignments.length > 0) {
          const claimIds = assignments.map((a) => a.claim_id);
          query = query.in("id", claimIds);
        } else {
          return [];
        }
      } else if (portalType === "referrer") {
        const { data: referrerData } = await supabase
          .from("referrers")
          .select("id")
          .eq("user_id", user.id)
          .maybeSingle();

        if (referrerData?.id) {
          query = query.eq("referrer_id", referrerData.id);
        } else {
          return [];
        }
      } else if (!portalType) {
        const { data: roles } = await supabase
          .from("user_roles")
          .select("role")
          .eq("user_id", user.id);

        const isAdmin = roles?.some((r) => r.role === "admin");
        const isStaff = roles?.some((r) => r.role === "staff");

        if (isStaff && !isAdmin) {
          const { data: staffAssignments } = await supabase
            .from("claim_staff")
            .select("claim_id")
            .eq("staff_id", user.id);

          if (staffAssignments && staffAssignments.length > 0) {
            const claimIds = staffAssignments.map((a) => a.claim_id);
            query = query.in("id", claimIds);
          } else {
            return [];
          }
        }
      }

      const { data, error } = await query.order("updated_at", { ascending: false });
      console.log(`[query] claimsTable: ${(performance.now() - start).toFixed(2)}ms, rows: ${data?.length ?? 0}`);
      if (error) throw error;
      return (data || []) as Claim[];
    },
    enabled: !!user?.id,
    staleTime: 5000, // Reduced cache time for more responsive updates
  });

  // Real-time subscription for claim updates
  useEffect(() => {
    const channel = supabase
      .channel('claims-table-updates')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'claims',
        },
        () => {
          // Invalidate cache to refetch updated claims
          queryClient.invalidateQueries({ queryKey: ["claims"] });
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [queryClient]);

  // Fetch active statuses with React Query - ordered by display_order to match Settings
  const { data: activeStatuses = [] } = useQuery({
    queryKey: ["claim-statuses"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("claim_statuses")
        .select("name, is_active")
        .eq("is_active", true)
        .order("display_order");
      if (error) throw error;
      return (data || []).map((s) => s.name);
    },
    staleTime: 60000, // Cache for 1 minute
  });

  // Use memoized filtering - no debounce needed for client-side filtering
  const filteredClaims = useMemo(() => {
    let filtered = [...claims];

    // Hide closed claims by default
    if (!showClosed) {
      filtered = filtered.filter((claim) => !claim.is_closed);
    }

    // Search filter - instant client-side filtering
    const query = searchQuery.trim().toLowerCase();
    if (query) {
      filtered = filtered.filter((claim) => {
        const claimNum = (claim.claim_number || "").toLowerCase();
        const name = (claim.policyholder_name || "").toLowerCase();
        const address = (claim.policyholder_address || "").toLowerCase();
        return claimNum.includes(query) || name.includes(query) || address.includes(query);
      });
    }

    // Status filter
    if (statusFilter !== "all") {
      filtered = filtered.filter((claim) => claim.status === statusFilter);
    }

    // Loss type filter
    if (lossTypeFilter !== "all") {
      filtered = filtered.filter((claim) => claim.loss_type === lossTypeFilter);
    }

    return filtered.sort((a, b) => {
      const aHasNotification = claimsWithNotifications.has(a.id) ? 1 : 0;
      const bHasNotification = claimsWithNotifications.has(b.id) ? 1 : 0;
      return bHasNotification - aHasNotification;
    });
  }, [claims, searchQuery, statusFilter, lossTypeFilter, showClosed, claimsWithNotifications]);

  const toggleClaimSelection = (claimId: string) => {
    const newSelected = new Set(selectedClaims);
    if (newSelected.has(claimId)) {
      newSelected.delete(claimId);
    } else {
      newSelected.add(claimId);
    }
    setSelectedClaims(newSelected);
  };

  const toggleAllClaims = () => {
    if (selectedClaims.size === filteredClaims.length) {
      setSelectedClaims(new Set());
    } else {
      setSelectedClaims(new Set(filteredClaims.map(c => c.id)));
    }
  };

  const handleDeleteSelected = async () => {
    setDeleting(true);
    try {
      const { error } = await supabase
        .from("claims")
        .delete()
        .in("id", Array.from(selectedClaims));

      if (error) throw error;

      toast({
        title: "Success",
        description: `Successfully deleted ${selectedClaims.size} claim(s)`,
      });

      setSelectedClaims(new Set());
      setShowDeleteDialog(false);
      queryClient.invalidateQueries({ queryKey: ["claims"] });
    } catch (error) {
      console.error("Error deleting claims:", error);
      toast({
        title: "Error",
        description: "Failed to delete claims",
        variant: "destructive",
      });
    } finally {
      setDeleting(false);
    }
  };

  // Skeleton loading component
  const LoadingSkeleton = () => (
    <Card>
      <CardHeader>
        <CardTitle>All Claims</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-col gap-3">
          <Skeleton className="h-10 w-full" />
          <div className="flex gap-3">
            <Skeleton className="h-10 w-[200px]" />
            <Skeleton className="h-10 w-[200px]" />
          </div>
        </div>
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-12"><Skeleton className="h-4 w-4" /></TableHead>
                <TableHead><Skeleton className="h-4 w-20" /></TableHead>
                <TableHead><Skeleton className="h-4 w-24" /></TableHead>
                <TableHead><Skeleton className="h-4 w-32" /></TableHead>
                <TableHead><Skeleton className="h-4 w-20" /></TableHead>
                <TableHead><Skeleton className="h-4 w-20" /></TableHead>
                <TableHead><Skeleton className="h-4 w-24" /></TableHead>
                <TableHead><Skeleton className="h-4 w-16" /></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {[1, 2, 3, 4, 5].map((i) => (
                <TableRow key={i}>
                  <TableCell><Skeleton className="h-4 w-4" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-24" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-32" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-40" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-20" /></TableCell>
                  <TableCell><Skeleton className="h-6 w-24" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-24" /></TableCell>
                  <TableCell><Skeleton className="h-8 w-16" /></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );

  if (isLoading) {
    return <LoadingSkeleton />;
  }

  // Use activeStatuses from the ordered query instead of deriving from claims
  const uniqueStatuses = ["all", ...activeStatuses];
  const uniqueLossTypes = ["all", ...new Set(claims.map((c) => c.loss_type).filter(Boolean))];

  return (
    <Card>
      <CardHeader>
        <CardTitle>All Claims</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-col gap-3">
          {selectedClaims.size > 0 && (
            <BulkClaimActions
              selectedClaims={selectedClaims}
              onClearSelection={() => setSelectedClaims(new Set())}
              onDeleteRequest={() => setShowDeleteDialog(true)}
            />
          )}
          

          <div className="relative">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search by claim number, client name, or address..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9"
            />
          </div>
          
          <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center">
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-full sm:w-[200px]">
                <SelectValue placeholder="Filter by status" />
              </SelectTrigger>
              <SelectContent>
                {uniqueStatuses.map((status) => (
                  <SelectItem key={status} value={status}>
                    {status === "all" ? "All Statuses" : status}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={lossTypeFilter} onValueChange={setLossTypeFilter}>
              <SelectTrigger className="w-full sm:w-[200px]">
                <SelectValue placeholder="Filter by loss type" />
              </SelectTrigger>
              <SelectContent>
                {uniqueLossTypes.map((type) => (
                  <SelectItem key={type} value={type}>
                    {type === "all" ? "All Loss Types" : type}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <div className="flex items-center gap-2">
              <Checkbox
                id="show-closed"
                checked={showClosed}
                onCheckedChange={(checked) => setShowClosed(checked as boolean)}
              />
              <Label htmlFor="show-closed" className="text-sm cursor-pointer">
                Show closed claims
              </Label>
            </div>
          </div>
        </div>

        {/* Mobile card layout */}
        <div className="block md:hidden space-y-2">
          {filteredClaims.length === 0 ? (
            <p className="text-center text-muted-foreground py-8">No claims found</p>
          ) : (
            filteredClaims.map((claim) => {
              const hasNotification = claimsWithNotifications.has(claim.id);
              const nudge = nudgesByClaim.get(claim.id);
              const isCritical = nudge?.topSeverity === "critical";
              return (
                <div
                  key={claim.id}
                  className={cn(
                    "rounded-lg border p-3 cursor-pointer transition-colors active:bg-muted/70",
                    hasNotification && "bg-primary/5 border-l-4 border-l-primary",
                    !hasNotification && isCritical && "bg-destructive/5 border-l-4 border-l-destructive",
                    !hasNotification && !isCritical && "bg-card"
                  )}
                  onClick={() => handleClaimClick(claim.id)}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <Checkbox
                        checked={selectedClaims.has(claim.id)}
                        onCheckedChange={() => toggleClaimSelection(claim.id)}
                        onClick={(e) => e.stopPropagation()}
                      />
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          {hasNotification && (
                            <Badge variant="destructive" className="h-4 w-4 p-0 flex items-center justify-center shrink-0">
                              <Bell className="h-2.5 w-2.5" />
                            </Badge>
                          )}
                          <span className="text-sm font-semibold text-foreground">{claim.claim_number || "—"}</span>
                          {nudge && (
                            <span className={cn(
                              "inline-flex items-center gap-1 px-1.5 py-0 rounded-full text-[10px] font-medium border",
                              severityBadgeClasses(nudge.topSeverity)
                            )}>
                              <AlertTriangle className="h-2 w-2" />
                              {severityLabel(nudge.topSeverity)}
                              {nudge.count > 1 && <span className="opacity-70">·{nudge.count}</span>}
                            </span>
                          )}
                        </div>
                        <p className="text-sm text-foreground mt-0.5">{claim.policyholder_name || "—"}</p>
                      </div>
                    </div>
                    <div onClick={(e) => e.stopPropagation()} className="shrink-0">
                      <ClaimStatusSelect
                        claimId={claim.id}
                        currentStatus={claim.status}
                        currentSubStatusId={(claim as any).sub_status_id}
                        compact
                      />
                    </div>
                  </div>
                  <div className="mt-2 pl-8 space-y-0.5">
                    <p className="text-xs text-muted-foreground truncate">{claim.policyholder_address || "N/A"}</p>
                    <div className="flex items-center gap-3 text-xs text-muted-foreground">
                      <span>{claim.loss_type || "N/A"}</span>
                      <span>·</span>
                      <span>{format(new Date(claim.created_at), "MMM dd, yyyy")}</span>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Desktop table layout */}
        <div className="hidden md:block rounded-md border overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-12">
                  <Checkbox
                    checked={filteredClaims.length > 0 && selectedClaims.size === filteredClaims.length}
                    onCheckedChange={toggleAllClaims}
                  />
                </TableHead>
                <TableHead className="whitespace-nowrap">Claim #</TableHead>
                <TableHead className="whitespace-nowrap w-[110px]">Nudges</TableHead>
                <TableHead className="whitespace-nowrap">Client Name</TableHead>
                <TableHead className="whitespace-nowrap">Property Address</TableHead>
                <TableHead className="whitespace-nowrap">Loss Type</TableHead>
                <TableHead className="whitespace-nowrap">Status</TableHead>
                <TableHead className="whitespace-nowrap">Date Submitted</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredClaims.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="text-center text-muted-foreground">
                    No claims found
                  </TableCell>
                </TableRow>
              ) : (
                filteredClaims.map((claim) => {
                  const hasNotification = claimsWithNotifications.has(claim.id);
                  const nudge = nudgesByClaim.get(claim.id);
                  const isCritical = nudge?.topSeverity === "critical";
                  return (
                    <TableRow
                      key={claim.id}
                      className={cn(
                        "hover:bg-muted/50 transition-colors cursor-pointer",
                        hasNotification && "bg-primary/5 border-l-4 border-l-primary",
                        !hasNotification && isCritical && "bg-destructive/5 border-l-4 border-l-destructive"
                      )}
                      onClick={() => handleClaimClick(claim.id)}
                    >
                      <TableCell onClick={(e) => e.stopPropagation()} className={hasNotification ? 'bg-primary/5' : 'bg-background'}>
                        <Checkbox
                          checked={selectedClaims.has(claim.id)}
                          onCheckedChange={() => toggleClaimSelection(claim.id)}
                        />
                      </TableCell>
                      <TableCell className="font-medium">
                        <div className="flex items-center gap-2">
                          {hasNotification && (
                            <Badge variant="destructive" className="h-5 w-5 p-0 flex items-center justify-center shrink-0">
                              <Bell className="h-3 w-3" />
                            </Badge>
                          )}
                          <span className="text-sm">{claim.claim_number || "—"}</span>
                        </div>
                      </TableCell>
                      <TableCell>
                        {nudge ? (
                          <span
                            className={cn(
                              "inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium border",
                              severityBadgeClasses(nudge.topSeverity)
                            )}
                            title={`${nudge.count} active ${nudge.count === 1 ? 'nudge' : 'nudges'}`}
                          >
                            <AlertTriangle className="h-2.5 w-2.5" />
                            {severityLabel(nudge.topSeverity)}
                            {nudge.count > 1 && <span className="opacity-70">·{nudge.count}</span>}
                          </span>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <span className="text-sm">{claim.policyholder_name || "—"}</span>
                      </TableCell>
                      <TableCell className="max-w-[250px] min-w-[150px]">
                        <span className="text-sm block truncate" title={claim.policyholder_address || "N/A"}>{claim.policyholder_address || "N/A"}</span>
                      </TableCell>
                      <TableCell className="min-w-[100px] whitespace-nowrap">{claim.loss_type || "N/A"}</TableCell>
                      <TableCell onClick={(e) => e.stopPropagation()}>
                        <ClaimStatusSelect
                          claimId={claim.id}
                          currentStatus={claim.status}
                          currentSubStatusId={(claim as any).sub_status_id}
                          compact
                        />
                      </TableCell>
                      <TableCell>
                        {format(new Date(claim.created_at), "MMM dd, yyyy")}
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>
      </CardContent>

      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {selectedClaims.size} Claim(s)?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the selected claims and all associated data including:
              files, notes, tasks, payments, and accounting records. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteSelected}
              disabled={deleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleting ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
};

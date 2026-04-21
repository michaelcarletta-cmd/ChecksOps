import { useState, useMemo } from "react";
import { useClaimControlBoard } from "@/hooks/useClaimControlBoard";
import { useGlobalImmediateMicrotasks } from "@/hooks/useGlobalImmediateMicrotasks";
import { ClaimBoardCard } from "@/components/control-board/ClaimBoardCard";
import { NeedsActionStrip } from "@/components/control-board/NeedsActionStrip";
import { ClaimBoardEntry, FollowUpStatus } from "@/services/claimOperationsService";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Loader2, Search, SlidersHorizontal } from "lucide-react";

type SortField = "priority_rank" | "days_since_activity" | "pressure_score" | "follow_up_status";

const ClaimsControlBoard = () => {
  const { data: claims = [], isLoading } = useClaimControlBoard();
  const { data: immediateTasks = [] } = useGlobalImmediateMicrotasks();
  const [sortBy, setSortBy] = useState<SortField>("priority_rank");
  const [search, setSearch] = useState("");
  const [filterFollowUp, setFilterFollowUp] = useState<string>("all");

  const filtered = useMemo(() => {
    let result = [...claims];

    // Search filter
    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter(c =>
        c.claim_number?.toLowerCase().includes(q) ||
        c.policyholder_name?.toLowerCase().includes(q) ||
        c.insurance_carrier?.toLowerCase().includes(q) ||
        c.property_address?.toLowerCase().includes(q)
      );
    }

    // Follow-up filter
    if (filterFollowUp !== "all") {
      result = result.filter(c => c.ops?.follow_up_status === filterFollowUp);
    }

    // Sort
    result.sort((a, b) => {
      const opsA = a.ops;
      const opsB = b.ops;
      switch (sortBy) {
        case "priority_rank":
          return (opsB?.priority_rank || 0) - (opsA?.priority_rank || 0);
        case "days_since_activity":
          return (opsB?.days_since_last_activity || 0) - (opsA?.days_since_last_activity || 0);
        case "pressure_score":
          return (opsB?.pressure_score || 0) - (opsA?.pressure_score || 0);
        case "follow_up_status": {
          const order: Record<string, number> = { escalation: 0, overdue: 1, due: 2, on_track: 3 };
          return (order[opsA?.follow_up_status || "on_track"] || 3) - (order[opsB?.follow_up_status || "on_track"] || 3);
        }
        default:
          return 0;
      }
    });

    return result;
  }, [claims, search, filterFollowUp, sortBy]);

  // Stats
  const escalationCount = claims.filter(c => c.ops?.follow_up_status === "escalation").length;
  const overdueCount = claims.filter(c => c.ops?.follow_up_status === "overdue").length;
  const staleCount = claims.filter(c => c.ops?.stale_flag).length;
  const highExposureCount = claims.filter(c => c.ops?.high_exposure_flag).length;
  const outstandingTaskCount = claims.filter(c => c.immediate_microtasks > 0 || c.blocking_microtasks > 0 || c.ops?.follow_up_status === "overdue" || c.ops?.follow_up_status === "escalation").length;

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-3xl font-bold text-foreground">Claims Control Board</h1>
          <p className="text-muted-foreground mt-1">Loading operational intelligence...</p>
        </div>
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div>
        <h1 className="text-2xl md:text-3xl font-bold text-foreground">Claims Control Board</h1>
        <p className="text-muted-foreground text-sm mt-1">
          {claims.length} active claims • {outstandingTaskCount > 0 
            ? `${outstandingTaskCount} claims with outstanding tasks` 
            : "All current claims on track"}
        </p>
      </div>

      {/* Needs Action Now strip */}
      {immediateTasks.length > 0 && (
        <NeedsActionStrip tasks={immediateTasks} />
      )}

      {/* Stats badges */}
      <div className="flex flex-wrap gap-2">
        {escalationCount > 0 && (
          <Badge variant="destructive" className="cursor-pointer" onClick={() => setFilterFollowUp("escalation")}>
            {escalationCount} Escalation
          </Badge>
        )}
        {overdueCount > 0 && (
          <Badge variant="destructive" className="cursor-pointer" onClick={() => setFilterFollowUp("overdue")}>
            {overdueCount} Overdue
          </Badge>
        )}
        {staleCount > 0 && (
          <Badge variant="secondary" className="cursor-pointer">
            {staleCount} Stale
          </Badge>
        )}
        {highExposureCount > 0 && (
          <Badge variant="outline" className="cursor-pointer border-amber-500 text-amber-600 dark:text-amber-400">
            {highExposureCount} High Exposure
          </Badge>
        )}
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search claims..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="pl-10"
          />
        </div>
        <Select value={filterFollowUp} onValueChange={setFilterFollowUp}>
          <SelectTrigger className="w-[160px]">
            <SelectValue placeholder="Follow-up" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Statuses</SelectItem>
            <SelectItem value="escalation">Escalation</SelectItem>
            <SelectItem value="overdue">Overdue</SelectItem>
            <SelectItem value="due">Due</SelectItem>
            <SelectItem value="on_track">On Track</SelectItem>
          </SelectContent>
        </Select>
        <Select value={sortBy} onValueChange={(v) => setSortBy(v as SortField)}>
          <SelectTrigger className="w-[180px]">
            <SlidersHorizontal className="h-4 w-4 mr-2" />
            <SelectValue placeholder="Sort by" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="priority_rank">Priority Rank</SelectItem>
            <SelectItem value="pressure_score">Pressure Score</SelectItem>
            <SelectItem value="days_since_activity">Days Inactive</SelectItem>
            <SelectItem value="follow_up_status">Follow-up Status</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Claims list */}
      {filtered.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <p className="text-lg">No claims match your filters</p>
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map(claim => (
            <ClaimBoardCard key={claim.claim_id} entry={claim} />
          ))}
        </div>
      )}
    </div>
  );
};

export default ClaimsControlBoard;

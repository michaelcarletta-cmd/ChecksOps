import { useState, useMemo } from "react";
import { useClaimControlBoard } from "@/hooks/useClaimControlBoard";
import { useGlobalImmediateMicrotasks } from "@/hooks/useGlobalImmediateMicrotasks";
import { ClaimBoardCard } from "@/components/control-board/ClaimBoardCard";
import { NeedsActionStrip } from "@/components/control-board/NeedsActionStrip";
import { BoardSummaryBar } from "@/components/control-board/BoardSummaryBar";
import { ClaimBoardEntry } from "@/services/claimOperationsService";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Loader2, Search, SlidersHorizontal, ChevronDown, ChevronRight } from "lucide-react";

type SortField = "priority_rank" | "days_since_activity" | "pressure_score" | "follow_up_status";

interface LaneConfig {
  key: string;
  label: string;
  filter: (c: ClaimBoardEntry) => boolean;
  accentClass: string;
  defaultOpen: boolean;
}

const LANES: LaneConfig[] = [
  {
    key: "needs_action",
    label: "Needs Action Now",
    filter: (c) =>
      c.ops?.follow_up_status === "escalation" ||
      c.ops?.follow_up_status === "overdue" ||
      c.immediate_microtasks > 0 ||
      c.blocking_microtasks > 0 ||
      (c.overdue_tasks || 0) > 0,
    accentClass: "border-l-red-500",
    defaultOpen: true,
  },
  {
    key: "due_soon",
    label: "Due Soon",
    filter: (c) => c.ops?.follow_up_status === "due",
    accentClass: "border-l-amber-500",
    defaultOpen: true,
  },
  {
    key: "carrier_waiting",
    label: "Waiting on Carrier",
    filter: (c) => {
      const status = c.status || "";
      return [
        "Carrier Review",
        "Funding from Insurance",
        "Recoverable Depreciation Requested",
        "Waiting on ACV Funds",
        "Waiting on Insurance Funds (ACV)",
        "Waiting on Mortgage Check",
      ].includes(status);
    },
    accentClass: "border-l-muted-foreground",
    defaultOpen: false,
  },
  {
    key: "on_track",
    label: "On Track",
    filter: () => true, // catch-all
    accentClass: "border-l-green-500",
    defaultOpen: false,
  },
];

const ClaimsControlBoard = () => {
  const { data: claims = [], isLoading } = useClaimControlBoard();
  const { data: immediateTasks = [] } = useGlobalImmediateMicrotasks();
  const [sortBy, setSortBy] = useState<SortField>("priority_rank");
  const [search, setSearch] = useState("");

  // Apply search filter
  const filtered = useMemo(() => {
    if (!search.trim()) return claims;
    const q = search.toLowerCase();
    return claims.filter(
      (c) =>
        c.claim_number?.toLowerCase().includes(q) ||
        c.policyholder_name?.toLowerCase().includes(q) ||
        c.insurance_carrier?.toLowerCase().includes(q) ||
        c.property_address?.toLowerCase().includes(q)
    );
  }, [claims, search]);

  // Sort function
  const sortClaims = (list: ClaimBoardEntry[]) => {
    return [...list].sort((a, b) => {
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
  };

  // Distribute claims into lanes (each claim goes to first matching lane)
  const laneData = useMemo(() => {
    const assigned = new Set<string>();
    return LANES.map((lane) => {
      const laneClaims = filtered.filter((c) => {
        if (assigned.has(c.claim_id)) return false;
        if (lane.key === "on_track") {
          // catch-all: anything not assigned yet
          return !assigned.has(c.claim_id);
        }
        return lane.filter(c);
      });
      laneClaims.forEach((c) => assigned.add(c.claim_id));
      return { ...lane, claims: sortClaims(laneClaims) };
    });
  }, [filtered, sortBy]);

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
          {claims.length} active claims
        </p>
      </div>

      {/* Daily pulse summary */}
      <BoardSummaryBar claims={claims} />

      {/* Needs Action Now strip */}
      {immediateTasks.length > 0 && (
        <NeedsActionStrip tasks={immediateTasks} />
      )}

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search claims..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-10"
          />
        </div>
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

      {/* Grouped lanes */}
      {claims.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <p className="text-lg">All claims are closed.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {laneData.map((lane) => (
            <LaneSection key={lane.key} lane={lane} />
          ))}
        </div>
      )}
    </div>
  );
};

function LaneSection({ lane }: { lane: LaneConfig & { claims: ClaimBoardEntry[] } }) {
  const [open, setOpen] = useState(lane.defaultOpen || lane.claims.length > 0 && lane.key === "needs_action");

  if (lane.claims.length === 0) return null;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className={`flex items-center gap-2 w-full p-3 rounded-lg border border-l-4 ${lane.accentClass} bg-card hover:bg-accent/50 transition-colors`}>
        {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        <span className="font-semibold text-sm text-foreground">{lane.label}</span>
        <Badge variant={lane.key === "needs_action" ? "destructive" : lane.key === "due_soon" ? "secondary" : "outline"} className="text-xs">
          {lane.claims.length}
        </Badge>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="space-y-2 mt-2 ml-2">
          {lane.claims.map((claim) => (
            <ClaimBoardCard key={claim.claim_id} entry={claim} />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

export default ClaimsControlBoard;

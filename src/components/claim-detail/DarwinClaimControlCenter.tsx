import { useEffect, useMemo, useState, lazy, Suspense } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ClaimOverview } from "@/components/claim-detail/ClaimOverview";
import { ClaimCashFlowCard } from "@/components/loss-draft/ClaimCashFlowCard";
import { CheckStatusWorkflow } from "@/components/check-review/CheckStatusWorkflow";
import { ClaimAssigned } from "@/components/claim-detail/ClaimAssigned";
import { ClaimActivity } from "@/components/claim-detail/ClaimActivity";
import { ClaimAccounting } from "@/components/claim-detail/ClaimAccounting";
import { ClaimTasks } from "@/components/claim-detail/ClaimTasks";
import { ClaimInspections } from "@/components/claim-detail/ClaimInspections";
import { ChevronDown, Loader2 } from "lucide-react";
import { useIsMobile } from "@/hooks/use-mobile";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";

const ClaimExternalSync = lazy(() => import("@/components/claim-detail/ClaimExternalSync").then(m => ({ default: m.ClaimExternalSync })));
const ClaimAccessManagement = lazy(() => import("@/components/claim-detail/ClaimAccessManagement").then(m => ({ default: m.ClaimAccessManagement })));

interface DarwinClaimControlCenterProps {
  claimId: string;
  claim: any;
  userRole: string | null;
  isStaffOrAdmin: boolean;
  onClaimUpdated?: (claim: any) => void;
  defaultTab?: string;
  onTabChange?: (tab: string) => void;
}

interface ControlTab {
  value: string;
  label: string;
  staffOnly?: boolean;
}

const controlTabs: ControlTab[] = [
  { value: "overview", label: "Overview" },
  { value: "assigned", label: "Assigned", staffOnly: true },
  { value: "activity", label: "Notes & Activity" },
  { value: "tasks", label: "Tasks", staffOnly: true },
  { value: "inspections", label: "Inspections" },
  { value: "funds", label: "Funds" },
  { value: "access", label: "Portal Access", staffOnly: true },
];

export function DarwinClaimControlCenter({
  claimId,
  claim,
  userRole,
  isStaffOrAdmin,
  onClaimUpdated,
  defaultTab = "overview",
  onTabChange,
}: DarwinClaimControlCenterProps) {
  const [internalTab, setInternalTab] = useState(defaultTab);
  const activeControlTab = onTabChange ? defaultTab : internalTab;

  const handleTabChange = (value: string) => {
    if (onTabChange) {
      onTabChange(value);
    } else {
      setInternalTab(value);
    }
  };

  const visibleTabs = useMemo(
    () => controlTabs.filter((tab) => !tab.staffOnly || isStaffOrAdmin),
    [isStaffOrAdmin],
  );

  useEffect(() => {
    if (!onTabChange) setInternalTab("overview");
  }, [claimId, onTabChange]);

  useEffect(() => {
    if (!visibleTabs.some((tab) => tab.value === activeControlTab)) {
      handleTabChange(visibleTabs[0]?.value ?? "overview");
    }
  }, [visibleTabs, activeControlTab]);

  const isMobile = useIsMobile();
  const activeTabLabel = visibleTabs.find(t => t.value === activeControlTab)?.label || "Overview";

  return (
    <div className="space-y-4">
      <Tabs value={activeControlTab} onValueChange={handleTabChange} className="w-full">
        {isMobile ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" className="w-full justify-between bg-muted border-border text-foreground font-medium">
                <span>{activeTabLabel}</span>
                <ChevronDown className="h-4 w-4 ml-2 opacity-50" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="w-[var(--radix-dropdown-menu-trigger-width)] bg-popover border-border" align="start">
              {visibleTabs.map((tab) => (
                <DropdownMenuItem
                  key={tab.value}
                  onClick={() => handleTabChange(tab.value)}
                  className={`cursor-pointer ${activeControlTab === tab.value ? 'bg-accent text-accent-foreground' : ''}`}
                >
                  {tab.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <TabsList className="flex flex-row w-full bg-muted p-2 gap-1 h-auto rounded-md overflow-x-auto">
            {visibleTabs.map((tab) => (
              <TabsTrigger
                key={tab.value}
                value={tab.value}
                className="w-auto justify-start text-sm font-medium px-3 py-2 text-muted-foreground data-[state=active]:bg-background data-[state=active]:text-foreground rounded-sm whitespace-nowrap"
              >
                {tab.label}
              </TabsTrigger>
            ))}
          </TabsList>
        )}

        <TabsContent value="overview" className="mt-6 space-y-6">
          <ClaimOverview claim={claim} isPortalUser={false} onClaimUpdated={onClaimUpdated} />
          {isStaffOrAdmin && (
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              <div className="lg:col-span-2">
                <ClaimCashFlowCard claimId={claimId} />
              </div>
              <div className="lg:col-span-1">
                <CheckStatusWorkflow claimId={claimId} />
              </div>
            </div>
          )}
        </TabsContent>

        {isStaffOrAdmin && (
          <TabsContent value="assigned" className="mt-6">
            <ClaimAssigned claim={claim} />
          </TabsContent>
        )}

        <TabsContent value="activity" className="mt-6">
          <ClaimActivity claimId={claimId} claim={claim} isPortalUser={false} />
        </TabsContent>

        {isStaffOrAdmin && (
          <TabsContent value="tasks" className="mt-6">
            <ClaimTasks claimId={claimId} />
          </TabsContent>
        )}

        <TabsContent value="inspections" className="mt-6">
          <ClaimInspections claimId={claimId} />
        </TabsContent>

        <TabsContent value="funds" className="mt-6">
          <ClaimAccounting claim={claim} userRole={userRole} />
        </TabsContent>

        {isStaffOrAdmin && (
          <TabsContent value="access" className="mt-6 space-y-6">
            <Suspense fallback={<div className="flex items-center justify-center p-8"><Loader2 className="h-6 w-6 animate-spin text-primary mr-2" /><span className="text-muted-foreground">Loading...</span></div>}>
              <ClaimExternalSync claimId={claimId} />
              <ClaimAccessManagement claimId={claimId} isGuidedMode={claim?.is_guided_mode} />
            </Suspense>
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}

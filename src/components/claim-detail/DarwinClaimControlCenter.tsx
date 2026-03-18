import { useEffect, useMemo, useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ClaimOverview } from "@/components/claim-detail/ClaimOverview";
import { ClaimCashFlowCard } from "@/components/loss-draft/ClaimCashFlowCard";
import { ClaimAssigned } from "@/components/claim-detail/ClaimAssigned";
import { ClaimActivity } from "@/components/claim-detail/ClaimActivity";
import { ClaimTasks } from "@/components/claim-detail/ClaimTasks";
import { ClaimPhotos } from "@/components/claim-detail/ClaimPhotos";
import { ClaimFiles } from "@/components/claim-detail/ClaimFiles";
import { ClaimAccounting } from "@/components/claim-detail/ClaimAccounting";

interface DarwinClaimControlCenterProps {
  claimId: string;
  claim: any;
  userRole: string | null;
  isStaffOrAdmin: boolean;
  onClaimUpdated?: (claim: any) => void;
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
  { value: "photos", label: "Photos" },
  { value: "files", label: "Files" },
  { value: "accounting", label: "Accounting" },
];

export function DarwinClaimControlCenter({
  claimId,
  claim,
  userRole,
  isStaffOrAdmin,
  onClaimUpdated,
}: DarwinClaimControlCenterProps) {
  const [activeControlTab, setActiveControlTab] = useState("overview");

  const visibleTabs = useMemo(
    () => controlTabs.filter((tab) => !tab.staffOnly || isStaffOrAdmin),
    [isStaffOrAdmin],
  );

  useEffect(() => {
    setActiveControlTab("overview");
  }, [claimId]);

  useEffect(() => {
    if (!visibleTabs.some((tab) => tab.value === activeControlTab)) {
      setActiveControlTab(visibleTabs[0]?.value ?? "overview");
    }
  }, [visibleTabs, activeControlTab]);

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-base font-semibold">Claim Control Center</h3>
        <p className="text-sm text-muted-foreground">
          Control your core claim tabs directly inside Darwin.
        </p>
      </div>

      <Tabs value={activeControlTab} onValueChange={setActiveControlTab} className="w-full">
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

        <TabsContent value="overview" className="mt-6 space-y-6">
          <ClaimOverview claim={claim} isPortalUser={false} onClaimUpdated={onClaimUpdated} />
          {isStaffOrAdmin && <ClaimCashFlowCard claimId={claimId} />}
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

        <TabsContent value="photos" className="mt-6">
          <ClaimPhotos claimId={claimId} claim={claim} isPortalUser={false} />
        </TabsContent>

        <TabsContent value="files" className="mt-6">
          <ClaimFiles claimId={claimId} claim={claim} isStaffOrAdmin={isStaffOrAdmin} />
        </TabsContent>

        <TabsContent value="accounting" className="mt-6">
          <ClaimAccounting claim={claim} userRole={userRole} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

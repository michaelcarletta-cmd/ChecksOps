import { useState, useEffect, Suspense, lazy } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Calculator } from "lucide-react";

const DarwinEstimateComparison = lazy(() => import("@/components/claim-detail/DarwinEstimateComparison").then(m => ({ default: m.DarwinEstimateComparison })));
const DarwinEstimateGapAnalysis = lazy(() => import("@/components/claim-detail/DarwinEstimateGapAnalysis").then(m => ({ default: m.DarwinEstimateGapAnalysis })));
const DarwinSupplementGenerator = lazy(() => import("@/components/claim-detail/DarwinSupplementGenerator").then(m => ({ default: m.DarwinSupplementGenerator })));
const DarwinEstimateBuilder = lazy(() => import("@/components/claim-detail/DarwinEstimateBuilder").then(m => ({ default: m.DarwinEstimateBuilder })));
const DarwinScopeEngine = lazy(() => import("@/components/claim-detail/DarwinScopeEngine").then(m => ({ default: m.DarwinScopeEngine })));
const LineItemJustificationPanel = lazy(() => import("@/components/claim-detail/LineItemJustificationPanel").then(m => ({ default: m.LineItemJustificationPanel })));

type SectionKey = "estimate_comparison" | "gap_analysis" | "supplement" | "estimate_builder" | "scope_engine" | "justification";

const STORAGE_KEY = "estimate-workspace-selected-section";

const sectionOptions: { value: SectionKey; label: string }[] = [
  { value: "estimate_comparison", label: "Estimate Comparison" },
  { value: "gap_analysis", label: "Estimate Gap Analysis" },
  { value: "supplement", label: "Supplement Generator" },
  { value: "estimate_builder", label: "Estimate Builder" },
  { value: "scope_engine", label: "Scope Engine" },
  { value: "justification", label: "Line Item Justification" },
];

interface EstimateWorkspacePanelProps {
  claimId: string;
  claim: any;
}

export const EstimateWorkspacePanel = ({ claimId, claim }: EstimateWorkspacePanelProps) => {
  const [selectedSection, setSelectedSection] = useState<SectionKey>(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && sectionOptions.some(o => o.value === stored)) return stored as SectionKey;
    return "estimate_comparison";
  });

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, selectedSection);
  }, [selectedSection]);

  // Placeholder line items from claim data - will be populated from estimate tables
  const lineItems = claim?.estimate_items || [];

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <Calculator className="h-4 w-4 text-primary" />
          <div>
            <h3 className="text-sm font-semibold">Estimate Workspace</h3>
            <p className="text-[11px] text-muted-foreground">Select a section below to focus on one tool at a time.</p>
          </div>
        </div>
        <Select value={selectedSection} onValueChange={(v) => setSelectedSection(v as SectionKey)}>
          <SelectTrigger className="w-full sm:w-[280px] h-9 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {sectionOptions.map(opt => (
              <SelectItem key={opt.value} value={opt.value} className="text-xs">
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <Suspense fallback={<div className="text-xs text-muted-foreground py-4">Loading…</div>}>
        {selectedSection === "estimate_comparison" && <DarwinEstimateComparison claimId={claimId} claim={claim} />}
        {selectedSection === "gap_analysis" && <DarwinEstimateGapAnalysis claimId={claimId} claim={claim} />}
        {selectedSection === "supplement" && <DarwinSupplementGenerator claimId={claimId} claim={claim} />}
        {selectedSection === "estimate_builder" && <DarwinEstimateBuilder claimId={claimId} claim={claim} />}
        {selectedSection === "scope_engine" && <DarwinScopeEngine claimId={claimId} claim={claim} />}
        {selectedSection === "justification" && <LineItemJustificationPanel claimId={claimId} claim={claim} lineItems={lineItems} />}
      </Suspense>
    </div>
  );
};

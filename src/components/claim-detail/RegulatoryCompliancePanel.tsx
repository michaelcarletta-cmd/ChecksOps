import { useState, useEffect, Suspense, lazy } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Clock } from "lucide-react";

const DarwinStateLawAdvisor = lazy(() => import("@/components/claim-detail/DarwinStateLawAdvisor").then(m => ({ default: m.DarwinStateLawAdvisor })));
const DarwinCarrierDeadlineMonitor = lazy(() => import("@/components/claim-detail/DarwinCarrierDeadlineMonitor").then(m => ({ default: m.DarwinCarrierDeadlineMonitor })));
const DarwinDeadlineTracker = lazy(() => import("@/components/claim-detail/DarwinDeadlineTracker").then(m => ({ default: m.DarwinDeadlineTracker })));
const DarwinQualifyingLanguage = lazy(() => import("@/components/claim-detail/DarwinQualifyingLanguage").then(m => ({ default: m.DarwinQualifyingLanguage })));
const DarwinComplianceChecker = lazy(() => import("@/components/claim-detail/DarwinComplianceChecker").then(m => ({ default: m.DarwinComplianceChecker })));
const DarwinDOBILetterDrafter = lazy(() => import("@/components/claim-detail/DarwinDOBILetterDrafter").then(m => ({ default: m.DarwinDOBILetterDrafter })));
const DarwinBuildingCodes = lazy(() => import("@/components/claim-detail/DarwinBuildingCodes").then(m => ({ default: m.DarwinBuildingCodes })));

type SectionKey = "state_law" | "carrier_deadlines" | "deadline_tracker" | "qualifying_language" | "compliance_checker" | "dobi_letter" | "building_codes";

const STORAGE_KEY = "regulatory-compliance-selected-section";

const sectionOptions: { value: SectionKey; label: string }[] = [
  { value: "state_law", label: "State Law Advisor" },
  { value: "carrier_deadlines", label: "Carrier Deadline Monitor" },
  { value: "deadline_tracker", label: "Deadline Tracker" },
  { value: "qualifying_language", label: "Qualifying Language" },
  { value: "compliance_checker", label: "Compliance Checker" },
  { value: "dobi_letter", label: "DOBI Letter Drafter" },
  { value: "building_codes", label: "Building Codes" },
];

interface RegulatoryCompliancePanelProps {
  claimId: string;
  claim: any;
}

export const RegulatoryCompliancePanel = ({ claimId, claim }: RegulatoryCompliancePanelProps) => {
  const [selectedSection, setSelectedSection] = useState<SectionKey>(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && sectionOptions.some(o => o.value === stored)) return stored as SectionKey;
    return "state_law";
  });

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, selectedSection);
  }, [selectedSection]);

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <Clock className="h-4 w-4 text-primary" />
          <div>
            <h3 className="text-sm font-semibold">Regulatory & Compliance</h3>
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
        {selectedSection === "state_law" && <DarwinStateLawAdvisor claimId={claimId} claim={claim} />}
        {selectedSection === "carrier_deadlines" && <DarwinCarrierDeadlineMonitor claimId={claimId} claim={claim} />}
        {selectedSection === "deadline_tracker" && <DarwinDeadlineTracker claimId={claimId} claim={claim} />}
        {selectedSection === "qualifying_language" && <DarwinQualifyingLanguage claimId={claimId} claim={claim} />}
        {selectedSection === "compliance_checker" && <DarwinComplianceChecker claimId={claimId} claim={claim} />}
        {selectedSection === "dobi_letter" && <DarwinDOBILetterDrafter claimId={claimId} claim={claim} />}
        {selectedSection === "building_codes" && <DarwinBuildingCodes claimId={claimId} claim={claim} />}
      </Suspense>
    </div>
  );
};

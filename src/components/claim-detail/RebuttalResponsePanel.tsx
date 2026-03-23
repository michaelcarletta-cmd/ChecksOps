import { useState, useEffect, Suspense, lazy } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Shield } from "lucide-react";

const DarwinDeclaredPosition = lazy(() => import("@/components/claim-detail/DarwinDeclaredPosition").then(m => ({ default: m.DarwinDeclaredPosition })));
const DarwinButForCausation = lazy(() => import("@/components/claim-detail/DarwinButForCausation").then(m => ({ default: m.DarwinButForCausation })));
const DarwinAutoDraftRebuttal = lazy(() => import("@/components/claim-detail/DarwinAutoDraftRebuttal").then(m => ({ default: m.DarwinAutoDraftRebuttal })));
const DarwinDenialAnalyzer = lazy(() => import("@/components/claim-detail/DarwinDenialAnalyzer").then(m => ({ default: m.DarwinDenialAnalyzer })));
const DarwinEngineerReportAnalyzer = lazy(() => import("@/components/claim-detail/DarwinEngineerReportAnalyzer").then(m => ({ default: m.DarwinEngineerReportAnalyzer })));
const DarwinCorrespondenceAnalyzer = lazy(() => import("@/components/claim-detail/DarwinCorrespondenceAnalyzer").then(m => ({ default: m.DarwinCorrespondenceAnalyzer })));

type SectionKey = "declared_position" | "but_for_causation" | "engineer" | "denial" | "correspondence" | "auto_rebuttal";

const STORAGE_KEY = "rebuttal-response-selected-section";

const sectionOptions: { value: SectionKey; label: string }[] = [
  { value: "declared_position", label: "Declared Position" },
  { value: "but_for_causation", label: "But-For Causation Analysis" },
  { value: "engineer", label: "Engineer Report Analyzer" },
  { value: "denial", label: "Denial Letter Analyzer" },
  { value: "correspondence", label: "Adjuster Correspondence Analyzer" },
  { value: "auto_rebuttal", label: "Darwin Auto Draft Rebuttal" },
];

interface RebuttalResponsePanelProps {
  claimId: string;
  claim: any;
}

export const RebuttalResponsePanel = ({ claimId, claim }: RebuttalResponsePanelProps) => {
  const [selectedSection, setSelectedSection] = useState<SectionKey>(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && sectionOptions.some(o => o.value === stored)) return stored as SectionKey;
    return "declared_position";
  });

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, selectedSection);
  }, [selectedSection]);

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <Shield className="h-4 w-4 text-primary" />
          <div>
            <h3 className="text-sm font-semibold">Rebuttal & Response</h3>
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
        {selectedSection === "declared_position" && <DarwinDeclaredPosition claimId={claimId} claim={claim} />}
        {selectedSection === "but_for_causation" && <DarwinButForCausation claimId={claimId} claim={claim} />}
        {selectedSection === "engineer" && <DarwinEngineerReportAnalyzer claimId={claimId} claim={claim} />}
        {selectedSection === "denial" && <DarwinDenialAnalyzer claimId={claimId} claim={claim} />}
        {selectedSection === "correspondence" && <DarwinCorrespondenceAnalyzer claimId={claimId} claim={claim} />}
        {selectedSection === "auto_rebuttal" && <DarwinAutoDraftRebuttal claimId={claimId} claim={claim} />}
      </Suspense>
    </div>
  );
};

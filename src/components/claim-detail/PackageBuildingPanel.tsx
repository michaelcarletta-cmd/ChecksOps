import { useState, lazy, Suspense } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Package, Loader2 } from "lucide-react";

const DarwinDemandPackage = lazy(() => import("@/components/claim-detail/DarwinDemandPackage").then(m => ({ default: m.DarwinDemandPackage })));
const RecoverableDepreciationInvoice = lazy(() => import("@/components/claim-detail/RecoverableDepreciationInvoice").then(m => ({ default: m.RecoverableDepreciationInvoice })));
const DarwinDocumentCompiler = lazy(() => import("@/components/claim-detail/DarwinDocumentCompiler").then(m => ({ default: m.DarwinDocumentCompiler })));
const DarwinCarrierEmailDrafter = lazy(() => import("@/components/claim-detail/DarwinCarrierEmailDrafter").then(m => ({ default: m.DarwinCarrierEmailDrafter })));

const STORAGE_KEY = "package-building-selected-section";

type SectionKey = "demand_package" | "rd_invoice" | "document_compiler" | "carrier_email";

const sectionOptions: { value: SectionKey; label: string }[] = [
  { value: "demand_package", label: "Demand Package Builder" },
  { value: "rd_invoice", label: "Recoverable Depreciation Invoice" },
  { value: "document_compiler", label: "Document Compiler" },
  { value: "carrier_email", label: "Carrier Email Drafter" },
];

function getInitialSection(): SectionKey {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && sectionOptions.some(o => o.value === stored)) return stored as SectionKey;
  } catch {}
  return "demand_package";
}

const LoadingFallback = () => (
  <div className="flex items-center justify-center p-8 text-muted-foreground">
    <Loader2 className="h-5 w-5 animate-spin mr-2" />
    Loading…
  </div>
);

interface PackageBuildingPanelProps {
  claimId: string;
  claim: any;
}

export const PackageBuildingPanel = ({ claimId, claim }: PackageBuildingPanelProps) => {
  const [selected, setSelected] = useState<SectionKey>(getInitialSection);

  const handleChange = (value: SectionKey) => {
    setSelected(value);
    try { localStorage.setItem(STORAGE_KEY, value); } catch {}
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="flex items-center gap-2 shrink-0">
          <Package className="h-5 w-5 text-primary" />
          <h3 className="font-semibold text-base">Package Building</h3>
        </div>
        <Select value={selected} onValueChange={handleChange}>
          <SelectTrigger className="w-full sm:w-[280px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {sectionOptions.map(opt => (
              <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <p className="text-sm text-muted-foreground -mt-2">Select a tool below to focus on one at a time.</p>

      <Suspense fallback={<LoadingFallback />}>
        {selected === "demand_package" && <DarwinDemandPackage claimId={claimId} claim={claim} />}
        {selected === "rd_invoice" && <RecoverableDepreciationInvoice claimId={claimId} claim={claim} />}
        {selected === "document_compiler" && <DarwinDocumentCompiler claimId={claimId} claim={claim} />}
        {selected === "carrier_email" && <DarwinCarrierEmailDrafter claimId={claimId} claim={claim} />}
      </Suspense>
    </div>
  );
};

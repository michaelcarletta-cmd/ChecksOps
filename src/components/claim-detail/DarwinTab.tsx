import { useState, useEffect, lazy, Suspense, useMemo, useCallback } from "react";
import { useRenderCount } from "@/hooks/useRenderCount";
import { Brain, Loader2, MessageSquare, FileText, Shield, Calculator, Zap, Search, Clock, Sparkles, Swords, Building2, AlertCircle, Eye, Clipboard, Send, type LucideIcon } from "lucide-react";
import { DarwinCopilotPanel } from "./DarwinCopilotPanel";
import { DarwinCockpit } from "./DarwinCockpit";
import { ClaimAccounting } from "./ClaimAccounting";
import { ClaimFiles } from "./ClaimFiles";
import { ClaimPhotos } from "./ClaimPhotos";
import { supabase } from "@/integrations/supabase/client";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { toast } from "sonner";
import { subscribeCarrierDismantler } from "@/lib/darwinDismantlerBus";
import { DarwinSMSActivityLog } from "@/components/inbox/DarwinSMSActivityLog";
import { DismantlerOutput } from "./DismantlerOutput";
import type { DismantlerResult, ClaimFactsPack, DecisionCard, MissingDocRequest } from "@/lib/darwinContracts";

// Lazy load all Darwin components
const DarwinInsightsPanel = lazy(() => import("@/components/claim-detail/DarwinInsightsPanel").then(m => ({ default: m.DarwinInsightsPanel })));
const DarwinDenialAnalyzer = lazy(() => import("@/components/claim-detail/DarwinDenialAnalyzer").then(m => ({ default: m.DarwinDenialAnalyzer })));
const DarwinNextSteps = lazy(() => import("@/components/claim-detail/DarwinNextSteps").then(m => ({ default: m.DarwinNextSteps })));
const DarwinSupplementGenerator = lazy(() => import("@/components/claim-detail/DarwinSupplementGenerator").then(m => ({ default: m.DarwinSupplementGenerator })));
const DarwinCorrespondenceAnalyzer = lazy(() => import("@/components/claim-detail/DarwinCorrespondenceAnalyzer").then(m => ({ default: m.DarwinCorrespondenceAnalyzer })));
const DarwinEngineerReportAnalyzer = lazy(() => import("@/components/claim-detail/DarwinEngineerReportAnalyzer").then(m => ({ default: m.DarwinEngineerReportAnalyzer })));
const DarwinClaimBriefing = lazy(() => import("@/components/claim-detail/DarwinClaimBriefing").then(m => ({ default: m.DarwinClaimBriefing })));
const DarwinDocumentCompiler = lazy(() => import("@/components/claim-detail/DarwinDocumentCompiler").then(m => ({ default: m.DarwinDocumentCompiler })));
const DarwinDemandPackage = lazy(() => import("@/components/claim-detail/DarwinDemandPackage").then(m => ({ default: m.DarwinDemandPackage })));
const DarwinDocumentComparison = lazy(() => import("@/components/claim-detail/DarwinDocumentComparison").then(m => ({ default: m.DarwinDocumentComparison })));
const DarwinWeaknessDetection = lazy(() => import("@/components/claim-detail/DarwinWeaknessDetection").then(m => ({ default: m.DarwinWeaknessDetection })));
const DarwinDeadlineTracker = lazy(() => import("@/components/claim-detail/DarwinDeadlineTracker").then(m => ({ default: m.DarwinDeadlineTracker })));
const DarwinPhotoLinker = lazy(() => import("@/components/claim-detail/DarwinPhotoLinker").then(m => ({ default: m.DarwinPhotoLinker })));
const DarwinBuildingCodes = lazy(() => import("@/components/claim-detail/DarwinBuildingCodes").then(m => ({ default: m.DarwinBuildingCodes })));
const DarwinTaskGenerator = lazy(() => import("@/components/claim-detail/DarwinTaskGenerator").then(m => ({ default: m.DarwinTaskGenerator })));
const DarwinOutcomePredictor = lazy(() => import("@/components/claim-detail/DarwinOutcomePredictor").then(m => ({ default: m.DarwinOutcomePredictor })));
const DarwinStateLawAdvisor = lazy(() => import("@/components/claim-detail/DarwinStateLawAdvisor").then(m => ({ default: m.DarwinStateLawAdvisor })));
const DarwinCarrierDeadlineMonitor = lazy(() => import("@/components/claim-detail/DarwinCarrierDeadlineMonitor").then(m => ({ default: m.DarwinCarrierDeadlineMonitor })));
const DarwinLossOfUseCalculator = lazy(() => import("@/components/claim-detail/DarwinLossOfUseCalculator").then(m => ({ default: m.DarwinLossOfUseCalculator })));
const DarwinHomeInventoryBuilder = lazy(() => import("@/components/claim-detail/DarwinHomeInventoryBuilder").then(m => ({ default: m.DarwinHomeInventoryBuilder })));
const DarwinHiddenLossDetective = lazy(() => import("@/components/claim-detail/DarwinHiddenLossDetective").then(m => ({ default: m.DarwinHiddenLossDetective })));
const DarwinQualifyingLanguage = lazy(() => import("@/components/claim-detail/DarwinQualifyingLanguage").then(m => ({ default: m.DarwinQualifyingLanguage })));
const DarwinCarrierEmailDrafter = lazy(() => import("@/components/claim-detail/DarwinCarrierEmailDrafter").then(m => ({ default: m.DarwinCarrierEmailDrafter })));
const DarwinWeatherHistory = lazy(() => import("@/components/claim-detail/DarwinWeatherHistory").then(m => ({ default: m.DarwinWeatherHistory })));
const DarwinOneClickPackage = lazy(() => import("@/components/claim-detail/DarwinOneClickPackage").then(m => ({ default: m.DarwinOneClickPackage })));
const DarwinAutoDraftRebuttal = lazy(() => import("@/components/claim-detail/DarwinAutoDraftRebuttal").then(m => ({ default: m.DarwinAutoDraftRebuttal })));
const DarwinAutoSummary = lazy(() => import("@/components/claim-detail/DarwinAutoSummary").then(m => ({ default: m.DarwinAutoSummary })));

const DarwinEstimateGapAnalysis = lazy(() => import("@/components/claim-detail/DarwinEstimateGapAnalysis").then(m => ({ default: m.DarwinEstimateGapAnalysis })));
const DarwinEstimateComparison = lazy(() => import("@/components/claim-detail/DarwinEstimateComparison").then(m => ({ default: m.DarwinEstimateComparison })));
const DarwinDocumentTimeline = lazy(() => import("@/components/claim-detail/DarwinDocumentTimeline").then(m => ({ default: m.DarwinDocumentTimeline })));
const DarwinComplianceChecker = lazy(() => import("@/components/claim-detail/DarwinComplianceChecker").then(m => ({ default: m.DarwinComplianceChecker })));
const DarwinDOBILetterDrafter = lazy(() => import("@/components/claim-detail/DarwinDOBILetterDrafter").then(m => ({ default: m.DarwinDOBILetterDrafter })));
const ProofOfLossGenerator = lazy(() => import("@/components/claim-detail/ProofOfLossGenerator").then(m => ({ default: m.ProofOfLossGenerator })));
const ClaimContextPipeline = lazy(() => import("@/components/claim-detail/ClaimContextPipeline").then(m => ({ default: m.ClaimContextPipeline })));
const RecoverableDepreciationInvoice = lazy(() => import("@/components/claim-detail/RecoverableDepreciationInvoice").then(m => ({ default: m.RecoverableDepreciationInvoice })));
const ClaimAutonomySettings = lazy(() => import("@/components/claim-detail/ClaimAutonomySettings").then(m => ({ default: m.ClaimAutonomySettings })));
const RecoverableDepreciationFollowUps = lazy(() => import("@/components/claim-detail/RecoverableDepreciationFollowUps").then(m => ({ default: m.RecoverableDepreciationFollowUps })));
const DarwinButForCausation = lazy(() => import("@/components/claim-detail/DarwinButForCausation").then(m => ({ default: m.DarwinButForCausation })));
const DarwinProximityPrecedents = lazy(() => import("@/components/claim-detail/DarwinProximityPrecedents").then(m => ({ default: m.DarwinProximityPrecedents })));
const DarwinDeclaredPosition = lazy(() => import("@/components/claim-detail/DarwinDeclaredPosition").then(m => ({ default: m.DarwinDeclaredPosition })));

// New Strategic Components
const ClaimWarRoom = lazy(() => import("@/components/claim-detail/ClaimWarRoom").then(m => ({ default: m.ClaimWarRoom })));
const CarrierPlaybookDialog = lazy(() => import("@/components/claim-detail/CarrierPlaybookDialog").then(m => ({ default: m.CarrierPlaybookDialog })));
// DarwinSecondBrain removed — nudges merged into Copilot panel
const DarwinCommandBar = lazy(() => import("@/components/claim-detail/DarwinCommandBar").then(m => ({ default: m.DarwinCommandBar })));
const DarwinGeneratedAssets = lazy(() => import("@/components/claim-detail/DarwinGeneratedAssets").then(m => ({ default: m.DarwinGeneratedAssets })));
const CarrierScenarioPlaybook = lazy(() => import("@/components/claim-detail/CarrierScenarioPlaybook").then(m => ({ default: m.CarrierScenarioPlaybook })));
const DarwinEscalationEngine = lazy(() => import("@/components/claim-detail/DarwinEscalationEngine"));
const DarwinHealthCheck = lazy(() => import("@/components/claim-detail/DarwinHealthCheck"));
const DarwinRoofEstimate = lazy(() => import("@/components/claim-detail/DarwinRoofEstimate").then(m => ({ default: m.DarwinRoofEstimate })));
const DarwinEstimateBuilder = lazy(() => import("@/components/claim-detail/DarwinEstimateBuilder").then(m => ({ default: m.DarwinEstimateBuilder })));
const DarwinScopeEngine = lazy(() => import("@/components/claim-detail/DarwinScopeEngine").then(m => ({ default: m.DarwinScopeEngine })));
const DarwinClaimControlCenter = lazy(() => import("@/components/claim-detail/DarwinClaimControlCenter").then(m => ({ default: m.DarwinClaimControlCenter })));
const RebuttalResponsePanel = lazy(() => import("@/components/claim-detail/RebuttalResponsePanel").then(m => ({ default: m.RebuttalResponsePanel })));
const RegulatoryCompliancePanel = lazy(() => import("@/components/claim-detail/RegulatoryCompliancePanel").then(m => ({ default: m.RegulatoryCompliancePanel })));
const EstimateWorkspacePanel = lazy(() => import("@/components/claim-detail/EstimateWorkspacePanel").then(m => ({ default: m.EstimateWorkspacePanel })));
const PackageBuildingPanel = lazy(() => import("@/components/claim-detail/PackageBuildingPanel").then(m => ({ default: m.PackageBuildingPanel })));


interface DarwinTabProps {
  claimId: string;
  claim: any;
  userRole: string | null;
  isStaffOrAdmin: boolean;
  onClaimUpdated?: (claim: any) => void;
}

const LoadingFallback = () => (
  <div className="flex items-center justify-center p-6">
    <Loader2 className="h-5 w-5 animate-spin text-primary mr-2" />
    <span className="text-sm text-muted-foreground">Loading...</span>
  </div>
);

type DarwinWorkspaceKey =
  | "claim-control-center"
  | "claim-intelligence"
  | "document-analysis"
  | "rebuttals"
  | "estimates"
  | "package-building"
  | "regulatory-compliance"
  | "contents-loss"
  | "automation";

interface DarwinWorkspaceSection {
  key: DarwinWorkspaceKey;
  title: string;
  description: string;
  icon: LucideIcon;
}

const workspaceSections: DarwinWorkspaceSection[] = [
  {
    key: "claim-control-center",
    title: "Claim Control Center",
    description: "Manage overview, assignments, activity, tasks, and inspections",
    icon: Clipboard,
  },
  {
    key: "claim-intelligence",
    title: "Claim Intelligence",
    description: "Insights, accounting, strategic command, and quick actions",
    icon: Search,
  },
  {
    key: "document-analysis",
    title: "Document Analysis",
    description: "Files, photos, comparison, and sorting",
    icon: FileText,
  },
  {
    key: "rebuttals",
    title: "Rebuttals & Responses",
    description: "Counter denials, causation analysis, and draft responses",
    icon: Shield,
  },
  {
    key: "estimates",
    title: "Estimate Workspace",
    description: "Roof measurements, estimate building, and scope engine",
    icon: Calculator,
  },
  {
    key: "package-building",
    title: "Package Building",
    description: "Generate demand packages and outbound docs",
    icon: Sparkles,
  },
  {
    key: "regulatory-compliance",
    title: "Regulatory & Compliance",
    description: "Deadlines, statutes, and compliance checks",
    icon: Clock,
  },
  {
    key: "contents-loss",
    title: "Contents & Loss Tracking",
    description: "ALE, inventory, and hidden damage support",
    icon: Calculator,
  },
  {
    key: "automation",
    title: "Automation Settings",
    description: "Configure autonomous Darwin workflows",
    icon: Zap,
  },
];

const sectionToWorkspace: Record<string, DarwinWorkspaceKey> = {
  rebuttals: "rebuttals",
  "document-analysis": "document-analysis",
};

// Map analysis types to readable names and scroll targets
const analysisTypeLabels: Record<string, { label: string; section: string }> = {
  denial_rebuttal: { label: 'Denial Rebuttal', section: 'rebuttals' },
  engineer_report_rebuttal: { label: 'Engineer Report Rebuttal', section: 'rebuttals' },
  estimate_gap_analysis: { label: 'Estimate Gap Analysis', section: 'document-analysis' },
  systematic_dismantling: { label: 'Systematic Dismantling', section: 'rebuttals' },
};

export const DarwinTab = ({ claimId, claim, userRole, isStaffOrAdmin, onClaimUpdated }: DarwinTabProps) => {
  useRenderCount("DarwinTab");
  const isMobile = useIsMobile();
  const [showCopilot, setShowCopilot] = useState(true);
  const [mobileSheetOpen, setMobileSheetOpen] = useState(false);
  const [copilotExpanded, setCopilotExpanded] = useState(false);
  const [copilotView, setCopilotView] = useState<'conversation' | 'dismantler'>('conversation');
  const [activeWorkspace, setActiveWorkspace] = useState<DarwinWorkspaceKey>("claim-control-center");
  const [activeTab, setActiveTab] = useState("overview");
  const [autoAnalyses, setAutoAnalyses] = useState<Array<{ id: string; analysis_type: string; created_at: string; input_summary: string }>>([]);
  const [dismissedAnalyses, setDismissedAnalyses] = useState<Set<string>>(new Set());
  const [liveCarrierDismantler, setLiveCarrierDismantler] = useState<{
    analysisType: string;
    receivedAt: string;
    payload: any;
    claimFactsPack?: ClaimFactsPack | null;
  } | null>(null);
  const [fallbackDismantler, setFallbackDismantler] = useState<{
    id: string;
    created_at: string;
    result: string | null;
  } | null>(null);

  // Fetch recent auto-triggered analyses
  useEffect(() => {
    const fetchAutoAnalyses = async () => {
      const { data } = await supabase
        .from('darwin_analysis_results')
        .select('id, analysis_type, created_at, input_summary')
        .eq('claim_id', claimId)
        .in('analysis_type', ['denial_rebuttal', 'engineer_report_rebuttal', 'estimate_gap_analysis'])
        .gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()) // Last 24 hours
        .order('created_at', { ascending: false })
        .limit(5);

      if (data) {
        setAutoAnalyses(data);
      }
    };

    fetchAutoAnalyses();

    const fetchFallbackDismantler = async () => {
      const { data } = await supabase
        .from("darwin_analysis_results")
        .select("id, created_at, result, analysis_type")
        .eq("claim_id", claimId)
        .eq("analysis_type", "systematic_dismantling")
        .order("created_at", { ascending: false })
        .limit(1);

      if (data && data.length > 0) {
        setFallbackDismantler({
          id: data[0].id,
          created_at: data[0].created_at,
          result: data[0].result as any,
        });
      }
    };

    fetchFallbackDismantler();

    const unsubscribe = subscribeCarrierDismantler((detail) => {
      if (detail.claimId !== claimId) return;
      setLiveCarrierDismantler({
        analysisType: detail.analysisType,
        receivedAt: new Date().toISOString(),
        payload: detail.carrierDismantler,
        claimFactsPack: detail.claimFactsPack ?? undefined,
      });
    });

    // Subscribe to new analyses
    const channel = supabase
      .channel(`darwin_analyses_${claimId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'darwin_analysis_results',
          filter: `claim_id=eq.${claimId}`,
        },
        (payload) => {
          const newAnalysis = payload.new as any;
          if (['denial_rebuttal', 'engineer_report_rebuttal', 'estimate_gap_analysis'].includes(newAnalysis.analysis_type)) {
            setAutoAnalyses(prev => [newAnalysis, ...prev].slice(0, 5));
          }
          if (newAnalysis.analysis_type === "systematic_dismantling") {
            setFallbackDismantler({
              id: newAnalysis.id,
              created_at: newAnalysis.created_at,
              result: newAnalysis.result,
            });
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
      unsubscribe();
    };
  }, [claimId]);

  const handleDismissAnalysis = (id: string) => {
    setDismissedAnalyses(prev => new Set([...prev, id]));
  };

  const scrollToSection = (section: string) => {
    const targetWorkspace = sectionToWorkspace[section];
    if (targetWorkspace) {
      setActiveWorkspace(targetWorkspace);
    }
    
    if (section === "funds") {
      setActiveWorkspace("claim-control-center");
      setActiveTab("funds");
    }

    const workspace = document.getElementById("darwin-workspace");
    workspace?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const visibleAnalyses = autoAnalyses.filter(a => !dismissedAnalyses.has(a.id));
  const activeWorkspaceMeta =
    workspaceSections.find((section) => section.key === activeWorkspace) ?? workspaceSections[0];

  const dismantlerText: string | null = useMemo(() => {
    const live = liveCarrierDismantler?.payload;
    if (typeof live === "string") return live;
    if (live && typeof live === "object") {
      // backend returns structured { text, confidence, missingDocs }
      if (typeof (live as any).text === "string") return (live as any).text;
      // fallback: stringify for display
      return JSON.stringify(live, null, 2);
    }
    return fallbackDismantler?.result ?? null;
  }, [liveCarrierDismantler, fallbackDismantler]);

  const dismantlerStructured = useMemo(() => {
    const live = liveCarrierDismantler?.payload;
    if (live && typeof live === "object" && (live as any).confidence !== undefined) {
      return {
        confidence: Number((live as any).confidence) as number,
        missingDocs: Array.isArray((live as any).missingDocs) ? (live as any).missingDocs as string[] : [] as string[],
      };
    }
    return null;
  }, [liveCarrierDismantler?.payload]);

  const dismantlerFull = useMemo((): DismantlerResult | null => {
    const live = liveCarrierDismantler?.payload;
    if (live && typeof live === "object" && Array.isArray((live as any).objections) && typeof (live as any).requestedResolutionOverall === "string") {
      return live as DismantlerResult;
    }
    return null;
  }, [liveCarrierDismantler?.payload]);

  const parsedDismantler = useMemo(() => {
    if (dismantlerFull) {
      const evidenceLines = dismantlerFull.objections.flatMap((o) =>
        o.evidence.map((e) => (e.quote ? `${e.docName}: "${e.quote}"` : e.docName))
      );
      const resolution = [
        dismantlerFull.requestedResolutionOverall,
        ...dismantlerFull.objections.map((o) => o.requestedResolution).filter(Boolean),
      ].filter(Boolean);
      return {
        estimatedConfidence: dismantlerFull.confidence,
        evidenceLines,
        weaknesses: dismantlerFull.objections.map((o) => o.whyItFails || o.verbatim),
        resolution,
        missingDocs: dismantlerFull.missingDocs,
        missingDocRequests: dismantlerFull.missingDocRequests ?? [],
        notesForUser: dismantlerFull.notesForUser ?? [],
        objections: dismantlerFull.objections,
        decisionCards: dismantlerFull.decisionCards ?? [],
        isStructured: true as const,
      };
    }

    const text = dismantlerText || "";
    const headings = [
      "Carrier Position Summary",
      "Key Weaknesses",
      "Evidence to Emphasize",
      "Risk and Overreach Checks",
      "Requested Resolution",
    ];

    const findIndex = (h: string) => {
      const re = new RegExp(`^\\s*(?:##\\s*)?${h}\\s*$`, "im");
      const m = text.match(re);
      if (!m?.index && m?.index !== 0) return -1;
      return m.index;
    };

    const starts = headings
      .map((h) => ({ h, i: findIndex(h) }))
      .filter((x) => x.i >= 0)
      .sort((a, b) => a.i - b.i);

    const section = (h: string) => {
      const startObj = starts.find((s) => s.h === h);
      if (!startObj) return "";
      const start = startObj.i;
      const next = starts.find((s) => s.i > start)?.i ?? text.length;
      return text.slice(start, next).replace(/\r/g, "").trim();
    };

    const bulletsFromSection = (s: string) =>
      s
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.startsWith("-"))
        .map((l) => l.replace(/^-+\s*/, "").trim())
        .filter(Boolean);

    const numberedFromSection = (s: string) =>
      s
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => /^\d+\.\s+/.test(l))
        .map((l) => l.replace(/^\d+\.\s+/, "").trim())
        .filter(Boolean);

    const evidenceLines = bulletsFromSection(section("Evidence to Emphasize"));
    const weaknesses = bulletsFromSection(section("Key Weaknesses"));
    const resolution = numberedFromSection(section("Requested Resolution"));

    const defaultConfidence =
      evidenceLines.length === 0 ? 0.25 : evidenceLines.length < 2 ? 0.5 : 0.75;
    const estimatedConfidence =
      dismantlerStructured?.confidence !== undefined
        ? Math.max(0, Math.min(1, dismantlerStructured.confidence))
        : defaultConfidence;

    const defaultMissingDocs =
      evidenceLines.length === 0
        ? [
            "Declarations page",
            "Carrier estimate",
            "Denial/coverage letter",
            "Photos (damage + pre-loss if available)",
            "Engineer/contractor report (if causation disputed)",
          ]
        : [];
    const missingDocs =
      dismantlerStructured?.missingDocs?.length
        ? dismantlerStructured.missingDocs
        : defaultMissingDocs;

    return {
      estimatedConfidence,
      evidenceLines,
      weaknesses,
      resolution,
      missingDocs,
      missingDocRequests: [] as MissingDocRequest[],
      notesForUser: [] as string[],
      objections: [] as DismantlerResult["objections"],
      decisionCards: [] as DecisionCard[],
      isStructured: false as const,
    };
  }, [dismantlerText, dismantlerStructured, dismantlerFull]);


  const renderActiveWorkspace = () => {
    switch (activeWorkspace) {
      case "claim-control-center":
        return (
          <DarwinClaimControlCenter
            claimId={claimId}
            claim={claim}
            userRole={userRole}
            isStaffOrAdmin={isStaffOrAdmin}
            onClaimUpdated={onClaimUpdated}
            defaultTab={activeTab}
            onTabChange={setActiveTab}
          />
        );
      case "claim-intelligence":
        return (
          <>
            {/* War Room at the top */}
            <div className="flex items-center gap-2 mb-2">
              <Suspense fallback={<LoadingFallback />}>
                <ClaimWarRoom claimId={claimId} claim={claim} />
              </Suspense>
            </div>
            <DarwinCockpit
              claimId={claimId}
              claim={claim}
              onNavigateSection={(section) => {
                const targetWorkspace = section as DarwinWorkspaceKey;
                if (workspaceSections.some(s => s.key === targetWorkspace)) {
                  setActiveWorkspace(targetWorkspace);
                }
              }}
            />
            <ClaimAccounting claim={claim} userRole={userRole} />
            <DarwinProximityPrecedents claimId={claimId} claim={claim} />
            <Card className="bg-gradient-to-br from-primary/5 to-primary/10 border-primary/20">
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <Swords className="h-4 w-4 text-primary" />
                  Strategic Command
                </CardTitle>
              </CardHeader>
              <CardContent className="flex flex-wrap gap-2">
                <Suspense fallback={<LoadingFallback />}>
                  <CarrierPlaybookDialog
                    carrierName={claim?.insurance_company}
                    stateCode={claim?.property_state}
                  />
                </Suspense>
              </CardContent>
            </Card>
            <Card className="bg-gradient-to-br from-primary/5 to-primary/10 border-primary/20">
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <Zap className="h-4 w-4 text-primary" />
                  Quick Actions
                </CardTitle>
              </CardHeader>
              <CardContent className="flex flex-wrap gap-2">
                <Suspense fallback={<LoadingFallback />}>
                  <DarwinAutoSummary claimId={claimId} claim={claim} />
                  <DarwinOneClickPackage claimId={claimId} claim={claim} />
                  <ProofOfLossGenerator claimId={claimId} claim={claim} />
                  <ClaimContextPipeline claimId={claimId} claim={claim} />
                </Suspense>
              </CardContent>
            </Card>
          </>
        );
      case "document-analysis":
        return (
          <>
            <ClaimFiles claimId={claimId} claim={claim} isStaffOrAdmin={isStaffOrAdmin} />
            <ClaimPhotos claimId={claimId} claim={claim} isPortalUser={false} />
            <DarwinDocumentComparison claimId={claimId} claim={claim} />
            <DarwinPhotoLinker claimId={claimId} claim={claim} />
          </>
        );
      case "rebuttals":
        return <RebuttalResponsePanel claimId={claimId} claim={claim} />;
      case "estimates":
        return <EstimateWorkspacePanel claimId={claimId} claim={claim} />;
      case "package-building":
        return <PackageBuildingPanel claimId={claimId} claim={claim} />;
      case "regulatory-compliance":
        return <RegulatoryCompliancePanel claimId={claimId} claim={claim} />;
      case "contents-loss":
        return (
          <>
            <DarwinLossOfUseCalculator claimId={claimId} claim={claim} />
            <DarwinHomeInventoryBuilder claimId={claimId} claim={claim} />
            <DarwinHiddenLossDetective claimId={claimId} claim={claim} />
          </>
        );
      case "automation":
        return (
          <>
            <ClaimAutonomySettings claimId={claimId} />
            <RecoverableDepreciationFollowUps claimId={claimId} />
            <DarwinTaskGenerator claimId={claimId} claim={claim} />
            <DarwinSMSActivityLog claimId={claimId} limit={20} />
          </>
        );
      default:
        return null;
    }
  };

  if (!claimId || !claim) {
    return (
      <div className="flex items-center justify-center p-8 text-muted-foreground">
        Loading claim…
      </div>
    );
  }

  return (
    <div className="space-y-3 md:space-y-4">
      {/* Darwin Header - compact on mobile */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 md:gap-3">
          <div className="p-1.5 md:p-2 rounded-lg bg-primary/10">
            <Brain className="h-5 w-5 md:h-6 md:w-6 text-primary" />
          </div>
          <div>
            <h2 className="text-lg md:text-xl font-semibold">Darwin AI</h2>
            <p className="text-xs md:text-sm text-muted-foreground hidden sm:block">Your intelligent claims copilot</p>
          </div>
        </div>
        <Button
          variant={showCopilot ? "default" : "outline"}
          size="sm"
          onClick={() => {
            if (isMobile) {
              setMobileSheetOpen(true);
            } else {
              setShowCopilot(!showCopilot);
            }
          }}
          className="gap-1.5 text-xs md:text-sm"
        >
          <MessageSquare className="h-3.5 w-3.5 md:h-4 md:w-4" />
          <span className="hidden sm:inline">{isMobile ? "Open Copilot" : showCopilot ? "Hide Assistant Panel" : "Show Assistant Panel"}</span>
          <span className="sm:hidden">{isMobile ? "Copilot" : showCopilot ? "Hide" : "Show"}</span>
        </Button>
      </div>

      {/* Auto-Analysis Ready Banner */}
      {visibleAnalyses.length > 0 && (
        <Alert className="border-primary/50 bg-primary/5">
          <Brain className="h-4 w-4 text-primary" />
          <AlertTitle className="flex items-center gap-2">
            Darwin Analysis Ready
            <span className="text-xs font-normal text-muted-foreground">
              ({visibleAnalyses.length} {visibleAnalyses.length === 1 ? 'analysis' : 'analyses'} completed)
            </span>
          </AlertTitle>
          <AlertDescription className="mt-2 space-y-2">
            {visibleAnalyses.map(analysis => {
              const typeInfo = analysisTypeLabels[analysis.analysis_type] || { label: analysis.analysis_type, section: '' };
              const timeAgo = new Date(analysis.created_at).toLocaleTimeString();
              
              return (
                <div key={analysis.id} className="flex items-center justify-between gap-2 py-1">
                  <div className="flex-1 min-w-0">
                    <span className="font-medium text-sm">{typeInfo.label}</span>
                    {analysis.input_summary && (
                      <span className="text-xs text-muted-foreground ml-2 truncate">
                        {analysis.input_summary.substring(0, 50)}...
                      </span>
                    )}
                    <span className="text-xs text-muted-foreground ml-2">({timeAgo})</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button 
                      size="sm" 
                      variant="outline" 
                      className="h-7 text-xs gap-1"
                      onClick={() => scrollToSection(typeInfo.section)}
                    >
                      <Eye className="h-3 w-3" />
                      View
                    </Button>
                    <Button 
                      size="sm" 
                      variant="ghost" 
                      className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
                      onClick={() => handleDismissAnalysis(analysis.id)}
                    >
                      ×
                    </Button>
                  </div>
                </div>
              );
            })}
          </AlertDescription>
        </Alert>
      )}

      {/* Workspace navigation - top of page */}
      {isMobile ? (
        <div className="space-y-2">
          <Select
            value={activeWorkspace}
            onValueChange={(value) => setActiveWorkspace(value as DarwinWorkspaceKey)}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Select Darwin workspace" />
            </SelectTrigger>
            <SelectContent>
              {workspaceSections.map((section) => (
                <SelectItem key={section.key} value={section.key}>
                  {section.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground px-1">{activeWorkspaceMeta.description}</p>
        </div>
      ) : (
        <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-hide">
          {workspaceSections.map((section) => {
            const SectionIcon = section.icon;
            return (
              <Button
                key={section.key}
                size="sm"
                variant={activeWorkspace === section.key ? "default" : "outline"}
                onClick={() => setActiveWorkspace(section.key)}
                aria-pressed={activeWorkspace === section.key}
                className={cn(
                  "whitespace-nowrap gap-2",
                  activeWorkspace === section.key && "ring-1 ring-primary/30",
                )}
              >
                <SectionIcon className="h-4 w-4" />
                {section.title}
              </Button>
            );
          })}
        </div>
      )}

      {/* Top context pills - scrollable on mobile */}
      <div className="flex flex-nowrap md:flex-wrap gap-1.5 md:gap-2 pb-1 overflow-x-auto scrollbar-hide">
        {claim?.insurance_company && (
          <span className="px-2 py-0.5 md:px-2.5 md:py-1 rounded-full bg-primary/10 text-primary text-[11px] md:text-xs flex items-center gap-1 whitespace-nowrap">
            <Building2 className="h-3 w-3" />
            {claim.insurance_company}
          </span>
        )}
        {(claim?.policyholder_state || claim?.property_state) && (
          <span className="px-2 py-0.5 md:px-2.5 md:py-1 rounded-full bg-muted text-muted-foreground text-[11px] md:text-xs whitespace-nowrap">
            State: {claim.policyholder_state || claim.property_state}
          </span>
        )}
        {claim?.loss_type && (
          <span className="px-2 py-0.5 md:px-2.5 md:py-1 rounded-full bg-muted text-muted-foreground text-[11px] md:text-xs whitespace-nowrap">
            Loss: {claim.loss_type}
          </span>
        )}
      </div>


      {/* Main Layout: workspace panel + assistant drawer */}
      <div
        className={cn(
          "grid gap-4 items-start",
          showCopilot
            ? copilotExpanded
              ? "xl:grid-cols-[minmax(0,1fr)_40rem]"
              : "xl:grid-cols-[minmax(0,1fr)_22rem]"
            : "",
        )}
      >
        {/* Center column - full width workspace */}
        <div className="min-w-0">
          <Suspense fallback={<LoadingFallback />}>
            <div className="space-y-4">{renderActiveWorkspace()}</div>
          </Suspense>
        </div>

        {/* Right drawer */}
        {showCopilot && (
          <div className="hidden xl:block flex-shrink-0 xl:sticky xl:top-4">
            <Card className="h-[calc(100vh-2rem)] flex flex-col border-primary/20">
            {/* Panel toggle */}
            <div className="flex border-b">
              <button
                className={cn(
                  "flex-1 px-3 py-2 text-xs font-medium transition-colors",
                  copilotView === 'conversation'
                    ? "bg-primary/10 text-primary border-b-2 border-primary"
                    : "text-muted-foreground hover:bg-accent/50"
                )}
                onClick={() => setCopilotView('conversation')}
              >
                <MessageSquare className="h-3 w-3 inline mr-1" />
                Copilot
              </button>
              <button
                className={cn(
                  "flex-1 px-3 py-2 text-xs font-medium transition-colors",
                  copilotView === 'dismantler'
                    ? "bg-primary/10 text-primary border-b-2 border-primary"
                    : "text-muted-foreground hover:bg-accent/50"
                )}
                onClick={() => setCopilotView('dismantler')}
              >
                <Shield className="h-3 w-3 inline mr-1" />
                Dismantler
              </button>
            </div>

            {copilotView === 'conversation' ? (
              <DarwinCopilotPanel claimId={claimId} isExpanded={copilotExpanded} onToggleExpand={() => setCopilotExpanded(e => !e)} />
            ) : (
            <div className="flex-1 overflow-y-auto">
              <CardHeader className="py-3 border-b bg-gradient-to-r from-primary/5 to-transparent">
                <div className="flex items-center gap-2">
                  <Shield className="h-4 w-4 text-primary" />
                  <CardTitle className="text-sm">Dismantler Output</CardTitle>
                </div>
                <CardDescription className="text-xs">
                  Prefers fresh API output; falls back to latest saved result.
                </CardDescription>
              </CardHeader>
              <CardContent className="p-3">
                <DismantlerOutput
                  parsed={parsedDismantler}
                  dismantlerText={dismantlerText}
                  claimFactsPack={liveCarrierDismantler?.claimFactsPack}
                />
              </CardContent>
            </div>
            )}
            </Card>
          </div>
        )}
      </div>

      {/* Mobile Copilot Sheet */}
      <Sheet open={mobileSheetOpen} onOpenChange={setMobileSheetOpen}>
        <SheetContent side="bottom" className="h-[85vh] p-0 flex flex-col">
          <SheetHeader className="sr-only">
            <SheetTitle>Darwin Copilot</SheetTitle>
          </SheetHeader>
          <div className="flex border-b">
            <button
              className={cn(
                "flex-1 px-3 py-2 text-xs font-medium transition-colors",
                copilotView === 'conversation'
                  ? "bg-primary/10 text-primary border-b-2 border-primary"
                  : "text-muted-foreground hover:bg-accent/50"
              )}
              onClick={() => setCopilotView('conversation')}
            >
              <MessageSquare className="h-3 w-3 inline mr-1" />
              Copilot
            </button>
            <button
              className={cn(
                "flex-1 px-3 py-2 text-xs font-medium transition-colors",
                copilotView === 'dismantler'
                  ? "bg-primary/10 text-primary border-b-2 border-primary"
                  : "text-muted-foreground hover:bg-accent/50"
              )}
              onClick={() => setCopilotView('dismantler')}
            >
              <Shield className="h-3 w-3 inline mr-1" />
              Dismantler
            </button>
          </div>
          {copilotView === 'conversation' ? (
            <DarwinCopilotPanel claimId={claimId} isExpanded={false} />
          ) : (
            <div className="flex-1 overflow-y-auto p-3">
              <DismantlerOutput
                parsed={parsedDismantler}
                dismantlerText={dismantlerText}
                claimFactsPack={liveCarrierDismantler?.claimFactsPack}
                compact
              />
            </div>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
};

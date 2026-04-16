import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { useQuery } from "@tanstack/react-query";
import { 
  Sparkles, Loader2, Copy, Download, FileText, 
  Brain, Target, Shield, AlertTriangle, CheckCircle2, RefreshCw
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useDeclaredPosition } from "@/hooks/useDeclaredPosition";
import { PositionGateBanner } from "./PositionGateBanner";
import { publishCarrierDismantler } from "@/lib/darwinDismantlerBus";
import { DarwinRefinementChat } from "./DarwinRefinementChat";
import { DarwinModeToggle } from "@/components/darwin/DarwinModeToggle";
import type { DarwinMode } from "@/components/darwin/types";
import { DarwinCitationWatchdog } from "./DarwinCitationWatchdog";
import { getFunctionErrorDetails } from "@/lib/edgeFunctionError";

interface DarwinAutoDraftRebuttalProps {
  claimId: string;
  claim: any;
}

export const DarwinAutoDraftRebuttal = ({ claimId, claim }: DarwinAutoDraftRebuttalProps) => {
  const { toast } = useToast();
  const [isGenerating, setIsGenerating] = useState(false);
  const [rebuttal, setRebuttal] = useState<string | null>(null);
  const [editableRebuttal, setEditableRebuttal] = useState<string>("");
  const [provisionalOverride, setProvisionalOverride] = useState(false);
  const [citationWatchdog, setCitationWatchdog] = useState<any>(null);
  const [jurisdiction, setJurisdiction] = useState<any>(null);
  const [mode, setMode] = useState<DarwinMode>("rebuttal");
  const [generationError, setGenerationError] = useState<string | null>(null);
  const { position, isLocked, loading: positionLoading } = useDeclaredPosition(claimId);

  // Fetch all strategic intelligence data
  const { data: strategicInsights } = useQuery({
    queryKey: ["strategic-insights", claimId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("claim_strategic_insights")
        .select("*")
        .eq("claim_id", claimId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      
      if (error) throw error;
      return data;
    },
  });

  // Fetch Darwin analysis results
  const { data: darwinAnalyses } = useQuery({
    queryKey: ["darwin-analyses-all", claimId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("darwin_analysis_results")
        .select("*")
        .eq("claim_id", claimId)
        .order("created_at", { ascending: false });
      
      if (error) throw error;
      return data;
    },
  });

  // Fetch carrier behavior profile
  const { data: carrierProfile } = useQuery({
    queryKey: ["carrier-profile", claim?.insurance_company],
    queryFn: async () => {
      if (!claim?.insurance_company) return null;
      const { data } = await supabase
        .from("carrier_behavior_profiles")
        .select("*")
        .ilike("carrier_name", `%${claim.insurance_company}%`)
        .limit(1)
        .maybeSingle();
      return data;
    },
    enabled: !!claim?.insurance_company,
  });

  // Fetch claim files for context - include all files, not just PDFs
  const { data: claimFiles } = useQuery({
    queryKey: ["claim-files-list", claimId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("claim_files")
        .select("file_name, file_type, uploaded_at, document_classification, claim_folders(name)")
        .eq("claim_id", claimId);
      
      if (error) throw error;
      return data;
    },
  });

  // Fetch AI-analyzed photos for evidence
  const { data: aiPhotos } = useQuery({
    queryKey: ["ai-photos-for-rebuttal", claimId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("claim_photos")
        .select("file_name, ai_condition_rating, ai_condition_notes, ai_detected_damages, ai_material_type, ai_analysis_summary, category")
        .eq("claim_id", claimId)
        .not("ai_analyzed_at", "is", null);
      
      if (error) throw error;
      return data;
    },
  });

  // Fetch proximity precedents for evidence of inconsistent carrier handling
  const { data: proximityPrecedents } = useQuery({
    queryKey: ["proximity-precedents-rebuttal", claimId, claim?.latitude, claim?.longitude],
    queryFn: async () => {
      if (!claim?.latitude || !claim?.longitude) return null;

      const { data, error } = await supabase.rpc("search_claims_by_proximity", {
        target_lat: claim.latitude,
        target_lng: claim.longitude,
        radius_miles: 5,
        exclude_claim_id: claimId,
        target_insurance_company: claim.insurance_company || undefined,
      });

      if (error) throw error;
      // Filter to settled/closed claims
      return data?.filter((p: any) => 
        p.is_closed || p.status === "Settled" || p.status === "Closed" || p.status === "Claim Settled" || p.claim_amount > 0
      ) || [];
    },
  });

  // Process AI photo data for display
  const poorConditionPhotos = aiPhotos?.filter(p => 
    p.ai_condition_rating === 'Poor' || p.ai_condition_rating === 'Failed'
  ) || [];
  const photosWithDamages = aiPhotos?.filter(p => {
    if (!p.ai_detected_damages) return false;
    try {
      const damages = typeof p.ai_detected_damages === 'string' 
        ? JSON.parse(p.ai_detected_damages) 
        : p.ai_detected_damages;
      return Array.isArray(damages) && damages.length > 0;
    } catch { return false; }
  }) || [];

  // Categorize files for display
  const stormReports = claimFiles?.filter(f => {
    const name = f.file_name?.toLowerCase() || '';
    return f.document_classification === 'storm_report' ||
           f.document_classification === 'weather_report' ||
           name.includes('storm') || name.includes('weather') ||
           name.includes('hail') || name.includes('wind') ||
           name.includes('nws') || name.includes('noaa');
  }) || [];
  
  const beforePhotos = claimFiles?.filter(f => {
    const name = f.file_name?.toLowerCase() || '';
    return name.includes('before') || name.includes('pre-storm') ||
           name.includes('prestorm') || name.includes('prior') ||
           name.includes('overview') || name.includes('original condition');
  }) || [];

  const dataPoints = [
    { 
      label: "Strategic Insights", 
      available: !!strategicInsights,
      icon: Target 
    },
    { 
      label: "Darwin Analyses", 
      available: (darwinAnalyses?.length || 0) > 0,
      count: darwinAnalyses?.length,
      icon: Brain 
    },
    { 
      label: "Carrier Profile", 
      available: !!carrierProfile,
      icon: Shield 
    },
    { 
      label: "Storm/Weather Reports", 
      available: stormReports.length > 0,
      count: stormReports.length,
      icon: FileText 
    },
    { 
      label: "Before/Pre-Storm Photos", 
      available: beforePhotos.length > 0,
      count: beforePhotos.length,
      icon: FileText 
    },
    { 
      label: "Claim Files", 
      available: (claimFiles?.length || 0) > 0,
      count: claimFiles?.length,
      icon: FileText 
    },
    { 
      label: "AI Photo Analysis", 
      available: (aiPhotos?.length || 0) > 0,
      count: aiPhotos?.length,
      icon: FileText,
      description: poorConditionPhotos.length > 0 
        ? `${poorConditionPhotos.length} poor/failed, ${photosWithDamages.length} with damages`
        : undefined
    },
    { 
      label: "Proximity Precedents", 
      available: (proximityPrecedents?.length || 0) > 0,
      count: proximityPrecedents?.length,
      icon: Target,
      description: proximityPrecedents?.length ? `${proximityPrecedents.length} settled claim(s) within 5 miles` : undefined
    },
  ];

  const handleGenerate = async () => {
    setIsGenerating(true);
    setRebuttal(null);
    setEditableRebuttal("");
    setCitationWatchdog(null);
    setJurisdiction(null);
    setGenerationError(null);
    try {
      const { data, error } = await supabase.functions.invoke("darwin-ai-analysis", {
        body: {
          claimId,
          analysisType: "auto_draft_rebuttal",
          mode,
          additionalContext: {
            strategicInsights,
            darwinAnalyses: darwinAnalyses?.map(a => ({
              type: a.analysis_type,
              result: a.result,
              created_at: a.created_at,
            })),
            carrierProfile,
            claimFiles: claimFiles?.map(f => f.file_name),
            aiPhotoAnalysis: aiPhotos?.map(p => ({
              fileName: p.file_name,
              category: p.category,
              material: p.ai_material_type,
              condition: p.ai_condition_rating,
              conditionNotes: p.ai_condition_notes,
              summary: p.ai_analysis_summary,
              detectedDamages: p.ai_detected_damages,
            })),
            photoAnalysisSummary: {
              totalAnalyzed: aiPhotos?.length || 0,
              poorConditionCount: poorConditionPhotos.length,
              withDamagesCount: photosWithDamages.length,
              materials: [...new Set(aiPhotos?.map(p => p.ai_material_type).filter(Boolean) || [])],
            },
            proximityPrecedents: proximityPrecedents?.map(p => ({
              claimNumber: p.claim_number,
              policyholderName: p.policyholder_name,
              address: p.policyholder_address,
              distanceMiles: p.distance_miles?.toFixed(2),
              lossType: p.loss_type,
              lossDate: p.loss_date,
              status: p.status,
              claimAmount: p.claim_amount,
            })),
            ...(isLocked && position ? {
              declaredPosition: {
                primary_cause_of_loss: position.primary_cause_of_loss,
                primary_coverage_theory: position.primary_coverage_theory,
                primary_carrier_error: position.primary_carrier_error,
                carrier_dependency_statement: position.carrier_dependency_statement,
              }
            } : {}),
            ...(provisionalOverride ? { provisionalPosition: true } : {}),
          },
          claim,
        },
      });

      if (error) {
        const details = await getFunctionErrorDetails(error, "Failed to generate rebuttal");
        console.error("Auto draft rebuttal blocked", {
          status: details.status,
          scenarioDiagnostics: details.scenarioDiagnostics,
          violations: details.violations,
          payload: details.payload,
        });

        const violationText = details.violations?.length
          ? ` Violations: ${details.violations.join(", ")}.`
          : "";
        throw new Error(`${details.message}${violationText}`.trim());
      }

      if (data?.error) {
        const payloadViolations = Array.isArray((data as any).violations)
          ? (data as any).violations.filter((item: unknown) => typeof item === "string")
          : [];
        const violationText = payloadViolations.length
          ? ` Violations: ${payloadViolations.join(", ")}.`
          : "";
        throw new Error(`${data.error}${violationText}`.trim());
      }

      if (!data?.result || typeof data.result !== "string") {
        throw new Error("No rebuttal returned. The response was blocked before delivery.");
      }

      setRebuttal(data.result);
      setEditableRebuttal(data.result);

      // Store watchdog results for display
      if (data?.citation_watchdog) {
        setCitationWatchdog(data.citation_watchdog);
      }
      if (data?.jurisdiction) {
        setJurisdiction(data.jurisdiction);
      }

      if (data?.carrierDismantler) {
        publishCarrierDismantler({
          claimId,
          analysisType: "auto_draft_rebuttal",
          carrierDismantler: data.carrierDismantler,
          claimFactsPack: data.claimFactsPack ?? null,
        });
      }

      // Persisting is handled server-side only after final low-slope validation passes.

      toast({
        title: "Rebuttal drafted",
        description: data?.citation_watchdog
          ? `⚠️ Rebuttal ready but ${data.citation_watchdog.wrong_state_citations_found} wrong-state citation(s) detected — review before sending`
          : "Darwin has compiled a comprehensive rebuttal using all available intelligence",
        variant: data?.citation_watchdog ? "destructive" : "default",
      });
    } catch (error: any) {
      console.error("Error generating rebuttal:", error);
      setGenerationError(error.message || "Failed to generate rebuttal");
      toast({
        title: "Generation failed",
        description: error.message || "Failed to generate rebuttal",
        variant: "destructive",
      });
    } finally {
      setIsGenerating(false);
    }
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(editableRebuttal);
    toast({ title: "Copied", description: "Rebuttal copied to clipboard" });
  };

  const handleDownload = () => {
    const blob = new Blob([editableRebuttal], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `Strategic_Rebuttal_${claim.claim_number || claimId}_${new Date().toISOString().split("T")[0]}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const availableDataCount = dataPoints.filter(d => d.available).length;

  return (
    <Card className="border-primary/20">
      <CardHeader className="bg-primary/5 border-b">
        <CardTitle className="flex items-center gap-2 text-foreground">
          <Sparkles className="h-5 w-5 text-primary" />
          Darwin Auto-Draft Rebuttal
        </CardTitle>
        <CardDescription className="text-muted-foreground">
          Let Darwin compile a comprehensive rebuttal using all strategic intelligence, 
          analyses, carrier behavior data, and claim documentation
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 pt-4">
        <PositionGateBanner
          lockStatus={position?.lock_status || "draft"}
          loading={positionLoading}
          onProceedProvisional={() => setProvisionalOverride(true)}
        />
        <DarwinModeToggle value={mode} onChange={setMode} />
        {/* Data Sources Summary */}
        <div className="space-y-2">
          <h4 className="text-sm font-medium text-foreground flex items-center gap-2">
            <Brain className="h-4 w-4 text-primary" />
            Intelligence Sources ({availableDataCount}/{dataPoints.length})
          </h4>
          <div className="flex flex-wrap gap-2">
            {dataPoints.map((point) => {
              const Icon = point.icon;
              return (
                <Badge
                  key={point.label}
                  variant={point.available ? "default" : "secondary"}
                  className={`flex items-center gap-1.5 ${
                    point.available 
                      ? "bg-primary/10 text-primary border-primary/30 hover:bg-primary/20" 
                      : "bg-muted text-muted-foreground"
                  }`}
                >
                  {point.available ? (
                    <CheckCircle2 className="h-3 w-3" />
                  ) : (
                    <AlertTriangle className="h-3 w-3" />
                  )}
                  <Icon className="h-3 w-3" />
                  {point.label}
                  {point.count && <span className="ml-1">({point.count})</span>}
                </Badge>
              );
            })}
          </div>
        </div>

        {/* Warning if missing data */}
        {availableDataCount < 2 && (
          <div className="p-3 bg-warning/10 border border-warning/30 rounded-lg text-sm text-foreground">
            <div className="flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 text-warning mt-0.5" />
              <div>
                <p className="font-medium">Limited data available</p>
                <p className="text-muted-foreground text-xs mt-1">
                  Run Strategic Analysis in the War Room and generate analyses from Darwin tools for best results.
                </p>
              </div>
            </div>
          </div>
        )}

        {/* What Darwin will include */}
        <div className="p-3 bg-card border rounded-lg">
          <h5 className="text-sm font-medium text-foreground mb-2">Darwin will compile:</h5>
          <ul className="text-xs text-muted-foreground space-y-1">
            <li className="flex items-center gap-2">
              <CheckCircle2 className="h-3 w-3 text-primary" />
              Strategic position analysis & health scores
            </li>
            <li className="flex items-center gap-2">
              <CheckCircle2 className="h-3 w-3 text-primary" />
              All previous rebuttals & denial analyses
            </li>
            <li className="flex items-center gap-2">
              <CheckCircle2 className="h-3 w-3 text-primary" />
              Carrier-specific tactics & counter-strategies
            </li>
            <li className="flex items-center gap-2">
              <CheckCircle2 className="h-3 w-3 text-primary" />
              Evidence citations from uploaded documents
            </li>
            <li className="flex items-center gap-2">
              <CheckCircle2 className="h-3 w-3 text-primary" />
              AI photo analysis (conditions, damages, materials)
            </li>
            <li className="flex items-center gap-2">
              <CheckCircle2 className="h-3 w-3 text-primary" />
              Building codes & regulatory references (no case law)
            </li>
            <li className="flex items-center gap-2">
              <CheckCircle2 className="h-3 w-3 text-primary" />
              Proximity precedents (nearby settled claims as inconsistency evidence)
            </li>
          </ul>
        </div>

        <Button
          onClick={handleGenerate}
          disabled={isGenerating}
          className="w-full"
          size="lg"
        >
          {isGenerating ? (
            <>
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              Darwin is compiling comprehensive rebuttal...
            </>
          ) : (
            <>
              <Sparkles className="h-4 w-4 mr-2" />
              Generate Strategic Rebuttal
            </>
          )}
        </Button>

        {/* Error with retry */}
        {generationError && !isGenerating && !rebuttal && (
          <div className="p-4 bg-destructive/10 border border-destructive/30 rounded-lg space-y-2">
            <div className="flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 text-destructive mt-0.5" />
              <div className="flex-1">
                <p className="text-sm font-medium text-destructive">Generation Failed</p>
                <p className="text-xs text-muted-foreground mt-1">{generationError}</p>
              </div>
            </div>
            <Button variant="outline" size="sm" onClick={handleGenerate} className="gap-1.5">
              <RefreshCw className="h-3.5 w-3.5" />
              Retry
            </Button>
          </div>
        )}

        {rebuttal && (
          <div className="space-y-3 pt-4 border-t">
            <DarwinCitationWatchdog watchdog={citationWatchdog} jurisdiction={jurisdiction} />
            <div className="flex items-center justify-between">
              <h4 className="font-medium text-foreground">Generated Rebuttal</h4>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={handleCopy}>
                  <Copy className="h-4 w-4 mr-1" />
                  Copy
                </Button>
                <Button variant="outline" size="sm" onClick={handleDownload}>
                  <Download className="h-4 w-4 mr-1" />
                  Download
                </Button>
              </div>
            </div>
            <Textarea
              value={editableRebuttal}
              onChange={(e) => setEditableRebuttal(e.target.value)}
              className="min-h-[400px] font-mono text-sm bg-card text-card-foreground"
            />
            <DarwinRefinementChat
              currentDocument={editableRebuttal}
              onDocumentUpdated={(revised) => {
                setEditableRebuttal(revised);
                setRebuttal(revised);
              }}
              claimId={claimId}
              documentLabel="rebuttal"
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
};

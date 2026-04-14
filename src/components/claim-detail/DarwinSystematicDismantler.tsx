import { useState, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { 
  Gavel, Loader2, Copy, Download, Sparkles, Upload, X, FileText, History, 
  FolderOpen, AlertTriangle, Scale, Target, Shield, CheckCircle2, XCircle,
  ChevronDown, ChevronUp, Files
} from "lucide-react";
import { useClaimFiles } from "@/hooks/useClaimFiles";
import { MultiClaimFileSelector } from "./MultiClaimFileSelector";
import { Textarea } from "@/components/ui/textarea";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useDeclaredPosition } from "@/hooks/useDeclaredPosition";
import { PositionGateBanner } from "./PositionGateBanner";

interface DarwinSystematicDismantlerProps {
  claimId: string;
  claim: any;
}

interface AssertionAnalysis {
  id: string;
  carrierAssertion: string;
  burdenHolder: 'carrier' | 'policyholder';
  burdenMet: boolean;
  burdenAnalysis: string;
  syllogism: {
    premise1Policy: string;
    premise2Facts: string;
    conclusion: string;
    premisesAccurate: boolean;
    evidenceSupport: boolean;
    logicallyValid: boolean;
    failures: string[];
  };
  proceduralDefects: string[];
  requiredEvidence: string[];
  counterArguments: string[];
  authorityViolations: string[];
  score: {
    policyAlignment: number;
    evidenceQuality: number;
    proceduralCompliance: number;
    logicalConsistency: number;
    overall: number;
  };
}

interface DismantlingResult {
  statementOfDispute: string;
  assertions: AssertionAnalysis[];
  movingGoalposts: string[];
  postHocRationalizations: string[];
  overallProceduralDefects: string[];
  requiredCarrierActions: string[];
  escalationRecommendations: string[];
  overallScore: number;
  rawAnalysis: string;
}

export const DarwinSystematicDismantler = ({ claimId, claim }: DarwinSystematicDismantlerProps) => {
  const [carrierContent, setCarrierContent] = useState("");
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [selectedClaimFileIds, setSelectedClaimFileIds] = useState<Set<string>>(new Set());
  const [previousResponses, setPreviousResponses] = useState("");
  const [result, setResult] = useState<DismantlingResult | null>(null);
  const [rawAnalysis, setRawAnalysis] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [lastAnalyzed, setLastAnalyzed] = useState<Date | null>(null);
  const [inputMethod, setInputMethod] = useState<string>("claim-files");
  const [expandedAssertions, setExpandedAssertions] = useState<Set<string>>(new Set());
  const [provisionalOverride, setProvisionalOverride] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();
  
  const { files: claimFiles, loading: loadingFiles } = useClaimFiles(claimId);
  const { position, isLocked, loading: positionLoading } = useDeclaredPosition(claimId);

  const toggleFileSelection = (fileId: string) => {
    const newSet = new Set(selectedClaimFileIds);
    if (newSet.has(fileId)) {
      newSet.delete(fileId);
    } else {
      newSet.add(fileId);
    }
    setSelectedClaimFileIds(newSet);
    setPdfFile(null);
    setCarrierContent("");
  };

  const selectAllFiles = () => {
    setSelectedClaimFileIds(new Set(claimFiles.map(f => f.id)));
    setPdfFile(null);
    setCarrierContent("");
  };

  const clearAllFiles = () => {
    setSelectedClaimFileIds(new Set());
  };

  const selectedFiles = claimFiles.filter(f => selectedClaimFileIds.has(f.id));

  // Load previous analysis on mount
  useEffect(() => {
    const loadPreviousAnalysis = async () => {
      const { data } = await supabase
        .from('darwin_analysis_results')
        .select('*')
        .eq('claim_id', claimId)
        .eq('analysis_type', 'systematic_dismantling')
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      if (data) {
        setRawAnalysis(data.result);
        setLastAnalyzed(new Date(data.created_at));
        // Try to parse structured result if available
        try {
          if (data.input_summary && data.input_summary.startsWith('{')) {
            setResult(JSON.parse(data.input_summary));
          }
        } catch {}
      }
    };

    loadPreviousAnalysis();
  }, [claimId]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      if (file.type !== 'application/pdf') {
        toast({
          title: "Invalid file type",
          description: "Please upload a PDF file",
          variant: "destructive"
        });
        return;
      }
      if (file.size > 10 * 1024 * 1024) {
        toast({
          title: "File too large",
          description: "Please upload a file smaller than 10MB",
          variant: "destructive"
        });
        return;
      }
      setPdfFile(file);
      setSelectedClaimFileIds(new Set());
    }
  };

  const removeFile = () => {
    setPdfFile(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const uploadPdfToClaimStorage = async (file: File): Promise<string> => {
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      throw new Error("You must be signed in to upload documents.");
    }

    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    const storagePath = `${claimId}/analysis-temp/${Date.now()}-${safeName}`;
    const { error: uploadError } = await supabase.storage
      .from("claim-files")
      .upload(storagePath, file, {
        contentType: file.type || "application/pdf",
        upsert: false,
      });

    if (uploadError) throw uploadError;
    return storagePath;
  };

  const toggleAssertion = (id: string) => {
    const newExpanded = new Set(expandedAssertions);
    if (newExpanded.has(id)) {
      newExpanded.delete(id);
    } else {
      newExpanded.add(id);
    }
    setExpandedAssertions(newExpanded);
  };

  const handleAnalyze = async () => {
    if (!carrierContent.trim() && !pdfFile && selectedFiles.length === 0) {
      toast({
        title: "Content required",
        description: "Please select files, upload a PDF, or paste content",
        variant: "destructive"
      });
      return;
    }

    setLoading(true);
    try {
      let pdfFilePaths: Array<{ path: string; name: string; folder?: string }> = [];
      let singlePdfPath: string | null = null;
      let singlePdfBase64: string | null = null;
      let fileName: string | undefined;

      // Handle multiple claim files
      if (selectedFiles.length > 0) {
        pdfFilePaths = selectedFiles.slice(0, 5).map((file) => ({
          path: file.file_path,
          name: file.file_name,
          folder: file.folder_name,
        }));
      } else if (pdfFile) {
        // Handle single uploaded PDF
        fileName = pdfFile.name;
        try {
          singlePdfPath = await uploadPdfToClaimStorage(pdfFile);
        } catch (uploadErr) {
          // Fallback for very small PDFs if storage upload fails.
          if (pdfFile.size <= 3 * 1024 * 1024) {
            const arrayBuffer = await pdfFile.arrayBuffer();
            const bytes = new Uint8Array(arrayBuffer);
            let binary = '';
            for (let i = 0; i < bytes.length; i++) {
              binary += String.fromCharCode(bytes[i]);
            }
            singlePdfBase64 = btoa(binary);
          } else {
            throw uploadErr;
          }
        }
      }

      const { data, error } = await supabase.functions.invoke('darwin-ai-analysis', {
        body: {
          claimId,
          analysisType: 'systematic_dismantling',
          content: carrierContent || undefined,
          pdfContent: singlePdfBase64 || undefined,
          pdfFilePath: singlePdfPath || undefined,
          pdfFileName: fileName,
          pdfFilePaths: pdfFilePaths.length > 0 ? pdfFilePaths : undefined,
          additionalContext: {
            previousResponses,
            ...(isLocked && position ? {
              declaredPosition: {
                primary_cause_of_loss: position.primary_cause_of_loss,
                primary_coverage_theory: position.primary_coverage_theory,
                primary_carrier_error: position.primary_carrier_error,
                carrier_dependency_statement: position.carrier_dependency_statement,
              }
            } : {}),
            ...(provisionalOverride ? { provisionalPosition: true } : {}),
          }
        }
      });

      if (error) throw error;

      if (data?.error) {
        throw new Error(data.error);
      }

      setRawAnalysis(data.result);
      setLastAnalyzed(new Date());

      // Try to parse structured result
      if (data.structured) {
        setResult(data.structured);
      }

      // Save the analysis result
      const { data: userData } = await supabase.auth.getUser();
      const filesSummary = selectedFiles.length > 0 
        ? selectedFiles.map(f => f.file_name).join(', ')
        : (fileName || carrierContent.substring(0, 200));
      await supabase.from('darwin_analysis_results').insert({
        claim_id: claimId,
        analysis_type: 'systematic_dismantling',
        input_summary: data.structured ? JSON.stringify(data.structured) : filesSummary,
        result: data.result,
        pdf_file_name: selectedFiles.length > 0 ? `${selectedFiles.length} files` : (fileName || null),
        created_by: userData.user?.id
      });

      toast({
        title: "Systematic dismantling complete",
        description: "Carrier position has been analyzed and dismantled"
      });
    } catch (error: any) {
      console.error("Systematic dismantling error:", error);
      const rawMessage = String(error?.message || "");
      const isEdgeTransportError =
        /Failed to send a request to the Edge Function|FunctionsFetchError|Failed to fetch|Load failed/i.test(rawMessage);
      toast({
        title: "Analysis failed",
        description: isEdgeTransportError
          ? "Darwin could not reach the analysis function. Please retry. If this persists, redeploy darwin-ai-analysis and confirm OPENAI_API_KEY is set."
          : (error.message || "Failed to analyze carrier response"),
        variant: "destructive"
      });
    } finally {
      setLoading(false);
    }
  };

  const copyToClipboard = () => {
    if (rawAnalysis) {
      navigator.clipboard.writeText(rawAnalysis);
      toast({ title: "Copied", description: "Analysis copied to clipboard" });
    }
  };

  const downloadAsText = () => {
    if (rawAnalysis) {
      const blob = new Blob([rawAnalysis], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `systematic-dismantling-${claim.claim_number || claimId}.txt`;
      a.click();
      URL.revokeObjectURL(url);
    }
  };

  const hasInput = carrierContent.trim() || pdfFile || selectedFiles.length > 0;

  const getScoreColor = (score: number) => {
    if (score >= 70) return "text-red-600 bg-red-100";
    if (score >= 40) return "text-yellow-600 bg-yellow-100";
    return "text-green-600 bg-green-100";
  };

  const getScoreLabel = (score: number) => {
    if (score >= 70) return "Easily Dismantled";
    if (score >= 40) return "Vulnerable";
    return "Requires Careful Approach";
  };

  return (
    <Card className="border-2 border-destructive/20">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Gavel className="h-5 w-5 text-destructive" />
          Systematic Carrier Dismantler
        </CardTitle>
        <CardDescription>
          Systematically dismantle carrier denials using burden-of-proof enforcement, policy supremacy, 
          procedural compliance analysis, and formal logic validation. Every assertion is treated as 
          unsupported until proven otherwise.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <PositionGateBanner
          lockStatus={position?.lock_status || "draft"}
          loading={positionLoading}
          onProceedProvisional={() => setProvisionalOverride(true)}
        />
        {lastAnalyzed && (
          <div className="p-3 bg-muted/50 rounded-md text-sm text-muted-foreground flex items-center gap-2">
            <History className="h-4 w-4" />
            Previous analysis from {lastAnalyzed.toLocaleString()}
          </div>
        )}

        <div className="p-3 bg-destructive/10 rounded-md border border-destructive/20">
          <div className="flex items-start gap-2">
            <Shield className="h-5 w-5 text-destructive mt-0.5" />
            <div className="text-sm">
              <p className="font-medium text-destructive">Non-Negotiable System Behaviors</p>
              <ul className="mt-1 text-muted-foreground space-y-1">
                <li>• Carrier determinations are unsupported until proven otherwise</li>
                <li>• Every assertion is decomposed and tested independently</li>
                <li>• Burden of proof strictly enforced on each claim</li>
                <li>• Output is escalation-ready (DOI, appraisal, litigation)</li>
              </ul>
            </div>
          </div>
        </div>

        <Tabs value={inputMethod} onValueChange={setInputMethod}>
          <TabsList className="flex flex-col sm:flex-row w-full h-auto gap-1 p-1">
            <TabsTrigger value="claim-files" className="w-full justify-start gap-2 px-3 py-2">
              <FolderOpen className="h-4 w-4 flex-shrink-0" />
              <span>Claim Files</span>
            </TabsTrigger>
            <TabsTrigger value="upload" className="w-full justify-start gap-2 px-3 py-2">
              <Upload className="h-4 w-4 flex-shrink-0" />
              <span>Upload PDF</span>
            </TabsTrigger>
            <TabsTrigger value="paste" className="w-full justify-start gap-2 px-3 py-2">
              <FileText className="h-4 w-4 flex-shrink-0" />
              <span>Paste Content</span>
            </TabsTrigger>
          </TabsList>

          <TabsContent value="claim-files" className="space-y-2 mt-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">Select Carrier Documents (Multiple)</label>
              <p className="text-xs text-muted-foreground">
                Select multiple documents for cross-referencing: denial letters, engineer reports, adjuster notes, carrier estimates. Darwin will detect contradictions, moving goalposts, and inconsistencies.
              </p>
            </div>
            <MultiClaimFileSelector
              files={claimFiles}
              loading={loadingFiles}
              selectedFileIds={selectedClaimFileIds}
              onToggleFile={toggleFileSelection}
              onSelectAll={selectAllFiles}
              onClearAll={clearAllFiles}
              height="200px"
            />
            {selectedFiles.length > 0 && (
              <div className="p-3 bg-primary/10 rounded-md border border-primary/20">
                <div className="flex items-center gap-2 mb-2">
                  <Files className="h-4 w-4 text-primary" />
                  <span className="text-sm font-medium">{selectedFiles.length} documents selected for cross-reference analysis</span>
                </div>
                <div className="flex flex-wrap gap-1">
                  {selectedFiles.map(file => (
                    <Badge key={file.id} variant="secondary" className="text-xs">
                      {file.file_name}
                    </Badge>
                  ))}
                </div>
              </div>
            )}
          </TabsContent>

          <TabsContent value="upload" className="space-y-2 mt-4">
            <label className="text-sm font-medium">Upload Carrier Response (PDF)</label>
            <input
              type="file"
              ref={fileInputRef}
              onChange={handleFileChange}
              accept=".pdf"
              className="hidden"
            />
            {pdfFile ? (
              <div className="flex items-center gap-2 p-3 border rounded-md bg-muted/50">
                <FileText className="h-5 w-5 text-primary" />
                <span className="flex-1 text-sm truncate">{pdfFile.name}</span>
                <Button variant="ghost" size="sm" onClick={removeFile}>
                  <X className="h-4 w-4" />
                </Button>
              </div>
            ) : (
              <Button
                variant="outline"
                className="w-full"
                onClick={() => fileInputRef.current?.click()}
              >
                <Upload className="h-4 w-4 mr-2" />
                Select PDF File
              </Button>
            )}
          </TabsContent>

          <TabsContent value="paste" className="space-y-2 mt-4">
            <label className="text-sm font-medium">Carrier Response Content</label>
            <Textarea
              value={carrierContent}
              onChange={(e) => {
                setCarrierContent(e.target.value);
                setSelectedClaimFileIds(new Set());
                setPdfFile(null);
              }}
              placeholder="Paste the carrier's denial letter or response here..."
              className="min-h-[150px]"
            />
          </TabsContent>
        </Tabs>

        <div className="space-y-2">
          <label className="text-sm font-medium">Previous Carrier Responses (for goalpost detection)</label>
          <Textarea
            value={previousResponses}
            onChange={(e) => setPreviousResponses(e.target.value)}
            placeholder="Paste any previous carrier responses to detect moving goalposts and post-hoc rationalizations..."
            className="min-h-[80px]"
          />
        </div>

        <Button 
          onClick={handleAnalyze} 
          disabled={loading || !hasInput}
          className="w-full bg-destructive hover:bg-destructive/90"
        >
          {loading ? (
            <>
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              Systematically Dismantling...
            </>
          ) : (
            <>
              <Gavel className="h-4 w-4 mr-2" />
              Dismantle Carrier Position
            </>
          )}
        </Button>

        {rawAnalysis && (
          <div className="space-y-4 pt-4 border-t">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <h4 className="font-medium">Systematic Analysis</h4>
                {result?.overallScore !== undefined && (
                  <Badge className={getScoreColor(100 - result.overallScore)}>
                    Carrier Position: {getScoreLabel(100 - result.overallScore)}
                  </Badge>
                )}
              </div>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={copyToClipboard}>
                  <Copy className="h-4 w-4 mr-1" />
                  Copy
                </Button>
                <Button variant="outline" size="sm" onClick={downloadAsText}>
                  <Download className="h-4 w-4 mr-1" />
                  Download
                </Button>
              </div>
            </div>

            <ScrollArea className="h-[600px] border rounded-md p-4 bg-muted/30">
              <pre className="whitespace-pre-wrap text-sm font-mono">{rawAnalysis}</pre>
            </ScrollArea>
          </div>
        )}
      </CardContent>
    </Card>
  );
};

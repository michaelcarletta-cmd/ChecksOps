import { useState, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { HardHat, Loader2, Copy, Download, Sparkles, Upload, X, FileText, History, FolderOpen, CheckCircle2, CircleDashed, AlertTriangle } from "lucide-react";
import { useDeclaredPosition } from "@/hooks/useDeclaredPosition";
import { PositionGateBanner } from "./PositionGateBanner";
import { publishCarrierDismantler } from "@/lib/darwinDismantlerBus";
import { getFunctionErrorDetails } from "@/lib/edgeFunctionError";

interface DarwinEngineerReportAnalyzerProps {
  claimId: string;
  claim: any;
}

interface ClaimFile {
  id: string;
  file_name: string;
  file_path: string;
  file_type: string | null;
  folder_id: string | null;
  folder_name?: string;
  uploaded_at: string | null;
  extracted_text?: string | null;
  clean_text?: string | null;
}

interface AnalysisExecutionStep {
  key: string;
  label: string;
  status: "started" | "completed" | "skipped" | "error";
  detail?: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
}

export const DarwinEngineerReportAnalyzer = ({ claimId, claim }: DarwinEngineerReportAnalyzerProps) => {
  const [reportContent, setReportContent] = useState("");
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [additionalContext, setAdditionalContext] = useState("");
  const [analysis, setAnalysis] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [lastAnalyzed, setLastAnalyzed] = useState<Date | null>(null);
  const [lastFileName, setLastFileName] = useState<string | null>(null);
  const [claimFiles, setClaimFiles] = useState<ClaimFile[]>([]);
  const [selectedClaimFile, setSelectedClaimFile] = useState<ClaimFile | null>(null);
  const [loadingFiles, setLoadingFiles] = useState(true);
  const [inputMethod, setInputMethod] = useState<'existing' | 'upload' | 'paste'>('existing');
  const [provisionalOverride, setProvisionalOverride] = useState(false);
  const [executionSteps, setExecutionSteps] = useState<AnalysisExecutionStep[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();
  const { position, isLocked, loading: positionLoading } = useDeclaredPosition(claimId);

  // Load claim files and previous analysis on mount
  useEffect(() => {
    const loadData = async () => {
      setLoadingFiles(true);
      try {
        // Load folders for folder names
        const { data: foldersData } = await supabase
          .from('claim_folders')
          .select('id, name')
          .eq('claim_id', claimId);
        
        const folderMap = new Map(foldersData?.map(f => [f.id, f.name]) || []);

        // Load PDF files from claim
        const { data: filesData } = await supabase
          .from('claim_files')
          .select('id, file_name, file_path, file_type, folder_id, uploaded_at, extracted_text, clean_text')
          .eq('claim_id', claimId)
          .order('uploaded_at', { ascending: false });

        const pdfFiles = (filesData || [])
          .filter(f => f.file_name?.toLowerCase().endsWith('.pdf'))
          .map(f => ({
            ...f,
            folder_name: f.folder_id ? folderMap.get(f.folder_id) : undefined
          }));
        
        setClaimFiles(pdfFiles);

        // Load previous analysis
        const { data } = await supabase
          .from('darwin_analysis_results')
          .select('*')
          .eq('claim_id', claimId)
          .eq('analysis_type', 'engineer_report_rebuttal')
          .order('created_at', { ascending: false })
          .limit(1)
          .single();

        if (data) {
          setAnalysis(data.result);
          setLastAnalyzed(new Date(data.created_at));
          setLastFileName(data.pdf_file_name || null);
        }
      } catch (error) {
        console.error('Error loading data:', error);
      } finally {
        setLoadingFiles(false);
      }
    };

    loadData();
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
      if (file.size > 50 * 1024 * 1024) {
        toast({
          title: "File too large",
          description: "Please upload a file smaller than 50MB",
          variant: "destructive"
        });
        return;
      }
      setPdfFile(file);
      setSelectedClaimFile(null);
    }
  };

  const removeFile = () => {
    setPdfFile(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const selectClaimFile = (file: ClaimFile) => {
    setSelectedClaimFile(file);
    setPdfFile(null);
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

  const handleAnalyze = async () => {
    if (!reportContent.trim() && !pdfFile && !selectedClaimFile) {
      toast({
        title: "Content required",
        description: "Please select a claim file, upload a PDF, or paste content",
        variant: "destructive"
      });
      return;
    }

    setLoading(true);
    setExecutionSteps([]);
    setAnalysis(null);
    try {
      let pdfBase64 = null;
      let pdfFilePath: string | null = null;
      let fileName = null;
      let selectedClaimFileText: string | null = null;

      if (selectedClaimFile) {
        pdfFilePath = selectedClaimFile.file_path;
        fileName = selectedClaimFile.file_name;
        selectedClaimFileText = (
          selectedClaimFile.clean_text?.trim()
          || selectedClaimFile.extracted_text?.trim()
          || null
        );
      } else if (pdfFile) {
        fileName = pdfFile.name;
        try {
          pdfFilePath = await uploadPdfToClaimStorage(pdfFile);
        } catch (uploadErr) {
          // Fallback for very small PDFs if storage upload fails.
          if (pdfFile.size <= 3 * 1024 * 1024) {
            const arrayBuffer = await pdfFile.arrayBuffer();
            const bytes = new Uint8Array(arrayBuffer);
            let binary = '';
            for (let i = 0; i < bytes.length; i++) {
              binary += String.fromCharCode(bytes[i]);
            }
            pdfBase64 = btoa(binary);
          } else {
            throw uploadErr;
          }
        }
      }

      const { data, error } = await supabase.functions.invoke('darwin-ai-analysis', {
        body: {
          claimId,
          analysisType: 'engineer_report_rebuttal',
          content: reportContent || undefined,
          pdfContent: pdfBase64 || undefined,
          pdfFilePath: pdfFilePath || undefined,
          pdfFileName: fileName || undefined,
          additionalContext: {
            ...(additionalContext ? { userContext: additionalContext } : {}),
            ...(selectedClaimFileText ? {
              engineerReportText: selectedClaimFileText,
              uploadedEngineerReportText: selectedClaimFileText,
            } : {}),
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

      if (error) {
        const details = await getFunctionErrorDetails(error, "Failed to analyze engineer report");
        console.error("Engineer report analysis blocked", {
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
          ? (data as any).violations.filter((item: unknown) => typeof item === 'string')
          : [];
        const violationText = payloadViolations.length
          ? ` Violations: ${payloadViolations.join(", ")}.`
          : "";
        throw new Error(`${data.error}${violationText}`.trim());
      }

      if (!data?.result || typeof data.result !== 'string') {
        throw new Error('No rebuttal returned. The response was blocked before delivery.');
      }

      setAnalysis(data.result);
      setExecutionSteps(Array.isArray(data?.executionSteps) ? data.executionSteps : []);
      if (data?.carrierDismantler) {
        publishCarrierDismantler({
          claimId,
          analysisType: "engineer_report_rebuttal",
          carrierDismantler: data.carrierDismantler,
          claimFactsPack: data.claimFactsPack ?? null,
        });
      }
      setLastAnalyzed(new Date());
      setLastFileName(fileName || null);

      // Persisting is handled server-side only after final low-slope validation passes.

      toast({
        title: "Analysis complete",
        description: "Darwin has generated your engineer report rebuttal"
      });
    } catch (error: any) {
      console.error("Engineer report analysis error:", error);
      const rawMessage = String(error?.message || "");
      const isEdgeTransportError =
        /Failed to send a request to the Edge Function|FunctionsFetchError|Failed to fetch|Load failed/i.test(rawMessage);
      toast({
        title: "Analysis failed",
        description: isEdgeTransportError
          ? "Darwin could not reach the analysis function. Please retry. If this persists, redeploy darwin-ai-analysis and confirm OPENAI_API_KEY is set."
          : (error.message || "Failed to analyze engineer report"),
        variant: "destructive"
      });
    } finally {
      setLoading(false);
    }
  };

  const copyToClipboard = () => {
    if (analysis) {
      navigator.clipboard.writeText(analysis);
      toast({ title: "Copied", description: "Rebuttal copied to clipboard" });
    }
  };

  const downloadAsText = () => {
    if (analysis) {
      const blob = new Blob([analysis], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `engineer-rebuttal-${claim.claim_number || claimId}.txt`;
      a.click();
      URL.revokeObjectURL(url);
    }
  };

  const hasInput = reportContent.trim() || pdfFile || selectedClaimFile;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <HardHat className="h-5 w-5 text-orange-500" />
          Engineer Report Analyzer
        </CardTitle>
        <CardDescription>
          Select an engineer report from claim files, upload a new PDF, or paste content for Darwin to analyze and generate a professional rebuttal
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
            {lastFileName && <span className="text-xs">({lastFileName})</span>}
          </div>
        )}

        {/* Input Method Tabs */}
        <Tabs value={inputMethod} onValueChange={(v) => setInputMethod(v as any)}>
          <TabsList className="flex flex-col sm:flex-row w-full h-auto gap-1 p-1">
            <TabsTrigger value="existing" className="w-full justify-start gap-2 px-3 py-2">
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

          <TabsContent value="existing" className="space-y-3">
            {loadingFiles ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : claimFiles.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                <FolderOpen className="h-10 w-10 mx-auto mb-2 opacity-50" />
                <p className="text-sm">No PDF files in this claim.</p>
                <p className="text-xs">Upload files to the claim or use another input method.</p>
              </div>
            ) : (
              <ScrollArea className="h-[200px] border rounded-md p-2">
                <div className="space-y-2">
                  {claimFiles.map(file => (
                    <div
                      key={file.id}
                      className={`flex items-center gap-3 p-3 border rounded-lg cursor-pointer hover:bg-muted/50 transition-colors ${
                        selectedClaimFile?.id === file.id ? 'border-primary bg-primary/5' : ''
                      }`}
                      onClick={() => selectClaimFile(file)}
                    >
                      <FileText className="h-5 w-5 text-primary flex-shrink-0" />
                      <div className="overflow-hidden flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{file.file_name}</p>
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          {file.folder_name && (
                            <span className="bg-muted px-1.5 py-0.5 rounded">{file.folder_name}</span>
                          )}
                          {file.uploaded_at && (
                            <span>{new Date(file.uploaded_at).toLocaleDateString()}</span>
                          )}
                        </div>
                      </div>
                      {selectedClaimFile?.id === file.id && (
                        <div className="h-2 w-2 rounded-full bg-primary" />
                      )}
                    </div>
                  ))}
                </div>
              </ScrollArea>
            )}
            {selectedClaimFile && (
              <div className="flex items-center gap-2 p-2 bg-primary/10 rounded-md text-sm">
                <FileText className="h-4 w-4 text-primary" />
                <span className="flex-1 truncate">Selected: {selectedClaimFile.file_name}</span>
                <Button variant="ghost" size="sm" onClick={() => setSelectedClaimFile(null)}>
                  <X className="h-4 w-4" />
                </Button>
              </div>
            )}
          </TabsContent>

          <TabsContent value="upload" className="space-y-3">
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
                className="w-full h-24 flex-col gap-2"
                onClick={() => fileInputRef.current?.click()}
              >
                <Upload className="h-6 w-6" />
                <span>Click to select PDF file</span>
              </Button>
            )}
          </TabsContent>

          <TabsContent value="paste" className="space-y-3">
            <Textarea
              value={reportContent}
              onChange={(e) => setReportContent(e.target.value)}
              placeholder="Paste the engineer's report content here..."
              className="min-h-[150px]"
            />
          </TabsContent>
        </Tabs>

        <div className="space-y-2">
          <label className="text-sm font-medium">Additional Context (Optional)</label>
          <Textarea
            value={additionalContext}
            onChange={(e) => setAdditionalContext(e.target.value)}
            placeholder="Add any additional observations, photo descriptions, or contradictory evidence that should be considered..."
            className="min-h-[80px]"
          />
        </div>

        <Button 
          onClick={handleAnalyze} 
          disabled={loading || !hasInput}
          className="w-full"
        >
          {loading ? (
            <>
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              Analyzing Report...
            </>
          ) : (
            <>
              <Sparkles className="h-4 w-4 mr-2" />
              Generate Rebuttal
            </>
          )}
        </Button>

        {executionSteps.length > 0 && (
          <div className="space-y-2 rounded-md border p-3 bg-muted/20">
            <div className="text-sm font-medium">Darwin processing steps</div>
            <div className="space-y-1.5">
              {executionSteps.map((step, idx) => {
                const icon = step.status === "completed"
                  ? <CheckCircle2 className="h-3.5 w-3.5 text-green-600" />
                  : step.status === "error"
                    ? <AlertTriangle className="h-3.5 w-3.5 text-destructive" />
                    : <CircleDashed className="h-3.5 w-3.5 text-muted-foreground" />;
                return (
                  <div key={`${step.key}-${idx}`} className="flex items-start gap-2 text-xs">
                    <div className="mt-0.5">{icon}</div>
                    <div className="min-w-0 flex-1">
                      <div className="font-medium">{step.label}</div>
                      {step.detail && <div className="text-muted-foreground">{step.detail}</div>}
                    </div>
                    {typeof step.durationMs === "number" && (
                      <div className="text-muted-foreground whitespace-nowrap">
                        {(step.durationMs / 1000).toFixed(step.durationMs >= 10000 ? 0 : 1)}s
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {analysis && (
          <div className="space-y-3 pt-4 border-t">
            <div className="flex items-center justify-between">
              <h4 className="font-medium">Engineer Report Rebuttal</h4>
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
            <ScrollArea className="h-[400px] border rounded-md p-4 bg-muted/30">
              <pre className="whitespace-pre-wrap text-sm font-mono">{analysis}</pre>
            </ScrollArea>
          </div>
        )}
      </CardContent>
    </Card>
  );
};

import { useState, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { FileWarning, Loader2, Sparkles, Upload, X, FileText, History, FolderOpen } from "lucide-react";
import { useClaimFiles } from "@/hooks/useClaimFiles";
import { ClaimFileSelector } from "./ClaimFileSelector";
import { useDeclaredPosition } from "@/hooks/useDeclaredPosition";
import { PositionGateBanner } from "./PositionGateBanner";
import { DarwinStructuredRenderer } from "@/components/darwin/DarwinStructuredRenderer";
import { DarwinModeToggle } from "@/components/darwin/DarwinModeToggle";
import type { DarwinMode, DarwinStructuredResult } from "@/components/darwin/types";

interface DarwinDenialAnalyzerProps {
  claimId: string;
  claim: any;
}

const parseStructuredResult = (value: unknown): DarwinStructuredResult | null => {
  const parsedValue =
    typeof value === "string"
      ? (() => {
          try {
            return JSON.parse(value);
          } catch {
            return null;
          }
        })()
      : value;

  if (!parsedValue || typeof parsedValue !== "object") return null;

  const candidate = parsedValue as Partial<DarwinStructuredResult>;
  if (typeof candidate.steelman_opponent !== "string") return null;
  if (!candidate.talking_points || typeof candidate.talking_points !== "object") return null;
  return parsedValue as DarwinStructuredResult;
};

export const DarwinDenialAnalyzer = ({ claimId }: DarwinDenialAnalyzerProps) => {
  const [denialContent, setDenialContent] = useState("");
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [selectedClaimFileId, setSelectedClaimFileId] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<DarwinStructuredResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [lastAnalyzed, setLastAnalyzed] = useState<Date | null>(null);
  const [lastFileName, setLastFileName] = useState<string | null>(null);
  const [inputMethod, setInputMethod] = useState<string>("claim-files");
  const [provisionalOverride, setProvisionalOverride] = useState(false);
  const [mode, setMode] = useState<DarwinMode>("rebuttal");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();
  
  const { files: claimFiles, loading: loadingFiles } = useClaimFiles(claimId);
  const { position, isLocked, loading: positionLoading } = useDeclaredPosition(claimId);

  // Load previous analysis on mount
  useEffect(() => {
    const loadPreviousAnalysis = async () => {
      const { data } = await supabase
        .from('darwin_analysis_results')
        .select('*')
        .eq('claim_id', claimId)
        .eq('analysis_type', 'denial_rebuttal')
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      if (data) {
        const previousResult = parseStructuredResult(data.result);
        if (previousResult) {
          setAnalysis(previousResult);
        }
        setLastAnalyzed(new Date(data.created_at));
        setLastFileName(data.pdf_file_name || null);
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
      setSelectedClaimFileId(null);
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

  const handleAnalyze = async () => {
    const selectedFile = claimFiles.find(f => f.id === selectedClaimFileId);
    
    if (!denialContent.trim() && !pdfFile && !selectedFile) {
      toast({
        title: "Content required",
        description: "Please select a file, upload a PDF, or paste content",
        variant: "destructive"
      });
      return;
    }

    setLoading(true);
    try {
      let pdfBase64: string | null = null;
      let pdfFilePath: string | null = null;
      let fileName: string | undefined;

      if (selectedFile) {
        pdfFilePath = selectedFile.file_path;
        fileName = selectedFile.file_name;
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
          analysisType: 'denial_rebuttal',
          content: denialContent || undefined,
          pdfContent: pdfBase64 || undefined,
          pdfFilePath: pdfFilePath || undefined,
          pdfFileName: fileName,
          additionalContext: {
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
          mode,
        }
      });

      if (error) throw error;

      if (data?.error) {
        throw new Error(data.error);
      }

      const structuredResult = parseStructuredResult(data?.result ?? data);
      if (!structuredResult) {
        throw new Error("Darwin returned an invalid structured response");
      }
      setAnalysis(structuredResult);

      setLastAnalyzed(new Date());
      setLastFileName(fileName || null);

      // Save the analysis result
      const { data: userData } = await supabase.auth.getUser();
      await supabase.from('darwin_analysis_results').insert({
        claim_id: claimId,
        analysis_type: 'denial_rebuttal',
        input_summary: fileName || denialContent.substring(0, 200),
        result: JSON.stringify(structuredResult, null, 2),
        pdf_file_name: fileName || null,
        created_by: userData.user?.id
      });

      toast({
        title: "Analysis complete",
        description: "Darwin has generated your rebuttal"
      });
    } catch (error: any) {
      console.error("Denial analysis error:", error);
      const rawMessage = String(error?.message || "");
      const isEdgeTransportError =
        /Failed to send a request to the Edge Function|FunctionsFetchError|Failed to fetch|Load failed/i.test(rawMessage);
      toast({
        title: "Analysis failed",
        description: isEdgeTransportError
          ? "Darwin could not reach the analysis function. Please retry. If this persists, redeploy darwin-ai-analysis and confirm OPENAI_API_KEY is set."
          : (error.message || "Failed to analyze denial letter"),
        variant: "destructive"
      });
    } finally {
      setLoading(false);
    }
  };

  const selectedFile = claimFiles.find(f => f.id === selectedClaimFileId);
  const hasInput = denialContent.trim() || pdfFile || selectedFile;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FileWarning className="h-5 w-5 text-destructive" />
          Denial Letter Analyzer
        </CardTitle>
        <CardDescription>
          Select a denial letter from claim files, upload a PDF, or paste content for Darwin to generate a point-by-point rebuttal
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <PositionGateBanner
          lockStatus={position?.lock_status || "draft"}
          loading={positionLoading}
          onProceedProvisional={() => setProvisionalOverride(true)}
        />
        <DarwinModeToggle value={mode} onChange={setMode} />
        {lastAnalyzed && (
          <div className="p-3 bg-muted/50 rounded-md text-sm text-muted-foreground flex items-center gap-2">
            <History className="h-4 w-4" />
            Previous analysis from {lastAnalyzed.toLocaleString()}
            {lastFileName && <span className="text-xs">({lastFileName})</span>}
          </div>
        )}

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
            <label className="text-sm font-medium">Select from Claim Files</label>
            <ClaimFileSelector
              files={claimFiles}
              loading={loadingFiles}
              selectedFileId={selectedClaimFileId}
              onSelectFile={(file) => {
                setSelectedClaimFileId(file.id);
                setPdfFile(null);
                setDenialContent("");
              }}
              height="200px"
            />
          </TabsContent>

          <TabsContent value="upload" className="space-y-2 mt-4">
            <label className="text-sm font-medium">Upload Denial Letter (PDF)</label>
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
            <label className="text-sm font-medium">Denial Letter Content</label>
            <Textarea
              value={denialContent}
              onChange={(e) => {
                setDenialContent(e.target.value);
                setSelectedClaimFileId(null);
                setPdfFile(null);
              }}
              placeholder="Paste the denial letter content here..."
              className="min-h-[150px]"
            />
          </TabsContent>
        </Tabs>

        <Button 
          onClick={handleAnalyze} 
          disabled={loading || !hasInput}
          className="w-full"
        >
          {loading ? (
            <>
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              Analyzing...
            </>
          ) : (
            <>
              <Sparkles className="h-4 w-4 mr-2" />
              Generate Rebuttal
            </>
          )}
        </Button>

        {analysis && (
          <div className="space-y-3 pt-4 border-t">
            <h4 className="font-medium">Structured Rebuttal Output</h4>
            <ScrollArea className="h-[520px] border rounded-md p-4 bg-muted/30">
              <DarwinStructuredRenderer result={analysis} />
            </ScrollArea>
          </div>
        )}
      </CardContent>
    </Card>
  );
};

import { useState, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { PlusCircle, Loader2, Sparkles, Upload, X, FileText, History, FolderOpen, Camera, Ruler, ChevronDown, AlertTriangle, CheckCircle2 } from "lucide-react";
import { useClaimFiles } from "@/hooks/useClaimFiles";
import { ClaimFileSelector } from "./ClaimFileSelector";
import { DarwinStructuredRenderer } from "@/components/darwin/DarwinStructuredRenderer";
import { DarwinModeToggle } from "@/components/darwin/DarwinModeToggle";
import type { DarwinMode, DarwinStructuredResult } from "@/components/darwin/types";
interface DarwinSupplementGeneratorProps {
  claimId: string;
  claim: any;
}

interface PhotoAnalysis {
  id: string;
  file_name: string;
  category: string | null;
  ai_analysis_summary: string | null;
  ai_material_type: string | null;
  ai_detected_damages: unknown;
  ai_condition_rating: string | null;
  ai_loss_type_consistency: string | null;
  is_analyzed: boolean;
}

interface MeasurementFile {
  id: string;
  file_name: string;
  file_path: string;
  folder_name: string | null;
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

export const DarwinSupplementGenerator = ({ claimId }: DarwinSupplementGeneratorProps) => {
  const [existingEstimate, setExistingEstimate] = useState("");
  const [additionalNotes, setAdditionalNotes] = useState("");
  const [analysis, setAnalysis] = useState<DarwinStructuredResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [ourEstimatePdf, setOurEstimatePdf] = useState<File | null>(null);
  const [insuranceEstimatePdf, setInsuranceEstimatePdf] = useState<File | null>(null);
  const [selectedOurEstimateId, setSelectedOurEstimateId] = useState<string | null>(null);
  const [selectedInsuranceEstimateId, setSelectedInsuranceEstimateId] = useState<string | null>(null);
  const [selectedMeasurementIds, setSelectedMeasurementIds] = useState<Set<string>>(new Set());
  const [lastAnalyzed, setLastAnalyzed] = useState<Date | null>(null);
  const [lastFileName, setLastFileName] = useState<string | null>(null);
  const [inputMethod, setInputMethod] = useState<string>("claim-files");
  const [photoAnalyses, setPhotoAnalyses] = useState<PhotoAnalysis[]>([]);
  const [measurementFiles, setMeasurementFiles] = useState<MeasurementFile[]>([]);
  const [loadingEvidence, setLoadingEvidence] = useState(true);
  const [evidenceExpanded, setEvidenceExpanded] = useState(true);
  const [mode, setMode] = useState<DarwinMode>("evidence");
  const ourEstimateInputRef = useRef<HTMLInputElement>(null);
  const insuranceEstimateInputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();
  
  // Manual measurement inputs - CRITICAL for accurate quantities
  const [manualMeasurements, setManualMeasurements] = useState({
    roofSquares: '',
    ridgeHipLF: '',
    valleyLF: '',
    eaveRakeLF: '',
    roofPitch: '',
    stories: '',
    pipeBoots: '',
    vents: '',
    skylights: ''
  });

  const { files: claimFiles, loading: loadingFiles, downloadFileAsBase64 } = useClaimFiles(claimId);

  // Load photo analyses and measurement files
  useEffect(() => {
    const loadEvidenceData = async () => {
      if (!claimId) {
        console.error('AI Estimate Builder: No claimId provided');
        return;
      }
      
      setLoadingEvidence(true);
      console.log('AI Estimate Builder: Loading evidence for claim', claimId);
      
      try {
        // Fetch ALL photos (analyzed and unanalyzed)
        const { data: photos, error: photosError } = await supabase
          .from('claim_photos')
          .select('id, file_name, category, ai_analysis_summary, ai_material_type, ai_detected_damages, ai_condition_rating, ai_loss_type_consistency')
          .eq('claim_id', claimId);
        
        if (photosError) {
          console.error('AI Estimate Builder: Error fetching photos:', photosError);
        } else {
          console.log('AI Estimate Builder: Fetched photos from database:', photos?.length);
        }
        
        // Mark each photo as analyzed or not
        const processedPhotos = (photos || []).map(p => ({
          ...p,
          is_analyzed: !!p.ai_analysis_summary
        }));
        
        console.log('AI Estimate Builder: Setting photoAnalyses state with', processedPhotos.length, 'photos');
        setPhotoAnalyses(processedPhotos);

        // Fetch ALL files for measurement detection
        const { data: files, error: filesError } = await supabase
          .from('claim_files')
          .select('id, file_name, file_path, claim_folders(name)')
          .eq('claim_id', claimId);
        
        if (filesError) {
          console.error('Error fetching claim files:', filesError);
        }
        
        // SIMPLIFIED: Only match TRUE measurement reports, NOT inspection reports
        // Measurement reports contain property dimensions (sq ft, linear ft, roof area)
        const measurementKeywords = [
          'measurement', 'eagleview', 'hover', 'roof report', 
          'takeoff', 'dimensions', 'aerial', 'satellite'
        ];
        
        // Patterns to EXCLUDE (these are NOT measurement reports)
        const excludeKeywords = [
          'inspector', 'inspection', 'engineer', 'adjuster', 'denial', 'letter', 'scope'
        ];
        
        console.log('All claim files for measurement detection:', files?.map((f: any) => f.file_name));
        
        const measurements = (files || []).filter((f: any) => {
          const fileName = f.file_name?.toLowerCase() || '';
          const folderName = f.claim_folders?.name?.toLowerCase() || '';
          
          // EXCLUDE inspector/engineer reports
          const isExcluded = excludeKeywords.some(k => 
            fileName.includes(k) || folderName.includes(k)
          );
          if (isExcluded) return false;
          
          // Match ONLY files that contain measurement-related keywords
          const matchesKeyword = measurementKeywords.some(k => 
            fileName.includes(k) || folderName.includes(k)
          );
          
          // Match EagleView-style naming ONLY if folder suggests measurements OR filename says "report"
          // Pattern: "report-XXXXX.pdf" in a measurements folder
          const isReportPattern = /^report-[a-z0-9]+/i.test(fileName) && 
            (folderName.includes('measurement') || folderName.includes('eagleview') || folderName.includes('hover'));
          
          const isMatch = matchesKeyword || isReportPattern;
          if (isMatch) {
            console.log('Matched measurement file:', fileName, { matchesKeyword, isReportPattern });
          }
          
          return isMatch;
        }).map((f: any) => ({
          id: f.id,
          file_name: f.file_name,
          file_path: f.file_path,
          folder_name: f.claim_folders?.name || null
        }));
        
        console.log('Evidence loaded - Photos:', photos?.length, 'Measurement files found:', measurements.length, measurements.map(m => m.file_name));
        setMeasurementFiles(measurements);
      } catch (error) {
        console.error('Error loading evidence data:', error);
      } finally {
        setLoadingEvidence(false);
      }
    };

    loadEvidenceData();
  }, [claimId]);

  // Load previous analysis on mount
  useEffect(() => {
    const loadPreviousAnalysis = async () => {
      const { data } = await supabase
        .from('darwin_analysis_results')
        .select('*')
        .eq('claim_id', claimId)
        .eq('analysis_type', 'supplement')
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

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>, type: 'our' | 'insurance') => {
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
      if (type === 'our') {
        setOurEstimatePdf(file);
        setSelectedOurEstimateId(null);
      } else {
        setInsuranceEstimatePdf(file);
        setSelectedInsuranceEstimateId(null);
      }
    }
  };

  const clearFile = (type: 'our' | 'insurance') => {
    if (type === 'our') {
      setOurEstimatePdf(null);
      if (ourEstimateInputRef.current) {
        ourEstimateInputRef.current.value = '';
      }
    } else {
      setInsuranceEstimatePdf(null);
      if (insuranceEstimateInputRef.current) {
        insuranceEstimateInputRef.current.value = '';
      }
    }
  };

  const convertFileToBase64 = async (file: File): Promise<string> => {
    const arrayBuffer = await file.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  };

  const toggleMeasurementFile = (id: string) => {
    const newSelected = new Set(selectedMeasurementIds);
    if (newSelected.has(id)) {
      newSelected.delete(id);
    } else {
      newSelected.add(id);
    }
    setSelectedMeasurementIds(newSelected);
  };

  const selectAllMeasurements = () => {
    setSelectedMeasurementIds(new Set(measurementFiles.map(m => m.id)));
  };

  // Build photo evidence summary for AI
  const buildPhotoEvidenceSummary = () => {
    if (photoAnalyses.length === 0) return null;
    
    const summary = photoAnalyses.map(photo => {
      const damages = Array.isArray(photo.ai_detected_damages) ? photo.ai_detected_damages : [];
      return {
        file_name: photo.file_name,
        category: photo.category,
        material: photo.ai_material_type,
        condition: photo.ai_condition_rating,
        damages: damages,
        loss_consistency: photo.ai_loss_type_consistency,
        summary: photo.ai_analysis_summary
      };
    });
    
    return summary;
  };

  const handleGenerate = async () => {
    setLoading(true);
    try {
      let ourEstimateContent: string | undefined;
      let insuranceEstimateContent: string | undefined;
      let ourFileName: string | undefined;
      let insuranceFileName: string | undefined;

      if (inputMethod === "claim-files") {
        const ourFile = claimFiles.find(f => f.id === selectedOurEstimateId);
        const insuranceFile = claimFiles.find(f => f.id === selectedInsuranceEstimateId);

        if (ourFile) {
          ourEstimateContent = await downloadFileAsBase64(ourFile.file_path) || undefined;
          ourFileName = ourFile.file_name;
        }
        if (insuranceFile) {
          insuranceEstimateContent = await downloadFileAsBase64(insuranceFile.file_path) || undefined;
          insuranceFileName = insuranceFile.file_name;
        }
      } else {
        if (ourEstimatePdf) {
          ourEstimateContent = await convertFileToBase64(ourEstimatePdf);
          ourFileName = ourEstimatePdf.name;
        }
        if (insuranceEstimatePdf) {
          insuranceEstimateContent = await convertFileToBase64(insuranceEstimatePdf);
          insuranceFileName = insuranceEstimatePdf.name;
        }
      }

      // Load selected measurement file contents
      const measurementContents: Array<{ name: string; content: string }> = [];
      for (const measurementId of selectedMeasurementIds) {
        const file = measurementFiles.find(f => f.id === measurementId);
        if (file) {
          const content = await downloadFileAsBase64(file.file_path);
          if (content) {
            measurementContents.push({ name: file.file_name, content });
          }
        }
      }

      // Build photo evidence summary
      const photoEvidence = buildPhotoEvidenceSummary();

      // Check if manual measurements are provided (these override PDF extraction)
      const hasManualMeasurements = manualMeasurements.roofSquares || manualMeasurements.ridgeHipLF;
      
      const { data, error } = await supabase.functions.invoke('darwin-ai-analysis', {
        body: {
          claimId,
          analysisType: 'supplement',
          content: additionalNotes,
          pdfContent: insuranceEstimateContent,
          pdfFileName: insuranceFileName,
          additionalContext: { 
            existingEstimate,
            ourEstimatePdf: ourEstimateContent,
            ourEstimatePdfName: ourFileName,
            insuranceEstimatePdf: insuranceEstimateContent,
            insuranceEstimatePdfName: insuranceFileName,
            // Photo analysis evidence
            photoEvidence,
            photoCount: photoAnalyses.length,
            // Measurement reports (PDF files)
            measurementReports: measurementContents,
            measurementCount: measurementContents.length,
            // CRITICAL: Manual measurements from user (EXACT values to use)
            manualMeasurements: hasManualMeasurements ? {
              roofSquares: manualMeasurements.roofSquares || null,
              ridgeHipLF: manualMeasurements.ridgeHipLF || null,
              valleyLF: manualMeasurements.valleyLF || null,
              eaveRakeLF: manualMeasurements.eaveRakeLF || null,
              roofPitch: manualMeasurements.roofPitch || null,
              stories: manualMeasurements.stories || null,
              pipeBoots: manualMeasurements.pipeBoots || null,
              vents: manualMeasurements.vents || null,
              skylights: manualMeasurements.skylights || null
            } : null
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
      const fileNames = [ourFileName, insuranceFileName].filter(Boolean).join(' vs ');
      setLastFileName(fileNames || null);

      // Save the analysis result
      const { data: userData } = await supabase.auth.getUser();
      await supabase.from('darwin_analysis_results').insert({
        claim_id: claimId,
        analysis_type: 'supplement',
        input_summary: `${fileNames || existingEstimate.substring(0, 100)} | Photos: ${photoAnalyses.length} | Measurements: ${measurementContents.length}`,
        result: JSON.stringify(structuredResult, null, 2),
        pdf_file_name: fileNames || null,
        created_by: userData.user?.id
      });

      toast({
        title: "Estimate generated",
        description: `Darwin analyzed ${photoAnalyses.length} photos and ${measurementContents.length} measurement reports to build the estimate`
      });
    } catch (error: any) {
      console.error("Supplement generation error:", error);
      toast({
        title: "Generation failed",
        description: error.message || "Failed to generate supplement",
        variant: "destructive"
      });
    } finally {
      setLoading(false);
    }
  };

  // Stats for evidence summary
  const analyzedPhotosCount = photoAnalyses.filter(p => p.is_analyzed).length;
  const unanalyzedPhotosCount = photoAnalyses.filter(p => !p.is_analyzed).length;
  const damagePhotosCount = photoAnalyses.filter(p => {
    const damages = Array.isArray(p.ai_detected_damages) ? p.ai_detected_damages : [];
    return damages.length > 0;
  }).length;
  
  const criticalPhotosCount = photoAnalyses.filter(p => 
    p.ai_condition_rating?.toLowerCase() === 'poor' || 
    p.ai_condition_rating?.toLowerCase() === 'failed'
  ).length;

  const ourEstimateFile = claimFiles.find(f => f.id === selectedOurEstimateId);
  const insuranceEstimateFile = claimFiles.find(f => f.id === selectedInsuranceEstimateId);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <PlusCircle className="h-5 w-5 text-primary" />
          AI Estimate Builder
        </CardTitle>
        <CardDescription>
          Generate accurate estimates from photo analysis, measurements, and damage documentation
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <DarwinModeToggle value={mode} onChange={setMode} />

        {lastAnalyzed && (
          <div className="p-3 bg-muted/50 rounded-md text-sm text-muted-foreground flex items-center gap-2">
            <History className="h-4 w-4" />
            Previous analysis from {lastAnalyzed.toLocaleString()}
            {lastFileName && <span className="text-xs">({lastFileName})</span>}
          </div>
        )}

        {/* Evidence Panel */}
        <Collapsible open={evidenceExpanded} onOpenChange={setEvidenceExpanded}>
          <CollapsibleTrigger asChild>
            <Button variant="outline" className="w-full justify-between">
              <div className="flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-primary" />
                <span>Available Evidence for Estimate</span>
              </div>
              <div className="flex items-center gap-2">
                {loadingEvidence ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <>
                    <Badge variant="secondary" className="text-xs">
                      {photoAnalyses.length} Photos ({analyzedPhotosCount} analyzed)
                    </Badge>
                    <Badge variant="secondary" className="text-xs">
                      {measurementFiles.length} Measurements
                    </Badge>
                  </>
                )}
                <ChevronDown className={`h-4 w-4 transition-transform ${evidenceExpanded ? 'rotate-180' : ''}`} />
              </div>
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="pt-3 space-y-4">
            {/* Photo Evidence Summary */}
            <div className="border rounded-lg p-4 space-y-3">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <div className="flex items-center gap-2">
                  <Camera className="h-4 w-4 text-primary" />
                  <span className="font-medium text-sm">Claim Photos ({photoAnalyses.length} total)</span>
                </div>
                <div className="flex items-center gap-2">
                  {unanalyzedPhotosCount > 0 && (
                    <Badge variant="outline" className="text-xs text-amber-600 border-amber-300">
                      {unanalyzedPhotosCount} not analyzed
                    </Badge>
                  )}
                  {damagePhotosCount > 0 && (
                    <Badge variant="destructive" className="text-xs">
                      <AlertTriangle className="h-3 w-3 mr-1" />
                      {damagePhotosCount} with damage
                    </Badge>
                  )}
                </div>
              </div>
              
              {photoAnalyses.length > 0 ? (
                <ScrollArea className="h-[160px]">
                  <div className="space-y-2">
                    {/* Show analyzed photos first */}
                    {photoAnalyses.filter(p => p.is_analyzed).map(photo => {
                      const damages = Array.isArray(photo.ai_detected_damages) ? photo.ai_detected_damages : [];
                      return (
                        <div key={photo.id} className="flex items-start gap-2 p-2 bg-muted/50 rounded text-xs">
                          <CheckCircle2 className="h-3 w-3 text-green-600 mt-0.5 flex-shrink-0" />
                          <div className="flex-1 min-w-0">
                            <p className="font-medium truncate">{photo.file_name}</p>
                            <div className="flex flex-wrap gap-1 mt-1">
                              {photo.ai_material_type && (
                                <Badge variant="outline" className="text-xs">{photo.ai_material_type}</Badge>
                              )}
                              {photo.ai_condition_rating && (
                                <Badge 
                                  variant={photo.ai_condition_rating.toLowerCase() === 'poor' || photo.ai_condition_rating.toLowerCase() === 'failed' ? 'destructive' : 'secondary'} 
                                  className="text-xs"
                                >
                                  {photo.ai_condition_rating}
                                </Badge>
                              )}
                              {damages.length > 0 && (
                                <Badge variant="destructive" className="text-xs">
                                  {damages.length} damage{damages.length > 1 ? 's' : ''}
                                </Badge>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                    {/* Show unanalyzed photos */}
                    {photoAnalyses.filter(p => !p.is_analyzed).map(photo => (
                      <div key={photo.id} className="flex items-start gap-2 p-2 bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800 rounded text-xs">
                        <Camera className="h-3 w-3 text-amber-600 mt-0.5 flex-shrink-0" />
                        <div className="flex-1 min-w-0">
                          <p className="font-medium truncate text-muted-foreground">{photo.file_name}</p>
                          <Badge variant="outline" className="text-xs mt-1 text-amber-600 border-amber-300">
                            Pending AI analysis
                          </Badge>
                        </div>
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No photos found for this claim.
                </p>
              )}

              {unanalyzedPhotosCount > 0 && (
                <div className="p-2 bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800 rounded text-xs text-amber-700 dark:text-amber-400">
                  <strong>Tip:</strong> Go to the Photos tab and run "Analyze All Photos" to get AI damage detection for better estimates.
                </div>
              )}

              {criticalPhotosCount > 0 && (
                <div className="flex items-center gap-2 p-2 bg-destructive/10 rounded text-xs text-destructive">
                  <AlertTriangle className="h-3 w-3" />
                  <span>{criticalPhotosCount} photo(s) show Poor/Failed condition - critical for estimate justification</span>
                </div>
              )}
            </div>

            {/* Measurement Files */}
            <div className="border rounded-lg p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Ruler className="h-4 w-4 text-primary" />
                  <span className="font-medium text-sm">Measurement Reports</span>
                </div>
                {measurementFiles.length > 0 && (
                  <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={selectAllMeasurements}>
                    Select All
                  </Button>
                )}
              </div>
              
              {measurementFiles.length > 0 ? (
                <div className="space-y-2">
                  {measurementFiles.map(file => (
                    <div 
                      key={file.id} 
                      className={`flex items-center gap-2 p-2 border rounded cursor-pointer hover:bg-muted/50 ${
                        selectedMeasurementIds.has(file.id) ? 'border-primary bg-primary/5' : ''
                      }`}
                      onClick={() => toggleMeasurementFile(file.id)}
                    >
                      <div className={`h-4 w-4 border rounded flex items-center justify-center ${
                        selectedMeasurementIds.has(file.id) ? 'bg-primary border-primary' : ''
                      }`}>
                        {selectedMeasurementIds.has(file.id) && <CheckCircle2 className="h-3 w-3 text-primary-foreground" />}
                      </div>
                      <FileText className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm truncate">{file.file_name}</p>
                        {file.folder_name && (
                          <p className="text-xs text-muted-foreground">{file.folder_name}</p>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No measurement reports found. Upload EagleView, Hover, or other measurement reports to the claim files.
                </p>
              )}

              {/* Manual Measurement Entry - CRITICAL for accurate quantities */}
              <div className="mt-4 p-3 bg-primary/5 rounded-lg border border-primary/20 space-y-3">
                <div className="flex items-center gap-2">
                  <Ruler className="h-4 w-4 text-primary" />
                  <span className="font-medium text-sm">Manual Measurements (Required for accuracy)</span>
                </div>
                <p className="text-xs text-muted-foreground">
                  Enter EXACT values from your measurement report. These override AI guesses.
                </p>
                
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                  <div className="space-y-1">
                    <Label htmlFor="roofSquares" className="text-xs font-medium">Roof Area (SQ)</Label>
                    <Input
                      id="roofSquares"
                      type="text"
                      placeholder="e.g., 17"
                      value={manualMeasurements.roofSquares}
                      onChange={(e) => setManualMeasurements(prev => ({ ...prev, roofSquares: e.target.value }))}
                      className="h-8 text-sm"
                    />
                  </div>
                  
                  <div className="space-y-1">
                    <Label htmlFor="ridgeHipLF" className="text-xs font-medium">Ridge/Hip (LF)</Label>
                    <Input
                      id="ridgeHipLF"
                      type="text"
                      placeholder="e.g., 145"
                      value={manualMeasurements.ridgeHipLF}
                      onChange={(e) => setManualMeasurements(prev => ({ ...prev, ridgeHipLF: e.target.value }))}
                      className="h-8 text-sm"
                    />
                  </div>
                  
                  <div className="space-y-1">
                    <Label htmlFor="valleyLF" className="text-xs font-medium">Valley (LF)</Label>
                    <Input
                      id="valleyLF"
                      type="text"
                      placeholder="e.g., 68"
                      value={manualMeasurements.valleyLF}
                      onChange={(e) => setManualMeasurements(prev => ({ ...prev, valleyLF: e.target.value }))}
                      className="h-8 text-sm"
                    />
                  </div>
                  
                  <div className="space-y-1">
                    <Label htmlFor="eaveRakeLF" className="text-xs font-medium">Eave/Rake (LF)</Label>
                    <Input
                      id="eaveRakeLF"
                      type="text"
                      placeholder="e.g., 320"
                      value={manualMeasurements.eaveRakeLF}
                      onChange={(e) => setManualMeasurements(prev => ({ ...prev, eaveRakeLF: e.target.value }))}
                      className="h-8 text-sm"
                    />
                  </div>
                  
                  <div className="space-y-1">
                    <Label htmlFor="roofPitch" className="text-xs font-medium">Pitch</Label>
                    <Input
                      id="roofPitch"
                      type="text"
                      placeholder="e.g., 6/12"
                      value={manualMeasurements.roofPitch}
                      onChange={(e) => setManualMeasurements(prev => ({ ...prev, roofPitch: e.target.value }))}
                      className="h-8 text-sm"
                    />
                  </div>
                  
                  <div className="space-y-1">
                    <Label htmlFor="stories" className="text-xs font-medium">Stories</Label>
                    <Input
                      id="stories"
                      type="text"
                      placeholder="e.g., 2"
                      value={manualMeasurements.stories}
                      onChange={(e) => setManualMeasurements(prev => ({ ...prev, stories: e.target.value }))}
                      className="h-8 text-sm"
                    />
                  </div>
                </div>
                
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div className="space-y-1">
                    <Label htmlFor="pipeBoots" className="text-xs font-medium">Pipe Boots</Label>
                    <Input
                      id="pipeBoots"
                      type="text"
                      placeholder="e.g., 4"
                      value={manualMeasurements.pipeBoots}
                      onChange={(e) => setManualMeasurements(prev => ({ ...prev, pipeBoots: e.target.value }))}
                      className="h-8 text-sm"
                    />
                  </div>
                  
                  <div className="space-y-1">
                    <Label htmlFor="vents" className="text-xs font-medium">Vents</Label>
                    <Input
                      id="vents"
                      type="text"
                      placeholder="e.g., 2"
                      value={manualMeasurements.vents}
                      onChange={(e) => setManualMeasurements(prev => ({ ...prev, vents: e.target.value }))}
                      className="h-8 text-sm"
                    />
                  </div>
                  
                  <div className="space-y-1">
                    <Label htmlFor="skylights" className="text-xs font-medium">Skylights</Label>
                    <Input
                      id="skylights"
                      type="text"
                      placeholder="e.g., 0"
                      value={manualMeasurements.skylights}
                      onChange={(e) => setManualMeasurements(prev => ({ ...prev, skylights: e.target.value }))}
                      className="h-8 text-sm"
                    />
                  </div>
                </div>
              </div>
            </div>

            {/* Evidence Summary */}
            {(photoAnalyses.length > 0 || selectedMeasurementIds.size > 0 || manualMeasurements.roofSquares) && (
              <div className="p-3 bg-primary/5 rounded-lg border border-primary/20">
                <p className="text-sm">
                  <strong>Darwin will use:</strong> {photoAnalyses.length} analyzed photos 
                  {manualMeasurements.roofSquares && <span className="text-primary font-medium"> + {manualMeasurements.roofSquares} SQ roof</span>}
                  {selectedMeasurementIds.size > 0 && !manualMeasurements.roofSquares && ` + ${selectedMeasurementIds.size} measurement report(s)`} 
                  {' '}to generate accurate line items with justifications.
                </p>
                {manualMeasurements.roofSquares && (
                  <p className="text-xs text-primary mt-1">
                    ✓ Manual measurements will be used for exact quantities
                  </p>
                )}
              </div>
            )}
          </CollapsibleContent>
        </Collapsible>

        <Tabs value={inputMethod} onValueChange={setInputMethod}>
          <TabsList className="flex flex-col sm:flex-row w-full h-auto gap-1 p-1">
            <TabsTrigger value="claim-files" className="w-full justify-start gap-2 px-3 py-2">
              <FolderOpen className="h-4 w-4 flex-shrink-0" />
              <span>Select from Claim Files</span>
            </TabsTrigger>
            <TabsTrigger value="upload" className="w-full justify-start gap-2 px-3 py-2">
              <Upload className="h-4 w-4 flex-shrink-0" />
              <span>Upload New PDFs</span>
            </TabsTrigger>
          </TabsList>

          <TabsContent value="claim-files" className="space-y-4 mt-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <label className="text-sm font-medium">Our Estimate</label>
                <ClaimFileSelector
                  files={claimFiles}
                  loading={loadingFiles}
                  selectedFileId={selectedOurEstimateId}
                  onSelectFile={(file) => {
                    setSelectedOurEstimateId(file.id);
                    setOurEstimatePdf(null);
                  }}
                  height="150px"
                  emptyMessage="No PDFs found"
                />
                {ourEstimateFile && (
                  <p className="text-xs text-primary">Selected: {ourEstimateFile.file_name}</p>
                )}
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium">Insurance Estimate</label>
                <ClaimFileSelector
                  files={claimFiles}
                  loading={loadingFiles}
                  selectedFileId={selectedInsuranceEstimateId}
                  onSelectFile={(file) => {
                    setSelectedInsuranceEstimateId(file.id);
                    setInsuranceEstimatePdf(null);
                  }}
                  height="150px"
                  emptyMessage="No PDFs found"
                />
                {insuranceEstimateFile && (
                  <p className="text-xs text-primary">Selected: {insuranceEstimateFile.file_name}</p>
                )}
              </div>
            </div>
          </TabsContent>

          <TabsContent value="upload" className="mt-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <label className="text-sm font-medium">Our Estimate (PDF)</label>
                <div className="flex items-center gap-2">
                  <input
                    type="file"
                    accept=".pdf"
                    onChange={(e) => handleFileChange(e, 'our')}
                    ref={ourEstimateInputRef}
                    className="hidden"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => ourEstimateInputRef.current?.click()}
                    className="flex items-center gap-2"
                  >
                    <Upload className="h-4 w-4" />
                    {ourEstimatePdf ? 'Change' : 'Upload'}
                  </Button>
                  {ourEstimatePdf && (
                    <div className="flex items-center gap-2 px-3 py-1.5 bg-muted rounded-md flex-1">
                      <FileText className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                      <span className="text-sm truncate">{ourEstimatePdf.name}</span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => clearFile('our')}
                        className="h-6 w-6 p-0 ml-auto flex-shrink-0"
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                  )}
                </div>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium">Insurance Estimate (PDF)</label>
                <div className="flex items-center gap-2">
                  <input
                    type="file"
                    accept=".pdf"
                    onChange={(e) => handleFileChange(e, 'insurance')}
                    ref={insuranceEstimateInputRef}
                    className="hidden"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => insuranceEstimateInputRef.current?.click()}
                    className="flex items-center gap-2"
                  >
                    <Upload className="h-4 w-4" />
                    {insuranceEstimatePdf ? 'Change' : 'Upload'}
                  </Button>
                  {insuranceEstimatePdf && (
                    <div className="flex items-center gap-2 px-3 py-1.5 bg-muted rounded-md flex-1">
                      <FileText className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                      <span className="text-sm truncate">{insuranceEstimatePdf.name}</span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => clearFile('insurance')}
                        className="h-6 w-6 p-0 ml-auto flex-shrink-0"
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </TabsContent>
        </Tabs>

        <div className="space-y-2">
          <label className="text-sm font-medium">Or Paste Estimate Items (optional)</label>
          <Textarea
            value={existingEstimate}
            onChange={(e) => setExistingEstimate(e.target.value)}
            placeholder="Paste existing estimate line items here to help identify what's missing..."
            className="min-h-[100px]"
          />
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium">Additional Observations (optional)</label>
          <Textarea
            value={additionalNotes}
            onChange={(e) => setAdditionalNotes(e.target.value)}
            placeholder="Note any specific damage observations, areas of concern, or items you suspect were missed..."
            className="min-h-[80px]"
          />
        </div>

        <Button 
          onClick={handleGenerate} 
          disabled={loading}
          className="w-full"
        >
          {loading ? (
            <>
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              Building Estimate from Evidence...
            </>
          ) : (
            <>
              <Sparkles className="h-4 w-4 mr-2" />
              Generate Estimate with Line Item Justifications
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

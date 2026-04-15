import { useState, useEffect } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { getFunctionErrorMessage } from "@/lib/edgeFunctionError";
import { toast } from "sonner";
import { FileText, Loader2, Download, Copy, FolderOpen, File, CheckSquare, AlertCircle, Briefcase, Camera, Shield, Flame, Scale } from "lucide-react";
import { format } from "date-fns";
import { useDeclaredPosition } from "@/hooks/useDeclaredPosition";

interface DarwinDemandPackageProps {
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
}

interface ClaimPhoto {
  id: string;
  file_name: string;
  file_path: string;
  category: string | null;
  description: string | null;
}

const STRATEGY_PRESETS: { value: string; label: string; description: string }[] = [
  { value: "general_property", label: "General Property Loss", description: "Balanced demand package across causation, scope, code, and cost." },
  { value: "roof_wind_hail", label: "Roof Wind / Hail", description: "Emphasizes storm causation, HAAG, weather correlation, and repairability." },
  { value: "interior_water", label: "Interior Water", description: "Emphasizes source, intrusion path, drying, secondary damage, and full scope." },
  { value: "engineer_rebuttal", label: "Engineer Rebuttal", description: "Targets carrier engineer conclusions and selective inspection issues." },
  { value: "repairability_matching", label: "Repairability / Matching", description: "Focuses on discontinuation, system interdependency, and infeasible repair." },
  { value: "code_upgrade", label: "Code Upgrade", description: "Emphasizes building code triggers, local amendments, and required upgrades." },
  { value: "partial_denial_rebuttal", label: "Partial Denial Rebuttal", description: "Rebut denied line items and prove covered scope item-by-item." },
  { value: "coverage_trigger_dispute", label: "Coverage Trigger Dispute", description: "Focuses on direct physical loss, ensuing loss, storm-created opening, and carrier burden." },
];

const TONE_OPTIONS: { value: string; label: string; description: string; icon: string }[] = [
  { value: "standard", label: "Standard", description: "Professional, evidence-driven demand", icon: "📋" },
  { value: "aggressive", label: "Aggressive", description: "Forceful, emphasizes carrier failures and obligations", icon: "🔥" },
  { value: "litigation", label: "Litigation Ready", description: "Final step before formal dispute — maximum pressure", icon: "⚖️" },
];

const REQUIRED_SECTIONS = [
  'Summary of Findings',
  'Narrative Framing & Preemptive Clarification',
  'Roof Damage Assessment',
  'Exterior / Siding Damage Assessment',
  'Gutter / Downspout Assessment',
  'Damage Characterization Analysis',
  'Scope of Repair / Justification',
  'Demand',
];

const SECTION_VALIDATION_RULES: Record<string, { minChars: number; minSentences: number }> = {
  'Summary of Findings': { minChars: 250, minSentences: 3 },
  'Narrative Framing & Preemptive Clarification': { minChars: 250, minSentences: 3 },
  'Roof Damage Assessment': { minChars: 400, minSentences: 5 },
  'Exterior / Siding Damage Assessment': { minChars: 250, minSentences: 3 },
  'Gutter / Downspout Assessment': { minChars: 200, minSentences: 2 },
  'Damage Characterization Analysis': { minChars: 300, minSentences: 4 },
  'Scope of Repair / Justification': { minChars: 400, minSentences: 5 },
  'Demand': { minChars: 150, minSentences: 2 },
};

const FILLER_PHRASES = [
  'in conclusion',
  'overall',
  'it is important to note',
  'this section',
  'placeholder',
  'to be determined',
];

function countSentences(text: string): number {
  return (text.match(/[.!?](?:\s|$)/g) || []).length;
}

function extractSectionBody(fullText: string, heading: string, nextHeadings: string[]): string {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const nextPattern = nextHeadings
    .map(h => h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  const regex = new RegExp(`${escaped}[\\s\\S]*?(?=${nextPattern}|$)`, 'i');
  const match = fullText.match(regex);
  return match?.[0] || '';
}

interface ValidationError {
  section: string;
  message: string;
}

function validateDemandPackage(fullText: string): ValidationError[] {
  const errors: ValidationError[] = [];

  // Check all sections present
  for (const heading of REQUIRED_SECTIONS) {
    if (!fullText.toLowerCase().includes(heading.toLowerCase())) {
      errors.push({ section: heading, message: `Missing section: ${heading}` });
    }
  }
  if (errors.length > 0) return errors;

  // Validate each section body
  for (let i = 0; i < REQUIRED_SECTIONS.length; i++) {
    const heading = REQUIRED_SECTIONS[i];
    const body = extractSectionBody(fullText, heading, REQUIRED_SECTIONS.slice(i + 1));
    const stripped = body.replace(new RegExp(heading, 'i'), '').replace(/\s+/g, ' ').trim();
    const rules = SECTION_VALIDATION_RULES[heading];
    if (!rules) continue;

    const chars = stripped.length;
    const sentences = countSentences(stripped);

    if (chars < rules.minChars) {
      errors.push({ section: heading, message: `${heading} too short: ${chars} chars, requires ${rules.minChars}` });
    }
    if (sentences < rules.minSentences) {
      errors.push({ section: heading, message: `${heading} needs ${rules.minSentences}+ sentences, found ${sentences}` });
    }
  }

  // Filler detection
  const lowerText = fullText.toLowerCase();
  for (const phrase of FILLER_PHRASES) {
    if (lowerText.includes(phrase)) {
      errors.push({ section: 'Content Quality', message: `Contains filler phrase: "${phrase}"` });
    }
  }

  return errors;
}

const GENERATION_RULES = [
  'Use a factual, technical, report-style tone — not persuasive narrative.',
  'Summary of Findings must be bullet points only — no paragraph text.',
  'Each bullet: one fact, specific, tied to observed damage.',
  'Include exclusion bullets (e.g., "No hail damage observed").',
  'Do not invent facts not found in the provided evidence.',
  'Use subheadings within damage sections for scannability.',
  'Add explanation only for: repair scope justification, code requirements, manufacturer specs, system interdependency.',
  'Remove redundant conclusions — state a finding once.',
  'If evidence does not support a confident conclusion, say so explicitly.',
  'Identify evidence gaps in strategic_notes only, not in the report body.',
];

export const DarwinDemandPackage = ({ claimId, claim }: DarwinDemandPackageProps) => {
  const [files, setFiles] = useState<ClaimFile[]>([]);
  const [photos, setPhotos] = useState<ClaimPhoto[]>([]);
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const [selectedPhotos, setSelectedPhotos] = useState<Set<string>>(new Set());
  const [additionalInstructions, setAdditionalInstructions] = useState('');
  const [strategyPreset, setStrategyPreset] = useState<string>('roof_wind_hail');
  const [tone, setTone] = useState<string>('standard');
  const [provenMode, setProvenMode] = useState<boolean>(true);
  const [loading, setLoading] = useState(false);
  const [loadingData, setLoadingData] = useState(true);
  const [generatedPackage, setGeneratedPackage] = useState<string | null>(null);
  const [docxHtml, setDocxHtml] = useState<string | null>(null);
  const [lastPackageDate, setLastPackageDate] = useState<string | null>(null);
  const [validationErrors, setValidationErrors] = useState<ValidationError[]>([]);

  const { position } = useDeclaredPosition(claimId);

  const [assignedUserName, setAssignedUserName] = useState<string>('Public Adjuster');
  const [companyBranding, setCompanyBranding] = useState<any>(null);

  // Structured claim facts helper
  const claimFacts = {
    policyholderName: claim?.policyholder_name || '',
    claimNumber: claim?.claim_number || '',
    policyNumber: claim?.policy_number || '',
    carrier: claim?.carrier_name || claim?.insurance_company || '',
    dateOfLoss: claim?.date_of_loss || claim?.loss_date || '',
    lossAddress: claim?.loss_address || claim?.property_address || '',
    state: claim?.state || '',
    typeOfLoss: claim?.loss_type || claim?.claim_type || '',
  };

  useEffect(() => {
    loadData();
  }, [claimId]);

  const loadData = async () => {
    setLoadingData(true);
    try {
      const { data: foldersData } = await supabase
        .from('claim_folders')
        .select('id, name')
        .eq('claim_id', claimId);
      
      const folderMap = new Map(foldersData?.map(f => [f.id, f.name]) || []);

      const { data: filesData, error: filesError } = await supabase
        .from('claim_files')
        .select('id, file_name, file_path, file_type, folder_id, uploaded_at')
        .eq('claim_id', claimId)
        .order('uploaded_at', { ascending: false });

      if (filesError) throw filesError;
      
      const documentFiles = (filesData || [])
        .filter(f => f.file_name?.toLowerCase().endsWith('.pdf'))
        .map(f => ({
          ...f,
          folder_name: f.folder_id ? folderMap.get(f.folder_id) : undefined
        }));
      setFiles(documentFiles);

      const { data: photosData } = await supabase
        .from('claim_photos')
        .select('id, file_name, file_path, category, description')
        .eq('claim_id', claimId)
        .order('created_at', { ascending: false });
      
      setPhotos(photosData || []);

      const { data: brandingData } = await supabase
        .from('company_branding')
        .select('*')
        .limit(1)
        .single();
      setCompanyBranding(brandingData);

      const { data: staffData } = await supabase
        .from('claim_staff')
        .select('staff_id')
        .eq('claim_id', claimId)
        .limit(1)
        .maybeSingle();

      if (staffData?.staff_id) {
        const { data: profileData } = await supabase
          .from('profiles')
          .select('full_name')
          .eq('id', staffData.staff_id)
          .maybeSingle();
        if (profileData?.full_name) {
          setAssignedUserName(profileData.full_name);
        }
      }

      const { data: previousPackage } = await supabase
        .from('darwin_analysis_results')
        .select('result, created_at')
        .eq('claim_id', claimId)
        .eq('analysis_type', 'demand_package')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (previousPackage) {
        setGeneratedPackage(previousPackage.result);
        setLastPackageDate(previousPackage.created_at);
      }
    } catch (error) {
      console.error('Error loading data:', error);
    } finally {
      setLoadingData(false);
    }
  };

  const toggleFile = (id: string) => {
    const newSelected = new Set(selectedFiles);
    if (newSelected.has(id)) newSelected.delete(id);
    else newSelected.add(id);
    setSelectedFiles(newSelected);
  };

  const togglePhoto = (id: string) => {
    const newSelected = new Set(selectedPhotos);
    if (newSelected.has(id)) newSelected.delete(id);
    else newSelected.add(id);
    setSelectedPhotos(newSelected);
  };

  const selectAllFiles = () => setSelectedFiles(new Set(files.map(f => f.id)));
  const clearFiles = () => setSelectedFiles(new Set());
  const selectAllPhotos = () => setSelectedPhotos(new Set(photos.map(p => p.id)));
  const clearPhotos = () => setSelectedPhotos(new Set());

  const blobToBase64 = (blob: Blob): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const result = reader.result as string;
        const base64 = result.split(',')[1] || result;
        resolve(base64);
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  };

  const MAX_PDFS = 5;
  const MAX_PHOTOS = 15;
  const MAX_FILE_SIZE_MB = 12;
  const MAX_TOTAL_PAYLOAD_BYTES = 45 * 1024 * 1024;

  const handleGenerate = async () => {
    setLoading(true);
    toast.info('Darwin is analyzing evidence and assembling the restoration report.');

    try {
      // Build declared position text from position hook
      const declaredPositionText = position ? [
        position.observed_damage_condition ? `Observed Damage: ${position.observed_damage_condition}` : '',
        position.primary_loss_mechanism ? `Loss Mechanism: ${position.primary_loss_mechanism}` : '',
        position.coverage_trigger_theory ? `Coverage Trigger: ${position.coverage_trigger_theory}` : '',
        position.specific_carrier_failure ? `Carrier Failure: ${position.specific_carrier_failure}` : '',
        position.decisive_contradiction ? `Decisive Contradiction: ${position.decisive_contradiction}` : '',
        position.requested_remedy ? `Requested Remedy: ${position.requested_remedy}` : '',
        position.master_position_statement ? `Position Statement: ${position.master_position_statement}` : '',
      ].filter(Boolean).join('\n') : '';

      const selectedFileIdsArray = Array.from(selectedFiles);

      console.log("Demand package selected files", {
        selectedFiles,
        selectedFileIdsArray,
        availableFiles: files.map((f) => ({
          id: f.id,
          file_name: f.file_name,
        })),
      });

      const selectedEstimateFile = files.find(
        (f) =>
          selectedFileIdsArray.includes(f.id) &&
          /estimate|xactimate|scope|repair estimate|rebuild/i.test(
            `${f.file_name || ""}`
          )
      );

      const { data, error } = await supabase.functions.invoke('generate-demand-package', {
        body: {
          claimId,
          tone,
          mode: provenMode ? "proven" : "standard",
          selectedFileIds: selectedFileIdsArray,
          selectedEstimateId: selectedEstimateFile?.id || null,
          estimateTotal: null,
          declaredPositionText,
          userNotes: additionalInstructions || '',
          saveToMasterState: true,
        },
      });

      if (error) throw error;

      const demandPackage = data?.demandPackage;
      const demandText = demandPackage?.full_demand_package || '';
      const returnedDocxHtml = data?.docxHtml || '';

      setGeneratedPackage(demandText);
      setDocxHtml(returnedDocxHtml);
      setLastPackageDate(new Date().toISOString());

      await supabase.from('darwin_analysis_results').insert({
        claim_id: claimId,
        analysis_type: 'demand_package',
        result: demandText,
        input_summary: `Tone: ${tone}, Strategy: ${strategyPreset}, Proven Mode: ${provenMode ? 'on' : 'off'}`,
        metadata: {
          tone,
          mode: provenMode ? "proven" : "standard",
          strategyPreset,
          demandAmount: demandPackage?.demand_amount || '',
          confidenceScore: demandPackage?.confidence_score || 0,
          claimFacts,
        } as any
      });

      toast.success('Restoration report generated successfully');
    } catch (error: any) {
      console.error('Error generating restoration report:', error);
      const message = await getFunctionErrorMessage(error, 'Failed to generate restoration report');
      toast.error(message);
    } finally {
      setLoading(false);
    }
  };

  const copyToClipboard = () => {
    if (generatedPackage) {
      navigator.clipboard.writeText(generatedPackage);
      toast.success('Copied to clipboard');
    }
  };

  const downloadAsText = () => {
    if (!generatedPackage) return;
    const blob = new Blob([generatedPackage], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `demand_package_${claim.claim_number || claimId}_${format(new Date(), 'yyyy-MM-dd')}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast.success('Demand package downloaded');
  };

  const saveAsWord = async () => {
    if (!generatedPackage) return;
    
    toast.info('Generating Word document...');
    
    try {
      const { data, error } = await supabase.functions.invoke('generate-photo-report-docx', {
        body: {
          reportContent: generatedPackage,
          claimId,
          reportTitle: `Demand Package - ${claim.policyholder_name || 'Claim'} - ${format(new Date(), 'yyyy-MM-dd')}`,
          reportType: 'demand_package',
          companyBranding,
          includeLogoHeader: true,
          headerLogoUrl: companyBranding?.letterhead_url || companyBranding?.logo_url || null,
        }
      });

      if (error) throw error;

      if (data.downloadUrl) {
        const a = document.createElement('a');
        a.href = data.downloadUrl;
        a.download = data.fileName || `demand_package_${claim.claim_number || claimId}.docx`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        toast.success('Word document saved and downloaded');
      }
    } catch (error: any) {
      console.error('Error saving as Word:', error);
      toast.error(error.message || 'Failed to generate Word document');
    }
  };

  if (loadingData) {
    return (
      <Card>
        <CardContent className="py-8 text-center">
          <Loader2 className="h-6 w-6 animate-spin mx-auto mb-2" />
          <p className="text-muted-foreground">Loading claim evidence...</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Briefcase className="h-5 w-5 text-primary" />
          Restoration Report Builder
        </CardTitle>
        <CardDescription>
          Select inspection reports, estimates, and photos for Darwin to analyze. Darwin will organize the evidence into a factual restoration report documenting observed damage, assessment methodology, and repair scope.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <Alert>
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            <strong>How it works:</strong> Select evidence documents and photos. Darwin will read and analyze the actual content to extract findings, document conditions, and build a technical restoration report. Missing evidence is identified in strategic notes.
          </AlertDescription>
        </Alert>

        {/* Strategy Preset */}
        <div className="space-y-2">
          <Label className="flex items-center gap-2">
            <Shield className="h-4 w-4 text-primary" />
            Packet Strategy
          </Label>
          <Select value={strategyPreset} onValueChange={setStrategyPreset}>
            <SelectTrigger>
              <SelectValue placeholder="Select a strategy preset" />
            </SelectTrigger>
            <SelectContent>
              {STRATEGY_PRESETS.map(preset => (
                <SelectItem key={preset.value} value={preset.value}>
                  <div className="flex flex-col">
                    <span>{preset.label}</span>
                    <span className="text-xs text-muted-foreground">{preset.description}</span>
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            Strategy presets adjust Darwin's emphasis and section weighting based on claim type.
          </p>
        </div>

        {/* Demand Tone */}
        <div className="space-y-2">
          <Label className="flex items-center gap-2">
            <Flame className="h-4 w-4 text-destructive" />
            Demand Tone
          </Label>
          <Select value={tone} onValueChange={setTone}>
            <SelectTrigger>
              <SelectValue placeholder="Select tone" />
            </SelectTrigger>
            <SelectContent>
              {TONE_OPTIONS.map(opt => (
                <SelectItem key={opt.value} value={opt.value}>
                  <div className="flex flex-col">
                    <span>{opt.icon} {opt.label}</span>
                    <span className="text-xs text-muted-foreground">{opt.description}</span>
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            Controls assertiveness level. Litigation Ready is for final-step demands before formal dispute.
          </p>
        </div>

        {/* Proven Mode */}
        <div className="flex items-center justify-between p-3 bg-muted/30 rounded-lg border">
          <div className="space-y-1">
            <Label className="text-sm font-medium">Proven Mode</Label>
            <p className="text-xs text-muted-foreground">
              Uses documentation-led language and leans on selected policy materials to support coverage and scope positions.
            </p>
          </div>
          <Switch checked={provenMode} onCheckedChange={setProvenMode} />
        </div>

        {/* Declared Position Status */}
        {position && (position.lock_status === 'strategic_lock' || position.lock_status === 'litigation_grade') && (
          <Alert className="border-primary/30 bg-primary/5">
            <Scale className="h-4 w-4" />
            <AlertDescription>
              <strong>Declared Position Locked</strong> — demand will align with: {position.primary_loss_mechanism || 'loss mechanism'} → {position.requested_remedy || 'requested remedy'}
            </AlertDescription>
          </Alert>
        )}

        {/* Selection Tabs */}
        <Tabs defaultValue="documents" className="w-full">
          <TabsList className="flex flex-col sm:flex-row w-full h-auto gap-1 p-1">
            <TabsTrigger value="documents" className="w-full justify-start gap-2 px-3 py-2">
              <File className="h-4 w-4 flex-shrink-0" />
              <span>Evidence Documents ({selectedFiles.size}/{files.length})</span>
            </TabsTrigger>
            <TabsTrigger value="photos" className="w-full justify-start gap-2 px-3 py-2">
              <Camera className="h-4 w-4 flex-shrink-0" />
              <span>Photos ({selectedPhotos.size}/{photos.length})</span>
            </TabsTrigger>
          </TabsList>

          <TabsContent value="documents" className="space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-sm text-muted-foreground">
                {files.length === 0 ? 'No PDF documents uploaded' : `${files.length} PDF documents available for analysis`}
              </p>
              {files.length > 0 && (
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={selectAllFiles}>
                    <CheckSquare className="h-4 w-4 mr-1" />
                    Select All
                  </Button>
                  <Button variant="ghost" size="sm" onClick={clearFiles}>
                    Clear
                  </Button>
                </div>
              )}
            </div>

            {files.length > 0 ? (
              <ScrollArea className="h-[280px] border rounded-md p-3">
                <div className="space-y-2">
                  {files.map(file => (
                    <div
                      key={file.id}
                      className={`flex items-center gap-3 p-3 border rounded-lg cursor-pointer hover:bg-muted/50 transition-colors ${
                        selectedFiles.has(file.id) ? 'border-primary bg-primary/5' : ''
                      }`}
                      onClick={() => toggleFile(file.id)}
                    >
                      <Checkbox
                        checked={selectedFiles.has(file.id)}
                        onClick={(e) => e.stopPropagation()}
                        onCheckedChange={() => toggleFile(file.id)}
                      />
                      <FolderOpen className="h-5 w-5 text-muted-foreground flex-shrink-0" />
                      <div className="overflow-hidden flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{file.file_name}</p>
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          {file.folder_name && (
                            <span className="bg-muted px-1.5 py-0.5 rounded">{file.folder_name}</span>
                          )}
                          <span>{file.uploaded_at ? format(new Date(file.uploaded_at), 'MMM d, yyyy') : 'Unknown date'}</span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </ScrollArea>
            ) : (
              <div className="border rounded-md p-8 text-center text-muted-foreground">
                <File className="h-12 w-12 mx-auto mb-3 opacity-50" />
                <p>No PDF documents found in this claim.</p>
                <p className="text-xs mt-1">Upload evidence documents to the claim files first.</p>
              </div>
            )}
          </TabsContent>

          <TabsContent value="photos" className="space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-sm text-muted-foreground">
                {photos.length === 0 ? 'No photos uploaded' : `${photos.length} photos available — selected photos will be sent as images for visual analysis`}
              </p>
              {photos.length > 0 && (
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={selectAllPhotos}>
                    <CheckSquare className="h-4 w-4 mr-1" />
                    Select All
                  </Button>
                  <Button variant="ghost" size="sm" onClick={clearPhotos}>
                    Clear
                  </Button>
                </div>
              )}
            </div>

            {photos.length > 0 ? (
              <ScrollArea className="h-[280px] border rounded-md p-3">
                <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                  {photos.map((photo, idx) => (
                    <div
                      key={photo.id}
                      className={`flex items-center gap-2 p-2 border rounded cursor-pointer hover:bg-muted/50 ${
                        selectedPhotos.has(photo.id) ? 'border-primary bg-primary/5' : ''
                      }`}
                      onClick={() => togglePhoto(photo.id)}
                    >
                      <Checkbox
                        checked={selectedPhotos.has(photo.id)}
                        onClick={(e) => e.stopPropagation()}
                        onCheckedChange={() => togglePhoto(photo.id)}
                      />
                      <Camera className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                      <div className="overflow-hidden flex-1 min-w-0">
                        <p className="text-xs truncate">{photo.file_name || `Photo ${idx + 1}`}</p>
                        {photo.category && (
                          <p className="text-xs text-muted-foreground truncate">{photo.category}</p>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </ScrollArea>
            ) : (
              <div className="border rounded-md p-6 text-center text-muted-foreground">
                <Camera className="h-10 w-10 mx-auto mb-2 opacity-50" />
                <p className="text-sm">No photos uploaded to this claim.</p>
              </div>
            )}
          </TabsContent>
        </Tabs>

        {/* Additional Instructions */}
        <div className="space-y-2">
          <Label>Case Strategy & Instructions (Optional)</Label>
          <Textarea
            placeholder="Provide any specific arguments, case strategy notes, or areas to emphasize in the demand package..."
            value={additionalInstructions}
            onChange={(e) => setAdditionalInstructions(e.target.value)}
            rows={4}
          />
          <p className="text-xs text-muted-foreground">
            Tell Darwin what to focus on, any specific arguments to make, or context that will help build a stronger case.
          </p>
        </div>

        {/* Generate Button */}
        <Button
          onClick={handleGenerate}
          disabled={loading || selectedFiles.size === 0}
          className="w-full"
          size="lg"
        >
          {loading ? (
            <>
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              Analyzing Evidence & Building Restoration Report...
            </>
          ) : (
            <>
              <Briefcase className="h-4 w-4 mr-2" />
              Build Restoration Report ({selectedFiles.size} documents{selectedPhotos.size > 0 ? `, ${selectedPhotos.size} photos` : ''})
            </>
          )}
        </Button>

        {/* Generated Report */}
        {generatedPackage && (
          <div className="space-y-3 border-t pt-4">
            <div className="flex items-center justify-between">
              <Label className="text-base">Generated Restoration Report</Label>
              {lastPackageDate && (
                <span className="text-xs text-muted-foreground">
                  Generated: {format(new Date(lastPackageDate), 'MMM d, yyyy h:mm a')}
                </span>
              )}
            </div>
            
            <div className="h-[400px] overflow-y-auto border rounded-md p-4 bg-muted/30 scroll-smooth restoration-report">
              <pre className="whitespace-pre-wrap text-sm leading-relaxed">{generatedPackage}</pre>
            </div>

            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={copyToClipboard}>
                <Copy className="h-4 w-4 mr-1" />
                Copy
              </Button>
              <Button variant="outline" size="sm" onClick={downloadAsText}>
                <Download className="h-4 w-4 mr-1" />
                Download Text
              </Button>
              <Button variant="outline" size="sm" onClick={saveAsWord}>
                <FileText className="h-4 w-4 mr-1" />
                Save as Word
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
};

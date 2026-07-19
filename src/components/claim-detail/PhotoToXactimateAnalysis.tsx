import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { 
  Camera, 
  Loader2, 
  Sparkles, 
  Image as ImageIcon,
  CheckCircle,
  AlertCircle,
  Calculator,
  Info,
  FileText,
  Upload,
  MapPin,
  Scale,
  BookOpen,
  Gavel
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";

interface ClaimPhoto {
  id: string;
  file_name: string;
  file_path: string;
  category: string | null;
  description: string | null;
  ai_material_type?: string | null;
  ai_condition_rating?: string | null;
  ai_detected_damages?: any;
  ai_analysis_summary?: string | null;
  ai_analyzed_at?: string | null;
}

interface XactimateLineItem {
  category: string;
  subcategory?: string;
  xactimate_code: string;
  description: string;
  unit: string;
  quantity: number;
  unit_price: number;
  regional_adjusted_price?: number;
  total: number;
  justification: string;
  code_citation?: string;
  photo_reference?: string;
  manufacturer_spec?: string;
}

// Format compatible with EnhancedEstimateBuilder
interface EstimateLineItem {
  id: string;
  category: string;
  description: string;
  unit: string;
  quantity: number;
  unitPrice: number;
  total: number;
  xactimateCode?: string;
  justification?: string;
  codeCitation?: string;
  photoReference?: string;
  manufacturerSpec?: string;
}

interface AnalysisResult {
  summary: string;
  total_estimated_rcv: number;
  overhead_profit?: number;
  grand_total?: number;
  line_items: XactimateLineItem[];
  measurement_source?: string;
  measurement_notes?: string;
  additional_items_to_verify?: string[];
  code_compliance_items?: string[];
  advocacy_notes?: string;
}

interface MeasurementReportData {
  reportType?: string;
  totalArea?: string;
  perimeter?: string;
  facetCount?: string;
  pitch?: string;
  stories?: string;
  ridges?: string;
  hips?: string;
  valleys?: string;
  eaves?: string;
  rakes?: string;
  dripEdge?: string;
  starter?: string;
  stepFlashing?: string;
  headwallFlashing?: string;
  pipes?: string;
  wasteFactor?: string;
}

interface PhotoToXactimateAnalysisProps {
  claimId: string;
  onLineItemsGenerated: (items: EstimateLineItem[]) => void;
}

const REGIONS = [
  { code: 'NJ', name: 'New Jersey', multiplier: 1.25 },
  { code: 'PA', name: 'Pennsylvania', multiplier: 1.10 },
  { code: 'NY', name: 'New York', multiplier: 1.35 },
  { code: 'TX', name: 'Texas', multiplier: 0.95 },
  { code: 'FL', name: 'Florida', multiplier: 1.15 },
  { code: 'CO', name: 'Colorado', multiplier: 1.20 },
  { code: 'CA', name: 'California', multiplier: 1.30 },
  { code: 'DEFAULT', name: 'National Average', multiplier: 1.00 },
];

export const PhotoToXactimateAnalysis = ({ claimId, onLineItemsGenerated }: PhotoToXactimateAnalysisProps) => {
  const [photos, setPhotos] = useState<ClaimPhoto[]>([]);
  const [selectedPhotoIds, setSelectedPhotoIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [analyzing, setAnalyzing] = useState(false);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [expandedItems, setExpandedItems] = useState<Set<number>>(new Set());
  
  // Measurement inputs
  const [roofArea, setRoofArea] = useState("");
  const [pitch, setPitch] = useState("");
  const [stories, setStories] = useState("");
  
  // Measurement report upload
  const [measurementFile, setMeasurementFile] = useState<File | null>(null);
  const [parsingReport, setParsingReport] = useState(false);
  const [measurementReportData, setMeasurementReportData] = useState<MeasurementReportData | null>(null);
  
  // Regional pricing
  const [selectedRegion, setSelectedRegion] = useState("NJ");

  useEffect(() => {
    fetchPhotos();
  }, [claimId]);

  const fetchPhotos = async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from("claim_photos")
        .select("id, file_name, file_path, category, description, ai_material_type, ai_condition_rating, ai_detected_damages, ai_analysis_summary, ai_analyzed_at")
        .eq("claim_id", claimId)
        .order("created_at", { ascending: false });
      
      if (error) throw error;
      setPhotos((data || []) as ClaimPhoto[]);
    } catch (error) {
      console.error("Error fetching photos:", error);
      toast.error("Failed to load photos");
    } finally {
      setLoading(false);
    }
  };

  const togglePhoto = (photoId: string) => {
    const newSelected = new Set(selectedPhotoIds);
    if (newSelected.has(photoId)) {
      newSelected.delete(photoId);
    } else {
      newSelected.add(photoId);
    }
    setSelectedPhotoIds(newSelected);
  };

  const selectAll = () => {
    setSelectedPhotoIds(new Set(photos.map(p => p.id)));
  };

  const selectNone = () => {
    setSelectedPhotoIds(new Set());
  };

  const getConditionBadge = (rating: string | null) => {
    if (!rating) return null;
    const variants: Record<string, "default" | "destructive" | "outline" | "secondary"> = {
      excellent: "default",
      good: "default",
      fair: "secondary",
      poor: "outline",
      failed: "destructive",
    };
    return (
      <Badge variant={variants[rating.toLowerCase()] || "secondary"}>
        {rating}
      </Badge>
    );
  };

  const handleMeasurementUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    if (file.type !== "application/pdf") {
      toast.error("Please upload a PDF file (EagleView, Hover, or similar)");
      return;
    }
    
    setMeasurementFile(file);
    setParsingReport(true);
    
    try {
      // Convert PDF to base64 for parsing
      const arrayBuffer = await file.arrayBuffer();
      const base64 = btoa(
        new Uint8Array(arrayBuffer).reduce((data, byte) => data + String.fromCharCode(byte), '')
      );
      
      // Call edge function to parse measurement report
      const { data, error } = await supabase.functions.invoke("darwin-ai-analysis", {
        body: {
          claimId,
          analysisType: "smart_extraction",
          pdfContent: base64,
          pdfFileName: file.name,
          additionalContext: {
            extractionType: "measurement_report",
            expectedFields: [
              "totalArea", "perimeter", "facetCount", "pitch", "stories",
              "ridges", "hips", "valleys", "eaves", "rakes", "dripEdge",
              "starter", "stepFlashing", "headwallFlashing", "pipes", "wasteFactor"
            ]
          }
        }
      });
      
      if (error) throw error;
      
      // Try to parse the extracted data
      if (data?.result) {
        try {
          // Parse JSON from result
          let jsonStr = data.result;
          if (jsonStr.includes("```json")) {
            jsonStr = jsonStr.replace(/```json\n?/g, "").replace(/```\n?/g, "");
          }
          if (jsonStr.includes("```")) {
            jsonStr = jsonStr.replace(/```\n?/g, "");
          }
          
          // Try to find JSON object in the response
          const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            setMeasurementReportData({
              reportType: file.name.includes("EagleView") ? "EagleView" : 
                         file.name.includes("Hover") ? "Hover" : "Roof Measurement Report",
              totalArea: parsed.totalArea || parsed.total_area || parsed.roofArea,
              perimeter: parsed.perimeter,
              facetCount: parsed.facetCount || parsed.facets,
              pitch: parsed.pitch || parsed.predominantPitch,
              stories: parsed.stories,
              ridges: parsed.ridges || parsed.ridgeLength,
              hips: parsed.hips || parsed.hipLength,
              valleys: parsed.valleys || parsed.valleyLength,
              eaves: parsed.eaves || parsed.eaveLength,
              rakes: parsed.rakes || parsed.rakeLength,
              dripEdge: parsed.dripEdge || parsed.drip_edge,
              starter: parsed.starter || parsed.starterStrip,
              stepFlashing: parsed.stepFlashing || parsed.step_flashing,
              headwallFlashing: parsed.headwallFlashing || parsed.headwall_flashing,
              pipes: parsed.pipes || parsed.penetrations,
              wasteFactor: parsed.wasteFactor || parsed.waste_factor || "15%"
            });
            toast.success("Measurement report parsed successfully");
          } else {
            // Use text extraction as fallback
            setMeasurementReportData({
              reportType: "Roof Measurement Report",
            });
            toast.success("Report uploaded - manual measurements may be needed");
          }
        } catch (parseError) {
          console.error("Failed to parse measurement data:", parseError);
          toast.warning("Could not extract structured data - using manual inputs");
        }
      }
    } catch (error: any) {
      console.error("Error parsing measurement report:", error);
      toast.error("Failed to parse measurement report");
    } finally {
      setParsingReport(false);
    }
  };

  const analyzePhotos = async () => {
    if (selectedPhotoIds.size === 0) {
      toast.error("Please select at least one photo");
      return;
    }

    setAnalyzing(true);
    setResult(null);

    try {
      // Get signed URLs for selected photos
      const selectedPhotos = photos.filter(p => selectedPhotoIds.has(p.id));
      const photoUrls: string[] = [];
      const photoDescriptions: string[] = [];
      const existingAnalysis: any[] = [];

      for (const photo of selectedPhotos) {
        const { data: signedUrlData } = await supabase.storage
          .from("claim-files")
          .createSignedUrl(photo.file_path, 3600);
        
        if (signedUrlData?.signedUrl) {
          photoUrls.push(signedUrlData.signedUrl);
          photoDescriptions.push(photo.description || "");
          
          if (photo.ai_material_type || photo.ai_condition_rating) {
            existingAnalysis.push({
              file_name: photo.file_name,
              ai_material_type: photo.ai_material_type,
              ai_condition_rating: photo.ai_condition_rating,
              ai_detected_damages: photo.ai_detected_damages,
              ai_analysis_summary: photo.ai_analysis_summary,
            });
          }
        }
      }

      if (photoUrls.length === 0) {
        toast.error("Could not access photo files");
        return;
      }

      // Build measurement data
      const measurementData = (roofArea || pitch || stories) ? {
        roofArea: roofArea || null,
        pitch: pitch || null,
        stories: stories || null,
      } : null;

      // Call the darwin-ai-analysis function with enhanced parameters
      const { data, error } = await supabase.functions.invoke("darwin-ai-analysis", {
        body: {
          claimId,
          analysisType: "photo_to_xactimate",
          additionalContext: {
            photoUrls,
            photoDescriptions,
            existingAnalysis,
            measurementData,
            measurementReportData,
            pricingRegion: selectedRegion,
          },
        },
      });

      if (error) throw error;

      // Parse the result
      let analysisResult: AnalysisResult | null = null;
      
      if (data?.result) {
        try {
          // Try to parse JSON from the result
          let jsonStr = data.result;
          if (jsonStr.includes("```json")) {
            jsonStr = jsonStr.replace(/```json\n?/g, "").replace(/```\n?/g, "");
          }
          if (jsonStr.includes("```")) {
            jsonStr = jsonStr.replace(/```\n?/g, "");
          }
          analysisResult = JSON.parse(jsonStr.trim());
        } catch (parseError) {
          console.error("Failed to parse analysis result:", parseError);
          toast.error("Could not parse line items - please try again");
          return;
        }
      }

      if (analysisResult) {
        setResult(analysisResult);
        toast.success(`Generated ${analysisResult.line_items?.length || 0} Xactimate line items in Advocacy Mode`);
      }

    } catch (error: any) {
      console.error("Error analyzing photos:", error);
      toast.error(error.message || "Failed to analyze photos");
    } finally {
      setAnalyzing(false);
    }
  };

  const applyLineItems = () => {
    if (result?.line_items) {
      // Convert to the format expected by EnhancedEstimateBuilder
      const items: EstimateLineItem[] = result.line_items.map((item, idx) => ({
        id: `photo-${Date.now()}-${idx}`,
        category: item.category,
        description: item.description,
        xactimateCode: item.xactimate_code,
        unit: item.unit,
        quantity: item.quantity,
        unitPrice: item.regional_adjusted_price || item.unit_price,
        total: item.total,
        justification: item.justification,
        codeCitation: item.code_citation,
        photoReference: item.photo_reference,
        manufacturerSpec: item.manufacturer_spec,
      }));
      onLineItemsGenerated(items);
      toast.success(`Applied ${items.length} line items to estimate`);
    }
  };

  const toggleItemExpanded = (idx: number) => {
    const newExpanded = new Set(expandedItems);
    if (newExpanded.has(idx)) {
      newExpanded.delete(idx);
    } else {
      newExpanded.add(idx);
    }
    setExpandedItems(newExpanded);
  };

  const selectedRegionInfo = REGIONS.find(r => r.code === selectedRegion);

  if (loading) {
    return (
      <div className="flex items-center justify-center p-8">
        <Loader2 className="h-6 w-6 animate-spin mr-2" />
        Loading photos...
      </div>
    );
  }

  if (photos.length === 0) {
    return (
      <div className="text-center p-8 text-muted-foreground">
        <Camera className="h-12 w-12 mx-auto mb-4 opacity-50" />
        <p>No photos uploaded for this claim</p>
        <p className="text-sm">Upload photos in the Photos tab first</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Advocacy Mode Header */}
      <div className="bg-primary/10 border border-primary/30 rounded-lg p-3">
        <div className="flex items-center gap-2 text-primary font-semibold">
          <Scale className="h-4 w-4" />
          ADVOCACY MODE ACTIVE
        </div>
        <p className="text-xs text-muted-foreground mt-1">
          Maximum line item depth with code citations, manufacturer specs, and regional pricing
        </p>
      </div>

      {/* Photo Selection */}
      <Card>
        <CardHeader className="py-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm flex items-center gap-2">
              <Camera className="h-4 w-4" />
              Select Photos ({selectedPhotoIds.size} of {photos.length})
            </CardTitle>
            <div className="flex gap-2">
              <Button variant="ghost" size="sm" onClick={selectAll}>All</Button>
              <Button variant="ghost" size="sm" onClick={selectNone}>None</Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="pt-0">
          <ScrollArea className="h-[180px]">
            <div className="grid grid-cols-2 gap-2">
              {photos.map((photo) => (
                <div
                  key={photo.id}
                  onClick={() => togglePhoto(photo.id)}
                  className={`flex items-start gap-2 p-2 rounded-md cursor-pointer transition-colors ${
                    selectedPhotoIds.has(photo.id) 
                      ? "bg-primary/10 border border-primary/30" 
                      : "bg-muted/50 hover:bg-muted"
                  }`}
                >
                  <Checkbox
                    checked={selectedPhotoIds.has(photo.id)}
                    onCheckedChange={() => togglePhoto(photo.id)}
                    className="mt-0.5"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1">
                      <ImageIcon className="h-3 w-3 text-muted-foreground flex-shrink-0" />
                      <span className="text-xs font-medium truncate">{photo.file_name}</span>
                    </div>
                    <div className="flex items-center gap-1 mt-1">
                      {photo.ai_condition_rating && getConditionBadge(photo.ai_condition_rating)}
                      {photo.ai_material_type && (
                        <span className="text-xs text-muted-foreground truncate">
                          {photo.ai_material_type}
                        </span>
                      )}
                    </div>
                  </div>
                  {photo.ai_analysis_summary && (
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger>
                          <CheckCircle className="h-4 w-4 text-primary flex-shrink-0" />
                        </TooltipTrigger>
                        <TooltipContent>
                          <p className="max-w-xs text-xs">{photo.ai_analysis_summary}</p>
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  )}
                </div>
              ))}
            </div>
          </ScrollArea>
        </CardContent>
      </Card>

      {/* Measurement Report Upload */}
      <Card>
        <CardHeader className="py-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <FileText className="h-4 w-4" />
            Measurement Report (EagleView/Hover)
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0 space-y-3">
          <div className="flex items-center gap-2">
            <Input
              type="file"
              accept=".pdf"
              onChange={handleMeasurementUpload}
              className="flex-1"
              disabled={parsingReport}
            />
            {parsingReport && <Loader2 className="h-4 w-4 animate-spin" />}
          </div>
          
          {measurementReportData && (
            <div className="p-2 bg-primary/10 border border-primary/30 rounded-md">
              <div className="flex items-center gap-2 text-primary text-sm font-medium">
                <CheckCircle className="h-4 w-4" />
                {measurementReportData.reportType} Parsed
              </div>
              <div className="grid grid-cols-3 gap-2 mt-2 text-xs">
                {measurementReportData.totalArea && (
                  <div><span className="text-muted-foreground">Area:</span> {measurementReportData.totalArea} SQ</div>
                )}
                {measurementReportData.pitch && (
                  <div><span className="text-muted-foreground">Pitch:</span> {measurementReportData.pitch}</div>
                )}
                {measurementReportData.ridges && (
                  <div><span className="text-muted-foreground">Ridge:</span> {measurementReportData.ridges} LF</div>
                )}
                {measurementReportData.valleys && (
                  <div><span className="text-muted-foreground">Valley:</span> {measurementReportData.valleys} LF</div>
                )}
                {measurementReportData.eaves && (
                  <div><span className="text-muted-foreground">Eave:</span> {measurementReportData.eaves} LF</div>
                )}
                {measurementReportData.pipes && (
                  <div><span className="text-muted-foreground">Pipes:</span> {measurementReportData.pipes} EA</div>
                )}
              </div>
            </div>
          )}

          {!measurementReportData && (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <Label className="text-xs">Roof Area (SQ)</Label>
                <Input
                  type="number"
                  placeholder="e.g., 25"
                  value={roofArea}
                  onChange={(e) => setRoofArea(e.target.value)}
                  className="h-8"
                />
              </div>
              <div>
                <Label className="text-xs">Pitch</Label>
                <Input
                  placeholder="e.g., 6/12"
                  value={pitch}
                  onChange={(e) => setPitch(e.target.value)}
                  className="h-8"
                />
              </div>
              <div>
                <Label className="text-xs">Stories</Label>
                <Input
                  type="number"
                  placeholder="e.g., 2"
                  value={stories}
                  onChange={(e) => setStories(e.target.value)}
                  className="h-8"
                />
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Regional Pricing */}
      <Card>
        <CardHeader className="py-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <MapPin className="h-4 w-4" />
            Regional Pricing
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <div className="flex items-center gap-3">
            <Select value={selectedRegion} onValueChange={setSelectedRegion}>
              <SelectTrigger className="w-[200px] h-8">
                <SelectValue placeholder="Select region" />
              </SelectTrigger>
              <SelectContent>
                {REGIONS.map((region) => (
                  <SelectItem key={region.code} value={region.code}>
                    {region.name} ({region.multiplier}x)
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {selectedRegionInfo && (
              <span className="text-xs text-muted-foreground">
                {selectedRegionInfo.multiplier}x pricing multiplier applied
              </span>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Analyze Button */}
      <Button
        onClick={analyzePhotos}
        disabled={analyzing || selectedPhotoIds.size === 0}
        className="w-full gap-2"
        size="lg"
      >
        {analyzing ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" />
            Generating Advocacy Estimate from {selectedPhotoIds.size} photos...
          </>
        ) : (
          <>
            <Sparkles className="h-4 w-4" />
            Generate Xactimate Estimate (Advocacy Mode)
          </>
        )}
      </Button>

      {/* Results */}
      {result && (
        <Card className="border-primary/30">
          <CardHeader className="py-3 bg-primary/5">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm flex items-center gap-2">
                <CheckCircle className="h-4 w-4 text-primary" />
                Advocacy Estimate Complete
              </CardTitle>
              <div className="flex items-center gap-2">
                {result.overhead_profit && result.overhead_profit > 0 && (
                  <Badge variant="outline" className="text-xs">
                    O&P: ${result.overhead_profit.toLocaleString()}
                  </Badge>
                )}
                <Badge variant="default" className="text-sm">
                  ${(result.grand_total || result.total_estimated_rcv)?.toLocaleString()} RCV
                </Badge>
              </div>
            </div>
          </CardHeader>
          <CardContent className="pt-4 space-y-4">
            <p className="text-sm text-muted-foreground">{result.summary}</p>
            
            {/* Code Compliance Items */}
            {result.code_compliance_items && result.code_compliance_items.length > 0 && (
              <div className="p-2 bg-secondary/50 border border-secondary rounded text-xs">
                <div className="flex items-center gap-2 font-medium text-secondary-foreground mb-1">
                  <Gavel className="h-3 w-3" />
                  Code Compliance Items Included
                </div>
                <ul className="list-disc list-inside text-muted-foreground">
                  {result.code_compliance_items.map((item, idx) => (
                    <li key={idx}>{item}</li>
                  ))}
                </ul>
              </div>
            )}

            {/* Line Items */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">
                  {result.line_items?.length || 0} Line Items Generated
                </span>
                <Button size="sm" onClick={applyLineItems} className="gap-1">
                  <Calculator className="h-3 w-3" />
                  Apply to Estimate
                </Button>
              </div>
              
              <ScrollArea className="h-[280px] border rounded-md">
                <div className="p-2 space-y-2">
                  {result.line_items?.map((item, idx) => (
                    <Collapsible key={idx} open={expandedItems.has(idx)} onOpenChange={() => toggleItemExpanded(idx)}>
                      <div className="p-2 bg-muted/50 rounded text-xs space-y-1">
                        <CollapsibleTrigger className="w-full">
                          <div className="flex items-center justify-between cursor-pointer">
                            <div className="flex items-center gap-2">
                              <Badge variant="outline" className="text-xs">{item.xactimate_code}</Badge>
                              <span className="font-medium text-left">{item.description}</span>
                            </div>
                            <span className="font-bold">${item.total?.toFixed(2)}</span>
                          </div>
                        </CollapsibleTrigger>
                        <div className="flex items-center gap-2 text-muted-foreground">
                          <Badge variant="secondary" className="text-xs">{item.category}</Badge>
                          <span>{item.quantity} {item.unit} @ ${(item.regional_adjusted_price || item.unit_price)?.toFixed(2)}</span>
                        </div>
                        
                        <CollapsibleContent className="pt-2 space-y-1 border-t border-border/50 mt-2">
                          <p className="text-muted-foreground">{item.justification}</p>
                          
                          {item.code_citation && (
                            <div className="flex items-start gap-1 text-secondary-foreground">
                              <BookOpen className="h-3 w-3 mt-0.5 flex-shrink-0" />
                              <span>{item.code_citation}</span>
                            </div>
                          )}
                          
                          {item.manufacturer_spec && (
                            <div className="flex items-start gap-1 text-primary">
                              <FileText className="h-3 w-3 mt-0.5 flex-shrink-0" />
                              <span>{item.manufacturer_spec}</span>
                            </div>
                          )}
                          
                          {item.photo_reference && (
                            <div className="flex items-start gap-1 text-muted-foreground">
                              <Camera className="h-3 w-3 mt-0.5 flex-shrink-0" />
                              <span>{item.photo_reference}</span>
                            </div>
                          )}
                        </CollapsibleContent>
                      </div>
                    </Collapsible>
                  ))}
                </div>
              </ScrollArea>
            </div>

            {/* Advocacy Notes */}
            {result.advocacy_notes && (
              <div className="p-2 bg-accent/50 border border-accent rounded text-xs">
                <div className="flex items-start gap-2">
                  <Scale className="h-4 w-4 text-accent-foreground mt-0.5" />
                  <div>
                    <span className="font-medium text-accent-foreground">Advocacy Notes:</span>
                    <p className="text-muted-foreground mt-1">{result.advocacy_notes}</p>
                  </div>
                </div>
              </div>
            )}

            {result.measurement_notes && (
              <div className="p-2 bg-accent/50 border border-accent rounded text-xs">
                <div className="flex items-start gap-2">
                  <AlertCircle className="h-4 w-4 text-accent-foreground mt-0.5" />
                  <div>
                    <span className="font-medium">Measurement Notes:</span>
                    <p className="text-muted-foreground">{result.measurement_notes}</p>
                  </div>
                </div>
              </div>
            )}

            {result.additional_items_to_verify && result.additional_items_to_verify.length > 0 && (
              <div className="p-2 bg-muted border border-border rounded text-xs">
                <span className="font-medium">Items to Verify On-Site:</span>
                <ul className="list-disc list-inside text-muted-foreground mt-1">
                  {result.additional_items_to_verify.map((item, idx) => (
                    <li key={idx}>{item}</li>
                  ))}
                </ul>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
};

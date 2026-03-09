import { useState, useEffect, useRef, memo } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { FileText, Download, Grid, Columns, Sparkles, Loader2, Cloud, Wind, Droplets, Thermometer, File, FolderOpen, Image, Brain } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { htmlElementToPdf } from "@/utils/htmlToPdf";
import { DarwinCitationWatchdog } from "./DarwinCitationWatchdog";

interface ClaimPhoto {
  id: string;
  claim_id: string;
  file_path: string;
  file_name: string;
  category: string;
  description: string | null;
  annotated_file_path: string | null;
  before_after_type: string | null;
  before_after_pair_id: string | null;
  // AI analysis fields
  ai_condition_rating?: string | null;
  ai_condition_notes?: string | null;
  ai_detected_damages?: any;
  ai_material_type?: string | null;
  ai_analysis_summary?: string | null;
  ai_analyzed_at?: string | null;
}

interface SupportingDocument {
  id: string;
  file_name: string;
  file_path: string;
  file_type: string | null;
}

interface PhotoReportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  photos: ClaimPhoto[];
  claim: any;
  claimId: string;
}

const AI_REPORT_TYPES = [
  { 
    id: "full-report", 
    name: "Forensic Photo Report", 
    description: "Comprehensive forensic analysis with damage assessment and restoration requirements" 
  },
  { 
    id: "damage-assessment", 
    name: "Damage Assessment", 
    description: "Focused analysis of visible damage with severity ratings and repair scope" 
  },
  { 
    id: "before-after", 
    name: "Before/After Analysis", 
    description: "Compare before and after photos to document repairs" 
  },
  { 
    id: "quick-analysis", 
    name: "Quick Summary", 
    description: "Brief overview of damage for quick reference" 
  },
];

export function PhotoReportDialog({ open, onOpenChange, photos, claim, claimId }: PhotoReportDialogProps) {
  const [reportTitle, setReportTitle] = useState("");
  const [reportType, setReportType] = useState<"grid" | "before-after" | "detailed">("grid");
  const [selectedPhotos, setSelectedPhotos] = useState<string[]>([]);
  const [includeDescriptions, setIncludeDescriptions] = useState(true);
  const [includeCategories, setIncludeCategories] = useState(true);
  const [includeAIAnalysis, setIncludeAIAnalysis] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [activeTab, setActiveTab] = useState<"standard" | "ai">("ai");
  const [aiReportType, setAiReportType] = useState("demand-package");
  const [companyBranding, setCompanyBranding] = useState<{ company_name?: string; letterhead_url?: string } | null>(null);
  
  // Supporting documents state
  const [supportingDocs, setSupportingDocs] = useState<SupportingDocument[]>([]);
  const [selectedDocs, setSelectedDocs] = useState<string[]>([]);
  const [loadingDocs, setLoadingDocs] = useState(false);

  useEffect(() => {
    const fetchBranding = async () => {
      const { data } = await supabase
        .from("company_branding" as any)
        .select("company_name, letterhead_url")
        .limit(1)
        .maybeSingle();
      if (data) setCompanyBranding(data as any);
    };
    fetchBranding();
  }, []);

  // Fetch supporting documents when dialog opens
  useEffect(() => {
    const fetchSupportingDocs = async () => {
      if (!open || !claimId) return;
      
      setLoadingDocs(true);
      try {
        // Find the Supporting Evidence folder
        const { data: folders } = await supabase
          .from("claim_folders")
          .select("id")
          .eq("claim_id", claimId)
          .eq("name", "Supporting Evidence")
          .maybeSingle();
        
        if (folders?.id) {
          // Fetch files from this folder
          const { data: files } = await supabase
            .from("claim_files")
            .select("id, file_name, file_path, file_type")
            .eq("claim_id", claimId)
            .eq("folder_id", folders.id);
          
          if (files) {
            setSupportingDocs(files);
          }
        }
      } catch (error) {
        console.error("Error fetching supporting docs:", error);
      } finally {
        setLoadingDocs(false);
      }
    };
    
    fetchSupportingDocs();
  }, [open, claimId]);

  const [aiReport, setAiReport] = useState<string | null>(null);
  const [aiPhotoUrls, setAiPhotoUrls] = useState<{ url: string; fileName: string; category: string; description: string; photoNumber: number }[]>([]);
  const [aiReferencedPhotos, setAiReferencedPhotos] = useState<{ url: string; fileName: string; category: string; description: string; photoNumber: number; aiContext: string }[]>([]);
  const [aiSupportingDocs, setAiSupportingDocs] = useState<{ name: string; url: string }[]>([]);
  const [weatherData, setWeatherData] = useState<any>(null);
  const [previewingWeather, setPreviewingWeather] = useState(false);
  const [currentJobId, setCurrentJobId] = useState<string | null>(null);
  const [pollingForResult, setPollingForResult] = useState(false);
  const [generatingReferencedPdf, setGeneratingReferencedPdf] = useState(false);
  const [citationWatchdog, setCitationWatchdog] = useState<any>(null);
  const [jurisdictionInfo, setJurisdictionInfo] = useState<any>(null);
  const { toast } = useToast();

  // Check for recently completed photo reports when dialog opens
  useEffect(() => {
    const checkForRecentReport = async () => {
      if (!open || !claimId) return;
      
      // Check if there's a recent photo report (within last 10 minutes)
      const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      const { data: recentReport } = await supabase
        .from("darwin_analysis_results")
        .select("*")
        .eq("claim_id", claimId)
        .like("analysis_type", "photo_report_%")
        .gte("created_at", tenMinutesAgo)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      
      if (recentReport && !aiReport) {
        toast({
          title: "Previous report found",
          description: "A recently generated report was found. View it in Darwin tab or generate a new one.",
        });
      }
    };
    
    checkForRecentReport();
  }, [open, claimId]);

  useEffect(() => {
    if (open) {
      setReportTitle(`Photo Report - ${claim?.policyholder_name || "Claim"} - ${new Date().toLocaleDateString()}`);
      setSelectedPhotos(photos.map(p => p.id));
      setSelectedDocs([]);
      setAiReport(null);
      setAiPhotoUrls([]);
      setAiReferencedPhotos([]);
      setAiSupportingDocs([]);
      setWeatherData(null);
      setPreviewingWeather(false);
      setCurrentJobId(null);
      setPollingForResult(false);
      setGeneratingReferencedPdf(false);
    }
  }, [open, claim, photos]);

  const previewWeather = async () => {
    setPreviewingWeather(true);
    try {
      const { data, error } = await supabase.functions.invoke("analyze-photos", {
        body: { claimId, weatherOnly: true },
      });
      
      if (error) throw error;
      if (data.error) throw new Error(data.error);
      
      setWeatherData(data.weatherData);
      if (!data.weatherData) {
        toast({ title: "No weather data available", description: "Could not find weather data for this claim's address/date", variant: "destructive" });
      }
    } catch (error: any) {
      console.error("Weather preview error:", error);
      toast({ title: "Error fetching weather", description: error.message, variant: "destructive" });
    } finally {
      setPreviewingWeather(false);
    }
  };

  const togglePhoto = (photoId: string) => {
    setSelectedPhotos(prev =>
      prev.includes(photoId)
        ? prev.filter(id => id !== photoId)
        : [...prev, photoId]
    );
  };

  const selectAll = () => setSelectedPhotos(photos.map(p => p.id));
  const selectNone = () => setSelectedPhotos([]);

  const toggleDoc = (docId: string) => {
    setSelectedDocs(prev =>
      prev.includes(docId)
        ? prev.filter(id => id !== docId)
        : [...prev, docId]
    );
  };

  const selectAllDocs = () => setSelectedDocs(supportingDocs.map(d => d.id));
  const clearDocs = () => setSelectedDocs([]);

  const generateAIReport = async () => {
    if (selectedPhotos.length === 0) {
      toast({ title: "Please select at least one photo", variant: "destructive" });
      return;
    }

    // Warn if more than 30 photos selected
    if (selectedPhotos.length > 30) {
      toast({ 
        title: "Photo limit exceeded", 
        description: "Only the first 30 photos will be analyzed to prevent timeout. Select fewer photos for best results.",
        variant: "destructive" 
      });
    }

    setGenerating(true);
    setAiReport(null);
    
    // Inform user to stay on page
    toast({ 
      title: "Generating report...", 
      description: "This may take 2-3 minutes. Please stay on this page until complete.",
    });
    
    try {
      // Use fetch directly with extended timeout for large photo batches (10 minutes)
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 600000); // 10 minute timeout
      
      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/analyze-photos`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}`,
          },
          body: JSON.stringify({
            photoIds: selectedPhotos,
            claimId,
            reportType: aiReportType,
            documentIds: aiReportType === 'demand-package' ? selectedDocs : [],
          }),
          signal: controller.signal,
        }
      );
      
      clearTimeout(timeoutId);
      
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `Request failed with status ${response.status}`);
      }
      
      const data = await response.json();
      
      if (data.error) {
        throw new Error(data.error);
      }

      setAiReport(data.report);
      setAiPhotoUrls(data.photoUrls || []);
      setAiReferencedPhotos(data.referencedPhotos || []);
      setAiSupportingDocs(data.supportingDocs || []);
      setWeatherData(data.weatherData || null);
      if (data.citation_watchdog) {
        setCitationWatchdog(data.citation_watchdog);
      }
      if (data.jurisdiction) {
        setJurisdictionInfo(data.jurisdiction);
      }
      if (data.jobId) {
        setCurrentJobId(data.jobId);
      }
      
      // Notify — watchdog warnings take priority
      if (data.citation_watchdog) {
        toast({ 
          title: "⚠️ Wrong-State Citations Detected", 
          description: `${data.citation_watchdog.wrong_state_citations_found} citation(s) from the wrong state found. Review the report carefully before sending.`,
          variant: "destructive",
        });
      } else if (data.referencedPhotos?.length > 0) {
        toast({ 
          title: "Analysis complete", 
          description: `AI cited ${data.referencedPhotos.length} photos in the report. You can download a PDF with just those photos.`
        });
      } else if (data.wasLimited) {
        toast({ 
          title: "Analysis complete", 
          description: `Analyzed ${data.photoCount} of ${data.originalPhotoCount} photos (limited to prevent timeout)`
        });
      } else {
        toast({ title: "Analysis complete" });
      }
    } catch (error: any) {
      console.error("AI report error:", error);
      if (error.name === 'AbortError' || error.message?.includes('connection') || error.message?.includes('Failed to fetch') || error.name === 'TypeError') {
        // Connection issue - start polling for completed report
        setPollingForResult(true);
        toast({ 
          title: "Connection interrupted", 
          description: "Checking for completed report in background...",
        });
        pollForResult();
      } else {
        toast({ 
          title: "Error generating AI report", 
          description: error.message || "Please try again",
          variant: "destructive" 
        });
      }
    } finally {
      setGenerating(false);
    }
  };

  const pollForResult = async () => {
    // Check for recently completed photo reports
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    
    for (let i = 0; i < 20; i++) { // Poll for up to ~2 minutes
      await new Promise(resolve => setTimeout(resolve, 6000)); // Wait 6 seconds
      
      const { data: recentReport } = await supabase
        .from("darwin_analysis_results")
        .select("*")
        .eq("claim_id", claimId)
        .like("analysis_type", "photo_report_%")
        .gte("created_at", fiveMinutesAgo)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      
      if (recentReport) {
        setAiReport(recentReport.result);
        setPollingForResult(false);
        toast({ title: "Report retrieved!", description: "Your report completed successfully." });
        return;
      }
    }
    
    setPollingForResult(false);
    toast({ 
      title: "Report may still be processing", 
      description: "Check the Darwin tab later for completed reports.",
      variant: "destructive" 
    });
  };

  const checkForCompletedReport = async () => {
    setPollingForResult(true);
    toast({ title: "Checking for completed reports..." });
    
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const { data: recentReport } = await supabase
      .from("darwin_analysis_results")
      .select("*")
      .eq("claim_id", claimId)
      .like("analysis_type", "photo_report_%")
      .gte("created_at", tenMinutesAgo)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    
    setPollingForResult(false);
    
    if (recentReport) {
      setAiReport(recentReport.result);
      toast({ title: "Report found!", description: "Loaded the most recent report." });
    } else {
      toast({ 
        title: "No recent reports found", 
        description: "No reports completed in the last 10 minutes.",
        variant: "destructive" 
      });
    }
  };

  const saveAIReport = async () => {
    if (!aiReport) return;
    
    try {
      toast({ title: "Generating Word document..." });
      
      // Call the backend to generate Word document
      const { data, error } = await supabase.functions.invoke("generate-photo-report-docx", {
        body: {
          reportContent: aiReport,
          claimId,
          reportTitle,
          reportType: aiReportType,
          photoUrls: aiPhotoUrls,
          weatherData,
          companyBranding,
        },
      });

      if (error) throw error;
      if (data.error) throw new Error(data.error);

      // Download the Word document
      if (data.downloadUrl) {
        const a = document.createElement("a");
        a.href = data.downloadUrl;
        a.download = data.fileName || `${reportTitle.replace(/[^a-z0-9]/gi, "_")}.docx`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      }

      toast({ title: "Word document saved to claim files and downloaded" });
      onOpenChange(false);
    } catch (error: any) {
      console.error("Error saving report:", error);
      toast({ 
        title: "Error saving report", 
        description: error.message || "Please try again",
        variant: "destructive" 
      });
    }
  };

  // Generate PDF with AI-referenced photos and their AI context
  const generateReferencedPhotoPdf = async () => {
    if (aiReferencedPhotos.length === 0) {
      toast({ title: "No AI-referenced photos available", variant: "destructive" });
      return;
    }

    setGeneratingReferencedPdf(true);
    try {
      toast({ title: "Generating AI-referenced photo PDF..." });
      
      // Call edge function to generate HTML with AI context
      const { data, error } = await supabase.functions.invoke("generate-photo-report-pdf", {
        body: {
          claimId,
          reportTitle: `${reportTitle} - AI Referenced Photos`,
          photoUrls: aiReferencedPhotos,
          companyBranding,
          includeAiContext: true, // Flag to include AI analysis snippets
        },
      });

      if (error) throw error;
      if (data.error) throw new Error(data.error);

      // Use jsPDF + html2canvas to convert HTML to PDF on client side
      const container = document.createElement("div");
      container.innerHTML = data.html;
      document.body.appendChild(container);

      try {
        await htmlElementToPdf(container, {
          filename: `${reportTitle.replace(/[^a-z0-9]/gi, "_")}_ai_referenced.pdf`,
          margin: 0,
          format: "letter",
          orientation: "portrait",
          imageQuality: 0.85,
        });
      } finally {
        document.body.removeChild(container);
      }

      toast({ title: "AI-referenced photo PDF generated successfully" });
    } catch (error: any) {
      console.error("Referenced photo PDF error:", error);
      toast({ 
        title: "Error generating referenced photo PDF", 
        description: error.message || "Please try again",
        variant: "destructive" 
      });
    } finally {
      setGeneratingReferencedPdf(false);
    }
  };

  const generatePhotoDocx = async () => {
    if (selectedPhotos.length === 0) {
      toast({ title: "Please select at least one photo", variant: "destructive" });
      return;
    }

    setGenerating(true);
    try {
      toast({ title: "Generating Word document with photos..." });
      
      const selectedPhotoData = photos.filter(p => selectedPhotos.includes(p.id));
      
      // Fetch claim data for header
      const { data: claimData } = await supabase
        .from("claims")
        .select("claim_number, policyholder_name, policyholder_address, loss_date")
        .eq("id", claimId)
        .single();

      // Convert all photos to base64 first
      const BATCH_SIZE = 8;
      const photoEntries: { 
        base64: string; fileName: string; category: string; description: string; photoNumber: number;
        aiAnalysis?: { material_type: string | null; condition_rating: string | null; condition_notes: string | null; detected_damages: any; summary: string | null; } | null;
      }[] = [];
      
      for (let i = 0; i < selectedPhotoData.length; i += BATCH_SIZE) {
        const batch = selectedPhotoData.slice(i, i + BATCH_SIZE);
        toast({ title: `Processing photos ${i + 1}-${Math.min(i + BATCH_SIZE, selectedPhotoData.length)} of ${selectedPhotoData.length}...` });
        const batchResults = await Promise.all(
          batch.map(async (photo, batchIdx) => {
            const path = photo.annotated_file_path || photo.file_path;
            const { data } = await supabase.storage.from("claim-files").createSignedUrl(path, 3600);
            let base64 = "";
            if (data?.signedUrl) {
              try {
                const response = await fetch(data.signedUrl);
                const blob = await response.blob();
                base64 = await new Promise<string>((resolve) => {
                  const reader = new FileReader();
                  reader.onloadend = () => resolve(reader.result as string);
                  reader.readAsDataURL(blob);
                });
              } catch (e) {
                console.warn("Could not fetch photo:", photo.file_name, e);
              }
            }
            return {
              base64,
              fileName: photo.file_name,
              category: photo.category || "General",
              description: photo.description || "",
              photoNumber: i + batchIdx + 1,
              aiAnalysis: includeAIAnalysis && photo.ai_analyzed_at ? {
                material_type: photo.ai_material_type || null,
                condition_rating: photo.ai_condition_rating || null,
                condition_notes: photo.ai_condition_notes || null,
                detected_damages: photo.ai_detected_damages || [],
                summary: photo.ai_analysis_summary || null,
              } : null,
            };
          })
        );
        photoEntries.push(...batchResults);
      }

      const esc = (s: string | null | undefined) => (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const reportDate = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
      const companyName = esc(companyBranding?.company_name || 'Freedom Adjustment');

      // Build photo cards HTML with base64 images directly
      const photoCardsHtml = photoEntries.map((photo, idx) => {
        let aiHtml = '';
        if (photo.aiAnalysis) {
          const a = photo.aiAnalysis;
          const topDamages = (a.detected_damages || []).slice(0, 3);
          aiHtml = `<div style="margin-top:8px;padding:10px;background:#f8fbff;border:1px solid #d4e5f7;border-left:3px solid #1976d2;border-radius:4px;">
            <div style="font-size:11px;font-weight:600;color:#1565c0;text-transform:uppercase;margin-bottom:6px;padding-bottom:4px;border-bottom:1px solid #e3f2fd;">Damage Assessment</div>
            ${a.material_type ? `<div style="font-size:11px;"><b>Material:</b> ${esc(a.material_type)}</div>` : ''}
            
            ${topDamages.length > 0 ? `<div style="margin-top:6px;"><div style="font-size:10px;font-weight:600;color:#c62828;">Detected Damages:</div>${topDamages.map((d: any) => `<div style="padding:3px 6px;margin:2px 0;background:#fff5f5;border:1px solid #ffcdd2;border-radius:4px;font-size:10px;"><b style="color:#c62828;">${esc(d.type)}</b> - ${esc(d.severity || 'N/A')}${d.location ? ` at ${esc(d.location)}` : ''}</div>`).join('')}</div>` : ''}
            ${a.summary ? `<div style="margin-top:6px;padding:6px;background:#e3f2fd;border-radius:4px;font-size:11px;font-style:italic;color:#1565c0;">${esc(a.summary)}</div>` : ''}
          </div>`;
        }

        return `${idx > 0 ? '<br clear="all" style="page-break-before:always;">' : ''}
          <div style="page-break-inside:avoid;padding:10px 0;">
            <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid #eee;">
              <span style="font-weight:600;color:#1e3a5f;font-size:14px;">Photo ${photo.photoNumber}</span>
              <span style="font-size:11px;padding:3px 8px;background:#e3f2fd;color:#1976d2;border-radius:10px;">${esc(photo.category)}</span>
            </div>
            <div style="padding:10px 0;text-align:center;">
              ${photo.base64 ? `<img src="${photo.base64}" alt="Photo ${photo.photoNumber}" width="480" height="384" style="width:5in;height:4in;object-fit:contain;" />` : '<p style="color:#999;">[Photo could not be loaded]</p>'}
            </div>
            <div style="padding:4px 0;">
              <div style="font-weight:500;font-size:12px;">${esc(photo.fileName)}</div>
              ${photo.description ? `<div style="font-size:12px;color:#666;">${esc(photo.description)}</div>` : ''}
              ${aiHtml}
            </div>
          </div>`;
      }).join('');

      const wordHtml = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
<head><meta charset="UTF-8"><!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View><w:Zoom>100</w:Zoom><w:DoNotOptimizeForBrowser/></w:WordDocument></xml><![endif]-->
<style>@page { size: 8.5in 11in; margin: 0.5in; } body { font-family: Calibri, sans-serif; }</style>
</head><body>
<div style="background:linear-gradient(135deg,#1e3a5f,#2d5a87);color:white;padding:30px;text-align:center;">
  <div style="font-size:16px;opacity:0.9;">${companyName}</div>
  <h1 style="font-size:24px;margin:8px 0;">${esc(reportTitle)}</h1>
  <div style="font-size:13px;opacity:0.8;">${reportDate}</div>
</div>
<table style="width:100%;border-bottom:1px solid #ddd;padding:10px 0;" cellpadding="8">
  <tr>
    <td><div style="font-size:10px;color:#666;text-transform:uppercase;">Claim Number</div><div style="font-size:14px;font-weight:600;">${esc(claimData?.claim_number)}</div></td>
    <td><div style="font-size:10px;color:#666;text-transform:uppercase;">Policyholder</div><div style="font-size:14px;font-weight:600;">${esc(claimData?.policyholder_name)}</div></td>
    <td><div style="font-size:10px;color:#666;text-transform:uppercase;">Property Address</div><div style="font-size:14px;font-weight:600;">${esc(claimData?.policyholder_address)}</div></td>
    <td><div style="font-size:10px;color:#666;text-transform:uppercase;">Loss Date</div><div style="font-size:14px;font-weight:600;">${claimData?.loss_date ? new Date(claimData.loss_date).toLocaleDateString() : 'N/A'}</div></td>
  </tr>
</table>
${photoCardsHtml}
<div style="text-align:center;padding:15px;color:#666;font-size:11px;border-top:1px solid #ddd;">
  Generated on ${reportDate} • ${photoEntries.length} photos included
</div>
</body></html>`;

      const blob = new Blob([wordHtml], { type: "application/msword" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${reportTitle.replace(/[^a-z0-9]/gi, "_")}_photos.doc`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      toast({ title: "Word document downloaded with embedded photos" });
    } catch (error: any) {
      console.error("Photo DOCX error:", error);
      toast({ title: "Error generating Word document", description: error.message || "Please try again", variant: "destructive" });
    } finally {
      setGenerating(false);
    }
  };

  const generatePhotoPdf = async () => {
    if (selectedPhotos.length === 0) {
      toast({ title: "Please select at least one photo", variant: "destructive" });
      return;
    }

    setGenerating(true);
    try {
      toast({ title: "Generating photo PDF..." });
      
      const selectedPhotoData = photos.filter(p => selectedPhotos.includes(p.id));
      
      // Batch fetch signed URLs with concurrency limit for better performance
      const BATCH_SIZE = 8;
      const photoUrls: { 
        url: string; 
        fileName: string; 
        category: string; 
        description: string; 
        photoNumber: number;
        aiAnalysis?: {
          material_type: string | null;
          condition_rating: string | null;
          condition_notes: string | null;
          detected_damages: any;
          summary: string | null;
        } | null;
      }[] = [];
      
      for (let i = 0; i < selectedPhotoData.length; i += BATCH_SIZE) {
        const batch = selectedPhotoData.slice(i, i + BATCH_SIZE);
        const batchResults = await Promise.all(
          batch.map(async (photo, batchIdx) => {
            const path = photo.annotated_file_path || photo.file_path;
            const { data } = await supabase.storage
              .from("claim-files")
              .createSignedUrl(path, 3600);
            return {
              url: data?.signedUrl || "",
              fileName: photo.file_name,
              category: photo.category || "General",
              description: photo.description || "",
              photoNumber: i + batchIdx + 1,
              // Include AI analysis data if available and requested
              aiAnalysis: includeAIAnalysis && photo.ai_analyzed_at ? {
                material_type: photo.ai_material_type || null,
                condition_rating: photo.ai_condition_rating || null,
                condition_notes: photo.ai_condition_notes || null,
                detected_damages: photo.ai_detected_damages || [],
                summary: photo.ai_analysis_summary || null,
              } : null,
            };
          })
        );
        photoUrls.push(...batchResults);
      }

      // Call edge function to generate HTML
      const { data, error } = await supabase.functions.invoke("generate-photo-report-pdf", {
        body: {
          claimId,
          reportTitle,
          photoUrls,
          companyBranding,
          includeAiContext: includeAIAnalysis,
        },
      });

      if (error) throw error;
      if (data.error) throw new Error(data.error);

      // Use jsPDF + html2canvas to convert HTML to PDF on client side
      const container = document.createElement("div");
      container.innerHTML = data.html;
      document.body.appendChild(container);

      try {
        await htmlElementToPdf(container, {
          filename: `${reportTitle.replace(/[^a-z0-9]/gi, "_")}_photos.pdf`,
          margin: 0,
          format: "letter",
          orientation: "portrait",
          imageQuality: 0.85,
        });
      } finally {
        document.body.removeChild(container);
      }

      toast({ title: "Photo PDF generated successfully" });
    } catch (error: any) {
      console.error("Photo PDF error:", error);
      toast({ 
        title: "Error generating photo PDF", 
        description: error.message || "Please try again",
        variant: "destructive" 
      });
    } finally {
      setGenerating(false);
    }
  };

  const generateStandardReport = async () => {
    if (selectedPhotos.length === 0) {
      toast({ title: "Please select at least one photo", variant: "destructive" });
      return;
    }

    setGenerating(true);
    try {
      const selectedPhotoData = photos.filter(p => selectedPhotos.includes(p.id));
      
      // Batch fetch signed URLs with concurrency limit
      const BATCH_SIZE = 8;
      const photoUrls: Array<ClaimPhoto & { signedUrl: string }> = [];
      
      for (let i = 0; i < selectedPhotoData.length; i += BATCH_SIZE) {
        const batch = selectedPhotoData.slice(i, i + BATCH_SIZE);
        const batchResults = await Promise.all(
          batch.map(async (photo) => {
            const path = photo.annotated_file_path || photo.file_path;
            const { data } = await supabase.storage
              .from("claim-files")
              .createSignedUrl(path, 3600);
            return { ...photo, signedUrl: data?.signedUrl || "" };
          })
        );
        photoUrls.push(...batchResults);
      }

      const html = generateReportHtml(photoUrls, reportTitle, reportType, includeDescriptions, includeCategories, claim);
      
      const blob = new Blob([html], { type: "text/html" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${reportTitle.replace(/[^a-z0-9]/gi, "_")}.html`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      const reportPath = `${claimId}/reports/photo_report_${Date.now()}.html`;
      await supabase.storage.from("claim-files").upload(reportPath, blob);
      
      await supabase.from("claim_files").insert({
        claim_id: claimId,
        file_name: `${reportTitle}.html`,
        file_path: reportPath,
        file_type: "text/html",
        file_size: blob.size,
      });

      toast({ title: "Report generated and saved to claim files" });
      onOpenChange(false);
    } catch (error: any) {
      console.error("Report generation error:", error);
      toast({ title: "Error generating report", description: error.message, variant: "destructive" });
    } finally {
      setGenerating(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-auto">
        <DialogHeader>
          <DialogTitle>Generate Photo Report</DialogTitle>
        </DialogHeader>

        <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as any)}>
          <TabsList className="flex flex-row w-full bg-muted/40 p-2 gap-1">
            <TabsTrigger value="ai" className="flex-1 justify-center text-base font-medium px-4">
              <Sparkles className="h-4 w-4 mr-2" />
              AI Analysis
            </TabsTrigger>
            <TabsTrigger value="standard" className="flex-1 justify-center text-base font-medium px-4">
              <FileText className="h-4 w-4 mr-2" />
              Standard Report
            </TabsTrigger>
          </TabsList>

          <TabsContent value="ai" className="space-y-4 mt-4">
            <div>
              <Label>Report Title</Label>
              <Input
                value={reportTitle}
                onChange={(e) => setReportTitle(e.target.value)}
                className="mt-1"
              />
            </div>

            <div>
              <Label className="mb-2 block">AI Report Type</Label>
              <div className="grid grid-cols-2 gap-3">
                {AI_REPORT_TYPES.map(type => (
                  <Card 
                    key={type.id}
                    className={`cursor-pointer transition-all ${aiReportType === type.id ? "ring-2 ring-primary" : ""}`}
                    onClick={() => setAiReportType(type.id)}
                  >
                    <CardHeader className="p-3">
                      <CardTitle className="text-sm">{type.name}</CardTitle>
                      <CardDescription className="text-xs">{type.description}</CardDescription>
                    </CardHeader>
                  </Card>
                ))}
              </div>
            </div>

            {aiReportType === 'demand-package' && (
              <div className="border rounded-lg p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Cloud className="h-4 w-4 text-muted-foreground" />
                    <Label className="text-sm font-medium">Weather History Preview</Label>
                  </div>
                  <Button 
                    variant="outline" 
                    size="sm" 
                    onClick={previewWeather}
                    disabled={previewingWeather}
                  >
                    {previewingWeather ? (
                      <>
                        <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                        Loading...
                      </>
                    ) : (
                      <>
                        <Cloud className="h-3 w-3 mr-1" />
                        Check Weather
                      </>
                    )}
                  </Button>
                </div>
                
                {weatherData && weatherData.daily && (
                  <div className="bg-muted/30 rounded-lg p-3 space-y-3">
                    <p className="text-xs text-muted-foreground">
                      {weatherData.location}
                    </p>
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="border-b">
                            <th className="text-left py-1 px-2">Date</th>
                            <th className="text-left py-1 px-2">Conditions</th>
                            <th className="text-center py-1 px-2">
                              <Thermometer className="h-3 w-3 inline" />
                            </th>
                            <th className="text-center py-1 px-2">
                              <Droplets className="h-3 w-3 inline" />
                            </th>
                            <th className="text-center py-1 px-2">
                              <Wind className="h-3 w-3 inline" /> Speed
                            </th>
                            <th className="text-center py-1 px-2">
                              <Wind className="h-3 w-3 inline" /> Gusts
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {weatherData.daily.dates?.map((date: string, i: number) => (
                            <tr 
                              key={date} 
                              className={i === weatherData.dayIndex ? "bg-amber-100 dark:bg-amber-900/30 font-medium" : ""}
                            >
                              <td className="py-1 px-2">
                                {date}
                                {i === weatherData.dayIndex && <span className="text-amber-600 ml-1">(Loss)</span>}
                              </td>
                              <td className="py-1 px-2">{weatherData.daily.weatherDescription?.[i]}</td>
                              <td className="text-center py-1 px-2">{weatherData.daily.maxTemp?.[i]}°/{weatherData.daily.minTemp?.[i]}°F</td>
                              <td className="text-center py-1 px-2">{weatherData.daily.precipitation?.[i]} mm</td>
                              <td className="text-center py-1 px-2">{weatherData.daily.maxWindSpeed?.[i]} mph</td>
                              <td className="text-center py-1 px-2">{weatherData.daily.maxWindGusts?.[i]} mph</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
                
                {!weatherData && !previewingWeather && (
                  <p className="text-xs text-muted-foreground">
                    Click "Check Weather" to preview historical wind, hail, and precipitation data for the loss date.
                  </p>
                )}
              </div>
            )}

            {/* Supporting Documents Section for Demand Package */}
            {aiReportType === 'demand-package' && (
              <div className="border rounded-lg p-4 space-y-3">
                <div className="flex items-center gap-2">
                  <FolderOpen className="h-4 w-4 text-muted-foreground" />
                  <Label className="text-sm font-medium">Supporting Evidence Documents</Label>
                </div>
                
                {loadingDocs ? (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    Loading documents...
                  </div>
                ) : supportingDocs.length > 0 ? (
                  <>
                    <div className="flex justify-between items-center">
                      <span className="text-xs text-muted-foreground">
                        {selectedDocs.length} of {supportingDocs.length} selected
                      </span>
                      <div className="flex gap-2">
                        <Button variant="outline" size="sm" onClick={selectAllDocs}>Select All</Button>
                        <Button variant="outline" size="sm" onClick={clearDocs}>Clear</Button>
                      </div>
                    </div>
                    <div className="grid gap-2 max-h-32 overflow-auto">
                      {supportingDocs.map(doc => (
                        <label 
                          key={doc.id} 
                          className={`flex items-center gap-2 p-2 rounded cursor-pointer hover:bg-muted/50 ${selectedDocs.includes(doc.id) ? 'bg-primary/10' : ''}`}
                        >
                          <Checkbox 
                            checked={selectedDocs.includes(doc.id)}
                            onCheckedChange={() => toggleDoc(doc.id)}
                          />
                          <File className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                          <span className="text-sm truncate">{doc.file_name}</span>
                        </label>
                      ))}
                    </div>
                  </>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    No documents found in "Supporting Evidence" folder. Add documents there to include them in the demand package.
                  </p>
                )}
              </div>
            )}
            <PhotoSelector 
              photos={photos} 
              selectedPhotos={selectedPhotos} 
              togglePhoto={togglePhoto}
              selectAll={selectAll}
              selectNone={selectNone}
            />

            {aiReport && (
              <div className="space-y-3">
                <DarwinCitationWatchdog watchdog={citationWatchdog} jurisdiction={jurisdictionInfo} />
                {aiReferencedPhotos.length > 0 && (
                  <div className="border border-primary/20 bg-primary/5 rounded-lg p-4">
                    <h4 className="font-medium mb-2 flex items-center gap-2 text-primary">
                      <Sparkles className="h-4 w-4" />
                      AI-Referenced Photos ({aiReferencedPhotos.length})
                    </h4>
                    <p className="text-xs text-muted-foreground mb-3">
                      These photos were specifically cited in the AI analysis. Download the "AI Referenced PDF" to get a photo report with just these photos and their AI analysis context.
                    </p>
                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2 max-h-32 overflow-auto">
                      {aiReferencedPhotos.map((photo) => (
                        <div key={photo.photoNumber} className="text-xs bg-background rounded p-2 border">
                          <span className="font-medium">Photo {photo.photoNumber}</span>
                          <p className="text-muted-foreground line-clamp-2 mt-1">{photo.aiContext}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                <div className="bg-muted/50 rounded-lg p-4 max-h-64 overflow-auto">
                  <h4 className="font-medium mb-2 flex items-center gap-2">
                    <FileText className="h-4 w-4 text-primary" />
                    AI Analysis Report
                  </h4>
                  <div className="text-sm whitespace-pre-wrap">{aiReport}</div>
                </div>
              </div>
            )}

            <DialogFooter className="flex-col sm:flex-row gap-2">
              <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
              {aiReport ? (
                <div className="flex flex-wrap gap-2">
                  {aiReferencedPhotos.length > 0 && (
                    <Button 
                      variant="default" 
                      onClick={generateReferencedPhotoPdf} 
                      disabled={generatingReferencedPdf}
                      className="bg-primary"
                    >
                      <Sparkles className="h-4 w-4 mr-2" />
                      {generatingReferencedPdf ? "Generating..." : `AI Referenced PDF (${aiReferencedPhotos.length})`}
                    </Button>
                  )}
                  <Button variant="outline" onClick={generatePhotoPdf} disabled={generating}>
                    <Image className="h-4 w-4 mr-2" />
                    {generating ? "Generating..." : "Photos PDF"}
                  </Button>
                  <Button variant="outline" onClick={generatePhotoDocx} disabled={generating}>
                    <FileText className="h-4 w-4 mr-2" />
                    {generating ? "Generating..." : "Photos Word (.doc)"}
                  </Button>
                  <Button onClick={saveAIReport} disabled={generating}>
                    <FileText className="h-4 w-4 mr-2" />
                    Save Word Doc
                  </Button>
                </div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {(generating || pollingForResult) && (
                    <Button variant="outline" onClick={checkForCompletedReport} disabled={pollingForResult}>
                      {pollingForResult ? (
                        <>
                          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                          Checking...
                        </>
                      ) : (
                        "Check for Completed Report"
                      )}
                    </Button>
                  )}
                  <Button variant="outline" onClick={generatePhotoPdf} disabled={generating || selectedPhotos.length === 0}>
                    <Image className="h-4 w-4 mr-2" />
                    {generating ? "Generating..." : "Photos PDF"}
                  </Button>
                  <Button variant="outline" onClick={generatePhotoDocx} disabled={generating || selectedPhotos.length === 0}>
                    <FileText className="h-4 w-4 mr-2" />
                    {generating ? "Generating..." : "Photos Word (.doc)"}
                  </Button>
                  <Button onClick={generateAIReport} disabled={generating || pollingForResult || selectedPhotos.length === 0}>
                    {generating ? (
                      <>
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        Analyzing (stay on page)...
                      </>
                    ) : pollingForResult ? (
                      <>
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        Retrieving...
                      </>
                    ) : (
                      <>
                        <Sparkles className="h-4 w-4 mr-2" />
                        Generate AI Report
                      </>
                    )}
                  </Button>
                </div>
              )}
            </DialogFooter>
          </TabsContent>

          <TabsContent value="standard" className="space-y-4 mt-4">
            <div>
              <Label>Report Title</Label>
              <Input
                value={reportTitle}
                onChange={(e) => setReportTitle(e.target.value)}
                className="mt-1"
              />
            </div>

            <div>
              <Label>Report Layout</Label>
              <Select value={reportType} onValueChange={(v: any) => setReportType(v)}>
                <SelectTrigger className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="grid">
                    <div className="flex items-center gap-2">
                      <Grid className="h-4 w-4" />
                      Photo Grid (3 per row)
                    </div>
                  </SelectItem>
                  <SelectItem value="before-after">
                    <div className="flex items-center gap-2">
                      <Columns className="h-4 w-4" />
                      Before/After Comparison
                    </div>
                  </SelectItem>
                  <SelectItem value="detailed">
                    <div className="flex items-center gap-2">
                      <FileText className="h-4 w-4" />
                      Detailed (1 per page)
                    </div>
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="flex gap-4">
              <label className="flex items-center gap-2">
                <Checkbox
                  checked={includeDescriptions}
                  onCheckedChange={(c) => setIncludeDescriptions(!!c)}
                />
                Include Descriptions
              </label>
              <label className="flex items-center gap-2">
                <Checkbox
                  checked={includeCategories}
                  onCheckedChange={(c) => setIncludeCategories(!!c)}
                />
                Include Categories
              </label>
              <label className="flex items-center gap-2">
                <Checkbox
                  checked={includeAIAnalysis}
                  onCheckedChange={(c) => setIncludeAIAnalysis(!!c)}
                />
                <span className="flex items-center gap-1">
                  <Brain className="h-3 w-3" />
                  Include Darwin AI Analysis
                </span>
              </label>
            </div>

            <PhotoSelector 
              photos={photos} 
              selectedPhotos={selectedPhotos} 
              togglePhoto={togglePhoto}
              selectAll={selectAll}
              selectNone={selectNone}
            />

            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button onClick={generateStandardReport} disabled={generating || selectedPhotos.length === 0}>
                <Download className="h-4 w-4 mr-2" />
                {generating ? "Generating..." : "Generate Report"}
              </Button>
            </DialogFooter>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

// Shared cache for thumbnail URLs across component instances
const thumbnailUrlCache = new Map<string, string>();

function PhotoSelector({ 
  photos, 
  selectedPhotos, 
  togglePhoto,
  selectAll,
  selectNone
}: { 
  photos: ClaimPhoto[]; 
  selectedPhotos: string[];
  togglePhoto: (id: string) => void;
  selectAll: () => void;
  selectNone: () => void;
}) {
  const [thumbnailUrls, setThumbnailUrls] = useState<Record<string, string>>({});
  const [loadingBatch, setLoadingBatch] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Batch load visible thumbnails with concurrency limiting
  useEffect(() => {
    if (photos.length === 0) return;
    
    const loadThumbnails = async () => {
      // Only load photos that aren't already cached
      const photosToLoad = photos.filter(p => !thumbnailUrlCache.has(p.id) && !thumbnailUrls[p.id]);
      if (photosToLoad.length === 0) {
        // All photos already cached, just use cache
        const cached: Record<string, string> = {};
        photos.forEach(p => {
          const url = thumbnailUrlCache.get(p.id);
          if (url) cached[p.id] = url;
        });
        if (Object.keys(cached).length > 0) {
          setThumbnailUrls(prev => ({ ...prev, ...cached }));
        }
        return;
      }
      
      setLoadingBatch(true);
      
      // Batch in groups of 8 for better performance
      const BATCH_SIZE = 8;
      const newUrls: Record<string, string> = {};
      
      for (let i = 0; i < Math.min(photosToLoad.length, 50); i += BATCH_SIZE) { // Limit to first 50 for initial load
        const batch = photosToLoad.slice(i, i + BATCH_SIZE);
        const results = await Promise.all(
          batch.map(async (photo) => {
            const path = photo.annotated_file_path || photo.file_path;
            // Use small thumbnails for selector - 80px is plenty
            const { data } = await supabase.storage
              .from("claim-files")
              .createSignedUrl(path, 3600, {
                transform: { width: 80, height: 80, resize: 'cover', quality: 60 }
              });
            return { id: photo.id, url: data?.signedUrl || "" };
          })
        );
        
        results.forEach(({ id, url }) => {
          if (url) {
            newUrls[id] = url;
            thumbnailUrlCache.set(id, url);
          }
        });
        
        // Update state progressively for better UX
        setThumbnailUrls(prev => ({ ...prev, ...newUrls }));
      }
      
      setLoadingBatch(false);
    };
    
    loadThumbnails();
  }, [photos]);

  return (
    <div>
      <div className="flex justify-between items-center mb-2">
        <Label>Select Photos ({selectedPhotos.length} of {photos.length})</Label>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={selectAll}>Select All</Button>
          <Button variant="outline" size="sm" onClick={selectNone}>Clear</Button>
        </div>
      </div>
      <div 
        ref={containerRef}
        className="grid grid-cols-6 md:grid-cols-10 gap-1 max-h-40 overflow-auto p-2 border rounded"
      >
        {photos.map(photo => (
          <PhotoThumbnail
            key={photo.id}
            photo={photo}
            url={thumbnailUrls[photo.id] || thumbnailUrlCache.get(photo.id) || ""}
            selected={selectedPhotos.includes(photo.id)}
            onToggle={() => togglePhoto(photo.id)}
          />
        ))}
      </div>
      {loadingBatch && (
        <p className="text-xs text-muted-foreground mt-1">Loading thumbnails...</p>
      )}
    </div>
  );
}

const PhotoThumbnail = memo(function PhotoThumbnail({ 
  photo, 
  url,
  selected, 
  onToggle 
}: { 
  photo: ClaimPhoto; 
  url: string;
  selected: boolean; 
  onToggle: () => void;
}) {
  return (
    <div
      className={`relative aspect-square cursor-pointer rounded overflow-hidden border-2 ${
        selected ? "border-primary" : "border-transparent"
      }`}
      onClick={onToggle}
    >
      {url ? (
        <img src={url} alt={photo.file_name} className="w-full h-full object-cover" loading="lazy" />
      ) : (
        <div className="w-full h-full bg-muted animate-pulse" />
      )}
      {selected && (
        <div className="absolute inset-0 bg-primary/20 flex items-center justify-center">
          <div className="w-4 h-4 rounded-full bg-primary flex items-center justify-center">
            <svg className="w-2 h-2 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          </div>
        </div>
      )}
    </div>
  );
});

function generateReportHtml(
  photos: Array<ClaimPhoto & { signedUrl: string }>,
  title: string,
  type: "grid" | "before-after" | "detailed",
  includeDescriptions: boolean,
  includeCategories: boolean,
  claim: any
): string {
  const styles = `
    <style>
      * { box-sizing: border-box; margin: 0; padding: 0; }
      body { font-family: Arial, sans-serif; padding: 20px; background: #fff; }
      .header { text-align: center; margin-bottom: 30px; border-bottom: 2px solid #333; padding-bottom: 20px; }
      .header h1 { font-size: 24px; margin-bottom: 10px; }
      .header p { color: #666; }
      .claim-info { margin-bottom: 30px; padding: 15px; background: #f5f5f5; border-radius: 8px; }
      .claim-info p { margin: 5px 0; }
      .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; }
      .photo-card { border: 1px solid #ddd; border-radius: 8px; overflow: hidden; page-break-inside: avoid; }
      .photo-card img { width: 100%; height: 200px; object-fit: cover; }
      .photo-card .info { padding: 10px; }
      .photo-card .category { font-size: 12px; color: #666; font-weight: bold; }
      .photo-card .description { font-size: 14px; margin-top: 5px; }
      .before-after { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 30px; page-break-inside: avoid; }
      .before-after h3 { text-align: center; margin-bottom: 10px; }
      .before-after img { width: 100%; border-radius: 8px; }
      .detailed-photo { page-break-after: always; margin-bottom: 30px; }
      .detailed-photo img { max-width: 100%; max-height: 500px; display: block; margin: 0 auto; border-radius: 8px; }
      .detailed-photo .info { margin-top: 20px; padding: 15px; background: #f5f5f5; border-radius: 8px; }
      @media print { 
        body { padding: 0; }
        .grid { grid-template-columns: repeat(2, 1fr); }
      }
    </style>
  `;

  let content = "";

  if (type === "grid") {
    content = `<div class="grid">${photos.map(photo => `
      <div class="photo-card">
        <img src="${photo.signedUrl}" alt="${photo.file_name}" />
        <div class="info">
          ${includeCategories ? `<p class="category">${photo.category}</p>` : ""}
          ${includeDescriptions && photo.description ? `<p class="description">${photo.description}</p>` : ""}
        </div>
      </div>
    `).join("")}</div>`;
  } else if (type === "before-after") {
    const pairs = photos
      .filter(p => p.before_after_type === "before" && p.before_after_pair_id)
      .map(before => ({
        before,
        after: photos.find(p => p.before_after_pair_id === before.before_after_pair_id && p.before_after_type === "after"),
      }))
      .filter(pair => pair.after);

    content = pairs.map((pair) => `
      <div class="before-after">
        <div>
          <h3>Before</h3>
          <img src="${pair.before.signedUrl}" alt="Before" />
          ${includeDescriptions && pair.before.description ? `<p style="margin-top:10px">${pair.before.description}</p>` : ""}
        </div>
        <div>
          <h3>After</h3>
          <img src="${pair.after!.signedUrl}" alt="After" />
          ${includeDescriptions && pair.after!.description ? `<p style="margin-top:10px">${pair.after!.description}</p>` : ""}
        </div>
      </div>
    `).join("");

    if (pairs.length === 0) {
      content = `<p>No before/after pairs available.</p>`;
    }
  } else {
    content = photos.map(photo => `
      <div class="detailed-photo">
        <img src="${photo.signedUrl}" alt="${photo.file_name}" />
        <div class="info">
          ${includeCategories ? `<p><strong>Category:</strong> ${photo.category}</p>` : ""}
          ${includeDescriptions && photo.description ? `<p><strong>Description:</strong> ${photo.description}</p>` : ""}
          <p><strong>File:</strong> ${photo.file_name}</p>
        </div>
      </div>
    `).join("");
  }

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <title>${title}</title>
      ${styles}
    </head>
    <body>
      <div class="header">
        <h1>${title}</h1>
        <p>Generated on ${new Date().toLocaleString()}</p>
      </div>
      <div class="claim-info">
        <p><strong>Policyholder:</strong> ${claim?.policyholder_name || "N/A"}</p>
        <p><strong>Address:</strong> ${claim?.policyholder_address || "N/A"}</p>
        <p><strong>Claim Number:</strong> ${claim?.claim_number || "N/A"}</p>
        <p><strong>Insurance:</strong> ${claim?.insurance_company || "N/A"}</p>
      </div>
      ${content}
    </body>
    </html>
  `;
}

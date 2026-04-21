import { useState, useEffect, useRef, useCallback, useMemo, memo } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Camera, Upload, Pencil, Trash2, Link2, FileText, Grid, Columns, X, Download, Eye, Sparkles, ChevronLeft, ChevronRight, Brain, Loader2, AlertTriangle, CheckCircle2, XCircle, HelpCircle, ZoomIn, ZoomOut, RotateCcw, CheckSquare } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { PhotoAnnotationEditor } from "./PhotoAnnotationEditor";
import { PhotoReportDialog } from "./PhotoReportDialog";
import { PhotoDamageFindings } from "./PhotoDamageFindings";

interface ClaimPhoto {
  id: string;
  claim_id: string;
  file_path: string;
  file_name: string;
  file_size: number | null;
  category: string;
  description: string | null;
  annotations: any;
  annotated_file_path: string | null;
  before_after_type: string | null;
  before_after_pair_id: string | null;
  taken_at: string | null;
  uploaded_by: string | null;
  created_at: string;
  updated_at: string;
  // AI analysis fields
  ai_condition_rating: string | null;
  ai_condition_notes: string | null;
  ai_detected_damages: any;
  ai_material_type: string | null;
  ai_analysis_summary: string | null;
  ai_analyzed_at: string | null;
}

interface ClaimPhotosProps {
  claimId: string;
  claim: any;
  isPortalUser?: boolean;
}

const PHOTO_CATEGORIES = [
  "Exterior - Front",
  "Exterior - Back",
  "Exterior - Left",
  "Exterior - Right",
  "Roof - Overview",
  "Roof - Damage",
  "Roof - Shingles",
  "Roof - Flashing",
  "Roof - Gutters",
  "Interior - Living Areas",
  "Interior - Bedrooms",
  "Interior - Bathrooms",
  "Interior - Kitchen",
  "Interior - Basement",
  "Interior - Attic",
  "Water Damage",
  "Fire Damage",
  "Storm Damage",
  "Hail Damage",
  "Wind Damage",
  "Mold",
  "Before Repairs",
  "After Repairs",
  "General",
];

const PHOTOS_PER_PAGE = 24;

export function ClaimPhotos({ claimId, claim, isPortalUser = false }: ClaimPhotosProps) {
  const [photos, setPhotos] = useState<ClaimPhoto[]>([]);
  const [photoUrls, setPhotoUrls] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [uploadDialogOpen, setUploadDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [annotateDialogOpen, setAnnotateDialogOpen] = useState(false);
  const [linkDialogOpen, setLinkDialogOpen] = useState(false);
  const [reportDialogOpen, setReportDialogOpen] = useState(false);
  const [previewDialogOpen, setPreviewDialogOpen] = useState(false);
  const [selectedPhoto, setSelectedPhoto] = useState<ClaimPhoto | null>(null);
  const [selectedPhotos, setSelectedPhotos] = useState<string[]>([]);
  const [activeCategory, setActiveCategory] = useState("all");
  const [viewMode, setViewMode] = useState<"grid" | "before-after">("grid");
  const [currentPage, setCurrentPage] = useState(1);
  
  // Analyze all photos state
  const [analyzingAll, setAnalyzingAll] = useState(false);
  const [analysisProgress, setAnalysisProgress] = useState({ current: 0, total: 0 });
  
  // Upload form state
  const [uploadFiles, setUploadFiles] = useState<File[]>([]);
  const [uploadCategory, setUploadCategory] = useState("General");
  const [uploadDescription, setUploadDescription] = useState("");
  const [uploadBeforeAfter, setUploadBeforeAfter] = useState<string | null>(null);
  
  // Camera state
  const [cameraDialogOpen, setCameraDialogOpen] = useState(false);
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  
  // Edit form state
  const [editCategory, setEditCategory] = useState("");
  const [editDescription, setEditDescription] = useState("");
  
  const { toast } = useToast();

  useEffect(() => {
    fetchPhotos();
  }, [claimId]);

  // Connect camera stream to video element when both are available
  useEffect(() => {
    if (cameraDialogOpen && cameraStream && videoRef.current) {
      videoRef.current.srcObject = cameraStream;
    }
  }, [cameraDialogOpen, cameraStream]);

  // Filter photos by category
  const filteredPhotos = useMemo(() => {
    return activeCategory === "all" 
      ? photos 
      : photos.filter(p => p.category === activeCategory);
  }, [photos, activeCategory]);

  // Paginate filtered photos
  const paginatedPhotos = useMemo(() => {
    const startIdx = (currentPage - 1) * PHOTOS_PER_PAGE;
    return filteredPhotos.slice(startIdx, startIdx + PHOTOS_PER_PAGE);
  }, [filteredPhotos, currentPage]);

  const totalPages = Math.ceil(filteredPhotos.length / PHOTOS_PER_PAGE);

  // Reset page when category changes
  useEffect(() => {
    setCurrentPage(1);
  }, [activeCategory]);

  // Batch fetch signed URLs for visible photos with concurrency limiting
  const fetchSignedUrls = useCallback(async (photosToFetch: ClaimPhoto[]) => {
    if (photosToFetch.length === 0) return;
    
    // Only fetch URLs for photos we don't already have
    const photosNeedingUrls = photosToFetch.filter(p => !photoUrls[p.id]);
    if (photosNeedingUrls.length === 0) return;
    
    // Batch fetch with concurrency limit of 6 to avoid overwhelming the browser
    const BATCH_SIZE = 6;
    const newUrls: Record<string, string> = {};
    
    for (let i = 0; i < photosNeedingUrls.length; i += BATCH_SIZE) {
      const batch = photosNeedingUrls.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(
        batch.map(async (photo) => {
          const path = photo.annotated_file_path || photo.file_path;
          // Use transform for thumbnails - much smaller file size = faster loading
          const { data } = await supabase.storage
            .from("claim-files")
            .createSignedUrl(path, 3600, {
              transform: { width: 400, height: 400, resize: 'cover', quality: 70 }
            });
          return { id: photo.id, url: data?.signedUrl || "" };
        })
      );
      
      batchResults.forEach(({ id, url }) => {
        if (url) newUrls[id] = url;
      });
    }
    
    setPhotoUrls(prev => ({ ...prev, ...newUrls }));
  }, [photoUrls]);

  // Fetch URLs when paginated photos change - with debounce to prevent rapid refetching
  useEffect(() => {
    const timeoutId = setTimeout(() => {
      fetchSignedUrls(paginatedPhotos);
    }, 100);
    return () => clearTimeout(timeoutId);
  }, [paginatedPhotos, fetchSignedUrls]);

  const fetchPhotos = async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from("claim_photos")
      .select("*")
      .eq("claim_id", claimId)
      .order("created_at", { ascending: false });
    
    if (error) {
      console.error("Error fetching photos:", error);
      toast({ title: "Error loading photos", variant: "destructive" });
    } else {
      setPhotos(data || []);
    }
    setLoading(false);
  };

  // Trigger AI analysis for a single photo
  const analyzePhoto = async (photoId: string): Promise<boolean> => {
    try {
      console.log(`Triggering AI analysis for photo ${photoId}...`);
      const { data, error } = await supabase.functions.invoke("analyze-single-photo", {
        body: { photoId, claimId },
      });

      if (error) {
        console.error("AI analysis error:", error);
        return false;
      }

      if (data?.success) {
        console.log(`AI analysis complete for photo ${photoId}:`, data.analysis);
        return true;
      }
      return false;
    } catch (err) {
      console.error("Failed to analyze photo:", err);
      return false;
    }
  };

  // Analyze photos helper function
  const analyzePhotoBatch = async (photosToAnalyze: ClaimPhoto[], label: string) => {
    if (photosToAnalyze.length === 0) {
      toast({ 
        title: "All photos already analyzed", 
        description: "All photos in this selection have been analyzed by Darwin." 
      });
      return;
    }

    setAnalyzingAll(true);
    setAnalysisProgress({ current: 0, total: photosToAnalyze.length });

    toast({ 
      title: "Darwin is analyzing photos", 
      description: `Analyzing ${photosToAnalyze.length} ${label}. This may take a few minutes.`
    });

    let successCount = 0;
    let failCount = 0;

    // Process photos in batches of 3 to avoid rate limits
    const BATCH_SIZE = 3;
    for (let i = 0; i < photosToAnalyze.length; i += BATCH_SIZE) {
      const batch = photosToAnalyze.slice(i, i + BATCH_SIZE);
      
      const results = await Promise.all(
        batch.map(photo => analyzePhoto(photo.id))
      );
      
      results.forEach(success => {
        if (success) successCount++;
        else failCount++;
      });
      
      setAnalysisProgress({ current: i + batch.length, total: photosToAnalyze.length });
      
      // Small delay between batches to avoid overwhelming the API
      if (i + BATCH_SIZE < photosToAnalyze.length) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    setAnalyzingAll(false);
    setAnalysisProgress({ current: 0, total: 0 });
    fetchPhotos();

    toast({ 
      title: "Analysis complete", 
      description: `Successfully analyzed ${successCount} photos${failCount > 0 ? `, ${failCount} failed` : ''}.`
    });
  };

  // Analyze all photos that haven't been analyzed yet
  const analyzeAllPhotos = async () => {
    const unanalyzedPhotos = photos.filter(p => !p.ai_analyzed_at);
    await analyzePhotoBatch(unanalyzedPhotos, "photos");
  };

  // Re-analyze ALL photos (including already analyzed)
  const reanalyzeAllPhotos = async () => {
    await analyzePhotoBatch([...photos], "photos (re-analysis)");
  };

  // Analyze only photos on the current page that haven't been analyzed
  const analyzeCurrentPage = async () => {
    const unanalyzedOnPage = paginatedPhotos.filter(p => !p.ai_analyzed_at);
    await analyzePhotoBatch(unanalyzedOnPage, `photos on this page`);
  };

  // Re-analyze all photos on current page (including already analyzed)
  const reanalyzeCurrentPage = async () => {
    await analyzePhotoBatch([...paginatedPhotos], `photos on this page (re-analysis)`);
  };

  const handleUpload = async () => {
    if (uploadFiles.length === 0) return;
    
    setUploading(true);
    const uploadedPhotoIds: string[] = [];
    
    try {
      for (const file of uploadFiles) {
        const fileExt = file.name.split(".").pop();
        const fileName = `${crypto.randomUUID()}.${fileExt}`;
        const filePath = `${claimId}/photos/${fileName}`;
        
        const { error: uploadError } = await supabase.storage
          .from("claim-files")
          .upload(filePath, file);
        
        if (uploadError) throw uploadError;
        
        const { data: insertedPhoto, error: dbError } = await supabase.from("claim_photos").insert({
          claim_id: claimId,
          file_path: filePath,
          file_name: file.name,
          file_size: file.size,
          category: uploadCategory,
          description: uploadDescription || null,
          before_after_type: uploadBeforeAfter,
        }).select("id").single();
        
        if (dbError) throw dbError;
        if (insertedPhoto) {
          uploadedPhotoIds.push(insertedPhoto.id);
        }
      }
      
      toast({ title: `${uploadFiles.length} photo(s) uploaded successfully` });
      setUploadDialogOpen(false);
      setUploadFiles([]);
      setUploadCategory("General");
      setUploadDescription("");
      setUploadBeforeAfter(null);
      fetchPhotos();
    } catch (error: any) {
      console.error("Upload error:", error);
      toast({ title: "Error uploading photos", description: error.message, variant: "destructive" });
    } finally {
      setUploading(false);
    }
  };

  const handleEdit = async () => {
    if (!selectedPhoto) return;
    
    try {
      const { error } = await supabase
        .from("claim_photos")
        .update({
          category: editCategory,
          description: editDescription || null,
        })
        .eq("id", selectedPhoto.id);
      
      if (error) throw error;
      
      toast({ title: "Photo updated" });
      setEditDialogOpen(false);
      fetchPhotos();
    } catch (error: any) {
      toast({ title: "Error updating photo", variant: "destructive" });
    }
  };

  const handleDelete = async (photoId: string) => {
    const photo = photos.find(p => p.id === photoId);
    if (!photo) return;
    
    try {
      await supabase.storage.from("claim-files").remove([photo.file_path]);
      if (photo.annotated_file_path) {
        await supabase.storage.from("claim-files").remove([photo.annotated_file_path]);
      }
      
      const { error } = await supabase.from("claim_photos").delete().eq("id", photoId);
      if (error) throw error;
      
      toast({ title: "Photo deleted" });
      // Clear URL from cache
      setPhotoUrls(prev => {
        const newUrls = { ...prev };
        delete newUrls[photoId];
        return newUrls;
      });
      fetchPhotos();
    } catch (error) {
      toast({ title: "Error deleting photo", variant: "destructive" });
    }
  };

  const handleLinkBeforeAfter = async (beforeId: string, afterId: string) => {
    const pairId = crypto.randomUUID();
    
    try {
      await supabase
        .from("claim_photos")
        .update({ before_after_type: "before", before_after_pair_id: pairId })
        .eq("id", beforeId);
      
      await supabase
        .from("claim_photos")
        .update({ before_after_type: "after", before_after_pair_id: pairId })
        .eq("id", afterId);
      
      toast({ title: "Before/After pair linked" });
      setLinkDialogOpen(false);
      setSelectedPhotos([]);
      fetchPhotos();
    } catch (error) {
      toast({ title: "Error linking photos", variant: "destructive" });
    }
  };

  // Camera functions
  const startCamera = async () => {
    setCameraDialogOpen(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ 
        video: { facingMode: "environment" } 
      });
      setCameraStream(stream);
    } catch (error) {
      console.error("Camera error:", error);
      toast({ 
        title: "Camera access denied", 
        description: "Please allow camera access to take photos.",
        variant: "destructive" 
      });
      setCameraDialogOpen(false);
    }
  };

  const stopCamera = () => {
    if (cameraStream) {
      cameraStream.getTracks().forEach(track => track.stop());
      setCameraStream(null);
    }
    setCameraDialogOpen(false);
  };

  const capturePhoto = async () => {
    if (!videoRef.current || !canvasRef.current) return;
    
    const video = videoRef.current;
    const canvas = canvasRef.current;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    
    ctx.drawImage(video, 0, 0);
    
    canvas.toBlob(async (blob) => {
      if (!blob) return;
      
      setUploading(true);
      try {
        const fileName = `camera_${Date.now()}.jpg`;
        const filePath = `${claimId}/photos/${fileName}`;
        
        const { error: uploadError } = await supabase.storage
          .from("claim-files")
          .upload(filePath, blob);
        
        if (uploadError) throw uploadError;
        
        const { data: insertedPhoto, error: dbError } = await supabase.from("claim_photos").insert({
          claim_id: claimId,
          file_path: filePath,
          file_name: fileName,
          file_size: blob.size,
          category: uploadCategory,
          taken_at: new Date().toISOString(),
        }).select("id").single();
        
        if (dbError) throw dbError;
        
        toast({ title: "Photo captured successfully" });
        fetchPhotos();
      } catch (error: any) {
        toast({ title: "Error saving photo", description: error.message, variant: "destructive" });
      } finally {
        setUploading(false);
      }
    }, "image/jpeg", 0.9);
  };

  const openEditDialog = (photo: ClaimPhoto) => {
    setSelectedPhoto(photo);
    setEditCategory(photo.category);
    setEditDescription(photo.description || "");
    setEditDialogOpen(true);
  };

  const openAnnotateDialog = (photo: ClaimPhoto) => {
    setSelectedPhoto(photo);
    setAnnotateDialogOpen(true);
  };

  // Full-res URLs for the lightbox (separate from thumbnail cache)
  const [fullResUrls, setFullResUrls] = useState<Record<string, string>>({});

  const openPreviewDialog = async (photo: ClaimPhoto) => {
    setSelectedPhoto(photo);
    setPreviewDialogOpen(true);
    
    // Fetch full-resolution signed URL (not thumbnail)
    if (!fullResUrls[photo.id]) {
      const path = photo.annotated_file_path || photo.file_path;
      const { data } = await supabase.storage
        .from("claim-files")
        .createSignedUrl(path, 3600);
      if (data?.signedUrl) {
        setFullResUrls(prev => ({ ...prev, [photo.id]: data.signedUrl }));
      }
    }
  };

  // Navigate to next/previous photo in the lightbox
  const navigatePhoto = async (direction: "prev" | "next") => {
    if (!selectedPhoto) return;
    const currentIndex = filteredPhotos.findIndex(p => p.id === selectedPhoto.id);
    if (currentIndex === -1) return;
    const newIndex = direction === "next" 
      ? (currentIndex + 1) % filteredPhotos.length 
      : (currentIndex - 1 + filteredPhotos.length) % filteredPhotos.length;
    const newPhoto = filteredPhotos[newIndex];
    setSelectedPhoto(newPhoto);
    
    if (!fullResUrls[newPhoto.id]) {
      const path = newPhoto.annotated_file_path || newPhoto.file_path;
      const { data } = await supabase.storage
        .from("claim-files")
        .createSignedUrl(path, 3600);
      if (data?.signedUrl) {
        setFullResUrls(prev => ({ ...prev, [newPhoto.id]: data.signedUrl }));
      }
    }
  };

  const togglePhotoSelection = (photoId: string) => {
    setSelectedPhotos(prev => 
      prev.includes(photoId) 
        ? prev.filter(id => id !== photoId)
        : [...prev, photoId]
    );
  };

  const handleSelectAll = () => {
    const allFilteredIds = filteredPhotos.map(p => p.id);
    const allSelected = allFilteredIds.every(id => selectedPhotos.includes(id));
    if (allSelected) {
      setSelectedPhotos(prev => prev.filter(id => !allFilteredIds.includes(id)));
    } else {
      setSelectedPhotos(prev => [...new Set([...prev, ...allFilteredIds])]);
    }
  };

  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [bulkDeleteProgress, setBulkDeleteProgress] = useState({ current: 0, total: 0 });

  const handleBulkDelete = async () => {
    const photosToDelete = photos.filter(p => selectedPhotos.includes(p.id));
    if (photosToDelete.length === 0) return;

    setBulkDeleting(true);
    setBulkDeleteProgress({ current: 0, total: photosToDelete.length });

    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < photosToDelete.length; i++) {
      const photo = photosToDelete[i];
      try {
        await supabase.storage.from("claim-files").remove([photo.file_path]);
        if (photo.annotated_file_path) {
          await supabase.storage.from("claim-files").remove([photo.annotated_file_path]);
        }
        const { error } = await supabase.from("claim_photos").delete().eq("id", photo.id);
        if (error) throw error;
        successCount++;
      } catch {
        failCount++;
      }
      setBulkDeleteProgress({ current: i + 1, total: photosToDelete.length });
    }

    // Clear deleted photo URLs from cache
    setPhotoUrls(prev => {
      const newUrls = { ...prev };
      photosToDelete.forEach(p => delete newUrls[p.id]);
      return newUrls;
    });

    setSelectedPhotos([]);
    setBulkDeleting(false);
    setBulkDeleteProgress({ current: 0, total: 0 });
    fetchPhotos();

    toast({
      title: `Deleted ${successCount} photo(s)`,
      description: failCount > 0 ? `${failCount} failed to delete.` : undefined,
    });
  };

  const categories = useMemo(() => {
    return ["all", ...new Set(photos.map(p => p.category))];
  }, [photos]);

  const beforeAfterPairs = useMemo(() => {
    return photos
      .filter(p => p.before_after_pair_id && p.before_after_type === "before")
      .map(beforePhoto => {
        const afterPhoto = photos.find(
          p => p.before_after_pair_id === beforePhoto.before_after_pair_id && p.before_after_type === "after"
        );
        return { before: beforePhoto, after: afterPhoto };
      })
      .filter(pair => pair.after);
  }, [photos]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap justify-between items-center gap-2">
        <div className="flex items-center gap-2">
          <h3 className="text-lg font-semibold">Photos ({photos.length})</h3>
          <div className="flex border rounded-md">
            <Button
              variant={viewMode === "grid" ? "secondary" : "ghost"}
              size="sm"
              onClick={() => setViewMode("grid")}
            >
              <Grid className="h-4 w-4" />
            </Button>
            <Button
              variant={viewMode === "before-after" ? "secondary" : "ghost"}
              size="sm"
              onClick={() => setViewMode("before-after")}
            >
              <Columns className="h-4 w-4" />
            </Button>
          </div>
        </div>
        
        <div className="flex flex-wrap gap-2">
          {filteredPhotos.length > 0 && (
            <Button variant="outline" size="sm" onClick={handleSelectAll}>
              <CheckSquare className="h-4 w-4 mr-2" />
              {filteredPhotos.every(p => selectedPhotos.includes(p.id)) ? "Deselect All" : "Select All"} ({filteredPhotos.length})
            </Button>
          )}
          {selectedPhotos.length === 2 && (
            <Button variant="outline" size="sm" onClick={() => setLinkDialogOpen(true)}>
              <Link2 className="h-4 w-4 mr-2" />
              Link Before/After
            </Button>
          )}
          {selectedPhotos.length > 0 && (
            <>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="destructive" size="sm" disabled={bulkDeleting}>
                    {bulkDeleting ? (
                      <>
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        Deleting {bulkDeleteProgress.current}/{bulkDeleteProgress.total}
                      </>
                    ) : (
                      <>
                        <Trash2 className="h-4 w-4 mr-2" />
                        Delete Selected ({selectedPhotos.length})
                      </>
                    )}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Delete {selectedPhotos.length} photo(s)?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This will permanently delete {selectedPhotos.length} selected photo(s) and their files. This action cannot be undone.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction onClick={handleBulkDelete} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
                      Delete {selectedPhotos.length} Photo(s)
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
              <Button variant="outline" size="sm" onClick={() => setSelectedPhotos([])}>
                <X className="h-4 w-4 mr-2" />
                Clear ({selectedPhotos.length})
              </Button>
            </>
          )}
          {!isPortalUser && (
            <>
              <Button 
                variant="outline" 
                size="sm" 
                onClick={analyzeCurrentPage}
                disabled={analyzingAll || paginatedPhotos.length === 0}
              >
                {analyzingAll ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Analyzing {analysisProgress.current}/{analysisProgress.total}
                  </>
                ) : (
                  <>
                    <Brain className="h-4 w-4 mr-2" />
                    Analyze This Page
                  </>
                )}
              </Button>
              <Button 
                variant="outline" 
                size="sm" 
                onClick={analyzeAllPhotos}
                disabled={analyzingAll || photos.length === 0}
              >
                <Brain className="h-4 w-4 mr-2" />
                Analyze All ({photos.filter(p => !p.ai_analyzed_at).length})
              </Button>
              {photos.some(p => p.ai_analyzed_at) && (
                <Button 
                  variant="outline" 
                  size="sm" 
                  onClick={reanalyzeAllPhotos}
                  disabled={analyzingAll || photos.length === 0}
                >
                  <Sparkles className="h-4 w-4 mr-2" />
                  Re-analyze All ({photos.length})
                </Button>
              )}
              <Button variant="outline" size="sm" onClick={() => setReportDialogOpen(true)}>
                <FileText className="h-4 w-4 mr-2" />
                Generate Report
              </Button>
            </>
          )}
          <Button variant="outline" size="sm" onClick={startCamera}>
            <Camera className="h-4 w-4 mr-2" />
            Take Photo
          </Button>
          <Dialog open={uploadDialogOpen} onOpenChange={setUploadDialogOpen}>
            <DialogTrigger asChild>
              <Button size="sm">
                <Upload className="h-4 w-4 mr-2" />
                Upload Photos
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-md">
              <DialogHeader>
                <DialogTitle>Upload Photos</DialogTitle>
              </DialogHeader>
              <div className="space-y-4">
                <div>
                  <Label>Select Photos</Label>
                  <Input
                    type="file"
                    accept="image/*,video/*"
                    multiple
                    onChange={(e) => setUploadFiles(Array.from(e.target.files || []))}
                    className="mt-1"
                  />
                  {uploadFiles.length > 0 && (
                    <p className="text-sm text-muted-foreground mt-1">
                      {uploadFiles.length} file(s) selected
                    </p>
                  )}
                </div>
                <div>
                  <Label>Category</Label>
                  <Select value={uploadCategory} onValueChange={setUploadCategory}>
                    <SelectTrigger className="mt-1">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {PHOTO_CATEGORIES.map(cat => (
                        <SelectItem key={cat} value={cat}>{cat}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Before/After Type (Optional)</Label>
                  <Select 
                    value={uploadBeforeAfter || "none"} 
                    onValueChange={(v) => setUploadBeforeAfter(v === "none" ? null : v)}
                  >
                    <SelectTrigger className="mt-1">
                      <SelectValue placeholder="None" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">None</SelectItem>
                      <SelectItem value="before">Before</SelectItem>
                      <SelectItem value="after">After</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Description (Optional)</Label>
                  <Textarea
                    value={uploadDescription}
                    onChange={(e) => setUploadDescription(e.target.value)}
                    placeholder="Describe the photos..."
                    className="mt-1"
                  />
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setUploadDialogOpen(false)}>Cancel</Button>
                <Button onClick={handleUpload} disabled={uploading || uploadFiles.length === 0}>
                  {uploading ? "Uploading..." : "Upload"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {/* Category Filter */}
      <div className="flex flex-wrap gap-2">
        {categories.map(cat => (
          <Badge
            key={cat}
            variant={activeCategory === cat ? "default" : "outline"}
            className="cursor-pointer"
            onClick={() => setActiveCategory(cat)}
          >
            {cat === "all" ? "All" : cat}
          </Badge>
        ))}
      </div>

      {loading ? (
        <div className="text-center py-8 text-muted-foreground">Loading photos...</div>
      ) : photos.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <Camera className="h-12 w-12 text-muted-foreground mb-4" />
            <p className="text-muted-foreground">No photos uploaded yet</p>
            <Button variant="outline" className="mt-4" onClick={() => setUploadDialogOpen(true)}>
              Upload First Photo
            </Button>
          </CardContent>
        </Card>
      ) : viewMode === "grid" ? (
        <>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
            {paginatedPhotos.map(photo => (
              <PhotoCard
                key={photo.id}
                photo={photo}
                imageUrl={photoUrls[photo.id] || ""}
                selected={selectedPhotos.includes(photo.id)}
                onSelect={() => togglePhotoSelection(photo.id)}
                onEdit={() => openEditDialog(photo)}
                onAnnotate={() => openAnnotateDialog(photo)}
                onDelete={() => handleDelete(photo.id)}
                onPreview={() => openPreviewDialog(photo)}
              />
            ))}
          </div>
          
          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-4 mt-6">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                disabled={currentPage === 1}
              >
                <ChevronLeft className="h-4 w-4 mr-1" />
                Previous
              </Button>
              <span className="text-sm text-muted-foreground">
                Page {currentPage} of {totalPages} ({filteredPhotos.length} photos)
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                disabled={currentPage === totalPages}
              >
                Next
                <ChevronRight className="h-4 w-4 ml-1" />
              </Button>
            </div>
          )}
        </>
      ) : (
        <div className="space-y-6">
          <h4 className="font-medium">Before/After Comparisons</h4>
          {beforeAfterPairs.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No before/after pairs created. Select 2 photos and click "Link Before/After" to create a pair.
            </p>
          ) : (
            beforeAfterPairs.map((pair, idx) => (
              <div key={idx} className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-sm font-medium mb-2 text-center">Before</p>
                  <PhotoCard
                    photo={pair.before}
                    imageUrl={photoUrls[pair.before.id] || ""}
                    selected={false}
                    onSelect={() => {}}
                    onEdit={() => openEditDialog(pair.before)}
                    onAnnotate={() => openAnnotateDialog(pair.before)}
                    onDelete={() => handleDelete(pair.before.id)}
                    onPreview={() => openPreviewDialog(pair.before)}
                    compact
                  />
                </div>
                {pair.after && (
                  <div>
                    <p className="text-sm font-medium mb-2 text-center">After</p>
                    <PhotoCard
                      photo={pair.after}
                      imageUrl={photoUrls[pair.after.id] || ""}
                      selected={false}
                      onSelect={() => {}}
                      onEdit={() => openEditDialog(pair.after)}
                      onAnnotate={() => openAnnotateDialog(pair.after)}
                      onDelete={() => handleDelete(pair.after.id)}
                      onPreview={() => openPreviewDialog(pair.after)}
                      compact
                    />
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      )}

      {/* Edit Dialog */}
      <Dialog open={editDialogOpen} onOpenChange={setEditDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Photo Details</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Category</Label>
              <Select value={editCategory} onValueChange={setEditCategory}>
                <SelectTrigger className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PHOTO_CATEGORIES.map(cat => (
                    <SelectItem key={cat} value={cat}>{cat}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Description</Label>
              <Textarea
                value={editDescription}
                onChange={(e) => setEditDescription(e.target.value)}
                className="mt-1"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleEdit}>Save Changes</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Link Before/After Dialog */}
      <Dialog open={linkDialogOpen} onOpenChange={setLinkDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Link Before/After Photos</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            You've selected 2 photos. Choose which is the "Before" and which is the "After":
          </p>
          <div className="grid grid-cols-2 gap-4 mt-4">
            {selectedPhotos.map((photoId, idx) => {
              const photo = photos.find(p => p.id === photoId);
              if (!photo) return null;
              const url = photoUrls[photoId];
              return (
                <div key={photoId} className="text-center">
                  <p className="text-sm font-medium mb-2">{idx === 0 ? "Before" : "After"}</p>
                  {url ? (
                    <img
                      src={url}
                      alt={photo.file_name}
                      className="rounded aspect-square object-cover"
                    />
                  ) : (
                    <div className="rounded aspect-square bg-muted flex items-center justify-center">
                      <Camera className="h-8 w-8 text-muted-foreground" />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setLinkDialogOpen(false)}>Cancel</Button>
            <Button onClick={() => handleLinkBeforeAfter(selectedPhotos[0], selectedPhotos[1])}>
              Create Pair
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Annotation Dialog */}
      {selectedPhoto && (
        <PhotoAnnotationEditor
          open={annotateDialogOpen}
          onOpenChange={setAnnotateDialogOpen}
          photo={selectedPhoto}
          claimId={claimId}
          onSave={fetchPhotos}
        />
      )}

      {/* Lightbox Preview Dialog */}
      <Dialog open={previewDialogOpen} onOpenChange={setPreviewDialogOpen}>
        <DialogContent className="max-w-[95vw] w-[95vw] max-h-[95vh] h-[95vh] p-0 overflow-hidden flex flex-col">
          <DialogHeader className="p-4 pb-2 shrink-0">
            <div className="flex items-center justify-between">
              <DialogTitle className="truncate pr-4">{selectedPhoto?.file_name}</DialogTitle>
              <span className="text-sm text-muted-foreground whitespace-nowrap">
                {selectedPhoto ? filteredPhotos.findIndex(p => p.id === selectedPhoto.id) + 1 : 0} / {filteredPhotos.length}
              </span>
            </div>
          </DialogHeader>
          {selectedPhoto && (
            <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
              {/* Image area with navigation and zoom */}
              <LightboxImage
                src={fullResUrls[selectedPhoto.id] || ""}
                alt={selectedPhoto.file_name}
                loading={!fullResUrls[selectedPhoto.id]}
                showNav={filteredPhotos.length > 1}
                onPrev={() => navigatePhoto("prev")}
                onNext={() => navigatePhoto("next")}
                photoId={selectedPhoto.id}
              />

              {/* Details panel */}
              <div className="shrink-0 max-h-[30vh] overflow-y-auto p-4 border-t space-y-3">
                <div className="flex justify-between items-start">
                  <div>
                    <Badge>{selectedPhoto.category}</Badge>
                    {selectedPhoto.description && (
                      <p className="text-sm text-muted-foreground mt-2">{selectedPhoto.description}</p>
                    )}
                  </div>
                </div>

                {/* AI Analysis Section */}
                {selectedPhoto.ai_analyzed_at ? (
                  <div className="border rounded-lg p-4 bg-card space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2 text-sm font-medium">
                        <Brain className="h-4 w-4 text-primary" />
                        <span>Darwin AI Analysis</span>
                        <Badge variant="outline" className="text-xs">
                          {new Date(selectedPhoto.ai_analyzed_at).toLocaleDateString()}
                        </Badge>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          analyzePhoto(selectedPhoto.id);
                          toast({ title: "Re-analyzing photo with Darwin..." });
                        }}
                      >
                        <Sparkles className="h-3 w-3 mr-1" />
                        Re-analyze
                      </Button>
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                      {selectedPhoto.ai_material_type && (
                        <div>
                          <p className="text-xs text-muted-foreground">Material</p>
                          <p className="text-sm font-medium capitalize">{selectedPhoto.ai_material_type}</p>
                        </div>
                      )}
                      {selectedPhoto.ai_condition_rating && (
                        <div>
                          <p className="text-xs text-muted-foreground">Condition</p>
                          <ConditionBadge rating={selectedPhoto.ai_condition_rating} />
                        </div>
                      )}
                    </div>

                    {selectedPhoto.ai_condition_notes && (
                      <div>
                        <p className="text-xs text-muted-foreground mb-1">Condition Notes</p>
                        <p className="text-sm">{selectedPhoto.ai_condition_notes}</p>
                      </div>
                    )}

                    {selectedPhoto.ai_detected_damages && Array.isArray(selectedPhoto.ai_detected_damages) && selectedPhoto.ai_detected_damages.length > 0 && (
                      <div>
                        <p className="text-xs text-muted-foreground mb-2">Detected Damages</p>
                        <div className="space-y-2">
                          {selectedPhoto.ai_detected_damages.map((damage: any, idx: number) => (
                            <div key={idx} className="flex items-start gap-2 p-2 bg-destructive/10 border border-destructive/20 rounded text-sm">
                              <AlertTriangle className="h-4 w-4 text-destructive mt-0.5 flex-shrink-0" />
                              <div>
                                <span className="font-medium">{damage.type}</span>
                                <span className="text-muted-foreground"> ({damage.severity})</span>
                                {damage.location && <span className="text-muted-foreground"> - {damage.location}</span>}
                                {damage.notes && <p className="text-xs text-muted-foreground mt-1">{damage.notes}</p>}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {selectedPhoto.ai_analysis_summary && (
                      <div className="p-2 bg-muted rounded text-sm">
                        <p className="text-xs text-muted-foreground mb-1">Summary</p>
                        {selectedPhoto.ai_analysis_summary}
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="border rounded-lg p-4 bg-muted/50 text-center">
                    <Brain className="h-8 w-8 text-muted-foreground mx-auto mb-2" />
                    <p className="text-sm text-muted-foreground">AI analysis not yet available</p>
                    <Button 
                      variant="outline" 
                      size="sm" 
                      className="mt-2"
                      onClick={() => {
                        analyzePhoto(selectedPhoto.id);
                        toast({ title: "Darwin is analyzing this photo..." });
                      }}
                    >
                      <Sparkles className="h-3 w-3 mr-1" />
                      Analyze Now
                    </Button>
                  </div>
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Camera Dialog */}
      <Dialog open={cameraDialogOpen} onOpenChange={(open) => { if (!open) stopCamera(); }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Take Photo</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="relative bg-black rounded-lg overflow-hidden aspect-video">
              <video 
                ref={videoRef} 
                autoPlay 
                playsInline 
                muted 
                className="w-full h-full object-cover"
              />
              <canvas ref={canvasRef} className="hidden" />
            </div>
            <div>
              <Label>Category</Label>
              <Select value={uploadCategory} onValueChange={setUploadCategory}>
                <SelectTrigger className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PHOTO_CATEGORIES.map(cat => (
                    <SelectItem key={cat} value={cat}>{cat}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={stopCamera}>Close</Button>
            <Button onClick={capturePhoto} disabled={uploading}>
              <Camera className="h-4 w-4 mr-2" />
              {uploading ? "Saving..." : "Capture"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Report Dialog */}
      <PhotoReportDialog
        open={reportDialogOpen}
        onOpenChange={setReportDialogOpen}
        photos={photos}
        claim={claim}
        claimId={claimId}
      />

      {/* Photo Damage Analyzer */}
      <PhotoDamageFindings
        claimId={claimId}
        photoCount={photos.length}
        pagePhotoIds={paginatedPhotos.map(p => p.id)}
        currentPage={currentPage}
        totalPages={totalPages}
      />
    </div>
  );
}
// Lightbox image with zoom + pan
function LightboxImage({ src, alt, loading, showNav, onPrev, onNext, photoId }: {
  src: string; alt: string; loading: boolean; showNav: boolean;
  onPrev: () => void; onNext: () => void; photoId: string;
}) {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const dragStart = useRef({ x: 0, y: 0, panX: 0, panY: 0 });
  const containerRef = useRef<HTMLDivElement>(null);

  // Reset zoom/pan when photo changes
  useEffect(() => { setZoom(1); setPan({ x: 0, y: 0 }); }, [photoId]);

  const handleZoom = useCallback((delta: number) => {
    setZoom(prev => {
      const next = Math.min(5, Math.max(1, prev + delta));
      if (next === 1) setPan({ x: 0, y: 0 });
      return next;
    });
  }, []);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    handleZoom(e.deltaY > 0 ? -0.3 : 0.3);
  }, [handleZoom]);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (zoom <= 1) return;
    setIsDragging(true);
    dragStart.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, [zoom, pan]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!isDragging) return;
    setPan({
      x: dragStart.current.panX + (e.clientX - dragStart.current.x),
      y: dragStart.current.panY + (e.clientY - dragStart.current.y),
    });
  }, [isDragging]);

  const handlePointerUp = useCallback(() => { setIsDragging(false); }, []);

  return (
    <div
      ref={containerRef}
      className="flex-1 relative flex items-center justify-center bg-black/5 dark:bg-black/20 min-h-0 px-12 overflow-hidden select-none"
      onWheel={handleWheel}
    >
      {showNav && (
        <Button variant="ghost" size="icon"
          className="absolute left-2 z-10 h-10 w-10 rounded-full bg-background/80 hover:bg-background shadow"
          onClick={(e) => { e.stopPropagation(); onPrev(); }}>
          <ChevronLeft className="h-5 w-5" />
        </Button>
      )}

      {loading ? (
        <div className="flex items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <img
          src={src} alt={alt}
          className="max-h-full max-w-full object-contain transition-transform duration-150"
          style={{
            transform: `scale(${zoom}) translate(${pan.x / zoom}px, ${pan.y / zoom}px)`,
            cursor: zoom > 1 ? (isDragging ? "grabbing" : "grab") : "zoom-in",
          }}
          draggable={false}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onClick={() => { if (zoom === 1) handleZoom(1); }}
        />
      )}

      {showNav && (
        <Button variant="ghost" size="icon"
          className="absolute right-2 z-10 h-10 w-10 rounded-full bg-background/80 hover:bg-background shadow"
          onClick={(e) => { e.stopPropagation(); onNext(); }}>
          <ChevronRight className="h-5 w-5" />
        </Button>
      )}

      {/* Zoom controls */}
      <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-10 flex items-center gap-1 bg-background/80 backdrop-blur-sm rounded-full px-2 py-1 shadow">
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => handleZoom(-0.5)} disabled={zoom <= 1}>
          <ZoomOut className="h-4 w-4" />
        </Button>
        <span className="text-xs font-medium w-12 text-center">{Math.round(zoom * 100)}%</span>
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => handleZoom(0.5)} disabled={zoom >= 5}>
          <ZoomIn className="h-4 w-4" />
        </Button>
        {zoom > 1 && (
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }}>
            <RotateCcw className="h-4 w-4" />
          </Button>
        )}
      </div>
    </div>
  );
}


const PhotoCard = memo(function PhotoCard({ 
  photo, 
  imageUrl,
  selected, 
  onSelect, 
  onEdit, 
  onAnnotate, 
  onDelete,
  onPreview,
  compact = false 
}: { 
  photo: ClaimPhoto; 
  imageUrl: string;
  selected: boolean;
  onSelect: () => void;
  onEdit: () => void;
  onAnnotate: () => void;
  onDelete: () => void;
  onPreview: () => void;
  compact?: boolean;
}) {
  return (
    <TooltipProvider>
      <Card 
        className={`overflow-hidden cursor-pointer transition-all ${selected ? "ring-2 ring-primary" : ""}`}
        onClick={onPreview}
      >
        <div className="relative aspect-square">
          {imageUrl ? (
            <img
              src={imageUrl}
              alt={photo.file_name}
              className="w-full h-full object-cover"
              loading="lazy"
            />
          ) : (
            <div className="w-full h-full bg-muted flex items-center justify-center">
              <Camera className="h-8 w-8 text-muted-foreground animate-pulse" />
            </div>
          )}
          {photo.annotated_file_path && (
            <Badge className="absolute top-2 left-2" variant="secondary">
              <Pencil className="h-3 w-3 mr-1" />
              Annotated
            </Badge>
          )}
          {photo.before_after_type && (
            <Badge className="absolute top-2 right-2" variant="outline">
              {photo.before_after_type === "before" ? "Before" : "After"}
            </Badge>
          )}
          {/* AI Analysis Indicator */}
          {photo.ai_analyzed_at && (
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="absolute bottom-2 left-2">
                  <ConditionIndicator rating={photo.ai_condition_rating} damages={photo.ai_detected_damages} />
                </div>
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-xs">
                <div className="text-xs space-y-1">
                  {photo.ai_material_type && <p><strong>Material:</strong> {photo.ai_material_type}</p>}
                  {photo.ai_condition_rating && <p><strong>Condition:</strong> {photo.ai_condition_rating}</p>}
                  {photo.ai_detected_damages && Array.isArray(photo.ai_detected_damages) && photo.ai_detected_damages.length > 0 && (
                    <p><strong>Damages:</strong> {photo.ai_detected_damages.map((d: any) => d.type).join(", ")}</p>
                  )}
                  {photo.ai_analysis_summary && <p className="italic">{photo.ai_analysis_summary}</p>}
                </div>
              </TooltipContent>
            </Tooltip>
          )}
        </div>
        {!compact && (
          <CardContent className="p-2">
            <p className="text-xs font-medium truncate">{photo.category}</p>
            {photo.ai_analysis_summary ? (
              <p className="text-xs text-muted-foreground truncate">{photo.ai_analysis_summary}</p>
            ) : photo.description ? (
              <p className="text-xs text-muted-foreground truncate">{photo.description}</p>
            ) : null}
            <div className="flex gap-1 mt-2" onClick={(e) => e.stopPropagation()}>
              <Button variant={selected ? "secondary" : "ghost"} size="icon" className="h-7 w-7" onClick={onSelect}>
                <CheckCircle2 className={`h-3 w-3 ${selected ? "text-primary" : ""}`} />
              </Button>
              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onAnnotate}>
                <Pencil className="h-3 w-3" />
              </Button>
              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onEdit}>
                <FileText className="h-3 w-3" />
              </Button>
              <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={onDelete}>
                <Trash2 className="h-3 w-3" />
              </Button>
            </div>
          </CardContent>
        )}
      </Card>
    </TooltipProvider>
  );
});

// Helper component to show condition indicator on photo cards
function ConditionIndicator({ rating, damages }: { rating: string | null; damages: any }) {
  const hasDamages = damages && Array.isArray(damages) && damages.length > 0;
  
  if (rating === "failed" || rating === "poor" || hasDamages) {
    return (
      <Badge variant="destructive" className="text-xs gap-1">
        <AlertTriangle className="h-3 w-3" />
        {hasDamages ? `${damages.length} damage${damages.length > 1 ? 's' : ''}` : rating}
      </Badge>
    );
  }
  
  if (rating === "fair") {
    return (
      <Badge variant="secondary" className="text-xs gap-1 bg-yellow-500/20 text-yellow-700 dark:text-yellow-400">
        <HelpCircle className="h-3 w-3" />
        Fair
      </Badge>
    );
  }
  
  if (rating === "good" || rating === "excellent") {
    return (
      <Badge variant="secondary" className="text-xs gap-1 bg-green-500/20 text-green-700 dark:text-green-400">
        <CheckCircle2 className="h-3 w-3" />
        {rating}
      </Badge>
    );
  }
  
  return (
    <Badge variant="outline" className="text-xs gap-1">
      <Brain className="h-3 w-3" />
      AI
    </Badge>
  );
}

// Helper component for condition badge
function ConditionBadge({ rating }: { rating: string }) {
  const variants: Record<string, string> = {
    excellent: "bg-green-500/20 text-green-700 dark:text-green-400",
    good: "bg-green-500/15 text-green-600 dark:text-green-500",
    fair: "bg-yellow-500/20 text-yellow-700 dark:text-yellow-400",
    poor: "bg-orange-500/20 text-orange-700 dark:text-orange-400",
    failed: "bg-destructive/20 text-destructive",
  };
  
  return (
    <Badge variant="secondary" className={`capitalize ${variants[rating] || ""}`}>
      {rating}
    </Badge>
  );
}

function PhotoPreview({ photo, imageUrl }: { photo: ClaimPhoto; imageUrl: string }) {
  return imageUrl ? (
    <img src={imageUrl} alt={photo.file_name} className="max-h-[60vh] mx-auto rounded" />
  ) : (
    <div className="h-64 bg-muted flex items-center justify-center rounded">
      <Camera className="h-8 w-8 text-muted-foreground" />
    </div>
  );
}

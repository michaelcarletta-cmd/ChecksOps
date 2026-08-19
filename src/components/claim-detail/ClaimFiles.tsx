import { useState } from "react";
import { Button } from "@/components/ui/button";
import { FileText, Image, Download, Upload, Eye, Folder, Plus, FolderPlus, File as FileIcon, FileUp, Trash2, ExternalLink, Copy, Calculator, Bot, RefreshCw, Loader2, ChevronRight, AlertTriangle, CheckCircle2, XCircle, ScanLine, Zap, FileSignature } from "lucide-react";
import { DOCUMENT_TYPE_LABELS, TEXT_QUALITY_LABELS, type TextQualityStatus } from "@/lib/document-intelligence-types";
import { Badge } from "@/components/ui/badge";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ClaimTemplates } from "./ClaimTemplates";

import { EstimateUploadDialog } from "./EstimateUploadDialog";


interface ClaimFilesProps {
  claimId: string;
  claim?: any;
  isStaffOrAdmin?: boolean;
}

const getFileIcon = (type: string) => {
  if (type?.includes("image")) return Image;
  if (type?.includes("pdf")) return FileText;
  return FileIcon;
};

const formatFileSize = (bytes: number) => {
  if (!bytes) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + " " + sizes[i];
};

export const ClaimFiles = ({ claimId, claim, isStaffOrAdmin = false }: ClaimFilesProps) => {
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [uploadDialogOpen, setUploadDialogOpen] = useState(false);
  const [folderDialogOpen, setFolderDialogOpen] = useState(false);
  const [subfolderDialogOpen, setSubfolderDialogOpen] = useState(false);
  const [subfolderParentId, setSubfolderParentId] = useState<string | null>(null);
  const [newFolderName, setNewFolderName] = useState("");
  const [uploadingFile, setUploadingFile] = useState(false);
  const [saveAsTemplateDialogOpen, setSaveAsTemplateDialogOpen] = useState(false);
  const [previewDialogOpen, setPreviewDialogOpen] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewFileType, setPreviewFileType] = useState<string>("");
  const [selectedFile, setSelectedFile] = useState<any>(null);
  const [estimateUploadOpen, setEstimateUploadOpen] = useState(false);
  const [estimatePromptOpen, setEstimatePromptOpen] = useState(false);
  const [pendingEstimateFile, setPendingEstimateFile] = useState<any>(null);
  const [templateForm, setTemplateForm] = useState({
    name: "",
    description: "",
    category: "Other",
  });
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Helper to detect if a file is likely an estimate
  const isEstimateFile = (fileName: string, folderName: string | null) => {
    const estimatePatterns = [
      /estimate/i, /xactimate/i, /symbility/i, /rcv/i, /acv/i, /settlement/i, /scope/i,
    ];
    const isInEstimateFolder = folderName?.toLowerCase().includes("estimate");
    const fileMatchesPattern = estimatePatterns.some(p => p.test(fileName));
    return isInEstimateFolder || fileMatchesPattern;
  };

  // Fetch folders (including subfolders via parent_folder_id)
  const { data: folders } = useQuery({
    queryKey: ["claim-folders", claimId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("claim_folders")
        .select("*")
        .eq("claim_id", claimId)
        .order("display_order", { ascending: true })
        .order("name", { ascending: true });

      if (error) throw error;
      return data;
    },
  });

  // Separate top-level folders and subfolders
  const topLevelFolders = folders?.filter(f => !f.parent_folder_id) || [];
  const getSubfolders = (parentId: string) => folders?.filter(f => f.parent_folder_id === parentId) || [];

  // Fetch files with classification + intelligence data
  const { data: files, refetch: refetchFiles } = useQuery({
    queryKey: ["claim-files", claimId],
    queryFn: async () => {
      const start = performance.now();
      const { data, error } = await supabase
        .from("claim_files")
        .select("id, claim_id, file_name, file_path, file_type, file_size, folder_id, uploaded_at, document_classification, classification_confidence, classification_metadata, processed_by_darwin, document_type, document_subtype, text_quality_status, extraction_method, is_scanned, ready_for_analysis, needs_reprocessing, processing_error, document_summary, page_count")
        .eq("claim_id", claimId)
        .order("uploaded_at", { ascending: false });
      console.log(`[query] fetchClaimFiles: ${(performance.now() - start).toFixed(2)}ms, rows: ${data?.length ?? 0}`);

      if (error) throw error;
      return data;
    },
  });

  // Bulk reprocess all files in claim
  const bulkReprocessMutation = useMutation({
    mutationFn: async () => {
      const allFiles = files || [];
      const processable = allFiles.filter(f => f.file_type?.includes('pdf') || f.file_type?.includes('text') || f.file_type?.includes('word') || /\.(pdf|docx?|txt)$/i.test(f.file_name));
      for (const file of processable) {
        await supabase.functions.invoke('darwin-process-document', {
          body: { fileId: file.id, force: true }
        });
      }
      return processable.length;
    },
    onSuccess: (count) => {
      refetchFiles();
      toast({
        title: "Bulk Reprocess Started",
        description: `${count} files queued for reprocessing.`,
      });
    },
    onError: () => {
      toast({ title: "Error", description: "Bulk reprocess failed.", variant: "destructive" });
    },
  });

  // Reprocess file with Darwin
  const reprocessFileMutation = useMutation({
    mutationFn: async (fileId: string) => {
      const { data, error } = await supabase.functions.invoke('darwin-process-document', {
        body: { fileId, force: true }
      });
      if (error) throw error;
      return data;
    },
    onMutate: () => {
      toast({
        title: "Reprocessing document...",
        description: "Analyzing and updating document type.",
      });
    },
    onSuccess: (data) => {
      refetchFiles();
      const classification = typeof data?.classification === "string"
        ? data.classification.replace(/_/g, " ").replace(/\b\w/g, (l: string) => l.toUpperCase())
        : null;
      const confidence = typeof data?.confidence === "number" ? Math.round(data.confidence * 100) : null;

      toast({
        title: "Document Reprocessed",
        description: classification
          ? `Classified as ${classification}${confidence !== null ? ` (${confidence}% confidence)` : ""}`
          : "Document was reprocessed successfully.",
      });
    },
    onError: (error: unknown) => {
      const message = error instanceof Error ? error.message : "Unable to reprocess the document.";
      toast({
        title: "Processing Error",
        description: message,
        variant: "destructive",
      });
    },
  });

  // Get classification badge color
  const getClassificationBadge = (classification: string | null, confidence: number | null) => {
    if (!classification) return null;
    
    const colors: Record<string, string> = {
      estimate: "bg-blue-500/20 text-blue-500 border-blue-500/30",
      denial: "bg-red-500/20 text-red-500 border-red-500/30",
      approval: "bg-green-500/20 text-green-500 border-green-500/30",
      rfi: "bg-amber-500/20 text-amber-500 border-amber-500/30",
      engineering_report: "bg-purple-500/20 text-purple-500 border-purple-500/30",
      policy: "bg-indigo-500/20 text-indigo-500 border-indigo-500/30",
      correspondence: "bg-slate-500/20 text-slate-400 border-slate-500/30",
      invoice: "bg-emerald-500/20 text-emerald-500 border-emerald-500/30",
      photo: "bg-pink-500/20 text-pink-500 border-pink-500/30",
      other: "bg-gray-500/20 text-gray-400 border-gray-500/30",
    };

    const label = classification.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
    const confidencePercent = confidence ? Math.round(confidence * 100) : 0;
    
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge variant="outline" className={`${colors[classification] || colors.other} text-xs`}>
              <Bot className="h-3 w-3 mr-1" />
              {label}
            </Badge>
          </TooltipTrigger>
          <TooltipContent>
            <p>Darwin classified this as {label}</p>
            <p className="text-xs text-muted-foreground">Confidence: {confidencePercent}%</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  };

  // Create folder mutation (supports subfolders)
  const createFolderMutation = useMutation({
    mutationFn: async ({ folderName, parentId }: { folderName: string; parentId?: string | null }) => {
      const { data: { user } } = await supabase.auth.getUser();
      const { data, error } = await supabase
        .from("claim_folders")
        .insert({
          claim_id: claimId,
          name: folderName,
          is_predefined: false,
          created_by: user?.id,
          parent_folder_id: parentId || null,
        })
        .select()
        .single();

      if (error) throw error;
      return data;
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ["claim-folders", claimId] });
      setFolderDialogOpen(false);
      setSubfolderDialogOpen(false);
      setSubfolderParentId(null);
      setNewFolderName("");
      toast({
        title: variables.parentId ? "Subfolder created" : "Folder created",
        description: `The ${variables.parentId ? 'subfolder' : 'folder'} has been created successfully.`,
      });
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to create folder.",
        variant: "destructive",
      });
    },
  });

  // Delete folder mutation
  const deleteFolderMutation = useMutation({
    mutationFn: async (folderId: string) => {
      // Delete all files in the folder from storage and DB
      const folderFiles = files?.filter(f => f.folder_id === folderId) || [];
      for (const file of folderFiles) {
        await supabase.storage.from("claim-files").remove([file.file_path]);
        await supabase.from("claim_files").delete().eq("id", file.id);
      }
      // Delete subfolders recursively
      const subs = folders?.filter(f => f.parent_folder_id === folderId) || [];
      for (const sub of subs) {
        await deleteFolderMutation.mutateAsync(sub.id);
      }
      // Delete the folder itself
      const { error } = await supabase.from("claim_folders").delete().eq("id", folderId);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["claim-folders", claimId] });
      queryClient.invalidateQueries({ queryKey: ["claim-files", claimId] });
      toast({ title: "Folder deleted", description: "The folder and its contents have been removed." });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to delete folder.", variant: "destructive" });
    },
  });

  const handleDeleteFolder = (folderId: string, folderName: string) => {
    const folderFiles = files?.filter(f => f.folder_id === folderId) || [];
    const subs = folders?.filter(f => f.parent_folder_id === folderId) || [];
    const msg = folderFiles.length > 0 || subs.length > 0
      ? `"${folderName}" contains ${folderFiles.length} file(s) and ${subs.length} subfolder(s). Everything inside will be permanently deleted. Continue?`
      : `Delete folder "${folderName}"?`;
    if (confirm(msg)) {
      deleteFolderMutation.mutate(folderId);
    }
  };

  // Upload file mutation
  const uploadFileMutation = useMutation({
    mutationFn: async (file: File) => {
      if (!selectedFolderId) throw new Error("No folder selected");

      const { data: { user } } = await supabase.auth.getUser();
      const fileExt = file.name.split(".").pop();
      const fileName = `${claimId}/${selectedFolderId}/${Date.now()}.${fileExt}`;

      const { error: uploadError } = await supabase.storage
        .from("claim-files")
        .upload(fileName, file);

      if (uploadError) throw uploadError;

      const { data, error } = await supabase
        .from("claim_files")
        .insert({
          claim_id: claimId,
          folder_id: selectedFolderId,
          file_name: file.name,
          file_path: fileName,
          file_size: file.size,
          file_type: file.type,
          uploaded_by: user?.id,
        })
        .select()
        .single();

      if (error) throw error;
      return data;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["claim-files", claimId] });
      
      if (data?.id) {
        supabase.functions.invoke('darwin-process-document', {
          body: { fileId: data.id }
        }).then(() => {
          setTimeout(() => refetchFiles(), 2000);
        }).catch(err => console.error('Darwin processing queued:', err));
      }
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to upload file.",
        variant: "destructive",
      });
    },
  });

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const uploadedFiles = e.target.files;
    if (!uploadedFiles || uploadedFiles.length === 0) return;

    const folder = folders?.find(f => f.id === selectedFolderId);
    const folderName = folder?.name || null;

    setUploadingFile(true);
    try {
      const uploadPromises = Array.from(uploadedFiles).map(file => uploadFileMutation.mutateAsync(file));
      const results = await Promise.all(uploadPromises);
      
      toast({
        title: uploadedFiles.length > 1 ? "Files uploaded" : "File uploaded",
        description: `${uploadedFiles.length} file${uploadedFiles.length > 1 ? 's' : ''} uploaded successfully.`,
      });

      const firstFile = uploadedFiles[0];
      if (uploadedFiles.length === 1 && isEstimateFile(firstFile.name, folderName)) {
        setPendingEstimateFile({
          file: firstFile,
          dbRecord: results[0],
        });
        setEstimatePromptOpen(true);
      }
    } catch (error) {
      // Error handled by mutation
    } finally {
      setUploadingFile(false);
      setUploadDialogOpen(false);
      setSelectedFolderId(null);
    }
  };

  const handleDownload = async (file: any) => {
    const { data, error } = await supabase.storage
      .from("claim-files")
      .createSignedUrl(file.file_path, 300, { download: file.file_name });

    if (error || !data?.signedUrl) {
      toast({ title: "Error", description: "Failed to download file.", variant: "destructive" });
      return;
    }

    const a = document.createElement("a");
    a.href = data.signedUrl;
    a.download = file.file_name;
    a.click();
  };

  const handleView = async (file: any) => {
    const { data, error } = await supabase.storage
      .from("claim-files")
      .createSignedUrl(file.file_path, 3600);

    if (error) {
      toast({ title: "Error", description: "Failed to view file.", variant: "destructive" });
      return;
    }

    setPreviewUrl(data.signedUrl);
    setPreviewFileType(file.file_type || "");
    setPreviewDialogOpen(true);
  };

  const handleSaveAsTemplate = (file: any) => {
    setSelectedFile(file);
    setTemplateForm({
      name: file.file_name.replace(/\.[^/.]+$/, ""),
      description: "",
      category: "Other",
    });
    setSaveAsTemplateDialogOpen(true);
  };

  const saveAsTemplateMutation = useMutation({
    mutationFn: async () => {
      if (!selectedFile) throw new Error("No file selected");

      const { data: fileData, error: downloadError } = await supabase.storage
        .from("claim-files")
        .download(selectedFile.file_path);

      if (downloadError) throw downloadError;

      const fileName = `${Date.now()}-${selectedFile.file_name}`;
      const { error: uploadError } = await supabase.storage
        .from("document-templates")
        .upload(fileName, fileData);

      if (uploadError) throw uploadError;

      const { error: dbError } = await supabase
        .from("document_templates")
        .insert({
          name: templateForm.name,
          description: templateForm.description,
          category: templateForm.category,
          file_path: fileName,
          file_name: selectedFile.file_name,
        });

      if (dbError) throw dbError;
    },
    onSuccess: () => {
      toast({ title: "Template created", description: "File has been saved as a template." });
      setSaveAsTemplateDialogOpen(false);
      setSelectedFile(null);
      setTemplateForm({ name: "", description: "", category: "Other" });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const deleteFileMutation = useMutation({
    mutationFn: async (file: any) => {
      const { error: storageError } = await supabase.storage
        .from("claim-files")
        .remove([file.file_path]);

      if (storageError) throw storageError;

      const { error: dbError } = await supabase
        .from("claim_files")
        .delete()
        .eq("id", file.id);

      if (dbError) throw dbError;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["claim-files", claimId] });
      toast({ title: "File deleted", description: "The file has been deleted successfully." });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to delete file.", variant: "destructive" });
    },
  });

  const handleDeleteFile = async (file: any) => {
    if (confirm("Are you sure you want to delete this file?")) {
      await deleteFileMutation.mutateAsync(file);
    }
  };

  // Render file list for a folder
  const renderFileList = (folderFiles: any[]) => {
    if (folderFiles.length === 0) {
      return (
        <p className="text-sm text-muted-foreground text-center py-4">
          No files in this folder
        </p>
      );
    }

    return (
      <div className="space-y-2">
        {folderFiles.map((file) => {
          const Icon = getFileIcon(file.file_type);
          const isReprocessing = reprocessFileMutation.isPending && reprocessFileMutation.variables === file.id;
          const qualityStatus = file.text_quality_status as TextQualityStatus | null;
          const qualityInfo = qualityStatus ? TEXT_QUALITY_LABELS[qualityStatus] : null;
          const docTypeLabel = DOCUMENT_TYPE_LABELS[file.document_classification || file.document_type || ''] || null;
          
          return (
            <div key={file.id} className="p-3 rounded-lg border border-border hover:bg-muted/30 transition-colors">
              <div className="flex items-start gap-3">
                <div className="p-2 rounded-lg bg-primary/10">
                  <Icon className="h-4 w-4" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="text-sm font-medium truncate">{file.file_name}</p>
                    {getClassificationBadge(file.document_classification, file.classification_confidence)}
                    {file.is_scanned && (
                      <Badge variant="outline" className="text-xs bg-amber-500/10 text-amber-500 border-amber-500/30">
                        <ScanLine className="h-3 w-3 mr-1" /> OCR
                      </Badge>
                    )}
                    {file.ready_for_analysis === true && (
                      <Badge variant="outline" className="text-xs bg-green-500/10 text-green-500 border-green-500/30">
                        <CheckCircle2 className="h-3 w-3 mr-1" /> Ready
                      </Badge>
                    )}
                    {file.ready_for_analysis === false && file.processed_by_darwin && (
                      <Badge variant="outline" className="text-xs bg-red-500/10 text-red-500 border-red-500/30">
                        <XCircle className="h-3 w-3 mr-1" /> Blocked
                      </Badge>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    {formatFileSize(file.file_size || 0)} •{" "}
                    {new Date(file.uploaded_at).toLocaleDateString()}
                    {docTypeLabel && <span className="ml-1">• {docTypeLabel}</span>}
                    {file.document_subtype && <span className="ml-1 opacity-70">({file.document_subtype.replace(/_/g, ' ')})</span>}
                    {qualityInfo && <span className={`ml-1 ${qualityInfo.color}`}>• Text: {qualityInfo.label}</span>}
                    {file.extraction_method && file.extraction_method !== 'none' && (
                      <span className="ml-1 opacity-70">• {file.extraction_method.replace(/_/g, ' ')}</span>
                    )}
                    {file.page_count && <span className="ml-1">• {file.page_count}p</span>}
                  </p>
                  {file.document_summary && (
                    <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1 italic">
                      {file.document_summary}
                    </p>
                  )}
                  {file.processing_error && (
                    <p className="text-xs text-destructive mt-0.5 flex items-center gap-1">
                      <AlertTriangle className="h-3 w-3" /> {file.processing_error}
                    </p>
                  )}
                  {file.needs_reprocessing && !file.processing_error && (
                    <p className="text-xs text-amber-500 mt-0.5 flex items-center gap-1">
                      <AlertTriangle className="h-3 w-3" /> Needs reprocessing
                    </p>
                  )}
                  <div className="flex gap-2 mt-2 flex-wrap">
                    <Button variant="outline" size="sm" onClick={() => handleView(file)}>
                      <Eye className="h-3 w-3 mr-1" /> View
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => handleDownload(file)}>
                      <Download className="h-3 w-3 mr-1" /> Download
                    </Button>
                    {file.file_type?.includes("pdf") && (
                      <Button 
                        variant="outline" 
                        size="sm" 
                        className="text-amber-500 border-amber-500/30 hover:bg-amber-500/10"
                        onClick={() => {
                          const tabsList = document.querySelector('[role="tablist"]');
                          const sigTrigger = tabsList?.querySelector('[value="templates"]');
                          if (sigTrigger instanceof HTMLElement) {
                            sigTrigger.click();
                            // We pass state via local storage or a more robust state management if needed, 
                            // but for now, switching tabs is the first step.
                            // To make it seamless, we could use a custom event or store the file in a shared state.
                            toast({
                              title: "Switching to Signatures",
                              description: "Select 'Request Signature' and choose this file from 'Claim Files'.",
                            });
                          }
                        }}
                      >
                        <FileSignature className="h-3 w-3 mr-1" /> Send for Signature
                      </Button>
                    )}
                    {(file.file_name.toLowerCase().endsWith('.docx') || file.file_name.toLowerCase().endsWith('.pdf')) && (
                      <Button variant="outline" size="sm" onClick={() => handleSaveAsTemplate(file)}>
                        <FileUp className="h-3 w-3 mr-1" /> Save as Template
                      </Button>
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      title="Re-analyze document type"
                      onClick={() => reprocessFileMutation.mutate(file.id)}
                      disabled={isReprocessing}
                    >
                      {isReprocessing ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <RefreshCw className="h-3 w-3 mr-1" />}
                      {isReprocessing ? "Processing..." : "Reprocess"}
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => handleDeleteFile(file)}>
                      <Trash2 className="h-3 w-3 mr-1" /> Delete
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  // Render upload button for a folder
  const renderUploadButton = (folderId: string, folderName: string) => (
    <Dialog open={uploadDialogOpen && selectedFolderId === folderId} onOpenChange={(open) => {
      setUploadDialogOpen(open);
      if (!open) setSelectedFolderId(null);
    }}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="w-full" onClick={() => setSelectedFolderId(folderId)}>
          <Upload className="h-4 w-4 mr-2" /> Upload File
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Upload File to {folderName}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <Input type="file" multiple onChange={handleFileUpload} disabled={uploadingFile} />
        </div>
      </DialogContent>
    </Dialog>
  );

  // Render subfolders inside a parent folder
  const renderSubfolders = (parentId: string) => {
    const subs = getSubfolders(parentId);
    if (subs.length === 0) return null;

    return (
      <Accordion type="multiple" className="w-full space-y-1 mt-2">
        {subs.map((sub) => {
          const subFiles = files?.filter((f) => f.folder_id === sub.id) || [];
          const nestedSubs = getSubfolders(sub.id);
          
          return (
            <AccordionItem key={sub.id} value={sub.id} className="border rounded-lg bg-muted/20">
              <AccordionTrigger className="px-3 py-2 hover:no-underline hover:bg-muted/30">
                <div className="flex items-center gap-2">
                  <ChevronRight className="h-3 w-3 text-muted-foreground" />
                  <Folder className="h-4 w-4 text-primary/70" />
                  <span className="font-medium text-sm text-foreground">{sub.name}</span>
                  <Badge variant="secondary" className="ml-1 text-xs">
                    {subFiles.length}
                  </Badge>
                </div>
              </AccordionTrigger>
              <AccordionContent className="px-3 pb-3">
                <div className="space-y-3 mt-2">
                  <div className="flex gap-2">
                    {renderUploadButton(sub.id, sub.name)}
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setSubfolderParentId(sub.id);
                        setSubfolderDialogOpen(true);
                      }}
                    >
                      <FolderPlus className="h-4 w-4 mr-1" />
                      Subfolder
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="text-destructive hover:text-destructive"
                      onClick={() => handleDeleteFolder(sub.id, sub.name)}
                      disabled={deleteFolderMutation.isPending}
                    >
                      <Trash2 className="h-4 w-4 mr-1" />
                      Delete
                    </Button>
                  </div>
                  {renderFileList(subFiles)}
                  {nestedSubs.length > 0 && renderSubfolders(sub.id)}
                </div>
              </AccordionContent>
            </AccordionItem>
          );
        })}
      </Accordion>
    );
  };

  return (
    <Tabs defaultValue="files" className="w-full">
      <TabsList className="flex flex-row w-full bg-muted/40 p-2 gap-1 overflow-x-auto scrollbar-hide">
        <TabsTrigger value="files" className="flex-1 md:flex-none justify-start text-base font-medium px-4 whitespace-nowrap">Documents & Files</TabsTrigger>
        {claim && (
          <TabsTrigger value="templates" className="flex-1 md:flex-none justify-start text-base font-medium px-4 whitespace-nowrap">Templates & Signatures</TabsTrigger>
        )}
      </TabsList>

      <TabsContent value="files" className="space-y-4 mt-4">
        <div className="flex justify-between items-center flex-wrap gap-2">
          <h3 className="text-lg font-semibold">Documents & Files</h3>
          <div className="flex flex-wrap gap-2">
            {isStaffOrAdmin && claim?.policyholder_address && (
              <Button
                variant="outline"
                onClick={() => {
                  navigator.clipboard.writeText(claim.policyholder_address);
                  toast({ title: "Address copied", description: "Property address copied to clipboard." });
                }}
              >
                <Copy className="h-4 w-4 mr-2" /> Copy Address
              </Button>
            )}
            {isStaffOrAdmin && (
              <Button variant="outline" onClick={() => window.open("https://ssoext.gaf.com/oauth2/ausclyogeZBNESNcI4x6/v1/authorize?client_id=0oaclwmauH1TXBDzU4x6&code_challenge=5w3eWPZzMixtrRpmMsiaB-kkOrB6f0iptcPGkKehUHU&code_challenge_method=S256&nonce=zCbdYnAIj7cBfgWxzMPjoxyi0ftuviGSK8qw3SiigZHS0KqaDOYVOei142d5znNF&redirect_uri=https%3A%2F%2Fquickmeasure.gaf.com%2Fcallback&response_type=code&state=thy7nldi3KrQQkvaxuvNMe92rjHE0kqxXKEOIjdVXDSOXrjW31jo58XUBnAtEOKi&scope=openid%20profile%20email%20openid%20email%20profile%20CheckCoverage%20IsServiceOpen%20SiteStatus%20SendErrorReport%20SearchOrders%20PlaceOrder%20InitiatePayment%20UpdatePayment%20IsValidPromoCode%20RedeemPromoCode%20SearchReceipts%20DownloadRoofReport%20GetUserProfile%20SaveUserProfile%20GetLookup%20User%3ASavePreferences%20User%3AGetPreferences%20User%3AGetAvailableAddresses%20User%3ASetNotificationLog%20User%3AGetReplenishmentPreferences%20User%3ASaveReplenishmentPreferences%20User%3AGetProductPreferences%20User%3ASaveProductPreferences%20User%3AAcceptTermsAndConditions%20User%3AGetAccountPreferences%20User%3ASaveAccountPreferences%20Track%20Guest%3AAcceptTermsAndConditions%20GetDistributorsForPostalCode%20UpdateOrderService%20DownloadFile%20BPFileupload%20Orders%3AShareOrder%20Orders%3AGetSharedOrder", "_blank")}>
                <ExternalLink className="h-4 w-4 mr-2" /> GAF QuickMeasure
              </Button>
            )}
            {isStaffOrAdmin && (
              <Button variant="outline" onClick={() => window.open("https://xactimate.com/xor/sign-in?utm_source=xactimate&utm_medium=referral&utm_campaign=login_page&utm_content=sign_in_btn", "_blank")}>
                <ExternalLink className="h-4 w-4 mr-2" /> Xactimate
              </Button>
            )}
            {isStaffOrAdmin && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => bulkReprocessMutation.mutate()}
                disabled={bulkReprocessMutation.isPending}
              >
                {bulkReprocessMutation.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Zap className="h-4 w-4 mr-2" />}
                {bulkReprocessMutation.isPending ? "Reprocessing..." : "Reprocess All"}
              </Button>
            )}
            
            {/* New Folder - available to all users */}
            <Dialog open={folderDialogOpen} onOpenChange={setFolderDialogOpen}>
              <DialogTrigger asChild>
                <Button variant="outline">
                  <FolderPlus className="h-4 w-4 mr-2" /> New Folder
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Create New Folder</DialogTitle>
                </DialogHeader>
                <div className="space-y-4">
                  <div>
                    <Label htmlFor="folderName">Folder Name</Label>
                    <Input
                      id="folderName"
                      value={newFolderName}
                      onChange={(e) => setNewFolderName(e.target.value)}
                      placeholder="Enter folder name"
                    />
                  </div>
                  <Button
                    onClick={() => createFolderMutation.mutate({ folderName: newFolderName })}
                    disabled={!newFolderName.trim() || createFolderMutation.isPending}
                    className="w-full"
                  >
                    Create Folder
                  </Button>
                </div>
              </DialogContent>
            </Dialog>
          </div>
        </div>

      <Accordion type="multiple" className="w-full space-y-2">
        {topLevelFolders.map((folder) => {
          const folderFiles = files?.filter((f) => f.folder_id === folder.id) || [];
          const subs = getSubfolders(folder.id);
          const totalSubFiles = subs.reduce((acc, sub) => acc + (files?.filter(f => f.folder_id === sub.id).length || 0), 0);
          
          return (
            <AccordionItem key={folder.id} value={folder.id} className="border rounded-lg bg-card">
              <AccordionTrigger className="px-4 hover:no-underline hover:bg-muted/30">
                <div className="flex items-center gap-2">
                  <Folder className="h-4 w-4 text-primary" />
                  <span className="font-medium text-foreground">{folder.name}</span>
                  <Badge variant="secondary" className="ml-2">
                    {folderFiles.length}{subs.length > 0 ? ` + ${totalSubFiles}` : ''}
                  </Badge>
                  {subs.length > 0 && (
                    <Badge variant="outline" className="text-xs text-muted-foreground">
                      {subs.length} subfolder{subs.length > 1 ? 's' : ''}
                    </Badge>
                  )}
                </div>
              </AccordionTrigger>
              <AccordionContent className="px-4 pb-4">
                <div className="space-y-3 mt-3">
                   <div className="flex gap-2">
                    {renderUploadButton(folder.id, folder.name)}
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setSubfolderParentId(folder.id);
                        setSubfolderDialogOpen(true);
                      }}
                    >
                      <FolderPlus className="h-4 w-4 mr-1" />
                      Subfolder
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="text-destructive hover:text-destructive"
                      onClick={() => handleDeleteFolder(folder.id, folder.name)}
                      disabled={deleteFolderMutation.isPending}
                    >
                      <Trash2 className="h-4 w-4 mr-1" />
                      Delete
                    </Button>
                  </div>

                  {renderFileList(folderFiles)}
                  {renderSubfolders(folder.id)}
                </div>
              </AccordionContent>
            </AccordionItem>
          );
        })}
      </Accordion>

      {!folders?.length && (
        <p className="text-muted-foreground text-center py-8">
          No folders yet. Create your first folder to start uploading files.
        </p>
      )}

      {/* Subfolder Dialog */}
      <Dialog open={subfolderDialogOpen} onOpenChange={(open) => {
        setSubfolderDialogOpen(open);
        if (!open) { setSubfolderParentId(null); setNewFolderName(""); }
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create Subfolder</DialogTitle>
            <DialogDescription>
              Create a subfolder inside "{folders?.find(f => f.id === subfolderParentId)?.name}"
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label htmlFor="subfolderName">Subfolder Name</Label>
              <Input
                id="subfolderName"
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                placeholder="Enter subfolder name"
              />
            </div>
            <Button
              onClick={() => createFolderMutation.mutate({ folderName: newFolderName, parentId: subfolderParentId })}
              disabled={!newFolderName.trim() || createFolderMutation.isPending}
              className="w-full"
            >
              {createFolderMutation.isPending ? "Creating..." : "Create Subfolder"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Save as Template Dialog */}
      <Dialog open={saveAsTemplateDialogOpen} onOpenChange={setSaveAsTemplateDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Save as Template</DialogTitle>
            <DialogDescription>Save this document as a reusable template for future claims</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Template Name</Label>
              <Input value={templateForm.name} onChange={(e) => setTemplateForm({ ...templateForm, name: e.target.value })} placeholder="e.g., Standard Contract" />
            </div>
            <div>
              <Label>Description</Label>
              <Textarea value={templateForm.description} onChange={(e) => setTemplateForm({ ...templateForm, description: e.target.value })} placeholder="Optional description" />
            </div>
            <div>
              <Label>Category</Label>
              <Select value={templateForm.category} onValueChange={(value) => setTemplateForm({ ...templateForm, category: value })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="Contract">Contract</SelectItem>
                  <SelectItem value="Invoice">Invoice</SelectItem>
                  <SelectItem value="Letter">Letter</SelectItem>
                  <SelectItem value="Form">Form</SelectItem>
                  <SelectItem value="Other">Other</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSaveAsTemplateDialogOpen(false)}>Cancel</Button>
            <Button onClick={() => saveAsTemplateMutation.mutate()} disabled={!templateForm.name || saveAsTemplateMutation.isPending}>
              {saveAsTemplateMutation.isPending ? "Saving..." : "Save as Template"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* File Preview Dialog */}
      <Dialog open={previewDialogOpen} onOpenChange={setPreviewDialogOpen}>
        <DialogContent className="max-w-4xl max-h-[90vh]">
          <DialogHeader>
            <DialogTitle>File Preview</DialogTitle>
          </DialogHeader>
          <div className="overflow-auto max-h-[70vh]">
            {previewUrl && (
              <>
                {previewFileType.includes("image") ? (
                  <img src={previewUrl} alt="Preview" className="w-full h-auto rounded-lg" />
                ) : previewFileType.includes("pdf") ? (
                  <iframe src={previewUrl} className="w-full h-[70vh] rounded-lg border" title="PDF Preview" />
                ) : (
                  <div className="text-center py-8">
                    <FileText className="h-16 w-16 mx-auto text-muted-foreground mb-4" />
                    <p className="text-muted-foreground mb-4">Preview not available for this file type</p>
                    <Button onClick={() => window.open(previewUrl, "_blank")}>Open in New Tab</Button>
                  </div>
                )}
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>
      </TabsContent>

      {claim && (
        <TabsContent value="templates" className="mt-4 space-y-4">
          <ClaimTemplates claimId={claimId} claim={claim} />
        </TabsContent>
      )}

      {/* Estimate Upload Dialog */}
      <EstimateUploadDialog open={estimateUploadOpen} onOpenChange={setEstimateUploadOpen} claimId={claimId} />

      {/* Estimate Detection Prompt */}
      <Dialog open={estimatePromptOpen} onOpenChange={setEstimatePromptOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Calculator className="h-5 w-5" /> Estimate Detected
            </DialogTitle>
            <DialogDescription>
              This file appears to be an insurance estimate. Would you like to extract the financial figures and populate them into the Accounting tab?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" onClick={() => { setEstimatePromptOpen(false); setPendingEstimateFile(null); }}>
              No, just upload
            </Button>
            <Button onClick={() => { setEstimatePromptOpen(false); setEstimateUploadOpen(true); }}>
              <Calculator className="h-4 w-4 mr-2" /> Extract & Populate
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Tabs>
  );
};

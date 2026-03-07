import { useState } from "react";
import { Button } from "@/components/ui/button";
import { FileText, Image, Download, Upload, Eye, Folder, Plus, FolderPlus, File as FileIcon, FileUp, Trash2, ExternalLink, Copy, Calculator, Bot, RefreshCw, Loader2 } from "lucide-react";
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
      /estimate/i,
      /xactimate/i,
      /symbility/i,
      /rcv/i,
      /acv/i,
      /settlement/i,
      /scope/i,
    ];
    const isInEstimateFolder = folderName?.toLowerCase().includes("estimate");
    const fileMatchesPattern = estimatePatterns.some(p => p.test(fileName));
    return isInEstimateFolder || fileMatchesPattern;
  };

  // Fetch folders
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

  // Fetch files with classification data
  const { data: files, refetch: refetchFiles } = useQuery({
    queryKey: ["claim-files", claimId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("claim_files")
        .select("*, document_classification, classification_confidence, classification_metadata, processed_by_darwin")
        .eq("claim_id", claimId)
        .order("uploaded_at", { ascending: false });

      if (error) throw error;
      return data;
    },
  });

  // Reprocess file with Darwin
  const reprocessFileMutation = useMutation({
    mutationFn: async (fileId: string) => {
      const { data, error } = await supabase.functions.invoke('darwin-process-document', {
        body: { fileId }
      });
      if (error) throw error;
      return data;
    },
    onSuccess: (data) => {
      refetchFiles();
      toast({
        title: "Document Reprocessed",
        description: `Classified as ${data.classification} (${Math.round((data.confidence || 0) * 100)}% confidence)`,
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Processing Error",
        description: error.message,
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

  // Create folder mutation
  const createFolderMutation = useMutation({
    mutationFn: async (folderName: string) => {
      const { data: { user } } = await supabase.auth.getUser();
      const { data, error } = await supabase
        .from("claim_folders")
        .insert({
          claim_id: claimId,
          name: folderName,
          is_predefined: false,
          created_by: user?.id,
        })
        .select()
        .single();

      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["claim-folders", claimId] });
      setFolderDialogOpen(false);
      setNewFolderName("");
      toast({
        title: "Folder created",
        description: "The folder has been created successfully.",
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

  // Upload file mutation
  const uploadFileMutation = useMutation({
    mutationFn: async (file: File) => {
      if (!selectedFolderId) throw new Error("No folder selected");

      const { data: { user } } = await supabase.auth.getUser();
      const fileExt = file.name.split(".").pop();
      const fileName = `${claimId}/${selectedFolderId}/${Date.now()}.${fileExt}`;

      // Upload to storage
      const { error: uploadError } = await supabase.storage
        .from("claim-files")
        .upload(fileName, file);

      if (uploadError) throw uploadError;

      // Create database record
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
      
      // Trigger Darwin classification immediately (non-blocking)
      if (data?.id) {
        supabase.functions.invoke('darwin-process-document', {
          body: { fileId: data.id }
        }).then(() => {
          // Refetch to show updated classification
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

    // Get folder name for estimate detection
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

      // Check if any uploaded file is an estimate
      const firstFile = uploadedFiles[0];
      if (uploadedFiles.length === 1 && isEstimateFile(firstFile.name, folderName)) {
        // Store the file info for potential estimate extraction
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
      .download(file.file_path);

    if (error) {
      toast({
        title: "Error",
        description: "Failed to download file.",
        variant: "destructive",
      });
      return;
    }

    const url = URL.createObjectURL(data);
    const a = document.createElement("a");
    a.href = url;
    a.download = file.file_name;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleView = async (file: any) => {
    const { data, error } = await supabase.storage
      .from("claim-files")
      .createSignedUrl(file.file_path, 3600);

    if (error) {
      toast({
        title: "Error",
        description: "Failed to view file.",
        variant: "destructive",
      });
      return;
    }

    setPreviewUrl(data.signedUrl);
    setPreviewFileType(file.file_type || "");
    setPreviewDialogOpen(true);
  };

  const handleSaveAsTemplate = (file: any) => {
    setSelectedFile(file);
    setTemplateForm({
      name: file.file_name.replace(/\.[^/.]+$/, ""), // Remove extension
      description: "",
      category: "Other",
    });
    setSaveAsTemplateDialogOpen(true);
  };

  const saveAsTemplateMutation = useMutation({
    mutationFn: async () => {
      if (!selectedFile) throw new Error("No file selected");

      // Download the file from claim-files
      const { data: fileData, error: downloadError } = await supabase.storage
        .from("claim-files")
        .download(selectedFile.file_path);

      if (downloadError) throw downloadError;

      // Upload to document-templates bucket
      const fileName = `${Date.now()}-${selectedFile.file_name}`;
      const { error: uploadError } = await supabase.storage
        .from("document-templates")
        .upload(fileName, fileData);

      if (uploadError) throw uploadError;

      // Create template record
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
      toast({
        title: "Template created",
        description: "File has been saved as a template.",
      });
      setSaveAsTemplateDialogOpen(false);
      setSelectedFile(null);
      setTemplateForm({ name: "", description: "", category: "Other" });
    },
    onError: (error: Error) => {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const deleteFileMutation = useMutation({
    mutationFn: async (file: any) => {
      // Delete from storage
      const { error: storageError } = await supabase.storage
        .from("claim-files")
        .remove([file.file_path]);

      if (storageError) throw storageError;

      // Delete from database
      const { error: dbError } = await supabase
        .from("claim_files")
        .delete()
        .eq("id", file.id);

      if (dbError) throw dbError;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["claim-files", claimId] });
      toast({
        title: "File deleted",
        description: "The file has been deleted successfully.",
      });
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to delete file.",
        variant: "destructive",
      });
    },
  });

  const handleDeleteFile = async (file: any) => {
    if (confirm("Are you sure you want to delete this file?")) {
      await deleteFileMutation.mutateAsync(file);
    }
  };

  return (
    <Tabs defaultValue="files" className="w-full">
      <TabsList className="flex flex-row w-full bg-muted/40 p-2 gap-1 overflow-x-auto scrollbar-hide">
        <TabsTrigger value="files" className="flex-1 md:flex-none justify-start text-base font-medium px-4 whitespace-nowrap">Documents & Files</TabsTrigger>
        {isStaffOrAdmin && claim && (
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
                  toast({
                    title: "Address copied",
                    description: "Property address copied to clipboard.",
                  });
                }}
              >
                <Copy className="h-4 w-4 mr-2" />
                Copy Address
              </Button>
            )}
            {isStaffOrAdmin && (
              <Button
                variant="outline"
                onClick={() => window.open("https://ssoext.gaf.com/oauth2/ausclyogeZBNESNcI4x6/v1/authorize?client_id=0oaclwmauH1TXBDzU4x6&code_challenge=5w3eWPZzMixtrRpmMsiaB-kkOrB6f0iptcPGkKehUHU&code_challenge_method=S256&nonce=zCbdYnAIj7cBfgWxzMPjoxyi0ftuviGSK8qw3SiigZHS0KqaDOYVOei142d5znNF&redirect_uri=https%3A%2F%2Fquickmeasure.gaf.com%2Fcallback&response_type=code&state=thy7nldi3KrQQkvaxuvNMe92rjHE0kqxXKEOIjdVXDSOXrjW31jo58XUBnAtEOKi&scope=openid%20profile%20email%20openid%20email%20profile%20CheckCoverage%20IsServiceOpen%20SiteStatus%20SendErrorReport%20SearchOrders%20PlaceOrder%20InitiatePayment%20UpdatePayment%20IsValidPromoCode%20RedeemPromoCode%20SearchReceipts%20DownloadRoofReport%20GetUserProfile%20SaveUserProfile%20GetLookup%20User%3ASavePreferences%20User%3AGetPreferences%20User%3AGetAvailableAddresses%20User%3ASetNotificationLog%20User%3AGetReplenishmentPreferences%20User%3ASaveReplenishmentPreferences%20User%3AGetProductPreferences%20User%3ASaveProductPreferences%20User%3AAcceptTermsAndConditions%20User%3AGetAccountPreferences%20User%3ASaveAccountPreferences%20Track%20Guest%3AAcceptTermsAndConditions%20GetDistributorsForPostalCode%20UpdateOrderService%20DownloadFile%20BPFileupload%20Orders%3AShareOrder%20Orders%3AGetSharedOrder", "_blank")}
              >
                <ExternalLink className="h-4 w-4 mr-2" />
                GAF QuickMeasure
              </Button>
            )}
            {isStaffOrAdmin && (
              <Button
                variant="outline"
                onClick={() => window.open("https://xactimate.com/xor/sign-in?utm_source=xactimate&utm_medium=referral&utm_campaign=login_page&utm_content=sign_in_btn", "_blank")}
              >
                <ExternalLink className="h-4 w-4 mr-2" />
                Xactimate
              </Button>
            )}
            
            {isStaffOrAdmin && (
              <Dialog open={folderDialogOpen} onOpenChange={setFolderDialogOpen}>
                <DialogTrigger asChild>
                  <Button variant="outline">
                    <FolderPlus className="h-4 w-4 mr-2" />
                    New Folder
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
                      onClick={() => createFolderMutation.mutate(newFolderName)}
                      disabled={!newFolderName.trim() || createFolderMutation.isPending}
                      className="w-full"
                    >
                      Create Folder
                    </Button>
                  </div>
                </DialogContent>
              </Dialog>
            )}
          </div>
        </div>

      <Accordion type="multiple" className="w-full space-y-2">
        {folders?.map((folder) => {
          const folderFiles = files?.filter((f) => f.folder_id === folder.id) || [];
          
          return (
            <AccordionItem
              key={folder.id}
              value={folder.id}
              className="border rounded-lg bg-card"
            >
              <AccordionTrigger className="px-4 hover:no-underline hover:bg-muted/30">
                <div className="flex items-center gap-2">
                  <Folder className="h-4 w-4 text-primary" />
                  <span className="font-medium text-foreground">{folder.name}</span>
                  <Badge variant="secondary" className="ml-2">
                    {folderFiles.length}
                  </Badge>
                </div>
              </AccordionTrigger>
              <AccordionContent className="px-4 pb-4">
                <div className="space-y-3 mt-3">
                  <Dialog open={uploadDialogOpen && selectedFolderId === folder.id} onOpenChange={(open) => {
                    setUploadDialogOpen(open);
                    if (!open) setSelectedFolderId(null);
                  }}>
                    <DialogTrigger asChild>
                      <Button
                        variant="outline"
                        size="sm"
                        className="w-full"
                        onClick={() => setSelectedFolderId(folder.id)}
                      >
                        <Upload className="h-4 w-4 mr-2" />
                        Upload File
                      </Button>
                    </DialogTrigger>
                    <DialogContent>
                      <DialogHeader>
                        <DialogTitle>Upload File to {folder.name}</DialogTitle>
                      </DialogHeader>
                      <div className="space-y-4">
                        <Input
                          type="file"
                          multiple
                          onChange={handleFileUpload}
                          disabled={uploadingFile}
                        />
                      </div>
                    </DialogContent>
                  </Dialog>

                  {folderFiles.length === 0 ? (
                    <p className="text-sm text-muted-foreground text-center py-4">
                      No files in this folder
                    </p>
                  ) : (
                    <div className="space-y-2">
                      {folderFiles.map((file) => {
                        const Icon = getFileIcon(file.file_type);
                        const isReprocessing = reprocessFileMutation.isPending && reprocessFileMutation.variables === file.id;
                        return (
                          <div
                            key={file.id}
                            className="p-3 rounded-lg border border-border hover:bg-muted/30 transition-colors"
                          >
                            <div className="flex items-start gap-3">
                              <div className="p-2 rounded-lg bg-primary/10">
                                <Icon className="h-4 w-4" />
                              </div>
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <p className="text-sm font-medium truncate">
                                    {file.file_name}
                                  </p>
                                  {getClassificationBadge(file.document_classification, file.classification_confidence)}
                                </div>
                                <p className="text-xs text-muted-foreground mt-1">
                                  {formatFileSize(file.file_size || 0)} •{" "}
                                  {new Date(file.uploaded_at).toLocaleDateString()}
                                  {file.classification_metadata && typeof file.classification_metadata === 'object' && 'summary' in file.classification_metadata && (
                                    <span className="ml-2 text-muted-foreground">
                                      • {String((file.classification_metadata as Record<string, unknown>).summary)}
                                    </span>
                                  )}
                                </p>
                                <div className="flex gap-2 mt-2 flex-wrap">
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => handleView(file)}
                                  >
                                    <Eye className="h-3 w-3 mr-1" />
                                    View
                                  </Button>
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => handleDownload(file)}
                                  >
                                    <Download className="h-3 w-3 mr-1" />
                                    Download
                                  </Button>
                                  {(file.file_name.toLowerCase().endsWith('.docx') || file.file_name.toLowerCase().endsWith('.pdf')) && (
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      onClick={() => handleSaveAsTemplate(file)}
                                    >
                                      <FileUp className="h-3 w-3 mr-1" />
                                      Save as Template
                                    </Button>
                                  )}
                                  <TooltipProvider>
                                    <Tooltip>
                                      <TooltipTrigger asChild>
                                        <Button
                                          variant="outline"
                                          size="sm"
                                          onClick={() => reprocessFileMutation.mutate(file.id)}
                                          disabled={isReprocessing}
                                        >
                                          {isReprocessing ? (
                                            <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                                          ) : (
                                            <RefreshCw className="h-3 w-3 mr-1" />
                                          )}
                                          {isReprocessing ? "Processing..." : "Reprocess"}
                                        </Button>
                                      </TooltipTrigger>
                                      <TooltipContent>
                                        <p>Re-analyze with Darwin AI</p>
                                      </TooltipContent>
                                    </Tooltip>
                                  </TooltipProvider>
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => handleDeleteFile(file)}
                                  >
                                    <Trash2 className="h-3 w-3 mr-1" />
                                    Delete
                                  </Button>
                                </div>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
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

      <Dialog open={saveAsTemplateDialogOpen} onOpenChange={setSaveAsTemplateDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Save as Template</DialogTitle>
            <DialogDescription>
              Save this document as a reusable template for future claims
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Template Name</Label>
              <Input
                value={templateForm.name}
                onChange={(e) =>
                  setTemplateForm({ ...templateForm, name: e.target.value })
                }
                placeholder="e.g., Standard Contract"
              />
            </div>
            <div>
              <Label>Description</Label>
              <Textarea
                value={templateForm.description}
                onChange={(e) =>
                  setTemplateForm({ ...templateForm, description: e.target.value })
                }
                placeholder="Optional description"
              />
            </div>
            <div>
              <Label>Category</Label>
              <Select
                value={templateForm.category}
                onValueChange={(value) =>
                  setTemplateForm({ ...templateForm, category: value })
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
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
            <Button
              variant="outline"
              onClick={() => setSaveAsTemplateDialogOpen(false)}
            >
              Cancel
            </Button>
            <Button
              onClick={() => saveAsTemplateMutation.mutate()}
              disabled={!templateForm.name || saveAsTemplateMutation.isPending}
            >
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
                  <img 
                    src={previewUrl} 
                    alt="Preview" 
                    className="w-full h-auto rounded-lg"
                  />
                ) : previewFileType.includes("pdf") ? (
                  <iframe
                    src={previewUrl}
                    className="w-full h-[70vh] rounded-lg border"
                    title="PDF Preview"
                  />
                ) : (
                  <div className="text-center py-8">
                    <FileText className="h-16 w-16 mx-auto text-muted-foreground mb-4" />
                    <p className="text-muted-foreground mb-4">
                      Preview not available for this file type
                    </p>
                    <Button onClick={() => window.open(previewUrl, "_blank")}>
                      Open in New Tab
                    </Button>
                  </div>
                )}
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>
      </TabsContent>

      {isStaffOrAdmin && claim && (
        <TabsContent value="templates" className="mt-4">
          <ClaimTemplates claimId={claimId} claim={claim} />
        </TabsContent>
      )}

      {/* Estimate Upload Dialog (direct upload) */}
      <EstimateUploadDialog
        open={estimateUploadOpen}
        onOpenChange={setEstimateUploadOpen}
        claimId={claimId}
      />

      {/* Estimate Detection Prompt */}
      <Dialog open={estimatePromptOpen} onOpenChange={setEstimatePromptOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Calculator className="h-5 w-5" />
              Estimate Detected
            </DialogTitle>
            <DialogDescription>
              This file appears to be an insurance estimate. Would you like to extract the financial figures and populate them into the Accounting tab?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              variant="outline"
              onClick={() => {
                setEstimatePromptOpen(false);
                setPendingEstimateFile(null);
              }}
            >
              No, just upload
            </Button>
            <Button
              onClick={() => {
                setEstimatePromptOpen(false);
                setEstimateUploadOpen(true);
              }}
            >
              <Calculator className="h-4 w-4 mr-2" />
              Extract & Populate
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Tabs>
  );
};

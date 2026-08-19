import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "sonner";
import { Upload, Trash2, FileText, Video, Loader2, CheckCircle, XCircle, Clock, Brain, Image, Link, Globe, AlignLeft, RefreshCw, Activity, ShieldCheck } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { SettingsHero } from "./SettingsHero";
import { SectionCard } from "./SectionCard";

const CATEGORIES = [
  { value: "insurance-regulations", label: "Insurance Regulations" },
  { value: "building-codes", label: "Building Codes" },
  { value: "manufacturer-specs", label: "Manufacturer Specifications" },
  { value: "company-policies", label: "Company Policies" },
  { value: "training-materials", label: "Training Materials" },
  { value: "legal-documents", label: "Legal Documents" },
  { value: "other", label: "Other" },
];

const ACCEPTED_FILE_TYPES = ".pdf,.doc,.docx,.ppt,.pptx,.mp4,.mov,.avi,.mkv,.mp3,.wav,.m4a,.webm,.jpg,.jpeg,.png,.gif,.webp,.bmp";

type UploadTab = "files" | "url" | "text";

interface KnowledgeValidationIssue {
  documentId: string;
  fileName: string;
  fileType: string;
  filePath: string;
  status: string;
  issueType: "failed" | "stuck_processing" | "stuck_pending" | "missing_chunks" | "missing_embeddings";
  detail: string;
}

interface KnowledgeValidationData {
  summary: {
    totalDocs: number;
    completedDocs: number;
    failedDocs: number;
    processingDocs: number;
    pendingDocs: number;
    docsMissingChunks: number;
    docsMissingEmbeddings: number;
    healthyDocs: number;
  };
  issues: KnowledgeValidationIssue[];
}

interface KnowledgeValidationRepairResult {
  attempted: number;
  repaired: number;
  manual: number;
  failed: number;
  failures: Array<{
    documentId: string;
    fileName: string;
    issueType: KnowledgeValidationIssue["issueType"];
    error: string;
  }>;
}

export const AIKnowledgeBaseSettings = () => {
  const queryClient = useQueryClient();
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [category, setCategory] = useState<string>("");
  const [description, setDescription] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<{ current: number; total: number } | null>(null);
  const [deleteDocId, setDeleteDocId] = useState<string | null>(null);
  
  // URL upload state
  const [urlInput, setUrlInput] = useState("");
  const [urlCategory, setUrlCategory] = useState<string>("");
  
  // Text upload state
  const [textTitle, setTextTitle] = useState("");
  const [textContent, setTextContent] = useState("");
  const [textCategory, setTextCategory] = useState<string>("");
  const [textDescription, setTextDescription] = useState("");
  const [textUploading, setTextUploading] = useState(false);
  const [urlDescription, setUrlDescription] = useState("");
  const [urlUploading, setUrlUploading] = useState(false);
  const [repairProgress, setRepairProgress] = useState<{
    current: number;
    total: number;
    fileName?: string;
  } | null>(null);
  const [lastRepairResult, setLastRepairResult] = useState<KnowledgeValidationRepairResult | null>(null);

  const { data: documents, isLoading } = useQuery({
    queryKey: ["ai-knowledge-documents"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("ai_knowledge_documents")
        .select("*")
        .order("created_at", { ascending: false });
      
      if (error) throw error;
      return data;
    },
    refetchInterval: 15000,
  });

  const {
    data: knowledgeValidation,
    isLoading: validationLoading,
    refetch: refetchKnowledgeValidation,
  } = useQuery<KnowledgeValidationData>({
    queryKey: ["ai-knowledge-validation"],
    queryFn: async () => {
      const { data: docs, error: docsError } = await supabase
        .from("ai_knowledge_documents")
        .select("id, file_name, file_path, file_type, status, error_message, updated_at")
        .order("created_at", { ascending: false });

      if (docsError) throw docsError;
      const documentsList = docs || [];
      const documentIds = documentsList.map((d) => d.id);

      const perDocStats = new Map<string, { chunkCount: number; embeddedCount: number }>();
      if (documentIds.length > 0) {
        // Supabase returns chunk rows in pages; iterate all pages so large KBs
        // do not show false "zero chunks" validation errors.
        const CHUNK_PAGE_SIZE = 1000;
        let offset = 0;

        while (true) {
          const { data: chunkPage, error: chunksError } = await supabase
            .from("ai_knowledge_chunks")
            .select("id, document_id, embedding")
            .in("document_id", documentIds)
            .order("id", { ascending: true })
            .range(offset, offset + CHUNK_PAGE_SIZE - 1);
          if (chunksError) throw chunksError;

          const rows = (chunkPage || []) as Array<{
            id: string;
            document_id: string;
            embedding: unknown | null;
          }>;
          for (const chunk of rows) {
            const current = perDocStats.get(chunk.document_id) || { chunkCount: 0, embeddedCount: 0 };
            current.chunkCount += 1;
            if (chunk.embedding) current.embeddedCount += 1;
            perDocStats.set(chunk.document_id, current);
          }

          if (rows.length < CHUNK_PAGE_SIZE) break;
          offset += CHUNK_PAGE_SIZE;
        }
      }

      const issues: KnowledgeValidationIssue[] = [];
      const now = Date.now();
      const processingStaleMs = 15 * 60 * 1000;
      const pendingStaleMs = 5 * 60 * 1000;

      let completedDocs = 0;
      let failedDocs = 0;
      let processingDocs = 0;
      let pendingDocs = 0;
      let docsMissingChunks = 0;
      let docsMissingEmbeddings = 0;
      let healthyDocs = 0;

      for (const doc of documentsList) {
        const stats = perDocStats.get(doc.id) || { chunkCount: 0, embeddedCount: 0 };
        const ageMs = now - new Date(doc.updated_at).getTime();

        if (doc.status === "completed") completedDocs += 1;
        if (doc.status === "failed") failedDocs += 1;
        if (doc.status === "processing") processingDocs += 1;
        if (doc.status === "pending") pendingDocs += 1;

        if (doc.status === "failed") {
          issues.push({
            documentId: doc.id,
            fileName: doc.file_name,
            fileType: doc.file_type,
            filePath: doc.file_path,
            status: doc.status,
            issueType: "failed",
            detail: doc.error_message || "Document processing failed.",
          });
          continue;
        }

        if (doc.status === "processing" && ageMs > processingStaleMs) {
          issues.push({
            documentId: doc.id,
            fileName: doc.file_name,
            fileType: doc.file_type,
            filePath: doc.file_path,
            status: doc.status,
            issueType: "stuck_processing",
            detail: "Document has stayed in processing too long.",
          });
          continue;
        }

        if (doc.status === "pending" && ageMs > pendingStaleMs) {
          issues.push({
            documentId: doc.id,
            fileName: doc.file_name,
            fileType: doc.file_type,
            filePath: doc.file_path,
            status: doc.status,
            issueType: "stuck_pending",
            detail: "Document stayed pending and never started processing.",
          });
          continue;
        }

        if (doc.status === "completed" && stats.chunkCount === 0) {
          docsMissingChunks += 1;
          issues.push({
            documentId: doc.id,
            fileName: doc.file_name,
            fileType: doc.file_type,
            filePath: doc.file_path,
            status: doc.status,
            issueType: "missing_chunks",
            detail: "Marked completed but has zero knowledge chunks.",
          });
          continue;
        }

        if (doc.status === "completed" && stats.chunkCount > 0 && stats.embeddedCount < stats.chunkCount) {
          docsMissingEmbeddings += 1;
          issues.push({
            documentId: doc.id,
            fileName: doc.file_name,
            fileType: doc.file_type,
            filePath: doc.file_path,
            status: doc.status,
            issueType: "missing_embeddings",
            detail: `Only ${stats.embeddedCount}/${stats.chunkCount} chunks have embeddings.`,
          });
          continue;
        }

        if (doc.status === "completed") healthyDocs += 1;
      }

      return {
        summary: {
          totalDocs: documentsList.length,
          completedDocs,
          failedDocs,
          processingDocs,
          pendingDocs,
          docsMissingChunks,
          docsMissingEmbeddings,
          healthyDocs,
        },
        issues,
      };
    },
    refetchInterval: 15000,
  });

  const invokeFunctionOrThrow = async (functionName: string, body: Record<string, unknown>) => {
    const { data, error } = await supabase.functions.invoke(functionName, { body });
    if (error) {
      throw new Error(error.message || `Failed to invoke ${functionName}`);
    }
    if (data && typeof data === "object" && "error" in data && (data as any).error) {
      throw new Error(String((data as any).error));
    }
    return data;
  };

  const repairValidationMutation = useMutation({
    mutationFn: async (): Promise<KnowledgeValidationRepairResult> => {
      if (!knowledgeValidation) {
        return { attempted: 0, repaired: 0, manual: 0, failed: 0, failures: [] };
      }

      const MAX_ISSUES_PER_RUN = 250;
      const issues = knowledgeValidation.issues.slice(0, MAX_ISSUES_PER_RUN);
      let repaired = 0;
      let manual = 0;
      let failed = 0;
      const failures: KnowledgeValidationRepairResult["failures"] = [];

      for (let index = 0; index < issues.length; index += 1) {
        const issue = issues[index];
        setRepairProgress({
          current: index + 1,
          total: issues.length,
          fileName: issue.fileName,
        });
        try {
          if (issue.issueType === "missing_embeddings") {
            await invokeFunctionOrThrow("generate-embeddings", {
              documentId: issue.documentId,
            });
            const { count: remainingCount, error: verifyError } = await supabase
              .from("ai_knowledge_chunks")
              .select("id", { count: "exact", head: true })
              .eq("document_id", issue.documentId)
              .is("embedding", null);
            if (verifyError) throw verifyError;
            if ((remainingCount || 0) > 0) {
              throw new Error(`Embeddings still missing for ${remainingCount} chunk(s).`);
            }
            repaired += 1;
            continue;
          }

          if (issue.fileType === "text") {
            // Text uploads are not reconstructable without original content payload.
            manual += 1;
            continue;
          }

          const { error: resetError } = await supabase
            .from("ai_knowledge_documents")
            .update({ status: "pending", error_message: null })
            .eq("id", issue.documentId);
          if (resetError) throw resetError;

          if (issue.fileType === "url") {
            await invokeFunctionOrThrow("process-knowledge-url", {
              documentId: issue.documentId,
              url: issue.filePath,
            });
          } else {
            await invokeFunctionOrThrow("process-knowledge-document", {
              documentId: issue.documentId,
            });
          }
          repaired += 1;
        } catch (error) {
          console.error("Validation repair error:", issue.documentId, error);
          failed += 1;
          failures.push({
            documentId: issue.documentId,
            fileName: issue.fileName,
            issueType: issue.issueType,
            error: error instanceof Error ? error.message : "Unknown error",
          });
        }
      }

      return { attempted: issues.length, repaired, manual, failed, failures };
    },
    onMutate: () => {
      setLastRepairResult(null);
      setRepairProgress({ current: 0, total: knowledgeValidation?.issues.length || 0 });
    },
    onSuccess: (result) => {
      setRepairProgress(null);
      setLastRepairResult(result);
      queryClient.invalidateQueries({ queryKey: ["ai-knowledge-documents"] });
      queryClient.invalidateQueries({ queryKey: ["ai-knowledge-validation"] });
      if (result.repaired > 0) {
        toast.success(
          `Validation repair started for ${result.repaired}/${result.attempted} docs` +
            (result.manual > 0 ? ` (${result.manual} text docs require manual re-upload)` : "") +
            (result.failed > 0 ? ` (${result.failed} failed to trigger)` : "")
        );
      } else if (result.manual > 0 && result.failed === 0) {
        toast.warning(
          `No automatic repairs possible. ${result.manual} text docs require manual re-upload.`
        );
      } else if (result.failed > 0) {
        toast.error(`Auto-fix could not trigger repairs (${result.failed} failed).`);
      } else {
        toast.info("No validation issues required repair.");
      }
    },
    onError: (error: any) => {
      setRepairProgress(null);
      toast.error(error.message || "Failed to run validation repair");
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (docId: string) => {
      const doc = documents?.find(d => d.id === docId);
      if (!doc) throw new Error("Document not found");

      // Delete from storage
      const { error: storageError } = await supabase.storage
        .from("ai-knowledge-base")
        .remove([doc.file_path]);
      
      if (storageError) console.error("Storage delete error:", storageError);

      // Delete from database (chunks will cascade delete)
      const { error } = await supabase
        .from("ai_knowledge_documents")
        .delete()
        .eq("id", docId);
      
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["ai-knowledge-documents"] });
      queryClient.invalidateQueries({ queryKey: ["ai-knowledge-validation"] });
      toast.success("Document deleted");
      setDeleteDocId(null);
    },
    onError: (error: any) => {
      toast.error(error.message || "Failed to delete document");
    },
  });

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    const validFiles: File[] = [];
    
    for (const file of files) {
      if (file.size > 20 * 1024 * 1024) {
        toast.error(`${file.name} is too large (max 20MB)`);
        continue;
      }
      validFiles.push(file);
    }
    
    setSelectedFiles(validFiles);
  };

  const handleUpload = async () => {
    if (selectedFiles.length === 0 || !category) {
      toast.error("Please select file(s) and category");
      return;
    }

    setUploading(true);
    setUploadProgress({ current: 0, total: selectedFiles.length });

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Not authenticated");

      let successCount = 0;
      let failCount = 0;

      for (let i = 0; i < selectedFiles.length; i++) {
        const file = selectedFiles[i];
        setUploadProgress({ current: i + 1, total: selectedFiles.length });

        try {
          // Upload file to storage
          const filePath = `${user.id}/${Date.now()}-${file.name}`;

          const { error: uploadError } = await supabase.storage
            .from("ai-knowledge-base")
            .upload(filePath, file);

          if (uploadError) throw uploadError;

          // Create document record
          const { data: docData, error: docError } = await supabase
            .from("ai_knowledge_documents")
            .insert({
              file_name: file.name,
              file_path: filePath,
              file_type: file.type,
              file_size: file.size,
              category,
              description: description || null,
              uploaded_by: user.id,
              status: "pending",
            })
            .select()
            .single();

          if (docError) throw docError;

          // Trigger processing (don't await, let it run in background)
          supabase.functions.invoke(
            "process-knowledge-document",
            { body: { documentId: docData.id } }
          ).catch(err => console.error("Processing trigger error:", err));

          successCount++;
        } catch (error: any) {
          console.error(`Upload error for ${file.name}:`, error);
          failCount++;
        }
      }

      if (successCount > 0) {
        toast.success(`${successCount} file(s) uploaded and processing started`);
      }
      if (failCount > 0) {
        toast.error(`${failCount} file(s) failed to upload`);
      }

      // Reset form
      setSelectedFiles([]);
      setCategory("");
      setDescription("");
      queryClient.invalidateQueries({ queryKey: ["ai-knowledge-documents"] });
      queryClient.invalidateQueries({ queryKey: ["ai-knowledge-validation"] });

    } catch (error: any) {
      console.error("Upload error:", error);
      toast.error(error.message || "Failed to upload documents");
    } finally {
      setUploading(false);
      setUploadProgress(null);
    }
  };

  const handleUrlUpload = async () => {
    if (!urlInput || !urlCategory) {
      toast.error("Please enter a URL and select a category");
      return;
    }

    // Validate URL
    let url: URL;
    try {
      url = new URL(urlInput.startsWith('http') ? urlInput : `https://${urlInput}`);
    } catch {
      toast.error("Please enter a valid URL");
      return;
    }

    setUrlUploading(true);

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Not authenticated");

      // Create document record for URL
      const { data: docData, error: docError } = await supabase
        .from("ai_knowledge_documents")
        .insert({
          file_name: url.hostname,
          file_path: url.toString(),
          file_type: "url",
          file_size: null,
          category: urlCategory,
          description: urlDescription || null,
          uploaded_by: user.id,
          status: "pending",
        })
        .select()
        .single();

      if (docError) throw docError;

      // Trigger URL processing
      supabase.functions.invoke(
        "process-knowledge-url",
        { body: { documentId: docData.id, url: url.toString() } }
      ).catch(err => console.error("URL processing trigger error:", err));

      toast.success("URL submitted for processing");

      // Reset form
      setUrlInput("");
      setUrlCategory("");
      setUrlDescription("");
      queryClient.invalidateQueries({ queryKey: ["ai-knowledge-documents"] });
      queryClient.invalidateQueries({ queryKey: ["ai-knowledge-validation"] });

    } catch (error: any) {
      console.error("URL upload error:", error);
      toast.error(error.message || "Failed to submit URL");
    } finally {
      setUrlUploading(false);
    }
  };

  const handleTextUpload = async () => {
    if (!textContent || !textCategory || !textTitle) {
      toast.error("Please enter a title, content, and select a category");
      return;
    }

    setTextUploading(true);

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Not authenticated");

      // Create document record for text content
      const { data: docData, error: docError } = await supabase
        .from("ai_knowledge_documents")
        .insert({
          file_name: textTitle,
          file_path: `text-content-${Date.now()}`,
          file_type: "text",
          file_size: new Blob([textContent]).size,
          category: textCategory,
          description: textDescription || null,
          uploaded_by: user.id,
          status: "pending",
        })
        .select()
        .single();

      if (docError) throw docError;

      // Trigger text processing - store the text content directly
      supabase.functions.invoke(
        "process-knowledge-text",
        { body: { documentId: docData.id, content: textContent, title: textTitle } }
      ).catch(err => console.error("Text processing trigger error:", err));

      toast.success("Text content submitted for processing");

      // Reset form
      setTextTitle("");
      setTextContent("");
      setTextCategory("");
      setTextDescription("");
      queryClient.invalidateQueries({ queryKey: ["ai-knowledge-documents"] });
      queryClient.invalidateQueries({ queryKey: ["ai-knowledge-validation"] });

    } catch (error: any) {
      console.error("Text upload error:", error);
      toast.error(error.message || "Failed to submit text content");
    } finally {
      setTextUploading(false);
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "completed":
        return <Badge className="bg-green-500/20 text-green-400 border-green-500/30"><CheckCircle className="h-3 w-3 mr-1" />Processed</Badge>;
      case "processing":
        return <Badge className="bg-blue-500/20 text-blue-400 border-blue-500/30"><Loader2 className="h-3 w-3 mr-1 animate-spin" />Processing</Badge>;
      case "failed":
        return <Badge className="bg-red-500/20 text-red-400 border-red-500/30"><XCircle className="h-3 w-3 mr-1" />Failed</Badge>;
      default:
        return <Badge className="bg-yellow-500/20 text-yellow-400 border-yellow-500/30"><Clock className="h-3 w-3 mr-1" />Pending</Badge>;
    }
  };

  const getFileIcon = (fileName: string, fileType?: string) => {
    if (fileType === 'url') {
      return <Globe className="h-5 w-5 text-cyan-400" />;
    }
    if (fileType === 'text') {
      return <AlignLeft className="h-5 w-5 text-emerald-400" />;
    }
    if (fileName.match(/\.(mp4|mov|avi|mkv|mp3|wav|m4a|webm)$/i)) {
      return <Video className="h-5 w-5 text-purple-400" />;
    }
    if (fileName.match(/\.(jpg|jpeg|png|gif|webp|bmp)$/i)) {
      return <Image className="h-5 w-5 text-green-400" />;
    }
    if (fileName.match(/\.(ppt|pptx)$/i)) {
      return <FileText className="h-5 w-5 text-orange-400" />;
    }
    return <FileText className="h-5 w-5 text-blue-400" />;
  };

  const getCategoryLabel = (value: string) => {
    return CATEGORIES.find(c => c.value === value)?.label || value;
  };

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      <SettingsHero
        title="AI Knowledge Base"
        description="Upload documents, images, videos, add URLs, or enter text to train the AI assistant."
        badge="AI Training"
        icon={<Brain className="h-4 w-4 text-primary" />}
      />
      <SectionCard
        title="Knowledge Sources"
        accent="bg-gradient-to-r from-primary/60 to-primary/10"
        icon={<Brain className="h-4 w-4 text-primary" />}
        description="Add new content for the AI to learn from."
      >

          <Tabs defaultValue="files" className="w-full">
            <TabsList className="grid w-full grid-cols-3">
              <TabsTrigger value="files" className="flex items-center gap-2">
                <Upload className="h-4 w-4" />
                Files
              </TabsTrigger>
              <TabsTrigger value="url" className="flex items-center gap-2">
                <Link className="h-4 w-4" />
                URL
              </TabsTrigger>
              <TabsTrigger value="text" className="flex items-center gap-2">
                <AlignLeft className="h-4 w-4" />
                Text
              </TabsTrigger>
            </TabsList>
            
            <TabsContent value="files" className="space-y-4 mt-4">
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label>File(s) - Select multiple for bulk upload</Label>
                  <Input
                    type="file"
                    accept={ACCEPTED_FILE_TYPES}
                    onChange={handleFileSelect}
                    disabled={uploading}
                    className="cursor-pointer"
                    multiple
                  />
                  {selectedFiles.length > 0 && (
                    <p className="text-sm text-muted-foreground">
                      Selected: {selectedFiles.length} file(s) ({(selectedFiles.reduce((acc, f) => acc + f.size, 0) / 1024 / 1024).toFixed(2)} MB total)
                    </p>
                  )}
                </div>

                <div className="space-y-2">
                  <Label>Category *</Label>
                  <Select value={category} onValueChange={setCategory} disabled={uploading}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select category" />
                    </SelectTrigger>
                    <SelectContent>
                      {CATEGORIES.map((cat) => (
                        <SelectItem key={cat.value} value={cat.value}>
                          {cat.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="space-y-2">
                <Label>Description (optional)</Label>
                <Textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Brief description of the document content..."
                  disabled={uploading}
                  rows={2}
                />
              </div>

              <Button
                onClick={handleUpload}
                disabled={selectedFiles.length === 0 || !category || uploading}
                className="w-full md:w-auto"
              >
                {uploading ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    {uploadProgress ? `Uploading ${uploadProgress.current}/${uploadProgress.total}...` : 'Uploading...'}
                  </>
                ) : (
                  <>
                    <Upload className="h-4 w-4 mr-2" />
                    Upload {selectedFiles.length > 1 ? `${selectedFiles.length} Documents` : 'Document'}
                  </>
                )}
              </Button>
              <p className="text-xs text-muted-foreground mt-2">
                Supported: PDF, Word docs, PowerPoint, images (JPG, PNG), video/audio files. Max 20MB per file.
              </p>
            </TabsContent>
            
            <TabsContent value="url" className="space-y-4 mt-4">
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label>Website URL *</Label>
                  <Input
                    type="url"
                    value={urlInput}
                    onChange={(e) => setUrlInput(e.target.value)}
                    placeholder="https://example.com/page"
                    disabled={urlUploading}
                  />
                </div>

                <div className="space-y-2">
                  <Label>Category *</Label>
                  <Select value={urlCategory} onValueChange={setUrlCategory} disabled={urlUploading}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select category" />
                    </SelectTrigger>
                    <SelectContent>
                      {CATEGORIES.map((cat) => (
                        <SelectItem key={cat.value} value={cat.value}>
                          {cat.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="space-y-2">
                <Label>Description (optional)</Label>
                <Textarea
                  value={urlDescription}
                  onChange={(e) => setUrlDescription(e.target.value)}
                  placeholder="Brief description of what this page contains..."
                  disabled={urlUploading}
                  rows={2}
                />
              </div>

              <Button
                onClick={handleUrlUpload}
                disabled={!urlInput || !urlCategory || urlUploading}
                className="w-full md:w-auto"
              >
                {urlUploading ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Processing URL...
                  </>
                ) : (
                  <>
                    <Globe className="h-4 w-4 mr-2" />
                    Add URL
                  </>
                )}
              </Button>
              <p className="text-xs text-muted-foreground mt-2">
                The AI will fetch and analyze the webpage content. Processing takes 30-60 seconds.
              </p>
            </TabsContent>
            
            <TabsContent value="text" className="space-y-4 mt-4">
              <div className="space-y-2">
                <Label>Title *</Label>
                <Input
                  value={textTitle}
                  onChange={(e) => setTextTitle(e.target.value)}
                  placeholder="e.g., State Farm Denial Response Template"
                  disabled={textUploading}
                />
              </div>
              
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label>Category *</Label>
                  <Select value={textCategory} onValueChange={setTextCategory} disabled={textUploading}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select category" />
                    </SelectTrigger>
                    <SelectContent>
                      {CATEGORIES.map((cat) => (
                        <SelectItem key={cat.value} value={cat.value}>
                          {cat.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label>Description (optional)</Label>
                  <Input
                    value={textDescription}
                    onChange={(e) => setTextDescription(e.target.value)}
                    placeholder="Brief description..."
                    disabled={textUploading}
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label>Content *</Label>
                <Textarea
                  value={textContent}
                  onChange={(e) => setTextContent(e.target.value)}
                  placeholder="Enter statements, paragraphs, verbiage, policy language, response templates, or any other text content for the AI to learn..."
                  disabled={textUploading}
                  rows={8}
                  className="font-mono text-sm"
                />
                <p className="text-xs text-muted-foreground">
                  {textContent.length} characters
                </p>
              </div>

              <Button
                onClick={handleTextUpload}
                disabled={!textContent || !textCategory || !textTitle || textUploading}
                className="w-full md:w-auto"
              >
                {textUploading ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Processing...
                  </>
                ) : (
                  <>
                    <AlignLeft className="h-4 w-4 mr-2" />
                    Add Text Content
                  </>
                )}
              </Button>
              <p className="text-xs text-muted-foreground mt-2">
                Add policy language, response templates, verbiage, statements, or any text the AI should know.
              </p>
            </TabsContent>
          </Tabs>
      </SectionCard>

      <SectionCard
        title="Knowledge Validation"
        accent="bg-gradient-to-r from-emerald-500/60 to-emerald-500/10"
        icon={<CheckCircle className="h-4 w-4 text-emerald-500" />}
      >
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between mb-4">
          <div>
            <p className="text-sm text-muted-foreground">
              Verifies every uploaded document is processed, chunked, and embedded for reliable retrieval.
            </p>
          </div>

            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => refetchKnowledgeValidation()}
                disabled={validationLoading}
                className="gap-2"
              >
                {validationLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4" />
                )}
                Refresh
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => repairValidationMutation.mutate()}
                disabled={
                  repairValidationMutation.isPending ||
                  !knowledgeValidation ||
                  knowledgeValidation.issues.length === 0
                }
                className="gap-2"
              >
                {repairValidationMutation.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4" />
                )}
                {repairValidationMutation.isPending
                  ? `Auto-fixing ${repairProgress?.current || 0}/${repairProgress?.total || 0}`
                  : "Auto-fix issues"}
              </Button>
            </div>
        </div>
        <div className="space-y-4">

          {validationLoading ? (
            <div className="flex items-center justify-center py-6">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : knowledgeValidation ? (
            <>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <div className="rounded-lg border bg-muted/20 p-3">
                  <p className="text-xs text-muted-foreground">Total docs</p>
                  <p className="text-lg font-semibold">{knowledgeValidation.summary.totalDocs}</p>
                </div>
                <div className="rounded-lg border bg-muted/20 p-3">
                  <p className="text-xs text-muted-foreground">Healthy</p>
                  <p className="text-lg font-semibold text-green-600">{knowledgeValidation.summary.healthyDocs}</p>
                </div>
                <div className="rounded-lg border bg-muted/20 p-3">
                  <p className="text-xs text-muted-foreground">Failed</p>
                  <p className="text-lg font-semibold text-red-500">{knowledgeValidation.summary.failedDocs}</p>
                </div>
                <div className="rounded-lg border bg-muted/20 p-3">
                  <p className="text-xs text-muted-foreground">Processing/Pending</p>
                  <p className="text-lg font-semibold">
                    {knowledgeValidation.summary.processingDocs + knowledgeValidation.summary.pendingDocs}
                  </p>
                </div>
              </div>

              <div className="flex flex-wrap gap-2">
                <Badge variant="outline">
                  Missing chunks: {knowledgeValidation.summary.docsMissingChunks}
                </Badge>
                <Badge variant="outline">
                  Missing embeddings: {knowledgeValidation.summary.docsMissingEmbeddings}
                </Badge>
                <Badge variant={knowledgeValidation.issues.length === 0 ? "secondary" : "destructive"}>
                  Open issues: {knowledgeValidation.issues.length}
                </Badge>
              </div>

              {repairValidationMutation.isPending && repairProgress && (
                <div className="rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm">
                  <p className="font-medium">
                    Auto-fix in progress: {repairProgress.current}/{repairProgress.total}
                  </p>
                  {repairProgress.fileName && (
                    <p className="text-xs text-muted-foreground mt-1 truncate">
                      Currently processing: {repairProgress.fileName}
                    </p>
                  )}
                </div>
              )}

              {lastRepairResult && (
                <div className="rounded-lg border p-3 space-y-2">
                  <p className="text-sm font-medium">
                    Last auto-fix run: attempted {lastRepairResult.attempted}, triggered {lastRepairResult.repaired},
                    manual {lastRepairResult.manual}, failed {lastRepairResult.failed}
                  </p>
                  {lastRepairResult.failures.length > 0 && (
                    <div className="max-h-40 overflow-y-auto space-y-1">
                      {lastRepairResult.failures.slice(0, 12).map((failure) => (
                        <div key={`${failure.documentId}-${failure.issueType}`} className="rounded border bg-muted/20 p-2">
                          <p className="text-xs font-medium">
                            {failure.fileName} ({failure.issueType.replace("_", " ")})
                          </p>
                          <p className="text-xs text-red-500">{failure.error}</p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {knowledgeValidation.issues.length === 0 ? (
                <div className="rounded-lg border border-green-500/30 bg-green-500/5 p-3 text-sm text-green-700">
                  Validation passed. All completed documents are chunked and embedded.
                </div>
              ) : (
                <div className="space-y-2 rounded-lg border p-3">
                  <p className="text-sm font-medium">
                    Validation issues ({knowledgeValidation.issues.length})
                  </p>
                  <div className="max-h-52 space-y-2 overflow-y-auto pr-1">
                    {knowledgeValidation.issues.slice(0, 25).map((issue) => (
                      <div key={`${issue.documentId}-${issue.issueType}`} className="rounded-md border bg-muted/20 p-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge variant="outline" className="text-[10px] uppercase tracking-wide">
                            {issue.issueType.replace("_", " ")}
                          </Badge>
                          <span className="text-xs font-medium">{issue.fileName}</span>
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">{issue.detail}</p>
                      </div>
                    ))}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Auto-fix retries failed/stuck docs and regenerates missing embeddings. Text entries that lost original
                    content must be re-uploaded manually.
                  </p>
                </div>
              )}
            </>
          ) : (
            <p className="text-sm text-muted-foreground">Validation data is unavailable right now.</p>
          )}
      </SectionCard>


      <SectionCard
        title="Uploaded Documents"
        accent="bg-gradient-to-r from-blue-500/60 to-blue-500/10"
        icon={<FileText className="h-4 w-4 text-blue-500" />}
        description={`${documents?.length || 0} documents in the knowledge base`}
      >

        <div>
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : documents && documents.length > 0 ? (
            <ScrollArea className="h-[400px]">
              <div className="space-y-3">
                {documents.map((doc) => (
                  <div
                    key={doc.id}
                    className="flex items-center justify-between p-3 rounded-lg bg-muted/30 border border-border"
                  >
                    <div className="flex items-center gap-3 min-w-0 flex-1">
                      {getFileIcon(doc.file_name, doc.file_type)}
                      <div className="min-w-0 flex-1">
                        <p className="font-medium truncate">{doc.file_name}</p>
                        <div className="flex items-center gap-2 mt-1">
                          <Badge variant="outline" className="text-xs">
                            {getCategoryLabel(doc.category)}
                          </Badge>
                          {getStatusBadge(doc.status)}
                          {doc.error_message && (
                            <span className="text-xs text-red-400 truncate max-w-[200px]">
                              {doc.error_message}
                            </span>
                          )}
                        </div>
                        {doc.description && (
                          <p className="text-sm text-muted-foreground mt-1 truncate">
                            {doc.description}
                          </p>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      {(doc.status === 'failed' || doc.status === 'processing') && (
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={async () => {
                            try {
                              toast.info(`Reprocessing ${doc.file_name}...`);
                              if (doc.file_type === 'url') {
                                await supabase.functions.invoke('process-knowledge-url', {
                                  body: { documentId: doc.id, url: doc.file_path }
                                });
                              } else if (doc.file_type === 'text') {
                                // For text docs we don't have the original content, reset to pending
                                await supabase.from('ai_knowledge_documents').update({ status: 'pending' }).eq('id', doc.id);
                                toast.info('Text documents need to be re-uploaded to reprocess');
                                return;
                              } else {
                                await supabase.functions.invoke('process-knowledge-document', {
                                  body: { documentId: doc.id }
                                });
                              }
                              queryClient.invalidateQueries({ queryKey: ["ai-knowledge-documents"] });
                              queryClient.invalidateQueries({ queryKey: ["ai-knowledge-validation"] });
                              toast.success('Reprocessing started');
                            } catch (err: any) {
                              toast.error(err.message || 'Failed to reprocess');
                            }
                          }}
                          className="text-primary hover:text-primary hover:bg-primary/10"
                          title="Reprocess document"
                        >
                          <RefreshCw className="h-4 w-4" />
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => setDeleteDocId(doc.id)}
                        className="text-destructive hover:text-destructive hover:bg-destructive/10"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </ScrollArea>
          ) : (
            <div className="text-center py-8 text-muted-foreground">
              <Brain className="h-12 w-12 mx-auto mb-3 opacity-50" />
              <p>No documents uploaded yet</p>
              <p className="text-sm">Upload documents to enhance the AI assistant's knowledge</p>
            </div>
          )}
      </SectionCard>


      <AlertDialog open={!!deleteDocId} onOpenChange={() => setDeleteDocId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Document</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete this document? This will remove all extracted knowledge from the AI assistant.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteDocId && deleteMutation.mutate(deleteDocId)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

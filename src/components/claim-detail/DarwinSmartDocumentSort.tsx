import { useState, useCallback, useRef } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import {
  FolderOpen,
  Upload,
  FileText,
  Sparkles,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Tag,
  ChevronDown,
  ChevronUp,
  FolderPlus,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useQuery, useQueryClient } from "@tanstack/react-query";

interface DarwinSmartDocumentSortProps {
  claimId: string;
  claim?: any;
}

interface ClassifiedDocument {
  file: File;
  suggestedFolder: string;
  documentType: string;
  confidence: number;
  sender?: string;
  date?: string;
  topic?: string;
  isProcessing?: boolean;
  isUploaded?: boolean;
  error?: string;
}

const FOLDER_MAPPING: Record<string, string> = {
  "Policy Documents": "Policy Documents",
  "Correspondence": "Correspondence",
  "Estimates": "Estimates",
  "Photos": "Photos",
  "Invoices": "Invoices",
  "Inspection Reports": "Inspection Reports",
  "Legal Documents": "Legal Documents",
  "Contracts": "Contracts",
  "Weather Reports": "Weather Reports",
  "Engineering Reports": "Engineering Reports",
  "Other": "Other",
};

export const DarwinSmartDocumentSort = ({ claimId }: DarwinSmartDocumentSortProps) => {
  const [isOpen, setIsOpen] = useState(false);
  const [documents, setDocuments] = useState<ClassifiedDocument[]>([]);
  const [isClassifying, setIsClassifying] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [classificationProgress, setClassificationProgress] = useState(0);
  const [selectedParentFolderId, setSelectedParentFolderId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();

  // Fetch existing folders for parent folder selection
  const { data: existingFolders } = useQuery({
    queryKey: ["claim-folders", claimId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("claim_folders")
        .select("*")
        .eq("claim_id", claimId)
        .order("name", { ascending: true });
      if (error) throw error;
      return data;
    },
  });

  // Only show top-level folders as parent options
  const topLevelFolders = existingFolders?.filter(f => !f.parent_folder_id) || [];

  const classifyDocument = async (file: File): Promise<Partial<ClassifiedDocument>> => {
    const fileExtension = file.name.split('.').pop()?.toLowerCase() || '';
    const fileName = file.name.toLowerCase();
    
    // Quick classification based on file name patterns
    let suggestedFolder = "Other";
    let documentType = "Document";
    let confidence = 0.7;
    let topic = "";
    
    // Pattern matching for common document types
    // Check for policy number patterns (e.g., H0132PK000001, HO-3, HO3, DP-1, etc.)
    const policyNumberPattern = /^h[o0][-]?\d|^dp[-]?\d|^ho\d{2,}/i;
    const isPolicyNumberFormat = policyNumberPattern.test(fileName) || /^[a-z]{1,3}\d{3,}[a-z]*\d*[-_]?\d*/i.test(fileName);
    
    if (fileName.includes("policy") || fileName.includes("dec") || fileName.includes("declaration") || isPolicyNumberFormat) {
      suggestedFolder = "Policy Documents";
      documentType = "Policy/Declaration Page";
      confidence = 0.9;
      topic = "Insurance Policy";
    } else if (fileName.includes("estimate") || fileName.includes("xactimate") || fileName.includes("scope")) {
      suggestedFolder = "Estimates";
      documentType = "Estimate/Scope";
      confidence = 0.9;
      topic = "Damage Estimate";
    } else if (fileName.includes("invoice") || fileName.includes("receipt") || fileName.includes("bill")) {
      suggestedFolder = "Invoices";
      documentType = "Invoice/Receipt";
      confidence = 0.9;
      topic = "Payment/Billing";
    } else if (fileName.includes("letter") || fileName.includes("correspondence") || fileName.includes("denial") || fileName.includes("response")) {
      suggestedFolder = "Correspondence";
      documentType = "Carrier Correspondence";
      confidence = 0.85;
      topic = "Insurance Communication";
    } else if (fileName.includes("inspection") || fileName.includes("adjuster")) {
      suggestedFolder = "Inspection Reports";
      documentType = "Inspection Report";
      confidence = 0.85;
      topic = "Property Inspection";
    } else if (fileName.includes("engineer") || fileName.includes("structural")) {
      suggestedFolder = "Engineering Reports";
      documentType = "Engineering Report";
      confidence = 0.9;
      topic = "Structural Analysis";
    } else if (fileName.includes("weather") || fileName.includes("hail") || fileName.includes("storm")) {
      suggestedFolder = "Weather Reports";
      documentType = "Weather Report";
      confidence = 0.85;
      topic = "Weather Data";
    } else if (fileName.includes("contract") || fileName.includes("agreement") || fileName.includes("authorization")) {
      suggestedFolder = "Contracts";
      documentType = "Contract/Agreement";
      confidence = 0.85;
      topic = "Legal Agreement";
    } else if (fileName.includes("legal") || fileName.includes("attorney") || fileName.includes("lawsuit")) {
      suggestedFolder = "Legal Documents";
      documentType = "Legal Document";
      confidence = 0.85;
      topic = "Legal Matter";
    } else if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic'].includes(fileExtension)) {
      suggestedFolder = "Photos";
      documentType = "Photo/Image";
      confidence = 0.95;
      topic = "Visual Documentation";
    } else if (fileExtension === 'pdf') {
      // For PDFs, try AI classification
      try {
        const { data, error } = await supabase.functions.invoke("darwin-ai-analysis", {
          body: {
            type: "document_classify",
            claimId,
            fileName: file.name,
            fileSize: file.size,
          },
        });
        
        if (!error && data?.classification) {
          return {
            suggestedFolder: data.classification.folder || "Other",
            documentType: data.classification.type || "PDF Document",
            confidence: data.classification.confidence || 0.7,
            sender: data.classification.sender,
            date: data.classification.date,
            topic: data.classification.topic,
          };
        }
      } catch (e) {
        console.log("AI classification fallback to pattern matching");
      }
    }

    return { suggestedFolder, documentType, confidence, topic };
  };

  const handleFileDrop = useCallback(async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files);
    await processFiles(files);
  }, [claimId]);

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    await processFiles(files);
    e.target.value = "";
  };

  const openFilePicker = () => {
    setIsOpen(true);
    fileInputRef.current?.click();
  };

  const processFiles = async (files: File[]) => {
    if (files.length === 0) return;
    
    setIsClassifying(true);
    setClassificationProgress(0);
    
    const newDocs: ClassifiedDocument[] = [];
    
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      setClassificationProgress(((i + 1) / files.length) * 100);
      
      const classification = await classifyDocument(file);
      
      newDocs.push({
        file,
        suggestedFolder: classification.suggestedFolder || "Other",
        documentType: classification.documentType || "Document",
        confidence: classification.confidence || 0.5,
        sender: classification.sender,
        date: classification.date,
        topic: classification.topic,
      });
    }
    
    setDocuments(prev => [...prev, ...newDocs]);
    setIsClassifying(false);
    toast.success(`Classified ${files.length} document${files.length > 1 ? 's' : ''}`);
  };

  const uploadDocuments = async () => {
    if (documents.length === 0) return;
    if (!selectedParentFolderId) {
      toast.error("Please select a parent folder first");
      return;
    }
    
    setIsUploading(true);
    const { data: { user } } = await supabase.auth.getUser();
    
    let successCount = 0;
    let errorCount = 0;

    for (const doc of documents) {
      if (doc.isUploaded) continue;
      
      setDocuments(prev => 
        prev.map(d => d.file === doc.file ? { ...d, isProcessing: true } : d)
      );

      try {
        // Find or create subfolder under the selected parent folder
        let folderId: string;
        
        const { data: existingFolder } = await supabase
          .from("claim_folders")
          .select("id")
          .eq("claim_id", claimId)
          .eq("name", doc.suggestedFolder)
          .eq("parent_folder_id", selectedParentFolderId)
          .maybeSingle();
        
        if (existingFolder) {
          folderId = existingFolder.id;
        } else {
          const { data: newFolder, error: folderError } = await supabase
            .from("claim_folders")
            .insert({
              claim_id: claimId,
              name: doc.suggestedFolder,
              is_predefined: false,
              created_by: user?.id,
              parent_folder_id: selectedParentFolderId,
            })
            .select()
            .single();
          
          if (folderError) throw folderError;
          folderId = newFolder.id;
        }

        // Upload file
        const fileExt = doc.file.name.split(".").pop();
        const fileName = `${claimId}/${folderId}/${Date.now()}.${fileExt}`;

        const { error: uploadError } = await supabase.storage
          .from("claim-files")
          .upload(fileName, doc.file);

        if (uploadError) throw uploadError;

        // Create database record
        const { error: dbError } = await supabase
          .from("claim_files")
          .insert({
            claim_id: claimId,
            folder_id: folderId,
            file_name: doc.file.name,
            file_path: fileName,
            file_size: doc.file.size,
            file_type: doc.file.type,
            uploaded_by: user?.id,
          });

        if (dbError) throw dbError;

        setDocuments(prev => 
          prev.map(d => d.file === doc.file ? { ...d, isProcessing: false, isUploaded: true } : d)
        );
        successCount++;

      } catch (error: any) {
        console.error("Upload error:", error);
        setDocuments(prev => 
          prev.map(d => d.file === doc.file ? { ...d, isProcessing: false, error: error.message } : d)
        );
        errorCount++;
      }
    }

    setIsUploading(false);
    queryClient.invalidateQueries({ queryKey: ["claim-files", claimId] });
    queryClient.invalidateQueries({ queryKey: ["claim-folders", claimId] });
    
    if (successCount > 0) {
      toast.success(`Uploaded ${successCount} document${successCount > 1 ? 's' : ''} to smart folders`);
    }
    if (errorCount > 0) {
      toast.error(`Failed to upload ${errorCount} document${errorCount > 1 ? 's' : ''}`);
    }
  };

  const updateFolder = (file: File, newFolder: string) => {
    setDocuments(prev => 
      prev.map(d => d.file === file ? { ...d, suggestedFolder: newFolder } : d)
    );
  };

  const removeDocument = (file: File) => {
    setDocuments(prev => prev.filter(d => d.file !== file));
  };

  const clearUploaded = () => {
    setDocuments(prev => prev.filter(d => !d.isUploaded));
  };

  const getConfidenceColor = (confidence: number) => {
    if (confidence >= 0.85) return "text-green-600 bg-green-100";
    if (confidence >= 0.7) return "text-amber-600 bg-amber-100";
    return "text-red-600 bg-red-100";
  };

  const pendingCount = documents.filter(d => !d.isUploaded && !d.error).length;
  const uploadedCount = documents.filter(d => d.isUploaded).length;

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        onChange={handleFileSelect}
        className="hidden"
        accept="*/*"
      />
      <Card>
        <CollapsibleTrigger asChild>
          <CardHeader className="cursor-pointer hover:bg-muted/50 transition-colors">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base flex items-center gap-2">
                <FolderOpen className="h-5 w-5 text-primary" />
                Smart Document Sorting
                <Badge variant="secondary" className="ml-2">AI-Powered</Badge>
              </CardTitle>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-8"
                  disabled={isClassifying || isUploading}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    openFilePicker();
                  }}
                >
                  {isClassifying ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      Classifying...
                    </>
                  ) : (
                    <>
                      <Upload className="h-4 w-4 mr-2" />
                      Upload & Sort
                    </>
                  )}
                </Button>
                {pendingCount > 0 && (
                  <Badge variant="default">{pendingCount} pending</Badge>
                )}
                {isOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
              </div>
            </div>
          </CardHeader>
        </CollapsibleTrigger>

        <CollapsibleContent>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Drop documents here and Darwin will automatically classify and organize them into subfolders within your selected parent folder.
            </p>

            {/* Parent Folder Selector */}
            <div className="space-y-1.5">
              <Label className="text-sm font-medium">Upload into folder</Label>
              <Select
                value={selectedParentFolderId || ""}
                onValueChange={(val) => setSelectedParentFolderId(val || null)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select a parent folder…" />
                </SelectTrigger>
                <SelectContent>
                  {topLevelFolders.map(f => (
                    <SelectItem key={f.id} value={f.id}>
                      📁 {f.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {!selectedParentFolderId && documents.length > 0 && (
                <p className="text-xs text-destructive">Please select a folder before uploading</p>
              )}
            </div>

            {/* Drop Zone */}
            <div
              onDrop={handleFileDrop}
              onDragOver={(e) => e.preventDefault()}
              onClick={openFilePicker}
              className="border-2 border-dashed border-muted-foreground/30 rounded-lg p-8 text-center hover:border-primary/50 hover:bg-primary/5 transition-all cursor-pointer"
            >
              <div className="flex flex-col items-center gap-3">
                {isClassifying ? (
                  <>
                    <Loader2 className="h-10 w-10 text-primary animate-spin" />
                    <p className="text-sm text-muted-foreground">Classifying documents...</p>
                    <Progress value={classificationProgress} className="w-48" />
                  </>
                ) : (
                  <>
                    <Upload className="h-10 w-10 text-muted-foreground" />
                    <div>
                      <p className="font-medium">Drop files here or click to upload</p>
                      <p className="text-sm text-muted-foreground">
                        PDFs, images, documents - Darwin will sort them automatically
                      </p>
                    </div>
                  </>
                )}
              </div>
            </div>

            {/* Classified Documents List */}
            {documents.length > 0 && (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h4 className="font-medium text-sm">Classified Documents</h4>
                  <div className="flex gap-2">
                    {uploadedCount > 0 && (
                      <Button variant="ghost" size="sm" onClick={clearUploaded}>
                        Clear uploaded
                      </Button>
                    )}
                    {pendingCount > 0 && (
                      <Button 
                        size="sm" 
                        onClick={uploadDocuments}
                        disabled={isUploading || !selectedParentFolderId}
                      >
                        {isUploading ? (
                          <>
                            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                            Uploading...
                          </>
                        ) : (
                          <>
                            <FolderPlus className="h-4 w-4 mr-2" />
                            Upload {pendingCount} as Subfolders
                          </>
                        )}
                      </Button>
                    )}
                  </div>
                </div>

                <ScrollArea className="h-[300px]">
                  <div className="space-y-2">
                    {documents.map((doc, idx) => (
                      <div 
                        key={`${doc.file.name}-${idx}`}
                        className={`p-3 rounded-lg border ${
                          doc.isUploaded 
                            ? 'bg-green-50 border-green-200 dark:bg-green-950 dark:border-green-800' 
                            : doc.error 
                              ? 'bg-red-50 border-red-200 dark:bg-red-950 dark:border-red-800'
                              : 'bg-card'
                        }`}
                      >
                        <div className="flex items-start gap-3">
                          <div className="p-2 rounded-lg bg-primary/10">
                            <FileText className="h-4 w-4 text-primary" />
                          </div>
                          
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="font-medium text-sm truncate">{doc.file.name}</span>
                              {doc.isProcessing && <Loader2 className="h-3 w-3 animate-spin" />}
                              {doc.isUploaded && <CheckCircle2 className="h-4 w-4 text-green-600" />}
                              {doc.error && <AlertCircle className="h-4 w-4 text-red-600" />}
                            </div>
                            
                            <div className="flex flex-wrap items-center gap-2 mt-1">
                              <Badge variant="outline" className="text-xs">
                                <Tag className="h-3 w-3 mr-1" />
                                {doc.documentType}
                              </Badge>
                              <Badge className={`text-xs ${getConfidenceColor(doc.confidence)}`}>
                                <Sparkles className="h-3 w-3 mr-1" />
                                {Math.round(doc.confidence * 100)}% match
                              </Badge>
                              {doc.topic && (
                                <span className="text-xs text-muted-foreground">{doc.topic}</span>
                              )}
                            </div>

                            {doc.error && (
                              <p className="text-xs text-red-600 mt-1">{doc.error}</p>
                            )}
                          </div>

                          {!doc.isUploaded && !doc.isProcessing && (
                            <div className="flex items-center gap-2">
                              <div className="relative">
                                <input
                                  type="text"
                                  list={`folder-options-${idx}`}
                                  value={doc.suggestedFolder}
                                  onChange={(e) => updateFolder(doc.file, e.target.value)}
                                  className="text-xs border rounded px-2 py-1 bg-background w-40"
                                  placeholder="Type or select folder"
                                />
                                <datalist id={`folder-options-${idx}`}>
                                  {Object.keys(FOLDER_MAPPING).map(folder => (
                                    <option key={folder} value={folder} />
                                  ))}
                                </datalist>
                              </div>
                              <Button 
                                variant="ghost" 
                                size="sm"
                                onClick={() => removeDocument(doc.file)}
                              >
                                ×
                              </Button>
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              </div>
            )}
          </CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
};

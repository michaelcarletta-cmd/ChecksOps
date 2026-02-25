import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { FileText, Upload, Download, Loader2, Eye, Info } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SignatureRequests } from "./SignatureRequests";

interface ClaimTemplatesProps {
  claimId: string;
  claim: any;
}

export function ClaimTemplates({ claimId, claim }: ClaimTemplatesProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [isUploadOpen, setIsUploadOpen] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewFileName, setPreviewFileName] = useState<string>("");
  
  const [templateForm, setTemplateForm] = useState({
    name: "",
    description: "",
    category: "Contract",
    file: null as File | null,
  });

  const { data: templates, isLoading } = useQuery({
    queryKey: ["document-templates"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("document_templates")
        .select("*")
        .eq("is_active", true)
        .order("name");
      
      if (error) throw error;
      return data;
    },
  });

  const uploadMutation = useMutation({
    mutationFn: async () => {
      if (!templateForm.file) throw new Error("No file selected");

      // Sanitize filename: remove special characters and replace spaces with underscores
      const sanitizedName = templateForm.file.name
        .replace(/[^a-zA-Z0-9.-]/g, '_')
        .replace(/_+/g, '_');
      const fileName = `${Date.now()}-${sanitizedName}`;
      
      const { error: uploadError } = await supabase.storage
        .from("document-templates")
        .upload(fileName, templateForm.file);

      if (uploadError) throw uploadError;

      const { error: dbError } = await supabase
        .from("document_templates")
        .insert({
          name: templateForm.name,
          description: templateForm.description,
          category: templateForm.category,
          file_path: fileName,
          file_name: templateForm.file.name,
        });

      if (dbError) throw dbError;
    },
    onSuccess: () => {
      toast({ title: "Template uploaded successfully" });
      setIsUploadOpen(false);
      setTemplateForm({ name: "", description: "", category: "Contract", file: null });
      queryClient.invalidateQueries({ queryKey: ["document-templates"] });
    },
    onError: (error: Error) => {
      toast({
        title: "Upload failed",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const handleGenerateDocument = async (template: any) => {
    setIsGenerating(true);
    try {
      const { data, error } = await supabase.functions.invoke("generate-document", {
        body: {
          templateId: template.id,
          claimId,
        },
      });

      if (error) throw error;
      
      // Check if the response contains an error property (from edge function)
      if (data?.error) {
        throw new Error(data.details || data.error);
      }

      // Create blob from the returned data
      const contentArray = Array.isArray(data.content)
        ? data.content
        : data.content?.data || data.content;
      const blob = new Blob([new Uint8Array(contentArray)], {
        type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      });
      const url = URL.createObjectURL(blob);
      
      setPreviewUrl(url);
      setPreviewFileName(data.fileName);
      
      toast({ title: "Document generated successfully" });
    } catch (error: any) {
      toast({
        title: "Generation failed",
        description: error.message || "An error occurred while generating the document",
        variant: "destructive",
      });
    } finally {
      setIsGenerating(false);
    }
  };

  const handleDownload = () => {
    if (previewUrl) {
      const a = document.createElement("a");
      a.href = previewUrl;
      a.download = previewFileName;
      a.click();
    }
  };

  const handleSaveToClaim = async () => {
    if (!previewUrl) return;

    try {
      const response = await fetch(previewUrl);
      const blob = await response.blob();
      const file = new File([blob], previewFileName, { type: blob.type });

      const fileName = `${claimId}/${Date.now()}-${previewFileName}`;
      const { error: uploadError } = await supabase.storage
        .from("claim-files")
        .upload(fileName, file);

      if (uploadError) throw uploadError;

      const { error: dbError } = await supabase.from("claim_files").insert({
        claim_id: claimId,
        file_name: previewFileName,
        file_path: fileName,
        file_size: file.size,
        file_type: file.type,
      });

      if (dbError) throw dbError;

      toast({ title: "Document saved to claim files" });
      setPreviewUrl(null);
      setPreviewFileName("");
    } catch (error: any) {
      toast({
        title: "Save failed",
        description: error.message,
        variant: "destructive",
      });
    }
  };

  return (
    <Tabs defaultValue="templates" className="w-full">
      <TabsList className="flex flex-row w-full bg-muted/40 p-2 gap-1 overflow-x-auto scrollbar-hide">
        <TabsTrigger value="templates" className="flex-1 md:flex-none justify-start text-base font-medium px-4 whitespace-nowrap">Templates</TabsTrigger>
        <TabsTrigger value="signatures" className="flex-1 md:flex-none justify-start text-base font-medium px-4 whitespace-nowrap">Signature Requests</TabsTrigger>
      </TabsList>

      <TabsContent value="templates" className="space-y-6">
      <Alert>
        <Info className="h-4 w-4" />
        <AlertTitle>Available Merge Fields</AlertTitle>
        <AlertDescription>
          <p className="mb-2">Use these fields in your Word templates with dollar sign and curly braces:</p>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-2 text-sm font-mono">
            <div>{`\${policyholder}`}</div>
            <div>{`\${policyholder_email}`}</div>
            <div>{`\${policyholder_phone}`}</div>
            <div>{`\${property_address}`}</div>
            <div>{`\${street}`}</div>
            <div>{`\${city}`}</div>
            <div>{`\${state}`}</div>
            <div>{`\${zip}`}</div>
            <div>{`\${policy_number}`}</div>
            <div>{`\${claim_number}`}</div>
            <div>{`\${loss_date}`}</div>
            <div>{`\${loss_type}`}</div>
            <div>{`\${loss_description}`}</div>
            <div>{`\${insurance_company}`}</div>
            <div>{`\${insurance_phone}`}</div>
            <div>{`\${insurance_email}`}</div>
            <div>{`\${adjuster_name}`}</div>
            <div>{`\${adjuster_phone}`}</div>
            <div>{`\${adjuster_email}`}</div>
            <div>{`\${mortgage_company}`}</div>
            <div>{`\${loan_number}`}</div>
            <div>{`\${ssn_last_four}`}</div>
            <div>{`\${referrer_name}`}</div>
            <div>{`\${referrer_company}`}</div>
            <div>{`\${date}`}</div>
            <div>{`\${today}`}</div>
          </div>
        </AlertDescription>
      </Alert>

      <div className="flex justify-between items-center">
        <div>
          <h3 className="text-lg font-semibold">Document Templates</h3>
          <p className="text-sm text-muted-foreground">
            Generate documents with auto-filled claim information
          </p>
        </div>
        <Dialog open={isUploadOpen} onOpenChange={setIsUploadOpen}>
          <DialogTrigger asChild>
            <Button>
              <Upload className="w-4 h-4 mr-2" />
              Upload Template
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Upload Document Template</DialogTitle>
              <DialogDescription>
                Upload a Word document with merge fields like {`\${policyholder}`} or {`\${address.street}`}
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
              <div>
                <Label>Template File (DOCX or PDF)</Label>
                <Input
                  type="file"
                  accept=".docx,.pdf"
                  onChange={(e) =>
                    setTemplateForm({
                      ...templateForm,
                      file: e.target.files?.[0] || null,
                    })
                  }
                />
              </div>
            </div>
            <DialogFooter>
              <Button
                onClick={() => uploadMutation.mutate()}
                disabled={!templateForm.name || !templateForm.file || uploadMutation.isPending}
              >
                {uploadMutation.isPending ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Uploading...
                  </>
                ) : (
                  "Upload"
                )}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center p-8">
          <Loader2 className="w-6 h-6 animate-spin" />
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {templates?.map((template) => (
            <Card key={template.id}>
              <CardHeader>
                <CardTitle className="flex items-center text-base">
                  <FileText className="w-4 h-4 mr-2" />
                  {template.name}
                </CardTitle>
                {template.description && (
                  <CardDescription>{template.description}</CardDescription>
                )}
              </CardHeader>
              <CardContent>
                <Button
                  className="w-full"
                  onClick={() => handleGenerateDocument(template)}
                  disabled={isGenerating}
                >
                  {isGenerating ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Generating...
                    </>
                  ) : (
                    <>
                      <Eye className="w-4 h-4 mr-2" />
                      Generate & Preview
                    </>
                  )}
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {previewUrl && (
        <Dialog open={!!previewUrl} onOpenChange={() => setPreviewUrl(null)}>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>Document Preview</DialogTitle>
              <DialogDescription>
                Review the generated document before saving
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div className="p-4 border rounded-md bg-muted">
                <p className="text-sm font-medium">{previewFileName}</p>
                <p className="text-xs text-muted-foreground">
                  Word document generated with claim information
                </p>
              </div>
              <div className="flex gap-2">
                <Button onClick={handleDownload} variant="outline" className="flex-1">
                  <Download className="w-4 h-4 mr-2" />
                  Download
                </Button>
                <Button onClick={handleSaveToClaim} className="flex-1">
                  Save to Claim Files
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      )}
      </TabsContent>

      <TabsContent value="signatures">
        <SignatureRequests claimId={claimId} claim={claim} />
      </TabsContent>
    </Tabs>
  );
}

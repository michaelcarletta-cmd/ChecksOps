import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { FileSignature, Plus, Loader2, Mail, Check, Clock, X, ChevronRight, ChevronLeft, ExternalLink, Link2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { FieldPlacementEditor } from "./FieldPlacementEditor";
import { SignatureDiagnostics } from "./SignatureDiagnostics";
import { getFunctionErrorMessage } from "@/lib/edgeFunctionError";

interface SignatureRequestsProps {
  claimId: string;
  claim: any;
}

export function SignatureRequests({ claimId, claim }: SignatureRequestsProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [currentStep, setCurrentStep] = useState<1 | 2 | 3>(1); // 1: template, 2: fields, 3: signers
  const [signers, setSigners] = useState([
    { name: claim.policyholder_name || "", email: claim.policyholder_email || "", type: "policyholder", order: 1 }
  ]);
  const [selectedTemplate, setSelectedTemplate] = useState<any>(null);
  const [generatedDocUrl, setGeneratedDocUrl] = useState<string | null>(null);
  const [generatedDocPath, setGeneratedDocPath] = useState<string | null>(null);
  const [placedFields, setPlacedFields] = useState<any[]>([]);
  const [generatedDocxData, setGeneratedDocxData] = useState<Uint8Array | null>(null);
  const [sourceType, setSourceType] = useState<"template" | "claim_file">("template");
  const [selectedClaimFile, setSelectedClaimFile] = useState<any>(null);


  const { data: templates } = useQuery({
    queryKey: ["document-templates"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("document_templates")
        .select("*")
        .eq("is_active", true);
      if (error) throw error;
      return data;
    },
  });

  // Fetch claim PDF files for direct signature use
  const { data: claimPdfFiles } = useQuery({
    queryKey: ["claim-pdf-files", claimId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("claim_files")
        .select("*")
        .eq("claim_id", claimId)
        .or("file_name.ilike.%.pdf,file_name.ilike.%.docx")
        .order("uploaded_at", { ascending: false });
      if (error) throw error;
      return data;
    },
  });

  const { data: requests, isLoading } = useQuery({
    queryKey: ["signature-requests", claimId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("signature_requests")
        .select(`
          *,
          signature_signers(*)
        `)
        .eq("claim_id", claimId)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data;
    },
  });

  const [isDocxTemplate, setIsDocxTemplate] = useState(false);

  const generateDocumentMutation = useMutation({
    mutationFn: async () => {
      if (!selectedTemplate) throw new Error("No template selected");

      // Generate document from template
      const { data: docData, error: docError } = await supabase.functions.invoke(
        "generate-document",
        { body: { templateId: selectedTemplate.id, claimId } }
      );
      if (docError) throw docError;
      if (docData.error) throw new Error(docData.error);

      // Handle both PDF and Word document responses
      const isPDF = docData.isPDF;
      setIsDocxTemplate(!isPDF);
      
      const contentArray = Array.isArray(docData.content) 
        ? docData.content 
        : docData.content?.data || docData.content;
      
      const contentUint8 = new Uint8Array(contentArray);
      
      const mimeType = isPDF 
        ? "application/pdf" 
        : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

      // Upload to storage
      const fileName = `signatures/${claimId}/${Date.now()}-${docData.fileName}`;
      const blob = new Blob([contentUint8], { type: mimeType });
      
      const { error: uploadError } = await supabase.storage
        .from("claim-files")
        .upload(fileName, blob);
      if (uploadError) throw uploadError;

      // Get signed URL for field placement (only useful for PDFs)
      const { data: urlData } = await supabase.storage
        .from("claim-files")
        .createSignedUrl(fileName, 3600);

      setGeneratedDocPath(fileName);
      
      if (isPDF) {
        setGeneratedDocUrl(urlData?.signedUrl || null);
        setGeneratedDocxData(null);
      } else {
        // For DOCX, store the raw data for client-side rendering
        setGeneratedDocUrl(null);
        setGeneratedDocxData(contentUint8);
      }
      
      return { fileName, url: urlData?.signedUrl, isPDF };
    },
    onSuccess: () => {
      // Always go to field placement step
      setCurrentStep(2);
      toast({ title: "Document generated! Now place signature fields." });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to generate document", description: error.message, variant: "destructive" });
    },
  });

  const useClaimFileMutation = useMutation({
    mutationFn: async () => {
      if (!selectedClaimFile) throw new Error("No file selected");

      // Get signed URL for the existing PDF
      const { data: urlData, error } = await supabase.storage
        .from("claim-files")
        .createSignedUrl(selectedClaimFile.file_path, 3600);
      if (error) throw error;

      setGeneratedDocPath(selectedClaimFile.file_path);
      setGeneratedDocUrl(urlData?.signedUrl || null);
      setGeneratedDocxData(null);
      setIsDocxTemplate(false);

      return { url: urlData?.signedUrl };
    },
    onSuccess: () => {
      setCurrentStep(2);
      toast({ title: "PDF loaded! Now place signature fields." });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to load file", description: error.message, variant: "destructive" });
    },
  });

  const createRequestMutation = useMutation({
    mutationFn: async ({ skipEmail = false }: { skipEmail?: boolean }) => {
      if (!generatedDocPath) throw new Error("Missing required data");
      const docName = sourceType === "claim_file" 
        ? selectedClaimFile?.file_name || "Document" 
        : selectedTemplate?.name || "Document";

      // Create signature request record
      const { data: request, error: requestError } = await supabase
        .from("signature_requests")
        .insert({
          claim_id: claimId,
          document_name: docName,
          document_path: generatedDocPath,
          field_data: placedFields,
          status: "pending",
        })
        .select()
        .single();
      if (requestError) throw requestError;

      // Create signers
      const signersData = signers.map((s) => ({
        signature_request_id: request.id,
        signer_name: s.name,
        signer_email: s.email,
        signer_type: s.type,
        signing_order: s.order,
      }));

      const { error: signersError } = await supabase
        .from("signature_signers")
        .insert(signersData);
      if (signersError) throw signersError;

      // Delegate ALL delivery orchestration to the edge function
      const { data, error } = await supabase.functions.invoke("send-signature-request", {
        body: { requestId: request.id, skipEmail },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);

      // Copy links to clipboard in manual bypass mode
      if (skipEmail && data?.signerLinks) {
        const links = data.signerLinks.map((l: any) => l.sign_url).join("\n");
        navigator.clipboard.writeText(links);
      }

      return { ...request, mode: data?.mode || (skipEmail ? "manual_bypass" : "delivered") };
    },
    onSuccess: (data) => {
      const mode = (data as any)?.mode;
      const title = mode === "manual_bypass"
        ? "Sign links generated & copied to clipboard"
        : mode === "make_signnow"
          ? "Sent to SignNow via Make.com"
          : "Signature request created and emails sent";
      toast({ title });
      setIsCreateOpen(false);
      setCurrentStep(1);
      setSelectedTemplate(null);
      setGeneratedDocUrl(null);
      setGeneratedDocPath(null);
      setPlacedFields([]);
      setIsDocxTemplate(false);
      setGeneratedDocxData(null);
      setSigners([{ name: claim.policyholder_name || "", email: claim.policyholder_email || "", type: "policyholder", order: 1 }]);
      queryClient.invalidateQueries({ queryKey: ["signature-requests"] });
      queryClient.invalidateQueries({ queryKey: ["sig-diagnostics"] });
      queryClient.invalidateQueries({ queryKey: ["esign-event-logs"] });
      queryClient.invalidateQueries({ queryKey: ["claim-updates"] });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to create request", description: error.message, variant: "destructive" });
    },
  });

  const addSigner = () => {
    setSigners([...signers, { name: "", email: "", type: "other", order: signers.length + 1 }]);
  };

  const updateSigner = (index: number, field: string, value: string) => {
    const updated = [...signers];
    updated[index] = { ...updated[index], [field]: value };
    setSigners(updated);
  };

  const removeSigner = (index: number) => {
    setSigners(signers.filter((_, i) => i !== index));
  };

  const deleteRequestMutation = useMutation({
    mutationFn: async (request: any) => {
      // Delete document from storage
      const { error: storageError } = await supabase.storage
        .from("claim-files")
        .remove([request.document_path]);
      if (storageError) console.error("Storage deletion error:", storageError);

      // Delete signature request (will cascade delete signers)
      const { error } = await supabase
        .from("signature_requests")
        .delete()
        .eq("id", request.id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast({ title: "Signature request deleted" });
      queryClient.invalidateQueries({ queryKey: ["signature-requests"] });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to delete", description: error.message, variant: "destructive" });
    },
  });

  const getStatusIcon = (status: string) => {
    switch (status) {
      case "completed": return <Check className="w-4 h-4 text-green-600" />;
      case "in_progress": return <Clock className="w-4 h-4 text-yellow-600" />;
      case "declined": return <X className="w-4 h-4 text-red-600" />;
      default: return <Clock className="w-4 h-4 text-muted-foreground" />;
    }
  };

  const getStatusBadge = (status: string) => {
    const variants: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
      completed: "default",
      in_progress: "secondary",
      declined: "destructive",
      pending: "outline",
    };
    const displayStatus = status.replace("_", " ");
    return <Badge variant={variants[status] || "outline"}>{displayStatus}</Badge>;
  };

  const handleOpenDocument = async (request: any) => {
    try {
      if (!request.document_path) {
        throw new Error("No document path found for this request");
      }

      const { data, error } = await supabase.storage
        .from("claim-files")
        .createSignedUrl(request.document_path, 3600);

      if (error || !data?.signedUrl) {
        throw new Error(error?.message || "Unable to generate document link");
      }

      window.open(data.signedUrl, "_blank", "noopener,noreferrer");
    } catch (error: any) {
      toast({
        title: "Unable to open document",
        description: error.message,
        variant: "destructive",
      });
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h3 className="text-lg font-semibold">Signature Requests</h3>
          <p className="text-sm text-muted-foreground">
            Send documents for electronic signature
          </p>
        </div>
        <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="w-4 h-4 mr-2" />
              Request Signature
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Create Signature Request - Step {currentStep} of 3</DialogTitle>
              <DialogDescription>
                {currentStep === 1 && "Select a document source"}
                {currentStep === 2 && "Place signature and date fields on the document"}
                {currentStep === 3 && "Configure signers"}
              </DialogDescription>
            </DialogHeader>

            {/* Step 1: Source Selection */}
            {currentStep === 1 && (
              <div className="space-y-4">
                <div>
                  <Label>Document Source</Label>
                  <Select value={sourceType} onValueChange={(v) => { setSourceType(v as any); setSelectedTemplate(null); setSelectedClaimFile(null); }}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="template">Generate from Template</SelectItem>
                      <SelectItem value="claim_file">Use Existing Claim PDF</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {sourceType === "template" && (
                  <div>
                    <Label>Document Template</Label>
                    <Select
                      value={selectedTemplate?.id}
                      onValueChange={(id) =>
                        setSelectedTemplate(templates?.find((t) => t.id === id))
                      }
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select template" />
                      </SelectTrigger>
                      <SelectContent>
                        {templates?.map((template) => (
                          <SelectItem key={template.id} value={template.id}>
                            {template.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}

                {sourceType === "claim_file" && (
                  <div>
                    <Label>Claim File (PDF or DOCX)</Label>
                    <Select
                      value={selectedClaimFile?.id}
                      onValueChange={(id) =>
                        setSelectedClaimFile(claimPdfFiles?.find((f) => f.id === id))
                      }
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select a file from claim files" />
                      </SelectTrigger>
                      <SelectContent>
                        {claimPdfFiles?.length === 0 && (
                          <div className="px-3 py-2 text-sm text-muted-foreground">No PDF or DOCX files found for this claim</div>
                        )}
                        {claimPdfFiles?.map((file) => (
                          <SelectItem key={file.id} value={file.id}>
                            {file.file_name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
              </div>
            )}

            {/* Step 2: Field Placement (works for both PDF and DOCX) */}
            {currentStep === 2 && (generatedDocUrl || generatedDocxData) && (
              <FieldPlacementEditor
                documentUrl={generatedDocUrl || undefined}
                docxData={generatedDocxData || undefined}
                onFieldsChange={setPlacedFields}
                signerCount={signers.length}
              />
            )}

            {/* Step 3: Signer Configuration */}
            {currentStep === 3 && (
              <div className="space-y-3">
                <div className="flex justify-between items-center">
                  <Label>Signers (in order)</Label>
                  <Button type="button" variant="outline" size="sm" onClick={addSigner}>
                    <Plus className="w-3 h-3 mr-1" />
                    Add Signer
                  </Button>
                </div>
                {signers.map((signer, index) => (
                  <div key={index} className="flex gap-2 items-start">
                    <div className="flex-1 grid grid-cols-3 gap-2">
                      <Input
                        placeholder="Name"
                        value={signer.name}
                        onChange={(e) => updateSigner(index, "name", e.target.value)}
                      />
                      <Input
                        type="email"
                        placeholder="Email"
                        value={signer.email}
                        onChange={(e) => updateSigner(index, "email", e.target.value)}
                      />
                      <Select
                        value={signer.type}
                        onValueChange={(value) => updateSigner(index, "type", value)}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="policyholder">Policyholder</SelectItem>
                          <SelectItem value="contractor">Contractor</SelectItem>
                          <SelectItem value="staff">Staff</SelectItem>
                          <SelectItem value="other">Other</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    {signers.length > 1 && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        onClick={() => removeSigner(index)}
                      >
                        <X className="w-4 h-4" />
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            )}

            <DialogFooter>
              <div className="flex justify-between w-full">
                <div>
                  {currentStep > 1 && (
                    <Button
                      variant="outline"
                      onClick={() => setCurrentStep((currentStep - 1) as 1 | 2 | 3)}
                    >
                      <ChevronLeft className="w-4 h-4 mr-2" />
                      Back
                    </Button>
                  )}
                </div>
                <div className="flex gap-2">
                  {currentStep === 1 && sourceType === "template" && (
                    <Button
                      onClick={() => generateDocumentMutation.mutate()}
                      disabled={!selectedTemplate || generateDocumentMutation.isPending}
                    >
                      {generateDocumentMutation.isPending ? (
                        <>
                          <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                          Generating...
                        </>
                      ) : (
                        <>
                          Next
                          <ChevronRight className="w-4 h-4 ml-2" />
                        </>
                      )}
                    </Button>
                  )}
                  {currentStep === 1 && sourceType === "claim_file" && (
                    <Button
                      onClick={() => useClaimFileMutation.mutate()}
                      disabled={!selectedClaimFile || useClaimFileMutation.isPending}
                    >
                      {useClaimFileMutation.isPending ? (
                        <>
                          <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                          Loading...
                        </>
                      ) : (
                        <>
                          Next
                          <ChevronRight className="w-4 h-4 ml-2" />
                        </>
                      )}
                    </Button>
                  )}
                  {currentStep === 2 && (
                    <Button
                      onClick={() => setCurrentStep(3)}
                    >
                      Next
                      <ChevronRight className="w-4 h-4 ml-2" />
                    </Button>
                  )}
                  {currentStep === 3 && (
                    <>
                      <Button
                        variant="outline"
                        onClick={() => createRequestMutation.mutate({ skipEmail: true })}
                        disabled={signers.some(s => !s.name || !s.email) || createRequestMutation.isPending}
                      >
                        <Link2 className="w-4 h-4 mr-2" />
                        Generate Link Only
                      </Button>
                      <Button
                        onClick={() => createRequestMutation.mutate({ skipEmail: false })}
                        disabled={signers.some(s => !s.name || !s.email) || createRequestMutation.isPending}
                      >
                        {createRequestMutation.isPending ? (
                          <>
                            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                            Sending...
                          </>
                        ) : (
                          <>
                            <Mail className="w-4 h-4 mr-2" />
                            Send for Signature
                          </>
                        )}
                      </Button>
                    </>
                  )}
                </div>
              </div>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center p-8">
          <Loader2 className="w-6 h-6 animate-spin" />
        </div>
      ) : requests && requests.length > 0 ? (
        <div className="space-y-4">
          {requests.map((request) => (
            <Card key={request.id}>
              <CardHeader>
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-2">
                    <FileSignature className="w-5 h-5" />
                    <div>
                      <CardTitle className="text-base">{request.document_name}</CardTitle>
                      <CardDescription>
                        Created {new Date(request.created_at).toLocaleDateString()}
                      </CardDescription>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleOpenDocument(request)}
                    >
                      Open Document
                    </Button>
                    {getStatusBadge(request.status)}
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => deleteRequestMutation.mutate(request)}
                      disabled={deleteRequestMutation.isPending}
                    >
                      <X className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  <p className="text-sm font-medium">Signers:</p>
                  <div className="space-y-1">
                    {request.signature_signers?.sort((a, b) => a.signing_order - b.signing_order).map((signer) => (
                      <div key={signer.id} className="flex items-center justify-between text-sm p-2 rounded bg-muted/50">
                        <div className="flex items-center gap-2">
                          {getStatusIcon(signer.status)}
                          <span>{signer.signer_name}</span>
                          <span className="text-muted-foreground">({signer.signer_email})</span>
                        </div>
                        <Badge variant="outline" className="text-xs">
                          {signer.status === "signed" ? `Signed ${new Date(signer.signed_at!).toLocaleDateString()}` : signer.status}
                        </Badge>
                      </div>
                    ))}
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <Card>
          <CardContent className="flex flex-col items-center justify-center p-8 text-center">
            <FileSignature className="w-12 h-12 text-muted-foreground mb-4" />
            <p className="text-muted-foreground">No signature requests yet</p>
          </CardContent>
        </Card>
      )}

      {/* Diagnostics Section */}
      <SignatureDiagnostics claimId={claimId} claim={claim} />
    </div>
  );
}

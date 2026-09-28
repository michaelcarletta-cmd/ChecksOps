import { useState, useEffect, lazy, Suspense } from "react";
import { detectDocumentType } from "@/lib/signer-display-templates";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { FileSignature, Plus, Loader2, Mail, Check, Clock, X, ChevronRight, ChevronLeft, ExternalLink, Link2, RefreshCw, AlertTriangle, Upload } from "lucide-react";
import { Badge } from "@/components/ui/badge";
const FieldPlacementEditor = lazy(() => import("./FieldPlacementEditor").then((m) => ({ default: m.FieldPlacementEditor })));
import { SignatureDiagnostics } from "./SignatureDiagnostics";
import { getFunctionErrorMessage } from "@/lib/edgeFunctionError";
import {
  mergeClaimAndCheckSignatureFiles,
  signatureSourceFilesQueryKey,
} from "@/lib/signature-source-files";

interface SignatureRequestsProps {
  claimId: string;
  claim: any;
  checkIntakeItemId?: string | null;
}

export function SignatureRequests({ claimId, claim, checkIntakeItemId = null }: SignatureRequestsProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [currentStep, setCurrentStep] = useState<1 | 2 | 3>(1);

  useEffect(() => {
    const stored = localStorage.getItem("preselected_sig_file");
    if (stored) {
      try {
        const file = JSON.parse(stored);
        localStorage.removeItem("preselected_sig_file");
        setSourceType("claim_file");
        setSelectedClaimFile(file);
        setIsCreateOpen(true);
      } catch (e) {
        console.error("Failed to parse preselected file", e);
      }
    }
  }, []);

  // Expose methods via a custom hook or event if we want better integration, 
  // but for now we'll check localStorage for a file to pre-select.
  const checkPreselectedFile = () => {
    try {
      const stored = localStorage.getItem("preselected_sig_file");
      if (stored) {
        const file = JSON.parse(stored);
        localStorage.removeItem("preselected_sig_file");
        setSourceType("claim_file");
        setSelectedClaimFile(file);
        setIsCreateOpen(true);
      }
    } catch (e) {
      console.error("Failed to parse preselected file", e);
    }
  };

  useEffect(() => {
    checkPreselectedFile();
    const onPreselected = () => checkPreselectedFile();
    window.addEventListener("preselected-sig-file", onPreselected);
    return () => window.removeEventListener("preselected-sig-file", onPreselected);
  }, []);
  const [signers, setSigners] = useState([
    { name: claim.policyholder_name || "", email: claim.policyholder_email || "", type: "policyholder", order: 1 }
  ]);
  const [selectedTemplate, setSelectedTemplate] = useState<any>(null);
  const [generatedDocUrl, setGeneratedDocUrl] = useState<string | null>(null);
  const [generatedDocPath, setGeneratedDocPath] = useState<string | null>(null);
  const [placedFields, setPlacedFields] = useState<any[]>([]);
  const [generatedDocxData, setGeneratedDocxData] = useState<Uint8Array | null>(null);
  const [sourceType, setSourceType] = useState<"template" | "claim_file" | "upload">("template");
  const [selectedClaimFile, setSelectedClaimFile] = useState<any>(null);
  const [uploadedFile, setUploadedFile] = useState<File | null>(null);

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

  const { data: claimPdfFiles, refetch: refetchSourceFiles } = useQuery({
    queryKey: signatureSourceFilesQueryKey(claimId, checkIntakeItemId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("claim_files")
        .select("id, file_name, file_path, uploaded_at, claim_id")
        .eq("claim_id", claimId)
        .order("uploaded_at", { ascending: false });
      if (error) throw error;
      let checkFiles: Array<Record<string, unknown>> = [];
      if (checkIntakeItemId) {
        const { data: checkRows, error: checkErr } = await supabase
          .from("check_files")
          .select("id, file_name, file_path, created_at, check_intake_item_id")
          .eq("check_intake_item_id", checkIntakeItemId)
          .order("created_at", { ascending: false });
        if (checkErr) throw checkErr;
        checkFiles = checkRows || [];
      }
      return mergeClaimAndCheckSignatureFiles({
        claimFiles: data || [],
        checkFiles,
        checkIntakeItemId,
      });
    },
    refetchOnMount: "always",
  });

  useEffect(() => {
    if (isCreateOpen) {
      void refetchSourceFiles();
    }
  }, [isCreateOpen, refetchSourceFiles]);

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

      const { data: docData, error: docError } = await supabase.functions.invoke(
        "generate-document",
        { body: { templateId: selectedTemplate.id, claimId } }
      );
      if (docError) throw docError;
      if (docData.error) throw new Error(docData.error);

      const isPDF = docData.isPDF;
      setIsDocxTemplate(!isPDF);
      
      const contentArray = Array.isArray(docData.content) 
        ? docData.content 
        : docData.content?.data || docData.content;
      
      const contentUint8 = new Uint8Array(contentArray);
      
      const mimeType = isPDF 
        ? "application/pdf" 
        : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

      const fileName = `signatures/${claimId}/${Date.now()}-${docData.fileName}`;
      const blob = new Blob([contentUint8], { type: mimeType });
      
      const { error: uploadError } = await supabase.storage
        .from("claim-files")
        .upload(fileName, blob);
      if (uploadError) throw uploadError;

      const { data: urlData } = await supabase.storage
        .from("claim-files")
        .createSignedUrl(fileName, 3600);

      setGeneratedDocPath(fileName);
      
      if (isPDF) {
        setGeneratedDocUrl(urlData?.signedUrl || null);
        setGeneratedDocxData(null);
      } else {
        setGeneratedDocUrl(null);
        setGeneratedDocxData(contentUint8);
      }
      
      return { fileName, url: urlData?.signedUrl, isPDF };
    },
    onSuccess: () => {
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

      const { data: urlData, error } = await supabase.storage
        .from("claim-files")
        .createSignedUrl(selectedClaimFile.file_path, 3600);
      if (error) {
        throw new Error("This file is no longer available in storage. Please upload the file directly instead.");
      }

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

  const uploadFileMutation = useMutation({
    mutationFn: async () => {
      if (!uploadedFile) throw new Error("No file selected");

      const isPDF = uploadedFile.name.toLowerCase().endsWith(".pdf");
      const isDocx = uploadedFile.name.toLowerCase().endsWith(".docx");
      if (!isPDF && !isDocx) throw new Error("Please upload a PDF or DOCX file");

      const sanitizedName = uploadedFile.name.replace(/[^a-zA-Z0-9.\-_]/g, "_");
      const fileName = `signatures/${claimId}/${Date.now()}-${sanitizedName}`;

      const { error: uploadError } = await supabase.storage
        .from("claim-files")
        .upload(fileName, uploadedFile);
      if (uploadError) throw uploadError;

      const { data: urlData, error: urlError } = await supabase.storage
        .from("claim-files")
        .createSignedUrl(fileName, 3600);
      if (urlError) throw urlError;

      setGeneratedDocPath(fileName);
      setIsDocxTemplate(isDocx);

      if (isPDF) {
        setGeneratedDocUrl(urlData?.signedUrl || null);
        setGeneratedDocxData(null);
      } else {
        setGeneratedDocUrl(null);
        const arrayBuffer = await uploadedFile.arrayBuffer();
        setGeneratedDocxData(new Uint8Array(arrayBuffer));
      }

      return { fileName, url: urlData?.signedUrl };
    },
    onSuccess: () => {
      setCurrentStep(2);
      toast({ title: "File uploaded! Now place signature fields." });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to upload file", description: error.message, variant: "destructive" });
    },
  });

  const createRequestMutation = useMutation({
    mutationFn: async ({ skipEmail = false }: { skipEmail?: boolean }) => {
      if (!generatedDocPath) throw new Error("Missing required data");

      // Guard against stale/missing storage files to avoid sending broken sign links
      const { data: docCheck, error: docCheckError } = await supabase.storage
        .from("claim-files")
        .createSignedUrl(generatedDocPath, 60);

      if (docCheckError || !docCheck?.signedUrl) {
        throw new Error("Document file is missing in storage. Please regenerate the document before sending.");
      }

      const docName = sourceType === "claim_file" 
        ? selectedClaimFile?.file_name || "Document" 
        : sourceType === "upload"
        ? uploadedFile?.name || "Document"
        : selectedTemplate?.name || "Document";

      const { data: request, error: requestError } = await supabase
        .from("signature_requests")
        .insert({
          claim_id: claimId,
          check_intake_item_id: checkIntakeItemId || null,
          document_name: docName,
          document_path: generatedDocPath,
          document_type: detectDocumentType(docName),
          field_data: placedFields,
          status: "draft",
        })
        .select()
        .single();
      if (requestError) throw requestError;

      if (checkIntakeItemId && generatedDocPath) {
        await supabase
          .from("check_files")
          .update({ signature_request_id: request.id })
          .eq("check_intake_item_id", checkIntakeItemId)
          .eq("file_path", generatedDocPath);
      }

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

      const { data, error } = await supabase.functions.invoke("send-signature-request", {
        body: { requestId: request.id, skipEmail },
      });
      if (error) {
        throw new Error(await getFunctionErrorMessage(error, "Could not send signature request"));
      }
      if (data && !data.ok) throw new Error(data.error || "Send failed");

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
      setUploadedFile(null);
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

  const resendMutation = useMutation({
    mutationFn: async ({ requestId, targetSignerIds }: { requestId: string; targetSignerIds?: string[] }) => {
      const { data, error } = await supabase.functions.invoke("send-signature-request", {
        body: { requestId, skipEmail: false, targetSignerIds },
      });
      if (error) {
        throw new Error(await getFunctionErrorMessage(error, "Could not resend"));
      }
      if (data && !data.ok) throw new Error(data.error || "Resend failed");
      return data;
    },
    onSuccess: () => {
      toast({ title: "Signature request resent" });
      queryClient.invalidateQueries({ queryKey: ["signature-requests"] });
    },
    onError: (error: Error) => {
      toast({ title: "Resend failed", description: error.message, variant: "destructive" });
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
      const { error: storageError } = await supabase.storage
        .from("claim-files")
        .remove([request.document_path]);
      if (storageError) console.error("Storage deletion error:", storageError);

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
      case "signed": return <Check className="w-4 h-4 text-green-600" />;
      case "in_progress": return <Clock className="w-4 h-4 text-yellow-600" />;
      case "viewed": return <Clock className="w-4 h-4 text-blue-600" />;
      case "declined": return <X className="w-4 h-4 text-red-600" />;
      case "failed": return <X className="w-4 h-4 text-red-600" />;
      default: return <Clock className="w-4 h-4 text-muted-foreground" />;
    }
  };

  const getStatusBadge = (request: any) => {
    const status = request.status;
    const completionStatus = request.completion_status;

    const variants: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
      completed: "default",
      in_progress: "secondary",
      failed: "destructive",
      declined: "destructive",
      pending: "outline",
      draft: "outline",
    };

    let label = status;
    if (status === "completed" && completionStatus === "failed") {
      label = "Signed — PDF Failed";
    } else {
      const labels: Record<string, string> = {
        pending: "Sent",
        in_progress: "Partially Signed",
        completed: "Completed",
        failed: "Failed",
        declined: "Declined",
        draft: "Draft",
      };
      label = labels[status] || status.replace("_", " ");
    }

    const variant = status === "completed" && completionStatus === "failed"
      ? "destructive" as const
      : (variants[status] || "outline") as "default" | "secondary" | "destructive" | "outline";

    return <Badge variant={variant}>{label}</Badge>;
  };

  const requestAlreadySigned = (request: any) => {
    const status = String(request?.status || "");
    if (status === "completed" || status === "signed") return true;
    const list = request?.signature_signers || [];
    return list.length > 0 && list.every((signer: any) => signer.status === "signed");
  };

  const canResendRequest = (request: any) => {
    if (requestAlreadySigned(request)) return false;
    return request.status === "failed" || request.status === "pending";
  };

  const getSignerStatusLabel = (signer: any) => {
    if (signer.status === "signed") return `Signed ${new Date(signer.signed_at!).toLocaleDateString()}`;
    if (signer.viewed_at) return `Viewed ${new Date(signer.viewed_at).toLocaleDateString()}`;
    if (signer.delivery_status === "sent") return "Email sent";
    if (signer.delivery_status === "failed") return "Send failed";
    return signer.status;
  };

  const handleOpenDocument = async (request: any) => {
    try {
      // Prefer final signed PDF if available
      const path = request.final_pdf_path || request.document_path;
      if (!path) throw new Error("No document path found");

      const { data, error } = await supabase.storage
        .from("claim-files")
        .createSignedUrl(path, 3600);

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
          <DialogContent className="w-[calc(100%-2rem)] max-w-4xl max-h-[90vh] min-w-0 overflow-x-hidden overflow-y-auto p-4 sm:p-6">
            <DialogHeader className="min-w-0 space-y-1.5 pr-8 text-left">
              <DialogTitle className="text-base leading-snug break-words sm:text-lg">
                Create Signature Request - Step {currentStep} of 3
              </DialogTitle>
              <DialogDescription className="text-left">
                {currentStep === 1 && "Select a document source"}
                {currentStep === 2 && "Place signature and date fields on the document"}
                {currentStep === 3 && "Configure signers"}
              </DialogDescription>
            </DialogHeader>

            {/* Step 1: Source Selection */}
            {currentStep === 1 && (
              <div className="min-w-0 space-y-4">
                <div>
                  <Label>Document Source</Label>
                  <Select value={sourceType} onValueChange={(v) => { setSourceType(v as any); setSelectedTemplate(null); setSelectedClaimFile(null); setUploadedFile(null); }}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="template">Generate from Template</SelectItem>
                      <SelectItem value="upload">Upload a File</SelectItem>
                      <SelectItem value="claim_file">Use Existing Claim/Check File</SelectItem>
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

                {sourceType === "upload" && (
                  <div>
                    <Label>Upload PDF or DOCX</Label>
                    <div className="mt-1.5">
                      <Input
                        type="file"
                        accept=".pdf,.docx"
                        onChange={(e) => setUploadedFile(e.target.files?.[0] || null)}
                      />
                      {uploadedFile && (
                        <p className="text-xs text-muted-foreground mt-1.5 flex items-center gap-1">
                          <Upload className="w-3 h-3" />
                          {uploadedFile.name} ({(uploadedFile.size / 1024).toFixed(0)} KB)
                        </p>
                      )}
                    </div>
                  </div>
                )}

                {sourceType === "claim_file" && (
                  <div>
                    <Label>Existing file (PDF or DOCX)</Label>
                    <Select
                      value={selectedClaimFile?.id}
                      onValueChange={(id) =>
                        setSelectedClaimFile(claimPdfFiles?.find((f) => f.id === id))
                      }
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select a file from claim/check files" />
                      </SelectTrigger>
                      <SelectContent>
                        {claimPdfFiles?.length === 0 && (
                          <div className="px-3 py-2 text-sm text-muted-foreground">No PDF or DOCX files found for this claim/check</div>
                        )}
                        {claimPdfFiles?.map((file) => (
                          <SelectItem key={`${file._source}:${file.id}`} value={file.id}>
                            {file.file_name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground mt-1">
                      If a file fails to load, use "Upload a File" instead.
                    </p>
                  </div>
                )}
              </div>
            )}

            {/* Step 2: Field Placement */}
            {currentStep === 2 && (generatedDocUrl || generatedDocxData) && (
              <Suspense fallback={<div className="py-10 text-center text-sm text-muted-foreground">Loading document editor…</div>}>
              <FieldPlacementEditor
                documentUrl={generatedDocUrl || undefined}
                docxData={generatedDocxData || undefined}
                onFieldsChange={setPlacedFields}
                signerCount={signers.length}
              />
              </Suspense>
            )}

            {/* Step 3: Signer Configuration */}
            {currentStep === 3 && (
              <div className="min-w-0 space-y-3">
                <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                  <Label className="min-w-0">Signers (in order)</Label>
                  <Button type="button" variant="outline" size="sm" className="shrink-0" onClick={addSigner}>
                    <Plus className="w-3 h-3 mr-1" />
                    Add Signer
                  </Button>
                </div>
                {signers.map((signer, index) => (
                  <div key={index} className="flex min-w-0 items-start gap-2">
                    <div className="grid min-w-0 flex-1 grid-cols-1 gap-2 sm:grid-cols-3">
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

            <DialogFooter className="sticky bottom-0 z-10 min-w-0 bg-background pt-2">
              <div className="flex w-full min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex w-full min-w-0 sm:w-auto">
                  {currentStep > 1 && (
                    <Button
                      variant="outline"
                      className="w-full sm:w-auto"
                      onClick={() => setCurrentStep((currentStep - 1) as 1 | 2 | 3)}
                    >
                      <ChevronLeft className="w-4 h-4 mr-2" />
                      Back
                    </Button>
                  )}
                </div>
                <div className="flex w-full min-w-0 flex-col gap-2 sm:w-auto sm:flex-row sm:justify-end">
                  {currentStep === 1 && sourceType === "template" && (
                    <Button
                      className="w-full sm:w-auto"
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
                      className="w-full sm:w-auto"
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
                  {currentStep === 1 && sourceType === "upload" && (
                    <Button
                      className="w-full sm:w-auto"
                      onClick={() => uploadFileMutation.mutate()}
                      disabled={!uploadedFile || uploadFileMutation.isPending}
                    >
                      {uploadFileMutation.isPending ? (
                        <>
                          <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                          Uploading...
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
                    <Button className="w-full sm:w-auto" onClick={() => setCurrentStep(3)}>
                      Next
                      <ChevronRight className="w-4 h-4 ml-2" />
                    </Button>
                  )}
                  {currentStep === 3 && (
                    <>
                      <Button
                        variant="outline"
                        className="w-full sm:w-auto"
                        onClick={() => createRequestMutation.mutate({ skipEmail: true })}
                        disabled={signers.some(s => !s.name || !s.email) || createRequestMutation.isPending}
                      >
                        <Link2 className="w-4 h-4 mr-2" />
                        Generate Link Only
                      </Button>
                      <Button
                        className="w-full sm:w-auto"
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
                        {request.sent_at && ` · Sent ${new Date(request.sent_at).toLocaleDateString()}`}
                        {request.completed_at && ` · Completed ${new Date(request.completed_at).toLocaleDateString()}`}
                      </CardDescription>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleOpenDocument(request)}
                    >
                      {request.final_pdf_path ? "View Signed PDF" : "Open Document"}
                    </Button>
                    {canResendRequest(request) && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => resendMutation.mutate({ requestId: request.id })}
                        disabled={resendMutation.isPending}
                      >
                        <RefreshCw className={`w-3 h-3 mr-1 ${resendMutation.isPending ? "animate-spin" : ""}`} />
                        Resend All
                      </Button>
                    )}
                    {getStatusBadge(request)}
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
                {request.last_error && (
                  <div className="flex items-center gap-1.5 mt-1.5 text-xs text-destructive">
                    <AlertTriangle className="w-3 h-3" />
                    {request.last_error}
                  </div>
                )}
                {request.completion_status === "failed" && (
                  <div className="flex items-center gap-2 mt-1">
                    <div className="flex items-center gap-1.5 text-xs text-amber-600">
                      <AlertTriangle className="w-3 h-3" />
                      Signatures captured but final PDF generation failed
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-6 px-2 text-xs"
                      onClick={async () => {
                        toast({ title: "Retrying PDF generation..." });
                        try {
                          const { data, error } = await supabase.functions.invoke("retry-pdf-generation", {
                            body: { requestId: request.id },
                          });
                          if (error) throw error;
                          if (data?.ok) {
                            toast({ title: "✅ Signed PDF generated successfully!" });
                            queryClient.invalidateQueries({ queryKey: ["signature-requests", claimId] });
                          } else {
                            toast({ title: "PDF generation failed", description: data?.error, variant: "destructive" });
                          }
                        } catch (err: any) {
                          toast({ title: "Retry failed", description: err.message, variant: "destructive" });
                        }
                      }}
                    >
                      <RefreshCw className="w-3 h-3 mr-1" />
                      Retry PDF
                    </Button>
                  </div>
                )}
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
                        <div className="flex items-center gap-2">
                          {signer.delivery_status === "failed" && signer.status !== "signed" && !requestAlreadySigned(request) && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-6 px-2 text-xs text-destructive hover:text-destructive"
                              onClick={() => resendMutation.mutate({ requestId: request.id, targetSignerIds: [signer.id] })}
                              disabled={resendMutation.isPending}
                            >
                              <RefreshCw className="w-3 h-3 mr-1" />
                              Retry
                            </Button>
                          )}
                          <Badge variant={signer.delivery_status === "failed" ? "destructive" : "outline"} className="text-xs">
                            {getSignerStatusLabel(signer)}
                          </Badge>
                        </div>
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

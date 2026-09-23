import { useMemo, useRef, useState } from "react";
import type { ChecksOpsClient } from "@/integrations/aws/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import {
  FileText,
  Plus,
  Trash2,
  Upload,
  Download,
  Send,
  Loader2,
  Sparkles,
} from "lucide-react";
import { format } from "date-fns";

export interface LossDraftDocRow {
  id: string;
  document_type: string;
  document_label: string;
  is_required: boolean;
  is_submitted: boolean;
  submitted_at?: string | null;
  file_id?: string | null;
  file_path?: string | null;
  file_name?: string | null;
  signature_request_id?: string | null;
  is_template_generated?: boolean | null;
  notes?: string | null;
}

export interface LossDraftClaimContext {
  homeowner_name?: string | null;
  homeowner_email?: string | null;
  property_address?: string | null;
  claim_number?: string | null;
  policy_number?: string | null;
  carrier?: string | null;
  loss_date?: string | null;
  mortgage_company?: string | null;
  loan_number?: string | null;
}

interface Props {
  supabaseClient: ChecksOpsClient;
  lossDraftId: string;
  claimId: string | null;
  claimContext: LossDraftClaimContext;
  docs: LossDraftDocRow[];
  actorId: string | null;
  onChanged: () => void;
  /**
   * Called after a document is generated or uploaded and is ready to be sent
   * to the homeowner for e-signature. The parent owns the field-placement
   * editor + send-signature flow.
   */
  onSendForSignature?: (payload: {
    docId: string;
    path: string;
    fileName: string;
    documentLabel: string;
    signedUrl: string;
  }) => void;
  canSendSignature?: boolean;
}

type PresetKey =
  | "tpa"
  | "lien_waiver"
  | "endorsed_check"
  | "contractor_estimate"
  | "signed_contract"
  | "w9"
  | "certificate_completion"
  | "inspection_report"
  | "photos_before"
  | "photos_progress"
  | "photos_after"
  | "adjuster_report"
  | "custom";

interface Preset {
  key: PresetKey;
  document_type: string;
  label: string;
  template?: "tpa" | "lien_waiver"; // ChecksOps-generated
  requiresSignature?: boolean;
}

const PRESETS: Preset[] = [
  { key: "tpa", document_type: "third_party_authorization", label: "Third Party Authorization (ChecksOps template)", template: "tpa", requiresSignature: true },
  { key: "lien_waiver", document_type: "lien_waiver", label: "Lien Waiver (ChecksOps template)", template: "lien_waiver", requiresSignature: true },
  { key: "endorsed_check", document_type: "endorsed_check", label: "Endorsed Insurance Check" },
  { key: "contractor_estimate", document_type: "contractor_estimate", label: "Contractor Estimate / Scope of Work" },
  { key: "signed_contract", document_type: "signed_contract", label: "Signed Repair Contract" },
  { key: "w9", document_type: "w9", label: "Contractor W-9" },
  { key: "certificate_completion", document_type: "certificate_completion", label: "Certificate of Completion" },
  { key: "inspection_report", document_type: "inspection_report", label: "Lender Inspection Report" },
  { key: "photos_before", document_type: "photos_before", label: "Before Photos" },
  { key: "photos_progress", document_type: "photos_progress", label: "Progress Photos" },
  { key: "photos_after", document_type: "photos_after", label: "After / Completion Photos" },
  { key: "adjuster_report", document_type: "adjuster_report", label: "Insurance Adjuster Report" },
  { key: "custom", document_type: "custom", label: "Other / Custom document…" },
];

export function LossDraftDocsManager({
  supabaseClient,
  lossDraftId,
  claimId,
  claimContext,
  docs,
  actorId,
  onChanged,
  onSendForSignature,
  canSendSignature = true,
}: Props) {
  const { toast } = useToast();
  const [addOpen, setAddOpen] = useState(false);
  const [selectedPreset, setSelectedPreset] = useState<PresetKey | "">("");
  const [customLabel, setCustomLabel] = useState("");
  const [templateForm, setTemplateForm] = useState<LossDraftClaimContext & { contractor_name?: string; contractor_amount?: string }>({});
  const [templateOpen, setTemplateOpen] = useState<null | { preset: Preset; docId?: string }>(null);
  const [busy, setBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadingDocId, setUploadingDocId] = useState<string | null>(null);

  const supabase = supabaseClient;

  const openTemplateFor = (preset: Preset, docId?: string) => {
    setTemplateForm({
      homeowner_name: claimContext.homeowner_name ?? "",
      property_address: claimContext.property_address ?? "",
      claim_number: claimContext.claim_number ?? "",
      policy_number: claimContext.policy_number ?? "",
      carrier: claimContext.carrier ?? "",
      loss_date: claimContext.loss_date ?? "",
      mortgage_company: claimContext.mortgage_company ?? "",
      loan_number: claimContext.loan_number ?? "",
      contractor_name: "",
      contractor_amount: "",
    });
    setTemplateOpen({ preset, docId });
  };

  const handleAdd = async () => {
    if (!selectedPreset) return;
    const preset = PRESETS.find((p) => p.key === selectedPreset)!;
    const label = preset.key === "custom" ? customLabel.trim() : preset.label.replace(/\s*\(ChecksOps template\)$/, "");
    if (preset.key === "custom" && !label) {
      toast({ title: "Enter a document name", variant: "destructive" });
      return;
    }

    setBusy(true);
    try {
      const { data: inserted, error } = await supabase
        .from("loss_draft_documents")
        .insert({
          loss_draft_id: lossDraftId,
          document_type: preset.document_type === "custom" ? `custom_${Date.now()}` : preset.document_type,
          document_label: label,
          is_required: false,
        })
        .select("id")
        .single();
      if (error) throw error;

      toast({ title: "Document added" });
      setAddOpen(false);
      setSelectedPreset("");
      setCustomLabel("");
      onChanged();

      if (preset.template) {
        // Immediately open the fill-in dialog for ChecksOps templates
        openTemplateFor(preset, inserted?.id);
      }
    } catch (e: any) {
      toast({ title: "Failed to add", description: e.message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const handleGenerateTemplate = async () => {
    if (!templateOpen || !claimId) return;
    const { preset, docId } = templateOpen;
    if (!preset.template) return;
    if (!templateForm.homeowner_name?.trim()) {
      toast({ title: "Homeowner name required", variant: "destructive" });
      return;
    }
    setBusy(true);
    try {
      const { data, error } = await supabase.functions.invoke("generate-checksops-doc", {
        body: {
          claim_id: claimId,
          loss_draft_id: lossDraftId,
          template: preset.template,
          homeowner_name: templateForm.homeowner_name,
          property_address: templateForm.property_address,
          claim_number: templateForm.claim_number,
          policy_number: templateForm.policy_number,
          carrier: templateForm.carrier,
          loss_date: templateForm.loss_date,
          mortgage_company: templateForm.mortgage_company,
          loan_number: templateForm.loan_number,
          contractor_name: templateForm.contractor_name,
          contractor_amount: templateForm.contractor_amount,
        },
      });
      if (error) throw error;
      if (!data?.ok || !data?.path) throw new Error(data?.error || "Failed to generate document");

      // Attach to the doc row
      if (docId) {
        await supabase
          .from("loss_draft_documents")
          .update({
            file_path: data.path,
            file_name: data.file_name,
            is_template_generated: true,
            is_submitted: true,
            submitted_at: new Date().toISOString(),
            submitted_by: actorId,
          })
          .eq("id", docId);
      }

      toast({ title: "Template generated", description: docId ? "Place signature fields, then send to the homeowner." : "Downloading…" });
      setTemplateOpen(null);
      onChanged();

      if (!docId && data.signed_url) {
        // Blank/download-only flow — just open the PDF
        window.open(data.signed_url, "_blank");
      } else if (onSendForSignature && data.signed_url && docId) {
        onSendForSignature({
          docId,
          path: data.path,
          fileName: data.file_name,
          documentLabel: data.document_label || preset.label,
          signedUrl: data.signed_url,
        });
      }
    } catch (e: any) {
      toast({ title: "Generation failed", description: e.message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const handleUploadFile = async (docId: string, file: File) => {
    if (!claimId) return;
    setUploadingDocId(docId);
    try {
      const safeName = file.name.replace(/[^a-zA-Z0-9.\-_]/g, "_");
      const path = `${claimId}/${lossDraftId}/${docId}/${Date.now()}-${safeName}`;
      const { error: upErr } = await supabase.storage
        .from("loss-draft-documents")
        .upload(path, file, { upsert: true });
      if (upErr) throw upErr;

      const { error: updErr } = await supabase
        .from("loss_draft_documents")
        .update({
          file_path: path,
          file_name: file.name,
          is_submitted: true,
          submitted_at: new Date().toISOString(),
          submitted_by: actorId,
        })
        .eq("id", docId);
      if (updErr) throw updErr;

      toast({ title: "Uploaded" });
      onChanged();
    } catch (e: any) {
      toast({ title: "Upload failed", description: e.message, variant: "destructive" });
    } finally {
      setUploadingDocId(null);
    }
  };

  const handleDelete = async (doc: LossDraftDocRow) => {
    if (!confirm(`Remove "${doc.document_label}" from this loss draft?`)) return;
    try {
      if (doc.file_path) {
        await supabase.storage.from("loss-draft-documents").remove([doc.file_path]);
      }
      const { error } = await supabase
        .from("loss_draft_documents")
        .delete()
        .eq("id", doc.id);
      if (error) throw error;
      toast({ title: "Removed" });
      onChanged();
    } catch (e: any) {
      toast({ title: "Delete failed", description: e.message, variant: "destructive" });
    }
  };

  const handleRemoveFile = async (doc: LossDraftDocRow) => {
    if (!doc.file_path) return;
    if (!confirm(`Remove the attached file from "${doc.document_label}"? The document row will stay so you can upload a new one.`)) return;
    try {
      const bucket = doc.is_template_generated ? "claim-files" : "loss-draft-documents";
      await supabase.storage.from(bucket).remove([doc.file_path]);
      const { error } = await supabase
        .from("loss_draft_documents")
        .update({
          file_path: null,
          file_name: null,
          file_id: null,
          is_submitted: false,
          submitted_at: null,
          is_template_generated: false,
          signature_request_id: null,
        })
        .eq("id", doc.id);
      if (error) throw error;
      toast({ title: "Attachment removed" });
      onChanged();
    } catch (e: any) {
      toast({ title: "Remove failed", description: e.message, variant: "destructive" });
    }
  };

  const handleReplaceFile = (doc: LossDraftDocRow) => {
    setUploadingDocId(doc.id);
    fileInputRef.current?.click();
  };

  const handleToggle = async (doc: LossDraftDocRow) => {
    try {
      const { error } = await supabase
        .from("loss_draft_documents")
        .update({
          is_submitted: !doc.is_submitted,
          submitted_at: !doc.is_submitted ? new Date().toISOString() : null,
        })
        .eq("id", doc.id);
      if (error) throw error;
      onChanged();
    } catch (e: any) {
      toast({ title: "Update failed", description: e.message, variant: "destructive" });
    }
  };

  const handleDownload = async (doc: LossDraftDocRow) => {
    if (!doc.file_path) return;
    // Templates live in claim-files; user uploads live in loss-draft-documents
    const bucket = doc.is_template_generated ? "claim-files" : "loss-draft-documents";
    try {
      const { data, error } = await supabase.storage
        .from(bucket)
        .createSignedUrl(doc.file_path, 300, { download: doc.file_name || "document.pdf" });
      if (error) throw error;
      window.open(data.signedUrl, "_blank");
    } catch (e: any) {
      toast({ title: "Download failed", description: e.message, variant: "destructive" });
    }
  };

  const handleSendExisting = async (doc: LossDraftDocRow) => {
    if (!doc.file_path || !onSendForSignature) return;
    const bucket = doc.is_template_generated ? "claim-files" : "loss-draft-documents";
    try {
      const { data, error } = await supabase.storage
        .from(bucket)
        .createSignedUrl(doc.file_path, 3600);
      if (error) throw error;
      onSendForSignature({
        docId: doc.id,
        path: doc.file_path,
        fileName: doc.file_name || "document.pdf",
        documentLabel: doc.document_label,
        signedUrl: data.signedUrl,
      });
    } catch (e: any) {
      toast({ title: "Could not open", description: e.message, variant: "destructive" });
    }
  };

  const selectedPresetObj = useMemo(
    () => PRESETS.find((p) => p.key === selectedPreset),
    [selectedPreset],
  );

  return (
    <div className="space-y-2">
      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        accept=".pdf,.doc,.docx,.jpg,.jpeg,.png,.xls,.xlsx"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f && uploadingDocId) handleUploadFile(uploadingDocId, f);
          e.target.value = "";
        }}
      />

      <div className="flex items-center justify-between">
        <div className="text-sm font-semibold flex items-center gap-2">
          <FileText className="h-4 w-4" /> Loss draft documents{" "}
          <span className="text-xs text-muted-foreground">
            ({docs.filter((d) => d.is_submitted).length}/{docs.length})
          </span>
        </div>
        <Button size="sm" variant="outline" onClick={() => setAddOpen(true)}>
          <Plus className="h-3 w-3 mr-1" /> Add document
        </Button>
      </div>

      {/* Quick-download ChecksOps letterhead templates */}
      <div className="flex flex-wrap items-center gap-2 rounded-md border border-dashed border-border p-2 bg-muted/20">
        <span className="text-[11px] text-muted-foreground flex items-center gap-1">
          <Sparkles className="h-3 w-3" /> ChecksOps letterhead:
        </span>
        <Select
          onValueChange={(v) => {
            const preset = PRESETS.find((p) => p.key === v);
            if (preset?.template) openTemplateFor(preset);
          }}
        >
          <SelectTrigger className="h-7 text-[11px] w-[220px]">
            <SelectValue placeholder="Download blank template…" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="tpa">Third Party Authorization</SelectItem>
            <SelectItem value="lien_waiver">Waiver of Lien</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {docs.length === 0 ? (
        <p className="text-xs text-muted-foreground italic py-2">
          No documents yet. Click "Add document" to pick from the checklist or generate a
          ChecksOps template.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {docs.map((d) => (
            <li key={d.id} className="py-2 space-y-1">
              <div className="flex items-start gap-2">
                <input
                  type="checkbox"
                  checked={d.is_submitted}
                  onChange={() => handleToggle(d)}
                  className="mt-1"
                />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate">{d.document_label}</div>
                  <div className="flex flex-wrap gap-1 mt-0.5 items-center">
                    {d.is_template_generated && (
                      <Badge variant="secondary" className="text-[9px]">
                        <Sparkles className="h-2.5 w-2.5 mr-0.5" /> ChecksOps template
                      </Badge>
                    )}
                    {d.signature_request_id && (
                      <Badge variant="outline" className="text-[9px]">signature sent</Badge>
                    )}
                    {d.submitted_at && (
                      <span className="text-[10px] text-muted-foreground">
                        {format(new Date(d.submitted_at), "M/d/yy")}
                      </span>
                    )}
                  </div>
                </div>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-6 w-6 text-destructive"
                  onClick={() => handleDelete(d)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
              <div className="pl-6 flex flex-wrap gap-1.5">
                {d.file_path ? (
                  <>
                    <Button size="sm" variant="outline" className="h-6 text-[11px]" onClick={() => handleDownload(d)}>
                      <Download className="h-3 w-3 mr-1" /> {d.file_name || "Download"}
                    </Button>
                    {canSendSignature && onSendForSignature && !d.signature_request_id && (
                      <Button size="sm" variant="outline" className="h-6 text-[11px]" onClick={() => handleSendExisting(d)}>
                        <Send className="h-3 w-3 mr-1" /> Send for signature
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-6 text-[11px]"
                      disabled={uploadingDocId === d.id}
                      onClick={() => handleReplaceFile(d)}
                    >
                      {uploadingDocId === d.id ? (
                        <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                      ) : (
                        <Upload className="h-3 w-3 mr-1" />
                      )}
                      Replace
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 text-[11px] text-destructive"
                      onClick={() => handleRemoveFile(d)}
                    >
                      <Trash2 className="h-3 w-3 mr-1" /> Remove file
                    </Button>
                  </>
                ) : (
                  <>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-6 text-[11px]"
                      disabled={uploadingDocId === d.id}
                      onClick={() => {
                        setUploadingDocId(d.id);
                        fileInputRef.current?.click();
                      }}
                    >
                      {uploadingDocId === d.id ? (
                        <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                      ) : (
                        <Upload className="h-3 w-3 mr-1" />
                      )}
                      Upload file
                    </Button>
                    {(d.document_type === "third_party_authorization" || d.document_type === "lien_waiver") && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-6 text-[11px]"
                        onClick={() => {
                          const preset = PRESETS.find((p) => p.document_type === d.document_type)!;
                          openTemplateFor(preset, d.id);
                        }}
                      >
                        <Sparkles className="h-3 w-3 mr-1" /> Generate template
                      </Button>
                    )}
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* Add document dialog */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add loss draft document</DialogTitle>
            <DialogDescription>
              Pick a preset or generate a ChecksOps template pre-filled with claim info.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label className="text-xs">Document</Label>
              <Select value={selectedPreset} onValueChange={(v) => setSelectedPreset(v as PresetKey)}>
                <SelectTrigger><SelectValue placeholder="Select…" /></SelectTrigger>
                <SelectContent className="max-h-72">
                  {PRESETS.map((p) => (
                    <SelectItem key={p.key} value={p.key}>{p.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {selectedPreset === "custom" && (
              <div>
                <Label className="text-xs">Custom document name</Label>
                <Input value={customLabel} onChange={(e) => setCustomLabel(e.target.value)} placeholder="e.g. City permit approval" />
              </div>
            )}
            {selectedPresetObj?.template && (
              <p className="text-xs text-muted-foreground">
                After adding, you'll fill in claim details, generate the PDF on ChecksOps
                letterhead, then place signature fields before sending to the homeowner.
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOpen(false)}>Cancel</Button>
            <Button onClick={handleAdd} disabled={busy || !selectedPreset}>
              {busy && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
              Add
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Template fill-in dialog */}
      <Dialog open={!!templateOpen} onOpenChange={(o) => !o && setTemplateOpen(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {templateOpen?.preset.template === "tpa"
                ? "Third Party Authorization"
                : "Lien Waiver"}
            </DialogTitle>
            <DialogDescription>
              Confirm the details — fields are pre-filled from the claim. Blank fields will
              print as underlines on the generated PDF.
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-2 max-h-[60vh] overflow-y-auto">
            <div className="col-span-2">
              <Label className="text-xs">Homeowner name *</Label>
              <Input value={templateForm.homeowner_name ?? ""} onChange={(e) => setTemplateForm({ ...templateForm, homeowner_name: e.target.value })} />
            </div>
            <div className="col-span-2">
              <Label className="text-xs">Property address</Label>
              <Input value={templateForm.property_address ?? ""} onChange={(e) => setTemplateForm({ ...templateForm, property_address: e.target.value })} />
            </div>
            <div>
              <Label className="text-xs">Carrier</Label>
              <Input value={templateForm.carrier ?? ""} onChange={(e) => setTemplateForm({ ...templateForm, carrier: e.target.value })} />
            </div>
            <div>
              <Label className="text-xs">Claim number</Label>
              <Input value={templateForm.claim_number ?? ""} onChange={(e) => setTemplateForm({ ...templateForm, claim_number: e.target.value })} />
            </div>
            <div>
              <Label className="text-xs">Policy number</Label>
              <Input value={templateForm.policy_number ?? ""} onChange={(e) => setTemplateForm({ ...templateForm, policy_number: e.target.value })} />
            </div>
            <div>
              <Label className="text-xs">Date of loss</Label>
              <Input value={templateForm.loss_date ?? ""} onChange={(e) => setTemplateForm({ ...templateForm, loss_date: e.target.value })} />
            </div>
            <div>
              <Label className="text-xs">Mortgage company</Label>
              <Input value={templateForm.mortgage_company ?? ""} onChange={(e) => setTemplateForm({ ...templateForm, mortgage_company: e.target.value })} />
            </div>
            <div>
              <Label className="text-xs">Loan number</Label>
              <Input value={templateForm.loan_number ?? ""} onChange={(e) => setTemplateForm({ ...templateForm, loan_number: e.target.value })} />
            </div>
            {templateOpen?.preset.template === "lien_waiver" && (
              <>
                <div>
                  <Label className="text-xs">Contractor name</Label>
                  <Input value={templateForm.contractor_name ?? ""} onChange={(e) => setTemplateForm({ ...templateForm, contractor_name: e.target.value })} />
                </div>
                <div>
                  <Label className="text-xs">Amount paid</Label>
                  <Input value={templateForm.contractor_amount ?? ""} onChange={(e) => setTemplateForm({ ...templateForm, contractor_amount: e.target.value })} />
                </div>
              </>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTemplateOpen(null)}>Cancel</Button>
            <Button onClick={handleGenerateTemplate} disabled={busy}>
              {busy && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
              Generate & prepare signature
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

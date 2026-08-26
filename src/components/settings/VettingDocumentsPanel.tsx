import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Eye, FileText, Loader2, Trash2, Upload, ShieldCheck, CheckCircle2, CircleDashed } from "lucide-react";
import { format } from "date-fns";

/**
 * Tenant vetting document library. Unlike the payment-provider verification
 * panel, this is stored in ChecksOps itself and does not require a payment
 * account — it is the onboarding paperwork we collect from every organization.
 */

export const VETTING_DOC_TYPES = [
  { value: "w9", label: "W-9" },
  { value: "business_license", label: "Business License" },
  { value: "certificate_of_insurance", label: "Certificate of Insurance" },
  { value: "articles_of_incorporation", label: "Articles of Incorporation / Formation" },
  { value: "ein_letter", label: "EIN Confirmation Letter" },
  { value: "voided_check", label: "Voided Check / Bank Letter" },
  { value: "photo_id", label: "Owner Photo ID" },
  { value: "saas_agreement", label: "SaaS Agreement (signed)" },
  { value: "terms_of_service", label: "Terms of Service (signed)" },
  { value: "privacy_policy", label: "Privacy Policy (acknowledged)" },
  { value: "other", label: "Other supporting document" },
] as const;

const DOC_LABEL: Record<string, string> = Object.fromEntries(
  VETTING_DOC_TYPES.map((d) => [d.value, d.label]),
);

const REQUIRED_TYPES = [
  "w9",
  "business_license",
  "certificate_of_insurance",
  "saas_agreement",
  "terms_of_service",
  "privacy_policy",
];

const STATUS_CLASS: Record<string, string> = {
  pending: "border-amber-500/40 text-amber-500",
  approved: "border-emerald-500/40 text-emerald-500",
  rejected: "border-destructive/40 text-destructive",
};

const STATUS_LABEL: Record<string, string> = {
  pending: "In review",
  approved: "Approved",
  rejected: "Rejected",
};

const ACCEPTED = ".pdf,.jpg,.jpeg,.png,.doc,.docx";
const MAX_BYTES = 20 * 1024 * 1024;
const BUCKET = "tenant-documents";

interface VettingDoc {
  id: string;
  doc_type: string;
  file_name: string;
  file_path: string;
  file_size_bytes: number | null;
  review_status: string;
  expires_on: string | null;
  created_at: string;
}

export function VettingDocumentsPanel({
  tenantId,
  canManage = true,
}: {
  tenantId?: string | null;
  canManage?: boolean;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);

  const [docType, setDocType] = useState<string>("w9");
  const [expiresOn, setExpiresOn] = useState("");
  const [busy, setBusy] = useState(false);
  const [openingId, setOpeningId] = useState<string | null>(null);

  const { data: docs = [], isLoading } = useQuery({
    queryKey: ["tenant-vetting-documents", tenantId],
    enabled: !!tenantId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("tenant_vetting_documents")
        .select("id, doc_type, file_name, file_path, file_size_bytes, review_status, expires_on, created_at")
        .eq("tenant_id", tenantId!)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as VettingDoc[];
    },
  });

  async function handleFile(file: File) {
    if (!tenantId) return;
    if (file.size > MAX_BYTES) {
      toast({ title: "File too large", description: "Documents must be 20 MB or smaller.", variant: "destructive" });
      return;
    }
    setBusy(true);
    try {
      const safeName = file.name.replace(/[^\w.\-]+/g, "_");
      const path = `${tenantId}/vetting/${docType}-${Date.now()}-${safeName}`;
      const { error: upErr } = await supabase.storage
        .from(BUCKET)
        .upload(path, file, { contentType: file.type || "application/octet-stream", upsert: false });
      if (upErr) throw upErr;

      const { error: rowErr } = await supabase.from("tenant_vetting_documents").insert({
        tenant_id: tenantId,
        doc_type: docType,
        file_name: file.name,
        file_path: path,
        file_size_bytes: file.size,
        content_type: file.type || null,
        expires_on: expiresOn || null,
        uploaded_by: (await supabase.auth.getUser()).data.user?.id ?? null,
      } as any);
      if (rowErr) throw rowErr;

      toast({ title: "Document uploaded", description: `${DOC_LABEL[docType] ?? docType} saved.` });
      setExpiresOn("");
      qc.invalidateQueries({ queryKey: ["tenant-vetting-documents", tenantId] });
    } catch (e: any) {
      toast({ title: "Upload failed", description: e.message, variant: "destructive" });
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function handleView(doc: VettingDoc) {
    setOpeningId(doc.id);
    try {
      const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(doc.file_path, 300);
      if (error || !data?.signedUrl) throw new Error(error?.message ?? "Could not open that document.");
      window.open(data.signedUrl, "_blank", "noopener");
    } catch (e: any) {
      toast({ title: "Could not open document", description: e.message, variant: "destructive" });
    } finally {
      setOpeningId(null);
    }
  }

  const remove = useMutation({
    mutationFn: async (doc: VettingDoc) => {
      const { error } = await supabase.from("tenant_vetting_documents").delete().eq("id", doc.id);
      if (error) throw error;
      await supabase.storage.from(BUCKET).remove([doc.file_path]);
    },
    onSuccess: () => {
      toast({ title: "Document removed" });
      qc.invalidateQueries({ queryKey: ["tenant-vetting-documents", tenantId] });
    },
    onError: (e: any) => toast({ title: "Could not remove", description: e.message, variant: "destructive" }),
  });

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-sky-500" />
          Vetting Documents
        </CardTitle>
        <CardDescription className="text-xs">
          W-9, license, insurance and signed agreements. Stored privately for this organization.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {!tenantId && (
          <p className="text-xs text-muted-foreground">Select an organization to manage vetting documents.</p>
        )}

        {tenantId && canManage && (
          <div className="space-y-3 rounded-md border border-border p-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label className="text-xs">Document type</Label>
                <Select value={docType} onValueChange={setDocType}>
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {VETTING_DOC_TYPES.map((d) => (
                      <SelectItem key={d.value} value={d.value} className="text-xs">
                        {d.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Expiration date (optional)</Label>
                <Input
                  type="date"
                  value={expiresOn}
                  onChange={(e) => setExpiresOn(e.target.value)}
                  className="h-8 text-xs"
                />
              </div>
            </div>

            <input
              ref={fileRef}
              type="file"
              accept={ACCEPTED}
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleFile(f);
              }}
            />

            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" className="h-8 text-xs" onClick={() => fileRef.current?.click()} disabled={busy}>
                {busy ? (
                  <><Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> Uploading…</>
                ) : (
                  <><Upload className="h-3.5 w-3.5 mr-1.5" /> Upload document</>
                )}
              </Button>
              <span className="text-[11px] text-muted-foreground">PDF, JPG, PNG or Word · up to 20 MB</span>
            </div>
          </div>
        )}

        <div className="rounded-md border border-border p-3">
          <div className="text-xs font-medium mb-2">Required checklist</div>
          <div className="grid gap-1.5 sm:grid-cols-2">
            {REQUIRED_TYPES.map((t) => {
              const match = docs.find((d) => d.doc_type === t);
              return (
                <div key={t} className="flex items-center justify-between gap-2 text-[11px]">
                  <span className="truncate flex items-center gap-1.5">
                    {match ? (
                      <CheckCircle2 className="h-3 w-3 text-emerald-500 shrink-0" />
                    ) : (
                      <CircleDashed className="h-3 w-3 text-muted-foreground shrink-0" />
                    )}
                    {DOC_LABEL[t]}
                  </span>
                  <Badge
                    variant="outline"
                    className={`text-[10px] shrink-0 ${match ? STATUS_CLASS[match.review_status] ?? STATUS_CLASS.pending : "text-muted-foreground"}`}
                  >
                    {match ? STATUS_LABEL[match.review_status] ?? match.review_status : "Missing"}
                  </Badge>
                </div>
              );
            })}
          </div>
        </div>

        <div className="space-y-2">
          {isLoading && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading documents…
            </div>
          )}
          {!isLoading && tenantId && docs.length === 0 && (
            <p className="text-xs text-muted-foreground">No vetting documents uploaded yet.</p>
          )}
          {docs.map((d) => (
            <div key={d.id} className="flex items-center gap-2 rounded-md border border-border p-2">
              <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="text-xs font-medium truncate">{DOC_LABEL[d.doc_type] ?? d.doc_type}</div>
                <div className="text-[11px] text-muted-foreground truncate">
                  {d.file_name} · {format(new Date(d.created_at), "PP")}
                  {d.expires_on ? ` · expires ${format(new Date(d.expires_on), "PP")}` : ""}
                </div>
              </div>
              <Badge variant="outline" className={`text-[10px] shrink-0 ${STATUS_CLASS[d.review_status] ?? STATUS_CLASS.pending}`}>
                {STATUS_LABEL[d.review_status] ?? d.review_status}
              </Badge>
              <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => handleView(d)} disabled={openingId === d.id}>
                {openingId === d.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Eye className="h-3.5 w-3.5" />}
              </Button>
              {canManage && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 w-7 p-0 text-destructive"
                  onClick={() => remove.mutate(d)}
                  disabled={remove.isPending}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

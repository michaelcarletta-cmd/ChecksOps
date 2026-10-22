import { useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Eye, FileCheck2, Loader2, RotateCcw, Upload } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import {
  ACCEPTED_EXTENSIONS,
  FILE_PURPOSE_OPTIONS,
  PURPOSE_LABEL,
  VETTING_PURPOSES,
  type VerificationPurpose,
} from "@/lib/payments/verificationFiles";
import {
  DocumentUploadError,
  describeDocumentStatus,
  safeErrorMessage,
  uploadOnboardingDocument,
  validateDocumentFile,
  xhrPut,
  type DocumentMoovTone,
  type OnboardingApi,
  type OnboardingDocument,
} from "@/lib/payments/moovOnboarding";

const TONE_CLASS: Record<DocumentMoovTone, string> = {
  ok: "border-emerald-500/40 text-emerald-500",
  pending: "border-amber-500/40 text-amber-500",
  error: "border-destructive/40 text-destructive",
  none: "text-muted-foreground",
};

/** A local upload that did not finish; the File is kept in memory only so it can be retried. */
interface FailedUpload {
  localId: string;
  file: File;
  purpose: VerificationPurpose;
  stage: DocumentUploadError["stage"];
  documentId: string | null;
  message: string;
}

interface Props {
  tenantId: string;
  documents: OnboardingDocument[];
  readOnly: boolean;
  api: Pick<OnboardingApi, "requestUploadUrl" | "finalizeDocument" | "viewDocument">;
  onChanged: () => void | Promise<unknown>;
}

/**
 * Onboarding documents: upload-url -> presigned PUT -> finalize (sends to
 * Moov). Each document shows its Moov status; anything not yet delivered can
 * be retried. Documents stay stored in ChecksOps and visible in Tenant
 * Management.
 */
export function DocumentsSection({ tenantId, documents, readOnly, api, onChanged }: Props) {
  const { toast } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [purpose, setPurpose] = useState<VerificationPurpose>("business_verification");
  const [progress, setProgress] = useState<number | null>(null);
  const [failed, setFailed] = useState<FailedUpload[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function runUpload(file: File, p: VerificationPurpose, retryOf?: string) {
    setProgress(0);
    try {
      await uploadOnboardingDocument({ api, put: xhrPut, tenantId, purpose: p, file, onProgress: setProgress });
      if (retryOf) setFailed((f) => f.filter((x) => x.localId !== retryOf));
      toast({ title: "Document uploaded", description: "Stored in ChecksOps and submitted for review." });
    } catch (e) {
      const err = e instanceof DocumentUploadError ? e : new DocumentUploadError("upload_url", safeErrorMessage(e));
      if (err.stage !== "validate") {
        const entry: FailedUpload = {
          localId: retryOf ?? `${Date.now()}-${file.name}`,
          file,
          purpose: p,
          stage: err.stage,
          documentId: err.documentId,
          message: err.message,
        };
        setFailed((f) => [...f.filter((x) => x.localId !== entry.localId), entry]);
      }
      toast({
        title: err.stage === "finalize" ? "Uploaded, not yet submitted" : "Upload failed",
        description: err.message,
        variant: "destructive",
      });
    } finally {
      setProgress(null);
      if (fileRef.current) fileRef.current.value = "";
      await onChanged();
    }
  }

  function handlePick(file: File) {
    const check = validateDocumentFile(file);
    if (check.ok === false) {
      toast({ title: "File not accepted", description: check.error, variant: "destructive" });
      if (fileRef.current) fileRef.current.value = "";
      return;
    }
    void runUpload(file, purpose);
  }

  async function retryFinalize(documentId: string, localId?: string) {
    setBusyId(localId ?? documentId);
    try {
      await api.finalizeDocument(tenantId, documentId);
      if (localId) setFailed((f) => f.filter((x) => x.localId !== localId));
      toast({ title: "Submitted for review" });
    } catch (e) {
      toast({ title: "Still couldn't submit", description: safeErrorMessage(e), variant: "destructive" });
    } finally {
      setBusyId(null);
      await onChanged();
    }
  }

  function retryLocal(f: FailedUpload) {
    if (f.stage === "finalize" && f.documentId) return retryFinalize(f.documentId, f.localId);
    return runUpload(f.file, f.purpose, f.localId);
  }

  async function handleView(documentId: string) {
    setBusyId(documentId);
    try {
      const url = await api.viewDocument(tenantId, documentId);
      const w = window.open(url, "_blank", "noopener,noreferrer");
      if (!w) toast({ title: "Pop-up blocked", description: "Allow pop-ups for this site to view documents." });
    } catch (e) {
      toast({ title: "Could not open document", description: safeErrorMessage(e), variant: "destructive" });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-4">
      {!readOnly && (
        <div className="space-y-3 rounded-md border border-border p-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="doc-purpose" className="text-xs">Document type</Label>
              <Select value={purpose} onValueChange={(v) => setPurpose(v as VerificationPurpose)}>
                <SelectTrigger id="doc-purpose" className="h-8 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {FILE_PURPOSE_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value} className="text-xs">{o.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <input
            ref={fileRef}
            type="file"
            accept={ACCEPTED_EXTENSIONS}
            className="hidden"
            aria-label="Choose document file"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handlePick(f);
            }}
          />

          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" size="sm" className="h-8 text-xs" onClick={() => fileRef.current?.click()} disabled={progress !== null}>
              {progress !== null
                ? <><Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> Uploading…</>
                : <><Upload className="h-3.5 w-3.5 mr-1.5" /> Upload document</>}
            </Button>
            <span className="text-[11px] text-muted-foreground">PDF, JPG, PNG, or CSV · up to 20 MB</span>
          </div>

          {progress !== null && (
            <Progress value={progress} className="h-1.5" aria-label="Upload progress" aria-valuenow={progress} />
          )}
        </div>
      )}

      {failed.length > 0 && (
        <div className="space-y-2" role="alert">
          {failed.map((f) => (
            <div key={f.localId} className="flex items-center justify-between gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-2.5">
              <div className="min-w-0 text-[11px]">
                <div className="font-medium truncate">{f.file.name}</div>
                <div className="text-muted-foreground">{f.message}</div>
              </div>
              {!readOnly && (
                <Button type="button" size="sm" variant="outline" className="h-7 text-[11px] px-2 shrink-0" onClick={() => retryLocal(f)} disabled={busyId === f.localId || progress !== null}>
                  {busyId === f.localId ? <Loader2 className="h-3 w-3 animate-spin" /> : <><RotateCcw className="h-3 w-3 mr-1" /> Retry</>}
                </Button>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="rounded-md border border-border p-3">
        <div className="text-xs font-medium mb-2">Vetting checklist</div>
        <div className="grid gap-1.5 sm:grid-cols-2">
          {VETTING_PURPOSES.map((t) => {
            const match = documents.find((d) => d.purpose === t);
            const st = match ? describeDocumentStatus(match) : null;
            return (
              <div key={t} className="flex items-center justify-between gap-2 text-[11px]">
                <span className="truncate">{PURPOSE_LABEL[t] ?? t}</span>
                <Badge variant="outline" className={`text-[10px] shrink-0 ${st ? TONE_CLASS[st.tone] : TONE_CLASS.none}`}>
                  {st ? (st.tone === "ok" ? "Approved" : st.tone === "error" ? "Needs attention" : "On file") : "Missing"}
                </Badge>
              </div>
            );
          })}
        </div>
      </div>

      <div className="space-y-2" aria-label="Uploaded documents">
        {documents.length === 0 ? (
          <p className="text-xs text-muted-foreground">No onboarding documents uploaded yet.</p>
        ) : (
          documents.map((d) => {
            const st = describeDocumentStatus(d);
            return (
              <div key={d.id} className="flex items-start justify-between gap-3 rounded-md bg-muted/40 p-2.5">
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 text-xs font-medium truncate">
                    <FileCheck2 className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    <span className="truncate">{d.file_name}</span>
                  </div>
                  <div className="text-[11px] text-muted-foreground mt-0.5">
                    {PURPOSE_LABEL[d.purpose] ?? d.purpose}
                    {d.size ? ` · ${(d.size / 1024).toFixed(0)} KB` : ""}
                    {d.uploaded_at ? ` · ${new Date(d.uploaded_at).toLocaleDateString()}` : ""}
                  </div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <Button type="button" size="sm" variant="outline" className="h-7 text-[11px] px-2" onClick={() => handleView(d.id)} disabled={busyId === d.id} aria-label={`View ${d.file_name}`}>
                    {busyId === d.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <><Eye className="h-3 w-3 mr-1" /> View</>}
                  </Button>
                  {st.retryable && !readOnly && (
                    <Button type="button" size="sm" variant="outline" className="h-7 text-[11px] px-2" onClick={() => retryFinalize(d.id)} disabled={busyId === d.id} aria-label={`Retry submitting ${d.file_name}`}>
                      <RotateCcw className="h-3 w-3 mr-1" /> Retry
                    </Button>
                  )}
                  <Badge variant="outline" className={`text-[10px] ${TONE_CLASS[st.tone]}`}>{st.label}</Badge>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

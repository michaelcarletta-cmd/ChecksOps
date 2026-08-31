import { useRef, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Eye, FileCheck2, Loader2, RefreshCw, ShieldCheck, Upload } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useVerificationFiles } from "@/hooks/useVerificationFiles";
import {
  ACCEPTED_EXTENSIONS,
  FILE_PURPOSE_OPTIONS,
  MAX_UPLOAD_BYTES,
  PURPOSE_LABEL,
  getVerificationFileUrl,
  uploadVerificationFile,
  type VerificationPurpose,
} from "@/lib/payments/verificationFiles";

const STATUS_CLASS: Record<string, string> = {
  pending: "border-amber-500/40 text-amber-500",
  approved: "border-emerald-500/40 text-emerald-500",
  rejected: "border-destructive/40 text-destructive",
};

const VETTING_TYPES = [
  "w9",
  "bank_statement",
  "license",
  "insurance",
  "saas_agreement",
  "terms_of_service",
  "privacy_policy",
];


const STATUS_LABEL: Record<string, string> = {
  pending: "In review",
  approved: "Approved",
  rejected: "Rejected",
};

/**
 * Tenant-facing verification document submission (KYB/KYC).
 * Read-only when `readOnly` is set — the admin view of a tenant's record.
 */
export function VerificationDocumentsPanel({
  tenantId: tenantIdOverride,
  readOnly = false,
}: {
  tenantId?: string;
  readOnly?: boolean;
}) {
  const { tenantId, data, files, representatives, isLoading, refetch } =
    useVerificationFiles(tenantIdOverride);
  const { toast } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);

  const [purpose, setPurpose] = useState<VerificationPurpose>("business_verification");
  const [representativeId, setRepresentativeId] = useState<string>("");
  const [progress, setProgress] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [openingId, setOpeningId] = useState<string | null>(null);

  async function handleView(fileId: string) {
    if (!tenantId) return;
    setOpeningId(fileId);
    try {
      const url = await getVerificationFileUrl(tenantId, fileId);
      window.open(url, "_blank", "noopener");
    } catch (e: any) {
      toast({ title: "Could not open document", description: e.message, variant: "destructive" });
    } finally {
      setOpeningId(null);
    }
  }

  const needsRepresentative = purpose === "representative_verification";

  async function handleFile(file: File) {
    if (!tenantId) return;
    if (file.size > MAX_UPLOAD_BYTES) {
      toast({ title: "File too large", description: "Documents must be 20 MB or smaller.", variant: "destructive" });
      return;
    }
    if (needsRepresentative && !representativeId) {
      toast({
        title: "Select a representative",
        description: "Representative documents must be linked to a business representative.",
        variant: "destructive",
      });
      return;
    }
    setProgress(0);
    try {
      await uploadVerificationFile({
        tenantId,
        file,
        purpose,
        representativeId: needsRepresentative ? representativeId : null,
        onProgress: setProgress,
      });
      toast({ title: "Document submitted", description: "It's now with the verification team for review." });
      await refetch();
    } catch (e: any) {
      toast({ title: "Upload failed", description: e.message, variant: "destructive" });
    } finally {
      setProgress(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function handleRefresh() {
    setRefreshing(true);
    try {
      await refetch();
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <div>
            <CardTitle className="text-sm flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-primary" />
              Verification Documents
            </CardTitle>
            <CardDescription className="text-xs mt-1">
              Submit identity and business documents to verify your account. Documents are
              streamed directly to the payment provider — we do not store sensitive identity data
              locally.
            </CardDescription>
          </div>
          <Button size="sm" variant="outline" className="h-8 text-xs shrink-0" onClick={handleRefresh} disabled={refreshing}>
            {refreshing
              ? <><Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> Refreshing…</>
              : <><RefreshCw className="h-3.5 w-3.5 mr-1.5" /> Refresh status</>}
          </Button>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {data && !data.account_connected && (
          <p className="text-xs text-muted-foreground">
            Set up your payment account first, then submit verification documents here.
          </p>
        )}

        {!readOnly && data?.account_connected && (
          <div className="space-y-3 rounded-md border border-border p-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label className="text-xs">Document type</Label>
                <Select value={purpose} onValueChange={(v) => setPurpose(v as VerificationPurpose)}>
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {FILE_PURPOSE_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={o.value} className="text-xs">
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {needsRepresentative && (
                <div className="space-y-1.5">
                  <Label className="text-xs">Business representative</Label>
                  <Select value={representativeId} onValueChange={setRepresentativeId}>
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue placeholder={representatives.length ? "Select representative" : "No representatives yet"} />
                    </SelectTrigger>
                    <SelectContent>
                      {representatives.map((r) => (
                        <SelectItem key={r.id} value={r.id} className="text-xs">{r.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>

            <input
              ref={fileRef}
              type="file"
              accept={ACCEPTED_EXTENSIONS}
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleFile(f);
              }}
            />

            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                className="h-8 text-xs"
                onClick={() => fileRef.current?.click()}
                disabled={progress !== null}
              >
                {progress !== null
                  ? <><Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> Uploading…</>
                  : <><Upload className="h-3.5 w-3.5 mr-1.5" /> Upload document</>}
              </Button>
              <span className="text-[11px] text-muted-foreground">PDF, JPG, PNG, or CSV · up to 20 MB</span>
            </div>

            {progress !== null && <Progress value={progress} className="h-1.5" />}
          </div>
        )}

        <div className="rounded-md border border-border p-3">
          <div className="text-xs font-medium mb-2">Vetting checklist</div>
          <div className="grid gap-1.5 sm:grid-cols-2">
            {VETTING_TYPES.map((t) => {
              const match = files.find((f) => f.file_purpose === t);
              return (
                <div key={t} className="flex items-center justify-between gap-2 text-[11px]">
                  <span className="truncate">{PURPOSE_LABEL[t] ?? t}</span>
                  <Badge
                    variant="outline"
                    className={`text-[10px] shrink-0 ${
                      match ? STATUS_CLASS[match.review_status] ?? STATUS_CLASS.pending : "text-muted-foreground"
                    }`}
                  >
                    {match ? STATUS_LABEL[match.review_status] ?? "In review" : "Missing"}
                  </Badge>
                </div>
              );
            })}
          </div>
        </div>

        <div className="space-y-2">
          {isLoading ? (
            <div className="py-6 flex justify-center">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            </div>
          ) : files.length === 0 ? (
            <p className="text-xs text-muted-foreground">No verification documents submitted yet.</p>
          ) : (
            files.map((f) => (
              <div key={f.id} className="flex items-start justify-between gap-3 rounded-md bg-muted/40 p-2.5">
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 text-xs font-medium truncate">
                    <FileCheck2 className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    <span className="truncate">{f.file_name}</span>
                  </div>
                  <div className="text-[11px] text-muted-foreground mt-0.5">
                    {PURPOSE_LABEL[f.file_purpose] ?? f.file_purpose}
                    {f.provider_representative_id ? " · representative" : ""}
                    {f.file_size_bytes ? ` · ${(f.file_size_bytes / 1024).toFixed(0)} KB` : ""}
                    {` · ${new Date(f.created_at).toLocaleDateString()}`}
                  </div>
                  {f.review_reason && (
                    <div className="text-[11px] text-destructive mt-0.5">{f.review_reason}</div>
                  )}
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  {f.storage_path ? (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-[11px] px-2"
                      onClick={() => handleView(f.id)}
                      disabled={openingId === f.id}
                    >
                      {openingId === f.id
                        ? <Loader2 className="h-3 w-3 animate-spin" />
                        : <><Eye className="h-3 w-3 mr-1" /> View</>}
                    </Button>
                  ) : (
                    <span className="text-[10px] text-muted-foreground whitespace-nowrap">
                      Copy not retained
                    </span>
                  )}

                  <Badge
                    variant="outline"
                    className={`text-[10px] ${STATUS_CLASS[f.review_status] ?? STATUS_CLASS.pending}`}
                  >
                    {STATUS_LABEL[f.review_status] ?? "In review"}
                  </Badge>
                </div>
              </div>
            ))
          )}
        </div>
      </CardContent>
    </Card>
  );
}

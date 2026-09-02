import { FileCheck2, FileLock2, FolderKey } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export type ComplianceDocumentType = "KYB/KYC" | "Agreement" | "Banking & Payment" | "Authorization" | "Security Review" | "Other";
export type ComplianceDocumentStatus = "Current" | "Review Due" | "Expired" | "Pending";

export interface TenantComplianceDocument {
  id: string;
  name: string;
  type: ComplianceDocumentType;
  status: ComplianceDocumentStatus;
  version?: string;
  uploadedAt?: string;
  uploadedBy?: string;
  effectiveAt?: string;
  expiresAt?: string;
  storageReference?: string;
  notes?: string;
}

interface TenantComplianceDocumentsProps { documents?: TenantComplianceDocument[]; }

const statusClass: Record<ComplianceDocumentStatus, string> = {
  Current: "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  "Review Due": "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  Expired: "border-destructive/30 bg-destructive/10 text-destructive",
  Pending: "border-border bg-muted text-muted-foreground",
};
const formatDate = (value?: string) => { if (!value) return "—"; const date = new Date(value); return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString(); };

export function TenantComplianceDocuments({ documents = [] }: TenantComplianceDocumentsProps) {
  const current = documents.filter(document => document.status === "Current").length;
  const attention = documents.filter(document => document.status === "Review Due" || document.status === "Expired").length;

  return <Card>
    <CardHeader><CardTitle className="flex items-center gap-2 text-base"><FolderKey className="h-4 w-4" /> Compliance Documents</CardTitle></CardHeader>
    <CardContent className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-lg border border-border p-3"><p className="text-xs text-muted-foreground">Documents</p><p className="mt-1 text-xl font-semibold">{documents.length}</p></div>
        <div className="rounded-lg border border-border p-3"><p className="text-xs text-muted-foreground">Current</p><p className="mt-1 text-xl font-semibold">{current}</p></div>
        <div className="rounded-lg border border-border p-3"><p className="text-xs text-muted-foreground">Needs Attention</p><p className="mt-1 text-xl font-semibold">{attention}</p></div>
      </div>

      <div className="rounded-lg border border-border bg-muted/20 p-3"><div className="flex items-start gap-2"><FileLock2 className="mt-0.5 h-4 w-4 shrink-0" /><div><p className="text-sm font-medium">Protected compliance evidence</p><p className="mt-1 text-xs text-muted-foreground">KYB/KYC, agreements, banking/payment records, authorization documents, and security reviews may contain sensitive information. The frontend should receive only authorized metadata and secure download/view references from AWS; storage credentials and raw protected data must not be exposed.</p></div></div></div>

      {documents.length === 0 ? <div className="rounded-lg border border-dashed border-border p-6 text-center"><FileCheck2 className="mx-auto h-5 w-5 text-muted-foreground" /><p className="mt-2 text-sm font-medium">No AWS compliance documents connected yet.</p><p className="mt-1 text-xs text-muted-foreground">Ready for secure document metadata and access without moving current files or changing existing storage.</p></div> : <div className="overflow-x-auto"><table className="w-full min-w-[1050px] text-sm"><thead className="border-b text-left text-xs text-muted-foreground"><tr><th className="px-3 py-2">Document</th><th className="px-3 py-2">Type</th><th className="px-3 py-2">Status</th><th className="px-3 py-2">Version</th><th className="px-3 py-2">Uploaded</th><th className="px-3 py-2">Effective</th><th className="px-3 py-2">Expires</th><th className="px-3 py-2">Storage Ref</th><th className="px-3 py-2">Notes</th></tr></thead><tbody className="divide-y divide-border">{documents.map(document => <tr key={document.id}><td className="px-3 py-3"><p className="font-medium">{document.name}</p><p className="text-xs text-muted-foreground">{document.uploadedBy || "—"}</p></td><td className="px-3 py-3">{document.type}</td><td className="px-3 py-3"><Badge variant="outline" className={statusClass[document.status]}>{document.status}</Badge></td><td className="px-3 py-3">{document.version || "—"}</td><td className="px-3 py-3 text-xs">{formatDate(document.uploadedAt)}</td><td className="px-3 py-3 text-xs">{formatDate(document.effectiveAt)}</td><td className="px-3 py-3 text-xs">{formatDate(document.expiresAt)}</td><td className="max-w-[180px] truncate px-3 py-3 font-mono text-xs text-muted-foreground">{document.storageReference || "—"}</td><td className="max-w-[220px] px-3 py-3 text-xs text-muted-foreground">{document.notes || "—"}</td></tr>)}</tbody></table></div>}

      <p className="text-xs text-muted-foreground">AWS-ready display only. Upload authorization, malware scanning, encryption, retention, access logging, secure retrieval, and deletion remain backend responsibilities.</p>
    </CardContent>
  </Card>;
}

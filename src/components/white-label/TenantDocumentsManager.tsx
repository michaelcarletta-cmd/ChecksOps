import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { toast } from "@/hooks/use-toast";
import { FileText, Upload, Loader2, Trash2, Download, CheckCircle2, AlertCircle } from "lucide-react";

type DocType = "w9" | "license" | "insurance";

const DOC_DEFS: { type: DocType; label: string; description: string }[] = [
  { type: "w9", label: "W-9", description: "IRS Form W-9 (Request for Taxpayer Identification Number)" },
  { type: "license", label: "License", description: "Business or professional license" },
  { type: "insurance", label: "Insurance", description: "Certificate of Insurance (COI)" },
];

interface TenantDocumentRow {
  id: string;
  tenant_id: string;
  doc_type: DocType;
  file_path: string;
  file_name: string;
  mime_type: string | null;
  file_size: number | null;
  expires_at: string | null;
  notes: string | null;
  created_at: string;
}

export function TenantDocumentsManager({ tenantId }: { tenantId: string }) {
  const [docs, setDocs] = useState<TenantDocumentRow[]>([]);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from("tenant_documents" as any)
      .select("*")
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: false });
    if (error) {
      toast({ title: "Failed to load documents", description: error.message, variant: "destructive" });
    } else {
      setDocs((data as any) || []);
    }
    setLoading(false);
  };

  useEffect(() => {
    load();
  }, [tenantId]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Vetting Documents</CardTitle>
        <CardDescription>
          Upload the W-9, License, and Insurance documents for this tenant. Replacing a document keeps prior versions on file.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <div className="py-6 flex justify-center">
            <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          DOC_DEFS.map((def) => (
            <DocSlot
              key={def.type}
              tenantId={tenantId}
              def={def}
              docs={docs.filter((d) => d.doc_type === def.type)}
              onChange={load}
            />
          ))
        )}
      </CardContent>
    </Card>
  );
}

function DocSlot({
  tenantId,
  def,
  docs,
  onChange,
}: {
  tenantId: string;
  def: { type: DocType; label: string; description: string };
  docs: TenantDocumentRow[];
  onChange: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [expiresAt, setExpiresAt] = useState("");
  const current = docs[0];
  const history = docs.slice(1);

  const handleUpload = async (file: File) => {
    if (file.size > 15 * 1024 * 1024) {
      toast({ title: "File too large", description: "Maximum 15MB.", variant: "destructive" });
      return;
    }
    setUploading(true);
    try {
      const ext = file.name.split(".").pop() || "bin";
      const path = `${tenantId}/${def.type}/${Date.now()}.${ext}`;
      const { error: upErr } = await supabase.storage
        .from("tenant-documents")
        .upload(path, file, { upsert: false, contentType: file.type });
      if (upErr) throw upErr;

      const { data: userData } = await supabase.auth.getUser();
      const { error: insErr } = await supabase.from("tenant_documents" as any).insert({
        tenant_id: tenantId,
        doc_type: def.type,
        file_path: path,
        file_name: file.name,
        mime_type: file.type,
        file_size: file.size,
        uploaded_by: userData.user?.id,
        expires_at: expiresAt || null,
      });
      if (insErr) throw insErr;
      toast({ title: "Uploaded", description: `${def.label} saved.` });
      setExpiresAt("");
      onChange();
    } catch (e: any) {
      toast({ title: "Upload failed", description: e.message, variant: "destructive" });
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const handleDownload = async (doc: TenantDocumentRow) => {
    const { data, error } = await supabase.storage
      .from("tenant-documents")
      .createSignedUrl(doc.file_path, 60 * 5);
    if (error || !data) {
      toast({ title: "Could not open file", description: error?.message, variant: "destructive" });
      return;
    }
    window.open(data.signedUrl, "_blank");
  };

  const handleDelete = async (doc: TenantDocumentRow) => {
    if (!confirm(`Delete ${doc.file_name}?`)) return;
    const { error: storageErr } = await supabase.storage.from("tenant-documents").remove([doc.file_path]);
    if (storageErr) {
      toast({ title: "Storage delete failed", description: storageErr.message, variant: "destructive" });
      return;
    }
    const { error } = await supabase.from("tenant_documents" as any).delete().eq("id", doc.id);
    if (error) {
      toast({ title: "Delete failed", description: error.message, variant: "destructive" });
      return;
    }
    toast({ title: "Deleted" });
    onChange();
  };

  const expired = current?.expires_at ? new Date(current.expires_at) < new Date() : false;

  return (
    <div className="rounded border border-border p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <FileText className="w-5 h-5 text-muted-foreground mt-0.5" />
          <div>
            <div className="flex items-center gap-2">
              <h4 className="text-sm font-medium">{def.label}</h4>
              {current ? (
                expired ? (
                  <Badge variant="destructive" className="text-xs">
                    <AlertCircle className="w-3 h-3 mr-1" /> Expired
                  </Badge>
                ) : (
                  <Badge variant="default" className="text-xs">
                    <CheckCircle2 className="w-3 h-3 mr-1" /> On file
                  </Badge>
                )
              ) : (
                <Badge variant="outline" className="text-xs">Missing</Badge>
              )}
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">{def.description}</p>
          </div>
        </div>
      </div>

      {current && (
        <div className="flex items-center justify-between rounded bg-muted/40 p-2 text-sm">
          <div className="min-w-0">
            <div className="truncate font-medium">{current.file_name}</div>
            <div className="text-xs text-muted-foreground">
              Uploaded {new Date(current.created_at).toLocaleDateString()}
              {current.expires_at && ` · Expires ${new Date(current.expires_at).toLocaleDateString()}`}
              {current.file_size && ` · ${(current.file_size / 1024).toFixed(0)} KB`}
            </div>
          </div>
          <div className="flex gap-1">
            <Button variant="outline" size="sm" onClick={() => handleDownload(current)}>
              <Download className="w-3 h-3 mr-1" /> Open
            </Button>
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => handleDelete(current)}>
              <Trash2 className="w-3 h-3" />
            </Button>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1">
          <Label className="text-xs">Expiration (optional)</Label>
          <Input
            type="date"
            value={expiresAt}
            onChange={(e) => setExpiresAt(e.target.value)}
            className="h-8 w-[160px]"
          />
        </div>
        <input
          ref={fileRef}
          type="file"
          accept=".pdf,image/*,.doc,.docx"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) handleUpload(f);
          }}
        />
        <Button
          variant="outline"
          size="sm"
          onClick={() => fileRef.current?.click()}
          disabled={uploading}
        >
          {uploading ? (
            <Loader2 className="w-3 h-3 mr-1 animate-spin" />
          ) : (
            <Upload className="w-3 h-3 mr-1" />
          )}
          {current ? "Replace" : "Upload"}
        </Button>
      </div>

      {history.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground">
            History ({history.length})
          </summary>
          <ul className="mt-2 space-y-1">
            {history.map((h) => (
              <li key={h.id} className="flex items-center justify-between rounded bg-muted/20 px-2 py-1">
                <span className="truncate">
                  {h.file_name} · {new Date(h.created_at).toLocaleDateString()}
                </span>
                <div className="flex gap-1">
                  <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => handleDownload(h)}>
                    <Download className="w-3 h-3" />
                  </Button>
                  <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => handleDelete(h)}>
                    <Trash2 className="w-3 h-3" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

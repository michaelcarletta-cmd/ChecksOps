import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "@/hooks/use-toast";
import {
  FileText, Upload, Loader2, Trash2, Download, Palette, Home as HomeIcon,
  FileSignature, Image as ImageIcon, Headset, Eye, Landmark,
} from "lucide-react";

// Categories stored as doc_type = `library:<category>:<slug>`
type LibraryCategory = "mortgage" | "template" | "shingle" | "siding" | "letterhead" | "catalog";

// Mortgage companies almost always ask for the same packet up front.
const MORTGAGE_DOC_KINDS = [
  "W-9",
  "Contractor license",
  "General liability insurance",
  "Workers comp insurance",
  "Certificate of insurance",
  "Signed contract",
  "Adjuster / TPA letter",
  "Other",
];

const CATEGORIES: {
  key: LibraryCategory;
  label: string;
  description: string;
  accept: string;
  icon: any;
}[] = [
  {
    key: "mortgage",
    label: "Mortgage docs",
    description:
      "W-9, contractor license, insurance certificates and anything else mortgage companies request. These auto-attach to every check you send to the Mortgage Desk, so ops never has to ask you for them.",
    accept: ".pdf,.doc,.docx,image/*",
    icon: Landmark,
  },

  {
    key: "template",
    label: "Templates",
    description:
      "Reusable PDF/DOCX templates (TPA, contracts, waivers) mortgage ops and files can send.",
    accept: ".pdf,.doc,.docx",
    icon: FileSignature,
  },
  {
    key: "shingle",
    label: "Shingle catalog",
    description: "Shingle color/style samples the homeowner picks from.",
    accept: "image/*,.pdf",
    icon: HomeIcon,
  },
  {
    key: "siding",
    label: "Siding catalog",
    description: "Siding color/style samples the homeowner picks from.",
    accept: "image/*,.pdf",
    icon: Palette,
  },
  {
    key: "catalog",
    label: "Catalogs",
    description: "Roofing, siding, and other material catalogs shared with homeowners.",
    accept: ".pdf,image/*",
    icon: Palette,
  },
  {
    key: "letterhead",
    label: "Letterhead",
    description: "Logo, footer, signature blocks used on generated docs & emails.",
    accept: "image/*,.pdf,.doc,.docx",
    icon: ImageIcon,
  },
];

interface LibraryRow {
  id: string;
  tenant_id: string;
  doc_type: string;
  file_path: string;
  file_name: string;
  mime_type: string | null;
  file_size: number | null;
  notes: string | null;
  auto_share_mortgage_ops: boolean | null;
  shared_with_homeowners: boolean | null;
  created_at: string;
}

const BUCKET = "tenant-documents";
const PREFIX = "library:";

export function TenantDocumentLibrary({ tenantId }: { tenantId: string }) {
  const [rows, setRows] = useState<LibraryRow[]>([]);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from("tenant_documents" as any)
      .select("*")
      .eq("tenant_id", tenantId)
      .like("doc_type", `${PREFIX}%`)
      .order("created_at", { ascending: false });
    if (error) {
      toast({ title: "Failed to load library", description: error.message, variant: "destructive" });
    } else {
      setRows(((data as any) || []) as LibraryRow[]);
    }
    setLoading(false);
  };

  useEffect(() => { load(); }, [tenantId]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FileText className="h-4 w-4" /> Document Library
        </CardTitle>
        <CardDescription>
          Mortgage packet docs (W-9, license, insurance), templates, color catalogs, and letterhead
          your team reuses across claims. Mortgage docs auto-attach to every check you send to the
          ChecksOps Mortgage Desk, so they never have to ask you for them.
        </CardDescription>

      </CardHeader>
      <CardContent>
        <Tabs defaultValue="mortgage">
          <TabsList className="flex w-full flex-wrap h-auto gap-1">
            {CATEGORIES.map((c) => (
              <TabsTrigger key={c.key} value={c.key} className="text-xs">
                <c.icon className="h-3.5 w-3.5 mr-1" /> {c.label}
              </TabsTrigger>
            ))}
          </TabsList>
          {CATEGORIES.map((c) => {
            const catRows = rows.filter((r) => r.doc_type.startsWith(`${PREFIX}${c.key}:`));
            return (
              <TabsContent key={c.key} value={c.key} className="space-y-3 pt-4">
                <p className="text-xs text-muted-foreground">{c.description}</p>
                <UploadBar
                  tenantId={tenantId}
                  category={c.key}
                  accept={c.accept}
                  kinds={c.key === "mortgage" ? MORTGAGE_DOC_KINDS : undefined}
                  defaultAutoShare={c.key === "mortgage"}
                  onDone={load}
                />

                {loading ? (
                  <div className="py-6 flex justify-center">
                    <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
                  </div>
                ) : catRows.length === 0 ? (
                  <div className="text-center text-xs text-muted-foreground border rounded-md py-6">
                    Nothing here yet.
                  </div>
                ) : (
                  <ul className="space-y-2">
                    {catRows.map((row) => (
                      <LibraryItem key={row.id} row={row} onChange={load} />
                    ))}
                  </ul>
                )}
              </TabsContent>
            );
          })}
        </Tabs>
      </CardContent>
    </Card>
  );
}

function UploadBar({
  tenantId, category, accept, kinds, defaultAutoShare, onDone,
}: {
  tenantId: string;
  category: LibraryCategory;
  accept: string;
  kinds?: string[];
  defaultAutoShare?: boolean;
  onDone: () => void;
}) {
  const { user } = useAuth();
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [kind, setKind] = useState(kinds?.[0] ?? "");
  const [autoShare, setAutoShare] = useState(!!defaultAutoShare);

  const handleUpload = async (file: File) => {
    if (file.size > 25 * 1024 * 1024) {
      toast({ title: "File too large", description: "Maximum 25MB.", variant: "destructive" });
      return;
    }
    setUploading(true);
    try {
      const ext = file.name.split(".").pop() || "bin";
      const path = `${tenantId}/library/${category}/${Date.now()}-${crypto.randomUUID()}.${ext}`;
      const { error: upErr } = await supabase.storage
        .from(BUCKET)
        .upload(path, file, { upsert: false, contentType: file.type });
      if (upErr) throw upErr;

      const label = displayName || (kinds && kind && kind !== "Other" ? kind : "") || file.name;
      const slug = label
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 60) || crypto.randomUUID().slice(0, 8);

      const { error: insErr } = await supabase.from("tenant_documents" as any).insert({
        tenant_id: tenantId,
        doc_type: `${PREFIX}${category}:${slug}`,
        file_path: path,
        file_name: label,
        mime_type: file.type,
        file_size: file.size,
        auto_share_mortgage_ops: autoShare,
        uploaded_by: user?.id ?? null,
      });
      if (insErr) throw insErr;
      toast({
        title: "Added to library",
        description: autoShare ? "Will auto-attach to Mortgage Desk requests." : undefined,
      });
      setDisplayName("");
      onDone();
    } catch (e: any) {
      toast({ title: "Upload failed", description: e.message, variant: "destructive" });
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <div className="flex flex-wrap items-end gap-2 rounded border border-border p-3">
      {kinds && (
        <div className="space-y-1 min-w-[180px]">
          <Label className="text-xs">Document type</Label>
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value)}
            className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
          >
            {kinds.map((k) => (
              <option key={k} value={k}>{k}</option>
            ))}
          </select>
        </div>
      )}
      <div className="space-y-1 flex-1 min-w-[180px]">
        <Label className="text-xs">Display name (optional)</Label>
        <Input
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder={kinds ? "e.g. W-9 (2026)" : "e.g. Third Party Authorization"}
          className="h-8"
        />
      </div>
      <label className="flex items-center gap-2 text-[11px] text-muted-foreground cursor-pointer select-none pb-1.5">
        <Checkbox checked={autoShare} onCheckedChange={(v) => setAutoShare(v === true)} />
        <span className="flex items-center gap-1"><Headset className="h-3 w-3" /> Auto-share with Mortgage Ops</span>
      </label>

      <input
        ref={fileRef}
        type="file"
        accept={accept}
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) handleUpload(f);
        }}
      />
      <Button
        size="sm"
        onClick={() => fileRef.current?.click()}
        disabled={uploading}
      >
        {uploading
          ? <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />
          : <Upload className="w-3.5 h-3.5 mr-1" />}
        Upload
      </Button>
    </div>
  );
}

function LibraryItem({ row, onChange }: { row: LibraryRow; onChange: () => void }) {
  const [autoShare, setAutoShare] = useState(!!row.auto_share_mortgage_ops);
  const [sharedHomeowner, setSharedHomeowner] = useState(!!row.shared_with_homeowners);
  const [saving, setSaving] = useState(false);

  const open = async () => {
    const { data, error } = await supabase.storage
      .from(BUCKET)
      .createSignedUrl(row.file_path, 60 * 5);
    if (error || !data) {
      toast({ title: "Could not open", description: error?.message, variant: "destructive" });
      return;
    }
    window.open(data.signedUrl, "_blank");
  };

  const toggleAutoShare = async (next: boolean) => {
    setAutoShare(next);
    setSaving(true);
    const { error } = await supabase
      .from("tenant_documents" as any)
      .update({ auto_share_mortgage_ops: next } as any)
      .eq("id", row.id);
    if (error) {
      setSaving(false);
      setAutoShare(!next);
      toast({ title: "Could not update", description: error.message, variant: "destructive" });
      return;
    }

    // Backfill: attach to Mortgage Desk requests that are still open, so ops
    // gets the doc even if it was uploaded after the check was sent.
    if (next) {
      const { data: openReqs } = await supabase
        .from("mortgage_handling_requests")
        .select("id")
        .eq("tenant_id", row.tenant_id)
        .in("status", ["requested", "in_progress"]);
      if (openReqs?.length) {
        await supabase.from("mortgage_request_library_documents" as any).upsert(
          openReqs.map((r: any) => ({
            request_id: r.id,
            tenant_id: row.tenant_id,
            tenant_document_id: row.id,
            doc_type: row.doc_type,
            file_name: row.file_name,
            file_path: row.file_path,
            mime_type: row.mime_type,
            file_size: row.file_size,
          })),
          { onConflict: "request_id,file_path", ignoreDuplicates: true } as any
        );
      }
    }
    setSaving(false);

    toast({
      title: next ? "Will auto-share with Mortgage Ops" : "Auto-share turned off",
      description: next
        ? "This document is attached automatically when a check is sent to the Mortgage Desk."
        : undefined,
    });
    onChange();
  };

  const toggleSharedHomeowner = async (next: boolean) => {
    setSharedHomeowner(next);
    setSaving(true);
    const { error } = await supabase
      .from("tenant_documents" as any)
      .update({ shared_with_homeowners: next } as any)
      .eq("id", row.id);
    setSaving(false);
    if (error) {
      setSharedHomeowner(!next);
      toast({ title: "Could not update", description: error.message, variant: "destructive" });
      return;
    }
    toast({
      title: next ? "Shared with Clients" : "Unshared with Clients",
      description: next
        ? "This document will now appear in the Homeowner Ledger Resource Center."
        : undefined,
    });
    onChange();
  };

  const remove = async () => {
    if (!confirm(`Delete "${row.file_name}"?`)) return;
    await supabase.storage.from(BUCKET).remove([row.file_path]);
    const { error } = await supabase.from("tenant_documents" as any).delete().eq("id", row.id);
    if (error) {
      toast({ title: "Delete failed", description: error.message, variant: "destructive" });
      return;
    }
    toast({ title: "Removed" });
    onChange();
  };

  const slug = row.doc_type.split(":").slice(2).join(":");

  return (
    <li className="flex flex-wrap items-center gap-2 border rounded-md p-2">
      <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium truncate">{row.file_name}</p>
          {slug && <Badge variant="outline" className="text-[10px]">{slug}</Badge>}
        </div>
        <p className="text-[11px] text-muted-foreground">
          {new Date(row.created_at).toLocaleDateString()}
          {row.file_size ? ` · ${(row.file_size / 1024).toFixed(0)} KB` : ""}
        </p>
      </div>
      <label className="flex items-center gap-2 text-[11px] text-muted-foreground cursor-pointer select-none mr-1">
        <Checkbox
          checked={autoShare}
          disabled={saving}
          onCheckedChange={(v) => toggleAutoShare(v === true)}
          aria-label="Auto-share with Mortgage Ops"
        />
        <span className="flex items-center gap-1">
          <Headset className="h-3 w-3" />
          Auto-share with Mortgage Ops
        </span>
      </label>
      <label className="flex items-center gap-2 text-[11px] text-muted-foreground cursor-pointer select-none mr-1">
        <Checkbox
          checked={sharedHomeowner}
          disabled={saving}
          onCheckedChange={(v) => toggleSharedHomeowner(v === true)}
          aria-label="Share with Clients"
        />
        <span className="flex items-center gap-1">
          <Eye className="h-3 w-3" />
          Share with Clients
        </span>
      </label>
      <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={open} title="Open">
        <Download className="h-3.5 w-3.5" />
      </Button>
      <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-destructive" onClick={remove} title="Delete">
        <Trash2 className="h-3.5 w-3.5" />
      </Button>
    </li>
  );
}

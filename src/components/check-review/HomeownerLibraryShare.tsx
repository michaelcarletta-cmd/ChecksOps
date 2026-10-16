import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpen, Loader2, Send, X } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";

/**
 * Share Document Library files (templates, catalogs, shingle / siding samples,
 * letterhead) with this claim's homeowner. Sharing is per claim: the document
 * shows in this claim's HomeownerOps link only, and revoking removes it there.
 * Mortgage packet documents are never offered (they go to the Mortgage Desk).
 */

type LibraryDoc = {
  id: string;
  doc_type: string;
  category: string | null;
  file_name: string | null;
  mime_type: string | null;
  file_size: number | null;
};

type Share = { id: string; tenant_document_id: string; shared_at: string };

type ClaimLibrary = {
  tenant_id: string;
  documents: LibraryDoc[];
  shares: Share[];
  sharing_available: boolean;
};

const CATEGORY_LABELS: Record<string, string> = {
  template: "Template",
  shingle: "Shingle",
  siding: "Siding",
  catalog: "Catalog",
  letterhead: "Letterhead",
};

const invokeOk = async <T,>(name: string, body: Record<string, unknown>): Promise<T> => {
  const { data, error } = await supabase.functions.invoke(name, { body });
  const res = data as ({ ok?: boolean; error?: string; message?: string } & T) | null;
  if (error || !res || res.ok === false) {
    const context = (error as { context?: { text?: () => Promise<string> } } | null)?.context;
    const text = context?.text ? await context.text().catch(() => "") : "";
    throw new Error(res?.message || res?.error || text || (error as Error | null)?.message || "Request failed");
  }
  return res;
};

function claimLibraryQueryKey(claimId: string) {
  return ["claim-library-documents", claimId] as const;
}

export function HomeownerLibraryShare({ claimId }: { claimId: string }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [selected, setSelected] = useState("");

  const { data, isLoading, error } = useQuery({
    queryKey: claimLibraryQueryKey(claimId),
    queryFn: () => invokeOk<ClaimLibrary>("claim-library-documents", { claim_id: claimId }),
    retry: false,
  });

  const shareMutation = useMutation({
    mutationFn: async (documentId: string) => {
      if (!data) throw new Error("Library not loaded");
      return invokeOk("homeowner-share-library-document", {
        tenant_id: data.tenant_id,
        claim_id: claimId,
        tenant_document_id: documentId,
      });
    },
    onSuccess: () => {
      setSelected("");
      toast({ title: "Shared with homeowner", description: "It now shows on this claim's HomeownerOps link." });
      qc.invalidateQueries({ queryKey: claimLibraryQueryKey(claimId) });
    },
    onError: (err: Error) => toast({ title: "Could not share", description: err.message, variant: "destructive" }),
  });

  const revokeMutation = useMutation({
    mutationFn: async (documentId: string) => {
      if (!data) throw new Error("Library not loaded");
      return invokeOk("homeowner-share-library-document-revoke", {
        tenant_id: data.tenant_id,
        claim_id: claimId,
        tenant_document_id: documentId,
      });
    },
    onSuccess: () => {
      toast({ title: "No longer shared" });
      qc.invalidateQueries({ queryKey: claimLibraryQueryKey(claimId) });
    },
    onError: (err: Error) => toast({ title: "Could not revoke", description: err.message, variant: "destructive" }),
  });

  if (isLoading) {
    return (
      <div className="flex justify-center py-2">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (error || !data) return null;
  if (!data.sharing_available) {
    return (
      <p className="text-[11px] text-muted-foreground">
        Sharing library documents with homeowners is not available yet.
      </p>
    );
  }

  const sharedIds = new Set(data.shares.map((share) => share.tenant_document_id));
  const byId = new Map(data.documents.map((doc) => [doc.id, doc]));
  const available = data.documents.filter((doc) => !sharedIds.has(doc.id));

  return (
    <div className="space-y-2 border rounded-md p-2">
      <div className="flex items-center gap-2 text-xs font-medium">
        <BookOpen className="h-3.5 w-3.5" /> Share from Document Library
      </div>
      {data.shares.length > 0 && (
        <ul className="space-y-1">
          {data.shares.map((share) => {
            const doc = byId.get(share.tenant_document_id);
            return (
              <li key={share.id} className="flex items-center gap-2 text-xs">
                <span className="truncate flex-1">{doc?.file_name || "Library document"}</span>
                {doc?.category && (
                  <Badge variant="outline" className="text-[9px]">{CATEGORY_LABELS[doc.category] || doc.category}</Badge>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 w-6 p-0"
                  title="Stop sharing"
                  disabled={revokeMutation.isPending}
                  onClick={() => revokeMutation.mutate(share.tenant_document_id)}
                >
                  <X className="h-3 w-3" />
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      {available.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">
          {data.documents.length === 0
            ? "No templates or catalogs in the Document Library yet (Compliance & Docs)."
            : "Every library document is already shared with this homeowner."}
        </p>
      ) : (
        <div className="flex items-center gap-2">
          <select
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            className="h-8 flex-1 min-w-0 rounded-md border border-input bg-background px-2 text-xs"
            aria-label="Library document to share"
          >
            <option value="">Choose a library document</option>
            {available.map((doc) => (
              <option key={doc.id} value={doc.id}>
                {(doc.category && CATEGORY_LABELS[doc.category]) || "Document"}: {doc.file_name || doc.id}
              </option>
            ))}
          </select>
          <Button
            size="sm"
            variant="outline"
            className="h-8"
            disabled={!selected || shareMutation.isPending}
            onClick={() => shareMutation.mutate(selected)}
          >
            {shareMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5 mr-1" />}
            Share
          </Button>
        </div>
      )}
    </div>
  );
}

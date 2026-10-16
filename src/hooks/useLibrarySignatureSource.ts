import { useMutation, useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

/**
 * Data for the Signature Requests source "From Document Library". The server
 * (signature-library-document-copy) copies the library object into the claim's
 * signature folder and returns that claim-scoped path; the library path itself
 * is never a signature document. Mortgage packet documents are not offered.
 */

export type LibrarySignatureDoc = {
  id: string;
  doc_type: string;
  category: string | null;
  file_name: string | null;
  mime_type: string | null;
};

export type LibrarySignatureCopy = {
  path: string;
  file_name: string;
  mime_type: string;
  is_pdf: boolean;
  signedUrl: string;
};

const SIGNABLE = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);

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

/** Templates first, then the other non-mortgage categories; PDF / DOCX only. */
export function useLibrarySignatureDocs(claimId: string, enabled: boolean) {
  return useQuery({
    queryKey: ["signature-library-documents", claimId],
    enabled,
    retry: false,
    queryFn: async () => {
      const res = await invokeOk<{ documents: LibrarySignatureDoc[] }>("claim-library-documents", { claim_id: claimId });
      const order = (doc: LibrarySignatureDoc) => (doc.category === "template" ? 0 : 1);
      return (res.documents || [])
        .filter((doc) => SIGNABLE.has(String(doc.mime_type || "").toLowerCase()))
        .sort((a, b) => order(a) - order(b));
    },
  });
}

export function useLibrarySignatureCopy() {
  return useMutation({
    mutationFn: async (input: { documentId: string; claimId: string; checkIntakeItemId?: string | null }) => {
      const res = await invokeOk<LibrarySignatureCopy>("signature-library-document-copy", {
        tenant_document_id: input.documentId,
        claim_id: input.claimId,
        check_intake_item_id: input.checkIntakeItemId || undefined,
      });
      let docxBytes: Uint8Array | null = null;
      if (!res.is_pdf) {
        const file = await fetch(res.signedUrl);
        if (!file.ok) throw new Error("The copied document could not be loaded");
        docxBytes = new Uint8Array(await file.arrayBuffer());
      }
      return { ...res, docxBytes };
    },
  });
}

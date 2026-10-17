import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { LibrarySignatureDoc } from "@/hooks/useLibrarySignatureSource";

/**
 * Signature Requests source "From Document Library": a template (or catalog,
 * shingle / siding sample, letterhead) from Compliance & Docs. Data and the
 * copy call live in @/hooks/useLibrarySignatureSource.
 */

const CATEGORY_LABELS: Record<string, string> = {
  template: "Template",
  catalog: "Catalog",
  shingle: "Shingle",
  siding: "Siding",
  letterhead: "Letterhead",
};

export function LibrarySignatureSourcePicker({
  docs,
  loading,
  selectedId,
  onSelect,
}: {
  docs: LibrarySignatureDoc[] | undefined;
  loading: boolean;
  selectedId: string | undefined;
  onSelect: (doc: LibrarySignatureDoc | null) => void;
}) {
  return (
    <div>
      <Label>Document Library (PDF or DOCX)</Label>
      <Select value={selectedId} onValueChange={(id) => onSelect(docs?.find((doc) => doc.id === id) || null)}>
        <SelectTrigger>
          <SelectValue placeholder={loading ? "Loading library…" : "Select a library document"} />
        </SelectTrigger>
        <SelectContent>
          {!loading && (docs?.length ?? 0) === 0 && (
            <div className="px-3 py-2 text-sm text-muted-foreground">
              No PDF or DOCX templates in the Document Library (Compliance &amp; Docs)
            </div>
          )}
          {docs?.map((doc) => (
            <SelectItem key={doc.id} value={doc.id}>
              {(doc.category && CATEGORY_LABELS[doc.category]) || "Document"}: {doc.file_name || doc.id}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground mt-1">
        A copy is saved to this claim for the signature; the library file is not changed.
      </p>
    </div>
  );
}

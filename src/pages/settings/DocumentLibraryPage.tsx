import { useTenantFilter } from "@/hooks/useTenantFilter";
import { TenantDocumentLibrary } from "@/components/settings/TenantDocumentLibrary";
import { Loader2 } from "lucide-react";

export default function DocumentLibraryPage() {
  const { tenantId } = useTenantFilter();

  if (!tenantId) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-5xl mx-auto px-4 py-6 space-y-4">
        <div>
          <h1 className="text-2xl font-semibold">Document Library</h1>
          <p className="text-sm text-muted-foreground">
            Templates, color/material catalogs, and letterhead assets your team reuses across claims.
          </p>
        </div>
        <TenantDocumentLibrary tenantId={tenantId} />
      </div>
    </div>
  );
}

import { supabase } from "@/integrations/aws/client";
import { useQuery } from "@tanstack/react-query";

/**
 * Hook to fetch document presets from the database.
 * Falls back to hardcoded SIGNER_DISPLAY_TEMPLATES if DB is unavailable.
 */
export function useDocumentPresets() {
  return useQuery({
    queryKey: ["signature-document-presets"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("signature_document_presets")
        .select("document_type, label, description, fields")
        .order("label");
      if (error) throw error;
      return (data ?? []) as Array<{
        document_type: string;
        label: string;
        description: string | null;
        fields: Record<string, {
          display_label: string;
          display_help_text: string;
          display_section?: string;
          display_order?: number;
        }>;
      }>;
    },
    staleTime: 1000 * 60 * 10,
    gcTime: 1000 * 60 * 30,
    refetchOnWindowFocus: false,
  });
}

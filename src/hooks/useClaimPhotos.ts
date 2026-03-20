import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export async function getClaimPhotos(claimId: string) {
  const { data, error } = await supabase
    .from("claim_photos")
    .select("id, file_path, file_name, category, description, created_at")
    .eq("claim_id", claimId)
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) throw error;
  return data ?? [];
}

export function useClaimPhotos(claimId: string) {
  return useQuery({
    queryKey: ["claim-photos", claimId],
    queryFn: () => getClaimPhotos(claimId),
    staleTime: 1000 * 60 * 5,
    gcTime: 1000 * 60 * 30,
    refetchOnWindowFocus: false,
    retry: 1,
    enabled: !!claimId,
  });
}

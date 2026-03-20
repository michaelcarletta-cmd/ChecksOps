import { supabase } from "@/integrations/supabase/client";

export type ClaimPhotoRow = {
  id: string;
  file_path: string;
  file_name: string;
  description: string | null;
  created_at: string | null;
};

export async function getClaimPhotos(claimId: string): Promise<ClaimPhotoRow[]> {
  const { data, error } = await supabase
    .from("claim_photos")
    .select("id, file_path, file_name, description, created_at")
    .eq("claim_id", claimId)
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) throw error;
  return data ?? [];
}

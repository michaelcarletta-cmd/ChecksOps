import { supabase } from "@/integrations/supabase/client";

export type ClaimPhotoRow = {
  id: string;
  public_url: string;
  caption: string | null;
  created_at: string | null;
};

export async function getClaimPhotos(claimId: string): Promise<ClaimPhotoRow[]> {
  const { data, error } = await supabase
    .from("claim_photos")
    .select("id, public_url, caption, created_at")
    .eq("claim_id", claimId)
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) {
    throw error;
  }

  return (data ?? []) as ClaimPhotoRow[];
}

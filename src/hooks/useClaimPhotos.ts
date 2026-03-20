import { useQuery } from "@tanstack/react-query";
import { getClaimPhotos } from "@/lib/getClaimPhotos";

export function useClaimPhotos(claimId: string) {
  return useQuery({
    queryKey: ["claim-photos", claimId],
    queryFn: () => getClaimPhotos(claimId),
    staleTime: 1000 * 60 * 5,
    gcTime: 1000 * 60 * 30,
    refetchOnWindowFocus: false,
    retry: 1,
    enabled: Boolean(claimId),
  });
}

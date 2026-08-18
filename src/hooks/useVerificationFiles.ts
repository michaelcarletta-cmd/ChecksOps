import { useQuery } from "@tanstack/react-query";
import { useTenantFilter } from "@/hooks/useTenantFilter";
import { listVerificationFiles, type VerificationFilesResponse } from "@/lib/payments/verificationFiles";

/**
 * Verification-document metadata for one organization. `tenantIdOverride`
 * lets the platform admin surface read another tenant's onboarding record;
 * the edge function still enforces who may see what.
 */
export function useVerificationFiles(tenantIdOverride?: string) {
  const { tenantId: currentTenantId } = useTenantFilter();
  const tenantId = tenantIdOverride ?? currentTenantId;

  const query = useQuery<VerificationFilesResponse>({
    queryKey: ["verification-files", tenantId],
    enabled: !!tenantId,
    staleTime: 60 * 1000,
    queryFn: () => listVerificationFiles(tenantId!),
  });

  return {
    tenantId,
    data: query.data ?? null,
    files: query.data?.files ?? [],
    representatives: query.data?.representatives ?? [],
    requirements: query.data?.requirements ?? [],
    isLoading: query.isLoading,
    error: query.error as Error | null,
    refetch: query.refetch,
  };
}

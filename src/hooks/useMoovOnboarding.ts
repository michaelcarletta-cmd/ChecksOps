import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import {
  OnboardingApiError,
  createOnboardingApi,
  type InvokeFn,
  type OnboardingState,
} from "@/lib/payments/moovOnboarding";

/**
 * `supabase.functions.invoke` -> POST /functions/v1/<name> on AWS.
 * Error text is redacted inside OnboardingApiError; request bodies are never
 * logged or echoed.
 */
interface ErrorBody {
  ok?: boolean;
  error?: string;
  message?: string;
  error_code?: string;
  code?: string;
}

interface FunctionsErrorLike {
  message?: string;
  context?: { status?: number; body?: ErrorBody | null; json?: () => Promise<ErrorBody> };
}

export const invokeOnboardingFunction: InvokeFn = async (name, body) => {
  const { data, error } = await supabase.functions.invoke(name, { body });
  if (error) {
    const err = error as FunctionsErrorLike;
    let payload: ErrorBody | null = err.context?.body ?? null;
    if (!payload) {
      try {
        payload = (await err.context?.json?.()) ?? null;
      } catch {
        /* keep null */
      }
    }
    const status = err.context?.status;
    throw new OnboardingApiError(
      payload?.message ?? payload?.error ?? err.message ?? "Request failed",
      payload?.error_code ?? payload?.code ?? null,
      typeof status === "number" ? status : null,
    );
  }
  const d = data as ErrorBody | null;
  if (d?.error && d.ok !== true) {
    throw new OnboardingApiError(d.message ?? d.error, d.error_code ?? null);
  }
  return data;
};

export function useOnboardingApi() {
  return useMemo(() => createOnboardingApi(invokeOnboardingFunction), []);
}

export const moovOnboardingQueryKey = (tenantId?: string | null) => ["moov-onboarding", tenantId] as const;

/**
 * The tenant's onboarding record as ChecksOps holds it (masked). Replaces the
 * old direct `payment_provider_accounts` read, which had no environment
 * filter: the server picks the tenant's active Moov environment.
 */
export function useMoovOnboarding(tenantId?: string | null) {
  const api = useOnboardingApi();
  return useQuery<OnboardingState>({
    queryKey: moovOnboardingQueryKey(tenantId),
    enabled: !!tenantId,
    staleTime: 15 * 1000,
    retry: 1,
    queryFn: () => api.get(tenantId!),
    // Keep polling while Moov delivery is in flight so "sending" resolves honestly.
    refetchInterval: (query) => (query.state.data?.sync?.pending ? 5000 : false),
  });
}

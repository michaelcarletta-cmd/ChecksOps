import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/aws/client";

export interface ProviderAddress {
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  stateOrProvince?: string;
  postalCode?: string;
}

export interface ProviderRepresentative {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  jobTitle: string;
  birthDateProvided: boolean;
  governmentIDProvided: boolean;
  address: ProviderAddress;
  isController: boolean;
  isOwner: boolean;
  ownershipPercentage: string;
}

export interface ProviderBusinessProfile {
  legalBusinessName: string;
  doingBusinessAs: string;
  businessType: string;
  email: string;
  phone: string;
  website: string;
  description: string;
  taxIdProvided: boolean;
  address: ProviderAddress;
}

export interface ProviderProfile {
  verified: boolean;
  business: ProviderBusinessProfile | null;
  representatives: ProviderRepresentative[];
}

function digitsOnly(v: unknown) {
  return typeof v === "string" || typeof v === "number" ? String(v).replace(/\D/g, "") : "";
}

/**
 * The identity details the payment provider already holds for this
 * organization. Used to prefill compliance forms so a verified tenant is never
 * asked to type everything a second time.
 */
export function useProviderProfile(tenantId?: string | null) {
  return useQuery<ProviderProfile | null>({
    queryKey: ["provider-profile", tenantId],
    enabled: !!tenantId,
    staleTime: 60 * 1000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("payment_provider_accounts")
        .select("verification_status, provider_metadata")
        .eq("tenant_id", tenantId!)
        .eq("provider", "moov")
        .maybeSingle();
      if (error) throw error;
      if (!data) return null;

      const meta = (data as any).provider_metadata ?? {};
      const b = meta?.profile?.business ?? null;
      if (!b) {
        return { verified: (data as any).verification_status === "verified", business: null, representatives: [] };
      }

      const business: ProviderBusinessProfile = {
        legalBusinessName: b.legalBusinessName ?? "",
        doingBusinessAs: b.doingBusinessAs ?? "",
        businessType: b.businessType ?? "privateCorporation",
        email: b.email ?? "",
        phone: digitsOnly(b.phone?.number),
        website: b.website ?? "",
        description: b.description ?? "",
        taxIdProvided: !!b.taxIDProvided,
        address: {
          addressLine1: b.address?.addressLine1 ?? "",
          addressLine2: b.address?.addressLine2 ?? "",
          city: b.address?.city ?? "",
          stateOrProvince: b.address?.stateOrProvince ?? "",
          postalCode: b.address?.postalCode ?? "",
        },
      };

      const representatives: ProviderRepresentative[] = (b.representatives ?? []).map((r: any) => ({
        firstName: r?.name?.firstName ?? "",
        lastName: r?.name?.lastName ?? "",
        email: r?.email ?? "",
        phone: digitsOnly(r?.phone?.number),
        jobTitle: r?.responsibilities?.jobTitle ?? "",
        birthDateProvided: !!r?.birthDateProvided,
        governmentIDProvided: !!r?.governmentIDProvided,
        address: {
          addressLine1: r?.address?.addressLine1 ?? "",
          addressLine2: r?.address?.addressLine2 ?? "",
          city: r?.address?.city ?? "",
          stateOrProvince: r?.address?.stateOrProvince ?? "",
          postalCode: r?.address?.postalCode ?? "",
        },
        isController: !!r?.responsibilities?.isController,
        isOwner: !!r?.responsibilities?.isOwner,
        ownershipPercentage: r?.responsibilities?.ownershipPercentage
          ? String(r.responsibilities.ownershipPercentage)
          : "",
      }));

      return {
        verified: (data as any).verification_status === "verified",
        business,
        representatives,
      };
    },
  });
}

import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export type ProfessionalType = "contractor" | "public_adjuster" | "attorney";

export interface ReferralProfessional {
  id: string;
  professional_type: ProfessionalType;
  name: string;
  company: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  states_served: string[];
  specialties: string[];
  description: string | null;
  logo_url: string | null;
  is_premium: boolean;
  rating: number;
  reviews_count: number;
}

/**
 * Fetch professionals by type and state, with premium professionals sorted first.
 */
export function useReferralProfessionals(
  professionalType: ProfessionalType | null,
  state: string | null
) {
  return useQuery({
    queryKey: ["referral-professionals", professionalType, state],
    queryFn: async () => {
      if (!professionalType) return [];

      let query = supabase
        .from("referral_professionals")
        .select("id, professional_type, name, company, email, phone, website, states_served, specialties, description, logo_url, is_premium, rating, reviews_count")
        .eq("professional_type", professionalType)
        .eq("is_active", true)
        .order("is_premium", { ascending: false })
        .order("rating", { ascending: false });

      if (state) {
        query = query.contains("states_served", [state]);
      }

      const { data, error } = await query.limit(20);
      if (error) throw error;
      return (data || []) as ReferralProfessional[];
    },
    enabled: !!professionalType,
  });
}

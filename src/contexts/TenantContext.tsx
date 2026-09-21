import { createContext, useContext, useState, useEffect, ReactNode } from "react";
import { supabase } from "@/integrations/supabase/client";

export interface Tenant {
  id: string;
  name: string;
  slug: string;
  logo_url: string | null;
  primary_color: string;
  secondary_color: string;
  custom_domain: string | null;
  subscription_status: string;
  plan_tier: string;
  partner_code: string | null;
  is_system_tenant: boolean;
  max_checks_per_month: number;
  vendor_cap?: number;
  sales_rep_cap?: number;
  subcontractor_cap?: number;
  is_test_account?: boolean | null;
  moov_environment?: string | null;
}

interface TenantContextType {
  tenant: Tenant | null;
  loading: boolean;
  error: string | null;
  setTenantBySlug: (slug: string) => Promise<void>;
  refreshTenant: () => Promise<void>;
  isWhiteLabel: boolean;
}

const TenantContext = createContext<TenantContextType>({
  tenant: null,
  loading: false,
  error: null,
  setTenantBySlug: async () => {},
  refreshTenant: async () => {},
  isWhiteLabel: false,
});

export function useTenant() {
  return useContext(TenantContext);
}

export function TenantProvider({ children, slug }: { children: ReactNode; slug?: string }) {
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [loading, setLoading] = useState(!!slug);
  const [error, setError] = useState<string | null>(null);

  const setTenantBySlug = async (tenantSlug: string) => {
    setLoading(true);
    setError(null);
    try {
      const { data, error: fetchError } = await supabase
        .from("tenants_public" as any)
        .select("*")
        .eq("slug", tenantSlug)
        .maybeSingle();


      if (fetchError) throw fetchError;
      if (!data) {
        setError("Organization not found");
        setTenant(null);
      } else {
        let next = data as unknown as Tenant;
        const { data: flags } = await supabase
          .from("tenants")
          .select("is_test_account, moov_environment")
          .eq("id", next.id)
          .maybeSingle();
        if (flags) {
          next = {
            ...next,
            is_test_account: !!(flags as { is_test_account?: boolean | null }).is_test_account,
            moov_environment: (flags as { moov_environment?: string | null }).moov_environment ?? null,
          };
        }
        setTenant(next);
      }
    } catch (e: any) {
      setError(e.message || "Failed to load organization");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (slug) {
      setTenantBySlug(slug);
    }
  }, [slug]);

  const refreshTenant = async () => {
    if (!slug) return;
    await setTenantBySlug(slug);
  };

  return (
    <TenantContext.Provider
      value={{
        tenant,
        loading,
        error,
        setTenantBySlug,
        refreshTenant,
        isWhiteLabel: !!tenant && !tenant.is_system_tenant,
      }}
    >
      {children}
    </TenantContext.Provider>
  );
}

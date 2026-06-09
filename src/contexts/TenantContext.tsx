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
        .from("tenants")
        .select("*")
        .eq("slug", tenantSlug)
        .maybeSingle();

      if (fetchError) throw fetchError;
      if (!data) {
        setError("Organization not found");
        setTenant(null);
      } else {
        setTenant(data as unknown as Tenant);
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

  useEffect(() => {
    if (!slug) return;

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event) => {
      // TOKEN_REFRESHED fires on every JWT rotation (including routine background
      // refreshes) and does not change tenant data. Reacting to it sets
      // loading=true and re-renders the full provider tree, which resets all
      // child UI state (active tabs, selections, etc.) on every tab switch.
      // Only re-fetch on events that actually indicate a user change.
      if (event === 'SIGNED_IN' || event === 'SIGNED_OUT' || event === 'USER_UPDATED') {
        void setTenantBySlug(slug);
      }
    });

    return () => subscription.unsubscribe();
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

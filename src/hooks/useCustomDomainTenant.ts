import { useState, useEffect } from "react";
import { supabase } from "@/integrations/aws/client";
import { isCheckOpsHost } from "@/lib/checkopsHost";

/**
 * Checks if the current hostname matches a tenant's custom_domain.
 * Returns the tenant slug if matched, null otherwise.
 *
 * Known app domains (freedomclaims.work, freedomclaims.lovable.app, localhost, preview domains)
 * and the CheckOps platform hosts (checkops.com, etc.) are skipped — they are handled by
 * the normal router, not the tenant custom-domain shortcut.
 */

const KNOWN_APP_DOMAINS = [
  "localhost",
  "freedomclaims.work",
  "www.freedomclaims.work",
  "freedomclaims.lovable.app",
];

function isKnownAppDomain(hostname: string): boolean {
  if (KNOWN_APP_DOMAINS.includes(hostname)) return true;
  // Lovable preview domains
  if (hostname.endsWith(".lovable.app")) return true;
  // Local dev
  if (hostname === "127.0.0.1" || hostname === "0.0.0.0") return true;
  // CheckOps platform hosts are handled by CheckOpsHostRoutes, not tenant custom-domain
  if (isCheckOpsHost(hostname)) return true;
  return false;
}

export function useCustomDomainTenant() {
  const [tenantSlug, setTenantSlug] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    const hostname = window.location.hostname;

    if (isKnownAppDomain(hostname)) {
      setTenantSlug(null);
      setLoading(false);
      setChecked(true);
      return;
    }

    // Unknown domain — check if it's a tenant custom domain
    const resolve = async () => {
      try {
        const { data } = await supabase
          .from("tenants_public" as any)
          .select("slug")
          .eq("custom_domain", hostname)
          .eq("subscription_status", "active")
          .maybeSingle();

        setTenantSlug((data as any)?.slug ?? null);
      } catch {
        setTenantSlug(null);
      } finally {
        setLoading(false);
        setChecked(true);
      }
    };

    resolve();
  }, []);

  return { tenantSlug, loading, checked };
}

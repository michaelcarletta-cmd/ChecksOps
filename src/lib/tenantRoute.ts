/**
 * Tenant URL resolution for `/:slug/*`.
 *
 * Canonical identifier is `tenants.slug`. Partner codes (and aliases) are a
 * secondary public identifier used in sharing flows — resolve them through
 * `lookup_tenant_by_partner_code` instead of hardcoded slug maps.
 *
 * Reserved first segments must never be treated as organization slugs.
 */
export const RESERVED_TENANT_SLUGS = new Set([
  "h",
  "admin",
  "api",
  "assets",
  "static",
  "prep",
  "wl",
  "login",
  "signup",
  "auth",
  "account",
  "pricing",
  "security",
  "privacy-notice",
  "terms",
  "terms-of-service",
  "find-a-pro",
  "pros",
  "mortgage-ops",
  "invoice",
  "ledger",
  "start-claim",
  "sign",
  "endorse",
  "unsubscribe",
  "pay-setup",
  "verify-account",
  "payment-direction",
  "forgot-password",
  "reset-password",
]);

export const TENANT_ROUTE_COLUMNS =
  "id, name, slug, logo_url, primary_color, secondary_color, custom_domain, subscription_status, plan_tier, partner_code, is_system_tenant, max_checks_per_month, vendor_cap, sales_rep_cap, subcontractor_cap";

export type TenantRouteRecord = {
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
  max_checks_per_month?: number;
  vendor_cap?: number;
  sales_rep_cap?: number;
  subcontractor_cap?: number;
};

export type TenantRouteSource =
  | "reserved"
  | "tenants_public.slug"
  | "tenants.slug"
  | "partner_code"
  | "not_found";

export function isReservedTenantSlug(slug?: string | null): boolean {
  if (!slug) return false;
  return RESERVED_TENANT_SLUGS.has(String(slug).trim().toLowerCase());
}

const firstRpcRow = (data: unknown): { id?: string } | null => {
  if (!data) return null;
  if (Array.isArray(data)) return data[0] || null;
  if (typeof data === "object") return data as { id?: string };
  return null;
};

export async function resolveTenantByRouteSlug(
  supabase: {
    from: (table: string) => any;
    rpc: (name: string, args: Record<string, unknown>) => any;
  },
  rawSlug: string,
): Promise<{ tenant: TenantRouteRecord | null; source: TenantRouteSource }> {
  const slug = String(rawSlug || "").trim();
  if (!slug || isReservedTenantSlug(slug)) {
    return { tenant: null, source: "reserved" };
  }

  const { data: publicRow, error: publicError } = await supabase
    .from("tenants_public")
    .select("*")
    .eq("slug", slug)
    .maybeSingle();
  if (publicError) throw publicError;
  if (publicRow) {
    return { tenant: publicRow as TenantRouteRecord, source: "tenants_public.slug" };
  }

  const { data: tenantRow, error: tenantError } = await supabase
    .from("tenants")
    .select(TENANT_ROUTE_COLUMNS)
    .eq("slug", slug)
    .maybeSingle();
  if (tenantError) throw tenantError;
  if (tenantRow) {
    return { tenant: tenantRow as TenantRouteRecord, source: "tenants.slug" };
  }

  const { data: byCode, error: codeError } = await supabase.rpc("lookup_tenant_by_partner_code", {
    _code: slug,
  });
  if (codeError) throw codeError;
  const match = firstRpcRow(byCode);
  if (!match?.id) {
    return { tenant: null, source: "not_found" };
  }

  const { data: byId, error: byIdError } = await supabase
    .from("tenants")
    .select(TENANT_ROUTE_COLUMNS)
    .eq("id", match.id)
    .maybeSingle();
  if (byIdError) throw byIdError;
  if (byId) {
    return { tenant: byId as TenantRouteRecord, source: "partner_code" };
  }

  const { data: publicById, error: publicByIdError } = await supabase
    .from("tenants_public")
    .select("*")
    .eq("id", match.id)
    .maybeSingle();
  if (publicByIdError) throw publicByIdError;
  if (publicById) {
    return { tenant: publicById as TenantRouteRecord, source: "partner_code" };
  }

  return { tenant: null, source: "not_found" };
}

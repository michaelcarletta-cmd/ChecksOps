/**
 * Pure BYOK — resolve a tenant's OpenAI API key.
 *
 * Returns:
 *   { key: string, isSystemTenant: false }   → use tenant's key (bypass gateway)
 *   { key: null,   isSystemTenant: true  }   → Freedom internal; use platform OPENAI_API_KEY
 *   { key: null,   isSystemTenant: false }   → tenant has not configured a key; caller must error
 */

export interface TenantKeyResult {
  key: string | null;
  isSystemTenant: boolean;
  status: "active" | "invalid" | "unverified" | "missing" | "system";
}

export async function resolveTenantOpenAIKey(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  tenantId: string | null | undefined,
): Promise<TenantKeyResult> {
  if (!tenantId) {
    // No tenant on the record → treat as system/internal flow.
    return { key: null, isSystemTenant: true, status: "system" };
  }

  // Is this the Freedom system tenant?
  const { data: tenantRow, error: tErr } = await supabase
    .from("tenants")
    .select("is_system_tenant, slug")
    .eq("id", tenantId)
    .maybeSingle();

  if (tErr) {
    // Fail-open as system to avoid blocking Freedom's own ingestion on transient errors.
    console.warn("[tenantKeyResolver] tenant lookup failed, defaulting to system:", tErr.message);
    return { key: null, isSystemTenant: true, status: "system" };
  }

  const isSystem = !!tenantRow?.is_system_tenant || tenantRow?.slug === "freedom-claims";
  if (isSystem) {
    return { key: null, isSystemTenant: true, status: "system" };
  }

  // White-label tenant — must have a configured key.
  const { data: cred, error: cErr } = await supabase
    .from("tenant_openai_credentials")
    .select("status")
    .eq("tenant_id", tenantId)
    .maybeSingle();

  if (cErr || !cred) {
    return { key: null, isSystemTenant: false, status: "missing" };
  }

  if (cred.status !== "active") {
    return { key: null, isSystemTenant: false, status: cred.status as TenantKeyResult["status"] };
  }

  const { data: decrypted, error: dErr } = await supabase
    .rpc("decrypt_tenant_openai_key", { p_tenant: tenantId });

  if (dErr || !decrypted) {
    console.error("[tenantKeyResolver] decrypt failed:", dErr?.message);
    return { key: null, isSystemTenant: false, status: "invalid" };
  }

  return { key: decrypted as string, isSystemTenant: false, status: "active" };
}

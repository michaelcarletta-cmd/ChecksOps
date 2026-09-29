/**
 * Default Moov configuration applied to every ChecksOps tenant.
 *
 * Moov is generally available: there is no Freedom-only, pilot, or
 * allowlist gate. Test accounts stay on the sandbox ledger so no real
 * money moves; live tenants use production credentials. Identity/KYB,
 * ToS, bank verification, wallet, and capability checks still apply
 * before any money movement.
 */
export interface TenantMoovDefaults {
  payment_provider: "moov";
  moov_allowlisted: true;
  moov_environment: "production" | "sandbox";
}

export function tenantMoovDefaults(opts?: { isTestAccount?: boolean | null }): TenantMoovDefaults {
  return {
    payment_provider: "moov",
    moov_allowlisted: true,
    moov_environment: opts?.isTestAccount ? "sandbox" : "production",
  };
}

/** Live tenants that have not started Moov onboarding move to production. */
export function shouldPromoteExistingTenantToProduction(tenant: {
  is_test_account?: boolean | null;
  moov_environment?: string | null;
  has_moov_account?: boolean | null;
}): boolean {
  if (tenant.is_test_account) return false;
  if (tenant.has_moov_account) return false;
  return (tenant.moov_environment ?? "sandbox").toLowerCase() !== "production";
}

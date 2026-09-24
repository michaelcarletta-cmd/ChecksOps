/**
 * Server-side Moov defaults for every ChecksOps tenant.
 *
 * Availability is not gated by moov_allowlisted, Freedom, or a pilot list.
 * AWS_MOOV_ENABLED is a real-money / production-mutation safety hold
 * (see provider-flags.mjs). It is not a tenant eligibility switch.
 */
export const tenantMoovDefaults = ({ isTestAccount = false } = {}) => ({
  payment_provider: 'moov',
  moov_allowlisted: true,
  moov_environment: isTestAccount ? 'sandbox' : 'production',
});

export const shouldPromoteExistingTenantToProduction = (tenant = {}) => {
  if (tenant.is_test_account) return false;
  if (tenant.has_moov_account) return false;
  return String(tenant.moov_environment ?? 'sandbox').toLowerCase() !== 'production';
};

/**
 * Platform (master merchant) identity vs tenant identity.
 *
 * ChecksOps runs two separate logins on purpose:
 *  - PLATFORM_OWNER_EMAIL  -> the ChecksOps platform / master merchant.
 *    Owns Tenant Management, platform financials and the PLATFORM Moov
 *    facilitator account (MOOV_PLATFORM_ACCOUNT_ID). Not a member of any
 *    single organization.
 *  - Tenant logins (e.g. the Freedom Adjustment admin) -> own only their own
 *    organization and their own connected Moov account.
 *
 * Keeping these separate prevents platform-level actions from ever running
 * against a tenant's Moov account (and vice versa).
 */
export const PLATFORM_OWNER_EMAIL = "checksopsadmin@gmail.com";

/** Legacy alias — kept so existing imports keep working. */
export const MASTER_MERCHANT_EMAIL = PLATFORM_OWNER_EMAIL;

export function isPlatformOwner(email?: string | null): boolean {
  return (email ?? "").trim().toLowerCase() === PLATFORM_OWNER_EMAIL;
}

/** @deprecated use isPlatformOwner */
export function isMasterMerchant(email?: string | null): boolean {
  return isPlatformOwner(email);
}

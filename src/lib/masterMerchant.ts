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
 *
 * Authorization prefers the stable application UUID (same key as
 * public.is_master_owner()). Email remains a secondary UI gate for production
 * magic-link flows. This does not change the SQL helper.
 */

/** Stable ChecksOps application UUID for the platform master owner. */
export const MASTER_OWNER_APPLICATION_USER_ID = "7dbb3009-f059-4767-b5dc-1c5c72379330";

export const PLATFORM_OWNER_EMAIL = "checksopsadmin@gmail.com";

/**
 * Staging-only Cognito login email for the existing master Cognito user
 * (sub 54a8b4c8-… → application UUID MASTER_OWNER_APPLICATION_USER_ID).
 * Not a production mailbox; password UAT only.
 */
export const STAGING_MASTER_LOGIN_EMAIL = "staging-master@checksops.invalid";

/** Legacy alias — kept so existing imports keep working. */
export const MASTER_MERCHANT_EMAIL = PLATFORM_OWNER_EMAIL;

export function isMasterOwnerUserId(userId?: string | null): boolean {
  return String(userId || "").trim().toLowerCase() === MASTER_OWNER_APPLICATION_USER_ID;
}

export function isPlatformOwnerEmail(email?: string | null): boolean {
  const emailLc = (email ?? "").trim().toLowerCase();
  if (!emailLc) return false;
  if (emailLc === PLATFORM_OWNER_EMAIL) return true;
  if (emailLc === STAGING_MASTER_LOGIN_EMAIL) return true;
  return false;
}

/**
 * Platform-owner UI gate. Prefer application UUID (matches is_master_owner()).
 * Email is secondary for production inbox-based flows and staging master login.
 */
export function isPlatformOwner(email?: string | null, userId?: string | null): boolean {
  if (isMasterOwnerUserId(userId)) return true;
  return isPlatformOwnerEmail(email);
}

/** @deprecated use isPlatformOwner */
export function isMasterMerchant(email?: string | null, userId?: string | null): boolean {
  return isPlatformOwner(email, userId);
}

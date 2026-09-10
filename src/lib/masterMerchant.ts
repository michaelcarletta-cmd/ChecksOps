/**
 * Platform-owner identity vs tenant identity.
 *
 * ChecksOps runs two separate login scopes:
 *  - PLATFORM_OWNER_EMAIL owns Tenant Management and platform financials.
 *  - Tenant users are restricted to the organizations in tenant_users.
 *
 * Platform authorization is deliberately email-based here. An application UUID
 * can belong to a tenant user (including a migrated legacy owner record), so it
 * must never grant platform-wide UI access or redirect a tenant to /admin.
 */

export const PLATFORM_OWNER_EMAIL = "checksopsadmin@gmail.com";

/**
 * Retained only for compatibility with staging tooling and historical imports.
 * This UUID does not grant platform-owner access.
 */
export const MASTER_OWNER_APPLICATION_USER_ID = "7dbb3009-f059-4767-b5dc-1c5c72379330";

/** Staging test identity. It does not grant platform-owner access. */
export const STAGING_MASTER_LOGIN_EMAIL = "staging-master@checksops.invalid";

/** Legacy alias — kept so existing imports keep working. */
export const MASTER_MERCHANT_EMAIL = PLATFORM_OWNER_EMAIL;

/** @deprecated Stable UUIDs are not platform-authorization credentials. */
export function isMasterOwnerUserId(_userId?: string | null): boolean {
  return false;
}

export function isPlatformOwnerEmail(email?: string | null): boolean {
  return (email ?? "").trim().toLowerCase() === PLATFORM_OWNER_EMAIL;
}

/**
 * Platform-owner UI gate. The authenticated application email must match the
 * explicit platform-owner mailbox. Tenant roles and legacy UUIDs never qualify.
 */
export function isPlatformOwner(email?: string | null, _userId?: string | null): boolean {
  return isPlatformOwnerEmail(email);
}

/** @deprecated use isPlatformOwner */
export function isMasterMerchant(email?: string | null, userId?: string | null): boolean {
  return isPlatformOwner(email, userId);
}

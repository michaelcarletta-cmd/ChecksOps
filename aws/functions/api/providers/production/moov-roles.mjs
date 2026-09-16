/**
 * Tenant Management identity for production Moov money movement.
 *
 * Matches `src/lib/masterMerchant.ts`. Platform-owner access is the mapped
 * application email `checksopsadmin@gmail.com`, never a UUID and never a
 * spoofed JWT email. SQL `is_platform_owner()` uses `auth.uid()` and is not
 * relied on from these writers.
 */

export const PLATFORM_OWNER_EMAIL = 'checksopsadmin@gmail.com';

/** Historical import UUID. It does not grant Tenant Management access. */
export const MASTER_OWNER_APPLICATION_USER_ID = '7dbb3009-f059-4767-b5dc-1c5c72379330';

export const mappedEmail = (mapping = {}) => String(mapping?.email || '').trim().toLowerCase();

export const isPlatformOwnerEmail = (email) =>
  String(email || '').trim().toLowerCase() === PLATFORM_OWNER_EMAIL;

/** Tenant Management. JWT `claims.email` is ignored so it cannot be spoofed. */
export const isPlatformOwnerCaller = (mapping = {}) => isPlatformOwnerEmail(mappedEmail(mapping));

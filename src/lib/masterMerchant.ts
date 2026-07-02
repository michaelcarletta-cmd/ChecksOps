/**
 * Master merchant (platform owner) identity.
 * The master merchant can preview any tenant's Check Center without being a tenant_users member.
 */
export const MASTER_MERCHANT_EMAIL = "mcarletta@freedomadj.com";

export function isMasterMerchant(email?: string | null): boolean {
  return (email ?? "").trim().toLowerCase() === MASTER_MERCHANT_EMAIL;
}

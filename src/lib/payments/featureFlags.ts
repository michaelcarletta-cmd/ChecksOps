import type { PaymentProviderId } from "./types";

/**
 * Payment feature flags.
 *
 * Moov is the money-movement rail. Plaid remains available only as a legacy
 * fallback flag; the Actum/Authentecheck rail has been removed entirely.
 */
export interface PaymentFeatureFlags {
  USE_PLAID: boolean;
  USE_MOOV: boolean;
  SHOW_PAYMENT_SETTINGS: boolean;
  /** Internal-only admin tooling for the platform payment provider. */
  SHOW_PAYMENT_ADMIN: boolean;
}

function envFlag(name: string, fallback: boolean): boolean {
  const raw = (import.meta as any)?.env?.[`VITE_${name}`];
  if (raw === undefined || raw === null || raw === "") return fallback;
  return String(raw).toLowerCase() === "true" || raw === "1";
}

export const PAYMENT_FLAGS: PaymentFeatureFlags = {
  USE_PLAID: envFlag("USE_PLAID", false),
  // Moov is on, but still gated per-organization by the `moov_allowlisted`
  // flag (enforced again on the backend), so only allowlisted orgs see it.
  USE_MOOV: envFlag("USE_MOOV", true),
  SHOW_PAYMENT_SETTINGS: envFlag("SHOW_PAYMENT_SETTINGS", true),
  SHOW_PAYMENT_ADMIN: envFlag("SHOW_PAYMENT_ADMIN", true),
};

/**
 * Moov actions are only allowed when the global flag is on AND the tenant is
 * on the allowlist. The backend enforces the same two conditions plus the
 * presence of sandbox credentials — this is purely so the UI stays quiet.
 */
export function isMoovAllowedForTenant(tenantAllowlisted: boolean | null | undefined): boolean {
  return PAYMENT_FLAGS.USE_MOOV && !!tenantAllowlisted;
}

export function isProviderEnabled(provider: PaymentProviderId): boolean {
  switch (provider) {
    case "plaid":
      return PAYMENT_FLAGS.USE_PLAID;
    case "moov":
      return PAYMENT_FLAGS.USE_MOOV;
    default:
      return false;
  }
}

/** The provider used when a tenant has no explicit (or no enabled) preference. */
export function defaultProvider(): PaymentProviderId {
  return PAYMENT_FLAGS.USE_MOOV ? "moov" : "plaid";
}

/**
 * Resolves the rail for a tenant.
 * `payment_provider` (provider-neutral) wins; the legacy `payment_rail`
 * column is only consulted as a fallback.
 */
export function resolveProvider(
  tenantPaymentProvider?: string | null,
  legacyPaymentRail?: string | null,
): PaymentProviderId {
  const candidate = (tenantPaymentProvider ?? legacyPaymentRail ?? "") as PaymentProviderId;
  if (candidate && isProviderEnabled(candidate)) return candidate;
  return defaultProvider();
}

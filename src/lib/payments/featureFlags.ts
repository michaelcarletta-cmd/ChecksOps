import type { PaymentProviderId } from "./types";

/**
 * Payment feature flags.
 *
 * Defaults keep today's behaviour exactly as-is: Actum and Plaid stay on,
 * Moov stays off. A tenant row can override the resolved provider once its
 * flag is enabled, so switching rails is a data change, not a deploy.
 */
export interface PaymentFeatureFlags {
  USE_ACTUM: boolean;
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
  USE_ACTUM: envFlag("USE_ACTUM", true),
  USE_PLAID: envFlag("USE_PLAID", true),
  // Moov is wired but intentionally dark until the live APIs are connected.
  USE_MOOV: envFlag("USE_MOOV", false),
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
    case "actum":
      return PAYMENT_FLAGS.USE_ACTUM;
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
  // Deliberately never Moov: enabling the Moov flag must not migrate any
  // existing tenant. A tenant only lands on Moov by setting payment_provider
  // explicitly on its own row.
  if (PAYMENT_FLAGS.USE_ACTUM) return "actum";
  return "plaid";
}

/**
 * Resolves the rail for a tenant.
 * `payment_provider` (new, provider-neutral) wins; `payment_rail` (legacy
 * actum/plaid flag) is the fallback so nothing changes for current tenants.
 */
export function resolveProvider(
  tenantPaymentProvider?: string | null,
  legacyPaymentRail?: string | null,
): PaymentProviderId {
  const candidate = (tenantPaymentProvider ?? legacyPaymentRail ?? "") as PaymentProviderId;
  if (candidate && isProviderEnabled(candidate)) return candidate;
  return defaultProvider();
}

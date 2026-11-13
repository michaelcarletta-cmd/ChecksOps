import type { PaymentProviderId } from "./types";

/**
 * Payment feature flags.
 *
 * Moov is the money-movement rail.
 */
export interface PaymentFeatureFlags {
  USE_MOOV: boolean;
  SHOW_PAYMENT_SETTINGS: boolean;
  /** Internal-only admin tooling for the platform payment provider. */
  SHOW_PAYMENT_ADMIN: boolean;
  /**
   * Automatic payouts (Moov treasury sweeps): the on/off control, the sweep settings
   * ("Manage sweeps" / MoovTreasuryPanel) and the "Last automatic payout" display.
   */
  SHOW_AUTOMATIC_PAYOUTS: boolean;
  /** The "Manage sweeps" button on Wallet & Treasury (MoovTreasuryPanel in a dialog). */
  SHOW_SWEEPS_BUTTON: boolean;
}

function envFlag(name: string, fallback: boolean): boolean {
  const raw = (import.meta as any)?.env?.[`VITE_${name}`];
  if (raw === undefined || raw === null || raw === "") return fallback;
  return String(raw).toLowerCase() === "true" || raw === "1";
}

export const PAYMENT_FLAGS: PaymentFeatureFlags = {
  // Moov is generally available for every tenant. Identity/KYB, ToS, bank
  // verification, wallet, and capability checks still gate money movement.
  USE_MOOV: envFlag("USE_MOOV", true),
  SHOW_PAYMENT_SETTINGS: envFlag("SHOW_PAYMENT_SETTINGS", true),
  SHOW_PAYMENT_ADMIN: envFlag("SHOW_PAYMENT_ADMIN", true),
  // Hidden (owner, 2026-11-12: "if we are not using it, hide anything that says automatic
  // payout"). Production refuses every sweep-config change by design (production_execution_blocked,
  // aws/functions/api/providers.mjs), so these controls could only fail. Not an env flag: change it
  // here, in a reviewed PR, to bring them back.
  SHOW_AUTOMATIC_PAYOUTS: false,
  // Shown (owner, 2026-11-13: "I want the sweeps button not the automatic payout button"): the
  // "Manage sweeps" button and its dialog, independent of the automatic-payout on/off button,
  // badge and tiles above. Not an env flag.
  SHOW_SWEEPS_BUTTON: true,
};

/**
 * Moov onboarding and UI are available to every organization when the global
 * flag is on. The unused allowlist argument is kept so existing callers
 * compile; it is ignored.
 */
export function isMoovAllowedForTenant(_tenantAllowlisted?: boolean | null): boolean {
  return PAYMENT_FLAGS.USE_MOOV;
}

export function isProviderEnabled(provider: PaymentProviderId): boolean {
  switch (provider) {
    case "moov":
      return PAYMENT_FLAGS.USE_MOOV;
    default:
      return false;
  }
}

/** The provider used when a tenant has no explicit (or no enabled) preference. */
export function defaultProvider(): PaymentProviderId {
  return "moov";
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

/**
 * Deterministic payment_wallets lookup when a tenant has both sandbox
 * and production operating rows. Never picks rows[0]. Never invents a wallet.
 */

export type PaymentWalletEnvironment = "production" | "sandbox";

export type PaymentWalletRow = {
  id?: string | null;
  tenant_id?: string | null;
  wallet_type?: string | null;
  environment?: string | null;
  provider?: string | null;
  provider_payment_method_id?: string | null;
  provider_wallet_id?: string | null;
  provider_metadata?: Record<string, unknown> | null;
};

export type PaymentWalletSelectionErrorCode =
  | "environment_required"
  | "ambiguous_wallet";

export class PaymentWalletSelectionError extends Error {
  code: PaymentWalletSelectionErrorCode;

  constructor(code: PaymentWalletSelectionErrorCode, message: string) {
    super(message);
    this.name = "PaymentWalletSelectionError";
    this.code = code;
  }
}

const PRODUCTION_HOSTS = new Set([
  "checksops.com",
  "www.checksops.com",
  "checkops.com",
  "www.checkops.com",
]);

export function normalizePaymentEnvironment(value: unknown): PaymentWalletEnvironment | null {
  const env = String(value || "").trim().toLowerCase();
  if (env === "production") return "production";
  if (env === "sandbox" || env === "staging") return "sandbox";
  return null;
}

/**
 * Application/provider environment for WalletOps wallet reads.
 *
 * Production hosts always select production wallets.
 * Staging hosts always select sandbox wallets.
 * Other hosts (localhost) use the tenant Moov environment, then sandbox.
 */
export function resolveWalletOpsEnvironment(input: {
  hostname?: string | null;
  tenantMoovEnvironment?: string | null;
  appUrl?: string | null;
}): PaymentWalletEnvironment {
  const host = String(input.hostname || "").trim().toLowerCase();
  let appHost = "";
  try {
    appHost = new URL(String(input.appUrl || "")).hostname.toLowerCase();
  } catch {
    appHost = "";
  }

  const isStagingHost = host.startsWith("staging.")
    || host === "staging.checksops.com"
    || appHost.startsWith("staging.");
  if (isStagingHost) return "sandbox";

  if (PRODUCTION_HOSTS.has(host)) return "production";

  return normalizePaymentEnvironment(input.tenantMoovEnvironment) || "sandbox";
}

export function isWalletOpsEnvironmentHostDeterministic(hostname?: string | null, appUrl?: string | null) {
  const host = String(hostname || "").trim().toLowerCase();
  if (host.startsWith("staging.") || PRODUCTION_HOSTS.has(host)) return true;
  try {
    return new URL(String(appUrl || "")).hostname.toLowerCase().startsWith("staging.");
  } catch {
    return false;
  }
}

export function selectPaymentWallet(
  rows: PaymentWalletRow[] | null | undefined,
  {
    tenantId,
    walletType = "operating",
    environment,
  }: {
    tenantId: string;
    walletType?: string;
    environment?: string | null;
  },
): PaymentWalletRow | null {
  const env = normalizePaymentEnvironment(environment);
  if (!env) {
    throw new PaymentWalletSelectionError(
      "environment_required",
      "Payment wallet environment is required.",
    );
  }

  const wanted = (rows || []).filter((row) => {
    if (row.tenant_id && String(row.tenant_id) !== String(tenantId)) return false;
    if (row.wallet_type && String(row.wallet_type) !== String(walletType)) return false;
    return normalizePaymentEnvironment(row.environment) === env;
  });

  if (wanted.length === 0) return null;
  if (wanted.length > 1) {
    throw new PaymentWalletSelectionError(
      "ambiguous_wallet",
      `Multiple ${env} ${walletType} wallets for this organization.`,
    );
  }
  return wanted[0];
}

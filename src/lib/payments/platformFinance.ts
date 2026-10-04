/**
 * ChecksOps Platform Finance client read-model.
 *
 * Platform identity only. Never a tenant id, memberships[0], or WalletOps hook.
 */

export const PLATFORM_FINANCE_WRITE_BLOCKED_MESSAGE =
  "Platform Finance writes are disabled. Bank attach, verification, ACH, and fee collection are not available in this phase.";

export type PlatformFinanceEnvironment = "production" | "sandbox";

export type PlatformBankRow = {
  id?: string | null;
  bank_account_id?: string | null;
  bankAccountID?: string | null;
  bank_name?: string | null;
  bankName?: string | null;
  last_four?: string | null;
  lastFourAccountNumber?: string | null;
  account_type?: string | null;
  bank_account_type?: string | null;
  bankAccountType?: string | null;
  holder_name?: string | null;
  holderName?: string | null;
  verification_status?: string | null;
  status?: string | null;
  connection_status?: string | null;
  is_default?: boolean | null;
  connected_at?: string | null;
  micro_deposit?: { status?: string; attempts?: number } | null;
  source?: string | null;
};

export type PlatformWalletRow = {
  walletID?: string | null;
  walletId?: string | null;
  id?: string | null;
  walletType?: string | null;
  wallet_type?: string | null;
  name?: string | null;
  accountID?: string | null;
  accountId?: string | null;
  provider_account_id?: string | null;
  availableBalance?: { value?: number; valueDecimal?: number; currency?: string } | null;
  pendingBalance?: { value?: number; valueDecimal?: number; currency?: string } | null;
};

const PRODUCTION_HOSTS = new Set([
  "checksops.com",
  "www.checksops.com",
  "checkops.com",
  "www.checkops.com",
]);

export function resolvePlatformFinanceEnvironment(input: {
  hostname?: string | null;
  checksopsEnv?: string | null;
  appUrl?: string | null;
} = {}): PlatformFinanceEnvironment {
  const env = String(input.checksopsEnv || "").trim().toLowerCase();
  const host = String(input.hostname || "").trim().toLowerCase();
  let appHost = "";
  try {
    appHost = new URL(String(input.appUrl || "")).hostname.toLowerCase();
  } catch {
    appHost = "";
  }
  if (env === "staging" || env === "sandbox" || env === "uat") return "sandbox";
  if (host.startsWith("staging.") || host === "staging.checksops.com" || appHost.startsWith("staging.")) {
    return "sandbox";
  }
  if (env === "production") return "production";
  if (PRODUCTION_HOSTS.has(host) || PRODUCTION_HOSTS.has(appHost)) return "production";
  return "sandbox";
}

export function resolvePlatformFacilitatorId(input: {
  environment?: string | null;
  sandboxPlatformAccountId?: string | null;
  productionPlatformAccountId?: string | null;
  claimedTenantId?: string | null;
  membershipTenantId?: string | null;
} = {}): string | null {
  void input.claimedTenantId;
  void input.membershipTenantId;
  const environment = String(input.environment || "").toLowerCase();
  if (environment === "production") return input.productionPlatformAccountId || null;
  return input.sandboxPlatformAccountId || null;
}

function walletTypeOf(wallet: PlatformWalletRow) {
  return String(wallet.walletType ?? wallet.wallet_type ?? wallet.name ?? "").toLowerCase();
}

function isOperatingWallet(wallet: PlatformWalletRow) {
  const type = walletTypeOf(wallet);
  return type === "operating" || type === "default" || type.includes("operating") || type === "moov-wallet";
}

/**
 * Deterministic platform/operating wallet selection.
 * Never returns wallets[0] when more than one candidate remains.
 */
export function selectPlatformWallet(
  wallets: PlatformWalletRow[] | null | undefined,
  input: { environment?: string | null; platformAccountId?: string | null } = {},
): { wallet: PlatformWalletRow | null; reason: string; warning: string | null } {
  const environment = String(input.environment || "").toLowerCase();
  if (environment !== "sandbox" && environment !== "production") {
    return { wallet: null, reason: "environment_required", warning: "Payment wallet environment is required." };
  }
  const rows = (wallets || []).filter(Boolean);
  const accountFiltered = rows.filter((wallet) => {
    const accountId = wallet.accountID ?? wallet.accountId ?? wallet.provider_account_id ?? null;
    if (!input.platformAccountId || !accountId) return true;
    return String(accountId) === String(input.platformAccountId);
  });
  const operating = accountFiltered.filter(isOperatingWallet);
  const pool = operating.length > 0 ? operating : accountFiltered;
  if (pool.length === 0) return { wallet: null, reason: "not_found", warning: null };
  if (pool.length > 1) {
    return {
      wallet: null,
      reason: "ambiguous_wallet",
      warning: `Multiple ${environment} platform wallets for the ChecksOps facilitator.`,
    };
  }
  return { wallet: pool[0], reason: "selected", warning: null };
}

export function composePlatformBankDisplay(input: {
  providerBanks?: PlatformBankRow[] | null;
  localMethods?: PlatformBankRow[] | null;
} = {}): PlatformBankRow[] {
  const byId = new Map<string, PlatformBankRow>();
  for (const bank of input.providerBanks || []) {
    const bankAccountId = bank.bank_account_id || bank.bankAccountID || null;
    if (!bankAccountId) continue;
    byId.set(String(bankAccountId), {
      id: bank.id || bankAccountId,
      bank_account_id: bankAccountId,
      bank_name: bank.bank_name ?? bank.bankName ?? null,
      last_four: bank.last_four ?? bank.lastFourAccountNumber ?? null,
      account_type: bank.account_type ?? bank.bank_account_type ?? bank.bankAccountType ?? null,
      holder_name: bank.holder_name ?? bank.holderName ?? null,
      verification_status: String(bank.verification_status ?? bank.status ?? "unknown").toLowerCase(),
      connection_status: String(
        bank.connection_status ?? (String(bank.status || "").toLowerCase() === "verified" ? "connected" : "pending"),
      ),
      is_default: Boolean(bank.is_default),
      connected_at: bank.connected_at ?? null,
      micro_deposit: bank.micro_deposit ?? null,
      source: "moov",
    });
  }
  for (const method of input.localMethods || []) {
    const bankAccountId = method.bank_account_id || method.id;
    if (!bankAccountId) continue;
    const key = String(bankAccountId);
    const existing = byId.get(key);
    byId.set(key, {
      id: method.id || existing?.id || bankAccountId,
      bank_account_id: key,
      bank_name: existing?.bank_name || method.bank_name || null,
      last_four: existing?.last_four || method.last_four || null,
      account_type: existing?.account_type || method.account_type || null,
      holder_name: existing?.holder_name || method.holder_name || null,
      verification_status: String(existing?.verification_status || method.verification_status || "unknown").toLowerCase(),
      connection_status: existing?.connection_status || method.connection_status || "pending",
      is_default: Boolean(method.is_default || existing?.is_default),
      connected_at: method.connected_at || existing?.connected_at || null,
      micro_deposit: method.micro_deposit || existing?.micro_deposit || null,
      source: existing ? "moov+local" : "local",
    });
  }
  return [...byId.values()];
}

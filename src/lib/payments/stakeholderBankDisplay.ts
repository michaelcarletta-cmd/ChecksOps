/**
 * Settings Bank Account / Stakeholder display.
 *
 * Moov-linked accounts store last four on provider_* / payment_provider_methods
 * / tenants.bank_last_four. Placeholder chk_acct values (all zeros) are not a
 * real account number and must not render as ••••0000 or "Account pending"
 * when Moov already has a verified last four.
 *
 * verification_status on stakeholder_accounts can lag Moov. Linked recipient
 * onboarding and payment_provider_methods are the same source WalletOps uses.
 */

export type StakeholderVerificationStatus =
  | "unverified"
  | "pending"
  | "verified"
  | "failed"
  | "locked"
  | "admin_override";

const ZERO_ACCOUNT = /^0+$/;
const VERIFIED_HINTS = new Set([
  "verified",
  "admin_override",
  "successful",
  "completed",
  "connected",
  "ready",
  "active",
]);

export function digitsOnly(value: unknown): string {
  return String(value ?? "").replace(/\D/g, "");
}

export function isPlaceholderAccountNumber(value: unknown): boolean {
  const digits = digitsOnly(value);
  return digits.length === 0 || ZERO_ACCOUNT.test(digits);
}

export function accountLastFour(input: {
  chk_acct?: string | null;
  provider_last_four?: string | null;
  method_last_four?: string | null;
  bank_last_four?: string | null;
  recipient_last_four?: string | null;
  last_four?: string | null;
} = {}): string | null {
  const candidates = [
    input.provider_last_four,
    input.method_last_four,
    input.bank_last_four,
    input.recipient_last_four,
    input.last_four,
    isPlaceholderAccountNumber(input.chk_acct) ? null : input.chk_acct,
  ];
  for (const candidate of candidates) {
    const digits = digitsOnly(candidate);
    if (digits && !ZERO_ACCOUNT.test(digits)) return digits.slice(-4);
  }
  return null;
}

export function formatAccountLastFour(input: Parameters<typeof accountLastFour>[0] = {}): string {
  const four = accountLastFour(input);
  return four ? `••••${four}` : "Account pending";
}

export function isVerifiedHint(value: unknown): boolean {
  return VERIFIED_HINTS.has(String(value ?? "").toLowerCase().replace(/_/g, "-"));
}

export function nextVerificationStatus(
  current: string | null | undefined,
  incoming: string | null | undefined,
): StakeholderVerificationStatus {
  const now = String(current ?? "unverified").toLowerCase() as StakeholderVerificationStatus;
  if (now === "admin_override" || now === "verified") return now;
  if (isVerifiedHint(incoming)) return "verified";
  if (now === "pending" || now === "failed" || now === "locked" || now === "unverified") return now;
  return "unverified";
}

export function resolveStakeholderVerificationStatus(input: {
  verification_status?: string | null;
  recipient_onboarding_status?: string | null;
  recipient_verification_status?: string | null;
  method_verification_status?: string | null;
  method_connection_status?: string | null;
  tenant_bank_connection_status?: string | null;
} = {}): StakeholderVerificationStatus {
  const local = String(input.verification_status ?? "unverified").toLowerCase() as StakeholderVerificationStatus;
  if (local === "admin_override" || local === "verified") return local;
  const linked = [
    input.recipient_onboarding_status,
    input.recipient_verification_status,
    input.method_verification_status,
    input.method_connection_status,
    input.tenant_bank_connection_status,
  ];
  if (linked.some(isVerifiedHint)) return "verified";
  return local || "unverified";
}

export type StakeholderBankRow = {
  id: string;
  account_type?: string | null;
  origin?: string | null;
  chk_acct?: string | null;
  provider_last_four?: string | null;
  provider_bank_name?: string | null;
  provider_account_id?: string | null;
  verification_status?: string | null;
  [key: string]: unknown;
};

export type LinkedBankMethod = {
  last_four?: string | null;
  bank_name?: string | null;
  verification_status?: string | null;
  connection_status?: string | null;
  provider_account_id?: string | null;
  external_recipient_id?: string | null;
};

export type LinkedRecipient = {
  id?: string;
  stakeholder_account_id?: string | null;
  onboarding_status?: string | null;
  provider_last_four?: string | null;
  provider_bank_name?: string | null;
  provider_account_id?: string | null;
};

export type TenantBankMirror = {
  bank_last_four?: string | null;
  bank_name?: string | null;
  bank_connection_status?: string | null;
};

export function isOperatingStakeholder(acct: Pick<StakeholderBankRow, "account_type" | "origin">): boolean {
  return acct.account_type === "operating" || acct.origin === "provider_connected";
}

export function pickLinkedMethod(
  acct: StakeholderBankRow,
  methods: LinkedBankMethod[] = [],
  recipient: LinkedRecipient | null = null,
): LinkedBankMethod | null {
  const operating = isOperatingStakeholder(acct);
  const matches = (methods || []).filter((method) => {
    if (recipient?.id && method.external_recipient_id === recipient.id) return true;
    if (acct.provider_account_id && method.provider_account_id === acct.provider_account_id) return true;
    if (operating && !method.external_recipient_id) return true;
    return false;
  });
  return matches.find((method) => isVerifiedHint(method.verification_status) || isVerifiedHint(method.connection_status))
    ?? matches.find((method) => accountLastFour({ last_four: method.last_four }))
    ?? matches[0]
    ?? null;
}

export function decorateStakeholderBank(
  acct: StakeholderBankRow,
  extras: {
    tenantBank?: TenantBankMirror | null;
    methods?: LinkedBankMethod[];
    recipients?: LinkedRecipient[];
  } = {},
) {
  const operating = isOperatingStakeholder(acct);
  const recipient = (extras.recipients ?? []).find((row) => row.stakeholder_account_id === acct.id) ?? null;
  const method = pickLinkedMethod(acct, extras.methods, recipient);
  const lastFourInput = {
    chk_acct: acct.chk_acct,
    provider_last_four: acct.provider_last_four,
    method_last_four: method?.last_four ?? null,
    bank_last_four: operating ? extras.tenantBank?.bank_last_four ?? null : null,
    recipient_last_four: recipient?.provider_last_four ?? null,
  };
  const verification_status = resolveStakeholderVerificationStatus({
    verification_status: acct.verification_status,
    recipient_onboarding_status: recipient?.onboarding_status,
    method_verification_status: method?.verification_status,
    method_connection_status: method?.connection_status,
    tenant_bank_connection_status: operating ? extras.tenantBank?.bank_connection_status ?? null : null,
  });
  return {
    ...acct,
    verification_status,
    display_last_four: accountLastFour(lastFourInput),
    display_last_four_label: formatAccountLastFour(lastFourInput),
    display_bank_name: acct.provider_bank_name || method?.bank_name || recipient?.provider_bank_name
      || (operating ? extras.tenantBank?.bank_name ?? null : null)
      || null,
  };
}

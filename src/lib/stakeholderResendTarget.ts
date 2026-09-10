/**
 * Stakeholder Resend targeting helpers.
 *
 * The live Edge function `stakeholder-resend-verification` binds by
 * `stakeholder_account_id` only. Display name is never a key.
 * These helpers keep the Settings list from hiding an inactive production
 * recipient and from presenting two "Michael Carletta" rows as identical.
 */

export type LinkedPaymentRecipient = {
  id: string;
  email: string | null;
  environment: string | null;
  provider_last_four: string | null;
  provider_bank_name: string | null;
  onboarding_status: string | null;
};

export type StakeholderResendRow = {
  id: string;
  account_type: string | null;
  origin: string | null;
  is_active: boolean | null;
  verification_status: string | null;
  verification_recipient_email: string | null;
  nickname: string | null;
  custname: string | null;
  homeowner_name: string | null;
  chk_acct?: string | null;
  acct_type?: string | null;
  is_primary?: boolean | null;
  verified_at?: string | null;
  external_payment_recipients?: LinkedPaymentRecipient[] | LinkedPaymentRecipient | null;
};

export function linkedRecipients(row: StakeholderResendRow): LinkedPaymentRecipient[] {
  const raw = row.external_payment_recipients;
  if (!raw) return [];
  return Array.isArray(raw) ? raw : [raw];
}

export function shouldListStakeholder(row: StakeholderResendRow): boolean {
  if (row.account_type === "operating" || row.origin === "provider_connected") return false;
  if (row.is_active) return true;
  return linkedRecipients(row).length > 0;
}

export function setupLinkEmail(row: StakeholderResendRow): string | null {
  const fromStakeholder = row.verification_recipient_email?.trim() || "";
  if (fromStakeholder) return fromStakeholder;
  return linkedRecipients(row)[0]?.email?.trim() || null;
}

export function canResendSetupLink(row: StakeholderResendRow): boolean {
  const status = row.verification_status ?? "unverified";
  if (!["unverified", "pending", "failed"].includes(status)) return false;
  return Boolean(setupLinkEmail(row));
}

export function resendConfirmCopy(row: StakeholderResendRow) {
  const rec = linkedRecipients(row)[0] ?? null;
  return {
    stakeholderId: row.id,
    displayName: row.homeowner_name || row.custname || row.nickname || "this stakeholder",
    accountType: row.account_type,
    email: setupLinkEmail(row),
    environment: rec?.environment ?? null,
    bankLast4: rec?.provider_last_four ?? null,
    bankName: rec?.provider_bank_name ?? null,
    recipientId: rec?.id ?? null,
    isActive: Boolean(row.is_active),
  };
}

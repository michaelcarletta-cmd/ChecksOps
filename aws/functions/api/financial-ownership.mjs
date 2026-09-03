const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const isUuid = (value) => UUID_RE.test(String(value || ''));

export const UNTRUSTED_OWNERSHIP_KEYS = [
  'tenant_id', 'tenantId', 'user_id', 'userId', 'application_user_id',
  'provider_account_id', 'providerAccountId', 'wallet_id', 'walletId',
  'provider_wallet_id', 'bank_account_id', 'bankAccountId',
  'transfer_id', 'transferId', 'payee_id', 'payeeId',
];

export const ignoredOwnershipSpoof = (body = {}) => (
  UNTRUSTED_OWNERSHIP_KEYS.filter((key) => body[key] !== undefined && body[key] !== null)
);

export const membershipForTenant = (memberships, tenantId) =>
  (memberships || []).find((row) => row.tenant_id === tenantId) || null;

/**
 * Independently verify:
 * user → app UUID → tenant membership → check/resource → provider account/wallet
 * All must belong to the authorized tenant. Browser IDs are never trusted.
 */
export const verifyOwnershipChain = ({
  applicationUserId,
  memberships,
  check,
  providerAccount,
  wallet,
  payee,
  claimed = {},
} = {}) => {
  const ignored = ignoredOwnershipSpoof(claimed);
  if (!applicationUserId) {
    return { ok: false, error: 'identity_required', ignored };
  }
  if (!check?.id || !check.tenant_id) {
    return { ok: false, error: 'resource_not_owned', field: 'check', ignored };
  }
  const membership = membershipForTenant(memberships, check.tenant_id);
  if (!membership) {
    return { ok: false, error: 'tenant_membership_required', ignored };
  }
  // Browser tenant_id / user_id are never used. Resource tenant comes from the check.
  if (providerAccount && providerAccount.tenant_id !== check.tenant_id) {
    return { ok: false, statusCode: 403, error: 'spoofed_provider_id', field: 'provider_account', ignored };
  }
  if (wallet && wallet.tenant_id !== check.tenant_id) {
    return { ok: false, statusCode: 403, error: 'spoofed_provider_id', field: 'wallet', ignored };
  }
  if (payee && payee.check_id && payee.check_id !== check.id) {
    return { ok: false, statusCode: 403, error: 'spoofed_payee_id', ignored };
  }
  if (claimed.provider_account_id && providerAccount
    && claimed.provider_account_id !== providerAccount.provider_account_id
    && claimed.provider_account_id !== providerAccount.id) {
    return { ok: false, statusCode: 403, error: 'spoofed_provider_id', field: 'provider_account_id', ignored };
  }
  if ((claimed.wallet_id || claimed.provider_wallet_id) && wallet) {
    const claimedWallet = claimed.wallet_id || claimed.provider_wallet_id;
    if (claimedWallet !== wallet.id && claimedWallet !== wallet.provider_wallet_id) {
      return { ok: false, statusCode: 403, error: 'spoofed_provider_id', field: 'wallet_id', ignored };
    }
  }
  return {
    ok: true,
    tenantId: check.tenant_id,
    membership,
    ignored,
  };
};

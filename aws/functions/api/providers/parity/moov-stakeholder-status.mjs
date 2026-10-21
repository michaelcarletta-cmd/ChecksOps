/**
 * Reconcile stakeholder bank-verification display from live Moov bank status.
 * Identity/KYC and bank verification stay separate — a provider account id is
 * never treated as bank-verified by itself.
 */
import { liveBankVerified } from '../moov-recipient-tos-policy.mjs';
import { moovFetch, scopes } from './moov-client.mjs';

export const bankStatusFromMoovBanks = (banks = []) => {
  const list = Array.isArray(banks) ? banks : (banks?.bankAccounts || []);
  if (!list.length) return 'unverified';
  if (liveBankVerified(list)) return 'verified';
  const statuses = list.map((row) => String(row?.verificationStatus || row?.status || '').toLowerCase());
  if (statuses.some((status) => ['errored', 'failed', 'disabled'].includes(status))) return 'failed';
  if (statuses.some((status) => status && status !== 'unverified')) return 'pending';
  return 'unverified';
};

export const identityStatusFromMoovAccount = (account = {}) => String(
  account?.profile?.individual?.verification?.status
  ?? account?.profile?.business?.verification?.status
  ?? account?.verification?.status
  ?? account?.verificationStatus
  ?? 'unverified',
).toLowerCase();

const firstBank = (banks = []) => {
  const list = Array.isArray(banks) ? banks : (banks?.bankAccounts || []);
  return list[0] || null;
};

export const reconcileStakeholderBankStatuses = async (client, {
  tenantId,
  fetchImpl,
  stakeholders = null,
  fetchAccount = null,
  fetchBanks = null,
}) => {
  const rows = stakeholders || (await client.query(
    `SELECT id, tenant_id, verification_status, provider, provider_account_id,
            provider_bank_account_id, provider_last_four, provider_bank_name
     FROM public.stakeholder_accounts
     WHERE tenant_id = $1::uuid
       AND is_active = true
       AND provider = 'moov'
       AND provider_account_id IS NOT NULL`,
    [tenantId],
  )).rows;

  const results = [];
  for (const row of rows) {
    const accountId = row.provider_account_id;
    if (!accountId) {
      results.push({
        id: row.id,
        skipped: true,
        reason: 'missing_provider_account',
        verification_status: row.verification_status || 'unverified',
      });
      continue;
    }
    let remote = null;
    let banks = [];
    try {
      remote = fetchAccount
        ? await fetchAccount(accountId)
        : await moovFetch(`/accounts/${accountId}`, {
          scopes: scopes.accountRead(accountId),
          fetchImpl,
        });
    } catch (error) {
      results.push({
        id: row.id,
        error: error.message || 'moov_account_get_failed',
        verification_status: row.verification_status || 'unverified',
      });
      continue;
    }
    try {
      const payload = fetchBanks
        ? await fetchBanks(accountId)
        : await moovFetch(`/accounts/${accountId}/bank-accounts`, {
          scopes: scopes.bankAccountsRead(accountId),
          fetchImpl,
        });
      banks = Array.isArray(payload) ? payload : payload?.bankAccounts || [];
    } catch {
      banks = [];
    }
    const bankStatus = bankStatusFromMoovBanks(banks);
    const identityStatus = identityStatusFromMoovAccount(remote || {});
    const bank = firstBank(banks);
    const bankAccountId = bank?.bankAccountID || bank?.bankAccountId || row.provider_bank_account_id || null;
    const lastFour = bank?.lastFourAccountNumber || row.provider_last_four || null;
    const bankName = bank?.bankName || row.provider_bank_name || null;
    await client.query(
      `UPDATE public.stakeholder_accounts
       SET verification_status = $2,
           verified_at = CASE WHEN $2 = 'verified' THEN COALESCE(verified_at, now()) ELSE verified_at END,
           provider_bank_account_id = COALESCE($3, provider_bank_account_id),
           provider_last_four = COALESCE($4, provider_last_four),
           provider_bank_name = COALESCE($5, provider_bank_name),
           updated_at = now()
       WHERE id = $1::uuid AND tenant_id = $6::uuid`,
      [row.id, bankStatus, bankAccountId, lastFour, bankName, tenantId],
    );
    results.push({
      id: row.id,
      verification_status: bankStatus,
      identity_status: identityStatus,
      bank_verified: bankStatus === 'verified',
      identity_verified: identityStatus === 'verified',
      conflated: false,
    });
  }
  return results;
};

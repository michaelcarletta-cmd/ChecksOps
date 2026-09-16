/**
 * Cache live Moov GET into RDS so the UI matches Moov.
 * Local status only — never POSTs capabilities, KYC, banks, or wallets.
 */
import { capabilityFlags } from '../parity/moov-client.mjs';
import { isDeniedDuplicateMoovAccount, KNOWN_APPROVED_MOOV } from './moov-accounts.mjs';
import { listOf, productionMoovFetch } from './moov-http.mjs';

const verificationOf = (account) => String(
  account?.profile?.business?.verification?.status
  ?? account?.profile?.individual?.verification?.status
  ?? account?.verification?.status
  ?? '',
).toLowerCase();

export const PAYEE_LIST_RECIPIENTS_SQL = `
SELECT id, stakeholder_account_id, provider_account_id, onboarding_status
FROM public.external_payment_recipients
WHERE tenant_id = $1::uuid
  AND provider_account_id IS NOT NULL
LIMIT 20`;

export const PAYEE_LIST_STAKEHOLDERS_SQL = `
SELECT id, provider_account_id, verification_status
FROM public.stakeholder_accounts
WHERE tenant_id = $1::uuid
  AND provider_account_id IS NOT NULL
  AND COALESCE(is_active, true) = true
LIMIT 20`;

export async function persistMerchantCache(client, {
  tenantId,
  moovAccountId,
  snapshot,
  readiness,
  wallet,
} = {}) {
  if (!client || !tenantId || !moovAccountId) return { persisted: false };
  const flags = capabilityFlags(snapshot?.capabilities || []);
  const verification = String(snapshot?.verification || '').toLowerCase() || null;
  const onboarding = snapshot?.verified ? 'active' : (verification === 'pending' ? 'verification_pending' : 'onboarding_incomplete');
  const tosAt = snapshot?.tosAccepted ? new Date().toISOString() : null;
  const metadata = {
    banks: snapshot?.banks || [],
    source: 'live_provider_get',
    cached_at: new Date().toISOString(),
  };
  await client.query(
    `UPDATE public.payment_provider_accounts
     SET onboarding_status = $2,
         verification_status = $3,
         tos_accepted_at = COALESCE(tos_accepted_at, $4::timestamptz),
         can_send_payments = $5,
         can_receive_payments = $6,
         can_ach_credit = $7,
         can_ach_debit = $8,
         disabled = $9,
         restricted = $10,
         capabilities = $11::jsonb,
         readiness = $12::jsonb,
         last_synced_at = now(),
         provider_metadata = COALESCE(provider_metadata, '{}'::jsonb) || $13::jsonb
     WHERE tenant_id = $1::uuid
       AND provider = 'moov'
       AND environment = 'production'
       AND provider_account_id = $14`,
    [
      tenantId,
      onboarding,
      verification || 'unverified',
      tosAt,
      flags.can_send_payments === true,
      flags.can_receive_payments === true,
      flags.can_ach_credit === true,
      flags.can_ach_debit === true,
      snapshot?.disabled === true,
      flags.restricted === true,
      JSON.stringify(snapshot?.capabilities || []),
      JSON.stringify(readiness || {}),
      JSON.stringify(metadata),
      moovAccountId,
    ],
  );
  if (wallet && (wallet.available_cents != null || wallet.provider_wallet_id)) {
    await client.query(
      `UPDATE public.payment_wallets
       SET available_cents = COALESCE($3, available_cents),
           pending_cents = COALESCE($4, pending_cents),
           status = COALESCE($5, status),
           last_synced_at = now()
       WHERE tenant_id = $1::uuid
         AND provider = 'moov'
         AND environment = 'production'
         AND ($2::text IS NULL OR provider_wallet_id = $2)`,
      [
        tenantId,
        wallet.provider_wallet_id || null,
        Number.isFinite(Number(wallet.available_cents)) ? Number(wallet.available_cents) : null,
        Number.isFinite(Number(wallet.pending_cents)) ? Number(wallet.pending_cents) : null,
        wallet.status || null,
      ],
    );
  }
  return { persisted: true };
}

const uniqueAccountIds = (rows = []) => {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const id = String(row?.provider_account_id || '').trim();
    if (!id || seen.has(id) || isDeniedDuplicateMoovAccount(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
};

export async function loadLinkedPayeeRows(client, tenantId) {
  const recipients = (await client.query(PAYEE_LIST_RECIPIENTS_SQL, [tenantId])).rows || [];
  const stakeholders = (await client.query(PAYEE_LIST_STAKEHOLDERS_SQL, [tenantId])).rows || [];
  const known = KNOWN_APPROVED_MOOV.recipient;
  if (
    String(tenantId) === KNOWN_APPROVED_MOOV.freedom.tenantId
    && known?.moovAccountId
    && !recipients.some((row) => String(row.provider_account_id) === known.moovAccountId)
  ) {
    recipients.push({
      id: known.recipientId,
      stakeholder_account_id: null,
      provider_account_id: known.moovAccountId,
      onboarding_status: null,
    });
  }
  return { recipients, stakeholders };
}

export async function persistTenantPayeeCache(client, {
  tenantId,
  credentials,
  fetchImpl,
} = {}) {
  if (!client || !tenantId || !credentials) return { payees: [], persisted: false };
  const { recipients, stakeholders } = await loadLinkedPayeeRows(client, tenantId);
  const accountIds = uniqueAccountIds([...recipients, ...stakeholders]);
  const payees = [];

  for (const accountId of accountIds) {
    const account = await productionMoovFetch({
      credentials,
      path: `/accounts/${accountId}`,
      fetchImpl,
    }).catch(() => null);
    if (!account) continue;
    const banks = listOf(await productionMoovFetch({
      credentials,
      path: `/accounts/${accountId}/bank-accounts`,
      fetchImpl,
    }).catch(() => []));
    const verification = verificationOf(account);
    const verified = verification === 'verified';
    const verifiedBank = banks.some((bank) => String(bank.status || '').toLowerCase() === 'verified');
    const bank = banks.find((row) => String(row.status || '').toLowerCase() === 'verified') || banks[0] || null;
    const localStatus = verified && (verifiedBank || banks.length === 0) ? 'verified' : verification || 'pending';

    const linkedRecipients = recipients.filter((row) => String(row.provider_account_id) === accountId);
    const linkedStakeholders = stakeholders.filter((row) => String(row.provider_account_id) === accountId);

    if (localStatus === 'verified') {
      await client.query(
        `UPDATE public.external_payment_recipients
         SET onboarding_status = 'verified',
             provider_bank_name = COALESCE($3, provider_bank_name),
             provider_last_four = COALESCE($4, provider_last_four)
         WHERE tenant_id = $1::uuid
           AND provider_account_id = $2
           AND onboarding_status IS DISTINCT FROM 'verified'`,
        [
          tenantId,
          accountId,
          bank?.bankName || null,
          bank?.lastFourAccountNumber || bank?.lastFour || null,
        ],
      ).catch(() => null);
      await client.query(
        `UPDATE public.stakeholder_accounts
         SET verification_status = 'verified',
             verified_at = COALESCE(verified_at, now()),
             provider_bank_name = COALESCE($3, provider_bank_name),
             provider_last_four = COALESCE($4, provider_last_four)
         WHERE tenant_id = $1::uuid
           AND provider_account_id = $2
           AND verification_status IS DISTINCT FROM 'verified'
           AND verification_status IS DISTINCT FROM 'admin_override'`,
        [
          tenantId,
          accountId,
          bank?.bankName || null,
          bank?.lastFourAccountNumber || bank?.lastFour || null,
        ],
      ).catch(() => null);
    }

    const stakeholderIds = [
      ...linkedStakeholders.map((row) => row.id),
      ...linkedRecipients.map((row) => row.stakeholder_account_id).filter(Boolean),
    ];
    payees.push({
      moov_account_id: accountId,
      recipient_id: linkedRecipients[0]?.id || (accountId === KNOWN_APPROVED_MOOV.recipient.moovAccountId
        ? KNOWN_APPROVED_MOOV.recipient.recipientId
        : null),
      stakeholder_account_ids: [...new Set(stakeholderIds)],
      verification_status: localStatus,
      identity_verified: verified,
      bank_verified: verifiedBank,
      bank_name: bank?.bankName || null,
      last_four: bank?.lastFourAccountNumber || bank?.lastFour || null,
      tos_accepted: Boolean(account?.termsOfService?.acceptedDate || account?.termsOfService?.acceptedOn),
    });
  }

  return { payees, persisted: true };
}

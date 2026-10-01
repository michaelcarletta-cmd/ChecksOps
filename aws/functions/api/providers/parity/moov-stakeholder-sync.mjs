/**
 * Mirror live Moov bank metadata onto stakeholder_accounts.
 * Read-only against Moov. Does not create transfers or change money movement.
 *
 * Sandbox AWS sync must only write sandbox-scoped rows so production Freedom
 * / Michael records are not overwritten by sandbox bank data.
 */

const ZERO_ACCOUNT = /^0+$/;

export function digitsOnly(value) {
  return String(value ?? '').replace(/\D/g, '');
}

export function isPlaceholderAccountNumber(value) {
  const digits = digitsOnly(value);
  return digits.length === 0 || ZERO_ACCOUNT.test(digits);
}

export function safeLastFour(value) {
  const digits = digitsOnly(value);
  if (!digits || ZERO_ACCOUNT.test(digits)) return null;
  return digits.slice(-4);
}

export function interpretMoovBankStatus(bank = {}, verification = null) {
  const bankStatus = String(bank.status ?? '').toLowerCase();
  const verifStatus = String(verification?.status ?? '').toLowerCase();
  const verifSucceeded = ['successful', 'completed', 'verified'].includes(verifStatus);
  if (bankStatus === 'verified' || verifSucceeded) return 'verified';
  if (
    bankStatus === 'errored'
    || bankStatus === 'verificationfailed'
    || ['failed', 'expired', 'max-attempts-exceeded'].includes(verifStatus)
  ) {
    return 'failed';
  }
  return bankStatus || verifStatus || 'pending';
}

export function nextStakeholderVerification(current, incoming) {
  const now = String(current ?? 'unverified').toLowerCase();
  if (now === 'admin_override' || now === 'verified') return now;
  if (incoming === 'verified') return 'verified';
  return now || incoming || 'unverified';
}

export function pickPreferredBank(banks = []) {
  const list = Array.isArray(banks) ? banks : [];
  return list.find((bank) => interpretMoovBankStatus(bank) === 'verified')
    ?? list.find((bank) => safeLastFour(bank.lastFourAccountNumber ?? bank.last_four))
    ?? list[0]
    ?? null;
}

export function stakeholderPatchFromBank(current = {}, bank = {}, verification = null) {
  const incoming = interpretMoovBankStatus(bank, verification);
  const lastFour = safeLastFour(
    bank.lastFourAccountNumber ?? bank.last_four ?? current.provider_last_four,
  );
  const verificationStatus = nextStakeholderVerification(current.verification_status, incoming);
  return {
    provider_bank_account_id: bank.bankAccountID ?? bank.bankAccountId ?? current.provider_bank_account_id ?? null,
    provider_bank_name: bank.bankName ?? bank.bank_name ?? current.provider_bank_name ?? null,
    provider_last_four: lastFour,
    verification_status: verificationStatus,
    verified_at: verificationStatus === 'verified'
      ? (current.verified_at || new Date().toISOString())
      : current.verified_at ?? null,
  };
}

export function sandboxScopedStakeholder(row = {}, environment = 'sandbox') {
  const env = String(row.provider_environment ?? row.environment ?? '').toLowerCase();
  if (!env) return environment === 'sandbox';
  return env === String(environment || 'sandbox').toLowerCase();
}

export async function applyMoovBanksToStakeholders(client, {
  tenantId,
  environment = 'sandbox',
  providerAccountId,
  banks = [],
  verification = null,
  operatingOnly = false,
} = {}) {
  if (!client?.query || !tenantId || !providerAccountId) return { updated: 0 };
  const bank = pickPreferredBank(banks);
  if (!bank) return { updated: 0 };
  const rows = (await client.query(
    `SELECT id, verification_status, verified_at, provider_last_four, provider_bank_name,
            provider_bank_account_id, provider_environment, account_type, origin
     FROM public.stakeholder_accounts
     WHERE tenant_id = $1::uuid
       AND is_active = true
       AND provider_account_id = $2
       AND ($3::boolean = false OR account_type = 'operating' OR origin = 'provider_connected')`,
    [tenantId, providerAccountId, operatingOnly],
  )).rows;
  let updated = 0;
  for (const row of rows) {
    if (!sandboxScopedStakeholder(row, environment) && environment === 'sandbox') continue;
    const patch = stakeholderPatchFromBank(row, bank, verification);
    await client.query(
      `UPDATE public.stakeholder_accounts
       SET provider_bank_account_id = $2,
           provider_bank_name = $3,
           provider_last_four = $4,
           verification_status = $5,
           verified_at = $6
       WHERE id = $1::uuid`,
      [
        row.id,
        patch.provider_bank_account_id,
        patch.provider_bank_name,
        patch.provider_last_four,
        patch.verification_status,
        patch.verified_at,
      ],
    );
    updated += 1;
  }
  return { updated };
}

export async function syncLinkedStakeholderBanks(client, {
  tenantId,
  environment = 'sandbox',
  skipAccountIds = [],
  fetchBanks,
} = {}) {
  if (!client?.query || !tenantId || typeof fetchBanks !== 'function') {
    return { accounts: 0, updated: 0 };
  }
  const skip = new Set((skipAccountIds || []).filter(Boolean));
  const stakes = (await client.query(
    `SELECT id, provider_account_id, verification_status, verified_at, provider_last_four,
            provider_bank_name, provider_bank_account_id, provider_environment
     FROM public.stakeholder_accounts
     WHERE tenant_id = $1::uuid AND is_active = true AND provider_account_id IS NOT NULL`,
    [tenantId],
  )).rows;
  const recipients = (await client.query(
    `SELECT id, stakeholder_account_id, provider_account_id, onboarding_status,
            provider_last_four, provider_bank_name, environment
     FROM public.external_payment_recipients
     WHERE tenant_id = $1::uuid AND provider_account_id IS NOT NULL`,
    [tenantId],
  )).rows;

  const byAccount = new Map();
  for (const row of stakes) {
    if (!row.provider_account_id || skip.has(row.provider_account_id)) continue;
    if (!sandboxScopedStakeholder(row, environment) && environment === 'sandbox') continue;
    const list = byAccount.get(row.provider_account_id) || { stakes: [], recipients: [] };
    list.stakes.push(row);
    byAccount.set(row.provider_account_id, list);
  }
  for (const row of recipients) {
    if (!row.provider_account_id || skip.has(row.provider_account_id)) continue;
    if (String(row.environment || environment).toLowerCase() !== String(environment).toLowerCase()) continue;
    const list = byAccount.get(row.provider_account_id) || { stakes: [], recipients: [] };
    list.recipients.push(row);
    byAccount.set(row.provider_account_id, list);
  }

  let updated = 0;
  for (const [accountId, group] of byAccount.entries()) {
    const banks = await fetchBanks(accountId).catch(() => []);
    const bank = pickPreferredBank(banks);
    if (!bank) continue;
    const incoming = interpretMoovBankStatus(bank);
    for (const stake of group.stakes) {
      const patch = stakeholderPatchFromBank(stake, bank);
      await client.query(
        `UPDATE public.stakeholder_accounts
         SET provider_bank_account_id = $2,
             provider_bank_name = $3,
             provider_last_four = $4,
             verification_status = $5,
             verified_at = $6
         WHERE id = $1::uuid`,
        [
          stake.id,
          patch.provider_bank_account_id,
          patch.provider_bank_name,
          patch.provider_last_four,
          patch.verification_status,
          patch.verified_at,
        ],
      );
      updated += 1;
    }
    for (const recipient of group.recipients) {
      await client.query(
        `UPDATE public.external_payment_recipients
         SET onboarding_status = $2,
             provider_bank_name = $3,
             provider_last_four = $4,
             bank_linked_at = COALESCE(bank_linked_at, now())
         WHERE id = $1::uuid`,
        [
          recipient.id,
          incoming === 'verified' ? 'ready' : (recipient.onboarding_status || 'awaiting_bank'),
          bank.bankName ?? bank.bank_name ?? recipient.provider_bank_name ?? null,
          safeLastFour(bank.lastFourAccountNumber ?? bank.last_four) ?? recipient.provider_last_four ?? null,
        ],
      );
      if (recipient.stakeholder_account_id && !group.stakes.some((s) => s.id === recipient.stakeholder_account_id)) {
        const linked = (await client.query(
          `SELECT id, verification_status, verified_at, provider_last_four, provider_bank_name,
                  provider_bank_account_id, provider_environment
           FROM public.stakeholder_accounts WHERE id = $1::uuid`,
          [recipient.stakeholder_account_id],
        )).rows[0];
        if (linked) {
          const patch = stakeholderPatchFromBank(linked, bank);
          await client.query(
            `UPDATE public.stakeholder_accounts
             SET provider = 'moov',
                 provider_account_id = $2,
                 provider_bank_account_id = $3,
                 provider_bank_name = $4,
                 provider_last_four = $5,
                 verification_status = $6,
                 verified_at = $7
             WHERE id = $1::uuid`,
            [
              linked.id,
              accountId,
              patch.provider_bank_account_id,
              patch.provider_bank_name,
              patch.provider_last_four,
              patch.verification_status,
              patch.verified_at,
            ],
          );
          updated += 1;
        }
      }
    }
  }
  return { accounts: byAccount.size, updated };
}

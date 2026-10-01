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

export function normalizeStakeholderEmail(value) {
  const email = String(value ?? '').trim().toLowerCase();
  return email || null;
}

export function bankEventFromPayload(data = {}) {
  const bank = data?.bankAccount && typeof data.bankAccount === 'object' ? data.bankAccount : data;
  return {
    bankAccountID: data?.bankAccountID ?? data?.bankAccountId ?? bank?.bankAccountID ?? bank?.bankAccountId ?? null,
    bankName: data?.bankName ?? bank?.bankName ?? bank?.bank_name ?? null,
    lastFour: data?.lastFourAccountNumber ?? bank?.lastFourAccountNumber ?? data?.lastFour ?? bank?.last_four ?? null,
    status: data?.status ?? bank?.status ?? null,
    verification: data?.verification ?? bank?.verification ?? null,
  };
}

export function shouldApplyBankVerificationEvent(eventType, data = {}) {
  const type = String(eventType || '');
  if (!type.startsWith('bankAccount') && !type.includes('verification')) return false;
  const event = bankEventFromPayload(data);
  return Boolean(event.bankAccountID || event.status || event.verification);
}

export function resolveStakeholderVerificationTargets({
  providerAccountId,
  bankAccountID = null,
  stakeholders = [],
  recipients = [],
  methods = [],
  isTenantOperatingAccount = false,
} = {}) {
  const ids = new Set();
  const recipientLinks = [];

  for (const stake of stakeholders) {
    if (providerAccountId && stake.provider_account_id === providerAccountId) ids.add(stake.id);
  }

  const matchingRecipients = recipients.filter((row) => {
    if (providerAccountId && row.provider_account_id === providerAccountId) return true;
    if (bankAccountID && row.provider_bank_account_id === bankAccountID) return true;
    return false;
  });

  for (const recipient of matchingRecipients) {
    if (recipient.stakeholder_account_id) ids.add(recipient.stakeholder_account_id);
  }

  for (const method of methods) {
    const matches = (bankAccountID && method.provider_bank_account_id === bankAccountID)
      || (providerAccountId && method.provider_account_id === providerAccountId);
    if (!matches || !method.external_recipient_id) continue;
    const recipient = recipients.find((row) => row.id === method.external_recipient_id);
    if (recipient?.stakeholder_account_id) ids.add(recipient.stakeholder_account_id);
  }

  for (const recipient of matchingRecipients) {
    if (recipient.stakeholder_account_id || !normalizeStakeholderEmail(recipient.email)) continue;
    const email = normalizeStakeholderEmail(recipient.email);
    const candidates = stakeholders.filter((stake) => {
      if (stake.provider_account_id && stake.provider_account_id !== providerAccountId) return false;
      return normalizeStakeholderEmail(stake.verification_recipient_email) === email;
    });
    if (candidates.length === 1) {
      ids.add(candidates[0].id);
      recipientLinks.push({ recipientId: recipient.id, stakeholderId: candidates[0].id });
    }
  }

  if (isTenantOperatingAccount) {
    for (const stake of stakeholders) {
      const operating = stake.account_type === 'operating' || stake.origin === 'provider_connected';
      if (!operating) continue;
      if (!stake.provider_account_id || stake.provider_account_id === providerAccountId) {
        ids.add(stake.id);
      }
    }
  }

  return { stakeholderIds: [...ids], recipientLinks };
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
            provider_bank_account_id, provider_environment, account_type, origin, provider_account_id
     FROM public.stakeholder_accounts
     WHERE tenant_id = $1::uuid
       AND is_active = true
       AND (
         provider_account_id = $2
         OR (
           $3::boolean = true
           AND (account_type = 'operating' OR origin = 'provider_connected')
           AND (provider_account_id IS NULL OR provider_account_id = $2)
         )
       )`,
    [tenantId, providerAccountId, operatingOnly],
  )).rows;
  let updated = 0;
  for (const row of rows) {
    if (!sandboxScopedStakeholder(row, environment) && environment === 'sandbox') continue;
    const patch = stakeholderPatchFromBank(row, bank, verification);
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
        row.id,
        providerAccountId,
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
            provider_last_four, provider_bank_name, environment, email
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
      let linkedStakeholderId = recipient.stakeholder_account_id || null;
      if (!linkedStakeholderId && recipient.email) {
        const email = normalizeStakeholderEmail(recipient.email);
        const matches = (await client.query(
          `SELECT id, verification_status, verified_at, provider_last_four, provider_bank_name,
                  provider_bank_account_id, provider_environment, provider_account_id
           FROM public.stakeholder_accounts
           WHERE tenant_id = $1::uuid
             AND is_active = true
             AND lower(trim(verification_recipient_email)) = $2
             AND (provider_account_id IS NULL OR provider_account_id = $3)`,
          [tenantId, email, accountId],
        )).rows;
        if (matches.length === 1) {
          linkedStakeholderId = matches[0].id;
          await client.query(
            `UPDATE public.external_payment_recipients
             SET stakeholder_account_id = $2::uuid
             WHERE id = $1::uuid AND stakeholder_account_id IS NULL`,
            [recipient.id, linkedStakeholderId],
          );
        }
      }
      if (linkedStakeholderId && !group.stakes.some((s) => s.id === linkedStakeholderId)) {
        const linked = (await client.query(
          `SELECT id, verification_status, verified_at, provider_last_four, provider_bank_name,
                  provider_bank_account_id, provider_environment
           FROM public.stakeholder_accounts WHERE id = $1::uuid`,
          [linkedStakeholderId],
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

function mergeStakeholderRows(...lists) {
  const byId = new Map();
  for (const list of lists) {
    for (const row of list || []) {
      if (row?.id) byId.set(row.id, row);
    }
  }
  return [...byId.values()];
}

export async function applyMoovBankVerificationEvent(client, {
  environment = 'sandbox',
  providerAccountId,
  tenantId = null,
  bank = {},
  verification = null,
  sandboxOnly = true,
} = {}) {
  if (!client?.query || !providerAccountId) return { updated: 0, recipients: 0 };
  if (sandboxOnly && String(environment || '').toLowerCase() !== 'sandbox') {
    return { updated: 0, recipients: 0, skipped: 'production_environment' };
  }

  const event = bankEventFromPayload(bank);
  const scopedEnv = sandboxOnly ? 'sandbox' : environment;
  const recipients = (await client.query(
    `SELECT id, tenant_id, stakeholder_account_id, provider_account_id, email,
            onboarding_status, provider_last_four, provider_bank_name, environment,
            provider_bank_account_id
     FROM public.external_payment_recipients
     WHERE provider_account_id = $1 AND environment = $2`,
    [providerAccountId, scopedEnv],
  )).rows;
  const methods = event.bankAccountID
    ? (await client.query(
      `SELECT id, provider_account_id, provider_bank_account_id, external_recipient_id, environment
       FROM public.payment_provider_methods
       WHERE provider_bank_account_id = $1 AND environment = $2`,
      [event.bankAccountID, scopedEnv],
    )).rows
    : [];

  let tenant = tenantId || recipients[0]?.tenant_id || null;
  let isTenantOperatingAccount = false;
  const account = (await client.query(
    `SELECT id, tenant_id, environment
     FROM public.payment_provider_accounts
     WHERE provider = 'moov' AND provider_account_id = $1 AND environment = $2
     LIMIT 1`,
    [providerAccountId, scopedEnv],
  )).rows[0];
  if (account) {
    tenant = tenant || account.tenant_id;
    isTenantOperatingAccount = true;
  }

  let stakeholders = [];
  if (tenant) {
    stakeholders = (await client.query(
      `SELECT id, tenant_id, provider_account_id, verification_status, verified_at,
              provider_last_four, provider_bank_name, provider_bank_account_id,
              provider_environment, account_type, origin, verification_recipient_email
       FROM public.stakeholder_accounts
       WHERE tenant_id = $1::uuid AND is_active = true`,
      [tenant],
    )).rows;
  } else {
    const linkedIds = recipients.map((row) => row.stakeholder_account_id).filter(Boolean);
    const byLink = linkedIds.length
      ? (await client.query(
        `SELECT id, tenant_id, provider_account_id, verification_status, verified_at,
                provider_last_four, provider_bank_name, provider_bank_account_id,
                provider_environment, account_type, origin, verification_recipient_email
         FROM public.stakeholder_accounts
         WHERE id = ANY($1::uuid[]) AND is_active = true`,
        [linkedIds],
      )).rows
      : [];
    const byAccount = (await client.query(
      `SELECT id, tenant_id, provider_account_id, verification_status, verified_at,
              provider_last_four, provider_bank_name, provider_bank_account_id,
              provider_environment, account_type, origin, verification_recipient_email
       FROM public.stakeholder_accounts
       WHERE provider_account_id = $1 AND is_active = true`,
      [providerAccountId],
    )).rows;
    stakeholders = mergeStakeholderRows(byLink, byAccount);
  }

  if (sandboxOnly) {
    stakeholders = stakeholders.filter((row) => sandboxScopedStakeholder(row, 'sandbox'));
  }

  const targets = resolveStakeholderVerificationTargets({
    providerAccountId,
    bankAccountID: event.bankAccountID,
    stakeholders,
    recipients,
    methods,
    isTenantOperatingAccount,
  });

  const lastFour = safeLastFour(event.lastFour);
  const incoming = interpretMoovBankStatus({
    status: event.status,
    lastFourAccountNumber: event.lastFour,
    bankAccountID: event.bankAccountID,
    bankName: event.bankName,
  }, verification ?? event.verification);

  for (const recipient of recipients) {
    const link = targets.recipientLinks.find((row) => row.recipientId === recipient.id);
    await client.query(
      `UPDATE public.external_payment_recipients
       SET onboarding_status = $2,
           provider_bank_name = COALESCE($3, provider_bank_name),
           provider_last_four = COALESCE($4, provider_last_four),
           stakeholder_account_id = COALESCE($5::uuid, stakeholder_account_id),
           bank_linked_at = COALESCE(bank_linked_at, now())
       WHERE id = $1::uuid`,
      [
        recipient.id,
        incoming === 'verified' ? 'ready' : (recipient.onboarding_status || 'awaiting_bank'),
        event.bankName,
        lastFour,
        link?.stakeholderId ?? null,
      ],
    );
  }

  let updated = 0;
  for (const id of targets.stakeholderIds) {
    let current = stakeholders.find((row) => row.id === id);
    if (!current) {
      current = (await client.query(
        `SELECT id, verification_status, verified_at, provider_last_four, provider_bank_name,
                provider_bank_account_id, provider_environment
         FROM public.stakeholder_accounts WHERE id = $1::uuid`,
        [id],
      )).rows[0];
    }
    if (!current) continue;
    if (sandboxOnly && !sandboxScopedStakeholder(current, 'sandbox')) continue;
    const patch = stakeholderPatchFromBank(current, {
      bankAccountID: event.bankAccountID,
      bankName: event.bankName,
      lastFourAccountNumber: event.lastFour,
      status: event.status,
    }, verification ?? event.verification);
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
        current.id,
        providerAccountId,
        patch.provider_bank_account_id,
        patch.provider_bank_name,
        patch.provider_last_four,
        patch.verification_status,
        patch.verified_at,
      ],
    );
    updated += 1;
  }

  return {
    updated,
    recipients: recipients.length,
    stakeholderIds: targets.stakeholderIds,
    linked: targets.recipientLinks.length,
  };
}

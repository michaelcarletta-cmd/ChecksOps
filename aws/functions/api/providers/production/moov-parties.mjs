import { isUuid } from '../../financial-ownership.mjs';
import {
  KNOWN_APPROVED_MOOV,
  isDeniedDuplicateMoovAccount,
  knownApprovedForTenant,
} from './moov-accounts.mjs';

export const CHECKALT_CLEARED_STATUSES = Object.freeze(new Set([
  'cleared',
  'settled',
  'deposited',
]));

const walletIdOf = (row) => row?.walletID || row?.walletId || row?.provider_wallet_id || null;

const failParty = (error, extra = {}) => ({
  ok: false,
  statusCode: extra.statusCode || 409,
  error,
  provider: 'moov',
  liveProviderCalled: extra.liveProviderCalled === true,
  productionExecution: false,
  kycRequested: false,
  capabilitiesPosted: false,
  ...extra,
});

export const pickOperatingWalletId = (wallets = []) => {
  const list = Array.isArray(wallets) ? wallets : [];
  const operating = list.find((row) => (
    !String(row?.name || row?.metadata?.walletType || '').toLowerCase().includes('trust')
  ));
  return walletIdOf(operating) || walletIdOf(list[0]) || null;
};

export async function resolveProductionMerchant(client, tenantId) {
  if (!isUuid(tenantId)) {
    return failParty('invalid_uuid', { statusCode: 400, field: 'tenant_id' });
  }
  const known = knownApprovedForTenant(tenantId);
  const accounts = (await client.query(
    `SELECT provider_account_id, onboarding_status, verification_status, disabled
     FROM public.payment_provider_accounts
     WHERE tenant_id = $1::uuid AND provider = 'moov' AND environment = 'production'
     ORDER BY updated_at DESC NULLS LAST
     LIMIT 8`,
    [tenantId],
  )).rows;
  const wallets = (await client.query(
    `SELECT provider_wallet_id, provider_payment_method_id, wallet_type
     FROM public.payment_wallets
     WHERE tenant_id = $1::uuid AND provider = 'moov' AND environment = 'production'
     ORDER BY CASE WHEN wallet_type = 'operating' THEN 0 ELSE 1 END, updated_at DESC NULLS LAST
     LIMIT 4`,
    [tenantId],
  )).rows;

  const ids = accounts.map((row) => row.provider_account_id).filter(Boolean);
  const preferred = (known?.moovAccountId && ids.includes(known.moovAccountId) && known.moovAccountId)
    || ids.find((id) => !isDeniedDuplicateMoovAccount(id))
    || known?.moovAccountId
    || null;

  if (!preferred) {
    return failParty('unknown_merchant_do_not_create', {
      message: 'This tenant has no production Moov merchant to reuse. Do not create a Moov account or request KYC.',
    });
  }
  if (isDeniedDuplicateMoovAccount(preferred)) {
    return failParty('denied_duplicate_account_do_not_kyc', {
      moovAccountId: preferred,
      message: 'This Moov account is a leftover duplicate. Do not KYC or request capabilities on it.',
    });
  }

  return {
    ok: true,
    tenantId,
    label: known?.label || 'Tenant merchant',
    moovAccountId: preferred,
    walletId: known?.walletId || wallets.find((row) => row.wallet_type === 'operating')?.provider_wallet_id
      || wallets[0]?.provider_wallet_id
      || null,
    bankId: known?.bankId || null,
    known,
  };
}

export async function resolveProductionRecipient(client, tenantId, recipientId) {
  if (!recipientId) {
    return failParty('recipient_required', {
      statusCode: 400,
      message: 'external_recipient_id is required. Do not default to the pay-setup recipient. Partner, sub-contractor, vendor, and homeowner payouts must name the already-verified payee.',
    });
  }
  if (!isUuid(recipientId)) {
    return failParty('invalid_uuid', { statusCode: 400, field: 'external_recipient_id' });
  }

  const recipient = (await client.query(
    `SELECT id, tenant_id, recipient_type, relationship, provider_account_id, onboarding_status,
            stakeholder_account_id
     FROM public.external_payment_recipients
     WHERE id = $1::uuid AND tenant_id = $2::uuid`,
    [recipientId, tenantId],
  )).rows[0] || null;

  let stakeholder = null;
  if (!recipient) {
    stakeholder = (await client.query(
      `SELECT id, tenant_id, account_type, provider, provider_account_id, provider_bank_account_id,
              verification_status, is_partner_payout, is_active
       FROM public.stakeholder_accounts
       WHERE id = $1::uuid AND tenant_id = $2::uuid`,
      [recipientId, tenantId],
    )).rows[0] || null;
  } else if (recipient.stakeholder_account_id) {
    stakeholder = (await client.query(
      `SELECT id, tenant_id, account_type, provider, provider_account_id, provider_bank_account_id,
              verification_status, is_partner_payout, is_active
       FROM public.stakeholder_accounts
       WHERE id = $1::uuid AND tenant_id = $2::uuid`,
      [recipient.stakeholder_account_id, tenantId],
    )).rows[0] || null;
  }

  const moovAccountId = recipient?.provider_account_id || stakeholder?.provider_account_id || null;
  const bankId = stakeholder?.provider_bank_account_id
    || (String(moovAccountId) === KNOWN_APPROVED_MOOV.recipient.moovAccountId
      ? KNOWN_APPROVED_MOOV.recipient.bankId
      : null);

  if (!recipient && !stakeholder) {
    return failParty('unknown_recipient_do_not_kyc', {
      message: 'Recipient is not a partner, sub-contractor, vendor, or homeowner linked to this tenant. Do not create or KYC a new payee.',
    });
  }
  if (!moovAccountId) {
    return failParty('unknown_recipient_do_not_kyc', {
      message: 'This payee has no Moov account to reuse. Do not create or KYC from ChecksOps.',
    });
  }
  if (isDeniedDuplicateMoovAccount(moovAccountId)) {
    return failParty('denied_duplicate_account_do_not_kyc', {
      moovAccountId,
      message: 'This Moov account is a leftover duplicate. Do not KYC or send to it.',
    });
  }
  if (stakeholder && stakeholder.is_active === false) {
    return failParty('recipient_inactive', {
      message: 'This stakeholder account is inactive. Do not re-KYC it.',
    });
  }

  return {
    ok: true,
    recipientId,
    tenantId,
    label: recipient?.recipient_type || stakeholder?.account_type || 'payee',
    recipientType: recipient?.recipient_type || stakeholder?.account_type || null,
    relationship: recipient?.relationship || null,
    moovAccountId,
    bankId,
    known: String(moovAccountId) === KNOWN_APPROVED_MOOV.recipient.moovAccountId
      ? KNOWN_APPROVED_MOOV.recipient
      : { label: 'Tenant payee', moovAccountId, bankId },
  };
}

const depositIsCleared = (row) => {
  if (!row) return false;
  if (row.cleared_at) return true;
  return CHECKALT_CLEARED_STATUSES.has(String(row.status || '').toLowerCase());
};

export async function assertCheckAltCleared(client, {
  tenantId,
  checkaltDepositId,
  checkIntakeItemId,
  batchId,
} = {}) {
  let intakeId = checkIntakeItemId || null;
  if (batchId) {
    if (!isUuid(batchId)) {
      return failParty('invalid_uuid', { statusCode: 400, field: 'batch_id' });
    }
    const batch = (await client.query(
      `SELECT id, tenant_id, check_intake_item_id FROM public.disbursement_batches WHERE id = $1::uuid`,
      [batchId],
    )).rows[0];
    if (!batch || String(batch.tenant_id) !== String(tenantId)) {
      return failParty('check_not_cleared', {
        statusCode: 409,
        message: 'Disbursement batch is not owned by this tenant. Moov send waits for a cleared CheckAlt deposit.',
      });
    }
    intakeId = batch.check_intake_item_id || intakeId;
  }

  let deposit = null;
  if (checkaltDepositId) {
    if (!isUuid(checkaltDepositId)) {
      return failParty('invalid_uuid', { statusCode: 400, field: 'checkalt_deposit_id' });
    }
    deposit = (await client.query(
      `SELECT id, tenant_id, status, cleared_at, check_intake_item_id, returned_at
       FROM public.checkalt_deposits
       WHERE id = $1::uuid AND tenant_id = $2::uuid`,
      [checkaltDepositId, tenantId],
    )).rows[0] || null;
  } else if (intakeId) {
    if (!isUuid(intakeId)) {
      return failParty('invalid_uuid', { statusCode: 400, field: 'check_intake_item_id' });
    }
    deposit = (await client.query(
      `SELECT id, tenant_id, status, cleared_at, check_intake_item_id, returned_at
       FROM public.checkalt_deposits
       WHERE check_intake_item_id = $1::uuid AND tenant_id = $2::uuid
       ORDER BY cleared_at DESC NULLS LAST, updated_at DESC NULLS LAST
       LIMIT 1`,
      [intakeId, tenantId],
    )).rows[0] || null;
  }

  if (!deposit) {
    return failParty('check_not_cleared', {
      message: 'Once a check clears through CheckAlt, the tenant (or Tenant Management) sends Moov to the partner, sub-contractor, vendor, or homeowner. Name a cleared CheckAlt deposit or its check.',
    });
  }
  if (deposit.returned_at) {
    return failParty('check_not_cleared', {
      message: 'This CheckAlt deposit was returned. Do not send Moov against it.',
    });
  }
  if (!depositIsCleared(deposit)) {
    return failParty('check_not_cleared', {
      depositStatus: deposit.status,
      message: 'CheckAlt has not cleared this deposit yet. Do not send Moov until it has.',
    });
  }
  return { ok: true, deposit };
}

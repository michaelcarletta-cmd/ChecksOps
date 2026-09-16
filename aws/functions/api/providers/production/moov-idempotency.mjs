import { APP_USER_EMAIL_GUC, APP_USER_ID_GUC } from '../../cognito.mjs';
import { financialPermissionsActivated } from '../../financial-flags.mjs';
import { stableIdempotencyKey } from '../../financial-idempotency.mjs';
import { isUuid } from '../../financial-ownership.mjs';

export const moovFundingIdempotencyKey = ({ tenantId, intentId, amountCents }) =>
  stableIdempotencyKey({
    tenantId,
    operationType: 'moov_wallet_fund',
    resourceId: intentId,
    amountCents,
    currency: 'USD',
  });

export const moovDisburseIdempotencyKey = ({ tenantId, intentId, amountCents }) =>
  stableIdempotencyKey({
    tenantId,
    operationType: 'moov_wallet_disburse',
    resourceId: intentId,
    amountCents,
    currency: 'USD',
  });

export const moovFeeCollectIdempotencyKey = ({ tenantId, intentId, amountCents }) =>
  stableIdempotencyKey({
    tenantId,
    operationType: 'moov_platform_fee_collect',
    resourceId: intentId,
    amountCents,
    currency: 'USD',
  });

export const moovRefundIdempotencyKey = ({ tenantId, intentId, amountCents }) =>
  stableIdempotencyKey({
    tenantId,
    operationType: 'moov_platform_refund',
    resourceId: intentId,
    amountCents,
    currency: 'USD',
  });

/** Provider X-Idempotency-Key is derived only from the existing payment_transfers.id. Browser cannot override. */
export const providerFundIdempotencyKey = (paymentTransferId) =>
  `checksops-wallet-fund-${paymentTransferId}`;

export async function loadProductionTransferById(client, id) {
  if (!isUuid(id)) return null;
  return (await client.query(
    `SELECT * FROM public.payment_transfers WHERE id = $1::uuid LIMIT 1`,
    [id],
  )).rows[0] || null;
}

export async function bindMoovProductionGucs(client, mapping, claims) {
  await client.query('SELECT set_config($1, $2, true)', [APP_USER_ID_GUC, mapping.application_user_id]);
  await client.query('SELECT set_config($1, $2, true)', [
    APP_USER_EMAIL_GUC,
    mapping.email || claims?.email || '',
  ]);
  await client.query("SELECT set_config('request.financial_execution', '1', true)");
  await client.query('SELECT set_config($1, $2, true)', [
    'request.aws_financial_permissions_activated',
    financialPermissionsActivated() ? '1' : '0',
  ]);
}

export async function commitDurableAttempt(client, mapping, claims) {
  await client.query('COMMIT');
  await client.query('BEGIN');
  await client.query('SET TRANSACTION READ WRITE');
  await bindMoovProductionGucs(client, mapping, claims);
}

export const rowHasProviderHttpAttempt = (row) => (
  Boolean(row?.provider_transfer_id)
  || String(row?.status || '') === 'submitting'
  || Boolean(row?.submitted_at)
);

export const shouldReconcileInsteadOfPost = (row) => {
  if (!row) return false;
  if (row.provider_transfer_id) return true;
  if (['submitted', 'completed', 'failed', 'returned', 'canceled', 'cancelled'].includes(String(row.status || ''))) {
    return true;
  }
  if (rowHasProviderHttpAttempt(row)) return true;
  return false;
};

const localRefFail = (error, extra = {}) => ({
  ok: false,
  statusCode: extra.statusCode || 409,
  error,
  message: extra.message,
  ...extra,
});

/**
 * payment_transfers.source_payment_method_id / destination_payment_method_id
 * FK to payment_provider_methods.id. wallet_id FK to payment_wallets.id.
 * Moov paymentMethodIDs must never be written into those columns.
 */
export async function loadLocalProductionWallet(client, { tenantId, providerWalletId }) {
  return (await client.query(
    `SELECT id, provider_wallet_id, provider_payment_method_id, wallet_type
     FROM public.payment_wallets
     WHERE tenant_id = $1::uuid
       AND provider = 'moov'
       AND environment = 'production'
       AND provider_wallet_id = $2
     LIMIT 1`,
    [tenantId, providerWalletId],
  )).rows[0] || null;
}

export async function loadLocalProductionBankMethod(client, {
  tenantId,
  providerBankAccountId,
  providerPaymentMethodId,
}) {
  if (providerBankAccountId) {
    const byBank = (await client.query(
      `SELECT id, provider_bank_account_id, provider_payment_method_id, connection_status
       FROM public.payment_provider_methods
       WHERE tenant_id = $1::uuid
         AND provider = 'moov'
         AND environment = 'production'
         AND provider_bank_account_id = $2
         AND connection_status = 'connected'
       ORDER BY is_default DESC NULLS LAST, updated_at DESC NULLS LAST
       LIMIT 1`,
      [tenantId, providerBankAccountId],
    )).rows[0];
    if (byBank) return byBank;
  }
  if (!providerPaymentMethodId) return null;
  return (await client.query(
    `SELECT id, provider_bank_account_id, provider_payment_method_id, connection_status
     FROM public.payment_provider_methods
     WHERE tenant_id = $1::uuid
       AND provider = 'moov'
       AND environment = 'production'
       AND provider_payment_method_id = $2
       AND connection_status = 'connected'
     ORDER BY is_default DESC NULLS LAST, updated_at DESC NULLS LAST
     LIMIT 1`,
    [tenantId, providerPaymentMethodId],
  )).rows[0] || null;
}

export async function loadLocalRecipientMethod(client, { recipientId, providerBankAccountId }) {
  if (recipientId) {
    const byRecipient = (await client.query(
      `SELECT id, provider_bank_account_id, provider_payment_method_id, external_recipient_id
       FROM public.payment_provider_methods
       WHERE external_recipient_id = $1::uuid
         AND provider = 'moov'
         AND connection_status = 'connected'
       ORDER BY is_default DESC NULLS LAST, updated_at DESC NULLS LAST
       LIMIT 1`,
      [recipientId],
    )).rows[0];
    if (byRecipient) return byRecipient;
  }
  if (!providerBankAccountId) return null;
  return (await client.query(
    `SELECT id, provider_bank_account_id, provider_payment_method_id, external_recipient_id
     FROM public.payment_provider_methods
     WHERE provider = 'moov'
       AND provider_bank_account_id = $1
       AND connection_status = 'connected'
     ORDER BY is_default DESC NULLS LAST, updated_at DESC NULLS LAST
     LIMIT 1`,
    [providerBankAccountId],
  )).rows[0] || null;
}

export async function resolveLocalFundIntentRefs(client, {
  tenantId,
  bankId,
  walletId,
  sourceMoovPaymentMethodId,
}) {
  const method = await loadLocalProductionBankMethod(client, {
    tenantId,
    providerBankAccountId: bankId,
    providerPaymentMethodId: sourceMoovPaymentMethodId,
  });
  if (!method) {
    return localRefFail('local_bank_method_missing', {
      message: 'Freedom verified bank is not linked in payment_provider_methods. Do not create a new bank.',
    });
  }
  const wallet = await loadLocalProductionWallet(client, {
    tenantId,
    providerWalletId: walletId,
  });
  if (!wallet) {
    return localRefFail('local_wallet_missing', {
      message: 'Freedom wallet is not linked in payment_wallets. Do not create a new wallet.',
    });
  }
  return {
    ok: true,
    sourcePaymentMethodId: method.id,
    destinationPaymentMethodId: null,
    walletId: wallet.id,
  };
}

export async function resolveLocalDisburseIntentRefs(client, {
  tenantId,
  walletId,
  recipientId,
  recipientBankId,
}) {
  const wallet = await loadLocalProductionWallet(client, {
    tenantId,
    providerWalletId: walletId,
  });
  if (!wallet) {
    return localRefFail('local_wallet_missing', {
      message: 'Freedom wallet is not linked in payment_wallets. Do not create a new wallet.',
    });
  }
  const destMethod = await loadLocalRecipientMethod(client, {
    recipientId,
    providerBankAccountId: recipientBankId,
  });
  return {
    ok: true,
    sourcePaymentMethodId: null,
    destinationPaymentMethodId: destMethod?.id || null,
    walletId: wallet.id,
  };
}

export const productionTransferInsertFkError = (error) => {
  const message = String(error?.constraint || error?.message || error);
  return /payment_transfers_source_payment_method_id_fkey|payment_transfers_destination_payment_method_id_fkey|payment_transfers_wallet_id_fkey/i.test(message);
};

export async function insertProductionTransferDraft(client, row) {
  const saved = (await client.query(
    `INSERT INTO public.payment_transfers
      (tenant_id, provider, environment, status, idempotency_key, amount_cents,
       platform_fee_cents, net_amount_cents, speed, description,
       source_tenant_account_id, source_payment_method_id,
       destination_tenant_id, destination_recipient_id, destination_payment_method_id,
       wallet_id, leg_role, created_by)
     VALUES ($1::uuid, 'moov', 'production', 'ready', $2, $3, 0, $3, 'standard', $4,
             $5, $6, $7, $8, $9, $10, $11, $12::uuid)
     RETURNING *`,
    [
      row.tenant_id,
      row.idempotency_key,
      row.amount_cents,
      row.description ?? null,
      row.source_tenant_account_id ?? null,
      row.source_payment_method_id ?? null,
      row.destination_tenant_id ?? null,
      row.destination_recipient_id ?? null,
      row.destination_payment_method_id ?? null,
      row.wallet_id ?? null,
      row.leg_role,
      row.created_by ?? null,
    ],
  )).rows[0];
  return saved;
}

export async function casMarkSubmitting(client, id) {
  const saved = (await client.query(
    `UPDATE public.payment_transfers
     SET status = 'submitting'
     WHERE id = $1::uuid
       AND provider_transfer_id IS NULL
       AND status = 'ready'
     RETURNING *`,
    [id],
  )).rows[0] || null;
  return saved;
}

export async function updateProductionTransfer(client, id, patch) {
  return (await client.query(
    `UPDATE public.payment_transfers SET
       provider_transfer_id = $2, provider_status = $3, status = $4,
       submitted_at = now(), provider_metadata = $5::jsonb, failure_reason = $6
     WHERE id = $1::uuid
     RETURNING *`,
    [
      id,
      patch.provider_transfer_id ?? null,
      patch.provider_status ?? null,
      patch.status,
      JSON.stringify(patch.provider_metadata || {}),
      patch.failure_reason ?? null,
    ],
  )).rows[0];
}

export async function existingProductionTransferByKey(client, tenantId, key) {
  return (await client.query(
    `SELECT * FROM public.payment_transfers
     WHERE tenant_id = $1::uuid AND idempotency_key = $2 LIMIT 1`,
    [tenantId, key],
  )).rows[0] || null;
}

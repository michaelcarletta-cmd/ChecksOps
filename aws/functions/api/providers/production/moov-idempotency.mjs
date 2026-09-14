import { APP_USER_EMAIL_GUC, APP_USER_ID_GUC } from '../../cognito.mjs';
import { financialPermissionsActivated } from '../../financial-flags.mjs';
import { stableIdempotencyKey } from '../../financial-idempotency.mjs';

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

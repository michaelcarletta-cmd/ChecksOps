import { APP_USER_EMAIL_GUC, APP_USER_ID_GUC } from '../../cognito.mjs';
import { financialPermissionsActivated } from '../../financial-flags.mjs';
import { replaySafeResponse, stableIdempotencyKey } from '../../financial-idempotency.mjs';
import { sanitizeAuditDetails } from '../../financial-audit.mjs';
import { PRODUCTION_MOOV_ENVIRONMENT } from './moov-holds.mjs';

export const moovDisbursementIdempotencyKey = ({
  tenantId,
  resourceId,
  amountCents,
  destinationId = '',
} = {}) => stableIdempotencyKey({
  tenantId,
  operationType: 'moov_disbursement',
  resourceId: `${resourceId}:${destinationId || ''}`,
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
  Boolean(row?.provider_http_attempted_at)
  || Boolean(row?.provider_transfer_id)
  || Boolean(row?.provider_metadata?.provider_http_attempted)
  || ['submitting', 'submitted', 'pending', 'completed', 'failed'].includes(String(row?.status || ''))
);

export const shouldReconcileInsteadOfPost = (row) => {
  if (!row) return false;
  if (row.provider_transfer_id) return true;
  if (rowHasProviderHttpAttempt(row) && ['ready', 'queued', 'submitting', 'error'].includes(String(row.status || ''))) {
    return true;
  }
  return false;
};

export const replayMoovTransferResponse = (row, extra = {}) => replaySafeResponse({
  id: row.id,
  tenant_id: row.tenant_id,
  status: row.status,
  provider_reference: row.provider_transfer_id,
  amount_cents: row.amount_cents,
  idempotency_key: row.idempotency_key,
}, {
  provider: 'moov',
  transfer_id: row.id,
  provider_transfer_id: row.provider_transfer_id,
  provider_status: row.provider_status,
  status: row.status,
  liveProviderCalled: false,
  productionExecution: true,
  productionRecordsMutated: true,
  message: extra.message || 'Existing production Moov transfer reused. A second provider POST was not sent.',
  ...extra,
});

export async function loadTransferByIdempotency(client, { tenantId, idempotencyKey }) {
  return (await client.query(
    `SELECT * FROM public.payment_transfers
     WHERE tenant_id = $1::uuid AND idempotency_key = $2
     LIMIT 1`,
    [tenantId, idempotencyKey],
  )).rows[0] || null;
}

export async function loadProductionTransferById(client, transferId) {
  if (!transferId) return null;
  return (await client.query(
    `SELECT * FROM public.payment_transfers WHERE id = $1::uuid LIMIT 1`,
    [transferId],
  )).rows[0] || null;
}

export async function insertProductionTransferDraft(client, {
  tenantId,
  mapping,
  amountCents,
  idempotencyKey,
  destination,
  source,
  transfer = null,
  batchId = null,
  checkId = null,
  description = null,
}) {
  if (transfer?.id) {
    return { ok: true, row: transfer, inserted: false };
  }
  try {
    const row = (await client.query(
      `INSERT INTO public.payment_transfers
        (tenant_id, provider, environment, status, idempotency_key, amount_cents,
         platform_fee_cents, net_amount_cents, speed, description,
         source_tenant_account_id, source_payment_method_id,
         destination_recipient_id, destination_payment_method_id,
         check_id, wallet_id, leg_role, created_by, provider_metadata)
       VALUES (
         $1::uuid, 'moov', $2, 'ready', $3, $4,
         0, $4, 'standard', $5,
         $6, $7,
         $8, $9,
         $10, $11, 'disbursement', $12::uuid, $13::jsonb
       )
       RETURNING *`,
      [
        tenantId,
        PRODUCTION_MOOV_ENVIRONMENT,
        idempotencyKey,
        amountCents,
        description,
        source?.providerAccountId || null,
        source?.methodRowId || null,
        destination?.recipientId || null,
        destination?.methodId || null,
        checkId,
        source?.walletId || null,
        mapping.application_user_id,
        JSON.stringify(sanitizeAuditDetails({
          phase: 'queued_before_http',
          provider_http_attempted: false,
          batch_id: batchId,
          amount_cents: amountCents,
          destination_id: destination?.recipientId || destination?.methodId || null,
        })),
      ],
    )).rows[0];
    return { ok: true, row, inserted: true };
  } catch (error) {
    if (error?.code === '23505') {
      const existing = await loadTransferByIdempotency(client, { tenantId, idempotencyKey });
      if (existing) return { ok: true, row: existing, inserted: false, duplicate: true };
    }
    return {
      ok: false,
      statusCode: 503,
      error: 'idempotency_persist_failed',
      liveProviderCalled: false,
      productionExecution: false,
      message: 'Could not persist the Moov attempt record before provider HTTP. Fail closed.',
      pgCode: error?.code || null,
    };
  }
}

export async function markHttpAttempted(client, rowId) {
  const payload = JSON.stringify(sanitizeAuditDetails({
    provider_http_attempted: true,
    phase: 'submitting',
  }));
  const claimed = (await client.query(
    `UPDATE public.payment_transfers
     SET status = 'submitting',
         provider_metadata = COALESCE(provider_metadata, '{}'::jsonb) || $2::jsonb
     WHERE id = $1::uuid
       AND provider_transfer_id IS NULL
       AND status IN ('ready', 'queued', 'draft')
     RETURNING *`,
    [rowId, payload],
  )).rows[0] || null;
  if (claimed) {
    claimed.provider_http_attempted_at = new Date().toISOString();
    return { claimed: true, row: claimed };
  }
  const existing = await loadProductionTransferById(client, rowId);
  return { claimed: false, row: existing };
}

export async function persistProviderOutcome(client, {
  rowId,
  status,
  providerTransferId = null,
  providerStatus = null,
  failureReason = null,
  providerPayload = null,
}) {
  const payload = JSON.stringify(sanitizeAuditDetails({
    provider_http_attempted: true,
    phase: 'provider_outcome',
    provider_status: providerStatus,
    response_keys: providerPayload && typeof providerPayload === 'object'
      ? Object.keys(providerPayload).slice(0, 40)
      : [],
  }));
  return (await client.query(
    `UPDATE public.payment_transfers
     SET status = $2,
         provider_transfer_id = COALESCE($3, provider_transfer_id),
         provider_status = COALESCE($4, provider_status),
         submitted_at = CASE WHEN $3 IS NOT NULL THEN COALESCE(submitted_at, now()) ELSE submitted_at END,
         failure_reason = COALESCE($5, failure_reason),
         provider_metadata = COALESCE(provider_metadata, '{}'::jsonb) || $6::jsonb
     WHERE id = $1::uuid
     RETURNING *`,
    [rowId, status, providerTransferId, providerStatus, failureReason, payload],
  )).rows[0];
}

export const providerReferenceOf = (created) => (
  created?.transferID || created?.transferId || created?.id || null
);

export const documentedSuccessStatuses = new Set([
  'created',
  'queued',
  'pending',
  'completed',
]);

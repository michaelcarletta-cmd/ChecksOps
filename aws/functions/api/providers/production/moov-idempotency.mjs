import { APP_USER_EMAIL_GUC, APP_USER_ID_GUC } from '../../cognito.mjs';
import { financialPermissionsActivated } from '../../financial-flags.mjs';
import { replaySafeResponse, stableIdempotencyKey } from '../../financial-idempotency.mjs';
import { sanitizeAuditDetails } from '../../financial-audit.mjs';

export const moovTransferIdempotencyKey = ({
  tenantId,
  resourceId,
  amountCents,
  destinationMethodId = '',
} = {}) =>
  stableIdempotencyKey({
    tenantId,
    operationType: `moov_transfer|${destinationMethodId || ''}`,
    resourceId,
    amountCents,
    currency: 'USD',
  });

/** Moov X-Idempotency-Key is the durable payment_transfers.id UUID. Never regenerated on retry. */
export const providerIdempotencyKeyFromIntent = (row) => {
  if (!row?.id) return null;
  return String(row.id);
};

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

const TERMINAL_REPLAY = new Set([
  'submitted',
  'pending',
  'completed',
  'failed',
  'returned',
  'canceled',
  'cancelled',
]);

export const rowHasProviderHttpAttempt = (row) => (
  Boolean(row?.provider_http_attempted_at)
  || Boolean(row?.provider_metadata?.provider_http_attempted)
  || Boolean(row?.provider_transfer_id)
);

const PROVIDER_MAY_HAVE_OCCURRED = new Set([
  ...TERMINAL_REPLAY,
  'queued',
  'submitting',
  'processing',
  'error',
]);

export const shouldReconcileInsteadOfPost = (row) => {
  if (!row) return false;
  if (row.provider_transfer_id) return true;
  if (TERMINAL_REPLAY.has(String(row.status || ''))) return true;
  if (rowHasProviderHttpAttempt(row) && ['queued', 'draft', 'submitting', 'pending', 'processing', 'error'].includes(String(row.status || ''))) {
    return true;
  }
  return false;
};

export const shouldBlockNewProviderPost = (row) => {
  if (!row) return false;
  if (shouldReconcileInsteadOfPost(row)) return true;
  if (PROVIDER_MAY_HAVE_OCCURRED.has(String(row.status || '')) && rowHasProviderHttpAttempt(row)) return true;
  return false;
};

export const replayTransferResponse = (row, extra = {}) => replaySafeResponse({
  id: row.id,
  tenant_id: row.tenant_id,
  status: row.status,
  provider_reference: row.provider_transfer_id,
  amount_cents: row.amount_cents,
  idempotency_key: row.idempotency_key,
}, {
  provider: 'moov',
  payment_transfer_id: row.id,
  provider_transfer_id: row.provider_transfer_id,
  status: row.status,
  liveProviderCalled: false,
  productionRecordsMutated: true,
  reconciled: extra.reconciled === true,
  message: extra.message || 'Existing Moov transfer reused. A second provider POST was not sent.',
  ...extra,
});

export async function loadTransferById(client, transferId) {
  if (!transferId) return null;
  return (await client.query(
    `SELECT id, tenant_id, provider, environment, provider_transfer_id, provider_status, status,
            idempotency_key, amount_cents, currency, speed, description,
            source_tenant_account_id, source_payment_method_id,
            destination_tenant_id, destination_recipient_id, destination_payment_method_id,
            claim_id, check_id, failure_reason, provider_metadata, created_by,
            submitted_at, completed_at, created_at, updated_at,
            provider_http_attempted_at, failure_class, last_error
     FROM public.payment_transfers
     WHERE id = $1::uuid
     LIMIT 1`,
    [transferId],
  )).rows[0] || null;
}

export async function loadTransferByIdempotency(client, { tenantId, idempotencyKey }) {
  return (await client.query(
    `SELECT id, tenant_id, provider, environment, provider_transfer_id, provider_status, status,
            idempotency_key, amount_cents, currency, speed, description,
            source_tenant_account_id, source_payment_method_id,
            destination_tenant_id, destination_recipient_id, destination_payment_method_id,
            claim_id, check_id, failure_reason, provider_metadata, created_by,
            submitted_at, completed_at, created_at, updated_at,
            provider_http_attempted_at, failure_class, last_error
     FROM public.payment_transfers
     WHERE tenant_id = $1::uuid AND idempotency_key = $2
     LIMIT 1`,
    [tenantId, idempotencyKey],
  )).rows[0] || null;
}

export async function insertQueuedTransfer(client, {
  mapping,
  tenantId,
  amountCents,
  idempotencyKey,
  sourceAccountId,
  sourceMethodId,
  destinationRecipientId,
  destinationMethodId,
  description,
  metadata = {},
}) {
  try {
    const row = (await client.query(
      `INSERT INTO public.payment_transfers (
         tenant_id, provider, environment, status, idempotency_key, amount_cents, currency,
         source_tenant_account_id, source_payment_method_id,
         destination_recipient_id, destination_payment_method_id,
         description, created_by, provider_metadata
       ) VALUES (
         $1::uuid, 'moov', 'production', 'queued', $2, $3, 'USD',
         $4, $5::uuid, $6::uuid, $7::uuid, $8, $9::uuid, $10::jsonb
       )
       RETURNING *`,
      [
        tenantId,
        idempotencyKey,
        amountCents,
        sourceAccountId,
        sourceMethodId,
        destinationRecipientId,
        destinationMethodId,
        description || 'ChecksOps production transfer',
        mapping.application_user_id,
        JSON.stringify(sanitizeAuditDetails({
          phase: 'queued_before_http',
          scale: 'integer_cents',
          amount_cents: amountCents,
          provider_http_attempted: false,
          ...metadata,
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
      message: 'Could not persist the Moov transfer intent before provider HTTP. Fail closed.',
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
         provider_http_attempted_at = now(),
         provider_metadata = COALESCE(provider_metadata, '{}'::jsonb) || $2::jsonb,
         updated_at = now()
     WHERE id = $1::uuid
       AND environment = 'production'
       AND provider = 'moov'
       AND provider_http_attempted_at IS NULL
       AND provider_transfer_id IS NULL
       AND status IN ('queued', 'draft', 'submitting')
     RETURNING *`,
    [rowId, payload],
  )).rows[0] || null;
  if (claimed) return { claimed: true, row: claimed };
  const existing = await loadTransferById(client, rowId);
  return { claimed: false, row: existing };
}

export async function persistProviderOutcome(client, {
  rowId,
  status,
  providerTransferId,
  failureClass = null,
  lastError = null,
  providerPayload = null,
}) {
  const payload = JSON.stringify(sanitizeAuditDetails({
    provider_http_attempted: true,
    phase: 'provider_outcome',
    failure_class: failureClass,
    response_keys: providerPayload && typeof providerPayload === 'object'
      ? Object.keys(providerPayload).slice(0, 40)
      : [],
  }));
  return (await client.query(
    `UPDATE public.payment_transfers
     SET status = $2,
         provider_status = COALESCE($3, provider_status),
         provider_transfer_id = COALESCE($4, provider_transfer_id),
         submitted_at = CASE WHEN $4 IS NOT NULL THEN COALESCE(submitted_at, now()) ELSE submitted_at END,
         failure_class = COALESCE($5, failure_class),
         last_error = COALESCE($6, last_error),
         provider_metadata = COALESCE(provider_metadata, '{}'::jsonb) || $7::jsonb,
         updated_at = now()
     WHERE id = $1::uuid AND environment = 'production'
     RETURNING *`,
    [rowId, status, status, providerTransferId, failureClass, lastError, payload],
  )).rows[0];
}

export async function persistPollOutcome(client, {
  rowId,
  status,
  providerTransferId,
  providerPayload = null,
}) {
  const payload = JSON.stringify(sanitizeAuditDetails({
    last_poll: {
      status,
      response_keys: providerPayload && typeof providerPayload === 'object'
        ? Object.keys(providerPayload).slice(0, 40)
        : [],
    },
  }));
  return (await client.query(
    `UPDATE public.payment_transfers
     SET status = COALESCE($2, status),
         provider_status = COALESCE($3, provider_status),
         provider_transfer_id = COALESCE($4, provider_transfer_id),
         completed_at = CASE WHEN $2 = 'completed' THEN COALESCE(completed_at, now()) ELSE completed_at END,
         provider_metadata = COALESCE(provider_metadata, '{}'::jsonb) || $5::jsonb,
         updated_at = now()
     WHERE id = $1::uuid AND environment = 'production'
     RETURNING *`,
    [rowId, status, status, providerTransferId, payload],
  )).rows[0];
}

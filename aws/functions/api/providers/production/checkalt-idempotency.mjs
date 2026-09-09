import { APP_USER_EMAIL_GUC, APP_USER_ID_GUC } from '../../cognito.mjs';
import { financialPermissionsActivated } from '../../financial-flags.mjs';
import { replaySafeResponse, stableIdempotencyKey } from '../../financial-idempotency.mjs';
import { sanitizeAuditDetails } from '../../financial-audit.mjs';

export const checkAltIdempotencyKey = ({ tenantId, checkId, amountCents }) =>
  stableIdempotencyKey({
    tenantId,
    operationType: 'checkalt_deposit',
    resourceId: checkId,
    amountCents,
    currency: 'USD',
  });

export async function bindCheckAltProductionGucs(client, mapping, claims) {
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

/**
 * Commit the current write so a later HTTP/Lambda failure cannot erase the
 * durable attempt. Opens a new transaction and rebinds identity GUCs.
 */
export async function commitDurableAttempt(client, mapping, claims) {
  await client.query('COMMIT');
  await client.query('BEGIN');
  await client.query('SET TRANSACTION READ WRITE');
  await bindCheckAltProductionGucs(client, mapping, claims);
}

const TERMINAL_REPLAY = new Set([
  'submitted',
  'pending_approval',
  'cleared',
  'rejected',
  'returned',
  'duplicate',
]);

export const rowHasProviderHttpAttempt = (row) => (
  Boolean(row?.provider_http_attempted_at)
  || Boolean(row?.last_status_payload?.provider_http_attempted)
  || Boolean(row?.checkalt_reference)
);

const PROVIDER_MAY_HAVE_OCCURRED = new Set([
  ...TERMINAL_REPLAY,
  'submitting',
  'pending',
  'error',
]);

export const isLegacyDepositRow = (row) => Boolean(row) && (row.idempotency_key == null || row.idempotency_key === '');

export const shouldReconcileInsteadOfPost = (row) => {
  if (!row) return false;
  if (row.checkalt_reference) return true;
  if (TERMINAL_REPLAY.has(String(row.status || ''))) return true;
  if (rowHasProviderHttpAttempt(row) && ['queued', 'pending', 'submitting', 'error'].includes(String(row.status || ''))) {
    return true;
  }
  return false;
};

export const shouldBlockNewProcessPost = (row) => {
  if (!row) return false;
  if (shouldReconcileInsteadOfPost(row)) return true;
  if (PROVIDER_MAY_HAVE_OCCURRED.has(String(row.status || ''))) return true;
  if (isLegacyDepositRow(row)) return true;
  return false;
};

export const pickBlockingDeposit = (rows = []) => {
  const list = (rows || []).filter(Boolean);
  return list.find((row) => row.checkalt_reference)
    || list.find((row) => rowHasProviderHttpAttempt(row))
    || list.find((row) => shouldBlockNewProcessPost(row))
    || null;
};

export async function loadDepositsForCheck(client, { tenantId, checkId } = {}) {
  if (!tenantId || !checkId) return [];
  return (await client.query(
    `SELECT id, tenant_id, check_intake_item_id, checkalt_reference, status, amount, amount_cents,
            idempotency_key, provider_http_attempted_at, failure_class, last_status_payload,
            last_error, submitted_at, cleared_at, returned_at, last_polled_at, submitted_by,
            created_at, updated_at
     FROM public.checkalt_deposits
     WHERE tenant_id = $1::uuid AND check_intake_item_id = $2::uuid
     ORDER BY created_at ASC NULLS LAST, id ASC`,
    [tenantId, checkId],
  )).rows;
}

export const replayDepositResponse = (row, extra = {}) => replaySafeResponse({
  id: row.id,
  tenant_id: row.tenant_id,
  status: row.status,
  provider_reference: row.checkalt_reference,
  amount_cents: row.amount_cents,
  idempotency_key: row.idempotency_key,
}, {
  provider: 'checkalt',
  deposit_id: row.id,
  checkalt_reference: row.checkalt_reference,
  status: row.status,
  liveProviderCalled: false,
  productionRecordsMutated: true,
  reconciled: extra.reconciled === true,
  message: extra.message || 'Existing CheckAlt deposit reused. A second FinCapture POST was not sent.',
  ...extra,
});

export async function loadDepositByIdempotency(client, { tenantId, idempotencyKey }) {
  return (await client.query(
    `SELECT id, tenant_id, check_intake_item_id, checkalt_reference, status, amount, amount_cents,
            idempotency_key, provider_http_attempted_at, failure_class, last_status_payload,
            last_error, submitted_at, cleared_at, returned_at, last_polled_at, submitted_by,
            created_at, updated_at
     FROM public.checkalt_deposits
     WHERE tenant_id = $1::uuid AND idempotency_key = $2
     LIMIT 1`,
    [tenantId, idempotencyKey],
  )).rows[0] || null;
}

export async function insertQueuedDeposit(client, {
  check,
  mapping,
  amountCents,
  idempotencyKey,
}) {
  try {
    const row = (await client.query(
      `INSERT INTO public.checkalt_deposits (
         check_intake_item_id, tenant_id, amount, amount_cents, status, submitted_by,
         idempotency_key, last_status_payload
       ) VALUES (
         $1::uuid, $2::uuid, $3, $4, 'queued', $5::uuid, $6, $7::jsonb
       )
       RETURNING *`,
      [
        check.id,
        check.tenant_id,
        check.amount,
        amountCents,
        mapping.application_user_id,
        idempotencyKey,
        JSON.stringify(sanitizeAuditDetails({
          phase: 'queued_before_http',
          scale: 'integer_cents',
          amount_cents: amountCents,
          provider_http_attempted: false,
        })),
      ],
    )).rows[0];
    return { ok: true, row, inserted: true };
  } catch (error) {
    if (error?.code === '23505') {
      const existing = await loadDepositByIdempotency(client, {
        tenantId: check.tenant_id,
        idempotencyKey,
      });
      if (existing) return { ok: true, row: existing, inserted: false, duplicate: true };
    }
    return {
      ok: false,
      statusCode: 503,
      error: 'idempotency_persist_failed',
      liveProviderCalled: false,
      message: 'Could not persist the CheckAlt attempt record before provider HTTP. Fail closed.',
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
    `UPDATE public.checkalt_deposits
     SET status = 'submitting',
         provider_http_attempted_at = now(),
         last_status_payload = COALESCE(last_status_payload, '{}'::jsonb) || $2::jsonb,
         updated_at = now()
     WHERE id = $1::uuid
       AND provider_http_attempted_at IS NULL
       AND checkalt_reference IS NULL
       AND status IN ('queued', 'pending', 'submitting')
     RETURNING *`,
    [rowId, payload],
  )).rows[0] || null;
  if (claimed) return { claimed: true, row: claimed };
  const existing = (await client.query(
    `SELECT * FROM public.checkalt_deposits WHERE id = $1::uuid LIMIT 1`,
    [rowId],
  )).rows[0] || null;
  return { claimed: false, row: existing };
}

export async function persistProviderOutcome(client, {
  rowId,
  status,
  reference,
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
    status_code: providerPayload?.status ?? providerPayload?.statusCode ?? null,
  }));
  return (await client.query(
    `UPDATE public.checkalt_deposits
     SET status = $2,
         checkalt_reference = COALESCE($3, checkalt_reference),
         submitted_at = CASE WHEN $3 IS NOT NULL THEN COALESCE(submitted_at, now()) ELSE submitted_at END,
         failure_class = COALESCE($4, failure_class),
         last_error = COALESCE($5, last_error),
         last_status_payload = COALESCE(last_status_payload, '{}'::jsonb) || $6::jsonb,
         updated_at = now()
     WHERE id = $1::uuid
     RETURNING *`,
    [rowId, status, reference, failureClass, lastError, payload],
  )).rows[0];
}

export async function persistPollOutcome(client, {
  rowId,
  status,
  reference,
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
    `UPDATE public.checkalt_deposits
     SET status = COALESCE($2, status),
         checkalt_reference = COALESCE($3, checkalt_reference),
         last_polled_at = now(),
         cleared_at = CASE WHEN $2 = 'cleared' THEN COALESCE(cleared_at, now()) ELSE cleared_at END,
         returned_at = CASE WHEN $2 = 'returned' THEN COALESCE(returned_at, now()) ELSE returned_at END,
         last_status_payload = COALESCE(last_status_payload, '{}'::jsonb) || $4::jsonb,
         updated_at = now()
     WHERE id = $1::uuid
     RETURNING *`,
    [rowId, status, reference, payload],
  )).rows[0];
}

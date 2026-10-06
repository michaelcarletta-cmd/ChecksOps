/**
 * Tenant Collection V2 settlement synchronization.
 *
 * Routes authoritative Moov terminal status through applyBillingProviderEvent.
 * Does not create Moov transfers, post ledger, or treat due+transfer-id as settled.
 */
import {
  COLLECTION_CONTRACT_ID,
  COLLECTION_STATUS,
  FAILED_STATUSES,
  IN_FLIGHT_STATUSES,
  SETTLED_STATUSES,
  classifyCollectionStatus,
  receivedCentsFromLegs,
} from './tenant-collection-v2.mjs';

export const COLLECTION_V2_COMPLETION_EVENT = 'collection_v2.completed';
export const CHECKSOPS_KIND_MONTHLY = 'monthly_subscription';

const TERMINAL_SETTLED = new Set(['settled']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const asIso = (value) => {
  if (value == null || value === '') return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
};

const dataOf = (payload) => payload?.data ?? payload ?? {};

export const mapProviderStatusToBilling = (status) => {
  const normalized = String(status || '').toLowerCase();
  if (!normalized) return null;
  if (normalized.includes('return') || normalized.includes('revers')) return 'returned';
  if (normalized.includes('fail') || normalized.includes('cancel')) return 'failed';
  if (normalized.includes('complete') || normalized.includes('settled') || normalized.includes('succeed')) {
    return 'settled';
  }
  return null;
};

export const extractProviderTransferId = (payload = {}) => {
  const data = dataOf(payload);
  return String(
    data.transferID
    || data.transferId
    || payload.transferID
    || payload.transferId
    || payload.provider_transfer_id
    || '',
  ).trim();
};

export const extractProviderStatus = (payload = {}) => {
  const data = dataOf(payload);
  const direct = data.status || payload.status || payload.provider_status || '';
  if (direct) return String(direct);
  const eventType = String(payload.type || payload.eventType || '');
  if (eventType.includes('completed')) return 'completed';
  if (eventType.includes('failed')) return 'failed';
  if (eventType.includes('returned') || eventType.includes('reversed')) return 'returned';
  if (eventType.includes('canceled') || eventType.includes('cancelled')) return 'canceled';
  return '';
};

export const providerCompletionTimestamp = (payload = {}) => {
  const data = dataOf(payload);
  return asIso(
    data.completedOn
    || data.completed_on
    || data.settledOn
    || data.settled_on
    || payload.completedOn
    || payload.completed_at
    || payload.settled_at
    || null,
  );
};

export const obligationStatusAfterSubmit = ({ collected = {}, occurrence = {} } = {}) => {
  if (collected.obligation_status) return collected.obligation_status;
  if (!collected.ok) return 'failed';
  const amountDue = Number(occurrence.amount_cents || collected.amount_due_cents || 0);
  const received = Number(collected.amount_received_cents || 0);
  if (collected.collection_status === COLLECTION_STATUS.PAID && received >= amountDue && amountDue > 0) {
    return 'settled';
  }
  const legs = collected.legs || [];
  const hasTransfer = legs.some((leg) => String(leg.provider_transfer_id || '').trim());
  const inFlight = legs.some((leg) => (
    IN_FLIGHT_STATUSES.has(String(leg.provider_status || leg.status || '').toLowerCase())
  ));
  if (hasTransfer || inFlight) return 'submitted';
  return collected.ok ? 'submitted' : 'due';
};

export const isCollectionV2Obligation = (row = {}) => {
  const kind = String(row.occurrence_kind || row.checksops_kind || '').toLowerCase();
  if (kind === CHECKSOPS_KIND_MONTHLY) return true;
  const notes = String(row.notes || row.collection_notes || '');
  if (notes.includes('collection_v2') || notes.includes(COLLECTION_CONTRACT_ID)) return true;
  const meta = row.provider_metadata && typeof row.provider_metadata === 'object' ? row.provider_metadata : {};
  return meta.collection_contract === COLLECTION_CONTRACT_ID
    || meta.checksops_kind === CHECKSOPS_KIND_MONTHLY;
};

export const isCollectionV2Leg = (row = {}) => {
  const meta = row.provider_metadata && typeof row.provider_metadata === 'object' ? row.provider_metadata : {};
  return meta.collection_contract === COLLECTION_CONTRACT_ID
    || meta.checksops_kind === CHECKSOPS_KIND_MONTHLY;
};

export const planHistoricalCollectionV2Reconcile = (obligation = {}) => {
  const providerTransferId = String(obligation.provider_transfer_id || '').trim();
  if (!providerTransferId) {
    return { ok: false, action: 'none', reason: 'no_provider_transfer_id' };
  }
  if (TERMINAL_SETTLED.has(String(obligation.status || '').toLowerCase())) {
    return { ok: true, action: 'noop_already_settled', provider_transfer_id: providerTransferId };
  }
  return {
    ok: true,
    action: 'read_provider_then_apply',
    provider_transfer_id: providerTransferId,
    forbidden: 'due+provider_transfer_id must not become settled without provider confirmation',
  };
};

const environmentsCompatible = (left, right) => {
  const a = String(left || '').toLowerCase();
  const b = String(right || '').toLowerCase();
  if (!a || !b) return true;
  return a === b;
};

const lookupObligation = async (client, { providerTransferId, collectionLeg }) => {
  const byTransfer = (await client.query(
    `SELECT * FROM public.tenant_maintenance_payments
     WHERE provider_transfer_id = $1
     LIMIT 1`,
    [providerTransferId],
  ).catch(() => ({ rows: [] }))).rows[0];
  if (byTransfer) return byTransfer;

  const obligationId = collectionLeg?.provider_metadata?.obligation_id
    || collectionLeg?.provider_metadata?.checksops_payment_id
    || '';
  if (UUID_RE.test(String(obligationId))) {
    const byId = (await client.query(
      `SELECT * FROM public.tenant_maintenance_payments WHERE id = $1::uuid LIMIT 1`,
      [obligationId],
    ).catch(() => ({ rows: [] }))).rows[0];
    if (byId) return byId;
  }

  return (await client.query(
    `SELECT * FROM public.tenant_maintenance_payments
     WHERE notes LIKE $1
     LIMIT 1`,
    [`%${providerTransferId}%`],
  ).catch(() => ({ rows: [] }))).rows[0] || null;
};

const persistCompletionEvent = async (client, {
  occurrence,
  providerTransferId,
  mapped,
  previousStatus,
  environment,
  collectionLeg,
  metadata = {},
}) => {
  const existing = (await client.query(
    `SELECT id FROM public.payment_event_log
     WHERE provider_transfer_id = $1
       AND event_type = $2
       AND new_status = $3
     LIMIT 1`,
    [providerTransferId, COLLECTION_V2_COMPLETION_EVENT, mapped],
  ).catch(() => ({ rows: [] }))).rows[0];
  if (existing) return { written: false, duplicate: true, id: existing.id };

  const inserted = (await client.query(
    `INSERT INTO public.payment_event_log
       (provider, environment, tenant_id, transfer_id, provider_transfer_id,
        event_type, previous_status, new_status, provider_metadata)
     VALUES ('moov', $1, $2::uuid, $3::uuid, $4, $5, $6, $7, $8::jsonb)
     RETURNING id`,
    [
      environment || occurrence.provider_environment || 'production',
      occurrence.tenant_id,
      collectionLeg?.id || null,
      providerTransferId,
      COLLECTION_V2_COMPLETION_EVENT,
      previousStatus || null,
      mapped,
      JSON.stringify({
        collection_contract: COLLECTION_CONTRACT_ID,
        checksops_kind: occurrence.occurrence_kind || CHECKSOPS_KIND_MONTHLY,
        checksops_payment_id: occurrence.id,
        checksops_period: occurrence.billing_period || null,
        amount_cents: occurrence.amount_cents,
        ...metadata,
      }),
    ],
  ).catch(() => ({ rows: [] }))).rows[0];
  return { written: Boolean(inserted?.id), duplicate: false, id: inserted?.id || null };
};

/**
 * Existing Collection V2 settlement contract.
 * Terminal provider status only. Never infers settled from a transfer id alone.
 */
export async function applyBillingProviderEvent(client, {
  providerTransferId,
  status,
  reason = null,
  completedAt = null,
  environment = null,
  metadata = {},
} = {}) {
  if (!providerTransferId) return { applied: false, skipped: 'no_transfer_id' };
  const normalized = String(status || '').toLowerCase();
  const mapped = mapProviderStatusToBilling(normalized);
  if (!mapped) return { applied: false, skipped: 'unmapped_status', status: normalized };

  const collectionLeg = (await client.query(
    `SELECT * FROM public.payment_transfers
     WHERE provider_transfer_id = $1
     LIMIT 1`,
    [providerTransferId],
  ).catch(() => ({ rows: [] }))).rows[0] || null;

  if (collectionLeg && !isCollectionV2Leg(collectionLeg)) {
    const maybeObligation = await lookupObligation(client, { providerTransferId, collectionLeg: null });
    if (!maybeObligation) {
      return { applied: false, skipped: 'unrelated_transfer', transfer_id: collectionLeg.id };
    }
  }

  if (collectionLeg && mapped) {
    const settledAt = asIso(completedAt);
    await client.query(
      `UPDATE public.payment_transfers SET
         status = $2,
         provider_status = $3,
         completed_at = CASE
           WHEN $2 = 'settled' THEN COALESCE(completed_at, $5::timestamptz, now())
           ELSE completed_at
         END,
         failure_reason = CASE WHEN $2 IN ('failed','returned') THEN COALESCE($4, failure_reason) ELSE failure_reason END,
         updated_at = now()
       WHERE id = $1::uuid`,
      [collectionLeg.id, mapped, normalized, reason, settledAt],
    ).catch(() => {});
  }

  const existing = await lookupObligation(client, { providerTransferId, collectionLeg });
  if (!existing) return { applied: false, skipped: 'no_billing_occurrence' };
  if (!isCollectionV2Obligation(existing)) {
    return { applied: false, skipped: 'not_collection_v2', occurrence: existing };
  }
  if (!environmentsCompatible(environment, existing.provider_environment)) {
    return { applied: false, skipped: 'environment_mismatch', occurrence: existing };
  }
  if (existing.status === 'returned' && mapped !== 'returned') {
    return { applied: false, skipped: 'already_returned', occurrence: existing };
  }
  if (existing.status === 'settled' && mapped === 'settled') {
    const event = await persistCompletionEvent(client, {
      occurrence: existing,
      providerTransferId,
      mapped,
      previousStatus: existing.status,
      environment: environment || existing.provider_environment,
      collectionLeg,
      metadata,
    });
    return {
      applied: true,
      duplicate: true,
      occurrence: existing,
      previous: existing.status,
      collection_leg: collectionLeg,
      event,
    };
  }
  if (existing.status === 'settled' && mapped === 'failed') {
    return { applied: false, skipped: 'already_settled', occurrence: existing };
  }

  let nextStatus = mapped;
  if (collectionLeg) {
    const siblingLegs = (await client.query(
      `SELECT * FROM public.payment_transfers
       WHERE provider_metadata->>'obligation_id' = $1`,
      [String(existing.id)],
    ).catch(() => ({ rows: [] }))).rows.map((row) => ({
      ...row,
      leg_type: row.provider_metadata?.leg_type || row.leg_role,
    }));
    const received = receivedCentsFromLegs(siblingLegs);
    const collectionStatus = classifyCollectionStatus({
      amountDueCents: existing.amount_cents,
      legs: siblingLegs,
    });
    nextStatus = received >= Number(existing.amount_cents || 0)
      ? 'settled'
      : collectionStatus === COLLECTION_STATUS.RECONCILIATION_REQUIRED
        ? 'failed'
        : siblingLegs.some((row) => IN_FLIGHT_STATUSES.has(String(row.status || '').toLowerCase()))
          ? 'submitted'
          : mapped;
  }

  if (FAILED_STATUSES.has(normalized) && nextStatus === 'settled') {
    nextStatus = mapped;
  }
  if (mapped !== 'settled' && nextStatus === 'settled' && !SETTLED_STATUSES.has(normalized)) {
    nextStatus = mapped;
  }

  const settledAt = nextStatus === 'settled' ? (asIso(completedAt) || null) : null;
  const saved = (await client.query(
    `UPDATE public.tenant_maintenance_payments SET
       status = $2,
       settled_at = CASE
         WHEN $2 = 'settled' THEN COALESCE(settled_at, $4::timestamptz, now())
         ELSE settled_at
       END,
       returned_at = CASE WHEN $2 = 'returned' THEN COALESCE(returned_at, now()) ELSE returned_at END,
       return_reason = CASE WHEN $2 = 'returned' THEN COALESCE($3, return_reason) ELSE return_reason END,
       failure_reason = CASE WHEN $2 IN ('failed','returned') THEN COALESCE($3, failure_reason) ELSE failure_reason END
     WHERE id = $1::uuid
     RETURNING *`,
    [existing.id, nextStatus, reason, settledAt],
  )).rows[0];

  const event = await persistCompletionEvent(client, {
    occurrence: saved || existing,
    providerTransferId,
    mapped: nextStatus,
    previousStatus: existing.status,
    environment: environment || existing.provider_environment,
    collectionLeg,
    metadata,
  });

  return {
    applied: true,
    duplicate: false,
    occurrence: saved,
    previous: existing.status,
    collection_leg: collectionLeg,
    event,
    productionRecordsMutated: String(saved?.provider_environment || environment || '') === 'production',
  };
}

export async function applyCollectionV2ProviderCompletion(client, payload = {}, { dryRun = false } = {}) {
  const providerTransferId = extractProviderTransferId(payload);
  if (!providerTransferId) return { applied: false, skipped: 'no_transfer_id' };
  const status = extractProviderStatus(payload);
  const mapped = mapProviderStatusToBilling(status);
  if (!mapped) return { applied: false, skipped: 'unmapped_status', status };
  if (dryRun) return { applied: false, skipped: 'dry_run', provider_transfer_id: providerTransferId, mapped };

  const accountId = payload.accountID || payload.accountId || dataOf(payload).accountID || null;
  let environment = null;
  if (accountId) {
    const account = (await client.query(
      `SELECT environment FROM public.payment_provider_accounts
       WHERE provider = 'moov' AND provider_account_id = $1
       LIMIT 1`,
      [String(accountId)],
    ).catch(() => ({ rows: [] }))).rows[0];
    environment = account?.environment || null;
  }

  return applyBillingProviderEvent(client, {
    providerTransferId,
    status,
    reason: payload.type || payload.eventType || 'provider_webhook',
    completedAt: providerCompletionTimestamp(payload),
    environment,
    metadata: {
      provider_status: status,
      event_type: payload.type || payload.eventType || null,
    },
  });
}

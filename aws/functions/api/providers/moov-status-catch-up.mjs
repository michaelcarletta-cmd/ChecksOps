/**
 * Moov status catch-up: what the transfer.* webhooks would have written, read back from Moov.
 *
 * Production has received no transfer.* webhook (aws_provider_webhook_receipts holds two Moov
 * receipts ever, event.test and balance.updated), so payment_transfers legs and tenant fee
 * obligations whose Moov transfer finished stayed at the status they had when they were
 * created. This module catches that history up, one Moov transfer at a time, through the code
 * the webhook route already runs (providers/webhooks.mjs):
 *
 *   1. read the transfer back from Moov (GET only): confirmMoovWebhookPayload
 *      (moov-webhook-confirm.mjs) with the hint { type: 'transfer.updated', data: { transferID } },
 *      which is the read the webhook does and builds the same trusted payload from Moov's record;
 *   2. apply that trusted payload with applyProductionMoovTransferWebhook
 *      (moov-transfer-webhook.mjs, the SQL 109 writer: wallet_funding / send_wallet / send_bank
 *      legs) and applyCollectionV2ProviderCompletion (tenant-collection-v2-settlement.mjs: the
 *      tenant fee legs and their obligation), in that order, as the webhook does.
 *
 * Nothing is written from a guess: a row changes only from Moov's own read-back, and only to
 * the outcome the reviewed plan showed.
 *
 * Two phases, one direct Lambda invocation each (no HTTP route; see isMoovStatusCatchUpInvocation):
 *
 *   plan   read-only. The candidates are read inside BEGIN READ ONLY (transaction_read_only
 *          checked), the transaction ends, then each transfer is read from Moov. For every
 *          candidate it reports the database status, Moov's status and amount, and the change
 *          the apply functions would make (predicted with their own pure helpers). It prints a
 *          manifest and its sha256. It writes nothing.
 *   apply  only with the owner's approval statement (verbatim) and the plan's manifest_sha256
 *          and transfer ids. It plans again; if the new manifest's hash differs (the database or
 *          Moov moved since the reviewed plan) or the ids differ, it refuses and writes nothing.
 *          Then, per transfer, one transaction: lock the rows (SQL 146's
 *          aws_moov_catch_up_lock_rows), re-check the planned pre-state, run the SQL 109 writer,
 *          write a fee collection leg's status (SQL 146's aws_moov_apply_collection_leg_status)
 *          and run the settlement code, re-read the rows and require exactly the planned
 *          post-state, COMMIT. Anything else rolls that transaction back and stops the run.
 *          Idempotent: an applied transfer is no longer a candidate, the SQL 109 writer records
 *          the catch-up event id once, and an old manifest hash no longer matches.
 *
 * Deliberate differences from a webhook delivery, all narrower:
 *   - no aws_provider_webhook_receipts row (no webhook was delivered; the receipts table records
 *     deliveries only);
 *   - a transfer Moov has not finished (created, queued, pending) is reported and left alone;
 *   - an amount that differs from Moov's is refused, and so is a transfer Moov cannot find;
 *   - reads and writes run as one reviewed platform-owner actor (request.app_user_id, refused
 *     unless public.is_platform_owner() is true for it), as the scheduled Check Alt status job
 *     does, because the payment tables are under row security and the webhook has no user.
 *
 * Why SQL 146: the platform owner reads every tenant's payment rows (SELECT policies), but is not
 * a member of those tenants, and payment_transfers' UPDATE policies are membership-only since
 * SQL 90. PostgreSQL applies them to SELECT ... FOR UPDATE too, so a plain lock returned no row
 * (production run 42395949680: catch_up_state_changed_since_plan, found {legs: {}}), and the
 * settlement code's own UPDATE of a fee leg finds no row. SQL 146's two SECURITY DEFINER
 * functions lock the rows and write the fee leg, only for the platform owner (or no user) in the
 * Moov webhook apply context (request.provider_webhook_apply = '1', SQL 91), which this module
 * sets around them and around the settlement code, whose payment_event_log row needs it (SQL 91's
 * aws_webhook_insert_payment_event_log), and clears again. Funding and send legs keep SQL 109's
 * writer. Until SQL 146 is applied the lock call fails and the transfer rolls back.
 *
 * Output: ids, statuses, cents and ACH codes only. Never a secret, an account or routing number,
 * a payment method id, a Moov account id, notes or a hostname.
 */
import { createHash } from 'node:crypto';
import pg from 'pg';
import { buildClientConfig, buildWriteClientConfig } from '../db-health.mjs';
import { loadDatabaseCredentials } from '../secrets.mjs';
import { loadProviderSecrets } from '../provider-secrets.mjs';
import { providerWebhookDryRun } from '../provider-flags.mjs';
import { billingEnvironment, isProductionChecksOpsRuntime } from '../tenant-billing-destination.mjs';
import {
  COLLECTION_STATUS,
  FAILED_STATUSES,
  IN_FLIGHT_STATUSES,
  SETTLED_STATUSES,
  classifyCollectionStatus,
  receivedCentsFromLegs,
} from '../tenant-collection-v2.mjs';
import {
  applyCollectionV2ProviderCompletion,
  extractProviderStatus,
  isCollectionV2Leg,
  isCollectionV2Obligation,
  mapProviderStatusToBilling,
  providerCompletionTimestamp,
} from '../tenant-collection-v2-settlement.mjs';
import { MoovConfirmationRetry, confirmMoovWebhookPayload } from './moov-webhook-confirm.mjs';
import {
  applyProductionMoovTransferWebhook,
  interpretMoovTransferEvent,
  productionTransferWebhookApplyEnabled,
} from './moov-transfer-webhook.mjs';

const { Client } = pg;

export const CATCH_UP_OPERATION = 'moov-status-catch-up';
export const CATCH_UP_PATH = `/scheduled/${CATCH_UP_OPERATION}`;
export const CATCH_UP_EVENT_TYPE = 'transfer.updated';
export const CATCH_UP_EVENT_ID_PREFIX = 'moov-status-catch-up';
/** The owner's words that start a plan; an apply statement equal to them is refused. */
export const CATCH_UP_PLAN_STATEMENT = 'run the read-only Moov catch-up plan';
export const CATCH_UP_DEFAULT_LIMIT = 50;
export const CATCH_UP_MAX_LIMIT = 200;

/** Event keys a direct invocation may carry. Anything else is refused. */
export const CATCH_UP_EVENT_KEYS = Object.freeze([
  'checksops_operator', 'rawPath', 'requestContext', 'phase', 'actor_application_user_id',
  'limit', 'approval_statement', 'manifest_sha256', 'transfer_ids',
]);

/** Legs the SQL 109 writer owns (it answers not_owned for every other leg_role). */
export const SQL109_OWNED_LEG_ROLES = Object.freeze(['wallet_funding', 'send_wallet', 'send_bank', 'wallet_withdrawal']);
/** payment_transfers statuses that are final: never a candidate. */
export const TERMINAL_LEG_STATUSES = Object.freeze([
  'completed', 'settled', 'failed', 'canceled', 'cancelled', 'returned', 'reversed',
]);
/** ChecksOps statuses (interpretMoovTransferEvent) that mean Moov finished the transfer. */
const MOOV_FINAL = new Set(['completed', 'failed', 'returned', 'canceled']);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TRANSFER_ID_RE = /^[A-Za-z0-9_-]{1,120}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

// ------------------------------------------------------------------ SQL (all reads are narrow)

/** Candidate legs: Moov, this environment, a provider transfer id, not final. */
export const CANDIDATE_LEGS_SQL = `SELECT id, tenant_id, leg_role, status, provider_status, amount_cents,
       provider_transfer_id, provider_metadata->>'obligation_id' AS obligation_id,
       provider_metadata->>'collection_contract' AS collection_contract,
       provider_metadata->>'checksops_kind' AS checksops_kind,
       provider_metadata->>'leg_type' AS leg_type, created_at
  FROM public.payment_transfers /* moov_status_catch_up_legs */
 WHERE provider = 'moov'
   AND environment = $1
   AND NULLIF(btrim(COALESCE(provider_transfer_id, '')), '') IS NOT NULL
   AND status <> ALL ($2::text[])
 ORDER BY created_at ASC, id ASC
 LIMIT $3`;

/** Candidate fee obligations: a provider transfer id, not settled, this environment or none. */
export const CANDIDATE_OBLIGATIONS_SQL = `SELECT id, tenant_id, status, amount_cents, provider_transfer_id,
       provider_environment, occurrence_kind, billing_period, created_at
  FROM public.tenant_maintenance_payments /* moov_status_catch_up_obligations */
 WHERE NULLIF(btrim(COALESCE(provider_transfer_id, '')), '') IS NOT NULL
   AND status <> 'settled'
   AND (provider_environment IS NULL OR provider_environment = $1)
 ORDER BY created_at ASC, id ASC
 LIMIT $2`;

/** Every leg (any status) of the candidate transfer ids, and the legs of the candidate obligations. */
export const RELATED_LEGS_SQL = `SELECT id, tenant_id, leg_role, status, provider_status, amount_cents,
       provider_transfer_id, provider_metadata->>'obligation_id' AS obligation_id,
       provider_metadata->>'collection_contract' AS collection_contract,
       provider_metadata->>'checksops_kind' AS checksops_kind,
       provider_metadata->>'leg_type' AS leg_type
  FROM public.payment_transfers /* moov_status_catch_up_related_legs */
 WHERE provider = 'moov'
   AND environment = $1
   AND (provider_transfer_id = ANY ($2::text[]) OR provider_metadata->>'obligation_id' = ANY ($3::text[]))`;

/** Obligations named by a candidate transfer id, or by a candidate leg's obligation_id. */
export const RELATED_OBLIGATIONS_SQL = `SELECT id, tenant_id, status, amount_cents, provider_transfer_id,
       provider_environment, occurrence_kind, billing_period
  FROM public.tenant_maintenance_payments /* moov_status_catch_up_related_obligations */
 WHERE provider_transfer_id = ANY ($1::text[]) OR id::text = ANY ($2::text[])`;

/**
 * The apply's row lock (SQL 146, SECURITY DEFINER): this transfer's legs and the named obligations, FOR UPDATE, as
 * {legs: {id: status}, obligations: {id: status}}. A plain SELECT ... FOR UPDATE here returned no row for the platform
 * owner (PostgreSQL applies the UPDATE policies to it, and payment_transfers' are membership-only since SQL 90;
 * production run 42395949680). Only the platform owner, in the webhook apply context.
 */
export const LOCK_ROWS_SQL = 'SELECT public.aws_moov_catch_up_lock_rows($1, $2, $3::uuid[]) AS locked';
/**
 * A tenant fee collection leg's Moov status (SQL 146, SECURITY DEFINER): the UPDATE applyBillingProviderEvent makes,
 * for the row with this transfer id and Moov's confirmed amount, never backwards. The settlement code's own UPDATE
 * finds no row for the platform owner (the same UPDATE policies), so the catch-up writes the leg first.
 */
export const COLLECTION_LEG_STATUS_SQL = `SELECT public.aws_moov_apply_collection_leg_status(
  $1, $2, $3::bigint, $4, $5, $6, $7::timestamptz) AS result`;
export const READ_LEGS_SQL = `SELECT id, status FROM public.payment_transfers /* moov_status_catch_up_verify */
 WHERE provider = 'moov' AND environment = $1 AND provider_transfer_id = $2
 ORDER BY id`;
export const READ_OBLIGATIONS_SQL = `SELECT id, status FROM public.tenant_maintenance_payments /* moov_status_catch_up_verify */
 WHERE id::text = ANY ($1::text[])
 ORDER BY id`;

export const BIND_ACTOR_SQL = "SELECT set_config('request.app_user_id', $1, true)";
export const PLATFORM_OWNER_SQL = 'SELECT public.is_platform_owner() AS ok';
export const READ_ONLY_PROBE_SQL = "SELECT current_setting('transaction_read_only') AS transaction_read_only";
export const WEBHOOK_GUC_SQL = "SELECT set_config('request.provider_webhook', '1', true)";
/** The Moov webhook apply context (SQL 91), which SQL 146's functions and the event log's webhook INSERT policy ask for. */
export const WEBHOOK_APPLY_ON_SQL = "SELECT set_config('request.provider_webhook_apply', '1', true)";
export const WEBHOOK_APPLY_OFF_SQL = "SELECT set_config('request.provider_webhook_apply', '0', true)";

// ------------------------------------------------------------------ pure helpers

const text = (value) => String(value ?? '').trim();
const lower = (value) => text(value).toLowerCase();
const cents = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
};

/** sha256 of the canonical JSON (object keys sorted at every level). */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}
export const sha256Hex = (value) => createHash('sha256').update(String(value), 'utf8').digest('hex');
export const manifestSha256 = (manifest) => sha256Hex(canonicalJson(manifest));

/** The SQL 109 writer's rank (aws/workflows/sql/109_moov_transfer_webhook_status.sql). */
export function sql109Rank(status) {
  switch (lower(status)) {
    case 'submitted': return 1;
    case 'pending': case 'processing': return 2;
    case 'completed': return 3;
    case 'failed': case 'canceled': return 4;
    case 'returned': return 5;
    default: return 0;
  }
}

/** The catch-up's event id for SQL 109: one per transfer and Moov status, so a re-run is a duplicate. */
export const catchUpEventId = (providerTransferId, providerStatus) => (
  `${CATCH_UP_EVENT_ID_PREFIX}:${providerTransferId}:${lower(providerStatus) || 'unknown'}`.slice(0, 200)
);

/** The hint the webhook confirm reads: only the transfer id and the event type. */
export const catchUpHint = (providerTransferId) => ({
  type: CATCH_UP_EVENT_TYPE,
  data: { transferID: providerTransferId },
});

/** What we keep from Moov's record: status, cents, ACH codes. No account or payment method ids. */
export function moovSummary(trusted) {
  const data = trusted?.data ?? {};
  const event = interpretMoovTransferEvent(trusted);
  const amount = data?.amount && typeof data.amount === 'object' ? data.amount : null;
  return {
    provider_status: event.providerStatus || null,
    status: event.status || null,
    amount_cents: cents(amount?.value),
    currency: amount?.currency ? text(amount.currency).slice(0, 8).toUpperCase() : null,
    return_code: event.returnCode || null,
    correction_code: event.correctionCode || null,
    completed_at: event.completedAt || null,
  };
}

const legView = (row) => ({
  id: String(row.id),
  tenant_id: row.tenant_id ? String(row.tenant_id) : null,
  leg_role: row.leg_role ? String(row.leg_role) : null,
  status: row.status ? String(row.status) : null,
  amount_cents: cents(row.amount_cents),
});

const obligationView = (row) => ({
  id: String(row.id),
  tenant_id: row.tenant_id ? String(row.tenant_id) : null,
  billing_period: row.billing_period ? String(row.billing_period).slice(0, 40) : null,
  status: row.status ? String(row.status) : null,
  amount_cents: cents(row.amount_cents),
});

/** The leg shape isCollectionV2Leg reads, from the flattened SELECT. */
const asSettlementLeg = (row) => ({
  ...row,
  provider_metadata: {
    obligation_id: row.obligation_id ?? undefined,
    collection_contract: row.collection_contract ?? undefined,
    checksops_kind: row.checksops_kind ?? undefined,
    leg_type: row.leg_type ?? undefined,
  },
});

/**
 * The obligation status applyBillingProviderEvent would write (tenant-collection-v2-settlement.mjs),
 * or null for no change. Pure; mirrors that function step for step on the rows the plan read.
 */
export function predictCollectionOutcome({ leg, obligation, siblings = [], providerStatus, environment }) {
  const normalized = lower(providerStatus);
  const mapped = mapProviderStatusToBilling(normalized);
  const none = (reason) => ({ leg_status: null, obligation_status: null, reason });
  if (!mapped) return none('unmapped_status');
  const collectionLeg = leg ? asSettlementLeg(leg) : null;
  if (collectionLeg && !isCollectionV2Leg(collectionLeg) && !obligation) return none('unrelated_transfer');
  const legStatus = collectionLeg ? mapped : null;
  if (!obligation) return { leg_status: legStatus, obligation_status: null, reason: 'no_billing_occurrence' };
  if (!isCollectionV2Obligation(obligation)) return { leg_status: legStatus, obligation_status: null, reason: 'not_collection_v2' };
  const a = lower(environment);
  const b = lower(obligation.provider_environment);
  if (a && b && a !== b) return { leg_status: legStatus, obligation_status: null, reason: 'environment_mismatch' };
  const current = String(obligation.status || '');
  if (current === 'returned' && mapped !== 'returned') return { leg_status: legStatus, obligation_status: null, reason: 'already_returned' };
  if (current === 'settled') return { leg_status: legStatus, obligation_status: null, reason: 'already_settled' };

  let next = mapped;
  if (collectionLeg) {
    const legs = siblings.map((row) => {
      const updated = String(row.id) === String(collectionLeg.id)
        ? { ...row, status: mapped, provider_status: normalized }
        : row;
      return { ...updated, leg_type: updated.leg_type || updated.leg_role };
    });
    const received = receivedCentsFromLegs(legs);
    const collectionStatus = classifyCollectionStatus({ amountDueCents: obligation.amount_cents, legs });
    next = received >= Number(obligation.amount_cents || 0)
      ? 'settled'
      : collectionStatus === COLLECTION_STATUS.RECONCILIATION_REQUIRED
        ? 'failed'
        : legs.some((row) => IN_FLIGHT_STATUSES.has(lower(row.status)))
          ? 'submitted'
          : mapped;
  }
  if (FAILED_STATUSES.has(normalized) && next === 'settled') next = mapped;
  if (mapped !== 'settled' && next === 'settled' && !SETTLED_STATUSES.has(normalized)) next = mapped;
  return {
    leg_status: legStatus,
    obligation_status: next === current ? null : next,
    reason: next === current ? 'unchanged' : 'applied',
  };
}

/**
 * One plan entry for one Moov transfer: the rows, Moov's record, and the change. Pure.
 * `moov` is { ok: true, payload } from the confirm, or { ok: false, skipped }.
 */
export function classifyCandidate({ providerTransferId, legs = [], obligations = [], siblingsByObligation = {}, moov, environment }) {
  const entry = {
    provider_transfer_id: providerTransferId,
    legs: legs.map(legView),
    obligations: obligations.map(obligationView),
    moov: null,
    action: 'skip',
    reason: null,
  };
  if (!moov?.ok) {
    entry.reason = moov?.skipped === 'moov_resource_not_found' ? 'moov_not_found' : (moov?.skipped || 'moov_unreadable');
    return entry;
  }
  const summary = moovSummary(moov.payload);
  entry.moov = summary;
  if (!summary.status) { entry.reason = 'unmapped_moov_status'; return entry; }
  if (!MOOV_FINAL.has(summary.status)) { entry.reason = 'moov_not_final'; return entry; }

  // Amounts: each leg with this transfer id, or the obligation when no leg names the transfer.
  if (summary.amount_cents === null) { entry.reason = 'moov_amount_missing'; return entry; }
  if (summary.currency && summary.currency !== 'USD') { entry.reason = 'moov_currency_not_usd'; return entry; }
  const compared = legs.length ? legs : obligations;
  if (!compared.length) { entry.reason = 'no_rows'; return entry; }
  if (compared.some((row) => cents(row.amount_cents) !== summary.amount_cents)) {
    entry.action = 'refuse';
    entry.reason = 'amount_mismatch';
    return entry;
  }
  if (legs.length > 1) { entry.action = 'refuse'; entry.reason = 'duplicate_legs'; return entry; }
  if (obligations.length > 1) { entry.action = 'refuse'; entry.reason = 'duplicate_obligations'; return entry; }

  const leg = legs[0] || null;
  const obligation = obligations[0] || null;
  const legView0 = entry.legs[0] || null;
  const obligationView0 = entry.obligations[0] || null;

  // 1. SQL 109 writer (owned legs only, never backwards).
  let legAfter = leg ? String(leg.status || '') : null;
  if (leg && TERMINAL_LEG_STATUSES.includes(lower(leg.status)) && !obligation) {
    entry.reason = 'already_terminal';
    return entry;
  }
  if (leg && SQL109_OWNED_LEG_ROLES.includes(String(leg.leg_role || ''))
      && sql109Rank(summary.status) > sql109Rank(leg.status)) {
    legAfter = summary.status;
  }
  // 2. Collection V2 (fee legs and the obligation), on the leg as SQL 109 left it.
  const collection = predictCollectionOutcome({
    leg: leg ? { ...leg, status: legAfter } : null,
    obligation,
    siblings: obligation ? (siblingsByObligation[String(obligation.id)] || []) : [],
    providerStatus: extractProviderStatus(moov.payload),
    environment,
  });
  if (collection.leg_status) legAfter = collection.leg_status;

  if (legView0) legView0.predicted_status = legAfter;
  if (obligationView0) obligationView0.predicted_status = collection.obligation_status || obligationView0.status;
  const legChanges = Boolean(legView0 && legView0.predicted_status !== legView0.status);
  const obligationChanges = Boolean(obligationView0 && obligationView0.predicted_status !== obligationView0.status);
  if (!legChanges && !obligationChanges) {
    entry.reason = leg && TERMINAL_LEG_STATUSES.includes(lower(leg.status)) ? 'already_terminal' : 'no_effect';
    return entry;
  }
  // Narrower than a webhook: a final row is never rewritten by the catch-up (applyBillingProviderEvent
  // updates the fee leg before it checks the obligation, so a returned leg could become settled).
  if ((legChanges && TERMINAL_LEG_STATUSES.includes(lower(leg.status)))
      || (obligationChanges && ['settled', 'returned'].includes(lower(obligation.status)))) {
    entry.action = 'refuse';
    entry.reason = 'terminal_row_would_change';
    return entry;
  }
  entry.action = 'apply';
  entry.reason = summary.status;
  return entry;
}

/** The manifest the owner reviews: everything apply re-checks, nothing volatile. */
export function buildCatchUpManifest({ environment, limit, entries }) {
  return {
    operation: CATCH_UP_OPERATION,
    environment,
    limit,
    entries: [...entries].sort((a, b) => a.provider_transfer_id.localeCompare(b.provider_transfer_id)),
  };
}

export const actionableTransferIds = (manifest) => manifest.entries
  .filter((entry) => entry.action === 'apply')
  .map((entry) => entry.provider_transfer_id)
  .sort();

export function summarizeEntries(entries) {
  const counts = { candidates: entries.length, apply: 0, skip: 0, refuse: 0, by_reason: {} };
  for (const entry of entries) {
    counts[entry.action] += 1;
    counts.by_reason[entry.reason] = (counts.by_reason[entry.reason] || 0) + 1;
  }
  return counts;
}

// ------------------------------------------------------------------ invocation shape

/**
 * A direct Lambda invocation of the catch-up (IAM lambda:InvokeFunction). An HTTP API request
 * can never look like this: API Gateway always builds the event itself (version, routeKey,
 * headers, requestContext.apiId / requestId / domainName / stage), and a caller cannot add
 * top-level fields. The rawPath routes it through the live /scheduled branch of index.mjs.
 */
export function isMoovStatusCatchUpInvocation(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return false;
  if (event.checksops_operator !== CATCH_UP_OPERATION) return false;
  if (event.rawPath !== CATCH_UP_PATH) return false;
  for (const key of ['version', 'routeKey', 'headers', 'multiValueHeaders', 'httpMethod', 'body',
    'isBase64Encoded', 'queryStringParameters', 'pathParameters', 'cookies', 'rawQueryString']) {
    if (event[key] !== undefined) return false;
  }
  if (Object.keys(event).some((key) => !CATCH_UP_EVENT_KEYS.includes(key))) return false;
  const ctx = event.requestContext;
  if (ctx !== undefined) {
    if (!ctx || typeof ctx !== 'object' || Array.isArray(ctx)) return false;
    if (Object.keys(ctx).some((key) => key !== 'http')) return false;
    const http = ctx.http;
    if (!http || typeof http !== 'object' || Object.keys(http).some((key) => key !== 'method')) return false;
    if (http.method !== 'POST') return false;
  }
  return true;
}

/** The validated request, or { ok: false, error }. Pure. */
export function parseCatchUpRequest(event) {
  if (!isMoovStatusCatchUpInvocation(event)) return { ok: false, error: 'catch_up_invocation_invalid' };
  const phase = event.phase;
  if (phase !== 'plan' && phase !== 'apply') return { ok: false, error: 'catch_up_phase_invalid' };
  const actorId = typeof event.actor_application_user_id === 'string' && UUID_RE.test(event.actor_application_user_id)
    ? event.actor_application_user_id.toLowerCase()
    : null;
  if (!actorId) return { ok: false, error: 'catch_up_actor_required' };
  const limit = event.limit === undefined ? CATCH_UP_DEFAULT_LIMIT : Number(event.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > CATCH_UP_MAX_LIMIT) return { ok: false, error: 'catch_up_limit_invalid' };
  if (phase === 'plan') {
    if (event.approval_statement !== undefined || event.manifest_sha256 !== undefined || event.transfer_ids !== undefined) {
      return { ok: false, error: 'catch_up_plan_takes_no_apply_fields' };
    }
    return { ok: true, phase, actorId, limit };
  }
  const statement = typeof event.approval_statement === 'string' ? event.approval_statement : '';
  if (!statement.trim() || statement.length > 2000) return { ok: false, error: 'catch_up_approval_statement_required' };
  if (statement.trim().toLowerCase() === CATCH_UP_PLAN_STATEMENT.toLowerCase()) {
    return { ok: false, error: 'catch_up_plan_statement_is_not_apply_approval' };
  }
  const hash = typeof event.manifest_sha256 === 'string' ? event.manifest_sha256 : '';
  if (!SHA256_RE.test(hash)) return { ok: false, error: 'catch_up_manifest_sha256_required' };
  const ids = event.transfer_ids;
  if (!Array.isArray(ids) || !ids.length || ids.length > CATCH_UP_MAX_LIMIT
      || ids.some((id) => typeof id !== 'string' || !TRANSFER_ID_RE.test(id))
      || new Set(ids).size !== ids.length) {
    return { ok: false, error: 'catch_up_transfer_ids_invalid' };
  }
  return { ok: true, phase, actorId, limit, statement, manifestSha256: hash, transferIds: [...ids].sort() };
}

// ------------------------------------------------------------------ database steps

async function bindActor(client, actorId) {
  await client.query(BIND_ACTOR_SQL, [actorId]);
  const owner = (await client.query(PLATFORM_OWNER_SQL)).rows[0]?.ok === true;
  return owner;
}

/** Read every candidate and the rows the prediction needs, inside BEGIN READ ONLY. */
export async function loadCatchUpCandidates(client, { environment, actorId, limit }) {
  await client.query('BEGIN READ ONLY');
  try {
    const ro = (await client.query(READ_ONLY_PROBE_SQL)).rows[0]?.transaction_read_only;
    if (ro !== 'on') return { ok: false, error: 'catch_up_plan_not_read_only' };
    if (!(await bindActor(client, actorId))) return { ok: false, error: 'catch_up_actor_not_platform_owner' };
    const legs = (await client.query(CANDIDATE_LEGS_SQL, [environment, [...TERMINAL_LEG_STATUSES], limit])).rows;
    const obligations = (await client.query(CANDIDATE_OBLIGATIONS_SQL, [environment, limit])).rows;
    const ids = [...new Set([
      ...legs.map((row) => text(row.provider_transfer_id)),
      ...obligations.map((row) => text(row.provider_transfer_id)),
    ].filter(Boolean))].sort();
    const obligationIds = [...new Set([
      ...obligations.map((row) => String(row.id)),
      ...legs.map((row) => text(row.obligation_id)).filter((id) => UUID_RE.test(id)),
    ])].sort();
    const relatedLegs = ids.length || obligationIds.length
      ? (await client.query(RELATED_LEGS_SQL, [environment, ids, obligationIds])).rows
      : [];
    const relatedObligations = ids.length || obligationIds.length
      ? (await client.query(RELATED_OBLIGATIONS_SQL, [ids, obligationIds])).rows
      : [];
    return {
      ok: true,
      truncated: legs.length >= limit || obligations.length >= limit,
      ids,
      relatedLegs,
      relatedObligations,
    };
  } finally {
    await client.query('ROLLBACK');
  }
}

/** Group the rows by Moov transfer id. Pure. */
export function groupCandidates({ ids, relatedLegs, relatedObligations }) {
  const siblingsByObligation = {};
  for (const leg of relatedLegs) {
    const oid = text(leg.obligation_id);
    if (UUID_RE.test(oid)) (siblingsByObligation[oid] ||= []).push(leg);
  }
  const obligationsById = new Map(relatedObligations.map((row) => [String(row.id), row]));
  return ids.map((providerTransferId) => {
    const legs = relatedLegs.filter((row) => text(row.provider_transfer_id) === providerTransferId);
    const named = new Map();
    for (const row of relatedObligations) {
      if (text(row.provider_transfer_id) === providerTransferId) named.set(String(row.id), row);
    }
    if (!named.size) {
      // applyBillingProviderEvent's second lookup: the leg's provider_metadata.obligation_id.
      for (const leg of legs) {
        const row = obligationsById.get(text(leg.obligation_id));
        if (row) named.set(String(row.id), row);
      }
    }
    return { providerTransferId, legs, obligations: [...named.values()], siblingsByObligation };
  });
}

// ------------------------------------------------------------------ plan and apply

async function readMoovTransfer(providerTransferId, { environment, secrets, fetchImpl, confirm }) {
  try {
    return await confirm(catchUpHint(providerTransferId), { environment, secrets, fetchImpl });
  } catch (error) {
    if (error instanceof MoovConfirmationRetry) return { ok: false, skipped: 'moov_unavailable', retry: true };
    throw error;
  }
}

/** Plan: read-only. Returns { ok, manifest, manifest_sha256, counts, ... } and the trusted payloads (not printed). */
export async function runCatchUpPlan({ client, environment, actorId, limit, secrets, fetchImpl = fetch, confirm = confirmMoovWebhookPayload }) {
  const loaded = await loadCatchUpCandidates(client, { environment, actorId, limit });
  if (!loaded.ok) return { ok: false, error: loaded.error, trusted: new Map() };
  const groups = groupCandidates(loaded);
  const entries = [];
  const trusted = new Map();
  let moovUnavailable = 0;
  for (const group of groups) {
    const moov = await readMoovTransfer(group.providerTransferId, { environment, secrets, fetchImpl, confirm });
    if (moov.retry) moovUnavailable += 1;
    if (moov.ok) trusted.set(group.providerTransferId, moov.payload);
    entries.push(classifyCandidate({ ...group, moov, environment }));
  }
  const manifest = buildCatchUpManifest({ environment, limit, entries });
  return {
    ok: true,
    manifest,
    manifest_sha256: manifestSha256(manifest),
    transfer_ids: actionableTransferIds(manifest),
    counts: summarizeEntries(entries),
    truncated: loaded.truncated,
    moov_unavailable: moovUnavailable,
    trusted,
  };
}

const statusMap = (rows) => Object.fromEntries(rows.map((row) => [String(row.id), String(row.status ?? '')]));
/** SQL 146's {id: status} object as the same map. */
const asStatusMap = (value) => (value && typeof value === 'object' && !Array.isArray(value)
  ? Object.fromEntries(Object.entries(value).map(([id, status]) => [String(id), String(status ?? '')]))
  : {});

/**
 * The fee collection leg's Moov status through SQL 146, when the plan predicted the leg changes and it is not a SQL 109
 * leg: Moov's status mapped as applyBillingProviderEvent maps it, Moov's confirmed amount, the same reason and
 * completion time. Returns SQL 146's result, or null when there is nothing to write. An error rolls the transfer back.
 */
async function applyCollectionLegStatus(client, { entry, payload, environment }) {
  const leg = entry.legs.length === 1 ? entry.legs[0] : null;
  if (!leg || SQL109_OWNED_LEG_ROLES.includes(String(leg.leg_role || ''))) return null;
  if ((leg.predicted_status ?? leg.status) === leg.status) return null;
  const providerStatus = lower(extractProviderStatus(payload));
  const mapped = mapProviderStatusToBilling(providerStatus);
  if (!mapped) return null;
  const row = (await client.query(COLLECTION_LEG_STATUS_SQL, [
    environment,
    entry.provider_transfer_id,
    entry.moov?.amount_cents ?? null,
    mapped,
    providerStatus,
    payload?.type || payload?.eventType || 'provider_webhook',
    providerCompletionTimestamp(payload),
  ])).rows[0]?.result;
  return row || null;
}

/** One transfer, one transaction. Returns { ok: true, result } or { ok: false, error, ... } after ROLLBACK. */
export async function applyOneTransfer(client, { entry, payload, environment, actorId, log = console }) {
  const legIds = entry.legs.map((leg) => leg.id).sort();
  const obligationIds = entry.obligations.map((row) => row.id).sort();
  const expectedBefore = {
    legs: Object.fromEntries(entry.legs.map((leg) => [leg.id, leg.status])),
    obligations: Object.fromEntries(entry.obligations.map((row) => [row.id, row.status])),
  };
  const expectedAfter = {
    legs: Object.fromEntries(entry.legs.map((leg) => [leg.id, leg.predicted_status ?? leg.status])),
    obligations: Object.fromEntries(entry.obligations.map((row) => [row.id, row.predicted_status ?? row.status])),
  };
  const fail = async (error, extra = {}) => {
    try { await client.query('ROLLBACK'); } catch { /* keep the first error */ }
    return { ok: false, error, provider_transfer_id: entry.provider_transfer_id, rolled_back: true, ...extra };
  };
  try {
    await client.query('BEGIN');
    await client.query('SET TRANSACTION READ WRITE');
    await client.query(WEBHOOK_GUC_SQL);
    if (!(await bindActor(client, actorId))) return fail('catch_up_actor_not_platform_owner');
    await client.query(WEBHOOK_APPLY_ON_SQL);
    const locked = (await client.query(LOCK_ROWS_SQL, [environment, entry.provider_transfer_id, obligationIds])).rows[0]?.locked || {};
    const lockedLegs = asStatusMap(locked.legs);
    const lockedObligations = asStatusMap(locked.obligations);
    if (canonicalJson(Object.keys(lockedLegs).sort()) !== canonicalJson(legIds)
        || canonicalJson(lockedLegs) !== canonicalJson(expectedBefore.legs)
        || canonicalJson(lockedObligations) !== canonicalJson(expectedBefore.obligations)) {
      return fail('catch_up_state_changed_since_plan', { found: { legs: lockedLegs, obligations: lockedObligations } });
    }

    const eventId = catchUpEventId(entry.provider_transfer_id, entry.moov?.provider_status);
    // The SQL 109 writer (funding and send legs) sets the webhook apply context and clears it again itself.
    const transfer = await applyProductionMoovTransferWebhook(client, payload, { eventId, environment, log });
    // The fee leg first (SQL 146), then the settlement code, in the webhook apply context its event row needs.
    let collectionLeg = null;
    let collection = null;
    await client.query(WEBHOOK_APPLY_ON_SQL);
    try {
      collectionLeg = await applyCollectionLegStatus(client, { entry, payload, environment });
      collection = await applyCollectionV2ProviderCompletion(client, payload, { dryRun: false });
    } finally {
      await client.query(WEBHOOK_APPLY_OFF_SQL);
    }

    const afterLegs = statusMap((await client.query(READ_LEGS_SQL, [environment, entry.provider_transfer_id])).rows);
    const afterObligations = statusMap(obligationIds.length
      ? (await client.query(READ_OBLIGATIONS_SQL, [obligationIds])).rows
      : []);
    if (canonicalJson(afterLegs) !== canonicalJson(expectedAfter.legs)
        || canonicalJson(afterObligations) !== canonicalJson(expectedAfter.obligations)) {
      return fail('catch_up_outcome_differs_from_plan', {
        expected: expectedAfter,
        found: { legs: afterLegs, obligations: afterObligations },
        transfer_outcome: transfer?.outcome || transfer?.skipped || null,
        collection_leg_outcome: collectionLeg?.outcome || null,
        collection_outcome: collection?.skipped || (collection?.applied ? 'applied' : null),
      });
    }
    await client.query('COMMIT');
    return {
      ok: true,
      result: {
        provider_transfer_id: entry.provider_transfer_id,
        event_id: eventId,
        transfer_outcome: transfer?.outcome || transfer?.skipped || null,
        collection_leg_outcome: collectionLeg?.outcome || null,
        collection_outcome: collection?.applied ? (collection.duplicate ? 'duplicate' : 'applied') : (collection?.skipped || null),
        before: expectedBefore,
        after: { legs: afterLegs, obligations: afterObligations },
      },
    };
  } catch (error) {
    return fail('catch_up_apply_exception', {
      sqlstate: error?.code || null,
      message: String(error?.message || error).replace(/\s+/g, ' ').slice(0, 160),
    });
  }
}

/** Apply: re-plan, bind to the reviewed manifest, then one transaction per transfer; stop on the first failure. */
export async function runCatchUpApply({ client, environment, request, secrets, fetchImpl = fetch, confirm = confirmMoovWebhookPayload, log = console }) {
  const plan = await runCatchUpPlan({
    client, environment, actorId: request.actorId, limit: request.limit, secrets, fetchImpl, confirm,
  });
  const base = {
    phase: 'apply',
    approval_statement: request.statement,
    approval_statement_sha256: sha256Hex(request.statement),
    reviewed_manifest_sha256: request.manifestSha256,
    applied: [],
    attempted: 0,
  };
  if (!plan.ok) return { ok: false, error: plan.error, ...base };
  base.current_manifest_sha256 = plan.manifest_sha256;
  if (plan.truncated) return { ok: false, error: 'catch_up_plan_truncated', ...base };
  if (plan.moov_unavailable) return { ok: false, error: 'catch_up_moov_unavailable', ...base };
  if (plan.manifest_sha256 !== request.manifestSha256) {
    return { ok: false, error: 'catch_up_plan_changed', message: 'The database or Moov changed since the reviewed plan. Nothing was written; run a new plan.', ...base };
  }
  if (canonicalJson(plan.transfer_ids) !== canonicalJson(request.transferIds)) {
    return { ok: false, error: 'catch_up_transfer_ids_differ_from_plan', ...base };
  }
  for (const entry of plan.manifest.entries.filter((row) => row.action === 'apply')) {
    base.attempted += 1;
    const payload = plan.trusted.get(entry.provider_transfer_id);
    if (!payload) return { ok: false, error: 'catch_up_moov_record_missing', stopped_at: entry.provider_transfer_id, ...base };
    const done = await applyOneTransfer(client, { entry, payload, environment, actorId: request.actorId, log });
    if (!done.ok) return { ...base, ok: false, stopped_at: entry.provider_transfer_id, failure: done, error: done.error };
    base.applied.push(done.result);
  }
  return { ok: true, ...base, counts: plan.counts };
}

// ------------------------------------------------------------------ Lambda entry

/** Where the catch-up may run and which writes are switched on. */
export function catchUpRuntime() {
  const environment = billingEnvironment();
  const production = isProductionChecksOpsRuntime();
  return {
    environment,
    production,
    applyEnabled: production ? productionTransferWebhookApplyEnabled() : !providerWebhookDryRun(),
  };
}

const publicPlan = (plan) => ({
  manifest: plan.manifest,
  manifest_sha256: plan.manifest_sha256,
  transfer_ids: plan.transfer_ids,
  counts: plan.counts,
  truncated: plan.truncated,
  moov_unavailable: plan.moov_unavailable,
});

/**
 * The direct-invocation handler (scheduled.mjs dispatches here when isMoovStatusCatchUpInvocation).
 * Returns { ok, statusCode, ... } like the other scheduled jobs.
 */
export async function handleMoovStatusCatchUp(event, deps = {}) {
  const request = parseCatchUpRequest(event);
  const flags = { liveProviderCalled: false, moneyMoved: false, writesAttempted: false, operation: CATCH_UP_OPERATION };
  if (!request.ok) return { ok: false, statusCode: 400, error: request.error, ...flags };
  const runtime = deps.runtime || catchUpRuntime();
  if (request.phase === 'apply' && !runtime.applyEnabled) {
    return { ok: false, statusCode: 403, error: 'catch_up_apply_disabled', message: 'The webhook apply switches are off on this runtime; nothing was read or written.', ...flags };
  }
  const createClient = deps.createClient || ((config) => new Client(config));
  const loadCredentials = deps.loadDatabaseCredentials || loadDatabaseCredentials;
  let client;
  try {
    const credentials = await loadCredentials();
    const config = request.phase === 'plan'
      ? buildClientConfig(credentials, { queryTimeoutMillis: 15000, readOnly: true })
      : buildWriteClientConfig(credentials, { queryTimeoutMillis: 15000 });
    client = createClient(config);
    await client.connect?.();
    const secrets = await (deps.loadProviderSecrets || loadProviderSecrets)();
    const common = {
      client,
      environment: runtime.environment,
      secrets,
      fetchImpl: deps.fetchImpl || fetch,
      confirm: deps.confirmMoovWebhook || confirmMoovWebhookPayload,
    };
    if (request.phase === 'plan') {
      const plan = await runCatchUpPlan({ ...common, actorId: request.actorId, limit: request.limit });
      if (!plan.ok) return { ok: false, statusCode: 403, error: plan.error, phase: 'plan', environment: runtime.environment, ...flags };
      return {
        ok: true,
        statusCode: 200,
        phase: 'plan',
        environment: runtime.environment,
        read_only: true,
        ...publicPlan(plan),
        ...flags,
        liveProviderCalled: plan.counts.candidates > 0,
      };
    }
    const applied = await runCatchUpApply({ ...common, request, log: deps.log || console });
    return {
      statusCode: applied.ok ? 200 : 409,
      environment: runtime.environment,
      ...flags,
      ...applied,
      liveProviderCalled: true,
      writesAttempted: applied.attempted > 0,
      productionRecordsMutated: runtime.production && applied.applied.length > 0,
    };
  } catch (error) {
    return {
      ok: false,
      statusCode: 503,
      error: 'catch_up_failed',
      message: String(error?.message || error).replace(/\s+/g, ' ').slice(0, 160),
      ...flags,
    };
  } finally {
    if (client) {
      try { await client.end?.(); } catch { /* ignore */ }
    }
  }
}

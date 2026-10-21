/**
 * Production Moov transfer status write-back (transfer.* webhooks).
 *
 * A verified Moov webhook for a wallet funding (bank -> wallet) or a send (wallet or bank ->
 * stakeholder / partner) updates that transfer's ChecksOps record: its status, Moov's status,
 * the ACH return code and reason (R01, R10, ...) or a notification of change (NOC, C01, ...).
 * The SPA reads payment_transfers, so WalletOps and the check's payment list show the bounce,
 * and a returned or failed send no longer counts as paid on the check.
 *
 * The write is one call to public.aws_moov_webhook_apply_transfer_status (SQL 107), a
 * SECURITY DEFINER writer gated on request.provider_webhook_apply = '1'. It finds the row by
 * provider_transfer_id in the given environment (the tenant is the row's own), touches only
 * wallet_funding / send_wallet / send_bank legs, never moves a status backwards (a late
 * 'pending' or 'completed' cannot overwrite a failure or a return), and records each Moov
 * event id once. Duplicate deliveries are also stopped earlier by the webhook receipt
 * (aws_provider_webhook_receipts, unique per provider event id).
 *
 * What it does not do: no money movement, no wallet ledger entry (production funding and
 * sends post none; the balance shown is Moov's, which already reflects a return), no payment
 * method change on a NOC (recorded with manual_follow_up for a person), no provider call, and
 * no email (there is no payment-event email or notification path; the return is recorded for
 * display and logged as moov_transfer_returned for operators).
 *
 * Runs in production when the existing production switches are on (AWS_PROVIDER_EXECUTION_ENABLED
 * and AWS_MOOV_ENABLED, webhook dry-run off, sandbox execution off) and SQL 107 is applied.
 * Until SQL 107 is applied the call fails inside a savepoint and the webhook is still
 * accepted and logged, exactly as before.
 */
import { executionAllowed, providerWebhookDryRun } from '../provider-flags.mjs';
import { providerSandboxExecutionEnabled } from '../sandbox-flags.mjs';

export const TRANSFER_STATUS_WRITER_SQL = `SELECT public.aws_moov_webhook_apply_transfer_status(
  $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::timestamptz) AS result`;

/** Outcomes that wrote the transfer row (and an event log row). */
const WRITTEN = new Set(['applied', 'correction']);
/** Outcomes that appended an event log row. */
const LOGGED = new Set(['applied', 'correction', 'unchanged', 'stale']);

export const isMoovTransferEvent = (eventType) => String(eventType || '').startsWith('transfer.');

/** Production write-back switch: the existing production provider switches; no new flag. */
export const productionTransferWebhookApplyEnabled = () => (
  executionAllowed('moov') && !providerWebhookDryRun() && !providerSandboxExecutionEnabled()
);

/** Moov transfer status -> the ChecksOps payment_transfers status, or null when unknown. */
export function mapMoovTransferStatus(moovStatus) {
  switch (String(moovStatus ?? '').trim().toLowerCase()) {
    case 'created':
    case 'queued':
      return 'submitted';
    case 'pending':
      return 'pending';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'reversed':
    case 'returned':
      return 'returned';
    case 'canceled':
    case 'cancelled':
      return 'canceled';
    default:
      return null;
  }
}

const statusFromEventType = (eventType) => {
  const t = String(eventType || '').toLowerCase();
  if (t.endsWith('.completed')) return 'completed';
  if (t.endsWith('.failed')) return 'failed';
  if (t.endsWith('.reversed') || t.endsWith('.returned')) return 'reversed';
  if (t.endsWith('.canceled') || t.endsWith('.cancelled')) return 'canceled';
  if (t.endsWith('.created')) return 'created';
  return null;
};

const RETURN_CODE_RE = /^R\d{2}$/;
const CORRECTION_CODE_RE = /^C\d{2}$/;
const text = (value, max = 200) => {
  const s = String(value ?? '').trim();
  return s ? s.slice(0, max) : null;
};
const code = (value, re) => {
  const s = String(value ?? '').trim().toUpperCase();
  return re.test(s) ? s : null;
};

/**
 * The ACH return and NOC Moov reports on either leg (source or destination achDetails, or a
 * flat field on the event). The first R code / C code found wins; source leg first.
 */
export function extractAchOutcome(data = {}) {
  const legs = [data?.source?.achDetails, data?.destination?.achDetails, data?.achDetails, data];
  let returnCode = null;
  let returnReason = null;
  let correctionCode = null;
  let correctionReason = null;
  let achReturned = false;
  for (const leg of legs) {
    if (!leg || typeof leg !== 'object') continue;
    if (String(leg.status || '').toLowerCase() === 'returned' && leg !== data) achReturned = true;
    const ret = leg.return && typeof leg.return === 'object' ? leg.return : null;
    const rc = code(ret?.code ?? leg.returnCode, RETURN_CODE_RE);
    if (rc && !returnCode) {
      returnCode = rc;
      returnReason = text(ret?.reason ?? ret?.description ?? leg.returnReason);
    }
    const cor = leg.correction && typeof leg.correction === 'object' ? leg.correction : null;
    const cc = code(cor?.code ?? leg.correctionCode, CORRECTION_CODE_RE);
    if (cc && !correctionCode) {
      correctionCode = cc;
      correctionReason = text(cor?.reason ?? cor?.description ?? leg.correctionReason);
    }
  }
  return { returnCode, returnReason, correctionCode, correctionReason, achReturned };
}

const asIso = (value) => {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
};

/** What a transfer.* webhook says, mapped onto ChecksOps. Pure; no I/O. */
export function interpretMoovTransferEvent(payload = {}) {
  const data = payload?.data ?? payload ?? {};
  const eventType = String(payload?.type ?? payload?.eventType ?? 'transfer.updated').slice(0, 120);
  const providerTransferId = text(data?.transferID ?? data?.transferId ?? payload?.transferID ?? payload?.transferId, 120);
  const providerStatus = text(data?.status, 40) || statusFromEventType(eventType);
  const ach = extractAchOutcome(data);
  let status = mapMoovTransferStatus(providerStatus);
  // An ACH return is a bounce whatever the transfer status says (failed before completion,
  // completed then returned, or reversed): record it as returned.
  if ((ach.returnCode || ach.achReturned) && status !== 'canceled') status = 'returned';
  return {
    providerTransferId,
    eventType,
    providerStatus,
    status,
    returnCode: ach.returnCode,
    returnReason: ach.returnReason,
    correctionCode: ach.correctionCode,
    correctionReason: ach.correctionReason,
    completedAt: status === 'completed' ? asIso(data?.completedOn ?? data?.completed_on) : null,
  };
}

/**
 * Apply one verified, not-yet-seen transfer.* webhook to a production transfer. Runs inside
 * the webhook transaction; the writer call is isolated in a savepoint so a missing SQL 107
 * (or any refusal) never aborts the receipt.
 */
export async function applyProductionMoovTransferWebhook(client, payload, { eventId, environment = 'production', log = console } = {}) {
  const event = interpretMoovTransferEvent(payload);
  const base = { financialTablesMutated: false, mutations: [], environment };
  if (!event.providerTransferId) return { ...base, applied: false, skipped: 'no_transfer_id' };
  if (!eventId) return { ...base, applied: false, skipped: 'no_event_id' };
  if (!event.status && !event.correctionCode) {
    return { ...base, applied: false, skipped: 'unmapped_status', provider_status: event.providerStatus };
  }

  let row;
  await client.query("SELECT set_config('request.aws_financial_permissions_activated', '0', true)");
  await client.query("SELECT set_config('request.provider_webhook_apply', '1', true)");
  try {
    await client.query('SAVEPOINT moov_transfer_status');
    try {
      row = (await client.query(TRANSFER_STATUS_WRITER_SQL, [
        environment,
        event.providerTransferId,
        event.status,
        event.providerStatus,
        String(eventId).slice(0, 200),
        event.eventType,
        event.returnCode,
        event.returnReason,
        event.correctionCode,
        event.correctionReason,
        event.completedAt,
      ])).rows[0]?.result;
      await client.query('RELEASE SAVEPOINT moov_transfer_status');
    } catch (error) {
      await client.query('ROLLBACK TO SAVEPOINT moov_transfer_status');
      await client.query('RELEASE SAVEPOINT moov_transfer_status');
      log.warn?.(JSON.stringify({
        service: 'checksops-api',
        event: 'moov_transfer_status_writer_failed',
        provider_transfer_id: event.providerTransferId,
        sqlstate: error?.code || null,
      }));
      return { ...base, applied: false, skipped: 'status_writer_unavailable', sqlstate: error?.code || null };
    }
  } finally {
    // Scoped to this apply only: later steps of the webhook transaction must not inherit it.
    await client.query("SELECT set_config('request.provider_webhook_apply', '0', true)");
  }

  const outcome = row?.outcome || 'unknown_transfer';
  const mutations = [
    ...(WRITTEN.has(outcome) ? ['payment_transfers'] : []),
    ...(LOGGED.has(outcome) ? ['payment_event_log'] : []),
  ];
  if (row?.notify === true) {
    log.warn?.(JSON.stringify({
      service: 'checksops-api',
      event: 'moov_transfer_returned',
      tenant_id: row.tenant_id,
      transfer_id: row.transfer_id,
      leg_role: row.leg_role,
      status: row.new_status,
      return_code: event.returnCode,
    }));
  }
  return {
    applied: WRITTEN.has(outcome),
    skipped: WRITTEN.has(outcome) ? null : outcome,
    outcome,
    environment,
    transfer_id: row?.transfer_id || null,
    tenant_id: row?.tenant_id || null,
    leg_role: row?.leg_role || null,
    previous_status: row?.previous_status || null,
    status: row?.new_status || null,
    return_code: event.returnCode,
    correction_code: event.correctionCode,
    notify: row?.notify === true,
    financialTablesMutated: mutations.length > 0,
    mutations,
  };
}

/**
 * Production Moov webhook apply: reconcile existing objects only.
 * Never INSERT payment_transfers. Never POST to Moov.
 */
import { sanitize } from './parity/db.mjs';
import { canTransition, completedAtFor, extractTransferEvent, normalizeMoovStatus } from './moov-lifecycle.mjs';

export const productionWebhookReconcileEnabled = () => true;

const call = async (client, sql, params = []) => (await client.query(sql, params)).rows;

export async function applyProductionMoovWebhook(client, payload, { mappedTenantId = null, dryRun = false } = {}) {
  const extracted = extractTransferEvent(payload);
  const mutations = [];
  if (dryRun) {
    return {
      applied: false,
      skipped: 'dry_run',
      environment: 'production',
      financialTablesMutated: false,
      mutations,
      createdPaymentTransfer: false,
      liveProviderCalled: false,
    };
  }
  if (!extracted.transferId) {
    return {
      applied: false,
      skipped: 'no_transfer_id',
      environment: 'production',
      financialTablesMutated: false,
      mutations,
      createdPaymentTransfer: false,
      liveProviderCalled: false,
    };
  }

  await client.query("SELECT set_config('request.provider_webhook', '1', true)");
  await client.query("SELECT set_config('request.provider_webhook_apply', '1', true)");

  const existing = (await call(
    client,
    `SELECT * FROM public.aws_moov_lookup_transfer($1)`,
    [extracted.transferId],
  ))[0] || null;

  if (existing?.environment === 'sandbox') {
    return {
      applied: false,
      skipped: 'sandbox_row_use_sandbox_apply',
      environment: 'sandbox',
      financialTablesMutated: false,
      mutations,
      createdPaymentTransfer: false,
      liveProviderCalled: false,
    };
  }

  if (existing) {
    if (mappedTenantId && existing.tenant_id && String(mappedTenantId) !== String(existing.tenant_id)) {
      return {
        applied: false,
        skipped: 'tenant_mismatch',
        environment: existing.environment,
        financialTablesMutated: false,
        mutations,
        createdPaymentTransfer: false,
        liveProviderCalled: false,
      };
    }
    const gate = canTransition(existing.status, extracted.status);
    if (!gate.ok || gate.noop) {
      if (!gate.ok) {
        await call(
          client,
          `SELECT public.aws_moov_record_reconcile_event($1::uuid, $2, $3, $4, $5, $6::jsonb)`,
          [
            existing.tenant_id,
            existing.id,
            extracted.transferId,
            extracted.eventType,
            existing.status,
            JSON.stringify(sanitize({
              skipped: gate.reason,
              attempted: extracted.status,
              provider_status: extracted.providerStatus,
            })),
          ],
        );
        mutations.push('payment_event_log');
      }
      return {
        applied: Boolean(gate.ok && gate.noop),
        skipped: gate.ok ? 'idempotent_same_status' : gate.reason,
        environment: existing.environment,
        financialTablesMutated: false,
        mutations,
        createdPaymentTransfer: false,
        liveProviderCalled: false,
        payment_transfer_id: existing.id,
        status: existing.status,
        completed_at: existing.completed_at,
      };
    }

    const completedAt = completedAtFor({
      nextStatus: extracted.status,
      providerCompletedAt: extracted.completedOn,
      existingCompletedAt: existing.completed_at,
    });
    const updated = (await call(
      client,
      `SELECT * FROM public.aws_moov_reconcile_existing_transfer(
         $1, $2, $3, $4::timestamptz, $5, $6, $7::jsonb)`,
      [
        extracted.transferId,
        extracted.status,
        extracted.providerStatus,
        completedAt,
        extracted.eventType,
        existing.status,
        JSON.stringify(sanitize({
          source: 'moov_webhook',
          completedOn: extracted.completedOn,
          createdOn: extracted.createdOn,
          sweep: extracted.sweep,
        })),
      ],
    ))[0];
    mutations.push('payment_transfers', 'payment_event_log');
    return {
      applied: true,
      skipped: null,
      environment: existing.environment,
      financialTablesMutated: true,
      mutations,
      createdPaymentTransfer: false,
      liveProviderCalled: false,
      payment_transfer_id: existing.id,
      status: updated?.status || extracted.status,
      completed_at: updated?.completed_at || completedAt,
    };
  }

  const observed = (await call(
    client,
    `SELECT * FROM public.aws_moov_observe_provider_activity(
       $1::uuid, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz, $10::timestamptz, $11::jsonb)`,
    [
      mappedTenantId,
      extracted.transferId,
      extracted.sweep.isSweep ? 'provider_sweep' : 'provider_unknown',
      extracted.sweep.kind,
      extracted.status,
      extracted.amountCents,
      extracted.sweep.sourceType,
      extracted.sweep.destType,
      extracted.createdOn,
      extracted.completedOn,
      JSON.stringify(sanitize({
        event_type: extracted.eventType,
        sweepID: extracted.sweep.sweepID,
        accountID: extracted.accountId,
        metadata: extracted.metadata,
      })),
    ],
  ))[0];
  mutations.push('payment_provider_activity');
  return {
    applied: true,
    skipped: 'unknown_transfer_observed_only',
    environment: 'production',
    financialTablesMutated: false,
    mutations,
    createdPaymentTransfer: false,
    liveProviderCalled: false,
    observed_id: observed?.observed_id || observed?.id || null,
    provider_transfer_id: extracted.transferId,
  };
}

export async function reconcileExistingFromProviderGet(client, {
  providerTransferId,
  providerStatus,
  completedOn = null,
  eventType = 'transfer.status_refresh',
  sweep = null,
} = {}) {
  const extractedStatus = normalizeMoovStatus(providerStatus, eventType);
  const existing = (await call(
    client,
    `SELECT * FROM public.aws_moov_lookup_transfer($1)`,
    [providerTransferId],
  ))[0] || null;
  if (!existing) {
    return { applied: false, skipped: 'unknown_transfer', createdPaymentTransfer: false };
  }
  const gate = canTransition(existing.status, extractedStatus);
  if (!gate.ok || gate.noop) {
    return {
      applied: Boolean(gate.ok && gate.noop),
      skipped: gate.ok ? 'idempotent_same_status' : gate.reason,
      payment_transfer_id: existing.id,
      status: existing.status,
      completed_at: existing.completed_at,
      createdPaymentTransfer: false,
      liveProviderPosted: false,
    };
  }
  const completedAt = completedAtFor({
    nextStatus: extractedStatus,
    providerCompletedAt: completedOn,
    existingCompletedAt: existing.completed_at,
  });
  const updated = (await call(
    client,
    `SELECT * FROM public.aws_moov_reconcile_existing_transfer(
       $1, $2, $3, $4::timestamptz, $5, $6, $7::jsonb)`,
    [
      providerTransferId,
      extractedStatus,
      providerStatus,
      completedAt,
      eventType,
      existing.status,
      JSON.stringify(sanitize({ source: 'moov_get', completedOn, sweep })),
    ],
  ))[0];
  return {
    applied: true,
    skipped: gate.noop ? 'idempotent_same_status' : null,
    payment_transfer_id: existing.id,
    status: updated?.status || extractedStatus,
    completed_at: updated?.completed_at || completedAt,
    createdPaymentTransfer: false,
    liveProviderPosted: false,
  };
}

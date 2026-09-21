/**
 * Production Moov webhook apply: reconcile existing objects only.
 * Never INSERT payment_transfers. Never POST to Moov.
 * Terminal completed success fills completed_at, clears stale failure_reason,
 * and updates the environment-scoped wallet cache from payload amounts.
 */
import { sanitize } from './parity/db.mjs';
import {
  canTransition,
  completedAtFor,
  extractTransferEvent,
  extractWalletEvent,
  needsParityFill,
  normalizeMoovStatus,
} from './moov-lifecycle.mjs';

export const productionWebhookReconcileEnabled = () => true;

const call = async (client, sql, params = []) => (await client.query(sql, params)).rows;

const envOf = (environment) => (
  String(environment || 'production').toLowerCase() === 'sandbox' ? 'sandbox' : 'production'
);

export async function reconcileWalletCache(client, {
  providerWalletId,
  environment = 'production',
  availableCents = null,
  pendingCents = null,
  tenantId = null,
  metadata = null,
} = {}) {
  const env = envOf(environment);
  if (!providerWalletId) {
    return { applied: false, skipped: 'no_wallet_id', environment: env, liveProviderCalled: false };
  }
  if (availableCents == null && pendingCents == null) {
    return { applied: false, skipped: 'wallet_amounts_absent', environment: env, liveProviderCalled: false };
  }
  try {
    const updated = (await call(
      client,
      `SELECT * FROM public.aws_moov_reconcile_wallet_cache($1, $2, $3::bigint, $4::bigint, $5::uuid, $6::jsonb)`,
      [
        String(providerWalletId),
        env,
        availableCents,
        pendingCents,
        tenantId || null,
        JSON.stringify(sanitize(metadata || { source: 'moov_wallet_event' })),
      ],
    ))[0] || null;
    if (!updated) {
      return {
        applied: false,
        skipped: 'wallet_not_found',
        environment: env,
        liveProviderCalled: false,
        createdPaymentTransfer: false,
      };
    }
    return {
      applied: true,
      skipped: null,
      environment: updated.environment || env,
      financialTablesMutated: true,
      mutations: ['payment_wallets', 'payment_event_log'],
      createdPaymentTransfer: false,
      liveProviderCalled: false,
      wallet_id: updated.id,
      available_cents: updated.available_cents,
      pending_cents: updated.pending_cents,
    };
  } catch (error) {
    const message = String(error?.message || error);
    if (message.includes('moov_environment_mismatch')) {
      return {
        applied: false,
        skipped: 'cross_environment_wallet_refused',
        environment: env,
        liveProviderCalled: false,
        createdPaymentTransfer: false,
      };
    }
    if (message.includes('moov_tenant_mismatch')) {
      return {
        applied: false,
        skipped: 'tenant_mismatch',
        environment: env,
        liveProviderCalled: false,
        createdPaymentTransfer: false,
      };
    }
    throw error;
  }
}

const applyExistingTransfer = async (client, {
  existing,
  extracted,
  env,
  eventType,
  metadata,
}) => {
  const gate = canTransition(existing.status, extracted.status);
  const parityFill = needsParityFill(existing, extracted);
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
    return {
      applied: false,
      skipped: gate.reason,
      environment: existing.environment,
      financialTablesMutated: false,
      mutations: ['payment_event_log'],
      createdPaymentTransfer: false,
      liveProviderCalled: false,
      payment_transfer_id: existing.id,
      status: existing.status,
      completed_at: existing.completed_at,
      failure_reason: existing.failure_reason || null,
    };
  }
  if (gate.noop && !parityFill) {
    return {
      applied: true,
      skipped: 'idempotent_same_status',
      environment: existing.environment,
      financialTablesMutated: false,
      mutations: [],
      createdPaymentTransfer: false,
      liveProviderCalled: false,
      payment_transfer_id: existing.id,
      status: existing.status,
      completed_at: existing.completed_at,
      failure_reason: existing.failure_reason || null,
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
       $1, $2, $3, $4::timestamptz, $5, $6, $7::jsonb, $8)`,
    [
      extracted.transferId,
      extracted.status,
      extracted.providerStatus,
      completedAt,
      eventType,
      existing.status,
      JSON.stringify(sanitize(metadata)),
      env,
    ],
  ))[0];
  return {
    applied: true,
    skipped: null,
    environment: existing.environment,
    financialTablesMutated: true,
    mutations: ['payment_transfers', 'payment_event_log'],
    createdPaymentTransfer: false,
    liveProviderCalled: false,
    payment_transfer_id: existing.id,
    status: updated?.status || extracted.status,
    completed_at: updated?.completed_at || completedAt,
    failure_reason: updated?.failure_reason ?? null,
    parity_fill: Boolean(parityFill),
  };
};

export async function applyProductionMoovWebhook(client, payload, { mappedTenantId = null, dryRun = false, environment = 'production' } = {}) {
  const extracted = extractTransferEvent(payload);
  const wallet = extractWalletEvent(payload);
  const env = envOf(environment);
  const mutations = [];
  if (dryRun) {
    return {
      applied: false,
      skipped: 'dry_run',
      environment: env,
      financialTablesMutated: false,
      mutations,
      createdPaymentTransfer: false,
      liveProviderCalled: false,
    };
  }

  await client.query("SELECT set_config('request.provider_webhook', '1', true)");
  await client.query("SELECT set_config('request.provider_webhook_apply', '1', true)");

  let walletApply = null;
  if (wallet.walletId && wallet.hasAmounts) {
    walletApply = await reconcileWalletCache(client, {
      providerWalletId: wallet.walletId,
      environment: env,
      availableCents: wallet.availableCents,
      pendingCents: wallet.pendingCents,
      tenantId: mappedTenantId,
      metadata: {
        source: 'moov_webhook',
        event_type: wallet.eventType,
        accountID: wallet.accountId,
      },
    });
    if (walletApply.mutations) mutations.push(...walletApply.mutations);
  }

  const transferId = extracted.transferId;
  if (!transferId) {
    if (walletApply?.applied) {
      return {
        applied: true,
        skipped: null,
        environment: walletApply.environment || env,
        financialTablesMutated: true,
        mutations,
        createdPaymentTransfer: false,
        liveProviderCalled: false,
        wallet_id: walletApply.wallet_id,
        available_cents: walletApply.available_cents,
        pending_cents: walletApply.pending_cents,
      };
    }
    if (wallet.walletId && walletApply && !walletApply.applied) {
      return {
        applied: false,
        skipped: walletApply.skipped || 'wallet_not_found',
        environment: env,
        financialTablesMutated: false,
        mutations,
        createdPaymentTransfer: false,
        liveProviderCalled: false,
      };
    }
    return {
      applied: false,
      skipped: 'no_transfer_id',
      environment: env,
      financialTablesMutated: false,
      mutations,
      createdPaymentTransfer: false,
      liveProviderCalled: false,
    };
  }

  const existing = (await call(
    client,
    `SELECT * FROM public.aws_moov_lookup_transfer($1, $2)`,
    [transferId, env],
  ))[0] || null;

  if (existing && existing.environment && existing.environment !== env) {
    return {
      applied: false,
      skipped: 'cross_environment_row_refused',
      environment: existing.environment,
      financialTablesMutated: Boolean(walletApply?.applied),
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
        financialTablesMutated: Boolean(walletApply?.applied),
        mutations,
        createdPaymentTransfer: false,
        liveProviderCalled: false,
      };
    }
    const result = await applyExistingTransfer(client, {
      existing,
      extracted,
      env,
      eventType: extracted.eventType,
      metadata: {
        source: 'moov_webhook',
        completedOn: extracted.completedOn,
        createdOn: extracted.createdOn,
        sweep: extracted.sweep,
        walletID: wallet.walletId,
      },
    });
    result.mutations = [...mutations, ...(result.mutations || [])];
    result.financialTablesMutated = Boolean(result.financialTablesMutated || walletApply?.applied);
    if (walletApply?.applied) {
      result.wallet_id = walletApply.wallet_id;
      result.available_cents = walletApply.available_cents;
      result.pending_cents = walletApply.pending_cents;
    }
    return result;
  }

  const observed = (await call(
    client,
    `SELECT * FROM public.aws_moov_observe_provider_activity(
       $1::uuid, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz, $10::timestamptz, $11::jsonb, $12)`,
    [
      mappedTenantId,
      transferId,
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
        walletID: wallet.walletId,
      })),
      env,
    ],
  ))[0];
  mutations.push('payment_provider_activity');
  return {
    applied: true,
    skipped: 'unknown_transfer_observed_only',
    environment: env,
    financialTablesMutated: Boolean(walletApply?.applied),
    mutations,
    createdPaymentTransfer: false,
    liveProviderCalled: false,
    observed_id: observed?.observed_id || observed?.id || null,
    provider_transfer_id: transferId,
    wallet_id: walletApply?.wallet_id || null,
  };
}

export async function reconcileExistingFromProviderGet(client, {
  providerTransferId,
  providerStatus,
  completedOn = null,
  eventType = 'transfer.status_refresh',
  sweep = null,
  environment = 'production',
} = {}) {
  const env = envOf(environment);
  const extractedStatus = normalizeMoovStatus(providerStatus, eventType);
  await client.query("SELECT set_config('request.moov_get_reconcile', '1', true)");
  const existing = (await call(
    client,
    `SELECT * FROM public.aws_moov_lookup_transfer($1, $2)`,
    [providerTransferId, env],
  ))[0] || null;
  if (!existing) {
    return { applied: false, skipped: 'unknown_transfer', createdPaymentTransfer: false, environment: env, liveProviderPosted: false };
  }
  const extracted = {
    transferId: providerTransferId,
    status: extractedStatus,
    providerStatus,
    completedOn,
    eventType,
  };
  const result = await applyExistingTransfer(client, {
    existing,
    extracted,
    env,
    eventType,
    metadata: { source: 'moov_get', completedOn, sweep },
  });
  return {
    ...result,
    liveProviderPosted: false,
    createdPaymentTransfer: false,
    environment: env,
  };
}

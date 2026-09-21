/**
 * M7.11 sandbox end-to-end payout orchestration for Pipeline Test.
 *
 * Uses the M7.7 shortfall machine plus the proven sandbox BANK→WALLET and
 * WALLET→RECIPIENT writers. LIVE Moov available balance is authority.
 * RDS cached wallet cents never decide funding. Production POST is refused.
 * Unknown/timeout never retries. GET fallback never creates a transfer.
 */
import { KNOWN_APPROVED_MOOV } from './moov-accounts.mjs';
import {
  PIPELINE_TEST_SANDBOX,
  PIPELINE_TEST_TENANT_ID,
  SANDBOX_FUNDING_AMOUNT_CENTS,
  executeSandboxWalletFunding,
  persistSandboxFundingIntent,
} from './moov-sandbox-wallet-fund.mjs';
import {
  SANDBOX_PAYOUT_AMOUNT_CENTS,
  executeSandboxWalletDisbursement,
  persistSandboxPayoutIntent,
} from './moov-sandbox-wallet-disburse.mjs';
import { extractTransferEvent, normalizeMoovStatus } from '../moov-lifecycle.mjs';
import { reconcileExistingFromProviderGet } from '../webhook-apply-production.mjs';
import { applyMoovWebhook } from '../webhook-apply.mjs';
import {
  DECISION,
  applyGetFallbackToIntent,
  createMemoryPayoutStore,
  getReconciliationMayCreateMoneyIntent,
  orchestratePayout,
  webhookMayCreateMoneyIntent,
} from './moov-payout-orchestrator.mjs';

export const M711_PHASE = 'M7.11';
export const SANDBOX_E2E_PAYOUT_CENTS = SANDBOX_PAYOUT_AMOUNT_CENTS;

const FREEDOM = KNOWN_APPROVED_MOOV.freedom.tenantId;
const fail = (error, extra = {}) => ({
  ok: false,
  error,
  phase: M711_PHASE,
  environment: 'sandbox',
  liveProviderPosted: false,
  createdPaymentTransfer: extra.createdPaymentTransfer === true,
  productionMoneyMoved: false,
  ...extra,
});

const amountCentsOf = (amount) => {
  if (amount === undefined || amount === null) return 0;
  if (typeof amount === 'object') {
    if (amount.valueDecimal != null && amount.valueDecimal !== '') {
      const n = Math.round(Number(amount.valueDecimal) * 100);
      return Number.isFinite(n) ? n : 0;
    }
    const raw = amount.value ?? amount.amount ?? 0;
    const n = Number(raw);
    return Number.isFinite(n) ? Math.round(n) : 0;
  }
  const n = Number(amount);
  return Number.isFinite(n) ? Math.round(n) : 0;
};

export const explainMissingSandboxPayoutWebhookReceipt = ({
  transferId,
  receiptsByTransferId = [],
  receiptsByEventId = [],
  tenantTransferReceipts = [],
  transferTypedReceipts = [],
  eventLog = [],
  sandboxApplyEnabled = false,
  productionExecutionEnabled = false,
  dryRun = false,
} = {}) => {
  const unmappedTransferReceipts = (transferTypedReceipts || []).filter((row) => (
    !row.mapped_tenant_id && !row.mapped_internal_id
    && String(row.event_type || '').toLowerCase().includes('transfer')
  ));
  const matchingEventLog = (eventLog || []).filter((row) => (
    String(row.provider_transfer_id || '') === String(transferId || '')
    && String(row.event_type || '').toLowerCase().includes('transfer')
  ));
  const lookupMiss = (receiptsByTransferId || []).length === 0
    && ((receiptsByEventId || []).length > 0
      || (tenantTransferReceipts || []).length > 0
      || unmappedTransferReceipts.length > 0);
  const reasons = [];
  if (!sandboxApplyEnabled) {
    reasons.push('sandbox_apply_disabled');
  }
  if (productionExecutionEnabled) {
    reasons.push('production_execution_blocks_sandbox_apply');
  }
  if (dryRun) reasons.push('webhook_dry_run');
  reasons.push('receipts_keyed_by_event_uuid_not_transfer_uuid');
  if (lookupMiss) reasons.push('receipt_lookup_by_transfer_id_misses_event_uuid_rows');
  if (unmappedTransferReceipts.length > 0) {
    reasons.push('transfer_receipts_unmapped_tenant_and_account_null');
  }
  if (matchingEventLog.length > 0) {
    reasons.push('production_apply_matched_provider_transfer_id');
  }
  if ((receiptsByTransferId || []).length === 0 && (tenantTransferReceipts || []).length === 0 && (receiptsByEventId || []).length === 0 && unmappedTransferReceipts.length === 0) {
    reasons.push('no_persisted_receipt_for_event_or_transfer');
  }
  let rootCause = 'no_matching_persisted_receipt';
  if ((receiptsByTransferId || []).length > 0) {
    rootCause = 'receipt_present_apply_or_mapping';
  } else if (unmappedTransferReceipts.length > 0 && matchingEventLog.length > 0) {
    rootCause = 'emitted_receipted_unmapped_lookup_miss';
  } else if (lookupMiss) {
    rootCause = 'receipt_lookup_issue';
  }
  return {
    transferId: transferId || null,
    webhookChangeRequired: false,
    getFallbackRequired: true,
    sandboxApplyEnabled: sandboxApplyEnabled === true,
    productionExecutionEnabled: productionExecutionEnabled === true,
    dryRun: dryRun === true,
    lookup: {
      storedKey: 'aws_provider_webhook_receipts.external_event_id = Moov eventID',
      notStored: 'provider_transfer_id / transferID',
      mapped_internal_id: 'payment_provider_accounts.id, not the transfer',
    },
    unmappedTransferReceipts: unmappedTransferReceipts.length,
    matchingEventLog: matchingEventLog.length,
    reasons,
    rootCause,
  };
};

const snapshotTransfer = (json) => {
  const extracted = extractTransferEvent(json?.data ? json : { data: json });
  return {
    id: extracted.transferId || json?.transferID || json?.transferId || json?.id || null,
    status: extracted.status || normalizeMoovStatus(json?.status),
    providerStatus: json?.status || extracted.providerStatus || null,
    completedOn: extracted.completedOn || json?.completedOn || json?.destination?.achDetails?.completedOn || null,
    originatedOn: json?.destination?.achDetails?.originatedOn || json?.source?.achDetails?.originatedOn || null,
    amountCents: extracted.amountCents ?? amountCentsOf(json?.amount),
  };
};

const applyFallback = async ({
  client,
  intent,
  store,
  getTransfer,
  environment = 'sandbox',
}) => {
  if (!intent?.provider_transfer_id) {
    return {
      applied: false,
      skipped: 'no_provider_transfer_id',
      intent,
      liveProviderPosted: false,
      createdPaymentTransfer: false,
    };
  }
  if (getReconciliationMayCreateMoneyIntent() || webhookMayCreateMoneyIntent()) {
    return fail('recon_create_forbidden');
  }
  let provider = null;
  if (typeof getTransfer === 'function') {
    const got = await getTransfer(intent.provider_transfer_id);
    provider = snapshotTransfer(got?.data || got || {});
  }
  if (!provider?.id) {
    return {
      applied: false,
      skipped: 'provider_get_missing',
      intent,
      liveProviderPosted: false,
      createdPaymentTransfer: false,
    };
  }
  const local = applyGetFallbackToIntent({
    intent,
    providerStatus: provider.providerStatus || provider.status,
    completedOn: provider.completedOn,
  });
  if (local.intent && store?.updateIntent) {
    await store.updateIntent(intent.idempotency_key, local.intent);
  }
  let sql = null;
  if (client && local.intent?.provider_transfer_id) {
    sql = await reconcileExistingFromProviderGet(client, {
      providerTransferId: local.intent.provider_transfer_id,
      providerStatus: provider.providerStatus || provider.status,
      completedOn: provider.completedOn,
      environment,
    });
  }
  return {
    applied: local.applied === true || sql?.applied === true,
    skipped: local.skipped || sql?.skipped || null,
    intent: local.intent || intent,
    createdPaymentTransfer: false,
    liveProviderPosted: false,
    provider,
  };
};

export async function executeSandboxPayoutE2e({
  tenantId,
  tenantEnvironment,
  liveAvailableCents,
  rdsAvailableCents = null,
  payoutCents = SANDBOX_E2E_PAYOUT_CENTS,
  recipientVerified = false,
  credentials = null,
  productionPublicKey = null,
  productionSecretKey = null,
  transferPostEnabled = false,
  productionTransferPostEnabled = false,
  persistMoneyIntents = true,
  store = null,
  existingRows = [],
  sweepActivity = [],
  labels = null,
  fundBinding = null,
  payoutBinding = null,
  client = null,
  getTransfer = null,
  refreshLiveWallet = null,
  applyWebhookPayload = null,
  fetchImpl = fetch,
  executeFunding = executeSandboxWalletFunding,
  executePayout = executeSandboxWalletDisbursement,
} = {}) {
  if (tenantEnvironment !== 'sandbox') return fail('tenant_not_sandbox', { tenantEnvironment });
  if (!tenantId || tenantId === FREEDOM) return fail('refused_production_tenant', { tenantId });
  if (tenantId !== PIPELINE_TEST_TENANT_ID) return fail('undesignated_tenant', { tenantId });
  if (productionTransferPostEnabled === true) return fail('production_post_flag_refused');
  if (credentials && credentials.environment !== 'sandbox') {
    return fail('cross_environment_credential_refused');
  }
  if (liveAvailableCents === undefined || liveAvailableCents === null) {
    return fail('live_balance_required', { message: 'RDS wallet cache is not authority for funding.' });
  }
  if (Number(payoutCents) !== SANDBOX_E2E_PAYOUT_CENTS) {
    return fail('amount_not_one_cent', { payoutCents });
  }

  const memory = store || createMemoryPayoutStore();
  let availableCents = Number(liveAvailableCents);
  const posts = { funding: 0, payout: 0 };
  const sequence = ['payout_requested', 'wallet_check'];

  const planOnce = async (rows) => orchestratePayout({
    availableCents,
    payoutCents,
    recipientVerified,
    totpFundPresent: true,
    totpDisbursePresent: true,
    requireTotp: false,
    transferPostEnabled: transferPostEnabled === true && productionTransferPostEnabled !== true,
    persistMoneyIntents,
    store: memory,
    existingRows: rows,
    sweepActivity,
    environment: 'sandbox',
    tenantId,
    labels,
    rdsAvailableCents,
  });

  let rows = [...existingRows];
  let plan = await planOnce(rows);

  const fundingRow = () => rows.find((row) => String(row.leg_role || row.kind || '') === 'wallet_funding') || plan.funding_intent;
  const payoutRow = () => rows.find((row) => String(row.leg_role || row.kind || '') === 'wallet_disbursement') || plan.payout_intent;

  if (applyWebhookPayload && client) {
    await applyMoovWebhook(client, applyWebhookPayload, { mappedTenantId: tenantId });
  } else if (applyWebhookPayload) {
    const extracted = extractTransferEvent(applyWebhookPayload);
    for (const row of rows) {
      if (String(row.provider_transfer_id || '') === String(extracted.transferId || '')) {
        const applied = applyGetFallbackToIntent({
          intent: row,
          providerStatus: extracted.providerStatus || extracted.status,
          completedOn: extracted.completedOn,
        });
        if (applied.intent) {
          Object.assign(row, applied.intent);
          if (row.idempotency_key) {
            await memory.updateIntent(row.idempotency_key, applied.intent);
          }
        }
      }
    }
  }

  let fundingRecon = await applyFallback({
    client,
    intent: fundingRow(),
    store: memory,
    getTransfer,
  });
  if (fundingRecon.intent?.idempotency_key) {
    rows = rows.map((row) => (
      row.idempotency_key === fundingRecon.intent.idempotency_key ? fundingRecon.intent : row
    ));
    if (!rows.some((row) => row.idempotency_key === fundingRecon.intent.idempotency_key) && fundingRecon.intent.provider_transfer_id) {
      rows.push(fundingRecon.intent);
    }
  }

  if (typeof refreshLiveWallet === 'function') {
    const live = await refreshLiveWallet();
    availableCents = amountCentsOf(live?.availableBalance ?? live?.available ?? live);
  }

  plan = await planOnce(rows);

  let fundingExec = null;
  const fundingBlockedPayout = ['funding_pending', 'funding_submitting', 'funding_submitted', 'funding_unknown', 'funding_failed', 'funding_returned']
    .includes(plan.funding_state);
  if (plan.decision === DECISION.FUND_FIRST && plan.funding_intent && persistMoneyIntents) {
    if (Number(plan.shortfall_cents) !== SANDBOX_FUNDING_AMOUNT_CENTS && Number(plan.shortfall_cents) !== 0) {
      /* persist still records exact shortfall; live writer remains 1¢ proven amount */
    }
    await persistSandboxFundingIntent(memory, plan.funding_intent);
    const canPostFunding = plan.funding_post_allowed === true
      && transferPostEnabled === true
      && productionTransferPostEnabled !== true
      && !['funding_pending', 'funding_submitting', 'funding_submitted', 'funding_unknown', 'funding_failed', 'funding_returned', 'funding_completed'].includes(plan.funding_state);
    if (canPostFunding) {
      fundingExec = await executeFunding({
        credentials,
        productionPublicKey,
        productionSecretKey,
        binding: fundBinding,
        intent: plan.funding_intent,
        transferPostEnabled: true,
        productionTransferPostEnabled: false,
        fetchImpl,
      });
      if (fundingExec?.liveProviderPosted === true) posts.funding += 1;
      if (plan.funding_intent?.idempotency_key && memory.updateIntent) {
        await memory.updateIntent(plan.funding_intent.idempotency_key, {
          ...plan.funding_intent,
          status: fundingExec?.outcome === 'posted'
            ? (fundingExec.provider_status || 'pending')
            : (fundingExec?.outcome === 'unknown' || fundingExec?.outcome === 'unknown_no_retry' ? 'unknown' : plan.funding_intent.status),
          provider_transfer_id: fundingExec?.provider_transfer_id || plan.funding_intent.provider_transfer_id,
          provider_metadata: {
            ...(plan.funding_intent.provider_metadata || {}),
            post_attempted: fundingExec?.liveProviderCalled === true,
            post_outcome: fundingExec?.outcome || null,
          },
        });
      }
    } else if (transferPostEnabled !== true) {
      fundingExec = await executeFunding({
        credentials,
        productionPublicKey,
        productionSecretKey,
        binding: fundBinding,
        intent: plan.funding_intent,
        transferPostEnabled: false,
        productionTransferPostEnabled: false,
        fetchImpl,
      });
    }
  }

  if (typeof refreshLiveWallet === 'function') {
    const live = await refreshLiveWallet();
    availableCents = amountCentsOf(live?.availableBalance ?? live?.available ?? live);
  }
  const storedFunding = plan.funding_intent?.idempotency_key
    ? await memory.getIntent(plan.funding_intent.idempotency_key)
    : null;
  if (storedFunding) {
    rows = [
      ...rows.filter((row) => row.idempotency_key !== storedFunding.idempotency_key),
      storedFunding,
    ];
    fundingRecon = await applyFallback({
      client,
      intent: storedFunding,
      store: memory,
      getTransfer,
    });
    if (fundingRecon.intent?.idempotency_key) {
      rows = [
        ...rows.filter((row) => row.idempotency_key !== fundingRecon.intent.idempotency_key),
        fundingRecon.intent,
      ];
    }
  }
  plan = await planOnce(rows);

  const payoutGateBlocked = plan.payout_submittable !== true
    || plan.payout_state !== 'payout_ready'
    || availableCents < payoutCents
    || fundingBlockedPayout
    || ['funding_pending', 'funding_submitting', 'funding_submitted', 'funding_unknown', 'funding_failed', 'funding_returned'].includes(plan.funding_state);

  let payoutExec = null;
  if (plan.payout_intent && persistMoneyIntents) {
    await persistSandboxPayoutIntent(memory, plan.payout_intent);
  }
  const canPostPayout = plan.payout_submittable === true
    && transferPostEnabled === true
    && productionTransferPostEnabled !== true
    && availableCents >= payoutCents
    && !payoutGateBlocked;
  if (canPostPayout) {
    payoutExec = await executePayout({
      credentials,
      productionPublicKey,
      productionSecretKey,
      binding: payoutBinding,
      intent: plan.payout_intent,
      transferPostEnabled: true,
      productionTransferPostEnabled: false,
      fetchImpl,
    });
    if (payoutExec?.liveProviderPosted === true) posts.payout += 1;
    if (plan.payout_intent?.idempotency_key && memory.updateIntent) {
      await memory.updateIntent(plan.payout_intent.idempotency_key, {
        ...plan.payout_intent,
        status: payoutExec?.outcome === 'posted'
          ? (payoutExec.provider_status || 'pending')
          : (payoutExec?.outcome === 'unknown' || payoutExec?.outcome === 'unknown_no_retry' ? 'unknown' : plan.payout_intent.status),
        provider_transfer_id: payoutExec?.provider_transfer_id || plan.payout_intent.provider_transfer_id,
        provider_metadata: {
          ...(plan.payout_intent.provider_metadata || {}),
          post_attempted: payoutExec?.liveProviderCalled === true,
          post_outcome: payoutExec?.outcome || null,
        },
      });
    }
  } else if (transferPostEnabled !== true && !payoutGateBlocked) {
    payoutExec = await executePayout({
      credentials,
      productionPublicKey,
      productionSecretKey,
      binding: payoutBinding,
      intent: plan.payout_intent,
      transferPostEnabled: false,
      productionTransferPostEnabled: false,
      fetchImpl,
    });
  }

  const storedPayout = plan.payout_intent?.idempotency_key
    ? await memory.getIntent(plan.payout_intent.idempotency_key)
    : null;
  if (storedPayout) {
    rows = [
      ...rows.filter((row) => row.idempotency_key !== storedPayout.idempotency_key),
      storedPayout,
    ];
  }

  let payoutRecon = await applyFallback({
    client,
    intent: storedPayout || payoutRow(),
    store: memory,
    getTransfer,
  });
  if (payoutRecon.intent?.idempotency_key) {
    rows = [
      ...rows.filter((row) => row.idempotency_key !== payoutRecon.intent.idempotency_key),
      payoutRecon.intent,
    ];
  }
  plan = await planOnce(rows);

  const finished = plan.payout_state === 'payout_completed' || plan.payout_state === 'payout_failed';
  sequence.push(plan.funding_state || (plan.decision === DECISION.PAYOUT_READY ? 'payout_ready' : 'funding_required'));
  sequence.push(plan.payout_state);

  return {
    ok: true,
    phase: M711_PHASE,
    environment: 'sandbox',
    tenant_id: tenantId,
    sequence_started: 'payout_requested',
    wallet_check: true,
    live_balance_authority: true,
    rds_balance_ignored: rdsAvailableCents != null,
    available_cents: availableCents,
    rds_available_cents: rdsAvailableCents,
    payout_cents: payoutCents,
    shortfall_cents: plan.shortfall_cents,
    exact_shortfall: plan.shortfall_cents,
    decision: plan.decision,
    funding_state: plan.funding_state,
    payout_state: plan.payout_state,
    funding_gate: Boolean(
      plan.decision === DECISION.FUND_FIRST
      && plan.funding_state !== 'funding_completed'
    ),
    payout_release_gate: availableCents >= payoutCents
      && (plan.decision === DECISION.PAYOUT_READY
        || plan.funding_state === 'funding_completed'
        || plan.funding_state == null)
      && !['funding_pending', 'funding_submitting', 'funding_submitted', 'funding_unknown', 'funding_failed', 'funding_returned'].includes(plan.funding_state),
    funding_intent: plan.funding_intent,
    payout_intent: plan.payout_intent,
    funding_post_allowed: plan.funding_post_allowed,
    payout_submittable: plan.payout_submittable,
    funding_exec: fundingExec,
    payout_exec: payoutExec,
    funding_recon: fundingRecon,
    payout_recon: payoutRecon,
    sandbox_provider_posts: posts.funding + posts.payout,
    funding_provider_posts: posts.funding,
    payout_provider_posts: posts.payout,
    production_provider_posts: 0,
    liveProviderPosted: (posts.funding + posts.payout) > 0,
    createdPaymentTransfer: persistMoneyIntents === true && Boolean(plan.created_payment_transfer),
    persist_money_intents: persistMoneyIntents === true,
    transfer_post_enabled: transferPostEnabled === true,
    production_post_enabled: false,
    duplicate_funding_prevented: true,
    duplicate_payout_prevented: true,
    unknown_no_retry: fundingExec?.doNotRetry === true || payoutExec?.doNotRetry === true
      || plan.funding_state === 'funding_unknown'
      || plan.payout_state === 'payout_unknown',
    webhook_recon: Boolean(applyWebhookPayload),
    get_fallback: Boolean(getTransfer),
    finished,
    blocked_reasons: plan.blocked_reasons,
    payout_operation_id: plan.payout_operation_id,
    productionMoneyMoved: false,
    freedomChanged: false,
    sweepChanged: false,
  };
}

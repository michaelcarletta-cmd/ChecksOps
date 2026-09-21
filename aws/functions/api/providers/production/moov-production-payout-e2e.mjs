/**
 * M7.14 production end-to-end wrapper for the Freedom first-test penny.
 *
 * Same shared orchestratePayout machine proven by M7.12. Production-specific
 * authorization and object bindings only. MUST_KEEP fund/disburse writers are
 * contained as primitives and cannot orchestrate independently.
 *
 * This phase never POSTs, never consumes TOTP, and defaults persist off.
 */
import { extractTransferEvent, normalizeMoovStatus } from '../moov-lifecycle.mjs';
import { reconcileExistingFromProviderGet } from '../webhook-apply-production.mjs';
import { KNOWN_APPROVED_MOOV } from './moov-accounts.mjs';
import {
  FIRST_PRODUCTION_TRANSFER_CENTS,
  firstTestDisburseBinding,
  firstTestFundBinding,
} from './moov-first-test.mjs';
import {
  CONSUME_TOTP_THIS_PHASE,
  DECISION,
  PERSIST_MONEY_INTENTS_THIS_PHASE,
  applyGetFallbackToIntent,
  createMemoryPayoutStore,
  getReconciliationMayCreateMoneyIntent,
  orchestratePayout,
  payoutOperationIdFor,
  webhookMayCreateMoneyIntent,
} from './moov-payout-orchestrator.mjs';
import { PIPELINE_TEST_TENANT_ID } from './moov-sandbox-wallet-fund.mjs';
import {
  evaluateProductionPennyAuthorization,
  evaluateProductionPennySweepRace,
} from './moov-production-penny-authz.mjs';
import {
  M714_PHASE,
  executeProductionWalletDisbursement,
  executeProductionWalletFunding,
  persistProductionIntentCas,
  refuseIndependentMustKeepInvocation,
} from './moov-production-transfer-primitives.mjs';

export { evaluateProductionPennySweepRace } from './moov-production-penny-authz.mjs';

export const PRODUCTION_E2E_PAYOUT_CENTS = FIRST_PRODUCTION_TRANSFER_CENTS;
export const FREEDOM_PRODUCTION_TENANT_ID = KNOWN_APPROVED_MOOV.freedom.tenantId;

export const m714PayoutOperationId = () => payoutOperationIdFor({
  tenantId: FREEDOM_PRODUCTION_TENANT_ID,
  environment: 'production',
  recipientId: KNOWN_APPROVED_MOOV.recipient.recipientId,
  payoutCents: PRODUCTION_E2E_PAYOUT_CENTS,
});

const fail = (error, extra = {}) => ({
  ok: false,
  error,
  phase: M714_PHASE,
  environment: 'production',
  liveProviderPosted: false,
  createdPaymentTransfer: extra.createdPaymentTransfer === true,
  productionMoneyMoved: false,
  totp_consumed: false,
  require_totp: true,
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

const snapshotTransfer = (json) => {
  const extracted = extractTransferEvent(json?.data ? json : { data: json });
  return {
    id: extracted.transferId || json?.transferID || json?.transferId || json?.id || null,
    status: extracted.status || normalizeMoovStatus(json?.status),
    providerStatus: json?.status || extracted.providerStatus || null,
    completedOn: extracted.completedOn || json?.completedOn || json?.destination?.achDetails?.completedOn || null,
    amountCents: extracted.amountCents ?? amountCentsOf(json?.amount),
  };
};

const applyFallback = async ({ client, intent, store, getTransfer, environment = 'production' }) => {
  if (!intent?.provider_transfer_id) {
    return { applied: false, skipped: 'no_provider_transfer_id', intent, liveProviderPosted: false, createdPaymentTransfer: false };
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
    return { applied: false, skipped: 'provider_get_missing', intent, liveProviderPosted: false, createdPaymentTransfer: false };
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

export async function executeProductionPayoutE2e({
  tenantId,
  tenantEnvironment,
  liveAvailableCents,
  rdsAvailableCents = null,
  payoutCents = PRODUCTION_E2E_PAYOUT_CENTS,
  recipientVerified = false,
  credentials = null,
  sandboxPublicKey = null,
  sandboxSecretKey = null,
  transferPostEnabled = false,
  sandboxTransferPostEnabled = false,
  persistMoneyIntents = PERSIST_MONEY_INTENTS_THIS_PHASE,
  store = null,
  existingRows = [],
  sweepActivity = [],
  totpFundPresent = false,
  totpDisbursePresent = false,
  totpFundValid = false,
  totpDisburseValid = false,
  totpCode = null,
  identityOk = true,
  membershipOk = true,
  roles = ['owner'],
  client = null,
  getTransfer = null,
  refreshLiveWallet = null,
  applyWebhookPayload = null,
  fetchImpl = fetch,
  executeFunding = executeProductionWalletFunding,
  executePayout = executeProductionWalletDisbursement,
  operationId = null,
  postPhase = 'none',
  independentMustKeepInvocation = false,
} = {}) {
  if (totpCode) return fail('totp_code_refused', { message: 'Cursor must never receive a Financial TOTP code.' });
  if (independentMustKeepInvocation === true) {
    return refuseIndependentMustKeepInvocation('moov-wallet-fund');
  }
  if (tenantEnvironment !== 'production') return fail('tenant_not_production', { tenantEnvironment });
  if (!tenantId || tenantId === PIPELINE_TEST_TENANT_ID) return fail('refused_sandbox_tenant', { tenantId });
  if (tenantId !== FREEDOM_PRODUCTION_TENANT_ID) return fail('undesignated_tenant', { tenantId });
  if (sandboxTransferPostEnabled === true) return fail('sandbox_post_flag_refused');
  if (Number(payoutCents) !== PRODUCTION_E2E_PAYOUT_CENTS) {
    return fail('amount_not_one_cent', { payoutCents });
  }
  if (liveAvailableCents === undefined || liveAvailableCents === null) {
    return fail('live_balance_required', { message: 'RDS wallet cache is not authority for funding.' });
  }
  if (credentials && credentials.environment !== 'production') {
    return fail('cross_environment_credential_refused');
  }

  const fundAuthz = evaluateProductionPennyAuthorization({
    operation: 'wallet_fund',
    tenantId,
    environment: 'production',
    identityOk,
    membershipOk,
    roles,
    totpPresent: totpFundPresent,
    totpValid: totpFundValid,
  });
  const disburseAuthz = evaluateProductionPennyAuthorization({
    operation: 'wallet_disburse',
    tenantId,
    environment: 'production',
    identityOk,
    membershipOk,
    roles,
    totpPresent: totpDisbursePresent,
    totpValid: totpDisburseValid,
  });

  const memory = store || (persistMoneyIntents === true ? createMemoryPayoutStore() : null);
  let availableCents = Number(liveAvailableCents);
  const posts = { funding: 0, payout: 0 };
  const fundBinding = firstTestFundBinding();
  const disburseBinding = firstTestDisburseBinding();
  const labels = {
    fund: {
      sourceLabel: fundBinding.sourceLabel,
      destinationLabel: fundBinding.destinationLabel,
      bankId: fundBinding.bankId,
      walletId: fundBinding.walletId,
      sourcePaymentMethodId: fundBinding.sourcePaymentMethodId,
      destinationPaymentMethodId: fundBinding.destinationPaymentMethodId,
    },
    disburse: {
      sourceLabel: disburseBinding.sourceLabel,
      destinationLabel: disburseBinding.destinationLabel,
      recipientLabel: disburseBinding.recipientLabel,
      recipientId: disburseBinding.recipientId,
    },
  };

  const planOnce = async (rows) => orchestratePayout({
    availableCents,
    payoutCents,
    recipientVerified,
    totpFundPresent: totpFundPresent === true && totpFundValid === true,
    totpDisbursePresent: totpDisbursePresent === true && totpDisburseValid === true,
    requireTotp: true,
    transferPostEnabled: transferPostEnabled === true && sandboxTransferPostEnabled !== true,
    persistMoneyIntents,
    store: memory,
    existingRows: rows,
    sweepActivity,
    environment: 'production',
    tenantId,
    labels,
    rdsAvailableCents,
    operationId,
  });

  let rows = [...existingRows];
  let plan = await planOnce(rows);

  const fundingRow = () => rows.find((row) => String(row.leg_role || row.kind || '') === 'wallet_funding') || plan.funding_intent;
  const payoutRow = () => rows.find((row) => String(row.leg_role || row.kind || '') === 'wallet_disbursement') || plan.payout_intent;

  if (applyWebhookPayload) {
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
          if (row.idempotency_key && memory?.updateIntent) {
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

  const sweepRace = evaluateProductionPennySweepRace({
    fundingState: plan.funding_state,
    liveAvailableCents: availableCents,
    payoutCents,
    mayCreateSecondFunding: plan.may_create_second_funding,
  });

  let fundingPersist = null;
  let fundingExec = null;
  const allowFundingPersist = persistMoneyIntents === true && plan.funding_intent;
  if (allowFundingPersist) {
    fundingPersist = await persistProductionIntentCas(memory, plan.funding_intent);
    if (fundingPersist.intent?.idempotency_key) {
      rows = [
        ...rows.filter((row) => row.idempotency_key !== fundingPersist.intent.idempotency_key),
        fundingPersist.intent,
      ];
    }
  }

  const canAttemptFundingPrimitive = plan.decision === DECISION.FUND_FIRST && plan.funding_intent;
  if (canAttemptFundingPrimitive) {
    fundingExec = await executeFunding({
      credentials,
      sandboxPublicKey,
      sandboxSecretKey,
      binding: {
        ...fundBinding,
        amountCents: PRODUCTION_E2E_PAYOUT_CENTS,
        accountId: KNOWN_APPROVED_MOOV.freedom.moovAccountId,
        platformAccountId: KNOWN_APPROVED_MOOV.platform.moovAccountId,
        idempotencyKey: plan.funding_intent.idempotency_key,
      },
      intent: fundingPersist?.intent || plan.funding_intent,
      transferPostEnabled,
      sandboxTransferPostEnabled,
      persistDone: fundingPersist?.persisted === true,
      orchestratorAllows: plan.funding_post_allowed === true,
      totpPresent: totpFundPresent,
      totpValid: totpFundValid,
      fetchImpl,
    });
    if (fundingExec?.liveProviderPosted === true) posts.funding += 1;
  }

  if (typeof refreshLiveWallet === 'function') {
    const live = await refreshLiveWallet();
    availableCents = amountCentsOf(live?.availableBalance ?? live?.available ?? live);
  }
  const storedFunding = plan.funding_intent?.idempotency_key && memory
    ? await memory.getIntent(plan.funding_intent.idempotency_key)
    : null;
  if (storedFunding) {
    rows = [
      ...rows.filter((row) => row.idempotency_key !== storedFunding.idempotency_key),
      storedFunding,
    ];
  }
  plan = await planOnce(rows);

  let payoutPersist = null;
  let payoutExec = null;
  if (plan.payout_intent && persistMoneyIntents === true) {
    payoutPersist = await persistProductionIntentCas(memory, plan.payout_intent);
  }
  const haltAfterFunding = postPhase === 'funding' || postPhase === 'none';
  const canAttemptPayoutPrimitive = plan.payout_intent
    && postPhase === 'payout'
    && haltAfterFunding !== true;
  if (canAttemptPayoutPrimitive) {
    payoutExec = await executePayout({
      credentials,
      sandboxPublicKey,
      sandboxSecretKey,
      binding: {
        ...disburseBinding,
        amountCents: PRODUCTION_E2E_PAYOUT_CENTS,
        accountId: KNOWN_APPROVED_MOOV.freedom.moovAccountId,
        platformAccountId: KNOWN_APPROVED_MOOV.platform.moovAccountId,
        idempotencyKey: plan.payout_intent.idempotency_key,
      },
      intent: payoutPersist?.intent || plan.payout_intent,
      transferPostEnabled,
      sandboxTransferPostEnabled,
      persistDone: payoutPersist?.persisted === true,
      orchestratorAllows: plan.payout_submittable === true,
      totpPresent: totpDisbursePresent,
      totpValid: totpDisburseValid,
      fetchImpl,
    });
    if (payoutExec?.liveProviderPosted === true) posts.payout += 1;
  }

  const storedPayout = plan.payout_intent?.idempotency_key && memory
    ? await memory.getIntent(plan.payout_intent.idempotency_key)
    : null;
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

  return {
    ok: true,
    phase: M714_PHASE,
    environment: 'production',
    tenant_id: tenantId,
    live_balance_authority: true,
    rds_balance_ignored: rdsAvailableCents != null,
    available_cents: availableCents,
    rds_available_cents: rdsAvailableCents,
    payout_cents: payoutCents,
    shortfall_cents: plan.shortfall_cents,
    decision: plan.decision,
    funding_state: plan.funding_state,
    payout_state: plan.payout_state,
    funding_intent: plan.funding_intent,
    payout_intent: plan.payout_intent,
    funding_post_allowed: plan.funding_post_allowed,
    payout_submittable: plan.payout_submittable,
    funding_persist: fundingPersist,
    payout_persist: payoutPersist,
    funding_exec: fundingExec,
    payout_exec: payoutExec,
    funding_recon: fundingRecon,
    payout_recon: payoutRecon,
    sweep_race: sweepRace,
    production_provider_posts: posts.funding + posts.payout,
    funding_provider_posts: posts.funding,
    payout_provider_posts: posts.payout,
    liveProviderPosted: (posts.funding + posts.payout) > 0,
    createdPaymentTransfer: persistMoneyIntents === true && Boolean(plan.created_payment_transfer),
    persist_money_intents: persistMoneyIntents === true,
    transfer_post_enabled: transferPostEnabled === true,
    sandbox_post_enabled: false,
    duplicate_funding_prevented: true,
    duplicate_payout_prevented: true,
    may_create_second_funding: plan.may_create_second_funding,
    may_create_second_payout: plan.may_create_second_payout,
    unknown_no_retry: fundingExec?.doNotRetry === true || payoutExec?.doNotRetry === true
      || plan.funding_state === 'funding_unknown'
      || plan.payout_state === 'payout_unknown',
    require_totp: true,
    totp_consumed: false,
    consume_totp_this_phase: CONSUME_TOTP_THIS_PHASE === true,
    fund_authz: fundAuthz,
    disburse_authz: disburseAuthz,
    blocked_reasons: plan.blocked_reasons,
    payout_operation_id: plan.payout_operation_id,
    post_phase: postPhase,
    productionMoneyMoved: false,
    sweepChanged: false,
    webhook_may_create_intent: webhookMayCreateMoneyIntent(),
    get_recon_may_create_transfer: getReconciliationMayCreateMoneyIntent(),
  };
}

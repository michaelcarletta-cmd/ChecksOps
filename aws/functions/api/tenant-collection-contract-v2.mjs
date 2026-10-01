/**
 * Proposed Tenant Collection Contract v2.
 * Evaluates fixtures only. Does not call AWS, Moov, or SQL.
 * Does not replace the accepted Freedom funding contract.
 */
import {
  CHECKSOPS_PLATFORM_ACCOUNT_ID,
  CHECKSOPS_PLATFORM_WALLET_PM_ID,
  CHECKSOPS_SANDBOX_MERCHANT_ACCOUNT_ID,
  COLLECTION_CONTRACT_ID,
  COLLECTION_CONTRACT_STATUS,
  COLLECTION_CONTRACT_VERSION,
  FALLBACK_SELECTIONS,
  LEG_TYPE,
  isSettlementReceived,
  receivedCentsFromLegs,
  remainingUnpaidCents,
  splitCollectionAmounts,
} from './tenant-collection-v2.mjs';

export const TENANT_COLLECTION_CONTRACT_V2 = Object.freeze({
  id: COLLECTION_CONTRACT_ID,
  version: COLLECTION_CONTRACT_VERSION,
  status: COLLECTION_CONTRACT_STATUS,
  environment: 'staging',
  production_accepted: false,
  preserves: [
    'explicit tenant identity',
    'explicit production environment',
    'explicit source',
    'explicit ChecksOps destination',
    'tenant isolation',
    'idempotency',
    'provider/local reconciliation',
    'fail closed',
    'no first-wallet fallback',
    'no first-bank fallback',
  ],
  adds: [
    'wallet-first',
    'bank-remainder-only',
    'one-obligation/multiple-leg model',
    'provider-timeout reconciliation',
    'partial-payment preservation',
    'settlement-aware receivables',
    'retry-only-unpaid-remainder',
  ],
});

const asCents = (value) => Math.max(0, Math.trunc(Number(value) || 0));

export function evaluateCollectionOperation(operation, contract = TENANT_COLLECTION_CONTRACT_V2) {
  const errors = [];
  if (!operation || typeof operation !== 'object') {
    return { ok: false, errors: ['collection operation is missing'], contract };
  }

  const env = String(operation.environment || '').toLowerCase();
  const source = operation.source || {};
  const destination = operation.destination || {};
  const legs = Array.isArray(operation.legs) ? operation.legs : [];
  const amountDue = asCents(operation.amount_due_cents);
  const split = operation.split || splitCollectionAmounts({
    amountDueCents: amountDue,
    availableWalletCents: operation.available_wallet_cents,
    pendingWalletCents: operation.pending_wallet_cents,
  });

  if (contract.status !== 'PROPOSED / STAGING') {
    errors.push('collection contract must remain PROPOSED / STAGING');
  }
  if (contract.production_accepted === true) {
    errors.push('collection contract is not production accepted');
  }
  if (!operation.tenant_id) errors.push('explicit tenant identity is required');
  if (!env) errors.push('explicit environment is required');
  if (env === 'production' && (
    source.sandbox === true
    || destination.sandbox === true
    || operation.moovEnvironment === 'sandbox'
    || source.accountId === CHECKSOPS_SANDBOX_MERCHANT_ACCOUNT_ID
  )) {
    errors.push('sandbox resource used in production-mode fixture');
  }
  if (destination.accountId && destination.accountId !== CHECKSOPS_PLATFORM_ACCOUNT_ID && env === 'production') {
    errors.push('destination is not the ChecksOps platform account');
  }
  if (destination.paymentMethodId && destination.paymentMethodId !== CHECKSOPS_PLATFORM_WALLET_PM_ID && env === 'production') {
    errors.push('destination is not the ChecksOps platform wallet payment method');
  }
  if (source.accountId === CHECKSOPS_PLATFORM_ACCOUNT_ID) {
    errors.push('ChecksOps platform account used as source');
  }
  if (source.selection && FALLBACK_SELECTIONS.has(source.selection)) {
    errors.push(`fallback selection refused: ${source.selection}`);
  }
  if (destination.selection && FALLBACK_SELECTIONS.has(destination.selection)) {
    errors.push(`fallback selection refused: ${destination.selection}`);
  }
  if (operation.cross_tenant_wallet === true) errors.push('cross-tenant wallet attempt');
  if (operation.cross_tenant_bank === true) errors.push('cross-tenant bank attempt');
  if (source.paymentMethodId && destination.paymentMethodId
    && source.paymentMethodId === destination.paymentMethodId
    && source.accountId === destination.accountId) {
    errors.push('source/destination reversal');
  }

  const walletLegs = legs.filter((leg) => leg.leg_type === LEG_TYPE.WALLET);
  const bankLegs = legs.filter((leg) => leg.leg_type === LEG_TYPE.BANK);
  if (walletLegs.length > 1) errors.push('duplicate wallet leg');
  if (bankLegs.length > 1) errors.push('duplicate bank leg');

  const createdWallet = walletLegs.find((leg) => leg.provider_transfer_id || leg.outcome === 'created');
  const bank = bankLegs[0];
  if (createdWallet && bank && asCents(bank.amount_cents) === amountDue && asCents(createdWallet.amount_cents) > 0) {
    errors.push('bank charged full amount after partial wallet success');
  }
  if (split.walletAmountCents > 0 && split.bankAmountCents !== amountDue - split.walletAmountCents) {
    errors.push('bank remainder does not equal unpaid amount');
  }
  if (operation.used_pending_wallet === true || (asCents(operation.pending_wallet_cents) > 0
    && asCents(operation.available_wallet_cents) === 0
    && split.walletAmountCents > 0)) {
    errors.push('pending wallet funds were collected');
  }

  const received = operation.amount_received_cents != null
    ? asCents(operation.amount_received_cents)
    : receivedCentsFromLegs(legs);
  const pendingCounted = legs.some((leg) => (
    !isSettlementReceived(leg.provider_status || leg.status)
    && asCents(operation.received_from_leg?.[leg.idempotency_key]) > 0
  ));
  if (pendingCounted) errors.push('pending/originated counted as received');
  if (operation.count_pending_as_received === true) {
    errors.push('pending/originated counted as received');
  }
  for (const leg of legs) {
    if (!isSettlementReceived(leg.provider_status || leg.status) && operation.force_received_cents > 0) {
      errors.push('pending/originated counted as received');
      break;
    }
  }

  const obligationIds = new Set(legs.map((leg) => leg.obligation_id).filter(Boolean));
  if (legs.length > 1 && obligationIds.size > 1) {
    errors.push('legs do not map to one billing obligation');
  }
  if (operation.double_counted === true) {
    errors.push('receivables totals double counted');
  }
  if (operation.amount_mismatch === true) errors.push('amount mismatch');
  if (operation.provider_local_status_mismatch === true) errors.push('provider/local status mismatch');

  if (operation.retry === true) {
    const remaining = remainingUnpaidCents({ amountDueCents: amountDue, legs: operation.prior_legs || [] });
    if (asCents(operation.retry_amount_cents) > remaining) {
      errors.push('retry exceeded verified unpaid remainder');
    }
  }

  if (operation.wallet_posted && operation.bank_posted && !operation.wallet_reconciled_before_bank) {
    errors.push('wallet-first ordering was not reconciled before bank');
  }

  return {
    ok: errors.length === 0,
    errors,
    contract,
    split,
    received_cents: received,
  };
}

export function mustFailContract(operation, needle) {
  const evaluated = evaluateCollectionOperation(operation);
  const matched = evaluated.errors.some((error) => String(error).includes(needle));
  return { ...evaluated, ok: false, matched, must_fail: true };
}

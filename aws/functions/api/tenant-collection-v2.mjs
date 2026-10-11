/**
 * Tenant Collection Contract v2 — wallet first, bank remainder.
 * PROPOSED / STAGING. Does not create Moov accounts, wallets, banks, or destinations.
 *
 * Production monthly billing POST remains independently gated.
 * This module never treats SUBMITTED / PENDING / ORIGINATED as received.
 */
export const COLLECTION_CONTRACT_ID = 'tenant-collection-v2';
export const COLLECTION_CONTRACT_VERSION = '2.0.0';
export const COLLECTION_CONTRACT_STATUS = 'PROPOSED / STAGING';

export const CHECKSOPS_PLATFORM_ACCOUNT_ID = '41cb5d67-4911-4bef-aad5-d8ee9c582208';
export const CHECKSOPS_PLATFORM_WALLET_ID = '72630a70-4954-4761-b652-e8beff1ad02c';
export const CHECKSOPS_PLATFORM_WALLET_PM_ID = 'c70a90f2-9bcc-4084-8263-d5a0fb5d806c';
export const CHECKSOPS_SANDBOX_MERCHANT_ACCOUNT_ID = '36b79957-ce7a-4ca7-a68f-30986c9e47bb';

export const LEG_TYPE = Object.freeze({
  WALLET: 'wallet',
  BANK: 'ach_debit',
});

export const COLLECTION_STATUS = Object.freeze({
  DUE: 'DUE',
  WALLET_PENDING: 'WALLET_PENDING',
  BANK_PENDING: 'BANK_PENDING',
  BOTH_PENDING: 'BOTH_PENDING',
  PARTIALLY_PAID: 'PARTIALLY_PAID',
  PARTIALLY_PAID_BANK_FAILED: 'PARTIALLY PAID / BANK FAILED',
  PAID: 'PAID',
  FAILED: 'FAILED',
  RECONCILIATION_REQUIRED: 'RECONCILIATION REQUIRED',
});

export const SETTLED_STATUSES = new Set(['completed', 'settled', 'succeeded']);
export const IN_FLIGHT_STATUSES = new Set([
  'submitted', 'pending', 'originated', 'originating', 'queued', 'created', 'processing',
]);
export const FAILED_STATUSES = new Set(['failed', 'failure', 'returned', 'reversed', 'canceled', 'cancelled']);
export const FALLBACK_SELECTIONS = new Set([
  'first_wallet', 'first_bank', 'first_available_payment_method',
  'other_tenant_source', 'platform_bank_as_source', 'sandbox_in_production',
]);
export const WALLET_FALLBACK_SELECTIONS = new Set([
  'first_wallet', 'first_available_payment_method', 'other_tenant_source',
]);
export const BANK_FALLBACK_SELECTIONS = new Set([
  'first_bank', 'first_available_payment_method', 'platform_bank_as_source',
]);

const asCents = (value) => {
  const n = Math.trunc(Number(value) || 0);
  return Number.isFinite(n) ? Math.max(0, n) : 0;
};

const statusOf = (row) => String(row?.provider_status || row?.status || '').toLowerCase();

export const isSettlementReceived = (status) => SETTLED_STATUSES.has(String(status || '').toLowerCase());
export const isInFlight = (status) => IN_FLIGHT_STATUSES.has(String(status || '').toLowerCase());
export const isFailedStatus = (status) => FAILED_STATUSES.has(String(status || '').toLowerCase());

export const isTimeoutOrUnknown = (error) => {
  if (!error) return false;
  if (error.unknown === true || error.reconciliation_required === true) return true;
  const message = String(error.message || error.code || error).toLowerCase();
  return [
    'timeout', 'timed out', 'etimedout', 'econnreset', 'network', 'unknown',
    'socket hang up', 'aborted', 'und_err_connect',
  ].some((needle) => message.includes(needle));
};

export const obligationIdentity = ({
  tenantId, billingPeriod, billingType = 'monthly_subscription',
}) => `${billingType}:${tenantId}:${billingPeriod}`;

export const walletLegIdempotencyKey = ({ tenantId, billingPeriod }) => (
  `billing-${billingPeriod}-${tenantId}-wallet`
);

export const bankLegIdempotencyKey = ({ tenantId, billingPeriod }) => (
  `billing-${billingPeriod}-${tenantId}-bank`
);

export const splitCollectionAmounts = ({
  amountDueCents,
  availableWalletCents,
  pendingWalletCents = 0,
} = {}) => {
  const amountDue = asCents(amountDueCents);
  const available = asCents(availableWalletCents);
  // Pending is recorded for visibility only. It is never collected.
  const pending = asCents(pendingWalletCents);
  const walletAmountCents = Math.min(amountDue, available);
  return {
    amountDueCents: amountDue,
    availableWalletCents: available,
    pendingWalletCents: pending,
    pendingExcludedCents: pending,
    walletAmountCents,
    bankAmountCents: amountDue - walletAmountCents,
  };
};

export const receivedCentsFromLegs = (legs = []) => (
  legs.reduce((sum, leg) => (
    sum + (isSettlementReceived(statusOf(leg)) ? asCents(leg.amount_cents) : 0)
  ), 0)
);

export const occupiedCentsFromLegs = (legs = []) => (
  legs.reduce((sum, leg) => {
    if (leg?.reconciliation_required || leg?.outcome === 'unknown') {
      return sum + asCents(leg.amount_cents);
    }
    if (isFailedStatus(statusOf(leg)) && !leg.provider_transfer_id) return sum;
    if (leg?.outcome === 'not_created') return sum;
    if (leg?.provider_transfer_id || isInFlight(statusOf(leg)) || isSettlementReceived(statusOf(leg))) {
      return sum + asCents(leg.amount_cents);
    }
    return sum;
  }, 0)
);

export const remainingUnpaidCents = ({ amountDueCents, legs = [] } = {}) => (
  Math.max(0, asCents(amountDueCents) - occupiedCentsFromLegs(legs))
);

export const appliedCents = (legs = [], type) => (
  legs
    .filter((leg) => leg.leg_type === type && !isFailedStatus(statusOf(leg)))
    .reduce((sum, leg) => sum + asCents(leg.amount_cents), 0)
);

export const classifyCollectionStatus = ({ amountDueCents, legs = [] } = {}) => {
  const due = asCents(amountDueCents);
  const received = receivedCentsFromLegs(legs);
  if (legs.some((leg) => leg.reconciliation_required || leg.outcome === 'unknown')) {
    return COLLECTION_STATUS.RECONCILIATION_REQUIRED;
  }
  const wallet = legs.find((leg) => leg.leg_type === LEG_TYPE.WALLET);
  const bank = legs.find((leg) => leg.leg_type === LEG_TYPE.BANK);
  if (due > 0 && received >= due) return COLLECTION_STATUS.PAID;
  const walletCreated = wallet && (
    isSettlementReceived(statusOf(wallet))
    || isInFlight(statusOf(wallet))
    || Boolean(wallet.provider_transfer_id)
  );
  const bankFailed = bank && isFailedStatus(statusOf(bank));
  if (walletCreated && bankFailed && received < due) {
    return COLLECTION_STATUS.PARTIALLY_PAID_BANK_FAILED;
  }
  if (received > 0 && received < due) return COLLECTION_STATUS.PARTIALLY_PAID;
  const walletInFlight = wallet && isInFlight(statusOf(wallet));
  const bankInFlight = bank && isInFlight(statusOf(bank));
  if (walletInFlight && bankInFlight) return COLLECTION_STATUS.BOTH_PENDING;
  if (walletInFlight) return COLLECTION_STATUS.WALLET_PENDING;
  if (bankInFlight) return COLLECTION_STATUS.BANK_PENDING;
  if (legs.some((leg) => isFailedStatus(statusOf(leg)))) return COLLECTION_STATUS.FAILED;
  return COLLECTION_STATUS.DUE;
};

export const createMemoryCollectionStore = () => {
  const obligations = new Map();
  const legs = new Map();
  return {
    async getObligation(id) {
      return obligations.get(id) || null;
    },
    async putObligation(row) {
      obligations.set(row.id, { ...row });
      return obligations.get(row.id);
    },
    async getLeg(idempotencyKey) {
      return legs.get(idempotencyKey) || null;
    },
    async putLeg(row) {
      if (typeof this.failPersist === 'function' && this.failPersist(row)) {
        const error = new Error('local_persistence_failed');
        error.code = 'LOCAL_PERSISTENCE_FAILED';
        throw error;
      }
      legs.set(row.idempotency_key, { ...row });
      return legs.get(row.idempotency_key);
    },
    async listLegs(obligationId) {
      return [...legs.values()].filter((row) => row.obligation_id === obligationId);
    },
    snapshot() {
      return {
        obligations: [...obligations.values()],
        legs: [...legs.values()],
      };
    },
  };
};

export async function createPostgresCollectionStore(client) {
  return {
    async getObligation(id) {
      return (await client.query(
        `SELECT * FROM public.tenant_maintenance_payments WHERE id = $1::uuid LIMIT 1`,
        [id],
      ).catch(() => ({ rows: [] }))).rows[0] || null;
    },
    async putObligation(row) {
      if (!row?.id) return row;
      const notesSuffix = row.collection_notes ? ` · collection_v2:${row.collection_notes}` : '';
      return (await client.query(
        `UPDATE public.tenant_maintenance_payments SET
           status = COALESCE($2, status),
           failure_reason = $3,
           notes = CASE
             WHEN $4 = '' THEN notes
             WHEN COALESCE(notes, '') LIKE '%collection_v2:%' THEN notes
             ELSE COALESCE(notes, '') || $4
           END,
           provider_transfer_id = COALESCE($5, provider_transfer_id),
           submitted_at = CASE
             WHEN $2 IN ('submitted', 'failed') THEN COALESCE(submitted_at, now())
             ELSE submitted_at
           END
         WHERE id = $1::uuid
         RETURNING *`,
        [
          row.id,
          row.status || null,
          row.failure_reason || null,
          notesSuffix,
          row.provider_transfer_id || null,
        ],
      ).catch(() => ({ rows: [row] }))).rows[0] || row;
    },
    async getLeg(idempotencyKey) {
      return (await client.query(
        `SELECT * FROM public.payment_transfers
         WHERE idempotency_key = $1
         LIMIT 1`,
        [idempotencyKey],
      ).catch(() => ({ rows: [] }))).rows[0] || null;
    },
    async putLeg(row) {
      const metadata = JSON.stringify({
        collection_contract: COLLECTION_CONTRACT_ID,
        obligation_id: row.obligation_id,
        billing_period: row.billing_period,
        billing_type: row.billing_type || 'monthly_subscription',
        leg_type: row.leg_type,
        destination_account_id: row.destination_account_id,
        destination_payment_method_id: row.destination_payment_method_id,
        source_payment_method_id: row.source_payment_method_id,
        source_wallet_id: row.source_wallet_id || null,
        source_account_id: row.source_account_id || null,
      });
      const existing = await this.getLeg(row.idempotency_key);
      if (existing) {
        return (await client.query(
          `UPDATE public.payment_transfers SET
             provider_transfer_id = COALESCE($2, provider_transfer_id),
             provider_status = COALESCE($3, provider_status),
             status = COALESCE($4, status),
             failure_reason = $5,
             provider_metadata = COALESCE(provider_metadata, '{}'::jsonb) || $6::jsonb,
             submitted_at = COALESCE(submitted_at, now()),
             updated_at = now()
           WHERE idempotency_key = $1
           RETURNING *`,
          [
            row.idempotency_key,
            row.provider_transfer_id || null,
            row.provider_status || null,
            row.status || existing.status,
            row.failure_reason || null,
            metadata,
          ],
        ).catch(() => ({ rows: [existing] }))).rows[0] || existing;
      }
      return (await client.query(
        `INSERT INTO public.payment_transfers
           (tenant_id, provider, environment, status, idempotency_key, amount_cents,
            platform_fee_cents, net_amount_cents, speed, description,
            source_tenant_account_id, wallet_id, leg_role, provider_transfer_id,
            provider_status, failure_reason, provider_metadata, submitted_at)
         VALUES ($1::uuid, 'moov', $2, $3, $4, $5, 0, $5, 'standard', $6,
                 $7, $8::uuid, $9, $10, $11, $12, $13::jsonb, now())
         ON CONFLICT (tenant_id, idempotency_key) DO UPDATE SET
           provider_transfer_id = COALESCE(EXCLUDED.provider_transfer_id, payment_transfers.provider_transfer_id),
           provider_status = COALESCE(EXCLUDED.provider_status, payment_transfers.provider_status),
           status = EXCLUDED.status,
           updated_at = now()
         RETURNING *`,
        [
          row.tenant_id,
          row.environment || 'sandbox',
          row.status || 'submitted',
          row.idempotency_key,
          row.amount_cents,
          row.description || `ChecksOps collection v2 ${row.billing_period} ${row.leg_type}`,
          row.source_account_id || null,
          row.wallet_id || null,
          row.leg_type,
          row.provider_transfer_id || null,
          row.provider_status || null,
          row.failure_reason || null,
          metadata,
        ],
      )).rows[0];
    },
    async listLegs(obligationId) {
      return (await client.query(
        `SELECT * FROM public.payment_transfers
         WHERE provider_metadata->>'obligation_id' = $1
            OR provider_metadata->>'collection_contract' = $2
               AND (
                 idempotency_key LIKE $3
                 OR idempotency_key LIKE $4
               )
         ORDER BY created_at ASC`,
        [
          obligationId,
          COLLECTION_CONTRACT_ID,
          `%${obligationId.split(':').slice(-2).join('-')}%`,
          `%${String(obligationId).split(':')[1]}%`,
        ],
      ).catch(() => ({ rows: [] }))).rows.map((row) => ({
        ...row,
        obligation_id: row.provider_metadata?.obligation_id || obligationId,
        leg_type: row.provider_metadata?.leg_type || row.leg_role,
        billing_period: row.provider_metadata?.billing_period || null,
      }));
    },
  };
}

export function assertExplicitDestination(destination, environment) {
  const accountId = destination?.accountId || destination?.moov_account_id;
  const paymentMethodId = destination?.paymentMethodId || destination?.moov_payment_method_id;
  const errors = [];
  if (!accountId || !paymentMethodId) errors.push('destination_unresolved');
  if (environment === 'production' && accountId === CHECKSOPS_SANDBOX_MERCHANT_ACCOUNT_ID) {
    errors.push('sandbox_resource_in_production');
  }
  if (environment === 'production' && accountId && accountId !== CHECKSOPS_PLATFORM_ACCOUNT_ID) {
    errors.push('destination_not_checksops_platform');
  }
  if (environment === 'production' && paymentMethodId && paymentMethodId !== CHECKSOPS_PLATFORM_WALLET_PM_ID) {
    errors.push('destination_not_checksops_wallet_pm');
  }
  if (destination?.selection && FALLBACK_SELECTIONS.has(destination.selection)) {
    errors.push(`destination_fallback:${destination.selection}`);
  }
  return { ok: errors.length === 0, errors, accountId, paymentMethodId };
}

export function assertTenantWalletSource({
  tenantId,
  environment,
  accountId,
  wallet,
  selection,
  allowSandboxFallback = false,
} = {}) {
  const errors = [];
  if (!wallet) errors.push('tenant_wallet_unresolved');
  if (environment === 'production' && (
    allowSandboxFallback
    || wallet?.environment === 'sandbox'
    || wallet?.provider_account_id === CHECKSOPS_SANDBOX_MERCHANT_ACCOUNT_ID
  )) {
    errors.push('sandbox_resource_in_production');
  }
  if (wallet && wallet.tenant_id && wallet.tenant_id !== tenantId) {
    errors.push('cross_tenant_wallet');
  }
  if (accountId && wallet?.provider_account_id && wallet.provider_account_id !== accountId) {
    errors.push('wallet_account_mismatch');
  }
  if (wallet && !wallet.provider_wallet_id) errors.push('tenant_wallet_id_unresolved');
  if (wallet && !wallet.provider_payment_method_id) errors.push('tenant_wallet_payment_method_unresolved');
  if (selection && WALLET_FALLBACK_SELECTIONS.has(selection)) errors.push(`wallet_fallback:${selection}`);
  if (wallet?.provider_account_id === CHECKSOPS_PLATFORM_ACCOUNT_ID) {
    errors.push('platform_wallet_used_as_source');
  }
  return { ok: errors.length === 0, errors };
}

export function assertTenantBankSource({
  tenantId,
  environment,
  authorization,
  debit,
  selection,
  destination,
} = {}) {
  const errors = [];
  if (!authorization) errors.push('missing_authorization');
  if (authorization?.tenant_id && authorization.tenant_id !== tenantId) {
    errors.push('cross_tenant_bank');
  }
  if (!debit?.sourceMethodId) errors.push('bank_debit_source_unresolved');
  if (selection && BANK_FALLBACK_SELECTIONS.has(selection)) errors.push(`bank_fallback:${selection}`);
  if (debit?.sourceAccountId === CHECKSOPS_PLATFORM_ACCOUNT_ID) {
    errors.push('platform_chase_used_as_source');
  }
  if (debit?.sourceMethodId && destination?.paymentMethodId
    && debit.sourceMethodId === destination.paymentMethodId) {
    errors.push('source_destination_reversal');
  }
  if (environment === 'production' && (
    debit?.sandbox === true
    || authorization?.provider_environment === 'sandbox'
    || debit?.sourceAccountId === CHECKSOPS_SANDBOX_MERCHANT_ACCOUNT_ID
  )) {
    errors.push('sandbox_resource_in_production');
  }
  return { ok: errors.length === 0, errors };
}

export async function resolveTenantWalletSource(client, {
  tenantId,
  environment,
  accountId,
  fetchImpl,
  deps = {},
} = {}) {
  if (deps.selection && WALLET_FALLBACK_SELECTIONS.has(deps.selection)) {
    return { ok: false, error: `wallet_fallback:${deps.selection}`, statusCode: 409 };
  }
  let wallet = deps.wallet || null;
  if (!wallet && typeof deps.readWallet === 'function') {
    wallet = await deps.readWallet(client, tenantId, environment, 'operating');
  } else if (!wallet && client) {
    const { readWallet } = await import('./providers/parity/moov-wallet.mjs');
    wallet = await readWallet(client, tenantId, environment, 'operating');
  }
  const asserted = assertTenantWalletSource({
    tenantId, environment, accountId, wallet, selection: deps.selection,
    allowSandboxFallback: deps.allowSandboxFallback === true,
  });
  if (!asserted.ok) {
    return { ok: false, error: asserted.errors[0], errors: asserted.errors, statusCode: 409 };
  }

  let availableCents = asCents(deps.availableWalletCents ?? wallet.available_cents);
  let pendingCents = asCents(deps.pendingWalletCents ?? wallet.pending_cents);
  if (typeof deps.getWalletBalance === 'function') {
    const live = await deps.getWalletBalance({
      accountId: wallet.provider_account_id,
      walletId: wallet.provider_wallet_id,
      fetchImpl,
    });
    if (live?.walletId && live.walletId !== wallet.provider_wallet_id) {
      return { ok: false, error: 'wallet_fallback:first_wallet', statusCode: 409 };
    }
    availableCents = asCents(live?.available_cents);
    pendingCents = asCents(live?.pending_cents);
  }

  return {
    ok: true,
    wallet,
    sourceMethodId: wallet.provider_payment_method_id,
    sourceWalletId: wallet.provider_wallet_id,
    sourceAccountId: wallet.provider_account_id,
    available_cents: availableCents,
    pending_cents: pendingCents,
    firstWalletFallback: false,
  };
}

export async function resolveTenantBankSource(client, {
  tenantId,
  environment,
  authorization,
  destination,
  fetchImpl,
  deps = {},
} = {}) {
  if (deps.selection && BANK_FALLBACK_SELECTIONS.has(deps.selection)) {
    return { ok: false, error: `bank_fallback:${deps.selection}`, statusCode: 409 };
  }
  const resolver = deps.resolveBillingDebitSource;
  if (typeof resolver !== 'function') {
    return { ok: false, error: 'bank_debit_resolver_missing', statusCode: 409 };
  }
  const debit = await resolver(client, { authorization, fetchImpl });
  if (!debit?.ok) return debit;
  const asserted = assertTenantBankSource({
    tenantId, environment, authorization, debit, selection: deps.selection, destination,
  });
  if (!asserted.ok) {
    return { ok: false, error: asserted.errors[0], errors: asserted.errors, statusCode: 409 };
  }
  return { ...debit, firstBankFallback: false };
}

export async function reconcileProviderTransfer({
  timeoutError,
  idempotencyKey,
  existingTransferId,
  deps = {},
} = {}) {
  if (existingTransferId && typeof deps.getTransfer === 'function') {
    const found = await deps.getTransfer(existingTransferId);
    if (found) return { ok: true, created: true, transfer: found, reconciled: true };
  }
  if (typeof deps.findTransferByIdempotency === 'function') {
    const found = await deps.findTransferByIdempotency(idempotencyKey);
    if (found) return { ok: true, created: true, transfer: found, reconciled: true };
    if (found === null) return { ok: true, created: false, transfer: null, reconciled: true };
  }
  if (typeof deps.retryIdempotentPost === 'function') {
    try {
      const created = await deps.retryIdempotentPost(idempotencyKey);
      if (created) return { ok: true, created: true, transfer: created, reconciled: true };
    } catch (error) {
      if (!isTimeoutOrUnknown(error)) {
        return { ok: true, created: false, transfer: null, reconciled: true, error: error.message };
      }
    }
  }
  return {
    ok: false,
    created: undefined,
    reconciliation_required: true,
    error: 'RECONCILIATION_REQUIRED',
    timeout: Boolean(timeoutError),
  };
}

async function persistLeg(store, row) {
  const saved = await store.putLeg(row);
  return { ...row, ...saved };
}

async function executeCollectionLeg({
  store,
  postTransfer,
  amountCents,
  description,
  metadata,
  idempotencyKey,
  sourceMethodId,
  destMethodId,
  facilitatorAccountId,
  environment,
  fetchImpl,
  deps,
  base,
}) {
  const existing = await store.getLeg(idempotencyKey);
  if (existing?.provider_transfer_id) {
    return { ok: true, duplicate: true, created: false, leg: existing };
  }
  if (existing && existing.reconciliation_required) {
    return {
      ok: false,
      reconciliation_required: true,
      error: 'RECONCILIATION_REQUIRED',
      leg: existing,
    };
  }

  let created = null;
  if (!existing?.provider_transfer_id && typeof deps.findTransferByIdempotency === 'function') {
    const already = await deps.findTransferByIdempotency(idempotencyKey);
    if (already) created = already;
  }
  try {
    if (!created) {
      created = await postTransfer({
        sourceMethodId,
        destMethodId,
        amount: amountCents,
        description,
        metadata,
        idempotencyKey,
        fetchImpl,
        facilitatorAccountId,
        environment,
        deps,
      });
    }
  } catch (error) {
    if (isTimeoutOrUnknown(error)) {
      const reconciled = await reconcileProviderTransfer({
        timeoutError: error,
        idempotencyKey,
        existingTransferId: existing?.provider_transfer_id,
        deps,
      });
      if (reconciled.reconciliation_required) {
        const unknownLeg = {
          ...base,
          amount_cents: amountCents,
          idempotency_key: idempotencyKey,
          status: 'due',
          outcome: 'unknown',
          reconciliation_required: true,
          failure_reason: 'RECONCILIATION_REQUIRED',
        };
        try { await persistLeg(store, unknownLeg); } catch { /* fail closed even if persist fails */ }
        return { ok: false, reconciliation_required: true, error: 'RECONCILIATION_REQUIRED', leg: unknownLeg };
      }
      if (!reconciled.created) {
        return {
          ok: false,
          created: false,
          error: error.message || 'provider_timeout_not_created',
          leg: { ...base, amount_cents: amountCents, outcome: 'not_created', status: 'failed' },
        };
      }
      created = reconciled.transfer;
    } else {
      return {
        ok: false,
        created: false,
        error: error.message || 'provider_rejected',
        leg: {
          ...base,
          amount_cents: amountCents,
          idempotency_key: idempotencyKey,
          outcome: 'not_created',
          status: 'failed',
          failure_reason: error.message || 'provider_rejected',
        },
      };
    }
  }

  const transferId = created?.transferID || created?.transferId || created?.provider_transfer_id || null;
  const providerStatus = created?.status || 'submitted';
  const persisted = {
    ...base,
    amount_cents: amountCents,
    idempotency_key: idempotencyKey,
    provider_transfer_id: transferId,
    provider_status: providerStatus,
    status: isSettlementReceived(providerStatus) ? 'settled' : 'submitted',
    outcome: 'created',
  };
  try {
    const saved = await persistLeg(store, persisted);
    return { ok: true, created: !existing, persist_failed: false, leg: saved };
  } catch (error) {
    return {
      ok: true,
      created: true,
      persist_failed: true,
      provider_created: true,
      error: error.message,
      leg: { ...persisted, persist_failed: true },
    };
  }
}

export async function collectTenantObligation(client, {
  occurrence,
  readiness,
  destination,
  fetchImpl,
  deps = {},
  postTransfer,
  resolveBillingDebitSource,
} = {}) {
  const tenantId = occurrence.tenant_id;
  const billingPeriod = occurrence.billing_period;
  const amountDueCents = asCents(occurrence.amount_cents);
  const environment = readiness.environment || destination.environment;
  const obligationId = occurrence.id;
  const billingType = occurrence.occurrence_kind || 'monthly_subscription';
  const store = deps.store || (client ? await createPostgresCollectionStore(client) : createMemoryCollectionStore());

  const dest = assertExplicitDestination(destination, environment);
  if (!dest.ok) {
    return { ok: false, statusCode: 409, error: dest.errors[0], errors: dest.errors };
  }

  const existingLegs = await store.listLegs(obligationId);
  if (existingLegs.some((leg) => leg.reconciliation_required || leg.outcome === 'unknown')) {
    return {
      ok: false,
      statusCode: 409,
      error: 'RECONCILIATION_REQUIRED',
      collection_status: COLLECTION_STATUS.RECONCILIATION_REQUIRED,
      obligation_id: obligationId,
      legs: existingLegs,
      amount_due_cents: amountDueCents,
      amount_received_cents: receivedCentsFromLegs(existingLegs),
      outstanding_cents: remainingUnpaidCents({ amountDueCents, legs: existingLegs }),
    };
  }

  const walletSource = amountDueCents > 0
    ? await resolveTenantWalletSource(client, {
      tenantId,
      environment,
      accountId: readiness.account?.provider_account_id || readiness.authorization?.provider_account_id,
      fetchImpl,
      deps,
    })
    : { ok: true, available_cents: 0, pending_cents: 0 };

  if (!walletSource.ok && walletSource.error !== 'tenant_wallet_unresolved') {
    return { ...walletSource, statusCode: walletSource.statusCode || 409 };
  }

  const split = splitCollectionAmounts({
    amountDueCents,
    availableWalletCents: walletSource.ok ? walletSource.available_cents : 0,
    pendingWalletCents: walletSource.ok ? walletSource.pending_cents : 0,
  });

  const knownLegs = [...existingLegs];
  let walletResult = null;
  if (split.walletAmountCents > 0) {
    const walletKey = walletLegIdempotencyKey({ tenantId, billingPeriod });
    walletResult = await executeCollectionLeg({
      store,
      postTransfer,
      amountCents: split.walletAmountCents,
      description: `ChecksOps subscription ${billingPeriod} wallet`,
      metadata: {
        checksops_kind: 'monthly_subscription',
        checksops_leg: LEG_TYPE.WALLET,
        checksops_tenant_id: tenantId,
        checksops_payment_id: obligationId,
        checksops_period: billingPeriod,
        collection_contract: COLLECTION_CONTRACT_ID,
      },
      idempotencyKey: walletKey,
      sourceMethodId: walletSource.sourceMethodId,
      destMethodId: dest.paymentMethodId,
      facilitatorAccountId: dest.accountId,
      environment,
      fetchImpl,
      deps,
      base: {
        tenant_id: tenantId,
        obligation_id: obligationId,
        billing_period: billingPeriod,
        billing_type: billingType,
        leg_type: LEG_TYPE.WALLET,
        environment,
        destination_account_id: dest.accountId,
        destination_payment_method_id: dest.paymentMethodId,
        source_payment_method_id: walletSource.sourceMethodId,
        source_wallet_id: walletSource.sourceWalletId,
        source_account_id: walletSource.sourceAccountId,
        wallet_id: walletSource.wallet?.id || null,
      },
    });
    if (walletResult.reconciliation_required) {
      return {
        ok: false,
        statusCode: 409,
        error: 'RECONCILIATION_REQUIRED',
        collection_status: COLLECTION_STATUS.RECONCILIATION_REQUIRED,
        obligation_id: obligationId,
        split,
        legs: [...knownLegs, walletResult.leg].filter(Boolean),
        amount_due_cents: amountDueCents,
        amount_received_cents: 0,
        outstanding_cents: amountDueCents,
        liveProviderCalled: true,
      };
    }
    if (walletResult.leg) knownLegs.push(walletResult.leg);
  }

  const remaining = remainingUnpaidCents({ amountDueCents, legs: uniqueLegs(knownLegs) });
  let bankResult = null;
  if (remaining > 0) {
    const bankSource = await resolveTenantBankSource(client, {
      tenantId,
      environment,
      authorization: readiness.authorization,
      destination: dest,
      fetchImpl,
      deps: { ...deps, resolveBillingDebitSource },
    });
    if (!bankSource.ok) {
      const status = classifyCollectionStatus({ amountDueCents, legs: knownLegs });
      return {
        ok: false,
        statusCode: bankSource.statusCode || 409,
        error: bankSource.error,
        collection_status: status,
        obligation_id: obligationId,
        split: { ...split, bankAmountCents: remaining },
        legs: knownLegs,
        amount_due_cents: amountDueCents,
        wallet_applied_cents: appliedCents(knownLegs, LEG_TYPE.WALLET),
        bank_ach_cents: 0,
        amount_received_cents: receivedCentsFromLegs(knownLegs),
        outstanding_cents: remaining,
      };
    }
    const bankKey = bankLegIdempotencyKey({ tenantId, billingPeriod });
    bankResult = await executeCollectionLeg({
      store,
      postTransfer,
      amountCents: remaining,
      description: `ChecksOps subscription ${billingPeriod} bank`,
      metadata: {
        checksops_kind: 'monthly_subscription',
        checksops_leg: LEG_TYPE.BANK,
        checksops_tenant_id: tenantId,
        checksops_payment_id: obligationId,
        checksops_period: billingPeriod,
        collection_contract: COLLECTION_CONTRACT_ID,
      },
      idempotencyKey: bankKey,
      sourceMethodId: bankSource.sourceMethodId,
      destMethodId: dest.paymentMethodId,
      facilitatorAccountId: dest.accountId,
      environment,
      fetchImpl,
      deps,
      base: {
        tenant_id: tenantId,
        obligation_id: obligationId,
        billing_period: billingPeriod,
        billing_type: billingType,
        leg_type: LEG_TYPE.BANK,
        environment,
        destination_account_id: dest.accountId,
        destination_payment_method_id: dest.paymentMethodId,
        source_payment_method_id: bankSource.sourceMethodId,
        source_account_id: bankSource.sourceAccountId,
      },
    });
    if (bankResult.reconciliation_required) {
      return {
        ok: false,
        statusCode: 409,
        error: 'RECONCILIATION_REQUIRED',
        collection_status: COLLECTION_STATUS.RECONCILIATION_REQUIRED,
        obligation_id: obligationId,
        split: { ...split, bankAmountCents: remaining },
        legs: [...knownLegs, bankResult.leg].filter(Boolean),
        amount_due_cents: amountDueCents,
        wallet_applied_cents: appliedCents(knownLegs, LEG_TYPE.WALLET),
        bank_ach_cents: remaining,
        amount_received_cents: receivedCentsFromLegs(knownLegs),
        outstanding_cents: remaining,
        liveProviderCalled: true,
      };
    }
    if (bankResult.leg) knownLegs.push(bankResult.leg);
  }

  const legs = uniqueLegs(knownLegs);
  const collectionStatus = classifyCollectionStatus({ amountDueCents, legs });
  const received = receivedCentsFromLegs(legs);
  const walletApplied = appliedCents(legs, LEG_TYPE.WALLET);
  const bankApplied = appliedCents(legs, LEG_TYPE.BANK);
  const failure = (!walletResult || walletResult.ok || !split.walletAmountCents)
    && (!bankResult || bankResult.ok || remaining === 0)
    ? null
    : (bankResult?.error || walletResult?.error || null);

  const obligationStatus = collectionStatus === COLLECTION_STATUS.RECONCILIATION_REQUIRED
    ? 'failed'
    : collectionStatus === COLLECTION_STATUS.PAID
      ? (received >= amountDueCents ? 'settled' : 'submitted')
      : (legs.some((leg) => isInFlight(statusOf(leg))) ? 'submitted' : (failure ? 'failed' : 'due'));

  const snapshot = {
    wallet_cents: walletApplied,
    bank_cents: bankApplied,
    received_cents: received,
    outstanding_cents: Math.max(0, amountDueCents - received),
    status: collectionStatus,
    legs: legs.map((leg) => ({
      leg_type: leg.leg_type,
      amount_cents: leg.amount_cents,
      provider_transfer_id: leg.provider_transfer_id || null,
      status: statusOf(leg),
      idempotency_key: leg.idempotency_key,
    })),
  };

  if (typeof store.putObligation === 'function') {
    await store.putObligation({
      id: obligationId,
      status: obligationStatus,
      failure_reason: collectionStatus === COLLECTION_STATUS.RECONCILIATION_REQUIRED
        ? 'RECONCILIATION_REQUIRED'
        : (failure || null),
      provider_transfer_id: legs.find((leg) => leg.provider_transfer_id)?.provider_transfer_id || null,
      collection_notes: JSON.stringify(snapshot),
    }).catch(() => {});
  }

  return {
    ok: !failure && collectionStatus !== COLLECTION_STATUS.RECONCILIATION_REQUIRED,
    simulated: deps.simulate === true,
    occurrence,
    obligation_id: obligationId,
    collection_status: collectionStatus,
    split: { ...split, bankAmountCents: bankApplied || remaining },
    legs,
    wallet_applied_cents: walletApplied,
    bank_ach_cents: bankApplied,
    amount_due_cents: amountDueCents,
    amount_received_cents: received,
    outstanding_cents: Math.max(0, amountDueCents - received),
    liveProviderCalled: deps.simulate !== true,
    error: failure,
    resolvedDebitSourceMethodId: bankResult?.leg?.source_payment_method_id || null,
    resolvedWalletSourceMethodId: walletSource.sourceMethodId || null,
  };
}

const uniqueLegs = (legs) => {
  const seen = new Set();
  const out = [];
  for (const leg of legs) {
    const key = leg.idempotency_key || `${leg.leg_type}:${leg.provider_transfer_id || 'none'}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(leg);
  }
  return out;
};

export const collectionRowFields = ({ amountDueCents, legs = [] } = {}) => {
  const received = receivedCentsFromLegs(legs);
  return {
    wallet_applied_cents: appliedCents(legs, LEG_TYPE.WALLET),
    bank_ach_cents: appliedCents(legs, LEG_TYPE.BANK),
    amount_received_cents: received,
    outstanding_cents: Math.max(0, asCents(amountDueCents) - received),
    collection_status: classifyCollectionStatus({ amountDueCents, legs }),
    legs,
  };
};

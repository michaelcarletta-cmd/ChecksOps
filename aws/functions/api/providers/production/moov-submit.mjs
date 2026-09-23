import { TENANT_MEMBERSHIP_SQL } from '../../identity.mjs';
import { isProviderNetworkError } from '../../sandbox-credentials.mjs';
import { facilitatorAccountId, moovFetch, normalizeTransferStatus, scopes, withMoovContext } from '../parity/moov-client.mjs';
import { logPaymentEvent, sanitize } from '../parity/db.mjs';
import {
  authorizeMoovProduction,
  compareOptionalClientAmount,
  compareOptionalClientDestination,
  loadApprovedDisbursement,
  resolveProductionDestination,
  serverAmountFromDisbursement,
} from './moov-authz.mjs';
import {
  PRODUCTION_MOOV_ENVIRONMENT,
  denyMoovProductionHold,
  productionMoovExecutionAllowed,
} from './moov-holds.mjs';
import {
  commitDurableAttempt,
  documentedSuccessStatuses,
  insertProductionTransferDraft,
  loadTransferByIdempotency,
  markHttpAttempted,
  moovDisbursementIdempotencyKey,
  persistProviderOutcome,
  providerReferenceOf,
  replayMoovTransferResponse,
  shouldReconcileInsteadOfPost,
} from './moov-idempotency.mjs';
import {
  assertProductionMethod,
  loadProductionConnectedMethod,
  loadProductionWallet,
} from './moov-methods.mjs';
import { loadProductionMoovSecrets, productionMoovContext } from './moov-secrets.mjs';

const membershipsOf = async (client, userId) => {
  const rows = (await client.query(TENANT_MEMBERSHIP_SQL, [userId])).rows;
  return rows.map((row) => ({
    tenant_id: row.tenant_id,
    role: row.role,
    tenant_name: row.tenant_name,
    tenant_slug: row.tenant_slug,
  }));
};

const fail = (error, statusCode, extra = {}) => denyMoovProductionHold(error, {
  statusCode,
  ...extra,
});

const postProductionTransfer = async ({
  facilitatorHint,
  sourceMethodId,
  destMethodId,
  amount,
  description,
  metadata,
  idempotencyKey,
  fetchImpl,
}) => {
  const facilitatorId = await facilitatorAccountId(facilitatorHint, fetchImpl);
  const created = await moovFetch(`/accounts/${facilitatorId}/transfers`, {
    method: 'POST',
    scopes: scopes.transfersWrite(facilitatorId),
    idempotencyKey,
    fetchImpl,
    body: {
      source: { paymentMethodID: sourceMethodId },
      destination: { paymentMethodID: destMethodId },
      amount: { currency: 'USD', value: amount },
      description: String(description || 'ChecksOps payment').slice(0, 128),
      metadata,
    },
  });
  return { created, facilitatorId };
};

export async function handleProductionMoovDisbursement({
  client,
  mapping,
  claims,
  body,
  spoof,
  fetchImpl = fetch,
  deps = {},
} = {}) {
  if (!productionMoovExecutionAllowed()) {
    return fail('production_execution_blocked', 403, {
      tranche4HardBlock: true,
      message: 'Production Moov execution flags remain off. No transfer was created.',
      spoofFieldsIgnored: spoof,
    });
  }

  const claimedUser = body.user_id || body.userId || body.application_user_id || null;
  if (claimedUser && claimedUser !== mapping.application_user_id) {
    return fail('identity_spoof_denied', 403, {
      message: 'Browser user_id is not authorization. Cognito-mapped application UUID is used.',
    });
  }

  const loaded = await loadApprovedDisbursement(client, {
    batchId: body.batch_id || body.batchId || null,
    transferId: body.transfer_id || body.transferId || body.disbursement_id || null,
  });
  if (!loaded.ok) {
    return fail(loaded.error, loaded.statusCode || 400, { message: loaded.message });
  }

  const tenantId = loaded.batch?.tenant_id || loaded.transfer?.tenant_id;
  const claimedTenant = body.tenant_id || body.tenantId || null;
  if (claimedTenant && claimedTenant !== tenantId) {
    return fail('cross_tenant_denied', 403, {
      message: 'Browser tenant_id does not match the disbursement tenant and is not used as authority.',
    });
  }

  const amount = serverAmountFromDisbursement(loaded);
  if (amount.error) {
    return fail('invalid_amount', 400, { message: amount.message || 'Server-derived disbursement amount is required.' });
  }
  const amountSpoof = compareOptionalClientAmount(body, amount.cents);
  if (amountSpoof) return fail(amountSpoof.error, amountSpoof.statusCode, { message: amountSpoof.message });

  const destination = await resolveProductionDestination(client, {
    tenantId,
    transfer: loaded.transfer,
    splits: loaded.splits,
  });
  if (!destination.ok) {
    return fail(destination.error, destination.statusCode || 409, { message: destination.message });
  }
  const destSpoof = compareOptionalClientDestination(body, destination);
  if (destSpoof) return fail(destSpoof.error, destSpoof.statusCode, { message: destSpoof.message });

  const memberships = await membershipsOf(client, mapping.application_user_id);
  const authz = await authorizeMoovProduction({
    client,
    mapping,
    memberships,
    resource: loaded,
    destination,
    amountCents: amount.cents,
  });
  if (!authz.ok) return { ...authz, spoofFieldsIgnored: spoof };

  const sourceMethod = await loadProductionConnectedMethod(client, {
    tenantId,
    providerAccountId: authz.account.provider_account_id,
  });
  const wallet = await loadProductionWallet(client, {
    tenantId,
    providerAccountId: authz.account.provider_account_id,
  });
  const sourceFromWallet = wallet?.provider_payment_method_id || null;
  const sourceChecked = sourceFromWallet
    ? { ok: true, providerMethodId: sourceFromWallet, method: { id: wallet.id, environment: 'production' } }
    : assertProductionMethod(sourceMethod, { tenantId, label: 'source method' });
  if (!sourceChecked.ok) {
    return fail(sourceChecked.error, sourceChecked.statusCode || 409, { message: sourceChecked.message });
  }

  const resourceId = loaded.transfer?.id || destination.split?.id || loaded.batch?.id;
  const idempotencyKey = loaded.transfer?.idempotency_key || moovDisbursementIdempotencyKey({
    tenantId,
    resourceId,
    amountCents: amount.cents,
    destinationId: destination.recipientId || destination.methodId,
  });
  const existing = await loadTransferByIdempotency(client, { tenantId, idempotencyKey });
  if (existing?.provider_transfer_id || (existing && shouldReconcileInsteadOfPost(existing))) {
    return {
      ...replayMoovTransferResponse(existing),
      spoofFieldsIgnored: spoof,
      applicationUserId: mapping.application_user_id,
    };
  }

  const persisted = await insertProductionTransferDraft(client, {
    tenantId,
    mapping,
    amountCents: amount.cents,
    idempotencyKey,
    destination,
    source: {
      providerAccountId: authz.account.provider_account_id,
      methodRowId: sourceMethod?.id || null,
      walletId: wallet?.id || null,
    },
    transfer: loaded.transfer || existing,
    batchId: loaded.batch?.id || null,
    checkId: loaded.batch?.check_intake_item_id || loaded.transfer?.check_id || null,
    description: body.description || `ChecksOps disbursement to ${destination.label}`,
  });
  if (!persisted.ok) return { ...persisted, spoofFieldsIgnored: spoof };
  if (persisted.row?.provider_transfer_id || shouldReconcileInsteadOfPost(persisted.row)) {
    return {
      ...replayMoovTransferResponse(persisted.row),
      spoofFieldsIgnored: spoof,
      applicationUserId: mapping.application_user_id,
    };
  }

  await commitDurableAttempt(client, mapping, claims);
  const claimed = await markHttpAttempted(client, persisted.row.id);
  if (!claimed.claimed) {
    return {
      ...replayMoovTransferResponse(claimed.row || persisted.row, {
        message: 'A concurrent or prior attempt already claimed this disbursement. A second provider POST was not sent.',
        recoverable: !claimed.row?.provider_transfer_id,
      }),
      spoofFieldsIgnored: spoof,
      applicationUserId: mapping.application_user_id,
    };
  }

  const secrets = await (deps.loadProductionSecrets || loadProductionMoovSecrets)(deps.getSecrets);
  if (!secrets.ok) {
    await persistProviderOutcome(client, {
      rowId: persisted.row.id,
      status: 'failed',
      failureReason: secrets.message || 'production_secret_missing',
    });
    return { ...secrets, spoofFieldsIgnored: spoof };
  }

  let created;
  try {
    ({ created } = await withMoovContext(productionMoovContext(secrets.credentials, fetchImpl), () => (
      postProductionTransfer({
        facilitatorHint: authz.account.provider_account_id,
        sourceMethodId: sourceChecked.providerMethodId,
        destMethodId: destination.providerMethodId,
        amount: amount.cents,
        description: persisted.row.description,
        metadata: {
          checksops_transfer_id: persisted.row.id,
          checksops_tenant_id: tenantId,
          checksops_batch_id: loaded.batch?.id || '',
          environment: PRODUCTION_MOOV_ENVIRONMENT,
        },
        idempotencyKey: `checksops-prod-transfer-${persisted.row.id}`,
        fetchImpl,
      })
    )));
  } catch (error) {
    if (isProviderNetworkError(error)) {
      await persistProviderOutcome(client, {
        rowId: persisted.row.id,
        status: 'error',
        failureReason: error.message,
      });
      return fail('provider_timeout', 502, {
        message: 'Provider call failed after the attempt was recorded. Recover by reconciliation, not a second create.',
        recoverable: true,
        liveProviderCalled: true,
        productionExecution: true,
        transfer_id: persisted.row.id,
      });
    }
    const saved = await persistProviderOutcome(client, {
      rowId: persisted.row.id,
      status: 'failed',
      failureReason: error.message,
    });
    await logPaymentEvent(client, {
      tenant_id: tenantId,
      transfer_id: persisted.row.id,
      event_type: 'transfer.failed',
      previous_status: 'ready',
      new_status: 'failed',
      environment: PRODUCTION_MOOV_ENVIRONMENT,
      provider_metadata: { reason: error.message },
    });
    return fail(error.message || 'provider_failed', 502, {
      liveProviderCalled: true,
      productionExecution: true,
      transfer: saved,
      success: false,
    });
  }

  const providerTransferId = providerReferenceOf(created);
  const providerStatus = created?.status || null;
  if (!providerTransferId || !documentedSuccessStatuses.has(String(providerStatus || '').toLowerCase())) {
    const saved = await persistProviderOutcome(client, {
      rowId: persisted.row.id,
      status: 'failed',
      providerTransferId,
      providerStatus,
      failureReason: 'Provider response did not include a documented success status.',
      providerPayload: created,
    });
    return fail('provider_result_unsuccessful', 502, {
      liveProviderCalled: true,
      productionExecution: true,
      transfer: saved,
      success: false,
      message: 'HTTP success is not enough. A documented Moov transfer id and status are required.',
    });
  }

  const status = normalizeTransferStatus(providerStatus);
  const finalTransfer = await persistProviderOutcome(client, {
    rowId: persisted.row.id,
    status,
    providerTransferId,
    providerStatus,
    providerPayload: sanitize(created),
  });
  if (destination.split?.id && providerTransferId) {
    await client.query(
      `UPDATE public.disbursement_splits
       SET moov_transfer_id = $2, moov_status = $3, status = $4, submitted_at = now()
       WHERE id = $1::uuid AND moov_transfer_id IS NULL`,
      [destination.split.id, providerTransferId, status, status === 'failed' ? 'failed' : 'submitted'],
    );
  }
  await logPaymentEvent(client, {
    tenant_id: tenantId,
    recipient_id: destination.recipientId,
    transfer_id: persisted.row.id,
    provider_transfer_id: providerTransferId,
    event_type: 'transfer.created',
    previous_status: 'ready',
    new_status: status,
    environment: PRODUCTION_MOOV_ENVIRONMENT,
  });
  return {
    ok: true,
    statusCode: 200,
    success: true,
    duplicate: false,
    provider: 'moov',
    productionExecution: true,
    liveProviderCalled: true,
    transfer: finalTransfer,
    provider_transfer_id: providerTransferId,
    provider_status: providerStatus,
    amount_cents: amount.cents,
    environment: PRODUCTION_MOOV_ENVIRONMENT,
    spoofFieldsIgnored: spoof,
    applicationUserId: mapping.application_user_id,
  };
}

export const handleProductionMoovTransferCreate = handleProductionMoovDisbursement;
export const handleProductionMoovDisburse = handleProductionMoovDisbursement;

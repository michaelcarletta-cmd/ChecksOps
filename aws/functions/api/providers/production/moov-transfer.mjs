import { rejectUntrustedAmountFields, validateProviderCents, formatMoovTransferAmount } from '../amounts.mjs';
import { ignoredOwnershipSpoof } from '../../financial-ownership.mjs';
import { TENANT_MEMBERSHIP_SQL } from '../../identity.mjs';
import {
  isProviderNetworkError,
  productionMoovFetch,
  transferIdOf,
  normalizeProductionTransferStatus,
} from './moov-client.mjs';
import { authorizeMoovProduction } from './moov-authz.mjs';
import {
  assertProductionRail,
  loadProductionPaymentMethod,
  loadProductionRecipient,
  loadProductionTenantAccount,
} from './moov-config.mjs';
import {
  commitDurableAttempt,
  insertQueuedTransfer,
  loadTransferById,
  loadTransferByIdempotency,
  markHttpAttempted,
  moovTransferIdempotencyKey,
  persistProviderOutcome,
  providerIdempotencyKeyFromIntent,
  replayTransferResponse,
  shouldReconcileInsteadOfPost,
} from './moov-idempotency.mjs';
import { loadProductionMoovSecrets } from './moov-secrets.mjs';
import { reconcileProductionMoovTransfer } from './moov-reconcile.mjs';

const UNTRUSTED_MOOV_KEYS = [
  'moov_account_id', 'moovAccountId', 'MOOV_ACCOUNT_ID',
  'platform_account_id', 'platformAccountId', 'facilitator_account_id',
  'payment_method_id', 'paymentMethodId', 'source_payment_method_id',
  'destination_payment_method_id', 'sourcePaymentMethodID', 'destinationPaymentMethodID',
  'provider_account_id', 'providerAccountId',
];

const fail = (error, statusCode, extra = {}) => ({
  ok: false,
  statusCode,
  error,
  provider: 'moov',
  liveProviderCalled: false,
  productionExecution: extra.productionExecution === true,
  ...extra,
});

const membershipsOf = async (client, userId) => {
  const rows = (await client.query(TENANT_MEMBERSHIP_SQL, [userId])).rows;
  return rows.map((row) => ({
    tenant_id: row.tenant_id,
    role: row.role,
    tenant_name: row.tenant_name,
    tenant_slug: row.tenant_slug,
  }));
};

const rejectUntrustedMoovConfig = (body = {}) => {
  const present = UNTRUSTED_MOOV_KEYS.filter((key) => body[key] !== undefined && body[key] !== null);
  if (!present.length) return null;
  return fail('untrusted_provider_config', 400, {
    fields: present,
    message: 'Moov account, platform account, and payment method ids are server-derived. Browser values are rejected.',
    ignored: ignoredOwnershipSpoof(body),
  });
};

export async function handleProductionMoovTransferCreate({
  client,
  mapping,
  claims,
  body,
  spoof,
  fetchImpl = fetch,
  deps = {},
} = {}) {
  const amountSpoof = rejectUntrustedAmountFields(body);
  if (amountSpoof) {
    return { ...amountSpoof, liveProviderCalled: false, productionExecution: false, spoofFieldsIgnored: spoof };
  }
  const configSpoof = rejectUntrustedMoovConfig(body);
  if (configSpoof) return { ...configSpoof, spoofFieldsIgnored: spoof };

  const transferId = body.payment_transfer_id;
  if (!transferId) {
    return fail('payment_transfer_id is required', 400, {
      message: 'Browser may supply payment_transfers.id as a lookup only. Tenant, amount, and destination are server-derived.',
    });
  }

  const transfer = await loadTransferById(client, transferId);
  if (!transfer) return fail('Transfer not found', 404);
  if (transfer.provider !== 'moov' || transfer.environment !== 'production') {
    return fail('production_transfer_required', 409, {
      message: 'Only environment=production Moov payment_transfers rows may use this path.',
    });
  }

  const claimedTenant = body.tenant_id || body.tenantId || null;
  if (claimedTenant && claimedTenant !== transfer.tenant_id) {
    return fail('cross_tenant_denied', 403, {
      message: 'Browser tenant_id does not match the transfer tenant and is not used as authority.',
    });
  }
  const claimedUser = body.user_id || body.userId || body.application_user_id || null;
  if (claimedUser && claimedUser !== mapping.application_user_id) {
    return fail('identity_spoof_denied', 403, {
      message: 'Browser user_id is not authorization. Cognito-mapped application UUID is used.',
    });
  }
  const claimedRecipient = body.recipient_id || body.destination_recipient_id || null;
  if (claimedRecipient && transfer.destination_recipient_id
    && claimedRecipient !== transfer.destination_recipient_id) {
    return fail('spoofed_recipient', 403, {
      message: 'Browser recipient is ignored. Server-loaded destination_recipient_id is used.',
    });
  }

  const centsCheck = validateProviderCents(Number(transfer.amount_cents));
  if (centsCheck.error) return fail(centsCheck.message || 'invalid_amount', 400);
  const amountCents = centsCheck.cents;

  const memberships = await membershipsOf(client, mapping.application_user_id);
  const authz = await authorizeMoovProduction({
    client,
    mapping,
    memberships,
    transfer,
    requireStepUp: true,
  });
  if (!authz.ok) return { ...authz, spoofFieldsIgnored: spoof };

  const secrets = await (deps.loadProductionSecrets || loadProductionMoovSecrets)(deps.getSecrets);
  if (!secrets.ok) return { ...secrets, spoofFieldsIgnored: spoof };

  const account = await loadProductionTenantAccount(client, transfer.tenant_id);
  const sourceMethod = await loadProductionPaymentMethod(client, {
    methodId: transfer.source_payment_method_id,
    tenantId: transfer.tenant_id,
  });
  const destMethod = await loadProductionPaymentMethod(client, {
    methodId: transfer.destination_payment_method_id,
  });
  const recipient = transfer.destination_recipient_id
    ? await loadProductionRecipient(client, {
      recipientId: transfer.destination_recipient_id,
      tenantId: transfer.tenant_id,
    })
    : null;
  const rail = assertProductionRail({ account, sourceMethod, destMethod, recipient });
  if (!rail.ok) return { ...rail, spoofFieldsIgnored: spoof };

  const formatted = formatMoovTransferAmount(amountCents);
  if (formatted.error) return fail(formatted.message || 'invalid_amount', 400);

  const idempotencyKey = transfer.idempotency_key || moovTransferIdempotencyKey({
    tenantId: transfer.tenant_id,
    resourceId: transfer.id,
    amountCents,
    destinationMethodId: destMethod.provider_payment_method_id,
  });
  const existing = transfer.idempotency_key
    ? transfer
    : await loadTransferByIdempotency(client, { tenantId: transfer.tenant_id, idempotencyKey });
  const intent = existing || (await insertQueuedTransfer(client, {
    mapping,
    tenantId: transfer.tenant_id,
    amountCents,
    idempotencyKey,
    sourceAccountId: account.provider_account_id,
    sourceMethodId: sourceMethod.id,
    destinationRecipientId: recipient?.id || transfer.destination_recipient_id,
    destinationMethodId: destMethod.id,
    description: transfer.description,
    metadata: { payment_transfer_id: transfer.id },
  })).row;
  if (!intent) return fail('idempotency_persist_failed', 503);

  if (shouldReconcileInsteadOfPost(intent)) {
    if (intent.provider_transfer_id && ['submitted', 'pending', 'completed'].includes(String(intent.status || ''))) {
      return {
        ...replayTransferResponse(intent),
        spoofFieldsIgnored: spoof,
        applicationUserId: mapping.application_user_id,
        provider_idempotency_key: providerIdempotencyKeyFromIntent(intent),
      };
    }
    const reconciled = await reconcileProductionMoovTransfer({
      client,
      mapping,
      row: intent,
      credentials: secrets.credentials,
      fetchImpl,
    });
    return {
      ...reconciled,
      duplicate: true,
      replayed: true,
      spoofFieldsIgnored: spoof,
      applicationUserId: mapping.application_user_id,
      provider_idempotency_key: providerIdempotencyKeyFromIntent(intent),
    };
  }

  await commitDurableAttempt(client, mapping, claims);
  const claimedHttp = await markHttpAttempted(client, intent.id);
  await commitDurableAttempt(client, mapping, claims);
  if (!claimedHttp.claimed) {
    if (claimedHttp.row && shouldReconcileInsteadOfPost(claimedHttp.row)) {
      const reconciled = await reconcileProductionMoovTransfer({
        client,
        mapping,
        row: claimedHttp.row,
        credentials: secrets.credentials,
        fetchImpl,
      });
      return {
        ...reconciled,
        duplicate: true,
        replayed: true,
        spoofFieldsIgnored: spoof,
        applicationUserId: mapping.application_user_id,
        provider_idempotency_key: providerIdempotencyKeyFromIntent(claimedHttp.row || intent),
      };
    }
    return {
      ...replayTransferResponse(claimedHttp.row || intent, {
        error: 'duplicate_in_flight',
        message: 'Another in-flight attempt already claimed this transfer. A second Moov POST was not sent.',
      }),
      statusCode: 409,
      spoofFieldsIgnored: spoof,
      applicationUserId: mapping.application_user_id,
      provider_idempotency_key: providerIdempotencyKeyFromIntent(claimedHttp.row || intent),
    };
  }
  const submitting = claimedHttp.row;
  const providerKey = providerIdempotencyKeyFromIntent(submitting);
  const facilitator = secrets.credentials.platformAccountId;

  try {
    const created = await productionMoovFetch({
      credentials: secrets.credentials,
      path: `/accounts/${facilitator}/transfers`,
      method: 'POST',
      scopes: [`/accounts/${facilitator}/transfers.write`],
      idempotencyKey: providerKey,
      fetchImpl,
      body: {
        source: { paymentMethodID: sourceMethod.provider_payment_method_id },
        destination: { paymentMethodID: destMethod.provider_payment_method_id },
        amount: formatted.amount,
        description: String(transfer.description || 'ChecksOps production transfer').slice(0, 128),
        metadata: {
          checksops_transfer_id: submitting.id,
          checksops_tenant_id: transfer.tenant_id,
        },
      },
    });
    const providerTransferId = transferIdOf(created.json);
    const status = normalizeProductionTransferStatus(created.json?.status);
    let saved;
    try {
      saved = await persistProviderOutcome(client, {
        rowId: submitting.id,
        status,
        providerTransferId,
        failureClass: null,
        providerPayload: created.json,
      });
      await commitDurableAttempt(client, mapping, claims);
    } catch (error) {
      return {
        ok: true,
        statusCode: 200,
        success: Boolean(providerTransferId),
        duplicate: false,
        replayed: false,
        liveProviderCalled: true,
        productionExecution: true,
        productionRecordsMutated: true,
        payment_transfer_id: submitting.id,
        provider_transfer_id: providerTransferId,
        provider_idempotency_key: providerKey,
        status: 'submitting',
        failure_class: 'db_after_provider',
        amount_cents: amountCents,
        scale: 'integer_cents',
        message: 'Provider accepted or responded but the RDS update failed. Reconcile this row. Do not POST again.',
        recovery: 'POST /functions/v1/moov-transfer-status with payment_transfer_id. Never retry create.',
        pgCode: error?.code || null,
        spoofFieldsIgnored: spoof,
        applicationUserId: mapping.application_user_id,
      };
    }
    return {
      ok: true,
      statusCode: 200,
      success: true,
      liveProviderCalled: true,
      productionExecution: true,
      productionRecordsMutated: true,
      payment_transfer_id: saved.id,
      provider_transfer_id: saved.provider_transfer_id,
      provider_idempotency_key: providerKey,
      status: saved.status,
      amount_cents: amountCents,
      scale: 'integer_cents',
      spoofFieldsIgnored: spoof,
      applicationUserId: mapping.application_user_id,
      authUid: mapping.application_user_id,
      cognitoSub: claims.sub,
    };
  } catch (error) {
    if (isProviderNetworkError(error)) {
      await persistProviderOutcome(client, {
        rowId: submitting.id,
        status: 'submitting',
        providerTransferId: null,
        failureClass: 'provider_timeout',
        lastError: 'provider_egress_or_timeout',
        providerPayload: { error: 'provider_timeout' },
      }).catch(() => null);
      await commitDurableAttempt(client, mapping, claims).catch(() => null);
      return fail('provider_timeout', 503, {
        payment_transfer_id: submitting.id,
        liveProviderCalled: true,
        productionExecution: true,
        productionRecordsMutated: true,
        failure_class: 'provider_timeout',
        provider_idempotency_key: providerKey,
        message: 'Moov HTTP did not complete. The durable attempt was kept. Reconcile instead of posting again.',
        spoofFieldsIgnored: spoof,
      });
    }
    if (error?.status) {
      await persistProviderOutcome(client, {
        rowId: submitting.id,
        status: 'error',
        providerTransferId: null,
        failureClass: `provider_${error.status}`,
        lastError: String(error.message || 'provider_error').slice(0, 300),
        providerPayload: error.body,
      }).catch(() => null);
      return fail('provider_error', error.status >= 500 ? 502 : error.status, {
        payment_transfer_id: submitting.id,
        liveProviderCalled: true,
        productionExecution: true,
        productionRecordsMutated: true,
        provider_idempotency_key: providerKey,
        spoofFieldsIgnored: spoof,
      });
    }
    throw error;
  }
}

export const handleProductionMoovDisburse = handleProductionMoovTransferCreate;

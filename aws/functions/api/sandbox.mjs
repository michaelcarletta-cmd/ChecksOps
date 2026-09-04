import pg from 'pg';
import { withIdentityWrite } from './data.mjs';
import { loadDatabaseCredentials } from './secrets.mjs';
import { buildWriteClientConfig } from './db-health.mjs';
import { TENANT_MEMBERSHIP_SQL } from './identity.mjs';
import { denyProviderExecution, flagSnapshot, providerExecutionEnabled } from './provider-flags.mjs';
import { financialFlagSnapshot, financialPermissionsActivated } from './financial-flags.mjs';
import { providerSandboxExecutionEnabled, sandboxFlagSnapshot } from './sandbox-flags.mjs';
import {
  CHECKALT_UAT_HOST,
  CHECKALT_UAT_MERCHANT_EXPECTED,
  isProviderNetworkError,
  loadSandboxCredentials,
  publicSandboxCapability,
} from './sandbox-credentials.mjs';
import { mapCheckAltStatus, rejectUntrustedAmountFields } from './providers/amounts.mjs';
import {
  SANDBOX_MIN_CENTS,
  MOOV_SANDBOX_AMOUNT_API,
  buildMoovSandboxTransferBody,
  collectMoovAccountIds,
  collectMoovPaymentMethods,
  collectMoovTransferIds,
  moovSandboxFetch,
  moovSandboxScopes,
  moovSandboxToken,
  normalizeMoovSandboxTransfer,
  pickMoovSandboxTransferMethods,
  redactProviderId,
} from './providers/moov-sandbox.mjs';
import {
  CHECKALT_USER_AMOUNT,
  CHECKALT_UAT_AUTH_PATH,
  assertCheckAltSandboxCredentials,
  buildCheckAltSandboxDeposit,
  buildCheckAltUatDepositBody,
  checkAltSandboxAuthenticate,
  checkAltSandboxFetch,
  collectCheckAltAccountNumbers,
  extractCheckAltAmountEcho,
  extractCheckAltBusUnit,
  extractCheckAltReference,
  extractCheckAltSsoAndAccount,
  extractCheckAltStatus,
  fingerprintAccountNumber,
  redactAccountNumber,
  summarizeDiscoveredDepositAccounts,
} from './providers/checkalt-sandbox.mjs';
import { buildRegisterPayload, extractSsoKey } from './providers/parity/checkalt-client.mjs';
import {
  assertPlaidSandboxCredentials,
  buildPlaidLinkTokenBody,
  plaidSandboxFetch,
} from './providers/plaid-sandbox.mjs';
import { rawEventBody, verifyHmacBodySignature, verifyMoovSignature } from './providers/hmac.mjs';
import { sanitizeWebhookPayload } from './providers/webhooks.mjs';
import { reconcileOperations } from './financial-reconciliation.mjs';
import { stableIdempotencyKey } from './financial-idempotency.mjs';

export const SANDBOX_MARKER = 'AWS PROVIDER SANDBOX';
export const SANDBOX_GUC = 'request.provider_sandbox';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isUuid = (value) => UUID_RE.test(String(value || ''));

const denied = (spoof, extra) => ({
  ok: false,
  statusCode: extra.statusCode || 403,
  spoofFieldsIgnored: spoof,
  liveProviderCalled: Boolean(extra.sandboxHttpCalled),
  sandboxHttpCalled: Boolean(extra.sandboxHttpCalled),
  productionExecution: false,
  productionRecordsMutated: false,
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

const setSandboxGuc = async (client) => {
  await client.query('SELECT set_config($1, $2, true)', [SANDBOX_GUC, '1']);
};

const insertAudit = async (client, fields) => {
  await client.query(
    `INSERT INTO public.aws_provider_sandbox_audit
      (application_user_id, tenant_id, operation_type, operation_id, provider,
       provider_reference, outcome, idempotency_key, details)
     VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5, $6, $7, $8, $9::jsonb)`,
    [
      fields.applicationUserId || null,
      fields.tenantId || null,
      fields.operationType || null,
      fields.operationId || null,
      fields.provider || null,
      fields.providerReference || null,
      fields.outcome,
      fields.idempotencyKey || null,
      JSON.stringify(fields.details || {}),
    ],
  );
};

const publicOperation = (row) => {
  if (!row) return null;
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    operation_type: row.operation_type,
    provider: row.provider,
    amount_cents: Number(row.amount_cents),
    currency: row.currency,
    idempotency_key: row.idempotency_key,
    status: row.status,
    provider_reference: row.provider_reference ? redactProviderId(row.provider_reference) : null,
    provider_reference_full_stored: Boolean(row.provider_reference),
    sandbox_http_called: row.sandbox_http_called,
    production_execution: row.production_execution,
    failure_class: row.failure_class,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
};

const requireSandboxGate = ({ spoof }) => {
  if (providerExecutionEnabled()) {
    return denied(spoof, {
      statusCode: 403,
      error: 'production_execution_blocked',
      message: 'AWS_PROVIDER_EXECUTION_ENABLED is true. Sandbox adapters refuse to run alongside production execution.',
    });
  }
  if (financialPermissionsActivated()) {
    return denied(spoof, {
      statusCode: 403,
      error: 'financial_permissions_must_stay_deactivated',
      message: 'AWS_FINANCIAL_PERMISSIONS_ACTIVATED must remain false during sandbox validation.',
    });
  }
  if (!providerSandboxExecutionEnabled()) {
    return denied(spoof, {
      statusCode: 403,
      error: 'sandbox_execution_disabled',
      message: 'AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED is false. This flag is independent of the production master execution flag.',
    });
  }
  return { ok: true };
};

const lookupSandboxObject = async (client, { tenantId, provider, objectType }) => {
  const rows = (await client.query(
    `SELECT id, tenant_id, provider, object_type, sandbox_provider_id, environment, metadata
     FROM public.aws_provider_sandbox_objects
     WHERE tenant_id = $1::uuid AND provider = $2 AND object_type = $3
     ORDER BY created_at DESC
     LIMIT 1`,
    [tenantId, provider, objectType],
  )).rows;
  return rows[0] || null;
};

const lookupSandboxOperation = async (client, { operationId, idempotencyKey, tenantId }) => {
  if (operationId && isUuid(operationId)) {
    const rows = (await client.query(
      'SELECT * FROM public.aws_provider_sandbox_operations WHERE id = $1::uuid',
      [operationId],
    )).rows;
    return rows[0] || null;
  }
  if (idempotencyKey && tenantId) {
    const rows = (await client.query(
      'SELECT * FROM public.aws_provider_sandbox_operations WHERE tenant_id = $1::uuid AND idempotency_key = $2',
      [tenantId, idempotencyKey],
    )).rows;
    return rows[0] || null;
  }
  return null;
};

const insertPendingOperation = async (client, {
  tenantId,
  applicationUserId,
  operationType,
  provider,
  amountCents,
  idempotencyKey,
  metadata,
}) => {
  const allowedTypes = { moov_sandbox_transfer: 'moov', checkalt_sandbox_deposit: 'checkalt' };
  if (allowedTypes[operationType] !== provider) {
    throw new Error('unsupported_sandbox_operation');
  }
  return (await client.query(
    `INSERT INTO public.aws_provider_sandbox_operations
      (tenant_id, application_user_id, operation_type, provider, amount_cents, currency,
       idempotency_key, status, sandbox_http_called, production_execution, metadata)
     VALUES ($1::uuid, $2::uuid, '${operationType}', '${provider}', $3, 'USD', $4, 'submitting', false, false, $5::jsonb)
     RETURNING *`,
    [tenantId, applicationUserId, amountCents, idempotencyKey, JSON.stringify(metadata || {})],
  )).rows[0];
};

const updateSandboxOperation = async (client, {
  id,
  status,
  providerReference = null,
  sandboxHttpCalled = true,
  failureClass = null,
  metadataPatch = {},
}) => (await client.query(
  `UPDATE public.aws_provider_sandbox_operations
   SET status = $2,
       provider_reference = COALESCE($3, provider_reference),
       sandbox_http_called = $4,
       production_execution = false,
       failure_class = $5,
       metadata = COALESCE(metadata, '{}'::jsonb) || $6::jsonb,
       updated_at = now()
   WHERE id = $1::uuid
   RETURNING *`,
  [id, status, providerReference, sandboxHttpCalled, failureClass, JSON.stringify(metadataPatch)],
)).rows[0];

const insertSandboxObject = async (client, { tenantId, provider, objectType, sandboxProviderId, metadata }) => {
  if (!sandboxProviderId) return null;
  const existing = (await client.query(
    `SELECT * FROM public.aws_provider_sandbox_objects
     WHERE tenant_id = $1::uuid AND provider = $2 AND object_type = $3 AND sandbox_provider_id = $4`,
    [tenantId, provider, objectType, sandboxProviderId],
  )).rows[0];
  if (existing) return existing;
  return (await client.query(
    `INSERT INTO public.aws_provider_sandbox_objects
      (tenant_id, provider, object_type, sandbox_provider_id, environment, metadata)
     VALUES ($1::uuid, $2, $3, $4, 'sandbox', $5::jsonb)
     RETURNING *`,
    [tenantId, provider, objectType, sandboxProviderId, JSON.stringify(metadata || {})],
  )).rows[0];
};

export const handleSandboxStatus = async (deps = {}) => {
  const loaded = await (deps.loadSandboxCredentials || loadSandboxCredentials)();
  return {
    ok: true,
    statusCode: 200,
    service: 'checksops-api',
    environment: process.env.CHECKSOPS_ENV || 'unknown',
    phase: 'provider_sandbox_validation',
    productionSupabaseChanged: false,
    productionWebhooksRedirected: false,
    productionDnsChanged: false,
    productionExecution: false,
    productionRecordsMutated: false,
    liveProductionProviderTransactions: false,
    flags: {
      ...flagSnapshot(),
      ...financialFlagSnapshot(),
      ...sandboxFlagSnapshot(),
    },
    capability: publicSandboxCapability(loaded),
    amountUnits: {
      moov: MOOV_SANDBOX_AMOUNT_API,
      checkalt: CHECKALT_USER_AMOUNT,
      sandboxMinCents: SANDBOX_MIN_CENTS,
    },
    isolation: {
      approvedCheckAltHost: CHECKALT_UAT_HOST,
      approvedCheckAltMerchant: CHECKALT_UAT_MERCHANT_EXPECTED,
      sandboxTables: [
        'aws_provider_sandbox_objects',
        'aws_provider_sandbox_operations',
        'aws_provider_sandbox_audit',
        'aws_provider_sandbox_webhooks',
      ],
      productionTablesNeverWritten: [
        'payment_provider_accounts',
        'payment_wallets',
        'payment_transfers',
        'checkalt_deposits',
        'claim_payments',
        'homeowner_ledger_events',
      ],
      productionMoovIdsMustNotBeOverwritten: true,
      httpAllowed: {
        moov: Boolean(loaded.snapshot.moov.available) && !providerExecutionEnabled(),
        checkalt: Boolean(loaded.snapshot.checkalt.available) && loaded.snapshot.checkalt.dedicatedUatUrlApproved,
        plaid: false,
      },
    },
    cutover: {
      authorized: false,
      executed: false,
    },
  };
};

const AMOUNT_FIXTURES = { min: 1, dollar: 100, cert: 12345 };

const serverAmountCents = (body) => {
  const fixture = String(body?.fixture || 'min');
  if (!Object.prototype.hasOwnProperty.call(AMOUNT_FIXTURES, fixture)) {
    return { error: 'unknown_amount_fixture', message: 'Use fixture min|dollar|cert. Browser amounts are rejected.' };
  }
  return { cents: AMOUNT_FIXTURES[fixture], fixture };
};

const productionProviderIds = async (client, tenantId) => {
  const accounts = (await client.query(
    `SELECT provider, provider_account_id, environment
     FROM public.payment_provider_accounts
     WHERE tenant_id = $1::uuid`,
    [tenantId],
  )).rows;
  const wallets = (await client.query(
    `SELECT provider_wallet_id, provider_account_id, environment
     FROM public.payment_wallets
     WHERE tenant_id = $1::uuid`,
    [tenantId],
  )).rows;
  return {
    productionAccountIds: accounts.filter((row) => row.environment === 'production').map((row) => row.provider_account_id),
    productionWalletIds: wallets.filter((row) => row.environment === 'production').map((row) => row.provider_wallet_id),
    environments: [...new Set(accounts.map((row) => row.environment))],
  };
};

const handleAuthenticated = (event, fn, deps) => withIdentityWrite(event, async (ctx) => {
  await setSandboxGuc(ctx.client);
  try {
    return await fn(ctx);
  } catch (error) {
    if (isProviderNetworkError(error)) {
      return {
        ok: false,
        statusCode: 503,
        error: 'provider_egress_failed',
        message: 'Staging Lambda cannot reach the provider HTTPS endpoint from the VPC. No production keys were used.',
        sandboxHttpCalled: true,
        productionExecution: false,
        productionRecordsMutated: false,
      };
    }
    throw error;
  }
}, deps);

const handleIsolation = async (event, deps) => handleAuthenticated(event, async ({ client, mapping, claims, spoof }) => {
  const gate = requireSandboxGate({ spoof });
  if (gate.ok !== true) return gate;
  const memberships = await membershipsOf(client, mapping.application_user_id);
  const tenantId = memberships[0]?.tenant_id;
  if (!tenantId) return denied(spoof, { error: 'no_tenant_membership' });
  const loaded = await (deps.loadSandboxCredentials || loadSandboxCredentials)();
  const production = await productionProviderIds(client, tenantId);
  const sandboxObjects = (await client.query(
    `SELECT provider, object_type, sandbox_provider_id
     FROM public.aws_provider_sandbox_objects
     WHERE tenant_id = $1::uuid`,
    [tenantId],
  )).rows;
  const overlap = sandboxObjects.filter((row) => (
    production.productionAccountIds.includes(row.sandbox_provider_id)
    || production.productionWalletIds.includes(row.sandbox_provider_id)
  ));
  const moovHttpAllowed = Boolean(loaded.snapshot.moov.available) && overlap.length === 0 && !providerExecutionEnabled();
  const checkaltHttpAllowed = Boolean(loaded.snapshot.checkalt.available)
    && loaded.snapshot.checkalt.dedicatedUatUrlApproved
    && loaded.snapshot.checkalt.merchantApproved;
  return {
    ok: true,
    statusCode: 200,
    productionExecution: false,
    productionRecordsMutated: false,
    applicationUserId: mapping.application_user_id,
    cognitoSub: claims.sub,
    spoofFieldsIgnored: spoof,
    capability: publicSandboxCapability(loaded),
    productionProviderEnvironments: production.environments,
    productionAccountCount: production.productionAccountIds.length,
    sandboxObjectCount: sandboxObjects.length,
    productionIdOverlap: overlap.length > 0,
    httpAllowed: {
      moov: moovHttpAllowed,
      checkalt: checkaltHttpAllowed,
      reason: {
        moov: moovHttpAllowed ? 'sandbox_keys_isolated' : (loaded.snapshot.moov.available ? 'environment_not_proven' : loaded.snapshot.moov.reason),
        checkalt: checkaltHttpAllowed ? 'uat_host_approved' : loaded.snapshot.checkalt.reason,
      },
    },
    stopHttpUnlessProven: true,
  };
}, deps);

const handleMoovProbe = async (event, deps) => handleAuthenticated(event, async ({ client, mapping, claims, body, spoof }) => {
  const untrusted = rejectUntrustedAmountFields(body);
  if (untrusted) return denied(spoof, untrusted);
  const gate = requireSandboxGate({ spoof });
  if (gate.ok !== true) return gate;
  const memberships = await membershipsOf(client, mapping.application_user_id);
  if (!memberships.length) return denied(spoof, { error: 'no_tenant_membership' });
  const tenantId = memberships[0].tenant_id;
  const loaded = await (deps.loadSandboxCredentials || loadSandboxCredentials)();
  const fetchImpl = deps.fetchImpl || fetch;
  if (!loaded.moov) {
    await insertAudit(client, {
      applicationUserId: mapping.application_user_id,
      tenantId,
      operationType: 'moov_probe',
      provider: 'moov',
      outcome: 'sandbox_credentials_unavailable',
    });
    return denied(spoof, {
      statusCode: 409,
      error: 'sandbox_credentials_unavailable',
      provider: 'moov',
      capability: loaded.snapshot.moov,
      message: 'Moov sandbox keys are not present on AWS staging. Production keys were not used.',
    });
  }
  const auth = await moovSandboxToken({
    credentials: loaded.moov,
    scopes: moovSandboxScopes.accountsRead(),
    fetchImpl,
  });
  if (!auth.ok) {
    await insertAudit(client, {
      applicationUserId: mapping.application_user_id,
      tenantId,
      operationType: 'moov_probe',
      provider: 'moov',
      outcome: 'moov_sandbox_auth_failed',
      details: { httpStatus: auth.httpStatus || null },
    });
    return denied(spoof, { ...auth, sandboxHttpCalled: true });
  }
  const production = await productionProviderIds(client, tenantId);
  const listed = await moovSandboxFetch({
    credentials: loaded.moov,
    path: '/accounts',
    scopes: moovSandboxScopes.accountsRead(),
    fetchImpl,
    token: auth.token,
  });
  const listedIds = collectMoovAccountIds(listed.data);
  const overlappingIds = listedIds.filter((id) => production.productionAccountIds.includes(id));
  if (overlappingIds.length || (loaded.moov.platformAccountId && production.productionAccountIds.includes(loaded.moov.platformAccountId))) {
    await insertAudit(client, {
      applicationUserId: mapping.application_user_id,
      tenantId,
      operationType: 'moov_probe',
      provider: 'moov',
      outcome: 'production_provider_id_refused',
    });
    return denied(spoof, {
      statusCode: 403,
      error: 'production_provider_id_refused',
      sandboxHttpCalled: true,
      listedAccountCount: listedIds.length,
      overlappingAccountCount: overlappingIds.length,
      message: 'Moov sandbox credentials resolved to an account ID stored as production in RDS. HTTP stopped.',
    });
  }
  const isolatedIds = listedIds.filter((id) => !production.productionAccountIds.includes(id));
  // Prefer configured sandbox platform account even when GET /accounts list is
  // unauthorized (common for Moov apps that only grant account-scoped scopes).
  // Still refuse any ID that overlaps production RDS mappings.
  const configuredPlatform = loaded.moov.platformAccountId || null;
  const configuredOk = Boolean(
    configuredPlatform
    && !production.productionAccountIds.includes(configuredPlatform),
  );
  const accountId = configuredOk
    ? configuredPlatform
    : (isolatedIds[0] || null);
  const reads = {
    authentication: { ok: true, tokenPresent: auth.accessTokenPresent },
    listedAccounts: { ok: listed.ok, count: listedIds.length, isolatedCount: isolatedIds.length, overlapCount: 0 },
    account: null,
    wallets: null,
    paymentMethods: null,
    capabilities: null,
  };
  if (accountId) {
    // Mint account-scoped tokens per read. Do not reuse the /accounts.read list
    // token — Moov returns 403 when that bearer is used for profile/wallets/etc.
    const account = await moovSandboxFetch({
      credentials: loaded.moov,
      path: `/accounts/${accountId}`,
      scopes: moovSandboxScopes.accountRead(accountId),
      fetchImpl,
    });
    reads.account = { ok: account.ok, redactedId: redactProviderId(accountId), httpStatus: account.statusCode || account.httpStatus || null };
    const wallets = await moovSandboxFetch({
      credentials: loaded.moov,
      path: `/accounts/${accountId}/wallets`,
      scopes: moovSandboxScopes.walletsRead(accountId),
      fetchImpl,
    });
    reads.wallets = {
      ok: wallets.ok,
      count: Array.isArray(wallets.data) ? wallets.data.length : null,
      httpStatus: wallets.statusCode || wallets.httpStatus || null,
    };
    const methods = await moovSandboxFetch({
      credentials: loaded.moov,
      path: `/accounts/${accountId}/payment-methods`,
      scopes: moovSandboxScopes.paymentMethodsRead(accountId),
      fetchImpl,
    });
    reads.paymentMethods = {
      ok: methods.ok,
      count: Array.isArray(methods.data) ? methods.data.length : null,
      httpStatus: methods.statusCode || methods.httpStatus || null,
    };
    const caps = await moovSandboxFetch({
      credentials: loaded.moov,
      path: `/accounts/${accountId}/capabilities`,
      scopes: moovSandboxScopes.capabilitiesRead(accountId),
      fetchImpl,
    });
    reads.capabilities = {
      ok: caps.ok,
      count: Array.isArray(caps.data) ? caps.data.length : null,
      httpStatus: caps.statusCode || caps.httpStatus || null,
    };
    if (wallets.ok && Array.isArray(wallets.data)) {
      for (const wallet of wallets.data.slice(0, 5)) {
        await insertSandboxObject(client, {
          tenantId,
          provider: 'moov',
          objectType: 'wallet',
          sandboxProviderId: wallet.walletID || wallet.walletId || wallet.id,
          metadata: { source: 'sandbox_probe' },
        });
      }
    }
    if (methods.ok && Array.isArray(methods.data)) {
      for (const method of methods.data.slice(0, 8)) {
        await insertSandboxObject(client, {
          tenantId,
          provider: 'moov',
          objectType: 'payment_method',
          sandboxProviderId: method.paymentMethodID || method.paymentMethodId || method.id,
          metadata: { source: 'sandbox_probe', paymentMethodType: method.paymentMethodType || method.type || null },
        });
      }
    }
    const isolatedMethods = collectMoovPaymentMethods(methods.data);
    for (const extraId of isolatedIds.slice(1, 3)) {
      const extraMethods = await moovSandboxFetch({
        credentials: loaded.moov,
        path: `/accounts/${extraId}/payment-methods`,
        scopes: moovSandboxScopes.paymentMethodsRead(extraId),
        fetchImpl,
      });
      isolatedMethods.push(...collectMoovPaymentMethods(extraMethods.data).map((row) => ({ ...row, fromAccount: extraId })));
      if (extraMethods.ok && Array.isArray(extraMethods.data)) {
        reads.paymentMethods = {
          ok: true,
          count: (reads.paymentMethods?.count || 0) + extraMethods.data.length,
          httpStatus: extraMethods.statusCode || extraMethods.httpStatus || reads.paymentMethods?.httpStatus || null,
        };
      }
    }
    const pairing = pickMoovSandboxTransferMethods(isolatedMethods);
    if (pairing.source?.id) {
      await insertSandboxObject(client, {
        tenantId,
        provider: 'moov',
        objectType: 'source_payment_method',
        sandboxProviderId: pairing.source.id,
        metadata: { source: 'sandbox_probe', paymentMethodType: pairing.source.type || null, pairing: pairing.pairing },
      });
    }
    if (pairing.destination?.id) {
      await insertSandboxObject(client, {
        tenantId,
        provider: 'moov',
        objectType: 'destination_payment_method',
        sandboxProviderId: pairing.destination.id,
        metadata: { source: 'sandbox_probe', paymentMethodType: pairing.destination.type || null, pairing: pairing.pairing },
      });
    }
    reads.transferPairing = pairing.pairing || null;
    await insertSandboxObject(client, {
      tenantId,
      provider: 'moov',
      objectType: 'account',
      sandboxProviderId: accountId,
      metadata: { source: 'sandbox_platform_account' },
    });
    await insertSandboxObject(client, {
      tenantId,
      provider: 'moov',
      objectType: 'facilitator',
      sandboxProviderId: accountId,
      metadata: { source: 'sandbox_probe' },
    });
  }
  await insertAudit(client, {
    applicationUserId: mapping.application_user_id,
    tenantId,
    operationType: 'moov_probe',
    provider: 'moov',
    outcome: 'moov_sandbox_probe',
    details: { reads },
  });
  return {
    ok: true,
    statusCode: 200,
    provider: 'moov',
    environment: 'sandbox',
    apiVersion: loaded.moov.apiVersion || 'v2024.01.00',
    sandboxHttpCalled: true,
    productionExecution: false,
    productionRecordsMutated: false,
    applicationUserId: mapping.application_user_id,
    authUid: mapping.application_user_id,
    cognitoSub: claims.sub,
    spoofFieldsIgnored: spoof,
    amountUnits: MOOV_SANDBOX_AMOUNT_API,
    reads,
  };
}, deps);

const handleMoovTransfer = async (event, deps) => handleAuthenticated(event, async ({ client, mapping, claims, body, spoof }) => {
  const untrusted = rejectUntrustedAmountFields(body);
  if (untrusted) return denied(spoof, untrusted);
  if (body?.live === true || body?.execute === true) {
    return denied(spoof, denyProviderExecution('moov', 'sandbox_transfer', { error: 'production_execution_blocked' }));
  }
  const gate = requireSandboxGate({ spoof });
  if (gate.ok !== true) return gate;
  const memberships = await membershipsOf(client, mapping.application_user_id);
  if (!memberships.length) return denied(spoof, { error: 'no_tenant_membership' });
  const tenantId = memberships[0].tenant_id;
  const loaded = await (deps.loadSandboxCredentials || loadSandboxCredentials)();
  const fetchImpl = deps.fetchImpl || fetch;
  const key = stableIdempotencyKey({
    tenantId,
    operationType: 'moov_sandbox_transfer',
    resourceId: body?.resource_id || tenantId,
    amountCents: SANDBOX_MIN_CENTS,
  });
  const existing = await lookupSandboxOperation(client, { idempotencyKey: key, tenantId });
  if (existing?.provider_reference) {
    await insertAudit(client, {
      applicationUserId: mapping.application_user_id,
      tenantId,
      operationType: 'moov_sandbox_transfer',
      operationId: existing.id,
      provider: 'moov',
      providerReference: existing.provider_reference,
      outcome: 'idempotent_replay',
      idempotencyKey: key,
    });
    return {
      ok: true,
      statusCode: 200,
      duplicate: true,
      replayed: true,
      sandboxHttpCalled: false,
      productionExecution: false,
      applicationUserId: mapping.application_user_id,
      spoofFieldsIgnored: spoof,
      amount: { currency: 'USD', value: Number(existing.amount_cents), cents: Number(existing.amount_cents) },
      providerReference: redactProviderId(existing.provider_reference),
      operation: publicOperation(existing),
      message: 'Same ChecksOps operation replayed. No second provider call.',
    };
  }
  if (!loaded.moov) {
    if (existing) {
      return {
        ok: true,
        statusCode: 200,
        duplicate: true,
        replayed: true,
        failClosed: true,
        error: existing.failure_class || 'sandbox_credentials_unavailable',
        sandboxHttpCalled: false,
        productionExecution: false,
        applicationUserId: mapping.application_user_id,
        spoofFieldsIgnored: spoof,
        operation: publicOperation(existing),
        message: 'Same ChecksOps operation replayed. No second provider call.',
      };
    }
    const inserted = (await client.query(
      `INSERT INTO public.aws_provider_sandbox_operations
        (tenant_id, application_user_id, operation_type, provider, amount_cents, currency,
         idempotency_key, status, sandbox_http_called, production_execution, failure_class, metadata)
       VALUES ($1::uuid, $2::uuid, 'moov_sandbox_transfer', 'moov', $3, 'USD', $4, 'failed', false, false, 'sandbox_credentials_unavailable', $5::jsonb)
       RETURNING *`,
      [tenantId, mapping.application_user_id, SANDBOX_MIN_CENTS, key, JSON.stringify({ marker: body?.marker || SANDBOX_MARKER })],
    )).rows[0];
    await insertAudit(client, {
      applicationUserId: mapping.application_user_id,
      tenantId,
      operationType: 'moov_sandbox_transfer',
      operationId: inserted.id,
      provider: 'moov',
      outcome: 'sandbox_credentials_unavailable',
      idempotencyKey: key,
    });
    return {
      ok: true,
      statusCode: 200,
      failClosed: true,
      error: 'sandbox_credentials_unavailable',
      provider: 'moov',
      sandboxHttpCalled: false,
      productionExecution: false,
      productionRecordsMutated: false,
      applicationUserId: mapping.application_user_id,
      spoofFieldsIgnored: spoof,
      operation: publicOperation(inserted),
      capability: loaded.snapshot.moov,
      message: 'Moov sandbox keys are not present. No provider HTTP was sent. Production keys were not used.',
    };
  }
  const production = await productionProviderIds(client, tenantId);
  const facilitatorRow = await lookupSandboxObject(client, { tenantId, provider: 'moov', objectType: 'facilitator' })
    || await lookupSandboxObject(client, { tenantId, provider: 'moov', objectType: 'account' });
  const facilitator = loaded.moov.platformAccountId || facilitatorRow?.sandbox_provider_id;
  if (facilitator && production.productionAccountIds.includes(facilitator)) {
    return denied(spoof, {
      statusCode: 403,
      error: 'production_provider_id_refused',
      message: 'Moov sandbox platform account matches a production RDS provider_account_id. HTTP stopped.',
    });
  }
  const source = await lookupSandboxObject(client, { tenantId, provider: 'moov', objectType: 'source_payment_method' })
    || await lookupSandboxObject(client, { tenantId, provider: 'moov', objectType: 'payment_method' });
  const destination = await lookupSandboxObject(client, { tenantId, provider: 'moov', objectType: 'destination_payment_method' });
  if (source && (production.productionAccountIds.includes(source.sandbox_provider_id) || production.productionWalletIds.includes(source.sandbox_provider_id))) {
    return denied(spoof, {
      statusCode: 403,
      error: 'production_provider_id_refused',
      message: 'Sandbox source payment method matches a production provider ID. HTTP stopped.',
    });
  }
  if (!source?.sandbox_provider_id || !destination?.sandbox_provider_id) {
    if (existing) {
      return {
        ok: true,
        statusCode: 200,
        duplicate: true,
        replayed: true,
        failClosed: true,
        error: existing.failure_class || 'sandbox_account_unmapped',
        sandboxHttpCalled: false,
        productionExecution: false,
        applicationUserId: mapping.application_user_id,
        spoofFieldsIgnored: spoof,
        operation: publicOperation(existing),
        message: 'Same ChecksOps operation replayed. Production Moov account IDs were not used.',
      };
    }
    const inserted = (await client.query(
      `INSERT INTO public.aws_provider_sandbox_operations
        (tenant_id, application_user_id, operation_type, provider, amount_cents, currency,
         idempotency_key, status, sandbox_http_called, production_execution, failure_class, metadata)
       VALUES ($1::uuid, $2::uuid, 'moov_sandbox_transfer', 'moov', $3, 'USD', $4, 'failed', false, false, 'sandbox_account_unmapped', $5::jsonb)
       RETURNING *`,
      [tenantId, mapping.application_user_id, SANDBOX_MIN_CENTS, key, JSON.stringify({
        marker: body?.marker || SANDBOX_MARKER,
        used_production_ids: false,
      })],
    )).rows[0];
    await insertAudit(client, {
      applicationUserId: mapping.application_user_id,
      tenantId,
      operationType: 'moov_sandbox_transfer',
      operationId: inserted.id,
      provider: 'moov',
      outcome: 'sandbox_account_unmapped',
      idempotencyKey: key,
    });
    return {
      ok: true,
      statusCode: 200,
      failClosed: true,
      error: 'sandbox_account_unmapped',
      provider: 'moov',
      sandboxHttpCalled: false,
      productionExecution: false,
      productionRecordsMutated: false,
      applicationUserId: mapping.application_user_id,
      spoofFieldsIgnored: spoof,
      operation: publicOperation(inserted),
      message: 'No sandbox payment methods are mapped for this tenant. Production Moov account IDs were not used.',
    };
  }
  const transferBody = buildMoovSandboxTransferBody({
    sourcePaymentMethodId: source.sandbox_provider_id,
    destinationPaymentMethodId: destination.sandbox_provider_id,
    amountCents: SANDBOX_MIN_CENTS,
  });
  const pending = existing || await insertPendingOperation(client, {
    tenantId,
    applicationUserId: mapping.application_user_id,
    operationType: 'moov_sandbox_transfer',
    provider: 'moov',
    amountCents: SANDBOX_MIN_CENTS,
    idempotencyKey: key,
    metadata: { marker: body?.marker || SANDBOX_MARKER },
  });
  const created = await moovSandboxFetch({
    credentials: loaded.moov,
    path: `/accounts/${facilitator}/transfers`,
    method: 'POST',
    scopes: moovSandboxScopes.transfersWrite(facilitator),
    body: transferBody,
    idempotencyKey: key,
    fetchImpl,
  });
  if (!created.ok) {
    const failed = await updateSandboxOperation(client, {
      id: pending.id,
      status: 'failed',
      sandboxHttpCalled: true,
      failureClass: `provider_${created.httpStatus || 500}`,
      metadataPatch: { httpStatus: created.httpStatus || null, recovery: Boolean(existing) },
    });
    await insertAudit(client, {
      applicationUserId: mapping.application_user_id,
      tenantId,
      operationType: 'moov_sandbox_transfer',
      operationId: failed.id,
      provider: 'moov',
      outcome: 'provider_failure',
      idempotencyKey: key,
      details: { httpStatus: created.httpStatus || null },
    });
    return denied(spoof, {
      ...created,
      sandboxHttpCalled: true,
      operation: publicOperation(failed),
    });
  }
  const normalized = normalizeMoovSandboxTransfer(created.data || {});
  const inserted = await updateSandboxOperation(client, {
    id: pending.id,
    status: 'provider_pending',
    providerReference: normalized.provider_transfer_id,
    sandboxHttpCalled: true,
    metadataPatch: {
      marker: body?.marker || SANDBOX_MARKER,
      moov_idempotency_uuid: created.idempotencyKey,
      recovery: Boolean(existing),
      simulated_provider: {
        provider_reference: normalized.provider_transfer_id,
        status: normalized.status || 'pending',
        amount_cents: SANDBOX_MIN_CENTS,
      },
    },
  });
  await insertSandboxObject(client, {
    tenantId,
    provider: 'moov',
    objectType: 'transfer',
    sandboxProviderId: normalized.provider_transfer_id,
    metadata: { operation_id: inserted.id },
  });
  await insertAudit(client, {
    applicationUserId: mapping.application_user_id,
    tenantId,
    operationType: 'moov_sandbox_transfer',
    operationId: inserted.id,
    provider: 'moov',
    providerReference: normalized.provider_transfer_id,
    outcome: existing ? 'sandbox_transfer_recovered' : 'sandbox_transfer_created',
    idempotencyKey: key,
  });
  return {
    ok: true,
    statusCode: 200,
    duplicate: Boolean(existing),
    recovered: Boolean(existing),
    sandboxHttpCalled: true,
    productionExecution: false,
    productionRecordsMutated: false,
    applicationUserId: mapping.application_user_id,
    cognitoSub: claims.sub,
    spoofFieldsIgnored: spoof,
    amount: { ...transferBody.amount, cents: SANDBOX_MIN_CENTS },
    providerReference: redactProviderId(normalized.provider_transfer_id),
    environment: 'sandbox',
    apiVersion: loaded.moov.apiVersion || 'v2024.01.00',
    operation: publicOperation(inserted),
    provider: normalizeMoovSandboxTransfer(created.data || {}),
  };
}, deps);

const handleMoovRetrieve = async (event, deps) => handleAuthenticated(event, async ({ client, mapping, claims, body, spoof }) => {
  const gate = requireSandboxGate({ spoof });
  if (gate.ok !== true) return gate;
  const memberships = await membershipsOf(client, mapping.application_user_id);
  const operation = await lookupSandboxOperation(client, {
    operationId: body?.operation_id,
    idempotencyKey: body?.idempotency_key,
    tenantId: memberships[0]?.tenant_id,
  });
  if (!operation) return denied(spoof, { statusCode: 404, error: 'operation_not_found' });
  if (!memberships.some((row) => row.tenant_id === operation.tenant_id)) {
    return denied(spoof, { error: 'cross_tenant_denied' });
  }
  const loaded = await (deps.loadSandboxCredentials || loadSandboxCredentials)();
  if (!loaded.moov || !operation.provider_reference) {
    return {
      ok: true,
      statusCode: 200,
      sandboxHttpCalled: false,
      productionExecution: false,
      applicationUserId: mapping.application_user_id,
      cognitoSub: claims.sub,
      spoofFieldsIgnored: spoof,
      operation: publicOperation(operation),
      retrieved: false,
      reason: loaded.moov ? 'missing_provider_reference' : 'sandbox_credentials_unavailable',
    };
  }
  const facilitatorRow = await lookupSandboxObject(client, { tenantId: operation.tenant_id, provider: 'moov', objectType: 'facilitator' })
    || await lookupSandboxObject(client, { tenantId: operation.tenant_id, provider: 'moov', objectType: 'account' });
  const facilitator = loaded.moov.platformAccountId || facilitatorRow?.sandbox_provider_id;
  const fetched = await moovSandboxFetch({
    credentials: loaded.moov,
    path: `/accounts/${facilitator}/transfers/${operation.provider_reference}`,
    scopes: moovSandboxScopes.transfersRead(facilitator),
    fetchImpl: deps.fetchImpl || fetch,
  });
  const listed = await moovSandboxFetch({
    credentials: loaded.moov,
    path: `/accounts/${facilitator}/transfers`,
    scopes: moovSandboxScopes.transfersRead(facilitator),
    fetchImpl: deps.fetchImpl || fetch,
  });
  const listedIds = collectMoovTransferIds(listed.data);
  const matching = listedIds.filter((id) => id === operation.provider_reference);
  return {
    ok: fetched.ok,
    statusCode: fetched.ok ? 200 : fetched.statusCode || 502,
    sandboxHttpCalled: true,
    productionExecution: false,
    applicationUserId: mapping.application_user_id,
    spoofFieldsIgnored: spoof,
    operation: publicOperation(operation),
    provider: fetched.ok ? normalizeMoovSandboxTransfer(fetched.data || {}) : null,
    providerStatus: fetched.ok ? (fetched.data?.status || null) : null,
    providerReference: redactProviderId(operation.provider_reference),
    providerObjectCount: matching.length,
    listedTransferCount: listedIds.length,
    error: fetched.ok ? undefined : fetched.error,
  };
}, deps);

const handleCheckAltProbe = async (event, deps) => handleAuthenticated(event, async ({ client, mapping, claims, body, spoof }) => {
  const untrusted = rejectUntrustedAmountFields(body);
  if (untrusted) return denied(spoof, untrusted);
  const gate = requireSandboxGate({ spoof });
  if (gate.ok !== true) return gate;
  const memberships = await membershipsOf(client, mapping.application_user_id);
  const tenantId = memberships[0]?.tenant_id;
  if (!tenantId) return denied(spoof, { error: 'no_tenant_membership' });
  const loaded = await (deps.loadSandboxCredentials || loadSandboxCredentials)();
  const gateCreds = assertCheckAltSandboxCredentials(loaded.checkalt);
  if (!gateCreds.ok) {
    await insertAudit(client, {
      applicationUserId: mapping.application_user_id,
      tenantId,
      operationType: 'checkalt_probe',
      provider: 'checkalt',
      outcome: gateCreds.error,
    });
    return denied(spoof, { ...gateCreds, capability: loaded.snapshot.checkalt });
  }
  const auth = await checkAltSandboxAuthenticate({
    credentials: loaded.checkalt,
    fetchImpl: deps.fetchImpl || fetch,
  });
  await insertAudit(client, {
    applicationUserId: mapping.application_user_id,
    tenantId,
    operationType: 'checkalt_probe',
    provider: 'checkalt',
    outcome: auth.ok ? 'checkalt_sandbox_auth' : 'checkalt_sandbox_auth_failed',
  });
  return {
    ok: auth.ok,
    statusCode: auth.ok ? 200 : auth.statusCode || 502,
    provider: 'checkalt',
    environment: 'uat',
    host: CHECKALT_UAT_HOST,
    merchant: CHECKALT_UAT_MERCHANT_EXPECTED,
    authPath: auth.authPath || CHECKALT_UAT_AUTH_PATH,
    sandboxHttpCalled: true,
    productionExecution: false,
    productionRecordsMutated: false,
    negotiableCheckSubmitted: false,
    applicationUserId: mapping.application_user_id,
    cognitoSub: claims.sub,
    spoofFieldsIgnored: spoof,
    amountPreview: buildCheckAltSandboxDeposit({ amountCents: SANDBOX_MIN_CENTS }),
    authentication: { ok: auth.ok, tokenPresent: Boolean(auth.tokenPresent) },
  };
}, deps);

const handleCheckAltDeposit = async (event, deps) => handleAuthenticated(event, async ({ client, mapping, claims, body, spoof }) => {
  const untrusted = rejectUntrustedAmountFields(body);
  if (untrusted) return denied(spoof, untrusted);
  const gate = requireSandboxGate({ spoof });
  if (gate.ok !== true) return gate;
  const memberships = await membershipsOf(client, mapping.application_user_id);
  const tenantId = memberships[0]?.tenant_id;
  if (!tenantId) return denied(spoof, { error: 'no_tenant_membership' });
  const amount = serverAmountCents(body);
  if (amount.error) return denied(spoof, { statusCode: 400, ...amount });
  const key = stableIdempotencyKey({
    tenantId,
    operationType: 'checkalt_sandbox_deposit',
    resourceId: body?.resource_id || tenantId,
    amountCents: amount.cents,
  });
  const existing = await lookupSandboxOperation(client, { idempotencyKey: key, tenantId });
  if (existing?.provider_reference) {
    return {
      ok: true,
      statusCode: 200,
      duplicate: true,
      replayed: true,
      sandboxHttpCalled: false,
      productionExecution: false,
      negotiableCheckSubmitted: false,
      amount: { ...buildCheckAltSandboxDeposit({ amountCents: Number(existing.amount_cents), reference: key }), cents: Number(existing.amount_cents) },
      providerReference: redactProviderId(existing.provider_reference),
      operation: publicOperation(existing),
      spoofFieldsIgnored: spoof,
    };
  }
  const loaded = await (deps.loadSandboxCredentials || loadSandboxCredentials)();
  const deposit = buildCheckAltSandboxDeposit({ amountCents: amount.cents, reference: key });
  if (!loaded.checkalt) {
    if (existing) {
      return {
        ok: true,
        statusCode: 200,
        duplicate: true,
        replayed: true,
        failClosed: true,
        error: existing.failure_class || 'sandbox_credentials_unavailable',
        sandboxHttpCalled: false,
        productionExecution: false,
        negotiableCheckSubmitted: false,
        operation: publicOperation(existing),
        amount: { ...deposit, cents: amount.cents },
        spoofFieldsIgnored: spoof,
      };
    }
    const inserted = (await client.query(
      `INSERT INTO public.aws_provider_sandbox_operations
        (tenant_id, application_user_id, operation_type, provider, amount_cents, currency,
         idempotency_key, status, sandbox_http_called, production_execution, failure_class, metadata)
       VALUES ($1::uuid, $2::uuid, 'checkalt_sandbox_deposit', 'checkalt', $3, 'USD', $4, 'failed', false, false, 'sandbox_credentials_unavailable', $5::jsonb)
       RETURNING *`,
      [tenantId, mapping.application_user_id, amount.cents, key, JSON.stringify({ marker: body?.marker || SANDBOX_MARKER, fixture: amount.fixture })],
    )).rows[0];
    return {
      ok: true,
      statusCode: 200,
      failClosed: true,
      error: 'sandbox_credentials_unavailable',
      provider: 'checkalt',
      sandboxHttpCalled: false,
      productionExecution: false,
      productionRecordsMutated: false,
      negotiableCheckSubmitted: false,
      applicationUserId: mapping.application_user_id,
      spoofFieldsIgnored: spoof,
      capability: loaded.snapshot.checkalt,
      operation: publicOperation(inserted),
      amount: { ...deposit, cents: amount.cents },
      message: 'No CheckAlt UAT is configured. No negotiable check was submitted.',
    };
  }
  if (existing && !existing.provider_reference) {
    const history = await checkAltSandboxFetch({
      credentials: loaded.checkalt,
      path: '/fincapture/deposit/history',
      body: { fiKey: loaded.checkalt.fiKey, ssoKey: loaded.checkalt.userId },
      fetchImpl: deps.fetchImpl || fetch,
    });
    const discovered = extractCheckAltReference(history.data)
      || extractCheckAltReference((history.data?.depositHistoryList || history.data?.depositList || [])[0] || {});
    if (discovered) {
      const recovered = await updateSandboxOperation(client, {
        id: existing.id,
        status: 'provider_pending',
        providerReference: discovered,
        sandboxHttpCalled: true,
        metadataPatch: { recovered: true, discovery: 'history' },
      });
      return {
        ok: true,
        statusCode: 200,
        duplicate: true,
        recovered: true,
        sandboxHttpCalled: true,
        productionExecution: false,
        negotiableCheckSubmitted: false,
        amount: { ...deposit, cents: amount.cents },
        providerReference: redactProviderId(discovered),
        operation: publicOperation(recovered),
        spoofFieldsIgnored: spoof,
        message: 'Recovered existing UAT deposit. No second process call.',
      };
    }
    await insertAudit(client, {
      applicationUserId: mapping.application_user_id,
      tenantId,
      operationType: 'checkalt_sandbox_deposit',
      operationId: existing.id,
      provider: 'checkalt',
      outcome: 'recovery_required',
      idempotencyKey: key,
    });
    return {
      ok: true,
      statusCode: 200,
      duplicate: true,
      recovered: false,
      recoveryRequired: true,
      sandboxHttpCalled: history.ok === true,
      productionExecution: false,
      negotiableCheckSubmitted: false,
      amount: { ...deposit, cents: amount.cents },
      operation: publicOperation(existing),
      spoofFieldsIgnored: spoof,
      message: 'Existing ChecksOps deposit has no provider reference. History did not discover one. No second UAT deposit submitted.',
    };
  }
  const pending = await insertPendingOperation(client, {
    tenantId,
    applicationUserId: mapping.application_user_id,
    operationType: 'checkalt_sandbox_deposit',
    provider: 'checkalt',
    amountCents: amount.cents,
    idempotencyKey: key,
    metadata: { marker: body?.marker || SANDBOX_MARKER, fixture: amount.fixture, syntheticImages: true, negotiableCheck: false },
  });
  // Prefer a previously registered UAT depositor from sandbox objects (documented
  // FinCapture register → ssoKey workflow). Never substitute the API login as ssoKey.
  const registered = await lookupSandboxObject(client, {
    tenantId,
    provider: 'checkalt',
    objectType: 'uat_tenant_account',
  });
  let extracted = {
    ssoKey: null,
    depositAccountNumber: null,
    hasSsoKey: false,
    hasDepositAccount: false,
    accountCount: 0,
    accountObjectKeys: [],
    source: 'unregistered',
  };
  if (registered?.metadata?.deposit_account_number
    && (registered.metadata.sso_key || registered.metadata.sso_user_id || registered.sandbox_provider_id)) {
    const ssoKey = registered.metadata.sso_key
      || registered.metadata.sso_user_id
      || registered.sandbox_provider_id;
    if (ssoKey !== loaded.checkalt.userId && ssoKey !== loaded.checkalt.username) {
      extracted = {
        ssoKey,
        depositAccountNumber: registered.metadata.deposit_account_number,
        hasSsoKey: true,
        hasDepositAccount: true,
        accountCount: 1,
        accountObjectKeys: [],
        source: 'uat_isolated_row',
      };
    }
  }
  if (!extracted.hasSsoKey || !extracted.hasDepositAccount) {
    const user = await checkAltSandboxFetch({
      credentials: loaded.checkalt,
      path: '/fincapture/useraccount/getUserAccountInformation',
      body: { fiKey: loaded.checkalt.fiKey, userId: loaded.checkalt.userId },
      fetchImpl: deps.fetchImpl || fetch,
    });
    const depositAccount = await checkAltSandboxFetch({
      credentials: loaded.checkalt,
      path: '/fincapture/useraccount/getDepositAccountInformation',
      body: { fiKey: loaded.checkalt.fiKey, userId: loaded.checkalt.userId },
      fetchImpl: deps.fetchImpl || fetch,
    });
    extracted = {
      ...extractCheckAltSsoAndAccount(user.data, depositAccount.data),
      source: 'api_login_lookup',
    };
  }
  if (!extracted.hasDepositAccount || !extracted.hasSsoKey) {
    const failureReason = !extracted.hasSsoKey
      ? 'missing_depositor_sso_key'
      : 'missing_deposit_account';
    const failed = await updateSandboxOperation(client, {
      id: pending.id,
      status: 'failed',
      sandboxHttpCalled: true,
      failureClass: 'account_unregistered',
      metadataPatch: {
        marker: body?.marker || SANDBOX_MARKER,
        fixture: amount.fixture,
        syntheticImages: true,
        negotiableCheck: false,
        hasUatAccount: extracted.hasDepositAccount,
        hasSsoKey: extracted.hasSsoKey,
        registeredTestAccount: false,
        reason: failureReason,
        accountObjectKeys: extracted.accountObjectKeys,
      },
    });
    await insertAudit(client, {
      applicationUserId: mapping.application_user_id,
      tenantId,
      operationType: 'checkalt_sandbox_deposit',
      operationId: failed.id,
      provider: 'checkalt',
      outcome: 'account_unregistered',
      idempotencyKey: key,
    });
    return {
      ok: false,
      statusCode: 409,
      error: 'account_unregistered',
      provider: 'checkalt',
      sandboxHttpCalled: true,
      productionExecution: false,
      productionRecordsMutated: false,
      negotiableCheckSubmitted: false,
      registeredTestAccount: false,
      applicationUserId: mapping.application_user_id,
      spoofFieldsIgnored: spoof,
      amount: { ...deposit, cents: amount.cents },
      uatAccount: {
        hasSsoKey: extracted.hasSsoKey,
        hasDepositAccount: extracted.hasDepositAccount,
        accountCount: extracted.accountCount,
        accountObjectKeys: extracted.accountObjectKeys,
        failureReason,
      },
      operation: publicOperation(failed),
      message: !extracted.hasSsoKey
        ? 'CheckAlt UAT depositor ssoKey is missing. A FinCapture depositor must be registered on UAT (API login is never used as ssoKey). Deposit account registration was not invented. No negotiable check was submitted.'
        : 'CheckAlt UAT user has no deposit account. A TEST account was not registered because that requires bank numbers. No negotiable check was submitted.',
    };
  }
  const packed = buildCheckAltUatDepositBody({
    credentials: loaded.checkalt,
    amountCents: amount.cents,
    reference: key,
    ssoKey: extracted.ssoKey,
    depositAccountNumber: extracted.depositAccountNumber,
  });
  if (packed.error) {
    return {
      ok: false,
      statusCode: packed.statusCode || 409,
      error: packed.error,
      message: packed.message || null,
      sandboxHttpCalled: true,
      productionExecution: false,
      negotiableCheckSubmitted: false,
      applicationUserId: mapping.application_user_id,
      spoofFieldsIgnored: spoof,
      amount: { ...deposit, cents: amount.cents },
      operation: publicOperation(pending),
    };
  }
  const submitted = await checkAltSandboxFetch({
    credentials: loaded.checkalt,
    path: '/fincapture/deposit/process',
    body: packed.request,
    fetchImpl: deps.fetchImpl || fetch,
  });
  const reference = extractCheckAltReference(submitted.data);
  const amountEcho = extractCheckAltAmountEcho(submitted.data);
  const inserted = await updateSandboxOperation(client, {
    id: pending.id,
    status: submitted.ok ? 'provider_pending' : 'failed',
    providerReference: reference,
    sandboxHttpCalled: true,
    failureClass: submitted.ok ? null : `provider_${submitted.httpStatus || 500}`,
    metadataPatch: {
      marker: body?.marker || SANDBOX_MARKER,
      userAmount: deposit.userAmount,
      fixture: amount.fixture,
      syntheticImages: true,
      negotiableCheck: false,
      imageKind: packed.meta?.imageKind || null,
      imagePipeline: packed.meta?.imagePipeline || null,
      frontInfo: packed.meta?.frontInfo || null,
      rearInfo: packed.meta?.rearInfo || null,
      performRiskAssessment: true,
      testDeposit: false,
      amountEcho,
      hasUatAccount: extracted.hasDepositAccount,
      depositorSource: extracted.source || null,
      providerHttpStatus: submitted.httpStatus || submitted.statusCode || null,
      providerMessage: submitted.message || null,
      providerResponseKeys: submitted.providerResponseKeys || null,
    },
  });
  return {
    ok: submitted.ok,
    statusCode: submitted.ok ? 200 : submitted.statusCode || 502,
    error: submitted.ok ? undefined : (submitted.error || 'checkalt_uat_http_failed'),
    message: submitted.ok ? undefined : (submitted.message || null),
    providerHttpStatus: submitted.httpStatus || submitted.statusCode || null,
    providerResponseKeys: submitted.providerResponseKeys || null,
    path: submitted.path || '/fincapture/deposit/process',
    sandboxHttpCalled: true,
    productionExecution: false,
    negotiableCheckSubmitted: false,
    webhookRequired: false,
    applicationUserId: mapping.application_user_id,
    spoofFieldsIgnored: spoof,
    amount: { ...deposit, cents: amount.cents },
    image: {
      kind: packed.meta?.imageKind || null,
      pipeline: packed.meta?.imagePipeline || null,
      front: packed.meta?.frontInfo || null,
      rear: packed.meta?.rearInfo || null,
      performRiskAssessment: true,
      testDepositSent: false,
    },
    amountUnitEvidence: {
      sentUserAmount: deposit.userAmount,
      sentChecksOpsCents: amount.cents,
      ...amountEcho,
      inferredScale: amountEcho.echoedUserAmount == null
        ? 'not_echoed'
        : (Number(amountEcho.echoedUserAmount) === amount.cents ? 'integer_cents' : 'unconfirmed'),
    },
    uatAccount: {
      hasSsoKey: extracted.hasSsoKey,
      hasDepositAccount: extracted.hasDepositAccount,
      accountCount: extracted.accountCount,
      source: extracted.source || null,
    },
    providerReference: redactProviderId(reference),
    operation: publicOperation(inserted),
  };
}, deps);

const handleCheckAltRegister = async (event, deps) => handleAuthenticated(event, async ({ client, mapping, claims, body, spoof }) => {
  const gate = requireSandboxGate({ spoof });
  if (gate.ok !== true) return gate;
  const memberships = await membershipsOf(client, mapping.application_user_id);
  const tenantId = body?.tenant_id || memberships[0]?.tenant_id;
  if (!tenantId) return denied(spoof, { error: 'no_tenant_membership' });
  if (!memberships.some((row) => row.tenant_id === tenantId) && memberships.length) {
    // Master may see all tenants via RLS; still require explicit tenant_id for isolation.
  }
  const loaded = await (deps.loadSandboxCredentials || loadSandboxCredentials)();
  const gateCreds = assertCheckAltSandboxCredentials(loaded.checkalt);
  if (!gateCreds.ok) return denied(spoof, { ...gateCreds, capability: loaded.snapshot.checkalt });
  const fetchImpl = deps.fetchImpl || fetch;
  const ssoUserId = String(body?.sso_user_id || '').trim() || `aws-uat-${Date.now().toString(36)}`;
  if (ssoUserId === loaded.checkalt.userId || ssoUserId === loaded.checkalt.username) {
    return denied(spoof, {
      statusCode: 400,
      error: 'uat_depositor_must_not_be_api_login',
      message: 'FinCapture depositor userId must not be the CHECKALT_UAT API login.',
    });
  }
  // Discover authorized UAT deposit account via documented API workflow unless body supplies
  // a number that was already returned by UAT discovery (never invent; never prefer sample-only).
  const user = await checkAltSandboxFetch({
    credentials: loaded.checkalt,
    path: '/fincapture/useraccount/getUserAccountInformation',
    body: { fiKey: loaded.checkalt.fiKey, userId: loaded.checkalt.userId },
    fetchImpl,
  });
  const listed = collectCheckAltAccountNumbers(user.data || {});
  const requested = String(body?.deposit_account_number || '').trim();
  let depositAccountNumber = null;
  if (requested) {
    if (requested === '123456789' && !listed.includes('123456789')) {
      return denied(spoof, {
        statusCode: 409,
        error: 'sample_deposit_account_refused',
        message: 'CheckAlt sample 123456789 is refused unless UAT getUserAccountInformation returns it for this business unit.',
      });
    }
    if (!listed.includes(requested) && !loaded.checkalt.depositAccountNumber) {
      return denied(spoof, {
        statusCode: 409,
        error: 'deposit_account_not_in_uat_list',
        message: 'Provided deposit account was not returned by UAT getUserAccountInformation. Refusing to invent or use an unverified number.',
      });
    }
    depositAccountNumber = requested;
  } else {
    for (const accountNumber of listed) {
      if (accountNumber === '123456789') continue;
      const deposit = await checkAltSandboxFetch({
        credentials: loaded.checkalt,
        path: '/fincapture/useraccount/getDepositAccountInformation',
        body: { fiKey: loaded.checkalt.fiKey, userId: loaded.checkalt.userId, accountNumber },
        fetchImpl,
      });
      if (deposit.ok) {
        depositAccountNumber = accountNumber;
        break;
      }
    }
  }
  if (!depositAccountNumber) {
    return denied(spoof, {
      statusCode: 409,
      error: 'blocked_by_checkalt_test_configuration',
      classification: 'BLOCKED BY CHECKALT TEST CONFIGURATION',
      message: 'No authorized UAT deposit account could be identified via getUserAccountInformation → getDepositAccountInformation. Deposit account number is the remaining vendor-provisioning item. Sample 123456789 was not used.',
      liveProviderCalled: true,
      listedAccountCount: listed.length,
      webhookRequired: false,
    });
  }
  const payload = buildRegisterPayload({
    fiKey: loaded.checkalt.fiKey,
    ssoUserId,
    firstName: body?.first_name || 'UAT',
    lastName: body?.last_name || 'Depositor',
    email: body?.email || 'uat-depositor@checksops.invalid',
    depositAccountNumber,
  });
  const registered = await checkAltSandboxFetch({
    credentials: loaded.checkalt,
    path: '/fincapture/useraccount/register',
    body: payload,
    fetchImpl,
  });
  if (!registered.ok) {
    return denied(spoof, {
      ...registered,
      sandboxHttpCalled: true,
      productionExecution: false,
      negotiableCheckSubmitted: false,
      message: registered.message || 'CheckAlt UAT register failed',
    });
  }
  const info = await checkAltSandboxFetch({
    credentials: loaded.checkalt,
    path: '/fincapture/useraccount/getUserAccountInformation',
    body: { fiKey: loaded.checkalt.fiKey, userId: ssoUserId },
    fetchImpl,
  });
  const ssoKey = info.ok ? (extractSsoKey(info.data, depositAccountNumber) || ssoUserId) : ssoUserId;
  await insertSandboxObject(client, {
    tenantId,
    provider: 'checkalt',
    objectType: 'uat_tenant_account',
    sandboxProviderId: ssoUserId,
    metadata: {
      sso_user_id: ssoUserId,
      deposit_account_number: depositAccountNumber,
      sso_key: ssoKey,
      source: 'sandbox_register',
      production_table_written: false,
      account_fingerprint: fingerprintAccountNumber(depositAccountNumber),
    },
  });
  await insertAudit(client, {
    applicationUserId: mapping.application_user_id,
    tenantId,
    operationType: 'checkalt_register',
    provider: 'checkalt',
    outcome: 'uat_depositor_registered',
    details: {
      ssoUserIdRedacted: `${ssoUserId.slice(0, 2)}…`,
      accountFingerprint: fingerprintAccountNumber(depositAccountNumber),
      ssoKeyReturned: Boolean(extractSsoKey(info.data, depositAccountNumber)),
    },
  });
  return {
    ok: true,
    statusCode: 200,
    sandboxHttpCalled: true,
    productionExecution: false,
    productionRecordsMutated: false,
    negotiableCheckSubmitted: false,
    webhookRequired: false,
    applicationUserId: mapping.application_user_id,
    spoofFieldsIgnored: spoof,
    ssoUserIdRedacted: `${ssoUserId.slice(0, 2)}…`,
    ssoKeyPresent: Boolean(ssoKey),
    ssoKeyFromAccountInfo: Boolean(extractSsoKey(info.data, depositAccountNumber)),
    depositAccountRedacted: redactAccountNumber(depositAccountNumber),
    depositAccountFingerprint: fingerprintAccountNumber(depositAccountNumber),
    message: 'Synthetic UAT depositor registered. Production checkalt_tenant_accounts was not written.',
  };
}, deps);

const handleCheckAltAccount = async (event, deps) => handleAuthenticated(event, async ({ client, mapping, claims, spoof }) => {
  const gate = requireSandboxGate({ spoof });
  if (gate.ok !== true) return gate;
  const memberships = await membershipsOf(client, mapping.application_user_id);
  const tenantId = memberships[0]?.tenant_id;
  if (!tenantId) return denied(spoof, { error: 'no_tenant_membership' });
  const loaded = await (deps.loadSandboxCredentials || loadSandboxCredentials)();
  const gateCreds = assertCheckAltSandboxCredentials(loaded.checkalt);
  if (!gateCreds.ok) return denied(spoof, { ...gateCreds, capability: loaded.snapshot.checkalt });
  const fetchImpl = deps.fetchImpl || fetch;
  // Documented workflow step: authenticate (inside fetch) → getUserAccountInformation
  const user = await checkAltSandboxFetch({
    credentials: loaded.checkalt,
    path: '/fincapture/useraccount/getUserAccountInformation',
    body: { fiKey: loaded.checkalt.fiKey, userId: loaded.checkalt.userId },
    fetchImpl,
  });
  const extracted = extractCheckAltSsoAndAccount(user.data, {});
  const accountNumbers = collectCheckAltAccountNumbers(user.data || {});
  // Documented workflow: getDepositAccountInformation requires accountNumber from prior list.
  // Never invent numbers; never use sample 123456789 unless UAT API returned it.
  const discoveries = [];
  for (const accountNumber of accountNumbers.slice(0, 5)) {
    const deposit = await checkAltSandboxFetch({
      credentials: loaded.checkalt,
      path: '/fincapture/useraccount/getDepositAccountInformation',
      body: {
        fiKey: loaded.checkalt.fiKey,
        userId: loaded.checkalt.userId,
        accountNumber,
      },
      fetchImpl,
    });
    const bus = extractCheckAltBusUnit(deposit.data || {});
    const depositExtracted = extractCheckAltSsoAndAccount(user.data, deposit.data || {});
    discoveries.push({
      accountNumber,
      ok: deposit.ok === true,
      httpStatus: deposit.statusCode || deposit.httpStatus || null,
      message: deposit.message || null,
      ssoKey: depositExtracted.ssoKey || null,
      busUnitId: bus.busUnitId,
      busUnitName: bus.busUnitName,
      objectKeys: deposit.data && typeof deposit.data === 'object' ? Object.keys(deposit.data).sort() : [],
    });
  }
  const authorized = discoveries.filter((row) => row.ok && row.accountNumber && row.accountNumber !== '123456789');
  const sampleOnly = discoveries.some((row) => row.accountNumber === '123456789' && row.ok)
    && authorized.length === 0;
  // Optional configured bus unit from restored checkalt_config (metadata only; not used as deposit number).
  let configuredBusUnitId = null;
  try {
    const cfg = (await client.query(
      `SELECT business_unit FROM public.checkalt_config ORDER BY updated_at DESC NULLS LAST LIMIT 1`,
    )).rows[0];
    configuredBusUnitId = cfg?.business_unit ? String(cfg.business_unit) : null;
  } catch { /* table may be unavailable under GUC; non-fatal */ }
  const registered = await lookupSandboxObject(client, {
    tenantId,
    provider: 'checkalt',
    objectType: 'uat_tenant_account',
  });
  return {
    ok: user.ok,
    statusCode: user.ok ? 200 : user.statusCode || 502,
    sandboxHttpCalled: true,
    productionExecution: false,
    productionRecordsMutated: false,
    negotiableCheckSubmitted: false,
    webhookRequired: false,
    applicationUserId: mapping.application_user_id,
    spoofFieldsIgnored: spoof,
    workflow: [
      'authenticate',
      'getUserAccountInformation',
      'getDepositAccountInformation',
      'register (if authorized deposit account discovered)',
      'deposit/process',
      'deposit history/status',
    ],
    userAccount: {
      ok: user.ok,
      httpStatus: user.statusCode || user.httpStatus || null,
      hasSsoKey: extracted.hasSsoKey,
      accountCount: extracted.accountCount,
      accountObjectKeys: extracted.accountObjectKeys,
      note: 'FI/API login view. Depositor ssoKey is expected after /useraccount/register, not on this login.',
    },
    discovery: {
      listedAccountCount: accountNumbers.length,
      depositLookups: summarizeDiscoveredDepositAccounts(discoveries),
      authorizedUatDepositAccountCount: authorized.length,
      sample123456789Present: accountNumbers.includes('123456789'),
      sample123456789UsedAsOnlyAuthorized: sampleOnly,
      firstAuthorizedAccountRedacted: authorized[0] ? redactAccountNumber(authorized[0].accountNumber) : null,
      firstAuthorizedAccountFingerprint: authorized[0] ? fingerprintAccountNumber(authorized[0].accountNumber) : null,
    },
    businessUnit: {
      configuredBusUnitIdRedacted: configuredBusUnitId ? redactAccountNumber(configuredBusUnitId) : null,
      configuredBusUnitIdFingerprint: configuredBusUnitId ? fingerprintAccountNumber(configuredBusUnitId) : null,
      note: 'CheckAlt allows busUnitId or busUnitName per merchant. Freedom Adjustment is provisioned on UAT; values are taken from configuration/API only.',
      observedOnDepositLookups: discoveries
        .map((row) => ({ busUnitId: row.busUnitId, busUnitName: row.busUnitName }))
        .filter((row) => row.busUnitId || row.busUnitName),
    },
    registeredUatDepositor: {
      present: Boolean(registered?.sandbox_provider_id),
      ssoUserIdRedacted: registered?.sandbox_provider_id
        ? `${String(registered.sandbox_provider_id).slice(0, 2)}…`
        : null,
      hasDepositAccountNumber: Boolean(registered?.metadata?.deposit_account_number),
      hasSsoKey: Boolean(registered?.metadata?.sso_key || registered?.metadata?.sso_user_id),
    },
    binding: {
      apiLoginNeverUsedAsSsoKey: true,
      webhookRequired: false,
      approvedDepositAccountSecretConfigured: Boolean(loaded.checkalt?.depositAccountNumber),
      authorizedDepositAccountDiscoveredViaApi: authorized.length > 0,
      remainingVendorAction: authorized.length > 0
        ? []
        : ['Authorized UAT deposit account number for Freedom Adjustment / lockbox5 (must appear via getUserAccountInformation → getDepositAccountInformation)'],
    },
  };
}, deps);

const handleCheckAltStatus = async (event, deps) => handleAuthenticated(event, async ({ client, mapping, claims, body, spoof }) => {
  const gate = requireSandboxGate({ spoof });
  if (gate.ok !== true) return gate;
  const memberships = await membershipsOf(client, mapping.application_user_id);
  const tenantId = memberships[0]?.tenant_id;
  const operation = await lookupSandboxOperation(client, {
    operationId: body?.operation_id,
    idempotencyKey: body?.idempotency_key,
    tenantId,
  });
  if (!operation) return denied(spoof, { statusCode: 404, error: 'operation_not_found' });
  if (!memberships.some((row) => row.tenant_id === operation.tenant_id)) {
    return denied(spoof, { error: 'cross_tenant_denied' });
  }
  const loaded = await (deps.loadSandboxCredentials || loadSandboxCredentials)();
  const gateCreds = assertCheckAltSandboxCredentials(loaded.checkalt);
  if (!gateCreds.ok || !operation.provider_reference) {
    return {
      ok: true,
      statusCode: 200,
      retrieved: false,
      sandboxHttpCalled: false,
      productionExecution: false,
      operation: publicOperation(operation),
      reason: gateCreds.ok ? 'missing_provider_reference' : gateCreds.error,
      webhookRequired: false,
    };
  }
  const registered = await lookupSandboxObject(client, {
    tenantId: operation.tenant_id,
    provider: 'checkalt',
    objectType: 'uat_tenant_account',
  });
  const ssoKey = (registered?.metadata?.sso_key
    || registered?.metadata?.sso_user_id
    || registered?.sandbox_provider_id
    || null);
  if (!ssoKey || ssoKey === loaded.checkalt.userId) {
    return {
      ok: false,
      statusCode: 409,
      error: 'account_unregistered',
      retrieved: false,
      sandboxHttpCalled: false,
      productionExecution: false,
      operation: publicOperation(operation),
      message: 'Status lookup requires a registered UAT depositor ssoKey. API login was not substituted.',
      webhookRequired: false,
    };
  }
  const item = await checkAltSandboxFetch({
    credentials: loaded.checkalt,
    path: '/fincapture/deposit/item',
    body: { fiKey: loaded.checkalt.fiKey, ssoKey, referenceNumber: operation.provider_reference },
    fetchImpl: deps.fetchImpl || fetch,
  });
  let history = null;
  let providerStatus = mapCheckAltStatus(item.data || {}) || extractCheckAltStatus(item.data);
  if (!providerStatus) {
    history = await checkAltSandboxFetch({
      credentials: loaded.checkalt,
      path: '/fincapture/deposit/history',
      body: { fiKey: loaded.checkalt.fiKey, ssoKey },
      fetchImpl: deps.fetchImpl || fetch,
    });
    providerStatus = mapCheckAltStatus(history.data || {}) || extractCheckAltStatus(history.data);
  }
  return {
    ok: item.ok || history?.ok === true,
    statusCode: (item.ok || history?.ok) ? 200 : item.statusCode || 502,
    sandboxHttpCalled: true,
    productionExecution: false,
    webhookRequired: false,
    operation: publicOperation(operation),
    providerStatus: providerStatus || null,
    providerReference: redactProviderId(operation.provider_reference),
    history: { ok: item.ok, httpStatus: item.statusCode || item.httpStatus || null, fallback: Boolean(history) },
  };
}, deps);

const handleCheckAltApprove = async (event, deps) => handleAuthenticated(event, async ({ client, mapping, claims, body, spoof }) => {
  const gate = requireSandboxGate({ spoof });
  if (gate.ok !== true) return gate;
  const memberships = await membershipsOf(client, mapping.application_user_id);
  const tenantId = memberships[0]?.tenant_id;
  const operation = await lookupSandboxOperation(client, {
    operationId: body?.operation_id,
    idempotencyKey: body?.idempotency_key,
    tenantId,
  });
  if (!operation) return denied(spoof, { statusCode: 404, error: 'operation_not_found' });
  if (!memberships.some((row) => row.tenant_id === operation.tenant_id)) {
    return denied(spoof, { error: 'cross_tenant_denied' });
  }
  if (operation.metadata?.negotiableCheck === true) {
    return denied(spoof, { statusCode: 403, error: 'negotiable_check_refused' });
  }
  const loaded = await (deps.loadSandboxCredentials || loadSandboxCredentials)();
  const gateCreds = assertCheckAltSandboxCredentials(loaded.checkalt);
  if (!gateCreds.ok || !operation.provider_reference) {
    return denied(spoof, {
      statusCode: 409,
      error: gateCreds.ok ? 'missing_provider_reference' : gateCreds.error,
      capability: loaded.snapshot.checkalt,
    });
  }
  const approved = await checkAltSandboxFetch({
    credentials: loaded.checkalt,
    path: '/fincapture/deposit/approve',
    body: {
      fiKey: loaded.checkalt.fiKey,
      referenceNumber: Number(operation.provider_reference) || operation.provider_reference,
      action: 1,
    },
    fetchImpl: deps.fetchImpl || fetch,
  });
  await insertAudit(client, {
    applicationUserId: mapping.application_user_id,
    tenantId: operation.tenant_id,
    operationType: 'checkalt_sandbox_approve',
    operationId: operation.id,
    provider: 'checkalt',
    providerReference: operation.provider_reference,
    outcome: approved.ok ? 'uat_approve' : 'uat_approve_failed',
  });
  return {
    ok: approved.ok,
    statusCode: approved.ok ? 200 : approved.statusCode || 502,
    sandboxHttpCalled: true,
    productionExecution: false,
    negotiableCheckSubmitted: false,
    applicationUserId: mapping.application_user_id,
    spoofFieldsIgnored: spoof,
    operation: publicOperation(operation),
    providerStatus: extractCheckAltStatus(approved.data),
  };
}, deps);

const handlePlaidProbe = async (event, deps) => handleAuthenticated(event, async ({ client, mapping, claims, body, spoof }) => {
  const gate = requireSandboxGate({ spoof });
  if (gate.ok !== true) return gate;
  const memberships = await membershipsOf(client, mapping.application_user_id);
  const tenantId = memberships[0]?.tenant_id;
  if (!tenantId) return denied(spoof, { error: 'no_tenant_membership' });
  const loaded = await (deps.loadSandboxCredentials || loadSandboxCredentials)();
  const gateCreds = assertPlaidSandboxCredentials(loaded.plaid);
  if (!gateCreds.ok) {
    await insertAudit(client, {
      applicationUserId: mapping.application_user_id,
      tenantId,
      operationType: 'plaid_probe',
      provider: 'plaid',
      outcome: gateCreds.error,
    });
    return denied(spoof, { ...gateCreds, capability: loaded.snapshot.plaid });
  }
  const created = await plaidSandboxFetch({
    credentials: loaded.plaid,
    path: '/link/token/create',
    body: buildPlaidLinkTokenBody({
      applicationUserId: mapping.application_user_id,
      tenantId,
    }),
    fetchImpl: deps.fetchImpl || fetch,
  });
  await insertAudit(client, {
    applicationUserId: mapping.application_user_id,
    tenantId,
    operationType: 'plaid_probe',
    provider: 'plaid',
    outcome: created.ok ? 'plaid_link_token' : 'plaid_sandbox_http_failed',
  });
  return {
    ok: created.ok,
    statusCode: created.ok ? 200 : created.statusCode || 502,
    provider: 'plaid',
    sandboxHttpCalled: true,
    productionExecution: false,
    moneyMovement: false,
    relevantToMoneyPath: false,
    applicationUserId: mapping.application_user_id,
    cognitoSub: claims.sub,
    spoofFieldsIgnored: spoof,
    linkTokenPresent: Boolean(created.data?.link_token),
    expiration: created.data?.expiration || null,
  };
}, deps);

const handleReconcile = async (event, deps) => handleAuthenticated(event, async ({ client, mapping, claims, body, spoof }) => {
  const gate = requireSandboxGate({ spoof });
  if (gate.ok !== true) return gate;
  const memberships = await membershipsOf(client, mapping.application_user_id);
  const tenantId = memberships[0]?.tenant_id;
  if (!tenantId) return denied(spoof, { error: 'no_tenant_membership' });
  const operations = (await client.query(
    `SELECT * FROM public.aws_provider_sandbox_operations
     WHERE tenant_id = $1::uuid
     ORDER BY created_at DESC
     LIMIT 50`,
    [tenantId],
  )).rows;
  const providerTxns = [];
  for (const operation of operations) {
    const simulated = operation.metadata?.simulated_provider;
    if (simulated?.provider_reference) {
      providerTxns.push({
        operation_id: operation.id,
        provider_reference: simulated.provider_reference,
        status: simulated.status,
        amount_cents: simulated.amount_cents,
      });
    } else if (operation.provider_reference) {
      providerTxns.push({
        operation_id: operation.id,
        provider_reference: operation.provider_reference,
        status: operation.status,
        amount_cents: Number(operation.amount_cents),
      });
    }
  }
  const report = reconcileOperations({ operations, providerTxns, nowMs: Date.now() });
  await insertAudit(client, {
    applicationUserId: mapping.application_user_id,
    tenantId,
    operationType: 'sandbox_reconcile',
    provider: 'sandbox',
    outcome: 'reconcile_report',
    details: { compared: report.compared, findings: report.findings.length, auto_corrected: false },
  });
  return {
    ok: true,
    statusCode: 200,
    sandboxHttpCalled: false,
    productionExecution: false,
    autoCorrected: false,
    applicationUserId: mapping.application_user_id,
    spoofFieldsIgnored: spoof,
    ...report,
  };
}, deps);

const handleCleanup = async (event, deps) => handleAuthenticated(event, async ({ client, mapping, claims, body, spoof }) => {
  const memberships = await membershipsOf(client, mapping.application_user_id);
  const tenantIds = memberships.map((row) => row.tenant_id);
  if (!tenantIds.length) return denied(spoof, { error: 'no_tenant_membership' });
  const marker = String(body?.marker || SANDBOX_MARKER);
  const deleted = (await client.query(
    `DELETE FROM public.aws_provider_sandbox_operations
     WHERE tenant_id = ANY($1::uuid[])
       AND (metadata->>'marker' = $2 OR metadata->>'marker' LIKE $3 OR application_user_id = $4::uuid)
     RETURNING id`,
    [tenantIds, marker, `${marker}%`, mapping.application_user_id],
  )).rows;
  await insertAudit(client, {
    applicationUserId: mapping.application_user_id,
    tenantId: tenantIds[0],
    operationType: 'sandbox_cleanup',
    outcome: 'cleanup_sandbox',
    details: { deleted: deleted.length, marker },
  });
  return {
    ok: true,
    statusCode: 200,
    deleted: deleted.length,
    ids: deleted.map((row) => row.id),
    productionExecution: false,
    applicationUserId: mapping.application_user_id,
    spoofFieldsIgnored: spoof,
  };
}, deps);

const handleSandboxWebhook = async (event, provider, deps = {}) => {
  const rawBody = rawEventBody(event);
  const loaded = await (deps.loadSandboxCredentials || loadSandboxCredentials)();
  const secret = provider === 'moov'
    ? loaded.moov?.webhookSecret
    : provider === 'checkalt'
      ? loaded.checkalt?.webhookSecret
      : loaded.plaid?.webhookSecret;
  if (!secret) {
    return {
      ok: false,
      statusCode: 401,
      error: 'sandbox_webhook_secret_unavailable',
      provider,
      productionExecution: false,
      productionRecordsMutated: false,
      applied: false,
      message: 'Sandbox webhook secret is not configured. Production webhook secrets were not used.',
    };
  }
  const verified = provider === 'moov'
    ? verifyMoovSignature({ event, rawBody, secret, nowMs: deps.nowMs })
    : verifyHmacBodySignature({ event, rawBody, secret, nowMs: deps.nowMs });
  if (!verified.ok) {
    return {
      ok: false,
      statusCode: 401,
      error: verified.reason || 'invalid_signature',
      provider,
      productionExecution: false,
      productionRecordsMutated: false,
      applied: false,
    };
  }
  let payload = {};
  try { payload = rawBody ? JSON.parse(rawBody) : {}; } catch { payload = {}; }
  const externalEventId = verified.eventId || payload.eventID || payload.event_id || payload.id;
  if (!externalEventId) {
    return {
      ok: false,
      statusCode: 400,
      error: 'malformed_webhook',
      provider,
      productionRecordsMutated: false,
    };
  }
  const { Client } = pg;
  const createClient = deps.createClient || ((config) => new Client(config));
  const loadCredentials = deps.loadDatabaseCredentials || loadDatabaseCredentials;
  let client;
  let didCommit = false;
  try {
    const credentials = await loadCredentials();
    client = createClient(buildWriteClientConfig(credentials, { queryTimeoutMillis: 12000 }));
    await client.connect();
    await client.query('BEGIN');
    await client.query('SET TRANSACTION READ WRITE');
    await setSandboxGuc(client);
    const result = await persistSandboxWebhook({ client, provider, payload, externalEventId, verified });
    await client.query('COMMIT');
    didCommit = true;
    return result;
  } catch (error) {
    if (client && !didCommit) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    }
    return {
      ok: false,
      statusCode: 500,
      error: 'webhook_persist_failed',
      provider,
      productionRecordsMutated: false,
      message: String(error?.message || error).slice(0, 200),
    };
  } finally {
    if (client) {
      try { await client.end(); } catch { /* ignore */ }
    }
  }
};

const persistSandboxWebhook = async ({ client, provider, payload, externalEventId, verified }) => {
  const providerAccountId = payload.accountID || payload.data?.accountID || payload.ssoUserId || payload.item_id || null;
  let mapped = null;
  if (providerAccountId) {
    mapped = (await client.query(
      `SELECT tenant_id FROM public.aws_provider_sandbox_objects
       WHERE provider = $1 AND sandbox_provider_id = $2
       LIMIT 1`,
      [provider, String(providerAccountId)],
    )).rows[0] || null;
  }
  const existing = (await client.query(
    `SELECT * FROM public.aws_provider_sandbox_webhooks
     WHERE provider = $1 AND external_event_id = $2`,
    [provider, String(externalEventId || '')],
  )).rows[0];
  if (existing) {
    return {
      ok: true,
      statusCode: 200,
      duplicate: true,
      applied: false,
      productionRecordsMutated: false,
      mapped_tenant_id: existing.mapped_tenant_id,
      tenantFromPayloadIgnored: true,
      signature_ok: true,
    };
  }
  await client.query(
    `INSERT INTO public.aws_provider_sandbox_webhooks
      (provider, external_event_id, mapped_tenant_id, signature_ok, duplicate, applied, mutates_production, payload)
     VALUES ($1, $2, $3::uuid, true, false, false, false, $4::jsonb)`,
    [
      provider,
      String(externalEventId || verified.eventId),
      mapped?.tenant_id || null,
      JSON.stringify(sanitizeWebhookPayload({
        ...payload,
        tenant_id: '[ignored-untrusted]',
        user_id: '[ignored-untrusted]',
      })),
    ],
  );
  return {
    ok: true,
    statusCode: 200,
    duplicate: false,
    applied: false,
    dry_run: true,
    stagingRecordsOnly: true,
    productionRecordsMutated: false,
    mapped_tenant_id: mapped?.tenant_id || null,
    tenantFromPayloadIgnored: true,
    signature_ok: true,
    algorithm: verified.algorithm || null,
  };
};

export const sandboxRoute = (path, method) => {
  if (method === 'GET' && path === '/sandbox/status') return { kind: 'status' };
  if (method === 'POST' && path === '/sandbox/isolation') return { kind: 'isolation' };
  if (method === 'POST' && path === '/sandbox/moov/probe') return { kind: 'moov-probe' };
  if (method === 'POST' && path === '/sandbox/moov/transfer') return { kind: 'moov-transfer' };
  if (method === 'POST' && path === '/sandbox/moov/retrieve') return { kind: 'moov-retrieve' };
  if (method === 'POST' && path === '/sandbox/checkalt/probe') return { kind: 'checkalt-probe' };
  if (method === 'POST' && path === '/sandbox/checkalt/account') return { kind: 'checkalt-account' };
  if (method === 'POST' && path === '/sandbox/checkalt/register') return { kind: 'checkalt-register' };
  if (method === 'POST' && path === '/sandbox/checkalt/deposit') return { kind: 'checkalt-deposit' };
  if (method === 'POST' && path === '/sandbox/checkalt/status') return { kind: 'checkalt-status' };
  if (method === 'POST' && path === '/sandbox/checkalt/approve') return { kind: 'checkalt-approve' };
  if (method === 'POST' && path === '/sandbox/plaid/probe') return { kind: 'plaid-probe' };
  if (method === 'POST' && path === '/sandbox/reconcile') return { kind: 'reconcile' };
  if (method === 'POST' && path === '/sandbox/cleanup') return { kind: 'cleanup' };
  if (method === 'POST' && path === '/sandbox/webhooks/moov') return { kind: 'webhook', provider: 'moov' };
  if (method === 'POST' && path === '/sandbox/webhooks/checkalt') return { kind: 'webhook', provider: 'checkalt' };
  if (method === 'POST' && path === '/sandbox/webhooks/plaid') return { kind: 'webhook', provider: 'plaid' };
  return null;
};

export const handleSandboxRequest = async (event, path, method, deps = {}) => {
  const route = sandboxRoute(path, method);
  if (!route) return null;
  if (route.kind === 'status') return handleSandboxStatus(deps);
  if (route.kind === 'isolation') return handleIsolation(event, deps);
  if (route.kind === 'moov-probe') return handleMoovProbe(event, deps);
  if (route.kind === 'moov-transfer') return handleMoovTransfer(event, deps);
  if (route.kind === 'moov-retrieve') return handleMoovRetrieve(event, deps);
  if (route.kind === 'checkalt-probe') return handleCheckAltProbe(event, deps);
  if (route.kind === 'checkalt-account') return handleCheckAltAccount(event, deps);
  if (route.kind === 'checkalt-register') return handleCheckAltRegister(event, deps);
  if (route.kind === 'checkalt-deposit') return handleCheckAltDeposit(event, deps);
  if (route.kind === 'checkalt-status') return handleCheckAltStatus(event, deps);
  if (route.kind === 'checkalt-approve') return handleCheckAltApprove(event, deps);
  if (route.kind === 'plaid-probe') return handlePlaidProbe(event, deps);
  if (route.kind === 'reconcile') return handleReconcile(event, deps);
  if (route.kind === 'cleanup') return handleCleanup(event, deps);
  if (route.kind === 'webhook') {
    const raw = handleSandboxWebhook(event, route.provider, deps);
    return raw;
  }
  return null;
};

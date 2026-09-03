import pg from 'pg';
import { withIdentityWrite } from './data.mjs';
import { loadDatabaseCredentials } from './secrets.mjs';
import { buildWriteClientConfig } from './db-health.mjs';
import { TENANT_MEMBERSHIP_SQL } from './identity.mjs';
import { denyProviderExecution, flagSnapshot, providerExecutionEnabled } from './provider-flags.mjs';
import { financialFlagSnapshot, financialPermissionsActivated } from './financial-flags.mjs';
import { providerSandboxExecutionEnabled, sandboxFlagSnapshot } from './sandbox-flags.mjs';
import { loadSandboxCredentials, publicSandboxCapability } from './sandbox-credentials.mjs';
import { rejectUntrustedAmountFields } from './providers/amounts.mjs';
import {
  SANDBOX_MIN_CENTS,
  MOOV_SANDBOX_AMOUNT_API,
  buildMoovSandboxTransferBody,
  moovSandboxFetch,
  moovSandboxScopes,
  moovSandboxToken,
  normalizeMoovSandboxTransfer,
  redactProviderId,
} from './providers/moov-sandbox.mjs';
import {
  assertCheckAltSandboxCredentials,
  buildCheckAltSandboxDeposit,
  checkAltSandboxAuthenticate,
  checkAltSandboxFetch,
} from './providers/checkalt-sandbox.mjs';
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
    `SELECT id, tenant_id, provider, object_type, sandbox_provider_id, environment
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
      checkalt: { scale: 'integer_cents', example: { dollars: 0.01, userAmount: 1 } },
      sandboxMinCents: SANDBOX_MIN_CENTS,
    },
    isolation: {
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
    },
    cutover: {
      authorized: false,
      executed: false,
    },
  };
};

const handleAuthenticated = (event, fn, deps) => withIdentityWrite(event, async (ctx) => {
  await setSandboxGuc(ctx.client);
  return fn(ctx);
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
  const accountId = loaded.moov.platformAccountId;
  const reads = {
    authentication: { ok: true, tokenPresent: auth.accessTokenPresent },
    account: null,
    wallets: null,
    paymentMethods: null,
    capabilities: null,
  };
  if (accountId) {
    const account = await moovSandboxFetch({
      credentials: loaded.moov,
      path: `/accounts/${accountId}`,
      scopes: moovSandboxScopes.accountRead(accountId),
      fetchImpl,
      token: auth.token,
    });
    reads.account = { ok: account.ok, redactedId: redactProviderId(accountId), httpStatus: account.statusCode || account.httpStatus || null };
    const wallets = await moovSandboxFetch({
      credentials: loaded.moov,
      path: `/accounts/${accountId}/wallets`,
      scopes: moovSandboxScopes.accountRead(accountId),
      fetchImpl,
      token: auth.token,
    });
    reads.wallets = {
      ok: wallets.ok,
      count: Array.isArray(wallets.data) ? wallets.data.length : null,
    };
    const methods = await moovSandboxFetch({
      credentials: loaded.moov,
      path: `/accounts/${accountId}/payment-methods`,
      scopes: moovSandboxScopes.paymentMethodsRead(accountId),
      fetchImpl,
      token: auth.token,
    });
    reads.paymentMethods = {
      ok: methods.ok,
      count: Array.isArray(methods.data) ? methods.data.length : null,
    };
    const caps = await moovSandboxFetch({
      credentials: loaded.moov,
      path: `/accounts/${accountId}/capabilities`,
      scopes: moovSandboxScopes.capabilitiesRead(accountId),
      fetchImpl,
      token: auth.token,
    });
    reads.capabilities = {
      ok: caps.ok,
      count: Array.isArray(caps.data) ? caps.data.length : null,
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
          metadata: { source: 'sandbox_probe' },
        });
      }
    }
    await insertSandboxObject(client, {
      tenantId,
      provider: 'moov',
      objectType: 'account',
      sandboxProviderId: accountId,
      metadata: { source: 'sandbox_platform_account' },
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
  if (existing) {
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
      operation: publicOperation(existing),
      message: 'Same ChecksOps operation replayed. No second provider call.',
    };
  }
  if (!loaded.moov) {
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
    return denied(spoof, {
      statusCode: 409,
      error: 'sandbox_credentials_unavailable',
      provider: 'moov',
      operation: publicOperation(inserted),
      capability: loaded.snapshot.moov,
    });
  }
  const source = await lookupSandboxObject(client, { tenantId, provider: 'moov', objectType: 'source_payment_method' })
    || await lookupSandboxObject(client, { tenantId, provider: 'moov', objectType: 'payment_method' });
  const destination = await lookupSandboxObject(client, { tenantId, provider: 'moov', objectType: 'destination_payment_method' })
    || await lookupSandboxObject(client, { tenantId, provider: 'moov', objectType: 'wallet' });
  if (!source?.sandbox_provider_id || !destination?.sandbox_provider_id) {
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
    return denied(spoof, {
      statusCode: 409,
      error: 'sandbox_account_unmapped',
      provider: 'moov',
      operation: publicOperation(inserted),
      message: 'No sandbox payment methods are mapped for this tenant. Production Moov account IDs were not used.',
    });
  }
  const facilitator = loaded.moov.platformAccountId;
  const transferBody = buildMoovSandboxTransferBody({
    sourcePaymentMethodId: source.sandbox_provider_id,
    destinationPaymentMethodId: destination.sandbox_provider_id,
    amountCents: SANDBOX_MIN_CENTS,
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
    const inserted = (await client.query(
      `INSERT INTO public.aws_provider_sandbox_operations
        (tenant_id, application_user_id, operation_type, provider, amount_cents, currency,
         idempotency_key, status, sandbox_http_called, production_execution, failure_class, metadata)
       VALUES ($1::uuid, $2::uuid, 'moov_sandbox_transfer', 'moov', $3, 'USD', $4, 'failed', true, false, $5, $6::jsonb)
       RETURNING *`,
      [
        tenantId,
        mapping.application_user_id,
        SANDBOX_MIN_CENTS,
        key,
        `provider_${created.httpStatus || 500}`,
        JSON.stringify({ marker: body?.marker || SANDBOX_MARKER, httpStatus: created.httpStatus || null }),
      ],
    )).rows[0];
    await insertAudit(client, {
      applicationUserId: mapping.application_user_id,
      tenantId,
      operationType: 'moov_sandbox_transfer',
      operationId: inserted.id,
      provider: 'moov',
      outcome: 'provider_failure',
      idempotencyKey: key,
      details: { httpStatus: created.httpStatus || null },
    });
    return denied(spoof, {
      ...created,
      sandboxHttpCalled: true,
      operation: publicOperation(inserted),
    });
  }
  const normalized = normalizeMoovSandboxTransfer(created.data || {});
  const inserted = (await client.query(
    `INSERT INTO public.aws_provider_sandbox_operations
      (tenant_id, application_user_id, operation_type, provider, amount_cents, currency,
       idempotency_key, status, provider_reference, sandbox_http_called, production_execution, metadata)
     VALUES ($1::uuid, $2::uuid, 'moov_sandbox_transfer', 'moov', $3, 'USD', $4, 'provider_pending', $5, true, false, $6::jsonb)
     RETURNING *`,
    [
      tenantId,
      mapping.application_user_id,
      SANDBOX_MIN_CENTS,
      key,
      normalized.provider_transfer_id,
      JSON.stringify({
        marker: body?.marker || SANDBOX_MARKER,
        moov_idempotency_uuid: created.idempotencyKey,
        simulated_provider: {
          provider_reference: normalized.provider_transfer_id,
          status: normalized.status || 'pending',
          amount_cents: SANDBOX_MIN_CENTS,
        },
      }),
    ],
  )).rows[0];
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
    outcome: 'sandbox_transfer_created',
    idempotencyKey: key,
  });
  return {
    ok: true,
    statusCode: 200,
    duplicate: false,
    sandboxHttpCalled: true,
    productionExecution: false,
    productionRecordsMutated: false,
    applicationUserId: mapping.application_user_id,
    cognitoSub: claims.sub,
    spoofFieldsIgnored: spoof,
    amount: transferBody.amount,
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
  const facilitator = loaded.moov.platformAccountId;
  const fetched = await moovSandboxFetch({
    credentials: loaded.moov,
    path: `/accounts/${facilitator}/transfers/${operation.provider_reference}`,
    scopes: moovSandboxScopes.transfersRead(facilitator),
    fetchImpl: deps.fetchImpl || fetch,
  });
  return {
    ok: fetched.ok,
    statusCode: fetched.ok ? 200 : fetched.statusCode || 502,
    sandboxHttpCalled: true,
    productionExecution: false,
    applicationUserId: mapping.application_user_id,
    spoofFieldsIgnored: spoof,
    operation: publicOperation(operation),
    provider: fetched.ok ? normalizeMoovSandboxTransfer(fetched.data || {}) : null,
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
  const key = stableIdempotencyKey({
    tenantId,
    operationType: 'checkalt_sandbox_deposit',
    resourceId: body?.resource_id || tenantId,
    amountCents: SANDBOX_MIN_CENTS,
  });
  const existing = await lookupSandboxOperation(client, { idempotencyKey: key, tenantId });
  if (existing) {
    return {
      ok: true,
      statusCode: 200,
      duplicate: true,
      replayed: true,
      sandboxHttpCalled: false,
      productionExecution: false,
      negotiableCheckSubmitted: false,
      operation: publicOperation(existing),
      spoofFieldsIgnored: spoof,
    };
  }
  const loaded = await (deps.loadSandboxCredentials || loadSandboxCredentials)();
  const deposit = buildCheckAltSandboxDeposit({ amountCents: SANDBOX_MIN_CENTS, reference: key });
  if (!loaded.checkalt) {
    const inserted = (await client.query(
      `INSERT INTO public.aws_provider_sandbox_operations
        (tenant_id, application_user_id, operation_type, provider, amount_cents, currency,
         idempotency_key, status, sandbox_http_called, production_execution, failure_class, metadata)
       VALUES ($1::uuid, $2::uuid, 'checkalt_sandbox_deposit', 'checkalt', $3, 'USD', $4, 'failed', false, false, 'sandbox_credentials_unavailable', $5::jsonb)
       RETURNING *`,
      [tenantId, mapping.application_user_id, SANDBOX_MIN_CENTS, key, JSON.stringify({ marker: body?.marker || SANDBOX_MARKER })],
    )).rows[0];
    return denied(spoof, {
      statusCode: 409,
      error: 'sandbox_credentials_unavailable',
      provider: 'checkalt',
      capability: loaded.snapshot.checkalt,
      operation: publicOperation(inserted),
      amount: deposit,
      negotiableCheckSubmitted: false,
    });
  }
  const submitted = await checkAltSandboxFetch({
    credentials: loaded.checkalt,
    path: '/fincapture/deposit/process',
    body: {
      userAmount: deposit.userAmount,
      referenceNumber: key,
      testDeposit: true,
      includeImages: false,
    },
    fetchImpl: deps.fetchImpl || fetch,
  });
  const inserted = (await client.query(
    `INSERT INTO public.aws_provider_sandbox_operations
      (tenant_id, application_user_id, operation_type, provider, amount_cents, currency,
       idempotency_key, status, provider_reference, sandbox_http_called, production_execution, failure_class, metadata)
     VALUES ($1::uuid, $2::uuid, 'checkalt_sandbox_deposit', 'checkalt', $3, 'USD', $4, $5, $6, true, false, $7, $8::jsonb)
     RETURNING *`,
    [
      tenantId,
      mapping.application_user_id,
      SANDBOX_MIN_CENTS,
      key,
      submitted.ok ? 'provider_pending' : 'failed',
      submitted.data?.referenceNumber || submitted.data?.checkalt_reference || null,
      submitted.ok ? null : `provider_${submitted.httpStatus || 500}`,
      JSON.stringify({ marker: body?.marker || SANDBOX_MARKER, userAmount: deposit.userAmount }),
    ],
  )).rows[0];
  return {
    ok: submitted.ok,
    statusCode: submitted.ok ? 200 : submitted.statusCode || 502,
    sandboxHttpCalled: true,
    productionExecution: false,
    negotiableCheckSubmitted: false,
    applicationUserId: mapping.application_user_id,
    spoofFieldsIgnored: spoof,
    amount: deposit,
    operation: publicOperation(inserted),
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
  if (method === 'POST' && path === '/sandbox/moov/probe') return { kind: 'moov-probe' };
  if (method === 'POST' && path === '/sandbox/moov/transfer') return { kind: 'moov-transfer' };
  if (method === 'POST' && path === '/sandbox/moov/retrieve') return { kind: 'moov-retrieve' };
  if (method === 'POST' && path === '/sandbox/checkalt/probe') return { kind: 'checkalt-probe' };
  if (method === 'POST' && path === '/sandbox/checkalt/deposit') return { kind: 'checkalt-deposit' };
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
  if (route.kind === 'moov-probe') return handleMoovProbe(event, deps);
  if (route.kind === 'moov-transfer') return handleMoovTransfer(event, deps);
  if (route.kind === 'moov-retrieve') return handleMoovRetrieve(event, deps);
  if (route.kind === 'checkalt-probe') return handleCheckAltProbe(event, deps);
  if (route.kind === 'checkalt-deposit') return handleCheckAltDeposit(event, deps);
  if (route.kind === 'plaid-probe') return handlePlaidProbe(event, deps);
  if (route.kind === 'reconcile') return handleReconcile(event, deps);
  if (route.kind === 'cleanup') return handleCleanup(event, deps);
  if (route.kind === 'webhook') {
    const raw = handleSandboxWebhook(event, route.provider, deps);
    return raw;
  }
  return null;
};

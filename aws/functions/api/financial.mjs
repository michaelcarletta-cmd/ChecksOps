import { ignoredSpoof, parseBody, withIdentity, withIdentityWrite } from './data.mjs';
import { TENANT_MEMBERSHIP_SQL, USER_ROLES_SQL } from './identity.mjs';
import { denyProviderExecution, flagSnapshot, providerExecutionEnabled } from './provider-flags.mjs';
import { financialFlagSnapshot, financialPermissionsActivated, financialSandboxSimulationEnabled } from './financial-flags.mjs';
import {
  denyFinancialPermission,
  evaluateFinancialAuthorization,
  FINANCIAL_OPERATIONS,
  financialPermissionSnapshot,
} from './financial-authz.mjs';
import {
  dollarsToIntegerCents,
  formatCheckAltUserAmount,
  formatMoovTransferAmount,
  MOOV_AMOUNT_API,
  rejectUntrustedAmountFields,
  validateProviderCents,
} from './providers/amounts.mjs';
import { evaluateTransition, FINANCIAL_STATES, mapProviderStatus, WEBHOOK_EVENT_ACTIONS } from './financial-state.mjs';
import { replaySafeResponse, stableIdempotencyKey } from './financial-idempotency.mjs';
import { isUuid, verifyOwnershipChain } from './financial-ownership.mjs';
import { auditRow } from './financial-audit.mjs';
import { reconcileOperations } from './financial-reconciliation.mjs';

export const CERTIFICATION_FIXTURE_CENTS = 12345;
export const CERTIFICATION_MARKER = 'AWS T6 FINANCIAL';

const PROVIDER_FOR_OPERATION = {
  checkalt_deposit: 'checkalt',
  checkalt_approve: 'checkalt',
  wallet_fund: 'moov',
  disbursement: 'moov',
  ach: 'moov',
  rtp: 'moov',
  wire: 'moov',
  pay_homeowner: 'moov',
  pay_contractor: 'moov',
  pay_vendor: 'moov',
  retry_failed: null,
  cancel: 'moov',
};

const FAILURE_CLASSES = new Set([
  'provider_400',
  'provider_401',
  'provider_409',
  'provider_429',
  'provider_500',
  'provider_timeout',
  'lambda_timeout',
  'db_before_provider',
  'db_after_provider',
  'webhook_delay',
  'duplicate_webhook',
  'return',
  'reversal',
]);

const denied = (spoof, extra) => ({
  ok: false,
  statusCode: extra.statusCode || 403,
  spoofFieldsIgnored: spoof,
  liveProviderCalled: false,
  productionExecution: false,
  ...extra,
});

const publicOperation = (row) => {
  if (!row) return null;
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    operation_type: row.operation_type,
    provider: row.provider,
    resource_type: row.resource_type,
    resource_id: row.resource_id,
    amount_cents: Number(row.amount_cents),
    currency: row.currency,
    amount_source: row.amount_source,
    idempotency_key: row.idempotency_key,
    status: row.status,
    previous_status: row.previous_status,
    provider_reference: row.provider_reference,
    simulated: row.simulated,
    live_provider_called: row.live_provider_called,
    failure_class: row.failure_class,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
};

const membershipsOf = async (client, userId) => {
  const rows = (await client.query(TENANT_MEMBERSHIP_SQL, [userId])).rows;
  return rows.map((row) => ({
    tenant_id: row.tenant_id,
    role: row.role,
    tenant_name: row.tenant_name,
    tenant_slug: row.tenant_slug,
  }));
};

const rolesOf = async (client, userId, tenantId) => {
  const platform = (await client.query(USER_ROLES_SQL, [userId])).rows.map((row) => String(row.role || '').toLowerCase());
  const tenant = tenantId
    ? (await client.query(
      'SELECT role FROM public.tenant_users WHERE user_id = $1::uuid AND tenant_id = $2::uuid',
      [userId, tenantId],
    )).rows.map((row) => String(row.role || '').toLowerCase())
    : [];
  return [...new Set([...platform, ...tenant])];
};

const setCertificationGuc = async (client) => {
  await client.query("SELECT set_config('request.financial_certification', '1', true)");
};

const insertAudit = async (client, fields) => {
  const row = auditRow(fields);
  await client.query(
    `INSERT INTO public.aws_financial_audit
      (application_user_id, tenant_id, operation_type, operation_id, amount_cents,
       provider, provider_reference, outcome, idempotency_key, details)
     VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5, $6, $7, $8, $9, $10::jsonb)`,
    [
      row.application_user_id,
      row.tenant_id,
      row.operation_type,
      row.operation_id,
      row.amount_cents,
      row.provider,
      row.provider_reference,
      row.outcome,
      row.idempotency_key,
      JSON.stringify(row.details || {}),
    ],
  );
};

const lookupCheck = async (client, checkId) => {
  if (!isUuid(checkId)) return { error: 'invalid_uuid', field: 'check_id' };
  const rows = (await client.query(
    `SELECT id, tenant_id, uploaded_by, status, check_stage, claim_id, deposited_at,
            amount, carrier_name, review_notes
     FROM public.check_intake_items
     WHERE id = $1::uuid`,
    [checkId],
  )).rows;
  if (!rows.length) return { error: 'rls_denied', message: 'check not found or not writable' };
  return { check: rows[0] };
};

const optionalLookup = async (client, sql, params) => {
  await client.query('SAVEPOINT financial_lookup');
  try {
    const rows = (await client.query(sql, params)).rows;
    await client.query('RELEASE SAVEPOINT financial_lookup');
    return rows[0] || null;
  } catch {
    try { await client.query('ROLLBACK TO SAVEPOINT financial_lookup'); } catch { /* ignore */ }
    return null;
  }
};

const lookupProviderAccount = async (client, tenantId, provider) => {
  if (provider === 'checkalt') {
    return optionalLookup(
      client,
      `SELECT id, tenant_id, 'checkalt' AS provider, sso_user_id AS provider_account_id, enabled
       FROM public.checkalt_tenant_accounts
       WHERE tenant_id = $1::uuid
       ORDER BY updated_at DESC NULLS LAST
       LIMIT 1`,
      [tenantId],
    );
  }
  return optionalLookup(
    client,
    `SELECT id, tenant_id, provider, provider_account_id, environment, disabled
     FROM public.payment_provider_accounts
     WHERE tenant_id = $1::uuid AND provider = $2
     ORDER BY updated_at DESC NULLS LAST
     LIMIT 1`,
    [tenantId, provider],
  );
};

const lookupWallet = async (client, tenantId) => optionalLookup(
  client,
  `SELECT id, tenant_id, provider, provider_wallet_id, provider_account_id, status
   FROM public.payment_wallets
   WHERE tenant_id = $1::uuid
   ORDER BY updated_at DESC NULLS LAST
   LIMIT 1`,
  [tenantId],
);

const lookupOperation = async (client, { operationId, idempotencyKey, tenantId }) => {
  if (operationId && isUuid(operationId)) {
    const rows = (await client.query(
      'SELECT * FROM public.aws_financial_operations WHERE id = $1::uuid',
      [operationId],
    )).rows;
    return rows[0] || null;
  }
  if (idempotencyKey && tenantId) {
    const rows = (await client.query(
      'SELECT * FROM public.aws_financial_operations WHERE tenant_id = $1::uuid AND idempotency_key = $2',
      [tenantId, idempotencyKey],
    )).rows;
    return rows[0] || null;
  }
  return null;
};

const resolveServerAmount = ({ check, simulationEnabled }) => {
  if (check?.amount !== undefined && check?.amount !== null && check?.amount !== '') {
    const parsed = dollarsToIntegerCents(check.amount);
    if (parsed.error) return parsed;
    const validated = validateProviderCents(parsed.cents);
    if (validated.error) return validated;
    return {
      cents: validated.cents,
      source: 'check_intake_items.amount',
      checkalt: formatCheckAltUserAmount(check.amount),
      moov: formatMoovTransferAmount(validated.cents),
    };
  }
  if (simulationEnabled) {
    const validated = validateProviderCents(CERTIFICATION_FIXTURE_CENTS);
    return {
      cents: validated.cents,
      source: 'sandbox_certification_fixture',
      checkalt: { userAmount: validated.cents, scale: 'integer_cents', sourceDollars: 123.45 },
      moov: formatMoovTransferAmount(validated.cents),
    };
  }
  return { error: 'missing_amount', message: 'check has no server-side amount' };
};

const requireSimulation = ({ mapping, claims, spoof, gate }) => {
  if (providerExecutionEnabled()) {
    return denied(spoof, {
      statusCode: 403,
      error: 'production_execution_blocked',
      message: 'AWS_PROVIDER_EXECUTION_ENABLED must remain false. This phase does not move money.',
    });
  }
  if (financialPermissionsActivated()) {
    return denied(spoof, {
      statusCode: 403,
      error: 'financial_permissions_must_stay_deactivated',
      message: 'AWS_FINANCIAL_PERMISSIONS_ACTIVATED must remain false during pre-activation.',
    });
  }
  if (!financialSandboxSimulationEnabled()) {
    return denied(spoof, {
      statusCode: 403,
      error: 'sandbox_simulation_disabled',
      message: 'AWS_FINANCIAL_SANDBOX_SIMULATION_ENABLED is false.',
    });
  }
  if (!gate.canSimulate) {
    return denyFinancialPermission(gate.operation, {
      spoofFieldsIgnored: spoof,
      liveProviderCalled: false,
      gate,
    });
  }
  return {
    ok: true,
    applicationUserId: mapping.application_user_id,
    cognitoSub: claims.sub,
    gate,
  };
};

export const handleFinancialStatus = async () => ({
  ok: true,
  statusCode: 200,
  service: 'checksops-api',
  environment: process.env.CHECKSOPS_ENV || 'unknown',
  productionSupabaseChanged: false,
  productionWebhooksRedirected: false,
  productionDnsChanged: false,
  liveProviderTransactions: false,
  productionExecution: false,
  flags: {
    ...flagSnapshot(),
    ...financialFlagSnapshot(),
  },
  permissions: financialPermissionSnapshot(),
  amountUnits: {
    checkalt: { scale: 'integer_cents', example: { dollars: 123.45, userAmount: 12345 } },
    moov: MOOV_AMOUNT_API,
  },
  operations: Object.keys(FINANCIAL_OPERATIONS),
  certificationFixtureCents: CERTIFICATION_FIXTURE_CENTS,
});

const handlePrepare = async (event, deps) => withIdentityWrite(event, async ({ client, mapping, claims, body, spoof }) => {
  await setCertificationGuc(client);
  const untrustedAmount = rejectUntrustedAmountFields(body);
  if (untrustedAmount) {
    await insertAudit(client, {
      applicationUserId: mapping.application_user_id,
      operationType: body?.operation_type,
      outcome: 'rejected_untrusted_amount',
      details: { fields: untrustedAmount.fields },
    });
    return denied(spoof, untrustedAmount);
  }
  const operationType = String(body?.operation_type || '');
  if (!FINANCIAL_OPERATIONS[operationType]) {
    return denied(spoof, { statusCode: 400, error: 'unknown_operation', operation: operationType || null });
  }
  if (body?.live === true || body?.execute === true) {
    return denied(spoof, denyProviderExecution(PROVIDER_FOR_OPERATION[operationType], operationType, {
      error: 'production_execution_blocked',
    }));
  }
  const checkId = body?.check_id || body?.checkId;
  const found = await lookupCheck(client, checkId);
  if (found.error) {
    return denied(spoof, { statusCode: found.error === 'invalid_uuid' ? 400 : 403, ...found });
  }
  const memberships = await membershipsOf(client, mapping.application_user_id);
  const roles = await rolesOf(client, mapping.application_user_id, found.check.tenant_id);
  const gate = evaluateFinancialAuthorization({
    operation: operationType,
    identityOk: true,
    membershipOk: memberships.some((row) => row.tenant_id === found.check.tenant_id),
    roles,
    simulationEnabled: financialSandboxSimulationEnabled(),
    permissionsActivated: financialPermissionsActivated(),
  });
  const sim = requireSimulation({ mapping, claims, spoof, gate });
  if (sim.ok !== true) {
    await insertAudit(client, {
      applicationUserId: mapping.application_user_id,
      tenantId: found.check.tenant_id,
      operationType,
      outcome: 'unauthorized',
      details: { error: sim.error },
    });
    return sim;
  }
  const provider = PROVIDER_FOR_OPERATION[operationType];
  const providerAccount = provider ? await lookupProviderAccount(client, found.check.tenant_id, provider) : null;
  const wallet = provider === 'moov' ? await lookupWallet(client, found.check.tenant_id) : null;
  const ownership = verifyOwnershipChain({
    applicationUserId: mapping.application_user_id,
    memberships,
    check: found.check,
    providerAccount,
    wallet,
    claimed: body,
  });
  if (!ownership.ok) {
    await insertAudit(client, {
      applicationUserId: mapping.application_user_id,
      tenantId: found.check.tenant_id,
      operationType,
      outcome: 'ownership_denied',
      details: { error: ownership.error },
    });
    return denied(spoof, { statusCode: ownership.statusCode || 403, ...ownership });
  }
  const amount = resolveServerAmount({
    check: found.check,
    simulationEnabled: financialSandboxSimulationEnabled(),
  });
  if (amount.error) {
    return denied(spoof, { statusCode: 400, ...amount });
  }
  const key = stableIdempotencyKey({
    tenantId: found.check.tenant_id,
    operationType,
    resourceId: found.check.id,
    amountCents: amount.cents,
  });
  const existing = await lookupOperation(client, { idempotencyKey: key, tenantId: found.check.tenant_id });
  if (existing) {
    await insertAudit(client, {
      applicationUserId: mapping.application_user_id,
      tenantId: found.check.tenant_id,
      operationType,
      operationId: existing.id,
      amountCents: existing.amount_cents,
      provider,
      outcome: 'idempotent_replay',
      idempotencyKey: key,
    });
    return {
      ok: true,
      statusCode: 200,
      duplicate: true,
      replayed: true,
      liveProviderCalled: false,
      productionExecution: false,
      applicationUserId: mapping.application_user_id,
      authUid: mapping.application_user_id,
      cognitoSub: claims.sub,
      spoofFieldsIgnored: { ...spoof, ownership: ownership.ignored },
      gate,
      amount,
      operation: publicOperation(existing),
    };
  }
  const ready = found.check.status === 'approved_for_deposit' || found.check.check_stage === 'ready_for_deposit';
  const inserted = (await client.query(
    `INSERT INTO public.aws_financial_operations
      (tenant_id, application_user_id, operation_type, provider, resource_type, resource_id,
       amount_cents, currency, amount_source, idempotency_key, status, simulated,
       live_provider_called, metadata)
     VALUES ($1::uuid, $2::uuid, $3, $4, 'check', $5::uuid, $6, 'USD', $7, $8, $9, true, false, $10::jsonb)
     RETURNING *`,
    [
      found.check.tenant_id,
      mapping.application_user_id,
      operationType,
      provider,
      found.check.id,
      amount.cents,
      amount.source,
      key,
      FINANCIAL_STATES.ready_for_provider,
      JSON.stringify({
        marker: body?.marker || CERTIFICATION_MARKER,
        check_status: found.check.status,
        check_stage: found.check.check_stage,
        ready_for_provider: ready,
        provider_account_id: providerAccount?.provider_account_id || null,
        wallet_id: wallet?.id || null,
      }),
    ],
  )).rows[0];
  await insertAudit(client, {
    applicationUserId: mapping.application_user_id,
    tenantId: found.check.tenant_id,
    operationType,
    operationId: inserted.id,
    amountCents: amount.cents,
    provider,
    outcome: 'prepared',
    idempotencyKey: key,
    details: { amount_source: amount.source, ready_for_provider: ready },
  });
  return {
    ok: true,
    statusCode: 200,
    duplicate: false,
    liveProviderCalled: false,
    productionExecution: false,
    applicationUserId: mapping.application_user_id,
    authUid: mapping.application_user_id,
    cognitoSub: claims.sub,
    spoofFieldsIgnored: { ...spoof, ownership: ownership.ignored },
    gate,
    amount,
    readyForProvider: ready,
    operation: publicOperation(inserted),
  };
}, deps);

const applyStatus = async (client, operation, action, extra = {}) => {
  const transition = evaluateTransition(operation.status, action);
  if (!transition.ok) return transition;
  const updated = (await client.query(
    `UPDATE public.aws_financial_operations
     SET previous_status = status,
         status = $2,
         provider_reference = COALESCE($3, provider_reference),
         failure_class = COALESCE($4, failure_class),
         metadata = COALESCE(metadata, '{}'::jsonb) || $5::jsonb,
         updated_at = now()
     WHERE id = $1::uuid
     RETURNING *`,
    [
      operation.id,
      transition.to,
      extra.provider_reference || null,
      extra.failure_class || null,
      JSON.stringify(extra.metadata || {}),
    ],
  )).rows[0];
  return { ok: true, transition, operation: updated };
};

const handleSimulateSubmit = async (event, deps) => withIdentityWrite(event, async ({ client, mapping, claims, body, spoof }) => {
  await setCertificationGuc(client);
  const untrustedAmount = rejectUntrustedAmountFields(body);
  if (untrustedAmount) return denied(spoof, untrustedAmount);
  if (body?.live === true || body?.execute === true) {
    return denied(spoof, { error: 'production_execution_blocked', message: 'Live provider submit is blocked.' });
  }
  const memberships = await membershipsOf(client, mapping.application_user_id);
  const operation = await lookupOperation(client, {
    operationId: body?.operation_id,
    idempotencyKey: body?.idempotency_key,
    tenantId: memberships[0]?.tenant_id,
  });
  if (!operation) return denied(spoof, { statusCode: 404, error: 'operation_not_found' });
  if (!memberships.some((row) => row.tenant_id === operation.tenant_id)) {
    return denied(spoof, { error: 'cross_tenant_denied' });
  }
  const roles = await rolesOf(client, mapping.application_user_id, operation.tenant_id);
  const gate = evaluateFinancialAuthorization({
    operation: operation.operation_type,
    identityOk: true,
    membershipOk: true,
    roles,
    simulationEnabled: financialSandboxSimulationEnabled(),
    permissionsActivated: financialPermissionsActivated(),
  });
  const sim = requireSimulation({ mapping, claims, spoof, gate });
  if (sim.ok !== true) return sim;
  if (['submitting', 'provider_pending', 'provider_confirmed', 'settled'].includes(operation.status)) {
    await insertAudit(client, {
      applicationUserId: mapping.application_user_id,
      tenantId: operation.tenant_id,
      operationType: operation.operation_type,
      operationId: operation.id,
      amountCents: operation.amount_cents,
      provider: operation.provider,
      providerReference: operation.provider_reference,
      outcome: 'idempotent_replay',
      idempotencyKey: operation.idempotency_key,
    });
    return replaySafeResponse(publicOperation(operation), {
      applicationUserId: mapping.application_user_id,
      authUid: mapping.application_user_id,
      cognitoSub: claims.sub,
      spoofFieldsIgnored: spoof,
      productionExecution: false,
      gate,
    });
  }
  const failureClass = body?.failure_class || null;
  if (failureClass && !FAILURE_CLASSES.has(failureClass)) {
    return denied(spoof, { statusCode: 400, error: 'unknown_failure_class' });
  }
  if (failureClass === 'db_before_provider') {
    await insertAudit(client, {
      applicationUserId: mapping.application_user_id,
      tenantId: operation.tenant_id,
      operationType: operation.operation_type,
      operationId: operation.id,
      amountCents: operation.amount_cents,
      provider: operation.provider,
      outcome: 'db_failure_before_provider',
      idempotencyKey: operation.idempotency_key,
    });
    return denied(spoof, {
      statusCode: 503,
      error: 'database_failure_before_provider',
      operation: publicOperation(operation),
      liveProviderCalled: false,
      recovery: 'retry_prepare_or_submit',
    });
  }
  const submitted = await applyStatus(client, operation, 'submit', {
    metadata: { submitted_at: new Date().toISOString(), simulated: true },
  });
  if (!submitted.ok) return denied(spoof, { statusCode: 409, ...submitted });
  if (failureClass && ['provider_400', 'provider_401', 'provider_409', 'provider_429', 'provider_500', 'provider_timeout', 'lambda_timeout'].includes(failureClass)) {
    const failed = await applyStatus(client, submitted.operation, 'fail', {
      failure_class: failureClass,
      metadata: { simulated_provider_error: failureClass, live_http: false },
    });
    await insertAudit(client, {
      applicationUserId: mapping.application_user_id,
      tenantId: operation.tenant_id,
      operationType: operation.operation_type,
      operationId: operation.id,
      amountCents: operation.amount_cents,
      provider: operation.provider,
      outcome: `simulated_${failureClass}`,
      idempotencyKey: operation.idempotency_key,
    });
    return {
      ok: true,
      statusCode: 200,
      simulatedFailure: true,
      failureClass,
      liveProviderCalled: false,
      productionExecution: false,
      applicationUserId: mapping.application_user_id,
      operation: publicOperation(failed.operation),
      gate,
    };
  }
  if (failureClass === 'db_after_provider') {
    const hung = (await client.query(
      `UPDATE public.aws_financial_operations
       SET provider_reference = $2,
           failure_class = 'db_after_provider',
           metadata = COALESCE(metadata, '{}'::jsonb) || $3::jsonb,
           updated_at = now()
       WHERE id = $1::uuid
       RETURNING *`,
      [
        submitted.operation.id,
        `sim_${submitted.operation.id}`,
        JSON.stringify({
          reconciliation_needed: true,
          provider_accepted: true,
          internal_update_failed: true,
          recovery: 'reconcile_then_confirm_from_provider_reference',
        }),
      ],
    )).rows[0];
    await insertAudit(client, {
      applicationUserId: mapping.application_user_id,
      tenantId: operation.tenant_id,
      operationType: operation.operation_type,
      operationId: operation.id,
      amountCents: operation.amount_cents,
      provider: operation.provider,
      providerReference: hung.provider_reference,
      outcome: 'provider_accepted_db_update_failed',
      idempotencyKey: operation.idempotency_key,
    });
    return {
      ok: true,
      statusCode: 200,
      simulatedFailure: true,
      failureClass: 'db_after_provider',
      liveProviderCalled: false,
      productionExecution: false,
      reconciliationNeeded: true,
      applicationUserId: mapping.application_user_id,
      operation: publicOperation(hung),
      recovery: 'Use /financial/reconcile. Do not create a second provider transaction.',
      gate,
    };
  }
  const accepted = await applyStatus(client, submitted.operation, 'provider_accepted', {
    provider_reference: `sim_${submitted.operation.id}`,
    metadata: {
      simulated_provider: {
        status: 'pending',
        amount_cents: Number(operation.amount_cents),
        provider_reference: `sim_${submitted.operation.id}`,
      },
    },
  });
  await insertAudit(client, {
    applicationUserId: mapping.application_user_id,
    tenantId: operation.tenant_id,
    operationType: operation.operation_type,
    operationId: operation.id,
    amountCents: operation.amount_cents,
    provider: operation.provider,
    providerReference: accepted.operation.provider_reference,
    outcome: 'simulated_submit',
    idempotencyKey: operation.idempotency_key,
  });
  return {
    ok: true,
    statusCode: 200,
    duplicate: false,
    liveProviderCalled: false,
    productionExecution: false,
    applicationUserId: mapping.application_user_id,
    authUid: mapping.application_user_id,
    cognitoSub: claims.sub,
    spoofFieldsIgnored: spoof,
    gate,
    operation: publicOperation(accepted.operation),
  };
}, deps);

const handleSimulateWebhook = async (event, deps) => withIdentityWrite(event, async ({ client, mapping, claims, body, spoof }) => {
  await setCertificationGuc(client);
  if (body?.tenant_id) {
    /* tenant from payload is ignored; server-derived from the operation */
  }
  const memberships = await membershipsOf(client, mapping.application_user_id);
  const operation = await lookupOperation(client, {
    operationId: body?.operation_id,
    idempotencyKey: body?.idempotency_key,
    tenantId: memberships[0]?.tenant_id,
  });
  if (!operation) return denied(spoof, { statusCode: 404, error: 'operation_not_found' });
  if (!memberships.some((row) => row.tenant_id === operation.tenant_id)) {
    return denied(spoof, { error: 'cross_tenant_denied' });
  }
  const roles = await rolesOf(client, mapping.application_user_id, operation.tenant_id);
  const gate = evaluateFinancialAuthorization({
    operation: operation.operation_type,
    identityOk: true,
    membershipOk: true,
    roles,
    simulationEnabled: financialSandboxSimulationEnabled(),
    permissionsActivated: financialPermissionsActivated(),
  });
  const sim = requireSimulation({ mapping, claims, spoof, gate });
  if (sim.ok !== true) return sim;
  const eventType = String(body?.event_type || (operation.provider === 'checkalt' ? 'deposit.cleared' : 'transfer.completed'));
  const externalEventId = String(body?.external_event_id || `sim-wh-${operation.id}-${eventType}`);
  const seen = operation.metadata?.webhook_events || [];
  if (seen.includes(externalEventId)) {
    await insertAudit(client, {
      applicationUserId: mapping.application_user_id,
      tenantId: operation.tenant_id,
      operationType: operation.operation_type,
      operationId: operation.id,
      amountCents: operation.amount_cents,
      provider: operation.provider,
      providerReference: operation.provider_reference,
      outcome: 'duplicate_webhook',
      idempotencyKey: operation.idempotency_key,
      details: { external_event_id: externalEventId },
    });
    return {
      ok: true,
      statusCode: 200,
      duplicate: true,
      applied: false,
      liveProviderCalled: false,
      productionExecution: false,
      mapped_tenant_id: operation.tenant_id,
      tenantFromPayloadIgnored: true,
      operation: publicOperation(operation),
    };
  }
  const action = WEBHOOK_EVENT_ACTIONS[eventType];
  if (!action) {
    return denied(spoof, {
      statusCode: 409,
      error: 'unexpected_webhook_event',
      event_type: eventType,
      message: 'Event is not expected by the financial state machine.',
    });
  }
  if (body?.out_of_order && operation.status === FINANCIAL_STATES.ready_for_provider) {
    await insertAudit(client, {
      applicationUserId: mapping.application_user_id,
      tenantId: operation.tenant_id,
      operationType: operation.operation_type,
      operationId: operation.id,
      outcome: 'out_of_order_webhook_ignored',
      details: { event_type: eventType, from: operation.status },
    });
    return {
      ok: true,
      statusCode: 200,
      applied: false,
      outOfOrder: true,
      liveProviderCalled: false,
      productionExecution: false,
      operation: publicOperation(operation),
      message: 'Out-of-order webhook ignored. State machine was not mutated.',
    };
  }
  const applied = await applyStatus(client, operation, action, {
    metadata: {
      webhook_events: [...seen, externalEventId],
      last_webhook: { event_type: eventType, external_event_id: externalEventId },
      simulated_provider: {
        status: mapProviderStatus(operation.provider, body?.provider_status) || action,
        amount_cents: Number(operation.amount_cents),
        provider_reference: operation.provider_reference,
      },
    },
  });
  if (!applied.ok) {
    return denied(spoof, { statusCode: 409, ...applied });
  }
  await insertAudit(client, {
    applicationUserId: mapping.application_user_id,
    tenantId: operation.tenant_id,
    operationType: operation.operation_type,
    operationId: operation.id,
    amountCents: operation.amount_cents,
    provider: operation.provider,
    providerReference: applied.operation.provider_reference,
    outcome: 'simulated_webhook',
    idempotencyKey: operation.idempotency_key,
    details: { event_type: eventType, external_event_id: externalEventId },
  });
  return {
    ok: true,
    statusCode: 200,
    duplicate: false,
    applied: true,
    dry_run: false,
    stagingRecordsOnly: true,
    liveProviderCalled: false,
    productionExecution: false,
    mapped_tenant_id: operation.tenant_id,
    tenantFromPayloadIgnored: true,
    applicationUserId: mapping.application_user_id,
    authUid: mapping.application_user_id,
    cognitoSub: claims.sub,
    spoofFieldsIgnored: spoof,
    operation: publicOperation(applied.operation),
  };
}, deps);

const handleReconcile = async (event, deps) => withIdentityWrite(event, async ({ client, mapping, claims, body, spoof }) => {
  await setCertificationGuc(client);
  const memberships = await membershipsOf(client, mapping.application_user_id);
  const tenantId = memberships[0]?.tenant_id;
  if (!tenantId) return denied(spoof, { error: 'no_tenant_membership' });
  const operationId = body?.operation_id;
  const operations = operationId && isUuid(operationId)
    ? (await client.query(
      'SELECT * FROM public.aws_financial_operations WHERE id = $1::uuid AND tenant_id = $2::uuid',
      [operationId, tenantId],
    )).rows
    : (await client.query(
      `SELECT * FROM public.aws_financial_operations
       WHERE tenant_id = $1::uuid
       ORDER BY created_at DESC
       LIMIT 50`,
      [tenantId],
    )).rows;
  const providerTxns = [];
  for (const operation of operations) {
    const simulated = operation.metadata?.simulated_provider;
    if (simulated) {
      providerTxns.push({
        operation_id: operation.id,
        provider_reference: simulated.provider_reference || operation.provider_reference,
        status: simulated.status,
        amount_cents: simulated.amount_cents,
      });
    }
    if (operation.failure_class === 'db_after_provider' && operation.provider_reference) {
      providerTxns.push({
        operation_id: operation.id,
        provider_reference: operation.provider_reference,
        status: 'completed',
        amount_cents: Number(operation.amount_cents),
      });
    }
  }
  if (Array.isArray(body?.extra_provider_txns)) {
    for (const txn of body.extra_provider_txns) {
      providerTxns.push({
        operation_id: txn.operation_id || null,
        provider_reference: txn.provider_reference,
        status: txn.status,
        amount_cents: txn.amount_cents,
      });
    }
  }
  const report = reconcileOperations({
    operations,
    providerTxns,
    nowMs: Date.now(),
  });
  for (const finding of report.findings) {
    await client.query(
      `INSERT INTO public.aws_financial_reconciliation_findings
        (operation_id, tenant_id, finding_type, internal_status, provider_status,
         internal_amount_cents, provider_amount_cents, details, auto_corrected)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8::jsonb, false)`,
      [
        finding.operation_id,
        tenantId,
        finding.finding_type,
        finding.internal_status,
        finding.provider_status,
        finding.internal_amount_cents,
        finding.provider_amount_cents,
        JSON.stringify({ provider_reference: finding.provider_reference }),
      ],
    );
  }
  await insertAudit(client, {
    applicationUserId: mapping.application_user_id,
    tenantId,
    operationType: 'reconcile',
    operationId: operationId && isUuid(operationId) ? operationId : null,
    outcome: 'reconcile_report',
    details: { compared: report.compared, findings: report.findings.length },
  });
  return {
    ok: true,
    statusCode: 200,
    liveProviderCalled: false,
    productionExecution: false,
    autoCorrected: false,
    applicationUserId: mapping.application_user_id,
    authUid: mapping.application_user_id,
    cognitoSub: claims.sub,
    spoofFieldsIgnored: spoof,
    ...report,
  };
}, deps);

const handleSimulateFailure = async (event, deps) => {
  const body = parseBody(event);
  return handleSimulateSubmit({
    ...event,
    body: JSON.stringify({ ...body, failure_class: body.failure_class }),
  }, deps);
};

const handleCleanup = async (event, deps) => withIdentityWrite(event, async ({ client, mapping, claims, body, spoof }) => {
  await setCertificationGuc(client);
  const memberships = await membershipsOf(client, mapping.application_user_id);
  const tenantIds = memberships.map((row) => row.tenant_id);
  if (!tenantIds.length) return denied(spoof, { error: 'no_tenant_membership' });
  const marker = String(body?.marker || CERTIFICATION_MARKER);
  const deleted = (await client.query(
    `DELETE FROM public.aws_financial_operations
     WHERE simulated = true
       AND tenant_id = ANY($1::uuid[])
       AND (
         metadata->>'marker' = $2
         OR metadata->>'marker' LIKE $3
         OR application_user_id = $4::uuid
       )
     RETURNING id`,
    [tenantIds, marker, `${marker}%`, mapping.application_user_id],
  )).rows;
  await insertAudit(client, {
    applicationUserId: mapping.application_user_id,
    tenantId: tenantIds[0],
    operationType: 'cleanup',
    outcome: 'cleanup_simulated',
    details: { deleted: deleted.length, marker },
  });
  return {
    ok: true,
    statusCode: 200,
    deleted: deleted.length,
    ids: deleted.map((row) => row.id),
    liveProviderCalled: false,
    productionExecution: false,
    applicationUserId: mapping.application_user_id,
    cognitoSub: claims.sub,
    spoofFieldsIgnored: spoof,
  };
}, deps);

export const financialRoute = (path, method) => {
  if (method === 'GET' && path === '/financial/status') return { kind: 'status' };
  if (method === 'POST' && path === '/financial/prepare') return { kind: 'prepare' };
  if (method === 'POST' && path === '/financial/simulate-submit') return { kind: 'submit' };
  if (method === 'POST' && path === '/financial/simulate-webhook') return { kind: 'webhook' };
  if (method === 'POST' && path === '/financial/reconcile') return { kind: 'reconcile' };
  if (method === 'POST' && path === '/financial/simulate-failure') return { kind: 'failure' };
  if (method === 'POST' && path === '/financial/cleanup') return { kind: 'cleanup' };
  return null;
};

export const handleFinancialRequest = async (event, path, method, deps = {}) => {
  const route = financialRoute(path, method);
  if (!route) return null;
  if (route.kind === 'status') return handleFinancialStatus();
  if (route.kind === 'prepare') return handlePrepare(event, deps);
  if (route.kind === 'submit') return handleSimulateSubmit(event, deps);
  if (route.kind === 'webhook') return handleSimulateWebhook(event, deps);
  if (route.kind === 'reconcile') return handleReconcile(event, deps);
  if (route.kind === 'failure') return handleSimulateFailure(event, deps);
  if (route.kind === 'cleanup') return handleCleanup(event, deps);
  return null;
};

export { handlePrepare, handleSimulateSubmit, handleSimulateWebhook, handleReconcile };

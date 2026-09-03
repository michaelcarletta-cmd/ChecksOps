import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handler } from '../functions/api/index.mjs';
import { LOOKUP_MAPPING_SQL, TENANT_MEMBERSHIP_SQL, USER_ROLES_SQL } from '../functions/api/identity.mjs';
import { handleFinancialRequest } from '../functions/api/financial.mjs';
import { CERTIFICATION_FIXTURE_CENTS } from '../functions/api/financial.mjs';
import { evaluateFinancialAuthorization, FINANCIAL_OPERATIONS } from '../functions/api/financial-authz.mjs';
import { evaluateTransition, FINANCIAL_STATES } from '../functions/api/financial-state.mjs';
import { stableIdempotencyKey } from '../functions/api/financial-idempotency.mjs';
import { verifyOwnershipChain } from '../functions/api/financial-ownership.mjs';
import { sanitizeAuditDetails } from '../functions/api/financial-audit.mjs';
import { FINDING_TYPES, reconcileOperations } from '../functions/api/financial-reconciliation.mjs';
import {
  dollarsToIntegerCents,
  formatCheckAltUserAmount,
  formatMoovTransferAmount,
  rejectUntrustedAmountFields,
  validateProviderCents,
} from '../functions/api/providers/amounts.mjs';

const FREEDOM_APP = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';
const FREEDOM_TENANT = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const C1C_TENANT = '4f172140-f57a-4744-8050-95f4f07b13b4';
const COGNITO_SUB = 'c4386408-60e1-70e2-abb6-e6194e8e635f';
const SPOOF_ID = '00000000-0000-0000-0000-000000000099';
const CHECK_ID = '8d2b1c3e-4f5a-4678-9abc-def012345678';
const OP_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const jwtEvent = (path, method, body, extra = {}) => ({
  rawPath: path,
  headers: {
    authorization: extra.auth === null ? undefined : 'Bearer test-id-token',
    'x-user-id': SPOOF_ID,
    'x-tenant-id': C1C_TENANT,
    'x-role': 'admin',
    ...(extra.headers || {}),
  },
  queryStringParameters: { user_id: SPOOF_ID, tenant_id: C1C_TENANT, ...(extra.query || {}) },
  body: body ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
  requestContext: {
    stage: 'staging',
    http: { method, path },
    authorizer: extra.auth === null ? undefined : {
      jwt: { claims: { sub: extra.sub || COGNITO_SUB, email: 'checksops-tester@freedomadj.com', token_use: 'id' } },
    },
  },
});

const mappingFor = () => ({
  application_user_id: FREEDOM_APP,
  cognito_sub: COGNITO_SUB,
  email: 'checksops-tester@freedomadj.com',
  status: 'active',
});

const readyCheck = {
  id: CHECK_ID,
  tenant_id: FREEDOM_TENANT,
  uploaded_by: FREEDOM_APP,
  status: 'approved_for_deposit',
  check_stage: 'ready_for_deposit',
  claim_id: null,
  deposited_at: null,
  amount: 123.45,
  carrier_name: 'AWS T6 FINANCIAL',
};

const mockClient = ({
  mapping = mappingFor(),
  memberships = [{ tenant_id: FREEDOM_TENANT, role: 'admin', tenant_name: 'Freedom', tenant_slug: 'freedom' }],
  roles = [{ role: 'admin' }],
  check = readyCheck,
  operations = [],
} = {}) => {
  const queries = [];
  const ops = [...operations];
  const audits = [];
  const findings = [];
  return {
    queries,
    ops,
    audits,
    findings,
    connect: async () => {},
    end: async () => {},
    query: async (sql, params = []) => {
      queries.push({ sql, params });
      if (sql === 'BEGIN' || sql === 'ROLLBACK' || sql === 'COMMIT' || sql === 'SET TRANSACTION READ WRITE') {
        return { rows: [] };
      }
      if (sql.startsWith('SELECT set_config') || sql.includes("set_config('request.financial_certification'")) {
        return { rows: [{ set_config: params[1] || '1' }] };
      }
      if (sql === LOOKUP_MAPPING_SQL) {
        return { rows: params[0] === mapping.cognito_sub ? [mapping] : [] };
      }
      if (sql === TENANT_MEMBERSHIP_SQL || sql.includes('FROM public.tenant_users tu')) {
        return { rows: memberships };
      }
      if (sql === USER_ROLES_SQL || sql.includes('FROM public.user_roles')) {
        return { rows: roles };
      }
      if (sql.includes('FROM public.tenant_users WHERE user_id')) {
        return { rows: memberships.filter((row) => !params[1] || row.tenant_id === params[1]) };
      }
      if (sql.includes('FROM public.check_intake_items')) {
        return { rows: check && params[0] === check.id ? [check] : [] };
      }
      if (sql.includes('FROM public.checkalt_tenant_accounts')) {
        return { rows: [{ id: 'ca-1', tenant_id: FREEDOM_TENANT, provider: 'checkalt', provider_account_id: 'sso-1' }] };
      }
      if (sql.includes('FROM public.payment_provider_accounts')) {
        return { rows: [{ id: 'acct-1', tenant_id: FREEDOM_TENANT, provider: 'moov', provider_account_id: 'moov-acct-freedom' }] };
      }
      if (sql.includes('FROM public.payment_wallets')) {
        return { rows: [{ id: '11111111-1111-4111-8111-111111111111', tenant_id: FREEDOM_TENANT, provider_wallet_id: 'w1' }] };
      }
      if (sql.includes('INSERT INTO public.aws_financial_audit')) {
        audits.push({ outcome: params[7] });
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO public.aws_financial_reconciliation_findings')) {
        findings.push({ finding_type: params[2] });
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO public.aws_financial_operations')) {
        const existing = ops.find((row) => row.tenant_id === params[0] && row.idempotency_key === params[7]);
        if (existing) return { rows: [existing] };
        const row = {
          id: OP_ID,
          tenant_id: params[0],
          application_user_id: params[1],
          operation_type: params[2],
          provider: params[3],
          resource_type: 'check',
          resource_id: params[4],
          amount_cents: params[5],
          currency: 'USD',
          amount_source: params[6],
          idempotency_key: params[7],
          status: params[8],
          previous_status: null,
          provider_reference: null,
          simulated: true,
          live_provider_called: false,
          failure_class: null,
          metadata: JSON.parse(params[9] || '{}'),
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        ops.push(row);
        return { rows: [row] };
      }
      if (sql.includes('UPDATE public.aws_financial_operations')) {
        const row = ops.find((item) => item.id === params[0]);
        if (!row) return { rows: [] };
        if (sql.includes('SET previous_status')) {
          row.previous_status = row.status;
          row.status = params[1];
          if (params[2]) row.provider_reference = params[2];
          if (params[3]) row.failure_class = params[3];
          row.metadata = { ...(row.metadata || {}), ...(JSON.parse(params[4] || '{}')) };
        } else if (sql.includes('provider_reference')) {
          row.provider_reference = params[1];
          if (sql.includes("failure_class = 'db_after_provider'")) row.failure_class = 'db_after_provider';
          const metaIdx = sql.includes('$3') ? 2 : 3;
          const rawMeta = params[metaIdx];
          if (rawMeta && typeof rawMeta === 'string' && rawMeta.startsWith('{')) {
            row.metadata = { ...(row.metadata || {}), ...JSON.parse(rawMeta) };
          }
        }
        row.updated_at = new Date().toISOString();
        return { rows: [row] };
      }
      if (sql.includes('FROM public.aws_financial_operations')) {
        if (params[0] && /(?:WHERE|AND) id =/.test(sql)) {
          return { rows: ops.filter((row) => row.id === params[0] && (!params[1] || row.tenant_id === params[1])) };
        }
        if (params[1] && String(sql).includes('idempotency_key')) {
          return { rows: ops.filter((row) => row.tenant_id === params[0] && row.idempotency_key === params[1]) };
        }
        return { rows: ops.filter((row) => !params[0] || row.tenant_id === params[0]) };
      }
      if (sql.includes('DELETE FROM public.aws_financial_operations')) {
        const removed = ops.splice(0, ops.length);
        return { rows: removed };
      }
      return { rows: [] };
    },
  };
};

const withEnv = async (vars, fn) => {
  const previous = {};
  for (const [key, value] of Object.entries(vars)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

const depsFor = (client) => ({
  loadDatabaseCredentials: async () => ({ host: 'localhost', username: 'checksops', password: 'x', database: 'checksops' }),
  createClient: () => client,
});

test('CheckAlt integer-cents and Moov amount.value stay cents', () => {
  assert.equal(formatCheckAltUserAmount(123.45).userAmount, 12345);
  assert.equal(formatCheckAltUserAmount('123.45').userAmount, 12345);
  assert.equal(formatCheckAltUserAmount(0.01).userAmount, 1);
  assert.equal(formatCheckAltUserAmount(1).userAmount, 100);
  assert.equal(dollarsToIntegerCents('1.00').cents, 100);
  const moov = formatMoovTransferAmount(12345);
  assert.equal(moov.amount.value, 12345);
  assert.equal(moov.amount.currency, 'USD');
  assert.equal(moov.scale, 'integer_cents');
});

test('invalid amounts are rejected server-side', () => {
  assert.equal(validateProviderCents(0).error, 'invalid_amount');
  assert.equal(validateProviderCents(-1).error, 'invalid_amount');
  assert.equal(validateProviderCents(100_000_001).error, 'invalid_amount');
  assert.equal(validateProviderCents(1.5).error, 'invalid_amount');
  assert.equal(dollarsToIntegerCents('123.456').error, 'invalid_amount');
  assert.equal(dollarsToIntegerCents('not-a-number').error, 'invalid_amount');
  const untrusted = rejectUntrustedAmountFields({ amount: 12.34, check_id: CHECK_ID });
  assert.equal(untrusted.error, 'untrusted_amount');
  assert.ok(untrusted.fields.includes('amount'));
});

test('admin/staff login is not production money-movement authority', () => {
  const gate = evaluateFinancialAuthorization({
    operation: 'checkalt_deposit',
    identityOk: true,
    membershipOk: true,
    roles: ['admin', 'staff'],
    simulationEnabled: false,
    permissionsActivated: false,
  });
  assert.equal(gate.canExecuteProduction, false);
  assert.equal(gate.canSimulate, false);
  const sim = evaluateFinancialAuthorization({
    operation: 'checkalt_deposit',
    identityOk: true,
    membershipOk: true,
    roles: ['staff'],
    simulationEnabled: true,
    permissionsActivated: false,
  });
  assert.equal(sim.canExecuteProduction, false);
  assert.equal(sim.canSimulate, true);
  assert.equal(sim.roleOk, false);
  assert.equal(FINANCIAL_OPERATIONS.checkalt_deposit.activated, false);
});

test('state machine rejects illegal browser-style jumps', () => {
  const illegal = evaluateTransition(FINANCIAL_STATES.ready_for_provider, 'provider_confirmed');
  assert.equal(illegal.ok, false);
  const ok = evaluateTransition(FINANCIAL_STATES.provider_pending, 'provider_confirmed');
  assert.equal(ok.ok, true);
  assert.equal(ok.to, FINANCIAL_STATES.provider_confirmed);
});

test('ownership ignores browser tenant and rejects spoofed wallet/payee', () => {
  const ignoredTenant = verifyOwnershipChain({
    applicationUserId: FREEDOM_APP,
    memberships: [{ tenant_id: FREEDOM_TENANT, role: 'admin' }],
    check: readyCheck,
    claimed: { tenant_id: C1C_TENANT, user_id: SPOOF_ID },
  });
  assert.equal(ignoredTenant.ok, true);
  assert.equal(ignoredTenant.tenantId, FREEDOM_TENANT);
  assert.ok(ignoredTenant.ignored.includes('tenant_id'));
  const walletDenied = verifyOwnershipChain({
    applicationUserId: FREEDOM_APP,
    memberships: [{ tenant_id: FREEDOM_TENANT, role: 'admin' }],
    check: readyCheck,
    wallet: { id: 'w1', tenant_id: C1C_TENANT },
  });
  assert.equal(walletDenied.error, 'spoofed_provider_id');
});

test('audit redacts secrets and bank numbers', () => {
  const sanitized = sanitizeAuditDetails({
    account_number: '123456789',
    routing_number: '021000021',
    token: 'secret',
    kyc_document: 'bytes',
    operation: 'checkalt_deposit',
  });
  assert.equal(sanitized.account_number, '[redacted]');
  assert.equal(sanitized.routing_number, '[redacted]');
  assert.equal(sanitized.token, '[redacted]');
  assert.equal(sanitized.kyc_document, '[redacted]');
  assert.equal(sanitized.operation, 'checkalt_deposit');
});

test('reconciliation reports and never auto-corrects', () => {
  const report = reconcileOperations({
    operations: [{
      id: OP_ID,
      status: 'submitting',
      amount_cents: 12345,
      provider_reference: 'sim_1',
      updated_at: new Date().toISOString(),
    }],
    providerTxns: [{
      operation_id: OP_ID,
      provider_reference: 'sim_1',
      status: 'completed',
      amount_cents: 12345,
    }],
  });
  assert.equal(report.autoCorrected, false);
  assert.equal(report.findings[0].finding_type, FINDING_TYPES.INTERNAL_PENDING_PROVIDER_SUCCEEDED);
});

test('GET /financial/status keeps production execution blocked', async () => {
  await withEnv({
    AWS_PROVIDER_EXECUTION_ENABLED: 'false',
    AWS_FINANCIAL_PERMISSIONS_ACTIVATED: 'false',
    AWS_FINANCIAL_SANDBOX_SIMULATION_ENABLED: 'true',
  }, async () => {
    const response = await handler(jwtEvent('/financial/status', 'GET'));
    const body = JSON.parse(response.body);
    assert.equal(response.statusCode, 200);
    assert.equal(body.flags.AWS_PROVIDER_EXECUTION_ENABLED, false);
    assert.equal(body.flags.AWS_FINANCIAL_PERMISSIONS_ACTIVATED, false);
    assert.equal(body.liveProviderTransactions, false);
    assert.equal(body.productionExecution, false);
    assert.equal(body.amountUnits.moov.scale, 'integer_cents');
    assert.equal(body.certificationFixtureCents, CERTIFICATION_FIXTURE_CENTS);
  });
});

test('prepare uses server amount and rejects browser amount', async () => {
  await withEnv({
    AWS_FINANCIAL_SANDBOX_SIMULATION_ENABLED: 'true',
    AWS_PROVIDER_EXECUTION_ENABLED: 'false',
    AWS_FINANCIAL_PERMISSIONS_ACTIVATED: 'false',
  }, async () => {
    const client = mockClient();
    const rejected = await handleFinancialRequest(
      jwtEvent('/financial/prepare', 'POST', { operation_type: 'checkalt_deposit', check_id: CHECK_ID, amount: 9.99 }),
      '/financial/prepare',
      'POST',
      depsFor(client),
    );
    assert.equal(rejected.statusCode, 400);
    assert.equal(rejected.error, 'untrusted_amount');

    const prepared = await handleFinancialRequest(
      jwtEvent('/financial/prepare', 'POST', {
        operation_type: 'checkalt_deposit',
        check_id: CHECK_ID,
        tenant_id: C1C_TENANT,
        user_id: SPOOF_ID,
        amount: undefined,
      }),
      '/financial/prepare',
      'POST',
      depsFor(client),
    );
    assert.equal(prepared.ok, true);
    assert.equal(prepared.operation.amount_cents, 12345);
    assert.equal(prepared.operation.amount_source, 'check_intake_items.amount');
    assert.equal(prepared.liveProviderCalled, false);
    assert.equal(prepared.applicationUserId, FREEDOM_APP);
  });
});

test('identical prepare is idempotent', async () => {
  await withEnv({
    AWS_FINANCIAL_SANDBOX_SIMULATION_ENABLED: 'true',
    AWS_PROVIDER_EXECUTION_ENABLED: 'false',
  }, async () => {
    const client = mockClient();
    const first = await handleFinancialRequest(
      jwtEvent('/financial/prepare', 'POST', { operation_type: 'checkalt_deposit', check_id: CHECK_ID }),
      '/financial/prepare',
      'POST',
      depsFor(client),
    );
    const second = await handleFinancialRequest(
      jwtEvent('/financial/prepare', 'POST', { operation_type: 'checkalt_deposit', check_id: CHECK_ID }),
      '/financial/prepare',
      'POST',
      depsFor(client),
    );
    assert.equal(first.ok, true);
    assert.equal(second.duplicate, true);
    assert.equal(second.operation.id, first.operation.id);
    assert.equal(client.ops.length, 1);
    assert.equal(stableIdempotencyKey({
      tenantId: FREEDOM_TENANT,
      operationType: 'checkalt_deposit',
      resourceId: CHECK_ID,
      amountCents: 12345,
    }).length, 64);
  });
});

test('simulate submit then webhook reaches provider_confirmed', async () => {
  await withEnv({
    AWS_FINANCIAL_SANDBOX_SIMULATION_ENABLED: 'true',
    AWS_PROVIDER_EXECUTION_ENABLED: 'false',
  }, async () => {
    const client = mockClient();
    await handleFinancialRequest(
      jwtEvent('/financial/prepare', 'POST', { operation_type: 'checkalt_deposit', check_id: CHECK_ID }),
      '/financial/prepare',
      'POST',
      depsFor(client),
    );
    const submitted = await handleFinancialRequest(
      jwtEvent('/financial/simulate-submit', 'POST', { operation_id: OP_ID }),
      '/financial/simulate-submit',
      'POST',
      depsFor(client),
    );
    assert.equal(submitted.operation.status, FINANCIAL_STATES.provider_pending);
    assert.equal(submitted.liveProviderCalled, false);
    const replay = await handleFinancialRequest(
      jwtEvent('/financial/simulate-submit', 'POST', { operation_id: OP_ID }),
      '/financial/simulate-submit',
      'POST',
      depsFor(client),
    );
    assert.equal(replay.duplicate, true);
    const webhook = await handleFinancialRequest(
      jwtEvent('/financial/simulate-webhook', 'POST', {
        operation_id: OP_ID,
        event_type: 'deposit.cleared',
        tenant_id: C1C_TENANT,
        external_event_id: 'evt-1',
      }),
      '/financial/simulate-webhook',
      'POST',
      depsFor(client),
    );
    assert.equal(webhook.applied, true);
    assert.equal(webhook.mapped_tenant_id, FREEDOM_TENANT);
    assert.equal(webhook.tenantFromPayloadIgnored, true);
    assert.equal(webhook.operation.status, FINANCIAL_STATES.provider_confirmed);
    const dup = await handleFinancialRequest(
      jwtEvent('/financial/simulate-webhook', 'POST', {
        operation_id: OP_ID,
        event_type: 'deposit.cleared',
        external_event_id: 'evt-1',
      }),
      '/financial/simulate-webhook',
      'POST',
      depsFor(client),
    );
    assert.equal(dup.duplicate, true);
    assert.equal(dup.applied, false);
  });
});

test('simulated provider failures do not call a live provider', async () => {
  await withEnv({
    AWS_FINANCIAL_SANDBOX_SIMULATION_ENABLED: 'true',
    AWS_PROVIDER_EXECUTION_ENABLED: 'false',
  }, async () => {
    for (const failureClass of ['provider_400', 'provider_401', 'provider_409', 'provider_429', 'provider_500', 'provider_timeout']) {
      const client = mockClient();
      await handleFinancialRequest(
        jwtEvent('/financial/prepare', 'POST', { operation_type: 'disbursement', check_id: CHECK_ID }),
        '/financial/prepare',
        'POST',
        depsFor(client),
      );
      const failed = await handleFinancialRequest(
        jwtEvent('/financial/simulate-failure', 'POST', { operation_id: OP_ID, failure_class: failureClass }),
        '/financial/simulate-failure',
        'POST',
        depsFor(client),
      );
      assert.equal(failed.simulatedFailure, true);
      assert.equal(failed.liveProviderCalled, false);
      assert.equal(failed.operation.status, FINANCIAL_STATES.provider_failed);
    }
  });
});

test('db failure after provider accept is reported for reconciliation', async () => {
  await withEnv({
    AWS_FINANCIAL_SANDBOX_SIMULATION_ENABLED: 'true',
    AWS_PROVIDER_EXECUTION_ENABLED: 'false',
  }, async () => {
    const client = mockClient();
    await handleFinancialRequest(
      jwtEvent('/financial/prepare', 'POST', { operation_type: 'ach', check_id: CHECK_ID }),
      '/financial/prepare',
      'POST',
      depsFor(client),
    );
    const hung = await handleFinancialRequest(
      jwtEvent('/financial/simulate-submit', 'POST', { operation_id: OP_ID, failure_class: 'db_after_provider' }),
      '/financial/simulate-submit',
      'POST',
      depsFor(client),
    );
    assert.equal(hung.reconciliationNeeded, true);
    assert.equal(hung.operation.status, FINANCIAL_STATES.submitting);
    assert.ok(hung.operation.provider_reference);
    const report = await handleFinancialRequest(
      jwtEvent('/financial/reconcile', 'POST', { operation_id: OP_ID }),
      '/financial/reconcile',
      'POST',
      depsFor(client),
    );
    assert.equal(report.autoCorrected, false);
    assert.ok(report.findings.some((row) => row.finding_type === FINDING_TYPES.INTERNAL_PENDING_PROVIDER_SUCCEEDED));
  });
});

test('production execution stays blocked even if the master flag is flipped', async () => {
  await withEnv({
    AWS_FINANCIAL_SANDBOX_SIMULATION_ENABLED: 'true',
    AWS_PROVIDER_EXECUTION_ENABLED: 'true',
    AWS_MOOV_ENABLED: 'true',
  }, async () => {
    const client = mockClient();
    const result = await handleFinancialRequest(
      jwtEvent('/financial/prepare', 'POST', { operation_type: 'checkalt_deposit', check_id: CHECK_ID }),
      '/financial/prepare',
      'POST',
      depsFor(client),
    );
    assert.equal(result.statusCode, 403);
    assert.equal(result.error, 'production_execution_blocked');
    const liveFn = await handler(jwtEvent('/functions/v1/moov-transfer-create', 'POST', { amount_cents: 100 }));
    assert.equal(liveFn.statusCode, 403);
    assert.equal(JSON.parse(liveFn.body).error, 'production_execution_blocked');
  });
});

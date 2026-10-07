import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  handleTenantManagementV2,
  resolvePeriod,
  runTenantManagementV2,
} from '../functions/api/tenant-management-v2.mjs';
import { handleAppServiceRequest } from '../functions/api/app-services.mjs';

const TENANT_ID = '4f172140-f57a-4744-8050-95f4f07b13b4';
const OTHER_TENANT_ID = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';

const tenant = {
  id: TENANT_ID,
  name: 'Tenant One',
  slug: 'tenant-one',
  subscription_status: 'active',
  plan_tier: 'pro',
  max_checks_per_month: 100,
  moov_environment: 'sandbox',
  per_check_billing_enabled: true,
  per_check_rate_cents: 300,
  created_at: '2026-01-01T00:00:00.000Z',
  user_count: 3,
};

const queryRows = (sql) => {
  if (/SELECT public\.is_platform_owner/.test(sql)) return [{ is_platform_owner: true }];
  if (/FROM public\.tenants t/.test(sql)) return [tenant];
  if (/WITH processed AS/.test(sql)) return [{
    processed_checks: 4,
    matched_checks: 2,
    missing_usage_events: 1,
    duplicate_billing_events: 1,
    orphan_billing_events: 1,
    suspicious_billing_events: 2,
  }];
  if (/AS checks_total/.test(sql)) {
    return [{
      checks_total: 40,
      ocr_completed: 31,
      ocr_failed: 2,
      ocr_pending: 7,
      files_total: 12,
      known_file_bytes: '4096',
      unknown_file_sizes: 0,
      signature_requests_total: 4,
      signature_requests_open: 1,
      mortgage_ops_total: 3,
      mortgage_ops_open: 1,
      deposits_total: 8,
      deposits_open: 2,
      disbursements_total: 5,
      disbursements_open: 2,
    }];
  }
  if (/FROM public\.check_intake_items\s+WHERE/.test(sql)) return [{ checks_received: 9 }];
  if (/FROM public\.check_billing_events/.test(sql)) {
    return [{
      fee_events: 2,
      check_and_disbursement_fees_cents: '300',
      non_usd_fee_events: 0,
      failed_fee_events: 1,
    }];
  }
  if (/FROM public\.mortgage_handling_requests\s+WHERE tenant_id/.test(sql)) {
    return [{ billed_requests: 1, billed_cents: '150', failed_billing_requests: 0 }];
  }
  if (/AS recorded_payments_cents/.test(sql)) {
    return [{
      recorded_payments: 1,
      recorded_payments_cents: '600',
      collected_payments: 1,
      collected_payments_cents: '400',
    }];
  }
  if (/FROM public\.tenant_maintenance_payments/.test(sql)) {
    return [
      { id: 'payment-recorded', amount_cents: 500, status: 'recorded', period_start: '2026-10-01', period_end: '2026-10-31', received_at: '2026-10-02T00:00:00Z' },
      { id: 'payment-cleared', amount_cents: 200, status: 'cleared', period_start: '2026-09-01', period_end: '2026-09-30', received_at: '2026-10-03T00:00:00Z' },
      { id: 'payment-pending', amount_cents: 900, status: 'pending', period_start: '2026-10-01', period_end: '2026-10-31', received_at: '2026-10-04T00:00:00Z' },
    ];
  }
  if (/FROM public\.tenant_billing_accounts/.test(sql)) {
    return [{ auto_debit_enabled: true, verification_status: 'verified', ach_authorized_at: '2026-09-01T00:00:00Z' }];
  }
  if (/FROM public\.payment_provider_accounts/.test(sql)) {
    return [{
      environment: 'sandbox',
      onboarding_status: 'complete',
      verification_status: 'verified',
      can_receive_payments: true,
      can_send_payments: false,
      can_ach_debit: true,
      can_ach_credit: false,
      restricted: false,
      disabled: false,
      requirements_count: 0,
      last_synced_at: '2026-10-01T00:00:00Z',
    }];
  }
  if (/FROM public\.payment_provider_methods/.test(sql)) {
    return [{ total: 2, connected: 1, pending: 1, disconnected: 0 }];
  }
  if (/public\.checkalt_tenant_accounts/.test(sql)) {
    return [{ enabled: true, registered_at: '2026-09-01T00:00:00Z', platform_enabled: true }];
  }
  if (/FROM public\.payment_webhook_events/.test(sql)) {
    return [{ moov_error_events: 1, checkalt_error_events: 2, last_error_at: '2026-10-05T00:00:00Z' }];
  }
  if (/FROM public\.check_audit_log/.test(sql)) {
    return [{ created_at: '2026-10-06T00:00:00Z', action: 'check_deposited', actor_id: TENANT_ID }];
  }
  if (/FROM public\.audit_logs/.test(sql)) {
    return [{
      id: 'audit-1',
      created_at: '2026-10-06T00:00:00Z',
      actor_id: TENANT_ID,
      action: 'tenant updated token=example-secret',
      record_type: 'tenant',
      old_values: { name: 'Old Tenant', plan_tier: 'starter', account_number: '123456', token: 'private' },
      new_values: { name: 'New Tenant', per_check_rate_cents: 300, api_key: 'private' },
    }];
  }
  throw new Error(`Unexpected query: ${sql}`);
};

const makeClient = (mutateTenant) => {
  const queries = [];
  return {
    queries,
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (/SELECT public\.is_platform_owner/.test(sql)) return { rows: [{ is_platform_owner: true }] };
      if (/FROM public\.tenants t/.test(sql)) {
        return { rows: [mutateTenant || tenant] };
      }
      return { rows: queryRows(sql) };
    },
  };
};

test('uses the current UTC month by default and validates explicit periods', () => {
  const now = new Date('2026-10-07T01:52:00.000Z');
  assert.deepEqual(resolvePeriod({}, now), {
    ok: true,
    start: '2026-10-01T00:00:00.000Z',
    end: '2026-11-01T00:00:00.000Z',
  });
  assert.equal(resolvePeriod({ period_start: '2026-10-01' }, now).ok, false);
  assert.equal(resolvePeriod({ period_start: 'not-a-date', period_end: '2026-11-01' }, now).ok, false);
  assert.equal(resolvePeriod({ period_start: '2025-01-01', period_end: '2026-02-01' }, now).ok, false);
});

test('requires an explicitly bound tenant ID and ignores spoofed body scope', async () => {
  let identityCalled = false;
  const invalid = await handleTenantManagementV2({
    body: JSON.stringify({ tenant_id: TENANT_ID }),
    queryStringParameters: {},
  }, {
    withIdentity: async () => { identityCalled = true; },
  });
  assert.equal(invalid.statusCode, 400);
  assert.equal(identityCalled, false);

  const client = makeClient();
  const result = await handleTenantManagementV2({
    body: JSON.stringify({ tenant_id: OTHER_TENANT_ID }),
    queryStringParameters: { tenant_id: TENANT_ID },
  }, {
    withIdentity: async (event, callback, options) => {
      assert.equal(event.queryStringParameters.tenant_id, TENANT_ID);
      assert.equal(options.write, false);
      assert.equal(options.commit, false);
      return callback({ client });
    },
    now: new Date('2026-10-07T00:00:00Z'),
  });
  assert.equal(result.ok, true);
  assert.equal(result.tenant.id, TENANT_ID);
  for (const query of client.queries.slice(1)) {
    assert.equal(query.params[0], TENANT_ID);
  }
});

test('fails closed for non-owner identities before reading any tenant data', async () => {
  const client = {
    queries: [],
    async query(sql, params = []) {
      this.queries.push({ sql, params });
      return { rows: [{ is_platform_owner: false }] };
    },
  };
  const result = await runTenantManagementV2({
    client,
    tenantId: TENANT_ID,
    period: { start: '2026-10-01T00:00:00.000Z', end: '2026-11-01T00:00:00.000Z' },
  });
  assert.equal(result.statusCode, 403);
  assert.equal(client.queries.length, 1);
});

test('fails closed if the selected tenant read model returns another tenant', async () => {
  const client = makeClient({ ...tenant, id: OTHER_TENANT_ID });
  const result = await runTenantManagementV2({
    client,
    tenantId: TENANT_ID,
    period: { start: '2026-10-01T00:00:00.000Z', end: '2026-11-01T00:00:00.000Z' },
  });
  assert.equal(result.statusCode, 503);
  assert.equal(client.queries.length, 2);
});

test('reconciles billing, separates recorded and collected payments, and leaves unsupported outstanding unavailable', async () => {
  const client = makeClient();
  const result = await runTenantManagementV2({
    client,
    tenantId: TENANT_ID,
    period: { start: '2026-10-01T00:00:00.000Z', end: '2026-11-01T00:00:00.000Z' },
    environment: 'staging',
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.integrity, {
    processedChecks: 4,
    matchedChecks: 2,
    missingUsageEvents: 1,
    orphanBillingEvents: 1,
    duplicateBillingEvents: 1,
    suspiciousBillingEvents: 2,
    status: 'discrepancies',
  });
  assert.equal(result.billing.checkAndDisbursementFeesCents, 300);
  assert.equal(result.billing.mortgageFeesCents, 150);
  assert.equal(result.billing.chargesCents, 450);
  assert.equal(result.billing.recordedPaymentsCents, 600);
  assert.equal(result.billing.collectedPaymentsCents, 400);
  assert.equal(result.billing.outstandingCents, null);
  assert.equal(result.billing.outstandingStatus, 'unavailable');
  assert.equal(result.billing.autoDebit.enabled, true);
  assert.equal(result.billing.paymentHistory.length, 3);
  const paymentTotalsQuery = client.queries.find(({ sql }) => /AS recorded_payments_cents/.test(sql));
  assert.deepEqual(paymentTotalsQuery.params, [
    TENANT_ID,
    '2026-10-01T00:00:00.000Z',
    '2026-11-01T00:00:00.000Z',
  ]);
  assert.equal(result.usage.checksReceived, 9);
  assert.equal(result.usage.remainingAllowance, 91);
  assert.equal(result.providers.moov[0].readiness, 'ready');
  assert.equal(result.providers.moovBankConnections.connected, 1);
  assert.equal(result.providers.checkAlt.readiness, 'configured');
  assert.equal(result.providers.checkAlt.enabled, true);
  assert.deepEqual(result.providers.providerErrors, {
    status: 'errors_recorded',
    moov: 1,
    checkAlt: 2,
    lastErrorAt: '2026-10-05T00:00:00Z',
  });
  assert.equal(result.operations.files.bytes, 4096);
  assert.equal(result.operations.signatures.open, 1);
  assert.equal(result.operations.disbursements.total, 5);
  assert.equal(result.auditHistory[0].action, 'other');
  assert.deepEqual(result.auditHistory[0].before, { name: 'Old Tenant', plan_tier: 'starter' });
  assert.deepEqual(result.auditHistory[0].after, { name: 'New Tenant', per_check_rate_cents: 300 });
  assert.equal(result.auditHistory[0].actorId, TENANT_ID);
  assert.equal(JSON.stringify(result).includes('123456'), false);
  assert.equal(JSON.stringify(result).includes('private'), false);
});

test('CheckAlt readiness fails closed when the persisted platform switch is disabled', async () => {
  const client = makeClient();
  const query = client.query.bind(client);
  client.query = async (sql, params = []) => {
    if (/public\.checkalt_tenant_accounts/.test(sql)) {
      client.queries.push({ sql, params });
      return { rows: [{ enabled: true, registered_at: '2026-09-01T00:00:00Z', platform_enabled: false }] };
    }
    return query(sql, params);
  };
  const result = await runTenantManagementV2({
    client,
    tenantId: TENANT_ID,
    period: { start: '2026-10-01T00:00:00.000Z', end: '2026-11-01T00:00:00.000Z' },
  });
  assert.equal(result.ok, true);
  assert.equal(result.providers.checkAlt.enabled, false);
  assert.equal(result.providers.checkAlt.tenantEnabled, true);
  assert.equal(result.providers.checkAlt.platformEnabled, false);
  assert.equal(result.providers.checkAlt.readiness, 'disabled');
});

test('marks storage bytes unavailable when source metadata has unknown sizes', async () => {
  const client = makeClient();
  client.query = async function query(sql, params = []) {
    this.queries.push({ sql, params });
    if (/SELECT public\.is_platform_owner/.test(sql)) return { rows: [{ is_platform_owner: true }] };
    if (/FROM public\.tenants t/.test(sql)) return { rows: [tenant] };
    if (/AS checks_total/.test(sql)) {
      return { rows: [queryRows(sql)[0] && { ...queryRows(sql)[0], unknown_file_sizes: 1 }] };
    }
    return { rows: queryRows(sql) };
  };
  const result = await runTenantManagementV2({
    client,
    tenantId: TENANT_ID,
    period: { start: '2026-10-01T00:00:00.000Z', end: '2026-11-01T00:00:00.000Z' },
  });
  assert.equal(result.operations.files.bytes, null);
  assert.equal(result.operations.files.unknownSizeCount, 1);
});

test('Class A route exposes a GET-only read endpoint and no provider client is used', async () => {
  const get = await handleAppServiceRequest(
    { queryStringParameters: {} },
    '/functions/v1/tenant-management-v2',
    'GET',
  );
  const post = await handleAppServiceRequest(
    { queryStringParameters: { tenant_id: TENANT_ID } },
    '/functions/v1/tenant-management-v2',
    'POST',
  );
  assert.equal(get.statusCode, 400);
  assert.equal(post.statusCode, 405);

  const source = fs.readFileSync(
    new URL('../functions/api/tenant-management-v2.mjs', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(source, /from ['"][^'"]*(?:moov|checkalt)/i);
  assert.doesNotMatch(source, /\bfetch\s*\(/i);
  assert.doesNotMatch(source, /\bnew\s+(?:Moov|CheckAlt)/i);
});

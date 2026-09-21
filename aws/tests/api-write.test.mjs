import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handler } from '../functions/api/index.mjs';
import { LOOKUP_MAPPING_SQL } from '../functions/api/identity.mjs';
import { handleWrite } from '../functions/api/write.mjs';
import {
  CLIENT_IDENTITY_KEYS,
  denyTableReason,
  pickAllowlistedValues,
  WRITE_ALLOWLIST,
} from '../functions/api/write-allowlist.mjs';

const APP_ID = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';
const COGNITO_SUB = 'c4386408-60e1-70e2-abb6-e6194e8e635f';
const SPOOF_ID = '00000000-0000-0000-0000-000000000099';
const CHECK_ID = '8d2b1c3e-4f5a-4678-9abc-def012345678';

const jwtEvent = (path, method, body, extra = {}) => ({
  rawPath: path,
  headers: {
    authorization: 'Bearer test-id-token',
    'x-user-id': SPOOF_ID,
    'x-tenant-id': 'spoof-tenant',
    'x-role': 'admin',
    ...(extra.headers || {}),
  },
  queryStringParameters: { user_id: SPOOF_ID, tenant_id: 'spoof-tenant', ...(extra.query || {}) },
  body: body ? JSON.stringify(body) : undefined,
  requestContext: {
    stage: 'staging',
    http: { method, path },
    authorizer: { jwt: { claims: { sub: extra.sub || COGNITO_SUB, email: 'checksops-tester@freedomadj.com', token_use: 'id' } } },
  },
});

const mappingFor = (sub = COGNITO_SUB) => ({
  application_user_id: APP_ID,
  cognito_sub: sub,
  email: 'checksops-tester@freedomadj.com',
  status: 'active',
});

const mockClient = ({ rows = [], mapping = mappingFor(), throwOn = null } = {}) => {
  const queries = [];
  return {
    queries,
    connect: async () => {},
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (throwOn && String(sql).includes(throwOn)) {
        const error = new Error('synthetic write failure');
        error.code = '40001';
        throw error;
      }
      if (sql === 'BEGIN' || sql === 'ROLLBACK' || sql === 'COMMIT' || sql === 'SET TRANSACTION READ WRITE') {
        return { rows: [] };
      }
      if (sql.startsWith('SELECT set_config')) return { rows: [{ set_config: params[1] }] };
      if (sql === LOOKUP_MAPPING_SQL) {
        return { rows: params[0] === mapping.cognito_sub ? [mapping] : [] };
      }
      if (/SELECT id, tenant_id FROM public.check_intake_items/.test(sql)) {
        return { rows: [{ id: params[0], tenant_id: '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a' }] };
      }
      if (/FROM public.check_payees p/.test(sql)) {
        return {
          rows: [{
            id: params[0],
            check_id: CHECK_ID,
            payee_tenant_id: '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a',
            tenant_id: '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a',
          }],
        };
      }
      if (/FROM public.check_endorsements e/.test(sql)) {
        return {
          rows: [{
            id: params[0],
            check_id: CHECK_ID,
            endorsement_tenant_id: '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a',
            tenant_id: '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a',
          }],
        };
      }
      if (/FROM public.check_files f/.test(sql) || /FROM public.claim_checks cc/.test(sql)) {
        return {
          rows: [{
            id: params[0],
            check_intake_item_id: CHECK_ID,
            tenant_id: '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a',
          }],
        };
      }
      return { rows };
    },
    end: async () => {},
  };
};

const depsFor = (client) => ({
  forceEnabled: true,
  loadDatabaseCredentials: async () => ({
    username: 'checksops',
    password: 'unit-test-only-not-a-real-secret',
    host: 'db.example.internal',
    database: 'checksops',
  }),
  createClient: (config) => {
    client.lastConfig = config;
    return client;
  },
});

test('allowlist rejects financial tables and unknown columns; ignores spoof identity keys', () => {
  assert.equal(denyTableReason('claim_payments'), 'financial_or_provider');
  assert.equal(denyTableReason('check_intake_items'), null);
  assert.equal(WRITE_ALLOWLIST.check_intake_items.ops.has('insert'), false);
  assert.equal(denyTableReason('moov_unknown'), 'unknown_table');
  const financialIntake = pickAllowlistedValues('check_intake_items', {
    carrier_name: 'Test',
    amount: 12,
    routing_number: '123456789',
  });
  assert.equal(financialIntake.error, 'column_not_allowlisted');
  assert.ok(financialIntake.columns.includes('amount'));
  assert.ok(financialIntake.columns.includes('routing_number'));
  assert.equal(WRITE_ALLOWLIST.check_message_reads.ops.has('upsert'), true);
  const picked = pickAllowlistedValues('check_message_reads', {
    user_id: SPOOF_ID,
    tenant_id: 'spoof-tenant',
    check_id: CHECK_ID,
    last_read_at: '2026-09-02T00:00:00.000Z',
    amount: 12,
  });
  assert.equal(picked.error, 'column_not_allowlisted');
  assert.deepEqual(picked.columns, ['amount']);
  const ok = pickAllowlistedValues('notification_preferences', {
    user_id: SPOOF_ID,
    in_app_enabled: false,
    email_enabled: true,
    sms_enabled: false,
  });
  assert.equal(ok.error, undefined);
  assert.equal(ok.values.user_id, undefined);
  assert.equal(ok.ignored.includes('user_id'), true);
  assert.equal(CLIENT_IDENTITY_KEYS.has('tenant_id'), true);
  assert.equal(WRITE_ALLOWLIST.financial_stepup_log.ops.has('insert'), true);
  assert.equal(WRITE_ALLOWLIST.financial_stepup_log.ops.has('update'), false);
  const stepup = pickAllowlistedValues('financial_stepup_log', {
    user_id: SPOOF_ID,
    tenant_id: APP_ID,
    action_key: 'disburse',
    factor_type: 'totp',
    succeeded: true,
    amount: 12,
  });
  assert.equal(stepup.error, 'column_not_allowlisted');
  assert.deepEqual(stepup.columns, ['amount']);
  const stepupOk = pickAllowlistedValues('financial_stepup_log', {
    user_id: SPOOF_ID,
    tenant_id: APP_ID,
    action_key: 'disburse',
    factor_type: 'totp',
    succeeded: true,
  });
  assert.equal(stepupOk.error, undefined);
  assert.equal(stepupOk.values.user_id, undefined);
  assert.equal(stepupOk.values.action_key, 'disburse');
  assert.equal(stepupOk.values.tenant_id, APP_ID);
});

test('check_intake_items allowlist permits endorsement render pointers and override metadata', () => {
  const picked = pickAllowlistedValues('check_intake_items', {
    back_image_original_path: 'checks/reupload/aa148d55-25be-4c3f-9fdd-833ba143593e/back.jpg',
    back_image_deposit_path: 'checks/reupload/aa148d55-25be-4c3f-9fdd-833ba143593e/endorsed_deposit_x.checkalt.jpg',
    endorsement_render_status: 'completed',
    endorsement_render_meta: { renderer_version: 1, bytes: 123 },
    endorsement_override: { xPct: 0.5, yPct: 0.5, scale: 1, rotationDeg: 0, showPayToOrder: false },
  });
  assert.equal(picked.error, undefined, JSON.stringify(picked));
  assert.equal(picked.values.back_image_deposit_path.includes('endorsed_deposit'), true);
  assert.equal(picked.values.endorsement_render_status, 'completed');
});

test('POST /data/write upserts check_message_reads as mapped UUID and ignores spoofed ids', async () => {
  const client = mockClient({
    rows: [{ user_id: APP_ID, check_id: CHECK_ID, last_read_at: '2026-09-02T00:00:00.000Z' }],
  });
  const result = await handleWrite(jwtEvent('/data/write', 'POST', {
    table: 'check_message_reads',
    op: 'upsert',
    values: {
      user_id: SPOOF_ID,
      tenant_id: '4f172140-f57a-4744-8050-95f4f07b13b4',
      check_id: CHECK_ID,
      last_read_at: '2026-09-02T00:00:00.000Z',
    },
  }), depsFor(client));
  assert.equal(result.ok, true);
  assert.equal(result.applicationUserId, APP_ID);
  assert.notEqual(result.applicationUserId, result.cognitoSub);
  assert.equal(result.spoofFieldsIgnored.headerUserId, SPOOF_ID);
  const write = client.queries.find((q) => String(q.sql).includes('INSERT INTO public.check_message_reads'));
  assert.ok(write);
  assert.equal(write.params[0], APP_ID);
  assert.equal(write.params.includes(SPOOF_ID), false);
  assert.equal(client.queries.some((q) => q.sql === 'COMMIT'), true);
  assert.equal(client.queries.some((q) => q.sql === 'SET TRANSACTION READ WRITE'), true);
  assert.equal(Boolean(client.lastConfig?.options), false);
});

test('kill switch disables writes without using the write transaction', async () => {
  const previous = process.env.AWS_WRITES_ENABLED;
  process.env.AWS_WRITES_ENABLED = 'false';
  try {
    const client = mockClient();
    const result = await handleWrite(jwtEvent('/data/write', 'POST', {
      table: 'check_message_reads',
      op: 'upsert',
      values: { check_id: CHECK_ID },
    }), { ...depsFor(client), forceEnabled: false });
    assert.equal(result.statusCode, 403);
    assert.equal(result.error, 'writes_disabled');
    assert.equal(client.queries.some((q) => String(q.sql).includes('INSERT')), false);
    assert.equal(client.queries.some((q) => q.sql === 'COMMIT'), false);
  } finally {
    if (previous === undefined) delete process.env.AWS_WRITES_ENABLED;
    else process.env.AWS_WRITES_ENABLED = previous;
  }
});

test('unauthenticated write is 401; unapproved table/column/financial tables are 403', async () => {
  const unauth = await handler({
    rawPath: '/data/write',
    requestContext: { stage: 'staging', http: { method: 'POST', path: '/data/write' } },
    body: JSON.stringify({ table: 'check_message_reads', op: 'upsert', values: { check_id: CHECK_ID } }),
  });
  assert.equal(unauth.statusCode, 401);

  const client = mockClient();
  const unknown = await handleWrite(jwtEvent('/data/write', 'POST', {
    table: 'organizations',
    op: 'update',
    values: { name: 'x' },
  }), depsFor(client));
  assert.equal(unknown.statusCode, 403);
  assert.equal(unknown.error, 'table_not_allowlisted');

  const tenantBilling = await handleWrite(jwtEvent('/data/write', 'POST', {
    table: 'tenants',
    op: 'update',
    values: { checkalt_enabled: true },
    filters: [{ column: 'id', op: 'eq', value: '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a' }],
  }), depsFor(client));
  assert.equal(tenantBilling.statusCode, 403);
  assert.ok(
    tenantBilling.error === 'column_not_allowlisted'
      || tenantBilling.error === 'application_workflow_writes_disabled',
  );

  const financial = await handleWrite(jwtEvent('/data/write', 'POST', {
    table: 'disbursement_batches',
    op: 'insert',
    values: { amount: 1 },
  }), depsFor(client));
  assert.equal(financial.reason, 'financial_or_provider');

  const column = await handleWrite(jwtEvent('/data/write', 'POST', {
    table: 'notification_preferences',
    op: 'update',
    values: { webhook_url: 'https://evil.example' },
  }), depsFor(client));
  assert.equal(column.error, 'column_not_allowlisted');
});

test('generic /data mutating routes stay writes_disabled; get_or_create ignores p_user_id', async () => {
  const generic = await handler(jwtEvent('/data/claims', 'POST', { name: 'x' }));
  assert.equal(generic.statusCode, 403);
  assert.equal(JSON.parse(generic.body).error, 'writes_disabled');

  const client = mockClient({
    rows: [{ id: 'pref-1', user_id: APP_ID, in_app_enabled: true, email_enabled: true, sms_enabled: false }],
  });
  const result = await handleWrite(jwtEvent('/data/write', 'POST', {
    table: 'notification_preferences',
    op: 'get_or_create',
    args: { p_user_id: SPOOF_ID },
    values: { user_id: SPOOF_ID },
    maybeSingle: true,
  }), depsFor(client));
  assert.equal(result.ok, true);
  assert.equal(result.data.user_id, APP_ID);
  const select = client.queries.find((q) => String(q.sql).includes('FROM public.notification_preferences'));
  assert.equal(select.params[0], APP_ID);
});

test('write errors roll back and do not COMMIT', async () => {
  const client = mockClient({ throwOn: 'INSERT INTO public.check_message_reads' });
  const result = await handleWrite(jwtEvent('/data/write', 'POST', {
    table: 'check_message_reads',
    op: 'upsert',
    values: { check_id: CHECK_ID },
  }), depsFor(client));
  assert.equal(result.ok, false);
  assert.equal(client.queries.some((q) => q.sql === 'COMMIT'), false);
  assert.equal(client.queries.some((q) => q.sql === 'ROLLBACK'), true);
});

test('Cognito sub used as application UUID is refused', async () => {
  const client = mockClient({
    mapping: {
      application_user_id: COGNITO_SUB,
      cognito_sub: COGNITO_SUB,
      email: 'checksops-tester@freedomadj.com',
      status: 'active',
    },
  });
  const result = await handleWrite(jwtEvent('/data/write', 'POST', {
    table: 'check_message_reads',
    op: 'upsert',
    values: { check_id: CHECK_ID, user_id: COGNITO_SUB },
  }), depsFor(client));
  assert.equal(result.ok, false);
  assert.match(String(result.message || result.error), /application_user_id equals cognito_sub|data_query_failed/);
});

test('unmapped identity including ninth UUID cannot write', async () => {
  const client = mockClient();
  const result = await handleWrite(jwtEvent('/data/write', 'POST', {
    table: 'notification_preferences',
    op: 'update',
    values: { in_app_enabled: false },
  }, { sub: '00000000-0000-0000-0000-000000000009' }), depsFor(client));
  assert.equal(result.statusCode, 401);
  assert.equal(result.error, 'identity_not_linked');
  assert.equal(client.queries.some((q) => String(q.sql).includes('INSERT') || String(q.sql).includes('UPDATE')), false);
});

test('Tranche 2 updates descriptive check fields and ignores spoofed tenant/user', async () => {
  const client = mockClient({
    rows: [{ id: CHECK_ID, carrier_name: 'Safe Carrier', amount: 100 }],
  });
  const result = await handleWrite(jwtEvent('/data/write', 'POST', {
    table: 'check_intake_items',
    op: 'update',
    values: {
      carrier_name: 'Safe Carrier',
      user_id: SPOOF_ID,
      tenant_id: '4f172140-f57a-4744-8050-95f4f07b13b4',
    },
    filters: [{ column: 'id', op: 'eq', value: CHECK_ID }],
  }), depsFor(client));
  assert.equal(result.ok, true);
  const update = client.queries.find((q) => String(q.sql).includes('UPDATE public.check_intake_items'));
  assert.ok(update);
  assert.equal(update.params.includes(SPOOF_ID), false);
  assert.equal(String(update.sql).includes('amount'), false);
});

test('Tranche 2 denies financial intake columns, status, insert, and endorsement signed status', async () => {
  const client = mockClient();
  const amount = await handleWrite(jwtEvent('/data/write', 'POST', {
    table: 'check_intake_items',
    op: 'update',
    values: { amount: 50 },
    filters: [{ column: 'id', op: 'eq', value: CHECK_ID }],
  }), depsFor(client));
  assert.equal(amount.statusCode, 403);
  assert.equal(amount.error, 'column_not_allowlisted');

  const status = await handleWrite(jwtEvent('/data/write', 'POST', {
    table: 'check_intake_items',
    op: 'update',
    values: { status: 'deposited' },
    filters: [{ column: 'id', op: 'eq', value: CHECK_ID }],
  }), depsFor(client));
  assert.equal(status.error, 'column_not_allowlisted');

  const insert = await handleWrite(jwtEvent('/data/write', 'POST', {
    table: 'check_intake_items',
    op: 'insert',
    values: { carrier_name: 'x' },
  }), depsFor(client));
  assert.equal(insert.error, 'operation_not_allowlisted');

  const endorseStatus = await handleWrite(jwtEvent('/data/write', 'POST', {
    table: 'check_endorsements',
    op: 'update',
    values: { status: 'signed', signed_at: '2026-09-02T00:00:00.000Z' },
    filters: [{ column: 'id', op: 'eq', value: CHECK_ID }],
  }), depsFor(client));
  assert.equal(endorseStatus.statusCode, 403);
  assert.equal(endorseStatus.error, 'column_not_allowlisted');
  assert.ok(endorseStatus.columns.includes('status'));
});

test('Tranche 2 payee insert derives tenant from parent check and ignores client tenant', async () => {
  const client = mockClient({
    rows: [{ id: '11111111-1111-4111-8111-111111111111', payee_name: 'Pat Payee', check_id: CHECK_ID }],
  });
  const result = await handleWrite(jwtEvent('/data/write', 'POST', {
    table: 'check_payees',
    op: 'insert',
    values: {
      check_id: CHECK_ID,
      payee_name: 'Pat Payee',
      payee_type: 'insured',
      tenant_id: '4f172140-f57a-4744-8050-95f4f07b13b4',
      endorsement_status: 'signed',
      endorsed_at: '2026-09-02T00:00:00.000Z',
    },
  }), depsFor(client));
  assert.equal(result.ok, true);
  const insert = client.queries.find((q) => String(q.sql).includes('INSERT INTO public.check_payees'));
  assert.ok(insert);
  assert.equal(insert.params[0], CHECK_ID);
  assert.equal(insert.params[1], '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a');
  assert.equal(insert.params.includes('4f172140-f57a-4744-8050-95f4f07b13b4'), false);
  assert.equal(String(insert.sql).includes('endorsed_at'), false);
});

test('Tranche 2 audit insert forces actor_id to mapped UUID', async () => {
  const client = mockClient({
    rows: [{ id: '22222222-2222-4222-8222-222222222222', actor_id: APP_ID, check_id: CHECK_ID }],
  });
  const result = await handleWrite(jwtEvent('/data/write', 'POST', {
    table: 'check_audit_log',
    op: 'insert',
    values: {
      check_id: CHECK_ID,
      event_type: 'aws_tranche2_test',
      event_description: 'unit',
      actor_id: SPOOF_ID,
      tenant_id: '4f172140-f57a-4744-8050-95f4f07b13b4',
    },
  }), depsFor(client));
  assert.equal(result.ok, true);
  const insert = client.queries.find((q) => String(q.sql).includes('INSERT INTO public.check_audit_log'));
  assert.equal(insert.params[2], APP_ID);
  assert.equal(insert.params.includes(SPOOF_ID), false);
});

test('Tranche 2 flag disables check workflow without disabling Tranche 1', async () => {
  const previous = process.env.AWS_CHECK_WORKFLOW_WRITES_ENABLED;
  process.env.AWS_CHECK_WORKFLOW_WRITES_ENABLED = 'false';
  try {
    const client = mockClient();
    const deniedT2 = await handleWrite(jwtEvent('/data/write', 'POST', {
      table: 'check_intake_items',
      op: 'update',
      values: { carrier_name: 'x' },
      filters: [{ column: 'id', op: 'eq', value: CHECK_ID }],
    }), { ...depsFor(client), forceCheckWorkflow: false });
    assert.equal(deniedT2.statusCode, 403);
    assert.equal(deniedT2.error, 'check_workflow_writes_disabled');

    const t1 = await handleWrite(jwtEvent('/data/write', 'POST', {
      table: 'check_message_reads',
      op: 'upsert',
      values: { check_id: CHECK_ID },
    }), { ...depsFor(client), forceCheckWorkflow: false });
    assert.equal(t1.ok, true);
  } finally {
    if (previous === undefined) delete process.env.AWS_CHECK_WORKFLOW_WRITES_ENABLED;
    else process.env.AWS_CHECK_WORKFLOW_WRITES_ENABLED = previous;
  }
});

test('malformed check id is 400 and does not UPDATE', async () => {
  const client = mockClient();
  const result = await handleWrite(jwtEvent('/data/write', 'POST', {
    table: 'check_intake_items',
    op: 'update',
    values: { carrier_name: 'x' },
    filters: [{ column: 'id', op: 'eq', value: 'not-a-uuid' }],
  }), depsFor(client));
  assert.equal(result.statusCode, 400);
  assert.equal(result.error, 'invalid_uuid');
  assert.equal(client.queries.some((q) => String(q.sql).includes('UPDATE public.check_intake_items')), false);
});

test('Tranche 3 inserts check notes with mapped sender_id and ignores spoofed identity', async () => {
  const client = mockClient({
    rows: [{ id: '33333333-3333-4333-8333-333333333333', check_id: CHECK_ID, sender_id: APP_ID, body: 'AWS T3 TEST note' }],
  });
  const result = await handleWrite(jwtEvent('/data/write', 'POST', {
    table: 'check_messages',
    op: 'insert',
    values: {
      check_id: CHECK_ID,
      body: 'AWS T3 TEST note',
      sender_id: SPOOF_ID,
      user_id: SPOOF_ID,
      tenant_id: '4f172140-f57a-4744-8050-95f4b07b13b4',
    },
  }), depsFor(client));
  assert.equal(result.ok, true);
  const insert = client.queries.find((q) => String(q.sql).includes('INSERT INTO public.check_messages'));
  assert.ok(insert);
  assert.equal(insert.params[0], CHECK_ID);
  assert.equal(insert.params[1], APP_ID);
  assert.equal(insert.params.includes(SPOOF_ID), false);
});

test('Tranche 3 updates descriptive claim_checks and denies amount/deposit/endorsement_status', async () => {
  const client = mockClient({
    rows: [{ id: '44444444-4444-4444-8444-444444444444', carrier_name: 'Safe', check_intake_item_id: CHECK_ID }],
  });
  const ok = await handleWrite(jwtEvent('/data/write', 'POST', {
    table: 'claim_checks',
    op: 'update',
    values: { carrier_name: 'Safe', tenant_id: '4f172140-f57a-4744-8050-95f4f07b13b4' },
    filters: [{ column: 'id', op: 'eq', value: '44444444-4444-4444-8444-444444444444' }],
  }), depsFor(client));
  assert.equal(ok.ok, true);
  const amount = await handleWrite(jwtEvent('/data/write', 'POST', {
    table: 'claim_checks',
    op: 'update',
    values: { amount: 99 },
    filters: [{ column: 'id', op: 'eq', value: '44444444-4444-4444-8444-444444444444' }],
  }), depsFor(client));
  assert.equal(amount.statusCode, 403);
  assert.equal(amount.error, 'column_not_allowlisted');
  const deposit = await handleWrite(jwtEvent('/data/write', 'POST', {
    table: 'claim_checks',
    op: 'update',
    values: { deposit_status: 'deposited', endorsement_status: 'signed' },
    filters: [{ column: 'id', op: 'eq', value: '44444444-4444-4444-8444-444444444444' }],
  }), depsFor(client));
  assert.equal(deposit.error, 'column_not_allowlisted');
});

test('Tranche 3 check_files insert requires a check-scoped path and mapped uploaded_by', async () => {
  const client = mockClient({
    rows: [{ id: '55555555-5555-4555-8555-555555555555', file_path: `check-intake/${CHECK_ID}/files/a.pdf` }],
  });
  const result = await handleWrite(jwtEvent('/data/write', 'POST', {
    table: 'check_files',
    op: 'insert',
    values: {
      check_intake_item_id: CHECK_ID,
      file_name: 'aws-t3-test.pdf',
      file_path: `check-intake/${CHECK_ID}/files/a.pdf`,
      category: 'other',
      source: 'manual',
      uploaded_by: SPOOF_ID,
    },
  }), depsFor(client));
  assert.equal(result.ok, true);
  const insert = client.queries.find((q) => String(q.sql).includes('INSERT INTO public.check_files'));
  assert.equal(insert.params[insert.params.length - 1], APP_ID);

  const crossed = await handleWrite(jwtEvent('/data/write', 'POST', {
    table: 'check_files',
    op: 'insert',
    values: {
      check_intake_item_id: CHECK_ID,
      file_name: 'x.pdf',
      file_path: 'check-intake/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/files/x.pdf',
    },
  }), depsFor(client));
  assert.equal(crossed.statusCode, 403);
});

test('Tranche 3 intake image path must be scoped to the same check', async () => {
  const client = mockClient({ rows: [{ id: CHECK_ID, front_image_path: `checks/${CHECK_ID}/front.jpg` }] });
  const ok = await handleWrite(jwtEvent('/data/write', 'POST', {
    table: 'check_intake_items',
    op: 'update',
    values: { front_image_path: `checks/${CHECK_ID}/front.jpg` },
    filters: [{ column: 'id', op: 'eq', value: CHECK_ID }],
  }), depsFor(client));
  assert.equal(ok.ok, true);

  const denied = await handleWrite(jwtEvent('/data/write', 'POST', {
    table: 'check_intake_items',
    op: 'update',
    values: { front_image_path: 'checks/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/front.jpg' },
    filters: [{ column: 'id', op: 'eq', value: CHECK_ID }],
  }), depsFor(client));
  assert.equal(denied.statusCode, 403);
});


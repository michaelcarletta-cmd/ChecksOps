import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handler } from '../functions/api/index.mjs';
import { LOOKUP_MAPPING_SQL } from '../functions/api/identity.mjs';
import { buildRejectedWriteLog, handleWrite } from '../functions/api/write.mjs';
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
      if (/SELECT id, tenant_id(?:, deposited_at, payee_line, claim_id)?\s+FROM public\.check_intake_items/.test(sql)) {
        return { rows: [{ id: params[0], tenant_id: '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a', deposited_at: null, payee_line: null, claim_id: null }] };
      }
      if (/review_save_detected_claim_number/.test(sql)) {
        return {
          rows: [{
            result: {
              ok: true,
              persisted: true,
              code: 'written',
              detected_claim_number: params[2],
            },
          }],
        };
      }
      if (/SELECT \* FROM public.check_intake_items WHERE id =/.test(sql)) {
        return {
          rows: [{
            id: params[0],
            tenant_id: '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a',
            detected_claim_number: '003779807',
            claim_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            carrier_name: 'USAA',
            amount: 18893.07,
          }],
        };
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
    pa_fee_amount: 12,
    status: 'deposited',
  });
  assert.equal(financialIntake.error, 'column_not_allowlisted');
  assert.ok(financialIntake.columns.includes('pa_fee_amount'));
  assert.ok(financialIntake.columns.includes('status'));
  // Amount, routing and account are allowlisted; write-check-workflow limits them to Review.
  for (const column of ['amount', 'routing_number', 'account_number']) {
    assert.equal(WRITE_ALLOWLIST.check_intake_items.columns.has(column), true, column);
  }
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
  // Step-up rows are written only by the server (insertAppStepUpLog), never via /data/write.
  assert.equal(WRITE_ALLOWLIST.financial_stepup_log, undefined);
  const stepup = pickAllowlistedValues('financial_stepup_log', {
    user_id: SPOOF_ID,
    tenant_id: APP_ID,
    action_key: 'wallet.fund',
    factor_type: 'totp',
    succeeded: true,
    metadata: { source: 'app_financial_totp', login_session: 'forged' },
  });
  assert.equal(stepup.error, 'table_not_allowlisted');
});

test('POST /data/write cannot insert a financial_stepup_log row (no forged step-up)', async () => {
  const client = mockClient();
  const result = await handleWrite(jwtEvent('/data/write', 'POST', {
    table: 'financial_stepup_log',
    op: 'insert',
    values: {
      tenant_id: APP_ID,
      action_key: 'wallet.fund',
      factor_type: 'totp',
      succeeded: true,
      metadata: { source: 'app_financial_totp', login_session: 'forged' },
    },
  }), depsFor(client));
  assert.equal(result.statusCode, 403);
  assert.equal(result.error, 'table_not_allowlisted');
  assert.equal(client.queries.some((q) => /financial_stepup_log/.test(String(q.sql))), false);
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

test('POST /data/write updates check_intake_items endorsement render fields', async () => {
  const client = mockClient({
    rows: [{
      id: CHECK_ID,
      tenant_id: '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a',
      endorsement_render_status: 'completed',
      back_image_deposit_path: `check-intake/${CHECK_ID}/files/endorsed_deposit_x.checkalt.jpg`,
    }],
  });
  const result = await handleWrite(jwtEvent('/data/write', 'POST', {
    table: 'check_intake_items',
    op: 'update',
    values: {
      endorsement_override: { xPct: 0.5, yPct: 0.5, scale: 1, rotationDeg: 0, showPayToOrder: false },
      endorsement_render_status: 'completed',
      endorsement_render_meta: { renderer_version: 'test', bytes: 123 },
      back_image_deposit_path: `check-intake/${CHECK_ID}/files/endorsed_deposit_x.checkalt.jpg`,
    },
    filters: [{ column: 'id', op: 'eq', value: CHECK_ID }],
    single: true,
  }), depsFor(client));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.statusCode, 200);
  assert.equal(result.data?.id, CHECK_ID);
  const update = client.queries.find((q) => String(q.sql).startsWith('UPDATE public.check_intake_items'));
  assert.ok(update);
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

  const settlement = await handler(jwtEvent('/data/claim_settlements', 'POST', {
    claim_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    amount: 100,
  }));
  assert.equal(settlement.statusCode, 403);
  assert.equal(JSON.parse(settlement.body).error, 'writes_disabled');

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

test('amount, routing and account change only while the check is in Review', async () => {
  // The mock returns no row from the guarded UPDATE: the check is past Review.
  const blocked = mockClient();
  for (const values of [{ amount: 50 }, { routing_number: '111000025' }, { account_number: '111000025' }]) {
    const result = await handleWrite(jwtEvent('/data/write', 'POST', {
      table: 'check_intake_items',
      op: 'update',
      values,
      filters: [{ column: 'id', op: 'eq', value: CHECK_ID }],
    }), depsFor(blocked));
    assert.equal(result.statusCode, 409, JSON.stringify(values));
    assert.equal(result.error, 'financial_edit_requires_review');
    assert.match(result.message, /back to Review/);
  }
  const update = blocked.queries.find((q) => /UPDATE public.check_intake_items/.test(String(q.sql)));
  assert.match(String(update.sql), /AND check_stage::text = \$\d+::text/);
  assert.doesNotMatch(String(update.sql), /status = ANY/);
  assert.equal(update.params.at(-1), 'review');

  // In Review the guarded UPDATE returns the row and the values are normalized.
  const inReview = mockClient({ rows: [{ id: CHECK_ID, amount: 1250.5 }] });
  const saved = await handleWrite(jwtEvent('/data/write', 'POST', {
    table: 'check_intake_items',
    op: 'update',
    values: { amount: 1250.5, routing_number: '021000021', account_number: '123456789' },
    filters: [{ column: 'id', op: 'eq', value: CHECK_ID }],
  }), depsFor(inReview));
  assert.equal(saved.ok, true, JSON.stringify(saved));
  const savedUpdate = inReview.queries.find((q) => /UPDATE public.check_intake_items/.test(String(q.sql)));
  assert.match(String(savedUpdate.sql), /amount = \$\d+::numeric/);
  assert.ok(savedUpdate.params.includes('1250.50'));
  assert.ok(savedUpdate.params.includes('021000021'));

  // Typical two-decimal amounts are not exact in IEEE floats (19.99 * 100 !== 1999).
  for (const [amount, stored] of [[19.99, '19.99'], [10.1, '10.10'], ['10.10', '10.10']]) {
    const centsClient = mockClient({ rows: [{ id: CHECK_ID }] });
    const centsSaved = await handleWrite(jwtEvent('/data/write', 'POST', {
      table: 'check_intake_items',
      op: 'update',
      values: { amount },
      filters: [{ column: 'id', op: 'eq', value: CHECK_ID }],
    }), depsFor(centsClient));
    assert.equal(centsSaved.ok, true, JSON.stringify({ amount, centsSaved }));
    const centsUpdate = centsClient.queries.find((q) => /UPDATE public.check_intake_items/.test(String(q.sql)));
    assert.ok(centsUpdate.params.includes(stored), String(amount));
  }

  // Descriptive edits carry no status guard, so endorsing can still edit them.
  const descriptive = mockClient({ rows: [{ id: CHECK_ID }] });
  await handleWrite(jwtEvent('/data/write', 'POST', {
    table: 'check_intake_items',
    op: 'update',
    values: { carrier_name: 'Carrier', funds_type: 'insurance', property_address: '1 Main', expiration_days: 90 },
    filters: [{ column: 'id', op: 'eq', value: CHECK_ID }],
  }), depsFor(descriptive));
  const descUpdate = descriptive.queries.find((q) => /UPDATE public.check_intake_items/.test(String(q.sql)));
  assert.doesNotMatch(String(descUpdate.sql), /check_stage/);
});

test('financial intake values are validated', async () => {
  const client = mockClient({ rows: [{ id: CHECK_ID }] });
  for (const values of [
    { amount: -1 }, { amount: 50_000_001 }, { amount: 'abc' }, { amount: 10.123 },
    { routing_number: '12345678' }, { routing_number: '12345678a' },
    { account_number: '123' }, { account_number: '1'.repeat(21) },
  ]) {
    const result = await handleWrite(jwtEvent('/data/write', 'POST', {
      table: 'check_intake_items',
      op: 'update',
      values,
      filters: [{ column: 'id', op: 'eq', value: CHECK_ID }],
    }), depsFor(client));
    assert.equal(result.statusCode, 400, JSON.stringify(values));
    assert.equal(result.error, 'invalid_field');
  }
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
    values: { pa_fee_amount: 50 },
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

test('authorized claim_number update keeps UUID and tenant; extras and inserts stay denied', async () => {
  const claimId = '8ff57eaf-f200-4466-a1cf-2debb56c88a8';
  const tenantId = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
  const snapshot = {
    id: claimId,
    org_id: tenantId,
    claim_number: 'CLM-OLD',
    status: 'tracking',
    policyholder_name: 'Jane Doe',
    insurance_company: 'Acme',
  };
  const queries = [];
  const client = mockClient();
  const originalQuery = client.query.bind(client);
  client.query = async (sql, params) => {
    queries.push({ sql, params });
    if (/FROM public.claims WHERE id = \$1::uuid LIMIT 1/.test(sql)) {
      return { rows: [snapshot] };
    }
    if (/FROM public.tenant_users WHERE user_id = \$1::uuid AND tenant_id = \$2::uuid LIMIT 1/.test(sql)) {
      return { rows: params[1] === tenantId ? [{ ok: 1 }] : [] };
    }
    if (/UPDATE public.claims/.test(sql)) {
      return { rows: [{ ...snapshot, claim_number: params[1] }] };
    }
    return originalQuery(sql, params);
  };

  const ok = await handleWrite(jwtEvent('/data/write', 'POST', {
    table: 'claims',
    op: 'update',
    values: { claim_number: 'CLM-NEW' },
    filters: [{ column: 'id', op: 'eq', value: claimId }],
    single: true,
  }), { ...depsFor(client), forceWorkflow: true });
  assert.equal(ok.ok, true);
  assert.equal(ok.data.id, claimId);
  assert.equal(ok.data.claim_number, 'CLM-NEW');
  assert.equal(ok.data.org_id, tenantId);
  assert.equal(ok.data.status, 'tracking');
  assert.equal(ok.data.policyholder_name, 'Jane Doe');

  const extra = await handleWrite(jwtEvent('/data/write', 'POST', {
    table: 'claims',
    op: 'update',
    values: { claim_number: 'CLM-NEW', policyholder_name: 'rewritten', amount: 1 },
    filters: [{ column: 'id', op: 'eq', value: claimId }],
  }), { ...depsFor(client), forceWorkflow: true });
  assert.equal(extra.statusCode, 403);
  assert.equal(extra.error, 'column_not_allowlisted');

  const created = await handleWrite(jwtEvent('/data/write', 'POST', {
    table: 'claims',
    op: 'insert',
    values: { claim_number: 'CLM-BRAND-NEW' },
  }), { ...depsFor(client), forceWorkflow: true });
  assert.equal(created.statusCode, 403);
  assert.equal(created.error, 'operation_not_allowlisted');
});

test('staging write-reject diagnostics omit values, tokens, and PII', () => {
  const row = buildRejectedWriteLog({
    event: {
      requestContext: { requestId: 'req-pr532-diag' },
      headers: { authorization: 'Bearer SUPER-SECRET-TOKEN', cookie: 'sid=abc' },
    },
    mapping: { application_user_id: APP_ID },
    claims: { sub: COGNITO_SUB },
    body: {
      table: 'claims',
      op: 'insert',
      values: {
        claim_number: 'SECRET-CLAIM-NUMBER',
        status: 'tracking',
        org_id: '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a',
      },
      filters: [{ column: 'id', op: 'eq', value: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }],
    },
    reason: 'operation_not_allowlisted',
    statusCode: 403,
  });
  const serialized = JSON.stringify(row);
  assert.equal(row.event, 'write_rejected');
  assert.equal(row.table, 'claims');
  assert.equal(row.op, 'insert');
  assert.deepEqual(row.valueColumns, ['claim_number', 'status', 'org_id']);
  assert.deepEqual(row.filterColumns, ['id']);
  assert.equal(row.reason, 'operation_not_allowlisted');
  assert.equal(row.requestId, 'req-pr532-diag');
  assert.equal(row.applicationUserId, APP_ID);
  assert.equal(row.cognitoSub, COGNITO_SUB);
  assert.equal(serialized.includes('SECRET-CLAIM-NUMBER'), false);
  assert.equal(serialized.includes('SUPER-SECRET-TOKEN'), false);
  assert.equal(serialized.includes('sid=abc'), false);
  assert.equal(serialized.includes('Bearer'), false);
  assert.equal(serialized.includes('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), false);
});

test('Review claim # save uses RPC and does not allowlist the column or amount', async () => {
  assert.equal(WRITE_ALLOWLIST.check_intake_items.columns.has('detected_claim_number'), false);
  assert.equal(WRITE_ALLOWLIST.check_intake_items.columns.has('claim_id'), false);
  const stillDenied = pickAllowlistedValues('check_intake_items', { detected_claim_number: '003779807' });
  assert.equal(stillDenied.error, 'column_not_allowlisted');
  assert.deepEqual(stillDenied.columns, ['detected_claim_number']);

  const client = mockClient();
  const saved = await handleWrite(jwtEvent('/data/write', 'POST', {
    table: 'check_intake_items',
    op: 'update',
    values: { detected_claim_number: '003779807' },
    filters: [{ column: 'id', op: 'eq', value: CHECK_ID }],
  }), depsFor(client));
  assert.equal(saved.ok, true);
  assert.equal(saved.data?.[0]?.detected_claim_number, '003779807');
  assert.equal(saved.data?.[0]?.claim_id, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  const rpc = client.queries.find((q) => String(q.sql).includes('review_save_detected_claim_number'));
  assert.ok(rpc);
  assert.equal(rpc.params[0], CHECK_ID);
  assert.equal(rpc.params[2], '003779807');
  assert.equal(client.queries.some((q) => /UPDATE public.check_intake_items\s+SET/.test(String(q.sql))), false);
  assert.equal(client.queries.some((q) => /INSERT INTO public\.claims/.test(String(q.sql))), false);
  assert.equal(client.queries.some((q) => /UPDATE public\.claims/.test(String(q.sql))), false);

  const amountWithClaimNumber = await handleWrite(jwtEvent('/data/write', 'POST', {
    table: 'check_intake_items',
    op: 'update',
    values: { amount: 50, detected_claim_number: '003779807' },
    filters: [{ column: 'id', op: 'eq', value: CHECK_ID }],
  }), depsFor(client));
  // The claim number goes through its RPC; the amount now meets the Review-only
  // guard (the mock check is past Review), and claims are still never written.
  assert.equal(amountWithClaimNumber.statusCode, 409);
  assert.equal(amountWithClaimNumber.error, 'financial_edit_requires_review');
  assert.equal(client.queries.some((q) => /INSERT INTO public\.claims|UPDATE public\.claims/.test(String(q.sql))), false);
});

test('Review claim # save denies invalid, missing, and cross-tenant checks without writing claims', async () => {
  const invalid = await handleWrite(jwtEvent('/data/write', 'POST', {
    table: 'check_intake_items',
    op: 'update',
    values: { detected_claim_number: '003779807' },
    filters: [{ column: 'id', op: 'eq', value: 'not-a-uuid' }],
  }), depsFor(mockClient()));
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.error, 'invalid_uuid');

  const missingClient = mockClient();
  const originalMissing = missingClient.query.bind(missingClient);
  missingClient.query = async (sql, params) => {
    if (/SELECT id, tenant_id(?:, deposited_at, payee_line, claim_id)?\s+FROM public\.check_intake_items/.test(sql)) return { rows: [] };
    return originalMissing(sql, params);
  };
  const missing = await handleWrite(jwtEvent('/data/write', 'POST', {
    table: 'check_intake_items',
    op: 'update',
    values: { detected_claim_number: '003779807' },
    filters: [{ column: 'id', op: 'eq', value: CHECK_ID }],
  }), depsFor(missingClient));
  assert.equal(missing.statusCode, 403);
  assert.equal(missing.error, 'rls_denied');
  assert.equal(missingClient.queries.some((q) => String(q.sql).includes('review_save_detected_claim_number')), false);

  const mismatchClient = mockClient();
  const originalMismatch = mismatchClient.query.bind(mismatchClient);
  mismatchClient.query = async (sql, params) => {
    if (/review_save_detected_claim_number/.test(sql)) {
      return { rows: [{ result: { ok: false, persisted: false, code: 'tenant_mismatch' } }] };
    }
    return originalMismatch(sql, params);
  };
  const mismatch = await handleWrite(jwtEvent('/data/write', 'POST', {
    table: 'check_intake_items',
    op: 'update',
    values: { detected_claim_number: 'OTHER-TENANT' },
    filters: [{ column: 'id', op: 'eq', value: CHECK_ID }],
  }), depsFor(mismatchClient));
  assert.equal(mismatch.statusCode, 403);
  assert.equal(mismatch.error, 'tenant_mismatch');
  assert.equal(mismatchClient.queries.some((q) => /INSERT INTO public\.claims/.test(String(q.sql))), false);
});

test('unrelated intake writes still use the generic allowlisted UPDATE', async () => {
  const client = mockClient({
    rows: [{ id: CHECK_ID, carrier_name: 'Safe Carrier', amount: 100, claim_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }],
  });
  const result = await handleWrite(jwtEvent('/data/write', 'POST', {
    table: 'check_intake_items',
    op: 'update',
    values: { carrier_name: 'Safe Carrier' },
    filters: [{ column: 'id', op: 'eq', value: CHECK_ID }],
  }), depsFor(client));
  assert.equal(result.ok, true);
  assert.equal(result.data?.[0]?.carrier_name, 'Safe Carrier');
  assert.equal(client.queries.some((q) => String(q.sql).includes('review_save_detected_claim_number')), false);
  const update = client.queries.find((q) => /UPDATE public.check_intake_items\s+SET/.test(String(q.sql)));
  assert.ok(update);
  assert.equal(String(update.sql).includes('detected_claim_number'), false);
  assert.equal(String(update.sql).includes('claim_id'), false);
});

const OWN_TENANT = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const OTHER_TENANT = '4f172140-f57a-4744-8050-95f4f07b13b4';
const ACCOUNT_ID = '5a5a5a5a-5a5a-4a5a-8a5a-5a5a5a5a5a5a';
const LINK_ID = '6b6b6b6b-6b6b-4b6b-8b6b-6b6b6b6b6b6b';

/** mockClient plus check_stakeholders answers: own active accounts, membership/writability, existing links. */
const stakeholderClient = ({ member = false, canWrite = true, accounts = [ACCOUNT_ID], linked = false, deletable = true } = {}) => {
  const base = mockClient();
  const query = base.query;
  base.query = async (sql, params) => {
    const text = String(sql);
    if (text.includes('$1::uuid IN (SELECT public.aws_user_tenant_ids())') && text.includes('AS ok')) {
      base.queries.push({ sql, params });
      return { rows: [{ ok: (member || canWrite) && params[0] === OWN_TENANT }] };
    }
    if (text.includes('FROM public.stakeholder_accounts')) {
      base.queries.push({ sql, params });
      return { rows: accounts.includes(params[0]) && params[1] === OWN_TENANT ? [{ id: params[0] }] : [] };
    }
    if (text.includes('INSERT INTO public.check_stakeholders')) {
      base.queries.push({ sql, params });
      return { rows: linked ? [] : [{ id: LINK_ID, check_intake_item_id: params[0], stakeholder_account_id: params[1], tenant_id: params[2] }] };
    }
    if (text.includes('SELECT * FROM public.check_stakeholders')) {
      base.queries.push({ sql, params });
      return { rows: linked ? [{ id: LINK_ID, stakeholder_account_id: params[1], tenant_id: params[2] }] : [] };
    }
    if (text.includes('DELETE FROM public.check_stakeholders')) {
      base.queries.push({ sql, params });
      return { rows: deletable ? [{ id: params[0] }] : [] };
    }
    return query(sql, params);
  };
  return base;
};

const stakeholderWrite = (client, body) => handleWrite(jwtEvent('/data/write', 'POST', { table: 'check_stakeholders', ...body }), depsFor(client));

test('check_stakeholders insert links an own active account; tenant, added_via and added_by are server-derived', async () => {
  const client = stakeholderClient();
  const result = await stakeholderWrite(client, {
    op: 'insert',
    values: {
      check_intake_item_id: CHECK_ID,
      stakeholder_account_id: ACCOUNT_ID,
      tenant_id: OTHER_TENANT,
      added_via: 'partner_share',
      added_by: SPOOF_ID,
    },
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  const insert = client.queries.find((q) => String(q.sql).includes('INSERT INTO public.check_stakeholders'));
  assert.ok(insert);
  assert.deepEqual(insert.params, [CHECK_ID, ACCOUNT_ID, OWN_TENANT, APP_ID]);
  assert.match(String(insert.sql), /'manual'/);
  assert.doesNotMatch(String(insert.sql), /partner_tenant_id/);
});

test('check_stakeholders refuses partner fields, updates, another organization\'s account, and a non-writable check', async () => {
  const partner = await stakeholderWrite(stakeholderClient(), {
    op: 'insert',
    values: { check_intake_item_id: CHECK_ID, stakeholder_account_id: ACCOUNT_ID, partner_tenant_id: OTHER_TENANT },
  });
  assert.equal(partner.ok, false);
  assert.equal(partner.error, 'column_not_allowlisted');

  const update = await stakeholderWrite(stakeholderClient(), {
    op: 'update', values: { stakeholder_account_id: ACCOUNT_ID }, filters: [{ column: 'id', op: 'eq', value: LINK_ID }],
  });
  assert.equal(update.ok, false);
  assert.equal(update.error, 'operation_not_allowlisted');

  for (const [options, label] of [
    [{ accounts: [] }, 'account of another organization or inactive'],
    [{ canWrite: false }, 'check the caller cannot write (e.g. a partner viewing a shared check)'],
  ]) {
    const client = stakeholderClient(options);
    const result = await stakeholderWrite(client, {
      op: 'insert', values: { check_intake_item_id: CHECK_ID, stakeholder_account_id: ACCOUNT_ID },
    });
    assert.equal(result.ok, false, label);
    assert.equal(result.error, 'rls_denied', label);
    assert.equal(client.queries.some((q) => String(q.sql).includes('INSERT INTO public.check_stakeholders')), false, label);
  }

  const missing = await stakeholderWrite(stakeholderClient(), { op: 'insert', values: { check_intake_item_id: CHECK_ID } });
  assert.equal(missing.ok, false);
  assert.equal(missing.error, 'missing_required_field');
});

test('check_stakeholders insert of an existing link returns it instead of failing', async () => {
  const client = stakeholderClient({ linked: true });
  const result = await stakeholderWrite(client, {
    op: 'insert', values: { check_intake_item_id: CHECK_ID, stakeholder_account_id: ACCOUNT_ID },
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(client.queries.some((q) => String(q.sql).includes('SELECT * FROM public.check_stakeholders')));
});

test('check_stakeholders delete is by id only, on the owner\'s own check, and refuses other filters', async () => {
  const client = stakeholderClient();
  const result = await stakeholderWrite(client, { op: 'delete', filters: [{ column: 'id', op: 'eq', value: LINK_ID }] });
  assert.equal(result.ok, true, JSON.stringify(result));
  const del = client.queries.find((q) => String(q.sql).includes('DELETE FROM public.check_stakeholders'));
  assert.match(String(del.sql), /c\.tenant_id = cs\.tenant_id/);
  assert.match(String(del.sql), /\(cs\.tenant_id IN \(SELECT public\.aws_user_tenant_ids\(\)\) OR public\.aws_can_write_tenant\(cs\.tenant_id\)\)/);
  assert.deepEqual(del.params, [LINK_ID]);

  const denied = await stakeholderWrite(stakeholderClient({ deletable: false }), { op: 'delete', filters: [{ column: 'id', op: 'eq', value: LINK_ID }] });
  assert.equal(denied.ok, false);
  assert.equal(denied.error, 'rls_denied');

  const byAccount = await stakeholderWrite(stakeholderClient(), {
    op: 'delete', filters: [{ column: 'stakeholder_account_id', op: 'eq', value: ACCOUNT_ID }],
  });
  assert.equal(byAccount.ok, false);
  assert.equal(byAccount.error, 'column_not_allowlisted');

  const noId = await stakeholderWrite(stakeholderClient(), { op: 'delete', filters: [] });
  assert.equal(noId.ok, false);
  assert.equal(noId.error, 'invalid_uuid');
});

const PARTNER_TENANT = '7c1d2e3f-4a5b-4c6d-8e7f-901234567890';
const REMOVAL_ID = '7d7d7d7d-7d7d-4d7d-8d7d-7d7d7d7d7d7d';

/** mockClient plus check_partner_stakeholder_removals answers: membership/writability, live shares, existing removals. */
const partnerRemovalClient = ({ member = false, canWrite = true, shared = [PARTNER_TENANT], removed = false, deletable = true } = {}) => {
  const base = mockClient();
  const query = base.query;
  base.query = async (sql, params) => {
    const text = String(sql);
    if (text.includes('$1::uuid IN (SELECT public.aws_user_tenant_ids())') && text.includes('AS ok')) {
      base.queries.push({ sql, params });
      return { rows: [{ ok: (member || canWrite) && params[0] === OWN_TENANT }] };
    }
    if (text.includes('FROM public.shared_checks')) {
      base.queries.push({ sql, params });
      return { rows: params[0] === CHECK_ID && params[1] === OWN_TENANT && shared.includes(params[2]) ? [{ target_tenant_id: params[2] }] : [] };
    }
    if (text.includes('INSERT INTO public.check_partner_stakeholder_removals')) {
      base.queries.push({ sql, params });
      return { rows: removed ? [] : [{ id: REMOVAL_ID, check_intake_item_id: params[0], tenant_id: params[1], partner_tenant_id: params[2], removed_by: params[3] }] };
    }
    if (text.includes('SELECT * FROM public.check_partner_stakeholder_removals')) {
      base.queries.push({ sql, params });
      return { rows: removed ? [{ id: REMOVAL_ID, check_intake_item_id: params[0], tenant_id: params[1], partner_tenant_id: params[2] }] : [] };
    }
    if (text.includes('DELETE FROM public.check_partner_stakeholder_removals')) {
      base.queries.push({ sql, params });
      return { rows: deletable ? [{ id: REMOVAL_ID }] : [] };
    }
    return query(sql, params);
  };
  return base;
};

const partnerRemovalWrite = (client, body) => handleWrite(
  jwtEvent('/data/write', 'POST', { table: 'check_partner_stakeholder_removals', ...body }),
  depsFor(client),
);

test('check_partner_stakeholder_removals insert removes a shared partner; tenant and removed_by are server-derived', async () => {
  const client = partnerRemovalClient();
  const result = await partnerRemovalWrite(client, {
    op: 'insert',
    values: {
      check_intake_item_id: CHECK_ID,
      partner_tenant_id: PARTNER_TENANT,
      tenant_id: OTHER_TENANT,
      removed_by: SPOOF_ID,
      id: REMOVAL_ID,
      created_at: '2020-01-01T00:00:00Z',
    },
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  const share = client.queries.find((q) => String(q.sql).includes('FROM public.shared_checks'));
  assert.match(String(share.sql), /revoked_at IS NULL/);
  assert.deepEqual(share.params, [CHECK_ID, OWN_TENANT, PARTNER_TENANT]);
  const insert = client.queries.find((q) => String(q.sql).includes('INSERT INTO public.check_partner_stakeholder_removals'));
  assert.deepEqual(insert.params, [CHECK_ID, OWN_TENANT, PARTNER_TENANT, APP_ID]);
  assert.match(String(insert.sql), /ON CONFLICT \(check_intake_item_id, tenant_id, partner_tenant_id\) DO NOTHING/);
});

test('check_partner_stakeholder_removals refuses unshared partners, non-writable checks, updates and bad ids', async () => {
  const unshared = partnerRemovalClient({ shared: [] });
  const notShared = await partnerRemovalWrite(unshared, {
    op: 'insert', values: { check_intake_item_id: CHECK_ID, partner_tenant_id: PARTNER_TENANT },
  });
  assert.equal(notShared.ok, false);
  assert.equal(notShared.error, 'partner_not_shared');
  assert.equal(notShared.statusCode, 409);
  assert.equal(unshared.queries.some((q) => String(q.sql).includes('INSERT INTO public.check_partner_stakeholder_removals')), false);

  const readonly = partnerRemovalClient({ canWrite: false });
  const denied = await partnerRemovalWrite(readonly, {
    op: 'insert', values: { check_intake_item_id: CHECK_ID, partner_tenant_id: PARTNER_TENANT },
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.error, 'rls_denied');
  assert.equal(readonly.queries.some((q) => String(q.sql).includes('FROM public.shared_checks')), false);

  const update = await partnerRemovalWrite(partnerRemovalClient(), {
    op: 'update', values: { partner_tenant_id: PARTNER_TENANT }, filters: [{ column: 'id', op: 'eq', value: REMOVAL_ID }],
  });
  assert.equal(update.error, 'operation_not_allowlisted');

  const badPartner = await partnerRemovalWrite(partnerRemovalClient(), {
    op: 'insert', values: { check_intake_item_id: CHECK_ID, partner_tenant_id: 'nope' },
  });
  assert.equal(badPartner.error, 'invalid_uuid');
  assert.equal(badPartner.statusCode, 400);

  const missing = await partnerRemovalWrite(partnerRemovalClient(), { op: 'insert', values: { check_intake_item_id: CHECK_ID } });
  assert.equal(missing.error, 'missing_required_field');

  const extra = await partnerRemovalWrite(partnerRemovalClient(), {
    op: 'insert', values: { check_intake_item_id: CHECK_ID, partner_tenant_id: PARTNER_TENANT, stakeholder_account_id: ACCOUNT_ID },
  });
  assert.equal(extra.error, 'column_not_allowlisted');
});

test('check_partner_stakeholder_removals insert of an existing removal returns it', async () => {
  const client = partnerRemovalClient({ removed: true });
  const result = await partnerRemovalWrite(client, {
    op: 'insert', values: { check_intake_item_id: CHECK_ID, partner_tenant_id: PARTNER_TENANT },
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.data[0].id, REMOVAL_ID);
});

test('check_partner_stakeholder_removals delete by id or by check + partner, scoped to the check owner', async () => {
  const byId = partnerRemovalClient();
  let result = await partnerRemovalWrite(byId, { op: 'delete', filters: [{ column: 'id', op: 'eq', value: REMOVAL_ID }] });
  assert.equal(result.ok, true, JSON.stringify(result));
  let del = byId.queries.find((q) => String(q.sql).includes('DELETE FROM public.check_partner_stakeholder_removals'));
  assert.match(String(del.sql), /c\.tenant_id = r\.tenant_id/);
  assert.match(String(del.sql), /\(r\.tenant_id IN \(SELECT public\.aws_user_tenant_ids\(\)\) OR public\.aws_can_write_tenant\(r\.tenant_id\)\)/);
  assert.deepEqual(del.params, [REMOVAL_ID]);

  const byPair = partnerRemovalClient();
  result = await partnerRemovalWrite(byPair, {
    op: 'delete',
    filters: [
      { column: 'check_intake_item_id', op: 'eq', value: CHECK_ID },
      { column: 'partner_tenant_id', op: 'eq', value: PARTNER_TENANT },
    ],
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  del = byPair.queries.find((q) => String(q.sql).includes('DELETE FROM public.check_partner_stakeholder_removals'));
  assert.match(String(del.sql), /c\.tenant_id = r\.tenant_id/);
  assert.deepEqual(del.params, [CHECK_ID, PARTNER_TENANT]);

  const onlyCheck = await partnerRemovalWrite(partnerRemovalClient(), {
    op: 'delete', filters: [{ column: 'check_intake_item_id', op: 'eq', value: CHECK_ID }],
  });
  assert.equal(onlyCheck.error, 'invalid_uuid');

  const none = await partnerRemovalWrite(partnerRemovalClient(), { op: 'delete', filters: [] });
  assert.equal(none.error, 'invalid_uuid');

  const notFound = await partnerRemovalWrite(partnerRemovalClient({ deletable: false }), {
    op: 'delete', filters: [{ column: 'id', op: 'eq', value: REMOVAL_ID }],
  });
  assert.equal(notFound.error, 'rls_denied');

  const byTenant = await partnerRemovalWrite(partnerRemovalClient(), {
    op: 'delete', filters: [{ column: 'tenant_id', op: 'eq', value: OWN_TENANT }],
  });
  assert.equal(byTenant.ok, false);
});

test('check_stakeholders and partner removals: a plain member of the owner tenant may write; the gate is membership or writer', async () => {
  for (const [label, write, values, insertSql] of [
    ['check_stakeholders', stakeholderWrite, { check_intake_item_id: CHECK_ID, stakeholder_account_id: ACCOUNT_ID }, 'INSERT INTO public.check_stakeholders'],
    ['check_partner_stakeholder_removals', partnerRemovalWrite, { check_intake_item_id: CHECK_ID, partner_tenant_id: PARTNER_TENANT }, 'INSERT INTO public.check_partner_stakeholder_removals'],
  ]) {
    const factory = label === 'check_stakeholders' ? stakeholderClient : partnerRemovalClient;
    // Member of the owner tenant without an admin/staff role.
    const memberClient = factory({ member: true, canWrite: false });
    const allowed = await write(memberClient, { op: 'insert', values });
    assert.equal(allowed.ok, true, `${label}: ${JSON.stringify(allowed)}`);
    const gate = memberClient.queries.find((q) => String(q.sql).includes('AS ok'));
    assert.match(String(gate.sql), /\$1::uuid IN \(SELECT public\.aws_user_tenant_ids\(\)\)\s+OR public\.aws_can_write_tenant\(\$1::uuid\)/, label);
    assert.deepEqual(gate.params, [OWN_TENANT], label);
    // Neither a member of the owner tenant nor its writer (e.g. a partner the check is shared with).
    const outsider = factory({ member: false, canWrite: false });
    const refused = await write(outsider, { op: 'insert', values });
    assert.equal(refused.error, 'rls_denied', label);
    assert.equal(outsider.queries.some((q) => String(q.sql).includes(insertSql)), false, label);
  }
});

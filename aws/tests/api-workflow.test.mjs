import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handler } from '../functions/api/index.mjs';
import { LOOKUP_MAPPING_SQL, TENANT_MEMBERSHIP_SQL, USER_ROLES_SQL } from '../functions/api/identity.mjs';
import { handleCreateCheck, handleCheckTransition, handleWorkflowStatus } from '../functions/api/workflow.mjs';
import { handleWrite } from '../functions/api/write.mjs';
import {
  evaluateTransition,
  mapReviewPath,
  TRANSITIONS,
} from '../functions/api/workflow-transitions.mjs';
import { applicationWorkflowWritesEnabled } from '../functions/api/workflow-flags.mjs';
import { WRITE_ALLOWLIST } from '../functions/api/write-allowlist.mjs';

const APP_ID = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';
const COGNITO_SUB = 'c4386408-60e1-70e2-abb6-e6194e8e635f';
const SPOOF_ID = '00000000-0000-0000-0000-000000000099';
const FREEDOM_TENANT = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const C1C_TENANT = '4f172140-f57a-4744-8050-95f4f07b13b4';
const CHECK_ID = '8d2b1c3e-4f5a-4678-9abc-def012345678';

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
  body: body ? JSON.stringify(body) : undefined,
  requestContext: {
    stage: 'staging',
    http: { method, path },
    authorizer: extra.auth === null ? undefined : {
      jwt: { claims: { sub: extra.sub || COGNITO_SUB, email: 'checksops-tester@freedomadj.com', token_use: 'id' } },
    },
  },
});

const mappingFor = (sub = COGNITO_SUB) => ({
  application_user_id: APP_ID,
  cognito_sub: sub,
  email: 'checksops-tester@freedomadj.com',
  status: 'active',
});

const createdRow = {
  id: CHECK_ID,
  tenant_id: FREEDOM_TENANT,
  uploaded_by: APP_ID,
  status: 'uploaded',
  check_stage: 'review',
  claim_id: null,
  deposited_at: null,
  external_origin: null,
  amount: null,
  carrier_name: 'AWS T5 TEST',
};

const mockClient = ({
  mapping = mappingFor(),
  memberships = [{ tenant_id: FREEDOM_TENANT, role: 'admin', tenant_name: 'Freedom', tenant_slug: 'freedom' }],
  roles = [{ role: 'admin' }],
  check = createdRow,
  rows = [createdRow],
  payees,
  endorsements,
} = {}) => {
  const queries = [];
  const defaultPayees = payees || [{
    id: 'payee-ready-1',
    check_id: check?.id || CHECK_ID,
    tenant_id: check?.tenant_id || FREEDOM_TENANT,
    payee_type: 'insured',
    endorsement_status: 'signed',
    endorsed_at: '2026-01-01T00:00:00.000Z',
  }];
  const defaultEndorsements = endorsements || [{
    id: 'endo-ready-1',
    check_id: check?.id || CHECK_ID,
    tenant_id: check?.tenant_id || FREEDOM_TENANT,
    payee_id: defaultPayees[0]?.id,
    payee_type: 'insured',
    status: 'signed',
    signed_at: '2026-01-01T00:00:00.000Z',
  }];
  return {
    queries,
    connect: async () => {},
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (sql === 'BEGIN' || sql === 'ROLLBACK' || sql === 'COMMIT' || sql === 'SET TRANSACTION READ WRITE') {
        return { rows: [] };
      }
      if (sql.startsWith('SELECT set_config')) return { rows: [{ set_config: params[1] }] };
      if (sql === LOOKUP_MAPPING_SQL) {
        return { rows: params[0] === mapping.cognito_sub ? [mapping] : [] };
      }
      if (sql === TENANT_MEMBERSHIP_SQL) return { rows: memberships };
      if (sql === USER_ROLES_SQL) return { rows: roles };
      if (/SELECT role FROM public.tenant_users/.test(sql)) return { rows: memberships };
      if (/FROM public.check_payees/.test(sql)) return { rows: defaultPayees };
      if (/FROM public.check_endorsements/.test(sql)) return { rows: defaultEndorsements };
      if (/FROM public.check_intake_items/.test(sql) && /SELECT id, tenant_id, uploaded_by/.test(sql)) {
        return { rows: check ? [check] : [] };
      }
      if (/SELECT id, tenant_id FROM public.check_intake_items/.test(sql)) {
        return { rows: [{ id: params[0], tenant_id: FREEDOM_TENANT }] };
      }
      if (/INSERT INTO public.check_intake_items/.test(sql)) return { rows };
      if (/UPDATE public.check_intake_items/.test(sql)) {
        return { rows: [{ ...check, status: params?.[1] || check.status, check_stage: params?.[2] || check.check_stage }] };
      }
      if (/INSERT INTO public.check_audit_log/.test(sql)) return { rows: [{ id: 'audit' }] };
      if (/INSERT INTO public.mortgage_handling_requests/.test(sql)) {
        return { rows: [{ id: 'req-1', check_intake_item_id: params[1], requested_by: params[5] }] };
      }
      if (/INSERT INTO public.loss_draft_tracking/.test(sql)) {
        return { rows: [{ id: 'ld-1', check_intake_item_id: params[0] }] };
      }
      if (/FROM public.loss_draft_tracking d/.test(sql)) {
        return { rows: [{ id: params[0], check_intake_item_id: CHECK_ID, tenant_id: FREEDOM_TENANT }] };
      }
      return { rows };
    },
    end: async () => {},
  };
};

const depsFor = (client, extra = {}) => ({
  forceEnabled: true,
  forceWorkflow: true,
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
  ...extra,
});

test('state machine allows documented T5 transitions and denies skip / provider dest', () => {
  const check = { id: CHECK_ID, status: 'uploaded', claim_id: null };
  assert.equal(evaluateTransition('start_review', check).ok, true);
  assert.equal(evaluateTransition('mark_ready_for_deposit', check).error, 'invalid_transition');
  assert.equal(evaluateTransition('mark_deposited', check).error, 'financial_or_provider');
  assert.equal(evaluateTransition('start_review', { ...check, claim_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }).error, 'claim_linked_transition_denied');
  assert.equal(evaluateTransition('start_review', {
    ...check,
    external_origin: { source_app: 'freedom_crm', source_check_id: 'abc' },
  }).error, 'partner_linked_transition_denied');
  assert.equal(mapReviewPath('approved_for_deposit').action, 'mark_ready_for_deposit');
  assert.equal(mapReviewPath('branch_deposit_required').error, 'financial_or_provider');
  assert.equal(TRANSITIONS.mark_ready_for_deposit.providerExecution, false);
  assert.deepEqual(TRANSITIONS.mark_ready_for_deposit.requiredRecords, ['endorsement_complete']);
});

test('T5 flag defaults false and is independent of T1 writes', () => {
  const previous = process.env.AWS_APPLICATION_WORKFLOW_WRITES_ENABLED;
  delete process.env.AWS_APPLICATION_WORKFLOW_WRITES_ENABLED;
  try {
    assert.equal(applicationWorkflowWritesEnabled(), false);
    process.env.AWS_APPLICATION_WORKFLOW_WRITES_ENABLED = 'TRUE';
    assert.equal(applicationWorkflowWritesEnabled(), false);
    process.env.AWS_APPLICATION_WORKFLOW_WRITES_ENABLED = 'true';
    assert.equal(applicationWorkflowWritesEnabled(), true);
  } finally {
    if (previous === undefined) delete process.env.AWS_APPLICATION_WORKFLOW_WRITES_ENABLED;
    else process.env.AWS_APPLICATION_WORKFLOW_WRITES_ENABLED = previous;
  }
});

test('GET /workflow/status lists transitions and provider flags stay false', async () => {
  const result = await handler(jwtEvent('/workflow/status', 'GET'));
  const body = JSON.parse(result.body);
  assert.equal(result.statusCode, 200);
  assert.equal(body.ok, true);
  assert.equal(body.flags.AWS_PROVIDER_EXECUTION_ENABLED, false);
  assert.equal(body.flags.AWS_CHECKALT_ENABLED, false);
  assert.ok(body.transitions.some((row) => row.action === 'mark_ready_for_deposit'));
});

test('create check derives tenant and uploaded_by and ignores spoofed identity', async () => {
  const client = mockClient();
  const result = await handleCreateCheck(jwtEvent('/workflow/checks', 'POST', {
    tenant_id: C1C_TENANT,
    uploaded_by: SPOOF_ID,
    user_id: SPOOF_ID,
    carrier_name: 'AWS T5 TEST',
    claim_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    status: 'deposited',
  }), depsFor(client));
  assert.equal(result.ok, true);
  assert.equal(result.applicationUserId, APP_ID);
  assert.equal(result.ocrInvoked, false);
  assert.equal(result.providerSubmitted, false);
  const insert = client.queries.find((q) => String(q.sql).includes('INSERT INTO public.check_intake_items'));
  assert.ok(insert);
  assert.equal(insert.params[1], FREEDOM_TENANT);
  assert.equal(insert.params[2], APP_ID);
  assert.equal(insert.params[3], 'uploaded');
  assert.equal(insert.params.includes(C1C_TENANT), false);
  assert.equal(insert.params.includes(SPOOF_ID), false);
  assert.equal(insert.params.includes('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), false);
});

test('T5 kill switch disables create without a write transaction', async () => {
  const client = mockClient();
  const result = await handleCreateCheck(jwtEvent('/workflow/checks', 'POST', {
    carrier_name: 'x',
  }), { ...depsFor(client), forceWorkflow: false });
  assert.equal(result.statusCode, 403);
  assert.equal(result.error, 'application_workflow_writes_disabled');
  assert.equal(client.queries.some((q) => String(q.sql).includes('INSERT INTO public.check_intake_items')), false);
});

test('valid start_review then mark_ready; skip and deposited denied', async () => {
  const client = mockClient({ check: { ...createdRow, status: 'uploaded' } });
  const review = await handleCheckTransition(jwtEvent('/workflow/transition', 'POST', {
    check_id: CHECK_ID,
    action: 'start_review',
    tenant_id: C1C_TENANT,
    user_id: SPOOF_ID,
  }), depsFor(client));
  assert.equal(review.ok, true);
  assert.equal(review.toStatus, 'needs_review');

  const skip = await handleCheckTransition(jwtEvent('/workflow/transition', 'POST', {
    check_id: CHECK_ID,
    action: 'mark_ready_for_deposit',
  }), depsFor(mockClient({ check: { ...createdRow, status: 'uploaded' } })));
  assert.equal(skip.statusCode, 403);
  assert.equal(skip.error, 'invalid_transition');

  const readyClient = mockClient({ check: { ...createdRow, status: 'needs_review' } });
  const ready = await handleCheckTransition(jwtEvent('/workflow/transition', 'POST', {
    check_id: CHECK_ID,
    action: 'mark_ready_for_deposit',
  }), depsFor(readyClient));
  assert.equal(ready.ok, true);
  assert.equal(ready.readyForProviderExecution, true);
  assert.equal(ready.providerExecution, false);

  const unsigned = await handleCheckTransition(jwtEvent('/workflow/transition', 'POST', {
    check_id: CHECK_ID,
    action: 'mark_ready_for_deposit',
  }), depsFor(mockClient({
    check: { ...createdRow, status: 'needs_review' },
    payees: [{
      id: 'payee-unsigned-1',
      check_id: CHECK_ID,
      tenant_id: FREEDOM_TENANT,
      payee_type: 'insured',
      endorsement_status: 'pending',
      endorsed_at: null,
    }],
    endorsements: [{
      id: 'endo-unsigned-1',
      check_id: CHECK_ID,
      tenant_id: FREEDOM_TENANT,
      payee_id: 'payee-unsigned-1',
      payee_type: 'insured',
      status: 'pending',
      signed_at: null,
    }],
  })));
  assert.equal(unsigned.ok, false);
  assert.equal(unsigned.error, 'endorsements_incomplete');
  assert.equal(unsigned.providerExecution, undefined);

  const deposited = await handleCheckTransition(jwtEvent('/workflow/transition', 'POST', {
    check_id: CHECK_ID,
    action: 'mark_deposited',
  }), depsFor(mockClient({ check: { ...createdRow, status: 'needs_review' } })));
  assert.equal(deposited.error, 'financial_or_provider');
});

test('review RPC path branch_deposit_required is denied as financial', async () => {
  const result = await handleCheckTransition(jwtEvent('/workflow/transition', 'POST', {
    check_id: CHECK_ID,
    p_deposit_path: 'branch_deposit_required',
  }), depsFor(mockClient()));
  assert.equal(result.statusCode, 403);
  assert.equal(result.error, 'financial_or_provider');
});

test('T5 mortgage columns require the T5 flag; T2 descriptive still works', async () => {
  assert.equal(WRITE_ALLOWLIST.check_intake_items.ops.has('insert'), false);
  const client = mockClient();
  const denied = await handleWrite(jwtEvent('/data/write', 'POST', {
    table: 'check_intake_items',
    op: 'update',
    values: { mortgage_monitoring_type: 'monitored' },
    filters: [{ column: 'id', op: 'eq', value: CHECK_ID }],
  }), { ...depsFor(client), forceWorkflow: false });
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.error, 'application_workflow_writes_disabled');

  const t2 = await handleWrite(jwtEvent('/data/write', 'POST', {
    table: 'check_intake_items',
    op: 'update',
    values: { carrier_name: 'Safe' },
    filters: [{ column: 'id', op: 'eq', value: CHECK_ID }],
  }), { ...depsFor(client), forceWorkflow: false });
  assert.equal(t2.ok, true);

  const t5 = await handleWrite(jwtEvent('/data/write', 'POST', {
    table: 'check_intake_items',
    op: 'update',
    values: { mortgage_monitoring_type: 'monitored' },
    filters: [{ column: 'id', op: 'eq', value: CHECK_ID }],
  }), depsFor(client));
  assert.equal(t5.ok, true);

  const release = await handleWrite(jwtEvent('/data/write', 'POST', {
    table: 'check_intake_items',
    op: 'update',
    values: { mortgage_final_released_at: '2026-09-02T00:00:00.000Z' },
    filters: [{ column: 'id', op: 'eq', value: CHECK_ID }],
  }), depsFor(client));
  assert.equal(release.error, 'column_not_allowlisted');
});

test('mortgage request insert uses mapped actor and check tenant', async () => {
  const client = mockClient();
  const result = await handleWrite(jwtEvent('/data/write', 'POST', {
    table: 'mortgage_handling_requests',
    op: 'insert',
    values: {
      check_intake_item_id: CHECK_ID,
      mortgage_company: 'AWS T5 TEST Lender',
      tenant_id: C1C_TENANT,
      requested_by: SPOOF_ID,
      billed_at: '2026-09-02T00:00:00.000Z',
    },
  }), depsFor(client));
  assert.equal(result.ok, true);
  const insert = client.queries.find((q) => String(q.sql).includes('INSERT INTO public.mortgage_handling_requests'));
  assert.equal(insert.params[0], FREEDOM_TENANT);
  assert.equal(insert.params[5], APP_ID);
});

test('unauthenticated workflow create is 401', async () => {
  const result = await handler(jwtEvent('/workflow/checks', 'POST', { carrier_name: 'x' }, { auth: null }));
  assert.equal(result.statusCode, 401);
});

test('provider execution routes remain disabled', async () => {
  const result = await handler(jwtEvent('/functions/v1/checkalt-submit-deposit', 'POST', { checkId: CHECK_ID }));
  const body = JSON.parse(result.body);
  assert.equal(result.statusCode, 403);
  assert.equal(body.error, 'provider_disabled');
});

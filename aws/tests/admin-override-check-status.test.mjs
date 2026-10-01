import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ADMIN_OVERRIDE_ALLOWED_STATUSES,
  executeAdminOverrideCheckStatus,
  recommendationForAdminOverrideStatus,
  stageForAdminOverrideStatus,
} from '../functions/api/admin-override-check-status.mjs';
import {
  SAFE_WRITE_RPC_CLASSIFICATION,
  SAFE_WRITE_RPCS,
  executeSafeWriteRpc,
  handleSafeWriteRpc,
} from '../functions/api/workflow-rpc.mjs';
import { handleDataRpc } from '../functions/api/data.mjs';
import { LOOKUP_MAPPING_SQL, USER_ROLES_SQL } from '../functions/api/identity.mjs';

const APP_ID = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';
const COGNITO_SUB = 'c4386408-60e1-70e2-abb6-e6194e8e635f';
const CHECK_ID = '33333333-3333-4333-8333-333333333333';
const FREEDOM = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';

const jwtEvent = (body) => ({
  rawPath: '/data/rpc',
  headers: { authorization: 'Bearer test-id-token' },
  body: JSON.stringify(body),
  requestContext: {
    stage: 'staging',
    http: { method: 'POST', path: '/data/rpc' },
    authorizer: {
      jwt: { claims: { sub: COGNITO_SUB, email: 'checksops-tester@freedomadj.com', token_use: 'id' } },
    },
  },
});

const mockClient = ({
  roles = [{ role: 'admin' }],
  check = {
    id: CHECK_ID,
    tenant_id: FREEDOM,
    status: 'endorsements_in_progress',
    check_stage: 'endorsing',
  },
} = {}) => {
  const queries = [];
  return {
    queries,
    connect: async () => {},
    end: async () => {},
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (sql === 'BEGIN' || sql === 'ROLLBACK' || sql === 'COMMIT' || sql === 'SET TRANSACTION READ WRITE') {
        return { rows: [] };
      }
      if (sql.startsWith('SELECT set_config')) return { rows: [{ set_config: params[1] }] };
      if (sql === LOOKUP_MAPPING_SQL) {
        return {
          rows: [{
            application_user_id: APP_ID,
            cognito_sub: COGNITO_SUB,
            email: 'checksops-tester@freedomadj.com',
            status: 'active',
          }],
        };
      }
      if (sql === USER_ROLES_SQL) return { rows: roles };
      if (/FROM public.check_intake_items/.test(sql) && /FOR UPDATE/.test(sql)) {
        return { rows: check ? [check] : [] };
      }
      if (/FROM public.tenant_users/.test(sql)) {
        return { rows: check?.tenant_id === FREEDOM ? [{ '?column?': 1 }] : [] };
      }
      if (/UPDATE public.check_intake_items/.test(sql)) return { rows: [] };
      if (/UPDATE public.claim_checks/.test(sql)) return { rows: [] };
      if (/INSERT INTO public.check_audit_log/.test(sql)) return { rows: [{ id: 'audit' }] };
      return { rows: [] };
    },
  };
};

test('admin override is allowlisted as a safe write RPC', () => {
  assert.equal(SAFE_WRITE_RPCS.has('admin_override_check_status'), true);
  assert.equal(SAFE_WRITE_RPC_CLASSIFICATION.admin_override_check_status, 'safe_now');
  assert.equal(ADMIN_OVERRIDE_ALLOWED_STATUSES.has('needs_review'), true);
  assert.equal(ADMIN_OVERRIDE_ALLOWED_STATUSES.has('deposited'), false);
  assert.equal(stageForAdminOverrideStatus('needs_review'), 'review');
  assert.equal(stageForAdminOverrideStatus('endorsements_in_progress'), 'endorsing');
  assert.equal(recommendationForAdminOverrideStatus('needs_review'), null);
});

test('admin can move a claim-linked check from Endorsing back to Review', async () => {
  const client = mockClient({
    check: {
      id: CHECK_ID,
      tenant_id: FREEDOM,
      status: 'endorsements_in_progress',
      check_stage: 'endorsing',
      claim_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    },
  });
  const result = await executeAdminOverrideCheckStatus({
    client,
    mapping: { application_user_id: APP_ID },
    args: { p_check_id: CHECK_ID, p_new_status: 'needs_review', p_actor_id: APP_ID },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.data.ok, true);
  assert.equal(result.data.old_status, 'endorsements_in_progress');
  assert.equal(result.data.new_status, 'needs_review');
  assert.equal(result.data.new_stage, 'review');

  const intake = client.queries.find((q) => /UPDATE public.check_intake_items/.test(q.sql));
  assert.ok(intake);
  assert.equal(intake.params[1], 'needs_review');
  assert.equal(intake.params[2], 'review');
  assert.equal(intake.params[3], null);

  const mirror = client.queries.find((q) => /UPDATE public.claim_checks/.test(q.sql));
  assert.ok(mirror);
  assert.equal(mirror.params[1], 'review');

  const audit = client.queries.find((q) => /INSERT INTO public.check_audit_log/.test(q.sql));
  assert.ok(audit);
  assert.equal(audit.params[1], APP_ID);
  assert.match(audit.params[2], /endorsements_in_progress/);
});

test('admin can move forward to endorsing without T5 from-state blockers', async () => {
  const client = mockClient({
    check: { id: CHECK_ID, tenant_id: FREEDOM, status: 'needs_review', check_stage: 'review' },
  });
  const result = await executeSafeWriteRpc({
    client,
    mapping: { application_user_id: APP_ID },
    name: 'admin_override_check_status',
    args: { p_check_id: CHECK_ID, p_new_status: 'endorsements_in_progress' },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.data.new_status, 'endorsements_in_progress');
  assert.equal(result.data.new_stage, 'endorsing');
});

test('deposited remains a financial destination', async () => {
  const client = mockClient();
  const result = await executeAdminOverrideCheckStatus({
    client,
    mapping: { application_user_id: APP_ID },
    args: { p_check_id: CHECK_ID, p_new_status: 'deposited' },
  });
  assert.equal(result.error, 'rpc_financial_disabled');
  assert.equal(client.queries.some((q) => /UPDATE public.check_intake_items/.test(q.sql)), false);
});

test('staff outside the tenant cannot override', async () => {
  const client = mockClient({
    roles: [{ role: 'staff' }],
    check: { id: CHECK_ID, tenant_id: '99999999-9999-4999-8999-999999999999', status: 'endorsements_in_progress' },
  });
  const result = await executeAdminOverrideCheckStatus({
    client,
    mapping: { application_user_id: APP_ID },
    args: { p_check_id: CHECK_ID, p_new_status: 'needs_review' },
  });
  assert.equal(result.error, 'not_authorized');
});

test('non-admin non-staff is rejected', async () => {
  const client = mockClient({ roles: [{ role: 'user' }] });
  const result = await executeAdminOverrideCheckStatus({
    client,
    mapping: { application_user_id: APP_ID },
    args: { p_check_id: CHECK_ID, p_new_status: 'needs_review' },
  });
  assert.equal(result.error, 'not_authorized');
});

test('handleDataRpc no longer returns the staging-read deny for admin override', async () => {
  process.env.AWS_APPLICATION_WORKFLOW_WRITES_ENABLED = 'true';
  process.env.AWS_WRITES_ENABLED = 'true';
  const client = mockClient();
  const result = await handleDataRpc(
    jwtEvent({
      name: 'admin_override_check_status',
      args: { p_check_id: CHECK_ID, p_new_status: 'needs_review' },
    }),
    {
      loadDatabaseCredentials: async () => ({ host: 'x', username: 'checksops', password: 'x', database: 'checksops' }),
      createClient: () => client,
      forceEnabled: true,
    },
  );
  assert.notEqual(result.error, 'rpc_disabled');
  assert.equal(String(result.message || '').includes('not enabled for AWS staging reads'), false);
  assert.equal(result.ok, true);
  assert.equal(result.data.new_status, 'needs_review');
  assert.equal(result.data.new_stage, 'review');
});

test('HTTP /data/rpc routes admin override to the write bridge', async () => {
  process.env.AWS_APPLICATION_WORKFLOW_WRITES_ENABLED = 'true';
  process.env.AWS_WRITES_ENABLED = 'true';
  const client = mockClient();
  const result = await handleSafeWriteRpc(
    jwtEvent({
      name: 'admin_override_check_status',
      args: { p_check_id: CHECK_ID, p_new_status: 'needs_review' },
    }),
    {
      loadDatabaseCredentials: async () => ({ host: 'x', username: 'checksops', password: 'x', database: 'checksops' }),
      createClient: () => client,
      forceEnabled: true,
    },
  );
  assert.equal(result.ok, true);
  assert.equal(result.providerExecution, false);
  assert.equal(result.data.new_status, 'needs_review');
  assert.equal(result.data.new_stage, 'review');
});

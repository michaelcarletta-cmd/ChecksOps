import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { handleCheckTransition, handleDeleteCheck, matchWorkflowRoute } from '../functions/api/workflow.mjs';
import { handleAdminStatusCorrection } from '../functions/api/workflow-admin-status.mjs';
import { handleWrite } from '../functions/api/write.mjs';
import { handleDataRpc } from '../functions/api/data.mjs';
import { LOOKUP_MAPPING_SQL, TENANT_MEMBERSHIP_SQL, USER_ROLES_SQL } from '../functions/api/identity.mjs';
import { IS_PLATFORM_OWNER_SQL } from '../functions/api/data.mjs';
import { SAFE_WRITE_RPCS, SAFE_WRITE_RPC_CLASSIFICATION } from '../functions/api/workflow-rpc.mjs';
import { WRITE_ALLOWLIST, INTAKE_PROHIBITED_COLUMNS } from '../functions/api/write-allowlist.mjs';
import { evaluateTransition, mapReviewPath, TRANSITIONS } from '../functions/api/workflow-transitions.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const APP_ID = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';
const OTHER_APP = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const COGNITO_SUB = 'c4386408-60e1-70e2-abb6-e6194e8e635f';
const FREEDOM_TENANT = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const C1C_TENANT = '4f172140-f57a-4744-8050-95f4f07b13b4';
const CHECK_ID = '8d2b1c3e-4f5a-4678-9abc-def012345678';

const jwtEvent = (path, method, body, extra = {}) => ({
  rawPath: path,
  headers: {
    authorization: extra.auth === null ? undefined : 'Bearer test-id-token',
    'x-user-id': OTHER_APP,
    'x-tenant-id': C1C_TENANT,
    'x-role': extra.headerRole || 'admin',
  },
  body: body ? JSON.stringify(body) : undefined,
  requestContext: {
    stage: 'staging',
    http: { method, path },
    authorizer: extra.auth === null ? undefined : {
      jwt: { claims: { sub: extra.sub || COGNITO_SUB, email: 'checksops-tester@freedomadj.com', token_use: 'id' } },
    },
  },
});

const mappingFor = (applicationUserId = APP_ID) => ({
  application_user_id: applicationUserId,
  cognito_sub: COGNITO_SUB,
  email: 'checksops-tester@freedomadj.com',
  status: 'active',
});

const checkRow = {
  id: CHECK_ID,
  tenant_id: FREEDOM_TENANT,
  uploaded_by: APP_ID,
  status: 'endorsements_in_progress',
  check_stage: 'endorsing',
  claim_id: null,
  deposited_at: null,
};

const mockClient = ({
  mapping = mappingFor(),
  memberships = [{ tenant_id: FREEDOM_TENANT, role: 'admin', tenant_name: 'Freedom', tenant_slug: 'freedom' }],
  roles = [{ role: 'admin' }],
  platformOwner = false,
  masterOwner = false,
  check = checkRow,
  claimChecksError = null,
} = {}) => {
  const queries = [];
  return {
    queries,
    connect: async () => {},
    end: async () => {},
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (
        sql === 'BEGIN' || sql === 'ROLLBACK' || sql === 'COMMIT' || sql === 'SET TRANSACTION READ WRITE'
        || sql === 'SAVEPOINT admin_status_claim_mirror'
        || sql === 'RELEASE SAVEPOINT admin_status_claim_mirror'
        || sql === 'ROLLBACK TO SAVEPOINT admin_status_claim_mirror'
      ) {
        return { rows: [] };
      }
      if (sql.startsWith('SELECT set_config')) return { rows: [{ set_config: params[1] }] };
      if (sql === LOOKUP_MAPPING_SQL) {
        return { rows: params[0] === mapping.cognito_sub ? [mapping] : [] };
      }
      if (sql === TENANT_MEMBERSHIP_SQL) return { rows: memberships };
      if (sql === USER_ROLES_SQL) return { rows: roles };
      if (sql === IS_PLATFORM_OWNER_SQL) return { rows: [{ is_owner: platformOwner }] };
      if (/SELECT public.is_master_owner\(\) AS is_master/.test(sql)) return { rows: [{ is_master: masterOwner }] };
      if (/SELECT role FROM public.tenant_users/.test(sql)) {
        const tenantId = params?.[1];
        return { rows: memberships.filter((row) => !tenantId || row.tenant_id === tenantId) };
      }
      if (/FROM public.check_intake_items/.test(sql) && /SELECT id, tenant_id, status/.test(sql)) {
        return { rows: check ? [check] : [] };
      }
      if (/FROM public.check_intake_items/.test(sql) && /SELECT id, tenant_id, uploaded_by/.test(sql)) {
        return { rows: check ? [check] : [] };
      }
      if (/UPDATE public.check_intake_items/.test(sql) && /deposit_recommendation/.test(sql)) {
        return {
          rows: [{
            ...check,
            status: params[1],
            check_stage: params[2],
            deposit_recommendation: params[3],
            updated_at: '2026-09-23T18:00:00.000Z',
          }],
        };
      }
      if (/UPDATE public.check_intake_items/.test(sql)) {
        return { rows: [{ ...check, status: params?.[1] || check.status, check_stage: params?.[2] || check.check_stage }] };
      }
      if (/UPDATE public.claim_checks/.test(sql)) {
        if (claimChecksError) {
          const error = new Error(claimChecksError.message);
          error.code = claimChecksError.code;
          throw error;
        }
        return { rows: [] };
      }
      if (/INSERT INTO public.check_audit_log/.test(sql)) return { rows: [{ id: 'audit' }] };
      if (/DELETE FROM public.check_intake_items/.test(sql)) return { rows: [{ id: CHECK_ID }] };
      if (/DELETE FROM public.check_/.test(sql) || /DELETE FROM public.loss_draft/.test(sql) || /DELETE FROM public.mortgage_/.test(sql)) {
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
};

const depsFor = (client) => ({
  forceEnabled: true,
  forceWorkflow: true,
  loadDatabaseCredentials: async () => ({
    username: 'checksops',
    password: 'unit-test-only-not-a-real-secret',
    host: 'db.example.internal',
    database: 'checksops',
  }),
  createClient: () => client,
});

test('admin status correction succeeds for an authorized tenant admin', async () => {
  const client = mockClient();
  const result = await handleAdminStatusCorrection(jwtEvent('/workflow/admin-status-correction', 'POST', {
    p_check_id: CHECK_ID,
    p_new_status: 'needs_review',
    p_actor_id: OTHER_APP,
    p_reason: 'Misclassified',
  }), depsFor(client));
  assert.equal(result.ok, true);
  assert.equal(result.data.ok, true);
  assert.equal(result.data.old_status, 'endorsements_in_progress');
  assert.equal(result.data.previous_status, 'endorsements_in_progress');
  assert.equal(result.data.new_status, 'needs_review');
  assert.equal(result.data.new_stage, 'review');
  assert.equal(result.data.actor_id, APP_ID);
  assert.ok(result.data.timestamp);
  assert.equal(result.data.reason, 'Misclassified');
  assert.equal(result.providerExecution, false);
  const update = client.queries.find((q) => /UPDATE public.check_intake_items/.test(q.sql) && /deposit_recommendation/.test(q.sql));
  assert.equal(update.params[0], CHECK_ID);
  assert.equal(update.params[1], 'needs_review');
  assert.equal(update.params[2], 'review');
  assert.equal(update.params.includes(OTHER_APP), false);
  const claimMirror = client.queries.find((q) => /UPDATE public.claim_checks/.test(q.sql));
  assert.match(claimMirror.sql, /check_stage = \$2::public\.check_stage/);
  const audit = client.queries.find((q) => /INSERT INTO public.check_audit_log/.test(q.sql));
  assert.equal(audit.params[2], APP_ID);
  assert.match(String(audit.params[3]), /endorsements_in_progress/);
  assert.match(String(audit.params[3]), /needs_review/);
  assert.equal(JSON.parse(audit.params[4]).reason, 'Misclassified');
});

test('claim_checks mirror permission denied does not fail the intake correction', async () => {
  const client = mockClient({
    claimChecksError: { code: '42501', message: 'permission denied for table claim_checks' },
  });
  const result = await handleAdminStatusCorrection(jwtEvent('/workflow/admin-status-correction', 'POST', {
    check_id: CHECK_ID,
    new_status: 'needs_review',
  }), depsFor(client));
  assert.equal(result.ok, true);
  assert.equal(result.data.new_status, 'needs_review');
  assert.ok(client.queries.some((q) => q.sql === 'ROLLBACK TO SAVEPOINT admin_status_claim_mirror'));
  assert.ok(client.queries.some((q) => /INSERT INTO public.check_audit_log/.test(q.sql)));
});

test('unauthorized staff or member cannot perform admin status correction', async () => {
  const staff = await handleAdminStatusCorrection(jwtEvent('/workflow/admin-status-correction', 'POST', {
    check_id: CHECK_ID,
    new_status: 'voided',
  }), depsFor(mockClient({ roles: [{ role: 'staff' }], memberships: [{ tenant_id: FREEDOM_TENANT, role: 'member' }] })));
  assert.equal(staff.ok, false);
  assert.equal(staff.statusCode, 403);
  assert.equal(staff.error, 'not_authorized');

  const member = await handleAdminStatusCorrection(jwtEvent('/workflow/admin-status-correction', 'POST', {
    check_id: CHECK_ID,
    new_status: 'voided',
  }), depsFor(mockClient({ roles: [], memberships: [{ tenant_id: FREEDOM_TENANT, role: 'member' }] })));
  assert.equal(member.error, 'not_authorized');
});

test('cross-tenant status correction is rejected', async () => {
  const result = await handleAdminStatusCorrection(jwtEvent('/workflow/admin-status-correction', 'POST', {
    check_id: CHECK_ID,
    new_status: 'needs_review',
  }), depsFor(mockClient({
    roles: [{ role: 'admin' }],
    memberships: [{ tenant_id: C1C_TENANT, role: 'admin' }],
  })));
  assert.equal(result.ok, false);
  assert.equal(result.statusCode, 403);
  assert.equal(result.error, 'cross_tenant');
});

test('platform owner may correct another tenant; invalid and financial targets are rejected', async () => {
  const owner = await handleAdminStatusCorrection(jwtEvent('/workflow/admin-status-correction', 'POST', {
    check_id: CHECK_ID,
    new_status: 'voided',
  }), depsFor(mockClient({
    platformOwner: true,
    roles: [],
    memberships: [],
  })));
  assert.equal(owner.ok, true);
  assert.equal(owner.data.new_status, 'voided');

  const invalid = await handleAdminStatusCorrection(jwtEvent('/workflow/admin-status-correction', 'POST', {
    check_id: CHECK_ID,
    new_status: 'not_a_real_status',
  }), depsFor(mockClient()));
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.error, 'invalid_status');

  const deposited = await handleAdminStatusCorrection(jwtEvent('/workflow/admin-status-correction', 'POST', {
    check_id: CHECK_ID,
    new_status: 'deposited',
  }), depsFor(mockClient()));
  assert.equal(deposited.error, 'invalid_status');

  const locked = await handleAdminStatusCorrection(jwtEvent('/workflow/admin-status-correction', 'POST', {
    check_id: CHECK_ID,
    new_status: 'needs_review',
  }), depsFor(mockClient({ check: { ...checkRow, deposited_at: '2026-09-01T00:00:00.000Z' } })));
  assert.equal(locked.error, 'financial_lock');
});

test('normal workflow users still cannot bypass the state machine via /workflow/transition', async () => {
  const missingFrom = await handleCheckTransition(jwtEvent('/workflow/transition', 'POST', {
    check_id: CHECK_ID,
    action: 'start_review',
  }), depsFor(mockClient({
    roles: [{ role: 'member' }],
    memberships: [{ tenant_id: FREEDOM_TENANT, role: 'member' }],
    check: { ...checkRow, status: 'endorsements_in_progress' },
  })));
  assert.equal(missingFrom.error, 'invalid_transition');

  const voided = await handleCheckTransition(jwtEvent('/workflow/transition', 'POST', {
    check_id: CHECK_ID,
    p_deposit_path: 'voided',
  }), depsFor(mockClient({ roles: [{ role: 'member' }] })));
  assert.equal(voided.error, 'not_in_tranche_5_machine');
  assert.equal(mapReviewPath('voided').error, 'not_in_tranche_5_machine');
  assert.equal(mapReviewPath('reissue_requested').error, 'not_in_tranche_5_machine');
  assert.equal(evaluateTransition('start_review', { id: CHECK_ID, status: 'endorsements_in_progress', claim_id: null }).error, 'invalid_transition');
});

test('both admin override UIs and the edit dialog call the same helper; client bridges one AWS route', () => {
  const helper = readFileSync(join(ROOT, 'src/lib/adminCheckWorkflow.ts'), 'utf8');
  const ccc = readFileSync(join(ROOT, 'src/pages/CheckCommandCenter.tsx'), 'utf8');
  const tracker = readFileSync(join(ROOT, 'src/components/check-review/AdminCheckTracker.tsx'), 'utf8');
  const edit = readFileSync(join(ROOT, 'src/components/check-review/CheckAdminEditDialog.tsx'), 'utf8');
  const client = readFileSync(join(ROOT, 'src/integrations/aws/client.ts'), 'utf8');
  assert.match(helper, /ADMIN_OVERRIDE_CHECK_STATUS_RPC = "admin_override_check_status"/);
  assert.match(ccc, /adminOverrideCheckStatus/);
  assert.match(tracker, /adminOverrideCheckStatus/);
  assert.match(edit, /adminOverrideCheckStatus/);
  assert.equal(ccc.includes('supabase.rpc("admin_override_check_status"'), false);
  assert.equal(tracker.includes('supabase.rpc("admin_override_check_status"'), false);
  assert.match(client, /if \(name === "admin_override_check_status"\)/);
  assert.match(client, /\/workflow\/admin-status-correction/);
  assert.equal(SAFE_WRITE_RPCS.has('admin_override_check_status'), false);
  assert.equal(SAFE_WRITE_RPC_CLASSIFICATION.admin_override_check_status, 'already_bridged');
});

test('generic /data/write still cannot modify intake status or amount/MICR', async () => {
  assert.equal(INTAKE_PROHIBITED_COLUMNS.has('status'), true);
  assert.equal(INTAKE_PROHIBITED_COLUMNS.has('amount'), true);
  assert.equal(INTAKE_PROHIBITED_COLUMNS.has('routing_number'), true);
  assert.equal(INTAKE_PROHIBITED_COLUMNS.has('account_number'), true);
  assert.equal(WRITE_ALLOWLIST.check_intake_items.columns.has('status'), false);
  const client = mockClient();
  const status = await handleWrite(jwtEvent('/data/write', 'POST', {
    table: 'check_intake_items',
    op: 'update',
    values: { status: 'voided' },
    filters: [{ column: 'id', op: 'eq', value: CHECK_ID }],
  }), depsFor(client));
  assert.equal(status.error, 'column_not_allowlisted');

  const amount = await handleWrite(jwtEvent('/data/write', 'POST', {
    table: 'check_intake_items',
    op: 'update',
    values: { amount: 12.34, routing_number: '021000021', account_number: '999' },
    filters: [{ column: 'id', op: 'eq', value: CHECK_ID }],
  }), depsFor(client));
  assert.equal(amount.error, 'column_not_allowlisted');
});

test('direct /data/rpc still rejects admin_override_check_status', async () => {
  const result = await handleDataRpc(jwtEvent('/data/rpc', 'POST', {
    name: 'admin_override_check_status',
    args: { p_check_id: CHECK_ID, p_new_status: 'voided' },
  }), depsFor(mockClient()));
  assert.equal(result.ok, false);
  assert.equal(result.error, 'rpc_disabled');
});

test('existing normal workflow transitions remain unchanged', () => {
  const uploaded = { id: CHECK_ID, status: 'uploaded', claim_id: null };
  assert.equal(evaluateTransition('start_review', uploaded).ok, true);
  assert.equal(evaluateTransition('mark_ready_for_deposit', uploaded).error, 'invalid_transition');
  assert.equal(evaluateTransition('mark_deposited', uploaded).error, 'financial_or_provider');
  assert.equal(TRANSITIONS.return_to_review.toStatus, 'needs_review');
  assert.equal(mapReviewPath('approved_for_deposit').action, 'mark_ready_for_deposit');
  assert.equal(matchWorkflowRoute('POST', '/workflow/transition'), 'transition');
  assert.equal(matchWorkflowRoute('POST', '/workflow/admin-status-correction'), 'admin-status-correction');
  assert.notEqual(matchWorkflowRoute('POST', '/workflow/admin-status-correction'), 'transition');
});

test('existing AdminDeleteCheck route and constraints remain unchanged', async () => {
  const route = matchWorkflowRoute('DELETE', `/workflow/checks/${CHECK_ID}`);
  assert.deepEqual(route, { kind: 'delete', checkId: CHECK_ID });
  const helper = readFileSync(join(ROOT, 'src/lib/adminCheckWorkflow.ts'), 'utf8');
  const queue = readFileSync(join(ROOT, 'src/pages/CheckCommandCenter.tsx'), 'utf8');
  const tracker = readFileSync(join(ROOT, 'src/components/check-review/AdminCheckTracker.tsx'), 'utf8');
  const button = readFileSync(join(ROOT, 'src/components/checks/AdminDeleteCheckButton.tsx'), 'utf8');
  assert.match(helper, /ADMIN_DELETE_CHECK_RPC = "admin_delete_check"/);
  assert.match(queue, /adminDeleteCheck/);
  assert.match(tracker, /adminDeleteCheck/);
  assert.match(button, /adminDeleteCheck/);
  assert.equal(queue.includes('check_review_decisions'), false);

  const deposited = await handleDeleteCheck(jwtEvent(`/workflow/checks/${CHECK_ID}`, 'DELETE', {
    check_id: CHECK_ID,
  }), depsFor(mockClient({ check: { ...checkRow, deposited_at: '2026-09-01T00:00:00.000Z', status: 'deposited' } })));
  assert.equal(deposited.error, 'cleanup_denied');

  const ok = await handleDeleteCheck(jwtEvent(`/workflow/checks/${CHECK_ID}`, 'DELETE', {
    check_id: CHECK_ID,
  }), depsFor(mockClient()));
  assert.equal(ok.ok, true);
  assert.equal(ok.data.deleted, true);
});

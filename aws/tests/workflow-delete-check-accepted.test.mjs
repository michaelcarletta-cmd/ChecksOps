import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handleDeleteCheck, FINANCIAL_DELETE_BLOCKERS } from '../functions/api/workflow-delete-check.mjs';
import { LOOKUP_MAPPING_SQL, USER_ROLES_SQL } from '../functions/api/identity.mjs';

const APP_ID = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';
const COGNITO_SUB = 'c4386408-60e1-70e2-abb6-e6194e8e635f';
const FREEDOM = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const CHECK_ID = '8d2b1c3e-4f5a-4678-9abc-def012345678';
const CLAIM_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const jwtEvent = (body) => ({
  rawPath: `/workflow/checks/${CHECK_ID}`,
  headers: { authorization: 'Bearer test-id-token' },
  body: JSON.stringify(body),
  requestContext: {
    stage: 'staging',
    http: { method: 'DELETE', path: `/workflow/checks/${CHECK_ID}` },
    authorizer: {
      jwt: { claims: { sub: COGNITO_SUB, email: 'checksops-tester@freedomadj.com', token_use: 'id' } },
    },
  },
});

const baseCheck = {
  id: CHECK_ID,
  tenant_id: FREEDOM,
  uploaded_by: APP_ID,
  status: 'needs_review',
  check_stage: 'review',
  claim_id: null,
  deposited_at: null,
  external_origin: null,
  amount: 100,
  check_number: '9001',
};

const mockClient = ({
  roles = [{ role: 'admin' }],
  check = baseCheck,
  blockers = {},
} = {}) => {
  const queries = [];
  return {
    queries,
    connect: async () => {},
    end: async () => {},
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (
        sql === 'BEGIN'
        || sql === 'ROLLBACK'
        || sql === 'COMMIT'
        || sql === 'SET TRANSACTION READ WRITE'
        || /SAVEPOINT/.test(sql)
        || /RELEASE SAVEPOINT/.test(sql)
        || /ROLLBACK TO SAVEPOINT/.test(sql)
      ) {
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
      if (/FROM public.check_intake_items/.test(sql) && /SELECT id, tenant_id/.test(sql)) {
        return { rows: check ? [check] : [] };
      }
      if (/SELECT \* FROM public.check_intake_items/.test(sql)) return { rows: check ? [check] : [] };
      if (/FROM public.deposit_items/.test(sql)) return { rows: blockers.deposit_items ? [{ '?column?': 1 }] : [] };
      if (/FROM public.checkalt_deposits/.test(sql)) return { rows: blockers.checkalt_deposits ? [{ '?column?': 1 }] : [] };
      if (/FROM public.disbursement_batches/.test(sql)) return { rows: [] };
      if (/FROM public.claim_check_payments/.test(sql)) return { rows: [] };
      if (/FROM public.check_billing_events/.test(sql)) return { rows: [] };
      if (/FROM public.check_payment_directions/.test(sql)) return { rows: [] };
      if (/to_regclass\('public.check_deletion_log'\)/.test(sql)) return { rows: [{ t: 'check_deletion_log' }] };
      if (/INSERT INTO public.check_deletion_log/.test(sql)) return { rows: [] };
      if (/INSERT INTO public.claim_audit_log/.test(sql)) return { rows: [] };
      if (/loss_draft_tracking/.test(sql)) return { rows: [] };
      if (/DELETE FROM public.check_intake_items/.test(sql)) return { rows: [{ id: CHECK_ID }] };
      return { rows: [] };
    },
  };
};

const depsFor = (client) => ({
  forceWorkflow: true,
  disableS3Cleanup: true,
  loadDatabaseCredentials: async () => ({
    username: 'checksops',
    password: 'unit-test-only-not-a-real-secret',
    host: 'db.example.internal',
    database: 'checksops',
  }),
  createClient: () => client,
});

test('financial delete blockers include provider and disbursement tables', () => {
  assert.deepEqual(
    FINANCIAL_DELETE_BLOCKERS.map((row) => row.table).sort(),
    [
      'check_billing_events',
      'check_payment_directions',
      'checkalt_deposits',
      'claim_check_payments',
      'deposit_items',
      'disbursement_batches',
    ],
  );
});

test('authorized delete with reason succeeds for a claim-linked check', async () => {
  const client = mockClient({ check: { ...baseCheck, claim_id: CLAIM_ID } });
  const result = await handleDeleteCheck(
    jwtEvent({ check_id: CHECK_ID, reason: 'duplicate intake' }),
    depsFor(client),
  );
  assert.equal(result.ok, true);
  assert.equal(result.data.deleted, true);
  assert.equal(result.claimLinkageDidNotBlock, true);
  assert.equal(client.queries.some((q) => /AND claim_id IS NULL RETURNING id/.test(q.sql)), false);
  assert.equal(client.queries.some((q) => /INSERT INTO public.check_deletion_log/.test(q.sql)), true);
});

test('reason shorter than 3 trimmed characters is rejected', async () => {
  const client = mockClient();
  const result = await handleDeleteCheck(
    jwtEvent({ check_id: CHECK_ID, reason: '  ab ' }),
    depsFor(client),
  );
  assert.equal(result.ok, false);
  assert.equal(result.error, 'missing_required_field');
  assert.equal(result.field, 'reason');
});

test('non-admin cannot delete', async () => {
  const client = mockClient({ roles: [{ role: 'staff' }] });
  const result = await handleDeleteCheck(
    jwtEvent({ check_id: CHECK_ID, reason: 'duplicate intake' }),
    depsFor(client),
  );
  assert.equal(result.ok, false);
  assert.equal(result.error, 'not_authorized');
});

test('terminal financial checks remain blocked', async () => {
  const client = mockClient({
    check: { ...baseCheck, status: 'deposited', check_stage: 'deposited', deposited_at: '2026-01-01' },
  });
  const result = await handleDeleteCheck(
    jwtEvent({ check_id: CHECK_ID, reason: 'duplicate intake' }),
    depsFor(client),
  );
  assert.equal(result.ok, false);
  assert.equal(result.error, 'cleanup_denied');
});

test('CheckAlt / deposit_items financial dependency remains blocked', async () => {
  const client = mockClient({ blockers: { checkalt_deposits: true } });
  const result = await handleDeleteCheck(
    jwtEvent({ check_id: CHECK_ID, reason: 'duplicate intake' }),
    depsFor(client),
  );
  assert.equal(result.ok, false);
  assert.equal(result.error, 'cleanup_denied');
  assert.equal(result.blocker, 'checkalt_deposits');
});

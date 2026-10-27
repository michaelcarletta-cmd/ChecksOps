/**
 * Delete Check as served in production (aws/functions/api/workflow.mjs handleDeleteCheck;
 * workflow-delete-check.mjs is not deployed, see production-lambda-source-reconciliation.test.mjs).
 *
 * Owner policy (2026-10-27): every check can be deleted with a reason. A check shared with a partner
 * is unshared first, then deleted: only an active shared_checks row blocks, not a partner-ingested
 * copy (external_origin.source_check_id) or a revoked share. A claim payment does not block (its
 * check link is ON DELETE SET NULL); a billing event blocks only once billed (invoiced, or a charge
 * for work done), not the mortgage_handling event written when a check enters Review. Real money
 * records (deposits, Check Alt, disbursements) still block.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handleDeleteCheck } from '../functions/api/workflow.mjs';
import { LOOKUP_MAPPING_SQL, USER_ROLES_SQL } from '../functions/api/identity.mjs';
import { TENANT_MEMBER_SQL } from '../functions/api/workflow-transitions.mjs';

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
    stage: 'production',
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

// A partner-ingested copy (SQL 70, native-paired Freedom code): it carries the source check id but
// no shared_checks row.
const ingestedCheck = {
  ...baseCheck,
  external_origin: {
    source_app: 'freedom_crm',
    source_check_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    source_partner_code: 'DF9CC985',
    native_paired: true,
  },
};

const ANY_ROW = [{ '?column?': 1 }];

const mockClient = ({ check = baseCheck, activeShare = false, shareError = null, blockers = {} } = {}) => {
  const queries = [];
  return {
    queries,
    connect: async () => {},
    end: async () => {},
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (['BEGIN', 'ROLLBACK', 'COMMIT', 'SET TRANSACTION READ WRITE'].includes(sql) || /SAVEPOINT/.test(sql)) {
        return { rows: [] };
      }
      if (sql.startsWith('SELECT set_config')) return { rows: [{ set_config: params[1] }] };
      if (sql === LOOKUP_MAPPING_SQL) {
        return { rows: [{ application_user_id: APP_ID, cognito_sub: COGNITO_SUB, email: 'checksops-tester@freedomadj.com', status: 'active' }] };
      }
      if (sql === USER_ROLES_SQL) return { rows: [] };
      if (sql === TENANT_MEMBER_SQL) return { rows: params[0] === APP_ID && params[1] === FREEDOM ? ANY_ROW : [] };
      if (/FROM public.check_intake_items/.test(sql) && /SELECT id, tenant_id/.test(sql)) return { rows: [check] };
      if (/SELECT \* FROM public.check_intake_items/.test(sql)) return { rows: [check] };
      if (/FROM public.shared_checks/.test(sql)) {
        if (shareError) {
          const error = new Error('shared_checks read failed');
          error.code = shareError;
          throw error;
        }
        return { rows: activeShare ? ANY_ROW : [] };
      }
      for (const table of ['deposit_items', 'checkalt_deposits', 'disbursement_batches', 'claim_check_payments',
        'claim_payments', 'check_billing_events', 'check_payment_directions', 'claim_disbursements']) {
        if (new RegExp(`FROM public\\.${table}\\b`).test(sql)) return { rows: blockers[table] ? ANY_ROW : [] };
      }
      if (/FROM public.claim_checks cc\s+WHERE/.test(sql)) return { rows: blockers.claim_checks_terminal ? ANY_ROW : [] };
      if (/to_regclass\('public.check_deletion_log'\)/.test(sql)) return { rows: [{ t: 'check_deletion_log' }] };
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

const remove = (client) => handleDeleteCheck(jwtEvent({ check_id: CHECK_ID, reason: 'duplicate intake' }), depsFor(client));
const deleted = (client) => client.queries.some((q) => /DELETE FROM public\.check_intake_items/.test(q.sql));

test('a partner-ingested copy with no active share is deleted', async () => {
  const client = mockClient({ check: ingestedCheck });
  const result = await remove(client);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.data.deleted, true);
  assert.equal(deleted(client), true);
  assert.equal(client.queries.some((q) => /INSERT INTO public\.check_deletion_log/.test(q.sql)), true);
});

test('an actively shared check is refused until it is unshared; only an active share counts', async () => {
  const client = mockClient({ activeShare: true });
  const result = await remove(client);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'check_shared_with_partner');
  assert.match(result.message, /Unshare it first, then delete it/);
  assert.equal(deleted(client), false);
  const share = client.queries.find((q) => /FROM public\.shared_checks/.test(q.sql));
  assert.match(share.sql, /check_id = \$1::uuid AND revoked_at IS NULL/);
  assert.deepEqual(share.params, [CHECK_ID]);
});

test('a share check that cannot be read refuses; a missing shared_checks table does not block', async () => {
  const denied = mockClient({ shareError: '42501' });
  const refused = await remove(denied);
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'blocker_verification_denied');
  assert.equal(refused.blocker, 'shared_checks');
  assert.equal(deleted(denied), false);
  const absent = mockClient({ shareError: '42P01' });
  assert.equal((await remove(absent)).ok, true);
});

test('a claim payment linked to a check in Review does not block (its link is ON DELETE SET NULL)', async () => {
  const client = mockClient({ check: { ...baseCheck, claim_id: CLAIM_ID }, blockers: { claim_payments: true } });
  const result = await remove(client);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(client.queries.some((q) => /FROM public\.claim_payments/.test(q.sql)), false);
  assert.equal(deleted(client), true);
});

test('billing events block only once billed; the Review mortgage_handling event does not', async () => {
  const client = mockClient({ blockers: { check_billing_events: true } });
  const result = await remove(client);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'check_has_financial_activity');
  assert.equal(result.blocker, 'check_billing_events');
  const billing = client.queries.find((q) => /FROM public\.check_billing_events/.test(q.sql));
  assert.match(billing.sql, /e\.status IS DISTINCT FROM 'voided'/);
  assert.match(billing.sql, /e\.status = 'invoiced'/);
  assert.match(billing.sql, /to_jsonb\(e\)->>'invoice_id' IS NOT NULL/);
  assert.match(billing.sql, /e\.event_type IS DISTINCT FROM 'mortgage_handling'/);
});

for (const table of ['deposit_items', 'checkalt_deposits', 'disbursement_batches', 'claim_check_payments',
  'check_payment_directions', 'claim_disbursements', 'claim_checks_terminal']) {
  test(`real money records still block: ${table}`, async () => {
    const client = mockClient({ check: ingestedCheck, blockers: { [table]: true } });
    const result = await remove(client);
    assert.equal(result.ok, false);
    assert.equal(result.error, 'check_has_financial_activity');
    assert.equal(result.blocker, table);
    assert.equal(deleted(client), false);
  });
}

test('a deposited check is still refused as terminal', async () => {
  const client = mockClient({ check: { ...baseCheck, status: 'deposited', check_stage: 'deposited', deposited_at: '2026-10-01' } });
  const result = await remove(client);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'check_terminal_financial_state');
  assert.equal(deleted(client), false);
});

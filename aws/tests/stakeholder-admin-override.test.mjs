/**
 * Settings Override must write admin_override through the AWS allowlist.
 * No Moov call. No money movement.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { WRITE_ALLOWLIST, pickAllowlistedValues } from '../functions/api/write-allowlist.mjs';
import { executeStakeholderAdminOverride } from '../functions/api/write-stakeholder-override.mjs';

const ADMIN = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';
const MEMBER = '11111111-1111-4111-8111-111111111111';
const TENANT = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const ACCOUNT = '8d2b1c3e-4f5a-4678-9abc-def012345678';

test('stakeholder_accounts write allowlist is override-only', () => {
  const spec = WRITE_ALLOWLIST.stakeholder_accounts;
  assert.equal(spec.tranche, 6);
  assert.equal(spec.ops.has('update'), true);
  assert.equal(spec.ops.has('insert'), false);
  assert.equal(spec.ops.has('delete'), false);
  assert.deepEqual([...spec.columns], ['verification_status']);
  assert.ok(!spec.columns.has('chk_acct'));
  assert.ok(!spec.columns.has('chk_aba'));
  assert.ok(spec.clientIgnored.has('verified_at'));
  const ignored = pickAllowlistedValues('stakeholder_accounts', {
    verification_status: 'admin_override',
    chk_acct: '1234567890',
    verified_at: '2026-10-01T00:00:00.000Z',
  });
  assert.equal(ignored.error, undefined);
  assert.deepEqual(ignored.values, { verification_status: 'admin_override' });
  const denied = pickAllowlistedValues('stakeholder_accounts', {
    verification_status: 'admin_override',
    nickname: 'michael1',
  });
  assert.equal(denied.error, 'column_not_allowlisted');
  const awsClient = readFileSync('src/integrations/aws/client.ts', 'utf8');
  assert.match(awsClient, /"stakeholder_accounts"/);
  const workflow = readFileSync('aws/functions/api/write-check-workflow.mjs', 'utf8');
  assert.match(workflow, /executeStakeholderAdminOverride/);
});

function mockClient({ role = 'admin', actor = ADMIN } = {}) {
  const queries = [];
  return {
    queries,
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (/FROM public.stakeholder_accounts/.test(sql) && /SELECT id, tenant_id/.test(sql)) {
        return { rows: [{ id: ACCOUNT, tenant_id: TENANT, verification_status: 'unverified' }] };
      }
      if (/FROM public.tenant_users/.test(sql) || /FROM public.user_roles/.test(sql)) {
        if (actor === ADMIN && (role === 'admin' || role === 'owner')) {
          return { rows: [{ '?column?': 1 }] };
        }
        return { rows: [] };
      }
      if (/UPDATE public.stakeholder_accounts/.test(sql)) {
        return {
          rows: [{
            id: ACCOUNT,
            tenant_id: TENANT,
            verification_status: 'admin_override',
            verified_at: '2026-10-01T14:00:00.000Z',
          }],
        };
      }
      return { rows: [] };
    },
  };
}

test('admin override writes admin_override and server verified_at', async () => {
  const client = mockClient();
  const result = await executeStakeholderAdminOverride({
    client,
    mapping: { application_user_id: ADMIN },
    op: 'update',
    values: { verification_status: 'admin_override' },
    filters: [{ column: 'id', op: 'eq', value: ACCOUNT }],
  });
  assert.equal(result.rows[0].verification_status, 'admin_override');
  const update = client.queries.find((q) => /UPDATE public.stakeholder_accounts/.test(q.sql));
  assert.match(update.sql, /verification_status = 'admin_override'/);
  assert.match(update.sql, /verified_at = now\(\)/);
});

test('override rejects verified or pending values and non-admins', async () => {
  const verified = await executeStakeholderAdminOverride({
    client: mockClient(),
    mapping: { application_user_id: ADMIN },
    op: 'update',
    values: { verification_status: 'verified' },
    filters: [{ column: 'id', op: 'eq', value: ACCOUNT }],
  });
  assert.equal(verified.error, 'invalid_field');

  const member = await executeStakeholderAdminOverride({
    client: mockClient({ actor: MEMBER, role: 'member' }),
    mapping: { application_user_id: MEMBER },
    op: 'update',
    values: { verification_status: 'admin_override' },
    filters: [{ column: 'id', op: 'eq', value: ACCOUNT }],
  });
  assert.equal(member.error, 'not_authorized');
});

/**
 * Settings > Stakeholder Accounts on AWS (owner requirements 2026-10-25): remove a non-payee
 * stakeholder (is_active / is_primary false) and change a stakeholder's type, through
 * /data/write stakeholder_accounts (tranche 6, AWS_APPLICATION_WORKFLOW_WRITES_ENABLED) on the
 * SQL 114 column grant. Pins the allowlist entry, the executor's two writes and every refusal,
 * the client table entry, and the Settings page's types and calls.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { WRITE_ALLOWLIST, pickAllowlistedValues } from '../functions/api/write-allowlist.mjs';
import { executeAppMetadataWrite, executeStakeholderAccounts, STAKEHOLDER_SETTINGS_TYPES } from '../functions/api/write-app-metadata.mjs';
import { executeAllowlistedWrite } from '../functions/api/write.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const APP_ID = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';
const TENANT = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const ACCOUNT = '5a0c1e2f-3b4d-4e5f-8a6b-7c8d9e0f1a2b';
const mapping = { application_user_id: APP_ID };
const idFilter = (value = ACCOUNT) => [{ column: 'id', op: 'eq', value }];

/**
 * A mock connection: `row` is what the tenant-scoped lookup sees (null: another tenant's or a
 * missing row), `payee` whether a connected payee holds the row, `updated` whether the UPDATE
 * matches (false: RLS or a concurrent change). Records every statement.
 */
function mockClient({ row = { id: ACCOUNT, account_type: 'homeowner', origin: 'manual', is_active: true }, payee = false, updated = true } = {}) {
  const queries = [];
  return {
    queries,
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (/^\s*SELECT id, account_type, origin, is_active\s+FROM public\.stakeholder_accounts/.test(sql)) {
        assert.match(sql, /tenant_id IN \(SELECT public\.aws_user_tenant_ids\(\)\)/);
        return { rows: row ? [row] : [] };
      }
      if (/^\s*SELECT 1 FROM public\.external_payment_recipients/.test(sql)) {
        assert.match(sql, /disconnected_at IS NULL/);
        return { rows: payee ? [{ '?column?': 1 }] : [] };
      }
      if (/^\s*UPDATE public\.stakeholder_accounts/.test(sql)) {
        if (!updated) return { rows: [] };
        return {
          rows: [{
            id: params[0],
            tenant_id: TENANT,
            account_type: params[1] ?? row?.account_type,
            is_active: !/is_active = false/.test(sql),
            is_primary: false,
            homeowner_name: null,
            homeowner_email: null,
            updated_at: '2026-10-25T00:00:00.000Z',
            // A RETURNING that leaked would carry these; the route strips them regardless.
            plaid_access_token: 'leak',
            verification_token: 'leak',
          }],
        };
      }
      throw new Error(`unexpected statement: ${sql}`);
    },
  };
}
const updates = (client) => client.queries.filter((q) => /^\s*UPDATE/.test(q.sql));
const write = (client, values, filters = idFilter(), op = 'update') => executeAppMetadataWrite({
  client, mapping, table: 'stakeholder_accounts', op, values, filters,
});

test('allowlist: update only, three client columns, id filter, tranche 6; homeowner fields server-cleared, never client-set', () => {
  const spec = WRITE_ALLOWLIST.stakeholder_accounts;
  assert.ok(spec);
  assert.equal(spec.tranche, 6);
  assert.deepEqual([...spec.ops], ['update']);
  assert.deepEqual([...spec.columns].sort(), ['account_type', 'is_active', 'is_primary']);
  assert.deepEqual([...spec.filterColumns], ['id']);
  assert.deepEqual([...spec.serverClearedColumns].sort(), ['homeowner_email', 'homeowner_name']);
  assert.equal(spec.identityColumn, null);
  for (const column of ['id', 'tenant_id', 'created_by', 'provider', 'provider_account_id', 'provider_environment',
    'verification_status', 'verification_source', 'verification_token', 'verified_at', 'chk_acct', 'chk_aba',
    'acct_type', 'plaid_access_token', 'origin']) {
    assert.ok(spec.clientIgnored.has(column), column);
    assert.ok(!spec.columns.has(column), column);
  }
  for (const column of ['homeowner_name', 'homeowner_email']) {
    assert.ok(!spec.columns.has(column), column);
    assert.ok(!spec.clientIgnored.has(column), column);
    assert.deepEqual(pickAllowlistedValues('stakeholder_accounts', { account_type: 'contractor', [column]: 'Someone' }), {
      error: 'column_not_allowlisted', columns: [column], table: 'stakeholder_accounts',
    });
  }
  // Provider, verification and bank keys are dropped, never written.
  const picked = pickAllowlistedValues('stakeholder_accounts', { account_type: 'vendor', verification_status: 'verified', chk_acct: '1', provider_account_id: 'x' });
  assert.deepEqual(picked.values, { account_type: 'vendor' });
  assert.match(spec.frontend.file, /StakeholderAccountSettings\.tsx/);
  assert.deepEqual([...STAKEHOLDER_SETTINGS_TYPES], ['contractor', 'subcontractor', 'vendor', 'sales_rep']);
});

test('remove: is_active and is_primary false, tenant-scoped, payee guard in the UPDATE, no secret column returned', async () => {
  const client = mockClient({ row: { id: ACCOUNT, account_type: 'vendor', origin: 'manual', is_active: true } });
  const out = await write(client, { is_active: false, is_primary: false });
  assert.equal(out.error, undefined, JSON.stringify(out));
  const [update] = updates(client);
  assert.match(update.sql, /SET is_active = false, is_primary = false, updated_at = now\(\)/);
  assert.match(update.sql, /sa\.id = \$1::uuid AND sa\.tenant_id IN \(SELECT public\.aws_user_tenant_ids\(\)\)/);
  assert.match(update.sql, /NOT EXISTS \(\s*SELECT 1 FROM public\.external_payment_recipients r\s+WHERE r\.stakeholder_account_id = sa\.id AND r\.disconnected_at IS NULL/);
  assert.match(update.sql, /sa\.account_type <> 'operating' AND sa\.origin IS DISTINCT FROM 'provider_connected'/);
  assert.doesNotMatch(update.sql, /RETURNING \*|plaid_access_token|verification_token|homeowner_name =/);
  assert.deepEqual(update.params, [ACCOUNT]);
  assert.equal(out.rows[0].plaid_access_token, undefined);
  assert.equal(out.rows[0].verification_token, undefined);
  // is_active false alone is a removal too.
  const single = mockClient();
  assert.equal((await write(single, { is_active: false })).error, undefined);
  assert.match(updates(single)[0].sql, /SET is_active = false, updated_at = now\(\)/);
});

test('type change: account_type to an allowed type clears homeowner_name and homeowner_email server-side; nothing else', async () => {
  for (const type of STAKEHOLDER_SETTINGS_TYPES) {
    const client = mockClient();
    const out = await write(client, { account_type: type });
    assert.equal(out.error, undefined, type);
    const [update] = updates(client);
    assert.match(update.sql, /SET account_type = \$2::text, homeowner_name = NULL, homeowner_email = NULL, updated_at = now\(\)/);
    assert.match(update.sql, /id = \$1::uuid AND tenant_id IN \(SELECT public\.aws_user_tenant_ids\(\)\)\s+AND is_active IS TRUE/);
    assert.doesNotMatch(update.sql, /verification|provider_account|chk_|plaid|is_active = |is_primary = /);
    assert.deepEqual(update.params, [ACCOUNT, type]);
    // A type change never consults or depends on the payee state.
    assert.ok(!client.queries.some((q) => /external_payment_recipients/.test(q.sql)));
  }
});

test('refusals: reactivate, is_primary true, homeowner or unknown type, arbitrary column, mixed write, empty values', async () => {
  const cases = [
    [{ is_active: true }, { error: 'invalid_field', field: 'is_active' }],
    [{ is_active: 'true' }, { error: 'invalid_field', field: 'is_active' }],
    [{ is_primary: true }, { error: 'invalid_field', field: 'is_primary' }],
    [{ is_active: false, is_primary: true }, { error: 'invalid_field', field: 'is_primary' }],
    [{ account_type: 'homeowner' }, { error: 'invalid_field', field: 'account_type' }],
    [{ account_type: 'operating' }, { error: 'invalid_field', field: 'account_type' }],
    [{ account_type: 'other' }, { error: 'invalid_field', field: 'account_type' }],
    [{ account_type: null }, { error: 'invalid_field', field: 'account_type' }],
    [{ account_type: 'contractor', is_active: false }, { error: 'invalid_field', field: 'account_type' }],
    [{ homeowner_name: 'Someone' }, { error: 'column_not_allowlisted', columns: ['homeowner_name'] }],
    [{ verification_status: 'verified' }, { error: 'column_not_allowlisted', columns: ['verification_status'] }],
    [{}, { error: 'missing_required_field', field: 'values' }],
  ];
  for (const [values, expected] of cases) {
    const client = mockClient();
    const out = await executeStakeholderAccounts({ client, op: 'update', values, filters: idFilter() });
    for (const [key, value] of Object.entries(expected)) assert.deepEqual(out[key], value, `${JSON.stringify(values)} ${key}`);
    assert.equal(client.queries.length, 0, JSON.stringify(values));
  }
});

test('refusals: insert/delete, non-eq or non-id filter, missing or malformed id', async () => {
  for (const op of ['insert', 'delete', 'upsert']) {
    assert.equal((await executeStakeholderAccounts({ client: mockClient(), op, values: { is_active: false }, filters: idFilter() })).error, 'operation_not_allowlisted', op);
  }
  const filterCases = [
    [[{ column: 'id', op: 'in', value: [ACCOUNT] }], 'filter_not_allowlisted'],
    [[{ column: 'id', op: 'neq', value: ACCOUNT }], 'filter_not_allowlisted'],
    [[{ op: 'or', value: 'id.eq.x' }], 'filter_not_allowlisted'],
    [[{ column: 'tenant_id', op: 'eq', value: TENANT }], 'column_not_allowlisted'],
    [[...idFilter(), { column: 'account_type', op: 'eq', value: 'vendor' }], 'column_not_allowlisted'],
    [[], 'invalid_uuid'],
    [idFilter('not-a-uuid'), 'invalid_uuid'],
  ];
  for (const [filters, error] of filterCases) {
    const client = mockClient();
    const out = await executeStakeholderAccounts({ client, op: 'update', values: { is_active: false }, filters });
    assert.equal(out.error, error, JSON.stringify(filters));
    assert.equal(client.queries.length, 0);
  }
});

test('refusals: a connected payee is removed through Disconnect, not deactivated here', async () => {
  const client = mockClient({ payee: true });
  const out = await write(client, { is_active: false, is_primary: false });
  assert.equal(out.error, 'operation_not_allowlisted');
  assert.equal(out.reason, 'payee_disconnect_required');
  assert.equal(updates(client).length, 0);
});

test('refusals: another tenant\'s or a missing row, a lost race, and the tenant\'s own bank account', async () => {
  // Cross-tenant: the tenant-scoped lookup sees nothing; no UPDATE runs.
  for (const values of [{ is_active: false }, { account_type: 'contractor' }]) {
    const client = mockClient({ row: null });
    const out = await write(client, values);
    assert.equal(out.error, 'rls_denied', JSON.stringify(values));
    assert.equal(updates(client).length, 0);
  }
  // The UPDATE matches no row (RLS aws_write_stakeholder_accounts, an inactive row, a payee connected meanwhile).
  for (const values of [{ is_active: false }, { account_type: 'vendor' }]) {
    const out = await write(mockClient({ updated: false }), values);
    assert.equal(out.error, 'rls_denied', JSON.stringify(values));
  }
  for (const row of [
    { id: ACCOUNT, account_type: 'operating', origin: 'manual', is_active: true },
    { id: ACCOUNT, account_type: 'other', origin: 'provider_connected', is_active: true },
  ]) {
    for (const values of [{ is_active: false }, { account_type: 'vendor' }]) {
      const client = mockClient({ row });
      const out = await write(client, values);
      assert.equal(out.error, 'operation_not_allowlisted');
      assert.equal(out.reason, 'tenant_bank_account');
      assert.equal(updates(client).length, 0);
    }
  }
});

test('/data/write path: tranche 6 is gated by AWS_APPLICATION_WORKFLOW_WRITES_ENABLED and reaches the executor', async () => {
  const body = { table: 'stakeholder_accounts', op: 'update', values: { account_type: 'contractor' }, filters: idFilter() };
  const off = mockClient();
  assert.equal((await executeAllowlistedWrite({ client: off, mapping, body, applicationWorkflowEnabled: false })).error, 'application_workflow_writes_disabled');
  assert.equal(off.queries.length, 0);
  const on = mockClient();
  const out = await executeAllowlistedWrite({ client: on, mapping, body, applicationWorkflowEnabled: true });
  assert.equal(out.error, undefined, JSON.stringify(out));
  assert.equal(out.rows[0].account_type, 'contractor');
  assert.equal(updates(on).length, 1);
  // Client-sent identity and provider keys are dropped; the homeowner fields are refused.
  const spoof = mockClient();
  const spoofed = await executeAllowlistedWrite({
    client: spoof, mapping, applicationWorkflowEnabled: true,
    body: { ...body, values: { account_type: 'vendor', tenant_id: TENANT, verification_status: 'verified' } },
  });
  assert.equal(spoofed.error, undefined);
  assert.deepEqual(updates(spoof)[0].params, [ACCOUNT, 'vendor']);
  const named = await executeAllowlistedWrite({
    client: mockClient(), mapping, applicationWorkflowEnabled: true,
    body: { ...body, values: { account_type: 'vendor', homeowner_email: 'x@example.invalid' } },
  });
  assert.equal(named.error, 'column_not_allowlisted');
  // Non-eq filters are refused before the executor.
  const ranged = await executeAllowlistedWrite({
    client: mockClient(), mapping, applicationWorkflowEnabled: true,
    body: { ...body, filters: [{ column: 'id', op: 'in', value: [ACCOUNT] }] },
  });
  assert.equal(ranged.error, 'filter_not_allowlisted');
});

test('client: stakeholder_accounts is an AWS write table; Settings offers contractor, subcontractor, vendor and sales rep, never homeowner', () => {
  const match = read('src/integrations/aws/client.ts').match(/const AWS_WRITE_TABLES = new Set\(\[([\s\S]*?)\]\)/);
  assert.ok(match);
  assert.ok([...match[1].matchAll(/"([^"]+)"/g)].map((row) => row[1]).includes('stakeholder_accounts'));
  const settings = read('src/components/disbursement/StakeholderAccountSettings.tsx');
  assert.match(settings, /const SELECTABLE_ACCOUNT_TYPES = \["contractor", "subcontractor", "vendor", "sales_rep"\] as const;/);
  // Remove (non-payee) and change type are the two stakeholder_accounts writes; payees disconnect.
  assert.match(settings, /from\("stakeholder_accounts"\)\s*\.update\(\{ is_active: false, is_primary: false \}\)\s*\.eq\("id", id\)/);
  assert.match(settings, /from\("stakeholder_accounts"\)\s*\.update\(\{ account_type \}\)\s*\.eq\("id", id\)/);
  assert.doesNotMatch(settings, /homeowner_(name|email):/);
  assert.match(settings, /supabase\.functions\.invoke\("moov-recipient-disconnect", \{\s*body: \{ recipient_id: payee\.id \}/);
  // The same caps: vendors, sales reps and subcontractors share one limit; contractor is not capped.
  assert.match(settings, /const CAPPED_TYPES = \["sales_rep", "subcontractor", "vendor"\];/);
  const changeType = settings.slice(settings.indexOf('const changeType = useMutation'), settings.indexOf('const typeChangeHitsCap'));
  for (const key of ['stakeholder-accounts', 'payee-recipients', 'tenant-primary-accounts', 'check-stakeholders', 'disbursement-accounts']) {
    assert.match(changeType, new RegExp(`queryKey: \\["${key}"\\]`), key);
  }
});

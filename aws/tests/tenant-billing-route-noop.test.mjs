/**
 * save-tenant-billing-account never reports a billing change the database did not make
 * (owner report, staging 2026-11-01: unchecking auto-debit said "updated" but the box stayed
 * checked after reload). toggleTenantAutoDebit and saveTenantBillingAuthorization return
 * 409 billing_update_not_applied when the UPDATE/INSERT ... RETURNING yields no row (row
 * security or anything else filtered it) or, for the toggle, a row without the requested value;
 * on success they return the row actually written. The refusal carries a read-only diagnostic
 * (billingWriteDiagnostic: row count, the session's write and membership checks, the role name and the
 * table's row-security metadata; booleans, counts and names only, never an id) so the owner can see why
 * the database did not apply the change (owner 2026-11-01, "add the billing diagnostic").
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { billingWriteDiagnostic, saveTenantBillingAuthorization, toggleTenantAutoDebit } from '../functions/api/tenant-settings-handlers.mjs';
import { SET_MONEY_WRITE_SQL } from '../functions/api/money-write-flag.mjs';

const HANDLERS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../functions/api/tenant-settings-handlers.mjs');
const TENANT = '33333333-3333-4333-8333-333333333333';
const USER = '44444444-4444-4444-8444-444444444444';
const STAKEHOLDER = '55555555-5555-4555-8555-555555555555';
const EXISTING = { id: 'b1', tenant_id: TENANT, auto_debit_enabled: true, verification_status: 'verified', routing_number: '', account_number_encrypted: '' };

/** A fake pg client: `routes` maps a SQL pattern to the rows it returns; everything else returns []. */
const fakeClient = (routes) => {
  const queries = [];
  return {
    queries,
    query: async (sql, params = []) => {
      const text = String(sql);
      queries.push({ sql: text, params });
      for (const [pattern, rows] of routes) {
        if (pattern.test(text)) return { rows: typeof rows === 'function' ? rows(params) : rows };
      }
      return { rows: [] };
    },
  };
};
const SELECT_BILLING = /^\s*SELECT[\s\S]*FROM public\.tenant_billing_accounts/;
const UPDATE_BILLING = /UPDATE public\.tenant_billing_accounts/;
const INSERT_BILLING = /INSERT INTO public\.tenant_billing_accounts/;
const UUID_IN_TEXT = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const DIAGNOSTIC_KEYS = ['row_visible', 'can_write_tenant', 'is_tenant_member', 'auth_uid_set', 'auth_uid_matches_caller', 'current_user', 'policies', 'rls_enabled', 'rls_forced', 'triggers', 'rules', 'policy_detail', 'trigger_fn_detail', 'fn_overloads', 'trial_update', 'lock_probe'];
const assertDiagnosticShape = (diagnostic, { returned = false } = {}) => {
  assert.ok(diagnostic && typeof diagnostic === 'object', 'diagnostic present');
  assert.deepEqual(Object.keys(diagnostic), returned ? [...DIAGNOSTIC_KEYS, 'returned_row', 'returned_auto_debit_enabled'] : DIAGNOSTIC_KEYS);
  // Never an id in the diagnostic.
  assert.doesNotMatch(JSON.stringify(diagnostic), UUID_IN_TEXT);
};

const STAKEHOLDER_ROW = [{
  id: STAKEHOLDER, tenant_id: TENANT, nickname: 'Ops', custname: 'Freedom Adjustment', acct_type: 'C',
  chk_acct: '000123456789', chk_aba: '021000021', verification_status: 'verified', is_active: true,
}];

test('toggle: an update that changes no row is refused, not reported as updated', async () => {
  const client = fakeClient([[SELECT_BILLING, [EXISTING]], [UPDATE_BILLING, []]]);
  const result = await toggleTenantAutoDebit(client, { tenantId: TENANT, enabled: false, userId: USER });
  assert.equal(result.ok, false);
  assert.equal(result.statusCode, 409);
  assert.equal(result.error, 'billing_update_not_applied');
  assertDiagnosticShape(result.diagnostic, { returned: true });
  assert.equal(result.diagnostic.returned_row, false);
});

test('toggle: a returned row that does not hold the requested value is refused', async () => {
  const client = fakeClient([[SELECT_BILLING, [EXISTING]], [UPDATE_BILLING, [{ ...EXISTING, auto_debit_enabled: true }]]]);
  const result = await toggleTenantAutoDebit(client, { tenantId: TENANT, enabled: false, userId: USER });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'billing_update_not_applied');
  assertDiagnosticShape(result.diagnostic, { returned: true });
  assert.equal(result.diagnostic.returned_row, true);
  assert.equal(result.diagnostic.returned_auto_debit_enabled, true);
});

test('toggle: success returns the row actually written', async () => {
  const client = fakeClient([[SELECT_BILLING, [EXISTING]], [UPDATE_BILLING, [{ ...EXISTING, auto_debit_enabled: false }]]]);
  const result = await toggleTenantAutoDebit(client, { tenantId: TENANT, enabled: false });
  assert.equal(result.ok, true);
  assert.equal(result.authorization.id, 'b1');
  assert.equal(result.authorization.auto_debit_enabled, false);
});

test('toggle: no billing row at all is still missing_authorization (404)', async () => {
  const client = fakeClient([]);
  const result = await toggleTenantAutoDebit(client, { tenantId: TENANT, enabled: false });
  assert.deepEqual(result, { ok: false, statusCode: 404, error: 'missing_authorization' });
});

test('save: an UPDATE that returns no row is refused', async () => {
  const client = fakeClient([[/FROM public\.stakeholder_accounts/, STAKEHOLDER_ROW], [SELECT_BILLING, [EXISTING]], [UPDATE_BILLING, []]]);
  const result = await saveTenantBillingAuthorization(client, { tenantId: TENANT, userId: USER, stakeholderId: STAKEHOLDER, authorized: true });
  assert.equal(result.ok, false);
  assert.equal(result.statusCode, 409);
  assert.equal(result.error, 'billing_update_not_applied');
  assertDiagnosticShape(result.diagnostic, { returned: true });
  assert.ok(client.queries.some((q) => UPDATE_BILLING.test(q.sql)));
});

test('save: an INSERT that returns no row is refused', async () => {
  const client = fakeClient([[/FROM public\.stakeholder_accounts/, STAKEHOLDER_ROW], [INSERT_BILLING, []]]);
  const result = await saveTenantBillingAuthorization(client, { tenantId: TENANT, userId: USER, stakeholderId: STAKEHOLDER, authorized: true });
  assert.equal(result.ok, false);
  assert.equal(result.statusCode, 409);
  assert.equal(result.error, 'billing_update_not_applied');
  assertDiagnosticShape(result.diagnostic, { returned: true });
  assert.ok(client.queries.some((q) => INSERT_BILLING.test(q.sql)));
});

test('save: success returns the row actually written', async () => {
  const written = { ...EXISTING, id: 'b2', stakeholder_account_id: STAKEHOLDER, auto_debit_enabled: true, ach_authorized_at: '2026-11-01T00:00:00.000Z' };
  const client = fakeClient([[/FROM public\.stakeholder_accounts/, STAKEHOLDER_ROW], [INSERT_BILLING, [written]]]);
  const result = await saveTenantBillingAuthorization(client, { tenantId: TENANT, userId: USER, stakeholderId: STAKEHOLDER, authorized: true });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.authorization.id, 'b2');
  assert.equal(result.authorization.stakeholder_account_id, STAKEHOLDER);
});

const TRIGGERS = [
  { name: 'update_tenant_billing_accounts_updated_at', timing: 'BEFORE', events: 'UPDATE', level: 'ROW', enabled: 'O', fn: 'public.update_updated_at_column', fn_returns_null_on_some_path: false },
];
const RULES = [{ name: 'tenant_billing_accounts_noop', is_instead: true, nothing: true }];
const POLICY_DETAIL = [
  { name: 'aws_write_tenant_billing_accounts', cmd: 'ALL', permissive: 'PERMISSIVE', roles: ['authenticated'], qual_sha256: '2523b078754a', check_sha256: '2523b078754a', calls_can_write_tenant: true, qual_fn_names: ['public.aws_can_write_tenant'] },
];
const TRIGGER_FN_DETAIL = [
  { name: 'update_tenant_billing_accounts_updated_at', fn: 'public.update_updated_at_column', lang: 'plpgsql', secdef: true, prosrc_sha256: 'c10d3ecdb68d', prosrc_matches_repo: true },
];
const FN_OVERLOADS = { count: 1, args: ['_tenant_id uuid'] };
const LOCK_SQL = 'SELECT count(*)::int AS v FROM (SELECT 1 FROM public.tenant_billing_accounts WHERE tenant_id = $1::uuid FOR UPDATE) s';

test('diagnostic: read-only probes in savepoints, ids only as bound parameters, values passed through', async () => {
  const POLICIES = [{ name: 'aws_write_tenant_billing_accounts', permissive: 'PERMISSIVE', cmd: 'ALL', roles: ['authenticated'] }];
  const client = fakeClient([
    // The policy, trigger-function and overload probes first: they also name pg_policies, pg_trigger and
    // aws_can_write_tenant, which the earlier routes match.
    [/'qual_sha256'/, [{ v: POLICY_DETAIL }]],
    [/'prosrc_sha256'/, [{ v: TRIGGER_FN_DETAIL }]],
    [/pg_get_function_identity_arguments/, [{ v: FN_OVERLOADS }]],
    [/FOR UPDATE\) s$/, [{ v: 1 }]],
    [/count\(\*\)::int AS v FROM public\.tenant_billing_accounts/, [{ v: 1 }]],
    [/aws_can_write_tenant/, [{ v: false }]],
    [/aws_is_tenant_member/, [{ v: true }]],
    [/auth\.uid\(\) IS NOT NULL/, [{ v: true }]],
    [/IS NOT DISTINCT FROM/, [{ v: true }]],
    [/current_user/, [{ v: 'checksops' }]],
    [/pg_policies/, [{ v: POLICIES }]],
    [/relrowsecurity/, [{ v: true }]],
    [/relforcerowsecurity/, [{ v: false }]],
    [/pg_trigger/, [{ v: TRIGGERS }]],
    [/pg_rules/, [{ v: RULES }]],
    [UPDATE_BILLING, [{ '?column?': 1 }]],
  ]);
  const diagnostic = await billingWriteDiagnostic(client, { tenantId: TENANT, userId: USER });
  assert.deepEqual(diagnostic, {
    row_visible: 1, can_write_tenant: false, is_tenant_member: true, auth_uid_set: true, auth_uid_matches_caller: true,
    current_user: 'checksops', policies: POLICIES, rls_enabled: true, rls_forced: false,
    triggers: TRIGGERS, rules: RULES, policy_detail: POLICY_DETAIL, trigger_fn_detail: TRIGGER_FN_DETAIL, fn_overloads: FN_OVERLOADS,
    trial_update: { rows: 1 }, lock_probe: { rows: 1 },
  });
  // Every catalog probe is a SELECT inside its own savepoint; the one write is the no-op trial, rolled back, and the
  // lock probe is a SELECT ... FOR UPDATE, rolled back too.
  const probes = client.queries.filter((q) => !/SAVEPOINT/.test(q.sql) && !UPDATE_BILLING.test(q.sql) && q.sql !== SET_MONEY_WRITE_SQL);
  assert.equal(probes.length, 15);
  for (const q of probes) assert.match(q.sql, /^\s*SELECT\b/);
  assert.equal(client.queries.filter((q) => /^SAVEPOINT billing_diag_/.test(q.sql)).length, 16);
  assert.equal(client.queries.filter((q) => /^RELEASE SAVEPOINT billing_diag_/.test(q.sql)).length, 14);
  // The trial update is a no-op on this tenant's row, bound by parameter, and always rolled back to its savepoint.
  const sqls = client.queries.map((q) => q.sql);
  const trialAt = sqls.findIndex((q) => UPDATE_BILLING.test(q));
  assert.ok(trialAt > 0);
  // Flagged like the refused write it diagnoses, inside the savepoint so the rollback clears the flag again.
  assert.equal(sqls[trialAt - 2], 'SAVEPOINT billing_diag_trial_update');
  assert.equal(sqls[trialAt - 1], SET_MONEY_WRITE_SQL);
  assert.equal(sqls.filter((q) => q === SET_MONEY_WRITE_SQL).length, 1);
  assert.equal(sqls[trialAt + 1], 'ROLLBACK TO SAVEPOINT billing_diag_trial_update');
  assert.match(sqls[trialAt], /SET updated_at = updated_at WHERE tenant_id = \$1::uuid RETURNING 1$/);
  assert.deepEqual(client.queries[trialAt].params, [TENANT]);
  assert.equal(sqls.includes('RELEASE SAVEPOINT billing_diag_trial_update'), false);
  // The lock probe: this tenant's row FOR UPDATE, bound by parameter, unflagged, always rolled back to its savepoint.
  const lockAt = sqls.indexOf(LOCK_SQL);
  assert.ok(lockAt > trialAt);
  assert.equal(sqls[lockAt - 1], 'SAVEPOINT billing_diag_lock_probe');
  assert.equal(sqls[lockAt + 1], 'ROLLBACK TO SAVEPOINT billing_diag_lock_probe');
  assert.deepEqual(client.queries[lockAt].params, [TENANT]);
  assert.equal(sqls.includes('RELEASE SAVEPOINT billing_diag_lock_probe'), false);
  // The policy and trigger-function probes hash the expression and body text; they never return it.
  const detail = probes.filter((q) => /'qual_sha256'|'prosrc_sha256'/.test(q.sql)).map((q) => q.sql).join('\n');
  assert.match(detail, /'qual_sha256', left\(encode\(sha256\(convert_to\(pg_get_expr\(p\.polqual, p\.polrelid\), 'UTF8'\)\), 'hex'\), 12\)/);
  assert.match(detail, /'check_sha256', left\(encode\(sha256\(convert_to\(pg_get_expr\(p\.polwithcheck, p\.polrelid\), 'UTF8'\)\), 'hex'\), 12\)/);
  assert.match(detail, /'prosrc_sha256', left\(encode\(sha256\(convert_to\(p\.prosrc, 'UTF8'\)\), 'hex'\), 12\)/);
  assert.match(detail, /to_regprocedure\('public\.aws_can_write_tenant\(uuid\)'\)/);
  assert.match(detail, /= 'BEGIN NEW\.updated_at = NOW\(\); RETURN NEW; END;'\)/);
  for (const field of ['polqual', 'polwithcheck', 'prosrc']) {
    // Every use of an expression or body column is inside sha256(...) or a comparison, never a returned value.
    assert.doesNotMatch(detail, new RegExp(`'[a-z_]+', (p\\.)?${field}\\b`));
    assert.doesNotMatch(detail, new RegExp(`'[a-z_]+', pg_get_expr\\((p\\.)?${field}`));
  }
  // The trigger and rule probes read names and flags only: never the function body or the rule definition.
  const catalog = probes.filter((q) => /pg_trigger|pg_rules/.test(q.sql)).map((q) => q.sql).join('\n');
  assert.match(catalog, /p\.prosrc ~\* 'return\\s\+null'/);
  assert.doesNotMatch(catalog, /'(body|prosrc|definition|source)',/);
  assert.match(catalog, /WHERE t\.tgrelid = 'public\.tenant_billing_accounts'::regclass AND NOT t\.tgisinternal/);
  // The tenant and caller ids are bound parameters only.
  assert.deepEqual(probes.find((q) => /aws_can_write_tenant/.test(q.sql)).params, [TENANT]);
  assert.deepEqual(probes.find((q) => /IS NOT DISTINCT FROM/.test(q.sql)).params, [USER]);
  for (const q of probes) assert.doesNotMatch(q.sql, UUID_IN_TEXT);
});

test('diagnostic: a failing probe reports its SQLSTATE, rolls back its savepoint, and does not throw or stop the rest', async () => {
  const queries = [];
  const client = {
    query: async (sql, params = []) => {
      queries.push(String(sql));
      if (/aws_can_write_tenant/.test(sql)) {
        const error = new Error('permission denied for function aws_can_write_tenant');
        error.code = '42501';
        throw error;
      }
      if (/current_user/.test(sql)) return { rows: [{ v: 'checksops' }] };
      return { rows: [] };
    },
  };
  const diagnostic = await billingWriteDiagnostic(client, { tenantId: TENANT, userId: USER });
  assert.deepEqual(diagnostic.can_write_tenant, { error: '42501' });
  assert.equal(diagnostic.current_user, 'checksops');
  assert.equal(diagnostic.row_visible, null);
  assert.ok(queries.includes('ROLLBACK TO SAVEPOINT billing_diag_can_write_tenant'));
  // The empty fake catalog leaves the trigger and rule probes null; the trial reports zero rows.
  assert.equal(diagnostic.triggers, null);
  assert.equal(diagnostic.rules, null);
  assert.deepEqual(diagnostic.trial_update, { rows: 0 });
  // The policy, trigger-function and overload probes read nothing from the empty fake catalog; the lock finds no row.
  assert.equal(diagnostic.trigger_fn_detail, null);
  assert.deepEqual(diagnostic.lock_probe, { rows: 0 });
  assert.doesNotMatch(JSON.stringify(diagnostic), /permission denied/);
});

test('diagnostic: failing trigger, rule and trial probes report their SQLSTATE only, and the trial still rolls back', async () => {
  const queries = [];
  const fail = (code, message) => { const error = new Error(message); error.code = code; throw error; };
  const client = {
    query: async (sql) => {
      queries.push(String(sql));
      if (/pg_trigger/.test(sql)) fail('42501', 'permission denied for table pg_trigger');
      if (/pg_rules/.test(sql)) fail('42P01', 'relation pg_rules does not exist');
      if (UPDATE_BILLING.test(sql)) fail('P0001', 'trigger raised: blocked for tenant ' + TENANT);
      return { rows: [] };
    },
  };
  const diagnostic = await billingWriteDiagnostic(client, { tenantId: TENANT, userId: USER });
  assert.deepEqual(diagnostic.triggers, { error: '42501' });
  assert.deepEqual(diagnostic.rules, { error: '42P01' });
  assert.deepEqual(diagnostic.trial_update, { error: 'P0001' });
  assert.ok(queries.includes('ROLLBACK TO SAVEPOINT billing_diag_triggers'));
  assert.ok(queries.includes('ROLLBACK TO SAVEPOINT billing_diag_rules'));
  assert.equal(queries[queries.findIndex((q) => UPDATE_BILLING.test(q)) + 1], 'ROLLBACK TO SAVEPOINT billing_diag_trial_update');
  // No error message, and so no id it may carry, reaches the diagnostic.
  assert.doesNotMatch(JSON.stringify(diagnostic), /permission denied|does not exist|trigger raised/);
  assert.doesNotMatch(JSON.stringify(diagnostic), UUID_IN_TEXT);
});

test('diagnostic: failing policy, trigger-function, overload and lock probes report their SQLSTATE only, and the lock still rolls back', async () => {
  const queries = [];
  const fail = (code, message) => { const error = new Error(message); error.code = code; throw error; };
  const client = {
    query: async (sql) => {
      queries.push(String(sql));
      if (/'qual_sha256'/.test(sql)) fail('42883', 'function sha256(bytea) does not exist');
      if (/'prosrc_sha256'/.test(sql)) fail('42501', 'permission denied for table pg_proc');
      if (/pg_get_function_identity_arguments/.test(sql)) fail('XX000', 'cache lookup failed');
      if (/FOR UPDATE\) s$/.test(sql)) fail('55P03', 'could not obtain lock on row for tenant ' + TENANT);
      return { rows: [] };
    },
  };
  const diagnostic = await billingWriteDiagnostic(client, { tenantId: TENANT, userId: USER });
  assert.deepEqual(diagnostic.policy_detail, { error: '42883' });
  assert.deepEqual(diagnostic.trigger_fn_detail, { error: '42501' });
  assert.deepEqual(diagnostic.fn_overloads, { error: 'XX000' });
  assert.deepEqual(diagnostic.lock_probe, { error: '55P03' });
  for (const key of ['policy_detail', 'trigger_fn_detail', 'fn_overloads']) assert.ok(queries.includes(`ROLLBACK TO SAVEPOINT billing_diag_${key}`), key);
  assert.equal(queries[queries.indexOf(LOCK_SQL) + 1], 'ROLLBACK TO SAVEPOINT billing_diag_lock_probe');
  // The trial update still ran and reported; nothing aborted the rest.
  assert.deepEqual(diagnostic.trial_update, { rows: 0 });
  assert.doesNotMatch(JSON.stringify(diagnostic), /does not exist|permission denied|cache lookup|could not obtain/);
  assert.doesNotMatch(JSON.stringify(diagnostic), UUID_IN_TEXT);
});

test('diagnostic: a caller id that is not a uuid is never sent', async () => {
  const client = fakeClient([]);
  await billingWriteDiagnostic(client, { tenantId: TENANT, userId: 'not-a-uuid' });
  assert.deepEqual(client.queries.find((q) => /IS NOT DISTINCT FROM/.test(q.sql)).params, [null]);
});

test('success paths carry no diagnostic', async () => {
  const toggled = await toggleTenantAutoDebit(fakeClient([[SELECT_BILLING, [EXISTING]], [UPDATE_BILLING, [{ ...EXISTING, auto_debit_enabled: false }]]]), { tenantId: TENANT, enabled: false, userId: USER });
  assert.equal(toggled.ok, true);
  assert.equal('diagnostic' in toggled, false);
  const written = { ...EXISTING, id: 'b2', stakeholder_account_id: STAKEHOLDER, auto_debit_enabled: true };
  const saved = await saveTenantBillingAuthorization(fakeClient([[/FROM public\.stakeholder_accounts/, STAKEHOLDER_ROW], [INSERT_BILLING, [written]]]), { tenantId: TENANT, userId: USER, stakeholderId: STAKEHOLDER, authorized: true });
  assert.equal(saved.ok, true);
  assert.equal('diagnostic' in saved, false);
  // The route passes the caller to the toggle so the diagnostic can compare it.
  assert.match(fs.readFileSync(HANDLERS, 'utf8'), /enabled: body\.auto_debit_enabled === true,\s*userId: mapping\.application_user_id,/);
});

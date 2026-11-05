/**
 * Owner report 2026-11-04: editing a mortgage company (Manager, and a Loss Draft check) failed with
 * "Failed to update company". MortgageCompanyEditorDialog saves contact and mailing-address columns
 * that the mortgage_companies write allowlist did not list, so the API refused the whole write with
 * column_not_allowlisted. Every column the dialog writes must be allowlisted; nothing else changes.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { WRITE_ALLOWLIST, pickAllowlistedValues } from '../functions/api/write-allowlist.mjs';

const dialog = readFileSync(new URL('../../src/components/checks/MortgageCompanyEditorDialog.tsx', import.meta.url), 'utf8');
const payloadBlock = dialog.slice(dialog.indexOf('const payload = {'), dialog.indexOf('};', dialog.indexOf('const payload = {')));
const dialogColumns = [...payloadBlock.matchAll(/^\s*([a-z_0-9]+):/gm)].map((m) => m[1]);

test('1 the dialog payload is what the allowlist must cover', () => {
  assert.deepEqual(dialogColumns.sort(), [
    'address_line_1', 'address_line_2', 'address_line_3', 'address_line_4', 'address_line_5',
    'contact_name', 'email', 'mortgage_site', 'name', 'phone', 'phone_extension',
  ]);
});

test('2 every column the dialog writes is allowlisted, so its insert and update pass', () => {
  const values = Object.fromEntries(dialogColumns.map((c) => [c, c === 'name' ? 'Acme Mortgage' : null]));
  const picked = pickAllowlistedValues('mortgage_companies', values);
  assert.equal(picked.error, undefined, JSON.stringify(picked));
  assert.deepEqual(Object.keys(picked.values).sort(), [...dialogColumns].sort());
});

test('3 the table keeps its ops, filter and other columns; unknown columns are still refused', () => {
  const spec = WRITE_ALLOWLIST.mortgage_companies;
  // delete: SQL 143 (owner decision 2026-11-05, "Remove should delete it", delete only when unused).
  assert.deepEqual([...spec.ops].sort(), ['delete', 'insert', 'update']);
  assert.deepEqual([...spec.filterColumns], ['id']);
  for (const c of ['website', 'is_active', 'loss_draft_email', 'loss_draft_phone', 'loss_draft_fax', 'loss_draft_contact']) {
    assert.ok(spec.columns.has(c), c);
  }
  const refused = pickAllowlistedValues('mortgage_companies', { name: 'X', tenant_secret: 'y' });
  assert.equal(refused.error, 'column_not_allowlisted');
  assert.deepEqual(refused.columns, ['tenant_secret']);
});

// The executor must write what the allowlist lets through: otherwise the dialog reports
// "Company updated" while the contact and address are silently dropped.
const { executeMortgageCompanies } = await import('../functions/api/write-app-metadata.mjs');
const ID = '11111111-2222-4333-8444-555555555555';
const recorder = () => {
  const calls = [];
  return { calls, client: { query: async (sql, params) => { calls.push({ sql, params }); return { rows: [{ id: ID }] }; } } };
};
const dialogValues = {
  name: 'Acme Mortgage', contact_name: 'Pat Lee', phone: '555-0100', phone_extension: '12',
  email: 'ld@acme.test', mortgage_site: 'https://acme.test', address_line_1: 'PO Box 1',
  address_line_2: 'Attn Loss Draft', address_line_3: null, address_line_4: null, address_line_5: null,
};

test('4 update writes every dialog column with its value', async () => {
  const { calls, client } = recorder();
  const out = await executeMortgageCompanies({ client, op: 'update', values: dialogValues, filters: [{ column: 'id', op: 'eq', value: ID }] });
  assert.equal(out.error, undefined, JSON.stringify(out));
  assert.equal(calls.length, 1);
  for (const [col, value] of Object.entries(dialogValues)) {
    assert.match(calls[0].sql, new RegExp(`"?${col}"? = \\$\\d+::text`), col);
    assert.ok(calls[0].params.includes(value), col);
  }
  assert.equal(calls[0].params.at(-1), ID);
});

test('5 insert writes every dialog column and keeps is_active true by default', async () => {
  const { calls, client } = recorder();
  const out = await executeMortgageCompanies({ client, op: 'insert', values: dialogValues, filters: [] });
  assert.equal(out.error, undefined, JSON.stringify(out));
  const cols = calls[0].sql.slice(calls[0].sql.indexOf('(') + 1, calls[0].sql.indexOf(')')).split(',').map((c) => c.trim().replaceAll('"', ''));
  assert.deepEqual([...cols].sort(), [...Object.keys(dialogValues), 'is_active'].sort());
  assert.equal(calls[0].params[cols.indexOf('is_active')], true);
  assert.equal(calls[0].params[cols.indexOf('contact_name')], 'Pat Lee');
  // The Loss Draft desk insert (no dialog columns) still writes what it wrote before.
  const desk = recorder();
  await executeMortgageCompanies({ client: desk.client, op: 'insert', values: { name: 'B', loss_draft_email: 'x@y.test', is_active: false }, filters: [] });
  assert.match(desk.calls[0].sql, /name/);
  assert.ok(desk.calls[0].params.includes(false));
});

test('6 length caps and the name requirement still refuse', async () => {
  const { calls, client } = recorder();
  assert.deepEqual(await executeMortgageCompanies({ client, op: 'insert', values: { contact_name: 'x' }, filters: [] }), { error: 'missing_required_field', field: 'name' });
  assert.deepEqual(await executeMortgageCompanies({ client, op: 'update', values: { address_line_1: 'x'.repeat(201) }, filters: [{ column: 'id', op: 'eq', value: ID }] }), { error: 'invalid_field', field: 'length' });
  assert.equal(calls.length, 0);
});

// Owner decisions 2026-11-05: "Remove should delete it ... anyone can do this, mortgage agents should be able to
// share and edit list", then "1": delete only when no claim, loss draft or check case uses the company; otherwise
// refuse ("This company is used by N files"), nothing deleted or unlinked. SQL 143's trigger enforces it in the
// database (SQLSTATE MC143, DETAIL the counts as JSON); the API maps that refusal to a 409.
const { mortgageCompanyInUse } = await import('../functions/api/write-app-metadata.mjs');
const inUseError = (files, extra = {}) => Object.assign(new Error(`sql143_company_in_use: this company is used by ${files} files`), {
  code: 'MC143', detail: JSON.stringify({ files, claims: files, loss_drafts: 0, check_cases: 0 }), ...extra,
});
const throwing = (error) => {
  const calls = [];
  return { calls, client: { query: async (sql, params) => { calls.push({ sql, params }); throw error; } } };
};
const byId = [{ column: 'id', op: 'eq', value: ID }];

test('7 delete by id deletes the one row and returns it', async () => {
  const { calls, client } = recorder();
  const out = await executeMortgageCompanies({ client, op: 'delete', values: {}, filters: byId });
  assert.deepEqual(out, { rows: [{ id: ID }] });
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /^DELETE FROM public\.mortgage_companies WHERE id = \$1::uuid RETURNING \*$/);
  assert.deepEqual(calls[0].params, [ID]);
});

test('8 a company in use answers 409 mortgage_company_in_use with the count; nothing else is tried', async () => {
  for (const files of [1, 3]) {
    const { calls, client } = throwing(inUseError(files));
    const out = await executeMortgageCompanies({ client, op: 'delete', values: {}, filters: byId });
    assert.deepEqual(out, {
      error: 'mortgage_company_in_use',
      statusCode: 409,
      files,
      message: `This company is used by ${files} ${files === 1 ? 'file' : 'files'}`,
    });
    assert.equal(calls.length, 1);
  }
  // Without a readable DETAIL the count comes from the message; without either it is not invented.
  assert.equal(mortgageCompanyInUse(inUseError(4, { detail: undefined })).files, 4);
  const bare = mortgageCompanyInUse({ code: 'MC143', message: 'x' });
  assert.equal(bare.files, null);
  assert.equal(bare.statusCode, 409);
  assert.equal(mortgageCompanyInUse({ code: '23503', message: 'fk' }), null);
});

test('9 delete refuses a bad id before the database; no row (RLS) is rls_denied; other errors are not hidden', async () => {
  const none = recorder();
  assert.deepEqual(await executeMortgageCompanies({ client: none.client, op: 'delete', values: {}, filters: [{ column: 'id', op: 'eq', value: 'x' }] }), { error: 'invalid_uuid', field: 'id' });
  assert.equal(none.calls.length, 0);
  const empty = { query: async () => ({ rows: [] }) };
  assert.deepEqual(await executeMortgageCompanies({ client: empty, op: 'delete', values: {}, filters: byId }), { error: 'rls_denied', message: 'mortgage company not deletable' });
  const other = Object.assign(new Error('boom'), { code: '57014' });
  await assert.rejects(executeMortgageCompanies({ client: throwing(other).client, op: 'delete', values: {}, filters: byId }), /boom/);
});

test('10 the directory Remove deletes by id and shows the in-use message, keeping the row', () => {
  const page = readFileSync(new URL('../../src/pages/mortgage-ops/MortgageOpsDirectory.tsx', import.meta.url), 'utf8');
  const remove = page.slice(page.indexOf('const confirmDeactivate'), page.indexOf('return (', page.indexOf('const confirmDeactivate')));
  assert.match(remove, /\.from\("mortgage_companies"\)\s*\.delete\(\)\s*\.eq\("id", deactivateTarget\.id\)/);
  assert.doesNotMatch(remove, /is_active: false/);
  assert.match(remove, /code === "mortgage_company_in_use"/);
  assert.match(remove, /toast\.error\(inUse \? error\.message : "Failed to remove company"\)/);
  // The list reloads only after a successful delete.
  assert.ok(remove.indexOf('fetchCompanies()') > remove.indexOf('} else {'));
  assert.match(page, /cannot be removed/);
});

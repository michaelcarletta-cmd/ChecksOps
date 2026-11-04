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
  assert.deepEqual([...spec.ops].sort(), ['insert', 'update']);
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

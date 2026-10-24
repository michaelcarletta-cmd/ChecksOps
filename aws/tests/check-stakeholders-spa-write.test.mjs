/**
 * Adding a payee from a claim check links it with a browser insert into
 * check_stakeholders (AddExternalStakeholderDialog, CheckStakeholdersManager).
 * On AWS the client refused that insert with writes_disabled before it reached
 * /data/write, because the table was missing from AWS_WRITE_TABLES. Pins the
 * client entry and that the server allowlist it relies on stays narrow.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const clientWriteTables = () => {
  const match = read('src/integrations/aws/client.ts').match(/const AWS_WRITE_TABLES = new Set\(\[([\s\S]*?)\]\)/);
  assert.ok(match, 'AWS_WRITE_TABLES Set not found');
  return [...match[1].matchAll(/"([^"]+)"/g)].map((row) => row[1]);
};

test('client AWS_WRITE_TABLES lets the browser link a stakeholder to a check', () => {
  assert.ok(clientWriteTables().includes('check_stakeholders'));
});

test('the claim-check payee dialog and the stakeholder manager write check_stakeholders', () => {
  assert.match(read('src/components/disbursement/AddExternalStakeholderDialog.tsx'), /from\("check_stakeholders"\)\.insert\(/);
  const manager = read('src/components/disbursement/CheckStakeholdersManager.tsx');
  assert.match(manager, /from\("check_stakeholders"\)\.insert\(/);
  assert.match(manager, /from\("check_stakeholders"\)\.delete\(\)/);
});

test('server allowlist for check_stakeholders stays insert/delete on the two link columns', async () => {
  const { WRITE_ALLOWLIST } = await import('../functions/api/write-allowlist.mjs');
  const spec = WRITE_ALLOWLIST.check_stakeholders;
  assert.ok(spec, 'check_stakeholders must stay on the server allowlist');
  assert.deepEqual([...spec.ops].sort(), ['delete', 'insert']);
  assert.deepEqual([...spec.columns].sort(), ['check_intake_item_id', 'stakeholder_account_id']);
  assert.equal(spec.identityColumn, 'added_by');
});

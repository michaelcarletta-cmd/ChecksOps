/**
 * Same-name stakeholders and Settings disconnect on AWS.
 * - The check's stakeholder picker shows each saved stakeholder's email and
 *   verification status, so a verified payee is told apart from a re-invited
 *   one with the same name.
 * - Settings unlinks a removed stakeholder from its checks one check_stakeholders
 *   row at a time by id: /data/write filters check_stakeholders deletes on id
 *   only, and refused the stakeholder_account_id filter with column_not_allowlisted.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('check stakeholder picker reads and shows email and verification status', () => {
  const src = read('src/components/disbursement/CheckStakeholdersManager.tsx');
  assert.match(src, /\.select\("id, nickname, account_type, chk_acct, custname, homeowner_name, verification_status, verification_recipient_email, homeowner_email"\)/);
  assert.match(src, /const email = a\.verification_recipient_email \|\| a\.homeowner_email \|\| null;/);
  assert.match(src, /\{VERIFICATION_LABEL\[vStatus\]\}/);
});

test('Settings unlinks check_stakeholders by id, never by stakeholder_account_id', () => {
  const src = read('src/components/disbursement/StakeholderAccountSettings.tsx');
  assert.doesNotMatch(src, /from\("check_stakeholders"\)\s*\.delete\(\)\s*\.eq\("stakeholder_account_id"/);
  assert.match(src, /from\("check_stakeholders"\)\s*\.select\("id"\)\s*\.eq\("stakeholder_account_id", id\)/);
  assert.match(src, /from\("check_stakeholders"\)\.delete\(\)\.eq\("id", link\.id\)/);
});

test('Settings hides disconnected payees until the owner asks to see them', () => {
  const src = read('src/components/disbursement/StakeholderAccountSettings.tsx');
  assert.match(src, /const \[showDisconnected, setShowDisconnected\] = useState\(false\);/);
  assert.match(src, /\{showDisconnected \? "Hide" : "Show"\} disconnected payees \(\{disconnectedPayees\.length\}\)/);
  assert.match(src, /\{showDisconnected && disconnectedPayees\.map\(/);
});

test('server allowlist still filters check_stakeholders deletes on id only', async () => {
  const { WRITE_ALLOWLIST } = await import('../functions/api/write-allowlist.mjs');
  assert.deepEqual([...WRITE_ALLOWLIST.check_stakeholders.filterColumns], ['id']);
});

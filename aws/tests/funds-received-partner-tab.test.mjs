import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');

const asFundsReceivedRows = (data) => (Array.isArray(data) ? data : []);
const incomingSplitsForCheck = (data, checkId) => asFundsReceivedRows(data)
  .filter((row) => row.check_intake_item_id === checkId);

const SAMPLE_CHECK = '3f60998b-ac56-4cea-8899-6363309d4bbf';
const AUTHORIZED_SPLIT = 'ce3ba146-01a0-41f0-a7de-7fae966efe60';
const UNAUTHORIZED_SPLIT = '8bbbc70d-8bd1-4b9e-a506-5b5406fb6ad2';

const rpcRowsForViewer = [
  {
    id: AUTHORIZED_SPLIT,
    amount: 23259.16,
    check_intake_item_id: SAMPLE_CHECK,
    method: 'external_check',
  },
  {
    id: '99999999-9999-4999-8999-999999999999',
    amount: 100,
    check_intake_item_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    method: 'external_check',
  },
];

test('incomingSplitsForCheck associates only RPC-authorized rows for the current check', () => {
  const rows = incomingSplitsForCheck(rpcRowsForViewer, SAMPLE_CHECK);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, AUTHORIZED_SPLIT);
  assert.equal(Number(rows[0].amount), 23259.16);
  assert.equal(rows.some((r) => r.id === UNAUTHORIZED_SPLIT), false);
});

test('NULL-recipient owner split is not exposed unless the RPC independently returned it', () => {
  const rows = incomingSplitsForCheck(rpcRowsForViewer, SAMPLE_CHECK);
  assert.equal(rows.find((r) => r.id === UNAUTHORIZED_SPLIT), undefined);
  const ifRpcAuthorized = incomingSplitsForCheck([
    ...rpcRowsForViewer,
    { id: UNAUTHORIZED_SPLIT, amount: 34350, check_intake_item_id: SAMPLE_CHECK },
  ], SAMPLE_CHECK);
  assert.equal(ifRpcAuthorized.some((r) => r.id === UNAUTHORIZED_SPLIT), true);
});

test('check filter is tenant-generic and does not hardcode a partner UUID', () => {
  const otherCheck = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const otherSplit = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const rows = incomingSplitsForCheck([
    { id: otherSplit, amount: 5, check_intake_item_id: otherCheck },
    { id: AUTHORIZED_SPLIT, amount: 23259.16, check_intake_item_id: SAMPLE_CHECK },
  ], otherCheck);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, otherSplit);
});

test('non-array RPC payloads map to an empty incoming list instead of throwing', () => {
  assert.deepEqual(incomingSplitsForCheck({ id: AUTHORIZED_SPLIT }, SAMPLE_CHECK), []);
  assert.deepEqual(incomingSplitsForCheck(null, SAMPLE_CHECK), []);
});

test('FundsTab incoming path uses the recipient RPC, not owner disbursement tables', () => {
  const tab = fs.readFileSync(path.join(ROOT, 'src/components/payments/FundsTab.tsx'), 'utf8');
  assert.match(tab, /incomingSplitsForCheck/);
  assert.match(tab, /get_tenant_funds_received/);
  const incomingFn = tab.slice(tab.indexOf('queryKey: ["incoming-splits"'), tab.indexOf('queryKey: ["intake-pa-fee"'));
  assert.match(incomingFn, /get_tenant_funds_received/);
  assert.doesNotMatch(incomingFn, /\.from\("disbursement_splits"\)/);
  assert.doesNotMatch(incomingFn, /\.from\("disbursement_batches"\)/);
  assert.match(tab, /readOnly/);
  assert.match(tab, /if \(readOnly\) return;/);
});

test('CheckCommandCenter lane maps Funds Received through the array-safe helper', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/pages/CheckCommandCenter.tsx'), 'utf8');
  assert.match(src, /mapLaneFundsReceived/);
  assert.match(src, /readOnly/);
  assert.doesNotMatch(src, /\(\(data \?\? \[\]\) as any\[\]\)\.map/);
});

test('product repair files do not hardcode Condition One or Freedom tenant UUIDs', () => {
  const files = [
    'src/lib/fundsReceived.ts',
    'src/components/payments/FundsTab.tsx',
    'aws/functions/api/data.mjs',
  ];
  for (const rel of files) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.doesNotMatch(src, /4f172140-f57a-4744-8050-95f4f07b13b4/);
    assert.doesNotMatch(src, /2eff5f1a-929d-4ce3-9a8b-cd96b98df42a/);
  }
});

test('this repair does not modify or add protected partner-sharing SQL 31-34', () => {
  const changed = execFileSync('git', ['diff', '--name-only', 'origin/main'], { cwd: ROOT }).toString();
  assert.doesNotMatch(changed, /31_partner_safe_read\.sql/);
  assert.doesNotMatch(changed, /32_partner_share_lifecycle\.sql/);
  assert.doesNotMatch(changed, /33_partner_stage_totals\.sql/);
  assert.doesNotMatch(changed, /34_c1c_partner_visibility\.sql/);
});

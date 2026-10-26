import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  amountCents,
  checkNumberQueryValues,
  describeDuplicate,
  findDuplicateChecks,
  isDuplicatePair,
  normalizeCheckNumber,
} from '../../src/lib/duplicateChecks.ts';

const read = (file) => fs.readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');

test('check numbers compare without spaces, dashes, case or leading zeros', () => {
  assert.equal(normalizeCheckNumber('00-1234 5'), '12345');
  assert.equal(normalizeCheckNumber('123 45'), '12345');
  assert.equal(normalizeCheckNumber('ab-0012'), 'AB0012');
  assert.equal(normalizeCheckNumber('0000'), '0');
  assert.equal(normalizeCheckNumber(null), '');
  assert.equal(amountCents('5000.004'), 500000);
  assert.equal(amountCents(0), null);
  assert.equal(amountCents(''), null);
});

test('same number and same amount is a duplicate; different amount, carrier or missing data is not', () => {
  const a = { id: 'a', check_number: '001234', amount: 5000, carrier_name: 'State Farm' };
  assert.equal(isDuplicatePair(a, { id: 'b', check_number: '1234', amount: '5000.00', carrier_name: 'STATE FARM' }), true);
  assert.equal(isDuplicatePair(a, { id: 'b', check_number: '1234', amount: 5000, carrier_name: null }), true);
  assert.equal(isDuplicatePair(a, { id: 'b', check_number: '1234', amount: 5000.01, carrier_name: 'State Farm' }), false);
  assert.equal(isDuplicatePair(a, { id: 'b', check_number: '1234', amount: 5000, carrier_name: 'Allstate' }), false);
  assert.equal(isDuplicatePair(a, { id: 'b', check_number: '1235', amount: 5000 }), false);
  assert.equal(isDuplicatePair(a, { id: 'b', check_number: null, amount: 5000 }), false);
  assert.equal(isDuplicatePair({ id: 'x', check_number: '1', amount: null }, { id: 'y', check_number: '1', amount: null }), false);
  assert.equal(isDuplicatePair(a, a), false);
});

test('every copy is flagged with the others, oldest first; one row seen twice is not a duplicate', () => {
  const rows = [
    { id: 'new', check_number: '777', amount: 100, created_at: '2026-10-26T10:00:00Z' },
    { id: 'old', check_number: '777', amount: 100, created_at: '2026-10-01T10:00:00Z', deposited_at: '2026-10-02T10:00:00Z' },
    { id: 'mid', check_number: '0777', amount: 100, created_at: '2026-10-10T10:00:00Z' },
    { id: 'other', check_number: '777', amount: 250, created_at: '2026-10-05T10:00:00Z' },
    { id: 'solo', check_number: '888', amount: 100 },
    { id: 'solo', check_number: '888', amount: 100 },
  ];
  const dup = findDuplicateChecks(rows);
  assert.deepEqual(dup.get('new').map((r) => r.id), ['old', 'mid']);
  assert.deepEqual(dup.get('old').map((r) => r.id), ['mid', 'new']);
  assert.deepEqual(dup.get('mid').map((r) => r.id), ['old', 'new']);
  assert.equal(dup.has('other'), false);
  assert.equal(dup.has('solo'), false);
});

test('query values include each stored number and its normalized form', () => {
  assert.deepEqual(checkNumberQueryValues(['001234', ' 1234 ', null, '', 'AB-1']), ['001234', '1234', 'AB-1', 'AB1']);
});

test('the flag line names the other check and its state', () => {
  assert.equal(
    describeDuplicate({ id: 'o', check_number: '777', amount: 1250.5, created_at: '2026-10-01T10:00:00Z', deposited_at: '2026-10-02T00:00:00Z' }),
    'Check #777 · $1,250.50 · uploaded 10/01/2026 · Deposited',
  );
  assert.equal(
    describeDuplicate({ id: 'o', check_number: '777', amount: 10, created_at: '2026-10-01', check_stage: 'needs_review' }),
    'Check #777 · $10.00 · uploaded 10/01/2026 · Needs Review',
  );
});

test('wiring: queue rows show the badge, the detail panel shows the banner, the lookup covers the tenant', () => {
  const center = read('src/pages/CheckCommandCenter.tsx');
  assert.match(center, /const duplicateChecks = useDuplicateChecks\(tenantId, ownTenantChecks\)/);
  assert.match(center, /<DuplicateCheckBadge duplicates=\{duplicateChecks\.get\(check\.id\)\} \/>/);
  assert.match(center, /<DuplicateCheckBanner duplicates=\{checkDuplicates\} \/>/);
  const hook = read('src/hooks/useDuplicateChecks.ts');
  assert.match(hook, /\.eq\("tenant_id", tenantId!\)/);
  assert.match(hook, /\.in\("check_number", values\.slice\(i, i \+ 100\)\)/);
  assert.match(hook, /queryKey: \["check-duplicates", tenantId, values\]/);
});

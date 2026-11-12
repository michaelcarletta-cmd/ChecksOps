// Check Overview → Deposit Status (owner 2026-11-12): show only the deposit status and the deposited date; no
// "Deposited by <organization>" line (it read "Unknown organization" whenever the viewer could not read the depositor).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('Deposit Status shows the status and the deposited date, never the depositing organization', () => {
  const panel = read('src/components/check-review/DepositStatusPanel.tsx');
  assert.match(panel, /Deposit Status/);
  assert.match(panel, /Deposited on \{format\(new Date\(depositedAt!\), "MMM d, yyyy 'at' h:mm a"\)\}/);
  assert.match(panel, /Not yet deposited/);
  assert.doesNotMatch(panel, /Deposited by|Unknown organization|partner_code|from\("tenants"\)|useQuery/);
  // The prop the (release-locked) Overview still passes is accepted and ignored: nothing reads it.
  assert.match(panel, /depositedByTenantId\?: string \| null;/);
  assert.equal(panel.match(/depositedByTenantId/g).length, 1);
  assert.match(panel, /export function DepositStatusPanel\(\{ checkId, depositedAt, lastUpdated \}/);
});

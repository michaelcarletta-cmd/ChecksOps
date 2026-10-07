import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('queue Delete next to Share uses AdminDeleteCheckButton, not a direct-table mutation', () => {
  const src = read('src/pages/CheckCommandCenter.tsx');
  assert.match(src, /<Share2 className="h-3\.5 w-3\.5" \/>/);
  assert.match(src, /<AdminDeleteCheckButton/);
  assert.match(src, /canDeleteAnyCheck = isAdmin/);
  assert.doesNotMatch(src, /deleteCheckMutation/);
  assert.doesNotMatch(src, /confirm\("Delete this check\? This cannot be undone\."\)/);
  assert.doesNotMatch(src, /from\("check_intake_items"\)\.delete\(\)/);
  assert.doesNotMatch(src, /from\("claim_checks"\)\.delete\(\)\.eq\("check_intake_item_id"/);
});

test('Share-adjacent and Admin tools Delete both invoke the accepted admin_delete_check workflow', () => {
  const ccc = read('src/pages/CheckCommandCenter.tsx');
  const button = read('src/components/checks/AdminDeleteCheckButton.tsx');
  assert.match(button, /supabase\.rpc\("admin_delete_check"/);
  assert.match(button, /p_reason:\s*trimmed/);
  assert.match(button, /const reasonValid = trimmed\.length >= 3/);
  assert.match(button, /if \(!isAdmin\) return null/);
  assert.equal((ccc.match(/<AdminDeleteCheckButton/g) || []).length >= 3, true);
});

test('successful queue deletion invalidates intake + dashboard queries and removes the current item', () => {
  const src = read('src/pages/CheckCommandCenter.tsx');
  assert.match(src, /optimisticRemove\(qc, \[check\.id\]\)/);
  assert.match(src, /setSelectedCheck\(null\)/);
  assert.match(src, /invalidateQueries\(\{ queryKey: \["check-intake-items"\] \}\)/);
  assert.match(src, /invalidateQueries\(\{ queryKey: \["check-dashboard-counts"\] \}\)/);
});

test('Admin Settings / Admin tools Delete Check remains wired to AdminDeleteCheckButton', () => {
  const src = read('src/pages/CheckCommandCenter.tsx');
  assert.match(src, /Admin tools/);
  assert.match(src, /<AdminDeleteCheckButton[\s\S]*checkId=\{checkId\}/);
  const tracker = read('src/components/check-review/CheckReviewConsole.tsx');
  assert.match(tracker, /<AdminDeleteCheckButton/);
});

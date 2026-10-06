import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('Claim/check file Overview does not render Reviewed By', () => {
  const src = read('src/pages/CheckCommandCenter.tsx');
  assert.equal(src.includes('Reviewed By'), false);
  assert.doesNotMatch(src, /reviewer-profile/);
  assert.doesNotMatch(src, /reviewerProfile/);
});

test('Audit tab still owns review attribution and reviewer columns remain in stored selects', () => {
  const src = read('src/pages/CheckCommandCenter.tsx');
  assert.match(src, /TabsTrigger value="audit"/);
  assert.match(src, /check_audit_log/);
  assert.match(src, /"reviewed_by"/);
});

test('reviewer/audit data writers remain intact (presentation-only repair)', () => {
  const rpc = read('scripts/test-review-decision-rpc.mjs');
  assert.match(rpc, /reviewed_by/);
  const ccc = read('src/pages/CheckCommandCenter.tsx');
  assert.match(ccc, /reviewed_by/);
});

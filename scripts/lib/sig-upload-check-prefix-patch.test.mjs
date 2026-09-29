import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { patchLiveFilesSignatureUploads } from './sig-upload-check-prefix-patch.mjs';

const LIVE = '/tmp/prod-spa/CheckFilesSection-0Fmhwbep-reread.js';

test('live Files chunk Signature uploads retarget to the check UUID', () => {
  assert.equal(existsSync(LIVE), true, 'need the current live Files chunk');
  const source = readFileSync(LIVE, 'utf8');
  const patched = patchLiveFilesSignatureUploads(source);
  assert.equal(source.includes('signatures/${r}/'), true);
  assert.equal(patched.includes('signatures/${r}/'), false);
  assert.match(patched, /check-intake\/\$\{j\}\/files\/\$\{Date\.now\(\)\}-\$\{crypto\.randomUUID\(\)\}-\$\{s\.fileName\}/);
  assert.match(patched, /check-intake\/\$\{j\}\/files\/\$\{Date\.now\(\)\}-\$\{crypto\.randomUUID\(\)\}-\$\{a\}/);
  assert.equal(patched.includes('check-intake/${l}/files/${Date.now()}-${crypto.randomUUID()}-${i}'), true);
  assert.equal((patched.match(/Signature upload requires a check-scoped path/g) || []).length, 2);
});

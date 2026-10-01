import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(path.join(ROOT, 'src/pages/mortgage-ops/MortgageOpsRequestDetail.tsx'), 'utf8');

test('MortgageOps signature and label uploads stay on allowlisted checks/{checkId}/ prefixes', () => {
  assert.match(src, /checks\/\$\{check\.id\}\/mortgage-ops\/\$\{Date\.now\(\)\}-/);
  assert.match(src, /checks\/\$\{check\.id\}\/mortgage-ops\/label-\$\{Date\.now\(\)\}-/);
  assert.match(src, /functions\.invoke\("send-signature-request"/);
  assert.equal(src.includes('signatures/${'), false);
  assert.equal(src.includes('signatures/${claimId}'), false);
});

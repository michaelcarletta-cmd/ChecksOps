/**
 * Send for Signature uploads must land on a check-scoped claim-files prefix the
 * storage write gate allows (Cursor 1ea903640). signatures/{claimId}/ is
 * rejected with path_not_allowlisted, so the SPA must never build it.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { authorizeStorageWritePath } from '../functions/api/storage-write-auth.mjs';
import { authorizeSignatureDocumentPath } from '../functions/api/write-signature.mjs';
import { buildCheckScopedSignatureUploadPath } from '../../src/lib/signature-request-actions.ts';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CHECK = '3916f620-9d20-499b-8450-9e1a8e70a3c9';
const OTHER_CHECK = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const CLAIM = '1de2f734-de37-404a-aa3e-d23905f7a6ea';
const TENANT = '11111111-1111-4111-8111-111111111111';

// The listed checks are the caller's own: visible and writable (aws_can_write_check).
const visibleChecks = (ids) => ({
  query: async (sql, params = []) => {
    if (sql === 'SELECT public.aws_can_write_check($1::uuid) AS ok') return { rows: [{ ok: ids.includes(params[0]) }] };
    if (String(sql).includes('FROM public.check_intake_items WHERE id = $1::uuid')) {
      return { rows: ids.includes(params[0]) ? [{ id: params[0], tenant_id: TENANT }] : [] };
    }
    return { rows: [] };
  },
});

test('the SPA builds check-intake/{checkId}/files/... and refuses without a check UUID', () => {
  const built = buildCheckScopedSignatureUploadPath(CHECK, 'Third Party Auth (1).pdf', 1700000000000, 'nonce-1');
  assert.equal(built, `check-intake/${CHECK}/files/1700000000000-nonce-1-Third_Party_Auth__1_.pdf`);
  assert.equal(buildCheckScopedSignatureUploadPath(CHECK.toUpperCase(), 'x.pdf', 1, 'n'), `check-intake/${CHECK}/files/1-n-x.pdf`);
  assert.match(buildCheckScopedSignatureUploadPath(CHECK, 'x.pdf'), new RegExp(`^check-intake/${CHECK}/files/\\d+-[0-9a-f-]{36}-x\\.pdf$`));
  assert.equal(buildCheckScopedSignatureUploadPath(CHECK, '../../evil.pdf', 1, 'n').includes('/../'), false);
  for (const bad of [null, undefined, '', 'not-a-uuid', CLAIM.slice(0, 30)]) {
    assert.throws(() => buildCheckScopedSignatureUploadPath(bad, 'x.pdf'), /check-scoped path/);
  }
});

test('storage write gate accepts the built path for a writable check', async () => {
  const rel = buildCheckScopedSignatureUploadPath(CHECK, 'release.pdf', 1, 'n');
  const result = await authorizeStorageWritePath(visibleChecks([CHECK]), 'claim-files', rel, null);
  assert.equal(result.ok, true);
  assert.equal(result.strategy, 'check');
  assert.equal(result.check.id, CHECK);
});

test('storage write gate still rejects signatures/{claimId}/ and other checks', async () => {
  const legacy = await authorizeStorageWritePath(visibleChecks([CHECK]), 'claim-files', `signatures/${CLAIM}/1-release.pdf`, null);
  assert.equal(legacy.ok, false);
  assert.equal(legacy.statusCode, 403);
  assert.equal(legacy.error, 'path_not_allowlisted');
  const other = await authorizeStorageWritePath(
    visibleChecks([CHECK]),
    'claim-files',
    buildCheckScopedSignatureUploadPath(OTHER_CHECK, 'x.pdf', 1, 'n'),
    null,
  );
  assert.equal(other.ok, false);
  assert.equal(other.statusCode, 403);
});

test('esign authorizeSignatureDocumentPath accepts the built path only for its own check', async () => {
  const rel = buildCheckScopedSignatureUploadPath(CHECK, 'release.pdf', 1, 'n');
  const none = { query: async () => ({ rows: [] }) };
  assert.equal(await authorizeSignatureDocumentPath(none, { path: rel, claimId: CLAIM, checkId: CHECK }), true);
  assert.equal(await authorizeSignatureDocumentPath(none, { path: rel, claimId: CLAIM, checkId: OTHER_CHECK }), false);
});

test('SignatureRequests.tsx uses the helper for both uploads and records a check file', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/components/claim-detail/SignatureRequests.tsx'), 'utf8');
  assert.equal(src.includes('signatures/${claimId}'), false);
  assert.equal((src.match(/buildCheckScopedSignatureUploadPath\(checkIntakeItemId,/g) || []).length, 2);
  assert.equal((src.match(/from\("check_files"\)\.insert\(/g) || []).length, 2);
});

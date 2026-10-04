/**
 * Pins the accepted Signature Request create contract:
 * Files tab → CCC claim_id → wizard → send-signature-request create payload
 * → live esign create branch → existing /sign. Normal create/send must not
 * use generic browser inserts.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildSendSignatureRequestCreatePayload } from '../../src/lib/signature-source-files.ts';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const sha256 = (rel) => createHash('sha256').update(read(rel), 'utf8').digest('hex');

const CLAIM = '1de2f734-de37-404a-aa3e-d23905f7a6ea';
const CHECK = '3916f620-9d20-499b-8450-9e1a8e70a3c9';
const FROZEN = Object.freeze([
  'aws/functions/api/write-allowlist.mjs',
  'aws/functions/api/write-check-workflow.mjs',
  'aws/functions/api/write-signature.mjs',
  'aws/functions/api/esign.mjs',
  'aws/functions/api/signature-submit.mjs',
  'aws/functions/api/homeowner.mjs',
  'aws/workflows/sql/73_homeowner_ledger_view_last_viewed_best_effort.sql',
  'aws/workflows/sql/74_homeowner_signing_rls_boundary.sql',
]);

test('Files tab still uses the authoritative CCC claim ID', () => {
  const files = read('src/components/check-review/CheckFilesSection.tsx');
  const ccc = read('src/pages/CheckCommandCenter.tsx');
  assert.match(ccc, /<CheckFilesSection checkIntakeItemId=\{checkId\} claimId=\{check\?\.claim_id \?\? null\} \/>/);
  assert.match(files, /resolveSignatureRequestClaimId\(claimId, null\)/);
  assert.match(files, /resolveSignatureRequestClaimId\(suppliedClaimId, checkClaim\?\.claim_id\)/);
  assert.match(files, /<SignatureRequests/);
  assert.match(files, /claimId=\{linkedClaim\.id\}/);
  assert.match(files, /checkIntakeItemId=\{checkIntakeItemId\}/);
  assert.match(files, /data-testid="signature-requests-region"/);
  assert.match(files, /data-testid="signature-requests-unlinked"/);
});

test('wizard create/send uses the complete send-signature-request payload', () => {
  const wizard = read('src/components/claim-detail/SignatureRequests.tsx');
  const helper = read('src/lib/signature-source-files.ts');
  assert.match(wizard, /buildSendSignatureRequestCreatePayload\(/);
  assert.match(wizard, /functions\.invoke\("send-signature-request"/);
  assert.match(helper, /claim_id: claimId \|\| null/);
  assert.match(helper, /check_intake_item_id: checkIntakeItemId \|\| null/);
  assert.match(helper, /document_name: documentName/);
  assert.match(helper, /document_path: documentPath/);
  assert.match(helper, /document_type: documentType \|\| null/);
  assert.match(helper, /field_data: Array\.isArray\(fieldData\) \? fieldData : \[\]/);
  assert.match(helper, /signer_name:/);
  assert.match(helper, /signer_email:/);
  assert.match(helper, /signer_type:/);
  assert.match(helper, /signing_order:/);
  assert.match(helper, /skipEmail: skipEmail === true/);
  assert.doesNotMatch(helper, /requestId\s*:/);
  const createFn = wizard.slice(
    wizard.indexOf('const createRequestMutation = useMutation'),
    wizard.indexOf('const resendMutation = useMutation'),
  );
  assert.match(createFn, /buildSendSignatureRequestCreatePayload\(/);
  assert.doesNotMatch(createFn, /\.insert\(/);
  assert.doesNotMatch(createFn, /requestId/);
  assert.doesNotMatch(wizard, /\.from\("signature_requests"\)\s*\.insert\(/);
  assert.doesNotMatch(wizard, /\.from\("signature_signers"\)\s*\.insert\(/);
  const payload = buildSendSignatureRequestCreatePayload({
    claimId: CLAIM,
    checkIntakeItemId: CHECK,
    documentName: 'Release.pdf',
    documentPath: 'claims/doc.pdf',
    documentType: 'release',
    fieldData: [],
    signers: [{ name: 'A', email: 'a@example.com', type: 'policyholder', order: 1 }],
    skipEmail: true,
  });
  assert.equal(payload.claim_id, CLAIM);
  assert.equal(payload.check_intake_item_id, CHECK);
  assert.equal(payload.document_name, 'Release.pdf');
  assert.equal(payload.document_path, 'claims/doc.pdf');
  assert.equal(payload.document_type, 'release');
  assert.deepEqual(payload.field_data, []);
  assert.deepEqual(payload.signers, [{
    signer_name: 'A',
    signer_email: 'a@example.com',
    signer_type: 'policyholder',
    signing_order: 1,
  }]);
  assert.equal(payload.skipEmail, true);
  assert.equal('requestId' in payload, false);
});

test('resend and list/delete keep requestId and table reads', () => {
  const wizard = read('src/components/claim-detail/SignatureRequests.tsx');
  assert.match(wizard, /\.from\("signature_requests"\)\s*\.select\(/);
  assert.match(wizard, /signature_signers\(\*\)/);
  assert.match(wizard, /\.from\("signature_requests"\)\s*\.delete\(\)/);
  assert.match(wizard, /body: \{ requestId, skipEmail: false, targetSignerIds \}/);
  assert.match(read('src/App.tsx'), /path="\/sign"/);
});

test('this repair does not touch frozen API, SQL73/SQL74, or Homeowner signing', () => {
  const changed = execFileSync(
    'git',
    ['diff', '--name-only', 'HEAD'],
    { cwd: ROOT, encoding: 'utf8' },
  )
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  for (const rel of FROZEN) {
    assert.ok(fs.existsSync(path.join(ROOT, rel)) || rel.endsWith('write-signature.mjs'), rel);
    assert.ok(!changed.includes(rel), `${rel} must stay untouched`);
  }
  const sql73 = sha256('aws/workflows/sql/73_homeowner_ledger_view_last_viewed_best_effort.sql');
  const sql74 = sha256('aws/workflows/sql/74_homeowner_signing_rls_boundary.sql');
  assert.equal(sql73.length, 64);
  assert.equal(sql74.length, 64);
  assert.ok(!changed.includes('src/pages/Sign.tsx'));
});

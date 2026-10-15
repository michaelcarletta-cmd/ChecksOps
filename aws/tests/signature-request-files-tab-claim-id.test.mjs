/**
 * Pins both proven Signature Request frontend dependencies:
 * 1. browser AWS_WRITE_TABLES still permits only signature_requests + signature_signers
 * 2. Check Command Center passes check.claim_id into Files, and the
 *    Signature Requests region cannot silently disappear when the
 *    redundant secondary lookup fails.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  resolveSignatureRequestClaimId,
  shouldUseSignatureClaimFallback,
  signatureRequestsRegionMode,
  SIGNATURE_REQUESTS_UNLINKED_COPY,
} from '../../src/lib/signature-source-files.ts';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const CLAIM = '1de2f734-de37-404a-aa3e-d23905f7a6ea';
function parseWriteTables(source) {
  const match = source.match(/const AWS_WRITE_TABLES = new Set\(\[([\s\S]*?)\]\)/);
  assert.ok(match, 'AWS_WRITE_TABLES Set not found');
  return [...match[1].matchAll(/"([^"]+)"/g)].map((row) => row[1]);
}

test('linked check + CCC claim ID keeps Signature Requests visible', () => {
  const files = read('src/components/check-review/CheckFilesSection.tsx');
  const ccc = read('src/pages/CheckCommandCenter.tsx');
  assert.match(ccc, /<CheckFilesSection checkIntakeItemId=\{checkId\} claimId=\{check\?\.claim_id \?\? null\} \/>/);
  assert.match(files, /claimId\?: string \| null/);
  assert.equal(resolveSignatureRequestClaimId(CLAIM, null), CLAIM);
  assert.equal(signatureRequestsRegionMode(CLAIM), 'requests');
  assert.match(files, /regionMode === "requests"/);
  assert.match(files, /<SignatureRequests/);
  assert.match(files, /data-testid="signature-requests-region"/);
});

test('secondary lookup failure + valid CCC claim ID still shows Signature Requests', () => {
  const files = read('src/components/check-review/CheckFilesSection.tsx');
  assert.match(files, /enabled: shouldUseSignatureClaimFallback\(suppliedClaimId\)/);
  assert.equal(shouldUseSignatureClaimFallback(CLAIM), false);
  assert.equal(resolveSignatureRequestClaimId(CLAIM, null), CLAIM);
  assert.equal(resolveSignatureRequestClaimId(CLAIM, undefined), CLAIM);
  assert.equal(signatureRequestsRegionMode(resolveSignatureRequestClaimId(CLAIM, null)), 'requests');
  assert.doesNotMatch(files, /linkedClaim\?\.id && \(\s*<SignatureRequests/);
});

test('genuinely unlinked check shows an explanatory empty state', () => {
  const files = read('src/components/check-review/CheckFilesSection.tsx');
  assert.equal(resolveSignatureRequestClaimId(null, null), null);
  assert.equal(signatureRequestsRegionMode(null), 'unlinked');
  assert.match(files, /data-testid="signature-requests-unlinked"/);
  assert.match(files, /SIGNATURE_REQUESTS_UNLINKED_COPY/);
  assert.match(SIGNATURE_REQUESTS_UNLINKED_COPY, /not linked to a claim/);
  assert.match(SIGNATURE_REQUESTS_UNLINKED_COPY, /before requesting signatures/);
  assert.doesNotMatch(files, /insert\(\{[^}]*claim_id/);
});

test('browser write adapter still permits only signature_requests and signature_signers', () => {
  const tables = parseWriteTables(read('src/integrations/aws/client.ts'));
  const extras = tables.filter((table) => table.startsWith('signature_'));
  assert.deepEqual(extras, ['signature_requests', 'signature_signers']);
  assert.ok(tables.includes('signature_requests'));
  assert.ok(tables.includes('signature_signers'));
  assert.ok(!tables.includes('signature_field_templates'));
});

test('create → signer → send path remains intact', () => {
  const wizard = read('src/components/claim-detail/SignatureRequests.tsx');
  assert.match(wizard, /buildSendSignatureRequestCreatePayload\(/);
  assert.match(wizard, /functions\.invoke\("send-signature-request"/);
  assert.match(wizard, /documentName: docName/);
  assert.match(wizard, /documentPath: generatedDocPath/);
  assert.match(wizard, /fieldData: placedFields/);
  assert.match(wizard, /skipEmail/);
  assert.doesNotMatch(wizard, /\.from\("signature_requests"\)\s*\.insert\(/);
  assert.doesNotMatch(wizard, /\.from\("signature_signers"\)\s*\.insert\(/);
  assert.match(wizard, /body: \{ requestId, skipEmail: false, targetSignerIds \}/);
  assert.match(read('src/App.tsx'), /path="\/sign"/);
});

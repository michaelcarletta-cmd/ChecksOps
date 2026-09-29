import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('SignatureRequests create mutation uses Class A send-signature-request payload', () => {
  const source = readFileSync(new URL('../src/components/claim-detail/SignatureRequests.tsx', import.meta.url), 'utf8');
  assert.equal(source.includes('.from("signature_requests")\n        .insert'), false);
  assert.equal(source.includes('.from("signature_signers")\n        .insert'), false);
  assert.match(source, /functions\.invoke\("send-signature-request"/);
  assert.match(source, /claim_id: claimId/);
  assert.match(source, /check_intake_item_id: checkIntakeItemId \|\| null/);
  assert.match(source, /document_name: docName/);
  assert.match(source, /document_path: generatedDocPath/);
  assert.match(source, /field_data: placedFields/);
  assert.match(source, /skipEmail/);
  assert.match(source, /createSignedUrl\(generatedDocPath, 60\)/);
});

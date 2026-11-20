/**
 * Signature Requests "From Document Library" (owner 2026-11-20: "It should show all files in document library to add.
 * In freedom adjustment only have w9 but it's not showing up"). The picker lists through
 * signature-library-document-copy action "list" (every category, Mortgage packet included), labels Mortgage packet
 * documents, and the homeowner share picker keeps claim-library-documents (Mortgage packet left out).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('the signature picker lists through signature-library-document-copy action list, not the homeowner list', () => {
  const hook = read('src/hooks/useLibrarySignatureSource.ts');
  assert.match(hook, /invokeOk<\{ documents: LibrarySignatureDoc\[\] \}>\("signature-library-document-copy", \{ action: "list", claim_id: claimId \}\)/);
  assert.doesNotMatch(hook, /"claim-library-documents"/);
  // Still PDF / DOCX only, templates first.
  assert.match(hook, /\.filter\(\(doc\) => SIGNABLE\.has\(String\(doc\.mime_type \|\| ""\)\.toLowerCase\(\)\)\)/);
});

test('Mortgage packet documents are labelled, and the empty state says images cannot be signed', () => {
  const picker = read('src/components/claim-detail/LibrarySignatureSource.tsx');
  assert.match(picker, /mortgage: "Mortgage packet",/);
  assert.match(picker, /No PDF or DOCX documents in the Document Library \(Compliance &amp; Docs\)\. Images can’t be sent for signature\./);
});

test('the homeowner share picker still uses claim-library-documents (Mortgage packet left out there)', () => {
  assert.match(read('src/components/check-review/HomeownerLibraryShare.tsx'), /invokeOk<ClaimLibrary>\("claim-library-documents", \{ claim_id: claimId \}\)/);
});

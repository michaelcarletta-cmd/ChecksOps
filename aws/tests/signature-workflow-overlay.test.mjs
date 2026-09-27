import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const sourceOf = (rel) => readFileSync(join(ROOT, rel), 'utf8');

test('Mortgage Ops confirm/resend reuse the existing send-signature-request engine', () => {
  const src = sourceOf('src/pages/mortgage-ops/MortgageOpsRequestDetail.tsx');
  assert.match(src, /Confirm homeowner email/);
  assert.match(src, /confirmEmail/);
  assert.match(src, /resendSignatureRequest/);
  assert.match(src, /functions\.invoke\("send-signature-request"/);
  assert.match(src, /claim_id: req\.claim_id/);
  assert.match(src, /check_intake_item_id: check\?\.id/);
  assert.equal(src.includes('from("signature_requests")\n        .insert'), true);
  const resendBlock = src.slice(src.indexOf('const resendSignatureRequest'), src.indexOf('const sendPlacedSignatureRequest'));
  assert.match(resendBlock, /send-signature-request/);
  assert.equal(resendBlock.includes('.insert('), false);
});

test('tenant Check Documents mounts the existing SignatureRequests component', () => {
  const files = sourceOf('src/components/check-review/CheckFilesSection.tsx');
  assert.match(files, /import \{ SignatureRequests \}/);
  assert.match(files, /<SignatureRequests/);
  assert.match(files, /checkIntakeItemId=\{checkIntakeItemId\}/);
  assert.match(files, /preselected-sig-file/);
  assert.match(files, /Send for Homeowner Signature/);

  const requests = sourceOf('src/components/claim-detail/SignatureRequests.tsx');
  assert.match(requests, /checkIntakeItemId\?: string \| null/);
  assert.match(requests, /claim_id: claimId/);
  assert.match(requests, /check_intake_item_id: checkIntakeItemId \|\| null/);
  assert.match(requests, /Use Existing Claim\/Check File/);
  assert.match(requests, /from\("check_files"\)/);
  assert.match(requests, /functions\.invoke\("send-signature-request"/);
});

test('AWS viewed + attach overlay does not add a second signing engine or overwrite LDD originals', () => {
  const storage = sourceOf('aws/functions/api/storage.mjs');
  assert.match(storage, /export const recordPublicSignerViewed/);
  assert.match(storage, /aws_public_signature_mark_viewed/);
  assert.match(storage, /handlePublicSignatureDocument/);
  assert.equal(storage.includes("SET status = 'in_progress'"), false);

  const submit = sourceOf('aws/functions/api/signature-submit.mjs');
  assert.match(submit, /export const attachCompletedSignatureDocument/);
  assert.match(submit, /aws_public_signature_attach_signed/);
  assert.match(submit, /aws_public_signature_submit/);
  assert.equal(submit.includes('INSERT INTO public.claim_files'), false);
  const helpers = sourceOf('aws/storage/sql/02_public_signature_write_helpers.sql');
  assert.match(helpers, /signed_dtp/);
  assert.match(helpers, /final_pdf_path/);
  assert.match(helpers, /signature_status = 'signed'/);
  assert.equal(helpers.includes('SET document_path'), false);

  const lovable = sourceOf('supabase/functions/submit-signature/index.ts');
  const lovableLdd = lovable.slice(lovable.indexOf('loss_draft_documents'));
  assert.match(lovableLdd, /signature_status: "signed"/);
  assert.equal(lovableLdd.includes('file_path:'), false);
});

test('overlay does not introduce a replacement public signing route or token system', () => {
  const index = sourceOf('aws/functions/api/index.mjs');
  assert.match(index, /handlePublicSignatureDocument/);
  assert.match(index, /handlePublicSignatureSubmit/);
  assert.equal(index.includes('/public/signature-submit-v2'), false);
  assert.equal(index.includes('another_signing'), false);
});

test('AWS staging write allowlist exposes only the existing signature tables', () => {
  const allow = sourceOf('aws/functions/api/write-allowlist.mjs');
  assert.match(allow, /signature_requests:/);
  assert.match(allow, /signature_signers:/);
  assert.match(allow, /signature_request_id/);
  const client = sourceOf('src/integrations/aws/client.ts');
  assert.match(client, /"signature_requests"/);
  assert.match(client, /"signature_signers"/);
  const writer = sourceOf('aws/functions/api/write-signature.mjs');
  assert.match(writer, /status !== 'draft'/);
  assert.equal(writer.includes('bill-mortgage'), false);
  assert.equal(writer.includes('ready_for_deposit'), false);
});

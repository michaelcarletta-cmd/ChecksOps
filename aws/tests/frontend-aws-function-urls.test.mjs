import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  emailUnsubscribeUrl,
  interpretUnsubscribeConfirm,
  interpretUnsubscribeGet,
  moovAccountFileUploadUrl,
  resolveAwsFunctionUrl,
} from '../../src/lib/awsFunctionUrls.ts';
import { resolveAwsApiBaseUrl } from '../../src/lib/awsApiBase.ts';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sourceOf = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('production-aws /prep base resolves unsubscribe and Moov KYC upload onto Lambda', () => {
  const apiBase = resolveAwsApiBaseUrl('/prep', 'https://checksops.com');
  assert.equal(apiBase, 'https://checksops.com/prep');
  assert.equal(
    emailUnsubscribeUrl(apiBase, 'tok-1'),
    'https://checksops.com/prep/functions/v1/handle-email-unsubscribe?token=tok-1',
  );
  assert.equal(
    moovAccountFileUploadUrl(apiBase),
    'https://checksops.com/prep/functions/v1/moov-account-file-upload',
  );
  assert.equal(
    resolveAwsFunctionUrl('/prep', 'handle-email-unsubscribe', { token: 'abc def' }),
    '/prep/functions/v1/handle-email-unsubscribe?token=abc+def',
  );
});

test('unsubscribe GET/POST interpreters accept AWS handler shapes', () => {
  assert.deepEqual(
    interpretUnsubscribeGet(200, { valid: true, email: 'a@example.com' }),
    { kind: 'valid', email: 'a@example.com' },
  );
  assert.deepEqual(
    interpretUnsubscribeGet(200, { valid: true }),
    { kind: 'valid', email: '' },
  );
  assert.deepEqual(
    interpretUnsubscribeGet(200, { alreadyUnsubscribed: true }),
    { kind: 'already' },
  );
  assert.deepEqual(
    interpretUnsubscribeGet(404, { error: 'invalid_token' }),
    { kind: 'invalid', message: 'invalid_token' },
  );
  assert.deepEqual(
    interpretUnsubscribeConfirm(200, { success: true }, 'a@example.com'),
    { kind: 'done', email: 'a@example.com' },
  );
  assert.deepEqual(
    interpretUnsubscribeConfirm(200, { success: false, reason: 'already_unsubscribed' }),
    { kind: 'already' },
  );
  assert.equal(interpretUnsubscribeConfirm(503, { error: 'unsubscribe_failed' }).kind, 'error');
});

test('Unsubscribe and verification upload no longer concatenate VITE_SUPABASE_URL', () => {
  const unsubscribe = sourceOf('src/pages/Unsubscribe.tsx');
  const upload = sourceOf('src/lib/payments/verificationFiles.ts');

  assert.match(unsubscribe, /emailUnsubscribeUrl\(awsApiBaseUrl\(\), token\)/);
  assert.match(unsubscribe, /interpretUnsubscribeGet/);
  assert.doesNotMatch(unsubscribe, /VITE_SUPABASE_URL/);
  assert.doesNotMatch(unsubscribe, /VITE_SUPABASE_PUBLISHABLE_KEY/);
  assert.doesNotMatch(unsubscribe, /supabase\.functions\.invoke/);
  assert.doesNotMatch(unsubscribe, /apikey/);

  assert.match(upload, /moovAccountFileUploadUrl\(awsApiBaseUrl\(\)\)/);
  assert.doesNotMatch(upload, /VITE_SUPABASE_URL/);
  assert.doesNotMatch(upload, /VITE_SUPABASE_PUBLISHABLE_KEY/);
  assert.doesNotMatch(upload, /setRequestHeader\("apikey"/);
});

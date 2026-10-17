import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { CLASS_A_FUNCTIONS, handleAppServiceRequest } from '../functions/api/app-services.mjs';
import { hashToken, replaceMergeFields, signBaseUrl } from '../functions/api/esign.mjs';
import { handleMfaSetPreference, MFA_AUTH_ROUTES } from '../functions/api/auth-mfa.mjs';
import { classifyNinthUuid, ninthExcludedFromInvite } from '../identity/ninth-uuid.mjs';

const eventOf = ({ headers = {}, body = {}, method = 'POST', path = '/functions/v1/send-signature-request' } = {}) => ({
  headers,
  body: JSON.stringify(body),
  requestContext: { http: { method, path } },
});

test('class A registry includes remaining non-financial workflows', () => {
  for (const name of [
    'homeowner-ledger-attach-upload',
    'send-signature-request',
    'check-endorsement',
    'check-reconciliation',
    'send-payment-direction-request',
    'admin-reset-totp',
    'bill-mortgage-handling',
    'checkalt-deposit-preflight',
  ]) {
    assert.ok(CLASS_A_FUNCTIONS.has(name), name);
  }
  assert.ok(CLASS_A_FUNCTIONS.has('tenant-tax-profiles'));
  assert.ok(!CLASS_A_FUNCTIONS.has('moov-disburse'));
});

test('the retired Freedom Claims bridge routes are gone', async () => {
  for (const name of ['ingest-shared-check', 'lookup-partner-code-public']) {
    assert.equal(CLASS_A_FUNCTIONS.has(name), false, name);
    const path = `/functions/v1/${name}`;
    const result = await handleAppServiceRequest(
      eventOf({ headers: { 'x-bridge-secret': 'anything' }, body: { source_check_id: 'x', code: 'ABCDEFGH' }, path }),
      path,
      'POST',
    );
    // Not a class A route any more: the app-services dispatcher does not handle it.
    assert.equal(result, null, name);
  }
  // Only a retired stub remains (for a live app-services.mjs during the overlay): 410, no SQL.
  const stub = fs.readFileSync(new URL('../functions/api/ingest-shared-check.mjs', import.meta.url), 'utf8');
  assert.match(stub, /RETIRED stub/);
  assert.doesNotMatch(stub, /client\.query|SELECT|INSERT|UPDATE|S3Client|import /);
  const { handleIngestSharedCheck, bridgeSecretMatches } = await import('../functions/api/ingest-shared-check.mjs');
  assert.equal((await handleIngestSharedCheck({ headers: { 'x-bridge-secret': 'anything' } })).statusCode, 410);
  assert.equal(bridgeSecretMatches({ headers: { 'x-bridge-secret': 'anything' } }), false);
});

test('e-sign adapter hashes tokens and stays on staging sign base', () => {
  const prev = process.env.SIGN_BASE_URL;
  delete process.env.SIGN_BASE_URL;
  assert.equal(signBaseUrl(), 'https://staging.checksops.com');
  const hash = hashToken('abc');
  assert.equal(hash.length, 64);
  const subject = replaceMergeFields('Sign {document.name}', { signer_name: 'A' }, { document_name: 'Release' }, 'https://staging.checksops.com/sign?token=x');
  assert.equal(subject, 'Sign Release');
  process.env.SIGN_BASE_URL = prev;
});

test('preferred MFA set-preference stays refused and money stays locked', async () => {
  const result = await handleMfaSetPreference();
  assert.equal(result.statusCode, 403);
  assert.equal(result.financialPermissionsActivated, false);
  assert.equal(result.moneyMovementUnlocked, false);
  assert.ok(MFA_AUTH_ROUTES['/auth/mfa/associate']);
  assert.ok(MFA_AUTH_ROUTES['/auth/mfa/verify']);
});

test('ninth UUID is not a live production user and is excluded from Cognito invite', () => {
  const ninth = classifyNinthUuid();
  assert.equal(ninth.classification, 'not_found');
  assert.equal(ninth.cognitoInvite, false);
  assert.equal(ninth.inventEmail, false);
  assert.equal(ninth.failClosed, true);
  assert.equal(ninthExcludedFromInvite(), true);
});

/**
 * Gate 3D live state (2026-10-30, read-only): require-mode is live on the production origin-verify
 * authorizer (applied 2026-09-09 by the account root, recorded here), raw execute-api refuses every
 * request but CORS preflight, and DisableExecuteApiEndpoint is the remaining step. The record holds
 * no secret, header value or token.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = (rel) => fs.readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');
const DOC = read('aws/cutover/API_PERIMETER_STEP3_GATE3D_LIVE_STATE.md');

test('the live state records require-mode as applied, by whom and when, and that nothing was changed', () => {
  assert.match(DOC, /Work on items 1 and 2/);
  assert.match(DOC, /`ORIGIN_VERIFY_REQUIRE` is\s+`true`/);
  assert.match(DOC, /2026-09-09 02:07:15 UTC by\s+`arn:aws:iam::806168576068:root`/);
  assert.match(DOC, /nothing was changed/);
  assert.match(DOC, /`ChecksOpsCursorApiPerimeterStep3Temp` and `ChecksOpsCursorApiPerimeterStep3AuditTemp` no\s+longer exist/);
});

test('raw execute-api refuses everything but CORS preflight, and only the disable step remains', () => {
  assert.match(DOC, /`DisableExecuteApiEndpoint` \*\*false\*\*/);
  assert.match(DOC, /raw `GET https:\/\/kiqojucc02\.execute-api\.us-east-1\.amazonaws\.com\/prep\/health` \| \*\*403\*\*/);
  assert.match(DOC, /fabricated `x-checksops-origin-verify` \| 403/);
  assert.match(DOC, /raw `OPTIONS …\/prep\/data\/query` \| \*\*204\*\*/);
  assert.match(DOC, /The remaining step is\s+`DisableExecuteApiEndpoint=true` on `kiqojucc02`/);
  assert.match(DOC, /Staging cannot rehearse it/);
  // The CORS smoke that uses the raw host moves to CloudFront before the endpoint is disabled.
  assert.match(read('.github/workflows/guarded-production-cors.yml'), /kiqojucc02\.execute-api\.us-east-1\.amazonaws\.com\/prep\/health/);
  assert.match(DOC, /guarded-production-cors\.yml/);
  assert.match(DOC, /## Rollback|Rollback: the same tool with `DisableExecuteApiEndpoint=false`/);
});

test('the record carries no secret, header value or token', () => {
  assert.doesNotMatch(DOC, /SecretString|HeaderValue\s*[:=]/);
  assert.doesNotMatch(DOC, /eyJ[A-Za-z0-9_-]{10,}\./);
  assert.doesNotMatch(DOC, /Bearer [A-Za-z0-9._-]+/);
  // The Gate 3D package stays the review-time record.
  assert.match(read('aws/cutover/API_PERIMETER_STEP3_GATE3D.md'), /STOP FOR REVIEW\. DO NOT APPLY GATE 3D/);
});

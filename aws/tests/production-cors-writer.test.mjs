import assert from 'node:assert/strict';
import test from 'node:test';
import { EXPECTED, TARGET_ORIGINS, desiredCors, normalizeSnapshot, validatePinnedSnapshot, assertOnlyCorsDelta } from '../../scripts/deployment-guard/production-cors-update.mjs';

function live() {
  return normalizeSnapshot({
    api: { ApiId: 'kiqojucc02', DisableExecuteApiEndpoint: false, CorsConfiguration: structuredClone(EXPECTED.cors) },
    routes: { Items: [
      { RouteKey: 'OPTIONS /{proxy+}', AuthorizationType: 'NONE' },
      { RouteKey: '$default', AuthorizationType: 'CUSTOM', AuthorizerId: '0dwrwx' },
    ] },
    authorizers: { Items: [{ AuthorizerId: '0dwrwx', Name: 'checksops-production-origin-verify' }] },
    cloudfront: { ETag: EXPECTED.cloudfront.ETag, Distribution: { Status: 'Deployed', DistributionConfig: { WebACLId: EXPECTED.cloudfront.WebACLId } } },
    lambda: { CodeSha256: EXPECTED.lambda.CodeSha256, RevisionId: EXPECTED.lambda.RevisionId },
  });
}

test('exact pinned live snapshot passes', () => assert.equal(validatePinnedSnapshot(live()).ok, true));

test('drift fails closed', () => {
  for (const mutate of [
    s => { s.api.CorsConfiguration.MaxAge = 1; },
    s => { s.authorizer.Name = 'moved'; },
    s => { s.cloudfront.ETag = 'changed'; },
    s => { s.lambda.RevisionId = 'changed'; },
    s => { s.api.DisableExecuteApiEndpoint = true; },
  ]) {
    const s = live();
    mutate(s);
    assert.equal(validatePinnedSnapshot(s).ok, false);
  }
});

test('desired CORS changes only AllowOrigins', () => {
  assert.deepEqual(desiredCors(structuredClone(EXPECTED.cors)), { ...EXPECTED.cors, AllowOrigins: [...TARGET_ORIGINS] });
});

test('unexpected CORS shape is refused', () => {
  assert.throws(() => desiredCors({ ...EXPECTED.cors, AllowCredentials: true }), /cors_shape_drift/);
});

test('post-write verifier accepts only exact CORS delta', () => {
  const before = live();
  const after = structuredClone(before);
  after.api.CorsConfiguration = desiredCors(before.api.CorsConfiguration);
  assert.doesNotThrow(() => assertOnlyCorsDelta(before, after));
  after.lambda.RevisionId = 'changed';
  assert.throws(() => assertOnlyCorsDelta(before, after), /post_write_non_cors_drift/);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handler } from '../functions/api/index.mjs';
import { readinessSnapshot, stagingSafetyHolds } from '../functions/api/ops-readiness.mjs';

test('staging safety holds when execution flags are unset', () => {
  const snap = readinessSnapshot();
  const holds = stagingSafetyHolds(snap);
  assert.equal(holds.ok, true);
  assert.equal(snap.productionCutoverForbidden, true);
  assert.equal(snap.plaidRequired, false);
  assert.equal(snap.flags.AWS_FINANCIAL_PERMISSIONS_ACTIVATED, false);
  assert.equal(snap.flags.AWS_PLAID_ENABLED, false);
  assert.equal(snap.bridgesMustRemainDeployed, true);
  assert.equal(snap.checkAltHandledSeparately, true);
  assert.equal(snap.classA.ingestSharedCheck, true);
  assert.equal(snap.classA.stripeFailClosed, true);
  assert.equal(snap.cognitoMfaPreferred, false);
});

test('GET /ops/readiness reports holds without requiring a database', async () => {
  const result = await handler({
    requestContext: { http: { method: 'GET', path: '/ops/readiness' } },
  });
  assert.equal(result.statusCode, 200);
  const body = JSON.parse(result.body);
  assert.equal(body.productionCutoverForbidden, true);
  assert.equal(body.holds.ok, true);
  assert.equal(body.plaidRequired, false);
  assert.equal(body.flags.AWS_PROVIDER_EXECUTION_ENABLED, false);
});

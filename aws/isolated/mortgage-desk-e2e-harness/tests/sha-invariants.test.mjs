import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PREP_SHA_BASELINE, STAGING_SHA_BASELINE } from '../src/constants.mjs';
import { refuseOnShaDrift } from '../src/sha-invariants.mjs';
import { handler } from '../src/index.mjs';

test('matching SHAs are accepted and drift is refused', () => {
  assert.equal(refuseOnShaDrift({ unchanged: true }), null);
  const drifted = refuseOnShaDrift({
    unchanged: false,
    matches: { staging: false, prep: true },
    staging: { CodeSha256: 'nope' },
  });
  assert.equal(drifted.error, 'application_sha_drift');
  assert.equal(drifted.statusCode, 409);
});

test('handler stops on SHA drift before any secret or database work', async () => {
  const result = await handler({ action: 'preflight' }, {
    captureApplicationShas: async () => ({
      unchanged: false,
      matches: { staging: false, prep: true },
      baselines: { staging: STAGING_SHA_BASELINE, prep: PREP_SHA_BASELINE },
      staging: { CodeSha256: 'drift' },
      prep: { CodeSha256: PREP_SHA_BASELINE },
    }),
    getSecretString: async () => {
      throw new Error('secret must not be loaded after SHA drift');
    },
  });
  assert.equal(result.error, 'application_sha_drift');
  assert.equal(result.rowsCreated, 0);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  HARNESS_FUNCTION_NAME,
  STAGING_RDS_HOST,
  STAGING_SECRET_ARN_PREFIX,
} from '../src/constants.mjs';
import { evaluateFailClosed, refuseWriteAction, stagingSecretArnAllowed } from '../src/fail-closed.mjs';
import { handler } from '../src/index.mjs';
import { WRITE_ACTIONS } from '../src/constants.mjs';

const stagingArn = `${STAGING_SECRET_ARN_PREFIX}-b4U0Rn`;

const okEnv = {
  CHECKSOPS_ENV: 'staging',
  DATABASE_NAME: 'checksops',
  RDS_HOST: STAGING_RDS_HOST,
  DATABASE_SECRET_ARN: stagingArn,
  AWS_LAMBDA_FUNCTION_NAME: HARNESS_FUNCTION_NAME,
  HARNESS_FUNCTION_NAME,
  ALLOW_SYNTHETIC_WRITES: 'false',
};

test('staging application secret ARN is allowed and production/admin/provider ARNs are not', () => {
  assert.equal(stagingSecretArnAllowed(stagingArn), true);
  assert.equal(stagingSecretArnAllowed('arn:aws:secretsmanager:us-east-1:806168576068:secret:rds-db-credentials/checksops-production/checksops/1790081257144-xxxx'), false);
  assert.equal(stagingSecretArnAllowed('arn:aws:secretsmanager:us-east-1:806168576068:secret:rds-db-credentials/checksops-staging/checksops_admin/1-xxxx'), false);
  assert.equal(stagingSecretArnAllowed('arn:aws:secretsmanager:us-east-1:806168576068:secret:checksops/staging/providers-xxxx'), false);
});

test('fail-closed requires staging identity and refuses money/provider flags', () => {
  assert.equal(evaluateFailClosed(okEnv).ok, true);
  assert.equal(evaluateFailClosed({ ...okEnv, CHECKSOPS_ENV: 'production-prep' }).ok, false);
  assert.equal(evaluateFailClosed({ ...okEnv, AWS_MOOV_ENABLED: 'true' }).ok, false);
  assert.equal(evaluateFailClosed({ ...okEnv, PROVIDER_SECRETS_ARN: 'arn:aws:secretsmanager:us-east-1:806168576068:secret:checksops/staging/providers-x' }).ok, false);
  assert.equal(evaluateFailClosed({ ...okEnv, ALLOW_SYNTHETIC_WRITES: 'true' }).ok, false);
  assert.equal(evaluateFailClosed({ ...okEnv, AWS_LAMBDA_FUNCTION_NAME: 'checksops-staging-api' }).ok, false);
});

test('write actions return a hard refusal', () => {
  for (const action of WRITE_ACTIONS) {
    const refused = refuseWriteAction(action);
    assert.equal(refused.ok, false);
    assert.equal(refused.statusCode, 403);
    assert.equal(refused.rowsCreated, 0);
    assert.equal(refused.rowsDeleted, 0);
  }
});

test('handler refuses run_initial even when SHAs match', async () => {
  const result = await handler({ action: 'run_initial' }, {
    captureApplicationShas: async () => ({
      unchanged: true,
      matches: { staging: true, prep: true },
      staging: { CodeSha256: 'ok' },
      prep: { CodeSha256: 'ok' },
    }),
    getSecretString: async () => {
      throw new Error('secret should not be read for refused write actions');
    },
  });
  assert.equal(result.error, 'synthetic_writes_not_authorized');
  assert.equal(result.rowsCreated, 0);
});

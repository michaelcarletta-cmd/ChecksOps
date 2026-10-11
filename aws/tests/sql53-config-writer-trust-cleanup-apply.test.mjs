import assert from 'node:assert/strict';
import { test } from 'node:test';

import { applySql53ConfigWriterOidcTrustCleanup } from '../../scripts/deployment-guard/lib/sql53-config-writer-trust-cleanup.mjs';
import {
  SQL53_CONFIG_WRITER_FUNCTION_ARN,
  SQL53_CONFIG_WRITER_OIDC_STATEMENT,
} from '../../scripts/deployment-guard/lib/sql53-config-writer-trust-merge.mjs';

const IDENTITY_CENTER_ALLOW = {
  Sid: 'AllowIdentityCenterAdministratorAccessUnchanged',
  Effect: 'Allow',
  Principal: {
    AWS: 'arn:aws:iam::806168576068:role/aws-reserved/sso.amazonaws.com/AWSReservedSSO_AdministratorAccess_TESTONLY',
  },
  Action: 'sts:AssumeRole',
};

const PERMS = {
  Version: '2012-10-17',
  Statement: [{
    Sid: 'Sql53TemporaryLambdaConfigurationOnly',
    Effect: 'Allow',
    Action: [
      'lambda:GetFunctionConfiguration',
      'lambda:UpdateFunctionConfiguration',
      'lambda:InvokeFunction',
    ],
    Resource: SQL53_CONFIG_WRITER_FUNCTION_ARN,
  }],
};

function currentTrust() {
  return {
    Version: '2012-10-17',
    Statement: [IDENTITY_CENTER_ALLOW, SQL53_CONFIG_WRITER_OIDC_STATEMENT],
  };
}

function adminIdentity() {
  return {
    Account: '806168576068',
    Arn: 'arn:aws:sts::806168576068:assumed-role/AWSReservedSSO_AdministratorAccess_ABC123/owner',
  };
}

function adapter(overrides = {}) {
  let trust = currentTrust();
  let perms = PERMS;
  let updated = false;
  return {
    updated: () => updated,
    async getCallerIdentity() {
      return overrides.identity || adminIdentity();
    },
    async getRole() {
      if (overrides.getRoleError) throw new Error('denied');
      return { Role: { AssumeRolePolicyDocument: trust } };
    },
    async listRolePolicies() {
      return { PolicyNames: ['sql53-writer'] };
    },
    async listAttachedRolePolicies() {
      return { AttachedPolicies: [] };
    },
    async getRolePolicy() {
      return { PolicyDocument: perms };
    },
    async updateAssumeRolePolicy({ policyDocument }) {
      updated = true;
      trust = policyDocument;
    },
  };
}

test('cleanup apply refuses without admin identity or apply flags', async () => {
  const forbidden = await applySql53ConfigWriterOidcTrustCleanup({ apply: false }, {
    env: {},
    aws: adapter(),
  });
  assert.equal(forbidden.ok, false);
  assert.equal(forbidden.code, 'GUARD_APPLY_FORBIDDEN');

  const staging = await applySql53ConfigWriterOidcTrustCleanup({ apply: true }, {
    env: { CHECKSOPS_SQL53_OIDC_TRUST_CLEANUP: '1' },
    aws: adapter({
      identity: {
        Account: '806168576068',
        Arn: 'arn:aws:sts::806168576068:assumed-role/ChecksOpsCursorCloudStaging/session',
      },
    }),
  });
  assert.equal(staging.ok, false);
  assert.equal(staging.code, 'PRODUCTION_APPROVAL_REQUIRED');
  assert.equal(staging.details.arn_class, 'ChecksOpsCursorCloudStaging');
});

test('cleanup apply stops when live trust cannot be read', async () => {
  const denied = await applySql53ConfigWriterOidcTrustCleanup({ apply: true }, {
    env: { CHECKSOPS_SQL53_OIDC_TRUST_CLEANUP: '1' },
    aws: adapter({ getRoleError: true }),
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.code, 'DEPLOYMENT_COLLISION');
  assert.match(denied.message, /stop without changes/);
});

test('cleanup apply removes only the approved Cursor OIDC statement and rereads it', async () => {
  const aws = adapter();
  const result = await applySql53ConfigWriterOidcTrustCleanup({ apply: true }, {
    env: { CHECKSOPS_SQL53_OIDC_TRUST_CLEANUP: '1' },
    aws,
  });
  assert.equal(result.ok, true);
  assert.equal(result.details.iam_cleanup_verified, true);
  assert.equal(aws.updated(), true);
  assert.deepEqual(result.details.removed_statement, SQL53_CONFIG_WRITER_OIDC_STATEMENT);
  assert.equal(result.details.comparison.only_approved_cursor_oidc_removed, true);
  assert.equal(result.details.before.statement_count, 2);
  assert.equal(result.details.after.statement_count, 1);
  assert.equal(result.details.after.statements[0].aws_principal_class, 'AWSReservedSSO_AdministratorAccess');
  assert.equal(result.details.after.statements.some((row) => row.approved_cursor_oidc), false);
});

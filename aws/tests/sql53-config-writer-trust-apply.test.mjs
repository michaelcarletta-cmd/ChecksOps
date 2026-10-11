import assert from 'node:assert/strict';
import { test } from 'node:test';

import { applySql53ConfigWriterOidcTrust } from '../../scripts/deployment-guard/lib/sql53-config-writer-trust-apply.mjs';
import {
  SQL53_CONFIG_WRITER_FUNCTION_ARN,
  SQL53_CONFIG_WRITER_OIDC_STATEMENT,
  SQL53_CONFIG_WRITER_REQUIRED_ACTIONS,
  isIdentityCenterAdministratorIdentity,
} from '../../scripts/deployment-guard/lib/sql53-config-writer-trust-merge.mjs';

const ADMIN = {
  Account: '806168576068',
  Arn: 'arn:aws:sts::806168576068:assumed-role/AWSReservedSSO_AdministratorAccess_TESTONLY1/owner',
};

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
    Effect: 'Allow',
    Action: [...SQL53_CONFIG_WRITER_REQUIRED_ACTIONS],
    Resource: SQL53_CONFIG_WRITER_FUNCTION_ARN,
  }],
};

function awsStub(overrides = {}) {
  const calls = [];
  let trustStatements = overrides.trustStatements || [IDENTITY_CENTER_ALLOW];
  const stub = {
    calls,
    getCallerIdentity: async () => {
      calls.push('getCallerIdentity');
      return overrides.identity || ADMIN;
    },
    getRole: async () => {
      calls.push('getRole');
      return {
        Role: {
          AssumeRolePolicyDocument: {
            Version: '2012-10-17',
            Statement: trustStatements,
          },
        },
      };
    },
    listRolePolicies: async () => {
      calls.push('listRolePolicies');
      return { PolicyNames: overrides.policyNames || ['ChecksOpsProductionSql53ConfigWriterInline'] };
    },
    listAttachedRolePolicies: async () => {
      calls.push('listAttachedRolePolicies');
      return { AttachedPolicies: overrides.attached || [] };
    },
    getRolePolicy: async () => {
      calls.push('getRolePolicy');
      return { PolicyDocument: overrides.permissions || PERMS };
    },
    updateAssumeRolePolicy: async (input) => {
      calls.push('updateAssumeRolePolicy');
      stub.lastUpdate = input;
      trustStatements = input.policyDocument.Statement;
    },
  };
  return stub;
}

test('Identity Center administrator identity is exact and refuses Cursor staging', () => {
  assert.equal(isIdentityCenterAdministratorIdentity(ADMIN), true);
  assert.equal(isIdentityCenterAdministratorIdentity({
    Account: '806168576068',
    Arn: 'arn:aws:sts::806168576068:assumed-role/ChecksOpsCursorCloudStaging/sql53-oidc-apply-read',
  }), false);
});

test('apply refuses non-admin identities before any IAM write', async () => {
  const aws = awsStub({
    identity: {
      Account: '806168576068',
      Arn: 'arn:aws:sts::806168576068:assumed-role/ChecksOpsCursorCloudStaging/sql53-oidc-apply-read',
    },
  });
  const result = await applySql53ConfigWriterOidcTrust({ apply: true }, {
    aws,
    env: { CHECKSOPS_SQL53_OIDC_TRUST_APPLY: '1' },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'PRODUCTION_APPROVAL_REQUIRED');
  assert.ok(!aws.calls.includes('updateAssumeRolePolicy'));
  assert.ok(!aws.calls.includes('getRole'));
});

test('apply appends OIDC and preserves the Identity Center statement', async () => {
  const aws = awsStub();
  const result = await applySql53ConfigWriterOidcTrust({ apply: true }, {
    aws,
    env: { CHECKSOPS_SQL53_OIDC_TRUST_APPLY: '1' },
  });
  assert.equal(result.ok, true);
  assert.equal(result.details.applied, true);
  assert.equal(result.details.identity_center_statement_preserved, true);
  assert.equal(result.details.writer_assumed, false);
  assert.deepEqual(aws.lastUpdate.policyDocument.Statement[0], IDENTITY_CENTER_ALLOW);
  assert.deepEqual(aws.lastUpdate.policyDocument.Statement[1], SQL53_CONFIG_WRITER_OIDC_STATEMENT);
});

test('apply refuses extra permissions and missing apply authorization', async () => {
  const forbidden = await applySql53ConfigWriterOidcTrust({ apply: true }, {
    aws: awsStub(),
    env: {},
  });
  assert.equal(forbidden.ok, false);
  assert.equal(forbidden.code, 'GUARD_APPLY_FORBIDDEN');

  const extra = await applySql53ConfigWriterOidcTrust({ apply: true }, {
    aws: awsStub({
      permissions: {
        Version: '2012-10-17',
        Statement: [{
          Effect: 'Allow',
          Action: [...SQL53_CONFIG_WRITER_REQUIRED_ACTIONS, 'lambda:UpdateFunctionCode'],
          Resource: SQL53_CONFIG_WRITER_FUNCTION_ARN,
        }],
      },
    }),
    env: { CHECKSOPS_SQL53_OIDC_TRUST_APPLY: '1' },
  });
  assert.equal(extra.ok, false);
  assert.equal(extra.code, 'UNRELATED_MUTATION');
});

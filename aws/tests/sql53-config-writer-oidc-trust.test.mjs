import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  SQL53_CONFIG_WRITER_FUNCTION_ARN,
  SQL53_CONFIG_WRITER_OIDC_AUD,
  SQL53_CONFIG_WRITER_OIDC_PROVIDER,
  SQL53_CONFIG_WRITER_OIDC_SID,
  SQL53_CONFIG_WRITER_OIDC_STATEMENT,
  SQL53_CONFIG_WRITER_OIDC_SUB,
  SQL53_CONFIG_WRITER_REQUIRED_ACTIONS,
  mergeSql53ConfigWriterOidcTrust,
  permissionsRemainSql53Only,
} from '../../scripts/deployment-guard/lib/sql53-config-writer-trust-merge.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ADDITIVE = JSON.parse(fs.readFileSync(path.join(ROOT, 'aws/production/sql53-config-writer-trust-additive-cursor-oidc.json'), 'utf8'));
const PERMS = JSON.parse(fs.readFileSync(path.join(ROOT, 'aws/production/sql53-config-writer-permissions.json'), 'utf8'));
const IDENTITY = JSON.parse(fs.readFileSync(path.join(ROOT, 'ops/deployment-guard/production-sql53-oidc-trust.json'), 'utf8'));
const RUNBOOK = fs.readFileSync(path.join(ROOT, 'ops/production-sql53-oidc-trust.md'), 'utf8');

const IDENTITY_CENTER_ALLOW = {
  Sid: 'AllowIdentityCenterAdministratorAccessUnchanged',
  Effect: 'Allow',
  Principal: {
    AWS: 'arn:aws:iam::806168576068:role/aws-reserved/sso.amazonaws.com/AWSReservedSSO_AdministratorAccess_TESTONLY',
  },
  Action: 'sts:AssumeRole',
};

function currentTrust(overrides = {}) {
  return {
    Version: '2012-10-17',
    Statement: [IDENTITY_CENTER_ALLOW],
    ...overrides,
  };
}

test('additive Cursor OIDC statement is pinned to the verified owner subject', () => {
  assert.deepEqual(ADDITIVE, SQL53_CONFIG_WRITER_OIDC_STATEMENT);
  assert.equal(ADDITIVE.Sid, SQL53_CONFIG_WRITER_OIDC_SID);
  assert.equal(ADDITIVE.Principal.Federated, SQL53_CONFIG_WRITER_OIDC_PROVIDER);
  assert.equal(ADDITIVE.Action, 'sts:AssumeRoleWithWebIdentity');
  assert.deepEqual(ADDITIVE.Condition.StringEquals, {
    'api.cursor.com:aud': SQL53_CONFIG_WRITER_OIDC_AUD,
    'api.cursor.com:sub': SQL53_CONFIG_WRITER_OIDC_SUB,
  });
  assert.equal(SQL53_CONFIG_WRITER_OIDC_SUB, 'user:325724407');
});

test('merge appends OIDC without changing Identity Center administrator access', () => {
  const merged = mergeSql53ConfigWriterOidcTrust(currentTrust());
  assert.equal(merged.ok, true);
  assert.equal(merged.details.changed, true);
  assert.equal(merged.details.document.Statement.length, 2);
  assert.deepEqual(merged.details.document.Statement[0], IDENTITY_CENTER_ALLOW);
  assert.deepEqual(merged.details.document.Statement[1], ADDITIVE);
});

test('merge is idempotent and refuses staging, other Cursor users, and empty current trust', () => {
  const once = mergeSql53ConfigWriterOidcTrust(currentTrust());
  const twice = mergeSql53ConfigWriterOidcTrust(once.details.document);
  assert.equal(twice.ok, true);
  assert.equal(twice.details.changed, false);
  assert.deepEqual(twice.details.document.Statement[0], IDENTITY_CENTER_ALLOW);

  const staging = mergeSql53ConfigWriterOidcTrust({
    Version: '2012-10-17',
    Statement: [
      IDENTITY_CENTER_ALLOW,
      {
        Effect: 'Allow',
        Principal: { AWS: 'role/ChecksOpsCursorCloudStaging' },
        Action: 'sts:AssumeRole',
      },
    ],
  });
  assert.equal(staging.ok, false);

  const otherUser = mergeSql53ConfigWriterOidcTrust({
    Version: '2012-10-17',
    Statement: [
      IDENTITY_CENTER_ALLOW,
      {
        ...ADDITIVE,
        Condition: {
          StringEquals: {
            'api.cursor.com:aud': 'sts.amazonaws.com',
            'api.cursor.com:sub': 'user:999999999',
          },
        },
      },
    ],
  });
  assert.equal(otherUser.ok, false);

  const empty = mergeSql53ConfigWriterOidcTrust({ Version: '2012-10-17', Statement: [] });
  assert.equal(empty.ok, false);
});

test('required writer permissions remain the three approved Lambda actions', () => {
  assert.equal(permissionsRemainSql53Only(PERMS), true);
  assert.deepEqual(PERMS.Statement[0].Action, SQL53_CONFIG_WRITER_REQUIRED_ACTIONS);
  assert.equal(PERMS.Statement[0].Resource, SQL53_CONFIG_WRITER_FUNCTION_ARN);
  assert.doesNotMatch(JSON.stringify(PERMS), /\*|UpdateFunctionCode|iam:PassRole|AdministratorAccess/);
});

test('prepare-only evidence does not authorize IAM apply or writer invoke', () => {
  assert.equal(IDENTITY.iam_update_authorized, false);
  assert.equal(IDENTITY.apply_authorized, false);
  assert.equal(IDENTITY.fingerprint_only_authorized, false);
  assert.equal(IDENTITY.can_assume_today, false);
  assert.equal(IDENTITY.selected_trust, 'additive-cursor-oidc-owner-pending-approval');
  assert.match(RUNBOOK, /STOP FOR APPROVAL/);
  assert.match(RUNBOOK, /Do not grant access to `ChecksOpsCursorCloudStaging`/);
  assert.match(RUNBOOK, /update-assume-role-policy/);
});

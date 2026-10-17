import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  SQL53_CONFIG_WRITER_FUNCTION_ARN,
  SQL53_CONFIG_WRITER_OIDC_STATEMENT,
  SQL53_CONFIG_WRITER_REQUIRED_ACTIONS,
  compareSql53ConfigWriterTrust,
  mergeSql53ConfigWriterOidcTrust,
  permissionsRemainSql53Only,
  removeSql53ConfigWriterOidcTrust,
} from '../../scripts/deployment-guard/lib/sql53-config-writer-trust-merge.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ADDITIVE = JSON.parse(fs.readFileSync(path.join(ROOT, 'aws/production/sql53-config-writer-trust-additive-cursor-oidc.json'), 'utf8'));
const PERMS = JSON.parse(fs.readFileSync(path.join(ROOT, 'aws/production/sql53-config-writer-permissions.json'), 'utf8'));
const REVIEW = JSON.parse(fs.readFileSync(path.join(ROOT, 'ops/deployment-guard/production-sql53-iam-cleanup-review.json'), 'utf8'));

const IDENTITY_CENTER_ALLOW = {
  Sid: 'AllowIdentityCenterAdministratorAccessUnchanged',
  Effect: 'Allow',
  Principal: {
    AWS: 'arn:aws:iam::806168576068:role/aws-reserved/sso.amazonaws.com/AWSReservedSSO_AdministratorAccess_TESTONLY',
  },
  Action: 'sts:AssumeRole',
};

const EXTRA_ALLOW = {
  Sid: 'UnrelatedExistingAllowMustStay',
  Effect: 'Allow',
  Principal: {
    AWS: 'arn:aws:iam::806168576068:role/aws-reserved/sso.amazonaws.com/AWSReservedSSO_AdministratorAccess_TESTONLY',
  },
  Action: 'sts:TagSession',
};

function currentTrust(extra = []) {
  return {
    Version: '2012-10-17',
    Statement: [IDENTITY_CENTER_ALLOW, SQL53_CONFIG_WRITER_OIDC_STATEMENT, ...extra],
  };
}

test('cleanup target is the exact approved Cursor OIDC owner statement', () => {
  assert.deepEqual(ADDITIVE, SQL53_CONFIG_WRITER_OIDC_STATEMENT);
  assert.equal(ADDITIVE.Sid, 'AllowOwnerCursorCloudOidcFingerprintOnly');
  assert.equal(ADDITIVE.Principal.Federated, 'arn:aws:iam::806168576068:oidc-provider/api.cursor.com');
  assert.deepEqual(ADDITIVE.Condition.StringEquals, {
    'api.cursor.com:aud': 'sts.amazonaws.com',
    'api.cursor.com:sub': 'user:325724407',
  });
});

test('remove deletes only the Cursor OIDC statement and keeps Identity Center plus extras', () => {
  const current = currentTrust([EXTRA_ALLOW]);
  const removed = removeSql53ConfigWriterOidcTrust(current);
  assert.equal(removed.ok, true);
  assert.equal(removed.details.changed, true);
  assert.deepEqual(removed.details.removed_statement, ADDITIVE);
  assert.deepEqual(removed.details.document.Statement, [IDENTITY_CENTER_ALLOW, EXTRA_ALLOW]);
  assert.equal(removed.details.comparison.only_approved_cursor_oidc_removed, true);
  assert.equal(removed.details.comparison.identity_center_preserved, true);
  assert.deepEqual(removed.details.comparison.added, []);
  assert.deepEqual(removed.details.comparison.removed, [ADDITIVE]);
  assert.deepEqual(removed.details.comparison.unchanged, [IDENTITY_CENTER_ALLOW, EXTRA_ALLOW]);
});

test('remove is the inverse of the official additive merge', () => {
  const baseline = {
    Version: '2012-10-17',
    Statement: [IDENTITY_CENTER_ALLOW],
  };
  const merged = mergeSql53ConfigWriterOidcTrust(baseline);
  assert.equal(merged.ok, true);
  const cleaned = removeSql53ConfigWriterOidcTrust(merged.details.document);
  assert.equal(cleaned.ok, true);
  assert.deepEqual(cleaned.details.document, baseline);
});

test('remove refuses if Identity Center would disappear or a different OIDC statement exists', () => {
  const oidcOnly = removeSql53ConfigWriterOidcTrust({
    Version: '2012-10-17',
    Statement: [SQL53_CONFIG_WRITER_OIDC_STATEMENT],
  });
  assert.equal(oidcOnly.ok, false);
  assert.equal(oidcOnly.code, 'UNRELATED_MUTATION');

  const otherUser = removeSql53ConfigWriterOidcTrust({
    Version: '2012-10-17',
    Statement: [
      IDENTITY_CENTER_ALLOW,
      {
        ...SQL53_CONFIG_WRITER_OIDC_STATEMENT,
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

  const staging = removeSql53ConfigWriterOidcTrust({
    Version: '2012-10-17',
    Statement: [
      IDENTITY_CENTER_ALLOW,
      SQL53_CONFIG_WRITER_OIDC_STATEMENT,
      {
        Effect: 'Allow',
        Principal: { AWS: 'role/ChecksOpsCursorCloudStaging' },
        Action: 'sts:AssumeRole',
      },
    ],
  });
  assert.equal(staging.ok, false);
});

test('compare reports no permission-policy edits and review remains apply-blocked', () => {
  const before = currentTrust();
  const after = removeSql53ConfigWriterOidcTrust(before).details.document;
  const comparison = compareSql53ConfigWriterTrust(before, after);
  assert.equal(comparison.ok, true);
  assert.equal(comparison.details.permissions_document_untouched, true);
  assert.equal(permissionsRemainSql53Only(PERMS), true);
  assert.deepEqual(PERMS.Statement[0].Action, SQL53_CONFIG_WRITER_REQUIRED_ACTIONS);
  assert.equal(PERMS.Statement[0].Resource, SQL53_CONFIG_WRITER_FUNCTION_ARN);
  assert.equal(REVIEW.iam_update_authorized, false);
  assert.equal(REVIEW.stop_for_approval, true);
  assert.equal(REVIEW.live_trust_read, 'AccessDenied');
});

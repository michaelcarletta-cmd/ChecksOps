import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const trust = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'aws/production/production-spa-deploy-role-trust.json'), 'utf8'),
);
const yaml = fs.readFileSync(path.join(ROOT, 'aws/production/production-spa-deploy-role.yaml'), 'utf8');
const lockPolicy = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'aws/production/production-frontend-bucket-lock-policy.json'), 'utf8'),
);

test('intended SPA deploy trust is scoped to the approved Cursor OIDC identity', () => {
  assert.equal(trust.Statement.length, 1);
  const stmt = trust.Statement[0];
  assert.equal(stmt.Sid, 'CursorCloudOidcLiveApiCursorCom');
  assert.equal(stmt.Effect, 'Allow');
  assert.equal(stmt.Action, 'sts:AssumeRoleWithWebIdentity');
  assert.equal(
    stmt.Principal.Federated,
    'arn:aws:iam::806168576068:oidc-provider/api.cursor.com',
  );
  assert.equal(stmt.Condition.StringEquals['api.cursor.com:aud'], 'sts.amazonaws.com');
  assert.equal(stmt.Condition.StringEquals['api.cursor.com:sub'], 'user:325724407');
  assert.equal(Object.keys(stmt.Principal).join(','), 'Federated');
  assert.ok(!JSON.stringify(trust).includes('*'));
  assert.ok(!JSON.stringify(trust).includes('ChecksOpsCursorCloudStaging'));
  assert.ok(!JSON.stringify(trust).includes('sts:AssumeRole"'));
  assert.ok(!JSON.stringify(trust).includes('oidc.cursor.sh'));
});

test('deploy-role template keeps DeployRole=false and uses the intended OIDC trust', () => {
  assert.match(yaml, /Default: "false"/);
  assert.match(yaml, /RoleName: ChecksOpsProductionSpaDeploy/);
  assert.match(yaml, /Policies: \[\]/);
  assert.match(yaml, /api\.cursor\.com:sub: user:325724407/);
  assert.match(yaml, /sts:AssumeRoleWithWebIdentity/);
  assert.doesNotMatch(yaml, /Principal: "\*"/);
  assert.doesNotMatch(yaml, /ChecksOpsCursorCloudStaging/);
});

test('production frontend explicit deny still excludes staging and names only the deploy role', () => {
  const deny = lockPolicy.Statement.find(
    (row) => row.Sid === 'DenyProductionSpaWritesExceptApprovedDeployRole',
  );
  assert.ok(deny);
  const allowed = deny.Condition.ArnNotLike['aws:PrincipalArn'];
  assert.ok(allowed.includes('arn:aws:iam::806168576068:role/ChecksOpsProductionSpaDeploy'));
  assert.ok(allowed.includes('arn:aws:sts::806168576068:assumed-role/ChecksOpsProductionSpaDeploy/*'));
  assert.ok(!allowed.some((arn) => arn.includes('ChecksOpsCursorCloudStaging')));
  assert.ok(!allowed.some((arn) => arn.includes('rehearsal')));
  const policyDeny = lockPolicy.Statement.find(
    (row) => row.Sid === 'DenyProductionSpaBucketPolicyChangesExceptRoot',
  );
  assert.deepEqual(policyDeny.Condition.ArnNotLike['aws:PrincipalArn'], [
    'arn:aws:iam::806168576068:root',
  ]);
});

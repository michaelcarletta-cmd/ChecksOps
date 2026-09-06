#!/usr/bin/env node
/**
 * T0: create the approved 8 Cognito users on the production pool and remap
 * identity_accounts. Never invites. Never touches the ninth UUID.
 * Never logs emails, passwords, or tokens.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { EXPECTED_EIGHT, NINTH_ID } from '../../identity/expected-mappings.mjs';

const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const REGION = 'us-east-1';
const POOL = 'us-east-1_h00WorYMT';
const STAGING_POOL = 'us-east-1_vPmQ7cL1F';
const LAMBDA = process.env.REHEARSAL_LAMBDA_NAME || 'checksops-staging-rehearsal-oneshot';

if (!process.argv.includes('--confirm-t0')) {
  console.error(JSON.stringify({
    error: 'refusing_identity_import',
    message: 'Pass --confirm-t0 after isolated DB/storage recon PASS.',
  }));
  process.exit(2);
}

if (POOL === STAGING_POOL) {
  console.error(JSON.stringify({ error: 'refusing_staging_pool' }));
  process.exit(2);
}

const awsJson = (args) => JSON.parse(execFileSync(AWS, ['--region', REGION, '--output', 'json', ...args], {
  encoding: 'utf8',
  maxBuffer: 8 * 1024 * 1024,
}) || '{}');

const tempPassword = () => `T0-${randomBytes(24).toString('base64url')}!aA1`;

const created = [];
const existing = [];
for (const row of EXPECTED_EIGHT) {
  if (row.applicationUserId === NINTH_ID) {
    console.error(JSON.stringify({ error: 'ninth_uuid_in_expected_eight' }));
    process.exit(2);
  }
  if (row.applicationUserId === row.cognitoSub) {
    console.error(JSON.stringify({ error: 'sub_equals_application_user_id' }));
    process.exit(2);
  }
  const subOf = (user) => {
    const attrs = user.UserAttributes || user.Attributes || user.User?.Attributes || [];
    return attrs.find((a) => a.Name === 'sub')?.Value || null;
  };
  let sub;
  try {
    const found = awsJson([
      'cognito-idp', 'admin-get-user',
      '--user-pool-id', POOL,
      '--username', row.email,
    ]);
    sub = subOf(found);
    existing.push(row.applicationUserId);
  } catch {
    const createdUser = awsJson([
      'cognito-idp', 'admin-create-user',
      '--user-pool-id', POOL,
      '--username', row.email,
      '--user-attributes', `Name=email,Value=${row.email}`, 'Name=email_verified,Value=true',
      '--message-action', 'SUPPRESS',
    ]);
    sub = subOf(createdUser) || subOf(createdUser.User || {});
    const pwd = tempPassword();
    execFileSync(AWS, [
      '--region', REGION, 'cognito-idp', 'admin-set-user-password',
      '--user-pool-id', POOL,
      '--username', row.email,
      '--password', pwd,
      '--permanent',
    ], { encoding: 'utf8', stdio: 'ignore' });
    created.push(row.applicationUserId);
  }
  if (!sub || sub === row.applicationUserId) {
    console.error(JSON.stringify({ error: 'invalid_or_colliding_sub', applicationUserId: row.applicationUserId }));
    process.exit(2);
  }
  row.productionCognitoSub = sub;
}

const links = EXPECTED_EIGHT.map((row) => ({
  applicationUserId: row.applicationUserId,
  cognitoSub: row.productionCognitoSub,
  email: row.email,
}));

const payload = {
  step: 'apply_production_identity_links',
  confirmT0Identity: true,
  links,
};
const outFile = '/tmp/t0/identity-links.json';
const invoked = spawnSync(AWS, [
  '--region', REGION, 'lambda', 'invoke',
  '--function-name', LAMBDA,
  '--cli-binary-format', 'raw-in-base64-out',
  '--payload', JSON.stringify(payload),
  outFile,
], { encoding: 'utf8' });

let lambda = {};
try { lambda = JSON.parse(execFileSync('cat', [outFile], { encoding: 'utf8' })); } catch { /* missing */ }

const users = awsJson(['cognito-idp', 'list-users', '--user-pool-id', POOL, '--max-items', '20']);
const userCount = (users.Users || []).length;

const report = {
  ok: invoked.status === 0 && lambda.ok === true && lambda.applied === 8 && lambda.ninthUntouched === true && userCount === 8,
  pool: POOL,
  stagingPoolTouched: false,
  usersInPool: userCount,
  created: created.length,
  alreadyPresent: existing.length,
  linked: lambda.applied || 0,
  ninthUntouched: lambda.ninthUntouched === true,
  realInvitationEmailsSent: false,
  emailsLogged: false,
  lambdaError: lambda.error || (invoked.status !== 0 ? invoked.stderr.slice(0, 240) : null),
};
console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);

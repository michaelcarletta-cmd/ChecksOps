#!/usr/bin/env node
/**
 * Phase 3A.2 — read-only TOTP enrollment preconditions.
 * Does not associate/verify TOTP, does not set preferred MFA, does not change role.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const REGION = 'us-east-1';
const POOL = 'us-east-1_h00WorYMT';
const EMAIL = 'mcarletta@freedomadj.com';
const APP_USER = '7dbb3009-f059-4767-b5dc-1c5c72379330';
const EXPECTED_SUB = '54a8b4c8-60d1-7028-cfbb-0eb2baee5592';
const FREEDOM = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const ARTIFACTS = '/opt/cursor/artifacts';

const awsJson = (args) => JSON.parse(execFileSync(AWS, ['--region', REGION, ...args], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
}));

const user = awsJson([
  'cognito-idp', 'admin-get-user',
  '--user-pool-id', POOL,
  '--username', EMAIL,
]);

const attrs = Object.fromEntries((user.UserAttributes || []).map((row) => [row.Name, row.Value]));
const sub = attrs.sub || null;
const mfaList = user.UserMFASettingList || [];
const preferred = user.PreferredMfaSetting || null;

const out = {
  email: EMAIL,
  applicationUserId: APP_USER,
  expectedCognitoSub: EXPECTED_SUB,
  cognitoSub: sub,
  mappingMatches: sub === EXPECTED_SUB,
  userStatus: user.UserStatus || null,
  enabled: user.Enabled === true,
  confirmed: String(user.UserStatus || '') === 'CONFIRMED',
  totpEnrolled: mfaList.includes('SOFTWARE_TOKEN_MFA'),
  userMfaSettingCount: mfaList.length,
  preferredMfaSet: Boolean(preferred),
  preferredMfa: preferred,
  pool: POOL,
  freedomTenantId: FREEDOM,
  expectedRole: 'admin',
  note: 'Membership/role reconfirmed from Phase 3A.1 live inspect; this script only reads Cognito. Do not enroll from the agent.',
};

fs.mkdirSync(ARTIFACTS, { recursive: true });
fs.writeFileSync(`${ARTIFACTS}/phase3a2-totp-precheck.json`, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
if (!out.confirmed || !out.enabled || !out.mappingMatches) process.exit(2);

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('production provider flags stay false and SAM forbids Environment=production', () => {
  const template = read('aws/template.yaml');
  assert.match(template, /AWS_PROVIDER_EXECUTION_ENABLED: "false"/);
  assert.match(template, /AWS_MOOV_ENABLED: "false"/);
  assert.match(template, /AWS_CHECKALT_ENABLED: "false"/);
  assert.match(template, /AWS_PLAID_ENABLED: "false"/);
  assert.match(template, /AWS_FINANCIAL_PERMISSIONS_ACTIVATED: "false"/);
  assert.match(template, /COGNITO_WEBAUTHN_ORIGIN: "https:\/\/staging\.checksops\.com"/);
  assert.match(template, /COGNITO_WEBAUTHN_RP_ID: "staging\.checksops\.com"/);
  const allowed = template.match(/AllowedValues:\n(?:[ \t]+-[^\n]+\n)+/);
  assert.ok(allowed);
  assert.match(allowed[0], /- staging\b/);
  assert.doesNotMatch(allowed[0], /- production\b/);
});

test('financial activation SQL remains a NOT_APPLIED stub and is not auto-applied', () => {
  const sql = read('aws/financial/sql/64_financial_activation_grants.sql');
  assert.match(sql, /DO NOT APPLY THIS FILE/);
  assert.match(sql, /NOT_APPLIED/);
  const ci = read('.github/workflows/aws-migration-ci.yml');
  assert.match(ci, /64_financial_activation_grants/);
});

test('live production frontend env stays Supabase-only', () => {
  const prod = read('.env.production');
  assert.match(prod, /VITE_SUPABASE_URL=/);
  assert.doesNotMatch(prod, /VITE_AUTH_PROVIDER=cognito/);
  assert.doesNotMatch(prod, /VITE_COGNITO_USER_POOL_ID=/);
  const example = read('.env.production.aws.example');
  assert.match(example, /DO NOT USE YET/);
  assert.match(example, /us-east-1_vPmQ7cL1F/);
  assert.match(example, /Plaid is not required/);
});

test('cutover runbook is STOP / BLOCKED and keeps bridges; Plaid is not required', () => {
  const runbook = read('aws/cutover/FINAL_PRODUCTION_CUTOVER_RUNBOOK.md');
  const matrix = read('aws/cutover/CUTOVER_READINESS_MATRIX.md');
  const scheduling = read('aws/cutover/SCHEDULING_READINESS.md');
  assert.match(runbook, /DO NOT EXECUTE PRODUCTION CUTOVER/);
  assert.match(runbook, /\*\*BLOCKED\*\* for executing production cutover/);
  assert.match(runbook, /Plaid \| \*\*N\/A/);
  assert.match(runbook, /must remain deployed/);
  assert.match(runbook, /64_financial_activation_grants\.sql/);
  assert.match(runbook, /READY TO SCHEDULE PRODUCTION CUTOVER: YES/);
  assert.match(matrix, /ChecksOps AWS overall/);
  assert.match(matrix, /\*\*BLOCKED\*\*/);
  assert.match(matrix, /READY TO SCHEDULE PRODUCTION CUTOVER: YES/);
  assert.match(scheduling, /READY TO SCHEDULE PRODUCTION CUTOVER: \*\*YES\*\*/);
  assert.match(scheduling, /AWS_CHECKALT_ENABLED/);
  assert.match(scheduling, /Point B/);
  const timing = read('aws/db-copy/rehearsal/WRITE_FREEZE_TIMING.md');
  assert.match(timing, /Production write-freeze \| \*\*NO\*\*/);
  assert.match(timing, /Recommended customer-facing window/);
  assert.match(timing, /45 minutes/);
  assert.doesNotMatch(runbook, /perform production cutover from this PR/i);
});

test('bridge teardown and webhook docs refuse current execution', () => {
  const teardown = read('aws/cutover/BRIDGE_TEARDOWN.md');
  const webhooks = read('aws/cutover/WEBHOOK_TRANSITION.md');
  const rollback = read('aws/cutover/ROLLBACK.md');
  assert.match(teardown, /DO NOT TEAR DOWN NOW/);
  assert.match(webhooks, /Do not redirect production Moov or CheckAlt webhooks/);
  assert.match(rollback, /Point A/);
  assert.match(rollback, /Point C/);
});

test('production example configs are marked do-not-deploy and keep flags false', () => {
  const params = read('aws/cutover/production/parameters.production.example.json');
  const sam = read('aws/cutover/production/samconfig.production.example.toml');
  const cf = read('aws/cutover/production/https-cloudfront.production.example.yaml');
  const cw = read('aws/cutover/production/cloudwatch-alarms.example.yaml');
  assert.match(params, /"doNotDeploy": true/);
  assert.match(params, /"AWS_PROVIDER_EXECUTION_ENABLED": "false"/);
  assert.match(sam, /DO NOT DEPLOY/);
  assert.match(cf, /DO NOT DEPLOY/);
  assert.match(cw, /DO NOT DEPLOY/);
  assert.match(cf, /AllowedValues: \['true'\]/);
});

test('dry-run scripts refuse --apply and print no production mutation', () => {
  const scripts = [
    ['aws/cutover/scripts/identity-migration-dry-run.mjs'],
    ['aws/cutover/scripts/identity-migration-dry-run.mjs', '--apply'],
    ['aws/cutover/scripts/bridge-teardown-dry-run.mjs'],
    ['aws/cutover/scripts/bridge-teardown-dry-run.mjs', '--apply'],
    ['aws/cutover/scripts/rollback-dry-run.mjs'],
  ];
  const identity = spawnSync(process.execPath, [path.join(ROOT, scripts[0][0])], { encoding: 'utf8' });
  assert.equal(identity.status, 0);
  const identityBody = JSON.parse(identity.stdout);
  assert.equal(identityBody.mappedEligibleCount, 8);
  assert.equal(identityBody.subEqualsApplicationUserIdCount, 0);
  assert.equal(identityBody.productionAuthSwitch, false);
  assert.doesNotMatch(identity.stdout, /@/);

  const identityApply = spawnSync(process.execPath, [path.join(ROOT, scripts[1][0]), '--apply'], { encoding: 'utf8' });
  assert.equal(identityApply.status, 2);

  const teardown = spawnSync(process.execPath, [path.join(ROOT, scripts[2][0])], { encoding: 'utf8' });
  assert.equal(teardown.status, 0);
  assert.equal(JSON.parse(teardown.stdout).wouldDeleteNow, false);

  const teardownApply = spawnSync(process.execPath, [path.join(ROOT, scripts[3][0]), '--apply'], { encoding: 'utf8' });
  assert.equal(teardownApply.status, 2);

  const rollback = spawnSync(process.execPath, [path.join(ROOT, scripts[4][0])], { encoding: 'utf8' });
  assert.equal(rollback.status, 0);
  assert.equal(JSON.parse(rollback.stdout).wouldChangeProduction, false);

  const timedApply = spawnSync(process.execPath, [path.join(ROOT, 'aws/db-copy/rehearsal/scripts/timed-cutover-rehearsal.mjs'), '--apply'], { encoding: 'utf8' });
  assert.equal(timedApply.status, 2);
  assert.match(timedApply.stderr, /refusing_cutover_apply/);
});

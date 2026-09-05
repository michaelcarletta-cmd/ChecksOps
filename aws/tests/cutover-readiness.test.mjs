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
  assert.match(runbook, /DO NOT EXECUTE PRODUCTION CUTOVER/);
  assert.match(runbook, /\*\*BLOCKED\*\* for executing production cutover/);
  assert.match(runbook, /Plaid \| \*\*N\/A/);
  assert.match(runbook, /must remain deployed/);
  assert.match(runbook, /64_financial_activation_grants\.sql/);
  assert.match(matrix, /ChecksOps AWS overall/);
  assert.match(matrix, /\*\*BLOCKED\*\*/);
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

test('production-prep templates keep flags off, skip apex aliases, and do not reuse staging Cognito', () => {
  const prep = read('aws/production/prep-stack.yaml');
  const api = read('aws/production/api-template.yaml');
  assert.match(prep, /Default: us-east-1_h00WorYMT/);
  assert.match(prep, /Default: checksops\.com/);
  assert.match(prep, /checksops-production-frontend-oac-prep2/);
  assert.match(prep, /OriginRequestPolicyId: 88a5eaf4-2fd4-4709-b370-b4c650ea3fcf/);
  assert.doesNotMatch(prep, /UserPoolName:/);
  assert.doesNotMatch(prep, /Default: us-east-1_vPmQ7cL1F/);
  assert.match(prep, /StagingPoolMustNotBeReused/);
  assert.doesNotMatch(prep, /Aliases:/);
  assert.match(prep, /no checksops.com aliases/);
  assert.match(api, /AllowedValues:\n      - production-prep/);
  assert.doesNotMatch(api, /- production\n/);
  assert.match(api, /AWS_PROVIDER_EXECUTION_ENABLED: "false"/);
  assert.match(api, /AWS_MOOV_ENABLED: "false"/);
  assert.match(api, /AWS_CHECKALT_ENABLED: "false"/);
  assert.match(api, /AWS_FINANCIAL_PERMISSIONS_ACTIVATED: "false"/);
  assert.match(api, /AWS_COGNITO_MFA_PREFERRED: "false"/);
  assert.match(api, /FunctionName: checksops-production-prep-api/);
  assert.match(api, /AlarmName: checksops-production-prep-api-errors/);
  assert.match(api, /Default: us-east-1_h00WorYMT/);
  assert.doesNotMatch(api, /Default: us-east-1_vPmQ7cL1F/);
  const apiCfn = read('aws/production/api-cfn.yaml');
  assert.match(apiCfn, /FunctionName: checksops-production-prep-api/);
  assert.match(apiCfn, /AWS_PROVIDER_EXECUTION_ENABLED: "false"/);
  assert.match(apiCfn, /AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED: "false"/);
  assert.match(apiCfn, /AWS_FINANCIAL_PERMISSIONS_ACTIVATED: "false"/);
  assert.doesNotMatch(apiCfn, /Default: us-east-1_vPmQ7cL1F/);
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
});

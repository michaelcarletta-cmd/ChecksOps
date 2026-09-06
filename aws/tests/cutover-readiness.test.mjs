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
  assert.match(apiCfn, /ExistingExecutionRoleArn/);
  assert.match(apiCfn, /checksops-staging-ApiFunctionRole-7E7XRyLe3nyi/);
  assert.doesNotMatch(apiCfn, /AWS::IAM::Role/);
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

test('write-freeze drill and identity scripts refuse production mutation flags', () => {
  const freezeApply = spawnSync(process.execPath, [path.join(ROOT, 'aws/cutover/scripts/write-freeze-drill.mjs'), '--apply'], { encoding: 'utf8' });
  assert.equal(freezeApply.status, 2);
  assert.match(freezeApply.stderr, /refusing_production_write_freeze/);

  const freezeFlag = spawnSync(process.execPath, [path.join(ROOT, 'aws/cutover/scripts/write-freeze-drill.mjs'), '--freeze'], { encoding: 'utf8' });
  assert.equal(freezeFlag.status, 2);

  const ninthSrc = read('aws/cutover/scripts/ninth-uuid-live-investigate.mjs');
  assert.match(ninthSrc, /Never prints emails/);
  assert.match(ninthSrc, /Never creates Cognito users/);
  assert.doesNotMatch(ninthSrc, /EXPECTED_EIGHT/);

  const freezeSrc = read('aws/cutover/scripts/write-freeze-drill.mjs');
  assert.match(freezeSrc, /Does not freeze production/);
  assert.match(freezeSrc, /does not run a final delta/);
});

test('safe-prep docs record WebAuthn, SES gap, realtime waiver, and ninth UUID not_found', () => {
  const matrix = read('aws/cutover/CUTOVER_READINESS_MATRIX.md');
  assert.match(matrix, /WebAuthn RP \*\*`checksops\.com`\*\*/);
  assert.match(matrix, /SES From \*\*PARTIAL\*\*/);
  assert.match(matrix, /Realtime 15s polling waived/);
  assert.match(matrix, /Ninth UUID \*\*not present\*\* on live production \(`not_found`\)/);
  assert.match(matrix, /https:\/\/kiqojucc02\.execute-api\.us-east-1\.amazonaws\.com\/prep/);
  assert.match(matrix, /ExistingExecutionRoleArn|existing staging Lambda role reused/);
  assert.doesNotMatch(matrix, /Pool WebAuthn RP ID not yet set/);

  const ses = read('aws/production/SES_FROM.md');
  assert.match(ses, /COGNITO_DEFAULT/);
  assert.match(ses, /ListIdentities/);
  assert.match(ses, /us-east-1_h00WorYMT/);
  assert.doesNotMatch(ses, /us-east-1_vPmQ7cL1F only/);

  const waiver = read('aws/cutover/REALTIME_POLLING_WAIVER.md');
  assert.match(waiver, /15s poll/);
  assert.match(waiver, /does not change `\.env\.production`/);

  const ninth = read('aws/identity/NINTH_UUID_RESOLUTION.md');
  assert.match(ninth, /not_found/);
  assert.match(ninth, /Do not invent an email/);

  const apiCfn = read('aws/production/api-cfn.yaml');
  assert.match(apiCfn, /Default: 'false'/);
  assert.doesNotMatch(apiCfn, /AWS::IAM::Role/);
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
  assert.equal(identityBody.ninth.classification, 'not_found');
  assert.equal(identityBody.ninthExcludedFromInvite, true);
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

test('T0 promote and identity import refuse without confirm flags', () => {
  const identity = spawnSync(process.execPath, [path.join(ROOT, 'aws/cutover/scripts/t0-identity-import.mjs')], { encoding: 'utf8' });
  assert.equal(identity.status, 2);
  assert.match(identity.stderr, /refusing_identity_import/);

  const promote = spawnSync(process.execPath, [path.join(ROOT, 'aws/cutover/scripts/t0-promote-live.mjs')], { encoding: 'utf8' });
  assert.equal(promote.status, 2);
  assert.match(promote.stderr, /refusing_live_promote/);

  const api = spawnSync(process.execPath, [path.join(ROOT, 'aws/cutover/scripts/t0-enable-prod-api.mjs')], { encoding: 'utf8' });
  assert.equal(api.status, 2);
  const spa = spawnSync(process.execPath, [path.join(ROOT, 'aws/cutover/scripts/t0-deploy-spa.mjs')], { encoding: 'utf8' });
  assert.equal(spa.status, 2);
  const dns = spawnSync(process.execPath, [path.join(ROOT, 'aws/cutover/scripts/t0-dns-switch.mjs')], { encoding: 'utf8' });
  assert.equal(dns.status, 2);

  const oneshot = read('aws/db-copy/rehearsal/oneshot-apply/index.mjs');
  assert.match(oneshot, /confirmChecksopsOverlay/);
  assert.match(oneshot, /confirmIsolatedReconPass/);
  assert.match(oneshot, /staging_only_identity/);
  assert.match(oneshot, /confirmT0Identity/);
  assert.match(oneshot, /Never applies 64_financial_activation_grants/);
});

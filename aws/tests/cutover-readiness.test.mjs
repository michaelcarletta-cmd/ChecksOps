import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('production provider flags stay false and SAM forbids Environment=production', () => {
  const template = read('aws/template.yaml');
  assert.match(template, /AWS_PROVIDER_EXECUTION_ENABLED: "false"/);
  assert.match(template, /AWS_MOOV_ENABLED: "false"/);
  assert.match(template, /AWS_CHECKALT_ENABLED: "false"/);
  assert.match(template, /AWS_PLAID_ENABLED: "false"/);
  assert.match(template, /AWS_FINANCIAL_PERMISSIONS_ACTIVATED: "false"/);
  assert.match(template, /AWS_COGNITO_MFA_PREFERRED: "false"/);
  assert.match(template, /COGNITO_WEBAUTHN_ORIGIN: "https:\/\/staging\.checksops\.com"/);
  assert.match(template, /COGNITO_WEBAUTHN_RP_ID: "staging\.checksops\.com"/);
  assert.match(template, /SIGN_BASE_URL: "https:\/\/staging\.checksops\.com"/);
  assert.match(template, /x-bridge-secret/);
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

test('production SAM example exists but live samconfig stays staging-only', () => {
  const live = read('aws/samconfig.toml');
  assert.match(live, /stack_name = "checksops-staging"/);
  assert.doesNotMatch(live, /stack_name = "checksops-production"/);
  const example = read('aws/cutover/production/samconfig.production.example.toml');
  assert.match(example, /DO NOT DEPLOY/);
  const params = read('aws/cutover/production/parameters.production.example.json');
  assert.match(params, /checksops\.com/);
  assert.match(params, /"AWS_PLAID_ENABLED": "false"/);
  const cognito = read('aws/cutover/production/COGNITO_PRODUCTION.md');
  assert.match(cognito, /us-east-1_vPmQ7cL1F/);
  assert.match(cognito, /do not reuse/);
});

test('cutover runbook is STOP / BLOCKED and keeps bridges; Plaid is not required', () => {
  const runbook = read('aws/cutover/FINAL_PRODUCTION_CUTOVER_RUNBOOK.md');
  assert.match(runbook, /DO NOT EXECUTE PRODUCTION CUTOVER/);
  assert.match(runbook, /\*\*BLOCKED\*\* for executing production cutover/);
  assert.match(runbook, /Plaid \| \*\*N\/A/);
  assert.match(runbook, /must remain deployed/);
  assert.match(runbook, /64_financial_activation_grants\.sql/);
  assert.doesNotMatch(runbook, /perform production cutover from this PR/i);
});

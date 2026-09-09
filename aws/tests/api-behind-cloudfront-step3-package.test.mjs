import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import {
  evaluateOriginVerify,
  publicVerifyState,
  safeObserveLog,
} from '../functions/origin-verify/authorizer.mjs';
import { publicVerifyLine, redactDeep } from '../origin-verify/lib.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const run = (rel, env = {}) =>
  spawnSync(process.execPath, [path.join(ROOT, rel)], {
    encoding: 'utf8',
    env: {
      ...process.env,
      CHECKSOPS_STEP3_EXECUTE: '',
      CHECKSOPS_APPLY_GATE3A: '',
      CHECKSOPS_APPLY_GATE3B: '',
      CHECKSOPS_APPLY_GATE3C: '',
      CHECKSOPS_OPERATOR_GATE3B: '',
      CHECKSOPS_OPERATOR_EXECUTE: '',
      CHECKSOPS_OPERATOR_PREFLIGHT: '',
      ORIGIN_VERIFY_REQUIRE: '',
      ...env,
    },
  });

const audit = read('aws/cutover/API_PERIMETER_STEP3_CALLER_AUDIT.md');
const gates = read('aws/cutover/API_PERIMETER_STEP3_GATES.md');
const banner = read('src/components/AwsStagingBanner.tsx');

test('caller audit is PASS after privileged operator list', () => {
  assert.match(audit, /\*\*Result: PASS\*\*/);
  assert.match(audit, /API Destinations \| none/);
  assert.match(audit, /Synthetics canaries \| none/);
  assert.match(audit, /checksops-prod-api-4xx/);
  assert.match(audit, /index-reP2FWHf\.js/);
  assert.match(audit, /holds\.ok=true/);
  assert.match(audit, /productionExecution=false/);
  assert.match(audit, /NOT_APPLIED/);
  assert.match(audit, /Do \*\*not\*\* begin Gate 3D/);
  assert.doesNotMatch(audit, /aws cloudfront update-distribution/);
  assert.doesNotMatch(audit, /DisableExecuteApiEndpoint=true/);
});

test('Gate 3A-3C package never enables require-mode or deploys', () => {
  assert.match(gates, /STOP FOR REVIEW\. DO NOT CREATE THE STEP 3 ROLE/);
  assert.match(gates, /DO NOT DEPLOY STEP 3/);
  assert.match(gates, /Gate 3D is a later/);
  assert.match(gates, /ORIGIN_VERIFY_REQUIRE=true/);
  assert.match(gates, /observe/);
  assert.match(gates, /OPTIONS \/\{\proxy\+\}/);
  assert.match(gates, /remove:header\.x-checksops-origin-verify/);
  assert.match(gates, /exit 2/);
  assert.match(gates, /productionExecution` \| \*\*false\*\*/);
  assert.match(gates, /NOT_APPLIED/);
  assert.match(gates, /UpdateDistribution/);
  assert.match(gates, /IntegrationUri/);
  assert.doesNotMatch(gates, /aws cloudfront update-distribution/);
  assert.doesNotMatch(gates, /DisableExecuteApiEndpoint=true/);
});

test('apply scripts refuse without and with the deploy gate', () => {
  for (const rel of [
    'aws/origin-verify/apply-gate3a.mjs',
    'aws/origin-verify/apply-gate3b.mjs',
    'aws/origin-verify/apply-gate3c.mjs',
  ]) {
    const blocked = run(rel);
    assert.equal(blocked.status, 2, rel);
    assert.match(blocked.stderr, /DO_NOT_DEPLOY/);
  }
  const a = run('aws/origin-verify/apply-gate3a.mjs', {
    CHECKSOPS_APPLY_GATE3A: 'I_UNDERSTAND_PRODUCTION',
  });
  assert.equal(a.status, 2);
  assert.match(a.stdout, /"attached":false/);
  assert.doesNotMatch(a.stdout, /SecretString/);
  assert.doesNotMatch(`${a.stdout}${a.stderr}`, /[a-f0-9]{32}/);
});

test('observe validate prints only public booleans and refuses secret input', () => {
  const ok = spawnSync(
    process.execPath,
    [path.join(ROOT, 'aws/origin-verify/observe-validate.mjs')],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        CHECKSOPS_OBSERVE_SAMPLE: JSON.stringify({
          originHeaderPresent: true,
          originHeaderValid: true,
        }),
      },
    },
  );
  assert.equal(ok.status, 0, ok.stderr);
  const parsed = JSON.parse(ok.stdout);
  assert.deepEqual(parsed.cloudfront, { originHeaderPresent: true, originHeaderValid: true });
  assert.doesNotMatch(ok.stdout, /HeaderValue|SecretString|current/);

  const bad = spawnSync(
    process.execPath,
    [path.join(ROOT, 'aws/origin-verify/observe-validate.mjs'), '{"HeaderValue":"abc"}'],
    { encoding: 'utf8', env: process.env },
  );
  assert.equal(bad.status, 2);
});

test('authorizer public states and redaction never leak header values', () => {
  const secrets = { current: 'current-secret-value', next: '' };
  const state = publicVerifyState({ header: 'current-secret-value', secrets });
  assert.deepEqual(state, { originHeaderPresent: true, originHeaderValid: true });
  const line = safeObserveLog({ requestId: 'abc', state });
  assert.doesNotMatch(line, /current-secret-value/);
  assert.match(line, /"originHeaderPresent":true/);
  const result = evaluateOriginVerify({ header: 'nope', secrets, require: false });
  assert.equal(result.isAuthorized, true);
  assert.equal(result.context.originHeaderValid, '0');
  const redacted = redactDeep({
    CustomHeaders: { Quantity: 1, Items: [{ HeaderName: 'x-checksops-origin-verify', HeaderValue: 'secret' }] },
    SecretString: '{"current":"secret"}',
  });
  assert.equal(redacted.CustomHeaders.Items[0].HeaderValue, '[REDACTED]');
  assert.equal(redacted.SecretString, '[REDACTED]');
  assert.deepEqual(publicVerifyLine({ originHeaderPresent: 1, originHeaderValid: 0 }), {
    originHeaderPresent: true,
    originHeaderValid: false,
  });
});

test('audit and deploy role templates stay gated and read-only vs mutate', () => {
  const auditYaml = read('aws/production/cursor-api-perimeter-step3-audit-role.yaml');
  const deployYaml = read('aws/production/cursor-api-perimeter-step3-role.yaml');
  assert.match(auditYaml, /DeployRole:\n    Type: String\n    Default: "false"/);
  assert.match(auditYaml, /ChecksOpsCursorApiPerimeterStep3AuditTemp/);
  assert.match(auditYaml, /secretsmanager:GetSecretValue/);
  assert.match(deployYaml, /DeployRole:\n    Type: String\n    Default: "false"/);
  assert.match(deployYaml, /ChecksOpsCursorApiPerimeterStep3Temp/);
  const allow = JSON.parse(read('aws/production/cursor-api-perimeter-step3-audit-role-allow.json'));
  const deny = JSON.parse(read('aws/production/cursor-api-perimeter-step3-audit-role-deny.json'));
  assert.ok(JSON.stringify(allow).length < 6144);
  assert.ok(JSON.stringify(deny).length < 6144);
  assert.match(JSON.stringify(allow), /events:ListRules/);
  assert.match(JSON.stringify(deny), /GetSecretValue/);
  assert.doesNotMatch(JSON.stringify(allow), /UpdateDistribution|CreateFunction|PutSecretValue/);
});

test('Gate 3A blocked record does not deploy and keeps execute-api', () => {
  const blocked = read('aws/cutover/API_PERIMETER_STEP3_GATE3A_ROLE_BLOCKED.md');
  assert.match(blocked, /Gate 3A BLOCKED/);
  assert.match(blocked, /AuthorizationType=NONE/);
  assert.match(blocked, /ChecksOpsCursorApiPerimeterStep3Temp/);
  assert.match(blocked, /Do \*\*not\*\* begin Gate 3D/);
  assert.doesNotMatch(blocked, /DisableExecuteApiEndpoint=true/);
  assert.doesNotMatch(blocked, /ORIGIN_VERIFY_REQUIRE=true/);
});

test('banner is hostname-gated and financial SQL remains unapplied', () => {
  assert.match(banner, /AWS staging — Cognito \+ RDS/);
  assert.match(banner, /isAwsStagingEnvironment/);
  assert.doesNotMatch(banner, /if \(!isAwsStaging\(\)\)/);
  assert.match(read('aws/financial/sql/64_financial_activation_grants.sql'), /DO NOT APPLY THIS FILE/);
  assert.match(read('aws/origin-verify/authorizer-config.json'), /"AuthorizerResultTtlInSeconds": 0/);
  assert.match(read('aws/origin-verify/options-route.json'), /OPTIONS \/\{\proxy\+\}/);
  assert.match(
    read('aws/origin-verify/integration-header-remove.json'),
    /remove:header\.x-checksops-origin-verify/,
  );
});

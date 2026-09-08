import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { parseObserveLogLine } from '../origin-verify/lib.mjs';

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

test('Gate 3C PASS record is observe-only and has no secret material', () => {
  const pass = read('aws/cutover/API_PERIMETER_STEP3_GATE3C_PASS.md');
  assert.match(pass, /Gate 3C PASS/);
  assert.match(pass, /observe only/i);
  assert.match(pass, /ORIGIN_VERIFY_REQUIRE.*false/i);
  assert.match(pass, /AuthorizationType=NONE/);
  assert.match(pass, /overwrite:header\.x-checksops-origin-verify/);
  assert.match(pass, /integrationStillPrep=true/);
  assert.match(pass, /`originHeaderPresent`/);
  assert.match(pass, /`originHeaderValid`/);
  assert.match(pass, /CloudFront `https:\/\/checksops\.com\/prep\/health` \| `true` \| `true`/);
  assert.match(pass, /Raw `https:\/\/kiqojucc02\.execute-api\.us-east-1\.amazonaws\.com\/prep\/health` \| `false` \| `false`/);
  assert.match(pass, /Do \*\*not\*\* start Gate 3D/);
  assert.match(pass, /financialActivationSqlApplied=false/);
  assert.match(pass, /DisableExecuteApiEndpoint.*false/);
  assert.doesNotMatch(pass, /ORIGIN_VERIFY_REQUIRE=true/);
  assert.doesNotMatch(pass, /DisableExecuteApiEndpoint=true/);
  assert.doesNotMatch(pass, /HeaderValue\s*[:=]\s*["'][^"']{4,}/);
  assert.doesNotMatch(pass, /SecretString/);
  assert.doesNotMatch(pass, /"current"\s*:\s*"[A-Za-z0-9+/=]{8,}"/);
});

test('apply-gate3c stays observe-only and plans overwrite empty-string strip', () => {
  const src = read('aws/origin-verify/apply-gate3c.mjs');
  assert.match(src, /overwrite:header\.\$\{HEADER_NAME\}/);
  assert.match(src, /Does not set ORIGIN_VERIFY_REQUIRE=true/);
  assert.doesNotMatch(src, /ORIGIN_VERIFY_REQUIRE["']?\s*[:=]\s*["']true["']/);
  assert.doesNotMatch(src, /DisableExecuteApiEndpoint["']?\s*:\s*true/);
  assert.doesNotMatch(src, /GetSecretValue/);

  const blocked = run('aws/origin-verify/apply-gate3c.mjs');
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /DO_NOT_DEPLOY/);

  const planned = run('aws/origin-verify/apply-gate3c.mjs', {
    CHECKSOPS_APPLY_GATE3C: 'I_UNDERSTAND_PRODUCTION',
  });
  assert.equal(planned.status, 2);
  assert.match(planned.stdout, /"attachMode":"observe"/);
  assert.match(planned.stdout, /"ORIGIN_VERIFY_REQUIRE":false/);
  assert.match(planned.stdout, /jci10de/);
  assert.doesNotMatch(`${planned.stdout}${planned.stderr}`, /SecretString|HeaderValue/);
});

test('validate-observe requires overwrite strip and raw invalid header', () => {
  const src = read('aws/origin-verify/validate-observe.mjs');
  assert.match(src, /overwrite:header\.\$\{HEADER_NAME\}/);
  assert.match(src, /headerStrippedOnIntegration/);
  assert.match(src, /executeApiDirect\.originHeaderValid === false/);
  assert.match(src, /parseObserveLogLine/);
  assert.doesNotMatch(src, /ORIGIN_VERIFY_REQUIRE["']?\s*[:=]\s*["']true["']/);
});

test('parseObserveLogLine reads CloudWatch-prefixed public booleans only', () => {
  const prefixed = '2026-09-08T18:51:00.000Z\tabc\tINFO\t{"requestId":"abc","originHeaderPresent":true,"originHeaderValid":true}';
  assert.deepEqual(parseObserveLogLine(prefixed), {
    originHeaderPresent: true,
    originHeaderValid: true,
  });
  assert.deepEqual(
    parseObserveLogLine('2026-09-08T18:51:00.000Z\t{"originHeaderPresent":false,"originHeaderValid":false}'),
    { originHeaderPresent: false, originHeaderValid: false },
  );
  assert.equal(parseObserveLogLine('START RequestId: abc'), null);

  const observed = spawnSync(
    process.execPath,
    [
      path.join(ROOT, 'aws/origin-verify/observe-validate.mjs'),
      '2026-09-08T18:51:00.000Z\t{"originHeaderPresent":true,"originHeaderValid":true}',
      '2026-09-08T18:51:01.000Z\t{"originHeaderPresent":false,"originHeaderValid":false}',
    ],
    { encoding: 'utf8', env: { ...process.env, CHECKSOPS_OBSERVE_SAMPLE: '' } },
  );
  assert.equal(observed.status, 0, observed.stderr);
  const parsed = JSON.parse(observed.stdout);
  assert.deepEqual(parsed.cloudfront, { originHeaderPresent: true, originHeaderValid: true });
  assert.deepEqual(parsed.executeApiDirect, { originHeaderPresent: false, originHeaderValid: false });
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const run = (rel, env = {}) =>
  spawnSync(process.execPath, [path.join(ROOT, rel)], {
    encoding: 'utf8',
    env: {
      ...process.env,
      CHECKSOPS_STEP3_EXECUTE: '',
      CHECKSOPS_OPERATOR_EXECUTE: '',
      CHECKSOPS_OPERATOR_GATE3B: '',
      CHECKSOPS_OPERATOR_PREFLIGHT: '',
      ORIGIN_VERIFY_REQUIRE: '',
      ...env,
    },
  });

test('operator Gate 3B script is plan-only and refuses require-mode', () => {
  const script = read('aws/origin-verify/operator-apply-gate3b.mjs');
  const validate = read('aws/origin-verify/operator-validate-gate3b.mjs');
  const handoff = read('aws/cutover/API_PERIMETER_STEP3_OPERATOR_GATE3B.md');
  assert.match(script, /refusing_waf_mismatch/);
  assert.match(script, /refusing_prep_behavior_mismatch/);
  assert.match(script, /refusing_custom_headers_not_zero/);
  assert.match(script, /refusing_wrong_distribution/);
  assert.match(script, /refusing_step3temp/);
  assert.match(script, /shredPath/);
  assert.match(script, /ProductionPrepHttpApi/);
  assert.match(script, /4135ea2d-6df8-44a3-9df3-4b5a84be39ad/);
  assert.match(script, /b689b0a8-53d0-40ab-baf2-68738e2966ac/);
  assert.match(script, /Do not start Gate 3C/);
  assert.doesNotMatch(script, /update-route/);
  assert.doesNotMatch(script, /create-authorizer/);
  assert.doesNotMatch(script, /DisableExecuteApiEndpoint=true/);
  assert.doesNotMatch(validate, /get-secret-value/);
  assert.match(handoff, /DO NOT DEPLOY GATE 3C/);
  assert.match(handoff, /CHECKSOPS_OPERATOR_EXECUTE=1/);
  assert.match(handoff, /Do not broaden/);

  const planned = run('aws/origin-verify/operator-apply-gate3b.mjs');
  assert.equal(planned.status, 2);
  assert.match(planned.stdout, /"operatorOnly":true/);
  assert.match(planned.stdout, /"headerValuePrinted":false/);
  assert.match(planned.stdout, /"startGate3C":false/);
  assert.doesNotMatch(`${planned.stdout}${planned.stderr}`, /SecretString|HeaderValue/);
});

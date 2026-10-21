import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

import { enforceSharedStackTarget } from '../../scripts/deployment-guard/require-guard.mjs';
import { CODES } from '../../scripts/deployment-guard/lib/errors.mjs';
import {
  RETIRED_STACKS,
  SHARED_STACKS,
  lookupRetiredStack,
  lookupSharedStack,
} from '../../scripts/deployment-guard/lib/shared-targets.mjs';

const read = (rel) => fs.readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');
const TEMPLATES = ['aws/production/api-cfn.yaml', 'aws/production/api-template.yaml'];

for (const rel of TEMPLATES) {
  test(`${rel} is marked retired and carries a CloudFormation rule that always fails`, () => {
    const source = read(rel);
    assert.match(source, /^# RETIRED\. DO NOT DEPLOY\./);
    // Rules sits at the top level, before Conditions, and asserts two different literals are equal,
    // so CloudFormation refuses every change set built from this file.
    assert.match(source, /\nRules:\n  RetiredTemplateMustNotDeploy:\n    Assertions:\n      - Assert: !Equals \['retired', 'deployable'\]\n        AssertDescription: >-\n          RETIRED template\./);
    assert.ok(source.indexOf('\nRules:\n') < source.indexOf('\nConditions:\n'));
    assert.equal(source.match(/\nRules:\n/g).length, 1);
  });
}

test('the production API stack is retired in the guard and never a shared stack target', () => {
  const retired = lookupRetiredStack('checksops-production-prep-api');
  assert.ok(retired);
  assert.deepEqual(retired.templates, TEMPLATES);
  assert.equal(lookupSharedStack('checksops-production-prep-api'), null);
  for (const name of Object.keys(RETIRED_STACKS)) {
    assert.equal(Object.prototype.hasOwnProperty.call(SHARED_STACKS, name), false, name);
  }
  const refused = enforceSharedStackTarget({ stackName: 'checksops-production-prep-api', script: import.meta.url });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, CODES.UNRELATED_MUTATION);
  assert.match(refused.message, /retired stack/);
  // Padding does not slip past the lookup.
  assert.equal(enforceSharedStackTarget({ stackName: ' checksops-production-prep-api ', script: import.meta.url }).code, CODES.UNRELATED_MUTATION);
  // An unregistered stack still fails closed as before.
  assert.equal(enforceSharedStackTarget({ stackName: 'checksops-unknown-stack', script: import.meta.url }).code, CODES.DEPLOYMENT_GUARD_REQUIRED);
});

test('the production README has no deploy command for the retired API stack and names the guarded paths', () => {
  const readme = read('aws/production/README.md');
  assert.doesNotMatch(readme, /--stack-name checksops-production-prep-api\b/);
  assert.doesNotMatch(readme, /--template-file aws\/production\/api-(cfn|template)\.yaml/);
  assert.match(readme, /## Retired stack templates \(do not deploy\)/);
  for (const workflow of ['guarded-production-lambda-overlay.yml', 'guarded-production-lambda-rebuild.yml', 'guarded-production-lambda-config.yml', 'guarded-production-spa-upload.yml']) {
    assert.ok(readme.includes(workflow), workflow);
    assert.ok(fs.existsSync(new URL(`../../.github/workflows/${workflow}`, import.meta.url)), workflow);
  }
  // The prep stack (Cognito client, bucket, CloudFront) keeps its operator deploy.
  assert.match(readme, /--stack-name checksops-production-prep\b/);
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const workflow = read('.github/workflows/sql53-manual-ssm-pin-transfer.yml');
const document = JSON.parse(read('ops/security/sql53-pin-transfer/ssm-document.json'));
const pin = read('ops/deployment-guard/sql53-production-apply.json');
const pinSha256 = createHash('sha256').update(pin).digest('hex');

test('manual transfer binds the exact pin and source to the fixed function', () => {
  assert.equal(pinSha256, '1116f31148ad7a6a537c087fc85db693366a0b736926ebf30ccf4a65bf3b8471');
  assert.match(workflow, new RegExp(pinSha256));
  assert.match(workflow, /5a8f8bc35c69f2b339c78f3637d6bb1c606117967e3ab9d83b5dec1d37561197/);
  assert.match(workflow, /public\.save_claim_settlement_breakdown\(uuid,uuid,jsonb\)/);
  assert.equal(document.parameters.PinPart1.interpolationType, 'ENV_VAR');
  assert.equal(document.parameters.PinPart2.interpolationType, 'ENV_VAR');
  const script = document.mainSteps[0].inputs.runCommand.join('\n');
  for (const value of [
    pinSha256,
    '5a8f8bc35c69f2b339c78f3637d6bb1c606117967e3ab9d83b5dec1d37561197',
    'public.save_claim_settlement_breakdown(uuid,uuid,jsonb)',
    'os.replace(replacement_path, TARGET)',
  ]) {
    assert.ok(script.includes(value), `fixed SSM script must include ${value}`);
  }
});

test('workflow can invoke only document version 1, not general shell', () => {
  assert.match(workflow, /--document-name","ChecksOpsSql53PinTransfer","--document-version","1"/);
  assert.match(workflow, /"ssm:DocumentVersion":"1"/);
  assert.doesNotMatch(workflow, /AWS-RunShellScript/);
  assert.match(workflow, /ssm:GetCommandInvocation","Resource":"\*"/);
  assert.match(workflow, /"refs\/heads\/main"/);
  assert.match(workflow, /persist-credentials: false/);
});

test('custom SSM document has a fixed script and bounded literal payload inputs', () => {
  assert.equal(document.schemaVersion, '2.2');
  assert.deepEqual(Object.keys(document.parameters).sort(), ['PinPart1', 'PinPart2']);
  assert.equal(document.mainSteps.length, 1);
  assert.equal(document.mainSteps[0].action, 'aws:runShellScript');
  const script = document.mainSteps[0].inputs.runCommand.join('\n');
  assert.match(script, /os\.environ\["SSM_PinPart1"\]/);
  assert.match(script, /os\.environ\["SSM_PinPart2"\]/);
  assert.doesNotMatch(script, /subprocess|os\.system|eval\(/);
});

test('workflow fails closed for unsuccessful SSM states and missing verification', () => {
  assert.match(workflow, /status in \("Pending","InProgress","Delayed","Cancelling"\)/);
  assert.match(workflow, /if status != "Success"/);
  assert.match(workflow, /SQL53_PIN_TRANSFER_VERIFIED_NO_SQL_EXECUTED/);
  assert.match(workflow, /Timed out waiting for SSM transfer verification/);
});

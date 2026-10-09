import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { CODES } from '../../scripts/deployment-guard/lib/errors.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENSURE = path.join(ROOT, 'scripts/deployment-guard/sql-executor-ensure.mjs');
const EXPECTED_SHA = 'eWyfw2kGKayio0CGs13FQWYDsyB1jrS5wKEIs+Pk6iM=';
const EXPECTED_REV = '419c3227-a55a-4c29-9ba8-16cca009350f';
const ROLE = 'arn:aws:iam::806168576068:role/checksops-staging-guarded-sql-executor';

function jsonLine(value) {
  return JSON.stringify(value).replace(/'/g, `'\\''`);
}

function writeFakeAws(dir, mode) {
  const log = path.join(dir, 'aws-calls.log');
  const bin = path.join(dir, 'fake-aws');
  const live = {
    FunctionName: 'checksops-staging-guarded-sql-executor',
    CodeSha256: mode === 'mismatch' ? 'other-sha' : EXPECTED_SHA,
    RevisionId: mode === 'mismatch' ? 'other-rev' : EXPECTED_REV,
    Role: ROLE,
    Timeout: 120,
    MemorySize: 256,
    VpcConfig: {
      VpcId: 'vpc-09f2268778966ce97',
      SubnetIds: ['subnet-0df2518070c5b9ff0'],
      SecurityGroupIds: ['sg-0fe2698f236959353'],
    },
    Environment: {
      Variables: {
        ADMIN_SECRET_ARN: 'arn:aws:secretsmanager:us-east-1:806168576068:secret:rds-db-credentials/checksops-staging/checksops_admin/x',
        DATABASE_NAME: 'checksops',
        EXECUTOR_IDENTITY: 'checksops-staging-guarded-sql-executor',
      },
    },
  };
  const afterCode = {
    ...live,
    CodeSha256: 'new-sha',
    RevisionId: 'after-code-revision',
  };
  const rehearsal = {
    Role: 'arn:aws:iam::806168576068:role/checksops-staging-rehearsal-oneshot',
    Environment: {
      Variables: {
        ADMIN_SECRET_ARN: 'arn:aws:secretsmanager:us-east-1:806168576068:secret:rds-db-credentials/checksops-staging/checksops_admin/1788286368527-Kv5tBt',
        RDS_HOST: 'checksops-staging.cyr0q4kcop3c.us-east-1.rds.amazonaws.com',
        SECRETS_MANAGER_ENDPOINT: 'https://vpce.example',
      },
    },
  };
  const api = {
    VpcConfig: live.VpcConfig,
  };
  const codeUpdate = mode === 'code-fail'
    ? 'echo CODE_FAIL >&2; exit 1'
    : 'printf \'{"CodeSha256":"new-sha","RevisionId":"after-code-revision"}\\n\'; exit 0';

  fs.writeFileSync(bin, `#!/bin/sh
printf '%s\\n' "$*" >> "${log}"
cmd="$*"
if printf '%s' "$cmd" | grep -q 'update-function-code'; then
  ${codeUpdate}
fi
if printf '%s' "$cmd" | grep -q 'update-function-configuration'; then
  printf '{"RevisionId":"after-config-revision"}\\n'
  exit 0
fi
if printf '%s' "$cmd" | grep -q 'create-function'; then
  echo CREATE_FORBIDDEN >&2
  exit 2
fi
if printf '%s' "$cmd" | grep -q 'wait'; then
  exit 0
fi
if printf '%s' "$cmd" | grep -q 'checksops-staging-rehearsal-oneshot'; then
  printf '%s\\n' '${jsonLine(rehearsal)}'
  exit 0
fi
if printf '%s' "$cmd" | grep -q 'checksops-staging-api'; then
  printf '%s\\n' '${jsonLine(api)}'
  exit 0
fi
if printf '%s' "$cmd" | grep -q 'get-function-configuration'; then
  if grep -q 'update-function-code' "${log}" 2>/dev/null; then
    printf '%s\\n' '${jsonLine(afterCode)}'
    exit 0
  fi
  printf '%s\\n' '${jsonLine(live)}'
  exit 0
fi
echo unexpected >&2
exit 1
`);
  fs.chmodSync(bin, 0o755);
  return { log, bin };
}

function runEnsure(dir, extraArgs, mode = 'ok') {
  const { log, bin } = writeFakeAws(dir, mode);
  const result = spawnSync(process.execPath, [ENSURE, ...extraArgs], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      AWS_CLI: bin,
      HOME: dir,
      CHECKSOPS_DEPLOYMENT_GUARD_ROOT: dir,
    },
  });
  return {
    result,
    log: fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '',
  };
}

const APPROVED_ARGS = [
  '--workstream-id', 'staging-sql53-3bc9',
  '--commit', '3b186ef27f9a3e27a10b8368ef2eb737998898f2',
];

test('sql-executor-ensure refuses to write without expected fingerprint CAS', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'checksops-sql-ens-cas-'));
  const { result, log } = runEnsure(dir, APPROVED_ARGS);
  assert.notEqual(result.status, 0);
  const payload = JSON.parse(result.stderr || result.stdout);
  assert.equal(payload.code, CODES.DEPLOYMENT_COLLISION);
  assert.match(payload.message, /expected CodeSha256 and RevisionId CAS/);
  assert.equal(log, '');
});

test('sql-executor-ensure stops on live fingerprint drift before packing or updating', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'checksops-sql-ens-drift-'));
  const { result, log } = runEnsure(dir, [
    ...APPROVED_ARGS,
    '--expected-code-sha256', EXPECTED_SHA,
    '--expected-revision-id', EXPECTED_REV,
  ], 'mismatch');
  assert.notEqual(result.status, 0);
  const payload = JSON.parse(result.stderr || result.stdout);
  assert.equal(payload.code, CODES.DEPLOYMENT_COLLISION);
  assert.match(payload.message, /fingerprint changed after preflight/);
  assert.match(log, /get-function-configuration/);
  assert.equal(log.includes('update-function-code'), false);
  assert.equal(log.includes('create-function'), false);
});

test('failed update-function-code never falls through to create-function', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'checksops-sql-ens-fail-'));
  const { result, log } = runEnsure(dir, [
    ...APPROVED_ARGS,
    '--expected-code-sha256', EXPECTED_SHA,
    '--expected-revision-id', EXPECTED_REV,
  ], 'code-fail');
  assert.notEqual(result.status, 0);
  const payload = JSON.parse(result.stderr || result.stdout);
  assert.equal(payload.code, CODES.DEPLOYMENT_COLLISION);
  assert.match(log, /update-function-code/);
  assert.match(log, new RegExp(`--revision-id ${EXPECTED_REV}`));
  assert.equal(log.includes('create-function'), false);
});

test('successful ensure passes RevisionId CAS on code and configuration updates', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'checksops-sql-ens-ok-'));
  const { result, log } = runEnsure(dir, [
    ...APPROVED_ARGS,
    '--expected-code-sha256', EXPECTED_SHA,
    '--expected-revision-id', EXPECTED_REV,
  ], 'ok');
  assert.equal(result.status, 0, `${result.stderr}${result.stdout}`);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.details.created, false);
  assert.equal(payload.details.invoked, false);
  assert.equal(payload.details.sql_executed, false);
  assert.equal(payload.details.receipt_issued, false);
  assert.match(log, new RegExp(`update-function-code.*--revision-id ${EXPECTED_REV}`));
  assert.match(log, /update-function-configuration.*--revision-id after-code-revision/);
  assert.equal(log.includes('create-function'), false);
  assert.equal(log.includes(' invoke '), false);
});

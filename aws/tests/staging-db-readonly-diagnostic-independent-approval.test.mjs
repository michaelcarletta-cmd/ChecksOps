import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync, sign } from 'node:crypto';
import { test } from 'node:test';
import { main as deployMain } from '../../scripts/staging-db-readonly-diagnostic-deploy.mjs';
import {
  CREATE_APPROVAL_KIND,
  CREATE_APPROVAL_LEDGER,
  CREATE_APPROVAL_TARGET,
  INDEPENDENT_APPROVAL_BLOCKER,
  INDEPENDENT_APPROVAL_REUSED,
  INDEPENDENT_APPROVAL_UNVERIFIED,
  OWNER_EVIDENCE,
  canonicalCreateApprovalPayload,
  consumedCreateApprovalObjectKey,
  createPersistentMemoryLedger,
  createS3CreateApprovalLedger,
  requireCreateOnlyLedgerPutObjectArgs,
  requireIndependentCreateApproval,
} from '../../scripts/staging-db-readonly-diagnostic-independent-approval.mjs';

const COMMIT = 'a'.repeat(40);
const KEY_ARN = 'arn:aws:kms:us-east-1:806168576068:key/11111111-2222-3333-4444-555555555555';
const APPROVER = 'arn:aws:iam::806168576068:role/ChecksOpsOwnerDiagnosticCreateApprover';
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const PUBLIC_DER = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'diagnostic-create-approval-'));
}

function approvalEnv(overrides = {}) {
  return {
    CHECKSOPS_STAGING_DB_DIAGNOSTIC_APPROVAL_KMS_KEY_ARN: KEY_ARN,
    CHECKSOPS_STAGING_DB_DIAGNOSTIC_APPROVAL_PUBLIC_KEY_DER_B64: PUBLIC_DER,
    ...overrides,
  };
}

function unsignedApproval(overrides = {}) {
  const now = Date.parse('2026-10-09T12:00:00.000Z');
  return {
    kind: CREATE_APPROVAL_KIND,
    commit: COMMIT,
    workstream_id: CREATE_APPROVAL_TARGET.workstreamId,
    target_environment: CREATE_APPROVAL_TARGET.environment,
    target_component: CREATE_APPROVAL_TARGET.component,
    stack_name: CREATE_APPROVAL_TARGET.stackName,
    function_name: CREATE_APPROVAL_TARGET.functionName,
    account: CREATE_APPROVAL_TARGET.account,
    region: CREATE_APPROVAL_TARGET.region,
    deployment_type: CREATE_APPROVAL_TARGET.deploymentType,
    nonce: '1'.repeat(32),
    issued_at: new Date(now).toISOString(),
    expiry: new Date(now + 15 * 60 * 1000).toISOString(),
    approver: APPROVER,
    kms_key_arn: KEY_ARN,
    ...overrides,
  };
}

function signedApproval(overrides = {}) {
  const approval = unsignedApproval(overrides);
  return {
    ...approval,
    kms_signature: sign('sha256', Buffer.from(canonicalCreateApprovalPayload(approval)), privateKey).toString('base64'),
  };
}

function requireApproval(approval, overrides = {}) {
  return requireIndependentCreateApproval({
    approval,
    commit: COMMIT,
    actor: 'github-actor',
    env: approvalEnv(),
    now: Date.parse('2026-10-09T12:01:00.000Z'),
    consumeOnce: createPersistentMemoryLedger(),
    ...overrides,
  });
}

test('independently signed create approval bound to exact target verifies once', () => {
  assert.equal(requireApproval(signedApproval()), true);
});

test('missing, caller-supplied, GitHub-environment, HMAC, and self-approvals fail closed', () => {
  assert.throws(() => requireApproval(), /independent_approval_unverified/);
  assert.throws(() => requireApproval(null), /independent_approval_unverified/);
  assert.throws(() => requireApproval({
    source: 'approved_commit',
    commit: COMMIT,
    approved_commit: COMMIT,
  }), /independent_approval_unverified/);
  assert.throws(() => requireApproval({
    source: 'github_environment',
    commit: COMMIT,
    kms_signature: 'not-independent',
  }), /independent_approval_unverified/);
  assert.throws(() => requireApproval({
    ...unsignedApproval(),
    mac: 'a'.repeat(64),
  }), /independent_approval_unverified/);
  assert.throws(() => requireApproval(signedApproval({
    approver_github: 'github-actor',
  })), /independent_approval_unverified/);
  assert.throws(() => requireApproval(signedApproval({
    approver: CREATE_APPROVAL_TARGET.deployRoleArn,
  })), /independent_approval_unverified/);
  assert.throws(() => requireApproval(signedApproval({
    approver: CREATE_APPROVAL_TARGET.executionRoleArn,
  })), /independent_approval_unverified/);
});

test('wrong SHA, workstream, target, account, region, and production bindings fail closed', () => {
  for (const override of [
    { commit: 'b'.repeat(40) },
    { workstream_id: 'another-workstream' },
    { target_environment: 'production' },
    { target_component: 'checksops-staging-api' },
    { stack_name: 'checksops-staging-api' },
    { function_name: 'checksops-production-prep-api' },
    { account: '123456789012' },
    { region: 'us-west-2' },
    { deployment_type: 'cloudformation' },
    { kind: 'deployment-guard-receipt' },
  ]) {
    assert.throws(() => requireApproval(signedApproval(override)), /independent_approval_unverified/);
  }
});

test('expired, over-TTL, reused nonce, and tampered signatures fail closed', () => {
  const now = Date.parse('2026-10-09T12:01:00.000Z');
  let consumeCalls = 0;
  const consumeOnce = (input) => {
    consumeCalls += 1;
    return createPersistentMemoryLedger()(input);
  };
  assert.throws(() => requireApproval(signedApproval({
    issued_at: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
    expiry: new Date(now - 60 * 1000).toISOString(),
  }), { consumeOnce }), /independent_approval_unverified/);
  assert.throws(() => requireApproval(signedApproval({
    issued_at: new Date(now).toISOString(),
    expiry: new Date(now + 2 * 60 * 60 * 1000).toISOString(),
  }), { consumeOnce }), /independent_approval_unverified/);
  assert.equal(consumeCalls, 0);

  const ledger = createPersistentMemoryLedger();
  const once = signedApproval({ nonce: 'ab'.repeat(16) });
  assert.equal(requireApproval(once, { consumeOnce: ledger }), true);
  assert.throws(() => requireApproval(once, { consumeOnce: ledger }), /independent_approval_reused/);

  const valid = signedApproval();
  assert.throws(() => requireApproval({
    ...valid,
    commit: COMMIT,
    kms_signature: valid.kms_signature,
    workstream_id: 'tampered',
  }), /independent_approval_unverified/);
  const other = generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey
    .export({ type: 'spki', format: 'der' }).toString('base64');
  assert.throws(() => requireApproval(valid, {
    env: approvalEnv({ CHECKSOPS_STAGING_DB_DIAGNOSTIC_APPROVAL_PUBLIC_KEY_DER_B64: other }),
  }), /independent_approval_unverified/);
});

test('missing owner KMS authority and reused guard-receipt key fail closed as the documented blocker', () => {
  assert.equal(OWNER_EVIDENCE.independent_approval_kms_key, 'unknown');
  assert.equal(OWNER_EVIDENCE.independent_approval_kms_alias, 'none_found_does_not_prove_key_absence_2026-10-09');
  assert.equal(OWNER_EVIDENCE.independent_approval_consume_ledger, 'unknown');
  assert.equal(OWNER_EVIDENCE.independent_approval_consume_ledger_delete_denied, 'iam_omits_delete_no_bucket_deny_2026-10-09');
  assert.equal(OWNER_EVIDENCE.independent_approval_consume_if_none_match, 'unknown_no_bucket_policy_2026-10-09');
  assert.equal(OWNER_EVIDENCE.cloudformation_execution_role_trust, 'reported_cfn_service_trust_2026-10-09');
  assert.equal(OWNER_EVIDENCE.artifact_bucket_encryption, 'aes256_2026-10-09');
  assert.equal(OWNER_EVIDENCE.artifact_bucket_policy, 'none_2026-10-09');
  assert.equal(OWNER_EVIDENCE.artifact_bucket_versioning, 'unset_2026-10-09');
  assert.equal(OWNER_EVIDENCE.staging_environment_required_reviewers, 'unverified');
  assert.equal(INDEPENDENT_APPROVAL_BLOCKER, 'owner_controlled_aws_kms_approval_authority_unverified');
  assert.throws(() => requireApproval(signedApproval(), {
    env: approvalEnv({
      CHECKSOPS_STAGING_DB_DIAGNOSTIC_APPROVAL_KMS_KEY_ARN: '',
      CHECKSOPS_STAGING_DB_DIAGNOSTIC_APPROVAL_PUBLIC_KEY_DER_B64: '',
    }),
  }), /independent_approval_unverified/);
  assert.throws(() => requireApproval(signedApproval(), {
    env: approvalEnv({ CHECKSOPS_DEPLOYMENT_GUARD_KMS_KEY_ARN: KEY_ARN }),
  }), /independent_approval_unverified/);
});

test('runner-local files are not a consume ledger and missing persistent consume fails closed', () => {
  const approval = signedApproval({ nonce: '11'.repeat(16) });
  assert.throws(() => requireApproval(approval, { consumeOnce: undefined }), /independent_approval_unverified/);
  assert.throws(() => requireApproval(approval, {
    consumeOnce: () => ({ ok: true, persistent: false, ifNoneMatch: '*' }),
  }), /independent_approval_unverified/);
  assert.throws(() => requireApproval(approval, {
    consumeOnce: () => ({ ok: true, persistent: true, ifNoneMatch: undefined }),
  }), /independent_approval_unverified/);
});

test('fresh runner replay and concurrent consume of the same nonce fail closed', () => {
  const store = new Map();
  const consumeOnce = createPersistentMemoryLedger(store);
  const approval = signedApproval({ nonce: '22'.repeat(16) });
  assert.equal(requireApproval(approval, { consumeOnce }), true);
  assert.throws(
    () => requireApproval(approval, { consumeOnce: createPersistentMemoryLedger(store) }),
    /independent_approval_reused/,
  );

  const race = new Map();
  const shared = createPersistentMemoryLedger(race);
  const concurrent = signedApproval({ nonce: '33'.repeat(16) });
  const outcomes = [0, 1].map(() => {
    try {
      requireApproval(concurrent, { consumeOnce: shared });
      return 'ok';
    } catch (error) {
      return error.message;
    }
  });
  assert.deepEqual(outcomes.sort(), ['independent_approval_reused', 'ok']);
});

test('S3 consume ledger is atomic If-None-Match create and maps 412 to reused', () => {
  const nonce = '44'.repeat(16);
  const key = consumedCreateApprovalObjectKey(nonce);
  assert.equal(key, `${CREATE_APPROVAL_LEDGER.prefix}/${nonce}.json`);
  const calls = [];
  const consumeOnce = createS3CreateApprovalLedger({
    execFile: (cmd, args) => {
      calls.push({ cmd, args: [...args], body: fs.readFileSync(args[args.indexOf('--body') + 1], 'utf8') });
      return '{}';
    },
  });
  const first = consumeOnce({ nonce, payload: { nonce } });
  assert.equal(first.ok, true);
  assert.equal(first.persistent, true);
  assert.equal(first.ifNoneMatch, '*');
  assert.equal(calls[0].cmd, 'aws');
  assert.ok(calls[0].args.includes('put-object'));
  assert.ok(calls[0].args.includes('--if-none-match'));
  assert.ok(calls[0].args.includes('*'));
  assert.ok(calls[0].args.includes(CREATE_APPROVAL_LEDGER.bucket));
  assert.ok(calls[0].args.includes(key));
  assert.doesNotMatch(calls[0].args.join(' '), /delete-object|update-stack|checksops-staging-api/);

  const reused = createS3CreateApprovalLedger({
    execFile: () => {
      const error = new Error('failed');
      error.stderr = 'An error occurred (PreconditionFailed) when calling the PutObject operation';
      throw error;
    },
  })({ nonce, payload: { nonce } });
  assert.equal(reused.reused, true);

  assert.throws(() => createS3CreateApprovalLedger({
    bucket: 'another-bucket',
  }), /independent_approval_unverified/);
});

test('PutObject --body is an existing file and the command cannot delete or overwrite', () => {
  const nonce = '66'.repeat(16);
  const payload = { nonce, commit: COMMIT, workstream_id: CREATE_APPROVAL_TARGET.workstreamId };
  let observed;
  const consumeOnce = createS3CreateApprovalLedger({
    execFile: (cmd, args) => {
      const body = args[args.indexOf('--body') + 1];
      observed = {
        cmd,
        args: [...args],
        body,
        exists: fs.existsSync(body),
        isFile: fs.statSync(body).isFile(),
        contents: fs.readFileSync(body, 'utf8'),
        ifNoneMatch: args[args.indexOf('--if-none-match') + 1],
      };
      requireCreateOnlyLedgerPutObjectArgs(args);
      return '{}';
    },
  });
  assert.equal(consumeOnce({ nonce, payload }).ok, true);
  assert.equal(observed.cmd, 'aws');
  assert.equal(observed.args[0], 's3api');
  assert.equal(observed.args[1], 'put-object');
  assert.equal(observed.exists, true);
  assert.equal(observed.isFile, true);
  assert.equal(JSON.parse(observed.contents).nonce, nonce);
  assert.doesNotMatch(observed.body, /^\{/);
  assert.equal(observed.ifNoneMatch, '*');
  assert.equal(observed.args.includes('delete-object'), false);
  assert.equal(observed.args.includes('copy-object'), false);
  assert.equal(observed.args.includes('--copy-source'), false);
  assert.equal(fs.existsSync(observed.body), false);

  const inlineJson = [
    's3api', 'put-object',
    '--bucket', CREATE_APPROVAL_LEDGER.bucket,
    '--key', consumedCreateApprovalObjectKey(nonce),
    '--body', JSON.stringify(payload),
    '--if-none-match', '*',
  ];
  assert.throws(() => requireCreateOnlyLedgerPutObjectArgs(inlineJson), /independent_approval_unverified/);
  assert.throws(() => requireCreateOnlyLedgerPutObjectArgs([
    's3api', 'put-object',
    '--body', observed.body,
    '--if-none-match', '*',
  ]), /independent_approval_unverified/);
  assert.throws(() => requireCreateOnlyLedgerPutObjectArgs([
    's3api', 'delete-object',
    '--bucket', CREATE_APPROVAL_LEDGER.bucket,
    '--key', consumedCreateApprovalObjectKey(nonce),
  ]), /independent_approval_unverified/);
  assert.throws(() => requireCreateOnlyLedgerPutObjectArgs([
    's3api', 'put-object',
    '--body', '/tmp',
    '--if-none-match', undefined,
  ]), /independent_approval_unverified/);
});

test('failed create-only deploy cannot retry the same approval on a fresh runner', () => {
  const consumeOnce = createPersistentMemoryLedger();
  const approval = signedApproval({ nonce: '55'.repeat(16) });
  assert.equal(requireApproval(approval, { consumeOnce }), true);

  const retryCalls = [];
  const retry = deployMain({
    GITHUB_REF: 'refs/heads/main',
    GITHUB_SHA: COMMIT,
    APPROVED_COMMIT: COMMIT,
    CHECKSOPS_DEPLOY_ENVIRONMENT: 'staging',
    AWS_REGION: 'us-east-1',
    CHECKSOPS_STAGING_DB_DIAGNOSTIC_ROLE_ARN: CREATE_APPROVAL_TARGET.deployRoleArn,
    GITHUB_RUN_ID: '101',
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_ACTOR: 'github-actor',
    ...approvalEnv(),
  }, {
    checkedOutSha: COMMIT,
    root: tmpRoot(),
    approval,
    consumeOnce,
    now: Date.parse('2026-10-09T12:02:00.000Z'),
    run: (...args) => {
      retryCalls.push(args);
      throw new Error('aws_must_not_run');
    },
    runQuiet: (...args) => {
      retryCalls.push(args);
      throw new Error('aws_must_not_run');
    },
  });
  assert.equal(retry, 2);
  assert.equal(retryCalls.length, 0);
});

test('create-only deploy refuses before AWS mutation without independent approval', () => {
  const calls = [];
  const code = deployMain({
    GITHUB_REF: 'refs/heads/main',
    GITHUB_SHA: COMMIT,
    APPROVED_COMMIT: COMMIT,
    CHECKSOPS_DEPLOY_ENVIRONMENT: 'staging',
    AWS_REGION: 'us-east-1',
    CHECKSOPS_STAGING_DB_DIAGNOSTIC_ROLE_ARN: CREATE_APPROVAL_TARGET.deployRoleArn,
    GITHUB_RUN_ID: '100',
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_ACTOR: 'github-actor',
  }, {
    checkedOutSha: COMMIT,
    root: tmpRoot(),
    run: (...args) => {
      calls.push(args);
      throw new Error('aws_must_not_run');
    },
    runQuiet: (...args) => {
      calls.push(args);
      throw new Error('aws_must_not_run');
    },
  });
  assert.equal(code, 2);
  assert.equal(calls.length, 0);
});

test('create-only workflow stays disabled and does not treat approved_commit as independent approval', () => {
  const workflow = fs.readFileSync(new URL('../../.github/workflows/staging-db-readonly-diagnostic-deploy.yml', import.meta.url), 'utf8');
  const runner = fs.readFileSync(new URL('../../scripts/staging-db-readonly-diagnostic-deploy.mjs', import.meta.url), 'utf8');
  const docs = fs.readFileSync(new URL('../../aws/staging-db-readonly-diagnostic/DEPLOYMENT.md', import.meta.url), 'utf8');
  assert.match(workflow, /if: \$\{\{ false \}\}/);
  assert.doesNotMatch(workflow, /id-token:\s*write/);
  assert.match(workflow, /not independent approval/);
  assert.match(runner, /requireIndependentCreateApproval/);
  assert.match(runner, /createS3CreateApprovalLedger/);
  assert.match(docs, /If-None-Match/);
  assert.match(docs, /fresh runner/);
  assert.match(workflow, /DenyDeleteConsumedApprovals/);
  assert.match(workflow, /s3:DeleteObject/);
  assert.match(workflow, /s3:if-none-match/);
  assert.match(workflow, /s3:PutObject/);
  assert.doesNotMatch(runner, /'update-stack'/);
  assert.doesNotMatch(runner, /'delete-stack'/);
  assert.doesNotMatch(runner, /cloudformation', 'deploy/);
  assert.match(docs, /INDEPENDENT APPROVAL BLOCKER/);
  assert.match(docs, /workflow_dispatch[`\s]+403/);
  assert.match(docs, /Cognito admin/);
  assert.match(docs, /Do not claim an independent approval exists/);
  assert.equal(INDEPENDENT_APPROVAL_UNVERIFIED, 'independent_approval_unverified');
  assert.equal(INDEPENDENT_APPROVAL_REUSED, 'independent_approval_reused');
});

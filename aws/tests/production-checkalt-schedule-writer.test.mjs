import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PREP_LAMBDA_ARN,
  ROLE_ARN,
  SCHEDULE_DEPLOYMENT_TYPE,
  SCHEDULE_NAME,
  SCHEDULE_TARGET_COMPONENT,
  STACK_NAME,
  TEMPLATE_PATH,
  TEMPLATE_SHA256,
  assertExpectedAfter,
  classify,
  createStackArgs,
  main as writer,
  normalizeSnapshot,
  ownedComponentsFor,
  readTemplate,
  snapshotFingerprint,
  updateStackArgs,
  validateActor,
  waitForStack,
} from '../../scripts/deployment-guard/production-checkalt-schedule.mjs';
import {
  CREATE_PHRASE,
  PAUSE_PHRASE,
  RESUME_PHRASE,
  approvalPhraseFor,
  run as preflight,
  validateChangeInputs,
  workflowIdentity,
} from '../../scripts/deployment-guard/github-production-checkalt-schedule.mjs';
import { CODES } from '../../scripts/deployment-guard/lib/errors.mjs';
import { DEPLOYMENT_TYPES } from '../../scripts/deployment-guard/lib/identity.mjs';
import { acquireLease } from '../../scripts/deployment-guard/lib/lease.mjs';
import { issueReceipt } from '../../scripts/deployment-guard/lib/receipt.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHA = 'c'.repeat(40);
const STAGING_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/123';
const ACTOR = '3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const WORKFLOW = fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/guarded-production-checkalt-schedule.yml'), 'utf8');
const TEMPLATE = readTemplate(REPO_ROOT);

const LAMBDA = { FunctionName: 'checksops-production-prep-api', CodeSha256: 'sxodWyRpUr0LbETU0YhBayaqYe1VsfNBQi1OoMZpd4U=', RevisionId: '58733b08-ef0a-4ab9-a47a-30fc15ebeafb' };

function absent(lambda = LAMBDA) {
  return normalizeSnapshot({ stack: null, stackTemplateBody: null, role: null, rolePolicy: null, schedule: null, lambda });
}

function raw({ actor = ACTOR, state = 'ENABLED', status = 'CREATE_COMPLETE', templateBody = TEMPLATE.body, lambda = LAMBDA } = {}) {
  return {
    stack: {
      StackName: STACK_NAME,
      StackId: `arn:aws:cloudformation:us-east-1:806168576068:stack/${STACK_NAME}/0b1c2d3e-0000-0000-0000-000000000000`,
      StackStatus: status,
      Parameters: [
        { ParameterKey: 'ScheduleState', ParameterValue: state },
        { ParameterKey: 'ActorApplicationUserId', ParameterValue: actor },
        { ParameterKey: 'ScheduleExpression', ParameterValue: 'rate(30 minutes)' },
      ],
    },
    stackTemplateBody: templateBody,
    role: { Role: {
      RoleName: 'checksops-production-checkalt-status-schedule',
      Arn: ROLE_ARN,
      AssumeRolePolicyDocument: { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: 'scheduler.amazonaws.com' }, Action: 'sts:AssumeRole', Condition: { StringEquals: { 'aws:SourceAccount': '806168576068' } } }] },
    } },
    rolePolicy: { PolicyDocument: { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: 'lambda:InvokeFunction', Resource: PREP_LAMBDA_ARN }] } },
    schedule: {
      Name: SCHEDULE_NAME,
      GroupName: 'default',
      State: state,
      ScheduleExpression: 'rate(30 minutes)',
      ScheduleExpressionTimezone: 'UTC',
      FlexibleTimeWindow: { Mode: 'OFF' },
      Target: {
        Arn: PREP_LAMBDA_ARN,
        RoleArn: ROLE_ARN,
        RetryPolicy: { MaximumEventAgeInSeconds: 300, MaximumRetryAttempts: 0 },
        Input: `{"checksops_scheduler":"eventbridge-scheduler","job":"checkalt-poll-deposits","rawPath":"/scheduled/checkalt-poll-deposits","requestContext":{"http":{"method":"POST"}},"actor_application_user_id":"${actor}"}\n`,
      },
    },
    lambda,
  };
}

const live = (opts) => normalizeSnapshot(raw(opts));

// --- template pin -------------------------------------------------------------------------------

test('the template on this checkout is the pinned bytes (derived from the file, LF checkout)', () => {
  const bytes = fs.readFileSync(path.join(REPO_ROOT, TEMPLATE_PATH));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), TEMPLATE_SHA256);
  assert.equal(TEMPLATE.sha256, TEMPLATE_SHA256);
  assert.equal(bytes.includes(0x0d), false, 'CRLF checkout changes the pinned hash');
});

test('the actor check is the template AllowedPattern, verbatim', () => {
  const pattern = TEMPLATE.body.match(/AllowedPattern: '([^']+)'/)[1];
  assert.equal(pattern, '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$');
  assert.equal(validateActor(ACTOR), true);
  for (const bad of ['', 'owner', ACTOR.toUpperCase(), `${ACTOR} `, '3f1c2d4e-5a6b-6c7d-8e9f-0a1b2c3d4e5f', '3f1c2d4e-5a6b-4c7d-7e9f-0a1b2c3d4e5f']) {
    assert.equal(validateActor(bad), false, bad);
  }
  assert.ok(WORKFLOW.includes(pattern.replace(/^\^|\$$/g, '')), 'workflow input check uses the same pattern');
});

test('cloudformation is a registered deployment type, so the receipts can validate', () => {
  assert.ok(DEPLOYMENT_TYPES.includes(SCHEDULE_DEPLOYMENT_TYPE));
});

// --- classification -----------------------------------------------------------------------------

test('classify: ABSENT before create, LIVE for the pinned stack, BLOCKED on partial or drifted state', () => {
  assert.equal(classify(absent()).state, 'ABSENT');
  assert.equal(classify(live()).state, 'LIVE');
  assert.equal(classify(live({ state: 'DISABLED' })).state, 'LIVE');
  assert.equal(classify(live({ status: 'UPDATE_COMPLETE' })).state, 'LIVE');
  assert.equal(classify(absent({ ...LAMBDA, RevisionId: null })).state, 'BLOCKED');
  for (const status of ['CREATE_IN_PROGRESS', 'CREATE_FAILED', 'ROLLBACK_COMPLETE', 'UPDATE_ROLLBACK_COMPLETE', 'UPDATE_IN_PROGRESS']) {
    assert.equal(classify(live({ status })).state, 'BLOCKED', status);
  }
  assert.equal(classify(live({ templateBody: `${TEMPLATE.body}# edited\n` })).problems.includes('stack_template_drift'), true);
  const drifts = [
    s => { s.stack = null; },
    s => { s.role = null; },
    s => { s.schedule = null; },
    s => { s.schedule.TargetArn = 'arn:aws:lambda:us-east-1:806168576068:function:other'; },
    s => { s.schedule.RoleArn = 'arn:aws:iam::806168576068:role/other'; },
    s => { s.schedule.Input.actor_application_user_id = '00000000-0000-4000-8000-000000000000'; },
    s => { s.schedule.Input.job = 'checkalt-approve'; },
    s => { s.schedule.State = 'DISABLED'; },
    s => { s.schedule.RetryPolicy.MaximumRetryAttempts = 3; },
    s => { s.role.InlinePolicy.Statement[0].Resource = '*'; },
    s => { s.role.InlinePolicy.Statement.push({ Effect: 'Allow', Action: 's3:*', Resource: '*' }); },
    s => { s.role.AssumeRolePolicyDocument.Statement[0].Principal = { AWS: '*' }; },
    s => { s.stack.Parameters.Extra = 'x'; },
  ];
  for (const mutate of drifts) {
    const s = live();
    mutate(s);
    assert.equal(classify(s).state, 'BLOCKED', String(mutate));
  }
  // Partial resources without the stack are never ABSENT.
  const roleOnly = absent();
  roleOnly.role = live().role;
  assert.equal(classify(roleOnly).state, 'BLOCKED');
});

// --- exact AWS arguments ------------------------------------------------------------------------

test('create-stack arguments: pinned template body, CAPABILITY_NAMED_IAM, only the actor parameter, no rollback-delete', () => {
  const args = createStackArgs({ templateBody: TEMPLATE.body, actor: ACTOR });
  assert.deepEqual(args, [
    'cloudformation', 'create-stack',
    '--stack-name', 'checksops-production-checkalt-status-schedule',
    '--template-body', TEMPLATE.body,
    '--capabilities', 'CAPABILITY_NAMED_IAM',
    '--on-failure', 'DO_NOTHING',
    '--parameters', JSON.stringify([{ ParameterKey: 'ActorApplicationUserId', ParameterValue: ACTOR }]),
  ]);
  assert.equal(createHash('sha256').update(args[5]).digest('hex'), TEMPLATE_SHA256);
});

test('update-stack arguments: previous template, only ScheduleState changes', () => {
  assert.deepEqual(updateStackArgs({ state: 'DISABLED' }), [
    'cloudformation', 'update-stack',
    '--stack-name', 'checksops-production-checkalt-status-schedule',
    '--use-previous-template',
    '--capabilities', 'CAPABILITY_NAMED_IAM',
    '--parameters', JSON.stringify([
      { ParameterKey: 'ActorApplicationUserId', UsePreviousValue: true },
      { ParameterKey: 'ScheduleExpression', UsePreviousValue: true },
      { ParameterKey: 'ScheduleState', ParameterValue: 'DISABLED' },
    ]),
  ]);
});

test('waitForStack polls until the stack settles and times out instead of retrying', () => {
  const statuses = ['CREATE_IN_PROGRESS', 'CREATE_IN_PROGRESS', 'CREATE_COMPLETE'];
  let sleeps = 0;
  assert.equal(waitForStack({}, { describe: () => statuses.shift(), sleep: () => { sleeps += 1; } }), 'CREATE_COMPLETE');
  assert.equal(sleeps, 2);
  assert.equal(waitForStack({}, { describe: () => 'ROLLBACK_COMPLETE', sleep: () => {} }), 'ROLLBACK_COMPLETE');
  let t = 0;
  assert.throws(() => waitForStack({}, { describe: () => 'CREATE_IN_PROGRESS', sleep: () => {}, now: () => (t += 60_000), timeoutMs: 120_000 }), /stack_wait_timeout/);
});

// --- verify logic -------------------------------------------------------------------------------

test('verify: create must produce exactly the pinned stack for this actor, enabled', () => {
  assert.doesNotThrow(() => assertExpectedAfter(absent(), live(), { mode: 'create', actor: ACTOR }));
  assert.throws(() => assertExpectedAfter(absent(), live({ actor: '00000000-0000-4000-8000-000000000000' }), { mode: 'create', actor: ACTOR }), /post_write_parameters/);
  assert.throws(() => assertExpectedAfter(absent(), live({ state: 'DISABLED' }), { mode: 'create', actor: ACTOR }), /post_write_parameters/);
  assert.throws(() => assertExpectedAfter(absent(), live({ lambda: { ...LAMBDA, RevisionId: 'moved' } }), { mode: 'create', actor: ACTOR }), /post_write_lambda_moved/);
  assert.throws(() => assertExpectedAfter(absent(), live({ status: 'ROLLBACK_COMPLETE' }), { mode: 'create', actor: ACTOR }), /post_write_not_live/);
  assert.throws(() => assertExpectedAfter(live(), live(), { mode: 'create', actor: ACTOR }), /post_write_create_precondition/);
});

test('verify: set-state changes only the state and the stack status', () => {
  const before = live();
  assert.doesNotThrow(() => assertExpectedAfter(before, live({ state: 'DISABLED', status: 'UPDATE_COMPLETE' }), { mode: 'set-state', state: 'DISABLED' }));
  const moved = live({ state: 'DISABLED', status: 'UPDATE_COMPLETE' });
  moved.schedule.RetryPolicy.MaximumEventAgeInSeconds = 600;
  assert.throws(() => assertExpectedAfter(before, moved, { mode: 'set-state', state: 'DISABLED' }), /post_write_not_live|post_write_non_state_drift/);
  const actorMoved = live({ state: 'DISABLED', status: 'UPDATE_COMPLETE', actor: '00000000-0000-4000-8000-000000000000' });
  assert.throws(() => assertExpectedAfter(before, actorMoved, { mode: 'set-state', state: 'DISABLED' }), /post_write_non_state_drift/);
  assert.throws(() => assertExpectedAfter(before, live({ state: 'ENABLED', status: 'UPDATE_COMPLETE' }), { mode: 'set-state', state: 'DISABLED' }), /post_write_non_state_drift/);
});

// --- preflight refusals -------------------------------------------------------------------------

test('approval phrases are exact per mode and state', () => {
  assert.equal(approvalPhraseFor('create'), 'CREATE CHECKALT STATUS SCHEDULE IN PRODUCTION');
  assert.equal(approvalPhraseFor('set-state', 'DISABLED'), 'PAUSE CHECKALT STATUS SCHEDULE IN PRODUCTION');
  assert.equal(approvalPhraseFor('set-state', 'ENABLED'), 'RESUME CHECKALT STATUS SCHEDULE IN PRODUCTION');
  for (const phrase of [CREATE_PHRASE, PAUSE_PHRASE, RESUME_PHRASE]) assert.ok(WORKFLOW.includes(phrase), phrase);
  const fp = snapshotFingerprint(absent());
  const base = { mode: 'create', approval: CREATE_PHRASE, stagingAcceptance: STAGING_REF, expectedFingerprint: fp, liveFingerprint: fp, actor: ACTOR };
  assert.doesNotThrow(() => validateChangeInputs(base));
  for (const approval of ['create checkalt status schedule in production', `${CREATE_PHRASE} `, PAUSE_PHRASE, '']) {
    assert.throws(() => validateChangeInputs({ ...base, approval }), (e) => e.code === CODES.PRODUCTION_APPROVAL_REQUIRED, approval);
  }
  assert.throws(() => validateChangeInputs({ ...base, mode: 'set-state', scheduleState: 'DISABLED', approval: RESUME_PHRASE }), (e) => e.code === CODES.PRODUCTION_APPROVAL_REQUIRED);
  assert.throws(() => validateChangeInputs({ ...base, mode: 'set-state', scheduleState: 'PAUSED', approval: PAUSE_PHRASE }), (e) => e.code === CODES.INVALID_MANIFEST);
  assert.throws(() => validateChangeInputs({ ...base, stagingAcceptance: 'staging ok' }), (e) => e.code === CODES.PRODUCTION_APPROVAL_REQUIRED);
  assert.throws(() => validateChangeInputs({ ...base, expectedFingerprint: '' }), (e) => e.code === CODES.INVALID_MANIFEST);
  assert.throws(() => validateChangeInputs({ ...base, expectedFingerprint: 'a'.repeat(64) }), (e) => e.code === CODES.DEPLOYMENT_COLLISION);
  assert.throws(() => validateChangeInputs({ ...base, actor: 'not-a-uuid' }), (e) => e.code === CODES.INVALID_MANIFEST);
});

test('preflight refuses anything but main and an incomplete identity', () => {
  assert.throws(() => workflowIdentity({ GITHUB_SHA: SHA, GITHUB_REF_NAME: 'feature', GITHUB_ACTOR: 'x', GITHUB_RUN_ID: '1' }), (e) => e.code === CODES.UNRELATED_MUTATION);
  assert.throws(() => workflowIdentity({ GITHUB_SHA: 'short', GITHUB_REF_NAME: 'main', GITHUB_ACTOR: 'x', GITHUB_RUN_ID: '1' }), (e) => e.code === CODES.ANONYMOUS_DEPLOYMENT);
  assert.equal(workflowIdentity({ GITHUB_SHA: SHA, GITHUB_REF_NAME: 'main', GITHUB_ACTOR: 'x', GITHUB_RUN_ID: '7' }).workstreamId, 'github-production-checkalt-schedule-7');
});

function tmpRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'checksops-checkalt-schedule-'));
  fs.mkdirSync(path.join(root, 'ops/deployment-guard'), { recursive: true });
  fs.copyFileSync(path.join(REPO_ROOT, 'ops/deployment-guard/accepted-contracts.json'), path.join(root, 'ops/deployment-guard/accepted-contracts.json'));
  return root;
}

// A fake AWS: never calls AWS. runAws records the exact arguments and applies them to the state.
function fakeAws(initial, { onRun = null, settle = null } = {}) {
  const state = { snapshot: initial, calls: [] };
  return {
    state,
    readSnapshot: () => structuredClone(state.snapshot),
    runAws: (args) => {
      state.calls.push(args);
      if (onRun) onRun(state, args);
      else if (args[1] === 'create-stack') state.snapshot = live({ actor: JSON.parse(args.at(-1))[0].ParameterValue });
      else if (args[1] === 'update-stack') {
        const target = JSON.parse(args.at(-1))[2].ParameterValue;
        const next = structuredClone(state.snapshot);
        next.stack.StackStatus = 'UPDATE_COMPLETE';
        next.stack.Parameters.ScheduleState = target;
        next.schedule.State = target;
        state.snapshot = next;
      }
      return {};
    },
    waitForStack: () => settle || state.snapshot.stack?.StackStatus,
    failureEvents: () => [],
  };
}

const ENV = { GITHUB_SHA: SHA, GITHUB_REF_NAME: 'main', GITHUB_ACTOR: 'owner', GITHUB_RUN_ID: '4242' };

async function preflightChange(root, aws, extra = {}, deps = {}) {
  const fp = snapshotFingerprint(aws.readSnapshot());
  const setState = extra.CHECKSOPS_SCHEDULE_MODE === 'set-state';
  return preflight({
    ...ENV,
    CHECKSOPS_SCHEDULE_MODE: 'create',
    CHECKSOPS_EXPECTED_SNAPSHOT_SHA256: fp,
    CHECKSOPS_STAGING_ACCEPTANCE_REFERENCE: STAGING_REF,
    CHECKSOPS_SCHEDULE_ACTOR: setState ? '' : ACTOR,
    CHECKSOPS_SCHEDULE_APPROVAL: CREATE_PHRASE,
    ...extra,
  }, { root, readSnapshot: aws.readSnapshot, signer: (unsigned) => unsigned, ...deps });
}

function writerEnv(result) {
  return {
    CHECKSOPS_PRODUCTION_CHECKALT_SCHEDULE_EXECUTE: '1',
    CHECKSOPS_DEPLOYMENT_GUARD_APPLY: '1',
    CHECKSOPS_DEPLOYMENT_GUARD_RECEIPT: result.authorization.receiptFile,
    CHECKSOPS_SCHEDULE_INPUT: result.authorization.scheduleInput,
    CHECKSOPS_WORKSTREAM_ID: result.identity.workstreamId,
    CHECKSOPS_COMMIT: SHA,
  };
}

const writerDeps = (aws, root) => ({ readSnapshot: aws.readSnapshot, runAws: aws.runAws, waitForStack: aws.waitForStack, failureEvents: aws.failureEvents, guardRoot: root });

test('inspect never writes and reports the live state', async () => {
  const root = tmpRoot();
  const aws = fakeAws(absent());
  const result = await preflight({ ...ENV, CHECKSOPS_SCHEDULE_MODE: 'inspect' }, { root, readSnapshot: aws.readSnapshot });
  assert.equal(result.state, 'ABSENT');
  assert.equal(result.mutation, false);
  assert.equal(result.stack_status, 'ABSENT');
  assert.equal(result.template_sha256, TEMPLATE_SHA256);
  assert.equal(result.snapshot_sha256, snapshotFingerprint(absent()));
  assert.equal(aws.state.calls.length, 0);
  assert.equal(fs.existsSync(path.join(root, '.deployment-guard')), false, 'inspect takes no lease and issues no receipt');
});

test('preflight refuses template hash drift before reading AWS', async () => {
  const root = tmpRoot();
  let reads = 0;
  await assert.rejects(preflight({ ...ENV, CHECKSOPS_SCHEDULE_MODE: 'inspect' }, {
    root,
    readSnapshot: () => { reads += 1; return absent(); },
    readTemplate: () => ({ body: `${TEMPLATE.body} `, sha256: 'f'.repeat(64) }),
  }), (e) => e.code === CODES.DEPLOYMENT_COLLISION && /pinned sha256/.test(e.message));
  assert.equal(reads, 0);
});

test('preflight create refuses a present stack, a stale inspect hash, a wrong phrase, a bad UUID and non-main', async () => {
  const root = tmpRoot();
  await assert.rejects(preflightChange(root, fakeAws(live())), (e) => e.code === CODES.DEPLOYMENT_COLLISION && /absent/.test(e.message));
  const roleOnly = absent();
  roleOnly.role = live().role;
  await assert.rejects(preflightChange(root, fakeAws(roleOnly)), (e) => e.code === CODES.DEPLOYMENT_COLLISION);
  const aws = fakeAws(absent());
  await assert.rejects(preflightChange(root, aws, { CHECKSOPS_EXPECTED_SNAPSHOT_SHA256: 'b'.repeat(64) }), (e) => e.code === CODES.DEPLOYMENT_COLLISION);
  await assert.rejects(preflightChange(root, aws, { CHECKSOPS_SCHEDULE_APPROVAL: 'yes' }), (e) => e.code === CODES.PRODUCTION_APPROVAL_REQUIRED);
  await assert.rejects(preflightChange(root, aws, { CHECKSOPS_SCHEDULE_ACTOR: ACTOR.toUpperCase() }), (e) => e.code === CODES.INVALID_MANIFEST);
  await assert.rejects(preflightChange(root, aws, { CHECKSOPS_STAGING_ACCEPTANCE_REFERENCE: '' }), (e) => e.code === CODES.PRODUCTION_APPROVAL_REQUIRED);
  await assert.rejects(preflightChange(root, aws, { GITHUB_REF_NAME: 'claude/branch' }), (e) => e.code === CODES.UNRELATED_MUTATION);
  assert.equal(aws.state.calls.length, 0);
});

test('preflight set-state refuses a missing stack, the current state, and the wrong phrase', async () => {
  const root = tmpRoot();
  await assert.rejects(preflightChange(root, fakeAws(absent()), { CHECKSOPS_SCHEDULE_MODE: 'set-state', CHECKSOPS_SCHEDULE_STATE: 'DISABLED', CHECKSOPS_SCHEDULE_APPROVAL: PAUSE_PHRASE }), (e) => e.code === CODES.DEPLOYMENT_COLLISION);
  await assert.rejects(preflightChange(root, fakeAws(live()), { CHECKSOPS_SCHEDULE_MODE: 'set-state', CHECKSOPS_SCHEDULE_STATE: 'ENABLED', CHECKSOPS_SCHEDULE_APPROVAL: RESUME_PHRASE }), (e) => e.code === CODES.UNRELATED_MUTATION);
  await assert.rejects(preflightChange(root, fakeAws(live()), { CHECKSOPS_SCHEDULE_MODE: 'set-state', CHECKSOPS_SCHEDULE_STATE: 'DISABLED', CHECKSOPS_SCHEDULE_APPROVAL: CREATE_PHRASE }), (e) => e.code === CODES.PRODUCTION_APPROVAL_REQUIRED);
  await assert.rejects(preflightChange(root, fakeAws(live({ status: 'UPDATE_ROLLBACK_COMPLETE' })), { CHECKSOPS_SCHEDULE_MODE: 'set-state', CHECKSOPS_SCHEDULE_STATE: 'DISABLED', CHECKSOPS_SCHEDULE_APPROVAL: PAUSE_PHRASE }), (e) => e.code === CODES.DEPLOYMENT_COLLISION);
});

// --- end to end with a fake AWS -----------------------------------------------------------------

test('create: the receipt binds the snapshot and the actor; the writer sends exactly one create-stack; verify passes; the receipt is single-use', async () => {
  const root = tmpRoot();
  const aws = fakeAws(absent());
  const result = await preflightChange(root, aws);
  const receipt = JSON.parse(fs.readFileSync(result.authorization.receiptFile, 'utf8'));
  assert.equal(receipt.deployment_type, SCHEDULE_DEPLOYMENT_TYPE);
  assert.equal(receipt.target_component, SCHEDULE_TARGET_COMPONENT);
  assert.equal(receipt.target_environment, 'production');
  assert.deepEqual(receipt.owned_components, ownedComponentsFor('create', ACTOR));
  assert.deepEqual(receipt.preflight_live_fingerprint, absent());
  assert.equal(writer(writerEnv(result), writerDeps(aws, root)), 0);
  assert.equal(aws.state.calls.length, 1);
  assert.deepEqual(aws.state.calls[0], createStackArgs({ templateBody: TEMPLATE.body, actor: ACTOR }));
  assert.equal(classify(aws.readSnapshot()).state, 'LIVE');
  const verified = await preflight({ ...ENV, CHECKSOPS_SCHEDULE_MODE: 'verify', CHECKSOPS_SCHEDULE_INPUT: result.authorization.scheduleInput }, { root, readSnapshot: aws.readSnapshot });
  assert.equal(verified.state, 'VERIFIED');
  assert.equal(verified.schedule_state, 'ENABLED');
  assert.equal(verified.schedule_actor, ACTOR);
  // Replay of the same receipt is refused before any write.
  aws.state.snapshot = absent();
  assert.throws(() => writer(writerEnv(result), writerDeps(aws, root)), /receipt_consumption_failed|guard_refused/);
  assert.equal(aws.state.calls.length, 1);
});

test('set-state: pause then resume each send one update-stack and verify', async () => {
  const aws = fakeAws(live());
  for (const [state, phrase] of [['DISABLED', PAUSE_PHRASE], ['ENABLED', RESUME_PHRASE]]) {
    const root = tmpRoot();
    const before = aws.state.calls.length;
    const result = await preflightChange(root, aws, { CHECKSOPS_SCHEDULE_MODE: 'set-state', CHECKSOPS_SCHEDULE_STATE: state, CHECKSOPS_SCHEDULE_APPROVAL: phrase });
    const receipt = JSON.parse(fs.readFileSync(result.authorization.receiptFile, 'utf8'));
    assert.deepEqual(receipt.owned_components, ownedComponentsFor('set-state', state));
    assert.equal(writer(writerEnv(result), writerDeps(aws, root)), 0);
    assert.equal(aws.state.calls.length, before + 1);
    assert.deepEqual(aws.state.calls.at(-1), updateStackArgs({ state }));
    const verified = await preflight({ ...ENV, CHECKSOPS_SCHEDULE_MODE: 'verify', CHECKSOPS_SCHEDULE_INPUT: result.authorization.scheduleInput }, { root, readSnapshot: aws.readSnapshot });
    assert.equal(verified.schedule_state, state);
  }
});

test('the writer refuses when anything moved after the receipt was issued', async () => {
  for (const moved of [absent({ ...LAMBDA, RevisionId: 'rev-moved' }), (() => { const s = absent(); s.role = live().role; return s; })()]) {
    const root = tmpRoot();
    const aws = fakeAws(absent());
    const result = await preflightChange(root, aws);
    aws.state.snapshot = moved;
    assert.throws(() => writer(writerEnv(result), writerDeps(aws, root)), /guard_refused|preflight_state/);
    assert.equal(aws.state.calls.length, 0);
  }
});

test('the writer reports a failed create and never retries or deletes', async () => {
  const root = tmpRoot();
  const aws = fakeAws(absent(), {
    onRun: (state) => { state.snapshot = live({ status: 'ROLLBACK_COMPLETE' }); },
    settle: 'ROLLBACK_COMPLETE',
  });
  const result = await preflightChange(root, aws);
  assert.throws(() => writer(writerEnv(result), writerDeps(aws, root)), /stack_create_failed:ROLLBACK_COMPLETE/);
  assert.equal(aws.state.calls.length, 1);
  assert.equal(aws.state.calls.some((args) => /delete/.test(args[1])), false);
});

test('the writer fails closed when the create left something other than the requested stack', async () => {
  const root = tmpRoot();
  const aws = fakeAws(absent(), { onRun: (state) => { state.snapshot = live({ lambda: { ...LAMBDA, RevisionId: 'moved-during-write' } }); }, settle: 'CREATE_COMPLETE' });
  const result = await preflightChange(root, aws);
  assert.throws(() => writer(writerEnv(result), writerDeps(aws, root)), /post_write_lambda_moved/);
});

test('the writer refuses without a receipt, with another receipt, with caller-supplied stack input, a mismatched actor, no approval, and plan-only', async () => {
  const root = tmpRoot();
  const aws = fakeAws(absent());
  const input = path.join(root, 'input.json');
  const approval = { approved: true, workstream_id: 'ws-other' };
  const staging = { ok: true, reference: STAGING_REF };

  // No receipt at all.
  fs.writeFileSync(input, JSON.stringify({ mode: 'create', actor_application_user_id: ACTOR, workstream_id: 'ws-other', commit: SHA, approval, staging_acceptance: staging }));
  const noReceipt = { CHECKSOPS_PRODUCTION_CHECKALT_SCHEDULE_EXECUTE: '1', CHECKSOPS_DEPLOYMENT_GUARD_APPLY: '1', CHECKSOPS_SCHEDULE_INPUT: input };
  assert.throws(() => writer(noReceipt, writerDeps(aws, root)), /guard_refused/);

  // A receipt whose lease is gone.
  const lease = acquireLease(root, { workstream_id: 'ws-other', component: SCHEDULE_TARGET_COMPONENT, environment: 'production', commit: SHA, operator: 'x' });
  const issued = issueReceipt(root, {
    workstream_id: 'ws-other', branch: 'main', commit: SHA, target_environment: 'production', target_component: SCHEDULE_TARGET_COMPONENT,
    deployment_type: SCHEDULE_DEPLOYMENT_TYPE, owned_components: ownedComponentsFor('create', ACTOR), preflight_live_fingerprint: absent(), lease: lease.details.lease,
  });
  assert.equal(issued.ok, true, issued.message);
  const env = { ...noReceipt, CHECKSOPS_DEPLOYMENT_GUARD_RECEIPT: issued.details.file };
  fs.rmSync(path.join(root, '.deployment-guard', 'leases'), { recursive: true, force: true });
  assert.throws(() => writer(env, writerDeps(aws, root)), /guard_refused/);

  // Another deployment type for the same component.
  const root2 = tmpRoot();
  const lease2 = acquireLease(root2, { workstream_id: 'ws-other', component: SCHEDULE_TARGET_COMPONENT, environment: 'production', commit: SHA, operator: 'x' });
  const other = issueReceipt(root2, {
    workstream_id: 'ws-other', branch: 'main', commit: SHA, target_environment: 'production', target_component: SCHEDULE_TARGET_COMPONENT,
    deployment_type: 'infra-mutate', owned_components: ownedComponentsFor('create', ACTOR), preflight_live_fingerprint: absent(), lease: lease2.details.lease,
  });
  assert.throws(() => writer({ ...noReceipt, CHECKSOPS_DEPLOYMENT_GUARD_RECEIPT: other.details.file }, writerDeps(aws, root2)), /guard_refused|receipt_type_mismatch/);

  // Caller-supplied template or parameters.
  for (const extra of [{ template_body: 'Resources: {}' }, { parameters: [] }, { delete: true }]) {
    fs.writeFileSync(input, JSON.stringify({ mode: 'create', actor_application_user_id: ACTOR, ...extra }));
    assert.throws(() => writer(noReceipt, writerDeps(aws, root)), /caller_supplied_stack_forbidden/);
  }

  // A receipt for one actor cannot create the stack for another.
  const root3 = tmpRoot();
  const result = await preflightChange(root3, aws);
  const tampered = JSON.parse(fs.readFileSync(result.authorization.scheduleInput, 'utf8'));
  tampered.actor_application_user_id = '00000000-0000-4000-8000-000000000000';
  fs.writeFileSync(result.authorization.scheduleInput, JSON.stringify(tampered));
  assert.throws(() => writer(writerEnv(result), writerDeps(aws, root3)), /receipt_component_mismatch/);

  // No approval in the input.
  const root4 = tmpRoot();
  const result4 = await preflightChange(root4, aws);
  const noApproval = JSON.parse(fs.readFileSync(result4.authorization.scheduleInput, 'utf8'));
  delete noApproval.approval;
  fs.writeFileSync(result4.authorization.scheduleInput, JSON.stringify(noApproval));
  assert.throws(() => writer(writerEnv(result4), writerDeps(aws, root4)), /production_gate/);

  // Template drift at write time.
  const root5 = tmpRoot();
  const result5 = await preflightChange(root5, aws);
  assert.throws(() => writer(writerEnv(result5), { ...writerDeps(aws, root5), readTemplate: () => ({ body: 'x', sha256: 'e'.repeat(64) }) }), /template_hash_drift/);

  assert.equal(writer({}, writerDeps(aws, root)), 2);
  assert.equal(aws.state.calls.length, 0);
});

// --- workflow wiring ----------------------------------------------------------------------------

test('the workflow runs only from main in the production environment, with its own concurrency group, and runs these tests', () => {
  assert.match(WORKFLOW, /^\s+environment: production$/m);
  assert.match(WORKFLOW, /group: guarded-production-checkalt-status-schedule\n\s+cancel-in-progress: false/);
  assert.match(WORKFLOW, /test "\$GITHUB_REF" = "refs\/heads\/main"/);
  assert.match(WORKFLOW, /test "\$\(git rev-parse HEAD\)" = "\$GITHUB_SHA"/);
  assert.match(WORKFLOW, /test "\$INPUT_APPROVED_COMMIT" = "\$GITHUB_SHA"/);
  assert.ok(WORKFLOW.includes('node --test aws/tests/production-checkalt-schedule-writer.test.mjs'));
  assert.ok(WORKFLOW.includes('node --test aws/tests/production-checkalt-schedule-policy.test.mjs'));
  assert.ok(WORKFLOW.includes('node scripts/deployment-guard/scan-bypass.mjs'));
  // The only AWS writes go through the writer; the workflow itself never calls CloudFormation, IAM or Scheduler.
  assert.doesNotMatch(WORKFLOW, /aws cloudformation|aws iam|aws scheduler|create-stack|update-stack|delete-stack/);
  assert.match(WORKFLOW, /if: \$\{\{ inputs\.mode != 'inspect' \}\}\n\s+shell: bash\n\s+env:\n\s+CHECKSOPS_PRODUCTION_CHECKALT_SCHEDULE_EXECUTE: "1"/);
});

#!/usr/bin/env node
/**
 * Receipt-gated writer for the production CloudFormation stack
 * checksops-production-checkalt-status-schedule (the scheduled, read-only Check Alt status check).
 *
 * Exact permitted mutations:
 *   create:    CreateStack with exactly the bytes of aws/production/checkalt-status-reconcile-schedule.yaml
 *              (sha256 pinned below), CAPABILITY_NAMED_IAM, ActorApplicationUserId = the reviewed
 *              platform-owner id, every other parameter at its template default, OnFailure DO_NOTHING.
 *   set-state: UpdateStack UsePreviousTemplate=true, ScheduleState ENABLED <-> DISABLED, every other
 *              parameter UsePreviousValue=true.
 *
 * The stack, its IAM role, its schedule and the prep Lambda are read into one normalized snapshot.
 * The signed receipt's preflight fingerprint is that whole snapshot, and the requested change
 * (the actor id or the target state) is bound into the receipt's owned_components. The writer
 * re-reads before and immediately before the write, waits for the stack to settle, never retries
 * and never deletes, and requires the post-write snapshot to differ only in what was requested.
 * No Lambda, API Gateway, CloudFront, SQL, Cognito, provider, financial or SPA mutation is performed.
 *
 * Run only from guarded-production-checkalt-schedule.yml after github-production-checkalt-schedule.mjs
 * issued the receipt.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { refuseUnguardedDeploy, resolveGuardRoot } from './require-guard.mjs';
import { consumeReceiptOnce } from './lib/consumed-receipts.mjs';
import { evaluateProductionGate } from './lib/production.mjs';

const AWS = process.env.AWS_CLI || process.env.AWS || 'aws';
const REGION = 'us-east-1';
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const ACCOUNT_ID = '806168576068';
export const STACK_NAME = 'checksops-production-checkalt-status-schedule';
export const SCHEDULE_NAME = 'checksops-production-checkalt-status-reconcile';
export const ROLE_NAME = 'checksops-production-checkalt-status-schedule';
export const ROLE_POLICY_NAME = 'invoke-prep-api-only';
export const PREP_LAMBDA = 'checksops-production-prep-api';
export const PREP_LAMBDA_ARN = `arn:aws:lambda:${REGION}:${ACCOUNT_ID}:function:${PREP_LAMBDA}`;
export const ROLE_ARN = `arn:aws:iam::${ACCOUNT_ID}:role/${ROLE_NAME}`;
export const TEMPLATE_PATH = 'aws/production/checkalt-status-reconcile-schedule.yaml';
// sha256 of the template bytes on an LF checkout of main bd9fe944b. The template is not edited by
// this workflow; a different file is a new reviewed change, never an updated number here.
export const TEMPLATE_SHA256 = '4db5dd4f1e9abf120db92dedb8e3213ddc4960a21bb96d5aa6c19d3a478a5845';
// The template's ActorApplicationUserId AllowedPattern, verbatim.
export const ACTOR_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const SCHEDULE_STATES = Object.freeze(['ENABLED', 'DISABLED']);
export const DEFAULT_PARAMETERS = Object.freeze({ ScheduleState: 'ENABLED', ScheduleExpression: 'rate(30 minutes)' });
export const SCHEDULE_DEPLOYMENT_TYPE = 'cloudformation';
export const SCHEDULE_TARGET_COMPONENT = 'production-checkalt-status-schedule';
export const SCHEDULE_CAPABILITIES = Object.freeze(['CAPABILITY_NAMED_IAM']);
export const COMPLETE_STATUSES = Object.freeze(['CREATE_COMPLETE', 'UPDATE_COMPLETE']);
export const EXPECTED_SCHEDULE = Object.freeze({
  GroupName: 'default',
  ScheduleExpressionTimezone: 'UTC',
  FlexibleTimeWindow: { Mode: 'OFF' },
  TargetArn: PREP_LAMBDA_ARN,
  RoleArn: ROLE_ARN,
  RetryPolicy: { MaximumEventAgeInSeconds: 300, MaximumRetryAttempts: 0 },
});
export const EXPECTED_INPUT_SHAPE = Object.freeze({
  checksops_scheduler: 'eventbridge-scheduler',
  job: 'checkalt-poll-deposits',
  rawPath: '/scheduled/checkalt-poll-deposits',
  requestContext: { http: { method: 'POST' } },
});

const sha256 = (v) => createHash('sha256').update(v).digest('hex');
const hash = (v) => sha256(JSON.stringify(v));
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const arr = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);
export const snapshotFingerprint = (snapshot) => hash(snapshot);

/** The owned components bind the requested change into the signed receipt. */
export function ownedComponentsFor(mode, value) {
  if (mode === 'create') return [`stack:${STACK_NAME}:create`, `parameter:ActorApplicationUserId=${value}`];
  if (mode === 'set-state') return [`stack:${STACK_NAME}:update`, `parameter:ScheduleState=${value}`];
  throw new Error('unknown_mode');
}

export function validateActor(actor) {
  return ACTOR_RE.test(String(actor || ''));
}

export function readTemplate(root = repoRoot) {
  const bytes = fs.readFileSync(path.join(root, TEMPLATE_PATH));
  return { body: bytes.toString('utf8'), sha256: sha256(bytes) };
}

export function assertPinnedTemplate(template) {
  if (template.sha256 !== TEMPLATE_SHA256) {
    throw new Error(`template_hash_drift:${template.sha256}`);
  }
}

function sortObject(obj) {
  return Object.fromEntries(Object.entries(obj || {}).sort(([a], [b]) => a.localeCompare(b)));
}

function parseInput(raw) {
  if (raw == null) return null;
  try { return JSON.parse(raw); } catch { return { unparseable: true }; }
}

export function normalizeSnapshot({ stack, stackTemplateBody, role, rolePolicy, schedule, lambda }) {
  return {
    repository_template_sha256: TEMPLATE_SHA256,
    stack: stack ? {
      StackName: stack.StackName,
      StackId: stack.StackId,
      StackStatus: stack.StackStatus,
      Parameters: sortObject(Object.fromEntries((stack.Parameters || []).map((p) => [p.ParameterKey, p.ParameterValue]))),
      TemplateSha256: stackTemplateBody == null ? null : sha256(typeof stackTemplateBody === 'string' ? stackTemplateBody : JSON.stringify(stackTemplateBody)),
    } : null,
    role: role ? {
      RoleName: role.Role?.RoleName,
      Arn: role.Role?.Arn,
      AssumeRolePolicyDocument: role.Role?.AssumeRolePolicyDocument ?? null,
      InlinePolicy: rolePolicy ? rolePolicy.PolicyDocument ?? null : null,
    } : null,
    schedule: schedule ? {
      Name: schedule.Name,
      GroupName: schedule.GroupName,
      State: schedule.State,
      ScheduleExpression: schedule.ScheduleExpression,
      ScheduleExpressionTimezone: schedule.ScheduleExpressionTimezone,
      FlexibleTimeWindow: { Mode: schedule.FlexibleTimeWindow?.Mode },
      TargetArn: schedule.Target?.Arn,
      RoleArn: schedule.Target?.RoleArn,
      RetryPolicy: {
        MaximumEventAgeInSeconds: schedule.Target?.RetryPolicy?.MaximumEventAgeInSeconds,
        MaximumRetryAttempts: schedule.Target?.RetryPolicy?.MaximumRetryAttempts,
      },
      Input: parseInput(schedule.Target?.Input),
    } : null,
    lambda: lambda ? { FunctionName: lambda.FunctionName, CodeSha256: lambda.CodeSha256, RevisionId: lambda.RevisionId } : null,
  };
}

function lambdaShape(s, errors) {
  if (!s.lambda || s.lambda.FunctionName !== PREP_LAMBDA || !s.lambda.CodeSha256 || !s.lambda.RevisionId) errors.push('prep_lambda_missing');
  if (s.repository_template_sha256 !== TEMPLATE_SHA256) errors.push('template_pin_drift');
}

function roleShapeErrors(role) {
  const errors = [];
  if (!role) return ['role_missing'];
  if (role.RoleName !== ROLE_NAME || role.Arn !== ROLE_ARN) errors.push('role_identity_drift');
  const trust = arr(role.AssumeRolePolicyDocument?.Statement);
  const t = trust[0] || {};
  if (trust.length !== 1 || t.Effect !== 'Allow'
    || !eq(arr(t.Principal?.Service), ['scheduler.amazonaws.com']) || Object.keys(t.Principal || {}).length !== 1
    || !eq(arr(t.Action), ['sts:AssumeRole'])
    || !eq(t.Condition, { StringEquals: { 'aws:SourceAccount': ACCOUNT_ID } })) errors.push('role_trust_drift');
  const policy = arr(role.InlinePolicy?.Statement);
  const p = policy[0] || {};
  if (policy.length !== 1 || p.Effect !== 'Allow'
    || !eq(arr(p.Action), ['lambda:InvokeFunction'])
    || !eq(arr(p.Resource), [PREP_LAMBDA_ARN]) || p.Condition || p.NotAction || p.NotResource) errors.push('role_policy_drift');
  return errors;
}

/** The live schedule holds the pinned shape for this actor and state. */
export function scheduleShapeErrors(schedule, { actor, state }) {
  const errors = [];
  if (!schedule) return ['schedule_missing'];
  if (schedule.Name !== SCHEDULE_NAME) errors.push('schedule_name_drift');
  if (state && schedule.State !== state) errors.push('schedule_state_mismatch');
  for (const key of Object.keys(EXPECTED_SCHEDULE)) {
    if (!eq(schedule[key], EXPECTED_SCHEDULE[key])) errors.push(`schedule_${key}_drift`);
  }
  if (!['rate(30 minutes)', 'rate(45 minutes)', 'rate(60 minutes)'].includes(schedule.ScheduleExpression)) errors.push('schedule_expression_drift');
  if (!eq(schedule.Input, { ...EXPECTED_INPUT_SHAPE, actor_application_user_id: actor })) errors.push('schedule_input_drift');
  return errors;
}

/**
 * ABSENT: stack, role and schedule absent, prep Lambda present -> create may proceed.
 * LIVE:   stack complete from the pinned template, role and schedule in the pinned shape and
 *         consistent with the stack parameters -> set-state may proceed.
 * BLOCKED: anything else (partial create, rollback, in-progress, drift).
 */
export function classify(s) {
  const errors = [];
  lambdaShape(s, errors);
  if (!s.stack && !s.role && !s.schedule) {
    return { state: errors.length ? 'BLOCKED' : 'ABSENT', problems: errors, fingerprint: hash(s) };
  }
  if (!s.stack) errors.push('stack_missing_but_resources_present');
  else {
    if (s.stack.StackName !== STACK_NAME) errors.push('stack_name_drift');
    if (!COMPLETE_STATUSES.includes(s.stack.StackStatus)) errors.push(`stack_status_${s.stack.StackStatus}`);
    if (s.stack.TemplateSha256 !== TEMPLATE_SHA256) errors.push('stack_template_drift');
    const params = s.stack.Parameters || {};
    if (!eq(Object.keys(params).sort(), ['ActorApplicationUserId', 'ScheduleExpression', 'ScheduleState'])) errors.push('stack_parameters_drift');
    if (!validateActor(params.ActorApplicationUserId)) errors.push('stack_actor_invalid');
    if (!SCHEDULE_STATES.includes(params.ScheduleState)) errors.push('stack_schedule_state_invalid');
    errors.push(...roleShapeErrors(s.role));
    errors.push(...scheduleShapeErrors(s.schedule, { actor: params.ActorApplicationUserId, state: params.ScheduleState }));
    if (s.schedule && s.schedule.ScheduleExpression !== params.ScheduleExpression) errors.push('schedule_expression_mismatch');
  }
  return { state: errors.length ? 'BLOCKED' : 'LIVE', problems: errors, fingerprint: hash(s) };
}

/** The post-write snapshot differs from the pre-write one only in what was requested. */
export function assertExpectedAfter(before, after, { mode, actor, state }) {
  const live = classify(after);
  if (live.state !== 'LIVE') throw new Error('post_write_not_live:' + live.problems.join(','));
  if (!eq(after.lambda, before.lambda)) throw new Error('post_write_lambda_moved');
  if (after.repository_template_sha256 !== before.repository_template_sha256) throw new Error('post_write_template_moved');
  if (mode === 'create') {
    if (before.stack || before.role || before.schedule) throw new Error('post_write_create_precondition');
    if (after.stack.StackStatus !== 'CREATE_COMPLETE') throw new Error('post_write_stack_status');
    if (!eq(after.stack.Parameters, sortObject({ ...DEFAULT_PARAMETERS, ActorApplicationUserId: actor }))) throw new Error('post_write_parameters');
    if (after.schedule.State !== 'ENABLED') throw new Error('post_write_schedule_state');
    if (after.schedule.Input?.actor_application_user_id !== actor) throw new Error('post_write_actor');
    return;
  }
  if (mode === 'set-state') {
    const expected = structuredClone(before);
    expected.stack.StackStatus = 'UPDATE_COMPLETE';
    expected.stack.Parameters.ScheduleState = state;
    expected.schedule.State = state;
    if (!eq(after, expected)) throw new Error('post_write_non_state_drift');
    return;
  }
  throw new Error('unknown_mode');
}

function awsJson(args, env = process.env) {
  const out = execFileSync(AWS, ['--region', REGION, '--output', 'json', ...args], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
  return out.trim() ? JSON.parse(out) : {};
}

function awsJsonOrAbsent(args, absentRe, env) {
  try {
    return awsJson(args, env);
  } catch (error) {
    const text = `${error?.stderr || ''}${error?.message || ''}`;
    if (absentRe.test(text)) return null;
    throw error;
  }
}

export function readSnapshot(env = process.env) {
  const stacks = awsJsonOrAbsent(['cloudformation', 'describe-stacks', '--stack-name', STACK_NAME], /does not exist/, env);
  const stack = stacks?.Stacks?.[0] || null;
  const template = stack
    ? awsJson(['cloudformation', 'get-template', '--stack-name', STACK_NAME, '--template-stage', 'Original'], env)
    : null;
  const role = awsJsonOrAbsent(['iam', 'get-role', '--role-name', ROLE_NAME], /NoSuchEntity/, env);
  const rolePolicy = role
    ? awsJsonOrAbsent(['iam', 'get-role-policy', '--role-name', ROLE_NAME, '--policy-name', ROLE_POLICY_NAME], /NoSuchEntity/, env)
    : null;
  const schedule = awsJsonOrAbsent(['scheduler', 'get-schedule', '--name', SCHEDULE_NAME], /ResourceNotFoundException/, env);
  const lambda = awsJson(['lambda', 'get-function-configuration', '--function-name', PREP_LAMBDA], env);
  return normalizeSnapshot({ stack, stackTemplateBody: template?.TemplateBody ?? null, role, rolePolicy, schedule, lambda });
}

/** The exact CreateStack call. Nothing caller-supplied but the validated actor id reaches it. */
export function createStackArgs({ templateBody, actor }) {
  return [
    'cloudformation', 'create-stack',
    '--stack-name', STACK_NAME,
    '--template-body', templateBody,
    '--capabilities', ...SCHEDULE_CAPABILITIES,
    '--on-failure', 'DO_NOTHING',
    '--parameters', JSON.stringify([{ ParameterKey: 'ActorApplicationUserId', ParameterValue: actor }]),
  ];
}

/** The exact UpdateStack call: previous template, only ScheduleState changes. */
export function updateStackArgs({ state }) {
  return [
    'cloudformation', 'update-stack',
    '--stack-name', STACK_NAME,
    '--use-previous-template',
    '--capabilities', ...SCHEDULE_CAPABILITIES,
    '--parameters', JSON.stringify([
      { ParameterKey: 'ActorApplicationUserId', UsePreviousValue: true },
      { ParameterKey: 'ScheduleExpression', UsePreviousValue: true },
      { ParameterKey: 'ScheduleState', ParameterValue: state },
    ]),
  ];
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Polls DescribeStacks until the stack leaves *_IN_PROGRESS. Never retries the write. */
export function waitForStack(env = process.env, { describe, sleep = sleepSync, intervalMs = 10_000, timeoutMs = 20 * 60_000, now = Date.now } = {}) {
  const read = describe || (() => awsJson(['cloudformation', 'describe-stacks', '--stack-name', STACK_NAME], env).Stacks?.[0]?.StackStatus);
  const deadline = now() + timeoutMs;
  for (;;) {
    const status = read();
    if (status && !/_IN_PROGRESS$/.test(status)) return status;
    if (now() >= deadline) throw new Error(`stack_wait_timeout:${status}`);
    sleep(intervalMs);
  }
}

function failureEvents(env) {
  try {
    const events = awsJson(['cloudformation', 'describe-stack-events', '--stack-name', STACK_NAME], env).StackEvents || [];
    return events.filter((e) => /FAILED/.test(e.ResourceStatus || '')).slice(0, 10)
      .map((e) => ({ LogicalResourceId: e.LogicalResourceId, ResourceStatus: e.ResourceStatus, ResourceStatusReason: e.ResourceStatusReason }));
  } catch {
    return [];
  }
}

function readInput(env) {
  const file = env.CHECKSOPS_SCHEDULE_INPUT;
  if (!file) throw new Error('schedule_input_missing');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function main(env = process.env, deps = {}) {
  const read = deps.readSnapshot || readSnapshot;
  const runAws = deps.runAws || ((args) => awsJson(args, env));
  const wait = deps.waitForStack || (() => waitForStack(env));
  const events = deps.failureEvents || (() => failureEvents(env));
  if (env.CHECKSOPS_PRODUCTION_CHECKALT_SCHEDULE_EXECUTE !== '1') {
    process.stdout.write(JSON.stringify({ ok: false, plan_only: true, stack: STACK_NAME, template_sha256: TEMPLATE_SHA256 }) + '\n');
    return 2;
  }
  const input = readInput(env);
  if (input.template_body || input.template_url || input.parameters || input.capabilities || input.delete === true) {
    throw new Error('caller_supplied_stack_forbidden');
  }
  const mode = input.mode;
  if (mode !== 'create' && mode !== 'set-state') throw new Error('unknown_mode');
  const value = mode === 'create' ? input.actor_application_user_id : input.schedule_state;
  if (mode === 'create' && !validateActor(value)) throw new Error('actor_invalid');
  if (mode === 'set-state' && !SCHEDULE_STATES.includes(value)) throw new Error('schedule_state_invalid');

  const template = (deps.readTemplate || readTemplate)(deps.repoRoot || repoRoot);
  assertPinnedTemplate(template);

  const first = read(env);
  const checked = classify(first);
  const required = mode === 'create' ? 'ABSENT' : 'LIVE';
  if (checked.state !== required) throw new Error(`preflight_state:${checked.state}:${checked.problems.join(',')}`);
  if (mode === 'set-state' && first.schedule.State === value) throw new Error('schedule_already_in_state');

  const authorized = refuseUnguardedDeploy({
    target_environment: 'production',
    target_component: SCHEDULE_TARGET_COMPONENT,
    deployment_type: SCHEDULE_DEPLOYMENT_TYPE,
    preflight_live_fingerprint: first,
    workstream_id: input.workstream_id || env.CHECKSOPS_WORKSTREAM_ID,
    commit: input.commit || env.CHECKSOPS_COMMIT,
    receipt_path: input.receipt_path,
  }, { env, now: deps.now, root: deps.guardRoot });
  if (!authorized.ok) throw new Error('guard_refused:' + (authorized.code || 'DEPLOYMENT_GUARD_REQUIRED'));
  const receipt = authorized.details.receipt;
  if (receipt.deployment_type !== SCHEDULE_DEPLOYMENT_TYPE) throw new Error('receipt_type_mismatch');
  if (!eq(receipt.owned_components, ownedComponentsFor(mode, value)) || Object.hasOwn(receipt, 'owned_member_ops')) {
    throw new Error('receipt_component_mismatch');
  }

  // Mandatory TOCTOU read immediately before the only mutation.
  const second = read(env);
  const rechecked = classify(second);
  if (rechecked.state !== required || rechecked.fingerprint !== checked.fingerprint) {
    throw new Error('toctou_drift:' + rechecked.problems.join(','));
  }

  const gate = evaluateProductionGate({
    target_environment: 'production',
    deployment_type: SCHEDULE_DEPLOYMENT_TYPE,
    workstream_id: receipt.workstream_id,
    production_fingerprint: { snapshot_sha256: checked.fingerprint },
    immediately_before_fingerprint: { snapshot_sha256: rechecked.fingerprint },
    staging_acceptance: input.staging_acceptance,
    approval: input.approval,
  });
  if (!gate.ok) throw new Error('production_gate:' + (gate.code || 'refused'));

  const consumed = consumeReceiptOnce(deps.guardRoot || resolveGuardRoot({}, env), receipt, {
    now: deps.now,
    actor: env.CHECKSOPS_OPERATOR || env.USER || null,
    script: 'production-checkalt-schedule',
  });
  if (!consumed.ok) throw new Error('receipt_consumption_failed:' + (consumed.code || 'unknown'));

  runAws(mode === 'create' ? createStackArgs({ templateBody: template.body, actor: value }) : updateStackArgs({ state: value }));

  const status = wait();
  const expectedStatus = mode === 'create' ? 'CREATE_COMPLETE' : 'UPDATE_COMPLETE';
  if (status !== expectedStatus) {
    // Report and stop: no retry, no delete, no rollback by this writer.
    process.stderr.write(JSON.stringify({ ok: false, stack: STACK_NAME, status, failure_events: events() }) + '\n');
    throw new Error(`stack_${mode}_failed:${status}`);
  }

  const after = read(env);
  assertExpectedAfter(second, after, { mode, actor: value, state: value });
  process.stdout.write(JSON.stringify({
    ok: true,
    stack: STACK_NAME,
    mode,
    status,
    schedule_state: after.schedule.State,
    before_fingerprint: checked.fingerprint,
    after_fingerprint: hash(after),
  }) + '\n');
  return 0;
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) { try { process.exitCode = main(); } catch (e) { process.stderr.write(JSON.stringify({ ok: false, message: e?.message || String(e) }) + '\n'); process.exitCode = 2; } }

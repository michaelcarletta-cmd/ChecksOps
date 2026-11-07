/**
 * Production Moov status catch-up workflow and its dedicated role (ops/moov-status-catch-up.md,
 * ops/deployment-guard/production-moov-status-catch-up/README.md): the role may only invoke
 * checksops-production-prep-api; its trust is pinned to this workflow on main in the production
 * environment of this repository; the workflow refuses an apply without the reviewed plan's
 * manifest_sha256, transfer ids and the owner's exact phrase, and never applies unless a fresh
 * plan is the reviewed one. No AWS call: the Lambda invoke is a fake.
 *
 * Run with: node --experimental-strip-types --test aws/tests/github-production-moov-status-catch-up.test.mjs
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import {
  FUNCTION_ARN,
  FUNCTION_NAME,
  ROLE_ARN,
  ROLE_ARN_VARIABLE,
  ROLE_NAME,
  WORKFLOW_FILE,
  applyPhrase,
  compareWithReviewedPlan,
  main,
  parseTransferIds,
  run,
  validateInputs,
} from '../../scripts/deployment-guard/github-production-moov-status-catch-up.mjs';
import {
  CATCH_UP_PLAN_STATEMENT,
  isMoovStatusCatchUpInvocation,
  parseCatchUpRequest,
} from '../functions/api/providers/moov-status-catch-up.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
const DIR = 'ops/deployment-guard/production-moov-status-catch-up';
const WORKFLOW = read(WORKFLOW_FILE);
const WORKFLOW_DOC = YAML.parse(WORKFLOW);
const STEPS = WORKFLOW_DOC.jobs['production-moov-status-catch-up'].steps;
const step = (name) => STEPS.find((row) => row.name === name);

const ACTOR = '0f0e0d0c-0b0a-4908-8706-050403020100';
const MANIFEST = 'a'.repeat(64);
const IDS = ['b31c7752-031f-4b8b-9b6e-82dd0aaed2cb', '0aa1c3d2-1111-4222-8333-444455556666'];
const SORTED_IDS = [...IDS].sort();

const planAnswer = (overrides = {}) => ({
  ok: true,
  statusCode: 200,
  phase: 'plan',
  environment: 'production',
  read_only: true,
  manifest: { environment: 'production', limit: 50, entries: [] },
  manifest_sha256: MANIFEST,
  transfer_ids: SORTED_IDS,
  counts: { candidates: 2, apply: 2, skip: 0, refuse: 0 },
  truncated: false,
  moov_unavailable: false,
  ...overrides,
});

const applyEnv = (overrides = {}) => ({
  CHECKSOPS_CATCH_UP_PHASE: 'apply',
  CHECKSOPS_CATCH_UP_ACTOR_APPLICATION_USER_ID: ACTOR,
  CHECKSOPS_CATCH_UP_LIMIT: '50',
  CHECKSOPS_CATCH_UP_APPROVAL_PHRASE: applyPhrase(MANIFEST),
  CHECKSOPS_CATCH_UP_MANIFEST_SHA256: MANIFEST,
  CHECKSOPS_CATCH_UP_TRANSFER_IDS: IDS.join(','),
  ...overrides,
});
const planEnv = (overrides = {}) => ({
  CHECKSOPS_CATCH_UP_PHASE: 'plan',
  CHECKSOPS_CATCH_UP_ACTOR_APPLICATION_USER_ID: ACTOR,
  CHECKSOPS_CATCH_UP_LIMIT: '50',
  ...overrides,
});

// A fake lambda:InvokeFunction: records each call and answers plan / apply in turn.
function fakeInvoke({ plan = planAnswer(), apply = { ok: true, phase: 'apply', applied: SORTED_IDS } } = {}) {
  const calls = [];
  const invoke = async (call) => {
    calls.push(structuredClone(call));
    return call.event.phase === 'plan' ? structuredClone(plan) : structuredClone(apply);
  };
  return { calls, invoke };
}

// An unqualified invoke (FunctionName, no Qualifier) runs $LATEST, and Lambda authorizes it against
// the ':$LATEST'-qualified ARN: run 42383055459 was refused by the role's own NotResource deny when
// both statements named only the unqualified ARN. These two strings, and nothing else.
const INVOKE_RESOURCES = [FUNCTION_ARN, `${FUNCTION_ARN}:$LATEST`];

test('the IAM permissions: lambda:InvokeFunction on checksops-production-prep-api (unqualified and :$LATEST) and nothing else', () => {
  const policy = JSON.parse(read(`${DIR}/permissions-policy.json`));
  assert.deepEqual(INVOKE_RESOURCES, [
    'arn:aws:lambda:us-east-1:806168576068:function:checksops-production-prep-api',
    'arn:aws:lambda:us-east-1:806168576068:function:checksops-production-prep-api:$LATEST',
  ]);
  // The whole document: any added action, resource, statement, condition or key fails here.
  assert.deepEqual(policy, {
    Version: '2012-10-17',
    Statement: [
      { Sid: 'InvokeTheProductionApiLambdaOnly', Effect: 'Allow', Action: 'lambda:InvokeFunction', Resource: INVOKE_RESOURCES },
      { Sid: 'NeverAnyOtherAction', Effect: 'Deny', NotAction: 'lambda:InvokeFunction', Resource: '*' },
      { Sid: 'NeverInvokeAnyOtherFunctionVersionOrAlias', Effect: 'Deny', Action: 'lambda:InvokeFunction', NotResource: INVOKE_RESOURCES },
    ],
  });
  // No wildcard in the invoke statements, and no qualifier other than $LATEST.
  const invoke = policy.Statement.filter((s) => s.Sid !== 'NeverAnyOtherAction');
  assert.equal(/[*?]/.test(JSON.stringify(invoke)), false);
  const qualifiers = JSON.stringify(invoke).match(/:function:checksops-production-prep-api:[^"]*/g);
  assert.deepEqual([...new Set(qualifiers)], [':function:checksops-production-prep-api:$LATEST']);
});

// A small IAM evaluator over the JSON documents: explicit deny wins, then an allow, else implicit
// deny. A session policy can only narrow: the request needs an allow in both and no deny in either.
// Matching is IAM's: case-sensitive resources, '*' and '?' wildcards, string or list values.
function iamGlob(pattern, value, { ignoreCase = false } = {}) {
  const re = new RegExp(`^${pattern.split('').map((c) => (c === '*' ? '.*' : c === '?' ? '.' : c.replace(/[.+^${}()|[\]\\]/g, '\\$&'))).join('')}$`, ignoreCase ? 'i' : '');
  return re.test(value);
}
const asList = (value) => (value === undefined ? undefined : [].concat(value));
function statementMatches(statement, { action, resource }) {
  assert.equal(statement.Condition, undefined, 'the evaluator does not model conditions');
  const actions = asList(statement.Action);
  const notActions = asList(statement.NotAction);
  const resources = asList(statement.Resource);
  const notResources = asList(statement.NotResource);
  const actionHit = actions
    ? actions.some((a) => iamGlob(a, action, { ignoreCase: true }))
    : !notActions.some((a) => iamGlob(a, action, { ignoreCase: true }));
  const resourceHit = resources
    ? resources.some((r) => iamGlob(r, resource))
    : !notResources.some((r) => iamGlob(r, resource));
  return actionHit && resourceHit;
}
function evaluatePolicy(policy, request) {
  const hits = policy.Statement.filter((s) => statementMatches(s, request));
  if (hits.some((s) => s.Effect === 'Deny')) return 'explicit_deny';
  if (hits.some((s) => s.Effect === 'Allow')) return 'allow';
  return 'implicit_deny';
}
function evaluateSession(identity, session, request) {
  const a = evaluatePolicy(identity, request);
  const b = evaluatePolicy(session, request);
  if (a === 'explicit_deny' || b === 'explicit_deny') return 'explicit_deny';
  return a === 'allow' && b === 'allow' ? 'allow' : 'implicit_deny';
}

test('IAM evaluation: the role and the workflow session allow the unqualified and the :$LATEST invoke, and nothing else', () => {
  const identity = JSON.parse(read(`${DIR}/permissions-policy.json`));
  const sessions = STEPS.filter((row) => String(row.uses || '').startsWith('aws-actions/configure-aws-credentials@'));
  const session = JSON.parse(sessions[0].with['inline-session-policy']);
  const invoke = (resource) => ({ action: 'lambda:InvokeFunction', resource });

  // The evaluator reproduces run 42383055459 on the policy as first created.
  const firstVersion = structuredClone(identity);
  firstVersion.Statement[0].Resource = FUNCTION_ARN;
  firstVersion.Statement[2].NotResource = FUNCTION_ARN;
  assert.equal(evaluatePolicy(firstVersion, invoke(`${FUNCTION_ARN}:$LATEST`)), 'explicit_deny');
  assert.equal(evaluatePolicy(firstVersion, invoke(FUNCTION_ARN)), 'allow');

  for (const resource of [FUNCTION_ARN, `${FUNCTION_ARN}:$LATEST`]) {
    assert.equal(evaluatePolicy(identity, invoke(resource)), 'allow', resource);
    assert.equal(evaluatePolicy(session, invoke(resource)), 'allow', resource);
    assert.equal(evaluateSession(identity, session, invoke(resource)), 'allow', resource);
  }
  for (const resource of [
    `${FUNCTION_ARN}:1`,
    `${FUNCTION_ARN}:live`,
    `${FUNCTION_ARN}:$latest`,
    `${FUNCTION_ARN}:$LATEST:1`,
    `${FUNCTION_ARN}-other`,
    `${FUNCTION_ARN}-other:$LATEST`,
    'arn:aws:lambda:us-east-1:806168576068:function:checksops-staging-prep-api',
    'arn:aws:lambda:us-east-1:806168576068:function:checksops-staging-prep-api:$LATEST',
    'arn:aws:lambda:us-west-2:806168576068:function:checksops-production-prep-api',
    'arn:aws:lambda:us-east-1:111111111111:function:checksops-production-prep-api:$LATEST',
  ]) {
    assert.equal(evaluatePolicy(identity, invoke(resource)), 'explicit_deny', resource);
    assert.equal(evaluateSession(identity, session, invoke(resource)), 'explicit_deny', resource);
    assert.equal(evaluatePolicy(session, invoke(resource)), 'implicit_deny', resource);
  }
  for (const action of ['lambda:UpdateFunctionCode', 'lambda:UpdateFunctionConfiguration', 'lambda:GetFunction', 'lambda:InvokeAsync', 'lambda:InvokeFunctionUrl', 'iam:PassRole', 's3:GetObject']) {
    for (const resource of [FUNCTION_ARN, `${FUNCTION_ARN}:$LATEST`, '*']) {
      assert.equal(evaluatePolicy(identity, { action, resource }), 'explicit_deny', `${action} ${resource}`);
      assert.equal(evaluatePolicy(session, { action, resource }), 'implicit_deny', `${action} ${resource}`);
    }
  }
});

test('the IAM trust: GitHub OIDC, this repository, main, the production environment and only this workflow file', () => {
  const trust = JSON.parse(read(`${DIR}/trust-policy.json`));
  const spa = JSON.parse(read('ops/deployment-guard/production-spa-fallback/trust-policy.json'));
  assert.equal(trust.Statement.length, 1);
  const [statement] = trust.Statement;
  assert.equal(statement.Effect, 'Allow');
  assert.equal(statement.Action, 'sts:AssumeRoleWithWebIdentity');
  assert.deepEqual(statement.Principal, { Federated: 'arn:aws:iam::806168576068:oidc-provider/token.actions.githubusercontent.com' });
  assert.deepEqual(statement.Principal, spa.Statement[0].Principal);
  assert.deepEqual(statement.Condition, {
    StringEquals: {
      'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
      'token.actions.githubusercontent.com:sub': 'repo:michaelcarletta-cmd/ChecksOps:environment:production',
      'token.actions.githubusercontent.com:repository_id': '1231339992',
      'token.actions.githubusercontent.com:repository_owner_id': '248244651',
      'token.actions.githubusercontent.com:environment': 'production',
      'token.actions.githubusercontent.com:ref': 'refs/heads/main',
      'token.actions.githubusercontent.com:job_workflow_ref': `michaelcarletta-cmd/ChecksOps/${WORKFLOW_FILE}@refs/heads/main`,
    },
  });
  // The SPA fallback role's proven conditions, with only the workflow file changed.
  const { 'token.actions.githubusercontent.com:job_workflow_ref': _mine, ...rest } = statement.Condition.StringEquals;
  const { 'token.actions.githubusercontent.com:job_workflow_ref': _spa, ...spaRest } = spa.Statement[0].Condition.StringEquals;
  assert.deepEqual(rest, spaRest);
  // No wildcard, no StringLike.
  assert.equal(/StringLike|\*/.test(JSON.stringify(trust)), false);
  assert.ok(fs.existsSync(path.join(REPO_ROOT, WORKFLOW_FILE)));
});

test('the workflow: dispatch only, main only, production environment, own concurrency, the dedicated role, an invoke-only session', () => {
  assert.deepEqual(Object.keys(WORKFLOW_DOC.on), ['workflow_dispatch']);
  const inputs = WORKFLOW_DOC.on.workflow_dispatch.inputs;
  assert.deepEqual(Object.keys(inputs), ['phase', 'actor_application_user_id', 'limit', 'approval_phrase', 'manifest_sha256', 'transfer_ids']);
  assert.deepEqual(inputs.phase.options, ['plan', 'apply']);
  assert.equal(inputs.phase.default, 'plan');
  assert.deepEqual(WORKFLOW_DOC.permissions, { contents: 'read', 'id-token': 'write' });
  assert.deepEqual(WORKFLOW_DOC.concurrency, { group: 'production-moov-status-catch-up', 'cancel-in-progress': false });
  const job = WORKFLOW_DOC.jobs['production-moov-status-catch-up'];
  assert.deepEqual(Object.keys(WORKFLOW_DOC.jobs), ['production-moov-status-catch-up']);
  assert.equal(job.environment, 'production');
  assert.match(WORKFLOW, /test "\$GITHUB_REF" = "refs\/heads\/main"/);
  assert.match(WORKFLOW, /test "\$\(git rev-parse HEAD\)" = "\$GITHUB_SHA"/);
  assert.match(WORKFLOW, new RegExp(`vars\\.${ROLE_ARN_VARIABLE}`));
  assert.match(WORKFLOW, /test "\$PRODUCTION_MOOV_STATUS_CATCH_UP_ROLE_ARN" = "arn:aws:iam::806168576068:role\/ChecksOpsGitHubProductionMoovStatusCatchUp"/);
  assert.ok(WORKFLOW.includes(ROLE_ARN));
  assert.match(WORKFLOW, /arn:aws:sts::806168576068:assumed-role\/ChecksOpsGitHubProductionMoovStatusCatchUp\/checksops-production-moov-status-catch-up-\$GITHUB_RUN_ID/);
  assert.match(WORKFLOW, /node --experimental-strip-types --test aws\/tests\/github-production-moov-status-catch-up\.test\.mjs/);

  // One AWS session, and it can only invoke the one function.
  const sessions = STEPS.filter((row) => String(row.uses || '').startsWith('aws-actions/configure-aws-credentials@'));
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].with['role-to-assume'], `\${{ vars.${ROLE_ARN_VARIABLE} }}`);
  assert.equal(sessions[0].with['role-session-name'], 'checksops-production-moov-status-catch-up-${{ github.run_id }}');
  const session = JSON.parse(sessions[0].with['inline-session-policy']);
  assert.deepEqual(session, { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: ['lambda:InvokeFunction'], Resource: INVOKE_RESOURCES }] });

  // Inputs reach shell only through env; no secret is read; no write-shaped AWS command.
  for (const row of STEPS.filter((s) => s.run)) assert.equal(/\$\{\{\s*inputs\./.test(row.run), false, row.name);
  assert.equal(/secrets\./.test(WORKFLOW), false);
  assert.equal(/update-function|UpdateFunction|put-role-policy|create-role|aws lambda invoke|staging/.test(WORKFLOW.replace(/^#.*$/gm, '')), false);
  const invokeStep = step('Invoke the catch-up in the production API Lambda');
  assert.equal(invokeStep.run, 'node scripts/deployment-guard/github-production-moov-status-catch-up.mjs');
  assert.deepEqual(Object.keys(invokeStep.env).sort(), [
    'CHECKSOPS_CATCH_UP_ACTOR_APPLICATION_USER_ID', 'CHECKSOPS_CATCH_UP_APPROVAL_PHRASE', 'CHECKSOPS_CATCH_UP_LIMIT',
    'CHECKSOPS_CATCH_UP_MANIFEST_SHA256', 'CHECKSOPS_CATCH_UP_PHASE', 'CHECKSOPS_CATCH_UP_TRANSFER_IDS',
  ]);
  // The gate runs before Node, the role check and the session.
  const order = STEPS.map((s) => s.name);
  assert.ok(order.indexOf('Refuse non-main or incomplete apply') < order.indexOf('Configure production catch-up session (invoke only)'));
  assert.ok(order.indexOf('Verify AWS identity') < order.indexOf('Invoke the catch-up in the production API Lambda'));
});

// Run the workflow's own gate script, as GitHub would, against this checkout.
function gate(env) {
  const script = step('Refuse non-main or incomplete apply').run;
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).stdout.trim();
  const res = spawnSync('bash', ['-c', script], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      GITHUB_REF: 'refs/heads/main',
      GITHUB_SHA: head,
      INPUT_PHASE: 'plan',
      INPUT_ACTOR: ACTOR,
      INPUT_LIMIT: '50',
      INPUT_APPROVAL_PHRASE: '',
      INPUT_MANIFEST_SHA256: '',
      INPUT_TRANSFER_IDS: '',
      ...env,
    },
  });
  return { code: res.status, out: `${res.stdout}${res.stderr}` };
}

test('the workflow gate: plan alone passes; apply needs the manifest, the ids and the exact phrase for that manifest', () => {
  assert.equal(gate({}).code, 0);
  const apply = { INPUT_PHASE: 'apply', INPUT_MANIFEST_SHA256: MANIFEST, INPUT_TRANSFER_IDS: IDS.join(','), INPUT_APPROVAL_PHRASE: applyPhrase(MANIFEST) };
  assert.equal(gate(apply).code, 0);

  const refusals = [
    [{ GITHUB_REF: 'refs/heads/feature' }, /only runs from main/],
    [{ GITHUB_SHA: 'f'.repeat(40) }, /Checkout SHA mismatch/],
    [{ INPUT_ACTOR: 'owner' }, /must be a uuid/],
    [{ INPUT_LIMIT: '0' }, /limit must be 1 to 200/],
    [{ INPUT_LIMIT: '201' }, /limit must be 1 to 200/],
    [{ INPUT_PHASE: 'delete' }, /phase must be plan or apply/],
    [{ INPUT_APPROVAL_PHRASE: CATCH_UP_PLAN_STATEMENT }, /plan takes no approval_phrase/],
    [{ INPUT_MANIFEST_SHA256: MANIFEST }, /plan takes no approval_phrase/],
    [{ ...apply, INPUT_APPROVAL_PHRASE: '' }, /approval_phrase must be exactly: apply the Moov catch-up plan a{64} in production/],
    [{ ...apply, INPUT_APPROVAL_PHRASE: applyPhrase('b'.repeat(64)) }, /approval_phrase must be exactly/],
    [{ ...apply, INPUT_APPROVAL_PHRASE: `${applyPhrase(MANIFEST)}.` }, /approval_phrase must be exactly/],
    [{ ...apply, INPUT_APPROVAL_PHRASE: CATCH_UP_PLAN_STATEMENT }, /approval_phrase must be exactly/],
    [{ ...apply, INPUT_MANIFEST_SHA256: '' }, /apply requires manifest_sha256/],
    [{ ...apply, INPUT_MANIFEST_SHA256: MANIFEST.toUpperCase() }, /apply requires manifest_sha256/],
    [{ ...apply, INPUT_TRANSFER_IDS: '' }, /apply requires transfer_ids/],
  ];
  for (const [env, message] of refusals) {
    const res = gate(env);
    assert.equal(res.code, 2, JSON.stringify(env));
    assert.match(res.out, message, JSON.stringify(env));
  }
  // Shell metacharacters in an input stay data.
  const res = gate({ INPUT_ACTOR: '$(touch /tmp/never)' });
  assert.equal(res.code, 2);
});

test('validateInputs: the same rules again in Node, and the transfer ids are parsed exactly', () => {
  assert.deepEqual(validateInputs(planEnv()), { ok: true, phase: 'plan', actor: ACTOR, limit: 50 });
  assert.deepEqual(validateInputs(planEnv({ CHECKSOPS_CATCH_UP_LIMIT: '' })), { ok: true, phase: 'plan', actor: ACTOR, limit: 50 });
  assert.equal(validateInputs(planEnv({ CHECKSOPS_CATCH_UP_APPROVAL_PHRASE: 'x' })).error, 'plan_takes_no_approval_phrase_manifest_or_transfer_ids');
  assert.equal(validateInputs(planEnv({ CHECKSOPS_CATCH_UP_LIMIT: '1e2' })).error, 'limit_must_be_1_to_200');
  assert.equal(validateInputs(planEnv({ CHECKSOPS_CATCH_UP_PHASE: 'inspect' })).error, 'phase_must_be_plan_or_apply');
  assert.equal(validateInputs(planEnv({ CHECKSOPS_CATCH_UP_ACTOR_APPLICATION_USER_ID: '' })).error, 'actor_application_user_id_required');
  const ok = validateInputs(applyEnv());
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.transferIds, SORTED_IDS);
  assert.equal(ok.statement, `apply the Moov catch-up plan ${MANIFEST} in production`);
  assert.equal(validateInputs(applyEnv({ CHECKSOPS_CATCH_UP_APPROVAL_PHRASE: '' })).error, 'approval_phrase_must_be_exact');
  assert.equal(validateInputs(applyEnv({ CHECKSOPS_CATCH_UP_APPROVAL_PHRASE: ` ${applyPhrase(MANIFEST)}` })).error, 'approval_phrase_must_be_exact');
  assert.equal(validateInputs(applyEnv({ CHECKSOPS_CATCH_UP_MANIFEST_SHA256: 'abc' })).error, 'apply_requires_manifest_sha256_from_the_reviewed_plan');
  assert.equal(validateInputs(applyEnv({ CHECKSOPS_CATCH_UP_TRANSFER_IDS: '' })).error, 'apply_requires_transfer_ids_from_the_reviewed_plan');
  assert.equal(parseTransferIds(`${IDS[0]}, ${IDS[1]}\n`).length, 2);
  assert.equal(parseTransferIds(`${IDS[0]},${IDS[0]}`), null);
  assert.equal(parseTransferIds('a;b'), null);
  assert.equal(parseTransferIds(''), null);
});

test('plan: one read-only invocation of the production function, with the event the Lambda accepts as a plan', async () => {
  const fake = fakeInvoke();
  const { code, result } = await run(planEnv(), { invoke: fake.invoke });
  assert.equal(code, 0);
  assert.equal(result.manifest_sha256, MANIFEST);
  assert.equal(fake.calls.length, 1);
  const [call] = fake.calls;
  assert.equal(call.functionName, FUNCTION_NAME);
  assert.equal(call.region, 'us-east-1');
  assert.deepEqual(call.event, {
    checksops_operator: 'moov-status-catch-up',
    rawPath: '/scheduled/moov-status-catch-up',
    requestContext: { http: { method: 'POST' } },
    phase: 'plan',
    actor_application_user_id: ACTOR,
    limit: 50,
  });
  assert.equal(isMoovStatusCatchUpInvocation(call.event), true);
  assert.deepEqual(parseCatchUpRequest(call.event), { ok: true, phase: 'plan', actorId: ACTOR, limit: 50 });

  const failed = fakeInvoke({ plan: { ok: false, error: 'catch_up_actor_not_platform_owner' } });
  assert.equal((await run(planEnv(), { invoke: failed.invoke })).code, 1);
});

test('apply: plans again, applies only when the fresh plan is the reviewed one, with the owner\'s phrase verbatim', async () => {
  const fake = fakeInvoke();
  const { code, result } = await run(applyEnv(), { invoke: fake.invoke });
  assert.equal(code, 0);
  assert.deepEqual(fake.calls.map((c) => c.event.phase), ['plan', 'apply']);
  const applyEvent = fake.calls[1].event;
  assert.equal(fake.calls[1].functionName, FUNCTION_NAME);
  assert.equal(applyEvent.approval_statement, applyPhrase(MANIFEST));
  assert.equal(applyEvent.manifest_sha256, MANIFEST);
  assert.deepEqual(applyEvent.transfer_ids, SORTED_IDS);
  assert.equal(applyEvent.limit, 50);
  assert.equal(isMoovStatusCatchUpInvocation(applyEvent), true);
  const parsed = parseCatchUpRequest(applyEvent);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.phase, 'apply');
  assert.equal(parsed.statement, applyPhrase(MANIFEST));
  assert.equal(result.fresh_plan.manifest_sha256, MANIFEST);
  assert.equal(result.apply.ok, true);

  const failedApply = fakeInvoke({ apply: { ok: false, error: 'catch_up_outcome_differs_from_plan', stopped_at: IDS[0] } });
  assert.equal((await run(applyEnv(), { invoke: failedApply.invoke })).code, 1);
});

test('apply never invokes the apply phase when the database or Moov moved, the plan is truncated, or the inputs are incomplete', async () => {
  const cases = [
    [planAnswer({ manifest_sha256: 'c'.repeat(64) }), 'catch_up_plan_changed'],
    [planAnswer({ transfer_ids: [SORTED_IDS[0]] }), 'transfer_ids_differ_from_reviewed_plan'],
    [planAnswer({ transfer_ids: [...SORTED_IDS, 'extra-transfer'] }), 'transfer_ids_differ_from_reviewed_plan'],
    [planAnswer({ truncated: true }), 'fresh_plan_truncated'],
    [planAnswer({ moov_unavailable: true }), 'fresh_plan_moov_unavailable'],
    [planAnswer({ environment: 'sandbox' }), 'fresh_plan_failed'],
    [{ ok: false, error: 'catch_up_failed' }, 'fresh_plan_failed'],
  ];
  for (const [plan, error] of cases) {
    const fake = fakeInvoke({ plan });
    const { code, result } = await run(applyEnv(), { invoke: fake.invoke });
    assert.equal(code, 1, error);
    assert.equal(result.error, error);
    assert.equal(result.apply_invoked, false);
    assert.deepEqual(fake.calls.map((c) => c.event.phase), ['plan'], error);
  }
  for (const env of [
    applyEnv({ CHECKSOPS_CATCH_UP_APPROVAL_PHRASE: '' }),
    applyEnv({ CHECKSOPS_CATCH_UP_APPROVAL_PHRASE: CATCH_UP_PLAN_STATEMENT }),
    applyEnv({ CHECKSOPS_CATCH_UP_MANIFEST_SHA256: '' }),
    applyEnv({ CHECKSOPS_CATCH_UP_TRANSFER_IDS: '' }),
  ]) {
    const fake = fakeInvoke();
    const { code } = await run(env, { invoke: fake.invoke });
    assert.equal(code, 2);
    assert.equal(fake.calls.length, 0);
  }
  // The same limit as the reviewed plan, or the manifest (which records the limit) differs.
  const fake = fakeInvoke({ plan: planAnswer({ manifest: { environment: 'production', limit: 60, entries: [] } }) });
  const res = await run(applyEnv({ CHECKSOPS_CATCH_UP_LIMIT: '50' }), { invoke: fake.invoke });
  assert.equal(res.result.error, 'apply_event_differs_from_inputs');
  assert.equal(fake.calls.length, 1);
  assert.deepEqual(compareWithReviewedPlan(planAnswer(), { manifestSha256: MANIFEST, transferIds: SORTED_IDS }), { ok: true });
});

test('main prints the Lambda JSON and appends it to the step summary', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moov-catch-up-'));
  try {
    const summary = path.join(dir, 'summary.md');
    const fake = fakeInvoke();
    const writes = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk) => { writes.push(String(chunk)); return true; };
    let code;
    try {
      code = await main({ ...planEnv(), GITHUB_STEP_SUMMARY: summary }, { invoke: fake.invoke });
    } finally {
      process.stdout.write = original;
    }
    assert.equal(code, 0);
    assert.equal(JSON.parse(writes.join('')).manifest_sha256, MANIFEST);
    assert.match(fs.readFileSync(summary, 'utf8'), /### Moov status catch-up \(plan\)[\s\S]*"manifest_sha256": "a{64}"/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the owner README and the runbook name the role, the variable, the commands and the phrase', () => {
  const readme = read(`${DIR}/README.md`);
  assert.match(readme, new RegExp(`aws iam create-role --role-name ${ROLE_NAME}`));
  assert.match(readme, new RegExp(`aws iam put-role-policy --role-name ${ROLE_NAME}`));
  assert.match(readme, /--assume-role-policy-document file:\/\/ops\/deployment-guard\/production-moov-status-catch-up\/trust-policy\.json/);
  assert.match(readme, /--policy-document file:\/\/ops\/deployment-guard\/production-moov-status-catch-up\/permissions-policy\.json/);
  assert.ok(readme.includes(ROLE_ARN_VARIABLE));
  assert.ok(readme.includes(ROLE_ARN));
  const runbook = read('ops/moov-status-catch-up.md');
  assert.ok(runbook.includes(WORKFLOW_FILE));
  assert.ok(runbook.includes(ROLE_NAME));
  assert.match(runbook, /apply the Moov catch-up plan <manifest_sha256> in production/);
});

test('the owner fix command: a self-contained heredoc of exactly permissions-policy.json and one put-role-policy, in the README and the runbook', () => {
  const policyText = read(`${DIR}/permissions-policy.json`);
  const block = "```bash\ncat > /tmp/catchup-permissions.json <<'EOF'\n"
    + policyText
    + 'EOF\n'
    + `aws iam put-role-policy --no-cli-pager --role-name ${ROLE_NAME} --policy-name ChecksOpsProductionMoovStatusCatchUp --policy-document file:///tmp/catchup-permissions.json\n`
    + '```\n';
  for (const rel of [`${DIR}/README.md`, 'ops/moov-status-catch-up.md']) {
    const doc = read(rel);
    assert.ok(doc.includes(block), rel);
    assert.ok(doc.includes('42383055459'), rel);
    assert.ok(doc.includes(`${FUNCTION_ARN}:$LATEST with an`), rel);
  }
});

#!/usr/bin/env node
/**
 * GitHub-hosted guarded environment-variable preflight for the shared API Lambdas
 * (checksops-staging-api, checksops-production-prep-api).
 *
 * inspect: read the live configuration and report the state of every key the plan
 *          section lists (ops/deployment-guard/lambda-config-plan.json). Never writes
 *          AWS. With an empty section it reports PENDING_PLAN and the live variable
 *          names (never values), which is what the plan author needs.
 * apply:   same checks, then requires the live RevisionId from a prior inspect, the
 *          exact approval phrase (and for production a staging acceptance reference),
 *          takes the lease and issues a KMS-signed receipt owning the plan change's
 *          SHA-256 for lambda-config-apply.mjs, the only writer.
 * verify:  the live variables equal the plan's intended values.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CODES, GuardError } from './lib/errors.mjs';
import { acquireLease } from './lib/lease.mjs';
import { issueReceiptWithSigner } from './lib/receipt.mjs';
import { signReceiptWithKms } from './lib/kms-issuer.mjs';
import {
  CONFIG_DEPLOYMENT_TYPE,
  CONFIG_FUNCTIONS,
  changeCount,
  changeSha256,
  configurationSha256,
  environmentComponent,
  evaluateConfigChange,
  liveVariablesOf,
  loadConfigPlan,
} from './lib/lambda-config.mjs';
import { LOCAL_STATE_DIR } from './lib/paths.mjs';

const REGION = 'us-east-1';
const STAGING_ACCEPTANCE_RE = /^https:\/\/github\.com\/michaelcarletta-cmd\/ChecksOps\/(actions\/runs\/\d+(\/job\/\d+)?|pull\/\d+)$/;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function approvalPhrase(environment) {
  return `APPLY API CONFIGURATION TO ${String(environment).toUpperCase()}`;
}

export function resolveEnvironment(value) {
  const environment = String(value || '').trim();
  if (!CONFIG_FUNCTIONS[environment]) {
    throw new GuardError(CODES.INVALID_MANIFEST, 'config environment must be staging or production', { environment });
  }
  return { environment, functionName: CONFIG_FUNCTIONS[environment] };
}

export function workflowIdentity(env = process.env, environment) {
  const commit = String(env.GITHUB_SHA || '').trim();
  const branch = String(env.GITHUB_REF_NAME || '').trim();
  const actor = String(env.GITHUB_ACTOR || '').trim();
  const runId = String(env.GITHUB_RUN_ID || '').trim();
  if (!/^[0-9a-f]{40}$/.test(commit) || !branch || !actor || !runId) {
    throw new GuardError(CODES.ANONYMOUS_DEPLOYMENT, 'GitHub workflow identity is incomplete');
  }
  if (branch !== 'main') {
    throw new GuardError(CODES.UNRELATED_MUTATION, 'guarded config change may only run from main', { branch });
  }
  return { commit, branch, operator: actor, workstreamId: `github-${environment}-config-${runId}` };
}

export function validateApplyInputs({ environment, approval, stagingAcceptance, expectedLiveRevisionId, liveRevisionId }) {
  if (approval !== approvalPhrase(environment)) {
    throw new GuardError(CODES.PRODUCTION_APPROVAL_REQUIRED, 'config apply requires the exact approval phrase', { expected: approvalPhrase(environment) });
  }
  if (environment === 'production' && !STAGING_ACCEPTANCE_RE.test(String(stagingAcceptance || ''))) {
    throw new GuardError(CODES.PRODUCTION_APPROVAL_REQUIRED, 'production config change requires a staging acceptance reference (a ChecksOps GitHub run or PR URL)');
  }
  const expected = String(expectedLiveRevisionId || '').trim();
  if (!expected) {
    throw new GuardError(CODES.INVALID_MANIFEST, 'config apply requires expected_live_revision_id from a prior inspect run');
  }
  if (expected !== liveRevisionId) {
    throw new GuardError(CODES.DEPLOYMENT_COLLISION, 'live Lambda changed since the inspect run', { expected_live_revision_id: expected, actual_live_revision_id: liveRevisionId });
  }
}

export async function inspectLive(functionName, { lambda = null, loadSdk = (specifier) => import(specifier) } = {}) {
  let client = lambda;
  let command;
  if (!client) {
    const sdk = await loadSdk('@aws-sdk/client-lambda');
    client = new sdk.LambdaClient({ region: REGION });
    command = new sdk.GetFunctionConfigurationCommand({ FunctionName: functionName });
  } else {
    command = { operation: 'GetFunctionConfiguration', input: { FunctionName: functionName } };
  }
  const configuration = await client.send(command);
  const codeSha256 = configuration?.CodeSha256 || null;
  const revisionId = configuration?.RevisionId || null;
  if (!codeSha256 || !revisionId) {
    throw new GuardError(CODES.DEPLOYMENT_COLLISION, 'live Lambda fingerprint is incomplete');
  }
  const variables = liveVariablesOf(configuration);
  if (!variables.ok) throw new GuardError(variables.code, variables.message, variables.details);
  return { functionName, codeSha256, revisionId, configuration, configurationSha256: configurationSha256(configuration), variables: variables.details.variables };
}

function appendGithubOutput(values, env = process.env) {
  const file = env.GITHUB_OUTPUT;
  if (!file) return;
  fs.appendFileSync(file, `${Object.entries(values).map(([key, value]) => `${key}=${String(value)}`).join('\n')}\n`);
}

function writeState(root, name, data) {
  const dir = path.join(root, LOCAL_STATE_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, data);
  return file;
}

export async function run(env = process.env, deps = {}) {
  const root = deps.root || repoRoot;
  const mode = String(env.CHECKSOPS_CONFIG_MODE || 'inspect').trim();
  if (!['inspect', 'apply', 'verify'].includes(mode)) {
    throw new GuardError(CODES.INVALID_MANIFEST, 'mode must be inspect, apply or verify');
  }
  const { environment, functionName } = resolveEnvironment(env.CHECKSOPS_CONFIG_ENVIRONMENT);
  const identity = workflowIdentity(env, environment);
  const row = deps.plan || loadConfigPlan(root, environment);
  const plan = { environments: { [environment]: row } };
  const live = await (deps.inspectLive || inspectLive)(functionName, deps);

  const summary = {
    environment,
    function_name: functionName,
    live_code_sha256: live.codeSha256,
    live_revision_id: live.revisionId,
    live_configuration_sha256: live.configurationSha256,
    live_variable_count: Object.keys(live.variables).length,
    change_count: changeCount(row),
    change_sha256: changeCount(row) ? changeSha256(row) : '',
  };

  if (changeCount(row) === 0) {
    if (mode !== 'inspect') {
      throw new GuardError(CODES.INVALID_MANIFEST, 'config plan section lists no change; fill it from an inspect run first', { environment });
    }
    const names = Object.keys(live.variables).sort();
    const diffFile = writeState(root, `config-diff-${environment}.json`, `${JSON.stringify({ ...summary, state: 'PENDING_PLAN', live_variable_names: names, changes: [] }, null, 2)}\n`);
    appendGithubOutput({ ...summary, state: 'PENDING_PLAN', diff_file: diffFile, problem_count: 0 }, env);
    return { ok: true, mode, identity, ...summary, state: 'PENDING_PLAN', live_variable_names: names, changes: [], mutation: false };
  }

  const evaluation = evaluateConfigChange({ plan, environment, liveVariables: live.variables });
  if (!evaluation.ok && evaluation.code !== CODES.DEPLOYMENT_COLLISION) {
    throw new GuardError(evaluation.code, evaluation.message, evaluation.details);
  }
  const changes = evaluation.ok ? evaluation.details.changes : evaluation.details.changes;
  const problems = evaluation.ok ? [] : evaluation.details.problems;
  let state = evaluation.ok ? evaluation.details.state : 'BLOCKED';

  if (mode === 'verify') {
    if (!evaluation.ok || evaluation.details.state !== 'ALREADY_ACCEPTED') {
      throw new GuardError(CODES.DEPLOYMENT_COLLISION, 'post-apply live environment does not hold every intended value', { changes, problems });
    }
    state = 'VERIFIED';
    appendGithubOutput({ ...summary, state }, env);
    return { ok: true, mode, identity, ...summary, state, changes, mutation: false };
  }

  const diffFile = writeState(root, `config-diff-${environment}.json`, `${JSON.stringify({ ...summary, state, problems, changes }, null, 2)}\n`);
  appendGithubOutput({ ...summary, state, diff_file: diffFile, problem_count: problems.length }, env);

  if (mode === 'inspect') {
    return { ok: true, mode, identity, ...summary, state, problems, changes, mutation: false };
  }
  if (!evaluation.ok) throw new GuardError(evaluation.code, evaluation.message, evaluation.details);
  if (state === 'ALREADY_ACCEPTED') {
    throw new GuardError(CODES.UNRELATED_MUTATION, 'live environment already holds every intended value; nothing to apply');
  }

  validateApplyInputs({
    environment,
    approval: env.CHECKSOPS_CONFIG_APPROVAL,
    stagingAcceptance: env.CHECKSOPS_STAGING_ACCEPTANCE_REFERENCE,
    expectedLiveRevisionId: env.CHECKSOPS_EXPECTED_LIVE_REVISION_ID,
    liveRevisionId: live.revisionId,
  });
  const fingerprint = { codeSha256: live.codeSha256, revisionId: live.revisionId };
  const approval = { approved: true, workstream_id: identity.workstreamId, phrase: approvalPhrase(environment), approver: identity.operator };
  const stagingAcceptance = environment === 'production'
    ? { ok: true, reference: String(env.CHECKSOPS_STAGING_ACCEPTANCE_REFERENCE) }
    : { ok: true, reference: 'staging-is-the-acceptance-environment' };

  const lease = (deps.acquireLease || acquireLease)(root, {
    workstream_id: identity.workstreamId,
    component: functionName,
    environment,
    commit: identity.commit,
    operator: identity.operator,
  });
  if (!lease.ok) throw new GuardError(lease.code, lease.message, lease.details || {});

  const component = environmentComponent(summary.change_sha256);
  const issued = (deps.issueReceipt || issueReceiptWithSigner)(root, {
    workstream_id: identity.workstreamId,
    branch: identity.branch,
    commit: identity.commit,
    operator: identity.operator,
    target_environment: environment,
    target_component: functionName,
    deployment_type: CONFIG_DEPLOYMENT_TYPE,
    owned_components: [component],
    preflight_live_fingerprint: fingerprint,
    production_fingerprint: fingerprint,
    immediately_before_fingerprint: fingerprint,
    staging_acceptance: stagingAcceptance,
    approval,
    lease: lease.details.lease,
  }, deps.signer || ((unsigned) => signReceiptWithKms(unsigned, { env })));
  if (!issued.ok) throw new GuardError(issued.code, issued.message, issued.details || {});

  const inputPath = writeState(root, `github-${environment}-config-input.json`, JSON.stringify({
    workstream_id: identity.workstreamId,
    branch: identity.branch,
    commit: identity.commit,
    operator: identity.operator,
    target_environment: environment,
    target_component: functionName,
    function_name: functionName,
    receipt_path: issued.details.file,
    change_sha256: summary.change_sha256,
    staging_acceptance: stagingAcceptance,
    approval,
  }, null, 2));

  appendGithubOutput({ config_input: inputPath, receipt_path: issued.details.file, workstream_id: identity.workstreamId }, env);
  return {
    ok: true,
    mode,
    identity,
    ...summary,
    state,
    changes,
    mutation: false,
    authorization: { lease: lease.details.lease, receiptFile: issued.details.file, configInput: inputPath },
  };
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  run().then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }).catch((error) => {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      code: error?.code || CODES.DEPLOYMENT_COLLISION,
      message: error?.message || String(error),
      details: error?.details || {},
    }, null, 2)}\n`);
    process.exitCode = 2;
  });
}

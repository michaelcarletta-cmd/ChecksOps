#!/usr/bin/env node
/**
 * GitHub-hosted preflight for the staging VPC SQL executor.
 *
 * inspect: compare the live executor package with the one main would deploy.
 * deploy:  the same check, then allow the official sql-executor-ensure.mjs
 *          only when every live member is equal or superseded by main.
 * apply:   require the live executor to carry exactly main's package, run the
 *          accepted contracts, evaluate, lease, and issue a KMS-signed
 *          sql-executor-invoke receipt for the official sql-executor-invoke.mjs.
 *
 * This script never deploys, invokes the executor, or applies SQL itself.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadContractRegistry, relevantContracts } from './lib/contracts.mjs';
import { CODES, GuardError } from './lib/errors.mjs';
import { evaluateDeployment } from './lib/guard.mjs';
import { signReceiptWithKms } from './lib/kms-issuer.mjs';
import { acquireLease } from './lib/lease.mjs';
import { issueReceiptWithSigner } from './lib/receipt.mjs';
import {
  AUTHORIZED_LEDGER_20261007193200,
  AUTHORIZED_SQL71_AMOUNT_GRANT,
  SQL_EXECUTOR_COMPONENT,
  SQL_EXECUTOR_DEPLOYMENT_TYPE,
  SQL_EXECUTOR_FUNCTION,
  authorizationFingerprint,
} from './lib/sql-executor-auth.mjs';
import {
  environmentMatches,
  lambdaCodeSha256,
  reconcileExecutorMembers,
  sourceMemberHashes,
} from './lib/sql-executor-inventory.mjs';
import { readZipMembers } from './lib/zip-members.mjs';
import { EXECUTOR_PACK_MEMBERS, executorEnvironment } from './sql-executor-ensure.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TARGET_ENVIRONMENT = 'staging';
const REHEARSAL_FUNCTION = 'checksops-staging-rehearsal-oneshot';
const RECEIPT_TTL_MS = 15 * 60 * 1000;

// Workflow choice value → allowlisted pin. Only reviewed pins may appear here.
export const MIGRATIONS = Object.freeze({
  'ledger-20261007193200': AUTHORIZED_LEDGER_20261007193200,
  'sql71-review-amount-grant': AUTHORIZED_SQL71_AMOUNT_GRANT,
});

const LAMBDA_CODE_SHA_RE = /^[A-Za-z0-9+/]{43}=$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

export function workflowIdentity(env = process.env) {
  const commit = String(env.GITHUB_SHA || '').trim();
  const branch = String(env.GITHUB_REF_NAME || '').trim();
  const actor = String(env.GITHUB_ACTOR || '').trim();
  const runId = String(env.GITHUB_RUN_ID || '').trim();
  const attempt = String(env.GITHUB_RUN_ATTEMPT || '1').trim();
  if (!/^[0-9a-f]{40}$/.test(commit) || !branch || !actor || !/^[0-9]+$/.test(runId) || !/^[0-9]+$/.test(attempt)) {
    throw new GuardError(CODES.ANONYMOUS_DEPLOYMENT, 'GitHub workflow identity is incomplete');
  }
  if (branch !== 'main') {
    throw new GuardError(CODES.UNRELATED_MUTATION, 'guarded staging SQL executor workflow may only run from main', { branch });
  }
  return {
    commit,
    branch,
    operator: actor,
    workstreamId: `github-staging-sql-${runId}`,
    oneUseId: `github-staging-sql-${runId}-${attempt}`,
  };
}

/** Candidate source members are the repo files sql-executor-ensure.mjs packs, by member path. */
export function candidateMembers(root = repoRoot) {
  const members = {};
  const sourceOf = {};
  for (const [from, to] of EXECUTOR_PACK_MEMBERS) {
    members[to] = sha256(fs.readFileSync(path.join(root, from)));
    sourceOf[to] = from;
  }
  return { members, sourceOf };
}

/** Every SHA-256 the source path had on main's history. A shallow clone fails closed. */
export function gitHistory(root = repoRoot) {
  const cache = new Map();
  return (source) => {
    if (cache.has(source)) return cache.get(source);
    const shas = new Set();
    const log = spawnSync('git', ['log', '--format=%H', 'HEAD', '--', source], { cwd: root, encoding: 'utf8' });
    for (const commit of String(log.stdout || '').split('\n').filter(Boolean)) {
      const blob = spawnSync('git', ['show', `${commit}:${source}`], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
      if (blob.status === 0) shas.add(sha256(blob.stdout));
    }
    cache.set(source, shas);
    return shas;
  };
}

function awsJson(args, env) {
  const out = execFileSync('aws', ['--region', 'us-east-1', '--output', 'json', ...args], { encoding: 'utf8', env });
  return out.trim() ? JSON.parse(out) : {};
}

export const defaultAws = {
  getConfig(name, env) {
    return awsJson(['lambda', 'get-function-configuration', '--function-name', name], env);
  },
  async getCodeZip(env) {
    const fn = awsJson(['lambda', 'get-function', '--function-name', SQL_EXECUTOR_FUNCTION], env);
    const url = fn?.Code?.Location;
    if (!url) throw new GuardError(CODES.DEPLOYMENT_COLLISION, 'live executor code location is missing');
    const response = await fetch(url);
    if (!response.ok) throw new GuardError(CODES.DEPLOYMENT_COLLISION, `live executor download failed (${response.status})`);
    return { zip: Buffer.from(await response.arrayBuffer()), codeSha256: fn?.Configuration?.CodeSha256 };
  },
};

function appendGithubOutput(values, env = process.env) {
  const file = env.GITHUB_OUTPUT;
  if (!file) return;
  const lines = Object.entries(values).map(([key, value]) => `${key}=${String(value)}`).join('\n');
  fs.appendFileSync(file, `${lines}\n`);
}

const defaultContractRunner = (testPath) => {
  const args = testPath.endsWith('.test.mjs') ? ['--experimental-strip-types', '--test', testPath] : [testPath];
  return spawnSync(process.execPath, args, { cwd: repoRoot, encoding: 'utf8', stdio: 'inherit' }).status === 0;
};

/** Execute every accepted contract for a staging sql-executor-invoke; a missing test fails. */
export function runContractTests(registry, { runner = defaultContractRunner } = {}) {
  const results = {};
  for (const contract of relevantContracts(registry, {
    environment: TARGET_ENVIRONMENT,
    component: SQL_EXECUTOR_COMPONENT,
    deployment_type: SQL_EXECUTOR_DEPLOYMENT_TYPE,
  })) {
    if (contract.accepted !== true) continue;
    const testPath = String(contract.test || '');
    if (!testPath || !fs.existsSync(path.join(repoRoot, testPath))) {
      results[contract.id] = { ok: false, reason: 'contract test file is missing', test: testPath || null };
      continue;
    }
    results[contract.id] = runner(testPath) === true ? { ok: true, test: testPath } : { ok: false, test: testPath };
  }
  return results;
}

export function buildInvokeInput(identity, pin, { now, contractResults, buildTimestamp }) {
  const input = {
    action: 'apply',
    workstream_id: identity.workstreamId,
    branch: identity.branch,
    // The executor allowlist binds each pin to the commit that authored the file.
    commit: pin.commit,
    operator: identity.operator,
    target_environment: TARGET_ENVIRONMENT,
    target_component: SQL_EXECUTOR_COMPONENT,
    deployment_type: SQL_EXECUTOR_DEPLOYMENT_TYPE,
    owned_components: [pin.filename],
    filename: pin.filename,
    migration_id: pin.migration_id,
    source_sha256: pin.source_sha256,
    intended_replacement_sha256: pin.intended_replacement_sha256,
    expected_live_definition_sha256: pin.expected_live_definition_sha256,
    one_use_id: identity.oneUseId,
    expiry: new Date(now + RECEIPT_TTL_MS).toISOString(),
    function_name: SQL_EXECUTOR_FUNCTION,
    build_timestamp: buildTimestamp,
    contract_results: contractResults,
    workflow_commit: identity.commit,
  };
  input.preflight_live_fingerprint = authorizationFingerprint(input);
  return input;
}

export async function run(env = process.env, deps = {}) {
  const mode = String(env.CHECKSOPS_SQL_EXECUTOR_MODE || 'inspect').trim();
  if (!['inspect', 'deploy', 'apply'].includes(mode)) {
    throw new GuardError(CODES.INVALID_MANIFEST, 'mode must be inspect, deploy, or apply');
  }
  const migrationKey = String(env.CHECKSOPS_SQL_EXECUTOR_MIGRATION || '').trim();
  const pin = Object.prototype.hasOwnProperty.call(MIGRATIONS, migrationKey) ? MIGRATIONS[migrationKey] : null;
  if (!pin) throw new GuardError(CODES.SQL_COLLISION, 'migration is not an allowlisted staging executor pin', { migration: migrationKey });

  const identity = workflowIdentity(env);
  const root = deps.root || repoRoot;
  const aws = deps.aws || defaultAws;
  const now = deps.now ? deps.now() : Date.now();

  const config = aws.getConfig(SQL_EXECUTOR_FUNCTION, env);
  const { zip, codeSha256 } = await aws.getCodeZip(env);
  if (!LAMBDA_CODE_SHA_RE.test(String(config.CodeSha256 || ''))) {
    throw new GuardError(CODES.DEPLOYMENT_COLLISION, 'live executor CodeSha256 is missing');
  }
  if (lambdaCodeSha256(zip) !== config.CodeSha256 || (codeSha256 && codeSha256 !== config.CodeSha256)) {
    throw new GuardError(CODES.DEPLOYMENT_COLLISION, 'live executor changed while it was being read');
  }
  const live = sourceMemberHashes(readZipMembers(zip));
  const candidate = deps.candidate || candidateMembers(repoRoot);
  const reconcile = reconcileExecutorMembers({
    live,
    candidate: candidate.members,
    sourceOf: candidate.sourceOf,
    historyOf: deps.historyOf || gitHistory(repoRoot),
  });
  const summary = reconcile.details || {};
  appendGithubOutput({
    live_code_sha256: config.CodeSha256,
    live_revision_id: config.RevisionId || '',
    live_last_modified: config.LastModified || '',
    executor_current: summary.current === true,
    superseded_members: (summary.superseded || []).join(' '),
    added_members: (summary.added || []).join(' '),
  }, env);
  const report = {
    mode,
    migration: migrationKey,
    identity,
    live_executor: { code_sha256: config.CodeSha256, revision_id: config.RevisionId, last_modified: config.LastModified },
    inventory: summary,
  };
  if (!reconcile.ok) throw new GuardError(reconcile.code, reconcile.message, summary);

  if (mode === 'inspect') {
    if (env.CHECKSOPS_REQUIRE_EXECUTOR_CURRENT === '1' && summary.current !== true) {
      throw new GuardError(CODES.STALE_PACKAGE, 'live executor does not carry main\'s package', summary);
    }
    return { ok: true, ...report, mutation: false };
  }

  if (String(env.CHECKSOPS_EXPECTED_EXECUTOR_CODE_SHA256 || '') !== config.CodeSha256) {
    throw new GuardError(CODES.DEPLOYMENT_COLLISION, 'live executor CodeSha256 differs from the inspected value', {
      expected: env.CHECKSOPS_EXPECTED_EXECUTOR_CODE_SHA256 || null,
      live: config.CodeSha256,
    });
  }

  if (mode === 'deploy') {
    if (summary.current === true) {
      throw new GuardError(CODES.STALE_PACKAGE, 'live executor already carries main\'s package; nothing to deploy');
    }
    const intended = executorEnvironment(aws.getConfig(REHEARSAL_FUNCTION, env));
    const environment = environmentMatches(config.Environment, intended);
    if (!environment.ok) throw new GuardError(environment.code, environment.message, environment.details);
    return { ok: true, ...report, deploy_allowed: true, mutation: false };
  }

  // apply
  if (summary.current !== true) {
    throw new GuardError(CODES.STALE_PACKAGE, 'deploy main\'s executor before apply; the live executor lacks this handler', summary);
  }
  const expectedLive = String(env.CHECKSOPS_EXPECTED_LIVE_DEFINITION_SHA256 || '');
  if (!SHA256_RE.test(expectedLive) || expectedLive !== pin.expected_live_definition_sha256) {
    throw new GuardError(CODES.DEPLOYMENT_COLLISION, 'expected live definition must be the pinned pre-apply definition from a fresh staging inspect', {
      provided: expectedLive || null,
      pinned: pin.expected_live_definition_sha256,
    });
  }
  const registry = deps.registry || loadContractRegistry(repoRoot);
  const contractResults = runContractTests(registry, { runner: deps.contractRunner });
  const input = buildInvokeInput(identity, pin, {
    now,
    contractResults,
    buildTimestamp: env.CHECKSOPS_BUILD_TIMESTAMP || new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z'),
  });
  const evaluated = evaluateDeployment(input, { root: repoRoot, env, registry });
  if (!evaluated.ok) {
    throw new GuardError(evaluated.code || CODES.DEPLOYMENT_GUARD_REQUIRED, evaluated.message || 'sql-executor-invoke evaluation failed', {
      errors: evaluated.errors || [],
    });
  }
  const lease = acquireLease(root, {
    workstream_id: input.workstream_id,
    component: SQL_EXECUTOR_COMPONENT,
    environment: TARGET_ENVIRONMENT,
    commit: input.commit,
    operator: input.operator,
  });
  if (!lease.ok) throw new GuardError(lease.code, lease.message, lease.details || {});
  const signer = deps.signer || ((unsigned) => signReceiptWithKms(unsigned, { env }));
  const issued = issueReceiptWithSigner(root, { ...input, lease: lease.details.lease }, signer);
  if (!issued.ok) throw new GuardError(issued.code, issued.message, issued.details || {});

  const inputFile = path.join(root, '.deployment-guard', 'sql-executor-input.json');
  fs.mkdirSync(path.dirname(inputFile), { recursive: true });
  fs.writeFileSync(inputFile, `${JSON.stringify(input, null, 2)}\n`);
  appendGithubOutput({
    receipt_path: issued.details.file,
    input_path: inputFile,
    workstream_id: input.workstream_id,
    pin_commit: input.commit,
    one_use_id: input.one_use_id,
  }, env);
  return {
    ok: true,
    ...report,
    contracts: contractResults,
    mutation: false,
    authorization: { lease: lease.details.lease, receiptFile: issued.details.file, inputFile },
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

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
 * read-live: like apply, but the receipt and invoke input are bound to the
 *          executor's read-only action 'inspect' (see lib/sql-executor-read-live.mjs).
 *          It reads the pinned migration's live database state and never writes.
 *          It neither requires nor accepts CHECKSOPS_EXPECTED_LIVE_DEFINITION_SHA256.
 *
 * This script never deploys, invokes the executor, or applies SQL itself.
 * `--read-live-report <invoke stdout> [<invoke stderr>]` prints only the
 * non-sensitive read-live fields of an invoke result.
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
  READ_LIVE_ACTION,
  READ_LIVE_EXPECTED_SENTINEL,
  readLiveSummary,
  readLiveSummaryMarkdown,
} from './lib/sql-executor-read-live.mjs';
import {
  AUTHORIZED_LEDGER_20261007193200,
  AUTHORIZED_SQL71_AMOUNT_GRANT,
  AUTHORIZED_SQL72_MEMBER_PAYMENT_WRITES,
  AUTHORIZED_SQL76_PARTNERSHIP_CONSENT,
  AUTHORIZED_SQL77_CHECK_STAKEHOLDERS_GRANT,
  AUTHORIZED_SQL78_PARTNER_STAKEHOLDER_REMOVALS,
  AUTHORIZED_SQL79_MEMBER_STAKEHOLDER_WRITES,
  AUTHORIZED_SQL80_CHECKALT_MEMBER_AUTO_DEPOSIT,
  AUTHORIZED_SQL81_CHECKALT_PRODUCTION_REGISTER,
  AUTHORIZED_SQL82_HOMEOWNER_LEDGER_VIEW,
  AUTHORIZED_SQL83_HOMEOWNER_SIGNING_CAPABILITIES,
  AUTHORIZED_SQL84_MORTGAGE_RETURN_TO_QUEUE,
  AUTHORIZED_SQL85_MORTGAGE_COMPENSATION_ADJUST,
  AUTHORIZED_SQL86_MORTGAGE_COMPENSATION_OWNER_ONLY,
  AUTHORIZED_SQL87_RESOLVE_CHECK_CASE_TENANT_SCOPE,
  AUTHORIZED_SQL88_CLAIM_ID_ASSIGN_CASE_TENANT_SCOPE,
  AUTHORIZED_SQL89_CHECK_INTAKE_COLUMN_UPDATE,
  AUTHORIZED_SQL29_MORTGAGE_OPS_LIBRARY_PARITY,
  AUTHORIZED_SQL30_TENANT_DOCUMENTS_DOC_TYPE,
  RELEASE_2026_10_17_PENDING_SQL_PINS,
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
  'sql72-member-payment-writes': AUTHORIZED_SQL72_MEMBER_PAYMENT_WRITES,
  'sql76-tenant-partnership-consent': AUTHORIZED_SQL76_PARTNERSHIP_CONSENT,
  'sql77-check-stakeholders-grant': AUTHORIZED_SQL77_CHECK_STAKEHOLDERS_GRANT,
  'sql78-check-partner-stakeholder-removals': AUTHORIZED_SQL78_PARTNER_STAKEHOLDER_REMOVALS,
  'sql79-member-stakeholder-writes': AUTHORIZED_SQL79_MEMBER_STAKEHOLDER_WRITES,
  'sql80-checkalt-member-auto-deposit': AUTHORIZED_SQL80_CHECKALT_MEMBER_AUTO_DEPOSIT,
  'sql81-checkalt-depositor-register': AUTHORIZED_SQL81_CHECKALT_PRODUCTION_REGISTER,
  'sql82-homeowner-ledger-view': AUTHORIZED_SQL82_HOMEOWNER_LEDGER_VIEW,
  'sql83-homeowner-signing-capabilities': AUTHORIZED_SQL83_HOMEOWNER_SIGNING_CAPABILITIES,
  'sql84-mortgage-return-to-queue': AUTHORIZED_SQL84_MORTGAGE_RETURN_TO_QUEUE,
  'sql85-mortgage-compensation-adjust': AUTHORIZED_SQL85_MORTGAGE_COMPENSATION_ADJUST,
  'sql86-mortgage-compensation-owner-only': AUTHORIZED_SQL86_MORTGAGE_COMPENSATION_OWNER_ONLY,
  'sql87-resolve-check-case-tenant-scope': AUTHORIZED_SQL87_RESOLVE_CHECK_CASE_TENANT_SCOPE,
  'sql88-claim-id-assign-case-tenant-scope': AUTHORIZED_SQL88_CLAIM_ID_ASSIGN_CASE_TENANT_SCOPE,
  'sql89-check-intake-column-update': AUTHORIZED_SQL89_CHECK_INTAKE_COLUMN_UPDATE,
  'sql29-mortgage-ops-library-parity': AUTHORIZED_SQL29_MORTGAGE_OPS_LIBRARY_PARITY,
  'sql30-tenant-documents-doc-type': AUTHORIZED_SQL30_TENANT_DOCUMENTS_DOC_TYPE,
  // Release 2026-10-17 (lib/release-sql-specs.mjs choice names).
  'sql90-users-only-tenant-roles': RELEASE_2026_10_17_PENDING_SQL_PINS.sql90,
  'sql91-moov-onboarding': RELEASE_2026_10_17_PENDING_SQL_PINS.sql91,
  'sql92-signature-request-check-files-link-grant': RELEASE_2026_10_17_PENDING_SQL_PINS.sql92,
  'sql93-tenant-company-info': RELEASE_2026_10_17_PENDING_SQL_PINS.sql93,
  'sql94-document-library-restore': RELEASE_2026_10_17_PENDING_SQL_PINS.sql94,
  'sql95-remove-freedom-claims-bridge': RELEASE_2026_10_17_PENDING_SQL_PINS.sql95,
  'sql96-platform-owner-tenant-pricing': RELEASE_2026_10_17_PENDING_SQL_PINS.sql96,
  'sql97-financial-stepup-log-server-writer': RELEASE_2026_10_17_PENDING_SQL_PINS.sql97,
  'sql98-tenant-fee-collection': RELEASE_2026_10_17_PENDING_SQL_PINS.sql98,
  'sql99-mortgage-desk-completion-messages': RELEASE_2026_10_17_PENDING_SQL_PINS.sql99,
  'sql100-mortgage-desk-live-access': RELEASE_2026_10_17_PENDING_SQL_PINS.sql100,
  'sql101-invite-identity-insert-order': RELEASE_2026_10_17_PENDING_SQL_PINS.sql101,
  'sql102-platform-owner-tenant-profile': RELEASE_2026_10_17_PENDING_SQL_PINS.sql102,
  'sql103-share-library-trigger-acl': RELEASE_2026_10_17_PENDING_SQL_PINS.sql103,
  'sql104-payment-idempotency-keys-grant': RELEASE_2026_10_17_PENDING_SQL_PINS.sql104,
  'sql105-onboarding-payment-table-grants': RELEASE_2026_10_17_PENDING_SQL_PINS.sql105,
  'sql106-financial-stepup-log-append-only': RELEASE_2026_10_17_PENDING_SQL_PINS.sql106,
  'sql108-check-intake-items-funds-type-values': RELEASE_2026_10_17_PENDING_SQL_PINS.sql108,
  'sql109-moov-transfer-webhook-status': RELEASE_2026_10_17_PENDING_SQL_PINS.sql109,
  'sql110-homeowner-preclaim-links': RELEASE_2026_10_17_PENDING_SQL_PINS.sql110,
  'sql111-tenant-referral-codes': RELEASE_2026_10_17_PENDING_SQL_PINS.sql111,
  'sql112-moov-invoice-table-grants': RELEASE_2026_10_17_PENDING_SQL_PINS.sql112,
  'sql113-payee-setup': RELEASE_2026_10_17_PENDING_SQL_PINS.sql113,
  'sql114-stakeholder-settings-update-grant': RELEASE_2026_10_17_PENDING_SQL_PINS.sql114,
  'sql115-provider-stakeholder-one-partner-payout': RELEASE_2026_10_17_PENDING_SQL_PINS.sql115,
  'sql116-moov-onboarding-profile-industry': RELEASE_2026_10_17_PENDING_SQL_PINS.sql116,
  'sql117-platform-owner-tenant-lifecycle': RELEASE_2026_10_17_PENDING_SQL_PINS.sql117,
  'sql118-platform-owner-tenant-lifecycle': RELEASE_2026_10_17_PENDING_SQL_PINS.sql118,
  'sql119-provider-stakeholder-sync-acl': RELEASE_2026_10_17_PENDING_SQL_PINS.sql119,
  'sql120-usage-events-at-approval-and-send': RELEASE_2026_10_17_PENDING_SQL_PINS.sql120,
  'sql121-cash-jobs-grants': RELEASE_2026_10_17_PENDING_SQL_PINS.sql121,
  'sql122-mortgage-desk-return-to-tenant': RELEASE_2026_10_17_PENDING_SQL_PINS.sql122,
  'sql123-checkalt-deposit-check-status': RELEASE_2026_10_17_PENDING_SQL_PINS.sql123,
  'sql124-mortgage-desk-signature-and-reads': RELEASE_2026_10_17_PENDING_SQL_PINS.sql124,
  'sql125-deposit-views-security-invoker': RELEASE_2026_10_17_PENDING_SQL_PINS.sql125,
  'sql126-definer-reads-caller-gates': RELEASE_2026_10_17_PENDING_SQL_PINS.sql126,
  'sql127-homeowner-portal-signing': RELEASE_2026_10_17_PENDING_SQL_PINS.sql127,
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

export const MODES = Object.freeze(['inspect', 'deploy', 'apply', 'read-live']);

export function buildInvokeInput(identity, pin, { now, contractResults, buildTimestamp, readLive = false }) {
  const input = {
    action: readLive ? READ_LIVE_ACTION : 'apply',
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
    // read-live: a sentinel no reviewed pin can equal, so this package can never pass an apply pin check.
    expected_live_definition_sha256: readLive ? READ_LIVE_EXPECTED_SENTINEL : pin.expected_live_definition_sha256,
    one_use_id: readLive ? `${identity.oneUseId}-read-live` : identity.oneUseId,
    expiry: new Date(now + RECEIPT_TTL_MS).toISOString(),
    function_name: SQL_EXECUTOR_FUNCTION,
    build_timestamp: buildTimestamp,
    contract_results: contractResults,
    workflow_commit: identity.commit,
  };
  // The signed receipt carries this fingerprint; for read-live it binds the action.
  input.preflight_live_fingerprint = readLive
    ? { ...authorizationFingerprint(input), action: READ_LIVE_ACTION }
    : authorizationFingerprint(input);
  return input;
}

export async function run(env = process.env, deps = {}) {
  const mode = String(env.CHECKSOPS_SQL_EXECUTOR_MODE || 'inspect').trim();
  if (!MODES.includes(mode)) {
    throw new GuardError(CODES.INVALID_MANIFEST, 'mode must be inspect, deploy, apply, or read-live');
  }
  if (mode === 'read-live' && String(env.CHECKSOPS_EXPECTED_LIVE_DEFINITION_SHA256 || '').trim()) {
    throw new GuardError(CODES.INVALID_MANIFEST, 'read-live does not accept an expected live definition; it only reports the live one');
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

  const expectedCode = String(env.CHECKSOPS_EXPECTED_EXECUTOR_CODE_SHA256 || '');
  // read-live requires main's exact package below; a prior inspect's CodeSha256 is optional but must match when given.
  if ((mode !== 'read-live' || expectedCode) && expectedCode !== config.CodeSha256) {
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

  // apply and read-live
  if (summary.current !== true) {
    throw new GuardError(CODES.STALE_PACKAGE, `deploy main's executor before ${mode}; the live executor lacks this handler`, summary);
  }
  const readLive = mode === 'read-live';
  const expectedLive = String(env.CHECKSOPS_EXPECTED_LIVE_DEFINITION_SHA256 || '');
  if (!readLive && (!SHA256_RE.test(expectedLive) || expectedLive !== pin.expected_live_definition_sha256)) {
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
    readLive,
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
    invoke_action: input.action,
  }, env);
  return {
    ok: true,
    ...report,
    invoke_action: input.action,
    contracts: contractResults,
    mutation: false,
    authorization: { lease: lease.details.lease, receiptFile: issued.details.file, inputFile },
  };
}

function parseJsonOutput(file) {
  if (!file || !fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, 'utf8').trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    try { return start >= 0 ? JSON.parse(text.slice(start)) : null; } catch { return null; }
  }
}

/**
 * Report a read-live invoke without echoing the executor's raw result. Prints a
 * `LIVE_DEFINITION_SHA256:` line, writes the step summary, and fails on any
 * invoke failure with only its code and message.
 */
export function reportReadLive(stdoutFile, stderrFile, env = process.env, write = (text) => process.stdout.write(text)) {
  const migration = String(env.CHECKSOPS_SQL_EXECUTOR_MIGRATION || '').trim();
  const pin = Object.prototype.hasOwnProperty.call(MIGRATIONS, migration) ? MIGRATIONS[migration] : null;
  if (!pin) throw new GuardError(CODES.SQL_COLLISION, 'migration is not an allowlisted staging executor pin', { migration });
  const result = parseJsonOutput(stdoutFile) || parseJsonOutput(stderrFile) || { ok: false, message: 'read-live invoke produced no result' };
  const summary = readLiveSummary(result, { migration, pin });
  if (!summary.ok) throw new GuardError(summary.code, summary.message, {});
  const details = summary.details;
  write(`${JSON.stringify(details, null, 2)}\n`);
  write(`LIVE_DEFINITION_SHA256: ${details.live_definition_sha256 ?? 'null'}\n`);
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `${readLiveSummaryMarkdown(details)}\n`);
  return details;
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
const reportIndex = process.argv.indexOf('--read-live-report');
if (isDirect && reportIndex >= 0) {
  try {
    reportReadLive(process.argv[reportIndex + 1], process.argv[reportIndex + 2]);
  } catch (error) {
    // Only GuardError messages are ours (fixed text); anything else could carry
    // driver or system detail.
    process.stderr.write(`${JSON.stringify({
      ok: false,
      code: error?.code || CODES.DEPLOYMENT_COLLISION,
      message: error instanceof GuardError ? error.message : 'read-live report failed',
    }, null, 2)}\n`);
    process.exitCode = 2;
  }
} else if (isDirect) {
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

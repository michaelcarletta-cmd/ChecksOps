#!/usr/bin/env node
/**
 * GitHub-hosted guarded preflight for the production stack checksops-production-onboarding-keys
 * (template aws/production/onboarding-keys.yaml, sha256 pinned in production-onboarding-keys.mjs).
 *
 * inspect: check the template bytes against the pin, read the stack, the two aliases
 *          (alias/checksops-production-compliance-documents, alias/checksops-production-moov-onboarding-pii)
 *          with the key each targets, and the prep Lambda configuration, and report ABSENT (create may
 *          proceed), LIVE (stack and keys in the pinned shape) or BLOCKED (drift, partial create,
 *          rollback, an alias already held). Never writes AWS.
 * create:  same read, then requires ABSENT, the snapshot SHA-256 from a prior inspect, the exact
 *          approval phrase and a staging acceptance reference; takes the production lease and issues
 *          a KMS-signed receipt whose preflight fingerprint is the whole snapshot and whose owned
 *          components are the stack and its two aliases.
 * verify:  the stack is CREATE_COMPLETE from the pinned template, both aliases target enabled,
 *          rotation-on keys whose key policies equal the template's, and the prep Lambda did not move
 *          from the pre-write snapshot recorded by the create run.
 * There is no update and no delete mode. production-onboarding-keys.mjs is the only writer.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CODES, GuardError } from './lib/errors.mjs';
import { acquireLease } from './lib/lease.mjs';
import { issueReceiptWithSigner } from './lib/receipt.mjs';
import { signReceiptWithKms } from './lib/kms-issuer.mjs';
import { LOCAL_STATE_DIR } from './lib/paths.mjs';
import {
  KEYS,
  KEYS_DEPLOYMENT_TYPE,
  KEYS_TARGET_COMPONENT,
  STACK_NAME,
  TEMPLATE_SHA256,
  assertExpectedAfter,
  classify,
  keyPoliciesFromTemplate,
  ownedComponentsFor,
  readSnapshot,
  readTemplate,
  snapshotFingerprint,
} from './production-onboarding-keys.mjs';

export const CREATE_PHRASE = 'CREATE ONBOARDING KEYS IN PRODUCTION';
const STAGING_ACCEPTANCE_RE = /^https:\/\/github\.com\/michaelcarletta-cmd\/ChecksOps\/(actions\/runs\/\d+(\/job\/\d+)?|pull\/\d+)$/;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function approvalPhraseFor(mode) {
  if (mode === 'create') return CREATE_PHRASE;
  throw new GuardError(CODES.INVALID_MANIFEST, 'only create needs an approval phrase');
}

export function workflowIdentity(env = process.env) {
  const commit = String(env.GITHUB_SHA || '').trim();
  const branch = String(env.GITHUB_REF_NAME || '').trim();
  const actor = String(env.GITHUB_ACTOR || '').trim();
  const runId = String(env.GITHUB_RUN_ID || '').trim();
  if (!/^[0-9a-f]{40}$/.test(commit) || !branch || !actor || !runId) {
    throw new GuardError(CODES.ANONYMOUS_DEPLOYMENT, 'GitHub workflow identity is incomplete');
  }
  if (branch !== 'main') throw new GuardError(CODES.UNRELATED_MUTATION, 'guarded onboarding keys change may only run from main', { branch });
  return { commit, branch, operator: actor, workstreamId: `github-production-onboarding-keys-${runId}` };
}

export function validateChangeInputs({ mode, approval, stagingAcceptance, expectedFingerprint, liveFingerprint }) {
  const phrase = approvalPhraseFor(mode);
  if (approval !== phrase) {
    throw new GuardError(CODES.PRODUCTION_APPROVAL_REQUIRED, `${mode} requires the exact approval phrase`, { expected: phrase });
  }
  if (!STAGING_ACCEPTANCE_RE.test(String(stagingAcceptance || ''))) {
    throw new GuardError(CODES.PRODUCTION_APPROVAL_REQUIRED, 'production onboarding keys create requires a staging acceptance reference (a ChecksOps GitHub run or PR URL)');
  }
  const expected = String(expectedFingerprint || '').trim();
  if (!/^[0-9a-f]{64}$/.test(expected)) throw new GuardError(CODES.INVALID_MANIFEST, `${mode} requires expected_snapshot_sha256 from a prior inspect run`);
  if (expected !== liveFingerprint) {
    throw new GuardError(CODES.DEPLOYMENT_COLLISION, 'live stack, aliases, keys or prep Lambda changed since the inspect run', { expected_snapshot_sha256: expected, actual_snapshot_sha256: liveFingerprint });
  }
}

function appendGithubOutput(values, env = process.env) {
  const file = env.GITHUB_OUTPUT;
  if (!file) return;
  fs.appendFileSync(file, `${Object.entries(values).map(([key, value]) => `${key}=${String(value).replace(/[\r\n]/g, ' ')}`).join('\n')}\n`);
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
  const mode = String(env.CHECKSOPS_ONBOARDING_KEYS_MODE || 'inspect').trim();
  if (!['inspect', 'create', 'verify'].includes(mode)) {
    throw new GuardError(CODES.INVALID_MANIFEST, 'mode must be inspect, create or verify');
  }
  const identity = workflowIdentity(env);
  const template = (deps.readTemplate || readTemplate)(deps.templateRoot || repoRoot);
  if (template.sha256 !== TEMPLATE_SHA256) {
    throw new GuardError(CODES.DEPLOYMENT_COLLISION, 'template bytes differ from the pinned sha256; the template is not changed by this workflow', { expected: TEMPLATE_SHA256, actual: template.sha256 });
  }
  const expectedPolicies = keyPoliciesFromTemplate(template.body);
  const snapshot = (deps.readSnapshot || readSnapshot)(env);
  const { state, problems, fingerprint } = classify(snapshot, { expectedPolicies });
  const summary = {
    stack: STACK_NAME,
    template_sha256: template.sha256,
    snapshot_sha256: snapshotFingerprint(snapshot),
    stack_status: snapshot.stack?.StackStatus || 'ABSENT',
    documents_key: snapshot.aliases?.[KEYS[0].alias] ? (snapshot.keys?.[KEYS[0].alias]?.Arn || 'ALIAS_WITHOUT_KEY') : 'ABSENT',
    pii_key: snapshot.aliases?.[KEYS[1].alias] ? (snapshot.keys?.[KEYS[1].alias]?.Arn || 'ALIAS_WITHOUT_KEY') : 'ABSENT',
    lambda_revision_id: snapshot.lambda?.RevisionId || '',
  };

  if (mode === 'verify') {
    const file = env.CHECKSOPS_ONBOARDING_KEYS_INPUT;
    if (!file) throw new GuardError(CODES.INVALID_MANIFEST, 'verify requires the change input recorded by the create run');
    const input = JSON.parse(fs.readFileSync(file, 'utf8'));
    try {
      assertExpectedAfter(input.before_snapshot, snapshot, { mode: input.mode, expectedPolicies });
    } catch (error) {
      throw new GuardError(CODES.DEPLOYMENT_COLLISION, 'post-change snapshot does not hold the pinned stack with nothing else moved', { reason: error.message, state, problems });
    }
    appendGithubOutput({ ...summary, state: 'VERIFIED' }, env);
    return { ok: true, mode, identity, ...summary, state: 'VERIFIED', mutation: false };
  }

  appendGithubOutput({ ...summary, state, problem_count: problems.length, problems: problems.join(',') }, env);
  if (mode === 'inspect') return { ok: true, mode, identity, ...summary, state, problems, mutation: false };

  if (state !== 'ABSENT') {
    throw new GuardError(CODES.DEPLOYMENT_COLLISION, 'create requires the stack and both aliases to be absent and the prep Lambda unchanged', { state, problems });
  }
  validateChangeInputs({
    mode,
    approval: env.CHECKSOPS_ONBOARDING_KEYS_APPROVAL,
    stagingAcceptance: env.CHECKSOPS_STAGING_ACCEPTANCE_REFERENCE,
    expectedFingerprint: env.CHECKSOPS_EXPECTED_SNAPSHOT_SHA256,
    liveFingerprint: fingerprint,
  });
  const approval = { approved: true, workstream_id: identity.workstreamId, phrase: approvalPhraseFor(mode), approver: identity.operator };
  const stagingAcceptance = { ok: true, reference: String(env.CHECKSOPS_STAGING_ACCEPTANCE_REFERENCE) };

  const lease = (deps.acquireLease || acquireLease)(root, {
    workstream_id: identity.workstreamId,
    component: KEYS_TARGET_COMPONENT,
    environment: 'production',
    commit: identity.commit,
    operator: identity.operator,
  });
  if (!lease.ok) throw new GuardError(lease.code, lease.message, lease.details || {});

  const issued = (deps.issueReceipt || issueReceiptWithSigner)(root, {
    workstream_id: identity.workstreamId,
    branch: identity.branch,
    commit: identity.commit,
    operator: identity.operator,
    target_environment: 'production',
    target_component: KEYS_TARGET_COMPONENT,
    deployment_type: KEYS_DEPLOYMENT_TYPE,
    owned_components: ownedComponentsFor(mode),
    preflight_live_fingerprint: snapshot,
    lease: lease.details.lease,
  }, deps.signer || ((unsigned) => signReceiptWithKms(unsigned, { env })));
  if (!issued.ok) throw new GuardError(issued.code, issued.message, issued.details || {});

  const inputPath = writeState(root, 'github-production-onboarding-keys-input.json', JSON.stringify({
    mode,
    workstream_id: identity.workstreamId,
    commit: identity.commit,
    operator: identity.operator,
    receipt_path: issued.details.file,
    snapshot_sha256: fingerprint,
    before_snapshot: snapshot,
    staging_acceptance: stagingAcceptance,
    approval,
  }, null, 2));
  appendGithubOutput({ keys_input: inputPath, receipt_path: issued.details.file, workstream_id: identity.workstreamId }, env);
  return { ok: true, mode, identity, ...summary, state, mutation: false, authorization: { lease: lease.details.lease, receiptFile: issued.details.file, keysInput: inputPath } };
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  run().then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)).catch((error) => {
    process.stderr.write(`${JSON.stringify({ ok: false, code: error?.code || CODES.DEPLOYMENT_COLLISION, message: error?.message || String(error), details: error?.details || {} }, null, 2)}\n`);
    process.exitCode = 2;
  });
}

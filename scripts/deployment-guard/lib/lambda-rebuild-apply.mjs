/**
 * Receipt-gated full-package rebuild writer for a shared API Lambda.
 *
 * Unlike applyLambdaOverlay (which starts from the live ZIP and swaps members),
 * this writer uploads a candidate ZIP built by the preflight. Everything else is
 * the same discipline: a signed receipt whose only owned component is the
 * candidate ZIP SHA-256, RevisionId CAS before the write, the rebuild plan
 * re-evaluated against the live bytes immediately before mutation, the
 * production gate, one-shot receipt consumption, and a post-update download that
 * must equal the candidate member for member. Never restores an old ZIP and
 * never touches configuration.
 */
import fs from 'node:fs';
import path from 'node:path';
import { consumeReceiptOnce } from './consumed-receipts.mjs';
import { CODES, fail, ok } from './errors.mjs';
import { configFingerprint } from './lambda-overlay-apply.mjs';
import { evaluateApplyFingerprintCas, requireLambdaApplyFingerprint } from './lambda-overlay.mjs';
import {
  REBUILD_DEPLOYMENT_TYPE,
  evaluateRebuild,
  loadRebuildPlan,
  parseFullPackageComponent,
  readPackage,
  sha256,
} from './lambda-rebuild.mjs';
import { LOCAL_STATE_DIR } from './paths.mjs';
import { evaluateProductionGate } from './production.mjs';
import { refuseUnguardedDeploy } from '../require-guard.mjs';
import { lookupSharedLambda } from './shared-targets.mjs';

const iso = (now) => new Date(now).toISOString();

function fingerprintsEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

async function waitForFunctionUpdated(aws, functionName, { attempts = 20, delayMs = 0 } = {}) {
  let last = null;
  for (let i = 0; i < attempts; i += 1) {
    last = await aws.getFunctionConfiguration({ functionName });
    if (!last?.ok) return last || fail(CODES.DEPLOYMENT_COLLISION, 'failed to read Lambda configuration after update');
    const status = last.details.lastUpdateStatus || last.details.configuration?.LastUpdateStatus || last.details.LastUpdateStatus;
    if (!status || status === 'Successful') return last;
    if (status === 'Failed') {
      return fail(CODES.DEPLOYMENT_COLLISION, 'Lambda update failed; stopping without restore', { lastUpdateStatus: status });
    }
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return last || fail(CODES.DEPLOYMENT_COLLISION, 'Lambda update did not complete');
}

/** The candidate ZIP may only come from the guard's own ephemeral state directory. */
export function resolveCandidateZip(guardRoot, candidatePath) {
  if (typeof candidatePath !== 'string' || !candidatePath.trim() || candidatePath.includes('\0')) {
    return fail(CODES.INVALID_MANIFEST, 'candidate_zip_path is required');
  }
  let stateReal;
  try {
    stateReal = fs.realpathSync(path.join(guardRoot, LOCAL_STATE_DIR));
  } catch {
    return fail(CODES.INVALID_MANIFEST, 'deployment-guard state directory is missing');
  }
  const candidate = path.isAbsolute(candidatePath) ? path.normalize(candidatePath) : path.resolve(guardRoot, candidatePath);
  let stat;
  try {
    stat = fs.lstatSync(candidate);
  } catch {
    return fail(CODES.STALE_PACKAGE, 'candidate ZIP is missing', { path: candidate });
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    return fail(CODES.UNRELATED_MUTATION, 'candidate ZIP must be a regular file', { path: candidate });
  }
  const real = fs.realpathSync(candidate);
  const relative = path.relative(stateReal, real);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    return fail(CODES.UNRELATED_MUTATION, 'candidate ZIP must live inside the deployment-guard state directory', { path: candidate });
  }
  return ok({ path: real });
}

export async function applyLambdaRebuild(input = {}, ctx = {}) {
  const env = ctx.env || process.env;
  const guardRoot = ctx.guardRoot;
  const aws = ctx.aws;
  const now = ctx.now || Date.now();
  const repoRoot = ctx.repoRoot || guardRoot;

  if (!guardRoot) return fail(CODES.INVALID_MANIFEST, 'applyLambdaRebuild requires guardRoot');
  if (input.apply !== true) {
    return fail(CODES.GUARD_APPLY_FORBIDDEN, 'lambda rebuild apply requires explicit apply:true confirmation');
  }
  if (env.CHECKSOPS_DEPLOYMENT_GUARD_APPLY !== '1') {
    return fail(CODES.GUARD_APPLY_FORBIDDEN, 'lambda rebuild apply is blocked unless CHECKSOPS_DEPLOYMENT_GUARD_APPLY=1');
  }
  if (input.restore === true || input.reclaim === true || input.saved_zip || input.package_path) {
    return fail(CODES.STALE_PACKAGE, 'restore/reclaim and saved packages are forbidden; only the preflight candidate may be uploaded');
  }
  if (!aws?.getFunction || !aws?.getFunctionConfiguration || !aws?.downloadFunctionCode || !aws?.updateFunctionCode) {
    return fail(CODES.INVALID_MANIFEST, 'applyLambdaRebuild requires a Lambda aws adapter');
  }

  const functionName = input.function_name || input.target_component;
  const shared = lookupSharedLambda(functionName);
  if (!shared) {
    return fail(CODES.UNRELATED_MUTATION, 'lambda rebuild may only target a registered shared Lambda', { function_name: functionName || null });
  }
  if (input.target_environment && input.target_environment !== shared.target_environment) {
    return fail(CODES.RECEIPT_MISMATCH, 'requested environment does not match the registered Lambda', {
      function_name: functionName,
      requested_environment: input.target_environment,
      registered_environment: shared.target_environment,
    });
  }
  const target_environment = shared.target_environment;
  const target_component = shared.target_component;
  const workstream_id = input.workstream_id || env.CHECKSOPS_WORKSTREAM_ID || null;
  const commit = input.commit || env.CHECKSOPS_COMMIT || null;

  const authorized = refuseUnguardedDeploy({
    target_environment,
    target_component,
    deployment_type: REBUILD_DEPLOYMENT_TYPE,
    workstream_id,
    commit,
    receipt: input.receipt,
    receipt_path: input.receipt_path,
  }, { root: guardRoot, now, env: ctx.guardEnv || env });
  if (!authorized.ok) return authorized;
  const receipt = authorized.details.receipt;

  if (receipt.deployment_type !== REBUILD_DEPLOYMENT_TYPE) {
    return fail(CODES.RECEIPT_MISMATCH, 'receipt is not a lambda-rebuild receipt', { deployment_type: receipt.deployment_type });
  }
  if (Object.prototype.hasOwnProperty.call(receipt, 'owned_member_ops')) {
    return fail(CODES.RECEIPT_MISMATCH, 'a rebuild receipt must not carry owned_member_ops');
  }
  const components = Array.isArray(receipt.owned_components) ? receipt.owned_components : [];
  const expectedZipSha256 = components.length === 1 ? parseFullPackageComponent(components[0]) : null;
  if (!expectedZipSha256) {
    return fail(CODES.RECEIPT_MISMATCH, 'rebuild receipt must own exactly one full-package@sha256:<candidate> component', { owned_components: components });
  }

  const candidatePath = resolveCandidateZip(guardRoot, input.candidate_zip_path);
  if (!candidatePath.ok) return candidatePath;
  const candidateZip = fs.readFileSync(candidatePath.details.path);
  const candidateSha256 = sha256(candidateZip);
  if (candidateSha256 !== expectedZipSha256) {
    return fail(CODES.RECEIPT_MISMATCH, 'candidate ZIP is not the package the receipt authorized', {
      receipt_sha256: expectedZipSha256,
      candidate_sha256: candidateSha256,
    });
  }
  let candidate;
  try {
    candidate = readPackage(candidateZip);
  } catch (error) {
    return fail(CODES.STALE_PACKAGE, 'candidate ZIP is unreadable', { error: String(error?.message || error) });
  }

  let plan;
  try {
    plan = input.plan ? { environments: { [target_environment]: input.plan } } : { environments: { [target_environment]: loadRebuildPlan(repoRoot, target_environment) } };
  } catch (error) {
    return fail(error?.code || CODES.INVALID_MANIFEST, error?.message || 'rebuild plan is unreadable', error?.details || {});
  }
  if (plan.environments[target_environment].function_name !== functionName) {
    return fail(CODES.UNRELATED_MUTATION, 'rebuild plan section targets a different function', { function_name: functionName });
  }

  const receiptIdentity = requireLambdaApplyFingerprint(receipt?.preflight_live_fingerprint, 'receipt preflight');
  if (!receiptIdentity.ok) return receiptIdentity;

  const liveFn = await aws.getFunction({ functionName });
  if (!liveFn?.ok) return liveFn || fail(CODES.DEPLOYMENT_COLLISION, 'failed to read current live Lambda');
  const liveCfg = await aws.getFunctionConfiguration({ functionName });
  if (!liveCfg?.ok) return liveCfg || fail(CODES.DEPLOYMENT_COLLISION, 'failed to read current live Lambda configuration');
  const liveIdentity = requireLambdaApplyFingerprint(liveFn.details, 'first live');
  if (!liveIdentity.ok) return liveIdentity;
  const firstCas = evaluateApplyFingerprintCas({
    preflight: { codeSha256: receiptIdentity.details.codeSha256, revisionId: receiptIdentity.details.revisionId },
    immediatelyBefore: liveIdentity.details,
    label: 'receipt-to-first-live',
  });
  if (!firstCas.ok) return firstCas;
  const configBefore = configFingerprint(liveCfg.details.configuration || liveCfg.details);

  const downloaded = await aws.downloadFunctionCode({ functionName, location: liveFn.details.code_location });
  if (!downloaded?.ok) return downloaded || fail(CODES.DEPLOYMENT_COLLISION, 'failed to download CURRENT live Lambda ZIP');
  if (downloaded.details.origin && downloaded.details.origin !== 'fresh-live-download') {
    return fail(CODES.STALE_PACKAGE, 'downloadFunctionCode did not return a fresh-live-download');
  }
  let live;
  try {
    live = readPackage(downloaded.details.zip);
  } catch (error) {
    return fail(CODES.DEPLOYMENT_COLLISION, 'failed to read live Lambda ZIP members', { error: String(error?.message || error) });
  }

  const evaluation = evaluateRebuild({
    plan,
    environment: target_environment,
    liveMemberHashes: live.memberHashes,
    candidateMemberHashes: candidate.memberHashes,
    liveInventory: live.inventory,
    candidateInventory: candidate.inventory,
  });
  if (!evaluation.ok) return evaluation;
  if (evaluation.details.state === 'ALREADY_ACCEPTED') {
    return fail(CODES.UNRELATED_MUTATION, 'live package already equals the candidate; nothing to apply');
  }

  const immediatelyBeforeFn = await aws.getFunction({ functionName });
  if (!immediatelyBeforeFn?.ok) return immediatelyBeforeFn || fail(CODES.DEPLOYMENT_COLLISION, 'failed to re-read Lambda immediately before mutation');
  const immediatelyBefore = requireLambdaApplyFingerprint(immediatelyBeforeFn.details, 'immediately-before');
  if (!immediatelyBefore.ok) return immediatelyBefore;
  const receiptToImmediate = evaluateApplyFingerprintCas({
    preflight: { codeSha256: receiptIdentity.details.codeSha256, revisionId: receiptIdentity.details.revisionId },
    immediatelyBefore: immediatelyBefore.details,
    label: 'receipt-to-immediately-before',
  });
  if (!receiptToImmediate.ok) return receiptToImmediate;

  const operator = input.operator || receipt.operator || env.CHECKSOPS_OPERATOR || env.USER || null;
  if (target_environment === 'production') {
    const gate = evaluateProductionGate({
      target_environment,
      deployment_type: REBUILD_DEPLOYMENT_TYPE,
      workstream_id: workstream_id || receipt.workstream_id,
      production_fingerprint: { codeSha256: receiptIdentity.details.codeSha256, revisionId: receiptIdentity.details.revisionId },
      immediately_before_fingerprint: immediatelyBefore.details,
      staging_acceptance: input.staging_acceptance,
      approval: input.approval,
    });
    if (!gate.ok) return gate;
  }

  const consumed = consumeReceiptOnce(guardRoot, receipt, { now, actor: operator, script: ctx.script || 'lambda-rebuild-apply' });
  if (!consumed.ok) return consumed;
  if (typeof aws.authorizeWrites === 'function') {
    aws.authorizeWrites({ receipt_mac: receipt.mac, function_name: functionName });
  }

  const updated = await aws.updateFunctionCode({ functionName, zip: candidateZip, revisionId: immediatelyBefore.details.revisionId });
  if (!updated?.ok) return updated || fail(CODES.DEPLOYMENT_COLLISION, 'UpdateFunctionCode failed');

  const afterCfg = await waitForFunctionUpdated(aws, functionName, { attempts: ctx.waitAttempts || 20, delayMs: ctx.waitDelayMs || 0 });
  if (!afterCfg?.ok) return afterCfg;
  const afterFn = await aws.getFunction({ functionName });
  if (!afterFn?.ok) return afterFn || fail(CODES.DEPLOYMENT_COLLISION, 'failed to read Lambda after update');
  const afterDownload = await aws.downloadFunctionCode({ functionName, location: afterFn.details.code_location });
  if (!afterDownload?.ok) return afterDownload || fail(CODES.DEPLOYMENT_COLLISION, 'failed to download Lambda ZIP after update');
  let after;
  try {
    after = readPackage(afterDownload.details.zip);
  } catch (error) {
    return fail(CODES.DEPLOYMENT_COLLISION, 'failed to read Lambda ZIP after update', { error: String(error?.message || error) });
  }
  const mismatched = [];
  const names = new Set([...Object.keys(candidate.memberHashes), ...Object.keys(after.memberHashes)]);
  for (const name of names) {
    if (candidate.memberHashes[name] !== after.memberHashes[name]) mismatched.push(name);
  }
  if (mismatched.length) {
    return fail(CODES.DEPLOYMENT_COLLISION, 'live package after update does not equal the candidate member for member', { mismatched: mismatched.slice(0, 50), count: mismatched.length });
  }
  const configAfter = configFingerprint(afterCfg.details.configuration || afterCfg.details);
  if (!fingerprintsEqual(configBefore, configAfter)) {
    return fail(CODES.UNRELATED_MUTATION, 'Lambda environment/configuration changed; stopping without restore', { before: configBefore, after: configAfter });
  }

  return ok({
    environment: target_environment,
    component: target_component,
    function_name: functionName,
    workstream_id: workstream_id || receipt.workstream_id,
    commit: commit || receipt.commit,
    candidate_zip_sha256: candidateSha256,
    candidate_member_count: candidate.memberCount,
    receipt: { file: authorized.details.receipt_file || null, mac: receipt.mac, consumed: consumed.details },
    before: { fingerprint: liveIdentity.details, configuration: configBefore },
    immediately_before: immediatelyBefore.details,
    after: {
      fingerprint: { codeSha256: afterFn.details.codeSha256 || null, revisionId: afterFn.details.revisionId || null },
      configuration: configAfter,
    },
    rebuild: evaluation.details,
    update: updated.details,
    applied_at: iso(now),
    reclaim_forbidden: true,
    restore_forbidden: true,
  });
}

import fs from 'node:fs';
import path from 'node:path';
import { consumeReceiptOnce } from './consumed-receipts.mjs';
import { CODES, fail, ok } from './errors.mjs';
import {
  evaluateApplyFingerprintCas,
  evaluateLambdaOverlay,
  evaluatePostOverlay,
  requireLambdaApplyFingerprint,
} from './lambda-overlay.mjs';
import { evaluateProductionGate } from './production.mjs';
import { refuseUnguardedDeploy } from '../require-guard.mjs';
import { lookupSharedLambda } from './shared-targets.mjs';
import { classifyOwnedMembers, evaluateOwnedMemberPresence } from './lambda-owned-members.mjs';
import { hashZipMembers, overlayZipMembers } from './zip-members.mjs';

function iso(now) {
  return new Date(now).toISOString();
}

export function configFingerprint(configuration = {}) {
  return {
    Role: configuration.Role || null,
    Runtime: configuration.Runtime || null,
    Handler: configuration.Handler || null,
    MemorySize: configuration.MemorySize ?? null,
    Timeout: configuration.Timeout ?? null,
    Environment: configuration.Environment?.Variables || configuration.Environment || {},
    VpcConfig: {
      SubnetIds: [...(configuration.VpcConfig?.SubnetIds || [])].sort(),
      SecurityGroupIds: [...(configuration.VpcConfig?.SecurityGroupIds || [])].sort(),
    },
  };
}

function fingerprintsEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function lambdaFingerprint(details = {}) {
  return {
    codeSha256: details.codeSha256 || details.CodeSha256 || null,
    revisionId: details.revisionId || details.RevisionId || null,
  };
}

function receiptLambdaFingerprint(receipt) {
  const required = requireLambdaApplyFingerprint(receipt?.preflight_live_fingerprint, 'receipt preflight');
  if (!required.ok) return required;
  return ok({
    codeSha256: required.details.codeSha256,
    revisionId: required.details.revisionId,
  });
}

function liveLambdaFingerprint(details, label) {
  return requireLambdaApplyFingerprint(details, label);
}

function hashZipMembersClosed(buffer, label) {
  try {
    return ok({ members: hashZipMembers(buffer) });
  } catch (error) {
    const message = String(error?.message || error);
    if (message.startsWith('DUPLICATE_ZIP_MEMBER')) {
      return fail(
        CODES.DEPLOYMENT_COLLISION,
        `${label} Lambda ZIP contains duplicate member names; fail closed without overlay or rebuild`,
        { error: message },
      );
    }
    return fail(CODES.DEPLOYMENT_COLLISION, `failed to read ${label} Lambda ZIP members`, { error: message });
  }
}

export function resolveOwnedMemberSource(repoRoot, member, sourcePath) {
  if (!repoRoot) {
    return fail(CODES.INVALID_MANIFEST, 'member_sources confinement requires a repository root', { member });
  }
  if (typeof sourcePath !== 'string' || !sourcePath.trim()) {
    return fail(CODES.STALE_PACKAGE, 'owned member source path is missing', { member });
  }
  const raw = sourcePath.trim();
  if (raw.includes('\0')) {
    return fail(CODES.UNRELATED_MUTATION, 'member source path is malformed', { member, path: raw });
  }
  const segments = raw.split(/[\\/]+/).filter(Boolean);
  if (segments.includes('..')) {
    return fail(
      CODES.UNRELATED_MUTATION,
      'member_sources must not traverse outside the approved repository root',
      { member, path: raw },
    );
  }

  let rootReal;
  try {
    rootReal = fs.realpathSync(repoRoot);
  } catch {
    return fail(CODES.INVALID_MANIFEST, 'repository root is not resolvable', { repoRoot });
  }

  const candidate = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(rootReal, raw);
  if (!fs.existsSync(candidate)) {
    return fail(CODES.STALE_PACKAGE, 'owned member source file is missing', { member, path: candidate });
  }

  let fileReal;
  try {
    fileReal = fs.realpathSync(candidate);
  } catch {
    return fail(CODES.STALE_PACKAGE, 'owned member source file is missing', { member, path: candidate });
  }

  const relative = path.relative(rootReal, fileReal);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    return fail(
      CODES.UNRELATED_MUTATION,
      'member_sources must resolve inside the approved repository root',
      { member, path: raw, resolved: fileReal },
    );
  }

  let stat;
  try {
    stat = fs.statSync(fileReal);
  } catch {
    return fail(CODES.STALE_PACKAGE, 'owned member source file is missing', { member, path: fileReal });
  }
  if (!stat.isFile()) {
    return fail(CODES.STALE_PACKAGE, 'owned member source is not a regular file', { member, path: fileReal });
  }
  if (path.basename(fileReal) !== member) {
    return fail(
      CODES.UNRELATED_MUTATION,
      'member source basename must match the receipt-approved ZIP member',
      { member, path: raw, basename: path.basename(fileReal) },
    );
  }
  return ok({ path: fileReal });
}

async function waitForFunctionUpdated(aws, functionName, { attempts = 20, delayMs = 0 } = {}) {
  let last = null;
  for (let i = 0; i < attempts; i += 1) {
    last = await aws.getFunctionConfiguration({ functionName });
    if (!last?.ok) return last || fail(CODES.DEPLOYMENT_COLLISION, 'failed to read Lambda configuration after update');
    const status = last.details.lastUpdateStatus || last.details.configuration?.LastUpdateStatus || last.details.LastUpdateStatus;
    if (!status || status === 'Successful') return last;
    if (status === 'Failed') {
      return fail(CODES.DEPLOYMENT_COLLISION, 'Lambda update failed; stopping without restore', {
        lastUpdateStatus: status,
      });
    }
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return last || fail(CODES.DEPLOYMENT_COLLISION, 'Lambda update did not complete');
}

export async function applyLambdaOverlay(input = {}, ctx = {}) {
  const env = ctx.env || process.env;
  const guardRoot = ctx.guardRoot;
  const aws = ctx.aws;
  const now = ctx.now || Date.now();
  const repoRoot = ctx.repoRoot;

  if (!guardRoot) return fail(CODES.INVALID_MANIFEST, 'applyLambdaOverlay requires guardRoot');
  if (input.apply !== true) {
    return fail(CODES.GUARD_APPLY_FORBIDDEN, 'lambda overlay apply requires explicit apply:true confirmation');
  }
  if (env.CHECKSOPS_DEPLOYMENT_GUARD_APPLY !== '1') {
    return fail(
      CODES.GUARD_APPLY_FORBIDDEN,
      'lambda overlay apply is blocked unless CHECKSOPS_DEPLOYMENT_GUARD_APPLY=1',
    );
  }
  if (input.zip || input.package_path || input.saved_zip || input.restore === true || input.reclaim === true) {
    return fail(
      CODES.STALE_PACKAGE,
      'old Lambda ZIP, repository full package, and restore/reclaim are forbidden; start from CURRENT live ZIP only',
    );
  }
  if (!aws?.getFunction || !aws?.getFunctionConfiguration || !aws?.downloadFunctionCode || !aws?.updateFunctionCode) {
    return fail(CODES.INVALID_MANIFEST, 'applyLambdaOverlay requires a Lambda aws adapter');
  }

  const functionName = input.function_name || input.target_component;
  const shared = lookupSharedLambda(functionName);
  if (!shared) {
    return fail(CODES.UNRELATED_MUTATION, 'lambda overlay apply may only target a registered shared Lambda', {
      function_name: functionName || null,
    });
  }
  if (input.target_environment && input.target_environment !== shared.target_environment) {
    return fail(CODES.RECEIPT_MISMATCH, 'requested environment does not match the registered Lambda', {
      function_name: functionName,
      requested_environment: input.target_environment,
      registered_environment: shared.target_environment,
    });
  }
  if (input.target_component && input.target_component !== shared.target_component) {
    return fail(CODES.RECEIPT_MISMATCH, 'requested component does not match the registered Lambda', {
      requested_component: input.target_component,
      registered_component: shared.target_component,
    });
  }

  const target_environment = shared.target_environment;
  const target_component = shared.target_component;
  const workstream_id = input.workstream_id || env.CHECKSOPS_WORKSTREAM_ID || null;
  const commit = input.commit || env.CHECKSOPS_COMMIT || null;

  const authorized = refuseUnguardedDeploy({
    target_environment,
    target_component,
    deployment_type: 'lambda-overlay',
    workstream_id,
    commit,
    receipt: input.receipt,
    receipt_path: input.receipt_path,
  }, { root: guardRoot, now, env: ctx.guardEnv || env });
  if (!authorized.ok) return authorized;

  const receipt = authorized.details.receipt;
  if (Object.prototype.hasOwnProperty.call(input, 'owned_member_ops')) {
    return fail(
      CODES.RECEIPT_MISMATCH,
      'owned_member_ops may only come from the signed receipt; caller input cannot add or reinterpret members',
    );
  }
  const classified = classifyOwnedMembers(receipt);
  if (!classified.ok) return classified;
  const owned = [...classified.details.all];
  const replaceMembers = [...classified.details.replace];
  const addMembers = [...classified.details.add];
  const memberSources = input.member_sources || {};
  for (const member of owned) {
    if (!memberSources[member]) {
      return fail(CODES.INVALID_MANIFEST, `owned ZIP member ${member} has no member_sources path`, { member });
    }
  }
  for (const member of Object.keys(memberSources)) {
    if (!owned.includes(member)) {
      return fail(CODES.UNRELATED_MUTATION, 'member_sources includes a ZIP member that the receipt did not approve', {
        member,
      });
    }
  }

  const receiptIdentity = receiptLambdaFingerprint(receipt);
  if (!receiptIdentity.ok) return receiptIdentity;

  const liveFn = await aws.getFunction({ functionName });
  if (!liveFn?.ok) return liveFn || fail(CODES.DEPLOYMENT_COLLISION, 'failed to read current live Lambda');
  const liveCfg = await aws.getFunctionConfiguration({ functionName });
  if (!liveCfg?.ok) return liveCfg || fail(CODES.DEPLOYMENT_COLLISION, 'failed to read current live Lambda configuration');

  const liveIdentity = liveLambdaFingerprint(liveFn.details, 'first live');
  if (!liveIdentity.ok) return liveIdentity;
  const firstCas = evaluateApplyFingerprintCas({
    preflight: receiptIdentity.details,
    immediatelyBefore: liveIdentity.details,
    label: 'receipt-to-first-live',
  });
  if (!firstCas.ok) return firstCas;

  const configBefore = configFingerprint(liveCfg.details.configuration || liveCfg.details);

  const downloaded = await aws.downloadFunctionCode({
    functionName,
    location: liveFn.details.code_location,
  });
  if (!downloaded?.ok) return downloaded || fail(CODES.DEPLOYMENT_COLLISION, 'failed to download CURRENT live Lambda ZIP');
  if (downloaded.details.origin && downloaded.details.origin !== 'fresh-live-download') {
    return fail(CODES.STALE_PACKAGE, 'downloadFunctionCode did not return a fresh-live-download');
  }

  const liveHashed = hashZipMembersClosed(downloaded.details.zip, 'live');
  if (!liveHashed.ok) return liveHashed;
  const liveMembers = liveHashed.details.members;
  const presence = evaluateOwnedMemberPresence({
    liveMembers,
    replace: replaceMembers,
    add: addMembers,
  });
  if (!presence.ok) return presence;

  const replacements = {};
  const sourceRoot = repoRoot || guardRoot;
  for (const member of owned) {
    const resolved = resolveOwnedMemberSource(sourceRoot, member, memberSources[member]);
    if (!resolved.ok) return resolved;
    replacements[member] = fs.readFileSync(resolved.details.path);
  }

  let candidateZip;
  try {
    candidateZip = overlayZipMembers(downloaded.details.zip, replacements);
  } catch (error) {
    const message = String(error?.message || error);
    return fail(CODES.DEPLOYMENT_COLLISION, 'failed to overlay live Lambda ZIP members', { error: message });
  }
  const candidateHashed = hashZipMembersClosed(candidateZip, 'candidate');
  if (!candidateHashed.ok) return candidateHashed;
  const candidateMembers = candidateHashed.details.members;

  const immediatelyBeforeFn = await aws.getFunction({ functionName });
  if (!immediatelyBeforeFn?.ok) {
    return immediatelyBeforeFn || fail(CODES.DEPLOYMENT_COLLISION, 'failed to re-read Lambda immediately before mutation');
  }
  const immediatelyBefore = liveLambdaFingerprint(immediatelyBeforeFn.details, 'immediately-before');
  if (!immediatelyBefore.ok) return immediatelyBefore;
  const receiptToImmediate = evaluateApplyFingerprintCas({
    preflight: receiptIdentity.details,
    immediatelyBefore: immediatelyBefore.details,
    label: 'receipt-to-immediately-before',
  });
  if (!receiptToImmediate.ok) return receiptToImmediate;
  const priorToImmediate = evaluateApplyFingerprintCas({
    preflight: liveIdentity.details,
    immediatelyBefore: immediatelyBefore.details,
    label: 'prior-live-to-immediately-before',
  });
  if (!priorToImmediate.ok) return priorToImmediate;

  const branch = input.branch || receipt.branch || env.CHECKSOPS_BRANCH || 'unknown-branch';
  const operator = input.operator || receipt.operator || env.CHECKSOPS_OPERATOR || env.USER || null;
  const build_timestamp = input.build_timestamp || iso(now);
  const evaluation = evaluateLambdaOverlay({
    workstream_id: workstream_id || receipt.workstream_id,
    branch,
    commit: commit || receipt.commit,
    operator,
    target_environment,
    deployment_type: 'lambda-overlay',
    owned_members: owned,
    owned_components: owned,
    add_members: addMembers,
    preflight: liveIdentity.details,
    immediately_before: immediatelyBefore.details,
    live_members: liveMembers,
    candidate_members: candidateMembers,
    package: {
      origin: 'fresh-live-download',
      downloaded_at: iso(now),
      preflight_at: iso(now),
      now: iso(now),
    },
    build_timestamp,
    peer_sources: input.peer_sources || [],
  });
  if (!evaluation.ok) return evaluation;

  if (target_environment === 'production') {
    const gate = evaluateProductionGate({
      target_environment,
      deployment_type: 'lambda-overlay',
      workstream_id: workstream_id || receipt.workstream_id,
      production_fingerprint: receiptIdentity.details,
      immediately_before_fingerprint: immediatelyBefore.details,
      staging_acceptance: input.staging_acceptance,
      approval: input.approval,
    });
    if (!gate.ok) return gate;
  }

  const consumed = consumeReceiptOnce(guardRoot, receipt, {
    now,
    actor: operator,
    script: ctx.script || 'lambda-overlay-apply',
  });
  if (!consumed.ok) return consumed;

  if (typeof aws.authorizeWrites === 'function') {
    aws.authorizeWrites({
      receipt_mac: receipt.mac,
      function_name: functionName,
    });
  }

  const updated = await aws.updateFunctionCode({
    functionName,
    zip: candidateZip,
    revisionId: immediatelyBefore.details.revisionId,
  });
  if (!updated?.ok) return updated || fail(CODES.DEPLOYMENT_COLLISION, 'UpdateFunctionCode failed');

  const afterCfg = await waitForFunctionUpdated(aws, functionName, {
    attempts: ctx.waitAttempts || 20,
    delayMs: ctx.waitDelayMs || 0,
  });
  if (!afterCfg?.ok) return afterCfg;

  const afterFn = await aws.getFunction({ functionName });
  if (!afterFn?.ok) return afterFn || fail(CODES.DEPLOYMENT_COLLISION, 'failed to read Lambda after update');
  const afterDownload = await aws.downloadFunctionCode({
    functionName,
    location: afterFn.details.code_location,
  });
  if (!afterDownload?.ok) return afterDownload || fail(CODES.DEPLOYMENT_COLLISION, 'failed to download Lambda ZIP after update');
  const afterHashed = hashZipMembersClosed(afterDownload.details.zip, 'post-update');
  if (!afterHashed.ok) return afterHashed;
  const afterMembers = afterHashed.details.members;
  const post = evaluatePostOverlay({
    liveMembersBefore: liveMembers,
    liveMembersAfter: afterMembers,
    ownedMembers: owned,
    addMembers,
  });
  if (!post.ok) return post;

  for (const member of owned) {
    if (afterMembers[member] !== candidateMembers[member]) {
      return fail(CODES.DEPLOYMENT_COLLISION, 'owned ZIP member did not match the overlay candidate after update', {
        member,
        expected: candidateMembers[member],
        actual: afterMembers[member] || null,
      });
    }
  }

  const configAfter = configFingerprint(afterCfg.details.configuration || afterCfg.details);
  if (!fingerprintsEqual(configBefore, configAfter)) {
    return fail(CODES.UNRELATED_MUTATION, 'Lambda environment/configuration changed; stopping without restore', {
      before: configBefore,
      after: configAfter,
    });
  }

  return ok({
    environment: target_environment,
    component: target_component,
    function_name: functionName,
    workstream_id: workstream_id || receipt.workstream_id,
    commit: commit || receipt.commit,
    owned_members: owned,
    replaced_members: replaceMembers,
    added_members: addMembers,
    receipt: {
      file: authorized.details.receipt_file || null,
      mac: receipt.mac,
      consumed: consumed.details,
    },
    before: {
      fingerprint: liveIdentity.details,
      configuration: configBefore,
    },
    immediately_before: immediatelyBefore.details,
    after: {
      fingerprint: lambdaFingerprint(afterFn.details),
      configuration: configAfter,
    },
    overlay: evaluation.details,
    post: post.details,
    update: updated.details,
    reclaim_forbidden: true,
    restore_forbidden: true,
  });
}

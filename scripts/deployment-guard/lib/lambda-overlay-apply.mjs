import fs from 'node:fs';
import path from 'node:path';
import { consumeReceiptOnce } from './consumed-receipts.mjs';
import { CODES, fail, ok } from './errors.mjs';
import { evaluateFingerprintCas, evaluateLambdaOverlay, evaluatePostOverlay } from './lambda-overlay.mjs';
import { evaluateProductionGate } from './production.mjs';
import { refuseUnguardedDeploy } from '../require-guard.mjs';
import { lookupSharedLambda } from './shared-targets.mjs';
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
  const raw = receipt?.preflight_live_fingerprint || {};
  return {
    codeSha256: raw.codeSha256 || raw.CodeSha256 || null,
    revisionId: raw.revisionId || raw.RevisionId || null,
  };
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
  const owned = [...(receipt.owned_components || [])];
  if (!owned.length) {
    return fail(CODES.INVALID_MANIFEST, 'receipt must list owned ZIP members');
  }
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

  const liveFn = await aws.getFunction({ functionName });
  if (!liveFn?.ok) return liveFn || fail(CODES.DEPLOYMENT_COLLISION, 'failed to read current live Lambda');
  const liveCfg = await aws.getFunctionConfiguration({ functionName });
  if (!liveCfg?.ok) return liveCfg || fail(CODES.DEPLOYMENT_COLLISION, 'failed to read current live Lambda configuration');

  const liveIdentity = lambdaFingerprint(liveFn.details);
  const receiptIdentity = receiptLambdaFingerprint(receipt);
  const firstCas = evaluateFingerprintCas({
    preflight: receiptIdentity,
    immediatelyBefore: liveIdentity,
  });
  if (!firstCas.ok) return firstCas;

  const configBefore = configFingerprint(liveCfg.details.configuration || liveCfg.details);

  if (target_environment === 'production') {
    const gate = evaluateProductionGate({
      target_environment,
      deployment_type: 'lambda-overlay',
      workstream_id: workstream_id || receipt.workstream_id,
      production_fingerprint: receipt.preflight_live_fingerprint,
      immediately_before_fingerprint: receipt.preflight_live_fingerprint,
      staging_acceptance: input.staging_acceptance,
      approval: input.approval,
    });
    if (!gate.ok) return gate;
  }

  const downloaded = await aws.downloadFunctionCode({
    functionName,
    location: liveFn.details.code_location,
  });
  if (!downloaded?.ok) return downloaded || fail(CODES.DEPLOYMENT_COLLISION, 'failed to download CURRENT live Lambda ZIP');
  if (downloaded.details.origin && downloaded.details.origin !== 'fresh-live-download') {
    return fail(CODES.STALE_PACKAGE, 'downloadFunctionCode did not return a fresh-live-download');
  }

  const liveMembers = hashZipMembers(downloaded.details.zip);
  const replacements = {};
  for (const member of owned) {
    const abs = path.resolve(repoRoot || guardRoot, memberSources[member]);
    if (!fs.existsSync(abs)) {
      return fail(CODES.STALE_PACKAGE, 'owned member source file is missing', { member, path: abs });
    }
    replacements[member] = fs.readFileSync(abs);
  }
  const candidateZip = overlayZipMembers(downloaded.details.zip, replacements);
  const candidateMembers = hashZipMembers(candidateZip);

  const immediatelyBeforeFn = await aws.getFunction({ functionName });
  if (!immediatelyBeforeFn?.ok) {
    return immediatelyBeforeFn || fail(CODES.DEPLOYMENT_COLLISION, 'failed to re-read Lambda immediately before mutation');
  }
  const immediatelyBefore = lambdaFingerprint(immediatelyBeforeFn.details);
  const toctou = evaluateFingerprintCas({
    preflight: liveIdentity,
    immediatelyBefore,
  });
  if (!toctou.ok) return toctou;

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
    preflight: liveIdentity,
    immediately_before: immediatelyBefore,
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
    revisionId: immediatelyBefore.revisionId,
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
  const afterMembers = hashZipMembers(afterDownload.details.zip);
  const post = evaluatePostOverlay({
    liveMembersBefore: liveMembers,
    liveMembersAfter: afterMembers,
    ownedMembers: owned,
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
    receipt: {
      file: authorized.details.receipt_file || null,
      mac: receipt.mac,
      consumed: consumed.details,
    },
    before: {
      fingerprint: liveIdentity,
      configuration: configBefore,
    },
    immediately_before: immediatelyBefore,
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

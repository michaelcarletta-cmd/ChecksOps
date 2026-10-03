#!/usr/bin/env node
/**
 * Official production Lambda overlay apply for accepted Mortgage Agent members.
 * Starts from CURRENT live ZIP. Never calls aws lambda update-function-code.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FUNCTION_NAME,
  WORKSTREAM_ID,
  EXPECTED_LIVE_CODE_SHA256,
  EXPECTED_LIVE_REVISION_ID,
  MEMBER_SOURCES,
  ACCEPTED_SOURCE_SHA256,
  STAGING_ACCEPTANCE,
} from './constants.mjs';
import { acquireLease } from '../../../../scripts/deployment-guard/lib/lease.mjs';
import { issueReceipt } from '../../../../scripts/deployment-guard/lib/receipt.mjs';
import { applyLambdaOverlay } from '../../../../scripts/deployment-guard/lib/lambda-overlay-apply.mjs';
import { createLiveAwsAdapter } from '../../../../scripts/deployment-guard/lib/aws-adapter.mjs';
import { repoRootFrom } from '../../../../scripts/deployment-guard/lib/paths.mjs';
import { resolveGuardRoot } from '../../../../scripts/deployment-guard/require-guard.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const REGION = 'us-east-1';
const COMMIT = execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const BRANCH = 'cursor/mortgage-agent-lambda-prod-ad99';
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

function loadAwsEnv() {
  const file = '/tmp/macomp-aws.env';
  if (!fs.existsSync(file)) throw new Error('missing /tmp/macomp-aws.env');
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^export ([A-Z0-9_]+)=(.*)$/);
    if (m) process.env[m[1]] = m[2];
  }
}

function awsJson(args) {
  const out = execFileSync(AWS, ['--region', REGION, '--output', 'json', ...args], { encoding: 'utf8' });
  return out.trim() ? JSON.parse(out) : {};
}

async function main() {
  loadAwsEnv();
  process.env.AWS_REGION = REGION;
  process.env.AWS_DEFAULT_REGION = REGION;
  delete process.env.CHECKSOPS_DEPLOYMENT_GUARD_RECEIPT;
  delete process.env.CHECKSOPS_SKIP_DEPLOYMENT_GUARD;
  delete process.env.CHECKSOPS_DEPLOYMENT_GUARD_BYPASS;
  process.env.CHECKSOPS_DEPLOYMENT_GUARD_APPLY = '1';
  process.env.CHECKSOPS_WORKSTREAM_ID = WORKSTREAM_ID;
  process.env.CHECKSOPS_COMMIT = COMMIT;
  process.env.CHECKSOPS_BRANCH = BRANCH;
  process.env.CHECKSOPS_OPERATOR = 'cursor-cloud-agent';

  for (const [member, rel] of Object.entries(MEMBER_SOURCES)) {
    const hash = sha256(fs.readFileSync(path.join(ROOT, rel)));
    if (hash !== ACCEPTED_SOURCE_SHA256[member]) {
      throw new Error(`accepted source hash drifted for ${member}: ${hash}`);
    }
  }

  const before = awsJson(['lambda', 'get-function-configuration', '--function-name', FUNCTION_NAME]);
  if (before.CodeSha256 !== EXPECTED_LIVE_CODE_SHA256 || before.RevisionId !== EXPECTED_LIVE_REVISION_ID) {
    const stop = {
      ok: false,
      code: 'DEPLOYMENT_COLLISION',
      message: 'RevisionId or CodeSha256 changed after preflight; STOP without reclaim',
      live: { CodeSha256: before.CodeSha256, RevisionId: before.RevisionId },
      expected: { CodeSha256: EXPECTED_LIVE_CODE_SHA256, RevisionId: EXPECTED_LIVE_REVISION_ID },
    };
    fs.writeFileSync('/opt/cursor/artifacts/prod-lambda-apply-stop.json', `${JSON.stringify(stop, null, 2)}\n`);
    process.stderr.write(`${JSON.stringify(stop, null, 2)}\n`);
    process.exit(2);
  }

  const lease = acquireLease(ROOT, {
    workstream_id: WORKSTREAM_ID,
    component: FUNCTION_NAME,
    environment: 'production',
    commit: COMMIT,
    operator: 'cursor-cloud-agent',
    ttl_ms: 45 * 60 * 1000,
  });
  if (!lease.ok) {
    fs.writeFileSync('/opt/cursor/artifacts/prod-lambda-lease.json', `${JSON.stringify(lease, null, 2)}\n`);
    throw new Error(lease.message || 'lease acquire failed');
  }
  fs.writeFileSync('/opt/cursor/artifacts/prod-lambda-lease.json', `${JSON.stringify(lease.details.lease, null, 2)}\n`);

  const issued = issueReceipt(ROOT, {
    workstream_id: WORKSTREAM_ID,
    branch: BRANCH,
    commit: COMMIT,
    operator: 'cursor-cloud-agent',
    target_environment: 'production',
    target_component: FUNCTION_NAME,
    deployment_type: 'lambda-overlay',
    owned_components: [...Object.keys(MEMBER_SOURCES)],
    owned_member_ops: {
      replace: ['app-services.mjs', 'tenant-admin.mjs', 'identity.mjs'],
      add: ['mortgage-agent-compensation.mjs'],
    },
    preflight_live_fingerprint: {
      codeSha256: before.CodeSha256,
      revisionId: before.RevisionId,
    },
    lease: lease.details.lease,
  });
  if (!issued.ok) {
    fs.writeFileSync('/opt/cursor/artifacts/prod-lambda-receipt.json', `${JSON.stringify(issued, null, 2)}\n`);
    throw new Error(issued.message || 'receipt issue failed');
  }
  fs.writeFileSync('/opt/cursor/artifacts/prod-lambda-receipt.json', `${JSON.stringify(issued.details.receipt, null, 2)}\n`);

  const toctou = awsJson(['lambda', 'get-function-configuration', '--function-name', FUNCTION_NAME]);
  if (toctou.CodeSha256 !== before.CodeSha256 || toctou.RevisionId !== before.RevisionId) {
    const stop = {
      ok: false,
      code: 'DEPLOYMENT_COLLISION',
      message: 'TOCTOU drift immediately before apply; STOP without reclaim',
      first: { CodeSha256: before.CodeSha256, RevisionId: before.RevisionId },
      toctou: { CodeSha256: toctou.CodeSha256, RevisionId: toctou.RevisionId },
    };
    fs.writeFileSync('/opt/cursor/artifacts/prod-lambda-apply-stop.json', `${JSON.stringify(stop, null, 2)}\n`);
    process.stderr.write(`${JSON.stringify(stop, null, 2)}\n`);
    process.exit(2);
  }

  const aws = createLiveAwsAdapter({ region: REGION });
  const result = await applyLambdaOverlay({
    apply: true,
    function_name: FUNCTION_NAME,
    workstream_id: WORKSTREAM_ID,
    commit: COMMIT,
    branch: BRANCH,
    operator: 'cursor-cloud-agent',
    receipt: issued.details.receipt,
    member_sources: MEMBER_SOURCES,
    staging_acceptance: STAGING_ACCEPTANCE,
    approval: {
      approved: true,
      workstream_id: WORKSTREAM_ID,
      inherited: false,
      from_previous_workstream: false,
    },
  }, {
    env: process.env,
    guardRoot: resolveGuardRoot({}, process.env),
    repoRoot: ROOT,
    aws,
    waitAttempts: 40,
    waitDelayMs: 3000,
    script: fileURLToPath(import.meta.url),
  });
  fs.writeFileSync('/opt/cursor/artifacts/prod-lambda-apply.json', `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({
    ok: result.ok,
    code: result.code || null,
    message: result.message || null,
    after: result.details?.after || result.details?.lambda_after || null,
    owned_changed: result.details?.owned_changed || result.details?.evaluation?.owned_changed || null,
  }, null, 2)}\n`);
  if (!result.ok) process.exit(2);

  const replay = await applyLambdaOverlay({
    apply: true,
    function_name: FUNCTION_NAME,
    workstream_id: WORKSTREAM_ID,
    commit: COMMIT,
    branch: BRANCH,
    operator: 'cursor-cloud-agent',
    receipt: issued.details.receipt,
    member_sources: MEMBER_SOURCES,
    staging_acceptance: STAGING_ACCEPTANCE,
    approval: { approved: true, workstream_id: WORKSTREAM_ID },
  }, {
    env: process.env,
    guardRoot: resolveGuardRoot({}, process.env),
    repoRoot: ROOT,
    aws: createLiveAwsAdapter({ region: REGION }),
    waitAttempts: 2,
    waitDelayMs: 0,
    script: fileURLToPath(import.meta.url),
  });
  fs.writeFileSync('/opt/cursor/artifacts/prod-lambda-apply-replay.json', `${JSON.stringify(replay, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ replay_ok: replay.ok, replay_code: replay.code, replay_message: replay.message }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exit(2);
});

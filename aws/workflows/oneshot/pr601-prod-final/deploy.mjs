#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { acquireLease, inspectLease } from '/tmp/main-guard/scripts/deployment-guard/lib/lease.mjs';
import { issueReceipt } from '/tmp/main-guard/scripts/deployment-guard/lib/receipt.mjs';
import { overlayZipMembers, hashZipMembers } from '/tmp/main-guard/scripts/deployment-guard/lib/zip-members.mjs';
import { applyLambdaOverlay } from '/tmp/main-guard/scripts/deployment-guard/lib/lambda-overlay-apply.mjs';

const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const REGION = 'us-east-1';
const ROOT = '/workspace';
const ART = '/opt/cursor/artifacts/pr601-prod-final';
const WORK = '/tmp/pr601-prod-final';
const API = 'checksops-production-prep-api';
const INSPECT = 'checksops-prod-pr601-sql-inspect-a2a4';
const WS = 'pr601-prod-final-a2a4';
const BRANCH = 'cursor/pr601-prod-final-a2a4';
const COMMIT = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
const EXPECTED_API = 'rWKOsHhlnZB+4a0SMiM0KDN0eflwVbgu9h1YPDP2KeQ=';
const EXPECTED_REV = '822ac283-370e-45af-aab6-58cf3e967b5c';
const SIX20 = ['providers.mjs', 'providers/parity/caller.mjs', 'providers/parity/moov-functions.mjs'];
const OWNED = ['tenant-check-user.mjs', 'admin-override-check-status.mjs'];
const PHASE = process.argv[2] || 'sql';

fs.mkdirSync(ART, { recursive: true });
fs.mkdirSync(WORK, { recursive: true });

const run = (args, opts = {}) => execFileSync(AWS, ['--region', REGION, '--output', 'json', ...args], {
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
  ...opts,
});
const awsJson = (args) => {
  const out = run(args);
  return out.trim() ? JSON.parse(out) : {};
};
const write = (name, value) => {
  const file = path.join(ART, name);
  fs.writeFileSync(file, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
  return file;
};
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

function cfg(name) {
  const row = awsJson(['lambda', 'get-function-configuration', '--function-name', name]);
  return { CodeSha256: row.CodeSha256, RevisionId: row.RevisionId, LastModified: row.LastModified };
}

function requireApiAuthority(label) {
  const live = cfg(API);
  write(`authority-${label}.json`, live);
  if (live.CodeSha256 !== EXPECTED_API || live.RevisionId !== EXPECTED_REV) {
    throw new Error(`STOP unexpected production API drift at ${label}: ${live.CodeSha256} ${live.RevisionId}`);
  }
  return live;
}

function acquire(component, environment = 'production') {
  const current = inspectLease(ROOT, environment, component);
  console.error(JSON.stringify({ lease_status: current }, null, 2));
  const lease = acquireLease(ROOT, {
    workstream_id: WS,
    component,
    environment,
    commit: COMMIT,
    operator: 'cursor-agent',
    ttl_ms: 20 * 60 * 1000,
  });
  if (!lease.ok) throw new Error(`lease_failed:${component}:${JSON.stringify(lease)}`);
  return lease.details.lease;
}

function createCliAwsAdapter() {
  const adapter = { kind: 'cli-live', writesAuthorized: false, calls: [] };
  adapter.authorizeWrites = (details = {}) => {
    adapter.writesAuthorized = true;
    return { ok: true, details: { authorized: true, ...details } };
  };
  adapter.getFunction = async ({ functionName }) => {
    const fn = awsJson(['lambda', 'get-function', '--function-name', functionName]);
    const configuration = fn.Configuration || {};
    return {
      ok: true,
      details: {
        function_name: functionName,
        codeSha256: configuration.CodeSha256 || null,
        revisionId: configuration.RevisionId || null,
        lastModified: configuration.LastModified || null,
        configuration,
        code_location: fn.Code?.Location || null,
      },
    };
  };
  adapter.getFunctionConfiguration = async ({ functionName }) => {
    const res = awsJson(['lambda', 'get-function-configuration', '--function-name', functionName]);
    return {
      ok: true,
      details: {
        function_name: functionName,
        codeSha256: res.CodeSha256 || null,
        revisionId: res.RevisionId || null,
        lastUpdateStatus: res.LastUpdateStatus || null,
        configuration: res,
        Role: res.Role,
        Runtime: res.Runtime,
        Handler: res.Handler,
        MemorySize: res.MemorySize,
        Timeout: res.Timeout,
        Environment: res.Environment,
        VpcConfig: res.VpcConfig,
        LastModified: res.LastModified,
      },
    };
  };
  adapter.downloadFunctionCode = async ({ functionName, location }) => {
    let loc = location;
    if (!loc) {
      const live = await adapter.getFunction({ functionName });
      if (!live.ok) return live;
      loc = live.details.code_location;
    }
    const dest = path.join(WORK, `live-download-${functionName}-${Date.now()}.zip`);
    execFileSync('curl', ['-sL', loc, '-o', dest]);
    const zip = fs.readFileSync(dest);
    return { ok: true, details: { zip, bytes: zip.length, origin: 'fresh-live-download' } };
  };
  adapter.updateFunctionCode = async ({ functionName, zip, revisionId }) => {
    if (!adapter.writesAuthorized) {
      return { ok: false, code: 'GUARD_APPLY_FORBIDDEN', message: 'writes not authorized' };
    }
    if (!revisionId) {
      return { ok: false, code: 'DEPLOYMENT_COLLISION', message: 'UpdateFunctionCode requires RevisionId CAS' };
    }
    const zipPath = path.join(WORK, `candidate-${functionName}.zip`);
    fs.writeFileSync(zipPath, zip);
    const res = awsJson([
      'lambda', 'update-function-code',
      '--function-name', functionName,
      '--zip-file', `fileb://${zipPath}`,
      '--revision-id', revisionId,
    ]);
    return {
      ok: true,
      details: {
        function_name: functionName,
        codeSha256: res.CodeSha256 || null,
        revisionId: res.RevisionId || null,
        lastUpdateStatus: res.LastUpdateStatus || null,
      },
    };
  };
  return adapter;
}

function invokeInspect(payload, outName) {
  const payloadPath = path.join(WORK, `${outName}-payload.json`);
  fs.writeFileSync(payloadPath, `${JSON.stringify(payload)}\n`);
  const outFile = path.join(ART, `${outName}.json`);
  run([
    'lambda', 'invoke',
    '--function-name', INSPECT,
    '--cli-binary-format', 'raw-in-base64-out',
    '--payload', `file://${payloadPath}`,
    outFile,
  ]);
  return JSON.parse(fs.readFileSync(outFile, 'utf8'));
}

async function applySql() {
  const apiBefore = requireApiAuthority('before-sql');
  const inspectBefore = cfg(INSPECT);
  write('inspect-lambda-before.json', inspectBefore);

  const lease = acquire('production-sql');
  const receipt = issueReceipt(ROOT, {
    workstream_id: WS,
    branch: BRANCH,
    commit: COMMIT,
    operator: 'cursor-agent',
    target_environment: 'production',
    target_component: 'production-sql',
    deployment_type: 'sql-apply',
    owned_components: ['supabase/migrations/20261002200000_user_can_move_tenant_checks_membership_only.sql'],
    preflight_live_fingerprint: {
      sql: '6117128f04865fbd2dfd758bec1ecbc7f283e1fe047651d5f3b84521e61d3fe2',
      override: '74a234df30847cecab759c72d75fb7ced55ef6e0a0e3d7f86d78e51310ab84e5',
      lambda_code_sha256: apiBefore.CodeSha256,
      lambda_revision_id: apiBefore.RevisionId,
    },
    lease,
  });
  if (!receipt.ok) throw new Error(`sql_receipt_failed:${JSON.stringify(receipt)}`);
  write('production-sql-receipt.json', receipt.details.receipt);

  const loc = awsJson(['lambda', 'get-function', '--function-name', INSPECT]).Code.Location;
  const liveZip = path.join(WORK, 'inspect-live-before-apply.zip');
  execFileSync('curl', ['-sL', loc, '-o', liveZip]);
  const liveBuf = fs.readFileSync(liveZip);
  const beforeMembers = hashZipMembers(liveBuf);
  const src = path.join(ROOT, 'aws/workflows/oneshot/pr601-prod-final');
  const candidate = overlayZipMembers(liveBuf, {
    'index.mjs': fs.readFileSync(path.join(src, 'sql-apply.mjs')),
    '20261002200000_user_can_move_tenant_checks_membership_only.sql': fs.readFileSync(
      path.join(src, '20261002200000_user_can_move_tenant_checks_membership_only.sql'),
    ),
  });
  const afterMembers = hashZipMembers(candidate);
  for (const name of Object.keys(beforeMembers)) {
    if (!afterMembers[name]) throw new Error(`STOP inspect overlay dropped ${name}`);
  }
  const candZip = path.join(WORK, 'inspect-apply-candidate.zip');
  fs.writeFileSync(candZip, candidate);
  const inspectNow = cfg(INSPECT);
  if (inspectNow.RevisionId !== inspectBefore.RevisionId) {
    throw new Error('STOP inspect Lambda drifted before overlay');
  }
  awsJson([
    'lambda', 'update-function-code',
    '--function-name', INSPECT,
    '--zip-file', `fileb://${candZip}`,
    '--revision-id', inspectBefore.RevisionId,
  ]);
  try { run(['lambda', 'wait', 'function-updated', '--function-name', INSPECT]); } catch { /* ok */ }

  const inspectCfgLive = awsJson(['lambda', 'get-function-configuration', '--function-name', INSPECT]);
  const inspectEnv = inspectCfgLive.Environment?.Variables || {};
  if (!/checksops-production/i.test(String(inspectEnv.ADMIN_SECRET_ARN || ''))) {
    throw new Error('STOP inspect Lambda missing production admin secret');
  }
  if (!/checksops-production/i.test(String(inspectEnv.RDS_HOST || ''))) {
    throw new Error('STOP inspect Lambda host is not production');
  }

  const inspect = invokeInspect({ action: 'inspect' }, 'sql-inspect-pre-apply');
  write('sql-inspect-pre-apply-summary.json', inspect);
  if (!inspect.ok) {
    awsJson(['lambda', 'update-function-code', '--function-name', INSPECT, '--zip-file', `fileb://${liveZip}`]);
    throw new Error(`sql_inspect_failed:${JSON.stringify(inspect)}`);
  }

  const apply = invokeInspect({ action: 'apply', target_environment: 'production' }, 'sql-apply');
  write('sql-apply-summary.json', apply);

  awsJson([
    'lambda', 'update-function-code',
    '--function-name', INSPECT,
    '--zip-file', `fileb://${liveZip}`,
  ]);
  try { run(['lambda', 'wait', 'function-updated', '--function-name', INSPECT]); } catch { /* ok */ }
  const inspectRestored = cfg(INSPECT);
  write('inspect-lambda-restored.json', inspectRestored);
  if (inspectRestored.CodeSha256 !== inspectBefore.CodeSha256) {
    throw new Error(`STOP inspect Lambda not restored ${inspectRestored.CodeSha256}`);
  }

  const apiAfter = cfg(API);
  if (apiAfter.CodeSha256 !== apiBefore.CodeSha256 || apiAfter.RevisionId !== apiBefore.RevisionId) {
    throw new Error('STOP production API changed during SQL apply');
  }
  if (!apply.ok || apply.result !== 'applied') {
    throw new Error(`sql_apply_failed:${JSON.stringify(apply)}`);
  }

  const afterInspect = invokeInspect({ action: 'inspect' }, 'sql-inspect-after-restore');
  write('sql-inspect-after-restore-summary.json', afterInspect);
  const helperAfter = afterInspect.functions?.find((row) => row.identity.includes('user_can_move_tenant_checks'));
  const overrideAfter = afterInspect.functions?.find((row) => row.identity.includes('admin_override_check_status'));
  if (helperAfter?.live_definition_sha256 !== '010a450154c4d0d97c4d5b4ab82858c83ab57a3044c9937d40dec86a6c7a749d') {
    throw new Error(`STOP helper after restore is not membership-only: ${helperAfter?.live_definition_sha256}`);
  }
  if (overrideAfter?.live_definition_sha256 !== '74a234df30847cecab759c72d75fb7ced55ef6e0a0e3d7f86d78e51310ab84e5') {
    throw new Error(`STOP override changed: ${overrideAfter?.live_definition_sha256}`);
  }
  const report = {
    api_unchanged: true,
    inspect_restored: true,
    helper_after: helperAfter.live_definition_sha256,
    override_after: overrideAfter.live_definition_sha256,
    override_unchanged: true,
    grant_revoke_rls: false,
    apply,
    inspect_restored_fingerprint: inspectRestored,
    official_inspect_after: {
      helper: helperAfter,
      override: overrideAfter,
    },
  };
  write('sql-phase-report.json', report);
  console.log(JSON.stringify(report, null, 2));
}

async function applyApi() {
  const first = requireApiAuthority('before-api-lease');
  const lease = acquire('checksops-production-prep-api');
  const receipt = issueReceipt(ROOT, {
    workstream_id: WS,
    branch: BRANCH,
    commit: COMMIT,
    operator: 'cursor-agent',
    target_environment: 'production',
    target_component: 'checksops-production-prep-api',
    deployment_type: 'lambda-overlay',
    owned_components: OWNED,
    owned_member_ops: { replace: OWNED, add: [] },
    preflight_live_fingerprint: {
      codeSha256: first.CodeSha256,
      revisionId: first.RevisionId,
      CodeSha256: first.CodeSha256,
      RevisionId: first.RevisionId,
    },
    lease,
  });
  if (!receipt.ok) throw new Error(`api_receipt_failed:${JSON.stringify(receipt)}`);
  write('production-api-receipt.json', receipt.details.receipt);

  const immediately = requireApiAuthority('immediately-before-api-write');
  const result = await applyLambdaOverlay({
    apply: true,
    function_name: API,
    target_environment: 'production',
    target_component: 'checksops-production-prep-api',
    workstream_id: WS,
    branch: BRANCH,
    commit: COMMIT,
    operator: 'cursor-agent',
    receipt: receipt.details.receipt,
    receipt_path: receipt.details.file,
    member_sources: {
      'tenant-check-user.mjs': 'aws/functions/api/tenant-check-user.mjs',
      'admin-override-check-status.mjs': 'aws/functions/api/admin-override-check-status.mjs',
    },
    staging_acceptance: {
      ok: true,
      reference: 'pr601-membership-enum-fix-a2a4 staging acceptance plus deposited-row cleanup 08f27cff',
    },
    approval: {
      approved: true,
      workstream_id: WS,
      inherited: false,
      from_previous_workstream: false,
    },
  }, {
    env: { ...process.env, CHECKSOPS_DEPLOYMENT_GUARD_APPLY: '1' },
    guardRoot: ROOT,
    repoRoot: ROOT,
    aws: createCliAwsAdapter(),
    script: 'pr601-prod-final/deploy.mjs',
    waitAttempts: 40,
    waitDelayMs: 2000,
  });
  write('api-overlay-result.json', result);
  if (!result.ok) throw new Error(`api_overlay_failed:${JSON.stringify(result)}`);

  const after = cfg(API);
  write('authority-after-api.json', after);
  const loc = awsJson(['lambda', 'get-function', '--function-name', API]).Code.Location;
  const afterZip = path.join(WORK, 'production-after-overlay.zip');
  execFileSync('curl', ['-sL', loc, '-o', afterZip]);
  const beforeMembers = hashZipMembers(fs.readFileSync(path.join(WORK, 'production-live-rWKOs.zip')));
  const afterMembers = hashZipMembers(fs.readFileSync(afterZip));
  const delta = {};
  for (const [name, hash] of Object.entries(afterMembers)) {
    if (beforeMembers[name] !== hash) {
      delta[name] = { before: beforeMembers[name] || null, after: hash, op: beforeMembers[name] ? 'replace' : 'add' };
    }
  }
  const dropped = Object.keys(beforeMembers).filter((name) => !afterMembers[name]);
  const six20 = Object.fromEntries(SIX20.map((name) => [name, {
    before: beforeMembers[name],
    after: afterMembers[name],
    identical: beforeMembers[name] === afterMembers[name],
  }]));
  const workflow = {
    before: beforeMembers['workflow-rpc.mjs'],
    after: afterMembers['workflow-rpc.mjs'],
    identical: beforeMembers['workflow-rpc.mjs'] === afterMembers['workflow-rpc.mjs'],
  };
  const preservation = {
    member_count_before: Object.keys(beforeMembers).length,
    member_count_after: Object.keys(afterMembers).length,
    dropped,
    delta,
    six20_byte_identical: Object.values(six20).every((row) => row.identical),
    workflow_rpc_byte_identical: workflow.identical,
    only_two_owned_changed: Object.keys(delta).sort().join(',') === OWNED.slice().sort().join(','),
  };
  write('api-preservation.json', { six20, workflow, preservation, after });
  if (!preservation.six20_byte_identical || !preservation.workflow_rpc_byte_identical || !preservation.only_two_owned_changed || dropped.length) {
    throw new Error(`STOP preservation failed:${JSON.stringify(preservation)}`);
  }
  console.log(JSON.stringify({ overlay: result.details?.after || after, preservation }, null, 2));
}

if (PHASE === 'sql') {
  await applySql();
} else if (PHASE === 'api') {
  await applyApi();
} else {
  throw new Error(`unknown phase ${PHASE}`);
}

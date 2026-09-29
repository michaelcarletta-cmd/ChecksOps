/**
 * Deployment-guard preflight orchestrator.
 *
 * Independent source work may happen concurrently.
 * Independent deployment to a shared target may not overwrite another workstream.
 *
 * Default mode is dry-run / plan-only. This CLI never calls AWS.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CODES,
  applyEnvForbidden,
  createDisabledAws,
  fail,
  loadGuardConfig,
  ok,
  repoRootFrom,
  writeReceipt,
} from './lib.mjs';
import { createManifest, validateManifest } from './manifest.mjs';
import { acquireLease, defaultStoreDir, inspectLease } from './lease.mjs';
import { planLambdaOverlay } from './lambda-overlay.mjs';
import { planSpaPromote } from './spa-promote.mjs';
import { planSqlApply } from './sql-apply.mjs';
import { evaluateContracts, passingResultsFor } from './contracts.mjs';
import { assertProductionApproval } from './production.mjs';

export function resolveTarget(targets, environment, component) {
  const env = targets.environments?.[environment];
  if (!env) return null;
  if (component && env.lambdas) {
    const lambda = env.lambdas.find((row) => row.name === component || row.id === component);
    if (lambda) return { kind: 'lambda', environment, ...lambda };
  }
  if (component === 'spa' || component === env.spa?.id) {
    return env.spa ? { kind: 'spa', environment, ...env.spa } : null;
  }
  return env;
}

export function runPreflight(input = {}, extras = {}) {
  const aws = extras.aws || createDisabledAws();
  const root = extras.root || repoRootFrom(import.meta.url);
  const config = extras.config || loadGuardConfig(root);
  const clock = extras.clock || (() => new Date());

  if (extras.allowApply !== true && applyEnvForbidden(extras.env || process.env)) {
    return fail(CODES.AWS_WRITE_FORBIDDEN, 'apply/AWS env is set but this safeguard workstream refuses writes');
  }

  let manifestResult = input.manifest
    ? validateManifest(input.manifest)
    : createManifest(input.identity || {}, { root, git: extras.git, env: extras.env, clock });
  if (!manifestResult.ok) return manifestResult;
  const manifest = manifestResult.manifest;

  const target = resolveTarget(config.targets, manifest.target_environment, input.component || manifest.owned_components[0]);
  if (input.component && !target && !input.skipTargetLookup) {
    return fail(CODES.INVALID_TARGET, `unknown protected target ${input.component} in ${manifest.target_environment}`);
  }

  const storeDir = extras.storeDir || defaultStoreDir(root);
  if (input.acquireLease !== false) {
    const lease = acquireLease(storeDir, {
      workstream_id: manifest.workstream_id,
      component: input.component || manifest.owned_components[0],
      environment: manifest.target_environment,
      commit: manifest.commit,
      operator: manifest.operator,
    }, { clock, ttlMs: input.ttlMs, fsImpl: extras.fsImpl, nowMs: extras.nowMs });
    if (!lease.ok) return lease;
    manifest.lease_id = lease.lease?.lease_id || manifest.lease_id;
    input._lease = lease;
  } else if (input.requireExistingLease) {
    const held = inspectLease(storeDir, {
      environment: manifest.target_environment,
      component: input.component || manifest.owned_components[0],
    }, extras);
    if (!held.ok || !held.held) {
      return fail(CODES.LEASE_HELD, 'deployment requires an active lease held by this workstream', { held });
    }
  }

  const contracts = evaluateContracts({
    registry: config.contracts,
    results: extras.contractResults || passingResultsFor(config.contracts),
    previouslyAccepted: extras.previouslyAccepted,
    root,
    exists: extras.exists,
  });
  if (!contracts.ok) return contracts;

  let lambdaPlan = null;
  if (manifest.deployment_type === 'lambda-overlay' || manifest.deployment_type === 'composed') {
    lambdaPlan = planLambdaOverlay({
      ...input.lambda,
      workstreamId: manifest.workstream_id,
      commit: manifest.commit,
      ownedMembers: manifest.owned_lambda_members,
      liveFingerprint: manifest.preflight_live_fingerprint,
      provenance: manifest.provenance || input.lambda?.provenance,
      intent: input.intent,
    });
    if (!lambdaPlan.ok) return lambdaPlan;
  }

  let spaPlan = null;
  if (manifest.deployment_type === 'spa-promote' || manifest.deployment_type === 'composed') {
    spaPlan = planSpaPromote({
      ...input.spa,
      manifest,
      environment: manifest.target_environment,
      frontendWorkstreams: manifest.frontend_workstreams,
      intent: input.intent,
    });
    if (!spaPlan.ok) return spaPlan;
  }

  let sqlPlan = null;
  if (manifest.deployment_type === 'sql-apply' || input.sql) {
    sqlPlan = planSqlApply(input.sql || {});
    if (!sqlPlan.ok) return sqlPlan;
  }

  if (manifest.target_environment === 'production') {
    const production = assertProductionApproval({
      environment: 'production',
      manifest,
      approval: manifest.production_approval,
      stagingAcceptance: manifest.staging_acceptance,
      preflightFingerprint: manifest.preflight_live_fingerprint,
      liveFingerprint: input.liveFingerprint || input.lambda?.immediateFingerprint || input.spa?.live,
      compositionAccepted: input.spa?.compositionAccepted ?? (manifest.frontend_workstreams || []).length <= 1,
      previousWorkstreamApproval: input.previousWorkstreamApproval,
      releaseManifest: extras.releaseManifest,
      candidate: input.candidate,
    });
    if (!production.ok) return production;
  }

  const receipt = {
    ...manifest,
    generated_at: clock().toISOString(),
    lambda: lambdaPlan,
    spa: spaPlan,
    sql: sqlPlan,
    contracts,
    aws_writes: typeof aws.writes === 'function' ? aws.writes() : [],
    dry_run: extras.dryRun !== false,
  };
  if (extras.writeReceiptFile) {
    receipt.receipt_path = writeReceipt(root, receipt, extras.fsImpl || fs);
  }
  return ok({
    manifest,
    target,
    lambda: lambdaPlan,
    spa: spaPlan,
    sql: sqlPlan,
    contracts,
    lease: input._lease || null,
    receipt,
    aws_writes: receipt.aws_writes,
  });
}

export function main(argv = process.argv.slice(2), extras = {}) {
  const root = extras.root || repoRootFrom(import.meta.url);
  if (argv.includes('--help')) {
    console.log(`ChecksOps deployment guard preflight (plan-only, no AWS)

Usage:
  node scripts/deployment-guard/preflight.mjs --dry-run
  node scripts/deployment-guard/preflight.mjs --manifest path.json

Future chats must use this tooling instead of calling AWS Lambda
code updates, S3 SPA upload, or CloudFront invalidation directly.
`);
    return 0;
  }
  if (argv.includes('--dry-run') && !argv.includes('--manifest')) {
    const config = loadGuardConfig(root);
    const aws = extras.aws || createDisabledAws();
    console.log(JSON.stringify({
      ok: true,
      dry_run: true,
      fail_closed: true,
      targets: Object.keys(config.targets.environments || {}),
      contracts: (config.contracts.contracts || []).map((row) => row.id),
      inventory: config.inventory.scripts?.length ?? 0,
      aws_writes: aws.writes(),
      message: 'deployment-guard configs loaded; no live AWS calls',
    }, null, 2));
    return 0;
  }
  let identity = extras.identity || {};
  const idx = argv.indexOf('--manifest');
  if (idx >= 0) {
    identity = { manifest: JSON.parse(fs.readFileSync(path.resolve(root, argv[idx + 1]), 'utf8')) };
  }
  const result = runPreflight(identity, { ...extras, root, dryRun: true });
  const out = JSON.stringify(result, null, 2);
  if (!result.ok) {
    console.error(out);
    return 1;
  }
  console.log(out);
  return 0;
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  process.exitCode = main();
}

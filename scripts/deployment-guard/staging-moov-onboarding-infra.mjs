#!/usr/bin/env node
/**
 * Receipt-gated, STAGING-ONLY writer for the Moov onboarding infrastructure that
 * aws/template.yaml defines but the checksops-staging stack never received.
 * A full `sam deploy` is forbidden (it would overwrite live overlay state), so
 * this writer creates only these pieces, in this order:
 *
 *   1. PII key -> alias -> rotation      (alias/checksops-staging-moov-onboarding-pii)
 *   2. docs key -> alias -> rotation     (alias/checksops-staging-compliance-documents)
 *   3. inline role policy MoovOnboardingKms on the staging API function role
 *   4. private files bucket policy (plain create; any existing policy fails closed)
 *   5. bucket CORS: existing rules kept, PUT rule gains the SSE-KMS headers
 *   6. bucket lifecycle: existing rule kept, two compliance-document rules added
 *   7. Lambda env: existing keys kept, three onboarding keys added (RevisionId CAS)
 *
 * The Lambda env step is last, so the code only sees the key ARNs once every
 * resource it needs exists. Default is plan-only (exit 2, reads only). Apply
 * needs CHECKSOPS_STAGING_ONBOARDING_INFRA_EXECUTE=1 AND a staging receipt for
 * staging-moov-onboarding-infra / staging-onboarding-infra bound to the printed
 * fingerprint. Output carries ARNs, step names and fingerprints only: Lambda
 * environment VALUES are never printed (every output line is also redacted).
 *
 * Usage:
 *   node scripts/deployment-guard/staging-moov-onboarding-infra.mjs [--plan]
 *   CHECKSOPS_STAGING_ONBOARDING_INFRA_EXECUTE=1 node scripts/deployment-guard/staging-moov-onboarding-infra.mjs
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { refuseUnguardedDeploy, resolveGuardRoot } from './require-guard.mjs';
import { consumeReceiptOnce } from './lib/consumed-receipts.mjs';
import {
  ACCOUNT_ID,
  BUCKET,
  COMPONENT,
  DEPLOYMENT_TYPE,
  EXECUTE_ENV,
  FUNCTION_NAME,
  KEYS,
  KEY_TAG,
  KEY_TAGS,
  REGION,
  ROLE_NAME,
  ROLE_POLICY_NAME,
  TARGET_ENVIRONMENT,
  assertOnlyPlannedDelta,
  bucketPolicy,
  canonicalJson,
  corsState,
  desiredKeyPolicy,
  diffEnvKeyNames,
  lifecycleState,
  liveFingerprint,
  mergeCors,
  mergeLambdaEnv,
  mergeLifecycle,
  normalizeSnapshot,
  ONBOARDING_ENV_KEYS,
  planDelta,
  policyChars,
  redactSecrets,
  rolePolicy,
  sha256,
  validatePreconditions,
} from './lib/staging-moov-onboarding-infra.mjs';

// ---------------------------------------------------------------- AWS CLI adapter

const notFound = (error, codes) => {
  const text = String(error?.stderr || error?.message || '');
  return codes.some((c) => text.includes(`(${c})`));
};

const cliError = (args, error) => {
  const op = args.slice(0, 2).join(' ');
  const first = String(error?.stderr || error?.message || 'unknown').split(/\r?\n/).find((l) => l.trim()) || 'unknown';
  return new Error(`aws_cli_failed:${op}:${first.slice(0, 300)}`);
};

/**
 * Real adapter: the aws CLI via execFileSync (AWS_CLI override), region pinned to
 * us-east-1, stdio piped so nothing (in particular Lambda env) reaches the console.
 * `exec` is injectable so tests can assert argv without calling AWS.
 */
export function createCliAdapter({ env = process.env, exec } = {}) {
  const bin = env.AWS_CLI || env.AWS || 'aws';
  const run = exec || ((args) => execFileSync(bin, args, {
    encoding: 'utf8',
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 16 * 1024 * 1024,
  }));
  const json = (args) => {
    let out;
    try {
      out = run(['--region', REGION, '--output', 'json', ...args]);
    } catch (error) {
      error.awsArgs = args;
      throw error;
    }
    return String(out || '').trim() ? JSON.parse(out) : {};
  };
  const safe = (args) => {
    try { return json(args); } catch (error) { throw cliError(args, error); }
  };
  const orNull = (args, codes) => {
    try { return json(args); } catch (error) {
      if (notFound(error, codes)) return null;
      throw cliError(args, error);
    }
  };
  const s3 = (op, extra = []) => ['s3api', op, '--bucket', BUCKET, '--expected-bucket-owner', ACCOUNT_ID, ...extra];

  return {
    kind: 'aws-cli',
    callerIdentity: () => safe(['sts', 'get-caller-identity']),
    getFunctionConfiguration: () => safe(['lambda', 'get-function-configuration', '--function-name', FUNCTION_NAME]),
    listRolePolicies: () => safe(['iam', 'list-role-policies', '--role-name', ROLE_NAME]).PolicyNames || [],
    getRolePolicy: (name) => orNull(['iam', 'get-role-policy', '--role-name', ROLE_NAME, '--policy-name', name], ['NoSuchEntity'])?.PolicyDocument ?? null,
    describeKey: (keyId) => orNull(['kms', 'describe-key', '--key-id', keyId], ['NotFoundException'])?.KeyMetadata ?? null,
    getKeyPolicy: (keyId) => safe(['kms', 'get-key-policy', '--key-id', keyId, '--policy-name', 'default']).Policy,
    getKeyRotationStatus: (keyId) => safe(['kms', 'get-key-rotation-status', '--key-id', keyId]).KeyRotationEnabled === true,
    findTaggedKeys: (slot) => (safe(['resourcegroupstaggingapi', 'get-resources', '--resource-type-filters', 'kms:key',
      '--tag-filters', JSON.stringify([{ Key: KEY_TAG, Values: [slot] }])]).ResourceTagMappingList || []).map((r) => r.ResourceARN),
    getBucketPolicy: () => orNull(s3('get-bucket-policy'), ['NoSuchBucketPolicy'])?.Policy ?? null,
    getBucketCors: () => orNull(s3('get-bucket-cors'), ['NoSuchCORSConfiguration'])?.CORSRules ?? [],
    getBucketLifecycle: () => orNull(s3('get-bucket-lifecycle-configuration'), ['NoSuchLifecycleConfiguration']),
    getBucketVersioning: () => safe(s3('get-bucket-versioning')),
    getBucketEncryption: () => orNull(s3('get-bucket-encryption'), ['ServerSideEncryptionConfigurationNotFoundError'])?.ServerSideEncryptionConfiguration ?? null,

    createKey: ({ description, policy, tags }) => safe(['kms', 'create-key', '--description', description,
      '--key-usage', 'ENCRYPT_DECRYPT', '--key-spec', 'SYMMETRIC_DEFAULT', '--origin', 'AWS_KMS', '--no-multi-region',
      '--policy', JSON.stringify(policy), '--tags', JSON.stringify(tags)]).KeyMetadata,
    createAlias: (alias, keyId) => safe(['kms', 'create-alias', '--alias-name', alias, '--target-key-id', keyId]),
    enableKeyRotation: (keyId) => safe(['kms', 'enable-key-rotation', '--key-id', keyId]),
    putRolePolicy: (name, doc) => safe(['iam', 'put-role-policy', '--role-name', ROLE_NAME, '--policy-name', name,
      '--policy-document', JSON.stringify(doc)]),
    putBucketPolicy: (doc) => safe(s3('put-bucket-policy', ['--policy', JSON.stringify(doc)])),
    putBucketCors: (rules) => safe(s3('put-bucket-cors', ['--cors-configuration', JSON.stringify({ CORSRules: rules })])),
    putBucketLifecycle: (rules, transitionDefault) => safe(s3('put-bucket-lifecycle-configuration', [
      '--lifecycle-configuration', JSON.stringify({ Rules: rules }),
      ...(transitionDefault ? ['--transition-default-minimum-object-size', transitionDefault] : []),
    ])),
    /**
     * Env values never go on the command line (visible to other local processes):
     * they are written to a 0600 file in a fresh temp dir and removed afterwards.
     */
    updateFunctionEnvironment: ({ revisionId, variables }) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'checksops-onboarding-env-'));
      const file = path.join(dir, 'input.json');
      try {
        fs.writeFileSync(file, JSON.stringify({
          FunctionName: FUNCTION_NAME,
          RevisionId: revisionId,
          Environment: { Variables: variables },
        }), { mode: 0o600 });
        const out = safe(['lambda', 'update-function-configuration', '--cli-input-json', `file://${file}`]);
        return { RevisionId: out.RevisionId ?? null };
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    waitFunctionUpdated: () => safe(['lambda', 'wait', 'function-updated', '--function-name', FUNCTION_NAME]),
  };
}

// ---------------------------------------------------------------- live reads

function readKey(adapter, slot) {
  const metadata = adapter.describeKey(KEYS[slot].alias);
  if (!metadata) return null;
  return {
    metadata,
    policy: adapter.getKeyPolicy(metadata.KeyId),
    rotation: adapter.getKeyRotationStatus(metadata.KeyId),
  };
}

function readTagged(adapter, slot) {
  return adapter.findTaggedKeys(slot).map((arn) => {
    const meta = adapter.describeKey(arn);
    return { KeyId: meta?.KeyId ?? String(arn).split('/').pop(), KeyState: meta?.KeyState ?? 'Unknown' };
  });
}

/** Returns { snapshot, env, raw }. `env` holds Lambda env values in memory only. */
export function readLive(adapter) {
  const lambda = adapter.getFunctionConfiguration();
  const policyNames = adapter.listRolePolicies();
  const raw = {
    identity: adapter.callerIdentity(),
    lambda,
    role: {
      policyNames,
      onboardingPolicy: policyNames.includes(ROLE_POLICY_NAME) ? adapter.getRolePolicy(ROLE_POLICY_NAME) : null,
      // IAM caps a role's inline policies at 10,240 characters in aggregate.
      otherPolicyChars: policyNames.filter((n) => n !== ROLE_POLICY_NAME)
        .reduce((sum, n) => sum + n.length + policyChars(adapter.getRolePolicy(n)), 0),
    },
    kms: {
      pii: readKey(adapter, 'pii'),
      docs: readKey(adapter, 'docs'),
      tagged: { pii: readTagged(adapter, 'pii'), docs: readTagged(adapter, 'docs') },
    },
    bucket: {
      policy: adapter.getBucketPolicy(),
      cors: adapter.getBucketCors(),
      lifecycle: adapter.getBucketLifecycle(),
      versioning: adapter.getBucketVersioning(),
      encryption: adapter.getBucketEncryption(),
    },
  };
  return { snapshot: normalizeSnapshot(raw), env: { ...(lambda?.Environment?.Variables || {}) }, raw };
}

// ---------------------------------------------------------------- steps

const same = (a, b) => canonicalJson(a) === canonicalJson(b);

/**
 * Runs the pending steps in order. Every step re-reads the one resource it is
 * about to change and refuses unless it is still in the state the plan assumed.
 */
export function applySteps(adapter, before, live, { onStep = () => {} } = {}) {
  const pending = new Set(planDelta(before).filter((s) => s.status === 'pending').map((s) => s.step));
  const arns = { pii: before.kms.pii.key?.Arn ?? null, docs: before.kms.docs.key?.Arn ?? null };
  const keyIds = { pii: before.kms.pii.key?.KeyId ?? null, docs: before.kms.docs.key?.KeyId ?? null };
  const completed = [];
  const step = (name, fn) => {
    if (!pending.has(name)) return;
    fn();
    completed.push(name);
    onStep(name);
  };
  try {
    for (const slot of ['pii', 'docs']) {
      step(`create-${slot}-key`, () => {
        if (adapter.describeKey(KEYS[slot].alias)) throw new Error(`toctou_drift:${slot}_alias_appeared`);
        if (readTagged(adapter, slot).some((k) => !['PendingDeletion', 'PendingReplicaDeletion'].includes(k.KeyState))) {
          throw new Error(`toctou_drift:${slot}_tagged_key_appeared`);
        }
        const meta = adapter.createKey({ description: KEYS[slot].description, policy: desiredKeyPolicy(slot), tags: KEY_TAGS(slot) });
        if (!meta?.KeyId || !meta?.Arn) throw new Error(`create_key_failed:${slot}`);
        keyIds[slot] = meta.KeyId;
        arns[slot] = meta.Arn;
      });
      step(`create-${slot}-key-alias`, () => adapter.createAlias(KEYS[slot].alias, keyIds[slot]));
      step(`enable-${slot}-key-rotation`, () => adapter.enableKeyRotation(keyIds[slot]));
    }

    step('put-role-policy', () => {
      if (adapter.listRolePolicies().includes(ROLE_POLICY_NAME)) throw new Error('toctou_drift:role_policy_appeared');
      adapter.putRolePolicy(ROLE_POLICY_NAME, rolePolicy(arns.pii, arns.docs));
    });

    step('put-bucket-policy', () => {
      if (adapter.getBucketPolicy() !== null) throw new Error('toctou_drift:bucket_policy_appeared');
      adapter.putBucketPolicy(bucketPolicy(arns.docs));
    });

    step('put-bucket-cors', () => {
      const current = adapter.getBucketCors();
      if (corsState(current) !== 'baseline' || !same(current, live.raw.bucket.cors)) throw new Error('toctou_drift:bucket_cors');
      adapter.putBucketCors(mergeCors(current));
    });

    step('put-bucket-lifecycle', () => {
      const current = adapter.getBucketLifecycle();
      if (lifecycleState(current?.Rules) !== 'baseline' || !same(current, live.raw.bucket.lifecycle)) {
        throw new Error('toctou_drift:bucket_lifecycle');
      }
      adapter.putBucketLifecycle(mergeLifecycle(current.Rules), current.TransitionDefaultMinimumObjectSize ?? null);
    });

    step('update-lambda-env', () => {
      const config = adapter.getFunctionConfiguration();
      const vars = config?.Environment?.Variables || {};
      const changed = diffEnvKeyNames(live.env, vars);
      if (config.RevisionId !== before.lambda.RevisionId || config.CodeSha256 !== before.lambda.CodeSha256
        || changed.added.length || changed.removed.length || changed.changed.length) {
        throw new Error('toctou_drift:lambda_changed');
      }
      adapter.updateFunctionEnvironment({
        revisionId: before.lambda.RevisionId,
        variables: mergeLambdaEnv(vars, arns.pii, arns.docs),
      });
      adapter.waitFunctionUpdated();
    });
  } catch (error) {
    error.completedSteps = completed;
    error.keyArns = arns;
    throw error;
  }
  return { completed, arns };
}

// ---------------------------------------------------------------- main

const readFlags = (argv) => new Set(argv.filter((a) => a.startsWith('--')));

/**
 * ctx: { argv, env, adapter, root, now, out, err, authorize }
 * `authorize` defaults to the real receipt guard; tests inject the adapter and
 * may inject `authorize` to exercise the apply path without a lease file.
 */
export function main(ctx = {}) {
  const env = ctx.env || process.env;
  const argv = ctx.argv || process.argv.slice(2);
  const out = ctx.out || ((s) => process.stdout.write(s));
  const err = ctx.err || ((s) => process.stderr.write(s));
  const secrets = [];
  // Every env value except the three onboarding keys (public ARNs / "false") is masked in any output.
  const collectSecrets = (vars) => {
    for (const [k, v] of Object.entries(vars || {})) if (!ONBOARDING_ENV_KEYS.includes(k)) secrets.push(String(v));
  };
  const emit = (writer, obj) => writer(`${redactSecrets(JSON.stringify(obj), secrets)}\n`);
  const flags = readFlags(argv);
  const unknown = [...flags].filter((f) => !['--plan'].includes(f));
  if (unknown.length) {
    emit(err, { ok: false, code: 'INVALID_ARGUMENTS', message: `unknown flags: ${unknown.join(',')}` });
    return 2;
  }
  if (env.AWS_REGION && env.AWS_REGION !== REGION) {
    emit(err, { ok: false, code: 'INVALID_ARGUMENTS', message: `AWS_REGION must be ${REGION} (staging only)` });
    return 2;
  }

  let completed = [];
  try {
    const adapter = ctx.adapter || createCliAdapter({ env });
    const first = readLive(adapter);
    collectSecrets(first.env);
    const checked = validatePreconditions(first.snapshot);
    if (!checked.ok) {
      emit(err, { ok: false, code: 'DEPLOYMENT_COLLISION', message: 'live staging state is not the pinned baseline or a clean resume point', errors: checked.errors });
      return 2;
    }
    const plan = planDelta(first.snapshot);
    const fingerprint = liveFingerprint(first.snapshot);
    const pending = plan.filter((s) => s.status === 'pending');

    if (flags.has('--plan') || env[EXECUTE_ENV] !== '1') {
      emit(out, {
        ok: false,
        plan_only: true,
        target_environment: TARGET_ENVIRONMENT,
        target_component: COMPONENT,
        deployment_type: DEPLOYMENT_TYPE,
        resume: !checked.fresh,
        steps: plan,
        existing_key_arns: checked.key_arns,
        env_keys_added: pending.some((s) => s.step === 'update-lambda-env') ? ONBOARDING_ENV_KEYS : [],
        preflight_live_fingerprint: fingerprint,
      });
      return 2;
    }

    if (!pending.length) {
      emit(out, { ok: true, nothing_to_do: true, key_arns: checked.key_arns, fingerprint });
      return 0;
    }

    const root = resolveGuardRoot({ root: ctx.root }, env);
    const authorize = ctx.authorize || refuseUnguardedDeploy;
    const authorized = authorize({
      script: import.meta.url,
      target_environment: TARGET_ENVIRONMENT,
      target_component: COMPONENT,
      deployment_type: DEPLOYMENT_TYPE,
      preflight_live_fingerprint: fingerprint,
      workstream_id: env.CHECKSOPS_WORKSTREAM_ID,
      commit: env.CHECKSOPS_COMMIT,
    }, { env, root, now: ctx.now });
    if (!authorized?.ok) {
      emit(err, { ok: false, code: authorized?.code || 'DEPLOYMENT_GUARD_REQUIRED', message: authorized?.message || 'guard refused', details: authorized?.details || {} });
      return 2;
    }
    const receipt = authorized.details?.receipt;
    if (receipt?.target_environment !== TARGET_ENVIRONMENT || receipt?.target_component !== COMPONENT
      || receipt?.deployment_type !== DEPLOYMENT_TYPE) {
      emit(err, { ok: false, code: 'RECEIPT_MISMATCH', message: 'receipt does not authorize staging-moov-onboarding-infra' });
      return 2;
    }

    // Mandatory TOCTOU read immediately before the mutation sequence.
    const second = readLive(adapter);
    collectSecrets(second.env);
    const rechecked = validatePreconditions(second.snapshot);
    if (!rechecked.ok || !same(liveFingerprint(second.snapshot), fingerprint)) {
      emit(err, { ok: false, code: 'DEPLOYMENT_COLLISION', message: 'toctou_drift: live state changed after the receipt fingerprint', errors: rechecked.errors });
      return 2;
    }

    const consumed = consumeReceiptOnce(root, receipt, {
      now: ctx.now || Date.now(),
      actor: env.CHECKSOPS_OPERATOR || env.USER || env.USERNAME || null,
      script: COMPONENT,
    });
    if (!consumed.ok) {
      emit(err, { ok: false, code: consumed.code || 'RECEIPT_REUSED', message: consumed.message || 'receipt_consumption_failed' });
      return 2;
    }

    const result = applySteps(adapter, second.snapshot, second, {
      onStep: (name) => { completed = [...completed, name]; },
    });

    const after = readLive(adapter);
    collectSecrets(after.env);
    assertOnlyPlannedDelta(second.snapshot, after.snapshot);
    const envDiff = diffEnvKeyNames(second.env, after.env);
    const expectedAdded = pending.some((s) => s.step === 'update-lambda-env') ? [...ONBOARDING_ENV_KEYS].sort() : [];
    if (envDiff.removed.length || envDiff.changed.length || !same(envDiff.added, expectedAdded)) {
      throw new Error(`post_verify_env_drift:added=${envDiff.added.join('|')};removed=${envDiff.removed.join('|')};changed=${envDiff.changed.join('|')}`);
    }

    emit(out, {
      ok: true,
      target_environment: TARGET_ENVIRONMENT,
      target_component: COMPONENT,
      applied_steps: result.completed,
      pii_key_arn: after.snapshot.kms.pii.key.Arn,
      docs_key_arn: after.snapshot.kms.docs.key.Arn,
      role_policy: ROLE_POLICY_NAME,
      env_keys_added: envDiff.added,
      preexisting_env_keys_unchanged: true,
      before_fingerprint: fingerprint,
      after_snapshot_sha256: sha256(after.snapshot),
    });
    return 0;
  } catch (error) {
    emit(err, {
      ok: false,
      code: /toctou_drift|unplanned_delta|post_verify/.test(String(error?.message)) ? 'DEPLOYMENT_COLLISION' : 'APPLY_FAILED',
      message: error?.message || String(error),
      completed_steps: error?.completedSteps || completed,
      key_arns: error?.keyArns || null,
      resume_hint: completed.length || error?.completedSteps?.length
        ? 'Re-run plan: completed steps are detected as done; issue a fresh receipt for the new fingerprint.'
        : undefined,
    });
    return 2;
  }
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) process.exitCode = main();

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ACCOUNT_ID,
  BUCKET,
  COMPONENT,
  DEPLOYMENT_TYPE,
  ENV_DOCS_KEY,
  ENV_PII_KEY,
  ENV_PRODUCTION_FLAG,
  FUNCTION_NAME,
  KEYS,
  KEY_TAG,
  PII_CONTEXT_KEYS,
  PII_ENCRYPTION_APP,
  ROLE_ARN,
  ROLE_POLICY_NAME,
  STEPS,
  assertOnlyPlannedDelta,
  bucketPolicy,
  corsState,
  desiredKeyPolicy,
  diffEnvKeyNames,
  docsKeyPolicy,
  lifecycleState,
  liveFingerprint,
  mergeCors,
  mergeLambdaEnv,
  mergeLifecycle,
  piiKeyPolicy,
  planDelta,
  redactSecrets,
  rolePolicy,
  validatePreconditions,
} from '../../scripts/deployment-guard/lib/staging-moov-onboarding-infra.mjs';
import { applySteps, createCliAdapter, main, readLive } from '../../scripts/deployment-guard/staging-moov-onboarding-infra.mjs';
import { consumedReceiptFile } from '../../scripts/deployment-guard/lib/consumed-receipts.mjs';
import { DEPLOYMENT_TYPES } from '../../scripts/deployment-guard/lib/identity.mjs';
import { acquireLease } from '../../scripts/deployment-guard/lib/lease.mjs';
import { issueReceipt } from '../../scripts/deployment-guard/lib/receipt.mjs';
import { encryptPii } from '../functions/api/providers/onboarding/crypto.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SECRET = 'fake-secret-value-DO-NOT-PRINT-7f3a9c41';
const SECRET_2 = 'another-fake-db-password-0b9e22d1';
const SHA = 'c'.repeat(40);

const ORIGINS = ['https://checksops.com', 'https://www.checksops.com', 'https://staging.checksops.com'];
const BASE_CORS = () => [
  {
    AllowedHeaders: ['*'],
    AllowedMethods: ['GET', 'HEAD'],
    AllowedOrigins: [...ORIGINS],
    ExposeHeaders: ['Content-Type', 'Content-Length', 'ETag', 'Content-Disposition'],
    MaxAgeSeconds: 300,
  },
  {
    AllowedHeaders: ['content-type'],
    AllowedMethods: ['PUT'],
    AllowedOrigins: [...ORIGINS],
    MaxAgeSeconds: 300,
  },
];
const BASE_LIFECYCLE = (form = 'filter') => ({
  TransitionDefaultMinimumObjectSize: 'all_storage_classes_128K',
  Rules: [{
    ID: 'AbortIncompleteMultipartUploads',
    ...(form === 'filter' ? { Filter: { Prefix: '' } } : { Prefix: '' }),
    Status: 'Enabled',
    AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 },
  }],
});

const MUTATIONS = ['createKey', 'createAlias', 'enableKeyRotation', 'putRolePolicy', 'putBucketPolicy',
  'putBucketCors', 'putBucketLifecycle', 'updateFunctionEnvironment'];

/** Stateful in-memory stand-in for the AWS CLI adapter. Never touches AWS. */
function fakeAws(overrides = {}) {
  const state = {
    account: ACCOUNT_ID,
    lambda: {
      FunctionName: FUNCTION_NAME,
      FunctionArn: `arn:aws:lambda:us-east-1:${ACCOUNT_ID}:function:${FUNCTION_NAME}`,
      Role: ROLE_ARN,
      CodeSha256: 'code-sha-live',
      RevisionId: 'rev-1',
      State: 'Active',
      LastUpdateStatus: 'Successful',
      Environment: { Variables: {
        FILES_BUCKET: BUCKET,
        DATABASE_PASSWORD: SECRET,
        MOOV_SECRET: SECRET_2,
        AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED: 'true',
      } },
    },
    rolePolicies: Object.fromEntries(['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9'].map((n) => [n, { Version: '2012-10-17', Statement: [] }])),
    keys: {},
    aliases: {},
    bucket: {
      policy: null,
      cors: BASE_CORS(),
      lifecycle: BASE_LIFECYCLE(),
      versioning: { Status: 'Enabled' },
      encryption: { Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' }, BucketKeyEnabled: false }] },
    },
    ...overrides,
  };
  const calls = [];
  const hooks = {};
  const counts = {};
  const call = (name, args, fn) => {
    calls.push({ name, args });
    counts[name] = (counts[name] || 0) + 1;
    hooks[name]?.(counts[name], state);
    return fn();
  };
  const resolveKey = (ref) => {
    const id = state.aliases[ref] || String(ref).split('/').pop();
    return state.keys[id] || null;
  };
  const adapter = {
    kind: 'fake',
    callerIdentity: () => call('callerIdentity', [], () => ({ Account: state.account })),
    getFunctionConfiguration: () => call('getFunctionConfiguration', [], () => structuredClone(state.lambda)),
    listRolePolicies: () => call('listRolePolicies', [], () => Object.keys(state.rolePolicies)),
    getRolePolicy: (name) => call('getRolePolicy', [name], () => structuredClone(state.rolePolicies[name] ?? null)),
    describeKey: (ref) => call('describeKey', [ref], () => structuredClone(resolveKey(ref)?.metadata ?? null)),
    getKeyPolicy: (id) => call('getKeyPolicy', [id], () => resolveKey(id).policy),
    getKeyRotationStatus: (id) => call('getKeyRotationStatus', [id], () => resolveKey(id).rotation),
    findTaggedKeys: (slot) => call('findTaggedKeys', [slot], () => Object.values(state.keys)
      .filter((k) => k.tags.some((t) => t.TagKey === KEY_TAG && t.TagValue === slot)).map((k) => k.metadata.Arn)),
    getBucketPolicy: () => call('getBucketPolicy', [], () => state.bucket.policy),
    getBucketCors: () => call('getBucketCors', [], () => structuredClone(state.bucket.cors)),
    getBucketLifecycle: () => call('getBucketLifecycle', [], () => structuredClone(state.bucket.lifecycle)),
    getBucketVersioning: () => call('getBucketVersioning', [], () => structuredClone(state.bucket.versioning)),
    getBucketEncryption: () => call('getBucketEncryption', [], () => structuredClone(state.bucket.encryption)),

    createKey: (input) => call('createKey', [input], () => {
      const id = randomUUID();
      const metadata = {
        KeyId: id, Arn: `arn:aws:kms:us-east-1:${ACCOUNT_ID}:key/${id}`, KeyState: 'Enabled', Enabled: true,
        KeyManager: 'CUSTOMER', KeySpec: 'SYMMETRIC_DEFAULT', KeyUsage: 'ENCRYPT_DECRYPT', Origin: 'AWS_KMS', MultiRegion: false,
      };
      state.keys[id] = { metadata, policy: JSON.stringify(input.policy), rotation: false, tags: input.tags };
      return structuredClone(metadata);
    }),
    createAlias: (alias, id) => call('createAlias', [alias, id], () => {
      if (state.aliases[alias]) throw new Error('(AlreadyExistsException)');
      state.aliases[alias] = id;
      return {};
    }),
    enableKeyRotation: (id) => call('enableKeyRotation', [id], () => { state.keys[id].rotation = true; return {}; }),
    putRolePolicy: (name, doc) => call('putRolePolicy', [name, doc], () => { state.rolePolicies[name] = structuredClone(doc); return {}; }),
    putBucketPolicy: (doc) => call('putBucketPolicy', [doc], () => { state.bucket.policy = JSON.stringify(doc); return {}; }),
    putBucketCors: (rules) => call('putBucketCors', [rules], () => { state.bucket.cors = structuredClone(rules); return {}; }),
    putBucketLifecycle: (rules, tdmos) => call('putBucketLifecycle', [rules, tdmos], () => {
      state.bucket.lifecycle = { TransitionDefaultMinimumObjectSize: tdmos, Rules: structuredClone(rules) };
      return {};
    }),
    updateFunctionEnvironment: (input) => call('updateFunctionEnvironment', [input], () => {
      if (input.revisionId !== state.lambda.RevisionId) throw new Error('(PreconditionFailedException) revision');
      state.lambda.Environment = { Variables: structuredClone(input.variables) };
      state.lambda.RevisionId = `${state.lambda.RevisionId}-next`;
      return { RevisionId: state.lambda.RevisionId };
    }),
    waitFunctionUpdated: () => call('waitFunctionUpdated', [], () => ({})),
  };
  return { adapter, state, calls, hooks, writes: () => calls.filter((c) => MUTATIONS.includes(c.name)) };
}

function capture() {
  const out = [];
  const err = [];
  return { out, err, ctx: { out: (s) => out.push(s), err: (s) => err.push(s) }, text: () => out.join('') + err.join('') };
}

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'checksops-onboarding-infra-'));
}

/** Stub guard returning a well-formed receipt (exercises the apply path on hosts without lease files). */
function stubAuthorize(overrides = {}) {
  const seen = [];
  const fn = (spec) => {
    seen.push(spec);
    return {
      ok: true,
      details: { receipt: {
        mac: randomUUID().replace(/-/g, '').padEnd(64, 'a').slice(0, 64),
        workstream_id: 'ws-onboarding-infra',
        commit: SHA,
        target_environment: 'staging',
        target_component: COMPONENT,
        deployment_type: DEPLOYMENT_TYPE,
        expiry: '2099-01-01T00:00:00.000Z',
        ...overrides,
      } },
    };
  };
  fn.seen = seen;
  return fn;
}

const EXECUTE = { CHECKSOPS_STAGING_ONBOARDING_INFRA_EXECUTE: '1' };

function apply(fake, extra = {}) {
  const cap = capture();
  const root = extra.root || tmpRoot();
  const code = main({ argv: [], env: { ...EXECUTE, ...(extra.env || {}) }, adapter: fake.adapter, root,
    authorize: extra.authorize === undefined ? stubAuthorize() : extra.authorize, ...cap.ctx });
  return { code, cap, root };
}

const parseLast = (lines) => JSON.parse(lines[lines.length - 1]);

// ------------------------------------------------------------------ pure logic

test('baseline live state is a fresh, valid plan with every step pending, in order', () => {
  const { snapshot } = readLive(fakeAws().adapter);
  const v = validatePreconditions(snapshot);
  assert.equal(v.ok, true, v.errors.join(','));
  assert.equal(v.fresh, true);
  assert.deepEqual(planDelta(snapshot).map((s) => s.step), STEPS);
  assert.ok(planDelta(snapshot).every((s) => s.status === 'pending'));
  assert.deepEqual(STEPS.slice(-1), ['update-lambda-env'], 'Lambda env must be the last step');
});

test('fingerprint is deterministic and carries no env values', () => {
  const a = liveFingerprint(readLive(fakeAws().adapter).snapshot);
  const b = liveFingerprint(readLive(fakeAws().adapter).snapshot);
  assert.deepEqual(a, b);
  const { snapshot } = readLive(fakeAws().adapter);
  const text = JSON.stringify({ a, snapshot });
  assert.ok(!text.includes(SECRET) && !text.includes(SECRET_2));
  assert.ok(snapshot.lambda.env_key_names.includes('DATABASE_PASSWORD'));
});

test('key policies mirror the template but bind use to the exact role ARN', () => {
  for (const policy of [piiKeyPolicy(), docsKeyPolicy()]) {
    const [admin, use] = policy.Statement;
    assert.equal(admin.Sid, 'KeyAdministrationOnly');
    assert.ok(!admin.Action.some((a) => /Encrypt|Decrypt|GenerateDataKey|CreateGrant/.test(a)));
    assert.ok(admin.Action.includes('kms:PutKeyPolicy'));
    assert.deepEqual(use.Condition.ArnEquals, { 'aws:PrincipalArn': ROLE_ARN });
    assert.ok(!JSON.stringify(policy).includes('*-ApiFunctionRole-'));
  }
  const pii = piiKeyPolicy().Statement[1];
  assert.deepEqual(pii.Action, ['kms:Encrypt', 'kms:Decrypt']);
  assert.equal(pii.Condition.StringEquals['kms:EncryptionContext:app'], 'checksops-moov-onboarding');
  assert.deepEqual(pii.Condition['ForAllValues:StringEquals']['kms:EncryptionContextKeys'], ['app', 'environment', 'tenant_id', 'field']);
  const docs = docsKeyPolicy().Statement[1];
  assert.deepEqual(docs.Action, ['kms:GenerateDataKey', 'kms:Decrypt']);
  assert.equal(docs.Condition.StringEquals['kms:ViaService'], 's3.us-east-1.amazonaws.com');
  assert.equal(docs.Condition.StringLike['kms:EncryptionContext:aws:s3:arn'], `arn:aws:s3:::${BUCKET}/files/verification-docs/*`);
});

test('PII key policy matches the encryption context crypto.mjs actually sends', async () => {
  const seen = [];
  const prior = process.env[ENV_PII_KEY];
  process.env[ENV_PII_KEY] = `arn:aws:kms:us-east-1:${ACCOUNT_ID}:key/00000000-0000-0000-0000-000000000000`;
  try {
    await encryptPii({ kms: { encrypt: async (input) => { seen.push(input); return { CiphertextBlob: Buffer.from('x') }; } } },
      { tenantId: 't-1', field: 'ein', environment: 'sandbox', plaintext: '12-3456789' });
  } finally {
    if (prior === undefined) delete process.env[ENV_PII_KEY]; else process.env[ENV_PII_KEY] = prior;
  }
  const context = seen[0].EncryptionContext;
  assert.equal(context.app, PII_ENCRYPTION_APP);
  assert.deepEqual(Object.keys(context).sort(), [...PII_CONTEXT_KEYS].sort());
});

test('documents.mjs prefix, SSE headers and key env match the bucket policy, CORS and env plan', () => {
  const src = fs.readFileSync(path.join(ROOT, 'aws/functions/api/providers/onboarding/documents.mjs'), 'utf8');
  assert.match(src, /DOCUMENTS_PREFIX = 'files\/verification-docs\/'/);
  assert.match(src, /\$\{DOCUMENTS_PREFIX\}uploads\//);
  assert.match(src, /\$\{DOCUMENTS_PREFIX\}final\//);
  assert.match(src, /'x-amz-server-side-encryption': 'aws:kms'/);
  assert.match(src, /'x-amz-server-side-encryption-aws-kms-key-id': keyArn/);
  assert.match(src, /DOCUMENTS_KMS_KEY_ENV = 'COMPLIANCE_DOCUMENTS_KMS_KEY_ARN'/);
  const merged = mergeCors(BASE_CORS()).find((r) => r.AllowedMethods.includes('PUT'));
  for (const h of ['content-type', 'x-amz-server-side-encryption', 'x-amz-server-side-encryption-aws-kms-key-id']) {
    assert.ok(merged.AllowedHeaders.includes(h), h);
  }
});

test('role policy is the three template statements with concrete ARNs; bucket policy the two Denies', () => {
  const pii = `arn:aws:kms:us-east-1:${ACCOUNT_ID}:key/11111111-1111-1111-1111-111111111111`;
  const docs = `arn:aws:kms:us-east-1:${ACCOUNT_ID}:key/22222222-2222-2222-2222-222222222222`;
  const role = rolePolicy(pii, docs);
  assert.deepEqual(role.Statement.map((s) => s.Sid), ['MoovOnboardingPiiEncryptDecrypt', 'ComplianceDocumentObjects', 'ComplianceDocumentsViaS3']);
  assert.equal(role.Statement[0].Resource, pii);
  assert.equal(role.Statement[2].Resource, docs);
  assert.equal(role.Statement[1].Resource, `arn:aws:s3:::${BUCKET}/files/verification-docs/*`);
  const bp = bucketPolicy(docs);
  assert.deepEqual(bp.Statement.map((s) => [s.Sid, s.Effect]), [['ComplianceDocumentsRequireSseKms', 'Deny'], ['ComplianceDocumentsRequireDedicatedKey', 'Deny']]);
  assert.equal(bp.Statement[1].Condition.StringNotEquals['s3:x-amz-server-side-encryption-aws-kms-key-id'], docs);
});

test('CORS merge keeps the GET rule and every origin byte-for-byte and only extends the PUT rule', () => {
  const base = BASE_CORS();
  assert.equal(corsState(base), 'baseline');
  const merged = mergeCors(base);
  assert.deepEqual(merged[0], base[0]);
  assert.deepEqual(merged[1].AllowedOrigins, base[1].AllowedOrigins);
  assert.deepEqual(merged[1].AllowedMethods, ['PUT']);
  assert.equal(merged[1].MaxAgeSeconds, 300);
  assert.deepEqual(merged[1].AllowedHeaders, ['content-type', 'content-length', 'x-amz-server-side-encryption', 'x-amz-server-side-encryption-aws-kms-key-id']);
  assert.deepEqual(merged[1].ExposeHeaders, ['ETag', 'x-amz-version-id']);
  assert.equal(corsState(merged), 'applied');
  assert.deepEqual(base, BASE_CORS(), 'input not mutated');
  const drift = BASE_CORS();
  drift[1].AllowedOrigins.pop();
  assert.equal(corsState(drift), 'drift');
  assert.throws(() => mergeCors(drift), /cors_merge_refused/);
  const third = [...BASE_CORS(), { AllowedMethods: ['POST'], AllowedOrigins: ['*'] }];
  assert.equal(corsState(third), 'drift');
});

test('lifecycle merge keeps the existing rule exactly and matches its prefix form', () => {
  for (const form of ['filter', 'prefix']) {
    const base = BASE_LIFECYCLE(form).Rules;
    const merged = mergeLifecycle(base);
    assert.deepEqual(merged[0], base[0]);
    assert.equal(merged.length, 3);
    const [uploads, final] = merged.slice(1);
    assert.equal(uploads.ID, 'ComplianceDocumentUploadsExpire');
    assert.deepEqual(uploads.Expiration, { Days: 1 });
    assert.deepEqual(uploads.NoncurrentVersionExpiration, { NoncurrentDays: 1 });
    assert.equal(final.ID, 'ComplianceDocumentsExpireNoncurrentVersions');
    assert.equal(final.Expiration, undefined);
    assert.deepEqual(final.NoncurrentVersionExpiration, { NoncurrentDays: 7 });
    if (form === 'filter') {
      assert.deepEqual(uploads.Filter, { Prefix: 'files/verification-docs/uploads/' });
      assert.deepEqual(final.Filter, { Prefix: 'files/verification-docs/final/' });
    } else {
      assert.equal(uploads.Prefix, 'files/verification-docs/uploads/');
      assert.equal(final.Prefix, 'files/verification-docs/final/');
      assert.equal(uploads.Filter, undefined);
    }
    assert.equal(lifecycleState(merged), 'applied');
  }
  const drift = BASE_LIFECYCLE().Rules;
  drift[0].AbortIncompleteMultipartUpload.DaysAfterInitiation = 3;
  assert.equal(lifecycleState(drift), 'drift');
  assert.throws(() => mergeLifecycle(drift), /lifecycle_merge_refused/);
});

test('env merge preserves every existing key and refuses a pre-set onboarding key or oversize env', () => {
  const current = { A: SECRET, B: SECRET_2, FILES_BUCKET: BUCKET };
  const merged = mergeLambdaEnv(current, 'arn:pii', 'arn:docs');
  for (const [k, v] of Object.entries(current)) assert.equal(merged[k], v);
  assert.equal(merged[ENV_PII_KEY], 'arn:pii');
  assert.equal(merged[ENV_DOCS_KEY], 'arn:docs');
  assert.equal(merged[ENV_PRODUCTION_FLAG], 'false');
  assert.deepEqual(diffEnvKeyNames(current, merged), { added: [ENV_DOCS_KEY, ENV_PII_KEY, ENV_PRODUCTION_FLAG].sort(), removed: [], changed: [] });
  assert.throws(() => mergeLambdaEnv({ ...current, [ENV_PRODUCTION_FLAG]: 'true' }, 'a', 'b'), /present/);
  assert.throws(() => mergeLambdaEnv({ BIG: 'x'.repeat(4000) }, 'arn:pii', 'arn:docs'), /size_limit/);
  assert.equal(redactSecrets(`x ${SECRET} y`, [SECRET]), 'x [REDACTED] y');
});

// ------------------------------------------------------------------ CLI: plan / refusals

test('plan-only (default and --plan) performs reads only and exits 2 with the fingerprint', () => {
  for (const [argv, env] of [[[], {}], [['--plan'], EXECUTE]]) {
    const fake = fakeAws();
    const cap = capture();
    const code = main({ argv, env, adapter: fake.adapter, root: tmpRoot(), authorize: () => { throw new Error('guard must not run'); }, ...cap.ctx });
    assert.equal(code, 2);
    assert.deepEqual(fake.writes(), []);
    const out = parseLast(cap.out);
    assert.equal(out.plan_only, true);
    assert.equal(out.target_component, COMPONENT);
    assert.equal(out.deployment_type, DEPLOYMENT_TYPE);
    assert.deepEqual(out.preflight_live_fingerprint, liveFingerprint(readLive(fakeAws().adapter).snapshot));
    assert.ok(!cap.text().includes(SECRET) && !cap.text().includes(SECRET_2));
  }
});

test('execute without a receipt is refused by the real guard before any write', () => {
  const fake = fakeAws();
  const root = tmpRoot();
  const cap = capture();
  const code = main({ argv: [], env: { ...EXECUTE }, adapter: fake.adapter, root, ...cap.ctx });
  assert.equal(code, 2);
  assert.match(cap.err.join(''), /DEPLOYMENT_GUARD_REQUIRED/);
  assert.deepEqual(fake.writes(), []);
  assert.ok(!fs.existsSync(path.join(root, '.deployment-guard', 'consumed-receipts')));
});

test('environment-variable bypass is refused by the real guard', () => {
  const fake = fakeAws();
  const cap = capture();
  const code = main({ argv: [], env: { ...EXECUTE, CHECKSOPS_DEPLOYMENT_GUARD_BYPASS: '1', CHECKSOPS_DEPLOYMENT_GUARD_APPLY: '1' },
    adapter: fake.adapter, root: tmpRoot(), ...cap.ctx });
  assert.equal(code, 2);
  assert.match(cap.err.join(''), /DEPLOYMENT_GUARD_REQUIRED/);
  assert.deepEqual(fake.writes(), []);
});

test('guard is asked for exactly the staging target, type and plan fingerprint; other receipts are refused', () => {
  const fake = fakeAws();
  const authorize = stubAuthorize({ target_component: 'checksops-staging-api' });
  const { code, cap } = apply(fake, { authorize });
  assert.equal(code, 2);
  assert.match(cap.err.join(''), /RECEIPT_MISMATCH/);
  assert.deepEqual(fake.writes(), []);
  const spec = authorize.seen[0];
  assert.equal(spec.target_environment, 'staging');
  assert.equal(spec.target_component, COMPONENT);
  assert.equal(spec.deployment_type, DEPLOYMENT_TYPE);
  assert.deepEqual(spec.preflight_live_fingerprint, liveFingerprint(readLive(fakeAws().adapter).snapshot));
  const prod = apply(fakeAws(), { authorize: stubAuthorize({ target_environment: 'production' }) });
  assert.equal(prod.code, 2);
  assert.match(prod.cap.err.join(''), /RECEIPT_MISMATCH/);
});

test('refuses a non-us-east-1 region and unknown flags', () => {
  const fake = fakeAws();
  const cap = capture();
  assert.equal(main({ argv: [], env: { AWS_REGION: 'us-west-2' }, adapter: fake.adapter, ...cap.ctx }), 2);
  assert.equal(main({ argv: ['--force'], env: {}, adapter: fake.adapter, ...cap.ctx }), 2);
  assert.equal(fake.calls.length, 0);
});

// ------------------------------------------------------------------ drift

const drifted = [
  ['alias exists with a mismatched key policy', (s) => {
    const id = randomUUID();
    s.keys[id] = { metadata: { KeyId: id, Arn: `arn:aws:kms:us-east-1:${ACCOUNT_ID}:key/${id}`, KeyState: 'Enabled', Enabled: true,
      KeyManager: 'CUSTOMER', KeySpec: 'SYMMETRIC_DEFAULT', KeyUsage: 'ENCRYPT_DECRYPT', Origin: 'AWS_KMS', MultiRegion: false },
    policy: JSON.stringify({ Version: '2012-10-17', Statement: [{ Sid: 'Open', Effect: 'Allow', Principal: { AWS: '*' }, Action: 'kms:*', Resource: '*' }] }),
    rotation: true, tags: [] };
    s.aliases[KEYS.pii.alias] = id;
  }, /pii_key_policy_mismatch/],
  ['bucket policy present', (s) => { s.bucket.policy = JSON.stringify({ Version: '2012-10-17', Statement: [{ Sid: 'Other', Effect: 'Deny', Principal: '*', Action: 's3:*', Resource: `arn:aws:s3:::${BUCKET}/*` }] }); }, /bucket_policy_present/],
  ['onboarding env key already set', (s) => { s.lambda.Environment.Variables[ENV_PRODUCTION_FLAG] = 'true'; }, /lambda_onboarding_env_drift/],
  ['role policy MoovOnboardingKms present', (s) => { s.rolePolicies[ROLE_POLICY_NAME] = { Version: '2012-10-17', Statement: [] }; }, /role_policy_present_with_unexpected_content/],
  ['versioning suspended', (s) => { s.bucket.versioning = { Status: 'Suspended' }; }, /bucket_versioning_not_enabled/],
  ['S3 bucket key enabled', (s) => { s.bucket.encryption.Rules[0].BucketKeyEnabled = true; }, /bucket_key_enabled/],
  ['CORS PUT rule changed', (s) => { s.bucket.cors[1].AllowedHeaders.push('x-custom'); }, /bucket_cors_drift/],
  ['lifecycle has another rule', (s) => { s.bucket.lifecycle.Rules.push({ ID: 'Other', Status: 'Enabled', Filter: { Prefix: 'x/' }, Expiration: { Days: 5 } }); }, /bucket_lifecycle_drift/],
  ['wrong account', (s) => { s.account = '111111111111'; }, /account_mismatch/],
  ['different Lambda role', (s) => { s.lambda.Role = `arn:aws:iam::${ACCOUNT_ID}:role/other`; }, /lambda_role_mismatch/],
  ['FILES_BUCKET points elsewhere', (s) => { s.lambda.Environment.Variables.FILES_BUCKET = 'other-bucket'; }, /lambda_files_bucket_mismatch/],
  ['Lambda update in progress', (s) => { s.lambda.LastUpdateStatus = 'InProgress'; }, /lambda_not_idle/],
  ['role inline policies too large for MoovOnboardingKms', (s) => {
    s.rolePolicies.P1 = { Version: '2012-10-17', Statement: [{ Sid: 'Big', Effect: 'Allow', Action: 's3:GetObject', Resource: Array.from({ length: 260 }, (_, i) => `arn:aws:s3:::bucket-${i}/prefix-${i}/*`) }] };
  }, /role_inline_policy_size_limit/],
  ['env too large for three more keys', (s) => { s.lambda.Environment.Variables.BIG = 'x'.repeat(3900); }, /lambda_env_size_limit/],
  ['orphan tagged key without alias', (s) => {
    const id = randomUUID();
    s.keys[id] = { metadata: { KeyId: id, Arn: `arn:aws:kms:us-east-1:${ACCOUNT_ID}:key/${id}`, KeyState: 'Enabled' }, policy: '{}', rotation: false,
      tags: [{ TagKey: KEY_TAG, TagValue: 'docs' }] };
  }, /docs_orphan_tagged_key_requires_review/],
];

for (const [name, mutate, code] of drifted) {
  test(`drift refused before any write: ${name}`, () => {
    const fake = fakeAws();
    mutate(fake.state);
    for (const env of [{}, EXECUTE]) {
      const cap = capture();
      const authorize = stubAuthorize();
      const result = main({ argv: [], env, adapter: fake.adapter, root: tmpRoot(), authorize, ...cap.ctx });
      assert.equal(result, 2);
      assert.match(cap.err.join(''), /DEPLOYMENT_COLLISION/);
      assert.match(cap.err.join(''), code);
      assert.equal(authorize.seen.length, 0, 'guard not reached');
    }
    assert.deepEqual(fake.writes(), []);
    assert.ok(!JSON.stringify(fake.calls).includes('"rev-1-next"'));
  });
}

test('a pending-deletion tagged key is not treated as an orphan', () => {
  const fake = fakeAws();
  const id = randomUUID();
  fake.state.keys[id] = { metadata: { KeyId: id, Arn: `arn:aws:kms:us-east-1:${ACCOUNT_ID}:key/${id}`, KeyState: 'PendingDeletion' }, policy: '{}', rotation: false,
    tags: [{ TagKey: KEY_TAG, TagValue: 'pii' }] };
  assert.equal(validatePreconditions(readLive(fake.adapter).snapshot).ok, true);
});

test('RevisionId changed between the guard read and the TOCTOU read: no write, receipt not consumed', () => {
  const fake = fakeAws();
  fake.hooks.getFunctionConfiguration = (n, s) => { if (n === 2) s.lambda.RevisionId = 'rev-2'; };
  const { code, cap, root } = apply(fake);
  assert.equal(code, 2);
  assert.match(cap.err.join(''), /DEPLOYMENT_COLLISION/);
  assert.match(cap.err.join(''), /toctou_drift/);
  assert.deepEqual(fake.writes(), []);
  assert.ok(!fs.existsSync(path.join(root, '.deployment-guard', 'consumed-receipts')));
});

test('Lambda changed during the mutation sequence: env step refuses, earlier steps reported for resume', () => {
  const fake = fakeAws();
  // Reads: 1 = plan, 2 = TOCTOU, 3 = immediately before the env update.
  fake.hooks.getFunctionConfiguration = (n, s) => { if (n === 3) s.lambda.Environment.Variables.NEW_KEY = 'from-another-workstream'; };
  const { code, cap } = apply(fake);
  assert.equal(code, 2);
  const errOut = parseLast(cap.err);
  assert.equal(errOut.code, 'DEPLOYMENT_COLLISION');
  assert.match(errOut.message, /toctou_drift:lambda_changed/);
  assert.deepEqual(errOut.completed_steps, STEPS.slice(0, -1));
  assert.equal(fake.calls.filter((c) => c.name === 'updateFunctionEnvironment').length, 0);
});

test('bucket policy appearing mid-sequence is never merged or overwritten', () => {
  const fake = fakeAws();
  fake.hooks.getBucketPolicy = (n, s) => { if (n === 3) s.bucket.policy = '{"Version":"2012-10-17","Statement":[]}'; };
  const { code, cap } = apply(fake);
  assert.equal(code, 2);
  assert.match(cap.err.join(''), /bucket_policy_appeared/);
  assert.equal(fake.calls.filter((c) => c.name === 'putBucketPolicy').length, 0);
  assert.equal(fake.state.bucket.policy, '{"Version":"2012-10-17","Statement":[]}');
});

// ------------------------------------------------------------------ apply

test('full apply: ordered steps, merges preserve existing rules and env, only the planned delta, no secret printed', () => {
  const fake = fakeAws();
  const beforeEnv = structuredClone(fake.state.lambda.Environment.Variables);
  const beforeCors = structuredClone(fake.state.bucket.cors);
  const beforeLifecycle = structuredClone(fake.state.bucket.lifecycle);
  const beforePolicies = Object.keys(fake.state.rolePolicies);
  const { code, cap, root } = apply(fake);
  assert.equal(code, 0, cap.err.join(''));
  const out = parseLast(cap.out);
  assert.equal(out.ok, true);
  assert.deepEqual(out.applied_steps, STEPS);

  const order = fake.writes().map((c) => c.name);
  assert.deepEqual(order, ['createKey', 'createAlias', 'enableKeyRotation', 'createKey', 'createAlias', 'enableKeyRotation',
    'putRolePolicy', 'putBucketPolicy', 'putBucketCors', 'putBucketLifecycle', 'updateFunctionEnvironment']);
  assert.equal(Object.keys(fake.state.keys).length, 2);

  const piiArn = fake.state.keys[fake.state.aliases[KEYS.pii.alias]].metadata.Arn;
  const docsArn = fake.state.keys[fake.state.aliases[KEYS.docs.alias]].metadata.Arn;
  assert.equal(out.pii_key_arn, piiArn);
  assert.equal(out.docs_key_arn, docsArn);
  assert.ok(Object.values(fake.state.keys).every((k) => k.rotation === true));

  // CORS / lifecycle: existing rules byte-for-byte.
  assert.deepEqual(fake.state.bucket.cors[0], beforeCors[0]);
  assert.deepEqual(fake.state.bucket.cors[1].AllowedOrigins, beforeCors[1].AllowedOrigins);
  assert.deepEqual(fake.state.bucket.lifecycle.Rules[0], beforeLifecycle.Rules[0]);
  assert.equal(fake.state.bucket.lifecycle.TransitionDefaultMinimumObjectSize, beforeLifecycle.TransitionDefaultMinimumObjectSize);

  // Role: the nine existing inline policies untouched, one added.
  assert.deepEqual(Object.keys(fake.state.rolePolicies).sort(), [...beforePolicies, ROLE_POLICY_NAME].sort());
  assert.deepEqual(fake.state.rolePolicies[ROLE_POLICY_NAME], rolePolicy(piiArn, docsArn));
  assert.deepEqual(JSON.parse(fake.state.bucket.policy), bucketPolicy(docsArn));

  // Env: every existing key unchanged, exactly three added, CAS on the original RevisionId.
  const afterEnv = fake.state.lambda.Environment.Variables;
  for (const [k, v] of Object.entries(beforeEnv)) assert.equal(afterEnv[k], v, k);
  assert.equal(afterEnv[ENV_PII_KEY], piiArn);
  assert.equal(afterEnv[ENV_DOCS_KEY], docsArn);
  assert.equal(afterEnv[ENV_PRODUCTION_FLAG], 'false');
  assert.equal(fake.calls.find((c) => c.name === 'updateFunctionEnvironment').args[0].revisionId, 'rev-1');
  assert.equal(fake.calls.filter((c) => c.name === 'waitFunctionUpdated').length, 1);

  // Output carries ARNs and names only.
  const text = cap.text();
  assert.ok(!text.includes(SECRET), 'secret printed');
  assert.ok(!text.includes(SECRET_2), 'secret printed');
  assert.deepEqual(out.env_keys_added, [ENV_DOCS_KEY, ENV_PII_KEY, ENV_PRODUCTION_FLAG].sort());

  // Receipt consumed once.
  const receiptDir = path.join(root, '.deployment-guard', 'consumed-receipts');
  assert.equal(fs.readdirSync(receiptDir).length, 1);

  // Re-running is a no-op plan.
  const again = capture();
  assert.equal(main({ argv: [], env: { ...EXECUTE }, adapter: fake.adapter, root, authorize: stubAuthorize(), ...again.ctx }), 0);
  assert.equal(parseLast(again.out).nothing_to_do, true);
  const plan = capture();
  main({ argv: [], env: {}, adapter: fake.adapter, ...plan.ctx });
  assert.ok(parseLast(plan.out).steps.every((s) => s.status === 'done'));
});

test('legacy Prefix-form lifecycle keeps its form and TransitionDefaultMinimumObjectSize is passed through', () => {
  const fake = fakeAws();
  fake.state.bucket.lifecycle = BASE_LIFECYCLE('prefix');
  fake.state.bucket.lifecycle.TransitionDefaultMinimumObjectSize = 'varies_by_storage_class';
  const { code } = apply(fake);
  assert.equal(code, 0);
  const put = fake.calls.find((c) => c.name === 'putBucketLifecycle');
  assert.equal(put.args[1], 'varies_by_storage_class');
  assert.ok(put.args[0].every((r) => Object.hasOwn(r, 'Prefix') && !Object.hasOwn(r, 'Filter')));
});

test('a secret leaked into an AWS error message is redacted from the output', () => {
  const fake = fakeAws();
  fake.adapter.putBucketCors = () => { throw new Error(`aws_cli_failed:s3api put-bucket-cors:boom ${SECRET}`); };
  const { code, cap } = apply(fake);
  assert.equal(code, 2);
  assert.ok(!cap.text().includes(SECRET));
  assert.match(cap.text(), /\[REDACTED\]/);
});

// ------------------------------------------------------------------ resume

test('resume after keys + aliases exist: key steps are done, no second key is created', () => {
  const fake = fakeAws();
  // Previous run created both keys and aliases (and PII rotation), then stopped.
  applySteps(fake.adapter, readLive(fake.adapter).snapshot, readLive(fake.adapter), {});
  fake.state.rolePolicies = Object.fromEntries(Object.entries(fake.state.rolePolicies).filter(([k]) => k !== ROLE_POLICY_NAME));
  fake.state.bucket.policy = null;
  fake.state.bucket.cors = BASE_CORS();
  fake.state.bucket.lifecycle = BASE_LIFECYCLE();
  const docsId = fake.state.aliases[KEYS.docs.alias];
  fake.state.keys[docsId].rotation = false;
  const env = fake.state.lambda.Environment.Variables;
  for (const k of [ENV_PII_KEY, ENV_DOCS_KEY, ENV_PRODUCTION_FLAG]) delete env[k];
  fake.state.lambda.RevisionId = 'rev-resume';
  fake.calls.length = 0;

  const v = validatePreconditions(readLive(fake.adapter).snapshot);
  assert.equal(v.ok, true, v.errors.join(','));
  assert.equal(v.fresh, false);
  const status = Object.fromEntries(planDelta(readLive(fake.adapter).snapshot).map((s) => [s.step, s.status]));
  assert.equal(status['create-pii-key'], 'done');
  assert.equal(status['create-docs-key-alias'], 'done');
  assert.equal(status['enable-docs-key-rotation'], 'pending');
  assert.equal(status['put-role-policy'], 'pending');
  fake.calls.length = 0;

  const keysBefore = Object.keys(fake.state.keys).sort();
  const { code, cap } = apply(fake);
  assert.equal(code, 0, cap.err.join(''));
  assert.equal(fake.calls.filter((c) => c.name === 'createKey').length, 0);
  assert.equal(fake.calls.filter((c) => c.name === 'createAlias').length, 0);
  assert.deepEqual(fake.writes().map((c) => c.name), ['enableKeyRotation', 'putRolePolicy', 'putBucketPolicy', 'putBucketCors', 'putBucketLifecycle', 'updateFunctionEnvironment']);
  assert.deepEqual(Object.keys(fake.state.keys).sort(), keysBefore);
  assert.deepEqual(parseLast(cap.out).applied_steps, ['enable-docs-key-rotation', 'put-role-policy', 'put-bucket-policy', 'put-bucket-cors', 'put-bucket-lifecycle', 'update-lambda-env']);
});

test('interrupted apply resumes from the completed prefix on the next run', () => {
  const fake = fakeAws();
  const original = fake.adapter.putBucketCors;
  fake.adapter.putBucketCors = () => { throw new Error('aws_cli_failed:s3api put-bucket-cors:throttled'); };
  const first = apply(fake);
  assert.equal(first.code, 2);
  const err = parseLast(first.cap.err);
  assert.equal(err.code, 'APPLY_FAILED');
  assert.deepEqual(err.completed_steps, STEPS.slice(0, STEPS.indexOf('put-bucket-cors')));
  assert.ok(err.key_arns.pii && err.key_arns.docs);

  fake.adapter.putBucketCors = original;
  fake.calls.length = 0;
  const second = apply(fake);
  assert.equal(second.code, 0, second.cap.err.join(''));
  assert.deepEqual(fake.writes().map((c) => c.name), ['putBucketCors', 'putBucketLifecycle', 'updateFunctionEnvironment']);
  assert.equal(Object.keys(fake.state.keys).length, 2);
});

test('out-of-order state (env set but keys absent) fails closed', () => {
  const fake = fakeAws();
  fake.state.bucket.cors = mergeCors(BASE_CORS());
  const v = validatePreconditions(readLive(fake.adapter).snapshot);
  assert.equal(v.ok, false);
  assert.ok(v.errors.includes('out_of_order_state'));
});

// ------------------------------------------------------------------ post-verify

test('assertOnlyPlannedDelta rejects anything beyond the plan', () => {
  const base = fakeAws();
  const before = readLive(base.adapter).snapshot;
  const good = fakeAws();
  applySteps(good.adapter, readLive(good.adapter).snapshot, readLive(good.adapter));
  const after = readLive(good.adapter).snapshot;
  assert.equal(assertOnlyPlannedDelta(before, after), true);

  const mutations = [
    (s) => { s.state.rolePolicies.Extra = {}; },
    (s) => { s.state.bucket.cors[0].MaxAgeSeconds = 1; },
    (s) => { s.state.lambda.Environment.Variables.DATABASE_PASSWORD = 'changed-value-123'; },
    (s) => { delete s.state.lambda.Environment.Variables.MOOV_SECRET; },
    (s) => { s.state.lambda.CodeSha256 = 'other-code'; },
    (s) => { s.state.bucket.versioning = { Status: 'Suspended' }; },
    (s) => { s.state.bucket.lifecycle.TransitionDefaultMinimumObjectSize = 'varies_by_storage_class'; },
  ];
  for (const mutate of mutations) {
    const f = fakeAws();
    const b = readLive(f.adapter).snapshot;
    applySteps(f.adapter, b, readLive(f.adapter));
    mutate(f);
    assert.throws(() => assertOnlyPlannedDelta(b, readLive(f.adapter).snapshot), /unplanned_delta|post_verify/);
  }
});

// ------------------------------------------------------------------ real CLI adapter (fake exec, no AWS)

test('CLI adapter pins region and bucket owner and never puts env values on the command line', () => {
  const argvs = [];
  let inputFile = null;
  let inputBody = null;
  const exec = (args) => {
    argvs.push(args);
    const i = args.indexOf('--cli-input-json');
    if (i !== -1) {
      inputFile = args[i + 1].replace(/^file:\/\//, '');
      inputBody = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
      return JSON.stringify({ RevisionId: 'rev-2', Environment: { Variables: inputBody.Environment.Variables } });
    }
    if (args.includes('get-bucket-policy')) {
      const e = new Error('Command failed');
      e.stderr = 'An error occurred (NoSuchBucketPolicy) when calling the GetBucketPolicy operation';
      throw e;
    }
    return '{}';
  };
  const adapter = createCliAdapter({ env: {}, exec });
  assert.equal(adapter.getBucketPolicy(), null);
  adapter.putBucketCors(mergeCors(BASE_CORS()));
  const res = adapter.updateFunctionEnvironment({ revisionId: 'rev-1', variables: { DATABASE_PASSWORD: SECRET, X: 'y' } });
  assert.deepEqual(res, { RevisionId: 'rev-2' });
  for (const args of argvs) {
    assert.deepEqual(args.slice(0, 4), ['--region', 'us-east-1', '--output', 'json']);
    assert.ok(!args.join(' ').includes(SECRET));
    if (args[4] === 's3api') assert.ok(args.includes('--expected-bucket-owner') && args.includes(ACCOUNT_ID) && args.includes(BUCKET));
  }
  assert.equal(inputBody.FunctionName, FUNCTION_NAME);
  assert.equal(inputBody.RevisionId, 'rev-1');
  assert.equal(inputBody.Environment.Variables.DATABASE_PASSWORD, SECRET);
  assert.ok(!fs.existsSync(inputFile), 'temp env file removed');

  const failing = createCliAdapter({ env: {}, exec: () => { const e = new Error('x'); e.stderr = 'An error occurred (AccessDenied) when calling X'; throw e; } });
  assert.throws(() => failing.getBucketPolicy(), /aws_cli_failed:s3api get-bucket-policy:An error occurred \(AccessDenied\)/);
});

// ------------------------------------------------------------------ registration

test('target, writer, deployment type and accepted contract are registered', () => {
  const read = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
  const target = read('ops/deployment-guard/protected-targets.json').targets.find((t) => t.id === COMPONENT);
  assert.equal(target.kind, 'infra');
  assert.equal(target.environment, 'staging');
  const row = read('ops/deployment-guard/bypass-inventory.json').scripts.find((r) => r.path === 'scripts/deployment-guard/staging-moov-onboarding-infra.mjs');
  assert.equal(row.classification, 'GUARDED');
  assert.ok(DEPLOYMENT_TYPES.includes(DEPLOYMENT_TYPE));
  const contract = read('ops/deployment-guard/accepted-contracts.json').contracts.find((c) => c.id === COMPONENT);
  assert.deepEqual(contract.environments, ['staging']);
  assert.deepEqual(contract.components, [COMPONENT]);
  assert.deepEqual(contract.deployment_types, [DEPLOYMENT_TYPE]);
  assert.equal(contract.test, 'aws/tests/staging-moov-onboarding-infra.test.mjs');
  const src = fs.readFileSync(path.join(ROOT, 'scripts/deployment-guard/staging-moov-onboarding-infra.mjs'), 'utf8');
  assert.match(src, /refuseUnguardedDeploy/);
  assert.match(src, /consumeReceiptOnce/);
  assert.ok(!/production/.test(desiredKeyPolicy('pii').Statement[1].Condition.ArnEquals['aws:PrincipalArn']));
});

// ------------------------------------------------------------------ end to end with a real receipt

// Lease and receipt file names contain ':' (environment::component), which Windows refuses.
test('real signed receipt: apply consumes it once; a replay is RECEIPT_REUSED', { skip: process.platform === 'win32' && 'lease file names contain ":"' }, () => {
  const root = tmpRoot();
  const fake = fakeAws();
  const fingerprint = liveFingerprint(readLive(fake.adapter).snapshot);
  const spec = {
    workstream_id: 'ws-onboarding-infra',
    branch: 'claude/staging-moov-onboarding-infra',
    commit: SHA,
    operator: 'test',
    target_environment: 'staging',
    target_component: COMPONENT,
    deployment_type: DEPLOYMENT_TYPE,
    owned_components: [COMPONENT],
    preflight_live_fingerprint: fingerprint,
  };
  const lease = acquireLease(root, { workstream_id: spec.workstream_id, component: COMPONENT, environment: 'staging', commit: SHA, operator: 'test' });
  assert.equal(lease.ok, true, lease.message);
  const issued = issueReceipt(root, { ...spec, lease: lease.details.lease });
  assert.equal(issued.ok, true, issued.message);
  const env = { ...EXECUTE, CHECKSOPS_WORKSTREAM_ID: spec.workstream_id, CHECKSOPS_COMMIT: SHA };

  const cap = capture();
  assert.equal(main({ argv: [], env, adapter: fake.adapter, root, ...cap.ctx }), 0, cap.err.join(''));
  assert.ok(fs.existsSync(consumedReceiptFile(root, issued.details.receipt)));

  const replay = capture();
  const fresh = fakeAws();
  assert.equal(main({ argv: [], env, adapter: fresh.adapter, root, ...replay.ctx }), 2);
  assert.match(replay.err.join(''), /RECEIPT_REUSED/);
  assert.deepEqual(fresh.writes(), []);
});

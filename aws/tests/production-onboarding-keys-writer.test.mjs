import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ALIAS_NAMES,
  FILES_BUCKET,
  KEYS,
  KEYS_DEPLOYMENT_TYPE,
  KEYS_TARGET_COMPONENT,
  LAMBDA_QUERY,
  PREP_LAMBDA_ROLE_ARN,
  STACK_NAME,
  TAG_KEY,
  TEMPLATE_PATH,
  TEMPLATE_SHA256,
  aliasArn,
  assertExpectedAfter,
  canonical,
  classify,
  createStackArgs,
  keyPoliciesFromTemplate,
  main as writer,
  normalizeSnapshot,
  ownedComponentsFor,
  readTemplate,
  snapshotFingerprint,
  waitForStack,
} from '../../scripts/deployment-guard/production-onboarding-keys.mjs';
import {
  CREATE_PHRASE,
  approvalPhraseFor,
  run as preflight,
  validateChangeInputs,
  workflowIdentity,
} from '../../scripts/deployment-guard/github-production-onboarding-keys.mjs';
import { CODES } from '../../scripts/deployment-guard/lib/errors.mjs';
import { DEPLOYMENT_TYPES } from '../../scripts/deployment-guard/lib/identity.mjs';
import { acquireLease } from '../../scripts/deployment-guard/lib/lease.mjs';
import { issueReceipt } from '../../scripts/deployment-guard/lib/receipt.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHA = 'c'.repeat(40);
const STAGING_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/123';
const WORKFLOW = fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/guarded-production-onboarding-keys.yml'), 'utf8');
const TEMPLATE = readTemplate(REPO_ROOT);
const POLICIES = keyPoliciesFromTemplate(TEMPLATE.body);
const [DOCS, PII] = KEYS;
const KEY_IDS = { [DOCS.alias]: '1a2b3c4d-0000-4000-8000-000000000001', [PII.alias]: '1a2b3c4d-0000-4000-8000-000000000002' };
const keyArn = (alias) => `arn:aws:kms:us-east-1:806168576068:key/${KEY_IDS[alias]}`;

const LAMBDA = {
  FunctionName: 'checksops-production-prep-api',
  CodeSha256: 'sxodWyRpUr0LbETU0YhBayaqYe1VsfNBQi1OoMZpd4U=',
  RevisionId: '58733b08-ef0a-4ab9-a47a-30fc15ebeafb',
  Role: PREP_LAMBDA_ROLE_ARN,
  FilesBucket: FILES_BUCKET,
  COMPLIANCE_DOCUMENTS_KMS_KEY_ARN: null,
  MOOV_ONBOARDING_PII_KMS_KEY_ARN: null,
};

function absent(lambda = LAMBDA) {
  return normalizeSnapshot({ stack: null, stackTemplateBody: null, aliases: [], keyDetails: {}, lambda });
}

// The live policy as KMS returns it: a JSON string, keys in template order (not canonical).
function livePolicyString(alias) {
  const body = TEMPLATE.body;
  const spec = KEYS.find((k) => k.alias === alias);
  const at = body.indexOf(`\n  ${spec.logicalId}:\n`);
  const start = body.indexOf('KeyPolicy: {', at) + 'KeyPolicy: '.length;
  let depth = 0;
  let end = start;
  for (; end < body.length; end += 1) {
    if (body[end] === '{') depth += 1;
    if (body[end] === '}') { depth -= 1; if (depth === 0) break; }
  }
  const resolved = body.slice(start, end + 1)
    .replace(/\{ "Fn::Sub": "([^"]+)" \}/g, (_, s) => JSON.stringify(s.replaceAll('${AWS::AccountId}', '806168576068').replaceAll('${AWS::Region}', 'us-east-1')));
  return JSON.stringify(JSON.parse(resolved));
}

function raw({ status = 'CREATE_COMPLETE', templateBody = TEMPLATE.body, lambda = LAMBDA, mutateKey = null, aliases = ALIAS_NAMES } = {}) {
  const keyDetails = {};
  for (const alias of aliases) {
    const spec = KEYS.find((k) => k.alias === alias);
    const detail = {
      metadata: { KeyMetadata: {
        AWSAccountId: '806168576068', KeyId: KEY_IDS[alias], Arn: keyArn(alias), Enabled: true, KeyState: 'Enabled',
        KeySpec: 'SYMMETRIC_DEFAULT', KeyUsage: 'ENCRYPT_DECRYPT', Origin: 'AWS_KMS', MultiRegion: false, KeyManager: 'CUSTOMER',
        Description: spec.description, CreationDate: '2026-11-01T00:00:00Z',
      } },
      policy: { PolicyName: 'default', Policy: livePolicyString(alias) },
      rotation: { KeyRotationEnabled: true, RotationPeriodInDays: 365 },
      tags: { Tags: [{ TagKey: TAG_KEY, TagValue: STACK_NAME }] },
    };
    if (mutateKey) mutateKey(alias, detail);
    keyDetails[alias] = detail;
  }
  return {
    stack: {
      StackName: STACK_NAME,
      StackId: `arn:aws:cloudformation:us-east-1:806168576068:stack/${STACK_NAME}/0b1c2d3e-0000-0000-0000-000000000000`,
      StackStatus: status,
      Outputs: [
        { OutputKey: 'ComplianceDocumentsKeyArn', OutputValue: keyArn(DOCS.alias) },
        { OutputKey: 'ComplianceDocumentsKeyAliasName', OutputValue: DOCS.alias },
        { OutputKey: 'MoovOnboardingPiiKeyArn', OutputValue: keyArn(PII.alias) },
        { OutputKey: 'MoovOnboardingPiiKeyAliasName', OutputValue: PII.alias },
      ],
    },
    stackTemplateBody: templateBody,
    aliases: [
      { AliasName: 'alias/aws/s3', AliasArn: 'arn:aws:kms:us-east-1:806168576068:alias/aws/s3', TargetKeyId: '99999999-0000-4000-8000-000000000000' },
      ...aliases.map((alias) => ({ AliasName: alias, AliasArn: aliasArn(alias), TargetKeyId: KEY_IDS[alias] })),
    ],
    keyDetails,
    lambda,
  };
}

const live = (opts) => normalizeSnapshot(raw(opts));
const cls = (s) => classify(s, { expectedPolicies: POLICIES });

// --- template pin and shape ---------------------------------------------------------------------

test('the template on this checkout is the pinned bytes (derived from the file, LF checkout)', () => {
  const bytes = fs.readFileSync(path.join(REPO_ROOT, TEMPLATE_PATH));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), TEMPLATE_SHA256);
  assert.equal(TEMPLATE.sha256, TEMPLATE_SHA256);
  assert.equal(bytes.includes(0x0d), false, 'CRLF checkout changes the pinned hash');
});

test('the template: two retained, rotating symmetric keys with aliases, no parameters, no IAM', () => {
  const body = TEMPLATE.body;
  assert.doesNotMatch(body, /^Parameters:/m);
  assert.doesNotMatch(body, /AWS::IAM::|AWS::S3::|AWS::Lambda::/);
  assert.equal((body.match(/Type: AWS::KMS::Key\n {4}DeletionPolicy: Retain\n {4}UpdateReplacePolicy: Retain\n/g) || []).length, 2);
  assert.equal((body.match(/\n {6}EnableKeyRotation: true\n {6}KeySpec: SYMMETRIC_DEFAULT\n {6}KeyUsage: ENCRYPT_DECRYPT\n/g) || []).length, 2);
  assert.equal((body.match(/Type: AWS::KMS::Alias/g) || []).length, 2);
  for (const k of KEYS) {
    assert.ok(body.includes(`      Description: ${k.description}\n`), k.description);
    assert.ok(body.includes(`  ${k.arnOutput}:\n    Value: !GetAtt ${k.logicalId}.Arn\n`), k.arnOutput);
    assert.ok(body.includes(`  ${k.aliasOutput}:\n    Value: !Ref ${k.logicalId}Alias\n`), k.aliasOutput);
    assert.ok(body.includes(`      AliasName: ${k.alias}\n      TargetKeyId: !Ref ${k.logicalId}\n`), k.alias);
  }
});

test('the key policies read from the template: staging administration statement, the production role directly, the conditions the code needs', () => {
  const staging = fs.readFileSync(path.join(REPO_ROOT, 'aws/template.yaml'), 'utf8');
  const adminActions = staging.split('- Sid: KeyAdministrationOnly')[1].split('Resource:')[0].match(/kms:[A-Za-z]+/g);
  const role = 'arn:aws:iam::806168576068:role/checksops-production-api-execution';
  for (const k of KEYS) {
    const p = POLICIES[k.alias];
    assert.equal(p.Version, '2012-10-17');
    assert.equal(p.Statement.length, 2);
    const [admin, use] = p.Statement;
    assert.deepEqual(admin, canonical({ Sid: 'KeyAdministrationOnly', Effect: 'Allow', Principal: { AWS: 'arn:aws:iam::806168576068:root' }, Action: adminActions, Resource: '*' }));
    assert.deepEqual(use.Principal, { AWS: role });
    assert.equal(use.Resource, '*');
    assert.equal(use.Effect, 'Allow');
  }
  assert.deepEqual(POLICIES[DOCS.alias].Statement[1], canonical({
    Sid: 'ProductionApiRoleViaS3',
    Effect: 'Allow',
    Principal: { AWS: role },
    Action: ['kms:GenerateDataKey', 'kms:Decrypt'],
    Resource: '*',
    Condition: {
      StringEquals: { 'kms:ViaService': 's3.us-east-1.amazonaws.com' },
      StringLike: { 'kms:EncryptionContext:aws:s3:arn': `arn:aws:s3:::${FILES_BUCKET}/files/verification-docs/*` },
    },
  }));
  assert.deepEqual(POLICIES[PII.alias].Statement[1], canonical({
    Sid: 'ProductionApiRoleFieldEncryption',
    Effect: 'Allow',
    Principal: { AWS: role },
    Action: ['kms:Encrypt', 'kms:Decrypt'],
    Resource: '*',
    Condition: {
      StringEquals: { 'kms:EncryptionContext:app': 'checksops-moov-onboarding' },
      'ForAllValues:StringEquals': { 'kms:EncryptionContextKeys': ['app', 'environment', 'tenant_id', 'field'] },
    },
  }));
});

test('the key policy conditions match what the API code writes and sends', () => {
  const documents = fs.readFileSync(path.join(REPO_ROOT, 'aws/functions/api/providers/onboarding/documents.mjs'), 'utf8');
  assert.match(documents, /export const DOCUMENTS_PREFIX = 'files\/verification-docs\/';/);
  assert.match(documents, new RegExp(`DOCUMENTS_KMS_KEY_ENV = '${DOCS.lambdaVariable}'`));
  const crypto = fs.readFileSync(path.join(REPO_ROOT, 'aws/functions/api/providers/onboarding/crypto.mjs'), 'utf8');
  assert.match(crypto, new RegExp(`PII_KMS_KEY_ENV = '${PII.lambdaVariable}'`));
  const context = crypto.split('const contextFor')[1].split('};')[0];
  assert.deepEqual([...context.matchAll(/^\s+([a-z_]+)(?::|,)/gm)].map((m) => m[1]), ['app', 'environment', 'tenant_id', 'field']);
  assert.match(context, /app: 'checksops-moov-onboarding'/);
});

test('the Lambda read fetches only the named fields, never the whole environment', () => {
  assert.equal(LAMBDA_QUERY, '{FunctionName:FunctionName,CodeSha256:CodeSha256,RevisionId:RevisionId,Role:Role,FilesBucket:Environment.Variables.FILES_BUCKET,COMPLIANCE_DOCUMENTS_KMS_KEY_ARN:Environment.Variables.COMPLIANCE_DOCUMENTS_KMS_KEY_ARN,MOOV_ONBOARDING_PII_KMS_KEY_ARN:Environment.Variables.MOOV_ONBOARDING_PII_KMS_KEY_ARN}');
});

test('cloudformation is a registered deployment type, so the receipts can validate', () => {
  assert.ok(DEPLOYMENT_TYPES.includes(KEYS_DEPLOYMENT_TYPE));
});

// --- classification -----------------------------------------------------------------------------

test('classify: ABSENT before create, LIVE for the pinned stack, BLOCKED on partial or drifted state', () => {
  assert.equal(cls(absent()).state, 'ABSENT');
  assert.equal(cls(live()).state, 'LIVE', cls(live()).problems.join(','));
  // Later, after the lambda-config change, the variables hold exactly these ARNs.
  assert.equal(cls(live({ lambda: { ...LAMBDA, COMPLIANCE_DOCUMENTS_KMS_KEY_ARN: keyArn(DOCS.alias), MOOV_ONBOARDING_PII_KMS_KEY_ARN: keyArn(PII.alias) } })).state, 'LIVE');
  assert.equal(cls(live({ lambda: { ...LAMBDA, COMPLIANCE_DOCUMENTS_KMS_KEY_ARN: keyArn(PII.alias) } })).state, 'BLOCKED');
  for (const lambda of [
    { ...LAMBDA, RevisionId: null },
    { ...LAMBDA, Role: 'arn:aws:iam::806168576068:role/other' },
    { ...LAMBDA, FilesBucket: 'checksops-staging-privatefilesbucket-erzqsolpucjp' },
    { ...LAMBDA, COMPLIANCE_DOCUMENTS_KMS_KEY_ARN: 'arn:aws:kms:us-east-1:806168576068:key/x' },
    { ...LAMBDA, MOOV_ONBOARDING_PII_KMS_KEY_ARN: 'arn:aws:kms:us-east-1:806168576068:key/y' },
  ]) {
    assert.equal(cls(absent(lambda)).state, 'BLOCKED', JSON.stringify(lambda));
  }
  for (const status of ['CREATE_IN_PROGRESS', 'CREATE_FAILED', 'ROLLBACK_COMPLETE', 'UPDATE_COMPLETE', 'UPDATE_ROLLBACK_COMPLETE']) {
    assert.equal(cls(live({ status })).state, 'BLOCKED', status);
  }
  assert.equal(cls(live({ templateBody: `${TEMPLATE.body}# edited\n` })).problems.includes('stack_template_drift'), true);
  const keyDrifts = [
    (a, d) => { d.metadata.KeyMetadata.Enabled = false; d.metadata.KeyMetadata.KeyState = 'Disabled'; },
    (a, d) => { d.metadata.KeyMetadata.KeyState = 'PendingDeletion'; },
    (a, d) => { d.rotation.KeyRotationEnabled = false; },
    (a, d) => { d.metadata.KeyMetadata.MultiRegion = true; },
    (a, d) => { d.metadata.KeyMetadata.Description = 'other'; },
    (a, d) => { d.tags.Tags = []; },
    (a, d) => { const p = JSON.parse(d.policy.Policy); p.Statement[1].Principal.AWS = 'arn:aws:iam::806168576068:root'; d.policy.Policy = JSON.stringify(p); },
    (a, d) => { const p = JSON.parse(d.policy.Policy); delete p.Statement[1].Condition; d.policy.Policy = JSON.stringify(p); },
    (a, d) => { const p = JSON.parse(d.policy.Policy); p.Statement.push({ Effect: 'Allow', Principal: { AWS: '*' }, Action: 'kms:*', Resource: '*' }); d.policy.Policy = JSON.stringify(p); },
    (a, d) => { d.policy.Policy = 'not json'; },
  ];
  for (const mutate of keyDrifts) {
    for (const target of ALIAS_NAMES) {
      const s = live({ mutateKey: (a, d) => { if (a === target) mutate(a, d); } });
      assert.equal(cls(s).state, 'BLOCKED', `${target} ${mutate}`);
    }
  }
  const drifts = [
    (s) => { s.stack = null; },
    (s) => { s.aliases[DOCS.alias] = null; s.keys[DOCS.alias] = null; },
    (s) => { s.aliases[PII.alias].TargetKeyId = KEY_IDS[DOCS.alias]; },
    (s) => { s.stack.Outputs.MoovOnboardingPiiKeyArn = keyArn(DOCS.alias); },
    (s) => { s.stack.Parameters.Extra = 'x'; },
    (s) => { s.stack.Outputs.Extra = 'x'; },
  ];
  for (const mutate of drifts) {
    const s = live();
    mutate(s);
    assert.equal(cls(s).state, 'BLOCKED', String(mutate));
  }
  // An alias already present without the stack is never ABSENT.
  assert.equal(cls(live({ aliases: [DOCS.alias] })).state, 'BLOCKED');
  const aliasOnly = absent();
  aliasOnly.aliases[PII.alias] = live().aliases[PII.alias];
  assert.equal(cls(aliasOnly).state, 'BLOCKED');
  // Without the template's policies nothing is LIVE.
  assert.equal(classify(live()).state, 'BLOCKED');
});

test('the live key policy compares by content, not by key order or whitespace', () => {
  const reordered = live({ mutateKey: (a, d) => {
    const p = JSON.parse(d.policy.Policy);
    d.policy.Policy = JSON.stringify({ Statement: p.Statement.map((st) => Object.fromEntries(Object.entries(st).reverse())), Version: p.Version }, null, 2);
  } });
  assert.equal(cls(reordered).state, 'LIVE');
  const actionOrder = live({ mutateKey: (a, d) => {
    const p = JSON.parse(d.policy.Policy);
    p.Statement[1].Action.reverse();
    d.policy.Policy = JSON.stringify(p);
  } });
  assert.equal(cls(actionOrder).state, 'BLOCKED', 'array order is content');
});

// --- exact AWS arguments ------------------------------------------------------------------------

test('create-stack arguments: pinned template body, no parameters, no capabilities, no rollback-delete', () => {
  const args = createStackArgs({ templateBody: TEMPLATE.body });
  assert.deepEqual(args, [
    'cloudformation', 'create-stack',
    '--stack-name', 'checksops-production-onboarding-keys',
    '--template-body', TEMPLATE.body,
    '--on-failure', 'DO_NOTHING',
  ]);
  assert.equal(createHash('sha256').update(args[5]).digest('hex'), TEMPLATE_SHA256);
});

test('waitForStack polls until the stack settles and times out instead of retrying', () => {
  const statuses = ['CREATE_IN_PROGRESS', 'CREATE_IN_PROGRESS', 'CREATE_COMPLETE'];
  let sleeps = 0;
  assert.equal(waitForStack({}, { describe: () => statuses.shift(), sleep: () => { sleeps += 1; } }), 'CREATE_COMPLETE');
  assert.equal(sleeps, 2);
  assert.equal(waitForStack({}, { describe: () => 'CREATE_FAILED', sleep: () => {} }), 'CREATE_FAILED');
  let t = 0;
  assert.throws(() => waitForStack({}, { describe: () => 'CREATE_IN_PROGRESS', sleep: () => {}, now: () => (t += 60_000), timeoutMs: 120_000 }), /stack_wait_timeout/);
});

// --- verify logic -------------------------------------------------------------------------------

test('verify: create must produce exactly the pinned stack and keys with the Lambda unmoved', () => {
  const opts = { mode: 'create', expectedPolicies: POLICIES };
  assert.doesNotThrow(() => assertExpectedAfter(absent(), live(), opts));
  assert.throws(() => assertExpectedAfter(absent(), live({ lambda: { ...LAMBDA, RevisionId: 'moved' } }), opts), /post_write_lambda_moved/);
  assert.throws(() => assertExpectedAfter(absent(), live({ lambda: { ...LAMBDA, COMPLIANCE_DOCUMENTS_KMS_KEY_ARN: keyArn(DOCS.alias) } }), opts), /post_write_lambda_moved/);
  assert.throws(() => assertExpectedAfter(absent(), live({ status: 'ROLLBACK_COMPLETE' }), opts), /post_write_not_live/);
  assert.throws(() => assertExpectedAfter(absent(), live({ mutateKey: (a, d) => { d.rotation.KeyRotationEnabled = false; } }), opts), /post_write_not_live/);
  assert.throws(() => assertExpectedAfter(live(), live(), opts), /post_write_create_precondition/);
  assert.throws(() => assertExpectedAfter(absent(), live(), { ...opts, mode: 'update' }), /unknown_mode/);
});

// --- preflight refusals -------------------------------------------------------------------------

test('the approval phrase is exact and appears in the workflow', () => {
  assert.equal(approvalPhraseFor('create'), 'CREATE ONBOARDING KEYS IN PRODUCTION');
  assert.ok(WORKFLOW.includes(CREATE_PHRASE));
  assert.throws(() => approvalPhraseFor('update'), (e) => e.code === CODES.INVALID_MANIFEST);
  const fp = snapshotFingerprint(absent());
  const base = { mode: 'create', approval: CREATE_PHRASE, stagingAcceptance: STAGING_REF, expectedFingerprint: fp, liveFingerprint: fp };
  assert.doesNotThrow(() => validateChangeInputs(base));
  for (const approval of ['create onboarding keys in production', `${CREATE_PHRASE} `, 'CREATE CHECKALT STATUS SCHEDULE IN PRODUCTION', '']) {
    assert.throws(() => validateChangeInputs({ ...base, approval }), (e) => e.code === CODES.PRODUCTION_APPROVAL_REQUIRED, approval);
  }
  assert.throws(() => validateChangeInputs({ ...base, stagingAcceptance: 'staging ok' }), (e) => e.code === CODES.PRODUCTION_APPROVAL_REQUIRED);
  assert.throws(() => validateChangeInputs({ ...base, stagingAcceptance: 'https://github.com/someone/else/pull/1' }), (e) => e.code === CODES.PRODUCTION_APPROVAL_REQUIRED);
  assert.throws(() => validateChangeInputs({ ...base, expectedFingerprint: '' }), (e) => e.code === CODES.INVALID_MANIFEST);
  assert.throws(() => validateChangeInputs({ ...base, expectedFingerprint: 'a'.repeat(64) }), (e) => e.code === CODES.DEPLOYMENT_COLLISION);
});

test('preflight refuses anything but main and an incomplete identity', () => {
  assert.throws(() => workflowIdentity({ GITHUB_SHA: SHA, GITHUB_REF_NAME: 'feature', GITHUB_ACTOR: 'x', GITHUB_RUN_ID: '1' }), (e) => e.code === CODES.UNRELATED_MUTATION);
  assert.throws(() => workflowIdentity({ GITHUB_SHA: 'short', GITHUB_REF_NAME: 'main', GITHUB_ACTOR: 'x', GITHUB_RUN_ID: '1' }), (e) => e.code === CODES.ANONYMOUS_DEPLOYMENT);
  assert.equal(workflowIdentity({ GITHUB_SHA: SHA, GITHUB_REF_NAME: 'main', GITHUB_ACTOR: 'x', GITHUB_RUN_ID: '7' }).workstreamId, 'github-production-onboarding-keys-7');
});

function tmpRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'checksops-onboarding-keys-'));
  fs.mkdirSync(path.join(root, 'ops/deployment-guard'), { recursive: true });
  fs.copyFileSync(path.join(REPO_ROOT, 'ops/deployment-guard/accepted-contracts.json'), path.join(root, 'ops/deployment-guard/accepted-contracts.json'));
  return root;
}

// A fake AWS: never calls AWS. runAws records the exact arguments and applies them to the state.
function fakeAws(initial, { onRun = null, settle = null } = {}) {
  const state = { snapshot: initial, calls: [] };
  return {
    state,
    readSnapshot: () => structuredClone(state.snapshot),
    runAws: (args) => {
      state.calls.push(args);
      if (onRun) onRun(state, args);
      else if (args[1] === 'create-stack') state.snapshot = live({ lambda: structuredClone(state.lambdaRaw || LAMBDA) });
      return {};
    },
    waitForStack: () => settle || state.snapshot.stack?.StackStatus,
    failureEvents: () => [],
  };
}

const ENV = { GITHUB_SHA: SHA, GITHUB_REF_NAME: 'main', GITHUB_ACTOR: 'owner', GITHUB_RUN_ID: '4242' };

async function preflightCreate(root, aws, extra = {}, deps = {}) {
  const fp = snapshotFingerprint(aws.readSnapshot());
  return preflight({
    ...ENV,
    CHECKSOPS_ONBOARDING_KEYS_MODE: 'create',
    CHECKSOPS_EXPECTED_SNAPSHOT_SHA256: fp,
    CHECKSOPS_STAGING_ACCEPTANCE_REFERENCE: STAGING_REF,
    CHECKSOPS_ONBOARDING_KEYS_APPROVAL: CREATE_PHRASE,
    ...extra,
  }, { root, readSnapshot: aws.readSnapshot, signer: (unsigned) => unsigned, ...deps });
}

function writerEnv(result) {
  return {
    CHECKSOPS_PRODUCTION_ONBOARDING_KEYS_EXECUTE: '1',
    CHECKSOPS_DEPLOYMENT_GUARD_APPLY: '1',
    CHECKSOPS_DEPLOYMENT_GUARD_RECEIPT: result.authorization.receiptFile,
    CHECKSOPS_ONBOARDING_KEYS_INPUT: result.authorization.keysInput,
    CHECKSOPS_WORKSTREAM_ID: result.identity.workstreamId,
    CHECKSOPS_COMMIT: SHA,
  };
}

const writerDeps = (aws, root) => ({ readSnapshot: aws.readSnapshot, runAws: aws.runAws, waitForStack: aws.waitForStack, failureEvents: aws.failureEvents, guardRoot: root });

test('inspect never writes and reports the live state', async () => {
  const root = tmpRoot();
  const aws = fakeAws(absent());
  const result = await preflight({ ...ENV, CHECKSOPS_ONBOARDING_KEYS_MODE: 'inspect' }, { root, readSnapshot: aws.readSnapshot });
  assert.equal(result.state, 'ABSENT');
  assert.equal(result.mutation, false);
  assert.equal(result.stack_status, 'ABSENT');
  assert.equal(result.documents_key, 'ABSENT');
  assert.equal(result.pii_key, 'ABSENT');
  assert.equal(result.lambda_revision_id, LAMBDA.RevisionId);
  assert.equal(result.template_sha256, TEMPLATE_SHA256);
  assert.equal(result.snapshot_sha256, snapshotFingerprint(absent()));
  assert.equal(aws.state.calls.length, 0);
  assert.equal(fs.existsSync(path.join(root, '.deployment-guard')), false, 'inspect takes no lease and issues no receipt');
  const after = await preflight({ ...ENV, CHECKSOPS_ONBOARDING_KEYS_MODE: 'inspect' }, { root, readSnapshot: () => live() });
  assert.equal(after.state, 'LIVE');
  assert.equal(after.documents_key, keyArn(DOCS.alias));
});

test('preflight refuses template hash drift before reading AWS, and unknown modes', async () => {
  const root = tmpRoot();
  let reads = 0;
  await assert.rejects(preflight({ ...ENV, CHECKSOPS_ONBOARDING_KEYS_MODE: 'inspect' }, {
    root,
    readSnapshot: () => { reads += 1; return absent(); },
    readTemplate: () => ({ body: `${TEMPLATE.body} `, sha256: 'f'.repeat(64) }),
  }), (e) => e.code === CODES.DEPLOYMENT_COLLISION && /pinned sha256/.test(e.message));
  for (const mode of ['update', 'delete', 'set-state']) {
    await assert.rejects(preflight({ ...ENV, CHECKSOPS_ONBOARDING_KEYS_MODE: mode }, { root, readSnapshot: () => { reads += 1; return absent(); } }), (e) => e.code === CODES.INVALID_MANIFEST, mode);
  }
  assert.equal(reads, 0);
});

test('preflight create refuses a present stack or alias, a stale inspect hash, a wrong phrase, no staging reference and non-main', async () => {
  const root = tmpRoot();
  await assert.rejects(preflightCreate(root, fakeAws(live())), (e) => e.code === CODES.DEPLOYMENT_COLLISION && /absent/.test(e.message));
  const aliasOnly = absent();
  aliasOnly.aliases[DOCS.alias] = live().aliases[DOCS.alias];
  await assert.rejects(preflightCreate(root, fakeAws(aliasOnly)), (e) => e.code === CODES.DEPLOYMENT_COLLISION);
  await assert.rejects(preflightCreate(root, fakeAws(absent({ ...LAMBDA, FilesBucket: 'other' }))), (e) => e.code === CODES.DEPLOYMENT_COLLISION);
  const aws = fakeAws(absent());
  await assert.rejects(preflightCreate(root, aws, { CHECKSOPS_EXPECTED_SNAPSHOT_SHA256: 'b'.repeat(64) }), (e) => e.code === CODES.DEPLOYMENT_COLLISION);
  await assert.rejects(preflightCreate(root, aws, { CHECKSOPS_ONBOARDING_KEYS_APPROVAL: 'yes' }), (e) => e.code === CODES.PRODUCTION_APPROVAL_REQUIRED);
  await assert.rejects(preflightCreate(root, aws, { CHECKSOPS_STAGING_ACCEPTANCE_REFERENCE: '' }), (e) => e.code === CODES.PRODUCTION_APPROVAL_REQUIRED);
  await assert.rejects(preflightCreate(root, aws, { GITHUB_REF_NAME: 'claude/branch' }), (e) => e.code === CODES.UNRELATED_MUTATION);
  assert.equal(aws.state.calls.length, 0);
  assert.equal(fs.existsSync(path.join(root, '.deployment-guard')), false, 'a refused create takes no lease');
});

// --- end to end with a fake AWS -----------------------------------------------------------------

test('create: the receipt binds the snapshot, the stack and both aliases; the writer sends exactly one create-stack; verify passes; the receipt is single-use', async () => {
  const root = tmpRoot();
  const aws = fakeAws(absent());
  const result = await preflightCreate(root, aws);
  const receipt = JSON.parse(fs.readFileSync(result.authorization.receiptFile, 'utf8'));
  assert.equal(receipt.deployment_type, KEYS_DEPLOYMENT_TYPE);
  assert.equal(receipt.target_component, KEYS_TARGET_COMPONENT);
  assert.equal(receipt.target_environment, 'production');
  assert.deepEqual(receipt.owned_components, ownedComponentsFor('create'));
  assert.deepEqual(receipt.owned_components, [
    'stack:checksops-production-onboarding-keys:create',
    'alias:alias/checksops-production-compliance-documents',
    'alias:alias/checksops-production-moov-onboarding-pii',
  ]);
  assert.deepEqual(receipt.preflight_live_fingerprint, absent());
  assert.equal(writer(writerEnv(result), writerDeps(aws, root)), 0);
  assert.equal(aws.state.calls.length, 1);
  assert.deepEqual(aws.state.calls[0], createStackArgs({ templateBody: TEMPLATE.body }));
  assert.equal(cls(aws.readSnapshot()).state, 'LIVE');
  const verified = await preflight({ ...ENV, CHECKSOPS_ONBOARDING_KEYS_MODE: 'verify', CHECKSOPS_ONBOARDING_KEYS_INPUT: result.authorization.keysInput }, { root, readSnapshot: aws.readSnapshot });
  assert.equal(verified.state, 'VERIFIED');
  assert.equal(verified.stack_status, 'CREATE_COMPLETE');
  assert.equal(verified.documents_key, keyArn(DOCS.alias));
  assert.equal(verified.pii_key, keyArn(PII.alias));
  assert.equal(verified.lambda_revision_id, LAMBDA.RevisionId);
  // Verify fails closed if a key policy differs from the template's.
  aws.state.snapshot = live({ mutateKey: (a, d) => { if (a === PII.alias) d.policy.Policy = livePolicyString(DOCS.alias); } });
  await assert.rejects(preflight({ ...ENV, CHECKSOPS_ONBOARDING_KEYS_MODE: 'verify', CHECKSOPS_ONBOARDING_KEYS_INPUT: result.authorization.keysInput }, { root, readSnapshot: aws.readSnapshot }), (e) => e.code === CODES.DEPLOYMENT_COLLISION && /key_policy_drift/.test(e.details.reason));
  // Replay of the same receipt is refused before any write.
  aws.state.snapshot = absent();
  assert.throws(() => writer(writerEnv(result), writerDeps(aws, root)), /receipt_consumption_failed|guard_refused/);
  assert.equal(aws.state.calls.length, 1);
});

test('the writer refuses when anything moved after the receipt was issued', async () => {
  const aliasOnly = absent();
  aliasOnly.aliases[PII.alias] = live().aliases[PII.alias];
  for (const moved of [absent({ ...LAMBDA, RevisionId: 'rev-moved' }), aliasOnly]) {
    const root = tmpRoot();
    const aws = fakeAws(absent());
    const result = await preflightCreate(root, aws);
    aws.state.snapshot = moved;
    assert.throws(() => writer(writerEnv(result), writerDeps(aws, root)), /guard_refused|preflight_state/);
    assert.equal(aws.state.calls.length, 0);
  }
});

test('the writer reports a failed create and never retries or deletes', async () => {
  const root = tmpRoot();
  const aws = fakeAws(absent(), {
    onRun: (state) => { state.snapshot = live({ status: 'CREATE_FAILED' }); },
    settle: 'CREATE_FAILED',
  });
  const result = await preflightCreate(root, aws);
  assert.throws(() => writer(writerEnv(result), writerDeps(aws, root)), /stack_create_failed:CREATE_FAILED/);
  assert.equal(aws.state.calls.length, 1);
  assert.equal(aws.state.calls.some((args) => /delete|update/.test(args[1])), false);
});

test('the writer fails closed when the create left something other than the pinned stack', async () => {
  for (const after of [
    live({ lambda: { ...LAMBDA, RevisionId: 'moved-during-write' } }),
    live({ mutateKey: (a, d) => { d.rotation.KeyRotationEnabled = false; } }),
  ]) {
    const root = tmpRoot();
    const aws = fakeAws(absent(), { onRun: (state) => { state.snapshot = after; }, settle: 'CREATE_COMPLETE' });
    const result = await preflightCreate(root, aws);
    assert.throws(() => writer(writerEnv(result), writerDeps(aws, root)), /post_write_lambda_moved|post_write_not_live/);
    assert.equal(aws.state.calls.length, 1);
  }
});

test('the writer refuses without a receipt, with another receipt, with caller-supplied stack input, another mode, no approval, template drift and plan-only', async () => {
  const root = tmpRoot();
  const aws = fakeAws(absent());
  const input = path.join(root, 'input.json');
  const approval = { approved: true, workstream_id: 'ws-other' };
  const staging = { ok: true, reference: STAGING_REF };

  // No receipt at all.
  fs.writeFileSync(input, JSON.stringify({ mode: 'create', workstream_id: 'ws-other', commit: SHA, approval, staging_acceptance: staging }));
  const noReceipt = { CHECKSOPS_PRODUCTION_ONBOARDING_KEYS_EXECUTE: '1', CHECKSOPS_DEPLOYMENT_GUARD_APPLY: '1', CHECKSOPS_ONBOARDING_KEYS_INPUT: input };
  assert.throws(() => writer(noReceipt, writerDeps(aws, root)), /guard_refused/);

  // A receipt whose lease is gone.
  const lease = acquireLease(root, { workstream_id: 'ws-other', component: KEYS_TARGET_COMPONENT, environment: 'production', commit: SHA, operator: 'x' });
  const issued = issueReceipt(root, {
    workstream_id: 'ws-other', branch: 'main', commit: SHA, target_environment: 'production', target_component: KEYS_TARGET_COMPONENT,
    deployment_type: KEYS_DEPLOYMENT_TYPE, owned_components: ownedComponentsFor('create'), preflight_live_fingerprint: absent(), lease: lease.details.lease,
  });
  assert.equal(issued.ok, true, issued.message);
  const env = { ...noReceipt, CHECKSOPS_DEPLOYMENT_GUARD_RECEIPT: issued.details.file };
  fs.rmSync(path.join(root, '.deployment-guard', 'leases'), { recursive: true, force: true });
  assert.throws(() => writer(env, writerDeps(aws, root)), /guard_refused/);

  // Another deployment type for the same component.
  const root2 = tmpRoot();
  const lease2 = acquireLease(root2, { workstream_id: 'ws-other', component: KEYS_TARGET_COMPONENT, environment: 'production', commit: SHA, operator: 'x' });
  const other = issueReceipt(root2, {
    workstream_id: 'ws-other', branch: 'main', commit: SHA, target_environment: 'production', target_component: KEYS_TARGET_COMPONENT,
    deployment_type: 'infra-mutate', owned_components: ownedComponentsFor('create'), preflight_live_fingerprint: absent(), lease: lease2.details.lease,
  });
  assert.throws(() => writer({ ...noReceipt, CHECKSOPS_DEPLOYMENT_GUARD_RECEIPT: other.details.file }, writerDeps(aws, root2)), /guard_refused|receipt_type_mismatch/);

  // A receipt for the Check Alt schedule component cannot create this stack.
  const root6 = tmpRoot();
  const lease6 = acquireLease(root6, { workstream_id: 'ws-other', component: 'production-checkalt-status-schedule', environment: 'production', commit: SHA, operator: 'x' });
  const schedule = issueReceipt(root6, {
    workstream_id: 'ws-other', branch: 'main', commit: SHA, target_environment: 'production', target_component: 'production-checkalt-status-schedule',
    deployment_type: KEYS_DEPLOYMENT_TYPE, owned_components: ownedComponentsFor('create'), preflight_live_fingerprint: absent(), lease: lease6.details.lease,
  });
  assert.throws(() => writer({ ...noReceipt, CHECKSOPS_DEPLOYMENT_GUARD_RECEIPT: schedule.details.file }, writerDeps(aws, root6)), /guard_refused/);

  // Caller-supplied template or parameters, or another mode.
  for (const extra of [{ template_body: 'Resources: {}' }, { parameters: [] }, { capabilities: ['CAPABILITY_IAM'] }, { delete: true }]) {
    fs.writeFileSync(input, JSON.stringify({ mode: 'create', ...extra }));
    assert.throws(() => writer(noReceipt, writerDeps(aws, root)), /caller_supplied_stack_forbidden/);
  }
  for (const mode of ['update', 'delete', 'set-state']) {
    fs.writeFileSync(input, JSON.stringify({ mode }));
    assert.throws(() => writer(noReceipt, writerDeps(aws, root)), /unknown_mode/);
  }

  // A receipt with different owned components is refused.
  const root3 = tmpRoot();
  const lease3 = acquireLease(root3, { workstream_id: 'ws-other', component: KEYS_TARGET_COMPONENT, environment: 'production', commit: SHA, operator: 'x' });
  const narrow = issueReceipt(root3, {
    workstream_id: 'ws-other', branch: 'main', commit: SHA, target_environment: 'production', target_component: KEYS_TARGET_COMPONENT,
    deployment_type: KEYS_DEPLOYMENT_TYPE, owned_components: [`stack:${STACK_NAME}:create`], preflight_live_fingerprint: absent(), lease: lease3.details.lease,
  });
  fs.writeFileSync(input, JSON.stringify({ mode: 'create', workstream_id: 'ws-other', commit: SHA, approval, staging_acceptance: staging }));
  assert.throws(() => writer({ ...noReceipt, CHECKSOPS_DEPLOYMENT_GUARD_RECEIPT: narrow.details.file }, writerDeps(aws, root3)), /receipt_component_mismatch/);

  // No approval in the input.
  const root4 = tmpRoot();
  const result4 = await preflightCreate(root4, aws);
  const noApproval = JSON.parse(fs.readFileSync(result4.authorization.keysInput, 'utf8'));
  delete noApproval.approval;
  fs.writeFileSync(result4.authorization.keysInput, JSON.stringify(noApproval));
  assert.throws(() => writer(writerEnv(result4), writerDeps(aws, root4)), /production_gate/);

  // Template drift at write time.
  const root5 = tmpRoot();
  const result5 = await preflightCreate(root5, aws);
  assert.throws(() => writer(writerEnv(result5), { ...writerDeps(aws, root5), readTemplate: () => ({ body: 'x', sha256: 'e'.repeat(64) }) }), /template_hash_drift/);

  assert.equal(writer({}, writerDeps(aws, root)), 2);
  assert.equal(aws.state.calls.length, 0);
});

// --- workflow wiring ----------------------------------------------------------------------------

test('the workflow: inspect and create only, main only, production environment, its own concurrency group, these tests', () => {
  assert.match(WORKFLOW, /options:\n\s+- inspect\n\s+- create\n\s+approved_commit:/);
  assert.doesNotMatch(WORKFLOW, /- update\n|- delete\n|set-state/);
  assert.match(WORKFLOW, /^\s+environment: production$/m);
  assert.match(WORKFLOW, /group: guarded-production-onboarding-keys\n\s+cancel-in-progress: false/);
  assert.match(WORKFLOW, /test "\$GITHUB_REF" = "refs\/heads\/main"/);
  assert.match(WORKFLOW, /test "\$\(git rev-parse HEAD\)" = "\$GITHUB_SHA"/);
  assert.match(WORKFLOW, /test "\$INPUT_APPROVED_COMMIT" = "\$GITHUB_SHA"/);
  assert.match(WORKFLOW, /EXPECTED_ROLE_ARN="arn:aws:iam::806168576068:role\/ChecksOpsGitHubProductionLambdaOverlay"/);
  assert.ok(WORKFLOW.includes('node --test aws/tests/production-onboarding-keys-writer.test.mjs'));
  assert.ok(WORKFLOW.includes('node --test aws/tests/production-onboarding-keys-policy.test.mjs'));
  assert.ok(WORKFLOW.includes('node scripts/deployment-guard/scan-bypass.mjs'));
  // The only AWS writes go through the writer; the workflow itself never calls CloudFormation or KMS writes.
  assert.doesNotMatch(WORKFLOW, /aws cloudformation|aws lambda|create-stack|update-stack|delete-stack|create-key|create-alias|put-key-policy|schedule-key-deletion/);
  assert.match(WORKFLOW, /if: \$\{\{ inputs\.mode != 'inspect' \}\}\n\s+shell: bash\n\s+env:\n\s+CHECKSOPS_PRODUCTION_ONBOARDING_KEYS_EXECUTE: "1"/);
});

test('the guard lists and the bypass inventory include the new files', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  const ci = fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/deployment-guard.yml'), 'utf8');
  for (const file of ['aws/tests/production-onboarding-keys-writer.test.mjs', 'aws/tests/production-onboarding-keys-policy.test.mjs']) {
    assert.ok(pkg.scripts['test:deployment-guard'].includes(file), file);
    assert.ok(ci.includes(file), file);
  }
  const inventory = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'ops/deployment-guard/bypass-inventory.json'), 'utf8'));
  const byPath = Object.fromEntries(inventory.scripts.map((row) => [row.path, row]));
  assert.equal(byPath['scripts/deployment-guard/production-onboarding-keys.mjs']?.classification, 'GUARDED');
  assert.equal(byPath['scripts/deployment-guard/github-production-onboarding-keys.mjs']?.classification, 'SAFE');
});

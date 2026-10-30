#!/usr/bin/env node
/**
 * Receipt-gated writer for the production CloudFormation stack checksops-production-onboarding-keys
 * (the KMS keys for Compliance & Docs uploads and onboarding PII field encryption).
 *
 * Exact permitted mutation:
 *   create: CreateStack with exactly the bytes of aws/production/onboarding-keys.yaml (sha256 pinned
 *           below), no parameters, no capabilities (the template creates no IAM resource),
 *           OnFailure DO_NOTHING.
 * There is no update and no delete. The keys are DeletionPolicy/UpdateReplacePolicy Retain.
 *
 * The stack, the two aliases (and the key each one targets: metadata, key policy, rotation, tags)
 * and the prep Lambda configuration (RevisionId, role, FILES_BUCKET and the two KMS key variables)
 * are read into one normalized snapshot. The signed receipt's preflight fingerprint is that whole
 * snapshot. The writer re-reads before and immediately before the write, waits for the stack to
 * settle, never retries and never deletes, and requires the post-write snapshot to hold exactly the
 * pinned stack with nothing else moved. No Lambda, IAM role, bucket, API Gateway, CloudFront, SQL,
 * Cognito, provider, financial or SPA mutation is performed; setting
 * COMPLIANCE_DOCUMENTS_KMS_KEY_ARN and MOOV_ONBOARDING_PII_KMS_KEY_ARN on the Lambda is a later,
 * separate guarded-production-lambda-config.yml change.
 *
 * Run only from guarded-production-onboarding-keys.yml after github-production-onboarding-keys.mjs
 * issued the receipt.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { refuseUnguardedDeploy, resolveGuardRoot } from './require-guard.mjs';
import { consumeReceiptOnce } from './lib/consumed-receipts.mjs';
import { evaluateProductionGate } from './lib/production.mjs';

const AWS = process.env.AWS_CLI || process.env.AWS || 'aws';
const REGION = 'us-east-1';
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const ACCOUNT_ID = '806168576068';
export const STACK_NAME = 'checksops-production-onboarding-keys';
export const PREP_LAMBDA = 'checksops-production-prep-api';
export const PREP_LAMBDA_ROLE_ARN = `arn:aws:iam::${ACCOUNT_ID}:role/checksops-production-api-execution`;
export const FILES_BUCKET = `checksops-production-privatefiles-${ACCOUNT_ID}`;
export const TEMPLATE_PATH = 'aws/production/onboarding-keys.yaml';
// sha256 of the template bytes on an LF checkout, computed from the file with sha256sum and checked
// by the test against readTemplate(). A different file is a new reviewed change, never an updated
// number here.
export const TEMPLATE_SHA256 = 'e584bb95750afd6a174b76f47288e197316c225aadcadcd4508bb1d21d1d85c2';
export const KEYS_DEPLOYMENT_TYPE = 'cloudformation';
export const KEYS_TARGET_COMPONENT = 'production-onboarding-keys';
export const TAG_KEY = 'checksops-stack';
// One entry per key: logical id in the template, alias, output keys, Lambda variable, description.
export const KEYS = Object.freeze([
  Object.freeze({
    logicalId: 'ComplianceDocumentsKey',
    alias: 'alias/checksops-production-compliance-documents',
    arnOutput: 'ComplianceDocumentsKeyArn',
    aliasOutput: 'ComplianceDocumentsKeyAliasName',
    lambdaVariable: 'COMPLIANCE_DOCUMENTS_KMS_KEY_ARN',
    description: 'ChecksOps compliance documents (SSE-KMS) under files/verification-docs/.',
  }),
  Object.freeze({
    logicalId: 'MoovOnboardingPiiKey',
    alias: 'alias/checksops-production-moov-onboarding-pii',
    arnOutput: 'MoovOnboardingPiiKeyArn',
    aliasOutput: 'MoovOnboardingPiiKeyAliasName',
    lambdaVariable: 'MOOV_ONBOARDING_PII_KMS_KEY_ARN',
    description: 'ChecksOps Moov onboarding PII field encryption (EIN, representative DOB). Full SSNs are never stored.',
  }),
]);
export const ALIAS_NAMES = Object.freeze(KEYS.map((k) => k.alias));
export const aliasArn = (alias) => `arn:aws:kms:${REGION}:${ACCOUNT_ID}:${alias}`;

const sha256 = (v) => createHash('sha256').update(v).digest('hex');
const hash = (v) => sha256(JSON.stringify(v));
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export const snapshotFingerprint = (snapshot) => hash(snapshot);

/** Deep copy with object keys sorted, so a key policy compares by content, not by key order. */
export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical(value[k])]));
  }
  return value;
}

/** The owned components bind the requested change (the stack and its two aliases) into the receipt. */
export function ownedComponentsFor(mode) {
  if (mode === 'create') return [`stack:${STACK_NAME}:create`, ...ALIAS_NAMES.map((a) => `alias:${a}`)];
  throw new Error('unknown_mode');
}

export function readTemplate(root = repoRoot) {
  const bytes = fs.readFileSync(path.join(root, TEMPLATE_PATH));
  return { body: bytes.toString('utf8'), sha256: sha256(bytes) };
}

export function assertPinnedTemplate(template) {
  if (template.sha256 !== TEMPLATE_SHA256) {
    throw new Error(`template_hash_drift:${template.sha256}`);
  }
}

/** Returns the JSON object literal that starts at text[start] ('{'), honouring strings. */
function jsonObjectAt(text, start) {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i += 1) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i += 1;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  throw new Error('template_key_policy_unterminated');
}

function resolveSub(value) {
  if (Array.isArray(value)) return value.map(resolveSub);
  if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === 'Fn::Sub') {
      if (typeof value['Fn::Sub'] !== 'string') throw new Error('template_key_policy_sub_form');
      const out = value['Fn::Sub'].replaceAll('${AWS::AccountId}', ACCOUNT_ID).replaceAll('${AWS::Region}', REGION);
      if (/\$\{/.test(out)) throw new Error('template_key_policy_unresolved_sub');
      return out;
    }
    return Object.fromEntries(keys.map((k) => [k, resolveSub(value[k])]));
  }
  return value;
}

/**
 * The key policy of each key exactly as the pinned template defines it, with ${AWS::AccountId} and
 * ${AWS::Region} resolved for production. Read from the template bytes, so verify compares the live
 * policy with the template itself, not with a second copy.
 */
export function keyPoliciesFromTemplate(body) {
  const out = {};
  for (const key of KEYS) {
    const header = `\n  ${key.logicalId}:\n    Type: AWS::KMS::Key\n`;
    const at = body.indexOf(header);
    if (at < 0 || body.indexOf(header, at + 1) >= 0) throw new Error(`template_key_missing:${key.logicalId}`);
    const marker = '\n      KeyPolicy: {';
    const policyAt = body.indexOf(marker, at);
    const nextResource = body.slice(at + header.length).search(/\n {2}[A-Za-z]+:\n/);
    if (policyAt < 0 || (nextResource >= 0 && policyAt > at + header.length + nextResource)) {
      throw new Error(`template_key_policy_missing:${key.logicalId}`);
    }
    out[key.alias] = canonical(resolveSub(JSON.parse(jsonObjectAt(body, policyAt + marker.length - 1))));
  }
  return out;
}

function sortObject(obj) {
  return Object.fromEntries(Object.entries(obj || {}).sort(([a], [b]) => a.localeCompare(b)));
}

function parsePolicy(raw) {
  if (raw == null) return null;
  try { return canonical(JSON.parse(raw)); } catch { return { unparseable: true }; }
}

/**
 * aliases: the ListAliases entries; keyDetails: per alias name, the reads of the key it targets
 * ({ metadata, policy, rotation, tags }) or absent; lambda: the selected configuration fields.
 */
export function normalizeSnapshot({ stack, stackTemplateBody, aliases, keyDetails, lambda }) {
  const byName = Object.fromEntries((aliases || []).map((a) => [a.AliasName, a]));
  const aliasesOut = {};
  const keysOut = {};
  for (const name of ALIAS_NAMES) {
    const a = byName[name];
    aliasesOut[name] = a ? { AliasName: a.AliasName, AliasArn: a.AliasArn, TargetKeyId: a.TargetKeyId ?? null } : null;
    const d = keyDetails?.[name];
    const m = d?.metadata?.KeyMetadata;
    keysOut[name] = a && m ? {
      KeyId: m.KeyId,
      Arn: m.Arn,
      Enabled: m.Enabled,
      KeyState: m.KeyState,
      KeySpec: m.KeySpec,
      KeyUsage: m.KeyUsage,
      Origin: m.Origin,
      MultiRegion: m.MultiRegion,
      KeyManager: m.KeyManager,
      Description: m.Description,
      RotationEnabled: d.rotation?.KeyRotationEnabled ?? null,
      Policy: parsePolicy(d.policy?.Policy),
      Tags: sortObject(Object.fromEntries((d.tags?.Tags || []).map((t) => [t.TagKey, t.TagValue]))),
    } : null;
  }
  return {
    repository_template_sha256: TEMPLATE_SHA256,
    stack: stack ? {
      StackName: stack.StackName,
      StackId: stack.StackId,
      StackStatus: stack.StackStatus,
      Parameters: sortObject(Object.fromEntries((stack.Parameters || []).map((p) => [p.ParameterKey, p.ParameterValue]))),
      Outputs: sortObject(Object.fromEntries((stack.Outputs || []).map((o) => [o.OutputKey, o.OutputValue]))),
      TemplateSha256: stackTemplateBody == null ? null : sha256(typeof stackTemplateBody === 'string' ? stackTemplateBody : JSON.stringify(stackTemplateBody)),
    } : null,
    aliases: aliasesOut,
    keys: keysOut,
    lambda: lambda ? {
      FunctionName: lambda.FunctionName ?? null,
      CodeSha256: lambda.CodeSha256 ?? null,
      RevisionId: lambda.RevisionId ?? null,
      Role: lambda.Role ?? null,
      FilesBucket: lambda.FilesBucket ?? '',
      ...Object.fromEntries(KEYS.map((k) => [k.lambdaVariable, lambda[k.lambdaVariable] ?? ''])),
    } : null,
  };
}

function lambdaShape(s, errors) {
  const l = s.lambda;
  if (!l || l.FunctionName !== PREP_LAMBDA || !l.CodeSha256 || !l.RevisionId) {
    errors.push('prep_lambda_missing');
    return;
  }
  if (l.Role !== PREP_LAMBDA_ROLE_ARN) errors.push('prep_lambda_role_drift');
  // The documents key policy names this bucket; another bucket would never match it.
  if (l.FilesBucket !== FILES_BUCKET) errors.push('prep_lambda_files_bucket_drift');
}

/** The live key behind one alias holds the pinned shape. */
export function keyShapeErrors(key, alias, { expectedPolicy, expectedArn }) {
  const spec = KEYS.find((k) => k.alias === alias);
  const errors = [];
  if (!key) return [`key_missing:${alias}`];
  if (expectedArn && key.Arn !== expectedArn) errors.push(`key_arn_mismatch:${alias}`);
  if (key.Enabled !== true || key.KeyState !== 'Enabled') errors.push(`key_not_enabled:${alias}`);
  if (key.KeySpec !== 'SYMMETRIC_DEFAULT' || key.KeyUsage !== 'ENCRYPT_DECRYPT' || key.Origin !== 'AWS_KMS'
    || key.MultiRegion !== false || key.KeyManager !== 'CUSTOMER') errors.push(`key_type_drift:${alias}`);
  if (key.Description !== spec.description) errors.push(`key_description_drift:${alias}`);
  if (key.RotationEnabled !== true) errors.push(`key_rotation_off:${alias}`);
  if (!eq(key.Policy, expectedPolicy)) errors.push(`key_policy_drift:${alias}`);
  if (!eq(key.Tags, { [TAG_KEY]: STACK_NAME })) errors.push(`key_tags_drift:${alias}`);
  return errors;
}

/**
 * ABSENT:  stack and both aliases absent, prep Lambda present with its role and FILES_BUCKET and
 *          neither KMS variable set -> create may proceed.
 * LIVE:    stack CREATE_COMPLETE from the pinned template; each alias targets the key named in the
 *          stack outputs; each key enabled, rotation on, key policy equal to the template's; the
 *          Lambda variables unset or equal to those key ARNs.
 * BLOCKED: anything else (partial create, rollback, in-progress, drift, an alias held by another key).
 */
export function classify(s, { expectedPolicies } = {}) {
  const errors = [];
  lambdaShape(s, errors);
  if (s.repository_template_sha256 !== TEMPLATE_SHA256) errors.push('template_pin_drift');
  const anyAlias = ALIAS_NAMES.some((a) => s.aliases?.[a]);
  if (!s.stack && !anyAlias) {
    for (const k of KEYS) if (s.lambda && s.lambda[k.lambdaVariable] !== '') errors.push(`prep_lambda_${k.lambdaVariable}_already_set`);
    return { state: errors.length ? 'BLOCKED' : 'ABSENT', problems: errors, fingerprint: hash(s) };
  }
  if (!s.stack) errors.push('stack_missing_but_aliases_present');
  else {
    if (s.stack.StackName !== STACK_NAME) errors.push('stack_name_drift');
    if (s.stack.StackStatus !== 'CREATE_COMPLETE') errors.push(`stack_status_${s.stack.StackStatus}`);
    if (s.stack.TemplateSha256 !== TEMPLATE_SHA256) errors.push('stack_template_drift');
    if (Object.keys(s.stack.Parameters || {}).length) errors.push('stack_parameters_drift');
    const outputs = s.stack.Outputs || {};
    if (!eq(Object.keys(outputs).sort(), KEYS.flatMap((k) => [k.aliasOutput, k.arnOutput]).sort())) errors.push('stack_outputs_drift');
    const policies = expectedPolicies || {};
    for (const k of KEYS) {
      const alias = s.aliases?.[k.alias];
      const expectedArn = outputs[k.arnOutput];
      if (outputs[k.aliasOutput] !== k.alias) errors.push(`stack_output_alias_drift:${k.alias}`);
      if (!/^arn:aws:kms:us-east-1:806168576068:key\/[0-9a-f-]{36}$/.test(String(expectedArn || ''))) errors.push(`stack_output_arn_invalid:${k.alias}`);
      if (!alias) { errors.push(`alias_missing:${k.alias}`); continue; }
      if (alias.AliasArn !== aliasArn(k.alias)) errors.push(`alias_arn_drift:${k.alias}`);
      const key = s.keys?.[k.alias];
      if (key && alias.TargetKeyId !== key.KeyId) errors.push(`alias_target_drift:${k.alias}`);
      if (!policies[k.alias]) errors.push(`expected_policy_missing:${k.alias}`);
      errors.push(...keyShapeErrors(key, k.alias, { expectedPolicy: policies[k.alias], expectedArn }));
      const variable = s.lambda?.[k.lambdaVariable];
      if (variable !== '' && variable !== expectedArn) errors.push(`prep_lambda_${k.lambdaVariable}_drift`);
    }
  }
  return { state: errors.length ? 'BLOCKED' : 'LIVE', problems: errors, fingerprint: hash(s) };
}

/** The post-write snapshot holds exactly the pinned stack and nothing else moved. */
export function assertExpectedAfter(before, after, { mode, expectedPolicies }) {
  if (mode !== 'create') throw new Error('unknown_mode');
  const live = classify(after, { expectedPolicies });
  if (live.state !== 'LIVE') throw new Error('post_write_not_live:' + live.problems.join(','));
  if (!eq(after.lambda, before.lambda)) throw new Error('post_write_lambda_moved');
  if (after.repository_template_sha256 !== before.repository_template_sha256) throw new Error('post_write_template_moved');
  if (before.stack || ALIAS_NAMES.some((a) => before.aliases?.[a] || before.keys?.[a])) throw new Error('post_write_create_precondition');
  if (after.stack.StackStatus !== 'CREATE_COMPLETE') throw new Error('post_write_stack_status');
}

function awsJson(args, env = process.env) {
  const out = execFileSync(AWS, ['--region', REGION, '--output', 'json', ...args], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
  return out.trim() ? JSON.parse(out) : {};
}

function awsJsonOrAbsent(args, absentRe, env) {
  try {
    return awsJson(args, env);
  } catch (error) {
    const text = `${error?.stderr || ''}${error?.message || ''}`;
    if (absentRe.test(text)) return null;
    throw error;
  }
}

// Only these fields leave the Lambda configuration read; no other variable value is fetched.
export const LAMBDA_QUERY = `{FunctionName:FunctionName,CodeSha256:CodeSha256,RevisionId:RevisionId,Role:Role,FilesBucket:Environment.Variables.FILES_BUCKET,${KEYS.map((k) => `${k.lambdaVariable}:Environment.Variables.${k.lambdaVariable}`).join(',')}}`;

export function readSnapshot(env = process.env) {
  const stacks = awsJsonOrAbsent(['cloudformation', 'describe-stacks', '--stack-name', STACK_NAME], /does not exist/, env);
  const stack = stacks?.Stacks?.[0] || null;
  const template = stack
    ? awsJson(['cloudformation', 'get-template', '--stack-name', STACK_NAME, '--template-stage', 'Original'], env)
    : null;
  const aliases = (awsJson(['kms', 'list-aliases'], env).Aliases || []).filter((a) => ALIAS_NAMES.includes(a.AliasName));
  const keyDetails = {};
  for (const a of aliases) {
    if (!a.TargetKeyId) continue;
    keyDetails[a.AliasName] = {
      metadata: awsJson(['kms', 'describe-key', '--key-id', a.TargetKeyId], env),
      policy: awsJson(['kms', 'get-key-policy', '--key-id', a.TargetKeyId, '--policy-name', 'default'], env),
      rotation: awsJson(['kms', 'get-key-rotation-status', '--key-id', a.TargetKeyId], env),
      tags: awsJson(['kms', 'list-resource-tags', '--key-id', a.TargetKeyId], env),
    };
  }
  const lambda = awsJson(['lambda', 'get-function-configuration', '--function-name', PREP_LAMBDA, '--query', LAMBDA_QUERY], env);
  return normalizeSnapshot({ stack, stackTemplateBody: template?.TemplateBody ?? null, aliases, keyDetails, lambda });
}

/** The exact CreateStack call. Nothing caller-supplied reaches it. */
export function createStackArgs({ templateBody }) {
  return [
    'cloudformation', 'create-stack',
    '--stack-name', STACK_NAME,
    '--template-body', templateBody,
    '--on-failure', 'DO_NOTHING',
  ];
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Polls DescribeStacks until the stack leaves *_IN_PROGRESS. Never retries the write. */
export function waitForStack(env = process.env, { describe, sleep = sleepSync, intervalMs = 10_000, timeoutMs = 20 * 60_000, now = Date.now } = {}) {
  const read = describe || (() => awsJson(['cloudformation', 'describe-stacks', '--stack-name', STACK_NAME], env).Stacks?.[0]?.StackStatus);
  const deadline = now() + timeoutMs;
  for (;;) {
    const status = read();
    if (status && !/_IN_PROGRESS$/.test(status)) return status;
    if (now() >= deadline) throw new Error(`stack_wait_timeout:${status}`);
    sleep(intervalMs);
  }
}

function failureEvents(env) {
  try {
    const events = awsJson(['cloudformation', 'describe-stack-events', '--stack-name', STACK_NAME], env).StackEvents || [];
    return events.filter((e) => /FAILED/.test(e.ResourceStatus || '')).slice(0, 10)
      .map((e) => ({ LogicalResourceId: e.LogicalResourceId, ResourceStatus: e.ResourceStatus, ResourceStatusReason: e.ResourceStatusReason }));
  } catch {
    return [];
  }
}

function readInput(env) {
  const file = env.CHECKSOPS_ONBOARDING_KEYS_INPUT;
  if (!file) throw new Error('onboarding_keys_input_missing');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function main(env = process.env, deps = {}) {
  const read = deps.readSnapshot || readSnapshot;
  const runAws = deps.runAws || ((args) => awsJson(args, env));
  const wait = deps.waitForStack || (() => waitForStack(env));
  const events = deps.failureEvents || (() => failureEvents(env));
  if (env.CHECKSOPS_PRODUCTION_ONBOARDING_KEYS_EXECUTE !== '1') {
    process.stdout.write(JSON.stringify({ ok: false, plan_only: true, stack: STACK_NAME, template_sha256: TEMPLATE_SHA256 }) + '\n');
    return 2;
  }
  const input = readInput(env);
  if (input.template_body || input.template_url || input.parameters || input.capabilities || input.delete === true) {
    throw new Error('caller_supplied_stack_forbidden');
  }
  const mode = input.mode;
  if (mode !== 'create') throw new Error('unknown_mode');

  const template = (deps.readTemplate || readTemplate)(deps.repoRoot || repoRoot);
  assertPinnedTemplate(template);
  const expectedPolicies = keyPoliciesFromTemplate(template.body);

  const first = read(env);
  const checked = classify(first, { expectedPolicies });
  if (checked.state !== 'ABSENT') throw new Error(`preflight_state:${checked.state}:${checked.problems.join(',')}`);

  const authorized = refuseUnguardedDeploy({
    target_environment: 'production',
    target_component: KEYS_TARGET_COMPONENT,
    deployment_type: KEYS_DEPLOYMENT_TYPE,
    preflight_live_fingerprint: first,
    workstream_id: input.workstream_id || env.CHECKSOPS_WORKSTREAM_ID,
    commit: input.commit || env.CHECKSOPS_COMMIT,
    receipt_path: input.receipt_path,
  }, { env, now: deps.now, root: deps.guardRoot });
  if (!authorized.ok) throw new Error('guard_refused:' + (authorized.code || 'DEPLOYMENT_GUARD_REQUIRED'));
  const receipt = authorized.details.receipt;
  if (receipt.deployment_type !== KEYS_DEPLOYMENT_TYPE) throw new Error('receipt_type_mismatch');
  if (!eq(receipt.owned_components, ownedComponentsFor(mode)) || Object.hasOwn(receipt, 'owned_member_ops')) {
    throw new Error('receipt_component_mismatch');
  }

  // Mandatory TOCTOU read immediately before the only mutation.
  const second = read(env);
  const rechecked = classify(second, { expectedPolicies });
  if (rechecked.state !== 'ABSENT' || rechecked.fingerprint !== checked.fingerprint) {
    throw new Error('toctou_drift:' + rechecked.problems.join(','));
  }

  const gate = evaluateProductionGate({
    target_environment: 'production',
    deployment_type: KEYS_DEPLOYMENT_TYPE,
    workstream_id: receipt.workstream_id,
    production_fingerprint: { snapshot_sha256: checked.fingerprint },
    immediately_before_fingerprint: { snapshot_sha256: rechecked.fingerprint },
    staging_acceptance: input.staging_acceptance,
    approval: input.approval,
  });
  if (!gate.ok) throw new Error('production_gate:' + (gate.code || 'refused'));

  const consumed = consumeReceiptOnce(deps.guardRoot || resolveGuardRoot({}, env), receipt, {
    now: deps.now,
    actor: env.CHECKSOPS_OPERATOR || env.USER || null,
    script: 'production-onboarding-keys',
  });
  if (!consumed.ok) throw new Error('receipt_consumption_failed:' + (consumed.code || 'unknown'));

  runAws(createStackArgs({ templateBody: template.body }));

  const status = wait();
  if (status !== 'CREATE_COMPLETE') {
    // Report and stop: no retry, no delete, no rollback by this writer.
    process.stderr.write(JSON.stringify({ ok: false, stack: STACK_NAME, status, failure_events: events() }) + '\n');
    throw new Error(`stack_create_failed:${status}`);
  }

  const after = read(env);
  assertExpectedAfter(second, after, { mode, expectedPolicies });
  process.stdout.write(JSON.stringify({
    ok: true,
    stack: STACK_NAME,
    mode,
    status,
    key_arns: Object.fromEntries(KEYS.map((k) => [k.alias, after.stack.Outputs[k.arnOutput]])),
    before_fingerprint: checked.fingerprint,
    after_fingerprint: hash(after),
  }) + '\n');
  return 0;
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) { try { process.exitCode = main(); } catch (e) { process.stderr.write(JSON.stringify({ ok: false, message: e?.message || String(e) }) + '\n'); process.exitCode = 2; } }

/**
 * Pure logic for the guarded, staging-only Moov onboarding infrastructure writer
 * (scripts/deployment-guard/staging-moov-onboarding-infra.mjs).
 *
 * Creates only the onboarding pieces aws/template.yaml defines but the staging
 * stack never received (last stack deploy 2026-09-03):
 *   - KMS keys + aliases for onboarding PII and compliance documents (rotation on)
 *   - inline role policy MoovOnboardingKms on the staging API function role
 *   - private files bucket policy (SSE-KMS required under files/verification-docs/)
 *   - bucket CORS PUT-rule extension and two lifecycle rules (existing rules kept)
 *   - three Lambda environment keys (all existing keys preserved, RevisionId CAS)
 *
 * No AWS calls here. Environment variable VALUES never leave this module except
 * inside the exact merged map handed to the adapter for the CAS update; snapshots
 * carry key names, the three onboarding values (ARNs / "false") and a digest.
 */
import { createHash } from 'node:crypto';

export const COMPONENT = 'staging-moov-onboarding-infra';
export const DEPLOYMENT_TYPE = 'staging-onboarding-infra';
export const TARGET_ENVIRONMENT = 'staging';
export const EXECUTE_ENV = 'CHECKSOPS_STAGING_ONBOARDING_INFRA_EXECUTE';

export const REGION = 'us-east-1';
export const ACCOUNT_ID = '806168576068';
export const FUNCTION_NAME = 'checksops-staging-api';
export const ROLE_NAME = 'checksops-staging-ApiFunctionRole-7E7XRyLe3nyi';
export const ROLE_ARN = `arn:aws:iam::${ACCOUNT_ID}:role/${ROLE_NAME}`;
export const BUCKET = 'checksops-staging-privatefilesbucket-erzqsolpucjp';
export const BUCKET_ARN = `arn:aws:s3:::${BUCKET}`;
export const DOCUMENTS_PREFIX = 'files/verification-docs/';
export const DOCUMENTS_OBJECT_ARN = `${BUCKET_ARN}/${DOCUMENTS_PREFIX}*`;
export const ROLE_POLICY_NAME = 'MoovOnboardingKms';
export const ROOT_PRINCIPAL = `arn:aws:iam::${ACCOUNT_ID}:root`;
export const KMS_VIA_S3 = `s3.${REGION}.amazonaws.com`;
export const PII_ENCRYPTION_APP = 'checksops-moov-onboarding';
export const PII_CONTEXT_KEYS = Object.freeze(['app', 'environment', 'tenant_id', 'field']);

export const ENV_PII_KEY = 'MOOV_ONBOARDING_PII_KMS_KEY_ARN';
export const ENV_DOCS_KEY = 'COMPLIANCE_DOCUMENTS_KMS_KEY_ARN';
export const ENV_PRODUCTION_FLAG = 'AWS_MOOV_ONBOARDING_PRODUCTION_ENABLED';
export const ONBOARDING_ENV_KEYS = Object.freeze([ENV_PII_KEY, ENV_DOCS_KEY, ENV_PRODUCTION_FLAG]);
export const LAMBDA_ENV_LIMIT_BYTES = 4096;

export const KEY_TAG = 'checksops:onboarding-infra-key';
export const KEYS = Object.freeze({
  pii: Object.freeze({
    slot: 'pii',
    alias: 'alias/checksops-staging-moov-onboarding-pii',
    description: 'ChecksOps Moov onboarding PII field encryption (EIN, representative DOB). Full SSNs are never stored.',
  }),
  docs: Object.freeze({
    slot: 'docs',
    alias: 'alias/checksops-staging-compliance-documents',
    description: 'ChecksOps compliance documents (SSE-KMS) under files/verification-docs/.',
  }),
});
export const KEY_TAGS = (slot) => [
  { TagKey: KEY_TAG, TagValue: slot },
  { TagKey: 'checksops:component', TagValue: COMPONENT },
  { TagKey: 'Environment', TagValue: 'staging' },
];

export const STAGING_ORIGINS = Object.freeze([
  'https://checksops.com',
  'https://www.checksops.com',
  'https://staging.checksops.com',
]);
/**
 * Headers added to the existing PUT rule. The browser (src/lib/payments/
 * moovOnboarding.ts xhrPut) sets exactly the presigned headers from
 * documents.mjs createUploadUrl: Content-Type, Content-Length and the two
 * SSE-KMS headers. Browsers never send Content-Length in a preflight (forbidden
 * header), so the two SSE-KMS headers are what the preflight needs; content-length
 * matches aws/template.yaml and is harmless. ETag / x-amz-version-id exposure
 * matches the template (the SPA does not read them today).
 */
export const PUT_HEADERS_ADDED = Object.freeze([
  'content-length',
  'x-amz-server-side-encryption',
  'x-amz-server-side-encryption-aws-kms-key-id',
]);
export const PUT_EXPOSE_ADDED = Object.freeze(['ETag', 'x-amz-version-id']);

export const LIFECYCLE_BASELINE_ID = 'AbortIncompleteMultipartUploads';
export const LIFECYCLE_UPLOADS = Object.freeze({
  ID: 'ComplianceDocumentUploadsExpire',
  prefix: `${DOCUMENTS_PREFIX}uploads/`,
  expirationDays: 1,
  noncurrentDays: 1,
});
export const LIFECYCLE_FINAL = Object.freeze({
  ID: 'ComplianceDocumentsExpireNoncurrentVersions',
  prefix: `${DOCUMENTS_PREFIX}final/`,
  expirationDays: null,
  noncurrentDays: 7,
});

export const STEPS = Object.freeze([
  'create-pii-key',
  'create-pii-key-alias',
  'enable-pii-key-rotation',
  'create-docs-key',
  'create-docs-key-alias',
  'enable-docs-key-rotation',
  'put-role-policy',
  'put-bucket-policy',
  'put-bucket-cors',
  'put-bucket-lifecycle',
  'update-lambda-env',
]);

// ---------------------------------------------------------------- helpers

export const sha256 = (value) => createHash('sha256').update(typeof value === 'string' ? value : canonicalJson(value)).digest('hex');

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

const eq = (a, b) => canonicalJson(a) === canonicalJson(b);
const arr = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const lowerSet = (v) => [...new Set(arr(v).map((s) => String(s).toLowerCase()))].sort();

/** Semantic policy form: parsed, single values as sorted arrays, statements by Sid. */
export function canonicalPolicy(doc) {
  if (doc == null || doc === '') return null;
  let parsed = doc;
  if (typeof doc === 'string') {
    let text = doc;
    if (/^%7B/i.test(text.trim())) text = decodeURIComponent(text);
    parsed = JSON.parse(text);
  }
  const norm = (v) => {
    if (Array.isArray(v)) return v.map(norm).sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)));
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, norm(v[k])]));
    return v;
  };
  const statement = arr(parsed.Statement).map((s) => {
    const out = {};
    for (const [k, v] of Object.entries(s)) {
      if (['Action', 'NotAction', 'Resource', 'NotResource'].includes(k)) out[k] = arr(v).slice().sort();
      else if (k === 'Principal') {
        out[k] = typeof v === 'string' ? v : Object.fromEntries(Object.keys(v).sort().map((p) => [p, arr(v[p]).slice().sort()]));
      } else if (k === 'Condition') {
        out[k] = Object.fromEntries(Object.keys(v).sort().map((op) => [op, Object.fromEntries(
          Object.keys(v[op]).sort().map((ck) => [ck, arr(v[op][ck]).slice().sort()]),
        )]));
      } else out[k] = norm(v);
    }
    return out;
  }).sort((a, b) => String(a.Sid || '').localeCompare(String(b.Sid || '')));
  return { Version: parsed.Version || null, Statement: statement };
}

/** Minified character count of a policy document (IAM ignores whitespace). */
export function policyChars(doc) {
  if (doc == null || doc === '') return 0;
  let parsed = doc;
  if (typeof doc === 'string') parsed = JSON.parse(/^%7B/i.test(doc.trim()) ? decodeURIComponent(doc) : doc);
  return JSON.stringify(parsed).length;
}
export const ROLE_INLINE_POLICY_LIMIT_CHARS = 10240;

// ---------------------------------------------------------------- desired documents

const KEY_ADMIN_ACTIONS = Object.freeze([
  'kms:DescribeKey', 'kms:GetKeyPolicy', 'kms:PutKeyPolicy', 'kms:ListKeyPolicies',
  'kms:ListResourceTags', 'kms:ListAliases', 'kms:ListGrants', 'kms:GetKeyRotationStatus',
  'kms:EnableKeyRotation', 'kms:DisableKeyRotation', 'kms:RotateKeyOnDemand', 'kms:ListKeyRotations',
  'kms:EnableKey', 'kms:DisableKey', 'kms:UpdateKeyDescription', 'kms:CreateAlias',
  'kms:UpdateAlias', 'kms:DeleteAlias', 'kms:RevokeGrant', 'kms:RetireGrant',
  'kms:TagResource', 'kms:UntagResource', 'kms:ScheduleKeyDeletion', 'kms:CancelKeyDeletion',
]);

const keyAdministration = () => ({
  Sid: 'KeyAdministrationOnly',
  Effect: 'Allow',
  Principal: { AWS: ROOT_PRINCIPAL },
  Action: [...KEY_ADMIN_ACTIONS],
  Resource: '*',
});

/**
 * Mirrors aws/template.yaml MoovOnboardingPiiKey, but use is bound to the exact
 * staging role ARN (ArnEquals) instead of the ${StackName}-ApiFunctionRole-* wildcard.
 * Context matches crypto.mjs contextFor: app, environment, tenant_id, field.
 */
export function piiKeyPolicy() {
  return {
    Version: '2012-10-17',
    Statement: [
      keyAdministration(),
      {
        Sid: 'ApiFunctionRoleFieldEncryption',
        Effect: 'Allow',
        Principal: { AWS: ROOT_PRINCIPAL },
        Action: ['kms:Encrypt', 'kms:Decrypt'],
        Resource: '*',
        Condition: {
          ArnEquals: { 'aws:PrincipalArn': ROLE_ARN },
          StringEquals: { 'kms:EncryptionContext:app': PII_ENCRYPTION_APP },
          'ForAllValues:StringEquals': { 'kms:EncryptionContextKeys': [...PII_CONTEXT_KEYS] },
        },
      },
    ],
  };
}

/**
 * Mirrors aws/template.yaml ComplianceDocumentsKey: use only through S3 and only
 * for objects under files/verification-docs/ (S3 SSE-KMS context aws:s3:arn is
 * the object ARN when S3 Bucket Keys are off, which validatePreconditions requires).
 */
export function docsKeyPolicy() {
  return {
    Version: '2012-10-17',
    Statement: [
      keyAdministration(),
      {
        Sid: 'ApiFunctionRoleViaS3',
        Effect: 'Allow',
        Principal: { AWS: ROOT_PRINCIPAL },
        Action: ['kms:GenerateDataKey', 'kms:Decrypt'],
        Resource: '*',
        Condition: {
          ArnEquals: { 'aws:PrincipalArn': ROLE_ARN },
          StringEquals: { 'kms:ViaService': KMS_VIA_S3 },
          StringLike: { 'kms:EncryptionContext:aws:s3:arn': DOCUMENTS_OBJECT_ARN },
        },
      },
    ],
  };
}

export const desiredKeyPolicy = (slot) => (slot === 'pii' ? piiKeyPolicy() : docsKeyPolicy());

/** The three ApiFunction statements from aws/template.yaml with concrete ARNs. */
export function rolePolicy(piiKeyArn, docsKeyArn) {
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'MoovOnboardingPiiEncryptDecrypt',
        Effect: 'Allow',
        Action: ['kms:Encrypt', 'kms:Decrypt'],
        Resource: piiKeyArn,
        Condition: { StringEquals: { 'kms:EncryptionContext:app': PII_ENCRYPTION_APP } },
      },
      {
        Sid: 'ComplianceDocumentObjects',
        Effect: 'Allow',
        Action: ['s3:GetObjectVersion', 's3:DeleteObject', 's3:DeleteObjectVersion'],
        Resource: DOCUMENTS_OBJECT_ARN,
      },
      {
        Sid: 'ComplianceDocumentsViaS3',
        Effect: 'Allow',
        Action: ['kms:GenerateDataKey', 'kms:Decrypt'],
        Resource: docsKeyArn,
        Condition: { StringEquals: { 'kms:ViaService': KMS_VIA_S3 } },
      },
    ],
  };
}

/** The two template Deny statements. The bucket has no policy today: plain create. */
export function bucketPolicy(docsKeyArn) {
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'ComplianceDocumentsRequireSseKms',
        Effect: 'Deny',
        Principal: '*',
        Action: 's3:PutObject',
        Resource: DOCUMENTS_OBJECT_ARN,
        Condition: { StringNotEquals: { 's3:x-amz-server-side-encryption': 'aws:kms' } },
      },
      {
        Sid: 'ComplianceDocumentsRequireDedicatedKey',
        Effect: 'Deny',
        Principal: '*',
        Action: 's3:PutObject',
        Resource: DOCUMENTS_OBJECT_ARN,
        Condition: { StringNotEquals: { 's3:x-amz-server-side-encryption-aws-kms-key-id': docsKeyArn } },
      },
    ],
  };
}

// ---------------------------------------------------------------- CORS

const normCorsRule = (r = {}) => ({
  ID: r.ID ?? null,
  AllowedMethods: arr(r.AllowedMethods).map((m) => String(m).toUpperCase()).sort(),
  AllowedOrigins: arr(r.AllowedOrigins).slice().sort(),
  AllowedHeaders: lowerSet(r.AllowedHeaders),
  ExposeHeaders: lowerSet(r.ExposeHeaders),
  MaxAgeSeconds: r.MaxAgeSeconds ?? null,
  extra: Object.keys(r).filter((k) => !['ID', 'AllowedMethods', 'AllowedOrigins', 'AllowedHeaders', 'ExposeHeaders', 'MaxAgeSeconds'].includes(k)).sort(),
});

export const normalizeCors = (rules) => arr(rules).map(normCorsRule);

const isPutRule = (r) => eq(normCorsRule(r).AllowedMethods, ['PUT']);
const putHeadersApplied = () => lowerSet(['content-type', ...PUT_HEADERS_ADDED]);
const putExposeApplied = () => lowerSet(PUT_EXPOSE_ADDED);

/** 'baseline' | 'applied' | 'drift' */
export const corsState = (rules) => corsStateNormalized(normalizeCors(rules));

function corsStateNormalized(n) {
  if (n.length !== 2) return 'drift';
  const put = n.filter((r) => eq(r.AllowedMethods, ['PUT']));
  const get = n.filter((r) => eq(r.AllowedMethods, ['GET', 'HEAD']));
  if (put.length !== 1 || get.length !== 1) return 'drift';
  const origins = [...STAGING_ORIGINS].sort();
  if (!eq(put[0].AllowedOrigins, origins) || !eq(get[0].AllowedOrigins, origins)) return 'drift';
  if (put[0].extra.length || get[0].extra.length) return 'drift';
  if (!eq(get[0].AllowedHeaders, ['*'])) return 'drift';
  if (!eq(get[0].ExposeHeaders, lowerSet(['Content-Type', 'Content-Length', 'ETag', 'Content-Disposition']))) return 'drift';
  if (get[0].MaxAgeSeconds !== 300 || put[0].MaxAgeSeconds !== 300) return 'drift';
  if (eq(put[0].AllowedHeaders, ['content-type']) && put[0].ExposeHeaders.length === 0) return 'baseline';
  if (eq(put[0].AllowedHeaders, putHeadersApplied()) && eq(put[0].ExposeHeaders, putExposeApplied())) return 'applied';
  return 'drift';
}

/** Keeps every rule byte-for-byte except the PUT rule, which gains the SSE-KMS headers. */
export function mergeCors(rules) {
  if (corsState(rules) !== 'baseline') throw new Error('cors_merge_refused:not_baseline');
  return arr(rules).map((r) => {
    if (!isPutRule(r)) return structuredClone(r);
    const allowed = arr(r.AllowedHeaders).slice();
    for (const h of PUT_HEADERS_ADDED) if (!allowed.map((x) => x.toLowerCase()).includes(h)) allowed.push(h);
    const expose = arr(r.ExposeHeaders).slice();
    for (const h of PUT_EXPOSE_ADDED) if (!expose.map((x) => x.toLowerCase()).includes(h.toLowerCase())) expose.push(h);
    return { ...structuredClone(r), AllowedHeaders: allowed, ExposeHeaders: expose };
  });
}

// ---------------------------------------------------------------- lifecycle

const LIFECYCLE_KNOWN = ['ID', 'Status', 'Prefix', 'Filter', 'Expiration', 'NoncurrentVersionExpiration', 'AbortIncompleteMultipartUpload'];

export function normLifecycleRule(r = {}) {
  let prefix = null;
  let form = null;
  let filterExtra = false;
  if (Object.hasOwn(r, 'Filter')) {
    form = 'filter';
    const f = r.Filter || {};
    const keys = Object.keys(f);
    if (keys.some((k) => k !== 'Prefix')) filterExtra = true;
    prefix = f.Prefix ?? '';
  } else if (Object.hasOwn(r, 'Prefix')) {
    form = 'prefix';
    prefix = r.Prefix ?? '';
  } else {
    form = 'none';
    prefix = '';
  }
  const exp = r.Expiration || null;
  const nve = r.NoncurrentVersionExpiration || null;
  return {
    ID: r.ID ?? null,
    Status: r.Status ?? null,
    form,
    prefix,
    filterExtra,
    expirationDays: exp ? (exp.Days ?? null) : null,
    expirationOther: exp ? Object.keys(exp).filter((k) => k !== 'Days').sort() : [],
    noncurrentDays: nve ? (nve.NoncurrentDays ?? null) : null,
    noncurrentOther: nve ? Object.keys(nve).filter((k) => k !== 'NoncurrentDays').sort() : [],
    abortDays: r.AbortIncompleteMultipartUpload?.DaysAfterInitiation ?? null,
    extra: Object.keys(r).filter((k) => !LIFECYCLE_KNOWN.includes(k)).sort(),
  };
}

const baselineRuleOk = (n) => n.ID === LIFECYCLE_BASELINE_ID && n.Status === 'Enabled' && n.prefix === ''
  && !n.filterExtra && n.abortDays === 7 && n.expirationDays === null && n.noncurrentDays === null
  && !n.expirationOther.length && !n.noncurrentOther.length && !n.extra.length;

const addedRuleOk = (n, spec) => n.ID === spec.ID && n.Status === 'Enabled' && n.prefix === spec.prefix
  && !n.filterExtra && n.abortDays === null && n.expirationDays === spec.expirationDays
  && n.noncurrentDays === spec.noncurrentDays && !n.expirationOther.length && !n.noncurrentOther.length && !n.extra.length;

const addedForm = (baseForm) => (baseForm === 'prefix' ? 'prefix' : 'filter');

/** 'baseline' | 'applied' | 'drift' */
export const lifecycleState = (rules) => lifecycleStateNormalized(arr(rules).map(normLifecycleRule));

function lifecycleStateNormalized(n) {
  if (n.length === 1 && baselineRuleOk(n[0])) return 'baseline';
  if (n.length === 3 && baselineRuleOk(n[0])
    && addedRuleOk(n[1], LIFECYCLE_UPLOADS) && addedRuleOk(n[2], LIFECYCLE_FINAL)
    && n[1].form === addedForm(n[0].form) && n[2].form === addedForm(n[0].form)) return 'applied';
  return 'drift';
}

const buildRule = (spec, form) => {
  const rule = { ID: spec.ID, Status: 'Enabled' };
  if (form === 'filter') rule.Filter = { Prefix: spec.prefix };
  else rule.Prefix = spec.prefix;
  if (spec.expirationDays != null) rule.Expiration = { Days: spec.expirationDays };
  rule.NoncurrentVersionExpiration = { NoncurrentDays: spec.noncurrentDays };
  return rule;
};

/**
 * Existing rule kept exactly as read; the two new rules use the same prefix form
 * as the existing rule (S3 refuses a configuration mixing legacy Prefix and Filter).
 */
export function mergeLifecycle(rules) {
  if (lifecycleState(rules) !== 'baseline') throw new Error('lifecycle_merge_refused:not_baseline');
  const existing = structuredClone(arr(rules)[0]);
  const form = addedForm(normLifecycleRule(existing).form);
  return [existing, buildRule(LIFECYCLE_UPLOADS, form), buildRule(LIFECYCLE_FINAL, form)];
}

// ---------------------------------------------------------------- Lambda env

const envBytes = (vars) => Object.entries(vars).reduce((n, [k, v]) => n + Buffer.byteLength(k) + Buffer.byteLength(String(v)), 0);

export function desiredOnboardingEnv(piiKeyArn, docsKeyArn) {
  return { [ENV_PII_KEY]: piiKeyArn, [ENV_DOCS_KEY]: docsKeyArn, [ENV_PRODUCTION_FLAG]: 'false' };
}

/** Current env plus exactly the three onboarding keys. Refuses if any is already set. */
export function mergeLambdaEnv(current, piiKeyArn, docsKeyArn) {
  const vars = { ...(current || {}) };
  for (const k of ONBOARDING_ENV_KEYS) if (Object.hasOwn(vars, k)) throw new Error(`lambda_env_merge_refused:${k}_present`);
  if (!piiKeyArn || !docsKeyArn) throw new Error('lambda_env_merge_refused:key_arn_missing');
  const merged = { ...vars, ...desiredOnboardingEnv(piiKeyArn, docsKeyArn) };
  if (envBytes(merged) > LAMBDA_ENV_LIMIT_BYTES) throw new Error('lambda_env_merge_refused:size_limit');
  return merged;
}

const preexistingDigest = (vars) => sha256(Object.fromEntries(Object.entries(vars || {})
  .filter(([k]) => !ONBOARDING_ENV_KEYS.includes(k))));

/** Names (never values) of keys that were added, removed or changed between two env maps. */
export function diffEnvKeyNames(before = {}, after = {}) {
  const h = (v) => sha256(String(v));
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  const added = [];
  const removed = [];
  const changed = [];
  for (const k of [...names].sort()) {
    if (!Object.hasOwn(before, k)) added.push(k);
    else if (!Object.hasOwn(after, k)) removed.push(k);
    else if (h(before[k]) !== h(after[k])) changed.push(k);
  }
  return { added, removed, changed };
}

/** Replaces any listed secret value (length >= 6) found in text. */
export function redactSecrets(text, values = []) {
  let out = String(text);
  for (const v of [...new Set(values.map(String))].filter((s) => s.length >= 6).sort((a, b) => b.length - a.length)) {
    out = out.split(v).join('[REDACTED]');
  }
  return out;
}

// ---------------------------------------------------------------- snapshot

const normKey = (k) => (k ? {
  KeyId: k.metadata?.KeyId ?? null,
  Arn: k.metadata?.Arn ?? null,
  KeyState: k.metadata?.KeyState ?? null,
  Enabled: k.metadata?.Enabled ?? null,
  KeyManager: k.metadata?.KeyManager ?? null,
  KeySpec: k.metadata?.KeySpec ?? k.metadata?.CustomerMasterKeySpec ?? null,
  KeyUsage: k.metadata?.KeyUsage ?? null,
  Origin: k.metadata?.Origin ?? null,
  MultiRegion: k.metadata?.MultiRegion ?? false,
  policy: canonicalPolicy(k.policy),
  rotation_enabled: k.rotation === true,
} : null);

const normEncryption = (enc) => arr(enc?.Rules).map((r) => ({
  SSEAlgorithm: r.ApplyServerSideEncryptionByDefault?.SSEAlgorithm ?? null,
  KMSMasterKeyID: r.ApplyServerSideEncryptionByDefault?.KMSMasterKeyID ?? null,
  BucketKeyEnabled: r.BucketKeyEnabled === true,
}));

/**
 * raw = {
 *   identity: sts get-caller-identity,
 *   lambda: get-function-configuration,
 *   role: { policyNames: [...], onboardingPolicy: doc|null },
 *   kms: { pii: null|{metadata, policy, rotation}, docs: ..., tagged: { pii: [{KeyId, KeyState}], docs: [...] } },
 *   bucket: { policy: string|null, cors: [...], lifecycle: {Rules, TransitionDefaultMinimumObjectSize}|null,
 *             versioning: {Status}, encryption: ServerSideEncryptionConfiguration },
 * }
 */
export function normalizeSnapshot(raw) {
  const lambda = raw.lambda || {};
  const vars = lambda.Environment?.Variables || {};
  const orphans = (slot) => {
    const aliased = raw.kms?.[slot]?.metadata?.KeyId || null;
    return arr(raw.kms?.tagged?.[slot])
      .filter((k) => k.KeyId !== aliased && !['PendingDeletion', 'PendingReplicaDeletion'].includes(k.KeyState))
      .map((k) => k.KeyId).sort();
  };
  return {
    account: raw.identity?.Account ?? null,
    lambda: {
      FunctionName: lambda.FunctionName ?? null,
      Role: lambda.Role ?? null,
      CodeSha256: lambda.CodeSha256 ?? null,
      RevisionId: lambda.RevisionId ?? null,
      State: lambda.State ?? null,
      LastUpdateStatus: lambda.LastUpdateStatus ?? null,
      env_key_names: Object.keys(vars).sort(),
      onboarding_env: Object.fromEntries(ONBOARDING_ENV_KEYS.map((k) => [k, Object.hasOwn(vars, k) ? String(vars[k]) : null])),
      preexisting_env_sha256: preexistingDigest(vars),
      env_size_bytes: envBytes(vars),
      files_bucket_matches: vars.FILES_BUCKET === BUCKET,
    },
    role: {
      inline_policy_names: arr(raw.role?.policyNames).slice().sort(),
      onboarding_policy: canonicalPolicy(raw.role?.onboardingPolicy ?? null),
      other_inline_policy_chars: raw.role?.otherPolicyChars ?? null,
    },
    kms: {
      pii: { alias: KEYS.pii.alias, key: normKey(raw.kms?.pii) },
      docs: { alias: KEYS.docs.alias, key: normKey(raw.kms?.docs) },
      orphan_key_ids: { pii: orphans('pii'), docs: orphans('docs') },
    },
    bucket: {
      name: BUCKET,
      versioning: raw.bucket?.versioning?.Status ?? null,
      encryption: normEncryption(raw.bucket?.encryption),
      policy: canonicalPolicy(raw.bucket?.policy ?? null),
      cors: normalizeCors(raw.bucket?.cors),
      lifecycle: arr(raw.bucket?.lifecycle?.Rules).map(normLifecycleRule),
      transition_default_minimum_object_size: raw.bucket?.lifecycle?.TransitionDefaultMinimumObjectSize ?? null,
    },
  };
}

// ---------------------------------------------------------------- state / plan

const KEY_ARN_RE = new RegExp(`^arn:aws:kms:${REGION}:${ACCOUNT_ID}:key/[0-9a-f-]{36}$`);

function keyState(snapshot, slot) {
  const k = snapshot.kms[slot].key;
  if (!k) return { exists: false, valid: true, rotation: false, errors: [] };
  const errors = [];
  if (!KEY_ARN_RE.test(String(k.Arn))) errors.push(`${slot}_key_arn_unexpected`);
  if (k.KeyState !== 'Enabled' || k.Enabled !== true) errors.push(`${slot}_key_not_enabled`);
  if (k.KeyManager !== 'CUSTOMER' || k.KeySpec !== 'SYMMETRIC_DEFAULT' || k.KeyUsage !== 'ENCRYPT_DECRYPT'
    || k.Origin !== 'AWS_KMS' || k.MultiRegion !== false) errors.push(`${slot}_key_shape_mismatch`);
  if (!eq(k.policy, canonicalPolicy(desiredKeyPolicy(slot)))) errors.push(`${slot}_key_policy_mismatch`);
  return { exists: true, valid: errors.length === 0, rotation: k.rotation_enabled, errors };
}

/** Per-step done flags plus every drift error. Pure. */
export function assessState(snapshot) {
  const errors = [];
  const done = {};
  if (snapshot.account !== ACCOUNT_ID) errors.push('account_mismatch');
  const l = snapshot.lambda;
  if (l.FunctionName !== FUNCTION_NAME) errors.push('lambda_function_mismatch');
  if (l.Role !== ROLE_ARN) errors.push('lambda_role_mismatch');
  if (l.State !== 'Active' || l.LastUpdateStatus !== 'Successful') errors.push('lambda_not_idle');
  if (!l.files_bucket_matches) errors.push('lambda_files_bucket_mismatch');
  if (!l.RevisionId || !l.CodeSha256) errors.push('lambda_revision_unreadable');

  const b = snapshot.bucket;
  if (b.versioning !== 'Enabled') errors.push('bucket_versioning_not_enabled');
  if (b.encryption.some((r) => r.BucketKeyEnabled)) errors.push('bucket_key_enabled_changes_kms_context');

  const arns = {};
  for (const slot of ['pii', 'docs']) {
    const s = keyState(snapshot, slot);
    errors.push(...s.errors);
    if (snapshot.kms.orphan_key_ids[slot].length) errors.push(`${slot}_orphan_tagged_key_requires_review`);
    done[`create-${slot}-key`] = s.exists;
    done[`create-${slot}-key-alias`] = s.exists;
    done[`enable-${slot}-key-rotation`] = s.exists && s.rotation;
    arns[slot] = s.exists ? snapshot.kms[slot].key.Arn : null;
  }

  const names = snapshot.role.inline_policy_names;
  const hasPolicy = names.includes(ROLE_POLICY_NAME);
  if (hasPolicy !== Boolean(snapshot.role.onboarding_policy)) errors.push('role_policy_read_inconsistent');
  if (hasPolicy) {
    if (!arns.pii || !arns.docs || !eq(snapshot.role.onboarding_policy, canonicalPolicy(rolePolicy(arns.pii, arns.docs)))) {
      errors.push('role_policy_present_with_unexpected_content');
    }
  }
  if (!hasPolicy) {
    const placeholder = `arn:aws:kms:${REGION}:${ACCOUNT_ID}:key/00000000-0000-0000-0000-000000000000`;
    const added = ROLE_POLICY_NAME.length + policyChars(rolePolicy(placeholder, placeholder));
    if (typeof snapshot.role.other_inline_policy_chars !== 'number'
      || snapshot.role.other_inline_policy_chars + added > ROLE_INLINE_POLICY_LIMIT_CHARS) {
      errors.push('role_inline_policy_size_limit');
    }
  }
  done['put-role-policy'] = hasPolicy;

  if (b.policy) {
    if (!arns.docs || !eq(b.policy, canonicalPolicy(bucketPolicy(arns.docs)))) errors.push('bucket_policy_present');
  }
  done['put-bucket-policy'] = Boolean(b.policy);

  const cors = corsStateNormalized(b.cors);
  if (cors === 'drift') errors.push('bucket_cors_drift');
  done['put-bucket-cors'] = cors === 'applied';

  const lc = lifecycleStateNormalized(b.lifecycle);
  if (lc === 'drift') errors.push('bucket_lifecycle_drift');
  done['put-bucket-lifecycle'] = lc === 'applied';

  const present = ONBOARDING_ENV_KEYS.filter((k) => l.onboarding_env[k] !== null);
  if (present.length === 0) {
    done['update-lambda-env'] = false;
    const added = Buffer.byteLength(ENV_PII_KEY) + Buffer.byteLength(ENV_DOCS_KEY) + Buffer.byteLength(ENV_PRODUCTION_FLAG)
      + 2 * Buffer.byteLength(`arn:aws:kms:${REGION}:${ACCOUNT_ID}:key/00000000-0000-0000-0000-000000000000`) + 5;
    if (l.env_size_bytes + added > LAMBDA_ENV_LIMIT_BYTES) errors.push('lambda_env_size_limit');
  } else if (present.length === 3 && arns.pii && arns.docs
    && eq(l.onboarding_env, desiredOnboardingEnv(arns.pii, arns.docs))) {
    done['update-lambda-env'] = true;
  } else {
    done['update-lambda-env'] = true;
    errors.push('lambda_onboarding_env_drift');
  }

  // The writer applies steps in order; only a completed prefix is a valid resume point.
  const flags = STEPS.map((s) => done[s] === true);
  const firstPending = flags.indexOf(false);
  if (firstPending !== -1 && flags.slice(firstPending).some(Boolean)) errors.push('out_of_order_state');

  return { errors: [...new Set(errors)], done, key_arns: arns };
}

/** Fails closed unless the live state is the pinned baseline or a clean resume point. */
export function validatePreconditions(snapshot) {
  const assessed = assessState(snapshot);
  return {
    ok: assessed.errors.length === 0,
    errors: assessed.errors,
    fresh: STEPS.every((s) => assessed.done[s] !== true),
    done: assessed.done,
    key_arns: assessed.key_arns,
  };
}

/** Ordered steps with done/pending status. Throws on any precondition failure. */
export function planDelta(snapshot) {
  const v = validatePreconditions(snapshot);
  if (!v.ok) throw new Error(`precondition_failed:${v.errors.join(',')}`);
  return STEPS.map((step) => ({ step, status: v.done[step] ? 'done' : 'pending' }));
}

/** Object bound into the preflight manifest / receipt (no env values). */
export function liveFingerprint(snapshot) {
  const plan = planDelta(snapshot);
  return {
    component: COMPONENT,
    function_name: FUNCTION_NAME,
    revision_id: snapshot.lambda.RevisionId,
    code_sha256: snapshot.lambda.CodeSha256,
    pending_steps: plan.filter((s) => s.status === 'pending').map((s) => s.step),
    snapshot_sha256: sha256(snapshot),
  };
}

/** The snapshot the writer must observe after applying every pending step. */
export function expectedAfter(before, piiKeyArn, docsKeyArn) {
  const exp = structuredClone(before);
  const desiredEnv = desiredOnboardingEnv(piiKeyArn, docsKeyArn);
  const pending = new Set(planDelta(before).filter((s) => s.status === 'pending').map((s) => s.step));
  if (pending.has('update-lambda-env')) {
    exp.lambda.env_key_names = [...new Set([...before.lambda.env_key_names, ...ONBOARDING_ENV_KEYS])].sort();
    exp.lambda.onboarding_env = desiredEnv;
    exp.lambda.env_size_bytes = before.lambda.env_size_bytes
      + Object.entries(desiredEnv).reduce((n, [k, v]) => n + Buffer.byteLength(k) + Buffer.byteLength(v), 0);
  }
  if (pending.has('put-role-policy')) {
    exp.role.inline_policy_names = [...before.role.inline_policy_names, ROLE_POLICY_NAME].sort();
    exp.role.onboarding_policy = canonicalPolicy(rolePolicy(piiKeyArn, docsKeyArn));
  }
  for (const [slot, arn] of [['pii', piiKeyArn], ['docs', docsKeyArn]]) {
    if (!before.kms[slot].key) {
      exp.kms[slot].key = {
        KeyId: arn.split('/').pop(), Arn: arn, KeyState: 'Enabled', Enabled: true, KeyManager: 'CUSTOMER',
        KeySpec: 'SYMMETRIC_DEFAULT', KeyUsage: 'ENCRYPT_DECRYPT', Origin: 'AWS_KMS', MultiRegion: false,
        policy: canonicalPolicy(desiredKeyPolicy(slot)), rotation_enabled: true,
      };
    } else {
      exp.kms[slot].key.rotation_enabled = true;
    }
  }
  if (pending.has('put-bucket-policy')) exp.bucket.policy = canonicalPolicy(bucketPolicy(docsKeyArn));
  if (pending.has('put-bucket-cors')) {
    exp.bucket.cors = exp.bucket.cors.map((r) => (eq(r.AllowedMethods, ['PUT'])
      ? { ...r, AllowedHeaders: putHeadersApplied(), ExposeHeaders: putExposeApplied() }
      : r));
  }
  if (pending.has('put-bucket-lifecycle')) {
    const form = addedForm(before.bucket.lifecycle[0].form);
    exp.bucket.lifecycle = [before.bucket.lifecycle[0],
      normLifecycleRule(buildRule(LIFECYCLE_UPLOADS, form)),
      normLifecycleRule(buildRule(LIFECYCLE_FINAL, form))];
  }
  return exp;
}

const diffPaths = (a, b, prefix = '') => {
  if (eq(a, b)) return [];
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap((k) => diffPaths(a[k], b[k], prefix ? `${prefix}.${k}` : k));
  }
  return [prefix || '(root)'];
};

/**
 * Throws unless `after` is exactly `before` plus the planned delta. The Lambda
 * RevisionId must change only when the env step ran; every pre-existing env key
 * is proven unchanged through the digest over the non-onboarding keys.
 */
export function assertOnlyPlannedDelta(before, after) {
  const piiArn = after.kms.pii.key?.Arn;
  const docsArn = after.kms.docs.key?.Arn;
  if (!piiArn || !docsArn) throw new Error('post_verify_failed:key_missing');
  for (const slot of ['pii', 'docs']) {
    if (before.kms[slot].key && before.kms[slot].key.KeyId !== after.kms[slot].key.KeyId) {
      throw new Error(`post_verify_failed:${slot}_alias_retargeted`);
    }
  }
  const envRan = planDelta(before).some((s) => s.step === 'update-lambda-env' && s.status === 'pending');
  const expected = expectedAfter(before, piiArn, docsArn);
  const mask = (s) => ({ ...s, lambda: { ...s.lambda, RevisionId: null } });
  const paths = diffPaths(mask(expected), mask(after));
  if (paths.length) throw new Error(`post_write_unplanned_delta:${paths.join(',')}`);
  if (envRan && after.lambda.RevisionId === before.lambda.RevisionId) throw new Error('post_verify_failed:revision_unchanged');
  if (!envRan && after.lambda.RevisionId !== before.lambda.RevisionId) throw new Error('post_write_unplanned_delta:lambda.RevisionId');
  return true;
}

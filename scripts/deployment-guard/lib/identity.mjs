import { execFileSync } from 'node:child_process';
import { CODES, errorEntry, failMany, ok } from './errors.mjs';

export const REQUIRED_MANIFEST_FIELDS = Object.freeze([
  'workstream_id',
  'branch',
  'commit',
  'target_environment',
  'deployment_type',
  'owned_components',
  'preflight_live_fingerprint',
  'build_timestamp',
]);

export const DEPLOYMENT_TYPES = Object.freeze([
  'lambda-overlay',
  'spa-promote',
  'sql-apply',
  'cloudfront-invalidation',
  'verify-only',
]);

const GIT_SHA_RE = /^[0-9a-f]{40}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

export function gitIdentity(root, env = process.env) {
  const run = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  let branch = env.CHECKSOPS_BRANCH || env.GITHUB_REF_NAME || null;
  let commit = env.CHECKSOPS_COMMIT || env.GITHUB_SHA || null;
  try {
    branch = branch || run(['rev-parse', '--abbrev-ref', 'HEAD']);
    commit = commit || run(['rev-parse', 'HEAD']);
  } catch {
    /* tests may inject both */
  }
  const operator = env.CHECKSOPS_OPERATOR
    || env.CURSOR_AGENT_ID
    || env.GITHUB_ACTOR
    || env.USER
    || null;
  return { branch, commit, operator };
}

export function validateWorkstreamIdentity(input = {}) {
  const errors = [];
  const workstreamId = String(input.workstream_id || '').trim();
  if (!workstreamId) {
    errors.push(errorEntry(CODES.ANONYMOUS_DEPLOYMENT, 'workstream_id is required; anonymous deployment is forbidden'));
  }
  if (!String(input.branch || '').trim()) {
    errors.push(errorEntry(CODES.ANONYMOUS_DEPLOYMENT, 'branch is required'));
  }
  if (!GIT_SHA_RE.test(String(input.commit || ''))) {
    errors.push(errorEntry(CODES.ANONYMOUS_DEPLOYMENT, 'commit SHA must be a 40-character git SHA'));
  }
  if (!String(input.target_environment || '').trim()) {
    errors.push(errorEntry(CODES.ANONYMOUS_DEPLOYMENT, 'target_environment is required'));
  }
  if (!DEPLOYMENT_TYPES.includes(input.deployment_type)) {
    errors.push(errorEntry(CODES.INVALID_MANIFEST, `deployment_type must be one of ${DEPLOYMENT_TYPES.join(', ')}`));
  }
  if (!Array.isArray(input.owned_components) || input.owned_components.length === 0) {
    errors.push(errorEntry(CODES.INVALID_MANIFEST, 'owned_components must list the files/members this workstream owns'));
  }
  if (!input.preflight_live_fingerprint || typeof input.preflight_live_fingerprint !== 'object') {
    errors.push(errorEntry(CODES.INVALID_MANIFEST, 'preflight_live_fingerprint is required'));
  }
  if (!ISO_RE.test(String(input.build_timestamp || ''))) {
    errors.push(errorEntry(CODES.INVALID_MANIFEST, 'build_timestamp must be an ISO-8601 UTC timestamp'));
  }
  if (errors.length) return failMany(errors, CODES.ANONYMOUS_DEPLOYMENT);
  return ok({
    workstream_id: workstreamId,
    branch: input.branch,
    commit: input.commit,
    operator: input.operator || null,
    target_environment: input.target_environment,
    deployment_type: input.deployment_type,
    owned_components: [...input.owned_components],
    preflight_live_fingerprint: input.preflight_live_fingerprint,
    build_timestamp: input.build_timestamp,
  });
}

export function buildManifest(input, extras = {}) {
  const identity = validateWorkstreamIdentity(input);
  if (!identity.ok) return identity;
  const manifest = {
    schema_version: 1,
    generated_at: extras.generated_at || new Date().toISOString(),
    ...identity.details,
    operator: input.operator || null,
    target_component: input.target_component || null,
    owned_files: input.owned_files || input.owned_components,
    accepted_contracts: input.accepted_contracts || [],
    lease: input.lease || null,
    package: input.package || null,
    notes: input.notes || 'Independent source work may proceed concurrently. Shared-target deployment may not overwrite another workstream.',
    reclaim_forbidden: true,
    restore_forbidden: true,
    stale_package_forbidden: true,
  };
  return ok(manifest);
}

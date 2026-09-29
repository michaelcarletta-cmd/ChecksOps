/**
 * Workstream deployment identity / machine-readable manifest.
 * No anonymous deployment.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CODES, fail, ok, GIT_SHA_RE, ISO_TIMESTAMP_RE, nowIso, sha256Text } from './lib.mjs';

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

export function defaultGitIdentity(root, execFile = execFileSync) {
  const run = (args) => {
    try {
      return String(execFile('git', args, { cwd: root, encoding: 'utf8' })).trim();
    } catch {
      return '';
    }
  };
  return {
    branch: run(['rev-parse', '--abbrev-ref', 'HEAD']),
    commit: run(['rev-parse', 'HEAD']),
  };
}

export function resolveOperator(env = process.env) {
  return env.CHECKSOPS_OPERATOR
    || env.CURSOR_AGENT_ID
    || env.GITHUB_ACTOR
    || env.USER
    || null;
}

export function createManifest(input = {}, { root = null, git = null, env = process.env, clock = () => new Date() } = {}) {
  const gitId = git || (root ? defaultGitIdentity(root) : { branch: '', commit: '' });
  const manifest = {
    schema: 'checksops.deployment-guard.manifest.v1',
    workstream_id: input.workstream_id || null,
    branch: input.branch || gitId.branch || null,
    commit: input.commit || gitId.commit || null,
    operator: input.operator || resolveOperator(env),
    target_environment: input.target_environment || null,
    deployment_type: input.deployment_type || null,
    owned_components: Array.isArray(input.owned_components) ? input.owned_components : [],
    owned_lambda_members: Array.isArray(input.owned_lambda_members) ? input.owned_lambda_members : [],
    frontend_workstreams: Array.isArray(input.frontend_workstreams) ? input.frontend_workstreams : [],
    preflight_live_fingerprint: input.preflight_live_fingerprint || null,
    build_timestamp: input.build_timestamp || nowIso(clock),
    lease_id: input.lease_id || null,
    staging_acceptance: input.staging_acceptance || null,
    production_approval: input.production_approval || null,
    provenance: input.provenance || null,
    notes: input.notes || null,
  };
  const checked = validateManifest(manifest);
  if (!checked.ok) return checked;
  return ok({
    manifest: {
      ...manifest,
      manifest_sha256: sha256Text(JSON.stringify({
        workstream_id: manifest.workstream_id,
        branch: manifest.branch,
        commit: manifest.commit,
        target_environment: manifest.target_environment,
        deployment_type: manifest.deployment_type,
        owned_components: manifest.owned_components,
        owned_lambda_members: manifest.owned_lambda_members,
        preflight_live_fingerprint: manifest.preflight_live_fingerprint,
        build_timestamp: manifest.build_timestamp,
      })),
    },
  });
}

export function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') {
    return fail(CODES.ANONYMOUS_DEPLOYMENT, 'deployment manifest is missing');
  }
  for (const field of REQUIRED_MANIFEST_FIELDS) {
    const value = manifest[field];
    if (value == null || value === '' || (Array.isArray(value) && field === 'owned_components' && value.length === 0)) {
      if (field === 'owned_components' && Array.isArray(value) && value.length === 0) {
        return fail(CODES.ANONYMOUS_DEPLOYMENT, 'owned_components must declare at least one owned component');
      }
      if (value == null || value === '') {
        return fail(CODES.ANONYMOUS_DEPLOYMENT, `anonymous deployment: missing ${field}`);
      }
    }
  }
  if (typeof manifest.workstream_id !== 'string' || manifest.workstream_id.trim().length < 3) {
    return fail(CODES.ANONYMOUS_DEPLOYMENT, 'workstream_id is required');
  }
  if (!GIT_SHA_RE.test(String(manifest.commit || ''))) {
    return fail(CODES.ANONYMOUS_DEPLOYMENT, 'commit SHA must be a 40-character git SHA');
  }
  if (!['staging', 'production'].includes(manifest.target_environment)) {
    return fail(CODES.INVALID_TARGET, `target_environment must be staging or production (got ${manifest.target_environment})`);
  }
  if (!['lambda-overlay', 'spa-promote', 'sql-apply', 'composed'].includes(manifest.deployment_type)) {
    return fail(CODES.INVALID_MANIFEST, `unknown deployment_type ${manifest.deployment_type}`);
  }
  if (!ISO_TIMESTAMP_RE.test(String(manifest.build_timestamp || ''))) {
    return fail(CODES.INVALID_MANIFEST, 'build_timestamp must be an ISO-8601 UTC timestamp');
  }
  if (!manifest.preflight_live_fingerprint || typeof manifest.preflight_live_fingerprint !== 'object') {
    return fail(CODES.INVALID_MANIFEST, 'preflight_live_fingerprint is required');
  }
  return ok({ manifest });
}

export function main(argv = process.argv.slice(2), extras = {}) {
  const input = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--') && argv[i + 1] && !argv[i + 1].startsWith('--')) {
      input[arg.slice(2).replace(/-/g, '_')] = argv[i + 1];
      i += 1;
    }
  }
  if (input.owned_components) input.owned_components = String(input.owned_components).split(',');
  if (input.owned_lambda_members) input.owned_lambda_members = String(input.owned_lambda_members).split(',');
  const created = createManifest(input, extras);
  if (!created.ok) {
    console.error(JSON.stringify(created, null, 2));
    return 1;
  }
  console.log(JSON.stringify(created.manifest, null, 2));
  return 0;
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  process.exitCode = main();
}

import { isDeepStrictEqual } from 'node:util';

export const UPDATE_TARGET = Object.freeze({
  account: '806168576068',
  region: 'us-east-1',
  environment: 'staging',
  roleArn: 'arn:aws:iam::806168576068:role/ChecksOpsGitHubStagingDbReadonlyDiagnosticDeploy',
  functionArn: 'arn:aws:lambda:us-east-1:806168576068:function:checksops-staging-db-readonly-diagnostic',
  workstreamId: 'staging-db-readonly-diagnostic',
  component: 'checksops-staging-db-readonly-diagnostic',
});

export const COMPOSED_SOURCE_PATHS = Object.freeze([
  'aws/functions/api/staging-db-readonly-diagnostic-output.mjs',
]);

export function validateUpdateTarget(target = {}) {
  if (target.account !== UPDATE_TARGET.account
      || target.region !== UPDATE_TARGET.region
      || target.environment !== UPDATE_TARGET.environment
      || target.roleArn !== UPDATE_TARGET.roleArn
      || target.functionArn !== UPDATE_TARGET.functionArn
      || target.workstreamId !== UPDATE_TARGET.workstreamId
      || target.component !== UPDATE_TARGET.component) {
    throw new Error('diagnostic_update_target_rejected');
  }
  return true;
}

export function requireIndependentApproval({
  attestation,
  commit,
  actor,
  verifyAttestation,
} = {}) {
  if (!attestation || typeof verifyAttestation !== 'function'
      || attestation.commit !== commit
      || attestation.workstreamId !== UPDATE_TARGET.workstreamId
      || attestation.environment !== UPDATE_TARGET.environment
      || !attestation.approver
      || attestation.approver === actor
      || verifyAttestation(attestation) !== true) {
    throw new Error('independent_approval_unverified');
  }
  return true;
}

export function requireOwnerApprovedStackPath({ stackExists, stackOwnership } = {}) {
  if (stackExists !== true) {
    throw new Error('existing_diagnostic_stack_required');
  }
  if (stackOwnership === 'cloudformation') {
    throw new Error('cloudformation_owner_path_required');
  }
  throw new Error('stack_ownership_unverified');
}

export function compareLiveState(preflight, immediatelyBefore) {
  const validFingerprint = (fingerprint) => fingerprint
    && typeof fingerprint.codeSha256 === 'string'
    && /^[A-Za-z0-9+/]{43}=$/.test(fingerprint.codeSha256)
    && typeof fingerprint.revisionId === 'string'
    && fingerprint.revisionId.length > 0
    && fingerprint.configuration
    && typeof fingerprint.configuration === 'object'
    && !Array.isArray(fingerprint.configuration);
  if (!validFingerprint(preflight) || !validFingerprint(immediatelyBefore)
      || preflight.codeSha256 !== immediatelyBefore.codeSha256
      || preflight.revisionId !== immediatelyBefore.revisionId
      || !isDeepStrictEqual(preflight.configuration, immediatelyBefore.configuration)) {
    throw new Error('diagnostic_live_state_drift');
  }
  return true;
}

export function validateSourceComposition(changedPaths = []) {
  const allowed = new Set(COMPOSED_SOURCE_PATHS);
  if (!Array.isArray(changedPaths) || changedPaths.length === 0
      || changedPaths.some((file) => !allowed.has(file))
      || new Set(changedPaths).size !== changedPaths.length) {
    throw new Error('diagnostic_source_composition_rejected');
  }
  return true;
}

export function validatePublishedVersion(record = {}, expectedCodeSha256) {
  if (record.FunctionArn !== UPDATE_TARGET.functionArn
      || !/^[1-9][0-9]*$/.test(String(record.Version || ''))
      || !/^[A-Za-z0-9+/]{43}=$/.test(String(expectedCodeSha256 || ''))
      || record.CodeSha256 !== expectedCodeSha256) {
    throw new Error('diagnostic_version_mismatch');
  }
  return `${record.FunctionArn}:${record.Version}`;
}

export function main() {
  console.error(JSON.stringify({ ok: false, code: 'source_only_draft' }));
  return 2;
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  process.exitCode = main();
}

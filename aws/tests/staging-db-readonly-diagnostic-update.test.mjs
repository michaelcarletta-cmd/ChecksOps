import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import {
  COMPOSED_SOURCE_PATHS,
  UPDATE_TARGET,
  compareLiveState,
  main,
  requireIndependentApproval,
  requireOwnerApprovedStackPath,
  validatePublishedVersion,
  validateSourceComposition,
  validateUpdateTarget,
} from '../../scripts/staging-db-readonly-diagnostic-update.mjs';
import { projectInspect, projectValidation } from '../functions/api/staging-db-readonly-diagnostic-output.mjs';

const SHA256 = 'A'.repeat(43) + '=';
const target = (overrides = {}) => ({ ...UPDATE_TARGET, ...overrides });
const fingerprint = (overrides = {}) => ({
  codeSha256: SHA256,
  revisionId: 'revision-1',
  configuration: {
    Role: 'arn:aws:iam::806168576068:role/diagnostic-runtime',
    Runtime: 'nodejs22.x',
    Environment: { Variables: { CHECKSOPS_ENV: 'staging' } },
  },
  ...overrides,
});

test('only the exact staging diagnostic function, workstream, and role are allowlisted', () => {
  assert.equal(validateUpdateTarget(target()), true);
  for (const override of [
    { account: '123456789012' },
    { region: 'us-west-2' },
    { environment: 'production' },
    { roleArn: 'arn:aws:iam::806168576068:role/ChecksOpsGitHubStagingLambdaOverlay' },
    { functionArn: 'arn:aws:lambda:us-east-1:806168576068:function:checksops-staging-api' },
    { functionArn: 'arn:aws:lambda:us-east-1:806168576068:function:checksops-production-prep-api' },
    { component: 'production-spa' },
    { workstreamId: 'another-workstream' },
  ]) {
    assert.throws(() => validateUpdateTarget(target(override)), /diagnostic_update_target_rejected/);
  }
  for (const resource of ['sql', 'spa', 'financial', 'shared-api', 'production']) {
    assert.throws(() => validateUpdateTarget(target({ component: resource })), /diagnostic_update_target_rejected/);
  }
});

test('missing, caller-supplied-only, stale, and self-approved attestations are rejected', () => {
  const attestation = {
    commit: 'a'.repeat(40),
    workstreamId: UPDATE_TARGET.workstreamId,
    environment: 'staging',
    approver: 'independent-owner',
  };
  assert.throws(() => requireIndependentApproval({ commit: attestation.commit }), /independent_approval_unverified/);
  assert.throws(() => requireIndependentApproval({
    attestation, commit: attestation.commit, actor: 'caller',
  }), /independent_approval_unverified/);
  assert.throws(() => requireIndependentApproval({
    attestation, commit: 'b'.repeat(40), actor: 'caller', verifyAttestation: () => true,
  }), /independent_approval_unverified/);
  assert.throws(() => requireIndependentApproval({
    attestation: { ...attestation, approver: 'caller' },
    commit: attestation.commit,
    actor: 'caller',
    verifyAttestation: () => true,
  }), /independent_approval_unverified/);
  assert.throws(() => requireIndependentApproval({
    attestation, commit: attestation.commit, actor: 'caller', verifyAttestation: () => false,
  }), /independent_approval_unverified/);
  assert.equal(requireIndependentApproval({
    attestation, commit: attestation.commit, actor: 'caller', verifyAttestation: () => true,
  }), true);
});

test('unknown and CloudFormation ownership stop pending an owner-approved stack-aware path', () => {
  assert.throws(() => requireOwnerApprovedStackPath({}), /existing_diagnostic_stack_required/);
  assert.throws(
    () => requireOwnerApprovedStackPath({ stackExists: true }),
    /stack_ownership_unverified/,
  );
  assert.throws(
    () => requireOwnerApprovedStackPath({ stackExists: true, stackOwnership: 'cloudformation' }),
    /cloudformation_owner_path_required/,
  );
  assert.throws(
    () => requireOwnerApprovedStackPath({ stackExists: true, stackOwnership: 'unmanaged' }),
    /stack_ownership_unverified/,
  );
});

test('stale fingerprints, configuration changes, and concurrent RevisionId writes fail closed', () => {
  const preflight = fingerprint();
  assert.equal(compareLiveState(preflight, fingerprint()), true);
  for (const live of [
    fingerprint({ codeSha256: 'B'.repeat(43) + '=' }),
    fingerprint({ revisionId: 'revision-2' }),
    fingerprint({ configuration: { ...preflight.configuration, Runtime: 'nodejs20.x' } }),
    fingerprint({ configuration: { ...preflight.configuration, Environment: { Variables: {} } } }),
    fingerprint({ revisionId: '' }),
    fingerprint({ codeSha256: 'not-a-sha' }),
  ]) {
    assert.throws(() => compareLiveState(preflight, live), /diagnostic_live_state_drift/);
  }
});

test('source composition is restricted to the reviewed diagnostic output module, not peer workstreams', () => {
  assert.equal(validateSourceComposition([COMPOSED_SOURCE_PATHS[0]]), true);
  assert.equal(validateSourceComposition([...COMPOSED_SOURCE_PATHS]), true);
  for (const changed of [
    [],
    ['aws/functions/api/index.mjs'],
    ['aws/db/migrations/20261009000000_unrelated.sql'],
    ['src/pages/production-spa.tsx'],
    [COMPOSED_SOURCE_PATHS[0], COMPOSED_SOURCE_PATHS[0]],
  ]) {
    assert.throws(() => validateSourceComposition(changed), /diagnostic_source_composition_rejected/);
  }
});

test('published versions must match the exact target and verified code fingerprint', () => {
  const record = {
    FunctionArn: UPDATE_TARGET.functionArn,
    Version: '42',
    CodeSha256: SHA256,
  };
  assert.equal(validatePublishedVersion(record, SHA256), `${UPDATE_TARGET.functionArn}:42`);
  assert.throws(() => validatePublishedVersion({ ...record, Version: '$LATEST' }, SHA256), /diagnostic_version_mismatch/);
  assert.throws(() => validatePublishedVersion({ ...record, FunctionArn: `${UPDATE_TARGET.functionArn}:42` }, SHA256), /diagnostic_version_mismatch/);
  assert.throws(() => validatePublishedVersion({ ...record, CodeSha256: 'B'.repeat(43) + '=' }, SHA256), /diagnostic_version_mismatch/);
});

test('diagnostic output keeps unavailable metadata distinct from absent objects and redacts SQL bodies', () => {
  const definitionSha256 = 'a'.repeat(64);
  const missing = projectValidation({
    ok: false,
    issues: [{ kind: 'missing_relation', severity: 'error', table: 'claims' }],
    tables: [{ table: 'claims', present: false, countMatches: false, expectedCount: 180, rowCount: null }],
  });
  const unavailable = projectValidation({
    ok: false,
    issues: [{ kind: 'query', severity: 'error', table: 'claims' }],
    tables: [{ table: 'claims', present: true, countMatches: false, expectedCount: 180, rowCount: null }],
  });
  assert.equal(missing.issues[0].classification, 'missing_relation');
  assert.equal(missing.tables.find((row) => row.table === 'claims').present, false);
  assert.equal(unavailable.issues[0].classification, 'query');
  assert.equal(unavailable.tables.find((row) => row.table === 'claims').present, true);
  assert.equal(unavailable.tables.find((row) => row.table === 'claims').actualCount, null);

  const projected = projectInspect({
    functions: [{
      identity: 'public.save_claim_settlement_breakdown(uuid,uuid,jsonb)',
      exists: true,
      definitionSha256,
      definition: 'CREATE FUNCTION with sensitive SQL',
      password: 'sensitive-password',
    }],
  });
  assert.doesNotMatch(JSON.stringify(projected), /CREATE FUNCTION|sensitive-password/);
  assert.equal(projected.functions[0].definitionSha256, definitionSha256);
});

test('draft has no mutating entrypoint; the existing create-only workflow stays disabled', () => {
  const workflow = fs.readFileSync(new URL('../../.github/workflows/staging-db-readonly-diagnostic-deploy.yml', import.meta.url), 'utf8');
  const source = fs.readFileSync(new URL('../../scripts/staging-db-readonly-diagnostic-update.mjs', import.meta.url), 'utf8');
  assert.match(workflow, /if: \$\{\{ false \}\}/);
  assert.match(source, /source_only_draft/);
  assert.doesNotMatch(source, /UpdateFunctionCode|UpdateStack|CreateChangeSet|lambda-overlay-apply/);
  assert.equal(main(), 2);
});

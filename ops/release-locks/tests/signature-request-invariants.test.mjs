/**
 * Staging Signature Request release-lock contract.
 *
 * Behavioral proof lives in aws/tests/signature-request-accepted-contract.test.mjs
 * plus the create/send/stamp/branding suite. This file pins the ownership
 * group, lock classification, and capability markers so a future composition
 * cannot silently drop the proven chain after updating tree_hash.
 *
 * Source and evidence only. Does not deploy, apply SQL, or mutate production.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  computeOwnershipHashes,
  loadJson,
  matchProtectedPath,
  validateReleaseLocks,
} from '../../../scripts/lib/release-locks.mjs';
import { loadReleaseLockInputs } from '../../../scripts/validate-release-locks.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const SR_PROTECTED = Object.freeze([
  'aws/functions/api/esign.mjs',
  'aws/functions/api/signature-submit.mjs',
  'aws/functions/api/email-branding.mjs',
  'aws/workflows/sql/73_homeowner_ledger_view_last_viewed_best_effort.sql',
  'aws/workflows/sql/74_homeowner_signing_rls_boundary.sql',
  'aws/workflows/sql/75_signature_request_check_files_link_grant.sql',
  'ops/release-locks/contracts/signature-request-staging-contract.json',
  'ops/release-locks/proof/signature-request-staging-acceptance-2026-10-04.md',
  'ops/deployment-guard/signature-request-accepted-staging.json',
  'aws/tests/signature-request-accepted-contract.test.mjs',
  'aws/tests/esign-sr-invariants.test.mjs',
  'aws/tests/signature-stamp-submit-values.test.mjs',
]);

const REQUIRED_INVARIANTS = Object.freeze([
  'normal create/send does not depend on generic browser inserts',
  'no access_token = NULL',
  'no claims.latest_signature_request_id mutation',
  'SQL75 column-level file-link permission remains narrow with RLS enforced',
  'email branding does not assume unapplied SES columns',
  'editor field IDs map safely to persisted UUID fields',
  'no first-signature-wins/ambiguous cross-mapping',
  'completed PDF uses the accepted signed-document storage contract',
]);

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('signature-requests ownership group is narrowly scoped to the proven chain', () => {
  const protectedPaths = loadJson(path.join(ROOT, 'ops/release-locks/protected-paths.json'));
  const group = protectedPaths.ownership_groups['signature-requests'];
  assert.ok(group, 'signature-requests ownership group is required');
  assert.deepEqual([...group.paths].sort(), [...SR_PROTECTED].sort());
  assert.ok(!group.paths.includes('aws/functions/api/homeowner.mjs'));
  assert.ok(!group.paths.includes('aws/functions/api/homeowner-signing-integration.mjs'));

  const hashes = computeOwnershipHashes(ROOT, protectedPaths);
  assert.deepEqual(hashes.groups['signature-requests'].files, [...SR_PROTECTED].sort());
  assert.equal(hashes.groups['signature-requests'].missing.length, 0);

  for (const rel of SR_PROTECTED) {
    const matches = matchProtectedPath(rel, protectedPaths);
    assert.ok(
      matches.some((row) => row.groupId === 'signature-requests'),
      `${rel} must belong to signature-requests`,
    );
  }
});

test('signature-requests lock is staging-only and pins the UAT tree hash', () => {
  const manifest = loadJson(path.join(ROOT, 'ops/release-locks/locked-components.json'));
  const component = manifest.components['signature-requests'];
  assert.ok(component, 'signature-requests manifest component is required');
  assert.equal(component.id, 'signature-requests');
  assert.equal(component.ownership_group, 'signature-requests');
  assert.equal(component.classification, 'STAGING_LOCKED_NOT_PRODUCTION');
  assert.equal(component.production_active, false);
  assert.equal(component.environment, 'staging');
  assert.equal(component.source.git_sha, '5e194a4d88987ef8905e6aa4df4a5a82676a2c3a');
  assert.equal(component.source.merged, false);
  assert.equal(component.artifact.lambda_name, 'checksops-staging-api');
  assert.equal(component.artifact.lambda_version, '99a9dd03-e001-448f-8c18-7ba9f0e823e5');
  assert.equal(component.production_validation.completed, false);
  assert.equal(component.production_validation.artifact_identity, 'aZ0K2droM3XKT0eQRUYdHEKwW0ehTlAy8VY/qm7YCgE=');
  assert.equal(component.deployment_fingerprint.spa_bundle, '/assets/index-DDibq3aS.js');
  assert.equal(
    component.deployment_fingerprint.spa_sha256,
    '1236a7b145e43bab4cb99b933febd90e2fcc553a0ba93c9575267f25681371e9',
  );
  assert.ok((component.missing_evidence || []).some((row) => /production/i.test(row)));
  assert.ok(
    (component.production_validation?.evidence_refs || [])
      .includes('ops/release-locks/proof/signature-request-staging-acceptance-2026-10-04.md'),
  );
  assert.equal(component.required_sql.length, 3);
  assert.ok(component.required_sql.every((row) => row.applied === true && row.applied_environment === 'staging'));

  const protectedPaths = loadJson(path.join(ROOT, 'ops/release-locks/protected-paths.json'));
  const hashes = computeOwnershipHashes(ROOT, protectedPaths);
  assert.equal(component.source.tree_hash, hashes.groups['signature-requests'].tree_hash);
});

test('signature-request staging contract keeps the proven chain and invariants', () => {
  const contract = loadJson(path.join(ROOT, 'ops/release-locks/contracts/signature-request-staging-contract.json'));
  const evidence = loadJson(path.join(ROOT, 'ops/deployment-guard/signature-request-accepted-staging.json'));
  assert.equal(contract.environment, 'staging');
  assert.equal(contract.production_active, false);
  assert.equal(contract.accepted, true);
  assert.deepEqual(contract.chain, evidence.chain);
  for (const invariant of REQUIRED_INVARIANTS) {
    assert.ok(contract.invariants.includes(invariant), invariant);
    assert.ok(evidence.invariants.includes(invariant), invariant);
  }
  assert.ok(contract.chain.includes('Class A create-payload'));
  assert.ok(contract.chain.includes('submitted-value mapping'));
  assert.ok(contract.chain.includes('signed PDF attachment/completion'));
});

test('create/send/submit/branding capability markers remain intact', () => {
  const esign = read('aws/functions/api/esign.mjs');
  const submit = read('aws/functions/api/signature-submit.mjs');
  const branding = read('aws/functions/api/email-branding.mjs');

  assert.match(esign, /export const createSignatureRequestRows/);
  assert.match(esign, /optionalUuid\(field\.id\)/);
  assert.match(esign, /SET access_token = \$2, token_hash = \$3, expires_at = \$4::timestamptz/);
  assert.doesNotMatch(esign, /access_token\s*=\s*NULL/i);
  assert.doesNotMatch(esign, /latest_signature_request_id/);
  assert.doesNotMatch(esign, /UPDATE public\.claims/);

  assert.match(submit, /export const mapSubmittedFieldValues/);
  assert.match(submit, /export const buildSubmitSignersWithValues/);
  assert.match(submit, /uniqueCorrespondent/);
  assert.match(submit, /aws_public_signature_attach_signed/);
  assert.match(submit, /signed\/\$\{request\.claim_id\}\/\$\{request\.id\}-final\.pdf/);
  assert.doesNotMatch(submit, /first-signature-wins|firstSignatureWins/i);

  assert.match(branding, /SELECT from_name, reply_to, sending_mode, sending_domain, from_address, domain_status\n\s+FROM public\.tenant_email_settings/);
  assert.doesNotMatch(branding, /ses_identity_name, custom_sending_enabled/);
});

test('signature-request lock introduces no new validator errors for this component', () => {
  const inputs = loadReleaseLockInputs(ROOT);
  const { errors } = validateReleaseLocks(inputs);
  const scoped = errors.filter((row) => /signature-request|esign\.mjs|signature-submit|email-branding|sql\/7[345]_/i.test(row));
  assert.deepEqual(scoped, []);
  assert.equal(
    errors.some((row) => /components\.production-release: protected source tree changed/.test(row)),
    false,
    'production-release tree_hash must be updated with this control-plane change',
  );
});

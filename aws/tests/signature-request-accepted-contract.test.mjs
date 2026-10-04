/**
 * Accepted staging Signature Request chain. Source and evidence only.
 * Does not deploy, apply SQL, or mutate production.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const sha256 = (rel) => createHash('sha256').update(read(rel), 'utf8').digest('hex');

const EVIDENCE_REL = 'ops/deployment-guard/signature-request-accepted-staging.json';
const CONTRACT_REL = 'ops/release-locks/contracts/signature-request-staging-contract.json';
const REQUIRED_INVARIANTS = [
  'normal create/send does not depend on generic browser inserts',
  'no access_token = NULL',
  'no claims.latest_signature_request_id mutation',
  'SQL75 column-level file-link permission remains narrow with RLS enforced',
  'email branding does not assume unapplied SES columns',
  'editor field IDs map safely to persisted UUID fields',
  'no first-signature-wins/ambiguous cross-mapping',
  'completed PDF uses the accepted signed-document storage contract',
];

const loadEvidence = () => JSON.parse(read(EVIDENCE_REL));
const loadRegistryContract = () => {
  const registry = JSON.parse(read('ops/deployment-guard/accepted-contracts.json'));
  return (registry.contracts || []).find((row) => row.id === 'signature-requests');
};

test('accepted staging Signature Request evidence pins the UAT composition', () => {
  const evidence = loadEvidence();
  assert.equal(evidence.accepted, true);
  assert.equal(evidence.environment, 'staging');
  assert.equal(evidence.production_changed, false);
  assert.equal(evidence.uat.result, 'passed');
  assert.equal(evidence.staging_fingerprints.spa_entry, '/assets/index-DDibq3aS.js');
  assert.equal(evidence.staging_fingerprints.spa_index_sha256, '1236a7b145e43bab4cb99b933febd90e2fcc553a0ba93c9575267f25681371e9');
  assert.equal(evidence.staging_fingerprints.api_lambda_sha256, 'aZ0K2droM3XKT0eQRUYdHEKwW0ehTlAy8VY/qm7YCgE=');
  assert.equal(evidence.staging_fingerprints.api_revision_id, '99a9dd03-e001-448f-8c18-7ba9f0e823e5');
  assert.equal(evidence.staging_fingerprints.members['esign.mjs'], '7c60b6462f7e0caa21800481a68735a44fc38bde19d74f78c64bc5ca97956b74');
  assert.equal(evidence.staging_fingerprints.members['signature-submit.mjs'], '24845b4cfbce74de6163a7f94174d5c56af2e5828cfbdeca99c791175150f38d');
  assert.equal(evidence.staging_fingerprints.members['email-branding.mjs'], '8b23eb8893377bad1c11d9a02522c789d222053b084d4ba53107eae7d374bb4b');
  assert.equal(evidence.staging_fingerprints.members['homeowner.mjs'], 'e770bbca94c31096443a96b03aed6a0e36e780ef79b17e1e73423647ede3e302');
  assert.equal(evidence.staging_fingerprints.members['homeowner-signing-integration.mjs'], 'd1a83f97003024419fcab8948667a3789d1e623e32f7229144587a35dc755a6f');
  assert.equal(evidence.production_untouched.api_lambda_sha256, 'CWB8lxnHoqANyVcaNpKL7h4MtDSPMlHZ6wliFuGE6yA=');
  for (const invariant of REQUIRED_INVARIANTS) {
    assert.ok(evidence.invariants.includes(invariant), invariant);
  }
  assert.ok(evidence.chain.includes('Class A create-payload'));
  assert.ok(evidence.chain.includes('submitted-value mapping'));
  assert.ok(evidence.chain.includes('signed PDF attachment/completion'));
});

test('registry and release-lock contract keep the proven chain executable', () => {
  const contract = loadRegistryContract();
  const evidence = loadEvidence();
  const lock = JSON.parse(read(CONTRACT_REL));
  assert.ok(contract, 'signature-requests contract missing');
  assert.equal(contract.accepted, true);
  assert.equal(contract.enabled, true);
  assert.equal(contract.evidence, EVIDENCE_REL);
  assert.equal(contract.test, 'aws/tests/signature-request-accepted-contract.test.mjs');
  for (const type of ['spa-promote', 'lambda-overlay']) {
    assert.ok(contract.deployment_types.includes(type), type);
  }
  for (const invariant of REQUIRED_INVARIANTS) {
    assert.ok(contract.invariants.includes(invariant), invariant);
    assert.ok(lock.invariants.includes(invariant), invariant);
  }
  for (const rel of contract.tests || []) {
    assert.ok(fs.existsSync(path.join(ROOT, rel)), rel);
  }
  assert.equal(lock.environment, 'staging');
  assert.equal(lock.production_active, false);
  assert.equal(lock.evidence, EVIDENCE_REL);
  assert.deepEqual(lock.chain, evidence.chain);
});

test('current source still matches the accepted live esign/submit/branding members', () => {
  const evidence = loadEvidence();
  assert.equal(sha256('aws/functions/api/esign.mjs'), evidence.staging_fingerprints.members['esign.mjs']);
  assert.equal(sha256('aws/functions/api/signature-submit.mjs'), evidence.staging_fingerprints.members['signature-submit.mjs']);
  assert.equal(sha256('aws/functions/api/email-branding.mjs'), evidence.staging_fingerprints.members['email-branding.mjs']);
});

test('create/send, branding, and stamp invariants remain in the accepted members', () => {
  const esign = read('aws/functions/api/esign.mjs');
  const submit = read('aws/functions/api/signature-submit.mjs');
  const branding = read('aws/functions/api/email-branding.mjs');
  const evidence = loadEvidence();

  assert.match(esign, /export const createSignatureRequestRows/);
  assert.match(esign, /optionalUuid\(field\.id\)/);
  assert.match(esign, /SET access_token = \$2, token_hash = \$3, expires_at = \$4::timestamptz/);
  assert.match(esign, /UPDATE public\.check_files/);
  assert.match(esign, /if \(!requestId\) \{\s+const created = await createSignatureRequestRows/);
  assert.doesNotMatch(esign, /access_token\s*=\s*NULL/i);
  assert.doesNotMatch(esign, /latest_signature_request_id/);
  assert.doesNotMatch(esign, /UPDATE public\.claims/);

  assert.match(submit, /export const mapSubmittedFieldValues/);
  assert.match(submit, /export const buildSubmitSignersWithValues/);
  assert.match(submit, /export const sameFieldPlacement/);
  assert.match(submit, /export const shouldStampSignatureImage/);
  assert.match(submit, /uniqueCorrespondent/);
  assert.match(submit, /aws_public_signature_attach_signed/);
  assert.match(submit, /signed\/\$\{request\.claim_id\}\/\$\{request\.id\}-final\.pdf/);
  assert.match(submit, /files\/\$\{request\.id\}-final\.pdf/);
  assert.doesNotMatch(submit, /first-signature-wins|firstSignatureWins/i);

  assert.match(branding, /SELECT from_name, reply_to, sending_mode, sending_domain, from_address, domain_status\n\s+FROM public\.tenant_email_settings/);
  assert.doesNotMatch(branding, /ses_identity_name, custom_sending_enabled/);

  assert.equal(evidence.storage_path_contract.claim_linked, 'signed/{claim_id}/{request_id}-final.pdf');
  assert.equal(evidence.storage_path_contract.attach_rpc, 'aws_public_signature_attach_signed');
});

test('SQL73/74/75 source hashes and SQL75 column-grant stay narrow', () => {
  const evidence = loadEvidence();
  assert.equal(sha256(evidence.sql.sql73.path), evidence.sql.sql73.source_sha256);
  assert.equal(sha256(evidence.sql.sql74.path), evidence.sql.sql74.source_sha256);
  assert.equal(sha256(evidence.sql.sql75.path), evidence.sql.sql75.source_sha256);

  const sql75 = read(evidence.sql.sql75.path);
  assert.match(sql75, /GRANT UPDATE \(signature_request_id\) ON TABLE public\.check_files TO checksops, authenticated;/);
  assert.doesNotMatch(sql75, /GRANT UPDATE ON TABLE public\.check_files/);
  assert.doesNotMatch(sql75, /GRANT UPDATE \(file_path\)/);
  assert.doesNotMatch(sql75, /TO PUBLIC/);
  assert.doesNotMatch(sql75, /ENABLE ROW LEVEL SECURITY|FORCE ROW LEVEL SECURITY|CREATE POLICY|DROP POLICY/);

  const sql74 = read(evidence.sql.sql74.path);
  assert.match(sql74, /aws_public_homeowner_pending_signatures/);
  assert.match(sql74, /aws_public_homeowner_document_sign_capability/);
  assert.match(sql74, /Never UPDATE signature_signers/);
  assert.doesNotMatch(sql74, /SET token_hash/);
});

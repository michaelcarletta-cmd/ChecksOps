/**
 * Signature production contract and invariant tests.
 * Synthetic local tests only. Does not write AWS or production.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { loadJson, validateReleaseLocks } from '../../../scripts/lib/release-locks.mjs';
import { loadReleaseLockInputs } from '../../../scripts/validate-release-locks.mjs';
import { compareCandidate } from '../../../scripts/production-deploy-guard.mjs';
import { mapSubmittedFieldValues } from '../../../aws/functions/api/signature-submit.mjs';
import {
  ACCEPTED_SIGNATURE_PROVENANCE,
  SIGNATURE_WORKFLOW_ID,
  acceptedSignatureCandidate,
  candidateTouchesSignature,
  compareSignatureCandidate,
  detectSignatureSourceFailures,
  evaluateSignatureSourceInvariants,
  isAcceptanceIdentity,
} from '../../../scripts/lib/signature-production-contract.mjs';
import { patchC9qrBjzFiles } from '../../../scripts/lib/sig-c9qr-bjz-files-patch.mjs';
import { patchSignMobilePreview } from '../../../scripts/lib/sig-mobile-sign-preview-patch.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function optionalUuidFromEsign(esignSrc) {
  assert.match(esignSrc, /const UUID_RE = \/\^\[0-9a-f\]\{8\}-/);
  assert.match(
    esignSrc,
    /const optionalUuid = \(value\) => \{\n  if \(value == null \|\| value === ''\) return null;\n  const text = String\(value\);\n  return UUID_RE\.test\(text\) \? text : null;\n\};/,
  );
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return (value) => {
    if (value == null || value === '') return null;
    const text = String(value);
    return UUID_RE.test(text) ? text : null;
  };
}

function writeCandidate(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sig-contract-'));
  const file = path.join(dir, 'candidate.json');
  fs.writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`);
  return file;
}

test('signature-workflow is source-locked and not a byte-restore PRODUCTION_LOCKED pin', () => {
  const manifest = loadJson(path.join(ROOT, 'ops/release-locks/locked-components.json'));
  const component = manifest.components[SIGNATURE_WORKFLOW_ID];
  assert.ok(component);
  assert.equal(component.classification, 'SOURCE_LOCKED_NOT_ACTIVE');
  assert.equal(component.production_active, false);
  assert.equal(component.artifact.hash, null);
  assert.match(component.notes, /provenance/);
  assert.match(component.notes, /not a PRODUCTION_LOCKED byte pin/);

  const contract = loadJson(path.join(ROOT, 'ops/release-locks/signature-production-contract.json'));
  assert.equal(contract.fail_closed, true);
  assert.equal(contract.acceptance_role, 'acceptance_evidence_not_restore_target');
  assert.equal(contract.provenance.sign_sha256, ACCEPTED_SIGNATURE_PROVENANCE.sign_sha256);
  assert.equal(contract.provenance.files_sha256, ACCEPTED_SIGNATURE_PROVENANCE.files_sha256);
  assert.equal(contract.provenance.lambda_code_sha256, ACCEPTED_SIGNATURE_PROVENANCE.lambda_code_sha256);
  assert.equal(contract.deploy_policy.never_restore_accepted_bytes, true);
});

test('accepted source invariants currently pass', () => {
  const result = evaluateSignatureSourceInvariants(ROOT);
  assert.deepEqual(result.failed, []);
  assert.equal(result.ok, true);
});

test('reintroduced anti-patterns fail the Signature detectors', () => {
  const good = evaluateSignatureSourceInvariants(ROOT);
  assert.equal(good.ok, true);
  const esign = fs.readFileSync(path.join(ROOT, 'aws/functions/api/esign.mjs'), 'utf8');
  const submit = fs.readFileSync(path.join(ROOT, 'aws/functions/api/signature-submit.mjs'), 'utf8');
  const documents = fs.readFileSync(path.join(ROOT, 'aws/functions/api/documents.mjs'), 'utf8');
  const sign = fs.readFileSync(path.join(ROOT, 'src/pages/Sign.tsx'), 'utf8');
  const requests = fs.readFileSync(path.join(ROOT, 'src/components/claim-detail/SignatureRequests.tsx'), 'utf8');
  const allowlist = fs.readFileSync(path.join(ROOT, 'aws/functions/api/write-allowlist.mjs'), 'utf8');

  const cases = [
    ['access_token_null', { esign: `${esign}\nSET access_token = NULL` }],
    ['claims_latest_signature_request_id', { esign: `${esign}\nUPDATE public.claims SET latest_signature_request_id = $1` }],
    ['certificate_pdf_path', { documents: `${documents}\ncertificate_pdf_path` }],
    ['dummy_staging_certificate', { documents: `${documents}\nSignature certificate (staging retry)` }],
    ['first_signature_wins', { submit: `${submit}\nfirstSignatureWins` }],
    ['data_image_stamp_missing', { submit: submit.replaceAll('SUPPORTED_DATA_IMAGE', 'X').replaceAll('data:image', 'data:x') }],
    ['retry_sql_not_hard_fail', { documents: documents.replace("throw new Error('final_pdf_path_update_failed')", 'return { ok: false }') }],
    ['swallowed_retry_sql', { documents: documents.replaceAll('final_pdf_path_update_failed', '') }],
    ['narrow_independent_70vh_400', { sign: sign.replace('style={signPreviewFrameStyle(narrowPreview)}', 'style={{ height: "70vh", minHeight: "400px" }}') }],
    ['signatures_claim_upload', { requests: `${requests}\nsignatures/\${claimId}/file.pdf` }],
    ['generic_frontend_inserts', { requests: `${requests}\n.from("signature_requests")\n        .insert({ id: 1 })` }],
    ['generic_frontend_inserts', { requests: `${requests}\n.from("signature_signers")\n        .insert({ id: 1 })` }],
    ['write_allowlist_signature_tables', { allowlist: `${allowlist}\nsignature_requests` }],
  ];

  for (const [expected, overlay] of cases) {
    const failed = detectSignatureSourceFailures({
      esign,
      submit,
      documents,
      sign,
      requests,
      allowlist,
      ...overlay,
    });
    assert.ok(failed.includes(expected), `${expected} should fail, got ${failed.join(',')}`);
  }
});

test('Class A, optionalUuid, data-URL stamp, and deterministic coordinates remain available', async () => {
  const esignSrc = fs.readFileSync(path.join(ROOT, 'aws/functions/api/esign.mjs'), 'utf8');
  assert.match(esignSrc, /export const createSignatureRequestRows/);
  assert.match(esignSrc, /optionalUuid\(field\.id\)/);
  const optionalUuid = optionalUuidFromEsign(esignSrc);
  assert.equal(optionalUuid('signature-1759180000000'), null);
  assert.equal(optionalUuid('aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'), 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa');

  const documentsSrc = fs.readFileSync(path.join(ROOT, 'aws/functions/api/documents.mjs'), 'utf8');
  assert.match(documentsSrc, /attachCompletedSignatureDocument/);
  assert.match(documentsSrc, /export const handleRetryPdfGeneration/);
  assert.equal(documentsSrc.includes('certificate_pdf_path'), false);
  assert.equal(documentsSrc.includes('Signature certificate (staging retry)'), false);
  assert.match(documentsSrc, /throw new Error\('final_pdf_path_update_failed'\)/);

  const submitSrc = fs.readFileSync(path.join(ROOT, 'aws/functions/api/signature-submit.mjs'), 'utf8');
  assert.match(submitSrc, /SUPPORTED_DATA_IMAGE/);
  assert.match(submitSrc, /export const stampSignaturePdf/);

  const persisted = { id: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', field_type: 'signature', page: 1, x: 12, y: 78, width: 32, height: 9 };
  const other = { id: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb', field_type: 'signature', page: 1, x: 58, y: 22, width: 28, height: 8 };
  const mapped = mapSubmittedFieldValues(
    [persisted, other],
    {
      'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa': 'data:image/png;base64,AAA',
      'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb': 'data:image/png;base64,BBB',
    },
    [
      { id: 'signature-1', type: 'signature', page: 1, x: 12, y: 78, width: 32, height: 9 },
      { id: 'signature-2', type: 'signature', page: 1, x: 58, y: 22, width: 28, height: 8 },
    ],
  );
  assert.equal(mapped[persisted.id].value, 'data:image/png;base64,AAA');
  assert.equal(mapped[other.id].value, 'data:image/png;base64,BBB');
  assert.equal(mapped[persisted.id].x, 12);
  assert.equal(mapped[other.id].x, 58);
  assert.notEqual(mapped[persisted.id].value, mapped[other.id].value);

  const cross = mapSubmittedFieldValues(
    [persisted, other],
    { 'signature-2': 'data:image/png;base64,ONLYB' },
    [
      { id: 'signature-1', type: 'signature', page: 1, x: 12, y: 78, width: 32, height: 9 },
      { id: 'signature-2', type: 'signature', page: 1, x: 58, y: 22, width: 28, height: 8 },
    ],
  );
  assert.equal(cross[persisted.id].value, null);
  assert.equal(cross[other.id].value, 'data:image/png;base64,ONLYB');
});

test('Files overlay keeps check-scoped Class A wizard and rejects claim-scoped upload', () => {
  const fixture = fs.readFileSync(path.join(ROOT, 'tests/fixtures/current-live-CheckFilesSection-BJZPqPpX.js'), 'utf8');
  const patched = patchC9qrBjzFiles(fixture);
  const sha = createHash('sha256').update(patched).digest('hex');
  assert.equal(sha, ACCEPTED_SIGNATURE_PROVENANCE.files_sha256);
  assert.equal(patched.includes('signatures/${'), false);
  assert.equal(patched.includes('.from("signature_requests").insert'), false);
  assert.equal(patched.includes('.from("signature_signers").insert'), false);
  assert.match(patched, /send-signature-request/);
  assert.match(patched, /check-intake\/\$\{w\}\/files\//);
});

test('Sign overlay keeps the accepted mobile preview SHA without stretching the iframe', () => {
  const fixture = fs.readFileSync(path.join(ROOT, 'tests/fixtures/current-live-Sign-DfWZrlqT.js'), 'utf8');
  const patched = patchSignMobilePreview(fixture);
  const sha = createHash('sha256').update(patched).digest('hex');
  assert.equal(sha, ACCEPTED_SIGNATURE_PROVENANCE.sign_sha256);
  assert.equal(patched.includes('style:{height:"70vh",minHeight:"400px"}'), false);
  assert.match(patched, /max\(90dvh, 160vw\)/);
  assert.match(patched, /l\.toDataURL\(\)/);
});

test('Signature ownership does not lock unrelated Files source or write-allowlist', () => {
  const protectedPaths = loadJson(path.join(ROOT, 'ops/release-locks/protected-paths.json'));
  const owned = protectedPaths.ownership_groups[SIGNATURE_WORKFLOW_ID].paths;
  assert.equal(owned.includes('src/components/check-review/CheckFilesSection.tsx'), false);
  assert.equal(owned.includes('aws/functions/api/write-allowlist.mjs'), false);
  assert.equal(owned.includes('src/pages/Sign.tsx'), true);
  assert.equal(owned.includes('aws/functions/api/esign.mjs'), true);
  assert.equal(owned.includes('aws/functions/api/signature-submit.mjs'), true);
  assert.equal(owned.includes('aws/functions/api/documents.mjs'), true);
});

test('current accepted live overlay is allowed; restoring accepted bytes over newer live is refused', () => {
  const manifest = loadJson(path.join(ROOT, 'ops/release-locks/locked-components.json'));
  const ok = acceptedSignatureCandidate();
  assert.deepEqual(compareCandidate(manifest, ok), []);
  assert.deepEqual(compareSignatureCandidate(ok.components[SIGNATURE_WORKFLOW_ID]), []);
  assert.equal(isAcceptanceIdentity(ok.components[SIGNATURE_WORKFLOW_ID].live_production), true);

  const restore = acceptedSignatureCandidate({ liveIsAcceptance: false });
  restore.components[SIGNATURE_WORKFLOW_ID].sign_bundle = ACCEPTED_SIGNATURE_PROVENANCE.sign_bundle;
  restore.components[SIGNATURE_WORKFLOW_ID].sign_sha256 = ACCEPTED_SIGNATURE_PROVENANCE.sign_sha256;
  restore.components[SIGNATURE_WORKFLOW_ID].files_bundle = ACCEPTED_SIGNATURE_PROVENANCE.files_bundle;
  restore.components[SIGNATURE_WORKFLOW_ID].files_sha256 = ACCEPTED_SIGNATURE_PROVENANCE.files_sha256;
  restore.components[SIGNATURE_WORKFLOW_ID].lambda_code_sha256 = ACCEPTED_SIGNATURE_PROVENANCE.lambda_code_sha256;
  restore.components[SIGNATURE_WORKFLOW_ID].entry = ACCEPTED_SIGNATURE_PROVENANCE.entry;
  restore.components[SIGNATURE_WORKFLOW_ID].restore_accepted_bytes = true;
  restore.components[SIGNATURE_WORKFLOW_ID].restore_old_dist = true;
  const restoreErrors = compareCandidate(manifest, restore);
  assert.ok(restoreErrors.some((row) => /refused restore of accepted C9Qr\/BJZ\/Sign\/Lambda bytes/.test(row)));
  assert.ok(restoreErrors.some((row) => /never restore an old dist or old Lambda ZIP/.test(row)));
});

test('unreconciled live drift, missing live read, dropped invariants, and silent Signature deploys fail closed', () => {
  const manifest = loadJson(path.join(ROOT, 'ops/release-locks/locked-components.json'));
  const drifted = acceptedSignatureCandidate({ liveIsAcceptance: false });
  drifted.components[SIGNATURE_WORKFLOW_ID].reconciled_signature_contract = false;
  const driftErrors = compareCandidate(manifest, drifted);
  assert.ok(driftErrors.some((row) => /explicit Signature contract reconciliation is required/.test(row)));

  const noLive = acceptedSignatureCandidate();
  delete noLive.components[SIGNATURE_WORKFLOW_ID].preflight_production;
  delete noLive.components[SIGNATURE_WORKFLOW_ID].live_production;
  const noLiveErrors = compareCandidate(manifest, noLive);
  assert.ok(noLiveErrors.some((row) => /must read current live SPA\/Lambda first/.test(row)));

  const dropped = acceptedSignatureCandidate();
  dropped.components[SIGNATURE_WORKFLOW_ID].signature_invariants_passed = false;
  dropped.components[SIGNATURE_WORKFLOW_ID].drops_signature_invariants = true;
  const droppedErrors = compareCandidate(manifest, dropped);
  assert.ok(droppedErrors.some((row) => /does not prove frozen Signature invariants/.test(row)));
  assert.ok(droppedErrors.some((row) => /silently removes frozen Signature invariants/.test(row)));

  const silent = {
    environment: 'production',
    approved: true,
    components: {
      'checkalt-submission': {
        deploy: true,
        lambda_name: ACCEPTED_SIGNATURE_PROVENANCE.lambda_name,
        files: ['esign.mjs', 'signature-submit.mjs'],
      },
    },
  };
  assert.equal(candidateTouchesSignature(silent), true);
  const silentErrors = compareCandidate(manifest, silent);
  assert.ok(silentErrors.some((row) => /without reconciling the Signature contract/.test(row)));
  writeCandidate(silent);
});

test('unrelated Lambda work that opts out of Signature modules is not captured', () => {
  const manifest = loadJson(path.join(ROOT, 'ops/release-locks/locked-components.json'));
  const unrelated = {
    environment: 'production',
    approved: true,
    components: {
      'checkalt-submission': {
        deploy: false,
        lambda_name: ACCEPTED_SIGNATURE_PROVENANCE.lambda_name,
        touches_signature_modules: false,
        files: ['checkalt-submit.mjs'],
      },
    },
  };
  assert.equal(candidateTouchesSignature(unrelated), false);
  assert.deepEqual(compareCandidate(manifest, unrelated).filter((row) => /signature-workflow/.test(row)), []);
});

test('full release-lock manifest still validates after the Signature contract', () => {
  const inputs = loadReleaseLockInputs(ROOT);
  const { errors } = validateReleaseLocks(inputs);
  assert.deepEqual(errors, []);
  assert.equal(inputs.manifest.components[SIGNATURE_WORKFLOW_ID].classification, 'SOURCE_LOCKED_NOT_ACTIVE');
  const locked = Object.values(inputs.manifest.components).filter((c) => c.classification === 'PRODUCTION_LOCKED');
  assert.equal(locked.length, 1);
  assert.equal(locked[0].id, 'production-spa');
});

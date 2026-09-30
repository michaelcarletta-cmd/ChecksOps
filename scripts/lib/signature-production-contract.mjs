/**
 * Signature production contract helpers.
 *
 * Protects accepted Signature *behavior*. Accepted SHAs are provenance,
 * not restore targets. Never writes AWS.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { loadJson } from './release-locks.mjs';
import {
  ACCEPTED_PRODUCTION_SPA,
  PRODUCTION_SPA_ID,
} from './production-spa-baseline.mjs';
import {
  filesInvariants,
  patchC9qrBjzFiles,
} from './sig-c9qr-bjz-files-patch.mjs';
import {
  signPreviewFrameStyle,
  signPreviewInvariants,
  patchSignMobilePreview,
} from './sig-mobile-sign-preview-patch.mjs';

export const SIGNATURE_WORKFLOW_ID = 'signature-workflow';

export const SIGNATURE_CONTRACT_PATH = 'ops/release-locks/signature-production-contract.json';
export const SIGNATURE_CONTRACT_SCHEMA_PATH =
  'ops/release-locks/schema/signature-production-contract.schema.json';

export const ACCEPTED_SIGNATURE_PROVENANCE = Object.freeze({
  role: 'acceptance_evidence_not_restore_target',
  entry: 'index-C9QrEEkl.js',
  sign_bundle: 'assets/Sign-DfWZrlqT.js',
  sign_sha256: '9f228f47e57f3f79723dc30aa5f0aed2b6facf70e1c5015d7b04dfba028d805b',
  files_bundle: 'assets/CheckFilesSection-BJZPqPpX.js',
  files_sha256: 'df1b95f4a85d04901d2d707e2feae7f3c77e605744cc5ffe9011d2872a4fb969',
  lambda_name: 'checksops-production-prep-api',
  lambda_code_sha256: 'pxZj4G6pGntJrkcRO5uNNEbiyvDpCOKPiWAboDnPvBA=',
});

export const SAFE_SIGNATURE_DEPLOY_MODES = Object.freeze([
  'per_object_put',
  'lambda_overlay',
]);

const SIGNATURE_ASSET_RE =
  /Sign-DfWZrlqT|CheckFilesSection-BJZPqPpX|esign\.mjs|signature-submit\.mjs|documents\.mjs/;

const read = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');

export function loadSignatureContract(root) {
  return loadJson(path.join(root, SIGNATURE_CONTRACT_PATH));
}

export function sha256Text(text) {
  return createHash('sha256').update(text).digest('hex');
}

export function liveIdentity(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  return {
    entry: snapshot.entry || snapshot.spa_bundle || null,
    sign_bundle: snapshot.sign_bundle || null,
    sign_sha256: snapshot.sign_sha256 || null,
    files_bundle: snapshot.files_bundle || null,
    files_sha256: snapshot.files_sha256 || null,
    lambda_code_sha256: snapshot.lambda_code_sha256 || snapshot.lambda_sha256 || null,
  };
}

export function identityEqual(left, right) {
  const a = liveIdentity(left);
  const b = liveIdentity(right);
  if (!a || !b) return false;
  return a.entry === b.entry
    && a.sign_bundle === b.sign_bundle
    && a.sign_sha256 === b.sign_sha256
    && a.files_bundle === b.files_bundle
    && a.files_sha256 === b.files_sha256
    && a.lambda_code_sha256 === b.lambda_code_sha256;
}

export function isAcceptanceIdentity(snapshot, provenance = ACCEPTED_SIGNATURE_PROVENANCE) {
  const live = liveIdentity(snapshot);
  if (!live) return false;
  const entry = String(live.entry || '').replace(/^\//, '');
  const signBundle = String(live.sign_bundle || '').replace(/^\//, '');
  const filesBundle = String(live.files_bundle || '').replace(/^\//, '');
  return (entry === provenance.entry || entry === `assets/${provenance.entry}` || entry.endsWith(provenance.entry))
    && (signBundle === provenance.sign_bundle || signBundle.endsWith('Sign-DfWZrlqT.js'))
    && live.sign_sha256 === provenance.sign_sha256
    && (filesBundle === provenance.files_bundle || filesBundle.endsWith('CheckFilesSection-BJZPqPpX.js'))
    && live.files_sha256 === provenance.files_sha256
    && live.lambda_code_sha256 === provenance.lambda_code_sha256;
}

export function candidateTouchesSignature(candidate) {
  if (!candidate || typeof candidate !== 'object') return false;
  const owned = candidate.components?.[SIGNATURE_WORKFLOW_ID];
  if (owned?.deploy === true) return true;
  for (const row of Object.values(candidate.components || {})) {
    if (!row || row.deploy !== true) continue;
    const blob = [
      row.spa_bundle,
      row.artifact,
      row.name,
      row.hash,
      ...(row.keys || []),
      ...(row.files || []),
      ...(row.lambda_files || []),
    ].map((value) => String(value || '')).join(' ');
    if (SIGNATURE_ASSET_RE.test(blob)) return true;
    if (row.lambda_name === ACCEPTED_SIGNATURE_PROVENANCE.lambda_name
      && row.touches_signature_modules !== false) {
      return true;
    }
  }
  return false;
}

function isDestructiveSignatureDeploy(row) {
  if (!row || typeof row !== 'object') return false;
  if (row.restore_old_dist === true || row.restore_old_lambda_zip === true) return true;
  if (row.restore_accepted_bytes === true) return true;
  const mode = String(row.deploy_mode || '');
  if (!mode) return false;
  if (SAFE_SIGNATURE_DEPLOY_MODES.includes(mode)) return false;
  return /sync|delete|full.?spa|restore.?zip|restore.?dist|promote.?spa/i.test(mode);
}

export function compareSignatureCandidate(row, { provenance = ACCEPTED_SIGNATURE_PROVENANCE } = {}) {
  const errors = [];
  const prefix = SIGNATURE_WORKFLOW_ID;
  if (!row || typeof row !== 'object') {
    errors.push(`${prefix}: Signature-owned deploy is missing the contract fingerprint`);
    return errors;
  }
  if (row.deploy !== true && !row.preflight_production && !row.live_production) {
    return errors;
  }

  const preflight = row.preflight_production;
  const live = row.live_production;
  if (!preflight || !live) {
    errors.push(`${prefix}: must read current live SPA/Lambda first (preflight_production and live_production required)`);
  } else if (!identityEqual(preflight, live)) {
    errors.push(`${prefix}: production changed after preflight (TOCTOU); refuse deployment`);
  }

  const basedOn = row.based_on_live || null;
  if (row.deploy === true) {
    if (!basedOn) {
      errors.push(`${prefix}: narrow overlay requires based_on_live equal to current live production`);
    } else if (live && !identityEqual(basedOn, live)) {
      errors.push(`${prefix}: based_on_live must match current live production, not a historical acceptance SHA`);
    }
    if (!row.deploy_mode) {
      errors.push(`${prefix}: Signature deploy requires deploy_mode=${SAFE_SIGNATURE_DEPLOY_MODES.join('|')}`);
    } else if (!SAFE_SIGNATURE_DEPLOY_MODES.includes(row.deploy_mode)) {
      errors.push(`${prefix}: Signature deploy_mode must be a narrow overlay (${SAFE_SIGNATURE_DEPLOY_MODES.join('|')})`);
    }
  }

  if (isDestructiveSignatureDeploy(row)) {
    errors.push(`${prefix}: never restore an old dist or old Lambda ZIP merely because its SHA matches the acceptance record`);
  }

  const candidateId = {
    entry: row.entry || row.spa_bundle,
    sign_bundle: row.sign_bundle,
    sign_sha256: row.sign_sha256 || row.hash,
    files_bundle: row.files_bundle,
    files_sha256: row.files_sha256,
    lambda_code_sha256: row.lambda_code_sha256,
  };
  if (live && !isAcceptanceIdentity(live, provenance) && isAcceptanceIdentity(candidateId, provenance)) {
    errors.push(`${prefix}: refused restore of accepted C9Qr/BJZ/Sign/Lambda bytes over newer live production`);
  }
  if (row.restore_accepted_bytes === true) {
    errors.push(`${prefix}: restoring accepted bytes is forbidden; overlay the current live baseline`);
  }

  if (live && !isAcceptanceIdentity(live, provenance) && row.reconciled_signature_contract !== true) {
    errors.push(`${prefix}: live identity drifted from the acceptance record; explicit Signature contract reconciliation is required`);
  }

  if (row.deploy === true && row.signature_invariants_passed !== true) {
    errors.push(`${prefix}: refused deploy that does not prove frozen Signature invariants still pass`);
  }
  if (row.drops_signature_invariants === true) {
    errors.push(`${prefix}: refused deploy that silently removes frozen Signature invariants`);
  }

  return errors;
}

export function detectSignatureSourceFailures({
  esign = '',
  submit = '',
  documents = '',
  sign = '',
  requests = '',
  allowlist = '',
} = {}) {
  const failed = [];

  if (!esign.includes('export const createSignatureRequestRows')) failed.push('class_a_create_missing');
  if (!esign.includes('optionalUuid(field.id)')) failed.push('optional_uuid_missing');
  if (!esign.includes('SET access_token = $2, token_hash = $3')) failed.push('token_mint_missing');
  if (esign.includes('access_token = NULL')) failed.push('access_token_null');
  if (/UPDATE\s+public\.claims[\s\S]{0,200}latest_signature_request_id/i.test(esign)) {
    failed.push('claims_latest_signature_request_id');
  }

  if (!submit.includes('export const mapSubmittedFieldValues')) failed.push('deterministic_mapping_missing');
  if (!submit.includes('Never assigns the first signature value')) failed.push('first_wins_guard_missing');
  if (!submit.includes('SUPPORTED_DATA_IMAGE') || !submit.includes('data:image')) {
    failed.push('data_image_stamp_missing');
  }
  if (!submit.includes('export const stampSignaturePdf')) failed.push('stamp_missing');
  if (submit.includes('first-signature-wins') || submit.includes('firstSignatureWins')) {
    failed.push('first_signature_wins');
  }

  if (documents.includes('certificate_pdf_path')) failed.push('certificate_pdf_path');
  if (documents.includes('Signature certificate (staging retry)')) failed.push('dummy_staging_certificate');
  if (!documents.includes('export const handleRetryPdfGeneration')) failed.push('retry_handler_missing');
  if (!documents.includes('attachCompletedSignatureDocument')) failed.push('real_final_pdf_missing');
  if (!documents.includes('final_pdf_path_update_failed')) failed.push('swallowed_retry_sql');
  const retryUpdate = documents.match(
    /UPDATE public\.signature_requests[\s\S]{0,400}final_pdf_path = \$2[\s\S]{0,400}if \(!updated\.rowCount\) \{\s*throw new Error\('final_pdf_path_update_failed'\)/,
  );
  if (!retryUpdate) failed.push('retry_sql_not_hard_fail');

  if (!sign.includes('signPreviewFrameStyle(narrowPreview)')) failed.push('mobile_preview_helper_missing');
  if (!sign.includes('max(90dvh, 160vw)')) failed.push('mobile_derived_height_missing');
  if (/style=\{\{\s*height:\s*"70vh",\s*minHeight:\s*"400px"\s*\}\}/.test(sign)) {
    failed.push('narrow_independent_70vh_400');
  }
  if (!sign.includes('canvas.toDataURL()')) failed.push('submit_data_url_missing');

  if (!requests.includes('functions.invoke("send-signature-request"')) {
    failed.push('frontend_class_a_invoke_missing');
  }
  if (requests.includes('signatures/${claimId}') || requests.includes('signatures/${r}')) {
    failed.push('signatures_claim_upload');
  }
  if (requests.includes('.from("signature_requests")\n        .insert')
    || requests.includes('.from("signature_signers")\n        .insert')) {
    failed.push('generic_frontend_inserts');
  }

  if (/\bsignature_requests\b/.test(allowlist) || /\bsignature_signers\b/.test(allowlist)) {
    failed.push('write_allowlist_signature_tables');
  }
  return failed;
}

export function evaluateSignatureSourceInvariants(root) {
  const failed = detectSignatureSourceFailures({
    esign: read(root, 'aws/functions/api/esign.mjs'),
    submit: read(root, 'aws/functions/api/signature-submit.mjs'),
    documents: read(root, 'aws/functions/api/documents.mjs'),
    sign: read(root, 'src/pages/Sign.tsx'),
    requests: read(root, 'src/components/claim-detail/SignatureRequests.tsx'),
    allowlist: read(root, 'aws/functions/api/write-allowlist.mjs'),
  });
  const filesFixture = read(root, 'tests/fixtures/current-live-CheckFilesSection-BJZPqPpX.js');
  const liveSignFixture = read(root, 'tests/fixtures/current-live-Sign-DfWZrlqT.js');

  let filesOk;
  try {
    filesOk = filesInvariants(patchC9qrBjzFiles(filesFixture));
  } catch (error) {
    failed.push(`files_overlay:${error.message}`);
    filesOk = {};
  }
  if (filesOk.no_signatures_claim === false) failed.push('files_signatures_claim_upload');
  if (filesOk.no_generic_request_insert === false) failed.push('files_generic_request_insert');
  if (filesOk.no_generic_signer_insert === false) failed.push('files_generic_signer_insert');
  if (filesOk.check_scoped_generate === false || filesOk.check_scoped_direct === false) {
    failed.push('files_check_scoped_upload_missing');
  }
  if (filesOk.class_a_create === false) failed.push('files_class_a_missing');

  let signOk;
  try {
    signOk = signPreviewInvariants(patchSignMobilePreview(liveSignFixture));
  } catch (error) {
    failed.push(`sign_overlay:${error.message}`);
    signOk = {};
  }
  if (signOk.no_live_iframe_style === false) failed.push('sign_independent_70vh_400');
  if (signOk.mobile_derived_height === false) failed.push('sign_mobile_height_missing');
  if (signOk.to_data_url === false) failed.push('sign_payload_changed');

  const desktop = signPreviewFrameStyle(false);
  const mobile = signPreviewFrameStyle(true);
  if (desktop.height !== '70vh' || desktop.minHeight !== '400px') failed.push('desktop_preview_changed');
  if (mobile.height !== 'max(90dvh, 160vw)' || mobile.minHeight !== 0) failed.push('mobile_preview_changed');

  return { ok: failed.length === 0, failed };
}

export function acceptedSignatureCandidate({ deploy = true, liveIsAcceptance = true } = {}) {
  const live = {
    entry: ACCEPTED_SIGNATURE_PROVENANCE.entry,
    sign_bundle: ACCEPTED_SIGNATURE_PROVENANCE.sign_bundle,
    sign_sha256: ACCEPTED_SIGNATURE_PROVENANCE.sign_sha256,
    files_bundle: ACCEPTED_SIGNATURE_PROVENANCE.files_bundle,
    files_sha256: ACCEPTED_SIGNATURE_PROVENANCE.files_sha256,
    lambda_code_sha256: ACCEPTED_SIGNATURE_PROVENANCE.lambda_code_sha256,
  };
  const newerLive = {
    entry: 'index-NewerEntry.js',
    sign_bundle: 'assets/Sign-Newer.js',
    sign_sha256: 'ab'.repeat(32),
    files_bundle: 'assets/CheckFilesSection-Newer.js',
    files_sha256: 'cd'.repeat(32),
    lambda_code_sha256: 'NewerLambdaSha=',
  };
  const pins = liveIsAcceptance ? live : newerLive;
  return {
    environment: 'production',
    approved: true,
    components: {
      [PRODUCTION_SPA_ID]: {
        deploy: false,
        hash: ACCEPTED_PRODUCTION_SPA.spa_sha256,
        spa_bundle: ACCEPTED_PRODUCTION_SPA.spa_bundle,
      },
      [SIGNATURE_WORKFLOW_ID]: {
        deploy,
        deploy_mode: 'per_object_put',
        based_on_live: { ...pins },
        preflight_production: { ...pins },
        live_production: { ...pins },
        signature_invariants_passed: true,
        reconciled_signature_contract: liveIsAcceptance ? false : true,
        restore_accepted_bytes: false,
        drops_signature_invariants: false,
        touches_signature_modules: true,
        sign_bundle: liveIsAcceptance ? live.sign_bundle : 'assets/Sign-Overlay.js',
        sign_sha256: liveIsAcceptance ? live.sign_sha256 : 'ef'.repeat(32),
        files_bundle: pins.files_bundle,
        files_sha256: pins.files_sha256,
        lambda_code_sha256: pins.lambda_code_sha256,
        entry: pins.entry,
      },
    },
  };
}

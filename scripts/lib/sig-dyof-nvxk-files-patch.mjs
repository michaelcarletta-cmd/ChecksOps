/**
 * Narrow patch for the CURRENT live CheckFilesSection-nvXkZh5q.js Signature wizard.
 * Applies only the two proven frontend reconciliations onto today's DyoF SPA:
 *   1) check-scoped upload constructor + refuse if checkIntakeItemId is missing
 *   2) Class A send-signature-request create (no generic request/signer inserts)
 * Does not restore C9Qr/BJZ bytes. Does not touch CCC, DTP, Sign, or Lambda.
 */
import {
  CHECK_SCOPED_DIRECT,
  CHECK_SCOPED_GENERATE,
  CREATE_NEW,
  CREATE_OLD,
  DIRECT_NEW,
  DIRECT_OLD,
  FILES_TAB_UPLOAD,
  GENERATE_NEW,
  GENERATE_OLD,
  RETURN_NEW,
  RETURN_OLD,
  WIZARD_FN,
} from './sig-c9qr-bjz-files-patch.mjs';

export const LIVE_ENTRY = 'index-DyoF7zdg.js';
export const LIVE_CCC = 'CheckCommandCenter-Cq_8X3gy.js';
export const LIVE_FILES = 'CheckFilesSection-nvXkZh5q.js';
export const FILES_KEY = `assets/${LIVE_FILES}`;

export const EXPECTED_FILES_SHA256 =
  '914811d126394bdef711f4e5be47299c34ef18e5c6a096613d0173697f9ea052';
export const EXPECTED_HTML_SHA256 =
  'd1a24f1089416b6a9630195ce87c310a0798cbcce3f207ae9cd5438a7e0954ac';
export const EXPECTED_ENTRY_SHA256 =
  '82002b64741255e8fd73e3fea61d8a2abebb255088d4508fa0ce23c425565080';
export const EXPECTED_CCC_SHA256 =
  'f537a5a3502b9c9f5753690ec6d5c2805397acd4c45cfd23d00394072fad4c77';

export {
  CHECK_SCOPED_DIRECT,
  CHECK_SCOPED_GENERATE,
  CREATE_NEW,
  CREATE_OLD,
  DIRECT_NEW,
  DIRECT_OLD,
  FILES_TAB_UPLOAD,
  GENERATE_NEW,
  GENERATE_OLD,
  RETURN_NEW,
  RETURN_OLD,
  WIZARD_FN,
};

const count = (src, needle) => String(src).split(needle).length - 1;

export const filesInvariants = (source) => {
  const js = String(source);
  return {
    has_wizard: js.includes(WIZARD_FN),
    check_scoped_generate: js.includes(CHECK_SCOPED_GENERATE),
    check_scoped_direct: js.includes(CHECK_SCOPED_DIRECT),
    files_tab_unchanged: js.includes(FILES_TAB_UPLOAD),
    missing_check_refusals: (js.match(/Signature upload requires a check-scoped path/g) || []).length === 2,
    no_signatures_claim: !js.includes('signatures/${r}/') && !js.includes('signatures/${'),
    no_generic_request_insert: !js.includes('.from("signature_requests").insert'),
    no_generic_signer_insert: !js.includes('.from("signature_signers").insert'),
    class_a_create: js.includes(CREATE_NEW),
    class_a_return: js.includes(RETURN_NEW),
    resend_request_id: js.includes('functions.invoke("send-signature-request",{body:{requestId:s,skipEmail:!1,targetSignerIds:a}})')
      || js.includes('functions.invoke("send-signature-request",{body:{requestId:'),
    send_button: js.includes('Send for Signature'),
    create_error_toast: js.includes('Failed to create request'),
    imports_dyof: js.includes('from"./index-DyoF7zdg.js"'),
    imports_ccc: js.includes('from"./CheckCommandCenter-Cq_8X3gy.js"'),
    no_c9qr_restore: !js.includes('index-C9QrEEkl.js'),
    no_bjz_restore: !js.includes('CheckFilesSection-BJZPqPpX.js'),
  };
};

export const patchDyofNvxkFiles = (source) => {
  const js = String(source);
  if (!js.includes(WIZARD_FN)) {
    throw new Error('nvXk Files chunk lost inlined Signature wizard _s');
  }
  if (count(js, GENERATE_OLD) !== 1) {
    throw new Error(`expected exactly one generate signatures/\${r} site, found ${count(js, GENERATE_OLD)}`);
  }
  if (count(js, DIRECT_OLD) !== 1) {
    throw new Error(`expected exactly one direct signatures/\${r} site, found ${count(js, DIRECT_OLD)}`);
  }
  if (count(js, CREATE_OLD) !== 1) {
    throw new Error(`expected exactly one generic signature_requests insert, found ${count(js, CREATE_OLD)}`);
  }
  if (count(js, RETURN_OLD) !== 1) {
    throw new Error(`expected exactly one create return {..._}, found ${count(js, RETURN_OLD)}`);
  }
  if (!js.includes(FILES_TAB_UPLOAD)) {
    throw new Error('nvXk Files chunk lost the Files-tab check-intake upload');
  }
  if (!js.includes('from"./index-DyoF7zdg.js"')) {
    throw new Error('nvXk Files chunk does not import current DyoF entry');
  }

  const next = js
    .replace(GENERATE_OLD, GENERATE_NEW)
    .replace(DIRECT_OLD, DIRECT_NEW)
    .replace(CREATE_OLD, CREATE_NEW)
    .replace(RETURN_OLD, RETURN_NEW);

  const invariants = filesInvariants(next);
  const failed = Object.entries(invariants).filter(([, ok]) => !ok).map(([key]) => key);
  if (failed.length) {
    throw new Error(`nvXk patch invariants failed: ${failed.join(',')}`);
  }
  if (next.includes(GENERATE_OLD) || next.includes(DIRECT_OLD) || next.includes(CREATE_OLD)) {
    throw new Error('old nvXk Signature sites remain after patch');
  }
  if (next.includes(',if(!w)throw new Error("Signature upload requires a check-scoped path")')) {
    throw new Error('path overlay inserted if into a comma declaration');
  }
  if (next.includes(';if(!w)throw new Error("Signature upload requires a check-scoped path");K=')
    || next.includes(';if(!w)throw new Error("Signature upload requires a check-scoped path");d=')) {
    throw new Error('path overlay left undeclared K= or d= after if(!w)');
  }
  return next;
};

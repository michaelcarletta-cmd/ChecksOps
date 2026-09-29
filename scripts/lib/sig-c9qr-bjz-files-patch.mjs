/**
 * Narrow patch for the CURRENT live CheckFilesSection-BJZPqPpX.js Signature wizard.
 * Applies only the two proven frontend reconciliations:
 *   1) check-scoped upload constructor + refuse if checkIntakeItemId is missing
 *   2) Class A send-signature-request create (no generic request/signer inserts)
 * Does not touch Files-tab upload, CCC, C9Qr, DTP, or Lambda.
 */

export const EXPECTED_FILES_SHA256 =
  '2f71de730dc29f10b3ce61821f1fe570a64c7ef02933d7415faf3f882a7de339';
export const EXPECTED_HTML_SHA256 =
  '2a8e5245d18a4a84b6175cace303dff9c06b27e5114e4cc439fe9854b2e53575';
export const EXPECTED_ENTRY_SHA256 =
  '10c0aab80ddc918744c5acdad0e25ef75d957aaf5c0409707abf06f9e35864f9';
export const EXPECTED_CCC_SHA256 =
  '436e07c2ca2dc8e876c28a6cffa5015850858de66dc2f8682b74c6d606e43973';
export const EXPECTED_DTP_SHA256 =
  'bcb6dcf98e54e2be98bb92ffae03fbff3bdee25834454db6ea0a51a8b324d979';
export const EXPECTED_LAMBDA_SHA = 's7fEdoI9HXCQhheLoa6i08Zl4UJ+tyU1HDUk5StoVqs=';
export const EXPECTED_ESIGN_SHA256 =
  '630b92b2b60c32637c7065b150b9b5757a0a4e67dd41f9e066f39f6577cd05aa';

export const LIVE_ENTRY = 'index-C9QrEEkl.js';
export const LIVE_CCC = 'CheckCommandCenter-CO3eXFPG.js';
export const LIVE_FILES = 'CheckFilesSection-BJZPqPpX.js';
export const LIVE_DTP = 'SharedCheckPaymentDirection-CxyHZONq.js';
export const FILES_KEY = `assets/${LIVE_FILES}`;

export const WIZARD_FN = 'function _s({claimId:r,claim:p,checkIntakeItemId:w=null})';
export const FILES_TAB_UPLOAD = 'check-intake/${r}/files/${Date.now()}-${crypto.randomUUID()}-${D}';
export const CHECK_SCOPED_GENERATE =
  'check-intake/${w}/files/${Date.now()}-${crypto.randomUUID()}-${s.fileName}';
export const CHECK_SCOPED_DIRECT =
  'check-intake/${w}/files/${Date.now()}-${crypto.randomUUID()}-${i}';
export const MISSING_CHECK = 'Signature upload requires a check-scoped path';

export const GENERATE_OLD =
  ',K=`signatures/${r}/${Date.now()}-${s.fileName}`,H=new Blob([_],{type:E}),{error:P}=await o.storage.from("claim-files").upload(K,H);if(P)throw P;';
export const GENERATE_NEW =
  ';if(!w)throw new Error("Signature upload requires a check-scoped path");const K=`check-intake/${w}/files/${Date.now()}-${crypto.randomUUID()}-${s.fileName}`,H=new Blob([_],{type:E}),{error:P}=await o.storage.from("claim-files").upload(K,H);if(P)throw P;{const{error:__cf}=await o.from("check_files").insert({check_intake_item_id:w,file_name:s.fileName||"Document",file_path:K,file_type:E,file_size:H.size,category:"other",source:"manual"});if(__cf)throw __cf;N.invalidateQueries({queryKey:["signature-source-files",r,w]});N.invalidateQueries({queryKey:["check-files",w]});}';

export const DIRECT_OLD =
  ',d=`signatures/${r}/${Date.now()}-${i}`,{error:_}=await o.storage.from("claim-files").upload(d,k);if(_)throw _;';
export const DIRECT_NEW =
  ';if(!w)throw new Error("Signature upload requires a check-scoped path");const d=`check-intake/${w}/files/${Date.now()}-${crypto.randomUUID()}-${i}`,{error:_}=await o.storage.from("claim-files").upload(d,k);if(_)throw _;{const{error:__cf}=await o.from("check_files").insert({check_intake_item_id:w,file_name:k.name,file_path:d,file_type:k.type||null,file_size:k.size,category:"other",source:"manual"});if(__cf)throw __cf;N.invalidateQueries({queryKey:["signature-source-files",r,w]});N.invalidateQueries({queryKey:["check-files",w]});}';

export const CREATE_OLD =
  '{data:_,error:E}=await o.from("signature_requests").insert({claim_id:r,check_intake_item_id:w||null,document_name:d,document_path:g,document_type:xs(d),field_data:t,status:"draft"}).select().single();if(E)throw E;w&&g&&await o.from("check_files").update({signature_request_id:_.id}).eq("check_intake_item_id",w).eq("file_path",g);const K=v.map(M=>({signature_request_id:_.id,signer_name:M.name,signer_email:M.email,signer_type:M.type,signing_order:M.order})),{error:H}=await o.from("signature_signers").insert(K);if(H)throw H;const{data:P,error:O}=await o.functions.invoke("send-signature-request",{body:{requestId:_.id,skipEmail:s}});';
export const CREATE_NEW =
  '{data:P,error:O}=await o.functions.invoke("send-signature-request",{body:{claim_id:r,check_intake_item_id:w||null,document_name:d,document_path:g,document_type:xs(d),field_data:t,signers:v.map(M=>({name:M.name,email:M.email,type:M.type,order:M.order})),skipEmail:s}});';

export const RETURN_OLD =
  'return{..._,mode:(P==null?void 0:P.mode)||(s?"manual_bypass":"delivered")}';
export const RETURN_NEW =
  'return{id:P==null?void 0:P.requestId,...P,mode:(P==null?void 0:P.mode)||(s?"manual_bypass":"delivered")}';

export const RETIRED_FILES = [
  'CheckFilesSection-0Fmhwbep.js',
  'CheckFilesSection-D_MzlCn1.js',
  'CheckFilesSection-DC3uOrqc.js',
];

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
    imports_c9qr: js.includes('from"./index-C9QrEEkl.js"'),
    imports_ccc: js.includes('from"./CheckCommandCenter-CO3eXFPG.js"'),
    no_retired_files: RETIRED_FILES.every((name) => !js.includes(name)),
  };
};

export const patchC9qrBjzFiles = (source) => {
  const js = String(source);
  if (!js.includes(WIZARD_FN)) {
    throw new Error('BJZ Files chunk lost inlined Signature wizard _s');
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
    throw new Error('BJZ Files chunk lost the Files-tab check-intake upload');
  }
  if (!js.includes('from"./index-C9QrEEkl.js"')) {
    throw new Error('BJZ Files chunk does not import current C9Qr entry');
  }

  const next = js
    .replace(GENERATE_OLD, GENERATE_NEW)
    .replace(DIRECT_OLD, DIRECT_NEW)
    .replace(CREATE_OLD, CREATE_NEW)
    .replace(RETURN_OLD, RETURN_NEW);

  const invariants = filesInvariants(next);
  const failed = Object.entries(invariants).filter(([, ok]) => !ok).map(([key]) => key);
  if (failed.length) {
    throw new Error(`BJZ patch invariants failed: ${failed.join(',')}`);
  }
  if (next.includes(GENERATE_OLD) || next.includes(DIRECT_OLD) || next.includes(CREATE_OLD)) {
    throw new Error('old BJZ Signature sites remain after patch');
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

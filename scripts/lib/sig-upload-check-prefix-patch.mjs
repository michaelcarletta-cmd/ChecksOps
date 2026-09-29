/**
 * Narrow patch for the live CheckFilesSection-0Fmhwbep.js Signature inline.
 * Replaces claim-scoped signatures/{claimId} uploads with check-scoped
 * check-intake/{checkId}/files/ paths. Does not touch Files-tab upload.
 */

const GENERATE_OLD = ',K=`signatures/${r}/${Date.now()}-${s.fileName}`,H=new Blob([S],{type:P}),{error:U}=await d.storage.from("claim-files").upload(K,H);if(U)throw U;';
const GENERATE_NEW = ';if(!j)throw new Error("Signature upload requires a check-scoped path");const K=`check-intake/${j}/files/${Date.now()}-${crypto.randomUUID()}-${s.fileName}`,H=new Blob([S],{type:P}),{error:U}=await d.storage.from("claim-files").upload(K,H);if(U)throw U;{const{error:__cf}=await d.from("check_files").insert({check_intake_item_id:j,file_name:s.fileName||"Document",file_path:K,file_type:P,file_size:H.size,category:"other",source:"manual"});if(__cf)throw __cf;b.invalidateQueries({queryKey:["signature-source-files",r,j]});b.invalidateQueries({queryKey:["check-files",j]});}';

const DIRECT_OLD = ',c=`signatures/${r}/${Date.now()}-${a}`,{error:S}=await d.storage.from("claim-files").upload(c,E);if(S)throw S;';
const DIRECT_NEW = ';if(!j)throw new Error("Signature upload requires a check-scoped path");const c=`check-intake/${j}/files/${Date.now()}-${crypto.randomUUID()}-${a}`,{error:S}=await d.storage.from("claim-files").upload(c,E);if(S)throw S;{const{error:__cf}=await d.from("check_files").insert({check_intake_item_id:j,file_name:E.name,file_path:c,file_type:E.type||null,file_size:E.size,category:"other",source:"manual"});if(__cf)throw __cf;b.invalidateQueries({queryKey:["signature-source-files",r,j]});b.invalidateQueries({queryKey:["check-files",j]});}';

export const COMMA_IF = ',if(!j)throw new Error("Signature upload requires a check-scoped path")';
export const SEMICOLON_IF = ';if(!j)throw new Error("Signature upload requires a check-scoped path")';

/** Two-character repair for the live overlay: comma-if → semicolon-if. No other edits. */
export const repairLiveFilesCommaIf = (source) => {
  const js = String(source);
  const sites = js.split(COMMA_IF).length - 1;
  if (sites !== 2) {
    throw new Error(`expected exactly two comma-if sites, found ${sites}`);
  }
  const next = js.replaceAll(COMMA_IF, SEMICOLON_IF);
  if (next.includes(COMMA_IF)) {
    throw new Error('comma-if sites remain after repair');
  }
  if ((next.split(SEMICOLON_IF).length - 1) !== 2) {
    throw new Error('semicolon-if site count is not 2 after repair');
  }
  if (next.length !== js.length) {
    throw new Error('repair changed file length');
  }
  let changed = 0;
  for (let i = 0; i < js.length; i += 1) {
    if (js[i] !== next[i]) changed += 1;
  }
  if (changed !== 2) {
    throw new Error(`repair changed ${changed} bytes; expected 2`);
  }
  return next;
};

export const IF_THEN_C = ';if(!j)throw new Error("Signature upload requires a check-scoped path");c=';
export const IF_THEN_CONST_C = ';if(!j)throw new Error("Signature upload requires a check-scoped path");const c=';
export const IF_THEN_K = ';if(!j)throw new Error("Signature upload requires a check-scoped path");K=';
export const IF_THEN_CONST_K = ';if(!j)throw new Error("Signature upload requires a check-scoped path");const K=';

/** Restore const on the two Signature upload bindings split by the semicolon repair. */
export const repairLiveFilesConstRestore = (source) => {
  const js = String(source);
  if ((js.split(IF_THEN_C).length - 1) !== 1) {
    throw new Error('expected exactly one undeclared c= after if(!j)');
  }
  if ((js.split(IF_THEN_K).length - 1) !== 1) {
    throw new Error('expected exactly one undeclared K= after if(!j)');
  }
  const next = js.replace(IF_THEN_C, IF_THEN_CONST_C).replace(IF_THEN_K, IF_THEN_CONST_K);
  if (next.includes(IF_THEN_C) || next.includes(IF_THEN_K)) {
    throw new Error('undeclared c=/K= sites remain after const restore');
  }
  if ((next.split(IF_THEN_CONST_C).length - 1) !== 1 || (next.split(IF_THEN_CONST_K).length - 1) !== 1) {
    throw new Error('const c=/K= site count is not 1 after restore');
  }
  if (!next.includes('const K=`check-intake/${j}/files/${Date.now()}-${crypto.randomUUID()}-${s.fileName}`,H=new Blob([S],{type:P}),{error:U}=')) {
    throw new Error('generate-document lost the const K,H,{error:U} chain');
  }
  if (!next.includes('const c=`check-intake/${j}/files/${Date.now()}-${crypto.randomUUID()}-${a}`,{error:S}=')) {
    throw new Error('direct upload lost the const c,{error:S} chain');
  }
  return next;
};

const FILES_TAB_UPLOAD = 'check-intake/${l}/files/${Date.now()}-${crypto.randomUUID()}-${i}';

export const patchLiveFilesSignatureUploads = (source) => {
  const js = String(source);
  if (!js.includes(GENERATE_OLD) || !js.includes(DIRECT_OLD)) {
    throw new Error('live Files chunk is missing the expected signatures/${claimId} upload sites');
  }
  if (!js.includes(FILES_TAB_UPLOAD)) {
    throw new Error('live Files chunk lost the Files-tab check-intake upload');
  }
  if (!js.includes('function Ss({claimId:r,claim:p,checkIntakeItemId:j=null})')) {
    throw new Error('live Files chunk lost inlined SignatureRequests');
  }
  const next = js.replace(GENERATE_OLD, GENERATE_NEW).replace(DIRECT_OLD, DIRECT_NEW);
  if (next.includes('signatures/${r}/') || next.includes('signatures/${')) {
    throw new Error('patched Files chunk still contains signatures/ upload paths');
  }
  if (!next.includes('check-intake/${j}/files/${Date.now()}-${crypto.randomUUID()}-${s.fileName}')) {
    throw new Error('generate-document upload was not retargeted');
  }
  if (!next.includes('check-intake/${j}/files/${Date.now()}-${crypto.randomUUID()}-${a}')) {
    throw new Error('direct Signature upload was not retargeted');
  }
  if (!next.includes(FILES_TAB_UPLOAD)) {
    throw new Error('Files-tab upload path was altered');
  }
  if ((next.match(/Signature upload requires a check-scoped path/g) || []).length !== 2) {
    throw new Error('missing-check refusal was not applied to both Signature uploads');
  }
  if (next.includes(COMMA_IF)) {
    throw new Error('path overlay inserted if into a comma declaration');
  }
  if (next.includes(IF_THEN_C) || next.includes(IF_THEN_K)) {
    throw new Error('path overlay left undeclared c= or K= after if(!j)');
  }
  return next;
};

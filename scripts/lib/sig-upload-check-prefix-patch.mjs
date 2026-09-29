/**
 * Narrow patch for the live CheckFilesSection-0Fmhwbep.js Signature inline.
 * Replaces claim-scoped signatures/{claimId} uploads with check-scoped
 * check-intake/{checkId}/files/ paths. Does not touch Files-tab upload.
 */

const GENERATE_OLD = 'K=`signatures/${r}/${Date.now()}-${s.fileName}`,H=new Blob([S],{type:P}),{error:U}=await d.storage.from("claim-files").upload(K,H);if(U)throw U;';
const GENERATE_NEW = 'if(!j)throw new Error("Signature upload requires a check-scoped path");K=`check-intake/${j}/files/${Date.now()}-${crypto.randomUUID()}-${s.fileName}`,H=new Blob([S],{type:P}),{error:U}=await d.storage.from("claim-files").upload(K,H);if(U)throw U;{const{error:__cf}=await d.from("check_files").insert({check_intake_item_id:j,file_name:s.fileName||"Document",file_path:K,file_type:P,file_size:H.size,category:"other",source:"manual"});if(__cf)throw __cf;b.invalidateQueries({queryKey:["signature-source-files",r,j]});b.invalidateQueries({queryKey:["check-files",j]});}';

const DIRECT_OLD = 'c=`signatures/${r}/${Date.now()}-${a}`,{error:S}=await d.storage.from("claim-files").upload(c,E);if(S)throw S;';
const DIRECT_NEW = 'if(!j)throw new Error("Signature upload requires a check-scoped path");c=`check-intake/${j}/files/${Date.now()}-${crypto.randomUUID()}-${a}`,{error:S}=await d.storage.from("claim-files").upload(c,E);if(S)throw S;{const{error:__cf}=await d.from("check_files").insert({check_intake_item_id:j,file_name:E.name,file_path:c,file_type:E.type||null,file_size:E.size,category:"other",source:"manual"});if(__cf)throw __cf;b.invalidateQueries({queryKey:["signature-source-files",r,j]});b.invalidateQueries({queryKey:["check-files",j]});}';

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
  return next;
};

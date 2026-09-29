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

export const GRAPH_B_ICON_IMPORTS = [
  'import{C as ps}from"./circle-check-big-DbOxWV8k.js";',
  'import{C as ws}from"./chevron-left-DsjQvYNH.js";',
  'import{C as re}from"./chevron-right-CTYLC974.js";',
].join('');

export const GRAPH_B_ICON_LOCALS = [
  'const ps=Ye("CircleCheckBig",[["path",{d:"M21.801 10A10 10 0 1 1 17 3.335",key:"yps3ct"}],["path",{d:"m9 11 3 3L22 4",key:"1pflzl"}]]);',
  'const ws=Ye("ChevronLeft",[["path",{d:"m15 18-6-6 6-6",key:"1wnfg3"}]]);',
  'const re=Ye("ChevronRight",[["path",{d:"m9 18 6-6-6-6",key:"mthhwq"}]]);',
].join('');

const GRAPH_B_ICON_FILES = [
  'circle-check-big-DbOxWV8k.js',
  'chevron-left-DsjQvYNH.js',
  'chevron-right-CTYLC974.js',
  'index-C5ku3IDF.js',
];

/** Drop leftover Graph B lucide imports that pull index-C5ku3IDF.js. */
export const repairLiveFilesDropGraphBIcons = (source) => {
  const js = String(source);
  if (!js.includes('import{m as Ye,')) {
    throw new Error('live Files chunk lost the DJN lucide factory Ye import');
  }
  if (!js.includes(GRAPH_B_ICON_IMPORTS)) {
    throw new Error('live Files chunk is missing the Graph B icon import block');
  }
  if ((js.split(GRAPH_B_ICON_IMPORTS).length - 1) !== 1) {
    throw new Error('expected exactly one Graph B icon import block');
  }
  if (!js.includes('const g="claim-files";')) {
    throw new Error('live Files chunk lost the claim-files bucket const');
  }
  const withoutImports = js.replace(GRAPH_B_ICON_IMPORTS, '');
  if (withoutImports.includes(GRAPH_B_ICON_IMPORTS)) {
    throw new Error('Graph B icon imports remain after removal');
  }
  const next = withoutImports.replace(
    'const g="claim-files";',
    `const g="claim-files";${GRAPH_B_ICON_LOCALS}`,
  );
  if (!next.includes(GRAPH_B_ICON_LOCALS)) {
    throw new Error('DJN-bound ps/ws/re locals were not inserted');
  }
  if ((next.split('const ps=Ye("CircleCheckBig"').length - 1) !== 1
    || (next.split('const ws=Ye("ChevronLeft"').length - 1) !== 1
    || (next.split('const re=Ye("ChevronRight"').length - 1) !== 1) {
    throw new Error('expected exactly one DJN-bound local for ps, ws, and re');
  }
  for (const name of GRAPH_B_ICON_FILES) {
    if (next.includes(name)) {
      throw new Error(`patched Files chunk still references ${name}`);
    }
  }
  if (!next.includes('function Ss({claimId:r,claim:p,checkIntakeItemId:j=null})')) {
    throw new Error('icon retarget lost inlined SignatureRequests');
  }
  if (!next.includes('const K=`check-intake/${j}/files/${Date.now()}-${crypto.randomUUID()}-${s.fileName}`,H=new Blob([S],{type:P}),{error:U}=')) {
    throw new Error('icon retarget changed the generate-document upload path');
  }
  if (!next.includes('const c=`check-intake/${j}/files/${Date.now()}-${crypto.randomUUID()}-${a}`,{error:S}=')) {
    throw new Error('icon retarget changed the direct Signature upload path');
  }
  if (!next.includes(FILES_TAB_UPLOAD)) {
    throw new Error('icon retarget changed the Files-tab upload path');
  }
  if (next.includes('signatures/${r}/') || next.includes('signatures/${')) {
    throw new Error('icon retarget reintroduced signatures/ upload paths');
  }
  if (!next.includes(',fs,ps,ws,re});function ee({checkIntakeItemId:l})')) {
    throw new Error('icon retarget lost IIFE bindings for ps/ws/re');
  }
  return next;
};

export const DJN_COLLAPSIBLE_IMPORTS = 'dq as Ze,dr as Ie,';
export const DJN_COLLAPSIBLE_SS_IMPORT = 'ds as ss,';

export const SIG_EXTRA_IMPORT_WITH_DQ = 'import{m as Ye,ag as ke,dq as Ze,dr as Ie,bM as es,T as je,ds as ss,a9 as Le,aQ as ts,bw as Te,cU as sigScroll,bc as is,c as le,_ as ns,bl as rs,aS as Fe,bb as ls,h as sigY,am as se,an as te,ao as ae,ap as ie,aq as sigQ,I as fe,aO as ne,bu as os,e as cs,aP as pe,g as Ee}from"./index-DJNHggvS.js";';

export const SIG_EXTRA_IMPORT_NO_DQ = 'import{m as Ye,ag as ke,bM as es,T as je,a9 as Le,aQ as ts,bw as Te,cU as sigScroll,bc as is,c as le,_ as ns,bl as rs,aS as Fe,bb as ls,h as sigY,am as se,an as te,ao as ae,ap as ie,aq as sigQ,I as fe,aO as ne,bu as os,e as cs,aP as pe,g as Ee}from"./index-DJNHggvS.js";';

export const CHEVRON_RIGHT_LOCAL = 'const re=Ye("ChevronRight",[["path",{d:"m9 18 6-6-6-6",key:"mthhwq"}]]);';

export const DIAG_COLLAPSIBLE_WRAPPERS = [
  'const Ze=({open:o,onOpenChange:n,children:c,className:a,...r})=>e.jsx("details",{open:!!o,className:a,onToggle:t=>{n&&n(t.currentTarget.open)},...r,children:c});',
  'const Ie=({children:c,className:a,...r})=>e.jsx("summary",{className:a,...r,children:c});',
  'const ss=({children:c,className:a,...r})=>e.jsx("div",{className:a,...r,children:c});',
].join('');

/** Replace Graph B Collapsible bindings (DJN dq/dr/ds) with host-element wrappers. */
export const repairLiveFilesDiagCollapsible = (source) => {
  const js = String(source);
  if (!js.includes(SIG_EXTRA_IMPORT_WITH_DQ)) {
    throw new Error('live Files chunk is missing the Graph B dq/dr/ds Collapsible import block');
  }
  if ((js.split(SIG_EXTRA_IMPORT_WITH_DQ).length - 1) !== 1) {
    throw new Error('expected exactly one Graph B Collapsible import block');
  }
  if (!js.includes(CHEVRON_RIGHT_LOCAL)) {
    throw new Error('live Files chunk lost the DJN-bound ChevronRight local');
  }
  if (!js.includes('const ps=Ye("CircleCheckBig"') || !js.includes('const ws=Ye("ChevronLeft"')) {
    throw new Error('live Files chunk lost the DJN-bound ps/ws icon locals');
  }
  const withoutImports = js.replace(SIG_EXTRA_IMPORT_WITH_DQ, SIG_EXTRA_IMPORT_NO_DQ);
  if (withoutImports.includes(SIG_EXTRA_IMPORT_WITH_DQ) || withoutImports.includes(DJN_COLLAPSIBLE_IMPORTS) || withoutImports.includes(DJN_COLLAPSIBLE_SS_IMPORT)) {
    throw new Error('DJN dq/dr/ds Collapsible imports remain after removal');
  }
  const next = withoutImports.replace(
    CHEVRON_RIGHT_LOCAL,
    `${CHEVRON_RIGHT_LOCAL}${DIAG_COLLAPSIBLE_WRAPPERS}`,
  );
  if (!next.includes(DIAG_COLLAPSIBLE_WRAPPERS)) {
    throw new Error('diagnostics host wrappers were not inserted');
  }
  if ((next.split('const Ze=({open:o,onOpenChange:n').length - 1) !== 1
    || (next.split('const Ie=({children:c,className:a').length - 1) !== 1
    || (next.split('const ss=({children:c,className:a').length - 1) !== 1) {
    throw new Error('expected exactly one host wrapper for Ze, Ie, and ss');
  }
  if (next.includes('dq as Ze') || next.includes('dr as Ie') || next.includes('ds as ss')) {
    throw new Error('patched Files chunk still imports DJN dq/dr/ds as Ze/Ie/ss');
  }
  if (next.includes('index-C5ku3IDF.js')) {
    throw new Error('collapsible repair reintroduced index-C5ku3IDF.js');
  }
  for (const name of GRAPH_B_ICON_FILES) {
    if (next.includes(name)) {
      throw new Error(`collapsible repair reintroduced ${name}`);
    }
  }
  if (!next.includes('const ps=Ye("CircleCheckBig"') || !next.includes('const ws=Ye("ChevronLeft"') || !next.includes(CHEVRON_RIGHT_LOCAL)) {
    throw new Error('collapsible repair changed the DJN-bound icon locals');
  }
  if (!next.includes('function Ss({claimId:r,claim:p,checkIntakeItemId:j=null})')) {
    throw new Error('collapsible repair lost inlined SignatureRequests');
  }
  if (!next.includes('e.jsxs(Ze,{open:v,onOpenChange:()=>T(v?null:i.id)')) {
    throw new Error('collapsible repair lost diagnostics open/close');
  }
  if (!next.includes('const K=`check-intake/${j}/files/${Date.now()}-${crypto.randomUUID()}-${s.fileName}`,H=new Blob([S],{type:P}),{error:U}=')) {
    throw new Error('collapsible repair changed the generate-document upload path');
  }
  if (!next.includes('const c=`check-intake/${j}/files/${Date.now()}-${crypto.randomUUID()}-${a}`,{error:S}=')) {
    throw new Error('collapsible repair changed the direct Signature upload path');
  }
  if (!next.includes(FILES_TAB_UPLOAD)) {
    throw new Error('collapsible repair changed the Files-tab upload path');
  }
  if (next.includes('signatures/${r}/') || next.includes('signatures/${')) {
    throw new Error('collapsible repair reintroduced signatures/ upload paths');
  }
  if (!next.includes(',fs,ps,ws,re});function ee({checkIntakeItemId:l})')) {
    throw new Error('collapsible repair lost IIFE bindings for ps/ws/re');
  }
  return next;
};

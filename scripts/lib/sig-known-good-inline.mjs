/**
 * Source-level transplant of the 2026-09-28T14:16 known-good Signature
 * implementation into the current CheckFilesSection-0Fmhwbep.js URL.
 *
 * Does not restore C5ku3IDF / Bc7bAAX_ / CHseToMm / D1Nz3L-a as live URLs.
 * Does not mint a second application entry.
 */
import { createHash } from 'node:crypto';
import {
  PINNED_CURRENT_LIVE,
  sha256,
} from './live-sig-baseline.mjs';

export const LIVE_FPE = 'FieldPlacementEditor-CbT-I20L.js';
export const LIVE_FPE_CSS = 'FieldPlacementEditor-C7U9D9nZ.css';
export const LIVE_TEMPLATES = 'signer-display-templates-B5YRNMRm.js';
export const LIVE_COMPRESS = 'compressCheckImage-Df2Tsl9J.js';
export const LIVE_CROPPER = 'CheckImageCropper-BlGyQebC.js';

const FILES_IMPORT =
  'import{a as F,v as z,av as E,r as p,x as T,aU as b,j as e,C as P,b as $,d as q,bz as k,B as d,L as f,by as M,f as B,F as K,M as Q,a$ as A,E as H,aZ as R,S as Z,b4 as O,b6 as W,b7 as Y,b8 as G,b9 as J,s as o}from"./index-DJNHggvS.js"';

const SIG_EXTRA_IMPORT =
  'import{m as Ye,ag as ke,dq as Ze,dr as Ie,bM as es,T as je,ds as ss,a9 as Le,aQ as ts,bw as Te,cU as sigScroll,bc as is,c as le,_ as ns,bl as rs,aS as Fe,bb as ls,h as sigY,am as se,an as te,ao as ae,ap as ie,aq as sigQ,I as fe,aO as ne,bu as os,e as cs,aP as pe,g as Ee}from"./index-DJNHggvS.js"';

const SIG_CHUNK_IMPORTS = [
  `import{d as fs}from"./${LIVE_TEMPLATES}"`,
  'import{C as ps}from"./circle-check-big-DbOxWV8k.js"',
  'import{C as ws}from"./chevron-left-DsjQvYNH.js"',
  'import{C as re}from"./chevron-right-CTYLC974.js"',
].join(';');

const INLINE_CE = 'async function ce(v,fallback){try{if(v&&v.context){const t=await v.context.text().catch(()=>"");if(t){try{const n=JSON.parse(t);return n.error||n.message||n.details||t}catch{return t}}}}catch{}return v&&v.message||fallback}';

const MAP_DEPS = `const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["assets/${LIVE_FPE}","assets/index-DJNHggvS.js","assets/index-D9SwIqYu.css","assets/tiny-invariant-CopsF_GD.js","assets/${LIVE_TEMPLATES}","assets/chevron-right-Brpv08Sy.js","assets/tag-D5wbVgNw.js","assets/${LIVE_FPE_CSS}"])))=>i.map(i=>d[i]);`;

const IIFE_BINDINGS = `{Ye,ye:F,_e:E,w:p,V:T,d:o,$:b,e,R:f,Z:P,I:B,ke,Ze,Ie,Ne:$,Se:q,G:Q,es,je,ss,Le,g:d,ts,Re:Z,Te,as:sigScroll,is,le,ns,ze:W,rs,Fe,Ke:Y,$e:G,Oe:J,ls,Y:sigY,se,te,ae,ie,Q:sigQ,fe,Me:M,ne,os,oe:K,cs,pe,Ee,ds:z,Pe:k,ms:A,us:H,hs:R,xs:O,fs,ps,ws,re}`;

const FORBIDDEN = [
  'index-C5ku3IDF',
  'CheckCommandCenter-Bc7bAAX_',
  'CheckFilesSection-CHseToMm',
  'FieldPlacementEditor-D1Nz3L-a',
  'compressCheckImage-SannDDGN',
  'SignatureRequests-ipdlcpz2',
  'index-QKetcACR',
  'CheckCommandCenter-B-yV-W5w',
  'CheckFilesSection-DC3uOrqc',
  'ReactCurrentBatchConfig',
  '__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED',
];

export function extractKnownGoodSignatureBody(chseJs) {
  const text = String(chseJs);
  const start = text.indexOf('const Ue=');
  const end = text.indexOf('function Xs(');
  if (start < 0 || end < 0 || end <= start) {
    throw new Error('known-good CHseToMm Signature body bounds missing');
  }
  let body = text.slice(start, end);
  if (!body.includes('function Ss(') || !body.includes('function js(')) {
    throw new Error('known-good Signature functions js/Ss missing');
  }
  if (!body.includes('Send for Signature') || !body.includes('Signature Requests')) {
    throw new Error('known-good Signature copy missing');
  }
  body = body.replace(
    /Ns=w\.lazy\(\(\)=>ns\(\(\)=>import\("\.\/FieldPlacementEditor-D1Nz3L-a\.js"\),__vite__mapDeps\(\[0,1,2,3,4,5,6,7,8\]\)\)\.then\(r=>\(\{default:r\.FieldPlacementEditor\}\)\)\);/,
    `Ns=w.lazy(()=>ns(()=>import("./${LIVE_FPE}"),__vite__mapDeps([0,1,2,3,4,5,6,7])).then(r=>({default:r.FieldPlacementEditor})));`,
  );
  if (body.includes('FieldPlacementEditor-D1Nz3L-a')) {
    throw new Error('known-good FPE lazy import was not retargeted');
  }
  if (!body.includes(`import("./${LIVE_FPE}")`)) {
    throw new Error('known-good FPE lazy import missing current DJN FieldPlacement chunk');
  }
  body = body.replaceAll('e.jsx(as,', 'e.jsx(sigScroll,');
  return body;
}

export function assertUntouchedHostGraph({ indexHtml, entryJs, cccJs, dtpJs }) {
  const errors = [];
  if (!String(indexHtml).includes('src="/assets/index-DJNHggvS.js"')) {
    errors.push('html_entry drifted');
  }
  if (sha256(indexHtml) !== PINNED_CURRENT_LIVE.index_html_sha256) {
    errors.push(`index.html drifted ${sha256(indexHtml)}`);
  }
  if (sha256(entryJs) !== PINNED_CURRENT_LIVE.djnh_sha256) {
    errors.push(`DJNHggvS drifted ${sha256(entryJs)}`);
  }
  if (sha256(cccJs) !== PINNED_CURRENT_LIVE.ccc_sha256) {
    errors.push(`CCC drifted ${sha256(cccJs)}`);
  }
  if (dtpJs && sha256(dtpJs) !== PINNED_CURRENT_LIVE.dtp_sha256) {
    errors.push(`DTP drifted ${sha256(dtpJs)}`);
  }
  if (errors.length) {
    throw new Error(`host graph drifted:\n${errors.join('\n')}`);
  }
}

export function assertLiveFilesBeforeTransplant(filesJs) {
  const text = String(filesJs);
  if (sha256(text) !== PINNED_CURRENT_LIVE.files_sha256) {
    throw new Error(`live Files drifted before transplant ${sha256(text)}`);
  }
  if (!text.includes('from"./SignatureRequests-ipdlcpz2.js"')) {
    throw new Error('live Files no longer imports the broken overlay; stop and re-read');
  }
  if (!text.includes('return s??[]}}),{data:checkClaim}=T(') || !text.includes('.select("id, claim_id")')) {
    throw new Error('live Files lost the two-hook claim_id lookup');
  }
}

export function assertInlineFilesOnlyWrites(writes) {
  const keys = Object.keys(writes);
  if (keys.length !== 1 || keys[0] !== 'assets/CheckFilesSection-0Fmhwbep.js') {
    throw new Error(`inline transplant may only write Files URL, got ${keys.join(',')}`);
  }
  return { filesKey: keys[0] };
}

export function assertTransplantedFiles(filesJs) {
  const text = String(filesJs);
  const errors = [];
  if (!text.includes(FILES_IMPORT)) errors.push('lost current Files DJN import letters');
  if (!text.includes('from"./index-DJNHggvS.js"')) errors.push('lost DJN import');
  if (!text.includes(`from"./${LIVE_COMPRESS}"`)) errors.push('lost current compress');
  if (!text.includes(`import"./${LIVE_CROPPER}"`)) errors.push('lost current cropper');
  if (!text.includes('return s??[]}}),{data:checkClaim}=T(')) errors.push('lost two-hook useQuery');
  if (!text.includes('.select("id, claim_id")')) errors.push('lost claim_id select');
  if (text.includes('claims:claim_id')) errors.push('regained claims embed');
  if (text.includes('from"./SignatureRequests-ipdlcpz2.js"')) errors.push('still imports broken overlay');
  if (!text.includes('function Ss(') || !text.includes('function js(')) errors.push('lost known-good Signature functions');
  if (!text.includes('Send for Signature') || !text.includes('Signature Requests') || !text.includes('Request Signature')) {
    errors.push('lost Signature copy');
  }
  if (!text.includes(`import("./${LIVE_FPE}")`)) errors.push('lost current FPE lazy import');
  if (!text.includes('linkedClaim&&linkedClaim.id&&e.jsx(sigReq')) errors.push('lost Signature mount');
  if (!text.includes('export{ee as CheckFilesSection}')) errors.push('lost current Files export');
  if (!text.includes('check-signature-claim')) errors.push('lost check-signature-claim');
  for (const needle of FORBIDDEN) {
    if (text.includes(needle)) errors.push(`forbidden remnant ${needle}`);
  }
  if (errors.length) {
    throw new Error(`transplanted Files invalid:\n${errors.join('\n')}`);
  }
}

export function transplantKnownGoodSignature({ liveFilesJs, knownGoodChseJs }) {
  assertLiveFilesBeforeTransplant(liveFilesJs);
  const body = extractKnownGoodSignatureBody(knownGoodChseJs);
  const live = String(liveFilesJs);
  const filesTail = live
    .replace(/^import\{[^}]+\}from"\.\/index-DJNHggvS\.js";/, '')
    .replace('import{SignatureRequests as sigReq}from"./SignatureRequests-ipdlcpz2.js";', '');
  if (filesTail.includes('SignatureRequests-ipdlcpz2') || filesTail.includes('sigReq}from')) {
    throw new Error('failed to drop the overlay SignatureRequests import');
  }
  if (!filesTail.includes(`from"./${LIVE_COMPRESS}"`) || !filesTail.includes(`import"./${LIVE_CROPPER}"`)) {
    throw new Error('Files tail lost current compress/cropper');
  }

  const next = [
    FILES_IMPORT + ';',
    SIG_EXTRA_IMPORT + ';',
    SIG_CHUNK_IMPORTS + ';',
    filesTail.replace(
      'const g="claim-files";',
      [
        'const g="claim-files";',
        MAP_DEPS,
        `const sigReq=(({Ye,ye,_e,w,V,d,$,e,R,Z,I,ke,Ze,Ie,Ne,Se,G,es,je,ss,Le,g,ts,Re,Te,as:sigScroll,is,le,ns,ze,rs,Fe,Ke,$e,Oe,ls,Y,se,te,ae,ie,Q,fe,Me,ne,os,oe,cs,pe,Ee,ds,Pe,ms,us,hs,xs,fs,ps,ws,re})=>{${INLINE_CE}${body}return Ss;})(${IIFE_BINDINGS});`,
      ].join(''),
    ),
  ].join('');

  assertTransplantedFiles(next);
  assertInlineFilesOnlyWrites({ 'assets/CheckFilesSection-0Fmhwbep.js': next });
  return {
    writes: {
      'assets/CheckFilesSection-0Fmhwbep.js': next,
    },
    report: {
      files_key: 'assets/CheckFilesSection-0Fmhwbep.js',
      files_sha256: sha256(next),
      files_before_sha256: PINNED_CURRENT_LIVE.files_sha256,
      ipdlcpz2_left_in_place: true,
      fpe: LIVE_FPE,
      host_untouched: [
        'index.html',
        'assets/index-DJNHggvS.js',
        'assets/CheckCommandCenter-M7p55m49.js',
        'assets/SharedCheckPaymentDirection-CxW2noA2.js',
        'assets/index-D9SwIqYu.css',
      ],
    },
  };
}

export const transplantSha256 = (buf) => createHash('sha256').update(buf).digest('hex');

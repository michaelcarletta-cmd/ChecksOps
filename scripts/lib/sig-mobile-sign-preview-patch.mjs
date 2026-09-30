/**
 * Narrow in-place overlay for the CURRENT live Sign-DfWZrlqT.js review iframe.
 * Mobile/narrow: width follows the container; height is derived (no 70vh+400 floor).
 * Desktop ≥768 keeps the live 70vh / minHeight 400px frame.
 * Does not touch submit/canvas payload, C9Qr, Files, or Lambda.
 */

export const LIVE_SIGN = 'Sign-DfWZrlqT.js';
export const LIVE_ENTRY = 'index-C9QrEEkl.js';
export const LIVE_FILES = 'CheckFilesSection-BJZPqPpX.js';
export const SIGN_KEY = `assets/${LIVE_SIGN}`;
export const FILES_KEY = `assets/${LIVE_FILES}`;

export const EXPECTED_SIGN_SHA256 =
  '99718609c1019b822ac9560271050cb3eb1463eb46ac6d0103bcbf3325c13a14';
export const EXPECTED_FILES_SHA256 =
  'df1b95f4a85d04901d2d707e2feae7f3c77e605744cc5ffe9011d2872a4fb969';
export const EXPECTED_ENTRY_SHA256 =
  '10c0aab80ddc918744c5acdad0e25ef75d957aaf5c0409707abf06f9e35864f9';
export const EXPECTED_HTML_SHA256 =
  '2a8e5245d18a4a84b6175cace303dff9c06b27e5114e4cc439fe9854b2e53575';
export const EXPECTED_LAMBDA_SHA = 'pxZj4G6pGntJrkcRO5uNNEbiyvDpCOKPiWAboDnPvBA=';

export const LIVE_IFRAME_STYLE = 'style:{height:"70vh",minHeight:"400px"}';
export const LIVE_PREVIEW_WRAP =
  'className:"border border-gray-200 rounded-lg overflow-hidden shadow-sm bg-white"';
export const PATCHED_PREVIEW_WRAP =
  'className:"border border-gray-200 rounded-lg overflow-auto shadow-sm bg-white"';
export const HELPER_FN =
  'function Me(n){return n?{width:"100%",maxWidth:"100%",height:"max(90dvh, 160vw)",minHeight:0,display:"block",border:0}:{height:"70vh",minHeight:"400px"}}';
export const NARROW_STATE =
  ',[Ae,Be]=c.useState(()=>{try{return window.matchMedia("(max-width: 767px)").matches}catch{return!1}})';
export const NARROW_EFFECT =
  'c.useEffect(()=>{const n=window.matchMedia("(max-width: 767px)"),t=()=>Be(n.matches);return t(),n.addEventListener("change",t),()=>n.removeEventListener("change",t)},[]);';
export const PATCHED_IFRAME_STYLE = 'style:Me(Ae)';

const TOKEN_EFFECT = 'c.useEffect(()=>{S?je():(P("No signing token provided"),_(!1))},[S]);';
const CONSENT_STATE = '[M,ye]=c.useState(!1)';

export function signPreviewFrameStyle(narrow) {
  if (!narrow) {
    return { height: '70vh', minHeight: '400px' };
  }
  return {
    width: '100%',
    maxWidth: '100%',
    height: 'max(90dvh, 160vw)',
    minHeight: 0,
    display: 'block',
    border: 0,
  };
}

export function resolveSignPreviewHeightPx(narrow, viewportWidthPx, viewportHeightPx) {
  if (!narrow) {
    return Math.max(viewportHeightPx * 0.7, 400);
  }
  return Math.max(viewportHeightPx * 0.9, viewportWidthPx * 1.6);
}

export function signPreviewInvariants(src) {
  return {
    imports_c9qr: src.includes('from"./index-C9QrEEkl.js"'),
    imports_templates: src.includes('from"./signer-display-templates-B5YRNMRm.js"'),
    imports_public_api: src.includes('from"./publicWorkflowApi-CSI3O7Ra.js"'),
    submit_signature: src.includes('"submit-signature"'),
    to_data_url: src.includes('l.toDataURL()'),
    canvas_400_150: src.includes('width:400,height:150'),
    no_react_pdf: !/react-pdf|Document,|Page,/.test(src) && !src.includes('pageWidth'),
    no_letter_assumption: !src.includes('612') && !src.includes('792'),
    helper: src.includes(HELPER_FN),
    narrow_mq: src.includes('(max-width: 767px)'),
    desktop_70vh_400: src.includes('{height:"70vh",minHeight:"400px"}'),
    mobile_derived_height: src.includes('max(90dvh, 160vw)'),
    no_live_iframe_style: !src.includes(LIVE_IFRAME_STYLE),
    patched_iframe_style: src.includes(PATCHED_IFRAME_STYLE),
    overflow_auto: src.includes(PATCHED_PREVIEW_WRAP),
    no_overflow_hidden_preview: !src.includes(LIVE_PREVIEW_WRAP),
  };
}

export function patchSignMobilePreview(src) {
  if (!src.includes('from"./index-C9QrEEkl.js"')) {
    throw new Error('Sign lost C9Qr import — target moved');
  }
  if (!src.includes(LIVE_IFRAME_STYLE)) {
    throw new Error('live Sign iframe style not found — target moved');
  }
  if (!src.includes(LIVE_PREVIEW_WRAP)) {
    throw new Error('live Sign preview wrapper not found — target moved');
  }
  if (!src.includes(CONSENT_STATE)) {
    throw new Error('live Sign consent state not found — target moved');
  }
  if (!src.includes(TOKEN_EFFECT)) {
    throw new Error('live Sign token effect not found — target moved');
  }
  if (!src.includes('function $e(){')) {
    throw new Error('live Sign component not found — target moved');
  }
  if (src.includes('react-pdf') || src.includes('pageWidth')) {
    throw new Error('refusing to patch a Sign chunk that already has a PDF renderer');
  }

  let next = src;
  next = next.replace('function $e(){', `${HELPER_FN}function $e(){`);
  next = next.replace(CONSENT_STATE, `${CONSENT_STATE}${NARROW_STATE}`);
  next = next.replace(TOKEN_EFFECT, `${TOKEN_EFFECT}${NARROW_EFFECT}`);
  next = next.replace(LIVE_IFRAME_STYLE, PATCHED_IFRAME_STYLE);
  next = next.replace(LIVE_PREVIEW_WRAP, PATCHED_PREVIEW_WRAP);

  const inv = signPreviewInvariants(next);
  const failed = Object.entries(inv).filter(([, ok]) => !ok).map(([key]) => key);
  if (failed.length) {
    throw new Error(`patched Sign failed invariants: ${failed.join(',')}`);
  }
  return next;
}

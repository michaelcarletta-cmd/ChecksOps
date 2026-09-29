/**
 * Current live production SPA after the single-entry Signature repair.
 * Further Signature work must start from these pins. Do not restore the
 * pre-repair DJN/CCC/Files graph and do not mint a second application entry.
 */
import { createHash } from 'node:crypto';

export const REFUSE_OLDER_SPA =
  'Refusing to restore or deploy an older SPA. Current live production (single React entry /assets/index-DJNHggvS.js → CheckCommandCenter-M7p55m49.js → CheckFilesSection-0Fmhwbep.js) is the baseline. Use scripts/build-live-sig-requests-overlay.mjs. Production deploy is disabled.';

export const REFUSE_PROD_DEPLOY =
  'Production deploy is disabled for this Signature restore. Build locally against current live only.';

export const CANONICAL_ENTRY = '/assets/index-DJNHggvS.js';
export const LIVE_CCC = '/assets/CheckCommandCenter-M7p55m49.js';
export const LIVE_FILES = '/assets/CheckFilesSection-0Fmhwbep.js';
export const LIVE_DTP = '/assets/SharedCheckPaymentDirection-CxW2noA2.js';
export const LIVE_CSS = '/assets/index-D9SwIqYu.css';
export const LIVE_SIG = '/assets/SignatureRequests-ipdlcpz2.js';
export const LIVE_SIG_CSS = '/assets/SignatureRequests-fsarOgFO.css';
export const LEFT_IN_PLACE_ENTRY = '/assets/index-QKetcACR.js';

export const PINNED_CURRENT_LIVE = Object.freeze({
  index_html_sha256: '79f7aa0df9f071b73c49a8b17e4cb1041ecd375fda0ddbcbbb31bbae146469f2',
  html_entry: CANONICAL_ENTRY,
  index_version: 'WST9r3YRkhA2nmsL6fVoNmmsy6S5GUeH',
  djnh_sha256: '40a7ad700091a26d328f90f695004e4c086143d1e6ae8e2aba35d8cc9c006380',
  qketcacr_sha256: '40a7ad700091a26d328f90f695004e4c086143d1e6ae8e2aba35d8cc9c006380',
  ccc_sha256: '33ba79e66e3d6e0ca7d00f90479a626a62785c2c63c4fdb1708bd706b2f1fe95',
  files_sha256: '85363ebdac367c620e4058cb2e19501f6b6cd70d987b88d8bfb0dff73876e4c5',
  dtp_sha256: '04cd3d058b482568f86eec308183d5007a25f2fd818bad1b7f59976cf35c87d3',
  sig_sha256: '8a9765729cf6902b33a2bcb007b05e93e9ee90b2301c2ce65e6f2be85c441a9f',
});

/** Pre-repair production. Restoring this graph is forbidden. */
export const RETIRED_OLDER_SPA = Object.freeze({
  html_entry: '/assets/index-QKetcACR.js',
  djnh_sha256: 'f7d5696b275fe6d2dbd1227c8e054c67a5ae5f3696708d685d6de9a583c18f94',
  files: '/assets/CheckFilesSection-DC3uOrqc.js',
  ccc: '/assets/CheckCommandCenter-B-yV-W5w.js',
});

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

export const viteHash = (buf) => {
  const b64 = createHash('sha256').update(buf).digest('base64url').replace(/[^A-Za-z0-9_-]/g, '');
  return b64.slice(0, 8);
};

export function parseHtmlEntry(html) {
  return (String(html).match(/src="(\/assets\/index-[^"]+\.js)"/) || [])[1] || null;
}

export function assertCurrentLiveGraph({
  indexHtml,
  entryJs,
  cccJs,
  filesJs,
  dtpJs,
}) {
  const errors = [];
  if (parseHtmlEntry(indexHtml) !== CANONICAL_ENTRY) {
    errors.push(`html_entry ${parseHtmlEntry(indexHtml)} != ${CANONICAL_ENTRY}`);
  }
  if (sha256(indexHtml) !== PINNED_CURRENT_LIVE.index_html_sha256) {
    errors.push(`index.html drifted ${sha256(indexHtml)}`);
  }
  if (sha256(entryJs) !== PINNED_CURRENT_LIVE.djnh_sha256) {
    errors.push(`DJNHggvS drifted ${sha256(entryJs)}`);
  }
  if (!String(entryJs).includes('CheckCommandCenter-M7p55m49.js')) {
    errors.push('canonical entry lost CheckCommandCenter-M7p55m49.js');
  }
  if (String(entryJs).includes('CheckCommandCenter-B-yV-W5w.js')) {
    errors.push('canonical entry points at retired CCC');
  }
  if (sha256(cccJs) !== PINNED_CURRENT_LIVE.ccc_sha256) {
    errors.push(`CCC drifted ${sha256(cccJs)}`);
  }
  if (!String(cccJs).includes('CheckFilesSection-0Fmhwbep.js')) {
    errors.push('CCC lost current Files chunk');
  }
  if (String(cccJs).includes('CheckFilesSection-DC3uOrqc.js')) {
    errors.push('CCC still references retired Files chunk');
  }
  if (sha256(filesJs) !== PINNED_CURRENT_LIVE.files_sha256) {
    errors.push(`Files drifted ${sha256(filesJs)}`);
  }
  if (!String(filesJs).includes('from"./index-DJNHggvS.js"')) {
    errors.push('Files chunk does not import canonical entry');
  }
  if (!String(filesJs).includes('from"./SignatureRequests-ipdlcpz2.js"')) {
    errors.push('Files chunk lost current SignatureRequests import');
  }
  if (!String(filesJs).includes('.select("id, claim_id")')) {
    errors.push('Files chunk lost id, claim_id select');
  }
  if (String(filesJs).includes('claims:claim_id')) {
    errors.push('Files chunk regained claims embed');
  }
  if (!String(filesJs).includes('return s??[]}}),{data:checkClaim}=T(')) {
    errors.push('Files chunk lost the two-hook useQuery split');
  }
  if (dtpJs && sha256(dtpJs) !== PINNED_CURRENT_LIVE.dtp_sha256) {
    errors.push(`DTP drifted ${sha256(dtpJs)}`);
  }
  if (errors.length) {
    throw new Error(`current live baseline drift:\n${errors.join('\n')}`);
  }
}

export function rewriteFilesSignatureImport(filesJs, nextSigFileName) {
  const currentImport = 'from"./SignatureRequests-ipdlcpz2.js"';
  const nextImport = `from"./${nextSigFileName}"`;
  const next = nextSigFileName === 'SignatureRequests-ipdlcpz2.js'
    ? String(filesJs)
    : String(filesJs).replaceAll(currentImport, nextImport);
  if (!next.includes(nextImport)) {
    throw new Error('failed to retarget Files SignatureRequests import');
  }
  if (nextSigFileName !== 'SignatureRequests-ipdlcpz2.js' && next.includes(currentImport)) {
    throw new Error('Files chunk still imports the previous SignatureRequests URL');
  }
  if (!next.includes('from"./index-DJNHggvS.js"')) {
    throw new Error('Files rewrite lost canonical entry import');
  }
  if (!next.includes('.select("id, claim_id")') || next.includes('claims:claim_id')) {
    throw new Error('Files rewrite lost the claim_id-only lookup');
  }
  if (!next.includes('return s??[]}}),{data:checkClaim}=T(')) {
    throw new Error('Files rewrite collapsed the two useQuery calls');
  }
  if (!next.includes('linkedClaim&&linkedClaim.id&&e.jsx(sigReq')) {
    throw new Error('Files rewrite lost SignatureRequests mount');
  }
  return next;
}

export function assertSingleEntryWrites(writes) {
  const keys = Object.keys(writes).sort();
  if (keys.some((key) => /^assets\/index-/.test(key) || key === 'index.html')) {
    throw new Error(`single-entry repair must stay pinned; unexpected write ${keys.join(',')}`);
  }
  if (keys.some((key) => /CheckCommandCenter-/.test(key))) {
    throw new Error('CCC must remain CheckCommandCenter-M7p55m49.js');
  }
  if (!keys.includes('assets/CheckFilesSection-0Fmhwbep.js')) {
    throw new Error('Files overlay must keep the live CheckFilesSection-0Fmhwbep.js URL');
  }
  const sigKeys = keys.filter((key) => /assets\/SignatureRequests-[A-Za-z0-9_-]+\.js$/.test(key));
  if (sigKeys.length !== 1) {
    throw new Error(`expected one new SignatureRequests JS asset, got ${sigKeys.join(',')}`);
  }
  return { filesKey: 'assets/CheckFilesSection-0Fmhwbep.js', sigKey: sigKeys[0], keys };
}

/**
 * Narrow single-entry Signature overlay repair.
 * Does not call AWS. Used by the promote script and unit tests.
 */
import { createHash } from 'node:crypto';

export const CANONICAL_ENTRY = '/assets/index-DJNHggvS.js';
export const OVERLAY_ENTRY = '/assets/index-QKetcACR.js';
export const OVERLAY_CCC = '/assets/CheckCommandCenter-M7p55m49.js';
export const OVERLAY_FILES = '/assets/CheckFilesSection-0Fmhwbep.js';
export const LIVE_DTP = '/assets/SharedCheckPaymentDirection-CxW2noA2.js';
export const LIVE_CSS = '/assets/index-D9SwIqYu.css';
export const SIG_CSS = '/assets/SignatureRequests-fsarOgFO.css';
export const SIG_CHUNK = '/assets/SignatureRequests-ipdlcpz2.js';

export const PINNED_LIVE = Object.freeze({
  index_html_sha256: '3b25fff5ae99228cdd92c8e5c93c46997fa2506cdfcf9fb0311476cef42cccad',
  html_entry: OVERLAY_ENTRY,
  qketcacr_sha256: '40a7ad700091a26d328f90f695004e4c086143d1e6ae8e2aba35d8cc9c006380',
  djnh_sha256: 'f7d5696b275fe6d2dbd1227c8e054c67a5ae5f3696708d685d6de9a583c18f94',
  ccc_sha256: '33ba79e66e3d6e0ca7d00f90479a626a62785c2c63c4fdb1708bd706b2f1fe95',
  files_sha256: 'd059a1c1b7a93755948dda46518f144d52f2a6c1f0b60052efce3a1a2633442b',
  dtp_sha256: '04cd3d058b482568f86eec308183d5007a25f2fd818bad1b7f59976cf35c87d3',
  index_version: 'YDUf2fnEspF3JHYHCuAftmE9GdaIVvUK',
});

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

export function parseHtmlEntry(html) {
  return (String(html).match(/src="(\/assets\/index-[^"]+\.js)"/) || [])[1] || null;
}

export function rewriteHtmlToCanonicalEntry(html) {
  const next = String(html).replaceAll(OVERLAY_ENTRY, CANONICAL_ENTRY);
  if (parseHtmlEntry(next) !== CANONICAL_ENTRY) {
    throw new Error('index.html rewrite did not restore canonical DJNHggvS entry');
  }
  if (next.includes(OVERLAY_ENTRY)) {
    throw new Error('index.html still references QKetcACR as an asset');
  }
  if (!next.includes(LIVE_CSS) || !next.includes(SIG_CSS)) {
    throw new Error('index.html lost production CSS');
  }
  return next;
}

export function assertOverlayEntryContent(entryJs) {
  const text = String(entryJs);
  if (!text.includes('CheckCommandCenter-M7p55m49.js')) {
    throw new Error('overlay entry is missing CheckCommandCenter-M7p55m49.js');
  }
  if (text.includes('CheckCommandCenter-B-yV-W5w.js')) {
    throw new Error('overlay entry still points at pre-overlay CCC');
  }
  if (!text.includes('createRoot') || !text.includes('getElementById("root")')) {
    throw new Error('overlay entry is not a full application entry');
  }
}

export function repairFilesOverlayUseQuery(filesJs) {
  let next = String(filesJs);
  if (!next.includes('sigReq') || !next.includes('check-signature-claim')) {
    throw new Error('live Files overlay is missing Signature mount/query');
  }

  const broken = 'return s??[]}},{data:checkClaim}=T({queryKey:["check-signature-claim",l],queryFn:async()=>{const{data:s2,error:t2}=await o.from("check_intake_items").select("id, claim_id, claims:claim_id(id, claim_number, policyholder_name, policyholder_email)").eq("id",l).maybeSingle();if(t2)throw t2;return s2}}),nestedClaim=checkClaim&&checkClaim.claims||null,resolvedClaimId=nestedClaim&&nestedClaim.id||checkClaim&&checkClaim.claim_id||null,linkedClaim=nestedClaim||(resolvedClaimId?{id:resolvedClaimId,claim_number:null,policyholder_name:null,policyholder_email:null}:null),S=async s=>{';
  const fixed = 'return s??[]}}),{data:checkClaim}=T({queryKey:["check-signature-claim",l],queryFn:async()=>{const{data:s2,error:t2}=await o.from("check_intake_items").select("id, claim_id").eq("id",l).maybeSingle();if(t2)throw t2;return s2}}),resolvedClaimId=checkClaim&&checkClaim.claim_id||null,linkedClaim=resolvedClaimId?{id:resolvedClaimId,claim_number:null,policyholder_name:null,policyholder_email:null}:null,S=async s=>{';
  if (!next.includes(broken)) {
    throw new Error('Files overlay useQuery splice point missing or already drifted');
  }
  next = next.replace(broken, fixed);

  const filesCall = next.match(/\{data:h=\[\],isLoading:D\}=T\(/);
  const claimCall = next.match(/\{data:checkClaim\}=T\(/);
  if (!filesCall || !claimCall) {
    throw new Error('repaired Files overlay is missing two useQuery calls');
  }
  if (next.includes('T({queryKey:["check-files"') && next.includes('},{data:checkClaim}=T(')) {
    throw new Error('repaired Files overlay still passes claim query as second useQuery argument');
  }
  if (next.includes('claims:claim_id')) {
    throw new Error('repaired Files overlay still embeds claims');
  }
  if (!next.includes('.select("id, claim_id")')) {
    throw new Error('repaired Files overlay missing id, claim_id select');
  }
  if (!next.includes('linkedClaim&&linkedClaim.id&&e.jsx(sigReq')) {
    throw new Error('repaired Files overlay lost SignatureRequests mount');
  }
  if (!next.includes(SIG_CHUNK.replace('/assets/', ''))) {
    throw new Error('repaired Files overlay lost SignatureRequests import');
  }
  return next;
}

export function comparePinnedLive(live) {
  const errors = [];
  const checks = [
    ['html_entry', live.html_entry, PINNED_LIVE.html_entry],
    ['index_html_sha256', live.index_html_sha256, PINNED_LIVE.index_html_sha256],
    ['qketcacr_sha256', live.qketcacr_sha256, PINNED_LIVE.qketcacr_sha256],
    ['djnh_sha256', live.djnh_sha256, PINNED_LIVE.djnh_sha256],
    ['ccc_sha256', live.ccc_sha256, PINNED_LIVE.ccc_sha256],
    ['files_sha256', live.files_sha256, PINNED_LIVE.files_sha256],
    ['dtp_sha256', live.dtp_sha256, PINNED_LIVE.dtp_sha256],
  ];
  if (live.index_version && live.index_version !== PINNED_LIVE.index_version) {
    errors.push(`index.html version drifted ${live.index_version} != ${PINNED_LIVE.index_version}`);
  }
  for (const [name, actual, expected] of checks) {
    if (actual !== expected) errors.push(`${name} drifted ${actual} != ${expected}`);
  }
  return errors;
}

export function buildSingleEntryRepair({
  indexHtml,
  qketcacrJs,
  filesJs,
}) {
  assertOverlayEntryContent(qketcacrJs);
  const repairedFiles = repairFilesOverlayUseQuery(filesJs);
  const repairedHtml = rewriteHtmlToCanonicalEntry(indexHtml);
  return {
    writes: {
      'assets/index-DJNHggvS.js': Buffer.from(qketcacrJs),
      'assets/CheckFilesSection-0Fmhwbep.js': Buffer.from(repairedFiles),
      'index.html': Buffer.from(repairedHtml),
    },
    report: {
      html_entry: parseHtmlEntry(repairedHtml),
      index_html_sha256: sha256(repairedHtml),
      djnh_sha256: sha256(qketcacrJs),
      files_sha256: sha256(repairedFiles),
      ccc_untouched: OVERLAY_CCC,
      dtp_untouched: LIVE_DTP,
      qketcacr_left_in_place: OVERLAY_ENTRY,
      uploaded_keys_only: [
        'assets/CheckFilesSection-0Fmhwbep.js',
        'assets/index-DJNHggvS.js',
        'index.html',
      ],
    },
  };
}

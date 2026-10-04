/**
 * Forward-compose the staging Homeowner ledger-view diagnostic onto a
 * freshly downloaded live SPA. Never rebuilds from a stale workspace Vite
 * baseline. Mint new hashed HomeownerLedger + index entry names so immutable
 * CloudFront assets are not overwritten in place.
 */
import { createHash } from 'node:crypto';

export const STALE_SPA_ENTRY_MARKERS = Object.freeze(['DJNHggvS', 'B4Tts4y1', 'Da1p11Te']);

export const FORBIDDEN_DIAGNOSTIC_LEAKS = Object.freeze([
  '/h/ledger/',
  'Authorization',
  'tenant_id',
  'claim_id',
  'homeowner_email',
  'homeowner_name',
  'stack',
  'request body',
]);

const REQUIRED_LIVE_MARKERS = Object.freeze([
  'homeowner-ledger-view',
  'Could not load ledger',
  "This link isn't working",
  'Ask your claim team to resend your ledger link.',
]);

export const INLINED_DIAGNOSTIC_HELPER = [
  'function __hoFormatLedgerViewDiag(e){',
  'var codes={invalid_token:400,not_found:404,revoked:410,expired:410,ledger_view_failed:503};',
  'var statusToCode={400:"invalid_token",404:"not_found",503:"ledger_view_failed"};',
  'var host=typeof location!=="undefined"?String(location.hostname||"").toLowerCase():"";',
  'if(host!=="staging.checksops.com"&&!(host.indexOf("staging.")===0&&host.slice(-13)===".checksops.com"))return null;',
  'if(host==="checksops.com"||host==="www.checksops.com"||host==="app.checksops.com")return null;',
  'var obj=e&&typeof e==="object"?e:null;',
  'var ctx=obj&&obj.context&&typeof obj.context==="object"?obj.context:null;',
  'var body=ctx&&ctx.body&&typeof ctx.body==="object"?ctx.body:null;',
  'var code=null;',
  'var raw=body&&typeof body.error==="string"?body.error:"";',
  'if(Object.prototype.hasOwnProperty.call(codes,raw))code=raw;',
  'if(!code&&obj&&typeof obj.message==="string"&&Object.prototype.hasOwnProperty.call(codes,obj.message))code=obj.message;',
  'if(!code&&typeof e==="string"&&Object.prototype.hasOwnProperty.call(codes,e))code=e;',
  'var status=ctx&&(ctx.status===400||ctx.status===404||ctx.status===410||ctx.status===503)?ctx.status:0;',
  'if(code&&!status)status=codes[code];',
  'if(status&&!code)code=statusToCode[status]||null;',
  'if(!code||!status)return null;',
  'return"Diagnostic: "+status+" — "+code;',
  '}',
].join('');

export function viteContentHash(content) {
  return createHash('sha256').update(String(content || ''), 'utf8').digest('base64url').replace(/[^A-Za-z0-9]/g, '').slice(0, 8);
}

export function entryFromHtml(html) {
  const match = String(html || '').match(/\/assets\/index-[^"'\\\s]+\.js/);
  return match ? match[0] : null;
}

export function homeownerChunkFromEntry(entryJs) {
  const match = String(entryJs || '').match(/HomeownerLedger-[A-Za-z0-9]+\.js/);
  return match ? match[0] : null;
}

function assertNoStaleEntry(name, label) {
  const value = String(name || '');
  for (const marker of STALE_SPA_ENTRY_MARKERS) {
    if (value.includes(marker)) {
      throw new Error(`stale SPA ${label} marker ${marker} is forbidden`);
    }
  }
}

function assertLiveHomeownerChunk(js) {
  const text = String(js || '');
  for (const marker of REQUIRED_LIVE_MARKERS) {
    if (!text.includes(marker)) {
      throw new Error(`live HomeownerLedger chunk is missing required marker: ${marker}`);
    }
  }
  if (!text.includes('}catch(') || !text.includes('Could not load ledger')) {
    throw new Error('live HomeownerLedger chunk is missing the ledger-view catch');
  }
}

function patchHomeownerLedgerJs(liveJs) {
  assertLiveHomeownerChunk(liveJs);
  let next = String(liveJs);
  if (!next.startsWith(INLINED_DIAGNOSTIC_HELPER)) {
    next = `${INLINED_DIAGNOSTIC_HELPER}\n${next}`;
  }

  const catchRe = /\}catch\(([A-Za-z_$][\w$]*)\)\{([A-Za-z_$][\w$]*)\(\1\.message\|\|"Could not load ledger"\)\}/;
  if (!catchRe.test(next)) {
    throw new Error('live HomeownerLedger catch shape changed; refusing to guess a patch');
  }
  next = next.replace(
    catchRe,
    '}catch($1){$2($1.message||"Could not load ledger");globalThis.__hoLedgerViewErr=$1}',
  );

  const resetRe = /([A-Za-z_$][\w$]*)\(!0\),([A-Za-z_$][\w$]*)\(null\);try\{const\{data:/;
  if (resetRe.test(next) && !next.includes('globalThis.__hoLedgerViewErr=null;try{const{data:')) {
    next = next.replace(resetRe, '$1(!0),$2(null);globalThis.__hoLedgerViewErr=null;try{const{data:');
  }

  const copy = 'Ask your claim team to resend your ledger link.';
  if (!next.includes(copy)) {
    throw new Error('live HomeownerLedger generic error copy is missing');
  }
  const jsxMatch = next.match(/([A-Za-z_$][\w$]*)\.jsx\("p",\{className:"text-sm text-muted-foreground",children:[^;]*Ask your claim team to resend your ledger link\."\}\)/);
  if (jsxMatch && !next.includes('data-testid":"homeowner-ledger-view-diagnostic"')) {
    const jsxId = jsxMatch[1];
    const sibling = `,(function(){var d=__hoFormatLedgerViewDiag(globalThis.__hoLedgerViewErr);return d?${jsxId}.jsx("p",{className:"text-xs text-muted-foreground font-mono","data-testid":"homeowner-ledger-view-diagnostic",children:d}):null})()`;
    next = next.replace(jsxMatch[0], `${jsxMatch[0]}${sibling}`);
  } else if (!next.includes('__hoFormatLedgerViewDiag(globalThis.__hoLedgerViewErr)')) {
    const diagnosticAppend = `${copy}"+(function(){var d=__hoFormatLedgerViewDiag(globalThis.__hoLedgerViewErr);return d?"\\n\\n"+d:""})()+"`;
    next = next.replace(copy, diagnosticAppend);
  }

  for (const leak of FORBIDDEN_DIAGNOSTIC_LEAKS) {
    if (INLINED_DIAGNOSTIC_HELPER.includes(leak)) {
      throw new Error(`diagnostic helper leaked forbidden field ${leak}`);
    }
  }
  return next;
}

function rewriteAssetName(originalName, nextHash, fallbackPrefix) {
  const match = String(originalName || '').match(/^([A-Za-z0-9]+)-[A-Za-z0-9]+\.js$/);
  const prefix = match ? match[1] : fallbackPrefix;
  return `${prefix}-${nextHash}.js`;
}

export function composeHomeownerLedgerDiagnostic({
  indexHtml,
  entryJs,
  homeownerLedgerJs,
  homeownerLedgerFileName,
  entryFileName,
} = {}) {
  const liveEntry = entryFromHtml(indexHtml);
  if (!liveEntry) throw new Error('live index.html is missing /assets/index-*.js');
  assertNoStaleEntry(liveEntry, 'index entry');

  const liveHomeownerName = homeownerLedgerFileName || homeownerChunkFromEntry(entryJs);
  if (!liveHomeownerName) throw new Error('live index entry is missing HomeownerLedger-*.js');
  assertNoStaleEntry(liveHomeownerName, 'HomeownerLedger');

  const patchedHomeowner = patchHomeownerLedgerJs(homeownerLedgerJs);
  let homeownerHash = viteContentHash(patchedHomeowner);
  let nextHomeownerName = rewriteAssetName(liveHomeownerName, homeownerHash, 'HomeownerLedger');
  if (nextHomeownerName === liveHomeownerName) {
    homeownerHash = `${homeownerHash}X`;
    nextHomeownerName = rewriteAssetName(liveHomeownerName, homeownerHash, 'HomeownerLedger');
  }

  let nextEntry = String(entryJs || '').split(liveHomeownerName).join(nextHomeownerName);
  if (nextEntry === entryJs) {
    throw new Error('live index entry did not reference the live HomeownerLedger chunk');
  }
  if (!nextEntry.includes('/h/ledger/') && String(entryJs).includes('/h/ledger/')) {
    throw new Error('compose dropped /h/ledger/:token from the live index entry');
  }
  if (String(entryJs).includes('/ledger/') && !nextEntry.includes('/ledger/')) {
    throw new Error('compose dropped /ledger/:token from the live index entry');
  }

  let entryHash = viteContentHash(nextEntry);
  const liveEntryName = entryFileName || liveEntry.replace(/^\/assets\//, '');
  let nextEntryName = rewriteAssetName(liveEntryName, entryHash, 'index');
  if (nextEntryName === liveEntryName) {
    entryHash = `${entryHash}X`;
    nextEntryName = rewriteAssetName(liveEntryName, entryHash, 'index');
  }
  assertNoStaleEntry(nextEntryName, 'composed index entry');
  assertNoStaleEntry(nextHomeownerName, 'composed HomeownerLedger');

  let nextHtml = String(indexHtml || '').split(liveEntryName).join(nextEntryName);
  if (nextHtml.includes(liveHomeownerName)) {
    nextHtml = nextHtml.split(liveHomeownerName).join(nextHomeownerName);
  }
  if (nextHtml === indexHtml) {
    throw new Error('compose did not retarget index.html to the new entry bundle');
  }
  if (entryFromHtml(nextHtml) !== `/assets/${nextEntryName}`) {
    throw new Error('composed index.html entry bundle is not the minted index hash');
  }

  return {
    origin: 'fresh-live-download',
    clean_build: true,
    live_entry: liveEntry,
    live_homeowner: liveHomeownerName,
    homeowner_file_name: nextHomeownerName,
    entry_file_name: nextEntryName,
    index_html: nextHtml,
    entry_js: nextEntry,
    homeowner_ledger_js: patchedHomeowner,
    preserved_routes: {
      h_ledger: String(entryJs).includes('/h/ledger/'),
      ledger: String(entryJs).includes('/ledger/'),
    },
  };
}

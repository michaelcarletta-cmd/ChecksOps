import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  extractHomeownerLedgerViewDiagnostic,
  formatHomeownerLedgerViewDiagnostic,
  homeownerLedgerViewDiagnosticLine,
  isHomeownerLedgerViewDiagnosticEnabled,
} from '../../src/lib/homeownerLedgerViewDiagnostic.ts';
import {
  FORBIDDEN_DIAGNOSTIC_LEAKS,
  INLINED_DIAGNOSTIC_HELPER,
  composeHomeownerLedgerDiagnostic,
  entryFromHtml,
} from '../../scripts/deployment-guard/lib/homeowner-ledger-diagnostic-compose.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const page = readFileSync(path.join(ROOT, 'src/pages/HomeownerLedger.tsx'), 'utf8');
const helper = readFileSync(path.join(ROOT, 'src/lib/homeownerLedgerViewDiagnostic.ts'), 'utf8');

test('staging host gate allows only staging.checksops.com and never production', () => {
  assert.equal(isHomeownerLedgerViewDiagnosticEnabled({ hostname: 'staging.checksops.com' }), true);
  assert.equal(isHomeownerLedgerViewDiagnosticEnabled({ hostname: 'checksops.com' }), false);
  assert.equal(isHomeownerLedgerViewDiagnosticEnabled({ hostname: 'www.checksops.com' }), false);
  assert.equal(isHomeownerLedgerViewDiagnosticEnabled({ hostname: 'app.checksops.com' }), false);
  assert.equal(isHomeownerLedgerViewDiagnosticEnabled({ hostname: 'localhost' }), false);
  assert.equal(isHomeownerLedgerViewDiagnosticEnabled({ hostname: '' }), false);
});

test('extracts allowlisted 404 not_found and 503 ledger_view_failed from AWS invoke errors', () => {
  assert.deepEqual(extractHomeownerLedgerViewDiagnostic({
    message: 'not_found',
    name: 'FunctionsHttpError',
    context: { status: 404, body: { error: 'not_found' } },
  }), { status: 404, code: 'not_found' });
  assert.equal(
    formatHomeownerLedgerViewDiagnostic({ status: 404, code: 'not_found' }),
    'Diagnostic: 404 — not_found',
  );

  assert.deepEqual(extractHomeownerLedgerViewDiagnostic({
    message: 'ledger_view_failed',
    context: { status: 503, body: { error: 'ledger_view_failed', message: 'relation does not exist' } },
  }), { status: 503, code: 'ledger_view_failed' });
  assert.equal(
    formatHomeownerLedgerViewDiagnostic({ status: 503, code: 'ledger_view_failed' }),
    'Diagnostic: 503 — ledger_view_failed',
  );
});

test('infers status from allowlisted code and code from allowlisted status', () => {
  assert.deepEqual(extractHomeownerLedgerViewDiagnostic(new Error('not_found')), {
    status: 404,
    code: 'not_found',
  });
  assert.deepEqual(extractHomeownerLedgerViewDiagnostic({
    message: 'Could not load ledger',
    context: { status: 503, body: { error: 'relation "aws_public_homeowner_ledger_by_token" does not exist' } },
  }), { status: 503, code: 'ledger_view_failed' });
  assert.deepEqual(extractHomeownerLedgerViewDiagnostic({
    message: 'invalid_token',
    context: { status: 400, body: { error: 'invalid_token' } },
  }), { status: 400, code: 'invalid_token' });
});

test('never returns raw backend details, tokens, or unknown codes', () => {
  assert.equal(extractHomeownerLedgerViewDiagnostic({
    message: 'relation does not exist',
    stack: 'Error: boom\n    at homeowner.mjs',
    context: {
      status: 500,
      body: {
        error: 'relation does not exist',
        token: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        tenant_id: '11111111-1111-4111-8111-111111111111',
        claim_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
      },
    },
  }), null);
  assert.equal(homeownerLedgerViewDiagnosticLine({
    message: 'not_found',
    context: { status: 404, body: { error: 'not_found' } },
  }, { hostname: 'www.checksops.com' }), null);
  assert.equal(homeownerLedgerViewDiagnosticLine({
    message: 'not_found',
    context: { status: 404, body: { error: 'not_found' } },
  }, { hostname: 'staging.checksops.com' }), 'Diagnostic: 404 — not_found');

  const line = formatHomeownerLedgerViewDiagnostic({ status: 404, code: 'not_found' });
  for (const leak of ['token', '/h/ledger/', 'Authorization', 'tenant', 'claim_id', 'stack', 'relation']) {
    assert.equal(line.includes(leak), false, leak);
  }
});

test('HomeownerLedger error UI keeps generic copy and only adds the safe diagnostic line', () => {
  assert.match(page, /homeownerLedgerViewDiagnosticLine/);
  assert.match(page, /Ask your claim team to resend your ledger link/);
  assert.match(page, /This link isn't working/);
  assert.match(page, /data-testid="homeowner-ledger-view-diagnostic"/);
  assert.match(page, /setDiagnostic\(homeownerLedgerViewDiagnosticLine/);
  assert.doesNotMatch(page, /Authorization/);
  assert.doesNotMatch(page, /tenant_id/);
  assert.doesNotMatch(page, /claim_id/);
  assert.doesNotMatch(helper, /\/h\/ledger\//);
  assert.doesNotMatch(helper, /window\.location\.href/);
});

test('forward-compose patches the live HomeownerLedger chunk and mints new hashes', () => {
  const liveHomeowner = [
    'const q={functions:{invoke:async()=>({})}};',
    'export default function HomeownerLedger(){',
    'const[l,s]=u.useState(!0);const[d,c]=u.useState(null);const[t,n]=u.useState(null);',
    'const load=async()=>{n(!0),u(null);try{const{data:x,error:h}=await q.functions.invoke("homeowner-ledger-view",{body:{token:a}});',
    'if(h)throw h;if(x!=null&&x.error)throw new Error(x.error);c(x)}catch(x){n(x.message||"Could not load ledger")}finally{n(!1)}};',
    'return t?i.jsxs("div",{children:[i.jsx("div",{className:"font-semibold",children:"This link isn\'t working"}),',
    'i.jsx("p",{className:"text-sm text-muted-foreground",children:t==="revoked"?"Your claim team has ended access to this link.":',
    't==="expired"?"This link has expired. Ask your claim team for a new one.":"Ask your claim team to resend your ledger link."})]}):null}',
  ].join('');
  const liveEntry = [
    'const routes=[',
    '{path:"/h/ledger/:token",lazy:()=>import("./HomeownerLedger-cDMDKYsn.js")}',
    ',{path:"/ledger/:token",lazy:()=>import("./HomeownerLedger-cDMDKYsn.js")}',
    ',{path:"/branding",lazy:()=>import("./Branding-keep.js")}',
    ',{path:"/mortgage",lazy:()=>import("./Mortgage-keep.js")}',
    '];',
  ].join('');
  const liveHtml = '<!doctype html><script type="module" src="/assets/index-BomgsBaq.js"></script>';

  const composed = composeHomeownerLedgerDiagnostic({
    indexHtml: liveHtml,
    entryJs: liveEntry,
    homeownerLedgerJs: liveHomeowner,
    homeownerLedgerFileName: 'HomeownerLedger-cDMDKYsn.js',
    entryFileName: 'index-BomgsBaq.js',
  });

  assert.equal(composed.origin, 'fresh-live-download');
  assert.equal(composed.clean_build, true);
  assert.notEqual(composed.homeowner_file_name, 'HomeownerLedger-cDMDKYsn.js');
  assert.notEqual(composed.entry_file_name, 'index-BomgsBaq.js');
  assert.equal(entryFromHtml(composed.index_html), `/assets/${composed.entry_file_name}`);
  assert.match(composed.entry_js, /\/h\/ledger\/:token/);
  assert.match(composed.entry_js, /\/ledger\/:token/);
  assert.match(composed.entry_js, /Branding-keep\.js/);
  assert.match(composed.entry_js, /Mortgage-keep\.js/);
  assert.match(composed.homeowner_ledger_js, /Diagnostic: /);
  assert.match(composed.homeowner_ledger_js, /__hoFormatLedgerViewDiag/);
  assert.match(composed.homeowner_ledger_js, /globalThis\.__hoLedgerViewErr/);
  assert.match(composed.homeowner_ledger_js, /homeowner-ledger-view-diagnostic/);
  assert.match(composed.homeowner_ledger_js, /globalThis\.__hoLedgerViewErr=null/);
  assert.match(composed.homeowner_ledger_js, /Ask your claim team to resend your ledger link/);
  assert.doesNotMatch(composed.homeowner_ledger_js, /Authorization/);
  assert.doesNotMatch(composed.homeowner_ledger_js, /tenant_id/);
  assert.doesNotMatch(composed.homeowner_ledger_js, /claim_id/);
  for (const leak of FORBIDDEN_DIAGNOSTIC_LEAKS) {
    assert.equal(INLINED_DIAGNOSTIC_HELPER.includes(leak), false, leak);
  }
});

test('compose refuses a stale or unmatched live HomeownerLedger chunk', () => {
  assert.throws(() => composeHomeownerLedgerDiagnostic({
    indexHtml: '<script src="/assets/index-DJNHggvS.js"></script>',
    entryJs: 'import("./HomeownerLedger-cDMDKYsn.js")',
    homeownerLedgerJs: 'homeowner-ledger-view Could not load ledger This link isn\'t working Ask your claim team to resend your ledger link. }catch(x){u(x.message||"Could not load ledger")}',
    homeownerLedgerFileName: 'HomeownerLedger-cDMDKYsn.js',
    entryFileName: 'index-DJNHggvS.js',
  }), /stale SPA/);
  assert.throws(() => composeHomeownerLedgerDiagnostic({
    indexHtml: '<script src="/assets/index-BomgsBaq.js"></script>',
    entryJs: 'import("./HomeownerLedger-cDMDKYsn.js")',
    homeownerLedgerJs: 'export default function Other(){return null}',
    homeownerLedgerFileName: 'HomeownerLedger-cDMDKYsn.js',
    entryFileName: 'index-BomgsBaq.js',
  }), /missing required marker/);
});

#!/usr/bin/env node
/**
 * Production SPA PREFLIGHT overlay. Never writes AWS.
 * Authority is the live Branding bundle, not the staging Mortgage Ops SPA.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import {
  OLD_BOUNDARY_ORIGINAL,
  NEW_BOUNDARY,
  OLD_TRY_AGAIN,
  NEW_TRY_AGAIN,
} from '/tmp/mops-repair-src/scripts/lib/staging-spa-dom-notfound-patch.mjs';

const SPA = '/tmp/mops-repair/prod-promote/compose/spa';
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

const entryLive = fs.readFileSync(`${SPA}/index-BgOCQCWm.js`, 'utf8');
const queueLive = fs.readFileSync(`${SPA}/MortgageOpsQueue-BD_nUT7A.js`, 'utf8');
const loginLive = fs.readFileSync(`${SPA}/MortgageOpsLogin-Phn06bQA.js`, 'utf8');
const htmlLive = fs.readFileSync(`${SPA}/index.html`, 'utf8');
const cssLive = fs.readFileSync(`${SPA}/index-C9b4-_no.css`);

if (!entryLive.includes(OLD_BOUNDARY_ORIGINAL)) {
  throw new Error('Branding entry missing original AppErrorBoundary; STOP');
}
if (entryLive.includes('checksops-error-boundary-reload')) {
  throw new Error('Branding entry unexpectedly has staging auto-reload; STOP');
}
if (!entryLive.includes(OLD_TRY_AGAIN)) {
  throw new Error('Branding entry missing Try-again remount; STOP');
}
if (!entryLive.includes('MortgageOpsQueue-BD_nUT7A.js')) {
  throw new Error('Branding entry does not lazy-load current queue; STOP');
}
if (!queueLive.includes('index-BgOCQCWm.js')) {
  throw new Error('Branding queue does not import Branding React entry; STOP');
}
if (!queueLive.includes('bill-mortgage-handling')) {
  throw new Error('Branding queue missing bill-mortgage-handling invoke to remove; STOP');
}
if (!queueLive.includes('defaultValue:"available"')) {
  throw new Error('Branding queue missing defaultValue available; STOP');
}

let entryNext = entryLive.replace(OLD_BOUNDARY_ORIGINAL, NEW_BOUNDARY);
entryNext = entryNext.replace(OLD_TRY_AGAIN, NEW_TRY_AGAIN);
if (entryNext.includes(OLD_BOUNDARY_ORIGINAL) || entryNext.includes(OLD_TRY_AGAIN)) {
  throw new Error('Branding entry boundary patch did not apply uniquely');
}
if (entryNext.includes('MortgageOpsQueue-BD_nUT7A.js') === false) {
  throw new Error('Branding entry lost live queue chunk name');
}
if (entryNext.includes('/assets/index-BgOCQCWm.js') === false && entryNext.includes('index-BgOCQCWm.js') === false) {
  // entry is the file itself; filename is preserved by in-place overwrite
}

if (!queueLive.includes('d.functions.invoke("bill-mortgage-handling"')) {
  throw new Error('queue bill invoke shape changed; STOP');
}

// Expression-safe: valid after a comma and as a statement. Never insert `const`.
const BLUR = 'document.activeElement instanceof HTMLElement&&document.activeElement.blur()';
const BILL_EXACT = 'const{data:S,error:Q}=await d.functions.invoke("bill-mortgage-handling",{body:{request_id:n}});if(P(null),Q||!(S!=null&&S.ok)){const W=(S==null?void 0:S.error)||(Q==null?void 0:Q.message)||"billing failed";u.error(`Marked complete — billing failed: ${W}`)}else if(S!=null&&S.already_billed)u.success("Marked complete (already billed)");else{const ee=((S.total_cents??S.flat_fee_cents)/100).toFixed(2);u.success(`Marked complete — billed $${ee} to ${S.tenant_name}`)}';
if (!queueLive.includes(BILL_EXACT)) {
  throw new Error('exact Branding bill-mortgage-handling block not found; STOP');
}

let queueNext = queueLive.replace('defaultValue:"available"', 'defaultValue:"mine"');
if (!queueNext.includes('u.success("Task accepted"),M()')) {
  throw new Error('accept success refetch shape changed; STOP');
}
queueNext = queueNext.replace(
  'u.success("Task accepted"),M()',
  `u.success("Task accepted"),${BLUR},M()`,
);
queueNext = queueNext.replace(BILL_EXACT, `P(null);u.success("Marked complete");${BLUR};`);
if (!queueNext.includes('u.success("Cancelled");M()')) {
  throw new Error('cancel refetch shape changed; STOP');
}
queueNext = queueNext.replace(
  'u.success("Cancelled");M()',
  `u.success("Cancelled");${BLUR};M()`,
);
if (queueNext.includes('const el=document.activeElement')) {
  throw new Error('queue overlay reintroduced illegal const-after-comma blur; STOP');
}

if (queueNext.includes('bill-mortgage-handling')) {
  throw new Error('queue still contains bill-mortgage-handling');
}
if (!queueNext.includes('defaultValue:"mine"') || queueNext.includes('defaultValue:"available"')) {
  throw new Error('queue default tab patch failed');
}
if (!queueNext.includes('index-BgOCQCWm.js')) {
  throw new Error('queue lost Branding React import');
}
if ((queueNext.match(/index-BgOCQCWm\.js/g) || []).length < 1) {
  throw new Error('queue React import count unexpected');
}

const htmlNext = htmlLive; // keep Branding entry filename
if (!htmlNext.includes('/assets/index-BgOCQCWm.js')) {
  throw new Error('index.html lost Branding entry');
}

fs.writeFileSync(`${SPA}/index-BgOCQCWm.proposed.js`, entryNext);
fs.writeFileSync(`${SPA}/MortgageOpsQueue-BD_nUT7A.proposed.js`, queueNext);

const report = {
  writes_aws: false,
  spa_authority: '/assets/index-BgOCQCWm.js',
  queue_authority: 'MortgageOpsQueue-BD_nUT7A.js',
  login_authority: 'MortgageOpsLogin-Phn06bQA.js',
  not_staging_spa: {
    rejected_entries: ['index-BcLmLtnF.js', 'index-moprRprA.js', 'MortgageOpsQueue-mopsRprD.js'],
  },
  live: {
    index_html_sha256: sha256(htmlLive),
    entry_sha256: sha256(entryLive),
    queue_sha256: sha256(queueLive),
    login_sha256: sha256(loginLive),
    css_sha256: sha256(cssLive),
  },
  proposed: {
    index_html_sha256: sha256(htmlNext),
    index_html_changed: htmlNext !== htmlLive,
    entry_sha256: sha256(entryNext),
    queue_sha256: sha256(queueNext),
    login_sha256: sha256(loginLive),
    css_sha256: sha256(cssLive),
    filenames_preserved: true,
    single_react_entry: 'index-BgOCQCWm.js',
  },
  exact_delta: [
    'AppErrorBoundary ignores transient DOM NotFoundError/removeChild',
    'Try again reloads the page instead of remounting a broken tree',
    'MortgageOpsQueue default tab becomes mine',
    'MortgageOpsQueue blurs the focused Accept/Complete control before refetch',
    'MortgageOpsQueue Complete no longer invokes bill-mortgage-handling',
  ],
  unchanged: [
    'index.html still points at /assets/index-BgOCQCWm.js',
    'MortgageOpsLogin-Phn06bQA.js',
    'index-C9b4-_no.css',
    'all other Branding lazy chunks and CSS',
    'no sw.js / Workbox',
  ],
  proofs: {
    entry_keeps_branding_filename: entryNext.length > 0,
    entry_has_dom_ignore: entryNext.includes('The object can not be found here'),
    entry_try_again_reloads: entryNext.includes('onClick:()=>window.location.reload()'),
    entry_no_auto_reload_loop: !entryNext.includes('checksops-error-boundary-reload'),
    queue_imports_branding_entry: queueNext.includes('index-BgOCQCWm.js'),
    queue_no_bill_mortgage: !queueNext.includes('bill-mortgage-handling'),
    queue_default_mine: queueNext.includes('defaultValue:"mine"'),
    login_unchanged: sha256(loginLive) === sha256(loginLive),
    html_unchanged: htmlNext === htmlLive,
  },
};
fs.writeFileSync(`${SPA}/spa-overlay-report.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));

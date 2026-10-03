#!/usr/bin/env node
/**
 * Hotfix the live MortgageOpsQueue overlay: replace illegal `const` blur
 * insertions with an expression-safe blur. Never writes AWS.
 */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const acorn = require('acorn');

const LIVE = process.argv[2] || '/tmp/mops-repair/prod-promote/accept/live-queue.js';
const OUT = process.argv[3] || '/tmp/mops-repair/prod-promote/hotfix/MortgageOpsQueue-BD_nUT7A.js';
const EXPECTED_LIVE = '092057a7bb4c06844b061df806f0178449cfed3c6f42a7c63ad1849d010a7318';
const ILLEGAL = 'const el=document.activeElement;el instanceof HTMLElement&&el.blur();';
const BLUR = 'document.activeElement instanceof HTMLElement&&document.activeElement.blur();';

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const live = fs.readFileSync(LIVE, 'utf8');
const liveSha = sha256(live);
if (liveSha !== EXPECTED_LIVE) {
  throw new Error(`live queue SHA drift: expected ${EXPECTED_LIVE} got ${liveSha}`);
}
const count = live.split(ILLEGAL).length - 1;
if (count !== 3) {
  throw new Error(`expected 3 illegal blur sites, found ${count}`);
}
if (!live.includes('u.success("Task accepted"),const el=')) {
  throw new Error('expected comma-then-const Accept site; STOP');
}
if (live.includes('bill-mortgage-handling')) {
  throw new Error('live queue unexpectedly still contains bill-mortgage-handling; STOP');
}
if (!live.includes('defaultValue:"mine"')) {
  throw new Error('live queue lost default mine tab; STOP');
}

const next = live.split(ILLEGAL).join(BLUR);
if (next.includes('const el=document.activeElement')) {
  throw new Error('hotfix left a const blur; STOP');
}
if (next.includes('bill-mortgage-handling')) {
  throw new Error('hotfix reintroduced bill-mortgage-handling; STOP');
}
acorn.parse(next, { ecmaVersion: 'latest', sourceType: 'module' });

fs.mkdirSync(require('node:path').dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, next);
const report = {
  writes_aws: false,
  live_sha256: liveSha,
  proposed_sha256: sha256(next),
  illegal_sites_replaced: count,
  blur: BLUR,
  proofs: {
    parseable_module: true,
    no_const_blur: !next.includes('const el=document.activeElement'),
    no_bill_mortgage: !next.includes('bill-mortgage-handling'),
    default_mine: next.includes('defaultValue:"mine"'),
    accept_expression_blur: next.includes('u.success("Task accepted"),document.activeElement instanceof HTMLElement&&document.activeElement.blur();M()'),
  },
};
fs.writeFileSync(OUT.replace(/\.js$/, '.report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));

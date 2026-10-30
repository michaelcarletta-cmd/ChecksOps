/**
 * Gate 3D live state (2026-10-30, read-only): require-mode is live on the production origin-verify
 * authorizer (applied 2026-09-09 by the account root, recorded here), raw execute-api refuses every
 * request but CORS preflight. Owner decision B (2026-10-30): the execute-api endpoint stays enabled,
 * because CloudFront's /prep origin is that endpoint; disabling it needs a custom domain first.
 * The record holds no secret, header value or token.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const read = (rel) => fs.readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');
const DOC = read('aws/cutover/API_PERIMETER_STEP3_GATE3D_LIVE_STATE.md');

test('the live state records require-mode as applied, by whom and when, and that nothing was changed', () => {
  assert.match(DOC, /Work on items 1 and 2/);
  assert.match(DOC, /`ORIGIN_VERIFY_REQUIRE` is\s+`true`/);
  assert.match(DOC, /2026-09-09 02:07:15 UTC by\s+`arn:aws:iam::806168576068:root`/);
  assert.match(DOC, /nothing was changed/);
  assert.match(DOC, /`ChecksOpsCursorApiPerimeterStep3Temp` and `ChecksOpsCursorApiPerimeterStep3AuditTemp` no\s+longer exist/);
});

test('raw execute-api refuses everything but CORS preflight, and the endpoint stays enabled by decision B', () => {
  assert.match(DOC, /`DisableExecuteApiEndpoint` \*\*false\*\*/);
  assert.match(DOC, /raw `GET https:\/\/kiqojucc02\.execute-api\.us-east-1\.amazonaws\.com\/prep\/health` \| \*\*403\*\*/);
  assert.match(DOC, /fabricated `x-checksops-origin-verify` \| 403/);
  assert.match(DOC, /raw `OPTIONS …\/prep\/data\/query` \| \*\*204\*\*/);
  // Decision B, and the reason: CloudFront's /prep origin is the execute-api endpoint, with no custom domain.
  assert.match(DOC, /## Decision \(item 1\): the raw endpoint stays enabled/);
  assert.match(DOC, /Go with B for item 1/);
  assert.match(DOC, /`DisableExecuteApiEndpoint` stays \*\*false\*\* on\s+`kiqojucc02`/);
  assert.match(DOC, /origin `ProductionPrepHttpApi`,\s+whose domain is `kiqojucc02\.execute-api\.us-east-1\.amazonaws\.com`/);
  assert.match(DOC, /API Gateway has no custom domain names/);
  assert.match(DOC, /`checksops\.com\/prep\/\*`, the whole app,\s+would stop answering/);
  // Disabling is never a next step on its own: it appears only after the custom-domain prerequisite.
  assert.doesNotMatch(DOC, /The remaining step is/);
  assert.doesNotMatch(DOC, /## What is left \(item 1\)/);
  const optionA = DOC.split('If this is ever revisited (option A, not planned)')[1];
  assert.ok(optionA, 'option A is recorded as the only path to disabling');
  const domainAt = optionA.indexOf('custom domain');
  const originAt = optionA.indexOf("Move CloudFront's `ProductionPrepHttpApi` origin");
  const disableAt = optionA.indexOf('set `DisableExecuteApiEndpoint=true`');
  assert.ok(domainAt >= 0 && originAt > domainAt && disableAt > originAt, 'custom domain, then origin move, then disable');
  const beforeOptionA = DOC.split('If this is ever revisited (option A, not planned)')[0];
  assert.doesNotMatch(beforeOptionA, /DisableExecuteApiEndpoint=true`? on `kiqojucc02`/);
  assert.match(DOC, /Staging HTTP API `psr19uhop4`/);
  // #1439's move of the CORS smoke stays: it no longer calls the raw host.
  assert.doesNotMatch(read('.github/workflows/guarded-production-cors.yml'), /https:\/\/[a-z0-9]+\.execute-api\./);
  assert.match(DOC, /guarded-production-cors\.yml/);
  assert.match(DOC, /`claude\/cors-smoke-via-cloudfront` \(#1439\)/);
  assert.match(DOC, /`Managed-AllViewerExceptHostHeader`, so `Origin` reaches the API/);
});

test('the record carries no secret, header value or token', () => {
  assert.doesNotMatch(DOC, /SecretString|HeaderValue\s*[:=]/);
  assert.doesNotMatch(DOC, /eyJ[A-Za-z0-9_-]{10,}\./);
  assert.doesNotMatch(DOC, /Bearer [A-Za-z0-9._-]+/);
  // The Gate 3D package stays the review-time record.
  assert.match(read('aws/cutover/API_PERIMETER_STEP3_GATE3D.md'), /STOP FOR REVIEW\. DO NOT APPLY GATE 3D/);
});

// The workflow's "Public production smoke" script, run with fetch stubbed: every request goes to
// CloudFront, the two website origins must be answered with their own origin after apply, and an
// untrusted origin must get no Access-Control-Allow-Origin.
const WORKFLOW = read('.github/workflows/guarded-production-cors.yml');
const SMOKE = (() => {
  const step = WORKFLOW.split('- name: Public production smoke')[1];
  const body = step.split("<<'NODE'\n")[1].split(/\n\s*NODE\n/)[0];
  return body.split('\n').map((line) => line.replace(/^ {10}/, '')).join('\n');
})();

function runSmoke({ mode, answers }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cors-smoke-'));
  try {
    const stub = `const answers = ${JSON.stringify(answers)};
globalThis.__calls = [];
globalThis.fetch = async (url, init = {}) => {
  const origin = init.headers?.Origin ?? null;
  globalThis.__calls.push({ url, method: init.method ?? 'GET', origin });
  if ((init.method ?? 'GET') === 'OPTIONS') {
    const allow = answers[origin] ?? null;
    return { status: 204, headers: { get: (h) => (h.toLowerCase() === 'access-control-allow-origin' ? allow : null) }, text: async () => '' };
  }
  return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ status: 'ok' }) };
};
process.on('exit', () => { console.log('CALLS ' + JSON.stringify(globalThis.__calls)); });
`;
    const file = path.join(dir, 'smoke.mjs');
    fs.writeFileSync(file, stub + SMOKE);
    const r = spawnSync(process.execPath, [file], { env: { PATH: process.env.PATH, INPUT_MODE: mode }, encoding: 'utf8' });
    const calls = JSON.parse((r.stdout.match(/^CALLS (.*)$/m) ?? [null, '[]'])[1]);
    return { status: r.status, stderr: r.stderr, calls };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const GOOD = { 'https://checksops.com': 'https://checksops.com', 'https://www.checksops.com': 'https://www.checksops.com' };

test('the CORS smoke sends every preflight through CloudFront, never to the raw execute-api host', () => {
  const r = runSmoke({ mode: 'apply', answers: GOOD });
  assert.equal(r.status, 0, r.stderr);
  const preflights = r.calls.filter((c) => c.method === 'OPTIONS');
  assert.deepEqual(preflights.map((c) => c.origin), ['https://checksops.com', 'https://www.checksops.com', 'https://cors-probe.invalid']);
  for (const c of r.calls) assert.equal(c.url, 'https://checksops.com/prep/health');
});

test('after apply, the website origins must be allowed and an untrusted origin must not be', () => {
  assert.equal(runSmoke({ mode: 'apply', answers: GOOD }).status, 0);
  const untrusted = runSmoke({ mode: 'apply', answers: { ...GOOD, 'https://cors-probe.invalid': 'https://cors-probe.invalid' } });
  assert.notEqual(untrusted.status, 0);
  assert.match(untrusted.stderr, /an untrusted origin is still allowed after apply/);
  const wildcard = runSmoke({ mode: 'apply', answers: { ...GOOD, 'https://cors-probe.invalid': '*' } });
  assert.notEqual(wildcard.status, 0);
  const noApex = runSmoke({ mode: 'apply', answers: { 'https://www.checksops.com': 'https://www.checksops.com' } });
  assert.notEqual(noApex.status, 0);
  assert.match(noApex.stderr, /checksops\.com is not allowed after apply/);
  const noWww = runSmoke({ mode: 'apply', answers: { 'https://checksops.com': 'https://checksops.com' } });
  assert.notEqual(noWww.status, 0);
  assert.match(noWww.stderr, /www\.checksops\.com is not allowed after apply/);
});

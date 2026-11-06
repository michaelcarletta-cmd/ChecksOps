#!/usr/bin/env node
/**
 * Public, read-only probe for the production SPA fallback function
 * (ops/deployment-guard/PRODUCTION_SPA_FALLBACK.md). Plain HTTPS GETs; no AWS credentials.
 * Run with: node --experimental-strip-types scripts/deployment-guard/spa-fallback-public-probe.mjs
 *
 *   --origin https://staging.checksops.com --expect own
 *       staging acceptance (inspect runs): staging serves each marketing page's own S3 object
 *       (its 403/404 mapping only applies to missing keys), so each marketing path must be
 *       text/html with that page's own og:title. Marketing paths only.
 *   --origin https://checksops.com --expect own
 *       after publish: each marketing path serves its own page, "/" and "/login" still serve
 *       index.html (the home og:title), the entry bundle loads, /prep/health is 200 ok.
 *   --origin https://checksops.com --expect home
 *       after revert: every marketing path is index.html again; the rest as after publish.
 * Retries the whole set (--attempts, --delay seconds) while CloudFront propagates.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOME_PAGE, MARKETING_PAGES } from '../../src/pages/marketing/marketingPages.ts';

export const PRODUCTION_ORIGIN = 'https://checksops.com';
export const ORIGINS = Object.freeze([PRODUCTION_ORIGIN, 'https://staging.checksops.com']);

// The same escaping marketingStaticHead.ts uses for attribute values.
export const escapeAttr = (v) => String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export const ogTitleTag = (title) => `<meta property="og:title" content="${escapeAttr(title)}">`;

/** [{ path, title }] the probe expects: marketing pages (own or home title), then (production) "/" and "/login". */
export function pageExpectations(expect, { spaRoutes = true } = {}) {
  if (!['own', 'home'].includes(expect)) throw new Error(`expect_invalid:${expect}`);
  const marketing = MARKETING_PAGES.filter((page) => page.path !== '/')
    .map((page) => ({ path: page.path, title: expect === 'own' ? page.title : HOME_PAGE.title }));
  return spaRoutes ? [...marketing, { path: '/', title: HOME_PAGE.title }, { path: '/login', title: HOME_PAGE.title }] : marketing;
}

/** Problems with one HTML response; an empty list means it is the expected page. */
export function checkPage({ status, contentType, body }, title) {
  const problems = [];
  if (status !== 200) problems.push(`status ${status}`);
  if (!String(contentType || '').toLowerCase().startsWith('text/html')) problems.push(`content-type ${contentType}`);
  if (!String(body || '').includes(ogTitleTag(title))) problems.push('og:title is not the expected page');
  return problems;
}

export function entryBundlePath(html) {
  const match = String(html || '').match(/<script\b[^>]*\btype="module"[^>]*\bsrc="(\/assets\/[^"]+\.js)"/);
  return match ? match[1] : null;
}

async function get(url) {
  const response = await fetch(url, { headers: { 'cache-control': 'no-cache' }, redirect: 'manual', signal: AbortSignal.timeout(20000) });
  return { status: response.status, contentType: response.headers.get('content-type'), body: await response.text() };
}

export async function probeOnce({ origin, expect, tag, fetcher = get }) {
  const production = origin === PRODUCTION_ORIGIN;
  const problems = [];
  const lines = [];
  let home = null;
  for (const { path: pagePath, title } of pageExpectations(expect, { spaRoutes: production })) {
    let response;
    try { response = await fetcher(`${origin}${pagePath}?probe=${tag}`); } catch (error) { problems.push(`${pagePath}: ${error?.message || error}`); continue; }
    const found = checkPage(response, title);
    if (pagePath === '/') home = response.body;
    if (found.length) problems.push(`${pagePath}: ${found.join(', ')}`);
    else lines.push(`${pagePath}: 200 ${response.contentType}, og:title "${title}"`);
  }
  const bundle = production ? entryBundlePath(home) : null;
  if (production && !bundle) problems.push('/: no entry bundle script');
  else if (bundle) {
    try {
      const response = await fetcher(`${origin}${bundle}`);
      if (response.status !== 200 || !/javascript/i.test(String(response.contentType))) problems.push(`${bundle}: status ${response.status}, ${response.contentType}`);
      else lines.push(`${bundle}: 200 ${response.contentType}`);
    } catch (error) { problems.push(`${bundle}: ${error?.message || error}`); }
  }
  if (production) {
    try {
      const response = await fetcher(`${origin}/prep/health`);
      let status = null;
      try { status = JSON.parse(response.body)?.status; } catch { /* reported below */ }
      if (response.status !== 200 || status !== 'ok') problems.push(`/prep/health: status ${response.status}, body status ${status}`);
      else lines.push('/prep/health: 200 ok');
    } catch (error) { problems.push(`/prep/health: ${error?.message || error}`); }
  }
  return { ok: problems.length === 0, problems, lines };
}

export function parseArgs(argv) {
  const args = { attempts: 1, delay: 30, tag: String(Date.now()) };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    i += 1;
    if (flag === '--origin') args.origin = value;
    else if (flag === '--expect') args.expect = value;
    else if (flag === '--attempts') args.attempts = Number(value);
    else if (flag === '--delay') args.delay = Number(value);
    else if (flag === '--tag') args.tag = value;
    else throw new Error(`unknown_argument:${flag}`);
  }
  if (!ORIGINS.includes(args.origin)) throw new Error(`origin_invalid:${args.origin}`);
  if (!['own', 'home'].includes(args.expect)) throw new Error(`expect_invalid:${args.expect}`);
  if (!Number.isInteger(args.attempts) || args.attempts < 1 || args.attempts > 40) throw new Error('attempts_invalid');
  if (!Number.isFinite(args.delay) || args.delay < 0 || args.delay > 120) throw new Error('delay_invalid');
  if (!/^[A-Za-z0-9-]+$/.test(args.tag)) throw new Error('tag_invalid');
  return args;
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const args = parseArgs(argv);
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  let last;
  for (let attempt = 1; attempt <= args.attempts; attempt += 1) {
    last = await probeOnce({ ...args, tag: `${args.tag}-${attempt}`, fetcher: deps.fetcher });
    if (last.ok) {
      process.stdout.write(`- ${args.origin}, expect ${args.expect} (attempt ${attempt}):\n${last.lines.map((line) => `  - ${line}`).join('\n')}\n`);
      return 0;
    }
    if (attempt < args.attempts) await sleep(args.delay * 1000);
  }
  process.stderr.write(`${args.origin} did not reach the expected state (${args.expect}):\n${last.problems.map((line) => `  - ${line}`).join('\n')}\n`);
  return 2;
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(`${error?.message || error}\n`);
    process.exitCode = 2;
  });
}

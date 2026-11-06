import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MARKETING_PAGES,
  PRICING_EXAMPLE,
  PRICING_PAGE,
  HOME_PAGE,
} from '../../src/pages/marketing/marketingPages.ts';
import { renderStaticHead, staticPageKey } from '../../src/pages/marketing/marketingStaticHead.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const indexHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

test('every marketing page gets its own title, share preview, canonical and JSON-LD in the served HTML', () => {
  for (const page of MARKETING_PAGES) {
    const html = renderStaticHead(indexHtml, page);
    const url = `https://checksops.com${page.path}`;
    assert.equal((html.match(/<title>/g) || []).length, 1, page.path);
    assert.ok(html.includes(`<meta property="og:title" content="${page.title.replace(/&/g, '&amp;')}">`), page.path);
    assert.ok(html.includes(`<link rel="canonical" href="${url}">`), page.path);
    assert.ok(html.includes(`<meta property="og:url" content="${url}">`), page.path);
    assert.equal(html.includes('id="page-json-ld"'), Boolean(page.jsonLd), page.path);
    // The body and the app entry are untouched, so the SPA boots the same way on every page.
    assert.equal(html.slice(html.indexOf('<body>')), indexHtml.slice(indexHtml.indexOf('<body>')));
  }
});

test('the pricing page share preview names pricing, not the home page', () => {
  const html = renderStaticHead(indexHtml, PRICING_PAGE);
  assert.match(html, /<meta property="og:title" content="ChecksOps Pricing - \$7,500 platform \+ \$4 per check">/);
  assert.ok(!html.includes(`content="${HOME_PAGE.title}"`));
  assert.ok(!html.includes(HOME_PAGE.description));
});

test('the home page carries the FAQ schema for its four visible questions', () => {
  const html = renderStaticHead(indexHtml, HOME_PAGE);
  const json = JSON.parse(html.match(/<script type="application\/ld\+json" id="page-json-ld">(.*?)<\/script>/s)[1]);
  assert.equal(json['@type'], 'FAQPage');
  assert.deepEqual(json.mainEntity.map((q) => q.name), [
    'Is ChecksOps a bank or a payment processor?',
    'Who holds the money in the wallet?',
    'What does it cost?',
    'How long does setup take?',
  ]);
});

test('page keys are the extensionless S3 keys CloudFront serves', () => {
  assert.equal(staticPageKey('/'), 'index.html');
  assert.equal(staticPageKey('/pricing'), 'pricing');
  assert.equal(staticPageKey('/vs/checksops-vs-snapsheet'), 'vs/checksops-vs-snapsheet');
  assert.throws(() => staticPageKey('/Pricing.html'));
  assert.equal(new Set(MARKETING_PAGES.map((p) => p.path)).size, MARKETING_PAGES.length);
});

test('every marketing page is in the sitemap and llms.txt', () => {
  const sitemap = fs.readFileSync(path.join(ROOT, 'public/sitemap.xml'), 'utf8');
  const llms = fs.readFileSync(path.join(ROOT, 'public/llms.txt'), 'utf8');
  for (const page of MARKETING_PAGES) {
    const url = `https://checksops.com${page.path}`;
    assert.ok(sitemap.includes(`<loc>${url}</loc>`), url);
    assert.ok(llms.includes(`(${url})`), url);
  }
});

test('the pricing worked example adds up from the published prices', () => {
  assert.equal(PRICING_EXAMPLE.checksMonthly, 400);
  assert.equal(PRICING_EXAMPLE.firstYearMonthlySupport, 13500);
  assert.equal(PRICING_EXAMPLE.firstYearAnnualSupport, 13300);
  assert.equal(PRICING_EXAMPLE.yearTwoAnnualSupport, 5800);
  const llms = fs.readFileSync(path.join(ROOT, 'public/llms.txt'), 'utf8');
  assert.ok(llms.includes('first year $13,500 with monthly support or $13,300 with annual support'));
});

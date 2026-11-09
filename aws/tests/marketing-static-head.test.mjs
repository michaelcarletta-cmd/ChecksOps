import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as marketingPages from '../../src/pages/marketing/marketingPages.ts';
import * as marketingPricing from '../../src/pages/marketing/marketingPricing.ts';

const { MARKETING_PAGES, HOME_PAGE, RETIRED_MARKETING_PATHS } = marketingPages;
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

test('public pricing is retired: /pricing is no marketing page and no page head states a price', () => {
  assert.deepEqual([...RETIRED_MARKETING_PATHS], ['/pricing']);
  assert.ok(!MARKETING_PAGES.some((page) => page.path === '/pricing'));
  for (const name of ['PRICING_PAGE', 'PRICING_EXAMPLE']) assert.equal(name in marketingPages, false, name);
  assert.equal('PUBLISHED_PRICING' in marketingPricing, false);
  for (const page of MARKETING_PAGES) {
    const html = renderStaticHead(indexHtml, page);
    assert.doesNotMatch(html, /7,?500|\$4\b|\$100\b|\$1,000|per-check fee|platform fee/i, page.path);
    assert.ok(!html.includes('https://checksops.com/pricing'), page.path);
  }
});

test('index.html structured data is valid JSON-LD with no offers or prices', () => {
  const blocks = [...indexHtml.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  assert.equal(blocks.length, 1);
  const graph = JSON.parse(blocks[0][1])['@graph'];
  assert.deepEqual(graph.map((node) => node['@type']), ['Organization', 'Service']);
  const text = JSON.stringify(graph);
  for (const banned of ['offers', 'Offer', 'price', '/pricing']) assert.ok(!text.includes(banned), banned);
});

test('the home page carries the FAQ schema for its three visible questions, none about cost', () => {
  const html = renderStaticHead(indexHtml, HOME_PAGE);
  const json = JSON.parse(html.match(/<script type="application\/ld\+json" id="page-json-ld">(.*?)<\/script>/s)[1]);
  assert.equal(json['@type'], 'FAQPage');
  assert.deepEqual(json.mainEntity.map((q) => q.name), [
    'Is ChecksOps a bank or a payment processor?',
    'Who holds the money in the wallet?',
    'How long does setup take?',
  ]);
});

test('page keys are the extensionless S3 keys CloudFront serves', () => {
  assert.equal(staticPageKey('/'), 'index.html');
  assert.equal(staticPageKey('/pricing'), 'pricing');
  assert.equal(staticPageKey('/claim-check-tracking'), 'claim-check-tracking');
  assert.equal(staticPageKey('/vs/checksops-vs-snapsheet'), 'vs/checksops-vs-snapsheet');
  assert.throws(() => staticPageKey('/Pricing.html'));
  assert.equal(new Set(MARKETING_PAGES.map((p) => p.path)).size, MARKETING_PAGES.length);
});

test('every marketing page is in the sitemap and llms.txt, and no retired page is', () => {
  const sitemap = fs.readFileSync(path.join(ROOT, 'public/sitemap.xml'), 'utf8');
  const llms = fs.readFileSync(path.join(ROOT, 'public/llms.txt'), 'utf8');
  for (const page of MARKETING_PAGES) {
    const url = `https://checksops.com${page.path}`;
    assert.ok(sitemap.includes(`<loc>${url}</loc>`), url);
    assert.ok(llms.includes(`(${url})`), url);
  }
  assert.equal((sitemap.match(/<loc>/g) || []).length, MARKETING_PAGES.length);
  for (const retired of RETIRED_MARKETING_PATHS) {
    assert.ok(!sitemap.includes(`https://checksops.com${retired}<`), retired);
    assert.ok(!llms.includes(`https://checksops.com${retired})`), retired);
  }
});

test('llms.txt states no ChecksOps price', () => {
  const llms = fs.readFileSync(path.join(ROOT, 'public/llms.txt'), 'utf8');
  assert.doesNotMatch(llms, /\$|pricing|per check|platform fee/i);
});

test('the build writes each retired path as a copy of the home page, so the guarded upload overwrites the old object', () => {
  const vite = fs.readFileSync(path.join(ROOT, 'vite.config.ts'), 'utf8');
  assert.match(vite, /for \(const retired of RETIRED_MARKETING_PATHS\)/);
  assert.match(vite, /const homeHtml = renderStaticHead\(indexHtml, HOME_PAGE\);/);
  const home = renderStaticHead(indexHtml, HOME_PAGE);
  assert.ok(home.includes('<link rel="canonical" href="https://checksops.com/">'));
  assert.ok(home.includes(`<meta property="og:title" content="${HOME_PAGE.title}">`));
});

test('the SPA sends /pricing to the home page and no public page links to it', () => {
  const app = fs.readFileSync(path.join(ROOT, 'src/App.tsx'), 'utf8');
  assert.match(app, /<Route path="\/pricing" element={<Navigate to="\/" replace \/>} \/>/);
  assert.ok(!app.includes('CheckOpsPricing'));
  assert.equal(fs.existsSync(path.join(ROOT, 'src/pages/checkops/CheckOpsPricing.tsx')), false);
  for (const rel of [
    'src/pages/marketing/CheckCenterMarketing.tsx',
    'src/pages/marketing/ChecksOpsVsIink.tsx',
    'src/pages/marketing/ChecksOpsVsCarrierPlatform.tsx',
    'src/pages/marketing/ClaimCheckTracking.tsx',
    'src/components/marketing/MarketingPageShell.tsx',
    'src/pages/checkops/CheckOpsSecurity.tsx',
  ]) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.ok(!/["'`]\/pricing["'`]/.test(src), `${rel} links to /pricing`);
    assert.ok(!/See (ChecksOps )?pricing|PUBLISHED_PRICING|7,500/.test(src), `${rel} shows pricing`);
  }
});

// Second UI pass and speed fixes (owner, 2026-11-12): the app should not read as AI-made, and
// the main bundle should carry only what every page needs. These pin the outcome so a later
// change cannot quietly bring back a second toaster, decorative emoji or sparkle icons, the
// Lovable share image, or the eager white-label settings import.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { toast as sonner } from 'sonner';
import { toast, useToast, TOAST_DURATION_MS } from '../../src/hooks/use-toast.ts';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

function srcFiles(dir = 'src') {
  return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) return srcFiles(rel);
    return /\.(tsx?|css)$/.test(e.name) ? [rel] : [];
  });
}

test('one toast system: App mounts Sonner only, and the Radix toaster is gone', () => {
  const app = read('src/App.tsx');
  assert.match(app, /import \{ Toaster as Sonner \} from "@\/components\/ui\/sonner";/);
  assert.match(app, /<Sonner \/>/);
  assert.doesNotMatch(app, /components\/ui\/toaster/);
  assert.equal((app.match(/<Toaster\b/g) || []).length, 0);
  assert.equal(exists('src/components/ui/toaster.tsx'), false);
  assert.equal(exists('src/components/ui/toast.tsx'), false);
  for (const file of srcFiles()) {
    assert.doesNotMatch(read(file), /@\/components\/ui\/toast["']|@radix-ui\/react-toast/, file);
  }
});

test('use-toast keeps its API and every toast reaches Sonner, stacked, none replaced', () => {
  const before = sonner.getHistory().length;
  const a = toast({ title: 'Saved', description: 'Check updated.' });
  const b = toast({ title: 'Not saved', description: 'Try again.', variant: 'destructive' });
  const c = useToast().toast({ description: 'Description only' });
  const added = sonner.getHistory().slice(before);
  assert.equal(added.length, 3, 'three toasts, none dropped');
  assert.deepEqual(added.map((t) => t.id), [a.id, b.id, c.id]);
  assert.equal(added[0].title, 'Saved');
  assert.equal(added[0].description, 'Check updated.');
  assert.equal(added[0].duration, TOAST_DURATION_MS);
  assert.equal(added[1].type, 'error', 'destructive shows as an error toast');
  assert.equal(added[2].title, 'Description only', 'a description-only toast still shows its text');
  assert.equal(added[2].description, undefined);
  assert.equal(typeof a.dismiss, 'function');
  assert.equal(typeof useToast().dismiss, 'function');
  a.update({ title: 'Saved again' });
  assert.equal(sonner.getHistory().at(-1).title, 'Saved again');
  assert.equal(sonner.getHistory().at(-1).id, a.id, 'update edits the same toast');
});

test('no decorative emoji in the named screens; Mortgage Desk data markers are untouched', () => {
  const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B50}\u{FE0F}]/u;
  for (const file of [
    'src/components/deposit-ops/ExceptionResolutionPanel.tsx',
    'src/components/loss-draft/LossDraftDetailPanel.tsx',
    'src/components/loss-draft/MortgageDeskShippingCard.tsx',
    'src/components/settings/SignaturePresetsSettings.tsx',
    'src/components/check-review/CheckReviewConsole.tsx',
  ]) assert.doesNotMatch(read(file), emoji, file);
});

test('no decorative Sparkles or Wand2 icons, and Check Center help says what the feature does', () => {
  for (const file of srcFiles()) {
    assert.doesNotMatch(read(file), /\b(?:Sparkles|Wand2)\b/, file);
  }
  const help = read('src/components/check-review/CheckCenterHelp.tsx');
  assert.doesNotMatch(help, /\bAI\b/);
  assert.match(help, /suggests a deposit path/);
});

test('share image is a ChecksOps asset, not the Lovable preview', () => {
  const html = read('index.html');
  assert.doesNotMatch(html, /lovable\.app-|r2\.dev/);
  assert.match(html, /<meta property="og:image" content="https:\/\/checksops\.com\/og-image\.png">/);
  assert.match(html, /<meta name="twitter:image" content="https:\/\/checksops\.com\/og-image\.png">/);
  const png = fs.readFileSync(path.join(ROOT, 'public/og-image.png'));
  assert.equal(png.subarray(1, 4).toString('latin1'), 'PNG');
  assert.equal(png.readUInt32BE(16), 1200, 'width');
  assert.equal(png.readUInt32BE(20), 630, 'height');
});

test('custom-domain app and white-label settings load on demand, not in the main bundle', () => {
  const app = read('src/App.tsx');
  assert.doesNotMatch(app, /^import \{ CustomDomainWhiteLabelApp \}/m);
  assert.match(app, /const CustomDomainWhiteLabelApp = lazy\(\(\) =>\s*import\("\.\/components\/white-label\/CustomDomainWhiteLabelApp"\)/);
  assert.match(app, /<Suspense fallback=\{<PageLoader \/>\}>\s*<CustomDomainWhiteLabelApp slug=\{tenantSlug\} \/>/);
  for (const file of ['src/pages/WhiteLabelApp.tsx', 'src/components/white-label/CustomDomainWhiteLabelApp.tsx']) {
    const src = read(file);
    assert.doesNotMatch(src, /^import \{ WhiteLabelSettings \}/m, file);
    assert.match(src, /const WhiteLabelSettings = lazy\(\(\) =>\s*import\("@\/components\/white-label\/WhiteLabelSettings"\)/, file);
    assert.match(src, /<Suspense fallback=\{[^}]*\}>\s*<WhiteLabelSettings \/>\s*<\/Suspense>/, file);
  }
});

test('logo images are compressed', () => {
  for (const [file, max] of [
    ['src/assets/homeowner-ops-logo.png', 80_000],
    ['src/assets/mortgage-ops-logo.png', 120_000],
    ['public/checksops-logo.png', 80_000],
    ['public/favicon.png', 30_000],
    ['public/pwa-192.png', 30_000],
  ]) {
    const size = fs.statSync(path.join(ROOT, file)).size;
    assert.ok(size <= max, `${file} is ${size} bytes`);
  }
  const icon = fs.readFileSync(path.join(ROOT, 'public/pwa-192.png'));
  assert.equal(icon.readUInt32BE(16), 192, 'pwa-192.png is 192 wide, as the manifest says');
  assert.equal(icon.readUInt32BE(20), 192);
});

test('brand stays: olive primary and Inter', () => {
  const css = read('src/index.css');
  assert.match(css, /--primary: 69 32% 29%;/);
  assert.match(read('tailwind.config.ts'), /Inter/);
});

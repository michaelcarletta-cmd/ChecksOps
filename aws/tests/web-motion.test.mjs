// Website motion: the app's animations, shorter and smaller, plus hover feedback and a sliding tab
// highlight. Every website rule is keyed off html:not(.native-app), so the app keeps its own block.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { NATIVE_PANEL_ENTER, playPanelEntrance, WEB_PANEL_ENTER, WEB_PANEL_TIMING } from '../../src/lib/nativeApp.ts';
import { measureActiveTab, syncTabIndicator } from '../../src/lib/tabIndicator.ts';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const NATIVE = { Capacitor: { isNativePlatform: () => true } };

function webBlock() {
  const css = read('src/index.css');
  const start = css.indexOf('/* ── Website only');
  const end = css.indexOf('/* ── iOS / Android app only');
  assert.ok(start > -1 && end > start, 'website block sits before the app block');
  return css.slice(start, end);
}

test('every website motion rule is scoped to html:not(.native-app)', () => {
  const selectors = webBlock()
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/@keyframes[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '')
    .replace(/@media[^{]*\{/g, '')
    .split('}')
    .map((chunk) => chunk.split('{')[0].trim())
    .filter((sel) => sel.length > 0);
  assert.ok(selectors.length >= 15, `found ${selectors.length} rules`);
  for (const sel of selectors) {
    for (const part of sel.split(/,(?![^(]*\))/)) {
      assert.match(part.trim(), /^html:not\(\.native-app\)/, `unscoped selector: ${part.trim()}`);
    }
  }
});

test('website motion: entrances never leave a translate behind, hover is mouse-only, reduced motion off', () => {
  const block = webBlock();
  assert.doesNotMatch(block, /animation:[^;]*\bboth;/);
  assert.match(block, /@media \(hover: hover\) and \(pointer: fine\) \{\s*html:not\(\.native-app\) \.cursor-pointer\.rounded-lg\.border/);
  assert.match(block, /prefers-reduced-motion: reduce\)[^]*animation-delay: 0ms !important;/);
  for (const sel of [
    'html:not(.native-app) [data-app-dialog][data-state="open"] {',
    'html:not(.native-app) [data-app-sheet="right"][data-state="open"]',
    'html:not(.native-app) [role="tablist"][data-tab-indicator-ready] > [data-tab-indicator] {',
    'html:not(.native-app) [role="tablist"][data-tab-indicator-ready] [role="tab"][data-state="active"] {',
  ]) assert.ok(block.includes(sel), sel);
});

function fakeAnimatedDocument(count) {
  const played = [];
  const els = Array.from({ length: count }, () => ({ animate: (k, t) => played.push({ k, t }) }));
  return { played, querySelectorAll: () => els };
}

test('check panel entrance: smaller and shorter on the website, the app keeps its own', () => {
  const web = fakeAnimatedDocument(1);
  assert.equal(playPanelEntrance('.check-detail-panel', web, {}), 1);
  assert.equal(web.played[0].k, WEB_PANEL_ENTER);
  assert.equal(web.played[0].t, WEB_PANEL_TIMING);
  for (const frame of WEB_PANEL_ENTER) assert.equal(frame.transform, undefined);

  const app = fakeAnimatedDocument(1);
  assert.equal(playPanelEntrance('.check-detail-panel', app, NATIVE), 1);
  assert.equal(app.played[0].k, NATIVE_PANEL_ENTER);

  const reduced = fakeAnimatedDocument(1);
  assert.equal(playPanelEntrance('.x', reduced, { matchMedia: () => ({ matches: true }) }), 0);
  assert.equal(playPanelEntrance('.x', undefined, {}), 0);
  assert.match(read('src/pages/CheckCommandCenter.tsx'), /import \{ playPanelEntrance \} from "@\/lib\/nativeApp";/);
});

function fakeList(tabs) {
  const attrs = new Map();
  const vars = new Map();
  const list = {
    attrs,
    vars,
    style: { setProperty: (k, v) => vars.set(k, v) },
    setAttribute: (k, v) => attrs.set(k, v),
    removeAttribute: (k) => attrs.delete(k),
    hasAttribute: (k) => attrs.has(k),
    querySelectorAll: () => tabs,
  };
  for (const t of tabs) if (!t.closest) t.closest = () => list;
  return list;
}

test('tab highlight: placed under this list\'s active tab, hidden for an unmeasured list and in the app', () => {
  const nested = { offsetLeft: 1, offsetTop: 1, offsetWidth: 10, offsetHeight: 10, closest: () => ({}) };
  const own = { offsetLeft: 96, offsetTop: 4, offsetWidth: 80, offsetHeight: 32 };
  const list = fakeList([nested, own]);
  assert.deepEqual(measureActiveTab(list), { x: 96, y: 4, w: 80, h: 32 });
  assert.equal(syncTabIndicator(list, {}), true);
  assert.equal(list.vars.get('--tab-x'), '96px');
  assert.equal(list.vars.get('--tab-w'), '80px');
  assert.ok(list.attrs.has('data-tab-indicator-ready'));

  const hidden = fakeList([{ offsetLeft: 0, offsetTop: 0, offsetWidth: 0, offsetHeight: 0 }]);
  hidden.setAttribute('data-tab-indicator-ready', '');
  assert.equal(syncTabIndicator(hidden, {}), false);
  assert.ok(!hidden.attrs.has('data-tab-indicator-ready'), 'a hidden list keeps the plain tab look');

  const app = fakeList([own]);
  assert.equal(syncTabIndicator(app, NATIVE), false);
  assert.equal(app.attrs.size, 0);
  assert.equal(syncTabIndicator(null, {}), false);
});

test('TabsList renders the highlight and keeps it out of layout until placed', () => {
  const src = read('src/components/ui/tabs.tsx');
  assert.match(src, /<span aria-hidden="true" data-tab-indicator="" className="pointer-events-none absolute left-0 top-0 hidden" \/>/);
  assert.match(src, /"relative inline-flex h-10 items-center/);
  assert.match(src, /const ready = syncTabIndicator\(list\);/);
  assert.match(src, /attributeFilter: \["data-state"\]/);
});

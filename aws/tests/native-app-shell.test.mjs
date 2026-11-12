// The iOS/Android app (mobile/, Capacitor) gets app-only styles: html.native-app, set at startup by
// applyNativeAppShell. Every rule keyed off it lives under html.native-app, so the website is
// unchanged. Payments & Financials picks its section from a dropdown in the app only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { applyNativeAppShell, NATIVE_PANEL_ENTER, NATIVE_PANEL_TIMING, playNativeAppEntrance } from '../../src/lib/nativeApp.ts';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const NATIVE = { Capacitor: { isNativePlatform: () => true } };

function fakeDocument(viewportContent) {
  const classes = new Set();
  const meta = viewportContent === null ? null : {
    content: viewportContent,
    getAttribute: (name) => (name === 'content' ? meta.content : null),
    setAttribute: (name, value) => { if (name === 'content') meta.content = value; },
  };
  return {
    classes,
    meta,
    documentElement: { classList: { add: (c) => classes.add(c) } },
    querySelector: (selector) => (selector === 'meta[name="viewport"]' ? meta : null),
  };
}

test('in the app: html.native-app is set and the viewport runs under the status bar', () => {
  const doc = fakeDocument('width=device-width, initial-scale=1.0');
  assert.equal(applyNativeAppShell(doc, NATIVE), true);
  assert.ok(doc.classes.has('native-app'));
  assert.equal(doc.meta.content, 'width=device-width, initial-scale=1.0, viewport-fit=cover');
  applyNativeAppShell(doc, NATIVE);
  assert.equal(doc.meta.content, 'width=device-width, initial-scale=1.0, viewport-fit=cover', 'not added twice');
});

test('in a browser: nothing changes', () => {
  for (const win of [{}, undefined, { Capacitor: { isNativePlatform: () => false } }]) {
    const doc = fakeDocument('width=device-width, initial-scale=1.0');
    assert.equal(applyNativeAppShell(doc, win), false);
    assert.equal(doc.classes.size, 0);
    assert.equal(doc.meta.content, 'width=device-width, initial-scale=1.0');
  }
  assert.equal(applyNativeAppShell(undefined, NATIVE), false);
});

test('main.tsx applies the shell before the first render', () => {
  const main = read('src/main.tsx');
  assert.ok(main.indexOf('applyNativeAppShell();') > -1);
  assert.ok(main.indexOf('applyNativeAppShell();') < main.indexOf('createRoot('));
});

test('every app-only CSS rule is scoped to html.native-app', () => {
  const css = read('src/index.css');
  const block = css.slice(css.indexOf('/* ── iOS / Android app only'));
  assert.ok(block.length > 0);
  const selectors = block
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/@keyframes[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '')
    .replace(/@media[^{]*\{/g, '')
    .split('}')
    .map((chunk) => chunk.split('{')[0].trim())
    .filter((sel) => sel.length > 0);
  assert.ok(selectors.length >= 8, `found ${selectors.length} rules`);
  for (const sel of selectors) {
    for (const part of sel.split(/,(?![^(]*\))/)) {
      assert.match(part.trim(), /^html\.native-app\b/, `unscoped selector: ${part.trim()}`);
    }
  }
});

test('the shell and page wrappers carry the classes the app styles target', () => {
  assert.match(read('src/App.tsx'), /<ThemeScope className="app-shell">/);
  assert.match(read('src/components/shell/PageShell.tsx'), /cn\("page-shell /);
});

test('Payments: a dropdown on phones (app, and the website below sm), the tab strip on wider screens', () => {
  const src = read('src/pages/Payments.tsx');
  assert.match(src, /const nativeApp = isNativeApp\(\);/);
  assert.match(src, /<Select value=\{activeTab\} onValueChange=\{setActiveTab\}>/);
  assert.match(src, /className=\{cn\("mb-6 h-12 w-full text-base", !nativeApp && "sm:hidden"\)\}/);
  assert.match(src, /\{!nativeApp && \(\s*<TabsList className="hidden sm:inline-flex bg-muted\/50 p-1 mb-8 overflow-x-auto w-full justify-start sm:w-auto h-auto">/);
  for (const value of ['ledger', 'invoices', 'revenue', 'recipients', 'tax', 'payroll']) {
    assert.match(src, new RegExp(`value: "${value}"`), value);
    assert.match(src, new RegExp(`<TabsContent value="${value}"`), `${value} content`);
  }
  assert.match(src, /\.\.\.\(canTax \? \[\{ value: "tax"/);
  assert.match(src, /\.\.\.\(isAdmin \? \[\{ value: "payroll"/);
});

test('the iOS project leaves the safe area to the CSS (no contentInset as well)', () => {
  const config = JSON.parse(read('mobile/capacitor.config.json'));
  assert.equal(config.ios?.contentInset, undefined);
});

test('login: the "Back to checksops.com" link is hidden in the app, kept on the website', () => {
  const src = read('src/pages/checkops/CheckOpsLogin.tsx');
  assert.match(src, /\{!isNativeApp\(\) && <Button[^]*?Back to checksops\.com<\/Link><\/Button>\}/);
});

function fakeAnimatedDocument(count) {
  const played = [];
  const els = Array.from({ length: count }, (_, i) => ({ animate: (k, t) => played.push({ i, k, t }) }));
  return { played, querySelectorAll: () => els };
}

test('check panel entrance plays in the app only, and not with reduced motion', () => {
  const doc = fakeAnimatedDocument(2);
  assert.equal(playNativeAppEntrance('.check-detail-panel', undefined, undefined, doc, NATIVE), 2);
  assert.equal(doc.played.length, 2);
  assert.equal(doc.played[0].k, NATIVE_PANEL_ENTER);
  assert.ok(doc.played[0].t.duration > 0);
  // Individual properties only: the panel's own transform is never animated.
  for (const frame of NATIVE_PANEL_ENTER) assert.equal(frame.transform, undefined);

  const web = fakeAnimatedDocument(1);
  assert.equal(playNativeAppEntrance('.check-detail-panel', undefined, undefined, web, {}), 0);
  assert.equal(web.played.length, 0);

  const reduced = fakeAnimatedDocument(1);
  const reducedWin = { ...NATIVE, matchMedia: (q) => ({ matches: q.includes('reduce') }) };
  assert.equal(playNativeAppEntrance('.check-detail-panel', undefined, undefined, reduced, reducedWin), 0);
  assert.equal(playNativeAppEntrance('.x', undefined, undefined, undefined, NATIVE), 0);
});

test('the check panel replays its entrance when a check is opened or switched', () => {
  const src = read('src/pages/CheckCommandCenter.tsx');
  assert.equal((src.match(/className=\{`check-detail-panel /g) || []).length, 2);
  assert.match(src, /<Card ref=\{reviewPanelRef\} className="check-detail-panel /);
  assert.match(src, /playPanelEntrance\("\.check-detail-panel"\)\);\s*return \(\) => cancelAnimationFrame\(frame\);\s*\}, \[selectedCheck, reviewCheckId\]\);/);
});

test('dialogs and sheets carry the markers the app animations target', () => {
  assert.match(read('src/components/ui/dialog.tsx'), /<DialogPrimitive\.Content\s+ref=\{ref\}\s+data-app-dialog=""/);
  assert.match(read('src/components/ui/alert-dialog.tsx'), /<AlertDialogPrimitive\.Content\s+ref=\{ref\}\s+data-app-dialog=""/);
  assert.match(read('src/components/ui/sheet.tsx'), /data-app-sheet=\{side \?\? "right"\}/);
});

test('app animations: dialogs, sheets, fields, panel; entrances never leave a translate behind', () => {
  const css = read('src/index.css');
  const block = css.slice(css.indexOf('/* ── iOS / Android app only'));
  for (const sel of [
    'html.native-app [data-app-dialog][data-state="open"] {',
    'html.native-app [data-app-sheet="right"][data-state="open"]',
    'html.native-app .check-detail-panel > * > * {',
    'html.native-app .route-page {',
    'html.native-app [data-radix-popper-content-wrapper] > [data-state="open"] {',
  ]) assert.ok(block.includes(sel), sel);
  assert.match(block, /textarea, button\[role="combobox"\]\):focus \{\s*animation: native-field-focus/);
  assert.doesNotMatch(block, /animation:[^;]*\bboth;/, 'fill both would leave translate set (a containing block for fixed children)');
  assert.doesNotMatch(block, /@keyframes native-(?:enter|dialog-in|sheet-\w+|pop) \{[^}]*transform/, 'keyframes use translate/scale, not transform');
  assert.match(block, /prefers-reduced-motion: reduce\)[^]*animation-delay: 0ms !important;/);
});

test('app pages float in from the right, once: one keyed .route-page per path, no double move', () => {
  const app = read('src/pages/WhiteLabelApp.tsx');
  assert.match(app, /<div key=\{location\.pathname\} className="route-page">\s*<Routes>/);
  for (const path of ['checks', 'payments', 'cash-jobs', 'wallet-ops', 'settings']) {
    assert.match(app, new RegExp(`path="${path}"`), path);
  }
  const css = read('src/index.css');
  const block = css.slice(css.indexOf('/* ── iOS / Android app only'));
  assert.match(block, /@keyframes native-page-in \{\s*from \{ opacity: 0; translate: 24px 0; \}/);
  assert.match(block, /html\.native-app \.route-page \{\s*overflow-x: clip;\s*animation: native-page-in /);
  assert.match(block, /html\.native-app \.route-page \.page-shell \{\s*animation: none;/);
  assert.doesNotMatch(block, /\.page-shell > /, 'no one-by-one sections on top of the page slide');
});

// Second UI pass (2026-11-12): the app moves like a calm native app, not a demo. No easing
// overshoots (a cubic-bezier y above 1 springs past the target), and nothing runs long.
test('app motion is calm: no overshooting easing, short durations and staggers', () => {
  const css = read('src/index.css');
  const block = css.slice(css.indexOf('/* ── iOS / Android app only'));
  const curves = [...block.matchAll(/cubic-bezier\(([^)]*)\)/g)].map((m) => m[1].split(',').map(Number));
  assert.ok(curves.length >= 10, `found ${curves.length} curves`);
  for (const [x1, y1, x2, y2] of curves) {
    assert.ok(y1 <= 1 && y2 <= 1 && y1 >= 0 && y2 >= 0, `overshooting curve cubic-bezier(${x1}, ${y1}, ${x2}, ${y2})`);
  }
  const body = block.slice(0, block.indexOf('@media (prefers-reduced-motion'));
  const durations = [...body.matchAll(/(?:animation|transition):[^;]*/g)]
    .flatMap((m) => [...m[0].matchAll(/(\d+)ms/g)].map((d) => Number(d[1])));
  assert.ok(durations.length >= 15, `found ${durations.length} durations`);
  for (const ms of durations) assert.ok(ms <= 300, `duration ${ms}ms is longer than 300ms`);
  const delays = [...body.matchAll(/animation-delay: (\d+)ms/g)].map((m) => Number(m[1]));
  assert.ok(delays.length >= 7);
  for (const ms of delays) assert.ok(ms <= 120, `stagger ${ms}ms is longer than 120ms`);
  assert.ok(NATIVE_PANEL_TIMING.duration <= 300, 'check panel entrance is short');
  assert.doesNotMatch(String(NATIVE_PANEL_TIMING.easing), /cubic-bezier\([^)]*\b1\.\d/, 'check panel entrance does not overshoot');
});

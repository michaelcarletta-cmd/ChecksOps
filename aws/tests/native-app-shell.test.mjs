// The iOS/Android app (mobile/, Capacitor) gets app-only styles: html.native-app, set at startup by
// applyNativeAppShell. Every rule keyed off it lives under html.native-app, so the website is
// unchanged. Payments & Financials picks its section from a dropdown in the app only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { applyNativeAppShell } from '../../src/lib/nativeApp.ts';

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

test('Payments: a dropdown in the app, the same tab strip on the website, one list of sections', () => {
  const src = read('src/pages/Payments.tsx');
  assert.match(src, /const nativeApp = isNativeApp\(\);/);
  assert.match(src, /\{nativeApp \? \(\s*<Select value=\{activeTab\} onValueChange=\{setActiveTab\}>/);
  assert.match(src, /<TabsList className="bg-muted\/50 p-1 mb-8 overflow-x-auto w-full justify-start sm:w-auto h-auto">/);
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

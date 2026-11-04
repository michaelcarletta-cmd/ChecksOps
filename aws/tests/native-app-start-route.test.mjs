// The iOS/Android app (mobile/, Capacitor) opens at /login, which shows the sign-in form or sends a
// signed-in user on to their tenant. In a browser, / stays the marketing landing.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { isNativeApp } from '../../src/lib/nativeApp.ts';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('isNativeApp is true only when the Capacitor shell reports a native platform', () => {
  assert.equal(isNativeApp({ Capacitor: { isNativePlatform: () => true } }), true);
  assert.equal(isNativeApp({ Capacitor: { isNativePlatform: () => false } }), false);
  assert.equal(isNativeApp({ Capacitor: {} }), false);
  assert.equal(isNativeApp({}), false);
  assert.equal(isNativeApp(undefined), false);
  assert.equal(isNativeApp({ Capacitor: { isNativePlatform: () => { throw new Error('bridge not ready'); } } }), false);
  assert.equal(isNativeApp({ Capacitor: { isNativePlatform: () => 'yes' } }), false);
});

test('/ redirects to /login in the app and keeps the landing page in a browser', () => {
  const app = fs.readFileSync(path.join(ROOT, 'src/App.tsx'), 'utf8');
  const route = app.match(/<Route\s+path="\/"\s+element=\{([^\n]+)\}\s*\/>/);
  assert.ok(route, 'the / route is present');
  assert.match(route[1], /^isNativeApp\(\) \? <Navigate to="\/login" replace \/> : <Suspense fallback=\{<PageLoader \/>\}><CheckOpsLanding \/><\/Suspense>$/);
});

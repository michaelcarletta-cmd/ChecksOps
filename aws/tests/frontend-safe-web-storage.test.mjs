/**
 * Owner 2026-11-23: "Signers are getting this error message when signing checks" (checksops.com/endorse:
 * "Failed to read the 'localStorage' property from 'Window': Access is denied"). The browser refuses
 * localStorage; src/lib/safeWebStorage.ts swaps in an in-memory Storage before the app loads.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  createMemoryStorage,
  installSafeWebStorage,
  isStorageUsable,
} from '../../src/lib/safeWebStorage.ts';

const read = (rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');

function blockedWindow() {
  const win = {};
  for (const name of ['localStorage', 'sessionStorage']) {
    Object.defineProperty(win, name, {
      configurable: true,
      enumerable: true,
      get() {
        const error = new Error(`Failed to read the '${name}' property from 'Window': Access is denied for this document.`);
        error.name = 'SecurityError';
        throw error;
      },
    });
  }
  return win;
}

test('a blocked localStorage and sessionStorage are replaced with working in-memory storage', () => {
  const win = blockedWindow();
  assert.throws(() => win.localStorage.getItem('x'), /Access is denied/);
  assert.deepEqual(installSafeWebStorage(win), ['localStorage', 'sessionStorage']);
  win.localStorage.setItem('k', 'v');
  assert.equal(win.localStorage.getItem('k'), 'v');
  assert.equal(win.localStorage.length, 1);
  assert.equal(win.localStorage.key(0), 'k');
  win.localStorage.removeItem('k');
  assert.equal(win.localStorage.getItem('k'), null);
  win.sessionStorage.setItem('a', 1);
  assert.equal(win.sessionStorage.getItem('a'), '1');
  win.sessionStorage.clear();
  assert.equal(win.sessionStorage.length, 0);
});

test('a storage that exists but throws on write (quota 0, private mode) is replaced too', () => {
  const broken = { getItem: () => null, setItem: () => { throw new Error('QuotaExceededError'); }, removeItem() {} };
  const win = { localStorage: broken, sessionStorage: createMemoryStorage() };
  assert.equal(isStorageUsable(win, 'localStorage'), false);
  assert.deepEqual(installSafeWebStorage(win), ['localStorage']);
  win.localStorage.setItem('k', 'v');
  assert.equal(win.localStorage.getItem('k'), 'v');
});

test('a working storage is left untouched', () => {
  const local = createMemoryStorage();
  local.setItem('keep', 'me');
  const win = { localStorage: local, sessionStorage: createMemoryStorage() };
  assert.deepEqual(installSafeWebStorage(win), []);
  assert.equal(win.localStorage, local);
  assert.equal(win.localStorage.getItem('keep'), 'me');
  assert.equal(win.localStorage.getItem('__checksops_storage_probe__'), null);
});

test('main.tsx imports the shim before anything else', () => {
  const imports = read('src/main.tsx').split('\n').filter((line) => line.startsWith('import '));
  assert.equal(imports[0], 'import "./lib/safeWebStorage";');
});

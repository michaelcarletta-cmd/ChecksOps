/**
 * Security floor for the website build toolchain (2026-11-03).
 *
 * - vite 6.4.5: the vite 5 line, and vite 6 up to 6.4.3, are inside the dev-server advisories, and
 *   vite 5 also pulled esbuild 0.21. The deployed build (`bun run build:aws`) uses vite and its
 *   bundled rollup.
 * - vite-plugin-pwa 1.3 brings workbox-build 7.4.1, which moves its terser plugin to
 *   serialize-javascript 7.1.x; 6.0.2 was inside the advisory ranges. The PWA plugin runs only in
 *   non-aws builds (vite.config.ts), so it never reached the deployed site, but it is in the tree.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const npmLock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8')).packages;
const bunLock = fs.readFileSync(path.join(ROOT, 'bun.lock'), 'utf8');

const cmp = (a, b) => {
  const pa = a.split(/[.-]/).map(Number);
  const pb = b.split(/[.-]/).map(Number);
  for (let i = 0; i < 3; i += 1) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
};
const escapeRegExp = (text) => text.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&');
const bunVersions = (name) => [...bunLock.matchAll(new RegExp(`\\["${escapeRegExp(name)}@([0-9][^"]*)"`, 'g'))].map((m) => m[1]);
const npmVersions = (name) => Object.entries(npmLock)
  .filter(([key]) => key === `node_modules/${name}` || key.endsWith(`/node_modules/${name}`))
  .map(([, value]) => value.version);

const FLOORS = {
  vite: '6.4.5',
  esbuild: '0.25.0',
  'serialize-javascript': '7.1.3',
  'workbox-build': '7.4.1',
  'vite-plugin-pwa': '1.3.0',
};

test('package.json asks for the patched vite and PWA plugin', () => {
  assert.equal(pkg.devDependencies.vite, '^6.4.5');
  assert.equal(pkg.dependencies['vite-plugin-pwa'], '^1.3.0');
});

for (const [name, floor] of Object.entries(FLOORS)) {
  test(`every ${name} in both lockfiles is at or above ${floor}`, () => {
    const versions = [...npmVersions(name), ...bunVersions(name)];
    assert.ok(versions.length >= 2, `${name} missing from a lockfile`);
    for (const version of versions) assert.ok(cmp(version, floor) >= 0, `${name} ${version} < ${floor}`);
  });
}

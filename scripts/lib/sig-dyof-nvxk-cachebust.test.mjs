import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  EXPECTED_FILES_SHA256,
  LIVE_ENTRY,
  LIVE_FILES,
  PATCHED_FILES_SHA256,
  buildNvXkCachebust,
  htmlInvariants,
  injectNvXkImportMap,
  newFilesNameFor,
  resolvePatchedFiles,
  sha256,
} from './sig-dyof-nvxk-cachebust.mjs';
import { patchDyofNvxkFiles } from './sig-dyof-nvxk-files-patch.mjs';

const require = createRequire(import.meta.url);
const acorn = require('acorn');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(HERE, '../../tests/fixtures/current-live-CheckFilesSection-nvXkZh5q.js');

const LIVE_HTML = `<!doctype html>
<html lang="en">
  <head>
    <title>ChecksOps</title>
    <link rel="stylesheet" crossorigin href="/assets/index-C6onCFE-.css">
  <script type="module" crossorigin src="/assets/${LIVE_ENTRY}"></script>
  </head>
  <body><div id="root"></div></body>
</html>
`;

test('fixture patch still hashes to the live overlay Files SHA', () => {
  assert.equal(existsSync(FIXTURE), true);
  const source = readFileSync(FIXTURE);
  assert.equal(sha256(source), EXPECTED_FILES_SHA256);
  const patched = patchDyofNvxkFiles(source.toString('utf8'));
  assert.equal(sha256(patched), PATCHED_FILES_SHA256);
});

test('cachebust remaps nvXk to a new Files URL and keeps DyoF', () => {
  const source = readFileSync(FIXTURE, 'utf8');
  const built = buildNvXkCachebust({ html: LIVE_HTML, files: source });
  acorn.parse(built.files, { ecmaVersion: 'latest', sourceType: 'module' });

  assert.equal(built.new_files, 'CheckFilesSection-d029f3a4.js');
  assert.equal(built.new_files_key, 'assets/CheckFilesSection-d029f3a4.js');
  assert.equal(built.files_sha256, PATCHED_FILES_SHA256);
  assert.equal(built.files.includes('signatures/${r}/'), false);
  assert.equal(built.files.includes('check-intake/${w}/files/'), true);
  assert.equal(built.files.includes(`from"./${LIVE_ENTRY}"`), true);
  assert.equal(built.html.includes(`src="/assets/${LIVE_ENTRY}"`), true);
  assert.equal(built.html.includes(`"/assets/${LIVE_FILES}":"/assets/${built.new_files}"`), true);
  assert.equal(built.html.includes('type="importmap"'), true);
  assert.equal(built.html.includes('index-C9QrEEkl.js'), false);
  assert.equal(Object.keys(built.writes).sort().join(','), 'assets/CheckFilesSection-d029f3a4.js,index.html');
  assert.equal(built.writes['index.html'], built.html);
  assert.equal(built.writes[built.new_files_key], built.files);

  for (const [key, ok] of Object.entries(built.files_invariants)) {
    assert.equal(ok, true, key);
  }
  for (const [key, ok] of Object.entries(built.html_invariants)) {
    assert.equal(ok, true, key);
  }
});

test('already-patched live Files is copied, not double-overlaid', () => {
  const patched = patchDyofNvxkFiles(readFileSync(FIXTURE, 'utf8'));
  const again = resolvePatchedFiles(patched);
  assert.equal(again, patched);
  assert.equal(sha256(again), PATCHED_FILES_SHA256);
  assert.equal(newFilesNameFor(again), 'CheckFilesSection-d029f3a4.js');
});

test('import map inject refuses a second overlay and retired graphs', () => {
  const first = injectNvXkImportMap(LIVE_HTML, 'CheckFilesSection-d029f3a4.js');
  assert.throws(
    () => injectNvXkImportMap(first, 'CheckFilesSection-d029f3a4.js'),
    /already has an import map/,
  );
  assert.throws(
    () => injectNvXkImportMap(LIVE_HTML.replace(LIVE_ENTRY, 'index-C9QrEEkl.js'), 'CheckFilesSection-d029f3a4.js'),
    /lost the current DyoF entry script/,
  );
  assert.throws(
    () => injectNvXkImportMap(LIVE_HTML.replace('ChecksOps', 'index-C9QrEEkl.js'), 'CheckFilesSection-d029f3a4.js'),
    /retired C9Qr\/BJZ/,
  );
  const failed = Object.entries(htmlInvariants(LIVE_HTML, 'CheckFilesSection-d029f3a4.js'))
    .filter(([, ok]) => !ok)
    .map(([key]) => key);
  assert.deepEqual(failed.sort(), ['has_importmap', 'remaps_nvxk']);
});

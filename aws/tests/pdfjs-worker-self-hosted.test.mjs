/**
 * The pdf.js worker is bundled with the SPA (2026-10-30, ops/security/SPA_CSP_ROLLOUT.md decision 3):
 * no source file loads it, or anything else, from unpkg.com, and FieldPlacementEditor.tsx takes the
 * worker from react-pdf's own pdfjs-dist, the copy whose API react-pdf runs, so the two versions
 * cannot drift apart.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const EDITOR = 'src/components/claim-detail/FieldPlacementEditor.tsx';
const WORKER_SPECIFIER = 'react-pdf/node_modules/pdfjs-dist/build/pdf.worker.min.mjs?url';

const sourceFiles = (dir) => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
  const rel = path.posix.join(dir, entry.name);
  if (entry.isDirectory()) return sourceFiles(rel);
  return /\.(ts|tsx|js|jsx|mjs|css|html)$/.test(entry.name) ? [rel] : [];
});

test('no SPA source file references unpkg.com', () => {
  const files = [...sourceFiles('src'), 'index.html'];
  assert.ok(files.includes(EDITOR));
  assert.deepEqual(files.filter((rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').includes('unpkg')), []);
});

test('the worker URL is the bundled asset of react-pdf\'s pdfjs-dist', () => {
  const editor = fs.readFileSync(path.join(ROOT, EDITOR), 'utf8');
  assert.ok(editor.includes(`import pdfWorkerUrl from "${WORKER_SPECIFIER}";`));
  assert.match(editor, /pdfjs\.GlobalWorkerOptions\.workerSrc = pdfWorkerUrl;/);
  assert.equal((editor.match(/workerSrc\s*=/g) || []).length, 1);
});

test('the lockfile installs react-pdf\'s pdfjs-dist at the version react-pdf asks for, worker included', () => {
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8')).packages;
  const reactPdf = lock['node_modules/react-pdf'];
  const nested = lock['node_modules/react-pdf/node_modules/pdfjs-dist'];
  assert.ok(nested, 'react-pdf/node_modules/pdfjs-dist is not in package-lock.json');
  assert.equal(nested.version, reactPdf.dependencies['pdfjs-dist']);
  const installed = path.join(ROOT, 'node_modules/react-pdf/node_modules/pdfjs-dist');
  if (fs.existsSync(installed)) {
    assert.equal(JSON.parse(fs.readFileSync(path.join(installed, 'package.json'), 'utf8')).version, nested.version);
    assert.ok(fs.existsSync(path.join(installed, 'build/pdf.worker.min.mjs')));
  }
});

test('both SPA uploaders give the .mjs worker a JavaScript content type', () => {
  // Without it S3 serves binary/octet-stream and the browser refuses the module worker.
  const production = fs.readFileSync(path.join(ROOT, 'scripts/deployment-guard/lib/production-spa-upload.mjs'), 'utf8');
  assert.match(production, /if \(key\.endsWith\('\.js'\) \|\| key\.endsWith\('\.mjs'\)\) return 'application\/javascript';/);
  const staging = fs.readFileSync(path.join(ROOT, 'scripts/deployment-guard/staging-spa-upload.mjs'), 'utf8');
  assert.match(staging, /const contentType = key\.endsWith\('\.js'\) \|\| key\.endsWith\('\.mjs'\)\n\s*\? 'application\/javascript'/);
});

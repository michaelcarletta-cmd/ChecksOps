/**
 * Security floor for the PDF and DOCX dependencies (2026-11-02).
 *
 * - pdfjs-dist 4.10.38: earlier 4.x versions take canvas 2.x as an optional dependency, which pulls in
 *   @mapbox/node-pre-gyp and tar 6 (npm audit: one critical, three high). 4.10.38 uses @napi-rs/canvas.
 *   The SPA does not import the top-level pdfjs-dist; FieldPlacementEditor.tsx runs react-pdf's own copy
 *   (see pdfjs-worker-self-hosted.test.mjs), so this bump does not change what the browser runs.
 * - @xmldom/xmldom 0.8.15: mammoth (DOCX upload preview) parses document XML with it. 0.8.11 is inside
 *   the ranges of the 0.8.x parser and serializer advisories fixed up to 0.8.15.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(path.join(ROOT, 'package.json'));

const PDFJS_FLOOR = '4.10.38';
const XMLDOM_FLOOR = '0.8.15';

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const npmLock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8')).packages;
const bunLock = fs.readFileSync(path.join(ROOT, 'bun.lock'), 'utf8');

const cmp = (a, b) => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
};
// Every version bun.lock records for a package name, nested entries included.
const bunVersions = (name) => [...bunLock.matchAll(new RegExp(`\\["${name.replace(/[/@.]/g, '\\$&')}@([0-9][^"]*)"`, 'g'))].map((m) => m[1]);
const npmVersions = (name) => Object.entries(npmLock)
  .filter(([key]) => key === `node_modules/${name}` || key.endsWith(`/node_modules/${name}`))
  .map(([, value]) => value.version);

test('package.json pins pdfjs-dist at the patched version', () => {
  assert.equal(pkg.dependencies['pdfjs-dist'], PDFJS_FLOOR);
});

test('both lockfiles install the top-level pdfjs-dist at the patched version, without canvas 2', () => {
  assert.equal(npmLock['node_modules/pdfjs-dist'].version, PDFJS_FLOOR);
  assert.match(bunLock, new RegExp(`"pdfjs-dist": \\["pdfjs-dist@${PDFJS_FLOOR.replace(/\./g, '\\.')}"`));
  assert.equal(npmLock['node_modules/pdfjs-dist'].optionalDependencies?.canvas, undefined);
});

test('neither lockfile carries the canvas 2 / node-pre-gyp / tar 6 chain', () => {
  for (const version of [...npmVersions('canvas'), ...bunVersions('canvas')]) {
    assert.ok(cmp(version, '3.0.0') >= 0, `canvas ${version} is the 2.x line that pulls node-pre-gyp and tar`);
  }
  assert.deepEqual(npmVersions('@mapbox/node-pre-gyp'), []);
  assert.deepEqual(bunVersions('@mapbox/node-pre-gyp'), []);
  assert.deepEqual(npmVersions('tar'), []);
  assert.deepEqual(bunVersions('tar'), []);
});

test('every @xmldom/xmldom in both lockfiles is at or above the patched 0.8 release', () => {
  const versions = [...npmVersions('@xmldom/xmldom'), ...bunVersions('@xmldom/xmldom')];
  assert.ok(versions.length >= 2, 'expected @xmldom/xmldom in both lockfiles');
  for (const version of versions) assert.ok(cmp(version, XMLDOM_FLOOR) >= 0, `@xmldom/xmldom ${version} < ${XMLDOM_FLOOR}`);
  // The patched release is still inside mammoth's own range, so mammoth itself is unchanged.
  assert.equal(npmLock['node_modules/mammoth'].dependencies['@xmldom/xmldom'], '^0.8.6');
});

const installed = (name) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', name, 'package.json'), 'utf8')).version;
  } catch {
    return null;
  }
};

test('mammoth converts a DOCX with the patched xmldom and escapes markup in document text', {
  skip: installed('mammoth') && installed('jszip') ? false : 'mammoth or jszip is not installed',
}, async () => {
  assert.ok(cmp(installed('@xmldom/xmldom'), XMLDOM_FLOOR) >= 0);
  const JSZip = require('jszip');
  const mammoth = require('mammoth');
  const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?>'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    + '</Types>');
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
    + '</Relationships>');
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="${W}"><w:body>`
    + '<w:p><w:r><w:t>Direction to Pay</w:t></w:r></w:p>'
    + '<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Signed</w:t></w:r></w:p>'
    + '<w:p><w:r><w:t>&lt;img src=x onerror=alert(1)&gt;</w:t></w:r></w:p>'
    + '</w:body></w:document>');
  const buffer = await zip.generateAsync({ type: 'nodebuffer' });
  const { value: html } = await mammoth.convertToHtml({ buffer });
  assert.equal(html, '<p>Direction to Pay</p><p><strong>Signed</strong></p><p>&lt;img src=x onerror=alert(1)&gt;</p>');
});

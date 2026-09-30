import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import {
  EXPECTED_SIGN_SHA256,
  LIVE_IFRAME_STYLE,
  patchSignMobilePreview,
  resolveSignPreviewHeightPx,
  signPreviewFrameStyle,
  signPreviewInvariants,
} from '../scripts/lib/sig-mobile-sign-preview-patch.mjs';

const require = createRequire(import.meta.url);
const acorn = require('acorn');

const FIXTURE = new URL('./fixtures/current-live-Sign-DfWZrlqT.js', import.meta.url);
const SIGN_SRC = new URL('../src/pages/Sign.tsx', import.meta.url);
const live = readFileSync(FIXTURE, 'utf8');
const signTsx = readFileSync(SIGN_SRC, 'utf8');

test('fixture is the owned live Sign-DfWZrlqT.js pin', () => {
  const sha = createHash('sha256').update(live).digest('hex');
  assert.equal(sha, EXPECTED_SIGN_SHA256);
  assert.match(live, /from"\.\/index-C9QrEEkl\.js"/);
  assert.ok(live.includes(LIVE_IFRAME_STYLE));
});

test('desktop style stays 70vh with the 400px floor', () => {
  assert.deepEqual(signPreviewFrameStyle(false), { height: '70vh', minHeight: '400px' });
  assert.equal(resolveSignPreviewHeightPx(false, 1280, 800), 560);
  assert.equal(resolveSignPreviewHeightPx(false, 1024, 500), 400);
});

test('narrow 375 and 390 follow container width and drop the 400px floor', () => {
  const style = signPreviewFrameStyle(true);
  assert.equal(style.width, '100%');
  assert.equal(style.height, 'max(90dvh, 160vw)');
  assert.equal(style.minHeight, 0);
  assert.notEqual(style.height, '70vh');

  const h375 = resolveSignPreviewHeightPx(true, 375, 667);
  const h390 = resolveSignPreviewHeightPx(true, 390, 844);
  assert.equal(h375, Math.max(667 * 0.9, 375 * 1.6));
  assert.equal(h390, Math.max(844 * 0.9, 390 * 1.6));
  assert.ok(h375 > 400);
  assert.ok(h390 > 400);
  assert.ok(375 / h375 < 375 / 400, '375 box must be taller-aspect than the 400px floor');
  assert.ok(390 / h390 < 390 / 400, '390 box must be taller-aspect than the 400px floor');
});

test('does not encode 612x792 as a universal page size', () => {
  const src = JSON.stringify(signPreviewFrameStyle(true)) + JSON.stringify(signPreviewFrameStyle(false));
  assert.equal(src.includes('612'), false);
  assert.equal(src.includes('792'), false);
  assert.equal(signTsx.includes('612'), false);
  assert.equal(signTsx.includes('792'), false);
});

test('Sign.tsx review iframe uses the helper and keeps submit/canvas payload', () => {
  assert.match(signTsx, /style=\{signPreviewFrameStyle\(narrowPreview\)\}/);
  assert.match(signTsx, /overflow-auto/);
  assert.doesNotMatch(signTsx, /style=\{\{ height: "70vh", minHeight: "400px" \}\}/);
  assert.match(signTsx, /canvas\.toDataURL\(\)/);
  assert.match(signTsx, /publicWorkflowRequest\("submit-signature"\)/);
  assert.match(signTsx, /width=\{400\}/);
  assert.match(signTsx, /height=\{150\}/);
  assert.doesNotMatch(signTsx, /react-pdf/);
});

test('in-place overlay keeps C9Qr imports and signing payload', () => {
  const patched = patchSignMobilePreview(live);
  acorn.parse(patched, { ecmaVersion: 'latest', sourceType: 'module' });
  const inv = signPreviewInvariants(patched);
  for (const [key, ok] of Object.entries(inv)) {
    assert.equal(ok, true, key);
  }
  assert.match(patched, /l\.toDataURL\(\)/);
  assert.match(patched, /"submit-signature"/);
  assert.match(patched, /width:400,height:150/);
  assert.doesNotMatch(patched, /style:\{height:"70vh",minHeight:"400px"\}/);
});

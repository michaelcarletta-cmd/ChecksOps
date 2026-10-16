/**
 * Recreated from Cursor 4b5a82185 (tests/sig-mobile-sign-preview.test.mjs). The
 * live-bundle fixture and in-place overlay checks are dropped: the fix now lives
 * in source (src/lib/signPreviewFrame.ts + src/pages/Sign.tsx).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  SIGN_PREVIEW_NARROW_MQ,
  resolveSignPreviewHeightPx,
  signPreviewFrameStyle,
} from "../src/lib/signPreviewFrame.ts";

const signTsx = readFileSync(new URL("../src/pages/Sign.tsx", import.meta.url), "utf8");

test("desktop style stays 70vh with the 400px floor", () => {
  assert.deepEqual(signPreviewFrameStyle(false), { height: "70vh", minHeight: "400px" });
  assert.equal(resolveSignPreviewHeightPx(false, 1280, 800), 560);
  assert.equal(resolveSignPreviewHeightPx(false, 1024, 500), 400);
});

test("narrow 375 and 390 follow container width and drop the 400px floor", () => {
  const style = signPreviewFrameStyle(true);
  assert.equal(style.width, "100%");
  assert.equal(style.height, "max(90dvh, 160vw)");
  assert.equal(style.minHeight, 0);
  assert.notEqual(style.height, "70vh");

  const h375 = resolveSignPreviewHeightPx(true, 375, 667);
  const h390 = resolveSignPreviewHeightPx(true, 390, 844);
  assert.equal(h375, Math.max(667 * 0.9, 375 * 1.6));
  assert.equal(h390, Math.max(844 * 0.9, 390 * 1.6));
  assert.ok(375 / h375 < 375 / 400, "375 box must be taller-aspect than the 400px floor");
  assert.ok(390 / h390 < 390 / 400, "390 box must be taller-aspect than the 400px floor");
  assert.equal(SIGN_PREVIEW_NARROW_MQ, "(max-width: 767px)");
});

test("does not encode 612x792 as a universal page size", () => {
  const src = JSON.stringify(signPreviewFrameStyle(true)) + JSON.stringify(signPreviewFrameStyle(false));
  assert.equal(src.includes("612"), false);
  assert.equal(src.includes("792"), false);
  assert.equal(signTsx.includes("612"), false);
  assert.equal(signTsx.includes("792"), false);
});

test("Sign.tsx review iframe uses the helper and keeps submit/canvas payload", () => {
  assert.match(signTsx, /style=\{signPreviewFrameStyle\(narrowPreview\)\}/);
  assert.match(signTsx, /rounded-lg overflow-auto shadow-sm/);
  assert.doesNotMatch(signTsx, /style=\{\{ height: "70vh", minHeight: "400px" \}\}/);
  assert.match(signTsx, /canvas\.toDataURL\(\)/);
  assert.match(signTsx, /publicWorkflowRequest\("submit-signature"\)/);
  assert.match(signTsx, /width=\{400\}/);
  assert.match(signTsx, /height=\{150\}/);
  assert.doesNotMatch(signTsx, /react-pdf/);
});

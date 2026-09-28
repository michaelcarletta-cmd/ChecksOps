import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  DESKTOP_COMPOSER_PAGE_WIDTH,
  clientPointToPercent,
  clampPercentField,
  defaultFieldSizePercent,
  displayPageWidth,
  looksLikePercentField,
  pdfPointFromPercent,
  pixelsToPercent,
  toPersistedPercentField,
} from "../src/lib/signature-field-coordinates.ts";

const LETTER_ASPECT = 11 / 8.5;
const PDF_LETTER_WIDTH = 612;
const PDF_LETTER_HEIGHT = 792;

const overlayAt = (width: number) => ({
  left: 12,
  top: 40,
  width,
  height: width * LETTER_ASPECT,
});

test("display width caps at the desktop composer canvas and shrinks on phones", () => {
  assert.equal(displayPageWidth(800), DESKTOP_COMPOSER_PAGE_WIDTH);
  assert.equal(displayPageWidth(600), 600);
  assert.equal(displayPageWidth(320), 320);
  assert.equal(displayPageWidth(0), DESKTOP_COMPOSER_PAGE_WIDTH);
});

test("the same visual page location stores the same percentages on mobile and desktop", () => {
  const mobile = overlayAt(320);
  const desktop = overlayAt(600);
  const mobileClick = clientPointToPercent(
    mobile.left + mobile.width * 0.25,
    mobile.top + mobile.height * 0.4,
    mobile,
  );
  const desktopClick = clientPointToPercent(
    desktop.left + desktop.width * 0.25,
    desktop.top + desktop.height * 0.4,
    desktop,
  );
  assert.deepEqual(mobileClick, { x: 25, y: 40 });
  assert.deepEqual(desktopClick, mobileClick);
});

test("default field sizes stay page-relative instead of viewport pixels", () => {
  const mobile = defaultFieldSizePercent("signature", 320, 320 * LETTER_ASPECT);
  const desktop = defaultFieldSizePercent("signature", 600, 600 * LETTER_ASPECT);
  assert.deepEqual(mobile, desktop);
  assert.equal(mobile.width, 25);
  assert.ok(mobile.height < 10);
  const date = defaultFieldSizePercent("date", 320, 320 * LETTER_ASPECT);
  const text = defaultFieldSizePercent("text", 390, 390 * LETTER_ASPECT);
  const checkbox = defaultFieldSizePercent("checkbox", 280, 280 * LETTER_ASPECT);
  assert.deepEqual(date, defaultFieldSizePercent("date", 600, 600 * LETTER_ASPECT));
  assert.deepEqual(text, defaultFieldSizePercent("text", 600, 600 * LETTER_ASPECT));
  assert.deepEqual(checkbox, defaultFieldSizePercent("checkbox", 600, 600 * LETTER_ASPECT));
});

test("reopening a mobile-placed field at desktop width keeps the same PDF point", () => {
  const mobile = overlayAt(320);
  const placed = toPersistedPercentField({
    id: "signature-1",
    type: "signature",
    ...clientPointToPercent(mobile.left + mobile.width * 0.18, mobile.top + mobile.height * 0.72, mobile),
    ...defaultFieldSizePercent("signature", mobile.width, mobile.height),
  });
  const desktopLeft = (placed.x / 100) * 600;
  const desktopTop = (placed.y / 100) * (600 * LETTER_ASPECT);
  assert.equal(roundish(desktopLeft / 600 * 100), placed.x);
  assert.equal(roundish(desktopTop / (600 * LETTER_ASPECT) * 100), placed.y);
  assert.equal(pdfPointFromPercent(placed.x, PDF_LETTER_WIDTH), (placed.x / 100) * PDF_LETTER_WIDTH);
  assert.equal(pdfPointFromPercent(placed.y, PDF_LETTER_HEIGHT), (placed.y / 100) * PDF_LETTER_HEIGHT);
});

test("legacy pixel fields convert through the overlay, percent fields pass through", () => {
  assert.equal(looksLikePercentField({ x: 18, y: 72, width: 25, height: 6.4 }), true);
  assert.equal(looksLikePercentField({ x: 150, y: 400, width: 150, height: 50 }), false);
  const converted = pixelsToPercent({ x: 150, y: 400, width: 150, height: 50 }, 600, 800);
  assert.deepEqual(converted, { x: 25, y: 50, width: 25, height: 6.25 });
  const already = toPersistedPercentField({ x: 18.12345, y: 72, width: 25, height: 6.4 });
  assert.equal(already.x, 18.1234);
  assert.equal(already.y, 72);
});

test("clamping keeps a dragged field on the page", () => {
  const moved = clampPercentField({ x: 95, y: -4, width: 25, height: 8 });
  assert.equal(moved.x, 75);
  assert.equal(moved.y, 0);
});

test("composer uses display scale and percent internals without changing /sign or selector", () => {
  const editor = readFileSync("src/components/claim-detail/FieldPlacementEditor.tsx", "utf8");
  const wizard = readFileSync("src/components/claim-detail/SignatureRequests.tsx", "utf8");
  const sign = readFileSync("src/pages/Sign.tsx", "utf8");
  assert.match(editor, /displayPageWidth/);
  assert.match(editor, /clientPointToPercent/);
  assert.match(editor, /toPersistedPercentField/);
  assert.match(editor, /grid-cols-2/);
  assert.match(editor, /onPointerDown/);
  assert.match(editor, /pointermove/);
  assert.doesNotMatch(editor, /width=\{600\}/);
  assert.match(editor, /left: `\$\{field\.x\}%`/);
  assert.match(wizard, /overflow-x-hidden/);
  assert.match(wizard, /Select a file from claim\/check files/);
  assert.match(wizard, /mergeClaimAndCheckSignatureFiles/);
  assert.doesNotMatch(wizard, /file_name\.ilike\.%\.pdf/);
  assert.match(sign, /data\.fields && data\.fields\.length > 0/);
  assert.match(sign, /x: f\.x/);
});

function roundish(value: number) {
  return parseFloat(value.toFixed(4));
}

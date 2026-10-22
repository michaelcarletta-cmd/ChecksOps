import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SRC = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../src/components/checks/CheckImageCropper.tsx'), 'utf8');

test('crop handles are touch-sized, whole edges resize, and the box follows the image size', () => {
  // 40 px corner hit areas and 24 px grab strips along the full edges (was 12 px squares at the midpoints).
  assert.match(SRC, /const CORNER_HIT = 40;/);
  assert.match(SRC, /const EDGE_HIT = 24;/);
  assert.match(SRC, /left: inset, right: inset, height: EDGE_HIT/);
  assert.match(SRC, /top: inset, bottom: inset, width: EDGE_HIT/);
  assert.equal(/const s = 12;/.test(SRC), false);
  // Corners sit above edges, edges above the move area.
  assert.match(SRC, /absolute z-20 flex items-center justify-center/);
  assert.match(SRC, /absolute z-10 flex items-center justify-center/);
  // Padding around the image so handles at the image edge are never clipped.
  assert.match(SRC, /relative mx-auto w-fit p-6/);
  assert.equal(/flex items-center justify-center touch-none/.test(SRC), false);
  // The crop box is recomputed when the displayed image is resized.
  assert.match(SRC, /new ResizeObserver\(/);
  assert.match(SRC, /Drag inside the box to move it\. Drag a corner or any edge to resize it\./);
});

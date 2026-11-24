/**
 * Owner 2026-11-24: on an old check (uploaded in the Cursor / Lovable era), Generate Deposit
 * Image failed with "check not found or not writable". The production count (#2060, SSM
 * 5215ffed-9da5-4ef1-be06-301660e6a4ca) found 25 not-deposited checks whose original back photo
 * lives under checks/<uploader user id>/. The deposit image was written next to it, which both
 * the storage write gate and the check update refuse. It now goes into the check's own folder.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  depositImagePathForCheck,
  depositImagePersistPatch,
  isGeneratedBackArtifactPath,
} from '../../src/lib/checkImageInvariants.ts';
import {
  isCheckScopedPathFor,
  matchCheckScopedPath,
  normalizePath,
} from '../functions/api/storage-paths.mjs';

const CHECK = '0f8fad5b-d9cb-469f-a165-70867728950e';
const UPLOADER = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

const acceptedByServer = (path) => {
  const rel = normalizePath(path, 'claim-files');
  return Boolean(rel) && isCheckScopedPathFor(rel, CHECK);
};

test('an old upload under the uploader folder: deposit image goes to the check folder and the server gates accept it', () => {
  const original = `checks/${UPLOADER}/claim-123/back.jpg`;
  // The old behavior wrote next to the original: refused (the uuid is not a check).
  const oldPath = `checks/${UPLOADER}/claim-123/endorsed_deposit_abc.checkalt.jpg`;
  assert.equal(matchCheckScopedPath(normalizePath(oldPath, 'claim-files')), UPLOADER);
  assert.equal(acceptedByServer(oldPath), false);

  const path = depositImagePathForCheck(CHECK, original, 'abc');
  assert.equal(path, `checks/${CHECK}/endorsed_deposit_abc.checkalt.jpg`);
  assert.equal(acceptedByServer(path), true);
  assert.equal(isGeneratedBackArtifactPath(path), true);
  const patch = depositImagePersistPatch(path, original);
  assert.equal(patch.back_image_deposit_path, path);
  assert.equal(patch.endorsement_render_meta.original_back_image_path, original);
});

test('a current upload already in the check folder keeps writing next to the original', () => {
  for (const folder of [`checks/${CHECK}`, `checks/${CHECK}/sub`, `checks/reupload/${CHECK}`, `check-intake/${CHECK}/files`]) {
    const path = depositImagePathForCheck(CHECK, `${folder}/back-1.jpg`, 'x1');
    assert.equal(path, `${folder}/endorsed_deposit_x1.checkalt.jpg`);
    assert.equal(acceptedByServer(path), true);
  }
});

test('uppercase check ids, a bare file name and other layouts all land in the check folder', () => {
  assert.equal(
    depositImagePathForCheck(CHECK.toUpperCase(), 'back.jpg', 'z'),
    `checks/${CHECK}/endorsed_deposit_z.checkalt.jpg`,
  );
  for (const original of ['uploads/back.png', `checks/${CHECK}x/back.jpg`, `tenants/${CHECK}/back.jpg`]) {
    const path = depositImagePathForCheck(CHECK, original, 'z');
    assert.equal(path, `checks/${CHECK}/endorsed_deposit_z.checkalt.jpg`);
    assert.equal(acceptedByServer(path), true);
  }
});

test('a bad check id or version is refused instead of writing a stray path', () => {
  assert.throws(() => depositImagePathForCheck('not-a-uuid', 'checks/a/b.jpg', 'v'));
  assert.throws(() => depositImagePathForCheck(CHECK, 'b.jpg', '../x'));
});

test('the adjuster uses the helper, not the original photo folder', () => {
  const src = readFileSync(new URL('../../src/components/checks/EndorsementAdjuster.tsx', import.meta.url), 'utf8');
  assert.match(src, /depositImagePathForCheck\(checkId, originalImagePath, version\)/);
  assert.doesNotMatch(src, /originalImagePath\.replace\(/);
});

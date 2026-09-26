import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CLEAN_ORIGINAL_AMBIGUOUS_MESSAGE,
  CLEAN_ORIGINAL_MISSING_MESSAGE,
  CLEAN_STEM_EXTENSIONS,
  assertCleanBackOriginalPath,
  collectEndorsedCleanStemCandidates,
  depositImagePersistPatch,
  endorsedGeneratedStem,
  extractMetaOriginals,
  isExactCleanStemOfGeneratedPointer,
  isGeneratedBackArtifactPath,
  isRecognizedEndorsedGeneratedPath,
  recoverCleanBackOriginalPath,
  resolveCleanBackOriginalPath,
} from '../../src/lib/checkImageInvariants.ts';
import {
  CLEAN_STEM_EXTENSIONS as LAMBDA_STEM_EXTS,
  endorsedGeneratedStem as lambdaEndorsedGeneratedStem,
  isExactCleanStemOfGeneratedPointer as lambdaIsExactCleanStem,
} from '../functions/api/storage-paths.mjs';

const CLEAN = 'checks/x/back.jpg';
const FRONT = 'checks/x/front.jpg';
const CHECKALT = 'checks/x/back.checkalt.jpg';
const DEPOSIT_A = 'checks/x/endorsed_deposit_aaa.checkalt.jpg';
const DEPOSIT_B = 'checks/x/endorsed_deposit_bbb.checkalt.jpg';
const ENDORSED = 'checks/x/back_endorsed.jpg';

test('isGeneratedBackArtifactPath matches endorsed and checkalt artifacts', () => {
  assert.equal(isGeneratedBackArtifactPath(null), false);
  assert.equal(isGeneratedBackArtifactPath(''), false);
  assert.equal(isGeneratedBackArtifactPath('checks/x/back.jpg'), false);
  assert.equal(isGeneratedBackArtifactPath('legacy checks/x/back.jpeg'), false);

  assert.equal(isGeneratedBackArtifactPath('checks/x/back.svg'), true);
  assert.equal(isGeneratedBackArtifactPath('checks/x/back.svg?token=abc'), true);
  assert.equal(isGeneratedBackArtifactPath('checks/x/back.checkalt.jpg'), true);
  assert.equal(isGeneratedBackArtifactPath('checks/x/endorsed_deposit_abc.checkalt.jpg'), true);
  assert.equal(isGeneratedBackArtifactPath('checks/x/back_endorsed.jpg'), true);
});

test('assertCleanBackOriginalPath rejects generated artifacts and missing paths', () => {
  assert.throws(() => assertCleanBackOriginalPath(null), /missing/i);
  assert.throws(() => assertCleanBackOriginalPath('checks/x/endorsed_deposit_abc.checkalt.jpg'), /generated artifact/i);
  assert.throws(() => assertCleanBackOriginalPath('checks/x/back.checkalt.jpg'), /generated artifact/i);
  assert.equal(assertCleanBackOriginalPath('checks/x/back.jpg'), 'checks/x/back.jpg');
});

test('valid clean original is accepted without recovery side paths', () => {
  const result = recoverCleanBackOriginalPath({
    record: {
      back_image_original_path: CLEAN,
      back_image_path: DEPOSIT_A,
      back_image_deposit_path: DEPOSIT_A,
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.path, CLEAN);
  assert.equal(result.source, 'original');
  assert.equal(assertCleanBackOriginalPath(result.path), CLEAN);
});

test('.checkalt.jpg remains prohibited as an original', () => {
  assert.equal(isGeneratedBackArtifactPath(CHECKALT), true);
  assert.throws(() => assertCleanBackOriginalPath(CHECKALT), /generated artifact/i);
  const result = recoverCleanBackOriginalPath({
    record: {
      back_image_original_path: CHECKALT,
      back_image_path: CHECKALT,
      back_image_deposit_path: DEPOSIT_A,
    },
    siblingNames: ['back.checkalt.jpg', 'endorsed_deposit_aaa.checkalt.jpg'],
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'missing');
});

test('missing or generated original recovers a proven clean original from meta', () => {
  const result = recoverCleanBackOriginalPath({
    record: {
      back_image_original_path: CHECKALT,
      back_image_path: DEPOSIT_A,
      back_image_deposit_path: DEPOSIT_A,
      endorsement_render_meta: { original_back_image_path: CLEAN },
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.path, CLEAN);
  assert.equal(result.source, 'meta');
});

test('missing original recovers a proven clean original from audit history', () => {
  const result = recoverCleanBackOriginalPath({
    record: {
      back_image_original_path: DEPOSIT_A,
      back_image_path: DEPOSIT_A,
      back_image_deposit_path: DEPOSIT_A,
    },
    audits: [{
      original_back_image_path: CLEAN,
      endorsed_back_image_path: DEPOSIT_A,
    }],
  });
  assert.equal(result.ok, true);
  assert.equal(result.path, CLEAN);
  assert.equal(result.source, 'audit');
});

test('generated deposit artifact is never selected as a recovery source', () => {
  const result = recoverCleanBackOriginalPath({
    record: {
      back_image_original_path: DEPOSIT_A,
      back_image_path: DEPOSIT_A,
      back_image_deposit_path: DEPOSIT_A,
      endorsement_render_meta: { original_back_image_path: DEPOSIT_B },
    },
    audits: [{
      original_back_image_path: DEPOSIT_A,
      original_back_path: DEPOSIT_B,
      endorsed_back_image_path: DEPOSIT_A,
    }],
    siblingNames: ['endorsed_deposit_aaa.checkalt.jpg', 'endorsed_deposit_bbb.checkalt.jpg', 'back.checkalt.jpg'],
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'missing');
  assert.equal(result.message, CLEAN_ORIGINAL_MISSING_MESSAGE);
});

test('unique clean sibling recovers when pointers are generated', () => {
  const result = recoverCleanBackOriginalPath({
    record: {
      back_image_original_path: DEPOSIT_A,
      back_image_path: DEPOSIT_A,
      back_image_deposit_path: DEPOSIT_A,
    },
    audits: [],
    siblingNames: ['front.jpg', 'back.jpg', 'endorsed_deposit_aaa.checkalt.jpg'],
  });
  assert.equal(result.ok, true);
  assert.equal(result.path, CLEAN);
  assert.equal(result.source, 'sibling');
});

test('ambiguous multiple clean candidates fail closed', () => {
  const result = recoverCleanBackOriginalPath({
    record: {
      back_image_original_path: DEPOSIT_A,
      back_image_path: DEPOSIT_A,
      back_image_deposit_path: DEPOSIT_A,
    },
    audits: [],
    siblingNames: ['back.jpg', 'scan.jpg', 'endorsed_deposit_aaa.checkalt.jpg'],
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'ambiguous');
  assert.equal(result.message, CLEAN_ORIGINAL_AMBIGUOUS_MESSAGE);
});

test('missing clean original fails clearly', () => {
  const result = recoverCleanBackOriginalPath({
    record: {
      back_image_original_path: null,
      back_image_path: null,
      back_image_deposit_path: DEPOSIT_A,
    },
    audits: [],
    siblingNames: ['endorsed_deposit_aaa.checkalt.jpg'],
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'missing');
  assert.equal(result.message, CLEAN_ORIGINAL_MISSING_MESSAGE);
});

test('generating a deposit image does not overwrite the clean-original pointer', () => {
  const patch = depositImagePersistPatch(DEPOSIT_A, CLEAN, { request_id: 'req-1' });
  assert.equal(patch.back_image_deposit_path, DEPOSIT_A);
  assert.equal(patch.endorsement_render_meta.original_back_image_path, CLEAN);
  assert.equal(Object.prototype.hasOwnProperty.call(patch, 'back_image_original_path'), false);
  assert.throws(
    () => depositImagePersistPatch(CLEAN, CLEAN),
    /generated artifact/i,
  );
  assert.throws(
    () => depositImagePersistPatch(DEPOSIT_A, CHECKALT),
    /generated artifact/i,
  );
});

test('repeated generation always starts from the clean original', () => {
  const afterFirst = {
    back_image_original_path: CLEAN,
    back_image_path: CLEAN,
    back_image_deposit_path: DEPOSIT_A,
    endorsement_render_meta: { original_back_image_path: CLEAN },
  };
  const first = recoverCleanBackOriginalPath({ record: afterFirst });
  assert.equal(first.ok, true);
  assert.equal(first.path, CLEAN);

  const afterSecond = {
    ...afterFirst,
    back_image_deposit_path: DEPOSIT_B,
    back_image_path: DEPOSIT_A,
  };
  const second = recoverCleanBackOriginalPath({ record: afterSecond });
  assert.equal(second.ok, true);
  assert.equal(second.path, CLEAN);
  assert.notEqual(second.path, DEPOSIT_A);
  assert.notEqual(second.path, DEPOSIT_B);
});

test('existing endorsement recovery still prefers a clean current pointer', () => {
  const result = recoverCleanBackOriginalPath({
    record: {
      back_image_original_path: ENDORSED,
      back_image_path: CLEAN,
      back_image_deposit_path: DEPOSIT_A,
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.path, CLEAN);
  assert.equal(result.source, 'current');
});

test('resolveCleanBackOriginalPath loads audit then sibling only when needed', async () => {
  let auditLoads = 0;
  let siblingLoads = 0;
  const recovered = await resolveCleanBackOriginalPath({
    record: {
      back_image_original_path: DEPOSIT_A,
      back_image_path: DEPOSIT_A,
      back_image_deposit_path: DEPOSIT_A,
    },
    loadAudits: async () => {
      auditLoads += 1;
      return [];
    },
    loadSiblingNames: async (directory) => {
      siblingLoads += 1;
      assert.equal(directory, 'checks/x');
      return ['back.jpg', FRONT.split('/').pop()];
    },
  });
  assert.equal(recovered.path, CLEAN);
  assert.equal(recovered.source, 'sibling');
  assert.equal(auditLoads, 1);
  assert.equal(siblingLoads, 1);

  const skipped = await resolveCleanBackOriginalPath({
    record: { back_image_original_path: CLEAN },
    loadAudits: async () => {
      auditLoads += 1;
      return [];
    },
    loadSiblingNames: async () => {
      siblingLoads += 1;
      return [];
    },
  });
  assert.equal(skipped.source, 'original');
  assert.equal(auditLoads, 1);
  assert.equal(siblingLoads, 1);
});

test('endorsed _endorsed_*.svg reconstructs exact clean .jpg/.jpeg/.png stems', () => {
  const folder = 'checks/7dbb3009-f059-4767-b5dc-1c5c72379330/unclaimed';
  const generated = `${folder}/1788459753367_back_IMG_1190_cropped_endorsed_1790258244171.svg`;
  const derived = endorsedGeneratedStem(generated);
  assert.equal(derived.directory, folder);
  assert.equal(derived.stem, '1788459753367_back_IMG_1190_cropped');
  assert.deepEqual(derived.candidates, [
    `${folder}/1788459753367_back_IMG_1190_cropped.jpg`,
    `${folder}/1788459753367_back_IMG_1190_cropped.jpeg`,
    `${folder}/1788459753367_back_IMG_1190_cropped.png`,
  ]);
  assert.equal(isExactCleanStemOfGeneratedPointer(`${folder}/1788459753367_back_IMG_1190_cropped.jpg`, generated), true);
  assert.equal(isExactCleanStemOfGeneratedPointer(`${folder}/other.jpg`, generated), false);
  assert.deepEqual(CLEAN_STEM_EXTENSIONS, ['.jpg', '.jpeg', '.png']);
});

test('endorsed stem recovery accepts .jpg when that exact object is proven', () => {
  const folder = 'checks/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/unclaimed';
  const generated = `${folder}/1788459753367_back_IMG_1190_cropped_endorsed_1790258244171.svg`;
  const clean = `${folder}/1788459753367_back_IMG_1190_cropped.jpg`;
  const result = recoverCleanBackOriginalPath({
    record: {
      back_image_original_path: null,
      back_image_path: generated,
      back_image_deposit_path: null,
    },
    existingStemPaths: [clean],
  });
  assert.equal(result.ok, true);
  assert.equal(result.source, 'endorsed_stem');
  assert.equal(result.path, clean);
  assert.equal(assertCleanBackOriginalPath(result.path), clean);
  assert.match(result.path, /aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/);
  assert.equal(result.path.includes('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'), false);
});

test('endorsed stem recovery accepts .jpeg and .png when that exact object is proven', () => {
  const jpeg = recoverCleanBackOriginalPath({
    record: { back_image_path: 'checks/shared/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/back-1781799562017_endorsed_1783956012422.png' },
    existingStemPaths: ['checks/shared/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/back-1781799562017.jpeg'],
  });
  assert.equal(jpeg.ok, true);
  assert.equal(jpeg.path, 'checks/shared/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/back-1781799562017.jpeg');

  const png = recoverCleanBackOriginalPath({
    record: { back_image_path: 'checks/x/scan_endorsed_1.svg' },
    existingStemPaths: ['checks/x/scan.png'],
  });
  assert.equal(png.ok, true);
  assert.equal(png.path, 'checks/x/scan.png');
});

test('nonexistent endorsed stem fails closed', () => {
  const result = recoverCleanBackOriginalPath({
    record: { back_image_path: 'checks/x/1788459753367_back_IMG_1190_cropped_endorsed_1790258244171.svg' },
    existingStemPaths: [],
    siblingNames: [],
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'missing');
});

test('multiple clean stem extensions fail closed as ambiguous', () => {
  const result = recoverCleanBackOriginalPath({
    record: { back_image_path: 'checks/x/scan_endorsed_9.svg' },
    existingStemPaths: ['checks/x/scan.jpg', 'checks/x/scan.jpeg'],
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'ambiguous');
  assert.equal(result.message, CLEAN_ORIGINAL_AMBIGUOUS_MESSAGE);
});

test('endorsed stem recovery never selects .checkalt.jpg or endorsed_deposit_*', () => {
  assert.equal(isRecognizedEndorsedGeneratedPath('checks/x/back.checkalt.jpg'), false);
  assert.equal(isRecognizedEndorsedGeneratedPath('checks/x/endorsed_deposit_aaa.jpg'), false);
  assert.equal(endorsedGeneratedStem('checks/x/endorsed_deposit_aaa.jpg'), null);
  assert.equal(endorsedGeneratedStem('checks/x/back.checkalt.jpg'), null);
  const checkalt = recoverCleanBackOriginalPath({
    record: { back_image_path: 'checks/x/scan_endorsed_1.svg' },
    existingStemPaths: ['checks/x/scan.checkalt.jpg'],
  });
  assert.equal(checkalt.ok, false);
  const deposit = recoverCleanBackOriginalPath({
    record: {
      back_image_original_path: null,
      back_image_path: 'checks/x/endorsed_deposit_aaa.jpg',
      back_image_deposit_path: 'checks/x/endorsed_deposit_aaa.jpg',
    },
    existingStemPaths: ['checks/x/scan.jpg'],
  });
  assert.equal(deposit.ok, false);
  assert.throws(() => assertCleanBackOriginalPath('checks/x/scan.checkalt.jpg'), /generated artifact/i);
  assert.throws(() => assertCleanBackOriginalPath('checks/x/endorsed_deposit_aaa.jpg'), /generated artifact/i);
});

test('unrelated same-directory JPEG is not an endorsed-stem match', () => {
  const probed = recoverCleanBackOriginalPath({
    record: { back_image_path: 'checks/x/scan_endorsed_1.svg' },
    existingStemPaths: ['checks/x/other.jpg'],
    siblingNames: [],
  });
  assert.equal(probed.ok, false);
  const listed = recoverCleanBackOriginalPath({
    record: { back_image_path: 'checks/x/scan_endorsed_1.svg' },
    existingStemPaths: [],
    siblingNames: ['other.jpg', 'scan.jpg', 'front.jpg'],
  });
  assert.equal(listed.ok, true);
  assert.equal(listed.source, 'endorsed_stem');
  assert.equal(listed.path, 'checks/x/scan.jpg');
  assert.notEqual(listed.path, 'checks/x/other.jpg');
});

test('folder UUID is preserved and is not replaced with check UUID', () => {
  const folder = '7dbb3009-f059-4767-b5dc-1c5c72379330';
  const checkId = 'b71c634c-8ec4-4d18-83cd-aff36b726a31';
  const generated = `checks/${folder}/unclaimed/1788459753367_back_IMG_1190_cropped_endorsed_1790258244171.svg`;
  const candidates = collectEndorsedCleanStemCandidates({ back_image_path: generated });
  assert.equal(candidates.length, 3);
  for (const path of candidates) {
    assert.match(path, new RegExp(folder));
    assert.equal(path.includes(checkId), false);
  }
});

test('valid back_image_original_path remains unchanged by stem recovery', () => {
  const result = recoverCleanBackOriginalPath({
    record: {
      back_image_original_path: CLEAN,
      back_image_path: 'checks/x/back_endorsed_1.svg',
      back_image_deposit_path: DEPOSIT_A,
    },
    existingStemPaths: ['checks/x/back.jpg', 'checks/x/other.jpg'],
  });
  assert.equal(result.ok, true);
  assert.equal(result.source, 'original');
  assert.equal(result.path, CLEAN);
});

test('resolveCleanBackOriginalPath probes endorsed stems before listing siblings', async () => {
  let probes = 0;
  let siblingLoads = 0;
  const recovered = await resolveCleanBackOriginalPath({
    record: { back_image_path: 'checks/x/scan_endorsed_1.svg' },
    probeCleanStemPaths: async (candidates) => {
      probes += 1;
      assert.deepEqual(candidates, ['checks/x/scan.jpg', 'checks/x/scan.jpeg', 'checks/x/scan.png']);
      return ['checks/x/scan.jpg'];
    },
    loadSiblingNames: async () => {
      siblingLoads += 1;
      return ['unrelated.jpg'];
    },
  });
  assert.equal(recovered.source, 'endorsed_stem');
  assert.equal(recovered.path, 'checks/x/scan.jpg');
  assert.equal(probes, 1);
  assert.equal(siblingLoads, 0);
});

test('SPA and Lambda endorsed-stem helpers stay in lockstep', () => {
  const generated = 'checks/shared/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/back-1_endorsed_2.png';
  assert.deepEqual(CLEAN_STEM_EXTENSIONS.slice(), LAMBDA_STEM_EXTS.slice());
  assert.deepEqual(endorsedGeneratedStem(generated), lambdaEndorsedGeneratedStem(generated));
  assert.equal(
    isExactCleanStemOfGeneratedPointer('checks/shared/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/back-1.jpeg', generated),
    lambdaIsExactCleanStem('checks/shared/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/back-1.jpeg', generated),
  );
});

test('extractMetaOriginals reads established original_back_* keys', () => {
  assert.deepEqual(
    extractMetaOriginals({ original_back_image_path: CLEAN, nested: { original_back_path: 'checks/x/other.jpg' } }),
    [CLEAN, 'checks/x/other.jpg'],
  );
  assert.deepEqual(extractMetaOriginals(null), []);
});

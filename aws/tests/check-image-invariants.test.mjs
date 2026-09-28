import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CLEAN_ORIGINAL_AMBIGUOUS_MESSAGE,
  CLEAN_ORIGINAL_MISSING_MESSAGE,
  assertCleanBackOriginalPath,
  depositImagePersistPatch,
  extractMetaOriginals,
  isGeneratedBackArtifactPath,
  recoverCleanBackOriginalPath,
  resolveCleanBackOriginalPath,
} from '../../src/lib/checkImageInvariants.ts';

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

test('extractMetaOriginals reads established original_back_* keys', () => {
  assert.deepEqual(
    extractMetaOriginals({ original_back_image_path: CLEAN, nested: { original_back_path: 'checks/x/other.jpg' } }),
    [CLEAN, 'checks/x/other.jpg'],
  );
  assert.deepEqual(extractMetaOriginals(null), []);
});

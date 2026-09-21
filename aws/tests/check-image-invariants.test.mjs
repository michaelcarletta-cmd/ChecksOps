import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  assertCleanBackOriginalPath,
  isGeneratedBackArtifactPath,
} from '../../src/lib/checkImageInvariants.ts';

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
  assert.equal(assertCleanBackOriginalPath('checks/x/back.jpg'), 'checks/x/back.jpg');
});


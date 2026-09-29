import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { PINNED_CURRENT_LIVE, PRE_INLINE_FILES_SHA256 } from '../scripts/lib/live-sig-baseline.mjs';
import {
  LIVE_FPE,
  assertInlineFilesOnlyWrites,
  assertTransplantedFiles,
  extractKnownGoodSignatureBody,
  transplantKnownGoodSignature,
} from '../scripts/lib/sig-known-good-inline.mjs';

const liveFiles = readFileSync('tests/fixtures/current-live-CheckFilesSection-0Fmhwbep.js', 'utf8');
const knownGood = readFileSync('tests/fixtures/known-good-CheckFilesSection-CHseToMm.js', 'utf8');

test('extracts known-good Signature body and retargets current FPE', () => {
  const body = extractKnownGoodSignatureBody(knownGood);
  assert.match(body, /function Ss\(/);
  assert.match(body, /Send for Signature/);
  assert.match(body, new RegExp(`import\\("\\./${LIVE_FPE}"\\)`));
  assert.doesNotMatch(body, /FieldPlacementEditor-D1Nz3L-a/);
  assert.doesNotMatch(body, /index-C5ku3IDF/);
});

test('transplant keeps current Files shell and drops the overlay import', () => {
  const { writes, report } = transplantKnownGoodSignature({
    liveFilesJs: liveFiles,
    knownGoodChseJs: knownGood,
  });
  const next = writes['assets/CheckFilesSection-0Fmhwbep.js'];
  assert.equal(report.files_before_sha256, PRE_INLINE_FILES_SHA256);
  assert.equal(report.files_sha256, PINNED_CURRENT_LIVE.files_sha256);
  assertTransplantedFiles(next);
  assert.match(next, /from"\.\/compressCheckImage-Df2Tsl9J\.js"/);
  assert.match(next, /import"\.\/CheckImageCropper-BlGyQebC\.js"/);
  assert.match(next, /from"\.\/index-DJNHggvS\.js"/);
  assert.doesNotMatch(next, /from"\.\/index-C5ku3IDF\.js"/);
  assert.doesNotMatch(next, /CheckCommandCenter-Bc7bAAX_/);
  assert.doesNotMatch(next, /SignatureRequests-ipdlcpz2/);
  assert.doesNotMatch(next, /ReactCurrentBatchConfig/);
  assert.match(next, /return s\?\?\[\]\}\}\),\{data:checkClaim\}=T\(/);
  assert.match(next, /\.select\("id, claim_id"\)/);
});

test('inline transplant may only write the live Files URL', () => {
  assert.throws(
    () => assertInlineFilesOnlyWrites({
      'assets/CheckFilesSection-0Fmhwbep.js': liveFiles,
      'index.html': '<html>',
    }),
    /only write Files URL/,
  );
  assert.deepEqual(
    assertInlineFilesOnlyWrites({ 'assets/CheckFilesSection-0Fmhwbep.js': liveFiles }),
    { filesKey: 'assets/CheckFilesSection-0Fmhwbep.js' },
  );
});

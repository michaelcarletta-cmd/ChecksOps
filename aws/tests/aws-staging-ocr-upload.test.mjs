import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const commandCenter = fs.readFileSync(path.join(ROOT, 'src/pages/CheckCommandCenter.tsx'), 'utf8');

const uploadFn = commandCenter.match(/const handleUpload = async \(\) => \{[\s\S]+?setUploading\(false\);\n    \}/);
assert.ok(uploadFn, 'CheckUploadForm handleUpload must exist');
const upload = uploadFn[0];

test('AWS staging upload invokes check-ocr-intake after the image path is saved', () => {
  assert.match(upload, /const aws = isAwsStaging\(\)/);
  assert.match(upload, /createAwsCheck/);
  assert.match(upload, /front_image_path: frontPath/);
  assert.match(upload, /functions\.invoke\("check-ocr-intake"/);
  assert.match(upload, /body: \{ checkId: check\.id, skipAi \}/);
  assert.doesNotMatch(
    upload,
    /if \(aws\) \{\s+toast\(\{[\s\S]+OCR and provider submission were not invoked/,
  );
});

test('AWS staging upload skips OCR only when the user chose manual entry', () => {
  assert.match(upload, /if \(aws && skipAi\)/);
  assert.match(upload, /OCR was not invoked/);
  assert.doesNotMatch(upload, /review_notes: skipAi \? "AWS staging intake — manual entry \(OCR skipped\)" : "AWS staging intake — OCR not invoked"/);
});

test('AWS staging upload does not trigger CheckAlt or Moov', () => {
  assert.doesNotMatch(upload, /checkalt-submit|checkalt-dispatch|moov-transfer|moov-webhook/);
});

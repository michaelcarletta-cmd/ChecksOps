import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const read = (path) => fs.readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

for (const path of ['aws/production/api-cfn.yaml', 'aws/production/api-template.yaml']) {
  test(`${path} production CORS is exact allow-list`, () => {
    const source = read(path);
    assert.match(source, /AllowOrigins:\s*\n\s*- ['"]https:\/\/checksops\.com['"]\s*\n\s*- ['"]https:\/\/www\.checksops\.com['"]/);
    assert.doesNotMatch(source, /AllowOrigins:\s*\n\s*- ['"]\*['"]/);
  });
}

test('staging CORS remains outside this production-only tranche', () => {
  const source = read('aws/template.yaml');
  assert.match(source, /AllowOrigins:\s*\n\s*- ['"]\*['"]/);
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('back-image reupload atomically updates back_image_path and back_image_original_path and clears deposit/render artifacts', () => {
  const src = readFileSync('src/components/checks/ReuploadCheckImageButton.tsx', 'utf8');
  assert.match(src, /const updatePayload:[\s\S]*\{ \[column\]: path \}/);
  assert.match(src, /if \(side === \"back\"\)[\s\S]*back_image_original_path\s*=\s*path/);
  assert.match(src, /if \(side === \"back\"\)[\s\S]*back_image_deposit_path\s*=\s*null/);
  assert.match(src, /if \(side === \"back\"\)[\s\S]*endorsement_render_status\s*=\s*\"idle\"/);
  assert.match(src, /if \(side === \"back\"\)[\s\S]*endorsement_render_meta\s*=\s*null/);
});

test('check detail back-image upload updates both pointers in one update payload and invalidates adjuster source query', () => {
  const src = readFileSync('src/pages/CheckCommandCenter.tsx', 'utf8');
  assert.match(src, /const backUpdate:[\s\S]*back_image_path:\s*newPath[\s\S]*back_image_original_path:\s*newPath/);
  assert.match(src, /back_image_deposit_path:\s*null/);
  assert.match(src, /invalidateQueries\(\{ queryKey: \[\"check-back-img-original-for-adjuster\", checkId\] \}\)/);
});


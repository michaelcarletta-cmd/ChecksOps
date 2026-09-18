import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const settings = read('src/components/white-label/WhiteLabelSettings.tsx');
const aiKey = read('src/components/white-label/TenantAIKeySettings.tsx');
const ocr = read('aws/functions/api/ocr.mjs');
const textractRunner = read('aws/functions/api/textract-check-ocr.mjs');
const commandCenter = read('src/pages/CheckCommandCenter.tsx');

test('Settings no longer exposes the OpenAI AI Key tab', () => {
  assert.doesNotMatch(settings, /value="ai-key"/);
  assert.doesNotMatch(settings, /<TenantAIKeySettings/);
  assert.doesNotMatch(settings, /from "\.\/TenantAIKeySettings"/);
  assert.match(settings, /<TabsTrigger value="profile"/);
  assert.match(settings, /<TabsTrigger value="usage"/);
  assert.match(settings, /<TabsTrigger value="users"/);
  assert.match(settings, /<TabsTrigger value="partners"/);
});

test('legacy \\?tab=ai-key deep links fall back to Profile', () => {
  assert.match(settings, /tab === "ai-key"/);
  assert.match(settings, /setActiveTab\("profile"\)/);
});

test('OpenAI key component remains in the repo and is not deleted', () => {
  assert.match(aiKey, /export function TenantAIKeySettings/);
  assert.match(aiKey, /tenant-set-openai-key/);
});

test('AWS Textract check OCR path remains', () => {
  assert.match(ocr, /aws_textract_analyze/);
  assert.match(ocr, /runTextract/);
  assert.match(textractRunner, /TextractClient/);
  assert.match(textractRunner, /AnalyzeDocumentCommand/);
  assert.match(commandCenter, /functions\.invoke\("check-ocr-intake"/);
});

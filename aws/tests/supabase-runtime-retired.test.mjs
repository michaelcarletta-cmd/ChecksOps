import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');

function walk(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      walk(full, acc);
    } else if (/\.(ts|tsx|js|mjs)$/.test(entry.name)) {
      acc.push(full);
    }
  }
  return acc;
}

test('production SPA has no @supabase/supabase-js or integrations/supabase imports', () => {
  const files = walk(path.join(ROOT, 'src'));
  assert.ok(files.length > 100);
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /from ['"]@supabase\/supabase-js['"]/, file);
    assert.doesNotMatch(source, /from ['"]@\/integrations\/supabase/, file);
    assert.doesNotMatch(source, /from ['"]\.\.?\/integrations\/supabase/, file);
    assert.doesNotMatch(source, /import\.meta\.env\.VITE_SUPABASE_/, file);
  }
  assert.equal(fs.existsSync(path.join(ROOT, 'src/integrations/supabase')), false);
  assert.equal(fs.existsSync(path.join(ROOT, 'src/types/database.ts')), true);
});

test('public signing and unsubscribe do not fall back to hosted Supabase', () => {
  const publicApi = fs.readFileSync(path.join(ROOT, 'src/lib/publicWorkflowApi.ts'), 'utf8');
  const unsubscribe = fs.readFileSync(path.join(ROOT, 'src/pages/Unsubscribe.tsx'), 'utf8');
  const verification = fs.readFileSync(path.join(ROOT, 'src/lib/payments/verificationFiles.ts'), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  for (const [name, source] of [
    ['publicWorkflowApi', publicApi],
    ['Unsubscribe', unsubscribe],
    ['verificationFiles', verification],
  ]) {
    assert.doesNotMatch(source, /supabase\.co/, name);
    assert.doesNotMatch(source, /VITE_SUPABASE_/, name);
    assert.doesNotMatch(source, /eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9/, name);
  }
  assert.match(publicApi, /awsApiBaseUrl/);
  assert.match(publicApi, /\/public\/signature-document/);
  assert.doesNotMatch(publicApi, /functions\/v1\/get-signature-document/);
  assert.equal(pkg.dependencies['@supabase/supabase-js'], undefined);
  assert.equal(pkg.devDependencies['lovable-tagger'], undefined);
  assert.match(pkg.scripts.build, /--mode aws/);
});

test('legacy publish-key check is a no-op and env files have no supabase credentials', () => {
  const checker = fs.readFileSync(path.join(ROOT, 'scripts/check-publish-keys.mjs'), 'utf8');
  const prod = fs.readFileSync(path.join(ROOT, '.env.production'), 'utf8');
  const local = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
  const example = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
  assert.match(checker, /do not use VITE_SUPABASE_/);
  assert.doesNotMatch(prod, /VITE_SUPABASE_/);
  assert.doesNotMatch(local, /VITE_SUPABASE_/);
  assert.doesNotMatch(example, /VITE_SUPABASE_/);
});

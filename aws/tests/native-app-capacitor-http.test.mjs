// The iOS/Android app sends its API calls through native networking (CapacitorHttp), because an
// API Gateway HTTP API refuses capacitor://localhost as a CORS origin (production CORS apply run
// 44175846094: "Invalid format for origin capacitor://localhost"). Presigned uploads keep the
// web view's own fetch: Capacitor's bridge sends a plain Blob body as JSON, which would corrupt the
// file, and the files bucket's CORS allows the app origins.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { webViewFetch } from '../../src/lib/webViewFetch.ts';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('the app turns on CapacitorHttp and nothing else changes in its config', () => {
  const config = JSON.parse(read('mobile/capacitor.config.json'));
  assert.deepEqual(config, {
    appId: 'com.checksops.app',
    appName: 'ChecksOps',
    webDir: '../dist',
    plugins: { CapacitorHttp: { enabled: true } },
  });
});

test('presigned PUT uploads use the web view fetch, not the patched one', () => {
  assert.match(read('src/integrations/aws/storage.ts'), /await webViewFetch\(String\(body\.uploadUrl\), \{ method: "PUT", headers, body: file \}\)/);
  assert.match(read('src/pages/HomeownerLedger.tsx'), /await webViewFetch\(target\.upload_url, \{\s*method: "PUT"/);
  for (const rel of ['src/integrations/aws/storage.ts', 'src/pages/HomeownerLedger.tsx']) {
    assert.doesNotMatch(read(rel), /await fetch\([^)]*upload_?[uU]rl/, rel);
  }
});

test('webViewFetch prefers window.CapacitorWebFetch and falls back to fetch', async () => {
  const calls = [];
  const savedFetch = globalThis.fetch;
  const savedWindow = globalThis.window;
  try {
    globalThis.fetch = async (url) => { calls.push(['fetch', url]); return new Response('a'); };
    globalThis.window = {};
    await webViewFetch('https://bucket.example/x', { method: 'PUT' });
    globalThis.window = { CapacitorWebFetch: async (url, init) => { calls.push(['web', url, init.method]); return new Response('b'); } };
    await webViewFetch('https://bucket.example/y', { method: 'PUT' });
  } finally {
    globalThis.fetch = savedFetch;
    if (savedWindow === undefined) delete globalThis.window; else globalThis.window = savedWindow;
  }
  assert.deepEqual(calls, [['fetch', 'https://bucket.example/x'], ['web', 'https://bucket.example/y', 'PUT']]);
});

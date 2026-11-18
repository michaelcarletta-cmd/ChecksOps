import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  allowedRemoteAssetUrl,
  fetchAllowedRemoteAsset,
} from '../../supabase/functions/_shared/safeRemoteAsset.ts';
import { timingSafeEqualStrings } from '../../supabase/functions/_shared/timingSafeEqual.ts';

const policy = { supabaseUrl: 'https://project.supabase.co', extraAllowedHosts: 'assets.example.com, cdn.example.com' };
const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

test('remote asset allow-list accepts only HTTPS storage hosts', () => {
  const ok = [
    'https://project.supabase.co/storage/v1/object/sign/claim-files/checks/1/front.jpg?token=t',
    'https://project.supabase.co/anything',
    'https://legacy.supabase.co/storage/v1/object/public/claim-files/a.png',
    'https://assets.example.com/a.png',
    'https://CDN.example.com:443/a.png',
  ];
  for (const url of ok) assert.ok(allowedRemoteAssetUrl(url, policy), url);

  const refused = [
    'http://project.supabase.co/storage/v1/object/public/claim-files/a.png',
    'https://169.254.169.254/latest/meta-data/',
    'http://169.254.169.254/latest/meta-data/',
    'https://localhost/a.png',
    'https://10.0.0.5/a.png',
    'https://evil.example.com/storage/v1/object/public/claim-files/a.png',
    'https://legacy.supabase.co/functions/v1/anything',
    'https://project.supabase.co.evil.example/storage/v1/object/a.png',
    'https://evilsupabase.co/storage/v1/object/a.png',
    'https://user:pass@project.supabase.co/storage/v1/object/a.png',
    'https://project.supabase.co:8443/storage/v1/object/a.png',
    'file:///etc/passwd',
    'not a url',
  ];
  for (const url of refused) assert.equal(allowedRemoteAssetUrl(url, policy), null, url);
});

test('an empty policy allows only Supabase storage object URLs', () => {
  assert.ok(allowedRemoteAssetUrl('https://legacy.supabase.co/storage/v1/object/public/b/a.png', {}));
  assert.equal(allowedRemoteAssetUrl('https://assets.example.com/a.png', {}), null);
});

test('fetchAllowedRemoteAsset never calls fetch for a refused URL and refuses redirects', async () => {
  const calls = [];
  const fakeFetch = async (url, init) => { calls.push({ url, init }); return new Response('ok'); };
  await assert.rejects(
    fetchAllowedRemoteAsset('https://169.254.169.254/latest/meta-data/', policy, fakeFetch),
    /remote_asset_host_not_allowed/,
  );
  assert.equal(calls.length, 0);
  await fetchAllowedRemoteAsset('https://assets.example.com/a.png', policy, fakeFetch);
  assert.deepEqual(calls, [{ url: 'https://assets.example.com/a.png', init: { redirect: 'error' } }]);
});

test('timingSafeEqualStrings matches only identical non-empty strings', async () => {
  assert.equal(await timingSafeEqualStrings('secret-token', 'secret-token'), true);
  assert.equal(await timingSafeEqualStrings('secret-token', 'secret-tokeN'), false);
  assert.equal(await timingSafeEqualStrings('secret', 'secret-token'), false);
  assert.equal(await timingSafeEqualStrings('', ''), false);
  assert.equal(await timingSafeEqualStrings(undefined, 'secret-token'), false);
  assert.equal(await timingSafeEqualStrings(undefined, undefined), false);
});

test('edge functions use the guarded helpers', () => {
  for (const path of [
    'supabase/functions/get-check-image-urls/index.ts',
    'supabase/functions/composite-endorsement-signatures/index.ts',
  ]) {
    const source = read(path);
    assert.match(source, /fetchAllowedRemoteAsset\(/, path);
    assert.doesNotMatch(source, /await fetch\((originalValue|signatureRef)\)/, path);
  }
  assert.match(read('supabase/functions/check-ocr-backlog/index.ts'), /timingSafeEqualStrings\(token, serviceKey\)/);
  assert.doesNotMatch(read('supabase/functions/check-ocr-backlog/index.ts'), /token !== serviceKey/);
  assert.match(read('supabase/functions/preview-transactional-email/index.ts'), /timingSafeEqualStrings\(token, apiKey\)/);
  assert.doesNotMatch(read('supabase/functions/preview-transactional-email/index.ts'), /token !== apiKey/);
});

test('rich text editor sanitises HTML and the Android app disables backup', () => {
  const editor = read('src/components/ui/rich-text-editor.tsx');
  assert.doesNotMatch(editor, /innerHTML = value/);
  assert.equal(editor.match(/innerHTML = sanitizeEditorHtml\(/g)?.length, 2);
  assert.match(read('mobile/android/app/src/main/AndroidManifest.xml'), /android:allowBackup="false"/);
});

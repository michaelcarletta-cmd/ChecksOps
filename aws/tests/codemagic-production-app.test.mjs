// The iOS/Android app can be built against production (Codemagic ios-production and
// android-production) next to the staging workflows. The app is served from capacitor://localhost
// or https://localhost, so it needs the full https://checksops.com/prep address; vite.config.ts
// allows that one address only when CHECKSOPS_NATIVE_APP_BUILD=1, and the website keeps /prep.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const VITE = pathToFileURL(createRequire(path.join(ROOT, 'package.json')).resolve('vite')).href;

function workflowBlock(yaml, id) {
  const start = yaml.indexOf(`\n  ${id}:\n`);
  assert.ok(start > -1, `workflow ${id}`);
  const rest = yaml.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][a-z-]*:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

test('production workflows build the production bundle; staging workflows still build staging', () => {
  const yaml = read('codemagic.yaml');
  for (const id of ['ios-production', 'android-production']) {
    const block = workflowBlock(yaml, id);
    assert.match(block, /- \*build_web_production\n/, id);
    assert.doesNotMatch(block, /- \*build_web\n/, id);
  }
  for (const id of ['ios-staging', 'android-staging', 'android-staging-build']) {
    const block = workflowBlock(yaml, id);
    assert.match(block, /- \*build_web\n/, id);
    assert.doesNotMatch(block, /build_web_production/, id);
  }
  assert.match(workflowBlock(yaml, 'ios-production'), /bundle_identifier: com\.checksops\.app/);
  assert.match(workflowBlock(yaml, 'ios-production'), /submit_to_testflight: false/);
  assert.match(workflowBlock(yaml, 'android-production'), /track: internal\n\s+submit_as_draft: true/);
});

test('the production app bundle uses the production pool and the full production API address', () => {
  const yaml = read('codemagic.yaml');
  const step = yaml.slice(yaml.indexOf('- &build_web_production'), yaml.indexOf('- &install_capacitor'));
  for (const line of [
    'VITE_AUTH_PROVIDER=cognito',
    'VITE_APP_URL=https://checksops.com',
    'VITE_CHECKSOPS_API_URL=https://checksops.com/prep',
    'VITE_AWS_REGION=us-east-1',
    'VITE_COGNITO_USER_POOL_ID=us-east-1_h00WorYMT',
    'VITE_COGNITO_USER_POOL_CLIENT_ID=3ja9fqaq2fjkv3i6up2varcqpe',
  ]) assert.ok(step.includes(`\n        ${line}\n`), line);
  assert.match(step, /\n {8}CHECKSOPS_NATIVE_APP_BUILD=1 bun run build:aws\n/);
  assert.doesNotMatch(step, /vPmQ7cL1F|psr19uhop4|staging\.checksops\.com/, 'no staging values');
  // The same public Cognito values the guarded production website upload checks.
  const upload = read('.github/workflows/guarded-production-spa-upload.yml');
  assert.match(upload, /VITE_COGNITO_USER_POOL_ID: us-east-1_h00WorYMT/);
  assert.match(upload, /VITE_COGNITO_USER_POOL_CLIENT_ID: 3ja9fqaq2fjkv3i6up2varcqpe/);
});

function viteConfig(env) {
  // Load vite.config.ts's guard through Vite itself, in aws mode, with only the given variables.
  // It runs from an empty folder so no local .env file (loadEnv reads the cwd) changes the result.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vite-guard-'));
  const script = `
    const { loadConfigFromFile } = await import(${JSON.stringify(VITE)});
    try {
      await loadConfigFromFile({ command: 'build', mode: 'aws' }, ${JSON.stringify(path.join(ROOT, 'vite.config.ts'))}, ${JSON.stringify(dir)});
      console.log('OK');
    } catch (e) { console.log('ERR ' + e.message); }
  `;
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^VITE_|^SUPABASE|^CHECKSOPS_NATIVE/.test(k)));
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: dir, env: { ...clean, ...env }, encoding: 'utf8' });
  return (res.stdout || '').trim().split('\n').pop();
}

const PROD = {
  VITE_AUTH_PROVIDER: 'cognito',
  VITE_APP_URL: 'https://checksops.com',
  VITE_AWS_REGION: 'us-east-1',
  VITE_COGNITO_USER_POOL_ID: 'us-east-1_h00WorYMT',
  VITE_COGNITO_USER_POOL_CLIENT_ID: '3ja9fqaq2fjkv3i6up2varcqpe',
};

test('vite guard: the website keeps /prep; only the app build takes https://checksops.com/prep', () => {
  assert.equal(viteConfig({ ...PROD, VITE_CHECKSOPS_API_URL: '/prep' }), 'OK');
  assert.match(viteConfig({ ...PROD, VITE_CHECKSOPS_API_URL: 'https://checksops.com/prep' }), /^ERR .*VITE_CHECKSOPS_API_URL=\/prep/);
  assert.equal(viteConfig({ ...PROD, VITE_CHECKSOPS_API_URL: 'https://checksops.com/prep', CHECKSOPS_NATIVE_APP_BUILD: '1' }), 'OK');
  assert.match(
    viteConfig({ ...PROD, VITE_CHECKSOPS_API_URL: 'https://evil.example.com/prep', CHECKSOPS_NATIVE_APP_BUILD: '1' }),
    /^ERR .*VITE_CHECKSOPS_API_URL=https:\/\/checksops\.com\/prep/,
  );
  assert.match(
    viteConfig({ ...PROD, VITE_CHECKSOPS_API_URL: 'https://kiqojucc02.execute-api.us-east-1.amazonaws.com/prep', CHECKSOPS_NATIVE_APP_BUILD: '1' }),
    /^ERR /,
  );
});

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

test('every app build number is the project-wide counter, so workflows never reuse one', () => {
  // Apple and Google Play refuse an upload whose build number was already used for
  // com.checksops.app; the per-workflow $BUILD_NUMBER restarted at 1 for the production workflows.
  const yaml = read('codemagic.yaml');
  assert.doesNotMatch(yaml, /\$BUILD_NUMBER\b/);
  for (const id of ['ios-staging', 'ios-production']) {
    assert.match(workflowBlock(yaml, id), /CURRENT_PROJECT_VERSION=\$PROJECT_BUILD_NUMBER"/, id);
  }
  for (const id of ['android-staging-build', 'android-staging', 'android-production']) {
    assert.match(workflowBlock(yaml, id), /-PversionCode="\$PROJECT_BUILD_NUMBER"/, id);
  }
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

test('a failed iOS archive prints Xcode errors and keeps the xcodebuild log', () => {
  const yaml = read('codemagic.yaml');
  for (const id of ['ios-staging', 'ios-production']) {
    const block = workflowBlock(yaml, id);
    assert.match(block, /if ! xcode-project build-ipa/, id);
    assert.match(block, /grep -h -E "error:[^"]*" \/tmp\/xcodebuild_logs\/\*\.log/, id);
    assert.match(block, /exit 65/, id);
    assert.match(block, /- \/tmp\/xcodebuild_logs\/\*\.log/, id);
  }
});

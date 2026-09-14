#!/usr/bin/env node
/**
 * Verify the production cutover lock without deploying.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PRODUCTION_SPA_LOCK,
  assertCloudFrontOriginLocked,
  isValidatedAwsCognitoFingerprint,
  listValidatedProductionFingerprints,
} from './production-spa-lock.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OFFLINE = process.argv.includes('--offline');
const AWS = process.env.AWS_CLI || 'aws';

const checks = [];
const record = (name, ok, detail) => {
  checks.push({ name, ok, detail });
};

const lock = PRODUCTION_SPA_LOCK.knownGood;
record('lock_file', true, { gitCommit: lock.gitCommit, spaBundle: lock.spaBundle });

const fp = JSON.parse(fs.readFileSync(path.join(ROOT, lock.fingerprint), 'utf8'));
record('known_good_fingerprint_validated', isValidatedAwsCognitoFingerprint(fp), {
  gitCommit: fp.gitCommit,
  authProvider: fp.authProvider,
});

const deploySrc = fs.readFileSync(path.join(ROOT, 'scripts/deploy-production-spa.mjs'), 'utf8');
record('deploy_script_refuses_unlocked_apply', deploySrc.includes('assertProductionSpaApplyAllowed'), {});

const ci = fs.readFileSync(path.join(ROOT, '.github/workflows/aws-migration-ci.yml'), 'utf8');
record('ci_has_no_s3_sync', !/s3\s+sync/.test(ci), {});
record('ci_does_not_invoke_apply', !/deploy-production-spa\.mjs --apply/.test(ci) || /apply must stay locked/.test(ci), {});
record('ci_permissions_contents_read', /permissions:[\s\S]*contents:\s*read/.test(ci), {});

const apply = spawnSync(process.execPath, [path.join(ROOT, 'scripts/deploy-production-spa.mjs'), '--apply'], {
  cwd: ROOT,
  encoding: 'utf8',
  env: { ...process.env, CHECKSOPS_PRODUCTION_SPA_UNLOCK: '' },
});
record('unlocked_apply_refused', apply.status === 2 && /production_spa_cutover_locked/.test(apply.stderr || apply.stdout || ''), {
  status: apply.status,
});

const supabaseRollback = spawnSync(process.execPath, [
  path.join(ROOT, 'scripts/rollback-production-spa.mjs'),
  '--apply',
  '--from-fingerprint',
  'aws/cutover/PRODUCTION_SPA_LOCK.json',
], {
  cwd: ROOT,
  encoding: 'utf8',
  env: { ...process.env, CHECKSOPS_PRODUCTION_SPA_UNLOCK: 'RELEASE_CUTOVER_LOCK' },
});
record('supabase_or_invalid_fingerprint_refused', supabaseRollback.status !== 0, {
  status: supabaseRollback.status,
});

record('validated_fingerprint_count', listValidatedProductionFingerprints().length >= 1, {
  count: listValidatedProductionFingerprints().length,
});

if (!OFFLINE) {
  const html = spawnSync('curl', ['-sS', 'https://checksops.com/'], { encoding: 'utf8' });
  const bundle = (html.stdout || '').match(/\/assets\/(index-[A-Za-z0-9]+\.js)/)?.[1] || null;
  record('public_spa_bundle', bundle === lock.spaBundle, { bundle });
  record('public_html_has_no_supabase_host', !/supabase\.co/.test(html.stdout || ''), {});

  const js = spawnSync('curl', ['-sS', `https://checksops.com/assets/${lock.spaBundle}`], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  const body = js.stdout || '';
  record('public_js_has_cognito_pool', body.includes(lock.cognitoPoolId), {});
  record('public_js_has_cognito_client', body.includes(lock.cognitoClientId), {});
  record('public_js_has_prep', body.includes(lock.apiTarget), {});
  record('public_js_has_no_supabase_host', !/supabase\.co/.test(body), {});

  const cf = spawnSync(AWS, ['cloudfront', 'get-distribution', '--id', lock.cloudfrontDistributionId, '--output', 'json'], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  if (cf.status === 0) {
    try {
      assertCloudFrontOriginLocked(JSON.parse(cf.stdout).Distribution);
      record('cloudfront_origin_locked', true, { origin: lock.spaOriginDomain });
    } catch (error) {
      record('cloudfront_origin_locked', false, { error: error.code || error.message });
    }
  } else {
    record('cloudfront_origin_locked', false, { error: (cf.stderr || '').slice(0, 300) });
  }
}

const failed = checks.filter((row) => !row.ok);
console.log(JSON.stringify({
  ok: failed.length === 0,
  offline: OFFLINE,
  knownGood: lock,
  checks,
  failed: failed.map((row) => row.name),
}, null, 2));
process.exit(failed.length === 0 ? 0 : 1);
